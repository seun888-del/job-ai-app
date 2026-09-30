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

// HealthJobsUK groups every vacancy under a job-family "sector". Searching WITHIN a
// sector (…/job_list/s{code}?JobSearch_q=…) returns only that family's jobs, which
// kills the loose keyword noise at the source (an admin searcher never sees clinical
// "…Specialist" roles). Codes read off the live homepage sector tiles.
const SECTORS = {
  s1: 'Nursing & Midwifery', s2: 'Medical & Dental', s3: 'Emergency Services',
  s4: 'Allied Health Professions', s5: 'Health Science Services', s6: 'Support Services',
  s7: 'Administrative Services', s8: 'Directors', s9: 'Volunteers', s10: 'Apprenticeships',
  s119: 'Personal Social Services',
};

// Map a user's search terms to the sector(s) worth searching. Purely additive: any
// matched sectors are searched; if nothing matches we fall back to 'ns' (all sectors)
// so no job type is ever silently excluded. Keeps sourcing user-driven, no hard-coded niche.
const SECTOR_LEXICON = [
  ['s7', /admin|administrat|clerk|clerical|secretar|reception|office|\bpa\b|coordinat|data entry|business support|ward clerk/],
  ['s6', /\bit\b|\bict\b|technician|technical|help ?desk|service desk|software|developer|programmer|engineer|network|sysadmin|system|infrastructure|devops|facilit|catering|porter|cleaner|estates|security|driver|logistic|supply chain|maintenance/],
  ['s5', /informatic|data analyst|data scien|\bbi\b|business intelligence|scientist|laborator|biomedical|genomic|pharmacy technician|analyst|statistic/],
  ['s1', /\bnurse\b|nursing|midwife|midwifery|\bhca\b|healthcare assistant|ward sister|matron|clinical support/],
  ['s2', /\bdoctor\b|physician|\bgp\b|dental|dentist|surgeon|registrar|\bsho\b|junior doctor|clinical fellow/],
  ['s3', /paramedic|ambulance|emergency care|\bua\b|urgent care/],
  ['s4', /physiotherap|\bphysio\b|occupational therap|radiographer|sonographer|dietit|dietician|speech.*language|\bslt\b|podiatr|orthopt|psycholog|\bodp\b|pharmacist|therapist/],
  ['s119', /social work|social care|support worker|care assistant|outreach/],
  ['s8', /director|head of|chief|\bcio\b|\bcfo\b|\bcoo\b/],
  ['s10', /apprentice/],
];
function sectorsForTerms(terms = []) {
  const hay = (Array.isArray(terms) ? terms : [terms]).join(' ').toLowerCase();
  const hits = [];
  for (const [code, re] of SECTOR_LEXICON) if (re.test(hay) && !hits.includes(code)) hits.push(code);
  return hits.length ? hits : ['ns'];
}

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
    let trust = deSlug(parts[5] || '');
    // Short advert paths put the job slug ("Administration-v8256516") where the trust goes.
    if (/-v\d+/i.test(trust) || /-v\d+/i.test(parts[5] || '')) {
      const emp = txt.match(/(?:Grade\s*\S+|VSM|Band\s*\S+)\s+(.+?)\s+,\s/i);
      trust = emp ? emp[1].trim() : '';
    }
    const town = deSlug(parts[4] || '');

    // Title = the anchor text up to "Band" / "NHS AfC: Band"; keep the band label.
    const bandM = txt.match(/(NHS AfC:\s*)?Band\s*[0-9][0-9a-z]?/i);
    // Some adverts lead with the band ("Band 4 - Medical Secretary, Urology Band 4 ..."): drop it first.
    let title = txt.replace(/^\s*Band\s*[0-9][0-9a-z]?\s*[-–:]\s*/i, '').replace(/\s*(NHS AfC:\s*)?Band\s.*$/i, '').trim();
    // Non-AfC adverts (Civil Service, VSM, salary-only) have no "Band", so the anchor text
    // runs on into employer, town, speciality and salary. Cut those off.
    title = title.replace(/\s+(Speciality|Salary|Civil Service|Executives \/ VSM)\s*:.*$/i, '').split(' , ')[0].trim();
    if (trust && trust.length > 8) { const k = title.toLowerCase().indexOf(trust.toLowerCase()); if (k > 3) title = title.slice(0, k).trim(); }
    title = title.replace(/[\s,;:\-–]+$/, '');
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

// Search Trac for a keyword. Returns de-duplicated jobs across `pages` pages and,
// when `sectors` is given, across those sector-scoped lists (…/job_list/s{code}?…).
// Default 'ns' = all sectors (back-compat). Sector-scoping lands the agent straight
// on the right job family instead of wading through every clinical result.
// HealthJobsUK now sits behind Cloudflare, which blocks plain HTTP (403 "Site unavailable").
// Fall back to the agent's real browser page, which passes the check (same as the adverts).
async function fetchListHtml(url, page) {
  const html = await fetchHtml(url);
  // A plain fetch can "succeed" with a page that has no job list (the results load by script,
  // or a bot-check page). Only trust it if it actually contains vacancy links.
  if (!page || (html && /-v\d{5,}/.test(html))) return html;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a[href*="-v"]', { timeout: 8000 }).catch(() => {});
    return await page.content();
  } catch (_) { return null; }
}

async function searchTrac(keyword, { pages = 1, sectors = ['ns'], page = null } = {}) {
  const out = [];
  const byId = new Map();
  const list = (Array.isArray(sectors) && sectors.length) ? sectors : ['ns'];
  for (const sec of list) {
    for (let p = 1; p <= pages; p++) {
      const url = `${TRAC_BASE}/job_list/${sec}?JobSearch_q=${encodeURIComponent(keyword)}&_pg=${p}`;
      const html = await fetchListHtml(url, page);
      if (!html) break;
      const jobs = parseJobs(html);
      if (!jobs.length) break;
      for (const j of jobs) if (!byId.has(j.jobId)) { byId.set(j.jobId, j); j.sector = SECTORS[sec] || ''; out.push(j); }
      if (jobs.length < 40) break;            // last page (short) reached
    }
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
      return String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 30000);
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
  return (start > 0 ? txt.slice(start) : txt).slice(0, 30000);
}

module.exports = { searchTrac, parseJobs, fetchHtml, fetchTracJD, sectorsForTerms, SECTORS, TRAC_BASE };
