/**
 * jobbank.js: Job Bank (jobbank.gc.ca), the Government of Canada's national job board.
 * Plain HTTP, no account:
 *  - search: jobsearch?searchstring=&locationstring=&fsrc=16 (only jobs the employer posted on
 *    Job Bank itself; the rest are copies of Indeed and other boards).
 *  - posting: jobposting/<id> (job details, the Job Bank number, who can apply).
 *  - how to apply: the page's own "Show how to apply" request (JSF partial ajax). Many employers
 *    accept applications by email there, which needs no Job Bank account.
 */
const BASE = 'https://www.jobbank.gc.ca';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch (undici), not the https module: Job Bank resets Node's https TLS handshake.
async function request(url, { method = 'GET', body = null, headers = {}, cookie = '' } = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(url, { method, body, signal: c.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-CA,en;q=0.9', ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    const cookies = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []).map((s) => s.split(';')[0]);
    return { status: r.status, body: await r.text(), cookies };
  } catch (_) { return { status: 0, body: '', cookies: [] }; }
  finally { clearTimeout(t); }
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (h) => decode(String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div|dd|dt)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const field = (raw, cls) => strip((raw.match(new RegExp(`<li class="${cls}">([\\s\\S]*?)</li>`)) || [])[1] || '').replace(/^(Location|Salary)\s*/i, '').replace(/\s+/g, ' ').trim();

function parseResults(html) {
  const out = [];
  for (const raw of html.split('<article').slice(1)) {
    const id = (raw.match(/jobposting\/(\d+)/) || [])[1];
    if (!id) continue;
    const title = strip((raw.match(/<span class="noctitle">([\s\S]*?)<\/span>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const source = strip((raw.match(/<li class="source">[\s\S]*?<span class="wb-inv">([^<]+)<\/span>/) || [])[1] || '');
    out.push({ id, jobId: `jobbank_${id}`, title, company: field(raw, 'business'), location: field(raw, 'location'), salary: field(raw, 'salary'),
      date: field(raw, 'date'), source, url: `${BASE}/jobsearch/jobposting/${id}` });
  }
  return out;
}

// Jobs posted on Job Bank by the employer, newest first. location: a city/province, '' = Canada.
async function search(term, { location = '', maxPages = 4 } = {}) {
  const byId = new Map();
  let cookie = '';
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/jobsearch/jobsearch?searchstring=${encodeURIComponent(term)}&locationstring=${encodeURIComponent(location)}&fsrc=16&sort=D${page > 1 ? `&page=${page}` : ''}`;
    const r = await request(url, { cookie });
    if (r.cookies.length) cookie = r.cookies.join('; ');
    if (r.status !== 200) break;
    const jobs = parseResults(r.body);
    let added = 0;
    for (const j of jobs) if (!byId.has(j.id) && /job bank/i.test(j.source || 'Job Bank')) { byId.set(j.id, j); added++; }
    if (!added || jobs.length < 25) break;
    await DELAY(800);
  }
  return [...byId.values()];
}

// The posting: description for the Scorer, Job Bank number, who can apply, and the cookie for
// the how-to-apply request.
async function fetchPosting(id) {
  const r = await request(`${BASE}/jobsearch/jobposting/${encodeURIComponent(id)}`);
  if (r.status !== 200) return { ok: false };
  const t = strip(r.body);
  const start = t.indexOf('Job details');
  const end = t.search(/\nHow to apply|Show how to apply|Advertised until|Report a problem/);
  const description = t.slice(start >= 0 ? start : 0, end > start ? end : undefined).trim().slice(0, 20000);
  const number = (t.match(/Job Bank\s*#\s*(\d{5,})/) || [])[1] || '';
  const who = (t.match(/Who can apply to this job\?\s*([^\n]{0,400})/i) || [])[1] || '';
  const expired = /This job posting is (no longer available|expired)|has expired/i.test(t);
  return { ok: true, description, number, who, expired, cookie: r.cookies.join('; ') };
}

// "Show how to apply": returns { email, directApply, other } (email '' when the employer only
// takes applications through Direct Apply, by mail or in person).
async function howToApply(id, cookie = '') {
  const url = `${BASE}/jobsearch/jobposting/${encodeURIComponent(id)}`;
  if (!cookie) cookie = (await request(url)).cookies.join('; ');
  const body = new URLSearchParams({
    seekeractivity: 'seekeractivity', 'seekeractivity:jobid': String(id), seekeractivity_SUBMIT: '1', 'jakarta.faces.ViewState': 'stateless',
    'jakarta.faces.source': 'seekeractivity', 'jakarta.faces.partial.event': 'click', 'jakarta.faces.partial.execute': 'jobid',
    'jakarta.faces.partial.render': 'applynow markappliedgroup', 'jakarta.faces.behavior.event': 'action', action: 'applynowbutton', 'jakarta.faces.partial.ajax': 'true',
  }).toString();
  const r = await request(url, { method: 'POST', body, cookie, headers: { Referer: url, 'Faces-Request': 'partial/ajax', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
  if (r.status !== 200) return { ok: false };
  const x = r.body.replace(/<!\[CDATA\[|\]\]>/g, '');
  const mail = (x.match(/<h4 id="htaemail">[\s\S]*?href="mailto:([^"?]+)/) || [])[1] || '';
  const email = /^[\w.+'-]+@[\w-]+(\.[\w-]+)+$/.test(mail.trim()) ? mail.trim().toLowerCase() : '';
  const t = strip(x);
  // Things the employer asks applicants to include ("Include this reference number...").
  const ref = (t.match(/[Ii]nclude this reference number when applying:\s*([^\n]{1,60})/) || [])[1] || '';
  return { ok: true, email, directApply: /Direct Apply/i.test(t), byMail: /By mail/i.test(t), inPerson: /In person/i.test(t), reference: ref.trim() };
}

module.exports = { search, fetchPosting, howToApply, parseResults, BASE };
