/**
 * Scorer Bot
 * ─────────────────────────────────────────────────────────────────────────
 * Watches queue.db for jobs with status "pending".
 * For each:
 *   1. Select the best-matching CV from the configured options (keyword scoring)
 *   2. Clean CV text (remove em-dashes, AI phrases)
 *   3. Tailor CV via local Ollama LLM (cv_tailor.js)
 *   4. Score CV against JD via local Ollama keyword extraction (cv_scorer.js)
 *   5. Boost: inject missing keywords, rescore (deterministic — no extra LLM calls)
 *   6. If best score >= MIN_SCORE: write PDF, set queue entry to "cv_ready"
 *   7. If no CV reaches threshold: mark job "skipped"
 *
 * No browser. No external services. Runs entirely on-device via Ollama.
 *
 * Run alongside bot_reed.js:
 *   node bot_scorer.js
 */

const path       = require('path');
const cfg        = require('./config');
const cvSelector = require('./modules/cv_selector');
const cvScorer   = require('./modules/cv_scorer');
const queue      = require('./modules/queue_manager');
const { cleanText }            = require('./modules/cv_cleaner');
const { writePDF, buildPaths } = require('./modules/cv_pdf_writer');
const { tailorCV }             = require('./modules/cv_tailor');
const { generateCoverLetter }  = require('./modules/cover_letter');
const { llmAvailable, isHosted, mode: llmMode } = require('../src/services/llm');

const MAX_BOOST_ATTEMPTS = 4;   // max keyword-inject rounds per CV
const QUICK_FAIL_THRESHOLD = 35; // skip a CV if its initial score is below this
const BOOST_TARGET = 85;        // score the boost loop aims for
const STUCK_TIMEOUT_MS = 10 * 60 * 1000; // reset 'processing' jobs stuck >10 min

const DELAY         = ms => new Promise(r => setTimeout(r, ms));
const POLL_INTERVAL = 10000;  // 10 s between queue checks

// Inject missing keywords into the CV text as an addendum line.
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

async function scoreWithBoost(cv, jdText, jobTitle) {
  const raw         = await cvSelector.extractPdfText(cv.path);
  const cleanedText = cleanText(raw);

  // Tailor CV — fall back to raw text if LLM unavailable
  let tailoredText = cleanedText;
  try {
    console.log(`  [Scorer Bot] Tailoring CV for: ${jobTitle}`);
    tailoredText = await tailorCV(cleanedText, jobTitle, jdText);
  } catch (err) {
    console.warn(`  [Scorer Bot] Tailoring failed (${err.message}) — using raw CV`);
  }

  // Score CV against JD — fall back to 85 if LLM unavailable
  let score, missingKeywords, allKeywords;
  try {
    ({ score, missingKeywords, allKeywords } = await cvScorer.scoreCV(tailoredText, jdText));
  } catch (err) {
    console.warn(`  [Scorer Bot] Scoring failed (${err.message}) — using fallback score 85`);
    return { score: 85, cvText: tailoredText };
  }

  let cvText     = tailoredText;
  let allInjected = [];

  console.log(`  [Scorer Bot] Initial score: ${score}% — ${cv.name}`);

  // Skip immediately if hopelessly irrelevant (score > 0 check avoids skipping on Ollama fallback)
  if (score > 0 && score < QUICK_FAIL_THRESHOLD) {
    console.log(`  [Scorer Bot] ${score}% below quick-fail (${QUICK_FAIL_THRESHOLD}%) — skipping`);
    return { score, cvText };
  }

  // Boost: inject missing keywords, rescore deterministically (no extra LLM calls)
  for (let attempt = 1; attempt < MAX_BOOST_ATTEMPTS && score < BOOST_TARGET; attempt++) {
    const newKeywords = missingKeywords.filter(k => !allInjected.includes(k));
    if (!newKeywords.length) {
      console.log('  [Scorer Bot] No new keywords to inject — stopping boost');
      break;
    }
    allInjected = allInjected.concat(newKeywords);
    cvText = boostCVText(tailoredText, allInjected);

    const rescore   = cvScorer.rescoreCV(cvText, allKeywords);
    score           = rescore.score;
    missingKeywords = rescore.missingKeywords;
    console.log(`  [Scorer Bot] Boost ${attempt}: injected ${newKeywords.length} keywords → ${score}%`);
  }

  return { score, cvText };
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

  queue.update(job.jobId, { status: 'processing' });

  const bestCV   = cvSelector.selectBestCV(job.description, cfg.CVS);
  const jobTitle = job.title.split('\n')[0].trim();

  let { score, cvText: boostedText } = await scoreWithBoost(bestCV, job.description, jobTitle);
  let bestScore  = score;
  let bestCvText = boostedText;
  let bestCvName = bestCV.name;

  // If the primary CV didn't reach target, try the others in keyword-score order
  if (score < BOOST_TARGET) {
    const others = cfg.CVS
      .filter(c => c.id !== bestCV.id)
      .map(c => ({ cv: c, kwScore: cvSelector.scoreCV(c, job.description) }))
      .sort((a, b) => b.kwScore - a.kwScore)
      .map(x => x.cv);

    for (const altCV of others) {
      console.log(`\n  [Scorer Bot] ${score}% — trying next CV: ${altCV.name}`);
      const result = await scoreWithBoost(altCV, job.description, jobTitle);

      if (result.score > bestScore) {
        bestScore  = result.score;
        bestCvText = result.cvText;
        bestCvName = altCV.name;
      }

      if (result.score >= BOOST_TARGET) break;
    }
  }

  if (bestScore >= cfg.MIN_SCORE) {
    const paths = buildPaths(path.join(cfg.OUTPUT_DIR, 'saved_cvs'), cfg.OUTPUT_DIR, cfg.RESUME_FILENAME, job.title, job.company, bestScore);
    await writePDF(bestCvText, paths.saved);
    await writePDF(bestCvText, paths.upload);
    const flag = bestScore >= BOOST_TARGET ? '✓' : '~';
    console.log(`  [Scorer Bot] ${flag} ${bestCvName} → ${bestScore}% | PDF: ${paths.saved}`);

    // Generate tailored cover letter
    let coverLetter = null;
    try {
      coverLetter = await generateCoverLetter(jobTitle, job.company, job.description, bestCvText);
      if (coverLetter) console.log(`  [Scorer Bot] ✓ Cover letter generated (${coverLetter.length} chars)`);
    } catch (err) {
      console.warn(`  [Scorer Bot] Cover letter generation failed: ${err.message}`);
    }

    queue.update(job.jobId, {
      status:      'cv_ready',
      cvPath:      paths.saved,
      cvScore:     bestScore,
      cvName:      bestCvName,
      coverLetter: coverLetter,
    });
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
      await DELAY(5000); // 5s between jobs to avoid rate limits
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
