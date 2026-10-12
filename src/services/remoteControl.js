// remoteControl.js
// Phone control: this computer checks in with the backend (POST /v1/remote/heartbeat),
// sending a small status (agent states, today's count, recent job titles) and picking up
// commands the user tapped on their phone at tryjobai.com/app: start all, stop all, or
// start/stop one agent. Commands go through the same licence gate as the Start button.
//
// Each check-in waits on the server for up to 20 seconds, so a tap on the phone reaches
// this computer within a second or two. A local change (agent started or stopped) ends the
// wait early and sends the new status. Best-effort and silent: failures never disturb the app.

const { JOBBOT_BACKEND_URL } = require('../config');
const db = require('../db/database');
const queueReader = require('../db/queueReader');
const botManager = require('./botManager');
const { machineId } = require('./machineId');

const WAIT_S = 20, RETRY_MS = 15000;
const LABELS = { trac: 'NHS (Trac)', reed: 'Reed', linkedin: 'LinkedIn', greenhouse: 'Company sites' };
// What the dashboard shows (and which boxes are ticked); the renderer keeps this current.
let prefs = { keys: ['trac', 'reed', 'linkedin', 'greenhouse'], enabled: null };
let deps = null, running = false, waitCtl = null, nudgeTimer = null;

function setPrefs(p) {
  if (!p || !Array.isArray(p.keys)) return;
  prefs = { keys: p.keys.filter((k) => LABELS[k]), enabled: Array.isArray(p.enabled) ? p.enabled.filter((k) => LABELS[k]) : null };
}
const isEnabled = (k) => !prefs.enabled || prefs.enabled.includes(k);
const isOn = (st) => st === 'running';

async function buildStatus() {
  const st = botManager.getStatus() || {};
  const lic = db.getLicense();
  const licensed = deps.licenseLocallyValid(lic);
  const limit = await deps.dailyLimit().catch(() => null);
  let hasCv = true; try { hasCv = db.getCVs().length > 0; } catch (_) {}
  let hasTrac = true; try { const t = JSON.parse(db.getProfile().trac_details || '{}'); hasTrac = !!((t.employment || []).length || (t.references || []).length); } catch (_) { hasTrac = false; }
  const summary = (await queueReader.getQueueSummary()) || [];
  const m = {}; for (const r of summary) m[r.status] = r.count;
  const recent = ((await queueReader.getRecentApplications(12)) || []).map((j) => ({
    title: j.title || '', company: j.company || '', source: LABELS[j.source] || '',
    status: j.status === 'applied' ? 'applied' : j.status === 'apply_failed' ? 'failed' : 'waiting',
    at: j.updated_at ? new Date(String(j.updated_at).replace(' ', 'T') + (/[zZ+]/.test(String(j.updated_at)) ? '' : 'Z')).toISOString() : '',
  }));
  const blocked = !licensed ? (lic && lic.license_key ? 'Your Job-AI access has ended. Subscribe to keep applying.' : 'Activate Job-AI on your computer first.')
    : !hasCv ? 'Add your CV on your computer first.'
    : limit && limit.reached ? `Today's limit of ${limit.cap} applications is reached. Agents carry on tomorrow.` : '';
  return {
    agents: prefs.keys.map((k) => ({ key: k, label: LABELS[k], state: st[k] === 'error' ? 'error' : isOn(st[k]) ? 'running' : 'stopped', enabled: isEnabled(k), canRun: licensed && hasCv && (k !== 'trac' || hasTrac) })),
    applied_today: limit ? limit.applied : 0, daily_cap: limit ? limit.cap : 0,
    in_queue: (m.pending || 0) + (m.cv_ready || 0), failed: m.apply_failed || 0,
    needs_you: (m.ready_to_submit || 0) + (m.attention_skips || 0),
    recent, blocked,
  };
}

async function run(cmd) {
  const keys = cmd.cmd === 'start' || cmd.cmd === 'stop' ? [cmd.agent].filter((k) => prefs.keys.includes(k)) : prefs.keys;
  if (!keys.length) return { ok: false, message: 'That agent is not on this computer.' };
  if (cmd.cmd === 'stop' || cmd.cmd === 'stop_all') {
    for (const k of keys) { try { botManager.stop(k); } catch (_) {} }
    return { ok: true };
  }
  let hasCv = true; try { hasCv = db.getCVs().length > 0; } catch (_) {}
  if (!hasCv) return { ok: false, message: 'Add your CV in Job-AI on your computer first.' };
  const limit = await deps.dailyLimit().catch(() => null);
  if (limit && limit.reached) return { ok: false, message: `Today's limit of ${limit.cap} applications is already reached.` };
  const st = botManager.getStatus() || {};
  const todo = keys.filter((k) => !isOn(st[k]) && (cmd.cmd === 'start' || isEnabled(k)));
  if (!todo.length) return { ok: true };
  const errors = [];
  for (const k of todo) {
    try { await deps.startBotGated(k); } catch (e) { errors.push(`${LABELS[k]}: ${e.message}`); if (e.code === 'license_required') break; }
  }
  deps.onStarted && deps.onStarted();
  return errors.length ? { ok: errors.length < todo.length, message: errors.join(' ').slice(0, 190) } : { ok: true };
}

async function post(path, key, body, signal) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Client': 'app' };
  try { headers['X-Machine-Id'] = machineId(); } catch (_) {}
  const r = await fetch(`${JOBBOT_BACKEND_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(15000) });
  return r.ok ? r.json() : null;
}

const label = () => (process.platform === 'darwin' ? 'Mac (Job-AI app)' : 'Windows PC (Job-AI app)');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function loop() {
  while (running) {
    const lic = db.getLicense();
    if (!lic || !lic.license_key) { await sleep(RETRY_MS); continue; }
    waitCtl = new AbortController();
    const t = setTimeout(() => waitCtl.abort(), (WAIT_S + 15) * 1000);
    let r = null;
    try { r = await post('/v1/remote/heartbeat', lic.license_key, { client: 'app', label: label(), status: await buildStatus(), wait: WAIT_S }, waitCtl.signal); }
    catch (_) { r = waitCtl.signal.aborted ? {} : null; } // aborted = nudged: go round again now
    finally { clearTimeout(t); }
    if (!r) { await sleep(RETRY_MS); continue; }
    for (const c of r.commands || []) {
      let out; try { out = await run(c); } catch (e) { out = { ok: false, message: e.message }; }
      await post('/v1/remote/ack', lic.license_key, { id: c.id, ok: out.ok, message: out.message || '' }).catch(() => {});
    }
    if ((r.commands || []).length) await sleep(1500); // let the agents report their new state
  }
}

// Something changed (agent started/stopped, licence activated): send the new status now.
function nudge() {
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { if (waitCtl) waitCtl.abort(); }, 800);
}

function start(d) {
  deps = d;
  if (running) return;
  running = true;
  setTimeout(loop, 5000);
}

module.exports = { start, nudge, setPrefs, _test: { buildStatus, run } };
