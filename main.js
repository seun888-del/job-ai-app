const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Notification } = require('electron');
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

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
}

app.whenReady().then(async () => {
  await db.init(app.getPath('userData'));
  queueReader.init(app.getPath('userData'));
  createWindow();

  botManager.setLogHandler((bot, stream, text) => {
    mainWindow?.webContents.send('bot:log', { bot, stream, text });
  });
  const BOT_DISPLAY = { reed: 'Reed Bot', scorer: 'Scorer Bot', linkedin: 'LinkedIn Bot', indeed: 'Indeed Bot', glassdoor: 'Glassdoor Bot', cvlibrary: 'CV-Library Bot', totaljobs: 'Totaljobs Bot', cwjobs: 'CWJobs Bot' };
  botManager.setStatusHandler((bot, status) => {
    mainWindow?.webContents.send('bot:status', { bot, status });
    if ((status === 'stopped' || status === 'error') && Notification.isSupported()) {
      const label = BOT_DISPLAY[bot] || bot;
      new Notification({
        title: status === 'error' ? `${label} stopped with an error` : `${label} finished`,
        body: status === 'error' ? 'Check the bot logs for details.' : 'The bot has completed its run.',
        silent: false,
      }).show();
    }
  });

  // Daily summary email — check every 30 minutes after 6 PM
  setInterval(maybeSendDailySummary, 30 * 60 * 1000);
  maybeSendDailySummary(); // also run immediately on launch in case it's past 6 PM

  // Check for updates silently — download in background, install on next quit
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update:ready');
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
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
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

// ── Bot manager ──────────────────────────────────────────────────────────
ipcMain.handle('bot:start', (event, botName) => botManager.start(botName, app.getPath('userData')));
ipcMain.handle('bot:stop', (event, botName) => botManager.stop(botName));
ipcMain.handle('bot:status', () => botManager.getStatus());

// ── License ─────────────────────────────────────────────────────────────
ipcMain.handle('license:get', () => db.getLicense());
ipcMain.handle('license:save', (event, fields) => db.saveLicense(fields));

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

// ── Site Connect — opens Chrome (no Playwright/CDP) so user can log in ──
// The bot later uses launchPersistentContext on the same profileDir and
// finds an already-authenticated session — bot detection never fires.
ipcMain.handle('site:connect', async (event, { site, loginUrl }) => {
  const fs   = require('fs');
  const { execFile } = require('child_process');
  const profileDir = path.join(app.getPath('userData'), `${site}_profile`);

  // Find Chrome or Edge (ordered by preference)
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  const browserPath = candidates.find(p => { try { return fs.existsSync(p); } catch(_) { return false; } });
  if (!browserPath) return { success: false, error: 'Chrome or Edge not found on this computer.' };

  return new Promise((resolve) => {
    const proc = execFile(browserPath, [
      `--user-data-dir=${profileDir}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      loginUrl,
    ]);
    proc.on('close', () => resolve({ success: true }));
    proc.on('error', (err) => resolve({ success: false, error: err.message }));
  });
});
