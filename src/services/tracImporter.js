/**
 * tracImporter.js
 * ─────────────────────────────────────────────────────────────────────────
 * "Upload a completed Trac form" feature: the user uploads a PDF of a Trac
 * application they've already filled (downloaded from apps.trac.jobs), and we
 * extract every answer into the app so they never re-type it. The NHS Trac PDF
 * is a consistent 8-section layout, but its text order is messy, so we let the
 * licensed AI read it and return structured JSON — far more robust than regex.
 */

const { extractPdfText } = require('./cvAnalyzer');
const { llmChat, llmAvailable } = require('./llm');

function extractJson(s) {
  if (!s) return null;
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {
    try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (__) { return null; }
  }
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v).trim());

// Map the AI's extracted JSON to the app's profile + trac_details shapes.
function normalise(j) {
  j = j || {};
  // Trac is a self-contained agent: everything (incl. name/address) lives in trac_details,
  // separate from the main profile that the other agents use. profile stays empty.
  const profile = {};

  const norm = (v) => str(v).toLowerCase();
  const yn = (v) => (/^y|yes|true/.test(norm(v)) ? 'yes' : /^n|no|false/.test(norm(v)) ? 'no' : '');

  const trac = {
    firstName: str(j.firstName), middleName: str(j.middleName), lastName: str(j.lastName),
    email: str(j.email), mobile: str(j.mobile || j.phone),
    address: str(j.address), city: str(j.city), county: str(j.county),
    postcode: str(j.postcode), country: str(j.country),
    // Accept "title" ONLY if it's a real personal salutation — never a job/vacancy title
    // (the AI sometimes grabs the "Application for: <role>" line).
    title: (/^(mr|mrs|ms|miss|dr|mx|prof|sir|rev|master)\.?$/i.test(str(j.title)) ? str(j.title) : ''),
    ni: str(j.ni || j.nationalInsurance),
    dob: str(j.dob || j.dateOfBirth),
    rightToWork: str(j.rightToWork || j.immigrationStatus),
    convictions: yn(j.convictions) || 'no',
    convictionDetails: str(j.convictionDetails),
    gender: str(j.gender),
    genderSameAsBirth: str(j.genderSameAsBirth),
    trans: str(j.trans),
    ethnicity: str(j.ethnicity),
    sexualOrientation: str(j.sexualOrientation),
    religion: str(j.religion),
    maritalStatus: str(j.maritalStatus),
    disability: str(j.disability),
    guaranteedInterview: str(j.guaranteedInterview),
    adjustments: str(j.adjustments),
    armedForces: str(j.armedForces),
    schoolType: str(j.schoolType),
    freeSchoolMeals: str(j.freeSchoolMeals),
    socioOccupation: str(j.socioOccupation),
    howHeard: str(j.howHeard),
    employment: arr(j.employment).map((e) => ({
      employer: str(e.employer || e.employerName), jobTitle: str(e.jobTitle || e.title),
      start: str(e.start || e.startDate), end: str(e.end || e.endDate),
      reason: str(e.reason || e.reasonForLeaving), duties: str(e.duties || e.description),
    })).filter((e) => e.employer || e.jobTitle),
    education: arr(j.education).map((e) => ({
      qualification: str(e.qualification || e.subject), place: str(e.place || e.placeOfStudy),
      grade: str(e.grade || e.result), year: str(e.year || e.yearObtained),
    })).filter((e) => e.qualification),
    references: arr(j.references).map((r) => ({
      name: str(r.name || [r.firstName, r.surname].filter(Boolean).join(' ')),
      org: str(r.org || r.organisation), jobTitle: str(r.jobTitle || r.title),
      email: str(r.email), phone: str(r.phone || r.telephone || r.mobile),
      relationship: str(r.relationship || r.howKnow),
      address: str(r.address || r.address1 || r.addressLine1), city: str(r.city || r.town),
      postcode: str(r.postcode || r.postCode || r.zip),
    })).filter((r) => r.name),
  };
  // Drop empty scalar keys so we don't overwrite existing values with blanks.
  Object.keys(trac).forEach((k) => { if (trac[k] === '' ) delete trac[k]; });
  return { profile, trac };
}

async function importTracPdf(filePath) {
  return importTracText(await extractPdfText(filePath));
}

// Same, from text already extracted (the Chrome extension reads the PDF in the browser).
async function importTracText(text) {
  if (!text || text.replace(/\s/g, '').length < 120) throw new Error('Could not read any text from that PDF.');
  if (!(await llmAvailable())) throw new Error('Reading the form needs the AI, which is currently unavailable. Try again shortly.');

  // Scalars + references + education FIRST, big employment array LAST, and keep duties to
  // one short line — so a truncated response never loses the references/equality answers.
  const prompt =
`Extract a candidate's answers from this NHS "Trac" job application form (Civica). Return ONLY JSON with these keys (use "" or [] when absent, never invent data):
{"title":"","firstName":"","middleName":"","lastName":"","address":"","city":"","county":"","postcode":"","email":"","mobile":"","ni":"","dob":"","rightToWork":"","convictions":"yes|no","convictionDetails":"","gender":"","genderSameAsBirth":"","trans":"","ethnicity":"","sexualOrientation":"","religion":"","maritalStatus":"","disability":"","guaranteedInterview":"","adjustments":"","armedForces":"","schoolType":"","freeSchoolMeals":"","socioOccupation":"","howHeard":"","education":[{"qualification":"","place":"","grade":"","year":""}],"references":[{"name":"","org":"","jobTitle":"","email":"","phone":"","relationship":"","address":"","city":"","postcode":""}],"employment":[{"employer":"","jobTitle":"","start":"","end":"","reason":"","duties":""}]}
Rules: "title" is the candidate's PERSONAL title / salutation ONLY (Mr, Mrs, Ms, Miss, Dr, Mx) — NEVER the job/vacancy title or the "Application for:" line; leave "" if no personal title is shown. employment most-recent-first; keep each "duties" to ONE short sentence (do not copy the full bullet list); dob and dates as written; rightToWork is the immigration status line (e.g. "British citizen"); ethnicity/gender/religion exactly as the form shows (e.g. "Black Nigerian", "Male", "Christianity"); references may be under "Current/main activity" or a References section, and include each referee's address/city/postcode when shown; howHeard is "where you first saw this post"; "trans" is the answer to "have you ever identified as trans or transgender" and "genderSameAsBirth" is ONLY the answer to "is your gender the same as assigned at birth" (never copy one into the other); armedForces/schoolType/freeSchoolMeals/socioOccupation come from the socio-economic / social-mobility monitoring questions (leave "" if the form has no such question).

FORM TEXT:
${text.slice(0, 30000)}`;

  const reply = await llmChat(prompt, 60000);
  const j = extractJson(reply);
  if (!j) throw new Error('The AI could not read that form. Make sure it is a completed Trac application PDF.');
  const out = normalise(j);
  out.counts = {
    employment: out.trac.employment ? out.trac.employment.length : 0,
    education: out.trac.education ? out.trac.education.length : 0,
    references: out.trac.references ? out.trac.references.length : 0,
  };
  return out;
}

module.exports = { importTracPdf, importTracText, normalise };
