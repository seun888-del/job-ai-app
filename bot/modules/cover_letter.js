const { llmAvailable, llmChat } = require('../../src/services/llm');
const cfg = require('../config');

const AVAILABILITY_LABEL = {
  'immediately': null,
  '1week':   '1 week notice',
  '2weeks':  '2 weeks notice',
  '1month':  '1 month notice',
  '2months': '2 months notice',
  '3months': '3 months notice',
};

async function generateCoverLetter(jobTitle, company, jobDescription, cvText) {
  if (!await llmAvailable()) return null;

  const { firstName, lastName, yearsExperience, availability, experienceLevel } = cfg.APPLICANT;
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || 'The applicant';
  const yearsText = yearsExperience > 0 ? `${yearsExperience} years of` : 'extensive';
  const levelNote = experienceLevel ? ` (${experienceLevel} level)` : '';
  const availNote = AVAILABILITY_LABEL[availability || 'immediately']
    ? `\nNOTICE PERIOD: ${AVAILABILITY_LABEL[availability]}`
    : '';

  const jdExcerpt = (jobDescription || '').substring(0, 2500);
  const cvExcerpt = (cvText || '').substring(0, 2000);

  const prompt = `Write a targeted, high-impact cover letter that will get this candidate an interview.

CANDIDATE: ${fullName} — ${yearsText} experience${levelNote}${availNote}
ROLE: ${jobTitle}
COMPANY: ${company || 'this company'}

JOB DESCRIPTION:
${jdExcerpt}

CANDIDATE CV:
${cvExcerpt}

─────────────────────────────────────────────

STEP 1 — Silently analyse (do not output this analysis):
• What are the 3 most important requirements in this JD?
• Which specific achievement or skill from the CV best addresses each requirement?
• What is one specific thing about this role or company that makes it genuinely compelling?

STEP 2 — Write the letter:

Write a 3-paragraph cover letter body ONLY (no date, no address, no "Dear Hiring Manager", no sign-off, no name).

PARAGRAPH 1 — HOOK (2–3 sentences):
Open with a confident statement that immediately connects the candidate's strongest relevant achievement to the role's single most critical requirement. Name the role and the company.

BANNED openers — if your first sentence starts with any of these, rewrite it:
❌ "I am writing to..."   ❌ "I would like to apply..."
❌ "I am interested in..."   ❌ "With X years of experience..."
❌ "As a..."   ❌ "I am excited to..."

PARAGRAPH 2 — EVIDENCE (3–5 sentences):
Cite 2–3 concrete, specific achievements from the CV that directly match what this JD is asking for. For each, connect it explicitly to the employer's stated requirement. Include numbers and metrics where the CV has them. Do NOT use generic statements.

PARAGRAPH 3 — CLOSE (2 sentences):
Express genuine enthusiasm for this specific role and company — not "any opportunity". State readiness for interview.

─────────────────────────────────────────────
RULES — non-negotiable:
- Maximum 220 words total
- Every sentence must be specific to this job — cut anything that could apply to any application
- BANNED words/phrases: "passionate", "team player", "results-driven", "hard-working", "go-getter", "leveraging", "spearheading", "seamlessly", "proactive", "dynamic", "I am a fast learner", "hit the ground running", "self-motivated"
- Do NOT invent experience not in the CV
- Do NOT mention salary
- Write as a confident professional — not as someone begging for a chance
- Return ONLY the 3 paragraph body — nothing else, no labels, no headings`;

  try {
    const letter = await llmChat(prompt);
    return (letter || '').trim() || null;
  } catch {
    return null;
  }
}

module.exports = { generateCoverLetter };
