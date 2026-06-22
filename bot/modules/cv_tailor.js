const { llmAvailable, llmChat } = require('../../src/services/llm');

// Finds where the next ALL-CAPS section heading starts (marks end of current section)
const SECTION_RE = /\n([A-Z][A-Z\s&]{3,})\n/;

// Work experience — covers all common heading variants
const WORK_RE = /\b(WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|EMPLOYMENT HISTORY|EMPLOYMENT EXPERIENCE)\b/i;

// Skills — covers all common heading variants
const SKILLS_RE = /\b(TECHNICAL SKILLS|KEY SKILLS|CORE SKILLS|CORE COMPETENCIES|PROFESSIONAL SKILLS|IT SKILLS|SKILLS)\b/i;

const SPACED_HEADING_MAP = {
  'PROFESSIONALPROFILE':          'PROFESSIONAL PROFILE',
  'PERSONALPROFILE':              'PERSONAL PROFILE',
  'CAREERPROFILE':                'CAREER PROFILE',
  'WORKEXPERIENCE':               'WORK EXPERIENCE',
  'PROFESSIONALEXPERIENCE':       'PROFESSIONAL EXPERIENCE',
  'EMPLOYMENTHISTORY':            'EMPLOYMENT HISTORY',
  'KEYPROJECTS':                  'KEY PROJECTS',
  'TECHNICALSKILLS':              'TECHNICAL SKILLS',
  'KEYSKILLS':                    'KEY SKILLS',
  'CORESKILLS':                   'CORE SKILLS',
  'CORECOMPETENCIES':             'CORE COMPETENCIES',
  'EDUCATIONANDCERTIFICATIONS':   'EDUCATION AND CERTIFICATIONS',
  'EDUCATIONCERTIFICATIONS':      'EDUCATION & CERTIFICATIONS',
  'EDUCATION':                    'EDUCATION',
  'CERTIFICATIONS':               'CERTIFICATIONS',
  'ACHIEVEMENTS':                 'ACHIEVEMENTS',
  'PROFESSIONALSUMMARY':          'PROFESSIONAL SUMMARY',
  'CAREERSUMMARY':                'CAREER SUMMARY',
};

function normalizeSpacedLetters(text) {
  return text.split('\n').map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4 && parts.every(p => /^[A-Z]$/.test(p))) {
      const collapsed = parts.join('');
      return SPACED_HEADING_MAP[collapsed] || collapsed;
    }
    return line;
  }).join('\n');
}

function extractParts(cvText) {
  const lines = cvText.split('\n');
  const nonEmpty = lines.map((l, i) => ({ text: l.trim(), idx: i })).filter(l => l.text);
  const subtitle = nonEmpty[1] ? nonEmpty[1].text : '';

  const profileHeadingRe = /\b(PROFESSIONAL PROFILE|PERSONAL PROFILE|CAREER PROFILE|EXECUTIVE PROFILE|PROFESSIONAL SUMMARY|CAREER SUMMARY|EXECUTIVE SUMMARY|PERSONAL SUMMARY|PERSONAL STATEMENT|OBJECTIVE|ABOUT ME|SUMMARY|PROFILE)\b/i;
  const headingMatch = profileHeadingRe.exec(cvText);
  if (headingMatch) {
    console.log(`  [Tailor] Profile heading: "${headingMatch[0]}"`);
  } else {
    console.log('  [Tailor] No profile section found — skipping Step 1');
    return { subtitle, profile: '', profileStart: -1, profileEnd: -1 };
  }

  const afterHeading = cvText.slice(headingMatch.index + headingMatch[0].length);
  const nextSection  = SECTION_RE.exec(afterHeading);
  const profileEnd   = nextSection ? nextSection.index : Math.min(afterHeading.length, 1200);
  const profile      = afterHeading.slice(0, profileEnd).trim();
  const absoluteStart = headingMatch.index + headingMatch[0].length;
  const absoluteEnd   = absoluteStart + profileEnd;

  return { subtitle, profile, absoluteStart, absoluteEnd };
}

function extractSection(cvText, headingPattern) {
  const match = headingPattern.exec(cvText);
  if (!match) return null;
  const afterHeading = cvText.slice(match.index + match[0].length);
  const nextSection  = SECTION_RE.exec(afterHeading);
  const sectionEnd   = nextSection ? nextSection.index : afterHeading.length;
  return {
    absoluteStart: match.index + match[0].length,
    absoluteEnd:   match.index + match[0].length + sectionEnd,
    text:          afterHeading.slice(0, sectionEnd).trim(),
  };
}

// ── Step 1: Subtitle + Professional Profile ──────────────────────────────────

async function _tailorProfile(cvText, jobTitle, jdExcerpt) {
  const { subtitle, profile, absoluteStart, absoluteEnd } = extractParts(cvText);
  if (!profile) return cvText;

  const prompt = `You are rewriting two parts of a CV to better match a specific job application.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION:
${jdExcerpt}

CURRENT CV SUBTITLE (role title shown under the person's name):
${subtitle}

CURRENT PROFESSIONAL PROFILE:
${profile}

Rewrite both parts so they feel written specifically for this job. Respond in EXACTLY this format with no other text:

SUBTITLE: [one-line role title that reflects the job being applied to]
PROFILE: [3-5 sentence professional profile paragraph tailored to this specific role]

Rules:
- Only use skills and experience that appear in the original profile — do not invent anything
- Do not change writing style or tone — keep it professional and factual
- Do not mention the company name
- Mirror the job title terminology closely in the subtitle
- Weave the most important JD keywords naturally into the profile`;

  try {
    const profileText   = await llmChat(prompt);
    const subtitleMatch = profileText.match(/^SUBTITLE:\s*(.+)/m);
    const profileMatch  = profileText.match(/^PROFILE:\s*([\s\S]+)/m);

    if (subtitleMatch && profileMatch) {
      let newSubtitle = subtitleMatch[1].trim();
      let newProfile  = profileMatch[1].trim();
      newProfile = newProfile.replace(/[.,]?\s*Conversational German\.?/gi, '').trim();
      newProfile = newProfile.replace(/,?\s*German\s*\(conversational\)\.?/gi, '').trim();

      let tailored = cvText.replace(subtitle, newSubtitle);
      const updated = extractParts(tailored);
      if (updated.absoluteStart != null && updated.absoluteStart >= 0) {
        tailored = tailored.slice(0, updated.absoluteStart) + '\n' + newProfile + '\n' + tailored.slice(updated.absoluteEnd);
        console.log(`  [Tailor] ✓ Profile → "${newSubtitle.substring(0, 55)}"`);
        return tailored;
      }
    } else {
      console.log('  [Tailor] Unexpected profile format — keeping original');
    }
  } catch (err) {
    console.log(`  [Tailor] Profile error: ${err.message}`);
  }
  return cvText;
}

// ── Step 2: Work Experience Bullets ─────────────────────────────────────────

async function _tailorBullets(cvText, jobTitle, jdExcerpt) {
  const workSection = extractSection(cvText, WORK_RE);
  if (!workSection || !workSection.text) {
    console.log('  [Tailor] No work experience section — skipping Step 2');
    return cvText;
  }

  const prompt = `You are tailoring Work Experience bullet points to a specific job application.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION:
${jdExcerpt}

CURRENT WORK EXPERIENCE:
${workSection.text.substring(0, 3000)}

Rewrite bullet points to emphasise skills relevant to this job.

Rules:
- Keep EXACTLY the same job titles, companies, and dates — do not change these
- Same number of bullets per role — do not add or remove
- Only use experience already described — do not invent
- Front-load the most relevant JD keywords in each bullet
- Focus most on the most recent role
- Consistent professional tone and tense
- Return ONLY the rewritten work experience section text, no commentary`;

  try {
    const result = await llmChat(prompt);
    if (!result) return cvText;
    const pos = extractSection(cvText, WORK_RE);
    if (!pos) return cvText;
    const tailored = cvText.slice(0, pos.absoluteStart) + '\n' + result.trim() + '\n' + cvText.slice(pos.absoluteEnd);
    console.log(`  [Tailor] ✓ Bullets tailored (${result.length} chars)`);
    return tailored;
  } catch (err) {
    console.log(`  [Tailor] Bullets error: ${err.message}`);
    return cvText;
  }
}

// ── Step 3: Skills Section Rebuild ──────────────────────────────────────────

async function _tailorSkills(cvText, jobTitle, jdExcerpt) {
  const skillsSection = extractSection(cvText, SKILLS_RE);
  if (!skillsSection || skillsSection.text.trim().length < 5) {
    console.log('  [Tailor] No skills section — skipping Step 3');
    return cvText;
  }

  const workSection   = extractSection(cvText, WORK_RE);
  const workContext   = workSection ? workSection.text.substring(0, 700) : '';

  const prompt = `You are rebuilding the Skills section of a CV to maximise match with a specific job.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION:
${jdExcerpt}

WORK EXPERIENCE (shows what the person actually knows):
${workContext}

CURRENT SKILLS SECTION:
${skillsSection.text}

Reconstruct the skills to:
1. Lead with the 6-10 skills the JD EXPLICITLY requires — use the EXACT wording from the JD
2. Keep all existing skills that are relevant to this role
3. Add skills clearly implied by the work experience that the JD specifically asks for
4. Remove or deprioritise skills unrelated to this job
5. Preserve the original formatting exactly (comma-separated, grouped categories, etc.)

Return ONLY the reconstructed skills content — no section heading, no commentary.`;

  try {
    const result = await llmChat(prompt);
    if (!result || result.trim().length < 5) return cvText;
    const pos = extractSection(cvText, SKILLS_RE);
    if (!pos) return cvText;
    const tailored = cvText.slice(0, pos.absoluteStart) + '\n' + result.trim() + '\n' + cvText.slice(pos.absoluteEnd);
    console.log('  [Tailor] ✓ Skills section rebuilt with JD-exact terminology');
    return tailored;
  } catch (err) {
    console.log(`  [Tailor] Skills error: ${err.message}`);
    return cvText;
  }
}

// ── Step 4: Quantify Achievements ───────────────────────────────────────────

async function _quantifyBullets(cvText, jobTitle) {
  const workSection = extractSection(cvText, WORK_RE);
  if (!workSection || workSection.text.trim().length < 20) return cvText;

  const workExcerpt = workSection.text.substring(0, 3000);

  const prompt = `Add specific numbers and metrics to unquantified bullet points in this CV Work Experience section.

ROLE BEING APPLIED FOR: ${jobTitle}

WORK EXPERIENCE:
${workExcerpt}

For each bullet WITHOUT a specific number or metric, add a realistic, conservative figure.

Examples of good quantification:
- "Provided IT support to users" → "Provided IT support to 150+ users across 2 sites"
- "Resolved help desk tickets" → "Resolved 40+ help desk tickets daily, maintaining 95% SLA compliance"
- "Managed a team" → "Led a team of 5 technicians"
- "Configured workstations" → "Configured and deployed 80+ Windows workstations"
- "Reduced downtime" → "Reduced system downtime by 30% through proactive monitoring"
- "Trained staff" → "Trained 20+ staff members on new systems and procedures"
- "Managed projects" → "Delivered 8 infrastructure projects on time and within budget"

Rules:
- Numbers must be plausible and conservative for the role seniority shown
- Do NOT change bullets that already have specific numbers or percentages
- Do NOT change job titles, company names, or dates
- Keep the same writing style and tense
- Return ONLY the rewritten work experience content — no heading, no commentary`;

  try {
    const result = await llmChat(prompt);
    if (!result || result.trim().length < workExcerpt.length * 0.3) return cvText;
    const pos = extractSection(cvText, WORK_RE);
    if (!pos) return cvText;
    const tailored = cvText.slice(0, pos.absoluteStart) + '\n' + result.trim() + '\n' + cvText.slice(pos.absoluteEnd);
    console.log('  [Tailor] ✓ Achievements quantified with metrics');
    return tailored;
  } catch (err) {
    console.log(`  [Tailor] Quantification error: ${err.message}`);
    return cvText;
  }
}

// ── Main tailorCV (4 steps) ──────────────────────────────────────────────────

async function tailorCV(cvText, jobTitle, jobDescription) {
  cvText = normalizeSpacedLetters(cvText);

  if (!await llmAvailable()) {
    console.log('  [Tailor] AI unavailable — skipping all tailoring');
    return cvText;
  }

  const jdExcerpt = jobDescription.substring(0, 2000);

  let tailored = cvText;

  console.log('  [Tailor] Step 1: Profile + subtitle...');
  tailored = await _tailorProfile(tailored, jobTitle, jdExcerpt);

  console.log('  [Tailor] Step 2: Work experience bullets...');
  tailored = await _tailorBullets(tailored, jobTitle, jdExcerpt);

  console.log('  [Tailor] Step 3: Skills section rebuild...');
  tailored = await _tailorSkills(tailored, jobTitle, jdExcerpt);

  console.log('  [Tailor] Step 4: Quantifying achievements...');
  tailored = await _quantifyBullets(tailored, jobTitle);

  return tailored;
}

// ── Inline keyword weaving (called by bot_scorer after initial scoring) ───────
// Weaves missing JD keywords naturally into bullets and skills — no crude addendum.

async function weaveKeywords(cvText, missingKeywords, jdText) {
  if (!missingKeywords || !missingKeywords.length || !await llmAvailable()) return cvText;

  const meaningful = missingKeywords
    .filter(k => typeof k === 'string' && k.trim().length >= 2 && k.trim().length <= 60 && !k.includes('?') && !k.includes('|'))
    .slice(0, 12);

  if (!meaningful.length) return cvText;

  const prompt = `Improve this CV by weaving missing keywords naturally into the existing content.

KEYWORDS TO INCORPORATE:
${meaningful.join(', ')}

CURRENT CV:
${cvText.substring(0, 4000)}

JOB CONTEXT:
${jdText.substring(0, 600)}

Instructions:
- Modify bullet points and the skills section to naturally include these keywords
- Do NOT change job titles, company names, dates, or section headings
- Weave keywords into existing sentences — do not just list them
- Only incorporate keywords the person demonstrably has based on their existing experience
- For specific tools or certifications that genuinely cannot fit in bullets, add to the skills section
- Return the COMPLETE CV with all sections intact — nothing removed
- No commentary or preamble — return only the CV text`;

  try {
    const result = await llmChat(prompt);
    if (result && result.length > cvText.length * 0.4) {
      console.log(`  [Tailor] ✓ ${meaningful.length} missing keywords woven inline`);
      return result.trim();
    }
  } catch (err) {
    console.log(`  [Tailor] Keyword weave error: ${err.message}`);
  }
  return cvText;
}

module.exports = { tailorCV, weaveKeywords };
