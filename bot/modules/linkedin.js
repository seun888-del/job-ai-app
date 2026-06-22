const cfg  = require('../config');
const fs   = require('fs');
const path = require('path');

const SSDIR = cfg.SCREENSHOTS_DIR;
const DELAY = (ms) => new Promise(r => setTimeout(r, ms));

// ── LOGIN ──────────────────────────────────────────────────────────────────
async function login(browser, email, password) {
  console.log('  [LinkedIn] Logging in...');
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(4000);

  const emailInput = page.locator('input[type="email"]').filter({ visible: true }).first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.click();
  await emailInput.fill(email);
  console.log('  [LinkedIn] Email filled.');
  await DELAY(800);

  const passInput = page.locator('input[type="password"]').filter({ visible: true }).first();
  await passInput.waitFor({ state: 'visible', timeout: 10000 });
  await passInput.click();
  await DELAY(400);
  await passInput.pressSequentially(password, { delay: 60 });
  console.log('  [LinkedIn] Password filled.');
  await DELAY(1000);

  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await DELAY(7000);

  // Wait up to 5 minutes — covers CAPTCHA/checkpoint requiring manual action
  const deadline = Date.now() + 300000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    const u = page.url();
    if (u.includes('feed') || u.includes('mynetwork') || (await page.$('.global-nav').catch(() => null))) {
      loggedIn = true;
      break;
    }
    if (u.includes('checkpoint') || u.includes('challenge') || u.includes('captcha') || u.includes('security-check')) {
      console.log('  [LinkedIn] ⚠️  Security check — please complete it in the browser window...');
    }
    await DELAY(5000);
  }

  if (loggedIn) {
    console.log('  [LinkedIn] Logged in successfully.');
  } else {
    console.log('  [LinkedIn] Login failed after 5 minutes. URL:', page.url());
    await page.screenshot({ path: path.join(SSDIR, 'li_login_issue.png') });
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
  await DELAY(2000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await DELAY(800);
  }

  const jobs = await page.evaluate((lim) => {
    const cardSelectors = [
      'li.jobs-search-results__list-item',
      '.job-card-container',
      '[data-job-id]',
      'li[class*="scaffold-layout__list-item"]',
      'div[class*="job-card"]',
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }
    cards = cards.slice(0, lim);

    return cards.map(card => {
      const titleEl   = card.querySelector('.job-card-list__title--link, .job-card-list__title, .job-card-container__link, a[class*="job-card"]');
      const companyEl = card.querySelector('.job-card-container__company-name, .artdeco-entity-lockup__subtitle, [class*="company-name"]');
      const linkEl    = card.querySelector('a[href*="/jobs/view/"]');
      const jobId     = card.getAttribute('data-job-id') || card.getAttribute('data-entity-urn') || '';
      return {
        title:   titleEl   ? titleEl.innerText.trim()   : 'Unknown',
        company: companyEl ? companyEl.innerText.trim() : 'Unknown',
        url:     linkEl    ? 'https://www.linkedin.com' + linkEl.getAttribute('href').split('?')[0] : '',
        jobId:   jobId.replace(/\D/g, ''),
      };
    }).filter(j => j.url);
  }, limit);

  console.log(`  [LinkedIn] Found ${jobs.length} jobs for "${searchTerm}"`);
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
  while (stepCount < MAX_STEPS) {
    stepCount++;
    await DELAY(3000);

    const modalVisible = await page.$('.jobs-easy-apply-modal, [class*="easy-apply-modal"], [aria-label*="Easy Apply"]');
    if (!modalVisible) { console.log('  [LinkedIn] Modal closed.'); break; }

    await page.screenshot({ path: path.join(SSDIR, `apply_0${stepCount}_step.png`) });
    await fillContactFields(page);
    const uploaded = await uploadResume(page, resumePath);
    if (uploaded) console.log('  [LinkedIn] Resume uploaded.');
    await answerScreeningQuestions(page, job);

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

// Build a short professional textarea answer from job and CV context
function buildTextareaAnswer(label, job) {
  const { yearsExperience, salaryExpectation } = cfg.APPLICANT;
  const yearsText = yearsExperience > 0 ? `${yearsExperience} years of` : 'extensive';
  const domain  = (job && job.cvName)  ? job.cvName  : 'IT support and service desk operations';
  const title   = (job && job.title)   ? job.title   : 'this role';
  const company = (job && job.company) ? job.company : 'your organisation';
  const lbl = (label || '').toLowerCase();

  if (/cover letter|covering letter|cover note/i.test(lbl)) {
    return (job && job.coverLetter) || `I am writing to express my strong interest in the ${title} position at ${company}. With ${yearsText} experience in ${domain}, I have developed a proven ability to deliver results in fast-paced environments. I am confident in my ability to contribute effectively from day one and look forward to the opportunity to discuss my application further.`;
  }
  if (/notice period|availability|available to start|when can you start/i.test(lbl)) {
    return 'I am immediately available and can start at short notice.';
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
  const { firstName, lastName, phone, email, location } = cfg.APPLICANT;
  const fills = [
    { sel: 'input[id*="firstName"], input[name*="firstName"]',                                val: firstName },
    { sel: 'input[id*="lastName"], input[name*="lastName"]',                                  val: lastName  },
    { sel: 'input[id*="phone"], input[name*="phone"]',                                        val: phone     },
    { sel: 'input[id*="email"], input[name*="email"]',                                        val: email     },
    { sel: 'input[id*="city"], input[name*="city"], input[placeholder*="ity" i]',             val: 'London'  },
    { sel: 'input[id*="location"], input[name*="location"], input[placeholder*="ocation" i]', val: location  },
  ];
  for (const { sel, val } of fills) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        const current = await el.inputValue();
        if (!current) await el.fill(val);
      }
    } catch (_) {}
  }
}

async function uploadResume(page, resumePath) {
  try {
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) { await fileInput.setInputFiles(resumePath); await DELAY(2000); return true; }
    const uploadBtn = await page.$('button:has-text("Upload resume"), label:has-text("Upload resume"), [aria-label*="upload" i]');
    if (uploadBtn) {
      const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), uploadBtn.click()]);
      await chooser.setFiles(resumePath);
      await DELAY(2000);
      return true;
    }
  } catch (_) {}
  return false;
}

async function answerScreeningQuestions(page, job) {
  await _answerRadios(page, job);
  await _answerCustomDropdowns(page, job);
  await _answerSelects(page, job);
  await _answerTextInputs(page, job);
  await _answerTextareas(page, job);
  await _answerCheckboxes(page);
}

// ── SHARED: resolve which option text to pick for a labelled dropdown ─────
// options is [{text: string}] where text is already lowercased
function resolveDropdownChoice(question, options, job) {
  const q = question.toLowerCase();
  const yr = cfg.APPLICANT.yearsExperience ?? 0;

  if (/require.*sponsor|need.*sponsor|visa.*sponsor|sponsor.*visa|will.*need.*sponsor|employer.*sponsor/i.test(q)) {
    const needs = cfg.APPLICANT.requiresSponsorship;
    return options.find(o => needs ? /^yes/.test(o.text) : /^no/.test(o.text)) || null;
  }
  if (/right to work|work permit|authoris|authoriz|eligible.*work|legal.*work|work.*authoris/i.test(q)) {
    const rtw = hasRightToWork(job?.description);
    return options.find(o => rtw ? /^yes/.test(o.text) : /^no/.test(o.text)) || null;
  }
  if (/commut|travel to|able to.*office|willing to.*office|office.*location/i.test(q)) {
    return options.find(o => /^yes/.test(o.text)) || options[0] || null;
  }
  if (/british|uk citizen|citizen.*uk|nationality/i.test(q)) {
    return options.find(o => /^yes/.test(o.text)) || null;
  }
  if (/gender/i.test(q)) {
    return options.find(o => /\bman\b|^male$/.test(o.text) || (o.text.includes('man') && !o.text.includes('woman'))) || null;
  }
  if (/sexual orientation|sexuality/i.test(q)) {
    return options.find(o => /straight|heterosexual/i.test(o.text)) || null;
  }
  if (/ethnic|race|racial/i.test(q)) {
    return options.find(o => /black.*african|african.*black|black or african/i.test(o.text)) ||
           options.find(o => /\bblack\b/i.test(o.text)) || null;
  }
  if (/year.*experience|experience.*year|how many year|how long|years in/i.test(q)) {
    const m = options.find(o => new RegExp(`\\b${yr}\\b`).test(o.text)) ||
              options.find(o => { const n = o.text.match(/\d+/g); return n && n.length >= 2 && yr >= Number(n[0]) && yr <= Number(n[1]); }) ||
              options.find(o => { const n = o.text.match(/\d+/g); return n && /\+|more|above|over/.test(o.text) && yr >= Number(n[0]); }) ||
              options[options.length - 1];
    return m || null;
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
  // Unknown — default to Yes, then first option
  const fallback = options.find(o => /^yes/.test(o.text)) || options[0] || null;
  if (q) console.log(`  [LinkedIn] Unknown dropdown: "${question}" — selected: "${fallback?.text}"`);
  return fallback;
}

// ── CUSTOM DROPDOWNS (LinkedIn artdeco button+listbox components) ─────────
// LinkedIn uses button[aria-haspopup="listbox"] instead of native <select>
// for many of its newer form builder fields. This handles those.
async function _answerCustomDropdowns(page, job) {
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

      const chosen = resolveDropdownChoice(question, options, job);
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
  try {
    const fieldsets = await page.$$('fieldset');
    for (const fieldset of fieldsets) {
      const question = await fieldset.evaluate(el => {
        const leg = el.querySelector('legend, .jobs-easy-apply-form-element__label, label');
        return leg ? leg.innerText.toLowerCase() : '';
      });
      const radios = await fieldset.$$('input[type="radio"]');
      if (!radios.length) continue;
      const options = [];
      for (const radio of radios) {
        const labelText = await radio.evaluate(el => {
          const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.parentElement?.querySelector('label');
          return lab ? lab.innerText.toLowerCase().trim() : '';
        });
        options.push({ radio, label: labelText });
      }
      let target = null;
      if (/require.*sponsor|need.*sponsor|visa.*sponsor|sponsor.*visa|will.*need.*sponsor|employer.*sponsor/i.test(question)) {
        const needs = cfg.APPLICANT.requiresSponsorship;
        target = needs ? options.find(o => /^yes/.test(o.label)) : options.find(o => /^no/.test(o.label));
      } else if (/right to work|work permit|authoris|authoriz|eligible.*work|legal.*work|work.*authoris/i.test(question)) {
        const rtw = hasRightToWork(job?.description);
        target = rtw ? options.find(o => /^yes/.test(o.label)) : options.find(o => /^no/.test(o.label));
      } else if (/commut|travel to|able to.*office|willing to.*office|office.*location/i.test(question)) {
        target = options.find(o => /^yes/.test(o.label));
      } else if (/british|uk citizen|citizen.*uk|nationality/i.test(question)) {
        target = options.find(o => /^yes/.test(o.label));
      } else if (/gender|sex(?!ual)/i.test(question)) {
        target = options.find(o => /\bman\b|^male$/i.test(o.label)) || options.find(o => o.label.includes('man') && !o.label.includes('woman'));
      } else if (/sexual orientation|sexuality/i.test(question)) {
        target = options.find(o => /straight|heterosexual/i.test(o.label));
      } else if (/ethnic|race|racial/i.test(question)) {
        target = options.find(o => /black.*african|african.*black|black or african/i.test(o.label)) || options.find(o => /\bblack\b/i.test(o.label));
      } else if (/experience|work.*with|have you.*used|familiar|proficient/i.test(question)) {
        target = options.find(o => /^yes/.test(o.label));
      } else if (/driving.*licen|licen.*driving|valid.*licen|licen.*valid/i.test(question)) {
        target = cfg.APPLICANT.drivingLicence
          ? options.find(o => /^yes/.test(o.label))
          : options.find(o => /^no/.test(o.label));
      } else {
        target = options.find(o => /^yes/.test(o.label)) || options[0];
        console.log(`  [LinkedIn] Unknown radio: "${question}" — selected: "${target?.label}"`);
      }
      if (target) {
        const already = await target.radio.isChecked().catch(() => false);
        if (!already) await target.radio.click().catch(() => {});
      }
    }
  } catch (_) {}
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
      const chosen = resolveDropdownChoice(question, nonEmpty, job);
      if (chosen) await sel.selectOption({ value: chosen.value }).catch(() => {});
    }
  } catch (_) {}
}

async function _answerTextInputs(page, job) {
  try {
    const inputs = await page.$$('input[type="number"], input[type="text"]');
    for (const inp of inputs) {
      const isVisible = await inp.isVisible().catch(() => false);
      if (!isVisible) continue;
      const current = await inp.inputValue().catch(() => '');
      if (current) continue;
      const question = await inp.evaluate(el => {
        const id = el.id;
        const lab = id ? document.querySelector(`label[for="${el.id}"]`) : null;
        return (lab ? lab.innerText : el.closest('.jobs-easy-apply-form-element')?.querySelector('label')?.innerText || '').toLowerCase();
      });
      if (/require.*sponsor|need.*sponsor|visa.*sponsor|sponsor.*visa|employer.*sponsor/i.test(question)) {
        await inp.fill(cfg.APPLICANT.requiresSponsorship ? 'Yes' : 'No').catch(() => {});
      } else if (/right to work|work permit|authoris|authoriz|eligible.*work|legal.*work/i.test(question)) {
        await inp.fill(hasRightToWork(job?.description) ? 'Yes' : 'No').catch(() => {});
      } else if (/commut|travel to|able to.*office|willing to.*office/i.test(question)) {
        await inp.fill('Yes').catch(() => {});
      } else if (/year.*experience|experience.*year|how many year|how long/i.test(question)) {
        await inp.fill(String(cfg.APPLICANT.yearsExperience ?? 0)).catch(() => {});
      } else if (/salary|expected.*pay|compensation|remuneration/i.test(question)) {
        if (cfg.APPLICANT.salaryExpectation) await inp.fill(cfg.APPLICANT.salaryExpectation).catch(() => {});
      } else if (/notice period|availability/i.test(question)) {
        await inp.fill('Immediately available').catch(() => {});
      } else {
        const type = await inp.getAttribute('type').catch(() => 'text');
        if (type === 'number') {
          await inp.fill(String(cfg.APPLICANT.yearsExperience ?? 0)).catch(() => {});
        } else {
          console.log(`  [LinkedIn] Unknown text field: "${question}" — left blank`);
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
      const text = buildTextareaAnswer(ctx.label, job || {});
      if (text) {
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

      // Form has errors — log them, try to fill the missed fields and retry once
      console.log(`  [LinkedIn] Required field(s) unmet: ${errors.join(', ')} — retrying fill`);
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

module.exports = { login, searchJobs, getJobDescription, applyToJob, dismissModal };
