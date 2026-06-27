/**
 * cv_tailor_structured.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tailors a parsed CV object (cv_parser.js) to a specific job description, then
 * hands the object to cv_pdf_writer.writeStructuredPDF for rendering.
 *
 * Tailoring is deliberately low-risk — it never invents experience:
 *   • subtitle  → mirror the JD's job title
 *   • bullets   → SELECT and reorder the most relevant existing bullets per role
 *                 (drops weak ones; never rewrites or fabricates)
 *   • skills    → reorder categories by JD relevance, then weave in any genuine
 *                 missing JD keywords that aren't fabricated
 *   • profile / education / name / contact → untouched
 *
 * Every step validates the LLM output and falls back to the original field on any
 * malformed or suspicious response, so a bad model reply can never corrupt the CV.
 */

const { llmAvailable, llmChat } = require('../../src/services/llm');

const MAX_BULLETS_PER_ROLE = 5;
const REFUSAL_RE = /\b(cannot|can't|i'm sorry|i am sorry|unable to|not able to|as an ai)\b/i;

function firstLine(s) { return String(s || '').split('\n').map(x => x.trim()).find(Boolean) || ''; }

// ── Subtitle ────────────────────────────────────────────────────────────────
async function tailorSubtitle(currentSubtitle, jobTitle, jdExcerpt) {
  const prompt = `You are updating the headline under a candidate's name on their CV to match a job they are applying for.

JOB TITLE: ${jobTitle}

CURRENT HEADLINE: ${currentSubtitle}

Return ONE short headline (3 to 7 words) that mirrors the job title above, optionally keeping a relevant second descriptor from the current headline. No quotes, no label, no explanation — just the headline text on a single line.`;
  try {
    const out = firstLine(await llmChat(prompt, 30000));
    const cleaned = out.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\*/g, '');
    if (cleaned && cleaned.length >= 3 && cleaned.length <= 70 && !REFUSAL_RE.test(cleaned)) {
      return cleaned;
    }
  } catch (_) {}
  return currentSubtitle;
}

// ── Bullet selection (per role) ──────────────────────────────────────────────
function parseIndexList(text, max) {
  // Pull the first JSON-ish array or any run of integers
  const nums = (String(text).match(/\d+/g) || []).map(n => parseInt(n, 10));
  const seen = new Set();
  const out = [];
  for (const n of nums) {
    if (n >= 0 && n < max && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// ── Anti-fabrication verifier ────────────────────────────────────────────────
// A reworded bullet may rephrase for emphasis, but it must not introduce any
// tool, system, acronym, product, or number that wasn't in the candidate's own
// original bullets for that role. We extract the "significant" tokens (numbers,
// acronyms, CamelCase/product names, version-style tokens) from the reworded
// line and reject it if any aren't present in the originals.
// Single-word product/company names worth guarding (multi-cap names like
// ServiceNow / SharePoint are already caught structurally below).
const KNOWN_TECH_NAME = /^(azure|aws|gcp|jira|confluence|servicenow|salesforce|sharepoint|purview|intune|jamf|sccm|entra|defender|okta|tableau|qlik|zendesk|freshdesk|citrix|vmware|windows|macos|linux|ubuntu|powershell|python|oracle|sap|workday|sophos|mcafee|kaspersky|cisco|fortinet|crowdstrike|kubernetes|docker|terraform|splunk)$/i;
const ORDINAL_RE = /^\d+(st|nd|rd|th)$/i;

// "Significant" = things that would be a fabricated claim if invented: numbers/
// metrics (not ordinals), ALL-CAPS acronyms, CamelCase product names, tokens
// containing a digit, and known single-word product names. Plain capitalised
// words (sentence-leading verbs like "Delivered") are deliberately ignored.
function significantTokens(text) {
  const t = String(text);
  const out = new Set();
  // numbers / metrics, ignoring ordinals (1st, 2nd, 3rd …)
  for (const raw of (t.match(/\d[\d,]*\.?\d*%?(?:st|nd|rd|th)?/gi) || [])) {
    if (ORDINAL_RE.test(raw)) continue;
    out.add(raw.replace(/,/g, '').toLowerCase());
  }
  // identifiers: ALL-CAPS (2+), CamelCase, digit-containing
  for (const tok of (t.match(/\b([A-Z]{2,}|[A-Z][a-z]+(?:[A-Z][A-Za-z]*)+|[A-Za-z]*\d[A-Za-z0-9+]*)\b/g) || [])) {
    if (ORDINAL_RE.test(tok)) continue;
    out.add(tok.toLowerCase());
  }
  // known single-word product / company names
  for (const w of (t.match(/[A-Za-z][A-Za-z+]+/g) || [])) {
    if (KNOWN_TECH_NAME.test(w)) out.add(w.toLowerCase());
  }
  return out;
}

// Index the originals as a set of whole words + comma-stripped numbers, so a
// token only counts as "present" on a real word boundary (no "AD" ⊂ "academic").
function originalIndex(text) {
  const low = String(text).toLowerCase();
  const words = new Set(low.match(/[a-z0-9+#./-]+/g) || []);
  for (const n of (low.match(/\d[\d,]*\.?\d*%?/g) || [])) words.add(n.replace(/,/g, ''));
  return words;
}

function introducesNewFacts(originalCorpus, reworded) {
  const orig = originalIndex(originalCorpus);
  for (const tok of significantTokens(reworded)) {
    if (!orig.has(tok)) return true;
  }
  return false;
}

// Select the most relevant bullets for a role AND lightly reword each to mirror
// the JD's terminology — without ever adding facts the candidate didn't state.
async function selectAndRewordBullets(role, jdExcerpt) {
  const bullets = role.bullets || [];
  if (!bullets.length) return bullets;

  const indexed   = bullets.map((b, i) => `[${i + 1}] ${b}`).join('\n');
  const originals = bullets.join('  ');   // corpus for the anti-fabrication check

  const prompt = `You are lightly tailoring CV bullet points to a specific job. This is rephrasing for emphasis — NOT a rewrite, and NOT invention.

JOB DESCRIPTION (excerpt):
${jdExcerpt}

ROLE: ${role.title} at ${role.company}
BULLET POINTS:
${indexed}

Task:
1. Choose up to ${MAX_BULLETS_PER_ROLE} bullets most relevant to the job, most relevant first.
2. Lightly reword each chosen bullet to use the job's terminology where it means the same thing.

Strict rules:
- Keep EVERY fact, tool, system, company, and number exactly as written — do not add, remove, or change any of them.
- Do NOT introduce any tool, technology, certification, metric, or claim that is not already in that bullet.
- Keep each bullet to a single concise line.
Return ONLY the chosen bullets, one per line, each starting with "- ". No numbering, no commentary.`;

  try {
    const out = await llmChat(prompt, 30000);
    if (REFUSAL_RE.test(out.slice(0, 120))) throw new Error('refusal');
    let lines = out.split('\n')
      .map(l => l.replace(/^\s*(?:\[\d+\]|[-•*]|\d+[.)])\s*/, '').trim())
      .filter(l => l.length > 15);
    // Drop any line that smuggles in a new tool/number/fact
    let safe = lines.filter(rw => !introducesNewFacts(originals, rw)).slice(0, MAX_BULLETS_PER_ROLE);
    if (safe.length >= Math.min(2, bullets.length)) {
      const dropped = lines.length - safe.length;
      if (dropped > 0) console.log(`  [Tailor] ${role.company}: rejected ${dropped} reworded bullet(s) that added new facts`);
      return safe;
    }
  } catch (_) {}
  // Fallback: keep the first N original bullets, unmodified
  return bullets.slice(0, MAX_BULLETS_PER_ROLE);
}

// ── Skills: reorder by JD relevance, then weave missing keywords ─────────────
async function reorderSkills(skills, jdExcerpt) {
  if (skills.length <= 2) return skills;
  const labels = skills.map((s, i) => `[${i}] ${s.label || s.items.slice(0, 30)}`).join('\n');
  const prompt = `Reorder CV skill categories so the most relevant to this job appear first.

JOB DESCRIPTION (excerpt):
${jdExcerpt}

SKILL CATEGORIES:
${labels}

Return ONLY the category numbers in your recommended order as a JSON array, e.g. [3, 0, 1, 2]. Include every number exactly once. No other text.`;
  try {
    const out = await llmChat(prompt, 30000);
    if (REFUSAL_RE.test(out.slice(0, 120))) throw new Error('refusal');
    const idx = parseIndexList(out, skills.length);
    if (idx.length === skills.length) return idx.map(i => skills[i]);
  } catch (_) {}
  return skills;
}

// Certifications / qualifications — NEVER weave these in. Claiming a cert the
// candidate doesn't hold is fabrication, not tailoring.
const CERT_RE = /\b(prince ?2|itil|pmp|prince2|cissp|comptia|a\+|network\+|security\+|mcsa|mcse|mcp|ccna|ccnp|ccie|ceh|cisa|cism|togaf|scrum master|psm|csm|safe agilist|six sigma|aws certified|azure certified|gcp certified|certified|certification|chartered|bachelor|master'?s|mba|diploma|nvq|btec|hnd|gcse|a-?level|degree|qualified|accredited)\b/i;

// Generic business / department / soft-skill words — look wrong dumped on a tools
// list and aren't concrete, verifiable skills.
const DOMAIN_BLOCK = new Set([
  'finance','financial','accounting','accountancy','marketing','sales','hr','human resources',
  'legal','procurement','logistics','operations','compliance','audit','payroll','recruitment',
  'administration','administrative','management','leadership','communication','communications',
  'stakeholder','stakeholders','budget','budgeting','strategy','strategic','governance','planning',
  'analysis','business','teamwork','collaboration','organisation','organization','negotiation',
  'presentation','customer service','problem solving','time management','attention to detail',
]);

// Tech tokens that mark a keyword as a genuine tool/technology worth weaving.
const TECH_HINT = /\b(sql|api|cloud|server|network|directory|azure|aws|gcp|google cloud|power\s?(bi|apps|automate|platform)|share\s?point|sharepoint|purview|microsoft|m365|office 365|365|intune|jamf|vpn|dns|dhcp|tcp\/ip|saas|itsm|servicenow|sccm|entra|defender|exchange|teams|outlook|active directory|okta|crowdstrike|tableau|qlik|jira|confluence|zendesk|freshdesk|salesforce|workspace|windows|macos|linux|vmware|citrix|hyper-?v|powershell|bash|python|endpoint|firewall|antivirus|backup|o365|onedrive)\b/i;

function isWeavable(kw, cvText) {
  const k = kw.trim();
  if (k.length < 2 || k.length > 40) return false;
  if (/[|?]/.test(k)) return false;
  if (CERT_RE.test(k)) return false;                       // no certifications
  const low = k.toLowerCase();
  if (DOMAIN_BLOCK.has(low)) return false;                 // no generic domain words
  if (low.split(/\s+/).length > 3) return false;           // no long phrases / responsibilities
  // Genuine if it already appears in the candidate's own CV text…
  if (cvText && cvText.toLowerCase().includes(low)) return true;
  // …otherwise only weave recognisable tools/technologies
  if (/[A-Z].*[A-Z]/.test(k) || /\d/.test(k)) return true; // CamelCase / acronym / version number
  return TECH_HINT.test(k);
}

// Pick the existing skills category that best fits the keywords (tool/SaaS-ish
// categories preferred); -1 means "make a new Additional Tools category".
function pickCategoryIndex(skills, keywords) {
  const kwTokens = new Set(keywords.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let best = -1, bestScore = 0;
  skills.forEach((s, i) => {
    const text = ((s.label || '') + ' ' + s.items).toLowerCase();
    let score = 0;
    for (const t of kwTokens) if (t.length >= 3 && text.includes(t)) score++;
    if (/tool|software|saas|application|platform|system|technolog/i.test(s.label || '')) score += 1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// Weave only genuine, tool-like JD keywords into a sensible category — never
// certifications, never off-domain/soft words, capped to stay credible.
function weaveKeywordsIntoSkills(skills, missingKeywords, cvFullText) {
  if (!skills.length || !missingKeywords || !missingKeywords.length) return skills;
  const seen = new Set();
  const add = missingKeywords
    .filter(k => typeof k === 'string')
    .map(k => k.trim())
    .filter(k => isWeavable(k, cvFullText))
    // not already shown anywhere in the skills section
    .filter(k => !skills.some(s => s.items.toLowerCase().includes(k.toLowerCase())))
    .filter(k => { const l = k.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; })
    .slice(0, 4);
  if (!add.length) return skills;

  const idx = pickCategoryIndex(skills, add);
  if (idx >= 0) {
    const target = skills[idx];
    target.items = `${target.items.replace(/[.,\s]+$/, '')}, ${add.join(', ')}`;
  } else {
    skills.push({ label: 'Additional Tools', items: add.join(', ') });
  }
  console.log(`  [Tailor] Wove ${add.length} keyword(s): ${add.join(', ')}`);
  return skills;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function tailorStructured(cv, jobTitle, jdText, missingKeywords = [], cvFullText = '') {
  // Deep-ish clone so we never mutate the caller's base object
  const out = {
    name: cv.name,
    subtitle: cv.subtitle,
    contact: cv.contact,
    profile: cv.profile,
    experience: (cv.experience || []).map(j => ({ ...j, bullets: [...(j.bullets || [])] })),
    skills: (cv.skills || []).map(s => ({ ...s })),
    education: (cv.education || []).map(e => ({ ...e })),
  };

  if (!await llmAvailable()) {
    console.log('  [Tailor] AI unavailable — capping bullets only, no JD tailoring');
    out.experience.forEach(j => { j.bullets = j.bullets.slice(0, MAX_BULLETS_PER_ROLE); });
    return out;
  }

  const jd = (jdText || '').substring(0, 3000);

  // 1. Subtitle
  out.subtitle = await tailorSubtitle(cv.subtitle, jobTitle, jd);
  console.log(`  [Tailor] Subtitle → "${out.subtitle}"`);

  // 2. Bullets — select most relevant per role AND lightly reword to the JD,
  //    rejecting any rewrite that introduces a new fact (sequential = rate-limit safe)
  for (const role of out.experience) {
    role.bullets = await selectAndRewordBullets(role, jd);
  }
  console.log(`  [Tailor] Bullets selected + lightly reworded for ${out.experience.length} role(s)`);

  // 3. Skills — reorder then weave missing keywords
  out.skills = await reorderSkills(out.skills, jd);
  out.skills = weaveKeywordsIntoSkills(out.skills, missingKeywords, cvFullText || cv.profile + ' ' + JSON.stringify(cv));
  console.log('  [Tailor] Skills reordered + keywords woven');

  return out;
}

module.exports = { tailorStructured };
