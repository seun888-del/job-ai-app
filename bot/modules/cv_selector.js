const fs      = require("fs");
const path    = require("path");
const pdfParse = require("pdf-parse");
const mammoth  = require("mammoth");
const { sanitizeCVText } = require("./cv_text_sanitizer");

// Score a CV against a job description using keyword frequency
function scoreCV(cv, jdText) {
  if (!jdText) return 0;
  const jd = jdText.toLowerCase();
  let score = 0;
  for (const keyword of cv.keywords) {
    const regex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = (jd.match(regex) || []).length;
    score += matches;
  }
  return score;
}

// Select the best CV for a given job description
function selectBestCV(jdText, cvProfiles) {
  let best = null;
  let bestScore = -1;

  for (const cv of cvProfiles) {
    const s = scoreCV(cv, jdText);
    console.log(`  [CV Match] ${cv.name}: ${s} keyword hits`);
    if (s > bestScore) {
      bestScore = s;
      best = cv;
    }
  }

  console.log(`  [CV Selected] ${best.name} (score: ${bestScore})`);
  return best;
}

// Extract plain text from a PDF file
async function extractPdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data   = await pdfParse(buffer);
  // Strip undecodable glyph garbage (e.g. dates in a subsetted font with no
  // ToUnicode map) before it can reach the tailored CV. See cv_text_sanitizer.
  return sanitizeCVText(data.text);
}

// Extract plain text from a .docx file preserving bullet structure as • markers
async function extractDocxText(filePath) {
  const result = await mammoth.convertToHtml({ path: filePath });
  let html = result.value;
  // Convert list items to • bullets before stripping tags
  html = html.replace(/<li>/gi, '\n• ').replace(/<\/li>/gi, '');
  html = html.replace(/<ul[^>]*>/gi, '\n').replace(/<\/ul>/gi, '\n');
  html = html.replace(/<ol[^>]*>/gi, '\n').replace(/<\/ol>/gi, '\n');
  // Paragraph breaks
  html = html.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  // Strip remaining HTML tags
  html = html.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  html = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  // Normalise whitespace
  html = html.replace(/\n{3,}/g, '\n\n').trim();
  return sanitizeCVText(html);
}

// Extract text from either PDF or docx based on file extension
async function extractCVText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx' || ext === '.doc') return extractDocxText(filePath);
  return extractPdfText(filePath);
}

// Prepare the output resume: copy selected PDF to output dir, rename it
function prepareResume(selectedCV, outputDir, filename) {
  const dest = path.join(outputDir, filename);
  fs.copyFileSync(selectedCV.path, dest);
  console.log(`  [Resume] Prepared: ${dest}`);
  return dest;
}

module.exports = { scoreCV, selectBestCV, extractPdfText, extractDocxText, extractCVText, prepareResume };
