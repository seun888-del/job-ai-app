const fs      = require("fs");
const path    = require("path");
const pdfParse = require("pdf-parse");

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
  return data.text;
}

// Prepare the output resume: copy selected PDF to output dir, rename it
function prepareResume(selectedCV, outputDir, filename) {
  const dest = path.join(outputDir, filename);
  fs.copyFileSync(selectedCV.path, dest);
  console.log(`  [Resume] Prepared: ${dest}`);
  return dest;
}

module.exports = { scoreCV, selectBestCV, extractPdfText, prepareResume };
