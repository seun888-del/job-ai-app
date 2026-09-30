// Browser version of bot/modules/cv_validate.js: checks a CV file in the in-browser file system
// is a real, complete PDF before any agent attaches it (never send a broken CV).
const fs = require('./fs');
const latin1 = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');
async function validateCvPdf(filePath) {
  try {
    if (!filePath) return { ok: false, reason: 'no path' };
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing file' };
    const b = fs.readFileSync(filePath);
    if (b.length < 1500) return { ok: false, reason: `too small (${b.length}B)`, bytes: b.length };
    if (latin1(b.subarray(0, 5)) !== '%PDF-') return { ok: false, reason: 'no %PDF header', bytes: b.length };
    if (!latin1(b.subarray(Math.max(0, b.length - 1024))).includes('%%EOF')) return { ok: false, reason: 'no %%EOF (truncated)', bytes: b.length };
    return { ok: true, reason: 'ok (structural)', bytes: b.length };
  } catch (e) { return { ok: false, reason: `check error (${String(e.message).slice(0, 40)})` }; }
}
module.exports = { validateCvPdf };
