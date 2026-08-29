/**
 * relevance_gate.js
 * ─────────────────────────────────────────────────────────────────────────
 * A cheap, domain-AGNOSTIC guard that runs BEFORE the expensive CV tailoring.
 *
 * The keyword scorer can rate an off-target role highly because soft-skill
 * words (communication, customer service, documentation, stakeholder) overlap
 * between unrelated professions — e.g. an "Occupational Therapist" JD scored 85%
 * against an IT-support CV and got applied to. This gate asks the licensed LLM
 * whether the job is in the SAME occupation as the candidate's OWN target roles
 * (their configured search terms), so it works for any user's field — IT, nursing,
 * teaching, whatever they actually search for. It NEVER hardcodes a domain.
 *
 * Fail-OPEN: if the LLM is unavailable, errors, or is ambiguous, the job passes.
 * A relevance gate must never silently block every application on an outage.
 */

const { llmAvailable, llmChat } = require('../../src/services/llm');

// Returns { relevant: boolean, reason: string }. relevant:true means "apply".
async function isRelevantRole({ jobTitle, jdText, targetRoles }) {
  const roles = (targetRoles || []).filter(Boolean);
  // Can't judge a domain with no target roles → don't block.
  if (!roles.length) return { relevant: true, reason: 'no target roles configured' };
  if (!jobTitle || !jobTitle.trim()) return { relevant: true, reason: 'no job title' };

  let available = false;
  try { available = await llmAvailable(); } catch (_) { available = false; }
  if (!available) return { relevant: true, reason: 'LLM unavailable — fail open' };

  const jd = String(jdText || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const prompt = `A job seeker is applying only for roles in their own profession. Their target job titles are:
${roles.slice(0, 25).map(r => `- ${r}`).join('\n')}

Here is a job they were shown:
TITLE: ${jobTitle}
DESCRIPTION: ${jd}

Question: Is this job in the SAME occupation / professional field as the target job titles above?
Judge the actual profession, NOT shared generic skills (communication, customer service, teamwork, documentation exist in every field and do NOT make two jobs the same occupation).

Answer with EXACTLY one line, no other text:
RELEVANT: YES
or
RELEVANT: NO - <max 8 word reason>`;

  try {
    const out = String(await llmChat(prompt) || '');
    const m = out.match(/RELEVANT:\s*(YES|NO)\b[^\n]*/i);
    if (!m) return { relevant: true, reason: 'unparseable LLM reply — fail open' };
    if (/^NO/i.test(m[1])) {
      const reason = (m[0].replace(/RELEVANT:\s*NO\s*[-–—:]?\s*/i, '').trim() || 'different occupation').slice(0, 80);
      return { relevant: false, reason };
    }
    return { relevant: true, reason: 'same field' };
  } catch (err) {
    return { relevant: true, reason: `LLM error (${err.message}) — fail open` };
  }
}

module.exports = { isRelevantRole };
