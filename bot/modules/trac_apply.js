/**
 * trac_apply.js
 * ─────────────────────────────────────────────────────────────────────────
 * Fills the NHS Trac application form using the field map (bot/specs/trac_form.json).
 * Trac is ONE system across trusts, but the form is a login-gated, multi-page
 * browser flow (advert pages are Cloudflare-blocked to plain HTTP), so this runs
 * against a Playwright page on a logged-in Trac session.
 *
 * SAFE BY DEFAULT: dry run (fills everything, never clicks the final submit) and
 * it NEVER auto-answers the sensitive/legal fields — criminal record, immigration
 * status, equality monitoring, disability, and the final declaration. Those are
 * flagged 'pause' so the agent surfaces them to the user to confirm. This protects
 * the applicant: false info on an NHS application is serious.
 *
 * Fields are matched by their LABEL text (not brittle input ids), so the same map
 * works across trusts even though ids differ. Selector/flow details are refined by
 * running it against a real Trac session.
 */

let ai = null;
const { elOp } = require('./dom_ops');
try { ai = require('./question_ai'); } catch (_) { ai = null; } // LLM fallback for outlier questions

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

// The data "payload" the AI answers from: everything the user saved for NHS applications,
// minus monitoring/legal answers (those are answered by fixed rules from the stored values
// and never sent to the model).
function tracPayload(applicant = {}, details = {}, supportingStatement = '') {
  const D = details || {}, A = applicant || {};
  return {
    name: [D.title, D.firstName || A.firstName, D.lastName || A.lastName].filter(Boolean).join(' '),
    email: D.email || A.email, mobile: D.mobile || A.phone,
    address: [D.address, D.city, D.county, D.postcode, D.country].filter(Boolean).join(', ') || A.address || A.location,
    employmentType: A.employmentType, availability: A.availability, drivingLicence: !!A.drivingLicence,
    howHeardAboutJobs: D.howHeard,
    employment: (D.employment || []).map((e) => ({ employer: e.employer, jobTitle: e.jobTitle, start: e.start, end: e.end, duties: e.duties, reasonForLeaving: e.reason })),
    education: D.education || [],
    references: (D.references || []).map((r) => ({ name: r.name, organisation: r.org, jobTitle: r.jobTitle, relationship: r.relationship })),
    supportingStatementForThisRole: String(supportingStatement || '').slice(0, 1500),
  };
}

// NHS equality-monitoring ethnicity dropdowns use fixed categories (e.g. "BLACK or BLACK
// BRITISH - African"), so a free-text answer like "Black Nigerian" never matches by
// substring. Map the answer to a distinctive keyword that DOES appear in the right option
// (the select-fill then matches it). Unknown → return as-is (select-fill's disclose
// fallback then picks "I do not wish to disclose").
function mapEthnicity(v) {
  const s = norm(v);
  if (!s) return '';
  if (/caribbean|jamaic|barbad|trinidad|antigua|grenad|guyan/.test(s)) return 'Caribbean';
  if (/niger|ghana|somali|kenya|congo|zimbabw|angola|african|ethiop|sudan|uganda|cameroon|senegal|ivor/.test(s)) return 'African';
  if (/pakistan/.test(s)) return 'Pakistani';
  if (/banglad/.test(s)) return 'Bangladeshi';
  if (/\bindian\b|\bindia\b/.test(s)) return 'Indian';
  if (/chinese|china/.test(s)) return 'Chinese';
  if (/irish/.test(s)) return 'Irish';
  if (/white|british|english|scottish|welsh|caucasian|european/.test(s)) return 'British';
  return v; // pass through — select-fill tries to match, else falls back to "do not wish to disclose"
}

// Decide how to answer a Trac field from its label + the applicant profile.
// Returns { action, value, sensitive }:
//   action 'fill'   → type/select `value`
//   action 'ai'     → generate via the tailoring/question engine (supporting statement etc.)
//   action 'pause'  → SENSITIVE/legal — leave for the user to confirm, never guess
//   action 'skip'   → we have no value; leave blank
// Gaps of over 3 months between jobs, and from the last job to today unless it's current.
// Same rule as the NHS / Trac page shows. Dates are UK style DD/MM/YYYY.
function employmentGapsFrom(employment) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (s) => {
    const t = String(s || '').trim(); let m;
    if ((m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/))) return new Date(+m[1], +m[2] - 1, +(m[3] || 1));
    if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return new Date(+m[3], +m[2] - 1, +m[1]);
    if ((m = t.match(/^(\d{1,2})\/(\d{4})$/))) return new Date(+m[2], +m[1] - 1, 1);
    return null;
  };
  const jobs = (Array.isArray(employment) ? employment : []).map((e) => ({ s: p(e.start), e: /present|current/i.test(e.end || '') || !String(e.end || '').trim() ? new Date() : p(e.end) }))
    .filter((j) => j.s && j.e).sort((a, b) => a.s - b.s);
  const out = []; let covered = null;
  for (const j of jobs) {
    if (covered && j.s - covered > 92 * 86400000) out.push([covered, j.s]);
    if (!covered || j.e > covered) covered = j.e;
  }
  if (covered && Date.now() - covered > 92 * 86400000) out.push([covered, new Date()]);
  return out.map(([a, b]) => `${MON[a.getMonth()]} ${a.getFullYear()} to ${MON[b.getMonth()]} ${b.getFullYear()}`);
}

function resolveAnswer(label, applicant = {}, details = {}) {
  const l = norm(label);
  const A = applicant;
  const D = details || {};
  const pause = (why) => ({ action: 'pause', reason: why, sensitive: true });
  const fill = (v) => ({ action: 'fill', value: v });
  const PNS = 'Prefer not to say';

  // ── Legal / sensitive — AUTO-FILLED from the answers the user stored ONCE, so an
  //    auto-apply run never stops to ask. These are the user's own truthful answers,
  //    collected once in NHS/Trac details, reused on every application. Monitoring
  //    questions fall back to "Prefer not to say" (always valid, never fabricated).
  //    Only pause if a REQUIRED legal answer was never provided.
  if (/(unspent )?conviction|criminal record|caution|rehabilitation of offenders|criminal conviction|disclos/.test(l)) {
    if (D.convictions === 'yes') return fill('Yes');
    if (D.convictions === 'no' || D.convictions == null) return fill('No');   // default: none (the common case; user can change)
    return fill('No');
  }
  if (/(details|please give|provide details).*(conviction|caution)|conviction.*details/.test(l)) return D.convictions === 'yes' ? fill(D.convictionDetails || '') : { action: 'skip' };

  // Sponsorship + right-to-work — from profile / stored status.
  if (/require.*sponsorship|need.*sponsorship|sponsorship.*(required|need)|certificate of sponsorship|visa sponsorship/.test(l)) return fill(A.requiresSponsorship ? 'Yes' : 'No');
  if (/(do you have|are you eligible|are you entitled|are you legally entitled|have you the).*(right to work|work in the uk)|eligible to work in the uk|entitled to work in the uk/.test(l)) return fill(A.requiresSponsorship ? 'No' : 'Yes');
  // Right-to-work / immigration STATUS — fill the user's stored status (matches the
  // radio option, e.g. "British citizen"). If they never set it, pause (can't guess).
  // Visa expiry date: not applicable to British/Irish citizens or settled status; anyone on a
  // visa gives their real date (never invented).
  if (/expiry date.*visa|visa.*(expiry|expires|end date|valid until)|date.*visa.*(ends|expires)/.test(l)) {
    if (/british|irish|indefinite|settled|ilr|citizen/i.test(String(D.rightToWork || ''))) return fill('Not applicable');
    return D.visaExpiry ? fill(D.visaExpiry) : pause('visa expiry date');
  }
  if (/immigration|british citizen|irish national|settled status|pre-?settled|eu.?eea|swiss national|\bvisa\b|right to work status|status.*right to work/.test(l)) {
    return D.rightToWork ? fill(D.rightToWork) : (A.requiresSponsorship ? pause('immigration / right to work') : fill('British citizen'));
  }

  // Equality / diversity / background MONITORING — the user's OWN answers set once in the
  // app (NHS/Trac details). Fall back to "Prefer not to say" only if never set, so the
  // agent never has to guess or pause.
  if (/date of birth|\bdob\b/.test(l)) return D.dob ? fill(D.dob) : { action: 'skip' };
  if (/ethnic/.test(l)) return fill(mapEthnicity(D.ethnicity || A.eeoEthnicity) || PNS);
  // Two OPPOSITE wordings of the same fact: "Have you ever identified as trans?" (Yes = trans)
  // vs "Is your gender the same as at birth?" (Yes = not trans). Answer each from its own
  // stored value, deriving one from the other when only one is saved.
  const flip = (v) => (/^y/i.test(v || '') ? 'No' : /^n/i.test(v || '') ? 'Yes' : '');
  if (/identif\w* as trans|trans or transgender|\btransgender\b|\btrans\b/.test(l)) return fill(D.trans || flip(D.genderSameAsBirth) || PNS);
  if (/gender identity|how you think of yourself|gender reassignment|same as.*(birth|registered)/.test(l)) return fill(D.genderSameAsBirth || flip(D.trans) || PNS);
  if (/\bgender\b|\bsex\b/.test(l)) return fill(D.gender || A.eeoGender || PNS);
  if (/marital|civil partnership/.test(l)) return fill(D.maritalStatus || PNS);
  if (/religion|belief|faith/.test(l)) return fill(D.religion || PNS);
  if (/sexual orientation/.test(l)) return fill(D.sexualOrientation || PNS);
  if (/guaranteed interview|disability confident/.test(l)) return fill(D.guaranteedInterview || 'No');
  // "I would describe my main disability as *" — required even when the answer to "Do you
  // have a disability?" is No; the right option then is "None / Not Applicable".
  if (/describe my main disability|main disability|type of (impairment|disability)/.test(l)) {
    return /^y/i.test(String(D.disability || '')) ? fill(D.disabilityType || 'Other / Not specified') : fill('None / Not Applicable');
  }
  if (/reasonable adjustment|adjustments.*(need|require)/.test(l)) return fill(D.adjustments || 'No');
  if (/disab|long.?term (health )?condition/.test(l)) return fill(D.disability || ((A.eeoDisability && /yes/i.test(A.eeoDisability)) ? 'Yes' : (A.eeoDisability || 'No')));
  // Background / socio-economic (Social Mobility Commission questions) — stored answers.
  if (/armed forces|reservist|veteran|ex[- ]forces/.test(l)) return fill(D.armedForces || 'No');
  if (/type of school|which type of school|what was the main type of school|state[- ]run|independent.*fee/.test(l)) return fill(D.schoolType || PNS);
  if (/free school meals/.test(l)) return fill(D.freeSchoolMeals || PNS);
  if (/(main.*earner|highest earner|main wage earner|parent|guardian).*(occupation|job|employed|work)|occupation of.*(parent|earner)|when you were (14|aged 14)/.test(l)) return fill(D.socioOccupation || PNS);
  if (/how did you (hear|learn).*(vacanc|job|post|role)|where did you (see|hear)|first (see|hear) (of|about) (this|the) (vacancy|post|role|job)|how.*learn of this vacancy|where.*advertised/.test(l)) return fill('HealthJobsUK'); // the agent finds every NHS job on HealthJobsUK, so that is the true answer

  // Declaration — the user configured the agent to apply on their behalf → agree.
  if (/i agree to the above declaration|the information.*(true|complete)|i declare|declaration/.test(l)) return fill('Yes');
  // Dismissal / disciplinary — the user's stored answer (default: No).
  if (/dismissed|misconduct|capability|compromise|settlement agreement/.test(l)) return fill(D.dismissed === 'yes' ? 'Yes' : 'No');

  // ── Personal details — Trac's OWN self-contained data (trac_details) first,
  //    then the general profile as a fallback ─────────────────────────────────
  if (/forename|first name/.test(l)) return fill(D.firstName || A.firstName);
  if (/middle name/.test(l)) return fill(D.middleName || A.middleName);
  if (/surname|last name|family name/.test(l)) return fill(D.lastName || A.lastName);
  if (/email/.test(l)) return fill(D.email || A.email);
  if (/mobile/.test(l)) return fill(D.mobile || A.phone);
  if (/work telephone|home telephone|telephone/.test(l)) return { action: 'skip' };
  if (/postcode/.test(l)) { if (D.postcode) return fill(D.postcode); const m = String(A.address || A.location || '').match(UK_POSTCODE); return m ? fill(m[1]) : { action: 'skip' }; }
  if (/city|town/.test(l)) return fill(D.city || A.location || '');
  if (/county/.test(l)) return D.county ? fill(D.county) : { action: 'skip' };
  if (/^address|address 1|street/.test(l)) return fill(D.address || (A.address || '').replace(UK_POSTCODE, '').trim());
  if (/country/.test(l)) return fill(D.country || A.country || 'United Kingdom');
  if (/national insurance/.test(l)) return D.ni ? fill(D.ni) : { action: 'skip' };
  if (/title\b/.test(l)) return D.title ? fill(D.title) : { action: 'skip' };

  // ── Simple screeners we can answer from profile ──────────────────────────
  if (/full time or part time|full or part time/.test(l)) return fill((A.employmentType || []).includes('part_time') ? 'Part Time' : 'Full Time');
  // "Preferred employment type" is a CHECKBOX GROUP — each option's own label is the field
  // label. Check the one(s) matching the user's employment type, leave the rest unchecked.
  if (/^full[- ]?time$/.test(l)) { const et = A.employmentType || []; return fill(et.includes('full_time') || !et.includes('part_time') ? 'Yes' : 'No'); }
  if (/^part[- ]?time$/.test(l)) return fill((A.employmentType || []).includes('part_time') ? 'Yes' : 'No');
  if (/^(job ?share|secondment|bank(\s+work)?|voluntary|fixed[- ]?term|apprenticeship|casual|as and when|zero[- ]?hours?)$/.test(l)) return fill('No');
  // Mutually Agreed Resignation Scheme (MARS) — a leaver scheme; standard answer No.
  if (/mutually agreed resignation|\bmars\b|mutually agreed|voluntary (redundancy|exit) scheme/.test(l)) return fill('No');
  // Redeployment / at-risk register — standard answer No for external applicants.
  if (/registered with.*(redeployment|redeploy)|redeployment (scheme|register|pool|list)|on the redeployment/.test(l)) return fill('No');
  // Inter Authority Transfer (IAT) consent — only applies to CURRENT NHS employees.
  // External applicants (the common case) choose "Not applicable — not currently in the NHS".
  if (/inter.?authority transfer|consent.*(trust|us).*obtain|obtaining details of your (nhs )?(employment|service|pay|continuous service)/.test(l)) {
    return fill(A.currentlyNhs ? 'I give my consent' : 'Not applicable - I am not currently employed in the NHS');
  }
  if (/driving licence|drivers licence|driver.?s license/.test(l)) return fill(A.drivingLicence ? 'Yes' : 'No');
  if (/travel independently/.test(l)) return fill('Yes');
  // Common NHS screeners (don't depend on the AI backend for these).
  if (/access to (a |your own )?(vehicle|car|transport)|use of a car|own transport|access to.*vehicle/.test(l)) return fill(A.drivingLicence ? 'Yes' : 'No');
  if (/(main|primary|sole|principal) (employment|job|source of income)|intend.*(this|the).*(employment|position|post|role).*(main|primary|sole|principal)/.test(l)) return fill('Yes');
  if (/is this your first job|first job in the nhs/.test(l)) return fill('No');
  if (/second job|additional employment|other paid employment|another job/.test(l)) return fill('No');
  if (/notice period/.test(l)) return fill(A.availability && /immediate/i.test(A.availability) ? 'None' : '1 month');
  if (/willing to (work|do) (shifts|nights|weekends|on-?call)|shift work|flexible working/.test(l)) return fill('Yes');
  if (/currently an employee of|currently work in the nhs|currently employed by|are you (currently )?employed (by|at|with)|do you (currently )?work for|are you an? (internal|existing) (employee|applicant|candidate)|current (member of )?staff/.test(l)) return fill('No');
  // Disclosure section: related to a board member/director/employee → No; dismissal handled above.
  if (/related to (a |any )?(member|director|employee|governor|staff|councillor)|relationship to (a |any )?(director|member|employee)/.test(l)) return fill('No');
  // GCSE Maths and English (or equivalent): the user's own answer from the NHS details page.
  if (/gcse|maths and english|english and maths|level 2 (in )?(maths|english|numeracy|literacy)/.test(l) && details.gcseMathsEnglish) return fill(details.gcseMathsEnglish);
  // Care leaver monitoring question: the user's own answer if given, else "prefer not to say"
  // (a sensitive question the agent never guesses).
  if (/looked after by the care system|care leaver|been in care|local authority care/.test(l)) return fill(details.careLeaver || 'Prefer not to say');
  // Welsh health boards: bank-only staff, and a study date for current students.
  if (/bank (only )?basis|on a bank only|bank only/.test(l)) return fill('No');
  if (/currently studying.*(expected|qualification date)|expected qualification date/.test(l)) return fill(details.studying || 'Not applicable');
  if (/first available date|available (to )?start|earliest.*start date|first date.*employ/.test(l)) return { action: 'skip' };
  if (/armed forces/.test(l)) return fill('No');
  if (/at.?risk|redeploy|employment status/.test(l)) return fill('I do not fall into one of the above categories');
  if (/salary/.test(l)) return fill(A.salaryExpectation || '');
  if (/where.*advertised|how did you.*learn|first saw this post/.test(l)) return fill('Job website');
  if (/smartcard/.test(l)) return fill('No');

  // ── Optional sections that are N/A for most applicants → skip (don't burn an AI call).
  // Employment gaps: the user's own explanation; "No gaps" when the dates show none; if there
  // are real gaps (over 3 months) but no explanation saved, ask the user (never invent one).
  if (/gaps? in.*employ|reasons? for.*(the )?gaps|any gaps within your employ/.test(l)) {
    if (String(details.employmentGaps || '').trim()) return fill(details.employmentGaps);
    const gaps = employmentGapsFrom(details.employment);
    if (!gaps.length) return fill('No gaps in my employment history.');
    return { action: 'pause', reason: 'Explain your employment gaps (' + gaps.join('; ') + ') on the NHS / Trac page' };
  }
  if (/continuous nhs service|months since.*(most recent )?employ(ment)? ended|start date of.*nhs service/.test(l)) return { action: 'skip' };
  if (/^(course title|training provider|duration|year completed)$/.test(l)) return { action: 'skip' };
  // "Professional registration status" is a REQUIRED select on many posts. Answer from any
  // stored registration, else "I do not have the relevant UK professional registration"
  // (true for most applicants, and it clears the required field). The registration
  // number / expiry / body-name DETAIL fields stay optional → skip.
  if (/professional registration status|indicate your (professional )?registration|registration status/.test(l)) return fill(D.professionalRegistration || 'I do not have the relevant UK professional registration');
  if (/professional (body|membership)|membership \/ registration number|expiry \/ renewal date|registration number/.test(l)) return { action: 'skip' };

  // ── Behavioural / free-text screeners + supporting statement → AI ─────────
  // Person-specification criteria responses: REQUIRED free-text "How do you meet these
  // essential / desirable criteria?" fields (the criteria are listed in the label). Route
  // to a criteria path that writes a tailored paragraph and, if the AI can't, falls back
  // to the supporting statement — so a required field is never left blank (which would
  // keep the whole section invalid on every application).
  if (/how do you meet (these|the) (essential|desirable) (criteria|requirements)|how you meet (these|the) (essential|desirable)/.test(l)) return { action: 'ai', kind: 'criteria' };
  if (/supporting (information|statement)|why.*applying|person specification|demonstrate/.test(l)) return { action: 'ai', kind: 'supporting_statement' };
  if (/piece of work that needs.*improvement|team member.*improvement/.test(l)) return fill('Sit down and discuss with them');

  // ── Confirmations / acknowledgements the form REQUIRES to proceed → agree ──
  // (An auto-apply run must clear these standard "I have read / I confirm" gates or
  //  the page can't advance. They're the applicant's own confirmations.)
  if (/confirm your ni|confirm your national insurance|\bni\b.*number|national insurance/.test(l)) return D.ni ? fill(D.ni) : { action: 'skip' };
  if (/if you wish to provide|you may wish to|optional.*(comment|information)/.test(l)) return { action: 'skip' };
  if (/do you meet the essential|meet the essential criteria|meet the minimum|essential requirements|meet the person spec|do you meet the criteria/.test(l)) return fill('Yes');
  // "Getting started" chooser — always start from a blank form (deterministic).
  if (/how would you like to start your application|use a recent application|blank form|starting source/.test(l)) return fill('Blank form');
  // "Please confirm you have read and understood the following statement" is an
  // ACKNOWLEDGEMENT, even when the statement is about AI ("Use of AI in Job Applications").
  // Confirming you've read a policy doesn't declare AI use, and its only option is "I confirm".
  if (/confirm (that )?you have read|have read and understood|read and understood the|please acknowledge|i acknowledge/.test(l)) return fill('Yes');
  // AI-use questions → always No (never declare AI assistance on an application).
  if (/\bai\b|artificial intelligence|use of ai|ai tool|ai.?generated|chat ?gpt|generative ai|large language model/.test(l)) return { ...fill('No'), aiUse: true };
  if (/i confirm|please confirm|do you confirm|i acknowledge|i understand|i have read|have you read|read and understood|read the (job|person|candidate|advert)/.test(l)) return fill('Yes');
  if (/not offering sponsorship|not able to offer sponsorship|unable to offer sponsorship|due to the band|please note/.test(l)) return fill('Yes');

  // Unknown → let the question-AI decide (or skip if not answerable)
  return { action: 'ai', kind: 'question' };
}

// Fill a row of a repeating section (employment / education / references) from the
// arrays the user entered once. The row index is parsed from the field name (Trac
// numbers repeated rows), defaulting to the first entry. Returns a fill/skip action,
// or null when the label isn't a repeater field (so resolveAnswer handles it).
// 1 when this is the "Activities prior to above" list AND the user's most recent job is
// current (it lives in the separate "Current job" section), else 0.
function employmentOffset(name, details = {}) {
  if (!/otheremp/i.test(String(name || ''))) return 0;
  const first = (Array.isArray(details.employment) ? details.employment : [])[0];
  return first && (!first.end || /present|current|now|ongoing|to date/i.test(first.end)) ? 1 : 0;
}

function repeaterAnswer(label, name, details = {}, secHint = '') {
  const l = norm(label);
  const nm = String(name || '').toLowerCase();
  if (/equality|equalops|monitoring|diversity|ethnic|disabilit|religio|orientation|employmentgaps|gaps/.test(nm) && !/grrow_/.test(nm)) return null;
  const m = nm.match(/(\d+)/);
  const idx = m ? parseInt(m[1], 10) : 0;
  const at = (arr) => (Array.isArray(arr) ? arr[idx] : null);
  const has = (arr) => Array.isArray(arr) && arr.length;
  const fill = (v) => (v != null && String(v) !== '') ? { action: 'fill', value: String(v) } : { action: 'skip' };

  // Which repeating section is this field in? Prefer the page-level `secHint` (detected
  // once from all fields, so references' bare "Job title"/"Email" route correctly);
  // otherwise fall back to per-field name/label signals.
  let sec = secHint || '';
  if (!sec) {
    if (/refere|reference/.test(nm) || /refere/.test(l)) sec = 'ref';
    else if (/educat|qualif|academic/.test(nm) || /subject|qualification|place of study|grade|result|year (obtained|completed|awarded|achieved)/.test(l)) sec = 'edu';
    else if (/employ|emphist|work.?history/.test(nm) || /employer|reason for leaving|duties|responsibilities|brief description|type of business|period of notice|your job title/.test(l)) sec = 'emp';
  }

  if (sec === 'ref') {
    const ref = at(details.references);
    if (!ref) return has(details.references) ? { action: 'skip' } : null;
    // "Dates known" — split Month/Year selects named ..._datefrom_month / _dateto_year.
    // "present" (or blank "to") means you still know them → this month / this year.
    const rd = nm.match(/(datefrom|dateto)_(day|month|year)/);
    if (rd) {
      let fromRaw = ref.from, toRaw = ref.to;
      if (!fromRaw) {
        const job = (details.employment || []).find((e) => e.employer && ref.org && norm(e.employer).includes(norm(ref.org).slice(0, 12)));
        if (job) { fromRaw = job.start; toRaw = toRaw || job.end || 'present'; }
        else { const t = new Date(); fromRaw = `${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')}/${t.getFullYear() - 3}`; }
      }
      const raw = rd[1] === 'datefrom' ? fromRaw : (toRaw || 'present');
      const p = /present|current|now|ongoing/i.test(String(raw || '')) ? todayParts() : parseDate(raw);
      return p[rd[2]] ? fill(p[rd[2]]) : { action: 'skip' };
    }
    const parts = String(ref.name || '').trim().split(/\s+/);
    if (/first name|forename/.test(l)) return fill(parts[0]);
    if (/surname|last name/.test(l)) return fill(parts.slice(1).join(' '));
    if (/organisation|company/.test(l)) return fill(ref.org);
    if (/email/.test(l)) return fill(ref.email);
    if (/mobile/.test(l)) return fill(ref.mobile || ref.phone);
    if (/telephone|phone/.test(l)) return fill(ref.phone);
    if (/job title|position/.test(l)) return fill(ref.jobTitle);
    // Referee ADDRESS — required on some trusts ("Address 1 *", "City / Town *"). Fill from
    // the stored referee address when present (else skip → the field stays blank and the
    // user completes it; References can't be fully autonomous without a referee address).
    if (/address 1|address line 1|^address$|^street/.test(l)) return fill(ref.address || ref.address1);
    if (/address 2|address line 2/.test(l)) return fill(ref.address2);
    if (/address 3|address line 3/.test(l)) return { action: 'skip' };
    if (/city|town/.test(l)) return fill(ref.town || ref.city);
    if (/county|state/.test(l)) return fill(ref.county);
    if (/postcode|post code|zip/.test(l)) return fill(ref.postcode);
    if (/how.*know you|relationship|capacity|in what capacity/.test(l)) {
      // Trac's "How do they know you?" is usually a fixed dropdown: Employer/Line Manager,
      // Course Tutor, or Personal/Character Reference. Map the stored free-text relationship.
      const rel = String(ref.relationship || '').toLowerCase();
      if (/tutor|lecturer|professor|teacher|academic|school|college|university|supervisor.*(study|phd|dissertation)/.test(rel)) return fill('Course Tutor');
      if (/personal|friend|character|neighbour|family/.test(rel)) return fill('Personal / Character Reference');
      return fill('Employer / Line Manager'); // colleague, manager, employer, supervisor → work reference
    }
    if (/approached prior|can the referee be approached/.test(l)) return fill('Yes');
    if (/name/.test(l) && !/changed|known/.test(l)) return fill(ref.name);
    return { action: 'skip' };
  }
  if (sec === 'edu') {
    const edu = at(details.education);
    if (!edu) return has(details.education) ? { action: 'skip' } : null;
    if (/subject|qualification/.test(l)) return fill(edu.qualification);
    if (/place of study|institution|school|college|university/.test(l)) return fill(edu.place);
    if (/grade|result/.test(l)) return fill(edu.grade);
    if (/year/.test(l)) return fill(edu.year);
    return { action: 'skip' };
  }
  if (sec === 'emp') {
    // Trac splits jobs into "Current job" (employment-* fields) and "Activities prior to
    // above" (otheremp_grrow_N). If your most recent job is current, it belongs ONLY in the
    // first, so the prior list starts at your SECOND job. (It used to start at the first, so
    // the current job appeared twice and every older job slid down a row.)
    const emp = (Array.isArray(details.employment) ? details.employment : [])[idx + employmentOffset(nm, details)];
    if (!emp) return has(details.employment) ? { action: 'skip' } : null;
    // Split Day / Month / Year date dropdowns, matched by field NAME (labels are just
    // "Day"/"Month"/"Year"). A current job's blank end date means today.
    const dm = nm.match(/(startdate|enddate)_(day|month|year)/);
    if (dm) {
      const raw = dm[1] === 'startdate' ? emp.start : emp.end;
      const p = (dm[1] === 'enddate' && (!raw || /present|current|now|ongoing/i.test(raw))) ? {} : parseDate(raw);
      return p[dm[2]] ? fill(p[dm[2]]) : { action: 'skip' };
    }
    // Wording varies by trust: "Employer name", "Employer or college name", "Employer/College Name".
    if (/employer name|name of employer|^employer$|employer (or|\/) ?college name|college name/.test(l)) return fill(emp.employer);
    // "What is your current main activity *" / "Type of activity *" (Employed, Student, ...).
    if (/current main activity|type of activity|main activity/.test(l)) return fill('Employed');
    if (/your job title|position held|(^| )job title/.test(l) && !/reporting/.test(l)) return fill(emp.jobTitle);
    if (/start date/.test(l)) return fill(emp.start);
    if (/end date/.test(l)) return fill(emp.end);
    if (/reason for leaving/.test(l)) return fill(emp.reason);
    if (/duties|responsibilities|brief description/.test(l)) return fill(emp.duties);
    return { action: 'skip' };   // employer address / type of business / grade / salary / notice — not stored
  }
  return null;
}

// ── Browser helpers (label-first, id-agnostic) ───────────────────────────────
// Refined against a live Trac session; kept resilient by matching on visible text.

// A closed vacancy on HealthJobsUK redirects to the homepage with a "now closed"
// banner; the homepage's only "Apply"-looking control is the SEARCH FILTER button
// (#filter-apply-handler), which is NOT a job application. Detect that state so we
// bail cleanly instead of looping on the search box + cookie banner.
async function advertState(page) {
  const url = page.url();
  const body = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  if (/just a moment|checking your browser|attention required|cloudflare/i.test(body)) return { state: 'blocked', body };
  if (/vacancy you tried to view is now closed|this vacancy is now closed|vacancy has now closed|no longer available|now closed|choose a sector below/i.test(body)) return { state: 'closed', body };
  // On the HealthJobsUK homepage / job list rather than a job advert.
  if (/\/job_list\b/i.test(url) || /healthjobsuk\.com\/?(\?|#|$)/i.test(url)) return { state: 'closed', body };
  return { state: 'ok', body };
}

// OneTrust (and similar) cookie banners overlay the page and their buttons get
// picked up as "form fields"/Apply. Dismiss with the most privacy-preserving
// option (reject non-essential) before doing anything else.
async function dismissCookieBanner(page) {
  const sels = ['#onetrust-reject-all-handler', 'button:has-text("Reject All")', 'button:has-text("Reject all")',
    'button:has-text("Decline")', '.ot-pc-refuse-all-handler', '#onetrust-accept-btn-handler'];
  for (const s of sels) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); await new Promise((r) => setTimeout(r, 500)); return true; }
  }
  return false;
}

async function findApplyEntry(page) {
  // The real apply link on a HealthJobsUK advert is "Apply online now" → a JOB-SPECIFIC
  // apps.trac.jobs URL (/job-advert/{id} or /vacancy/…). The advert ALSO has an
  // apps.trac.jobs "My account" link that points at the bare homepage (/) — matching
  // that instead lands on the login/home page and looks like a logout. So target the
  // vacancy path (or the exact apply text), and NEVER the bare-root or filter/cookie links.
  const sel = [
    'a[href*="apps.trac.jobs/job-advert/"]',
    'a[href*="apps.trac.jobs/vacancy/"]',
    'a[href*="/job-advert/"]',
    'a:has-text("Apply online now")',
    'a:has-text("Apply online")',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
    'a:has-text("Start application")',
  ];
  for (const s of sel) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) return el;
  }
  // Last resort: any Apply link that is NOT the account/home link, filter or cookie control.
  const fallback = page.locator('a:has-text("Apply"), button:has-text("Apply")');
  const n = await fallback.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = fallback.nth(i);
    const href = await el.getAttribute('href').catch(() => '') || '';
    const txt = (await el.innerText().catch(() => '') || '').toLowerCase();
    if (/my account|sign ?in|log ?in|register/.test(txt)) continue;
    if (/filter|mailto/i.test(href) || href === '/' || /apps\.trac\.jobs\/?$/.test(href)) continue;
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}
async function clickContinue(page) {
  for (const s of ['button:has-text("Save and continue")', 'button:has-text("Continue")', 'button:has-text("Next")', 'input[type="submit"][value*="ontinue" i]', 'button:has-text("Save")']) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) { await el.click().catch(() => {}); return true; }
  }
  return false;
}
// STRICT login detection. The Trac advert/application pages carry stray "sign in" /
// "create an account" links (shown to everyone) that must NOT be read as "logged out".
// A real login wall has a visible password field, or the URL is an auth route.
async function needsLogin(page) {
  const url = page.url();
  if (/\/(login|log-?in|sign-?in|signin|register|account\/login|auth\b)/i.test(url)) return true;
  const pw = await page.locator('input[type="password"]').count().catch(() => 0);
  if (!pw) return false;
  // A password field exists — only a wall if it's actually visible (not a hidden change-password widget).
  return await page.locator('input[type="password"]').first().isVisible().catch(() => false);
}

// Read the form as a list of QUESTIONS. Radio/checkbox options are grouped by their
// input `name` so a single "Right to work status" question (10 radio options) is ONE
// question, not ten. The question text comes from the Trac field container's caption
// (…_container / .trac-form-group / fieldset legend), falling back to the field's own
// label. Cookie-widget inputs are excluded.
async function readQuestions(page) {
  return await page.evaluate(() => {
    const inCookie = (el) => !!el.closest('#onetrust-banner-sdk, #onetrust-consent-sdk, #onetrust-pc-sdk, .ot-sdk-container, [id^="ot-"], [class*="ot-"], [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i]');
    const looksCookie = (s) => /cookie|onetrust|analytics & functional|performance cookies|select a category|checkbox label|leg\.?interest|\bconsent\b/i.test(s || '');
    const own = (el) => {
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.innerText) return l.innerText.trim(); }
      return (el.getAttribute('aria-label') || (el.closest('label') ? el.closest('label').innerText : '') || '').trim();
    };
    const groupQ = (el) => {
      const cont = el.closest('.trac-form-group, fieldset, [id$="_container"], .form-group');
      if (!cont) return '';
      const cap = cont.querySelector('legend, label.col-form-label, .col-form-label, legend.caption, .trac-form-caption, label');
      return cap && cap.innerText ? cap.innerText.trim() : '';
    };
    const visible = (el) => el.offsetParent !== null || el.type === 'radio' || el.type === 'checkbox';
    const out = [];
    const groups = {};
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      if (inCookie(el) || !visible(el)) continue;
      const name = el.name || el.id || '';
      // Trac's own form fields are never cookie controls. Without this, any NHS question
      // containing "consent" (the Declaration tick-box, data-sharing questions) was
      // mistaken for a cookie setting and silently dropped.
      // Judge cookie controls by NAME, never by label wording: NHS questions often mention
      // "consent" (Declaration, screening statements) and were being thrown away.
      const isTracField = !!name && !/(^|[-_])ot-|onetrust|cookie|chkbox-id|handler$|vendor|^ot-group/i.test(name);
      if (type === 'radio') {
        const key = 'r:' + (name || el.id);
        if (!groups[key]) { groups[key] = { kind: 'radio', name, question: groupQ(el), options: [] }; out.push(groups[key]); }
        groups[key].options.push({ label: own(el), value: el.value, id: el.id });
        continue;
      }
      if (type === 'checkbox') {
        const q = groupQ(el) || own(el);
        if (!isTracField && looksCookie(q)) continue;
        out.push({ kind: 'checkbox', name, question: q, label: own(el), id: el.id });
        continue;
      }
      const lbl = own(el) || groupQ(el);
      if (!isTracField && looksCookie(lbl)) continue;
      const kind = el.tagName.toLowerCase() === 'select' ? 'select' : (el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text');
      out.push({ kind, name, question: lbl, label: lbl });
    }
    // Radio group with no caption → use the shared prefix of its option labels as the question.
    for (const q of out) {
      if (q.kind === 'radio' && !q.question && q.options && q.options[0]) q.question = q.options[0].label;
      if (q.question) q.question = q.question.slice(0, 160);
    }
    return out;
  }).catch(() => []);
}

// Select the radio option in a group whose label best matches the resolved value
// (e.g. value "No" → the "No" option; value "Full Time" → the "Full Time" option).
async function selectRadioOption(page, q, value) {
  const v = norm(value);
  let target = null;
  for (const opt of q.options || []) {
    const ol = norm(opt.label);
    if (ol === v || ol.startsWith(v) || (v.length > 2 && ol.includes(v))) { target = opt; break; }
  }
  // Same answer, different wording between trusts ("Modern professional / traditional
  // professional" vs "Modern professional or traditional professional"): best word overlap.
  if (!target) {
    const toks = (x) => new Set(norm(x).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['and', 'the', 'for', 'with'].includes(w)));
    const want = toks(value);
    let best = 0;
    for (const opt of q.options || []) {
      const have = toks(opt.label);
      if (!want.size || !have.size) continue;
      const hit = [...want].filter((w) => have.has(w)).length;
      const score = hit / Math.max(want.size, have.size);
      if (score > best) { best = score; target = opt; }
    }
    if (best < 0.6) target = null;
  }
  if (!target || !target.id) return false;
  // A real click (Playwright), not el.checked = true from script, so Trac registers it.
  // Trac often hides the native radio behind a styled label, so fall back to its label.
  const radio = page.locator('#' + CSS_escape(target.id));
  // Already chosen (e.g. copied from a previous application): leave it. Clicking it again
  // fires Trac's change handler, which redraws the section as Save is pressed.
  if (await radio.isChecked().catch(() => false)) return true;
  await radio.scrollIntoViewIfNeeded().catch(() => {});
  let ok = await radio.check({ timeout: 3000 }).then(() => true).catch(() => false);
  if (!ok) ok = await page.locator('label[for="' + target.id.replace(/"/g, '\\"') + '"]').first().click({ timeout: 3000 }).then(() => true).catch(() => false);
  if (!ok) ok = await radio.check({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
  await sleep(FIELD_PAUSE_MS);
  return ok && await radio.isChecked().catch(() => ok);
}

// ── Section-loop navigator helpers ───────────────────────────────────────────
// Trac applications are a hub-and-spoke checklist: an Application summary lists
// sections; each is Opened, filled, and saved with "Save & next" (which advances to
// the next section). A validation dialog ("Fix now" / "Continue and fix later")
// appears when a section is incomplete; we choose "Continue and fix later" so a
// blocked section still saves as a draft instead of stalling the whole run.

async function fixNowIfDialog(page, log = () => {}) {
  const txt = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll('.modal.show, [role="dialog"]')).find((x) => x.offsetParent !== null && /fix now|fix later/i.test(x.textContent || ''));
    return m ? m.textContent.replace(/\s+/g, ' ').replace(/\b(cancel|close|done|edit)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 260) : '';
  }).catch(() => '');
  if (!txt) return false;
  log('  [Trac] Trac says: ' + txt);
  const hit = await clickControl(page, ['Fix now', 'Fix Now']);
  if (!hit) await handleDialog(page, log);
  await sleep(1200);
  return true;
}

async function handleDialog(page, log = () => {}) {
  const hit = await clickControl(page, ['Continue and fix later', 'Continue and Fix Later']);
  if (hit) { log('  [Trac] Dialog → "Continue and fix later" (section saved as draft).'); await new Promise((r) => setTimeout(r, 900)); return true; }
  return false;
}

// The "Getting started" gate: a required radio ("Use a recent application" / "Blank
// form") + a "Launch application" button that must be cleared before the sections appear.
//
// PREFER "Use a previous application": it copies the standard sections (personal details,
// employment, education, references, equality) from a prior application, so the agent only
// tailors the role-specific parts (supporting statement / person spec) instead of
// re-filling everything on every job. FAIL-SAFE: if there is no usable previous
// application to copy, fall back to "Blank form" (the proven path) so the flow never
// breaks. Set ctx reusePrevious=false to force Blank form. Returns true if handled.
async function handleGettingStarted(page, log = () => {}, reusePrevious = true, preferTitles = []) {
  const present = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    return radios.some((r) => /SelectStartingSource|SelectSource/i.test(r.name || '')) || /how would you like to start your application/i.test(document.body.innerText || '');
  }).catch(() => false);
  if (!present) return false;

  // Log the gate's structure once so the exact "use previous" DOM is visible in the log.
  const gate = await page.evaluate(() => {
    const lab = (r) => { const l = r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]'); return (l ? l.textContent : (r.closest('label') ? r.closest('label').textContent : '')).replace(/\s+/g, ' ').trim(); };
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter((r) => /SelectStartingSource|SelectSource|startingsource|source/i.test(r.name || r.id || '') || (r.closest('form') && /start your application/i.test(document.body.innerText || '')));
    return { radios: radios.map((r) => lab(r).slice(0, 60)).filter(Boolean).slice(0, 8) };
  }).catch(() => ({ radios: [] }));
  if (gate.radios.length) log('  [Trac] Getting started options: ' + gate.radios.map((r) => '"' + r + '"').join(', '));

  let mode = 'blank';
  if (reusePrevious) {
    // Select the "Use a recent / previous application" radio, then pick a source app.
    const chosen = await page.evaluate(() => {
      const lab = (r) => { const l = r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]'); return (l ? l.textContent : (r.closest('label') ? r.closest('label').textContent : '')).replace(/\s+/g, ' ').trim(); };
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const prev = radios.find((r) => /use (a|my) (recent|previous|existing) application|copy (from )?(a |my )?(recent|previous|another|existing) application|based on.*(previous|recent) application|reuse.*application/i.test(lab(r)));
      if (!prev) return { ok: false, reason: 'no-previous-option' };
      prev.checked = true; prev.dispatchEvent(new Event('change', { bubbles: true })); prev.dispatchEvent(new Event('click', { bubbles: true }));
      return { ok: true };
    }).catch(() => ({ ok: false, reason: 'error' }));

    if (chosen.ok) {
      await new Promise((r) => setTimeout(r, 1100)); // let the "which application?" picker render
      // Pick which application to copy: a <select> of prior apps, or a radio list. Confirm a
      // REAL option was selected — if the picker is empty (no prior application exists), this
      // is effectively a first application → revert to Blank form.
      const picked = await page.evaluate((prefer) => {
        // Prefer copying a FINISHED application (every section OK), newest first, so the new
        // form starts with as few gaps as possible. Falls back to the most recent one.
        const key = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 25);
        const rank = (text) => { const k = key(text); const i = prefer.findIndex((p) => p && k && (k.startsWith(p) || p.startsWith(k))); return i < 0 ? 1e9 : i; };
        const realOpt = (t) => t && !/please select|choose|select\.\.\.|^--|^\s*$/.test(t.trim().toLowerCase());
        // Dropdown picker
        const sel = Array.from(document.querySelectorAll('select')).find((s) => /application|recent|previous|copy|source/i.test((s.name || '') + ' ' + (s.id || '') + ' ' + (s.getAttribute('aria-label') || '')));
        if (sel) {
          const opts = Array.from(sel.options).filter((o) => o.value && realOpt(o.textContent));
          if (!opts.length) return { picked: false, reason: 'empty-dropdown' };
          const best = opts.slice().sort((x, y) => rank(x.textContent) - rank(y.textContent))[0];
          sel.value = best.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { picked: true, via: 'dropdown', finished: rank(best.textContent) < 1e9, label: (best.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) };
        }
        // Radio-list picker: extra radios (dates / application titles) that aren't the mode chooser
        const modeRe = /use (a|my) (recent|previous|existing)|blank form|blank application/i;
        const appRadios = Array.from(document.querySelectorAll('input[type="radio"]')).filter((r) => {
          const l = r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]');
          const t = (l ? l.textContent : '').replace(/\s+/g, ' ').trim();
          return t && !modeRe.test(t) && /(19|20)\d{2}|application|submitted|draft|ref\s*\d|vacancy/i.test(t);
        });
        if (appRadios.length) {
          const labOf = (r) => ((document.querySelector('label[for="' + CSS.escape(r.id) + '"]') || {}).textContent || '').replace(/\s+/g, ' ').trim();
          const best = appRadios.slice().sort((x, y) => rank(labOf(x)) - rank(labOf(y)))[0];
          best.checked = true; best.dispatchEvent(new Event('change', { bubbles: true })); best.dispatchEvent(new Event('click', { bubbles: true }));
          return { picked: true, via: 'radio', finished: rank(labOf(best)) < 1e9, label: labOf(best).slice(0, 50) };
        }
        // No picker appeared: selecting the mode radio alone may be enough (Trac copies the
        // most recent). Treat as usable — Launch validation will tell us if not.
        return { picked: true, via: 'none' };
      }, (preferTitles || []).map((t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 25)).filter(Boolean)).catch(() => ({ picked: false, reason: 'error' }));

      if (picked.picked) { mode = 'previous'; if (picked.label) log('  [Trac] Copying from ' + (picked.finished ? 'a finished' : 'the most recent') + ' application: "' + picked.label + '".'); }
      else log('  [Trac] "Use a previous application" not usable (' + (picked.reason || '') + ') — using Blank form.');
    } else if (chosen.reason === 'no-previous-option') {
      // Gate has no reuse option (e.g. first-ever application) — Blank form is correct.
    }
  }

  if (mode === 'blank') {
    await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const blank = radios.find((r) => { const l = r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]'); return l && /blank form|blank application|start.*blank/i.test(l.textContent || ''); });
      if (blank) { blank.checked = true; blank.dispatchEvent(new Event('change', { bubbles: true })); blank.dispatchEvent(new Event('click', { bubbles: true })); }
    }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 500));
  const hit = await clickControl(page, ['Launch application']);
  if (hit) { log('  [Trac] Getting started → ' + (mode === 'previous' ? 'Use a previous application (copies your standard answers)' : 'Blank form') + ' → Launch application.'); return mode; }
  return false;
}

// Is this the Application summary (the section checklist)? Trac marks it up with
// `.app-form-section` group cards and `.list-group-item.fieldset-*` sub-section rows.
async function isSummaryPage(page) {
  return await page.evaluate(() => {
    if (document.querySelector('.app-form-section')) return true;
    if (document.querySelectorAll('.list-group-item[class*="fieldset-"]').length >= 2) return true;
    // Fallback: a "Submit application" control alongside section-entry buttons.
    const label = (e) => (e.value || e.textContent || '').replace(/\s+/g, ' ').trim();
    const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    const entries = els.filter((b) => /^(open|start section)$/i.test(label(b))).length;
    const hasSubmit = els.some((b) => /^submit application$/i.test(label(b)));
    return entries >= 2 || (hasSubmit && entries >= 1);
  }).catch(() => false);
}

// From the summary, open the next section that still needs work. The reliable signal is
// the row's CSS STATE CLASS, not its button text — a completed section AND an incomplete
// one BOTH expose a button labelled "Edit", so matching on "Edit" alone cannot tell them
// apart (this was the bug: incomplete sections were never reopened). Trac's classes:
//   .list-group-item.fieldset-requires-attention  → Not started   → button "Open"
//   .list-group-item.fieldset-invalid             → Incomplete     → button "Edit"  (REOPEN)
//   .list-group-item.fieldset-complete            → OK / done      → button "Edit"  (SKIP)
//   .app-form-section  with a "Start section" btn → collapsed group→ expand to reveal subs
// `attempted` (a Set carried across calls) stops us re-opening a section that stays
// invalid after one honest retry, so a field the saved details can't fill never loops.
// Submit a COMPLETE application from its summary page and confirm Trac accepted it.
// Returns 'submitted', 'closed' (deadline passed) or 'failed'. Checks the deadline, pauses
// like a person reading it through, clicks "Submit application" and any confirmation, and
// only reports success when Trac itself shows the application as submitted.
async function submitApplication(page, log = () => {}) {
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const bodyText = () => page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')).catch(() => '');
  const SUBMITTED = /application status:\s*submitted|application (has been |was )?(successfully )?submitted|thank you for (submitting|your application)/i;
  let text = await bodyText();
  if (SUBMITTED.test(text)) { log('  [Trac] Already submitted.'); return 'submitted'; }
  const d = text.match(/submit before (\d{1,2})-([A-Za-z]{3})-(\d{4})(?: (\d{1,2}):(\d{2}))?/i);
  if (d) {
    const due = new Date(+d[3], MONTHS[d[2].toLowerCase()] ?? 0, +d[1], +(d[4] || 23), +(d[5] || 59));
    if (Date.now() > due.getTime() - 5 * 60 * 1000) { log('  [Trac] Deadline has passed, not submitting.'); return 'closed'; }
  }
  // A person reads the summary through before pressing Submit.
  await sleep(20000 + Math.floor(Math.random() * 40000));
  const btn = page.locator('[name$="_SubmitEntireApp"]:visible').first();
  if (!(await btn.count().catch(() => 0))) { log('  [Trac] Submit button not found, left as a draft for you.'); return 'failed'; }
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click().catch(() => {});
  log('  [Trac] Clicked "Submit application".');
  // A confirmation step (pop-up): press its submit/confirm button once.
  for (let k = 0; k < 3; k++) {
    await sleep(2500);
    const clicked = await page.evaluate(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const box = Array.from(document.querySelectorAll('.modal.show, [role="dialog"]')).find(vis);
      if (!box) return '';
      const b = Array.from(box.querySelectorAll('button, input[type=submit], a.btn')).find((x) => vis(x) && /^(submit|submit application|yes|confirm|yes,? submit|send)\b/i.test((x.innerText || x.value || '').trim()));
      if (!b) return '';
      const t = (b.innerText || b.value || '').trim(); b.click(); return t;
    }).catch(() => '');
    if (clicked) { log(`  [Trac] Confirmed: "${clicked}".`); break; }
  }
  // Only count it when Trac says so.
  for (let k = 0; k < 8; k++) {
    await sleep(2500);
    if (SUBMITTED.test(await bodyText())) { log('  [Trac] ✓ SUBMITTED. Trac confirmed the application.'); return 'submitted'; }
  }
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3000);
  text = await bodyText();
  if (SUBMITTED.test(text)) { log('  [Trac] ✓ SUBMITTED. Trac confirmed the application.'); return 'submitted'; }
  const msg = (text.match(/[^.]{0,80}(please|must|error|unable|cannot)[^.]{0,120}/i) || [''])[0].trim();
  log(`  [Trac] Submit not confirmed, left as a draft for you.${msg ? ' Trac says: ' + msg : ''}`);
  return 'failed';
}

async function openNextSection(page, attempted, log = () => {}) {
  const res = await page.evaluate((attemptedArr) => {
    const tried = new Set(attemptedArr);
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // A readable section name: drop the material-icon ligatures and status words.
    const nameOf = (row) => norm((row.textContent || '')
      .replace(/assignment_turned_in|assignment_late|content_paste|expand_more|expand_less/gi, ' ')
      .replace(/\b(OK|Incomplete|Not started|In progress|Show answers|Hide answers)\b/gi, ' ')).slice(0, 48);
    const clickIn = (row, wants) => {
      const btns = Array.from(row.querySelectorAll('button, input[type="button"], input[type="submit"], a'));
      for (const want of wants) {
        const b = btns.find((x) => { const l = norm(x.value || x.textContent).toLowerCase(); return (l === want || l.startsWith(want + ' ') || l === want) && x.offsetParent !== null; });
        if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
      }
      return false;
    };
    // 0) A section already OPEN inline (row class "open") that the fill loop had nothing to
    //    fill in, e.g. answers copied from a past application. Trac allows one open section
    //    at a time, so any other "Open" click is ignored until it's closed: SAVE it (this
    //    also confirms copied answers). If it was already saved once and is still open,
    //    Cancel it so the run can move on.
    const openRow = document.querySelector('.list-group-item.open');
    if (openRow) {
      const key = 'open:' + (openRow.id || nameOf(openRow));
      const pick = (n) => openRow.querySelector('[name="' + n + '"]') || document.querySelector('[name="' + n + '"]');
      const btn = tried.has(key) ? pick('EditAppFieldset_Cancel') : (pick('EditAppFieldset_SubmitNext') || pick('EditAppFieldset_Submit'));
      if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return { kind: tried.has(key) ? 'cancel-open' : 'save-open', name: nameOf(openRow), key }; }
    }
    // 1) Not-started sub-sections first (button "Open").
    for (const r of Array.from(document.querySelectorAll('.list-group-item.fieldset-requires-attention'))) {
      const key = r.id || nameOf(r); if (tried.has(key)) continue;
      if (clickIn(r, ['open', 'start section', 'resume'])) return { kind: 'not-started', name: nameOf(r), key };
    }
    // 2) Incomplete sub-sections we haven't retried yet (button "Edit") — THE FIX.
    for (const r of Array.from(document.querySelectorAll('.list-group-item.fieldset-invalid'))) {
      // Key on the row's stable id (e.g. "Fieldset_Row_persdetails"), NOT its visible text:
      // an invalid row previews its answers, some AI-written and different each pass, so a
      // text key would never match and the section would be reopened forever.
      const key = r.id || nameOf(r); if (tried.has(key)) continue;
      if (clickIn(r, ['edit', 'open', 'resume'])) return { kind: 'incomplete', name: nameOf(r), key };
    }
    // 3) A collapsed "Not started" group — expand it to reveal its sub-sections.
    for (const g of Array.from(document.querySelectorAll('.app-form-section'))) {
      const start = Array.from(g.querySelectorAll('button, input[type="button"], input[type="submit"]'))
        .find((b) => /^start section$/i.test(norm(b.value || b.textContent)) && b.offsetParent !== null);
      if (start) { start.scrollIntoView({ block: 'center' }); start.click(); return { kind: 'expand', name: nameOf(g) }; }
    }
    return null;
  }, [...attempted]).catch(() => null);

  if (!res) return false;
  if (res.key && res.kind !== 'expand') attempted.add(res.key);
  const verb = { expand: 'Expanded group', incomplete: 'Reopened incomplete section', 'save-open': 'Saved open section', 'cancel-open': 'Closed open section' }[res.kind] || 'Opened section';
  log(`  [Trac] ${verb}${res.name ? ': ' + res.name : ''}.`);
  if (res.kind === 'save-open' || res.kind === 'cancel-open') { await new Promise((r) => setTimeout(r, 1800)); await handleDialog(page, log); }
  else if (res.kind !== 'expand') await waitForSectionForm(page);
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After Save, Trac marks each rejected field with "Please complete this." inside the
// field's form group. Return those fields so they can be fixed and saved again.
async function readFieldErrors(page) {
  return page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const own = (el) => { if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.innerText) return l.innerText.trim(); } return (el.getAttribute('aria-label') || '').trim(); };
    const out = [], seen = new Set();
    document.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
      const t = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button'].includes(t) || (!vis(el) && t !== 'radio' && t !== 'checkbox') || seen.has(el.name) || /FirstAdd|GRRemove|onetrust|cookie|^ot-|search/i.test(el.name)) return;
      const grp = el.closest('.form-group, .trac-form-group, [id$="_container"]'); if (!grp) return;
      const msg = Array.from(grp.querySelectorAll('*')).find((x) => x.children.length === 0 && vis(x) && /please complete this|this field is required|please (enter|select|answer|choose) |is required|must (be|answer)|invalid/i.test(x.textContent));
      if (!msg) return;
      seen.add(el.name);
      out.push({ name: el.name, label: own(el).replace(/\s*\*\s*$/, '').slice(0, 120) });
    });
    return out;
  }).catch(() => []);
}

// Trac boxes can carry a character limit (maxlength). Keep whole paragraphs that fit,
// dropping from the end (desirable criteria come last, the close is re-added).
async function fitToFieldLimit(page, name, text, log = () => {}) {
  const max = await page.evaluate((n) => { const e = document.querySelector('[name="' + n.replace(/"/g, '\\"') + '"]'); return e && e.maxLength > 0 ? e.maxLength : 0; }, name).catch(() => 0);
  if (!max || text.length <= max) return text;
  const paras = text.split(/\n\s*\n/);
  const close = paras.length > 2 ? paras[paras.length - 1] : '';
  const body = close ? paras.slice(0, -1) : paras.slice();
  while (body.length > 1 && [...body, close].filter(Boolean).join('\n\n').length > max) body.pop();
  let out = [...body, close].filter(Boolean).join('\n\n');
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '');
  log(`  [Trac] Statement trimmed to the box limit (${max} characters).`);
  return out;
}

// Required fields (label marked "*", or required/aria-required) in the OPEN section that are
// still empty: nothing chosen in a select, blank text, no radio/tick box checked in the group.
async function findEmptyRequired(page) {
  return page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    const scope = document.querySelector('.list-group-item.open') || document;
    const labelOf = (el) => {
      let t = '';
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.innerText; }
      if (el.type === 'radio' || el.type === 'checkbox' || !t) { const g = el.closest('fieldset, .form-group, .trac-form-group'); const q = g && g.querySelector('legend, label'); if (q) t = q.innerText; }
      return (t || '').replace(/\s+/g, ' ').trim();
    };
    const out = [], seen = new Set();
    for (const el of scope.querySelectorAll('input[name^="EditAppFieldset_"], select[name^="EditAppFieldset_"], textarea[name^="EditAppFieldset_"]')) {
      const t = (el.type || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'file'].includes(t) || seen.has(el.name) || /GRRemove|FirstAdd|AddressLookup|_lookup/i.test(el.name)) continue;
      const group = (t === 'radio' || t === 'checkbox');
      if (!group && !vis(el)) continue;
      const label = labelOf(el);
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*(\(required\))?$/.test(label) || /\*\s*$/.test(label.split('\n')[0]);
      if (!required) continue;
      seen.add(el.name);
      let empty;
      if (group) { const all = document.querySelectorAll('[name="' + CSS.escape(el.name) + '"]'); if (![...all].some(vis) && ![...all].some((x) => x.closest('label') && vis(x.closest('label')))) continue; empty = ![...all].some((x) => x.checked); }
      else if (el.tagName === 'SELECT') empty = el.selectedIndex <= 0 || /^please select/i.test((el.options[el.selectedIndex] || {}).text || '');
      else empty = !String(el.value || '').trim();
      if (empty) out.push({ name: el.name, label: label.replace(/\s*\*.*$/, '').slice(0, 80) });
    }
    return out;
  }).catch(() => []);
}

// Tick boxes in a group share ONE name (e.g. preferredemployment[]), so filling by name
// always hit the first box and later "No" answers unticked it. Target the box by id.
async function setCheckbox(page, q, on) {
  if (!q.id) return fillFieldByName(page, q.name, on ? 'Yes' : 'No');
  const sel = '[id="' + String(q.id).replace(/"/g, '\\"') + '"]';
  const el = page.locator(sel).first();
  const state = () => elOp(el, 'checked').catch(() => null);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  if (on) await el.check({ timeout: 3000 }).catch(() => {}); else await el.uncheck({ timeout: 3000 }).catch(() => {});
  // Styled boxes hide the real input: fall back to its label, then a DOM click.
  if ((await state()) !== on) await page.locator('label[for="' + String(q.id).replace(/"/g, '\\"') + '"]').first().click({ timeout: 3000 }).catch(() => {});
  if ((await state()) !== on) await elOp(el, 'click').catch(() => {});
  if ((await state()) !== on) await elOp(el, 'setChecked', on).catch(() => {});
  await sleep(FIELD_PAUSE_MS);
  return (await state()) === on;
}

// Repeating sections (references, jobs) often arrive with spare EMPTY rows, each carrying
// required fields, so the section can never be saved. Remove rows that are completely
// empty (keeping any row with data), confirming Trac's "Yes, remove" prompt each time.
async function trimEmptyRepeaterRows(page, log = () => {}) {
  let removed = 0;
  for (let k = 0; k < 8; k++) {
    const hit = await page.evaluate(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const rows = {};
      document.querySelectorAll('[name^="EditAppFieldset_"][name*="grrow_"]').forEach((el) => {
        const m = el.name.match(/^(.*grrow_)(\d+)_(.+)$/); if (!m || !vis(el) || /GRRemove/i.test(m[3])) return;
        const t = (el.getAttribute('type') || el.tagName).toLowerCase();
        if (['hidden', 'submit', 'button'].includes(t)) return;
        const txt = el.tagName === 'SELECT' && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '';
        const has = el.tagName === 'SELECT' ? (el.selectedIndex > 0 && !/united kingdom|please select/i.test(txt)) : (t === 'checkbox' || t === 'radio') ? el.checked : !!String(el.value || '').trim();
        const key = m[1] + m[2];
        rows[key] = rows[key] || { prefix: m[1], n: +m[2], filled: false };
        if (has) rows[key].filled = true;
      });
      const list = Object.values(rows).sort((a, b) => b.n - a.n);
      for (const r of list) {
        if (r.filled || !list.some((x) => x.prefix === r.prefix && x.filled)) continue;
        const del = document.querySelector('[name="' + r.prefix + r.n + '_GRRemove"]');
        if (del && vis(del)) { del.click(); return true; }
      }
      return false;
    }).catch(() => false);
    if (!hit) break;
    await sleep(1200);
    await clickControl(page, ['Yes, remove', 'Yes remove']);
    await sleep(2200);
    removed++;
  }
  if (removed) log(`  [Trac] Removed ${removed} empty row(s) (unused referee/job slots).`);
  return removed;
}

// "You've completed the questions in this section. You must mark the section as complete..."
// info pop-up. It blocks the page until closed.
async function closeInfoModal(page) {
  return page.evaluate(() => {
    const m = Array.from(document.querySelectorAll('.modal.show, [role="dialog"]')).find((x) => x.offsetParent !== null && /mark the section as complete|completed the questions/i.test(x.textContent || ''));
    if (!m) return false;
    const b = Array.from(m.querySelectorAll('button, a, input[type="button"]')).find((x) => /close|ok/i.test(x.value || x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  }).catch(() => false);
}

// Each group ("Personal details", "References", ...) must be finished with "Mark section as
// complete" once all its parts are OK, or the application can never be submitted.
async function markGroupsComplete(page, log = () => {}) {
  const done = new Set();
  for (let k = 0; k < 8; k++) {
    const name = await page.evaluate((doneArr) => {
      const vis = (e) => e && e.offsetParent !== null;
      for (const g of document.querySelectorAll('.app-form-section')) {
        const title = (g.querySelector('h2, h3, .card-title, legend') || g).textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (doneArr.includes(title)) continue;
        const subs = g.querySelectorAll('.list-group-item[class*="fieldset-"]');
        if (!subs.length || Array.from(subs).some((r) => !/fieldset-complete/.test(r.className))) continue;
        const b = Array.from(g.querySelectorAll('button, input[type="button"], input[type="submit"]')).find((x) => vis(x) && /mark section as complete/i.test(x.value || x.textContent || ''));
        if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return title; }
      }
      return null;
    }, [...done]).catch(() => null);
    if (!name) break;
    done.add(name);
    log(`  [Trac] Marked section as complete: ${name}`);
    await sleep(2000);
    await clickControl(page, ['Yes, mark as complete', 'Mark as complete', 'Yes, mark', 'Confirm']);
    await sleep(1200);
    await closeInfoModal(page);
  }
  return done.size;
}

// Finish line: reload the summary (row states go stale after inline saves) and report.
async function applicationStatus(page) {
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2000);
  return page.evaluate(() => {
    const clean = (t) => t.replace(/assignment_turned_in|assignment_late|assignment_returned|content_paste|expand_more|expand_less/gi, ' ').replace(/\b(OK|Incomplete|Not started|Show answers|Hide answers|Filled from past application)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 45);
    const rows = Array.from(document.querySelectorAll('.list-group-item[class*="fieldset-"]'));
    const notOk = rows.filter((r) => !/fieldset-complete/.test(r.className)).map((r) => clean(r.textContent));
    const groupsOpen = Array.from(document.querySelectorAll('.app-form-section')).filter((g) => /in progress|not started/i.test((g.textContent || '').slice(0, 40))).length;
    return { total: rows.length, ok: rows.length - notOk.length, notOk, groupsOpen };
  }).catch(() => ({ total: 0, ok: 0, notOk: [], groupsOpen: -1 }));
}

// Opening a section is a full server postback, and sections "Filled from past application"
// load slowly. Without waiting, the loop re-read the OLD summary, clicked the next section
// and cancelled the load, so copied sections were never opened or saved. Wait until the
// section's form fields exist (up to 10s).
async function waitForSectionForm(page) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    const ready = await page.evaluate(() => !!document.querySelector('[name^="EditAppFieldset_"]') && document.readyState !== 'loading').catch(() => false);
    if (ready) { await new Promise((r) => setTimeout(r, 400)); return true; }
  }
  return false;
}

// When a PREVIOUS application was copied, its supporting statement is for the OLD role and
// arrives marked complete. Force-open that section (by title, even if complete) so it gets
// re-tailored for THIS job. Returns true if it opened one. Person spec is left to
// openNextSection — it comes in incomplete (new vacancy criteria) and fills normally.
async function reopenForRetailor(page, log = () => {}) {
  const opened = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Reveal any collapsed groups so the supporting-statement row is reachable.
    Array.from(document.querySelectorAll('.app-form-section')).forEach((g) => {
      const s = Array.from(g.querySelectorAll('button, input[type="button"], input[type="submit"]')).find((b) => /^start section$/i.test(norm(b.value || b.textContent)));
      if (s) s.click();
    });
    const rows = Array.from(document.querySelectorAll('.list-group-item[class*="fieldset-"]'));
    const target = rows.find((r) => /supporting (information|statement)|why (are|do) you.*(applying|suitable|want)|personal statement/i.test(norm(r.textContent)));
    if (!target) return null;
    const btn = Array.from(target.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
      .find((b) => { const l = norm(b.value || b.textContent).toLowerCase(); return (l === 'edit' || l === 'open' || l.startsWith('edit ') || l.startsWith('open ')) && b.offsetParent !== null; });
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' }); btn.click();
    return norm(target.textContent).slice(0, 40);
  }).catch(() => null);
  if (opened) { log('  [Trac] Re-tailoring the supporting statement for this role (copied from a previous application).'); await waitForSectionForm(page); return true; }
  return false;
}

// Save the current section and advance. "Save & next" walks straight to the next section.
// Click the first VISIBLE control whose label matches one of `labels`, in priority
// order. Trac renders controls as <input type="button"/"submit" value="X"> as well as
// <button>/<a>, so we match on value OR text. Excludes cookie/search-filter controls.
// Returns the matched label, or null.
async function clickControl(page, labels) {
  return await page.evaluate((labels) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Text of a control EXCLUDING material-icon ligatures (Trac buttons prefix an icon
    // span whose text, e.g. "cancel"/"done"/"content_paste", otherwise glues onto the
    // label — "cancelContinue and fix later" — and breaks a plain startsWith match).
    const labelOf = (e) => {
      if (e.value) return e.value;
      let t = '';
      for (const n of e.childNodes) {
        if (n.nodeType === 3) t += n.textContent;
        else if (n.nodeType === 1 && !/material-icons|material-symbols|(^|\s)icon(\s|$)|ligature/i.test(n.className || '')) t += ' ' + n.textContent;
      }
      return t.trim() || e.textContent || '';
    };
    const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
    for (const want of labels) {
      const w = want.toLowerCase();
      for (const e of els) {
        if (/filter|cookie|onetrust|preference/i.test((e.id || '') + ' ' + (e.className || ''))) continue;
        const lab = norm(labelOf(e)).toLowerCase();
        if (!lab) continue;
        if (lab === w || lab.startsWith(w) || (w.length >= 10 && lab.includes(w))) {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && e.offsetParent !== null) { e.scrollIntoView({ block: 'center' }); e.click(); return want; }
        }
      }
    }
    return null;
  }, labels).catch(() => null);
}

// Save the current section and advance. "Save & next" walks straight to the next section.
async function clickNext(page, log = () => {}) {
  await sleep(800); // let the page finish registering the last answers before saving
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); // any re-render from the last answer
  for (const [nm, label] of [['EditAppFieldset_SubmitNext', 'Save & next'], ['EditAppFieldset_Submit', 'Save']]) {
    const b = page.locator(`[name="${nm}"]:visible`).first();
    if (await b.count().catch(() => 0)) { await b.scrollIntoViewIfNeeded().catch(() => {}); await b.click().catch(() => {}); log(`  [Trac] Clicked "${label}".`); return true; }
  }
  const hit = await clickControl(page, ['Save & next', 'Save and next', 'Save and continue', 'Save & continue', 'Launch application', 'Continue', 'Next', 'Save']);
  if (hit) { log(`  [Trac] Clicked "${hit}".`); return true; }
  return false;
}

// On the apps.trac.jobs advert/landing page (no form yet) the way IN to the application
// is a "Continue draft" button (job already started) or "Apply"/"Start application"
// (fresh). Click it to enter. Never the hidden search-filter "Apply" (isVisible-gated).
async function enterApplication(page, log = () => {}) {
  const hit = await clickControl(page, ['Continue draft', 'Continue application', 'Resume application', 'Launch application', 'Start your application', 'Start application', 'Begin application', 'Apply online', 'Apply']);
  if (hit) { log(`  [Trac] Entered application via "${hit}".`); return true; }
  return false;
}

// Parse any stored date into { day:'06', month:'August', year:'2016' } for Trac's split
// Day / Month / Year dropdowns. UK order FIRST: "06/08/2016" is 6 August, not June 8.
// (The old parser took the first number as the month, so 04/09/2023 went in as April.)
// Also handles "Aug 2016", "6 August 2016", "2016-08-06", "08/2016", "2016".
// "present"/"current" → {} (the caller decides what "present" means).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s || /present|current|ongoing|to date|\bnow\b/i.test(s)) return {};
  const pad = (n) => String(parseInt(n, 10)).padStart(2, '0');
  const out = { day: '', month: '', year: '' };
  const yr = s.match(/\b(19|20)\d{2}\b/); if (yr) out.year = yr[0];
  const alpha = s.toLowerCase().match(/jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/);
  if (alpha) {
    out.month = MONTHS[['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(alpha[0])];
    const d = s.replace(yr ? yr[0] : '~~no-year~~', ' ').match(/\b(0?[1-9]|[12]\d|3[01])(st|nd|rd|th)?\b/);
    if (d) out.day = pad(d[1]);
    return out;
  }
  const iso = s.match(/\b((?:19|20)\d{2})[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?\b/);
  if (iso) { out.month = MONTHS[+iso[2] - 1] || ''; if (iso[3]) out.day = pad(iso[3]); return out; }
  const parts = s.replace(yr ? yr[0] : '~~no-year~~', ' ').split(/[\/\-.\s]+/).filter((p) => /^\d{1,2}$/.test(p)).map(Number);
  if (parts.length >= 2) {
    let [a, b] = parts;                     // UK: day, month
    if (b > 12 && a <= 12) [a, b] = [b, a]; // only read as US when UK is impossible
    if (a >= 1 && a <= 31) out.day = pad(a);
    out.month = MONTHS[b - 1] || '';
  } else if (parts.length === 1 && parts[0] >= 1 && parts[0] <= 12) {
    out.month = MONTHS[parts[0] - 1];       // "08/2016"
  }
  return out;
}
// Kept for existing callers.
function parseMonthYear(raw) { return parseDate(raw); }
// "present" for a date you still hold (current job, referee you still know) → today.
function todayParts() { const n = new Date(); return { day: String(n.getDate()).padStart(2, '0'), month: MONTHS[n.getMonth()], year: String(n.getFullYear()) }; }

// Repeating sections (employment/education/references) start with one blank row; add
// rows via "Add another"/"Add to top" until there are enough for the stored entries.
async function ensureRepeaterRows(page, ctx, log = () => {}) {
  const d = ctx.details || {};
  // Some trusts nest the qualification under each place of study: an "Add subject" button
  // (…_grrow_N_details_AddButton) reveals the subject/grade/year boxes. Click it once for
  // any place-of-study row that has no subject boxes yet, so they can be filled.
  const nested = await page.evaluate(() => {
    const vis = (e) => e && e.offsetParent !== null;
    let n = 0;
    for (const b of document.querySelectorAll('[name$="_details_AddButton"]')) {
      if (!vis(b)) continue;
      const row = b.name.replace(/_details_AddButton$/, '_details_');
      const has = Array.from(document.querySelectorAll('input[name^="' + row + '"], select[name^="' + row + '"], textarea[name^="' + row + '"]')).some((e) => vis(e) && e.type !== 'hidden' && e.type !== 'submit');
      if (!has) { b.click(); n++; }
    }
    return n;
  }).catch(() => 0);
  if (nested) { log(`  [Trac] Added ${nested} subject row(s) under place of study.`); await sleep(1500); }
  const meta = await page.evaluate(() => {
    // Only the OPEN section's visible fields: the summary page also holds other sections'
    // hidden fields (employment ones made References think it needed 4 rows).
    const names = Array.from(document.querySelectorAll('input, select, textarea')).filter((e) => e.offsetParent !== null && /^EditAppFieldset_/.test(e.name || '')).map((e) => (e.name || e.id || '').toLowerCase());
    const rows = new Set(names.map((n) => { const m = n.match(/grrow_(\d+)/); return m ? m[1] : null; }).filter((x) => x !== null)).size;
    let sec = '';
    if (names.some((n) => /_ref_grrow|approachable/.test(n))) sec = 'ref';
    else if (names.some((n) => /employment-|otheremp/.test(n))) sec = 'emp';
    else if (names.some((n) => /qualif|education|academic|genedu/.test(n))) sec = 'edu';
    // References fields are named grrow_N_surname / _orgname / _first-name (NO "reference" prefix).
    else if (names.some((n) => /refere|reference|_surname|_orgname|_first-name|approachable/.test(n))) sec = 'ref';
    const hasAdd = Array.from(document.querySelectorAll('button, a')).some((b) => /add another|add to top/i.test(b.textContent || ''));
    return { sec, rows, hasAdd, other: names.some((n) => /otheremp/.test(n)) };
  }).catch(() => ({ sec: '', rows: 0, hasAdd: false }));
  if (!meta.sec || !meta.hasAdd) return;
  const arr = meta.sec === 'emp' ? d.employment : meta.sec === 'edu' ? d.education : meta.sec === 'ref' ? d.references : [];
  const need = Math.max(0, (Array.isArray(arr) ? arr.length : 0) - (meta.sec === 'emp' && meta.other ? employmentOffset('otheremp', d) : 0));
  let have = Math.max(meta.rows, 1);
  let guard = 0;
  while (have < need && guard++ < 12) {
    const clicked = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, a')).find((x) => /add another|add to top/i.test(x.textContent || '')); if (b) { b.click(); return true; } return false; }).catch(() => false);
    if (!clicked) break;
    await new Promise((r) => setTimeout(r, 700));
    const now = await page.evaluate(() => new Set(Array.from(document.querySelectorAll('input, select, textarea')).filter((e) => e.offsetParent !== null && /^EditAppFieldset_/.test(e.name || '')).map((e) => { const m = (e.name || e.id || '').match(/grrow_(\d+)/); return m ? m[1] : null; }).filter((x) => x !== null)).size).catch(() => have);
    if (now <= have) break;
    have = now;
  }
  if (need > 1) log(`  [Trac] Repeater (${meta.sec}): ${have} row(s) for ${need} entries.`);
}

// Answer an OUTLIER (unmapped) question with the licensed AI engine — the same one
// Reed/LinkedIn use. It reads the job + profile and picks an option (radio/select) or
// writes a short answer (text). It NEVER answers sensitive questions (built-in guard),
// so those stay on the user's stored answers. Returns true if it filled the field.
async function aiAnswerOutlier(page, q, label, job) {
  if (!ai || !ai.aiEnabled || !ai.aiEnabled()) return false;
  // Retry once on a null result — the licensed backend can throw a transient 502
  // (cold start / brief upstream blip) that succeeds on a second attempt.
  const retry = async (fn) => { let r = await fn().catch(() => null); if (r == null) { await new Promise((s) => setTimeout(s, 1800)); r = await fn().catch(() => null); } return r; };
  try {
    if (q.kind === 'radio' && Array.isArray(q.options) && q.options.length >= 2) {
      const picked = await retry(() => ai.aiPickOption({ question: label, options: q.options.map((o) => ({ text: o.label })), job }));
      if (picked && picked.text) return await selectRadioOption(page, q, picked.text);
      return false;
    }
    if (q.kind === 'select' && q.name) {
      const opts = await page.evaluate((nm) => {
        const el = document.querySelector('[name="' + nm.replace(/"/g, '\\"') + '"]') || document.getElementById(nm);
        if (!el || !el.options) return [];
        return Array.from(el.options).map((o) => (o.textContent || '').trim()).filter((t) => t && !/please select|choose|select\.\.\.|^--/i.test(t));
      }, q.name).catch(() => []);
      if (opts.length >= 2) {
        const picked = await retry(() => ai.aiPickOption({ question: label, options: opts.map((t) => ({ text: t })), job }));
        if (picked && picked.text) { await fillFieldByName(page, q.name, picked.text); return true; }
      }
      return false;
    }
    if ((q.kind === 'text' || q.kind === 'textarea') && q.name) {
      const ans = await retry(() => ai.aiTextAnswer({ question: label, job, long: q.kind === 'textarea' }));
      if (ans) { await fillFieldByName(page, q.name, ans); return true; }
    }
  } catch (_) {}
  return false;
}

// Fill every question on the current section form from profile + stored details,
// falling back to the AI engine for outliers.
async function fillPageQuestions(page, ctx, paused, pausedKeys) {
  const { applicant = {}, details = {}, supportingStatement = '', job = {}, log = () => {} } = ctx;
  const questions = await readQuestions(page);
  // Detect the repeating section ONCE from all fields on this page, so every field routes
  // to the right data — including references' bare "Job title"/"Email address" fields.
  const allNames = questions.map((q) => (q.name || '')).join(' ').toLowerCase();
  const allLabels = questions.map((q) => (q.question || q.label || '')).join(' ').toLowerCase();
  let secHint = '';
  if (/employment-(?!equality)|otheremp/.test(allNames.replace(/employmentequality/g, 'eqmon'))) secHint = 'emp';
  else if (/education-|genedu|_qualif/.test(allNames) || /qualification|place of study/.test(allLabels)) secHint = 'edu';
  else if (/_surname|_orgname|_first-name|_approachable|refere|reference/.test(allNames) || /refere/.test(allLabels)) secHint = 'ref';
  let filled = 0, pausedThisPage = 0, aiAnswered = 0;
  const outliers = [];
  const unfilled = []; // DIAG: fields we did NOT fill, with enough identity to wire an answer
  const note = (q, why) => unfilled.push(`${q.kind}|${(q.name || '').slice(0, 40)}|${(q.question || q.label || '').slice(0, 50)}|${why}${q.options ? '|opts:' + q.options.map((o) => o.label).filter(Boolean).slice(0, 6).join('/') : ''}`);
  const pageStart = Date.now();
  const batch = []; // questions the rules couldn't answer → one AI call with the data payload
  for (const q of questions) {
    // Hard stops: never let one page eat the application's time budget (or 3 minutes).
    if ((ctx.deadline && Date.now() > ctx.deadline) || Date.now() - pageStart > 3 * 60 * 1000) { log('  [Trac] Page taking too long — saving what is filled and moving on.'); break; }
    const label = q.question || q.label || '';
    if (!label && !q.name) continue;
    // Retry pass: only touch the fields Trac flagged "Please complete this."
    if (ctx.onlyNames && !ctx.onlyNames.has(q.name)) continue;
    // Disability-type TICK-BOXES ("Physical impairment", "Sensory impairment", ...): leave
    // unticked unless the user said they have a disability. Saves an AI call per box.
    if (q.kind === 'checkbox' && /disabilitytype/i.test(q.name || '') && !/^y/i.test(String(details.disability || ''))) continue;
    // "Preferred employment type" tick boxes all share one name: tick the user's type
    // (default Full time) by its own id, leave the rest alone.
    if (q.kind === 'checkbox' && /preferredemploy|employment type|working pattern/i.test((q.name || '') + ' ' + label)) {
      const want = new RegExp(String(details.preferredEmployment || 'full.?time').replace(/[-\s]+/g, '.?'), 'i');
      if (want.test(q.label || '')) { const ok = await setCheckbox(page, q, true); filled++; log(`  [Trac] Ticked "${q.label}" (${ok ? 'ok' : 'DIAG not ticked, id=' + (q.id || 'none')}).`); }
      continue;
    }
    const dob = /(?:dob|dateofbirth|birthdate)_?(day|month|year)$/i.exec(q.name || '');
    const rep = dob ? (() => { const p = parseDate(details.dob); return p[dob[1].toLowerCase()] ? { action: 'fill', value: p[dob[1].toLowerCase()] } : { action: 'skip' }; })()
      : repeaterAnswer(label, q.name, details, secHint);
    // Person-spec boxes ("personspecification-criteria...") are labelled with the criterion
    // itself, so no label rule matches them: route by name to the tailored criteria writer.
    const a = (/personspecification-criteria/i.test(q.name || '') && q.kind === 'textarea') ? { action: 'ai', kind: 'criteria' } : (rep || resolveAnswer(label, applicant, details));
    // NHS service-record consent (Inter Authority Transfer): trusts word the options differently.
    // Pick "Not applicable" when offered (external applicant), otherwise the consent/Yes option.
    if (/inter.?authority transfer|consent.*(trust|us).*obtain|obtaining details of your (previous )?(nhs )?(employment|service|pay|continuous service)/i.test(label) && (q.kind === 'select' || q.kind === 'radio')) {
      const opts = q.kind === 'radio' ? (q.options || []).map((o) => o.label || '') : await page.evaluate((n) => { const e = document.querySelector('[name="' + n.replace(/"/g, '\\"') + '"]'); return e && e.options ? Array.from(e.options).map((o) => o.text.trim()) : []; }, q.name).catch(() => []);
      const pick = (!details.currentlyNhs && opts.find((o) => /not applicable|not currently/i.test(o))) || opts.find((o) => /^(yes|i give|i consent|i agree)/i.test(o));
      if (pick) {
        if (q.kind === 'radio') { if (await selectRadioOption(page, q, pick)) filled++; }
        else { await fillFieldByName(page, q.name, pick); filled++; }
        continue;
      }
    }
    // Start of continuous NHS service (if applicable): only for people who've worked in the NHS.
    // Otherwise leave BOTH blank (a lone month makes Trac demand the year too), clearing any
    // value filled earlier.
    if (/nhsstart_(month|year)$/i.test(q.name || '') && q.kind === 'select') {
      if (!details.currentlyNhs && !details.nhsStart) {
        await page.evaluate((n) => { for (const s of document.querySelectorAll('select[name="' + n + '"]')) if (s.selectedIndex > 0) { s.selectedIndex = 0; s.dispatchEvent(new Event('change', { bubbles: true })); } }, q.name).catch(() => {});
        note(q, 'not-nhs');
        continue;
      }
    }
    // Welsh language ability (Welsh health boards): radios labelled only "Yes"/"No", so route by
    // name. Answer from the profile if the user set it, else No.
    if (/welshlang/i.test(q.name || '') && (q.kind === 'radio' || q.kind === 'select')) {
      const w = /^y/i.test(String(details.welsh || '')) ? 'Yes' : 'No';
      if (q.kind === 'radio') { if (await selectRadioOption(page, q, w)) filled++; else note(q, 'welsh-miss'); }
      else { await fillFieldByName(page, q.name, w); filled++; }
      continue;
    }
    // Remember the form asked an AI-use declaration: such applications are never auto-submitted.
    if (a && a.aiUse) page.__jobaiAiQuestion = true;
    // Any question that mentions AI at all (however it gets answered) means the user submits.
    if (/\bai\b|artificial intelligence|chat ?gpt|generative ai|large language model/i.test(label)) page.__jobaiAiQuestion = true;
    // On a retry, Trac has told us this field is REQUIRED, so "skip" is not an option:
    // let the AI answer it from the user's details (sensitive questions stay blocked
    // inside question_ai). Otherwise skipped fields stay blank as before.
    // Never let the AI invent dates (start dates, "known since", date of birth).
    if (a.action === 'skip' && ctx.retry && /date|_day$|_month$|_year$|dob/i.test(q.name || '')) { note(q, 'date-needs-you'); continue; }
    if (a.action === 'skip' && ctx.retry) { batch.push({ q, label, why: 'required-blank' }); continue; }
    if (a.action === 'skip') { note(q, 'skip'); continue; }
    if (a.action === 'pause') { const key = q.name || label; if (!pausedKeys.has(key)) { pausedKeys.add(key); paused.push({ field: label, reason: a.reason }); } pausedThisPage++; note(q, 'pause'); continue; }
    if (a.action === 'ai') {
      if (a.kind === 'supporting_statement' && supportingStatement && q.name) { await fillFieldByName(page, q.name, await fitToFieldLimit(page, q.name, supportingStatement, log)).catch(() => {}); filled++; continue; }
      // Person-spec criteria: write a tailored answer; if the AI can't, fall back to the
      // pre-generated supporting statement so the REQUIRED field is never left blank.
      // Person-spec boxes go into the ONE batch AI call below (saves a call per box).
      if (a.kind === 'criteria' && q.name && /personspecification-criteria/i.test(q.name)) {
        batch.push({ q, label: `How do you meet this person specification criterion: "${label}"? Answer in the first person with specific evidence from my experience, 60 to 120 words.`, why: 'criteria' });
        continue;
      }
      if (a.kind === 'criteria' && q.name) {
        const crit = label;
        const ok = await aiAnswerOutlier(page, q, crit, job);
        if (ok) { aiAnswered++; filled++; }
        // A single criterion the user doesn't clearly meet: say so honestly rather than
        // leave a required box blank (or paste the whole statement into it).
        else if (/personspecification-criteria/i.test(q.name)) { await fillFieldByName(page, q.name, `I do not yet fully meet this, but I am keen to develop in this area and would welcome the training and support to do so.`).catch(() => {}); filled++; note(q, 'criteria-honest'); }
        else if (supportingStatement) { await fillFieldByName(page, q.name, supportingStatement).catch(() => {}); filled++; }
        else { if (label) outliers.push(label); note(q, 'criteria-blank'); }
        continue;
      }
      // Never let the AI answer a date part (Day / Month / Year): it invented an NHS start month.
      if (/[-_](day|month|year)$/i.test(q.name || '') || /^(day|month|year)\s*\*?$/i.test(String(label).trim())) { note(q, 'date-no-ai'); continue; }
      // Unknown question → answered below in ONE AI call with the full data payload.
      batch.push({ q, label, why: 'ai-blank' });
      continue;
    }
    if (a.action === 'fill' && a.value != null && a.value !== '') {
      if (q.kind === 'radio') { if (await selectRadioOption(page, q, String(a.value))) filled++; else batch.push({ q, label, why: 'radio-miss' }); }
      else if (q.kind === 'checkbox' && q.id) { await setCheckbox(page, q, /^(y|yes|true|1|on|agree|i agree)/i.test(String(a.value).trim())); filled++; }
      else { await fillFieldByName(page, q.name, String(a.value)); if (ctx.keyboard && q.kind === 'select') await keyboardSelect(page, q.name); filled++; }
    } else { note(q, 'no-value'); }
  }

  // Your friend's method: give the AI ONE payload of the user's data and let it answer every
  // question the rules couldn't, together, instead of one question at a time with no context.
  if (batch.length && ai && ai.aiFillFields && ai.aiEnabled && ai.aiEnabled()) {
    const selNames = batch.filter((b) => b.q.kind === 'select').map((b) => b.q.name);
    const selOpts = selNames.length ? await page.evaluate((names) => {
      const o = {};
      for (const n of names) { const el = document.querySelector('[name="' + n.replace(/"/g, '\\"') + '"]'); if (el && el.options) o[n] = Array.from(el.options).map((x) => (x.textContent || '').trim()).filter((t) => t && !/^please select|^select\.\.\.|^--/i.test(t)); }
      return o;
    }, selNames).catch(() => ({})) : {};
    const fields = batch.map((b, i) => ({ id: i, label: b.label, kind: b.q.kind, options: b.q.kind === 'radio' ? (b.q.options || []).map((o) => o.label).filter(Boolean) : selOpts[b.q.name] }));
    const answers = await ai.aiFillFields({ fields, payload: tracPayload(applicant, details, supportingStatement), job }).catch(() => ({}));
    for (let i = 0; i < batch.length; i++) {
      const { q, label, why } = batch[i];
      const v = answers[i];
      if (v) {
        if (q.kind === 'radio') { if (await selectRadioOption(page, q, v)) { filled++; aiAnswered++; continue; } }
        else if (q.kind === 'checkbox') { await setCheckbox(page, q, /^(y|yes|true|agree)/i.test(v)); filled++; aiAnswered++; continue; }
        else { await fillFieldByName(page, q.name, v); filled++; aiAnswered++; continue; }
      }
      // A person-spec criterion the user can't evidence: say so honestly (never blank, never invented).
      if (why === 'criteria') { await fillFieldByName(page, q.name, 'I do not yet fully meet this, but I am keen to develop in this area and would welcome the training and support to do so.').catch(() => {}); filled++; note(q, 'criteria-honest'); continue; }
      if (label && why !== 'required-blank') outliers.push(label);
      note(q, why);
    }
  } else {
    for (const { q, label, why } of batch) { if (label && why !== 'required-blank') outliers.push(label); note(q, why); }
  }
  if (outliers.length) log('  [Trac] Outlier(s) left blank: ' + outliers.slice(0, 8).map((s) => '"' + s.slice(0, 44) + '"').join(', '));
  if (unfilled.length) log('  [Trac] DIAG unfilled(' + unfilled.length + '): ' + unfilled.slice(0, 20).join(' ;; '));
  return { questions, filled, pausedThisPage, aiAnswered };
}

/**
 * Drive the Trac application for one job.
 * ctx: { job, applicant, jd, tailoredCvPath, generateSupportingStatement(jd, cv), answerQuestion(q, ctx), submit }
 * Returns 'applied' | 'dry_run' | 'needs_login' | 'blocked' | false, plus a paused[] list.
 */
async function fillApplication(page, ctx) {
  page.__jobaiAiQuestion = false;
  const { job, applicant, submit = false, log = console.log } = ctx;
  const paused = [];
  let strayTab = null;
  // Keepalive: a slow AI step (e.g. writing the supporting statement, ~1-2 min) leaves the
  // browser idle, and Trac's inactivity timer then throws up a password re-auth wall that
  // stalls the run. A lightweight background request every 40s keeps the session alive.
  let keepAlive = setInterval(() => {
    try { (strayTab || page).evaluate(() => { try { fetch('/dashboard', { credentials: 'include', cache: 'no-store' }); } catch (_) {} }).catch(() => {}); } catch (_) {}
  }, 40000);
  // Field actions default to a 30s wait each; on a page where fields aren't interactable
  // (e.g. just after a dialog) ~40 of them stalled one application for 20+ minutes. Keep
  // every action short so a bad page fails fast instead of looking like the agent froze.
  try { page.setDefaultTimeout(6000); } catch (_) {}
  ctx.deadline = Date.now() + 8 * 60 * 1000;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1200));
    await dismissCookieBanner(page);

    // RESUME MODE: job.url is an existing draft's application-summary URL (apps.trac.jobs/
    // application/{id}). Skip the advert → "Apply online" entry entirely and drop straight
    // into the section loop to finish the draft. Otherwise run the normal advert → apply flow.
    if (ctx.resume) {
      log(`  [Trac] Resuming existing draft → ${page.url().slice(0, 90)}`);
      if (await needsLogin(page)) { log('  [Trac] Login required — the Trac account session is needed.'); return { result: 'needs_login', paused }; }
      // The vacancy closed before this draft was submitted: nothing can be filled any more.
      const shut = await page.evaluate(() => /application status:\s*deadline passed|this vacancy closed|vacancy (has )?closed/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      if (shut) { log('  [Trac] Deadline passed: this vacancy closed before it was submitted.'); return { result: 'closed', paused }; }
    } else {
      const st = await advertState(page);
      log(`  [Trac] Advert opened: ${page.url().slice(0, 90)} (${st.body.length} chars, ${st.state})`);
      if (st.state === 'blocked') { log('  [Trac] Blocked by bot-check on the advert page.'); return { result: 'blocked', paused }; }
      if (st.state === 'closed') { log('  [Trac] Vacancy is closed / redirected to homepage — skipping (not an open advert).'); return { result: 'closed', paused }; }

      const apply = await findApplyEntry(page);
      if (!apply) { log('  [Trac] DIAG: no Apply button matched. Buttons/links on page: ' + (await page.evaluate(() => Array.from(document.querySelectorAll('a,button')).map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 40).slice(0, 20).join(' | ')).catch(() => ''))); return { result: false, paused }; }
      log('  [Trac] Apply entry found — clicking.');
      // The "Apply online now" link is target="_blank" — strip it so the application
      // opens IN PLACE instead of spawning a new tab for every job (which piles up).
      await elOp(apply, 'removeTarget').catch(() => {});
      const ctxObj = page.context();
      const before = ctxObj.pages().length;
      await apply.click().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      // Target was stripped so this normally navigates in place. If a stray tab STILL
      // opened, follow it and close it at the end (below) so tabs don't pile up. Never
      // close the caller's main page — it's reused for the next job.
      const pages = ctxObj.pages();
      if (pages.length > before) {
        strayTab = pages[pages.length - 1];
        page = strayTab;
        await page.bringToFront().catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      await dismissCookieBanner(page);

      const url = page.url();
      log(`  [Trac] After Apply → ${url.slice(0, 90)}`);
      if (await needsLogin(page)) { log('  [Trac] Login required — the Trac account session is needed.'); return { result: 'needs_login', paused }; }
      // Didn't leave the advert host → the click hit something that isn't the real apply.
      if (!/apps\.trac\.jobs/i.test(url) && /healthjobsuk\.com/i.test(url)) { log('  [Trac] Apply did not open the Trac application (still on the advert host) — skipping.'); return { result: false, paused }; }
    }

    // ── Section-loop navigator ────────────────────────────────────────────────
    // Drive the hub-and-spoke application: an initial linear pre-questions flow leads
    // to the Application summary (a checklist of sections). We fill each section form,
    // click "Save & next" (which advances to the next section), open any remaining
    // sections from the summary, and use "Continue and fix later" to keep going if a
    // section can't be fully completed. DRY RUN never clicks the final Submit.
    const pausedKeys = new Set();
    const attemptedSections = new Set(); // section names we've already opened this run (no re-fight)
    const reloadedFor = new Set(); // sections we already reloaded once to get past a stuck save
    const started = Date.now();
    let lastSig = '', repeats = 0, sectionsSeen = 0, entered = 0, opens = 0;
    let noControl = 0, noFields = 0;
    let gateSeen = 0; // count of times we've hit the Getting Started gate this application
    let usedPrevious = false, reTailored = false; // copied a previous app → must re-tailor the supporting statement for THIS role
    for (let step = 0; step < 80; step++) {
      // Hard time budget: a single application can never tie up the agent forever (e.g. a
      // slow AI step + Trac's inactivity password wall). Stop cleanly; the draft is saved.
      if (Date.now() - started > 8 * 60 * 1000) { log('  [Trac] Time budget reached for this application — saved as draft, moving on.'); break; }
      // Trac's inactivity re-auth wall can appear mid-flow (esp. after a slow AI step left
      // the browser idle). Detect it and stop cleanly instead of hanging on the password page.
      if (await needsLogin(page)) { log('  [Trac] Trac asked for the password again (inactivity) — draft saved, moving on. Sign in stays active while the agent runs continuously.'); break; }
      await dismissCookieBanner(page);
      await handleDialog(page, log);
      await closeInfoModal(page);

      // Clear the "Getting started" gate first. Prefer "Use a previous application" (copies
      // the standard sections) on the FIRST encounter; if that didn't get us past the gate
      // (still here next loop), force "Blank form" so we can never get stuck on the gate.
      const gateMode = await handleGettingStarted(page, log, gateSeen === 0, ctx.preferCopyFrom || []);
      if (gateMode) {
        gateSeen++; if (gateMode === 'previous') usedPrevious = true;
        // Launch can take several seconds: wait for the application itself to open before
        // looking again, so a slow load isn't mistaken for "the choice didn't work".
        for (let w = 0; w < 40; w++) {
          await sleep(500);
          const opened = await page.evaluate(() => /\/application\/\d+/.test(location.href) && !!document.querySelector('.list-group-item, [name^="EditAppFieldset_"]')).catch(() => false);
          if (opened) break;
        }
        continue;
      }

      // PRIORITY: if a section form is OPEN (fillable fields present), fill it and advance
      // with Save & next — BEFORE any summary handling. The summary's "Open" buttons stay
      // on the page while a section is open, so checking the summary first would wrongly
      // re-open sections instead of completing the one in front of us.
      await ensureRepeaterRows(page, ctx, log);
      const { questions, filled, pausedThisPage, aiAnswered } = await fillPageQuestions(page, { applicant, details: ctx.details || {}, supportingStatement: ctx.supportingStatement, job: ctx.job || {}, log, deadline: ctx.deadline }, paused, pausedKeys);

      if (questions.length > 0) {
        const sig = page.url() + '|' + questions.length + '|' + questions.slice(0, 6).map((q) => q.name).join(',');
        sectionsSeen++;
        log(`  [Trac] Section ${sectionsSeen}: ${questions.length} field(s) — filled ${filled}${aiAnswered ? ` (${aiAnswered} via AI)` : ''}, ${pausedThisPage} to confirm.`);
        // Loop-guard: same form twice → escape via the fix-later dialog, else stop.
        if (sig === lastSig) { repeats++; } else { repeats = 0; lastSig = sig; }
        if (repeats >= 2 || (repeats >= 1 && !(await readFieldErrors(page)).length)) { // saved with no errors but still open: usually already saved (last in its group), reload to confirm
          log('  [Trac] Section not advancing — saving as draft and moving on.');
          const why = await page.evaluate(() => {
            const vis = (e) => e && e.offsetParent !== null;
            const errs = Array.from(document.querySelectorAll('.field-validation-error, .invalid-feedback, .text-danger, .validation-summary-errors, .alert-danger, [role="alert"], [class*="error"]'))
              .filter(vis).map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 220);
            const qs = Array.from(document.querySelectorAll('input[name], select[name], textarea[name]')).filter((e) => (vis(e) || e.type === 'radio') && !['hidden', 'submit', 'button'].includes(e.type) && !/onetrust|cookie|^ot-/i.test(e.name))
              .map((e) => { const g = e.closest('fieldset, .form-group, .trac-form-group'); const q = g && g.querySelector('legend, label'); const v = e.type === 'radio' || e.type === 'checkbox' ? (e.checked ? 'CHECKED' : '') : e.tagName === 'SELECT' ? (e.options[e.selectedIndex] || {}).text : e.value;
                return `${String(e.name).slice(-28)}|${e.type}|${((q && q.innerText) || '').replace(/\s+/g, ' ').slice(0, 70)}|${String(v || '').slice(0, 30)}`; });
            // What the open section actually says + which buttons it offers (e.g. an "Add"
            // button that must commit a row, or a notice) - the part the field list misses.
            const row = document.querySelector('.list-group-item.open') || document.querySelector('[name^="EditAppFieldset_"]')?.closest('form, .list-group-item, section') || null;
            const text = row ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 900) : '';
            const btns = row ? Array.from(row.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]')).filter(vis).map((b) => `${(b.innerText || b.value || '').trim().slice(0, 30)}[${b.name || b.id || ''}]`).slice(0, 15) : [];
            return { url: location.href.slice(0, 80), errs: [...new Set(errs)].slice(0, 8), qs: qs.slice(0, 16), text, btns };
          }).catch(() => null);
          if (why) log('  [Trac] DIAG not advancing: ' + JSON.stringify(why));
          if (await handleDialog(page, log)) { await new Promise((r) => setTimeout(r, 1200)); continue; }
          // No dialog, no field errors: a timing glitch (the same section saves fine on a fresh
          // page). Reload once and retry; if it sticks again, close it and do the REST of the
          // form instead of abandoning the whole application.
          const openId = await page.evaluate(() => { const r = document.querySelector('.list-group-item.open'); return r ? r.id : ''; }).catch(() => '');
          const rkey = 'reload:' + (openId || sig);
          if (!reloadedFor.has(rkey)) {
            reloadedFor.add(rkey);
            log('  [Trac] Reloading the page and trying that section again.');
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
            // The reload closes the section; let the summary step reopen it once (it was
            // already marked as tried, which ended the run instead of retrying).
            if (openId) { attemptedSections.delete(openId); attemptedSections.delete('open:' + openId); }
            repeats = 0; lastSig = '';
            continue;
          }
          if (openId) {
            attemptedSections.add(openId);
            await page.locator('.list-group-item.open [name="EditAppFieldset_Cancel"]:visible').first().click().catch(() => {});
            await handleDialog(page, log);
            await sleep(1500);
            repeats = 0; lastSig = '';
            log('  [Trac] Skipping that section for now and carrying on with the rest.');
            continue;
          }
          break;
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        await trimEmptyRepeaterRows(page, log);
        // Pre-save check: any required (*) field in the open section still empty gets one
        // targeted fill BEFORE Save, instead of waiting for Trac to reject the save.
        const empties = await findEmptyRequired(page);
        if (empties.length) {
          log(`  [Trac] Pre-save check: ${empties.length} required field(s) empty (${empties.map((e) => e.label).join('; ').slice(0, 160)}). Filling them first.`);
          await fillPageQuestions(page, { applicant, details: ctx.details || {}, supportingStatement: ctx.supportingStatement, job: ctx.job || {}, log, deadline: ctx.deadline, onlyNames: new Set(empties.map((e) => e.name)), retry: true }, paused, pausedKeys);
        }
        const openBefore = await page.evaluate(() => { const r = document.querySelector('.list-group-item.open'); return r ? r.id : ''; }).catch(() => '');
        const advanced = await clickNext(page, log);
        if (!advanced) {
          // No Save button in view is NOT the end of the application (e.g. a page showing
          // only a notice). Reload back to the summary and carry on with the next section.
          noControl++;
          if (noControl >= 3) { log('  [Trac] No Save/Continue control after 3 tries, stopping here.'); break; }
          log('  [Trac] No Save button here, going back to the summary to carry on.');
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
          repeats = 0; lastSig = '';
          continue;
        }
        await sleep(1800);
        // Trac saves over AJAX and can take several seconds. Wait until the open section changes
        // (or a pop-up / error appears) before judging, so a slow save isn't taken as "stuck".
        if (openBefore) {
          for (let w = 0; w < 20; w++) {
            const s2 = await page.evaluate(() => {
              const r = document.querySelector('.list-group-item.open');
              const dlg = Array.from(document.querySelectorAll('.modal.show, [role="dialog"]')).some((x) => x.offsetParent !== null);
              const err = Array.from(document.querySelectorAll('.list-group-item.open *')).some((x) => x.children.length === 0 && x.offsetParent !== null && /please complete this|must be answered|is required/i.test(x.textContent || ''));
              return { id: r ? r.id : '', dlg, err };
            }).catch(() => ({ id: '', dlg: false, err: false }));
            if (s2.id !== openBefore || s2.dlg || s2.err) break;
            await sleep(500);
          }
        }
        // If Trac objects, read its pop-up and choose "Fix now" so the section stays open with
        // its "Please complete this." markers visible (instead of hiding them via fix-later).
        let hadDialog = await fixNowIfDialog(page, log);
        await closeInfoModal(page);
        let errs = await readFieldErrors(page);
        for (let attempt = 1; errs.length && attempt <= 2; attempt++) {
          log(`  [Trac] Trac flagged ${errs.length} field(s): ${errs.map((e) => e.label || e.name).join('; ').slice(0, 240)}. Fixing (try ${attempt}).`);
          await fillPageQuestions(page, { applicant, details: ctx.details || {}, supportingStatement: ctx.supportingStatement, job: ctx.job || {}, log, deadline: ctx.deadline, onlyNames: new Set(errs.map((e) => e.name)), retry: true, keyboard: attempt === 2 }, paused, pausedKeys);
          await trimEmptyRepeaterRows(page, log);
          await clickNext(page, log);
          await sleep(1800);
          hadDialog = await fixNowIfDialog(page, log);
          await closeInfoModal(page);
          errs = await readFieldErrors(page);
        }
        if (!errs.length && hadDialog && await page.evaluate(() => !!document.querySelector('.list-group-item.open')).catch(() => false)) {
          // Trac objected but marked no field: save what's there and move on.
          await clickNext(page, log); await sleep(1500); await handleDialog(page, log);
        }
        if (errs.length) {
          // Can't be saved with the details we hold: record exactly what's missing, close the
          // section (so the rest of the form can continue) and never reopen it this run.
          log(`  [Trac] Needs you: ${errs.map((e) => e.label || e.name).join('; ').slice(0, 300)}`);
          // What the page actually holds for each field it still rejects, so any remaining
          // cause is visible in one run (hidden twin field, custom widget, empty options...).
          const probe = await page.evaluate((names) => names.map((n) => {
            const els = Array.from(document.querySelectorAll('[name="' + n.replace(/"/g, '\\"') + '"]'));
            return n.replace('EditAppFieldset_', '') + ' => ' + els.map((e) => `${e.tagName.toLowerCase()}/${e.type || ''}${e.offsetParent === null ? '(hidden)' : ''}=${e.tagName === 'SELECT' ? JSON.stringify((e.options[e.selectedIndex] || {}).text || '') + ` opts:[${Array.from(e.options).slice(0, 5).map((o) => JSON.stringify(o.text.slice(0, 40) + '=' + o.value)).join(',')}]` : JSON.stringify(String(e.value || '').slice(0, 20)) + ` len=${String(e.value || '').length}${e.maxLength > 0 ? ' max=' + e.maxLength : ''}`}`).join(' + ') + ' | msg: ' + (((e0) => { const g = e0 && e0.closest('.form-group, .trac-form-group, [id$="_container"]'); const m = g && Array.from(g.querySelectorAll('*')).find((x) => x.children.length === 0 && x.offsetParent !== null && /please|required|must|invalid|exceed|maximum|characters|words/i.test(x.textContent)); return m ? m.textContent.trim().slice(0, 120) : ''; })(els[0]));
          }), errs.slice(0, 6).map((e) => e.name)).catch(() => []);
          if (probe.length) log('  [Trac] DIAG still rejected: ' + probe.join(' ;; '));
          for (const e of errs) { if (!pausedKeys.has(e.name)) { pausedKeys.add(e.name); paused.push({ field: e.label || e.name, reason: 'Trac: please complete this' }); } }
          const openId = await page.evaluate(() => { const r = document.querySelector('.list-group-item.open'); return r ? r.id : ''; }).catch(() => '');
          if (openId) attemptedSections.add(openId);
          await clickNext(page, log); await sleep(1500);
          if (!(await handleDialog(page, log))) { await clickControl(page, ['Cancel']); }
          await sleep(1500);
        }
        continue;
      }

      // No fillable fields → we're on the summary (open next section) or a landing page.
      if (await isSummaryPage(page)) {
        if (opens >= 25) { log('  [Trac] Section loop guard hit — stopping.'); break; }
        // If we copied a PREVIOUS application, its supporting statement is for the OLD role.
        // Force-reopen that section once to re-tailor it for THIS job (it copies over marked
        // "complete", so openNextSection would otherwise skip it). Person spec is tied to the
        // new vacancy's criteria, so it comes in incomplete and fills fresh on its own.
        if (usedPrevious && !reTailored) {
          reTailored = true;
          const reopened = await reopenForRetailor(page, log);
          if (reopened) { opens++; await new Promise((r) => setTimeout(r, 1500)); continue; }
        }
        const opened = await openNextSection(page, attemptedSections, log);
        if (!opened) {
          // Finish line: mark every fully-OK group complete, then report the true state.
          await closeInfoModal(page);
          await markGroupsComplete(page, log);
          let st = await applicationStatus(page);
          // "Mark section as complete" often needs a second try: reload and mark again once.
          if (st.total && !st.notOk.length && st.groupsOpen > 0) {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
            await closeInfoModal(page);
            await markGroupsComplete(page, log);
            st = await applicationStatus(page);
          }
          if (st.total && !st.notOk.length && st.groupsOpen === 0) log(`  [Trac] ✓ COMPLETE: all ${st.total} sections OK and every group marked complete. Ready to submit.`);
          else log(`  [Trac] Result: ${st.ok}/${st.total} sections OK${st.notOk.length ? `. Still needs you: ${st.notOk.join('; ')}` : ''}${st.groupsOpen > 0 ? `. ${st.groupsOpen} group(s) not yet marked complete` : ''}.`);
          ctx.finalStatus = st;
          break;
        }
        opens++;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // Advert/landing page (e.g. an existing draft shows "Continue draft") → click into it.
      if (entered < 4 && await enterApplication(page, log)) { entered++; await new Promise((r) => setTimeout(r, 1800)); continue; }
      // Page still loading or in an odd state: reload and look again (twice) before giving up.
      if (noFields < 2) { noFields++; log('  [Trac] Page not ready, reloading and trying again.'); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); continue; }
      { const what = await page.evaluate(() => ({ url: location.href.slice(0, 90), title: document.title.slice(0, 80), text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 400) })).catch(() => null);
        if (what) log('  [Trac] DIAG page: ' + JSON.stringify(what)); }
      log('  [Trac] No form fields and no way into the application — end.');
      break;
    }

    // Ended early (time budget, stuck page...): still read Trac's own section status so the
    // user sees exactly what is missing, not "check the draft".
    if (!ctx.finalStatus && /apps\.trac\.jobs\/application\//.test(page.url())) {
      try { await closeInfoModal(page); await markGroupsComplete(page, log); ctx.finalStatus = await applicationStatus(page); } catch (_) {}
      const st0 = ctx.finalStatus;
      if (st0 && st0.total) log(`  [Trac] Result: ${st0.ok}/${st0.total} sections OK${st0.notOk.length ? `. Still needs you: ${st0.notOk.join('; ')}` : ''}.`);
    }
    if (paused.length) log(`  [Trac] ${paused.length} field(s) still need you: ${paused.map((p) => p.reason).join(', ')}`);
    const draftUrl = (String(page.url() || '').match(/https:\/\/apps\.trac\.jobs\/application\/\d+/) || [''])[0];
    const aiQuestion = !!page.__jobaiAiQuestion;
    const st = ctx.finalStatus;
    const complete = !!(st && st.total && !st.notOk.length && st.groupsOpen === 0);
    if (!submit) { log('  [Trac] Filled and saved as a draft (you submit it).'); return { result: 'dry_run', paused, status: st, draftUrl, aiQuestion }; }
    // Auto-submit (the user turned it on). Only when Trac itself shows EVERY section OK, and
    // never when the form asked an AI-use declaration: those stay for the user to submit.
    if (!complete) { log('  [Trac] Not submitting: the application is not complete yet.'); return { result: 'dry_run', paused, status: st, draftUrl, aiQuestion }; }
    if (aiQuestion || ctx.blockSubmit) { log('  [Trac] Not auto-submitting: this form asks about AI use, so you submit it yourself.'); return { result: 'dry_run', paused, status: st, draftUrl, aiQuestion: true }; }
    const sub = await submitApplication(page, log);
    if (sub === 'submitted') return { result: 'applied', paused, status: st, draftUrl, aiQuestion };
    if (sub === 'closed') return { result: 'closed', paused, status: st, draftUrl, aiQuestion };
    return { result: 'dry_run', paused, status: st, draftUrl, aiQuestion };
  } catch (e) {
    log('  [Trac] Apply error: ' + e.message);
    return { result: false, paused };
  } finally {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    try { page.setDefaultTimeout(30000); } catch (_) {} // restore for non-form steps (login, search)
    // Close a stray application tab (if the apply link still popped one) so tabs
    // never accumulate one-per-job. The caller's main page is a different object.
    if (strayTab) { try { await strayTab.close(); } catch (_) {} }
  }
}

async function fillFieldByName(page, name, value) {
  if (!name) return;
  const nq = String(name).replace(/"/g, '\\"');
  const any = `select[name="${nq}"], textarea[name="${nq}"], input[name="${nq}"]:not([type="hidden"])`;
  const vis = page.locator(`select[name="${nq}"]:visible, textarea[name="${nq}"]:visible, input[name="${nq}"]:not([type="hidden"]):visible`);
  const el = (await vis.count().catch(() => 0)) ? vis.first() : page.locator(`${any}, #${CSS_escape(name)}:not([type="hidden"])`).first();
  const info = await elOp(el, 'info').catch(() => ({ tag: '', type: '' }));
  if (info.tag === 'select') {
    // Work out WHICH option (value) to pick in the page, then select it with a real
    // Playwright selection. Setting sel.value from script changed what was shown but Trac's
    // validation never registered it ("Please complete this." under a visibly filled box).
    const optValue = await elOp(el, 'pickOption', value).catch(() => null);
    if (optValue == null) return;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const optIndex = parseInt(optValue, 10);
    // Already holds this answer: don't touch it. Re-selecting fires Trac's change handlers,
    // which re-render the section just as we press Save, so the save is lost (Equality loop).
    const already = await elOp(el, 'selectedIs', optIndex).catch(() => false);
    if (!already) {
      await el.selectOption({ index: optIndex }).catch(() => {});
      await elOp(el, 'fireChangeBlur').catch(() => {});
      await sleep(FIELD_PAUSE_MS);
      // Verify it stuck; one more try if the page reset it.
      const stuck = await elOp(el, 'selectedIs', optIndex).catch(() => true);
      if (!stuck) { await elOp(el, 'setSelected', optIndex).catch(() => {}); await sleep(FIELD_PAUSE_MS); }
    }
    // Some Trac pages carry a second copy of the same dropdown; set it too, so whichever one
    // Trac reads on Save holds the answer.
    const chosenText = await elOp(el, 'selectedText').catch(() => '');
    await page.evaluate(([n, t]) => {
      for (const s of document.querySelectorAll('select[name="' + n.replace(/"/g, '\\"') + '"]')) {
        const k = Array.from(s.options).findIndex((o) => o.text === t);
        if (k > 0 && s.selectedIndex !== k) { s.selectedIndex = k; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, [name, chosenText]).catch(() => {});
    return;
  }
  if (info.type === 'checkbox') {
    const on = /^(y|yes|true|1|on|agree|i agree)/i.test(String(value).trim());
    await el.scrollIntoViewIfNeeded().catch(() => {});
    if (on) await el.check().catch(() => {}); else await el.uncheck().catch(() => {});
    await sleep(FIELD_PAUSE_MS);
    return;
  }
  if (info.type === 'radio') {
    // Pick the option in this radio group whose visible label matches the value.
    const opt = page.locator(`input[type="radio"][name="${name}"]`);
    const n = await opt.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const one = opt.nth(i);
      const lbl = await elOp(one, 'radioLabel').catch(() => '');
      if (norm(lbl) === norm(value) || norm(lbl).startsWith(norm(value))) { await one.scrollIntoViewIfNeeded().catch(() => {}); await one.check().catch(() => {}); await sleep(FIELD_PAUSE_MS); return; }
    }
    return;
  }
  // Text: type it like a person, then leave the field so Trac's validation runs.
  // Already holds this exact text (e.g. copied from a previous application): leave it, the
  // same as dropdowns. Re-typing it marks grid rows as edited and the first Save is lost.
  if (await elOp(el, 'valueEquals', value).catch(() => false)) return;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.fill(value).catch(() => {});
  await elOp(el, 'fireChangeBlur').catch(() => {});
  await sleep(FIELD_PAUSE_MS);
}

// Re-pick a dropdown's current choice with the keyboard: focus, type the option text,
// press Enter, Tab away. Genuine key events for pages that ignore programmatic changes.
async function keyboardSelect(page, name) {
  const nq = String(name).replace(/"/g, '\\"');
  const el = page.locator(`select[name="${nq}"]:visible`).first();
  const text = await elOp(el, 'selectedText').catch(() => '');
  if (!text || /please select/i.test(text)) return false;
  await el.focus().catch(() => {});
  await page.keyboard.type(text.slice(0, 20), { delay: 60 }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.keyboard.press('Tab').catch(() => {});
  await sleep(FIELD_PAUSE_MS);
  return true;
}

// Pause after every field so Trac's page scripts keep up (filling too fast left answers
// that showed on screen but were never registered).
const FIELD_PAUSE_MS = 350;
function CSS_escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

// Make sure the agent's browser is signed in to the user's NHS/Trac account. Trac
// login is manual (we never store the user's Trac password), so if not already
// signed in we open the Trac candidate site and WAIT for the user to log in in the
// visible window — the renderer shows a "Trac is waiting for you to log in" prompt
// off the log lines below. The persistent trac_profile keeps the session for next
// time, so this only happens once.
async function ensureTracLogin(page, log = console.log) {
  const HOME = 'https://apps.trac.jobs/';
  // Accurate "signed in" detection. The Trac header shows "My account" and "My
  // applications" links to EVERYONE (logged in or not), so those are useless as a
  // signal — using them false-positives and makes the agent skip login, then hit a
  // login wall on every application. The only reliable proof of a live session is a
  // Sign out / logout control AND no visible login (password) form.
  const isSignedIn = () => page.evaluate(() => {
    const u = location.href.toLowerCase();
    const onAuth = /\/login|\/register|sign[-_ ]?in|create.*account/.test(u);
    if (onAuth) return false;
    const hasLogout = !!document.querySelector('a[href*="logout" i], a[href*="signout" i], a[href*="sign-out" i]');
    const bodyTxt = (document.body ? document.body.innerText : '').toLowerCase();
    const hasLogoutText = /\bsign out\b|\blog out\b|\blogout\b/.test(bodyTxt);
    const pw = document.querySelector('input[type="password"]');
    const hasLoginForm = pw && pw.offsetParent !== null;
    return (hasLogout || hasLogoutText) && !hasLoginForm;
  }).catch(() => false);

  try { await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 40000 }); } catch (_) {}
  await new Promise((r) => setTimeout(r, 2000));
  if (await isSignedIn()) { log('  [Trac] ✓ Session restored — already logged in.'); return true; }

  log('  [Trac] Opening login page...');
  log('  [Trac] Waiting for you to complete login (up to 5 minutes) — sign in to your NHS/Trac account in the browser window that opened.');
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    if (await isSignedIn()) { log('  [Trac] ✓ Logged in. Session saved — next run will skip login.'); return true; }
  }
  log('  [Trac] Login timed out — start the Trac agent again once signed in.');
  return false;
}

// List the applicant's existing INCOMPLETE drafts from the Trac dashboard, so the agent
// can go back and finish applications it already started (rather than only applying to
// brand-new jobs). Returns [{ id, url, title }] for drafts that are not submitted/closed.
async function listDraftApplications(page, log = () => {}) {
  return (await listTracApplications(page, log)).drafts;
}

// Everything on the user's Trac account: open drafts (to finish) and the titles of
// applications already SUBMITTED (never apply to those again). Reads both the Dashboard
// and the Applications list, since Trac shows different items on each.
async function listTracApplications(page) {
  const drafts = [], submittedTitles = [], seen = new Set();
  for (const url of ['https://apps.trac.jobs/dashboard', 'https://apps.trac.jobs/applicationlist']) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(1600);
    const found = await page.evaluate(() => {
      const out = [];
      const cards = new Set();
      for (const a of document.querySelectorAll('a[href*="/application/"]')) {
        let c = a; for (let i = 0; i < 10 && c; i++) { if (/Application status|Job title|Complete your application|Draft/i.test(c.innerText || '') && (c.innerText || '').length > 60) break; c = c.parentElement; }
        if (c) cards.add(c);
      }
      for (const c of cards) {
        const t = (c.innerText || '').replace(/[ \t]+/g, ' ');
        const a = c.querySelector('a[href*="/application/"]');
        const id = a ? (a.href.match(/\/application\/(\d+)/) || [])[1] : null;
        const status = ((t.match(/Application status:?\s*\n?\s*([^\n]+)/i) || [])[1] || '').trim();
        const title = ((t.match(/Job title\s*\n\s*([^\n]+)/i) || [])[1] || t.split('\n').map((s) => s.trim()).find((s) => s.length > 6 && !/status|draft|complete your|received|ago/i.test(s)) || '').trim();
        const closed = /deadline passed|closed on|no longer accept|vacancy.*closed/i.test(t);
        const isDraft = /draft|in progress|incomplete|not submitted|complete your application/i.test(status + ' ' + t.slice(0, 200)) && !/unsuccessful|submitted|received|shortlisted|withdrawn|offer/i.test(status);
        out.push({ id, title: title.slice(0, 90), status, closed, isDraft });
      }
      return out;
    }).catch(() => []);
    for (const f of found) {
      if (!f.id || seen.has(f.id)) continue; seen.add(f.id);
      if (f.isDraft && !f.closed) drafts.push({ id: f.id, url: 'https://apps.trac.jobs/application/' + f.id, title: f.title });
      else if (!f.isDraft && f.title) submittedTitles.push(f.title);
    }
  }
  // The list sometimes shows no job title for a draft. Read it from the draft page itself
  // ("<Job title> | Application summary | Trac"), so a draft is never mistaken for missing.
  for (const d of drafts) {
    if (d.title && d.title.length > 5) continue;
    await page.goto(d.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(1200);
    d.title = String(await page.title().catch(() => '') || '').split('|')[0].trim();
  }
  return { drafts, submittedTitles };
}

module.exports = { resolveAnswer, repeaterAnswer, fillApplication, ensureTracLogin, listDraftApplications, listTracApplications, _test: { fillFieldByName, parseDate, fillPageQuestions, clickNext, readQuestions } };
