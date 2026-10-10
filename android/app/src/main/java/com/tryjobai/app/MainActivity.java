package com.tryjobai.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

// The screen. It only shows views the service owns (the dashboard and, when a site needs the
// user, an agent's page), so closing it never stops the agents.
public class MainActivity extends Activity {
  // The app's own colours (src/renderer/styles.css): --surface-alt, --bg, --border, --text, --primary.
  static final int SURFACE_ALT = 0xFFFBF9F4, BG = 0xFFF6F4EF, BORDER = 0xFFE6E1D6, TEXT = 0xFF1C1B17, PRIMARY = 0xFF3B82F6;
  static final int PICK = 42;

  final Handler h = new Handler(Looper.getMainLooper());
  FrameLayout root, hostFrame, tabFrame;
  LinearLayout overlay;
  ValueCallback<Uri[]> fileCb;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
    getWindow().setStatusBarColor(SURFACE_ALT);
    getWindow().setNavigationBarColor(BG);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

    root = new FrameLayout(this);
    root.setBackgroundColor(SURFACE_ALT);
    hostFrame = new FrameLayout(this);
    root.addView(hostFrame, new FrameLayout.LayoutParams(-1, -1));
    root.addView(buildOverlay(), new FrameLayout.LayoutParams(-1, -1));
    // Draw inside the status bar, navigation bar and keyboard, not under them.
    root.setOnApplyWindowInsetsListener((v, in) -> {
      int l, t, r, bt;
      if (Build.VERSION.SDK_INT >= 30) {
        Insets s = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
        l = s.left; t = s.top; r = s.right; bt = s.bottom;
      } else { l = in.getSystemWindowInsetLeft(); t = in.getSystemWindowInsetTop(); r = in.getSystemWindowInsetRight(); bt = in.getSystemWindowInsetBottom(); }
      v.setPadding(l, t, r, bt);
      return in;
    });
    setContentView(root);

    startForegroundService(new Intent(this, JobAIService.class));
    h.post(new Runnable() {
      @Override public void run() {
        JobAIService s = JobAIService.instance;
        if (s != null && s.host != null) s.attach(MainActivity.this); else h.postDelayed(this, 50);
      }
    });
  }

  // Bar shown above an agent's page when a site needs the user (sign in, check a form).
  View buildOverlay() {
    overlay = new LinearLayout(this);
    overlay.setOrientation(LinearLayout.VERTICAL);
    overlay.setBackgroundColor(SURFACE_ALT);
    overlay.setVisibility(View.GONE);
    LinearLayout bar = new LinearLayout(this);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(16), dp(10), dp(12), dp(10));
    bar.setBackgroundColor(SURFACE_ALT);
    TextView msg = new TextView(this);
    msg.setText("Sign in here, then tap Done. Job-AI carries on by itself.");
    msg.setTextColor(TEXT);
    msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
    bar.addView(msg, new LinearLayout.LayoutParams(0, -2, 1f));
    Button done = new Button(this);
    done.setText("Done");
    done.setAllCaps(false);
    done.setTextColor(Color.WHITE);
    done.setTypeface(Typeface.DEFAULT_BOLD);
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(PRIMARY);
    bg.setCornerRadius(dp(8));
    done.setBackground(bg);
    done.setMinHeight(dp(40)); done.setMinimumHeight(dp(40));
    done.setPadding(dp(18), 0, dp(18), 0);
    done.setOnClickListener(v -> { JobAIService s = JobAIService.instance; if (s != null) s.hide(); else hideTab(); });
    bar.addView(done, new LinearLayout.LayoutParams(-2, dp(40)));
    overlay.addView(bar, new LinearLayout.LayoutParams(-1, -2));
    View line = new View(this);
    line.setBackgroundColor(BORDER);
    overlay.addView(line, new LinearLayout.LayoutParams(-1, dp(1)));
    tabFrame = new FrameLayout(this);
    overlay.addView(tabFrame, new LinearLayout.LayoutParams(-1, 0, 1f));
    return overlay;
  }

  int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

  static void detachFromParent(View v) { ViewGroup p = (ViewGroup) v.getParent(); if (p != null) p.removeView(v); }

  void attachHost(WebView host) {
    detachFromParent(host);
    hostFrame.removeAllViews();
    hostFrame.addView(host, new FrameLayout.LayoutParams(-1, -1));
  }

  void showTab(JobAIService.Tab t) {
    t.ctx.setBaseContext(this);
    detachFromParent(t.wv);
    tabFrame.removeAllViews();
    tabFrame.addView(t.wv, new FrameLayout.LayoutParams(-1, -1));
    overlay.setVisibility(View.VISIBLE);
  }

  void hideTab() {
    tabFrame.removeAllViews();
    overlay.setVisibility(View.GONE);
  }

  void detachViews() { hostFrame.removeAllViews(); tabFrame.removeAllViews(); }

  boolean pickFile(ValueCallback<Uri[]> cb, WebChromeClient.FileChooserParams p) {
    if (fileCb != null) fileCb.onReceiveValue(null);
    fileCb = cb;
    try { startActivityForResult(p.createIntent(), PICK); return true; }
    catch (Exception e) { fileCb = null; cb.onReceiveValue(null); return true; }
  }

  @Override protected void onActivityResult(int req, int res, Intent data) {
    if (req == PICK && fileCb != null) { fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data)); fileCb = null; return; }
    super.onActivityResult(req, res, data);
  }

  @Override public void onBackPressed() {
    JobAIService s = JobAIService.instance;
    if (overlay.getVisibility() == View.VISIBLE && s != null && s.shown != null) {
      if (s.shown.wv.canGoBack()) s.shown.wv.goBack(); else s.hide();
      return;
    }
    // Leave the app without closing it: the agents keep working.
    moveTaskToBack(true);
  }

  // Off screen (app in the background or the screen locked) the dashboard must not count as a
  // hidden page: Chrome slows hidden pages down and freezes them after about 5 minutes, which
  // would stop the agents. So it is taken off the screen and kept as a never-shown page, the
  // same state the background test proved runs at full speed. It comes back on onStart.
  @Override protected void onStart() {
    super.onStart();
    JobAIService s = JobAIService.instance;
    if (s != null && s.host != null && s.activity == this) s.attach(this);
  }

  @Override protected void onStop() {
    JobAIService s = JobAIService.instance;
    if (s != null && s.activity == this) s.park();
    super.onStop();
  }

  @Override protected void onDestroy() {
    JobAIService s = JobAIService.instance;
    if (s != null) s.detach(this);
    h.removeCallbacksAndMessages(null);
    super.onDestroy();
  }
}
