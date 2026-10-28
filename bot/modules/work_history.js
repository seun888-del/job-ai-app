// Work history and education from the CV, in the shape the NHS details page saves
// (cfg.TRAC_DETAILS.employment / .education). Used by the form filler when there are no
// NHS details: US users never see that page, so "Current company", "School" and
// "Gaps in employment" would otherwise go unanswered.
const { parseCV } = require('./cv_parser');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "August 2024" -> "01/08/2024", "2019" -> "01/01/2019", "Present" -> "".
function toDate(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || /present|current|now|date/.test(t)) return '';
  const y = (t.match(/\b(19|20)\d{2}\b/) || [])[0];
  if (!y) return '';
  const m = MONTHS.findIndex((x) => t.includes(x));
  return `01/${String(m >= 0 ? m + 1 : 1).padStart(2, '0')}/${y}`;
}

function fromCV(cvText) {
  let cv;
  try { cv = parseCV(String(cvText || ''), {}); } catch (_) { return null; }
  const employment = (cv.experience || []).filter((e) => e.company || e.title).map((e) => {
    const [start, end] = String(e.dates || '').split(/\s+(?:to|until|-|–|—)\s+/i);
    return { jobTitle: e.title || '', employer: e.company || '', start: toDate(start), end: toDate(end) };
  });
  const education = (cv.education || []).filter((e) => /bachelor|master|degree|\bb\.?sc|\bb\.?a\b|\bm\.?sc|\bphd|diploma|hnd|gcse|a-?level/i.test(e.title || ''))
    .map((e) => ({ qualification: e.title, place: String(e.detail || '').split('|')[0].trim(), year: (String(e.detail || '').match(/\b(19|20)\d{2}\b/) || [])[0] || '' }));
  return { employment, education };
}

module.exports = { fromCV, _toDate: toDate };
