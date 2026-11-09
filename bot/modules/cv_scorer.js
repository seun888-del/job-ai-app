// Local ATS keyword scorer — replaces Jobscan website entirely.
// Uses an LLM to extract required keywords from a JD, then deterministically
// checks how many appear in the CV. No browser, no external service.
//
// SEMANTIC MATCHING (2026-09-12): real ATS (Workday, Taleo, SuccessFactors,
// NHS Trac) match on meaning, not just exact strings. A CV that says "user
// acceptance testing" DOES satisfy a JD asking for "UAT". So the LLM now returns,
// for each requirement, its acronym/expansion + accurate synonyms ("alts") and
// whether it is ESSENTIAL, in the SAME single call. Matching counts a term as
// present if the CV contains the term OR any alt; essential terms weigh 2x.
// This (a) stops the score understating true coverage and rejecting good jobs,
// and (b) stops the addendum dumping keywords the CV already covers in other words.

const { llmChat } = require('../../src/services/llm');
const { focusJD } = require('./jd_focus');

// ── Term presence: word-boundary-safe contains ───────────────────────────────
// Short all-letter terms (likely acronyms) must match on a word boundary so
// "AD" doesn't match inside "additional" and "SC" not inside "describe".
// Longer / multi-word / symbol-bearing terms use a plain substring check.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hasTerm(cvText, term) {
  const cvLower = String(cvText || '').toLowerCase();
  const t = String(term || '').trim().toLowerCase();
  if (t.length < 2) return false;
  const isShortAcronym = t.length <= 4 && /^[a-z]+$/.test(t);
  if (isShortAcronym) {
    try { return new RegExp(`\\b${escapeRe(t)}\\b`).test(cvLower); }
    catch { return cvLower.includes(t); }
  }
  return cvLower.includes(t);
}

// A keyword object counts as covered if the CV contains its term OR any alt.
function keywordCovered(cvLower, kw) {
  for (const t of [kw.term, ...(kw.alts || [])]) for (const v of termVariants(t)) if (hasTerm(cvLower, v)) return true;
  // Federal adverts (kw.loose): their skills come from duty sentences, so match on word stems
  // ("Human Resource policies" is met by "HR policy"). Other adverts keep the exact check.
  if (kw.loose) for (const t of [kw.term, ...(kw.alts || [])]) if (looseCovered(cvLower, t)) return true;
  return false;
}

const LOOSE_STOP = new Set(['and', 'or', 'of', 'the', 'to', 'in', 'for', 'with', 'a', 'an', 'on', 'experience', 'knowledge', 'skills', 'skill', 'ability', 'related', 'various', 'applicable']);
const stem = (w) => w.replace(/(ies|es|s)$/, '').slice(0, 5);
const looseWords = (s) => String(s || '').toLowerCase().replace(/\bhuman resources?\b/g, 'hr').split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !LOOSE_STOP.has(w)).map(stem);
let looseCv = { text: null, words: null }; // the last CV's stems (one CV is scored at a time)
function looseCovered(cvLower, term) {
  const words = looseWords(term);
  if (!words.length) return false;
  if (looseCv.text !== cvLower) looseCv = { text: cvLower, words: new Set(looseWords(cvLower)) };
  const cv = looseCv.words;
  const hits = words.filter((w) => cv.has(w)).length;
  return words.length <= 2 ? hits === words.length : hits >= Math.ceil(words.length * 2 / 3);
}

// Advert wordings a CV rarely repeats word for word: "Outlook / Excel" is met by either
// one, and filler like "suite", "tool" or "knowledge of" is dropped ("Microsoft Office
// suite" -> "Microsoft Office", "ITSM Tool" -> "ITSM").
const FILLER_HEAD_RE = /^(experience|knowledge|understanding|proficiency)( of| in| with)?\s+/i;
const FILLER_TAIL_RE = /\s+(suite|tools?|skills?|experience|knowledge)$/i;
function termVariants(term) {
  const t = String(term || '').trim();
  const out = new Set([t]);
  for (const part of t.split(/\s*\/\s*|\s+or\s+|\s*,\s*/i)) {
    out.add(part.trim());
    out.add(part.trim().replace(FILLER_HEAD_RE, '').replace(FILLER_TAIL_RE, '').trim());
  }
  return [...out].filter(v => v.length >= 2);
}

// Soft skills and personal qualities ("Strong communication skills", "Attention to
// detail", "Self motivated") aren't scored: every candidate claims them, CVs rarely
// word them the advert's way, and counting them sank good matches to 0% (NEC Service
// Desk Analyst, 2026-10-20). Only real skills, tools and experience count.
const SOFT_SKILL_RE = /communicat|attention to detail|detail[- ]oriented|self[- ]?motivat|self[- ]?starter|team ?(player|work)|work(ing)? (well )?(under pressure|independently|on your own|as part of a team)|follow(ing)? (instructions|procedures|processes)|(take|taking) ownership|make decisions|decision[- ]making|flexib|adaptab|proactive|enthusias|positive attitude|can[- ]do|hard[- ]working|well[- ]organi[sz]ed|organi[sz]ational skills|time management|punctual|good timekeeping|interpersonal|problem[- ]solving|influencing|motivated|reliab|willing(ness)? to learn|eager to learn|initiative|integrity|professionalism|people skills/i;

// Normalise whatever the model returned into our {term, essential, alts} shape.
// Tolerates the old flat ["skill", ...] format and stray junk so a model drift
// can never crash scoring — it just degrades to unweighted, exact-match terms.
function normaliseKeywords(raw) {
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let term, essential = false, alts = [];
    if (typeof item === 'string') {
      term = item;
    } else if (item && typeof item === 'object') {
      term = item.term || item.keyword || item.skill || '';
      essential = !!(item.essential || item.required || item.mandatory);
      if (Array.isArray(item.alts)) alts = item.alts;
      else if (Array.isArray(item.synonyms)) alts = item.synonyms;
    }
    term = String(term || '').trim();
    if (term.length < 2 || term.length > 60) continue;
    if (SOFT_SKILL_RE.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    alts = alts.filter(a => typeof a === 'string')
               .map(a => a.trim())
               .filter(a => a.length >= 2 && a.length <= 60);
    out.push({ term, essential, alts });
  }
  return out;
}

// Use the LLM to extract required skills from a JD, WITH acronym/synonym pairs
// and an essential/desirable flag — all in one call (no extra latency vs before).
// Returns an array of { term, essential, alts:[…] }.
async function extractJDKeywords(jdText, opts = {}) {
  const prompt = `Extract the key required skills, tools, technologies and qualifications from this job description.

For EACH requirement return an object with:
- "term": the skill/tool/qualification as written in the advert
- "essential": true if it is a must-have / mandatory requirement, false if merely desirable
- "alts": accurate equivalents that mean the SAME thing — acronym expansions, the acronym itself, and common synonyms. Include the acronym AND its full form as a pair (e.g. term "user acceptance testing" -> alts ["UAT"]; term "AD" -> alts ["Active Directory"]). Do NOT invent unrelated terms. For an experience-level requirement give the everyday wordings of that experience (e.g. term "1st line experience" -> alts ["first line", "1st line support", "service desk", "helpdesk", "IT support"]; term "customer service" -> alts ["customer support", "end-user support", "user support", "client support"]).

Leave out soft skills and personal qualities (communication, attention to detail, self-motivation, teamwork, following instructions, taking ownership, flexibility, problem solving); list only real skills, tools, technologies, qualifications and experience.

Return ONLY a valid JSON array of such objects, 10 to 20 items, most important first. No commentary.
Example:
[{"term":"Active Directory","essential":true,"alts":["AD","Entra ID","Azure AD"]},{"term":"user acceptance testing","essential":false,"alts":["UAT"]},{"term":"ITIL","essential":true,"alts":["IT service management","ITSM"]}]
${opts.federal ? `\n\nThis text is a U.S. federal "specialized experience" statement written as duties. Turn each duty into the short skill or experience it needs: 2 to 4 words, never a sentence, and give its everyday wordings as alts (e.g. "Providing technical Human Resource advice" -> term "HR advice", alts ["human resources advice", "HR guidance", "advise managers", "policy advice"]; "receiving, reviewing, documenting, or resolving IT help desk tickets" -> term "help desk tickets", alts ["service desk", "tickets", "incident tickets", "helpdesk"]). Use "HR" and "human resources" both where relevant. Mark a skill essential only if the statement requires it.` : ''}${opts.jobbank ? `\n\nThis is a Canada Job Bank advert built from standard job-description wording: "Duties" are generic task statements and "Requirements" are listed separately. Turn each duty into the short skill it needs: 2 to 4 words, never a sentence, with its everyday CV wordings as alts (e.g. "Respond to users experiencing difficulties with computer" -> term "user IT support", alts ["technical support", "troubleshooting", "help desk", "service desk", "resolving user issues"]; "Take vital signs" -> term "vital signs", alts ["observations", "obs", "patient monitoring"]). Mark essential ONLY the 3 or 4 duties that define this job and any required certificate or licence (e.g. "AZ licence", "CPR certificate"). Leave out education level, years of experience, languages and the "Desirable, not required" list: those are not skills to look for in the CV.` : ''}

JOB DESCRIPTION:
${focusJD(jdText, 3000)}`;

  const response = await llmChat(prompt);

  // Pull the first JSON array out of the response (greedy so nested objects survive)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const raw = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(raw)) return [];
    const kws = normaliseKeywords(raw);
    // Duty-written adverts (federal, Job Bank): match on word stems, not exact phrases.
    return opts.federal || opts.jobbank ? kws.map((k) => ({ ...k, loose: true })) : kws;
  } catch {
    return [];
  }
}

// Deterministically score the CV against the extracted keyword objects.
// Essential terms weigh 2x. A term is "found" when the CV contains it OR any of
// its accurate equivalents (semantic/acronym match). Returns:
//   { score 0-100, found:[terms], missing:[terms] }
// `missing` is a flat array of the ORIGINAL advert terms (strings), so the
// downstream addendum/weaving keeps working unchanged.
function computeScore(cvText, keywords) {
  if (!keywords.length) return { score: 0, found: [], missing: [] };
  const cvLower = cvText.toLowerCase();
  const found   = [];
  const missing = [];
  let matchedWeight = 0;
  let totalWeight   = 0;
  for (const kw of keywords) {
    const weight = kw.essential ? 2 : 1;
    totalWeight += weight;
    if (keywordCovered(cvLower, kw)) {
      matchedWeight += weight;
      found.push(kw.term);
    } else {
      missing.push(kw.term);
    }
  }
  return {
    score:   Math.round((matchedWeight / totalWeight) * 100),
    found,
    missing,
  };
}

// Full score: extract keywords (+ semantics) from JD via the LLM, then score.
// One LLM call per CV; subsequent boost iterations use rescoreCV (instant, no LLM).
// When the AI fails or reads no keywords (twice), this THROWS: callers retry the job
// later. It used to fall back to 85%, which let off-target jobs through (GitLab Backend
// Engineer roles reached Ready to send on 2026-10-20 with no keywords read).
// opts.federal: the text is a federal specialized experience statement (duties, not skills).
async function scoreCV(cvText, jdText, opts = {}) {
  let keywords = [];
  for (let attempt = 0; attempt < 2 && !keywords.length; attempt++) {
    keywords = await extractJDKeywords(jdText, opts);
  }
  if (!keywords.length) throw new Error('no keywords read from the advert');

  const { score, found, missing } = computeScore(cvText, keywords);
  const essN = keywords.filter(k => k.essential).length;
  console.log(`  [Scorer] ${found.length}/${keywords.length} keywords matched (${essN} essential) → ${score}% (semantic)`);
  if (missing.length) {
    const preview = missing.slice(0, 8).join(', ');
    console.log(`  [Scorer] Missing: ${preview}${missing.length > 8 ? '…' : ''}`);
  }

  // allKeywords carries the full {term,essential,alts} objects so rescoreCV
  // stays consistent with the semantic/weighted model used here.
  return { score, missingKeywords: missing, allKeywords: keywords };
}

// How picky the match check is (Search preferences). A job passes when its overall match
// reaches "any", OR the CV covers at least "ess" percent of the advert's must-haves: missing
// nice-to-haves alone never skip a job (tailoring brings them forward). Meeting none of two or
// more must-haves always skips. Checked on the CV as written, before any keyword addendum.
const MATCH_LEVELS = { wide: { any: 35, ess: 30 }, balanced: { any: 45, ess: 40 }, strict: { any: 70, ess: 70 } };
function matchFit(cvText, allKeywords, level) {
  const L = MATCH_LEVELS[level] || MATCH_LEVELS.balanced;
  const kws = !allKeywords || !allKeywords.length ? [] : typeof allKeywords[0] === 'string' ? normaliseKeywords(allKeywords) : allKeywords;
  if (!kws.length) return { pass: true, score: 0, essOk: 0, essTotal: 0, reason: '' };
  const { score } = computeScore(cvText, kws);
  const cvLower = String(cvText || '').toLowerCase();
  const ess = kws.filter(k => k.essential);
  const essOk = ess.filter(k => keywordCovered(cvLower, k)).length;
  const many = ess.length >= 2;
  const pass = many && !essOk ? false : score >= L.any || (many && (essOk / ess.length) * 100 >= L.ess);
  const reason = pass ? '' : many ? `meets ${essOk} of ${ess.length} must-haves` : `${score}% match`;
  console.log(`  [Scorer] Fit (${level || 'balanced'}): ${score}%, must-haves ${essOk}/${ess.length} → ${pass ? 'pass' : 'skip'}`);
  return { pass, score, essOk, essTotal: ess.length, reason };
}

// Rescore after injecting keywords — deterministic, no LLM call.
// Uses the keyword objects from the original scoreCV call. Tolerates the old
// flat string[] form (older callers) by normalising first.
function rescoreCV(cvText, allKeywords) {
  if (!allKeywords || !allKeywords.length) return { score: 85, missingKeywords: [] };
  const keywords = typeof allKeywords[0] === 'string' ? normaliseKeywords(allKeywords) : allKeywords;
  const { score, missing } = computeScore(cvText, keywords);
  console.log(`  [Scorer] Rescore → ${score}%`);
  return { score, missingKeywords: missing };
}

// The tailored CV that is actually sent must match at least this share of the advert's keywords.
// Below it the application rarely gets a call, so the job is skipped (and the daily cap kept for
// better fits). Follows the user's "How close a match" setting.
const SENT_FLOOR = { wide: 50, balanced: 60, strict: 75 };
const sentFloor = (level) => SENT_FLOOR[level] || SENT_FLOOR.balanced;

module.exports = { scoreCV, rescoreCV, extractJDKeywords, computeScore, hasTerm, matchFit, MATCH_LEVELS, SENT_FLOOR, sentFloor };
