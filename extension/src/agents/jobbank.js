// Job Bank agent (Canada): finds jobs the employer posted on Job Bank (jobbank.gc.ca, the
// Government of Canada board), and for each one that takes applications by email sends the
// tailored resume and cover letter from the user's own Gmail. No Job Bank account, no tab.
// Same rules as the app's bot/bot_jobbank.js.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { SiteAgent } from './base.js';
import { sendGmail, gmailStatus } from '../lib/gmail.js';

const jb = require('../../../bot/modules/jobbank');
const titleMatch = require('../../../bot/modules/title_match');
const { cleanJobBankJD } = require('../../../bot/modules/jobbank_jd');
const fs = require('fs');
const SOURCE = 'jobbank';
export const JOBBANK_ORIGINS = ['https://www.jobbank.gc.ca/*'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canWorkInCanada = () => (cfg.APPLICANT.rightToWorkCountries || []).some((c) => /canad/i.test(c));

export async function jobBankReady() {
  const perm = await chrome.permissions.contains({ origins: JOBBANK_ORIGINS }).catch(() => false);
  const g = await gmailStatus();
  return { perm, gmail: g.connected, email: g.email || '' };
}

export class JobBankAgent extends SiteAgent {
  constructor({ onChange } = {}) {
    super({ source: SOURCE, label: 'Job Bank', onChange });
    this.lazyWindow = true; // plain HTTP and the Gmail API: never opens a tab
    this.minWords = 60;
  }

  async signIn() {
    const r = await jobBankReady();
    if (!r.perm || !r.gmail) { this.log('Press Connect Gmail on the Job Bank card so it can send applications from your email.'); return false; }
    return true;
  }

  async search() {
    const terms = (cfg.JOB_SEARCHES || []).map((t) => String(t).trim()).filter(Boolean);
    if (!terms.length) { this.log('Add job titles in Search Preferences to find jobs on Job Bank.'); return; }
    const matchers = titleMatch.compile(terms);
    const loc = String(cfg.LOCATION || '').trim();
    const where = !loc || /^canada$/i.test(loc) ? '' : loc;
    for (const term of terms) {
      if (!this.running) return;
      let jobs = [];
      try { jobs = await jb.search(term, { location: where }); } catch (e) { this.log(`Search failed for "${term}": ${e.message}`); continue; }
      const fits = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
      this.log(`"${term}"${where ? ` near ${where}` : ''}: ${jobs.length} job(s) posted on Job Bank, ${fits.length} match your title.`);
      for (const j of fits) {
        if (!this.running) return;
        // A job scored before the cleaner existed (every tick box counted as a must-have) is
        // checked once more with the clean advert; anything else already seen is left alone.
        const prev = (await store.jobs()).find((x) => x.jobId === j.jobId);
        const recheck = prev && prev.status === 'skipped' && (prev.jdClean || 0) < 2 && /must-haves|tailored resume only matches|% match/.test(prev.reason || '');
        if (prev && !recheck) continue;
        const p = await jb.fetchPosting(j.id);
        await sleep(700);
        if (!p.ok || p.expired) continue;
        const job = { jobId: j.jobId, title: j.title, company: j.company, url: j.url, location: j.location, pay: j.salary, jobBankId: j.id, jobBankNumber: p.number };
        // "The employer accepts applications from: Canadian citizens and permanent or temporary residents..."
        if (p.who && !/other candidates/i.test(p.who) && !canWorkInCanada()) { await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: 'Only people who can already work in Canada' }); continue; }
        // Only jobs that take email can be sent: check before spending AI on the resume.
        const how = await jb.howToApply(j.id).catch(() => ({ ok: false }));
        if (!how.ok) continue; // Job Bank didn't answer: try again next round
        const noEmail = jb.noEmailReason(how);
        if (noEmail) { if (prev) await store.updateJob(j.jobId, { status: 'skipped', reason: noEmail, jdClean: 2 }); else await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: noEmail, jdClean: 2 }); continue; }
        // The duties and real requirements, not every tick box (see jobbank_jd.js).
        const description = cleanJobBankJD(p.description, { title: j.title });
        if (recheck) { await store.updateJob(j.jobId, { status: 'pending', reason: '', description, jdClean: 2 }); this.log(`Checking again: ${j.title} @ ${j.company}`); continue; }
        await this.queueIfWanted({ ...job, jdClean: 2 }, { description });
      }
    }
  }

  // Addresses already emailed in the last 30 days: one application per employer address.
  async recentlyEmailed() {
    const since = Date.now() - 30 * 864e5;
    return new Set((await store.jobs()).filter((j) => j.source === SOURCE && j.status === 'applied' && j.applyEmail && Date.parse(j.appliedAt || j.updatedAt || 0) >= since).map((j) => j.applyEmail));
  }

  emailText(job, from = '') {
    const A = cfg.APPLICANT;
    const name = [A.firstName, A.lastName].filter(Boolean).join(' ');
    let body = String(job.coverLetter || '').trim();
    if (!body) body = `I would like to apply for the ${job.title} position${job.company ? ` at ${job.company}` : ''} advertised on Job Bank.\n\nThank you for your time.`;
    // An email reads as a letter: greeting first, then a sign-off with name and contact details.
    if (!/^\s*(dear|hello|hi)\b/i.test(body)) body = `Dear Hiring Manager,\n\n${body}`;
    body = body.replace(/\n+\s*(kind regards|best regards|regards|sincerely|yours sincerely|yours faithfully),?[\s\S]*$/i, '').trim();
    const contact = [A.phone, from].filter(Boolean).join('\n');
    return `${body}\n\nKind regards,\n${name}${contact ? `\n${contact}` : ''}\n\nMy resume is attached.`;
  }

  async applyReady() {
    const emailed = await this.recentlyEmailed();
    for (const job of await store.byStatus('cv_ready', SOURCE)) {
      if (!this.running) return;
      if ((await store.capUsed()) >= cfg.MAX_APPLICATIONS_PER_DAY) { this.log('Daily limit reached.'); return; }
      const how = await jb.howToApply(job.jobBankId || String(job.jobId).replace(/^jobbank_/, '')).catch(() => ({ ok: false }));
      const skip = async (reason) => { await store.updateJob(job.jobId, { status: 'skipped', reason }); this.log(`Skipped: ${job.title} @ ${job.company} (${reason})`); this.onChange(); };
      if (!how.ok) { this.log(`Could not read how to apply for ${job.title}, trying again later.`); continue; }
      if (!how.email) { await skip(jb.noEmailReason(how)); continue; }
      if (emailed.has(how.email)) { await skip('Already applied to this employer by email in the last 30 days'); continue; }
      let bytes; try { bytes = fs.readFileSync(job.cvPath); } catch (_) { bytes = null; }
      if (!bytes || !bytes.length) { await skip('No tailored resume to attach'); continue; }
      const A = cfg.APPLICANT;
      const name = [A.firstName, A.lastName].filter(Boolean).join(' ');
      const subject = [`Application for ${job.title}${job.jobBankNumber ? ` (Job Bank #${job.jobBankNumber})` : ''}`, how.reference ? `Ref ${how.reference}` : '', name].filter(Boolean).join(', ');
      await store.updateJob(job.jobId, { status: 'applying' });
      this.log(`Emailing: ${job.title} @ ${job.company}`);
      try {
        await sendGmail({ to: how.email, fromName: name, subject, text: this.emailText(job, (await gmailStatus()).email),
          attachments: [{ filename: `${name || 'Resume'} Resume.pdf`.replace(/[\\/:*?"<>|]/g, ''), bytes, contentType: 'application/pdf' }] });
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
