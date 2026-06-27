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
  } catch (e) {
    console.warn('[afterPack] Hoist step failed (non-fatal):', e.message);
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
