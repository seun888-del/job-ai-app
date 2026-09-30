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

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9+#]{2,}/g) || [];
const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+# ]+/g, ' ').replace(/\s+/g, ' ').trim();

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
  // "Helpdesk" / "help desk" jobs are IT service desk jobs.
  if (have.has('helpdesk') || /\bhelp desk\b/.test(f)) ['it', 'service', 'desk'].forEach((w) => have.add(w));
  return matchers.some((m) => f.includes(' ' + m.phrase + ' ') || (m.need.length > 0 && m.need.every((w) => have.has(w))));
}

module.exports = { compile, titleMatches };
