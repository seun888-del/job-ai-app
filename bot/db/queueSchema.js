module.exports = `
CREATE TABLE IF NOT EXISTS queue (
  job_id TEXT PRIMARY KEY,
  title TEXT,
  company TEXT,
  url TEXT,
  source TEXT,
  description TEXT,
  status TEXT CHECK(status IN ('pending','processing','cv_ready','applying','applied','apply_failed','skipped','failed')) DEFAULT 'pending',
  reason TEXT,
  work_type TEXT,
  cv_name TEXT,
  cv_score INTEGER,
  cv_path TEXT,
  error TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS applied_jobs (
  job_id TEXT PRIMARY KEY,
  title TEXT,
  company TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);
`;
