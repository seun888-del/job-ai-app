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
  MIN_SCORE: 0,  // same as the app: no minimum unless the user sets one (the 45% floor still applies)
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
    cfg.PLAN_CAP = license.status === 'active' ? 25 : 5;
    cfg.MAX_APPLICATIONS_PER_DAY = Math.min(Number(settings.dailyCap || 15), cfg.PLAN_CAP);
    cfg.MIN_SCORE = Number(profile.minScore) || 0;
    cfg.SCHEDULE = settings.schedule || null;
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
