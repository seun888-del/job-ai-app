/**
 * CWJobs Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search cwjobs.co.uk (IT-focused UK job board) for matching
 *            jobs, extract JDs, add to queue.db (source: 'cwjobs').
 * Phase 2 — Poll queue. When Scorer sets a cwjobs job to "cv_ready",
 *            submit the application via CWJobs Quick Apply.
 *
 * CWJobs uses the same StepStone platform as Totaljobs — selectors are
 * identical; only the base URL and session file differ.
 */

const cfg     = require('./config');
const queue   = require('./modules/queue_manager');
const logger  = require('./modules/logger');
const salary  = require('./modules/salary_filter');
const sponsorship = require('./modules/sponsorship');
const stealth = require('./modules/stealth');
const { launchPersistentContext, connectToRunningChrome, humanWarmup, waitForCloudflareSolve } = require('./modules/browser_launcher');
const path    = require('path');
const fs      = require('fs');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;
const MAX_IDLE      = 6;

const BASE_URL = 'https://www.cwjobs.co.uk';

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
  if (/\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bwork from home\b|\bwfh\b|\bremote working\b|\bremote role\b/.test(d)) return 'remote';
  if (/\bhybrid\b/.test(d)) return 'hybrid';
  return 'onsite';
}

function workTypePriority() {
  const map = {};
  cfg.WORK_TYPE_PRIORITY.forEach((type, i) => { map[type] = i; });
  return map;
}

// ── Login ──────────────────────────────────────────────────────────────────
async function ensureLoggedIn(page) {
  await page.goto('https://www.cwjobs.co.uk/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await DELAY(2000);
  const isLoggedIn = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase();
    return t.includes('hi,') || t.includes('my recommended jobs') || t.includes('job search at a glance') ||
           t.includes('sign out') || t.includes('my jobs');
  }).catch(() => false);
  if (!isLoggedIn) throw new Error('CWJobs: not logged in. Go to Job Site Login → Connect CWJobs Account first.');
  console.log('  [CWJobs Bot] Session active');
}

// ── Phase 1: Search & queue ───────────────────────────────────────────────
async function phase1_searchAndQueue(context, page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [CWJobs Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  // Warm up on the homepage first — cold-jumping to a search URL triggers Akamai
  console.log('  [CWJobs Bot] Warming up on homepage...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await humanWarmup(page);
  await DELAY(2000 + Math.random() * 1500);

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [CWJobs Bot] Searching: "${searchTerm}"`);

    // Use the natural search URL format (/jobs?q=) that the search form produces,
    // not the legacy /jobs/{term} path — Akamai blocks the legacy path as scraping.
    const searchUrl = `${BASE_URL}/jobs?q=${encodeURIComponent(searchTerm)}&postedWithin=14&distance=20`;

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await waitForCloudflareSolve(page);
      await humanWarmup(page);
      await DELAY(2500 + Math.random() * 1500);
    } catch (err) {
      console.error(`  [CWJobs Bot] Failed to load search: ${err.message}`);
      continue;
    }

    const jobLinks = await page.$$eval(
      'article[data-job-id] h2 a, .job-result__title a, [data-at="job-item-title"] a, h2.job-title a',
      els => els.map(el => ({ url: el.href, title: el.textContent.trim() }))
    ).catch(() => []);

    if (!jobLinks.length) {
      console.log(`  [CWJobs Bot] No results for "${searchTerm}"`);
      continue;
    }

    console.log(`  [CWJobs Bot] Found ${jobLinks.length} listings`);

    for (const link of jobLinks.slice(0, cfg.MAX_JOBS_PER_SEARCH)) {
      const jobId = `cw_${link.url.replace(/[^a-z0-9]/gi, '_').slice(-40)}`;

      if (queue.has(jobId)) { console.log(`  [CWJobs Bot] Already queued: ${link.title}`); continue; }
      if (queue.wasApplied(jobId)) { console.log(`  [CWJobs Bot] Already applied — skipping: ${link.title}`); continue; }
      if (!isRelevantTitle(link.title)) { console.log(`  [CWJobs Bot] Title filter — skipping: ${link.title}`); continue; }

      try {
        await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await DELAY(1500);

        const company = await page.$eval(
          '[data-at="company-name"], .company-name, .job-info-header__company-name, [itemprop="hiringOrganization"] [itemprop="name"]',
          el => el.textContent.trim()
        ).catch(() => '');

        if (isBlockedCompany(company)) {
          console.log(`  [CWJobs Bot] Company blocked — skipping: ${link.title} @ ${company}`);
          continue;
        }


        if (queue.hasCanonical(link.title, company)) {
          console.log(`  [CWJobs Bot] Duplicate (cross-site) — skipping: ${link.title} @ ${company}`);
          continue;
        }

        const applyHref = await page.$eval(
          '[data-at="apply-button"], a.apply-button, a[href*="/apply"]',
          el => el.href || ''
        ).catch(() => '');
        if (applyHref && !applyHref.includes('cwjobs.co.uk') && /^https?:\/\//.test(applyHref)) {
          console.log(`  [CWJobs Bot] External site — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'External site' });
          continue;
        }

        const description = await page.$eval(
          '[data-at="job-description"], #job-description, .job-description, [class*="jobDescription"]',
          el => el.innerText
        ).catch(() => '');

        if (!description || description.trim().split(/\s+/).length < 80) {
          console.log(`  [CWJobs Bot] Short/missing JD — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }

        if (cfg.isTrainingCourseJD(description, link.title)) {
          console.log(`  [CWJobs Bot] Training course — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'Training course' });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(description))) {
          console.log(`  [CWJobs Bot] No sponsorship — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'No sponsorship offered' });
          continue;
        }

        const workType = detectWorkType(description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [CWJobs Bot] Work type "${workType}" not wanted — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: `Work type (${workType}) not wanted` });
          continue;
        }

        if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) {
          console.log(`  [CWJobs Bot] Below salary expectation — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        queue.add({ jobId, title: link.title, company, url: link.url, description, source: 'cwjobs', workType });
        console.log(`  [CWJobs Bot] → Queued for Scorer: ${link.title} @ ${company} [${workType}]`);
      } catch (err) {
        console.error(`  [CWJobs Bot] Error on "${link.title}": ${err.message}`);
      }

      await DELAY(2000);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'cwjobs').length;
  console.log(`\n  [CWJobs Bot] Phase 1 complete. ${pending} CWJobs job(s) queued for Scorer.`);
  return page;
}

// ── Phase 2: Apply ────────────────────────────────────────────────────────
async function phase2_applyReadyCVs(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [CWJobs Bot] Phase 2 — Waiting for Scorer bot...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('cwjobs');
  if (retried > 0) console.log(`  [CWJobs Bot] Requeueing ${retried} previously-failed job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'cwjobs')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));
    const pendingJobs = [
      ...queue.getByStatus('pending').filter(j => j.source === 'cwjobs'),
      ...queue.getByStatus('processing').filter(j => j.source === 'cwjobs'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [CWJobs Bot] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing until tomorrow`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        console.log(`  [CWJobs Bot] Post-queue title filter — skipping: ${job.title}`);
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [CWJobs Bot] Applying: ${job.title} @ ${job.company} [${job.workType || 'onsite'}] (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await waitForCloudflareSolve(page);
        await DELAY(2000);

        // Check if already applied
        const alreadyApplied = await page.evaluate(() => {
          const t = (document.body?.innerText || '').toLowerCase();
          return t.includes('you have already applied') || t.includes('already applied') ||
                 t.includes('application sent') || t.includes('you applied');
        }).catch(() => false);
        if (alreadyApplied) {
          queue.update(job.jobId, { status: 'skipped' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Already applied');
          console.log(`  [CWJobs Bot] Already applied — skipping: ${job.title}`);
          continue;
        }

        // Find and click Apply button
        const applySelectors = [
          '[data-at="apply-button"]',
          'a.apply-button', 'button.apply-button',
          'a:has-text("Apply Now")', 'button:has-text("Apply Now")',
          'a:has-text("Quick Apply")', 'button:has-text("Quick Apply")',
          'a:has-text("Apply")', 'button:has-text("Apply")',
        ];
        let clicked = false;
        for (const sel of applySelectors) {
          try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) { await btn.click(); clicked = true; break; }
          } catch (_) {}
        }
        if (!clicked) {
          queue.update(job.jobId, { status: 'skipped', reason: 'Apply button not found' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'No apply button');
          console.log(`  [CWJobs Bot] Apply button gone — skipping: ${job.title}`);
          continue;
        }

        await DELAY(3000);

        // If redirected to an external site, skip
        const postClickUrl = page.url();
        if (!postClickUrl.includes('cwjobs.co.uk') && !postClickUrl.includes('stepstone')) {
          queue.update(job.jobId, { status: 'skipped', reason: 'External application site' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'External site');
          console.log(`  [CWJobs Bot] External redirect — skipping: ${job.title}`);
          continue;
        }

        // Upload CV if we have one
        if (job.cvPath && fs.existsSync(job.cvPath)) {
          // Try clicking "Upload CV" / "Use different CV" button first
          const uploadTriggers = [
            'button:has-text("Upload CV")', 'a:has-text("Upload CV")',
            'button:has-text("Upload a CV")', 'a:has-text("Upload a CV")',
            'button:has-text("Change CV")', 'a:has-text("Change CV")',
            'button:has-text("Use different CV")', 'label:has-text("Upload")',
          ];
          for (const sel of uploadTriggers) {
            try {
              const btn = await page.$(sel);
              if (btn && await btn.isVisible()) { await btn.click(); await DELAY(1500); break; }
            } catch (_) {}
          }
          // Set the file on the file input
          try {
            const fileInput = await page.$('input[type="file"]');
            if (fileInput) {
              await fileInput.setInputFiles(job.cvPath);
              await DELAY(2000);
              console.log(`  [CWJobs Bot] CV uploaded: ${path.basename(job.cvPath)}`);
            }
          } catch (_) {}
        }

        // Fill cover letter if available
        if (job.coverLetter) {
          try {
            const clField = await page.$(
              'textarea[name*="cover"], textarea[name*="letter"], textarea[id*="cover"], ' +
              'textarea[placeholder*="cover"], [data-at="cover-letter"] textarea'
            );
            if (clField && await clField.isVisible()) {
              await clField.fill(job.coverLetter.substring(0, 3000));
              await DELAY(500);
            }
          } catch (_) {}
        }

        // Submit
        const submitSelectors = [
          'button[data-at="submit-application"]',
          'button[type="submit"]:has-text("Apply")',
          'button[type="submit"]:has-text("Submit")',
          'button:has-text("Submit application")',
          'button:has-text("Send application")',
          'input[type="submit"]',
        ];
        let submitted = false;
        for (const sel of submitSelectors) {
          try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) { await btn.click(); submitted = true; break; }
          } catch (_) {}
        }

        await DELAY(4000);

        const pageText = await page.textContent('body').catch(() => '');
        const success = submitted && /thank you|application (sent|received|submitted)|successfully applied|we.*received your|application complete/i.test(pageText);

        if (success) {
          queue.update(job.jobId, { status: 'applied' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'APPLIED', 'CWJobs');
          console.log(`  [CWJobs Bot] ✓ Applied: ${job.title} @ ${job.company}`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', reason: 'No confirmation detected' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'FAILED', 'No confirmation');
          console.log(`  [CWJobs Bot] No confirmation — marking failed: ${job.title}`);
        }
      } catch (err) {
        const isPageIssue = /apply button not found|no apply button|external/i.test(err.message);
        if (isPageIssue) {
          queue.update(job.jobId, { status: 'skipped', reason: err.message });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', err.message.substring(0, 100));
          console.log(`  [CWJobs Bot] Page issue — skipping: ${job.title} (${err.message})`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', error: err.message });
          logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
          console.error(`  [CWJobs Bot] Error applying to "${job.title}": ${err.message}`);
        }
      }

      const pause = 8000 + Math.random() * 7000;
      console.log(`  [CWJobs Bot] Pausing ${Math.round(pause / 1000)}s before next application...`);
      await DELAY(pause);
    }

    if (readyJobs.length > 0) {
      idleCount = 0;
    } else if (pendingJobs > 0) {
      idleCount = 0;
      try { queue.printStatus(); } catch (_) {}
      console.log(`  [CWJobs Bot] Waiting for Scorer bot... (${pendingJobs} CWJobs job(s) in progress)`);
    } else {
      idleCount++;
      console.log(`  [CWJobs Bot] Idle ${idleCount}/${MAX_IDLE} — no pending or ready CWJobs jobs`);
    }

    if (idleCount >= MAX_IDLE) break;
    await DELAY(POLL_INTERVAL);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  CWJobs Bot — Starting (continuous mode)');
  console.log('═══════════════════════════════════════════════════════');

  const stuckApplying = queue.getByStatus('applying').filter(j => j.source === 'cwjobs');
  if (stuckApplying.length > 0) {
    console.log(`  [CWJobs Bot] Recovering ${stuckApplying.length} interrupted job(s) → cv_ready`);
    for (const j of stuckApplying) queue.update(j.jobId, { status: 'cv_ready' });
  }

  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'cwjobs_profile');
  const cdpPort = process.env.JOBBOT_CDP_PORT;
  const context = cdpPort
    ? await connectToRunningChrome(parseInt(cdpPort)).catch(() => launchPersistentContext(profileDir))
    : await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);

  let page = await context.newPage();
  try {
    await ensureLoggedIn(page);
  } catch (err) {
    console.error('ERROR: ' + err.message);
    await context.close().catch(() => {});
    process.exit(1);
  }

  while (true) {
    page = await phase1_searchAndQueue(context, page);
    await phase2_applyReadyCVs(page);
    logger.printSummary();
    console.log('\n  [CWJobs Bot] Cycle complete. Waiting 1 min before next search...');
    await DELAY(60 * 1000);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
