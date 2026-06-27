const PDFDocument = require('pdfkit');
const fs   = require('fs');
const path = require('path');

const FONT      = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_ITAL = 'Helvetica-Oblique';

const BLUE  = '#1F5C9E';
const BLACK = '#1A1A1A';
const GRAY  = '#555555';
const RULE  = '#CCCCCC';

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_RE = new RegExp(`(${MONTHS})\\s+\\d{4}`, 'i');

// Known letter-spaced heading → normal text
const HEADING_MAP = {
  'PROFESSIONALPROFILE':          'PROFESSIONAL PROFILE',
  'WORKEXPERIENCE':               'WORK EXPERIENCE',
  'KEYPROJECTS':                  'KEY PROJECTS',
  'TECHNICALSKILLS':              'TECHNICAL SKILLS',
  'KEYSKILLS':                    'KEY SKILLS',
  'SKILLS':                       'SKILLS',
  'EDUCATIONANDCERTIFICATIONS':   'EDUCATION AND CERTIFICATIONS',
  'EDUCATIONCERTIFICATIONS':      'EDUCATION & CERTIFICATIONS',
  'EDUCATION':                    'EDUCATION',
  'CERTIFICATIONS':               'CERTIFICATIONS',
  'EXPERIENCE':                   'EXPERIENCE',
  'SUMMARY':                      'SUMMARY',
  'PROFILE':                      'PROFILE',
  'ACHIEVEMENTS':                 'ACHIEVEMENTS',
  'ADDITIONALSKILLSCOMPETENCIES': 'ADDITIONAL KEYWORDS',
};

// Detect "P R O F E S S I O N A L  P R O F I L E" style (every token is a single uppercase letter)
function deLetterSpace(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length >= 4 && parts.every(p => /^[A-Z]$/.test(p))) {
    const collapsed = parts.join('');
    return HEADING_MAP[collapsed] || collapsed;
  }
  return null;
}

// Pre-process raw lines:
//  - collapse letter-spaced headings
//  - join "Title | Company\nDate" into a single job-entry line
function preprocessLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw     = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) { out.push(''); continue; }

    // Fix letter-spaced heading
    const fixed = deLetterSpace(trimmed);
    if (fixed) { out.push(fixed); continue; }

    // Join job entry + standalone date on the next line
    if (trimmed.includes(' | ') && !DATE_RE.test(trimmed) && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (next && DATE_RE.test(next) && !next.includes(' | ')) {
        out.push(trimmed + '  ' + next);
        i++;
        continue;
      }
    }

    // Skip short lines that are a duplicate prefix of the next non-empty line
    // (PDF extraction artifact: "Detail-oriented" appearing before "Detail-oriented professional...")
    const nextNonEmpty = lines.slice(i + 1).find(l => l.trim().length > 0)?.trim() || '';
    if (trimmed.length < 60 && nextNonEmpty.toLowerCase().startsWith(trimmed.toLowerCase() + ' ')) {
      continue;
    }

    // Join continuation lines onto the previous line when:
    // (a) starts with lowercase/digit — mid-sentence wrap, OR
    // (b) previous bullet line doesn't end with sentence-ending punctuation, OR
    // (c) previous paragraph line ends with comma, OR
    // (d) previous paragraph line ends with a preposition/conjunction, OR
    // (e) previous paragraph line ends without sentence-ending punctuation and is not a
    //     complete skill line — catches "...Zuora\nCommerce Tools..." from AI-tailored text
    if (out.length > 0) {
      const prev     = out[out.length - 1];
      const prevTrim = prev ? prev.trim() : '';
      if (prevTrim.length > 0) {
        const isLowerCont    = /^[a-z\d]/.test(trimmed);
        const prevIsBullet   = /^[•\-–]\s/.test(prevTrim);
        const prevUnfinished = prevIsBullet && !/[.!?:)]$/.test(prevTrim);
        const isNotNewBullet = !/^[•\-–]\s/.test(trimmed);
        const isNotHeading   = !(/^[A-Z\s&\/()-]+$/.test(trimmed) && trimmed.length < 65 && trimmed.replace(/[^A-Z]/g,'').length >= 3);
        const isNotJobEntry  = !trimmed.includes(' | ');
        // Skill lines have "Category: content" format — exclude these from para-joining
        const isNotSkillLine = !/^[A-Z][A-Za-z0-9 ,&\/()-]{2,40}:\s+/.test(trimmed);
        const prevIsSkillLine = /^[A-Z][A-Za-z0-9 ,&\/()-]{2,40}:\s+/.test(prevTrim);
        const prevIsJobEntry  = prevTrim.includes(' | ') && DATE_RE.test(prevTrim);
        const prevIsParaLine = !prevIsBullet && !prevIsSkillLine && !prevIsJobEntry && !/^[A-Z\s&\/()-]+$/.test(prevTrim) && prevTrim.length > 10;
        // Ends with comma
        const prevParaEndsComma = prevIsParaLine && prevTrim.endsWith(',');
        // Ends with preposition/conjunction/article
        const WRAP_ENDINGS = /\b(over|by|with|at|for|and|or|but|to|of|in|from|through|across|into|including|as|via|than|that|a|an|the|their|its|our|your|his|her|this|these|those|both|each|all|any|some)\s*$/i;
        const prevParaWraps = prevIsParaLine && prevTrim.length > 15 && WRAP_ENDINGS.test(prevTrim);
        // Ends without sentence-ending punctuation (catches "...Zuora\nCommerce Tools...")
        const prevParaUnfinished = prevIsParaLine && prevTrim.length > 15 && !/[.!?:)]$/.test(prevTrim);

        if (isLowerCont ||
            (prevUnfinished && isNotNewBullet && isNotHeading && isNotJobEntry) ||
            ((prevParaEndsComma || prevParaWraps) && isNotNewBullet && isNotHeading && isNotJobEntry) ||
            (prevParaUnfinished && isNotNewBullet && isNotHeading && isNotJobEntry && isNotSkillLine)) {
          out[out.length - 1] = prev.trimEnd() + ' ' + trimmed;
          continue;
        }
      }
    }

    out.push(trimmed);
  }
  return out;
}

function drawRule(doc, left, right) {
  const y = doc.y;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke(RULE);
}

function writePDF(cvText, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size:    'A4',
      margins: { top: 48, bottom: 45, left: 55, right: 55 },
    });

    const stream = fs.createWriteStream(outputPath);
    stream.on('error', reject);
    stream.on('finish', () => resolve(outputPath));
    doc.pipe(stream);

    const L = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Strip PDF extraction artifacts like "1 Required", "2 Required" — these appear
    // as form validation labels. The number and "Required" may be split across lines.
    // Also update email address in case the source PDF has the old address.
    const cleanedText = cvText
      .replace(/femimerit\.tech@gmail\.com/g, 'merritfemi@gmail.com')
      .replace(/[,\s]*\b\d+\s+[Rr]equired\b[,\s]*/g, ', ')
      .replace(/,\s*,/g, ',')       // collapse any double-commas left behind
      .replace(/,\s*$/gm, '')       // remove trailing commas at end of lines
      .replace(/^\s*,\s*/gm, '')    // remove leading commas at start of lines
      .replace(/\s*References available on request\.?\s*/gi, '');  // boilerplate — remove
    const rawLines    = cleanedText.split('\n').map(l => l.trimEnd());
    const lines       = preprocessLines(rawLines);

    // ── Identify header block ──────────────────────────────────────────────
    const nonEmpty   = lines.filter(l => l.trim().length > 0);
    // Use override name if provided (avoids letter-spacing collapse artifacts like "FEMIMERIT")
    const rawNameLine = nonEmpty[0] ? nonEmpty[0].trim() : '';
    const nameLine   = options.overrideName || rawNameLine;
    const subLine    = nonEmpty[1] ? nonEmpty[1].trim() : '';

    // Find contact line and trim any profile text that bled in during PDF extraction.
    // E.g. "London | 07359... | email@... | linkedin.com/in/x Results-driven IT..." → strip after URL end.
    const rawContact = nonEmpty.slice(0, 6).find(l =>
      l.includes('@') || /\d{6,}/.test(l)
    ) || '';
    const contactLine = rawContact
      .split(/\s*\|\s*/)
      .map(p => p.replace(/((?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|uk|org|net|io)\/\S*)\s+.*/, '$1').trim())
      .filter(p => p.length > 0 && p.length < 80)
      .slice(0, 5)
      .join(' | ');

    const headerSet  = new Set([rawNameLine, subLine, rawContact].filter(Boolean));

    // ── Render header ──────────────────────────────────────────────────────
    doc.font(FONT_BOLD).fontSize(22).fillColor(BLACK)
       .text(nameLine, { align: 'center' });
    doc.moveDown(0.1);

    if (subLine && subLine !== nameLine) {
      doc.font(FONT_BOLD).fontSize(11).fillColor(BLUE)
         .text(subLine, { align: 'center' });
      doc.moveDown(0.1);
    }

    if (contactLine) {
      doc.font(FONT).fontSize(9.5).fillColor(GRAY)
         .text(contactLine, { align: 'center' });
    }

    doc.moveDown(0.35);
    drawRule(doc, L, L + W);
    doc.moveDown(0.45);

    // ── Render body ────────────────────────────────────────────────────────
    let pastHeader    = false;
    let currentSection = '';  // track which section we're in

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        if (pastHeader) doc.moveDown(0.2);
        continue;
      }

      if (!pastHeader && headerSet.has(trimmed)) {
        if (trimmed === contactLine || (!contactLine && headerSet.size <= 2)) pastHeader = true;
        continue;
      }
      pastHeader = true;

      // ── Section heading ──────────────────────────────────────────────────
      const isHeading =
        trimmed === trimmed.toUpperCase() &&
        trimmed.replace(/[^A-Z]/g, '').length >= 4 &&
        trimmed.length >= 4 &&
        trimmed.length < 65 &&
        !/^\d/.test(trimmed) &&
        !trimmed.includes('@') &&
        !/[a-z]/.test(trimmed) &&
        trimmed.split(/\s+/).every(w => w.length >= 2);  // no single-char tokens — filters "IENCE" etc.

      // ── Job entry: "Title | Company  Date" (not in Education section) ────
      const pipeIdx     = trimmed.indexOf(' | ');
      const hasDate     = DATE_RE.test(trimmed.slice(Math.max(0, pipeIdx)));
      const inEducation = currentSection.includes('EDUCATION') || currentSection.includes('CERTIF');
      const isJobEntry  = pipeIdx > 0 && hasDate && !inEducation;

      // ── Education entry: line in Education section that has a pipe ────────
      const isEduEntry = inEducation && pipeIdx > 0;

      // ── Bullet ──────────────────────────────────────────────────────────
      const isBullet = /^[•\-–]\s/.test(trimmed);

      // ── Skill line: "Category: content text" ───────────────────────────
      // Only match if not a heading and starts with a capitalised word before colon
      const skillMatch = !isHeading && !isJobEntry && !isEduEntry && !isBullet &&
        trimmed.match(/^([A-Z][A-Za-z0-9 ,&\/()-]{2,40}):\s+(.{5,})$/);

      // Skip "Additional Skills & Competencies" skill lines — these are keyword dumps
      // from the original CV that look unprofessional appended at the bottom
      if (skillMatch && /^additional\s+skills/i.test(skillMatch[1])) continue;

      if (isHeading) {
        // Map jammed headings (e.g. "WORKEXPERIENCE" → "WORK EXPERIENCE") for display
        const displayHeading = HEADING_MAP[trimmed.replace(/\s/g, '')] || trimmed;
        currentSection = displayHeading;
        doc.moveDown(0.6);
        doc.font(FONT_BOLD).fontSize(10.5).fillColor(BLUE).text(displayHeading);
        doc.moveDown(0.08);
        drawRule(doc, L, L + W);
        doc.moveDown(0.4);

      } else if (isJobEntry) {
        const afterPipe = trimmed.slice(pipeIdx + 3);
        const jobTitle  = trimmed.slice(0, pipeIdx).trim();
        const dateMatch = DATE_RE.exec(afterPipe);
        let company = afterPipe.trim();
        let dateStr = '';
        if (dateMatch) {
          company = afterPipe.slice(0, dateMatch.index).trim();
          dateStr = afterPipe.slice(dateMatch.index).trim();
        }

        doc.moveDown(0.3);
        // Bold black title + pipe
        doc.font(FONT_BOLD).fontSize(10).fillColor(BLACK)
           .text(jobTitle + ' | ', { continued: true });
        // Bold blue company
        doc.font(FONT_BOLD).fontSize(10).fillColor(BLUE)
           .text(company + (dateStr ? '  ' : ''), { continued: !!dateStr });
        // Italic gray date
        if (dateStr) {
          doc.font(FONT_ITAL).fontSize(10).fillColor(GRAY).text(dateStr);
        }
        doc.moveDown(0.25);

      } else if (isEduEntry) {
        // "Degree/Cert | Institution  Date" or "Degree/Cert | Institution"
        const afterPipe = trimmed.slice(pipeIdx + 3);
        const degreeTitle = trimmed.slice(0, pipeIdx).trim();
        const dateMatch = DATE_RE.exec(afterPipe);
        let institution = afterPipe.trim();
        let dateStr = '';
        if (dateMatch) {
          institution = afterPipe.slice(0, dateMatch.index).trim();
          dateStr = afterPipe.slice(dateMatch.index).trim();
        }
        doc.moveDown(0.2);
        doc.font(FONT_BOLD).fontSize(9.5).fillColor(BLACK)
           .text(degreeTitle + (institution ? ' | ' : ''), { continued: !!institution });
        if (institution) {
          doc.font(FONT).fontSize(9.5).fillColor(BLUE)
             .text(institution + (dateStr ? '  ' : ''), { continued: !!dateStr });
        }
        if (dateStr) {
          doc.font(FONT_ITAL).fontSize(9.5).fillColor(GRAY).text(dateStr);
        }

      } else if (isBullet) {
        const text  = trimmed.replace(/^[•\-–]\s*/, '');
        const textW = W - 18;
        // If this bullet won't fit on the remaining page, start a new page first
        // so the bullet and its text always start on the same page
        const textH = doc.heightOfString(text, { width: textW, lineGap: 2 });
        const spaceLeft = doc.page.height - doc.page.margins.bottom - doc.y;
        if (textH > spaceLeft) doc.addPage();
        const bulletX = L + 8;
        const textX   = L + 18;
        // Draw bullet symbol manually then place text so indentation is consistent
        doc.font(FONT).fontSize(9.5).fillColor(GRAY)
           .text('•', bulletX, doc.y, { width: 10, lineGap: 2 });
        const lineH = doc.currentLineHeight(true);
        doc.font(FONT).fontSize(9.5).fillColor(GRAY)
           .text(text, textX, doc.y - lineH, { width: textW, lineGap: 2 });
        doc.x = L;
        doc.moveDown(0.06);

      } else if (skillMatch) {
        // continued: true puts bold label and normal value on same line;
        // pdfkit 0.18 wraps continuation lines back to the left margin correctly
        doc.font(FONT_BOLD).fontSize(9.5).fillColor(BLACK)
           .text(skillMatch[1] + ': ', { continued: true });
        doc.font(FONT).fontSize(9.5).fillColor(GRAY)
           .text(skillMatch[2], { lineGap: 1.5 });
        doc.x = L;  // defensive reset for older pdfkit behaviour

      } else {
        doc.font(FONT).fontSize(9.5).fillColor(GRAY)
           .text(trimmed, { lineGap: 1.5 });
      }
    }

    doc.end();
  });
}

// ── Structured renderer ─────────────────────────────────────────────────────
// Renders a parsed CV object (see cv_parser.js) into the fixed reference layout.
// Layout is driven entirely from named fields, so text can never bleed between
// sections. This is the path used for every tailored CV.
function writeStructuredPDF(cv, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size:    'A4',
      margins: { top: 48, bottom: 45, left: 55, right: 55 },
    });
    const stream = fs.createWriteStream(outputPath);
    stream.on('error', reject);
    stream.on('finish', () => resolve(outputPath));
    doc.pipe(stream);

    const L = doc.page.margins.left;
    const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const sectionHeading = (label) => {
      doc.moveDown(0.6);
      doc.font(FONT_BOLD).fontSize(10.5).fillColor(BLUE).text(label);
      doc.moveDown(0.08);
      drawRule(doc, L, L + W);
      doc.moveDown(0.4);
    };

    // Start a new page if the next block of height `h` won't fit
    const ensureSpace = (h) => {
      const spaceLeft = doc.page.height - doc.page.margins.bottom - doc.y;
      if (h > spaceLeft) doc.addPage();
    };

    // ── Header ───────────────────────────────────────────────────────────────
    const name = (options.overrideName || cv.name || '').trim();
    doc.font(FONT_BOLD).fontSize(22).fillColor(BLACK).text(name, { align: 'center' });
    doc.moveDown(0.1);
    if (cv.subtitle) {
      doc.font(FONT_BOLD).fontSize(11).fillColor(BLUE).text(cv.subtitle.trim(), { align: 'center' });
      doc.moveDown(0.1);
    }
    if (cv.contact) {
      doc.font(FONT).fontSize(9.5).fillColor(GRAY).text(cv.contact.trim(), { align: 'center' });
    }
    doc.moveDown(0.35);
    drawRule(doc, L, L + W);
    doc.moveDown(0.45);

    // ── Professional Profile ───────────────────────────────────────────────
    if (cv.profile && cv.profile.trim()) {
      sectionHeading('PROFESSIONAL PROFILE');
      doc.font(FONT).fontSize(9.5).fillColor(GRAY).text(cv.profile.trim(), { lineGap: 1.5, align: 'left' });
    }

    // ── Work Experience ────────────────────────────────────────────────────
    if (Array.isArray(cv.experience) && cv.experience.length) {
      sectionHeading('WORK EXPERIENCE');
      cv.experience.forEach((job, idx) => {
        if (!job || !job.title) return;
        // Keep the role header with at least its first bullet on the same page
        const firstBulletH = job.bullets && job.bullets[0]
          ? doc.heightOfString(job.bullets[0], { width: W - 18, lineGap: 2 }) : 0;
        ensureSpace(28 + firstBulletH);

        if (idx > 0) doc.moveDown(0.35);
        doc.font(FONT_BOLD).fontSize(10).fillColor(BLACK)
           .text(job.title.trim() + (job.company ? '  |  ' : ''), { continued: !!job.company });
        if (job.company) {
          doc.font(FONT_BOLD).fontSize(10).fillColor(BLUE)
             .text(job.company.trim() + (job.dates ? '    ' : ''), { continued: !!job.dates });
        }
        if (job.dates) {
          doc.font(FONT_ITAL).fontSize(10).fillColor(GRAY).text(job.dates.trim());
        }
        doc.moveDown(0.25);

        for (const b of (job.bullets || [])) {
          const text  = String(b).trim();
          if (!text) continue;
          const textW = W - 18;
          const textH = doc.heightOfString(text, { width: textW, lineGap: 2 });
          ensureSpace(textH);
          const bulletX = L + 8;
          const textX   = L + 18;
          doc.font(FONT).fontSize(9.5).fillColor(GRAY).text('•', bulletX, doc.y, { width: 10, lineGap: 2 });
          const lineH = doc.currentLineHeight(true);
          doc.font(FONT).fontSize(9.5).fillColor(GRAY).text(text, textX, doc.y - lineH, { width: textW, lineGap: 2 });
          doc.x = L;
          doc.moveDown(0.06);
        }
      });
    }

    // ── Key Skills ──────────────────────────────────────────────────────────
    if (Array.isArray(cv.skills) && cv.skills.length) {
      sectionHeading('KEY SKILLS');
      for (const s of cv.skills) {
        if (!s || !s.items) continue;
        const itemH = doc.heightOfString(s.items, { width: W, lineGap: 1.5 });
        ensureSpace(itemH);
        if (s.label) {
          doc.font(FONT_BOLD).fontSize(9.5).fillColor(BLACK).text(s.label.trim() + ': ', { continued: true });
          doc.font(FONT).fontSize(9.5).fillColor(GRAY).text(s.items.trim(), { lineGap: 1.5 });
        } else {
          doc.font(FONT).fontSize(9.5).fillColor(GRAY).text(s.items.trim(), { lineGap: 1.5 });
        }
        doc.x = L;
        doc.moveDown(0.12);
      }
    }

    // ── Education & Certifications ──────────────────────────────────────────
    if (Array.isArray(cv.education) && cv.education.length) {
      sectionHeading('EDUCATION AND CERTIFICATIONS');
      cv.education.forEach((e, idx) => {
        if (!e || !e.title) return;
        ensureSpace(34);
        if (idx > 0) doc.moveDown(0.25);
        doc.font(FONT_BOLD).fontSize(9.5).fillColor(BLACK).text(e.title.trim());
        if (e.detail) {
          const pipe = e.detail.indexOf('|');
          if (pipe > 0) {
            const inst = e.detail.slice(0, pipe).trim();
            const rest = e.detail.slice(pipe + 1).trim();
            doc.font(FONT).fontSize(9.5).fillColor(BLUE).text(inst + (rest ? '  ' : ''), { continued: !!rest });
            if (rest) doc.font(FONT_ITAL).fontSize(9.5).fillColor(GRAY).text(rest);
          } else {
            doc.font(FONT_ITAL).fontSize(9.5).fillColor(GRAY).text(e.detail.trim());
          }
          doc.x = L;
        }
      });
    }

    doc.end();
  });
}

function buildPaths(savedDir, uploadDir, uploadFilename, jobTitle, company, score) {
  if (!fs.existsSync(savedDir))  fs.mkdirSync(savedDir,  { recursive: true });
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const date   = new Date().toISOString().slice(0, 10);
  const safe   = s => s.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').substring(0, 40);
  const saved  = path.join(savedDir,  `${safe(jobTitle)}_${safe(company)}_${score}pct_${date}.pdf`);
  const upload = path.join(uploadDir, uploadFilename);
  return { saved, upload };
}

module.exports = { writePDF, writeStructuredPDF, buildPaths };
