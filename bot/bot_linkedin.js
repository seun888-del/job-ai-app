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

const cfg      = require('./config');
const linkedin = require('./modules/linkedin');
const queue    = require('./modules/queue_manager');
const logger   = require('./modules/logger');
const salary   = require('./modules/salary_filter');
const stealth  = require('./modules/stealth');
const { launchPersistentContext, connectToRunningChrome, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');
const path     = require('path');

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

// Drain — apply all currently cv_ready LinkedIn jobs, then return immediately.
async function drainReadyCVs(liPage) {
  const priority = workTypePriority();
  const readyJobs = queue.getByStatus('cv_ready')
    .filter(j => j.source === 'linkedin')
    .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

  if (!readyJobs.length) return;
  console.log(`\n  [LinkedIn Bot] [Drain] ${readyJobs.length} cv_ready job(s) — applying before next search...`);

  for (const job of readyJobs) {
    if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) {
      console.log(`  [LinkedIn Bot] Daily limit reached — stopping drain`);
      return;
    }
    if (!isRelevantTitle(job.title)) {
      queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
      continue;
    }
    queue.update(job.jobId, { status: 'applying' });
    console.log(`  [LinkedIn Bot] [Drain] Applying: ${job.title} @ ${job.company}`);
    try {
      const applied = await linkedin.applyToJob(liPage, job, job.cvPath);
      if (applied === null) {
        queue.update(job.jobId, { status: 'skipped' });
        queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
      } else if (applied === 'cv_not_attached') {
        queue.update(job.jobId, { status: 'skipped', reason: 'Tailored CV not attached (reconnect account?)' });
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Tailored CV not attached');
        console.log(`  [LinkedIn Bot] ⚠️ Skipped (tailored CV not attached, base NOT sent): ${job.title}`);
      } else {
        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, applied ? 'APPLIED' : 'APPLY_FAILED', applied ? 'LinkedIn Easy Apply' : 'LinkedIn form could not be completed');
        console.log(`  [LinkedIn Bot] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      }
    } catch (err) {
      queue.update(job.jobId, { status: 'apply_failed', error: err.message });
      logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
      console.error(`  [LinkedIn Bot] [Drain] Error: ${err.message}`);
    }
    await DELAY(8000 + Math.random() * 7000);
  }
}

async function phase1_searchAndQueue(liPage) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [LinkedIn Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    // Drain any cv_ready jobs before starting the next search term
    await drainReadyCVs(liPage);

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

      if (isBlockedCompany(job.company)) {
        console.log(`  [LinkedIn Bot] Company blocked — skipping: ${job.title} @ ${job.company}`);
        continue;
      }


      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [LinkedIn Bot] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      try {
        const jobDetails = await linkedin.getJobDescription(liPage, job);

        if (!jobDetails.description || jobDetails.description.trim().split(/\s+/).length < 80) {
          console.log(`  [LinkedIn Bot] Short/missing JD — skipping: ${job.title}`);
          queue.add({ ...job, source: 'linkedin', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }

        if (cfg.isTrainingCourseJD(jobDetails.description, job.title)) {
          console.log(`  [LinkedIn Bot] Training course — skipping: ${job.title}`);
          queue.add({ ...job, source: 'linkedin', status: 'skipped', reason: 'Training course' });
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

        if (applied === 'cv_not_attached') {
          queue.update(job.jobId, { status: 'skipped', reason: 'Tailored CV not attached (reconnect account?)' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Tailored CV not attached');
          console.log(`  [LinkedIn Bot] ⚠️ Skipped (tailored CV not attached, base NOT sent): ${job.title}`);
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
      try { queue.printStatus(); } catch (_) {}
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

  console.log('═══════════════════════════════════════════════════════');
  console.log('  LinkedIn Bot — Starting (continuous mode)');
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'linkedin');
  if (stuckApplying.length > 0) {
    console.log(`  [LinkedIn Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'linkedin_profile');
  const cdpPort = process.env.JOBBOT_CDP_PORT;
  const context = cdpPort
    ? await connectToRunningChrome(parseInt(cdpPort)).catch(() => launchPersistentContext(profileDir))
    : await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  // User closing the Chromium window → clean stop, not an error
  const closeGuard = watchForManualClose(context, 'LinkedIn Bot');

  const liPage = await context.newPage();
  try {
    await linkedin.ensureLoggedIn(liPage);
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) {
      console.log('  [LinkedIn Bot] Browser window closed — agent stopped.');
      process.exit(0);
    }
    console.error('ERROR: ' + err.message);
    await context.close().catch(() => {});
    process.exit(1);
  }

  // When the shared daily application cap is reached, stop the WHOLE agent — not
  // just applications — so it doesn't keep searching + scoring/tailoring CVs it
  // can't apply to today (backlog buildup + wasted AI credits). Exiting cleanly
  // also auto-stops the Scorer (see botManager).
  const stopIfDailyLimit = async () => {
    const n = queue.countAppliedToday();
    if (n >= cfg.MAX_APPLICATIONS_PER_DAY) {
      // "Daily limit reached" in the log also triggers the desktop notification (main.js).
      console.log(`  [LinkedIn Bot] Daily limit reached (${n}/${cfg.MAX_APPLICATIONS_PER_DAY}) — stopping agent until tomorrow`);
      closeGuard.intentional = true;
      await context.close().catch(() => {});
      process.exit(0);
    }
  };

  try {
    while (true) {
      await stopIfDailyLimit();
      await phase2_applyReadyCVs(liPage);
      await stopIfDailyLimit();                 // stop before wasting a search/score cycle
      await phase1_searchAndQueue(liPage);
      await phase2_applyReadyCVs(liPage);
      await stopIfDailyLimit();
      logger.printSummary();
      console.log('\n  [LinkedIn Bot] Cycle complete. Waiting 1 min before next search...');
      await DELAY(60 * 1000);
    }
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) {
      console.log('  [LinkedIn Bot] Browser window closed — agent stopped.');
      closeGuard.intentional = true;
      await context.close().catch(() => {});
      process.exit(0);
    }
    throw err;
  }
}

main().catch(err => {
  if (BROWSER_CLOSED_RE.test(err?.message || '')) {
    console.log('  [LinkedIn Bot] Browser window closed — agent stopped.');
    process.exit(0);
  }
  console.error('Fatal error:', err);
  process.exit(1);
});
