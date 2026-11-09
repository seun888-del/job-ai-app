/**
 * Job Bank Agent (Canada): applies by email from the user's own Gmail.
 * ──────────────────────────────────────────────────────────────────
 *  Phase 1: search Job Bank (jobbank.gc.ca, Government of Canada) for the user's job titles,
 *           only jobs the employer posted there, read each posting and queue it (source 'jobbank').
 *           The Scorer checks the CV, tailors it and writes the cover letter.
 *  Phase 2: for each tailored job, read the employer's application email ("Show how to apply")
 *           and send the application from the user's Gmail: the cover letter as the email, the
 *           tailored resume attached, the Job Bank number in the subject.
 *
 * No browser and no Job Bank account. Jobs that only take Direct Apply, mail or in person are
 * skipped. One email per employer address in 30 days, so an employer with several postings
 * isn't flooded.
 */
const path = require('path');
const cfg = require('./config');
const queue = require('./modules/queue_manager');
const logger = require('./modules/logger');
const salary = require('./modules/salary_filter');
const titleMatch = require('./modules/title_match');
const jb = require('./modules/jobbank');
const { sendMail } = require('./modules/gmail_send');
const { cleanJobBankJD } = require('./modules/jobbank_jd');

const SOURCE = 'jobbank';
// Test mode: JOBBOT_JOBBANK_TEST_TO=<your own address> sends every application THERE instead of
// to the employer (subject says which employer it would have gone to), at most 3 per run.
const TEST_TO = String(process.env.JOBBOT_JOBBANK_TEST_TO || '').trim();
let testSent = 0;
const tested = new Set(); // jobs already test-sent this run, so none is sent twice
const ROUND_MS = 30 * 60 * 1000;
const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  [Job Bank] ${m}`);

const canWorkInCanada = () => (cfg.APPLICANT.rightToWorkCountries || []).some((c) => /canad/i.test(c));
// The city to search around: their own town if they live in Canada, else all of Canada.
function searchPlace() {
  const loc = String(cfg.LOCATION || '').trim();
  return !loc || /^canada$/i.test(loc) ? '' : loc;
}

async function phase1() {
  const terms = (cfg.JOB_SEARCHES || []).map((t) => String(t).trim()).filter(Boolean);
  if (!terms.length) { log('Add job titles in Search Preferences to find jobs on Job Bank.'); return; }
  const matchers = titleMatch.compile(terms);
  const remoteOnly = cfg.WORK_TYPE_PRIORITY.length === 1 && cfg.WORK_TYPE_PRIORITY[0] === 'remote';
  const where = searchPlace();
  let queued = 0;
  for (const term of terms) {
    let jobs = [];
    try { jobs = await jb.search(term, { location: where }); } catch (e) { log(`Search failed for "${term}": ${e.message}`); continue; }
    const fits = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
    log(`"${term}"${where ? ` near ${where}` : ''}: ${jobs.length} job(s) posted on Job Bank, ${fits.length} match your title.`);
    for (const j of fits) {
      // A job scored before the cleaner existed (every tick box counted as a must-have) is
      // checked once more with the clean advert; anything else already seen is left alone.
      const prev = queue.read().find((x) => x.jobId === j.jobId);
      const recheck = prev && prev.status === 'skipped' && ((prev.extra && prev.extra.jdClean) || 0) < 2 && /must-haves|tailored resume only matches|% match/.test(prev.reason || '');
      if ((queue.has(j.jobId) && !recheck) || queue.wasApplied(j.jobId)) continue;
      if (cfg.TITLE_BLOCKLIST.some((k) => j.title.toLowerCase().includes(k))) continue;
      if (cfg.COMPANY_BLOCKLIST.some((b) => j.company.toLowerCase().includes(b))) continue;
      if (!recheck && queue.hasCanonical(j.title, j.company)) continue;
      const base = { jobId: j.jobId, title: j.title, company: j.company, url: j.url, source: SOURCE, extra: { location: j.location, pay: j.salary } };
      const skip = (reason) => queue.add({ ...base, status: 'skipped', reason });
      const p = await jb.fetchPosting(j.id);
      await DELAY(700);
      if (!p.ok || p.expired) continue;
      // "The employer accepts applications from: Canadian citizens and permanent or temporary residents..."
      if (p.who && !/other candidates/i.test(p.who) && !canWorkInCanada()) { skip('Only people who can already work in Canada'); continue; }
      if (remoteOnly && !/remote/i.test(p.description)) { skip('Work type (on site) not wanted'); continue; }
      // Only jobs that take email can be sent: check before spending AI on the resume.
      const how = await jb.howToApply(j.id).catch(() => ({ ok: false }));
      if (!how.ok) continue; // Job Bank didn't answer: try again next round
      const noEmail = jb.noEmailReason(how);
      if (noEmail) { if (prev) queue.update(j.jobId, { status: 'skipped', reason: noEmail, extra: { ...(prev.extra || {}), jdClean: 2 } }); else skip(noEmail); continue; }
      // The duties and real requirements, not every tick box (see jobbank_jd.js).
      const description = cleanJobBankJD(p.description, { title: j.title });
      if (description.split(/\s+/).length < 60) { skip('Job description too short'); continue; }
      if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) { skip('Below your salary expectation'); continue; }
      if (recheck) { queue.update(j.jobId, { status: 'pending', reason: '', description, extra: { ...(prev.extra || {}), jobBankId: j.id, number: p.number, jdClean: 2 } }); log(`Checking again: ${j.title} @ ${j.company}`); continue; }
      queue.add({ ...base, description, extra: { ...base.extra, jobBankId: j.id, number: p.number, jdClean: 2 } });
      queued++;
      log(`Found: ${j.title} @ ${j.company}`);
    }
  }
  log(`Search done: ${queued} new job(s) for the Scorer.`);
}

// Addresses already emailed in the last 30 days (one application per employer address).
function recentlyEmailed() {
  const since = Date.now() - 30 * 864e5;
  return new Set(queue.read().filter((j) => j.source === SOURCE && j.status === 'applied' && j.extra && j.extra.email && Date.parse(j.updatedAt || 0) >= since).map((j) => j.extra.email));
}

function emailText(job, letter) {
  const A = cfg.APPLICANT;
  const name = [A.firstName, A.lastName].filter(Boolean).join(' ');
  let body = String(letter || '').trim();
  if (!body) body = `I would like to apply for the ${job.title} position${job.company ? ` at ${job.company}` : ''} advertised on Job Bank. My resume is attached.\n\nThank you for your time.`;
  // An email reads as a letter: greeting first, then a sign-off with name and contact details.
  if (!/^\s*(dear|hello|hi)\b/i.test(body)) body = `Dear Hiring Manager,\n\n${body}`;
  body = body.replace(/\n+\s*(kind regards|best regards|regards|sincerely|yours sincerely|yours faithfully),?[\s\S]*$/i, '').trim();
  const contact = [A.phone, process.env.JOBBOT_GMAIL_USER].filter(Boolean).join('\n');
  return `${body}\n\nKind regards,\n${name}${contact ? `\n${contact}` : ''}\n\nMy resume is attached.`;
}

async function phase2(until) {
  if (!process.env.JOBBOT_GMAIL_REFRESH) { log('Connect Gmail on the Job Bank card so the agent can send applications from your email.'); await DELAY(Math.max(0, until - Date.now())); return; }
  while (Date.now() < until) {
    const ready = queue.getByStatus('cv_ready').filter((j) => j.source === SOURCE);
    const emailed = recentlyEmailed();
    for (const job of ready) {
      if (tested.has(job.jobId)) continue;
      if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) { log('Daily limit reached.'); await DELAY(Math.max(0, until - Date.now())); return; }
      const ex = job.extra || {};
      console.log(`\n  [Job Bank] ── ${job.title} @ ${job.company}`);
      const how = await jb.howToApply(ex.jobBankId || String(job.jobId).replace(/^jobbank_/, '')).catch(() => ({ ok: false }));
      if (!how.ok) { log('Could not read how to apply, trying again later.'); continue; }
      if (!how.email) { const why = jb.noEmailReason(how); queue.update(job.jobId, { status: 'skipped', reason: why }); log(`Skipped: ${job.title} (${why})`); continue; }
      if (emailed.has(how.email)) { queue.update(job.jobId, { status: 'skipped', reason: 'Already applied to this employer by email in the last 30 days' }); continue; }
      if (!job.cvPath) { queue.update(job.jobId, { status: 'skipped', reason: 'No tailored resume to attach' }); continue; }
      queue.update(job.jobId, { status: 'applying' });
      const A = cfg.APPLICANT;
      const name = [A.firstName, A.lastName].filter(Boolean).join(' ');
      const subject = `Application for ${job.title}${ex.number ? ` (Job Bank #${ex.number})` : ''}${how.reference ? ` - Ref ${how.reference}` : ''}${name ? ` - ${name}` : ''}`.replace(/ - /g, ', ');
      if (TEST_TO && testSent >= 3) { queue.update(job.jobId, { status: 'cv_ready' }); log('Test mode: 3 test emails sent, stopping here.'); await DELAY(Math.max(0, until - Date.now())); return; }
      try {
        await sendMail({ to: TEST_TO || how.email, fromName: name, subject: TEST_TO ? `[TEST, would go to ${how.email}] ${subject}` : subject, text: emailText(job, job.coverLetter),
          attachments: [{ path: job.cvPath, filename: `${name || 'Resume'} Resume.pdf`.replace(/[\\/:*?"<>|]/g, '') }] });
        if (TEST_TO) {
          testSent++; tested.add(job.jobId);
          // A test send isn't an application: put the job back as ready so a real run can still apply.
          queue.update(job.jobId, { status: 'cv_ready' });
          log(`✓ TEST sent to ${TEST_TO} (would go to the employer): ${job.title} @ ${job.company}`);
          await DELAY(5000);
          continue;
        }
        queue.update(job.jobId, { status: 'applied', reason: 'Emailed from your Gmail', extra: { ...ex, email: how.email } });
        queue.markApplied(job.jobId);
        emailed.add(how.email);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'Job Bank (email)');
        log(`✓ Sent from your Gmail: ${job.title} @ ${job.company}`);
      } catch (e) {
        queue.update(job.jobId, { status: e.gmailDisconnected ? 'cv_ready' : 'apply_failed', reason: e.message });
        log(`✗ ${e.message}`);
        if (e.gmailDisconnected) { await DELAY(Math.max(0, until - Date.now())); return; }
      }
      await DELAY(20000 + Math.random() * 20000); // space the emails out
    }
    await DELAY(15000);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Job Bank Agent (Canada) — Starting. Applies by email from ${process.env.JOBBOT_GMAIL_USER || 'your Gmail (not connected yet)'}.`);
  console.log('═══════════════════════════════════════════════════════');
  if ((cfg.APPLICANT || {}).country !== 'Canada') { log('Job Bank is for Canada. Switch Find jobs in to Canada to use this agent.'); process.exit(0); }
  for (const j of queue.getByStatus('applying').filter((x) => x.source === SOURCE)) queue.update(j.jobId, { status: 'cv_ready' });
  for (;;) {
    await cfg.init().catch(() => {});
    await phase1();
    await phase2(Date.now() + ROUND_MS);
  }
}

if (require.main === module) main().catch((e) => { console.error('  [Job Bank] Uncaught: ' + e.message); process.exit(1); });
module.exports = { emailText, searchPlace };
