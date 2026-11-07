/**
 * federal_answers.js — "Help me answer" for federal (USA Staffing) questionnaires.
 * The user pastes the questionnaire (from the job's public preview page). For each question the
 * AI suggests the answer the CV honestly supports and quotes the CV line that backs it.
 *
 * Suggest only, never submit: the user copies each answer, edits it and submits it themselves.
 * The applicant certifies these answers to a federal agency (18 U.S.C. 1001), so experience
 * ratings need a quote that is really in the CV (checked below), and drafts use CV facts only. Shared by the
 * desktop app (main process) and the extension. AI goes through the licensed backend.
 */
const { llmChat } = require('../../src/services/llm');
// Truth gate, same rule as the NHS statement (nhs_statement.js): most of the quote's words must be
// in the CV. Copied so this module doesn't load the agents' config in the app's main process.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%$ ]+/g, ' ').replace(/\s+/g, ' ').trim();
function quoteInSource(quote, source) {
  const src = ' ' + norm(source) + ' ';
  const q = norm(quote).split(' ').filter((w) => w.length > 3);
  if (q.length < 2) return false;
  return q.filter((w) => src.includes(' ' + w + ' ') || src.includes(w)).length / q.length >= 0.75;
}

function parseJson(s) {
  const t = String(s || '');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

const MAX_TEXT = 14000;
const PER_CALL = 12;

// Split the pasted questionnaire into questions with their answer choices (one AI call).
async function readQuestions(text) {
  const prompt = `This is a U.S. federal job application questionnaire that an applicant copied from the USA Staffing preview page. Split it into its questions.

QUESTIONNAIRE:
${String(text).slice(0, MAX_TEXT)}

Return ONLY a JSON array, one item per question in order:
[{"n": 1, "kind": "experience" | "personal" | "essay" | "certification", "question": "the question or task statement, word for word (up to 400 characters)", "choices": ["each answer choice, word for word, in order (up to 400 characters each)"]}]

Kinds: "experience" = asks about the applicant's skills, education or work experience (task self-ratings, which statement describes your experience). "personal" = about the applicant themselves, not their skills: veterans' preference, eligibility, willingness or agreement to conditions (background check, travel, lifting, vaccination, probation, relocation). "essay" = asks for a written answer. "certification" = asks them to certify or verify their answers or that they wrote them themselves.
Rules: keep the wording exactly. Leave out headings and instructions. Yes/No questions get ["Yes","No"]. A question with no choices shown gets [].`;
  let arr = parseJson(await llmChat(prompt).catch(() => ''));
  if (!Array.isArray(arr)) arr = parseJson(await llmChat(prompt).catch(() => ''));
  if (!Array.isArray(arr)) throw new Error('Could not read the questions. Copy the questionnaire text again and paste it.');
  const KINDS = ['experience', 'personal', 'essay', 'certification'];
  return arr.filter((q) => q && q.question).slice(0, 60).map((q, i) => {
    const choices = (Array.isArray(q.choices) ? q.choices : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 8);
    let kind = KINDS.includes(q.kind) ? q.kind : 'experience';
    // Belt and braces: certify/verify wording, or a written answer with no choices, is never ours.
    // A written answer (no choices) is an essay even when it asks them to certify it is their own.
    if (!choices.length) { if (kind !== 'personal') kind = 'essay'; }
    else if (/\b(i certify|i verify|certif(y|ication))\b/i.test(q.question + ' ' + choices.join(' '))) kind = 'certification';
    return { n: i + 1, kind, question: String(q.question).trim(), choices };
  });
}

async function suggestBatch(questions, cvText) {
  const prompt = `You help a job applicant answer a U.S. federal application questionnaire HONESTLY from their CV. They certify their answers, and overstating is a federal offence, so never pick a choice the CV does not support.

CV (the only facts you may use):
${String(cvText).slice(0, 9000)}

QUESTIONS:
${questions.map((q) => `${q.n}. ${q.question}${q.choices.length ? '\n   Choices: ' + q.choices.map((c, i) => `(${String.fromCharCode(65 + i)}) ${c}`).join(' | ') : ''}`).join('\n')}

Return ONLY a JSON array:
[{"n": 1, "choice": "the exact text of the highest choice the CV clearly supports, or empty if none", "evidence": "one sentence: what the applicant did, where, from the CV", "quote": "a short phrase copied word for word from the CV that proves it"}]

Rules: pick the choice that matches what the CV shows, not the best-sounding one. Doing the task as part of the job means the "performed independently" level, not expert. The expert or "supervised others" level needs the CV to show the applicant trained, mentored, led or supervised others in that same task: put that line in the quote. If the CV says nothing about the task, choice empty, evidence empty, quote empty.`;
  let arr = parseJson(await llmChat(prompt).catch(() => ''));
  if (!Array.isArray(arr)) arr = parseJson(await llmChat(prompt).catch(() => ''));
  return Array.isArray(arr) ? arr : [];
}

// Personal, essay and certification questions: a draft the user copies, checks and edits.
// Job-AI never fills in or submits the questionnaire; the applicant decides what to send.
async function draftOthers(questions, cvText) {
  const prompt = `You help a job applicant answer a U.S. federal application questionnaire. They will copy your answers, check them and edit them before submitting it themselves.

CV (the only facts about the applicant you may use):
${String(cvText).slice(0, 9000)}

QUESTIONS:
${questions.map((q) => `${q.n}. [${q.kind}] ${q.question}${q.choices.length ? '\n   Choices: ' + q.choices.map((c, i) => `(${String.fromCharCode(65 + i)}) ${c}`).join(' | ') : ''}`).join('\n')}

Return ONLY a JSON array:
[{"n": 1, "choice": "for questions with choices: the exact text of the choice to suggest, otherwise empty", "answer": "for questions without choices: the written answer, otherwise empty", "note": "one short sentence on what the applicant must check, or empty"}]

Rules:
- personal (eligibility, veterans' preference, citizenship, willingness to travel or relocate, background check): pick the choice the CV supports. If the CV does not say, still pick the most likely choice (never leave it empty) and set note to what they must confirm, for example "Check this is true for you".
- certification: suggest the choice that certifies, with note "Only choose this if all your answers are true".
- essay: write the answer in plain first person, 120 to 250 words, using only facts from the CV, with specific examples and numbers from it. Never invent employers, dates, numbers, tools, actions or achievements. If the question asks for a specific example or detail the CV does not describe, write around what the CV does say and put a placeholder in square brackets where they must add it, like [what you changed and the result], and set note to "Fill in the parts in square brackets".`;
  let arr = parseJson(await llmChat(prompt).catch(() => ''));
  if (!Array.isArray(arr)) arr = parseJson(await llmChat(prompt).catch(() => ''));
  return Array.isArray(arr) ? arr : [];
}

/**
 * Returns [{ n, kind, question, choices, choice, evidence, answer, note }]. For experience
 * questions choice '' means the CV shows nothing for it, and a suggestion whose quote is not
 * really in the CV is dropped (truth gate). Other kinds get a draft to check and edit.
 */
async function suggestAnswers(questionnaireText, cvText) {
  if (String(questionnaireText || '').trim().length < 40) throw new Error('Paste the questionnaire questions first.');
  if (String(cvText || '').trim().length < 200) throw new Error('Add your CV first.');
  const qs = await readQuestions(questionnaireText);
  if (!qs.length) throw new Error('No questions found in that text.');
  const out = [];
  const others = qs.filter((q) => q.kind !== 'experience');
  for (let b = 0; b < others.length; b += PER_CALL) {
    const batch = others.slice(b, b + PER_CALL);
    const byN = new Map((await draftOthers(batch, cvText)).map((a) => [Number(a.n), a]));
    for (const q of batch) {
      const a = byN.get(q.n) || {};
      let choice = String(a.choice || '').trim().replace(/^\(?[A-H]\)\s*/, '');
      if (choice && q.choices.length) choice = q.choices.find((c) => c.toLowerCase() === choice.toLowerCase())
        || q.choices.find((c) => c.toLowerCase().startsWith(choice.toLowerCase().slice(0, 25))) || '';
      out.push({ ...q, choice, evidence: '', answer: q.choices.length ? '' : String(a.answer || '').trim(), note: String(a.note || '').trim() });
    }
  }
  const exp = qs.filter((q) => q.kind === 'experience');
  for (let b = 0; b < exp.length; b += PER_CALL) {
    const batch = exp.slice(b, b + PER_CALL);
    const byN = new Map((await suggestBatch(batch, cvText)).map((a) => [Number(a.n), a]));
    for (const q of batch) {
      const a = byN.get(q.n) || {};
      let choice = String(a.choice || '').trim();
      let evidence = String(a.evidence || '').trim();
      // The prompt labels choices (A), (B)...; the model often echoes the label back.
      choice = choice.replace(/^\(?[A-H]\)\s*/, '');
      if (choice && !quoteInSource(a.quote, cvText)) { choice = ''; evidence = ''; }
      // Only a choice that really is one of the options (when the question lists them).
      if (choice && q.choices.length && !q.choices.some((c) => c.toLowerCase() === choice.toLowerCase())) {
        const hit = q.choices.find((c) => c.toLowerCase().startsWith(choice.toLowerCase().slice(0, 25)));
        choice = hit || '';
        if (!hit) evidence = '';
      }
      // The top "expert / I supervised others" level needs the quoted CV line itself to show
      // leading, training or supervising others. Otherwise suggest the level below it.
      const i = choice ? q.choices.findIndex((c) => c.toLowerCase() === choice.toLowerCase()) : -1;
      if (i > 0 && /\bexpert\b|\bsupervised\b|\bconsulted by other/i.test(choice) && !/\b(supervis\w*|mentor\w*|train(ed|ing|s)?|coach\w*|led|lead\w*|manag(ed|es|ing) (a|the) team)\b/i.test(String(a.quote || ''))) {
        choice = q.choices[i - 1];
      }
      out.push({ ...q, choice, evidence });
    }
  }
  return out.sort((x, y) => x.n - y.n);
}

module.exports = { suggestAnswers };
