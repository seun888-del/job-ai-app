// Recruiter agent (UK): finds jobs on the UK government's job site (jobs.service.gov.uk, Work Hub,
// which replaced Find a Job). For each one that takes applications by email (the recruiter's
// application inbox), it sends the tailored CV and cover letter from the user's own Gmail.
// No account, no tab. Same rules as the app's bot/bot_workhub.js.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { SiteAgent } from './base.js';
import { sendGmail, gmailStatus } from '../lib/gmail.js';

const wh = require('../../../bot/modules/workhub');
const titleMatch = require('../../../bot/modules/title_match');
const fs = require('fs');
const SOURCE = 'workhub';
export const WORKHUB_ORIGINS = ['https://www.jobs.service.gov.uk/*'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function workHubReady() {
  const perm = await chrome.permissions.contains({ origins: WORKHUB_ORIGINS }).catch(() => false);
  const g = await gmailStatus();
  return { perm, gmail: g.connected, email: g.email || '' };
}

export class WorkHubAgent extends SiteAgent {
  constructor({ onChange } = {}) {
    super({ source: SOURCE, label: 'Recruiter', onChange });
    this.lazyWindow = true; // plain HTTP and the Gmail API: never opens a tab
    this.minWords = 60;
  }

  async signIn() {
    const r = await workHubReady();
    if (!r.perm || !r.gmail) { this.log('Press Connect Gmail on the Recruiter Agent card so it can send applications from your email.'); return false; }
    return true;
  }

  async search() {
    const terms = (cfg.JOB_SEARCHES || []).map((t) => String(t).trim()).filter(Boolean);
    if (!terms.length) { this.log('Add job titles in Search Preferences to find jobs.'); return; }
    const matchers = titleMatch.compile(terms);
    const loc = String(cfg.LOCATION || '').trim();
    const where = !loc || /^(uk|united kingdom|england|great britain)$/i.test(loc) ? '' : loc.split(',')[0].trim();
    const all = await store.jobs();
    // The same job already found on another site (company site, Reed...) is never sent twice.
    const seen = new Set(all.map((x) => `${same(x.title)}|${same(x.company)}`));
    let queued = 0, emailable = 0;
    for (const term of terms) {
      if (!this.running) return;
      let jobs = [];
      try { jobs = await wh.search(term, { location: where }); } catch (e) { this.log(`Search failed for "${term}": ${e.message}`); continue; }
      const fits = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
      this.log(`"${term}"${where ? ` near ${where}` : ''}: ${jobs.length} job(s) on the UK government job site, ${fits.length} match your title.`);
      for (const j of fits) {
        if (!this.running) return;
        if (all.some((x) => x.jobId === j.jobId) || seen.has(`${same(j.title)}|${same(j.company)}`)) continue;
        seen.add(`${same(j.title)}|${same(j.company)}`);
        const job = { jobId: j.jobId, title: j.title, company: j.company, url: j.url, location: j.location, pay: j.salary, workHubId: j.id };
        // Only jobs that take email can be sent: check before spending AI on the CV.
        const how = await wh.howToApply(j.id).catch(() => ({ ok: false }));
        await sleep(500);
        if (!how.ok) continue; // the site didn't answer: try again next round
        const noEmail = wh.noEmailReason(how);
        if (noEmail) { await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: noEmail }); continue; }
        emailable++;
        const p = await wh.fetchPosting(j.id);
        await sleep(500);
        if (!p.ok) { this.log(`Could not read the advert for ${j.title}, trying again next round.`); continue; }
        if (p.expired) { await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: 'Job has closed' }); this.log(`Skipped: ${j.title} @ ${j.company} (job has closed)`); continue; }
        const before = (await store.byStatus('pending', SOURCE)).length;
        await this.queueIfWanted(job, { description: `${j.salary ? `Pay: ${j.salary}. ` : ''}${p.description}` });
        if ((await store.byStatus('pending', SOURCE)).length > before) queued++;
      }
    }
    this.log(`Search done: ${emailable} new job(s) take applications by email, ${queued} sent for CV matching.`);
  }

  // Addresses already emailed in the last 30 days: one application per inbox.
  async recentlyEmailed() {
    const since = Date.now() - 30 * 864e5;
    return new Set((await store.jobs()).filter((j) => j.applyEmail && j.status === 'applied' && Date.parse(j.appliedAt || j.updatedAt || 0) >= since).map((j) => j.applyEmail));
  }

  emailText(job, from = '') {
    const A = cfg.APPLICANT;
    const name = [A.firstName, A.lastName].filter(Boolean).join(' ');
    let body = String(job.coverLetter || '').trim();
    if (!body) body = `I would like to apply for the ${job.title} role${job.company ? ` with ${job.company}` : ''} advertised on Find a Job.\n\nThank you for your time.`;
    // An email reads as a letter: greeting first, then a sign-off with name and contact details.
    if (!/^\s*(dear|hello|hi)\b/i.test(body)) body = `Dear Hiring Manager,\n\n${body}`;
    body = body.replace(/\n+\s*(kind regards|best regards|regards|sincerely|yours sincerely|yours faithfully),?[\s\S]*$/i, '').trim();
    const contact = [A.phone, from].filter(Boolean).join('\n');
    return `${body}\n\nKind regards,\n${name}${contact ? `\n${contact}` : ''}\n\nMy CV is attached.`;
  }

  async applyReady() {
    const emailed = await this.recentlyEmailed();
    for (const job of await store.byStatus('cv_ready', SOURCE)) {
      if (!this.running) return;
      if ((await store.capUsed()) >= cfg.MAX_APPLICATIONS_PER_DAY) { this.log('Daily limit reached.'); return; }
      const skip = async (reason) => { await store.updateJob(job.jobId, { status: 'skipped', reason }); this.log(`Skipped: ${job.title} @ ${job.company} (${reason})`); this.onChange(); };
      const how = await wh.howToApply(job.workHubId || String(job.jobId).replace(/^workhub_/, '')).catch(() => ({ ok: false }));
      if (!how.ok) { this.log(`Could not read how to apply for ${job.title}, trying again later.`); continue; }
      if (!how.email) { await skip(wh.noEmailReason(how)); continue; }
      if (emailed.has(how.email)) { await skip('Already applied to this recruiter by email in the last 30 days'); continue; }
      let bytes; try { bytes = fs.readFileSync(job.cvPath); } catch (_) { bytes = null; }
      if (!bytes || !bytes.length) { await skip('No tailored CV to attach'); continue; }
      const A = cfg.APPLICANT;
      const name = [A.firstName, A.lastName].filter(Boolean).join(' ');
      const subject = [`Application for ${job.title}`, name].filter(Boolean).join(', ');
      await store.updateJob(job.jobId, { status: 'applying' });
      this.log(`Emailing: ${job.title} @ ${job.company}`);
      try {
        await sendGmail({ to: how.email, fromName: name, subject, text: this.emailText(job, (await gmailStatus()).email),
          attachments: [{ filename: `${name || 'My'} CV.pdf`.replace(/[\\/:*?"<>|]/g, ''), bytes, contentType: 'application/pdf' }] });
        await store.updateJob(job.jobId, { applyEmail: how.email, reason: 'Emailed from your Gmail' });
        emailed.add(how.email);
        await this.record(job, true);
      } catch (e) {
        await this.record(job, { error: e.message });
        if (/reconnect|Connect Gmail/i.test(e.message)) { this.log(e.message); return; }
      }
      await sleep(8000 + Math.random() * 7000);
    }
  }
}
