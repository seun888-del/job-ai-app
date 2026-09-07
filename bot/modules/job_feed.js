/**
 * job_feed.js
 * Discovery via the licensed backend's candidate feed (GET /v1/jobs/candidates),
 * which runs an official Reed API search for the user's own terms server-side —
 * instead of the Reed agent scraping reed.co.uk's search results, which is the
 * flaky, blockable part that also runs dry.
 *
 * OPT-IN and FAIL-SAFE. It only runs when JOBBOT_USE_JOB_FEED=1 and a licence key
 * is present, and on any problem (off, no key, network error, empty) it returns
 * an empty list so the Reed agent falls straight back to its live search. It
 * never touches the apply pipeline: it only supplies the job LIST that Phase 1
 * then runs through the exact same JD extraction, filters and apply flow.
 */
const cfg = require('../config');

function backendUrl() { return process.env.JOBBOT_BACKEND_URL || 'https://api.tryjobai.com'; }
function licenseKey() { return process.env.JOBBOT_LICENSE_KEY; }
function enabled() { return process.env.JOBBOT_USE_JOB_FEED === '1' && !!licenseKey(); }

// Returns Reed job stubs shaped exactly like reed.searchJobs():
//   { jobId: 'reed_<id>', title, company, url, description }
// Empty array on any problem, so the caller can fall back to the live search.
async function fetchReedStubs({ country = 'GB', limit = 200 } = {}) {
  if (!enabled()) return [];
  try {
    const terms = (cfg.JOB_SEARCHES || []).slice(0, 5).map((t) => String(t).trim()).filter(Boolean).join(',');
    const url = `${backendUrl()}/v1/jobs/candidates?country=${encodeURIComponent(country)}&limit=${limit}`
      + (terms ? `&terms=${encodeURIComponent(terms)}` : '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${licenseKey()}` }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) { console.warn(`  [Feed] candidates ${res.status} — falling back to live search`); return []; }
    const data = await res.json().catch(() => ({}));
    const jobs = (data && data.jobs) || [];
    const stubs = jobs
      .filter((j) => j && j.apply_kind === 'reed' && j.apply_url)
      .map((j) => ({
        jobId: 'reed_' + String(j.id || '').split(':').pop(),
        title: j.title,
        company: j.company,
        url: j.apply_url,
        description: j.description || '',
      }))
      .filter((s) => s.jobId !== 'reed_' && s.url);
    console.log(`  [Feed] ${stubs.length} Reed job(s) from the backend feed (${terms || 'no terms'})`);
    return stubs;
  } catch (err) {
    console.warn(`  [Feed] unavailable (${err.message}) — falling back to live search`);
    return [];
  }
}

module.exports = { enabled, fetchReedStubs };
