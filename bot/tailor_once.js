/**
 * Tailor tab: one job the user pasted in, tailored on request.
 *   node tailor_once.js <input.json>
 * input: { title, company, description, cvId? }
 * Prints "TAILOR_STEP <text>" while it works and one "TAILOR_RESULT <json>" line at the end.
 * Same pipeline as the Scorer (bot_scorer.js): best of the user's CVs, structured tailoring in the
 * fixed layout, cover letter. Nothing is skipped (a weak match is still tailored and the result
 * says how well it fits), and the advert's missing skills are never added to the CV.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const cvSelector = require('./modules/cv_selector');
const cvScorer = require('./modules/cv_scorer');
const { cleanText } = require('./modules/cv_cleaner');
const { parseCV } = require('./modules/cv_parser');
const { tailorStructured, structuredText } = require('./modules/cv_tailor_structured');
const { writePDF, writeFittedPDF, buildPaths } = require('./modules/cv_pdf_writer');
const { generateCoverLetter } = require('./modules/cover_letter');

const step = (t) => process.stdout.write(`TAILOR_STEP ${t}\n`);
const done = (r) => { process.stdout.write(`TAILOR_RESULT ${JSON.stringify(r)}\n`); process.exit(0); };

(async () => {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  await cfg.init();
  const title = String(input.title || '').split('\n')[0].trim() || 'This job';
  const company = String(input.company || '').trim();
  const description = String(input.description || '').slice(0, 12000);
  let cvs = cfg.CVS.filter((c) => c && c.path && fs.existsSync(c.path));
  if (input.cvId) cvs = cvs.filter((c) => String(c.id) === String(input.cvId)).concat(cvs).slice(0, 1);
  if (!cvs.length) return done({ ok: false, error: 'Add your CV first (Setup, then CVs).' });

  let best = null;
  for (const c of cvs) {
    step('Checking your CV against the advert');
    const raw = cleanText(await cvSelector.extractCVText(c.path));
    const r = await cvScorer.scoreCV(raw, description, {});
    const fit = cvScorer.matchFit(raw, r.allKeywords, cfg.MATCH_LEVEL);
    if (!best || r.score > best.score) best = { cv: c, raw, score: r.score, fit, missing: r.missingKeywords || [], all: r.allKeywords || [] };
  }

  const fullName = `${cfg.APPLICANT.firstName || ''} ${cfg.APPLICANT.lastName || ''}`.trim();
  const paths = buildPaths(path.join(cfg.OUTPUT_DIR, 'saved_cvs'), cfg.OUTPUT_DIR, cfg.RESUME_FILENAME, title, company || 'Employer', best.score, fullName);
  fs.mkdirSync(path.dirname(paths.saved), { recursive: true });
  const pdfOpts = fullName ? { overrideName: fullName } : {};
  let score = best.score, tailored = false;
  step('Rewriting your CV for this job');
  try {
    const base = parseCV(best.raw, pdfOpts);
    const bullets = (base.experience || []).reduce((n, r) => n + (r.bullets ? r.bullets.length : 0), 0);
    if (!base.experience.length || !bullets) throw new Error('no work experience parsed');
    const missingSet = new Set(best.missing.map((k) => String(k).toLowerCase()));
    const t = await tailorStructured(base, title, description, best.missing, best.raw, {
      matchedKeywords: best.all.filter((k) => k && k.term && !missingSet.has(String(k.term).toLowerCase())),
      uk: !/united states|^us(a)?$|canada/i.test(String(cfg.APPLICANT.country || '')),
    });
    const A = cfg.APPLICANT || {};
    const contact = [A.location, A.phone, A.email].map((s) => String(s || '').trim()).filter(Boolean).join('   |   ');
    if (contact) t.contact = contact;
    const sub = String(t.subtitle || '').trim();
    if (!sub || /[™®]|[^\x00-\x7F]/.test(sub) || /\bsummary\b|work experience|\bprofile\b|\beducation\b|\bskills\b/i.test(sub)) t.subtitle = title;
    if (t.profile) t.profile = String(t.profile).replace(/\bsummary\b[\s™®]*\bwork experience\b/gi, ' ').replace(/[™®]/g, '').replace(/\s{2,}/g, ' ').trim();
    Object.assign(t, await writeFittedPDF(t, paths.saved, pdfOpts));
    tailored = true;
    if (best.all.length) score = cvScorer.rescoreCV(structuredText(t), best.all).score;
  } catch (e) { console.log('[Tailor] full-text layout: ' + e.message); }
  if (!tailored) await writePDF(best.raw, paths.saved, pdfOpts);

  step('Writing your cover letter');
  let coverLetter = '';
  try { coverLetter = (await generateCoverLetter(title, company || 'your company', description, best.raw, best.missing)) || ''; } catch (_) {}
  const gaps = [...new Set(best.missing.map((k) => String(k && k.term ? k.term : k).trim()).filter((k) => k && k.length <= 40 && !/[?|]/.test(k)))].slice(0, 8);
  done({ ok: true, cvPath: paths.saved, fileName: path.basename(paths.saved), tailored, score, fits: !!best.fit.pass, fitReason: best.fit.reason || '', gaps, coverLetter, cvName: best.cv.name || 'Main CV' });
})().catch((e) => done({ ok: false, error: e.message || String(e) }));
