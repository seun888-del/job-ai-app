/**
 * Indeed Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search Indeed (uk.indeed.com or indeed.com) for remote jobs
 *            with the "Easily Apply" filter. Extracts JDs and adds matching
 *            jobs to queue.db (source: 'indeed') with status "pending".
 *            The Scorer bot then scores and tailors the CV.
 *
 * Phase 2 — Polls the queue every 10 s. When the Scorer bot marks an Indeed
 *            job as "cv_ready", submits the application via Indeed's
 *            SmartApply system with the tailored CV.
 *
 * Works for both UK (uk.indeed.com) and US (indeed.com) users based on
 * the country setting in the applicant's profile.
 */

const { chromium } = require('playwright');
const cfg    = require('./config');
const indeed = require('./modules/indeed');
const queue  = require('./modules/queue_manager');
const logger = require('./modules/logger');
const salary = require('./modules/salary_filter');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;
const MAX_IDLE      = 6;

function isRelevantTitle(title) {
  const t = title.toLowerCase();
  return !cfg.TITLE_BLOCKLIST.some(k => t.includes(k));
}

function detectWorkType(description) {
  const d = (description || '').toLowerCase();
  const isRemote = /\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bremote position\b|\bwork from home\b|\bwfh\b|\bremote working\b|\bremote role\b/.test(d);
  const isHybrid = /\bhybrid\b/.test(d);
  if (isRemote) return 'remote';
  if (isHybrid) return 'hybrid';
  return 'onsite';
}

function workTypePriority() {
  const map = {};
  cfg.WORK_TYPE_PRIORITY.forEach((type, i) => { map[type] = i; });
  return map;
}

async function phase1_searchAndQueue(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Indeed Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [Indeed Bot] Searching: "${searchTerm}"`);
    let jobs;
    try {
      jobs = await indeed.searchJobs(page, searchTerm, cfg.MAX_JOBS_PER_SEARCH);
    } catch (err) {
      console.error(`  [Indeed Bot] Search failed: ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      if (queue.has(job.jobId)) {
        console.log(`  [Indeed Bot] Already queued: ${job.title}`);
        continue;
      }
      if (queue.wasApplied(job.jobId)) {
        console.log(`  [Indeed Bot] Already applied previously — skipping: ${job.title}`);
        continue;
      }
      if (!isRelevantTitle(job.title)) {
        console.log(`  [Indeed Bot] Title filter — skipping: ${job.title}`);
        continue;
      }

      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [Indeed Bot] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      try {
        const jobDetails = await indeed.getJobDescription(page, job);

        if (!jobDetails.description || jobDetails.description.length < 50) {
          console.log(`  [Indeed Bot] Could not extract JD — skipping: ${job.title}`);
          queue.add({ ...job, source: 'indeed', status: 'skipped', reason: 'Could not extract JD' });
          continue;
        }

        if (!jobDetails.hasEasyApply) {
          console.log(`  [Indeed Bot] No Easy Apply button found — skipping: ${job.title}`);
          queue.add({ ...job, source: 'indeed', status: 'skipped', reason: 'External apply (not Indeed Apply)' });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship) {
          const offersSponsor = /visa sponsor|sponsorship|skilled worker visa|tier 2|work permit|sponsor.*visa/i.test(jobDetails.description);
          if (!offersSponsor) {
            console.log(`  [Indeed Bot] No sponsorship offered — skipping: ${job.title}`);
            queue.add({ ...job, source: 'indeed', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }

        const workType = detectWorkType(jobDetails.description);

        if (!salary.isAcceptable(jobDetails.description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(jobDetails.description);
          console.log(`  [Indeed Bot] Below salary expectation (£${min?.toLocaleString() || '?'} < ${cfg.APPLICANT.salaryExpectation}) — skipping: ${job.title}`);
          queue.add({ ...job, source: 'indeed', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        queue.add({ ...jobDetails, source: 'indeed', workType });
        console.log(`  [Indeed Bot] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
      } catch (err) {
        console.error(`  [Indeed Bot] Error on "${job.title}": ${err.message}`);
      }

      await DELAY(2500);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'indeed').length;
  console.log(`\n  [Indeed Bot] Phase 1 complete. ${pending} Indeed job(s) queued for Scorer.`);
}

async function phase2_applyReadyCVs(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Indeed Bot] Phase 2 — Waiting for Scorer bot...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('indeed');
  if (retried > 0) console.log(`  [Indeed Bot] Requeueing ${retried} previously-failed Indeed job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount  = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'indeed')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

    const pendingCount = [
      ...queue.getByStatus('pending').filter(j => j.source === 'indeed'),
      ...queue.getByStatus('processing').filter(j => j.source === 'indeed'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Indeed Bot] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing until tomorrow`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [Indeed Bot] Applying: ${job.title} @ ${job.company} [${job.workType || 'remote'}] (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        const applied = await indeed.applyToJob(page, job, job.cvPath);

        if (applied === null) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
          console.log(`  [Indeed Bot] Already applied — skipping: ${job.title}`);
          continue;
        }

        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(
          job.title, job.company, job.url, job.cvName, job.cvScore,
          applied ? 'APPLIED' : 'APPLY_FAILED',
          applied ? 'Indeed SmartApply' : 'Indeed form could not be completed'
        );
        console.log(`  [Indeed Bot] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      } catch (err) {
        queue.update(job.jobId, { status: 'apply_failed', error: err.message });
        logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
        console.error(`  [Indeed Bot] Error applying to "${job.title}": ${err.message}`);
      }

      // Human-like pause between applications: 10–18 seconds
      const pause = 10000 + Math.random() * 8000;
      console.log(`  [Indeed Bot] Pausing ${Math.round(pause / 1000)}s before next application...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingCount > 0) {
      idleCount = 0;
      queue.printStatus();
      console.log(`  [Indeed Bot] Waiting for Scorer bot... (${pendingCount} Indeed job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [Indeed Bot] Idle ${idleCount}/${MAX_IDLE} — no pending or ready Indeed jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const indeedEmail = process.env.INDEED_EMAIL;
  const indeedPass  = process.env.INDEED_PASS;

  if (!indeedEmail || !indeedPass) {
    console.error('ERROR: Set INDEED_EMAIL and INDEED_PASS env vars');
    process.exit(1);
  }

  const country = cfg.APPLICANT.country || 'United Kingdom';
  const domain  = country === 'United States' ? 'indeed.com' : 'uk.indeed.com';

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Indeed Bot — Starting (${domain}, continuous mode)`);
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs stuck in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'indeed');
  if (stuckApplying.length > 0) {
    console.log(`  [Indeed Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  let indeedPage;
  try {
    indeedPage = await indeed.login(browser, indeedEmail, indeedPass);
  } catch (err) {
    console.error('ERROR: ' + err.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }

  while (true) {
    await phase1_searchAndQueue(indeedPage);
    await phase2_applyReadyCVs(indeedPage);
    logger.printSummary();
    console.log('\n  [Indeed Bot] Cycle complete. Waiting 1 min before next search...');
    await DELAY(60 * 1000);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
