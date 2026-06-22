/**
 * LinkedIn Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search LinkedIn for remote/hybrid Easy Apply jobs matching the
 *            configured search terms, extract JDs, add each job to queue.db
 *            (source: 'linkedin') with status "pending".
 *            The Scorer bot then scores and tailors the CV.
 *
 * Phase 2 — Poll the queue every 10 s. When the Scorer bot sets a LinkedIn
 *            job to "cv_ready", pick up the CV path and submit via Easy Apply.
 */

const { chromium } = require('playwright');
const cfg      = require('./config');
const linkedin = require('./modules/linkedin');
const queue    = require('./modules/queue_manager');
const logger   = require('./modules/logger');
const salary   = require('./modules/salary_filter');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;
const MAX_IDLE      = 6;

function isRelevantTitle(title) {
  const t = title.toLowerCase();
  return !cfg.TITLE_BLOCKLIST.some(k => t.includes(k));
}

function detectWorkType(description) {
  const d = (description || '').toLowerCase();
  const isRemote = /\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bremote position\b|\bwork from home\b|\bwfh\b|\bremote working\b|\bremote role\b|\bremote job\b/.test(d);
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

async function phase1_searchAndQueue(liPage) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [LinkedIn Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [LinkedIn Bot] Searching: "${searchTerm}"`);
    let jobs;
    try {
      jobs = await linkedin.searchJobs(liPage, searchTerm, cfg.MAX_JOBS_PER_SEARCH);
    } catch (err) {
      console.error(`  [LinkedIn Bot] Search failed: ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      if (queue.has(job.jobId)) {
        console.log(`  [LinkedIn Bot] Already queued: ${job.title}`);
        continue;
      }
      if (queue.wasApplied(job.jobId)) {
        console.log(`  [LinkedIn Bot] Already applied previously — skipping: ${job.title}`);
        continue;
      }
      if (!isRelevantTitle(job.title)) {
        console.log(`  [LinkedIn Bot] Title filter — skipping: ${job.title}`);
        continue;
      }

      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [LinkedIn Bot] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      try {
        const jobDetails = await linkedin.getJobDescription(liPage, job);

        if (!jobDetails.description || jobDetails.description.length < 50) {
          console.log(`  [LinkedIn Bot] Could not extract JD — skipping: ${job.title}`);
          queue.add({ ...job, source: 'linkedin', status: 'skipped', reason: 'Could not extract JD' });
          continue;
        }

        if (!jobDetails.hasEasyApply) {
          console.log(`  [LinkedIn Bot] No Easy Apply button found — skipping: ${job.title}`);
          queue.add({ ...job, source: 'linkedin', status: 'skipped', reason: 'No Easy Apply button' });
          continue;
        }

        // LinkedIn URL already filters f_WT=2,3 (Remote+Hybrid) — no need to re-filter
        const workType = detectWorkType(jobDetails.description);

        if (cfg.APPLICANT.seekSponsorship) {
          const offersSponsor = /visa sponsor|sponsorship|skilled worker visa|tier 2|work permit|sponsor.*visa/i.test(jobDetails.description);
          if (!offersSponsor) {
            console.log(`  [LinkedIn Bot] No sponsorship offered — skipping: ${job.title}`);
            queue.add({ ...job, source: 'linkedin', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }

        if (!salary.isAcceptable(jobDetails.description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(jobDetails.description);
          console.log(`  [LinkedIn Bot] Below salary expectation (£${min?.toLocaleString() || '?'} < ${cfg.APPLICANT.salaryExpectation}) — skipping: ${job.title}`);
          queue.add({ ...job, source: 'linkedin', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        queue.add({ ...jobDetails, source: 'linkedin', workType });
        console.log(`  [LinkedIn Bot] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
      } catch (err) {
        console.error(`  [LinkedIn Bot] Error on "${job.title}": ${err.message}`);
      }

      await DELAY(2000);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'linkedin').length;
  console.log(`\n  [LinkedIn Bot] Phase 1 complete. ${pending} LinkedIn job(s) queued for Scorer.`);
}

async function phase2_applyReadyCVs(liPage) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [LinkedIn Bot] Phase 2 — Waiting for Scorer bot...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('linkedin');
  if (retried > 0) console.log(`  [LinkedIn Bot] Requeueing ${retried} previously-failed LinkedIn job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'linkedin')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

    const pendingJobs = [
      ...queue.getByStatus('pending').filter(j => j.source === 'linkedin'),
      ...queue.getByStatus('processing').filter(j => j.source === 'linkedin'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [LinkedIn Bot] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing applications until tomorrow`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        console.log(`  [LinkedIn Bot] Post-queue title filter — skipping: ${job.title}`);
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [LinkedIn Bot] Applying: ${job.title} @ ${job.company} [${job.workType || 'hybrid'}] (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        const applied = await linkedin.applyToJob(liPage, job, job.cvPath);

        if (applied === null) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
          console.log(`  [LinkedIn Bot] Already applied — skipping: ${job.title}`);
          continue;
        }

        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(
          job.title, job.company, job.url, job.cvName, job.cvScore,
          applied ? 'APPLIED' : 'APPLY_FAILED',
          applied ? 'LinkedIn Easy Apply' : 'LinkedIn form could not be completed'
        );
        console.log(`  [LinkedIn Bot] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      } catch (err) {
        queue.update(job.jobId, { status: 'apply_failed', error: err.message });
        logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
        console.error(`  [LinkedIn Bot] Error applying to "${job.title}": ${err.message}`);
      }

      const pause = 8000 + Math.random() * 7000;
      console.log(`  [LinkedIn Bot] Pausing ${Math.round(pause / 1000)}s before next application...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingJobs > 0) {
      idleCount = 0;
      queue.printStatus();
      console.log(`  [LinkedIn Bot] Waiting for Scorer bot... (${pendingJobs} LinkedIn job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [LinkedIn Bot] Idle ${idleCount}/${MAX_IDLE} — no pending or ready LinkedIn jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const liEmail = process.env.LI_EMAIL;
  const liPass  = process.env.LI_PASS;

  if (!liEmail || !liPass) {
    console.error('ERROR: Set LI_EMAIL and LI_PASS env vars');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  LinkedIn Bot — Starting (continuous mode)');
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'linkedin');
  if (stuckApplying.length > 0) {
    console.log(`  [LinkedIn Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  let liPage;
  try {
    liPage = await linkedin.login(browser, liEmail, liPass);
  } catch (err) {
    console.error('ERROR: ' + err.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }

  while (true) {
    await phase1_searchAndQueue(liPage);
    await phase2_applyReadyCVs(liPage);
    logger.printSummary();
    console.log('\n  [LinkedIn Bot] Cycle complete. Waiting 1 min before next search...');
    await DELAY(60 * 1000);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
