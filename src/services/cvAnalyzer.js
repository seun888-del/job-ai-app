const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const { readCvProfile } = require('./cvProfile');
const { sanitizeCVText } = require('../../bot/modules/cv_text_sanitizer');

async function extractPdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  // Strip undecodable glyph garbage before analysis. See cv_text_sanitizer.
  return sanitizeCVText(data.text);
}

async function extractCVText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx' || ext === '.doc') {
    const result = await mammoth.extractRawText({ path: filePath });
    return sanitizeCVText(result.value);
  }
  return extractPdfText(filePath);
}

// Analyse a CV (PDF or docx): one AI read returns skill keywords, suggested job
// titles and the person's details (name, email, phone...) for the profile.
async function analyzeCV(filePath) {
  const empty = { keywords: [], suggestedRoles: [], profile: null };
  let cvText;
  try {
    cvText = await extractCVText(filePath);
  } catch (err) {
    console.error('[CV Analyzer] CV extraction failed:', err.message);
    return empty;
  }

  try {
    const p = await readCvProfile(cvText);
    return { keywords: p.keywords, suggestedRoles: p.roles, profile: p };
  } catch (err) {
    console.error('[CV Analyzer] AI analysis failed:', err.message);
    return empty;
  }
}

module.exports = { analyzeCV, extractPdfText };
