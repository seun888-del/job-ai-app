/**
 * Dice Bot (dice.com, USA)
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search Dice for Easy Apply jobs, extract JDs and add matching
 *            jobs to queue.db (source: 'dice') with status "pending".
 *            The Scorer agent then scores and tailors the resume.
 *
 * Phase 2 — Polls the queue every 10 s. When the Scorer marks a Dice job
 *            "cv_ready", applies through Dice's Easy Apply wizard with the
 *            tailored resume.
 */

const cfg            = require('./config');
const dice         = require('./modules/dice');
const queue          = require('./modules/queue_manager');
const logger         = require('./modules/logger');
const salary         = require('./modules/salary_filter');
const sponsorship    = require('./modules/sponsorship');
const stealth        = require('./modules/stealth');
const { launchPersistentContext, humanWarmup } = require('./modules/browser_launcher');
const path           = require('path');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;
const MAX_IDLE      = 6;

function isRelevantTitle(title) {
  const t = title.toLowerCase();
  return !cfg.TITLE_BLOCKLIST.some(k => t.includes(k));
}

function isBlockedCompany(company) {
  const c = (company || '').toLowerCase();
  return cfg.COMPANY_BLOCKLIST.some(b => c.includes(b));
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
  console.log('  [Dice Agent] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [Dice Agent] Searching: "${searchTerm}"`);
    let jobs;
    try {
      jobs = await dice.searchJobs(page, searchTerm, cfg.MAX_JOBS_PER_SEARCH);
    } catch (err) {
      console.error(`  [Dice Agent] Search failed: ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      if (queue.has(job.jobId)) {
        console.log(`  [Dice Agent] Already queued: ${job.title}`);
        continue;
      }
      if (queue.wasApplied(job.jobId)) {
        console.log(`  [Dice Agent] Already applied previously — skipping: ${job.title}`);
        continue;
      }
      if (!isRelevantTitle(job.title)) {
        console.log(`  [Dice Agent] Title filter — skipping: ${job.title}`);
        continue;
      }

      if (isBlockedCompany(job.company)) {
        console.log(`  [Dice Agent] Company blocked — skipping: ${job.title} @ ${job.company}`);
        continue;
      }


      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [Dice Agent] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      try {
        const jobDetails = await dice.getJobDescription(page, job);

        if (!jobDetails.description || jobDetails.description.trim().split(/\s+/).length < 80) {
          console.log(`  [Dice Agent] Short/missing JD — skipping: ${job.title}`);
          queue.add({ ...job, source: 'dice', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }

        if (cfg.isTrainingCourseJD(jobDetails.description, job.title)) {
          console.log(`  [Dice Agent] Training course — skipping: ${job.title}`);
          queue.add({ ...job, source: 'dice', status: 'skipped', reason: 'Training course' });
          continue;
        }

        if (!jobDetails.hasEasyApply) {
          console.log(`  [Dice Agent] No Easy Apply button found — skipping: ${job.title}`);
          queue.add({ ...job, source: 'dice', status: 'skipped', reason: 'External apply (not Dice Apply)' });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(jobDetails.description))) {
          console.log(`  [Dice Agent] No sponsorship offered — skipping: ${job.title}`);
          queue.add({ ...job, source: 'dice', status: 'skipped', reason: 'No sponsorship offered' });
          continue;
        }

        const workType = detectWorkType(jobDetails.description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [Dice Agent] Work type "${workType}" not wanted — skipping: ${job.title}`);
          queue.add({ ...job, source: 'dice', status: 'skipped', reason: `Work type (${workType}) not wanted` });
          continue;
        }

        if (!salary.isAcceptable(jobDetails.description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(jobDetails.description);
          console.log(`  [Dice Agent] Below salary expectation ($${min?.toLocaleString() || '?'} < ${cfg.APPLICANT.salaryExpectation}) — skipping: ${job.title}`);
          queue.add({ ...job, source: 'dice', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        queue.add({ ...jobDetails, source: 'dice', workType });
        console.log(`  [Dice Agent] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
      } catch (err) {
        // Sign-in / Terms prompts that timed out, or a closed window: stop, don't repeat per job.
        if (/^Dice: |closed/i.test(err.message || '')) throw err;
        console.error(`  [Dice Agent] Error on "${job.title}": ${err.message}`);
      }

      await DELAY(2500);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'dice').length;
  console.log(`\n  [Dice Agent] Phase 1 complete. ${pending} Dice job(s) queued for Scorer.`);
}

async function phase2_applyReadyCVs(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Dice Agent] Phase 2 — Waiting for Scorer agent...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('dice');
  if (retried > 0) console.log(`  [Dice Agent] Requeueing ${retried} previously-failed Dice job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount  = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'dice')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

    const pendingCount = [
      ...queue.getByStatus('pending').filter(j => j.source === 'dice'),
      ...queue.getByStatus('processing').filter(j => j.source === 'dice'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Dice Agent] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing until tomorrow`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [Dice Agent] Applying: ${job.title} @ ${job.company} [${job.workType || 'remote'}] (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        const applied = await dice.applyToJob(page, job, job.cvPath);

        if (applied === null) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
          console.log(`  [Dice Agent] Already applied — skipping: ${job.title}`);
          continue;
        }

        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(
          job.title, job.company, job.url, job.cvName, job.cvScore,
          applied ? 'APPLIED' : 'APPLY_FAILED',
          applied ? 'Dice Easy Apply' : 'Dice form could not be completed'
        );
        console.log(`  [Dice Agent] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      } catch (err) {
        const isPageIssue = /apply button not found|no apply button|external/i.test(err.message);
        if (isPageIssue) {
          queue.update(job.jobId, { status: 'skipped', reason: err.message });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', err.message.substring(0, 100));
          console.log(`  [Dice Agent] Page issue — skipping: ${job.title} (${err.message})`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', error: err.message });
          logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
          console.error(`  [Dice Agent] Error applying to "${job.title}": ${err.message}`);
        }
      }

      // Human-like pause between applications: 10–18 seconds
      const pause = 10000 + Math.random() * 8000;
      console.log(`  [Dice Agent] Pausing ${Math.round(pause / 1000)}s before next application...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingCount > 0) {
      idleCount = 0;
      try { queue.printStatus(); } catch (_) {}
      console.log(`  [Dice Agent] Waiting for Scorer agent... (${pendingCount} Dice job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [Dice Agent] Idle ${idleCount}/${MAX_IDLE} — no pending or ready Dice jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  // Scorer holds Dice jobs until the sign-in is confirmed below.
  queue.markSessionChecking('dice');

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Dice Agent — Starting (dice.com, continuous mode)`);
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs stuck in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'dice');
  if (stuckApplying.length > 0) {
    console.log(`  [Dice Agent] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  // Stealth Chrome with the agent's own saved profile (same as Indeed).
  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'dice_profile');
  const context = await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const dicePage = await context.newPage();
  // A crashed tab never answers, so the agent would wait forever. Close it: the pending step then
  // fails with "closed" and the agent stops with a clear message instead of hanging.
  dicePage.on('crash', () => {
    console.error('  [Dice Agent] The Dice page crashed (often low memory). Stopping, press Start to try again.');
    dicePage.close().catch(() => {});
  });

  try {
    try {
      await dice.ensureLoggedIn(dicePage);
    } catch (err) {
      queue.markSessionDead('dice'); // sign-in failed → Scorer stops tailoring Dice jobs
      throw err;
    }
    queue.markSessionHealthy('dice');
    while (true) {
      await phase1_searchAndQueue(dicePage);
      await phase2_applyReadyCVs(dicePage);
      logger.printSummary();
      console.log('\n  [Dice Agent] Cycle complete. Waiting 1 min before next search...');
      await DELAY(60 * 1000);
    }
  } catch (err) {
    console.error('ERROR: ' + err.message);
    process.exit(1);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
