package com.tryjobai.spike;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.nio.file.Files;
import java.util.List;

public class MainActivity extends Activity {
  TextView logView;
  final Handler h = new Handler(Looper.getMainLooper());

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
    LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setPadding(32, 48, 32, 32);
    Button start = new Button(this); start.setText("Start test");
    Button stop = new Button(this); stop.setText("Stop test");
    Button battery = new Button(this); battery.setText("Allow running in background");
    Button clear = new Button(this); clear.setText("Clear log");
    start.setOnClickListener(v -> startForegroundService(new Intent(this, AgentService.class)));
    stop.setOnClickListener(v -> stopService(new Intent(this, AgentService.class)));
    battery.setOnClickListener(v -> {
      PowerManager pm = getSystemService(PowerManager.class);
      if (!pm.isIgnoringBatteryOptimizations(getPackageName()))
        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
    });
    clear.setOnClickListener(v -> AgentService.logFile(this).delete());
    logView = new TextView(this);
    logView.setTextSize(11);
    logView.setTextIsSelectable(true);
    ScrollView sv = new ScrollView(this);
    sv.addView(logView);
    col.addView(start); col.addView(stop); col.addView(battery); col.addView(clear);
    col.addView(sv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
    setContentView(col);
    h.post(refresh);
  }

  final Runnable refresh = new Runnable() {
    @Override public void run() {
      try {
        File f = AgentService.logFile(MainActivity.this);
        List<String> lines = f.exists() ? Files.readAllLines(f.toPath()) : List.of();
        StringBuilder sb = new StringBuilder(AgentService.running ? "RUNNING\n\n" : "STOPPED\n\n");
        for (int i = lines.size() - 1; i >= Math.max(0, lines.size() - 80); i--) sb.append(lines.get(i)).append('\n');
        logView.setText(sb);
      } catch (Exception ignored) {}
      h.postDelayed(this, 2000);
    }
  };

  @Override protected void onDestroy() { h.removeCallbacksAndMessages(null); super.onDestroy(); }
}
