const cfg     = require('../config');
const fs      = require('fs');
const path    = require('path');
const stealth = require('./stealth');
const captcha = require('./captcha_solver');
const ai      = require('./question_ai'); // LLM fallback for unknown screening questions
const cvValidate = require('./cv_validate'); // reject corrupt/empty CVs before attaching

const SSDIR = cfg.SCREENSHOTS_DIR;
const DELAY = (ms) => new Promise(r => setTimeout(r, ms));

// ── LOGIN ──────────────────────────────────────────────────────────────────
async function login(browser, email, password) {
  console.log('  [LinkedIn] Logging in...');
  const page = await browser.newPage();
  await stealth.applyToPage(page);
  page.setDefaultTimeout(30000);

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(4000);

  const emailInput = page.locator('input[type="email"]').filter({ visible: true }).first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.click();
  await DELAY(300 + Math.random() * 300);
  await emailInput.pressSequentially(email, { delay: 55 + Math.random() * 65 });
  console.log('  [LinkedIn] Email filled.');
  await DELAY(600 + Math.random() * 400);

  const passInput = page.locator('input[type="password"]').filter({ visible: true }).first();
  await passInput.waitFor({ state: 'visible', timeout: 10000 });
  await passInput.click();
  await DELAY(400);
  await passInput.pressSequentially(password, { delay: 60 });
  console.log('  [LinkedIn] Password filled.');
  await DELAY(1000);

  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await DELAY(7000);

  // Wait indefinitely — auto-solve any CAPTCHA, never give up
  console.log('  [LinkedIn] Waiting for login...');
  while (true) {
    const u = page.url();
    if (u.includes('feed') || u.includes('mynetwork') || (await page.$('.global-nav').catch(() => null))) {
      console.log('  [LinkedIn] Logged in successfully.');
      break;
    }
    if (u.includes('checkpoint') || u.includes('challenge') || u.includes('captcha') || u.includes('security-check')) {
      console.log('  [LinkedIn] ⚠️  Security check — attempting auto-solve...');
    }
    await captcha.autoSolve(page).catch(() => {});
    await DELAY(5000);
  }

  return page;
}

// ── SEARCH JOBS ────────────────────────────────────────────────────────────
async function searchJobs(page, searchTerm, limit = 10) {
  const encoded = encodeURIComponent(searchTerm);
  // f_WT=2,3 = Remote+Hybrid, f_AL=true = Easy Apply only
  const tprParam = cfg.JOB_AGE && cfg.JOB_AGE !== 'any' ? `&f_TPR=${cfg.JOB_AGE}` : '';
  // f_JT: F=Full-time, C=Contract, T=Temporary
  const jtMap = { permanent: 'F', contract: 'C%2CT', any: 'F%2CC%2CT' };
  const jtParam = `&f_JT=${jtMap[cfg.CONTRACT_TYPE] || 'F%2CC%2CT'}`;
  const location = encodeURIComponent(cfg.LOCATION || 'United Kingdom');
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encoded}&location=${location}&f_WT=2%2C3&f_AL=true${jtParam}${tprParam}&sortBy=DD`;

  console.log(`\n  [LinkedIn] Searching: "${searchTerm}" (remote+hybrid, Easy Apply)`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await DELAY(3000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await DELAY(800);
  }

  const jobs = await page.evaluate((lim) => {
    // Use job view links as the primary anchor — /jobs/view/NNN is stable across UI changes.
    // LinkedIn class names change too frequently to rely on as primary selectors.
    const seen = new Set();
    const entries = [];
    for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
      const href = a.getAttribute('href') || '';
      const idMatch = href.match(/\/jobs\/view\/(\d+)/);
      if (!idMatch) continue;
      const jobId = idMatch[1];
      if (seen.has(jobId)) continue;  // deduplicate by job ID
      seen.add(jobId);
      const card = a.closest('li') || a.closest('[data-job-id]') || a.parentElement;
      entries.push({ a, card, jobId, href });
    }

    return entries.slice(0, lim).map(({ a, card, jobId, href }) => {
      const fullUrl = href.startsWith('http')
        ? href.split('?')[0]
        : 'https://www.linkedin.com' + href.split('?')[0];

      const titleEl   = card && card.querySelector('[class*="title"]');
      const companyEl = card && card.querySelector(
        '[class*="company-name"], [class*="subtitle"], .artdeco-entity-lockup__subtitle'
      );
      // LinkedIn's obfuscated classes often make the title selector miss, so we fall
      // back to the anchor text — which is the WHOLE card. The real title is always
      // the first non-empty line; keep only that (and drop LinkedIn's a11y duplicate
      // "<title> with verification" suffix) so we don't store the full description.
      const firstLine = (s) => (String(s || '').split('\n').map(x => x.trim()).find(Boolean) || 'Unknown');
      const rawTitle = titleEl ? titleEl.innerText : (a.getAttribute('aria-label') || a.innerText);
      const title   = firstLine(rawTitle).replace(/\s+with verification$/i, '').trim();
      const company = (companyEl ? companyEl.innerText : 'Unknown').trim().split('\n')[0];

      return { title, company, url: fullUrl, jobId };
    }).filter(j => j.url && j.jobId);
  }, limit);

  console.log(`  [LinkedIn] Found ${jobs.length} jobs for "${searchTerm}"`);
  if (jobs.length === 0) {
    const currentUrl = page.url();
    console.log(`  [LinkedIn] 0 jobs found. URL: ${currentUrl}`);
    await page.screenshot({ path: require('path').join(SSDIR, 'li_search_empty.png') }).catch(() => {});
  }
  return jobs;
}

// ── STRIP LINKEDIN PAGE BOILERPLATE ─────────────────────────────────────────
function extractJobContent(rawText) {
  const aboutJobRe = /about the job\s*\n/i;
  const aboutMatch = aboutJobRe.exec(rawText);
  let text = aboutMatch ? rawText.slice(aboutMatch.index + aboutMatch[0].length) : rawText;

  const CUTOFF_PATTERNS = [
    /\nAbout the company\b/i,
    /\nSet alert for similar jobs/i,
    /\nMore jobs\b/i,
    /\nJob search faster with Premium/i,
    /\nNeed to hire fast\?/i,
    /\nLinkedIn Corporation/i,
    /\nShow more\nMore jobs/i,
  ];
  for (const pat of CUTOFF_PATTERNS) {
    const m = pat.exec(text);
    if (m) text = text.slice(0, m.index);
  }
  text = text.trim();

  const RESP_HEADINGS = [
    'key responsibilities', 'responsibilities', 'your responsibilities',
    'what you\'ll do', 'what you will do', 'role & responsibilities',
    'role and responsibilities', 'job duties', 'duties and responsibilities',
    'the role', 'about the role', 'day to day', 'day-to-day',
    'in this role', 'what the job involves', 'position overview',
    'accountabilities', 'key accountabilities',
  ];
  const STOP_HEADINGS = [
    'about us', 'about the company', 'who we are', 'our company',
    'benefits', 'what we offer', 'perks', 'compensation', 'salary',
    'equal opportunity', 'diversity', 'how to apply', 'apply now',
  ];

  const lines = text.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase().trim();
    if (RESP_HEADINGS.some(h => line === h || line.startsWith(h + ':') || line.startsWith(h + ' -'))) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return text.length > 100 ? text : rawText;

  let endIdx = lines.length;
  for (let i = startIdx + 2; i < lines.length; i++) {
    const line = lines[i].toLowerCase().trim();
    if (line.length > 2 && STOP_HEADINGS.some(h => line === h || line.startsWith(h + ':') || line.startsWith(h + ' '))) {
      endIdx = i;
      break;
    }
  }

  const section = lines.slice(startIdx, endIdx).join('\n').trim();
  return section.length > 100 ? section : text;
}

// ── GET JOB DESCRIPTION ────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  await page.goto(job.url, { waitUntil: 'load', timeout: 60000 });
  await DELAY(3000);

  const showMoreSelectors = [
    'button[aria-label*="Show more"]',
    'button:has-text("Show more")',
    '[class*="show-more-less"] button',
    'footer button:has-text("more")',
  ];
  for (const sel of showMoreSelectors) {
    try { await page.click(sel, { timeout: 3000 }); await DELAY(1500); break; } catch (_) {}
  }

  const fullJD = await page.evaluate(() => {
    const descSelectors = [
      '.jobs-description__content',
      '.jobs-box__html-content',
      '[class*="jobs-description-content"]',
      '[class*="description__text"]',
      '.job-details-module',
      '[class*="job-view-layout"] article',
      '.jobs-description',
    ];
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) return el.innerText.trim();
    }
    const main = document.querySelector('main, [role="main"], .scaffold-layout__main');
    return main ? main.innerText.trim().substring(0, 10000) : document.body.innerText.trim().substring(0, 10000);
  });

  const jd = extractJobContent(fullJD);

  await page.evaluate(() => window.scrollBy(0, 600));
  await DELAY(1500);

  let hasEasyApply = (await page.locator('[aria-label*="Easy Apply"]').count()) > 0;
  if (!hasEasyApply) {
    hasEasyApply = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, a, [role="button"]')).some(el => {
        const t = (el.innerText || el.textContent || '').toLowerCase();
        return t.includes('easy apply');
      });
    });
  }
  if (!hasEasyApply) {
    hasEasyApply = (await page.getByText('Easy Apply', { exact: false }).count()) > 0;
  }

  await page.screenshot({ path: path.join(SSDIR, 'job_page_check.png') });
  const sectionUsed = jd.length < fullJD.length ? 'trimmed JD' : 'full JD';
  console.log(`  [JD] ${sectionUsed} — ${jd.length} chars | Easy Apply: ${hasEasyApply}`);
  return { ...job, description: jd, hasEasyApply };
}

// ── APPLY TO JOB ───────────────────────────────────────────────────────────
async function applyToJob(page, job, resumePath) {
  console.log(`  [LinkedIn] Applying: ${job.title} @ ${job.company}`);

  await page.goto(job.url, { waitUntil: 'load', timeout: 60000 });
  await DELAY(4000);
  await page.evaluate(() => window.scrollBy(0, 300));
  await DELAY(800);
  await page.evaluate(() => window.scrollTo(0, 0));
  await DELAY(500);

  const alreadyApplied = await page.evaluate(() => {
    const bodyText = (document.body.innerText || '').toLowerCase();
    return bodyText.includes('application submitted') ||
           bodyText.includes('you applied') ||
           bodyText.includes('applied on ');
  });
  if (alreadyApplied) {
    console.log('  [LinkedIn] Already applied to this job — skipping.');
    return null;
  }

  await page.screenshot({ path: path.join(SSDIR, 'apply_page_before_click.png') });

  let clicked = false;
  try { await page.click('.jobs-apply-button', { timeout: 10000 }); clicked = true; } catch (_) {}
  if (!clicked) { try { await page.click('[aria-label*="Easy Apply"]', { timeout: 5000 }); clicked = true; } catch (_) {} }
  if (!clicked) { try { await page.getByRole('button', { name: /easy apply/i }).first().click({ timeout: 5000 }); clicked = true; } catch (_) {} }
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*')).find(e => {
        const label = (e.getAttribute('aria-label') || '').toLowerCase();
        const text = (e.innerText || e.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return label.includes('easy apply') || text === 'easy apply' || text.startsWith('easy apply ');
      });
      if (el) { el.scrollIntoView({ behavior: 'instant', block: 'center' }); el.click(); return true; }
      return false;
    });
  }

  if (!clicked) {
    await page.screenshot({ path: path.join(SSDIR, 'apply_no_button.png') });
    throw new Error('Easy Apply button not found');
  }

  await DELAY(4000);
  await page.screenshot({ path: path.join(SSDIR, 'apply_01_modal.png') });

  let stepCount = 0;
  const MAX_STEPS = 12;
  let cvStepSeen = false, cvUploaded = false;
  while (stepCount < MAX_STEPS) {
    stepCount++;
    await DELAY(3000);

    const modalVisible = await page.$('.jobs-easy-apply-modal, [class*="easy-apply-modal"], [aria-label*="Easy Apply"]');
    if (!modalVisible) { console.log('  [LinkedIn] Modal closed.'); break; }

    await page.screenshot({ path: path.join(SSDIR, `apply_0${stepCount}_step.png`) });
    await fillContactFields(page);
    const uploaded = await uploadResume(page, resumePath);
    if (uploaded) { cvUploaded = true; console.log('  [LinkedIn] Resume uploaded.'); }
    // Track whether this application involves a résumé step — Easy Apply otherwise
    // reuses the profile CV, so we must upload our tailored file to a résumé step.
    if (await resumeStepPresent(page)) cvStepSeen = true;
    await answerScreeningQuestions(page, job);

    // Never submit the base CV: if a résumé is involved but we haven't uploaded
    // our tailored file, keep advancing to reach the upload control, and skip
    // rather than submit if we can't.
    if (cvStepSeen && !cvUploaded) {
      const advanced = await tryNext(page, job);
      if (!advanced) {
        console.log('  [LinkedIn] ⚠️  Tailored CV not attached — skipping so the base CV is NOT submitted.');
        console.log('  [[JOBBOT_NOTIFY]] Could not attach your tailored CV on LinkedIn — skipped this job instead of applying with your base CV.');
        await dismissModal(page).catch(() => {});
        return 'cv_not_attached';
      }
      continue;
    }

    const submitted = await trySubmit(page, job);
    if (submitted) {
      console.log('  [LinkedIn] Application submitted!');
      await DELAY(3000);
      await page.screenshot({ path: path.join(SSDIR, 'apply_submitted.png') });
      return true;
    }

    const advanced = await tryNext(page, job);
    if (!advanced) {
      console.log('  [LinkedIn] Could not advance — dismissing modal.');
      await page.screenshot({ path: path.join(SSDIR, `apply_stuck_step${stepCount}.png`) });
      await dismissModal(page).catch(() => {});
      await DELAY(2000);
      break;
    }
  }

  return false;
}

// Does the current Easy Apply step involve a résumé (upload / select / shown)?
async function resumeStepPresent(page) {
  try {
    return await page.evaluate(() => {
      if (document.querySelector('input[type=file]')) return true;
      const modal = document.querySelector('.jobs-easy-apply-modal, [class*="easy-apply-modal"], [role="dialog"]');
      const t = (modal?.innerText || '').toLowerCase();
      return /resume|\bcv\b/.test(t) && /(upload|change|select|attach|choose)/.test(t);
    });
  } catch { return false; }
}

// ── HELPERS ────────────────────────────────────────────────────────────────

// Returns true if applicant's location is US-based
// Infer the country a job is based in from its description/location text
function inferJobCountry(jobDesc) {
  const desc = (jobDesc || '').toLowerCase();
  if (/\bus\b|usa|united states|new york|california|texas|florida|chicago|seattle|boston|san francisco|los angeles/.test(desc)) return 'United States';
  if (/\bireland\b|\bdublin\b|\bcork\b|\bgalway\b/.test(desc)) return 'Ireland';
  if (/\beu\b|european union|germany|france|netherlands|spain|italy|poland|amsterdam|berlin|paris/.test(desc)) return 'European Union';
  if (/\baustralia\b|\bsydney\b|\bmelbourne\b|\bbrisbane\b/.test(desc)) return 'Australia';
  if (/\bcanada\b|\btoronto\b|\bvancouver\b|\bcalgary\b/.test(desc)) return 'Canada';
  return 'United Kingdom'; // default
}

// Check if the applicant has right to work in the inferred job country
function hasRightToWork(jobDesc) {
  const country = inferJobCountry(jobDesc);
  const eligible = cfg.APPLICANT.rightToWorkCountries || [];
  return eligible.some(c => c.toLowerCase() === country.toLowerCase());
}

// Pick the closest dropdown option to the applicant's years of experience
function pickExperienceOption(nonEmpty, yearsExp) {
  const yr = yearsExp ?? 0;
  let m = nonEmpty.find(o => new RegExp(`\\b${yr}\\b`).test(o.text));
  if (m) return m;
  m = nonEmpty.find(o => {
    const nums = o.text.match(/\d+/g);
    if (nums && nums.length >= 2) return yr >= Number(nums[0]) && yr <= Number(nums[1]);
    return false;
  });
  if (m) return m;
  m = nonEmpty.find(o => {
    const nums = o.text.match(/\d+/g);
    if (nums && /\+|more|above|over/.test(o.text)) return yr >= Number(nums[0]);
    return false;
  });
  return m || nonEmpty[nonEmpty.length - 1];
}

const AVAILABILITY_TEXT = {
  'immediately': 'I am immediately available and can start at short notice.',
  '1week':  'I have a 1-week notice period and can start within 1 week.',
  '2weeks': 'I have a 2-week notice period and can start within 2 weeks.',
  '1month': 'I have a 1-month notice period and can start within 1 month.',
  '2months': 'I have a 2-month notice period and can start within 2 months.',
  '3months': 'I have a 3-month notice period and can start within 3 months.',
};

// Build a short professional textarea answer from job and CV context
function buildTextareaAnswer(label, job) {
  const { yearsExperience, salaryExpectation, availability } = cfg.APPLICANT;
  const yearsText = yearsExperience > 0 ? `${yearsExperience} years of` : 'extensive';
  const domain  = (job && job.cvName)  ? job.cvName  : 'IT support and service desk operations';
  const title   = (job && job.title)   ? job.title   : 'this role';
  const company = (job && job.company) ? job.company : 'your organisation';
  const lbl = (label || '').toLowerCase();

  if (/cover letter|covering letter|cover note/i.test(lbl)) {
    return (job && job.coverLetter) || `I am writing to express my strong interest in the ${title} position at ${company}. With ${yearsText} experience in ${domain}, I have developed a proven ability to deliver results in fast-paced environments. I am confident in my ability to contribute effectively from day one and look forward to the opportunity to discuss my application further.`;
  }
  if (/notice period|availability|available to start|when can you start/i.test(lbl)) {
    return AVAILABILITY_TEXT[availability || 'immediately'] || AVAILABILITY_TEXT['immediately'];
  }
  if (/why.*(company|role|position|opportunit|us\b)|motivat|what attract/i.test(lbl)) {
    return `The ${title} role at ${company} closely aligns with my ${yearsText} background in ${domain}. I am drawn to this opportunity because it allows me to apply my technical expertise and problem-solving skills within a forward-thinking organisation.`;
  }
  if (/salary|compensation|pay expectation|remuneration/i.test(lbl)) {
    return salaryExpectation || '';
  }
  if (/additional|tell us|further information|anything else|message|comments/i.test(lbl)) {
    return `Please see my CV for a full overview of my ${domain} experience. I am enthusiastic about this role and available for interview at your earliest convenience.`;
  }
  return `Please see my CV for details on my relevant experience in ${domain}. I am keen to discuss this opportunity further.`;
}

async function fillContactFields(page) {
  const { firstName, middleName, lastName, phone, email, location } = cfg.APPLICANT;
  const simpleFields = [
    { sel: 'input[id*="firstName"], input[name*="firstName"]', val: firstName },
    { sel: 'input[id*="middleName"], input[name*="middleName"]', val: middleName },
    { sel: 'input[id*="lastName"],  input[name*="lastName"]',  val: lastName  },
    { sel: 'input[id*="phone"],     input[name*="phone"]',     val: phone     },
    { sel: 'input[id*="email"],     input[name*="email"]',     val: email     },
  ];
  for (const { sel, val } of simpleFields) {
    if (!val) continue;
    try {
      const el = await page.$(sel);
      if (!el || !(await el.isVisible().catch(() => false))) continue;
      await el.click({ clickCount: 3 }).catch(() => {});
      await DELAY(80);
      await el.fill(val).catch(() => {});
      await DELAY(150);
    } catch (_) {}
  }

  // Location/city — LinkedIn Easy Apply shows an autocomplete dropdown when you type.
  // Must select a suggestion or the field stays invalid and the step can't advance.
  if (location) {
    const locSels = [
      'input[id*="city"], input[name*="city"], input[placeholder*="ity" i]',
      'input[id*="location"], input[name*="location"], input[placeholder*="ocation" i]',
    ];
    for (const sel of locSels) {
      try {
        const el = await page.$(sel);
        if (!el || !(await el.isVisible().catch(() => false))) continue;
        await el.click({ clickCount: 3 }).catch(() => {});
        await DELAY(100);
        await el.fill(location).catch(() => {});
        await DELAY(1200);
        const hasSuggestion = await page.evaluate(() => {
          const opt = document.querySelector(
            '[role="listbox"] [role="option"], .basic-typeahead__triggered-content li, [class*="typeahead"] li'
          );
          return !!(opt && opt.offsetParent !== null);
        });
        if (hasSuggestion) {
          await page.keyboard.press('ArrowDown');
          await DELAY(200);
          await page.keyboard.press('Enter');
          await DELAY(400);
          console.log(`  [LinkedIn] Location autocomplete selected: ${location}`);
        }
        break;
      } catch (_) {}
    }
  }
}

// Confirm the tailored file is REALLY attached — never trust setFiles alone
// (a hidden/wrong input or silent rejection previously made us report success
// and Easy Apply fell back to the profile/base CV). Two signals, either proves
// it: a file input holding the exact tailored filename, or the distinctive
// underscored filename rendered in the résumé card (can't match JD prose).
async function verifyCvUploaded(page, resumePath) {
  const base  = path.basename(resumePath);
  const noExt = base.replace(/\.[^.]+$/, '');
  const needle = noExt.slice(0, 25); // card display may truncate long names
  try {
    await page.waitForFunction(({ base, needle }) => {
      for (const inp of document.querySelectorAll('input[type="file"]')) {
        for (const f of inp.files || []) if (f.name === base) return true;
      }
      const modal = document.querySelector('.jobs-easy-apply-modal, [class*="easy-apply-modal"], [role="dialog"]');
      return ((modal || document.body).innerText || '').includes(needle);
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
  // refuse — the caller's "skip rather than send a bad CV" contract takes over.
  const cvCheck = await cvValidate.validateCvPdf(resumePath);
  if (!cvCheck.ok) {
    console.log(`  [LinkedIn] ⚠ Tailored CV invalid (${cvCheck.reason}) — refusing to attach: ${path.basename(resumePath)}`);
    return false;
  }
  try {
    // Hidden file input — most reliable: set files directly without clicking
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(resumePath);
      await DELAY(2000);
      if (await verifyCvUploaded(page, resumePath)) {
        console.log(`  [LinkedIn] CV uploaded + verified attached: ${path.basename(resumePath)}`);
        return true;
      }
      console.log('  [LinkedIn] ⚠ File input set but tailored CV NOT confirmed attached — treating as failed.');
      return false;
    }

    // LinkedIn shows a "Change" or "Upload resume" button when no hidden input visible
    const triggerSelectors = [
      'button:has-text("Change")', 'button:has-text("Replace")',
      '[aria-label*="Change resume" i]', '[aria-label*="Replace resume" i]',
      'button:has-text("Upload resume")', 'label:has-text("Upload resume")',
      '[aria-label*="upload" i]',
    ];
    for (const sel of triggerSelectors) {
      try {
        const btn = await page.$(sel);
        if (!btn || !await btn.isVisible().catch(() => false)) continue;
        // waitForEvent('filechooser') is the current Playwright API
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }),
          btn.click(),
        ]);
        await chooser.setFiles(resumePath);
        await DELAY(2000);
        if (await verifyCvUploaded(page, resumePath)) {
          console.log(`  [LinkedIn] CV uploaded via "${sel}" + verified attached: ${path.basename(resumePath)}`);
          return true;
        }
        console.log('  [LinkedIn] ⚠ Upload set but tailored CV NOT confirmed attached — treating as failed.');
        return false;
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

async function answerScreeningQuestions(page, job) {
  // Scope all filling to inside the modal — prevents the bot accidentally filling
  // the LinkedIn search bar or other page-level inputs behind the overlay.
  const modal = await page.$('.jobs-easy-apply-modal, [data-test-modal], [role="dialog"]') || page;
  await _answerRadios(modal, job);
  await _answerCustomDropdowns(modal, job);
  await _answerSelects(modal, job);
  await _answerTextInputs(modal, job);
  await _answerTextareas(modal, job);
  await _answerCheckboxes(modal);
}

// ── SHARED: resolve which option text to pick for a labelled dropdown ─────
// options is [{text: string}] where text is already lowercased
// Correct yes/no for the legally-sensitive questions, shared by every LinkedIn
// field type (radio, dropdown, text). Sponsorship is resolved SEPARATELY from
// right-to-work and ALWAYS from the user's profile — so an unusual phrasing can
// never fall through to a "default Yes". Returns 'yes' | 'no' | null.
function sensitiveYesNo(question, job) {
  const q = (question || '').toLowerCase();
  // Any mention of sponsorship → answer from profile (handle inverted phrasing)
  if (/sponsor/i.test(q)) {
    const needs = !!cfg.APPLICANT.requiresSponsorship;
    if (/without sponsor|not require sponsor|no sponsor|don.?t (need|require) sponsor/i.test(q)) return needs ? 'no' : 'yes';
    return needs ? 'yes' : 'no';
  }
  if (/right to work|work permit|authoris|authoriz|eligible.*work|legal.*work|work.*authoris|entitled to work|permit to work/i.test(q)) {
    if (hasRightToWork(job?.description)) return 'yes';
    // Safety net: someone who doesn't need sponsorship has the right to work in
    // their home country (UK by default), so don't answer a disqualifying "no"
    // just because the right-to-work list wasn't filled in precisely.
    if (!cfg.APPLICANT.requiresSponsorship && inferJobCountry(job?.description) === 'United Kingdom') return 'yes';
    return 'no';
  }
  if (/background check|criminal record|dbs check|security check|willing to undergo|reference check|pre.?employment (check|screening)/i.test(q)) return 'yes';
  if (/start (immediately|right away|asap)|immediate start|available immediately|can you start|start date .*immediate/i.test(q)) {
    return (cfg.APPLICANT.availability || 'immediately') === 'immediately' ? 'yes' : 'no';
  }
  if (/reloc/i.test(q)) return cfg.APPLICANT.willingToRelocate ? 'yes' : 'no';
  if (/driving.*licen|licen.*driving|valid.*licen|full (uk )?licen/i.test(q)) return cfg.APPLICANT.drivingLicence ? 'yes' : 'no';
  return null;
}

async function resolveDropdownChoice(question, options, job) {
  const q = question.toLowerCase();
  const yr = cfg.APPLICANT.yearsExperience ?? 0;

  // Sensitive yes/no questions first — never let these reach the default-Yes path
  const yn = sensitiveYesNo(question, job);
  if (yn) return options.find(o => yn === 'yes' ? /^yes/.test(o.text) : /^no/.test(o.text)) || null;
  if (/commut|travel to|able to.*office|willing to.*office|office.*location/i.test(q)) {
    return options.find(o => /^yes/.test(o.text)) || options[0] || null;
  }
  if (/british|uk citizen|citizen.*uk|nationality/i.test(q)) {
    return options.find(o => /^yes/.test(o.text)) || null;
  }
  if (/gender/i.test(q)) {
    const g = cfg.APPLICANT.eeoGender;
    if (g === 'female') return options.find(o => /\bfemale\b|^woman$|\bwoman\b/i.test(o.text)) || null;
    if (g === 'nonbinary') return options.find(o => /non.?binary|other|self.?describ/i.test(o.text)) || null;
    if (g === 'other') return options.find(o => /other|self.?describ|prefer not/i.test(o.text)) || null;
    if (!g) return options.find(o => /prefer not|decline|not.*say/i.test(o.text)) || options[options.length - 1] || null;
    return options.find(o => /\bman\b|^male$|\bmale\b/i.test(o.text)) || null;
  }
  if (/disability|disabled|chronic/i.test(q)) {
    const d = cfg.APPLICANT.eeoDisability;
    if (d === 'yes') return options.find(o => /^yes/i.test(o.text)) || null;
    if (d === 'no') return options.find(o => /^no/i.test(o.text)) || null;
    return options.find(o => /prefer not|decline|not.*say/i.test(o.text)) || options[options.length - 1] || null;
  }
  if (/veteran|protected veteran|military/i.test(q)) {
    const v = cfg.APPLICANT.eeoVeteran;
    if (v === 'yes') return options.find(o => /^yes|^i am a.*veteran|^protected/i.test(o.text)) || null;
    if (v === 'no') return options.find(o => /^no|^not a/i.test(o.text)) || null;
    return options.find(o => /prefer not|decline|not.*say/i.test(o.text)) || options[options.length - 1] || null;
  }
  if (/sexual orientation|sexuality/i.test(q)) {
    return options.find(o => /straight|heterosexual/i.test(o.text)) || null;
  }
  if (/ethnic|race|racial/i.test(q)) {
    const eth = cfg.APPLICANT.eeoEthnicity;
    if (eth === 'white') return options.find(o => /\bwhite\b/i.test(o.text) && !/hispanic/i.test(o.text)) || null;
    if (eth === 'black') return options.find(o => /black.*african|african.*black|black or african|\bblack\b/i.test(o.text)) || null;
    if (eth === 'asian') return options.find(o => /\basian\b/i.test(o.text)) || null;
    if (eth === 'hispanic') return options.find(o => /hispanic|latino/i.test(o.text)) || null;
    if (eth === 'mixed') return options.find(o => /mixed|multiple/i.test(o.text)) || null;
    if (eth === 'mena') return options.find(o => /middle east|north african|mena/i.test(o.text)) || null;
    return options.find(o => /prefer not|decline|not.*say/i.test(o.text)) || options[options.length - 1] || null;
  }
  if (/year.*experience|experience.*year|how many year|how long|years in/i.test(q)) {
    const m = options.find(o => new RegExp(`\\b${yr}\\b`).test(o.text)) ||
              options.find(o => { const n = o.text.match(/\d+/g); return n && n.length >= 2 && yr >= Number(n[0]) && yr <= Number(n[1]); }) ||
              options.find(o => { const n = o.text.match(/\d+/g); return n && /\+|more|above|over/.test(o.text) && yr >= Number(n[0]); }) ||
              options[options.length - 1];
    return m || null;
  }
  if (/notice period|how.*soon.*start|when.*available.*start|available.*notice|notice.*required/i.test(q)) {
    const avMap = {
      'immediately': /immediate|asap|now|^0\s*|no notice|straight away/,
      '1week':       /^1\s*week|one\s*week/,
      '2weeks':      /^2\s*week|two\s*week/,
      '1month':      /^1\s*month|one\s*month/,
      '2months':     /^2\s*month|two\s*month/,
      '3months':     /^3\s*month|three\s*month/,
    };
    const avKey = cfg.APPLICANT.availability || 'immediately';
    const pattern = avMap[avKey];
    return options.find(o => pattern && pattern.test(o.text)) || options[0] || null;
  }
  if (/prefer.*work.*home|work.*from.*home.*prefer|remote.*prefer|prefer.*remote/i.test(q)) {
    return options.find(o => /^yes|remote|home/i.test(o.text)) || options[0] || null;
  }
  if (/driving.*licen|licen.*driving|valid.*licen/i.test(q)) {
    return cfg.APPLICANT.drivingLicence
      ? options.find(o => /^yes/.test(o.text))
      : options.find(o => /^no/.test(o.text));
  }
  if (/salary|compensation|expected pay|remuneration/i.test(q)) {
    const sal = cfg.APPLICANT.salaryExpectation;
    if (sal) {
      const num = parseInt(sal.replace(/[^0-9]/g, ''), 10);
      return options.find(o => {
        const nums = o.text.match(/\d[\d,]*/g);
        if (nums && nums.length >= 2) return num >= parseInt(nums[0].replace(/,/g, ''), 10) && num <= parseInt(nums[1].replace(/,/g, ''), 10);
        return false;
      }) || options[Math.floor(options.length / 2)] || null;
    }
    return options[Math.floor(options.length / 2)] || null;
  }
  // Unknown question — try the AI fallback before the blunt default. (Sensitive
  // questions were already handled above and are refused inside aiPickOption.)
  const aiPick = await ai.aiPickOption({ question, options, job, kind: 'dropdown' });
  if (aiPick) {
    console.log(`  [LinkedIn] AI answered dropdown: "${question}" → "${aiPick.text}"`);
    return aiPick;
  }

  // Unknown and AI unavailable/declined — default to Yes, then first option
  const fallback = options.find(o => /^yes/.test(o.text)) || options[0] || null;
  if (q) console.log(`  [LinkedIn] Unknown dropdown (no AI): "${question}" — selected: "${fallback?.text}"`);
  return fallback;
}

// ── CUSTOM DROPDOWNS (LinkedIn artdeco button+listbox components) ─────────
// LinkedIn uses button[aria-haspopup="listbox"] instead of native <select>
// for many of its newer form builder fields. This handles those.
async function _answerCustomDropdowns(page, job) { // page may be a modal ElementHandle
  try {
    const triggers = await page.$$('button[aria-haspopup="listbox"], [role="combobox"] button, [data-test-form-builder-dropdown] button');
    for (const trigger of triggers) {
      const isVisible = await trigger.isVisible().catch(() => false);
      if (!isVisible) continue;

      // Skip if already has a real selection (not placeholder text)
      const currentText = (await trigger.innerText().catch(() => '')).toLowerCase().trim();
      if (currentText && !/select an option|please select|choose/.test(currentText) && currentText !== '') continue;

      // Get the question label from the enclosing form element
      const question = await trigger.evaluate(el => {
        const container = el.closest('.jobs-easy-apply-form-element, [class*="form-element"], .fb-dash-form-element, [data-test-form-builder-dropdown]')
                       || el.parentElement?.parentElement;
        if (!container) return '';
        const lab = container.querySelector('label, legend, .jobs-easy-apply-form-element__label');
        return (lab ? lab.innerText : '').trim();
      });

      // Open the dropdown
      await trigger.click().catch(() => {});
      await DELAY(600);

      // Collect visible options from the listbox
      const options = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll(
          '[role="option"]:not([aria-disabled="true"]), [data-test-text-selectable-option], li[class*="listbox__item"]'
        )).filter(el => el.offsetParent !== null);
        return opts.map(o => ({ text: (o.innerText || o.textContent || '').trim().toLowerCase() }));
      });

      if (!options.length) {
        await page.keyboard.press('Escape');
        await DELAY(300);
        continue;
      }

      const chosen = await resolveDropdownChoice(question, options, job);
      if (chosen) {
        const clicked = await page.evaluate((targetText) => {
          const opts = Array.from(document.querySelectorAll(
            '[role="option"]:not([aria-disabled="true"]), [data-test-text-selectable-option], li[class*="listbox__item"]'
          )).filter(el => el.offsetParent !== null);
          const opt = opts.find(o => (o.innerText || o.textContent || '').trim().toLowerCase() === targetText);
          if (opt) { opt.click(); return true; }
          return false;
        }, chosen.text);
        if (!clicked) {
          console.log(`  [LinkedIn] Dropdown option "${chosen.text}" not clickable — closing`);
          await page.keyboard.press('Escape');
        }
      } else {
        await page.keyboard.press('Escape');
      }
      await DELAY(400);
    }
  } catch (_) {}
}

// ── CHECKBOXES (agreement / consent boxes) ────────────────────────────────
async function _answerCheckboxes(page) {
  try {
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const isVisible = await cb.isVisible().catch(() => false);
      if (!isVisible) continue;
      const checked = await cb.isChecked().catch(() => false);
      if (checked) continue;

      const label = await cb.evaluate(el => {
        const lab = document.querySelector(`label[for="${el.id}"]`)
                 || el.closest('label')
                 || el.parentElement?.querySelector('label');
        return (lab ? lab.innerText : el.getAttribute('aria-label') || '').toLowerCase().trim();
      });

      if (/agree|accept|confirm|consent|policy|terms|privacy|certif|acknowledge/i.test(label)) {
        await cb.click().catch(() => {});
        console.log(`  [LinkedIn] Checked: "${label.substring(0, 70)}"`);
      } else if (/do not|opt.?out|unsubscribe|decline/i.test(label)) {
        // Deliberate opt-out box — leave unchecked
      } else if (label) {
        console.log(`  [LinkedIn] Unchecked unknown checkbox: "${label.substring(0, 70)}"`);
      }
    }
  } catch (_) {}
}

async function _answerRadios(page, job) {
  // Find radio groups. LinkedIn Easy Apply wraps each question in a <fieldset> /
  // [role="radiogroup"] / [data-test-form-builder-radio-button-form-component].
  const groups = await page.$$('fieldset, [role="radiogroup"], [data-test-form-builder-radio-button-form-component]').catch(() => []);
  for (const group of groups) {
    try {
      // Only process LEAF groups — a wrapper that also contains a nested fieldset/
      // radiogroup would merge two questions' options. Skip it; the inner group is
      // iterated separately.
      const isLeaf = await group.evaluate(el => !el.querySelector('fieldset, [role="radiogroup"]')).catch(() => true);
      if (!isLeaf) continue;

      // Collect options — support BOTH native <input type="radio"> AND LinkedIn's
      // newer ARIA <div role="radio"> widgets (obfuscated classes, no <input>).
      // Prefer the ARIA element: LinkedIn's React handlers listen on it, so
      // clicking a hidden native input often doesn't register the selection.
      let radios = await group.$$('[role="radio"]').catch(() => []);
      const ariaMode = radios.length > 0;
      if (!ariaMode) radios = await group.$$('input[type="radio"]').catch(() => []);
      if (!radios.length) continue;

      const groupText = (await group.evaluate(el => (el.textContent || '')).catch(() => '')) || '';
      const gtLower = groupText.toLowerCase();
      // Skip LinkedIn's résumé picker (also radios) — it's not a question.
      if (/\.pdf|\.docx|\bresume\b|\bcv\b/.test(gtLower) && !/\byes\b|\bno\b/.test(gtLower)) continue;

      const options = [];
      for (const radio of radios) {
        const labelText = await radio.evaluate(el => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();
          // ARIA radio: its own label is aria-label or its visible text.
          if (el.getAttribute('role') === 'radio') {
            return clean(el.getAttribute('aria-label') || el.textContent).toLowerCase();
          }
          const id = el.id;
          const lab = (id && document.querySelector(`label[for="${id}"]`)) ||
                      el.closest('label') ||
                      el.parentElement?.querySelector('label') ||
                      el.nextElementSibling;
          return clean(el.getAttribute('aria-label') || (lab ? (lab.innerText || lab.textContent) : '')).toLowerCase();
        }).catch(() => '');
        options.push({ radio, label: labelText, aria: ariaMode });
      }

      // Derive the QUESTION robustly and CLASS-AGNOSTICALLY (LinkedIn renames its
      // CSS classes often — the old class-only extraction returned empty on the new
      // DOM, which meant even sponsorship/commute went unanswered). Try, in order:
      // ARIA labelling → known label classes → the wrapper's non-option text (the
      // question is usually a sibling above the options). Options + boilerplate are
      // stripped out.
      const stripOpts = (s) => {
        let out = ' ' + (s || '').toLowerCase() + ' ';
        for (const o of options) {
          if (o.label && o.label.length >= 2) {
            out = out.replace(new RegExp('\\b' + o.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), ' ');
          }
        }
        return out
          .replace(/this field is required|is required|select an option|please select|learn more|not sure how to answer[^?]*\??/gi, ' ')
          .replace(/\byes\b|\bno\b/gi, ' ')
          // Option labels concatenate with no whitespace in textContent ("YesNo"),
          // so the word-boundary strips above miss them — remove the fused form too.
          .replace(/\b(?:yes|no)+\b/gi, ' ')
          .replace(/\s+/g, ' ').trim();
      };
      let question = '';
      const labelText = await group.evaluate(el => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const meaningful = (t) => {
          const c = clean(t);
          const letters = c.replace(/[^a-z]/gi, '');
          return (letters.length > 5 && !/^(?:yesno|noyes)+$/i.test(letters)) ? c : '';
        };
        // (a) ARIA labelling on the group — most robust, immune to class churn.
        const lb = el.getAttribute('aria-labelledby');
        if (lb) {
          const txt = lb.split(/\s+/).map(id => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
          const m = meaningful(txt); if (m) return m;
        }
        const al = meaningful(el.getAttribute('aria-label')); if (al) return al;
        // (b) known label classes (older DOM).
        const container = el.closest(
          '.jobs-easy-apply-form-element, .fb-dash-form-element, [data-test-form-builder-radio-button-form-component], [class*="form-element"]'
        ) || el;
        const sel = [
          'span[data-test-form-builder-radio-button-form-component__title]',
          '.fb-dash-form-element__label',
          '.jobs-easy-apply-form-element__label',
          'legend span', 'legend',
          '[class*="form-element__label"]',
          'label:not([for])',
        ].join(',');
        for (const scope of [container, container.parentElement].filter(Boolean)) {
          for (const node of scope.querySelectorAll(sel)) {
            const m = meaningful(node.textContent); if (m) return m;
          }
        }
        // (c) class-agnostic fallback: the question is the wrapper's text that is
        // NOT inside a radio option and isn't error/boilerplate. Prefer a clause
        // ending in "?", else the longest candidate, scanning tightest scope first.
        for (const scope of [el.parentElement, container, container.parentElement].filter(Boolean)) {
          let best = '';
          for (const node of scope.querySelectorAll('span, label, legend, p, h3, h4, div')) {
            if (node.querySelector('[role="radio"], input[type="radio"]')) continue; // skip option containers
            if (node.closest('[role="radio"]')) continue;                            // skip option internals
            const c = clean(node.textContent);
            if (/required|select an option|not sure how to answer/i.test(c)) continue;
            const m = meaningful(c); if (!m) continue;
            if (/\?/.test(m)) return m;
            if (m.replace(/[^a-z]/gi, '').length > best.replace(/[^a-z]/gi, '').length) best = m;
          }
          if (best) return best;
        }
        return '';
      }).catch(() => '');
      if (labelText) question = stripOpts(labelText);
      // fallback: a "?"-terminated clause anywhere in the group text
      if (!question || question.replace(/[^a-z]/g, '').length < 5) {
        const qMatches = gtLower.match(/[^.?!]*\?/g);
        if (qMatches) {
          const cand = qMatches.map(stripOpts).filter(s => s.replace(/[^a-z]/g, '').length > 5);
          if (cand.length) question = cand.sort((a, b) => b.length - a.length)[0];
        }
      }
      // last resort — whole group text minus options/boilerplate
      if (!question || question.replace(/[^a-z]/g, '').length < 5) question = stripOpts(gtLower);
      let target = null;
      const _yn = sensitiveYesNo(question, job);
      if (_yn) {
        target = options.find(o => _yn === 'yes' ? /^yes/.test(o.label) : /^no/.test(o.label));
        if (/sponsor/i.test(question)) console.log(`  [LinkedIn] Sponsorship question → ${_yn === 'yes' ? 'Yes' : 'No'}`);
      } else if (/commut|travel to|able to.*office|willing to.*office|office.*location|onsite setting|comfortable.*onsite|comfortable.*office/i.test(question)) {
        const wantsOnsite = cfg.WORK_TYPE_PRIORITY.includes('onsite');
        target = wantsOnsite
          ? options.find(o => /^yes/.test(o.label))
          : options.find(o => /^no/.test(o.label));
      } else if (/british|uk citizen|citizen.*uk|nationality/i.test(question)) {
        target = options.find(o => /^yes/.test(o.label));
      } else if (/gender|sex(?!ual)/i.test(question)) {
        const g = cfg.APPLICANT.eeoGender;
        if (g === 'female') target = options.find(o => /\bfemale\b|\bwoman\b/i.test(o.label));
        else if (g === 'nonbinary') target = options.find(o => /non.?binary|other|self.?describ/i.test(o.label));
        else if (!g) target = options.find(o => /prefer not|decline|not.*say/i.test(o.label)) || options[options.length - 1];
        else target = options.find(o => /\bman\b|^male$|\bmale\b/i.test(o.label));
      } else if (/disability|disabled|chronic/i.test(question)) {
        const d = cfg.APPLICANT.eeoDisability;
        if (d === 'yes') target = options.find(o => /^yes/i.test(o.label));
        else if (d === 'no') target = options.find(o => /^no/i.test(o.label));
        else target = options.find(o => /prefer not|decline|not.*say/i.test(o.label)) || options[options.length - 1];
      } else if (/veteran|protected veteran|military/i.test(question)) {
        const v = cfg.APPLICANT.eeoVeteran;
        if (v === 'yes') target = options.find(o => /^yes|^i am a.*veteran|^protected/i.test(o.label));
        else if (v === 'no') target = options.find(o => /^no|^not a/i.test(o.label));
        else target = options.find(o => /prefer not|decline|not.*say/i.test(o.label)) || options[options.length - 1];
      } else if (/sexual orientation|sexuality/i.test(question)) {
        target = options.find(o => /straight|heterosexual/i.test(o.label));
      } else if (/ethnic|race|racial/i.test(question)) {
        const eth = cfg.APPLICANT.eeoEthnicity;
        if (eth === 'white') target = options.find(o => /\bwhite\b/i.test(o.label) && !/hispanic/i.test(o.label));
        else if (eth === 'black') target = options.find(o => /black.*african|african.*black|\bblack\b/i.test(o.label));
        else if (eth === 'asian') target = options.find(o => /\basian\b/i.test(o.label));
        else if (eth === 'hispanic') target = options.find(o => /hispanic|latino/i.test(o.label));
        else if (eth === 'mixed') target = options.find(o => /mixed|multiple/i.test(o.label));
        else if (eth === 'mena') target = options.find(o => /middle east|north african/i.test(o.label));
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
        const pattern = avMap[avKey];
        target = options.find(o => pattern && pattern.test(o.label)) || options[0];
      } else if (/experience|work.*with|have you.*used|familiar|proficient/i.test(question)) {
        target = options.find(o => /^yes/.test(o.label));
      } else if (/reloc/i.test(question)) {
        target = cfg.APPLICANT.willingToRelocate
          ? options.find(o => /^yes/.test(o.label))
          : options.find(o => /^no/.test(o.label));
      } else if (/driving.*licen|licen.*driving|valid.*licen|licen.*valid/i.test(question)) {
        target = cfg.APPLICANT.drivingLicence
          ? options.find(o => /^yes/.test(o.label))
          : options.find(o => /^no/.test(o.label));
      } else if (question && !ai.isSensitiveQuestion(question)) {
        // Unknown non-sensitive question — ask the LLM to pick from the options
        // instead of skipping (which left it blank → validation error → abandon).
        const picked = await ai.aiPickOption({
          question,
          options: options.map(o => ({ text: o.label, radio: o.radio })),
          job,
          kind: 'radio',
        });
        if (picked) {
          target = { radio: picked.radio, label: picked.text };
          console.log(`  [LinkedIn] AI answered radio: "${question}" → "${picked.text}"`);
        }
      }
      // Last-resort default: a gate question we couldn't map (AI declined or
      // returned an unmatchable answer). Disqualifying/sensitive questions were
      // already handled above, so for anything else the affirmative option is the
      // safe pick — and it beats leaving a REQUIRED radio blank, which stalls the
      // whole form in an endless re-upload loop.
      if (!target && question && !ai.isSensitiveQuestion(question)) {
        const yesOpt = options.find(o => /^\s*yes\b/i.test(o.label))
          || options.find(o => /^\s*i\s+(do|have|am|can|would|will)\b/i.test(o.label))
          || options.find(o => /\b(agree|confirm|accept)\b/i.test(o.label));
        if (yesOpt) {
          target = yesOpt;
          console.log(`  [LinkedIn] Defaulted unmatched radio "${(question || '').slice(0, 45)}" → "${yesOpt.label}"`);
        }
      }
      if (!target) {
        // Still unanswered — log (with a DOM snippet when the label couldn't be
        // extracted, so we can pinpoint LinkedIn DOM changes from the agent log)
        // and skip rather than guessing wrong; tryNext() surfaces the validation error.
        if (!question) {
          const snip = await group.evaluate(el => (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 320)).catch(() => '');
          console.log(`  [LinkedIn] Radio label not extracted — DOM: ${snip}`);
        } else {
          console.log(`  [LinkedIn] Unknown radio question: "${question}" — skipping`);
        }
        continue;
      }
      if (target) {
        // Works for BOTH ARIA radios (aria-checked) and native inputs (checked).
        // Also treats a checked hidden <input> inside an ARIA widget as success.
        const isChecked = () => target.radio.evaluate(el => {
          if (el.getAttribute('role') === 'radio') {
            if (el.getAttribute('aria-checked') === 'true') return true;
            const inp = el.querySelector('input[type="radio"]');
            return !!(inp && inp.checked);
          }
          return !!el.checked;
        }).catch(() => false);
        if (!(await isChecked())) {
          await target.radio.scrollIntoViewIfNeeded().catch(() => {});
          // Custom ARIA radios don't always react to a plain click and re-render
          // asynchronously — try a cascade, settling between attempts:
          //   1) Playwright actionable click on the widget
          //   2) Space-key activation (the standard ARIA radio keyboard pattern)
          //   3) JS click on the widget/label + flip any hidden native <input>
          const attempts = [
            async () => { await target.radio.click({ timeout: 3000 }); },
            async () => { await target.radio.press('Space'); },
            async () => {
              await target.radio.evaluate(el => {
                const widget = el.getAttribute('role') === 'radio'
                  ? el
                  : ((el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label') || el);
                widget.click();
                const inp = el.querySelector?.('input[type="radio"]')
                  || el.closest('[role="radio"]')?.querySelector('input[type="radio"]');
                if (inp && !inp.checked) {
                  inp.checked = true;
                  inp.dispatchEvent(new Event('input',  { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                }
              });
            },
          ];
          for (const attempt of attempts) {
            try { await attempt(); } catch (_) {}
            await DELAY(400);
            if (await isChecked()) break;
          }
          if (await isChecked()) {
            console.log(`  [LinkedIn] Set radio "${(question || '').slice(0, 45)}" → "${target.label}"`);
          } else {
            // Still not set — dump the option's real DOM so we can pinpoint the widget.
            const dom = await target.radio.evaluate(el =>
              ((el.closest('[role="radio"]') || el).outerHTML || '').replace(/\s+/g, ' ').slice(0, 400)
            ).catch(() => '(detached)');
            console.log(`  [LinkedIn] ⚠ Radio not set: "${(question || '').slice(0, 50)}" — OPT DOM: ${dom}`);
          }
        }
      }
    } catch (err) {
      console.log(`  [LinkedIn] Radio fill error: ${err.message}`);
    }
  }
}

async function _answerSelects(page, job) {
  try {
    const selects = await page.$$('select');
    for (const sel of selects) {
      const current = await sel.inputValue().catch(() => '');
      if (current && current !== '') continue;
      const question = await sel.evaluate(el => {
        const id = el.id;
        const lab = id ? document.querySelector(`label[for="${id}"]`) : null;
        return (lab ? lab.innerText : el.closest('.jobs-easy-apply-form-element')?.querySelector('label')?.innerText || '').trim();
      });
      const opts = await sel.evaluate(el =>
        Array.from(el.options).map(o => ({ value: o.value, text: o.text.toLowerCase().trim() }))
      );
      const nonEmpty = opts.filter(o => o.value && o.text && !/select an option|please select/.test(o.text));
      if (!nonEmpty.length) continue;
      const chosen = await resolveDropdownChoice(question, nonEmpty, job);
      if (chosen) await sel.selectOption({ value: chosen.value }).catch(() => {});
    }
  } catch (_) {}
}

async function _fillInput(inp, value) {
  const v = String(value);
  try {
    await inp.click({ clickCount: 3 }).catch(() => {});
    await DELAY(80);
    // Hard-clear first. LinkedIn/Ember inputs sometimes pre-fill or re-render with
    // a value still present, and a plain .fill() can then APPEND rather than replace
    // (e.g. "7" years becomes "77"). Select-all+Delete and blanking el.value make the
    // field empty before we type.
    await inp.press('ControlOrMeta+a').catch(() => {});
    await inp.press('Delete').catch(() => {});
    await inp.evaluate(el => { el.value = ''; }).catch(() => {});
    await inp.fill(v).catch(() => {});
    await DELAY(90);
    // Verify the field holds EXACTLY our value; if a formatter/re-render doubled or
    // mangled it, force it via the DOM and fire the events LinkedIn listens for.
    const got = await inp.inputValue().catch(() => '');
    if (got !== v) {
      await inp.evaluate((el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, v).catch(() => {});
    }
    await DELAY(100);
  } catch (_) {}
}

async function _answerTextInputs(page, job) {
  try {
    const inputs = await page.$$('input[type="number"], input[type="text"], input:not([type])');
    for (const inp of inputs) {
      const isVisible = await inp.isVisible().catch(() => false);
      if (!isVisible) continue;
      // Only skip if there's a meaningful non-zero value already entered
      const current = await inp.inputValue().catch(() => '');
      const type = await inp.getAttribute('type').catch(() => 'text');
      if (current && (type !== 'number' || Number(current) !== 0)) continue;
      const question = await inp.evaluate(el => {
        const id = el.id;
        // Try label[for] association first
        if (id) {
          const lab = document.querySelector(`label[for="${id}"]`);
          if (lab) return lab.innerText.toLowerCase();
        }
        // Walk up through multiple LinkedIn form container patterns
        const containers = [
          '.jobs-easy-apply-form-element',
          '.fb-form-element',
          '.fb-text-field',
          '.fb-form-field',
          '[class*="form-element"]',
          '[class*="formElement"]',
          '[class*="form-field"]',
          '[class*="FormField"]',
        ];
        for (const sel of containers) {
          const wrap = el.closest(sel);
          if (wrap) {
            const lab = wrap.querySelector('legend, label, .fb-label, [class*="label"]');
            if (lab && lab !== el) return lab.innerText.toLowerCase();
          }
        }
        // Last resort: parent and grandparent
        for (const ancestor of [el.parentElement, el.parentElement?.parentElement]) {
          if (!ancestor) continue;
          const lab = ancestor.querySelector('label, legend');
          if (lab && lab !== el) return lab.innerText.toLowerCase();
        }
        return '';
      });
      const _yn = sensitiveYesNo(question, job);
      if (_yn) {
        await _fillInput(inp, _yn === 'yes' ? 'Yes' : 'No');
      } else if (/commut|travel to|able to.*office|willing to.*office/i.test(question)) {
        await _fillInput(inp, 'Yes');
      } else if (/year.*experience|experience.*year|how many year|how long/i.test(question)) {
        await _fillInput(inp, cfg.APPLICANT.yearsExperience ?? 0);
      } else if (/salary|expected.*pay|compensation|remuneration/i.test(question)) {
        if (cfg.APPLICANT.salaryExpectation) await _fillInput(inp, cfg.APPLICANT.salaryExpectation);
      } else if (/notice period|availability|available to start|when can you start/i.test(question)) {
        const avText = { 'immediately': 'Immediately available', '1week': '1 week', '2weeks': '2 weeks', '1month': '1 month', '2months': '2 months', '3months': '3 months' };
        await _fillInput(inp, avText[cfg.APPLICANT.availability || 'immediately'] || 'Immediately available');
      } else if (/address\s*line\s*1|street address|^address\b|postal address|\baddress\b/i.test(question)) {
        const addr = cfg.APPLICANT.address || cfg.APPLICANT.location;
        if (addr) await _fillInput(inp, addr);
      } else if (/city|town/i.test(question)) {
        if (cfg.APPLICANT.location) await _fillInput(inp, cfg.APPLICANT.location);
      } else if (/reloc/i.test(question)) {
        await _fillInput(inp, cfg.APPLICANT.willingToRelocate ? 'Yes' : 'No');
      } else if (/middle\s*name|middle\s*initial/i.test(question)) {
        // Fill the user's middle name, or leave BLANK if they have none. Never let
        // a name field reach the AI fallback — it would invent a random name.
        if (cfg.APPLICANT.middleName) await _fillInput(inp, cfg.APPLICANT.middleName);
      } else if (/first\s*name|given\s*name|forename/i.test(question)) {
        if (cfg.APPLICANT.firstName) await _fillInput(inp, cfg.APPLICANT.firstName);
      } else if (/last\s*name|surname|family\s*name/i.test(question)) {
        if (cfg.APPLICANT.lastName) await _fillInput(inp, cfg.APPLICANT.lastName);
      } else if (/full\s*name|your\s*name|legal\s*name|preferred\s*name/i.test(question)) {
        const full = [cfg.APPLICANT.firstName, cfg.APPLICANT.middleName, cfg.APPLICANT.lastName].filter(Boolean).join(' ');
        if (full) await _fillInput(inp, full);
      } else {
        if (type === 'number') {
          await _fillInput(inp, cfg.APPLICANT.yearsExperience ?? 0);
        } else {
          // Unknown text field — ask the LLM for a short answer before falling
          // back to yearsExperience (the old blunt default).
          let val = null;
          if (question && !ai.isSensitiveQuestion(question)) {
            val = await ai.aiTextAnswer({ question, job, long: false });
          }
          if (val) {
            await _fillInput(inp, val);
            console.log(`  [LinkedIn] AI answered text field: "${question || '(no label)'}" → "${val}"`);
          } else {
            const yr = String(cfg.APPLICANT.yearsExperience ?? 0);
            await _fillInput(inp, yr);
            console.log(`  [LinkedIn] Unknown text field (no AI): "${question || '(no label)'}" — filled with yearsExperience (${yr})`);
          }
        }
      }
    }
  } catch (_) {}
}

async function _answerTextareas(page, job) {
  try {
    const textareas = await page.$$('textarea');
    for (const ta of textareas) {
      const isVisible = await ta.isVisible().catch(() => false);
      if (!isVisible) continue;
      const current = await ta.inputValue().catch(() => '');
      if (current && current.trim()) continue;
      const ctx = await ta.evaluate(el => {
        const formEl = el.closest('.jobs-easy-apply-form-element, [class*="form-element"]');
        const labelEl = formEl
          ? (formEl.querySelector('label, .jobs-easy-apply-form-element__label, legend') || {})
          : (document.querySelector(`label[for="${el.id}"]`) || {});
        return { required: el.required, label: (labelEl.innerText || '').trim() };
      });
      if (!ctx.required && !ctx.label) continue;
      // Cover letters use the pre-generated tailored letter; everything else
      // (open "describe a time…" prompts) gets an AI answer, falling back to the
      // canned template if AI is unavailable/declined.
      const lblLower = (ctx.label || '').toLowerCase();
      let text;
      if (/cover letter|covering letter|cover note/.test(lblLower)) {
        text = buildTextareaAnswer(ctx.label, job || {});
      } else {
        text = (!ai.isSensitiveQuestion(ctx.label) && await ai.aiTextAnswer({ question: ctx.label, job, long: true }))
          || buildTextareaAnswer(ctx.label, job || {});
      }
      if (text) {
        await ta.click().catch(() => {}); await DELAY(80);
        await ta.fill(text).catch(() => {});
        console.log(`  [LinkedIn] Filled textarea: "${ctx.label || '(unlabelled)'}"`);
      } else {
        console.log(`  [LinkedIn] Skipping optional textarea: "${ctx.label}"`);
      }
    }
  } catch (_) {}
}

async function trySubmit(page, job) {
  const submitSelectors = [
    'button[aria-label="Submit application"]',
    'button:has-text("Submit application")',
    'footer button:has-text("Submit")',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        console.log(`  [LinkedIn] Review complete — submitting: ${job?.title} @ ${job?.company}`);
        await page.screenshot({ path: path.join(SSDIR, 'apply_review_before_submit.png') });
        await btn.click();
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// Extract labels of currently visible form validation errors
async function getVisibleErrorFields(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(
      '.artdeco-inline-feedback--error, .fb-dash-form-element__error-field, [class*="inline-feedback--error"]'
    ))
      .filter(el => el.offsetParent !== null)
      .map(el => {
        const formEl = el.closest('.jobs-easy-apply-form-element, [class*="form-element"], .fb-dash-form-element');
        const lab = formEl?.querySelector('label, legend');
        return lab ? lab.innerText.trim() : '(unknown field)';
      })
      .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
  ).catch(() => []);
}

async function tryNext(page, job) {
  const nextSelectors = [
    'button[aria-label="Continue to next step"]',
    'button:has-text("Next")',
    'button:has-text("Review")',
    'footer button',
  ];
  for (const sel of nextSelectors) {
    try {
      const btn = await page.$(sel);
      if (!btn || !await btn.isVisible() || !await btn.isEnabled()) continue;

      // First attempt
      await btn.click();
      await DELAY(3000);

      let errors = await getVisibleErrorFields(page);
      if (!errors.length) return true;

      // Form has errors — the missed fields are still empty, so re-running the
      // answerers now escalates them to the AI fallback (#2). Retry once.
      console.log(`  [LinkedIn] Required field(s) unmet: ${errors.join(', ')} — re-answering (AI escalation)`);
      await answerScreeningQuestions(page, job);
      await DELAY(1000);

      const btn2 = await page.$(sel).catch(() => null);
      if (btn2 && await btn2.isVisible() && await btn2.isEnabled()) {
        await btn2.click();
        await DELAY(3000);
      }

      errors = await getVisibleErrorFields(page);
      if (!errors.length) return true;

      console.log(`  [LinkedIn] Still blocked after retry: ${errors.join(', ')} — abandoning`);
      return false;
    } catch (_) {}
  }
  return false;
}

async function dismissModal(page) {
  // Try dismiss button first
  const dismissSelectors = [
    '[aria-label="Dismiss"]',
    'button[aria-label="Discard"]',
    'button:has-text("Discard")',
    'button:has-text("Done")',
    'button:has-text("Dismiss")',
  ];
  for (const sel of dismissSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) { await btn.click(); await DELAY(1500); return; }
    } catch (_) {}
  }
  // If dismiss opened a confirmation dialog ("Discard application?"), confirm it
  try {
    await page.click('button:has-text("Discard"), button:has-text("Leave"), button:has-text("Confirm")', { timeout: 3000 });
    await DELAY(1000);
  } catch (_) {}
}

async function ensureLoggedIn(page) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(2000);
  const isLoggedIn = await page.evaluate(() => {
    const t = (document.body?.innerText || '').toLowerCase();
    return t.includes('home') || t.includes('my network') || t.includes('jobs') ||
           !!document.querySelector('[class*="global-nav"], [class*="feed-identity"]');
  }).catch(() => false);
  if (!isLoggedIn) throw new Error('LinkedIn: not logged in. Click "Connect account" on the LinkedIn bot card first.');
  console.log('  [LinkedIn] Session active');
}

module.exports = { ensureLoggedIn, login, searchJobs, getJobDescription, applyToJob, dismissModal, answerScreeningQuestions, uploadResume, _fillInput };
