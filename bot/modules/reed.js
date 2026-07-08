const cfg       = require('../config');
const fs        = require('fs');
const stealth   = require('./stealth');
const captcha   = require('./captcha_solver');
const salary    = require('./salary_filter');
const queue     = require('./queue_manager');
const atsFiller = require('./ats_filler');
const ai        = require('./question_ai'); // LLM fallback for unknown screening questions
const cvValidate = require('./cv_validate'); // reject corrupt/empty CVs before attaching

const SSDIR        = cfg.SCREENSHOTS_DIR;
const SESSION_FILE = cfg.SESSION_FILE;
const DELAY        = ms => new Promise(r => setTimeout(r, ms));

// ── LOGIN ──────────────────────────────────────────────────────────────────
// Uses a saved session file so the user only needs to log in once.
// On first run (or if session expired): opens login page, waits for manual login, saves session.
// On subsequent runs: loads saved cookies and skips the login page entirely.
async function login(browser, email, password) {
  // Try loading a saved session first
  let context;
  if (fs.existsSync(SESSION_FILE)) {
    console.log('  [Reed] Loading saved session...');
    try {
      context = await browser.newContext({ storageState: SESSION_FILE });
    } catch (_) {
      context = await browser.newContext();
    }
  } else {
    context = await browser.newContext();
  }

  await stealth.applyToContext(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Check if saved session is still valid by visiting reed.co.uk
  if (fs.existsSync(SESSION_FILE)) {
    await page.goto('https://www.reed.co.uk', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await DELAY(2000);
    const isLoggedIn = await page.evaluate(() => {
      const text = (document.body.innerText || '').toLowerCase();
      // Logged-in indicators: profile link, "my reed", account menu
      return text.includes('my reed') || text.includes('sign out') || text.includes('log out') ||
             !!document.querySelector('[href*="/my-reed"], [href*="/account"], [data-testid*="account"]');
    });
    if (isLoggedIn) {
      console.log('  [Reed] ✓ Session restored — already logged in.');
      return page;
    }
    console.log('  [Reed] Saved session expired — need to log in again.');
  }

  // Session missing or expired — auto-fill credentials and submit
  console.log('  [Reed] Opening login page...');
  await page.goto('https://secure.reed.co.uk/login', { waitUntil: 'load', timeout: 60000 });
  await DELAY(3000);

  // Auto-fill email
  try {
    const emailEl = await page.$('input[name="username"], input[id="username"], input[type="email"], input[name="email"]');
    if (emailEl && await emailEl.isVisible()) {
      await emailEl.click();
      await DELAY(300);
      await emailEl.fill(email);
      console.log('  [Reed] Email filled.');
    }
  } catch (_) {}

  // Auto-fill password and submit
  try {
    const passEl = await page.$('input[name="password"], input[type="password"]');
    if (passEl && await passEl.isVisible()) {
      await passEl.click();
      await DELAY(300);
      await passEl.fill(password);
      console.log('  [Reed] Password filled.');
      await DELAY(500);
      await passEl.press('Enter');
    }
  } catch (_) {}

  await DELAY(4000);
  console.log('  [Reed] Waiting for login (up to 5 minutes — complete any CAPTCHA in the browser)...');

  let loggedIn = false;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const u = page.url();
    if (u.startsWith('https://www.reed.co.uk') && !u.includes('/login') && !u.includes('/authentication')) {
      const authenticated = await page.evaluate(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return text.includes('my reed') || text.includes('sign out') || text.includes('log out') ||
               !!document.querySelector('[href*="/my-reed"], [href*="/account"], [data-testid*="account"]');
      }).catch(() => false);
      if (authenticated) { loggedIn = true; break; }
    }
    await captcha.autoSolve(page).catch(() => {});
    await DELAY(4000);
  }

  if (!loggedIn) throw new Error('Reed login timed out — check credentials or complete the CAPTCHA.');

  await context.storageState({ path: SESSION_FILE });
  console.log('  [Reed] ✓ Logged in. Session saved — next run will skip login.');
  return page;
}

// ── ENSURE LOGGED IN ──────────────────────────────────────────────────────
async function ensureLoggedIn(page) {
  await page.goto('https://www.reed.co.uk', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(2000);

  // HTTP 431 means cookie headers are too large — clear all cookies and retry
  const status = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    return bodyText.includes('HTTP ERROR 431') ? 431 : 0;
  }).catch(() => 0);

  if (status === 431) {
    console.log('  [Reed] HTTP 431 (cookie headers too large) — clearing cookies and retrying...');
    await page.context().clearCookies();
    await page.goto('https://www.reed.co.uk', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await DELAY(2000);
  }

  const isLoggedIn = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase();
    return t.includes('my reed') || t.includes('sign out') || t.includes('log out') ||
           !!document.querySelector('[href*="/my-reed"], [href*="/account"]');
  }).catch(() => false);
  if (!isLoggedIn) throw new Error('Reed: not logged in. Click "Connect account" on the Reed bot card first.');
  console.log('  [Reed] Session active');
}

// ── SEARCH JOBS ────────────────────────────────────────────────────────────
async function searchJobs(context, page, searchTerm, limit = 25, remoteOnly = false) {
  if (page.isClosed()) {
    console.log('  [Reed] Page was closed — opening new tab');
    page = await context.newPage();
    page.setDefaultTimeout(30000);
  }

  const encoded = encodeURIComponent(searchTerm);
  const REED_AGE = { r86400: 'LastDay', r259200: 'LastThreeDays', r604800: 'LastWeek', r1209600: 'LastTwoWeeks', r2592000: 'LastMonth' };
  const ageParam = cfg.JOB_AGE && cfg.JOB_AGE !== 'any' ? `&datecreatedoffset=${REED_AGE[cfg.JOB_AGE] || 'LastTwoWeeks'}` : '';
  const baseUrl  = `https://www.reed.co.uk/jobs?keywords=${encoded}&sortby=DisplayDate${ageParam}`;

  console.log(`\n  [Reed] Searching: "${searchTerm}"`);

  const allJobs  = [];
  let pageNo     = 1;
  let cookieDone = false;

  while (allJobs.length < limit) {
    const url = pageNo === 1 ? baseUrl : `${baseUrl}&pageno=${pageNo}`;

    // domcontentloaded is enough — Reed jobs are server-rendered in the initial HTML
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Handle HTTP 431 (cookie headers too large)
    const is431 = await page.evaluate(() => (document.body?.innerText || '').includes('HTTP ERROR 431')).catch(() => false);
    if (is431) {
      console.log('  [Reed] HTTP 431 — clearing cookies and reloading...');
      await page.context().clearCookies();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    // Dismiss cookie banner once — don't block if it never appears
    if (!cookieDone) {
      await page.click('#onetrust-accept-btn-handler, button:has-text("Accept all"), button:has-text("Accept cookies")', { timeout: 3000 }).catch(() => {});
      cookieDone = true;
    }

    // Wait for cards or a "no results" indicator — avoids fixed sleep
    await page.waitForSelector(
      'article[data-id], [data-gtm-class="job-listing"], [data-testid="job-card"], .no-results, [class*="no-result"]',
      { timeout: 12000 }
    ).catch(() => {});

    if (pageNo === 1) {
      await page.screenshot({ path: `${SSDIR}/reed_search_results.png` });
      console.log(`  [Reed] URL: ${page.url()}`);
    }

    const pageJobs = await page.evaluate(() => {
      // Reed's primary card selector — numeric data-id is always present
      let cards = Array.from(document.querySelectorAll('article[data-id]'));
      if (cards.length === 0) {
        for (const sel of ['[data-gtm-class="job-listing"]', '[data-testid="job-card"]', '.job-result']) {
          cards = Array.from(document.querySelectorAll(sel));
          if (cards.length > 0) break;
        }
      }

      return cards.map(card => {
        const dataId  = card.getAttribute('data-id') || '';
        const titleEl = card.querySelector('h2 a, h3 a, [class*="title"] a, [data-testid="job-title"] a');
        const href    = titleEl?.getAttribute('href') || card.querySelector('a[href*="/jobs/"]')?.getAttribute('href') || '';
        const idFromHref = href.match(/\/(\d+)\/?(?:[?#]|$)/)?.[1] || '';

        // Reed shows company as "X days ago by CompanyName" — extract after "by "
        // Also try class-based selectors as backup
        let company = '';
        const companyEl = card.querySelector(
          '[data-qa="employer-name"], [data-testid="employer-name"], a[data-gtm="employer"], ' +
          'a[data-gtm="company"], .recruiter, .employer, [class*="employer"], ' +
          'a[href*="/employers/"], .gtmJobListingPostedBy'
        );
        if (companyEl) {
          company = companyEl.innerText.replace(/\s+/g, ' ').trim();
        }
        if (!company) {
          // Parse "X days ago by CompanyName" from card text
          const cardText = card.innerText || '';
          const m = cardText.match(/\bby\s+([^\n\r]+)/i);
          if (m) company = m[1].trim().split(/\s{2,}/)[0].trim();
        }

        return {
          jobId:   'reed_' + (dataId || idFromHref),
          title:   (titleEl?.innerText || '').trim() || 'Unknown',
          company: company || 'Unknown',
          url:     href ? (href.startsWith('http') ? href : 'https://www.reed.co.uk' + href) : '',
        };
      }).filter(j => j.url && j.jobId !== 'reed_');
    });

    if (pageJobs.length === 0) {
      console.log(`  [Reed] Page ${pageNo}: no cards — end of results`);
      break;
    }
    console.log(`  [Reed] Page ${pageNo}: ${pageJobs.length} cards`);
    allJobs.push(...pageJobs);
    pageNo++;
    // Reed pages hold ~25 jobs; fewer than 15 means we're on the last page
    if (pageJobs.length < 15) break;
    await DELAY(1500);
  }

  const jobs = allJobs.slice(0, limit);
  console.log(`  [Reed] Found ${jobs.length} jobs for "${searchTerm}" (${pageNo - 1} page(s))`);
  return { jobs, page };
}

// ── GET JOB DESCRIPTION ────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  // 'load' waits for scripts but not for tracking pixels/XHR — much faster than
  // networkidle, and more reliable than domcontentloaded for JS-rendered content
  await page.goto(job.url, { waitUntil: 'load', timeout: 60000 });

  // Handle HTTP 431
  const is431 = await page.evaluate(() => (document.body?.innerText || '').includes('HTTP ERROR 431')).catch(() => false);
  if (is431) {
    console.log('  [Reed] HTTP 431 on job page — clearing cookies and reloading...');
    await page.context().clearCookies();
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  // Wait for the JD container to be in the DOM, then a short buffer for late JS
  await page.waitForSelector(
    '#jobDescriptionContainerDivId, [data-qa="job-description"], [itemprop="description"], .job-description',
    { timeout: 15000 }
  ).catch(() => {});
  await DELAY(800);

  // Single evaluate — one DOM round-trip extracts JD text + all signal flags
  const result = await page.evaluate(() => {
    // ── Job description ──────────────────────────────────────────────────
    // Strategy 1: known class/ID selectors
    const descSelectors = [
      '#jobDescriptionContainerDivId',
      '[data-qa="job-description"]',
      '[itemprop="description"]',
      '.job-description',
      '[data-testid="job-description"]',
      '[data-testid="job-description-container"]',
      '.job-description-copy',
      '[class*="description"]',
    ];
    let description = '';
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 80) { description = el.innerText.trim(); break; }
    }

    // Strategy 2: find "Full job description" heading and grab its parent/sibling
    // Reed currently renders JD under a "Full job description" <h2>
    if (!description) {
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, strong, b'));
      for (const h of headings) {
        if (/full job description|job description/i.test(h.innerText || '')) {
          // Try parent container first (heading + content share a parent)
          const parent = h.parentElement;
          const parentText = (parent?.innerText || '').trim();
          if (parentText.length > 200) { description = parentText.substring(0, 10000); break; }
          // Try next siblings
          let sib = h.nextElementSibling;
          const parts = [];
          while (sib && parts.join(' ').length < 10000) {
            const t = sib.innerText.trim();
            if (t) parts.push(t);
            sib = sib.nextElementSibling;
          }
          if (parts.join(' ').length > 100) { description = parts.join('\n').substring(0, 10000); break; }
        }
      }
    }

    // Strategy 3: longest text block on the page (no children count restriction)
    if (!description) {
      const blocks = Array.from(document.querySelectorAll('div, section, article'))
        .map(el => el.innerText.trim())
        .filter(t => t.length > 200);
      blocks.sort((a, b) => b.length - a.length);
      description = blocks[0]?.substring(0, 10000) ||
        document.querySelector('main, [role="main"]')?.innerText.trim().substring(0, 10000) || '';
    }

    // ── Training course: Reed marks these in the salary metadata element ─
    const bodyLower = (document.body.innerText || '').toLowerCase();
    const salaryEl = document.querySelector('[data-qa="salary"], [class*="salary"], [class*="compensation"]');
    const salaryText = (salaryEl?.innerText || '').toLowerCase();
    const isTrainingCourse = salaryText.includes('training') || bodyLower.includes('training course');

    // ── External-only: job routes to a company site, not Reed's apply form ─
    const externalPhrases = [
      'apply on company website', 'apply on employer', 'apply via employer',
      'visit employer website', 'apply externally', 'apply at employer',
      "apply on the employer's website", "apply on the company's website",
    ];
    const isExternalOnly = externalPhrases.some(p => bodyLower.includes(p)) ||
      Array.from(document.querySelectorAll('button, a')).some(el => {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return t.startsWith('apply on company') || t.startsWith('apply on employer') ||
               t.startsWith('visit employer') || t.startsWith('apply via employer');
      });

    // ── Apply button: check for any apply button on the page ─────────────
    // Reed uses "Apply now" — use includes to handle whitespace/casing variations
    const hasEasyApply = !isExternalOnly && Array.from(document.querySelectorAll('button, a')).some(el => {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return t === 'apply' || t === 'apply now' || t.includes('quick apply') ||
             t.includes('apply online') || t.startsWith('apply ');
    });

    // Capture external apply URL from button/link href (without clicking)
    let externalApplyUrl = '';
    if (isExternalOnly) {
      externalApplyUrl = Array.from(document.querySelectorAll('a[href], button[data-href]')).reduce((found, el) => {
        if (found) return found;
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t.includes('apply on company') || t.includes('apply on employer') ||
            t.includes('visit employer') || t.includes('apply via employer') ||
            t.includes('apply externally')) {
          return el.href || el.dataset?.href || '';
        }
        return '';
      }, '');
    }

    return { description, isTrainingCourse, isExternalOnly, hasEasyApply, externalApplyUrl };
  });

  await page.screenshot({ path: `${SSDIR}/reed_job_page_check.png` });
  console.log(`  [Reed JD] ${result.description.length} chars | Apply: ${result.hasEasyApply} | External: ${result.isExternalOnly} | Training: ${result.isTrainingCourse}`);

  return { ...job, ...result };
}

// ── APPLY TO JOB ───────────────────────────────────────────────────────────
async function applyToJob(page, job, resumePath) {
  console.log(`  [Reed] Applying: ${job.title} @ ${job.company}`);

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(4000);

  // Handle HTTP 431 (cookie headers too large) — clear and reload once
  const is431 = await page.evaluate(() => (document.body?.innerText || '').includes('HTTP ERROR 431')).catch(() => false);
  if (is431) {
    console.log('  [Reed] HTTP 431 on apply page — clearing cookies and reloading...');
    await page.context().clearCookies();
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await DELAY(4000);
  }

  // Check if already applied
  const alreadyApplied = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return text.includes('you have already applied') ||
           text.includes('already applied') ||
           text.includes('application submitted') ||
           text.includes('you applied');
  });
  if (alreadyApplied) {
    console.log('  [Reed] Already applied — skipping.');
    return null;
  }

  await page.screenshot({ path: `${SSDIR}/reed_apply_before_click.png` });

  // Click the Apply button
  let clicked = false;
  const applySelectors = [
    'button:has-text("Apply now")',
    'a:has-text("Apply now")',
    'button:has-text("Apply")',
    '[data-testid="apply-button"]',
    '.apply-button',
    'a[href*="/apply/"]',
  ];
  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        clicked = true;
        break;
      }
    } catch (_) {}
  }

  if (!clicked) {
    // JS fallback
    clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, a')).find(e => {
        const t = (e.innerText || e.textContent || '').trim().toLowerCase();
        return t === 'apply now' || t === 'apply' || t.startsWith('apply ');
      });
      if (el) { el.scrollIntoView({ behavior: 'instant', block: 'center' }); el.click(); return true; }
      return false;
    });
  }

  if (!clicked) {
    await page.screenshot({ path: `${SSDIR}/reed_apply_no_button.png` });
    throw new Error('Apply button not found on Reed job page');
  }

  // Listen for new tab/popup BEFORE waiting — catches the event even if fast
  const newPagePromise = page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null);

  await DELAY(5000);
  await page.screenshot({ path: `${SSDIR}/reed_apply_after_click.png` });

  // If the same tab redirected outside reed.co.uk — check for supported ATS
  const currentUrl = page.url();
  if (!currentUrl.includes('reed.co.uk')) {
    const ats = atsFiller.detectATS(currentUrl);
    if (atsFiller.SUPPORTED_ATS.has(ats)) {
      console.log(`  [Reed] ATS detected (redirect): ${ats} — filling form`);
      return await atsFiller.fillExternalForm(page, job, resumePath, ats);
    }
    console.log('  [Reed] Unsupported external redirect — skipping:', currentUrl.substring(0, 80));
    return 'external';
  }

  // Check for a new tab/popup that opened to an external site
  const popupPage = await newPagePromise;
  if (popupPage && popupPage !== page) {
    if (!popupPage.url() || popupPage.url() === 'about:blank') {
      await popupPage.waitForURL(u => u !== 'about:blank', { timeout: 3000 }).catch(() => {});
    }
    const popupUrl = popupPage.url();
    if (!popupUrl.includes('reed.co.uk')) {
      const ats = atsFiller.detectATS(popupUrl);
      if (atsFiller.SUPPORTED_ATS.has(ats)) {
        console.log(`  [Reed] ATS detected (new tab): ${ats} — filling form`);
        return await atsFiller.fillExternalForm(popupPage, job, resumePath, ats);
      }
      console.log('  [Reed] Unsupported external new tab — skipping:', popupUrl.substring(0, 80));
      await popupPage.close().catch(() => {});
      return 'external';
    }
  }

  // Sweep all open tabs — close any non-reed external tabs
  for (const p of page.context().pages()) {
    if (p !== page && !p.url().includes('reed.co.uk') && p.url() !== 'about:blank') {
      const ats = atsFiller.detectATS(p.url());
      if (atsFiller.SUPPORTED_ATS.has(ats)) {
        console.log(`  [Reed] ATS detected (open tab): ${ats} — filling form`);
        return await atsFiller.fillExternalForm(p, job, resumePath, ats);
      }
      console.log('  [Reed] Closing unsupported external tab:', p.url().substring(0, 80));
      await p.close().catch(() => {});
      return 'external';
    }
  }

  // Fill and submit the Reed application form
  await fillContactFields(page);
  const uploadOk = await uploadResume(page, resumePath);

  // Wait for Reed to process the uploaded CV
  await DELAY(3000);

  // If Reed's session expired while changing the CV, we cannot attach the
  // tailored CV — never submit with the account's saved (base) CV. Stop and
  // flag for reconnect.
  if (await reedSessionExpired(page)) {
    console.log('  [Reed] ⚠️  Reed session expired during CV upload — cannot attach the tailored CV.');
    console.log('  [[JOBBOT_NOTIFY]] Reed session expired — reconnect your Reed account so tailored CVs can be uploaded.');
    return 'cv_not_attached';
  }

  // Only proceed if the tailored-CV upload actually completed — never silently
  // fall back to the account's saved/base CV. (Reed pre-loads the profile CV, so
  // if the upload control wasn't found/driven, the base CV would be submitted.)
  if (!uploadOk) {
    console.log('  [Reed] ⚠️  Could not attach the tailored CV (upload control not found) — skipping so the base CV is NOT submitted.');
    console.log('  [[JOBBOT_NOTIFY]] Could not attach your tailored CV on Reed — skipped this job instead of applying with your base CV. If it persists, reconnect your Reed account.');
    return 'cv_not_attached';
  }

  // After file upload, "Update your CV" modal may show a confirmation button — click it
  const confirmSelectors = [
    'button:has-text("Update CV")',
    'button:has-text("Save CV")',
    'button:has-text("Upload CV")',
    'button:has-text("Done")',
    'button:has-text("Confirm")',
    'button:has-text("Save")',
  ];
  for (const sel of confirmSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        console.log(`  [Reed] Confirming CV upload via "${sel}"`);
        await btn.click();
        await DELAY(2500);
        break;
      }
    } catch (_) {}
  }

  // If the Update CV modal is still showing, dismiss it
  try {
    const cancelBtn = await page.$('button:has-text("Cancel update"), button:has-text("Cancel")');
    if (cancelBtn && await cancelBtn.isVisible()) {
      await cancelBtn.click();
      await DELAY(2000);
    }
  } catch (_) {}

  await page.screenshot({ path: `${SSDIR}/reed_after_cv_upload.png` });

  // Click "Continue" if Reed's modal shows it after CV upload
  try {
    const continueBtn = await page.$('button:has-text("Continue")');
    if (continueBtn && await continueBtn.isVisible()) {
      console.log('  [Reed] Clicking Continue...');
      await continueBtn.click();
      await DELAY(3000);
    }
  } catch (_) {}

  // After Continue, check if Reed reveals this is an external-only application
  try {
    const externalBtn = await page.$('button:has-text("Apply on external site"), a:has-text("Apply on external site"), button:has-text("apply on company website")');
    if (externalBtn && await externalBtn.isVisible()) {
      console.log('  [Reed] External site revealed after CV step — skipping');
      return 'external';
    }
  } catch (_) {}

  await answerScreeningQuestions(page);
  await fillCoverLetter(page, job);

  // #2 retry escalation: if Reed flags unmet required questions, answer again —
  // the still-empty fields now escalate to the AI fallback inside the answerers.
  if (await hasReedFormErrors(page)) {
    console.log('  [Reed] Required question(s) flagged — re-answering (AI escalation)');
    await answerScreeningQuestions(page);
    await fillCoverLetter(page, job);
  }

  await page.screenshot({ path: `${SSDIR}/reed_pre_submit.png` });

  const submitted = await trySubmit(page);
  if (submitted) {
    await DELAY(3000);
    await page.screenshot({ path: `${SSDIR}/reed_apply_submitted.png` });
    console.log('  [Reed] Application submitted!');
  }
  return submitted;
}

// ── HELPERS ────────────────────────────────────────────────────────────────

async function fillContactFields(page) {
  const { firstName, lastName, phone, email } = cfg.APPLICANT;
  const address = cfg.APPLICANT.address || cfg.APPLICANT.location || '';
  const fills = [
    { sel: 'input[name*="firstName" i], input[id*="firstName" i], input[placeholder*="First name" i]', val: firstName },
    { sel: 'input[name*="lastName" i], input[id*="lastName" i], input[placeholder*="Last name" i]',   val: lastName  },
    { sel: 'input[name*="phone" i], input[id*="phone" i], input[type="tel"]',                          val: phone     },
    { sel: 'input[name*="email" i], input[id*="email" i], input[type="email"]',                        val: email     },
    { sel: 'input[name*="address" i], input[id*="address" i], input[placeholder*="address" i]',        val: address   },
  ];
  for (const { sel, val } of fills) {
    if (!val) continue;
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        const cur = await el.inputValue();
        if (!cur) {
          await el.click({ clickCount: 3 });
          await DELAY(80);
          await el.fill(val);
          await DELAY(100);
        }
      }
    } catch (_) {}
  }
  // Label-based fallback for text fields like "Address Line 1" whose input has no
  // address-ish name/id/placeholder — match by the visible label text.
  if (address) await fillTextByLabel(page, /address\s*line\s*1|^address\b|street address/i, address);
}

// Fill the first empty text input/textarea whose associated label matches `re`.
async function fillTextByLabel(page, re, value) {
  try {
    const inputs = await page.$$('input[type="text"], input:not([type]), textarea');
    for (const el of inputs) {
      if (!(await el.isVisible().catch(() => false))) continue;
      if (await el.inputValue().catch(() => '')) continue; // don't overwrite
      const label = await el.evaluate(node => {
        const id = node.id;
        const lab = (id && document.querySelector(`label[for="${id}"]`)) ||
                    node.closest('label') ||
                    node.closest('[class*="field"], [class*="form"]')?.querySelector('label, legend, .question-text, p');
        return lab ? lab.innerText.trim() : (node.getAttribute('aria-label') || node.placeholder || '');
      }).catch(() => '');
      if (re.test(label)) {
        await el.click({ clickCount: 3 }).catch(() => {});
        await DELAY(80);
        await el.fill(value).catch(() => {});
        await DELAY(100);
        return true;
      }
    }
  } catch (_) {}
  return false;
}

// Confirm the tailored file is REALLY attached — never trust setFiles alone
// (a hidden/wrong input or a silent site rejection previously made us report
// success and submit the base CV). Two signals, either proves it:
//   1. a file input whose .files contains the exact tailored filename, or
//   2. the distinctive filename shown on the page ({Title}_{Company}_{NNpct}…
//      — underscored, so it can never match JD prose like the old check did).
async function verifyCvUploaded(page, resumePath) {
  const base  = String(resumePath).split(/[\\/]/).pop(); // path-free: reed.js doesn't import `path`
  const noExt = base.replace(/\.[^.]+$/, '');
  const needle = noExt.slice(0, 25); // display may truncate long names
  try {
    await page.waitForFunction(({ base, needle }) => {
      for (const inp of document.querySelectorAll('input[type="file"]')) {
        for (const f of inp.files || []) if (f.name === base) return true;
      }
      return document.body.innerText.includes(needle);
    }, { base, needle }, { timeout: 10000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function uploadResume(page, resumePath) {
  if (!resumePath || !fs.existsSync(resumePath)) return false;
  // Never attach a corrupt / empty / truncated CV to a real application. Stale
  // queue entries from an earlier build can point at a bad PDF; validate here and
  // refuse — applyToJob then skips rather than submitting the account's base CV.
  const cvCheck = await cvValidate.validateCvPdf(resumePath);
  if (!cvCheck.ok) {
    console.log(`  [Reed] ⚠ Tailored CV invalid (${cvCheck.reason}) — refusing to attach: ${require('path').basename(resumePath)}`);
    return false;
  }
  try {
    // Reed's apply modal shows "CV loading…" with a spinner while it fetches the
    // saved CV. The Update / upload controls only render AFTER that finishes, so
    // if we look for them too early we find nothing and wrongly skip the job.
    // Wait for the loading state to clear (and the CV controls to appear) first.
    try {
      await page.waitForFunction(() => {
        const t = document.body.innerText || '';
        if (/CV loading/i.test(t)) return false;              // still loading
        // ready once an Update/Change control or a file input is present
        return /\b(Update|Use a different CV|Change CV|Upload a different CV)\b/i.test(t)
               || !!document.querySelector('input[type="file"]');
      }, { timeout: 20000 });
    } catch (_) { /* fall through and try anyway */ }
    await DELAY(700);

    // Reed shows the CV saved on the account by default and hides the file input.
    // Click "Use a different CV" / "Change" / "Upload a different CV" first to reveal the upload field.
    // Reed's apply modal shows the saved CV with an "Update" link — click it to replace
    const changeSelectors = [
      'a:has-text("Update")',
      'button:has-text("Update")',
      'a:has-text("Use a different CV")',
      'button:has-text("Use a different CV")',
      'a:has-text("Upload a different CV")',
      'button:has-text("Upload a different CV")',
      'a:has-text("Change CV")',
      'button:has-text("Change CV")',
      'a:has-text("Change")',
      '[data-testid*="change-cv"]',
      '[data-testid*="update-cv"]',
    ];
    // Step 1: click "Update" — this opens a second modal (not a file chooser yet)
    for (const sel of changeSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          console.log(`  [Reed] Clicking "${sel}" to open CV update modal...`);
          await btn.click();
          await DELAY(2000);
          break;
        }
      } catch (_) {}
    }

    // Step 2: Reed shows "Update your CV" modal with a "Choose your CV file" button — click it
    const chooseSelectors = [
      'button:has-text("Choose your CV file")',
      'button:has-text("Choose your CV")',
      'button:has-text("Choose file")',
      'label:has-text("Choose")',
    ];
    for (const sel of chooseSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          console.log(`  [Reed] Clicking "${sel}" to open file chooser...`);
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 8000 }),
            btn.click(),
          ]);
          await chooser.setFiles(resumePath);
          await DELAY(3000);
          if (await verifyCvUploaded(page, resumePath)) {
            console.log('  [Reed] Tailored CV uploaded + verified attached.');
            return true;
          }
          console.log('  [Reed] ⚠ Upload set but tailored CV NOT confirmed attached — treating as failed.');
          await page.screenshot({ path: `${SSDIR}/reed_cv_verify_failed.png` }).catch(() => {});
          return false;
        }
      } catch (err) {
        console.log(`  [Reed] Choose file click error: ${err.message.substring(0, 80)}`);
      }
    }

    // Fallback: bare file input (no saved CV on account)
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await page.evaluate(el => { el.style.display = 'block'; el.style.visibility = 'visible'; }, fileInput);
      await fileInput.setInputFiles(resumePath);
      await DELAY(2500);
      if (await verifyCvUploaded(page, resumePath)) {
        console.log('  [Reed] Tailored CV uploaded via file input + verified attached.');
        return true;
      }
      console.log('  [Reed] ⚠ File input set but tailored CV NOT confirmed attached — treating as failed.');
      await page.screenshot({ path: `${SSDIR}/reed_cv_verify_failed.png` }).catch(() => {});
      return false;
    }

    await page.screenshot({ path: `${SSDIR}/reed_cv_upload_state.png` });
    console.log('  [Reed] Could not find a CV upload control — screenshot saved.');
    return false;
  } catch (err) {
    console.log('  [Reed] CV upload error:', err.message);
    return false;
  }
}

// Detect Reed's "session expired" state — the session must be reconnected.
async function reedSessionExpired(page) {
  try {
    return await page.evaluate(() =>
      /your session has expired|session expired|please refresh the page to continue/i.test(document.body?.innerText || '')
    );
  } catch { return false; }
}

async function fillCoverLetter(page, job) {
  try {
    const textareas = await page.$$('textarea');
    for (const ta of textareas) {
      if (!(await ta.isVisible().catch(() => false))) continue;
      const cur = await ta.inputValue().catch(() => '');
      if (cur && cur.trim()) continue;

      const ctx = await ta.evaluate(el => {
        const lab = el.closest('[class*="form"]')?.querySelector('label') ||
                    document.querySelector(`label[for="${el.id}"]`);
        return (lab ? lab.innerText : '').toLowerCase().trim();
      });

      let text = '';
      if (/cover letter/i.test(ctx)) {
        text = (job && job.coverLetter) || 'I am enthusiastic about this opportunity and believe my experience aligns well with your requirements. Please see my CV for a comprehensive overview of my background. I look forward to discussing my application further.';
      } else if (/additional|tell us|message|why|anything else|motivat/i.test(ctx)) {
        text = 'Please see my CV for a comprehensive overview of my relevant experience and qualifications. I am enthusiastic about this role and available for interview at your earliest convenience.';
      } else {
        text = 'Please see my CV for details on my relevant experience and qualifications.';
      }

      if (text) {
        await ta.click().catch(() => {});
        await DELAY(80);
        await ta.fill(text).catch(() => {});
      }
    }
  } catch (_) {}
}

// Correct yes/no for the legally-sensitive questions, shared by Reed's radio,
// dropdown and text handlers. Sponsorship is answered from the user's profile and
// is kept SEPARATE from right-to-work (a user who needs no sponsorship has the
// right to work). Handles inverted "without sponsorship" phrasing. Returns
// 'yes' | 'no' | null.
function sensitiveYesNo(question) {
  const q = (question || '').toLowerCase();
  const needsSponsor = !!cfg.APPLICANT.requiresSponsorship;
  // Any mention of sponsorship → from profile (check inverted phrasing first)
  if (/sponsor/i.test(q)) {
    if (/without sponsor|not require sponsor|no sponsor|don.?t (need|require) sponsor/i.test(q)) return needsSponsor ? 'no' : 'yes';
    return needsSponsor ? 'yes' : 'no';
  }
  if (/right to work|work permit|authoris.*work|authoriz.*work|eligible.*work|legal.*work|entitled to work|permit to work/i.test(q)) {
    return needsSponsor ? 'no' : 'yes';
  }
  if (/reloc/i.test(q)) return cfg.APPLICANT.willingToRelocate ? 'yes' : 'no';
  if (/driving.*licen|licen.*driving|valid.*licen|full (uk )?licen/i.test(q)) return cfg.APPLICANT.drivingLicence ? 'yes' : 'no';
  return null;
}

// Are there visible required-field validation errors on Reed's application form?
// Drives the #2 retry escalation — if true, we re-answer so the still-empty
// fields get the AI fallback. Broad selector set (Reed's markup varies); a false
// negative just means no retry (AI already ran once), a false positive re-runs
// the idempotent answerers (filled fields are skipped), so both directions are safe.
async function hasReedFormErrors(page) {
  try {
    return await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll(
        '.form-group--error, .field-validation-error, [class*="error-message"], [class*="validation-error"], [aria-invalid="true"], .qa-error'
      ));
      return els.some(el => el.offsetParent !== null && ((el.innerText || el.textContent || '').trim().length > 0 || el.getAttribute('aria-invalid') === 'true'));
    });
  } catch { return false; }
}

async function answerScreeningQuestions(page) {
  // Address Line 1 and similar text fields appear in Reed's "Application
  // questions" modal — fill them from the profile address (fallback: location).
  const _addr = cfg.APPLICANT.address || cfg.APPLICANT.location || '';
  if (_addr) await fillTextByLabel(page, /address\s*line\s*1|^address\b|street address|address\s*line/i, _addr);

  // ── Radio buttons ────────────────────────────────────────────────────────
  try {
    const fieldsets = await page.$$('fieldset, .question-group, [class*="question-row"]');
    for (const fieldset of fieldsets) {
      const question = await fieldset.evaluate(el => {
        const label = el.querySelector('legend, label, p, .question-text, h4');
        return label ? label.innerText.toLowerCase() : '';
      });

      const radios = await fieldset.$$('input[type="radio"]');
      if (!radios.length) continue;

      const options = [];
      for (const r of radios) {
        const lbl = await r.evaluate(el => {
          const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label');
          return lab ? lab.innerText.toLowerCase().trim() : '';
        });
        options.push({ radio: r, label: lbl });
      }

      let target = null;
      const _yn = sensitiveYesNo(question);
      if (_yn) {
        target = options.find(o => _yn === 'yes' ? o.label.startsWith('yes') : o.label.startsWith('no'));
        if (/sponsor/i.test(question)) console.log(`  [Reed] Sponsorship question → ${_yn === 'yes' ? 'Yes' : 'No'}`);
      } else if (/commut|travel to|able to.*office|willing to.*office/i.test(question)) {
        target = options.find(o => o.label.startsWith('yes'));
      } else if (/gender/i.test(question)) {
        const g = cfg.APPLICANT.eeoGender;
        if (g === 'female') target = options.find(o => /\bfemale\b|\bwoman\b/i.test(o.label));
        else if (g === 'nonbinary') target = options.find(o => /non.?binary|other/i.test(o.label));
        else if (!g) target = options.find(o => /prefer not|decline|not.*say/i.test(o.label)) || options[options.length - 1];
        else target = options.find(o => /\bmale\b|\bman\b/i.test(o.label) && !/fe/i.test(o.label));
      } else if (/disability|disabled|chronic/i.test(question)) {
        const d = cfg.APPLICANT.eeoDisability;
        if (d === 'yes') target = options.find(o => o.label.startsWith('yes'));
        else if (d === 'no') target = options.find(o => o.label.startsWith('no'));
        else target = options.find(o => /prefer not|decline|not.*say/i.test(o.label)) || options[options.length - 1];
      } else if (/veteran|military/i.test(question)) {
        const v = cfg.APPLICANT.eeoVeteran;
        if (v === 'yes') target = options.find(o => o.label.startsWith('yes') || /protected/i.test(o.label));
        else if (v === 'no') target = options.find(o => o.label.startsWith('no') || /not a/i.test(o.label));
        else target = options.find(o => /prefer not|decline|not.*say/i.test(o.label)) || options[options.length - 1];
      } else if (/notice period|how.*soon.*start|when.*available.*start|notice.*required/i.test(question)) {
        const avMap = {
          'immediately': /immediate|asap|now|^0\s*|no notice|straight away/,
          '1week':       /^1\s*week|one\s*week/,
          '2weeks':      /^2\s*week|two\s*week/,
          '1month':      /^1\s*month|one\s*month/,
          '2months':     /^2\s*month|two\s*month/,
          '3months':     /^3\s*month|three\s*month/,
        };
        const avKey = cfg.APPLICANT.availability || 'immediately';
        target = options.find(o => avMap[avKey]?.test(o.label)) || options[0];
      } else if (/experience|have you|familiar|worked with|authoris|authoriz|eligible/i.test(question)) {
        target = options.find(o => o.label.startsWith('yes'));
      } else if (/british|uk citizen|nationality/i.test(question)) {
        target = options.find(o => o.label.startsWith('yes'));
      } else if (question && !ai.isSensitiveQuestion(question)) {
        // Unknown non-sensitive question — ask the LLM to pick before defaulting.
        const picked = await ai.aiPickOption({
          question,
          options: options.map(o => ({ text: o.label, radio: o.radio })),
          kind: 'radio',
        });
        if (picked) {
          target = { radio: picked.radio, label: picked.text };
          console.log(`  [Reed] AI answered radio: "${question}" → "${picked.text}"`);
        } else {
          target = options.find(o => o.label.startsWith('yes')) || options[0];
        }
      } else {
        target = options.find(o => o.label.startsWith('yes')) || options[0];
      }

      if (target) {
        const already = await target.radio.isChecked().catch(() => false);
        if (!already) {
          await target.radio.scrollIntoViewIfNeeded().catch(() => {});
          // Reed styles its radios — clicking the hidden <input> can do nothing,
          // so verify it checked and fall back to clicking the parent <label>.
          let ok = false;
          try { await target.radio.click({ timeout: 2000 }); ok = await target.radio.isChecked().catch(() => false); } catch (_) {}
          if (!ok) {
            try {
              await target.radio.evaluate(el => {
                const lab = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
                (lab || el).click();
              });
              ok = await target.radio.isChecked().catch(() => false);
            } catch (_) {}
          }
          if (!ok) console.log(`  [Reed] ⚠ Radio not set: "${(question || '').substring(0, 45)}"`);
        }
      } else if (question) {
        console.log(`  [Reed] ⚠ No answer for radio: "${question.substring(0, 50)}"`);
      }
    }
  } catch (_) {}

  // ── Select dropdowns ─────────────────────────────────────────────────────
  try {
    const selects = await page.$$('select');
    for (const sel of selects) {
      const cur = await sel.inputValue().catch(() => '');
      if (cur && cur !== '') continue;

      const question = await sel.evaluate(el => {
        const id = el.id;
        const lab = id ? document.querySelector(`label[for="${id}"]`) : null;
        return (lab ? lab.innerText : '').toLowerCase();
      });

      const opts = await sel.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: o.text.toLowerCase().trim() }))
      );
      const nonEmpty = opts.filter(o => o.value && o.text &&
        !['select', 'please select', 'choose', '--'].some(p => o.text.startsWith(p))
      );

      let chosen = null;
      const _yn = sensitiveYesNo(question);
      if (_yn) {
        chosen = nonEmpty.find(o => _yn === 'yes' ? o.text.startsWith('yes') : o.text.startsWith('no')) || nonEmpty[0];
        if (/sponsor/i.test(question)) console.log(`  [Reed] Sponsorship dropdown → ${_yn === 'yes' ? 'Yes' : 'No'}`);
      } else if (/year|experience/i.test(question)) {
        const yr = cfg.APPLICANT.yearsExperience || 0;
        chosen = nonEmpty.find(o => new RegExp(`\\b${yr}\\b`).test(o.text)) ||
                 nonEmpty.find(o => { const n = o.text.match(/\d+/g); return n && n.length >= 2 && yr >= Number(n[0]) && yr <= Number(n[1]); }) ||
                 nonEmpty.find(o => { const n = o.text.match(/\d+/g); return n && /\+|more|above|over/.test(o.text) && yr >= Number(n[0]); }) ||
                 nonEmpty[0];
      } else if (/driving.*licen/i.test(question)) {
        chosen = cfg.APPLICANT.drivingLicence
          ? nonEmpty.find(o => o.text.startsWith('yes'))
          : nonEmpty.find(o => o.text.startsWith('no')) || nonEmpty[0];
      } else if (/notice period|availab/i.test(question)) {
        const avMap = { 'immediately': 'immediate', '1week': '1 week', '2weeks': '2 weeks', '1month': '1 month', '2months': '2 months', '3months': '3 months' };
        const key = avMap[cfg.APPLICANT.availability || 'immediately'] || 'immediate';
        chosen = nonEmpty.find(o => o.text.includes(key)) || nonEmpty.find(o => o.text.startsWith('yes')) || nonEmpty[0];
      } else if (/reloc/i.test(question)) {
        chosen = cfg.APPLICANT.willingToRelocate
          ? nonEmpty.find(o => o.text.startsWith('yes')) || nonEmpty[0]
          : nonEmpty.find(o => o.text.startsWith('no')) || nonEmpty[0];
      } else {
        if (question && !ai.isSensitiveQuestion(question)) {
          const picked = await ai.aiPickOption({ question, options: nonEmpty, kind: 'dropdown' });
          if (picked) {
            chosen = picked;
            console.log(`  [Reed] AI answered dropdown: "${question}" → "${picked.text}"`);
          }
        }
        if (!chosen) chosen = nonEmpty.find(o => o.text === 'yes' || o.text.startsWith('yes')) || nonEmpty[0];
      }

      if (chosen) await sel.selectOption({ value: chosen.value }).catch(() => {});
    }
  } catch (_) {}

  // ── Text / number inputs ─────────────────────────────────────────────────
  try {
    const inputs = await page.$$('input[type="number"], input[type="text"]');
    for (const inp of inputs) {
      if (!(await inp.isVisible().catch(() => false))) continue;
      const cur = await inp.inputValue().catch(() => '');
      if (cur) continue;

      const question = await inp.evaluate(el => {
        const id = el.id;
        const lab = id ? document.querySelector(`label[for="${id}"]`) : null;
        return (lab ? lab.innerText : '').toLowerCase();
      });

      const _yn = sensitiveYesNo(question);
      if (_yn) {
        await inp.fill(_yn === 'yes' ? 'Yes' : 'No').catch(() => {});
      } else if (/commut|travel/i.test(question)) {
        await inp.fill('Yes').catch(() => {});
      } else if (/reloc/i.test(question)) {
        await inp.fill(cfg.APPLICANT.willingToRelocate ? 'Yes' : 'No').catch(() => {});
      } else if (/notice period|availab|when can you start/i.test(question)) {
        const avText = { 'immediately': 'Immediately available', '1week': '1 week', '2weeks': '2 weeks', '1month': '1 month', '2months': '2 months', '3months': '3 months' };
        await inp.fill(avText[cfg.APPLICANT.availability || 'immediately'] || 'Immediately available').catch(() => {});
      } else if (/year|experience|how long|how many/i.test(question)) {
        await inp.fill(String(cfg.APPLICANT.yearsExperience || 0)).catch(() => {});
      } else if (/salary|expected|compensation/i.test(question)) {
        if (cfg.APPLICANT.salaryExpectation) await inp.fill(cfg.APPLICANT.salaryExpectation).catch(() => {});
      } else if (/middle\s*name|middle\s*initial/i.test(question)) {
        // Fill the middle name or leave BLANK if none — never send a name field to AI.
        if (cfg.APPLICANT.middleName) await inp.fill(cfg.APPLICANT.middleName).catch(() => {});
      } else if (/first\s*name|given\s*name|forename/i.test(question)) {
        if (cfg.APPLICANT.firstName) await inp.fill(cfg.APPLICANT.firstName).catch(() => {});
      } else if (/last\s*name|surname|family\s*name/i.test(question)) {
        if (cfg.APPLICANT.lastName) await inp.fill(cfg.APPLICANT.lastName).catch(() => {});
      } else if (/full\s*name|your\s*name|legal\s*name|preferred\s*name/i.test(question)) {
        const full = [cfg.APPLICANT.firstName, cfg.APPLICANT.middleName, cfg.APPLICANT.lastName].filter(Boolean).join(' ');
        if (full) await inp.fill(full).catch(() => {});
      } else {
        const type = await inp.getAttribute('type');
        let val = null;
        if (type !== 'number' && question && !ai.isSensitiveQuestion(question)) {
          val = await ai.aiTextAnswer({ question, long: false });
        }
        if (val) {
          await inp.fill(val).catch(() => {});
          console.log(`  [Reed] AI answered text field: "${question}" → "${val}"`);
        } else if (type === 'number') {
          await inp.fill(String(cfg.APPLICANT.yearsExperience || 0)).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

async function trySubmit(page) {
  const submitSelectors = [
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button:has-text("Send application")',
    'button:has-text("Complete application")',
    'button:has-text("Apply now")',
    'button:has-text("Apply")',
    'input[type="submit"]',
    'button[type="submit"]',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        const btnText = (await btn.innerText().catch(() => '')).toLowerCase();
        if (btnText.includes('external site') || btnText.includes('company website')) continue;
        await btn.scrollIntoViewIfNeeded();
        await DELAY(500);
        if (await btn.isEnabled()) {
          console.log(`  [Reed] Clicking submit: "${sel}"`);
          await btn.click();
          return true;
        }
      }
    } catch (_) {}
  }

  // JS fallback — scan all buttons for submit-like text
  const submitted = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(el => {
      if (el.disabled) return false;
      const t = (el.innerText || el.value || '').trim().toLowerCase();
      return t.includes('submit') || t.includes('send application') ||
             t.includes('complete application') || t === 'apply' || t === 'apply now';
    });
    if (btn) { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); btn.click(); return true; }
    return false;
  });

  if (submitted) console.log('  [Reed] Submit clicked via JS fallback');
  else console.log('  [Reed] Submit button not found — check reed_pre_submit.png');
  return submitted;
}

module.exports = { ensureLoggedIn, searchJobs, getJobDescription, applyToJob, answerScreeningQuestions };
