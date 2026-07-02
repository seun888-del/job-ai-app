const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// electron-builder's npm staging can nest packages differently from the dev
// install. Copy any packages that must sit at the top-level node_modules so
// all require() calls resolve correctly in the packaged app.
const HOIST_PACKAGES = ['call-bind-apply-helpers'];

function hoistPackages(appResourcesPath) {
  const nm = path.join(appResourcesPath, 'app', 'node_modules');
  for (const pkg of HOIST_PACKAGES) {
    const dest = path.join(nm, pkg);
    if (fs.existsSync(dest)) continue; // already at top-level
    // Search one level of nesting
    const entries = fs.readdirSync(nm);
    let found = false;
    for (const entry of entries) {
      const nested = path.join(nm, entry, 'node_modules', pkg);
      if (fs.existsSync(nested)) {
        fs.cpSync(nested, dest, { recursive: true });
        console.log(`[afterPack] Hoisted ${pkg} from ${entry}/node_modules/`);
        found = true;
        break;
      }
    }
    if (!found) console.warn(`[afterPack] Could not find ${pkg} to hoist`);
  }
}

// Delete every copy of puppeteer-extra-plugin-stealth's `chrome.app` evasion
// directory from the packaged app — a folder named *.app breaks macOS codesign.
function removeChromeAppEvasion(appResourcesPath) {
  const nm = path.join(appResourcesPath, 'app', 'node_modules');
  const targets = [path.join(nm, 'puppeteer-extra-plugin-stealth', 'evasions', 'chrome.app')];
  try {
    for (const entry of fs.readdirSync(nm)) {
      targets.push(path.join(nm, entry, 'node_modules', 'puppeteer-extra-plugin-stealth', 'evasions', 'chrome.app'));
    }
  } catch (_) {}
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) {
        fs.rmSync(t, { recursive: true, force: true });
        console.log('[afterPack] Removed codesign-incompatible dir:', t);
      }
    } catch (e) {
      console.warn('[afterPack] Could not remove', t, e.message);
    }
  }
}

module.exports = async function afterPack(context) {
  // Hoist missing top-level packages on all platforms
  try {
    const platform = context.electronPlatformName;
    let resourcesPath;
    if (platform === 'darwin') {
      resourcesPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
    } else {
      resourcesPath = path.join(context.appOutDir, 'resources');
    }
    hoistPackages(resourcesPath);
    // macOS only: remove the stealth plugin's `chrome.app` directory. codesign
    // treats any *.app dir as an app bundle and fails on this fake one. The
    // evasion is disabled at runtime (browser_launcher.js) and redundant with
    // real Chrome, so removing it is safe.
    if (platform === 'darwin') removeChromeAppEvasion(resourcesPath);
  } catch (e) {
    console.warn('[afterPack] Hoist/cleanup step failed (non-fatal):', e.message);
  }

  if (context.electronPlatformName !== 'darwin') return;
  // When a real Developer ID cert is provided (CSC_LINK), electron-builder does
  // the proper signing + notarization — so skip the ad-hoc signature here.
  if (process.env.CSC_LINK) {
    console.log('[afterPack] CSC_LINK present — skipping ad-hoc sign (electron-builder will sign + notarize)');
    return;
  }
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('[afterPack] Ad-hoc signed:', appPath);
  } catch (e) {
    console.warn('[afterPack] Ad-hoc signing failed (non-fatal):', e.message);
  }
};
