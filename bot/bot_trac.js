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
const { fillApplication, ensureTracLogin, listDraftApplications, listTracApplications } = require('./modules/trac_apply');
const { launchPersistentContext, connectToRunningChrome, spawnChromeWithCdp, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');

const DELAY  = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL   = 10000;
const CYCLE_MS = 10 * 60 * 1000; // re-search NHS jobs and re-check drafts every 10 minutes (search is ~15s)
// A Trac draft recorded under 'trac_draft_<id>' whose title matches this advert's title.
function hasDraftFor(title) {
  const k = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
  const t = k(title); if (!t) return false;
  return queue.read().some((j) => String(j.jobId || '').startsWith('trac_draft_') && k(j.title) && k(j.title).length >= 8 && (k(j.title).startsWith(t) || t.startsWith(k(j.title))));
}
const SOURCE = 'trac';
// Tell the Scorer we're filling a form so it pauses its AI work (the AI account has a
// per-minute limit shared by both). Always cleared, even if filling throws.
async function fillWhileScorerWaits(page, opts) {
  try { queue.setMeta('trac_filling', String(Date.now())); } catch (_) {}
  try { return await fillApplication(page, opts); }
  finally { try { queue.setMeta('trac_filling', ''); } catch (_) {} }
}
// Off = DRY RUN (fills the form but never submits). NHS applications are high-stakes,
// so real submit is an explicit, supervised opt-in.
// The user's "Submit for me" switch (NHS agent card), off by default. Read each time so a
// change applies on the next round. Applications that ask about AI use are never auto-submitted.
const autoSubmit = () => process.env.JOBBOT_TRAC_SUBMIT === '1' || ((cfg.TRAC_DETAILS || {}).autoSubmit === true);
const AI_NOTE = ' This form asks about AI use, so you submit it yourself.';

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
// Title filter shared with the Chrome extension: a title must contain the whole term or ALL of
// its key words (see bot/modules/title_match.js).
const titleMatch = require('./modules/title_match');


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
  // NHS job titles are worded differently from private-sector ones, so the user can keep
  // their own NHS search terms on the NHS / Trac page. Empty → use the main search terms.
  const own = (cfg.TRAC_DETAILS && Array.isArray(cfg.TRAC_DETAILS.searchTerms)) ? cfg.TRAC_DETAILS.searchTerms.map((t) => String(t).trim()).filter(Boolean) : [];
  const terms = own.length ? own : (cfg.JOB_SEARCHES || []);
  console.log(`  [Trac] Search terms: ${own.length ? 'your NHS terms' : 'your main search terms'} (${terms.length})`);
  const matchers = titleMatch.compile(terms);
  // Land straight on the relevant job family/families (Admin, Support, Health Science…).
  // Prefer the sectors the user explicitly ticked in NHS/Trac details; otherwise infer
  // them from the user's own search terms. Either way: no homepage/sector-tile hopping,
  // and no clinical noise for a non-clinical searcher.
  const chosen = (cfg.TRAC_SECTORS || []).filter((s) => trac.SECTORS[s]);
  const sectors = chosen.length ? chosen : trac.sectorsForTerms(terms);
  console.log(`  [Trac] Searching sector(s): ${sectors.map((s) => trac.SECTORS[s] || s).join(', ')}${chosen.length ? ' (your selection)' : ' (auto from search terms)'}`);
  for (const term of terms) {
    let jobs = [];
    try { jobs = await trac.searchTrac(term, { pages: 1, sectors, page }); }
    catch (e) { console.log(`  [Trac] search failed for "${term}": ${e.message}`); continue; }
    // Drop the loose-match noise up front (before any browser JD fetch).
    const before = jobs.length;
    jobs = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
    console.log(`  [Trac] "${term}" → ${before} job(s), ${jobs.length} on-target after title filter`);
    for (const job of jobs) {
      if (queue.has(job.jobId) || queue.wasApplied(job.jobId)) continue;
      if (!isRelevantTitle(job.title)) continue;
      if (isBlockedCompany(job.company)) continue;
      if (queue.hasCanonical(job.title, job.company)) continue;
      // Already have a Trac draft for this role (recorded from the draft list): never start a second one.
      if (hasDraftFor(job.title)) continue;

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

// Go back and FINISH the applicant's existing incomplete drafts (not just brand-new jobs).
// This resumes each draft straight at its application summary and runs the section loop to
// complete the sections still outstanding. Opt out with JOBBOT_TRAC_RESUME=0.
async function resumeDrafts(page) {
  if (process.env.JOBBOT_TRAC_RESUME === '0') return;
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  [Trac Agent] Finishing incomplete drafts${autoSubmit() ? ' (Submit for me is ON)' : ' (you submit them)'}`);
  console.log('══════════════════════════════════════════════════════');
  const signedIn = await ensureTracLogin(page, console.log);
  if (!signedIn) { console.log('  [Trac Agent] Not signed in — cannot resume drafts.'); return; }

  let drafts = [], submittedTitles = [];
  try { ({ drafts, submittedTitles } = await listTracApplications(page)); }
  catch (e) { console.log('  [Trac Agent] Could not read your Trac applications: ' + e.message); return; }
  console.log(`  [Trac Agent] Found ${drafts.length} incomplete draft(s) to finish.`);

  // A job whose draft is gone (you deleted it, or Trac removed it) is started again from
  // scratch, not treated as done. Never re-applies to anything you've already SUBMITTED,
  // and only retries each job twice so a job you deliberately dropped isn't recreated forever.
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
  const draftKeys = drafts.map((d) => key(d.title));
  const sentKeys = submittedTitles.map(key);
  const hasTitle = (list, t) => { const k = key(t); return k && list.some((x) => x && (x.includes(k.slice(0, 25)) || k.includes(x.slice(0, 25)))); };
  let restarted = 0;
  // If any draft's title still couldn't be read, we can't tell which jobs have drafts, so
  // restart nothing this round (better than risking a duplicate application).
  const titlesKnown = drafts.every((d) => d.title && d.title.length > 5);
  if (!titlesKnown) console.log('  [Trac Agent] Could not read every draft title, skipping restarts this round.');
  for (const j of titlesKnown ?  [...queue.getByStatus('skipped'), ...queue.getByStatus('ready_to_submit')].filter((x) => x.source === SOURCE) : []) {
    const wasOurs = /^Draft saved on Trac|^Every section complete|^Filled and saved as a draft/i.test(j.reason || '');
    if (!wasOurs || (j.retryCount || 0) >= 2) continue;
    if (hasTitle(draftKeys, j.title) || hasTitle(sentKeys, j.title)) continue;
    queue.update(j.jobId, { status: 'cv_ready', reason: 'Draft not found on Trac, starting again', retryCount: (j.retryCount || 0) + 1 });
    restarted++;
  }
  if (restarted) console.log(`  [Trac Agent] ${restarted} job(s) had no draft on Trac any more, starting them again.`);

  for (const d of drafts) {
    if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) { console.log('  [Trac Agent] Daily limit reached — pausing.'); return; }
    console.log(`\n  [Trac Agent] ── Resuming draft: ${d.title}`);
    try {
      // The queue job this draft belongs to (matched by title), so the outcome shows on the
      // dashboard and the role's own supporting statement is used.
      const dk = key(d.title);
      // Match on the START of the title (Trac shortens draft titles), never on a word found
      // anywhere: "Administrator" must not claim "Band 4 Ward Administrator - Ardenleigh".
      // Prefer the closest (longest shared) match.
      const owner = dk.length < 8 ? null : queue.read()
        .filter((j) => j.source === SOURCE && key(j.title).length >= 8 && (key(j.title).startsWith(dk) || dk.startsWith(key(j.title))))
        .sort((a, b) => Math.min(key(b.title).length, dk.length) - Math.min(key(a.title).length, dk.length) || (b.status === 'ready_to_submit') - (a.status === 'ready_to_submit'))[0];
      // Already confirmed complete: nothing to do until you submit it on Trac.
      if (owner && /^Vacancy closed/.test(owner.reason || '')) { console.log('  [Trac Agent] Vacancy closed, skipping.'); continue; }
      const aiBlocked = !!(owner && /asks about AI use/.test(owner.reason || ''));
      if (owner && owner.status === 'ready_to_submit' && (!autoSubmit() || aiBlocked)) { if (!owner.draftUrl && d.url) queue.update(owner.jobId, { draftUrl: d.url }); console.log('  [Trac Agent] Already complete, waiting for you to submit it on Trac.'); continue; }
      const { result, paused = [], status, aiQuestion } = await fillWhileScorerWaits(page, {
        job: owner ? { ...owner, url: d.url } : d, resume: true, applicant: cfg.APPLICANT || {}, details: cfg.TRAC_DETAILS || {},
        supportingStatement: (owner && owner.coverLetter) || '', submit: autoSubmit(), blockSubmit: aiBlocked, log: console.log,
      });
      console.log(`  [Trac Agent] Draft ${d.id} → ${result}`);
      // No queue record (e.g. the queue was cleared): record the draft so it isn't re-checked
      // every round and the search never queues the same role again.
      if (!owner && result === 'dry_run') {
        const complete = status && status.total && !status.notOk.length && status.groupsOpen === 0;
        queue.add({ jobId: 'trac_draft_' + d.id, title: d.title, company: '', url: d.url, source: SOURCE, status: complete ? 'ready_to_submit' : 'skipped', reason: complete ? 'Every section complete. Open it on Trac and press Submit.' : 'Draft saved on Trac. Needs you: check the draft.', draftUrl: d.url });
      }
      if (owner && result === 'applied') {
        queue.update(owner.jobId, { status: 'applied', reason: 'Submitted on Trac', draftUrl: d.url }); queue.markApplied(owner.jobId);
        logger.log(owner.title, owner.company, owner.url, owner.cvName, owner.cvScore, 'APPLIED', 'Trac');
        console.log(`  [Trac Agent] ✓ Submitted: ${owner.title}`);
      }
      if (owner && result === 'dry_run') {
        const missing = [...new Set([...(status && status.notOk ? status.notOk : []), ...paused.map((p) => p.field)])].filter(Boolean);
        const complete = status && status.total && !status.notOk.length && status.groupsOpen === 0;
        const note = complete ? 'Every section complete. Open it on Trac and press Submit.' : `Draft saved on Trac. Needs you: ${missing.slice(0, 6).join('; ') || 'check the draft'}${missing.length > 6 ? ` (+${missing.length - 6} more)` : ''}.`;
        queue.update(owner.jobId, { status: complete ? 'ready_to_submit' : 'skipped', reason: note + ((aiQuestion || aiBlocked) ? AI_NOTE : ''), draftUrl: d.url });
        console.log(`  [Trac Agent] ${complete ? '✓ Ready to submit' : '⚠ Needs your input'}: ${owner.title}. ${note}`);
      }
      if (result === 'closed') {
        if (owner) queue.update(owner.jobId, { status: 'skipped', reason: 'Vacancy closed before it was submitted' });
        else queue.add({ jobId: 'trac_draft_' + d.id, title: d.title, company: '', url: d.url, source: SOURCE, status: 'skipped', reason: 'Vacancy closed before it was submitted' });
        console.log(`  [Trac Agent] Closed: ${d.title}. The deadline passed, removed from your list.`);
      }
      if (result === 'needs_login') return; // session died — stop, user re-signs in
    } catch (e) {
      if (BROWSER_CLOSED_RE.test(e.message || '')) throw e;
      console.log(`  [Trac Agent] Draft ${d.id} error: ${e.message}`);
    }
    await DELAY(4000 + Math.random() * 3000);
  }
  console.log('  [Trac Agent] Draft resume pass complete.');
}

async function phase2(page, until = Infinity) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  [Trac Agent] Phase 2 — applying${autoSubmit() ? ' (Submit for me is ON)' : ' (you submit them)'}`);
  console.log('══════════════════════════════════════════════════════');

  // Sign in once (the user completes it in the visible browser); the session
  // persists in trac_profile. Until signed in, hold the Trac jobs (leave them
  // cv_ready) so a later run applies them — don't burn them as skipped.
  const signedIn = await ensureTracLogin(page, console.log);
  if (!signedIn) {
    console.log('  [Trac Agent] Not signed in to Trac. Holding applications; will check again next cycle.');
    await DELAY(Math.max(0, Math.min(until, Date.now() + CYCLE_MS) - Date.now()));
    return;
  }

  let idle = 0;
  while (Date.now() < until) {
    const ready = queue.getByStatus('cv_ready').filter((j) => j.source === SOURCE);
    for (const job of ready) {
      if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) {
        console.log(`  [Trac Agent] Daily limit reached. Pausing until the next cycle.`);
        await DELAY(Math.max(0, Math.min(until, Date.now() + CYCLE_MS) - Date.now()));
        return;
      }
      console.log(`\n  [Trac Agent] ── ${job.title} @ ${job.company}`);
      queue.update(job.jobId, { status: 'applying' });
      const { result, paused, status, draftUrl, aiQuestion } = await fillWhileScorerWaits(page, {
        job, applicant: cfg.APPLICANT || {}, details: cfg.TRAC_DETAILS || {}, supportingStatement: job.coverLetter || '', submit: autoSubmit(), log: console.log,
        // Copy from a FINISHED application (newest first) when starting a new form.
        preferCopyFrom: queue.getByStatus('ready_to_submit').filter((j) => j.source === SOURCE).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).map((j) => j.title),
      });
      if (result === 'applied') {
        queue.update(job.jobId, { status: 'applied', reason: 'Submitted on Trac', ...(draftUrl ? { draftUrl } : {}) }); queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'Trac');
        console.log(`  [Trac Agent] ✓ Applied: ${job.title}`);
      } else if (result === 'needs_login') {
        queue.update(job.jobId, { status: 'skipped', reason: 'Trac login needed — sign in to your NHS/Trac account in the agent browser' });
      } else if (result === 'closed') {
        queue.update(job.jobId, { status: 'skipped', reason: 'Vacancy closed (no longer accepting applications)' });
      } else if (result === 'blocked') {
        queue.update(job.jobId, { status: 'skipped', reason: 'Trac advert blocked (bot-check)' });
      } else if (result === 'dry_run') {
        // The form is filled and saved as a draft on Trac: the user only has to press Submit.
        // Record it as progress ("ready to submit"), not as a skip.
        // Say exactly what's missing (friend's step 3: "let you know if it needs info").
        const missing = [...new Set([...(status && status.notOk ? status.notOk : []), ...paused.map((p) => p.field)])].filter(Boolean);
        const complete = status && status.total && !status.notOk.length && status.groupsOpen === 0;
        const note = complete
          ? 'Every section complete. Open it on Trac and press Submit.'
          : `Draft saved on Trac. Needs you: ${missing.slice(0, 6).join('; ') || 'check the draft'}${missing.length > 6 ? ` (+${missing.length - 6} more)` : ''}.`;
        queue.update(job.jobId, { status: complete ? 'ready_to_submit' : 'skipped', reason: note + (aiQuestion ? AI_NOTE : ''), ...(draftUrl ? { draftUrl } : {}) });
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, complete ? 'READY TO SUBMIT' : 'NEEDS INFO', note);
        console.log(`  [Trac Agent] ${complete ? '✓ Ready to submit' : '⚠ Needs your input'}: ${job.title}. ${note}`);
      } else {
        queue.update(job.jobId, { status: 'apply_failed' });
      }
      await DELAY(6000 + Math.random() * 5000);
    }
    idle = ready.length ? 0 : idle + 1;
    if (idle && idle % 30 === 0) {
      // Say plainly why it's quiet, so idle never looks like stuck.
      const preparing = [...queue.getByStatus('pending'), ...queue.getByStatus('processing')].filter((j) => j.source === SOURCE).length;
      const next = new Date(until).toTimeString().slice(0, 5);
      console.log(preparing
        ? `  [Trac Agent] ${preparing} NHS job(s) being prepared (supporting statement). Will apply as soon as they are ready.`
        : `  [Trac Agent] Nothing new to apply to: every matching NHS job has been handled. Next search at ${next}. Add more NHS search terms to find more roles.`);
    }
    await DELAY(POLL);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Trac Agent (NHS) — Starting${autoSubmit() ? '  (Submit for me is ON)' : '  (you submit applications yourself)'}`);
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
    // Keep working: search for newly posted jobs, restart jobs whose draft disappeared,
    // finish open drafts, then apply to whatever is ready. Repeat every CYCLE_MS.
    for (;;) {
      // Pick up anything changed in the app since the last cycle (search terms, NHS
      // details such as referee dates) without needing a restart.
      await cfg.init().catch(() => {});
      await phase1(page);
      await resumeDrafts(page);
      await phase2(page, Date.now() + CYCLE_MS);
    }
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
