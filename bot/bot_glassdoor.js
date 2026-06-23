/**
 * Glassdoor Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search Glassdoor (glassdoor.co.uk / glassdoor.com) for Remote
 *            Easy Apply jobs. Extracts JDs and queues them (source: 'glassdoor').
 * Phase 2 — When Scorer marks a job cv_ready, submits via Glassdoor Easy Apply.
 */

const cfg            = require('./config');
const glassdoor      = require('./modules/glassdoor');
const queue          = require('./modules/queue_manager');
const logger         = require('./modules/logger');
const salary         = require('./modules/salary_filter');
const stealth        = require('./modules/stealth');
const { launchPersistentContext } = require('./modules/browser_launcher');
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
  if (/\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bwork from home\b|\bwfh\b/.test(d)) return 'remote';
  if (/\bhybrid\b/.test(d)) return 'hybrid';
  return 'onsite';
}

function workTypePriority() {
  const map = {};
  cfg.WORK_TYPE_PRIORITY.forEach((type, i) => { map[type] = i; });
  return map;
}

async function phase1_searchAndQueue(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Glassdoor Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [Glassdoor Bot] Searching: "${searchTerm}"`);
    let jobs;
    try {
      jobs = await glassdoor.searchJobs(page, searchTerm, cfg.MAX_JOBS_PER_SEARCH);
    } catch (err) {
      console.error(`  [Glassdoor Bot] Search failed: ${err.message}`);
      continue;
    }

    for (const job of jobs) {
      if (queue.has(job.jobId)) { console.log(`  [Glassdoor Bot] Already queued: ${job.title}`); continue; }
      if (queue.wasApplied(job.jobId)) { console.log(`  [Glassdoor Bot] Already applied — skipping: ${job.title}`); continue; }
      if (!isRelevantTitle(job.title)) { console.log(`  [Glassdoor Bot] Title filter — skipping: ${job.title}`); continue; }
      if (isBlockedCompany(job.company)) { console.log(`  [Glassdoor Bot] Company blocked — skipping: ${job.title} @ ${job.company}`); continue; }
      if (queue.wasAppliedToCompanyRecently(job.company)) {
        console.log(`  [Glassdoor Bot] Applied to ${job.company} in last 30 days — skipping: ${job.title}`);
        continue;
      }
      if (queue.hasCanonical(job.title, job.company)) {
        console.log(`  [Glassdoor Bot] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`);
        continue;
      }

      try {
        const jobDetails = await glassdoor.getJobDescription(page, job);

        if (!jobDetails.description || jobDetails.description.trim().split(/\s+/).length < 80) {
          queue.add({ ...job, source: 'glassdoor', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }
        if (!jobDetails.hasEasyApply) {
          queue.add({ ...job, source: 'glassdoor', status: 'skipped', reason: 'No Easy Apply button' });
          continue;
        }
        if (cfg.APPLICANT.seekSponsorship) {
          const offersSponsor = /visa sponsor|sponsorship|skilled worker visa|tier 2|work permit/i.test(jobDetails.description);
          if (!offersSponsor) {
            queue.add({ ...job, source: 'glassdoor', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }
        if (!salary.isAcceptable(jobDetails.description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(jobDetails.description);
          console.log(`  [Glassdoor Bot] Below salary (£${min?.toLocaleString() || '?'}) — skipping: ${job.title}`);
          queue.add({ ...job, source: 'glassdoor', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        const workType = detectWorkType(jobDetails.description);
        queue.add({ ...jobDetails, source: 'glassdoor', workType });
        console.log(`  [Glassdoor Bot] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
      } catch (err) {
        console.error(`  [Glassdoor Bot] Error on "${job.title}": ${err.message}`);
      }
      await DELAY(2500);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'glassdoor').length;
  console.log(`\n  [Glassdoor Bot] Phase 1 complete. ${pending} job(s) queued for Scorer.`);
}

async function phase2_applyReadyCVs(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Glassdoor Bot] Phase 2 — Waiting for Scorer bot...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('glassdoor');
  if (retried > 0) console.log(`  [Glassdoor Bot] Requeueing ${retried} previously-failed Glassdoor job(s).`);

  const priority = workTypePriority();
  let idleCount  = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'glassdoor')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

    const pendingCount = [
      ...queue.getByStatus('pending').filter(j => j.source === 'glassdoor'),
      ...queue.getByStatus('processing').filter(j => j.source === 'glassdoor'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Glassdoor Bot] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY})`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [Glassdoor Bot] Applying: ${job.title} @ ${job.company} (Score: ${job.cvScore}%)`);

      try {
        const applied = await glassdoor.applyToJob(page, job, job.cvPath);
        if (applied === null) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Already applied');
          continue;
        }
        const finalStatus = applied ? 'applied' : 'apply_failed';
        queue.update(job.jobId, { status: finalStatus });
        if (applied) queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore,
          applied ? 'APPLIED' : 'APPLY_FAILED',
          applied ? 'Glassdoor Easy Apply' : 'Glassdoor form could not be completed');
        console.log(`  [Glassdoor Bot] ${applied ? '✓ Applied' : '✗ Apply failed'}: ${job.title}`);
      } catch (err) {
        queue.update(job.jobId, { status: 'apply_failed', error: err.message });
        logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
        console.error(`  [Glassdoor Bot] Error: ${err.message}`);
      }

      const pause = 10000 + Math.random() * 8000;
      console.log(`  [Glassdoor Bot] Pausing ${Math.round(pause / 1000)}s...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingCount > 0) {
      idleCount = 0;
      console.log(`  [Glassdoor Bot] Waiting for Scorer... (${pendingCount} job(s) pending)`);
    } else {
      idleCount++;
      console.log(`  [Glassdoor Bot] Idle ${idleCount}/${MAX_IDLE}`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const country = cfg.APPLICANT.country || 'United Kingdom';
  const domain  = country === 'United States' ? 'glassdoor.com' : 'glassdoor.co.uk';

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Glassdoor Bot — Starting (${domain}, continuous mode)`);
  console.log('═══════════════════════════════════════════════════════');

  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'glassdoor');
  if (stuckApplying.length > 0) {
    console.log(`  [Glassdoor Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'glassdoor_profile');
  const context = await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const gdPage = await context.newPage();

  try {
    await glassdoor.ensureLoggedIn(gdPage, domain);
    while (true) {
      await phase1_searchAndQueue(gdPage);
      await phase2_applyReadyCVs(gdPage);
      logger.printSummary();
      console.log('\n  [Glassdoor Bot] Cycle complete. Waiting 1 min...');
      await DELAY(60 * 1000);
    }
  } catch (err) {
    console.error('ERROR: ' + err.message);
    process.exit(1);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
