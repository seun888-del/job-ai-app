// Bot config — replaces linkedin_bot/config.js. Static paths are computed
// synchronously at require-time (modules like reed.js / logger.js read them
// at module-top-level). Everything else is populated by init(), which does a
// READ-ONLY load of profile.db (Electron main owns writes to that file —
// the bot process must never persist back to it).

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const USER_DATA = process.env.JOBBOT_USERDATA;
if (!USER_DATA) {
  throw new Error('JOBBOT_USERDATA environment variable is required');
}

// ── Static paths — available synchronously at require-time ──
const OUTPUT_DIR = path.join(USER_DATA, 'output');
const LOGS_DIR = path.join(USER_DATA, 'logs');
const SCREENSHOTS_DIR = path.join(USER_DATA, 'screenshots');
const SESSION_FILE = path.join(USER_DATA, 'reed_session.json');
for (const dir of [OUTPUT_DIR, LOGS_DIR, SCREENSHOTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const cfg = {
  // ── Credentials (set via env vars by the bot manager) ──
  REED_EMAIL: process.env.REED_EMAIL,
  REED_PASSWORD: process.env.REED_PASS,

  // ── Paths ──
  OUTPUT_DIR,
  LOGS_DIR,
  SCREENSHOTS_DIR,
  SESSION_FILE,
  RESUME_FILENAME: 'Resume.pdf', // placeholder — replaced in init() with "<Name> Resume.pdf"

  // ── Search limits (not yet user-configurable) ──
  MAX_JOBS_PER_SEARCH: 50,

  // ── Populated by init() from profile.db ──
  APPLICANT: {},
  JOB_SEARCHES: [],
  CVS: [],
  TITLE_BLOCKLIST: [],
  WORK_TYPE_PRIORITY: ['remote', 'hybrid', 'onsite'],
  LOCATION: 'United Kingdom',
  CONTRACT_TYPE: 'any',
  SKIP_EXTERNAL_SITES: true,
  MAX_APPLICATIONS_PER_DAY: 15,
  MIN_SCORE: 0,

  // Read profile.db (read-only) and populate the fields above.
  async init() {
    const SQL = await initSqlJs();
    const dbPath = path.join(USER_DATA, 'profile.db');
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    try {
      const get = (sql) => {
        const stmt = db.prepare(sql);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      };
      const all = (sql) => {
        const stmt = db.prepare(sql);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      };

      const profile = get('SELECT * FROM profile WHERE id = 1') || {};
      const prefs = get('SELECT * FROM search_preferences WHERE id = 1') || {};
      const terms = all('SELECT term FROM search_terms WHERE is_active = 1 ORDER BY id');
      const excludes = all('SELECT keyword FROM exclude_keywords WHERE is_active = 1 ORDER BY id');
      const cvs = all('SELECT * FROM cvs WHERE is_active = 1 ORDER BY id');

      cfg.APPLICANT = {
        firstName: profile.first_name || '',
        lastName: profile.last_name || '',
        phone: profile.phone || '',
        email: profile.email || '',
        location: profile.location || '',
        linkedin: profile.linkedin_url || '',
        yearsExperience: profile.years_experience ?? 0,
        rightToWorkCountries: (profile.right_to_work_countries || 'United Kingdom').split(',').map(s => s.trim()).filter(Boolean),
        requiresSponsorship: !!profile.requires_sponsorship,
        seekSponsorship: !!profile.seek_sponsorship,
        drivingLicence: !!profile.driving_licence,
        salaryExpectation: profile.salary_expectation || '',
      };

      cfg.JOB_SEARCHES = terms.map(t => t.term);
      cfg.TITLE_BLOCKLIST = excludes.map(e => e.keyword.toLowerCase());

      cfg.CVS = cvs.map(cv => ({
        id: cv.id,
        name: cv.label,
        path: cv.file_path,
        keywords: cv.extracted_keywords ? JSON.parse(cv.extracted_keywords) : [],
      }));

      try {
        cfg.WORK_TYPE_PRIORITY = JSON.parse(prefs.work_type_priority || '["remote","hybrid","onsite"]');
      } catch {
        cfg.WORK_TYPE_PRIORITY = ['remote', 'hybrid', 'onsite'];
      }
      cfg.LOCATION = prefs.location || 'United Kingdom';
      cfg.CONTRACT_TYPE = prefs.contract_type || 'any';
      cfg.JOB_AGE = prefs.job_age || 'r1209600';

      cfg.SKIP_EXTERNAL_SITES = !!profile.skip_external_sites;
      cfg.MAX_APPLICATIONS_PER_DAY = profile.max_applications_per_day ?? 15;
      cfg.MIN_SCORE = profile.min_match_score ?? 0;

      const fullName = `${cfg.APPLICANT.firstName} ${cfg.APPLICANT.lastName}`.trim();
      cfg.RESUME_FILENAME = fullName ? `${fullName} Resume.pdf` : 'Resume.pdf';
    } finally {
      db.close();
    }
  },
};

module.exports = cfg;
