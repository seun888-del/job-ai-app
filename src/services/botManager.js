const { spawn } = require('child_process');
const path = require('path');
const { app, safeStorage } = require('electron');
const db = require('../db/database');
const { JOBBOT_BACKEND_URL } = require('../config');

const BOT_DIR = path.join(__dirname, '..', '..', 'bot');

const BOT_SCRIPTS = {
  reed:      'bot_reed.js',
  scorer:    'bot_scorer.js',
  linkedin:  'bot_linkedin.js',
  indeed:    'bot_indeed.js',
  glassdoor: 'bot_glassdoor.js',
};

const bots = {
  reed:      { proc: null, status: 'stopped', stopping: false },
  scorer:    { proc: null, status: 'stopped', stopping: false },
  linkedin:  { proc: null, status: 'stopped', stopping: false },
  indeed:    { proc: null, status: 'stopped', stopping: false },
  glassdoor: { proc: null, status: 'stopped', stopping: false },
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
    reed:      bots.reed.status,
    scorer:    bots.scorer.status,
    linkedin:  bots.linkedin.status,
    indeed:    bots.indeed.status,
    glassdoor: bots.glassdoor.status,
  };
}

// Spawn via the Electron binary itself (ELECTRON_RUN_AS_NODE) since a
// packaged app has no standalone node.exe on PATH.
function start(botName, userDataPath) {
  if (!BOT_SCRIPTS[botName]) throw new Error(`Unknown bot: ${botName}`);
  if (bots[botName].proc) return;

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    JOBBOT_USERDATA: userDataPath,
  };

  // In a packaged app, Playwright's browsers are bundled under resources/
  // rather than the dev-machine's ms-playwright cache.
  if (app.isPackaged) {
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'playwright-browsers');
  }

  // Hosted AI backend (test/commercial builds only): if a license key is
  // saved and active, pass it (and the backend URL) through so cv_tailor/
  // cv_scorer use the hosted backend instead of local Ollama.
  const license = db.getLicense();
  if (license && license.license_key && license.status !== 'expired') {
    env.JOBBOT_BACKEND_URL = JOBBOT_BACKEND_URL;
    env.JOBBOT_LICENSE_KEY = license.license_key;
  }

  if (botName === 'reed') {
    const cred = db.getCredential('reed');
    if (!cred || !cred.secret_enc) {
      throw new Error('No Reed credentials saved — add them in Settings before starting the Reed bot');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level credential encryption is not available on this machine');
    }
    env.REED_EMAIL = cred.username;
    env.REED_PASS = safeStorage.decryptString(Buffer.from(cred.secret_enc, 'base64'));
  }

  if (botName === 'linkedin') {
    const cred = db.getCredential('linkedin');
    if (!cred || !cred.secret_enc) {
      throw new Error('No LinkedIn credentials saved — add them in Job Site Login before starting the LinkedIn bot');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level credential encryption is not available on this machine');
    }
    env.LI_EMAIL = cred.username;
    env.LI_PASS = safeStorage.decryptString(Buffer.from(cred.secret_enc, 'base64'));
  }

  if (botName === 'indeed') {
    const cred = db.getCredential('indeed');
    if (!cred || !cred.secret_enc) {
      throw new Error('No Indeed credentials saved — add them in Job Site Login before starting the Indeed bot');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level credential encryption is not available on this machine');
    }
    env.INDEED_EMAIL = cred.username;
    env.INDEED_PASS = safeStorage.decryptString(Buffer.from(cred.secret_enc, 'base64'));
  }

  if (botName === 'glassdoor') {
    const cred = db.getCredential('glassdoor');
    if (!cred || !cred.secret_enc) {
      throw new Error('No Glassdoor credentials saved — add them in Job Site Login before starting the Glassdoor bot');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level credential encryption is not available on this machine');
    }
    env.GLASSDOOR_EMAIL = cred.username;
    env.GLASSDOOR_PASS = safeStorage.decryptString(Buffer.from(cred.secret_enc, 'base64'));
  }


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
  });

  proc.on('error', err => {
    if (logHandler) logHandler(botName, 'stderr', `Failed to start: ${err.message}\n`);
  });
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
