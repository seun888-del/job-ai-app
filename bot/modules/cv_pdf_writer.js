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
        const isNotSkillLine = !/^[A-Z][A-Za-z ,&\/()-]{2,40}:\s+/.test(trimmed);
        const prevIsSkillLine = /^[A-Z][A-Za-z ,&\/()-]{2,40}:\s+/.test(prevTrim);
        const prevIsParaLine = !prevIsBullet && !prevIsSkillLine && !/^[A-Z\s&\/()-]+$/.test(prevTrim) && prevTrim.length > 10;
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

function writePDF(cvText, outputPath) {
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
      .replace(/^\s*,\s*/gm, '');   // remove leading commas at start of lines
    const rawLines    = cleanedText.split('\n').map(l => l.trimEnd());
    const lines       = preprocessLines(rawLines);

    // ── Identify header block ──────────────────────────────────────────────
    const nonEmpty   = lines.filter(l => l.trim().length > 0);
    const nameLine   = nonEmpty[0] ? nonEmpty[0].trim() : '';
    const subLine    = nonEmpty[1] ? nonEmpty[1].trim() : '';
    const contactLine = nonEmpty.slice(0, 6).find(l =>
      l.includes('@') || /\d{6,}/.test(l)
    ) || '';
    const headerSet  = new Set([nameLine, subLine, contactLine].filter(Boolean));

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
        trimmed.match(/^([A-Z][A-Za-z ,&\/()-]{2,40}):\s+(.{5,})$/);

      if (isHeading) {
        currentSection = trimmed;
        doc.moveDown(0.6);
        doc.font(FONT_BOLD).fontSize(10.5).fillColor(BLUE).text(trimmed);
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
        const text = trimmed.replace(/^[•\-–]\s*/, '');
        // pdfkit's list() is the only reliable way to get hanging-indent wrap alignment.
        // bulletIndent = bullet x offset from L; textIndent = text x offset from L.
        // Wrapped continuation lines stay at textIndent, not the page margin.
        doc.font(FONT).fontSize(9.5).fillColor(GRAY)
           .list([text], L, doc.y, {
             listType:     'bullet',
             bulletRadius: 1.5,
             bulletIndent: 10,
             textIndent:   20,
             width:        W,
             lineGap:      2,
             paragraphGap: 0,
           });
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

function buildPaths(savedDir, uploadDir, uploadFilename, jobTitle, company, score) {
  if (!fs.existsSync(savedDir))  fs.mkdirSync(savedDir,  { recursive: true });
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const date   = new Date().toISOString().slice(0, 10);
  const safe   = s => s.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').substring(0, 40);
  const saved  = path.join(savedDir,  `Femi_Merit_${safe(jobTitle)}_${safe(company)}_${score}pct_${date}.pdf`);
  const upload = path.join(uploadDir, uploadFilename);
  return { saved, upload };
}

module.exports = { writePDF, buildPaths };
