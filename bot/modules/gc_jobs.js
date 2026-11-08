/**
 * gc_jobs.js: Government of Canada jobs (GC Jobs, emploisfp-psjobs.cfp-psc.gc.ca), Canada only.
 *
 * SEARCH (plain HTTP, no account): the job search is public. The results load the way the page
 * loads them: open the search URL (sets a JSESSIONID cookie), call ajaxSetInternalAccess=1, then
 * fetch the results part (isSecondPartOfPage=1). Job posters (page1800?poster=ID) are public too.
 * This anonymous session never touches the user's signed-in browser session.
 *
 * Some postings send people to the hiring organization's own website ("You will leave the GC
 * Jobs Web site"). Those can't be applied to here and are skipped.
 */
const https = require('https');

const HOST = 'emploisfp-psjobs.cfp-psc.gc.ca';
const BASE = `https://${HOST}/psrs-srfp/applicant`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function get(url, cookie = '', referer = '') {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-CA,en;q=0.9', ...(cookie ? { Cookie: cookie } : {}), ...(referer ? { Referer: referer } : {}) }, timeout: 30000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, cookies: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]) }));
    });
    req.on('error', () => resolve({ status: 0, body: '', cookies: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', cookies: [] }); });
  });
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = (html) => decode(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// One search result: title, closing date, organization, location(s), language, pay.
function parseResults(html) {
  const out = [];
  const re = /<li class="searchResult">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    const id = (raw.match(/poster=(\d+)/) || [])[1];
    if (!id) continue;
    const title = decode((raw.match(/<a [^>]*>([\s\S]*?)<\/a>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const parts = decode(raw.replace(/<a [\s\S]*?<\/a>/, '').replace(/<br\s*\/?>/g, '|').replace(/<[^>]+>/g, ' ')).split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const closes = ((parts.find((p) => /^Closing date:/i.test(p)) || '').match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const pay = parts.find((p) => /\$\s?\d/.test(p)) || '';
    const rest = parts.filter((p) => !/^Closing date:/i.test(p) && p !== pay);
    const company = rest[0] || '';
    // Location and language often share a line ("Dartmouth (Nova Scotia) English essential").
    const LANG = /((English|French) essential|Bilingual.*|Various language.*|English or French.*)$/i;
    let location = rest.slice(1).join(', '), language = '';
    const lm = location.match(LANG);
    if (lm) { language = lm[1].trim(); location = location.slice(0, lm.index).replace(/[,\s]+$/, ''); }
    out.push({ poster: id, jobId: `gcjobs_${id}`, title, company, location: location.replace(/\s+/g, ' ').trim(), closes, language, pay, url: `${BASE}/page1800?poster=${id}&toggleLanguage=en` });
  }
  return out;
}

// An anonymous GC Jobs session (cookie), needed before results and posters load.
async function openSession(url = `${BASE}/page2440?fromMenu=true&toggleLanguage=en`) {
  const r = await get(url);
  if (r.status !== 200) throw new Error(`GC Jobs did not load (${r.status})`);
  return r.cookies.join('; ');
}

// Public search for a job title. Returns jobs open to the public (all pages, capped).
async function search(term, { maxPages = 5 } = {}) {
  const q = `title=${encodeURIComponent(term)}&search=Search%20jobs&tab=1&log=false&toggleLanguage=en`;
  const first = `${BASE}/page2440?${q}`;
  const cookie = await openSession(first);
  await get(`${first}&ajaxSetInternalAccess=1`, cookie, first);
  const byId = new Map();
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1 ? `${first}&isSecondPartOfPage=1&isInitialNetworkCheck=1` : `${BASE}/page2440?requestedPage=${p}&fromPage=1&tab=1&log=false&isSecondPartOfPage=1`;
    const r = await get(url, cookie, first);
    if (r.status !== 200 || /Lost Connection/i.test(r.body)) break;
    const jobs = parseResults(r.body);
    let added = 0;
    for (const j of jobs) if (!byId.has(j.poster)) { byId.set(j.poster, j); added++; }
    const total = +((r.body.match(/Jobs open to the public \((\d+)\)/) || [])[1] || 0);
    if (!added || byId.size >= total || jobs.length < 20) break;
  }
  return [...byId.values()];
}

// The job poster: its text (for the Scorer), the reference number, and whether it is applied
// to on another website.
let _cookie = '', _cookieAt = 0;
async function fetchPoster(poster) {
  if (!_cookie || Date.now() - _cookieAt > 20 * 60 * 1000) { _cookie = await openSession(); _cookieAt = Date.now(); }
  const r = await get(`${BASE}/page1800?poster=${encodeURIComponent(poster)}&toggleLanguage=en`, _cookie);
  if (r.status !== 200) return { ok: false };
  const main = (r.body.match(/<main[\s\S]*?<\/main>/) || [r.body])[0];
  const t = text(main);
  if (/You will leave the GC Jobs Web site/i.test(t)) return { ok: true, external: true, text: t };
  const ref = (t.match(/Reference number\s+([A-Z0-9-]{8,})/) || [])[1] || '';
  const who = (t.match(/Who can apply\s+([^\n]+)/) || [])[1] || '';
  // Keep the parts the Scorer needs: duties, what you need, conditions. Drop the page chrome.
  // The page opens with an "On this page" list of the same headings, so cut from the last ones.
  const start = Math.max(t.lastIndexOf('About the position'), 0);
  const end = Math.max(t.lastIndexOf('Our commitment'), t.lastIndexOf('Date modified'));
  const body = t.slice(start, end > start ? end : undefined).trim();
  return { ok: true, external: false, ref, who, text: body.slice(0, 30000) };
}

module.exports = { search, fetchPoster, parseResults, BASE, HOST };
