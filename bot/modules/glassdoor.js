const cfg     = require('../config');
const fs      = require('fs');
const path    = require('path');
const stealth = require('./stealth');
const captcha = require('./captcha_solver');

const SSDIR = cfg.SCREENSHOTS_DIR;
const DELAY = ms => new Promise(r => setTimeout(r, ms));

function getBaseUrl() {
  return cfg.APPLICANT.country === 'United States'
    ? 'https://www.glassdoor.com'
    : 'https://www.glassdoor.co.uk';
}

// ── Login ──────────────────────────────────────────────────────────────────
async function login(browser, email, password) {
  const sessionFile = cfg.GLASSDOOR_SESSION_FILE;
  const baseUrl     = getBaseUrl();

  let context;
  if (fs.existsSync(sessionFile)) {
    try { context = await browser.newContext({ storageState: sessionFile }); }
    catch (_) { context = await browser.newContext(); }
  } else {
    context = await browser.newContext();
  }

  await stealth.applyToContext(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  if (fs.existsSync(sessionFile)) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await DELAY(2000);
    const isLoggedIn = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return t.includes('sign out') || t.includes('my profile') || t.includes('account settings') ||
             !!document.querySelector('[data-test="user-menu"], [class*="userMenu"], [class*="SignedIn"]');
    }).catch(() => false);
    if (isLoggedIn) {
      console.log('  [Glassdoor] ✓ Session restored — already logged in.');
      return page;
    }
    console.log('  [Glassdoor] Saved session expired — logging in again.');
  }

  const loginUrl = `${baseUrl}/profile/login_input.htm`;
  console.log('  [Glassdoor] Opening login page — please complete login in the browser window.');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(2000);

  try {
    const emailInput = page.locator('input[type="email"], input[id="userEmail"], input[name="username"]').first();
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailInput.fill(email);
    }
  } catch (_) {}

  console.log('  [Glassdoor] ⏳ Waiting for you to complete login (up to 5 minutes)...');
  const deadline = Date.now() + 300000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('glassdoor') && !url.includes('login') && !url.includes('signin')) {
      const authenticated = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase();
        return t.includes('sign out') || t.includes('my profile') ||
               !!document.querySelector('[data-test="user-menu"], [class*="userMenu"]');
      }).catch(() => false);
      if (authenticated) { loggedIn = true; break; }
    }
    if (url.includes('captcha') || url.includes('challenge')) {
      console.log('  [Glassdoor] ⚠️  CAPTCHA detected — attempting auto-solve...');
      await captcha.autoSolve(page).catch(() => {});
    }
    await DELAY(4000);
  }

  if (!loggedIn) {
    await page.screenshot({ path: path.join(SSDIR, 'glassdoor_login_issue.png') }).catch(() => {});
    throw new Error('Glassdoor login timed out. Check your credentials in Job Site Login.');
  }

  await context.storageState({ path: sessionFile });
  console.log('  [Glassdoor] ✓ Logged in. Session saved.');
  return page;
}

// ── Search Jobs ────────────────────────────────────────────────────────────
async function searchJobs(page, searchTerm, limit = 25) {
  const baseUrl = getBaseUrl();
  const encoded = encodeURIComponent(searchTerm);

  const jobAgeSecs = cfg.JOB_AGE ? parseInt((cfg.JOB_AGE || '').replace('r', ''), 10) : 1209600;
  const fromAgeDays = Math.max(1, Math.round((isNaN(jobAgeSecs) ? 1209600 : jobAgeSecs) / 86400));

  // Glassdoor search: Remote + Easy Apply
  const url = `${baseUrl}/Job/jobs.htm?sc.keyword=${encoded}&locT=N&wfhType=WFH&easyApply=true&fromAge=${fromAgeDays}&sortBy=date_desc`;

  console.log(`\n  [Glassdoor] Searching: "${searchTerm}" (Remote, Easy Apply)`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(3000);

  // Dismiss modal if present
  for (const sel of ['button[alt="Close"], [class*="modal"] button[class*="close"], [data-test="modal-close-btn"]']) {
    try { await page.click(sel, { timeout: 2000 }); await DELAY(500); } catch (_) {}
  }

  // Scroll to load cards
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await DELAY(800);
  }

  const jobs = await page.evaluate((lim) => {
    const cardSelectors = [
      '[data-test="jobListing"]',
      'li[data-jobid]',
      '[class*="JobCard"]',
      '.react-job-listing',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length) break;
    }

    return cards.slice(0, lim).map(card => {
      const titleEl   = card.querySelector('[data-test="job-title"], [class*="JobTitle"], .job-title a, h3 a');
      const companyEl = card.querySelector('[data-test="employer-name"], [class*="EmployerName"], .employer-name');
      const jobId     = card.getAttribute('data-jobid') || card.getAttribute('data-id') ||
                        titleEl?.getAttribute('href')?.match(/\/(\d+)(?:\.htm)?/)?.[1] || '';
      const href      = titleEl?.getAttribute('href') || '';

      return {
        title:   (titleEl?.innerText || '').trim(),
        company: (companyEl?.innerText || '').trim(),
        jobId:   'glassdoor_' + jobId,
        jobKey:  jobId,
        url:     href ? (href.startsWith('http') ? href : window.location.origin + href) : '',
      };
    }).filter(j => j.jobKey && j.title);
  }, limit);

  console.log(`  [Glassdoor] Found ${jobs.length} jobs for "${searchTerm}"`);
  return jobs;
}

// ── Get Job Description ────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  if (!job.url) return { ...job, description: '', hasEasyApply: false };

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(3000);

  // Dismiss overlay/modal
  for (const sel of ['[data-test="modal-close-btn"]', 'button[class*="CloseButton"]', '[class*="modal"] button:has-text("✕")']) {
    try { await page.click(sel, { timeout: 1500 }); await DELAY(500); } catch (_) {}
  }

  const { description, hasEasyApply } = await page.evaluate(() => {
    const descSelectors = [
      '[class*="jobDescriptionContent"]',
      '[data-test="jobDescriptionContent"]',
      '.desc',
      '[class*="JobDescription"]',
    ];
    let desc = '';
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) { desc = el.innerText.trim(); break; }
    }
    if (!desc) {
      const main = document.querySelector('main, [class*="jobContent"]');
      if (main) desc = main.innerText.trim().substring(0, 8000);
    }

    const easyApply = !!document.querySelector(
      '[data-test="easy-apply-button"], button:has-text("Easy Apply"), [class*="EasyApplyButton"]'
    ) || (document.body?.innerText || '').toLowerCase().includes('easy apply');

    return { description: desc, hasEasyApply: easyApply };
  });

  const type = hasEasyApply ? 'EASY APPLY' : 'EXTERNAL';
  console.log(`  [Glassdoor] JD: ${description.length} chars | Apply type: ${type}`);
  return { ...job, description, hasEasyApply };
}

// ── Apply to Job ────────────────────────────────────────────────────────────
async function applyToJob(page, job, resumePath) {
  console.log(`  [Glassdoor] Applying: ${job.title} @ ${job.company}`);

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(3000);

  // Dismiss modal
  for (const sel of ['[data-test="modal-close-btn"]', 'button[class*="CloseButton"]']) {
    try { await page.click(sel, { timeout: 1500 }); } catch (_) {}
  }

  // Already applied?
  const alreadyApplied = await page.evaluate(() => {
    return (document.body?.innerText || '').toLowerCase().includes('you applied') ||
           !!document.querySelector('[data-test="applied-badge"]');
  });
  if (alreadyApplied) return null;

  await page.screenshot({ path: path.join(SSDIR, 'gd_before_apply.png') }).catch(() => {});

  // Click Easy Apply button
  const applySelectors = [
    '[data-test="easy-apply-button"]',
    'button:has-text("Easy Apply")',
    '[class*="EasyApplyButton"]',
    'a:has-text("Easy Apply")',
  ];

  let clicked = false;
  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        const [newPage] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
          btn.click(),
        ]);
        if (newPage) {
          await newPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          await DELAY(2000);
        }
        clicked = true;
        break;
      }
    } catch (_) {}
  }

  if (!clicked) {
    console.log('  [Glassdoor] Easy Apply button not found');
    return false;
  }

  await DELAY(3000);
  await page.screenshot({ path: path.join(SSDIR, 'gd_apply_01.png') }).catch(() => {});

  // Glassdoor Easy Apply is an iframe/modal — fill fields
  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    await DELAY(2000);
    await page.screenshot({ path: path.join(SSDIR, `gd_apply_step${step}.png`) }).catch(() => {});

    // Upload resume if input present
    try {
      const fi = await page.$('input[type="file"]');
      if (fi) { await fi.setInputFiles(resumePath); await DELAY(2000); }
    } catch (_) {}

    // Fill contact fields
    await _fillFields(page, job);

    // Submit?
    const submitted = await _trySubmit(page);
    if (submitted) {
      console.log('  [Glassdoor] ✓ Application submitted!');
      return true;
    }

    // Continue?
    const advanced = await _tryContinue(page);
    if (!advanced) {
      console.log(`  [Glassdoor] Could not advance on step ${step}`);
      break;
    }
  }

  return false;
}

async function _fillFields(page, job) {
  const { firstName, lastName, phone, email } = cfg.APPLICANT;
  const fills = [
    { sels: ['input[name="firstName"], input[id*="firstName"], input[placeholder*="First"]'], val: firstName },
    { sels: ['input[name="lastName"], input[id*="lastName"], input[placeholder*="Last"]'], val: lastName },
    { sels: ['input[type="tel"], input[name*="phone"], input[placeholder*="Phone"]'], val: phone },
    { sels: ['input[type="email"], input[name*="email"], input[placeholder*="Email"]'], val: email },
  ];
  for (const { sels, val } of fills) {
    if (!val) continue;
    for (const sel of sels.flatMap(s => s.split(', '))) {
      try {
        const el = await page.$(sel.trim());
        if (el && await el.isVisible() && !await el.inputValue()) {
          await el.fill(val); await DELAY(150); break;
        }
      } catch (_) {}
    }
  }

  // Cover letter textarea
  try {
    const ta = await page.$('textarea[name*="coverLetter"], textarea[placeholder*="cover"]');
    if (ta && await ta.isVisible() && !await ta.inputValue()) {
      await ta.fill(job.coverLetter || `Please see my attached CV for full details of my experience. I am available immediately and excited about the ${job.title} role at ${job.company}.`);
    }
  } catch (_) {}

  // Consent checkboxes
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      const lbl = await cb.evaluate(el => (document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || { innerText: '' }).innerText.toLowerCase());
      if (/agree|terms|accept|consent/i.test(lbl) && !await cb.isChecked()) await cb.click();
    } catch (_) {}
  }
}

async function _trySubmit(page) {
  for (const sel of ['button:has-text("Submit")', 'button[type="submit"]', '[data-test="submit-button"]']) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) { await btn.click(); return true; }
    } catch (_) {}
  }
  return false;
}

async function _tryContinue(page) {
  for (const sel of ['button:has-text("Continue")', 'button:has-text("Next")', '[data-test="next-button"]']) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) { await btn.click(); await DELAY(2000); return true; }
    } catch (_) {}
  }
  return false;
}

module.exports = { login, searchJobs, getJobDescription, applyToJob };
