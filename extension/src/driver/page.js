// A Playwright-compatible "page" for one Chrome tab, built on chrome.tabs and chrome.scripting.
// It implements what the shared agent code (bot/modules/*) uses, so the same automation runs in
// the desktop app and in the extension. Page functions are called by id (see build.mjs); element
// handles are elements tagged with a data attribute so they can be found again.
const fs = require('../shims/fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openedBy = new Map(); // childTabId -> openerTabId
chrome.tabs.onCreated.addListener((t) => { if (t.openerTabId) openedBy.set(t.id, t.openerTabId); });
chrome.tabs.onRemoved.addListener((id) => openedBy.delete(id));

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
function fileSpec(f) {
  if (typeof f === 'string') {
    const bytes = fs.readFileSync(f);
    // Tailored CVs are stored under a descriptive name; employers see "<Name> Resume.pdf", as in the app.
    const name = /\/saved_cvs\//.test(f) ? (require('../shims/config').RESUME_FILENAME || 'Resume.pdf') : f.split('/').pop();
    return { name, type: /\.pdf$/i.test(name) ? 'application/pdf' : /\.docx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream', b64: b64(bytes) };
  }
  const bytes = f.buffer instanceof Uint8Array ? f.buffer : new Uint8Array(f.buffer || []);
  return { name: f.name, type: f.mimeType || 'application/octet-stream', b64: b64(bytes) };
}

export class Page {
  constructor(tabId, windowId) {
    this.tabId = tabId;
    this.windowId = windowId;
    this._url = '';
    this._closed = false;
    this._timeout = 30000;
    this._onUpd = (id, info, tab) => { if (id === this.tabId && (info.url || tab.url)) this._url = info.url || tab.url; };
    this._onRem = (id) => { if (id === this.tabId) this._closed = true; };
    chrome.tabs.onUpdated.addListener(this._onUpd);
    chrome.tabs.onRemoved.addListener(this._onRem);
    this.keyboard = {
      press: (key) => this._act('', 0, 'keyActive', key).catch(() => {}),
      type: (text) => this._act('', 0, 'typeActive', String(text)).catch(() => {}),
      down: async () => {}, up: async () => {},
    };
    this.mouse = { move: async () => {}, click: async () => {}, wheel: async () => {} };
  }

  static async open(url, { active = false, windowId } = {}) {
    const tab = await chrome.tabs.create({ url: url || 'about:blank', active, ...(windowId ? { windowId } : {}) });
    const p = new Page(tab.id, tab.windowId);
    p._url = tab.pendingUrl || tab.url || '';
    if (url && /^https?:/i.test(url)) await p._waitComplete(45000);
    return p;
  }

  isClosed() { return this._closed; }
  url() { return this._url; }
  async title() { const t = await chrome.tabs.get(this.tabId); return t.title || ''; }
  setDefaultTimeout(ms) { this._timeout = ms || 30000; }
  setDefaultNavigationTimeout() {}
  async setViewportSize() {}
  async bringToFront() { const t = await chrome.tabs.update(this.tabId, { active: true }); if (t.windowId) await chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); }
  async close() { this._cleanup(); await chrome.tabs.remove(this.tabId).catch(() => {}); this._closed = true; }
  _cleanup() { chrome.tabs.onUpdated.removeListener(this._onUpd); chrome.tabs.onRemoved.removeListener(this._onRem); }
  async screenshot() { return new Uint8Array(0); } // not needed in the extension
  on() {} off() {} once() {}
  frames() { return [this]; }
  mainFrame() { return this; }

  // Minimal "browser context": the agent's tab, tabs it opened, new tabs, cookies.
  context() {
    const self = this;
    return {
      pages() { return [self, ...[...openedBy.entries()].filter(([, o]) => o === self.tabId).map(([id]) => new Page(id, self.windowId))]; },
      async newPage() { return Page.open('about:blank', { windowId: self.windowId }); },
      async clearCookies() {},
      async cookies() { return []; },
      async addCookies() {},
      async storageState() { return {}; },
      async addInitScript() {},
      waitForEvent: (ev, opts) => self.waitForEvent(ev === 'page' ? 'popup' : ev, opts),
      on() {}, off() {},
    };
  }

  async _waitComplete(timeout = 30000) {
    const end = Date.now() + timeout;
    await sleep(150);
    while (Date.now() < end) {
      let t; try { t = await chrome.tabs.get(this.tabId); } catch (_) { this._closed = true; throw new Error('Target page, context or browser has been closed'); }
      if (t.url) this._url = t.url;
      if (t.status === 'complete' && t.url && !/^about:blank$/.test(t.url)) { await sleep(300); return; }
      await sleep(250);
    }
    throw new Error('Timeout waiting for page to load');
  }

  async goto(url, { timeout = 60000 } = {}) { this._url = url; await chrome.tabs.update(this.tabId, { url }); await this._waitComplete(timeout); return { ok: () => true, status: () => 200 }; }
  async reload() { await chrome.tabs.reload(this.tabId); await sleep(300); await this._waitComplete(45000); }
  async goBack() { await chrome.tabs.goBack(this.tabId).catch(() => {}); await this._waitComplete(30000).catch(() => {}); }
  async waitForLoadState(state, { timeout = 30000 } = {}) { await this._waitComplete(timeout).catch(() => {}); }
  async waitForURL(re, { timeout = 30000 } = {}) { const end = Date.now() + timeout; while (Date.now() < end) { const u = this.url(); if (re instanceof RegExp ? re.test(u) : typeof re === 'function' ? re(new URL(u)) : u.includes(String(re).replace(/\*\*/g, ''))) return; await sleep(300); } throw new Error('Timeout waiting for URL'); }
  async waitForNavigation({ timeout = 30000 } = {}) { await sleep(500); await this._waitComplete(timeout).catch(() => {}); }
  async waitForTimeout(ms) { await sleep(ms); }
  async waitForSelector(sel, { timeout, state } = {}) {
    const end = Date.now() + (timeout || this._timeout);
    while (Date.now() < end) {
      const n = await this.locator(state === 'visible' || !state ? `${sel}` : sel).count().catch(() => 0);
      if (state === 'detached' || state === 'hidden') { if (!n) return null; } else if (n) return this.$(sel);
      await sleep(300);
    }
    throw new Error('Timeout waiting for ' + sel);
  }
  async content() { return this.evaluate(() => document.documentElement.outerHTML); }

  // Page-level function (collected at build time). Chrome runs it in the page.
  async evaluate(fn, arg) {
    const res = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: fn, args: arg === undefined ? [] : [arg] });
    const r = res && res[0];
    if (!r) throw new Error('evaluate: no result (page navigating?)');
    if (r.error) throw new Error(String(r.error.message || r.error));
    return r.result;
  }
  async waitForFunction(fn, arg, { timeout } = {}) {
    const end = Date.now() + (timeout || this._timeout);
    while (Date.now() < end) { const v = await this.evaluate(fn, arg).catch(() => null); if (v) return v; await sleep(300); }
    throw new Error('Timeout in waitForFunction');
  }
  // Rewritten calls from the shared code: obj.__call(method, id, ...args)
  __call(method, id, ...args) {
    if (method === 'evaluate' || method === 'evaluateHandle') return this.evaluate(args[0], args[1]);
    if (method === 'waitForFunction') return this.waitForFunction(args[0], args[1], args[2]);
    if (method === '$eval') return this._act(args[0], 0, 'reg', { id, arg: args[2] });
    if (method === '$$eval') return this._act(args[0], 0, 'regAll', { id, arg: args[2] });
    throw new Error('unsupported ' + method);
  }

  // Runs an element action through the injected helper, injecting it on first use per page.
  async _act(sel, idx, action, arg, scope) {
    const call = () => chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: (s, i, a, x, sc) => {
        if (!globalThis.__jobai) return { __noHelper: true };
        try { return { v: globalThis.__jobai.act(s, i, a, x, sc) }; } catch (e) { return { err: String((e && e.message) || e) }; }
      },
      args: [sel, idx, action, arg === undefined ? null : arg, scope || null],
    });
    let res = await call();
    let out = res && res[0] && res[0].result;
    if (out && out.__noHelper) { await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ['helper.js'] }); res = await call(); out = res && res[0] && res[0].result; }
    if (!out) throw new Error('page not ready');
    if (out.err) throw new Error(out.err);
    return out.v;
  }

  // Playwright-style shortcuts on the page.
  locator(sel) { return new Locator(this, sel, 0); }
  getByRole(role, o = {}) { return new Locator(this, `@role=${role}|${o.name instanceof RegExp ? 're:' + o.name.source + '|' + o.name.flags : String(o.name || '')}|${o.exact ? 1 : 0}`, 0); }
  getByText(text, o = {}) { return new Locator(this, `@text=${text instanceof RegExp ? 're:' + text.source + '|' + text.flags : String(text)}|${o.exact ? 1 : 0}`, 0); }
  getByLabel(text) { return new Locator(this, `@label=${String(text)}`, 0); }
  async $(sel) { const h = await this._act(sel, 0, 'mark').catch(() => null); return h ? new Handle(this, h) : null; }
  async $$(sel) { const hs = await this._act(sel, 0, 'markAll').catch(() => []); return (hs || []).map((h) => new Handle(this, h)); }
  click(sel) { return this.locator(sel).first().click(); }
  fill(sel, v) { return this.locator(sel).first().fill(v); }
  type(sel, v) { return this.locator(sel).first().type(v); }
  press(sel, k) { return this.locator(sel).first().press(k); }
  check(sel) { return this.locator(sel).first().check(); }
  selectOption(sel, v) { return this.locator(sel).first().selectOption(v); }
  isVisible(sel) { return this.locator(sel).first().isVisible(); }
  getAttribute(sel, n) { return this.locator(sel).first().getAttribute(n); }
  inputValue(sel) { return this.locator(sel).first().inputValue(); }
  textContent(sel) { return this.locator(sel).first().textContent(); }
  innerText(sel) { return this.locator(sel).first().innerText(); }
  setInputFiles(sel, files) { return this.locator(sel).first().setInputFiles(files); }

  // popup: a new tab opened by this one. filechooser: attach files to the page's file input
  // directly (an extension's click isn't a user gesture, so no system file dialog opens).
  async waitForEvent(ev, opts = {}) {
    const timeout = typeof opts === 'number' ? opts : (opts.timeout || this._timeout);
    if (ev === 'popup' || ev === 'page') {
      const before = new Set([...openedBy.keys()]);
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const id = [...openedBy.entries()].find(([k, o]) => o === this.tabId && !before.has(k));
        if (id) { const p = new Page(id[0], this.windowId); await p._waitComplete(15000).catch(() => {}); return p; }
        await sleep(250);
      }
      throw new Error('Timeout waiting for popup');
    }
    if (ev === 'filechooser') {
      await sleep(400);
      const page = this;
      return { page: () => page, isMultiple: () => false, element: async () => page.$('input[type=file]'), setFiles: (files) => page._act('input[type=file]', -1, 'setFiles', (Array.isArray(files) ? files : [files]).map(fileSpec)) };
    }
    await sleep(Math.min(timeout, 3000));
    throw new Error('Timeout waiting for ' + ev);
  }
}

class Locator {
  constructor(page, sel, idx, scope) { this.page = page; this.sel = sel; this.idx = idx; this.scope = scope; }
  _a(action, arg) { return this.page._act(this.sel, this.idx, action, arg, this.scope); }
  first() { return new Locator(this.page, this.sel, 0, this.scope); }
  last() { return new Locator(this.page, this.sel, -1, this.scope); }
  nth(i) { return new Locator(this.page, this.sel, i, this.scope); }
  locator(sub) { return new Locator(this.page, sub, 0, { sel: this.sel, idx: this.idx, scope: this.scope }); }
  filter() { return this; }
  count() { return this.page._act(this.sel, 0, 'count', null, this.scope); }
  async all() { const n = await this.count(); return Array.from({ length: n }, (_, i) => this.nth(i)); }
  async waitFor({ state = 'visible', timeout } = {}) {
    const end = Date.now() + (timeout || this.page._timeout);
    while (Date.now() < end) {
      const vis = await this.isVisible();
      if ((state === 'hidden' || state === 'detached') ? !vis : state === 'attached' ? (await this.count().catch(() => 0)) > 0 : vis) return;
      await sleep(250);
    }
    throw new Error('Timeout waiting for ' + this.sel);
  }
  click() { return this._a('click'); }
  dblclick() { return this._a('click'); }
  hover() { return this._a('scroll'); }
  tap() { return this._a('click'); }
  check() { return this._a('check').then((ok) => { if (!ok) throw new Error('could not check'); }); }
  uncheck() { return this._a('uncheck'); }
  setChecked(v) { return v ? this.check() : this.uncheck(); }
  isChecked() { return this._a('isChecked'); }
  isVisible() { return this._a('isVisible').catch(() => false); }
  isHidden() { return this.isVisible().then((v) => !v); }
  isEnabled() { return this._a('isEnabled').catch(() => false); }
  isDisabled() { return this.isEnabled().then((v) => !v); }
  isEditable() { return this.isEnabled(); }
  scrollIntoViewIfNeeded() { return this._a('scroll'); }
  focus() { return this._a('focus'); }
  blur() { return this._a('blur'); }
  getAttribute(n) { return this._a('getAttribute', n); }
  innerText() { return this._a('innerText'); }
  textContent() { return this._a('textContent'); }
  inputValue() { return this._a('inputValue'); }
  async allInnerTexts() { return this.page._act(this.sel, 0, 'allTexts', null, this.scope); }
  async allTextContents() { return this.allInnerTexts(); }
  fill(v) { return this._a('fill', v); }
  clear() { return this._a('fill', ''); }
  type(v) { return this._a('type', String(v)); }
  pressSequentially(v) { return this._a('type', String(v)); }
  press(k) { return this._a('press', k); }
  selectOption(o) { return this._a('selectOption', o); }
  dispatchEvent(type) { return this._a('dispatch', type); }
  setInputFiles(files) { return this._a('setFiles', (Array.isArray(files) ? files : [files]).map(fileSpec)); }
  boundingBox() { return this._a('box').catch(() => null); }
  async elementHandle() { const h = await this._a('mark').catch(() => null); return h ? new Handle(this.page, h) : null; }
  __op(name, arg) { return this._a('op', { name, arg: arg === undefined ? null : arg }); }
  __call(method, id, ...args) {
    if (method === 'evaluate' || method === 'evaluateHandle') return this._a('reg', { id, arg: args[1] });
    if (method === '$eval') return this.page._act(args[0], 0, 'reg', { id, arg: args[2] }, { sel: this.sel, idx: this.idx, scope: this.scope });
    if (method === '$$eval') return this.page._act(args[0], 0, 'regAll', { id, arg: args[2] }, { sel: this.sel, idx: this.idx, scope: this.scope });
    throw new Error('unsupported ' + method);
  }
  evaluate() { return Promise.reject(new Error('locator.evaluate must be rewritten at build time (see build.mjs)')); }
}

// An element handle = a Locator pinned to one tagged element.
class Handle extends Locator {
  constructor(page, mark) { super(page, `[data-jobai-h="${mark}"]`, 0); this.mark = mark; }
  async $(sel) { const h = await this.page._act(sel, 0, 'mark', null, { sel: this.sel, idx: 0 }).catch(() => null); return h ? new Handle(this.page, h) : null; }
  async $$(sel) { const hs = await this.page._act(sel, 0, 'markAll', null, { sel: this.sel, idx: 0 }).catch(() => []); return (hs || []).map((h) => new Handle(this.page, h)); }
  asElement() { return this; }
  async dispose() {}
  async contentFrame() { return null; }
  async ownerFrame() { return this.page; }
  async waitForElementState() {}
}
