const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./src/db/database');
const queueReader = require('./src/db/queueReader');
const cvAnalyzer = require('./src/services/cvAnalyzer');
const botManager = require('./src/services/botManager');
const { JOBBOT_BACKEND_URL } = require('./src/config');

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
  botManager.setStatusHandler((bot, status) => {
    mainWindow?.webContents.send('bot:status', { bot, status });
  });

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

// ── Queue / dashboard ──────────────────────────────────────────────────────
ipcMain.handle('queue:summary', () => queueReader.getQueueSummary());
ipcMain.handle('queue:recent', (event, limit) => queueReader.getRecentApplications(limit));

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
