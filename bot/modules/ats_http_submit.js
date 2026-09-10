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

// ── Recruitee — documented open POST (no auth) ──────────────────────────────
// POST https://{company}.recruitee.com/api/offers/{slug}/candidates
// careers_url shape: https://{company}.recruitee.com/o/{slug}
async function submitRecruitee({ url, applicant, cvPath, coverLetter, questions, dryRun }) {
  const m = String(url || '').match(/https?:\/\/([^.]+)\.recruitee\.com\/(?:o|offers)\/([^/?#]+)/i);
  if (!m) return { ok: false, reason: 'unparseable_recruitee_url' };
  const [, company, slug] = m;
  const endpoint = `https://${company}.recruitee.com/api/offers/${encodeURIComponent(slug)}/candidates?async=true`;

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
