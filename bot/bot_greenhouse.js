/**
 * ATS Auto-Apply Agent  (file kept as bot_greenhouse.js / key "greenhouse")
 * ─────────────────────────────────────────────────────────────────────────
 * Auto-applies to SIMPLE-FORM ATS jobs — the ATSes whose public hosted forms
 * can be completed with no employer key and no candidate account, and which the
 * shared ats_filler already drives: Greenhouse, SmartRecruiters, Workable,
 * Breezy (+ Lever/Ashby/Teamtailor/Recruitee/Pinpoint as the feed adds them).
 *
 *  Phase 1 — Pull auto-appliable jobs from the backend candidate feed
 *            (/v1/jobs/candidates, auto_apply=true across all these ATSes),
 *            fetch each JD (Greenhouse via its public single-job API; every
 *            other ATS by loading the posting headlessly and reading its text),
 *            filter, and queue with source 'ats'. The Scorer tailors the CV.
 *  Phase 2 — For each cv_ready job, open the hosted form, DETECT the ATS from
 *            the URL, and complete it with the shared ats_filler.
 *
 * SAFE BY DEFAULT: the final submit is only clicked when JOBBOT_ATS_SUBMIT=1
 * (JOBBOT_GREENHOUSE_SUBMIT still honoured). Otherwise it is a DRY RUN — every
 * field is filled but nothing is sent — so the pipeline can be tested against
 * real forms without applying to employers. Runs HEADLESS (no login needed).
 */

const cfg         = require('./config');
const queue       = require('./modules/queue_manager');
const logger      = require('./modules/logger');
const salary      = require('./modules/salary_filter');
const sponsorship = require('./modules/sponsorship');
const jobFeed     = require('./modules/job_feed');
const stealth     = require('./modules/stealth');
const atsFiller   = require('./modules/ats_filler');
const { launchPersistentContext, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');
const path        = require('path');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;   // 10 s between queue polls
const MAX_IDLE      = 6;       // give up after ~60 s of no pending/ready jobs
const SUBMIT        = process.env.JOBBOT_ATS_SUBMIT === '1' || process.env.JOBBOT_GREENHOUSE_SUBMIT === '1'; // off = dry run
const SOURCE        = 'ats';

// ── filters (mirror the Reed agent) ────────────────────────────────────────
function isRelevantTitle(title) {
  const t = (title || '').toLowerCase();
  return !cfg.TITLE_BLOCKLIST.some(k => t.includes(k));
}
function isBlockedCompany(company) {
  const c = (company || '').toLowerCase();
  return cfg.COMPANY_BLOCKLIST.some(b => c.includes(b));
}
function detectWorkType(description) {
  const d = (description || '').toLowerCase();
  if (/\bfully remote\b|\b100%\s*remote\b|\bremote only\b|\bremote position\b|\bwork from home\b|\bwfh\b|\bremote (working|role|job)\b/.test(d)) return 'remote';
  if (/\bhybrid\b/.test(d)) return 'hybrid';
  return 'onsite';
}
function workTypePriority() {
  const map = {};
  cfg.WORK_TYPE_PRIORITY.forEach((type, i) => { map[type] = i; });
  return map;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Greenhouse exposes a cheap single-job API (JD + questions, one job, no OOM).
function parseGh(url) {
  try {
    const u = new URL(url);
    if (!/greenhouse/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/([^\/]+)\/jobs\/(\d+)/);
    return m ? { token: m[1], id: m[2] } : null;
  } catch (_) { return null; }
}
async function fetchGhJD(job) {
  const p = parseGh(job.url);
  if (!p) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try { res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${p.token}/jobs/${p.id}?questions=true`, { signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    return d ? stripHtml(d.content || '').slice(0, 8000) : null;
  } catch (_) { return null; }
}
// Generic JD: Greenhouse via API, every other ATS by loading the posting and
// reading its visible text (uniform, needs no per-ATS endpoint).
async function fetchJD(page, job) {
  const gh = await fetchGhJD(job);
  if (gh) return gh;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await DELAY(1500 + Math.random() * 1500);
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    return String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 8000);
  } catch (_) { return ''; }
}

// ── Phase 1: source + filter + queue ───────────────────────────────────────
async function filterAndQueue(page, job) {
  if (queue.has(job.jobId)) { console.log(`  [Auto-Apply] Already queued: ${job.title}`); return; }
  if (queue.wasApplied(job.jobId)) { console.log(`  [Auto-Apply] Already applied — skipping: ${job.title}`); return; }
  if (!isRelevantTitle(job.title)) { console.log(`  [Auto-Apply] Title filter — skipping: ${job.title}`); return; }
  if (isBlockedCompany(job.company)) { console.log(`  [Auto-Apply] Company blocked — skipping: ${job.title} @ ${job.company}`); return; }
  if (queue.hasCanonical(job.title, job.company)) { console.log(`  [Auto-Apply] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`); return; }

  const description = (await fetchJD(page, job)) || job.description || '';
  if (!description || description.trim().split(/\s+/).length < 60) {
    console.log(`  [Auto-Apply] Short/missing JD — skipping: ${job.title}`);
    queue.add({ ...job, source: SOURCE, status: 'skipped', reason: 'JD too short or missing' });
    return;
  }
  const workType = detectWorkType(description);
  if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
    console.log(`  [Auto-Apply] Work type "${workType}" not wanted — skipping: ${job.title}`);
    queue.add({ ...job, source: SOURCE, status: 'skipped', reason: `Work type (${workType}) not wanted` });
    return;
  }
  if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(description))) {
    console.log(`  [Auto-Apply] No sponsorship offered — skipping: ${job.title}`);
    queue.add({ ...job, source: SOURCE, status: 'skipped', reason: 'No sponsorship offered' });
    return;
  }
  if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) {
    console.log(`  [Auto-Apply] Below salary — skipping: ${job.title}`);
    queue.add({ ...job, source: SOURCE, status: 'skipped', reason: 'Below salary expectation' });
    return;
  }
  queue.add({ ...job, description, source: SOURCE, workType });
  console.log(`  [Auto-Apply] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
}

async function phase1_sourceAndQueue(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Auto-Apply] Phase 1 — sourcing auto-appliable ATS jobs from the feed');
  console.log('══════════════════════════════════════════════════════');

  let jobs = [];
  for (const country of ['GB', 'US']) {
    try { jobs = jobs.concat(await jobFeed.fetchAtsJobs({ country, limit: 100 })); } catch (_) {}
  }
  if (!jobs.length) {
    console.log('  [Auto-Apply] No auto-appliable jobs in the feed right now (feed off, no licence, or none matched your terms).');
    return;
  }
  console.log(`  [Auto-Apply] ${jobs.length} job(s) from the feed`);
  for (const job of jobs) { await filterAndQueue(page, job); await DELAY(800); }

  const pending = queue.getByStatus('pending').filter(j => j.source === SOURCE).length;
  console.log(`\n  [Auto-Apply] Phase 1 complete. ${pending} job(s) queued for Scorer.`);
}

// ── Phase 2: apply cv_ready jobs ───────────────────────────────────────────
async function phase2_applyReadyCVs(context, page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Auto-Apply] Phase 2 — waiting for Scorer agent...');
  console.log('══════════════════════════════════════════════════════');

  const priority = workTypePriority();
  let idleCount = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === SOURCE)
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));
    const pendingJobs = [
      ...queue.getByStatus('pending').filter(j => j.source === SOURCE),
      ...queue.getByStatus('processing').filter(j => j.source === SOURCE),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Auto-Apply] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing until tomorrow`);
        return;
      }
      if (!isRelevantTitle(job.title)) { queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' }); continue; }

      const ats = atsFiller.detectATS(job.url);
      queue.update(job.jobId, { status: 'applying' });
      console.log(`  [Auto-Apply] Applying${SUBMIT ? '' : ' (DRY RUN)'} [${ats}]: ${job.title} @ ${job.company}`);
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await DELAY(1500 + Math.random() * 1500);
        const result = await atsFiller.fillExternalForm(page, job, job.cvPath, ats, { submit: SUBMIT });

        if (result === true) {
          queue.update(job.jobId, { status: 'applied' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', ats);
          console.log(`  [Auto-Apply] ✓ Applied [${ats}]: ${job.title}`);
        } else if (result === 'dry_run') {
          queue.update(job.jobId, { status: 'skipped', reason: 'Dry run (submit disabled)' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', `Dry run — ${ats} form filled, not submitted`);
          console.log(`  [Auto-Apply] ✓ Dry run — filled, NOT submitted [${ats}]: ${job.title}`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLY_FAILED', `${ats} form could not be completed`);
          console.log(`  [Auto-Apply] ✗ Apply failed [${ats}]: ${job.title}`);
        }
      } catch (err) {
        const isPageClosed = /Target page.*closed|context.*closed|browser.*closed|page.*closed/i.test(err.message);
        if (isPageClosed) {
          queue.update(job.jobId, { status: 'cv_ready', error: null });
          await page.close().catch(() => {});
          page = await context.newPage(); // throws if the context is dead → caught by main()
        } else {
          queue.update(job.jobId, { status: 'apply_failed', error: err.message });
          logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
          console.error(`  [Auto-Apply] Error applying to "${job.title}": ${err.message}`);
        }
      }
      await DELAY(8000 + Math.random() * 7000);
    }

    if (readyJobs.length) { idleCount = 0; }
    else if (pendingJobs > 0) { idleCount = 0; console.log(`  [Auto-Apply] Waiting for Scorer... (${pendingJobs} job(s) in progress)`); }
    else { idleCount++; console.log(`  [Auto-Apply] Idle ${idleCount}/${MAX_IDLE} — no pending or ready jobs`); }

    if (idleCount >= MAX_IDLE) return;
    await DELAY(POLL_INTERVAL);
  }
}

// ── browser + main ─────────────────────────────────────────────────────────
async function launchBrowser() {
  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'greenhouse_profile'); // matches botManager key 'greenhouse'
  // Simple-form ATSes are public (no login, no hand-solved captcha), so run
  // HEADLESS by default; JOBBOT_SHOW_BROWSER=1 forces a visible window.
  const headless = process.env.JOBBOT_SHOW_BROWSER !== '1';
  const context = await launchPersistentContext(profileDir, { headless });
  await stealth.applyToContext(context);
  const page = await context.newPage();
  return { context, page };
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  ATS Auto-Apply Agent — Starting${SUBMIT ? '' : '  (DRY RUN — submissions disabled)'}`);
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuck = queue.getByStatus('applying').filter(j => j.source === SOURCE);
  for (const j of stuck) queue.update(j.jobId, { status: 'cv_ready' });

  let context, page, guard;
  try {
    ({ context, page } = await launchBrowser());
    guard = watchForManualClose(context, 'Auto-Apply');
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) { console.log('  [Auto-Apply] Browser closed — agent stopped.'); process.exit(0); }
    console.error('  [Auto-Apply] Failed to launch browser: ' + err.message);
    process.exit(1);
  }

  try {
    await phase1_sourceAndQueue(page);
    await phase2_applyReadyCVs(context, page);
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) console.log('  [Auto-Apply] Browser closed — agent stopped.');
    else console.error('  [Auto-Apply] Fatal: ' + err.message);
  } finally {
    if (guard) guard.intentional = true;
    await context?.close().catch(() => {});
  }
  console.log('  [Auto-Apply] Done.');
  process.exit(0);
}

main().catch(err => { console.error('  [Auto-Apply] Uncaught: ' + err.message); process.exit(1); });
