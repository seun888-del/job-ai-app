/**
 * Canada Government Jobs Agent (GC Jobs), Canada only.
 * ─────────────────────────────────────────────────────
 *  Phase 1: search GC Jobs (public, plain HTTP) for the user's job titles, read each poster and
 *           queue the ones applied for on GC Jobs (source 'gcjobs'). The Scorer checks the CV.
 *  Phase 2: in the agent's own browser (the user signs in to GC Jobs once), fill in every section
 *           of the application: notice, resume, screening questions (Yes only when the CV shows
 *           it), locations, tenure, classification, languages. Then submit it if the user turned
 *           on "Submit for me" and confirmed the GC Jobs notice in Job-AI.
 *
 * Education lives on the GC Jobs account: the user adds it once on GC Jobs.
 */
const path  = require('path');
const cfg   = require('./config');
const queue = require('./modules/queue_manager');
const logger = require('./modules/logger');
const salary = require('./modules/salary_filter');
const stealth = require('./modules/stealth');
const titleMatch = require('./modules/title_match');
const gc = require('./modules/gc_jobs');
const { applyToJob, ensureLogin } = require('./modules/gc_apply');
const { launchPersistentContext, watchForManualClose, BROWSER_CLOSED_RE } = require('./modules/browser_launcher');

const SOURCE = 'gcjobs';
const ROUND_MS = 30 * 60 * 1000;
const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  [GC Jobs] ${m}`);

const prefs = () => {
  const g = cfg.GC || {};
  return {
    location: cfg.APPLICANT.location || '', relocate: !!(g.relocate || cfg.APPLICANT.willingToRelocate),
    cities: Array.isArray(g.cities) ? g.cities : String(g.cities || '').split(',').map((s) => s.trim()).filter(Boolean),
    firstLang: g.firstLang || 'English', englishLevel: g.englishLevel || '', frenchLevel: g.frenchLevel || 'None', hasSle: !!g.hasSle,
  };
};
// Submitting needs both: the "Submit for me" switch and the confirmation of the GC Jobs notice.
const autoSubmit = () => { const g = cfg.GC || {}; return g.autoSubmit !== false && !!g.confirmed; };

async function phase1() {
  const terms = (cfg.JOB_SEARCHES || []).map((t) => String(t).trim()).filter(Boolean);
  if (!terms.length) { log('Add job titles in Search Preferences to find Government of Canada jobs.'); return; }
  const matchers = titleMatch.compile(terms);
  const p = prefs();
  const french = p.frenchLevel === 'Advanced' && p.hasSle;
  let queued = 0;
  for (const term of terms) {
    let jobs = [];
    try { jobs = await gc.search(term); } catch (e) { log(`Search failed for "${term}": ${e.message}`); continue; }
    const fits = jobs.filter((j) => titleMatch.titleMatches(j.title, matchers));
    log(`"${term}": ${jobs.length} job(s) open to the public, ${fits.length} match your title.`);
    for (const j of fits) {
      if (queue.has(j.jobId) || queue.wasApplied(j.jobId)) continue;
      if (cfg.TITLE_BLOCKLIST.some((k) => j.title.toLowerCase().includes(k))) continue;
      if (cfg.COMPANY_BLOCKLIST.some((b) => j.company.toLowerCase().includes(b))) continue;
      const base = { jobId: j.jobId, title: j.title, company: j.company, url: j.url, source: SOURCE,
        extra: { poster: j.poster, location: j.location, closes: j.closes, pay: j.pay, language: j.language } };
      const skip = (reason) => queue.add({ ...base, status: 'skipped', reason });
      if (/bilingual|french essential/i.test(j.language) && !/various/i.test(j.language) && !french) { skip(`Needs French (${j.language})`); continue; }
      const poster = await gc.fetchPoster(j.poster).catch(() => ({ ok: false }));
      await DELAY(800);
      if (!poster.ok) continue;
      if (poster.external) { skip("Applied for on the organization's own website"); continue; }
      const description = `${j.pay ? `Pay: ${j.pay}. ` : ''}${poster.text}`;
      if (description.split(/\s+/).length < 80) { skip('Job description too short'); continue; }
      if (!salary.isAcceptable(description, cfg.APPLICANT.salaryExpectation)) { skip('Below your salary expectation'); continue; }
      queue.add({ ...base, description, extra: { ...base.extra, ref: poster.ref, who: poster.who } });
      queued++;
      log(`Found: ${j.title} @ ${j.company}`);
    }
  }
  log(`Search done: ${queued} new job(s) for the Scorer.`);
}

function dropClosed() {
  const today = new Date().toISOString().slice(0, 10);
  for (const st of ['pending', 'cv_ready']) {
    for (const j of queue.getByStatus(st).filter((x) => x.source === SOURCE && x.extra && x.extra.closes && x.extra.closes < today)) {
      queue.update(j.jobId, { status: 'skipped', reason: 'Closed before it was sent' });
    }
  }
}

async function phase2(page, until) {
  let signedIn = false;
  while (Date.now() < until) {
    const ready = queue.getByStatus('cv_ready').filter((j) => j.source === SOURCE);
    if (ready.length && !signedIn) {
      signedIn = await ensureLogin(page, console.log);
      if (!signedIn) { log('Not signed in to GC Jobs. Holding applications until you sign in.'); await DELAY(Math.max(0, until - Date.now())); return; }
    }
    for (const job of ready) {
      if (queue.countAppliedToday() >= cfg.MAX_APPLICATIONS_PER_DAY) { log('Daily limit reached.'); await DELAY(Math.max(0, until - Date.now())); return; }
      console.log(`\n  [GC Jobs] ── ${job.title} @ ${job.company}`);
      queue.update(job.jobId, { status: 'applying' });
      const ex = job.extra || {};
      let r;
      try {
        r = await applyToJob(page, { job: { poster: ex.poster, ref: ex.ref, title: job.title, company: job.company },
          cvText: ex.resumeText || '', resumeText: ex.resumeText || '', prefs: prefs(), submit: autoSubmit(), log: console.log });
      } catch (e) {
        if (BROWSER_CLOSED_RE.test(e.message || '')) throw e;
        r = { result: 'failed', note: e.message };
      }
      const keep = { ...ex };
      if (r.result === 'applied') {
        queue.update(job.jobId, { status: 'applied', reason: 'Submitted on GC Jobs' }); queue.markApplied(job.jobId);
        logger.log(job.title, job.company, job.url, job.cvName, job.cvScore, 'APPLIED', 'GC Jobs');
        log(`✓ Submitted: ${job.title}`);
      } else if (r.result === 'ready') {
        queue.update(job.jobId, { status: 'ready_to_submit', reason: r.note, extra: keep }); queue.markCapCounted(job.jobId);
        log(`✓ Ready for you to submit on GC Jobs: ${job.title}`);
      } else if (r.result === 'needs_login') {
        queue.update(job.jobId, { status: 'cv_ready' }); signedIn = false;
        log('The GC Jobs session ended. Signing in again.');
        break;
      } else {
        const reason = { needs_user: `Needs you on GC Jobs: ${r.note}`, not_eligible: `Not sent: ${r.note}`, closed: 'Closed before it was sent', external: r.note }[r.result] || `Could not finish: ${r.note}`;
        queue.update(job.jobId, { status: r.result === 'failed' ? 'apply_failed' : 'skipped', reason });
        log(`✗ ${job.title}: ${reason}`);
      }
      await DELAY(5000 + Math.random() * 4000);
    }
    await DELAY(15000);
  }
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Canada Government Jobs Agent (GC Jobs) — Starting${autoSubmit() ? ' (Submit for me is ON)' : ' (you submit on GC Jobs)'}`);
  console.log('═══════════════════════════════════════════════════════');
  if ((cfg.APPLICANT || {}).country !== 'Canada') { log('Government of Canada jobs are for Canada. Switch Find jobs in to Canada to use this agent.'); process.exit(0); }
  if (!(cfg.GC || {}).wants) { log('Turn on Government of Canada jobs in Setup first.'); process.exit(0); }
  for (const j of queue.getByStatus('applying').filter((x) => x.source === SOURCE)) queue.update(j.jobId, { status: 'cv_ready' });

  let context, page, guard;
  try {
    context = await launchPersistentContext(path.join(process.env.JOBBOT_USERDATA, 'gc_profile'));
    await stealth.applyToContext(context).catch(() => {});
    page = context.pages()[0] || await context.newPage();
    guard = watchForManualClose(context, 'GC Jobs Agent');
  } catch (e) {
    if (BROWSER_CLOSED_RE.test(e.message || '')) process.exit(0);
    console.error('  [GC Jobs] Could not open the browser: ' + e.message); process.exit(1);
  }
  try {
    for (;;) {
      await cfg.init().catch(() => {});
      dropClosed();
      await phase1();
      await phase2(page, Date.now() + ROUND_MS);
    }
  } catch (e) {
    if (BROWSER_CLOSED_RE.test(e.message || '')) log('Browser closed, stopped.');
    else console.error('  [GC Jobs] Fatal: ' + e.message);
  } finally {
    if (guard) guard.intentional = true;
    try { await context?.close(); } catch (_) {}
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error('  [GC Jobs] Uncaught: ' + e.message); process.exit(1); });
module.exports = { phase1 };
