// End-to-end check of the Android app on an emulator (run by android/test/run-test.sh in CI).
// Talks to the app's dashboard WebView over the DevTools protocol (debug builds only) and runs
// the SAME shared agent code as the extension: Reed search + job read, NHS/Trac search, and a
// company-site form filled with a generated CV (never submitted). Saves phone screenshots.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.env.OUT || 'android-out';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => { try { execSync(`adb exec-out screencap -p > ${OUT}/${name}.png`); console.log('screenshot', name); } catch (e) { console.log('screenshot failed', name, e.message); } };

async function targets() { return (await fetch('http://localhost:9222/json/list')).json(); }

async function connect() {
  let t;
  for (let i = 0; i < 60 && !t; i++) { t = (await targets().catch(() => [])).find((x) => /dashboard\.html/.test(x.url)); if (!t) await sleep(1000); }
  if (!t) throw new Error('dashboard target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  // Evaluate an async function body in the dashboard and return its value.
  const run = async (body, timeoutMs = 240000) => {
    const d = await Promise.race([
      send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ timeout: true })),
    ]);
    if (d.timeout) return { error: 'timed out' };
    if (d.result && d.result.exceptionDetails) return { error: d.result.exceptionDetails.exception ? d.result.exceptionDetails.exception.description : d.result.exceptionDetails.text };
    return d.result && d.result.result ? d.result.result.value : undefined;
  };
  return { run, close: () => ws.close() };
}

const SAMPLE_CV = `Alex Morgan
alex.morgan@example.com | 07700 900123 | Manchester, UK

PROFESSIONAL SUMMARY
IT support analyst with 4 years of experience supporting 300+ users across Windows, Microsoft 365 and networking.

EXPERIENCE
IT Support Analyst, Northwind Health, Manchester (Jan 2022 - Present)
- Resolved 40+ tickets a week across hardware, software and network issues, keeping SLA above 95%.
- Rolled out Windows 11 to 250 laptops with Intune, cutting setup time by 30%.
- Wrote 25 knowledge base articles that reduced repeat tickets by 18%.

Service Desk Technician, Contoso Retail, Salford (Jun 2020 - Dec 2021)
- First-line support for 12 stores by phone, email and remote tools.
- Managed Active Directory accounts, password resets and permissions.

EDUCATION
BSc Computer Science, University of Salford (2017 - 2020)

SKILLS
Windows 10/11, Microsoft 365, Active Directory, Intune, ServiceNow, TCP/IP, customer service`;

const results = {};
const c = await connect();
console.log('connected to dashboard');

// The page loaded, the chrome.* stand-in is in place and the test hook is ready.
results.boot = await c.run(`
  for (let i = 0; i < 60 && !globalThis.__jobaiTest; i++) await new Promise((r) => setTimeout(r, 500));
  return { hook: !!globalThis.__jobaiTest, chrome: !!(window.chrome && chrome.tabs && chrome.scripting), client: globalThis.__jobaiClient, version: chrome.runtime.getManifest().version };
`);
console.log('boot', JSON.stringify(results.boot));
await sleep(2000);
shot('01-welcome');

// Close the welcome card, add test details, then screenshot each page.
results.setup = await c.run(`
  const T = globalThis.__jobaiTest;
  const skip = document.querySelector('#w-skip'); if (skip) skip.click();
  await T.store.patch('profile', { firstName: 'Alex', lastName: 'Morgan', email: 'alex.morgan@example.com', phone: '07700900123', city: 'Manchester', searchTerms: ['IT Support'] });
  await T.store.set('cv', { name: 'Alex Morgan CV.pdf', text: ${JSON.stringify(SAMPLE_CV)}, type: 'pdf' });
  await T.loadConfig();
  return 'ok';
`);
const view = async (sel, name) => { await c.run(`const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.click(); return !!el;`); await sleep(1500); shot(name); };
// Android wording: nothing about Chrome or LinkedIn; the phone setup card is there.
results.copy = await c.run(`
  const txt = document.body.innerText;
  return { mentionsChrome: /chrome|this browser|this tab/i.test(txt), linkedinCard: !!document.querySelector('#bot-card-linkedin'), phoneSetupCard: !!document.querySelector('.phone-setup-card') };
`);
console.log('copy', JSON.stringify(results.copy));
await view('#nav .tab[data-view=activity]', '02-activity');
await view('#nav .tab[data-view=dashboard]', '03-dashboard');
await c.run(`document.querySelector('#setup-label').click(); return true;`);
await sleep(800);
shot('04-setup-menu');
await view('#nav-setup [data-view=personal]', '04-setup-personal');
await view('#nav .tab[data-view=tracker]', '05-tracker');
await view('#nav .tab[data-view=dashboard]', '03-dashboard');

// Reed: search + read a job, through hidden WebView tabs (same code as the extension).
results.reed = await c.run(`
  const { Page, mods } = globalThis.__jobaiTest;
  const p = await Page.open('about:blank');
  const { jobs, page } = await mods.reed.searchJobs(p.context(), p, 'IT Support', 5, false);
  const d = jobs[0] ? await mods.reed.getJobDescription(page, jobs[0]) : null;
  await page.close();
  return { found: jobs.length, first: jobs[0] && jobs[0].title, jdWords: d && d.description ? d.description.split(/\\s+/).length : 0, easyApply: d && d.hasEasyApply };
`);
console.log('reed', JSON.stringify(results.reed));

// NHS / Trac: search (fetch through the app) + read an advert in a tab.
results.nhs = await c.run(`
  const T = globalThis.__jobaiTest;
  // Same as the NHS agent: the search gets a page to load the results in.
  const p = await T.Page.open('about:blank');
  const jobs = await T.trac.searchTrac('administrator', { pages: 1, page: p });
  let jdWords = 0;
  if (jobs[0]) { const jd = await T.trac.fetchTracJD(jobs[0].url, p).catch((e) => ''); jdWords = String((jd && jd.description) || jd || '').split(/\\s+/).length; }
  const title = await p.title().catch(() => '');
  await p.close();
  return { found: jobs.length, first: jobs[0] && jobs[0].title, jdWords, pageTitle: title, securityCheck: /unavailable|just a moment|attention required|security/i.test(title) };
`);
console.log('nhs', JSON.stringify(results.nhs));

// Company site: fill a real Greenhouse form with a generated CV. submit:false, never sent.
results.ats = await c.run(`
  const T = globalThis.__jobaiTest;
  await T.vfsReady;
  let job = null;
  for (const board of ['gitlab', 'discord', 'duolingo', 'airtable', 'figma', 'cloudflare']) {
    try {
      const r = await fetch('https://boards-api.greenhouse.io/v1/boards/' + board + '/jobs');
      const d = await r.json();
      const j = (d.jobs || [])[0];
      if (j) { job = { jobId: 'gh_' + j.id, title: j.title, company: board, url: 'https://job-boards.greenhouse.io/' + board + '/jobs/' + j.id }; break; }
    } catch (_) {}
  }
  if (!job) return { error: 'no greenhouse job found' };
  const s = T.parseCV(${JSON.stringify(SAMPLE_CV)}, { overrideName: 'Alex Morgan' });
  const cvPath = '/jobai/output/saved_cvs/Alex_Morgan_Test.pdf';
  await T.pdf.writeStructuredPDF(s, cvPath, { overrideName: 'Alex Morgan' });
  const p = await T.Page.open(job.url, { active: false });
  await new Promise((r) => setTimeout(r, 3000));
  const ats = T.mods.ats.detectATS(job.url);
  const res = await T.mods.ats.fillExternalForm(p, job, cvPath, ats, { submit: false });
  const filled = await p.evaluate(() => Array.from(document.querySelectorAll('input[type=text],input[type=email],input[type=tel],textarea')).filter((i) => i.offsetParent && i.value).length);
  // Greenhouse swaps the file box for a chip with the file name once a CV is in.
  const files = await p.evaluate(() => Array.from(document.querySelectorAll('input[type=file]')).map((f) => (f.files.length ? f.files[0].name : '')).filter(Boolean)
    .concat((document.body.innerText.match(/[\\w .()-]+\\.pdf/gi) || []).map((x) => x.trim())));
  globalThis.__testTab = p;
  return { job: job.title + ' @ ' + job.company, url: job.url, ats, result: res, filledFields: filled, cvAttached: files };
`);
console.log('ats', JSON.stringify(results.ats));

// Show the filled form full screen, as the app does when a site needs the user.
await c.run(`const p = globalThis.__testTab; if (p) { await chrome.tabs.update(p.tabId, { active: true }); await p.evaluate(() => { const i = Array.from(document.querySelectorAll('input[type=text],input[type=email]')).find((x) => x.value); if (i) i.scrollIntoView({ block: 'start' }); }); } return true;`);
await sleep(2500);
shot('06-filled-form');
await c.run(`if (globalThis.__testTab) await globalThis.__testTab.evaluate(() => { const f = document.querySelector('input[type=file]'); const el = (f && f.closest('fieldset,div')) || document.querySelector('form'); if (el) el.scrollIntoView({ block: 'center' }); }); return true;`);
await sleep(1500);
shot('07-filled-form-cv');
await c.run(`await chrome.windows.update(1, { state: 'minimized' }); return true;`);
await sleep(1500);
shot('08-back-to-dashboard');

// ── Step 3: the agents for real, from the Start button (safety switch on: nothing is sent) ──
const KEY = process.env.JOBAI_TEST_LICENSE || '';
const adb = (cmd) => { try { execSync('adb ' + cmd); } catch (_) {} };
if (KEY) {
  results.start = await c.run(`
    const T = globalThis.__jobaiTest;
    globalThis.__jobaiDryRun = true;
    // Activate the key on the License page, like a user.
    document.querySelector('#setup-label').click();
    document.querySelector('#nav-setup [data-view=license]').click();
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('#lic').value = ${JSON.stringify(KEY)};
    document.querySelector('#lic-save').click();
    for (let i = 0; i < 40 && !/Active/.test((document.querySelector('#lic-st') || {}).textContent || ''); i++) await new Promise((r) => setTimeout(r, 500));
    const licMsg = (document.querySelector('#lic-st') || {}).textContent || '';
    await T.store.patch('profile', { searchTerms: ['IT Support', 'Technical Support', 'Service Desk', 'Customer Support'], country: 'United Kingdom' });
    await T.store.patch('settings', { enabled: { trac: false, linkedin: false, reed: true, ats: true }, dailyCap: 5 });
    await T.loadConfig();
    document.querySelector('#nav .tab[data-view=license]')?.click();
    document.querySelector('#nav .tab[data-view=dashboard]').click();
    for (let i = 0; i < 30 && !(document.querySelector('#start-all') && !document.querySelector('#start-all').disabled); i++) await new Promise((r) => setTimeout(r, 500));
    const btn = document.querySelector('#start-all');
    if (!btn || btn.disabled) return { started: false, why: btn ? 'Start button disabled' : 'no Start button', licMsg };
    btn.click();
    await new Promise((r) => setTimeout(r, 4000));
    return { started: true, running: Object.entries(T.agents).filter(([, a]) => a.running).map(([k]) => k) };
  `);
  console.log('start', JSON.stringify(results.start));
  shot('10-agents-running');
  // In-page timer: if the dashboard gets slowed down or frozen in the background, this falls behind.
  await c.run(`window.__hb2 = 0; window.__hb2Start = Date.now(); setInterval(() => { window.__hb2++; }, 1000); return true;`);
  adb('shell cmd statusbar expand-notifications'); await sleep(2000); shot('11-notification'); adb('shell cmd statusbar collapse');

  // Lock the screen while they work, like a phone left on charge.
  adb('shell input keyevent 223');
  const t0 = Date.now(); let st = {};
  while (Date.now() - t0 < 18 * 60 * 1000) {
    await sleep(30000);
    st = await c.run(`const j = await globalThis.__jobaiTest.store.jobs(); const by = {}; for (const x of j) by[x.source + ':' + x.status] = (by[x.source + ':' + x.status] || 0) + 1; by.__timer = window.__hb2 + '/' + Math.round((Date.now() - window.__hb2Start) / 1000) + 's'; return by;`, 90000);
    console.log(Math.round((Date.now() - t0) / 60000) + 'min', JSON.stringify(st));
    if (st && st['ats:ready']) break;
    if (st && st.error) results.frozen = (results.frozen || 0) + 1;
  }
  results.agentRun = { minutes: Math.round((Date.now() - t0) / 60000), statuses: st };
  adb('shell input keyevent 224'); adb('shell wm dismiss-keyguard'); await sleep(2000);
  results.readyJob = await c.run(`const j = (await globalThis.__jobaiTest.store.jobs()).find((x) => x.status === 'ready'); return j ? { title: j.title, company: j.company, url: j.url, reason: j.reason, cv: j.cvPath } : null;`);
  results.agentLog = await c.run(`return (await globalThis.__jobaiTest.store.get('log')).slice(-60);`);
  await view('#nav .tab[data-view=dashboard]', '12-dashboard-after');
  await view('#nav .tab[data-view=tracker]', '13-tracker-after');
  await view('#nav .tab[data-view=activity]', '14-activity-after');
  // The filled company form, as the user would see it before pressing Submit themselves.
  await c.run(`const t = (await chrome.tabs.query({})).filter((x) => /^https/.test(x.url) && x.windowId !== 0).pop(); if (t) await chrome.tabs.update(t.id, { active: true }); return !!t;`);
  await sleep(2500); shot('15-filled-by-agent'); adb('shell input keyevent 4'); await sleep(1000);
  await c.run(`document.querySelector('#stop-all')?.click(); return true;`);
}

// Reed sign-in opens inside the app (shares cookies with the agents); Back/Done closes it.
await view('#nav .tab[data-view=dashboard]', '03-dashboard');
results.signin = await c.run(`
  const b = document.querySelector('.signin[data-url*="reed"]');
  if (!b) return { button: false };
  b.click();
  // Wait for the sign-in page to finish loading before the screenshot.
  for (let i = 0; i < 40; i++) { const t = (await chrome.tabs.query({})).find((x) => x.windowId === 0); if (t && t.status === 'complete' && /^https/.test(t.url)) break; await new Promise((r) => setTimeout(r, 500)); }
  await new Promise((r) => setTimeout(r, 3000));
  const open = (await chrome.tabs.query({})).filter((t) => t.windowId === 0);
  return { button: true, opened: open.length, url: open[0] && open[0].url };
`);
shot('16-reed-signin');
adb('shell input keyevent 4');
await sleep(2000);
results.signin.closedAfterBack = await c.run(`return (await chrome.tabs.query({})).filter((t) => t.windowId === 0).length === 0;`);
shot('17-after-signin-closed');
console.log('signin', JSON.stringify(results.signin));

results.errors = await c.run(`return (await globalThis.__jobaiTest.store.get('log')).slice(-30);`);
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
c.close();

const pass = {
  boot: !!(results.boot && results.boot.hook && results.boot.chrome),
  reed: !!(results.reed && results.reed.found > 0 && results.reed.jdWords > 80),
  // GitHub's servers get Trac's Cloudflare security check (home connections don't), so that
  // case is reported, not failed.
  nhs: !!(results.nhs && (results.nhs.found > 0 || results.nhs.securityCheck)),
  ats: !!(results.ats && results.ats.filledFields >= 3 && results.ats.cvAttached && results.ats.cvAttached.length),
  signin: !!(results.signin && results.signin.opened > 0 && results.signin.closedAfterBack),
  androidCopy: !!(results.copy && !results.copy.mentionsChrome && !results.copy.linkedinCard && results.copy.phoneSetupCard),
};
if (KEY) {
  const s = (results.agentRun && results.agentRun.statuses) || {};
  pass.started = !!(results.start && results.start.started);
  pass.tailored = Object.keys(s).some((k) => /^ats:(cv_ready|ready|applying)$/.test(k));
  pass.filledByAgent = !!s['ats:ready'];
  pass.keptRunningLocked = !results.frozen;
}
console.log('PASS?', JSON.stringify(pass));
writeFileSync(`${OUT}/pass.json`, JSON.stringify(pass));
process.exit(Object.values(pass).every(Boolean) ? 0 : 1);
