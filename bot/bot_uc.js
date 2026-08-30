/**
 * Universal Credit Agent
 * ─────────────────────────────────────────────────────────────────────────
 * Logs the jobs the app has GENUINELY applied to into the user's Universal
 * Credit "log your work search" journal, so a claimant doesn't have to type
 * each one in by hand.
 *
 * Truthful by design:
 *   - Only logs jobs from applied_jobs (i.e. actually submitted by the app).
 *   - Records each against its REAL application date (applied_at). There is no
 *     free-choice / backdate option — the journal must reflect what actually
 *     happened, on the day it happened. That keeps the claimant honest with DWP.
 *   - Marks each as logged so it is never double-entered.
 *
 * Runs on the user's own machine + own session (persistent uc_profile), like the
 * other agents. First run, the user logs in to their UC account once.
 */
'use strict';

const path = require('path');
const cfg = require('./config');
const queue = require('./modules/queue_manager');
const { launchPersistentContext, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');

const UC_BASE = 'https://www.universal-credit.service.gov.uk';
const DELAY = (ms) => new Promise(r => setTimeout(r, ms));

process.on('uncaughtException', (err) => { console.error('Fatal error:', err.message); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('Fatal error:', reason); process.exit(1); });

// applied_at is stored as "YYYY-MM-DD HH:MM:SS" (UTC). We only need the date.
function ukDateParts(appliedAt) {
  const datePart = String(appliedAt || '').slice(0, 10); // YYYY-MM-DD
  const [yyyy, mm, dd] = datePart.split('-');
  if (yyyy && mm && dd) return { dd, mm, yyyy };
  // Fallback: today (should never happen — applied_at always set on markApplied)
  const now = new Date();
  return { dd: String(now.getDate()).padStart(2, '0'), mm: String(now.getMonth() + 1).padStart(2, '0'), yyyy: String(now.getFullYear()) };
}

async function dismissCookieBanner(page) {
  try {
    const btn = page.locator('button:has-text("Reject analytics cookies")');
    if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); await DELAY(400); }
  } catch (_) {}
}

async function isSignedOut(page) {
  const url = page.url();
  return url.includes('sign-in') || url.includes('login') || !url.includes('universal-credit.service.gov.uk');
}

async function navigateToAddJob(page) {
  await page.goto(`${UC_BASE}/work-search`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (await isSignedOut(page)) return false;
  await dismissCookieBanner(page);

  for (const sel of ['a:has-text("Add a job")', 'button:has-text("Add a job")', 'text="Add a job"']) {
    try {
      await page.locator(sel).first().click({ timeout: 6000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      return true;
    } catch (_) {}
  }
  return false;
}

async function fillJobForm(page, job) {
  const { dd, mm, yyyy } = ukDateParts(job.appliedAt);
  const employer = job.company && job.company !== 'Unknown' ? job.company : 'Unknown Employer';
  console.log(`  [Universal Credit Agent] Logging "${job.title}" at "${employer}" (applied ${dd}/${mm}/${yyyy})`);

  // Employer
  for (const sel of ['input[name*="employer" i]', 'input[id*="employer" i]', '#employerName', 'input[name="EmployerName"]']) {
    try { await page.fill(sel, employer, { timeout: 3000 }); break; } catch (_) {}
  }
  // Job title
  for (const sel of ['input[name*="jobTitle" i]', 'input[id*="jobTitle" i]', '#jobTitle', 'input[name="JobTitle"]', 'input[name*="title" i]']) {
    try { await page.fill(sel, job.title, { timeout: 3000 }); break; } catch (_) {}
  }

  // Status "Applied" — reveals the date fields
  let statusSet = false;
  for (const text of ['Applied', 'Online', 'online application']) {
    try {
      const radio = page.locator(`label:has-text("${text}") input[type="radio"], input[type="radio"][value*="${text}" i]`).first();
      await radio.click({ timeout: 2500 });
      statusSet = true;
      break;
    } catch (_) {}
  }
  if (!statusSet) { try { await page.locator('select').first().selectOption({ label: 'Applied' }); } catch (_) {} }
  await DELAY(2000);

  // Date (real application date). Enabled day/month/year inputs; skip disabled hidden ones.
  const T = { timeout: 4000 };
  let filledDate = false;
  try {
    await page.locator('input[class~="day"]:not([disabled])').first().fill(dd, T);
    await page.locator('input[class~="month"]:not([disabled])').first().fill(mm, T);
    await page.locator('input[class~="year"]:not([disabled])').first().fill(yyyy, T);
    filledDate = true;
  } catch (_) {}
  if (!filledDate) {
    try {
      const inputs = page.locator('input[type="text"]:not([disabled]), input:not([type]):not([disabled])');
      if (await inputs.count() >= 5) {
        await inputs.nth(2).fill(dd, T); await inputs.nth(3).fill(mm, T); await inputs.nth(4).fill(yyyy, T);
        filledDate = true;
      }
    } catch (_) {}
  }
  if (!filledDate) {
    console.log('  [Universal Credit Agent] Could not fill the date field — skipping this entry (not submitting a wrong date).');
    return false;
  }
  await DELAY(800);

  // Submit
  for (const sel of ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Save")', 'button:has-text("Continue")', 'button:has-text("Add")', 'button:has-text("Confirm")', '[data-module="govuk-button"]']) {
    try { await page.click(sel, { timeout: 4000 }); await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {}); return true; }
    catch (_) {}
  }
  console.log('  [Universal Credit Agent] Could not find the submit button — entry not confirmed.');
  return false;
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Universal Credit Agent — Starting');
  console.log('═══════════════════════════════════════════════════════');

  const DAILY_LIMIT = parseInt(process.env.UC_DAILY_LIMIT || '20', 10);
  const pending = queue.getUcPending(DAILY_LIMIT);
  const total = queue.ucPendingCount();

  console.log(`  [Universal Credit Agent] ${total} applied job(s) not yet in your UC journal. Logging up to ${pending.length} this run.`);
  if (pending.length === 0) {
    console.log('  [Universal Credit Agent] Nothing to log — your UC journal is up to date.');
    process.exit(0);
  }

  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'uc_profile');
  const context = await launchPersistentContext(profileDir);
  const closeGuard = watchForManualClose(context, 'Universal Credit Agent');
  const page = await context.newPage();

  try {
    // Ensure we have a live UC session; if not, ask the user to log in once.
    await page.goto(`${UC_BASE}/work-search`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (await isSignedOut(page)) {
      await page.goto(`${UC_BASE}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      console.log('  [Universal Credit Agent] Please sign in to your Universal Credit account in the window.');
      console.log('  [[JOBBOT_NOTIFY]] Sign in to your Universal Credit account in the Agent window to log your applications.');
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await DELAY(3000);
        if (!(await isSignedOut(page))) break;
      }
      if (await isSignedOut(page)) {
        console.log('  [Universal Credit Agent] Sign-in not completed — stopping. Start again once logged in.');
        closeGuard.intentional = true;
        await context.close().catch(() => {});
        process.exit(0);
      }
      console.log('  [Universal Credit Agent] Signed in. Logging applications...');
    }

    let ok = 0, fail = 0;
    for (const job of pending) {
      if (await isSignedOut(page)) { console.log('  [Universal Credit Agent] Session ended — stopping.'); break; }
      try {
        if (!(await navigateToAddJob(page))) { console.log('  [Universal Credit Agent] Could not open the "Add a job" form — skipping.'); fail++; continue; }
        if (await fillJobForm(page, job)) {
          queue.markUcLogged(job.jobId);
          ok++;
          console.log(`  [Universal Credit Agent] ✓ Logged: ${job.title}`);
        } else { fail++; }
      } catch (err) {
        if (BROWSER_CLOSED_RE.test(err.message || '')) { console.log('  [Universal Credit Agent] Browser window closed — agent stopped.'); process.exit(0); }
        console.log(`  [Universal Credit Agent] Error on "${job.title}": ${err.message.split('\n')[0]}`);
        fail++;
      }
      await DELAY(4000); // gentle pacing on a government service
    }

    console.log(`  [Universal Credit Agent] Done. Logged ${ok}, skipped/failed ${fail}. ${queue.ucPendingCount()} still pending.`);
    closeGuard.intentional = true;
    await context.close().catch(() => {});
    process.exit(0);
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) { console.log('  [Universal Credit Agent] Browser window closed — agent stopped.'); process.exit(0); }
    console.error('Fatal error:', err.message);
    await context.close().catch(() => {});
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
