/**
 * trac_source.js
 * ─────────────────────────────────────────────────────────────────────────
 * NHS / Trac job SOURCING via the HealthJobsUK board (trac.jobs). Pure HTTP —
 * no browser — so it runs headless everywhere (Mac included). Search is GET:
 *   https://www.healthjobsuk.com/job_list/ns?JobSearch_q=<keyword>&_pg=<page>
 * The homepage blocks bots, but this endpoint returns 200 with a normal browser
 * User-Agent. Results are ~50 jobs/page, each an <a href="/job/UK/{region}/{town}/
 * {trust}/{slug}-v{vacancyId}">Title Band N Trust, Location</a>. See
 * bot/specs/trac_search.json. Applying is a separate, browser-login step
 * (trac_form.json maps the form); this module only reads jobs.
 */

const TRAC_BASE = 'https://www.healthjobsuk.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function fetchHtml(url, ms = 25000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' }, redirect: 'follow', signal: c.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const deSlug = (s) => decodeURIComponent(String(s || '').replace(/_/g, ' ')).replace(/\s+/g, ' ').trim();

// Parse the HealthJobsUK results HTML into job objects the queue/scorer understand.
function parseJobs(html) {
  const jobs = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/<a[^>]*href="([^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawHref = m[1];
    const txt = clean(m[2]);
    if (!txt || txt.length < 6) continue;
    const vm = rawHref.match(/-v(\d+)/);
    if (!vm) continue;                       // only real vacancy links carry -v{id}
    const id = vm[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const path = rawHref.split('?')[0];
    const parts = path.split('/');           // ['', 'job','UK',region,town,trust,slug,...]
    const trust = deSlug(parts[5] || '');
    const town = deSlug(parts[4] || '');

    // Title = the anchor text up to "Band" / "NHS AfC: Band"; keep the band label.
    const bandM = txt.match(/(NHS AfC:\s*)?Band\s*[0-9][0-9a-z]?/i);
    let title = txt.replace(/\s*(NHS AfC:\s*)?Band\s.*$/i, '').trim();
    if (!title) title = txt.slice(0, 90);

    jobs.push({
      jobId: 'trac_' + id,
      title,
      company: trust || 'NHS',
      location: town || '',
      band: bandM ? bandM[0].replace(/NHS AfC:\s*/i, '') : '',
      url: TRAC_BASE + path,
      source: 'trac',
      description: '',                        // fetched at apply time (JD/person spec)
      apply_kind: 'trac',
    });
  }
  return jobs;
}

// Search Trac for a keyword. Returns de-duplicated jobs across `pages` pages.
async function searchTrac(keyword, { pages = 1 } = {}) {
  const out = [];
  const byId = new Map();
  for (let p = 1; p <= pages; p++) {
    const url = `${TRAC_BASE}/job_list/ns?JobSearch_q=${encodeURIComponent(keyword)}&_pg=${p}`;
    const html = await fetchHtml(url);
    if (!html) break;
    const jobs = parseJobs(html);
    if (!jobs.length) break;
    for (const j of jobs) if (!byId.has(j.jobId)) { byId.set(j.jobId, j); out.push(j); }
    if (jobs.length < 40) break;              // last page (short) reached
  }
  return out;
}

// Fetch the job advert's description / person-spec text so the Scorer can tailor
// the CV + supporting statement. NOTE: Trac advert pages are bot-blocked (403) to
// plain HTTP, so pass a Playwright `page` (real browser passes the check) to get
// the real JD. Without a page it falls back to HTTP and will usually return '' —
// the browser apply phase is where the JD is reliably read.
async function fetchTracJD(url, page) {
  if (page) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 1200));
      const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      return String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch (_) { return ''; }
  }
  const html = await fetchHtml(url);
  if (!html) return '';
  // The advert body lives in the main content; strip scripts/styles/nav and collapse.
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' ');
  const txt = clean(body);
  // Trim the boilerplate that precedes the actual advert where we can spot it.
  const start = txt.search(/job overview|job summary|main duties|about the role|person specification|job description/i);
  return (start > 0 ? txt.slice(start) : txt).slice(0, 8000);
}

module.exports = { searchTrac, parseJobs, fetchHtml, fetchTracJD, TRAC_BASE };
