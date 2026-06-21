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
  return withQueueDb(db => all(db, 'SELECT status, COUNT(*) AS count FROM queue GROUP BY status'), []);
}

function getRecentApplications(limit = 50) {
  return withQueueDb(db => all(db, `
    SELECT * FROM queue WHERE status IN ('applied','skipped')
    ORDER BY updated_at DESC LIMIT ?
  `, [limit]), []);
}

module.exports = { init, getQueueSummary, getRecentApplications };
