const { llmAvailable, llmChat } = require('../../src/services/llm');
const cfg = require('../config');

async function generateCoverLetter(jobTitle, company, jobDescription, cvText) {
  if (!await llmAvailable()) return null;

  const { fullName, email, yearsExperience, location } = cfg.APPLICANT;
  const yearsText = yearsExperience > 0 ? `${yearsExperience} years of` : 'extensive';
  const jdExcerpt = (jobDescription || '').substring(0, 2000);
  const cvExcerpt = (cvText || '').substring(0, 2000);

  const prompt = `Write a concise, professional cover letter for a job application.

APPLICANT: ${fullName || 'The applicant'}
ROLE APPLYING FOR: ${jobTitle}
COMPANY: ${company}
JOB DESCRIPTION (excerpt):
${jdExcerpt}

CV SUMMARY (excerpt):
${cvExcerpt}

Write a 3-paragraph cover letter (no address header, no date, no sign-off line — body paragraphs only):
- Paragraph 1: Express interest in the specific role and company. Mention the job title.
- Paragraph 2: Highlight 2-3 specific skills or achievements from the CV that directly match the job description. Be concrete, not generic.
- Paragraph 3: Brief closing — enthusiasm to discuss further, available for interview.

Rules:
- Do NOT invent experience not in the CV
- Do NOT mention salary
- Keep it under 200 words total
- Write in first person, professional tone
- Return ONLY the cover letter body paragraphs, nothing else`;

  try {
    const letter = await llmChat(prompt);
    return (letter || '').trim() || null;
  } catch {
    return null;
  }
}

module.exports = { generateCoverLetter };
