// Safe read/write for queue.db. Several processes (each agent + the app) read and
// rewrite the WHOLE file. A plain writeFileSync truncates first, so a process that
// read at that instant saw an empty file, started a fresh database and saved it,
// wiping the queue. Writes now go to a temp file and are swapped in with a rename,
// and reads retry until the file looks like a real SQLite database.

const fs = require('fs');

const HEADER = 'SQLite format 3';
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };

function looksValid(buf) {
  return buf && buf.length >= 100 && buf.slice(0, HEADER.length).toString('latin1') === HEADER;
}

// Returns the file's bytes, or undefined if the file doesn't exist (new install).
function readDbFile(p) {
  if (!fs.existsSync(p)) return undefined;
  let buf;
  for (let i = 0; i < 40; i++) {
    try { buf = fs.readFileSync(p); } catch (_) { buf = null; }
    if (looksValid(buf)) return buf;
    pause(50);
  }
  // Still not a database after ~2s: refuse rather than start an empty one over it.
  throw new Error('queue.db unreadable (being written by another process?)');
}

function writeDbFile(p, data) {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; i < 40; i++) {
    try { fs.renameSync(tmp, p); return; } catch (e) {
      if (!/EPERM|EBUSY|EACCES/.test(e.code || '')) break;
      pause(50); // Windows: another process has the file open for a moment
    }
  }
  // Last resort: direct write (old behaviour), then drop the temp file.
  fs.writeFileSync(p, data);
  try { fs.unlinkSync(tmp); } catch (_) {}
}

module.exports = { readDbFile, writeDbFile };
