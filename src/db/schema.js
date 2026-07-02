module.exports = `
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  email TEXT,
  location TEXT,
  address TEXT,
  linkedin_url TEXT,
  right_to_work_countries TEXT DEFAULT 'United Kingdom',
  requires_sponsorship INTEGER DEFAULT 0,
  driving_licence INTEGER DEFAULT 0,
  years_experience INTEGER DEFAULT 0,
  max_applications_per_day INTEGER DEFAULT 15,
  skip_external_sites INTEGER DEFAULT 1,
  min_match_score INTEGER,
  notification_enabled INTEGER DEFAULT 1,
  country TEXT DEFAULT 'United Kingdom',
  experience_level TEXT,
  employment_type TEXT,
  availability TEXT DEFAULT 'immediately',
  willing_to_relocate INTEGER DEFAULT 0,
  eeo_gender TEXT,
  eeo_ethnicity TEXT,
  eeo_disability TEXT,
  eeo_veteran TEXT,
  eeo_sexual_orientation TEXT,
  seek_sponsorship INTEGER DEFAULT 0,
  onboarding_complete INTEGER DEFAULT 0,
  salary_expectation TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL UNIQUE,
  username TEXT,
  secret_enc TEXT,
  session_valid INTEGER DEFAULT 0,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS cvs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  file_path TEXT NOT NULL,
  extracted_keywords TEXT,
  suggested_roles TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  source TEXT CHECK(source IN ('ai_generated','user_added')) DEFAULT 'user_added',
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS exclude_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS search_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  work_type_priority TEXT DEFAULT '["remote","hybrid","onsite"]',
  contract_type TEXT CHECK(contract_type IN ('permanent','contract','any')) DEFAULT 'any',
  location TEXT DEFAULT 'United Kingdom',
  job_age TEXT DEFAULT 'r1209600'
);

CREATE TABLE IF NOT EXISTS bot_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  bot_name TEXT,
  applications_count INTEGER DEFAULT 0,
  status TEXT CHECK(status IN ('running','stopped','error')) DEFAULT 'stopped',
  started_at TEXT,
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS license (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license_key TEXT,
  status TEXT CHECK(status IN ('trial','active','expired')) DEFAULT 'trial',
  email TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS company_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL UNIQUE,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tracker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  title TEXT,
  company TEXT,
  url TEXT,
  source TEXT,
  cv_name TEXT,
  applied_at TEXT,
  stage TEXT DEFAULT 'applied',
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;
