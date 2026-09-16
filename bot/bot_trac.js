/**
 * Trac Agent (NHS / HealthJobsUK)
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 — search NHS/Trac for the user's terms (pure HTTP, headless) and, for
 *           each hit, read the JD in the real browser (advert pages are Cloudflare-
 *           blocked to plain HTTP), then queue it for the Scorer to tailor.
 * Phase 2 — for each tailored (cv_ready) Trac job, drive the multi-page Trac form
 *           using the field map (bot/specs/trac_form.json via trac_apply.js).
 *
 * SAFE BY DEFAULT: dry run unless JOBBOT_TRAC_SUBMIT=1, and the sensitive/legal
 * fields (criminal record, immigration, equality, disability, declaration) are
 * NEVER auto-answered — they're surfaced for the user to confirm. One handler
 * covers every NHS trust because Trac is a single system.
 */

const path        = require('path');
const cfg         = require('./config');
const queue       = require('./modules/queue_manager');
const logger      = require('./modules/logger');
const salary      = require('./modules/salary_filter');
const stealth     = require('./modules/stealth');
const trac        = require('./modules/trac_source');
const { fillApplication, ensureTracLogin } = require('./modules/trac_apply');
const { launchPersistentContext, connectToRunningChrome, spawnChromeWithCdp, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');

const DELAY  = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL   = 10000;
const SOURCE = 'trac';
// Off = DRY RUN (fills the form but never submits). NHS applications are high-stakes,
// so real submit is an explicit, supervised opt-in.
const SUBMIT = process.env.JOBBOT_TRAC_SUBMIT === '1';

let _spawnedChrome = null;
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) process.on(sig, () => { try { _spawnedChrome && _spawnedChrome.kill(); } catch (_) {} });

const isRelevantTitle = (title) => { const t = (title || '').toLowerCase(); return !cfg.TITLE_BLOCKLIST.some((k) => t.includes(k)); };
const isBlockedCompany = (c) => { const cc = (c || '').toLowerCase(); return (cfg.COMPANY_BLOCKLIST || []).some((b) => cc.includes(b)); };

// HealthJobsUK keyword search is loose (e.g. "IT Support Specialist" returns every
// clinical "...Specialist" role), so pre-filter by title BEFORE the costly in-browser
// JD fetch: keep only titles that share a meaningful, non-generic word with one of
// the user's own search terms. This is user-driven (no hard-coded niche) and kills
// the clinical noise for an IT/admin searcher while keeping NHS clinical jobs for a
// clinical searcher.
const GENERIC_TITLE_WORDS = new Set(('specialist senior junior band assistant highly trainee apprentice nhs trust foundation the and of for in at role post manager officer lead coordinator practitioner worker healthcare community hospital care team').split(/\s+/));
const termKeywords = (terms) => {
  const s = new Set();
  for (const t of terms || []) for (const w of String(t).toLowerCase().match(/[a-z0-9+#]{2,}/g) || []) if (!GENERIC_TITLE_WORDS.has(w)) s.add(w);
  return s;
};
const titleMatchesTerms = (title, kw) => {
  if (!kw.size) return true; // no terms → don't over-filter
  const words = String(title || '').toLowerCase().match(/[a-z0-9+#]{2,}/g) || [];
  return words.some((w) => kw.has(w));
};

async function launchBrowser() {
  const profileDir = path.join(process.env.JOBBOT_USERDATA, 'trac_profile');
  if (process.env.JOBBOT_CDP_SPAWN === '1') {
    const { context, page, proc } = await spawnChromeWithCdp(profileDir);
    _spawnedChrome = proc;
    try { await stealth.applyToContext(context); } catch (_) {}
    return { context, page };
  }
  // Attach to a still-open "Connect account" Chrome (locked profile) instead of
  // launching a second instance and erroring.
  const cdpPort = process.env.JOBBOT_CDP_PORT;
  if (cdpPort) {
    const attached = await connectToRunningChrome(parseInt(cdpPort, 10)).catch(() => null);
    if (attached) {
      try { await stealth.applyToContext(attached); } catch (_) {}
      const page = attached.pages()[0] || await attached.newPage();
      return { context: attached, page };
    }
  }
  const context = await launchPersistentContext(profileDir);
  await stealth.applyToContext(context);
  const page = await context.newPage();
  return { context, page };
}

async function phase1(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  [Trac Agent] Phase 1 — searching NHS/Trac (HealthJobsUK)');
  console.log('══════════════════════════════════════════════════════');
  const kw = termKeywords(cfg.JOB_SEARCHES);
  for (const term of cfg.JOB_SEARCHES) {
    let jobs = [];
    try { jobs = await trac.searchTrac(term, { pages: 1 }); }
    catch (e) { console.log(`  [Trac] search failed for "${term}": ${e.message}`); continue; }
    // Drop the loose-match noise up front (before any browser JD fetch).
    const before = jobs.length;
    jobs = jobs.filter((j) => titleMatchesTerms(j.title, kw));
    console.log(`  [Trac] "${term}" → ${before} job(s), ${jobs.length} on-target after title filter`);
    for (const job of jobs) {
      if (queue.has(job.jobId) || queue.wasApplied(job.jobId)) continue;
      if (!isRelevantTitle(job.title)) continue;
      if (isBlockedCompany(job.company)) continue;
      if (queue.hasCanonical(job.title, job.company)) continue;

      // JD via the real browser (advert pages are bot-blocked to plain HTTP).
      const jd = await trac.fetchTracJD(job.url, page).catch(() => '');
      if (!jd || jd.split(/\s+/).length < 60) {
        queue.add({ ...job, source: SOURCE, status: 'skipped', reason: 'JD too short or blocked' });
        continue;
      }
      if (!salary.isAcceptable(jd, cfg.APPLICANT.salaryExpectation)) {
        queue.add({ ...job, source: SOURCE, status: 'skipped', reason: 'Below salary expectation' });
        continue;
      }
      queue.add({ ...job, description: jd, source: SOURCE });
      console.log(`  [Trac] → Queued for Scorer: ${job.title} @ ${job.company}`);
      await DELAY(1500);
    }
  }
  const pending = queue.getByStatus('pending').filter((j) => j.source === SOURCE).length;
  console.log(`  [Trac Agent] Phase 1 complete. ${pending} job(s) queued.`);
}

async function phase2(page) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  [Trac Agent] Phase 2 — applying${SUBMIT ? '' : ' (DRY RUN — not submitted)'}`);
  console.log('══════════════════════════════════════════════════════');

  // Sign in once (the user completes it in the visible browser); the session
  // persists in trac_profile. Until signed in, hold the Trac jobs (leave them
  // cv_ready) so a later run applies them — don't burn them as skipped.
  const signedIn = await ensureTracLogin(page, console.log);
  if (!signedIn) {
    console.log('  [Trac Agent] Not signed in to Trac — holding applications until you log in and restart.');
    return;
  }

  let idle = 0;
  while (true) {
    const ready = queue.getByStatus('cv_ready').filter((j) => j.source === SOURCE);
    for (const job of ready) {
      if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Trac Agent] Daily limit reached — pausing.`);
        return;
      }
      console.log(`\n  [Trac Agent] ── ${job.title} @ ${job.company}`);
      queue.update(job.jobId, { status: 'applying' });
      const { result, paused } = await fillApplication(page, {
        job, applicant: cfg.APPLICANT || {}, supportingStatement: job.coverLetter || '', submit: SUBMIT, log: console.log,
      });
      if (result === 'applied') {
        queue.update(job.jobId, { status: 'applied' }); queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'Trac');
        console.log(`  [Trac Agent] ✓ Applied: ${job.title}`);
      } else if (result === 'needs_login') {
        queue.update(job.jobId, { status: 'skipped', reason: 'Trac login needed — sign in to your NHS/Trac account in the agent browser' });
      } else if (result === 'blocked') {
        queue.update(job.jobId, { status: 'skipped', reason: 'Trac advert blocked (bot-check)' });
      } else if (result === 'dry_run') {
        const note = `Dry run — form filled${paused.length ? `, ${paused.length} sensitive field(s) to confirm` : ''}`;
        queue.update(job.jobId, { status: 'skipped', reason: note });
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'SKIPPED', note);
      } else {
        queue.update(job.jobId, { status: 'apply_failed' });
      }
      await DELAY(6000 + Math.random() * 5000);
    }
    idle = ready.length ? 0 : idle + 1;
    if (idle && idle % 6 === 0) console.log('  [Trac Agent] Waiting for tailored jobs...');
    await DELAY(POLL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Trac Agent (NHS) — Starting${SUBMIT ? '' : '  (DRY RUN — submissions disabled)'}`);
  console.log('═══════════════════════════════════════════════════════');

  const stuck = queue.getByStatus('applying').filter((j) => j.source === SOURCE);
  for (const j of stuck) queue.update(j.jobId, { status: 'cv_ready' });

  let context, page, guard;
  try {
    ({ context, page } = await launchBrowser());
    guard = watchForManualClose(context, 'Trac Agent');
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) { console.log('  [Trac Agent] Browser closed — stopped.'); process.exit(0); }
    console.error('  [Trac Agent] Failed to launch browser: ' + err.message);
    process.exit(1);
  }

  try {
    await phase1(page);
    await phase2(page);
  } catch (err) {
    if (BROWSER_CLOSED_RE.test(err.message || '')) console.log('  [Trac Agent] Browser closed — stopped.');
    else console.error('  [Trac Agent] Fatal: ' + err.message);
  } finally {
    if (guard) guard.intentional = true;
    try { await context?.close(); } catch (_) {}
    if (_spawnedChrome) { try { _spawnedChrome.kill(); } catch (_) {} }
  }
  process.exit(0);
}

main().catch((err) => { console.error('  [Trac Agent] Uncaught: ' + err.message); process.exit(1); });
