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
// Answers already worked out for the form being filled (question → answer, '' = left blank).
const _answerCache = new Map();

async function fillExternalForm(page, job, resumePath, ats, opts = {}) {
  const dryRun = opts.submit === false;
  _answerCache.clear();
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
    if (step === 0 && ats === 'smartrecruiters') await _cancelParsedEntries(page);
    await _fillStep(page, job);
    // Answering a radio can REVEAL a dependent field (e.g. "How many years?"
    // appears only after "Do you have 1+ year experience? → Yes"), and such
    // fields render late — after the text pass, sometimes 15s+ in. Keep polling
    // and re-filling until required fields stay filled across two clean checks.
    await _ensureRequiredFilled(page, job);

    if (dryRun) {
      // Fill this step, then either advance to the next or, if this was the last
      // step, stop WITHOUT submitting.
      let advanced = await _tryNext(page);
      // SmartRecruiters opens an unfinished CV entry only when Next is pressed: close it, try once more.
      if (!advanced && ats === 'smartrecruiters' && step === 0) { await _cancelParsedEntries(page); advanced = await _tryNext(page); }
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

// SmartRecruiters reads the CV into Experience/Education entries and leaves any it
// couldn't complete (a certificate with no school, say) open in an edit box with Cancel
// and Save. Filling that box puts the cover letter and guesses into it and blocks Next,
// so it is cancelled: the complete entries stay, the CV itself is attached anyway.
async function _cancelParsedEntries(page) {
  for (let i = 0; i < 4; i++) {
    // SmartRecruiters' buttons are its own spl-button / oc-button elements, not <button>.
    const save = page.locator('spl-button, oc-button, button').filter({ hasText: /^\s*Save\s*$/ }).filter({ visible: true });
    const cancel = page.locator('spl-button, oc-button, button').filter({ hasText: /^\s*Cancel\s*$/ }).filter({ visible: true }).first();
    if (!(await save.count().catch(() => 0)) || !(await cancel.count().catch(() => 0))) return;
    await cancel.click({ timeout: 3000 }).catch(() => {});
    console.log('  [ATS] Closed an unfinished entry SmartRecruiters made from the CV');
    await J(800, 1200);
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

// Check-and-fix pass (as the Trac agent does): list the required fields still blank, fill
// again, re-check. Dependent questions (revealed by a radio answer) can appear 15s+ after
// the first fill, so it concludes only after TWO clean checks, and stops early when a pass
// changes nothing (the details don't answer what's left). Returns what's still blank.
async function _ensureRequiredFilled(page, job) {
  let cleanStreak = 0, prev = '';
  for (let i = 0; i < 7 && cleanStreak < 2; i++) {
    await J(1500, 2500);
    const empty = await _findEmptyRequired(page);
    if (!empty.length) { cleanStreak++; continue; }
    cleanStreak = 0;
    if (empty.join('|') === prev) {
      console.log(`  [ATS] ⚠ Required, still blank: ${empty.map(q => `"${q.substring(0, 45)}"`).join(', ')}`);
      return empty;
    }
    prev = empty.join('|');
    await _fillStep(page, job);
  }
  return [];
}

// Required fields still unanswered, by question text. Covers text boxes, selects, radio and
// tick-box groups, and react-select dropdowns (whose typing box stays empty after a pick:
// the chosen answer sits beside it).
function _findEmptyRequired(page) {
  return page.evaluate(() => {
    const shown = (e) => !!(e.offsetParent || (e.labels && [...e.labels].some(l => l.offsetParent)));
    const textOf = (e) => {
      const l = (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label');
      const w = e.closest('fieldset, [class*="field"], [class*="question"], [class*="Question"]');
      const wl = w && w.querySelector('legend, label, [class*="label"]');
      return ((wl && wl.innerText) || (l && l.innerText) || e.getAttribute('aria-label') || e.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    };
    const pickedNear = (e) => {
      let box = e.parentElement;
      for (let i = 0; i < 5 && box && box.parentElement && box.parentElement.querySelectorAll('input[role="combobox"]').length <= 1; i++) box = box.parentElement;
      const v = box && box.querySelector('[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]');
      return !!(v && v.textContent.trim());
    };
    const out = [], seen = new Set();
    for (const e of document.querySelectorAll('input, textarea, select')) {
      if (['hidden', 'file', 'submit', 'button'].includes(e.type) || /recaptcha|captcha/i.test(e.name || '') || !shown(e)) continue;
      if (!(e.required || e.getAttribute('aria-required') === 'true')) continue;
      if (e.type === 'radio' || e.type === 'checkbox') {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        const group = e.name ? [...document.querySelectorAll(`input[name="${CSS.escape(e.name)}"]`)] : [e];
        if (!group.some(r => r.checked || (r.closest('[role="radio"],[role="checkbox"]') || { getAttribute: () => '' }).getAttribute('aria-checked') === 'true')) out.push(textOf(e));
        continue;
      }
      if (String(e.value || '').trim() || pickedNear(e)) continue;
      out.push(textOf(e));
    }
    return [...new Set(out)];
  }).catch(() => []);
}

// Yes/No questions drawn as two buttons (Ashby: aria-pressed buttons over a hidden tick-box).
// Required ones are always answered; optional ones only when the profile gives the answer.
async function _answerYesNoButtons(page, job) {
  const qs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-jobai-yn]').forEach(e => e.removeAttribute('data-jobai-yn'));
    for (const box of document.querySelectorAll('div')) {
      const btns = [...box.children].filter(c => c.tagName === 'BUTTON');
      if (btns.length !== 2 || !box.offsetParent) continue;
      const texts = btns.map(b => (b.innerText || '').trim().toLowerCase());
      if (texts[0] !== 'yes' || texts[1] !== 'no') continue;
      if (btns.some(b => b.getAttribute('aria-pressed') === 'true')) continue;
      const entry = box.closest('[class*="fieldEntry"], fieldset, [class*="field"], [class*="question"]') || box.parentElement;
      const lab = entry && entry.querySelector('label, legend');
      const q = (lab && lab.innerText || '').replace(/\s+/g, ' ').trim();
      if (!q) continue;
      const i = out.length;
      btns.forEach((b, j) => b.setAttribute('data-jobai-yn', `${i}-${j}`));
      out.push({ i, q, required: !!(lab && /required/i.test(lab.className)) || /[*✱]\s*$/.test(q) });
    }
    return out;
  }).catch(() => []);
  for (const { i, q, required } of qs) {
    const question = q.replace(/\s*[*✱]\s*$/, '');
    const yn = _yesNoForQuestion(question);
    let chosen = yn ? (yn === 'yes' ? 'Yes' : 'No') : null;
    if (!chosen && required) chosen = await _aiPickOption(question, ['Yes', 'No'], job);
    if (!chosen) { if (required) console.log(`  [ATS] ⚠ No answer for Yes/No: "${question.substring(0, 50)}"`); continue; }
    const sel = `[data-jobai-yn="${i}-${chosen === 'Yes' ? 0 : 1}"]`;
    try { await page.click(sel, { timeout: 2500 }); } catch (_) { await page.$eval(sel, el => el.click()).catch(() => {}); }
    console.log(`  [ATS] Yes/No "${question.substring(0, 40)}" → "${chosen}"`);
    await J(400, 700);
  }
}

// Tick-box groups that work like a question ("Have you worked at Spotify before? No / Yes -
// Intern / Yes - Full Time", or an equality question): pick one option, as for radios.
// Equality questions get "Prefer not to say"; other optional groups are left alone.
async function _answerCheckboxGroups(page, job) {
  const groups = await page.evaluate(() => {
    const labelOf = (cb) => { const l = (cb.id && document.querySelector(`label[for="${CSS.escape(cb.id)}"]`)) || cb.closest('label'); return ((l && l.innerText) || cb.getAttribute('aria-label') || cb.value || '').replace(/\s+/g, ' ').trim(); };
    const shown = (e) => !!(e.offsetParent || (e.labels && [...e.labels].some(l => l.offsetParent)));
    const all = [...document.querySelectorAll('input[type="checkbox"]')].filter(shown);
    const used = new Set(), out = [];
    for (const cb of all) {
      if (used.has(cb)) continue;
      // The group: boxes sharing a name, or the nearest container of boxes and nothing else.
      let members = cb.name ? all.filter(x => x.name === cb.name) : [];
      let box = null;
      if (members.length >= 2) {
        box = cb.parentElement;
        while (box && !members.every(m => box.contains(m))) box = box.parentElement;
      } else {
        let c = cb.parentElement;
        for (let i = 0; i < 4 && c; i++, c = c.parentElement) {
          const inner = [...c.querySelectorAll('input, select, textarea')].filter(x => x.type !== 'hidden');
          if (inner.some(x => x.type !== 'checkbox')) break;
          if (inner.length >= 2) { box = c; members = inner.filter(shown); }
        }
      }
      if (!box || members.length < 2) continue;
      members.forEach(m => used.add(m));
      const options = members.map(labelOf);
      const optSet = new Set(options.map(t => t.toLowerCase()));
      let q = '';
      for (let node = box, i = 0; node && i < 5 && !q; node = node.parentElement, i++) {
        for (const c of node.querySelectorAll('legend, label, h3, h4, p, [class*="label" i], [class*="question" i], [class*="title" i]')) {
          const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
          if (t && t.length >= 3 && t.length < 300 && !optSet.has(t.toLowerCase()) && !options.some(o => o && t.includes(o) && t.length < o.length + 4)) { q = t; break; }
        }
      }
      const required = members.some(m => m.required || m.getAttribute('aria-required') === 'true') || /[*✱]\s*$/.test(q);
      const gi = out.length;
      members.forEach((m, j) => m.setAttribute('data-jobai-cb', `${gi}-${j}`));
      out.push({ gi, q, options, required, anyChecked: members.some(m => m.checked) });
    }
    return out;
  }).catch(() => []);

  for (const g of groups) {
    if (g.anyChecked || !g.q) continue;
    const q = g.q.replace(/\s*[*✱]\s*$/, '');
    const demo = DEMOGRAPHIC_RE.test(q);
    if (!g.required && !demo) continue;
    if (/pronoun/i.test(q)) continue;
    let chosen = demo
      ? g.options.find(t => /prefer not|decline|don.?t wish|do not wish|rather not|not to (say|answer|disclose)/i.test(t)) || null
      : _pickRadioOption(q, g.options) || await _aiPickOption(q, g.options, job);
    if (!chosen) { if (g.required) console.log(`  [ATS] ⚠ No answer for tick-box question: "${q.substring(0, 50)}"`); continue; }
    const j = g.options.indexOf(chosen);
    const sel = `[data-jobai-cb="${g.gi}-${j}"]`;
    let ok = false;
    try { await page.check(sel, { timeout: 2500 }); } catch (_) {}
    ok = await page.$eval(sel, el => el.checked).catch(() => false);
    if (!ok) {
      await page.$eval(sel, el => { const l = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label'); (l || el).click(); }).catch(() => {});
      ok = await page.$eval(sel, el => el.checked).catch(() => false);
    }
    console.log(`  [ATS] ${ok ? 'Tick-box' : '⚠ Tick-box NOT set'} "${q.substring(0, 40)}" → "${chosen}"`);
    await J(200, 400);
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
      const lab = r.closest('label') || (r.labels && r.labels[0]); let t = (lab && lab.innerText || '').trim();
      if (!t && w) { const wl = w.getAttribute('aria-labelledby'); if (wl) for (const tok of wl.split(' ')) if (/radio_label/i.test(tok)) { const e = document.getElementById(tok); if (e && (e.innerText || '').trim()) { t = e.innerText.trim(); break; } } }
      if (!t) t = r.value;
      const a = t.trim().toLowerCase(), b = String(want).trim().toLowerCase();
      return a === b || a.includes(b) || b.includes(a);
    }
    return false;
  }, { name: groupName, want: chosenText }).catch(() => false);
}

// ── Fill all visible fields on the current step ───────────────────────────
// Real text boxes only: not custom-dropdown inputs, and not the hidden "required" shadow input
// react-select renders next to each dropdown (aria-hidden, tabindex -1), which must never be typed in.
const TEXT_INPUTS = ['input[type="text"]', 'input[type="number"]', 'input:not([type])']
  .map(s => s + ':not([role="combobox"]):not([aria-hidden="true"]):not([tabindex="-1"])').join(', ');

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
    { val: linkedin || 'N/A',                 sels: ['input[name*="linkedin" i]', 'input[id*="linkedin" i]', 'input[placeholder*="LinkedIn" i]', 'input[aria-label*="LinkedIn" i]'] },
    { val: location || '',                    sels: ['input[name*="location" i]', 'input[id*="location" i]', 'input[placeholder*="Location" i]', 'input[autocomplete="address-level2"]'] },
  ];

  for (const { val, sels } of knownFields) {
    if (!val) continue;
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          // Custom dropdowns (role=combobox) need an option picked, not typed text: _answerComboboxes.
          if ((await el.getAttribute('role').catch(() => '')) === 'combobox') break;
          const cur = await el.inputValue().catch(() => '');
          // A phone box pre-filled with just the dial code ("+44") still needs the number.
          const dialOnly = val === phone && /^\s*\+\d{1,4}\s*$/.test(cur);
          if (cur && !dialOnly) break;
          await _setValue(el, dialOnly && !/^\s*\+/.test(val) ? `${cur.trim()} ${String(val).replace(/^\s*0/, '')}` : val);
          await J(80, 150);
          break;
        }
      } catch (_) {}
    }
  }

  // Yes/No answered first: the answer decides which follow-up questions appear.
  await _answerYesNoButtons(page, job);

  // Workable fills "Address" from the CV it parses (it can pick a university town):
  // when it doesn't name the profile's city, put the profile's location there.
  if (location && /workable\.com/.test(page.url())) {
    const city = location.split(',')[0].trim().toLowerCase();
    for (const el of await page.$$('input[name="address"], input[id="address"]').catch(() => [])) {
      try {
        const v = await el.inputValue();
        if (await el.isVisible() && !v.toLowerCase().includes(city)) {
          await _setValue(el, `${location}, ${cfg.APPLICANT.country || 'United Kingdom'}`);
          console.log(`  [ATS] Address → "${location}" (the site had "${v.slice(0, 30)}")`);
        }
      } catch (_) {}
    }
  }

  // "Confirm your email" is a second email box: every empty one gets the email.
  if (email) {
    for (const el of await page.$$('input[type="email"], input[name*="email" i], input[id*="email" i]').catch(() => [])) {
      try { if (await el.isVisible() && !(await el.inputValue().catch(() => ''))) { await _setValue(el, email); await J(80, 150); } } catch (_) {}
    }
  }

  // Unknown text inputs — label-matched with rules + AI fallback
  const allInputs = await page.$$(TEXT_INPUTS);
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
        // Lever keeps the question in a sibling .application-label, outside the field's box.
        const ll   = el.closest('.application-question')?.querySelector('.application-label');
        const label = (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || el.getAttribute('aria-label') || ll?.innerText || wl?.innerText || '').trim();
        return { label, placeholder: el.placeholder || '' };
      }).catch(() => ({ label: '', placeholder: '' }));

      const question = label || placeholder;
      // A bare "Type your response" placeholder isn't a question: don't let the AI guess one.
      if (!question || (!label && /^(type|enter|write) (your|an?) |^your (answer|response)/i.test(placeholder))) continue;
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
        const ll   = el.closest('.application-question')?.querySelector('.application-label');
        const question = (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || el.getAttribute('aria-label') || ll?.innerText || wl?.innerText || '').trim();
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

  // Custom dropdowns (react-select style, e.g. Greenhouse's newer forms)
  await _answerComboboxes(page, job);

  // Radio groups
  const radios = await page.$$('input[type="radio"]');
  const groupsSeen = new Set();
  for (const radio of radios) {
    try {
      // Lever hides the real radio and shows only its label, so a visible label counts.
      if (!await radio.evaluate(el => !!(el.offsetParent || (el.labels && [...el.labels].some(l => l.offsetParent)))).catch(() => false)) continue;
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
        // Lever: the question sits in the sibling .application-label.
        if (!q) { const ll = el.closest('.application-question')?.querySelector('.application-label'); if (ll) q = (ll.innerText || '').trim(); }
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

      const texts = options.map(o => o.text);
      // Equality questions (gender, ethnicity, disability, veteran): "Prefer not to say",
      // never a guess. Spotted by the question, or by its options when the question isn't found.
      const demo = DEMOGRAPHIC_RE.test(legend) || (texts.some(t => /prefer not|decline|choose not/i.test(t)) && texts.some(t => /\b(man|woman|male|female|asian|white|black|hispanic|veteran|disabilit)/i.test(t)));
      let chosen = demo
        ? texts.find(t => /prefer not|decline|don.?t wish|do not wish|rather not|choose not|not to (say|answer|disclose)/i.test(t))
        : _pickRadioOption(legend, texts) || await _aiPickOption(legend, texts, job);
      if (demo && !chosen) continue;
      // Last resort for a REQUIRED yes/no radio the rules and AI both left blank:
      // the affirmative, but only for a willingness/ability question. A blank required
      // radio blocks the submission; an experience question stays blank for the user.
      if (!chosen) {
        const isRequired = await page.$eval(`input[type="radio"][name="${groupName}"]`, el => {
          const w = el.closest('[role="radio"],fieldset'); return el.required || el.getAttribute('aria-required') === 'true' || (w && w.getAttribute('aria-required') === 'true');
        }).catch(() => false);
        const yesOpt = options.map(o => o.text).find(t => /^\s*yes\b/i.test(t));
        // Only for willingness/ability ("Can you work from the office?"), never experience claims.
        const willing = /\b(can you|i can|are you (willing|able|happy|comfortable|available|open)|willing|able to|happy to|comfortable|commute|relocat|travel|work from|on-?site|office|hours|shifts?|weekends?|start)\b/i.test(legend || '') && !/experience|years|certif|qualif|licen[cs]e|degree/i.test(legend || '');
        if (isRequired && yesOpt && willing) { chosen = yesOpt; console.log(`  [ATS] Required radio unanswered → affirmative fallback: "${(legend || '').substring(0, 40)}"`); }
      }
      if (chosen) {
        const opt = options.find(o => o.text === chosen);
        let ok = false;
        if (opt) {
          // 1) Playwright click on the VISIBLE proxy: the [role="radio"] wrapper is
          //    actionable; the real <input> is opacity:0 and just times out.
          if (opt.wrapperId) {
            try { await page.click(`[id="${opt.wrapperId}"]`, { timeout: 2500 }); } catch (_) {}
            ok = await _radioGroupSetTo(page, groupName, chosen);
          }
          // 2) DOM-click the wrapper / wrapping <label> (fires React's handler).
          if (!ok && opt.inputId) {
            try { await page.$eval(`[id="${opt.inputId}"]`, el => { const p = el.closest('[role="radio"]') || el.closest('label') || (el.labels && el.labels[0]) || el.parentElement; (p || el).click(); }); } catch (_) {}
            ok = await _radioGroupSetTo(page, groupName, chosen);
          }
          // 3) Last resort: force the input state + dispatch input/change.
          if (!ok && opt.inputId) {
            try { await page.$eval(`[id="${opt.inputId}"]`, el => { el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.click(); }); } catch (_) {}
            ok = await _radioGroupSetTo(page, groupName, chosen);
          }
          // 4) Radios with no id (Lever): click the option's label by its place in the group.
          if (!ok) {
            const idx = options.indexOf(opt);
            await page.$$eval(`input[type="radio"][name="${groupName}"]`, (els, i) => { const el = els[i]; if (!el) return; const l = el.closest('label') || (el.id && document.querySelector(`label[for="${el.id}"]`)); (l || el).click(); }, idx).catch(() => {});
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
    } catch (e) { console.log(`  [ATS] ⚠ Radio question failed: ${String(e && e.message || e).slice(0, 120)}`); }
  }

  // A required Cover Letter upload (Greenhouse): open its "Enter manually" box so the
  // textarea step below types the letter in. Optional ones are left alone.
  try {
    const opened = await page.evaluate(() => {
      for (const g of document.querySelectorAll('[class*="file-upload"], fieldset, [class*="field"]')) {
        const head = (g.querySelector('label, legend, [class*="label"]') || {}).innerText || '';
        if (!/cover letter/i.test(head) || !/\*/.test(head) || g.querySelector('textarea')) continue;
        if (/\.(pdf|docx?|txt|rtf)\b/i.test(g.innerText)) continue; // a file is already attached
        const b = [...g.querySelectorAll('button')].find((x) => /enter manually/i.test(x.innerText || x.getAttribute('aria-label') || ''));
        if (b) { b.click(); return true; }
      }
      return false;
    });
    if (opened) {
      // Its box is labelled by the "Enter manually" button, so fill it here, not by label.
      await page.waitForTimeout(800);
      const has = await page.evaluate(() => {
        for (const g of document.querySelectorAll('[class*="file-upload"], fieldset, [class*="field"]')) {
          const head = (g.querySelector('label, legend, [class*="label"]') || {}).innerText || '';
          const ta = /cover letter/i.test(head) && g.querySelector('textarea');
          if (ta && !ta.value) { ta.setAttribute('data-jobai-cl', '1'); return true; }
        }
        return false;
      });
      const ta = has && await page.$('textarea[data-jobai-cl]');
      if (ta) { await _setValue(ta, await _buildAnswer('cover letter', 'textarea', job)); console.log('  [ATS] Cover letter typed in (required)'); }
    }
  } catch (_) {}

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
        const ll   = el.closest('.application-question')?.querySelector('.application-label');
        return (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || ll?.innerText || wl?.innerText || el.placeholder || el.getAttribute('aria-label') || '').trim();
      }).catch(() => '');
      const answer = await _buildAnswer(question || 'cover letter', 'textarea', job);
      if (answer) {
        await _setValue(ta, answer);
      }
    } catch (_) {}
  }

  await _answerCheckboxGroups(page, job);

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
      if (!/agree|consent|terms|accept|gdpr|privacy|data protection|i have read|^\s*i understand|acknowledge/i.test(info.text)) continue;
      // A future-jobs mailing list is the applicant's choice, not part of applying.
      if (/future (job|role|opportunit|career)|marketing|newsletter|talent (pool|community)|contact me about/i.test(info.text)) continue;
      await J(200, 500);
      let done = false;
      try { await cb.check({ timeout: 2000 }); done = await cb.isChecked().catch(() => false); } catch (_) {}
      if (!done && info.id) { try { await page.$eval(`[id="${info.id}"]`, el => { const l = el.closest('label') || el.parentElement; (l || el).click(); }); } catch (_) {} done = await cb.isChecked().catch(() => false); }
      if (!done && info.id) { try { await page.$eval(`[id="${info.id}"]`, el => { el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); } catch (_) {} }
    } catch (_) {}
  }
}

// Cloudflare Turnstile ("Verify you are human") gates submit on some ATS forms
// (e.g. certain Workable employers). On the user's real Chrome + residential IP
// it's the checkbox kind that passes with a click, not an image puzzle. Returns
// true if solved or absent, false if present and could not be verified.
// Detect an unsolved human-verification CAPTCHA (Cloudflare Turnstile, reCAPTCHA)
// gating the submit. We deliberately do NOT try to defeat it: it is designed to
// stop automation, auto-solving is unreliable and can flag the user's IP, and
// captcha-gated forms are a small slice of the pool. When present, the caller
// skips the form (never a false "applied"). Returns true if a captcha blocks.
// A token already present (value set) means it was cleared (e.g. by the user) —
// then it does not block.
async function _captchaBlocks(page) {
  const hasToken = await page.evaluate(() => {
    const el = document.querySelector('input[name="cf-turnstile-response"], input[name*="turnstile" i], input[name="g-recaptcha-response"]');
    return !!(el && el.value && el.value.length > 20);
  }).catch(() => false);
  if (hasToken) return false;
  // Only a challenge the user can SEE blocks. Invisible reCAPTCHA (Greenhouse loads it on
  // every form) and an idle Turnstile script are always present and pass on their own;
  // counting them reported real submissions as "not sent".
  return await page.evaluate(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 60 && r.height > 60 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
    const challenge = [...document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"], iframe[title*="challenge" i], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha-delivery"]')].some(shown);
    return challenge || /verify you are human|slide right to secure|are you a robot/i.test(document.body?.innerText || '');
  }).catch(() => false);
}

// ── Submit detection ───────────────────────────────────────────────────────
// Why the last real submit didn't go through: 'captcha' | 'email_code' | 'validation' | 'unconfirmed' |
// 'empty' (required fields left blank) | 'sent'. Read by the Company Sites agent.
let lastOutcome = null;
async function _trySubmit(page, ats) {
  lastOutcome = 'empty';
  // GUARD: never click Submit while a required field is still empty. The ATS just
  // shows "Please select one of these options" and stays on the form, but the
  // click otherwise reports a false success → the job gets marked "applied" when
  // nothing was sent. Report NOT submitted instead so the caller can retry/skip.
  const empties = await page.evaluate(() => {
    let fields = 0, radios = 0, boxes = 0;
    for (const el of document.querySelectorAll('input[required], select[required], textarea[required]')) {
      if (el.offsetParent === null) continue;
      if (el.type === 'radio' || el.type === 'checkbox') continue;
      if (!el.value) fields++;
    }
    const seen = new Set();
    for (const r of document.querySelectorAll('input[type="radio"]')) {
      if (seen.has(r.name)) continue; seen.add(r.name);
      const w = r.closest('[role="radio"],fieldset');
      const req = r.required || r.getAttribute('aria-required') === 'true' || (w && w.getAttribute('aria-required') === 'true');
      if (req && !document.querySelector(`input[type="radio"][name="${r.name}"]:checked`)) radios++;
    }
    for (const c of document.querySelectorAll('input[type="checkbox"][required], input[type="checkbox"][aria-required="true"]')) {
      if (!c.checked) boxes++;
    }
    return { fields, radios, boxes };
  }).catch(() => ({ fields: 0, radios: 0, boxes: 0 }));
  if (empties.fields + empties.radios + empties.boxes > 0) {
    console.log(`  [ATS] ⚠ Not submitting — required still empty: ${empties.fields} field(s), ${empties.radios} radio group(s), ${empties.boxes} consent box(es). Application NOT sent.`);
    return false;
  }

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
        await J(500, 1000); await btn.click();
        // Cloudflare Turnstile on Workable renders only AFTER the submit click
        // (button flips to "Submitting…" and holds pending a human token). We do
        // not defeat CAPTCHAs — if one appears, skip: report NOT submitted so the
        // job isn't falsely marked applied, and the agent moves to the next one.
        await J(2000, 3000);
        // Poll for a REAL outcome. Critically, "Submitting…" is NOT success — the
        // button text merely flips while a Turnstile/validation block keeps the
        // application un-sent; only an explicit confirmation OR the apply form
        // actually disappearing counts. A stuck "Submitting…" → NOT submitted.
        for (let i = 0; i < 14; i++) {
          await J(1500, 2200);
          const st = await page.evaluate(() => {
            const t = (document.body?.innerText || '').toLowerCase();
            const success = /application (received|submitted)|thank you for applying|thanks for applying|successfully applied|we('| ha)ve received your|application complete/.test(t);
            const validationError = /please select|please (fill|complete)|this field is required|is required\b|please provide|please enter/.test(t);
            // Recruitee shows only a spinner (no text) while sending: a busy, disabled or blank submit button is still submitting.
            const submitting = !!Array.from(document.querySelectorAll('button')).find(b => /submitting/i.test(b.innerText || ''))
              || !!Array.from(document.querySelectorAll('button[type="submit"], [aria-busy="true"]')).find(b => b.offsetParent && (b.getAttribute('aria-busy') === 'true' || b.disabled || !(b.innerText || '').trim()));
            const formGone = !document.querySelector('input[type="email"], input[name*="email" i]')
              && !Array.from(document.querySelectorAll('button')).some(b => /submit application|submitting/i.test(b.innerText || ''));
            const turnstile = /verify you are human/i.test(t);
            // Greenhouse: "A verification code was sent to ... enter the 8-character code".
            const emailCode = /verification code (was|has been) sent|enter the \d+-character code|security code/i.test(t);
            return { success, validationError, submitting, formGone, turnstile, emailCode };
          }).catch(() => ({}));
          if (st.success || st.formGone) { console.log('  [ATS] ✓ Application submitted!'); lastOutcome = 'sent'; return true; }
          if (st.emailCode) { console.log('  [ATS] ⚠ The site emailed a code to finish this application. NOT sent.'); lastOutcome = 'email_code'; return false; }
          if (await _captchaBlocks(page)) {
            console.log('  [ATS] ⚠ Human-verification (CAPTCHA) on this form — application NOT sent.');
            lastOutcome = 'captcha'; return false;
          }
          if (st.validationError && !st.submitting) { console.log('  [ATS] ⚠ Submit blocked by a validation error — NOT submitted'); lastOutcome = 'validation'; return false; }
          // still submitting / turnstile pending → keep waiting
        }
        // Stuck because a Cloudflare "Verify you are human" box is waiting (Workable): a human check.
        if (await page.evaluate(() => /verify you are human/i.test(document.body?.innerText || '') || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [name="cf-turnstile-response"]')).catch(() => false)) {
          console.log('  [ATS] ⚠ Human-verification (Cloudflare) on Submit — application NOT sent.'); lastOutcome = 'captcha'; return false;
        }
        console.log('  [ATS] ⚠ Submit did not confirm (stuck on Submitting/verification) — NOT counting as applied'); lastOutcome = 'unconfirmed'; return false;
      }
    } catch (_) {}
  }
  return false;
}

// ── Emailed security code ──────────────────────────────────────────────────
// Greenhouse sometimes emails the applicant a code after Submit ("enter the 8-character
// code to confirm you're a human"). The user reads it from their own inbox and types it
// in the app; this enters it on the still-open form and submits again. True when the
// site confirms; lastOutcome says why not ('email_code' = code refused, try again).
async function submitEmailCode(page, code) {
  const chars = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  if (!chars) return false;
  const visible = async (els) => { const out = []; for (const e of els) if (await e.isVisible().catch(() => false)) out.push(e); return out; };
  // One box per character (Greenhouse), or a single code box.
  let boxes = await visible(await page.$$('input[id^="security-input"], input[maxlength="1"]'));
  if (boxes.length >= chars.length) {
    for (let i = 0; i < chars.length; i++) { await boxes[i].click().catch(() => {}); await boxes[i].fill(chars[i]).catch(() => {}); await J(60, 140); }
  } else {
    boxes = await visible(await page.$$('input[name*="security" i], input[id*="security" i], input[aria-label*="code" i], input[autocomplete="one-time-code"]'));
    if (!boxes.length) { lastOutcome = 'email_code'; return false; }
    await _setValue(boxes[0], chars);
  }
  await J(500, 900);
  for (const sel of ['button:has-text("Submit application")', 'button:has-text("Submit Application")', 'button[type="submit"]', 'button:has-text("Submit")']) {
    const btn = await page.$(sel).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) { await btn.click().catch(() => {}); break; }
  }
  for (let i = 0; i < 15; i++) {
    await J(1500, 2200);
    const st = await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase();
      return {
        success: /application (received|submitted)|thank you for (applying|your interest)|thanks for applying|successfully applied|we('| ha)ve received your|application complete/.test(t) || /confirmation/.test(location.href),
        wrong: /(invalid|incorrect|wrong|expired).{0,30}code|code.{0,30}(invalid|incorrect|expired|didn.t match)/.test(t),
      };
    }).catch(() => ({}));
    if (st.success) { console.log('  [ATS] ✓ Application submitted with the emailed code!'); lastOutcome = 'sent'; return true; }
    if (st.wrong) break;
  }
  console.log('  [ATS] ⚠ The code was not accepted. Application NOT sent.');
  lastOutcome = 'email_code';
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
// "Any gaps in employment in the last 5 years?": worked out from the saved work history
// (a gap = more than a month between one job ending and the next starting). Null when
// there's no history to go on.
function _hasEmploymentGap(question) {
  const jobs = ((cfg.TRAC_DETAILS || {}).employment || []).map((e) => ({ s: _ukDate(e.start), e: e.end ? _ukDate(e.end) : new Date() })).filter((j) => j.s && j.e);
  if (!jobs.length) return null;
  const yrs = +((/(\d+)\s*years?/.exec(question) || [])[1] || 5);
  const from = new Date(); from.setFullYear(from.getFullYear() - yrs);
  jobs.sort((x, y) => x.s - y.s);
  let covered = from;
  for (const j of jobs) {
    if (j.e < from) continue;
    if (j.s - covered > 31 * 864e5) return true;
    if (j.e > covered) covered = j.e;
  }
  return Date.now() - covered > 31 * 864e5;
}
function _ukDate(d) {
  const m = String(d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) || String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return m[1].length === 4 ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(+m[3], +m[2] - 1, +m[1]);
}

function _yesNoForQuestion(question) {
  const q = (question || '').toLowerCase();
  // "Are you a British citizen?": from the right-to-work status saved with the NHS details.
  const rtwStatus = String((cfg.TRAC_DETAILS || {}).rightToWork || '').toLowerCase();
  if (/\b(british|uk) citizen|citizen of the (uk|united kingdom)/.test(q) && rtwStatus) return /british citizen|uk citizen/.test(rtwStatus) ? 'yes' : 'no';
  if (/gaps? in (your )?(employment|work history|career)|employment gaps?/.test(q)) {
    const gap = _hasEmploymentGap(q);
    if (gap !== null) return gap ? 'yes' : 'no';
  }
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

  const fact = _workFact(question);
  if (fact !== undefined) return fact;

  const nameQ = q.replace(/[*✱:]/g, '').trim();
  if (/^(full |legal |your )?name$/.test(nameQ)) return `${firstName} ${lastName}`.trim();
  if (/^(first|given|forename)( name)?$/.test(nameQ)) return firstName || '';
  if (/^(last|family|surname)( name)?$/.test(nameQ)) return lastName || '';

  // Address from the profile ("15 Exchange Gardens, SW8 1BP"): the postcode is the part that
  // looks like a UK postcode or US ZIP, the street is the rest.
  if (/address|post ?code|postal|zip|street/i.test(q) && !/e-?mail|web/i.test(q)) {
    const addr = String(cfg.APPLICANT.address || '').trim();
    const pc = (addr.match(/\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/i) || addr.match(/\b\d{5}(?:-\d{4})?\b/) || [''])[0].toUpperCase();
    if (/post ?code|postal|zip/i.test(q)) return pc;
    if (/line ?2|line two|apartment|suite/i.test(q)) return '';
    return addr.replace(pc, '').replace(/[\s,]+$/, '').trim();
  }

  // Questions for current students (asked only if "enrolled" is answered Yes): not the
  // candidate's past degree.
  if (/anticipated graduation|expected graduation|graduation date|institution (do )?you (currently )?attend|currently (enrolled|studying)/i.test(q)) return '';

  // Links: only LinkedIn is in the profile. A "Website/Portfolio/GitHub" box (a textarea on
  // some Greenhouse forms) is left blank, never given the cover letter.
  // No LinkedIn in the profile: "N/A", so a required LinkedIn box doesn't block Submit.
  if (/linkedin/i.test(q)) return linkedin || 'N/A';
  if (/website|portfolio|github|gitlab|\burls?\b|twitter|\bx \(formerly|personal site|blog|behance|dribbble/i.test(q)) return '';

  // Job feeds give the board's short name ("tailscale"): capitalise it for the letter.
  const coName = /^[a-z0-9]+$/.test(job.company || '') ? job.company[0].toUpperCase() + job.company.slice(1) : (job.company || 'your company');
  const coverLetter = `Please see my attached CV for full details of my experience and qualifications. I am genuinely excited about the ${job.title} role at ${coName} and believe my background makes me a strong fit. I am ${AVAIL_MAP[availability || 'immediately'] || 'immediately available'} and welcome the opportunity to discuss further.`;
  // Other textareas are real questions ("Why this role?", a scenario): the rules and AI
  // below answer them, and the cover letter is only the fallback when the AI is unavailable.
  if (/cover letter|covering letter/i.test(q) || (fieldType === 'textarea' && !q.trim())) return job.coverLetter || coverLetter;
  if (/notice period|availability|when can you start|available to start/i.test(q))
    return AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
  if (/salary|compensation|expected pay|remuneration|expected salary|desired annual|on target earnings|\bote\b/i.test(q))
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
  if (/linkedin/i.test(q))  return linkedin || 'N/A';
  if (/github/i.test(q))    return '';
  if (/pronoun/i.test(q))   return '';
  if (/(how|where) did you (hear|find|learn)|how.*find.*role|how.*learn/i.test(q)) return 'Job board / online search';
  if (/additional|tell us more|anything else|comments/i.test(q))
    return 'Please see my CV for a full overview of my experience. I am available for interview at your earliest convenience.';
  if (/why.*role|why.*company|what.*attract|motivat|why (are you|do you want|would you like).*(interest|join|apply|work)|most interested in|interest(s|ed)? you (in|about)/i.test(q)) {
    const yrs = yearsExperience > 0 ? `${yearsExperience} years of` : 'solid';
    return `The ${job.title} position at ${coName} closely aligns with my ${yrs} experience and I am excited about the opportunity to contribute my skills.`;
  }

  if (!q) return '';
  // A form is re-checked several times; ask the AI each question once per form.
  const cacheKey = `t:${fieldType}:${q}`;
  if (_answerCache.has(cacheKey)) return _answerCache.get(cacheKey);
  try {
    if (await llmAvailable()) {
      const avail = AVAIL_MAP[availability || 'immediately'] || 'Immediately available';
      const home = cfg.APPLICANT.country === 'United States' ? 'US' : 'UK';
      const homeRe = home === 'US' ? /\bus\b|usa|united states|america/i : /uk|united kingdom|britain/i;
      // Work history and education, so "Company", "Title", "School" and their dates (the
      // work/education sections many ATS forms repeat) come from real data, newest first.
      const D = cfg.TRAC_DETAILS || {};
      const jobs = (D.employment || []).slice(0, 5).map((e) => `- ${e.jobTitle || ''} at ${e.employer || ''} (${e.start || '?'} to ${e.end || 'present'})`).join('\n');
      const edu = (D.education || []).slice(0, 3).map((e) => `- ${[e.qualification || e.subject, e.institution || e.school || e.place, e.end || e.year].filter(Boolean).join(', ')}`).join('\n');
      const prompt =
`You are completing a job application form on behalf of ${firstName} ${lastName}.

Candidate facts:
- ${yearsExperience} years of experience
- Location: ${location}
- Availability: ${avail}
- Right to work in ${home}: ${(rightToWorkCountries || []).some(c => homeRe.test(c)) ? 'Yes' : 'No'}
- Requires visa sponsorship: ${_yesNoForQuestion('do you require sponsorship') === 'yes' ? 'Yes' : 'No'}
${jobs ? `Work history (newest first):\n${jobs}\n` : ''}${edu ? `Education:\n${edu}\n` : ''}${job && job.cvText ? `CV:\n${String(job.cvText).slice(0, 5000)}\n` : ''}
Job: ${job.title} at ${job.company}

Form question: "${question}"

Rules:
- Use only the facts above. Never invent employers, job titles, dates, schools, links, numbers or experience.
- Experience with a specific skill, tool, standard, technology or industry counts only if the CV or work history shows it.
- A short field (company, job title, school, degree, a date, month, year, number or URL) takes just the value, nothing else. Fields about a job or school with no other context mean the most recent one.
- Company, employer, job title and date fields in a work-history section are about the candidate's OWN past jobs, never the job being applied for. A job with no end date is current: its end date fields get SKIP.
- An open question gets 1 to 3 natural, professional sentences. No bullet points, no mention of AI.
- If the facts don't answer it, reply with exactly: SKIP`;
      const answer = await llmChat(prompt);
      if (/^\W*skip\W*$/i.test(String(answer || '').trim()) || /^(please provide|i('m| am) (sorry|unable)|could you (please )?(provide|clarify)|as an ai)/i.test(String(answer || '').trim())) { console.log(`  [ATS] Not in your details, left blank: "${question.substring(0, 50)}"`); _answerCache.set(cacheKey, ''); return ''; }
      if (answer?.trim()) {
        console.log(`  [ATS] AI: "${question.substring(0, 50)}" → "${answer.substring(0, 60)}"`);
        _answerCache.set(cacheKey, answer.trim());
        return answer.trim();
      }
    } else if (fieldType === 'textarea') return coverLetter;
  } catch (e) {
    console.log(`  [ATS] AI answer failed: ${e.message}`);
  }
  return '';
}

// ── Custom dropdowns ───────────────────────────────────────────────────────
// Greenhouse (and others) render questions as react-select comboboxes: an <input role=combobox>
// whose options only exist while the menu is open. Open it, read the options, pick one with the
// same rules/AI as native selects, then click it. Mouse events are dispatched in the page so this
// works the same in Playwright and in the Chrome extension.
// Whole words: "race" must not match "Abtrace", nor "identity" an IT skill like identity management.
const DEMOGRAPHIC_RE = /gender|ethnic|\brac(e|ial)\b|hispanic|\blatin[oax]\b|sexual|disab|neurodiver|veteran|pronoun|religio|age range|\bwhat age\b|\byour age\b|\bage (group|bracket)\b|how old|transgender/i;
async function _answerComboboxes(page, job) {
  // Re-find the dropdowns before each one: picking an answer re-renders the form, which can
  // replace later inputs and leave stale handles behind.
  const total = (await page.$$('input[role="combobox"]')).length;
  for (let i = 0; i < total; i++) {
    const box = (await page.$$('input[role="combobox"]'))[i];
    if (!box) break;
    try {
      if (!await box.isVisible()) continue;
      const info = await box.evaluate(el => {
        const byId = id => { const e = id && document.getElementById(id); return e ? (e.innerText || '').trim() : ''; };
        const lab = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label');
        const alb = el.getAttribute('aria-labelledby') || '';
        const wrap = el.closest('[class*="field"],[class*="Field"],[class*="question"],[class*="select"]');
        const wl = wrap && wrap.parentElement && wrap.parentElement.querySelector('label, legend');
        const question = (lab?.innerText || (alb ? byId(alb.split(' ')[0]) : '') || el.getAttribute('aria-label') || wl?.innerText || '').trim();
        const control = el.closest('[class*="control"]') || el.parentElement;
        const chosen = control && control.querySelector('[class*="single-value"],[class*="singleValue"],[class*="multi-value"],[class*="multiValue"]');
        return { question, has: !!(chosen && chosen.textContent.trim()) };
      }).catch(() => ({ question: '', has: true }));
      if (info.has) continue;
      if (!info.question) { console.log('  [ATS] ⚠ Dropdown with no question text, skipped'); continue; }
      const q = info.question.replace(/\s*\*\s*$/, '');

      const readOptions = () => box.evaluate(el => {
        const id = el.getAttribute('aria-controls');
        const menu = id && document.getElementById(id);
        const opts = Array.from((menu || document).querySelectorAll('[role="option"]')).filter(o => o.offsetParent);
        return opts.map(o => (o.innerText || o.textContent || '').trim());
      }).catch(() => []);
      const open = () => box.evaluate(el => {
        el.focus();
        // react-select only opens on the full pointer + mouse sequence (a lone mousedown is ignored).
        const ctl = el.closest('[class*="control"]') || el.parentElement;
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const E = t.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          ctl.dispatchEvent(new E(t, { bubbles: true, cancelable: true, button: 0, view: window, pointerType: 'mouse' }));
        }
      }).catch(() => {});

      await open(); await J(400, 700);
      let options = await readOptions();
      if (!options.length) { await box.press('Escape').catch(() => {}); await J(300, 500); await open(); await J(900, 1300); options = await readOptions(); }
      // Ashby's search dropdowns open from the arrow button beside the box, or the Down key.
      if (!options.length) {
        await box.evaluate(el => { const b = el.parentElement && el.parentElement.querySelector('button'); if (b) b.click(); }).catch(() => {});
        await J(600, 900); options = await readOptions();
        if (!options.length) { await box.focus().catch(() => {}); await box.press('ArrowDown').catch(() => {}); await J(600, 900); options = await readOptions(); }
      }
      // A short "Location / City" search box, not a question that merely mentions the location.
      const isLocation = q.length <= 45 && /\b(location|city|town)\b|where.*(live|based)/i.test(q) && !/right to work|visa|sponsor|relocat|willing/i.test(q);
      if (!options.length || isLocation) {
        // Search-as-you-type dropdowns (e.g. Location): type the answer, then read the matches.
        const typed = isLocation ? (cfg.APPLICANT.location || '') : '';
        if (!typed) { console.log(`  [ATS] ⚠ Dropdown would not open: "${q.substring(0, 50)}"`); await box.press('Escape').catch(() => {}); continue; }
        await box.fill(typed).catch(() => {});
        await J(1500, 2200);
        options = await readOptions();
      }
      if (!options.length) { console.log(`  [ATS] ⚠ No options for dropdown: "${q.substring(0, 50)}"`); await box.press('Escape').catch(() => {}); continue; }

      // An optional "If yes, ..." follow-up: left blank (it only applies to a "Yes" above).
      if (/^\s*if (yes|so)\b/i.test(q) && !/\*\s*$/.test(info.question)) { await box.press('Escape').catch(() => {}); continue; }
      let chosen = null;
      const fact = _workFact(q);
      if (fact !== undefined) {
        const f = String(fact).toLowerCase().trim();
        chosen = f ? (options.find(t => t.toLowerCase() === f) || options.find(t => t.toLowerCase().includes(f) || (f.length > 3 && f.includes(t.toLowerCase())))) || null : null;
        if (!chosen) { console.log(`  [ATS] Not in your details, left blank: "${q.substring(0, 50)}"`); await box.press('Escape').catch(() => {}); continue; }
      }
      if (isLocation) chosen = options[0];
      else if (DEMOGRAPHIC_RE.test(q)) chosen = options.find(t => /prefer not|decline|don.?t wish|do not wish|rather not|not to (say|answer|disclose)/i.test(t)) || null;
      // "Have you used Tailscale before?": the honest "not yet" option, never a guessed "Yes".
      else if (/have you (ever )?used|are you (already )?(familiar|a (current )?(user|customer))|used .* before/i.test(q) && options.some(t => /haven.?t|have not|not yet|never|^no\b/i.test(t))) chosen = options.find(t => /haven.?t|have not|not yet|never|^no\b/i.test(t));
      // The agent found it online: never claim a referral, recruiter or event.
      else if (/how did you (hear|find|learn)|where did you (hear|see|find)|source of (this )?application/i.test(q))
        chosen = options.find(t => /career(s)? (page|site)|company (web)?site|job board|online|website|internet|search/i.test(t)) || options.find(t => /^other\b/i.test(t)) || null;
      if (!chosen) chosen = _pickDropdownOption(q, options.map(t => ({ val: t, text: t })));
      if (!chosen && !DEMOGRAPHIC_RE.test(q)) chosen = await _aiPickOption(q, options, job);
      if (!chosen) { console.log(`  [ATS] ⚠ No answer for dropdown: "${q.substring(0, 50)}" [${options.slice(0, 4).join(' / ').substring(0, 80)}]`); await box.press('Escape').catch(() => {}); continue; }

      const clicked = await box.evaluate((el, want) => {
        const id = el.getAttribute('aria-controls');
        const menu = id && document.getElementById(id);
        const opt = Array.from((menu || document).querySelectorAll('[role="option"]')).filter(o => o.offsetParent)
          .find(o => (o.innerText || o.textContent || '').trim() === want);
        if (!opt) return false;
        for (const t of ['pointermove', 'mousemove', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const E = t.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
          opt.dispatchEvent(new E(t, { bubbles: true, cancelable: true, button: 0, view: window, pointerType: 'mouse' }));
        }
        return true;
      }, chosen).catch(() => false);
      await J(250, 450);
      console.log(`  [ATS] ${clicked ? 'Dropdown' : '⚠ Dropdown click failed'} "${q.substring(0, 40)}" → "${String(chosen).substring(0, 40)}"`);
    } catch (e) { console.log(`  [ATS] ⚠ Dropdown error: ${e.message}`); }
  }
}

// ── Rule-based dropdown picker ─────────────────────────────────────────────
// "Which office / work location do you prefer?": the option naming the candidate's city
// (best if it also names their home country). Null when it isn't such a question or no
// option names the city (the AI then picks, knowing where they live).
function _pickLocationOption(question, optionTexts) {
  if (!/(prefer|preferred|which).*(office|location|site|hub)|(office|work) location/i.test(question || '')) return null;
  const city = (cfg.APPLICANT.location || '').split(',')[0].trim().toLowerCase();
  // Home = where they have the right to work (the profile country can be a search setting).
  const rtw = (cfg.APPLICANT.rightToWorkCountries || [])[0] || cfg.APPLICANT.country || '';
  const home = /united states|\busa?\b/i.test(rtw) ? /\bus\b|usa|united states/i : /\buk\b|united kingdom|britain|england/i;
  const hasCity = (t) => city && t.toLowerCase().includes(city);
  return optionTexts.find(t => hasCity(t) && home.test(t)) || optionTexts.find(hasCity) || null;
}

function _pickDropdownOption(question, options) {
  const q = (question || '').toLowerCase();
  const loc = _pickLocationOption(question, options.map(o => o.text));
  if (loc) return loc;
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
  const loc = _pickLocationOption(question, optionTexts);
  if (loc) return loc;
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

// Work-history and education fields ("Company name", "Title", "Start date month", "School"
// in the repeating sections Greenhouse and others add): answered from the candidate's own
// most recent job and qualification in code, not the AI, which confused them with the job
// being applied for. Returns undefined when the label isn't one of these fields, '' when it
// is but the data doesn't give it (left blank), otherwise the value.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function _workFact(question) {
  const q = String(question || '').toLowerCase().replace(/[*:]/g, '').trim();
  const D = cfg.TRAC_DETAILS || {};
  const job = (D.employment || [])[0] || {};
  const edu = (D.education || [])[0] || {};
  const part = (d, kind) => {
    const m = String(d || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{2})|^(\d{4})$/);
    if (!m) return '';
    const month = m[2] ? +m[2] : m[5] ? +m[5] : 0, year = m[3] || m[4] || m[6] || '';
    return kind === 'year' ? year : (month ? MONTHS[month - 1] : '');
  };
  if (/^(company( name)?|employer( name)?|current (company|employer))$/.test(q)) return job.employer || '';
  if (/^(title|job title|position|role)$/.test(q)) return job.jobTitle || '';
  const date = q.match(/^(start|end|from|to) date (month|year)$/);
  if (date) {
    const end = /^(end|to)$/.test(date[1]);
    if (end && !job.end) return ''; // current job: no end date
    return part(end ? job.end : job.start, date[2]);
  }
  if (/^(school|university|institution|college)( name)?$/.test(q)) return edu.institution || edu.school || edu.place || '';
  if (/^(discipline|field of study|major|subject)$/.test(q)) return edu.subject || edu.qualification || '';
  return undefined;
}

// ── AI option picker ───────────────────────────────────────────────────────
async function _aiPickOption(question, optionTexts, job) {
  if (!question || !optionTexts.length) return null;
  const cacheKey = `o:${question}|${optionTexts.join('|')}`;
  if (_answerCache.has(cacheKey)) return _answerCache.get(cacheKey);
  const picked = await _aiPickOptionUncached(question, optionTexts, job);
  _answerCache.set(cacheKey, picked);
  return picked;
}
async function _aiPickOptionUncached(question, optionTexts, job) {
  try {
    if (!await llmAvailable()) return null;
    const { firstName, lastName, yearsExperience, availability, rightToWorkCountries, country, location } = cfg.APPLICANT;
    const home = country === 'United States' ? 'US' : 'UK';
    const homeRe = home === 'US' ? /\bus\b|usa|united states|america/i : /uk|united kingdom|britain/i;
    const AVAIL_MAP = { 'immediately': 'Immediately', '1week': '1 week', '2weeks': '2 weeks', '1month': '1 month', '3months': '3 months' };
    const prompt =
`You are completing a job application for ${firstName} ${lastName} (${yearsExperience} yrs experience, lives in ${location || country || home}, availability: ${AVAIL_MAP[availability] || 'immediately'}, right to work ${home}: ${(rightToWorkCountries||[]).some(c=>homeRe.test(c))}, requires visa sponsorship: ${_yesNoForQuestion('require sponsorship') === 'yes'}).

${(() => { const D = cfg.TRAC_DETAILS || {}; const w = (D.employment || []).slice(0, 5).map((e) => `- ${e.jobTitle || ''} at ${e.employer || ''} (${e.start || '?'} to ${e.end || 'present'})`).join('\n'); const ed = (D.education || []).slice(0, 3).map((e) => `- ${[e.qualification || e.subject, e.institution || e.school || e.place, e.end || e.year].filter(Boolean).join(', ')}`).join('\n'); return (w ? `Work history (newest first):\n${w}\n` : '') + (ed ? `Education:\n${ed}\n` : ''); })()}${job && job.cvText ? `CV:\n${String(job.cvText).slice(0, 5000)}\n` : ''}
Question: "${question}"
Options:
${optionTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

A question about a specific date, month, year, school, degree or employer must come from the facts above (fields about a job or school with no other context mean the candidate's own most recent one, never the job being applied for; a job with no end date is current, so its end date is SKIP); if the facts don't give it, reply with exactly: SKIP
Answer truthfully. For a willingness, availability or commitment question the candidate can reasonably meet (e.g. willing to work on-site, able to commute), choose the affirmative option. For a rating of their own skill or knowledge, pick a modest middle level unless the details above show real expertise; never overstate. Never claim a licence, certificate, clearance or past employer the details don't show. For experience with a specific skill, tool, standard (e.g. ISO 27001), technology or industry, choose yes only if the CV or work history shows it; otherwise choose the no / none / lowest option. Reply with ONLY the exact text of the best option. No explanation.`;
    // The model occasionally returns an empty/garbled reply; a blank required
    // radio blocks the whole submission, so retry a couple of times before giving
    // up (each blank answer is a lost application otherwise).
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await llmChat(prompt);
      const cleaned = (reply || '').trim().replace(/^\d+\.\s*/, '');
      if (!cleaned) { await J(300, 600); continue; }
      if (/^\W*skip\W*$/i.test(cleaned)) { console.log(`  [ATS] Not in your details, left blank: "${question.substring(0, 50)}"`); return null; }
      const lc = cleaned.toLowerCase();
      const match = optionTexts.find(t => t.toLowerCase() === lc)
        || optionTexts.find(t => t.toLowerCase().startsWith(lc) || lc.startsWith(t.toLowerCase()))
        || optionTexts.find(t => t.toLowerCase().includes(lc) || lc.includes(t.toLowerCase()));
      if (match) return match;
      await J(300, 600);
    }
    return null;
  } catch (_) { return null; }
}

// Greenhouse's embedded form always shows the application, even for companies whose
// hosted job page redirects to their own careers site (Coinbase, Stripe...).
function formUrl(url) {
  const m = String(url || '').match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  return m ? `https://job-boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}` : url;
}

module.exports = { detectATS, SUPPORTED_ATS, ACCOUNT_REQUIRED_ATS, fillExternalForm, submitEmailCode, formUrl, lastSubmitOutcome: () => lastOutcome, _yesNoForQuestion, _pickRadioOption };
