// remoteControl.js
// Phone control: this computer checks in with the backend (POST /v1/remote/heartbeat),
// sending a small status (agent states, today's count, recent job titles) and picking up
// commands the user tapped on their phone at tryjobai.com/app: start all, stop all, or
// start/stop one agent. Commands go through the same licence gate as the Start button.
//
// Each check-in waits on the server for up to 20 seconds, so a tap on the phone reaches
// this computer within a second or two. A local change (agent started or stopped) ends the
// wait early and sends the new status. Best-effort and silent: failures never disturb the app.
//
// Phase 3: it also shares what needs the user (NHS forms ready or to finish, accounts to sign in
// to again), the applications list with its stages, and the search settings, sent only when
// they change. The phone can then submit a ready NHS form, set a stage, or change settings.

const { JOBBOT_BACKEND_URL } = require('../config');
const db = require('../db/database');
const queueReader = require('../db/queueReader');
const botManager = require('./botManager');
const { machineId } = require('./machineId');

const WAIT_S = 20, RETRY_MS = 15000, EXTRA_MIN_MS = 15000, EXTRA_RESEND_MS = 15 * 60 * 1000;
const LABELS = { trac: 'NHS (Trac)', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', greenhouse: 'Company sites' };
// What the dashboard shows (and which boxes are ticked); the renderer keeps this current.
let prefs = { keys: ['trac', 'reed', 'linkedin', 'greenhouse'], enabled: null };
let deps = null, running = false, waitCtl = null, nudgeTimer = null, extraSent = '', extraSentAt = 0, extraBuiltAt = 0;
const TRAC_APPS_URL = 'https://apps.trac.jobs/applicationlist';
const SITE = { reed: 'Reed', linkedin: 'LinkedIn', trac: 'NHS', greenhouse: 'Company site', ats: 'Company site', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound' };
const STAGES = ['applied', 'phone_screen', 'interview', 'offer', 'rejected', 'withdrawn'];
const cleanTitle = (t) => (String(t || '').split('\n').map((x) => x.trim()).find(Boolean) || '').replace(/\s+with verification$/i, '');
const toIso = (v) => { if (!v) return ''; const d = new Date(String(v).replace(' ', 'T') + (/[zZ+]/.test(String(v)) || String(v).length <= 10 ? '' : 'Z')); return isNaN(d) ? '' : d.toISOString(); };

function setPrefs(p) {
  if (!p || !Array.isArray(p.keys)) return;
  prefs = { keys: p.keys.filter((k) => LABELS[k]), enabled: Array.isArray(p.enabled) ? p.enabled.filter((k) => LABELS[k]) : null };
}
const isEnabled = (k) => !prefs.enabled || prefs.enabled.includes(k);
const isOn = (st) => st === 'running';

async function buildStatus() {
  const st = botManager.getStatus() || {};
  if (deps.computer) deps.computer.update(st); // keep-awake follows the agents even if a status event was missed
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
    awake: !!(deps.computer && deps.computer.isAwakeHeld()),
    agents: prefs.keys.map((k) => ({ key: k, label: LABELS[k], state: st[k] === 'error' ? 'error' : isOn(st[k]) ? 'running' : 'stopped', enabled: isEnabled(k), canRun: licensed && hasCv && (k !== 'trac' || hasTrac) })),
    applied_today: limit ? limit.applied : 0, daily_cap: limit ? limit.cap : 0,
    in_queue: (m.pending || 0) + (m.cv_ready || 0), failed: m.apply_failed || 0,
    needs_you: (m.ready_to_submit || 0) + (m.attention_skips || 0),
    recent, blocked,
  };
}

function tracDetails() { try { return JSON.parse(db.getProfile().trac_details || '{}') || {}; } catch (_) { return {}; } }

async function buildExtra() {
  const approved = (await queueReader.getTracApproved()) || [];
  const inbox = ((await queueReader.getTracApplications()) || []).map((a) => {
    const ready = a.status === 'ready_to_submit', ai = /asks about AI use/.test(a.reason || '');
    const missing = String(a.reason || '').replace(/^Draft saved on Trac\.?\s*Needs you:\s*/i, '').replace(/ This form asks about AI use.*$/, '').replace(/\.$/, '');
    return {
      id: a.job_id, kind: ready ? 'nhs_ready' : 'nhs_needs', title: String(a.title || '').split(' Band ')[0], company: a.company || 'NHS',
      note: ready ? (ai ? 'This form asks about AI use, so submit it yourself on Trac.' : 'Every section is complete. Read it, then submit.') : `Still needed: ${missing || 'check the draft'}. Fix it on Trac and Job-AI finishes the rest.`,
      url: /^https:\/\/apps\.trac\.jobs\//.test(a.draft_url || '') ? a.draft_url : TRAC_APPS_URL,
      statement: ready ? (a.cover_letter || '') : '', ai_blocked: ready && ai, submitting: ready && approved.includes(a.job_id), at: toIso(a.updated_at),
    };
  });
  for (const r of (await queueReader.getReconnectNeeded()) || []) {
    const site = SITE[r.source] || r.source || 'a job site';
    inbox.push({ id: 'reconnect_' + (r.source || 'site'), kind: 'reconnect', title: `Sign in to ${site} again`, company: '', note: `On your computer, open Job-AI and press Sign in on the ${site} card. Your agents carry on after.`, at: toIso(r.updated_at) });
  }
  // The applications list: the same rows as the Interview Tracker page.
  try { for (const j of (await queueReader.getAppliedJobsForSync()) || []) db.syncTrackerEntry(j); } catch (_) {}
  let tracker = [];
  try {
    tracker = db.getTracker().slice(0, 150).map((t) => ({ id: t.job_id, title: cleanTitle(t.title), company: t.company || '', source: SITE[t.source] || t.source || '', at: toIso(t.applied_at), stage: STAGES.includes(t.stage) ? t.stage : 'applied', url: t.url || '' }));
  } catch (_) {}
  let settings = null;
  try {
    const sp = db.getSearchPreferences();
    settings = { terms: db.getSearchTerms(true).map((x) => x.term), work_types: sp.work_type_priority || [], location: sp.location || '', nhs_submit: tracDetails().autoSubmit === true, has_nhs: prefs.keys.includes('trac') };
    if (deps.computer) { const c = deps.computer.get(); settings.computer = { keep_awake: c.keepAwake, open_at_login: c.openAtLogin, startup: 'computer' }; }
  } catch (_) {}
  return { inbox, tracker, stages: true, settings };
}

// Send the inbox, applications and settings when they change (and every 15 minutes anyway).
async function syncExtra(key, force) {
  if (!force && Date.now() - extraBuiltAt < EXTRA_MIN_MS) return;
  extraBuiltAt = Date.now();
  const extra = await buildExtra();
  const json = JSON.stringify(extra);
  if (!force && json === extraSent && Date.now() - extraSentAt < EXTRA_RESEND_MS) return;
  const r = await post('/v1/remote/sync', key, { client: 'app', extra }).catch(() => null);
  if (r && r.ok) { extraSent = json; extraSentAt = Date.now(); }
}

function applySettings(p) {
  const want = (p.terms || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 40);
  if (!want.length) return { ok: false, message: 'Add at least one job title.' };
  const lower = new Set(want.map((t) => t.toLowerCase()));
  for (const t of db.getSearchTerms(true)) if (!lower.has(String(t.term).toLowerCase())) db.setSearchTermActive(t.id, false);
  db.addSearchTerms(want, 'user_added');
  const wt = (p.work_types || []).filter((w) => ['remote', 'hybrid', 'onsite'].includes(w));
  const fields = {};
  if (wt.length) fields.work_type_priority = wt;
  if (p.location) fields.location = String(p.location).slice(0, 80);
  if (Object.keys(fields).length) db.saveSearchPreferences(fields);
  if (prefs.keys.includes('trac') && typeof p.nhs_submit === 'boolean') {
    const t = tracDetails();
    if ((t.autoSubmit === true) !== p.nhs_submit) { t.autoSubmit = p.nhs_submit; db.saveProfile({ trac_details: JSON.stringify(t) }); }
  }
  deps.onSettingsChanged && deps.onSettingsChanged();
  return { ok: true };
}

async function run(cmd) {
  if (cmd.cmd === 'set_settings') return applySettings(cmd.payload || {});
  if (cmd.cmd === 'set_computer') {
    if (!deps.computer) return { ok: false, message: 'Update Job-AI on this computer first.' };
    const p = cmd.payload || {};
    deps.computer.set({ keepAwake: p.keep_awake, openAtLogin: p.open_at_login });
    deps.onSettingsChanged && deps.onSettingsChanged();
    return { ok: true };
  }
  if (cmd.cmd === 'set_stage') {
    const p = cmd.payload || {};
    if (!STAGES.includes(p.stage)) return { ok: false, message: 'Unknown stage.' };
    const row = db.getTracker().find((t) => t.job_id === p.job_id);
    if (!row) return { ok: false, message: 'That application is not on this computer.' };
    db.updateTrackerEntry(row.id, { stage: p.stage });
    deps.onSettingsChanged && deps.onSettingsChanged();
    return { ok: true };
  }
  if (cmd.cmd === 'submit_nhs') {
    const id = String((cmd.payload || {}).job_id || '');
    if (!(await queueReader.approveTracSubmit(id))) return { ok: false, message: 'That application is no longer ready to submit.' };
    const st = botManager.getStatus() || {};
    if (!isOn(st.trac)) {
      try { await deps.startBotGated('trac'); deps.onStarted && deps.onStarted(); }
      catch (e) { return { ok: false, message: `Approved, but the NHS agent could not start: ${e.message}`.slice(0, 190) }; }
    }
    return { ok: true };
  }
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
    await syncExtra(lic.license_key, (r.commands || []).length > 0).catch(() => {});
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

module.exports = { start, nudge, setPrefs, _test: { buildStatus, buildExtra, run } };
