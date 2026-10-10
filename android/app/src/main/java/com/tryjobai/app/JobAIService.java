package com.tryjobai.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.content.pm.ApplicationInfo;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Owns everything that must keep running when the screen is off: the dashboard page (which
// runs the agents, same code as the Chrome extension) and each agent "tab" (a hidden WebView).
// The dashboard talks to this class through window.JobAIAndroid (see android-chrome.js).
public class JobAIService extends Service {
  static final String TAG = "JobAI";
  static final String ORIGIN = "https://appassets.androidplatform.net";
  static final String CH = "agents";
  static JobAIService instance;

  final Handler main = new Handler(Looper.getMainLooper());
  final Map<Integer, Tab> tabs = new HashMap<>();
  final Map<Integer, String> results = new ConcurrentHashMap<>();
  final ExecutorService io = Executors.newFixedThreadPool(4);
  WebView host;
  MutableContextWrapper hostCtx;
  MainActivity activity;
  Tab shown;
  int tabSeq = 0;
  String statusText = "Ready";
  String desktopUA;
  PowerManager.WakeLock wake;

  static class Tab {
    int id, windowId, openerId;
    boolean closeOnHide; // a sign-in page the user opened: closed again when they tap Done
    WebView wv;
    MutableContextWrapper ctx;
    String url = "about:blank", title = "", status = "complete";
  }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "STOP".equals(intent.getAction())) {
      if (activity != null) activity.finishAndRemoveTask();
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
      return START_NOT_STICKY;
    }
    if (instance != null) return START_STICKY;
    instance = this;
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel(CH, "Job-AI agents", NotificationManager.IMPORTANCE_LOW));
    if (Build.VERSION.SDK_INT >= 29) startForeground(1, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    else startForeground(1, notification());
    wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jobai:agents");
    wake.acquire();
    boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    WebView.setWebContentsDebuggingEnabled(debuggable);
    CookieManager.getInstance().setAcceptCookie(true);
    createHost();
    return START_STICKY;
  }

  @Override public void onDestroy() {
    instance = null;
    main.removeCallbacksAndMessages(null);
    for (Tab t : tabs.values()) t.wv.destroy();
    tabs.clear();
    if (host != null) host.destroy();
    if (parkWin != null) parkWin.dismiss();
    if (parkDisplay != null) parkDisplay.release();
    if (parkReader != null) parkReader.close();
    if (wake != null && wake.isHeld()) wake.release();
    io.shutdownNow();
    super.onDestroy();
  }

  Notification notification() {
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, JobAIService.class).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, CH).setContentTitle("Job-AI").setContentText(statusText)
      .setSmallIcon(R.drawable.ic_stat_jobai).setOngoing(true).setContentIntent(open)
      .addAction(new Notification.Action.Builder(null, "Quit Job-AI", stop).build()).build();
  }

  // ── The dashboard page ──────────────────────────────────────────────────────
  void createHost() {
    hostCtx = new MutableContextWrapper(this);
    host = new WebView(hostCtx);
    desktopUA = new WebSettings_UA(host.getSettings().getUserAgentString()).desktop();
    WebSettings s = host.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    WebViewAssetLoader loader = new WebViewAssetLoader.Builder().addPathHandler("/", this::asset).build();
    host.addJavascriptInterface(new HostBridge(), "JobAIAndroid");
    host.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return loader.shouldInterceptRequest(r.getUrl()); }
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        if (r.getUrl().toString().startsWith(ORIGIN)) return false;
        openExternal(r.getUrl().toString());
        return true;
      }
      @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
        Log.e(TAG, "dashboard renderer gone; restarting");
        main.post(() -> { ViewGroup p = (ViewGroup) host.getParent(); if (p != null) p.removeView(host); host.destroy(); createHost(); if (activity != null) activity.attachHost(host); });
        return true;
      }
    });
    host.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
        if (activity == null) { cb.onReceiveValue(null); return true; }
        return activity.pickFile(cb, p);
      }
      @Override public boolean onConsoleMessage(ConsoleMessage m) { Log.i(TAG, "[dashboard] " + m.message()); return true; }
    });
    host.loadUrl(ORIGIN + "/dashboard.html");
    if (activity != null) activity.attachHost(host);
  }

  WebResourceResponse asset(String path) {
    try {
      InputStream is = getAssets().open("www/" + path);
      String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css"
        : (path.endsWith(".js") || path.endsWith(".mjs")) ? "application/javascript"
        : path.endsWith(".png") ? "image/png" : path.endsWith(".woff2") ? "font/woff2"
        : (path.endsWith(".json") || path.endsWith(".map")) ? "application/json" : "application/octet-stream";
      return new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("javascript") ? "utf-8" : null, is);
    } catch (IOException e) { return null; }
  }

  class HostBridge {
    @JavascriptInterface public void call(String json) { main.post(() -> dispatch(json)); }
    @JavascriptInterface public String take(int id) { return results.remove(id); }
    @JavascriptInterface public String version() {
      try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "0.0.0"; }
    }
  }

  void ready(int id, String json) {
    results.put(id, json);
    main.post(() -> { if (host != null) host.evaluateJavascript("window.__jobaiNative&&__jobaiNative.ready(" + id + ")", null); });
  }
  void reply(int id, JSONObject o) { if (id > 0) ready(id, o.toString()); }
  void event(JSONObject e) { if (host != null) host.evaluateJavascript("window.__jobaiNative&&__jobaiNative.event(" + e + ")", null); }

  void dispatch(String json) {
    int id = 0;
    try {
      JSONObject m = new JSONObject(json);
      id = m.optInt("id");
      JSONObject a = m.optJSONObject("args");
      if (a == null) a = new JSONObject();
      Tab t = tabs.get(a.optInt("tabId", -1));
      JSONObject ok = new JSONObject().put("ok", true);
      switch (m.getString("op")) {
        case "tabCreate": {
          Tab n = newTab(a.optInt("windowId", 1), -1);
          n.closeOnHide = a.optBoolean("closeOnHide", false);
          String url = a.optString("url", "about:blank");
          if (url.startsWith("http")) { n.status = "loading"; n.url = url; n.wv.loadUrl(url); }
          reply(id, new JSONObject().put("id", n.id));
          return;
        }
        case "tabNavigate": if (t != null) { t.status = "loading"; t.url = a.getString("url"); t.wv.loadUrl(t.url); } reply(id, ok); return;
        case "tabReload": if (t != null) t.wv.reload(); reply(id, ok); return;
        case "tabBack": if (t != null && t.wv.canGoBack()) t.wv.goBack(); reply(id, ok); return;
        case "tabRemove": if (t != null) closeTab(t, false); reply(id, ok); return;
        case "tabShow": if (t != null) show(t); reply(id, ok); return;
        case "tabHide": hide(); reply(id, ok); return;
        case "tabExec": {
          int callId = a.getInt("callId");
          if (t == null) ready(callId, "null");
          else t.wv.evaluateJavascript(a.getString("code"), null);
          return;
        }
        case "openExternal": openExternal(a.getString("url")); reply(id, ok); return;
        case "phoneState": {
          boolean notif = getSystemService(NotificationManager.class).areNotificationsEnabled();
          boolean batt = getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
          reply(id, new JSONObject().put("notifications", notif).put("battery", batt));
          return;
        }
        case "askNotifications": if (activity != null) activity.askNotifications(); reply(id, ok); return;
        case "askBattery": if (activity != null) activity.askBattery(); reply(id, ok); return;
        case "notify": needsYou(a.optString("text", "")); reply(id, ok); return;
        case "status": statusText = a.optString("text", "Ready"); getSystemService(NotificationManager.class).notify(1, notification()); reply(id, ok); return;
        case "http": {
          final int rid = id; final JSONObject args = a;
          io.submit(() -> reply(rid, http(args)));
          return;
        }
        default: reply(id, new JSONObject().put("error", "unknown op"));
      }
    } catch (Exception e) {
      Log.e(TAG, "dispatch failed", e);
      try { reply(id, new JSONObject().put("error", String.valueOf(e.getMessage()))); } catch (Exception ignored) {}
    }
  }

  void openExternal(String url) {
    if (!url.startsWith("http")) return;
    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
  }

  // ── Agent tabs: hidden WebViews ─────────────────────────────────────────────
  Tab newTab(int windowId, int openerId) {
    Tab t = new Tab();
    t.id = ++tabSeq; t.windowId = windowId; t.openerId = openerId;
    t.ctx = new MutableContextWrapper(this);
    t.wv = new WebView(t.ctx);
    WebSettings s = t.wv.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setUserAgentString(desktopUA);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportMultipleWindows(true);
    s.setJavaScriptCanOpenWindowsAutomatically(true);
    s.setMediaPlaybackRequiresUserGesture(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    CookieManager.getInstance().setAcceptThirdPartyCookies(t.wv, true);
    t.wv.addJavascriptInterface(new TabBridge(), "JobAITab");
    t.wv.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) { t.url = url; t.status = "loading"; sendTab(t); }
      @Override public void onPageFinished(WebView v, String url) { t.url = url; t.title = v.getTitle() == null ? "" : v.getTitle(); t.status = "complete"; sendTab(t); }
      @Override public void doUpdateVisitedHistory(WebView v, String url, boolean reload) { if (!url.equals(t.url)) { t.url = url; sendTab(t); } }
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { String sc = r.getUrl().getScheme(); return !("http".equals(sc) || "https".equals(sc)); }
      @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) { Log.e(TAG, "tab " + t.id + " renderer gone"); closeTab(t, true); return true; }
    });
    t.wv.setWebChromeClient(new WebChromeClient() {
      @Override public void onReceivedTitle(WebView v, String title) { t.title = title == null ? "" : title; sendTab(t); }
      @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean gesture, Message msg) {
        Tab c = newTab(t.windowId, t.id);
        c.status = "loading";
        ((WebView.WebViewTransport) msg.obj).setWebView(c.wv);
        msg.sendToTarget();
        sendTab(c);
        return true;
      }
      @Override public void onCloseWindow(WebView v) { closeTab(t, true); }
      // Job sites' pop-up dialogs never block the agent.
      @Override public boolean onJsAlert(WebView v, String u, String msg, JsResult r) { r.confirm(); return true; }
      @Override public boolean onJsConfirm(WebView v, String u, String msg, JsResult r) { r.confirm(); return true; }
      @Override public boolean onJsPrompt(WebView v, String u, String msg, String def, JsPromptResult r) { r.cancel(); return true; }
      @Override public boolean onJsBeforeUnload(WebView v, String u, String msg, JsResult r) { r.confirm(); return true; }
      // The agent attaches CVs itself; never open the phone's file picker for a job site.
      @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) { cb.onReceiveValue(null); return true; }
    });
    layoutHidden(t.wv);
    tabs.put(t.id, t);
    return t;
  }

  // Off screen, pages still get a normal desktop-sized layout (the shared code checks visibility).
  void layoutHidden(WebView wv) {
    float d = getResources().getDisplayMetrics().density;
    int w = Math.round(1280 * d), h = Math.round(900 * d);
    wv.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
    wv.layout(0, 0, w, h);
  }

  class TabBridge {
    @JavascriptInterface public void result(int callId, String json) { ready(callId, json); }
  }

  void sendTab(Tab t) {
    try {
      JSONObject tab = new JSONObject().put("id", t.id).put("windowId", t.windowId).put("url", t.url).put("title", t.title).put("status", t.status);
      if (t.openerId > 0) tab.put("openerTabId", t.openerId);
      event(new JSONObject().put("type", "tab").put("tab", tab));
    } catch (Exception ignored) {}
  }

  void closeTab(Tab t, boolean notify) {
    if (tabs.remove(t.id) == null) return;
    if (shown == t) hide();
    t.wv.stopLoading();
    MainActivity.detachFromParent(t.wv);
    main.post(t.wv::destroy);
    if (notify) try { event(new JSONObject().put("type", "tabRemoved").put("id", t.id)); } catch (Exception ignored) {}
  }

  // Show an agent's page full screen (e.g. Trac or Reed asks the user to sign in).
  void show(Tab t) {
    shown = t;
    if (activity != null) activity.showTab(t);
    else needsYou();
  }
  void hide() {
    Tab t = shown; shown = null;
    if (activity != null) activity.hideTab();
    getSystemService(NotificationManager.class).cancel(2);
    if (t == null) return;
    if (t.closeOnHide) { closeTab(t, true); return; }
    parkView(t.wv, t.ctx);
  }

  // An agent needs the user (a site asks them to sign in) while the app is in the background.
  void needsYou() { needsYou(""); }
  void needsYou(String text) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel("needs_you", "Needs you", NotificationManager.IMPORTANCE_HIGH));
    PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    nm.notify(2, new Notification.Builder(this, "needs_you").setContentTitle("Job-AI needs you")
      .setContentText(text.isEmpty() ? "A job site is asking you to sign in. Tap to open it." : text)
      .setSmallIcon(R.drawable.ic_stat_jobai).setAutoCancel(true).setContentIntent(open).build());
  }

  // ── The activity (UI) comes and goes; the service and its pages stay ─────────
  void attach(MainActivity a) {
    activity = a;
    hostCtx.setBaseContext(a);
    a.attachHost(host);
    if (shown != null) a.showTab(shown);
  }
  // ── Off-screen parking ───────────────────────────────────────────────────────
  // A page that has been on screen and is then hidden gets frozen by the web engine after about
  // 5 minutes, which would stop the agents. So whenever the app's screen goes away, its pages move
  // to a window on the app's own private virtual display: still "on screen" as far as the engine
  // knows, invisible to the user, no permission needed. They move back when the app opens.
  android.hardware.display.VirtualDisplay parkDisplay;
  android.media.ImageReader parkReader;
  android.app.Presentation parkWin;
  android.widget.FrameLayout parkRoot;

  boolean ensureParking() {
    if (parkWin != null) return true;
    try {
      android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
      int w = Math.max(dm.widthPixels, 720), h = Math.max(dm.heightPixels, 1280);
      parkReader = android.media.ImageReader.newInstance(w, h, android.graphics.PixelFormat.RGBA_8888, 2);
      parkReader.setOnImageAvailableListener(r -> { android.media.Image i = r.acquireLatestImage(); if (i != null) i.close(); }, main);
      parkDisplay = getSystemService(android.hardware.display.DisplayManager.class).createVirtualDisplay("jobai-park", w, h, dm.densityDpi,
        parkReader.getSurface(), android.hardware.display.DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY);
      parkWin = new android.app.Presentation(this, parkDisplay.getDisplay());
      parkRoot = new android.widget.FrameLayout(parkWin.getContext());
      parkWin.setContentView(parkRoot);
      parkWin.show();
      return true;
    } catch (Exception e) {
      Log.e(TAG, "parking display unavailable", e);
      parkWin = null;
      return false;
    }
  }

  void parkView(WebView wv, MutableContextWrapper ctx) {
    if (ensureParking()) {
      ctx.setBaseContext(parkWin.getContext());
      MainActivity.detachFromParent(wv);
      parkRoot.addView(wv, new android.widget.FrameLayout.LayoutParams(-1, -1));
    } else {
      MainActivity.detachFromParent(wv);
      ctx.setBaseContext(this);
    }
  }

  void park() {
    if (activity == null) return;
    activity.detachViews();
    parkView(host, hostCtx);
    Log.i(TAG, "pages parked " + (parkWin != null ? "on the private display" : "off screen (no private display)"));
    if (shown != null) parkView(shown.wv, shown.ctx);
  }

  void detach(MainActivity a) {
    if (activity != a) return;
    a.detachViews();
    activity = null;
    parkView(host, hostCtx);
    if (shown != null) parkView(shown.wv, shown.ctx);
  }

  // ── fetch() to other sites, done natively (no CORS; shares the WebViews' cookies) ──
  JSONObject http(JSONObject a) {
    JSONObject out = new JSONObject();
    try {
      String method = a.getString("method");
      URL url = new URL(a.getString("url"));
      JSONObject hs = a.optJSONObject("headers");
      byte[] body = a.isNull("body") ? null : Base64.decode(a.getString("body"), Base64.DEFAULT);
      CookieManager cm = CookieManager.getInstance();
      HttpURLConnection c = null;
      for (int hop = 0; hop < 8; hop++) {
        c = (HttpURLConnection) url.openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(30000);
        c.setReadTimeout(60000);
        c.setRequestMethod(method);
        boolean ua = false, cookie = false;
        if (hs != null) for (Iterator<String> it = hs.keys(); it.hasNext(); ) {
          String k = it.next(), lk = k.toLowerCase();
          if (lk.equals("host") || lk.equals("content-length") || lk.equals("accept-encoding") || lk.equals("connection")) continue;
          if (lk.equals("user-agent")) ua = true;
          if (lk.equals("cookie")) cookie = true;
          c.setRequestProperty(k, hs.getString(k));
        }
        if (!ua) c.setRequestProperty("User-Agent", desktopUA);
        if (!cookie) { String ck = cm.getCookie(url.toString()); if (ck != null) c.setRequestProperty("Cookie", ck); }
        if (body != null) { c.setDoOutput(true); try (OutputStream os = c.getOutputStream()) { os.write(body); } }
        int code = c.getResponseCode();
        for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet())
          if (e.getKey() != null && e.getKey().equalsIgnoreCase("set-cookie")) for (String v : e.getValue()) cm.setCookie(url.toString(), v);
        String loc = c.getHeaderField("Location");
        if (code >= 300 && code < 400 && loc != null) {
          url = new URL(url, loc);
          if (code == 303 || ((code == 301 || code == 302) && !method.equals("GET") && !method.equals("HEAD"))) { method = "GET"; body = null; }
          c.disconnect();
          continue;
        }
        break;
      }
      cm.flush();
      int code = c.getResponseCode();
      InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      if (is != null) { byte[] b = new byte[16384]; int n; while ((n = is.read(b)) > 0) buf.write(b, 0, n); is.close(); }
      JSONObject headers = new JSONObject();
      for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
        if (e.getKey() == null || e.getKey().equalsIgnoreCase("set-cookie")) continue;
        headers.put(e.getKey().toLowerCase(), String.join(", ", e.getValue()));
      }
      out.put("status", code).put("statusText", c.getResponseMessage() == null ? "" : c.getResponseMessage())
        .put("headers", headers).put("body", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP)).put("url", url.toString());
      c.disconnect();
    } catch (Exception e) {
      try { out.put("failed", e.getClass().getSimpleName() + ": " + e.getMessage()); } catch (Exception ignored) {}
    }
    return out;
  }

  // The WebView's own user agent, minus the WebView markers: what desktop Chrome would send.
  static class WebSettings_UA {
    final String ua;
    WebSettings_UA(String ua) { this.ua = ua; }
    String desktop() {
      java.util.regex.Matcher m = java.util.regex.Pattern.compile("Chrome/([\\d.]+)").matcher(ua);
      String v = m.find() ? m.group(1) : "130.0.0.0";
      return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + " Safari/537.36";
    }
  }
}
