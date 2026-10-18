/**
 * login_prompt.js
 * When the user presses Start and a job site is not signed in, the agent's own browser
 * window comes to the front on the site's login page and waits for them to sign in.
 * Only one agent asks at a time. Unattended starts (schedule, phone) never wait: nobody
 * is at the computer, so the agent stops and says sign-in is needed.
 */
const fs = require('fs');
const path = require('path');

const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_STALE_MS = 6 * 60 * 1000;

function lockPath() { return path.join(process.env.JOBBOT_USERDATA || '.', 'login_prompt.lock'); }

// Another agent is already showing its sign-in window: wait for it to finish.
async function acquireLock() {
  const p = lockPath();
  const deadline = Date.now() + LOCK_STALE_MS;
  while (Date.now() < deadline) {
    try { fs.writeFileSync(p, String(process.pid), { flag: 'wx' }); return true; }
    catch (_) {
      try { if (Date.now() - fs.statSync(p).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(p); continue; } } catch (_) {}
      await DELAY(2000);
    }
  }
  return false;
}
function releaseLock() {
  try { if (fs.readFileSync(lockPath(), 'utf8') === String(process.pid)) fs.unlinkSync(lockPath()); } catch (_) {}
}

async function setWindowState(page, windowState) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
    await session.detach().catch(() => {});
  } catch (_) {}
}

// Returns true once signed in. Throws a plain "sign in needed" error when nobody can sign in now.
// `message` replaces the default "Sign in to X" ask (e.g. accept new terms); no loginUrl = stay on this page.
async function promptLogin(page, { site, loginUrl, isSignedIn, minutes = 5, message }) {
  if (process.env.JOBBOT_LOGIN_PROMPT !== '1') {
    console.log(`  [[JOBBOT_NOTIFY]] Sign in to ${site} needed. Press Start applying on your computer and sign in when the window opens.`);
    throw new Error(`${site}: sign in needed. Press Start applying on this computer and sign in when the ${site} window opens.`);
  }
  await acquireLock();
  try {
    if (loginUrl) { try { await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (_) {} }
    await setWindowState(page, 'normal');
    try { await page.bringToFront(); } catch (_) {}
    console.log(`  [[JOBBOT_NOTIFY]] ${message || `Sign in to ${site} in the window that just opened. The agent starts as soon as you're signed in.`}`);
    console.log(`  [${site}] Waiting for you to sign in (up to ${minutes} minutes)...`);
    const deadline = Date.now() + minutes * 60000;
    while (Date.now() < deadline) {
      await DELAY(3000);
      // Window closed by the user: stop now (the agents treat this message as a clean stop).
      if (page.isClosed && page.isClosed()) throw new Error('Target page, context or browser has been closed');
      if (await isSignedIn(page).catch(() => false)) {
        console.log(`  [${site}] ✓ Signed in. You won't be asked again on this computer.`);
        await DELAY(1500);
        if (!process.env.JOBBOT_SHOW_BROWSER) await setWindowState(page, 'minimized');
        return true;
      }
    }
  } finally { releaseLock(); }
  throw new Error(`${site}: sign in timed out. Press Start applying again when you're ready to sign in.`);
}

module.exports = { promptLogin };
