// Job-AI dashboard (the extension's main tab). Runs the agents while it's open.
// Same layout, components and stylesheet as the desktop app: Dashboard / Tracker / Activity tabs,
// the Setup menu, the welcome + setup tour and the "Ask Job-AI" assistant.
import cfg from './shims/config.js';
import * as store from './lib/store.js';
import { extractText, toBase64 } from './lib/cvtext.js';
import { TracAgent } from './agents/trac.js';
import { ReedAgent } from './agents/reed.js';
import { LinkedInAgent } from './agents/linkedin.js';
import { IndeedAgent } from './agents/indeed.js';
import { DiceAgent } from './agents/dice.js';
import { WellfoundAgent } from './agents/wellfound.js';
import { AtsAgent, feedJobs, fetchJD, fillAndOpen, releaseHeld } from './agents/ats.js';
import { UsajobsAgent } from './agents/usajobs.js';
import { Page } from './driver/page.js';
import { scoreJob } from './agents/scorer.js';

const { BACKEND, headers: apiHeaders, checkLicense, askAssistant, claimSetup, sendSetupCode } = require('./shims/llm.js');
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
const SETUP_URL = 'https://tryjobai.com/start?from=extension';
const openTab = (u) => { const s = safeUrl(u); if (s) chrome.tabs.create({ url: s }); };

// This install's device id (random, stays on this device). Sent with licence checks like the app.
async function deviceId() {
  let d = await store.get('device');
  if (!d || !d.id) { d = { id: 'ext-' + crypto.randomUUID() }; await store.set('device', d); }
  return d.id;
}

// Load everything the agents need from local storage.
// ── Region (UK / USA), same as the app ───────────────────────────────────────
// USA hides the NHS and Universal Credit cards,
// says "resume" not "CV" and shows dollar prices. First run picks it from the timezone.
const tzLooksUS = () => { try { return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').startsWith('America/'); } catch (_) { return false; } };
const isUS = (settings) => (settings && settings.region) === 'us';
// US states for the setup's State field.
const US_STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
function usStateOf(text) {
  const t = String(text || '');
  const code = (t.match(/,\s*([A-Z]{2})\b/g) || []).map((m) => m.replace(/[^A-Z]/g, '')).find((c) => US_STATE_NAMES[c]);
  if (code) return code;
  const hit = Object.entries(US_STATE_NAMES).sort((a, b) => b[1].length - a[1].length).find(([, n]) => new RegExp(`\\b${n}\\b`, 'i').test(t));
  return hit ? hit[0] : '';
}

async function setRegion(region) {
  await store.patch('settings', { region });
  const profile = await store.get('profile');
  const loc = (profile.searchLocation || '').trim();
  if (!loc || loc === 'United Kingdom' || loc === 'United States') await store.patch('profile', { searchLocation: region === 'us' ? 'United States' : 'United Kingdom' });
  applyRegionWording(region === 'us');
}
let regionWordingObs = null;
function usWord(t) {
  if (/\.(pdf|docx?|txt)\b/i.test(t)) return t;
  return t
    // UK-only sites in lists of agents/sites: US users only have LinkedIn + company sites.
    .replace(/NHS \(Trac\), Reed, LinkedIn and company/g, 'LinkedIn and company')
    .replace(/Reed, LinkedIn, NHS jobs \(through Trac\) and company/g, 'LinkedIn and company')
    .replace(/(the )?Reed, LinkedIn and company/g, (m, a) => (a || '') + 'LinkedIn and company')
    .replace(/\b4 Agents\b/g, '2 Agents')
    .replace(/\bCVs\b(?= [A-Z])/g, 'Resumes').replace(/\bCV\b(?= [A-Z])/g, 'Resume')
    .replace(/\bCVs\b/g, 'resumes').replace(/\bCV\b/g, 'resume')
    .replace(/(^|[.!?]\s+)resume/g, (m, a) => a + 'Resume').replace(/^([^A-Za-z]*)resume/, '$1Resume');
}
const US_WORD_HINT = /CV|Reed|4 Agents/;
function rewordTree(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('textarea,input,script,style,[contenteditable]')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (US_WORD_HINT.test(n.nodeValue)) { const v = usWord(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
  }
  if (root.querySelectorAll) root.querySelectorAll('[placeholder*="CV"],[title*="CV"]').forEach((el) => {
    for (const a of ['placeholder', 'title']) { const v = el.getAttribute(a); if (v && v.includes('CV')) el.setAttribute(a, usWord(v)); }
  });
}
function applyRegionWording(us) {
  if (regionWordingObs) { regionWordingObs.disconnect(); regionWordingObs = null; }
  if (!us) return;
  rewordTree(document.body);
  regionWordingObs = new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1) rewordTree(n);
      else if (n.nodeType === 3 && US_WORD_HINT.test(n.nodeValue)) n.nodeValue = usWord(n.nodeValue);
    }
  });
  regionWordingObs.observe(document.body, { childList: true, subtree: true });
}

async function loadConfig() {
  if (!(await store.get('settings')).region) await setRegion(tzLooksUS() ? 'us' : 'uk');
  const [license, profile, trac, settings] = await Promise.all([store.get('license'), store.get('profile'), store.get('trac'), store.get('settings')]);
  applyRegionWording(isUS(settings));
  applyExtraSites(settings);
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
// The shared agent code asks the user for things only a person may do (a "not a robot" box,
// a sign-in) with a [[JOBBOT_NOTIFY]] line. The app turns those into desktop alerts; here they
// go into the activity log, and the tab title flags it until the dashboard is looked at.
{
  const origLog = console.log.bind(console);
  console.log = (...a) => {
    origLog(...a);
    const m = String(a[0] || '').match(/\[\[JOBBOT_NOTIFY\]\]\s*(.*)/);
    if (!m) return;
    store.log('⚠ ' + m[1]);
    if (document.hidden) {
      const t = document.title;
      if (!/^\(!\)/.test(t)) document.title = '(!) ' + t;
      const back = () => { if (!document.hidden) { document.title = document.title.replace(/^\(!\) /, ''); document.removeEventListener('visibilitychange', back); } };
      document.addEventListener('visibilitychange', back);
    }
  };
}
const onChange = () => { if (current === 'dashboard') renderDashboard(); remoteNudge(); computerSync(); };
const agents = {
  trac: new TracAgent({ onChange }),
  reed: new ReedAgent({ onChange }),
  linkedin: new LinkedInAgent({ onChange }),
  indeed: new IndeedAgent({ onChange }),
  dice: new DiceAgent({ onChange }),
  wellfound: new WellfoundAgent({ onChange }),
  ats: new AtsAgent({ onChange }),
  usajobs: new UsajobsAgent({ onChange }),
};
const agent = agents.trac;
const AGENTS = [
  ['trac', 'Trac (NHS) Agent', 'https://apps.trac.jobs/', 'Sign in to Trac'],
  ['reed', 'Reed Agent', 'https://www.reed.co.uk/account/signin', 'Sign in to Reed'],
  ['linkedin', 'LinkedIn Agent', 'https://www.linkedin.com/login', 'Sign in to LinkedIn'],
  ['indeed', 'Indeed Agent', 'https://secure.indeed.com/auth', 'Sign in to Indeed'],
  ['dice', 'Dice Agent', 'https://www.dice.com/dashboard/login', 'Sign in to Dice'],
  ['wellfound', 'Wellfound Agent', 'https://wellfound.com/login', 'Sign in to Wellfound'],
  ['ats', 'Company Sites Agent', '', ''],
  ['usajobs', 'Federal Jobs Agent (USAJOBS)', '', ''],
];
// Extra job sites: off unless the user turns them on in Search Preferences, because each one
// applies through the user's own account on that site, signed in in this Chrome.
// UK: Reed. USA: Dice and Wellfound. LinkedIn in both. Indeed stays off for everyone: its
// Cloudflare check loops even when a person passes it. Same rule as the app (retired_agents.js).
const EXTRA_SITES = [['reed', 'Reed', 'uk'], ['linkedin', 'LinkedIn', 'both'], ['dice', 'Dice', 'us'], ['wellfound', 'Wellfound', 'us']];
const ALWAYS_OFF = ['indeed'];
const RETIRED = new Set(['reed', 'linkedin', 'indeed', 'dice', 'wellfound']);
const extraForRegion = (us) => EXTRA_SITES.filter(([, , r]) => r === 'both' || r === (us ? 'us' : 'uk'));
function applyExtraSites(settings) {
  const on = (settings && settings.extraSites) || {};
  const us = isUS(settings);
  RETIRED.clear();
  for (const k of ALWAYS_OFF) RETIRED.add(k);
  for (const [k, , r] of EXTRA_SITES) if (!on[k] || (r !== 'both' && r !== (us ? 'us' : 'uk'))) RETIRED.add(k);
}
// Company sites in both regions, NHS (Trac) in the UK for those who asked for it, plus any
// extra job sites the user turned on.
// Federal jobs (USAJOBS): USA users who chose them at setup, the way NHS works in the UK.
const inRegion = (k, us, nhs = true, fed = true) => !RETIRED.has(k) && !(k === 'trac' && (us || !nhs)) && !(k === 'usajobs' && (!us || !fed));
const anyRunning = () => Object.values(agents).some((a) => a.running);

// ── "Nothing sent yet" card ──────────────────────────────────────────────────
// When the user's own filters are skipping lots of jobs and nothing has gone out, name the
// filter and offer a one-tap fix. Widening puts those skipped jobs back in the queue.
const FILTER_FIXES = [
  { key: 'contract', test: /contract role|fixed-term/i, label: 'contract or fixed-term', button: 'Allow contract roles' },
  { key: 'part_time', test: /^part-time role/i, label: 'part-time', button: 'Allow part-time' },
  { key: 'worktype', test: /^work type \(/i, label: 'not remote', button: 'Allow hybrid and on-site' },
  { key: 'salary', test: /^below your salary expectation/i, label: 'below your minimum salary', button: 'Change my minimum salary' },
];
function filterHint(all, profile, settings) {
  const since = Date.now() - 2 * 864e5, week = Date.now() - 7 * 864e5;
  // Nothing sent in 2 days: any skips count. Jobs going out: only this week's, and a higher bar.
  const sent = all.some((j) => j.status === 'applied' && Date.parse(j.appliedAt || j.updatedAt || 0) >= since);
  if (Date.parse(settings.filterHintHiddenAt || 0) > Date.now() - 3 * 864e5) return null;
  const want = profile.employmentType && profile.employmentType.length ? profile.employmentType : ['full_time'];
  const wt = profile.workTypePriority && profile.workTypePriority.length ? profile.workTypePriority : ['remote', 'hybrid', 'onsite'];
  const open = (f) => !(f.key === 'contract' && want.includes('contract')) && !(f.key === 'part_time' && want.includes('part_time')) && !(f.key === 'worktype' && wt.length >= 3);
  const rows = FILTER_FIXES.filter(open).map((f) => ({ ...f, n: all.filter((j) => j.status === 'skipped' && f.test.test(j.reason || '') && (!sent || Date.parse(j.updatedAt || 0) >= week)).length })).filter((f) => f.n > 0);
  const total = rows.reduce((s, f) => s + f.n, 0);
  return total >= (sent ? 25 : 10) ? { total, sent, rows: rows.sort((a, b) => b.n - a.n).slice(0, 3) } : null;
}
function filterHintHtml(fh) {
  if (!fh) return '';
  const list = fh.rows.map((r) => `${r.n} ${r.label}`).join(', ');
  return `<div class="card filter-hint-card" style="border:1.5px solid var(--accent, #2563eb)">
    <h3 style="margin:0 0 4px;font-size:20px;text-transform:none;letter-spacing:-0.01em;color:var(--text, inherit)">Your settings skipped ${fh.total} jobs${fh.sent ? ' this week' : ''}</h3>
    <p class="card-hint" style="margin:0 0 12px">${fh.sent ? 'Applications are going out, but your settings are ruling out a lot of jobs.' : 'Nothing has been sent yet.'} Skipped: ${list}. If you would take any of these, allow them and Job-AI checks those jobs again.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${fh.rows.map((r) => `<button class="primary fh-fix" data-fix="${r.key}" style="margin:0;padding:10px 18px;font-size:14px;line-height:1.2;height:auto">${r.button}</button>`).join('')}<button class="secondary" id="fh-hide" style="margin:0;padding:10px 18px;font-size:14px;line-height:1.2;height:auto">Keep my settings</button></div></div>`;
}
async function widenFilter(key) {
  if (key === 'salary') return navigate('personal'); // the minimum salary field is on Your details
  const p = await store.get('profile');
  if (key === 'contract' || key === 'part_time') {
    const want = new Set(p.employmentType && p.employmentType.length ? p.employmentType : ['full_time']);
    want.add(key);
    await store.patch('profile', { employmentType: [...want] });
  } else if (key === 'worktype') await store.patch('profile', { workTypePriority: ['remote', 'hybrid', 'onsite'] });
  await loadConfig();
  const f = FILTER_FIXES.find((x) => x.key === key);
  // Only jobs whose advert was saved can be checked again; the agents re-run every filter on them.
  const again = (await store.jobs()).filter((j) => j.status === 'skipped' && f.test.test(j.reason || '') && j.description);
  for (const j of again) await store.updateJob(j.jobId, { status: 'pending', reason: null, retryCount: 0 });
  store.log(`Settings widened: ${again.length} skipped job(s) will be checked again.`);
  VIEWS.dashboard();
}

// ── Extra job sites: are you signed in? ─────────────────────────────────────
// Each extra site's card shows "Signed in" once Job-AI has seen you signed in there, so
// nobody is asked to sign in again for nothing. Checked in a minimised window now and then,
// and straight after you sign in from the card's button.
const SITE_AUTH = {
  reed: { url: 'https://www.reed.co.uk/', test: () => location.hostname === 'www.reed.co.uk' && !/login|signin|authentication/i.test(location.pathname) && !document.querySelector('a[href*="/account/signin" i], a[href*="secure.reed.co.uk/login" i]') && !!document.body && document.body.innerText.length > 200 },
  linkedin: { url: 'https://www.linkedin.com/feed/', test: () => location.hostname.endsWith('linkedin.com') && !/\/(login|checkpoint|uas|authwall|signup)/i.test(location.pathname) && location.pathname !== '/' && (/^\/feed/.test(location.pathname) || !!document.querySelector('[class*="global-nav"], [class*="feed-identity"]')) },
  dice: { url: 'https://www.dice.com/home/home-feed', test: () => {
    if (!/dice\.com/.test(location.href) || /\/dashboard\/login|\/login/.test(location.href)) return false;
    const words = [...document.querySelectorAll('header a, header button, nav a, nav button')].map((e) => (e.innerText || '').trim().toLowerCase());
    if (words.includes('login') || words.includes('log in') || words.includes('sign in')) return false;
    return !!document.querySelector('a[href*="/dashboard/profile"], a[href*="/logout"], [data-testid*="avatar" i], [aria-label*="profile" i], [aria-label*="account" i]') || words.some((w) => /log ?out|sign ?out|profile|my jobs/.test(w));
  } },
  wellfound: { url: 'https://wellfound.com/jobs', test: () => {
    if (!/wellfound\.com/.test(location.href) || /\/login|\/join/.test(location.href)) return false;
    const words = [...document.querySelectorAll('a, button')].filter((e) => e.offsetParent !== null).map((e) => (e.innerText || '').trim().toLowerCase());
    if (words.includes('log in') || words.includes('login')) return false;
    return words.includes('applied') || words.includes('messages') || !!document.querySelector('a[href*="/profile/edit"]');
  } },
};
const authPause = (ms) => new Promise((r) => setTimeout(r, ms));
async function siteAuthState() { return (await store.get('siteAuth')) || {}; }
async function saveSiteAuth(site, ok) {
  const all = await siteAuthState();
  if (all[site] && all[site].ok === ok) all[site].at = Date.now(); else all[site] = { ok, at: Date.now() };
  await store.set('siteAuth', all);
}
async function signedInOnTab(tabId, site) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: SITE_AUTH[site].test });
    return !!(r && r.result);
  } catch { return false; }
}
function tabLoaded(tabId, ms) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(v); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete' && t.url && !t.url.startsWith('about:')) done(true); }).catch(() => done(false));
  });
}
const probing = new Set();
// Quiet check in a minimised window: true / false, or null if it couldn't tell.
async function probeSite(site) {
  if (!SITE_AUTH[site] || probing.has(site)) return null;
  probing.add(site);
  let win;
  try {
    win = await chrome.windows.create({ url: SITE_AUTH[site].url, state: 'minimized', focused: false });
    const tabId = win.tabs[0].id;
    await tabLoaded(tabId, 25000);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) { await authPause(1500); ok = await signedInOnTab(tabId, site); }
    await saveSiteAuth(site, ok);
    return ok;
  } catch { return null; } finally {
    probing.delete(site);
    if (win) chrome.windows.remove(win.id).catch(() => {});
  }
}
// The card's Sign in button: open the site, notice when the person is signed in, close
// the tab and come back to Job-AI. Gives up after 15 minutes or if they close the tab.
async function signInAndWatch(site, url) {
  const me = await chrome.tabs.getCurrent().catch(() => null);
  const tab = await chrome.tabs.create({ url, active: true });
  return new Promise((resolve) => {
    let busy = false, finished = false;
    const finish = (v) => { if (finished) return; finished = true; clearInterval(poll); chrome.tabs.onUpdated.removeListener(onUpd); chrome.tabs.onRemoved.removeListener(onGone); resolve(v); };
    const check = async () => {
      if (busy || finished) return;
      busy = true; await authPause(1200);
      const ok = await signedInOnTab(tab.id, site);
      busy = false;
      if (ok && !finished) {
        await saveSiteAuth(site, true);
        chrome.tabs.remove(tab.id).catch(() => {});
        if (me) chrome.tabs.update(me.id, { active: true }).catch(() => {});
        finish(true);
        if (current === 'dashboard') VIEWS.dashboard();
      }
    };
    const onUpd = (id, info) => { if (id === tab.id && info.status === 'complete') check(); };
    const onGone = (id) => { if (id === tab.id) finish(false); };
    const until = Date.now() + 15 * 60 * 1000;
    const poll = setInterval(() => { if (Date.now() > until) finish(false); else check(); }, 4000);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onGone);
  });
}
// The agents report what they found when they check sign-in (agents/base.js).
globalThis.__jobaiSiteAuth = async (site, ok) => {
  if (!SITE_AUTH[site]) return;
  const before = (await siteAuthState())[site];
  await saveSiteAuth(site, ok);
  if ((!before || before.ok !== ok) && current === 'dashboard') VIEWS.dashboard();
};
// ── Setup-step beacon ───────────────────────────────────────────────────────
// Where new users stall before their first application (activated, CV added, job
// site signed in, agents started, first application). Anonymous: this install's
// random device id plus the step name, each step sent once. Same as the app.
const SETUP_BACKEND = 'https://api.tryjobai.com';
async function sendStep(step) {
  // Test builds and automated browsers (CI, screen recordings) must not count as real users.
  if (process.env.JOBAI_TEST === '1' || navigator.webdriver) return;
  try {
    const sent = (await store.get('stepsSent')) || [];
    if (sent.includes(step)) return;
    const r = await fetch(`${SETUP_BACKEND}/v1/telemetry/step`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_id: await deviceId(), step, client: 'extension', version: chrome.runtime.getManifest().version }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) await store.set('stepsSent', [...new Set([...((await store.get('stepsSent')) || []), step])]);
  } catch (_) {}
}
globalThis.__jobaiStep = sendStep;
// How each company-site job ended (sent, skipped and why, or waiting), so we can see what
// "Fully automatic" gives up. Anonymous: the random device id, the site type and the result.
globalThis.__jobaiOutcome = async (ats, kind) => {
  try {
    await fetch(`${SETUP_BACKEND}/v1/telemetry/outcome`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ install_id: await deviceId(), ats, kind }), signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}
};
async function checkSteps() {
  try {
    if (licenceActive(await store.get('license'))) sendStep('activated');
    const cv = await store.get('cv');
    if (cv && cv.text) sendStep('cv_added');
    if ((await store.jobs()).some((j) => j.status === 'applied')) sendStep('first_applied');
  } catch (_) {}
}
sendStep('opened');
checkSteps();
setInterval(checkSteps, 5 * 60 * 1000);

// start() resolves when the agent has fully stopped; kept so an update can wait for it.
// A restart waits for the previous run to finish its step, so two runs never overlap.
function runAgent(key) {
  if (RETIRED.has(key)) return; // retired sign-in agent: never started from any path
  const a = agents[key]; const prev = a.loop;
  a.loop = (async () => { if (prev) await prev.catch(() => {}); return a.start(); })();
  sendStep('agents_started');
}
// Switched UK <-> USA: the job sites there that need the user's own account are off by default,
// so offer them once per region instead of leaving them hidden in Search Preferences.
async function regionSitesPrompt(us) {
  const key = us ? 'us' : 'uk';
  const settings = await store.get('settings');
  if ((settings.regionPromptSeen || {})[key] || $('#region-prompt')) return;
  const on = settings.extraSites || {}, F = settings.federal || {};
  const rows = [
    ...extraForRegion(us).map(([k, l]) => [k, l, `Needs your own ${l} account.${k === 'linkedin' ? ' LinkedIn can limit accounts it thinks are automated, so keep your daily limit low.' : ''}`, !!on[k]]),
    us ? ['federal', 'Federal government jobs', 'Needs a USAJOBS account (you sign in with Login.gov). Job-AI writes the resume, you apply there yourself.', !!settings.wantsFederal]
       : ['nhs', 'NHS jobs', 'Needs a Trac account.', !!settings.wantsNhs],
  ];
  const o = document.createElement('div'); o.id = 'region-prompt';
  o.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:24px';
  o.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#1c1b17);max-width:520px;width:100%;max-height:86vh;overflow:auto;border-radius:12px;padding:22px 24px">
    <h3 style="margin:0 0 6px;font-size:20px;text-transform:none;letter-spacing:-0.01em">More job sites in the ${us ? 'USA' : 'UK'}</h3>
    <p style="margin:0 0 14px;color:var(--text-muted,#4a453b);font-size:14px">Job-AI applies on employers' own websites for you. It can also use these if you have an account there. Tick any you want.</p>
    ${rows.map(([k, l, note, c]) => `<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;cursor:pointer"><input type="checkbox" class="rp-site" value="${k}" ${c ? 'checked' : ''} style="flex:0 0 16px;width:16px;height:16px;min-width:16px;max-width:16px;margin:3px 0 0;padding:0;accent-color:var(--primary,#3b82f6)"><span><strong>${esc(l)}</strong><br><small style="color:var(--text-muted,#4a453b)">${esc(note)}</small></span></label>`).join('')}
    <div id="rp-fed" style="display:none;grid-template-columns:1fr 1fr;gap:0 10px;margin:-4px 0 10px 26px">
      <div class="field" style="margin-bottom:8px"><label for="rp-cit">Are you a U.S. citizen?</label><select id="rp-cit"><option value="">Choose</option><option value="yes" ${F.usCitizen === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${F.usCitizen === 'no' ? 'selected' : ''}>No</option></select></div>
      <div class="field" style="margin-bottom:8px"><label for="rp-hrs">Hours per week in your jobs</label><input id="rp-hrs" type="number" min="1" max="80" value="${esc(F.hoursPerWeek || 40)}"></div></div>
    <div class="status-msg" id="rp-st" style="margin:0 0 8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center"><button class="secondary" id="rp-no" style="margin:0;padding:10px 18px;line-height:1.2;height:auto">Not now</button><button class="primary" id="rp-yes" style="margin:0;padding:10px 18px;line-height:1.2;height:auto">Turn on</button></div></div>`;
  document.body.appendChild(o);
  const fedBox = o.querySelector('.rp-site[value="federal"]');
  const fedQ = () => { $('#rp-fed').style.display = fedBox && fedBox.checked ? 'grid' : 'none'; };
  if (fedBox) { fedBox.addEventListener('change', fedQ); fedQ(); }
  const seen = async () => store.patch('settings', { regionPromptSeen: { ...((await store.get('settings')).regionPromptSeen || {}), [key]: true } });
  $('#rp-no').addEventListener('click', async () => { await seen(); o.remove(); });
  $('#rp-yes').addEventListener('click', async () => {
    const picked = new Set($$('.rp-site:checked').map((c) => c.value));
    if (picked.has('federal') && !$('#rp-cit').value) { setSt('#rp-st', 'Please say if you are a U.S. citizen. Most federal jobs need it.', true); return; }
    const cur = await store.get('settings');
    const extraSites = { ...(cur.extraSites || {}) };
    for (const [k] of extraForRegion(us)) extraSites[k] = picked.has(k);
    const patch = { extraSites };
    if (us) { patch.wantsFederal = picked.has('federal'); if (picked.has('federal')) patch.federal = { ...(cur.federal || {}), usCitizen: $('#rp-cit').value, hoursPerWeek: Math.min(80, Math.max(1, parseInt($('#rp-hrs').value, 10) || 40)) }; }
    else patch.wantsNhs = picked.has('nhs');
    await store.patch('settings', patch);
    await seen(); o.remove();
    await loadConfig();
    // NHS needs its details page filled in before the agent can run.
    if (!us && picked.has('nhs') && !cur.wantsNhs) navigate('trac-details'); else renderDashboard();
  });
}

// Live company-site jobs that fit the user's job titles, for the first-win prompt (30 min cache).
let fwCache = null;
async function firstWinCount(us) {
  const key = (us ? 'US' : 'GB') + '|' + (cfg.JOB_SEARCHES || []).join(',');
  if (fwCache && fwCache.key === key && Date.now() - fwCache.at < 30 * 60 * 1000) return fwCache.n;
  try {
    const titleMatch = require('../../bot/modules/title_match');
    const m = titleMatch.compile(cfg.JOB_SEARCHES || []);
    const n = (await feedJobs(us ? 'US' : 'GB')).filter((j) => titleMatch.titleMatches(j.title, m)).length;
    fwCache = { key, n, at: Date.now() };
    return n;
  } catch (_) { return 0; }
}
async function startAgent(key) {
  if (!(await recheckLicence())) { navigate('license'); return; }
  runAgent(key);
  setTimeout(renderDashboard, 300);
}

// ── Extension updates ───────────────────────────────────────────────────────
// background.js flags a waiting update. Apply it at a safe moment: every agent finishes the
// step it's on (never mid-application), then the extension reloads into the new version and
// the agents that were running start again.
let updating = false;
async function applyPendingUpdate() {
  if (updating) return;
  const { updatePending } = await chrome.storage.local.get('updatePending');
  if (!updatePending) return;
  updating = true;
  const wasRunning = Object.keys(agents).filter((k) => agents[k].running);
  if (wasRunning.length) store.log(`Job-AI ${updatePending} is ready. Finishing the current step, then updating.`);
  Object.values(agents).forEach((a) => a.stop());
  await Promise.all(Object.values(agents).map((a) => a.loop).filter(Boolean));
  await chrome.storage.local.set({ resumeAfterUpdate: { agents: wasRunning, at: Date.now() } });
  await chrome.storage.local.remove('updatePending');
  chrome.runtime.reload();
}
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.updatePending && c.updatePending.newValue) applyPendingUpdate(); });
applyPendingUpdate();

// ── This computer: keep awake while agents run, open when Chrome starts ──────────
// Keep awake is on unless the user turns it off. The agents running right now are remembered
// (closing the tab or Chrome keeps the list), so a Chrome start can carry on with them.
let awakeHeld = false, lastRunning = null;
async function computerSync() {
  const s = await store.get('settings');
  const running = Object.keys(agents).filter((k) => agents[k].running);
  const want = running.length > 0 && s.keepAwake !== false;
  if (want !== awakeHeld && chrome.power) { awakeHeld = want; if (want) chrome.power.requestKeepAwake('system'); else chrome.power.releaseKeepAwake(); }
  if (!updating && running.join() !== lastRunning) { lastRunning = running.join(); await chrome.storage.local.set({ runningAgents: running }); }
}
let startupResumed = false;
async function resumeAfterChromeStart() {
  const { startupOpen, runningAgents } = await chrome.storage.local.get(['startupOpen', 'runningAgents']);
  if (!startupOpen || startupResumed) return;
  startupResumed = true;
  await chrome.storage.local.remove('startupOpen');
  if (Date.now() - startupOpen > 10 * 60 * 1000 || !(runningAgents || []).length || anyRunning()) return;
  if (!(await recheckLicence())) return;
  runningAgents.filter((k) => agents[k]).forEach(runAgent);
  store.log('Chrome started: your agents carry on.');
  setTimeout(renderDashboard, 300);
}
// Chrome may restore this tab before it says it has started, so also listen for the signal.
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.startupOpen && c.startupOpen.newValue) resumeAfterChromeStart(); });
setTimeout(resumeAfterChromeStart, 2000);

// One time: the Search page used to fill in 70% for everyone, so a saved 70 is almost always that
// default, not a choice. Clear it so the extension follows the app's rule (45% floor, no minimum).
(async () => {
  const s = await store.get('settings');
  if (s.minScoreReset) return;
  const p = await store.get('profile');
  if (Number(p.minScore) === 70 || !Number(p.minScore)) {
    if (Number(p.minScore) === 70) await store.patch('profile', { minScore: null });
    // Jobs skipped only for missing that old 70% go back in the queue (the 45% floor still applies).
    for (const j of await store.jobs()) {
      if (j.status === 'skipped' && /\(you need 70%\)$/.test(j.reason || '') && Number(j.cvScore) >= 45) await store.updateJob(j.jobId, { status: 'pending', reason: '' });
    }
  }
  await store.patch('settings', { minScoreReset: true });
  loadConfig().catch(() => {});
})();

// One time: the match check now looks at the advert's must-haves only. Jobs from the last two
// weeks skipped under the old 45% rule get checked again (one AI call each).
(async () => {
  const s = await store.get('settings');
  if (s.matchLevelRecheck) return;
  const since = Date.now() - 14 * 864e5;
  for (const j of await store.jobs()) {
    if (j.status === 'skipped' && /^Not a close enough match \(\d+%\)$/.test(j.reason || '') && Number(j.cvScore) >= 20 && Date.parse(j.updatedAt || 0) >= since) await store.updateJob(j.jobId, { status: 'pending', reason: '', retryCount: 0 });
  }
  await store.patch('settings', { matchLevelRecheck: true });
})();

// Just updated: restart the agents that were running before it.
(async () => {
  const { resumeAfterUpdate: r } = await chrome.storage.local.get('resumeAfterUpdate');
  if (!r) return;
  await chrome.storage.local.remove('resumeAfterUpdate');
  store.log(`Updated to Job-AI ${chrome.runtime.getManifest().version}.`);
  if (Date.now() - r.at > 10 * 60 * 1000 || !(r.agents || []).length) return;
  if (!(await recheckLicence())) return;
  r.agents.forEach(runAgent);
  store.log('Agents started again after the update.');
  setTimeout(renderDashboard, 300);
})();
// Stop everything if the licence ends while agents are running (checked every 30 minutes).
setInterval(async () => { if (anyRunning() && !(await recheckLicence())) { Object.values(agents).forEach((a) => a.stop()); store.log('Licence is no longer active. Agents stopped.'); } }, 30 * 60 * 1000);

// Keep this tab around while agents run.
chrome.tabs.getCurrent().then((t) => { if (t) chrome.tabs.update(t.id, { pinned: true }).catch(() => {}); });
window.addEventListener('beforeunload', (e) => { if (anyRunning()) { e.preventDefault(); e.returnValue = ''; } });

// ── Navigation (top tabs + Setup menu, like the app) ─────────────────────────
let current = 'dashboard';
const VIEWS = {};
// Label the user's own detail boxes so Chrome can autofill them from the person's
// saved name and addresses, and offer what they already gave Job-AI elsewhere
// (Personal Details <-> NHS form). Referee boxes are left alone.
const AUTOFILL_KEYS = {
  'p-in': { firstName: 'given-name', lastName: 'family-name', email: 'email', phone: 'tel', location: 'address-level2', linkedin: 'url' },
  't-text': { firstName: 'given-name', middleName: 'additional-name', lastName: 'family-name', email: 'email', mobile: 'tel', address: 'address-line1', city: 'address-level2', county: 'address-level1', postcode: 'postal-code', country: 'country-name' },
};
// The setup check step's boxes, by id.
const SETUP_AUTOFILL = { 'wc-first': 'given-name', 'wc-last': 'family-name', 'wc-phone': 'tel', 'wc-street': 'address-line1', 'wc-town': 'address-level2', 'wc-postcode': 'postal-code' };
async function attachAutofill() {
  const P = (await store.get('profile')) || {}, T = (await store.get('trac')) || {};
  // The profile keeps the address as one line, "street, postcode".
  const addr = String(P.address || '').trim();
  const pc = (addr.match(PC_UK) || addr.match(ZIP_US) || [''])[0];
  const known = {
    'given-name': [P.firstName, T.firstName], 'additional-name': [T.middleName], 'family-name': [P.lastName, T.lastName],
    email: [P.email, T.email], tel: [P.phone, T.mobile], 'address-line1': [addr.replace(pc, '').replace(/[\s,]+$/, ''), T.address],
    'address-level2': [P.location, String(P.location || '').split(',')[0], T.city], 'address-level1': [T.county], 'postal-code': [pc.toUpperCase(), T.postcode],
    'country-name': [T.country], url: [P.linkedin],
  };
  const attach = (el, kind, listId) => {
    el.setAttribute('autocomplete', kind);
    el.setAttribute('name', kind);
    const values = [...new Set((known[kind] || []).map((v) => String(v || '').trim()).filter(Boolean))];
    if (!values.length) return;
    let dl = document.getElementById(listId);
    if (!dl) { dl = document.createElement('datalist'); dl.id = listId; el.after(dl); }
    dl.innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join('');
    el.setAttribute('list', listId);
  };
  for (const [cls, keys] of Object.entries(AUTOFILL_KEYS)) {
    for (const el of $$('input.' + cls)) if (keys[el.dataset.k]) attach(el, keys[el.dataset.k], 'af-' + cls + '-' + el.dataset.k);
  }
  for (const [id, kind] of Object.entries(SETUP_AUTOFILL)) { const el = document.getElementById(id); if (el) attach(el, kind, 'af-' + id); }
}

function navigate(v) {
  if (!VIEWS[v]) v = 'dashboard';
  current = v;
  content.dataset.ok = '1';
  $$('#nav .tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('#nav-setup .setup-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#setup-label').classList.toggle('active', $$('#nav-setup .setup-item').some((b) => b.dataset.view === v));
  window.scrollTo(0, 0);
  return Promise.resolve(VIEWS[v]()).then((r) => { attachAutofill().catch(() => {}); return r; });
}
$$('#nav .tab, #nav-setup .setup-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
$('#setup-label').addEventListener('click', (e) => { e.stopPropagation(); $('#setup-menu').classList.toggle('open'); });
$('#setup-pop').addEventListener('click', () => $('#setup-menu').classList.remove('open'));
document.addEventListener('click', () => $('#setup-menu').classList.remove('open'));
$('#tn-help').addEventListener('click', () => navigate('help'));
const setSt = (id, msg, err) => { const el = $(id); if (!el) return; el.textContent = msg; el.style.color = err ? 'var(--danger)' : 'var(--text-muted)'; };

// Pick a CV, save it, and let the AI fill any blank profile fields (never overwriting what the
// user typed) plus the search terms if there are none yet. done(msg) runs once it's saved.
const CV_FIELDS = [['firstName', 'First name'], ['middleName', null], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'], ['linkedin', 'LinkedIn'], ['yearsExperience', 'Years of experience']];
// Several CVs, like the app: the scorer tries each one and uses the best for every job. 'cv' stays
// the first one, which older code and the phone setup use.
async function getCvs() {
  const list = await store.get('cvs');
  if (Array.isArray(list) && list.some((c) => c && c.text)) return list.filter((c) => c && c.text);
  const cv = await store.get('cv');
  return cv && cv.text ? [{ id: 'cv1', label: 'Main CV', ...cv }] : [];
}
async function saveCvs(list) { await store.set('cvs', list); await store.set('cv', list[0] || null); }
async function fillFromCv(text, cvId) {
  const r = await readCvProfile(text);
  const { profile: P } = await loadConfig();
  const out = {}, filled = [];
  for (const [k, label] of CV_FIELDS) if (r[k] && !String(P[k] || '').trim()) { out[k] = r[k]; if (label) filled.push(label); }
  let termsAdded = 0;
  if (r.roles.length && !(P.searchTerms || []).length) { out.searchTerms = r.roles; termsAdded = r.roles.length; }
  if (Object.keys(out).length) { await store.patch('profile', out); await loadConfig(); }
  // Same as the app's CVs page: the job titles this CV fits, and its keywords, shown with the CV.
  const list = await getCvs();
  const i = Math.max(0, list.findIndex((c) => c.id === cvId));
  if (list[i]) { list[i] = { ...list[i], roles: r.roles || [], keywords: r.keywords || [] }; await saveCvs(list); }
  return { filled, termsAdded, roles: r.roles || [] };
}
// mode 'add' adds another CV (CVs page); otherwise the first CV is replaced.
function pickCv(stSel, done, mode, label) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf,.doc,.docx' });
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setSt(stSel, 'That file is over 10 MB. Please use a smaller CV.', true); return; }
    setSt(stSel, 'Reading your CV. This can take a minute…');
    try {
      const buf = await f.arrayBuffer();
      const text = await extractText(f);
      if (text.replace(/\s/g, '').length < 200) throw new Error('No readable text found. Is it a scanned image?');
      const list = await getCvs();
      const entry = { id: 'cv' + Date.now(), label: (label || '').trim() || (list.length && mode === 'add' ? f.name.replace(/\.[^.]+$/, '') : 'Main CV'), name: f.name, type: f.type, text, dataB64: toBase64(buf) };
      if (mode === 'add') list.push(entry); else list[0] = { ...entry, label: (list[0] && list[0].label) || entry.label };
      await saveCvs(list);
      checkSteps();
      let msg = 'Using: ' + f.name;
      try {
        const r = await fillFromCv(text, mode === 'add' ? entry.id : (list[0] && list[0].id));
        const parts = [];
        if (r.filled.length) parts.push(`Filled in from your CV: ${r.filled.join(', ')}.`);
        if (r.termsAdded) parts.push(`Added ${r.termsAdded} job titles to search for.`);
        else if (r.roles.length) parts.push(`Suggested ${r.roles.length} job titles that fit your CV. See them on the CVs page.`);
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
function buildApplicationsGraph(all, N = 14) {
  const applied = all.filter((j) => j.status === 'applied' && j.appliedAt);
  if (!applied.length) return '<div class="graph-empty">No applications recorded yet</div>';
  const W = 560, H = 80, PAD = 4, LABEL_TOP = 12, AXIS_BOTTOM = 16;
  const days = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000); const key = d.toISOString().slice(0, 10);
    days.push({ key, count: applied.filter((j) => String(j.appliedAt).startsWith(key)).length, label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
  }
  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const barW = Math.floor((W - PAD * 2) / N);
  const bars = days.map((d, i) => {
    const barH = Math.max(2, Math.round((d.count / maxCount) * (H - LABEL_TOP - AXIS_BOTTOM)));
    const x = PAD + i * barW; const y = H - AXIS_BOTTOM - barH;
    return `<rect x="${x}" y="${y}" width="${barW - 2}" height="${barH}" class="graph-bar${i === N - 1 ? ' graph-bar-today' : ''}" rx="2"><title>${d.label}: ${d.count} application${d.count !== 1 ? 's' : ''}</title></rect>${d.count > 0 ? `<text x="${x + (barW - 2) / 2}" y="${y - 2}" class="graph-label" text-anchor="middle">${d.count}</text>` : ''}`;
  });
  const labels = [0, Math.floor((N - 1) / 2), N - 1].map((i) => `<text x="${PAD + i * barW + (barW - 2) / 2}" y="${H}" class="graph-date" text-anchor="middle">${days[i].label}</text>`);
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
    // Federal jobs with their resume, waiting for the user to apply on USAJOBS. Closed ones drop off.
    const today = new Date().toISOString().slice(0, 10);
    for (const j of all.filter((x) => x.source === 'usajobs' && x.status === 'ready_to_submit' && x.closes && x.closes < today)) { j.status = 'skipped'; await store.updateJob(j.jobId, { status: 'skipped', reason: 'Closed before you applied' }); }
    // Strong matches first, then the soonest closing date.
    const fedReady = all.filter((j) => j.source === 'usajobs' && j.status === 'ready_to_submit').sort((a, b) => (((b.cvScore || 0) >= 60) - ((a.cvScore || 0) >= 60)) || String(a.closes || '9').localeCompare(String(b.closes || '9')));
    const fed = settings.federal || {};
    const applied = all.filter((j) => j.status === 'applied');
    const failed = all.filter((j) => j.status === 'apply_failed');
    const inQueue = all.filter((j) => ['pending', 'cv_ready', 'applying'].includes(j.status));
    const tailoring = all.some((j) => j.status === 'processing');
    const reviewing = all.filter((j) => j.status === 'awaiting_review');
    const fh = filterHint(all, profile, settings);
    const us = isUS(settings);
    const ucOn = !us && (profile.country || 'United Kingdom') === 'United Kingdom';
    const ucPending = all.filter((j) => j.status === 'applied' && !j.ucLoggedAt);
    const hasLicence = licenceActive(license);
    // Trial days left (null when not on a trial), and a trial or plan that has run out.
    const trialLeft = hasLicence && license.status === 'trial' && license.expiresAt ? Math.max(0, Math.ceil((new Date(license.expiresAt) - Date.now()) / 86400000)) : null;
    const ended = !hasLicence && !!license.key && license.status !== 'device_trial_used';
    const setupDone = {
      personal: !!(profile.firstName && profile.lastName && profile.email && profile.phone),
      cvs: !!(cv && cv.text),
      search: !!((profile.searchTerms || []).length),
      trac: !!((trac.employment || []).length && (trac.references || []).length && (trac.searchTerms || []).length),
    };
    const base = hasLicence && setupDone.cvs;
    const canRun = { trac: !us && base && setupDone.trac, reed: !us && base && setupDone.search, linkedin: base && setupDone.search, indeed: us && base && setupDone.search, dice: us && base && setupDone.search, wellfound: us && base && setupDone.search, ats: base && setupDone.search, usajobs: us && base && setupDone.search && !!settings.wantsFederal && !!(settings.federal || {}).usCitizen };
    for (const k of RETIRED) canRun[k] = false;
    const running = anyRunning();
    const hour = new Date().getHours();
    const name = profile.firstName || trac.firstName || '';
    const apps = [...needs, ...ready].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // "Submit for me" switches: NHS is off by default, company sites on by default.
    // NHS is opt-in: asked once at setup. Anyone who already gave Trac details keeps it.
    const wantsNhs = !!settings.wantsNhs || setupDone.trac;
    const nhsNav = $('#nav-setup [data-view="trac-details"]');
    if (nhsNav) nhsNav.style.display = us || !wantsNhs ? 'none' : '';
    // Federal jobs: chosen at setup by USA users, like NHS in the UK.
    const wantsFederal = us && !!settings.wantsFederal;
    const fedNav = $('#nav-setup [data-view="federal-details"]');
    if (fedNav) fedNav.style.display = wantsFederal ? '' : 'none';
    const submitOn = { trac: !!(settings.autoSubmit && settings.autoSubmit.trac), ats: !(settings.autoSubmit && settings.autoSubmit.ats === false) };
    // Finished NHS applications piling up with Submit for me off: offer to turn it on (also for
    // people already running Job-AI, not just at setup). Hidden for 3 days on "I'll do it".
    const submitOffer = !us && !submitOn.trac && ready.length >= 2 && Date.parse(settings.submitOfferHiddenAt || 0) < Date.now() - 3 * 864e5;
    const SUBMIT_HINT = {
      trac: (on) => on ? 'Complete applications are submitted automatically.' : 'Off: you check each application and press Submit on Trac.',
      ats: (on) => on ? 'Sends them for you. Any it can\'t send on its own, it skips and moves on to the next job.' : 'Off: each one waits under Ready to send for you to check and submit.',
    };
    // Which agents "Start applying" runs (tick box on each card, like the app). All ticked by default.
    const enabled = (k) => !settings.enabled || settings.enabled[k] !== false;
    const LABEL = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'Company sites', usajobs: 'Federal' };
    const bySource = Object.keys(LABEL).map((s) => [s, applied.filter((j) => j.source === s).length]).filter(([, n]) => n);
    // Many jobs skipped as not a close match this week: offer the Wider match level once.
    const weekAgo = Date.now() - 7 * 864e5;
    const tooFar = all.filter((j) => j.status === 'skipped' && /^Not a close enough match/.test(j.reason || '') && Date.parse(j.updatedAt || 0) >= weekAgo);
    const anyExtra = Object.values(settings.extraSites || {}).some(Boolean);
    const extraNotice = (await store.get('extraNotice')) === 'show' && !anyExtra;
    const offerWider = tooFar.length >= 8 && profile.matchLevel !== 'wide' && !settings.widerOfferOff;

    // Company sites: what to do with a job that needs a person. auto = skip it (only "Applied"
    // ever shows), assist = send the rest and bring those to the user, review = send nothing
    // until the user checks it (the old "Send for me" off).
    const atsMode = !submitOn.ats ? 'review' : settings.hardOnes ? 'assist' : 'auto';
    const ATS_MODES = [
      ['auto', 'Fully automatic', "You only see Applied. Jobs it can't finish on its own are skipped."],
      ['assist', 'Bring me the hard ones', 'Sends what it can. Ones that need you (a human check, an emailed code, a question) wait under Ready to send. Better odds, a few taps.'],
      ['review', 'Check every application', 'Nothing is sent until you check it and press Submit.'],
    ];
    const siteAuth = await siteAuthState();
    const card = ([key, label, url, signLabel]) => {
      const on = agents[key].running;
      const toggle = key === 'usajobs' ? `<div class="agent-submit-toggle" style="display:block"><small>Writes a 2-page federal resume for each job. You apply on USAJOBS with your own account.</small></div>` : key === 'ats' ? `<div class="agent-submit-toggle" style="display:block">
          <strong style="display:block;margin-bottom:6px">Jobs that need a person</strong>
          ${ATS_MODES.map(([v, t, hint]) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:0 0 6px;cursor:pointer;font-weight:400">
            <input type="radio" name="ats-mode" class="ats-mode" value="${v}" ${atsMode === v ? 'checked' : ''} style="width:auto;margin-top:3px">
            <span><strong>${t}</strong><br><small>${hint}</small></span></label>`).join('')}
        </div>` : key in submitOn ? `<label class="agent-submit-toggle">
          <input type="checkbox" class="auto" data-bot="${key}" ${submitOn[key] ? 'checked' : ''}>
          <span><strong>${key === 'ats' ? 'Send for me' : 'Submit for me'}</strong><br><small>${SUBMIT_HINT[key](submitOn[key])}</small></span>
        </label>` : '';
      return `<div class="card bot-card${on ? ' bot-card-running' : ''}" id="bot-card-${key}">
        <div class="bot-card-header">
          <label class="agent-run-toggle" title="Tick to run this agent when you press Start applying, untick to skip it">
            <input type="checkbox" class="agent-enabled" data-bot="${key}" ${enabled(key) ? 'checked' : ''}>
            <strong>${label}</strong>
          </label>
          <span class="bot-status bot-status-${on ? 'running' : 'stopped'}">${on ? 'running' : 'stopped'}</span>
        </div>
        <div class="agent-run-state ${on ? 'on' : 'off'}">${on ? '✓ Working in a separate minimised Chrome window' : !canRun[key] ? '○ Finish setup to use this agent' : enabled(key) ? '✓ Included, runs when you press Start applying' : '○ Unticked, this agent will be skipped'}</div>
        ${toggle}
        <div class="bot-card-actions">
          ${on ? `<button class="secondary stop" data-bot="${key}">Stop</button>` : `<button class="primary start" data-bot="${key}" ${canRun[key] ? '' : 'disabled'}>Start</button>`}
          ${url ? (SITE_AUTH[key] && siteAuth[key] && siteAuth[key].ok ? '<span class="site-signed-in" style="align-self:center;color:var(--success, #15803d);font-weight:600">✓ Signed in</span>' : `<button class="btn-connect signin" data-url="${url}" data-site="${SITE_AUTH[key] ? key : ''}" data-label="${esc(signLabel)}">${signLabel}</button>`) : ''}
        </div>
      </div>`;
    };

    content.innerHTML = `
      <div class="dash-head">
        <div>
          <h2 class="dash-greeting">Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}${name ? ', ' + esc(name) : ''}</h2>
          <p class="dash-sub">${running && !applied.length ? 'Working on your first application. It usually goes out within a few minutes. Keep this tab open.' : running ? 'Your agents are working. Keep this tab open.' : hasLicence ? 'Your agents are ready. Press Start applying.' : 'Monitor agent activity and track your application progress.'}</p>
          <div class="region-row"><span class="region-label">Find jobs in:</span>
            <div class="region-switch" role="group" aria-label="Find jobs in">
              <button class="region-opt${us ? '' : ' active'}" data-region="uk">UK</button>
              <button class="region-opt${us ? ' active' : ''}" data-region="us">USA</button>
            </div>
          </div>
        </div>
        <div class="dash-cta">
          <span class="scorer-pill${tailoring ? ' scorer-pill-active' : ''}" title="The AI tailors your CV while the agents work, so you don't start it yourself.">${tailoring ? '✨ AI tailoring active' : 'AI tailoring: idle'}</span>
          <button class="secondary stop-all-btn" id="stop-all" ${running ? '' : 'disabled'}>Stop</button>
          <button class="primary start-applying-btn" id="start-all" ${Object.keys(canRun).some((k) => canRun[k] && enabled(k)) ? '' : 'disabled'}>▶ Start applying</button>
        </div>
      </div>

      ${hasLicence ? (trialLeft !== null && trialLeft <= 3 ? `<div class="no-license-banner"><span>Your free trial ends ${trialLeft <= 1 ? 'today' : `in ${trialLeft} days`}.${applied.length ? ` Job-AI has sent ${applied.length} application${applied.length === 1 ? '' : 's'} for you so far.` : ''} Keep your agents applying, first month half price.</span><button class="no-license-cta" id="keep-jobai">Subscribe now →</button></div>` : '')
        : ended ? `<div class="card" style="border:1.5px solid var(--accent, #2563eb);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div><h3 style="margin:0 0 4px;font-size:20px;text-transform:none;letter-spacing:-0.01em;color:var(--text, inherit)">${applied.length ? `Job-AI sent ${applied.length} application${applied.length === 1 ? '' : 's'} for you` : 'Your free trial has ended'}</h3>
          <p class="card-hint" style="margin:0">${applied.length ? 'Your free trial has ended, so your agents have stopped.' : 'Your agents have stopped.'} Pick a plan and they start again straight away, up to 25 a day. Your first month is half price.</p></div>
          <button class="primary" id="keep-jobai">Keep Job-AI</button></div>`
        : `<div class="no-license-banner"><span>Set up Job-AI to run the Agents. Free for 24 hours, no card needed.</span><button class="no-license-cta" id="nl-setup">Set up Job-AI →</button></div>`}

      ${extraNotice ? `<div class="no-license-banner"><span><strong>New:</strong> Job-AI can now also apply on ${extraForRegion(us).map(([, l]) => l).join(us ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1')} if you have an account there. It still applies on employers' own websites as well.</span><span style="display:flex;gap:8px"><button class="no-license-cta" id="extra-yes">Turn on</button><button class="welcome-skip-link" id="extra-no">No thanks</button></span></div>` : ''}
      ${offerWider ? `<div class="no-license-banner"><span>${tooFar.length} jobs this week were skipped as not a close enough match. Try a wider match?</span><span style="display:flex;gap:8px"><button class="no-license-cta" id="wider-yes">Try Wider</button><button class="welcome-skip-link" id="wider-no">No thanks</button></span></div>` : ''}

      ${submitOffer ? `<div class="card" style="border:1.5px solid #16a34a">
        <h3 style="margin:0 0 4px;font-size:20px;text-transform:none;letter-spacing:-0.01em;color:var(--text, inherit)">${ready.length} NHS applications are finished and waiting</h3>
        <p class="card-hint" style="margin:0 0 12px">Each one is complete on Trac, but the employer only gets it once Submit is pressed. Turn on Submit for me and Job-AI will submit these for you, plus any others it finishes from now on. Applications that ask about AI use, or still need an answer from you, are always left for you.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="primary" id="so-yes" style="margin:0;padding:10px 18px;font-size:14px;line-height:1.2;height:auto">Submit them for me</button><button class="secondary" id="so-no" style="margin:0;padding:10px 18px;font-size:14px;line-height:1.2;height:auto">I'll submit them myself</button></div></div>` : ''}
      ${filterHintHtml(fh)}
      ${canRun.ats && !applied.length && !running ? `<div class="card first-win-card" style="border:1.5px solid var(--accent, #2563eb);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div><h3 style="margin:0 0 4px;font-size:20px;text-transform:none;letter-spacing:-0.01em;color:var(--text, inherit)" id="fw-count">Checking live jobs for you...</h3>
        <p class="card-hint" style="margin:0">Press start and Job-AI tailors your CV and sends your first application, usually within a few minutes.</p></div>
        <button class="primary" id="fw-start">▶ Send my first application</button>
      </div>` : ''}

      <div class="card get-started-card">
        <h3>How to start applying</h3>
        <ol class="get-started-steps">
          <li>${gsMark(setupDone.cvs, 1)}<span>Upload your CV. We fill in your details from it</span>${setupDone.cvs ? '<em class="gs-ok">Done</em>' : '<button class="preflight-link cv-fill-btn">Upload CV →</button>'}</li>
          <li>${gsMark(setupDone.personal, 2)}<span>Check your details</span>${setupDone.personal ? '<em class="gs-ok">Done</em>' : '<button class="preflight-link" data-view="personal">Check details →</button>'}</li>
          <li>${gsMark(running, 3)}<span>Click <strong>Start applying</strong>. Job-AI applies on employers' own websites, so there are no job site accounts to sign in to</span>${running ? '<em class="gs-ok">Applying…</em>' : ''}</li>
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
          ${us || !wantsNhs ? '' : `<button class="preflight-link${setupDone.trac ? ' is-done' : ''}" data-view="trac-details">${setupDone.trac ? '✓' : '🏥'} NHS / Trac details</button>`}
          ${wantsFederal ? `<button class="preflight-link${fed.usCitizen ? ' is-done' : ''}" data-view="federal-details">${fed.usCitizen ? '✓' : '🏛️'} Federal jobs details</button>` : ''}
          <button class="preflight-link${hasLicence ? ' is-done' : ''}" data-view="license">${hasLicence ? '✓' : '🔑'} License</button>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card applied"><div class="num">${applied.length}</div><div class="label">Applied</div><div class="sub">${esc(bySource.map(([s, n]) => `${LABEL[s]} ${n}`).join(' · '))}</div></div>
        <div class="summary-card pending"><div class="num">${inQueue.length}</div><div class="label">In queue</div></div>
        ${ready.length + waiting.length + fedReady.length ? `<div class="summary-card ready"><div class="num">${ready.length + waiting.length + fedReady.length}</div><div class="label">Ready to submit</div></div>` : ''}
        <div class="summary-card apply_failed"><div class="num">${needs.length + failed.length}</div><div class="label">Needs attention</div></div>
      </div>

      ${waiting.length ? `<div class="card card-wide nhs-apps-card">
        <h3 style="margin:0 0 4px">Ready to send (${waiting.length})</h3>
        <p class="nhs-apps-hint">These need you for one step. Most are already filled in: press Open, do that step, then press Submit.</p>
        ${waiting.map((a) => { const why = String(a.reason || '').split(' Ready for you:')[0]; return `<div class="nhs-app"><div class="nhs-app-main"><div class="nhs-app-title">${esc(a.title)}</div><div class="nhs-app-meta">${esc(a.company || '')}</div>${why && !/^(Ready for you:|Filled in\.)/.test(why) ? `<div class="nhs-app-missing">${esc(why)}</div>` : ''}</div><span class="badge badge-success">Ready to send</span><div class="nhs-app-actions"><button class="primary fill-open" data-id="${esc(a.jobId)}" data-label="${a.heldTabId ? 'Open' : 'Fill and open'}">${a.heldTabId ? 'Open' : 'Fill and open'}</button><button class="secondary mark-sent" data-id="${esc(a.jobId)}">I sent it</button><button class="secondary skip-send" data-id="${esc(a.jobId)}">Skip</button></div></div>`; }).join('')}
      </div>` : ''}

      ${fedReady.length ? `<div class="card card-wide nhs-apps-card">
        <h3 style="margin:0 0 4px">Federal jobs ready (${fedReady.length})</h3>
        <p class="nhs-apps-hint">Each has a federal resume made for it. Download the resume, press Apply on USAJOBS, upload it there and answer the questions. Job-AI never applies for you here.</p>
        ${fedReady.map((a) => `<div class="nhs-app"><div class="nhs-app-main"><div class="nhs-app-title">${esc(a.title)}</div><div class="nhs-app-meta">${esc([a.company, a.location, a.grade, a.pay, a.closes ? 'closes ' + new Date(a.closes + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''].filter(Boolean).join(' · '))}</div>${/^Before you upload|clearance/.test(a.reason || '') ? `<div class="nhs-app-missing">${esc(String(a.reason).replace(/^Federal resume ready\. Apply on USAJOBS\.\s*/, ''))}</div>` : ''}</div><span class="badge ${(a.cvScore || 0) >= 60 ? 'badge-success' : 'badge-muted'}">${(a.cvScore || 0) >= 60 ? 'Strong match' : 'Worth a look'}</span><div class="nhs-app-actions"><button class="secondary fed-help" data-id="${esc(a.jobId)}">Help me answer</button><button class="secondary fed-dl" data-id="${esc(a.jobId)}">Download resume</button><button class="primary fed-open" data-url="${esc(safeUrl(a.url) || '')}">Apply on USAJOBS</button><button class="secondary fed-done" data-id="${esc(a.jobId)}">I applied</button><button class="secondary skip-send" data-id="${esc(a.jobId)}">Skip</button></div></div>`).join('')}
      </div>` : ''}

      ${apps.length ? `<div class="card card-wide nhs-apps-card">
        <h3 style="margin:0 0 4px">NHS applications</h3>
        <p class="nhs-apps-hint">Opens on Trac in a normal tab. Sign in there if asked.</p>
        ${apps.map((a, i) => appRow(a, i)).join('')}
      </div>` : ''}

      <div class="dash-cols">
        <div class="dash-col-main">
          <div class="dash-col-title">Your agents</div>
          <p class="bot-controls-hint">Tick the agents you want, then press <strong>Start applying</strong>. Or start one on its own card.</p>
          <div class="bot-controls">${AGENTS.filter(([k]) => inRegion(k, us, wantsNhs, wantsFederal)).map(card).join('')}</div>
        </div>
        <div class="dash-col-side">
          <div class="dash-col-title">Applications (last 14 days)</div>
          <div class="card dash-applications-card">${buildApplicationsGraph(all)}</div>
          <div class="dash-col-title" style="margin-top:18px">This computer</div>
          <div class="card computer-card">
            <label class="checkbox-label" style="align-items:flex-start;margin:0 0 12px"><input type="checkbox" class="pc" data-k="keepAwake" ${settings.keepAwake !== false ? 'checked' : ''}><span><strong>Keep awake while agents run</strong><br><small class="muted">Your computer will not go to sleep mid-application. A closed laptop lid still sleeps.</small></span></label>
            <label class="checkbox-label" style="align-items:flex-start;margin:0"><input type="checkbox" class="pc" data-k="openOnStartup" ${settings.openOnStartup ? 'checked' : ''}><span><strong>Open when Chrome starts</strong><br><small class="muted">Job-AI opens in a pinned tab and carries on applying.</small></span></label>
          </div>
        </div>
      </div>
      ${reviewing.length ? `<div class="card card-wide"><h3 style="margin:0 0 4px">Review before applying</h3>
        <p class="nhs-apps-hint">Check each tailored CV and cover letter, then approve it to apply or skip it.</p>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>Job</th><th>Company</th><th>Match</th><th></th><th></th></tr></thead><tbody>
        ${reviewing.map((j) => `<tr><td>${esc(j.title)}</td><td>${esc(j.company || '')}</td><td>${esc(j.cvScore != null ? j.cvScore + '%' : '')}</td><td class="row-actions">${docButtons(j)}</td>
          <td><div class="ext-inline"><button class="primary rv-ok" data-id="${esc(j.jobId)}">Approve</button><button class="secondary rv-skip" data-id="${esc(j.jobId)}">Skip</button></div></td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      ${ucOn ? `<div class="card bot-card uc-card"><div class="bot-card-header"><strong>📋 Universal Credit journal</strong></div>
        <p style="font-size:13px;color:var(--text-muted);margin:6px 0 12px">Keeps a running log of every job Job-AI has applied to, each with the real date, ready to add to your Universal Credit "log your work search" journal. ${ucPending.length ? `<strong>${ucPending.length}</strong> application${ucPending.length === 1 ? '' : 's'} ready to log.` : 'Your journal is up to date.'}</p>
        <div class="bot-card-actions"><button class="primary" id="uc-copy" ${ucPending.length ? '' : 'disabled'}>View / copy my work search log</button></div></div>` : ''}
      ${us ? `<div class="card bot-card wsl-card"><div class="bot-card-header"><strong>📋 Work search log</strong></div>
        <p style="font-size:13px;color:var(--text-muted);margin:6px 0 12px">Unemployment benefits ask for work search contacts each week. Job-AI logs every job it really applied to, with the real date, ready for your state's weekly form. <strong>${wslByWeek(all.filter((j) => j.status === 'applied')).filter((w) => w.start === wslWeekStart(new Date()).getTime()).reduce((n, w) => n + w.rows.length, 0)}</strong> this week.</p>
        <div class="bot-card-actions"><button class="primary" id="wsl-open">View my work search log</button></div></div>` : ''}
      ${recentHtml(all, settings.recentClearedAt)}`;

    $$('.start').forEach((b) => b.addEventListener('click', () => startAgent(b.dataset.bot)));
    $$('.rv-ok').forEach((b) => b.addEventListener('click', async () => { await store.updateJob(b.dataset.id, { status: 'cv_ready' }); renderDashboard(); }));
    $$('.rv-skip').forEach((b) => b.addEventListener('click', async () => { await store.updateJob(b.dataset.id, { status: 'skipped', reason: 'Skipped in review' }); renderDashboard(); }));
    $('#uc-copy')?.addEventListener('click', () => showUcLog(ucPending));
    $('#wsl-open')?.addEventListener('click', () => showWorkSearchLog(all.filter((j) => j.status === 'applied')));
    $('#recent-clear')?.addEventListener('click', async () => { await store.patch('settings', { recentClearedAt: new Date().toISOString() }); renderDashboard(); });
    $$('.stop').forEach((b) => b.addEventListener('click', () => { agents[b.dataset.bot].stop(); renderDashboard(); }));
    $('#start-all').addEventListener('click', async () => {
      if (!(await recheckLicence())) { navigate('license'); return; }
      for (const k of Object.keys(agents)) if (canRun[k] && enabled(k) && !agents[k].running) runAgent(k);
      setTimeout(renderDashboard, 300);
    });
    $('#stop-all').addEventListener('click', () => { Object.values(agents).forEach((a) => a.stop()); renderDashboard(); });
    $('#fw-start')?.addEventListener('click', () => $('#start-all').click());
    if ($('#fw-count')) firstWinCount(us).then((n) => { const h = $('#fw-count'); if (h) h.textContent = n ? `${n >= 50 ? '50+' : n} live job${n === 1 ? '' : 's'} fit you right now` : 'Your agents are ready to find jobs for you'; });
    $$('.region-opt').forEach((b) => b.addEventListener('click', async () => {
      if (b.classList.contains('active')) return;
      // UK-only agents can't keep running once their cards are hidden.
      for (const k of Object.keys(agents)) if (!inRegion(k, b.dataset.region === 'us')) agents[k].stop();
      await setRegion(b.dataset.region); renderDashboard();
      regionSitesPrompt(b.dataset.region === 'us');
    }));
    $$('.preflight-link[data-view]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
    $$('.cv-fill-btn').forEach((b) => b.addEventListener('click', () => pickCv('#gs-cv-st', cvToPersonal)));
    $$('.signin').forEach((b) => b.addEventListener('click', () => {
      if (!b.dataset.site) return openTab(b.dataset.url);
      b.disabled = true; b.textContent = 'Waiting for you to sign in…';
      signInAndWatch(b.dataset.site, b.dataset.url).then((ok) => { if (!ok && current === 'dashboard') VIEWS.dashboard(); });
    }));
    // Extra sites not checked in the last 30 minutes: check quietly, redraw if anything changed.
    (async () => {
      const due = EXTRA_SITES.filter(([k]) => SITE_AUTH[k] && inRegion(k, us, wantsNhs, wantsFederal) && !agents[k].running && (!siteAuth[k] || Date.now() - siteAuth[k].at > 30 * 60 * 1000));
      let changed = false;
      for (const [k] of due) { const ok = await probeSite(k); if (ok !== null && (!siteAuth[k] || siteAuth[k].ok !== ok)) changed = true; }
      if (changed && current === 'dashboard') VIEWS.dashboard();
    })();
    $$('.ats-mode').forEach((el) => el.addEventListener('change', async (e) => {
      const v = e.target.value;
      const s = await store.get('settings');
      s.autoSubmit = { ...(s.autoSubmit || {}), ats: v !== 'review' };
      s.hardOnes = v === 'assist';
      await store.set('settings', s); renderDashboard();
    }));
    $$('.auto').forEach((el) => el.addEventListener('change', async (e) => {
      const on = e.target.checked; const key = e.target.dataset.bot;
      if (on && key === 'trac' && !confirm('Let the NHS agent submit applications for you?\n\nIt only submits when every section on Trac is complete, and never forms that ask about AI use.')) { e.target.checked = false; return; }
      const s = await store.get('settings');
      s.autoSubmit = { ...(s.autoSubmit || {}), [key]: on };
      await store.set('settings', s); renderDashboard();
    }));
    $$('.pc').forEach((el) => el.addEventListener('change', async (e) => { await store.patch('settings', { [e.target.dataset.k]: e.target.checked }); computerSync(); remoteNudge(); }));
    $$('.agent-enabled').forEach((el) => el.addEventListener('change', async (e) => {
      const s = await store.get('settings');
      s.enabled = { ...(s.enabled || {}), [e.target.dataset.bot]: e.target.checked };
      await store.set('settings', s); renderDashboard();
    }));
    const heldFor = async (id) => releaseHeld((await store.jobs()).find((j) => j.jobId === id));
    $$('.mark-sent').forEach((b) => b.addEventListener('click', async () => { await heldFor(b.dataset.id); await store.updateJob(b.dataset.id, { status: 'applied', appliedAt: new Date().toISOString(), reason: 'Sent by you' }); renderDashboard(); }));
    $$('.fed-open').forEach((b) => b.addEventListener('click', () => { if (b.dataset.url) openTab(b.dataset.url); }));
    $$('.fed-dl').forEach((b) => b.addEventListener('click', () => downloadCv(b.dataset.id)));
    $$('.fed-help').forEach((b) => b.addEventListener('click', () => {
      const a = fedReady.find((x) => x.jobId === b.dataset.id); if (!a) return;
      federalHelpPanel({ title: [a.title, a.company].filter(Boolean).join(' at '), previewUrl: a.questionnaireUrl || '', openUrl: (u) => openTab(u || a.url),
        suggest: async (text) => { const cv = await store.get('cv'); try { return { ok: true, answers: await require('../../bot/modules/federal_answers').suggestAnswers(text, (cv && cv.text) || '') }; } catch (e) { return { ok: false, error: e.message }; } } });
    }));
    $$('.fed-done').forEach((b) => b.addEventListener('click', async () => { await store.updateJob(b.dataset.id, { status: 'applied', appliedAt: new Date().toISOString(), reason: 'You applied on USAJOBS' }); renderDashboard(); }));
    $$('.skip-send').forEach((b) => b.addEventListener('click', async () => { await heldFor(b.dataset.id); await store.updateJob(b.dataset.id, { status: 'skipped', reason: 'Not sent (your choice)' }); renderDashboard(); }));
    $$('.fill-open').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Opening...';
      const r = await fillAndOpen(b.dataset.id, () => renderDashboard()).catch((e) => ({ ok: false, message: e.message }));
      b.disabled = false; b.textContent = b.dataset.label || 'Fill and open';
      if (r && !r.ok && r.message) store.log('⚠ ' + r.message);
    }));
    $$('.open-url, .nhs-open').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.url)));
    $('#nl-setup')?.addEventListener('click', openSetup);
    for (const b of $$('.fh-fix')) b.addEventListener('click', () => { b.disabled = true; widenFilter(b.dataset.fix); });
    $('#fh-hide')?.addEventListener('click', async () => { await store.patch('settings', { filterHintHiddenAt: new Date().toISOString() }); VIEWS.dashboard(); });
    $('#so-yes')?.addEventListener('click', async () => {
      const s = await store.get('settings');
      await store.patch('settings', { autoSubmit: { ...(s.autoSubmit || {}), trac: true } });
      store.log('Submit for me is on for NHS: finished applications are submitted on the next round.');
      VIEWS.dashboard();
    });
    $('#so-no')?.addEventListener('click', async () => { await store.patch('settings', { submitOfferHiddenAt: new Date().toISOString() }); VIEWS.dashboard(); });
    $('#keep-jobai')?.addEventListener('click', () => openTab(`https://tryjobai.com/pricing?lk=${encodeURIComponent(license.key)}&utm_source=extension&utm_campaign=${ended ? 'trial_ended' : 'trial_ending'}`));
    $('#wider-yes')?.addEventListener('click', async () => {
      // Wider from now on, and this week's close misses get checked again.
      await store.patch('profile', { matchLevel: 'wide', minScore: null });
      for (const j of tooFar) await store.updateJob(j.jobId, { status: 'pending', reason: '', retryCount: 0 });
      await loadConfig(); renderDashboard();
    });
    $('#extra-yes')?.addEventListener('click', async () => {
      await store.set('extraNotice', 'done');
      await navigate('search');
      const h = [...document.querySelectorAll('h3')].find((x) => x.textContent.trim() === 'Extra job sites');
      if (h) { h.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'center' }); h.closest('.card').style.outline = '2px solid var(--accent, #2563eb)'; }
    });
    $('#extra-no')?.addEventListener('click', async () => { await store.set('extraNotice', 'done'); renderDashboard(); });
    $('#wider-no')?.addEventListener('click', async () => { await store.patch('settings', { widerOfferOff: true }); renderDashboard(); });
    $$('.nhs-statement').forEach((b) => b.addEventListener('click', () => { const p = $('#nhs-st-' + b.dataset.i); p.hidden = !p.hidden; b.textContent = p.hidden ? 'Supporting statement' : 'Hide supporting statement'; }));
  } finally { dashBusy = false; }
};
function renderDashboard() { return VIEWS.dashboard(); }

// ── Recent activity: the tailored CV and cover letter behind each application (same as the app) ──
const RECENT = ['applied', 'apply_failed', 'ready', 'ready_to_submit', 'cv_ready', 'applying'];
const docButtons = (j) => `${j.cvPath ? `<button class="view-cv-btn" data-id="${esc(j.jobId)}" title="View CV" aria-label="View CV"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>` : ''}${j.coverLetter ? `<button class="view-cl-btn" data-id="${esc(j.jobId)}" title="View cover letter" aria-label="View cover letter"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></svg></button>` : ''}`;
function recentHtml(all, clearedAt) {
  const rows = all.filter((j) => RECENT.includes(j.status) && (!clearedAt || String(j.appliedAt || j.updatedAt) > clearedAt)).sort((a, b) => String(b.appliedAt || b.updatedAt).localeCompare(String(a.appliedAt || a.updatedAt))).slice(0, 15);
  return `<div class="card card-wide"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><h3 style="margin:0">Recent activity</h3><button id="recent-clear" class="secondary" style="font-size:12px;padding:5px 12px" ${rows.length ? '' : 'disabled'}>Clear</button></div>
    ${rows.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Title</th><th>Company</th><th>Status</th><th>CV used</th><th>Updated</th><th></th></tr></thead><tbody>
    ${rows.map((j) => { const [l, c] = STATUS[j.status] || [j.status, 'badge-info']; const u = safeUrl(j.url); return `<tr>
      <td>${u ? `<a class="tracker-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a>` : esc(j.title)}</td><td>${esc(j.company || '')}</td>
      <td><span class="badge ${c}" title="${esc(j.reason || '')}">${esc(l)}</span></td><td class="cv-name-cell">${esc(j.cvName || '-')}</td>
      <td>${esc(j.appliedAt || j.updatedAt ? new Date(j.appliedAt || j.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '')}</td>
      <td class="row-actions">${docButtons(j)}</td></tr>`; }).join('')}</tbody></table></div>`
    : '<div class="empty-state">No applications yet. Each one shows here with the CV and cover letter that were sent.</div>'}</div>`;
}
// "Help me answer" panel for a federal job's questionnaire (same as the desktop app).
function federalHelpPanel({ title, previewUrl, openUrl, suggest }) {
  const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  document.getElementById('fed-help')?.remove();
  const o = document.createElement('div'); o.id = 'fed-help';
  o.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:24px';
  o.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#1c1b17);max-width:760px;width:100%;max-height:88vh;display:flex;flex-direction:column;border-radius:12px;overflow:hidden">
    <div style="padding:18px 22px;border-bottom:1px solid var(--border,#e6e1d6);display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
      <div><h3 style="margin:0 0 4px;font-size:19px;text-transform:none;letter-spacing:-0.01em">Help me answer</h3><div style="font-size:13px;color:var(--text-muted,#4a453b)">${e(title)}</div></div>
      <button class="secondary" id="fh-x" style="margin:0">Close</button></div>
    <div style="padding:16px 22px;overflow:auto" id="fh-body">
      <ol style="margin:0 0 12px 18px;padding:0;font-size:14px;line-height:1.6">
        <li>${previewUrl ? '<a href="#" id="fh-preview">Open the questionnaire preview</a>' : 'Open the job on USAJOBS (<a href="#" id="fh-job">open it</a>) and find "preview the questionnaire" under How you will be evaluated'}, then copy all its questions.</li>
        <li>Paste them below and press Suggest answers.</li></ol>
      <textarea id="fh-text" rows="7" placeholder="Paste the questionnaire questions here" style="width:100%;box-sizing:border-box;font:inherit;font-size:13.5px;padding:10px 12px;border:1px solid var(--border-strong,#d8d2c4);border-radius:8px;resize:vertical"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin:10px 0 4px"><button class="primary" id="fh-go" style="margin:0">Suggest answers</button><span id="fh-st" style="font-size:13px;color:var(--text-muted,#4a453b)"></span></div>
      <div id="fh-out"></div>
      <p style="font-size:12.5px;color:var(--text-muted,#4a453b);margin:14px 0 0">These are suggestions from your CV, not answers. You certify your answers to a federal agency, so only choose what is true. Job-AI never fills in or submits the questionnaire.</p>
    </div></div>`;
  document.body.appendChild(o);
  const $o = (s) => o.querySelector(s);
  $o('#fh-x').addEventListener('click', () => o.remove());
  o.addEventListener('click', (ev) => { if (ev.target === o) o.remove(); });
  $o('#fh-preview')?.addEventListener('click', (ev) => { ev.preventDefault(); openUrl(previewUrl); });
  $o('#fh-job')?.addEventListener('click', (ev) => { ev.preventDefault(); openUrl(null); });
  $o('#fh-go').addEventListener('click', async () => {
    const b = $o('#fh-go'); b.disabled = true; $o('#fh-st').textContent = 'Reading the questions and your CV. This takes up to a minute...';
    let r; try { r = await suggest($o('#fh-text').value); } catch (err) { r = { ok: false, error: err.message }; }
    b.disabled = false;
    if (!r || !r.ok) { $o('#fh-st').textContent = (r && r.error) || 'Could not suggest answers.'; return; }
    $o('#fh-st').textContent = `${r.answers.length} question${r.answers.length === 1 ? '' : 's'}.`;
    $o('#fh-out').innerHTML = r.answers.map((a) => `<div style="border-top:1px solid var(--border,#e6e1d6);padding:10px 0">
      <div style="font-size:13.5px;font-weight:600;margin-bottom:4px">${a.n}. ${e(a.question.length > 320 ? a.question.slice(0, 300) + '...' : a.question)}</div>
      ${a.kind === 'personal' ? `<div style="font-size:13px;color:var(--text-muted,#4a453b)">This one is about you, not your CV. Answer it yourself.</div>`
        : a.kind === 'essay' ? `<div style="font-size:13px;color:var(--text-muted,#4a453b)">Write this in your own words. Agencies ask you to certify you did not use AI, so Job-AI does not write it.</div>`
        : a.kind === 'certification' ? `<div style="font-size:13px;color:var(--text-muted,#4a453b)">Read it and answer it yourself.</div>`
        : a.choice ? `<div style="font-size:13.5px"><span style="color:var(--text-muted,#4a453b)">Your CV supports:</span> <strong>${e(a.choice.length > 320 ? a.choice.slice(0, 300) + '...' : a.choice)}</strong></div><div style="font-size:12.5px;color:var(--text-muted,#4a453b);margin-top:2px">${e(a.evidence)}</div>`
        : `<div style="font-size:13px;color:var(--danger,#a8432f)">No evidence in your CV. Only choose a higher answer if it is true and you can back it up.</div>`}
    </div>`).join('');
  });
  $o('#fh-text').focus();
}

// Save the tailored PDF to Downloads under its own name, ready to upload (federal resumes).
async function downloadCv(jobId) {
  const j = (await store.jobs()).find((x) => x.jobId === jobId); if (!j || !j.cvPath) return;
  await vfsReady;
  let bytes; try { bytes = vfs.readFileSync(j.cvPath); } catch (_) { alert('That resume is no longer on this device.'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = String(j.cvPath).split('/').pop() || 'Federal_Resume.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
// Open the tailored PDF (kept on this device) in a new tab, or show the cover letter.
async function openDoc(kind, jobId) {
  const j = (await store.jobs()).find((x) => x.jobId === jobId); if (!j) return;
  if (kind === 'cv') {
    await vfsReady;
    let bytes; try { bytes = vfs.readFileSync(j.cvPath); } catch (_) { alert('That CV is no longer on this device.'); return; }
    window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), '_blank');
    return;
  }
  let o = $('#cl-modal');
  if (!o) {
    o = document.createElement('div'); o.id = 'cl-modal';
    o.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:24px';
    o.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#1c1b17);max-width:640px;width:100%;max-height:82vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border,#e6e1d6)"><div><b>Cover letter</b><div id="cl-sub" class="muted" style="font-size:12px"></div></div><button id="cl-x" class="secondary" aria-label="Close">Close</button></div>
      <div id="cl-body" style="padding:20px;overflow:auto;white-space:pre-wrap;line-height:1.55;font-size:14px"></div>
      <div style="padding:12px 20px;border-top:1px solid var(--border,#e6e1d6);text-align:right"><button id="cl-copy" class="primary">Copy</button></div></div>`;
    document.body.appendChild(o);
    o.addEventListener('click', (e) => { if (e.target === o || e.target.id === 'cl-x') o.style.display = 'none'; });
    o.querySelector('#cl-copy').addEventListener('click', (e) => navigator.clipboard.writeText($('#cl-body').textContent).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1500); }).catch(() => {}));
  }
  $('#cl-sub').textContent = [j.title, j.company].filter(Boolean).join(' at ');
  $('#cl-body').textContent = j.coverLetter || '';
  o.style.display = 'flex';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.view-cv-btn, .view-cl-btn'); if (!b) return;
  openDoc(b.classList.contains('view-cv-btn') ? 'cv' : 'cl', b.dataset.id);
});

// ── Universal Credit work search log (the app's assisted flow: copy it into your own journal) ──
function showUcLog(list) {
  const fmt = (s) => { const d = String(s || '').slice(0, 10).split('-'); return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : ''; };
  const lines = list.map((j) => `${j.title} at ${j.company || 'Unknown employer'} (applied ${fmt(j.appliedAt || j.updatedAt)})`);
  const text = lines.length ? 'Job search log\n\n' + lines.map((l) => '- ' + l).join('\n') : 'Nothing to log right now. Your journal is up to date.';
  let o = $('#uc-modal');
  if (!o) {
    o = document.createElement('div'); o.id = 'uc-modal';
    o.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:24px';
    o.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#1c1b17);max-width:640px;width:100%;max-height:82vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border,#e6e1d6)"><div><b>Your Universal Credit work search log</b><div id="uc-sub" class="muted" style="font-size:12px"></div></div><button id="uc-x" class="secondary">Close</button></div>
      <div id="uc-body" style="padding:20px;overflow:auto;white-space:pre-wrap;line-height:1.55;font-size:13.5px"></div>
      <div style="padding:12px 20px;border-top:1px solid var(--border,#e6e1d6);display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="muted" style="font-size:12px;flex:1;min-width:180px">Add these to your journal, then click Mark as logged so they don't show again.</span>
        <div class="ext-inline"><button id="uc-mark" class="secondary">Mark as logged</button><button id="uc-cp" class="primary">Copy</button></div></div></div>`;
    document.body.appendChild(o);
    o.addEventListener('click', (e) => { if (e.target === o || e.target.id === 'uc-x') o.style.display = 'none'; });
  }
  $('#uc-sub').textContent = lines.length ? `${lines.length} application${lines.length === 1 ? '' : 's'} ready to add` : '';
  $('#uc-body').textContent = text;
  $('#uc-cp').onclick = (e) => navigator.clipboard.writeText(text).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1500); }).catch(() => {});
  $('#uc-mark').disabled = !lines.length;
  $('#uc-mark').onclick = async () => { const at = new Date().toISOString(); for (const j of list) await store.updateJob(j.jobId, { ucLoggedAt: at }); o.style.display = 'none'; renderDashboard(); };
  o.style.display = 'flex';
}

// ── US work search log (same as the app): benefit weeks run Sunday to Saturday ──
const WSL_SITE = { linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'company website', reed: 'Reed' };
function wslWeekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
function wslByWeek(list) {
  const weeks = new Map();
  for (const j of list) {
    const d = new Date(j.appliedAt || ''); if (isNaN(d)) continue;
    const start = wslWeekStart(d).getTime();
    if (!weeks.has(start)) weeks.set(start, { start, rows: [] });
    weeks.get(start).rows.push({ ...j, date: d });
  }
  for (const w of weeks.values()) w.rows.sort((a, b) => b.date - a.date);
  return [...weeks.values()].sort((a, b) => b.start - a.start);
}
function showWorkSearchLog(list) {
  const weeks = wslByWeek(list);
  const fmt = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const row = (j) => ({ date: j.date.toLocaleDateString('en-US'), employer: j.company || 'Unknown employer', position: j.title || '', method: `Online application via ${WSL_SITE[j.source] || 'job site'}`, contact: String(j.url || '').split(/[?#]/)[0], result: 'Application submitted' });
  const text = weeks.length ? weeks.map((w) => {
    const end = new Date(w.start); end.setDate(end.getDate() + 6);
    return `Week of ${fmt(w.start)} to ${fmt(end)} (${w.rows.length} contact${w.rows.length === 1 ? '' : 's'})\n` + w.rows.map(row).map((r) => `${r.date} | ${r.employer} | ${r.position} | ${r.method} | ${r.result}${r.contact ? ' | ' + r.contact : ''}`).join('\n');
  }).join('\n\n') : 'No applications yet. Once the agents apply to jobs, they appear here with the real date.';
  const cell = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = ['Week starting,Date,Employer,Position,How you applied,Website,Result']
    .concat(weeks.flatMap((w) => w.rows.map(row).map((r) => [new Date(w.start).toLocaleDateString('en-US'), r.date, r.employer, r.position, r.method, r.contact, r.result].map(cell).join(',')))).join('\r\n');
  let o = $('#wsl-modal');
  if (!o) {
    o = document.createElement('div'); o.id = 'wsl-modal';
    o.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:24px';
    o.innerHTML = `<div style="background:var(--surface,#fff);color:var(--text,#1c1b17);max-width:760px;width:100%;max-height:82vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border,#e6e1d6)"><div><b>Your work search log</b><div id="wsl-sub" class="muted" style="font-size:12px"></div></div><button id="wsl-x" class="secondary">Close</button></div>
      <div id="wsl-body" style="padding:20px;overflow:auto;white-space:pre-wrap;line-height:1.6;font-size:13px"></div>
      <div style="padding:12px 20px;border-top:1px solid var(--border,#e6e1d6);display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="muted" style="font-size:12px;flex:1;min-width:180px">Enter these on your state's weekly claim. Weeks run Sunday to Saturday.</span>
        <div class="ext-inline"><button id="wsl-csv" class="secondary">Download spreadsheet</button><button id="wsl-cp" class="primary">Copy</button></div></div></div>`;
    document.body.appendChild(o);
    o.addEventListener('click', (e) => { if (e.target === o || e.target.id === 'wsl-x') o.style.display = 'none'; });
  }
  $('#wsl-sub').textContent = list.length ? `${list.length} application${list.length === 1 ? '' : 's'} in ${weeks.length} week${weeks.length === 1 ? '' : 's'}` : '';
  $('#wsl-body').textContent = text;
  $('#wsl-cp').disabled = $('#wsl-csv').disabled = !weeks.length;
  $('#wsl-cp').onclick = (e) => navigator.clipboard.writeText(text).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1500); }).catch(() => {});
  $('#wsl-csv').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    a.download = `work-search-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  o.style.display = 'flex';
}

// ── Analytics (same sections as the app) ──
VIEWS.analytics = async function renderAnalytics() {
  const all = await store.jobs();
  const applied = all.filter((j) => j.status === 'applied'), skipped = all.filter((j) => j.status === 'skipped'), failed = all.filter((j) => j.status === 'apply_failed');
  const count = (list, key) => Object.entries(list.reduce((m, j) => { const k = key(j); if (k) m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const LABEL = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'Company sites', usajobs: 'Federal' };
  const bySource = count(applied, (j) => LABEL[j.source] || j.source), byCv = count(applied, (j) => j.cvName || 'Unknown');
  const skipReasons = count(skipped, (j) => String(j.reason || '').replace(/\s*\(\d+%\)$/, '').replace(/\d+%/g, 'N%')).slice(0, 10);
  const companies = count(applied, (j) => j.company).slice(0, 10), titles = count(applied, (j) => j.title).slice(0, 10);
  const daysActive = new Set(applied.map((j) => String(j.appliedAt || '').slice(0, 10)).filter(Boolean)).size || 1;
  const skipRate = applied.length + skipped.length ? Math.round(skipped.length / (applied.length + skipped.length) * 100) : 0;
  const bars = (rows, color) => rows.length ? rows.map(([k, n]) => `<div class="analytics-bar-row"><span class="analytics-bar-label">${esc(k)}</span><div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${Math.round(n / rows[0][1] * 100)}%;background:${color}"></div></div><span class="analytics-bar-count">${n}</span></div>`).join('') : '<div class="empty-state">No data yet</div>';
  const table = (rows, h) => `<table class="data-table"><thead><tr><th>${h}</th><th>Applications</th></tr></thead><tbody>${rows.length ? rows.map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join('') : '<tr><td colspan="2"><div class="empty-state">No data yet</div></td></tr>'}</tbody></table>`;
  content.innerHTML = `
    <div class="page-header"><h2>Analytics</h2><p>Application performance and patterns over time.</p></div>
    <div class="summary-grid analytics-summary">
      <div class="summary-card applied"><div class="num">${applied.length}</div><div class="label">Total applied</div></div>
      <div class="summary-card pending"><div class="num">${(applied.length / daysActive).toFixed(1)}</div><div class="label">Avg / active day</div></div>
      <div class="summary-card cv_ready"><div class="num num-sm">${esc((bySource[0] || ['-'])[0])}</div><div class="label">Top source</div></div>
      <div class="summary-card skipped"><div class="num">${skipRate}%</div><div class="label">Skip rate</div></div>
      <div class="summary-card apply_failed"><div class="num">${failed.length}</div><div class="label">Failed</div></div>
    </div>
    <div class="dash-col-title analytics-graph-title">Applications (last 30 days)</div>
    <div class="card card-wide">${buildApplicationsGraph(all, 30)}</div>
    <div class="analytics-grid">
      <div class="card"><h3>By site</h3>${bars(bySource, '#2563eb')}</div>
      <div class="card"><h3>By CV</h3>${bars(byCv, '#2563eb')}</div>
      <div class="card"><h3>Why jobs were skipped</h3>${bars(skipReasons, '#94a3b8')}</div>
    </div>
    <div class="analytics-tables">
      <div class="card"><h3>Top companies applied to</h3>${table(companies, 'Company')}</div>
      <div class="card"><h3>Top job titles applied to</h3>${table(titles, 'Title')}</div>
    </div>`;
};

// ── Help & FAQs (the app's, for the extension) ──
const FAQS = [
  ['How do I get started?', 'Open Setup (top right) and fill in Personal Details, CVs, Search Preferences and License. Set up on your phone? Then it is already done: type the 6-digit code on the License page. Next, press Start applying. The "How to start applying" checklist on the Dashboard shows anything still missing.'],
  ['Where does Job-AI apply?', 'On employers\' own career websites, through the Company Sites agent. In the UK the NHS (Trac) agent also applies to NHS jobs. Each has its own agent card on the Dashboard.'],
  ['Do I need job site accounts?', 'No. Company Sites applies straight on each employer\'s website, so there is nothing to sign in to. The only sign in is NHS Trac, in the UK, if you use the NHS agent.'],
  ['What do the agents do?', 'Each agent finds jobs that match your job titles, skips jobs that do not fit, tailors your CV and cover letter to each job that does, and applies. They work in their own minimised Chrome windows, so leave those windows alone and keep this Job-AI tab open.'],
  ['Why are some jobs showing as skipped?', 'Jobs are skipped when they do not fit what you asked for: the wrong work type or level, below your salary, an external application site, or a CV match under 45% (or under your own minimum if you set one). The Activity tab and the Tracker show the reason for each one.'],
  ['The agent says "Not signed in". What do I do?', 'Your session for that site has ended. Click the Sign in button on that agent card, sign in, and the agent carries on by itself.'],
  ['How do I add more CVs?', 'Open Setup, then CVs, and use "Add another CV". With more than one, the agents use the best fit for each job.'],
  ['What is the minimum match score?', 'How closely your CV must match a job before Job-AI applies. Leave it empty (Any) and it applies to every job that fits your CV, like the desktop app. Set a number in Search Preferences to be pickier.'],
  ['The agents are running but no jobs are being found. Why?', 'Every matching job may already have been handled. Add more job titles in Search Preferences, widen the work types, or allow older job postings.'],
  ['Can Job-AI apply on Reed, LinkedIn or other job sites?', 'Yes, if you have an account there. Open Search Preferences and tick the sites under Extra job sites (Reed and LinkedIn in the UK, LinkedIn, Dice and Wellfound in the USA). Each one then gets an agent card on the Dashboard: press its Sign in button, sign in as normal in this Chrome, and it applies through your account. LinkedIn can limit accounts it thinks are automated, so keep your daily limit low there.'],
  ['Can I check each application before it is sent?', 'Yes. Turn on "Review before applying" in Search Preferences. Each tailored CV and cover letter then waits on the Dashboard for you to approve or skip.'],
  ['Can I control Job-AI from my phone?', 'Yes. Open tryjobai.com/app on your phone to start and stop your agents, get a notification for each application, submit NHS forms and change your job search.'],
  ['Is my data stored online?', 'Your details, CVs and job list stay in this Chrome on this device. To let you control Job-AI from your phone, a short summary (job titles, companies, stages) is kept on our server. Your passwords are never seen or stored.'],
  ['How do I cancel or manage my subscription?', 'Open the License page and click "Manage or cancel subscription". That opens Stripe\'s secure page.'],
];
VIEWS.help = async function renderHelp() {
  content.innerHTML = `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px"><div><h2>Help &amp; FAQs</h2><p>Answers to common questions about setting up and running Job-AI.</p></div><button class="secondary" id="help-tour">Take the tour</button></div>
    <div class="help-faq">${FAQS.map(([q, a], i) => `<div class="faq-item" id="faq-${i}"><button class="faq-question" data-i="${i}"><span>${esc(q)}</span><span class="faq-chevron">›</span></button><div class="faq-answer">${esc(a)}</div></div>`).join('')}</div>
    <div class="help-contact"><p>Still need help? Email us at <a href="mailto:jobaisupport@gmail.com">jobaisupport@gmail.com</a> and we'll get back to you.</p></div>`;
  $$('.faq-question').forEach((b) => b.addEventListener('click', () => $('#faq-' + b.dataset.i).classList.toggle('open')));
  $('#help-tour').addEventListener('click', () => startTour());
};

// ── Daily summary email (as the app: once a day after 6pm, when something happened) ──
async function maybeSendDailySummary() {
  try {
    const now = new Date(), today = now.toISOString().slice(0, 10);
    if (now.getHours() < 18) return;
    const s = await store.get('settings');
    if (s.summarySent === today) return;
    const lic = await store.get('license');
    if (!licenceActive(lic)) return;
    const all = await store.jobs();
    const on = (j, k) => String(j[k] || j.updatedAt || '').slice(0, 10) === today;
    const pick = (j) => ({ title: j.title || '', company: j.company || '' });
    const applied = all.filter((j) => j.status === 'applied' && on(j, 'appliedAt')).map(pick);
    const failed = all.filter((j) => j.status === 'apply_failed' && on(j, 'updatedAt')).map(pick);
    if (!applied.length && !failed.length) return;
    const skipped = all.filter((j) => j.status === 'skipped' && on(j, 'updatedAt')).map(pick);
    const pending = all.filter((j) => ['pending', 'cv_ready'].includes(j.status)).length;
    const tc = {}; for (const j of applied) { const t = j.title.split(' ').slice(0, 4).join(' '); if (t) tc[t] = (tc[t] || 0) + 1; }
    const topTitles = Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
    const r = await fetch(BACKEND + '/api/daily-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ license_key: lic.key, date: today, applied, skipped, failed, pending, topTitles }), signal: AbortSignal.timeout(20000) });
    if (r.ok) await store.patch('settings', { summarySent: today });
  } catch (_) { /* tries again in a while */ }
}
if (globalThis.__jobaiClient !== 'android') { setTimeout(maybeSendDailySummary, 60000); setInterval(maybeSendDailySummary, 15 * 60 * 1000); }

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
const STAGE_LIST = [['applied', 'Applied'], ['phone_screen', 'Phone screen'], ['interview', 'Interview'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn']];
const STAGE = { phone_screen: ['Phone screen', 'badge-info'], interview: ['Interview', 'badge-info'], offer: ['Offer', 'badge-success'], rejected: ['Rejected', 'badge-muted'], withdrawn: ['Withdrawn', 'badge-muted'] };
const STATUS = { awaiting_review: ['Waiting for your review', 'badge-warning'], processing: ['Tailoring CV', 'badge-info'], applied: ['Applied', 'badge-success'], apply_failed: ['Failed', 'badge-danger'], skipped: ['Skipped', 'badge-muted'], pending: ['Found', 'badge-info'], cv_ready: ['CV ready', 'badge-info'], applying: ['Applying', 'badge-info'], ready: ['Waiting for you', 'badge-warning'], ready_to_submit: ['Ready to submit', 'badge-success'] };
const SOURCE = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'Company site' };
let trackerFilter = 'all';
VIEWS.tracker = async function renderTracker() {
  const all = (await store.jobs()).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const f = trackerFilter;
  const shown = all.filter((j) => !j.trackerHidden && (f === 'all' || (f === 'applied' ? j.status === 'applied' : f === 'skipped' ? j.status === 'skipped' : !['applied', 'skipped'].includes(j.status))));
  content.innerHTML = `
    <div class="page-header"><h2>Tracker</h2><p>Every job your agents found, and what happened to it.</p></div>
    <div class="ext-inline" style="margin-bottom:12px">${[['all', 'All'], ['applied', 'Applied'], ['open', 'In progress'], ['skipped', 'Skipped']].map(([k, l]) => `<button class="${f === k ? 'primary' : 'secondary'} trk-f" data-f="${k}">${l}</button>`).join('')}</div>
    ${shown.length ? `<div class="card card-wide"><div class="table-scroll"><table class="data-table tracker-table">
      <thead><tr><th>Job</th><th>Company</th><th>Site</th><th>Status</th><th>Notes</th><th>Updated</th><th></th></tr></thead>
      <tbody>${shown.slice(0, 300).map((j) => { const [l, c] = (j.status === 'applied' && STAGE[j.stage]) || STATUS[j.status] || [j.status, 'badge-info']; const u = safeUrl(j.draftUrl || j.url); return `<tr>
        <td class="tracker-title" title="${esc(j.title)}">${u ? `<a class="tracker-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a>` : esc(j.title)}</td>
        <td>${esc(j.company || '')}</td><td>${esc(SOURCE[j.source] || j.source || '')}</td>
        <td>${j.status === 'applied' ? `<select class="tracker-stage-select trk-stage" data-id="${esc(j.jobId)}" aria-label="Stage">${STAGE_LIST.map(([v, t]) => `<option value="${v}" ${(j.stage || 'applied') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>` : `<span class="badge ${c}" title="${esc(j.reason || '')}">${esc(l)}</span>`}</td>
        <td>${j.status === 'applied' ? `<textarea class="tracker-notes-input trk-notes" data-id="${esc(j.jobId)}" rows="1" placeholder="Add notes...">${esc(j.notes || '')}</textarea>` : ''}</td>
        <td>${esc(j.updatedAt ? new Date(j.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '')}</td><td class="row-actions">${docButtons(j)}<button class="tracker-delete-btn trk-del" data-id="${esc(j.jobId)}" title="Remove from Tracker" aria-label="Remove from Tracker">×</button></td></tr>`; }).join('')}</tbody>
    </table></div></div>` : '<div class="card"><div class="empty-state">No applications tracked yet. Jobs appear here once the agents start working.</div></div>'}`;
  $$('.trk-f').forEach((b) => b.addEventListener('click', () => { trackerFilter = b.dataset.f; renderTracker(); }));
  $$('.trk-stage').forEach((el) => el.addEventListener('change', () => store.updateJob(el.dataset.id, { stage: el.value }).then(remoteNudge)));
  $$('.trk-notes').forEach((el) => {
    const grow = () => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }; grow();
    el.addEventListener('input', grow);
    el.addEventListener('blur', () => store.updateJob(el.dataset.id, { notes: el.value.slice(0, 2000) }));
  });
  // Hidden from the Tracker only: the job stays known so it is never applied to twice.
  $$('.trk-del').forEach((b) => b.addEventListener('click', async () => { await store.updateJob(b.dataset.id, { trackerHidden: true }); renderTracker(); }));
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
// Security clearance questions (British citizen, 5 years in the UK). Used by Personal Details and setup.
const CLEARANCE = [
  ['britishCitizen', 'British citizen?', [['', 'Not set'], ['yes', 'Yes'], ['no', 'No']]],
  ['ukResidence', 'Your last 5 years', [['', 'Not set'], ['all', 'Lived in the UK, no trip abroad over 30 days'], ['short', 'Lived in the UK, a trip of 30 days to 3 months'], ['long', '3+ months abroad, or in the UK under 5 years']]],
];
VIEWS.personal = async function renderPersonal() {
  const { profile: P } = await loadConfig();
  const f = (k, l, type = 'text', ph = '') => `<div class="field"><label>${esc(l)}</label><input class="p-in" data-k="${k}" type="${type}" value="${esc(P[k] ?? '')}" placeholder="${esc(ph)}"></div>`;
  content.innerHTML = `
    <div class="page-header"><h2>Personal Details</h2><p>Used to fill in application forms automatically. Saved on this device only.</p></div>
    ${P.firstName && P.lastName && P.email && P.phone ? '' : `<div class="card"><h3>Fill this in from your CV</h3><p class="muted">Upload your CV and we'll add your name, contact details and experience for you.</p>
      <div class="ext-inline"><button class="primary" id="cv-fill">Upload CV</button><span class="status-msg" id="cv-fill-st"></span></div></div>`}
    <div class="card"><h3>About you</h3><div class="tracd-grid">
      ${f('firstName', 'First name')}${f('middleName', 'Middle name(s)')}${f('lastName', 'Last name')}${f('email', 'Email', 'email')}${f('phone', 'Phone', 'tel')}
      ${f('address', 'Address')}${f('location', 'City / town')}${f('country', 'Country', 'text', 'United Kingdom')}${f('linkedin', 'LinkedIn profile URL (many company forms ask for it; left empty, Job-AI writes N/A)', 'url', 'https://www.linkedin.com/in/...')}
    </div></div>
    <div class="card"><h3>Application answers</h3><p class="muted">How the agents answer common questions on job forms.</p><div class="tracd-grid">
      ${f('yearsExperience', 'Years of experience', 'number')}
      <div class="field"><label>Experience level</label><select class="p-sel" data-k="experienceLevel">${[['', 'Any level'], ['entry', 'Entry level'], ['junior', 'Junior'], ['mid', 'Mid level'], ['senior', 'Senior'], ['lead', 'Lead'], ['director', 'Director'], ['executive', 'Executive']].map(([v, l]) => `<option value="${v}" ${(P.experienceLevel || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select><small class="muted">Skips jobs clearly too senior or too junior for you.</small></div>
      ${f('rightToWorkCountries', 'Countries you can work in', 'text', 'United Kingdom')}
      <div class="field"><label>Notice period</label><select id="p-avail">${[['immediately', 'Immediately'], ['1week', '1 week'], ['2weeks', '2 weeks'], ['1month', '1 month'], ['3months', '3 months']].map(([v, l]) => `<option value="${v}" ${(P.availability || 'immediately') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${f('salaryExpectation', 'Minimum salary (£ a year)', 'text', 'e.g. 28000')}
    </div>
    <div class="tracd-sectors" style="margin-top:12px">${[['requiresSponsorship', 'I need visa sponsorship'], ['seekSponsorship', 'Only apply to jobs that offer sponsorship'], ['willingToRelocate', 'Willing to relocate'], ['drivingLicence', 'I have a driving licence']].map(([k, l]) => `<label class="sector-chip"><input type="checkbox" class="p-flag" data-k="${k}" ${P[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
    <div class="card"><h3>Security clearance</h3><p class="muted">Some UK employers, often government suppliers, ask these. Left blank, those jobs are skipped.</p><div class="tracd-grid">
      ${CLEARANCE.map(([k, l, o]) => `<div class="field"><label>${l}</label><select class="p-sel" data-k="${k}">${o.map(([v, t]) => `<option value="${v}" ${(P[k] || '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`).join('')}
    </div></div>
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
  const cvs = await getCvs();
  content.innerHTML = `
    <div class="page-header"><h2>Your CVs</h2><p>Your CVs are read on this device and never uploaded. Add more than one and the agents use the best fit for each job.</p></div>
    ${cvs.map((cv, i) => `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div><div class="cv-card-title">${esc(cv.label || 'CV')}</div><div class="cv-card-file">${esc(cv.name || '')}</div></div>
        <div class="ext-inline">${i === 0 ? '<button class="secondary cv-replace">Replace</button>' : ''}<button class="secondary cv-remove" data-i="${i}" style="color:#c0392b;border-color:#c0392b">Remove</button></div>
      </div>
      ${(cv.roles || []).length ? `<div class="cv-card-section">
        <strong>Suggested roles</strong>
        <div class="tag-list">${cv.roles.map((r) => `<div class="tag">${esc(r)}</div>`).join('')}</div>
        <p class="cv-suggest-hint">Add these to your search so the agents look for them on company websites.</p>
        <div class="ext-inline"><button class="primary cv-add-terms" data-i="${i}">＋ Add these as search terms</button><span class="status-msg cv-terms-st" data-i="${i}"></span></div></div>` : ''}
      ${(cv.keywords || []).length ? `<div class="cv-card-section"><strong>Extracted keywords</strong>
        <div class="tag-list">${cv.keywords.map((k) => `<div class="tag">${esc(k)}</div>`).join('')}</div></div>` : ''}
      ${!cv.roles ? '<p class="muted" style="margin-top:12px">Replace this CV to see the job titles it fits.</p>' : ''}
    </div>`).join('') || '<div class="card"><div class="empty-state">No CVs added yet. Add a Word document (.docx) for the best results.</div></div>'}
    <div class="card"><h3>${cvs.length ? 'Add another CV' : 'Add a CV'}</h3>
      <p class="muted" style="margin-top:0">Word (.docx) is read most accurately. PDF also works.</p>
      <div class="field" style="max-width:420px"><label>Label for this CV</label><input id="cv-label" placeholder="e.g. IT Support &amp; Service Desk"></div>
      <div class="ext-inline"><button class="primary" id="cv-pick">Choose file and add</button><span class="status-msg" id="cv-st"></span></div></div>`;
  const again = (msg) => VIEWS.cvs().then(() => setSt('#cv-st', msg));
  $('#cv-pick').addEventListener('click', () => pickCv('#cv-st', again, cvs.length ? 'add' : 'replace', $('#cv-label').value));
  $('.cv-replace')?.addEventListener('click', () => pickCv('#cv-st', again, 'replace'));
  $$('.cv-remove').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this CV from Job-AI?')) return;
    const list = await getCvs(); list.splice(Number(b.dataset.i), 1); await saveCvs(list); VIEWS.cvs();
  }));
  $$('.cv-add-terms').forEach((b) => b.addEventListener('click', async () => {
    const cv = cvs[Number(b.dataset.i)]; const { profile } = await loadConfig();
    const have = profile.searchTerms || [], lower = new Set(have.map((t) => t.toLowerCase()));
    const add = (cv.roles || []).filter((r) => !lower.has(r.toLowerCase()));
    if (add.length) { await store.patch('profile', { searchTerms: [...have, ...add].slice(0, 40) }); await loadConfig(); }
    setSt(`.cv-terms-st[data-i="${b.dataset.i}"]`, add.length ? `✓ Added ${add.length} to your search. See Search preferences.` : 'These are already in your search.');
  }));
};

// ── Setup: Search preferences ────────────────────────────────────────────────
VIEWS.search = async function renderSearch() {
  const { profile, settings } = await loadConfig();
  const sched = settings.schedule || {};
  content.innerHTML = `
    <div class="page-header"><h2>Search Preferences</h2><p>Used by the agents to find jobs that fit.</p></div>
    <div class="card"><div class="tracd-grid">
      <div class="field"><label>Job titles to search (one per line)</label><textarea id="s-terms" class="tracd" rows="5" placeholder="e.g. IT Support Analyst">${esc((profile.searchTerms || []).join('\n'))}</textarea></div>
      <div class="field"><label>Skip jobs with these words in the title (one per line)</label><textarea id="s-exclude" class="tracd" rows="5" placeholder="e.g. Senior">${esc((profile.excludeKeywords || []).join('\n'))}</textarea></div>
      <div class="field"><label>Blocked companies (one per line)</label><textarea id="s-block" class="tracd" rows="5" placeholder="e.g. Agency name">${esc((profile.blockedCompanies || []).join('\n'))}</textarea></div>
      <div class="field"><label>Search location</label><input id="s-where" type="text" value="${esc(profile.searchLocation || (isUS(settings) ? 'United States' : 'United Kingdom'))}"></div>
      <div class="field"><label>Maximum job posting age</label><select id="s-age">${[['r86400', 'Past 24 hours'], ['r604800', 'Past week'], ['r1209600', 'Past 2 weeks'], ['r2592000', 'Past month']].map(([v, l]) => `<option value="${v}" ${(profile.jobAge || 'r1209600') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>How close a match</label><select id="s-level">${[['wide', 'Wider: apply to more jobs'], ['balanced', 'Balanced (recommended)'], ['strict', 'Strict: close matches only']].map(([v, l]) => `<option value="${v}" ${(profile.matchLevel || (Number(profile.minScore) >= 70 ? 'strict' : 'balanced')) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Where you want to work</label><div class="tracd-sectors">${[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']].map(([v, l]) => `<label class="sector-chip"><input type="checkbox" class="s-wt" value="${v}" ${(profile.workTypePriority || ['remote', 'hybrid', 'onsite']).includes(v) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="field"><label>Contract</label><div class="tracd-sectors">${[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Fixed-term / contract']].map(([v, l]) => `<label class="sector-chip"><input type="checkbox" class="s-type" value="${v}" ${(profile.employmentType || ['full_time']).includes(v) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="field"><label>Applications a day</label><select id="s-cap">${[5, 10, 15, 20, 25].map((n) => `<option value="${n}" ${Number(settings.dailyCap || 15) === n ? 'selected' : ''} ${n > cfg.PLAN_CAP ? 'disabled' : ''}>${n}${n > cfg.PLAN_CAP ? ' (Pro)' : ''}</option>`).join('')}</select></div>
    </div><p class="muted" style="margin:2px 0 0;font-size:13px">How close a match: jobs are only skipped when your CV misses what the advert must have.</p></div>
    <div class="card"><h3>Agent schedule</h3><p class="muted" style="margin-top:0">Only search and apply on these days and hours. Off means any time.</p>
      <label class="checkbox-label"><input type="checkbox" id="s-sched" ${sched.enabled ? 'checked' : ''}> Enable schedule</label>
      <div class="tracd-grid" style="margin-top:10px">
        <div class="field"><label>Start time</label><select id="s-from">${[...Array(24).keys()].map((h) => `<option value="${h}" ${Number(sched.start ?? 9) === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div>
        <div class="field"><label>End time</label><select id="s-to">${[...Array(24).keys()].map((h) => h + 1).map((h) => `<option value="${h}" ${Number(sched.end ?? 18) === h ? 'selected' : ''}>${String(h % 24).padStart(2, '0')}:00</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Active days</label><div class="tracd-sectors">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<label class="sector-chip"><input type="checkbox" class="s-day" value="${d}" ${(sched.days || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).includes(d) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div></div>
    </div>
    <div class="card"><h3>Extra job sites</h3>
      <p class="muted" style="margin-top:0">Job-AI already applies on employers' own websites with no accounts. If you also want it to apply on these sites, tick them below. Each one <strong>needs your own account on that site</strong>, signed in in this Chrome. Job-AI never sees your password.</p>
      <div class="tracd-sectors">${extraForRegion(isUS(settings)).map(([k, l]) => `<label class="sector-chip"><input type="checkbox" class="s-extra" value="${k}" ${(settings.extraSites || {})[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <p class="muted" style="margin:8px 0 0;font-size:13px">Once ticked, the site gets its own agent card on the Dashboard with a Sign in button. ${extraForRegion(isUS(settings)).some(([k]) => k === 'linkedin') ? 'LinkedIn can limit accounts it thinks are automated, so use it at your own risk and keep your daily limit low.' : ''}</p>
    </div>
    <div class="card"><h3>Review before applying</h3>
      <label class="checkbox-label" style="align-items:flex-start"><input type="checkbox" id="s-review" ${settings.reviewBeforeApply ? 'checked' : ''}><span>Let me review each tailored CV and cover letter before it applies<br><small class="muted">Each one waits on the Dashboard for you to approve or skip.</small></span></label>
    </div>
    ${saveBar('s-save')}`;
  $('#s-save').addEventListener('click', async () => {
    await store.patch('profile', {
      searchTerms: lines('#s-terms').slice(0, 40), excludeKeywords: lines('#s-exclude').slice(0, 80),
      searchLocation: $('#s-where').value.trim() || 'United Kingdom', matchLevel: $('#s-level').value, minScore: null,
      workTypePriority: $$('.s-wt:checked').map((c) => c.value), employmentType: $$('.s-type:checked').map((c) => c.value),
    });
    await store.patch('profile', { blockedCompanies: lines('#s-block').slice(0, 100), jobAge: $('#s-age').value });
    const extraSites = { ...(settings.extraSites || {}) };
    for (const c of $$('.s-extra')) extraSites[c.value] = c.checked;
    for (const [k] of EXTRA_SITES) if (!extraSites[k] && agents[k] && agents[k].running) agents[k].stop();
    await store.patch('settings', { extraSites, dailyCap: Number($('#s-cap').value), reviewBeforeApply: $('#s-review').checked,
      schedule: { enabled: $('#s-sched').checked, start: Number($('#s-from').value), end: Number($('#s-to').value), days: $$('.s-day:checked').map((c) => c.value) } });
    await loadConfig();
    setSt('#s-save-st', '✓ Saved.');
  });
};

// ── Earn more: market value + "Only move for more money" ─────────────────────
// For people who aren't job hunting: what their job pays elsewhere (live adverts, same check
// as tryjobai.com/am-i-underpaid), and the mode that only applies when a job pays more.
const PAY_CHECK_URL = 'https://api.tryjobai.com/am-i-underpaid/check';
const MOVE_SKIP = /^(Pays under|No salary shown \(you only move|Your current employer)/;
VIEWS.earn = async function renderEarn() {
  const { profile, settings } = await loadConfig();
  const us = isUS(settings);
  const mv = profile.moveForMore || {};
  const money = (n) => (us ? '$' : '£') + Number(n).toLocaleString('en-GB');
  const title = mv.title || (profile.searchTerms || [])[0] || '';
  const where = mv.location != null ? mv.location : String(profile.location || '').split(',')[0].trim();
  const salary = String(mv.current || profile.salaryExpectation || '').replace(/[^0-9]/g, '');
  const all = await store.jobs();
  const since = Date.now() - 30 * 864e5;
  const sent = all.filter((j) => j.status === 'applied' && Date.parse(j.appliedAt || 0) >= since)
    .sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
  const held = all.filter((j) => j.status === 'skipped' && MOVE_SKIP.test(j.reason || '') && Date.parse(j.updatedAt || 0) >= since);
  const count = (re) => held.filter((j) => re.test(j.reason)).length;
  const left = await store.monthLeft();
  const usedN = cfg.MOVE.on ? Math.max(0, cfg.MOVE.monthly - Math.max(0, left)) : 0;
  content.innerHTML = `
    <div class="page-header"><h2>Earn more</h2><p>See what your job pays elsewhere, and let Job-AI apply only when a job pays more.</p></div>
    <div class="card"><h3>Your market value</h3>
      <div class="tracd-grid">
        <div class="field"><label>Your job title</label><input id="em-title" type="text" value="${esc(title)}" placeholder="e.g. Service Desk Analyst"></div>
        <div class="field"><label>Where you work</label><input id="em-where" type="text" value="${esc(where)}" placeholder="Town or city, or leave blank"></div>
        <div class="field"><label>Your salary now (a year)</label><input id="em-salary" type="text" inputmode="numeric" value="${esc(salary)}" placeholder="e.g. 32000"></div>
      </div>
      <button class="primary" id="em-check">Check my pay</button>
      <div id="em-result" style="margin-top:14px"></div>
    </div>
    <div class="card"><h3>Only move for more money</h3>
      <p class="muted" style="margin-top:0">Happy where you are? Job-AI then only applies to jobs whose advert shows a salary well above yours, never to your employer, and only a few a month.</p>
      <label class="checkbox-label"><input type="checkbox" id="mv-on" ${mv.on ? 'checked' : ''}> Turn on</label>
      <div class="tracd-grid" style="margin-top:10px">
        <div class="field"><label>Only apply if it pays at least</label><select id="mv-up">${[10, 15, 20, 25, 30].map((n) => `<option value="${n}" ${Number(mv.uplift || 15) === n ? 'selected' : ''}>${n}% more</option>`).join('')}</select></div>
        <div class="field"><label>Most applications a month</label><select id="mv-month">${[4, 8, 12, 20].map((n) => `<option value="${n}" ${Number(mv.monthly || 8) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>Your employer (never apply there)</label><input id="mv-emp" type="text" value="${esc(mv.employer || '')}" placeholder="e.g. Barts Health NHS Trust"></div>
      </div>
      <p class="muted" style="margin:2px 0 12px;font-size:13px">${cfg.MOVE.on ? `On: only jobs paying ${money(cfg.MOVE.min)} or more, from your salary above.` : 'Off. Uses your salary from Your market value above.'}</p>
      <button class="primary" id="mv-save">Save</button> <span class="status-msg" id="mv-st"></span>
    </div>
    <div class="card"><h3>What it found (last 30 days)</h3>
      ${cfg.MOVE.on ? `<p style="margin-top:0"><strong>${usedN} of ${cfg.MOVE.monthly}</strong> applications used this month.</p>` : '<p class="muted" style="margin-top:0">Turn on Only move for more money and this shows what it applied to, and what it skipped for paying too little.</p>'}
      ${held.length ? `<p class="muted">Skipped: ${count(/^Pays under/)} paid too little, ${count(/^No salary shown/)} showed no salary, ${count(/^Your current employer/)} at your employer.</p>` : ''}
      ${sent.length ? `<div style="font-weight:600;margin:10px 0 4px">Applications sent</div>${sent.slice(0, 6).map((j) => `<div style="padding:8px 0;border-top:1px solid var(--border,#e5e2da);font-size:14px"><strong>${esc(String(j.title || '').split('\n')[0])}</strong> <span class="muted">${esc(j.company || '')}, ${esc(String(j.appliedAt || '').slice(0, 10))}</span>${(() => { const r = cfg.movePay(j); return r ? ` <span style="color:#15803d;font-weight:600">${money(r.pay)}, ${r.pay_pct}% more</span>` : ''; })()}</div>`).join('')}` : ''}
    </div>`;

  const read = () => ({ title: $('#em-title').value.trim(), location: $('#em-where').value.trim(), salary: $('#em-salary').value.replace(/[^0-9]/g, '') });
  async function check() {
    const v = read(), out = $('#em-result');
    if (v.title.length < 3 || Number(v.salary) < 5000) { out.innerHTML = '<p class="muted">Type your job title and yearly salary, then press Check my pay.</p>'; return; }
    out.innerHTML = '<p class="muted">Checking live adverts…</p>';
    try {
      const r = await fetch(PAY_CHECK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...v, country: us ? 'US' : 'GB' }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Please try again.');
      out.innerHTML = `<div style="padding:14px 16px;border-radius:10px;background:${j.level === 'under' || j.level === 'below' ? '#fff7ed' : j.level === 'unknown' ? '#f8fafc' : '#f0fdf4'};border:1px solid var(--border,#e5e2da)">
          <div style="font-size:18px;font-weight:700;margin-bottom:4px">${esc(j.headline)}</div><div style="font-size:14.5px;line-height:1.5">${esc(j.detail)}</div>
          ${j.tooFew ? '' : `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">${[['Lower', j.low], ['Middle', j.mid], ['Upper', j.high]].map(([l, n]) => `<div style="flex:1;min-width:90px;text-align:center;background:#fff;border:1px solid var(--border,#e5e2da);border-radius:8px;padding:8px 4px"><div class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase">${l}</div><div style="font-weight:700">${money(n)}</div></div>`).join('')}</div><div class="muted" style="font-size:12.5px;margin-top:6px">From ${j.n} live adverts with a real salary.</div>`}</div>
        ${(j.better || []).length ? `<div style="font-weight:600;margin:14px 0 2px">Example adverts that pay more than you</div><div class="muted" style="font-size:12.5px;margin-bottom:4px">From Reed and Adzuna, to compare pay. Job-AI applies on employers' own sites and NHS Jobs, so it may not apply to these ones.</div>${j.better.map((a) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--border,#e5e2da);font-size:14px"><span><a href="#" class="em-job" data-url="${esc(a.url)}">${esc(a.title)}</a> <span class="muted">${esc(a.company)}</span></span><strong>${money(a.pay)}</strong></div>`).join('')}` : ''}
        ${!cfg.MOVE.on && !j.tooFew && j.share >= 40 ? '<p style="margin:12px 0 0">Want Job-AI to apply to the ones that pay more? Turn on <strong>Only move for more money</strong> below.</p>' : ''}`;
      $$('.em-job').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTab(a.dataset.url); }));
    } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message || 'Something went wrong. Please try again.')}</p>`; }
  }
  $('#em-check').addEventListener('click', check);
  if (title && Number(salary) >= 5000) check();

  $('#mv-save').addEventListener('click', async () => {
    const v = read();
    if ($('#mv-on').checked && Number(v.salary) < 10000) { setSt('#mv-st', 'Type your salary now (above) to turn this on.', true); return; }
    await store.patch('profile', { moveForMore: { on: $('#mv-on').checked, current: Number(v.salary) || '', uplift: Number($('#mv-up').value), monthly: Number($('#mv-month').value), employer: $('#mv-emp').value.trim(), title: v.title, location: v.location } });
    await loadConfig();
    // Jobs already found or tailored before the mode went on must pass it too.
    let n = 0;
    if (cfg.MOVE.on) for (const j of await store.jobs()) {
      if (!['pending', 'cv_ready', 'awaiting_review'].includes(j.status)) continue;
      const why = cfg.moveCheck(j);
      if (why) { await store.updateJob(j.jobId, { status: 'skipped', reason: why }); n++; }
    }
    await VIEWS.earn();
    setSt('#mv-st', n ? `✓ Saved. ${n} waiting job${n === 1 ? '' : 's'} didn't pay enough, so they were skipped.` : '✓ Saved.');
  });
};

// ── Setup: License ───────────────────────────────────────────────────────────
VIEWS.license = async function renderLicense() {
  const { license } = await loadConfig();
  const active = licenceActive(license);
  // The saved key is never written back into the page; only its last 4 characters are shown.
  content.innerHTML = `
    <div class="page-header"><h2>License</h2><p>${active ? 'Your Job-AI licence. The same key works in the desktop app.' : 'Set up Job-AI to start your free trial, or add the key from your Job-AI welcome email.'}</p></div>
    ${active ? '' : `<div class="card" id="trial-card">
      <h3 style="margin:0 0 6px">Set up Job-AI</h3>
      <p class="muted" style="margin:0">Takes 2 minutes: your email, your CV and a few details. Free for 24 hours, no card needed. At the end you get a 6-digit code to type here.</p>
      <div class="ext-inline" style="margin-top:12px"><button class="primary" id="tr-setup">Set up Job-AI (2 minutes)</button></div>
      <div class="field" style="max-width:220px;margin-top:16px"><label>Got your code? Type it here</label><input id="tr-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></div>
      <div class="ext-inline"><button class="secondary" id="tr-go">Connect</button><span class="status-msg" id="tr-st"></span></div>
      <p class="muted" style="margin-top:12px"><a class="tracker-link" href="#" id="tr-mail-show">Lost your code? Email me one</a></p>
      <div id="tr-mail" hidden><div class="field" style="max-width:320px"><label>The email you set up with</label><input id="tr-email" type="email" autocomplete="email" placeholder="you@example.com"></div>
      <div class="ext-inline"><button class="secondary" id="tr-send">Send code</button><span class="status-msg" id="tr-mail-st"></span></div></div>
    </div>`}
    ${active && license.status === 'trial' ? `<div class="card"><h3 style="margin:0 0 6px">Subscribe</h3>
      <p class="muted" style="margin:0 0 12px">No need to wait for your trial to end. Pick a plan and your key, settings and CV stay the same. First month half price.</p>
      <button class="primary" id="lic-keep">Subscribe now</button></div>`
      : !active && license.key && license.status !== 'device_trial_used' ? `<div class="card"><h3 style="margin:0 0 6px">Keep Job-AI</h3>
      <p class="muted" style="margin:0 0 12px">Your access has ended. Pick a plan and your agents start again with the same key, settings and CV. First month half price.</p>
      <button class="primary" id="lic-keep">Choose a plan</button></div>` : ''}
    <div class="card">${active ? '' : '<h3 style="margin:0 0 6px">Already have a key?</h3>'}
      ${license.key ? `<div class="stat-row"><span class="stat-label">Key</span><span class="stat-value">•••• ${esc(license.key.slice(-4))}</span></div>
      <div class="stat-row"><span class="stat-label">Status</span><span class="stat-value">${active ? (license.status === 'trial' ? 'Free trial' : 'Active') : license.status === 'device_trial_used' ? 'Trial already used on this device' : 'Not active'}</span></div>
      ${license.expiresAt ? `<div class="stat-row"><span class="stat-label">${active ? 'Renews / ends' : 'Ended'}</span><span class="stat-value">${esc(new Date(license.expiresAt).toLocaleDateString('en-GB'))}</span></div>` : ''}` : ''}
      <div class="field" style="max-width:460px;margin-top:12px"><label>${license.key ? 'Replace key' : 'License key'}</label><input id="lic" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key"></div>
      <div class="ext-inline"><button class="primary" id="lic-save">Activate</button>${license.key ? '<button class="secondary" id="lic-remove">Remove key</button>' : ''}<span class="status-msg" id="lic-st"></span></div>
    </div>
    ${license.key ? `<div class="card"><h3 style="margin:0 0 6px">Subscription</h3>
      <p class="muted" style="margin:0 0 12px">Update your payment details, view invoices, or cancel your subscription in Stripe's secure portal.</p>
      <div class="ext-inline"><button class="secondary" id="manage-sub">Manage or cancel subscription →</button><span class="status-msg" id="manage-st"></span></div></div>` : ''}
    ${globalThis.__jobaiClient === 'android' || !active ? '' : `<div class="card" id="phone-card">
      <h3 style="margin:0 0 6px">Set up from my phone</h3>
      <p class="muted">Set up on your phone at tryjobai.com/start? Type the 6-digit code it shows. Your licence, CV and details come straight in.</p>
      <div class="field" style="max-width:220px;margin-top:12px"><label>Code</label><input id="ph-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456"></div>
      <div class="ext-inline"><button class="primary" id="ph-go">Bring in my setup</button><span class="status-msg" id="ph-st"></span></div>
      <p class="muted" style="margin-top:12px">No code? <a class="tracker-link" href="#" id="ph-mail-show">Email me a code</a></p>
      <div id="ph-mail" hidden><div class="field" style="max-width:320px"><label>Your email</label><input id="ph-email" type="email" autocomplete="email" placeholder="you@example.com"></div>
      <div class="ext-inline"><button class="secondary" id="ph-send">Send code</button><span class="status-msg" id="ph-mail-st"></span></div></div>
    </div>`}`;
  $('#lic-keep')?.addEventListener('click', () => openTab(`https://tryjobai.com/pricing?lk=${encodeURIComponent(license.key)}&utm_source=extension&utm_campaign=licence_page`));
  // Same as the app: open Stripe's billing portal for this licence.
  $('#manage-sub')?.addEventListener('click', async () => {
    const b = $('#manage-sub'); b.disabled = true; setSt('#manage-st', 'Opening secure billing portal…');
    try {
      const r = await fetch(BACKEND + '/billing-portal', { method: 'POST', headers: { Authorization: 'Bearer ' + license.key, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.url) { openTab(j.url); setSt('#manage-st', 'Opened in a new tab. Manage or cancel there.'); }
      else setSt('#manage-st', j.error === 'no_subscription' ? 'No paid subscription is linked to this licence (trials have nothing to cancel).' : 'Could not open the billing portal. Please try again.', true);
    } catch (_) { setSt('#manage-st', 'Could not reach the server. Check your connection and try again.', true); }
    b.disabled = false;
  });
  $('#lic-save').addEventListener('click', async () => {
    const k = $('#lic').value.trim();
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(k)) { setSt('#lic-st', 'That does not look like a Job-AI key.', true); return; }
    setSt('#lic-st', 'Checking…');
    try {
      const r = await checkLicense(k);
      if (!r.ok) { setSt('#lic-st', r.http === 401 ? 'That key was not recognised.' : r.error === 'device_trial_used' ? 'This device has already used a free trial.' : /expired|inactive/.test(r.error) ? 'That licence has ended. Renew it to carry on.' : 'Could not check the key (' + r.http + ').', true); return; }
      await store.set('license', { key: k, status: r.licenseStatus || 'active', expiresAt: r.expires_at, checkedAt: Date.now() });
      checkSteps();
      $('#lic').value = '';
      globalThis.__jobaiLicense = k;
      setSt('#lic-st', `✓ Active${r.expires_at ? ' until ' + new Date(r.expires_at).toLocaleDateString('en-GB') : ''}.`);
      setTimeout(renderLicense, 900);
    } catch (e) { setSt('#lic-st', 'Could not reach Job-AI. Check your connection.', true); }
  });
  wirePhoneSetup();
  wireTrialCard();
  $('#lic-remove') && $('#lic-remove').addEventListener('click', async () => {
    if (!confirm('Remove the licence key from this browser? The agents stop until you add it again.')) return;
    Object.values(agents).forEach((a) => a.stop());
    await store.set('license', { key: '' }); globalThis.__jobaiLicense = '';
    renderLicense();
  });
};

// "Set up Job-AI": the setup page gives a 6-digit code that brings in the licence, CV and
// details. Lost the code? Email one (a new email still gets a trial, as a fallback).
function wireTrialCard() {
  if (!$('#trial-card')) return;
  $('#tr-setup').addEventListener('click', openSetup);
  $('#tr-mail-show').addEventListener('click', (e) => { e.preventDefault(); $('#tr-mail').hidden = false; $('#tr-email').focus(); });
  const send = async () => {
    const em = $('#tr-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setSt('#tr-mail-st', 'That email does not look right.', true); return; }
    $('#tr-send').disabled = true; setSt('#tr-mail-st', 'Sending…');
    let r; try { r = await sendSetupCode(em); } catch (_) { r = { ok: false }; }
    $('#tr-send').disabled = false; setSt('#tr-mail-st', codeSentMsg(r, em), !r.ok);
    if (r.ok) { $('#tr-mail').hidden = true; setSt('#tr-st', codeSentMsg(r, em)); $('#tr-code').focus(); }
  };
  const go = async () => {
    $('#tr-go').disabled = true;
    const done = await claimPhoneSetup($('#tr-code').value, (t, err) => setSt('#tr-st', t, err));
    $('#tr-go').disabled = false;
    if (done) setTimeout(() => navigate('dashboard'), 1500);
  };
  $('#tr-send').addEventListener('click', send);
  $('#tr-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#tr-go').addEventListener('click', go);
  $('#tr-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// "Set up from my phone": bring in the licence, CV and details from tryjobai.com/start.
function wirePhoneSetup(rerender) {
  if (!$('#phone-card')) return;
  $('#ph-mail-show').addEventListener('click', (e) => { e.preventDefault(); $('#ph-mail').hidden = false; $('#ph-email').focus(); });
  $('#ph-send').addEventListener('click', async () => {
    const em = $('#ph-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setSt('#ph-mail-st', 'That email does not look right.', true); return; }
    setSt('#ph-mail-st', 'Sending…');
    try { const r = await sendSetupCode(em); setSt('#ph-mail-st', codeSentMsg(r, em), !r.ok); }
    catch (_) { setSt('#ph-mail-st', 'Could not reach Job-AI. Check your connection.', true); }
  });
  $('#ph-go').addEventListener('click', async () => {
    if (await claimPhoneSetup($('#ph-code').value, (t, err) => setSt('#ph-st', t, err))) setTimeout(() => navigate('dashboard'), 1500);
  });
}

// Bring in what the user set up on their phone (tryjobai.com/start): licence, details and CV.
// say(text, isError) shows progress. Returns true when the licence is active.
function codeSentMsg(r, em) {
  if (r.ok) return `Code sent to ${em}. Type it here. Not there? Check spam.`;
  if (r.error === 'ended') return 'That email has already had a free trial. Subscribe at tryjobai.com to carry on.';
  if (r.suggest) return `Did you mean ${r.suggest}? Check your email and try again.`;
  if (r.error === 'disposable_email') return 'Please use your normal email address.';
  if (r.error === 'too_many_trials' || r.http === 429) return 'Too many tries. Wait a few minutes.';
  return 'Could not send. Check your connection and try again.';
}
async function claimPhoneSetup(raw, say) {
  {
    const code = String(raw || '').replace(/\D/g, '');
    if (code.length !== 6) { say('The code is 6 numbers.', true); return false; }
    say('Bringing in your setup…');
    let r;
    try { r = await claimSetup(code); } catch (_) { say('Could not reach Job-AI. Check your connection.', true); return false; }
    if (!r.ok) { say(r.http === 404 ? 'That code is wrong or has run out. Ask for a new one.' : r.http === 429 ? 'Too many tries. Wait a few minutes.' : 'Could not use the code (' + r.http + ').', true); return false; }
    // Details and CV first: they are the user's own and the server has now deleted its copy.
    const got = [];
    if (r.setup && r.setup.profile) {
      const P = r.setup.profile, out = {};
      for (const k of ['firstName', 'middleName', 'lastName', 'email', 'phone', 'location', 'linkedin', 'yearsExperience']) if (P[k]) out[k] = P[k];
      if ((P.searchTerms || []).length) out.searchTerms = P.searchTerms.slice(0, 40);
      if ((P.workTypePriority || []).length) out.workTypePriority = P.workTypePriority;
      // The "Questions employers ask" answers (only once the phone setup asked them).
      if (P.answered) {
        const cap = { male: 'Male', female: 'Female', nonbinary: 'Non-binary', white: 'White', mixed: 'Mixed', asian: 'Asian', black: 'Black', arab: 'Arab', other: 'Other', no: 'No', yes: 'Yes' };
        Object.assign(out, {
          rightToWorkCountries: P.rightToWorkCountries || 'United Kingdom', requiresSponsorship: !!P.requiresSponsorship, availability: P.availability || 'immediately',
          salaryExpectation: P.salaryExpectation || '', drivingLicence: !!P.drivingLicence, willingToRelocate: !!P.willingToRelocate,
          eeoGender: cap[P.eeoGender] || '', eeoEthnicity: cap[P.eeoEthnicity] || '', eeoDisability: cap[P.eeoDisability] || '',
        });
      }
      if (Object.keys(out).length) { await store.patch('profile', out); got.push('details'); }
      // NHS: jobs and qualifications read from the CV, referees typed on the phone. Only fills blanks.
      if (P.wantsNhs || r.setup.trac) {
        const T = r.setup.trac || {}, t = { ...((await store.get('trac')) || {}) };
        const blank = (k, v) => { if (v && !t[k]) t[k] = v; };
        blank('firstName', P.firstName); blank('lastName', P.lastName); blank('email', P.email); blank('mobile', P.phone); blank('city', P.location);
        for (const [k, v] of Object.entries(T)) {
          if (k === 'fromCv' || k === 'imported') continue;
          if (Array.isArray(v)) { if (v.length && !(t[k] || []).length) t[k] = v; } else blank(k, v);
        }
        if (!(t.searchTerms || []).length && (P.searchTerms || []).length) t.searchTerms = P.searchTerms.slice(0, 40);
        await store.set('trac', t);
        await store.patch('settings', { wantsNhs: true });
      }
      // Federal jobs chosen on the phone (USA): the two answers the federal resume uses.
      if (P.wantsFederal) await store.patch('settings', { wantsFederal: true, federal: { usCitizen: P.federal && P.federal.usCitizen || '', hoursPerWeek: (P.federal && P.federal.hoursPerWeek) || 40 } });
    }
    if (r.setup && r.setup.cv && r.setup.cv.text) {
      const c = r.setup.cv;
      await store.set('cvs', [{ id: 'cv' + Date.now(), label: 'Main CV', name: c.name, type: c.type, text: c.text, dataB64: c.dataB64, ...(Array.isArray(c.roles) ? { roles: c.roles.slice(0, 8), keywords: (c.keywords || []).slice(0, 25) } : {}) }]);
      await store.set('cv', { name: c.name, type: c.type, text: c.text, dataB64: c.dataB64, ...(Array.isArray(c.roles) ? { roles: c.roles.slice(0, 8), keywords: (c.keywords || []).slice(0, 25) } : {}) });
      got.push('CV');
    }
    const lic = await checkLicense(r.key).catch(() => ({ ok: false, http: 0 }));
    if (lic.ok) await store.set('license', { key: r.key, status: lic.licenseStatus || 'active', expiresAt: lic.expires_at, checkedAt: Date.now() });
    globalThis.__jobaiLicense = lic.ok ? r.key : globalThis.__jobaiLicense;
    await loadConfig(); checkSteps();
    if (!lic.ok) { say((got.length ? `Your ${got.join(' and ')} came in, but ` : '') + (lic.error === 'device_trial_used' ? 'this computer has already used a free trial.' : 'the licence could not be activated.'), true); return false; }
    say(`✓ Done. Licence active${got.length ? ', and your ' + got.join(' and ') + ' are in' : ''}.`);
    return true;
  }
}

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
const TEXTS = [['firstName', 'Forename'], ['middleName', 'Middle name(s)'], ['lastName', 'Surname'], ['email', 'Email'], ['mobile', 'Mobile telephone'], ['address', 'Address'], ['city', 'City / town'], ['county', 'County'], ['postcode', 'Postcode'], ['country', 'Country'], ['ni', 'National Insurance number'], ['dob', 'Date of birth (DD/MM/YYYY)'], ['convictionDetails', 'Conviction details (only if you have unspent convictions)'], ['adjustments', 'Adjustments you need for an interview (if any)']];
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

// Federal jobs (USA), the counterpart of the NHS / Trac page: whether to apply for them and the
// two answers every federal resume needs.
VIEWS['federal-details'] = async function renderFederal() {
  const { settings } = await loadConfig();
  const f = settings.federal || {};
  content.innerHTML = `
    <div class="page-header"><h2>Federal jobs details</h2><p>Federal government jobs are on USAJOBS. Job-AI finds the ones that fit you and writes a 2-page federal resume for each. Saved on this device only.</p></div>
    <div class="card"><h3>Your USAJOBS account</h3>
      <p style="color:var(--text-muted);font-size:13px;margin:2px 0 12px">You need a USAJOBS account to apply. It is free and you sign in with Login.gov. You press Submit on USAJOBS yourself: Job-AI never applies for you there.</p>
      <label class="checkbox-label" style="margin:0 0 10px"><input type="checkbox" id="fd-on" ${settings.wantsFederal ? 'checked' : ''}><span>Apply for federal government jobs</span></label>
      <button class="secondary" id="fd-acct">Create a USAJOBS account</button></div>
    <div class="card"><h3>Questions for your federal resume</h3>
      <div class="field"><label for="fd-cit">Are you a U.S. citizen? Most federal jobs need it.</label><select id="fd-cit"><option value="">Choose</option><option value="yes" ${f.usCitizen === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${f.usCitizen === 'no' ? 'selected' : ''}>No</option></select></div>
      <div class="field"><label for="fd-hrs">Hours per week in your jobs</label><input id="fd-hrs" type="number" min="1" max="80" value="${esc(f.hoursPerWeek || 40)}" style="max-width:120px"></div>
      <div class="ext-inline"><button class="primary" id="fd-save">Save</button><span class="status-msg" id="fd-st"></span></div></div>`;
  $('#fd-acct').addEventListener('click', () => openTab('https://www.usajobs.gov/'));
  $('#fd-save').addEventListener('click', async () => {
    const on = $('#fd-on').checked, cit = $('#fd-cit').value;
    if (on && !cit) { setSt('#fd-st', 'Please say if you are a U.S. citizen.', true); return; }
    await store.patch('settings', { wantsFederal: on, federal: { ...f, usCitizen: cit, hoursPerWeek: Math.min(80, Math.max(1, parseInt($('#fd-hrs').value, 10) || 40)) } });
    if (!on) agents.usajobs.stop();
    setSt('#fd-st', 'Saved.');
  });
};

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
const TOUR_STEPS_SETUP = [
  { view: 'cvs', title: 'Step 1: Upload your CV', tip: 'Start here. We read your CV and fill in your name, contact details, experience and the job titles to search for. Upload it as a Word document (.docx) for the best results. PDF also works. Before each application, the AI rewrites your summary and bullet points to match that specific job.', action: 'Click "Add CV" and choose your CV. It is read on this device and never uploaded.' },
  { view: 'personal', title: 'Step 2: Check your details', tip: 'Your name, email, phone, location and right to work status are used to fill in application forms automatically. The more complete this page is, the fewer forms the agents leave blank.', action: 'If you uploaded your CV, most of this is already filled in. Check it, complete anything missing and click Save.' },
  { view: 'search', title: 'Step 3: Search preferences', tip: 'Add the job titles you want to apply for, for example "IT Support Analyst". The agents use these terms to find jobs on company career sites. Have a Reed or LinkedIn account? You can also tick it under Extra job sites.', action: 'Add at least one job title, set your work type, then click Save.' },
  { view: 'license', title: 'Step 4: Activate your license', tip: 'Enter the license key from your welcome email. The AI that tailors your CV runs on our cloud, so there is nothing extra to install.', action: 'Paste your license key into the box and click Activate.' },
  { view: 'dashboard', title: 'Step 5: Your agents', tip: 'The Company Sites agent finds jobs on employers\' own career pages and applies there directly, so there are no job site accounts to sign in to.', action: 'Leave Company Sites ticked. In the UK you also see the NHS (Trac) agent: keep it ticked if you want NHS jobs.' },
  { view: 'dashboard', title: 'All set: start applying', tip: 'Click Start applying and each agent opens its own minimised Chrome window and works inside it: searching, tailoring your CV and applying to matching jobs.', action: 'Leave those windows alone and keep this Job-AI tab open. It is pinned so you do not close it by mistake. Closing it stops the agents.' },
  { view: 'trac-details', title: 'NHS jobs: the Trac Agent', tip: 'NHS jobs use a separate system called Trac with much longer forms, so the NHS agent has its own page: employment history, references, education and the monitoring questions.', action: 'Open "NHS / Trac details" and fill it in once, or click "Upload completed Trac PDF" to fill it from an old application. Then sign in to Trac with the button on the NHS agent card.' },
];
// After a phone setup the pages are already filled in, so this tour is about using Job-AI.
const USE_TOUR = (nhs) => [
  { view: 'dashboard', title: 'Start applying', tip: 'The Company Sites agent finds jobs on employers\' own websites, tailors your CV to each one and applies there. There are no job site accounts to sign in to. Press Start applying and it works in its own minimised Chrome window.', action: 'Leave those windows alone and keep this Job-AI tab open. It is pinned so you do not close it by mistake. Closing it stops the agents.' },
  { view: 'tracker', title: 'See every application', tip: 'The Tracker lists every job your agents found and what happened to it, with the reason for anything they skipped.', action: 'Check it any time. Anything that needs you shows at the top of the Dashboard.' },
  ...(nhs ? [{ view: 'trac-details', title: 'NHS jobs', tip: 'NHS applications go through Trac. We filled in your jobs and qualifications from your CV. Trac forms also ask for your address, referees and a few declarations.', action: 'Check this page, add anything missing and click Save. Then sign in to Trac from the NHS agent card. Finished forms wait as "Ready to submit" unless you turn on Submit for me.' }] : []),
  { view: 'dashboard', title: 'Control it from your phone', tip: 'Open tryjobai.com/app on your phone to start and stop your agents, get a notification for each application, submit NHS forms and change your job search.', action: 'On iPhone, add it to your Home Screen to get notifications. Keep this computer on and Chrome open while the agents work.' },
];
function startTour(steps = TOUR_STEPS_SETUP, onDone = null) {
  // No NHS page in the tour for people who didn't ask for NHS jobs.
  const nhsNav = $('#nav-setup [data-view="trac-details"]');
  const TOUR_STEPS = nhsNav && nhsNav.style.display === 'none' ? steps.filter((t) => t.view !== 'trac-details') : steps;
  let step = 0;
  const end = () => { const p = $('#tour-panel'); if (p) p.remove(); store.patch('settings', { tourDone: true }); navigate('dashboard'); if (onDone) onDone(); };
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
      <div class="tour-nav"><button class="tour-skip" id="tour-skip">Skip tour</button><button class="tour-next" id="tour-next">${last ? (steps === TOUR_STEPS_SETUP ? 'Finish setup' : 'Done') : 'Next'}</button></div></div>`;
    document.body.appendChild(panel);
    $('#tour-next').onclick = () => { if (last) end(); else { step++; show(); } };
    $('#tour-skip').onclick = end;
  };
  show();
}
const PC_UK = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/i;
const ZIP_US = /\b\d{5}(?:-\d{4})?\b/;
// Reopen the in-tab setup (welcome box) from the dashboard banner or the Licence page.
async function openSetup() { await store.patch('settings', { welcomeSeen: false }); initOnboarding(); }
async function initOnboarding() {
  const s = await store.get('settings');
  if (s.welcomeSeen) return;
  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.innerHTML = `<div class="welcome-modal"><div class="welcome-logo"></div>
    <h2>Welcome to Job-AI</h2>
    <p>Your automated job application assistant, right inside Chrome. Set it up once and the agents search, tailor your CV, and apply to jobs for you.</p>
    <div class="welcome-features">
      <div class="welcome-feature"><strong>Company Sites</strong><span>Applies on employers' own career pages. No job site accounts needed</span></div>
      <div class="welcome-feature"><strong>AI CV Tailoring</strong><span>Every CV is rewritten to match the job before it is sent</span></div>
      <div class="welcome-feature"><strong>Private</strong><span>Your details and CV stay in this browser, on this device</span></div>
      <div class="welcome-feature"><strong>Auto Apply</strong><span>Fills the forms, attaches your tailored CV, and submits for you</span></div>
    </div>
    ${globalThis.__jobaiClient === 'android' ? '' : `<div class="welcome-phone" id="w-setup-box" style="text-align:left;background:var(--surface-alt,#fbf9f4);border:1px solid var(--border,#e6e1d6);border-radius:9px;padding:16px;margin:18px 0 6px">
      <div id="ws-n" style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#4a453b)">Step 1 of 4</div>
      <div id="ws-email">
        <strong style="display:block;margin-top:4px">Start your free 7-day trial</strong>
        <span style="display:block;font-size:13.5px;color:var(--text-muted,#4a453b);margin:4px 0 10px">No card needed. We'll email you a 6-digit code.</span>
        <div style="display:flex;gap:8px"><input id="w-email" type="email" autocomplete="email" placeholder="you@email.com" aria-label="Your email" style="flex:1;min-width:0"><button class="primary" id="w-send" style="white-space:nowrap">Email me a code</button></div>
        <p style="margin:8px 0 0;font-size:13px"><a href="#" id="w-havecode" class="tracker-link">Already have a code?</a></p>
      </div>
      <div id="ws-code" hidden>
        <strong style="display:block;margin-top:4px">Type the code we emailed you</strong>
        <span id="ws-code-sub" style="display:block;font-size:13.5px;color:var(--text-muted,#4a453b);margin:4px 0 10px">It's in the subject line of the email. Not there? Check spam or junk.</span>
        <div style="display:flex;gap:8px"><input id="w-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" aria-label="6-digit code" style="flex:1;min-width:0;font-size:20px;letter-spacing:4px;text-align:center"><button class="primary" id="w-go" style="white-space:nowrap">Continue</button></div>
        <p style="margin:8px 0 0;font-size:13px"><a href="#" id="w-back" class="tracker-link">Use a different email</a></p>
      </div>
      <div id="ws-cv" hidden>
        <strong style="display:block;margin-top:4px">Add your CV</strong>
        <span style="display:block;font-size:13.5px;color:var(--text-muted,#4a453b);margin:4px 0 10px">We read it to fill in your details and find jobs that fit you. PDF or Word.</span>
        <button class="primary" id="w-cv" style="width:100%">Choose my CV</button>
      </div>
      <div id="ws-check" hidden>
        <strong style="display:block;margin-top:4px">Check these and you're done</strong>
        <span style="display:block;font-size:13.5px;color:var(--text-muted,#4a453b);margin:4px 0 10px">Filled in from your CV. Change anything that's wrong.</span>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px">
          <div class="field" style="margin-bottom:10px"><label for="wc-first">First name</label><input id="wc-first" autocomplete="given-name"></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-last">Last name</label><input id="wc-last" autocomplete="family-name"></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-phone">Phone</label><input id="wc-phone" type="tel" autocomplete="tel"></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-region">Find jobs in</label><select id="wc-region"><option value="uk">The UK</option><option value="us">The USA</option></select></div>
          <div class="field" style="margin-bottom:10px;grid-column:1 / -1"><label for="wc-street">Home address (house number and street)</label><input id="wc-street" autocomplete="address-line1"></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-town">Town or city</label><input id="wc-town" autocomplete="address-level2"></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-postcode" id="wc-postcode-l">Postcode</label><input id="wc-postcode" autocomplete="postal-code"></div>
          <div class="field" id="wc-state-row" style="margin-bottom:10px"><label for="wc-state">State</label><select id="wc-state" autocomplete="address-level1"><option value="">Choose your state</option>${Object.entries(US_STATE_NAMES).map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-notice">Notice period</label><select id="wc-notice">${[['immediately', 'Can start now'], ['1week', '1 week'], ['2weeks', '2 weeks'], ['1month', '1 month'], ['2months', '2 months'], ['3months', '3 months']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-salary" id="wc-salary-l">Lowest salary (£ a year)</label><input id="wc-salary" inputmode="numeric" placeholder="e.g. 30000"></div>
          ${CLEARANCE.map(([k, l, o]) => `<div class="field wc-clear" style="margin-bottom:10px${k === 'ukResidence' ? ';grid-column:1 / -1' : ''}"><label for="wc-${k}">${l}</label><select id="wc-${k}">${o.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`).join('')}
        </div>
        <p class="wc-clear" style="font-size:12.5px;color:var(--text-muted,#4a453b);margin:-4px 0 10px">Security clearance questions some UK employers ask. Leave as Not set to skip those jobs.</p>
        <p style="font-size:12.5px;color:var(--text-muted,#4a453b);margin:0 0 10px">Employers' forms ask for these. With them filled in, Job-AI can send your applications without stopping to ask you.</p>
        <div class="field" style="margin-bottom:8px"><label for="wc-titles">Job titles to apply for, separated by commas</label><textarea id="wc-titles" rows="3" style="width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--border-strong,var(--border));border-radius:8px;background:var(--surface,#fff);color:var(--text);resize:vertical"></textarea></div>
        <div class="field" style="margin-bottom:10px"><label>Where you want to work</label><div class="tracd-sectors">${[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']].map(([v, l]) => `<label class="sector-chip"><input type="checkbox" class="wc-wt" value="${v}"><span>${l}</span></label>`).join('')}</div></div>        <label style="font-size:13.5px;display:flex;gap:8px;align-items:center;margin:4px 0 14px;cursor:pointer"><input type="checkbox" id="wc-sponsor" style="width:16px;height:16px;margin:0"> <span id="wc-sponsor-l">I need visa sponsorship to work in the UK</span></label>
        <label style="font-size:13.5px;display:flex;gap:8px;align-items:center;margin:-8px 0 14px;cursor:pointer"><input type="checkbox" id="wc-licence" style="width:16px;height:16px;margin:0"> <span>I have a full driving licence</span></label>
        <label id="wc-nhs-row" style="font-size:13.5px;display:flex;gap:8px;align-items:center;margin:-8px 0 14px;cursor:pointer"><input type="checkbox" id="wc-nhs" style="width:16px;height:16px;margin:0"> <span>Also apply for NHS jobs (needs a Trac account)</span></label>
        <label id="wc-fed-row" style="font-size:13.5px;display:none;gap:8px;align-items:center;margin:-8px 0 14px;cursor:pointer"><input type="checkbox" id="wc-fed" style="width:16px;height:16px;margin:0"> <span>Also apply for federal government jobs (needs a USAJOBS account)</span></label>
        <div id="wc-fed-q" style="display:none;grid-template-columns:1fr 1fr;gap:0 10px;margin:-4px 0 12px">
          <div class="field" style="margin-bottom:10px"><label for="wc-fed-cit">Are you a U.S. citizen?</label><select id="wc-fed-cit"><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></div>
          <div class="field" style="margin-bottom:10px"><label for="wc-fed-hrs">Hours per week in your jobs</label><input id="wc-fed-hrs" type="number" min="1" max="80" value="40"></div>
        </div>
        <button class="primary" id="w-done" style="width:100%">Find me jobs</button>
      </div>
      <div class="status-msg" id="w-st" style="margin-top:8px"></div></div>
      <p style="margin:14px 0 8px;font-size:14px;color:var(--text-muted,#4a453b)">Or look around first:</p>`}
    <div class="welcome-actions"><button class="${globalThis.__jobaiClient === 'android' ? 'primary' : 'secondary'}" id="w-tour">Take the setup tour &rarr;</button><button class="welcome-skip-link" id="w-skip">I&rsquo;ll set up myself</button></div></div>`;
  document.body.appendChild(overlay);
  const dismiss = () => { overlay.remove(); store.patch('settings', { welcomeSeen: true }); };
  $('#w-tour').addEventListener('click', () => {
    dismiss();
    // Took the tour before setting up: bring the setup back at the end if it still isn't done.
    startTour(TOUR_STEPS_SETUP, async () => {
      const [license, cv] = await Promise.all([store.get('license'), store.get('cv')]);
      if (!licenceActive(license) || !(cv && cv.text)) openSetup();
    });
  });
  $('#w-skip').addEventListener('click', dismiss);
  if ($('#w-setup-box')) {
    // Setup in four steps, all in this tab: email, the emailed code (starts the trial), CV, a quick check.
    const STEPS = ['ws-email', 'ws-code', 'ws-cv', 'ws-check'];
    const step = (id) => {
      STEPS.forEach((x) => { $('#' + x).hidden = x !== id; });
      // Past the first step the feature boxes and intro just push the form off small screens.
      $$('.welcome-features, .welcome-modal > p').forEach((el) => { el.style.display = id === 'ws-email' ? '' : 'none'; });
      $('#ws-n').textContent = `Step ${STEPS.indexOf(id) + 1} of 4`;
      setSt('#w-st', '');
      const f = $('#' + id + ' input'); if (f) f.focus();
    };
    const send = async () => {
      const em = $('#w-email').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { setSt('#w-st', 'That email does not look right.', true); return; }
      $('#w-send').disabled = true; setSt('#w-st', 'Sending…');
      let r; try { r = await sendSetupCode(em); } catch (_) { r = { ok: false }; }
      $('#w-send').disabled = false;
      if (!r.ok) { setSt('#w-st', codeSentMsg(r, em), true); return; }
      $('#ws-code-sub').textContent = `Sent to ${em}. It's in the subject line of the email. Not there? Check spam or junk.`;
      $('#w-code').value = ''; step('ws-code');
    };
    const showCheck = async () => {
      const [{ profile: P }, st] = await Promise.all([loadConfig(), store.get('settings')]);
      $('#wc-first').value = P.firstName || ''; $('#wc-last').value = P.lastName || ''; $('#wc-phone').value = P.phone || '';
      $('#wc-titles').value = (P.searchTerms || []).join(', ');
      $('#wc-region').value = isUS(st) ? 'us' : 'uk';
      $('#wc-sponsor').checked = !!P.requiresSponsorship;
      const wt = (P.workTypePriority || []).length ? P.workTypePriority : ['remote', 'hybrid', 'onsite'];
      $$('.wc-wt').forEach((c) => { c.checked = wt.includes(c.value); });      $('#wc-licence').checked = !!P.drivingLicence;
      $('#wc-nhs').checked = !!st.wantsNhs;
      const F = st.federal || {};
      $('#wc-fed').checked = !!st.wantsFederal; $('#wc-fed-cit').value = F.usCitizen || ''; $('#wc-fed-hrs').value = F.hoursPerWeek || 40;
      const fedQ = () => { $('#wc-fed-q').style.display = $('#wc-region').value === 'us' && $('#wc-fed').checked ? 'grid' : 'none'; };
      $('#wc-fed').onchange = fedQ;
      // The stored address is one line, "street, postcode" (the form filler splits it the same way).
      const addr = String(P.address || '').trim();
      const pc = (addr.match(PC_UK) || addr.match(ZIP_US) || [''])[0];
      $('#wc-street').value = addr.replace(pc, '').replace(/[\s,]+$/, '').trim();
      $('#wc-postcode').value = pc.toUpperCase();
      $('#wc-town').value = String(P.location || '').split(',')[0].trim();
      $('#wc-state').value = usStateOf(`${P.location || ''}, ${P.address || ''}`);
      $('#wc-notice').value = P.availability || 'immediately';
      $('#wc-salary').value = String(P.salaryExpectation || '').replace(/[^0-9]/g, '');
      $('#wc-britishCitizen').value = P.britishCitizen || ''; $('#wc-ukResidence').value = P.ukResidence || '';
      attachAutofill().catch(() => {});
      const where = () => {
        const us = $('#wc-region').value === 'us';
        $('#wc-sponsor-l').textContent = `I need visa sponsorship to work in the ${us ? 'USA' : 'UK'}`;
        $('#wc-postcode-l').textContent = us ? 'ZIP code' : 'Postcode';
        $('#wc-salary-l').textContent = `Lowest salary (${us ? '$' : '£'} a year)`;
        $('#wc-nhs-row').style.display = us ? 'none' : 'flex';
        $('#wc-fed-row').style.display = us ? 'flex' : 'none'; fedQ();
        $('#wc-state-row').style.display = us ? '' : 'none';
        $$('.wc-clear').forEach((e) => { e.style.display = us ? 'none' : ''; });
      };
      $('#wc-region').onchange = where; where();
      step('ws-check');
    };
    const go = async () => {
      const b = $('#w-go'); b.disabled = true;
      const done = await claimPhoneSetup($('#w-code').value, (t, err) => setSt('#w-st', t, err));
      b.disabled = false;
      if (!done) return;
      // Set up on the phone already? The CV came with the code, so skip straight to the check.
      if ((await getCvs()).length) showCheck(); else step('ws-cv');
    };
    const finish = async () => {
      const titles = $('#wc-titles').value.split(',').map((t) => t.trim()).filter(Boolean);
      const first = $('#wc-first').value.trim(), last = $('#wc-last').value.trim(), phone = $('#wc-phone').value.trim();
      if (!first || !last) { setSt('#w-st', 'Please add your first and last name.', true); return; }
      if (!phone) { setSt('#w-st', 'Please add your phone number. Employers ask for it.', true); return; }
      if (!titles.length) { setSt('#w-st', 'Add at least one job title to apply for.', true); return; }
      const workTypes = $$('.wc-wt:checked').map((c) => c.value);
      if (!workTypes.length) { setSt('#w-st', 'Choose at least one: remote, hybrid or on-site.', true); return; }
      const region = $('#wc-region').value;
      const street = $('#wc-street').value.trim(), town = $('#wc-town').value.trim();
      const postcode = $('#wc-postcode').value.trim().toUpperCase();
      const salary = $('#wc-salary').value.replace(/[^0-9]/g, '');
      if (!street) { setSt('#w-st', 'Please add your home address. Many application forms ask for it.', true); return; }
      if (!town) { setSt('#w-st', 'Please add your town or city.', true); return; }
      const state = region === 'us' ? $('#wc-state').value : '';
      if (region === 'us' && !state) { setSt('#w-st', 'Please choose your state. Most US application forms ask for it.', true); return; }
      if (!(region === 'us' ? ZIP_US : PC_UK).test(postcode)) { setSt('#w-st', region === 'us' ? 'Please add a 5-digit ZIP code.' : 'Please add your postcode, like SW8 1BP.', true); return; }
      if (salary && (+salary < 5000 || +salary > 1000000)) { setSt('#w-st', 'Please type the salary as a yearly figure, like 30000.', true); return; }
      const fedOn = region === 'us' && $('#wc-fed').checked;
      if (fedOn && !$('#wc-fed-cit').value) { setSt('#w-st', 'Please say if you are a U.S. citizen. Most federal jobs need it.', true); return; }
      const country = region === 'us' ? 'United States' : 'United Kingdom';
      const { profile: P } = await loadConfig();
      const rtw = String(P.rightToWorkCountries || '').split(',').map((c) => c.trim()).filter(Boolean);
      const sponsor = $('#wc-sponsor').checked;
      await store.patch('profile', {
        firstName: first, lastName: last, phone, searchTerms: titles, requiresSponsorship: sponsor, workTypePriority: workTypes,        address: `${street}, ${postcode}`, availability: $('#wc-notice').value, drivingLicence: $('#wc-licence').checked,
        ...(region === 'uk' ? { britishCitizen: $('#wc-britishCitizen').value, ukResidence: $('#wc-ukResidence').value } : {}),
        ...(salary ? { salaryExpectation: salary } : {}),
        // Keep the county or state the CV gave ("Leeds, West Yorkshire") when the town is unchanged.
        // US: "Town, ST" so forms asking for the state get it.
        location: state ? `${town}, ${state}` : String(P.location || '').split(',')[0].trim().toLowerCase() === town.toLowerCase() ? P.location : town,
        // No sponsorship needed means they can already work there.
        rightToWorkCountries: (sponsor ? rtw.filter((c) => c !== country) : [...new Set([country, ...rtw])]).join(', '),
      });
      await setRegion(region);
      const nhs = region === 'uk' && $('#wc-nhs').checked;
      await store.patch('settings', { wantsNhs: nhs, wantsFederal: fedOn, ...(fedOn ? { federal: { ...((await store.get('settings')).federal || {}), usCitizen: $('#wc-fed-cit').value, hoursPerWeek: Math.min(80, Math.max(1, parseInt($('#wc-fed-hrs').value, 10) || 40)) } } : {}) });
      if (nhs) {
        // Start their Trac details from what they just checked. Only fills blanks.
        const t = { ...((await store.get('trac')) || {}) };
        const blank = (k, v) => { if (v && !t[k]) t[k] = v; };
        blank('firstName', first); blank('lastName', last); blank('email', P.email); blank('mobile', phone); blank('city', town);
        if (!(t.searchTerms || []).length) t.searchTerms = titles.slice(0, 40);
        await store.set('trac', t);
      }
      await loadConfig(); checkSteps();
      dismiss(); navigate('dashboard');
    };
    $('#w-send').addEventListener('click', send);
    $('#w-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    $('#w-havecode').addEventListener('click', (e) => { e.preventDefault(); $('#ws-code-sub').textContent = 'Type the 6-digit code from the Job-AI setup page or our email.'; step('ws-code'); });
    $('#w-back').addEventListener('click', (e) => { e.preventDefault(); step('ws-email'); });
    $('#w-go').addEventListener('click', go);
    $('#w-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#w-cv').addEventListener('click', () => pickCv('#w-st', () => showCheck()));
    $('#w-done').addEventListener('click', finish);
  }
}

// ── Phone control (tryjobai.com/app) ─────────────────────────────────────────
// This browser checks in with the backend and runs what the user taps on their phone: start
// all, stop all, or start/stop one agent, through the same licence gate as the buttons here.
// Each check-in waits on the server for up to 20s (no timers, which Chrome slows in background
// tabs), so a tap reaches this browser within a second or two. Not used on Android: there the
// phone is the computer.
// It also shares what needs the user, the applications list and the search settings (only when
// they change), so the phone can submit a ready NHS form, set a stage, or change settings.
const REMOTE_LABELS = { trac: 'NHS (Trac)', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'Company sites', usajobs: 'Federal (USAJOBS)' };
let remoteCtl = null, remoteNudgeT = null;
function remoteNudge() { clearTimeout(remoteNudgeT); remoteNudgeT = setTimeout(() => { if (remoteCtl) remoteCtl.abort(); }, 800); }
async function remoteGate() {
  const { license, profile, trac, settings } = await loadConfig();
  const cv = await store.get('cv');
  const base = licenceActive(license) && !!(cv && cv.text);
  const search = !!((profile.searchTerms || []).length);
  const tracOk = !!((trac.employment || []).length && (trac.references || []).length && (trac.searchTerms || []).length);
  const us = isUS(settings);
  const canRun = { trac: !us && base && tracOk, reed: !us && base && search, linkedin: base && search, indeed: us && base && search, dice: us && base && search, wellfound: us && base && search, ats: base && search, usajobs: us && base && search && !!settings.wantsFederal && !!(settings.federal || {}).usCitizen };
  for (const k of RETIRED) canRun[k] = false;
  const enabled = (k) => !settings.enabled || settings.enabled[k] !== false;
  return { license, cv, canRun, enabled };
}
async function remoteStatus() {
  const g = await remoteGate();
  const all = await store.jobs();
  const applied = await store.appliedToday(), cap = cfg.MAX_APPLICATIONS_PER_DAY;
  const SRC = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'Company site', usajobs: 'Federal' };
  const recent = all.filter((j) => ['applied', 'apply_failed', 'ready', 'ready_to_submit'].includes(j.status))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 12)
    .map((j) => ({ title: j.title || '', company: j.company || '', source: SRC[j.source] || '', status: j.status === 'applied' ? 'applied' : j.status === 'apply_failed' ? 'failed' : 'waiting', at: j.appliedAt || j.updatedAt || '', ...(j.status === 'apply_failed' && j.reason ? { reason: String(j.reason).slice(0, 140) } : {}), ...((j.status === 'applied' && cfg.movePay(j)) || {}) }));
  const skipReasons = {}; for (const j of all) if (j.status === 'skipped' && j.reason) { const r = String(j.reason).replace(/\(\d+%\)|\d+%/g, '').trim().slice(0, 80); skipReasons[r] = (skipReasons[r] || 0) + 1; }
  const blocked = !licenceActive(g.license) ? (g.license.key ? 'Your Job-AI access has ended. Subscribe to keep applying.' : 'Activate Job-AI in Chrome first.')
    : !(g.cv && g.cv.text) ? 'Add your CV in Job-AI first.' : applied >= cap ? `Today's limit of ${cap} applications is reached. Agents carry on tomorrow.` : '';
  return {
    awake: awakeHeld,
    agents: Object.keys(agents).filter((k) => !RETIRED.has(k)).map((k) => ({ key: k, label: REMOTE_LABELS[k], state: agents[k].running ? 'running' : 'stopped', enabled: g.enabled(k), canRun: g.canRun[k] })),
    applied_today: applied, daily_cap: cap,
    in_queue: all.filter((j) => ['pending', 'cv_ready', 'applying'].includes(j.status)).length,
    failed: all.filter((j) => j.status === 'apply_failed').length,
    needs_you: all.filter((j) => ['ready', 'ready_to_submit', 'awaiting_review'].includes(j.status) || (j.status === 'skipped' && /^Draft saved on Trac/.test(j.reason || ''))).length,
    recent, blocked,
    skipped: all.filter((j) => j.status === 'skipped').length,
    skip_reasons: Object.entries(skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, count]) => ({ reason, count })),
  };
}
const REMOTE_SITE = { trac: 'NHS', reed: 'Reed', linkedin: 'LinkedIn', indeed: 'Indeed', dice: 'Dice', wellfound: 'Wellfound', ats: 'Company site', usajobs: 'Federal' };
const REMOTE_STAGES = ['applied', 'phone_screen', 'interview', 'offer', 'rejected', 'withdrawn'];
const TRAC_LIST = 'https://apps.trac.jobs/applicationlist';
async function remoteExtra() {
  const { profile, settings } = await loadConfig();
  const all = await store.jobs();
  const newest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  const inbox = [];
  for (const j of all.filter((x) => x.source === 'trac' && (x.status === 'ready_to_submit' || (x.status === 'skipped' && /^Draft saved on Trac/.test(x.reason || '')))).sort(newest)) {
    const ready = j.status === 'ready_to_submit', ai = /asks about AI use/.test(j.reason || '');
    const missing = String(j.reason || '').replace(/^Draft saved on Trac\.?\s*Needs you:\s*/i, '').replace(/ This form asks about AI use.*$/, '').replace(/\.$/, '');
    inbox.push({
      id: j.jobId, kind: ready ? 'nhs_ready' : 'nhs_needs', title: String(j.title || '').split(' Band ')[0], company: j.company || 'NHS',
      note: ready ? (ai ? 'This form asks about AI use, so submit it yourself on Trac.' : 'Every section is complete. Read it, then submit.') : `Still needed: ${missing || 'check the draft'}. Fix it on Trac and Job-AI finishes the rest.`,
      url: /^https:\/\/apps\.trac\.jobs\//.test(j.draftUrl || '') ? j.draftUrl : TRAC_LIST, statement: ready ? (j.coverLetter || '') : '',
      ai_blocked: ready && ai, submitting: ready && !!j.submitApproved, at: j.updatedAt || '',
    });
  }
  for (const j of all.filter((x) => x.source === 'usajobs' && x.status === 'ready_to_submit').sort(newest)) {
    inbox.push({ id: j.jobId, kind: 'waiting', title: j.title || '', company: j.company || '', note: `Federal job${j.closes ? `, closes ${j.closes}` : ''}. Your federal resume is in Job-AI on your computer: download it there, then apply on USAJOBS.`, url: safeUrl(j.url) || '', at: j.updatedAt || '' });
  }
  for (const j of all.filter((x) => x.status === 'ready').sort(newest)) {
    inbox.push({ id: j.jobId, kind: 'waiting', title: j.title || '', company: j.company || '', note: 'Ready to send. On your computer, press Fill and open in Job-AI, check it and press Submit.', url: safeUrl(j.url) || '', at: j.updatedAt || '' });
  }
  const tracker = all.filter((j) => j.status === 'applied').sort((a, b) => String(b.appliedAt || b.updatedAt).localeCompare(String(a.appliedAt || a.updatedAt))).slice(0, 150)
    .map((j) => ({ id: j.jobId, title: j.title || '', company: j.company || '', source: REMOTE_SITE[j.source] || '', at: j.appliedAt || j.updatedAt || '', stage: REMOTE_STAGES.includes(j.stage) ? j.stage : 'applied', url: safeUrl(j.url) || '' }));
  const settingsOut = { terms: profile.searchTerms || [], work_types: profile.workTypePriority || ['remote', 'hybrid', 'onsite'], location: profile.searchLocation || '', nhs_submit: !!(settings.autoSubmit && settings.autoSubmit.trac), has_nhs: true,
    computer: { keep_awake: settings.keepAwake !== false, open_at_login: !!settings.openOnStartup, startup: 'chrome' } };
  return { inbox, tracker, stages: true, settings: settingsOut };
}
let remoteExtraSent = '', remoteExtraAt = 0, remoteExtraBuilt = 0;
async function remoteSyncExtra(force) {
  if (!force && Date.now() - remoteExtraBuilt < 15000) return;
  remoteExtraBuilt = Date.now();
  const extra = await remoteExtra();
  const json = JSON.stringify(extra);
  if (!force && json === remoteExtraSent && Date.now() - remoteExtraAt < 15 * 60 * 1000) return;
  const r = await remotePost('/v1/remote/sync', { client: 'extension', extra }).catch(() => null);
  if (r && r.ok) { remoteExtraSent = json; remoteExtraAt = Date.now(); }
}
function remoteRefreshView() { if (['dashboard', 'search', 'tracker'].includes(current) && !(document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) VIEWS[current](); }
async function remoteRun(c) {
  const p = c.payload || {};
  if (c.cmd === 'set_settings') {
    const terms = (p.terms || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 40);
    if (!terms.length) return { ok: false, message: 'Add at least one job title.' };
    const wt = (p.work_types || []).filter((w) => ['remote', 'hybrid', 'onsite'].includes(w));
    await store.patch('profile', { searchTerms: terms, ...(wt.length ? { workTypePriority: wt } : {}), ...(p.location ? { searchLocation: String(p.location).slice(0, 80) } : {}) });
    if (typeof p.nhs_submit === 'boolean') { const s = await store.get('settings'); await store.patch('settings', { autoSubmit: { ...(s.autoSubmit || {}), trac: p.nhs_submit } }); }
    await loadConfig(); remoteRefreshView();
    return { ok: true };
  }
  if (c.cmd === 'set_computer') {
    const fields = {};
    if (typeof p.keep_awake === 'boolean') fields.keepAwake = p.keep_awake;
    if (typeof p.open_at_login === 'boolean') fields.openOnStartup = p.open_at_login;
    await store.patch('settings', fields); await computerSync(); remoteRefreshView();
    return { ok: true };
  }
  if (c.cmd === 'set_stage') {
    if (!REMOTE_STAGES.includes(p.stage)) return { ok: false, message: 'Unknown stage.' };
    if (!(await store.hasJob(p.job_id))) return { ok: false, message: 'That application is not in this browser.' };
    await store.updateJob(p.job_id, { stage: p.stage }); remoteRefreshView();
    return { ok: true };
  }
  if (c.cmd === 'submit_nhs') {
    const j = (await store.jobs()).find((x) => x.jobId === p.job_id);
    if (!j || j.source !== 'trac' || j.status !== 'ready_to_submit' || /asks about AI use/.test(j.reason || '')) return { ok: false, message: 'That application is no longer ready to submit.' };
    await store.updateJob(j.jobId, { submitApproved: true });
    if (!agents.trac.running) {
      if (!(await recheckLicence())) return { ok: false, message: 'Your Job-AI access has ended. Subscribe to keep applying.' };
      runAgent('trac'); setTimeout(renderDashboard, 300);
    }
    return { ok: true };
  }
  const keys = c.cmd === 'start' || c.cmd === 'stop' ? [c.agent].filter((k) => agents[k]) : Object.keys(agents);
  if (!keys.length) return { ok: false, message: 'That agent is not in this browser.' };
  if (c.cmd === 'stop' || c.cmd === 'stop_all') { keys.forEach((k) => agents[k].stop()); setTimeout(renderDashboard, 300); return { ok: true }; }
  if (!(await recheckLicence())) return { ok: false, message: 'Your Job-AI access has ended. Subscribe to keep applying.' };
  if ((await store.capUsed()) >= cfg.MAX_APPLICATIONS_PER_DAY) return { ok: false, message: cfg.MOVE.on && (await store.monthLeft()) <= 0 ? "This month's limit for Only move for more money is reached." : `Today's limit of ${cfg.MAX_APPLICATIONS_PER_DAY} applications is already reached.` };
  const g = await remoteGate();
  const todo = keys.filter((k) => !agents[k].running && g.canRun[k] && (c.cmd === 'start' || g.enabled(k)));
  if (!todo.length) return keys.some((k) => agents[k].running) ? { ok: true } : { ok: false, message: 'Finish setting up that agent in Chrome first.' };
  todo.forEach(runAgent);
  setTimeout(renderDashboard, 300);
  return { ok: true };
}
async function remotePost(path, body, signal) {
  const r = await fetch(BACKEND + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...apiHeaders() }, body: JSON.stringify(body), signal: signal || AbortSignal.timeout(15000) });
  return r.ok ? r.json() : null;
}
(async function remoteLoop() {
  if (globalThis.__jobaiClient === 'android') return;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || (/Mac/.test(navigator.userAgent) ? 'Mac' : /CrOS/.test(navigator.userAgent) ? 'Chromebook' : 'Windows');
  const label = `Chrome on ${platform === 'macOS' ? 'Mac' : platform === 'Chrome OS' ? 'Chromebook' : platform}`;
  const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
  await pause(4000);
  for (;;) {
    if (!globalThis.__jobaiLicense) { await loadConfig().catch(() => {}); if (!globalThis.__jobaiLicense) { await pause(15000); continue; } }
    remoteCtl = new AbortController();
    const ctl = remoteCtl, t = setTimeout(() => ctl.abort(), 35000);
    let r = null;
    try { r = await remotePost('/v1/remote/heartbeat', { client: 'extension', label, status: await remoteStatus(), wait: 20 }, ctl.signal); }
    catch (_) { r = ctl.signal.aborted ? {} : null; }
    finally { clearTimeout(t); }
    if (!r) { await pause(15000); continue; }
    for (const c of r.commands || []) {
      let out; try { out = await remoteRun(c); } catch (e) { out = { ok: false, message: e.message }; }
      await remotePost('/v1/remote/ack', { id: c.id, ok: out.ok, message: out.message || '' }).catch(() => {});
    }
    await remoteSyncExtra((r.commands || []).length > 0).catch(() => {});
    if ((r.commands || []).length) await pause(1500);
  }
})();

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
    if (!greeted) { greeted = true; addHint('Hi! I can help you use Job-AI: why a job was skipped, search terms, CVs, limits and more. Ask me anything.'); }
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
  globalThis.__jobaiTest = { scoreJob, agent, agents, mods: { reed: require('../../bot/modules/reed'), linkedin: require('../../bot/modules/linkedin'), indeed: require('../../bot/modules/indeed'), dice: require('../../bot/modules/dice'), wellfound: require('../../bot/modules/wellfound'), ats: require('../../bot/modules/ats_filler'), feedJobs, fetchJD, fillAndOpen }, store, cfg, loadConfig, Page, vfs, vfsReady, trac: require('../../bot/modules/trac_source'), apply: require('../../bot/modules/trac_apply'), parseCV: require('../../bot/modules/cv_parser').parseCV, pdf: require('../../bot/modules/cv_pdf_writer') };
}

navigate('dashboard');
initOnboarding();
