// Everything the user gives Job-AI lives here, on this device only (chrome.storage.local).
// Nothing is sent anywhere except the AI requests needed to write answers, which go to the
// licensed Job-AI backend exactly like the desktop app.

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
export async function addJob(job) {
  const all = await jobs();
  if (all.some((j) => j.jobId === job.jobId)) return false;
  all.push({ status: 'pending', retryCount: 0, addedAt: new Date().toISOString(), ...job, updatedAt: new Date().toISOString() });
  await set('jobs', all);
  return true;
}
export async function updateJob(jobId, fields) {
  const all = await jobs();
  const j = all.find((x) => x.jobId === jobId);
  if (!j) return null;
  Object.assign(j, fields, { updatedAt: new Date().toISOString() });
  await set('jobs', all);
  return j;
}
export async function byStatus(status, source) { return (await jobs()).filter((j) => j.status === status && (!source || j.source === source)); }
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
