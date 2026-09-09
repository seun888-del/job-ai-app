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
  // Bound every field interaction: SPA forms (Workable etc.) re-render as they
  // load / after a CV import, leaving elements briefly un-actionable. Without a
  // cap Playwright waits its 30s default per action, so a few stuck fields look
  // like a hang. 6s means a stuck field is skipped fast, not blocking.
  try { page.setDefaultTimeout(6000); } catch (_) {}
  // Cookie-consent modals (Workable's is an aria-modal with a full-page backdrop)
  // intercept EVERY pointer event — clear it first or nothing on the page is
  // clickable. Runs again after the form renders in case it appears late.
  await _dismissCookieModal(page);
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

  // Wait for the application form itself to render (SPA apply pages like Workable
  // load the fields async and would otherwise be filled while still empty).
  await page.waitForSelector('input[name*="first" i], input[name="firstname"], input[type="email"], input[name*="email" i]', { timeout: 12000 }).catch(() => {});

  // Dismiss the cookie-consent modal again in case it rendered after page load —
  // its aria-modal backdrop intercepts EVERY click, so a stray one silently
  // blocks all field/radio/submit interactions.
  await _dismissCookieModal(page);

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    await J(1000, 2000);
    console.log(`  [ATS] ${ats} form step ${step + 1}${dryRun ? ' (dry run)' : ''}`);

    await _uploadResume(page, resumePath);
    // Let a CV-import autofill/re-render settle before typing — some ATSes
    // (Workable) parse the CV and rebuild the form, which briefly detaches the
    // name/email fields; typing into them mid-rebuild silently fails.
    if (step === 0) await J(4000, 5500);
    await _fillStep(page, job);
    // Answering a radio can REVEAL a dependent field (e.g. "How many years?"
    // appears only after "Do you have 1+ year experience? → Yes"), and such
    // fields render late — after the text pass, sometimes 15s+ in. Keep polling
    // and re-filling until required fields stay filled across two clean checks.
    if (step === 0) await _ensureRequiredFilled(page, job);

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

// Set an input's value reliably. Playwright fill() is React-aware (uses the
// native value setter + fires input/change) and doesn't need the click
// actionability that fails on some SPA fields (Workable's form) — try it first,
// fall back to click+type for anything fill() can't handle.
async function _setValue(el, val) {
  const v = String(val == null ? '' : val);
  try { await el.fill(v, { timeout: 5000 }); return true; } catch (_) {}
  try { await el.click({ timeout: 4000 }); await el.type(v, { delay: 40 }); return true; } catch (_) { return false; }
}

// Poll for late-rendered required fields and fill them. Dependent questions
// (revealed by a radio answer) can appear 15s+ after the initial fill, so a
// single pass misses them and a break-on-first-clean loop exits too early.
// Concludes only after TWO consecutive checks find nothing empty. Bounded.
async function _ensureRequiredFilled(page, job) {
  let cleanStreak = 0;
  for (let i = 0; i < 7 && cleanStreak < 2; i++) {
    await J(1500, 2500);
    const empty = await page.$$eval(
      'input[required], select[required], textarea[required]',
      els => els.filter(el => el.offsetParent !== null && !el.value && el.type !== 'radio' && el.type !== 'checkbox').length
    ).catch(() => 0);
    if (empty) { await _fillStep(page, job); cleanStreak = 0; }
    else cleanStreak++;
  }
}

// Dismiss a cookie-consent banner/modal. Workable renders it as a real
// aria-modal dialog whose backdrop swallows every click until it's gone, so this
// must succeed before any field interaction. Targets the specific accept control
// (never a generic "Accept"/"I agree" that could hit the form's own consent).
async function _dismissCookieModal(page) {
  const sels = [
    '[data-ui="cookie-consent-accept"]',   // Workable
    '#onetrust-accept-btn-handler',        // OneTrust
    'button:has-text("Accept all")', 'button:has-text("Accept All")',
    'button:has-text("Accept cookies")', 'button:has-text("Allow all")',
  ];
  try {
    const btn = await page.waitForSelector(sels.join(', '), { timeout: 4000 });
    if (btn) {
      try { await btn.click({ timeout: 2500 }); }
      catch (_) { await btn.evaluate(el => el.click()).catch(() => {}); }
      // Wait for the modal/backdrop to actually detach before returning.
      await page.waitForSelector('[data-ui="cookie-consent"]', { state: 'detached', timeout: 3000 }).catch(() => {});
      await J(300, 600);
    }
  } catch (_) { /* no cookie modal (e.g. returning profile) — fine */ }
}

// True if the radio group `groupName` has the option matching `chosenText`
// selected. Re-queries the group FRESH by name (not by a captured element id) —
// Workable re-renders the group after a selection, giving elements new ids, so a
// stale-id check reads null even though the group is correctly set. Reads both
// <input>.checked and the [role="radio"] wrapper's aria-checked.
async function _radioGroupSetTo(page, groupName, chosenText) {
  return await page.evaluate(({ name, want }) => {
    const rs = Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`));
    for (const r of rs) {
      const w = r.closest('[role="radio"]');
      const checked = r.checked || (w && w.getAttribute('aria-checked') === 'true');
      if (!checked) continue;
      const lab = r.closest('label'); let t = (lab && lab.innerText || '').trim();
      if (!t && w) { const wl = w.getAttribute('aria-labelledby'); if (wl) for (const tok of wl.split(' ')) if (/radio_label/i.test(tok)) { const e = document.getElementById(tok); if (e && (e.innerText || '').trim()) { t = e.innerText.trim(); break; } } }
      if (!t) t = r.value;
      const a = t.trim().toLowerCase(), b = String(want).trim().toLowerCase();
      return a === b || a.includes(b) || b.includes(a);
    }
    return false;
  }, { name: groupName, want: chosenText }).catch(() => false);
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
          await _setValue(el, val);
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
        const byId = id => { const e = id && document.getElementById(id); return e ? (e.innerText || '').trim() : ''; };
        // Also accept a WRAPPING <label> (no for=) — Workable nests the input
        // inside a <label> whose text is the question, with no fieldset/aria at
        // all (e.g. "How many years of experience…"). Missing this skips the field.
        const lab  = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
        // Some custom questions instead carry their prompt via fieldset
        // aria-labelledby, so resolve that too.
        const fs   = el.closest('fieldset');
        const alb  = (fs && fs.getAttribute('aria-labelledby')) || el.getAttribute('aria-labelledby') || '';
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wl   = wrap?.querySelector('label, legend, [class*="label"], [class*="Label"]');
        const label = (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || el.getAttribute('aria-label') || wl?.innerText || '').trim();
        return { label, placeholder: el.placeholder || '' };
      }).catch(() => ({ label: '', placeholder: '' }));

      const question = label || placeholder;
      if (!question) continue;
      const answer = await _buildAnswer(question, 'text', job);
      if (answer) {
        await _setValue(inp, answer);
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
        const byId = id => { const e = id && document.getElementById(id); return e ? (e.innerText || '').trim() : ''; };
        const lab  = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
        const fs   = el.closest('fieldset');
        const alb  = (fs && fs.getAttribute('aria-labelledby')) || el.getAttribute('aria-labelledby') || '';
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wl   = wrap?.querySelector('label, legend, [class*="label"]');
        const question = (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || el.getAttribute('aria-label') || wl?.innerText || '').trim();
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
        const name = el.name || '';
        const allR = name ? Array.from(document.querySelectorAll(`input[type="radio"][name="${name}"]`)) : [el];
        // Option text: label[for] / wrapping <label> / the radio's parent text
        // (Workable renders "YES"/"NO" in the parent, not an associated label).
        const options = allR.map(r => {
          const lab = r.id ? document.querySelector(`label[for="${r.id}"]`) : r.closest('label');
          let text = (lab && lab.innerText || '').trim();
          // The real <input> is often opacity:0 / aria-hidden; the clickable proxy
          // is a [role="radio"] wrapper (Workable) or the wrapping <label>. Capture
          // both ids so the click targets the visible proxy, not the dead input.
          const wrap = r.closest('[role="radio"]');
          // Option text lives in a radio_label_* span referenced by the WRAPPER's
          // aria-labelledby (not the input's). Some layouts (the consent question)
          // leave label/parent text empty, so without this the text falls back to
          // the numeric value and yes/no matching fails.
          if (!text && wrap) { const wl = wrap.getAttribute('aria-labelledby'); if (wl) { for (const tok of wl.split(' ')) { if (/radio_label/i.test(tok)) { const e = document.getElementById(tok); if (e && (e.innerText || '').trim()) { text = e.innerText.trim(); break; } } } } }
          if (!text) { const alb = r.getAttribute('aria-labelledby'); if (alb) { for (const tok of alb.split(' ')) { const e = document.getElementById(tok); if (e && (e.innerText || '').trim()) { text = e.innerText.trim(); break; } } } }
          if (!text && r.getAttribute('aria-label')) text = r.getAttribute('aria-label').trim();
          if (!text && r.parentElement) text = (r.parentElement.innerText || '').trim();
          return { val: r.value, text: (text || r.value || '').trim(), inputId: r.id || '', wrapperId: (wrap && wrap.id) || '' };
        });
        const optSet = new Set(options.map(o => o.text.toLowerCase()));
        // Question text: prefer ARIA (fieldset[aria-labelledby] -> the labelled
        // element) — the standard, reliable way (Workable et al.). Then <legend>,
        // then a nearest-ancestor text scan that skips the option labels.
        const fieldset = el.closest('fieldset');
        let q = '';
        const lb = (fieldset && fieldset.getAttribute('aria-labelledby')) || el.getAttribute('aria-labelledby') || '';
        if (lb) { const qe = document.getElementById(lb.split(' ')[0]); if (qe) q = (qe.innerText || '').trim(); }
        if (!q && fieldset && fieldset.querySelector('legend')) q = (fieldset.querySelector('legend').innerText || '').trim();
        if (q && optSet.has(q.toLowerCase())) q = '';
        if (!q) {
          let node = el.parentElement;
          for (let i = 0; i < 7 && node && !q; i++) {
            const cands = node.querySelectorAll('label, legend, h1, h2, h3, h4, p, [class*="label" i], [class*="question" i], [class*="title" i]');
            for (const c of cands) {
              const t = (c.innerText || '').trim();
              if (t && t.length >= 3 && t.length < 250 && !optSet.has(t.toLowerCase())) { q = t; break; }
            }
            node = node.parentElement;
          }
        }
        return { groupName: name, legend: q, options };
      }).catch(() => ({ groupName: '', legend: '', options: [] }));

      if (!groupName || groupsSeen.has(groupName) || !options.length) continue;
      groupsSeen.add(groupName);
      const alreadyChecked = await page.$eval(`input[type="radio"][name="${groupName}"]:checked`, () => true).catch(() => false);
      if (alreadyChecked) continue;

      const chosen = _pickRadioOption(legend, options.map(o => o.text)) || await _aiPickOption(legend, options.map(o => o.text), job);
      if (chosen) {
        const opt = options.find(o => o.text === chosen);
        let ok = false;
        if (opt) {
          // 1) Playwright click on the VISIBLE proxy: the [role="radio"] wrapper is
          //    actionable; the real <input> is opacity:0 and just times out.
          if (opt.wrapperId) {
            try { await page.click(`#${opt.wrapperId}`, { timeout: 2500 }); } catch (_) {}
            ok = await _radioGroupSetTo(page, groupName, chosen);
          }
          // 2) DOM-click the wrapper / wrapping <label> (fires React's handler).
          if (!ok && opt.inputId) {
            try { await page.$eval(`#${opt.inputId}`, el => { const p = el.closest('[role="radio"]') || el.closest('label') || el.parentElement; (p || el).click(); }); } catch (_) {}
            ok = await _radioGroupSetTo(page, groupName, chosen);
          }
          // 3) Last resort: force the input state + dispatch input/change.
          if (!ok && opt.inputId) {
            try { await page.$eval(`#${opt.inputId}`, el => { el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.click(); }); } catch (_) {}
            ok = await _radioGroupSetTo(page, groupName, chosen);
          }
          // React commits the checked state asynchronously after the click, so an
          // immediate read is a false negative. Poll briefly before concluding.
          for (let i = 0; i < 4 && !ok; i++) { await J(250, 400); ok = await _radioGroupSetTo(page, groupName, chosen); }
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
        const byId = id => { const e = id && document.getElementById(id); return e ? (e.innerText || '').trim() : ''; };
        const lab  = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
        const fs   = el.closest('fieldset');
        const alb  = (fs && fs.getAttribute('aria-labelledby')) || el.getAttribute('aria-labelledby') || '';
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="Question"]');
        const wl   = wrap?.querySelector('label, legend, [class*="label"]');
        return (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || wl?.innerText || el.placeholder || el.getAttribute('aria-label') || '').trim();
      }).catch(() => '');
      const answer = await _buildAnswer(question || 'cover letter', 'textarea', job);
      if (answer) {
        await _setValue(ta, answer);
      }
    } catch (_) {}
  }

  // Consent checkboxes. NOTE: no isVisible() guard — Workable's required consent
  // box is opacity:0 with a styled proxy, so isVisible() is false and it would be
  // silently skipped (leaving the form un-submittable). Gate on the label text.
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      if (await cb.isChecked().catch(() => false)) continue;
      const info = await cb.evaluate(el => {
        const lab = document.querySelector(`label[for="${el.id}"]`) || el.closest('label') || el.parentElement;
        return { text: (lab?.innerText || '').toLowerCase(), id: el.id || '' };
      }).catch(() => ({ text: '', id: '' }));
      if (!/agree|consent|terms|accept|gdpr|privacy|data protection|i have read/i.test(info.text)) continue;
      await J(200, 500);
      let done = false;
      try { await cb.check({ timeout: 2000 }); done = await cb.isChecked().catch(() => false); } catch (_) {}
      if (!done && info.id) { try { await page.$eval(`#${info.id}`, el => { const l = el.closest('label') || el.parentElement; (l || el).click(); }); } catch (_) {} done = await cb.isChecked().catch(() => false); }
      if (!done && info.id) { try { await page.$eval(`#${info.id}`, el => { el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); } catch (_) {} }
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

  // RIGHT-TO-WORK first when the question asks whether you HAVE the right / are
  // eligible to work — even if it adds "without (requiring) sponsorship". Those
  // are right-to-work questions (answer from hasRightToWork), NOT "do you require
  // sponsorship" questions. (Fixes answering NO to "Do you have full right to
  // work in the UK without requiring sponsorship?", which auto-rejects everyone.)
  const asksRightToWork = /right to work|authori[sz]ed to work|authori[sz]ation to work|eligible to work|legally (allowed|entitled|able) to work|entitled to work|permit to work|work permit|able to work in the/i.test(q);
  if (asksRightToWork) return hasRightToWork ? 'yes' : 'no';
  // Otherwise a sponsorship question ("do you require sponsorship?").
  if (/sponsor/i.test(q)) {
    if (/without sponsor/i.test(q)) return requiresSponsorship ? 'no' : 'yes'; // inverted phrasing
    return requiresSponsorship ? 'yes' : 'no';
  }
  if (/reloc/i.test(q)) return cfg.APPLICANT.willingToRelocate ? 'yes' : 'no';
  if (/driv(ing|er).?s? licen[cs]e|full (uk )?licen[cs]e/i.test(q)) return cfg.APPLICANT.drivingLicence ? 'yes' : 'no';
  if (/\bover 18\b|18 years old|at least 18|aged 18/i.test(q)) return 'yes'; // a job-seeker is an adult
  // Application data-processing / AI-screening consents are required-to-proceed
  // and benign; an applicant consents. (The LLM answers these inconsistently, so
  // pin them to Yes rather than leave it to chance.)
  if (/\b(do you |i )?consent\b|consent to|gdpr|process(ing)? (of )?(my|your) (personal )?data|data protection/i.test(q)) return 'yes';
  // Willingness / capability / commitment questions from someone who is applying
  // → affirmative. A "No" to "are you willing to work from our office 5 days?" or
  // "are you comfortable with…" auto-rejects the candidate who wants the job.
  // Placed AFTER the specific profile checks (RTW/sponsorship/relocation/driving)
  // so those keep their exact answers; relocation is already resolved above.
  if (/\bwilling to\b|\bare you able to\b|\bare you prepared to\b|\bare you comfortable\b|\bhappy to (work|commute|travel|attend|start)\b|\bcan you (commute|attend|travel|start|work)\b|\bcommit to\b|\bprepared to work\b/i.test(q)) return 'yes';
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
  if (/salary|compensation|expected pay|remuneration|expected salary/i.test(q))
    // Required salary fields block submit when the profile has no figure; a
    // "Negotiable" is honest, widely accepted, and unblocks the application.
    return salaryExpectation || 'Negotiable';
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

For a capability, willingness, availability, or commitment question the candidate can reasonably meet (e.g. willing to work on-site, comfortable with the environment, able to commute), choose the affirmative option so this strong candidate progresses. Reply with ONLY the exact text of the best option. No explanation.`;
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
