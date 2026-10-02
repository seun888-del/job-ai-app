// Job-AI dashboard (the extension's main tab). Runs the agents while it's open.
// Same layout, components and stylesheet as the desktop app: Dashboard / Tracker / Activity tabs,
// the Setup menu, the welcome + setup tour and the "Ask Job-AI" assistant.
import cfg from './shims/config.js';
import * as store from './lib/store.js';
import { extractText, toBase64 } from './lib/cvtext.js';
import { TracAgent } from './agents/trac.js';
import { ReedAgent } from './agents/reed.js';
import { LinkedInAgent } from './agents/linkedin.js';
import { AtsAgent, feedJobs, fetchJD } from './agents/ats.js';
import { Page } from './driver/page.js';

const { checkLicense, askAssistant } = require('./shims/llm.js');
const { importTracText } = require('../../src/services/tracImporter');
const { readCvProfile } = require('../../src/services/cvProfile');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const content = $('#content');
const vfs = require('./shims/fs');
const vfsReady = vfs.__load().catch(() => {}); // saved tailored CVs, back into memory
const lines = (sel) => String(($(sel) || {}).value || '').split('\n').map((x) => x.trim()).filter(Boolean);
// Only ever open normal web pages from stored data (never javascript:, data:, file: ...).
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (_) { return null; } };
const openTab = (u) => { const s = safeUrl(u); if (s) chrome.tabs.create({ url: s }); };

// This install's device id (random, stays on this device). Sent with licence checks like the app.
async function deviceId() {
  let d = await store.get('device');
  if (!d || !d.id) { d = { id: 'ext-' + crypto.randomUUID() }; await store.set('device', d); }
  return d.id;
}

// Load everything the agents need from local storage.
async function loadConfig() {
  const [license, profile, trac, settings] = await Promise.all([store.get('license'), store.get('profile'), store.get('trac'), store.get('settings')]);
  globalThis.__jobaiLicense = license.key || '';
  globalThis.__jobaiDevice = await deviceId();
  cfg.load({ profile, trac, settings, license });
  return { license, profile, trac, settings };
}

// ── Licence gate (same rule as the app: agents only run on an active trial or subscription) ──
const licenceActive = (l) => !!(l && l.key && ['trial', 'active'].includes(l.status) && (!l.expiresAt || new Date(l.expiresAt) > new Date()));
async function recheckLicence() {
  const l = await store.get('license');
  if (!l.key) return false;
  try {
    const r = await checkLicense(l.key);
    if (r.ok) await store.patch('license', { status: r.licenseStatus || 'active', expiresAt: r.expires_at, checkedAt: Date.now() });
    else if (r.http === 401 || r.http === 403) await store.patch('license', { status: r.error === 'device_trial_used' ? 'device_trial_used' : 'expired', checkedAt: Date.now() });
  } catch (_) { /* offline: fall back to the last known status and expiry */ }
  return licenceActive(await store.get('license'));
}

// ── Agents ───────────────────────────────────────────────────────────────────
const onChange = () => { if (current === 'dashboard') renderDashboard(); };
const agents = {
  trac: new TracAgent({ onChange }),
  reed: new ReedAgent({ onChange }),
  linkedin: new LinkedInAgent({ onChange }),
  ats: new AtsAgent({ onChange }),
};
const agent = agents.trac;
const AGENTS = [
  ['trac', 'Trac (NHS) Agent', 'https://apps.trac.jobs/', 'Sign in to Trac'],
  ['reed', 'Reed Agent', 'https://www.reed.co.uk/account/signin', 'Sign in to Reed'],
  ['linkedin', 'LinkedIn Agent', 'https://www.linkedin.com/login', 'Sign in to LinkedIn'],
  ['ats', 'Company Sites Agent', '', ''],
];
const anyRunning = () => Object.values(agents).some((a) => a.running);
async function startAgent(key) {
  if (!(await recheckLicence())) { navigate('license'); return; }
  agents[key].start();
  setTimeout(renderDashboard, 300);
}
// Stop everything if the licence ends while agents are running (checked every 30 minutes).
setInterval(async () => { if (anyRunning() && !(await recheckLicence())) { Object.values(agents).forEach((a) => a.stop()); store.log('Licence is no longer active. Agents stopped.'); } }, 30 * 60 * 1000);

// Keep this tab around while agents run.
chrome.tabs.getCurrent().then((t) => { if (t) chrome.tabs.update(t.id, { pinned: true }).catch(() => {}); });
window.addEventListener('beforeunload', (e) => { if (anyRunning()) { e.preventDefault(); e.returnValue = ''; } });

// ── Navigation (top tabs + Setup menu, like the app) ─────────────────────────
let current = 'dashboard';
const VIEWS = {};
function navigate(v) {
  if (!VIEWS[v]) v = 'dashboard';
  current = v;
  content.dataset.ok = '1';
  $$('#nav .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('#nav-setup .setup-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#setup-label').classList.toggle('active', $$('#nav-setup .setup-item').some((b) => b.dataset.view === v));
  window.scrollTo(0, 0);
  return VIEWS[v]();
}
$$('#nav .tab, #nav-setup .setup-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
$('#setup-label').addEventListener('click', (e) => { e.stopPropagation(); $('#setup-menu').classList.toggle('open'); });
$('#setup-pop').addEventListener('click', () => $('#setup-menu').classList.remove('open'));
document.addEventListener('click', () => $('#setup-menu').classList.remove('open'));
$('#tn-help').addEventListener('click', () => startTour());
const setSt = (id, msg, err) => { const el = $(id); if (!el) return; el.textContent = msg; el.style.color = err ? 'var(--danger)' : 'var(--text-muted)'; };

// Pick a CV, save it, and let the AI fill any blank profile fields (never overwriting what the
// user typed) plus the search terms if there are none yet. done(msg) runs once it's saved.
const CV_FIELDS = [['firstName', 'First name'], ['middleName', null], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'], ['linkedin', 'LinkedIn'], ['yearsExperience', 'Years of experience']];
async function fillFromCv(text) {
  const r = await readCvProfile(text);
  const { profile: P } = await loadConfig();
  const out = {}, filled = [];
  for (const [k, label] of CV_FIELDS) if (r[k] && !String(P[k] || '').trim()) { out[k] = r[k]; if (label) filled.push(label); }
  let termsAdded = 0;
  if (r.roles.length && !(P.searchTerms || []).length) { out.searchTerms = r.roles; termsAdded = r.roles.length; }
  if (Object.keys(out).length) { await store.patch('profile', out); await loadConfig(); }
  return { filled, termsAdded };
}
function pickCv(stSel, done) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf,.doc,.docx' });
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setSt(stSel, 'That file is over 10 MB. Please use a smaller CV.', true); return; }
    setSt(stSel, 'Reading your CV. This can take a minute…');
    try {
      const buf = await f.arrayBuffer();
      const text = await extractText(f);
      if (text.replace(/\s/g, '').length < 200) throw new Error('No readable text found. Is it a scanned image?');
      await store.set('cv', { name: f.name, type: f.type, text, dataB64: toBase64(buf) });
      let msg = 'Using: ' + f.name;
      try {
        const r = await fillFromCv(text);
        const parts = [];
        if (r.filled.length) parts.push(`Filled in from your CV: ${r.filled.join(', ')}.`);
        if (r.termsAdded) parts.push(`Added ${r.termsAdded} job titles to search for.`);
        if (parts.length) msg = parts.join(' ') + ' Check your details, then Save.';
      } catch (err) { msg += '. ' + err.message; }
      done(msg);
    } catch (err) { setSt(stSel, err.message, true); }
  });
  input.click();
}
// After a CV upload from the dashboard or Personal Details, land on Personal Details to check.
const cvToPersonal = (msg) => navigate('personal').then(() => {
  const note = Object.assign(document.createElement('div'), { className: 'card', textContent: '✓ ' + msg });
  $('.page-header').after(note);
});

// ── Dashboard ────────────────────────────────────────────────────────────────
function gsMark(ok, n) { return ok ? '<span class="gs-step gs-step-done">✓</span>' : `<span class="gs-step gs-step-num">${n}</span>`; }
function buildApplicationsGraph(all) {
  const applied = all.filter((j) => j.status === 'applied' && j.appliedAt);
  if (!applied.length) return '<div class="graph-empty">No applications recorded yet</div>';
  const W = 560, H = 80, PAD = 4, LABEL_TOP = 12, AXIS_BOTTOM = 16;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000); const key = d.toISOString().slice(0, 10);
    days.push({ key, count: applied.filter((j) => String(j.appliedAt).startsWith(key)).length, label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
  }
  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const barW = Math.floor((W - PAD * 2) / 14);
  const bars = days.map((d, i) => {
    const barH = Math.max(2, Math.round((d.count / maxCount) * (H - LABEL_TOP - AXIS_BOTTOM)));
    const x = PAD + i * barW; const y = H - AXIS_BOTTOM - barH;
    return `<rect x="${x}" y="${y}" width="${barW - 2}" height="${barH}" class="graph-bar${i === 13 ? ' graph-bar-today' : ''}" rx="2"><title>${d.label}: ${d.count} application${d.count !== 1 ? 's' : ''}</title></rect>${d.count > 0 ? `<text x="${x + (barW - 2) / 2}" y="${y - 2}" class="graph-label" text-anchor="middle">${d.count}</text>` : ''}`;
  });
  const labels = [0, 6, 13].map((i) => `<text x="${PAD + i * barW + (barW - 2) / 2}" y="${H}" class="graph-date" text-anchor="middle">${days[i].label}</text>`);
  return `<svg viewBox="0 0 ${W} ${H + 4}" class="applications-graph" xmlns="http://www.w3.org/2000/svg">${bars.join('')}${labels.join('')}</svg>`;
}

let dashBusy = false;
VIEWS.dashboard = async function renderDashboardView() {
  if (dashBusy) return; dashBusy = true;
  try {
    const { license, profile, trac, settings } = await loadConfig();
    const cv = await store.get('cv');
    const all = await store.jobs();
    const tracJobs = all.filter((j) => j.source === 'trac');
    const ready = tracJobs.filter((j) => j.status === 'ready_to_submit');
    const needs = tracJobs.filter((j) => j.status === 'skipped' && /^Draft saved on Trac/.test(j.reason || ''));
    const waiting = all.filter((j) => j.status === 'ready');
    const applied = all.filter((j) => j.status === 'applied');
    const failed = all.filter((j) => j.status === 'apply_failed');
    const inQueue = all.filter((j) => ['pending', 'cv_ready', 'applying'].includes(j.status));
    const hasLicence = licenceActive(license);
    const setupDone = {
      personal: !!(profile.firstName && profile.lastName && profile.email && profile.phone),
      cvs: !!(cv && cv.text),
      search: !!((profile.searchTerms || []).length),
      trac: !!((trac.employment || []).length && (trac.references || []).length && (trac.searchTerms || []).length),
    };
    const base = hasLicence && setupDone.cvs;
    const canRun = { trac: base && setupDone.trac, reed: base && setupDone.search, linkedin: base && setupDone.search, ats: base && setupDone.search };
    const running = anyRunning();
    const hour = new Date().getHours();
    const name = profile.firstName || trac.firstName || '';
    const apps = [...needs, ...ready].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const submitOn = { trac: !!(settings.autoSubmit && settings.autoSubmit.trac), ats: settings.atsSubmit !== false };
    const LABEL = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', ats: 'Company sites' };
    const bySource = Object.keys(LABEL).map((s) => [s, applied.filter((j) => j.source === s).length]).filter(([, n]) => n);

    const card = ([key, label, url, signLabel]) => {
      const on = agents[key].running;
      const toggle = key in submitOn ? `<label class="agent-submit-toggle">
          <input type="checkbox" class="auto" data-bot="${key}" ${submitOn[key] ? 'checked' : ''}>
          <span><strong>Submit for me</strong><br><small>${submitOn[key] ? 'Complete applications are submitted automatically.' : key === 'trac' ? 'Off: you check each application and press Submit on Trac.' : 'Off: forms are filled in a tab for you to check and submit.'}</small></span>
        </label>` : '';
      return `<div class="card bot-card${on ? ' bot-card-running' : ''}" id="bot-card-${key}">
        <div class="bot-card-header">
          <strong>${label}</strong>
          <span class="bot-status bot-status-${on ? 'running' : 'stopped'}">${on ? 'running' : 'stopped'}</span>
        </div>
        <div class="agent-run-state ${on ? 'on' : 'off'}">${on ? '✓ Working in a separate minimised Chrome window' : canRun[key] ? '○ Ready. Press Start' : '○ Finish setup to use this agent'}</div>
        ${toggle}
        <div class="bot-card-actions">
          ${on ? `<button class="secondary stop" data-bot="${key}">Stop</button>` : `<button class="primary start" data-bot="${key}" ${canRun[key] ? '' : 'disabled'}>Start</button>`}
          ${url ? `<button class="btn-connect signin" data-url="${url}">${signLabel}</button>` : ''}
        </div>
      </div>`;
    };

    content.innerHTML = `
      <div class="dash-head">
        <div>
          <h2 class="dash-greeting">Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}${name ? ', ' + esc(name) : ''}</h2>
          <p class="dash-sub">${running ? 'Your agents are working. Keep this tab open.' : hasLicence ? 'Your agents are ready. Press Start applying.' : 'Monitor agent activity and track your application progress.'}</p>
        </div>
        <div class="dash-cta">
          <button class="secondary stop-all-btn" id="stop-all" ${running ? '' : 'disabled'}>Stop</button>
          <button class="primary start-applying-btn" id="start-all" ${Object.values(canRun).some(Boolean) ? '' : 'disabled'}>▶ Start applying</button>
        </div>
      </div>

      ${hasLicence ? '' : `<div class="no-license-banner"><span>&#9888;  A license is required to start the Agents.</span><button class="no-license-cta preflight-link" data-view="license">Activate license →</button></div>`}

      <div class="card get-started-card">
        <h3>How to start applying</h3>
        <ol class="get-started-steps">
          <li>${gsMark(setupDone.cvs, 1)}<span>Upload your CV. We fill in your details from it</span>${setupDone.cvs ? '<em class="gs-ok">Done</em>' : '<button class="preflight-link cv-fill-btn">Upload CV →</button>'}</li>
          <li>${gsMark(setupDone.personal, 2)}<span>Check your details</span>${setupDone.personal ? '<em class="gs-ok">Done</em>' : '<button class="preflight-link" data-view="personal">Check details →</button>'}</li>
          <li>${gsMark(false, 3)}<span>Sign in to your job sites in this Chrome. Use the <strong>Sign in</strong> buttons on the cards below</span></li>
          <li>${gsMark(running, 4)}<span>Click <strong>Start applying</strong>. The AI scores jobs, tailors your CV and applies for you automatically</span>${running ? '<em class="gs-ok">Applying…</em>' : ''}</li>
        </ol>
        <span class="status-msg" id="gs-cv-st"></span>
      </div>

      <div class="card setup-card">
        <h3>Set up your details</h3>
        <p class="card-hint">Everything the agents use to apply. Fill these in once.</p>
        <div class="setup-quick">
          <button class="preflight-link${setupDone.personal ? ' is-done' : ''}" data-view="personal">${setupDone.personal ? '✓' : '👤'} Personal details</button>
          <button class="preflight-link${setupDone.search ? ' is-done' : ''}" data-view="search">${setupDone.search ? '✓' : '⚙️'} Search preferences</button>
          <button class="preflight-link${setupDone.cvs ? ' is-done' : ''}" data-view="cvs">${setupDone.cvs ? '✓' : '📄'} CVs</button>
          <button class="preflight-link${setupDone.trac ? ' is-done' : ''}" data-view="trac-details">${setupDone.trac ? '✓' : '🏥'} NHS / Trac details</button>
          <button class="preflight-link${hasLicence ? ' is-done' : ''}" data-view="license">${hasLicence ? '✓' : '🔑'} License</button>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card applied"><div class="num">${applied.length}</div><div class="label">Applied</div><div class="sub">${esc(bySource.map(([s, n]) => `${LABEL[s]} ${n}`).join(' · '))}</div></div>
        <div class="summary-card pending"><div class="num">${inQueue.length}</div><div class="label">In queue</div></div>
        ${ready.length + waiting.length ? `<div class="summary-card ready"><div class="num">${ready.length + waiting.length}</div><div class="label">Ready to submit</div></div>` : ''}
        <div class="summary-card apply_failed"><div class="num">${needs.length + failed.length}</div><div class="label">Needs attention</div></div>
      </div>

      ${waiting.length ? `<div class="card card-wide nhs-apps-card">
        <h3 style="margin:0 0 4px">Filled in, waiting for you</h3>
        <p class="nhs-apps-hint">Each form is open in a tab. Check it and press Submit on the site.</p>
        ${waiting.map((a) => `<div class="nhs-app"><div class="nhs-app-main"><div class="nhs-app-title">${esc(a.title)}</div><div class="nhs-app-meta">${esc(a.company || '')}</div></div><span class="badge badge-warning">Waiting for you</span><div class="nhs-app-actions"><button class="primary open-url" data-url="${esc(a.url)}">Open form</button><button class="secondary mark-sent" data-id="${esc(a.jobId)}">I submitted it</button></div></div>`).join('')}
      </div>` : ''}

      ${apps.length ? `<div class="card card-wide nhs-apps-card">
        <h3 style="margin:0 0 4px">NHS applications</h3>
        <p class="nhs-apps-hint">Opens on Trac in a normal tab. Sign in there if asked.</p>
        ${apps.map((a, i) => appRow(a, i)).join('')}
      </div>` : ''}

      <div class="dash-cols">
        <div class="dash-col-main">
          <div class="dash-col-title">Your agents</div>
          <p class="bot-controls-hint">Press <strong>Start applying</strong> to run every agent that is set up, or start one on its card.</p>
          <div class="bot-controls">${AGENTS.map(card).join('')}</div>
        </div>
        <div class="dash-col-side">
          <div class="dash-col-title">Applications (last 14 days)</div>
          <div class="card dash-applications-card">${buildApplicationsGraph(all)}</div>
        </div>
      </div>`;

    $$('.start').forEach((b) => b.addEventListener('click', () => startAgent(b.dataset.bot)));
    $$('.stop').forEach((b) => b.addEventListener('click', () => { agents[b.dataset.bot].stop(); renderDashboard(); }));
    $('#start-all').addEventListener('click', async () => {
      if (!(await recheckLicence())) { navigate('license'); return; }
      for (const k of Object.keys(agents)) if (canRun[k] && !agents[k].running) agents[k].start();
      setTimeout(renderDashboard, 300);
    });
    $('#stop-all').addEventListener('click', () => { Object.values(agents).forEach((a) => a.stop()); renderDashboard(); });
    $$('.preflight-link[data-view]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
    $$('.cv-fill-btn').forEach((b) => b.addEventListener('click', () => pickCv('#gs-cv-st', cvToPersonal)));
    $$('.signin').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.url)));
    $$('.auto').forEach((el) => el.addEventListener('change', async (e) => {
      const on = e.target.checked; const key = e.target.dataset.bot;
      if (on && key === 'trac' && !confirm('Let the NHS agent submit applications for you?\n\nIt only submits when every section on Trac is complete, and never forms that ask about AI use.')) { e.target.checked = false; return; }
      const s = await store.get('settings');
      if (key === 'trac') s.autoSubmit = { ...(s.autoSubmit || {}), trac: on }; else s.atsSubmit = on;
      await store.set('settings', s); renderDashboard();
    }));
    $$('.mark-sent').forEach((b) => b.addEventListener('click', async () => { await store.updateJob(b.dataset.id, { status: 'applied', appliedAt: new Date().toISOString(), reason: '' }); renderDashboard(); }));
    $$('.open-url, .nhs-open').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.url)));
    $$('.nhs-statement').forEach((b) => b.addEventListener('click', () => { const p = $('#nhs-st-' + b.dataset.i); p.hidden = !p.hidden; b.textContent = p.hidden ? 'Supporting statement' : 'Hide supporting statement'; }));
  } finally { dashBusy = false; }
};
function renderDashboard() { return VIEWS.dashboard(); }

function appRow(a, i) {
  const ok = a.status === 'ready_to_submit';
  const missing = ok ? '' : String(a.reason || '').replace(/^Draft saved on Trac\.?\s*Needs you:\s*/i, '').replace(/\.$/, '');
  const url = /^https:\/\/apps\.trac\.jobs\//.test(a.draftUrl || '') ? a.draftUrl : 'https://apps.trac.jobs/applicationlist';
  return `<div class="nhs-app">
    <div class="nhs-app-main"><div class="nhs-app-title">${esc(String(a.title || '').split(' Band ')[0])}</div><div class="nhs-app-meta">${esc(a.company || 'NHS')}</div>${missing ? `<div class="nhs-app-missing">Needs you: ${esc(missing)}</div>` : ''}</div>
    <span class="badge ${ok ? 'badge-success' : 'badge-warning'}">${ok ? 'Ready to submit' : 'Needs you'}</span>
    <div class="nhs-app-actions"><button class="primary nhs-open" data-url="${esc(url)}">Open on Trac</button>${a.coverLetter ? `<button class="secondary nhs-statement" data-i="${i}">Supporting statement</button>` : ''}</div>
    ${a.coverLetter ? `<pre class="nhs-app-statement" id="nhs-st-${i}" hidden>${esc(a.coverLetter)}</pre>` : ''}
  </div>`;
}
setInterval(() => { if (current === 'dashboard' && !document.hidden) renderDashboard(); }, 5000);

// ── Tracker ──────────────────────────────────────────────────────────────────
const STATUS = { applied: ['Applied', 'badge-success'], apply_failed: ['Failed', 'badge-danger'], skipped: ['Skipped', 'badge-muted'], pending: ['Found', 'badge-info'], cv_ready: ['CV ready', 'badge-info'], applying: ['Applying', 'badge-info'], ready: ['Waiting for you', 'badge-warning'], ready_to_submit: ['Ready to submit', 'badge-success'] };
const SOURCE = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', ats: 'Company site' };
let trackerFilter = 'all';
VIEWS.tracker = async function renderTracker() {
  const all = (await store.jobs()).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const f = trackerFilter;
  const shown = all.filter((j) => f === 'all' || (f === 'applied' ? j.status === 'applied' : f === 'skipped' ? j.status === 'skipped' : !['applied', 'skipped'].includes(j.status)));
  content.innerHTML = `
    <div class="page-header"><h2>Tracker</h2><p>Every job your agents found, and what happened to it.</p></div>
    <div class="ext-inline" style="margin-bottom:12px">${[['all', 'All'], ['applied', 'Applied'], ['open', 'In progress'], ['skipped', 'Skipped']].map(([k, l]) => `<button class="${f === k ? 'primary' : 'secondary'} trk-f" data-f="${k}">${l}</button>`).join('')}</div>
    ${shown.length ? `<div class="card card-wide"><div class="table-scroll"><table class="data-table tracker-table">
      <thead><tr><th>Job</th><th>Company</th><th>Site</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${shown.slice(0, 300).map((j) => { const [l, c] = STATUS[j.status] || [j.status, 'badge-info']; const u = safeUrl(j.draftUrl || j.url); return `<tr>
        <td class="tracker-title" title="${esc(j.title)}">${u ? `<a class="tracker-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a>` : esc(j.title)}</td>
        <td>${esc(j.company || '')}</td><td>${esc(SOURCE[j.source] || j.source || '')}</td>
        <td><span class="badge ${c}" title="${esc(j.reason || '')}">${esc(l)}</span></td>
        <td>${esc(j.updatedAt ? new Date(j.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '')}</td></tr>`; }).join('')}</tbody>
    </table></div></div>` : '<div class="card"><div class="empty-state">No applications tracked yet. Jobs appear here once the agents start working.</div></div>'}`;
  $$('.trk-f').forEach((b) => b.addEventListener('click', () => { trackerFilter = b.dataset.f; renderTracker(); }));
};

// ── Activity ─────────────────────────────────────────────────────────────────
let unLog = null;
VIEWS.activity = async function renderActivity() {
  const log = await store.get('log');
  content.innerHTML = `<div class="page-header"><h2>Activity</h2><p>What your agents have been doing.</p></div><div class="card"><pre class="ext-log" id="log">${esc(log.join('\n'))}</pre></div>`;
  const el = $('#log'); el.scrollTop = el.scrollHeight;
  if (unLog) unLog();
  unLog = store.onLog((line) => { const box = $('#log'); if (!box) return; box.textContent += '\n' + line; box.scrollTop = box.scrollHeight; });
};

// ── Setup: Personal details ──────────────────────────────────────────────────
const saveBar = (id, label = 'Save') => `<div class="card"><div class="ext-inline"><button class="primary" id="${id}">${label}</button><span class="status-msg" id="${id}-st"></span></div></div>`;
VIEWS.personal = async function renderPersonal() {
  const { profile: P } = await loadConfig();
  const f = (k, l, type = 'text', ph = '') => `<div class="field"><label>${esc(l)}</label><input class="p-in" data-k="${k}" type="${type}" value="${esc(P[k] ?? '')}" placeholder="${esc(ph)}"></div>`;
  content.innerHTML = `
    <div class="page-header"><h2>Personal Details</h2><p>Used to fill in application forms automatically. Saved on this device only.</p></div>
    ${P.firstName && P.lastName && P.email && P.phone ? '' : `<div class="card"><h3>Fill this in from your CV</h3><p class="muted">Upload your CV and we'll add your name, contact details and experience for you.</p>
      <div class="ext-inline"><button class="primary" id="cv-fill">Upload CV</button><span class="status-msg" id="cv-fill-st"></span></div></div>`}
    <div class="card"><h3>About you</h3><div class="tracd-grid">
      ${f('firstName', 'First name')}${f('lastName', 'Last name')}${f('email', 'Email', 'email')}${f('phone', 'Phone', 'tel')}
      ${f('location', 'City / town')}${f('linkedin', 'LinkedIn profile URL', 'url', 'https://www.linkedin.com/in/...')}
    </div></div>
    <div class="card"><h3>Application answers</h3><p class="muted">How the agents answer common questions on job forms.</p><div class="tracd-grid">
      ${f('yearsExperience', 'Years of experience', 'number')}
      ${f('rightToWorkCountries', 'Countries you can work in', 'text', 'United Kingdom')}
      <div class="field"><label>Notice period</label><select id="p-avail">${[['immediately', 'Immediately'], ['1week', '1 week'], ['2weeks', '2 weeks'], ['1month', '1 month'], ['3months', '3 months']].map(([v, l]) => `<option value="${v}" ${(P.availability || 'immediately') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${f('salaryExpectation', 'Minimum salary (£ a year)', 'text', 'e.g. 28000')}
    </div>
    <div class="tracd-sectors" style="margin-top:12px">${[['requiresSponsorship', 'I need visa sponsorship'], ['seekSponsorship', 'Only apply to jobs that offer sponsorship'], ['willingToRelocate', 'Willing to relocate'], ['drivingLicence', 'I have a driving licence']].map(([k, l]) => `<label class="sector-chip"><input type="checkbox" class="p-flag" data-k="${k}" ${P[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
    <div class="card"><h3>Equality monitoring</h3><p class="muted">Leave as "Prefer not to say" if you'd rather not share.</p><div class="tracd-grid">
      ${[['eeoGender', 'Gender', ['', 'Male', 'Female', 'Non-binary']], ['eeoEthnicity', 'Ethnicity', ['', 'White', 'Mixed', 'Asian', 'Black', 'Arab', 'Other']], ['eeoDisability', 'Disability', ['', 'No', 'Yes']], ['eeoVeteran', 'Veteran', ['', 'No', 'Yes']]].map(([k, l, o]) => `<div class="field"><label>${l}</label><select class="p-sel" data-k="${k}">${o.map((x) => `<option value="${x}" ${(P[k] || '') === x ? 'selected' : ''}>${x || 'Prefer not to say'}</option>`).join('')}</select></div>`).join('')}
    </div></div>
    ${saveBar('p-save')}`;
  $('#cv-fill')?.addEventListener('click', () => pickCv('#cv-fill-st', cvToPersonal));
  $('#p-save').addEventListener('click', async () => {
    const out = {};
    $$('.p-in').forEach((i) => { out[i.dataset.k] = i.value.trim(); });
    $$('.p-sel').forEach((s) => { out[s.dataset.k] = s.value; });
    $$('.p-flag').forEach((c) => { out[c.dataset.k] = c.checked; });
    out.availability = $('#p-avail').value;
    out.yearsExperience = Number(out.yearsExperience) || 0;
    if (out.linkedin && !safeUrl(out.linkedin)) { setSt('#p-save-st', 'The LinkedIn link must start with https://', true); return; }
    await store.patch('profile', out); await loadConfig();
    setSt('#p-save-st', '✓ Saved.');
  });
};

// ── Setup: CVs ───────────────────────────────────────────────────────────────
VIEWS.cvs = async function renderCVs() {
  const cv = await store.get('cv');
  content.innerHTML = `
    <div class="page-header"><h2>CVs</h2><p>Your CV is read on this device and never uploaded. Before each application the AI tailors a copy to that job.</p></div>
    <div class="card"><h3>Your CV</h3><p class="muted">Word (.docx) is read most accurately. PDF also works.</p>
      <div class="ext-inline"><button class="primary" id="cv-pick">${cv && cv.text ? 'Replace CV' : 'Add CV'}</button><span class="status-msg" id="cv-st">${cv && cv.text ? 'Using: ' + esc(cv.name) : 'No CV yet'}</span></div></div>`;
  $('#cv-pick').addEventListener('click', () => pickCv('#cv-st', (msg) => VIEWS.cvs().then(() => setSt('#cv-st', msg))));
};

// ── Setup: Search preferences ────────────────────────────────────────────────
VIEWS.search = async function renderSearch() {
  const { profile, settings } = await loadConfig();
  content.innerHTML = `
    <div class="page-header"><h2>Search Preferences</h2><p>Used by the Reed, LinkedIn and company sites agents.</p></div>
    <div class="card"><div class="tracd-grid">
      <div class="field"><label>Job titles to search (one per line)</label><textarea id="s-terms" class="tracd" rows="5" placeholder="e.g. IT Support Analyst">${esc((profile.searchTerms || []).join('\n'))}</textarea></div>
      <div class="field"><label>Skip jobs with these words in the title (one per line)</label><textarea id="s-exclude" class="tracd" rows="5" placeholder="e.g. Senior">${esc((profile.excludeKeywords || []).join('\n'))}</textarea></div>
      <div class="field"><label>Search location</label><input id="s-where" type="text" value="${esc(profile.searchLocation || 'United Kingdom')}"></div>
      <div class="field"><label>Minimum CV match (%)</label><input id="s-min" type="number" min="40" max="100" value="${esc(profile.minScore ?? 70)}"></div>
      <div class="field"><label>Where you want to work</label><div class="tracd-sectors">${[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']].map(([v, l]) => `<label class="sector-chip"><input type="checkbox" class="s-wt" value="${v}" ${(profile.workTypePriority || ['remote', 'hybrid', 'onsite']).includes(v) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="field"><label>Contract</label><div class="tracd-sectors">${[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Fixed-term / contract']].map(([v, l]) => `<label class="sector-chip"><input type="checkbox" class="s-type" value="${v}" ${(profile.employmentType || ['full_time']).includes(v) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="field"><label>Applications a day</label><select id="s-cap">${[5, 10, 15, 20, 25].map((n) => `<option value="${n}" ${Number(settings.dailyCap || 15) === n ? 'selected' : ''} ${n > cfg.PLAN_CAP ? 'disabled' : ''}>${n}${n > cfg.PLAN_CAP ? ' (Pro)' : ''}</option>`).join('')}</select></div>
    </div></div>
    ${saveBar('s-save')}`;
  $('#s-save').addEventListener('click', async () => {
    await store.patch('profile', {
      searchTerms: lines('#s-terms').slice(0, 40), excludeKeywords: lines('#s-exclude').slice(0, 80),
      searchLocation: $('#s-where').value.trim() || 'United Kingdom', minScore: Math.max(40, Math.min(100, Number($('#s-min').value) || 70)),
      workTypePriority: $$('.s-wt:checked').map((c) => c.value), employmentType: $$('.s-type:checked').map((c) => c.value),
    });
    await store.patch('settings', { dailyCap: Number($('#s-cap').value) });
    await loadConfig();
    setSt('#s-save-st', '✓ Saved.');
  });
};

// ── Setup: License ───────────────────────────────────────────────────────────
VIEWS.license = async function renderLicense() {
  const { license } = await loadConfig();
  const active = licenceActive(license);
  // The saved key is never written back into the page; only its last 4 characters are shown.
  content.innerHTML = `
    <div class="page-header"><h2>License</h2><p>Paste the key from your Job-AI welcome email. The same key works in the desktop app.</p></div>
    <div class="card">
      ${license.key ? `<div class="stat-row"><span class="stat-label">Key</span><span class="stat-value">•••• ${esc(license.key.slice(-4))}</span></div>
      <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value">${active ? (license.status === 'trial' ? 'Free trial' : 'Active') : license.status === 'device_trial_used' ? 'Trial already used on this device' : 'Not active'}</span></div>
      ${license.expiresAt ? `<div class="stat-row"><span class="stat-label">${active ? 'Renews / ends' : 'Ended'}</span><span class="stat-value">${esc(new Date(license.expiresAt).toLocaleDateString('en-GB'))}</span></div>` : ''}` : ''}
      <div class="field" style="max-width:460px;margin-top:12px"><label>${license.key ? 'Replace key' : 'License key'}</label><input id="lic" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key"></div>
      <div class="ext-inline"><button class="primary" id="lic-save">Activate</button>${license.key ? '<button class="secondary" id="lic-remove">Remove key</button>' : ''}<span class="status-msg" id="lic-st"></span></div>
      <p class="muted" style="margin-top:12px">No key yet? <a class="tracker-link" href="https://www.tryjobai.com/trial" target="_blank" rel="noopener noreferrer">Start a free trial</a></p>
    </div>`;
  $('#lic-save').addEventListener('click', async () => {
    const k = $('#lic').value.trim();
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(k)) { setSt('#lic-st', 'That does not look like a Job-AI key.', true); return; }
    setSt('#lic-st', 'Checking…');
    try {
      const r = await checkLicense(k);
      if (!r.ok) { setSt('#lic-st', r.http === 401 ? 'That key was not recognised.' : r.error === 'device_trial_used' ? 'This device has already used a free trial.' : /expired|inactive/.test(r.error) ? 'That licence has ended. Renew it to carry on.' : 'Could not check the key (' + r.http + ').', true); return; }
      await store.set('license', { key: k, status: r.licenseStatus || 'active', expiresAt: r.expires_at, checkedAt: Date.now() });
      $('#lic').value = '';
      globalThis.__jobaiLicense = k;
      setSt('#lic-st', `✓ Active${r.expires_at ? ' until ' + new Date(r.expires_at).toLocaleDateString('en-GB') : ''}.`);
      setTimeout(renderLicense, 900);
    } catch (e) { setSt('#lic-st', 'Could not reach Job-AI. Check your connection.', true); }
  });
  $('#lic-remove') && $('#lic-remove').addEventListener('click', async () => {
    if (!confirm('Remove the licence key from this browser? The agents stop until you add it again.')) return;
    Object.values(agents).forEach((a) => a.stop());
    await store.set('license', { key: '' }); globalThis.__jobaiLicense = '';
    renderLicense();
  });
};

// ── Setup: NHS / Trac details ────────────────────────────────────────────────
const SECTORS = [['s7', 'Administrative Services'], ['s6', 'Support Services'], ['s5', 'Health Science Services'], ['s1', 'Nursing & Midwifery'], ['s2', 'Medical & Dental'], ['s4', 'Allied Health Professions'], ['s3', 'Emergency Services'], ['s119', 'Personal Social Services'], ['s8', 'Directors'], ['s10', 'Apprenticeships'], ['s9', 'Volunteers']];
const SELECTS = [
  ['title', 'Title', ['', 'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Mx']],
  ['rightToWork', 'Right to work in the UK', ['', 'British citizen', 'Irish citizen', 'Settled status (EU Settlement Scheme)', 'Pre-settled status', 'Visa holder / work permit', 'I require sponsorship']],
  ['convictions', 'Any unspent criminal convictions?', ['no', 'yes']],
  ['gender', 'Gender', ['', 'Male', 'Female', 'Non-binary', 'Prefer not to say']],
  ['genderSameAsBirth', 'Gender same as at birth?', ['', 'Yes', 'No', 'Prefer not to say']],
  ['trans', 'Ever identified as trans or transgender?', ['', 'No', 'Yes', 'Prefer not to say']],
  ['ethnicity', 'Ethnic origin', ['', 'White - British', 'White - Irish', 'White - Other', 'Mixed', 'Asian - Indian', 'Asian - Pakistani', 'Asian - Bangladeshi', 'Asian - Chinese', 'Asian - Other', 'Black - African', 'Black - Caribbean', 'Black - Other', 'Arab', 'Other', 'Prefer not to say']],
  ['sexualOrientation', 'Sexual orientation', ['', 'Heterosexual / Straight', 'Gay / Lesbian', 'Bisexual', 'Other', 'Prefer not to say']],
  ['religion', 'Religion or belief', ['', 'None', 'Christian', 'Buddhist', 'Hindu', 'Jewish', 'Muslim', 'Sikh', 'Other', 'Prefer not to say']],
  ['maritalStatus', 'Marital status', ['', 'Single', 'Married', 'Civil partnership', 'Divorced', 'Widowed', 'Prefer not to say']],
  ['disability', 'Do you consider yourself to have a disability?', ['', 'No', 'Yes', 'Prefer not to say']],
  ['guaranteedInterview', 'Disability Confident guaranteed interview?', ['', 'No', 'Yes']],
  ['armedForces', 'Armed forces community?', ['', 'No', 'Currently serving', 'Veteran / ex-forces', 'Reservist', 'Spouse / partner of a member']],
  ['schoolType', 'Main school type (age 11-16)', ['', 'State-run or state-funded', 'Independent / fee-paying (with bursary)', 'Independent / fee-paying (no bursary)', 'Attended school outside the UK', 'Prefer not to say']],
  ['freeSchoolMeals', 'Eligible for free school meals?', ['', 'No', 'Yes', 'Do not know', 'Prefer not to say']],
  ['socioOccupation', 'Main earner occupation when you were 14', ['', 'Modern professional / traditional professional', 'Senior/junior manager or administrator', 'Clerical / intermediate occupation', 'Technical / craft occupation', 'Semi-routine manual / service', 'Routine manual / service', 'Long-term unemployed', 'Other / prefer not to say']],
  ['howHeard', 'How did you hear of vacancies?', ['', 'NHS Jobs website', 'Trac.jobs', 'Indeed', 'LinkedIn', 'Word of mouth', 'Other']],
  ['gcseMathsEnglish', 'GCSE Maths and English at C / 4 or above (or equivalent)?', ['', 'Yes', 'No']],
  ['welsh', 'Can you speak, read or write Welsh?', ['', 'No', 'Yes']],
  ['careLeaver', 'Have you ever been in care (care leaver)?', ['', 'No', 'Yes', 'Prefer not to say']],
];
const TEXTS = [['firstName', 'Forename'], ['middleName', 'Middle name(s)'], ['lastName', 'Surname'], ['email', 'Email'], ['mobile', 'Mobile telephone'], ['address', 'Address'], ['city', 'City / town'], ['county', 'County'], ['postcode', 'Postcode'], ['country', 'Country'], ['ni', 'National Insurance number'], ['dob', 'Date of birth (DD/MM/YYYY)']];
const REPS = {
  employment: [['employer', 'Employer'], ['jobTitle', 'Your job title'], ['start', 'Start (DD/MM/YYYY)'], ['end', 'End (DD/MM/YYYY, blank if current)'], ['reason', 'Reason for leaving'], ['duties', 'Brief description of duties & responsibilities', 'ta']],
  education: [['qualification', 'Subject / qualification'], ['place', 'Place of study'], ['grade', 'Grade / result'], ['year', 'Year obtained']],
  references: [['name', "Referee's name"], ['org', 'Organisation'], ['jobTitle', 'Their job title'], ['email', 'Work email'], ['phone', 'Phone'], ['relationship', 'How they know you (e.g. Line manager)'], ['address', 'Address line 1'], ['city', 'City / Town'], ['postcode', 'Postcode']],
};
function repHtml(group, items) {
  return (items.length ? items : [{}]).map((it) => `<div class="tracd-row" data-group="${group}">
    <div class="tracd-grid">${REPS[group].filter((f) => f[2] !== 'ta').map(([k, l]) => `<input class="tracd" data-k="${k}" type="text" value="${esc(it[k] || '')}" placeholder="${esc(l)}">`).join('')}</div>
    ${REPS[group].filter((f) => f[2] === 'ta').map(([k, l]) => `<textarea class="tracd" data-k="${k}" rows="2" placeholder="${esc(l)}">${esc(it[k] || '')}</textarea>`).join('')}
    <button class="tracd-del" type="button">Remove</button></div>`).join('');
}

VIEWS['trac-details'] = async function renderTrac() {
  const { trac } = await loadConfig();
  const d = trac || {};
  content.innerHTML = `
    <div class="page-header"><h2>NHS / Trac details</h2><p>Fill this in once. The NHS agent uses it for every Trac application. Saved on this device only.</p></div>

    <div class="card" style="border:1px dashed var(--primary);background:var(--primary-soft)">
      <h3 style="margin-top:0">Already have a completed Trac form? Upload it</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:2px 0 12px">Upload a Trac application PDF you filled in before. We read every answer and fill this page for you, so there is no typing.</p>
      <div class="ext-inline"><input type="file" id="imp" accept=".pdf" hidden><button class="primary" id="imp-pick">Upload completed Trac PDF</button><span class="status-msg" id="imp-st"></span></div></div>

    <div class="card"><h3>Select sector</h3>
      <div class="tracd-sectors">${SECTORS.map(([c, n]) => `<label class="sector-chip"><input type="checkbox" class="sector" value="${c}" ${(d.sectors || []).includes(c) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div></div>

    <div class="card"><h3>NHS search terms</h3><p class="muted">One job title per line.</p>
      <textarea id="terms" class="tracd" rows="5" placeholder="e.g. IT Support Analyst">${esc((d.searchTerms || []).join('\n'))}</textarea></div>

    <div class="card"><h3>Personal details</h3><div class="tracd-grid">
      ${TEXTS.map(([k, l]) => `<div class="field"><label>${esc(l)}</label><input class="t-text" data-k="${k}" type="text" value="${esc(d[k] || '')}"></div>`).join('')}</div></div>

    <div class="card"><h3>Employment history <span style="font-weight:400;color:var(--text-muted);font-size:13px">(most recent first)</span></h3>
      <div id="rep-employment">${repHtml('employment', d.employment || [])}</div><button class="secondary tracd-add" data-group="employment" type="button">+ Add employer</button></div>

    <div class="card"><h3>Gaps in employment</h3><p class="muted">If there are gaps of over 3 months between jobs, explain them once here.</p>
      <textarea id="gaps" class="tracd" rows="3" placeholder="e.g. Jan to Jun 2023: career break to care for a family member.">${esc(d.employmentGaps || '')}</textarea></div>

    <div class="card"><h3>References <span style="font-weight:400;color:var(--text-muted);font-size:13px">(cover the last 3 years)</span></h3>
      <div id="rep-references">${repHtml('references', d.references || [])}</div><button class="secondary tracd-add" data-group="references" type="button">+ Add reference</button></div>

    <div class="card"><h3>Education &amp; qualifications</h3>
      <div id="rep-education">${repHtml('education', d.education || [])}</div><button class="secondary tracd-add" data-group="education" type="button">+ Add qualification</button></div>

    <div class="card"><h3>Declarations &amp; monitoring</h3><div class="tracd-grid">
      ${SELECTS.map(([k, l, opts]) => { const cur = String(d[k] || ''); const o = cur && !opts.includes(cur) ? [cur, ...opts] : opts; return `<div class="field"><label>${esc(l)}</label><select class="t-sel" data-k="${k}">${o.map((x) => `<option value="${esc(x)}" ${cur === x ? 'selected' : ''}>${esc(x || 'Select…')}</option>`).join('')}</select></div>`; }).join('')}
    </div></div>
    ${saveBar('save')}`;

  $('#imp-pick').addEventListener('click', () => $('#imp').click());
  $('#imp').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return; setSt('#imp-st', 'Reading your form… (about a minute)');
    try {
      const out = await importTracText(await extractText(f));
      const cur = await store.get('trac');
      const merged = { ...cur, ...out.trac };
      for (const g of ['employment', 'education', 'references']) if (!(out.trac[g] || []).length) merged[g] = cur[g] || [];
      await store.set('trac', merged);
      setSt('#imp-st', `✓ Imported ${out.counts.employment} job(s), ${out.counts.education} qualification(s), ${out.counts.references} referee(s). Check the details below.`);
      setTimeout(renderTrac, 600);
    } catch (err) { setSt('#imp-st', err.message, true); }
  });
  const bindDel = () => $$('.tracd-del').forEach((b) => { b.onclick = () => b.closest('.tracd-row').remove(); });
  $$('.tracd-add').forEach((b) => b.addEventListener('click', () => { $('#rep-' + b.dataset.group).insertAdjacentHTML('beforeend', repHtml(b.dataset.group, [{}])); bindDel(); }));
  bindDel();

  $('#save').addEventListener('click', async () => {
    const t = { ...(await store.get('trac')) };
    $$('.t-text').forEach((i) => { t[i.dataset.k] = i.value.trim(); });
    $$('.t-sel').forEach((s) => { t[s.dataset.k] = s.value; });
    for (const g of Object.keys(REPS)) t[g] = $$('#rep-' + g + ' .tracd-row').map((r) => Object.fromEntries($$('[data-k]', r).map((i) => [i.dataset.k, i.value.trim()]))).filter((o) => Object.values(o).some(Boolean));
    t.searchTerms = lines('#terms');
    t.sectors = $$('.sector:checked').map((c) => c.value);
    t.employmentGaps = $('#gaps').value.trim();
    await store.set('trac', t);
    // Fill any gaps in the main profile from the NHS form (never overwrite what the user set there).
    const p = await store.get('profile');
    const fill = { firstName: t.firstName, lastName: t.lastName, email: t.email, phone: t.mobile, location: t.city };
    await store.patch('profile', Object.fromEntries(Object.entries(fill).filter(([k, v]) => v && !p[k])));
    const bad = (t.references || []).flatMap((r, i) => [!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(r.email || '') ? `${r.name || 'Referee ' + (i + 1)} needs a valid email` : '', String(r.phone || '').replace(/\D/g, '').length < 10 ? `${r.name || 'Referee ' + (i + 1)} needs a phone number` : ''].filter(Boolean));
    setSt('#save-st', bad.length ? 'Saved, but check: ' + bad.join('; ') + '.' : '✓ Saved. The agent uses these on every NHS form.', !!bad.length);
    await loadConfig();
  });
};

// ── Welcome + setup tour (same flow as the app, first open only) ─────────────
const TOUR_STEPS = [
  { view: 'cvs', title: 'Step 1: Upload your CV', tip: 'Start here. We read your CV and fill in your name, contact details, experience and the job titles to search for. Upload it as a Word document (.docx) for the best results. PDF also works. Before each application, the AI rewrites your summary and bullet points to match that specific job.', action: 'Click "Add CV" and choose your CV. It is read on this device and never uploaded.' },
  { view: 'personal', title: 'Step 2: Check your details', tip: 'Your name, email, phone, location and right to work status are used to fill in application forms automatically. The more complete this page is, the fewer forms the agents leave blank.', action: 'If you uploaded your CV, most of this is already filled in. Check it, complete anything missing and click Save.' },
  { view: 'search', title: 'Step 3: Search preferences', tip: 'Add the job titles you want to apply for, for example "IT Support Analyst". The Reed, LinkedIn and company sites agents all use these terms.', action: 'Add at least one job title, set your work type, then click Save.' },
  { view: 'license', title: 'Step 4: Activate your license', tip: 'Enter the license key from your welcome email. The AI that tailors your CV runs on our cloud, so there is nothing extra to install.', action: 'Paste your license key into the box and click Activate.' },
  { view: 'dashboard', title: 'Step 5: Sign in to your job sites', tip: 'The agents work inside this Chrome, using the accounts you are already signed in to. They never see your password.', action: 'Click "Sign in to Reed" or "Sign in to LinkedIn" on an agent card, sign in as normal, then come back to this tab. The company sites agent needs no sign in.' },
  { view: 'dashboard', title: 'All set: start applying', tip: 'Click Start applying and each agent opens its own minimised Chrome window and works inside it: searching, tailoring your CV and applying to matching jobs.', action: 'Leave those windows alone and keep this Job-AI tab open. It is pinned so you do not close it by mistake. Closing it stops the agents.' },
  { view: 'trac-details', title: 'NHS jobs: the Trac Agent', tip: 'NHS jobs use a separate system called Trac with much longer forms, so the NHS agent has its own page: employment history, references, education and the monitoring questions.', action: 'Open "NHS / Trac details" and fill it in once, or click "Upload completed Trac PDF" to fill it from an old application. Then sign in to Trac with the button on the NHS agent card.' },
];
function startTour() {
  let step = 0;
  const end = () => { const p = $('#tour-panel'); if (p) p.remove(); store.patch('settings', { tourDone: true }); navigate('dashboard'); };
  const show = async () => {
    const s = TOUR_STEPS[step];
    await navigate(s.view);
    const old = $('#tour-panel'); if (old) old.remove();
    const last = step === TOUR_STEPS.length - 1;
    const panel = document.createElement('div');
    panel.id = 'tour-panel'; panel.className = 'tour-panel';
    panel.innerHTML = `<div class="tour-progress"><div class="tour-progress-fill" style="width:${Math.round(((step + 1) / TOUR_STEPS.length) * 100)}%"></div></div>
      <div class="tour-body"><div class="tour-step-label">Step ${step + 1} of ${TOUR_STEPS.length}</div><div class="tour-step-title">${esc(s.title)}</div>
      <p class="tour-tip">${esc(s.tip)}</p><div class="tour-action">${esc(s.action)}</div>
      <div class="tour-nav"><button class="tour-skip" id="tour-skip">Skip tour</button><button class="tour-next" id="tour-next">${last ? 'Finish setup' : 'Next'}</button></div></div>`;
    document.body.appendChild(panel);
    $('#tour-next').onclick = () => { if (last) end(); else { step++; show(); } };
    $('#tour-skip').onclick = end;
  };
  show();
}
async function initOnboarding() {
  const s = await store.get('settings');
  if (s.welcomeSeen) return;
  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.innerHTML = `<div class="welcome-modal"><div class="welcome-logo"></div>
    <h2>Welcome to Job-AI</h2>
    <p>Your automated job application assistant, right inside Chrome. Set it up once and the agents search, tailor your CV, and apply to jobs for you.</p>
    <div class="welcome-features">
      <div class="welcome-feature"><strong>4 Agents</strong><span>NHS (Trac), Reed, LinkedIn and company career sites</span></div>
      <div class="welcome-feature"><strong>AI CV Tailoring</strong><span>Every CV is rewritten to match the job before it is sent</span></div>
      <div class="welcome-feature"><strong>Private</strong><span>Your details and CV stay in this browser, on this device</span></div>
      <div class="welcome-feature"><strong>Auto Apply</strong><span>Fills the forms, attaches your tailored CV, and submits for you</span></div>
    </div>
    <div class="welcome-actions"><button class="primary" id="w-tour">Take the setup tour &rarr;</button><button class="welcome-skip-link" id="w-skip">I&rsquo;ll set up myself</button></div></div>`;
  document.body.appendChild(overlay);
  const dismiss = () => { overlay.remove(); store.patch('settings', { welcomeSeen: true }); };
  $('#w-tour').addEventListener('click', () => { dismiss(); startTour(); });
  $('#w-skip').addEventListener('click', dismiss);
}

// ── Ask Job-AI assistant (same behaviour and safety rules as the app) ────────
(function initAssistant() {
  const fab = $('#asst-fab'), panel = $('#asst-panel'), close = $('#asst-close'), log = $('#asst-log'), form = $('#asst-form'), input = $('#asst-input'), send = $('#asst-send');
  let greeted = false, pending = false;
  // Model output is untrusted: strip control chars, clamp length, escape ALL html, then allow only **bold**.
  function renderReply(text) {
    const clean = Array.from(String(text)).filter((ch) => { const n = ch.charCodeAt(0); return n === 9 || n === 10 || n === 13 || n >= 32; }).join('').slice(0, 4000);
    return esc(clean).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function addMsg(kind, text, isHtml) { const el = document.createElement('div'); el.className = 'asst-msg ' + kind; if (isHtml) el.innerHTML = text; else el.textContent = text; log.appendChild(el); log.scrollTop = log.scrollHeight; return el; }
  function addHint(text) { const el = document.createElement('div'); el.className = 'asst-hint'; el.textContent = text; log.appendChild(el); log.scrollTop = log.scrollHeight; }
  function openPanel() {
    panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); fab.classList.add('hidden');
    if (!greeted) { greeted = true; addHint('Hi! I can help you use Job-AI: signing in to your job sites, why a job was skipped, search terms, CVs, limits and more. Ask me anything.'); }
    setTimeout(() => input.focus(), 50);
  }
  function closePanel() { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); fab.classList.remove('hidden'); }
  fab.addEventListener('click', openPanel);
  close.addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closePanel(); });
  const ERRORS = {
    no_license: 'You need an active license to use the assistant. Add your key on the License page.',
    license_inactive: 'Your license isn’t active right now. Check the License page to renew.',
    license_expired: 'Your license has expired. Renew it on the License page to keep using the assistant.',
    assistant_daily_limit: 'You’ve reached today’s assistant limit. It resets in 24 hours.',
    rate_limited: 'Give me a moment, that was a lot of messages at once.',
    network_error: 'I couldn’t reach the server. Check your connection and try again.',
    assistant_unavailable: 'The assistant is briefly unavailable. Please try again in a moment.',
  };
  // PII-free snapshot of the agents' state, the same shape the app sends (no name, email, key or files).
  async function state() {
    const [license, profile, all, cv] = await Promise.all([store.get('license'), store.get('profile'), store.jobs(), store.get('cv')]);
    const queue = {}; for (const j of all) queue[j.status] = (queue[j.status] || 0) + 1;
    const reasons = {}; for (const j of all) if (j.status === 'skipped' && j.reason) reasons[j.reason] = (reasons[j.reason] || 0) + 1;
    return {
      client: 'chrome_extension',
      license: { status: license.status || 'unknown', plan: license.status === 'active' ? 'paid' : 'trial', expires_at: license.expiresAt || null },
      agents: Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, a.running ? 'running' : 'stopped'])),
      connected_accounts: {},
      applied_today: await store.appliedToday(),
      queue,
      top_skip_reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason: reason.slice(0, 120), count })),
      search_terms: (profile.searchTerms || []).slice(0, 40),
      exclude_keywords: (profile.excludeKeywords || []).slice(0, 40),
      cvs: cv && cv.text ? [{ label: 'CV', active: true }] : [],
    };
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pending) return;
    const q = input.value.trim(); if (!q) return;
    addMsg('user', q); input.value = ''; pending = true; send.disabled = true;
    const typing = addMsg('typing', 'Job-AI is thinking…'); typing.className = 'asst-typing';
    await loadConfig();
    let resp; try { resp = await askAssistant(q, await state()); } catch (_) { resp = { ok: false, error: 'network_error' }; }
    typing.remove(); pending = false; send.disabled = false;
    if (resp && resp.ok) {
      addMsg('bot', renderReply(resp.reply || ''), true);
      if (typeof resp.remaining_today === 'number' && resp.remaining_today <= 5) addHint(`${resp.remaining_today} assistant message${resp.remaining_today === 1 ? '' : 's'} left today.`);
    } else addMsg('error', ERRORS[resp && resp.error] || 'Something went wrong. Please try again, or email jobaisupport@gmail.com.');
    input.focus();
  });
})();

// Test builds only (node build.mjs --test): lets automated tests drive the same objects.
// Release builds leave this out, so nothing internal is exposed on the page.
if (process.env.JOBAI_TEST === '1') {
  globalThis.__jobaiTest = { agent, agents, mods: { reed: require('../../bot/modules/reed'), linkedin: require('../../bot/modules/linkedin'), ats: require('../../bot/modules/ats_filler'), feedJobs, fetchJD }, store, cfg, loadConfig, Page, vfs, vfsReady, trac: require('../../bot/modules/trac_source'), apply: require('../../bot/modules/trac_apply'), parseCV: require('../../bot/modules/cv_parser').parseCV, pdf: require('../../bot/modules/cv_pdf_writer') };
}

navigate('dashboard');
initOnboarding();
