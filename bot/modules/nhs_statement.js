// NHS supporting statement ("Supporting information" on Trac), written the way shortlisting
// panels score it. Four steps, each a small job the model does reliably:
//
//   1. Vacancy map   - pull the person-spec criteria (essential/desirable, in order), the
//                      Trust's values and any word limit out of the advert.
//   2. Evidence map  - "tailor the CV": for each criterion, find the candidate's REAL evidence
//                      in their CV + Trac history, with a verbatim quote that is checked
//                      against the source. No quote found = no evidence (nothing invented).
//   3. Draft         - opening, one heading + STAR paragraph per criterion in the person
//                      spec's order, values shown through the examples, short close.
//   4. Audit         - mechanical checks (dashes, semicolons, banned words, numbers that are
//                      not in the source, essential criteria missing, length) and one
//                      targeted repair pass.
//
// Factual accuracy is a hard gate: the draft may only use facts from the evidence map.

const { llmAvailable, llmChat } = require('../../src/services/llm');
const cfg = require('../config');

const BANNED = ['passionate', 'team player', 'results-driven', 'hard-working', 'hardworking', 'leveraging', 'leverage', 'spearheading', 'spearheaded', 'seamlessly', 'seamless', 'dynamic', 'self-motivated', 'synergy', 'go-getter', 'thrive', 'fast-paced', 'delve', 'tapestry', 'testament', 'furthermore', 'moreover', 'in conclusion', 'i am writing to apply', 'great fit', 'perfect fit', 'insider knowledge', 'hit the ground running', 'blend of', 'wealth of', 'instrumental'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%£ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function parseJson(text) {
  const s = String(text || '').replace(/```(json)?/gi, '');
  for (const [a, b] of [['{', '}'], ['[', ']']]) {
    const i = s.indexOf(a), j = s.lastIndexOf(b);
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
  }
  return null;
}

// Everything we know the candidate has actually done: CV text + the Trac employment/education
// history they entered. This is the only material the statement may draw on.
function evidenceSource(cvText) {
  const d = cfg.TRAC_DETAILS || {};
  const jobs = (Array.isArray(d.employment) ? d.employment : []).map((e) => `${e.jobTitle || ''} at ${e.employer || 'employer'} (${e.start || ''} to ${e.end || 'present'}): ${e.duties || ''}`);
  const edu = (Array.isArray(d.education) ? d.education : []).map((e) => `${e.qualification || ''}, ${e.place || ''}${e.grade ? ', ' + e.grade : ''}${e.year ? ' (' + e.year + ')' : ''}`);
  return [String(cvText || '').slice(0, 4500), jobs.length ? 'EMPLOYMENT HISTORY:\n' + jobs.join('\n') : '', edu.length ? 'EDUCATION:\n' + edu.join('\n') : ''].filter(Boolean).join('\n\n');
}

// A quote counts only if most of its meaningful words really appear in the source.
function quoteInSource(quote, source) {
  const src = ' ' + norm(source) + ' ';
  const q = norm(quote).split(' ').filter((w) => w.length > 3);
  if (q.length < 2) return false;
  return q.filter((w) => src.includes(' ' + w + ' ') || src.includes(w)).length / q.length >= 0.75;
}

// Long adverts: keep the opening (role, Trust, values) and ALWAYS the person specification,
// which usually sits at the end.
function advertForModel(jd) {
  const t = String(jd || '');
  // Kept tight: the AI account has a per-minute token limit shared by every user.
  const at = t.search(/person specification|essential criteria|selection criteria/i);
  if (at > 1200) return t.slice(0, 1200) + '\n...\n' + t.slice(at, at + 7000);
  return t.slice(0, 8000);
}

// 1. Vacancy map
async function mapVacancy(jobTitle, employer, jd) {
  const prompt = `Read this NHS job advert and extract the shortlisting information as JSON.

JOB: ${jobTitle} at ${employer || 'the Trust'}
ADVERT:
${advertForModel(jd)}

Return ONLY this JSON:
{"trust": "employing organisation name", "band": "e.g. Band 5 or empty", "values": ["the Trust's own values if the advert names them, else empty"], "wordLimit": null or a number if the advert states a word limit for supporting information, "criteria": [{"id": 1, "type": "essential" or "desirable", "area": "qualifications|experience|knowledge|skills|values|other", "text": "the criterion, as worded in the person specification, max 18 words"}]}

Rules: take criteria from the person specification (or essential/desirable lists) in the order they appear. Include only criteria assessed at application or shortlisting (skip ones marked as assessed only at interview). If the advert has no person specification, derive up to 8 criteria from the main duties and requirements and mark them essential.`;
  let j = parseJson(await llmChat(prompt).catch(() => ''));
  if (!j || !Array.isArray(j.criteria) || !j.criteria.length) j = parseJson(await llmChat(prompt).catch(() => '')); // one retry
  if (!j || !Array.isArray(j.criteria) || !j.criteria.length) return null;
  j.criteria = j.criteria.filter((c) => c && c.text).slice(0, 20).map((c, i) => ({ id: i + 1, type: /desir/i.test(c.type) ? 'desirable' : 'essential', area: c.area || '', text: String(c.text).trim() }));
  j.values = (Array.isArray(j.values) ? j.values : []).filter(Boolean).slice(0, 8);
  return j;
}

// 2. Evidence map (the CV tailored to this person spec)
async function mapEvidence(criteria, source) {
  const prompt = `You are matching a job candidate's REAL experience to NHS person specification criteria.

CRITERIA:
${criteria.map((c) => `${c.id}. [${c.type}] ${c.text}`).join('\n')}

CANDIDATE SOURCE (CV and work history, the only facts you may use):
${source}

For each criterion return what the candidate has actually done that proves it. Return ONLY a JSON array:
[{"id": 1, "strength": "strong" | "partial" | "none", "evidence": "1 to 2 sentences restating what the candidate did, where, and the result, using numbers exactly as the source gives them", "quote": "a short phrase copied word for word from the SOURCE that supports it"}]

Rules: never infer a skill, system, qualification or number the source does not state. "partial" means related or transferable experience. If nothing supports it, strength "none" and empty evidence.`;
  let arr = parseJson(await llmChat(prompt).catch(() => ''));
  if (!Array.isArray(arr) || !arr.length) arr = parseJson(await llmChat(prompt).catch(() => '')); // one retry
  // Unreadable answer is NOT "no evidence": stop here so the job isn't wrongly skipped.
  if (!Array.isArray(arr) || !arr.length) throw new Error('evidence map unreadable');
  const byId = new Map((Array.isArray(arr) ? arr : []).map((e) => [Number(e.id), e]));
  return criteria.map((c) => {
    const e = byId.get(c.id) || {};
    let strength = /strong|partial/.test(e.strength) ? e.strength : 'none';
    // Truth gate: the quote must really be in the candidate's material.
    if (strength !== 'none' && !quoteInSource(e.quote, source)) strength = 'none';
    return { ...c, strength, evidence: strength === 'none' ? '' : String(e.evidence || '').trim() };
  });
}

function targetWords(map) {
  const ess = map.filter((c) => c.type === 'essential' && c.strength !== 'none').length;
  const des = map.filter((c) => c.type === 'desirable' && c.strength !== 'none').length;
  return Math.max(400, Math.min(900, 130 + ess * 80 + des * 45));
}

// 3. Draft
async function draft(jobTitle, vac, map, limit, name) {
  const values = vac.values.length ? vac.values : ['working together for patients', 'respect and dignity', 'commitment to quality of care', 'compassion', 'improving lives', 'everyone counts'];
  const lines = (type) => map.filter((c) => c.type === type).map((c) => `- ${c.text}\n  ${c.strength === 'none' ? 'NO EVIDENCE' : `(${c.strength}) ${c.evidence}`}`).join('\n');
  const prompt = `Write the "Supporting information" section of an NHS application for ${name}.

ROLE: ${jobTitle}${vac.band ? ' (' + vac.band + ')' : ''}
EMPLOYER: ${vac.trust || 'the Trust'}
VALUES TO SHOW: ${values.join(', ')}

ESSENTIAL CRITERIA, in order, with the candidate's verified evidence:
${lines('essential')}

DESIRABLE CRITERIA, with evidence:
${lines('desirable') || '(none)'}

STRUCTURE:
1. Opening, 2 sentences: the role and ${vac.trust || 'the Trust'}, and the candidate's most relevant concrete experience (years, type of work, setting). No general statements about the NHS.
2. For each ESSENTIAL criterion with evidence (leave out any with NO EVIDENCE, never claim them), in the order above: a short heading on its own line (the criterion in plain words, no numbering, no colon), then ONE paragraph of 3 to 5 sentences built around ONE specific example: the situation, what the candidate did, and the result or impact. Do not label the parts.
3. Each DESIRABLE criterion with evidence: a heading and 2 sentences. Leave out desirable criteria with no evidence entirely.
4. Show the values through what the candidate did. Name a value at most twice in the whole statement.
5. Close, 2 full sentences: what the candidate would bring to this team and that they would welcome the chance to discuss the role. Do not mention start dates, availability or notice periods. No sign-off.

WRITING STYLE (this is read by a human panel who reject robotic or AI-sounding text):
- First person, British English spelling (organisation, prioritise, programme).
- Natural, confident, plain English. Mix sentence lengths (roughly 10 to 25 words). Never start more than two sentences in a row with "I". Join related ideas with "and", "which", "so", "while", "after", "because".
- Every sentence must add a fact. No filler that only restates the criterion or praises the candidate (for example "This shows my commitment", "I learned to stay calm under pressure") unless the evidence says it.
- Use the person specification's key words so a shortlister can tick each line.
- Do not write a separate paragraph about values. Do not describe the candidate in the third person.
- Start at most one sentence per paragraph with "This". Do not end paragraphs with a sentence that only sums up or praises.
- Never refer to the CV or the application itself (no "I listed", "my CV shows").
- The statement MUST start with the opening paragraph, before the first heading.
- Use ONLY the facts in the evidence above. No new systems, qualifications, numbers, feelings, plans or achievements.
- NEVER invent an incident or story ("I recently resolved a...", "one time a user..."). If the evidence has no specific incident, describe the real duty, where it was done and its result as the evidence states it.
- Do not add a title line such as "Supporting Information".
- No semicolons. No em dashes or en dashes. No bullet points. No exclamation marks.
- Never use: ${BANNED.join(', ')}.
- About ${limit} words, never more than ${Math.round(limit * 1.1)}.

Return ONLY the statement text.`;
  return String(await llmChat(prompt).catch(() => '') || '').trim();
}

// 4. Audit + tidy
// Plain replacements for stock phrases the repair step sometimes leaves in.
const SWAPS = [
  [/\bpassionate about\b/gi, 'committed to'], [/\bpassionate\b/gi, 'committed'],
  [/\bleveraging\b/gi, 'using'], [/\bleverage(d)?\b/gi, 'use$1'], [/\bseamlessly\b/gi, 'smoothly'], [/\bseamless\b/gi, 'smooth'],
  [/\bspearhead(ed|ing)?\b/gi, 'led'], [/\bhard-?working\b/gi, 'reliable'], [/\bdynamic\b/gi, 'varied'],
  [/\bfast-paced\b/gi, 'busy'], [/\bresults-driven\b/gi, 'focused'], [/\bself-motivated\b/gi, 'independent'],
  [/\bteam player\b/gi, 'good colleague'], [/\bthrive\b/gi, 'work well'], [/\bfurthermore,?\s*/gi, ''], [/\bmoreover,?\s*/gi, ''],
  [/\bhit the ground running\b/gi, 'start quickly'], [/\binsider knowledge\b/gi, 'knowledge'], [/\bwealth of\b/gi, 'strong'],
  [/\binstrumental in\b/gi, 'part of'],
];

function tidy(text) {
  let t = String(text);
  for (const [re, rep] of SWAPS) t = t.replace(re, rep);
  // Re-capitalise a sentence start left lower-case by a removed opener ("Furthermore, the...").
  t = t.replace(/(^|[.!?]\s+|\n)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  return t
    .replace(/^\s*(supporting (information|statement)|personal statement)\s*\n/i, '')
    .replace(/(^|\n)Areas I am developing\n[\s\S]*?(?=\n\s*\n|$)/i, '')
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/;\s*([a-z])/g, (m, c) => '. ' + c.toUpperCase())
    .replace(/;/g, '.')
    .replace(/^\s*[*#-]+\s*/gm, '')          // stray markdown bullets / headings markers
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+([,.:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function audit(text, map, source, jd, limit) {
  const issues = [];
  const low = text.toLowerCase();
  const banned = BANNED.filter((b) => low.includes(b));
  if (banned.length) issues.push(`Remove these words/phrases: ${banned.join(', ')}.`);
  const known = norm(source + ' ' + jd);
  const nums = [...new Set((text.match(/£?\d[\d,.]*%?/g) || []).map((n) => n.replace(/[.,]$/, '')))];
  const unverified = nums.filter((n) => !known.includes(norm(n)) && !/^(19|20)\d\d$/.test(n));
  if (unverified.length) issues.push(`These numbers are not in the candidate's CV or history, remove or correct them: ${unverified.join(', ')}.`);
  const missing = map.filter((c) => c.type === 'essential' && c.strength !== 'none').filter((c) => {
    const keys = norm(c.text).split(' ').filter((w) => w.length > 5);
    return keys.length && !keys.some((k) => low.includes(k));
  });
  if (missing.length) issues.push(`These essential criteria are not clearly covered, add a heading and example for each: ${missing.map((c) => c.text).join(' | ')}.`);
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const firstLine = (blocks[0] || '').split('\n')[0];
  if (!/[.!?]$/.test(firstLine) || words(firstLine) < 12) issues.push("Add a 2 sentence opening paragraph BEFORE the first heading: the role and Trust, and the candidate's most relevant experience.");
  const last = blocks[blocks.length - 1] || '';
  if (!/welcome|discuss/i.test(last.split(/(?<=[.!?])\s+/).slice(-2).join(' ')) || !/[.!?]$/.test(last)) issues.push('Rewrite the final paragraph as 2 full first-person sentences: what the candidate would bring to the team, and that they would welcome the chance to discuss the role.');
  const n = words(text);
  if (n > limit * 1.2) issues.push(`Too long (${n} words). Cut to about ${limit} words, keeping every essential criterion.`);
  return { issues, unverified, wordCount: n, missing };
}

async function repair(text, issues) {
  const prompt = `Revise this NHS supporting statement to fix ONLY the issues listed. Keep everything else, including headings, facts and voice. Do not add any new facts, numbers or claims.

ISSUES:
${issues.map((i) => '- ' + i).join('\n')}

STATEMENT:
${text}

Return ONLY the revised statement.`;
  return String(await llmChat(prompt).catch(() => '') || '').trim();
}

// Fact-check: a separate pass lists every claim the candidate's material does not support
// (systems, tasks, scale, qualities presented as fact). The draft is then repaired once.
async function factCheck(text, source) {
  // Judge each sentence on its own (yes/no), which a model does far more strictly than an
  // open "list the problems" request. Headings and very short lines are skipped.
  const sents = [];
  text.split('\n').forEach((line) => { if (words(line) >= 6 && /[.!?]$/.test(line.trim())) line.split(/(?<=[.!?])\s+/).forEach((s) => { if (words(s) >= 5) sents.push(s.trim()); }); });
  if (!sents.length) return [];
  const prompt = `Fact-check each sentence of a job application against the candidate's own records.

CANDIDATE RECORDS (the only truth):
${source}

SENTENCES:
${sents.map((s, i) => `${i}. ${s}`).join('\n')}

A sentence is UNSUPPORTED if it states any specific fact the records do not state or clearly imply: a system, tool, task, responsibility, incident, story, number, qualification, sector, achievement, or a specific behaviour such as "prioritised clinical staff" or "managed escalated tickets". Links to NHS values, enthusiasm for the role and general closing lines are fine. Be strict.
Return ONLY JSON: {"unsupported": [sentence numbers]}`;
  const j = parseJson(await llmChat(prompt).catch(() => ''));
  const ids = Array.isArray(j && j.unsupported) ? j.unsupported.map(Number).filter((n) => Number.isInteger(n) && sents[n]) : [];
  return [...new Set(ids)].map((n) => sents[n]).slice(0, 15);
}

// Rewrite ONLY the sentences holding unsupported claims (or delete them), leaving the rest
// of the statement untouched.
async function fixSentences(text, phrases, source) {
  const sentences = [];
  text.split('\n').forEach((line, li) => line.split(/(?<=[.!?])\s+/).forEach((s) => { if (phrases.some((p) => s.includes(p.slice(0, 20)))) sentences.push(s); }));
  const uniq = [...new Set(sentences)].slice(0, 12);
  if (!uniq.length) return text;
  const prompt = `These sentences from a job application contain claims the candidate's records do not support. Rewrite each so it only states what the records support, keeping the same meaning where possible, first person, British English, same style. If nothing true can be said, return an empty string for it. No semicolons or dashes.

CANDIDATE RECORDS:
${source}

SENTENCES:
${uniq.map((s, i) => `${i}. ${s}`).join('\n')}

Return ONLY JSON: [{"i": 0, "rewrite": "..."}]`;
  const arr = parseJson(await llmChat(prompt).catch(() => ''));
  let out = text;
  for (const r of Array.isArray(arr) ? arr : []) {
    const orig = uniq[Number(r.i)];
    if (orig == null) continue;
    out = out.replace(orig, String(r.rewrite || '').trim());
  }
  return out.replace(/ {2,}/g, ' ');
}

// Last resort for length: shorten the longest body paragraph by its last sentence, again and
// again, never below 2 sentences, never touching headings, the opening or the close. Every
// criterion keeps its heading and evidence, so coverage is unchanged.
function shrinkToLimit(text, limit) {
  const blocks = text.split(/\n\s*\n/);
  const sentences = (p) => p.split(/(?<=[.!?])\s+/).filter(Boolean);
  const bodyIdx = [];
  blocks.forEach((b, i) => { if (i > 0 && i < blocks.length - 1) bodyIdx.push(i); });
  let guard = 0;
  while (words(blocks.join('\n\n')) > limit * 1.1 && guard++ < 400) {
    let best = -1, bestLen = 0;
    for (const i of bodyIdx) {
      const lines = blocks[i].split('\n');
      const body = lines[lines.length - 1];
      if (sentences(body).length > 2 && words(body) > bestLen) { best = i; bestLen = words(body); }
    }
    if (best < 0) break;
    const lines = blocks[best].split('\n');
    const s = sentences(lines[lines.length - 1]); s.pop();
    lines[lines.length - 1] = s.join(' ');
    blocks[best] = lines.join('\n');
  }
  return blocks.join('\n\n');
}

// Drop any sentence that still carries a number we can't verify (last-resort truth gate).
function dropUnverified(text, unverified) {
  if (!unverified.length) return text;
  return text.split('\n').map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !unverified.some((n) => s.includes(n))).join(' ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function generateNhsStatement(jobTitle, employer, jobDescription, cvText, opts = {}) {
  const r = await generateNhsStatementDetailed(jobTitle, employer, jobDescription, cvText, opts);
  return r ? r.text : null;
}

// Same, plus how many person-spec criteria the candidate can evidence (the NHS shortlisting gate).
async function generateNhsStatementDetailed(jobTitle, employer, jobDescription, cvText, { log = console.log, minCoverage = 0 } = {}) {
  if (!await llmAvailable()) return null;
  const { firstName, lastName } = cfg.APPLICANT || {};
  const name = [firstName, lastName].filter(Boolean).join(' ') || 'the applicant';
  const jd = String(jobDescription || '');
  const source = evidenceSource(cvText);

  const vac = await mapVacancy(jobTitle, employer, jd);
  if (!vac) { log('  [Statement] Could not read the person specification, using the simple format.'); return null; }
  const map = await mapEvidence(vac.criteria, source);
  // Early exit: not enough evidence to be shortlisted, so don't spend time writing a statement.
  {
    const e = map.filter((c) => c.type === 'essential'), ok = e.filter((c) => c.strength !== 'none');
    if (minCoverage && e.length && ok.length / e.length < minCoverage) {
      log(`  [Statement] Only ${ok.length}/${e.length} essential criteria evidenced, no statement written.`);
      return { text: null, essTotal: e.length, essOk: ok.length, desTotal: 0, desOk: 0, missing: e.filter((c) => c.strength === 'none').map((c) => c.text) };
    }
  }
  let limit = targetWords(map);
  if (vac.wordLimit && Number(vac.wordLimit) > 100) limit = Math.min(limit, Math.round(Number(vac.wordLimit) * 0.95));

  let text = tidy(await draft(jobTitle, vac, map, limit, name));
  if (!text) return null;

  // Surgical repairs keep the draft's voice: only flagged sentences / missing parts change.
  const unsupported = await factCheck(text, source);
  if (unsupported.length) text = tidy(await fixSentences(text, unsupported, source));
  let a = audit(text, map, source, jd, limit);
  if (a.issues.some((i) => /opening paragraph/.test(i))) {
    const open = tidy(await llmChat(`Write a 2 sentence opening for an NHS supporting statement, first person, British English, plain and specific, no semicolons or dashes. Sentence 1: applying for the ${jobTitle} role at ${vac.trust || 'the Trust'}. Sentence 2: the candidate's most relevant experience, from these facts only:\n${map.filter((c) => c.strength !== 'none').map((c) => '- ' + c.evidence).slice(0, 4).join('\n')}\nReturn ONLY the 2 sentences.`).catch(() => ''));
    if (open && words(open) < 70) text = open + '\n\n' + text;
  }
  if (a.issues.some((i) => /final paragraph/.test(i))) text = text + '\n\n' + `I would bring steady, well-documented support to the ${jobTitle} team at ${vac.trust || 'the Trust'}. I would welcome the chance to discuss the role with you.`;
  a = audit(text, map, source, jd, limit);
  // Whole-text repair only for problems a sentence swap can't fix (banned words, length, coverage).
  const big = a.issues.filter((i) => /Remove these words|Too long|not clearly covered/.test(i));
  if (big.length) {
    const fixed = tidy(await repair(text, big));
    if (fixed && words(fixed) > 150) text = fixed;
  }
  a = audit(text, map, source, jd, limit);
  text = tidy(dropUnverified(text, a.unverified));
  if (words(text) > limit * 1.1) text = shrinkToLimit(text, limit);
  a = audit(text, map, source, jd, limit);

  const ess = map.filter((c) => c.type === 'essential');
  const des = map.filter((c) => c.type === 'desirable');
  log(`  [Statement] ${ess.filter((c) => c.strength !== 'none').length}/${ess.length} essential and ${des.filter((c) => c.strength !== 'none').length}/${des.length} desirable criteria evidenced, ${a.wordCount} words, ${unsupported.length} unsupported claim(s) corrected${a.issues.length ? '. Still flagged: ' + a.issues.join(' ').slice(0, 200) : ', audit clean'}.`);
  return { text, essTotal: ess.length, essOk: ess.filter((c) => c.strength !== 'none').length, desTotal: des.length, desOk: des.filter((c) => c.strength !== 'none').length, missing: ess.filter((c) => c.strength === 'none').map((c) => c.text) };
}

module.exports = { generateNhsStatement, generateNhsStatementDetailed, _test: { mapVacancy, mapEvidence, audit, tidy, quoteInSource, evidenceSource, dropUnverified } };
