/**
 * cv_docx_writer.js
 * Creates a clean, ATS-friendly Word .docx from AI-rewritten CV text.
 * Uses the `docx` npm package — no PDF rendering, no layout reconstruction issues.
 */

const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, ShadingType, convertInchesToTwip } = require('docx');
const fs   = require('fs');
const path = require('path');

// Known section headings that mark the start of a new CV section
const SECTION_HEADINGS = new Set([
  'PROFESSIONAL PROFILE', 'PERSONAL PROFILE', 'CAREER PROFILE', 'PROFILE',
  'PROFESSIONAL SUMMARY', 'CAREER SUMMARY', 'SUMMARY',
  'WORK EXPERIENCE', 'PROFESSIONAL EXPERIENCE', 'EMPLOYMENT HISTORY', 'EXPERIENCE',
  'KEY SKILLS', 'CORE SKILLS', 'TECHNICAL SKILLS', 'CORE COMPETENCIES',
  'IT SKILLS', 'SKILLS', 'COMPETENCIES',
  'EDUCATION', 'EDUCATION AND CERTIFICATIONS', 'EDUCATION & CERTIFICATIONS',
  'CERTIFICATIONS', 'QUALIFICATIONS',
  'ACHIEVEMENTS', 'KEY ACHIEVEMENTS', 'NOTABLE ACHIEVEMENTS',
  'KEY PROJECTS', 'PROJECTS',
  'REFERENCES',
  'ADDITIONAL INFORMATION', 'INTERESTS', 'HOBBIES',
]);

function isHeading(line) {
  const t = line.trim().toUpperCase();
  if (SECTION_HEADINGS.has(t)) return true;
  // Also catch headings like "WORK EXPERIENCE:" or "KEY SKILLS:"
  if (SECTION_HEADINGS.has(t.replace(/:$/, ''))) return true;
  return false;
}

function isBullet(line) {
  return /^\s*[•\-–*]\s+/.test(line);
}

function stripBullet(line) {
  return line.replace(/^\s*[•\-–*]\s+/, '').trim();
}

function stripMarkdown(text) {
  // Strip **bold** markers the AI sometimes adds — we control formatting in the docx directly
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*\*/g, '').trim();
}

function isJobLine(line) {
  // "Job Title | Company | Date" or "Job Title @ Company | Date"
  return /[|@–—]/.test(line) && !/^[•\-–*]/.test(line.trim());
}

// ── Parse the flat text into structured sections ──────────────────────────────

function parseCV(text) {
  const lines   = text.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return { name: '', contact: '', sections: [] };

  const name    = nonEmpty[0].trim();
  const contact = nonEmpty[1] && !isHeading(nonEmpty[1]) ? nonEmpty[1].trim() : '';

  const sections = [];
  let current    = null;

  const bodyLines = lines.slice(contact ? 2 : 1);

  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) current.lines.push('');
      continue;
    }
    if (isHeading(trimmed)) {
      if (current) sections.push(current);
      current = { heading: trimmed.replace(/:$/, ''), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  return { name, contact, sections };
}

// ── Colour palette (keep it subtle / ATS-safe) ───────────────────────────────

const HEADING_COLOR = '1F3864'; // dark navy
const NAME_COLOR    = '1F3864';
const RULE_COLOR    = '1F3864';

// ── Build docx paragraphs ─────────────────────────────────────────────────────

function namePara(name) {
  return new Paragraph({
    children: [new TextRun({ text: name, bold: true, size: 36, color: NAME_COLOR, font: 'Calibri' })],
    alignment: AlignmentType.LEFT,
    spacing: { after: 60 },
  });
}

function contactPara(contact) {
  // Each pipe-separated segment is one run
  const parts = contact.split('|').map(p => p.trim()).filter(Boolean);
  const runs  = [];
  parts.forEach((p, i) => {
    runs.push(new TextRun({ text: p, size: 18, color: '555555', font: 'Calibri' }));
    if (i < parts.length - 1) runs.push(new TextRun({ text: '  |  ', size: 18, color: '999999', font: 'Calibri' }));
  });
  return new Paragraph({ children: runs, spacing: { after: 160 } });
}

function sectionHeadingPara(heading) {
  return new Paragraph({
    children: [
      new TextRun({ text: heading, bold: true, size: 22, color: HEADING_COLOR, font: 'Calibri', allCaps: true }),
    ],
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOR },
    },
    spacing: { before: 240, after: 80 },
  });
}

function bulletPara(text) {
  return new Paragraph({
    children: [new TextRun({ text: stripMarkdown(text), size: 20, font: 'Calibri', color: '222222' })],
    bullet: { level: 0 },
    spacing: { after: 40 },
  });
}

function jobLinePara(text) {
  // Bold the job title part (before first | or @)
  const sep   = text.search(/[|@–—]/);
  const title = sep > 0 ? stripMarkdown(text.slice(0, sep).trim()) : stripMarkdown(text);
  const rest  = sep > 0 ? text.slice(sep).trim() : '';
  return new Paragraph({
    children: [
      new TextRun({ text: title, bold: true, size: 20, font: 'Calibri', color: '222222' }),
      ...(rest ? [new TextRun({ text: ' ' + rest, size: 20, font: 'Calibri', color: '555555' })] : []),
    ],
    spacing: { before: 120, after: 40 },
  });
}

function bodyPara(text) {
  const clean = stripMarkdown(text);
  // Lines like "Category:" that the AI adds as sub-headings — render bold but small
  const isSubLabel = /^[A-Z][A-Za-z\s&\/()-]{2,40}:$/.test(clean);
  if (isSubLabel) {
    return new Paragraph({
      children: [new TextRun({ text: clean, bold: true, size: 20, font: 'Calibri', color: '333333' })],
      spacing: { before: 80, after: 20 },
    });
  }
  return new Paragraph({
    children: [new TextRun({ text: clean, size: 20, font: 'Calibri', color: '222222' })],
    spacing: { after: 60 },
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

async function writeDocx(cvText, outputPath) {
  const { name, contact, sections } = parseCV(cvText);
  const paras = [];

  // Header block
  if (name)    paras.push(namePara(name));
  if (contact) paras.push(contactPara(contact));

  // Sections
  for (const section of sections) {
    paras.push(sectionHeadingPara(section.heading));

    for (const line of section.lines) {
      const t = line.trim();
      if (!t) continue;
      if (isBullet(t))    paras.push(bulletPara(stripBullet(t)));
      else if (isJobLine(t)) paras.push(jobLinePara(t));
      else                   paras.push(bodyPara(t));
    }
  }

  const who = String(name || '').trim();
  const doc = new Document({
    creator: who || 'Candidate',
    lastModifiedBy: who || 'Candidate',
    title: who ? `${who} CV` : 'CV',
    sections: [{
      properties: {
        page: {
          margin: {
            top:    convertInchesToTwip(0.75),
            bottom: convertInchesToTwip(0.75),
            left:   convertInchesToTwip(0.85),
            right:  convertInchesToTwip(0.85),
          },
        },
      },
      children: paras,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

module.exports = { writeDocx };
