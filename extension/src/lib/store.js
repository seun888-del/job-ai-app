// Everything the user gives Job-AI lives here, on this device only (chrome.storage.local).
// Nothing is sent anywhere except the AI requests needed to write answers, and the title,
// company and link of each application sent (for the user's receipt email), which go to the
// licensed Job-AI backend exactly like the desktop app.
import llm from '../shims/llm.js';
import { TAILOR_VERSION } from '../../../bot/modules/tailor_version.js';

const DEFAULTS = {
  license: { key: '' },
  profile: {},            // name, email, phone, location, salary, work types (the app's "Profile")
  trac: {},               // NHS / Trac details (same fields as the app's NHS / Trac page)
  cv: null,               // { name, text, type, dataB64 }
  settings: { agents: { trac: true }, autoSubmit: { trac: false }, dailyCap: 25 },
  jobs: [],               // the queue: one entry per job found
  log: [],
};

export async function get(key) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? structuredClone(DEFAULTS[key]) : r[key];
}
export async function set(key, value) { await chrome.storage.local.set({ [key]: value }); }
export async function patch(key, fields) { const cur = (await get(key)) || {}; const next = { ...cur, ...fields }; await set(key, next); return next; }

// ── Job queue ───────────────────────────────────────────────────────────────
export async function jobs() { return get('jobs'); }
export async function hasJob(jobId) { return (await jobs()).some((j) => j.jobId === jobId); }
// Several agents run at once and each change rewrites the whole list, so changes are queued
// one at a time. Without this, two near-simultaneous saves lost one (e.g. an "Applied" status).
let jobsLock = Promise.resolve();
function withJobs(fn) {
  const run = jobsLock.then(async () => { const all = await jobs(); const r = fn(all); if (r && r.save) await set('jobs', all); return r && r.value; });
  jobsLock = run.catch(() => {});
  return run;
}
export function addJob(job) {
  return withJobs((all) => {
    if (all.some((j) => j.jobId === job.jobId)) return { value: false };
    all.push({ status: 'pending', retryCount: 0, addedAt: new Date().toISOString(), ...job, updatedAt: new Date().toISOString() });
    return { save: true, value: true };
  });
}
export async function updateJob(jobId, fields) {
  let applied = null;
  const r = await withJobs((all) => {
    const j = all.find((x) => x.jobId === jobId);
    if (!j) return { value: null };
    if (fields.status === 'applied' && j.status !== 'applied') applied = { title: j.title, company: j.company, url: j.url, cv_score: j.cvScore, tailor: TAILOR_VERSION };
    Object.assign(j, fields, { updatedAt: new Date().toISOString() });
    return { save: true, value: j };
  });
  // Newly applied: the backend emails the user a receipt (same as the app). Fire and forget.
  if (applied && applied.title) {
    fetch(`${llm.BACKEND}/v1/jobs/applied`, { method: 'POST', headers: { ...llm.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(applied), signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  return r;
}
export async function byStatus(status, source) { return (await jobs()).filter((j) => j.status === status && (!source || j.source === source)); }
// Tailored jobs waiting to be sent (fresh only, see the app's countReadyBacklog).
export async function readyBacklog() {
  const since = Date.now() - 2 * 864e5;
  return (await jobs()).filter((j) => ['cv_ready', 'applying', 'awaiting_review'].includes(j.status) && Date.parse(j.updatedAt || 0) >= since).length;
}

// Today's usage against the daily cap: applications sent plus finished Trac drafts the
// user submits themselves (countedAt). Each job counts once.
export async function appliedToday() {
  const d = new Date().toISOString().slice(0, 10);
  return (await jobs()).filter((j) => (j.status === 'applied' && String(j.appliedAt || '').startsWith(d)) || String(j.countedAt || '').startsWith(d)).length;
}

// ── Activity log (shown on the dashboard) ─────────────────────────────────────
const listeners = new Set();
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let pending = [];
let flushTimer = null;
export function log(line) {
  const entry = `[${new Date().toLocaleTimeString('en-GB')}] ${String(line).replace(/^\s+/, '')}`;
  for (const fn of listeners) { try { fn(entry); } catch (_) {} }
  pending.push(entry);
  if (!flushTimer) flushTimer = setTimeout(async () => {
    flushTimer = null;
    const cur = await get('log');
    const next = cur.concat(pending).slice(-400);
    pending = [];
    await set('log', next);
  }, 1500);
}
