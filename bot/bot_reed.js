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

const cfg       = require('./config');
const reed      = require('./modules/reed');
const queue     = require('./modules/queue_manager');
const logger    = require('./modules/logger');
const salary    = require('./modules/salary_filter');
const stealth   = require('./modules/stealth');
const atsFiller = require('./modules/ats_filler');
const { launchPersistentContext, connectToRunningChrome, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');
const path      = require('path');


const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;   // 10 s between queue polls
const MAX_IDLE      = 6;       // give up after ~60 s of no pending/ready jobs

// ── Job title pre-filter — driven by the user's exclude-keyword list ───────
function isRelevantTitle(title) {
  const t = title.toLowerCase();
  return !cfg.TITLE_BLOCKLIST.some(k => t.includes(k));
}

function isBlockedCompany(company) {
  const c = (company || '').toLowerCase();
  return cfg.COMPANY_BLOCKLIST.some(b => c.includes(b));
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

// Shared job filtering logic — applies the same skip rules whether jobs came
// from the API or the browser scraper.
async function filterAndQueue(job, getDetails) {
  if (queue.has(job.jobId)) { console.log(`  [Reed Bot] Already queued: ${job.title}`); return; }
  if (queue.wasApplied(job.jobId)) { console.log(`  [Reed Bot] Already applied — skipping: ${job.title}`); return; }
  if (!isRelevantTitle(job.title)) { console.log(`  [Reed Bot] Title filter — skipping: ${job.title}`); return; }
  if (isBlockedCompany(job.company)) { console.log(`  [Reed Bot] Company blocked — skipping: ${job.title} @ ${job.company}`); return; }
  if (queue.hasCanonical(job.title, job.company)) { console.log(`  [Reed Bot] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`); return; }
  if (/with verification/i.test(job.title)) {
    console.log(`  [Reed Bot] Requires identity verification — skipping: ${job.title}`);
    queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Requires identity verification' });
    return;
  }

  let jobDetails;
  try { jobDetails = await getDetails(job); } catch (err) {
    console.error(`  [Reed Bot] Error fetching JD for "${job.title}": ${err.message}`);
    return;
  }

  if (!jobDetails.description || jobDetails.description.trim().split(/\s+/).length < 80) {
    console.log(`  [Reed Bot] Short/missing JD — skipping: ${job.title}`);
    queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'JD too short or missing' });
    return;
  }
  if (jobDetails.isTrainingCourse || cfg.isTrainingCourseJD(jobDetails.description, job.title)) {
    console.log(`  [Reed Bot] Training course — skipping: ${job.title}`);
    queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Training course' });
    return;
  }
  if (!jobDetails.hasEasyApply) {
    const reason = jobDetails.isExternalOnly ? 'External site' : 'No apply button';
    console.log(`  [Reed Bot] ${reason} — skipping: ${job.title}`);
    queue.add({ ...job, source: 'reed', status: 'skipped', reason });
    return;
  }
  const workType = detectWorkType(jobDetails.description);
  if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
    console.log(`  [Reed Bot] Work type "${workType}" not wanted — skipping: ${job.title}`);
    queue.add({ ...job, source: 'reed', status: 'skipped', reason: `Work type (${workType}) not wanted` });
    return;
  }
  if (cfg.APPLICANT.seekSponsorship) {
    if (!/visa sponsor|sponsorship|skilled worker visa|tier 2|work permit|sponsor.*visa/i.test(jobDetails.description)) {
      console.log(`  [Reed Bot] No sponsorship offered — skipping: ${job.title}`);
      queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'No sponsorship offered' });
      return;
    }
  }
  if (!salary.isAcceptable(jobDetails.description, cfg.APPLICANT.salaryExpectation)) {
    const min = salary.extractMinSalary(jobDetails.description);
    console.log(`  [Reed Bot] Below salary (${min ? '£' + min.toLocaleString() : 'stated'}) — skipping: ${job.title}`);
    queue.add({ ...job, source: 'reed', status: 'skipped', reason: 'Below salary expectation' });
    return;
  }

  queue.add({ ...jobDetails, source: 'reed', workType });
  console.log(`  [Reed Bot] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
}

// Drain — apply all currently cv_ready Reed jobs, then return immediately.
// Called between search terms in Phase 1 so jobs don't pile up during long scans.
async function drainReadyCVs(context, reedPage) {
  const priority = workTypePriority();
  const readyJobs = queue.getByStatus('cv_ready')
    .filter(j => j.source === 'reed')
    .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

  if (!readyJobs.length) return reedPage;
  console.log(`\n  [Reed Bot] [Drain] ${readyJobs.length} cv_ready job(s) — applying before next search...`);

  for (const job of readyJobs) {
    if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) {
      console.log(`  [Reed Bot] Daily limit reached — stopping drain`);
      return reedPage;
    }
    if (!isRelevantTitle(job.title)) {
      queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
      continue;
    }
    queue.update(job.jobId, { status: 'applying' });
    console.log(`  [Reed Bot] [Drain] Applying: ${job.title} @ ${job.company}`);
    try {
      const applied = await reed.applyToJob(reedPage, job, job.cvPath);
      if (applied === null) {
        queue.update(job.jobId, { status: 'skipped' });
        queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
      } else if (applied === 'external') {
        queue.update(job.jobId, { status: 'skipped', reason: 'External application site' });
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'External application site');
      } else if (applied === 'cv_not_attached') {
        // Never submit the base CV: skip when the tailored CV couldn't be attached.
        queue.update(job.jobId, { status: 'skipped', reason: 'Tailored CV not attached (reconnect account?)' });
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Tailored CV not attached');
        console.log(`  [Reed Bot] ⚠️ Skipped (tailored CV not attached, base NOT sent): ${job.title}`);
      } else {
        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, applied ? 'APPLIED' : 'APPLY_FAILED', applied ? 'Reed' : 'Reed form could not be completed');
        console.log(`  [Reed Bot] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      }
    } catch (err) {
      const isPageClosed = /Target page.*closed|context.*closed|browser.*closed|page.*closed/i.test(err.message);
      if (isPageClosed) {
        queue.update(job.jobId, { status: 'cv_ready', error: null });
        await reedPage.close().catch(() => {});
        reedPage = await context.newPage();
        await reed.ensureLoggedIn(reedPage);
      } else {
        queue.update(job.jobId, { status: 'apply_failed', error: err.message });
        logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
        console.error(`  [Reed Bot] [Drain] Error: ${err.message}`);
      }
    }
    await DELAY(8000 + Math.random() * 7000);
  }
  return reedPage;
}

async function phase1_searchAndQueue(context, reedPage) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Reed Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    // Drain any cv_ready jobs that built up before starting the next search
    reedPage = await drainReadyCVs(context, reedPage);

    console.log(`\n  [Reed Bot] Searching: "${searchTerm}"`);
    let jobs;
    try {
      const result = await reed.searchJobs(context, reedPage, searchTerm, cfg.MAX_JOBS_PER_SEARCH, false);
      jobs     = result.jobs;
      reedPage = result.page;
    } catch (err) {
      console.error(`  [Reed Bot] Search failed: ${err.message}`);
      continue;
    }
    for (const job of jobs) {
      await filterAndQueue(job, j => reed.getJobDescription(reedPage, j));
      await DELAY(2000);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'reed').length;
  console.log(`\n  [Reed Bot] Phase 1 complete. ${pending} Reed job(s) queued for Scorer.`);
  return reedPage;
}

async function phase2_applyReadyCVs(context, reedPage) {
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

        if (applied === 'cv_not_attached') {
          // Never submit the base CV: skip when the tailored CV couldn't be attached.
          queue.update(job.jobId, { status: 'skipped', reason: 'Tailored CV not attached (reconnect account?)' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Tailored CV not attached');
          console.log(`  [Reed Bot] ⚠️ Skipped (tailored CV not attached, base NOT sent): ${job.title}`);
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
        const isPageClosed = /Target page.*closed|context.*closed|browser.*closed|page.*closed/i.test(err.message);

        if (isPageClosed) {
          // The browser tab died mid-apply — reset this job and try to recover with a fresh page.
          // If the whole context is dead, throw so main() can relaunch the entire browser.
          console.log(`  [Reed Bot] Page was closed unexpectedly — recovering browser page...`);
          queue.update(job.jobId, { status: 'cv_ready', error: null });
          await reedPage.close().catch(() => {});
          reedPage = await context.newPage(); // throws if context is dead → caught by main()
          await reed.ensureLoggedIn(reedPage);
          console.log(`  [Reed Bot] Browser page recovered — will retry "${job.title}" next loop`);
        } else if (isPageIssue) {
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
      try { queue.printStatus(); } catch (_) {}
      console.log(`  [Reed Bot] Waiting for Scorer bot... (${pendingJobs} Reed job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [Reed Bot] Idle ${idleCount}/${MAX_IDLE} — no pending or ready Reed jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

const CONTEXT_DEAD_RE = /Target page|context.*closed|browser.*closed|page.*closed/i;

async function launchBrowser() {
  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'reed_profile');
  const cdpPort = process.env.JOBBOT_CDP_PORT;
  const context = cdpPort
    ? await connectToRunningChrome(parseInt(cdpPort)).catch(() => launchPersistentContext(profileDir))
    : await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const page = await context.newPage();
  return { context, page };
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Reed Bot — Starting (continuous mode)');
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'reed');
  if (stuckApplying.length > 0) {
    console.log(`  [Reed Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  // Outer loop: relaunch the browser if the context dies mid-session
  while (true) {
    let context, reedPage, closeGuard;
    try {
      ({ context, page: reedPage } = await launchBrowser());
      // User closing the Chromium window → clean stop, not an error or relaunch
      closeGuard = watchForManualClose(context, 'Reed Bot');
      await reed.ensureLoggedIn(reedPage);
    } catch (err) {
      if (BROWSER_CLOSED_RE.test(err.message || '')) {
        console.log('  [Reed Bot] Browser window closed — agent stopped.');
        process.exit(0);
      }
      console.error('  [Reed Bot] Failed to launch browser or log in: ' + err.message);
      await context?.close().catch(() => {});
      process.exit(1);
    }

    // When the shared daily application cap is reached, stop the WHOLE agent —
    // not just applications. Otherwise it keeps searching + scoring/tailoring
    // CVs it can't apply to today, piling up an unappliable backlog and burning
    // AI credits. Exiting cleanly also auto-stops the Scorer (see botManager).
    const stopIfDailyLimit = async () => {
      const n = queue.countAppliedToday();
      if (n >= cfg.MAX_APPLICATIONS_PER_DAY) {
        // "Daily limit reached" in the log also triggers the desktop notification (main.js).
        console.log(`  [Reed Bot] Daily limit reached (${n}/${cfg.MAX_APPLICATIONS_PER_DAY}) — stopping agent until tomorrow`);
        if (closeGuard) closeGuard.intentional = true;
        await context.close().catch(() => {});
        process.exit(0);
      }
    };

    try {
      while (true) {
        await stopIfDailyLimit();
        await phase2_applyReadyCVs(context, reedPage);
        await stopIfDailyLimit();                 // stop before wasting a search/score cycle
        reedPage = await phase1_searchAndQueue(context, reedPage);
        await phase2_applyReadyCVs(context, reedPage);
        await stopIfDailyLimit();
        logger.printSummary();
        console.log('\n  [Reed Bot] Cycle complete. Waiting 1 min before next search...');
        await DELAY(60 * 1000);
      }
    } catch (err) {
      if (CONTEXT_DEAD_RE.test(err.message) || BROWSER_CLOSED_RE.test(err.message)) {
        // Browser window was closed (almost always the user clicking ✕) — stop
        // cleanly so the agent shows "stopped", don't error or pop a new window open.
        console.log('  [Reed Bot] Browser window closed — agent stopped.');
        if (closeGuard) closeGuard.intentional = true;
        await context.close().catch(() => {});
        process.exit(0);
      } else {
        console.error('Fatal error:', err);
        process.exit(1);
      }
    }
  }
}

main().catch(err => {
  if (BROWSER_CLOSED_RE.test(err?.message || '')) {
    console.log('  [Reed Bot] Browser window closed — agent stopped.');
    process.exit(0);
  }
  console.error('Fatal error:', err);
  process.exit(1);
});
