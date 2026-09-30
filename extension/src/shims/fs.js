// A small in-browser file system so the shared agent code (which writes the tailored CV PDF to
// a path and later uploads that path) works unchanged in the extension. Files live in memory
// and are saved to IndexedDB on this device, so they survive restarts. Nothing leaves the device.
const files = new Map(); // path -> Uint8Array
const DB = 'jobai-files', STORE = 'files';

function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/'); }
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data == null ? '' : data));
}

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return dbp;
}
function persist(p, bytes) {
  db().then((d) => { const tx = d.transaction(STORE, 'readwrite'); if (bytes) tx.objectStore(STORE).put(bytes, p); else tx.objectStore(STORE).delete(p); }).catch(() => {});
}
// Load saved files into memory (call once at start-up, before agents run).
async function load() {
  const d = await db();
  await new Promise((res) => {
    const tx = d.transaction(STORE, 'readonly'); const st = tx.objectStore(STORE);
    const req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { files.set(c.key, new Uint8Array(c.value)); c.continue(); } else res(); };
    req.onerror = () => res();
  });
}

function existsSync(p) { p = norm(p); if (files.has(p)) return true; const dir = p.endsWith('/') ? p : p + '/'; for (const k of files.keys()) if (k.startsWith(dir)) return true; return p === '' || /^\/jobai\/?[^/]*\/?$/.test(p); }
function readFileSync(p, enc) {
  const b = files.get(norm(p));
  if (!b) { const e = new Error(`ENOENT: no such file, open '${p}'`); e.code = 'ENOENT'; throw e; }
  return enc ? new TextDecoder().decode(b) : b;
}
function writeFileSync(p, data) { p = norm(p); const b = toBytes(data); files.set(p, b); persist(p, b); }
function unlinkSync(p) { p = norm(p); files.delete(p); persist(p, null); }
function copyFileSync(a, b) { writeFileSync(b, readFileSync(a)); }
function mkdirSync() {}
function statSync(p) { const b = files.get(norm(p)); if (!b) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { size: b.length, isFile: () => true, isDirectory: () => false, mtimeMs: Date.now() }; }
function readdirSync(dir) { dir = norm(dir).replace(/\/?$/, '/'); return [...new Set([...files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length).split('/')[0]))]; }

// Minimal Node-style writable stream (what pdfkit pipes into).
function createWriteStream(p) {
  const chunks = []; const ev = {};
  const s = {
    writable: true,
    on(n, f) { (ev[n] = ev[n] || []).push(f); return s; },
    once(n, f) { const w = (...a) => { s.removeListener(n, w); f(...a); }; return s.on(n, w); },
    prependListener(n, f) { (ev[n] = ev[n] || []).unshift(f); return s; },
    removeListener(n, f) { ev[n] = (ev[n] || []).filter((x) => x !== f); return s; },
    off(n, f) { return s.removeListener(n, f); },
    emit(n, ...a) { for (const f of (ev[n] || []).slice()) f(...a); return true; },
    listenerCount(n) { return (ev[n] || []).length; },
    write(c) { chunks.push(toBytes(c)); return true; },
    end(c) {
      if (c) chunks.push(toBytes(c));
      const len = chunks.reduce((n, x) => n + x.length, 0); const out = new Uint8Array(len); let o = 0;
      for (const x of chunks) { out.set(x, o); o += x.length; }
      writeFileSync(p, out);
      setTimeout(() => { s.emit('finish'); s.emit('close'); }, 0);
      return s;
    },
    destroy() {},
  };
  return s;
}

const promises = { readFile: async (p, e) => readFileSync(p, e), writeFile: async (p, d) => writeFileSync(p, d), unlink: async (p) => unlinkSync(p), mkdir: async () => {}, stat: async (p) => statSync(p) };
module.exports = { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, mkdirSync, statSync, readdirSync, createWriteStream, promises, __load: load, __files: files, __put: writeFileSync };
