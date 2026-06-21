// Local ATS keyword scorer — replaces Jobscan website entirely.
// Uses an LLM to extract required keywords from a JD, then deterministically
// checks how many appear in the CV. No browser, no external service.

const { llmAvailable, llmChat } = require('../../src/services/llm');

// Use the LLM to extract required keywords/skills from a job description.
// Returns a flat array of short keyword strings.
async function extractJDKeywords(jdText) {
  const prompt = `Extract the key required skills, tools, technologies, and qualifications from this job description.
Return ONLY a valid JSON array of short keyword strings. No explanation, no commentary — just the array.
Example output: ["Active Directory", "ITIL", "Windows 10", "Office 365", "ticketing system", "TCP/IP"]

JOB DESCRIPTION:
${jdText.substring(0, 3000)}`;

  const response = await llmChat(prompt);

  // Pull the first JSON array out of the response
  const jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return [];

  try {
    const raw = JSON.parse(jsonMatch[0]);
    return raw
      .filter(k => typeof k === 'string')
      .map(k => k.trim())
      .filter(k => k.length >= 2 && k.length <= 60);
  } catch {
    return [];
  }
}

// Deterministically check how many keywords from the list appear in cvText.
// Returns score (0-100), found array, and missing array.
function computeScore(cvText, keywords) {
  if (!keywords.length) return { score: 0, found: [], missing: [] };
  const cvLower = cvText.toLowerCase();
  const found   = [];
  const missing = [];
  for (const kw of keywords) {
    (cvLower.includes(kw.toLowerCase()) ? found : missing).push(kw);
  }
  return {
    score:   Math.round((found.length / keywords.length) * 100),
    found,
    missing,
  };
}

// Full score: extract keywords from JD via the LLM, then score CV against them.
// One LLM call per CV; subsequent boost iterations use rescoreCV (instant, no LLM).
// Falls back to score=85 / no missing keywords when the LLM is unavailable.
async function scoreCV(cvText, jdText) {
  if (!await llmAvailable()) {
    console.log('  [Scorer] AI scoring unavailable — fallback score 85');
    return { score: 85, missingKeywords: [], allKeywords: [] };
  }

  const keywords = await extractJDKeywords(jdText);
  if (!keywords.length) {
    console.log('  [Scorer] No keywords extracted — fallback score 85');
    return { score: 85, missingKeywords: [], allKeywords: [] };
  }

  const { score, found, missing } = computeScore(cvText, keywords);
  console.log(`  [Scorer] ${found.length}/${keywords.length} keywords matched → ${score}%`);
  if (missing.length) {
    const preview = missing.slice(0, 8).join(', ');
    console.log(`  [Scorer] Missing: ${preview}${missing.length > 8 ? '…' : ''}`);
  }

  return { score, missingKeywords: missing, allKeywords: keywords };
}

// Rescore after injecting keywords — deterministic, no LLM call.
// Uses the keyword list from the original scoreCV call.
function rescoreCV(cvText, allKeywords) {
  if (!allKeywords.length) return { score: 85, missingKeywords: [] };
  const { score, missing } = computeScore(cvText, allKeywords);
  console.log(`  [Scorer] Rescore → ${score}%`);
  return { score, missingKeywords: missing };
}

module.exports = { scoreCV, rescoreCV };
