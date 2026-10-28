/**
 * cv_tailor_structured.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tailors a parsed CV object (cv_parser.js) to a specific job description, then
 * hands the object to cv_pdf_writer.writeStructuredPDF for rendering.
 *
 * Tailoring rewrites the CV to read naturally to a recruiter (not just to pass
 * ATS keyword filters) while never inventing experience:
 *   • subtitle  → mirror the JD's job title
 *   • profile   → rewrite the summary into natural, role-targeted prose (truthful)
 *   • bullets   → SELECT the most relevant bullets per role, then rewrite each into
 *                 natural, outcome-led prose using the JD's terminology
 *   • skills    → reorder categories by JD relevance, then weave in any genuine
 *                 missing JD keywords that aren't fabricated
 *   • education / name / contact → untouched
 *
 * The anti-fabrication verifier guards every rewrite: any bullet or summary that
 * introduces a tool, number, certification, or claim absent from the candidate's
 * own CV is rejected and the original field is kept.
 *
 * Every step validates the LLM output and falls back to the original field on any
 * malformed or suspicious response, so a bad model reply can never corrupt the CV.
 */

const { llmAvailable, llmChat } = require('../../src/services/llm');
const { focusJD } = require('./jd_focus');

// Bullets per role by recency: latest job 6, the one before 5, the next 4, older jobs 3.
// The bullets kept are the ones that best match the advert, a bullet with a result
// (a number) is always kept, and every role keeps at least 2, so no job disappears.
const BULLETS_BY_ROLE = [6, 5, 4];
const bulletCap = (roleIndex) => BULLETS_BY_ROLE[roleIndex] || 3;
const hasResult = (b) => /\d/.test(String(b).replace(/\b(19|20)\d{2}\b/g, ''));
const numbersIn = (t) => (String(t).match(/\d[\d,]*\.?\d*%?/g) || []).map((n) => n.replace(/,/g, ''));
const REFUSAL_RE = /\b(cannot|can't|i'm sorry|i am sorry|unable to|not able to|as an ai)\b/i;

// Empty CV clichés that read as filler to a recruiter — banned from every rewrite.
const CLICHE_BAN = 'Never use empty CV clichés such as "hardworking", "team player", "results-driven", "detail-oriented", "go-getter", "passionate", "self-starter", "dynamic", "proactive", "synergy", "proven ability", "proven track record" or "thought leader".';


// ── Subtitle ────────────────────────────────────────────────────────────────
// The advert's own job title, cleaned in code: "Linux Desktop Support Engineer (London UK
// office)" -> "Linux Desktop Support Engineer", "Senior Support Engineer II" -> "Senior Support
// Engineer". The AI version produced fragments like "Enterprise Service Desk".
function headlineFromJobTitle(jobTitle, fallback) {
  const t = String(jobTitle || '')
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .split(/\s+[-–—|]\s+/)[0]
    .replace(/\s+(I{1,3}|IV|[1-4])\s*$/, '')
    .replace(/\s{2,}/g, ' ').trim().replace(/[,;:]+$/, '');
  return t.length >= 3 && t.split(/\s+/).length <= 8 ? t : fallback;
}

// ── House style ─────────────────────────────────────────────────────────────
// One consistent style across original and reworded lines, so the CV never reads as
// half machine-written: capital first letter, no full stop at the end, UK spelling for UK users.
const US_TO_UK = [
  [/\b(standardi|optimi|prioriti|organi|utili|reali|speciali|recogni|summari|categori|centrali|customi|minimi|maximi|authori|digiti|moderni|stabili|visuali|synchroni|initiali|capitali|familiari|emphasi|criti)z(e|es|ed|ing|ation|ations)\b/gi, '$1s$2'],
  [/\b(colo|behavio|favo|hono|labo|neighbo)r(s|ed|ing)?\b/gi, '$1ur$2'],
  [/\bcenter(s|ed)?\b/gi, 'centre$1'],
  [/\bcatalog(s)?\b/gi, 'catalogue$1'],
  [/\benroll(s|ment)?\b/gi, 'enrol$1'],
];
function houseStyle(line, uk) {
  let t = String(line || '').trim().replace(/\s{2,}/g, ' ');
  t = t.replace(/\btroubleshooted\b/gi, (m) => (m[0] === 'T' ? 'Troubleshot' : 'troubleshot'));
  if (uk) for (const [re, to] of US_TO_UK) t = t.replace(re, to);
  t = t.replace(/[.;]+$/, '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// ── Professional summary ─────────────────────────────────────────────────────
// Rewrites the top-of-CV summary so it speaks to THIS job and reads naturally to
// a recruiter. Truthful: the same anti-fabrication verifier (see below) rejects
// any summary that introduces a tool/number/cert the CV doesn't already support,
// falling back to the original. Kept to a single paragraph for the layout.
async function tailorProfile(profile, jobTitle, jdExcerpt, corpus, kwLine = '') {
  if (!profile || profile.trim().length < 30) return profile;
  const prompt = `You are rewriting the professional summary at the top of a candidate's CV so it speaks directly to a specific job and reads naturally to a recruiter. Summarise ONLY what the CV already demonstrates — never inflate.

JOB TITLE: ${jobTitle}

JOB DESCRIPTION (excerpt):
${jdExcerpt}

CURRENT SUMMARY:
${profile}
${kwLine}
Write a NEW summary of exactly 3 sentences, 45 to 75 words in total, that a recruiter for THIS job reads in five seconds:
1. Who they are for this role: their years of experience and their core area, in the advert's words where those words are true of them.
2. Their single most relevant piece of proof for this job, taken from the CV below, including a real result or number if the CV gives one. Keep each result tied to what actually produced it in the CV.
3. The two or three strengths from the CV that this advert asks for most.
No "I", no first person, no bullet points, no buzzwords, no list of every tool they know.

${CLICHE_BAN}

Absolute rules:
- Use only facts in the CV. Do NOT invent or imply any tool, technology, sector, certification, metric, number, seniority, or years of experience the CV does not already state.
- Every number must appear in the CV exactly as written.
Return ONLY the summary as a single paragraph — no label, no quotes, no commentary.

THE CANDIDATE'S CV (the only source of facts):
${String(corpus).slice(0, 6000)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = (await llmChat(prompt, 30000)) || '';
      const para = raw.replace(/^\s*(summary|profile)\s*[:\-]\s*/i, '').replace(/\s*\n+\s*/g, ' ').replace(/^["']+|["']+$/g, '').trim();
      const words = para.split(/\s+/).length;
      const why = words < 30 || words > 95 ? `${words} words` : REFUSAL_RE.test(para.slice(0, 120)) ? 'refusal' : introducesNewFacts(corpus, para) ? `new claim (${newFactsIn(corpus, para).join(', ')})` : '';
      if (!why) return para;
      console.log(`  [Tailor] Summary rewrite rejected: ${why}`);
    } catch (_) {}
  }
  return profile;
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
  // Also index each word without trailing/leading punctuation, so a tool ending a
  // sentence ("...and ServiceNow.") still counts as present.
  for (const w of [...words]) words.add(w.replace(/^[./-]+|[./-]+$/g, ''));
  for (const n of (low.match(/\d[\d,]*\.?\d*%?/g) || [])) words.add(n.replace(/,/g, ''));
  return words;
}

// Claims a recruiter takes at face value that the model likes to borrow from the
// advert: contact channels, sectors and work patterns. Rejected unless the CV says so.
const CLAIM_PHRASES = ['phone', 'telephone', 'live chat', 'face to face', 'in person', 'public sector',
  'private sector', 'financial services', 'healthcare', 'nhs', 'charity', 'retail', 'education',
  'hybrid', 'start-up', 'startup', 'agency'];
const hasPhrase = (text, p, flags) => new RegExp('(^|[^A-Za-z0-9])' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', flags).test(text);

// Capitalised words written mid-sentence ("supported Teams users in London") are
// names: they must appear in the CV with the same capitals ("teams" is not "Teams").
function midSentenceNames(text) {
  const out = new Set();
  for (const sentence of String(text).split(/(?<=[.!?:;])\s+/)) {
    sentence.split(/\s+/).forEach((w, i) => {
      const t = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
      if (i > 0 && /^[A-Z][a-z]/.test(t)) out.add(t);
    });
  }
  return out;
}

// The tools, numbers, names and claims in `reworded` that the original text doesn't support.
function newFactsIn(originalCorpus, reworded) {
  const orig = originalIndex(originalCorpus);
  const out = [];
  for (const tok of significantTokens(reworded)) if (!orig.has(tok)) out.push(tok);
  for (const p of CLAIM_PHRASES) if (hasPhrase(reworded, p, 'i') && !hasPhrase(originalCorpus, p, 'i')) out.push(p);
  for (const name of midSentenceNames(reworded)) if (!hasPhrase(originalCorpus, name, '')) out.push(name);
  return out;
}
function introducesNewFacts(originalCorpus, reworded) { return newFactsIn(originalCorpus, reworded).length > 0; }

// ── JD keyword biasing ───────────────────────────────────────────────────────
// Common words that carry no signal when matching a bullet to a job advert.
const JD_STOPWORDS = new Set(
  ('the a an and or but to of in for with on at by from as is are be been being will would ' +
   'you your we our us they them their this that these those it its role job jobs work works working ' +
   'team teams within across including etc via using use used able ability who which what when where ' +
   'have has had do does did can could should would must may also more most other others any all such ' +
   'into over under out up down off per each both than then so if not no yes new good strong ' +
   'candidate applicant experience experienced skills skill responsibilities requirements essential ' +
   'desirable please apply application day days week weeks month months year years ideal successful')
    .split(/\s+/)
);

function jdKeywordSet(jdExcerpt) {
  const set = new Set();
  for (const w of (String(jdExcerpt).toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) || [])) {
    if (!JD_STOPWORDS.has(w)) set.add(w);
  }
  return set;
}

// How many DISTINCT JD terms a bullet already contains (word-boundary matches).
function bulletJDScore(bullet, jdSet) {
  const seen = new Set();
  for (const w of (String(bullet).toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) || [])) {
    if (jdSet.has(w)) seen.add(w);
  }
  return seen.size;
}

// Select the most relevant bullets for a role AND genuinely rewrite each into
// natural, recruiter-grade prose tuned to the JD — without ever adding facts the
// candidate didn't state (the anti-fabrication verifier below enforces this).
// No-AI path: the same recency cap, keeping the bullets that best match the advert, unchanged.
// Most job-relevant first; a bullet with a result always makes the cut.
function rankBullets(bullets, jdSet, roleIndex) {
  const ranked = (bullets || []).map((b, i) => ({ b, i, s: bulletJDScore(b, jdSet) }))
    .sort((a, z) => z.s - a.s || a.i - z.i);
  const cap = Math.max(2, bulletCap(roleIndex));
  const keep = ranked.slice(0, cap);
  for (const r of ranked.slice(cap)) {
    if (!hasResult(r.b)) continue;
    const drop = [...keep].reverse().find((k) => !hasResult(k.b));
    if (drop) keep.splice(keep.indexOf(drop), 1, r);
  }
  return keep.sort((a, z) => z.s - a.s || a.i - z.i).map((r) => r.b);
}

function pickBullets(bullets, jdText, roleIndex) {
  return rankBullets(bullets, jdKeywordSet((jdText || '').substring(0, 3000)), roleIndex);
}

// The advert's wording for a skill counts as truthful in a bullet only when that bullet
// already names the skill in some form ("AD" -> "Active Directory"). Terms the CV has
// elsewhere (the skills list) are NOT allowed into a bullet that never mentioned them:
// that is how "Windows Server" got planted into an unrelated SOP bullet.
// Only short, plain wording can be swapped in ("tickets" -> "incidents"): a long advert phrase
// reads as pasted in, and a product name ("Azure AD" for "Active Directory") is a different claim.
// Only plain advert words may be swapped in: no product or tool names. A capitalised word
// or an acronym ("Kandji", "MDM") is a name the CV must already show, not a swap.
const swappable = (f) => f.split(/\s+/).length <= 3 && significantTokens(f).size === 0 && !/\b[A-Z][a-z]|\b[A-Z]{2,}\b/.test(f);
function bulletCorpus(orig, matched) {
  const forms = [];
  for (const k of matched || []) {
    const all = [k.term, ...(k.alts || [])].filter(Boolean);
    if (all.some((f) => hasPhrase(orig, f, 'i'))) forms.push(...all.filter(swappable));
  }
  return orig + (forms.length ? '  ' + forms.join('  ') : '');
}

// Why a reworded bullet isn't safe to use, or '' when it is.
function unsafeRewrite(orig, rw, matched) {
  if (!rw) return 'missing';
  const ow = orig.split(/\s+/).length, rwW = rw.split(/\s+/).length;
  if (rwW > Math.max(ow + 6, Math.round(ow * 1.3))) return 'longer';
  if (rwW < Math.min(ow, Math.round(ow * 0.6))) return 'lost detail';
  const nums = numbersIn(rw);
  if (numbersIn(orig).some((n) => !nums.includes(n))) return 'dropped a result';
  const pasted = (matched || []).flatMap((k) => [k.term, ...(k.alts || [])]).find((f) => f && f.split(/\s+/).length > 3 && hasPhrase(rw, f, 'i') && !hasPhrase(orig, f, 'i'));
  if (pasted) return `pasted advert phrase (${pasted})`;
  const added = newFactsIn(bulletCorpus(orig, matched), rw);
  return added.length ? `new claim (${added.join(', ')})` : '';
}

async function selectAndRewordBullets(role, jdExcerpt, roleIndex = 0, kw = {}) {
  const bullets = role.bullets || [];
  if (!bullets.length) return bullets;

  // The candidate's own bullets, most job-relevant first. Selection never changes wording.
  const ordered = rankBullets(bullets, jdKeywordSet(jdExcerpt), roleIndex);
  const indexed = ordered.map((b, i) => `[${i + 1}] ${b}`).join('\n');

  const prompt = `You are lightly editing a candidate's CV bullet points for one specific job. These are their real words and a recruiter should still recognise them as such. Most bullets need little or no change.

JOB DESCRIPTION (excerpt):
${jdExcerpt}

ROLE: ${role.title} at ${role.company}
ORIGINAL BULLETS:
${indexed}
${kw.line || ''}
For each bullet, in order, return exactly one line:
- If the bullet already reads well for this job, return it UNCHANGED.
- Otherwise make the smallest edit that helps: swap a word for the advert's word when it means exactly the same thing the bullet already says (e.g. "tickets" -> "incidents"), or move the part that matters most to this job to the front.
- Keep every tool, number, result and detail the bullet has. Never shorten it into a vaguer line.
- Never add a tool, system, skill, sector, number or claim the bullet itself doesn't state, even if the candidate has it elsewhere.
- Past tense for past roles; plain, natural English; no buzzwords.

${CLICHE_BAN}

Return exactly ${ordered.length} lines, one per bullet, each starting with "- ". No numbering, no commentary.`;

  try {
    const out = await llmChat(prompt, 30000);
    if (REFUSAL_RE.test(out.slice(0, 120))) throw new Error('refusal');
    const lines = out.split('\n')
      .map(l => l.replace(/^\s*(?:\[\d+\]|[-•*]|\d+[.)])\s*/, '').trim())
      .filter(l => l.length > 15);
    // One edit per original, in order. An edit that is missing, longer, vaguer, drops a
    // result or adds anything the bullet didn't say is replaced by the original bullet.
    const reverted = [];
    const result = ordered.map((orig, i) => {
      const why = unsafeRewrite(orig, lines[i], kw.matched);
      if (!why) return lines[i];
      reverted.push(why); return orig;
    });
    if (reverted.length) console.log(`  [Tailor] ${role.company}: kept ${reverted.length} original bullet(s) (${reverted.join('; ')})`);
    return result;
  } catch (_) {}
  // Fallback: every original bullet, most job-relevant first, unmodified.
  return ordered;
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
  // Only skills the candidate's own CV already mentions (e.g. a tool named in a bullet
  // but missing from the skills list). Adding an advert tool they never used would be
  // a made-up claim, and Job-AI promises it only rewords what is in the CV.
  return !!cvText && hasPhrase(cvText, k, 'i');
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
// opts.matchedKeywords: the advert's keywords this CV already covers ({term, essential, alts}),
// from cv_scorer. The rewrites use their exact wording so the CV matches the advert's phrasing.
async function tailorStructured(cv, jobTitle, jdText, missingKeywords = [], cvFullText = '', opts = {}) {
  // Deep-ish clone so we never mutate the caller's base object
  const out = {
    name: cv.name,
    subtitle: cv.subtitle,
    contact: cv.contact,
    profile: cv.profile,
    strengths: [...(cv.strengths || [])],
    experience: (cv.experience || []).map(j => ({ ...j, bullets: [...(j.bullets || [])] })),
    skills: (cv.skills || []).map(s => ({ ...s })),
    education: (cv.education || []).map(e => ({ ...e })),
  };

  const uk = opts.uk !== false;
  const style = (t) => {
    out.subtitle = headlineFromJobTitle(jobTitle, cv.subtitle);
    out.profile = out.profile ? houseStyle(out.profile, uk) + '.' : out.profile;
    out.strengths = rankBullets(out.strengths, jdKeywordSet(focusJD(jdText, 3000)), 0).map((s) => houseStyle(s, uk));
    for (const role of out.experience) role.bullets = role.bullets.map((b) => houseStyle(b, uk));
    return t;
  };

  if (!await llmAvailable()) {
    console.log('  [Tailor] AI unavailable: keeping the CV as written, no JD tailoring');
    out.experience.forEach((role, i) => { role.bullets = pickBullets(role.bullets, jdText, i); });
    return style(out);
  }

  const jd = focusJD(jdText, 3000);
  const matched = (opts.matchedKeywords || []).filter((k) => k && k.term)
    .sort((a, z) => (z.essential ? 1 : 0) - (a.essential ? 1 : 0)).slice(0, 12);
  const kw = matched.length ? {
    line: `\nTERMS FROM THE ADVERT THAT THE CANDIDATE GENUINELY HAS (most important first). Wherever the original text means the same thing, you may use these words instead so the CV matches the advert's wording:\n${matched.filter((k) => k.term.split(/\s+/).length <= 3).map((k) => k.term).join(', ')}\n`,
    corpus: matched.map((k) => [k.term, ...(k.alts || [])].filter(swappable).join(' ')).join('  '),
    matched,
  } : {};

  // 1b. Professional summary — natural, recruiter-facing rewrite. The corpus is
  //     the WHOLE CV so the summary may legitimately reference real skills/tools
  //     from any section; the verifier still blocks anything the CV can't support.
  const corpus = [
    cv.profile || '',
    ...(cv.strengths || []),
    ...out.experience.flatMap(j => [j.title, j.company, ...(j.bullets || [])]),
    ...out.skills.map(s => `${s.label || ''} ${s.items || ''}`),
    cv.subtitle || '',
    kw.corpus || '',
  ].join('  ');
  out.profile = await tailorProfile(cv.profile, jobTitle, jd, corpus, kw.line || '');
  console.log(`  [Tailor] Summary ${out.profile === cv.profile ? 'kept original' : 'rewritten to JD'}`);

  // 2. Bullets — select most relevant per role AND lightly reword to the JD,
  //    rejecting any rewrite that introduces a new fact (sequential = rate-limit safe)
  for (const [i, role] of out.experience.entries()) {
    role.bullets = await selectAndRewordBullets(role, jd, i, kw);
  }
  console.log(`  [Tailor] Bullets selected + lightly reworded for ${out.experience.length} role(s)`);

  // 3. Skills — reorder then weave missing keywords
  out.skills = await reorderSkills(out.skills, jd);
  out.skills = weaveKeywordsIntoSkills(out.skills, missingKeywords, cvFullText || cv.profile + ' ' + JSON.stringify(cv));
  console.log('  [Tailor] Skills reordered + keywords woven');

  style(out);
  console.log(`  [Tailor] Headline → "${out.subtitle}"`);
  return out;
}

// Plain text of a tailored CV object, so it can be scored exactly as the employer will read it.
function structuredText(t) {
  return [t.subtitle, t.profile, ...(t.strengths || []),
    ...(t.experience || []).flatMap((j) => [j.title, j.company, ...(j.bullets || [])]),
    ...(t.skills || []).map((s) => `${s.label || ''} ${s.items || ''}`),
    ...(t.education || []).map((e) => Object.values(e || {}).filter((v) => typeof v === 'string').join(' ')),
  ].filter(Boolean).join('\n');
}

module.exports = { tailorStructured, structuredText, _test: { houseStyle, headlineFromJobTitle, unsafeRewrite, rankBullets, introducesNewFacts, isWeavable, significantTokens, originalIndex, midSentenceNames, hasPhrase, CLAIM_PHRASES } };
