/**
 * CV-Library Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — Search cv-library.co.uk for matching jobs, extract JDs, add to
 *            queue.db (source: 'cvlibrary') with status "pending".
 * Phase 2 — Poll queue. When Scorer sets a cvlibrary job to "cv_ready",
 *            submit the application via CV-Library Quick Apply.
 */

const cfg     = require('./config');
const queue   = require('./modules/queue_manager');
const logger  = require('./modules/logger');
const salary  = require('./modules/salary_filter');
const stealth = require('./modules/stealth');
const { launchPersistentContext, humanWarmup, waitForCloudflareSolve } = require('./modules/browser_launcher');
const path    = require('path');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;
const MAX_IDLE      = 6;

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
  await page.goto('https://www.cv-library.co.uk/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await DELAY(2000);
  const isLoggedIn = await page.evaluate(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    return text.includes('my dashboard') || text.includes('my profile') ||
           text.includes('saved jobs') || text.includes('sign out') ||
           text.includes('log out') || text.includes('my cv');
  }).catch(() => false);
  if (!isLoggedIn) {
    throw new Error('CV-Library: not logged in. Go to Job Site Login → click Connect CV-Library Account → log in → close the Chrome window → then start this bot.');
  }
  console.log('  [CV-Library Bot] Session active');
}

// Accept the OneTrust cookie consent banner if visible (new Next.js site)
async function acceptCookies(page) {
  try {
    const btn = await page.$('button:has-text("Accept All"), #onetrust-accept-btn-handler');
    if (btn && await btn.isVisible()) { await btn.click(); await DELAY(800); }
  } catch (_) {}
}

// ── Phase 1: Search & queue ───────────────────────────────────────────────
async function phase1_searchAndQueue(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [CV-Library Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  let cookiesAccepted = false;

  // Warm up on the homepage first so navigation looks human (not cold-jumping to /search-jobs)
  console.log('  [CV-Library Bot] Warming up on homepage...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await acceptCookies(page);
  cookiesAccepted = true;
  await humanWarmup(page);
  await DELAY(2000 + Math.random() * 1500);

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [CV-Library Bot] Searching: "${searchTerm}"`);

    try {
      // CV-Library's new Next.js site requires using the search form, not query params
      await page.goto(`${BASE_URL}/search-jobs`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const passed = await waitForCloudflareSolve(page);
      if (!passed) {
        console.error('');
        console.error('  ════════════════════════════════════════════════════');
        console.error('  [CV-Library Bot] IP BLOCKED by CV-Library security.');
        console.error('  This is a temporary block on your IP address.');
        console.error('  DO NOT restart the bot — every attempt extends the block.');
        console.error('  Wait 24–48 hours, then try again.');
        console.error('  Reference: see "Blocked" page in the browser window.');
        console.error('  ════════════════════════════════════════════════════');
        console.error('');
        return; // stop entirely — don't keep hitting the blocked endpoint
      }

      if (!cookiesAccepted) { await acceptCookies(page); cookiesAccepted = true; } // fallback in case homepage didn't catch it

      await page.fill('input[name="keyword"]', searchTerm);
      await DELAY(400);
      await page.press('input[name="keyword"]', 'Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
      await waitForCloudflareSolve(page);
      await humanWarmup(page);
      await DELAY(2500);
    } catch (err) {
      console.error(`  [CV-Library Bot] Failed to load search for "${searchTerm}": ${err.message}`);
      continue;
    }

    // Extract job cards using the new Next.js card structure
    const jobCards = await page.evaluate((limit) => {
      const cards = Array.from(document.querySelectorAll('[class*="Card_card__"]'))
        .filter(c => c.querySelector('[data-qa="type-apply-now"]'));
      return cards.slice(0, limit).map(card => {
        const applyEl = card.querySelector('[data-qa="type-apply-now"]');
        const titleEl = card.querySelector('[class*="JobCard_titleText__"], [class*="JobCard_title__"] a, h2 a, h3 a');
        const companyEl = card.querySelector('[class*="JobCard_company__"]');
        const jobId = (applyEl?.getAttribute('href') || '').match(/\/apply\/(\d+)/)?.[1] || '';
        return {
          title: (titleEl?.innerText || '').trim(),
          url: titleEl?.closest('a')?.href || titleEl?.href || '',
          company: (companyEl?.innerText || '').trim(),
          applyUrl: applyEl?.href || '',
          jobId: 'cvlib_' + jobId,
        };
      }).filter(j => j.jobId !== 'cvlib_' && j.title && j.url);
    }, cfg.MAX_JOBS_PER_SEARCH).catch(() => []);

    if (!jobCards.length) {
      console.log(`  [CV-Library Bot] No results for "${searchTerm}"`);
      continue;
    }
    console.log(`  [CV-Library Bot] Found ${jobCards.length} listings`);

    for (const card of jobCards) {
      const { jobId, title, url, company, applyUrl } = card;

      if (queue.has(jobId)) { console.log(`  [CV-Library Bot] Already queued: ${title}`); continue; }
      if (queue.wasApplied(jobId)) { console.log(`  [CV-Library Bot] Already applied — skipping: ${title}`); continue; }
      if (!isRelevantTitle(title)) { console.log(`  [CV-Library Bot] Title filter — skipping: ${title}`); continue; }
      if (isBlockedCompany(company)) { console.log(`  [CV-Library Bot] Company blocked — skipping: ${title} @ ${company}`); continue; }
      if (queue.wasAppliedToCompanyRecently(company)) { console.log(`  [CV-Library Bot] Applied to ${company} in last 30 days — skipping: ${title}`); continue; }
      if (queue.hasCanonical(title, company)) { console.log(`  [CV-Library Bot] Duplicate (cross-site) — skipping: ${title} @ ${company}`); continue; }

      // Skip if apply URL points to an external site
      if (applyUrl && !applyUrl.includes('cv-library.co.uk')) {
        console.log(`  [CV-Library Bot] External site — skipping: ${title}`);
        queue.add({ jobId, title, company, url, source: 'cvlibrary', status: 'skipped', reason: 'External site' });
        continue;
      }

      try {
        // Navigate to job detail page for description
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForCloudflareSolve(page);
        await DELAY(1500);

        const description = await page.evaluate(() => {
          const descEl = document.querySelector(
            '[class*="JobView_jobDescription__"], [class*="JobDescription_description__"], [class*="job-description"]'
          ) || document.querySelector('main');
          return descEl ? descEl.innerText.trim() : '';
        }).catch(() => '');

        if (!description || description.trim().split(/\s+/).length < 80) {
          console.log(`  [CV-Library Bot] Short/missing JD — skipping: ${title}`);
          queue.add({ jobId, title, company, url, source: 'cvlibrary', status: 'skipped', reason: 'JD too short or missing' });
          continue;
        }

        if (cfg.APPLICANT.seekSponsorship) {
          if (!/visa sponsor|sponsorship|skilled worker|tier 2|work permit/i.test(description)) {
            console.log(`  [CV-Library Bot] No sponsorship — skipping: ${title}`);
            queue.add({ jobId, title, company, url, source: 'cvlibrary', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }

        if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) {
          const min = salary.extractMinSalary(description);
          console.log(`  [CV-Library Bot] Below salary (${min ? '£' + min.toLocaleString() : '?'}) — skipping: ${title}`);
          queue.add({ jobId, title, company, url, source: 'cvlibrary', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        const workType = detectWorkType(description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [CV-Library Bot] Work type "${workType}" not wanted — skipping: ${title}`);
          queue.add({ jobId, title, company, url, source: 'cvlibrary', status: 'skipped', reason: `Work type (${workType}) not wanted` });
          continue;
        }

        queue.add({ jobId, title, company, url, description, source: 'cvlibrary', workType });
        console.log(`  [CV-Library Bot] → Queued for Scorer: ${title} @ ${company} [${workType}]`);
      } catch (err) {
        console.error(`  [CV-Library Bot] Error on "${title}": ${err.message}`);
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

  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'cvlibrary_profile');
  const context = await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);

  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);
    await phase1_searchAndQueue(page);
    await phase2_applyReadyCVs(page);
  } catch (err) {
    console.error(`  [CV-Library Bot] Fatal error: ${err.message}`);
    process.exit(1);
  } finally {
    await context.close();
  }
})();
