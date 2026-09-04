// Read-only view onto queue.db for the Dashboard. The bots own queue.db
// (read-modify-write via bot/modules/queue_manager.js) — this module never
// writes, so it just re-opens the file fresh on every call.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let dbPath;

function init(userDataPath) {
  dbPath = path.join(userDataPath, 'queue.db');
}

async function withQueueDb(fn, fallback) {
  if (!dbPath || !fs.existsSync(dbPath)) return fallback;
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
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

// The ONE write this otherwise read-only module performs: after the user has
// copied their log into their UC journal by hand, mark those applications logged
// so they drop off the pending list. Rare, user-initiated; uses the same
// read-modify-write-whole-file approach the bots use for queue.db.
async function markUcLoggedManual(jobIds) {
  if (!dbPath || !fs.existsSync(dbPath) || !Array.isArray(jobIds) || jobIds.length === 0) return 0;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    try { db.run("ALTER TABLE applied_jobs ADD COLUMN uc_logged_at TEXT"); } catch (_) {}
    for (const id of jobIds) {
      db.run("UPDATE applied_jobs SET uc_logged_at = datetime('now') WHERE job_id = ? AND uc_logged_at IS NULL", [id]);
    }
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
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
  const db = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const res = db.exec("SELECT COUNT(*) AS c FROM queue WHERE status IN ('applied','apply_failed','skipped')");
    const n = res.length ? (res[0].values[0][0] || 0) : 0;
    db.run("DELETE FROM queue WHERE status IN ('applied','apply_failed','skipped')");
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
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
        WHERE status IN ('applied','apply_failed')
           OR (status = 'skipped' AND (
                 reason LIKE '%not attached%'
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
      const r = all(db, "SELECT COUNT(*) AS c FROM applied_jobs WHERE date(applied_at) = date('now')");
      return r[0]?.c || 0;
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

module.exports = { init, getQueueSummary, clearRecentActivity, getUcPendingCount, getUcPendingList, markUcLoggedManual, getRecentApplications, getTodayAppliedCount, getDailyApplications, getDailySummaryData, getAppliedJobsForSync, getAnalytics };
