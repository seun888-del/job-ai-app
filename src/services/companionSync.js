// companionSync.js
// Pushes a small snapshot of the user's activity to the backend (POST /v1/sync)
// on a timer, so the phone companion PWA (tryjobai.com/app) can show their job
// hunt without access to this machine's local queue.db. Best-effort and silent:
// the companion is a convenience, so a sync failure must never disturb the app.
//
// Auth mirrors the rest of the app: the stored licence key as a Bearer token,
// plus the machine id (same header the licence checks use). Nothing syncs until
// the user has a licence key (i.e. has activated), and only counts/titles the
// user already sees locally are sent — no new data leaves the machine.

const { JOBBOT_BACKEND_URL } = require('../config');
const db = require('../db/database');
const queueReader = require('../db/queueReader');
const botManager = require('./botManager');
const { machineId } = require('./machineId');

const SYNC_INTERVAL_MS = 3 * 60 * 1000; // every 3 minutes while the app is open

// Job-site agents shown on the phone (the internal 'scorer' is not a site;
// Indeed and CV-Library are intentionally omitted).
const AGENT_NAMES = {
  reed: 'Reed', linkedin: 'LinkedIn', glassdoor: 'Glassdoor',
  totaljobs: 'Totaljobs', cwjobs: 'CWJobs', uc: 'Universal Credit',
};

function fmtDMY(v) { const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function fmtShort(v) { const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

// Collapse a queue status into the three the phone renders.
function normStatus(s) {
  s = String(s || '').toLowerCase();
  if (s.indexOf('fail') > -1) return 'failed';
  if (s.indexOf('appl') > -1) return 'applied';
  return 'skipped';
}

function buildSnapshot() {
  const summary = queueReader.getQueueSummary() || [];
  const m = {};
  for (const r of summary) m[r.status] = r.count;

  const recent = (queueReader.getRecentApplications(25) || []).map(j => ({
    title: j.title || '', company: j.company || '', status: normStatus(j.status), date: fmtShort(j.updated_at),
  }));
  const uc_list = (queueReader.getUcPendingList(200) || []).map(j => ({
    title: j.title || '', company: j.company || '', applied: fmtDMY(j.appliedAt),
  }));

  let agents = [];
  try {
    const st = botManager.getStatus() || {};
    agents = Object.keys(AGENT_NAMES)
      .filter(k => st[k] != null)
      .map(k => ({ name: AGENT_NAMES[k], state: String(st[k] || 'idle').toLowerCase().replace(/\s+/g, '_') }));
  } catch (_) { /* agents are optional */ }

  return {
    applied_today: queueReader.getTodayAppliedCount() || 0,
    pending: (m['pending'] || 0) + (m['cv_ready'] || 0),
    cvs_tailored: m['tailored'] || 0,
    failed: (m['apply_failed'] || 0) + (m['failed'] || 0),
    recent,
    uc_pending: queueReader.getUcPendingCount() || 0,
    uc_list,
    agents,
  };
}

async function syncNow() {
  try {
    const lic = db.getLicense && db.getLicense();
    const key = lic && lic.license_key;
    if (!key) return; // not activated yet — nothing to push

    let mid = '';
    try { mid = machineId() || ''; } catch (_) {}
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    if (mid) headers['x-machine-id'] = mid;

    await fetch(`${JOBBOT_BACKEND_URL}/v1/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildSnapshot()),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) { /* best-effort; never break the app over a companion sync */ }
}

let timer = null;
function start() {
  if (timer) return;
  setTimeout(syncNow, 15 * 1000);            // once shortly after startup
  timer = setInterval(syncNow, SYNC_INTERVAL_MS);
}

module.exports = { start, syncNow, buildSnapshot };
