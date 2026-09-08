/**
 * Greenhouse Agent
 * ─────────────────────────────────────────────────────────────────────────
 * Auto-applies to Greenhouse-hosted jobs — the ATS whose PUBLIC hosted form
 * (job-boards.greenhouse.io/{company}/jobs/{id}) can be completed without an
 * employer key or a candidate account. Same shape as the Reed agent:
 *
 *  Phase 1 — Pull auto-appliable jobs from the backend candidate feed, fetch
 *            each job's JD + screening questions from the public Greenhouse
 *            Job Board API (one job at a time, so no OOM), filter, and queue
 *            with source 'greenhouse'. The Scorer agent then tailors the CV.
 *  Phase 2 — For each cv_ready Greenhouse job, open the hosted form and complete
 *            it with the shared ats_filler.
 *
 * SAFE BY DEFAULT: the final submit is only clicked when JOBBOT_GREENHOUSE_SUBMIT=1.
 * Otherwise it is a DRY RUN — every field is filled but nothing is sent — so the
 * whole pipeline can be tested against real forms without applying to employers.
 *
 * No login needed (the hosted form is public), so there is no account/session to
 * verify — unlike the Reed/LinkedIn agents.
 */

const cfg         = require('./config');
const queue       = require('./modules/queue_manager');
const logger      = require('./modules/logger');
const salary      = require('./modules/salary_filter');
const sponsorship = require('./modules/sponsorship');
const jobFeed     = require('./modules/job_feed');
const stealth     = require('./modules/stealth');
const atsFiller   = require('./modules/ats_filler');
const { launchPersistentContext, connectToRunningChrome, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');
const path        = require('path');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;   // 10 s between queue polls
const MAX_IDLE      = 6;       // give up after ~60 s of no pending/ready jobs
const SUBMIT        = process.env.JOBBOT_GREENHOUSE_SUBMIT === '1'; // off = dry run

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

// Parse a Greenhouse hosted-form URL into { token, id } for the public API.
function parseGh(url) {
  try {
    const u = new URL(url);
    if (!/greenhouse/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/([^\/]+)\/jobs\/(\d+)/);
    return m ? { token: m[1], id: m[2] } : null;
  } catch (_) { return null; }
}

// Fetch ONE job's description + location from the public Greenhouse Job Board
// API (GET needs no key; one job at a time so no OOM). null on any problem.
async function fetchGhDetails(job) {
  const p = parseGh(job.url);
  if (!p) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${p.token}/jobs/${p.id}?questions=true`, { signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    if (!d) return null;
    return { description: stripHtml(d.content || '').slice(0, 8000), location: (d.location && d.location.name) || '' };
  } catch (_) { return null; }
}

// ── Phase 1: source + filter + queue ───────────────────────────────────────
async function filterAndQueue(job) {
  if (queue.has(job.jobId)) { console.log(`  [Greenhouse Agent] Already queued: ${job.title}`); return; }
  if (queue.wasApplied(job.jobId)) { console.log(`  [Greenhouse Agent] Already applied — skipping: ${job.title}`); return; }
  if (!isRelevantTitle(job.title)) { console.log(`  [Greenhouse Agent] Title filter — skipping: ${job.title}`); return; }
  if (isBlockedCompany(job.company)) { console.log(`  [Greenhouse Agent] Company blocked — skipping: ${job.title} @ ${job.company}`); return; }
  if (queue.hasCanonical(job.title, job.company)) { console.log(`  [Greenhouse Agent] Duplicate (cross-site) — skipping: ${job.title} @ ${job.company}`); return; }

  const details = await fetchGhDetails(job);
  const description = (details && details.description) || job.description || '';
  if (!description || description.trim().split(/\s+/).length < 80) {
    console.log(`  [Greenhouse Agent] Short/missing JD — skipping: ${job.title}`);
    queue.add({ ...job, source: 'greenhouse', status: 'skipped', reason: 'JD too short or missing' });
    return;
  }
  const workType = detectWorkType(description);
  if (!cfg.WORK_TYPE_PRIORITY.includes(workType)) {
    console.log(`  [Greenhouse Agent] Work type "${workType}" not wanted — skipping: ${job.title}`);
    queue.add({ ...job, source: 'greenhouse', status: 'skipped', reason: `Work type (${workType}) not wanted` });
    return;
  }
  if (cfg.APPLICANT.seekSponsorship && !(await sponsorship.offersSponsorship(description))) {
    console.log(`  [Greenhouse Agent] No sponsorship offered — skipping: ${job.title}`);
    queue.add({ ...job, source: 'greenhouse', status: 'skipped', reason: 'No sponsorship offered' });
    return;
  }
  if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) {
    console.log(`  [Greenhouse Agent] Below salary — skipping: ${job.title}`);
    queue.add({ ...job, source: 'greenhouse', status: 'skipped', reason: 'Below salary expectation' });
    return;
  }
  queue.add({ ...job, description, location: (details && details.location) || '', source: 'greenhouse', workType });
  console.log(`  [Greenhouse Agent] → Queued for Scorer: ${job.title} @ ${job.company} [${workType}]`);
}

async function phase1_sourceAndQueue() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Greenhouse Agent] Phase 1 — sourcing auto-appliable jobs from the feed');
  console.log('══════════════════════════════════════════════════════');

  let jobs = [];
  for (const country of ['GB', 'US']) {
    try { jobs = jobs.concat(await jobFeed.fetchAtsJobs({ country, limit: 100 })); } catch (_) {}
  }
  if (!jobs.length) {
    console.log('  [Greenhouse Agent] No auto-appliable jobs in the feed right now (feed off, no licence, or none matched).');
    return;
  }
  console.log(`  [Greenhouse Agent] ${jobs.length} job(s) from the feed`);
  for (const job of jobs) { await filterAndQueue(job); await DELAY(1500); }

  const pending = queue.getByStatus('pending').filter(j => j.source === 'greenhouse').length;
  console.log(`\n  [Greenhouse Agent] Phase 1 complete. ${pending} job(s) queued for Scorer.`);
}

// ── Phase 2: apply cv_ready jobs ───────────────────────────────────────────
async function phase2_applyReadyCVs(context, page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Greenhouse Agent] Phase 2 — waiting for Scorer agent...');
  console.log('══════════════════════════════════════════════════════');

  const priority = workTypePriority();
  let idleCount = 0;

  while (true) {
    const readyJobs = queue.getByStatus('cv_ready')
      .filter(j => j.source === 'greenhouse')
      .sort((a, b) => (priority[a.workType] ?? 99) - (priority[b.workType] ?? 99));
    const pendingJobs = [
      ...queue.getByStatus('pending').filter(j => j.source === 'greenhouse'),
      ...queue.getByStatus('processing').filter(j => j.source === 'greenhouse'),
    ].length;

    for (const job of readyJobs) {
      const appliedToday = queue.countAppliedToday();
      if (appliedToday >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Greenhouse Agent] Daily limit reached (${appliedToday}/${cfg.MAX_APPLICATIONS_PER_DAY}) — pausing until tomorrow`);
        return;
      }
      if (!isRelevantTitle(job.title)) { queue.update(job.jobId, { status: 'skipped', reason: 'Title filter (post-queue)' }); continue; }

      queue.update(job.jobId, { status: 'applying' });
      console.log(`  [Greenhouse Agent] Applying${SUBMIT ? '' : ' (DRY RUN)'}: ${job.title} @ ${job.company}`);
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await DELAY(1500 + Math.random() * 1500);
        const result = await atsFiller.fillExternalForm(page, job, job.cvPath, 'greenhouse', { submit: SUBMIT });

        if (result === true) {
          queue.update(job.jobId, { status: 'applied' });
          queue.markApplied(job.jobId);
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'Greenhouse');
          console.log(`  [Greenhouse Agent] ✓ Applied: ${job.title}`);
        } else if (result === 'dry_run') {
          queue.update(job.jobId, { status: 'skipped', reason: 'Dry run (submit disabled)' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Dry run — form filled, not submitted');
          console.log(`  [Greenhouse Agent] ✓ Dry run — filled, NOT submitted: ${job.title}`);
        } else {
          queue.update(job.jobId, { status: 'apply_failed' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLY_FAILED', 'Greenhouse form could not be completed');
          console.log(`  [Greenhouse Agent] ✗ Apply failed: ${job.title}`);
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
          console.error(`  [Greenhouse Agent] Error applying to "${job.title}": ${err.message}`);
        }
      }
      await DELAY(8000 + Math.random() * 7000);
    }

    if (readyJobs.length) { idleCount = 0; }
    else if (pendingJobs > 0) { idleCount = 0; console.log(`  [Greenhouse Agent] Waiting for Scorer... (${pendingJobs} job(s) in progress)`); }
    else { idleCount++; console.log(`  [Greenhouse Agent] Idle ${idleCount}/${MAX_IDLE} — no pending or ready jobs`); }

    if (idleCount >= MAX_IDLE) return;
    await DELAY(POLL_INTERVAL);
  }
}

// ── browser + main ─────────────────────────────────────────────────────────
async function launchBrowser() {
  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'greenhouse_profile');
  const cdpPort = process.env.JOBBOT_CDP_PORT;
  const context = cdpPort
    ? await connectToRunningChrome(parseInt(cdpPort)).catch(() => launchPersistentContext(profileDir))
    : await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const page = await context.newPage();
  return { context, page };
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Greenhouse Agent — Starting${SUBMIT ? '' : '  (DRY RUN — submissions disabled)'}`);
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuck = queue.getByStatus('applying').filter(j => j.source === 'greenhouse');
  for (const j of stuck) queue.update(j.jobId, { status: 'cv_ready' });

  let context, page;
  try {
    ({ context, page } = await launchBrowser());
    watchForManualClose(context, 'Greenhouse Agent'); // user closing Chromium → clean stop
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) { console.log('  [Greenhouse Agent] Browser window closed — agent stopped.'); process.exit(0); }
    console.error('  [Greenhouse Agent] Failed to launch browser: ' + err.message);
    process.exit(1);
  }

  try {
    await phase1_sourceAndQueue();
    await phase2_applyReadyCVs(context, page);
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) console.log('  [Greenhouse Agent] Browser closed — agent stopped.');
    else console.error('  [Greenhouse Agent] Fatal: ' + err.message);
  } finally {
    await context?.close().catch(() => {});
  }
  console.log('  [Greenhouse Agent] Done.');
  process.exit(0);
}

main().catch(err => { console.error('  [Greenhouse Agent] Uncaught: ' + err.message); process.exit(1); });
