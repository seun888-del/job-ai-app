// Stable per-machine identifier for anti-abuse (one free trial per physical
// device). Prefers the OS hardware GUID — which survives an app reinstall or a
// userData wipe — and falls back to a hash of hostname + primary MAC address.
//
// Only a sha256 HASH ever leaves the machine; the raw hardware id is never sent.
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

function rawId() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', windowsHide: true, timeout: 4000 }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/i);
      if (m) return 'win:' + m[1];
    } else if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8', timeout: 4000 });
      const m = out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return 'mac:' + m[1];
    }
  } catch (_) { /* fall through to the MAC/hostname fallback */ }

  // Fallback: hostname + lowest non-internal MAC (stable enough on machines
  // where the hardware GUID couldn't be read).
  const macs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.push(ni.mac);
    }
  }
  macs.sort();
  return 'fb:' + os.hostname() + '|' + (macs[0] || 'nomac');
}

let cached;
function machineId() {
  if (cached) return cached;
  cached = crypto.createHash('sha256').update('jobai:' + rawId()).digest('hex');
  return cached;
}

module.exports = { machineId };
