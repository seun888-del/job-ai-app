// AI fallback for job-application form questions.
//
// The deterministic answerers in linkedin.js / reed.js resolve the ~15 common
// question types by regex. Everything else previously got SKIPPED (left blank →
// validation error → the job was abandoned) or filled with a blunt "Yes" /
// first-option guess. This module is the fallback: when the deterministic rules
// don't match a question, ask the LICENSED backend LLM to pick the best option
// (or write a short answer) from the candidate's profile.
//
// HARD RULE — legally / financially sensitive questions (sponsorship, right to
// work / visa, background checks, salary, EEO gender/ethnicity/disability/
// veteran, nationality) are NEVER routed to the model. Those stay 100% on
// sensitiveYesNo() / resolveDropdownChoice() in the callers, which answer only
// from the user's own profile. isSensitiveQuestion() below is a second safety
// net so a mis-integration can't leak one of them to the LLM.
//
// Everything degrades gracefully: no license (dev) → aiEnabled() is false and we
// never call out; a backend error / rate-limit / timeout → we catch and return
// null, and the caller keeps its existing deterministic fallback.

const cfg = require('../config');
// Reuse the app's single LLM client (routes through the licensed backend). Held
// as the module object — not destructured — so `llm.llmChat` is resolved at call
// time (keeps prod behaviour and lets tests swap the implementation).
let llm = null;
try { llm = require('../../src/services/llm'); } catch (_) { llm = null; }

// Cache answers within a run so the same question isn't re-sent to the LLM (the
// #2 retry pass, or the same question recurring across jobs). Keyed by a
// normalised hash of question + option set.
const _cache = new Map();

// Lazily decide whether AI is reachable at all: a shipped build always has a
// license key in env; dev needs JOBBOT_ALLOW_LOCAL_LLM. If neither, stay off and
// never attempt a call (keeps the bot fast + silent when AI is unavailable).
let _enabled = null;
function aiEnabled() {
  if (_enabled === null) {
    _enabled = !!(llm && typeof llm.llmChat === 'function') &&
      (!!process.env.JOBBOT_LICENSE_KEY || !!process.env.JOBBOT_ALLOW_LOCAL_LLM);
  }
  return _enabled;
}

// Second safety net — the callers already keep these on profile-only logic, but
// refuse here too so a future mis-wiring can never send them to the model.
const SENSITIVE_RE = /sponsor|right to work|work permit|\bvisa\b|authoris|authoriz|eligible.*work|entitled to work|permit to work|background check|criminal|\bdbs\b|security clearance|\bgender\b|\bsex\b|ethnic|\brace\b|racial|disab|veteran|sexual orientation|nationality|citizen|salary|compensation|remuneration/i;
// Personal-name fields must come from the profile, never the model — otherwise the
// LLM invents a random name (e.g. it filled a made-up middle name on LinkedIn).
const NAME_RE = /\b(first|middle|last|given|family|sur|fore)\s*name\b|surname|forename|full name|your name|legal name|preferred name|middle initial/i;
function isSensitiveQuestion(q) { return SENSITIVE_RE.test(q || '') || NAME_RE.test(q || ''); }

function _key(kind, question, options) {
  const opt = (options || []).map(o => (o && o.text) || '').join('|');
  return `${kind}::${(question || '').toLowerCase().trim()}::${opt}`.slice(0, 600);
}

function _profileBlock(job) {
  const a = cfg.APPLICANT || {};
  const lines = [
    `- Years of professional experience: ${a.yearsExperience ?? 0}`,
    a.location ? `- Location: ${a.location}` : '',
    a.experienceLevel ? `- Seniority: ${a.experienceLevel}` : '',
    `- Notice period / availability: ${a.availability || 'immediately'}`,
    `- Willing to relocate: ${a.willingToRelocate ? 'yes' : 'no'}`,
    `- Holds a driving licence: ${a.drivingLicence ? 'yes' : 'no'}`,
  ];
  if (job && (job.title || job.company)) {
    lines.push(`- Applying for: ${job.title || 'a role'}${job.company ? ' at ' + job.company : ''}`);
  }
  return lines.filter(Boolean).join('\n');
}

// Pull the first JSON object out of a possibly chatty reply.
function _extractJson(s) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Match the LLM's chosen text back to one of the option objects (exact →
// substring → shared number). Returns the SAME object the caller passed in.
function _matchOption(choice, opts) {
  const c = (choice || '').toLowerCase().trim();
  if (!c) return null;
  let m = opts.find(o => (o.text || '').toLowerCase().trim() === c);
  if (m) return m;
  m = opts.find(o => { const t = (o.text || '').toLowerCase().trim(); return t && (t.includes(c) || c.includes(t)); });
  if (m) return m;
  const cn = c.match(/\d+/);
  if (cn) { m = opts.find(o => (o.text || '').includes(cn[0])); if (m) return m; }
  // Yes/No sentiment: a verbose model answer ("I do have strong skills",
  // "Absolutely") should still map to the Yes/No option rather than falling
  // through to null (which left a required radio blank → stuck form).
  const yesOpt = opts.find(o => /^\s*yes\b/i.test(o.text || ''));
  const noOpt  = opts.find(o => /^\s*no\b/i.test(o.text || ''));
  if (yesOpt || noOpt) {
    const neg = /\b(no|not|never|don'?t|doesn'?t|can'?t|cannot|haven'?t|hasn'?t|unable|false)\b/.test(c);
    const pos = /\b(yes|yeah|yep|i do|i have|i am|i can|absolutely|certainly|of course|sure|correct|true|agree|indeed)\b/.test(c);
    if (neg && noOpt) return noOpt;   // negation wins ("I do not have" → No)
    if (pos && yesOpt) return yesOpt;
  }
  return null;
}

const TIMEOUT_MS = 25000;

// Pick one option for a choice question (radio / dropdown / select).
// options: [{ text, ...anything }] — returns the SAME object that best matches
// the LLM's choice, or null (caller keeps its own deterministic fallback).
async function aiPickOption({ question, options, job, kind = 'field' }) {
  try {
    if (!aiEnabled()) return null;
    const q = (question || '').trim();
    if (q.length < 3) return null;
    if (isSensitiveQuestion(q)) return null; // never send sensitive to the model
    const opts = (options || []).filter(o => o && (o.text || '').trim());
    if (opts.length < 2) return null;

    const ck = _key('opt:' + kind, q, opts);
    if (_cache.has(ck)) return _matchOption(_cache.get(ck), opts);

    const list = opts.map((o, i) => `${i + 1}. ${o.text}`).join('\n');
    const prompt =
`You are completing a job application form for the candidate below. Choose the SINGLE best answer option for the question so this strong, employable candidate progresses in the application. For capability or willingness questions the candidate can reasonably meet, prefer an affirmative answer. For amount/experience questions, choose the option that matches the candidate's profile.

CANDIDATE PROFILE:
${_profileBlock(job)}

QUESTION: ${q}

OPTIONS:
${list}

Respond with ONLY JSON: {"choice": "<the exact option text you picked>"}. The value MUST be copied verbatim from the OPTIONS list above.`;

    const reply = await llm.llmChat(prompt, TIMEOUT_MS);
    const parsed = _extractJson(reply);
    const choice = parsed && parsed.choice != null ? String(parsed.choice) : '';
    if (!choice) return null;
    _cache.set(ck, choice);
    return _matchOption(choice, opts);
  } catch (err) {
    console.log(`  [AI] option fallback failed: ${(err && err.message) || err}`);
    return null;
  }
}

// Free-text answer for a text input or textarea. `long` → allow a short
// paragraph (textarea); otherwise keep it to a few words / a number (single-line
// input). Returns a string, or null (caller keeps its own fallback).
async function aiTextAnswer({ question, job, long = false }) {
  try {
    if (!aiEnabled()) return null;
    const q = (question || '').trim();
    if (q.length < 3) return null;
    if (isSensitiveQuestion(q)) return null;

    const ck = _key(long ? 'ta' : 'txt', q, null);
    if (_cache.has(ck)) return _cache.get(ck);

    const shape = long
      ? 'Write a concise, professional answer of 2-4 sentences.'
      : 'Answer in a few words or a single number only (no full sentence unless essential).';
    const prompt =
`Answer this job application question for the candidate below, truthfully and positively, to help them progress. ${shape}

CANDIDATE PROFILE:
${_profileBlock(job)}

QUESTION: ${q}

Respond with ONLY the answer text — no preamble, no quotes, no labels.`;

    let reply = ((await llm.llmChat(prompt, TIMEOUT_MS)) || '').trim();
    reply = reply.replace(/^["'\s]+|["'\s]+$/g, '');
    if (!reply) return null;
    if (!long && reply.length > 120) reply = reply.split(/[.\n]/)[0].slice(0, 120).trim();
    if (!reply) return null;
    _cache.set(ck, reply);
    return reply;
  } catch (err) {
    console.log(`  [AI] text fallback failed: ${(err && err.message) || err}`);
    return null;
  }
}

// Answer MANY form fields in ONE call, using a full data "payload" about the candidate
// (their saved NHS/Trac details + profile) rather than one question at a time with little
// context. Each field: { id, label, kind, options?[] }. Returns { id: value } for the fields
// the model could answer from the payload; missing/unknown → omitted (never invented).
// Sensitive questions (legal / equality) are filtered out here as a second safety net;
// the caller answers those from the user's own stored values.
async function aiFillFields({ fields, payload, job }) {
  if (!aiEnabled() || !Array.isArray(fields) || !fields.length) return {};
  // Reuse answers already given this session: the same question ("working with people",
  // "an example of flexibility") comes up on form after form, so ask the AI only once.
  const out = {};
  const keyOf = (f) => 'ff:' + String(f.label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200) + '|' + (f.options || []).join('/').toLowerCase();
  const safe = fields.filter((f) => f && f.label && !isSensitiveQuestion(f.label)).filter((f) => {
    const hit = _cache.get(keyOf(f));
    if (hit) { out[f.id] = hit; return false; }
    return true;
  });
  if (!safe.length) return out;
  const list = safe.map((f) => ({ id: f.id, question: String(f.label).slice(0, 300), type: f.kind, ...(f.options && f.options.length ? { options: f.options.slice(0, 40) } : {}) }));
  const prompt = `You are completing an NHS job application form (Trac) on behalf of the candidate below. Answer each form field using ONLY the candidate's data.

CANDIDATE DATA (JSON):
${JSON.stringify(payload || {}).slice(0, 7000)}

JOB: ${(job && job.title) || ''}${job && job.company ? ' at ' + job.company : ''}

FORM FIELDS (JSON):
${JSON.stringify(list)}

RULES:
- For a field with "options", the value MUST be the exact text of one option.
- For a text field, give just the value (no labels, no quotes around it).
- For a free-text question about the candidate's experience or suitability, write 2 to 4 first-person sentences grounded in their employment history. British English. No em or en dashes.
- If the data does not contain the answer and it cannot be clearly derived from it (addresses, dates, phone numbers, registration numbers you do not have), use null. NEVER invent facts.
- Yes/No questions about standard declarations or confirmations (e.g. "I confirm the information is true") are answered "Yes".

Return ONLY JSON: {"answers":[{"id":<id>,"value":<string or null>}]}`;
  try {
    const raw = await llm.llmChat(prompt, Number(process.env.JOBBOT_AIFILL_MS || 60000)); if (process.env.JOBBOT_AIFILL_DEBUG) console.log('RAW', String(raw).slice(0, 800));
    const j = _extractJson(raw);
    const byId = new Map(safe.map((f) => [String(f.id), f]));
    for (const a of (j && Array.isArray(j.answers) ? j.answers : [])) {
      if (a && a.id != null && a.value != null && String(a.value).trim() && !/^null$/i.test(String(a.value).trim())) {
        out[a.id] = String(a.value).replace(/\s*[—–]\s*/g, ', ').trim();
        const f = byId.get(String(a.id)); if (f) _cache.set(keyOf(f), out[a.id]);
      }
    }
    return out;
  } catch (e) { console.log('  [AI] Form answers failed: ' + (e && e.message ? e.message : e)); return out; }
}

module.exports = { aiPickOption, aiTextAnswer, aiFillFields, isSensitiveQuestion, aiEnabled, _matchOption };
