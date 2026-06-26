/**
 * cv_light_tailor.js
 * Applies zero-layout-risk tailoring to a DOCX:
 *   1. Subtitle swap — replaces the CV's subtitle line with the JD job title
 *   2. Synonym swap  — replaces CV terms with JD-preferred synonyms
 *      (only when the synonym already exists in the CV — no new content added)
 *
 * Operates on raw <w:t> XML text nodes only.  Paragraph structure, formatting,
 * runs, and styles are never touched, so layout is guaranteed unchanged.
 */

const JSZip = require('jszip');
const fs    = require('fs');

// ── Synonym groups ────────────────────────────────────────────────────────────
// Terms within the same group are interchangeable.
// If the JD uses one form and the CV uses another, we swap the CV form → JD form.
const SYNONYM_GROUPS = [
  ['Microsoft 365', 'Office 365', 'MS 365', 'M365'],
  ['Microsoft Office', 'MS Office'],
  ['Active Directory', 'Microsoft Active Directory', 'AD'],
  ['Azure Active Directory', 'Azure AD', 'Entra ID', 'Microsoft Entra ID'],
  ['Windows 10/11', 'Windows 10', 'Windows 11'],
  ['Microsoft Teams', 'MS Teams', 'Teams'],
  ['SharePoint', 'Share Point', 'MS SharePoint'],
  ['Exchange Online', 'Exchange Server', 'MS Exchange', 'Microsoft Exchange'],
  ['Microsoft Intune', 'Intune', 'Endpoint Manager', 'Microsoft Endpoint Manager', 'SCCM', 'MEM'],
  ['VMware', 'VMWare', 'VM Ware'],
  ['ServiceNow', 'Service Now'],
  ['ITIL v4', 'ITIL', 'ITIL 4', 'ITIL Foundation', 'ITIL v4 Foundation'],
  ['Remote Desktop', 'RDP', 'Remote Desktop Protocol'],
  ['Help Desk', 'Helpdesk', 'Help-Desk'],
  ['Service Desk', 'Servicedesk', 'Service-Desk'],
  ['1st Line Support', 'First Line Support', '1st Line', 'First Line'],
  ['2nd Line Support', 'Second Line Support', '2nd Line', 'Second Line'],
  ['3rd Line Support', 'Third Line Support', '3rd Line', 'Third Line'],
  ['Troubleshooting', 'Trouble Shooting', 'Trouble-shooting'],
  ['VPN', 'Virtual Private Network'],
  ['TCP/IP', 'TCP IP', 'TCP-IP'],
  ['DNS', 'Domain Name System', 'Domain Name Service'],
  ['DHCP', 'Dynamic Host Configuration'],
  ['Patch Management', 'Patching', 'Patch Deployment'],
  ['Asset Management', 'IT Asset Management', 'ITAM'],
  ['Incident Management', 'Incident Handling', 'Incident Resolution'],
  ['Change Management', 'Change Control'],
  ['Google Workspace', 'G Suite', 'Google Apps'],
  ['Cisco', 'Cisco Systems', 'Cisco Networking'],
  ['CompTIA A+', 'CompTIA A Plus', 'A+ Certified'],
  ['CompTIA Network+', 'CompTIA Network Plus', 'Network+'],
  ['CompTIA Security+', 'CompTIA Security Plus', 'Security+'],
];

// ── Subtitle detection ────────────────────────────────────────────────────────
// Scans first 6 non-empty lines of extracted CV text for a job-title-like line.
function detectSubtitle(cvText) {
  const lines = cvText.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 1; i < Math.min(8, lines.length); i++) {
    const l = lines[i];
    // Skip email, phone, URL, LinkedIn, location-like lines
    if (/@/.test(l)) continue;
    if (/^https?:\/\//i.test(l)) continue;
    if (/linkedin\.com/i.test(l)) continue;
    if (/^\+?\d[\d\s\-().]{6,}$/.test(l)) continue; // looks like a phone
    if (/\d{5,}/.test(l)) continue;    // long number string
    if (/[|•,]/.test(l)) continue;     // looks like a contact info line
    // Accept: short-ish, letter-dominant line that looks like a title
    if (l.length >= 4 && l.length <= 80 && /[a-zA-Z]{3}/.test(l)) return l;
  }
  return null;
}

// ── Synonym replacement list ──────────────────────────────────────────────────
// Produces [[fromTerm, toTerm], ...] pairs.
// A swap is only proposed when the JD-preferred term is missing from the CV
// AND one of its synonyms IS present in the CV.
function buildSynonymSwaps(cvText, missingKeywords) {
  if (!missingKeywords || missingKeywords.length === 0) return [];
  const lowerCv = cvText.toLowerCase();
  const swaps   = [];
  const seen    = new Set(); // avoid double-swapping same source term

  for (const missing of missingKeywords) {
    const lm = missing.toLowerCase();
    const group = SYNONYM_GROUPS.find(g => g.some(t => t.toLowerCase() === lm));
    if (!group) continue;

    for (const synonym of group) {
      const ls = synonym.toLowerCase();
      if (ls === lm) continue;                 // skip the missing term itself
      if (seen.has(ls)) continue;              // already queued this synonym
      if (lowerCv.includes(ls)) {
        swaps.push([synonym, missing]);
        seen.add(ls);
        break;
      }
    }
  }
  return swaps;
}

// ── XML text-node replacement ─────────────────────────────────────────────────
// Only touches content inside <w:t>…</w:t> — never the XML structure itself.
function applyXmlReplacements(xml, pairs) {
  if (pairs.length === 0) return xml;

  return xml.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (match, attrs, text) => {
    if (!text) return match;
    let out = text;
    for (const [from, to] of pairs) {
      if (!from || !to) continue;
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Word-boundary match, case-insensitive
      const re = new RegExp(`(?<![\\w/])${escaped}(?![\\w/])`, 'gi');
      out = out.replace(re, to);
    }
    return `<w:t${attrs}>${out}</w:t>`;
  });
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param {string} inputPath      – source DOCX path (original CV file)
 * @param {string} outputPath     – destination DOCX path (tailored copy)
 * @param {string} cvText         – plain-text extraction of the CV (for subtitle/synonym detection)
 * @param {string} jobTitle       – job.title from the queue (used for subtitle swap)
 * @param {string[]} missingKeywords – keywords present in JD but not in CV (from scorer)
 * @returns {{ subtitleSwapped: boolean, synonymsSwapped: string[] }}
 */
async function lightTailorDocx(inputPath, outputPath, cvText, jobTitle, missingKeywords) {
  // Ensure output dir exists
  const outDir = require('path').dirname(outputPath);
  if (!require('fs').existsSync(outDir)) require('fs').mkdirSync(outDir, { recursive: true });

  const buffer = fs.readFileSync(inputPath);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // Not a valid ZIP/DOCX — fall back to plain copy
    fs.copyFileSync(inputPath, outputPath);
    return { subtitleSwapped: false, synonymsSwapped: [] };
  }

  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    fs.copyFileSync(inputPath, outputPath);
    return { subtitleSwapped: false, synonymsSwapped: [] };
  }

  let xml = await docFile.async('string');
  const replacements = [];

  // 1. Subtitle swap
  const subtitle       = cvText ? detectSubtitle(cvText) : null;
  const cleanJobTitle  = jobTitle ? jobTitle.split('\n')[0].trim().substring(0, 80) : null;
  let subtitleSwapped  = false;

  if (subtitle && cleanJobTitle && subtitle.toLowerCase() !== cleanJobTitle.toLowerCase()) {
    replacements.push([subtitle, cleanJobTitle]);
    subtitleSwapped = true;
    console.log(`  [LightTailor] Subtitle: "${subtitle}" → "${cleanJobTitle}"`);
  }

  // 2. Synonym swaps
  const synonymSwaps = buildSynonymSwaps(cvText || '', missingKeywords || []);
  for (const [from, to] of synonymSwaps) {
    console.log(`  [LightTailor] Synonym: "${from}" → "${to}"`);
  }
  replacements.push(...synonymSwaps);

  // Apply all replacements
  if (replacements.length > 0) {
    xml = applyXmlReplacements(xml, replacements);
    zip.file('word/document.xml', xml);
    const out = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    fs.writeFileSync(outputPath, out);
  } else {
    // Nothing to change — just copy the original
    fs.copyFileSync(inputPath, outputPath);
  }

  return {
    subtitleSwapped,
    synonymsSwapped: synonymSwaps.map(([f, t]) => `${f} → ${t}`),
  };
}

module.exports = { lightTailorDocx };
