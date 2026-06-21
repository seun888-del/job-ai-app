const fs = require('fs');
const pdfParse = require('pdf-parse');
const { llmAvailable, llmChat } = require('./llm');

async function extractPdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

// Analyse a CV PDF with Ollama: extract skill keywords and suggest job titles
// this CV is a good match for. Falls back to empty arrays if Ollama is
// unavailable or the response can't be parsed.
async function analyzeCV(filePath) {
  let cvText;
  try {
    cvText = await extractPdfText(filePath);
  } catch (err) {
    console.error('[CV Analyzer] PDF extraction failed:', err.message);
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
