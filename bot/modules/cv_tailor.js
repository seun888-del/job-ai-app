const { llmAvailable, llmChat } = require('../../src/services/llm');

// Section heading patterns that mark the end of a profile paragraph
const SECTION_RE = /\n([A-Z][A-Z\s&]{3,})\n/;

// Maps collapsed spaced-heading → readable heading with correct spacing
const SPACED_HEADING_MAP = {
  'PROFESSIONALPROFILE':          'PROFESSIONAL PROFILE',
  'PERSONALPROFILE':              'PERSONAL PROFILE',
  'CAREERPROFILE':                'CAREER PROFILE',
  'WORKEXPERIENCE':               'WORK EXPERIENCE',
  'KEYPROJECTS':                  'KEY PROJECTS',
  'TECHNICALSKILLS':              'TECHNICAL SKILLS',
  'KEYSKILLS':                    'KEY SKILLS',
  'EDUCATIONANDCERTIFICATIONS':   'EDUCATION AND CERTIFICATIONS',
  'EDUCATIONCERTIFICATIONS':      'EDUCATION & CERTIFICATIONS',
  'EDUCATION':                    'EDUCATION',
  'CERTIFICATIONS':               'CERTIFICATIONS',
  'ACHIEVEMENTS':                 'ACHIEVEMENTS',
  'PROFESSIONALSUMMARY':          'PROFESSIONAL SUMMARY',
  'CAREERSUMMARY':                'CAREER SUMMARY',
};

// Normalize spaced-letter headings that pdf-parse extracts from PDFs.
// ONLY modifies lines where every whitespace-separated token is a single uppercase letter.
// "P R O F E S S I O N A L   P R O F I L E" → "PROFESSIONAL PROFILE"
// Regular lines like "FEMI MERIT" or "Nine years of..." are untouched.
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

// Extract the subtitle (role title — second non-empty line) and professional profile text.
function extractParts(cvText) {
  const lines = cvText.split('\n');
  const nonEmpty = lines.map((l, i) => ({ text: l.trim(), idx: i })).filter(l => l.text);

  const subtitle = nonEmpty[1] ? nonEmpty[1].text : '';

  // Find the profile section heading — covers common CV heading variants
  const profileHeadingRe = /\b(PROFESSIONAL PROFILE|PERSONAL PROFILE|CAREER PROFILE|EXECUTIVE PROFILE|PROFESSIONAL SUMMARY|CAREER SUMMARY|EXECUTIVE SUMMARY|PERSONAL SUMMARY|PERSONAL STATEMENT|OBJECTIVE|ABOUT ME|SUMMARY|PROFILE)\b/i;
  let headingMatch = profileHeadingRe.exec(cvText);
  if (headingMatch) {
    console.log(`  [Tailor] Profile heading found: "${headingMatch[0]}"`);
  } else {
    console.log('  [Tailor] Could not locate profile section — skipping');
    return { subtitle, profile: '', profileStart: -1, profileEnd: -1 };
  }

  const afterHeading = cvText.slice(headingMatch.index + headingMatch[0].length);
  const nextSection = SECTION_RE.exec(afterHeading);
  const profileEnd = nextSection ? nextSection.index : Math.min(afterHeading.length, 1200);
  const profile = afterHeading.slice(0, profileEnd).trim();

  const absoluteStart = headingMatch.index + headingMatch[0].length;
  const absoluteEnd   = absoluteStart + profileEnd;

  return { subtitle, profile, absoluteStart, absoluteEnd };
}

// Extract a named section (e.g. WORK EXPERIENCE) and return its text + positions.
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

async function tailorCV(cvText, jobTitle, jobDescription) {
  // Normalize spaced-letter headings from PDF extraction — always run first, even if AI tailoring is unavailable
  cvText = normalizeSpacedLetters(cvText);

  if (!await llmAvailable()) {
    console.log('  [Tailor] AI tailoring unavailable — skipping');
    return cvText;
  }

  const { subtitle, profile, absoluteStart, absoluteEnd } = extractParts(cvText);
  if (!profile) {
    console.log('  [Tailor] Could not locate profile section — skipping');
    return cvText;
  }

  const jdExcerpt = jobDescription.substring(0, 2000);

  // ── Step 1: Tailor subtitle + professional profile ───────────────────────
  const profilePrompt = `You are rewriting two parts of a CV to better match a specific job application.

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
- Do not mention the company name in the profile
- The subtitle should mirror the job title terminology closely
- The profile must weave in the most important keywords from the job description naturally`;

  let tailored = cvText;

  try {
    const profileText   = await llmChat(profilePrompt);
    const subtitleMatch = profileText.match(/^SUBTITLE:\s*(.+)/m);
    const profileMatch  = profileText.match(/^PROFILE:\s*([\s\S]+)/m);

    if (subtitleMatch && profileMatch) {
      const newSubtitle = subtitleMatch[1].trim();
      let   newProfile  = profileMatch[1].trim();
      newProfile = newProfile.replace(/[.,]?\s*Conversational German\.?/gi, '').trim();
      newProfile = newProfile.replace(/,?\s*German\s*\(conversational\)\.?/gi, '').trim();

      tailored = cvText.replace(subtitle, newSubtitle);

      const updated   = extractParts(tailored);
      const profStart = updated.absoluteStart;
      const profEnd   = updated.absoluteEnd;

      if (profStart != null && profStart >= 0) {
        tailored = tailored.slice(0, profStart) + '\n' + newProfile + '\n' + tailored.slice(profEnd);
        console.log(`  [Tailor] ✓ Subtitle: "${newSubtitle.substring(0, 60)}"`);
        console.log(`  [Tailor] ✓ Profile rewritten (${newProfile.length} chars)`);
      }
    } else {
      console.log('  [Tailor] Unexpected profile response format — keeping original');
    }
  } catch (err) {
    console.log(`  [Tailor] Profile error — keeping original: ${err.message}`);
  }

  // ── Step 2: Tailor work experience bullet points ─────────────────────────
  try {
    const workSection = extractSection(tailored, /\bWORK EXPERIENCE\b/i);
    if (!workSection || !workSection.text) {
      console.log('  [Tailor] No WORK EXPERIENCE section found — skipping bullet tailoring');
      return tailored;
    }

    const workExcerpt = workSection.text.substring(0, 3000);

    const bulletPrompt = `You are tailoring the Work Experience bullet points of a CV for a specific job application.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION (excerpt):
${jdExcerpt}

CURRENT WORK EXPERIENCE SECTION:
${workExcerpt}

Rewrite the bullet points to better emphasise skills and experience relevant to this job.

Rules:
- Keep EXACTLY the same job titles, companies, and dates — do not change these lines at all
- Keep the same number of bullet points per role — do not add or remove bullets
- Only use experience and achievements already described — do not invent anything new
- Rephrase bullet points to front-load the most relevant keywords from the job description
- Focus most on the most recent role (listed first)
- Maintain the same writing style — concise, factual, consistent tense
- Return ONLY the rewritten work experience section text with no extra commentary`;

    const newWorkText = await llmChat(bulletPrompt);
    if (!newWorkText) {
      console.log('  [Tailor] Empty bullet response — keeping original bullets');
      return tailored;
    }

    const workPos = extractSection(tailored, /\bWORK EXPERIENCE\b/i);
    if (!workPos) {
      console.log('  [Tailor] Could not re-locate WORK EXPERIENCE — keeping original bullets');
      return tailored;
    }

    tailored = tailored.slice(0, workPos.absoluteStart) + '\n' + newWorkText + '\n' + tailored.slice(workPos.absoluteEnd);
    console.log(`  [Tailor] ✓ Work experience bullets tailored (${newWorkText.length} chars)`);

  } catch (err) {
    console.log(`  [Tailor] Bullet error — keeping original bullets: ${err.message}`);
  }

  return tailored;
}

module.exports = { tailorCV };
