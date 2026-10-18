// Dice (dice.com) — US tech job board with its own "Easy Apply".
// Search + job page work signed out; applying needs the user's Dice account
// (signed in once in the agent's window, see ensureLoggedIn).
// Cloudflare-checked 2026-10-18: search, job page and Apply Now load clean in
// both the app's stealth Chrome and real Chrome.

const cfg = require('../config');
const path = require('path');
const { promptLogin } = require('./login_prompt');
const ai = require('./question_ai');

const SSDIR = cfg.SCREENSHOTS_DIR;
const DELAY = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'https://www.dice.com';

// ── Sign-in ────────────────────────────────────────────────────────────────
async function diceSignedIn(page) {
  if (!/dice\.com/.test(page.url()) || /\/dashboard\/login|\/login/.test(page.url())) return false;
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('header a, header button, nav a, nav button')].map(a => (a.innerText || '').trim().toLowerCase());
    if (links.includes('login') || links.includes('log in') || links.includes('sign in')) return false;
    return !!document.querySelector('a[href*="/dashboard/profile"], a[href*="/logout"], [data-testid*="avatar" i], [aria-label*="profile" i], [aria-label*="account" i]')
      || links.some(t => /log ?out|sign ?out|profile|my jobs/.test(t));
  }).catch(() => false);
}

async function ensureLoggedIn(page) {
  await page.goto(`${BASE}/home/home-feed`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await DELAY(3000);
  if (!(await diceSignedIn(page))) {
    await promptLogin(page, { site: 'Dice', loginUrl: `${BASE}/dashboard/login`, isSignedIn: diceSignedIn });
  }
  console.log('  [Dice] Session active');
}

// ── Search ─────────────────────────────────────────────────────────────────
// Easy Apply only, posted in the last week (or month for longer job-age settings).
function searchUrl(term) {
  const days = Math.round((parseInt(String(cfg.JOB_AGE || 'r1209600').replace('r', ''), 10) || 1209600) / 86400);
  const posted = days <= 1 ? 'ONE' : days <= 3 ? 'THREE' : days <= 7 ? 'SEVEN' : 'THIRTY';
  const p = new URLSearchParams({ q: term, 'filters.easyApply': 'true', 'filters.postedDate': posted });
  // Remote-only users get Dice's remote filter; otherwise search their location.
  const wt = cfg.WORK_TYPE_PRIORITY || ['remote', 'hybrid', 'onsite'];
  const loc = String(cfg.LOCATION || '').trim();
  if (wt.length === 1 && wt[0] === 'remote') p.set('filters.workplaceTypes', 'Remote');
  else if (loc && !/^(united states|usa|us|remote)$/i.test(loc)) p.set('location', loc);
  if (cfg.CONTRACT_TYPE === 'permanent') p.set('filters.employmentType', 'FULLTIME');
  else if (cfg.CONTRACT_TYPE === 'contract') p.set('filters.employmentType', 'CONTRACTS');
  return `${BASE}/jobs?${p.toString()}`;
}

async function searchJobs(page, searchTerm, limit = 25) {
  console.log(`\n  [Dice] Searching: "${searchTerm}"`);
  await page.goto(searchUrl(searchTerm), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(5000);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await DELAY(600); }
  const jobs = await page.evaluate((lim) => {
    const seen = new Set(); const out = [];
    for (const a of document.querySelectorAll('a[data-testid="job-search-job-detail-link"], a[href*="/job-detail/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/job-detail\/([0-9a-f-]{36})/i);
      if (!m || seen.has(m[1])) continue;
      const title = (a.innerText || a.getAttribute('aria-label') || '').trim();
      if (!title || /^view details/i.test(title)) continue;
      seen.add(m[1]);
      // The card's text runs "Title / Company / Location • age / type / pay".
      let card = a; for (let i = 0; i < 6 && card && !(card.innerText || '').includes('•'); i++) card = card.parentElement;
      const lines = ((card && card.innerText) || '').split('\n').map(s => s.trim()).filter(Boolean);
      const ti = lines.indexOf(title);
      out.push({ jobId: 'dice_' + m[1], jobKey: m[1], title, company: lines[ti + 1] || '', location: (lines[ti + 2] || '').split('•')[0].trim(), url: `${location.origin}/job-detail/${m[1]}` });
      if (out.length >= lim) break;
    }
    return out;
  }, limit).catch(() => []);
  console.log(`  [Dice] Found ${jobs.length} jobs for "${searchTerm}"`);
  return jobs;
}

// ── Job description ────────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(4000);
  const d = await page.evaluate(() => {
    const desc = document.querySelector('[data-testid="jobDescriptionHtml"], [class*="jobDescription"], #jobDescription');
    const company = document.querySelector('a[href*="/company-profile/"], [data-cy="companyNameLink"]');
    // Dice's own apply goes to /job-applications/{id}; anything else leaves Dice.
    const apply = [...document.querySelectorAll('a, button, apply-button-wc, span')].find(b => b.offsetParent !== null && /^(apply now|easy apply|apply|continue application)$/i.test((b.innerText || '').trim()));
    const href = (apply && (apply.getAttribute('href') || (apply.closest('a') && apply.closest('a').getAttribute('href')))) || '';
    const applied = [...document.querySelectorAll('button, a, span')].some(b => b.offsetParent !== null && /^applied$|^application submitted$/i.test((b.innerText || '').trim()));
    return {
      description: desc ? desc.innerText.trim() : (document.querySelector('main')?.innerText || '').trim().slice(0, 8000),
      company: company ? company.innerText.trim() : '',
      hasEasyApply: !!apply && (!href || /job-applications|dashboard\/login/.test(href)),
      alreadyApplied: applied,
    };
  }).catch(() => ({ description: '', company: '', hasEasyApply: false, alreadyApplied: false }));
  console.log(`  [Dice] JD: ${d.description.length} chars | Easy Apply: ${d.hasEasyApply}`);
  return { ...job, company: job.company || d.company, description: d.description, hasEasyApply: d.hasEasyApply, alreadyApplied: d.alreadyApplied };
}

// ── Apply ──────────────────────────────────────────────────────────────────
// Dice's wizard: Resume & Cover Letter → (screening questions on some jobs) → Review → Submit.
// Work authorization and location come from the user's Dice profile.
// Returns true (applied), false (couldn't finish) or null (already applied).
// Marks the first visible element (css) whose text matches `re` and returns a selector for it,
// or '' if none. Plain CSS + evaluate so the same code runs in the app and the extension.
async function _find(page, css, re) {
  const tok = 'c' + Math.random().toString(36).slice(2, 9);
  const hit = await page.evaluate(([css, src, tok]) => {
    const re = new RegExp(src, 'i');
    const el = [...document.querySelectorAll(css)].find(e => e.offsetParent !== null && re.test(((e.innerText || e.getAttribute('aria-label') || '') + '').trim()));
    if (!el) return false;
    el.setAttribute('data-jbclick', tok);
    return true;
  }, [css, re.source, tok]).catch(() => false);
  return hit ? `[data-jbclick="${tok}"]` : '';
}

const RESUME_NAME_RE = /Resume\s*\*\s*\n?\s*([^\n]+\.(pdf|docx?|rtf|txt))/i;

async function applyToJob(page, job, resumePath) {
  console.log(`  [Dice] Applying: ${job.title} @ ${job.company}`);
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(5000);
  if (!(await diceSignedIn(page))) throw new Error('Dice: signed out, please sign in again');

  const state = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('button, a, span')].filter(b => b.offsetParent !== null).map(b => (b.innerText || '').trim());
    return { applied: vis.some(t => /^applied$|^application submitted$/i.test(t)), canApply: vis.some(t => /^(easy apply|apply now|continue application)$/i.test(t)) };
  }).catch(() => ({}));
  if (state.applied) { console.log('  [Dice] Already applied, skipping.'); return null; }
  if (!state.canApply) throw new Error('Dice: no apply button (external apply)');

  // A half-finished application shows "Continue Application" instead.
  const applyBtn = await _find(page, 'a, button, span', /^(easy apply|apply now|continue application)$/);
  if (!applyBtn) throw new Error('Dice: no apply button (external apply)');
  await page.locator(applyBtn).first().click({ timeout: 15000 });
  for (let i = 0; i < 20 && !/job-applications\//.test(page.url()); i++) await DELAY(1000);
  if (!/job-applications\//.test(page.url())) throw new Error('Dice: apply button did not open the application');
  await DELAY(4000);

  let resumeDone = !resumePath;
  let lastSig = '';
  for (let step = 1; step <= 8; step++) {
    if (!resumeDone && await _hasResumeSection(page)) resumeDone = await _replaceResume(page, resumePath);
    await _answerQuestions(page, job);

    // Step counter + form text: unchanged after Next means the page refused to move on.
    const sig = await page.evaluate(() => ((document.body.innerText.match(/step \d+ of \d+/i) || [''])[0]) + '|' + [...document.querySelectorAll('form')].map(f => f.innerText).join('|').slice(0, 1500)).catch(() => '');
    const submit = await _find(page, 'button', /^submit$/);
    if (submit) {
      // Never send the base resume when a tailored one was made for this job.
      if (!resumeDone) { console.log('  [Dice] Tailored resume not attached, not submitting.'); return false; }
      if (process.env.JOBBOT_NO_SUBMIT === '1') { console.log('  [Dice] TEST MODE: reached Submit, not pressing it'); return true; }
      await page.locator(submit).first().click();
      for (let i = 0; i < 20; i++) {
        await DELAY(1000);
        const ok = await page.evaluate(() => /application (has been |was )?(submitted|sent)|successfully applied|thanks for applying/i.test(document.body.innerText || '') || /\/success|confirmation/i.test(location.href)).catch(() => false);
        if (ok) { console.log('  [Dice] Application submitted.'); return true; }
      }
      await page.screenshot({ path: path.join(SSDIR, 'dice_after_submit.png'), fullPage: true }).catch(() => {});
      console.log('  [Dice] Submit pressed but no confirmation seen.');
      return false;
    }

    if (sig && sig === lastSig) {
      const errs = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [class*="error" i]')].map(e => (e.innerText || '').trim()).filter(t => t && t.length < 200)).catch(() => []);
      if (errs.length) console.log(`  [Dice] Form says: ${[...new Set(errs)].slice(0, 5).join(' | ')}`);
      await page.screenshot({ path: path.join(SSDIR, 'dice_stuck.png'), fullPage: true }).catch(() => {});
      console.log(`  [Dice] Stuck on step ${step}.`);
      return false;
    }
    lastSig = sig;
    const next = await _find(page, 'button', /^(next|continue)$/);
    if (!next) { console.log('  [Dice] No Next or Submit button.'); return false; }
    await page.locator(next).first().click().catch(() => {});
    await DELAY(4000);
  }
  return false;
}

async function _hasResumeSection(page) {
  return page.evaluate(() => /resume\s*\*/i.test(document.body.innerText || '') && !/review your application/i.test(document.body.innerText || '')).catch(() => false);
}

const _resumeName = page => page.evaluate(re => ((document.body.innerText || '').match(new RegExp(re, 'i')) || [])[1] || '', RESUME_NAME_RE.source).catch(() => '');

// Swap the profile resume for this job's tailored one ("File options" → Replace).
async function _replaceResume(page, resumePath) {
  try {
    const before = await _resumeName(page);
    const want = path.basename(resumePath).toLowerCase();
    // A resumed draft may already carry this job's resume.
    if (before.toLowerCase() === want) { console.log(`  [Dice] Resume: ${before} (already attached)`); return true; }
    const opts = await _find(page, 'button', /file options/);
    if (opts) {
      await page.locator(opts).first().click().catch(() => {});
      await DELAY(1000);
      const items = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] a, li button')].filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim()).filter(Boolean)).catch(() => []);
      console.log(`  [Dice] Resume options: ${items.join(' | ') || '(none)'}`);
      const rep = await _find(page, '[role="menuitem"], [role="menu"] button, li button, button', /^(replace|upload new|replace file|upload)( resume)?$/);
      if (rep) {
        const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        await page.locator(rep).first().click().catch(() => {});
        const fc = await chooser;
        if (fc) await fc.setFiles(resumePath);
        await DELAY(4000);
      }
    }
    let after = await _resumeName(page);
    if (after === before) {
      // Fall back to the page's first file input (the resume one).
      const input = page.locator('input[type="file"]').first();
      if (await input.count()) { await input.setInputFiles(resumePath).catch(() => {}); await DELAY(4000); }
      after = await _resumeName(page);
    }
    const ok = !!after && after !== before;
    console.log(`  [Dice] Resume: ${before || '?'} -> ${after || '?'} ${ok ? '(tailored attached)' : '(NOT replaced)'}`);
    return ok;
  } catch (e) {
    console.log(`  [Dice] Resume replace failed: ${e.message}`);
    return false;
  }
}

// Screening questions left empty by Dice: radios, selects, text. AI first, safe fallback.
async function _answerQuestions(page, job) {
  const qs = await page.evaluate(() => {
    const vis = e => e.offsetParent !== null || (e.type === 'radio' && e.closest('label') && e.closest('label').offsetParent !== null);
    const qText = el => {
      const fs = el.closest('fieldset'); const lg = fs && fs.querySelector('legend');
      if (lg) return lg.innerText.trim();
      const rg = el.closest('[role="radiogroup"]');
      const lb = el.getAttribute('aria-labelledby') || (rg && rg.getAttribute('aria-labelledby'));
      if (lb) { const t = lb.split(' ').map(id => (document.getElementById(id) || {}).innerText || '').join(' ').trim(); if (t) return t; }
      if (el.type !== 'radio' && el.labels && el.labels[0]) return el.labels[0].innerText.trim();
      let n = el.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        const t = [...n.querySelectorAll('label, p, span, div')].find(x => x.children.length === 0 && (x.innerText || '').trim().length > 8 && !x.contains(el) && !(x.closest('label') && x.closest('label').contains(el)));
        if (t) return t.innerText.trim();
      }
      return el.getAttribute('aria-label') || el.name || '';
    };
    const out = []; let k = 0; const radios = {};
    // The wizard's form is not inside <main>; header search boxes are outside any form.
    for (const el of document.querySelectorAll('form input, form select, form textarea')) {
      if (['hidden', 'file', 'submit', 'button', 'search', 'checkbox'].includes(el.type) || !vis(el)) continue;
      if (!el.dataset.jbq) el.dataset.jbq = 'q' + (k++) + Math.random().toString(36).slice(2, 6);
      if (el.type === 'radio') {
        const g = el.name || qText(el);
        const r = radios[g] = radios[g] || { kind: 'radio', q: qText(el), opts: [], done: false };
        r.opts.push({ text: ((el.labels && el.labels[0] && el.labels[0].innerText) || el.value || '').trim(), id: el.dataset.jbq });
        if (el.checked) r.done = true;
      } else if (el.tagName === 'SELECT') {
        if (el.value && el.selectedIndex > 0) continue;
        out.push({ kind: 'select', q: qText(el), id: el.dataset.jbq, opts: [...el.options].slice(1).map(o => ({ text: o.text.trim(), value: o.value })) });
      } else if (!el.value) {
        out.push({ kind: el.tagName === 'TEXTAREA' ? 'textarea' : (el.type === 'number' ? 'number' : 'text'), q: qText(el), id: el.dataset.jbq });
      }
    }
    for (const r of Object.values(radios)) if (!r.done) out.push(r);
    return out;
  }).catch(() => []);

  for (const f of qs) {
    try {
      if (f.kind === 'radio' || f.kind === 'select') {
        let pick = await ai.aiPickOption({ question: f.q, options: f.opts, job, kind: f.kind });
        if (!pick) pick = f.opts.find(o => /^yes\b/i.test(o.text)) || f.opts[0];
        if (!pick) continue;
        if (f.kind === 'radio') {
          // Dice hides the real input; the label is what takes the click.
          await page.evaluate(id => { const i = document.querySelector(`[data-jbq="${id}"]`); if (i) (i.closest('label') || i).click(); }, pick.id);
        } else {
          await page.locator(`[data-jbq="${f.id}"]`).selectOption(pick.value);
        }
        console.log(`  [Dice] Q: ${f.q.slice(0, 70)} -> ${pick.text}`);
      } else {
        let ans = await ai.aiTextAnswer({ question: f.q, job, long: f.kind === 'textarea' });
        if (f.kind === 'number') ans = (String(ans || '').match(/\d+/) || [''])[0];
        if (!ans) continue;
        await page.locator(`[data-jbq="${f.id}"]`).fill(String(ans));
        console.log(`  [Dice] Q: ${f.q.slice(0, 70)} -> ${String(ans).slice(0, 60)}`);
      }
      await DELAY(400);
    } catch (e) { console.log(`  [Dice] Could not answer "${(f.q || '').slice(0, 50)}": ${e.message}`); }
  }
}

module.exports = { ensureLoggedIn, diceSignedIn, searchJobs, getJobDescription, applyToJob, searchUrl, SSDIR, path };

