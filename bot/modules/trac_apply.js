/**
 * trac_apply.js
 * ─────────────────────────────────────────────────────────────────────────
 * Fills the NHS Trac application form using the field map (bot/specs/trac_form.json).
 * Trac is ONE system across trusts, but the form is a login-gated, multi-page
 * browser flow (advert pages are Cloudflare-blocked to plain HTTP), so this runs
 * against a Playwright page on a logged-in Trac session.
 *
 * SAFE BY DEFAULT: dry run (fills everything, never clicks the final submit) and
 * it NEVER auto-answers the sensitive/legal fields — criminal record, immigration
 * status, equality monitoring, disability, and the final declaration. Those are
 * flagged 'pause' so the agent surfaces them to the user to confirm. This protects
 * the applicant: false info on an NHS application is serious.
 *
 * Fields are matched by their LABEL text (not brittle input ids), so the same map
 * works across trusts even though ids differ. Selector/flow details are refined by
 * running it against a real Trac session.
 */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

// Decide how to answer a Trac field from its label + the applicant profile.
// Returns { action, value, sensitive }:
//   action 'fill'   → type/select `value`
//   action 'ai'     → generate via the tailoring/question engine (supporting statement etc.)
//   action 'pause'  → SENSITIVE/legal — leave for the user to confirm, never guess
//   action 'skip'   → we have no value; leave blank
function resolveAnswer(label, applicant = {}) {
  const l = norm(label);
  const A = applicant;
  const pause = (why) => ({ action: 'pause', reason: why, sensitive: true });
  const fill = (v) => ({ action: 'fill', value: v });

  // ── Sensitive / legal — always pause, never auto-answer ──────────────────
  if (/(unspent )?conviction|criminal|caution|rehabilitation of offenders|disclos/.test(l)) return pause('criminal record declaration');
  if (/immigration|right to work/.test(l)) return pause('immigration / right to work');
  if (/date of birth|ethnic|religion|belief|gender|sexual orientation|marital|disab|guaranteed interview/.test(l)) return pause('equality / disability monitoring');
  if (/i agree to the above declaration|declaration/.test(l)) return pause('final declaration');
  if (/dismissed|misconduct|capability|compromise|settlement agreement/.test(l)) return pause('disciplinary history (must be truthful)');

  // ── Straight-from-profile personal details ───────────────────────────────
  if (/forename|first name/.test(l)) return fill(A.firstName);
  if (/middle name/.test(l)) return fill(A.middleName);
  if (/surname|last name|family name/.test(l)) return fill(A.lastName);
  if (/email/.test(l)) return fill(A.email);
  if (/mobile/.test(l)) return fill(A.phone);
  if (/work telephone|home telephone|telephone/.test(l)) return { action: 'skip' };
  if (/postcode/.test(l)) { const m = String(A.address || A.location || '').match(UK_POSTCODE); return m ? fill(m[1]) : { action: 'skip' }; }
  if (/city|town/.test(l)) return fill(A.location || '');
  if (/county/.test(l)) return { action: 'skip' };
  if (/^address|address 1|street/.test(l)) return fill((A.address || '').replace(UK_POSTCODE, '').trim());
  if (/country/.test(l)) return fill(A.country || 'United Kingdom');
  if (/national insurance/.test(l)) return { action: 'skip' };
  if (/title\b/.test(l)) return { action: 'skip' };            // Mr/Mrs — not stored; let user set

  // ── Simple screeners we can answer from profile ──────────────────────────
  if (/full time or part time|full or part time/.test(l)) return fill((A.employmentType || []).includes('part_time') ? 'Part Time' : 'Full Time');
  if (/driving licence|drivers licence|driver.?s license/.test(l)) return fill(A.drivingLicence ? 'Yes' : 'No');
  if (/travel independently/.test(l)) return fill('Yes');
  if (/currently an employee of|currently work in the nhs/.test(l)) return fill('No');
  if (/armed forces/.test(l)) return fill('No');
  if (/at.?risk|redeploy|employment status/.test(l)) return fill('I do not fall into one of the above categories');
  if (/salary/.test(l)) return fill(A.salaryExpectation || '');
  if (/where.*advertised|how did you.*learn|first saw this post/.test(l)) return fill('Job website');
  if (/smartcard/.test(l)) return fill('No');

  // ── Behavioural / free-text screeners + supporting statement → AI ─────────
  if (/supporting (information|statement)|why.*applying|person specification|demonstrate/.test(l)) return { action: 'ai', kind: 'supporting_statement' };
  if (/piece of work that needs.*improvement|team member.*improvement/.test(l)) return fill('Sit down and discuss with them');

  // Unknown → let the question-AI decide (or skip if not answerable)
  return { action: 'ai', kind: 'question' };
}

// ── Browser helpers (label-first, id-agnostic) ───────────────────────────────
// Refined against a live Trac session; kept resilient by matching on visible text.
async function findApplyEntry(page) {
  const sel = ['a:has-text("Apply")', 'button:has-text("Apply")', 'a:has-text("Apply online")', 'a:has-text("Start")'];
  for (const s of sel) { const el = page.locator(s).first(); if (await el.count().catch(() => 0)) return el; }
  return null;
}
async function clickContinue(page) {
  for (const s of ['button:has-text("Save and continue")', 'button:has-text("Continue")', 'button:has-text("Next")', 'input[type="submit"][value*="ontinue" i]', 'button:has-text("Save")']) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) { await el.click().catch(() => {}); return true; }
  }
  return false;
}
function isLoginPage(url, bodyText) {
  return /login|sign[- ]?in|register/i.test(url) || /sign in to continue|please log in|create an account/i.test(bodyText || '');
}

/**
 * Drive the Trac application for one job.
 * ctx: { job, applicant, jd, tailoredCvPath, generateSupportingStatement(jd, cv), answerQuestion(q, ctx), submit }
 * Returns 'applied' | 'dry_run' | 'needs_login' | 'blocked' | false, plus a paused[] list.
 */
async function fillApplication(page, ctx) {
  const { job, applicant, submit = false, log = console.log } = ctx;
  const paused = [];
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1200));
    const body = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (/just a moment|checking your browser|attention required|cloudflare/i.test(body)) { log('  [Trac] Blocked by bot-check on the advert page.'); return { result: 'blocked', paused }; }

    const apply = await findApplyEntry(page);
    if (!apply) { log('  [Trac] Could not find the Apply entry on the advert.'); return { result: false, paused }; }
    await apply.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const url = page.url();
    const body2 = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    if (isLoginPage(url, body2)) { log('  [Trac] Login required — the Trac account session is needed.'); return { result: 'needs_login', paused }; }

    // Iterate the multi-page form. Each page: enumerate labelled fields, resolve,
    // fill non-sensitive, record sensitive as paused, then continue. Bounded so a
    // navigation loop can't spin forever.
    for (let step = 0; step < 12; step++) {
      const fields = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('input, select, textarea')) {
          const type = (el.getAttribute('type') || el.tagName).toLowerCase();
          if (['hidden', 'submit', 'button'].includes(type)) continue;
          let label = '';
          if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) label = l.innerText; }
          if (!label) label = el.getAttribute('aria-label') || el.closest('label')?.innerText || '';
          out.push({ label: (label || '').trim().slice(0, 120), name: el.name || el.id || '' });
        }
        return out;
      }).catch(() => []);

      if (!fields.length) break;
      for (const f of fields) {
        if (!f.label) continue;
        const a = resolveAnswer(f.label, applicant);
        if (a.action === 'pause') { paused.push({ field: f.label, reason: a.reason }); continue; }
        if (a.action === 'ai') {
          // supporting statement / unknown Q — generated by the caller's engine.
          if (a.kind === 'supporting_statement' && ctx.supportingStatement) {
            await fillFieldByName(page, f.name, ctx.supportingStatement).catch(() => {});
          }
          continue;
        }
        if (a.action === 'fill' && a.value != null && a.value !== '') {
          await fillFieldByName(page, f.name, String(a.value)).catch(() => {});
        }
      }
      const moved = await clickContinue(page);
      await new Promise((r) => setTimeout(r, 1200));
      if (!moved) break;
    }

    if (paused.length) log(`  [Trac] ${paused.length} sensitive field(s) need your confirmation: ${paused.map((p) => p.reason).join(', ')}`);
    if (!submit) { log('  [Trac] DRY RUN — form filled where possible, NOT submitted.'); return { result: 'dry_run', paused }; }
    // Real submit would confirm the sensitive fields + declaration first — left to
    // the supervised/live phase, never auto-clicked here.
    return { result: 'dry_run', paused };
  } catch (e) {
    log('  [Trac] Apply error: ' + e.message);
    return { result: false, paused };
  }
}

async function fillFieldByName(page, name, value) {
  if (!name) return;
  const el = page.locator(`[name="${name}"], #${CSS_escape(name)}`).first();
  const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') { await el.selectOption({ label: value }).catch(async () => { await el.selectOption(value).catch(() => {}); }); }
  else { await el.fill(value).catch(() => {}); }
}
function CSS_escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

// Make sure the agent's browser is signed in to the user's NHS/Trac account. Trac
// login is manual (we never store the user's Trac password), so if not already
// signed in we open the Trac candidate site and WAIT for the user to log in in the
// visible window — the renderer shows a "Trac is waiting for you to log in" prompt
// off the log lines below. The persistent trac_profile keeps the session for next
// time, so this only happens once.
async function ensureTracLogin(page, log = console.log) {
  const HOME = 'https://apps.trac.jobs/';
  const isSignedIn = () => page.evaluate(() => {
    const t = (document.body ? document.body.innerText : '').toLowerCase();
    const u = location.href.toLowerCase();
    const onAuth = /\/login|\/register|sign[-_ ]?in|create.*account/.test(u);
    const signedIn = t.includes('sign out') || t.includes('log out') || t.includes('my applications')
      || t.includes('your applications') || t.includes('my account')
      || !!document.querySelector('a[href*="logout" i], a[href*="signout" i]');
    return signedIn && !onAuth;
  }).catch(() => false);

  try { await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 40000 }); } catch (_) {}
  await new Promise((r) => setTimeout(r, 2000));
  if (await isSignedIn()) { log('  [Trac] ✓ Session restored — already logged in.'); return true; }

  log('  [Trac] Opening login page...');
  log('  [Trac] Waiting for you to complete login (up to 5 minutes) — sign in to your NHS/Trac account in the browser window that opened.');
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    if (await isSignedIn()) { log('  [Trac] ✓ Logged in. Session saved — next run will skip login.'); return true; }
  }
  log('  [Trac] Login timed out — start the Trac agent again once signed in.');
  return false;
}

module.exports = { resolveAnswer, fillApplication, ensureTracLogin };
