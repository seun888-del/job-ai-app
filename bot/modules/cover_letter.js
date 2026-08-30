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

  const prompt = `Write a short, targeted cover letter that reads like it was written specifically for this job — not templated.

CANDIDATE: ${fullName} — ${yearsText} experience${levelNote}${availNote}
ROLE: ${jobTitle}
COMPANY: ${company || 'this company'}

JOB DESCRIPTION:
${jdExcerpt}

CANDIDATE CV:
${cvExcerpt}

─────────────────────────────────────────────
SILENT PRE-WORK (do not output):
1. What are the 2–3 most important requirements in the JD?
2. Which specific experience or achievement from the CV best proves each one?
3. What does the JD reveal about this company or role that makes it specific — a challenge they mention, a team they describe, a tool they emphasise?

─────────────────────────────────────────────
OUTPUT — 4 paragraphs, no headings, no labels, no sign-off, no "Dear Hiring Manager":

PARAGRAPH 1 — HOOK (2 sentences):
Sentence 1: name the role and company in a confident, specific opening — NOT "I am writing to apply". Lead with the candidate's most relevant strength or achievement connected to the role's #1 requirement.
Sentence 2: say one concrete thing about why this specific role or company — pulled from what the JD actually says (a challenge, a mission, a technology) — not generic enthusiasm.

PARAGRAPH 2 — MATCH (3 sentences):
Take the top 3 requirements from the JD. For each, write one sentence that maps it directly to a specific skill or experience from the CV. Be explicit, e.g. "Your need for X is matched by my Y". No vague claims.

PARAGRAPH 3 — EVIDENCE (2 sentences):
State one concrete, quantified achievement from the CV. Explain in one sentence exactly why it proves the candidate can do this job.

PARAGRAPH 4 — CLOSE (1 sentence only):
Genuine, specific enthusiasm for this role. End with a clear ask for the interview.

─────────────────────────────────────────────
HARD RULES:
- 230 words maximum total
- Never use em dashes (—) or en dashes (–) anywhere. Use commas or full stops instead; for a range write "to". They read as AI-written.
- Every sentence must be specific to THIS job. Cut anything that could appear in any other cover letter
- BANNED openers: "I am writing to", "I would like to apply", "I am interested in", "With X years", "As a", "I am excited to", "I am passionate"
- BANNED words: "passionate", "team player", "results-driven", "hard-working", "go-getter", "leveraging", "spearheading", "seamlessly", "proactive", "dynamic", "fast learner", "hit the ground running", "self-motivated"
- Do NOT invent experience not in the CV
- Do NOT mention salary
- Return ONLY the 4 paragraph body — nothing else`;

  try {
    const letter = await llmChat(prompt);
    const clean = sanitizeDashes((letter || '').trim());
    return clean || null;
  } catch {
    return null;
  }
}

// Safety net for the prompt's no-dash rule: strip any em/en dashes the model
// still emits. A dash between digits becomes "to" (a range); anywhere else it
// becomes a comma, then we tidy the spacing/doubles it leaves behind.
function sanitizeDashes(text) {
  return String(text)
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2')  // "2019 – 2022" -> "2019 to 2022"
    .replace(/\s*[—–]\s*/g, ', ')                // clause dash -> comma
    .replace(/\s+([,.;:])/g, '$1')               // no space before punctuation
    .replace(/,\s*,/g, ',')                       // collapse double commas
    .replace(/,\s*\./g, '.')                      // ", ." -> "."
    .trim();
}

module.exports = { generateCoverLetter };
