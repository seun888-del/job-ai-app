/**
 * workhub.js: the UK government's job site (jobs.service.gov.uk, "Work Hub", which replaced
 * Find a Job). Plain HTTP, no account:
 *  - search: /jobs/search?keywords=&location=&pageNumber= (10 a page)
 *  - posting: /jobs/<id> (title, employer, pay, the advert text)
 *  - how to apply: /jobs/<id>/before-you-apply has the employer's "Continue" link. When that link
 *    is an Aplitrak (Broadbean) link, its adid is the recruiter's application inbox, which takes
 *    a CV by email; a mailto link is an email address too. Anything else is the employer's site.
 * Shared by the desktop app and the Chrome extension.
 */
const BASE = 'https://www.jobs.service.gov.uk';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
  try {
    const inBrowser = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    const r = await fetch(url, { signal: c.signal, ...(inBrowser ? {} : { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-GB,en;q=0.9' } }) });
    return { status: r.status, body: await r.text() };
  } catch (_) { return { status: 0, body: '' }; }
  finally { clearTimeout(t); }
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (h) => decode(String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

function parseResults(html) {
  const out = [];
  for (const raw of String(html).split('data-testid="searchResultCard-').slice(1)) {
    const id = (raw.match(/^([0-9a-f]{20,})/) || [])[1];
    if (!id) continue;
    const title = strip((raw.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1] || '');
    const emp = (raw.match(/data-testid="searchResultCardEmployer">([\s\S]*?)<\/p>/) || [])[1] || '';
    const spans = [...emp.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]));
    const company = spans[0] || '';
    const location = (spans[1] || '').replace(/^\s*-\s*/, '');
    const salary = strip((raw.match(/govuk-!-font-weight-bold govuk-!-margin-bottom-2">([\s\S]*?)<\/p>/) || [])[1] || '');
    out.push({ id, jobId: `workhub_${id}`, title, company, location, salary, url: `${BASE}/jobs/${id}` });
  }
  return out;
}

// Jobs for a title, newest pages first. location: a town or postcode, '' = all of the UK.
async function search(term, { location = '', maxPages = 3 } = {}) {
  const byId = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ keywords: term, ...(location ? { location } : {}), ...(page > 1 ? { pageNumber: String(page) } : {}) });
    const r = await request(`${BASE}/jobs/search?${q}`);
    if (r.status !== 200) break;
    const jobs = parseResults(r.body);
    let added = 0;
    for (const j of jobs) if (!byId.has(j.id)) { byId.set(j.id, j); added++; }
    if (!added || jobs.length < 10) break;
    await DELAY(800);
  }
  return [...byId.values()];
}

// The advert: description for the Scorer and the cover letter, plus the closing date.
async function fetchPosting(id) {
  const r = await request(`${BASE}/jobs/${encodeURIComponent(id)}`);
  if (r.status !== 200) return { ok: false };
  const main = r.body.slice(r.body.indexOf('<main'), r.body.indexOf('</main>') > 0 ? r.body.indexOf('</main>') : undefined);
  const t = strip(main);
  const start = t.search(/\bSummary\b/);
  const end = t.search(/\n(Report (this|a) job|Share this job|Back to (top|search)|Is there anything wrong)/i);
  const description = t.slice(start >= 0 ? start + 7 : 0, end > start ? end : undefined).trim().slice(0, 20000);
  const closing = (main.match(/data-testid="closingDate">([^<]+)</) || [])[1] || '';
  return { ok: true, description, closing: closing.trim(), expired: /no longer (available|accepting)|this job has closed/i.test(t) };
}

// The recruiter's application inbox from an Aplitrak link (its adid is the address, base64).
function aplitrakEmail(href) {
  try {
    const adid = new URL(href).searchParams.get('adid') || '';
    const b64 = adid.replace(/-/g, '+').replace(/_/g, '/');
    const txt = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString();
    const email = txt.trim().toLowerCase();
    return /^[\w.+'-]+@[\w-]+(\.[\w-]+)+$/.test(email) ? email : '';
  } catch (_) { return ''; }
}

// How the job takes applications: { ok, email, website }.
async function howToApply(id) {
  const r = await request(`${BASE}/jobs/${encodeURIComponent(id)}/before-you-apply`);
  if (r.status !== 200) return { ok: false };
  const href = decode((r.body.match(/href="([^"]+)"[^>]*>\s*Continue to the employer/) || [])[1] || '');
  let email = '';
  if (/^mailto:/i.test(href)) email = href.slice(7).split('?')[0].trim().toLowerCase();
  else if (/aplitrak\.com/i.test(href)) email = aplitrakEmail(href);
  if (email && !/^[\w.+'-]+@[\w-]+(\.[\w-]+)+$/.test(email)) email = '';
  return { ok: true, email, website: email ? '' : href };
}

function noEmailReason(how) {
  if (!how || !how.ok || how.email) return '';
  return how.website ? "Applies on the employer's own website, not by email" : 'No way to apply by email';
}

module.exports = { search, fetchPosting, howToApply, noEmailReason, parseResults, aplitrakEmail, BASE };
