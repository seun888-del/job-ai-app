// Shared external ATS form filler — used by Reed, LinkedIn, Glassdoor etc.
// Handles multi-step application forms on Greenhouse, Lever, Ashby and other
// modern ATS platforms that use consistent UI patterns across all companies.

const cfg = require('../config');
const { llmAvailable, llmChat } = require('../../src/services/llm');

const J = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ── ATS detection by URL ───────────────────────────────────────────────────
function detectATS(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('greenhouse.io') || u.includes('boards.greenhouse'))   return 'greenhouse';
  if (u.includes('lever.co') || u.includes('jobs.lever'))               return 'lever';
  if (u.includes('ashbyhq.com') || u.includes('jobs.ashbyhq'))         return 'ashby';
  if (u.includes('smartrecruiters.com'))                                 return 'smartrecruiters';
  if (u.includes('workable.com'))                                        return 'workable';
  if (u.includes('breezy.hr'))                                           return 'breezy';
  if (u.includes('teamtailor.com'))                                      return 'teamtailor';
  if (u.includes('recruitee.com'))                                       return 'recruitee';
  if (u.includes('pinpointhq.com'))                                      return 'pinpoint';
  if (u.includes('bamboohr.com'))                                        return 'bamboohr';
  if (u.includes('jobvite.com') || u.includes('hire.jobvite'))          return 'jobvite';
  if (u.includes('jazz.co') || u.includes('hire.jazz'))                 return 'jazz';
  if (u.includes('workday') || u.includes('myworkdayjobs.com'))         return 'workday';
  if (u.includes('taleo.net'))                                           return 'taleo';
  if (u.includes('successfactors') || u.includes('sap.com/careers'))    return 'successfactors';
  if (u.includes('icims.com'))                                           return 'icims';
  if (u.includes('adp.com') || u.includes('workforcenow.adp'))          return 'adp';
  if (u.includes('rippling.com'))                                        return 'rippling';
  if (u.includes('personio.'))                                           return 'personio';
  return 'generic';
}

// ATS we can fill without a pre-existing account
const SUPPORTED_ATS = new Set([
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable',
  'breezy', 'teamtailor', 'recruitee', 'pinpoint', 'bamboohr', 'jobvite', 'jazz',
]);

// ATS that require the candidate to already have an account — skip these
const ACCOUNT_REQUIRED_ATS = new Set(['workday', 'taleo', 'successfactors', 'adp', 'icims', 'oracle', 'rippling']);

// ── Main entry point ───────────────────────────────────────────────────────
// Call this after navigating to (or opening) the ATS apply page.
// opts.submit === false → DRY RUN: fill every field (and advance multi-step
// forms) but never click the final submit, so the whole pipeline can be tested
// against a real ATS form without ever sending an application to an employer.
// Returns true (submitted), 'dry_run' (filled, not submitted), or false.
async function fillExternalForm(page, job, resumePath, ats, opts = {}) {
  const dryRun = opts.submit === false;
  // Most ATSes show a job-info page first with an "Apply" / "I'm interested"
  // button that opens (or navigates to) the actual form. Click it, then wait for
  // a form field to render (SPA apply pages, e.g. SmartRecruiters, load async).
  if (['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'breezy', 'teamtailor', 'recruitee'].includes(ats)) {
    for (const sel of [
      'button:has-text("I\'m interested")', 'a:has-text("I\'m interested")',
      'a:has-text("Apply for this job")', 'button:has-text("Apply for this job")',
      'a:has-text("Apply for this position")', 'button:has-text("Apply for this position")',
      'a:has-text("Apply now")', 'button:has-text("Apply now")',
      'button:has-text("Apply")', 'a:has-text("Apply")',
      '.application-button', '[data-qa="btn-apply-bottom"]',
    ]) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), btn.click()]);
          await J(1500, 2500);
          await page.waitForSelector('input[type="email"], input[name*="email" i], input[name*="first" i], input[type="file"]', { timeout: 8000 }).catch(() => {});
          break;
        }
      } catch (_) {}
    }
  }

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    await J(1000, 2000);
    console.log(`  [ATS] ${ats} form step ${step + 1}${dryRun ? ' (dry run)' : ''}`);

    await _uploadResume(page, resumePath);
    await _fillStep(page, job);

    if (dryRun) {
      // Fill this step, then either advance to the next or, if this was the last
      // step, stop WITHOUT submitting.
      const advanced = await _tryNext(page);
      if (!advanced) { console.log('  [ATS] ✓ Dry run — form filled, NOT submitted'); return 'dry_run'; }
      await J(1500, 2500);
      continue;
    }

    const submitted = await _trySubmit(page, ats);
    if (submitted) return true;

    const advanced = await _tryNext(page);
    if (!advanced) {
      console.log(`  [ATS] No more steps to advance`);
      break;
    }
    await J(1500, 2500);
  }

  return false;
}

// ── Resume upload ──────────────────────────────────────────────────────────
async function _uploadResume(page, resumePath) {
  if (!resumePath) return;
  const sels = [
    'input[type="file"][accept*="pdf"]', 'input[type="file"][name*="resume" i]',
    'input[type="file"][name*="cv" i]',  'input[type="file"][id*="resume" i]',
    'input[type="file"][id*="cv" i]',    'input[type="file"]',
  ];
  for (const sel of sels) {
    try {
      const fi = await page.$(sel);
      if (fi) {
        const already = await fi.evaluate(el => el.files?.length || 0).catch(() => 0);
        if (!already) {
          await fi.setInputFiles(resumePath);
          await J(2000, 3500);
          console.log('  [ATS] Resume uploaded');
        }
        return;
      }
    } catch (_) {}
  }
}

// ── Fill all visible fields on the current step ───────────────────────────
async function _fillStep(page, job) {
  const { firstName, lastName, email, phone, linkedin, location,
          yearsExperience, salaryExpectation, availability,
          rightToWorkCountries } = cfg.APPLICANT;

  const knownFields = [
    { val: firstName,                         sels: ['input[name="first_name"]', 'input[name="firstname"]', 'input[id*="first_name" i]', 'input[id*="firstName" i]', 'input[placeholder*="First name" i]', 'input[autocomplete="given-name"]'] },
    { val: lastName,                          sels: ['input[name="last_name"]',  'input[name="lastname"]',  'input[id*="last_name" i]',  'input[id*="lastName" i]',  'input[placeholder*="Last name" i]',  'input[autocomplete="family-name"]'] },
    { val: `${firstName} ${lastName}`.trim(), sels: ['input[name="full_name"]',  'input[name="name"]',      'input[id*="full_name" i]',  'input[placeholder*="Full name" i]',  'input[autocomplete="name"]'] },
    { val: email,                             sels: ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="Email" i]', 'input[autocomplete="email"]'] },
    { val: phone,                             sels: ['input[type="tel"]',   'input[name*="phone" i]', 'input[id*="phone" i]', 'input[placeholder*="Phone" i]', 'input[placeholder*="Mobile" i]', 'input[autocomplete="tel"]'] },
    { val: linkedin || '',                    sels: ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[placeholder*="LinkedIn" i]', 'input[aria-label*="LinkedIn" i]'] },
    { val: location || '',                    sels: ['input[name*="location" i]', 'input[id*="location" i]', 'input[placeholder*="Location" i]', 'input[autocomplete="address-level2"]'] },
  ];

  for (const { val, sels } of knownFields) {
    if (!val) continue;
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          if (await el.inputValue().catch(() => '')) break;
          await el.click(); await J(80, 200);
          await el.type(val, { delay: 55 + Math.random() * 75 });
          await J(80, 150);
          break;
        }
      } catch (_) {}
    }
  }

  // Unknown text inputs — label-matched with rules + AI fallback
  const allInputs = await page.$$('input[type="text"], input[type="number"], input:not([type])');
  for (const inp of allInputs) {
    try {
      if (!await inp.isVisible()) continue;
      if (await inp.inputValue().catch(() => '')) continue;
      const { label, placeholder } = await inp.evaluate(el => {
        const lab  = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wl   = wrap?.querySelector('label, legend, [class*="label"], [class*="Label"]');
        return { label: (lab?.innerText || wl?.innerText || '').trim(), placeholder: el.placeholder || '' };
      }).catch(() => ({ label: '', placeholder: '' }));

      const question = label || placeholder;
      if (!question) continue;
      const answer = await _buildAnswer(question, 'text', job);
      if (answer) {
        await inp.click(); await J(80, 200);
        await inp.type(answer, { delay: 55 + Math.random() * 75 });
        await J(80, 150);
        console.log(`  [ATS] Filled "${question.substring(0, 50)}" → "${answer.substring(0, 40)}"`);
      }
    } catch (_) {}
  }

  // Select dropdowns
  const selects = await page.$$('select');
  for (const sel of selects) {
    try {
      if (!await sel.isVisible()) continue;
      const currentVal = await sel.inputValue().catch(() => '');
      if (currentVal && currentVal !== '0' && currentVal !== '') continue;

      const { question, options } = await sel.evaluate(el => {
        const lab  = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wl   = wrap?.querySelector('label, legend, [class*="label"]');
        const question = (lab?.innerText || wl?.innerText || el.getAttribute('aria-label') || '').trim();
        const options  = Array.from(el.options).map(o => ({ val: o.value, text: o.text.trim() })).filter(o => o.val && o.val !== '0');
        return { question, options };
      }).catch(() => ({ question: '', options: [] }));

      if (!question || !options.length) continue;
      const chosen = _pickDropdownOption(question, options) || await _aiPickOption(question, options.map(o => o.text), job);
      if (chosen) {
        const match = options.find(o => o.text === chosen || o.val === chosen)
          || options.find(o => o.text.trim().toLowerCase() === String(chosen).trim().toLowerCase());
        if (match) { await sel.selectOption(match.val); await J(200, 400); console.log(`  [ATS] Select "${question.substring(0, 40)}" → "${chosen}"`); }
        else console.log(`  [ATS] ⚠ Dropdown no match: "${question.substring(0, 40)}" (wanted "${chosen}")`);
      } else {
        console.log(`  [ATS] ⚠ No answer for dropdown: "${question.substring(0, 50)}"`);
      }
    } catch (_) {}
  }

  // Radio groups
  const radios = await page.$$('input[type="radio"]');
  const groupsSeen = new Set();
  for (const radio of radios) {
    try {
      if (!await radio.isVisible()) continue;
      const { groupName, legend, options } = await radio.evaluate(el => {
        const name     = el.name || '';
        const fieldset = el.closest('fieldset');
        const legend   = (fieldset?.querySelector('legend')?.innerText || '').trim();
        const wrap     = el.closest('[class*="question"],[class*="Question"],[class*="field"],[class*="Field"]');
        const wl       = (wrap?.querySelector('label, legend, [class*="label"]')?.innerText || '').trim();
        const allR     = name ? Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`)) : [el];
        const options  = allR.map(r => { const lab = r.id ? document.querySelector(`label[for="${r.id}"]`) : r.closest('label'); return { val: r.value, text: (lab?.innerText || r.value || '').trim() }; });
        return { groupName: name, legend: legend || wl, options };
      }).catch(() => ({ groupName: '', legend: '', options: [] }));

      if (!groupName || groupsSeen.has(groupName) || !options.length) continue;
      groupsSeen.add(groupName);
      const alreadyChecked = await page.$eval(`input[type="radio"][name="${groupName}"]:checked`, () => true).catch(() => false);
      if (alreadyChecked) continue;

      const chosen = _pickRadioOption(legend, options.map(o => o.text)) || await _aiPickOption(legend, options.map(o => o.text), job);
      if (chosen) {
        // Click by index (LinkedIn hides the real <input> and styles the label,
        // so a value-based click often does nothing). Verify it actually checked,
        // and fall back to clicking the associated label.
        const idx = options.findIndex(o => o.text === chosen);
        const groupRadios = idx >= 0 ? await page.$$(`input[type="radio"][name="${groupName}"]`) : [];
        const target = groupRadios[idx];
        let ok = false;
        if (target) {
          try { await target.click({ timeout: 2000 }); ok = await target.isChecked().catch(() => false); } catch (_) {}
          if (!ok) {
            try {
              await target.evaluate(el => {
                const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : el.closest('label');
                (lab || el).click();
              });
              ok = await target.isChecked().catch(() => false);
            } catch (_) {}
          }
          await J(200, 400);
        }
        if (ok) console.log(`  [ATS] Radio "${(legend || '').substring(0, 40)}" → "${chosen}"`);
        else    console.log(`  [ATS] ⚠ Radio NOT set: "${(legend || '').substring(0, 40)}" (wanted "${chosen}")`);
      } else {
        console.log(`  [ATS] ⚠ No answer for radio: "${(legend || '').substring(0, 50)}"`);
      }
    } catch (_) {}
  }

  // Textareas
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    try {
      if (!await ta.isVisible()) continue;
      if (await ta.inputValue().catch(() => '')) continue;
      const question = await ta.evaluate(el => {
        const lab  = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wl   = wrap?.querySelector('label, legend, [class*="label"]');
        return (lab?.innerText || wl?.innerText || el.placeholder || el.getAttribute('aria-label') || '').trim();
      }).catch(() => '');
      const answer = await _buildAnswer(question || 'cover letter', 'textarea', job);
      if (answer) {
        await ta.click(); await J(100, 200);
        await ta.type(answer, { delay: 25 + Math.random() * 35 });
      }
    } catch (_) {}
  }

  // Consent checkboxes
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      if (!await cb.isVisible()) continue;
      const lbl = await cb.evaluate(el => {
        const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.parentElement;
        return (lab?.innerText || '').toLowerCase();
      }).catch(() => '');
      if (/agree|consent|terms|accept|gdpr|privacy|data protection/i.test(lbl) && !await cb.isChecked().catch(() => false)) {
        await J(200, 500); await cb.click();
      }
    } catch (_) {}
  }
}

// ── Submit detection ───────────────────────────────────────────────────────
async function _trySubmit(page, ats) {
  const sels = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Submit application")', 'button:has-text("Submit Application")',
    'button:has-text("Submit")', 'button:has-text("Send application")',
    '[data-qa="btn-submit"]', '.submit-btn',
  ];
  if (ats === 'greenhouse') sels.push('button:has-text("Submit Application")');
  if (ats === 'lever')      sels.push('button:has-text("Submit your application")');

  for (const sel of sels) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) {
        await J(500, 1000); await btn.click(); await J(3000, 5000);
        const success = await page.evaluate(() => {
          const t = (document.body?.innerText || '').toLowerCase();
          return t.includes('application submitted') || t.includes('thank you for applying') ||
                 t.includes('successfully applied')   || t.includes('application received') ||
                 t.includes('application complete')   || t.includes('we received your');
        }).catch(() => false);
        console.log(`  [ATS] ${success ? '✓ Application submitted!' : 'Submit clicked (no confirmation found)'}`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ── Next/Continue step ─────────────────────────────────────────────────────
async function _tryNext(page) {
  for (const sel of [
    'button:has-text("Next")', 'button:has-text("Continue")',
    'button:has-text("Next step")', 'button:has-text("Next Step")',
    'button:has-text("Next: ")', '[data-qa="btn-next"]',
    'button[type="button"]:has-text("Next")',
  ]) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible() && await btn.isEnabled()) {
        await J(300, 700); await btn.click(); await J(1500, 2500);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// Resolves known yes/no application questions to the user's ACTUAL profile
// answer. Sponsorship is handled SEPARATELY from right-to-work — conflating the
// two made the agent answer "Yes, I need sponsorship" for users who have the
// right to work and need none. Returns 'yes' | 'no' | null.
function _yesNoForQuestion(question) {
  const q = (question || '').toLowerCase();
  const rtw = cfg.APPLICANT.rightToWorkCountries || [];
  const hasRightToWork = rtw.some(c => /uk|united kingdom|britain|england|scotland|wales|northern ireland|gb\b/i.test(c));
  // Explicit profile flag wins; otherwise infer (has right to work ⇒ no sponsorship needed)
  const requiresSponsorship = typeof cfg.APPLICANT.requiresSponsorship === 'boolean'
    ? cfg.APPLICANT.requiresSponsorship
    : !hasRightToWork;

  // Sponsorship FIRST — a sponsorship question usually also contains "work"
  // (e.g. "require sponsorship to work in the UK"), so it must win over the
  // right-to-work branch below.
  if (/sponsor/i.test(q)) {
    if (/without sponsor/i.test(q)) return requiresSponsorship ? 'no' : 'yes'; // inverted phrasing
    return requiresSponsorship ? 'yes' : 'no';
  }
  // Right to work / authorisation / eligibility
  if (/right to work|authori[sz]ed to work|authori[sz]ation to work|eligible to work|legally (allowed|entitled|able) to work|entitled to work|permit to work|work permit/i.test(q)) {
    return hasRightToWork ? 'yes' : 'no';
  }
  if (/reloc/i.test(q)) return cfg.APPLICANT.willingToRelocate ? 'yes' : 'no';
  if (/driv(ing|er).?s? licen[cs]e|full (uk )?licen[cs]e/i.test(q)) return cfg.APPLICANT.drivingLicence ? 'yes' : 'no';
  return null;
}

// ── Rule-based answer builder ──────────────────────────────────────────────
async function _buildAnswer(question, fieldType, job) {
  const { yearsExperience, salaryExpectation, availability, location,
          firstName, lastName, linkedin, rightToWorkCountries } = cfg.APPLICANT;
  const q = (question || '').toLowerCase();

  const AVAIL_MAP = {
    'immediately': 'Immediately available',
    '1week': '1 week notice', '2weeks': '2 weeks notice',
    '1month': '1 month notice', '2months': '2 months notice', '3months': '3 months notice',
  };

  if (/cover letter|covering letter/i.test(q) || fieldType === 'textarea') {
    return `Please see my attached CV for full details of my experience and qualifications. I am genuinely excited about the ${job.title} role at ${job.company} and believe my background makes me a strong fit. I am ${AVAIL_MAP[availability || 'immediately'] || 'immediately available'} and welcome the opportunity to discuss further.`;
  }
  if (/notice period|availability|when can you start|available to start/i.test(q))
    return AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
  if (/salary|compensation|expected pay|remuneration/i.test(q))
    return salaryExpectation || '';
  if (/year.*experience|experience.*year|how many year/i.test(q))
    return String(yearsExperience ?? 0);
  // Sponsorship / right-to-work / relocation / driving licence — from profile
  {
    const yn = _yesNoForQuestion(question);
    if (yn) return yn === 'yes' ? 'Yes' : 'No';
  }
  if (/city|location|where.*based|where do you live/i.test(q))
    return (location || '').split(',')[0].trim() || location || '';
  if (/linkedin/i.test(q))  return linkedin || '';
  if (/github/i.test(q))    return '';
  if (/pronoun/i.test(q))   return '';
  if (/how did you hear|how.*find.*role|how.*learn/i.test(q)) return 'Job board / online search';
  if (/additional|tell us more|anything else|comments/i.test(q))
    return 'Please see my CV for a full overview of my experience. I am available for interview at your earliest convenience.';
  if (/why.*role|why.*company|what.*attract|motivat/i.test(q)) {
    const yrs = yearsExperience > 0 ? `${yearsExperience} years of` : 'solid';
    return `The ${job.title} position at ${job.company} closely aligns with my ${yrs} experience and I am excited about the opportunity to contribute my skills.`;
  }

  if (!q) return '';
  try {
    if (await llmAvailable()) {
      const avail = AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
      const prompt =
`You are completing a job application form on behalf of ${firstName} ${lastName}.

Candidate facts:
- ${yearsExperience} years of experience
- Location: ${location}
- Availability: ${avail}
- Right to work in UK: ${(rightToWorkCountries || []).some(c => /uk|united kingdom/i.test(c)) ? 'Yes' : 'No'}
- Requires visa sponsorship: ${_yesNoForQuestion('do you require sponsorship') === 'yes' ? 'Yes' : 'No'}

Job: ${job.title} at ${job.company}

Form question: "${question}"

Write a short, professional answer (1-3 sentences). Sound natural and human. No bullet points. No mention of AI. Answer directly.`;
      const answer = await llmChat(prompt);
      if (answer?.trim()) {
        console.log(`  [ATS] AI: "${question.substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        return answer.trim();
      }
    }
  } catch (e) {
    console.log(`  [ATS] AI answer failed: ${e.message}`);
  }
  return '';
}

// ── Rule-based dropdown picker ─────────────────────────────────────────────
function _pickDropdownOption(question, options) {
  const q = (question || '').toLowerCase();
  const yn = _yesNoForQuestion(question);
  if (yn === 'yes') return options.find(o => /^\s*yes\b/i.test(o.text))?.text || options.find(o => /authoris|eligible|citizen/i.test(o.text))?.text || null;
  if (yn === 'no')  return options.find(o => /^\s*no\b/i.test(o.text))?.text || null;
  if (/notice period|availability/i.test(q)) {
    const avail = cfg.APPLICANT.availability || 'immediately';
    if (avail === 'immediately') return options.find(o => /immediate|0|none/i.test(o.text))?.text || null;
    if (avail === '1week')       return options.find(o => /1 week|one week/i.test(o.text))?.text || null;
    if (avail === '1month')      return options.find(o => /1 month|one month/i.test(o.text))?.text || null;
  }
  if (/salary|compensation/i.test(q)) return null;
  if (/country|where.*based/i.test(q))
    return options.find(o => /united kingdom|uk$/i.test(o.text))?.text || null;
  if (/experience.*level|senior.*level|level.*experi/i.test(q)) {
    const yrs = cfg.APPLICANT.yearsExperience ?? 0;
    if (yrs >= 5) return options.find(o => /senior|mid|experienced/i.test(o.text))?.text || null;
    return options.find(o => /junior|entry|graduate/i.test(o.text))?.text || null;
  }
  return null;
}

// ── Rule-based radio picker ────────────────────────────────────────────────
function _pickRadioOption(question, optionTexts) {
  const q = (question || '').toLowerCase();
  const yn = _yesNoForQuestion(question);
  if (yn === 'yes') return optionTexts.find(t => /^\s*yes\b/i.test(t)) || null;
  if (yn === 'no')  return optionTexts.find(t => /^\s*no\b/i.test(t)) || null;
  if (/currently employed|employment status/i.test(q)) {
    const avail = cfg.APPLICANT.availability || 'immediately';
    return avail === 'immediately'
      ? optionTexts.find(t => /unemployed|not employed|seeking|available/i.test(t)) || null
      : optionTexts.find(t => /employed|current/i.test(t)) || null;
  }
  if (/full.?time|part.?time/i.test(q))
    return optionTexts.find(t => /full.?time/i.test(t)) || null;
  return null;
}

// ── AI option picker ───────────────────────────────────────────────────────
async function _aiPickOption(question, optionTexts, job) {
  if (!question || !optionTexts.length) return null;
  try {
    if (!await llmAvailable()) return null;
    const { firstName, lastName, yearsExperience, availability, rightToWorkCountries } = cfg.APPLICANT;
    const AVAIL_MAP = { 'immediately': 'Immediately', '1week': '1 week', '2weeks': '2 weeks', '1month': '1 month', '3months': '3 months' };
    const prompt =
`You are completing a job application for ${firstName} ${lastName} (${yearsExperience} yrs experience, availability: ${AVAIL_MAP[availability] || 'immediately'}, right to work UK: ${(rightToWorkCountries||[]).some(c=>/uk/i.test(c))}, requires visa sponsorship: ${_yesNoForQuestion('require sponsorship') === 'yes'}).

Question: "${question}"
Options:
${optionTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Reply with ONLY the exact text of the best option. No explanation.`;
    const reply = await llmChat(prompt);
    const cleaned = (reply || '').trim().replace(/^\d+\.\s*/, '');
    const lc = cleaned.toLowerCase();
    return optionTexts.find(t => t.toLowerCase() === lc)
      || optionTexts.find(t => t.toLowerCase().startsWith(lc) || lc.startsWith(t.toLowerCase()))
      || optionTexts.find(t => t.toLowerCase().includes(lc) || lc.includes(t.toLowerCase()))
      || null;
  } catch (_) { return null; }
}

module.exports = { detectATS, SUPPORTED_ATS, ACCOUNT_REQUIRED_ATS, fillExternalForm };
