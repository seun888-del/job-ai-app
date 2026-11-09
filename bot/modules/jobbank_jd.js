/**
 * jobbank_jd.js
 * Job Bank (Canada) postings are built from the employer's tick boxes: a long "Computer and
 * technology knowledge" list (often 20 to 40 items: MAC, device drivers, image editing...),
 * work conditions ("Fast-paced environment", "Sitting"), personal suitability ("Dependability"),
 * benefits, screening questions. The CV scorer read every box as a must-have the CV has to show,
 * so almost every Job Bank job failed the match for every user, whatever the job.
 * This rebuilds the advert the way a recruiter reads it: the duties and the real requirements
 * (education, experience, languages, certificates) stay essential; the tick-box tool list is
 * marked desirable; conditions, traits and benefits are dropped. Shared by the app and extension.
 */
const LABELS = [
  'Education', 'Work setting', 'Tasks', 'Supervision', 'Computer and technology knowledge', 'Security and safety',
  'Work conditions and physical capabilities', 'Personal suitability', 'Screening questions', 'Experience',
  'Credentials', 'Certificates, licences, memberships, and courses', 'Area of specialization', 'Specialization',
  'Additional information', 'Transportation/travel information', 'Health benefits', 'Financial benefits',
  'Long term benefits', 'Other benefits', 'Weight handling', 'Ability to supervise', 'Own tools/equipment',
  'Work location information', 'Languages', 'Experience and specialization', 'Target audience', 'Equipment and machinery experience',
  'Asset languages', 'Employment terms options', 'Workplace information', 'Work site environment', 'Employment groups', 'Type of experience', 'Licences', 'Driving licence',
];
const ESSENTIAL = new Set(['Licences', 'Driving licence', 'Education', 'Experience', 'Languages', 'Credentials', 'Certificates, licences, memberships, and courses', 'Area of specialization', 'Specialization', 'Equipment and machinery experience']);
const DESIRABLE = new Set(['Computer and technology knowledge', 'Asset languages']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const LABEL_RE = new RegExp(`(?:^|[.\\s])(${LABELS.sort((a, b) => b.length - a.length).map(esc).join('|')})\\s?:\\s`, 'g');

// The "Job details" summary sentence is "Label: item. item. Label: item." — split it by label.
function sections(text) {
  const out = {};
  const marks = [];
  let m;
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(text))) marks.push({ label: m[1], start: m.index + m[0].length, at: m.index });
  marks.forEach((k, i) => {
    const body = text.slice(k.start, i + 1 < marks.length ? marks[i + 1].at + 1 : undefined).trim().replace(/\.$/, '');
    out[k.label] = (out[k.label] ? out[k.label] + '. ' : '') + body;
  });
  return out;
}

const items = (s) => String(s || '').split(/\.\s+|\.$/).map((x) => x.trim()).filter(Boolean);

/**
 * cleanJobBankJD(description, { title }) -> text for the scorer and the cover letter.
 * Falls back to the original text when the posting isn't in the usual Job Bank shape.
 */
function cleanJobBankJD(description, { title = '' } = {}) {
  const raw = String(description || '');
  const head = (raw.split(/\n\s*Location\s*\n/)[0] || raw).replace(/^\s*Job details\s*/i, '').replace(/\s+/g, ' ').trim();
  const sec = sections(head);
  if (!sec.Tasks && !sec.Education && !sec.Experience) return raw;
  const lang = (raw.match(/\n\s*Languages\s*\n\s*([^\n]+)/) || [])[1];
  if (lang && !sec.Languages) sec.Languages = lang.trim();
  const pay = (raw.match(/\n\s*Salary\s*([^\n]+)/) || [])[1];
  const lines = [];
  if (title) lines.push(`Job title: ${title}`);
  if (pay) lines.push(`Pay: ${pay.replace(/\s+/g, ' ').trim()}`);
  if (sec.Tasks) lines.push('', 'Duties:', ...items(sec.Tasks).map((x) => `- ${x}`));
  const req = Object.keys(sec).filter((k) => ESSENTIAL.has(k));
  if (req.length) lines.push('', 'Requirements:', ...req.map((k) => `- ${k}: ${items(sec[k]).join(', ')}`));
  const nice = Object.keys(sec).filter((k) => DESIRABLE.has(k)).flatMap((k) => items(sec[k]));
  if (nice.length) lines.push('', 'Desirable, not required (familiarity with some of these helps): ' + nice.join(', '));
  return lines.join('\n').trim();
}

module.exports = { cleanJobBankJD, _sections: sections };
