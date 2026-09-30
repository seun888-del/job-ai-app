// Company-sites agent for the extension: the same jobs feed, form filler and Recruitee direct
// submit as the desktop app's Auto-Apply agent (bot/bot_greenhouse.js), run in the user's Chrome.
// Jobs come from the Job-AI feed (Greenhouse, Lever, Recruitee and other company career pages).
// "Submit for me" off = the form is filled in a normal tab and left open for the user to send.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { Page } from '../driver/page.js';
import { SiteAgent } from './base.js';

const atsFiller = require('../../../bot/modules/ats_filler');
const httpSubmit = require('../../../bot/modules/ats_http_submit');
const llm = require('../shims/llm.js');
const titleMatch = require('../../../bot/modules/title_match');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKEND = 'https://api.tryjobai.com';

const stripHtml = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Auto-appliable company-site jobs for the user's search terms (same feed the app uses).
export async function feedJobs(country) {
  const terms = (cfg.JOB_SEARCHES || []).slice(0, 5).map((t) => String(t).trim()).filter(Boolean).join(',');
  const url = `${BACKEND}/v1/jobs/candidates?country=${country}&limit=100` + (terms ? `&terms=${encodeURIComponent(terms)}` : '');
  const data = await getJson(url, { headers: llm.headers() });
  return (data.jobs || [])
    .filter((j) => j && j.auto_apply && j.apply_url)
    .map((j) => ({ jobId: 'gh_' + String(j.id || '').split(':').pop(), title: j.title, company: j.company, url: j.apply_url, description: j.description || '', ats: j.source || 'greenhouse' }))
    .filter((j) => j.jobId !== 'gh_');
}

// Job description: Greenhouse's job API, otherwise the posting page's text.
export async function fetchJD(job) {
  const m = String(job.url).match(/greenhouse[^/]*\/([^/]+)\/jobs\/(\d+)/i);
  if (m) {
    try { const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`); return stripHtml(d.content).slice(0, 8000); } catch (_) {}
  }
  try {
    const r = await fetch(job.url, { signal: AbortSignal.timeout(20000) });
    if (r.ok) { const t = stripHtml(await r.text()).slice(0, 8000); if (t.split(/\s+/).length >= 60) return t; }
  } catch (_) {}
  return job.description || '';
}

// A bot check or CAPTCHA page instead of the form. The agent never tries to get past these.
async function blocked(page) {
  const t = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 3000)).catch(() => '');
  return /verification required|verify you are (a )?human|are you a robot|unusual activity|captcha/i.test(t);
}
async function formState(page) {
  return page.evaluate(() => ({
    filled: Array.from(document.querySelectorAll('input[type=text],input[type=email],input[type=tel],input:not([type]),textarea'))
      .filter((i) => i.offsetParent && String(i.value || '').trim()).length,
  }));
}

export class AtsAgent extends SiteAgent {
  constructor(opts) { super({ ...opts, source: 'ats', label: 'Company sites' }); this.minWords = 60; }

  async search() {
    if (!(cfg.JOB_SEARCHES || []).length) { this.log('Add search terms on the Setup page to find jobs.'); return; }
    // Only the countries the user can work in (UK by default), and only titles that fit their terms.
    const where = [cfg.APPLICANT.country, ...(cfg.APPLICANT.rightToWorkCountries || [])].join(' ').toLowerCase();
    const countries = [];
    if (!where.trim() || /united kingdom|\buk\b|britain|england|scotland|wales|northern ireland/.test(where)) countries.push('GB');
    if (/united states|\busa?\b|america/.test(where)) countries.push('US');
    if (!countries.length) countries.push('GB');
    const matchers = titleMatch.compile(cfg.JOB_SEARCHES);
    let jobs = [];
    for (const c of countries) {
      try { jobs = jobs.concat(await feedJobs(c)); } catch (e) { this.log(`Jobs feed unavailable (${e.message}).`); }
    }
    const found = jobs.length;
    jobs = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers)).slice(0, 50);
    this.log(`${found} company-site job(s) in the feed, ${jobs.length} match your job titles.`);
    for (const job of jobs) {
      if (!this.running) return;
      if (await store.hasJob(job.jobId)) continue;
      const ats = atsFiller.detectATS(job.url);
      if (atsFiller.ACCOUNT_REQUIRED_ATS.has(ats)) continue;
      const description = await fetchJD(job);
      await this.queueIfWanted(job, { ...job, description });
      await sleep(800);
    }
  }

  async submitOn() { return ((await store.get('settings')) || {}).atsSubmit !== false; }

  async apply(job) {
    const ats = atsFiller.detectATS(job.url);
    const submit = await this.submitOn();
    const httpFn = submit && (httpSubmit.httpSubmitterFor(ats) || httpSubmit.httpSubmitterFor(job.ats));
    if (httpFn) {
      const A = cfg.APPLICANT;
      const r = await httpFn({ url: job.url, cvPath: job.cvPath, coverLetter: job.coverLetter || '', dryRun: false, applicant: {
        firstName: A.firstName, lastName: A.lastName, email: A.email, phone: A.phone,
        rightToWorkCountries: A.rightToWorkCountries, requiresSponsorship: A.requiresSponsorship,
        salaryExpectation: A.salaryExpectation, yearsExperience: A.yearsExperience, availability: A.availability,
      } });
      if (r.submitted) return true;
      return { error: `${ats} did not accept the application (${r.reason}${r.status ? ' ' + r.status : ''})` };
    }
    if (submit) {
      await this.page.goto(job.url);
      await sleep(1500 + Math.random() * 1500);
      if (await blocked(this.page)) return 'Site asked for a verification check';
      const r = await atsFiller.fillExternalForm(this.page, job, job.cvPath, ats, { submit: true });
      return r === true ? true : { error: `${ats} form could not be completed` };
    }
    // Fill-only: do it in a normal tab the user can see, and leave it open for them to send.
    const tab = await Page.open(job.url, { active: false });
    await sleep(1500 + Math.random() * 1500);
    if (await blocked(tab)) { await tab.close(); return 'Site asked for a verification check'; }
    const r = await atsFiller.fillExternalForm(tab, job, job.cvPath, ats, { submit: false });
    // Only call it filled if the form really has our answers in it.
    const state = await formState(tab).catch(() => ({ filled: 0 }));
    if ((r === 'dry_run' || r === true) && state.filled >= 2) {
      await store.updateJob(job.jobId, { status: 'ready', reason: 'Filled in. Open the tab, check it and press Submit.' });
      this.log(`Filled, waiting for you to submit: ${job.title} @ ${job.company}`);
      this.onChange();
      return 'ready';
    }
    if (await blocked(tab)) { await tab.close(); return 'Site asked for a verification check'; }
    await tab.close();
    return { error: `${ats} form could not be completed` };
  }

  async record(job, r) { if (r !== 'ready') return super.record(job, r); }
}
