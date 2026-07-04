// Launches a real installed browser (Chrome → Edge → bundled Chromium fallback)
// with a persistent user-data directory, stealth plugin, fingerprint injection, and optional proxy.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const _stealth = StealthPlugin();
// The 'chrome.app' evasion ships as a directory literally named "chrome.app",
// which macOS codesign tries (and fails) to sign as an app bundle when signing
// the packaged app. It's removed from the Mac build (see afterPack.js) and is
// redundant here anyway — we drive the user's REAL Chrome, which natively
// exposes window.chrome.app — so disable it to avoid a missing-module require.
_stealth.enabledEvasions.delete('chrome.app');
chromium.use(_stealth);

let FingerprintGenerator, FingerprintInjector;
try {
  FingerprintGenerator = require('fingerprint-generator').FingerprintGenerator;
  FingerprintInjector  = require('fingerprint-injector').FingerprintInjector;
} catch (_) {}

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-notifications',
  '--disable-popup-blocking',
];

// Built-in residential proxy — replaced at build time by GitHub Actions.
// env var JOBBOT_PROXY_URL takes priority (allows user override via UI).
const _BUILTIN_PROXY = '__PROXY_URL__';
const PROXY_URL = process.env.JOBBOT_PROXY_URL ||
  (_BUILTIN_PROXY.startsWith('__') ? '' : _BUILTIN_PROXY);

function buildProxyOpts() {
  if (!PROXY_URL) return {};
  try {
    const u = new URL(PROXY_URL);
    const proxy = { server: `${u.protocol}//${u.hostname}:${u.port}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    console.log(`  [Browser] Proxy: ${u.hostname}:${u.port}`);
    return { proxy, ignoreHTTPSErrors: true };
  } catch (e) {
    console.warn('  [Browser] Invalid proxy URL — ignored:', e.message);
    return {};
  }
}

async function launchPersistentContext(profileDir, extraOpts = {}) {
  // On older macOS (e.g. macOS 12, which Google Chrome no longer updates) Chrome
  // shows "Something went wrong when opening your profile. Some features may be
  // unavailable." when the profile carries a "Last Version" marker newer than
  // the running Chrome (a version downgrade). That can leave the session
  // unusable so the agent can't log in / apply. Removing the version markers
  // makes Chrome open the profile cleanly; cookies and session data are kept.
  try {
    const _fs = require('fs'), _path = require('path');
    for (const _f of ['Last Version', 'Last Browser']) {
      try { _fs.rmSync(_path.join(profileDir, _f), { force: true }); } catch (_) {}
    }
  } catch (_) {}

  // Run the window MINIMISED so the agent doesn't pop up over the user's work,
  // while staying a real (headed) stealth browser — headless would spike bot
  // detection and break the interactive CAPTCHA flow. Set JOBBOT_SHOW_BROWSER=1
  // to keep it visible (useful for debugging). When a verification challenge is
  // hit, waitForCloudflareSolve auto-restores the window so the user can solve it.
  const minimizeArgs = process.env.JOBBOT_SHOW_BROWSER ? [] : ['--start-minimized'];
  const sharedOpts = {
    headless: false,
    args: [...BASE_ARGS, ...minimizeArgs],
    viewport: { width: 1366, height: 768 },
    ...buildProxyOpts(),
    ...extraOpts,
  };

  // Must use the same real Chrome that the user logged in with.
  // Bundled Chromium cannot read Chrome's DPAPI-encrypted cookies and will
  // always appear as a new session to every site — never fall back to it.
  let ctx;
  let usedChannel;
  for (const channel of ['chrome', 'msedge']) {
    try {
      ctx = await chromium.launchPersistentContext(profileDir, { channel, ...sharedOpts });
      usedChannel = channel;
      console.log(`  [Browser] Launched ${channel} with stored session (profile: ${profileDir})`);
      break;
    } catch (_) {}
  }

  if (!ctx) {
    throw new Error(
      'Chrome or Edge not found on this computer.\n' +
      'Please install Google Chrome, then click "Connect account" to log in before starting the bot.'
    );
  }

  // Inject a realistic browser fingerprint (canvas, WebGL, UA, screen, fonts).
  // locales: ['en-GB'] ensures navigator.language matches a UK residential IP.
  if (FingerprintGenerator && FingerprintInjector) {
    try {
      const fp = new FingerprintGenerator().getFingerprint({
        browsers: ['chrome'],
        operatingSystems: ['windows'],
        devices: ['desktop'],
        locales: ['en-GB'],
      });
      await new FingerprintInjector().attachFingerprintToPlaywright(ctx, fp);
    } catch (_) {}
  }

  // Minimise the window so the agent doesn't intrude on the user's screen. Done
  // via CDP because Chrome ignores --start-minimized when automated. Skipped when
  // JOBBOT_SHOW_BROWSER is set. Restored automatically if a challenge appears.
  if (!process.env.JOBBOT_SHOW_BROWSER) {
    try {
      const p = ctx.pages()[0] || await ctx.newPage();
      await setWindowState(p, 'minimized');
    } catch (_) {}
  }

  return ctx;
}

// Set the agent window's OS state (minimized / normal) via CDP. Chrome ignores
// --start-minimized when automated, so we drive the window state explicitly.
async function setWindowState(page, windowState) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
    await session.detach().catch(() => {});
  } catch (_) {}
}

// Un-minimise / bring the agent's Chrome window to the front, e.g. when a human
// verification challenge needs solving. No-op if it fails or is already normal.
async function restoreWindow(page) {
  await setWindowState(page, 'normal');
  try { await page.bringToFront(); } catch (_) {}
}

// Wait for a Cloudflare challenge to auto-solve before the bot reads the page.
// CF's JS challenge auto-solves within ~5s when running real Chrome with stealth.
async function waitForCloudflareSolve(page, { maxWaitMs = 300000 } = {}) {
  const pageStatus = () => page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    const b = (document.body?.innerText || '').substring(0, 1200).toLowerCase();
    const isCfChallenge =
      // Cloudflare passive challenges
      t.includes('just a moment') || t.includes('attention required') ||
      b.includes('checking your browser') || b.includes('checking if the site') ||
      b.includes('enable javascript and cookies') ||
      b.includes('ddos-guard') || b.includes('one more step') ||
      b.includes('please wait while we verify') ||
      // Indeed / site-specific human verification challenges
      b.includes('let us know you') || b.includes('are you a robot') ||
      b.includes('verify you are human') || b.includes('verify that you are') ||
      b.includes('human verification') || b.includes('bot verification') ||
      b.includes('security check') || b.includes('prove you') ||
      t.includes('human verification') || t.includes('security check') ||
      t.includes('are you a robot');
    const isHardBlock = t.includes('blocked') || t.includes('access denied') ||
      t.includes('403') || t.includes('forbidden') ||
      b.includes('you triggered a security action') || b.includes('your ip has been blocked') ||
      b.includes('access denied') || b.includes('you have been blocked');
    return { isCfChallenge, isHardBlock };
  }).catch(() => ({ isCfChallenge: false, isHardBlock: false }));

  const start = Date.now();
  let challenged = false;
  while (Date.now() - start < maxWaitMs) {
    const { isCfChallenge, isHardBlock } = await pageStatus();
    if (isHardBlock) {
      console.error('  [Browser] IP BLOCKED by site — this is a hard block, not a challenge.');
      console.error('  [Browser] The site has flagged this IP. Options: wait 24h, use a VPN, or contact site support.');
      return false;
    }
    if (isCfChallenge) {
      if (!challenged) {
        console.log('  [Browser] ⚠️  Human verification challenge detected — please complete it in the browser window.');
        console.log('  [Browser] Waiting up to 5 minutes for you to pass the check...');
        // The window runs minimised — restore it so the user can see/solve the
        // challenge, and fire a desktop notification (marker parsed by main.js).
        await restoreWindow(page);
        console.log('  [[JOBBOT_NOTIFY]] Human verification needed — complete the check in the Agent\'s Chrome window.');
        challenged = true;
      }
      await new Promise(r => setTimeout(r, 3000));
    } else {
      if (challenged) console.log('  [Browser] ✓ Verification passed — continuing.');
      return true;
    }
  }
  console.warn('  [Browser] Verification challenge did not complete in time — skipping.');
  return false;
}

// Simulate a brief human-like interaction on the page before the bot acts.
// Cloudflare behavioural checks look for mouse movement and scroll events.
async function humanWarmup(page) {
  try {
    const w = 1366, h = 768;
    // Random mouse path across the page
    for (let i = 0; i < 4; i++) {
      const x = 80 + Math.random() * (w - 160);
      const y = 80 + Math.random() * (h - 160);
      await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) });
      await new Promise(r => setTimeout(r, 120 + Math.random() * 180));
    }
    // Small natural scroll
    await page.mouse.wheel(0, 80 + Math.random() * 120);
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    await page.mouse.wheel(0, -(40 + Math.random() * 60));
  } catch (_) {}
}

// Attaches Playwright to the Chrome window the user logged in with via CDP.
// The bot controls that exact Chrome — same session, same cookies, no new launch.
async function connectToRunningChrome(port) {
  const { chromium: plainChromium } = require('playwright');
  const endpoint = `http://127.0.0.1:${port}`;
  console.log(`  [Browser] Attaching to Chrome on port ${port}...`);
  const browser = await plainChromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  const ctx = contexts.length > 0 ? contexts[0] : await browser.newContext();
  console.log(`  [Browser] Attached to live Chrome session`);
  return ctx;
}

// Playwright throws these when the page / context / browser has gone away.
const BROWSER_CLOSED_RE = /Target (page|frame|closed)|context was (destroyed|closed)|context.*closed|browser.*closed|page.*closed|has been closed|Target closed|Browser closed|websocket.*closed/i;

// When the user closes the Chromium window by hand, stop the agent cleanly —
// exit(0) so the bot manager shows "stopped" rather than an error, and never
// relaunch a window they deliberately closed. Returns a guard; set
// guard.intentional = true before any context.close() the bot performs itself so
// it isn't mistaken for a manual close.
function watchForManualClose(context, label) {
  const guard = { intentional: false };
  context.on('close', () => {
    if (guard.intentional) return;
    console.log(`  [${label}] Browser window closed — agent stopped.`);
    process.exit(0);
  });
  return guard;
}

module.exports = { launchPersistentContext, connectToRunningChrome, humanWarmup, waitForCloudflareSolve, BROWSER_CLOSED_RE, watchForManualClose };
