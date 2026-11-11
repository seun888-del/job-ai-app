// Everything the user gives Job-AI lives here, on this device only (chrome.storage.local).
// Nothing is sent anywhere except the AI requests needed to write answers, and the title,
// company and link of each application sent (for the user's receipt email), which go to the
// licensed Job-AI backend exactly like the desktop app.
import llm from '../shims/llm.js';
import { TAILOR_VERSION } from '../../../bot/modules/tailor_version.js';
import cfg from '../shims/config.js';

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
// The UK/USA/Canada switch: each job remembers the region it was found in, and only jobs of
// the region the user is in now are tailored or sent.
const regionNow = async () => ((await get('settings')) || {}).region || 'uk';
export async function addJob(job) {
  const region = job.region || await regionNow();
  return withJobs((all) => {
    if (all.some((j) => j.jobId === job.jobId)) return { value: false };
    all.push({ status: 'pending', retryCount: 0, addedAt: new Date().toISOString(), ...job, region, updatedAt: new Date().toISOString() });
    return { save: true, value: true };
  });
}
export async function updateJob(jobId, fields) {
  let applied = null;
  const r = await withJobs((all) => {
    const j = all.find((x) => x.jobId === jobId);
    if (!j) return { value: null };
    // Not for federal jobs: the user applied on USAJOBS themselves, so no "Job-AI applied" receipt.
    if (fields.status === 'applied' && j.status !== 'applied' && j.source !== 'usajobs') applied = { title: j.title, company: j.company, url: j.url, cv_score: j.cvScore, tailor: TAILOR_VERSION, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(cfg.movePay(j) || {}) };
    Object.assign(j, fields, { updatedAt: new Date().toISOString() });
    return { save: true, value: j };
  });
  // Newly applied: the backend emails the user a receipt (same as the app). Fire and forget.
  if (applied && applied.title) {
    fetch(`${llm.BACKEND}/v1/jobs/applied`, { method: 'POST', headers: { ...llm.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(applied), signal: AbortSignal.timeout(15000) }).catch(() => {});
  }
  return r;
}
export async function byStatus(status, source) { const r = await regionNow(); return (await jobs()).filter((j) => j.status === status && (!source || j.source === source) && (!j.region || j.region === r)); }
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

// "Only move for more money": applications in the last 30 days against the monthly limit.
// capUsed() is what the agents check against the daily cap: today's count, raised so the
// cap is reached early when the month's allowance runs out.
export async function monthLeft() {
  if (!cfg.MOVE || !cfg.MOVE.on) return Infinity;
  const since = Date.now() - 30 * 864e5;
  const n = (await jobs()).filter((j) => (j.status === 'applied' && Date.parse(j.appliedAt || 0) >= since) || Date.parse(j.countedAt || 0) >= since).length;
  return cfg.MOVE.monthly - n;
}
export async function capUsed() {
  const today = await appliedToday();
  const left = await monthLeft();
  return left === Infinity ? today : Math.max(today, cfg.MAX_APPLICATIONS_PER_DAY - Math.max(0, left));
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
