const cfg     = require('../config');
const captcha = require('./captcha_solver');
const { humanWarmup, waitForCloudflareSolve } = require('./browser_launcher');

const DELAY = ms => new Promise(r => setTimeout(r, ms));

function getBaseUrl() {
  return (cfg.APPLICANT.country === 'United States') ? 'https://www.indeed.com' : 'https://uk.indeed.com';
}

// ── Login ──────────────────────────────────────────────────────────────────
// Uses a persistent Chrome profile set up via the app's "Connect" button.
// No form interaction — bot detection cannot fire during login.
async function ensureLoggedIn(page) {
  const baseUrl = getBaseUrl();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForCloudflareSolve(page);
  await DELAY(2000);
  const isLoggedIn = await page.evaluate(() => {
    return !!(
      document.querySelector('[data-gnav-element-name="SignOut"], [class*="gnav-SignOut"], [id*="UserDropdown"], [class*="UserDropdown"]') ||
      (document.body?.innerText || '').toLowerCase().includes('sign out')
    );
  }).catch(() => false);
  if (!isLoggedIn) {
    throw new Error('Indeed: not logged in. Go to Job Site Login → Connect Indeed Account first.');
  }
  console.log('  [Indeed] Session active');
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
  await DELAY(3000);

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
    );
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
  await DELAY(4000);

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

  // Iterate through form steps
  let stepCount = 0;
  const MAX_STEPS = 12;

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
    const advanced = await _tryContinue(applyPage);
    if (!advanced) {
      console.log(`  [Indeed] Could not advance from step ${stepCount}.`);
      await applyPage.screenshot({ path: path.join(SSDIR, `indeed_stuck_step${stepCount}.png`) }).catch(() => {});
      break;
    }
  }

  return false;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function _handleResumeStep(page, resumePath) {
  try {
    // Prefer "Upload new resume" / "Use a different resume" when a saved one is shown
    const uploadNewSelectors = [
      'button:has-text("Upload new resume")',
      'button:has-text("Upload a resume")',
      'button:has-text("Use a different resume")',
      'button:has-text("Replace resume")',
      'label:has-text("Upload")',
    ];
    for (const sel of uploadNewSelectors) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await DELAY(2000);
        break;
      }
    }

    // Direct file input
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(resumePath);
      await DELAY(2500);
      console.log('  [Indeed] Resume uploaded.');
      return;
    }

    // File chooser via label/button
    const uploadTrigger = await page.$('[data-testid="FileUploadInput"], [data-testid="upload-button"], label[for*="file" i]');
    if (uploadTrigger) {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 3000 }),
        uploadTrigger.click(),
      ]);
      await chooser.setFiles(resumePath);
      await DELAY(2500);
      console.log('  [Indeed] Resume uploaded via file chooser.');
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
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          const current = await el.inputValue();
          if (!current) { await el.fill(val); await DELAY(200); }
          break;
        }
      } catch (_) {}
    }
  }
}

function _resolveRadio(question, labels) {
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
  const fallback = find(/^yes/i) || labels[0];
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

function _buildTextAnswer(question, job) {
  const { yearsExperience, salaryExpectation, availability, willingToRelocate } = cfg.APPLICANT;
  const q = (question || '').toLowerCase();

  const AVAIL_MAP = {
    'immediately': 'Immediately available',
    '1week':       '1 week notice',
    '2weeks':      '2 weeks notice',
    '1month':      '1 month notice',
    '2months':     '2 months notice',
    '3months':     '3 months notice',
  };

  if (/cover letter|covering letter/i.test(q)) return job?.coverLetter || '';
  if (/notice period|availability|when can you start|available to start/i.test(q)) {
    return AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
  }
  if (/why.*role|why.*company|why.*position|what.*attract|motivat/i.test(q)) {
    const title   = job?.title   || 'this role';
    const company = job?.company || 'your organisation';
    const yrs = yearsExperience > 0 ? `${yearsExperience} years of` : 'extensive';
    return `The ${title} position at ${company} closely matches my ${yrs} experience and career goals. I am excited about the opportunity to contribute from day one.`;
  }
  if (/salary|compensation|expected pay|remuneration/i.test(q)) return salaryExpectation || '';
  if (/reloc/i.test(q)) return willingToRelocate ? 'Yes, willing to relocate' : 'No, prefer remote or local opportunities';
  if (/year.*experience|experience.*year|how many year/i.test(q)) return String(yearsExperience ?? 0);
  if (/additional|tell us more|anything else|comments|message/i.test(q)) {
    return 'Please see my CV for a full overview of my experience. I am available for interview at your earliest convenience.';
  }
  return '';
}

async function _answerQuestions(page, job) {
  try {
    // ── Radio buttons ──
    const fieldsets = await page.$$('fieldset, [role="group"], [class*="ia-Question-radioGroup"]');
    for (const fs of fieldsets) {
      const question = await fs.evaluate(el => {
        const label = el.querySelector('legend, label, [class*="question"], [class*="ia-Question-label"], h3, p');
        return (label ? label.innerText : '').trim();
      }).catch(() => '');
      const radios = await fs.$$('input[type="radio"]');
      if (!radios.length) continue;

      const options = [];
      for (const r of radios) {
        const label = await r.evaluate(el => {
          const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.nextElementSibling;
          return (lab ? (lab.innerText || lab.textContent) : '').trim();
        }).catch(() => '');
        options.push({ radio: r, label });
      }

      const targetLabel = _resolveRadio(question, options.map(o => o.label));
      if (targetLabel) {
        const target = options.find(o => o.label === targetLabel);
        if (target) {
          const already = await target.radio.isChecked().catch(() => false);
          if (!already) await target.radio.click().catch(() => {});
        }
      }
    }

    // ── Select dropdowns ──
    const selects = await page.$$('select');
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
    const inputs = await page.$$('input[type="text"], input[type="number"]');
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

      const answer = _buildTextAnswer(question, job);
      if (answer) {
        await inp.fill(answer).catch(() => {});
      } else if (type === 'number') {
        await inp.fill(String(cfg.APPLICANT.yearsExperience ?? 0)).catch(() => {});
      } else if (question) {
        console.log(`  [Indeed] Unknown text field: "${question.substring(0, 80)}" — left blank`);
      }
    }

    // ── Textareas ──
    const textareas = await page.$$('textarea');
    for (const ta of textareas) {
      const isVis = await ta.isVisible().catch(() => false);
      if (!isVis) continue;
      const current = await ta.inputValue().catch(() => '');
      if (current && current.trim()) continue;
      const label = await ta.evaluate(el => {
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        return (lab ? lab.innerText : el.closest('[class*="ia-Question"], [class*="question"]')?.querySelector('label, [class*="label"]')?.innerText || '').trim();
      }).catch(() => '');
      const answer = _buildTextAnswer(label, job);
      if (answer) {
        await ta.fill(answer).catch(() => {});
        if (label) console.log(`  [Indeed] Filled textarea: "${label.substring(0, 60)}"`);
      }
    }

    // ── Checkboxes (terms/consent) ──
    const checkboxes = await page.$$('input[type="checkbox"]');
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
    console.log(`  [Indeed] Question answering error: ${err.message}`);
  }
}

async function _trySubmit(page, job) {
  const submitSelectors = [
    'button[data-testid="ia-submitButton"]',
    'button:has-text("Submit your application")',
    'button:has-text("Submit application")',
    'button[type="submit"]:has-text("Submit")',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) {
        console.log(`  [Indeed] Submitting: ${job?.title} @ ${job?.company}`);
        await page.screenshot({ path: path.join(SSDIR, 'indeed_before_submit.png') }).catch(() => {});
        await btn.click();
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function _tryContinue(page) {
  const nextSelectors = [
    'button[data-testid="ia-continueButton"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Review")',
    'button[type="submit"]:not(:has-text("Submit"))',
  ];
  for (const sel of nextSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) {
        await btn.click();
        await DELAY(3000);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

module.exports = { ensureLoggedIn, searchJobs, getJobDescription, applyToJob };
