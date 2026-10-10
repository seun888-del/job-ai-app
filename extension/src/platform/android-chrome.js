// Android app: a stand-in for the chrome.* extension APIs, backed by the native app
// (android/app/src/main/java/com/tryjobai/app). Loaded before dashboard.js, so the extension's
// dashboard, agents, page driver and the shared bot modules run unchanged.
//   - tabs / windows: each "tab" is a hidden WebView owned by the app's background service.
//   - scripting.executeScript: runs the function (or helper.js) in that WebView's page.
//   - storage.local: IndexedDB in this page.
//   - fetch to other sites goes through the app (like an extension's host permissions).
(() => {
  const native = window.JobAIAndroid;
  if (!native) return;

  // ── Native calls: request -> native signals ready(id) -> JS takes the JSON result ──
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, tabId?, timer? }
  function call(op, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      native.call(JSON.stringify({ id, op, args: args || {} }));
    });
  }
  function settle(id, r) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (r && r.error !== undefined && p.reject && !p.exec) p.reject(new Error(r.error));
    else p.resolve(r);
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  const emitter = () => { const fns = new Set(); return { addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), hasListener: (f) => fns.has(f), emit: (...a) => { for (const f of [...fns]) { try { f(...a); } catch (e) { console.error(e); } } } }; };
  const ev = {
    tabCreated: emitter(), tabUpdated: emitter(), tabRemoved: emitter(),
    winRemoved: emitter(), storageChanged: emitter(), noop: emitter(),
  };

  const tabs = new Map(); // id -> { id, windowId, url, title, status, openerTabId }
  const info = (t) => ({ ...t, pendingUrl: t.status === 'loading' ? t.url : undefined, active: false, pinned: false, index: 0 });
  function removeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    tabs.delete(id);
    // Any page script still waiting on this tab gets "no result".
    for (const [cid, p] of pending) if (p.exec && p.tabId === id) settle(cid, null);
    ev.tabRemoved.emit(id, { windowId: t.windowId, isWindowClosing: false });
    if (![...tabs.values()].some((x) => x.windowId === t.windowId) && windows.has(t.windowId)) { windows.delete(t.windowId); ev.winRemoved.emit(t.windowId); }
  }

  window.__jobaiNative = {
    ready(id) {
      const raw = native.take(id);
      let r = null; try { r = raw ? JSON.parse(raw) : null; } catch (_) {}
      settle(id, r);
    },
    event(e) {
      if (e.type === 'tab') {
        const prev = tabs.get(e.tab.id);
        const t = { ...(prev || {}), ...e.tab };
        if (!prev && t.windowId == null) t.windowId = (tabs.get(t.openerTabId) || {}).windowId || 1;
        tabs.set(t.id, t);
        if (!prev) ev.tabCreated.emit(info(t));
        // A new page is loading: page scripts that were running on the old one won't answer.
        if (t.status === 'loading' && prev && prev.status !== 'loading') for (const [cid, p] of pending) if (p.exec && p.tabId === t.id) settle(cid, null);
        ev.tabUpdated.emit(t.id, { status: t.status, url: t.url, title: t.title }, info(t));
      } else if (e.type === 'tabRemoved') removeTab(e.id);
    },
  };

  // ── tabs / windows ────────────────────────────────────────────────────────────
  let winSeq = 1;
  const windows = new Set([1]);
  const isWeb = (u) => /^https?:/i.test(String(u || ''));

  // Job sites the agents work on. Signing in to these must happen inside the app, where the
  // agents' pages share the cookies; the phone's own browser is a separate sign-in.
  const JOB_SITE = /(^|\.)(trac\.jobs|healthjobsuk\.com|reed\.co\.uk|linkedin\.com|greenhouse\.io|lever\.co|recruitee\.com|ashbyhq\.com|smartrecruiters\.com|workable\.com|breezy\.hr|teamtailor\.com|pinpointhq\.com|bamboohr\.com|jobvite\.com|applytojob\.com)$/i;
  const SIGNIN_WINDOW = 0;

  async function createTab({ url, windowId, active } = {}) {
    // A link the user opens from the dashboard: job sites open full screen in the app (closed
    // again with Done); anything else (help pages) goes to the phone's browser.
    if (windowId == null && active !== false) {
      let host = ''; try { host = new URL(url).hostname; } catch (_) {}
      if (isWeb(url) && JOB_SITE.test(host)) {
        const r = await call('tabCreate', { url, windowId: SIGNIN_WINDOW, closeOnHide: true });
        const t = { id: r.id, windowId: SIGNIN_WINDOW, url, title: '', status: 'loading', ...(tabs.get(r.id) || {}) };
        tabs.set(t.id, t);
        await call('tabShow', { tabId: t.id });
        return info(t);
      }
      if (isWeb(url)) await call('openExternal', { url });
      return { id: -1, windowId: -1, url, status: 'complete' };
    }
    const win = windowId == null ? 1 : windowId;
    const r = await call('tabCreate', { url: url || 'about:blank', windowId: win });
    const t = { id: r.id, windowId: win, url: url || 'about:blank', title: '', status: isWeb(url) ? 'loading' : 'complete', ...(tabs.get(r.id) || {}) };
    tabs.set(t.id, t);
    ev.tabCreated.emit(info(t));
    return info(t);
  }
  function getTab(id) {
    const t = tabs.get(id);
    if (!t) return Promise.reject(new Error('No tab with id: ' + id));
    return Promise.resolve(info(t));
  }

  const chromeTabs = {
    create: createTab,
    get: getTab,
    async query(q = {}) { return [...tabs.values()].filter((t) => !q.url || t.url === q.url || (q.url.endsWith('*') && t.url.startsWith(q.url.slice(0, -1)))).map(info); },
    async getCurrent() { return undefined; },
    async update(id, p = {}) {
      const t = tabs.get(id);
      if (!t) throw new Error('No tab with id: ' + id);
      if (p.url) { t.url = p.url; t.status = 'loading'; await call('tabNavigate', { tabId: id, url: p.url }); }
      if (p.active) await call('tabShow', { tabId: id });
      return info(t);
    },
    async remove(ids) { for (const id of [].concat(ids)) { await call('tabRemove', { tabId: id }).catch(() => {}); removeTab(id); } },
    async reload(id) { const t = tabs.get(id); if (t) t.status = 'loading'; await call('tabReload', { tabId: id }); },
    async goBack(id) { await call('tabBack', { tabId: id }); },
    onCreated: ev.tabCreated, onUpdated: ev.tabUpdated, onRemoved: ev.tabRemoved, onActivated: emitter(),
  };

  const chromeWindows = {
    async create({ url } = {}) {
      const id = ++winSeq;
      windows.add(id);
      const tab = await createTab({ url: url || 'about:blank', windowId: id, active: false });
      return { id, tabs: [tab], state: 'minimized', focused: false };
    },
    async update(id, p = {}) {
      const mine = [...tabs.values()].filter((t) => t.windowId === id);
      // "Bring the agent's window up" (e.g. Trac asks for a sign-in): show its newest page.
      if (p.state === 'minimized') await call('tabHide', {});
      else if ((p.focused || p.state === 'normal') && mine.length) await call('tabShow', { tabId: mine[mine.length - 1].id });
      return { id };
    },
    async remove(id) {
      for (const t of [...tabs.values()].filter((x) => x.windowId === id)) { await call('tabRemove', { tabId: t.id }).catch(() => {}); removeTab(t.id); }
      if (windows.delete(id)) ev.winRemoved.emit(id);
    },
    async getAll() { return [...windows].map((id) => ({ id })); },
    onRemoved: ev.winRemoved,
  };

  // ── scripting.executeScript ─────────────────────────────────────────────────
  const fileCache = new Map();
  async function fileSource(f) {
    if (!fileCache.has(f)) fileCache.set(f, await (await fetch('/' + f)).text());
    return fileCache.get(f);
  }
  async function executeScript({ target, func, args, files } = {}) {
    const tabId = target && target.tabId;
    if (!tabs.has(tabId)) throw new Error('No tab with id: ' + tabId);
    let expr;
    if (files && files.length) expr = `(function(){${(await Promise.all(files.map(fileSource))).join('\n;\n')}\n})()`;
    else expr = `(${func.toString()}).apply(null, ${JSON.stringify(args || [])})`;
    const id = ++seq;
    const code = `(function(){var __c=${id};Promise.resolve().then(function(){return ${expr};}).then(function(v){JobAITab.result(__c,JSON.stringify({result:v===undefined?null:v}))},function(e){JobAITab.result(__c,JSON.stringify({error:{message:String((e&&e.message)||e)}}))})})();`;
    const r = await new Promise((resolve) => {
      const p = { resolve, exec: true, tabId };
      p.timer = setTimeout(() => settle(id, null), 30000);
      pending.set(id, p);
      native.call(JSON.stringify({ id: 0, op: 'tabExec', args: { tabId, callId: id, code } }));
    });
    if (!r) return [];
    return [r.error ? { error: r.error } : { result: r.result }];
  }

  // ── storage.local (IndexedDB) ───────────────────────────────────────────────
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('jobai-storage', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', mode); const out = fn(t.objectStore('kv')); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
  const readOne = async (k) => { const d = await db(); return new Promise((res) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }); };
  const storageLocal = {
    async get(keys) {
      const out = {};
      if (keys == null) {
        const d = await db();
        await new Promise((res) => { const r = d.transaction('kv').objectStore('kv').openCursor(); r.onsuccess = () => { const c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else res(); }; r.onerror = () => res(); });
        return out;
      }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const k of list) { const v = await readOne(k); if (v !== undefined) out[k] = v; else if (typeof keys === 'object' && !Array.isArray(keys)) out[k] = keys[k]; }
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: await readOne(k), newValue: v };
      await tx('readwrite', (s) => { for (const [k, v] of Object.entries(obj)) s.put(structuredClone(v), k); });
      ev.storageChanged.emit(changes, 'local');
    },
    async remove(keys) {
      const list = [].concat(keys); const changes = {};
      for (const k of list) changes[k] = { oldValue: await readOne(k) };
      await tx('readwrite', (s) => { for (const k of list) s.delete(k); });
      ev.storageChanged.emit(changes, 'local');
    },
    async clear() { await tx('readwrite', (s) => s.clear()); },
  };

  // ── fetch to other sites goes through the app (no CORS, the app's cookies) ──────
  const pageFetch = window.fetch.bind(window);
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  window.fetch = async (input, init = {}) => {
    const req = new Request(input, init);
    const url = new URL(req.url, location.href);
    if (url.origin === location.origin || !isWeb(url.href)) return pageFetch(input, init);
    const headers = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    // Request drops "forbidden" headers (Referer, Origin, Cookie...); keep the ones the code set.
    new Headers(init.headers || (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { headers[k] = v; });
    const body = /^(GET|HEAD)$/.test(req.method) ? null : new Uint8Array(await req.arrayBuffer());
    const signal = init.signal || (input instanceof Request ? input.signal : null);
    if (signal && signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const work = call('http', { method: req.method, url: url.href, headers, body: body && body.length ? b64(body) : null });
    const r = await (signal ? Promise.race([work, new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason || new DOMException('Aborted', 'AbortError')), { once: true }))]) : work);
    if (!r || r.failed) throw new TypeError('Failed to fetch' + (r && r.failed ? ` (${r.failed})` : ''));
    const noBody = [101, 204, 205, 304].includes(r.status) || req.method === 'HEAD';
    const res = new Response(noBody ? null : unb64(r.body || ''), { status: r.status, statusText: r.statusText || '', headers: r.headers || {} });
    Object.defineProperty(res, 'url', { value: r.url || url.href });
    Object.defineProperty(res, 'redirected', { value: !!r.url && r.url !== url.href });
    return res;
  };

  // ── runtime / misc ──────────────────────────────────────────────────────────
  const version = native.version ? native.version() : '0.0.0';
  window.chrome = {
    tabs: chromeTabs,
    windows: chromeWindows,
    scripting: { executeScript },
    storage: { local: storageLocal, onChanged: ev.storageChanged },
    runtime: {
      id: 'jobai-android',
      getURL: (p) => location.origin + '/' + String(p).replace(/^\//, ''),
      getManifest: () => ({ version, name: 'Job-AI' }),
      reload: () => location.reload(),
      onInstalled: emitter(), onUpdateAvailable: emitter(), onMessage: emitter(),
    },
    action: { onClicked: emitter() },
  };
  // Backend: requests from the app are tagged as the Android app.
  globalThis.__jobaiClient = 'android';
  // Keep the "Job-AI" notification in step with the agents: it shows their latest log line.
  let lastStatus = '';
  ev.storageChanged.addListener((changes) => {
    const log = changes.log && changes.log.newValue;
    if (!Array.isArray(log) || !log.length) return;
    const text = String(log[log.length - 1]).replace(/^\[[^\]]*\]\s*/, '').slice(0, 120);
    if (text && text !== lastStatus) { lastStatus = text; call('status', { text }).catch(() => {}); }
  });
})();
