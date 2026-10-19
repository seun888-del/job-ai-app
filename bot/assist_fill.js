/**
 * Fill it, you press Send
 * ─────────────────────────────────────────────────────────────────────────
 * Opens one company-site job the Company Sites agent parked as ready_to_submit
 * (Greenhouse, Workable, Lever, Ashby, SmartRecruiters: their Submit is behind a
 * captcha or bot check), fills it with the tailored CV and the user's details, and
 * hands the window to the user. They check it, pass any check and press Submit
 * themselves. When the page confirms the application, the job is marked applied.
 *
 *   node assist_fill.js <jobId>
 *
 * Never presses Submit. Closing the window leaves the job in the ready list.
 */
process.env.JOBBOT_SHOW_BROWSER = '1'; // the user works in this window

const cfg       = require('./config');
const queue     = require('./modules/queue_manager');
const logger    = require('./modules/logger');
const atsFiller = require('./modules/ats_filler');
const stealth   = require('./modules/stealth');
const { launchPersistentContext, restoreWindow } = require('./modules/browser_launcher');
const path      = require('path');

const DELAY   = ms => new Promise(r => setTimeout(r, ms));
const WAIT_MS = 30 * 60 * 1000; // how long the window waits for the user to send it

// Confirmation text the ATSes show after a real submission.
const SENT_RE = /application (has been )?(received|submitted|sent)|thank you for (applying|your application|your interest)|thanks for applying|successfully (applied|submitted)|we('| ha)ve received your application|application complete/i;

async function pageState(page) {
  const st = { url: /\/confirmation|\/thank[-_]?you|\/success/i.test(page.url()), text: false, submitButton: false };
  for (const frame of page.frames()) {
    const r = await frame.evaluate(() => ({
      text: (document.body ? document.body.innerText : '').slice(0, 20000),
      submit: [...document.querySelectorAll('button, input[type="submit"]')].some((b) => (b.offsetParent || b.getClientRects().length) && /submit|send application|apply/i.test(b.innerText || b.value || '')),
    })).catch(() => ({ text: '', submit: false }));
    if (SENT_RE.test(r.text)) st.text = true;
    if (r.submit) st.submitButton = true;
  }
  return st;
}
// Sent = a confirmation URL, or confirmation text that wasn't on the form before (an advert
// can say "thank you for your interest") or that shows once the Submit button has gone.
const isSent = (st, before) => st.url || (st.text && (!before.text || !st.submitButton));

// Greenhouse's embedded form always shows the application, even for companies whose
// hosted job page redirects to their own careers site (Coinbase, Stripe...).
function formUrl(url) {
  const m = String(url || '').match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  return m ? `https://job-boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}` : url;
}
const hasForm = (page) => page.evaluate(() => !!document.querySelector('form input[type="file"], form input[type="email"], form input[name*="first" i]')).catch(() => false);

async function main() {
  const jobId = process.argv[2];
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  const job = queue.getByStatus('ready_to_submit').find((j) => j.jobId === jobId && j.source === 'ats');
  if (!job) { console.log('  [Send] That application is no longer waiting to be sent.'); process.exit(0); }

  const context = await launchPersistentContext(path.join(process.env.JOBBOT_USERDATA, 'assist_profile'));
  await stealth.applyToContext(context).catch(() => {});
  const page = context.pages()[0] || await context.newPage();
  let closed = false;
  context.on('close', () => { closed = true; });

  console.log(`  [Send] Opening ${job.title} @ ${job.company}`);
  await page.goto(formUrl(job.url), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await restoreWindow(page).catch(() => {});
  await DELAY(2000);

  try {
    const ats = atsFiller.detectATS(job.url);
    if (!(await hasForm(page))) {
      // No form on the page yet: most job pages open it behind an Apply button.
      const apply = page.locator('a, button').filter({ hasText: /^\s*apply( now| for this job)?\s*$/i }).first();
      if (await apply.count().catch(() => 0)) { await apply.click().catch(() => {}); await DELAY(3000); }
    }
    if (!(await hasForm(page))) {
      console.log("  [[JOBBOT_NOTIFY]] Couldn't find the form on this page. Press Apply there, fill it in, then press Submit.");
    } else {
      await atsFiller.fillExternalForm(page, job, job.cvPath, ats, { submit: false });
      console.log('  [[JOBBOT_NOTIFY]] Filled. Check the form, pass any check, then press Submit.');
    }
  } catch (err) {
    if (closed) process.exit(0);
    console.log(`  [Send] Couldn't fill everything (${err.message.slice(0, 80)}). Finish it in the window, then press Submit.`);
  }
  await restoreWindow(page).catch(() => {});
  // Tests: capture the filled form and stop (never waits for, or presses, Submit).
  if (process.env.JOBBOT_ASSIST_SHOT) {
    await page.screenshot({ path: process.env.JOBBOT_ASSIST_SHOT, fullPage: true }).catch(() => {});
    await context.close().catch(() => {});
    process.exit(0);
  }
  const before = await pageState(page);

  const until = Date.now() + WAIT_MS;
  while (!closed && Date.now() < until) {
    const p = context.pages().find((x) => !x.isClosed());
    if (!p) break;
    if (isSent(await pageState(p), before)) {
      queue.update(job.jobId, { status: 'applied', reason: 'Sent by you' });
      queue.markApplied(job.jobId);
      logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'Sent by you');
      console.log(`  [Send] ✓ Sent: ${job.title} @ ${job.company}`);
      await DELAY(4000);
      break;
    }
    await DELAY(2000);
  }
  if (!closed) await context.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => { console.error('  [Send] ' + err.message); process.exit(1); });
