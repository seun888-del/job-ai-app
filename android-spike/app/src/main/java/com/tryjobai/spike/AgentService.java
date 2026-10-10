package com.tryjobai.spike;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

// Spike: a hidden WebView owned by a foreground service runs a Reed search -> read jobs loop
// forever, logging every step with screen/charging state, so we can see whether Android keeps
// it alive (and keeps page JS running at full speed) with the screen locked.
public class AgentService extends Service {
  static final String TAG = "JobAISpike";
  static final String CH = "agent";
  static volatile boolean running = false;
  static final String[] TERMS = { "it-support", "customer-service", "administrator" };
  static final long STEP_TIMEOUT_MS = 90_000;
  static final long ROUND_GAP_MS = 2 * 60_000;

  Handler h;
  WebView web;
  PowerManager.WakeLock wake;
  int round = 0, termIx = 0, jobIx = 0;
  List<String> jobs = new ArrayList<>();
  String step = "";
  long stepStarted;
  Runnable onLoaded;
  int stalls = 0, pagesOk = 0;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    if (running) return START_STICKY;
    running = true;
    h = new Handler(Looper.getMainLooper());
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel(CH, "Agent running", NotificationManager.IMPORTANCE_LOW));
    Notification n = notif("Starting...");
    if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    else startForeground(1, n);
    wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jobai:agent");
    wake.acquire();
    setupWeb();
    log("SERVICE START");
    h.postDelayed(watchdog, 5000);
    nextRound();
    return START_STICKY;
  }

  @Override public void onDestroy() {
    running = false;
    log("SERVICE STOP (rounds=" + round + " pages=" + pagesOk + " stalls=" + stalls + ")");
    if (h != null) h.removeCallbacksAndMessages(null);
    if (web != null) { web.stopLoading(); web.destroy(); }
    if (wake != null && wake.isHeld()) wake.release();
    super.onDestroy();
  }

  Notification notif(String text) {
    Intent open = new Intent(this, MainActivity.class);
    android.app.PendingIntent pi = android.app.PendingIntent.getActivity(this, 0, open, android.app.PendingIntent.FLAG_IMMUTABLE);
    return new Notification.Builder(this, CH).setContentTitle("Job-AI is applying").setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true).setContentIntent(pi).build();
  }

  void status(String text) { getSystemService(NotificationManager.class).notify(1, notif(text)); }

  void setupWeb() {
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    // Look like normal Chrome, not an embedded WebView.
    s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/[\\d.]+ ", ""));
    // Never attached to a window: give it a real phone-sized layout so pages lay out normally.
    int w = 1080, hgt = 2200;
    web.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(hgt, View.MeasureSpec.EXACTLY));
    web.layout(0, 0, w, hgt);
    web.addJavascriptInterface(new Bridge(), "JobAIBridge");
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageFinished(WebView v, String url) {
        Runnable r = onLoaded; onLoaded = null;
        if (r != null) h.postDelayed(r, 2500);
      }
    });
  }

  // Async page op result channel (what the real page driver will use for awaited ops).
  class Bridge {
    @JavascriptInterface public void done(String id, String json) {
      h.post(() -> asyncDone(id, json));
    }
  }

  void begin(String name) { step = name; stepStarted = SystemClock.elapsedRealtime(); }

  final Runnable watchdog = new Runnable() {
    @Override public void run() {
      if (!running) return;
      if (!step.isEmpty() && SystemClock.elapsedRealtime() - stepStarted > STEP_TIMEOUT_MS) {
        stalls++;
        log("STALL in step '" + step + "' after " + (SystemClock.elapsedRealtime() - stepStarted) / 1000 + "s, moving on");
        onLoaded = null; step = "";
        web.stopLoading();
        h.post(AgentService.this::nextJob);
      }
      h.postDelayed(this, 5000);
    }
  };

  void nextRound() {
    if (!running) return;
    round++;
    String term = TERMS[termIx++ % TERMS.length];
    String url = "https://www.reed.co.uk/jobs/" + term + "-jobs";
    log("ROUND " + round + " search " + term);
    status("Round " + round + ": searching " + term);
    begin("search");
    onLoaded = this::afterSearch;
    web.loadUrl(url);
  }

  void afterSearch() {
    // Start an in-page heartbeat, then come back 20s later to see how many ticks ran.
    web.evaluateJavascript("window.__hb=0;window.__hbStart=Date.now();setInterval(function(){window.__hb++},1000);" +
      "JSON.stringify({t:document.title,l:Array.from(new Set(Array.from(document.querySelectorAll('a[href*=\"/jobs/\"]')).map(function(a){return a.href.split('?')[0]}).filter(function(h){return /\\/jobs\\/[^/]+\\/\\d+$/.test(h)}))).slice(0,5)})",
      (res) -> {
        jobs.clear();
        String title = "?";
        try {
          JSONObject o = new JSONObject(new JSONArray("[" + res + "]").getString(0));
          title = o.optString("t");
          JSONArray a = o.getJSONArray("l");
          for (int i = 0; i < a.length(); i++) jobs.add(a.getString(i));
        } catch (Exception e) { log("parse error: " + res); }
        pagesOk++;
        log("search found " + jobs.size() + " job link(s), page title: " + title);
        h.postDelayed(this::heartbeatCheck, 20_000);
      });
  }

  void heartbeatCheck() {
    if (!running) return;
    web.evaluateJavascript("JSON.stringify({hb:window.__hb,secs:Math.round((Date.now()-window.__hbStart)/1000)})",
      (res) -> {
        log("page timer heartbeat " + res + " (expect hb ~= secs)");
        // Async op test: page awaits a timer, then reports back through the bridge.
        begin("async-op");
        web.evaluateJavascript("(async function(){var t=Date.now();await new Promise(function(r){setTimeout(r,1500)});" +
          "JobAIBridge.done('wait', JSON.stringify({ms:Date.now()-t,title:document.title}))})()", null);
      });
  }

  void asyncDone(String id, String json) {
    if (!"async-op".equals(step)) return;
    log("async op '" + id + "' returned " + json);
    jobIx = 0;
    nextJob();
  }

  void nextJob() {
    if (!running) return;
    if (jobIx >= jobs.size()) {
      step = "";
      log("ROUND " + round + " done. Next in " + ROUND_GAP_MS / 60000 + " min");
      status("Round " + round + " done (" + pagesOk + " pages, " + stalls + " stalls)");
      h.postDelayed(this::nextRound, ROUND_GAP_MS);
      return;
    }
    String url = jobs.get(jobIx++);
    begin("job");
    onLoaded = () -> web.evaluateJavascript(
      "(function(){var d=document.querySelector('[data-qa=\"job-description\"]')||document.querySelector('main')||document.body;" +
      "return JSON.stringify({title:(document.querySelector('h1')||{}).innerText||'',words:(d.innerText||'').split(/\\s+/).length})})()",
      (res) -> { pagesOk++; log("job read " + res); step = ""; h.postDelayed(this::nextJob, 3000); });
    web.loadUrl(url);
  }

  void log(String m) {
    PowerManager pm = getSystemService(PowerManager.class);
    Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
    int plug = b == null ? 0 : b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
    int lvl = b == null ? -1 : b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
    String line = new SimpleDateFormat("HH:mm:ss", Locale.UK).format(new Date()) +
      " [screen " + (pm.isInteractive() ? "on" : "OFF") + (plug != 0 ? ", charging" : ", battery") + " " + lvl + "%" +
      (pm.isDeviceIdleMode() ? ", DOZE" : "") + "] " + m;
    Log.i(TAG, line);
    try (FileWriter f = new FileWriter(new File(getFilesDir(), "spike.log"), true)) { f.write(line + "\n"); } catch (Exception ignored) {}
  }

  static File logFile(Context c) { return new File(c.getFilesDir(), "spike.log"); }
}
