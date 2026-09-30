// Scorer for Reed, LinkedIn and company-site jobs (the NHS agent checks its own jobs). Same
// steps as the desktop app's bot_scorer.js, using the SAME shared modules:
//   pre-filter -> relevance check -> keyword score (+ addendum) -> tailored CV PDF -> cover letter.
// The tailored PDF is written to the in-browser file store and uploaded by the apply agents.
import cfg from '../shims/config.js';
import * as store from '../lib/store.js';

const cvScorer = require('../../../bot/modules/cv_scorer');
const { cleanText } = require('../../../bot/modules/cv_cleaner');
const { parseCV } = require('../../../bot/modules/cv_parser');
const { tailorStructured } = require('../../../bot/modules/cv_tailor_structured');
const { writePDF, writeStructuredPDF, buildPaths } = require('../../../bot/modules/cv_pdf_writer');
const { generateCoverLetter } = require('../../../bot/modules/cover_letter');
const { isRelevantRole } = require('../../../bot/modules/relevance_gate');

const QUICK_FAIL = 45;
const BOOST_TARGET = 85;

function boostCVText(cvText, keywords) {
  const valid = keywords.filter((k) => k && k.length >= 2 && k.length <= 60 && !k.includes('?') && !k.includes('|'));
  if (!valid.length) return cvText;
  const add = '\nAdditional Skills & Competencies: ' + valid.join(', ');
  const i = cvText.toLowerCase().indexOf('references available on request');
  return i > 0 ? cvText.slice(0, i).trimEnd() + add + '\n\n' + cvText.slice(i) : cvText.trimEnd() + add;
}

function preFilter(job) {
  const { experienceLevel, employmentType = [], salaryExpectation, country } = cfg.APPLICANT;
  const title = (job.title || '').toLowerCase();
  const desc = String(job.description || '').slice(0, 1500);
  if (experienceLevel) {
    const senior = /\b(senior|lead|principal|head of|director|vp|vice president|chief|cto|ceo|coo|staff engineer)\b/i.test(title);
    const junior = /\b(junior|entry.?level|graduate|trainee|apprentice|intern)\b/i.test(title);
    if (['entry', 'junior'].includes(experienceLevel) && senior) return `Senior-level role (you target ${experienceLevel})`;
    if (['senior', 'lead', 'director', 'executive'].includes(experienceLevel) && junior) return `Junior-level role (you target ${experienceLevel})`;
  }
  if (employmentType.length) {
    const ctxt = (title + ' ' + desc.slice(0, 500)).toLowerCase();
    const permanent = /\bpermanent\b/.test(ctxt);
    const contract = !permanent && /\b(fixed[- ]?term|\bftc\b|temporary|secondment|locum|day rate|freelance|outside ir35|inside ir35|\d{1,2}[- ]month(?:s)?(?:\s+(?:contract|fixed[- ]?term|ftc)))\b/i.test(ctxt);
    const partTime = /\bpart.?time\b/i.test(title + ' ' + desc.slice(0, 300));
    if (contract && !employmentType.includes('contract')) return 'Contract role (you target permanent)';
    if (partTime && !employmentType.includes('part_time')) return 'Part-time role (you target full-time)';
  }
  const min = parseInt(String(salaryExpectation || '').replace(/[^0-9]/g, ''), 10);
  if (min >= 15000) {
    const re = country === 'United States' ? /\$(\d[\d,]+)/g : /£(\d[\d,]+)/g;
    const found = [...desc.matchAll(re)].map((m) => parseInt(m[1].replace(/,/g, ''), 10)).filter((s) => s >= 15000 && s <= 500000);
    if (found.length && Math.max(...found) < min * 0.85) return 'Below your salary expectation';
  }
  return '';
}

export async function scoreJob(job, log) {
  const cv = await store.get('cv');
  if (!cv || !cv.text) { log('Add your CV on the Setup page first.'); return; }
  if (!job.description || job.description.trim().length < 30) { await store.updateJob(job.jobId, { status: 'skipped', reason: 'No job description' }); return; }
  const why = preFilter(job);
  if (why) { await store.updateJob(job.jobId, { status: 'skipped', reason: why }); return; }

  const jobTitle = String(job.title || '').split('\n')[0].trim();
  try {
    const rel = await isRelevantRole({ jobTitle, jdText: job.description, targetRoles: cfg.JOB_SEARCHES });
    if (!rel.relevant) { await store.updateJob(job.jobId, { status: 'skipped', reason: `Off-target role: ${rel.reason}` }); return; }
  } catch (_) { /* fail open */ }

  await store.updateJob(job.jobId, { status: 'processing' });
  log(`Scoring: ${jobTitle} @ ${job.company}`);
  const raw = cleanText(cv.text);
  let score, missing = [], all = [];
  try { ({ score, missingKeywords: missing, allKeywords: all } = await cvScorer.scoreCV(raw, job.description)); }
  catch (e) { log('Scoring failed (' + e.message + '), will retry later.'); await store.updateJob(job.jobId, { status: 'pending' }); return; }
  let cvText = raw;
  if (score >= QUICK_FAIL && score < BOOST_TARGET && missing.length) { cvText = boostCVText(raw, missing); score = cvScorer.rescoreCV(cvText, all).score; }
  if (score < cfg.MIN_SCORE) { await store.updateJob(job.jobId, { status: 'skipped', cvScore: score, reason: `CV scored ${score}% (you need ${cfg.MIN_SCORE}%)` }); return; }

  // Tailored CV in the app's fixed layout.
  const paths = buildPaths('/jobai/output/saved_cvs', '/jobai/output', cfg.RESUME_FILENAME, jobTitle, job.company, score);
  const full = `${cfg.APPLICANT.firstName} ${cfg.APPLICANT.lastName}`.trim();
  const pdfOpts = full ? { overrideName: full } : {};
  let rendered = false;
  try {
    const base = parseCV(raw, pdfOpts);
    const bullets = (base.experience || []).reduce((n, r) => n + (r.bullets ? r.bullets.length : 0), 0);
    if (!base.experience.length || !bullets) throw new Error('no work experience parsed');
    const t = await tailorStructured(base, jobTitle, job.description, missing, raw);
    const A = cfg.APPLICANT;
    const contact = [A.location, A.phone, A.email].map((s) => String(s || '').trim()).filter(Boolean).join('   |   ');
    if (contact) t.contact = contact;
    const sub = String(t.subtitle || '').trim();
    if (!sub || /[™®]|[^\x00-\x7F]/.test(sub) || /\bsummary\b|work experience|\bprofile\b|\beducation\b|\bskills\b/i.test(sub)) t.subtitle = jobTitle;
    if (t.profile) t.profile = String(t.profile).replace(/\bsummary\b[\s™®]*\bwork experience\b/gi, ' ').replace(/[™®]/g, '').replace(/\s{2,}/g, ' ').trim();
    await writeStructuredPDF(t, paths.saved, pdfOpts);
    rendered = true;
  } catch (e) { log('Structured CV failed (' + e.message + '), using the full-text layout.'); }
  if (!rendered) {
    try { await writePDF(cvText, paths.saved, pdfOpts); }
    catch (e) { await store.updateJob(job.jobId, { status: 'skipped', reason: 'CV could not be created' }); return; }
  }

  let coverLetter = null;
  try { coverLetter = await generateCoverLetter(jobTitle, job.company, job.description, cvText); } catch (_) {}
  await store.updateJob(job.jobId, { status: 'cv_ready', cvPath: paths.saved, cvScore: score, cvName: cv.name, ...(coverLetter ? { coverLetter } : {}) });
  log(`✓ CV tailored (${score}%): ${jobTitle}`);
}
