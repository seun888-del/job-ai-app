// Federal jobs agent (USA): finds jobs on USAJOBS through the Job-AI backend (official API),
// checks each one against the CV and writes a 2-page federal resume for it. It never applies:
// each job waits under "Federal jobs ready" and the user applies on USAJOBS with Login.gov.
// No browser window is needed, so it runs alongside the other agents without a tab.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';
import { SiteAgent } from './base.js';

const llm = require('../shims/llm.js');
const titleMatch = require('../../../bot/modules/title_match');
// Federal adverts' eligibility boilerplate is not a skill the CV can show: drop it before scoring.
const { cleanFederalJD, specializedExperience } = require('../../../bot/modules/federal_jd');
const SOURCE = 'usajobs';

const money = (n) => '$' + Number(n).toLocaleString('en-US');
export function federalPay(j) {
  if (!j.pay_min && !j.pay_max) return '';
  const range = j.pay_min && j.pay_max && j.pay_min !== j.pay_max ? `${money(j.pay_min)} to ${money(j.pay_max)}` : money(j.pay_min || j.pay_max);
  return `${range} ${String(j.pay_period || 'per year').toLowerCase()}`;
}

export async function federalQuestionnaire(previewUrl) {
  const id = (String(previewUrl || '').match(/ViewQuestionnaire\/(\d+)/i) || [])[1];
  if (!id) return { ok: false, error: 'no questionnaire link' };
  try {
    const r = await fetch(`${llm.BACKEND}/v1/federal/questionnaire/${id}`, { headers: llm.headers(), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.ok && j.text ? { ok: true, text: j.text, count: j.count || 0 } : { ok: false, error: 'could not load the questions' };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function federalJobs({ terms, location, remoteOnly }) {
  const q = new URLSearchParams({ terms: terms.slice(0, 10).join(','), location: location || '' });
  if (remoteOnly) q.set('remote', '1');
  const r = await fetch(`${llm.BACKEND}/v1/jobs/federal?${q}`, { headers: llm.headers(), signal: AbortSignal.timeout(60000) });
  if (r.status === 503) throw new Error('federal jobs are not available right now');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()).jobs || [];
}

export class UsajobsAgent extends SiteAgent {
  constructor({ onChange } = {}) {
    super({ source: SOURCE, label: 'Federal', onChange });
    this.lazyWindow = true; // API only: never opens a tab
    this.minWords = 60;
  }

  async search() {
    const fed = cfg.FEDERAL || {};
    if (!fed.usCitizen) { this.log('Answer the U.S. citizenship question in Setup, Federal jobs details.'); return; }
    const terms = (cfg.JOB_SEARCHES || []).map((t) => String(t).trim()).filter(Boolean);
    if (!terms.length) { this.log('Add job titles in Search Preferences to find federal jobs.'); return; }
    const remoteOnly = cfg.WORK_TYPE_PRIORITY.length === 1 && cfg.WORK_TYPE_PRIORITY[0] === 'remote';
    const jobs = await federalJobs({ terms, location: cfg.LOCATION, remoteOnly });
    const matchers = titleMatch.compile(terms);
    const fits = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
    this.log(`USAJOBS: ${jobs.length} open job(s) for your titles, ${fits.length} match them closely.`);
    for (const j of fits) {
      if (!this.running) return;
      if (await store.hasJob(j.id)) continue;
      const job = { jobId: j.id, title: j.title, company: j.company, url: j.apply_url, location: j.location, closes: j.closes, grade: j.grade, pay: federalPay(j), announcement: j.announcement, ...(j.questionnaire_url ? { questionnaireUrl: j.questionnaire_url } : {}), ...(/secret|ts\/sci|q clearance/i.test(j.clearance || '') ? { clearance: j.clearance } : {}) };
      if (fed.usCitizen === 'no' && j.citizenship_required) { await store.addJob({ ...job, source: SOURCE, status: 'skipped', reason: 'Needs U.S. citizenship' }); continue; }
      // Pay first, so the salary and "only move for more money" checks can read it.
      const description = (job.pay ? `Pay: ${job.pay}. ` : '') + (j.grade ? `Grade: ${j.grade}. ` : '') + cleanFederalJD(j.description);
      const spec = specializedExperience(j.description);
      await this.queueIfWanted(job, { description, ...(spec ? { scoreText: spec } : {}), workType: j.remote ? 'remote' : j.telework ? 'hybrid' : 'onsite' });
    }
  }

  // Nothing is sent. A job with its federal resume moves to "ready to submit" for the user,
  // and counts toward the daily limit (like a finished NHS draft) since the AI did the work.
  async applyReady() {
    for (const job of await store.byStatus('cv_ready', SOURCE)) {
      if (!this.running) return;
      if ((await store.capUsed()) >= cfg.MAX_APPLICATIONS_PER_DAY) { this.log('Daily limit reached.'); return; }
      const f = job.federal || {};
      const checks = [];
      if (f.fullText) checks.push('add hours per week to each job');
      if ((f.missingMonths || []).length) checks.push(`add the month to your dates for ${f.missingMonths.slice(0, 3).join(', ')}`);
      if (f.pages > 2) checks.push('cut it to 2 pages');
      const cl = job.clearance ? ` Needs a ${job.clearance} clearance, which the agency arranges after you are hired.` : '';
      await store.updateJob(job.jobId, { status: 'ready_to_submit', countedAt: job.countedAt || new Date().toISOString(), reason: (checks.length ? `Before you upload the resume: ${checks.join('; ')}.` : 'Federal resume ready. Apply on USAJOBS.') + cl });
      this.log(`✓ Ready for you to apply on USAJOBS: ${job.title}`);
      this.onChange();
    }
  }
}
