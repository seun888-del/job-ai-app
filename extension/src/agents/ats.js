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
import { SiteAgent, openMinimised, showWindow } from './base.js';

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
  const terms = (cfg.JOB_SEARCHES || []).slice(0, 15).map((t) => String(t).trim()).filter(Boolean).join(',');
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

// Ashby's board API lists every job with its text; one call per company per run.
const ashbyBoards = new Map();
// Job description: the ATS's job API where it has one, otherwise the posting page's text.
// Workable and Ashby pages draw their text with JavaScript, so a plain fetch reads only a
// few words and those jobs were all skipped as having no description.
export async function fetchJD(job) {
  const url = String(job.url);
  const m = url.match(/greenhouse[^/]*\/([^/]+)\/jobs\/(\d+)/i);
  if (m) {
    try { const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`); return stripHtml(d.content).slice(0, 8000); } catch (_) {}
  }
  const wk = url.match(/apply\.workable\.com\/([^/]+)\/j\/([A-Z0-9]+)/i);
  if (wk) {
    try {
      const d = await getJson(`https://apply.workable.com/api/v2/accounts/${wk[1]}/jobs/${wk[2]}`);
      const t = stripHtml([d.description, d.requirements, d.benefits].filter(Boolean).join(' '));
      if (t) return t.slice(0, 8000);
    } catch (_) {}
  }
  const ab = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
  if (ab) {
    try {
      if (!ashbyBoards.has(ab[1])) ashbyBoards.set(ab[1], getJson(`https://api.ashbyhq.com/posting-api/job-board/${ab[1]}`));
      const d = await ashbyBoards.get(ab[1]);
      const p = ((d && d.jobs) || []).find((x) => x.id === ab[2]);
      if (p && (p.descriptionPlain || p.descriptionHtml)) return String(p.descriptionPlain || stripHtml(p.descriptionHtml)).replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch (_) { ashbyBoards.delete(ab[1]); }
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
    // Only the user's own region (the UK/USA/Canada switch), and only titles that fit their terms.
    const countries = [cfg.APPLICANT.country === 'United States' ? 'US' : cfg.APPLICANT.country === 'Canada' ? 'CA' : 'GB'];
    const matchers = titleMatch.compile(cfg.JOB_SEARCHES);
    let jobs = [];
    for (const c of countries) {
      try { jobs = jobs.concat(await feedJobs(c)); } catch (e) { this.log(`Jobs feed unavailable (${e.message}).`); }
    }
    const found = jobs.length;
    jobs = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers)).slice(0, 50);
    this.log(`${found} company-site job(s) in the feed, ${jobs.length} match your job titles.`);
    let fresh = 0;
    for (const job of jobs) if (!(await store.hasJob(job.jobId))) fresh++;
    // The feed gets new jobs every few hours, so a quick re-check often has nothing new.
    if (jobs.length && !fresh) this.log('All of them were checked before. New jobs are added every few hours; more job titles find more.');
    const why = {}; let checked = 0, queued = 0;
    const skip = (r) => { why[r] = (why[r] || 0) + 1; };
    for (const job of jobs) {
      if (!this.running) break;
      if (await store.hasJob(job.jobId)) continue;
      checked++;
      const ats = atsFiller.detectATS(job.url);
      if (atsFiller.ACCOUNT_REQUIRED_ATS.has(ats)) { skip('need a site account'); continue; }
      // SmartRecruiters shows a puzzle after a few automated visits: leave it out.
      if (ats === 'smartrecruiters') { skip('site blocks automated forms'); continue; }
      // A required video or file upload can never go out unattended: skip before any CV tailoring.
      if (await httpSubmit.recruiteeNeedsMedia(job.url)) { skip('ask for a video or file'); await store.addJob({ ...job, source: this.source, status: 'skipped', reason: 'Asks for a video or file upload' }); continue; }
      const description = await fetchJD(job);
      await this.queueIfWanted(job, { ...job, description });
      const saved = (await store.jobs()).find((j) => j.jobId === job.jobId);
      if (saved && saved.status === 'skipped') skip(String(saved.reason || 'other').toLowerCase());
      else if (saved && saved.status === 'pending') queued++;
      else if (!saved) skip('blocked title or company');
      // First win: three queued is enough to get the first application out; the rest straight after.
      if (this.firstWin && (await store.byStatus('pending', this.source)).length >= 3) { this.log('Sending one application first, then checking the rest.'); break; }
      await sleep(800);
    }
    if (checked) {
      const reasons = Object.entries(why).map(([r, n]) => `${n} ${r}`).join(', ');
      this.log(`Checked ${checked} new job(s): ${queued} sent for CV matching` + (reasons ? `, skipped ${reasons}.` : '.'));
    }
  }

  // "Send for me" switch on the Company sites card. On by default.
  async submitOn() { const st = (await store.get('settings')) || {}; return !(st.autoSubmit && st.autoSubmit.ats === false); }

  // A job that can't go out without a person (a human check, an emailed code, a question the
  // profile can't answer). With Send for me on (the default) it is skipped quietly and the agent
  // moves on, so the user only ever sees applications that went out. With it off, the user asked
  // to check each one, so it waits under Ready to send with Fill and open.
  async park(job, why, kind = 'form', { hold = false } = {}) {
    const st = (await store.get('settings')) || {};
    // "Fully automatic": skip it. "Bring me the hard ones" or "Check every application": it waits.
    const skip = (await this.submitOn()) && !st.hardOnes;
    outcome(job, (skip ? 'skip_' : 'wait_') + kind);
    if (skip) {
      await store.updateJob(job.jobId, { status: 'skipped', reason: 'Skipped: ' + (why || 'needs a person to send it.') });
      this.log(`Skipped, moving on: ${job.title} @ ${job.company}${why ? ' (' + why.replace(/\.$/, '') + ')' : ''}`);
    } else {
      // The form is already filled in this tab: keep it, so Open shows it ready for the last step.
      const heldTabId = hold ? await this.holdTab() : null;
      await store.updateJob(job.jobId, { status: 'ready', waitKind: kind, heldTabId, reason: (why ? why + ' ' : '') + (heldTabId ? HELD : READY) });
      this.log(`Ready for you to send: ${job.title} @ ${job.company}${why ? ' (' + why.replace(/\.$/, '') + ')' : ''}`);
    }
    this.onChange();
    return 'ready';
  }

  // Hand the agent's filled tab over to the "Ready to send" window and give the agent a fresh
  // one. Chrome must not discard it, or the filled form is lost. Capped so tabs don't pile up.
  async holdTab() {
    const page = this.page;
    if (!page || page.isClosed()) return null;
    const live = [];
    for (const j of await store.byStatus('ready', this.source)) {
      if (j.heldTabId && (await chrome.tabs.get(j.heldTabId).catch(() => null))) live.push(j.heldTabId);
    }
    if (live.length >= MAX_HELD) return null;
    try {
      const win = live.length ? (await chrome.tabs.get(live[0])).windowId : null;
      if (win) await chrome.tabs.move(page.tabId, { windowId: win, index: -1 });
      else await openMinimised({ tabId: page.tabId });
      await chrome.tabs.update(page.tabId, { autoDiscardable: false }).catch(() => {});
      page._cleanup();
      this.page = null;
      return page.tabId;
    } catch (_) { return null; }
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
        location: A.location, address: A.address, drivingLicence: A.drivingLicence, eeoGender: A.eeoGender, linkedin: A.linkedin,
      }, ask: questionAi.recruiteeAsk(job, job.cvText) });
      if (r.submitted) return true;
      // A required question the profile can't answer: never guess, hand it over.
      if (r.reason === 'needs_media') return 'Asks for a video or file upload';
      if (r.reason === 'needs_you') return this.park(job, 'It asked a question your details can\'t answer.', 'question');
      return { error: `${ats} did not accept the application (${r.reason}${r.status ? ' ' + r.status : ''})` };
    }
    // SmartRecruiters puzzles a browser after a few automated visits, so it always waits for the user.
    if (ats === 'smartrecruiters') return this.park(job, '', 'smartrecruiters');
    if (!(await this.submitOn())) {
      await this.ensurePage();
      await this.page.goto(atsFiller.formUrl(job.url));
      await sleep(1500 + Math.random() * 1500);
      if (await blocked(this.page)) return this.park(job, 'The site asked for a human check.', 'review');
      let filled = 0;
      try {
        await atsFiller.fillExternalForm(this.page, job, job.cvPath, ats, { submit: false });
        filled = (await formState(this.page).catch(() => ({ filled: 0 }))).filled;
      } catch (_) {}
      return this.park(job, '', 'review', { hold: filled >= 2 });
    }
    await this.ensurePage();
    await this.page.goto(atsFiller.formUrl(job.url));
    await sleep(1500 + Math.random() * 1500);
    if (await blocked(this.page)) { reportOutcome(job.url, 'captcha'); return this.park(job, 'The site asked for a human check.', 'captcha'); }
    const r = await atsFiller.fillExternalForm(this.page, job, job.cvPath, ats, { submit: true });
    reportOutcome(job.url, r === true ? 'sent' : atsFiller.lastSubmitOutcome());
    if (r === true) return true;
    const why = { captcha: 'The site asked for a human check.', email_code: 'The site wanted a code from your email.', validation: "It asked a question your details can't answer.", empty: "It asked a question your details can't answer.", unconfirmed: "Sent, but the site didn't confirm it. It won't be sent again." }[atsFiller.lastSubmitOutcome()] || "The form couldn't be finished.";
    const kind = { captcha: 'captcha', email_code: 'email_code', validation: 'question', empty: 'question', unconfirmed: 'unconfirmed' }[atsFiller.lastSubmitOutcome()] || 'form';
    // Unconfirmed sends are done; everything else stopped on a filled form worth keeping.
    return this.park(job, why, kind, { hold: kind !== 'unconfirmed' });
  }

  async record(job, r) {
    if (r === 'ready') return;
    if (r === true) outcome(job, 'sent');
    if ((r && r.error) || r === false || r === undefined) {
      outcome(job, r && r.error ? 'skip_refused' : 'skip_form');
      const why = r && r.error ? String(r.error).slice(0, 120) : "the form couldn't be finished";
      await store.updateJob(job.jobId, { status: 'skipped', reason: 'Skipped: ' + why });
      this.log(`Skipped, moving on: ${job.title} @ ${job.company} (${why})`);
      return;
    }
    return super.record(job, r);
  }
}

const READY = 'Ready for you: press Fill and open, check it, then Submit.';
const HELD = 'Filled in. Press Open, do the last step, then Submit.';
const MAX_HELD = 8;
// What's left for the user on a kept tab.
const LAST_STEP = {
  captcha: 'Already filled in. Pass the check on the page, then press Submit.',
  email_code: 'Already filled in. Type the code from your email, then press Submit.',
  question: 'Already filled in. Answer the highlighted question, then press Submit.',
  form: 'Already filled in. Finish anything highlighted, then press Submit.',
  review: 'Already filled in. Check it, then press Submit.',
};
// Close a kept tab once its job is sent or skipped.
export function releaseHeld(job) {
  if (job && job.heldTabId) chrome.tabs.remove(job.heldTabId).catch(() => {});
}
// One anonymous count per finished job (see __jobaiOutcome in dashboard.js).
function outcome(job, kind) {
  if (globalThis.__jobaiOutcome) globalThis.__jobaiOutcome(atsFiller.detectATS(job.url) || job.ats || '', kind);
}
// Confirmation text the sites show after a real submission.
const SENT_RE = /application (has been )?(received|submitted|sent)|thank you for (applying|your application|your interest)|thanks for applying|successfully (applied|submitted)|we('| ha)ve received your application|application complete/i;

// Fill and open: fill one waiting job in a tab the user can see and leave Submit to them.
// Watches the tab and marks the job applied when the site confirms; closing the tab leaves
// it in the list. Never presses Submit.
export async function fillAndOpen(jobId, onChange = () => {}) {
  const job = (await store.jobs()).find((j) => j.jobId === jobId && j.status === 'ready');
  if (!job) return { ok: false, message: 'That application is no longer waiting.' };
  const ats = atsFiller.detectATS(job.url);
  const kept = job.heldTabId ? await chrome.tabs.get(job.heldTabId).catch(() => null) : null;
  let tab, note = 'Filled. Check the form, pass any check, then press Submit.';
  if (kept) {
    tab = new Page(kept.id, kept.windowId);
    await showWindow(kept.windowId);
    await chrome.tabs.update(kept.id, { active: true });
    note = LAST_STEP[job.waitKind] || LAST_STEP.form;
  } else {
    tab = await Page.open(atsFiller.formUrl(job.url), { active: true });
    await sleep(2500);
  }
  if (!kept) try {
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
