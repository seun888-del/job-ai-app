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
  if (hasTerm(cvLower, kw.term)) return true;
  for (const a of (kw.alts || [])) if (hasTerm(cvLower, a)) return true;
  return false;
}

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
async function extractJDKeywords(jdText) {
  const prompt = `Extract the key required skills, tools, technologies and qualifications from this job description.

For EACH requirement return an object with:
- "term": the skill/tool/qualification as written in the advert
- "essential": true if it is a must-have / mandatory requirement, false if merely desirable
- "alts": accurate equivalents that mean the SAME thing — acronym expansions, the acronym itself, and common synonyms. Include the acronym AND its full form as a pair (e.g. term "user acceptance testing" -> alts ["UAT"]; term "AD" -> alts ["Active Directory"]). Do NOT invent unrelated terms.

Return ONLY a valid JSON array of such objects, 10 to 20 items, most important first. No commentary.
Example:
[{"term":"Active Directory","essential":true,"alts":["AD","Entra ID","Azure AD"]},{"term":"user acceptance testing","essential":false,"alts":["UAT"]},{"term":"ITIL","essential":true,"alts":["IT service management","ITSM"]}]

JOB DESCRIPTION:
${jdText.substring(0, 3000)}`;

  const response = await llmChat(prompt);

  // Pull the first JSON array out of the response (greedy so nested objects survive)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const raw = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(raw)) return [];
    return normaliseKeywords(raw);
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
// Falls back to score=85 / no missing keywords when the LLM is unavailable.
async function scoreCV(cvText, jdText) {
  // Try the real LLM call and only fall back on an ACTUAL failure. Do NOT
  // pre-gate on llmAvailable()'s /health ping — it flakes (e.g. during a backend
  // redeploy) while the real /v1/chat call works fine, and pre-gating would then
  // silently score EVERY job 85, defeating the relevance gate.
  let keywords;
  try {
    keywords = await extractJDKeywords(jdText);
  } catch (err) {
    console.log(`  [Scorer] AI scoring unavailable (${err.message}) — fallback score 85`);
    return { score: 85, missingKeywords: [], allKeywords: [] };
  }
  if (!keywords.length) {
    console.log('  [Scorer] No keywords extracted — fallback score 85');
    return { score: 85, missingKeywords: [], allKeywords: [] };
  }

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

module.exports = { scoreCV, rescoreCV, extractJDKeywords, computeScore, hasTerm };
