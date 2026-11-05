// Browser stand-in for the desktop app's bot/config.js. The shared agent modules read the
// user's details from here; the dashboard fills it from storage before each run (load()).
const cfg = {
  // Paths live in the in-browser file system (shims/fs.js).
  OUTPUT_DIR: '/jobai/output',
  LOGS_DIR: '/jobai/logs',
  SCREENSHOTS_DIR: '/jobai/screenshots',
  SESSION_FILE: '/jobai/reed_session.json',
  RESUME_FILENAME: 'Resume.pdf',
  MAX_JOBS_PER_SEARCH: 50,

  APPLICANT: {},
  JOB_SEARCHES: [],
  TRAC_SECTORS: [],
  TRAC_DETAILS: {},
  CVS: [],
  TITLE_BLOCKLIST: [],
  COMPANY_BLOCKLIST: [],
  WORK_TYPE_PRIORITY: ['remote', 'hybrid', 'onsite'],
  LOCATION: 'United Kingdom',
  CONTRACT_TYPE: 'any',
  JOB_AGE: 'r1209600',
  SKIP_EXTERNAL_SITES: true,
  MAX_APPLICATIONS_PER_DAY: 25,
  PLAN_CAP: 25,
  SCHEDULE: null,
  MATCH_LEVEL: 'balanced',  // how picky the must-haves check is: wide, balanced or strict
  // "Only move for more money": for people happy where they are. Only jobs whose advert
  // shows a salary at least `uplift`% above theirs, never their own employer, few a month.
  MOVE: { on: false },
  async init() {},

  // Map the extension's stored profile onto the field names the shared modules expect
  // (same names the desktop app's config.js builds from profile.db).
  load({ profile = {}, trac = {}, settings = {}, license = {} } = {}) {
    const first = profile.firstName || trac.firstName || '';
    const last = profile.lastName || trac.lastName || '';
    cfg.APPLICANT = {
      firstName: first,
      middleName: profile.middleName || trac.middleName || '',
      lastName: last,
      phone: profile.phone || trac.mobile || '',
      email: profile.email || trac.email || '',
      location: profile.location || trac.city || '',
      address: profile.address || trac.address || '',
      linkedin: profile.linkedin || '',
      yearsExperience: Number(profile.yearsExperience || 0),
      rightToWorkCountries: String(profile.rightToWorkCountries || 'United Kingdom').split(',').map((s) => s.trim()).filter(Boolean),
      requiresSponsorship: !!profile.requiresSponsorship,
      seekSponsorship: !!profile.seekSponsorship,
      drivingLicence: !!profile.drivingLicence,
      britishCitizen: profile.britishCitizen || '',
      ukResidence: profile.ukResidence || '',
      salaryExpectation: profile.salaryExpectation || '',
      country: profile.country || 'United Kingdom',
      experienceLevel: profile.experienceLevel || '',
      employmentType: Array.isArray(profile.employmentType) && profile.employmentType.length ? profile.employmentType : ['full_time'],
      availability: profile.availability || 'immediately',
      willingToRelocate: !!profile.willingToRelocate,
      eeoGender: profile.eeoGender || '',
      eeoEthnicity: profile.eeoEthnicity || '',
      eeoDisability: profile.eeoDisability || '',
      eeoVeteran: profile.eeoVeteran || '',
    };
    cfg.TRAC_DETAILS = trac || {};
    cfg.TRAC_SECTORS = Array.isArray(trac.sectors) ? trac.sectors : [];
    cfg.JOB_SEARCHES = Array.isArray(profile.searchTerms) ? profile.searchTerms : [];
    cfg.TITLE_BLOCKLIST = (profile.excludeKeywords || []).map((k) => String(k).toLowerCase());
    cfg.COMPANY_BLOCKLIST = (profile.blockedCompanies || []).map((k) => String(k).toLowerCase());
    cfg.WORK_TYPE_PRIORITY = Array.isArray(profile.workTypePriority) && profile.workTypePriority.length ? profile.workTypePriority : ['remote', 'hybrid', 'onsite'];
    cfg.LOCATION = profile.searchLocation || ((settings && settings.region) === 'us' ? 'United States' : 'United Kingdom');
    cfg.CONTRACT_TYPE = profile.contractType || 'any';
    cfg.JOB_AGE = profile.jobAge || 'r1209600';
    cfg.SKIP_EXTERNAL_SITES = profile.skipExternalSites !== false;
    cfg.PLAN_CAP = license.status === 'active' ? 25 : 15;
    cfg.MAX_APPLICATIONS_PER_DAY = Math.min(Number(settings.dailyCap || 15), cfg.PLAN_CAP);
    // Older versions had a % box; 70 or more there meant close matches only.
    cfg.MATCH_LEVEL = profile.matchLevel || (Number(profile.minScore) >= 70 ? 'strict' : 'balanced');
    cfg.SCHEDULE = settings.schedule || null;
    const mv = profile.moveForMore || {};
    const now = parseInt(String(mv.current || '').replace(/[^0-9]/g, ''), 10) || 0;
    if (mv.on && now >= 10000) {
      const uplift = Math.min(100, Math.max(5, Number(mv.uplift) || 15));
      const employer = String(mv.employer || '').trim();
      cfg.MOVE = { on: true, current: now, uplift, min: Math.round(now * (1 + uplift / 100)), monthly: Math.min(30, Math.max(1, Number(mv.monthly) || 8)), employer };
      if (employer.length >= 3) cfg.COMPANY_BLOCKLIST = [...cfg.COMPANY_BLOCKLIST, employer.toLowerCase()];
    } else cfg.MOVE = { on: false };
    const full = `${first} ${last}`.trim();
    cfg.RESUME_FILENAME = full ? `${full} Resume.pdf` : 'Resume.pdf';
  },

  // Same rule as the app: with a schedule on, agents only search and apply on those days and hours.
  // Returns why it is waiting, or '' when it may work now.
  outsideSchedule() {
    const s = cfg.SCHEDULE;
    if (!s || !s.enabled) return '';
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = Array.isArray(s.days) && s.days.length ? s.days : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const from = Number(s.start ?? 9), to = Number(s.end ?? 18), now = new Date(), h = now.getHours();
    if (days.includes(DAYS[now.getDay()]) && h >= from && h < to) return '';
    const hh = (n) => String(n % 24).padStart(2, '0') + ':00';
    return `Outside your schedule (${days.join(', ')}, ${hh(from)} to ${hh(to)}). Waiting.`;
  },

  // "Only move for more money" check for one job: '' when it may go ahead, else why not.
  // The advert must SHOW a salary that reaches the target; no salary shown = no proof.
  moveCheck(job) {
    const m = cfg.MOVE;
    if (!m || !m.on) return '';
    const bare = (s) => String(s || '').toLowerCase().replace(/\b(ltd|limited|plc|llc|inc|group)\b\.?/g, '').replace(/\s+/g, ' ').trim();
    const co = bare(job.company), emp = bare(m.employer);
    if (emp.length >= 3 && co.length >= 3 && (co.includes(emp) || emp.includes(co))) return 'Your current employer';
    const text = String(job.title || '') + ' ' + String(job.description || '') + ' ' + String(job.salary || '');
    const us = cfg.APPLICANT.country === 'United States';
    const re = us ? /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\b/gi : /£\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\b/gi;
    const pays = [...text.matchAll(re)].map((x) => { const n = parseFloat(x[1].replace(/,/g, '')); return x[2] ? n * 1000 : n; })
      .filter((n) => n >= 10000 && n <= 500000);
    if (!pays.length) return 'No salary shown (you only move for more money)';
    const top = Math.max(...pays);
    if (top < m.min) return `Pays under ${us ? '$' : '£'}${m.min.toLocaleString('en-GB')} (${m.uplift}% more than you)`;
    return '';
  },

  // Same check as the desktop app: listings that are really paid training courses.
  isTrainingCourseJD(description, title) {
    const d = (description || '').toLowerCase();
    const t = (title || '').toLowerCase();
    if (/training course|training programme/.test(t)) return true;
    if (/£\s*training/i.test(description || '')) return true;
    if (/this is a training|fully.?funded training|funded training course|pay for your (own )?training|enrol(l?) (on|onto) (this|the|a) (course|programme)|no experience needed.*training provided/.test(d)) return true;
    return false;
  },
};
module.exports = cfg;
