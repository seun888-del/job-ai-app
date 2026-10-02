/**
 * cvProfile.js
 * ─────────────────────────────────────────────────────────────────────────
 * "Upload your CV and we fill in the rest": one AI read of the CV returns the
 * person's contact details, experience, the job titles they fit and their skill
 * keywords. The desktop app (cvAnalyzer) and the Chrome extension (dashboard.js)
 * both use this, so a new user's setup is one upload instead of a long form.
 *
 * Everything is validated before use and never invented: a field the CV doesn't
 * show comes back empty, and callers only fill fields the user left blank.
 */

const { llmChat, llmAvailable } = require('./llm');

const LEVELS = ['entry', 'junior', 'mid', 'senior', 'lead', 'director', 'executive'];

function extractJson(s) {
  const m = String(s || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {
    try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (__) { return null; }
  }
}

const str = (v, max = 120) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v, max) => (Array.isArray(v) ? v : [])
  .map((x) => str(x, 60)).filter((x) => x.length >= 2).slice(0, max);

// "FEMI" -> "Femi", "o'NEIL-SMITH" -> "O'Neil-Smith"; mixed-case names are left alone.
const nameCase = (n) => (n && n === n.toUpperCase()
  ? n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : n);

// First/last name, falling back to the full name when the AI only split part of it.
function names(j) {
  let first = str(j.firstName, 40), middle = str(j.middleName, 40), last = str(j.lastName, 40);
  const full = str(j.fullName, 80).split(' ').filter(Boolean);
  if (first.includes(' ') && !last) { const w = first.split(' '); first = w[0]; last = w[w.length - 1]; }
  if (full.length >= 2 && (!first || !last)) {
    first = first || full[0];
    last = last || full[full.length - 1];
    if (!middle && full.length > 2) middle = full.slice(1, -1).join(' ');
  }
  return { firstName: nameCase(first), middleName: nameCase(middle), lastName: nameCase(last) };
}

// Keep only values that look like what they claim to be.
function normalise(j) {
  j = j || {};
  const email = str(j.email).toLowerCase();
  const phone = str(j.phone, 30);
  const linkedin = str(j.linkedin, 200);
  const years = Math.round(Number(j.yearsExperience));
  const level = str(j.experienceLevel).toLowerCase();
  return {
    ...names(j),
    email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) ? email : '',
    phone: /^[+\d][\d\s().-]{6,}$/.test(phone) ? phone : '',
    location: str(j.location, 80),
    linkedin: /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(linkedin) ? linkedin
      : /^([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(linkedin) ? 'https://' + linkedin : '',
    yearsExperience: Number.isFinite(years) && years > 0 && years <= 60 ? years : 0,
    experienceLevel: LEVELS.includes(level) ? level : '',
    roles: list(j.roles, 8),
    keywords: list(j.keywords, 25),
  };
}

async function readCvProfile(text) {
  if (!text || text.replace(/\s/g, '').length < 120) throw new Error('Could not read any text from that CV.');
  if (!(await llmAvailable())) throw new Error('Reading your CV needs the AI, which is unavailable right now. Check your license, then try again.');

  const prompt =
`Read this CV and return ONLY a JSON object with these keys (use "" , 0 or [] when the CV does not show it; never guess or invent):
{"fullName":"","firstName":"","middleName":"","lastName":"","email":"","phone":"","location":"","linkedin":"","yearsExperience":0,"experienceLevel":"","roles":[],"keywords":[]}
Rules: "fullName" is the candidate's name exactly as written at the top of the CV, and first/middle/last split it; names are the CANDIDATE's own (never a referee's or employer's); "location" is the candidate's town/city and county/state, e.g. "Leeds, West Yorkshire"; "linkedin" is the full linkedin.com/in/ link if shown; "yearsExperience" is total years of paid work from the employment dates; "experienceLevel" is one of entry|junior|mid|senior|lead|director|executive based on their most recent role; "roles" are up to 8 specific job titles this person is qualified to apply for now, based on their actual experience; "keywords" are up to 25 short skill, tool or qualification keywords from the CV.

CV TEXT:
${text.slice(0, 12000)}`;

  const j = extractJson(await llmChat(prompt, 90000));
  if (!j) throw new Error('The AI could not read that CV. Please try again.');
  return normalise(j);
}

module.exports = { readCvProfile, normalise };
