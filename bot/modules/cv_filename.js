/**
 * cv_filename.js
 * The file name employers see on a tailored CV (shared by the app and the extension).
 */
// The tailored CV is uploaded under its own file name, so that name is what the recruiter
// sees: First_Last_Job_Title_CV.pdf. Each job gets its own folder so names never collide.
function cvFileName(fullName, jobTitle) {
  const words = (s, n) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, n);
  // "Data Analyst (Remote) - £35k" -> "Data Analyst"
  const title = String(jobTitle || '').replace(/\(.*?\)|\[.*?\]/g, ' ').split(/\s[-|–—:]\s|,|\//)[0];
  const parts = [...words(fullName, 3), ...words(title, 5), 'CV'];
  return parts.join('_').substring(0, 90) + '.pdf';
}

// CVs tailored before this naming existed sit directly in saved_cvs as "Title_Company_87pct_date.pdf".
// Bots upload the file as named, so give those a clean copy before they are sent.
function uploadablePath(cvPath, fullName, jobTitle) {
  try {
    if (!cvPath || !/[\\/]saved_cvs[\\/][^\\/]+_\d+pct_\d{4}-\d\d-\d\d\.pdf$/i.test(cvPath)) return cvPath;
    const fs = require('fs'), path = require('path');
    if (!fs.existsSync(cvPath)) return cvPath;
    const dir = cvPath.replace(/\.pdf$/i, '');
    const out = path.join(dir, cvFileName(fullName, jobTitle));
    if (!fs.existsSync(out)) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(cvPath, out); }
    return out;
  } catch (_) { return cvPath; }
}

module.exports = { cvFileName, uploadablePath };
