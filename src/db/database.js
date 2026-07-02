const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const schema = require('./schema');


let sqljsDb;
let dbPath;

// ── sql.js adapter (mimics the better-sqlite3 prepare/get/all/run API) ──────
function persist() {
  const data = sqljsDb.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function normalizeParams(params) {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params;
  const out = {};
  for (const [k, v] of Object.entries(params)) out['@' + k] = v;
  return out;
}

class Statement {
  constructor(sql) { this.sql = sql; }

  get(params) {
    const stmt = sqljsDb.prepare(this.sql);
    try {
      const p = normalizeParams(params);
      if (p !== undefined) stmt.bind(p);
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
  }

  all(params) {
    const stmt = sqljsDb.prepare(this.sql);
    const rows = [];
    try {
      const p = normalizeParams(params);
      if (p !== undefined) stmt.bind(p);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  run(params) {
    const stmt = sqljsDb.prepare(this.sql);
    try {
      const p = normalizeParams(params);
      if (p !== undefined) stmt.bind(p);
      stmt.step();
    } finally {
      stmt.free();
    }
    const idRes = sqljsDb.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = idRes[0] ? idRes[0].values[0][0] : undefined;
    const changes = sqljsDb.getRowsModified();
    persist();
    return { lastInsertRowid, changes };
  }
}

const db = {
  prepare(sql) { return new Statement(sql); },
  exec(sql) { sqljsDb.run(sql); persist(); },
  // Note: each Statement.run() already persists individually, so this is
  // just a grouping wrapper rather than a real SQL transaction.
  transaction(fn) {
    return (...args) => fn(...args);
  },
};

// ── Init ─────────────────────────────────────────────────────────────────
async function init(userDataPath) {
  const SQL = await initSqlJs();
  dbPath = path.join(userDataPath, 'profile.db');

  const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : undefined;
  sqljsDb = new SQL.Database(existing);
  db.exec(schema);

  // Migration: retrofit bot_name column onto pre-existing bot_runs tables
  const botRunsCols = db.prepare('PRAGMA table_info(bot_runs)').all().map(c => c.name);
  if (!botRunsCols.includes('bot_name')) {
    db.exec('ALTER TABLE bot_runs ADD COLUMN bot_name TEXT');
  }

  // Migration: add new profile columns
  const profileCols = db.prepare('PRAGMA table_info(profile)').all().map(c => c.name);
  if (!profileCols.includes('salary_expectation')) {
    db.exec('ALTER TABLE profile ADD COLUMN salary_expectation TEXT');
  }
  if (!profileCols.includes('right_to_work_countries')) {
    // Carry forward the old boolean: if right_to_work was set, default to UK
    db.exec("ALTER TABLE profile ADD COLUMN right_to_work_countries TEXT DEFAULT 'United Kingdom'");
    db.exec("UPDATE profile SET right_to_work_countries = CASE WHEN right_to_work = 1 THEN 'United Kingdom' ELSE '' END WHERE id = 1");
  }
  if (!profileCols.includes('requires_sponsorship')) {
    db.exec('ALTER TABLE profile ADD COLUMN requires_sponsorship INTEGER DEFAULT 0');
  }
  if (!profileCols.includes('seek_sponsorship')) {
    db.exec('ALTER TABLE profile ADD COLUMN seek_sponsorship INTEGER DEFAULT 0');
  }
  if (!profileCols.includes('country')) {
    db.exec("ALTER TABLE profile ADD COLUMN country TEXT DEFAULT 'United Kingdom'");
  }
  if (!profileCols.includes('address')) {
    db.exec('ALTER TABLE profile ADD COLUMN address TEXT');
  }
  if (!profileCols.includes('experience_level')) {
    db.exec('ALTER TABLE profile ADD COLUMN experience_level TEXT');
  }
  if (!profileCols.includes('employment_type')) {
    db.exec('ALTER TABLE profile ADD COLUMN employment_type TEXT');
  }
  if (!profileCols.includes('availability')) {
    db.exec("ALTER TABLE profile ADD COLUMN availability TEXT DEFAULT 'immediately'");
  }
  if (!profileCols.includes('willing_to_relocate')) {
    db.exec('ALTER TABLE profile ADD COLUMN willing_to_relocate INTEGER DEFAULT 0');
  }
  if (!profileCols.includes('eeo_disability')) {
    db.exec('ALTER TABLE profile ADD COLUMN eeo_disability TEXT');
  }
  if (!profileCols.includes('eeo_veteran')) {
    db.exec('ALTER TABLE profile ADD COLUMN eeo_veteran TEXT');
  }

  // Migration: add job_age + schedule columns to search_preferences
  const searchPrefsCols = db.prepare('PRAGMA table_info(search_preferences)').all().map(c => c.name);
  if (!searchPrefsCols.includes('job_age')) {
    db.exec("ALTER TABLE search_preferences ADD COLUMN job_age TEXT DEFAULT 'r1209600'");
  }
  if (!searchPrefsCols.includes('schedule_enabled')) {
    db.exec('ALTER TABLE search_preferences ADD COLUMN schedule_enabled INTEGER DEFAULT 0');
  }
  if (!searchPrefsCols.includes('schedule_days')) {
    db.exec("ALTER TABLE search_preferences ADD COLUMN schedule_days TEXT DEFAULT 'Mon,Tue,Wed,Thu,Fri'");
  }
  if (!searchPrefsCols.includes('schedule_start')) {
    db.exec('ALTER TABLE search_preferences ADD COLUMN schedule_start INTEGER DEFAULT 9');
  }
  if (!searchPrefsCols.includes('schedule_end')) {
    db.exec('ALTER TABLE search_preferences ADD COLUMN schedule_end INTEGER DEFAULT 18');
  }
  if (!searchPrefsCols.includes('proxy_url')) {
    db.exec("ALTER TABLE search_preferences ADD COLUMN proxy_url TEXT DEFAULT ''");
  }

  // Seed singleton rows
  if (!db.prepare('SELECT id FROM profile WHERE id = 1').get()) {
    db.prepare('INSERT INTO profile (id) VALUES (1)').run();
  }
  if (!db.prepare('SELECT id FROM search_preferences WHERE id = 1').get()) {
    db.prepare('INSERT INTO search_preferences (id) VALUES (1)').run();
  }
  if (!db.prepare('SELECT id FROM license WHERE id = 1').get()) {
    db.prepare("INSERT INTO license (id, status) VALUES (1, 'trial')").run();
  }


  return db;
}

function getDb() {
  if (!sqljsDb) throw new Error('Database not initialised — call init() first');
  return db;
}

// ── Profile ─────────────────────────────────────────────────────────────
function getProfile() {
  return db.prepare('SELECT * FROM profile WHERE id = 1').get();
}

function saveProfile(fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return getProfile();
  const setClause = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE profile SET ${setClause}, updated_at = datetime('now') WHERE id = 1`).run(fields);
  return getProfile();
}

// ── Search preferences ──────────────────────────────────────────────────
function getSearchPreferences() {
  const row = db.prepare('SELECT * FROM search_preferences WHERE id = 1').get();
  return { ...row, work_type_priority: JSON.parse(row.work_type_priority) };
}

function saveSearchPreferences(fields) {
  const data = { ...fields };
  if (data.work_type_priority) data.work_type_priority = JSON.stringify(data.work_type_priority);
  const cols = Object.keys(data);
  const setClause = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE search_preferences SET ${setClause} WHERE id = 1`).run(data);
  return getSearchPreferences();
}

// ── Search terms ─────────────────────────────────────────────────────────
function getSearchTerms(activeOnly = true) {
  const sql = activeOnly
    ? 'SELECT * FROM search_terms WHERE is_active = 1 ORDER BY id'
    : 'SELECT * FROM search_terms ORDER BY id';
  return db.prepare(sql).all();
}

function addSearchTerms(terms, source = 'user_added') {
  const existing = new Set(getSearchTerms(true).map(t => t.term.toLowerCase()));
  const insert = db.prepare('INSERT INTO search_terms (term, source) VALUES (?, ?)');
  const upsert = db.prepare('UPDATE search_terms SET is_active = 1 WHERE term = ? COLLATE NOCASE');
  const tx = db.transaction((items) => {
    for (const t of items) {
      if (existing.has(t.toLowerCase())) continue;
      const inactive = db.prepare('SELECT id FROM search_terms WHERE term = ? COLLATE NOCASE').get(t);
      if (inactive) { upsert.run(t); } else { insert.run([t, source]); }
      existing.add(t.toLowerCase());
    }
  });
  tx(terms);
  return getSearchTerms(true);
}

function deleteSearchTerm(id) {
  db.prepare('DELETE FROM search_terms WHERE id = ?').run([id]);
}

function setSearchTermActive(id, isActive) {
  db.prepare('UPDATE search_terms SET is_active = ? WHERE id = ?').run([isActive ? 1 : 0, id]);
}

// ── Exclude keywords ────────────────────────────────────────────────────
function getExcludeKeywords(activeOnly = true) {
  const sql = activeOnly
    ? 'SELECT * FROM exclude_keywords WHERE is_active = 1 ORDER BY id'
    : 'SELECT * FROM exclude_keywords ORDER BY id';
  return db.prepare(sql).all();
}

function addExcludeKeyword(keyword) {
  db.prepare('INSERT INTO exclude_keywords (keyword, is_default) VALUES (?, 0)').run([keyword]);
  return getExcludeKeywords(false);
}

function deleteExcludeKeyword(id) {
  db.prepare('DELETE FROM exclude_keywords WHERE id = ?').run([id]);
}

function setExcludeKeywordActive(id, isActive) {
  db.prepare('UPDATE exclude_keywords SET is_active = ? WHERE id = ?').run([isActive ? 1 : 0, id]);
}

// ── CVs ─────────────────────────────────────────────────────────────────
function getCVs(activeOnly = false) {
  const sql = activeOnly
    ? 'SELECT * FROM cvs WHERE is_active = 1 ORDER BY id'
    : 'SELECT * FROM cvs ORDER BY id';
  return db.prepare(sql).all().map(row => ({
    ...row,
    extracted_keywords: row.extracted_keywords ? JSON.parse(row.extracted_keywords) : [],
    suggested_roles: row.suggested_roles ? JSON.parse(row.suggested_roles) : [],
  }));
}

function addCV({ label, file_path, extracted_keywords = [], suggested_roles = [] }) {
  const result = db.prepare(`
    INSERT INTO cvs (label, file_path, extracted_keywords, suggested_roles)
    VALUES (@label, @file_path, @extracted_keywords, @suggested_roles)
  `).run({
    label, file_path,
    extracted_keywords: JSON.stringify(extracted_keywords),
    suggested_roles: JSON.stringify(suggested_roles),
  });
  return getCVs().find(c => c.id === result.lastInsertRowid);
}

function removeCV(id) {
  db.prepare('DELETE FROM cvs WHERE id = ?').run([id]);
}

// ── Credentials (encrypted via Electron safeStorage by caller) ────────────
function saveCredential({ site, username, secret_enc }) {
  const existing = db.prepare('SELECT id FROM credentials WHERE site = ?').get([site]);
  if (existing) {
    db.prepare('UPDATE credentials SET username = ?, secret_enc = ?, session_valid = 0 WHERE site = ?')
      .run([username, secret_enc, site]);
  } else {
    db.prepare('INSERT INTO credentials (site, username, secret_enc) VALUES (?, ?, ?)')
      .run([site, username, secret_enc]);
  }
  return db.prepare('SELECT * FROM credentials WHERE site = ?').get([site]);
}

function getCredential(site) {
  return db.prepare('SELECT * FROM credentials WHERE site = ?').get([site]);
}

// ── Bot runs ────────────────────────────────────────────────────────────
function recordBotStart(botName) {
  const result = db.prepare(`
    INSERT INTO bot_runs (date, bot_name, status, started_at)
    VALUES (date('now'), ?, 'running', datetime('now'))
  `).run([botName]);
  return result.lastInsertRowid;
}

function recordBotStop(botName, status = 'stopped') {
  db.prepare(`
    UPDATE bot_runs SET status = ?, stopped_at = datetime('now')
    WHERE id = (
      SELECT id FROM bot_runs WHERE bot_name = ? AND status = 'running' ORDER BY id DESC LIMIT 1
    )
  `).run([status, botName]);
}

// ── License ─────────────────────────────────────────────────────────────
function getLicense() {
  return db.prepare('SELECT * FROM license WHERE id = 1').get();
}

function saveLicense(fields) {
  const cols = Object.keys(fields);
  const setClause = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE license SET ${setClause} WHERE id = 1`).run(fields);
  return getLicense();
}

// ── Company blacklist ────────────────────────────────────────────────────
function getCompanyBlacklist() {
  return db.prepare('SELECT * FROM company_blacklist ORDER BY company ASC').all();
}

function addCompanyToBlacklist(company) {
  const trimmed = (company || '').trim();
  if (!trimmed) return null;
  db.prepare('INSERT OR IGNORE INTO company_blacklist (company) VALUES (?)').run([trimmed]);
  return db.prepare('SELECT * FROM company_blacklist WHERE company = ?').get([trimmed]);
}

function removeCompanyFromBlacklist(id) {
  db.prepare('DELETE FROM company_blacklist WHERE id = ?').run([id]);
}

// ── Interview Tracker ─────────────────────────────────────────────────────
function getTracker() {
  return db.prepare('SELECT * FROM tracker ORDER BY applied_at DESC').all();
}

function syncTrackerEntry({ job_id, title, company, url, source, cv_name, applied_at }) {
  if (!db.prepare('SELECT id FROM tracker WHERE job_id = ?').get([job_id])) {
    db.prepare(
      'INSERT INTO tracker (job_id, title, company, url, source, cv_name, applied_at) VALUES (?,?,?,?,?,?,?)'
    ).run([job_id, title || null, company || null, url || null, source || null, cv_name || null, applied_at || null]);
  }
}

function updateTrackerEntry(id, { stage, notes }) {
  const sets = [];
  const vals = [];
  if (stage !== undefined) { sets.push('stage = ?'); vals.push(stage); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE tracker SET ${sets.join(', ')} WHERE id = ?`).run([...vals, id]);
}

function deleteTrackerEntry(id) {
  db.prepare('DELETE FROM tracker WHERE id = ?').run([id]);
}

module.exports = {
  init,
  getDb,
  getProfile,
  saveProfile,
  getSearchPreferences,
  saveSearchPreferences,
  getSearchTerms,
  addSearchTerms,
  deleteSearchTerm,
  setSearchTermActive,
  getExcludeKeywords,
  addExcludeKeyword,
  deleteExcludeKeyword,
  setExcludeKeywordActive,
  getCVs,
  addCV,
  removeCV,
  saveCredential,
  getCredential,
  recordBotStart,
  recordBotStop,
  getLicense,
  saveLicense,
  getCompanyBlacklist,
  addCompanyToBlacklist,
  removeCompanyFromBlacklist,
  getTracker,
  syncTrackerEntry,
  updateTrackerEntry,
  deleteTrackerEntry,
};
