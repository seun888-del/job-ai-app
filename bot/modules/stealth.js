// Anti-bot-detection scripts injected into every page before first navigation.
// Masks Playwright's automation fingerprints from site bot detectors.

const STEALTH_SCRIPT = `(function () {
  // 1. Hide webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 1b. Remove any Playwright/CDP runtime globals
  try { delete window.__playwright; } catch(_) {}
  try { delete window.__pw_manual; } catch(_) {}
  try { delete window.__puppeteer_evaluation_script__; } catch(_) {}

  // 2. Realistic plugin array
  try {
    const FakePlugin = function(name, fn, desc) {
      this.name = name; this.filename = fn; this.description = desc; this.length = 0;
    };
    const plugins = [
      new FakePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
      new FakePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
      new FakePlugin('Native Client', 'internal-nacl-plugin', ''),
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => plugins });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [] });
  } catch (_) {}

  // 3. Languages
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en-US', 'en'] }); } catch (_) {}

  // 4. Hardware
  try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }); } catch (_) {}
  try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 }); } catch (_) {}
  try { Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }); } catch (_) {}

  // 5. Canvas fingerprint noise (tiny, invisible)
  try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      if (this.width > 0 && this.height > 0) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const noise = (Math.random() * 2 - 1) * 0.0001;
          ctx.fillStyle = 'rgba(255,255,255,' + noise + ')';
          ctx.fillRect(0, 0, 1, 1);
        }
      }
      return origToDataURL.apply(this, arguments);
    };
  } catch (_) {}

  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh) {
      const d = origGetImageData.call(this, sx, sy, sw, sh);
      const i = Math.floor(Math.random() * (d.data.length / 4)) * 4;
      d.data[i] = (d.data[i] ^ 1) & 0xFF;
      return d;
    };
  } catch (_) {}

  // 6. WebGL vendor/renderer — look like a real laptop GPU
  try {
    const _getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return _getParam.call(this, p);
    };
  } catch (_) {}
  try {
    const _getParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return _getParam2.call(this, p);
    };
  } catch (_) {}

  // 7. Permissions API — notifications always prompt (real browser behaviour)
  try {
    const _query = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') return Promise.resolve({ state: 'prompt' });
      return _query(params);
    };
  } catch (_) {}

  // 8. Chrome runtime stub — headless Chromium lacks window.chrome
  try {
    if (!window.chrome) {
      window.chrome = {
        runtime: {
          onConnect: { addListener: function() {} },
          onMessage: { addListener: function() {} },
          sendMessage: function() {},
          connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} }; },
        },
        loadTimes: function() { return {}; },
        csi: function() { return {}; },
        app: { isInstalled: false, InstallState: {}, RunningState: {} },
      };
    }
  } catch (_) {}

  // 9. Prevent iframe contentWindow.navigator.webdriver leak
  try {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      return origAttachShadow.call(this, init || { mode: 'open' });
    };
  } catch (_) {}

  // 10. navigator.vendor — real Chrome always returns "Google Inc."
  try { Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' }); } catch(_) {}

  // 11. window.outerWidth / outerHeight — should match a real browser window
  try {
    Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth  || 1366 });
    Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 768) + 74 });
  } catch(_) {}

  // 12. document.hasFocus — bots are typically considered out-of-focus
  try { document.hasFocus = () => true; } catch(_) {}

  // 13. navigator.connection — expose a realistic network info object
  try {
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ rtt: 100, downlink: 10, effectiveType: '4g', saveData: false }),
      });
    }
  } catch(_) {}

  // 14. Hide automation-related error stack traces leaking "puppeteer" / "playwright"
  try {
    const origPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = function(err, stack) {
      const s = origPrepareStackTrace ? origPrepareStackTrace(err, stack) : String(err);
      return typeof s === 'string' ? s.replace(/playwright|puppeteer|chromium/gi, 'chrome') : s;
    };
  } catch(_) {}

  // 15. Realistic screen properties
  try { Object.defineProperty(screen, 'colorDepth',  { get: () => 24 }); } catch(_) {}
  try { Object.defineProperty(screen, 'pixelDepth',  { get: () => 24 }); } catch(_) {}
})();`;

async function applyToPage(page) {
  await page.addInitScript(STEALTH_SCRIPT);
}

async function applyToContext(context) {
  await context.addInitScript(STEALTH_SCRIPT);
}

module.exports = { applyToPage, applyToContext };
