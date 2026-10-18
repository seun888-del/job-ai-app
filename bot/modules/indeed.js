const cfg     = require('../config');
const path    = require('path');
const captcha = require('./captcha_solver');
const { humanWarmup, waitForCloudflareSolve } = require('./browser_launcher');
const { llmAvailable, llmChat } = require('../../src/services/llm');
const { promptLogin } = require('./login_prompt');
const ai = require('./question_ai'); // LLM fallback for unknown screening questions

const SSDIR = cfg.SCREENSHOTS_DIR;
const DELAY = ms => new Promise(r => setTimeout(r, ms));

function getBaseUrl() {
  return (cfg.APPLICANT.country === 'United States') ? 'https://www.indeed.com' : 'https://uk.indeed.com';
}

// ── Login ──────────────────────────────────────────────────────────────────
// Uses a persistent Chrome profile set up via the app's "Connect" button.
// No form interaction — bot detection cannot fire during login.
// Signed in = the header has no "Sign in" link (signed-out pages show one; signed-in
// pages show the account / messages / notifications icons instead).
async function indeedSignedIn(page) {
  if (!/indeed\.com/.test(page.url()) || /\/account\/login|secure\.indeed\.com\/auth/.test(page.url())) return false;
  return page.evaluate(() => {
    const header = document.querySelector('header, #gnav-main-container, [data-testid="gnav"]') || document.body;
    const links = [...header.querySelectorAll('a, button')].map(a => (a.innerText || '').trim().toLowerCase());
    if (links.includes('sign in')) return false;
    return !!header.querySelector('[data-gnav-element-name="Profile"], [data-gnav-element-name="Messages"], a[href*="/account/view"], a[href*="/myjobs"], [aria-label*="Profile" i], [aria-label*="Account" i]')
      || links.some(t => t === 'sign out');
  }).catch(() => false);
}

// Indeed blocks every page behind an "Updates to our Terms of Service" popup until the
// account holder accepts. The agent never accepts terms for the user: it brings its
// window forward and waits for them to click Accept Terms themselves.
async function termsPopupShowing(page) {
  return page.evaluate(() => /updates to our terms of service/i.test(document.body?.innerText || '')
    && [...document.querySelectorAll('button')].some(b => /accept terms/i.test(b.innerText || ''))).catch(() => false);
}
async function handleTermsPopup(page) {
  if (!(await termsPopupShowing(page))) return;
  await promptLogin(page, {
    site: 'Indeed', isSignedIn: async (p) => !(await termsPopupShowing(p)),
    message: "Indeed has updated its Terms of Service. Read them in the Indeed window and click Accept Terms if you agree. The agent carries on once they're accepted.",
  });
}

async function ensureLoggedIn(page) {
  const baseUrl = getBaseUrl();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForCloudflareSolve(page);
  await DELAY(2000);
  if (!(await indeedSignedIn(page))) {
    const co = cfg.APPLICANT.country === 'United States' ? 'US' : 'GB';
    await promptLogin(page, {
      site: 'Indeed',
      loginUrl: `https://secure.indeed.com/account/login?co=${co}&continue=${encodeURIComponent(baseUrl + '/')}`,
      isSignedIn: indeedSignedIn,
    });
  }
  await handleTermsPopup(page);
  console.log('  [Indeed] Session active');
}

// Indeed's own apply button. US pages render it as plain "Apply now" text (no stable id),
// while external jobs say "Apply on company site".
const APPLY_NOW_RE = /^(apply now|easily apply)$/i;
async function findApplyNow(page) {
  const byId = page.locator('#indeedApplyButton, button[class*="ia-IndeedApply-button"], button[data-testid="indeed-apply-button"]').first();
  if (await byId.count().catch(() => 0) && await byId.isVisible().catch(() => false)) return byId;
  const byText = page.getByText(APPLY_NOW_RE).first();
  if (await byText.count().catch(() => 0) && await byText.isVisible().catch(() => false)) return byText;
  return null;
}

// ── Search Jobs ────────────────────────────────────────────────────────────
async function searchJobs(page, searchTerm, limit = 25) {
  const baseUrl = getBaseUrl();
  const encoded = encodeURIComponent(searchTerm);

  // Convert JOB_AGE (seconds like 'r1209600') → fromage days
  const jobAgeSecs = cfg.JOB_AGE ? parseInt((cfg.JOB_AGE || '').replace('r', ''), 10) : 1209600;
  const fromage = Math.max(1, Math.round((isNaN(jobAgeSecs) ? 1209600 : jobAgeSecs) / 86400));

  // Employment type
  const jtMap = { permanent: 'fulltime', contract: 'contract,temporary', any: '' };
  const jt = jtMap[cfg.CONTRACT_TYPE] || '';
  const jtParam = jt ? `&jt=${encodeURIComponent(jt)}` : '';

  // sc=0kf:attr(DSQF7) = "Easily Apply" filter
  const url = `${baseUrl}/jobs?q=${encoded}&l=Remote&sc=0kf%3Aattr%28DSQF7%29%3B&sort=date&fromage=${fromage}${jtParam}`;

  console.log(`\n  [Indeed] Searching: "${searchTerm}" (Remote, Easily Apply, last ${fromage} days)`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await humanWarmup(page);
  await DELAY(3000);

  // Scroll to load more cards
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await DELAY(700);
  }

  const jobs = await page.evaluate((lim) => {
    // Try multiple card selector strategies across Indeed versions
    const cardSelectors = [
      '.job_seen_beacon',
      '[data-testid="slider_container"]',
      '.jobCard',
      '.resultContent',
      'li[class*="css-"] [data-jk]',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    if (!cards.length) {
      // Fallback: collect all [data-jk] elements' parent containers
      const jkEls = Array.from(document.querySelectorAll('[data-jk]'));
      const seen  = new Set();
      cards = jkEls
        .map(el => el.closest('li, article, [class*="resultContent"]') || el.parentElement)
        .filter(el => el && !seen.has(el) && seen.add(el));
    }

    return cards.slice(0, lim).map(card => {
      const titleEl   = card.querySelector('.jobTitle a, h2.jobTitle a, a[data-jk], [data-testid="job-title"] a, [class*="jobTitle"] a');
      const companyEl = card.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]');
      const jkEl      = card.querySelector('[data-jk]') || titleEl;
      const jobKey    = jkEl?.getAttribute('data-jk') ||
                        titleEl?.getAttribute('href')?.match(/jk=([a-f0-9]+)/)?.[1] || '';

      const hasEasyApplyBadge = !!card.querySelector('[class*="easily-apply"], [class*="EasyApply"], [class*="indeedApply"]') ||
                                 (card.innerText || '').toLowerCase().includes('easily apply');

      return {
        title:             (titleEl?.innerText || '').trim(),
        company:           (companyEl?.innerText || '').trim(),
        jobId:             'indeed_' + jobKey,
        jobKey,
        url:               jobKey ? `${window.location.origin}/viewjob?jk=${jobKey}` : '',
        hasEasyApplyBadge,
      };
    }).filter(j => j.jobKey && j.title);
  }, limit);

  console.log(`  [Indeed] Found ${jobs.length} jobs for "${searchTerm}"`);
  return jobs;
}

// ── Get Job Description ────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  const baseUrl  = getBaseUrl();
  const viewUrl  = job.jobKey
    ? `${baseUrl}/viewjob?jk=${job.jobKey}`
    : job.url;

  await page.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await DELAY(3000);
  await handleTermsPopup(page);

  // Expand "Show more" if present
  const showMoreSelectors = [
    'button:has-text("Show more")',
    '[aria-label*="Show more"]',
    '#jobDescriptionText button',
    '.jobsearch-pj-description button',
  ];
  for (const sel of showMoreSelectors) {
    try { await page.click(sel, { timeout: 2000 }); await DELAY(1000); break; } catch (_) {}
  }

  const { description, hasEasyApply, isExternalApply } = await page.evaluate(() => {
    // Description extraction
    const descSelectors = [
      '#jobDescriptionText',
      '[data-testid="jobDescriptionText"]',
      '.jobsearch-JobComponent-description',
      '[class*="job-description"]',
      '#job-description',
    ];
    let desc = '';
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) { desc = el.innerText.trim(); break; }
    }
    if (!desc) {
      const main = document.querySelector('main, [role="main"]');
      if (main) desc = main.innerText.trim().substring(0, 8000);
    }

    // Detect Indeed Apply button (stays on indeed.com) vs external company apply
    const hasIndeedApplyBtn = !!document.querySelector(
      '#indeedApplyButton, [class*="ia-IndeedApply-button"], [data-testid="indeed-apply-button"], [class*="indeedApply"] button'
    ) || [...document.querySelectorAll('button, a, [role="button"]')].some(b => /^(apply now|easily apply)$/i.test((b.innerText || '').trim()));
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const isExternal = !hasIndeedApplyBtn && (
      bodyText.includes('apply on company site') ||
      bodyText.includes('apply on employer site') ||
      bodyText.includes('apply on partner site') ||
      bodyText.includes('apply directly')
    );

    return {
      description: desc,
      hasEasyApply: hasIndeedApplyBtn || (!isExternal && bodyText.includes('easily apply')),
      isExternalApply: isExternal,
    };
  });

  await page.screenshot({ path: path.join(SSDIR, 'indeed_job_check.png') }).catch(() => {});
  const type = isExternalApply ? 'EXTERNAL' : hasEasyApply ? 'EASY APPLY' : 'UNKNOWN';
  console.log(`  [Indeed] JD: ${description.length} chars | Apply type: ${type}`);
  return { ...job, description, hasEasyApply: hasEasyApply && !isExternalApply };
}

// ── Apply to Job ────────────────────────────────────────────────────────────
async function applyToJob(page, job, resumePath) {
  console.log(`  [Indeed] Applying: ${job.title} @ ${job.company}`);

  const baseUrl = getBaseUrl();
  const viewUrl = job.jobKey ? `${baseUrl}/viewjob?jk=${job.jobKey}` : job.url;

  await page.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCloudflareSolve(page);
  await DELAY(4000);
  await handleTermsPopup(page);

  // Check already applied
  const alreadyApplied = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase();
    return t.includes('application submitted') || t.includes('you applied') || t.includes('already applied');
  });
  if (alreadyApplied) {
    console.log('  [Indeed] Already applied — skipping.');
    return null;
  }

  await page.screenshot({ path: path.join(SSDIR, 'indeed_before_apply.png') }).catch(() => {});

  // Click the Indeed Apply button — may open a popup or navigate
  let applyPage = page;
  let clicked   = false;

  const applySelectors = [
    '#indeedApplyButton',
    'button[class*="ia-IndeedApply-button"]',
    'button[data-testid="indeed-apply-button"]',
    'button:has-text("Apply now")',
    'a:has-text("Apply now")',
    '[class*="indeedApply"] button',
  ];

  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (!btn || !await btn.isVisible()) continue;

      // Listen for a new page (popup) before clicking
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
        btn.click(),
      ]);

      if (newPage) {
        applyPage = newPage;
        await applyPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await DELAY(3000);
      } else {
        await DELAY(4000);
        // Check if current page navigated to smartapply
        if (page.url().includes('smartapply.indeed.com') || page.url().includes('/indeedapply/')) {
          applyPage = page;
        }
      }
      clicked = true;
      break;
    } catch (_) {}
  }

  if (!clicked) {
    const btn = await findApplyNow(page);
    if (btn) {
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
        btn.click().catch(() => {}),
      ]);
      if (newPage) { applyPage = newPage; await applyPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}); }
      await DELAY(4000);
      clicked = true;
    }
  }

  if (!clicked) {
    await page.screenshot({ path: path.join(SSDIR, 'indeed_no_apply_btn.png') }).catch(() => {});
    throw new Error('Indeed Apply button not found');
  }

  await applyPage.screenshot({ path: path.join(SSDIR, 'indeed_apply_01.png') }).catch(() => {});

  // Check if we ended up on an external ATS — abort
  const firstUrl = applyPage.url();
  if (firstUrl && !firstUrl.includes('indeed.com') && !firstUrl.includes('smartapply.indeed.com')) {
    console.log(`  [Indeed] Redirected to external ATS: ${firstUrl} — skipping`);
    return false;
  }

  return fillEasyApplyForm(applyPage, job, resumePath);
}

// Exported so Glassdoor (and others) can reuse the form-filling loop on an
// already-open Indeed apply tab without navigating to the job URL first.
async function fillEasyApplyForm(applyPage, job, resumePath) {
  let stepCount = 0;
  const MAX_STEPS = 12;
  let lastUrl = '', sameUrl = 0;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    await DELAY(2500);

    const currentUrl = applyPage.url();

    // Detect external ATS redirect mid-application
    if (currentUrl && !currentUrl.includes('indeed.com') && !currentUrl.includes('smartapply')) {
      console.log(`  [Indeed] Mid-apply redirect to external site — aborting`);
      return false;
    }

    await applyPage.screenshot({ path: path.join(SSDIR, `indeed_apply_step${stepCount}.png`) }).catch(() => {});
    // Continue pressed but the page didn't move: report what the form complains about, then stop.
    sameUrl = currentUrl === lastUrl ? sameUrl + 1 : 0; lastUrl = currentUrl;
    if (sameUrl >= 2) {
      const errs = await applyPage.evaluate(() => [...document.querySelectorAll('[role="alert"], [class*="error" i], [id*="error" i]')]
        .map(e => (e.innerText || '').trim()).filter(t => t && t.length < 200)).catch(() => []);
      console.log(`  [Indeed] Stuck on the same page.${errs.length ? ' Form says: ' + [...new Set(errs)].slice(0, 5).join(' | ') : ''}`);
      await applyPage.screenshot({ path: path.join(SSDIR, 'indeed_stuck_full.png'), fullPage: true }).catch(() => {});
      return false;
    }

    // Solve Cloudflare Turnstile mid-form if it appears (blocks Continue/Submit)
    if (cfg.CAPSOLVER_KEY) {
      const hasTurnstile = await applyPage.evaluate(() =>
        !!document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"]') ||
        !!document.querySelector('iframe[src*="turnstile"]') ||
        (document.body?.innerText || '').toLowerCase().includes('verify you are human')
      ).catch(() => false);
      if (hasTurnstile) {
        console.log(`  [Indeed] Turnstile on step ${stepCount} — solving via CapSolver...`);
        await captcha.solveTurnstile(applyPage).catch(() => false);
        await DELAY(2000);
      }
    }

    // Resume upload
    await _handleResumeStep(applyPage, resumePath);

    // Contact info
    await _fillContactFields(applyPage);

    // Screening questions (radio, select, text, textarea, checkbox)
    await _answerQuestions(applyPage, job);

    // Try submit first
    const submitted = await _trySubmit(applyPage, job);
    if (submitted) {
      console.log('  [Indeed] ✓ Application submitted!');
      await DELAY(3000);
      await applyPage.screenshot({ path: path.join(SSDIR, 'indeed_submitted.png') }).catch(() => {});
      return true;
    }

    // Try continue/next
    let advanced = await _tryContinue(applyPage);
    // A slow step leaves Continue disabled behind a spinner for a few seconds: wait, then retry once.
    if (!advanced) { await DELAY(6000); advanced = await _tryContinue(applyPage); }
    if (!advanced) {
      console.log(`  [Indeed] Could not advance from step ${stepCount}.`);
      const errs = await applyPage.evaluate(() => [...document.querySelectorAll('[role="alert"], [class*="error" i], [id*="error" i]')]
        .map(e => (e.innerText || '').trim()).filter(t => t && t.length < 200)).catch(() => []);
      if (errs.length) console.log(`  [Indeed] Form says: ${[...new Set(errs)].slice(0, 5).join(' | ')}`);
      await applyPage.screenshot({ path: path.join(SSDIR, `indeed_stuck_step${stepCount}.png`) }).catch(() => {});
      break;
    }
  }

  return false;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function _handleResumeStep(page, resumePath) {
  try {
    const uploadNewSelectors = [
      'button:has-text("Upload new resume")',
      'button:has-text("Upload a resume")',
      'button:has-text("Use a different resume")',
      'button:has-text("Replace resume")',
      'label:has-text("Upload")',
    ];
    for (const frame of _allFrames(page)) {
      for (const sel of uploadNewSelectors) {
        const btn = await frame.$(sel).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click();
          await DELAY(2000);
          break;
        }
      }

      // Direct file input
      const fileInput = await frame.$('input[type="file"]').catch(() => null);
      if (fileInput) {
        await fileInput.setInputFiles(resumePath);
        await DELAY(2500);
        console.log('  [Indeed] Resume uploaded.');
        return;
      }

      // File chooser via label/button
      const uploadTrigger = await frame.$('[data-testid="FileUploadInput"], [data-testid="upload-button"], label[for*="file" i]').catch(() => null);
      if (uploadTrigger) {
        const [chooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 3000 }),
          uploadTrigger.click(),
        ]);
        await chooser.setFiles(resumePath);
        await DELAY(2500);
        console.log('  [Indeed] Resume uploaded via file chooser.');
        return;
      }
    }
  } catch (_) {}
}

async function _fillContactFields(page) {
  const { firstName, lastName, phone, email, location } = cfg.APPLICANT;

  const fills = [
    {
      sels: ['input[aria-label*="First name" i]', 'input[id*="firstName"]', 'input[name*="firstName"]', 'input[autocomplete="given-name"]'],
      val: firstName,
    },
    {
      sels: ['input[aria-label*="Last name" i]', 'input[id*="lastName"]', 'input[name*="lastName"]', 'input[autocomplete="family-name"]'],
      val: lastName,
    },
    {
      sels: ['input[type="tel"]', 'input[aria-label*="Phone" i]', 'input[id*="phone"]', 'input[name*="phone"]'],
      val: phone,
    },
    {
      sels: ['input[type="email"]', 'input[aria-label*="Email" i]', 'input[id*="email"]'],
      val: email,
    },
    {
      sels: ['input[aria-label*="City" i]', 'input[aria-label*="Location" i]', 'input[id*="location"]', 'input[name*="location"]'],
      val: location,
    },
  ];

  for (const { sels, val } of fills) {
    if (!val) continue;
    let filled = false;
    for (const frame of _allFrames(page)) {
      if (filled) break;
      for (const sel of sels) {
        try {
          const el = await frame.$(sel);
          if (el && await el.isVisible()) {
            const current = await el.inputValue();
            // Indeed pre-fills the phone from the account; a stale/invalid one blocks Continue,
            // so replace it whenever its digits don't match the profile's number.
            const isPhone = val === phone;
            const digits = (x) => String(x || '').replace(/\D/g, '');
            const national = digits(val).replace(/^(1(?=\d{10}$)|44(?=\d{10}$))/, '').replace(/^0(?=7\d{9}$)/, '');
            if (isPhone) {
              // Country code first (switching it can reformat the box), then always our number.
              const cc = (_phoneCountry(val) || {}).code || '';
              await _matchPhoneCountry(frame, el, val);
              const want = cc ? '+' + cc + national : national;
              if (digits(await el.inputValue().catch(() => '')) !== digits(want)) {
                // Type it in international form: the box detects the country from the "+".
                await el.click(); await el.fill(''); await DELAY(150);
                await el.type(want, { delay: 55 + Math.random() * 75 });
                await el.press('Tab').catch(() => {});
                await DELAY(300 + Math.random() * 150);
              }
            } else if (!current) {
              await el.click(); await DELAY(80 + Math.random() * 120);
              await el.type(val, { delay: 55 + Math.random() * 75 });
              await DELAY(100 + Math.random() * 150);
            }
            filled = true;
            break;
          }
        } catch (_) {}
      }
    }
  }
}

// The phone box has a country-code picker that defaults to the site's country (+1 on
// indeed.com). A UK mobile (07... / +44) under +1 is rejected, so pick the matching code.
function _phoneCountry(raw) {
  const t = String(raw || '').trim();
  const d = t.replace(/\D/g, '');
  if (/^\+?44/.test(t) || /^07\d{9}$/.test(d)) return { code: '44', iso: 'GB', name: 'United Kingdom' };
  if (/^\+?1/.test(t) || /^\d{10}$/.test(d)) return { code: '1', iso: 'US', name: 'United States' };
  return null;
}
async function _matchPhoneCountry(frame, telEl, raw) {
  const want = _phoneCountry(raw);
  if (!want) return;
  try {
    const box = await telEl.evaluateHandle((el) => {
      let b = el.parentElement;
      for (let i = 0; i < 5 && b && !b.querySelector('select, button, [role="combobox"]'); i++) b = b.parentElement;
      return b;
    });
    const sel = await box.$('select');
    if (sel) {
      const val = await sel.evaluate((s, w) => {
        const re = new RegExp(`\\+${w.code}(\\D|$)|^${w.iso}$|${w.name}`, 'i');
        const o = [...s.options].find(o => re.test(o.text) || re.test(o.value));
        return o ? o.value : null;
      }, want);
      if (val && val !== await sel.inputValue()) { await sel.selectOption(val); console.log(`  [Indeed] Phone country set to +${want.code}`); }
      return;
    }
    const btn = await box.$('button, [role="combobox"]');
    if (!btn) return;
    const shown = (await btn.innerText().catch(() => '')) || '';
    if (shown.includes('+' + want.code)) return;
    await btn.click(); await DELAY(600);
    const opt = frame.locator('[role="option"], li').filter({ hasText: new RegExp(`${want.name}|\\+${want.code}\\b`) }).first();
    if (await opt.count()) { await opt.click(); console.log(`  [Indeed] Phone country set to +${want.code}`); }
    else console.log('  [Indeed] Phone country picker: option not found');
  } catch (e) { console.log(`  [Indeed] Phone country picker: ${e.message.slice(0, 80)}`); }
}

function _resolveRadio(question, labels, { allowUnknown = true } = {}) {
  const q = (question || '').toLowerCase();
  const { requiresSponsorship, willingToRelocate, drivingLicence, eeoGender, eeoDisability, eeoVeteran, eeoEthnicity } = cfg.APPLICANT;

  const find = re => labels.find(l => re.test(l));

  if (/right to work|work permit|authoris.*work|authoriz.*work|eligible.*work|legal.*work/i.test(q)) {
    return (!requiresSponsorship) ? (find(/^yes/i) || labels[0]) : (find(/^no/i) || labels[labels.length - 1]);
  }
  if (/require.*sponsor|need.*sponsor|visa.*sponsor|employer.*sponsor/i.test(q)) {
    return requiresSponsorship ? find(/^yes/i) : find(/^no/i);
  }
  if (/reloc/i.test(q)) return willingToRelocate ? find(/^yes/i) : find(/^no/i);
  // Marketing / job-alert opt-ins (often a third party's terms): never sign the user up.
  if (/opt.?in|newsletter|marketing|receiv\w* (email|text|sms)|text messages|contacted by (text|sms)|email notifications|job alerts/i.test(q) && !/required|must/i.test(q)) {
    return find(/^no/i) || labels[labels.length - 1];
  }
  // Spoken languages other than English: never claim a skill the profile doesn't list.
  if (/(speak|fluen|proficien|bilingual|language)/i.test(q) && /spanish|french|german|portuguese|italian|mandarin|chinese|japanese|korean|arabic|russian|hindi|polish|dutch|vietnamese|tagalog|bilingual/i.test(q)) {
    return find(/^(no|none|not|cannot|i cannot|i can't|beginner|basic|elementary)/i) || find(/no|none|cannot|not /i) || labels[labels.length - 1];
  }
  if (/commut|travel.*office|willing.*office|able.*office/i.test(q)) return find(/^yes/i);
  if (/driving.*licen|licen.*driving/i.test(q)) return drivingLicence ? find(/^yes/i) : find(/^no/i);
  if (/gender/i.test(q)) {
    if (eeoGender === 'female') return find(/female|woman/i);
    if (eeoGender === 'nonbinary') return find(/non.?binary|other/i);
    if (!eeoGender) return find(/prefer not|decline/i) || labels[labels.length - 1];
    return find(/\bmale\b|\bman\b/i);
  }
  if (/disability|disabled/i.test(q)) {
    if (eeoDisability === 'yes') return find(/^yes/i);
    if (eeoDisability === 'no') return find(/^no/i);
    return find(/prefer not|decline/i) || labels[labels.length - 1];
  }
  if (/veteran|military/i.test(q)) {
    if (eeoVeteran === 'yes') return find(/^yes|^i am/i);
    if (eeoVeteran === 'no') return find(/^no|^not a/i);
    return find(/prefer not|decline/i) || labels[labels.length - 1];
  }
  if (/ethnic|race/i.test(q)) {
    if (!eeoEthnicity) return find(/prefer not|decline/i) || labels[labels.length - 1];
    if (eeoEthnicity === 'white') return find(/white/i);
    if (eeoEthnicity === 'black') return find(/black/i);
    if (eeoEthnicity === 'asian') return find(/asian/i);
    if (eeoEthnicity === 'hispanic') return find(/hispanic|latino/i);
    return find(/prefer not|decline/i) || labels[labels.length - 1];
  }
  // For "do you currently X / are you bound by / have you ever" questions, "No" is the safe default.
  // For "are you comfortable / willing / able" questions, "Yes" is right.
  if (!allowUnknown) return null;
  const isNegativePattern = /do you currently|are you bound|have you ever|non.?compete|restrict|conflict|partner.*compan|compan.*partner|nda|lawsuit|terminat/i.test(q);
  const fallback = isNegativePattern
    ? (find(/^no/i) || labels[labels.length - 1])
    : (find(/^yes/i) || labels[0]);
  if (q) console.log(`  [Indeed] Unknown radio: "${question.substring(0, 80)}" → "${fallback}"`);
  return fallback;
}

function _resolveDropdown(question, options) {
  const q = (question || '').toLowerCase();
  const { yearsExperience, requiresSponsorship, willingToRelocate, drivingLicence, eeoGender, eeoDisability, eeoVeteran, eeoEthnicity, salaryExpectation } = cfg.APPLICANT;
  const yr = yearsExperience ?? 0;

  const find = re => options.find(o => re.test(o.text));

  if (/right to work|work permit|authoris.*work|authoriz.*work|eligible.*work|legal.*work/i.test(q)) {
    return (!requiresSponsorship) ? find(/^yes/i) : find(/^no/i);
  }
  if (/require.*sponsor|need.*sponsor|visa.*sponsor/i.test(q)) {
    return requiresSponsorship ? find(/^yes/i) : find(/^no/i);
  }
  if (/reloc/i.test(q)) return willingToRelocate ? find(/^yes/i) : find(/^no/i);
  if (/commut|travel.*office|able.*office/i.test(q)) return find(/^yes/i);
  if (/driving.*licen/i.test(q)) return drivingLicence ? find(/^yes/i) : find(/^no/i);
  if (/year.*experience|experience.*year|how many year|how long/i.test(q)) {
    return options.find(o => new RegExp(`\\b${yr}\\b`).test(o.text)) ||
           options.find(o => { const n = o.text.match(/\d+/g); return n?.length >= 2 && yr >= +n[0] && yr <= +n[1]; }) ||
           options.find(o => { const n = o.text.match(/\d+/g); return n && /\+|more|above|over/.test(o.text) && yr >= +n[0]; }) ||
           options[options.length - 1];
  }
  if (/education|qualif|degree/i.test(q)) {
    return find(/bachelor|degree|university/i) || options[Math.floor(options.length / 2)];
  }
  if (/salary|compensation|expected pay/i.test(q)) {
    if (salaryExpectation) {
      const num = parseInt(salaryExpectation.replace(/[^0-9]/g, ''), 10);
      return options.find(o => {
        const nums = o.text.match(/\d[\d,]*/g);
        if (nums?.length >= 2) return num >= parseInt(nums[0].replace(/,/g, ''), 10) && num <= parseInt(nums[1].replace(/,/g, ''), 10);
        return false;
      }) || options[Math.floor(options.length / 2)];
    }
    return options[Math.floor(options.length / 2)];
  }
  if (/gender/i.test(q)) {
    if (!eeoGender) return find(/prefer not|decline/i) || options[options.length - 1];
    if (eeoGender === 'female') return find(/female|woman/i);
    if (eeoGender === 'nonbinary') return find(/non.?binary|other/i);
    return find(/\bmale\b|\bman\b/i);
  }
  if (/disability/i.test(q)) {
    if (!eeoDisability) return find(/prefer not|decline/i) || options[options.length - 1];
    return eeoDisability === 'yes' ? find(/^yes/i) : find(/^no/i);
  }
  if (/veteran|military/i.test(q)) {
    if (!eeoVeteran) return find(/prefer not|decline/i) || options[options.length - 1];
    return eeoVeteran === 'yes' ? find(/^yes|^i am/i) : find(/^no|^not a/i);
  }
  if (/ethnic|race/i.test(q)) {
    if (!eeoEthnicity) return find(/prefer not|decline/i) || options[options.length - 1];
    if (eeoEthnicity === 'white') return find(/white/i);
    if (eeoEthnicity === 'black') return find(/black/i);
    if (eeoEthnicity === 'asian') return find(/asian/i);
    if (eeoEthnicity === 'hispanic') return find(/hispanic|latino/i);
    return find(/prefer not|decline/i) || options[options.length - 1];
  }
  const fallback = find(/^yes/i) || options[0];
  if (q) console.log(`  [Indeed] Unknown dropdown: "${question.substring(0, 80)}" → "${fallback?.text}"`);
  return fallback;
}

async function _buildTextAnswer(question, job) {
  const { yearsExperience, salaryExpectation, availability, willingToRelocate, location, firstName, lastName } = cfg.APPLICANT;
  const q = (question || '').toLowerCase();

  const AVAIL_MAP = {
    'immediately': 'Immediately available',
    '1week':       '1 week notice',
    '2weeks':      '2 weeks notice',
    '1month':      '1 month notice',
    '2months':     '2 months notice',
    '3months':     '3 months notice',
  };

  // Known patterns — handled without AI
  if (/cover letter|covering letter/i.test(q)) return job?.coverLetter || '';
  // "Do you know anyone here / were you referred? If not, please enter N/A."
  if (/(if (not|no)|otherwise)[^.?]{0,40}\bn\/?a\b/i.test(q) || /(friend|family|relative|related to|know anyone).{0,60}(employ|work)/i.test(q)) return 'N/A';
  if (/notice period|availability|when can you start|available to start/i.test(q)) {
    return AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
  }
  if (/salary|compensation|expected pay|remuneration/i.test(q)) return salaryExpectation || '';
  if (/reloc/i.test(q)) return willingToRelocate ? 'Yes, willing to relocate' : 'No, prefer remote or local opportunities';
  if (/year.*experience|experience.*year|how many year/i.test(q)) return String(yearsExperience ?? 0);

  // Location / city — extract city from full location string
  if (/city only|which city|city.*work|where.*based|where do you|location/i.test(q)) {
    return (location || '').split(',')[0].trim() || location || '';
  }

  // Current employment / work situation
  if (/current.*work.*situation|work.*situation|employment.*status|are you currently employed\s*\??\*?$|current.*role\b|current.*position\b/i.test(q) && !/employed by|worked (for|at)/i.test(q)) {
    if (!availability || availability === 'immediately') {
      return 'I am currently between roles and immediately available, actively seeking my next opportunity.';
    }
    return `I am currently employed and open to new opportunities. My notice period is ${AVAIL_MAP[availability] || availability}.`;
  }

  // Why this role / what interests you
  if (/why.*role|why.*company|why.*position|what.*attract|motivat|interest.*you.*position|interest.*you.*role|what.*interest|draw.*you|passion/i.test(q)) {
    const title   = job?.title   || 'this role';
    const company = job?.company || 'your organisation';
    const yrs = yearsExperience > 0 ? `${yearsExperience} years of` : 'solid';
    return `The ${title} position at ${company} closely aligns with my ${yrs} experience. I am drawn to the opportunity to contribute my skills and continue growing in a forward-thinking environment.`;
  }

  if (/additional|tell us more|anything else|comments|message/i.test(q)) {
    return `Please see my ${cfg.APPLICANT.country === 'United States' ? 'resume' : 'CV'} for a full overview of my experience. I am available for interview at your earliest convenience.`;
  }

  // Pronouns — leave blank (optional field, personal choice)
  if (/pronoun/i.test(q)) return '';

  // Current company — leave blank if not employed
  if (/current company|current employer|where.*currently work/i.test(q)) {
    if (!availability || availability === 'immediately') return 'Currently seeking new opportunities';
    return '';
  }

  // How did you hear — always pick the first/default option (handled by dropdown logic), return blank for text
  if (/how did you hear|how.*find.*role|how.*learn/i.test(q)) return 'Job board / online search';

  // ── AI fallback — ask Claude for anything not matched above ──
  if (!q) return '';
  try {
    const available = await llmAvailable();
    if (available) {
      const title   = job?.title   || 'IT Support';
      const company = job?.company || 'the company';
      const avail   = AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
      const prompt =
`You are completing a job application form on behalf of ${firstName} ${lastName}.

Candidate facts:
- ${yearsExperience} years of IT support / technical services experience
- Location: ${location}
- Availability: ${avail}
- No current employment contract restrictions

Job: ${title} at ${company}

Form question: "${question}"

Write a short, professional answer (2-4 sentences). Sound natural and human. No bullet points. No mention of AI. Answer directly — do not include the question in your response.`;

      const answer = await llmChat(prompt);
      if (answer && answer.trim()) {
        console.log(`  [Indeed] AI: "${question.substring(0, 60)}" → "${answer.substring(0, 80)}..."`);
        return answer.trim();
      }
    }
  } catch (e) {
    console.log(`  [Indeed] AI answer failed: ${e.message}`);
  }

  return '';
}

// Rule-based answers for common checkbox screener questions (no AI call needed).
function _resolveCheckboxGroup(question, optionLabels) {
  const q = (question || '').toLowerCase();

  if (/clearance|security.*level|cleared/i.test(q)) {
    // Pick "None/No clearance" — user has no US security clearance
    return optionLabels.filter(l => /none|no clearance/i.test(l));
  }
  if (/work.*authoris|authoris.*work|work.*eligib|eligib.*work/i.test(q)) {
    return optionLabels.filter(l => /citizen|permanent|authoris|eligible|yes/i.test(l)).slice(0, 1);
  }
  if (/work.*arrangement|prefer.*work|work.*prefer|work.*type|work.*style/i.test(q)) {
    return optionLabels.filter(l => /remote|hybrid/i.test(l));
  }
  if (/employment.*type|type.*employment|contract.*type|full.?time|part.?time/i.test(q)) {
    return optionLabels.filter(l => /full.?time|permanent/i.test(l)).slice(0, 1);
  }
  return null; // null = use AI
}

async function _answerCheckboxGroups(frame, job) {
  try {
    // Collect all visible unchecked checkboxes with their labels
    const allCbs = await frame.$$('input[type="checkbox"]');
    if (!allCbs.length) return;

    // Build list of {el, label, groupKey} by walking up to find a shared container
    const items = [];
    for (const cb of allCbs) {
      const isVis = await cb.isVisible().catch(() => false);
      if (!isVis) continue;
      const info = await cb.evaluate(el => {
        const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label');
        const labelText = (lab ? (lab.innerText || lab.textContent) : '').trim();
        // Skip consent/terms checkboxes — handled separately
        if (/agree|accept|terms|privacy|certif|consent|acknowledge/i.test(labelText.toLowerCase())) return null;
        // Walk up to find a container that holds multiple inputs
        let node = el.parentElement;
        let groupKey = '';
        for (let i = 0; i < 6; i++) {
          if (!node) break;
          if (node.querySelectorAll('input[type="checkbox"]').length >= 2) {
            if (!node.dataset.jbGroup) node.dataset.jbGroup = 'g' + Math.random().toString(36).slice(2);
            groupKey = node.dataset.jbGroup;
            break;
          }
          node = node.parentElement;
        }
        return { labelText, groupKey: groupKey || '__single__' };
      }).catch(() => null);
      if (info) items.push({ cb, ...info });
    }

    // Group by groupKey
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.groupKey)) groups.set(item.groupKey, []);
      groups.get(item.groupKey).push(item);
    }

    for (const [, groupItems] of groups) {
      if (groupItems.length < 2) continue; // single checkbox — handled by consent logic

      // If any in the group are already checked, skip
      let anyChecked = false;
      for (const item of groupItems) {
        if (await item.cb.isChecked().catch(() => false)) { anyChecked = true; break; }
      }
      if (anyChecked) continue;

      // Find the question label for this group
      const question = await groupItems[0].cb.evaluate(el => {
        let node = el.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!node) break;
          for (const tag of ['legend', 'h1', 'h2', 'h3', 'label', 'p', 'span']) {
            for (const l of node.querySelectorAll(tag)) {
              const t = (l.innerText || '').trim();
              // Must be longer than any individual option label
              if (t.length > 10 && !node.querySelector(`input[type="checkbox"]`)?.closest(tag)) return t;
            }
          }
          node = node.parentElement;
        }
        return '';
      }).catch(() => '');

      const optionLabels = groupItems.map(i => i.labelText);
      console.log(`  [Indeed] Checkbox group: "${question.substring(0, 60)}" options: [${optionLabels.join(', ')}]`);

      // Try rule-based first
      let toCheck = _resolveCheckboxGroup(question, optionLabels);
      if (!toCheck && (/(ever|previously|before).{0,40}(employed|worked)|employed by .* before/i.test(question)
          || optionLabels.some(l => /not previously been employed|have never (been employed|worked)/i.test(l)))) {
        const never = optionLabels.find(l => /have not|haven't|never|not previously|none of (the|these)/i.test(l));
        if (never) toCheck = [never];
      }

      // Fall back to Claude for unknown groups
      if (!toCheck) {
        try {
          const available = await llmAvailable();
          if (available) {
            const { firstName, lastName, yearsExperience, location, availability } = cfg.APPLICANT;
            const AVAIL_MAP = { immediately: 'Immediately available', '1week': '1 week notice', '2weeks': '2 weeks', '1month': '1 month', '2months': '2 months', '3months': '3 months' };
            const prompt =
`You are completing a job application for ${firstName} ${lastName}.
Candidate: ${yearsExperience} years IT support experience, based in ${location}, ${AVAIL_MAP[availability || 'immediately'] || 'immediately available'}, UK citizen, no security clearance, no employment restrictions.
Job: ${job?.title || 'IT Support'} at ${job?.company || 'company'}.

Screener question: "${question}"
Options (checkboxes): ${optionLabels.map((l, i) => `${i + 1}. ${l}`).join(', ')}

Reply with ONLY the numbers of the option(s) to tick, comma-separated. Example: "1" or "1,3". Pick the most accurate option(s) for this candidate.`;

            const reply = await llmChat(prompt);
            const nums = (reply || '').match(/\d+/g);
            if (nums) {
              toCheck = nums.map(n => optionLabels[parseInt(n, 10) - 1]).filter(Boolean);
              console.log(`  [Indeed] AI checkbox: "${question.substring(0, 50)}" → [${toCheck.join(', ')}]`);
            }
          }
        } catch (e) {
          console.log(`  [Indeed] AI checkbox failed: ${e.message}`);
        }
      }

      if (!toCheck || !toCheck.length) continue;

      // Click the matching checkboxes
      for (const item of groupItems) {
        if (toCheck.some(t => t.toLowerCase() === item.labelText.toLowerCase())) {
          await item.cb.click().catch(() => {});
          console.log(`  [Indeed] Ticked: "${item.labelText}"`);
        }
      }
    }
  } catch (e) {
    console.log(`  [Indeed] Checkbox group error: ${e.message}`);
  }
}

async function _answerQuestions(page, job) {
  for (const frame of _allFrames(page)) {
    try {
      // ── Radio buttons (group by name — works without fieldset wrappers) ──
      const allRadios = await frame.$$('input[type="radio"]');
      const radioGroups = new Map();
      for (const r of allRadios) {
        const name = await r.getAttribute('name').catch(() => null);
        const key = name || '__unnamed__';
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(r);
      }

      for (const [, radios] of radioGroups) {
        // Walk up the DOM from the first radio to find the question text
        const question = await radios[0].evaluate(el => {
          const fs = el.closest('fieldset');
          const legend = fs && fs.querySelector('legend');
          if (legend && (legend.innerText || '').trim()) return legend.innerText.trim();
          const group = el.closest('[role="radiogroup"]');
          const lbId = group && group.getAttribute('aria-labelledby');
          const lb = lbId && document.getElementById(lbId.split(' ')[0]);
          if (lb && (lb.innerText || '').trim()) return lb.innerText.trim();
          // Otherwise the nearest text above that isn't one of this group's own option labels.
          const name = el.getAttribute('name');
          const optionLabels = new Set([...document.querySelectorAll(`input[type="radio"]${name ? `[name="${CSS.escape(name)}"]` : ''}`)]
            .map(r => ((document.querySelector(`label[for="${r.id}"]`) || r.closest('label') || {}).innerText || '').trim()));
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            for (const tag of ['legend', 'h1', 'h2', 'h3', 'p', 'label', 'span']) {
              for (const l of node.querySelectorAll(tag)) {
                if (l.querySelector('input[type="radio"]') || (tag === 'label' && l.htmlFor && document.getElementById(l.htmlFor)?.type === 'radio')) continue;
                const t = (l.innerText || '').trim();
                if (t.length > 8 && !optionLabels.has(t) && !/^(yes|no|true|false)$/i.test(t)) return t;
              }
            }
            node = node.parentElement;
          }
          return '';
        }).catch(() => '');

        const options = [];
        for (const r of radios) {
          const label = await r.evaluate(el => {
            const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.nextElementSibling;
            return (lab ? (lab.innerText || lab.textContent) : '').trim();
          }).catch(() => '');
          options.push({ radio: r, label });
        }

        const labels = options.map(o => o.label);
        // A lone option ("I understand") is an acknowledgement: it must be ticked to continue.
        let targetLabel = labels.length === 1 ? labels[0] : _resolveRadio(question, labels, { allowUnknown: false });
        if (!targetLabel && question) {
          // Unknown question: let the AI pick from the candidate's profile (sensitive
          // questions are refused inside aiPickOption), else the old default.
          const picked = await ai.aiPickOption({ question, options: labels.map(text => ({ text })), job, kind: 'radio' }).catch(() => null);
          if (picked) console.log(`  [Indeed] AI answered radio: "${question.substring(0, 70)}" → "${picked.text}"`);
          targetLabel = picked ? picked.text : _resolveRadio(question, labels);
        }
        if (targetLabel) {
          const target = options.find(o => o.label === targetLabel);
          if (target) {
            const already = await target.radio.isChecked().catch(() => false);
            if (!already) {
              await target.radio.click().catch(() => {});
              console.log(`  [Indeed] Radio: "${question.substring(0, 70)}" → "${targetLabel}"`);
            }
          }
        }
      }

      // ── Select dropdowns ──
      const selects = await frame.$$('select');
      for (const sel of selects) {
        const current = await sel.inputValue().catch(() => '');
        if (current && current !== '') continue;
        const question = await sel.evaluate(el => {
          const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
          return (lab ? lab.innerText : el.closest('[class*="ia-Question"], [class*="question"], [role="group"]')?.querySelector('label, legend, [class*="label"]')?.innerText || '').trim();
        }).catch(() => '');
        const opts = await sel.evaluate(el =>
          Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim().toLowerCase() }))
        );
        const nonEmpty = opts.filter(o => o.value && !/^select|choose|please/i.test(o.text));
        if (!nonEmpty.length) continue;
        const chosen = _resolveDropdown(question, nonEmpty);
        if (chosen) await sel.selectOption({ value: chosen.value }).catch(() => {});
      }

      // ── Text / number inputs ──
      const inputs = await frame.$$('input[type="text"], input[type="number"]');
      for (const inp of inputs) {
        const isVis = await inp.isVisible().catch(() => false);
        if (!isVis) continue;
        const current = await inp.inputValue().catch(() => '');
        if (current) continue;
        const question = await inp.evaluate(el => {
          const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
          return (lab ? lab.innerText : el.closest('[class*="ia-Question"], [class*="question"]')?.querySelector('label, [class*="label"]')?.innerText || '').toLowerCase();
        }).catch(() => '');
        const type = await inp.getAttribute('type').catch(() => 'text');

        const answer = await _buildTextAnswer(question, job);
        if (answer) {
          await inp.click().catch(() => {}); await DELAY(80 + Math.random() * 120);
          await inp.type(answer, { delay: 55 + Math.random() * 75 }).catch(() => {});
        } else if (type === 'number') {
          await inp.click().catch(() => {}); await DELAY(60 + Math.random() * 80);
          await inp.type(String(cfg.APPLICANT.yearsExperience ?? 0), { delay: 55 + Math.random() * 60 }).catch(() => {});
        } else if (question) {
          console.log(`  [Indeed] Unknown text field: "${question.substring(0, 80)}" — left blank`);
        }
      }

      // ── Textareas ──
      const textareas = await frame.$$('textarea');
      for (const ta of textareas) {
        const isVis = await ta.isVisible().catch(() => false);
        if (!isVis) continue;
        const current = await ta.inputValue().catch(() => '');
        if (current && current.trim()) continue;
        const label = await ta.evaluate(el => {
          const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
          return (lab ? lab.innerText : el.closest('[class*="ia-Question"], [class*="question"]')?.querySelector('label, [class*="label"]')?.innerText || '').trim();
        }).catch(() => '');
        const answer = await _buildTextAnswer(label, job);
        if (answer) {
          await ta.click().catch(() => {}); await DELAY(80 + Math.random() * 120);
          await ta.type(answer, { delay: 30 + Math.random() * 40 }).catch(() => {});
          if (label) console.log(`  [Indeed] Filled textarea: "${label.substring(0, 60)}"`);
        }
      }

      // ── Checkbox screener groups (e.g. "Active clearance level", certifications) ──
      // Group visible checkboxes by their nearest shared container, then use Claude
      // to pick the right option(s) for any group that is unanswered.
      await _answerCheckboxGroups(frame, job);

      // ── Checkboxes (terms/consent) — tick all agreement boxes ──
      const checkboxes = await frame.$$('input[type="checkbox"]');
      for (const cb of checkboxes) {
        const isVis = await cb.isVisible().catch(() => false);
        if (!isVis) continue;
        const isChecked = await cb.isChecked().catch(() => false);
        if (isChecked) continue;
        const label = await cb.evaluate(el => {
          const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label');
          return (lab ? (lab.innerText || lab.textContent) : '').toLowerCase();
        }).catch(() => '');
        if (/agree|accept|terms|privacy|certif|consent|acknowledge/i.test(label)) {
          await cb.click().catch(() => {});
        }
      }
    } catch (err) {
      console.log(`  [Indeed] Question answering error (frame): ${err.message}`);
    }
  }
}

// Returns all frames on the page (main frame + iframes).
// SmartApply embeds its form in an iframe on the parent page, so selectors
// run against page.$() (main frame only) never find the form's buttons.
function _allFrames(page) {
  try { return page.frames(); } catch (_) { return [page.mainFrame ? page.mainFrame() : page]; }
}

async function _trySubmit(page, job) {
  // Wait up to 20s for "Preparing review" loading spinner to clear
  for (let i = 0; i < 10; i++) {
    const loading = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return t.includes('preparing review') || t.includes('loading');
    }).catch(() => false);
    if (!loading) break;
    await DELAY(2000);
  }

  // Solve any CAPTCHA on the review page (Turnstile, reCAPTCHA, hCaptcha)
  if (cfg.CAPSOLVER_KEY) {
    const hasTurnstile = await page.evaluate(() =>
      !!document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"]') ||
      !!document.querySelector('iframe[src*="turnstile"]') ||
      (document.body?.innerText || '').toLowerCase().includes('verify you are human')
    ).catch(() => false);

    if (hasTurnstile) {
      console.log('  [Indeed] Cloudflare Turnstile on review page — solving via CapSolver...');
      const solved = await captcha.solveTurnstile(page).catch(() => false);
      if (solved) await DELAY(2000);
    } else {
      for (const frame of _allFrames(page)) {
        try {
          const sitekey = await frame.evaluate(() => {
            const el = document.querySelector('.g-recaptcha, [data-sitekey]');
            return el?.getAttribute('data-sitekey') || null;
          }).catch(() => null);
          if (sitekey) {
            console.log('  [Indeed] reCAPTCHA on review page — solving via CapSolver...');
            const solved = await captcha.solveRecaptchaV2(page).catch(() => false);
            if (solved) await DELAY(2000);
            break;
          }
        } catch (_) {}
      }
    }
  }

  // A greyed-out Submit behind an "I'm not a robot" box: skip the job, never solve it.
  const blocked = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="submit-application-button"], button[data-testid="ia-submitButton"]');
    return !!(b && b.disabled && document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, iframe[src*="hcaptcha"]'));
  }).catch(() => false);
  if (blocked) throw new Error('Indeed asked for a captcha on the review page, skipped');

  const submitSelectors = [
    'button[data-testid="ia-submitButton"]',
    'button:has-text("Submit your application")',
    'button:has-text("Submit application")',
    'button[type="submit"]:has-text("Submit")',
  ];
  for (const frame of _allFrames(page)) {
    for (const sel of submitSelectors) {
      try {
        const btn = await frame.$(sel);
        if (btn && await btn.isVisible() && await btn.isEnabled()) {
          if (process.env.JOBBOT_NO_SUBMIT === '1') {
            console.log(`  [Indeed] TEST MODE: reached Submit, not pressing it: ${job?.title}`);
            await page.screenshot({ path: path.join(SSDIR, 'indeed_before_submit.png') }).catch(() => {});
            return true;
          }
          console.log(`  [Indeed] Submitting: ${job?.title} @ ${job?.company}`);
          await page.screenshot({ path: path.join(SSDIR, 'indeed_before_submit.png') }).catch(() => {});
          await btn.click();
          return true;
        }
      } catch (_) {}
    }
  }
  return false;
}

async function _tryContinue(page) {
  const nextSelectors = [
    'button[data-testid="ia-continueButton"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Review")',
    '[role="button"]:has-text("Continue")',
    'button[type="submit"]:not(:has-text("Submit"))',
  ];

  const frames = _allFrames(page);
  console.log(`  [Indeed] _tryContinue: ${frames.length} frame(s), url=${page.url()}`);

  for (const frame of frames) {
    const fUrl = frame.url();
    for (const sel of nextSelectors) {
      try {
        const btn = await frame.$(sel);
        if (!btn) continue;
        const vis = await btn.isVisible().catch(() => false);
        const ena = await btn.isEnabled().catch(() => false);
        console.log(`  [Indeed] frame=${fUrl} sel="${sel}" found=true vis=${vis} ena=${ena}`);
        if (vis && ena) {
          await btn.click();
          await DELAY(3000);
          return true;
        }
      } catch (e) {
        console.log(`  [Indeed] frame=${fUrl} sel="${sel}" err=${e.message}`);
      }
    }
  }

  // Last resort: JS click on any button whose text matches
  const jsClicked = await page.evaluate(() => {
    const texts = ['continue', 'next', 'review'];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (texts.includes(t)) { el.click(); return t; }
    }
    return null;
  }).catch(() => null);

  if (jsClicked) {
    console.log(`  [Indeed] JS-clicked "${jsClicked}" button`);
    await DELAY(3000);
    return true;
  }

  return false;
}

module.exports = { ensureLoggedIn, searchJobs, getJobDescription, applyToJob, fillEasyApplyForm, indeedSignedIn };
