/**
 * ats_http_submit.js
 * Direct HTTP application submitters for ATSes whose apply endpoint is OPEN (no
 * employer key, no browser-minted anti-bot token) — the "replay the request the
 * form fires" model. Pure Node fetch: no browser, works on the app AND the web.
 *
 * Only ATSes proven to accept a keyless server-side POST live here. Cloudflare /
 * token-protected ATSes (Workable, Greenhouse) are NOT here — they need the
 * browser (hybrid: browser gets the token, then POST) and stay with ats_filler.
 *
 * Each submitter returns:
 *   { ok:true, submitted:true }        real submission accepted
 *   { ok:true, dryRun:true, endpoint } dry run — request built, not sent
 *   { ok:false, reason, status? }      could not submit (caller falls back)
 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function attachCv(fd, field, cvPath) {
  if (!cvPath || !fs.existsSync(cvPath)) return false;
  const buf = fs.readFileSync(cvPath);
  const type = /\.docx?$/i.test(cvPath) ? 'application/msword' : 'application/pdf';
  fd.append(field, new Blob([buf], { type }), path.basename(cvPath));
  return true;
}

// Answer one Recruitee required open question from the applicant profile.
// Deterministic (no LLM — this module is shared app+web): covers the common
// right-to-work / sponsorship / salary / availability questions from the profile.
// Anything else comes back unknown:true, and the caller hands the job to the user
// instead of sending a guess (a "Yes" to a skill or licence they don't have).
function answerRecruiteeQuestion(q, a = {}) {
  const body = String(q.body || '').replace(/<[^>]+>/g, ' ').toLowerCase();
  const rtw = a.rightToWorkCountries || [];
  const us = a.country === 'United States';
  const home = us ? /us|usa|united states|america/i : /uk|united kingdom|britain/i;
  const hasRtW = Array.isArray(rtw) ? rtw.some((c) => home.test(c)) : home.test(String(rtw));
  const needsSponsor = typeof a.requiresSponsorship === 'boolean' ? a.requiresSponsorship : !hasRtW;
  if (q.kind === 'boolean') {
    if (/sponsor/.test(body)) return { id: q.id, kind: 'boolean', answer: needsSponsor };
    if (/right to work|eligible to work|authori[sz]|legally.*work/.test(body)) return { id: q.id, kind: 'boolean', answer: hasRtW };
    // "Are you based in the UK?": answered from where the applicant lives, when known.
    if (/based in|located in|living in|resid/.test(body) && home.test(body) && a.country) return { id: q.id, kind: 'boolean', answer: home.test(a.country) };
    if (/privacy|consent|data protection|gdpr|i (confirm|agree|accept)|terms/.test(body)) return { id: q.id, kind: 'boolean', answer: true };
    return { id: q.id, kind: 'boolean', answer: null, unknown: true };
  }
  if (q.kind === 'salary') return a.salaryExpectation ? { id: q.id, kind: 'salary', answer: a.salaryExpectation } : { id: q.id, kind: 'salary', answer: '', unknown: true };
  if (/notice period|availability|when can you start/.test(body) && a.availability) return { id: q.id, kind: q.kind, answer: a.availability };
  if (/year.*experience|how many year/.test(body) && a.yearsExperience != null && a.yearsExperience !== '') return { id: q.id, kind: q.kind, answer: String(a.yearsExperience) };
  return { id: q.id, kind: q.kind, answer: '', unknown: true };
}

// ── Recruitee — documented open POST (no auth) ──────────────────────────────
// POST https://{company}.recruitee.com/api/offers/{slug}/candidates
// careers_url shape: https://{company}.recruitee.com/o/{slug}
async function submitRecruitee({ url, applicant, cvPath, coverLetter, questions, dryRun }) {
  const m = String(url || '').match(/https?:\/\/([^.]+)\.recruitee\.com\/(?:o|offers)\/([^/?#]+)/i);
  if (!m) return { ok: false, reason: 'unparseable_recruitee_url' };
  const [, company, slug] = m;
  const endpoint = `https://${company}.recruitee.com/api/offers/${encodeURIComponent(slug)}/candidates?async=true`;

  // Fetch + auto-answer the offer's REQUIRED open questions when the caller didn't
  // supply them (booleans need a flag, salary a value — an unanswered required
  // question makes Recruitee reject the whole submission).
  if (!Array.isArray(questions)) {
    try {
      const or = await fetch(`https://${company}.recruitee.com/api/offers/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
      if (or.ok) {
        const oj = await or.json();
        const oqs = (oj.offer && oj.offer.open_questions) || [];
        questions = oqs.filter((q) => q.required).map((q) => answerRecruiteeQuestion(q, applicant));
      }
    } catch (_) { /* fall through — submit without answers, may 422 (creates nothing) */ }
  }

  // A required question the profile can't answer: don't guess, let the user send it.
  if (Array.isArray(questions) && questions.some((q) => q && q.unknown)) return { ok: false, reason: 'needs_you' };

  const fd = new FormData();
  const name = `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim();
  if (!name || !applicant.email) return { ok: false, reason: 'missing_name_or_email' };
  fd.append('candidate[name]', name);
  fd.append('candidate[email]', applicant.email);
  if (applicant.phone) fd.append('candidate[phone]', applicant.phone);
  if (coverLetter) fd.append('candidate[cover_letter]', coverLetter);
  if (Array.isArray(questions)) {
    questions.forEach((q, i) => {
      if (!q || q.id == null) return;
      const base = `candidate[open_question_answers_attributes][${i}]`;
      fd.append(`${base}[open_question_id]`, String(q.id));
      // Recruitee validates by question KIND: boolean questions require a [flag]
      // (true/false) and REJECT a [content] value ("flag can't be blank");
      // salary/text/numeric questions use [content]. Verified live 2026-09-10.
      if (q.kind === 'boolean') {
        const yes = q.answer === true || /^(yes|true|1)$/i.test(String(q.answer));
        fd.append(`${base}[flag]`, yes ? 'true' : 'false');
      } else {
        fd.append(`${base}[content]`, String(q.answer == null ? '' : q.answer));
      }
    });
  }
  const hasCv = attachCv(fd, 'candidate[cv]', cvPath);

  if (dryRun) return { ok: true, dryRun: true, endpoint, hasCv, name };

  try {
    const res = await fetch(endpoint, { method: 'POST', body: fd, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (res.ok) return { ok: true, submitted: true, status: res.status };
    return { ok: false, reason: 'rejected', status: res.status };
  } catch (e) {
    return { ok: false, reason: 'network', detail: e.message };
  }
}

// Registry: apply_kind / detected ATS -> submitter. Only OPEN ones.
const SUBMITTERS = { recruitee: submitRecruitee, ats_recruitee: submitRecruitee };

// True if this job can be submitted by pure HTTP (no browser).
function httpSubmitterFor(key) { return SUBMITTERS[key] || null; }

module.exports = { httpSubmitterFor, submitRecruitee };
