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

// NHS "Supporting information" statement for a Trac application. NHS shortlisting scores
// candidates line by line against the PERSON SPECIFICATION (essential, then desirable
// criteria), so this is written to evidence those criteria, not as a sales-style letter.
async function generateSupportingStatement(jobTitle, employer, jobDescription, cvText) {
  if (!await llmAvailable()) return null;
  // Person-spec driven statement (vacancy map -> evidence map -> draft -> audit). Falls back
  // to the simple one-shot format below if the advert can't be mapped.
  try {
    const s = await require('./nhs_statement').generateNhsStatement(jobTitle, employer, jobDescription, cvText);
    if (s) return s;
  } catch (e) { console.log('  [Statement] structured draft failed: ' + e.message); }

  const { firstName, lastName } = cfg.APPLICANT;
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'The applicant';
  // The person specification usually sits near the END of an NHS advert, so give the
  // model more of the advert than a normal cover letter gets.
  const jd = String(jobDescription || '');
  const specAt = jd.search(/person specification|essential criteria|essential\s*[:\n]/i);
  const jdExcerpt = specAt > 1500 ? (jd.slice(0, 1500) + '\n...\n' + jd.slice(specAt, specAt + 4500)) : jd.slice(0, 6000);
  const cvExcerpt = String(cvText || '').slice(0, 4000);

  const prompt = `Write the "Supporting information" section of an NHS job application on Trac.

CANDIDATE: ${fullName}
ROLE: ${jobTitle}
EMPLOYER: ${employer || 'the Trust'}

JOB ADVERT (includes the person specification):
${jdExcerpt}

CANDIDATE CV:
${cvExcerpt}

─────────────────────────────────────────────
HOW NHS SHORTLISTING WORKS: the panel ticks each person specification criterion (essential first, then desirable) against what the candidate wrote. Anything not clearly evidenced scores zero.

SILENT PRE-WORK (do not output): list the essential and desirable criteria from the person specification. For each, find the specific CV experience that proves it. Skip criteria the CV cannot support rather than inventing anything.

OUTPUT:
- Open with 2 sentences: why this role at this employer, and the candidate's most relevant strength.
- Then work through the criteria IN THE ORDER the person specification lists them, essential first. Give each one a short paragraph that names the requirement in plain words and proves it with a concrete example from the CV (what the candidate did, the scale, the result).
- Include one sentence linking the candidate's way of working to the NHS values (working together for patients, respect and dignity, commitment to quality of care, compassion, improving lives, everyone counts), grounded in something real from the CV.
- Close with 1 sentence on availability and enthusiasm for the role.

HARD RULES:
- 350 to 550 words, plain paragraphs, no headings, no bullet points, no sign-off
- Never use em dashes (—) or en dashes (–); use commas or full stops, and "to" for ranges
- Do NOT invent qualifications, registrations or experience that are not in the CV
- BANNED words: "passionate", "team player", "results-driven", "hard-working", "leveraging", "spearheading", "seamlessly", "dynamic", "self-motivated"
- Write in the first person, British English
- Return ONLY the statement text`;

  try {
    const text = await llmChat(prompt);
    const clean = sanitizeDashes((text || '').trim());
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

module.exports = { generateCoverLetter, generateSupportingStatement };
