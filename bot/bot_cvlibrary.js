/**
 * CV-Library Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search cv-library.co.uk for matching jobs, extract JDs, add to
 *            queue.db (source: 'cvlibrary') with status "pending".
 * Phase 2 — Poll queue. When Scorer sets a cvlibrary job to "cv_ready",
 *            submit the application via CV-Library Quick Apply.
 */

const { chromium } = require('playwright');
const cfg    = require('./config');
const queue  = require('./modules/queue_manager');
const logger = require('./modules/logger');
const salary = require('./modules/salary_filter');
const stealth = require('./modules/stealth');
const path   = require('path');
const fs     = require('fs');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;
const MAX_IDLE      = 6;
const SESSION_FILE  = cfg.SESSION_FILE?.replace('reed_session', 'cvlibrary_session')
  || path.join(require('path').dirname(cfg.SESSION_FILE || '/tmp/x'), 'cvlibrary_session.json');

const BASE_URL = 'https://www.cv-library.co.uk';

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

// ── Login ─────────────────────────────────────────────────────────────────
async function ensureLoggedIn(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await DELAY(1500);

  // Already logged in?
  if (page.url().includes('/dashboard') || page.url().includes('/my-cv-library')) {
    console.log('  [CV-Library Bot] Session still valid');
    return;
  }

  console.log('  [CV-Library Bot] Logging in...');
  await page.fill('input[name="email"], input[type="email"]', process.env.CVLIB_EMAIL || '');
  await page.fill('input[name="password"], input[type="password"]', process.env.CVLIB_PASS || '');
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForLoadState('domcontentloaded');
  await DELAY(2000);

  if (page.url().includes('login')) {
    throw new Error('CV-Library login failed — check credentials in Job Site Login');
  }
  console.log('  [CV-Library Bot] Logged in successfully');
}

// ── Phase 1: Search & queue ───────────────────────────────────────────────
async function phase1_searchAndQueue(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [CV-Library Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [CV-Library Bot] Searching: "${searchTerm}"`);

    const minSalary = (() => {
      if (!cfg.APPLICANT.salaryExpectation) return '';
      const m = String(cfg.APPLICANT.salaryExpectation).replace(/[^0-9]/g, '');
      return m ? `&minsalary=${m}` : '';
    })();

    const searchUrl = `${BASE_URL}/search-jobs?q=${encodeURIComponent(searchTerm)}&distance=50&salarytype=annual${minSalary}&tempperm=Permanent&us=1`;

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await DELAY(2000);
    } catch (err) {
      console.error(`  [CV-Library Bot] Failed to load search page: ${err.message}`);
      continue;
    }

    // Collect job cards from the results page
    const jobLinks = await page.$$eval(
      'article.job-result a[href*="/jobs/"], .job-result__title a, .results-jobs a.job-result__title',
      els => els.map(el => ({
        url: el.href,
        title: el.textContent.trim(),
      }))
    );

    if (!jobLinks.length) {
      console.log(`  [CV-Library Bot] No results for "${searchTerm}"`);
      continue;
    }

    console.log(`  [CV-Library Bot] Found ${jobLinks.length} listings`);

    for (const link of jobLinks.slice(0, cfg.MAX_JOBS_PER_SEARCH)) {
      const jobId = `cvlib_${link.url.replace(/[^a-z0-9]/gi, '_').slice(-40)}`;

      if (queue.has(jobId)) { console.log(`  [CV-Library Bot] Already queued: ${link.title}`); continue; }
      if (queue.wasApplied(jobId)) { console.log(`  [CV-Library Bot] Already applied — skipping: ${link.title}`); continue; }
      if (!isRelevantTitle(link.title)) { console.log(`  [CV-Library Bot] Title filter — skipping: ${link.title}`); continue; }

      try {
        await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await DELAY(1500);

        const company = await page.$eval(
          '.job-header__company, .job-details__company, [class*="company"]',
          el => el.textContent.trim()
        ).catch(() => '');

        if (isBlockedCompany(company)) {
          console.log(`  [CV-Library Bot] Company blocked — skipping: ${link.title} @ ${company}`);
          continue;
        }

        if (queue.wasAppliedToCompanyRecently(company)) {
          console.log(`  [CV-Library Bot] Applied to ${company} in last 30 days — skipping: ${link.title}`);
          continue;
        }

        if (queue.hasCanonical(link.title, company)) {
          console.log(`  [CV-Library Bot] Duplicate (cross-site) — skipping: ${link.title} @ ${company}`);
          continue;
        }

        // Check for Quick Apply button
        const hasQuickApply = await page.$('button[data-action*="apply"], a[href*="/apply/"], .apply-button, button:has-text("Apply"), a:has-text("Quick Apply")').catch(() => null);
        if (!hasQuickApply) {
          console.log(`  [CV-Library Bot] No apply button — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cvlibrary', status: 'skipped', reason: 'No quick apply' });
          continue;
        }

        // Check for external redirect
        const applyHref = await page.$eval(
          'a[href*="/apply/"], a:has-text("Apply Now")',
          el => el.href
        ).catch(() => '');
        if (applyHref && !applyHref.includes('cv-library.co.uk')) {
          console.log(`  [CV-Library Bot] External site — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cvlibrary', status: 'skipped', reason: 'External site' });
          continue;
        }

        const description = await page.$eval(
          '.job-description, .job-details__description, [class*="description"]',
          el => el.innerText
        ).catch(() => '');

        if (!description || description.trim().split(/\s+/).length < 80) {
          console.log(`  [CV-Library Bot] Short/missing JD — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cvlibrary', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship) {
          if (!/visa sponsor|sponsorship|skilled worker|tier 2|work permit/i.test(description)) {
            console.log(`  [CV-Library Bot] No sponsorship — skipping: ${link.title}`);
            queue.add({ jobId, title: link.title, company, url: link.url, source: 'cvlibrary', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }

        if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(description);
          console.log(`  [CV-Library Bot] Below salary expectation (${min ? '£' + min.toLocaleString() : 'stated'}) — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cvlibrary', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        const workType = detectWorkType(description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [CV-Library Bot] Work type "${workType}" not wanted — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cvlibrary', status: 'skipped', reason: `Work type (${workType}) not wanted` });
          continue;
        }

        queue.add({ jobId, title: link.title, company, url: link.url, description, source: 'cvlibrary', workType });
        console.log(`  [CV-Library Bot] → Queued for Scorer: ${link.title} @ ${company} [${workType}]`);
      } catch (err) {
        console.error(`  [CV-Library Bot] Error on "${link.title}": ${err.message}`);
      }

      await DELAY(2000);
    }
  }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'cvlibrary').length;
  console.log(`\n  [CV-Library Bot] Phase 1 complete. ${pending} CV-Library job(s) queued for Scorer.`);
}

// ── Phase 2: Apply ────────────────────────────────────────────────────────
async function phase2_applyReadyCVs(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [CV-Library Bot] Phase 2 — Waiting for Scorer bot...');
  console.log('══════════════════════════════════════════════════════');

  const retried = queue.requeueFailed('cvlibrary');
  if (retried > 0) console.log(`  [CV-Library Bot] Requeueing ${retried} previously-failed job(s) for retry.`);

  const priority = workTypePriority();
  let idleCount = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'cvlibrary')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));

    const pendingCount = [
      ...queue.getByStatus('pending').filter(j => j.source === 'cvlibrary'),
      ...queue.getByStatus('processing').filter(j => j.source === 'cvlibrary'),
    ].length;

    if (!readyJobs.length && !pendingCount) {
      idleCount++;
      if (idleCount >= MAX_IDLE) {
        console.log('  [CV-Library Bot] Queue exhausted — stopping.');
        break;
      }
      console.log(`  [CV-Library Bot] Waiting for Scorer... (${idleCount}/${MAX_IDLE})`);
      await DELAY(POLL_INTERVAL);
      continue;
    }
    idleCount = 0;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [CV-Library Bot] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — stopping.`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [CV-Library Bot] Applying: ${job.title} @ ${job.company} (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await DELAY(2000);

        // Click Apply / Quick Apply
        const applyBtn = await page.$('a:has-text("Quick Apply"), button:has-text("Apply Now"), a:has-text("Apply Now"), .apply-button');
        if (!applyBtn) {
          queue.update(job.jobId, { status: 'skipped', reason: 'Apply button not found' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'No apply button');
          console.log(`  [CV-Library Bot] Apply button gone — skipping: ${job.title}`);
          continue;
        }

        await applyBtn.click();
        await DELAY(2000);

        // Fill cover letter if present
        const clField = await page.$('textarea[name*="cover"], textarea[name*="letter"], textarea[id*="cover"]');
        if (clField && job.coverLetter) {
          await clField.fill(job.coverLetter);
        }

        // Submit
        const submitBtn = await page.$('button[type="submit"]:has-text("Apply"), button[type="submit"]:has-text("Submit"), input[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await DELAY(3000);
        }

        // Check for confirmation
        const pageText = await page.textContent('body').catch(() => '');
        const success = /thank you|application (sent|received|submitted)|successfully applied/i.test(pageText);

        if (success) {
          queue.update(job.jobId, { status: 'applied' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'APPLIED', '');
          console.log(`  [CV-Library Bot] ✓ Applied: ${job.title} @ ${job.company}`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', reason: 'No confirmation detected' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'FAILED', 'No confirmation');
          console.log(`  [CV-Library Bot] No confirmation — marking failed: ${job.title}`);
        }
      } catch (err) {
        queue.update(job.jobId, { status: 'apply_failed', reason: err.message });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'FAILED', err.message);
        console.error(`  [CV-Library Bot] Error applying to "${job.title}": ${err.message}`);
      }

      await DELAY(3000);
    }

    if (!readyJobs.length) await DELAY(POLL_INTERVAL);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  await stealth.applyToContext(context);

  // Restore session if available
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      await context.addCookies(cookies);
      console.log('  [CV-Library Bot] Restored previous session');
    } catch (_) {}
  }

  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);

    // Save session
    const cookies = await context.cookies();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies), 'utf8');

    await phase1_searchAndQueue(page);
    await phase2_applyReadyCVs(page);
  } catch (err) {
    console.error(`  [CV-Library Bot] Fatal error: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
