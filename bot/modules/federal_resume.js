/**
 * federal_resume.js
 * Turns a tailored structured CV into a federal resume for USAJOBS:
 *   - U.S. Letter, 2 pages at most (OPM rule, enforced on USAJOBS since 27 Sep 2025)
 *   - hours per week on every job, citizenship in the header
 *   - flags jobs whose dates lack a month (federal HR wants month and year)
 * Shared by the desktop app and the extension. Never invents facts: it only adds what the
 * user told us (hours, citizenship) and trims, it does not rewrite.
 */
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b|\b(0?[1-9]|1[0-2])\s*[\/.-]\s*(19|20)\d{2}\b/i;

function hoursText(h) {
  const n = parseInt(h, 10);
  return n > 0 && n <= 80 ? `${n} hours per week` : '';
}

/** Adds the federal details in place and returns the CV. */
function federalize(cv, { hoursPerWeek, usCitizen } = {}) {
  const hrs = hoursText(hoursPerWeek);
  for (const job of cv.experience || []) {
    if (!job || !hrs || /hours?\s*(per|\/|a)\s*week|hrs?\s*\/?\s*w/i.test(job.dates || '')) continue;
    job.dates = [String(job.dates || '').trim(), hrs].filter(Boolean).join('  |  ');
  }
  if (usCitizen === 'yes' && !/citizen/i.test(cv.contact || '')) cv.contact = [String(cv.contact || '').trim(), 'U.S. Citizen'].filter(Boolean).join('   |   ');
  return cv;
}

/** Jobs whose dates don't show a month, for the "check before you submit" note. */
function datesMissingMonths(cv) {
  return (cv.experience || []).filter((j) => j && j.title && !MONTH.test(String(j.dates || '').replace(/\d+\s*hours per week/i, ''))).map((j) => j.title.trim());
}

// Each step trims a little more until the resume fits on 2 pages.
const TRIMS = [
  (cv) => { cv.strengths = (cv.strengths || []).slice(0, 4); },
  (cv) => { for (const j of cv.experience || []) j.bullets = (j.bullets || []).slice(0, 5); },
  (cv) => { cv.strengths = []; },
  (cv) => { for (const j of cv.experience || []) j.bullets = (j.bullets || []).slice(0, 4); },
  (cv) => { (cv.experience || []).forEach((j, i) => { if (i >= 2) j.bullets = (j.bullets || []).slice(0, 2); }); },
  // Last resort: drop the oldest jobs.
  (cv) => { cv.experience = (cv.experience || []).slice(0, 6); },
  (cv) => { cv.experience = (cv.experience || []).slice(0, 5); cv.skills = (cv.skills || []).slice(0, 3); },
  (cv) => { cv.experience = (cv.experience || []).slice(0, 4); },
];

/**
 * Writes the federal resume PDF with writeStructuredPDF (passed in, so the extension can use its
 * own file system). Returns { pages, trimmed, missingMonths }.
 */
async function writeFederalPDF(cv, outputPath, writeStructuredPDF, opts = {}) {
  const work = JSON.parse(JSON.stringify(cv));
  federalize(work, opts);
  const pdfOpts = { ...(opts.pdfOptions || {}), size: 'LETTER', stats: {} };
  await writeStructuredPDF(work, outputPath, pdfOpts);
  let trimmed = 0;
  while (pdfOpts.stats.pages > 2 && trimmed < TRIMS.length) {
    TRIMS[trimmed++](work);
    await writeStructuredPDF(work, outputPath, pdfOpts);
  }
  return { pages: pdfOpts.stats.pages, trimmed, missingMonths: datesMissingMonths(work), cv: work };
}

module.exports = { federalize, datesMissingMonths, writeFederalPDF, hoursText };
