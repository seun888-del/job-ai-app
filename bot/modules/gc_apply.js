/**
 * gc_apply.js: fills in and submits a GC Jobs (Government of Canada) application in the
 * agent's own signed-in browser (Playwright page). Shared rules:
 *
 *  - GC Jobs ends the session ("Lost Connection") on browser back/forward, on a second session,
 *    and after 60 minutes idle. So after opening the job poster, every move is a click on the
 *    site's own links and buttons. Never page.goBack().
 *  - The application is a checklist page with sections. Each section has its own save button.
 *  - Answers must be true: the applicant confirms a fraud notice. Screening questions are
 *    answered Yes only when the CV shows the experience, with the organization, title, dates
 *    and examples taken from the CV. Anything the CV can't back is answered No.
 *  - "Submit application" submits at once when every section is complete. It is only clicked
 *    when the caller passes submit: true.
 */
const { llmChat } = require('../../src/services/llm');
const { BASE } = require('./gc_jobs');

const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));
const LOST = /Lost Connection|Connection interrupted/i;

async function bodyText(page) { return page.evaluate(() => (document.querySelector('main') || document.body).innerText).catch(() => ''); }

async function isSignedIn(page) {
  return page.evaluate(() => !!([...document.querySelectorAll('a,input[type=submit],button')].find((e) => /^\s*(Logout|Log out|Sign out)\s*$/i.test(e.textContent || e.value || '')))
    && !document.querySelector('input[type=password]')).catch(() => false);
}

// Open the GC Jobs login page and wait (up to 5 minutes) for the user to sign in.
async function ensureLogin(page, log = console.log) {
  try { await page.goto(`${BASE}/page1710?toggleLanguage=en`, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (_) {}
  await DELAY(1500);
  if (await isSignedIn(page)) { log('  [GC Jobs] ✓ Signed in.'); return true; }
  log('  [GC Jobs] Sign in to your GC Jobs account in the browser window that opened (waiting up to 5 minutes).');
  const end = Date.now() + 5 * 60 * 1000;
  while (Date.now() < end) {
    await DELAY(4000);
    if (await isSignedIn(page)) { log('  [GC Jobs] ✓ Signed in. The session is saved for next time.'); return true; }
  }
  log('  [GC Jobs] Sign-in timed out. Start the agent again once you are signed in.');
  return false;
}

// The section links of ONE application on the checklist page, found by its reference number
// (each link's hidden text names the job and its reference). State comes from the icon.
async function sections(page, ref) {
  // The checklist can still be loading after a save: wait for it, then read (retry once).
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    const s = await readSections(page, ref);
    if (s.length) return s;
    await DELAY(2000);
  }
  return [];
}
async function readSections(page, ref) {
  return page.evaluate((ref) => {
    const out = [];
    // Each section link's title reads "<Section> for <job title> <reference> <state>", and its
    // icon's alt is the state: "Completed", "To be completed" or "Optional".
    for (const a of document.querySelectorAll('main a[title]')) {
      const full = (a.getAttribute('title') || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      if (!full.includes(ref) || !/ for /.test(full)) continue;
      const name = (a.innerText || '').replace(/\s+/g, ' ').trim() || full.split(' for ')[0];
      const alt = [...a.querySelectorAll('img')].map((i) => i.alt || '').join(' ').toLowerCase() || full.toLowerCase();
      const state = /optional/.test(alt) ? 'optional' : /to be completed/.test(alt) ? 'todo' : /completed/.test(alt) ? 'done' : 'unknown';
      out.push({ name, full, state });
    }
    return out;
  }, ref).catch(() => []);
}

// The link whose title starts with "<name> for" and names this job's reference.
async function linkFor(page, ref, name) {
  const idx = await page.evaluate(({ ref, name }) => [...document.querySelectorAll('main a')].findIndex((a) => {
    const t = (a.getAttribute('title') || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    return t.includes(ref) && t.toLowerCase().startsWith(name.toLowerCase());
  }), { ref, name }).catch(() => -1);
  return idx < 0 ? null : page.locator('main a').nth(idx);
}

async function clickSection(page, ref, name) {
  const loc = await linkFor(page, ref, name);
  if (!loc) return false;
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), loc.click()]);
  await DELAY(1500);
  return true;
}

// Click a save/submit-type button by its visible value or text.
async function clickButton(page, re) {
  const btn = page.locator('main input[type=submit], main button');
  const n = await btn.count();
  for (let i = 0; i < n; i++) {
    const b = btn.nth(i);
    const v = `${(await b.getAttribute('value').catch(() => '')) || ''} ${(await b.textContent().catch(() => '')) || ''}`.trim();
    if (re.test(v) && await b.isVisible().catch(() => false)) {
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), b.click()]);
      await DELAY(1500);
      return v;
    }
  }
  return null;
}

async function pageErrors(page) {
  return page.evaluate(() => [...document.querySelectorAll('main .alert-danger, main .error, main [class*=error], main .label-danger')]
    .map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 400).slice(0, 5)).catch(() => []);
}

// ── Screening questions ─────────────────────────────────────────────────────
async function readScreening(page) {
  return page.evaluate(() => {
    const qs = [];
    const sels = [...document.querySelectorAll('main select')];
    for (const s of sels) {
      const lab = (s.id && document.querySelector(`label[for="${s.id}"]`)) || s.closest('fieldset, .form-group, div');
      const question = (lab ? lab.innerText : '').replace(/Please Specify|Yes\s*No\s*$/g, '').replace(/\s+/g, ' ').trim();
      // The detail box that follows this select (before the next select).
      let ta = null;
      const all = [...document.querySelectorAll('main select, main textarea')];
      for (let i = all.indexOf(s) + 1; i < all.length; i++) { if (all[i].tagName === 'SELECT') break; if (all[i].tagName === 'TEXTAREA') { ta = all[i]; break; } }
      const taLab = ta && ta.id ? document.querySelector(`label[for="${ta.id}"]`) : null;
      qs.push({ selName: s.name, selId: s.id, options: [...s.options].map((o) => o.text.trim()).filter(Boolean), question: question.slice(0, 1500),
        detailName: ta ? ta.name : '', detailId: ta ? ta.id : '', detailAsk: taLab ? taLab.innerText.replace(/\s+/g, ' ').trim().slice(0, 600) : '' });
    }
    return qs;
  }).catch(() => []);
}

function parseJson(s) {
  const t = String(s || ''); const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

// One AI call for all the screening questions of a job.
async function answerScreening(qs, { cvText, job, prefs }) {
  const prompt = `You are filling in a Government of Canada job application (GC Jobs) for the applicant below. The applicant confirms that every answer is TRUE and may be checked; false answers can lead to a criminal investigation. So answer ONLY from the CV and the applicant facts.

JOB: ${job.title} at ${job.company || ''}

APPLICANT FACTS:
- Lives in: ${prefs.location || 'not given'}. Willing to relocate: ${prefs.relocate ? 'yes' : 'no'}. Cities they want: ${(prefs.cities || []).join(', ') || 'not given'}.
- First official language: ${prefs.firstLang || 'English'}. English level: ${prefs.englishLevel || 'Advanced'}. French level: ${prefs.frenchLevel || 'None'}. Has valid Second Language Evaluation (SLE) results: ${prefs.hasSle ? 'yes' : 'no'}.
- Has applied to this same process before: no record.

CV (the only source for experience and education):
${String(cvText || '').slice(0, 14000)}

QUESTIONS:
${qs.map((q, i) => `${i + 1}. ${q.question}\n   Options: ${q.options.join(' | ')}${q.detailAsk ? `\n   If yes, the detail box asks: ${q.detailAsk}` : ''}`).join('\n')}

Return ONLY a JSON array, one item per question:
[{"n": 1, "answer": "the exact option text", "detail": "text for the detail box, or empty"}]

Rules:
- Experience or education questions: answer Yes ONLY if the CV clearly shows it. Then write the detail in first person from the CV only: the organization's name, the job title, the dates and how long, and 2 to 4 specific tasks or results that show the experience, as the detail box asks. 80 to 250 words. Never invent employers, dates, numbers or tasks. If the CV does not show it, answer No and leave detail empty.
- "Do you wish to be considered for positions in <city>": Yes if that city is one they want or they live there or nearby, or they are willing to relocate; otherwise No.
- Language questions: English essential = Yes if their English is Intermediate or Advanced. Bilingual or French positions = Yes only if their French is Advanced and they have SLE results.
- Armed Forces, veteran, Indigenous or other personal status questions: Yes only if the CV says so, otherwise No.
- "Have you applied before / been in a pool" questions: No.
- Confirmation questions about their own application (e.g. "I correctly identified my first official language"): Yes.
- Questions that ask for a reference or process number they would only know themselves: No.
- If unsure, choose No. Never choose an option that is not listed.`;
  let arr = parseJson(await llmChat(prompt).catch(() => ''));
  if (!Array.isArray(arr)) arr = parseJson(await llmChat(prompt).catch(() => ''));
  return Array.isArray(arr) ? arr : null;
}

async function fillScreening(page, ctx, log) {
  const qs = await readScreening(page);
  if (!qs.length) return { ok: true, note: 'no questions' };
  const ans = await answerScreening(qs, ctx);
  if (!ans) return { ok: false, note: 'Could not answer the screening questions (AI unavailable).' };
  const byN = new Map(ans.map((a) => [Number(a.n), a]));
  let essentialNo = 0;
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i], a = byN.get(i + 1) || {};
    const opt = q.options.find((o) => o.toLowerCase() === String(a.answer || '').trim().toLowerCase()) || q.options.find((o) => /^no$/i.test(o));
    if (!opt) continue;
    const sel = q.selId ? page.locator(`[id="${q.selId}"]`) : page.locator(`select[name="${q.selName}"]`);
    await sel.selectOption({ label: opt }).catch(() => {});
    const yes = /^yes/i.test(opt);
    if (q.detailName || q.detailId) {
      const ta = q.detailId ? page.locator(`[id="${q.detailId}"]`) : page.locator(`textarea[name="${q.detailName}"]`);
      await ta.fill(yes ? String(a.detail || '').trim().slice(0, 9000) : '').catch(() => {});
    }
    if (!yes && /^(EX|ED|EDU|E\d|experience|education)|do you (have|meet)/i.test(q.question) && !/asset|AEX|armed forces|applied for/i.test(q.question)) essentialNo++;
    log(`    Q${i + 1}: ${opt}${yes && a.detail ? ' (with details from your CV)' : ''}  ${q.question.slice(0, 80)}`);
  }
  const saved = await clickButton(page, /save as complete|^save$|save/i);
  const errs = await pageErrors(page);
  return { ok: !!saved && !errs.length, essentialNo, note: errs.join(' ') };
}

// ── The other sections ──────────────────────────────────────────────────────
// The notice: a new application shows an "affirm" checkbox + Continue; an existing one an
// "I confirm" button. Only reached when the user confirmed the notice in Job-AI.
async function fillNotice(page) {
  const affirm = page.locator('main input[name="affirm"]');
  if (await affirm.count()) {
    await affirm.first().check().catch(() => {});
    return { ok: !!(await clickButton(page, /^\s*Continue\s*$/i)) };
  }
  return { ok: !!(await clickButton(page, /I confirm/i)) };
}

async function fillResume(page, ctx) {
  const ta = page.locator('main textarea[name="resumeText"], main textarea').first();
  if (!(await ta.count())) return { ok: false, note: 'No resume box found' };
  await ta.fill(String(ctx.resumeText || ctx.cvText || '').replace(/\r/g, '').slice(0, 30000));
  const saved = await clickButton(page, /save as complete/i) || await clickButton(page, /save/i);
  return { ok: !!saved && !(await pageErrors(page)).length };
}

async function tickAll(page, selector) {
  const boxes = page.locator(selector);
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check().catch(() => {});
  return n;
}

async function fillWorkLocations(page, ctx) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('main input[type=checkbox]')].map((c) => ({ id: c.id, name: c.name, label: ((c.id && document.querySelector(`label[for="${c.id}"]`)) || c.parentElement || {}).innerText || '' }))).catch(() => []);
  const want = (ctx.prefs.cities || []).map((c) => c.toLowerCase().trim()).filter(Boolean);
  const home = String(ctx.prefs.location || '').split(',')[0].toLowerCase().trim();
  let ticked = 0;
  for (const b of boxes) {
    const l = b.label.toLowerCase();
    const ok = ctx.prefs.relocate || boxes.length === 1 || (home && l.includes(home)) || want.some((w) => l.includes(w));
    if (!ok) continue;
    const loc = b.id ? page.locator(`[id="${b.id}"]`) : page.locator(`input[name="${b.name}"]`).first();
    await loc.check().catch(() => {}); ticked++;
  }
  if (!ticked) return { ok: false, noLocation: true, note: 'None of the job locations is one you chose.' };
  const saved = await clickButton(page, /save as complete|^save$|save/i);
  return { ok: !!saved && !(await pageErrors(page)).length };
}

async function fillTickAllSection(page, selector) {
  const n = await tickAll(page, selector);
  if (!n) return { ok: false, note: 'Nothing to tick' };
  const saved = await clickButton(page, /save as complete|^save$|save/i);
  return { ok: !!saved && !(await pageErrors(page)).length };
}

async function fillLanguages(page, ctx) {
  const p = ctx.prefs; const first = p.firstLang === 'French' ? 'French' : 'English';
  const pick = async (name, value) => {
    const r = page.locator(`main input[type=radio][name="${name}"]`);
    const n = await r.count();
    for (let i = 0; i < n; i++) {
      const id = await r.nth(i).getAttribute('id');
      const lab = id ? await page.locator(`label[for="${id}"]`).innerText().catch(() => '') : '';
      const v = `${lab} ${(await r.nth(i).getAttribute('value')) || ''}`;
      if (new RegExp(`\\b${value}\\b`, 'i').test(v)) { await r.nth(i).check().catch(() => {}); return true; }
    }
    return false;
  };
  await pick('selectedFirstOfficialLang', first);
  await pick('selectedOfficialLangSkillEnglish', p.englishLevel || (first === 'English' ? 'Advanced' : 'Intermediate'));
  await pick('selectedOfficialLangSkillFrench', p.frenchLevel || 'None');
  for (const n of ['selectedCorrespondenceLang', 'selectedInterviewLang', 'selectedWrittenExamLang']) await pick(n, first);
  const saved = await clickButton(page, /save as complete|^save$|save/i);
  return { ok: !!saved && !(await pageErrors(page)).length };
}

// Education is kept on the account: one entry fills every application. If there is none yet,
// add the highest qualification from the CV: pick the level, press Add, then fill the form GC
// Jobs shows for it (academic level, area of study, institution, dates) from the CV.
async function readFields(page) {
  return page.evaluate(() => [...document.querySelectorAll('main select, main input[type=text], main textarea')].filter((e) => e.name).map((e) => {
    const l = e.id && document.querySelector(`label[for="${e.id}"]`);
    return { name: e.name, tag: e.tagName, label: (l ? l.innerText : e.name).replace(/\s+/g, ' ').trim().slice(0, 80),
      options: e.tagName === 'SELECT' ? [...e.options].map((o) => o.text.trim()).filter((t) => t && !/^Please Specify$/i.test(t)) : null };
  })).catch(() => []);
}

// Labels of the checkboxes on the page (GC Jobs puts them in the same row as the box).
async function readChecks(page, name) {
  return page.evaluate((name) => [...document.querySelectorAll(`main input[type=checkbox][name="${name}"]`)].map((c) => {
    const l = (c.id && document.querySelector(`label[for="${c.id}"]`)) || c.closest('label, tr, li') || c.parentElement;
    return { value: c.value, label: (l ? l.innerText : '').replace(/\s+/g, ' ').trim() };
  }), name).catch(() => []);
}

async function aiPick(question, options, cvText, max = 2) {
  const r = parseJson(await llmChat(`${question}\nOptions: ${JSON.stringify(options)}\nAnswer with ONLY a JSON array of up to ${max} exact option texts that match the CV (best first), or [] if none fit.\n\nCV:\n${String(cvText || '').slice(0, 14000)}`).catch(() => ''));
  return Array.isArray(r) ? r.filter((x) => options.includes(x)).slice(0, max) : [];
}

// GC Jobs Education is a short flow: (1) list page: pick the level, Add; (2) details form,
// Continue; (3) review + specialization groups, Continue; (4) specializations, Save; (5) list
// page with the entry, SAVE. Each page is recognised by its fields, filled from the CV.
async function fillEducation(page, ctx, log) {
  let assumed = '', level = null, added = false;
  for (let step = 0; step < 8; step++) {
    const t = (await bodyText(page)).replace(/\s+/g, ' ');
    const fields = await readFields(page);
    const names = fields.map((f) => f.name);
    if (names.includes('school')) {
      // List page. An entry exists (no "None" row): save the section.
      if (!/Action None\b/.test(t)) {
        const saved = await clickButton(page, /^\s*SAVE\s*$/i);
        const errs = await pageErrors(page);
        if (assumed) log(`    Education note: ${assumed}`);
        return { ok: !!saved && !errs.length, note: errs.join(' '), assumed };
      }
      if (added) return { ok: false, needsUser: true, note: 'Education was not saved. Add it once on GC Jobs.' };
      const levels = (fields.find((f) => f.name === 'school').options || []);
      level = (await aiPick("What is this person's highest completed (or in progress) level of education?", levels, ctx.cvText, 1))[0];
      if (!level) return { ok: false, needsUser: true, note: 'Your CV shows no education. Add it once on GC Jobs (Education section).' };
      await page.selectOption('main select[name="school"]', { label: level });
      await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator('main input[name="add"]').click()]);
      await DELAY(2000); added = true;
      continue;
    }
    const groups = await readChecks(page, 'specializationGroup');
    if (groups.length) {
      const picks = await aiPick('Which specialization group(s) cover the subject of this person\'s highest qualification?', groups.map((g) => g.label), ctx.cvText, 2);
      for (const g of groups.filter((x) => picks.includes(x.label))) await page.locator(`main input[name="specializationGroup"][value="${g.value}"]`).check().catch(() => {});
      if (!picks.length) await page.locator('main input[name="specializationGroup"]').first().check().catch(() => {});
      await clickButton(page, /^\s*Continue\s*$/i);
      continue;
    }
    const specs = await readChecks(page, 'specialization');
    if (specs.length) {
      const picks = await aiPick('Which specialization(s) match the subject of this person\'s highest qualification?', specs.map((s) => s.label).filter(Boolean), ctx.cvText, 2);
      const chosen = specs.filter((x) => picks.includes(x.label));
      if (!chosen.length) { await clickButton(page, /^\s*Back\s*$/i); continue; }
      for (const s of chosen) await page.locator(`main input[name="specialization"][value="${s.value}"]`).check().catch(() => {});
      await clickButton(page, /^\s*Save\s*$/i);
      continue;
    }
    const ask = fields.filter((f) => f.options || (f.label && f.label !== f.name && !/filter/i.test(f.label)));
    if (ask.length) {
      const prompt = `Fill in this Government of Canada education form for the applicant, ONLY from the CV. Education level: ${level || 'see CV'}.
FIELDS:
${ask.map((f) => `- ${f.name} (${f.label})${f.options ? ': choose one of ' + JSON.stringify(f.options.slice(0, 200)) : ''}`).join('\n')}

CV:
${String(ctx.cvText || '').slice(0, 14000)}

Return ONLY a JSON array: [{"name": "field name", "value": "exact option text or the value"}, ...] plus {"name": "_assumed", "value": "anything you had to assume, or empty"}.
Rules: exact option texts. Institution: the school in the CV if listed; a school outside Canada = "Other university outside Canada" or "Other post-secondary institution (outside Canada)"; a Canadian school not listed = the matching "Other ..." option. Year = 4 digits. Years completed and program length are whole numbers (a 3-year degree = 3). Only if the CV gives no month, use June and say so in _assumed. Never invent a qualification.`;
      const vals = parseJson(await llmChat(prompt).catch(() => ''));
      if (!Array.isArray(vals)) return { ok: false, needsUser: true, note: 'Could not read your education from the CV. Add it once on GC Jobs.' };
      for (const v of vals) {
        if (v.name === '_assumed') { if (v.value && !/^no|none|empty/i.test(String(v.value))) assumed = String(v.value); continue; }
        const f = fields.find((x) => x.name === v.name);
        if (!f || v.value == null || v.value === '') continue;
        const loc = page.locator(`main [name="${f.name}"]`).first();
        if (f.tag === 'SELECT') await loc.selectOption({ label: String(v.value) }).catch(() => {});
        else await loc.fill(String(v.value)).catch(() => {});
      }
      await DELAY(800);
    }
    // Details form or review page: move on.
    if (!(await clickButton(page, /^\s*Continue\s*$/i))) return { ok: false, needsUser: true, note: 'Education: unexpected page on GC Jobs.' };
    const errs = await pageErrors(page);
    if (errs.length) return { ok: false, needsUser: true, note: `Education: ${errs.join(' ')}` };
  }
  return { ok: false, needsUser: true, note: 'Education: took too many steps. Add it once on GC Jobs.' };
}

/**
 * Apply to one GC Jobs poster. opts: { job:{poster,title,company,ref}, cvText, resumeText, prefs, submit, log }
 * Returns { result: 'applied'|'ready'|'needs_user'|'not_eligible'|'needs_login'|'closed'|'external'|'failed', note }
 */
async function applyToJob(page, opts) {
  const { job, submit = false, log = console.log } = opts;
  const ctx = { cvText: opts.cvText, resumeText: opts.resumeText, prefs: opts.prefs || {}, job };
  const posterUrl = `${BASE}/page1800?poster=${encodeURIComponent(job.poster)}&toggleLanguage=en`;
  // GC Jobs can be slow: one retry before giving up on this job for now.
  try { await page.goto(posterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (_) { await DELAY(5000); await page.goto(posterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  await DELAY(1500);
  let t = await bodyText(page);
  if (LOST.test(t)) return { result: 'needs_login', note: 'GC Jobs session ended' };
  if (/You will leave the GC Jobs Web site/i.test(t)) return { result: 'external', note: 'Applied for on the organization\'s own website' };
  if (!(await isSignedIn(page))) return { result: 'needs_login', note: 'Not signed in to GC Jobs' };
  const ref = job.ref || (t.match(/Reference number\s+([A-Z0-9-]{8,})/) || [])[1];
  if (!ref) return { result: 'failed', note: 'Could not read the reference number' };
  const apply = page.locator('main a').filter({ hasText: /^\s*Apply\s*$/ });
  if (!(await apply.count())) return { result: 'closed', note: /closed|no longer/i.test(t) ? 'Closed' : 'No Apply button (closed or not open to you)' };
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), apply.first().click()]);
  await DELAY(2000);
  t = await bodyText(page);
  if (LOST.test(t)) return { result: 'needs_login', note: 'GC Jobs session ended' };
  // A new application starts on the notice page: confirm it, then the checklist opens.
  if (await page.locator('main input[name="affirm"]').count()) {
    log('  [GC Jobs] Notice...');
    if (!(await fillNotice(page)).ok) return { result: 'failed', note: 'Could not confirm the notice' };
    await page.waitForLoadState('load').catch(() => {});
    t = await bodyText(page);
  }
  if (new RegExp(`Submitted job applications[\\s\\S]*${ref}`).test(t) && !new RegExp(`In progress job applications[\\s\\S]*${ref}[\\s\\S]*Submitted job applications`).test(t)) {
    return { result: 'applied', note: 'Already submitted on GC Jobs' };
  }

  const ORDER = ['Notice', 'Résumé', 'Screening questions', 'Work locations', 'Employment tenure', 'Classification', 'Education', 'Languages'];
  const notes = []; let needsUser = false, essentialNo = 0, noLocation = false;
  for (const name of ORDER) {
    const secs = await sections(page, ref);
    const s = secs.find((x) => x.name.toLowerCase().startsWith(name.toLowerCase()) || x.full.toLowerCase().startsWith(name.toLowerCase()));
    if (!s) continue;                       // this job doesn't have that section
    if (s.state === 'done' || s.state === 'optional') continue;
    log(`  [GC Jobs] ${name}...`);
    if (!(await clickSection(page, ref, name))) { notes.push(`${name}: link not found`); continue; }
    if (LOST.test(await bodyText(page))) return { result: 'needs_login', note: 'GC Jobs session ended' };
    let r;
    try {
      if (name === 'Notice') r = await fillNotice(page);
      else if (name === 'Résumé') r = await fillResume(page, ctx);
      else if (name === 'Screening questions') r = await fillScreening(page, ctx, log);
      else if (name === 'Work locations') r = await fillWorkLocations(page, ctx);
      else if (name === 'Employment tenure') r = await fillTickAllSection(page, 'main input[type=checkbox][name="jobType"]');
      else if (name === 'Classification') r = await fillTickAllSection(page, 'main input[type=checkbox][name="classification"]');
      else if (name === 'Languages') r = await fillLanguages(page, ctx);
      else if (name === 'Education') r = await fillEducation(page, ctx, log);
    } catch (e) { r = { ok: false, note: e.message }; }
    if (r && r.essentialNo) essentialNo += r.essentialNo;
    if (r && r.noLocation) noLocation = true;
    if (r && r.needsUser) needsUser = true;
    if (r && !r.ok) notes.push(`${name}: ${r.note || 'not saved'}`);
    if (r && r.assumed) notes.push(`Education: ${r.assumed}`);
    // Back on the checklist (save buttons return there). If not, use the page's own Back button.
    if (!/In progress job applications/i.test(await bodyText(page))) await clickButton(page, /^\s*Back\s*$/i);
  }
  if (noLocation) return { result: 'not_eligible', note: 'None of the job locations is one you chose.' };

  const finalSecs = await sections(page, ref);
  // Never call it complete without seeing the checklist.
  if (!finalSecs.length) return { result: 'failed', note: ['Could not read the application checklist on GC Jobs.', ...notes].join(' ') };
  const left = finalSecs.filter((s) => s.state === 'todo' && !/^Submit/i.test(s.name));
  if (left.length || needsUser) {
    return { result: needsUser ? 'needs_user' : 'failed', note: [...notes, left.length ? `Still to do: ${left.map((s) => s.name).join(', ')}` : ''].filter(Boolean).join(' ') };
  }
  const extra = notes.filter((n) => /^Education: /.test(n)).join(' ');
  // Answered No to an essential qualification: GC Jobs would refuse it, so don't send it.
  if (essentialNo) return { result: 'not_eligible', note: `Your CV doesn't show ${essentialNo} of the essential qualifications, so it was not sent. The application is saved on GC Jobs.` };
  if (!submit) return { result: 'ready', note: `Every section complete. Submit it on GC Jobs.${extra ? ' ' + extra : ''}` };

  // Every section is complete: submit. GC Jobs refuses if the essential answers are No.
  const sub = await linkFor(page, ref, 'Submit application');
  if (!sub) return { result: 'failed', note: 'Submit link not found' };
  await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), sub.click()]);
  await DELAY(2500);
  t = await bodyText(page);
  const err = (t.match(/Error \d+:[^\n]+/) || [])[0];
  if (err) return { result: /mandatory requirements/i.test(err) ? 'not_eligible' : 'failed', note: err.replace(/^Error \d+:\s*/, '') + (essentialNo ? ' (your CV does not show some essential qualifications)' : '') };
  const submittedPart = t.split(/Submitted job applications/i)[1] || '';
  if (submittedPart.includes(ref)) return { result: 'applied', note: 'Submitted on GC Jobs' };
  return { result: 'failed', note: 'Submitted, but GC Jobs did not list it as submitted. Check My jobs on GC Jobs.' };
}

module.exports = { applyToJob, ensureLogin, isSignedIn, sections, answerScreening, readScreening };
