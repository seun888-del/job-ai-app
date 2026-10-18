// The extension runs in the user's own Chrome, so there is no browser to launch. Shared agent
// code only needs these two helpers from the desktop launcher.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real Chrome normally passes Cloudflare's check by itself; wait for it to clear (up to 2 min).
async function waitForCloudflareSolve(page, { maxWaitMs = 120000 } = {}) {
  const end = Date.now() + maxWaitMs;
  while (Date.now() < end) {
    const t = await page.title().catch(() => '');
    if (!/just a moment|attention required|verify you are human/i.test(t)) return true;
    await sleep(2000);
  }
  return false;
}

async function humanWarmup() {}
async function setWindowState() {}

module.exports = { waitForCloudflareSolve, humanWarmup, setWindowState };
