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
// Deterministic (no LLM — this module is shared app+web): covers right to work,
// sponsorship, salary, availability, where the applicant lives, postcode, phone,
// driving licence and gender from the profile. Anything else comes back unknown:true;
// the caller may pass an `ask` hook (the app's AI) to answer those, otherwise the job
// is handed to the user instead of sending a guess.
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const US_ZIP = /\b(\d{5})(?:-\d{4})?\b/;
function answerRecruiteeQuestion(q, a = {}) {
  const body = String(q.body || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').toLowerCase();
  const opts = (q.open_question_options || []).map((o) => ({ id: o.id, text: String(o.body || '') }));
  const rtw = a.rightToWorkCountries || [];
  const us = a.country === 'United States';
  const home = us ? /\bus\b|usa|united states|america/i : /\buk\b|united kingdom|britain|england|scotland|wales/i;
  const hasRtW = Array.isArray(rtw) ? rtw.some((c) => home.test(c)) : home.test(String(rtw));
  const needsSponsor = typeof a.requiresSponsorship === 'boolean' ? a.requiresSponsorship : !hasRtW;
  const where = [a.address, a.location].filter(Boolean).join(', ');
  const livesHome = a.country ? home.test(a.country) : null;
  const unknown = { id: q.id, kind: q.kind, answer: q.kind === 'boolean' ? null : '', unknown: true, body: String(q.body || '').replace(/<[^>]+>/g, ' ').trim(), options: opts };
  if (q.kind === 'boolean' || q.kind === 'legal') {
    const yes = (v) => ({ id: q.id, kind: 'boolean', answer: v });
    if (/sponsor/.test(body)) return yes(needsSponsor);
    if (/right to work|eligible to work|authori[sz]|legally.*work/.test(body)) return yes(hasRtW);
    // "Do you live in the UK?" / "Are you a UK resident?": from where the applicant lives.
    if (/\blive in|based in|located in|living in|resid/.test(body) && home.test(body) && livesHome != null) return yes(livesHome);
    if (/mobile|phone number/.test(body) && (!home.test(body) || livesHome)) return yes(!!a.phone);
    if (/driv(er|ing)['’]?s? licen[cs]e/.test(body) && !/passport/.test(body)) return yes(!!a.drivingLicence);
    if (/passport or driv|driv.* or passport/.test(body) && a.drivingLicence) return yes(true);
    if (/privacy|consent|data protection|gdpr|i (confirm|agree|accept)|terms/.test(body) || q.kind === 'legal') return yes(true);
    return unknown;
  }
  if (q.kind === 'salary') return a.salaryExpectation ? { id: q.id, kind: 'salary', answer: a.salaryExpectation } : unknown;
  if (/gender|\bsex\b/.test(body) && opts.length) {
    // The profile's own answer (matching "Male" to "M" too), else "Prefer not to say".
    const g = String(a.eeoGender || '').trim().toLowerCase();
    const pick = (/^(male|female)$/.test(g) && opts.find((o) => [g, g[0]].includes(o.text.trim().toLowerCase())))
      || opts.find((o) => /prefer not|rather not|decline/i.test(o.text));
    return pick ? { id: q.id, kind: q.kind, answer: pick.text } : unknown;
  }
  if (q.kind === 'string' || q.kind === 'text') {
    if (/salary|pay expectation/.test(body) && a.salaryExpectation) {
      const yearly = Number(String(a.salaryExpectation).replace(/[^\d.]/g, ''));
      return { id: q.id, kind: q.kind, answer: /month/.test(body) && yearly > 1000 ? String(Math.round(yearly / 12)) : String(a.salaryExpectation) };
    }
    if (/post\s*code|postal code|zip/.test(body)) {
      const m = where.match(us ? US_ZIP : UK_POSTCODE);
      return m ? { id: q.id, kind: q.kind, answer: m[1].toUpperCase() } : unknown;
    }
    if (/city|town/.test(body) && a.location) return { id: q.id, kind: q.kind, answer: /country/.test(body) ? `${a.location}, ${a.country || ''}`.replace(/, $/, '') : a.location };
    if (/where .*(live|reside|based)/.test(body) && a.location) return { id: q.id, kind: q.kind, answer: `${a.location}, ${a.country || ''}`.replace(/, $/, '') };
  }
  if (q.kind === 'date' && /start|availab/.test(body)) {
    const d = new Date(); const wk = /(\d+)\s*week/i.exec(a.availability || ''); const mo = /(\d+)\s*month/i.exec(a.availability || '');
    d.setDate(d.getDate() + (wk ? 7 * +wk[1] : mo ? 30 * +mo[1] : 1));
    return { id: q.id, kind: 'date', answer: d.toISOString().slice(0, 10) };
  }
  if (/notice period|availability|when can you start/.test(body) && a.availability) return { id: q.id, kind: q.kind, answer: a.availability };
  if (/year.*experience|how many year/.test(body) && /^(string|text|number|numeric)$/.test(q.kind) && a.yearsExperience != null && a.yearsExperience !== '') return { id: q.id, kind: q.kind, answer: String(a.yearsExperience) };
  return unknown;
}

// ── Recruitee — documented open POST (no auth) ──────────────────────────────
// POST https://{company}.recruitee.com/api/offers/{slug}/candidates
// careers_url shape: https://{company}.recruitee.com/o/{slug}
async function submitRecruitee({ url, applicant, cvPath, coverLetter, questions, dryRun, ask }) {
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

  // Questions the profile can't answer go to the caller's `ask` hook (the app's AI, which
  // never answers sensitive ones). Video and file questions can't be answered over HTTP.
  if (Array.isArray(questions) && typeof ask === 'function') {
    for (const q of questions) {
      if (!q || !q.unknown || /^(video|file)$/.test(q.kind)) continue;
      try {
        const v = await ask(q);
        if (v != null && v !== '') { q.answer = v; q.unknown = false; }
      } catch (_) { /* stays unknown */ }
    }
  }
  // A required question still unanswered: don't guess, let the user send it.
  const open = Array.isArray(questions) ? questions.filter((q) => q && q.unknown) : [];
  if (open.length) return { ok: false, reason: 'needs_you', questions: open.map((q) => q.body || q.kind) };

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
      } else if (q.kind === 'multi_choice') {
        // Choice answers carry the option text (Recruitee's documented shape; unverified live).
        fd.append(`${base}[multi_content][]`, String(q.answer == null ? '' : q.answer));
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
