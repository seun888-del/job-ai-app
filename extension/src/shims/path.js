// POSIX-style path helpers for the in-browser file system.
const norm = (p) => String(p || '').replace(/\\/g, '/');
function join(...parts) { return norm(parts.filter((x) => x != null && x !== '').join('/')).replace(/\/+/g, '/'); }
function dirname(p) { p = norm(p); const i = p.lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i); }
function basename(p, ext) { p = norm(p); let b = p.slice(p.lastIndexOf('/') + 1); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; }
function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
function resolve(...parts) { return join(...parts); }
module.exports = { join, dirname, basename, extname, resolve, sep: '/', posix: null };
module.exports.posix = module.exports;
