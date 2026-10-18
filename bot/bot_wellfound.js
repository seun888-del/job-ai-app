/**
 * Wellfound Bot (wellfound.com, USA startup jobs)
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search Wellfound for jobs applied for on Wellfound itself (search results
 *            carry the full description) and add matching jobs to queue.db
 *            (source: 'wellfound') with status "pending". The Scorer then tailors the resume.
 *
 * Phase 2 — Polls the queue every 10 s. When the Scorer marks a Wellfound job
 *            "cv_ready", puts the tailored resume on the user's Wellfound profile and sends
 *            the application with the Scorer's cover letter.
 */

const cfg            = require('./config');
const wellfound    = require('./modules/wellfound');
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
  console.log('  [Wellfound Agent] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [Wellfound Agent] Searching: "${searchTerm}"`);
    let jobs;
    try {
      jobs = await wellfound.searchJobs(page, searchTerm, cfg.MAX_JOBS_PER_SEARCH);
    } catch (err) {
      console.error(`  [Wellfound Agent] Search failed: ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      if (queue.has(job.jobId)) {
        console.log(`  [Wellfound Agent] Already queued: ${job.title}`);
        continue;
      }
      if (queue.wasApplied(job.jobId)) {
        console.log(`  [Wellfound Agent] Already applied previously — skipping: ${job.title}`);
        continue;
      }
      if (!isRelevantTitle(job.title)) {
        console.log(`  [Wellfound Agent] Title filter — skipping: ${job.title}`);
        continue;
      }

      if (isBlockedCompany(job.company)) {
        console.log(`  [Wellfound Agent] Company blocked — skipping: ${job.title} @ ${job.company}`);
        continue;
      }


      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [Wellfound Agent] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      if (job.external) {
        console.log(`  [Wellfound Agent] Applied for on the company website — skipping: ${job.title}`);
        queue.add({ ...job, source: 'wellfound', status: 'skipped', reason: 'External apply (not Wellfound)' });
        continue;
      }

      try {
        const jobDetails = await wellfound.getJobDescription(page, job);

        if (jobDetails.alreadyApplied) {
          console.log(`  [Wellfound Agent] Already applied on Wellfound — skipping: ${job.title}`);
          queue.markApplied(job.jobId);
          continue;
        }

        if (!jobDetails.description || jobDetails.description.trim().split(/\s+/).length < 80) {
          console.log(`  [Wellfound Agent] Short/missing JD — skipping: ${job.title}`);
          queue.add({ ...job, source: 'wellfound', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }

        if (cfg.isTrainingCourseJD(jobDetails.description, job.title)) {
          console.log(`  [Wellfound Agent] Training course — skipping: ${job.title}`);
          queue.add({ ...job, source: 'wellfound', status: 'skipped', reason: 'Training course' });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(jobDetails.description))) {
          console.log(`  [Wellfound Agent] No sponsorship offered — skipping: ${job.title}`);
          queue.add({ ...job, source: 'wellfound', status: 'skipped', reason: 'No sponsorship offered' });
          continue;
        }

        const workType = job.workType || detectWorkType(jobDetails.description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [Wellfound Agent] Work type "${workType}" not wanted — skipping: ${job.title}`);
          queue.add({ ...job, source: 'wellfound', status: 'skipped', reason: `Work type (${workType}) not wanted` });
          continue;
        }

        if (!salary.isAcceptable(`${jobDetails.salaryText || ''}\n${jobDetails.description}`, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(`${jobDetails.salaryText || ''}\n${jobDetails.description}`);
          console.log(`  [Wellfound Agent] Below salary expectation ($${min?.toLocaleString() || '?'} < ${cfg.APPLICANT.salaryExpectation}) — skipping: ${job.title}`);
          queue.add({ ...job, source: 'wellfound', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        const { alreadyApplied, external, salaryText, remoteText, ...rest } = jobDetails;
        queue.add({ ...rest, source: 'wellfound', workType });
        console.log(`  [Wellfound Agent] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
      } catch (err) {
        // Sign-in / Terms prompts that timed out, or a closed window: stop, don't repeat per job.
        if (/^Wellfound: (signed out|sign in|job search|the human check)|closed/i.test(err.message || '')) throw err;
        console.error(`  [Wellfound Agent] Error on "${job.title}": ${err.message}`);
      }

      await DELAY(2500);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'wellfound').length;
  console.log(`\n  [Wellfound Agent] Phase 1 complete. ${pending} Wellfound job(s) queued for Scorer.`);
}

async function phase2_applyReadyCVs(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Wellfound Agent] Phase 2 — Waiting for Scorer agent...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('wellfound');
  if (retried > 0) console.log(`  [Wellfound Agent] Requeueing ${retried} previously-failed Wellfound job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount  = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'wellfound')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

    const pendingCount = [
      ...queue.getByStatus('pending').filter(j => j.source === 'wellfound'),
      ...queue.getByStatus('processing').filter(j => j.source === 'wellfound'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Wellfound Agent] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing until tomorrow`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [Wellfound Agent] Applying: ${job.title} @ ${job.company} [${job.workType || 'remote'}] (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        // The Scorer writes the cover letter just after the resume; give it a moment.
        let letter = job.coverLetter || '';
        for (let i = 0; i < 12 && !letter; i++) {
          await DELAY(5000);
          const fresh = queue.getByStatus('applying').find(j => j.jobId === job.jobId);
          letter = (fresh && fresh.coverLetter) || '';
        }
        const applied = await wellfound.applyToJob(page, job, job.cvPath, letter);

        if (applied === null) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
          console.log(`  [Wellfound Agent] Already applied — skipping: ${job.title}`);
          continue;
        }

        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(
          job.title, job.company, job.url, job.cvName, job.cvScore,
          applied ? 'APPLIED' : 'APPLY_FAILED',
          applied ? 'Wellfound' : 'Wellfound form could not be completed'
        );
        console.log(`  [Wellfound Agent] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      } catch (err) {
        const isPageIssue = /no apply button|external|cannot apply here/i.test(err.message);
        if (isPageIssue) {
          queue.update(job.jobId, { status: 'skipped', reason: err.message });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', err.message.substring(0, 100));
          console.log(`  [Wellfound Agent] Page issue — skipping: ${job.title} (${err.message})`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', error: err.message });
          logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
          console.error(`  [Wellfound Agent] Error applying to "${job.title}": ${err.message}`);
        }
      }

      // Human-like pause between applications: 10–18 seconds
      const pause = 10000 + Math.random() * 8000;
      console.log(`  [Wellfound Agent] Pausing ${Math.round(pause / 1000)}s before next application...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingCount > 0) {
      idleCount = 0;
      try { queue.printStatus(); } catch (_) {}
      console.log(`  [Wellfound Agent] Waiting for Scorer agent... (${pendingCount} Wellfound job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [Wellfound Agent] Idle ${idleCount}/${MAX_IDLE} — no pending or ready Wellfound jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  // Scorer holds Wellfound jobs until the sign-in is confirmed below.
  queue.markSessionChecking('wellfound');

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Wellfound Agent — Starting (wellfound.com, continuous mode)`);
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs stuck in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'wellfound');
  if (stuckApplying.length > 0) {
    console.log(`  [Wellfound Agent] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  // Stealth Chrome with the agent's own saved profile (same as Indeed and Dice).
  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'wellfound_profile');
  const context = await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const wfPage = await context.newPage();
  // A crashed tab never answers, so the agent would wait forever. Close it: the pending step then
  // fails with "closed" and the agent stops with a clear message instead of hanging.
  wfPage.on('crash', () => {
    console.error('  [Wellfound Agent] The Wellfound page crashed (often low memory). Stopping, press Start to try again.');
    wfPage.close().catch(() => {});
  });

  try {
    try {
      await wellfound.ensureLoggedIn(wfPage);
    } catch (err) {
      queue.markSessionDead('wellfound'); // sign-in failed → Scorer stops tailoring Wellfound jobs
      throw err;
    }
    queue.markSessionHealthy('wellfound');
    while (true) {
      await phase1_searchAndQueue(wfPage);
      await phase2_applyReadyCVs(wfPage);
      logger.printSummary();
      console.log('\n  [Wellfound Agent] Cycle complete. Waiting 1 min before next search...');
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
