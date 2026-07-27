// SQLite-backed queue manager — drop-in replacement for the old queue.json
// based module. Same exported API (add, update, getByStatus, has, read,
// printStatus, markApplied, wasApplied) so bot_reed.js / bot_scorer.js and
// the modules they call (reed.js etc.) need no further changes.
//
// Each call re-reads queue.db from disk and (for mutations) writes it back,
// so the Reed bot and Scorer bot processes always see each other's latest
// state — equivalent to the read-modify-write semantics of the old
// queue.json file, but in SQLite.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const schema = require('../db/queueSchema');

let SQL;
let dbPath;

async function init(userDataPath) {
  SQL = await initSqlJs();
  dbPath = path.join(userDataPath, 'queue.db');

  const buffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined;
  const db = new SQL.Database(buffer);
  db.run(schema); // idempotent — creates tables if missing
  // Key/value store for cross-process bot state (e.g. the reconnect circuit-breaker).
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  // Migrations: add columns if not present
  const colStmt = db.prepare('PRAGMA table_info(queue)');
  const cols = [];
  while (colStmt.step()) cols.push(colStmt.getAsObject().name);
  colStmt.free();
  if (!cols.includes('cover_letter')) db.run('ALTER TABLE queue ADD COLUMN cover_letter TEXT');
  if (!cols.includes('retry_count'))  db.run('ALTER TABLE queue ADD COLUMN retry_count INTEGER DEFAULT 0');

  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

function withDb(fn) {
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);
  let mutated = false;
  try {
    return fn(db, () => { mutated = true; });
  } finally {
    if (mutated) fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
  }
}

function rowToJob(row) {
  return {
    jobId: row.job_id,
    title: row.title,
    company: row.company,
    url: row.url,
    source: row.source,
    description: row.description,
    status: row.status,
    reason: row.reason,
    workType: row.work_type,
    cvName: row.cv_name,
    cvScore: row.cv_score,
    cvPath: row.cv_path,
    coverLetter: row.cover_letter,
    error: row.error,
    retryCount: row.retry_count || 0,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function queryJobs(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(rowToJob(stmt.getAsObject()));
  stmt.free();
  return out;
}

// Add a job to the queue (no-op if jobId already exists)
function add(job) {
  withDb((db, markMutated) => {
    const stmt = db.prepare('SELECT 1 FROM queue WHERE job_id = ?');
    stmt.bind([job.jobId]);
    const exists = stmt.step();
    stmt.free();
    if (exists) return;

    db.run(`INSERT INTO queue
      (job_id, title, company, url, source, description, status, reason, work_type, cv_name, cv_score, cv_path, cover_letter, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      job.jobId,
      job.title ?? null,
      job.company ?? null,
      job.url ?? null,
      job.source ?? null,
      job.description ?? null,
      job.status || 'pending',
      job.reason ?? null,
      job.workType ?? null,
      job.cvName ?? null,
      job.cvScore ?? null,
      job.cvPath ?? null,
      job.coverLetter ?? null,
      job.error ?? null,
    ]);
    markMutated();
  });
}

const FIELD_MAP = {
  title: 'title', company: 'company', url: 'url', source: 'source',
  description: 'description', status: 'status', reason: 'reason',
  workType: 'work_type', cvName: 'cv_name', cvScore: 'cv_score',
  cvPath: 'cv_path', coverLetter: 'cover_letter', error: 'error',
  retryCount: 'retry_count',
};

// Update fields on a job entry
function update(jobId, fields) {
  withDb((db, markMutated) => {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(fields)) {
      const col = FIELD_MAP[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(val ?? null);
    }
    if (!sets.length) return;
    sets.push("updated_at = datetime('now')");
    db.run(`UPDATE queue SET ${sets.join(', ')} WHERE job_id = ?`, [...vals, jobId]);
    markMutated();
  });
}

function getByStatus(status) {
  return withDb((db) => queryJobs(db, 'SELECT * FROM queue WHERE status = ? ORDER BY added_at', [status]));
}

function has(jobId) {
  return withDb((db) => {
    const stmt = db.prepare('SELECT 1 FROM queue WHERE job_id = ?');
    stmt.bind([jobId]);
    const exists = stmt.step();
    stmt.free();
    return exists;
  });
}

function read() {
  return withDb((db) => queryJobs(db, 'SELECT * FROM queue ORDER BY added_at'));
}

function printStatus() {
  withDb((db) => {
    const stmt = db.prepare('SELECT status, COUNT(*) AS c FROM queue GROUP BY status');
    const counts = {};
    while (stmt.step()) {
      const row = stmt.getAsObject();
      counts[row.status] = row.c;
    }
    stmt.free();
    console.log('  [Queue]', JSON.stringify(counts));
  });
}

// Persistent record of job IDs ever applied — survives queue clears
function markApplied(jobId) {
  withDb((db, markMutated) => {
    const stmt = db.prepare('SELECT title, company FROM queue WHERE job_id = ?');
    stmt.bind([jobId]);
    let title = null, company = null;
    if (stmt.step()) {
      const row = stmt.getAsObject();
      title = row.title;
      company = row.company;
    }
    stmt.free();
    db.run('INSERT OR IGNORE INTO applied_jobs (job_id, title, company) VALUES (?, ?, ?)', [jobId, title, company]);
    markMutated();
  });
}

function wasApplied(jobId) {
  return withDb((db) => {
    const stmt = db.prepare('SELECT 1 FROM applied_jobs WHERE job_id = ?');
    stmt.bind([jobId]);
    const exists = stmt.step();
    stmt.free();
    return exists;
  });
}

function countAppliedToday() {
  return withDb((db) => {
    const stmt = db.prepare("SELECT COUNT(*) AS c FROM applied_jobs WHERE date(applied_at) = date('now')");
    const c = stmt.step() ? (stmt.getAsObject().c || 0) : 0;
    stmt.free();
    return c;
  });
}

// Cross-site deduplication — normalise title+company and check across all sources.
// Returns true if a job with the same role at the same company already exists.
function _normalise(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\b(senior|sr|junior|jr|lead|principal|remote|contract|interim|staff)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function hasCanonical(title, company) {
  const nt = _normalise(title);
  const nc = _normalise(company);
  if (!nt || !nc) return false;
  return withDb((db) => {
    const stmt = db.prepare('SELECT job_id, title, company FROM queue UNION SELECT job_id, title, company FROM applied_jobs');
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (_normalise(row.title) === nt && _normalise(row.company) === nc) {
        stmt.free();
        return true;
      }
    }
    stmt.free();
    return false;
  });
}

// Requeue apply_failed jobs for one more attempt (max 2 retries total).
// Call this at the start of each phase2 cycle.
function requeueFailed(source) {
  const failed = getByStatus('apply_failed').filter(j => j.source === source && (j.retryCount || 0) < 2);
  for (const j of failed) {
    update(j.jobId, { status: 'cv_ready', retryCount: (j.retryCount || 0) + 1, error: null });
    console.log(`  [Queue] Requeueing for retry (attempt ${(j.retryCount || 0) + 1}): ${j.title}`);
  }
  return failed.length;
}

// Returns true if any applied job from the same company was submitted within
// the past N days — prevents double-applying to the same employer.
function wasAppliedToCompanyRecently(company, days = 30) {
  if (!company) return false;
  const nc = _normalise(company);
  if (!nc) return false;
  return withDb(db => {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const stmt = db.prepare("SELECT company FROM applied_jobs WHERE date(applied_at) >= ?");
      stmt.bind([cutoff.toISOString().slice(0, 10)]);
      while (stmt.step()) {
        if (_normalise(stmt.getAsObject().company) === nc) { stmt.free(); return true; }
      }
      stmt.free();
    } catch (_) {}
    return false;
  });
}

// Returns false for short or generic JDs.
function isQualityJD(description, title) {
  if (!description || description.trim().split(/\s+/).length < 80) return false;
  if (/\b(various|multiple|several)\s+(roles?|positions?|vacancies?|openings?)/i.test(title || '')) return false;
  return true;
}

// ── Cross-process key/value store ───────────────────────────────────────────
function getMeta(key) {
  try {
    return withDb((db) => {
      db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
      const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
      stmt.bind([key]);
      const val = stmt.step() ? stmt.getAsObject().value : null;
      stmt.free();
      return val;
    });
  } catch (_) { return null; }
}

function setMeta(key, value) {
  try {
    withDb((db, mutated) => {
      db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
      db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(value)]);
      mutated();
    });
  } catch (_) { /* non-fatal: breaker must never break the pipeline */ }
}

// ── Session-health gate (stops tailoring CVs for a dead session) ─────────────
// Per-source session state lives in meta as `sess:<source>` = "<state>:<ts>":
//   checking → the apply bot is logging in; not yet verified
//   ok       → login verified / a real application just succeeded
//   dead     → login failed, or CVs repeatedly couldn't be attached
// The SCORER only tailors a source that is 'ok' or unknown (a non-participating
// bot like Indeed never sets state → tailors normally). It HOLDS 'dead' sources,
// and 'checking' sources within a grace window — so a CV is only tailored once
// the account's session is confirmed, not before. FAIL-SAFE: a 'checking' state
// stuck past CHECKING_GRACE_MS falls back to tailoring, so a missing "logged in"
// signal can never permanently stall the product — worst case is a short delay.
// Every call is defensive: on any error it returns a safe default and never
// disrupts the apply/tailor pipeline.
const CV_FAIL_THRESHOLD = 3;
const CHECKING_GRACE_MS = 90 * 1000;

function _setSession(source, state) { setMeta(`sess:${source}`, `${state}:${Date.now()}`); }
function _parseSession(raw) {
  if (!raw) return { state: null, ts: 0 };
  const i = String(raw).lastIndexOf(':');
  if (i < 0) return { state: String(raw), ts: 0 };
  return { state: String(raw).slice(0, i), ts: parseInt(String(raw).slice(i + 1), 10) || 0 };
}
function sessionState(source) { try { return _parseSession(getMeta(`sess:${source}`)); } catch (_) { return { state: null, ts: 0 }; } }

// Login in progress — call at bot startup, before ensureLoggedIn.
function markSessionChecking(source) { try { _setSession(source, 'checking'); } catch (_) {} }
// Login verified / a real application succeeded — resumes tailoring for this source.
function markSessionHealthy(source) { try { _setSession(source, 'ok'); setMeta(`cvfail:${source}`, '0'); } catch (_) {} }
// Login failed / repeated upload failures — pauses tailoring for this source.
function markSessionDead(source) { try { _setSession(source, 'dead'); } catch (_) {} }

// Mid-run upload failure. A healthy session only flips to dead after
// CV_FAIL_THRESHOLD in a row (guards against a one-off "upload box not found").
function recordUploadFailure(source) {
  try {
    const k = `cvfail:${source}`;
    const streak = (parseInt(getMeta(k) || '0', 10) || 0) + 1;
    setMeta(k, streak);
    if (streak >= CV_FAIL_THRESHOLD) { markSessionDead(source); return { tripped: true, streak }; }
    return { tripped: false, streak };
  } catch (_) { return { tripped: false, streak: 0 }; }
}
function recordUploadSuccess(source) { markSessionHealthy(source); }

// Apply-bot gate: don't bother applying when the session is dead.
function reconnectNeeded(source) { try { return sessionState(source).state === 'dead'; } catch (_) { return false; } }

// Scorer gate: sources whose CVs must NOT be tailored right now — 'dead', or
// 'checking' still inside the grace window. One DB read.
function tailoringPausedSources() {
  try {
    return withDb((db) => {
      db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
      const stmt = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'sess:%'");
      const out = []; const now = Date.now();
      while (stmt.step()) {
        const r = stmt.getAsObject();
        const src = String(r.key).slice('sess:'.length);
        const { state, ts } = _parseSession(r.value);
        if (state === 'dead') out.push(src);
        else if (state === 'checking' && (now - ts) < CHECKING_GRACE_MS) out.push(src);
      }
      stmt.free();
      return out;
    });
  } catch (_) { return []; }
}

// Sources currently flagged dead (for the reconnect prompt / logging).
function reconnectSources() {
  try {
    return withDb((db) => {
      db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
      const stmt = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'sess:%'");
      const out = [];
      while (stmt.step()) {
        const r = stmt.getAsObject();
        if (_parseSession(r.value).state === 'dead') out.push(String(r.key).slice('sess:'.length));
      }
      stmt.free();
      return out;
    });
  } catch (_) { return []; }
}

function clearReconnect(source) {
  try {
    if (source) { setMeta(`cvfail:${source}`, '0'); setMeta(`sess:${source}`, ''); return; }
    withDb((db, mutated) => {
      db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
      db.run("DELETE FROM meta WHERE key LIKE 'sess:%' OR key LIKE 'cvfail:%'");
      mutated();
    });
  } catch (_) { /* non-fatal */ }
}

module.exports = { init, add, update, getByStatus, has, read, printStatus, markApplied, wasApplied, countAppliedToday, hasCanonical, requeueFailed, wasAppliedToCompanyRecently, isQualityJD, getMeta, setMeta, markSessionChecking, markSessionHealthy, markSessionDead, sessionState, recordUploadFailure, recordUploadSuccess, reconnectNeeded, reconnectSources, tailoringPausedSources, clearReconnect };
