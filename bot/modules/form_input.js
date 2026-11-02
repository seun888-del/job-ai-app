// Shared form-input helpers for ATS forms (Greenhouse, Lever, ...).
// Paced typing so React/Vue inputs register every keystroke, clean resume
// uploads, honest browser context, and a human hand-off when a site shows a
// verification challenge. Nothing here hides automation or defeats a CAPTCHA:
// if a challenge appears, the user solves it themselves or the form is skipped.

const fs = require('fs');
const path = require('path');

// Context options that describe the user's real machine (not spoofed values).
function contextOptions() {
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  return {
    locale: locale || 'en-GB',
    timezoneId: timeZone || 'Europe/London',
    viewport: { width: 1366, height: 768 },
    acceptDownloads: false,
  };
}

const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// Type into a field at a steady pace, then confirm the value stuck.
// Falls back to fill() for fields that reject per-key input.
async function pacedType(locator, text, { minDelay = 35, maxDelay = 90 } = {}) {
  const v = String(text ?? '');
  try {
    await locator.click({ timeout: 4000 });
    await locator.fill('');
    await locator.pressSequentially(v, { delay: rand(minDelay, maxDelay) });
    if ((await locator.inputValue().catch(() => v)) === v) return true;
  } catch (_) {}
  try { await locator.fill(v, { timeout: 5000 }); return true; } catch (_) { return false; }
}

// Attach a file to the form. Handles a plain <input type=file> (often hidden
// behind a styled button) and pages that only open a native file chooser.
async function uploadFile(page, filePath, { inputSelector = 'input[type="file"]', buttonSelector } = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`Upload file missing: ${filePath}`);
  if (fs.statSync(filePath).size === 0) throw new Error(`Upload file is empty: ${filePath}`);

  const input = page.locator(inputSelector).first();
  if (await input.count()) {
    await input.setInputFiles(filePath); // works on hidden inputs, no dialog opens
  } else if (buttonSelector) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      page.locator(buttonSelector).first().click(),
    ]);
    await chooser.setFiles(filePath);
  } else {
    throw new Error('No file input or upload button found');
  }

  // Most ATSes echo the file name once the upload registers.
  const name = path.basename(filePath);
  await page.getByText(name, { exact: false }).first()
    .waitFor({ timeout: 10000 }).catch(() => {});
  return true;
}

const CHALLENGE_SELECTOR = [
  'iframe[src*="recaptcha/api2/bframe"]', 'iframe[src*="recaptcha/enterprise/bframe"]',
  'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="challenge" i]',
].join(', ');

// If a verification challenge is showing, bring the window forward and wait
// for the user to complete it. Returns false on timeout so the caller skips
// the form and reports it as NOT sent.
async function waitForHumanIfChallenged(page, { timeoutMs = 3 * 60 * 1000, notify } = {}) {
  const challenge = page.locator(CHALLENGE_SELECTOR).first();
  if (!(await challenge.isVisible().catch(() => false))) return true;
  await page.bringToFront().catch(() => {});
  if (notify) notify('This form needs a quick human check. Please complete it in the open window.');
  try {
    await challenge.waitFor({ state: 'hidden', timeout: timeoutMs });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { contextOptions, pacedType, uploadFile, waitForHumanIfChallenged };
