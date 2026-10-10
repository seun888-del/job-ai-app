#!/usr/bin/env bash
# CI emulator: install the app, open it, connect to its dashboard over DevTools, run e2e.mjs.
set -u
PKG=com.tryjobai.app
export OUT=android-out; mkdir -p $OUT
adb logcat -c
adb logcat -s JobAI:V chromium:I AndroidRuntime:E > $OUT/logcat.txt 2>&1 &
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb shell settings put system screen_off_timeout 1800000
adb shell am start -n $PKG/.MainActivity
sleep 15
SOCK=""
for i in $(seq 1 30); do
  SOCK=$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1 | tr -d '\r')
  [ -n "$SOCK" ] && break; sleep 2
done
echo "devtools socket: $SOCK"
adb forward tcp:9222 localabstract:$SOCK
node android/test/e2e.mjs; CODE=$?
adb exec-out screencap -p > $OUT/99-final.png || true
exit $CODE
