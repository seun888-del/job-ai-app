// Launches a real installed browser (Chrome → Edge → bundled Chromium fallback)
// with a persistent user-data directory so the profile looks like a real user.

const { chromium } = require('playwright');

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function launchPersistentContext(profileDir, extraOpts = {}) {
  const sharedOpts = {
    headless: false,
    args: BASE_ARGS,
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    ...extraOpts,
  };

  for (const channel of ['chrome', 'msedge']) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, { channel, ...sharedOpts });
      console.log(`  [Browser] Launched real ${channel} with persistent profile`);
      return ctx;
    } catch (_) {}
  }

  // Bundled Chromium last resort
  console.log('  [Browser] Using bundled Chromium (real browser not found)');
  return await chromium.launchPersistentContext(profileDir, sharedOpts);
}

module.exports = { launchPersistentContext };
