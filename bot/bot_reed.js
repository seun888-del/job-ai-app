/**
 * Reed Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search Reed.co.uk for jobs matching the configured search terms,
 *            extract JDs, add each job to queue.db (source: 'reed') with
 *            status "pending". The Scorer bot then scores and tailors the CV.
 *
 * Phase 2 — Poll the queue every 10 s. When the Scorer bot sets a Reed job
 *            to "cv_ready", pick up the CV path and submit the Reed application.
 */

const { chromium } = require('playwright');
const cfg    = require('./config');
const reed   = require('./modules/reed');
const queue  = require('./modules/queue_manager');
const logger = require('./modules/logger');
const salary = require('./modules/salary_filter');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;   // 10 s between queue polls
const MAX_IDLE      = 6;       // give up after ~60 s of no pending/ready jobs

// ── Job title pre-filter — driven by the user's exclude-keyword list ───────
function isRelevantTitle(title) {
  const t = title.toLowerCase();
  return !cfg.TITLE_BLOCKLIST.some(k => t.includes(k));
}

// Detect work type from job description text
// Returns 'remote', 'hybrid', or 'onsite'
function detectWorkType(description) {
  const d = (description || '').toLowerCase();
  const isRemote = /\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bremote position\b|\bwork from home\b|\bwfh\b|\bremote working\b|\bremote role\b|\bremote job\b/.test(d);
  const isHybrid = /\bhybrid\b/.test(d);
  if (isRemote) return 'remote';
  if (isHybrid) return 'hybrid';
  return 'onsite';
}

// Priority order for applying — derived from the user's Work Type Priority
// setting, e.g. ['remote','hybrid','onsite'] → { remote: 0, hybrid: 1, onsite: 2 }
function workTypePriority() {
  const map = {};
  cfg.WORK_TYPE_PRIORITY.forEach((type, i) => { map[type] = i; });
  return map;
}

async function phase1_searchAndQueue(browser, reedPage) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Reed Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  const searchRounds = cfg.JOB_SEARCHES.map(t => ({ term: t }));

  for (const { term: searchTerm } of searchRounds) {
    console.log(`\n  [Reed Bot] Searching: "${searchTerm}"`);
    let jobs;
    try {
      const result = await reed.searchJobs(browser, reedPage, searchTerm, cfg.MAX_JOBS_PER_SEARCH, false);
      jobs     = result.jobs;
      reedPage = result.page;  // may have been recreated after page close
    } catch (err) {
      console.error(`  [Reed Bot] Search failed: ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      if (queue.has(job.jobId)) {
        console.log(`  [Reed Bot] Already queued: ${job.title}`);
        continue;
      }

      if (queue.wasApplied(job.jobId)) {
        console.log(`  [Reed Bot] Already applied previously — skipping: ${job.title}`);
        continue;
      }

      if (!isRelevantTitle(job.title)) {
        console.log(`  [Reed Bot] Title filter — skipping: ${job.title}`);
        continue;
      }

      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [Reed Bot] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      if (/with verification/i.test(job.title)) {
        console.log(`  [Reed Bot] Requires identity verification — skipping: ${job.title}`);
        queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Requires identity verification' });
        continue;
      }

      try {
        const jobDetails = await reed.getJobDescription(reedPage, job);

        if (!jobDetails.description || jobDetails.description.length < 50) {
          console.log(`  [Reed Bot] Could not extract JD — skipping: ${job.title}`);
          queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Could not extract JD' });
          continue;
        }

        if (jobDetails.isTrainingCourse) {
          console.log(`  [Reed Bot] Training course — skipping: ${job.title}`);
          queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Training course' });
          continue;
        }

        if (!jobDetails.hasEasyApply) {
          console.log(`  [Reed Bot] No Apply button found — skipping: ${job.title}`);
          queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'No apply button' });
          continue;
        }

        const workType = detectWorkType(jobDetails.description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [Reed Bot] Work type "${workType}" not wanted — skipping: ${job.title}`);
          queue.add({ ...job, source: 'reed', status: 'skipped', reason: `Work type (${workType}) not wanted` });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship) {
          const offersSponsor = /visa sponsor|sponsorship|skilled worker visa|tier 2|work permit|sponsor.*visa/i.test(jobDetails.description);
          if (!offersSponsor) {
            console.log(`  [Reed Bot] No sponsorship offered — skipping: ${job.title}`);
            queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }

        if (!salary.isAcceptable(jobDetails.description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(jobDetails.description);
          console.log(`  [Reed Bot] Below salary expectation (${min ? '£' + min.toLocaleString() : 'stated'} < ${cfg.APPLICANT.salaryExpectation}) — skipping: ${job.title}`);
          queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        queue.add({ ...jobDetails, source: 'reed', workType });
        console.log(`  [Reed Bot] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
      } catch (err) {
        console.error(`  [Reed Bot] Error on "${job.title}": ${err.message}`);
      }

      await DELAY(2000);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'reed').length;
  console.log(`\n  [Reed Bot] Phase 1 complete. ${pending} Reed job(s) queued for Scorer.`);
  return reedPage;
}

async function phase2_applyReadyCVs(reedPage) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Reed Bot] Phase 2 — Waiting for Scorer bot...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('reed');
  if (retried > 0) console.log(`  [Reed Bot] Requeueing ${retried} previously-failed Reed job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount = 0;

  while (true) {
    // Only handle Reed jobs — other source bots handle their own jobs
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'reed')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));
    const pendingJobs = [
      ...queue.getByStatus('pending').filter(j => j.source === 'reed'),
      ...queue.getByStatus('processing').filter(j => j.source === 'reed'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Reed Bot] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing applications until tomorrow`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        console.log(`  [Reed Bot] Post-queue title filter — skipping: ${job.title}`);
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [Reed Bot] Applying: ${job.title} @ ${job.company} [${job.workType || 'onsite'}] (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        const applied = await reed.applyToJob(reedPage, job, job.cvPath);

        if (applied === null) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
          console.log(`  [Reed Bot] Already applied — skipping: ${job.title}`);
          continue;
        }

        if (applied === 'external') {
          queue.update(job.jobId, { status: 'skipped', reason: 'External application site' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'External application site');
          console.log(`  [Reed Bot] External site — skipping: ${job.title}`);
          continue;
        }

        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(
          job.title, job.company, job.url, job.cvName, job.cvScore,
          applied ? 'APPLIED' : 'APPLY_FAILED',
          applied ? 'Reed' : 'Reed form could not be completed'
        );
        console.log(`  [Reed Bot] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      } catch (err) {
        const isPageIssue = /apply button not found|no apply button|external/i.test(err.message);
        if (isPageIssue) {
          queue.update(job.jobId, { status: 'skipped', reason: err.message });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', err.message.substring(0, 100));
          console.log(`  [Reed Bot] Page issue — skipping: ${job.title} (${err.message})`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', error: err.message });
          logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
          console.error(`  [Reed Bot] Error applying to "${job.title}": ${err.message}`);
        }
      }

      const pause = 8000 + Math.random() * 7000;
      console.log(`  [Reed Bot] Pausing ${Math.round(pause / 1000)}s before next application...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingJobs > 0) {
      idleCount = 0;
      queue.printStatus();
      console.log(`  [Reed Bot] Waiting for Scorer bot... (${pendingJobs} Reed job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [Reed Bot] Idle ${idleCount}/${MAX_IDLE} — no pending or ready Reed jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const reedEmail = process.env.REED_EMAIL;
  const reedPass  = process.env.REED_PASS;

  if (!reedEmail || !reedPass) {
    console.error('ERROR: Set REED_EMAIL and REED_PASS env vars');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Reed Bot — Starting (continuous mode)');
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'reed');
  if (stuckApplying.length > 0) {
    console.log(`  [Reed Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  const browser  = await chromium.launch({ headless: false, slowMo: 60 });
  let reedPage;
  try {
    reedPage = await reed.login(browser, reedEmail, reedPass);
  } catch (err) {
    console.error('ERROR: ' + err.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }

  while (true) {
    reedPage = await phase1_searchAndQueue(browser, reedPage);
    await phase2_applyReadyCVs(reedPage);
    logger.printSummary();
    console.log('\n  [Reed Bot] Cycle complete. Waiting 1 min before next search...');
    await DELAY(60 * 1000);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
