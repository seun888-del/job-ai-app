// Launches a real installed browser (Chrome → Edge → bundled Chromium fallback)
// with a persistent user-data directory, stealth plugin, fingerprint injection, and optional proxy.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

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
  const sharedOpts = {
    headless: false,
    args: BASE_ARGS,
    // No userAgent override — let real Chrome send its authentic UA
    viewport: { width: 1366, height: 768 },
    ...buildProxyOpts(),
    ...extraOpts,
  };

  let ctx;
  for (const channel of ['chrome', 'msedge']) {
    try {
      ctx = await chromium.launchPersistentContext(profileDir, { channel, ...sharedOpts });
      console.log(`  [Browser] Launched real ${channel} with persistent profile`);
      break;
    } catch (_) {}
  }

  if (!ctx) {
    console.log('  [Browser] Using bundled Chromium (real browser not found)');
    ctx = await chromium.launchPersistentContext(profileDir, sharedOpts);
  }

  // Inject a realistic browser fingerprint (canvas, WebGL, UA, screen, fonts)
  if (FingerprintGenerator && FingerprintInjector) {
    try {
      const fp = new FingerprintGenerator().getFingerprint({ browsers: ['chrome'], operatingSystems: ['windows'], devices: ['desktop'] });
      await new FingerprintInjector().attachFingerprintToPlaywright(ctx, fp);
      console.log('  [Browser] Fingerprint injected');
    } catch (e) {
      console.warn('  [Browser] Fingerprint injection skipped:', e.message);
    }
  }

  return ctx;
}

// Wait for a Cloudflare challenge to auto-solve before the bot reads the page.
// CF's JS challenge auto-solves within ~5s when running real Chrome with stealth.
async function waitForCloudflareSolve(page, { maxWaitMs = 30000 } = {}) {
  const pageStatus = () => page.evaluate(() => {
    const t = (document.title || '').toLowerCase();
    const b = (document.body?.innerText || '').substring(0, 800).toLowerCase();
    const isCfChallenge = t.includes('just a moment') || t.includes('attention required') ||
      b.includes('checking your browser') || b.includes('checking if the site') ||
      b.includes('enable javascript and cookies') ||
      b.includes('ddos-guard') || b.includes('one more step') ||
      b.includes('please wait while we verify');
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
        console.log('  [Browser] Cloudflare challenge detected — waiting for auto-solve...');
        challenged = true;
      }
      await new Promise(r => setTimeout(r, 2000));
    } else {
      if (challenged) console.log('  [Browser] Cloudflare challenge passed');
      return true;
    }
  }
  console.warn('  [Browser] Cloudflare challenge did not auto-solve in time');
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

module.exports = { launchPersistentContext, humanWarmup, waitForCloudflareSolve };
