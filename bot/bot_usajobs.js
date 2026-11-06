/**
 * Federal Jobs Agent (USAJOBS), USA only.
 * ─────────────────────────────────────────
 *  Phase 1: find federal jobs open to the public for the user's job titles, through the
 *           Job-AI backend (official USAJOBS API, key kept on the server), filter them and
 *           queue them with source 'usajobs'. The Scorer checks the CV and writes a
 *           2-page federal resume (bot/modules/federal_resume.js).
 *  Phase 2: each job with its resume moves to "ready_to_submit" and shows under
 *           "Federal jobs ready" in the app. The user applies on USAJOBS with Login.gov.
 *
 * NEVER APPLIES OR SUBMITS. USAJOBS's API terms don't allow saying an application was
 * made for the user, so this agent only prepares. No browser is opened.
 */
const cfg        = require('./config');
const queue      = require('./modules/queue_manager');
const salary     = require('./modules/salary_filter');
const jobFeed    = require('./modules/job_feed');
const titleMatch = require('./modules/title_match');
const { cleanFederalJD, specializedExperience } = require('./modules/federal_jd');

const SOURCE   = 'usajobs';
const ROUND_MS = 30 * 60 * 1000;
const DELAY    = (ms) => new Promise((r) => setTimeout(r, ms));
const log      = (m) => console.log(`  [Federal] ${m}`);

const money = (n) => '$' + Number(n).toLocaleString('en-US');
function payText(j) {
  if (!j.pay_min && !j.pay_max) return '';
  const range = j.pay_min && j.pay_max && j.pay_min !== j.pay_max ? `${money(j.pay_min)} to ${money(j.pay_max)}` : money(j.pay_min || j.pay_max);
  return `${range} ${String(j.pay_period || 'per year').toLowerCase()}`;
}

async function phase1() {
  const fed = cfg.FEDERAL || {};
  if (!fed.wants) { log('Federal jobs are off. Turn them on in Setup, Federal jobs details.'); return; }
  if (!fed.usCitizen) { log('Answer the U.S. citizenship question in Setup, Federal jobs details.'); return; }
  const terms = (cfg.JOB_SEARCHES || []).map((t) => String(t).trim()).filter(Boolean);
  if (!terms.length) { log('Add job titles in Search Preferences to find federal jobs.'); return; }
  const remoteOnly = cfg.WORK_TYPE_PRIORITY.length === 1 && cfg.WORK_TYPE_PRIORITY[0] === 'remote';
  let jobs = [];
  try { jobs = await jobFeed.fetchFederalJobs({ terms, location: cfg.LOCATION, remoteOnly }); }
  catch (e) { log(`Could not search USAJOBS (${e.message}).`); return; }
  const matchers = titleMatch.compile(terms);
  const fits = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
  log(`USAJOBS: ${jobs.length} open job(s) for your titles, ${fits.length} match them closely.`);

  let queued = 0;
  for (const j of fits) {
    if (queue.has(j.id) || queue.wasApplied(j.id)) continue;
    const pay = payText(j);
    const base = {
      jobId: j.id, title: j.title, company: j.company, url: j.apply_url, source: SOURCE,
      extra: { location: j.location, grade: j.grade, pay, closes: j.closes, announcement: j.announcement, ...(j.questionnaire_url ? { questionnaireUrl: j.questionnaire_url } : {}), ...(/secret|ts\/sci|q clearance/i.test(j.clearance || '') ? { clearance: j.clearance } : {}) },
    };
    const skip = (reason) => queue.add({ ...base, status: 'skipped', reason });
    const t = (j.title || '').toLowerCase();
    if (cfg.TITLE_BLOCKLIST.some((k) => t.includes(k))) continue;
    if (cfg.COMPANY_BLOCKLIST.some((b) => (j.company || '').toLowerCase().includes(b))) continue;
    if (fed.usCitizen === 'no' && j.citizenship_required) { skip('Needs U.S. citizenship'); continue; }
    // Pay first, so the salary and "only move for more money" checks can read it.
    const description = (pay ? `Pay: ${pay}. ` : '') + (j.grade ? `Grade: ${j.grade}. ` : '') + cleanFederalJD(j.description);
    if (description.split(/\s+/).length < 60) { skip('Job description too short or missing'); continue; }
    const workType = j.remote ? 'remote' : j.telework ? 'hybrid' : 'onsite';
    if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) { skip(`Work type (${workType}) not wanted`); continue; }
    if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) { skip('Below your salary expectation'); continue; }
    const spec = specializedExperience(j.description);
    queue.add({ ...base, description, workType, extra: { ...base.extra, ...(spec ? { scoreText: spec } : {}) } });
    queued++;
    log(`Found: ${j.title} @ ${j.company}`);
  }
  log(`Search done: ${queued} new federal job(s) for the Scorer.`);
}

// Jobs with their federal resume move to the "ready" list. They count toward the daily
// limit (like a finished NHS draft), since the AI did the work.
function phase2() {
  for (const job of queue.getByStatus('cv_ready').filter((j) => j.source === SOURCE)) {
    if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) { log('Daily limit reached.'); return; }
    const f = (job.extra && job.extra.federal) || {};
    const checks = [];
    if (f.fullText) checks.push('add hours per week to each job');
    if ((f.missingMonths || []).length) checks.push(`add the month to your dates for ${f.missingMonths.slice(0, 3).join(', ')}`);
    if (f.pages > 2) checks.push('cut it to 2 pages');
    const cl = job.extra && job.extra.clearance ? ` Needs a ${job.extra.clearance} clearance, which the agency arranges after you are hired.` : '';
    queue.update(job.jobId, { status: 'ready_to_submit', reason: (checks.length ? `Before you upload the resume: ${checks.join('; ')}.` : 'Federal resume ready. Apply on USAJOBS.') + cl });
    queue.markCapCounted(job.jobId);
    log(`✓ Ready for you to apply on USAJOBS: ${job.title}`);
  }
}

// Closed announcements leave the ready list.
function dropClosed() {
  const today = new Date().toISOString().slice(0, 10);
  for (const st of ['pending', 'cv_ready', 'ready_to_submit']) {
    for (const j of queue.getByStatus(st).filter((x) => x.source === SOURCE && x.extra && x.extra.closes && x.extra.closes < today)) {
      queue.update(j.jobId, { status: 'skipped', reason: 'Closed before you applied' });
    }
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Federal Jobs Agent (USAJOBS) — Starting. It prepares resumes; you apply on USAJOBS.');
  console.log('═══════════════════════════════════════════════════════');
  if ((cfg.APPLICANT || {}).country !== 'United States') { log('Federal jobs are for the USA. Switch Find jobs in to USA to use this agent.'); process.exit(0); }
  while (true) {
    dropClosed();
    await phase1();
    // Give the Scorer time to write the resumes, moving each one as it is ready.
    const roundEnd = Date.now() + ROUND_MS;
    while (Date.now() < roundEnd) { phase2(); await DELAY(30000); }
  }
}

main().catch((err) => { console.error('  [Federal] Uncaught: ' + err.message); process.exit(1); });
