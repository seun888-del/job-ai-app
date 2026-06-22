// CapSolver integration — auto-detects and solves reCAPTCHA v2 / hCaptcha.
// Requires CAPSOLVER_KEY env var. Silently skips if no key is configured.

const https = require('https');
const cfg   = require('../config');

const POLL_MS   = 3000;
const MAX_POLLS = 60; // 3 minutes max

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.capsolver.com',
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function pollResult(taskId) {
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const res = await apiPost('/getTaskResult', { clientKey: cfg.CAPSOLVER_KEY, taskId });
    if (res.errorId) throw new Error(`CapSolver: ${res.errorDescription}`);
    if (res.status === 'ready') return res.solution;
  }
  throw new Error('CapSolver timed out after 3 minutes');
}

async function createAndSolve(taskBody) {
  const res = await apiPost('/createTask', { clientKey: cfg.CAPSOLVER_KEY, task: taskBody });
  if (res.errorId) throw new Error(`CapSolver createTask: ${res.errorDescription}`);
  return pollResult(res.taskId);
}

// Solve reCAPTCHA v2 if present on the page. Returns true if solved.
async function solveRecaptchaV2(page) {
  if (!cfg.CAPSOLVER_KEY) return false;
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('.g-recaptcha, [data-sitekey]');
    return el?.getAttribute('data-sitekey') || null;
  }).catch(() => null);
  if (!sitekey) return false;

  console.log('  [CAPTCHA] reCAPTCHA v2 detected — solving via CapSolver...');
  try {
    const solution = await createAndSolve({
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: page.url(),
      websiteKey: sitekey,
    });
    const token = solution.gRecaptchaResponse;
    await page.evaluate((t) => {
      const el = document.getElementById('g-recaptcha-response');
      if (el) { el.innerHTML = t; el.style.display = 'block'; }
      // Trigger callback if defined
      const cb = document.querySelector('[data-callback]')?.getAttribute('data-callback');
      if (cb && typeof window[cb] === 'function') window[cb](t);
    }, token);
    console.log('  [CAPTCHA] reCAPTCHA solved.');
    return true;
  } catch (err) {
    console.error(`  [CAPTCHA] reCAPTCHA solve failed: ${err.message}`);
    return false;
  }
}

// Solve hCaptcha if present on the page. Returns true if solved.
async function solveHcaptcha(page) {
  if (!cfg.CAPSOLVER_KEY) return false;
  const sitekey = await page.evaluate(() => {
    const el = document.querySelector('.h-captcha, [data-hcaptcha-widget-id]');
    return el?.getAttribute('data-sitekey') || null;
  }).catch(() => null);
  if (!sitekey) return false;

  console.log('  [CAPTCHA] hCaptcha detected — solving via CapSolver...');
  try {
    const solution = await createAndSolve({
      type: 'HCaptchaTaskProxyLess',
      websiteURL: page.url(),
      websiteKey: sitekey,
    });
    const token = solution.gRecaptchaResponse;
    await page.evaluate((t) => {
      const el = document.querySelector('[name="h-captcha-response"], textarea[name="h-captcha-response"]');
      if (el) el.value = t;
    }, token);
    console.log('  [CAPTCHA] hCaptcha solved.');
    return true;
  } catch (err) {
    console.error(`  [CAPTCHA] hCaptcha solve failed: ${err.message}`);
    return false;
  }
}

// Auto-detect and solve any CAPTCHA on the current page.
async function autoSolve(page) {
  if (!cfg.CAPSOLVER_KEY) return false;
  const url = page.url();
  if (!url || url === 'about:blank') return false;
  if (await solveRecaptchaV2(page)) return true;
  return solveHcaptcha(page);
}

module.exports = { autoSolve, solveRecaptchaV2, solveHcaptcha };
