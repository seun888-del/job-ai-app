const fs       = require('fs');
const path     = require('path');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const { llmAvailable, llmChat } = require('./llm');
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

// Analyse a CV (PDF or docx): extract skill keywords and suggest job titles
async function analyzeCV(filePath) {
  let cvText;
  try {
    cvText = await extractCVText(filePath);
  } catch (err) {
    console.error('[CV Analyzer] CV extraction failed:', err.message);
    return { keywords: [], suggestedRoles: [] };
  }

  if (!await llmAvailable()) {
    console.log('[CV Analyzer] AI analysis unavailable — skipping');
    return { keywords: [], suggestedRoles: [] };
  }

  const prompt = `You are analysing a CV/resume to help configure an automated job search.

Based on the CV text below, return ONLY a valid JSON object with this exact shape:
{
  "keywords": ["short skill, tool, technology or qualification keywords found in the CV, max 25"],
  "suggested_roles": ["specific job titles this person is qualified to apply for, based on their actual experience, max 8"]
}

No explanation, no commentary — just the JSON object.

CV TEXT:
${cvText.substring(0, 6000)}`;

  try {
    const response = await llmChat(prompt, 180000);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { keywords: [], suggestedRoles: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter(k => typeof k === 'string').map(k => k.trim()).filter(k => k.length >= 2 && k.length <= 60)
      : [];
    const suggestedRoles = Array.isArray(parsed.suggested_roles)
      ? parsed.suggested_roles.filter(r => typeof r === 'string').map(r => r.trim()).filter(r => r.length >= 2 && r.length <= 60)
      : [];

    return { keywords, suggestedRoles };
  } catch (err) {
    console.error('[CV Analyzer] AI analysis failed:', err.message);
    return { keywords: [], suggestedRoles: [] };
  }
}

module.exports = { analyzeCV, extractPdfText };
