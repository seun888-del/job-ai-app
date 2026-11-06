/**
 * federal_jd.js
 * Federal (USAJOBS) adverts are full of eligibility boilerplate: U.S. citizenship, "one year of
 * specialized experience equivalent to GS-7", time-in-grade, Selective Service, background
 * checks, probation, drug tests. The CV scorer read those as must-have skills a CV can never
 * show, so every federal job failed the match. This keeps the duties and the skills (including
 * what the specialized experience consists of) and drops the conditions of employment.
 * Shared by the desktop app and the extension. Citizenship is still checked separately.
 */
const BOILERPLATE = [
  /\bcitizens?(hip)?\b/i, /\bin order to qualify\b/i, /\bqualifications? (are|is) based on\b/i,
  /\bselective service\b/i, /\btime[- ]in[- ]grade\b/i, /\bbackground (check|investigation)\b/i,
  /\bsuitability\b/i, /\bprobationary period\b/i, /\bdrug (test|screen)/i, /\bfinancial disclosure\b/i,
  /\bsecurity clearance\b/i, /\bfair chance\b/i, /\bfederal employment\b/i, /\bpayroll\b.*\bdirect deposit\b/i,
  /\bwithin \d+ days of the closing date\b/i, /\bclosing date of (this|the) announcement\b/i,
  /\bmust meet all qualification requirements by\b/i, /\bresume (must|should) (show|include|clearly)/i,
  /\bhours per week\b/i, /\bpart-?time experience\b/i, /\bvolunteer experience\b/i,
  /\bforeign education\b/i, /\baccredited\b.*\b(institution|school|college)/i, /\bgrandfather/i,
  /\bbeginning and ending dates\b/i, /\bMM\/YYYY\b/i, /\brequired for the position\b/i, /\bgeneral experience\b/i,
  /\bpart[- ]time vs\.? full[- ]time\b/i, /\btranscripts?\b/i,
  /\bphysical requirements?\b/i, /\bEnglish language proficiency\b/i, /\bfor more information,? visit\b/i,
  /\bvacancy is being filled\b/i, /\bpromotion potential\b/i, /\bqualification standard\b/i,
];

// "One year of specialized experience equivalent to the GS-07 level, which includes X" keeps X.
function keepSpecialized(s) {
  const m = s.match(/specialized experience[^.]*?\b(?:which (?:includes?|is)|such as|including|that (?:includes?|demonstrates?)|defined as|for example)[:\s]+(.+)/i);
  if (m) return 'Experience: ' + m[1];
  if (/\b(one|1) (full )?year of specialized experience\b|\bequivalent to (at least )?(the )?(next lower )?(gs|grade)[- ]?\d+/i.test(s)) return '';
  return s;
}

function cleanFederalJD(text) {
  const parts = String(text || '').replace(/\s+/g, ' ').split(/(?<!\bU\.S)(?<=[.;:])\s+(?=[A-Z(•-])/);
  const out = [];
  for (let s of parts) {
    s = s.trim();
    if (!s) continue;
    if (BOILERPLATE.some((re) => re.test(s))) continue;
    s = keepSpecialized(s);
    if (s) out.push(s);
  }
  return out.join(' ').trim();
}

// What federal HR actually checks a resume against: the "specialized experience" paragraph
// (one or two sentences per grade). The job is scored on this, not on the long duty list,
// which the resume is still tailored to. '' when the advert has no such paragraph.
const SPEC_END = /\bthis definition of specialized experience\b|\bthe specialized experience must\b|\bin addition to (meeting )?the specialized experience\b|\bin addition to meeting\b|\btime[- ]in[- ]grade\b|\bkey requirements:|\beducation:|\badditional information\b|\bsubstitution of education\b|\bor education\b|\byou must meet\b|\bto be creditable\b/i;
const SPEC_LEAD = /^(?:and other experience)?[:\s]*(?:(?:one|1) (?:full )?year of (?:the )?specialized experience\s*)?(?:equivalent to (?:at least )?(?:the )?(?:next lower )?(?:gs|grade)[- ]?\d+(?: level)?(?: in the federal service)?[.,]?\s*)?(?:for this position,?\s*)?(?:specialized experience is defined as\s*)?(?:which (?:includes?|demonstrates?(?: experience in)?|is)|that (?:includes?|demonstrates?)|such as|including|defined as)?[:\s]*/i;
function specializedExperience(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out = [];
  const re = /specialized (?:and other )?experience/gi;
  let m;
  while ((m = re.exec(t)) && out.length < 2) {
    let s = t.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const end = s.search(SPEC_END);
    if (end >= 0) s = s.slice(0, end);
    s = cleanFederalJD(s.replace(SPEC_LEAD, '').replace(/^(?:is defined as|defined as)\s*/i, '').trim());
    // A sentence that only names the grade ("...equivalent to the GS-11 level.") has no skills.
    // Skip "...definition of specialized experience is typical of the next lower grade" and the like.
    if (/^(is typical|must|requirements?|and\/or|at the next|described)\b/i.test(s) || /definition of\s*$/i.test(t.slice(Math.max(0, m.index - 20), m.index))) { re.lastIndex = m.index + m[0].length; continue; }
    if (s.split(/\s+/).length >= 12 && !out.some((o) => o.slice(0, 60) === s.slice(0, 60))) out.push(s);
    re.lastIndex = m.index + m[0].length + Math.max(end, 0);
  }
  return out.join(' ').trim();
}

// Federal jobs are matched one level wider than the user's setting: the must-haves are long
// phrases from the specialized experience paragraph, and federal HR reads the tailored resume
// against that paragraph rather than looking for exact words.
function widerLevel(level) { return level === 'strict' ? 'balanced' : 'wide'; }

module.exports = { cleanFederalJD, specializedExperience, widerLevel };
