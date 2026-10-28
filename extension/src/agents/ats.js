// Company-sites agent for the extension: the same jobs feed, form filler and Recruitee direct
// submit as the desktop app's Auto-Apply agent (bot/bot_greenhouse.js), run in the user's Chrome.
// Jobs come from the Job-AI feed (Greenhouse, Lever, Recruitee and other company career pages).
// Recruitee sends over plain HTTP. The other sites (Greenhouse, Workable, Lever, Ashby,
// SmartRecruiters) guard Submit with a captcha or bot check: with "Send for me" on the agent
// presses Submit and anything that shows a check waits in Ready to send; with it off they
// all wait there for the user's Fill and open (fillAndOpen below).
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { Page } from '../driver/page.js';
import { SiteAgent } from './base.js';

const atsFiller = require('../../../bot/modules/ats_filler');
const httpSubmit = require('../../../bot/modules/ats_http_submit');
const questionAi = require('../../../bot/modules/question_ai');
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
  const url = `${BACKEND}/v1/jobs/candidates?country=${country}&limit=200` + (terms ? `&terms=${encodeURIComponent(terms)}` : '');
  const data = await getJson(url, { headers: llm.headers() });
  return (data.jobs || [])
    .filter((j) => j && (j.auto_apply || j.assist) && j.apply_url)
    .map((j) => ({ jobId: 'gh_' + String(j.id || '').split(':').pop(), title: j.title, company: j.company, url: j.apply_url, description: j.description || '', ats: j.source || 'greenhouse' }))
    .filter((j) => j.jobId !== 'gh_');
}

// Tell the backend how a send went, so employers whose form always stops for a human
// (captcha, emailed code) drop out of the feed. Only the job URL and outcome are sent.
function reportOutcome(url, outcome) {
  if (!url || !outcome) return;
  fetch(`${BACKEND}/v1/jobs/outcome`, { method: 'POST', headers: { ...llm.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ url, outcome }), signal: AbortSignal.timeout(10000) }).catch(() => {});
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
  constructor(opts) { super({ ...opts, source: 'ats', label: 'Company sites' }); this.minWords = 60; this.lazyWindow = true; }

  async search() {
    if (!(cfg.JOB_SEARCHES || []).length) { this.log('Add search terms on the Setup page to find jobs.'); return; }
    // Only the user's own region (the UK/USA switch), and only titles that fit their terms.
    const countries = [cfg.APPLICANT.country === 'United States' ? 'US' : 'GB'];
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
      // SmartRecruiters shows a puzzle after a few automated visits: leave it out.
      if (ats === 'smartrecruiters') continue;
      const description = await fetchJD(job);
      await this.queueIfWanted(job, { ...job, description });
      await sleep(800);
    }
  }

  // "Send for me" switch on the Company sites card. On by default.
  async submitOn() { const st = (await store.get('settings')) || {}; return !(st.autoSubmit && st.autoSubmit.ats === false); }

  // Park a job for the user: it shows under Ready to send with Fill and open.
  async park(job, why) {
    await store.updateJob(job.jobId, { status: 'ready', reason: (why ? why + ' ' : '') + READY });
    this.log(`Ready for you to send: ${job.title} @ ${job.company}${why ? ' (' + why.replace(/\.$/, '') + ')' : ''}`);
    this.onChange();
    return 'ready';
  }

  async apply(job) {
    const ats = atsFiller.detectATS(job.url);
    const httpFn = httpSubmit.httpSubmitterFor(ats) || httpSubmit.httpSubmitterFor(job.ats);
    if (httpFn) {
      const A = cfg.APPLICANT;
      const r = await httpFn({ url: job.url, cvPath: job.cvPath, coverLetter: job.coverLetter || '', dryRun: false, applicant: {
        firstName: A.firstName, lastName: A.lastName, email: A.email, phone: A.phone, country: A.country,
        rightToWorkCountries: A.rightToWorkCountries, requiresSponsorship: A.requiresSponsorship,
        salaryExpectation: A.salaryExpectation, yearsExperience: A.yearsExperience, availability: A.availability,
        location: A.location, address: A.address, drivingLicence: A.drivingLicence, eeoGender: A.eeoGender,
      }, ask: questionAi.recruiteeAsk(job, job.cvText) });
      if (r.submitted) return true;
      // A required question the profile can't answer: never guess, hand it over.
      if (r.reason === 'needs_you') return this.park(job, 'A question needs your answer.');
      return { error: `${ats} did not accept the application (${r.reason}${r.status ? ' ' + r.status : ''})` };
    }
    // SmartRecruiters puzzles a browser after a few automated visits, so it always waits for the user.
    if (!(await this.submitOn()) || ats === 'smartrecruiters') return this.park(job, '');
    await this.ensurePage();
    await this.page.goto(atsFiller.formUrl(job.url));
    await sleep(1500 + Math.random() * 1500);
    if (await blocked(this.page)) { reportOutcome(job.url, 'captcha'); return this.park(job, 'The site asked for a human check.'); }
    const r = await atsFiller.fillExternalForm(this.page, job, job.cvPath, ats, { submit: true });
    reportOutcome(job.url, r === true ? 'sent' : atsFiller.lastSubmitOutcome());
    if (r === true) return true;
    const why = { captcha: 'The site asked for a human check.', email_code: 'The site emailed you a code to finish it.', validation: 'A question needs your answer.', empty: 'A question needs your answer.', unconfirmed: "The site didn't confirm it. Check your email before sending again." }[atsFiller.lastSubmitOutcome()] || 'Needs you to finish it.';
    return this.park(job, why);
  }

  async record(job, r) { if (r !== 'ready') return super.record(job, r); }
}

const READY = 'Ready for you: press Fill and open, check it, then Submit.';
// Confirmation text the sites show after a real submission.
const SENT_RE = /application (has been )?(received|submitted|sent)|thank you for (applying|your application|your interest)|thanks for applying|successfully (applied|submitted)|we('| ha)ve received your application|application complete/i;

// Fill and open: fill one waiting job in a tab the user can see and leave Submit to them.
// Watches the tab and marks the job applied when the site confirms; closing the tab leaves
// it in the list. Never presses Submit.
export async function fillAndOpen(jobId, onChange = () => {}) {
  const job = (await store.jobs()).find((j) => j.jobId === jobId && j.status === 'ready');
  if (!job) return { ok: false, message: 'That application is no longer waiting.' };
  const ats = atsFiller.detectATS(job.url);
  const tab = await Page.open(atsFiller.formUrl(job.url), { active: true });
  await sleep(2500);
  let note = 'Filled. Check the form, pass any check, then press Submit.';
  try {
    if (await blocked(tab)) note = 'Pass the check on the page, then fill in and submit the form.';
    else {
      await atsFiller.fillExternalForm(tab, job, job.cvPath, ats, { submit: false });
      const filled = await formState(tab).catch(() => ({ filled: 0 }));
      if (filled.filled < 2) note = "Couldn't fill this form. Press Apply on the page, fill it in, then press Submit.";
    }
  } catch (_) { note = "Couldn't fill everything. Finish it on the page, then press Submit."; }
  store.log('⚠ ' + note);
  const pageState = () => tab.evaluate(() => ({
    url: location.href,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
    submit: [...document.querySelectorAll('button, input[type="submit"]')].some((b) => (b.offsetParent || b.getClientRects().length) && /submit|send application|apply/i.test(b.innerText || b.value || '')),
  }));
  const before = await pageState().catch(() => ({ text: '', submit: true }));
  const hadText = SENT_RE.test(before.text);
  // Sent = a confirmation URL, or confirmation text that wasn't on the form before (an advert
  // can say "thank you for your interest") or that shows once the Submit button has gone.
  (async () => {
    const until = Date.now() + 30 * 60 * 1000;
    while (Date.now() < until && !tab.isClosed()) {
      await sleep(2000);
      const st = await pageState().catch(() => null);
      if (!st) continue;
      if (/\/confirmation|\/thank[-_]?you|\/success/i.test(st.url) || (SENT_RE.test(st.text) && (!hadText || !st.submit))) {
        await store.updateJob(job.jobId, { status: 'applied', appliedAt: new Date().toISOString(), reason: 'Sent by you' });
        store.log(`✓ Sent: ${job.title} @ ${job.company}`);
        onChange();
        return;
      }
    }
  })();
  return { ok: true, message: note };
}
