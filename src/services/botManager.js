const { spawn } = require('child_process');
const path = require('path');
const { app, safeStorage } = require('electron');
const db = require('../db/database');
const { JOBBOT_BACKEND_URL } = require('../config');

const BOT_DIR = path.join(__dirname, '..', '..', 'bot');

const BOT_SCRIPTS = {
  reed:       'bot_reed.js',
  scorer:     'bot_scorer.js',
  linkedin:   'bot_linkedin.js',
  indeed:     'bot_indeed.js',
  glassdoor:  'bot_glassdoor.js',
  cvlibrary:  'bot_cvlibrary.js',
  totaljobs:  'bot_totaljobs.js',
  cwjobs:     'bot_cwjobs.js',
};

const bots = {
  reed:       { proc: null, status: 'stopped', stopping: false },
  scorer:     { proc: null, status: 'stopped', stopping: false },
  linkedin:   { proc: null, status: 'stopped', stopping: false },
  indeed:     { proc: null, status: 'stopped', stopping: false },
  glassdoor:  { proc: null, status: 'stopped', stopping: false },
  cvlibrary:  { proc: null, status: 'stopped', stopping: false },
  totaljobs:  { proc: null, status: 'stopped', stopping: false },
  cwjobs:     { proc: null, status: 'stopped', stopping: false },
};

let logHandler = null;
let statusHandler = null;

function setLogHandler(fn) { logHandler = fn; }
function setStatusHandler(fn) { statusHandler = fn; }

function emitStatus(botName, status) {
  bots[botName].status = status;
  if (statusHandler) statusHandler(botName, status);
}

function getStatus() {
  return {
    reed:       bots.reed.status,
    scorer:     bots.scorer.status,
    linkedin:   bots.linkedin.status,
    indeed:     bots.indeed.status,
    glassdoor:  bots.glassdoor.status,
    cvlibrary:  bots.cvlibrary.status,
    totaljobs:  bots.totaljobs.status,
    cwjobs:     bots.cwjobs.status,
  };
}

const JOB_SITE_BOTS = new Set(['reed', 'linkedin']);

function anyJobSiteBotRunning() {
  return [...JOB_SITE_BOTS].some(name => bots[name].proc !== null);
}

function isWithinSchedule() {
  const prefs = db.getSearchPreferences();
  if (!prefs.schedule_enabled) return true;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const now = new Date();
  const today = DAY_NAMES[now.getDay()];
  const allowedDays = (prefs.schedule_days || 'Mon,Tue,Wed,Thu,Fri').split(',');
  if (!allowedDays.includes(today)) return false;
  const hour = now.getHours();
  return hour >= (prefs.schedule_start ?? 9) && hour < (prefs.schedule_end ?? 18);
}

// Spawn via the Electron binary itself (ELECTRON_RUN_AS_NODE) since a
// packaged app has no standalone node.exe on PATH.
// opts.cdpPort — if set, the bot attaches to the already-open Chrome via CDP
//                instead of launching a new browser. This reuses the exact
//                logged-in session from the "Connect account" window.
function start(botName, userDataPath, opts = {}) {
  if (!BOT_SCRIPTS[botName]) throw new Error(`Unknown bot: ${botName}`);
  if (bots[botName].proc) return;

  // Scorer processes the queue regardless of schedule — only search bots are time-gated
  if (botName !== 'scorer' && !isWithinSchedule()) {
    const prefs = db.getSearchPreferences();
    throw new Error(`Outside scheduled hours (${prefs.schedule_start}:00–${prefs.schedule_end}:00). Change your schedule in Search Preferences.`);
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    JOBBOT_USERDATA: userDataPath,
  };

  // Ollama URL saved via AI Settings — inject so bots connect to the right Ollama instance
  const ollamaCred = db.getCredential('ollama');
  if (ollamaCred?.secret_enc && safeStorage.isEncryptionAvailable()) {
    try { env.OLLAMA_URL = safeStorage.decryptString(Buffer.from(ollamaCred.secret_enc, 'base64')); } catch (_) {}
  }

  // If Chrome is still open from "Connect account", pass the CDP port so the
  // bot can attach to that live session instead of launching a new browser.
  if (opts.cdpPort) {
    env.JOBBOT_CDP_PORT = String(opts.cdpPort);
  }

  // Reed API key for direct API job search (Phase 1 without browser)
  if (opts.reedApiKey) {
    env.REED_API_KEY = opts.reedApiKey;
  }

  // No bundled Chromium: the agents drive the user's REAL Chrome/Edge via
  // Playwright's `channel` option, so Playwright never needs its own browser
  // download. Not bundling it keeps the app ~150MB smaller and makes macOS
  // codesign + notarization fast (no thousands of Chromium binaries to sign).

  // Hosted AI backend (test/commercial builds only): if a license key is
  // saved and active, pass it (and the backend URL) through so cv_tailor/
  // cv_scorer use the hosted backend instead of local Ollama.
  // Always pass the license key + backend URL so AI routes through the licensed
  // backend. The backend is the single authority on validity — it rejects
  // revoked / expired / over-limit licenses — so we don't pre-judge status here
  // (pre-judging would let an "expired" local record fall back to a direct key).
  const license = db.getLicense();
  if (license && license.license_key) {
    env.JOBBOT_BACKEND_URL = JOBBOT_BACKEND_URL;
    env.JOBBOT_LICENSE_KEY = license.license_key;
  }

  // All bots use Chrome profiles from "Connect account" — no stored credentials needed.

  const scriptPath = path.join(BOT_DIR, BOT_SCRIPTS[botName]);
  const proc = spawn(process.execPath, [scriptPath], { cwd: BOT_DIR, env });

  bots[botName].proc = proc;
  db.recordBotStart(botName);
  emitStatus(botName, 'running');

  proc.stdout.on('data', chunk => { if (logHandler) logHandler(botName, 'stdout', chunk.toString()); });
  proc.stderr.on('data', chunk => { if (logHandler) logHandler(botName, 'stderr', chunk.toString()); });

  proc.on('exit', code => {
    bots[botName].proc = null;
    const finalStatus = bots[botName].stopping || code === 0 ? 'stopped' : 'error';
    bots[botName].stopping = false;
    db.recordBotStop(botName, finalStatus);
    emitStatus(botName, finalStatus);

    // Auto-stop scorer when the last job site bot exits
    if (JOB_SITE_BOTS.has(botName) && !anyJobSiteBotRunning() && bots.scorer.proc) {
      if (logHandler) logHandler('scorer', 'stdout', '[Scorer] All job site bots stopped — stopping scorer automatically.\n');
      stop('scorer');
    }
  });

  proc.on('error', err => {
    if (logHandler) logHandler(botName, 'stderr', `Failed to start: ${err.message}\n`);
  });

  // Auto-start scorer alongside any job site bot (if not already running)
  if (JOB_SITE_BOTS.has(botName) && !bots.scorer.proc) {
    try {
      start('scorer', userDataPath, {});
      if (logHandler) logHandler('scorer', 'stdout', '[Scorer] Auto-started alongside ' + botName + '.\n');
    } catch (e) {
      if (logHandler) logHandler('scorer', 'stderr', '[Scorer] Auto-start failed: ' + e.message + '\n');
    }
  }
}

// Force-kill the whole process tree on Windows — Playwright's Chromium runs
// as a child of the bot process and survives a plain proc.kill() otherwise.
function stop(botName) {
  const bot = bots[botName];
  if (!bot || !bot.proc) return;

  bot.stopping = true;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(bot.proc.pid), '/t', '/f']);
  } else {
    bot.proc.kill();
  }
}

function stopAll() {
  for (const botName of Object.keys(bots)) stop(botName);
}

module.exports = {
  start,
  stop,
  stopAll,
  getStatus,
  setLogHandler,
  setStatusHandler,
};
