// Anonymous error reporter. Sends field errors to the backend so we can observe
// what's breaking for users — GDPR-safe: only the random install id leaves the
// machine (NO email / license / IP), and messages/stacks are PII-scrubbed here
// before sending. Respects a user opt-out and is deduped + rate-capped so a
// crash loop can never spam.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { JOBBOT_BACKEND_URL } = require('../config');

const DEDUP_MS = 10 * 60 * 1000; // don't resend the same error within 10 min
const SESSION_CAP = 50;          // hard cap per app run
const sentAt = new Map();        // fingerprint -> last sent ms
let sessionCount = 0;
let _installId;

function stateFile(name) { return path.join(app.getPath('userData'), name); }

// Reuse the existing anonymous install id (same one the install beacon uses).
function installId() {
  if (_installId !== undefined) return _installId;
  try { _installId = JSON.parse(fs.readFileSync(stateFile('install_id.json'), 'utf8')).id || null; }
  catch { _installId = null; }
  return _installId;
}

// Diagnostics opt-out. Default ON (legitimate interest); user can disable it.
function diagnosticsEnabled() {
  try { return JSON.parse(fs.readFileSync(stateFile('diagnostics.json'), 'utf8')).enabled !== false; }
  catch { return true; }
}
function setDiagnosticsEnabled(v) {
  try { fs.writeFileSync(stateFile('diagnostics.json'), JSON.stringify({ enabled: !!v }), 'utf8'); } catch (_) {}
  return diagnosticsEnabled();
}

// Strip anything that could identify a person before it leaves the device.
function scrub(s, max = 4000) {
  return String(s == null ? '' : s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s"']+/gi, '<home>')
    .replace(/jb_[a-f0-9]{20,}/gi, '<license>')
    .slice(0, max);
}

function report({ source = 'main', name = 'Error', message = '', stack = '' } = {}) {
  try {
    if (!diagnosticsEnabled() || sessionCount >= SESSION_CAP) return;
    const fp = `${source}|${name}|${String(message).replace(/\d+/g, '#').slice(0, 120)}`;
    const now = Date.now();
    if (sentAt.has(fp) && now - sentAt.get(fp) < DEDUP_MS) return;
    sentAt.set(fp, now);
    sessionCount += 1;

    const body = JSON.stringify({
      install_id: installId(),
      source,
      name: String(name).slice(0, 120),
      message: scrub(message, 500),
      stack: scrub(stack, 4000),
      platform: process.platform,
      version: app.getVersion(),
    });
    fetch(`${JOBBOT_BACKEND_URL}/v1/telemetry/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    }).catch(() => {}); // best-effort; never throw from the reporter
  } catch (_) { /* reporting must never break the app */ }
}

module.exports = { report, diagnosticsEnabled, setDiagnosticsEnabled, installId };
