// Does a job title fit the user's search terms? Shared by the desktop app and the Chrome extension.
//
// A title matches a term when it contains the whole term, or when it contains ALL of the term's
// key words. Key words leave out generic words (band, senior, NHS...) and job-type nouns
// (support, analyst, engineer...), which are too common to decide anything on their own:
//   "IT Support"           needs "it"                 -> "IT Service Desk Analyst" yes, "Mental Health Support Worker" no
//   "Service Desk Analyst" needs "service" + "desk"   -> "1st Line Service Desk Engineer" yes
//   "Staff Nurse"          needs "nurse"
// A term made only of those common words ("Support Worker", "Healthcare Assistant") matches on
// the whole phrase, or on all its words.

const GENERIC = new Set(('specialist senior junior band assistant highly trainee apprentice nhs trust foundation the and of for in at on to with role post manager officer lead coordinator practitioner worker healthcare community hospital care team staff level grade year years x').split(' '));
const ROLE_NOUNS = new Set(('support analyst engineer technician administrator admin advisor adviser executive clerk operative associate consultant representative rep agent specialist officer assistant worker').split(' '));

// Different words employers use for the same job, rewritten to one form in both the user's
// terms and job titles: "Software Developer" finds "Software Engineer", "HR Advisor" finds
// "People Advisor", "Admin Assistant" finds "Administrative Assistant".
const SAME = [
  [/\b(developer|programmer|dev)\b/g, 'engineer'],
  [/\bback end\b/g, 'backend'], [/\bfront end\b/g, 'frontend'], [/\bfull stack\b/g, 'fullstack'],
  [/\bhuman resources?\b|\bpeople(?= (advisor|adviser|partner|officer|manager|coordinator|assistant|generalist|business partner)\b)/g, 'hr'],
  [/\b(administrative|administration|administrator)\b/g, 'admin'],
  [/\bcustomer (support|care|services)\b/g, 'customer service'],
  [/\b(nursing)\b/g, 'nurse'], [/\b(accounting|accounts)\b/g, 'accountant'],
  [/\b(despatch|dispatch|picker|packer|pick and pack|mhe|forklift|goods in|loader)\b/g, 'warehouse'],
];
const canon = (s) => SAME.reduce((t, [re, to]) => t.replace(re, to), ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9+# ]+/g, ' ').replace(/\s+/g, ' ') + ' ');
const words = (s) => canon(s).match(/[a-z0-9+#]{2,}/g) || [];
const flat = (s) => canon(s).trim();
// A software job named by its stack ("Senior Backend Developer", "Android Engineer").
const SOFTWARE = / (backend|frontend|fullstack|android|ios|mobile|web|java|javascript|python|node js|net|c#|react|ruby|php|golang|go) engineer /;

// One matcher per term: { phrase, need: [words that must all be in the title] }.
function compile(terms) {
  return (terms || []).map((t) => {
    const all = words(t);
    const key = all.filter((w) => !GENERIC.has(w) && !ROLE_NOUNS.has(w));
    const fallback = all.filter((w) => !GENERIC.has(w));
    return { phrase: flat(t), need: key.length ? key : fallback };
  }).filter((m) => m.phrase.length >= 2);
}

function titleMatches(title, matchers) {
  if (!matchers || !matchers.length) return true; // no terms: don't over-filter
  const f = ' ' + flat(title) + ' ';
  const have = new Set(words(title));
  const raw = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9+# ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  // "Helpdesk" / "help desk" jobs are IT service desk jobs.
  if (have.has('helpdesk') || /\bhelp desk\b/.test(f)) ['it', 'service', 'desk'].forEach((w) => have.add(w));
  // IT support jobs that don't say "IT": "2nd Line Support Consultant", "Technical Support
  // Engineer", "Infrastructure Support Engineer", "IS Support Specialist", "Support Engineer".
  if (/ (technical|tech|ict|is|infrastructure|applications?|systems?|desktop|cloud|(1st|2nd|3rd|first|second|third) line) support |\b(1st|2nd|3rd|first|second|third) line\b| support engineer /.test(f + ' ' + raw)) have.add('it');
  if (SOFTWARE.test(f)) have.add('software');
  return matchers.some((m) => f.includes(' ' + m.phrase + ' ') || (m.need.length > 0 && m.need.every((w) => have.has(w))));
}

module.exports = { compile, titleMatches };
