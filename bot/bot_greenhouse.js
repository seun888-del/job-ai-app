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
const httpSubmit  = require('./modules/ats_http_submit');
const reed        = require('./modules/reed');
const { launchPersistentContext, connectToRunningChrome, spawnChromeWithCdp, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');
const path        = require('path');

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;   // 10 s between queue polls
const MAX_IDLE      = 6;       // give up after ~60 s of no pending/ready jobs

// ── Router consolidation: browser job boards folded in behind a flag ─────────
// Step 2 of the one-agent plan. Reed is applied via reed.applyToJob on the Reed
// logged-in profile. OFF by default so the working ATS agent is untouched; set
// JOBBOT_AUTOAPPLY_REED=1 to also source + apply Reed here (bot_reed stays as
// the fallback until this is proven). Reed has no fill-only mode, so it can only
// be exercised for real (SUBMIT), never in a dry run.
const REED_ENABLED = process.env.JOBBOT_AUTOAPPLY_REED === '1';
// Reed applies for real when the global ATS submit is on OR a Reed-specific
// submit flag is set — so a supervised Reed test can go live WITHOUT forcing
// real Recruitee/SmartRecruiters applies (those stay dry-run under SUBMIT).
const REED_SUBMIT = process.env.JOBBOT_ATS_SUBMIT === '1' || process.env.JOBBOT_AUTOAPPLY_REED_SUBMIT === '1';
const isReedJob = (job) => /(^|\.)reed\.co\.uk/i.test(String(job.url || ''));

// Lazy browser-context pool keyed by profile: open a site's logged-in Chrome
// only when a job needs it, reuse it across that site's batch, close all at the
// end. Recruitee (HTTP) never enters this pool.
const _ctxPool = {};
async function getSiteContext(profile, loginFn) {
  if (_ctxPool[profile]) return _ctxPool[profile];
  const dir = path.join(process.env.JOBBOT_USERDATA, profile);
  const context = await launchPersistentContext(dir);
  await stealth.applyToContext(context);
  const page = await context.newPage();
  if (loginFn) await loginFn(page);
  _ctxPool[profile] = { context, page };
  return _ctxPool[profile];
}
async function closeSiteContexts() {
  for (const k of Object.keys(_ctxPool)) { try { await _ctxPool[k].context.close(); } catch (_) {} delete _ctxPool[k]; }
}
const SUBMIT        = process.env.JOBBOT_ATS_SUBMIT === '1' || process.env.JOBBOT_GREENHOUSE_SUBMIT === '1'; // off = dry run
// Headless mode: launch NO browser at all. Apply only to pure-HTTP ATSes
// (Recruitee) and skip anything that needs a browser. This is what makes the agent
// work on macOS, where the Playwright browser gets blocked — the HTTP apply path
// isn't affected by that block. botManager sets this automatically on macOS.
const HEADLESS_ONLY = process.env.JOBBOT_HEADLESS_ONLY === '1';
// CDP-spawn mode: instead of letting Playwright launch Chrome (which macOS blocks
// via the automation-permission prompt), SPAWN the user's real Chrome with a debug
// port and attach over CDP. Uses the user's real (imported) profile — no separate
// login — and slips past the macOS block because CDP is a localhost WebSocket, not
// Apple Events. The macOS-safe way to run the browser sites (LinkedIn/Reed).
const CDP_SPAWN     = process.env.JOBBOT_CDP_SPAWN === '1';
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
// Fetch a job description over plain HTTP (no browser). ATS apply pages render the
// JD server-side (Recruitee's does), so a GET + tag-strip is enough — this is how
// the headless agent reads JDs without Playwright.
async function fetchJdHttp(job) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(job.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: c.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return '';
    const html = await r.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim().slice(0, 8000);
  } catch (_) { return ''; }
}

async function fetchJD(page, job) {
  const gh = await fetchGhJD(job);
  if (gh) return gh;
  if (!page) return await fetchJdHttp(job); // headless mode: no browser to drive
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
    try { jobs = jobs.concat(await jobFeed.fetchAtsJobs({ country, limit: 40 })); } catch (_) {}
  }
  // Router step 2: also fold in Reed (browser board) when enabled. Reed stubs
  // carry a reed.co.uk URL, so the Phase-2 router applies them via reed.applyToJob.
  if (REED_ENABLED) {
    try {
      const reedStubs = await jobFeed.fetchReedStubs({ country: 'GB' });
      console.log(`  [Auto-Apply] +${reedStubs.length} Reed job(s) from the feed`);
      jobs = jobs.concat(reedStubs.map((s) => ({ ...s, url: s.url, apply_url: s.url, apply_kind: 'reed', auto_apply: false })));
    } catch (e) { console.log(`  [Auto-Apply] Reed feed unavailable (${e.message})`); }
  }
  // Cap the per-run candidate set: Phase 1 loads a page per non-Greenhouse job
  // for its JD, and the daily apply cap is 25, so ~50 candidates is plenty.
  jobs = jobs.slice(0, 50);
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

      // Headless mode: only jobs with a pure-HTTP submitter (Recruitee) can be
      // applied without a browser. Skip everything else (SmartRecruiters, Reed…)
      // rather than crash on a null page — this is what keeps macOS working.
      if (HEADLESS_ONLY) {
        const _ats = atsFiller.detectATS(job.url);
        const _httpFn = httpSubmit.httpSubmitterFor(_ats) || httpSubmit.httpSubmitterFor(job.source);
        if (!_httpFn) {
          queue.update(job.jobId, { status: 'skipped', reason: 'Needs a browser — skipped in headless mode' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Headless: browser-required ATS');
          console.log(`  [Auto-Apply] Headless — skipping browser-required job: ${job.title} @ ${job.company}`);
          continue;
        }
      }

      // ── Reed strategy (browser board, own profile + result mapping) ─────────
      if (REED_ENABLED && isReedJob(job)) {
        queue.update(job.jobId, { status: 'applying' });
        if (!REED_SUBMIT) {
          // Reed's applyToJob has no fill-only mode, so a dry run can't exercise
          // it without really applying — mark as dry-run without touching Reed.
          queue.update(job.jobId, { status: 'skipped', reason: 'Reed dry-run (no fill-only mode)' });
          logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Reed dry-run — not exercised');
          console.log(`  [Auto-Apply] Reed (dry run) — not exercised (reed has no fill-only mode): ${job.title}`);
        } else {
          console.log(`  [Auto-Apply] Applying [reed]: ${job.title} @ ${job.company}`);
          try {
            const { page: reedPage } = await getSiteContext('reed_profile', reed.ensureLoggedIn);
            const applied = await reed.applyToJob(reedPage, job, job.cvPath);
            if (applied === true) {
              queue.update(job.jobId, { status: 'applied' }); queue.markApplied(job.jobId);
              logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'Reed');
              console.log(`  [Auto-Apply] ✓ Applied [reed]: ${job.title}`);
            } else if (applied === null || applied === 'external' || applied === 'cv_not_attached') {
              queue.update(job.jobId, { status: 'skipped', reason: 'Reed: ' + applied });
              logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', 'Reed ' + applied);
            } else {
              queue.update(job.jobId, { status: 'apply_failed' });
              logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLY_FAILED', 'Reed form could not be completed');
              console.log(`  [Auto-Apply] ✗ Apply failed [reed]: ${job.title}`);
            }
          } catch (err) {
            queue.update(job.jobId, { status: 'apply_failed', error: err.message });
            logger.log(job.title, job.company, job.url, 'N/A', 0, 'ERROR', err.message.substring(0, 100));
            console.error(`  [Auto-Apply] Reed error on "${job.title}": ${err.message}`);
          }
        }
        await DELAY(8000 + Math.random() * 7000);
        continue;
      }

      const ats = atsFiller.detectATS(job.url);
      // Prefer a pure-HTTP submitter (open ATSes like Recruitee): no browser,
      // no fragile form-fill. Falls through to the browser for the rest.
      const httpFn = httpSubmit.httpSubmitterFor(ats) || httpSubmit.httpSubmitterFor(job.source);
      queue.update(job.jobId, { status: 'applying' });
      console.log(`  [Auto-Apply] Applying${SUBMIT ? '' : ' (DRY RUN)'} [${ats}${httpFn ? ' · HTTP' : ''}]: ${job.title} @ ${job.company}`);
      try {
        let result;
        if (httpFn) {
          const A = cfg.APPLICANT || {};
          const r = await httpFn({ url: job.url, applicant: {
            firstName: A.firstName, lastName: A.lastName, email: A.email, phone: A.phone,
            // Needed to auto-answer Recruitee's required questions (RTW/sponsorship/salary).
            rightToWorkCountries: A.rightToWorkCountries, requiresSponsorship: A.requiresSponsorship,
            salaryExpectation: A.salaryExpectation, yearsExperience: A.yearsExperience, availability: A.availability,
          }, cvPath: job.cvPath, coverLetter: job.coverLetter || '', dryRun: !SUBMIT });
          if (!r.ok && !r.dryRun) console.log(`  [Auto-Apply] HTTP submit not accepted (${r.reason}${r.status ? ' ' + r.status : ''})`);
          result = r.submitted ? true : (r.dryRun ? 'dry_run' : false);
        } else {
          await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await DELAY(1500 + Math.random() * 1500);
          result = await atsFiller.fillExternalForm(page, job, job.cvPath, ats, { submit: SUBMIT });
        }

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
  // Recruitee submits over pure HTTP (no browser needed), but SmartRecruiters is
  // DataDome-guarded and only passes with a REAL browser on the user's own IP —
  // a headless Chrome gets flagged. So launch a real, MINIMISED (not headless)
  // browser: no visible window intruding, but a genuine fingerprint DataDome
  // accepts. JOBBOT_SHOW_BROWSER=1 keeps it visible for debugging.
  if (CDP_SPAWN) {
    // Spawn the user's real Chrome + attach over CDP (macOS-safe, no login).
    const { context, page, proc } = await spawnChromeWithCdp(profileDir);
    try { await stealth.applyToContext(context); } catch (_) {}
    return { context, page, proc };
  }
  // If "Connect account" left Chrome open on this profile, attach to it via CDP
  // instead of trying to launch a second instance on the (locked) profile — which
  // otherwise errors when the user forgets to close the connect window.
  const cdpPort = process.env.JOBBOT_CDP_PORT;
  if (cdpPort) {
    const attached = await connectToRunningChrome(parseInt(cdpPort, 10)).catch(() => null);
    if (attached) {
      try { await stealth.applyToContext(attached); } catch (_) {}
      const page = attached.pages()[0] || await attached.newPage();
      return { context: attached, page, proc: null };
    }
  }
  const context = await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const page = await context.newPage();
  return { context, page, proc: null };
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  ATS Auto-Apply Agent — Starting${SUBMIT ? '' : '  (DRY RUN — submissions disabled)'}${HEADLESS_ONLY ? '  [HEADLESS — HTTP-only, no browser]' : ''}`);
  console.log('═══════════════════════════════════════════════════════');

  // Recover jobs left in 'applying' from a previous interrupted run
  const stuck = queue.getByStatus('applying').filter(j => j.source === SOURCE);
  for (const j of stuck) queue.update(j.jobId, { status: 'cv_ready' });

  let context = null, page = null, guard = null, chromeProc = null;
  if (HEADLESS_ONLY) {
    // No browser at all: source + apply over pure HTTP (Recruitee). Browser-only
    // ATSes (SmartRecruiters etc.) are skipped in phase 2. This is the macOS path.
    console.log('  [Auto-Apply] Headless mode — no browser. Applies HTTP-only ATSes (e.g. Recruitee); browser-required jobs are skipped.');
  } else {
    try {
      ({ context, page, proc: chromeProc } = await launchBrowser());
      guard = watchForManualClose(context, 'Auto-Apply');
    } catch (err) {
      if (BROWSER_CLOSED_RE.test(err.message || '')) { console.log('  [Auto-Apply] Browser closed — agent stopped.'); process.exit(0); }
      console.error('  [Auto-Apply] Failed to launch browser: ' + err.message);
      process.exit(1);
    }
  }

  try {
    await phase1_sourceAndQueue(page);
    await phase2_applyReadyCVs(context, page);
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) console.log('  [Auto-Apply] Browser closed — agent stopped.');
    else console.error('  [Auto-Apply] Fatal: ' + err.message);
  } finally {
    if (guard) guard.intentional = true;
    await closeSiteContexts(); // close any per-site (Reed) profiles opened by the router
    await context?.close().catch(() => {});
    // A CDP-spawned Chrome keeps running after we disconnect — kill it explicitly.
    if (chromeProc) { try { chromeProc.kill(); } catch (_) {} }
  }
  console.log('  [Auto-Apply] Done.');
  process.exit(0);
}

main().catch(err => { console.error('  [Auto-Apply] Uncaught: ' + err.message); process.exit(1); });
