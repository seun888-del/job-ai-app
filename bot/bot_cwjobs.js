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
const stealth = require('./modules/stealth');
const browser_launcher = require('./modules/browser_launcher');
const path    = require('path');

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
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await DELAY(2000 + Math.random() * 1000);

  // Already logged in?
  const loggedInEl = await page.$('a[href*="my-account"], a[href*="profile"], [data-testid="user-nav"], .user-nav, button[aria-label*="account"]').catch(() => null);
  if (loggedInEl) {
    console.log('  [CWJobs Bot] Session still valid');
    return;
  }

  // Click the site's own Sign In link
  const signInLink = await page.$('a[href*="login"], a[href*="sign-in"], a:has-text("Sign in"), a:has-text("Log in")').catch(() => null);
  if (signInLink) {
    await signInLink.click();
    await page.waitForLoadState('domcontentloaded');
    await DELAY(1500 + Math.random() * 500);
  }

  // Pre-fill email with human-like typing then wait for user to enter password
  try {
    const emailEl = page.locator('#email, input[name="email"], input[type="email"]').first();
    if (await emailEl.isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailEl.click();
      await DELAY(400 + Math.random() * 300);
      await emailEl.pressSequentially(process.env.CWJOBS_EMAIL || '', { delay: 55 + Math.random() * 65 });
    }
  } catch (_) {}

  console.log('  [CWJobs Bot] ⏳ Please enter your password and sign in (up to 5 minutes)...');

  const deadline = Date.now() + 300000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const u = page.url();
    if (!u.includes('cwjobs.co.uk') || (!u.includes('login') && !u.includes('sign-in') && !u.includes('register'))) {
      loggedIn = true; break;
    }
    await DELAY(3000);
  }

  if (!loggedIn) throw new Error('CWJobs login timed out — check credentials in Job Site Login');
  console.log('  [CWJobs Bot] Logged in successfully');
}

// ── Phase 1: Search & queue ───────────────────────────────────────────────
async function phase1_searchAndQueue(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [CWJobs Bot] Phase 1 — Searching for jobs');
  console.log('══════════════════════════════════════════════════════');

  for (const searchTerm of cfg.JOB_SEARCHES) {
    console.log(`\n  [CWJobs Bot] Searching: "${searchTerm}"`);

    const minSalary = (() => {
      if (!cfg.APPLICANT.salaryExpectation) return '';
      const m = String(cfg.APPLICANT.salaryExpectation).replace(/[^0-9]/g, '');
      return m ? `&salary=${m}` : '';
    })();

    const searchUrl = `${BASE_URL}/jobs/${encodeURIComponent(searchTerm)}?salarytype=annual${minSalary}&distance=20&postedWithin=14`;

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await DELAY(2000);
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

        if (queue.wasAppliedToCompanyRecently(company)) {
          console.log(`  [CWJobs Bot] Applied to ${company} recently — skipping: ${link.title}`);
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

        if (cfg.APPLICANT.seekSponsorship) {
          if (!/visa sponsor|sponsorship|skilled worker|tier 2|work permit/i.test(description)) {
            console.log(`  [CWJobs Bot] No sponsorship — skipping: ${link.title}`);
            queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'No sponsorship offered' });
            continue;
          }
        }

        if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) {
          console.log(`  [CWJobs Bot] Below salary expectation — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: 'Below salary expectation' });
          continue;
        }

        const workType = detectWorkType(description);
        if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
          console.log(`  [CWJobs Bot] Work type "${workType}" not wanted — skipping: ${link.title}`);
          queue.add({ jobId, title: link.title, company, url: link.url, source: 'cwjobs', status: 'skipped', reason: `Work type (${workType}) not wanted` });
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

    const pendingCount = [
      ...queue.getByStatus('pending').filter(j => j.source === 'cwjobs'),
      ...queue.getByStatus('processing').filter(j => j.source === 'cwjobs'),
    ].length;

    if (!readyJobs.length && !pendingCount) {
      idleCount++;
      if (idleCount >= MAX_IDLE) { console.log('  [CWJobs Bot] Queue exhausted — stopping.'); break; }
      console.log(`  [CWJobs Bot] Waiting for Scorer... (${idleCount}/${MAX_IDLE})`);
      await DELAY(POLL_INTERVAL);
      continue;
    }
    idleCount = 0;

    for (const job of readyJobs) {
      if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [CWJobs Bot] Daily limit reached — stopping.`);
        return;
      }

      if (!isRelevantTitle(job.title)) {
        queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'Title filter');
        continue;
      }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`\n  [CWJobs Bot] Applying: ${job.title} @ ${job.company} (CV: ${job.cvName}, Score: ${job.cvScore}%)`);

      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await DELAY(2000);

        const applyBtn = await page.$('[data-at="apply-button"], a.apply-button, button.apply-button, a:has-text("Apply Now"), button:has-text("Apply Now"), a:has-text("Quick Apply")');
        if (!applyBtn) {
          queue.update(job.jobId, { status: 'skipped', reason: 'Apply button not found' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'SKIPPED', 'No apply button');
          continue;
        }

        await applyBtn.click();
        await DELAY(2000);

        const clField = await page.$('textarea[name*="cover"], textarea[name*="letter"], textarea[id*="cover"], textarea[placeholder*="cover"]');
        if (clField && job.coverLetter) await clField.fill(job.coverLetter);

        const submitBtn = await page.$('button[type="submit"]:has-text("Apply"), button[type="submit"]:has-text("Submit"), button[data-at="submit-application"], input[type="submit"]');
        if (submitBtn) { await submitBtn.click(); await DELAY(3000); }

        const pageText = await page.textContent('body').catch(() => '');
        const success = /thank you|application (sent|received|submitted)|successfully applied|we.*received your/i.test(pageText);

        if (success) {
          queue.update(job.jobId, { status: 'applied' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'APPLIED', '');
          console.log(`  [CWJobs Bot] ✓ Applied: ${job.title} @ ${job.company}`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed', reason: 'No confirmation detected' });
          logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'FAILED', 'No confirmation');
          console.log(`  [CWJobs Bot] No confirmation — marking failed: ${job.title}`);
        }
      } catch (err) {
        queue.update(job.jobId, { status: 'apply_failed', reason: err.message });
        logger.log(job.title, job.company, job.url, job.cvName || 'N/A', job.cvScore || 0, 'FAILED', err.message);
        console.error(`  [CWJobs Bot] Error applying to "${job.title}": ${err.message}`);
      }

      await DELAY(3000);
    }

    if (!readyJobs.length) await DELAY(POLL_INTERVAL);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'cwjobs_profile');
  const context = await browser_launcher.launchPersistentContext(profileDir);
  await stealth.applyToContext(context);

  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);
    await phase1_searchAndQueue(page);
    await phase2_applyReadyCVs(page);
  } catch (err) {
    console.error(`  [CWJobs Bot] Fatal error: ${err.message}`);
    process.exit(1);
  } finally {
    await context.close();
  }
})();
