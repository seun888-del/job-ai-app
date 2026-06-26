/**
 * Scorer Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Watches queue.db for jobs with status "pending".
 * For each:
 *   0. Pre-filter: skip jobs mismatched on level, type, or salary
 *   1. Select the best-matching CV
 *   2. Score original CV text against JD keywords (no AI rewriting)
 *   3. Addendum fallback — append missing keywords for ATS if score < target
 *   4. Copy original uploaded CV file directly (no docx reconstruction)
 *   5. Generate targeted cover letter, set queue entry to "cv_ready"
 */

const path       = require('path');
const fs         = require('fs');
const cfg        = require('./config');
const cvSelector = require('./modules/cv_selector');
const cvScorer   = require('./modules/cv_scorer');
const queue      = require('./modules/queue_manager');
const { cleanText }                   = require('./modules/cv_cleaner');
const { writePDF, buildPaths }        = require('./modules/cv_pdf_writer');
const { writeDocx }                   = require('./modules/cv_docx_writer');
const { convertDocxToPdf }            = require('./modules/cv_converter');
const { tailorCV, weaveKeywords }     = require('./modules/cv_tailor');
const { lightTailorDocx }             = require('./modules/cv_light_tailor');
const { generateCoverLetter }         = require('./modules/cover_letter');
const { llmAvailable, mode: llmMode } = require('../src/services/llm');

const QUICK_FAIL_THRESHOLD = 35;
const BOOST_TARGET         = 85;
const STUCK_TIMEOUT_MS     = 10 * 60 * 1000;

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;

// Last-resort addendum — only fires when inline weaving still leaves keywords missing
function boostCVText(cvText, keywords) {
  const valid = keywords.filter(k => k && k.length >= 2 && k.length <= 60 && !k.includes('?') && !k.includes('|'));
  if (!valid.length) return cvText;
  const addendum = '\nAdditional Skills & Competencies: ' + valid.join(', ');
  const refIdx = cvText.toLowerCase().indexOf('references available on request');
  if (refIdx > 0) {
    return cvText.slice(0, refIdx).trimEnd() + addendum + '\n\n' + cvText.slice(refIdx);
  }
  return cvText.trimEnd() + addendum;
}

// ── Pre-filter: skip jobs mismatched on level, employment type, or salary ────
function passesPreFilter(job) {
  const { experienceLevel, employmentType, salaryExpectation, country } = cfg.APPLICANT;
  const title     = (job.title || '').toLowerCase();
  const descStart = (job.description || '').substring(0, 1500);

  // Experience level mismatch
  if (experienceLevel) {
    const isSeniorTitle = /\b(senior|lead|principal|head of|director|vp|vice president|chief|cto|ceo|coo|staff engineer)\b/i.test(title);
    const isJuniorTitle = /\b(junior|entry.?level|graduate|trainee|apprentice|intern)\b/i.test(title);
    const isJuniorUser  = ['entry', 'junior'].includes(experienceLevel);
    const isSeniorUser  = ['senior', 'lead', 'director', 'executive'].includes(experienceLevel);

    if (isJuniorUser && isSeniorTitle) {
      return { pass: false, reason: `Senior-level role skipped (user targets ${experienceLevel} level)` };
    }
    if (isSeniorUser && isJuniorTitle) {
      return { pass: false, reason: `Junior-level role skipped (user targets ${experienceLevel} level)` };
    }
  }

  // Employment type mismatch
  if (employmentType && employmentType.length > 0) {
    const wantsContract = employmentType.includes('contract');
    const wantsFullTime = employmentType.includes('full_time');
    const wantsPartTime = employmentType.includes('part_time');
    const jobIsContract = /\b(contract|freelance|day rate|outside ir35|inside ir35)\b/i.test(title + ' ' + descStart.substring(0, 300));
    const jobIsPartTime = /\bpart.?time\b/i.test(title + ' ' + descStart.substring(0, 300));

    if (jobIsContract && !wantsContract && (wantsFullTime || wantsPartTime)) {
      return { pass: false, reason: 'Contract role skipped — user targets permanent employment' };
    }
    if (jobIsPartTime && !wantsPartTime && (wantsFullTime || wantsContract)) {
      return { pass: false, reason: 'Part-time role skipped — user targets full-time/contract' };
    }
  }

  // Salary floor — only filter when salary is clearly stated AND clearly below minimum
  if (salaryExpectation) {
    const minSalary  = parseInt(salaryExpectation.replace(/[^0-9]/g, ''), 10);
    if (minSalary >= 15000) {
      const currencyRe = (country === 'United States') ? /\$(\d[\d,]+)/g : /£(\d[\d,]+)/g;
      const matches = [...descStart.matchAll(currencyRe)]
        .map(m => parseInt(m[1].replace(/,/g, ''), 10))
        .filter(s => s >= 15000 && s <= 500000);

      if (matches.length > 0) {
        const maxFound = Math.max(...matches);
        if (maxFound < minSalary * 0.85) {
          const sym = country === 'United States' ? '$' : '£';
          return { pass: false, reason: `Salary ${sym}${maxFound.toLocaleString()} below minimum — skipped` };
        }
      }
    }
  }

  return { pass: true };
}

async function scoreWithBoost(cv, jdText) {
  const raw         = await cvSelector.extractCVText(cv.path);
  const cleanedText = cleanText(raw);

  // Score original CV against JD keywords — no AI rewriting
  let score, missingKeywords, allKeywords;
  try {
    ({ score, missingKeywords, allKeywords } = await cvScorer.scoreCV(cleanedText, jdText));
  } catch (err) {
    console.warn(`  [Scorer Bot] Scoring failed (${err.message}) — fallback score 85`);
    return { score: 85, cvText: cleanedText, rawCvText: cleanedText, missingKeywords: [] };
  }

  console.log(`  [Scorer Bot] Score: ${score}% — ${cv.name}`);

  if (score > 0 && score < QUICK_FAIL_THRESHOLD) {
    console.log(`  [Scorer Bot] ${score}% below quick-fail threshold — skipping this CV`);
    return { score, cvText: cleanedText, rawCvText: cleanedText, missingKeywords };
  }

  // Addendum: append missing keywords at the bottom for ATS (no rewriting of CV body)
  let cvText = cleanedText;
  if (score < BOOST_TARGET && missingKeywords.length > 0) {
    console.log(`  [Scorer Bot] ${score}% — adding ${missingKeywords.length} missing keywords via addendum`);
    cvText = boostCVText(cleanedText, missingKeywords);
    const rescore = cvScorer.rescoreCV(cvText, allKeywords);
    score = rescore.score;
    console.log(`  [Scorer Bot] After addendum: ${score}%`);
  }

  return { score, cvText, rawCvText: cleanedText, missingKeywords: missingKeywords || [] };
}

async function processJob(job) {
  console.log(`\n  [Scorer Bot] ── ${job.title} @ ${job.company}`);

  if (!job.description || job.description.trim().length < 30) {
    console.log('  [Scorer Bot] No description — skipping');
    queue.update(job.jobId, { status: 'skipped', reason: 'No job description' });
    return;
  }

  if (!cfg.CVS.length) {
    console.log('  [Scorer Bot] No CVs configured — skipping');
    queue.update(job.jobId, { status: 'skipped', reason: 'No CVs configured' });
    return;
  }

  // Pre-filter: skip before spending any AI tokens
  const preFilter = passesPreFilter(job);
  if (!preFilter.pass) {
    console.log(`  [Scorer Bot] Pre-filter: ${preFilter.reason}`);
    queue.update(job.jobId, { status: 'skipped', reason: preFilter.reason });
    return;
  }

  queue.update(job.jobId, { status: 'processing' });

  const bestCV   = cvSelector.selectBestCV(job.description, cfg.CVS);
  const jobTitle = job.title.split('\n')[0].trim();

  let { score, cvText: boostedText, rawCvText, missingKeywords } = await scoreWithBoost(bestCV, job.description);
  let bestScore        = score;
  let bestCvText       = boostedText;
  let bestRawCvText    = rawCvText;
  let bestMissing      = missingKeywords;
  let bestCvName       = bestCV.name;

  // If the primary CV didn't reach target, try the others in keyword-score order
  if (score < BOOST_TARGET) {
    const others = cfg.CVS
      .filter(c => c.id !== bestCV.id)
      .map(c => ({ cv: c, kwScore: cvSelector.scoreCV(c, job.description) }))
      .sort((a, b) => b.kwScore - a.kwScore)
      .map(x => x.cv);

    for (const altCV of others) {
      console.log(`\n  [Scorer Bot] ${score}% — trying next CV: ${altCV.name}`);
      const result = await scoreWithBoost(altCV, job.description);

      if (result.score > bestScore) {
        bestScore     = result.score;
        bestCvText    = result.cvText;
        bestRawCvText = result.rawCvText;
        bestMissing   = result.missingKeywords;
        bestCvName    = altCV.name;
      }

      if (result.score >= BOOST_TARGET) break;
    }
  }

  if (bestScore >= cfg.MIN_SCORE) {
    const paths    = buildPaths(path.join(cfg.OUTPUT_DIR, 'saved_cvs'), cfg.OUTPUT_DIR, cfg.RESUME_FILENAME, job.title, job.company, bestScore);
    const bestCVObj = cfg.CVS.find(c => c.name === bestCvName) || cfg.CVS[0];
    const isDocx    = bestCVObj && /\.docx?$/i.test(bestCVObj.path);

    // Copy the original uploaded CV file directly — no AI rewriting
    const savedDir = path.dirname(paths.saved);
    if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });

    if (isDocx) {
      const docxPath = paths.saved.replace(/\.pdf$/i, '.docx');
      // Light-tailor: subtitle swap + synonym swap only — no layout changes
      try {
        const tailorResult = await lightTailorDocx(bestCVObj.path, docxPath, bestRawCvText, jobTitle, bestMissing);
        const changes = [
          tailorResult.subtitleSwapped ? 'subtitle' : '',
          ...tailorResult.synonymsSwapped,
        ].filter(Boolean);
        if (changes.length > 0) {
          console.log(`  [Scorer Bot] Light-tailored: ${changes.join(', ')}`);
        }
      } catch (err) {
        console.warn(`  [Scorer Bot] Light-tailor failed (${err.message}) — using original`);
        fs.copyFileSync(bestCVObj.path, docxPath);
      }
      try {
        await convertDocxToPdf(docxPath, paths.saved);
        await convertDocxToPdf(docxPath, paths.upload);
        console.log(`  [Scorer Bot] ✓ docx→PDF: ${paths.saved}`);
      } catch (err) {
        console.warn(`  [Scorer Bot] docx→PDF failed (${err.message}) — using pdfkit fallback`);
        const fullName = `${cfg.APPLICANT.firstName} ${cfg.APPLICANT.lastName}`.trim();
        const pdfOpts  = fullName ? { overrideName: fullName } : {};
        await writePDF(bestCvText, paths.saved, pdfOpts);
        await writePDF(bestCvText, paths.upload, pdfOpts);
      }
    } else {
      // PDF: copy original file directly (no DOCX XML to manipulate)
      fs.copyFileSync(bestCVObj.path, paths.saved);
      fs.copyFileSync(bestCVObj.path, paths.upload);
    }

    const flag = bestScore >= BOOST_TARGET ? '✓' : '~';
    console.log(`  [Scorer Bot] ${flag} ${bestCvName} → ${bestScore}% | PDF: ${paths.saved}`);

    // Mark cv_ready immediately — don't block on cover letter generation
    queue.update(job.jobId, {
      status:  'cv_ready',
      cvPath:  paths.saved,
      cvScore: bestScore,
      cvName:  bestCvName,
    });

    // Generate cover letter in background — updates queue when done
    generateCoverLetter(jobTitle, job.company, job.description, bestCvText)
      .then(coverLetter => {
        if (coverLetter) {
          queue.update(job.jobId, { coverLetter });
          console.log(`  [Scorer Bot] ✓ Cover letter ready for: ${job.title}`);
        }
      })
      .catch(err => console.warn(`  [Scorer Bot] Cover letter failed: ${err.message}`));

    return;
  }

  queue.update(job.jobId, {
    status: 'skipped',
    reason: `Best score across all CVs was ${bestScore}% (threshold: ${cfg.MIN_SCORE}%)`,
  });
  console.log(`  [Scorer Bot] ✗ No CV reached ${cfg.MIN_SCORE}% for "${job.title}" — skipped`);
}

async function main() {
  await cfg.init();
  await queue.init(process.env.JOBBOT_USERDATA);

  const modeLabel = llmMode === 'claude' ? 'Claude API' : llmMode === 'hosted' ? 'hosted backend' : 'local Ollama';
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Scorer Bot — Starting (${modeLabel}, no browser)`);
  console.log('  Watching queue.db for pending jobs...');
  console.log('═══════════════════════════════════════════════════════');

  // Report AI backend status at startup
  if (await llmAvailable()) {
    console.log(`  AI backend ready (${modeLabel})`);
  } else {
    console.log(`  WARNING: ${modeLabel} unavailable — will use fallback scoring (score=85 for all jobs)`);
  }

  // Recover any jobs stuck in 'processing' from a previous crashed run
  const stuck = queue.getByStatus('processing');
  if (stuck.length > 0) {
    console.log(`  [Scorer Bot] Recovering ${stuck.length} stuck job(s) from previous run...`);
    for (const j of stuck) {
      queue.update(j.jobId, { status: 'pending' });
      console.log(`  [Scorer Bot] Reset to pending: ${j.title}`);
    }
  }

  let logTick = 0;

  // Run forever — no idle exit. Reed bot continuously finds new jobs.
  while (true) {
    // Also recover jobs that got stuck in processing during this run (>30 min)
    const stuckNow = queue.getByStatus('processing').filter(j => {
      const age = Date.now() - new Date(j.updatedAt || j.addedAt).getTime();
      return age > STUCK_TIMEOUT_MS;
    });
    for (const j of stuckNow) {
      console.log(`  [Scorer Bot] Resetting stuck job (>30 min): ${j.title}`);
      queue.update(j.jobId, { status: 'pending' });
    }

    const pending = queue.getByStatus('pending');

    if (pending.length === 0) {
      logTick++;
      if (logTick % 18 === 0) { // log every ~3 min
        console.log('  [Scorer Bot] Waiting for new jobs...');
      }
      await DELAY(POLL_INTERVAL);
      continue;
    }

    logTick = 0;

    for (const job of pending) {
      try {
        await processJob(job);
      } catch (err) {
        console.error(`  [Scorer Bot] Error on "${job.title}": ${err.message}`);
        queue.update(job.jobId, { status: 'failed', error: err.message });
      }
      await DELAY(500); // brief pause between jobs
    }
  }
}

// Auto-restart on unexpected crash — wait 5 s then restart
async function run() {
  while (true) {
    try {
      await main();
    } catch (err) {
      console.error('  [Scorer Bot] Crashed:', err.message);
      console.log('  [Scorer Bot] Restarting in 5 s...');
      await DELAY(5000);
    }
  }
}

run();
