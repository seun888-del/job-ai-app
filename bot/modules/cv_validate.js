// Guard against attaching a corrupt / empty / truncated CV to a real application.
//
// The scorer writes each tailored CV to output/saved_cvs and stores its path on
// the queue entry; a site bot later uploads that path. If generation produced a
// bad PDF (0 bytes, truncated "bad XRef", "Invalid PDF structure") — or a stale
// corrupt file from an earlier build is still queued — we must NOT attach it to
// an employer. This validates the file is a real, non-trivial PDF with readable
// text; the bots' existing "skip rather than send a bad CV" contract handles the
// rejection.

const fs = require('fs');

// pdf-parse is a top-level dependency (also used by cv_parser). Load lazily so a
// require failure can't break the bot — we degrade to the structural checks.
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (_) { pdfParse = null; }

const MIN_BYTES = 3000;   // valid tailored CVs are ~6KB+; corrupt ones seen at 0–1.7KB
const MIN_TEXT  = 300;    // a real 1–2 page CV extracts thousands of chars

// Returns { ok: boolean, reason: string, bytes, textLen }.
async function validateCvPdf(filePath) {
  try {
    if (!filePath) return { ok: false, reason: 'no path' };
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing file' };
    const buf = fs.readFileSync(filePath);
    const bytes = buf.length;
    if (bytes < MIN_BYTES) return { ok: false, reason: `too small (${bytes}B)`, bytes };
    // Structural sanity: real PDFs start with "%PDF-" and end with an EOF marker.
    const head = buf.slice(0, 5).toString('latin1');
    if (head !== '%PDF-') return { ok: false, reason: 'no %PDF header', bytes };
    const tail = buf.slice(-1024).toString('latin1');
    if (!tail.includes('%%EOF')) return { ok: false, reason: 'no %%EOF (truncated)', bytes };
    // Authoritative: the text must actually be extractable (catches "bad XRef" /
    // "Invalid PDF structure" that still have a header/trailer, and blank pages).
    if (pdfParse) {
      try {
        const d = await pdfParse(buf);
        const textLen = (d.text || '').trim().length;
        if (textLen < MIN_TEXT) return { ok: false, reason: `too little text (${textLen} chars)`, bytes, textLen };
        return { ok: true, reason: 'ok', bytes, textLen };
      } catch (e) {
        return { ok: false, reason: `unparseable (${(e.message || '').slice(0, 40)})`, bytes };
      }
    }
    return { ok: true, reason: 'ok (structural only)', bytes };
  } catch (e) {
    return { ok: false, reason: `check error (${(e.message || '').slice(0, 40)})` };
  }
}

module.exports = { validateCvPdf };
