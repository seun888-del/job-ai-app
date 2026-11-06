// Read-only view onto queue.db for the Dashboard. The bots own queue.db
// (read-modify-write via bot/modules/queue_manager.js) — this module never
// writes, so it just re-opens the file fresh on every call.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { readDbFile, writeDbFile } = require('../../bot/db/safeFile');

let dbPath;

function init(userDataPath) {
  dbPath = path.join(userDataPath, 'queue.db');
}

async function withQueueDb(fn, fallback) {
  if (!dbPath || !fs.existsSync(dbPath)) return fallback;
  const SQL = await initSqlJs();
  const buffer = readDbFile(dbPath);
  const db = new SQL.Database(buffer);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function all(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// How many genuinely-applied jobs are not yet logged to the UC journal.
// Guarded: the uc_logged_at column may not exist on an older queue.db.
function getUcPendingCount() {
  return withQueueDb(db => {
    try {
      const rows = all(db, "SELECT COUNT(*) AS c FROM applied_jobs WHERE uc_logged_at IS NULL AND title IS NOT NULL AND title != ''");
      return rows[0]?.c || 0;
    } catch (_) {
      const rows = all(db, "SELECT COUNT(*) AS c FROM applied_jobs WHERE title IS NOT NULL AND title != ''");
      return rows[0]?.c || 0;
    }
  }, 0);
}

// The applied jobs not yet logged to the UC journal, oldest first, as a list the
// user can copy into their journal themselves (the assisted / non-automated flow).
function getUcPendingList(limit = 200) {
  return withQueueDb(db => {
    let rows;
    try {
      rows = all(db, "SELECT job_id, title, company, applied_at FROM applied_jobs WHERE uc_logged_at IS NULL AND title IS NOT NULL AND title != '' ORDER BY applied_at ASC LIMIT ?", [limit]);
    } catch (_) {
      rows = all(db, "SELECT job_id, title, company, applied_at FROM applied_jobs WHERE title IS NOT NULL AND title != '' ORDER BY applied_at ASC LIMIT ?", [limit]);
    }
    return rows.map(r => ({ jobId: r.job_id, title: r.title, company: r.company || '', appliedAt: r.applied_at }));
  }, []);
}

// Every application the agents really sent, newest first, for the US work search log
// (date, employer, position, how and where applied). Real applied dates only.
function getWorkSearchLog(limit = 2000) {
  return withQueueDb(db => {
    const rows = all(db, `SELECT a.job_id, a.title, a.company, a.applied_at, q.url, q.source
      FROM applied_jobs a LEFT JOIN queue q ON q.job_id = a.job_id
      WHERE a.title IS NOT NULL AND a.title != '' ORDER BY a.applied_at DESC LIMIT ?`, [limit]);
    return rows.map(r => ({ jobId: r.job_id, title: r.title, company: r.company || '', appliedAt: r.applied_at, url: r.url || '', source: r.source || String(r.job_id || '').split('_')[0] }));
  }, []);
}

// The ONE write this otherwise read-only module performs: after the user has
// copied their log into their UC journal by hand, mark those applications logged
// so they drop off the pending list. Rare, user-initiated; uses the same
// read-modify-write-whole-file approach the bots use for queue.db.
async function markUcLoggedManual(jobIds) {
  if (!dbPath || !fs.existsSync(dbPath) || !Array.isArray(jobIds) || jobIds.length === 0) return 0;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    try { db.run("ALTER TABLE applied_jobs ADD COLUMN uc_logged_at TEXT"); } catch (_) {}
    for (const id of jobIds) {
      db.run("UPDATE applied_jobs SET uc_logged_at = datetime('now') WHERE job_id = ? AND uc_logged_at IS NULL", [id]);
    }
    writeDbFile(dbPath, Buffer.from(db.export()));
    return jobIds.length;
  } finally {
    db.close();
  }
}

// Clear the Recent Activity list: delete the finished rows (applied, failed,
// skipped) from the queue. The permanent applied_jobs table is NOT touched, so
// nothing is ever re-applied to and the Universal Credit log is unaffected.
// In-flight rows (pending / processing / cv_ready / applying) are left alone.
async function clearRecentActivity() {
  if (!dbPath || !fs.existsSync(dbPath)) return 0;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    const res = db.exec("SELECT COUNT(*) AS c FROM queue WHERE status IN ('applied','apply_failed','skipped')");
    const n = res.length ? (res[0].values[0][0] || 0) : 0;
    db.run("DELETE FROM queue WHERE status IN ('applied','apply_failed','skipped')");
    writeDbFile(dbPath, Buffer.from(db.export()));
    return n;
  } finally {
    db.close();
  }
}

// Jobs the Scorer has tailored and parked for the user's approval (review-before-
// apply mode). Newest first. Each carries the tailored CV path + cover letter so
// the review card can show both before anything is submitted.
function getReviewQueue(limit = 100) {
  return withQueueDb(db => {
    try {
      const rows = all(db, `
        SELECT job_id, title, company, url, source, cv_path, cv_score, cv_name, cover_letter, updated_at
        FROM queue WHERE status = 'awaiting_review'
        ORDER BY updated_at DESC LIMIT ?`, [limit]);
      return rows.map(r => ({
        jobId: r.job_id, title: r.title, company: r.company || '', url: r.url || '',
        source: r.source || '', cvPath: r.cv_path || '', cvScore: r.cv_score,
        cvName: r.cv_name || '', coverLetter: r.cover_letter || '', updatedAt: r.updated_at,
      }));
    } catch (_) { return []; }
  }, []);
}

// Company-site applications the agent tailored and parked for the user to send
// ("Fill it, you press Send"). Newest first.
function getAssistQueue(limit = 100) {
  return withQueueDb(db => {
    try {
      return all(db, `SELECT job_id, title, company, url, reason, cv_path, cover_letter, updated_at FROM queue
        WHERE source = 'ats' AND status = 'ready_to_submit' ORDER BY updated_at DESC LIMIT ?`, [limit]);
    } catch (_) { return []; }
  }, []);
}
// Federal (USAJOBS) jobs with their federal resume, waiting for the user to apply on USAJOBS.
// Soonest closing first.
function getFederalQueue(limit = 100) {
  return withQueueDb(db => {
    try {
      return all(db, `SELECT job_id, title, company, url, reason, cv_path, cv_name, cv_score, extra, updated_at FROM queue
        WHERE source = 'usajobs' AND status = 'ready_to_submit' ORDER BY updated_at DESC LIMIT ?`, [limit])
        .map((r) => { let x = {}; try { x = JSON.parse(r.extra || '{}') || {}; } catch (_) {} return { ...r, extra: x }; })
        .sort((a, b) => String(a.extra.closes || '9').localeCompare(String(b.extra.closes || '9')));
    } catch (_) { return []; }
  }, []);
}
// The user applied on USAJOBS themselves (applied = true) or skipped it. No receipt email:
// Job-AI never says it applied to a federal job.
async function resolveFederal(jobId, applied) {
  if (!dbPath || !fs.existsSync(dbPath) || !jobId) return false;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    const id = String(jobId);
    if (applied) {
      db.run("UPDATE queue SET status = 'applied', reason = 'You applied on USAJOBS', updated_at = datetime('now') WHERE job_id = ? AND source = 'usajobs' AND status = 'ready_to_submit'", [id]);
      db.run("INSERT OR IGNORE INTO applied_jobs (job_id, title, company) SELECT job_id, title, company FROM queue WHERE job_id = ? AND source = 'usajobs'", [id]);
    } else {
      db.run("UPDATE queue SET status = 'skipped', reason = 'Not applied (your choice)', updated_at = datetime('now') WHERE job_id = ? AND source = 'usajobs' AND status = 'ready_to_submit'", [id]);
    }
    writeDbFile(dbPath, Buffer.from(db.export()));
    return true;
  } finally {
    db.close();
  }
}
// The user chose not to send it.
async function skipAssist(jobId) {
  if (!dbPath || !fs.existsSync(dbPath) || !jobId) return false;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    db.run("UPDATE queue SET status = 'skipped', reason = 'Not sent (your choice)', updated_at = datetime('now') WHERE job_id = ? AND source = 'ats' AND status = 'ready_to_submit'", [String(jobId)]);
    writeDbFile(dbPath, Buffer.from(db.export()));
    return true;
  } finally {
    db.close();
  }
}

function getReviewCount() {
  return withQueueDb(db => {
    try {
      const r = all(db, "SELECT COUNT(*) AS c FROM queue WHERE status = 'awaiting_review'");
      return r[0]?.c || 0;
    } catch (_) { return 0; }
  }, 0);
}

// Resolve reviewed jobs: approve -> 'cv_ready' (the normal apply flow resumes and
// an agent submits it); skip -> 'skipped'. Only rows still 'awaiting_review' are
// touched, so a job already applied to can't be disturbed. User-initiated and
// rare, so it uses the same whole-file read-modify-write the UC log write uses.
async function resolveReview(jobIds, approve) {
  if (!dbPath || !fs.existsSync(dbPath) || !Array.isArray(jobIds) || jobIds.length === 0) return 0;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    let n = 0;
    for (const id of jobIds) {
      if (approve) {
        db.run("UPDATE queue SET status = 'cv_ready', updated_at = datetime('now') WHERE job_id = ? AND status = 'awaiting_review'", [id]);
      } else {
        db.run("UPDATE queue SET status = 'skipped', reason = 'Skipped in review', updated_at = datetime('now') WHERE job_id = ? AND status = 'awaiting_review'", [id]);
      }
      n++;
    }
    writeDbFile(dbPath, Buffer.from(db.export()));
    return n;
  } finally {
    db.close();
  }
}

// Regenerate: send an awaiting_review job back to 'pending' with its tailored
// fields cleared, so the Scorer re-tailors the CV + cover letter from scratch
// (LLM tailoring is stochastic, so a re-run gives a fresh result) and re-parks it
// at awaiting_review. Only touches rows still awaiting_review. Needs the Scorer
// running to pick it up — otherwise it re-tailors on the next agent run.
async function requeueForReview(jobIds) {
  if (!dbPath || !fs.existsSync(dbPath) || !Array.isArray(jobIds) || jobIds.length === 0) return 0;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    let n = 0;
    for (const id of jobIds) {
      db.run(`UPDATE queue SET status = 'pending', cv_path = NULL, cv_score = NULL,
                cv_name = NULL, cover_letter = NULL, error = NULL, updated_at = datetime('now')
              WHERE job_id = ? AND status = 'awaiting_review'`, [id]);
      n++;
    }
    writeDbFile(dbPath, Buffer.from(db.export()));
    return n;
  } finally {
    db.close();
  }
}

function getQueueSummary() {
  return withQueueDb(db => {
    // A brand-new profile has a queue.db (meta table) but no `queue` table yet —
    // the bots create it on their first run. Tolerate that so the Dashboard shows
    // an empty state instead of "Failed to load".
    try {
      const rows = all(db, 'SELECT status, COUNT(*) AS count FROM queue GROUP BY status');
      // "Tailored so far" — every job that has had a CV generated keeps its
      // cv_path through later status changes, so this is a persistent total that
      // doesn't get consumed the way the momentary cv_ready status does.
      const tailored = all(db, "SELECT COUNT(*) AS count FROM queue WHERE cv_path IS NOT NULL AND cv_path != ''");
      rows.push({ status: 'tailored', count: tailored[0]?.count || 0 });
      // Applied, split by agent (LinkedIn 12 · Reed 8 · NHS 3) for the Applied card.
      for (const r of all(db, "SELECT source, COUNT(*) AS count FROM queue WHERE status = 'applied' GROUP BY source")) {
        rows.push({ status: 'applied_by:' + (r.source || 'other'), count: r.count });
      }
      // Skips the USER must act on (reconnect an account, sign in, a CV that could not be
      // attached). Routine skips (filters, closed vacancies) are not counted here.
      const attention = all(db, `SELECT COUNT(*) AS count FROM queue WHERE status = 'skipped' AND (
        reason LIKE '%not attached%' OR reason LIKE '%reconnect%' OR reason LIKE '%session%' OR reason LIKE '%login needed%' OR reason LIKE '%sign in%' OR reason LIKE '%Needs you:%')`);
      rows.push({ status: 'attention_skips', count: attention[0]?.count || 0 });
      return rows;
    } catch (_) { return []; }
  }, []);
}

function getRecentApplications(limit = 50) {
  // Recent Activity shows OUTCOMES THAT MATTER: applications, failures, and the
  // actionable skips the user needs to act on (e.g. "reconnect account" when the
  // tailored CV couldn't be attached). Routine skips (below score, external site,
  // wrong work type, already applied, duplicate, training course) are noise that
  // buries the real activity, so they're excluded here — the aggregate count is
  // still shown in the stats tile and the full detail is in the Agent Logs.
  return withQueueDb(db => {
    try {
      return all(db, `
        SELECT * FROM queue
        WHERE status IN ('applied','apply_failed','ready_to_submit')
           OR (status = 'skipped' AND (
                 reason LIKE '%not attached%'
                 OR reason LIKE '%Needs you:%'
                 OR reason LIKE '%reconnect%'
                 OR reason LIKE '%session%'
           ))
        ORDER BY updated_at DESC LIMIT ?
      `, [limit]);
    } catch (_) { return []; }  // no `queue` table yet on a fresh profile
  }, []);
}

// Applications submitted today. Mirrors the bots' own cap counter
// (queue_manager.countAppliedToday) so the "daily limit reached" prompt shown
// when the user presses Start lines up exactly with what the agents enforce.
function getTodayAppliedCount() {
  return withQueueDb(db => {
    try {
      // Same as queue_manager.countAppliedToday: applications plus completed drafts.
      try {
        const r = all(db, `SELECT COUNT(*) AS c FROM (
          SELECT job_id FROM applied_jobs WHERE date(applied_at) = date('now')
          UNION SELECT job_id FROM cap_counted WHERE date(counted_at) = date('now'))`);
        return r[0]?.c || 0;
      } catch (_) {
        const r = all(db, "SELECT COUNT(*) AS c FROM applied_jobs WHERE date(applied_at) = date('now')"); // no cap_counted table yet
        return r[0]?.c || 0;
      }
    } catch (_) { return 0; }
  }, 0);
}

// Returns applications-per-day for the last N days (from applied_jobs table)
function getDailyApplications(days = 14) {
  return withQueueDb(db => {
    try {
      return all(db, `
        SELECT date(applied_at) AS day, COUNT(*) AS count
        FROM applied_jobs
        WHERE applied_at >= date('now', '-${days} days')
        GROUP BY date(applied_at)
        ORDER BY day ASC
      `, []);
    } catch (_) { return []; }
  }, []);
}

// Returns data for the daily summary email — today's applied/skipped/failed + pending count + top titles
function getDailySummaryData() {
  return withQueueDb(db => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const applied = all(db, `
        SELECT title, company FROM queue
        WHERE status = 'applied' AND date(updated_at) = ?
        ORDER BY updated_at DESC
      `, [today]);
      const skipped = all(db, `
        SELECT title, company FROM queue
        WHERE status = 'skipped' AND date(updated_at) = ?
        ORDER BY updated_at DESC
      `, [today]);
      const failed = all(db, `
        SELECT title, company FROM queue
        WHERE status = 'apply_failed' AND date(updated_at) = ?
        ORDER BY updated_at DESC
      `, [today]);
      const pendingRows = all(db, `SELECT COUNT(*) AS n FROM queue WHERE status IN ('pending','cv_ready')`, []);
      const pending = pendingRows[0]?.n || 0;

      const titleCounts = {};
      for (const j of applied) {
        const t = (j.title || '').split(' ').slice(0, 4).join(' ');
        if (t) titleCounts[t] = (titleCounts[t] || 0) + 1;
      }
      const topTitles = Object.entries(titleCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t]) => t);

      return { applied, skipped, failed, pending, topTitles };
    } catch (_) { return null; }
  }, null);
}

// Returns all applied jobs with queue metadata — used to sync the interview tracker
function getAppliedJobsForSync() {
  return withQueueDb(db => {
    try {
      return all(db, `
        SELECT aj.job_id, aj.title, aj.company, aj.applied_at,
               q.url, q.source, q.cv_name
        FROM applied_jobs aj
        LEFT JOIN queue q ON q.job_id = aj.job_id
        ORDER BY aj.applied_at DESC LIMIT 500
      `);
    } catch (_) { return []; }
  }, []);
}

// Comprehensive stats for the Analytics page
function getAnalytics() {
  return withQueueDb(db => {
    try {
      const totals = all(db, `
        SELECT
          SUM(CASE WHEN status='applied'                   THEN 1 ELSE 0 END) AS total_applied,
          SUM(CASE WHEN status='skipped'                   THEN 1 ELSE 0 END) AS total_skipped,
          SUM(CASE WHEN status IN('apply_failed','failed') THEN 1 ELSE 0 END) AS total_failed
        FROM queue`);
      const bySource    = all(db, `SELECT source, COUNT(*) AS count FROM queue WHERE status='applied' AND source IS NOT NULL GROUP BY source ORDER BY count DESC`);
      const byCV        = all(db, `SELECT cv_name, COUNT(*) AS count FROM queue WHERE status='applied' AND cv_name IS NOT NULL GROUP BY cv_name ORDER BY count DESC`);
      const skipReasons = all(db, `SELECT reason, COUNT(*) AS count FROM queue WHERE status='skipped' AND reason IS NOT NULL GROUP BY reason ORDER BY count DESC LIMIT 10`);
      const daily30     = all(db, `SELECT date(applied_at) AS day, COUNT(*) AS count FROM applied_jobs WHERE applied_at >= date('now','-30 days') GROUP BY date(applied_at) ORDER BY day ASC`);
      const topCompanies= all(db, `SELECT company, COUNT(*) AS count FROM applied_jobs WHERE company IS NOT NULL GROUP BY company ORDER BY count DESC LIMIT 10`);
      const topTitles   = all(db, `SELECT title, COUNT(*) AS count FROM applied_jobs WHERE title IS NOT NULL GROUP BY title ORDER BY count DESC LIMIT 10`);
      return {
        totals: totals[0] || { total_applied: 0, total_skipped: 0, total_failed: 0 },
        bySource, byCV, skipReasons, daily30, topCompanies, topTitles,
      };
    } catch (_) { return null; }
  }, null);
}

// Why jobs were skipped in the last 7 days, counted by reason (percentages dropped so
// "Meets 2 of 6 (33%)" and "(40%)" group together). Sent with the phone-control status so
// the backend can tell a user whose agents run but send nothing what is blocking them.
// NHS drafts waiting for the user are not skips; they are counted under needs_you.
function getSkipReasons() {
  return withQueueDb(db => {
    try {
      const rows = all(db, `SELECT reason, COUNT(*) AS count FROM queue
        WHERE status = 'skipped' AND reason IS NOT NULL AND reason != '' AND reason NOT LIKE 'Draft saved on Trac%'
          AND updated_at >= datetime('now', '-7 days')
        GROUP BY reason`);
      const by = {}; let total = 0;
      for (const r of rows) {
        const raw = String(r.reason);
        // Same wording as the extension where the cause is the same; per-job detail dropped.
        const k = (/best score|below .*threshold/i.test(raw) ? 'Not a close enough match'
          : raw.replace(/\([^)]*\)/g, '').replace(/\d+%/g, '').split(/:|\s[—-]\s/)[0])
          .replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!k) continue;
        by[k] = (by[k] || 0) + r.count; total += r.count;
      }
      return { skipped: total, reasons: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, count]) => ({ reason, count })) };
    } catch (_) { return { skipped: 0, reasons: [] }; }
  }, { skipped: 0, reasons: [] });
}

// Skips caused by the user's own filters, which one setting change would undo
// (the dashboard's "Your settings skipped N jobs" card). Same wording the agents write.
const FILTER_SQL = {
  contract: "(reason LIKE 'Contract role skipped%' OR reason LIKE 'Fixed-term or contract%')",
  part_time: "reason LIKE 'Part-time role%'",
  worktype: "reason LIKE 'Work type (%'",
  salary: "(reason LIKE 'Below salary expectation%' OR reason LIKE 'Below your salary%' OR (reason LIKE 'Salary %' AND reason LIKE '%below minimum%'))",
};
function getFilterSkips() {
  const none = { sent48h: 0, counts: {} };
  return withQueueDb(db => {
    try {
      const sent48h = all(db, "SELECT COUNT(*) AS n FROM queue WHERE status = 'applied' AND updated_at >= datetime('now', '-2 days')")[0].n;
      const counts = {};
      for (const [k, w] of Object.entries(FILTER_SQL)) {
        counts[k] = all(db, `SELECT COUNT(*) AS n FROM queue WHERE status = 'skipped' AND updated_at >= datetime('now', '-7 days') AND ${w}`)[0].n;
      }
      return { sent48h, counts };
    } catch (_) { return none; }
  }, none);
}
// After a filter is widened, put the jobs it skipped back in the queue so the Scorer checks
// them again with the new setting. Only jobs whose advert was saved can be re-checked.
async function requeueFilterSkips(key) {
  const w = FILTER_SQL[key];
  if (!w || key === 'salary' || !dbPath || !fs.existsSync(dbPath)) return 0;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    const cols = all(db, 'PRAGMA table_info(queue)').map(c => c.name);
    const retry = cols.includes('retry_count') ? ', retry_count = 0' : '';
    db.run(`UPDATE queue SET status = 'pending', reason = NULL${retry}, updated_at = datetime('now')
      WHERE status = 'skipped' AND length(COALESCE(description, '')) > 200 AND ${w}`);
    const n = db.getRowsModified();
    if (n) writeDbFile(dbPath, Buffer.from(db.export()));
    return n;
  } finally { db.close(); }
}

// "Only move for more money": applications in the last 30 days (sent + finished drafts),
// counted the same way as the agents' monthly limit (queue_manager.countAppliedToday).
function getMonthUsed() {
  return withQueueDb(db => {
    try {
      return all(db, `SELECT COUNT(*) AS c FROM (
        SELECT job_id FROM applied_jobs WHERE datetime(applied_at) >= datetime('now', '-30 day')
        UNION SELECT job_id FROM cap_counted WHERE datetime(counted_at) >= datetime('now', '-30 day'))`)[0].c || 0;
    } catch (_) { return 0; }
  }, 0);
}

// Earn more tab: applications in the last 30 days and what the mode skipped.
function getMoveFound(move, us) {
  const { payRise } = require('../../bot/modules/move_mode');
  return withQueueDb(db => {
    try {
      const sent = all(db, `SELECT a.title, a.company, a.applied_at, q.description FROM applied_jobs a LEFT JOIN queue q ON q.job_id = a.job_id
        WHERE datetime(a.applied_at) >= datetime('now', '-30 day') ORDER BY a.applied_at DESC LIMIT 10`)
        .map(({ description, ...r }) => ({ ...r, ...(payRise(move, { description }, { us }) || {}) }));
      const n = (like) => all(db, `SELECT COUNT(*) AS c FROM queue WHERE status = 'skipped' AND reason LIKE ? AND datetime(updated_at) >= datetime('now', '-30 day')`, [like])[0].c || 0;
      return { sent, skipped: { pay: n('Pays under%'), nosalary: n('No salary shown (you only move%'), employer: n('Your current employer%') } };
    } catch (_) { return { sent: [], skipped: {} }; }
  }, { sent: [], skipped: {} });
}

// When the mode is turned on, jobs already found or tailored must pass it too.
async function skipFailingMove(move, us) {
  if (!move || !move.on || !dbPath || !fs.existsSync(dbPath)) return 0;
  const { check } = require('../../bot/modules/move_mode');
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    const rows = all(db, `SELECT job_id, title, company, description FROM queue WHERE status IN ('pending', 'cv_ready', 'awaiting_review')`);
    let n = 0;
    for (const r of rows) {
      const why = check(move, r, { us });
      if (!why) continue;
      db.run(`UPDATE queue SET status = 'skipped', reason = ?, updated_at = datetime('now') WHERE job_id = ?`, [why, r.job_id]);
      n++;
    }
    if (n) writeDbFile(dbPath, Buffer.from(db.export()));
    return n;
  } finally { db.close(); }
}

// NHS/Trac applications the user may want to open: ready to submit, or saved as a draft that
// needs them. Each carries its Trac link (draft_url) when the agent has recorded it.
function getTracApplications() {
  return withQueueDb(db => {
    try {
      const cols = all(db, 'PRAGMA table_info(queue)').map(c => c.name);
      const du = cols.includes('draft_url') ? 'draft_url' : "'' AS draft_url";
      return all(db, `SELECT job_id, title, company, url, status, reason, cover_letter, ${du}, updated_at FROM queue
        WHERE source = 'trac' AND (status = 'ready_to_submit' OR (status = 'skipped' AND reason LIKE 'Draft saved on Trac%'))
        ORDER BY (status = 'ready_to_submit') ASC, updated_at DESC LIMIT 100`);
    } catch (_) { return []; }
  });
}

// NHS applications the user approved from their phone (tryjobai.com/app). The Trac agent
// submits them on its next step and removes each id once it has tried (see bot_trac.js).
const APPROVED_KEY = 'trac_submit_ok';
function getTracApproved() {
  return withQueueDb(db => {
    try { const r = all(db, 'SELECT value FROM meta WHERE key = ?', [APPROVED_KEY]); return JSON.parse((r[0] && r[0].value) || '[]'); } catch (_) { return []; }
  }, []);
}
// Only a Trac job that is ready to submit and doesn't ask about AI use can be approved.
async function approveTracSubmit(jobId) {
  if (!dbPath || !fs.existsSync(dbPath) || !jobId) return false;
  const SQL = await initSqlJs();
  const db = new SQL.Database(readDbFile(dbPath));
  try {
    const job = all(db, "SELECT reason FROM queue WHERE job_id = ? AND source = 'trac' AND status = 'ready_to_submit'", [String(jobId)])[0];
    if (!job || /asks about AI use/.test(job.reason || '')) return false;
    db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    let ids = []; try { ids = JSON.parse((all(db, 'SELECT value FROM meta WHERE key = ?', [APPROVED_KEY])[0] || {}).value || '[]'); } catch (_) {}
    if (!ids.includes(String(jobId))) ids.push(String(jobId));
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [APPROVED_KEY, JSON.stringify(ids.slice(-50))]);
    writeDbFile(dbPath, Buffer.from(db.export()));
    return true;
  } finally {
    db.close();
  }
}

// Last sign-in result per site, as the agents record it: { reed: 'ok' | 'dead' | 'checking' }.
function getSignInStates() {
  return withQueueDb(db => {
    const out = {};
    try {
      for (const r of all(db, "SELECT key, value FROM meta WHERE key LIKE 'sess:%'")) {
        const v = String(r.value || ''); const i = v.lastIndexOf(':');
        out[String(r.key).slice(5)] = i < 0 ? v : v.slice(0, i);
      }
    } catch (_) {}
    return out;
  }, {});
}

// Accounts the user must sign in to again: the newest such skip per site, from the last 3 days.
function getReconnectNeeded() {
  return withQueueDb(db => {
    try {
      return all(db, `SELECT source, MAX(updated_at) AS updated_at FROM queue WHERE status = 'skipped' AND updated_at >= datetime('now', '-3 days')
        AND (reason LIKE '%reconnect%' OR reason LIKE '%login needed%' OR reason LIKE '%sign in%' OR reason LIKE '%session%') AND reason NOT LIKE 'Draft saved on Trac%'
        GROUP BY source`);
    } catch (_) { return []; }
  }, []);
}

module.exports = { getMoveFound, getMonthUsed, skipFailingMove, getFilterSkips, requeueFilterSkips, init, getSignInStates, getQueueSummary, getTracApplications, getTracApproved, approveTracSubmit, getReconnectNeeded, clearRecentActivity, getUcPendingCount, getUcPendingList, markUcLoggedManual, getWorkSearchLog, getRecentApplications, getTodayAppliedCount, getDailyApplications, getDailySummaryData, getAppliedJobsForSync, getAnalytics, getSkipReasons, getReviewQueue, getReviewCount, resolveReview, requeueForReview, getAssistQueue, skipAssist, getFederalQueue, resolveFederal };
