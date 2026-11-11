// Shared loop for the Reed, LinkedIn and company-site agents: each works in its own tab of one
// shared minimised Chrome window and repeats  search -> score (tailor CV) -> apply  every round, stopping at the
// daily limit. Site-specific steps come from the subclass: signIn(), search(), apply(job).
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { Page } from '../driver/page.js';
import { scoreJob } from './scorer.js';

const salary = require('../../../bot/modules/salary_filter');
const sponsorship = require('../../../bot/modules/sponsorship');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUND_MS = 20 * 60 * 1000;

export function detectWorkType(d) {
  d = String(d || '').toLowerCase();
  if (/\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bremote position\b|\bwork from home\b|\bwfh\b|\bremote working\b|\bremote role\b|\bremote job\b/.test(d)) return 'remote';
  if (/\bhybrid\b/.test(d)) return 'hybrid';
  return 'onsite';
}

// A minimised window. Chrome on Windows restores it (normal, often focused) the first time a
// page draws in it, so watch for that and minimise it again. The watch ends a few seconds after
// the first restore, or when Job-AI shows the window on purpose (showWindow).
const watching = new Map();
export async function openMinimised(opts = { url: 'about:blank' }) {
  const win = await chrome.windows.create({ ...opts, focused: false, state: 'minimized' }).catch(() => null);
  if (!win) return null;
  if (win.state !== 'minimized') await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
  let ending = false;
  const stop = () => { chrome.windows.onBoundsChanged.removeListener(fix); chrome.windows.onRemoved.removeListener(gone); watching.delete(win.id); };
  const gone = (id) => { if (id === win.id) stop(); };
  const fix = async (w) => {
    if (w.id !== win.id) return;
    const x = await chrome.windows.get(win.id).catch(() => null);
    if (!x || x.state === 'minimized' || !watching.has(win.id)) return;
    chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
    if (!ending) { ending = true; setTimeout(stop, 3000); }
  };
  chrome.windows.onBoundsChanged.addListener(fix);
  chrome.windows.onRemoved.addListener(gone);
  watching.set(win.id, stop);
  return win.id;
}
export function showWindow(id) {
  const stop = watching.get(id); if (stop) stop();
  return chrome.windows.update(id, { state: 'normal', focused: true }).catch(() => {});
}

// All agents share one minimised window, each in its own tab. It closes when the last one stops.
let sharedWin = null;
const winUsers = new Set();
export async function agentWindow(agent) {
  winUsers.add(agent);
  const id = sharedWin && (await sharedWin);
  if (id && (await chrome.windows.get(id).catch(() => null))) return id;
  sharedWin = openMinimised();
  return sharedWin;
}
export async function releaseWindow(agent) {
  winUsers.delete(agent);
  const id = agent.windowId;
  if (!id) return;
  if (winUsers.size) { if (agent.page && !agent.page.isClosed()) await chrome.tabs.remove(agent.page.tabId).catch(() => {}); return; }
  sharedWin = null;
  await chrome.windows.remove(id).catch(() => {});
}

// Closing an agent's browser window stops that agent, same as closing the app's browser.
export function stopOnWindowClose(agent) {
  const onRemoved = (id) => {
    if (id !== agent.windowId) return;
    agent.windowId = null;
    if (agent.running) { agent.running = false; agent.log('Browser window closed. Agent stopped.'); agent.onChange(); }
  };
  chrome.windows.onRemoved.addListener(onRemoved);
  return () => chrome.windows.onRemoved.removeListener(onRemoved);
}

export class SiteAgent {
  constructor({ source, label, onChange = () => {} }) { this.source = source; this.label = label; this.onChange = onChange; this.running = false; this.page = null; this.windowId = null; }
  log(m) { store.log(`[${this.label}] ${m}`); }
  async signIn() { return true; }
  async search() {}
  async apply() { return false; }

  async start() {
    if (this.running) return;
    this.running = true; this.onChange();
    this.log('Starting.');
    try {
      if (!this.lazyWindow) await this.ensurePage();
      while (this.running) {
        const off = cfg.outsideSchedule();
        if (off) { if (this._offMsg !== off) this.log(off); this._offMsg = off; await this.wait(Date.now() + 5 * 60 * 1000); continue; }
        this._offMsg = '';
        const roundEnd = Date.now() + ROUND_MS;
        const ok = await this.signIn().catch((e) => { this.log('Sign-in check failed: ' + e.message); return false; });
        if (globalThis.__jobaiSiteAuth) globalThis.__jobaiSiteAuth(this.source, !!ok);
        if (!ok) { this.log(`Not signed in. Press "Sign in again" on the ${this.label} card, then it carries on.`); await this.wait(Date.now() + 2 * 60 * 1000); continue; }
        if (globalThis.__jobaiStep) globalThis.__jobaiStep('site_connected');
        // First win: until the very first application has gone out, find a few jobs, tailor
        // until one is ready and send it straight away, so a new user sees it working in
        // minutes instead of after a full round of searching and tailoring.
        this.firstWin = !(await store.jobs()).some((j) => j.status === 'applied');
        await this.search().catch((e) => this.log('Search error: ' + e.message));
        await this.scorePending({ untilOneReady: this.firstWin });
        await this.applyReady();
        // After the first one is out, check the rest of this round's jobs straight away.
        // Search again only if the first search stopped early to get that one out (Company Sites).
        if (this.firstWin) { this.firstWin = false; if (this.cutShort) { this.cutShort = false; await this.search().catch((e) => this.log('Search error: ' + e.message)); } await this.scorePending(); await this.applyReady(); }
        this.log(`Round done. Next search at ${new Date(roundEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
        await this.wait(roundEnd);
      }
    } catch (e) {
      this.log('Stopped: ' + e.message);
    } finally {
      if (this._unwatch) this._unwatch();
      this._unwatch = null;
      this.running = false;
      await releaseWindow(this);
      this.page = null; this.windowId = null;
      this.onChange();
    }
  }
  // The agents' shared minimised window, opened on first use.
  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.windowId) {
      this.windowId = await agentWindow(this);
      if (!this._unwatch) this._unwatch = stopOnWindowClose(this);
    }
    this.page = await Page.open('about:blank', { windowId: this.windowId });
    return this.page;
  }
  stop() { if (this.running) { this.running = false; this.log('Stopping after the current step.'); this.onChange(); } }
  async wait(until) { while (this.running && Date.now() < until) await sleep(1000); }

  // Common skip rules before a job is queued (same as the app's filterAndQueue).
  async queueIfWanted(job, details) {
    const t = (job.title || '').toLowerCase();
    // Every job left out says why in the log, so nothing disappears silently.
    const said = (reason) => this.log(`Skipped: ${job.title}${job.company ? ` @ ${job.company}` : ''} (${reason})`);
    if (cfg.TITLE_BLOCKLIST.some((k) => t.includes(k))) return said('a word in the title is on your block list');
    if (cfg.COMPANY_BLOCKLIST.some((b) => (job.company || '').toLowerCase().includes(b))) return said('company is on your block list');
    const add = async (fields) => { const ok = await store.addJob({ ...job, ...fields, source: this.source }); if (ok && fields.status === 'skipped') said(fields.reason); return ok; };
    if (details && details.hasEasyApply === false) return add({ status: 'skipped', reason: details.isExternalOnly ? 'External site' : 'No apply button' });
    if (!details || !details.description || details.description.trim().split(/\s+/).length < (this.minWords || 80)) return add({ status: 'skipped', reason: 'Job description too short or missing' });
    if (details.isTrainingCourse || cfg.isTrainingCourseJD(details.description, job.title)) return add({ status: 'skipped', reason: 'Training course' });
    // A site that states the work type (Wellfound's job cards) beats guessing from the text.
    const workType = details.workType || detectWorkType(details.description);
    if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) return add({ status: 'skipped', reason: `Work type (${workType}) not wanted` });
    if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(details.description).catch(() => false))) return add({ status: 'skipped', reason: 'No sponsorship offered' });
    if (!salary.isAcceptable(details.description, cfg.APPLICANT.salaryExpectation)) return add({ status: 'skipped', reason: 'Below your salary expectation' });
    const ok = await add({ ...details, workType, status: 'pending' });
    if (ok) { this.log(`Found: ${job.title} @ ${job.company}`); this.onChange(); }
  }

  async scorePending({ untilOneReady = false } = {}) {
    for (const job of await store.byStatus('pending', this.source)) {
      if (!this.running) return;
      // Only tailor what can still be sent today (+2 spare). The rest wait until tomorrow.
      const left = Math.max(0, cfg.MAX_APPLICATIONS_PER_DAY - (await store.capUsed()));
      if ((await store.readyBacklog()) >= left + 2) return;
      await scoreJob(job, (m) => this.log(m)).catch((e) => this.log('Scoring error: ' + e.message));
      this.onChange();
      if (untilOneReady && (await store.byStatus('cv_ready', this.source)).length) return;
    }
  }

  async applyReady() {
    const order = {}; cfg.WORK_TYPE_PRIORITY.forEach((w, i) => { order[w] = i; });
    const ready = (await store.byStatus('cv_ready', this.source)).sort((a, b) => (order[a.workType] ?? 99) - (order[b.workType] ?? 99));
    for (const job of ready) {
      if (!this.running) return;
      if ((await store.capUsed()) >= cfg.MAX_APPLICATIONS_PER_DAY) { this.log(cfg.MOVE.on && (await store.monthLeft()) <= 0 ? "This month's limit is reached." : 'Daily limit reached.'); return; }
      await store.updateJob(job.jobId, { status: 'applying' });
      this.log(`Applying: ${job.title} @ ${job.company}`);
      let r;
      try { r = await this.apply(job); } catch (e) { r = { error: e.message }; }
      await this.record(job, r);
      await sleep(8000 + Math.random() * 7000);
    }
  }

  async record(job, r) {
    if (r === true) { await store.updateJob(job.jobId, { status: 'applied', appliedAt: new Date().toISOString() }); this.log(`✓ Applied: ${job.title}`); }
    else if (r === null) await store.updateJob(job.jobId, { status: 'skipped', reason: 'Already applied' });
    else if (r === 'external') await store.updateJob(job.jobId, { status: 'skipped', reason: 'Applies on an external site' });
    else if (r === 'cv_not_attached') await store.updateJob(job.jobId, { status: 'skipped', reason: 'Tailored CV could not be attached' });
    else if (r && r.error) { await store.updateJob(job.jobId, { status: 'apply_failed', reason: r.error.slice(0, 140) }); this.log(`Could not apply: ${job.title} (${r.error.slice(0, 80)})`); }
    else if (typeof r === 'string') await store.updateJob(job.jobId, { status: 'skipped', reason: r });
    else { await store.updateJob(job.jobId, { status: 'apply_failed', reason: 'Form could not be completed' }); this.log(`✗ Could not complete: ${job.title}`); }
    this.onChange();
  }
}
