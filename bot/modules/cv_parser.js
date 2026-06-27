/**
 * cv_parser.js
 * ─────────────────────────────────────────────────────────────────────────
 * Turns flat CV text (from pdf-parse / mammoth, optionally AI-tailored) into a
 * strict structured object:
 *
 *   {
 *     name, subtitle, contact,
 *     profile,                                   // single paragraph string
 *     experience: [ { title, company, dates, bullets:[...] } ],
 *     skills:     [ { label, items } ],
 *     education:  [ { title, detail } ],
 *   }
 *
 * The structured object is rendered by cv_pdf_writer.writeStructuredPDF into the
 * fixed reference layout. Because layout is driven from named fields — never from
 * re-parsed positioning — text can never bleed between sections.
 */

const MONTHS  = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_RE = new RegExp(`(?:${MONTHS}|\\d{1,2}/\\d{4})\\s*\\d{0,4}`, 'i');
const DATE_ANY = new RegExp(`(${MONTHS})\\s+\\d{4}|\\b(19|20)\\d{2}\\b|\\bPresent\\b|\\bCurrent\\b`, 'i');

// Section classification by heading text
const HEAD = {
  profile:    /\b(PROFESSIONAL PROFILE|PERSONAL PROFILE|CAREER PROFILE|EXECUTIVE PROFILE|PROFESSIONAL SUMMARY|CAREER SUMMARY|EXECUTIVE SUMMARY|PERSONAL SUMMARY|PERSONAL STATEMENT|OBJECTIVE|ABOUT ME|SUMMARY|PROFILE)\b/i,
  experience: /\b(WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|EMPLOYMENT HISTORY|EMPLOYMENT EXPERIENCE|CAREER HISTORY|EXPERIENCE)\b/i,
  skills:     /\b(TECHNICAL SKILLS|KEY SKILLS|CORE SKILLS|CORE COMPETENCIES|PROFESSIONAL SKILLS|IT SKILLS|SKILLS)\b/i,
  education:  /\b(EDUCATION AND CERTIFICATIONS|EDUCATION & CERTIFICATIONS|EDUCATION|CERTIFICATIONS|QUALIFICATIONS|TRAINING)\b/i,
};

// A line is a section heading when it is essentially all-caps with no lowercase.
function isHeadingLine(line) {
  const t = line.trim();
  if (t.length < 4 || t.length > 65) return false;
  if (/^\d/.test(t)) return false;
  if (t.includes('@') || t.includes('•')) return false;
  if (/[a-z]/.test(t)) return false;                 // any lowercase → not a heading
  if (t.replace(/[^A-Z]/g, '').length < 4) return false;
  return t.split(/\s+/).every(w => w.length >= 2);   // no stray single letters
}

function classifyHeading(line) {
  const t = line.trim();
  // Order matters: education regex contains "EDUCATION" which must win over generic
  for (const key of ['profile', 'experience', 'skills', 'education']) {
    if (HEAD[key].test(t)) return key;
  }
  return null;
}

function isBullet(line)  { return /^[••\-–—]\s/.test(line.trim()); }
function stripBullet(line) { return line.trim().replace(/^[••\-–—]\s*/, '').trim(); }

// Job header: "Title | Company   Date"  (pipe present + a date somewhere after it)
function parseJobHeader(line) {
  const t = line.trim();
  const pipe = t.indexOf('|');
  if (pipe < 1) return null;
  const title = t.slice(0, pipe).trim();
  let rest    = t.slice(pipe + 1).trim();
  if (!title || !rest) return null;

  const dm = DATE_ANY.exec(rest);
  let company = rest, dates = '';
  if (dm) {
    company = rest.slice(0, dm.index).trim().replace(/[|–—-]+$/, '').trim();
    dates   = rest.slice(dm.index).trim();
  }
  if (!company) return null;
  return { title, company, dates, bullets: [] };
}

function splitLines(cvText) {
  return cvText
    .replace(/\r/g, '')
    .replace(/\s*References available on request\.?\s*/gi, '')  // never keep this line
    .split('\n')
    .map(l => l.replace(/\s+$/,'').replace(/^\s+/,''))           // trim both ends but keep words
    .map(l => l.replace(/\s{2,}/g, m => m))                      // keep internal double-spaces (date sep)
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));    // collapse blank runs
}

function parseCV(cvText, opts = {}) {
  const lines = splitLines(cvText);
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  // ── Header block: name / subtitle / contact ──────────────────────────────
  const name = (opts.overrideName || nonEmpty[0] || '').trim();

  // subtitle = first line after name that is NOT the contact line and not a heading
  let subtitle = '', contact = '', headerConsumed = 1;
  for (let i = 1; i < Math.min(nonEmpty.length, 5); i++) {
    const l = nonEmpty[i].trim();
    if (classifyHeading(l)) break;
    const looksContact = l.includes('@') || /\d{6,}/.test(l.replace(/\s/g, ''));
    if (looksContact && !contact) { contact = l; headerConsumed = i + 1; continue; }
    if (!subtitle && !looksContact) { subtitle = l; headerConsumed = i + 1; continue; }
    if (contact) break;
  }

  // ── Walk sections ────────────────────────────────────────────────────────
  const sections = {};       // key -> array of body lines
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (i < headerConsumed && !classifyHeading(t)) continue; // skip header lines
    if (isHeadingLine(t)) {
      const key = classifyHeading(t);
      current = key;
      if (key && !sections[key]) sections[key] = [];
      continue;
    }
    if (current && sections[current]) sections[current].push(lines[i]);
  }

  // ── Profile ──────────────────────────────────────────────────────────────
  const profile = (sections.profile || [])
    .map(l => l.trim()).filter(Boolean).join(' ')
    .replace(/\s{2,}/g, ' ').trim();

  // ── Experience ───────────────────────────────────────────────────────────
  const experience = [];
  for (const raw of (sections.experience || [])) {
    const line = raw.trim();
    if (!line) continue;
    if (isBullet(line)) {
      if (experience.length) experience[experience.length - 1].bullets.push(stripBullet(line));
      continue;
    }
    const header = parseJobHeader(line);
    if (header) { experience.push(header); continue; }
    // Continuation of previous bullet (wrapped line with no bullet char)
    const last = experience[experience.length - 1];
    if (last && last.bullets.length) {
      last.bullets[last.bullets.length - 1] += ' ' + line;
    }
  }
  // Collapse internal whitespace inside bullets
  for (const job of experience) job.bullets = job.bullets.map(b => b.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);

  // ── Skills ───────────────────────────────────────────────────────────────
  const skills = [];
  for (const raw of (sections.skills || [])) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Z][A-Za-z0-9 ,&\/()+-]{1,40}):\s*(.+)$/);
    if (m) {
      skills.push({ label: m[1].trim(), items: m[2].trim() });
    } else if (skills.length) {
      // wrapped continuation of previous skill line
      skills[skills.length - 1].items += ' ' + line;
    } else {
      skills.push({ label: '', items: line });
    }
  }
  for (const s of skills) s.items = s.items.replace(/\s{2,}/g, ' ').trim();

  // ── Education ────────────────────────────────────────────────────────────
  const education = [];
  for (const raw of (sections.education || [])) {
    const line = raw.trim();
    if (!line) continue;
    const isDetail = line.includes('|') || DATE_ANY.test(line) || /^[a-z]/.test(line);
    if (isDetail && education.length && !education[education.length - 1].detail) {
      education[education.length - 1].detail = line;
    } else {
      education.push({ title: line, detail: '' });
    }
  }

  return { name, subtitle, contact, profile, experience, skills, education };
}

module.exports = { parseCV };
