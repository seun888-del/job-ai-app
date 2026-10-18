// Wellfound (wellfound.com, formerly AngelList Talent): US startup jobs with their own apply form.
// Needs the user's Wellfound account (signed in once in the agent's window, see ensureLoggedIn)
// with Skills and Work experience filled in, or Wellfound refuses every application.
// Checked 2026-10-18: job search, job pages and the apply form load clean in the app's stealth
// Chrome. The apply form loads Cloudflare Turnstile, shown only when "Send application" is pressed.
//
// Wellfound always sends the resume on the user's profile, so applying first uploads this job's
// tailored resume to the profile.

const cfg = require('../config');
const path = require('path');
const { promptLogin } = require('./login_prompt');
const ai = require('./question_ai');

const SSDIR = cfg.SCREENSHOTS_DIR;
const DELAY = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'https://wellfound.com';
const MODAL = '.ReactModal__Content';

// ── Sign-in ────────────────────────────────────────────────────────────────
async function wellfoundSignedIn(page) {
  if (!/wellfound\.com/.test(page.url()) || /\/login|\/join/.test(page.url())) return false;
  return page.evaluate(() => {
    const vis = [...document.querySelectorAll('a, button')].filter(e => e.offsetParent !== null).map(e => (e.innerText || '').trim().toLowerCase());
    if (vis.includes('log in') || vis.includes('login')) return false;
    return vis.includes('applied') || vis.includes('messages') || !!document.querySelector('a[href*="/profile/edit"]');
  }).catch(() => false);
}

// Pop-ups Wellfound puts over job pages: cookie banner and "Apply to be Featured".
async function dismissPopups(page) {
  for (const re of [/^reject all$/i, /^skip for now/i]) {
    const sel = await _find(page, 'button', re);
    if (sel) { await page.locator(sel).first().click({ timeout: 3000 }).catch(() => {}); await DELAY(1000); }
  }
}

async function ensureLoggedIn(page) {
  await page.goto(`${BASE}/jobs`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await DELAY(5000);
  await waitForHuman(page);
  if (!(await wellfoundSignedIn(page))) {
    await promptLogin(page, { site: 'Wellfound', loginUrl: `${BASE}/login`, isSignedIn: wellfoundSignedIn });
  }
  await dismissPopups(page);
  console.log('  [Wellfound] Session active');
}

// ── Search ─────────────────────────────────────────────────────────────────
// The same steps a person takes: Filters, one keyword, View results, then read the job cards.
// (Wellfound's search endpoint needs a signature only its own page code makes, so we never
// call it directly.) Each card says "Apply on Wellfound" or "Apply on company website".

// Cloudflare's "verify you are human" page. The user clicks it in the agent's window.
async function waitForHuman(page) {
  const blocked = () => page.evaluate(() => /just a moment|verify you are human|performing security verification/i.test((document.title || '') + ' ' + ((document.body && document.body.innerText) || '').slice(0, 500))).catch(() => false);
  if (!(await blocked())) return;
  console.log('  [[JOBBOT_NOTIFY]] Wellfound wants a quick human check. Click the box in the Wellfound window.');
  for (let i = 0; i < 60; i++) { await DELAY(3000); if (!(await blocked())) { console.log('  [Wellfound] Check passed, carrying on.'); await DELAY(2000); return; } }
  throw new Error('Wellfound: the human check was not completed');
}

function workTypeOf(text) {
  const t = String(text || '').toLowerCase();
  if (/remote only|onsite or remote|^remote|in office or remote/.test(t) || /\bremote\b/.test(t) && !/hybrid|onsite only|in office/.test(t)) return 'remote';
  if (/hybrid/.test(t)) return 'hybrid';
  return 'onsite';
}

async function searchJobs(page, searchTerm, limit = 25) {
  console.log(`\n  [Wellfound] Searching: "${searchTerm}"`);
  await page.goto(`${BASE}/jobs`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await DELAY(5000);
  await waitForHuman(page);
  await dismissPopups(page);
  const filters = await _find(page, 'button', /^filters$/);
  if (!filters) throw new Error('Wellfound: job search did not load');
  await page.locator(filters).first().click();
  await DELAY(2500);
  const M = '[data-test="SearchBar-FilterControlPanelModal"]';
  // One keyword at a time: clear the old ones, and any job title, so the keyword decides.
  const clearKw = await _find(page, `${M} [data-test="KeywordsFilterField--keywords"] button`, /^clear$/);
  if (clearKw) { await page.locator(clearKw).first().click().catch(() => {}); await DELAY(800); }
  for (let i = 0; i < 3; i++) {
    const role = await _find(page, `${M} [data-test="RoleSelectWrapper"] button`, /^(clear|remove)/);
    if (!role) break;
    await page.locator(role).first().click().catch(() => {}); await DELAY(600);
  }
  const kw = page.locator(`${M} [data-test="KeywordsFilterField--keywords--input"]`).first();
  await kw.click();
  await kw.fill(searchTerm);
  await kw.press('Enter');
  await DELAY(1200);
  const view = await _find(page, `${M} button`, /^view( \d+)? results$/);
  if (view) await page.locator(view).first().click();
  else await page.keyboard.press('Escape').catch(() => {});
  await DELAY(5000);
  for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {}); await DELAY(1200); }

  const jobs = await page.evaluate((lim) => {
    const out = []; const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/jobs\/(\d+)-[\w-]*/);
      if (!m || seen.has(m[1])) continue;
      const title = ((a.querySelector('span') || a).innerText || '').trim().split('\n')[0];
      if (!title) continue;
      seen.add(m[1]);
      let card = a; for (let k = 0; k < 6 && card && !/apply on/i.test(card.innerText || ''); k++) card = card.parentElement;
      let block = a, company = '';
      for (let k = 0; k < 16 && block; k++, block = block.parentElement) {
        const c = block.querySelector('a[href^="/company/"]');
        if (c) { company = (c.innerText || '').trim().split('\n')[0]; break; }
      }
      const spans = [...a.querySelectorAll('span')].map(x => (x.innerText || '').trim()).filter(Boolean);
      out.push({
        jobId: 'wellfound_' + m[1], jobKey: m[1], title, company,
        url: location.origin + m[0],
        external: /apply on company/i.test((card && card.innerText) || ''),
        remoteText: spans.slice(1).join(' | '),
      });
      if (out.length >= lim) break;
    }
    return out;
  }, limit).catch(() => []);
  for (const j of jobs) j.workType = workTypeOf(j.remoteText);
  console.log(`  [Wellfound] Found ${jobs.length} jobs for "${searchTerm}"`);
  return jobs;
}

// ── Job description ────────────────────────────────────────────────────────
async function getJobDescription(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(4000);
  await waitForHuman(page);
  await dismissPopups(page);
  const d = await page.evaluate(() => {
    const desc = document.querySelector('[class*="styles_description"]');
    // Page title: "Title at Company • Location • ..."
    const tm = (document.title || '').match(/ at (.+?) •/);
    const vis = [...document.querySelectorAll('button, a')].filter(b => b.offsetParent !== null && !b.closest('nav, aside, header')).map(b => (b.innerText || '').trim());
    return {
      description: desc ? desc.innerText.trim() : (document.querySelector('main') || document.body).innerText.trim().slice(0, 8000),
      company: tm ? tm[1].trim() : '',
      alreadyApplied: vis.some(t => /^applied$/i.test(t)),
      salaryText: [...document.querySelectorAll('span, div')].map(e => e.children.length ? '' : (e.innerText || '').trim()).find(t => /^\$\d/.test(t)) || '',
    };
  }).catch(() => ({ description: '', company: '', alreadyApplied: false, salaryText: '' }));
  console.log(`  [Wellfound] JD: ${d.description.length} chars`);
  return { ...job, company: job.company || d.company, description: d.description, alreadyApplied: d.alreadyApplied, salaryText: d.salaryText };
}

// ── Apply ──────────────────────────────────────────────────────────────────
// Marks the first visible element (css) whose text matches `re` and returns a selector for it.
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

// Puts this job's tailored resume on the user's Wellfound profile (Wellfound sends that one).
async function uploadResume(page, resumePath) {
  const name = path.basename(resumePath);
  try {
    await page.goto(`${BASE}/profile/edit/resume`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await DELAY(4000);
    await dismissPopups(page);
    const shown = () => page.evaluate(n => (document.body.innerText || '').includes(n), name).catch(() => false);
    if (await shown()) { console.log(`  [Wellfound] Resume: ${name} (already on profile)`); return true; }
    const input = page.locator('input[type="file"]').first();
    if (!(await input.count())) { console.log('  [Wellfound] Resume upload box not found'); return false; }
    await input.setInputFiles(resumePath);
    for (let i = 0; i < 20; i++) {
      await DELAY(1000);
      if (await shown()) { console.log(`  [Wellfound] Resume: ${name} (tailored, uploaded to profile)`); return true; }
    }
    await page.screenshot({ path: path.join(SSDIR, 'wellfound_resume.png'), fullPage: true }).catch(() => {});
    console.log('  [Wellfound] Resume upload not confirmed');
    return false;
  } catch (e) {
    console.log(`  [Wellfound] Resume upload failed: ${e.message}`);
    return false;
  }
}

// Returns true (applied), false (couldn't finish) or null (already applied).
// Throws "Wellfound: ..." for jobs that can't be applied for here (skip, don't retry).
async function applyToJob(page, job, resumePath, coverLetter) {
  console.log(`  [Wellfound] Applying: ${job.title} @ ${job.company}`);
  // Never send the base resume when a tailored one was made for this job.
  if (resumePath && !(await uploadResume(page, resumePath))) {
    console.log('  [Wellfound] Tailored resume not on profile, not applying.');
    return false;
  }

  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await DELAY(5000);
  await waitForHuman(page);
  if (!(await wellfoundSignedIn(page))) throw new Error('Wellfound: signed out, please sign in again');
  await dismissPopups(page);

  const state = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('button, a')].filter(b => b.offsetParent !== null && !b.closest('nav, aside, header')).map(b => (b.innerText || '').trim());
    return { applied: vis.some(t => /^applied$|^application sent$/i.test(t)), canApply: vis.some(t => /^apply$|^apply now$/i.test(t)), external: vis.some(t => /apply on company (website|site)/i.test(t)) };
  }).catch(() => ({}));
  if (state.applied) { console.log('  [Wellfound] Already applied, skipping.'); return null; }
  if (state.external && !state.canApply) throw new Error('Wellfound: external apply (company website)');
  const applyBtn = await _find(page, 'button', /^apply$|^apply now$/);
  if (!applyBtn) throw new Error('Wellfound: no apply button');
  await page.locator(applyBtn).first().click({ timeout: 15000 });

  let modal = '';
  for (let i = 0; i < 15; i++) {
    await DELAY(1000);
    modal = await page.evaluate(m => { const d = document.querySelector(m); return d ? d.innerText : ''; }, MODAL).catch(() => '');
    if (/send application/i.test(modal)) break;
  }
  if (!/send application/i.test(modal)) {
    // Some jobs only say so here: "Applications to this job are managed outside of Wellfound".
    if (/managed outside of wellfound|apply on (company )?website|apply on company/i.test(modal)) throw new Error('Wellfound: external apply (company website)');
    await page.screenshot({ path: path.join(SSDIR, 'wellfound_no_form.png'), fullPage: true }).catch(() => {});
    console.log('  [Wellfound] Apply form did not open.');
    return false;
  }
  // Wellfound blocks the form when the profile is missing something, or the job doesn't take
  // applicants from the user's location. Those need the user, not a retry.
  const block = modal.match(/you cannot apply[^\n]*(\n[^\n]+){0,3}|not accept(ing)? applic[^\n]*|primary location is too broad[^\n]*/i);
  if (block) throw new Error('Wellfound: cannot apply here, ' + block[0].replace(/\s+/g, ' ').slice(0, 160));

  await _answerQuestions(page, job, coverLetter);

  const send = await _find(page, `${MODAL} button`, /^send application$/);
  if (!send) { console.log('  [Wellfound] No Send application button.'); return false; }
  // Wellfound greys the button out while a required answer is missing.
  if (await page.locator(send).first().isDisabled().catch(() => false)) {
    await page.screenshot({ path: path.join(SSDIR, 'wellfound_incomplete.png'), fullPage: true }).catch(() => {});
    console.log('  [Wellfound] A required question is still empty, not sending.');
    return false;
  }
  if (process.env.JOBBOT_NO_SUBMIT === '1') { console.log('  [Wellfound] TEST MODE: reached Send application, not pressing it'); return true; }
  await page.locator(send).first().click();

  // Success: the form closes and the job shows as applied. Turnstile may run first.
  let human = false;
  for (let i = 0; i < 45; i++) {
    await DELAY(1000);
    const st = await page.evaluate(m => {
      const d = document.querySelector(m);
      const txt = document.body.innerText || '';
      const ts = [...document.querySelectorAll('iframe')].some(f => /challenges\.cloudflare\.com/.test(f.src) && f.getBoundingClientRect().height > 20);
      return { open: !!(d && /send application/i.test(d.innerText)), ok: /application (has been |was )?(sent|submitted)|you applied|applied\b.*ago|successfully applied/i.test(txt), ts,
        err: d ? [...d.querySelectorAll('[role="alert"], [class*="error" i]')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 3) : [] };
    }, MODAL).catch(() => ({}));
    if (st.ts) human = true;
    if (st.ok || (!st.open && i > 2)) {
      const applied = await page.evaluate(() => [...document.querySelectorAll('button, span')].some(b => b.offsetParent !== null && !b.closest('nav, aside, header') && /^applied$/i.test((b.innerText || '').trim()))).catch(() => false);
      if (st.ok || applied) { console.log('  [Wellfound] Application sent.'); return true; }
    }
    if (st.err && st.err.length && i > 3) { console.log(`  [Wellfound] Form says: ${st.err.join(' | ')}`); break; }
  }
  await page.screenshot({ path: path.join(SSDIR, 'wellfound_after_send.png'), fullPage: true }).catch(() => {});
  console.log(human ? '  [Wellfound] Wellfound asked for a human check and it did not pass.' : '  [Wellfound] Send pressed but no confirmation seen.');
  return false;
}

// The form's fields: a cover letter box and the employer's own questions.
async function _answerQuestions(page, job, coverLetter) {
  const qs = await page.evaluate((M) => {
    const root = document.querySelector(M); if (!root) return [];
    const qText = el => {
      if (el.labels && el.labels[0] && el.type !== 'radio') return el.labels[0].innerText.trim();
      // Wellfound wraps each field in a <label for="form-input--undefined">, so el.labels is empty.
      const wl = el.type !== 'radio' && el.closest('label');
      if (wl && (wl.innerText || '').trim()) return wl.innerText.replace(/\*\s*$/, '').trim();
      const fs = el.closest('fieldset'); const lg = fs && fs.querySelector('legend');
      if (lg) return lg.innerText.trim();
      let n = el.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        const t = [...n.querySelectorAll('label, p, span, div, h3, h4')].find(x => x.children.length === 0 && (x.innerText || '').trim().length > 4 && !x.contains(el) && !(x.closest('label') && x.closest('label').contains(el)));
        if (t) return t.innerText.trim();
      }
      return el.getAttribute('aria-label') || el.placeholder || el.name || '';
    };
    const out = []; let k = 0; const radios = {};
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (['hidden', 'file', 'submit', 'button', 'search', 'checkbox'].includes(el.type)) continue;
      if (el.offsetParent === null && !(el.type === 'radio' && el.closest('label'))) continue;
      if (/turnstile/i.test(el.name || '')) continue;
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
        out.push({ kind: el.tagName === 'TEXTAREA' ? 'textarea' : (el.type === 'number' ? 'number' : 'text'), q: qText(el), id: el.dataset.jbq, name: el.name || '' });
      }
    }
    for (const r of Object.values(radios)) if (!r.done) out.push(r);
    return out;
  }, MODAL).catch(() => []);

  for (const f of qs) {
    try {
      if (f.kind === 'radio' || f.kind === 'select') {
        let pick = await ai.aiPickOption({ question: f.q, options: f.opts, job, kind: f.kind });
        if (!pick) pick = f.opts.find(o => /^yes\b/i.test(o.text)) || f.opts[0];
        if (!pick) continue;
        if (f.kind === 'radio') await page.evaluate(id => { const i = document.querySelector(`[data-jbq="${id}"]`); if (i) (i.closest('label') || i).click(); }, pick.id);
        else await page.locator(`[data-jbq="${f.id}"]`).selectOption(pick.value);
        console.log(`  [Wellfound] Q: ${f.q.slice(0, 70)} -> ${pick.text}`);
        continue;
      }
      // The general cover letter box (not an employer question) takes the Scorer's letter.
      const isCover = f.kind === 'textarea' && !/customQuestion/i.test(f.name) && /cover letter|note to|message/i.test(f.q + ' ' + f.name);
      // Long answers ("What interests you about this company?") need the advert, or the AI guesses.
      const context = f.kind === 'textarea' ? (job.description || '') : '';
      let ans = isCover && coverLetter ? coverLetter : await ai.aiTextAnswer({ question: isCover ? 'Write a short cover note for this application' : f.q, job, long: f.kind === 'textarea', context });
      if (f.kind === 'number') ans = (String(ans || '').match(/\d+/) || [''])[0];
      if (!ans) continue;
      await page.locator(`[data-jbq="${f.id}"]`).fill(String(ans).slice(0, 4000));
      console.log(`  [Wellfound] ${isCover ? 'Cover letter' : 'Q: ' + f.q.slice(0, 70)} -> ${String(ans).replace(/\s+/g, ' ').slice(0, 60)}`);
      await DELAY(400);
    } catch (e) { console.log(`  [Wellfound] Could not answer "${(f.q || '').slice(0, 50)}": ${e.message}`); }
  }
}

module.exports = { ensureLoggedIn, wellfoundSignedIn, searchJobs, getJobDescription, applyToJob, uploadResume, waitForHuman, workTypeOf, SSDIR };
