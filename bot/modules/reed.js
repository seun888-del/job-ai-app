const cfg     = require('../config');
const fs      = require('fs');
const stealth = require('./stealth');
const salary  = require('./salary_filter');
const queue   = require('./queue_manager');

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

  // Session missing or expired — open login page for manual login
  console.log('  [Reed] Opening login page — please enter your password in the browser window.');
  await page.goto('https://secure.reed.co.uk/login', { waitUntil: 'load', timeout: 60000 });
  await DELAY(3000);

  // Pre-fill email
  try {
    const emailEl = await page.$('input[name="username"], input[id="username"], input[type="email"], input[name="email"]');
    if (emailEl && await emailEl.isVisible()) {
      await emailEl.click();
      await DELAY(300);
      await emailEl.fill(email);
      console.log('  [Reed] Email pre-filled. Please enter your password and click Log In.');
    }
  } catch (_) {}

  console.log('  [Reed] ⏳ Waiting for you to complete login (up to 5 minutes)...');

  const deadline = Date.now() + 300000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const u = page.url();
    if (u.startsWith('https://www.reed.co.uk') && !u.includes('/login') && !u.includes('/authentication')) {
      // Verify the page actually shows a logged-in state (not just the homepage unauthenticated)
      const authenticated = await page.evaluate(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return text.includes('my reed') || text.includes('sign out') || text.includes('log out') ||
               !!document.querySelector('[href*="/my-reed"], [href*="/account"], [data-testid*="account"]');
      }).catch(() => false);
      if (authenticated) { loggedIn = true; break; }
    }
    await DELAY(4000);
  }

  if (!loggedIn) {
    console.log('  [Reed] Login failed or timed out — check credentials in Job Site Login.');
    await page.screenshot({ path: `${SSDIR}/reed_login_issue.png` }).catch(() => {});
    throw new Error('Reed login timed out. Open Job Site Login in the app and check your credentials.');
  }

  await context.storageState({ path: SESSION_FILE });
  console.log('  [Reed] ✓ Logged in. Session saved — next run will skip login.');
  return page;
}

// ── SEARCH JOBS ────────────────────────────────────────────────────────────
async function searchJobs(browser, page, searchTerm, limit = 25, remoteOnly = false) {
  // Recover from a closed page (Reed can close tabs via anti-bot redirects)
  if (page.isClosed()) {
    console.log('  [Reed] Page was closed — opening new tab');
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
  }

  const encoded = encodeURIComponent(searchTerm);
  const REED_AGE = { r86400: 'LastDay', r259200: 'LastThreeDays', r604800: 'LastWeek', r1209600: 'LastTwoWeeks', r2592000: 'LastMonth' };
  const ageParam = cfg.JOB_AGE && cfg.JOB_AGE !== 'any' ? `&datecreatedoffset=${REED_AGE[cfg.JOB_AGE] || 'LastTwoWeeks'}` : '';
  const url = `https://www.reed.co.uk/jobs?keywords=${encoded}&sortby=DisplayDate${ageParam}`;

  console.log(`\n  [Reed] Searching: "${searchTerm}"`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await DELAY(4000);

  // Dismiss cookie banner if present
  try {
    await page.click('#onetrust-accept-btn-handler, button:has-text("Accept all"), button:has-text("Accept cookies")', { timeout: 3000 });
    await DELAY(1000);
  } catch (_) {}

  // Scroll to load more results
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await DELAY(800);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SSDIR}/reed_search_results.png` });

  // Dump page title + URL for debugging
  const pageTitle = await page.title();
  console.log(`  [Reed] Page: "${pageTitle}" | URL: ${page.url()}`);

  const jobs = await page.evaluate((lim) => {
    // Dump first 5 article tags to help diagnose selector issues
    const allArticles = Array.from(document.querySelectorAll('article')).slice(0, 5);
    console.log('[Reed debug] articles found:', allArticles.length,
      allArticles.map(a => a.className + ' | data-id=' + a.getAttribute('data-id')).join(' :: '));

    // Reed job card selectors — broad fallback chain
    const cardSelectors = [
      'article[data-id]',
      '[data-gtm-class="job-listing"]',
      '[data-testid="job-card"]',
      '.job-result',
      '.j-search-result',
      'article[class*="job"]',
      'article',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 2) break;
    }
    cards = cards.slice(0, lim);

    return cards.map(card => {
      const titleEl   = card.querySelector(
        'h2 a, h3 a, .title a, [data-testid="job-title"] a, a[data-gtm="job-title"], a[class*="title"]'
      );
      const companyEl = card.querySelector(
        '.recruiter, .employer, [data-testid="employer-name"], .gtmJobListingPostedBy, a[data-gtm="company"], [class*="company"]'
      );
      const linkEl    = card.querySelector('a[href*="/jobs/"]');
      const dataId    = card.getAttribute('data-id') || '';

      const href  = (titleEl || linkEl) ? ((titleEl || linkEl).getAttribute('href') || '') : '';
      const idFromHref = href.match(/\/jobs\/(\d+)\//)?.[1] || '';
      const jobId = 'reed_' + (dataId || idFromHref);

      return {
        title:   titleEl   ? titleEl.innerText.trim()   : 'Unknown',
        company: companyEl ? companyEl.innerText.trim() : 'Unknown',
        url:     href ? (href.startsWith('http') ? href : 'https://www.reed.co.uk' + href) : '',
        jobId,
      };
    }).filter(j => j.url && j.jobId !== 'reed_');
  }, limit);

  console.log(`  [Reed] Found ${jobs.length} jobs for "${searchTerm}"`);
  return { jobs, page };  // return updated page in case it was recreated
}

// ── GET JOB DESCRIPTION ────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  await page.goto(job.url, { waitUntil: 'networkidle', timeout: 60000 });
  await DELAY(4000);

  const fullJD = await page.evaluate(() => {
    // Try specific Reed selectors first
    const descSelectors = [
      '#jobDescriptionContainerDivId',
      '[data-qa="job-description"]',
      '[itemprop="description"]',
      '.description',
      '[data-testid="job-description"]',
      '[data-testid="job-description-container"]',
      '.job-description',
      '.job-description-copy',
      '.col-description',
      'article .content',
      '[class*="description"]',
      '[class*="job-details"]',
    ];
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 80) return el.innerText.trim();
    }
    // Broad fallback: find the longest text block on the page
    const candidates = Array.from(document.querySelectorAll('div, section, article'))
      .filter(el => el.children.length < 20)
      .map(el => el.innerText.trim())
      .filter(t => t.length > 150);
    if (candidates.length) {
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0].substring(0, 8000);
    }
    const main = document.querySelector('main, [role="main"]');
    return main ? main.innerText.trim().substring(0, 8000) : '';
  });

  // Detect training course listings (Reed shows "Training Course" in the salary field)
  const isTrainingCourse = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return text.includes('training course') ||
           text.includes('training programme') ||
           text.includes('no experience required') && text.includes('placement programme') ||
           !!document.querySelector('[class*="salary"],[data-qa*="salary"],[class*="compensation"]') &&
           (document.querySelector('[class*="salary"],[data-qa*="salary"],[class*="compensation"]')?.innerText || '').toLowerCase().includes('training');
  });

  // Detect external-only listings (must apply on company website — not via Reed)
  const isExternalOnly = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    if (text.includes('apply on company website') ||
        text.includes('apply on employer') ||
        text.includes('apply via employer') ||
        text.includes('visit employer website') ||
        text.includes('external application') ||
        text.includes('apply externally') ||
        text.includes('apply at employer') ||
        text.includes("apply on the employer's website") ||
        text.includes("apply on the company's website")) return true;
    const allEls = Array.from(document.querySelectorAll('button, a'));
    // Check button/link text
    const hasExternalText = allEls.some(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return t.includes('apply on company') || t.includes('apply on employer') ||
             t.includes('visit employer') || t.includes('apply via employer') ||
             t.includes('apply externally') || t === 'apply at employer';
    });
    if (hasExternalText) return true;
    // Check if the primary Apply button's href points outside reed.co.uk
    const applyBtn = allEls.find(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return t === 'apply' || t === 'apply now' || t.includes('quick apply') || t.includes('apply online');
    });
    if (applyBtn && applyBtn.href &&
        applyBtn.href.startsWith('http') &&
        !applyBtn.href.includes('reed.co.uk')) return true;
    return false;
  });

  // Check whether a Reed-hosted Quick Apply form is available (only if not external-only)
  const hasQuickApply = !isExternalOnly && await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('button, a'));
    return allEls.some(el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return t === 'apply' ||
             t === 'apply now' ||
             t.includes('quick apply') ||
             t.includes('apply online');
    });
  });

  await page.screenshot({ path: `${SSDIR}/reed_job_page_check.png` });
  console.log(`  [Reed JD] ${fullJD.length} chars | Quick Apply: ${hasQuickApply} | External only: ${isExternalOnly} | Training course: ${isTrainingCourse}`);

  return { ...job, description: fullJD, hasEasyApply: hasQuickApply, isTrainingCourse };
}

// ── APPLY TO JOB ───────────────────────────────────────────────────────────
async function applyToJob(page, job, resumePath) {
  console.log(`  [Reed] Applying: ${job.title} @ ${job.company}`);

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(4000);

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

  // If the same tab redirected outside reed.co.uk — external application
  const currentUrl = page.url();
  if (!currentUrl.includes('reed.co.uk')) {
    console.log('  [Reed] External application redirect — skipping:', currentUrl.substring(0, 80));
    return 'external';
  }

  // Check for a new tab/popup that opened to an external site
  const popupPage = await newPagePromise;
  if (popupPage && popupPage !== page) {
    // Wait for it to navigate away from about:blank if still loading
    if (!popupPage.url() || popupPage.url() === 'about:blank') {
      await popupPage.waitForURL(u => u !== 'about:blank', { timeout: 3000 }).catch(() => {});
    }
    const popupUrl = popupPage.url();
    if (!popupUrl.includes('reed.co.uk')) {
      console.log('  [Reed] External application opened in new tab — skipping:', popupUrl.substring(0, 80));
      await popupPage.close().catch(() => {});
      return 'external';
    }
  }

  // Sweep all open tabs — close any non-reed external tabs
  for (const p of page.context().pages()) {
    if (p !== page && !p.url().includes('reed.co.uk') && p.url() !== 'about:blank') {
      console.log('  [Reed] Closing external tab:', p.url().substring(0, 80));
      await p.close().catch(() => {});
      return 'external';
    }
  }

  // Fill and submit the Reed application form
  await fillContactFields(page);
  await uploadResume(page, resumePath);

  // Wait for Reed to process the uploaded CV
  await DELAY(3000);

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

  await answerScreeningQuestions(page);
  await fillCoverLetter(page, job);

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
  const fills = [
    { sel: 'input[name*="firstName" i], input[id*="firstName" i], input[placeholder*="First name" i]', val: firstName },
    { sel: 'input[name*="lastName" i], input[id*="lastName" i], input[placeholder*="Last name" i]',   val: lastName  },
    { sel: 'input[name*="phone" i], input[id*="phone" i], input[type="tel"]',                          val: phone     },
    { sel: 'input[name*="email" i], input[id*="email" i], input[type="email"]',                        val: email     },
  ];
  for (const { sel, val } of fills) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        const cur = await el.inputValue();
        if (!cur) await el.fill(val);
      }
    } catch (_) {}
  }
}

async function uploadResume(page, resumePath) {
  try {
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
          console.log('  [Reed] Tailored CV uploaded successfully.');
          return;
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
      console.log('  [Reed] Tailored CV uploaded via file input.');
      return;
    }

    await page.screenshot({ path: `${SSDIR}/reed_cv_upload_state.png` });
    console.log('  [Reed] Could not upload CV — screenshot saved.');
  } catch (err) {
    console.log('  [Reed] CV upload error:', err.message);
  }
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

      if (text) await ta.fill(text).catch(() => {});
    }
  } catch (_) {}
}

async function answerScreeningQuestions(page) {
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
      if (/sponsor|visa|right to work|work permit|require.*sponsor/i.test(question)) {
        const needs = cfg.APPLICANT.requiresSponsorship;
        target = options.find(o => needs ? o.label.startsWith('yes') : o.label.startsWith('no'));
      } else if (/commut|travel to|able to.*office|willing to.*office/i.test(question)) {
        target = options.find(o => o.label.startsWith('yes'));
      } else if (/reloc/i.test(question)) {
        target = cfg.APPLICANT.willingToRelocate
          ? options.find(o => o.label.startsWith('yes'))
          : options.find(o => o.label.startsWith('no'));
      } else if (/driving.*licen|licen.*driving|valid.*licen/i.test(question)) {
        target = cfg.APPLICANT.drivingLicence
          ? options.find(o => o.label.startsWith('yes'))
          : options.find(o => o.label.startsWith('no'));
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
      } else if (/experience|have you|familiar|worked with|authoris|authoriz|eligible/i.test(question)) {
        target = options.find(o => o.label.startsWith('yes'));
      } else if (/british|uk citizen|nationality/i.test(question)) {
        target = options.find(o => o.label.startsWith('yes'));
      } else {
        target = options.find(o => o.label.startsWith('yes')) || options[0];
      }

      if (target) {
        const already = await target.radio.isChecked().catch(() => false);
        if (!already) await target.radio.click().catch(() => {});
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
      if (/sponsor|visa|right to work/i.test(question)) {
        const needs = cfg.APPLICANT.requiresSponsorship;
        chosen = nonEmpty.find(o => needs ? o.text.startsWith('yes') : o.text.startsWith('no')) || nonEmpty[0];
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
        chosen = nonEmpty.find(o => o.text === 'yes' || o.text.startsWith('yes')) || nonEmpty[0];
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

      if (/sponsor|visa|right to work/i.test(question)) {
        await inp.fill(cfg.APPLICANT.requiresSponsorship ? 'Yes' : 'No').catch(() => {});
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
      } else {
        const type = await inp.getAttribute('type');
        if (type === 'number') await inp.fill(String(cfg.APPLICANT.yearsExperience || 0)).catch(() => {});
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

module.exports = { login, searchJobs, getJobDescription, applyToJob };
