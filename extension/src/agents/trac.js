// NHS / Trac agent for the extension. Same flow as the desktop app (bot/bot_trac.js plus the
// Scorer's NHS path), using the SAME shared modules for searching, the supporting statement
// and filling the form. Runs in the Job-AI dashboard tab.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { Page } from '../driver/page.js';

const trac = require('../../../bot/modules/trac_source');
const salary = require('../../../bot/modules/salary_filter');
const { generateNhsStatementDetailed } = require('../../../bot/modules/nhs_statement');
const { fillApplication, ensureTracLogin, listTracApplications } = require('../../../bot/modules/trac_apply');

const SOURCE = 'trac';
const AI_NOTE = ' This form asks about AI use, so you submit it yourself.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);

// Title filter shared with the desktop app (bot/modules/title_match.js).
const titleMatch = require('../../../bot/modules/title_match');

// Part-time / fixed-term jobs the user didn't ask for (same rule as the app's Scorer).
function preFilter(job) {
  const want = cfg.APPLICANT.employmentType || ['full_time'];
  const txt = (job.title + ' ' + String(job.description || '').slice(0, 500)).toLowerCase();
  const permanent = /\bpermanent\b/.test(txt);
  const contract = !permanent && /\b(fixed[- ]?term|\bftc\b|temporary|secondment|locum|\d{1,2}[- ]month(?:s)?(?:\s+(?:contract|fixed[- ]?term|ftc)))\b/i.test(txt);
  const partTime = /\bpart.?time\b/i.test(job.title + ' ' + String(job.description || '').slice(0, 300));
  if (contract && !want.includes('contract')) return 'Fixed-term or contract role (you asked for permanent)';
  if (partTime && !want.includes('part_time')) return 'Part-time role (you asked for full-time)';
  return '';
}

export class TracAgent {
  constructor({ onChange = () => {} } = {}) { this.running = false; this.page = null; this.onChange = onChange; }
  log(m) { store.log('[NHS] ' + m); }

  async settings() { return store.get('settings'); }
  async autoSubmit() { const s = await this.settings(); return !!(s.autoSubmit && s.autoSubmit.trac); }

  async start() {
    if (this.running) return;
    this.running = true; this.onChange();
    this.log(`Starting (${(await this.autoSubmit()) ? 'Submit for me is ON' : 'you submit applications yourself'}).`);
    try {
      // One background window for the agent's pages, so your own tabs are never touched.
      const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' }).catch(() => null);
      this.windowId = win && win.id;
      this.page = await Page.open('about:blank', { windowId: this.windowId });
      while (this.running) {
        const cycleEnd = Date.now() + 10 * 60 * 1000;
        await this.search().catch((e) => this.log('Search error: ' + e.message));
        if (!this.running) break;
        await this.prepare().catch((e) => this.log('Prepare error: ' + e.message));
        if (!this.running) break;
        // Trac asks for a sign-in: bring the agent window up so the user can do it.
        const signedIn = await ensureTracLogin(this.page, (m) => { this.log(m); if (/Waiting for you to complete login/i.test(m) && this.windowId) chrome.windows.update(this.windowId, { state: 'normal', focused: true }).catch(() => {}); });
        if (signedIn && this.windowId) chrome.windows.update(this.windowId, { state: 'minimized' }).catch(() => {});
        if (!signedIn) { this.log('Not signed in to Trac. Sign in in the Job-AI window, then it carries on.'); await this.wait(cycleEnd); continue; }
        await this.resumeDrafts().catch((e) => this.log('Drafts error: ' + e.message));
        if (!this.running) break;
        await this.applyReady().catch((e) => this.log('Apply error: ' + e.message));
        this.log('Round done. Next search in a few minutes.');
        await this.wait(cycleEnd);
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

  // 1. Search HealthJobsUK for the NHS terms and read each new advert.
  async search() {
    const t = cfg.TRAC_DETAILS || {};
    const terms = (Array.isArray(t.searchTerms) && t.searchTerms.length ? t.searchTerms : cfg.JOB_SEARCHES).map((x) => String(x).trim()).filter(Boolean);
    if (!terms.length) { this.log('Add NHS search terms on the Setup page to start finding jobs.'); return; }
    const matchers = titleMatch.compile(terms);
    const chosen = (cfg.TRAC_SECTORS || []).filter((s) => trac.SECTORS[s]);
    const sectors = chosen.length ? chosen : trac.sectorsForTerms(terms);
    let queued = 0;
    for (const term of terms) {
      if (!this.running) return;
      let jobs = [];
      try { jobs = await trac.searchTrac(term, { pages: 1, sectors, page: this.page }); } catch (e) { this.log(`Search failed for "${term}": ${e.message}`); continue; }
      const found = jobs.length;
      jobs = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
      this.log(`"${term}": ${found} job(s), ${jobs.length} match your terms.`);
      for (const job of jobs) {
        if (!this.running) return;
        if (await store.hasJob(job.jobId)) continue;
        const jd = await trac.fetchTracJD(job.url, this.page).catch(() => '');
        if (!jd || jd.split(/\s+/).length < 60) { await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: 'Advert could not be read' }); continue; }
        if (!salary.isAcceptable(jd, cfg.APPLICANT.salaryExpectation)) { await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: 'Below your salary expectation' }); continue; }
        await store.addJob({ ...job, description: jd, source: SOURCE, status: 'pending' });
        queued++; this.onChange();
        await sleep(1500);
      }
    }
    this.log(`Search done: ${queued} new job(s) found.`);
  }

  // 2. For each new job: check the CV evidences at least half the essential criteria, and write
  //    the supporting statement from that evidence (the app's Scorer does this step).
  async prepare() {
    const cv = await store.get('cv');
    const cvText = (cv && cv.text) || '';
    for (const job of await store.byStatus('pending', SOURCE)) {
      if (!this.running) return;
      const why = preFilter(job);
      if (why) { await store.updateJob(job.jobId, { status: 'skipped', reason: why }); continue; }
      if (!cvText) { this.log('Add your CV on the Setup page so jobs can be checked.'); return; }
      this.log(`Checking: ${job.title}`);
      let det = null;
      try { det = await generateNhsStatementDetailed(job.title, job.company, job.description, cvText, { minCoverage: 0.5, log: (m) => this.log(m) }); }
      catch (e) { this.log('Statement failed: ' + e.message); }
      if (!det || !det.essTotal) {
        const r = (job.retryCount || 0) + 1;
        await store.updateJob(job.jobId, r > 2 ? { status: 'skipped', reason: 'Could not read the person specification' } : { retryCount: r });
        continue;
      }
      if (det.essOk / det.essTotal < 0.5) {
        await store.updateJob(job.jobId, { status: 'skipped', cvScore: Math.round(det.essOk / det.essTotal * 100), reason: `Meets ${det.essOk} of ${det.essTotal} essential criteria` });
        continue;
      }
      await store.updateJob(job.jobId, { status: 'cv_ready', cvScore: Math.round(det.essOk / det.essTotal * 100), coverLetter: det.text, retryCount: 0 });
      this.log(`Ready to fill: ${job.title} (${det.essOk}/${det.essTotal} essential criteria evidenced).`);
      this.onChange();
    }
  }

  async record(job, { result, paused = [], status, draftUrl, aiQuestion }, aiBlocked = false) {
    if (result === 'applied') {
      await store.updateJob(job.jobId, { status: 'applied', appliedAt: new Date().toISOString(), reason: 'Submitted on Trac', ...(draftUrl ? { draftUrl } : {}) });
      this.log(`✓ Submitted: ${job.title}`);
    } else if (result === 'closed') {
      await store.updateJob(job.jobId, { status: 'skipped', reason: 'Vacancy closed before it was submitted' });
    } else if (result === 'dry_run') {
      const missing = [...new Set([...(status && status.notOk ? status.notOk : []), ...paused.map((p) => p.field)])].filter(Boolean);
      const complete = !!(status && status.total && !status.notOk.length && status.groupsOpen === 0);
      const note = complete ? 'Every section complete. Open it on Trac and press Submit.' : `Draft saved on Trac. Needs you: ${missing.slice(0, 6).join('; ') || 'check the draft'}.`;
      await store.updateJob(job.jobId, { status: complete ? 'ready_to_submit' : 'skipped', reason: note + ((aiQuestion || aiBlocked) ? AI_NOTE : ''), ...(draftUrl ? { draftUrl } : {}) });
      this.log(`${complete ? '✓ Ready to submit' : 'Needs you'}: ${job.title}`);
    } else if (result === 'needs_login') {
      await store.updateJob(job.jobId, { status: 'cv_ready' });
    } else {
      await store.updateJob(job.jobId, { status: 'apply_failed', reason: 'Could not complete the form' });
    }
    this.onChange();
  }

  // 3. Finish drafts already on Trac (reopen, fill what's missing).
  async resumeDrafts() {
    let drafts = [];
    try { ({ drafts } = await listTracApplications(this.page)); } catch (e) { this.log('Could not read your Trac applications: ' + e.message); return; }
    const all = await store.jobs();
    for (const d of drafts) {
      if (!this.running) return;
      const dk = key(d.title);
      const owner = dk.length < 8 ? null : all.filter((j) => j.source === SOURCE && key(j.title).length >= 8 && (key(j.title).startsWith(dk) || dk.startsWith(key(j.title))))
        .sort((a, b) => Math.min(key(b.title).length, dk.length) - Math.min(key(a.title).length, dk.length))[0];
      if (!owner) continue; // not one of ours
      if (/^Vacancy closed/.test(owner.reason || '')) continue;
      const aiBlocked = /asks about AI use/.test(owner.reason || '');
      if (owner.status === 'ready_to_submit' && (!(await this.autoSubmit()) || aiBlocked)) { if (!owner.draftUrl) await store.updateJob(owner.jobId, { draftUrl: d.url }); continue; }
      if (!['ready_to_submit', 'skipped', 'cv_ready'].includes(owner.status)) continue;
      this.log(`Finishing draft: ${d.title}`);
      const r = await fillApplication(this.page, { job: { ...owner, url: d.url }, resume: true, applicant: cfg.APPLICANT, details: cfg.TRAC_DETAILS, supportingStatement: owner.coverLetter || '', submit: await this.autoSubmit(), blockSubmit: aiBlocked, log: (m) => this.log(m) });
      await this.record(owner, { ...r, draftUrl: r.draftUrl || d.url }, aiBlocked);
      if (r.result === 'needs_login') return;
      await sleep(4000 + Math.random() * 3000);
    }
  }

  // 4. Fill new jobs that passed the check.
  async applyReady() {
    const s = await this.settings();
    for (const job of await store.byStatus('cv_ready', SOURCE)) {
      if (!this.running) return;
      if ((await store.appliedToday()) >= Number(s.dailyCap || 25)) { this.log('Daily limit reached.'); return; }
      this.log(`Filling: ${job.title} @ ${job.company}`);
      await store.updateJob(job.jobId, { status: 'applying' });
      const finished = (await store.byStatus('ready_to_submit', SOURCE)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((j) => j.title);
      const r = await fillApplication(this.page, { job, applicant: cfg.APPLICANT, details: cfg.TRAC_DETAILS, supportingStatement: job.coverLetter || '', submit: await this.autoSubmit(), preferCopyFrom: finished, log: (m) => this.log(m) });
      await this.record(job, r);
      await sleep(6000 + Math.random() * 5000);
    }
  }
}
