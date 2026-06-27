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

function getQueueSummary() {
  return withQueueDb(db => {
    const rows = all(db, 'SELECT status, COUNT(*) AS count FROM queue GROUP BY status');
    // "Tailored so far" — every job that has had a CV generated keeps its
    // cv_path through later status changes, so this is a persistent total that
    // doesn't get consumed the way the momentary cv_ready status does.
    const tailored = all(db, "SELECT COUNT(*) AS count FROM queue WHERE cv_path IS NOT NULL AND cv_path != ''");
    rows.push({ status: 'tailored', count: tailored[0]?.count || 0 });
    return rows;
  }, []);
}

function getRecentApplications(limit = 50) {
  return withQueueDb(db => all(db, `
    SELECT * FROM queue WHERE status IN ('applied','skipped')
    ORDER BY updated_at DESC LIMIT ?
  `, [limit]), []);
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

module.exports = { init, getQueueSummary, getRecentApplications, getDailyApplications, getDailySummaryData, getAppliedJobsForSync, getAnalytics };
