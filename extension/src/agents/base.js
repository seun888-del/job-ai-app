// Shared loop for the Reed, LinkedIn and company-site agents: each works in its own minimised
// Chrome window and repeats  search -> score (tailor CV) -> apply  every round, stopping at the
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
      const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' }).catch(() => null);
      this.windowId = win && win.id;
      this.page = await Page.open('about:blank', { windowId: this.windowId });
      while (this.running) {
        const roundEnd = Date.now() + ROUND_MS;
        const ok = await this.signIn().catch((e) => { this.log('Sign-in check failed: ' + e.message); return false; });
        if (!ok) { this.log(`Not signed in. Sign in to ${this.label} in Chrome, then it carries on.`); await this.wait(Date.now() + 2 * 60 * 1000); continue; }
        await this.search().catch((e) => this.log('Search error: ' + e.message));
        await this.scorePending();
        await this.applyReady();
        this.log('Round done. Searching again in a few minutes.');
        await this.wait(roundEnd);
      }
    } catch (e) {
      this.log('Stopped: ' + e.message);
    } finally {
      this.running = false;
      if (this.windowId) await chrome.windows.remove(this.windowId).catch(() => {});
      this.page = null; this.windowId = null;
      this.onChange();
    }
  }
  stop() { if (this.running) { this.running = false; this.log('Stopping after the current step.'); this.onChange(); } }
  async wait(until) { while (this.running && Date.now() < until) await sleep(1000); }

  // Common skip rules before a job is queued (same as the app's filterAndQueue).
  async queueIfWanted(job, details) {
    const t = (job.title || '').toLowerCase();
    if (cfg.TITLE_BLOCKLIST.some((k) => t.includes(k))) return;
    if (cfg.COMPANY_BLOCKLIST.some((b) => (job.company || '').toLowerCase().includes(b))) return;
    const add = (fields) => store.addJob({ ...job, ...fields, source: this.source });
    if (!details || !details.description || details.description.trim().split(/\s+/).length < (this.minWords || 80)) return add({ status: 'skipped', reason: 'Job description too short or missing' });
    if (details.isTrainingCourse || cfg.isTrainingCourseJD(details.description, job.title)) return add({ status: 'skipped', reason: 'Training course' });
    if (details.hasEasyApply === false) return add({ status: 'skipped', reason: details.isExternalOnly ? 'External site' : 'No apply button' });
    const workType = detectWorkType(details.description);
    if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) return add({ status: 'skipped', reason: `Work type (${workType}) not wanted` });
    if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(details.description).catch(() => false))) return add({ status: 'skipped', reason: 'No sponsorship offered' });
    if (!salary.isAcceptable(details.description, cfg.APPLICANT.salaryExpectation)) return add({ status: 'skipped', reason: 'Below your salary expectation' });
    const ok = await add({ ...details, workType, status: 'pending' });
    if (ok) { this.log(`Found: ${job.title} @ ${job.company}`); this.onChange(); }
  }

  async scorePending() {
    for (const job of await store.byStatus('pending', this.source)) {
      if (!this.running) return;
      // Only tailor what can still be sent today (+2 spare). The rest wait until tomorrow.
      const left = Math.max(0, cfg.MAX_APPLICATIONS_PER_DAY - (await store.appliedToday()));
      if ((await store.readyBacklog()) >= left + 2) return;
      await scoreJob(job, (m) => this.log(m)).catch((e) => this.log('Scoring error: ' + e.message));
      this.onChange();
    }
  }

  async applyReady() {
    const order = {}; cfg.WORK_TYPE_PRIORITY.forEach((w, i) => { order[w] = i; });
    const ready = (await store.byStatus('cv_ready', this.source)).sort((a, b) => (order[a.workType] ?? 99) - (order[b.workType] ?? 99));
    for (const job of ready) {
      if (!this.running) return;
      if ((await store.appliedToday()) >= cfg.MAX_APPLICATIONS_PER_DAY) { this.log('Daily limit reached.'); return; }
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
