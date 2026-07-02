const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Notification, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const db = require('./src/db/database');
const queueReader = require('./src/db/queueReader');
const cvAnalyzer = require('./src/services/cvAnalyzer');
const botManager = require('./src/services/botManager');
const https = require('https');
const { JOBBOT_BACKEND_URL } = require('./src/config');

autoUpdater.setFeedURL({ provider: 'github', owner: 'seun888-del', repo: 'jobbot-app' });
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// "Restart & update now" button in the renderer triggers an immediate, silent
// install + relaunch (before-quit stops all Agents first). Without this the
// update only applies whenever the user happens to close the app.
ipcMain.handle('update:install', () => {
  try {
    autoUpdater.quitAndInstall(true, true); // isSilent, isForceRunAfter
  } catch (e) {
    console.error('[Updater] quitAndInstall failed:', e?.message);
  }
});

let mainWindow;

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0b1f3a',
    // Navy custom title bar; the menu lives inside it (rendered by the app).
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { color: '#0b1f3a', symbolColor: '#ffffff', height: 38 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
}

// We render our own menu in the navy title bar, so remove the native one.
Menu.setApplicationMenu(null);

// Actions invoked by the custom in-title-bar menu (File/Edit/View/Window/Help).
ipcMain.handle('win:action', (_e, action) => {
  const w = mainWindow;
  if (!w) return;
  const wc = w.webContents;
  switch (action) {
    case 'minimize':       w.minimize(); break;
    case 'close':          w.close(); break;
    case 'quit':           app.quit(); break;
    case 'reload':         wc.reload(); break;
    case 'toggleDevTools': wc.toggleDevTools(); break;
    case 'fullscreen':     w.setFullScreen(!w.isFullScreen()); break;
    case 'zoomIn':         wc.setZoomLevel(wc.getZoomLevel() + 0.5); break;
    case 'zoomOut':        wc.setZoomLevel(wc.getZoomLevel() - 0.5); break;
    case 'zoomReset':      wc.setZoomLevel(0); break;
    case 'undo':           wc.undo(); break;
    case 'redo':           wc.redo(); break;
    case 'cut':            wc.cut(); break;
    case 'copy':           wc.copy(); break;
    case 'paste':          wc.paste(); break;
    case 'selectAll':      wc.selectAll(); break;
    case 'about':          dialog.showMessageBox(w, { type: 'info', title: 'About Job-AI', message: 'Job-AI', detail: 'Version ' + app.getVersion() }); break;
  }
});

// Single-instance lock — prevents a second copy of the app from starting
// (e.g. double-clicking the icon while an installer/update is running). A second
// instance would lock the app's files and can corrupt an in-progress install.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  await db.init(app.getPath('userData'));
  syncLicenseEnv(); // route main-process AI (CV analysis) through the licensed backend
  queueReader.init(app.getPath('userData'));
  createWindow();

  const BOT_DISPLAY = { reed: 'Reed Agent', scorer: 'Scorer Agent', linkedin: 'LinkedIn Agent', indeed: 'Indeed Agent', glassdoor: 'Glassdoor Agent', cvlibrary: 'CV-Library Agent', totaljobs: 'Totaljobs Agent', cwjobs: 'CWJobs Agent' };
  // Persist agent logs to disk so real runs can be inspected after the fact
  // (the in-app Agent tab only shows the live session). One file per UTC day.
  const agentLogFile = () => path.join(app.getPath('userData'), 'logs', `agents-${new Date().toISOString().slice(0, 10)}.log`);
  botManager.setLogHandler((bot, stream, text) => {
    // Agents run minimised, so surface "human verification needed" as a desktop
    // notification (the bot emits a [[JOBBOT_NOTIFY]] marker in its log stream).
    const idx = text.indexOf('[[JOBBOT_NOTIFY]]');
    if (idx !== -1 && Notification.isSupported()) {
      const msg = text.slice(idx + 17).trim() || 'Action needed in the Agent browser window.';
      new Notification({ title: `${BOT_DISPLAY[bot] || bot}: action needed`, body: msg, silent: false }).show();
    }
    // When an agent hits the user's daily application limit, notify ONCE per day
    // (the agents log this many times as they keep checking, so we de-dupe).
    if (/daily limit reached/i.test(text) && !dailyLimitNotifiedToday() && Notification.isSupported()) {
      markDailyLimitNotified();
      const m = text.match(/\((\d+)\s*\/\s*(\d+)\)/);
      const detail = m ? ` (${m[1]}/${m[2]})` : '';
      const note = new Notification({
        title: 'Daily application limit reached',
        body: `Job-AI applied to your daily maximum${detail} for today and will resume tomorrow. To apply more per day, raise "Max applications per day" in Search Preferences.`,
        silent: false,
      });
      note.on('click', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
      note.show();
    }
    try {
      const file = agentLogFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFile(file, `[${new Date().toISOString()}] [${bot}/${stream}] ${text}`, () => {});
    } catch (_) {}
    mainWindow?.webContents.send('bot:log', { bot, stream, text });
  });
  botManager.setStatusHandler((bot, status) => {
    mainWindow?.webContents.send('bot:status', { bot, status });
    if ((status === 'stopped' || status === 'error') && Notification.isSupported()) {
      const label = BOT_DISPLAY[bot] || bot;
      new Notification({
        title: status === 'error' ? `${label} stopped with an error` : `${label} finished`,
        body: status === 'error' ? 'Check the Agent logs for details.' : 'The Agent has completed its run.',
        silent: false,
      }).show();
    }
  });

  // Daily summary email — check every 30 minutes after 6 PM
  setInterval(maybeSendDailySummary, 30 * 60 * 1000);
  maybeSendDailySummary(); // also run immediately on launch in case it's past 6 PM

  // Anonymous install beacon (once per install) — feeds the founder funnel stats
  sendInstallBeacon();

  // Check for updates silently — download in background, install on next quit
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update:available', info?.version);
    });
    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('update:ready', info?.version);
    });
    autoUpdater.on('error', (err) => {
      console.error('[Updater] Error:', err?.message);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  botManager.stopAll();
});

// ── Daily summary email ───────────────────────────────────────────────────
function getSummaryStateFile() {
  return path.join(app.getPath('userData'), 'daily_summary_state.json');
}

// Track whether we've already shown the "daily application limit reached" notice
// today, so it fires once per day rather than on every limit check.
function dailyLimitStateFile() { return path.join(app.getPath('userData'), 'daily_limit_notice.json'); }
function dailyLimitNotifiedToday() {
  try { return JSON.parse(fs.readFileSync(dailyLimitStateFile(), 'utf8')).date === new Date().toISOString().slice(0, 10); }
  catch { return false; }
}
function markDailyLimitNotified() {
  try { fs.writeFileSync(dailyLimitStateFile(), JSON.stringify({ date: new Date().toISOString().slice(0, 10) }), 'utf8'); } catch (_) {}
}

function getLastSentDate() {
  try { return JSON.parse(fs.readFileSync(getSummaryStateFile(), 'utf8')).lastSent || ''; } catch { return ''; }
}

function markSentToday(date) {
  fs.writeFileSync(getSummaryStateFile(), JSON.stringify({ lastSent: date }), 'utf8');
}

async function maybeSendDailySummary() {
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() < 18) return; // only after 6 PM
    if (getLastSentDate() === today) return; // already sent today

    const license = db.getLicense();
    if (!license?.license_key || !['active', 'trial'].includes(license?.status)) return;

    const data = await queueReader.getDailySummaryData();
    if (!data || (data.applied.length === 0 && data.failed.length === 0)) return;

    const body = JSON.stringify({ license_key: license.license_key, date: today, ...data });
    const url = new URL(`${JOBBOT_BACKEND_URL}/api/daily-summary`);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    markSentToday(today);
    console.log('[summary] Daily summary email sent for', today);
  } catch (err) {
    console.error('[summary] Failed to send daily summary:', err.message);
  }
}

// ── Anonymous install beacon ─────────────────────────────────────────────
// Fires once per install so the backend can count installs for the
// download → install → trial → subscribe funnel. No personal data: just a
// random id generated on this machine, plus platform and app version. The
// server dedupes by id, so re-sends are harmless; we keep a local "beaconed"
// flag only to avoid needless network calls, and retry next launch if offline.
function getInstallIdFile() {
  return path.join(app.getPath('userData'), 'install_id.json');
}

async function sendInstallBeacon() {
  try {
    const file = getInstallIdFile();
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
    if (!state.id) {
      state.id = require('crypto').randomUUID();
      state.beaconed = false;
      fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    }
    if (state.beaconed) return; // already counted

    const body = JSON.stringify({ install_id: state.id, platform: process.platform, version: app.getVersion() });
    const url = new URL(`${JOBBOT_BACKEND_URL}/v1/telemetry/install`);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        res.resume();
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('HTTP ' + res.statusCode))));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    state.beaconed = true;
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    console.log('[telemetry] Install beacon sent');
  } catch (err) {
    // Offline / backend down — leave beaconed=false so it retries next launch.
    console.error('[telemetry] Install beacon failed (will retry):', err.message);
  }
}

// ── Profile ─────────────────────────────────────────────────────────────
ipcMain.handle('profile:get', () => db.getProfile());
ipcMain.handle('profile:save', (event, fields) => db.saveProfile(fields));

// ── Search preferences / terms / exclude keywords ─────────────────────────
ipcMain.handle('searchPrefs:get', () => db.getSearchPreferences());
ipcMain.handle('searchPrefs:save', (event, fields) => db.saveSearchPreferences(fields));

ipcMain.handle('searchTerms:get', () => db.getSearchTerms(true));
ipcMain.handle('searchTerms:add', (event, terms, source) => db.addSearchTerms(terms, source));
ipcMain.handle('searchTerms:delete', (event, id) => db.deleteSearchTerm(id));
ipcMain.handle('searchTerms:setActive', (event, id, isActive) => db.setSearchTermActive(id, isActive));

ipcMain.handle('excludeKeywords:get', () => db.getExcludeKeywords(true));
ipcMain.handle('excludeKeywords:add', (event, keyword) => db.addExcludeKeyword(keyword));
ipcMain.handle('excludeKeywords:delete', (event, id) => db.deleteExcludeKeyword(id));
ipcMain.handle('excludeKeywords:setActive', (event, id, isActive) => db.setExcludeKeywordActive(id, isActive));

// ── CVs ─────────────────────────────────────────────────────────────────
ipcMain.handle('cvs:get', () => db.getCVs());

ipcMain.handle('cvs:pickAndAdd', async (event, label) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'CV Files', extensions: ['pdf', 'docx', 'doc'] },
      { name: 'Word Document', extensions: ['docx', 'doc'] },
      { name: 'PDF', extensions: ['pdf'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const file_path = result.filePaths[0];
  const { keywords, suggestedRoles } = await cvAnalyzer.analyzeCV(file_path);
  return db.addCV({ label, file_path, extracted_keywords: keywords, suggested_roles: suggestedRoles });
});

ipcMain.handle('cvs:addSuggestedTerms', (event, cvId) => {
  const cv = db.getCVs().find(c => c.id === cvId);
  if (!cv || !cv.suggested_roles.length) return db.getSearchTerms(false);
  return db.addSearchTerms(cv.suggested_roles, 'ai_generated');
});

ipcMain.handle('cvs:remove', (event, cvId) => {
  db.removeCV(cvId);
});

// ── Credentials (encrypted via OS-level safeStorage) ───────────────────────
ipcMain.handle('credentials:save', (event, { site, username, password }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is not available on this machine');
  }
  const secret_enc = safeStorage.encryptString(password).toString('base64');
  const result = db.saveCredential({ site, username, secret_enc });

  // Clear cached session so the bot re-authenticates with the new credentials
  if (site === 'reed') {
    const sessionFile = path.join(app.getPath('userData'), 'reed_session.json');
    try { fs.unlinkSync(sessionFile); } catch (_) {}
  }

  return result;
});

ipcMain.handle('credentials:get', (event, site) => {
  const row = db.getCredential(site);
  if (!row) return null;
  let password = null;
  if (row.secret_enc && safeStorage.isEncryptionAvailable()) {
    password = safeStorage.decryptString(Buffer.from(row.secret_enc, 'base64'));
  }
  return { username: row.username, password, session_valid: !!row.session_valid };
});

// ── Company blacklist ─────────────────────────────────────────────────────
ipcMain.handle('blacklist:get', () => db.getCompanyBlacklist());
ipcMain.handle('blacklist:add', (event, company) => db.addCompanyToBlacklist(company));
ipcMain.handle('blacklist:remove', (event, id) => db.removeCompanyFromBlacklist(id));

// ── Interview Tracker ─────────────────────────────────────────────────────
ipcMain.handle('tracker:get', () => db.getTracker());
ipcMain.handle('tracker:sync', async () => {
  const jobs = await queueReader.getAppliedJobsForSync();
  for (const job of jobs) db.syncTrackerEntry(job);
  return db.getTracker();
});
ipcMain.handle('tracker:update', (event, id, fields) => db.updateTrackerEntry(id, fields));
ipcMain.handle('tracker:delete', (event, id) => db.deleteTrackerEntry(id));

// ── Analytics ────────────────────────────────────────────────────────────
ipcMain.handle('analytics:get', () => queueReader.getAnalytics());

// ── Queue / dashboard ──────────────────────────────────────────────────────
ipcMain.handle('queue:summary', () => queueReader.getQueueSummary());
ipcMain.handle('queue:recent', (event, limit) => queueReader.getRecentApplications(limit));
ipcMain.handle('queue:dailyApplications', (event, days) => queueReader.getDailyApplications(days || 14));

// ── License gate for the agents ───────────────────────────────────────────
// Offline-safe local check: a valid license exists, is active/trial, and has
// not passed its expiry. Catches an ended trial even when the stored status is
// still 'trial' (the backend only flips it to 'expired' on the next call).
function licenseLocallyValid(license) {
  if (!license?.license_key) return false;
  if (!['active', 'trial'].includes(license.status)) return false;
  if (license.expires_at && new Date(license.expires_at).getTime() <= Date.now()) return false;
  return true;
}

// Authoritative access check before starting any agent. Local expiry is the
// offline-safe gate; the backend re-check also catches a revoked / cancelled-
// and-not-renewed subscription. Fails OPEN only on network error, so a paying
// user who is briefly offline is never locked out. A 429 (daily AI quota) is
// NOT an expiry and must not block the agents.
async function agentAccessAllowed() {
  const license = db.getLicense();
  if (!licenseLocallyValid(license)) {
    return { ok: false, reason: license?.license_key ? 'expired' : 'no_license' };
  }
  try {
    const res = await fetch(`${JOBBOT_BACKEND_URL}/v1/license`, {
      headers: { Authorization: `Bearer ${license.license_key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) return { ok: true }; // valid licence, just daily-throttled
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.status) {
        const status = ['trial', 'active', 'expired'].includes(data.status) ? data.status : 'expired';
        db.saveLicense({ license_key: data.license_key, email: data.email, status, expires_at: data.expires_at });
        const lapsed = data.expires_at && new Date(data.expires_at).getTime() <= Date.now();
        if (!['trial', 'active'].includes(status) || lapsed) return { ok: false, reason: 'expired' };
      }
      return { ok: true };
    }
    if (res.status === 401 || res.status === 403) { // inactive per the backend
      try { db.saveLicense({ license_key: license.license_key, email: license.email, status: 'expired', expires_at: license.expires_at }); } catch (_) {}
      return { ok: false, reason: 'expired' };
    }
    return { ok: true }; // other backend errors: don't lock out a valid user
  } catch (_) {
    return { ok: true }; // offline: trust the local check that already passed
  }
}

// ── Bot manager ──────────────────────────────────────────────────────────
ipcMain.handle('bot:start', async (event, botName) => {
  // Gate: no agent may run without a currently-valid trial or subscription.
  const access = await agentAccessAllowed();
  if (!access.ok) {
    const err = new Error(access.reason === 'no_license'
      ? 'Activate a license to start the Agents.'
      : 'Your Job-AI access has ended. Subscribe to keep the Agents applying for you.');
    err.code = 'license_required';
    throw err;
  }

  const userData = app.getPath('userData');
  const cdpPort = connectPorts.get(botName); // set if Chrome is still open
  if (cdpPort) {
    // Chrome is still running from "Connect account" — attach the bot to it
    // directly via CDP. No kill, no relaunch, same session.
    return botManager.start(botName, userData, { cdpPort });
  }

  // Chrome was already closed — open fresh with the saved profile
  const profileDir = path.join(userData, `${botName}_profile`);
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch (_) {}
  }
  return botManager.start(botName, userData, {});
});
ipcMain.handle('bot:stop', (event, botName) => botManager.stop(botName));
ipcMain.handle('bot:status', () => botManager.getStatus());

// ── License ─────────────────────────────────────────────────────────────
// Keep process.env in sync with the stored license so main-process AI (e.g. CV
// analysis) routes through the licensed backend — identical to the bots, which
// get the key via spawn env. Without this, the main process would have no key
// and (in dev) could fall back to a local model. Called at startup and whenever
// the license changes. llm.js reads the key dynamically, so this takes effect
// immediately.
function syncLicenseEnv() {
  try {
    const lic = db.getLicense();
    if (lic && lic.license_key) {
      process.env.JOBBOT_LICENSE_KEY = lic.license_key;
      process.env.JOBBOT_BACKEND_URL = JOBBOT_BACKEND_URL;
    } else {
      delete process.env.JOBBOT_LICENSE_KEY;
    }
  } catch (_) {}
}

ipcMain.handle('license:get', () => db.getLicense());
ipcMain.handle('license:save', (event, fields) => { const r = db.saveLicense(fields); syncLicenseEnv(); return r; });

// Opens the Stripe billing portal (manage payment / cancel) in the browser.
ipcMain.handle('license:manageSubscription', async () => {
  const license = db.getLicense();
  if (!license?.license_key) return { ok: false, error: 'no_license' };
  let res;
  try {
    res = await fetch(`${JOBBOT_BACKEND_URL}/billing-portal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${license.license_key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) {
    return { ok: false, error: body.error || `http_${res.status}` };
  }
  shell.openExternal(body.url);
  return { ok: true };
});

ipcMain.handle('license:startTrial', async (event, email) => {
  let res;
  try {
    res = await fetch(`${JOBBOT_BACKEND_URL}/trial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }

  const body = await res.json().catch(() => ({}));
  if (!body.ok || !body.license_key) {
    return { ok: false, error: body.error || `http_${res.status}` };
  }

  return { ok: true, license_key: body.license_key };
});

ipcMain.handle('license:verify', async (event, key) => {
  const licenseKey = (key || '').trim();
  if (!licenseKey) return { ok: false, error: 'missing_key' };

  let res;
  try {
    res = await fetch(`${JOBBOT_BACKEND_URL}/v1/license`, {
      headers: { Authorization: `Bearer ${licenseKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || `http_${res.status}` };
  }

  const data = await res.json();
  // Local `license` table only allows trial/active/expired — fold any other
  // backend status (e.g. revoked) into expired.
  const status = ['trial', 'active', 'expired'].includes(data.status) ? data.status : 'expired';

  db.saveLicense({
    license_key: data.license_key,
    email: data.email,
    status,
    expires_at: data.expires_at,
  });
  syncLicenseEnv(); // main-process AI now uses this license via the backend

  return {
    ok: true,
    license: db.getLicense(),
    usage: {
      usage_today: data.usage_today,
      daily_limit: data.daily_limit,
      cost_today_usd: data.cost_today_usd,
    },
  };
});

// ── Shell ────────────────────────────────────────────────────────────────
ipcMain.handle('shell:openPath', (event, filePath) => shell.openPath(filePath));

// ── Site Connect ──────────────────────────────────────────────────────────
// Opens real Chrome with --remote-debugging-port so Playwright can attach to
// the SAME Chrome window the user logged in with (connectOverCDP).
// This reuses the live session — no cookie export, no new Chrome launch.
const connectProcs = new Map();   // site → ChildProcess
const connectPorts = new Map();   // site → CDP port (while Chrome is open)

const SITE_DEBUG_PORTS = {
  reed: 9222, linkedin: 9223, indeed: 9224,
  glassdoor: 9225, cvlibrary: 9226, totaljobs: 9227, cwjobs: 9228,
};

// ── Chrome Session Import ─────────────────────────────────────────────────
// Copies the user's real Chrome profile (cookies, localStorage, cf_clearance)
// into the bot's profile dir so the bot inherits the user's trusted session.
// This avoids Cloudflare Turnstile because the cf_clearance cookie is already
// present from the user's real browser history.
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { copyDirSync(s, d); }
    else { try { fs.copyFileSync(s, d); } catch (_) {} }
  }
}

ipcMain.handle('session:importChrome', async (event, botName) => {
  const chromeData = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  if (!fs.existsSync(chromeData)) {
    return { ok: false, error: 'Google Chrome not found on this machine.' };
  }

  const botProfile = path.join(app.getPath('userData'), `${botName}_profile`);
  fs.mkdirSync(path.join(botProfile, 'Default'), { recursive: true });

  const errors = [];

  // Local State holds the AES key used to decrypt cookie values (DPAPI-wrapped).
  // Must be copied alongside Cookies or the bot cannot read the cookie values.
  try { fs.copyFileSync(path.join(chromeData, 'Local State'), path.join(botProfile, 'Local State')); }
  catch (e) { errors.push(`Local State: ${e.message}`); }

  // Cookies DB — contains cf_clearance, session tokens, auth cookies for all sites
  try { fs.copyFileSync(path.join(chromeData, 'Default', 'Cookies'), path.join(botProfile, 'Default', 'Cookies')); }
  catch (e) { errors.push(`Cookies: ${e.message}`); }

  // localStorage — site auth state (e.g. Indeed session storage)
  const lsSrc = path.join(chromeData, 'Default', 'Local Storage');
  if (fs.existsSync(lsSrc)) {
    try { copyDirSync(lsSrc, path.join(botProfile, 'Default', 'Local Storage')); }
    catch (e) { errors.push(`Local Storage: ${e.message}`); }
  }

  // Network state — HSTS, certificate pinning, trust signals
  const netSrc = path.join(chromeData, 'Default', 'Network');
  if (fs.existsSync(netSrc)) {
    try { copyDirSync(netSrc, path.join(botProfile, 'Default', 'Network')); }
    catch (e) { errors.push(`Network: ${e.message}`); }
  }

  // Remove singleton locks so Playwright can open the profile
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(botProfile, lock)); } catch (_) {}
  }

  const cookiesLocked = errors.some(e => e.includes('Cookies'));
  if (cookiesLocked) {
    return { ok: false, chromeOpen: true, error: 'Please close Google Chrome first, then try again.' };
  }

  return { ok: true, warnings: errors.length ? errors : undefined };
});

ipcMain.handle('site:connect', async (event, { site, loginUrl }) => {
  const profileDir = path.join(app.getPath('userData'), `${site}_profile`);

  // Kill any existing connect window for this site
  const existingPid = connectProcs.get(site);
  if (existingPid) {
    try { process.kill(existingPid); } catch (_) {}
    connectProcs.delete(site);
    await new Promise(r => setTimeout(r, 500));
  }

  // Remove stale Chrome lock files so a fresh instance opens cleanly
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch (_) {}
  }

  // Find real Chrome or Edge — must match what the bot will use
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  const browserPath = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!browserPath) return { success: false, error: 'Chrome or Edge not found on this computer.' };

  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const port = SITE_DEBUG_PORTS[site] || 9229;

    // Glassdoor Easy Apply routes through Indeed's OAuth, so the glassdoor_profile
    // must have an active Indeed session. Open Indeed login first so the user logs
    // into both sites in the same Chrome window.
    const extraUrls = site === 'glassdoor' ? ['https://uk.indeed.com/account/login'] : [];

    const proc = execFile(browserPath, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-notifications',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      ...extraUrls,
      loginUrl,
    ]);
    connectProcs.set(site, proc.pid);
    connectPorts.set(site, port);
    proc.on('spawn', () => resolve({ success: true }));
    proc.on('error', (err) => { connectProcs.delete(site); connectPorts.delete(site); resolve({ success: false, error: err.message }); });
    proc.on('close', () => { connectProcs.delete(site); connectPorts.delete(site); });
  });
});

// Reports which sites the user has connected an account for. A session-based
// site (LinkedIn etc.) stores nothing in `credentials` — its login lives in a
// `{site}_profile` Chrome folder — so we detect connection by that folder's
// populated "Default" profile, OR (for password sites like Reed) a saved login.
ipcMain.handle('site:connectedStatus', () => {
  const sites = ['reed', 'linkedin', 'glassdoor', 'cvlibrary', 'totaljobs', 'cwjobs', 'indeed'];
  const status = {};
  for (const site of sites) {
    let connected = false;
    try {
      const profileDir = path.join(app.getPath('userData'), `${site}_profile`);
      if (fs.existsSync(path.join(profileDir, 'Default'))) connected = true;
    } catch (_) {}
    if (!connected) {
      try { if (db.getCredential(site)?.username) connected = true; } catch (_) {}
    }
    status[site] = connected;
  }
  return status;
});
