#!/usr/bin/env bash
# Runs on the CI emulator. Timeline (~45 min):
#   0-3 min   screen on, charging            (baseline)
#   3-23 min  screen OFF, battery, deep Doze (app NOT exempt from battery saving)
#  23-43 min  screen OFF, battery, deep Doze (app exempt, as after "Allow running in background")
set -u
PKG=com.tryjobai.spike
OUT=spike-out; mkdir -p $OUT
note() { echo "$(date +%H:%M:%S) [CI] $*" | tee -a $OUT/timeline.txt; }
state() {
  note "deep=$(adb shell dumpsys deviceidle get deep | tr -d '\r') light=$(adb shell dumpsys deviceidle get light | tr -d '\r') pid=$(adb shell pidof $PKG | tr -d '\r') screen=$(adb shell dumpsys power | grep -o 'mWakefulness=[A-Za-z]*' | head -1)"
}
watch_for() { local mins=$1; for _ in $(seq 1 "$mins"); do sleep 60; state; done; }

adb logcat -c
adb logcat -s JobAISpike:I ActivityManager:W > $OUT/logcat.txt 2>&1 &
adb install -r android-spike/app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb shell am start -n $PKG/.MainActivity
sleep 5
adb shell am start-foreground-service -n $PKG/.AgentService
note "PHASE 1: screen on, charging"
watch_for 3

note "PHASE 2: screen OFF, battery, deep Doze, NOT exempt"
adb shell dumpsys battery unplug
adb shell input keyevent 223
sleep 5
adb shell dumpsys deviceidle enable
adb shell dumpsys deviceidle force-idle
watch_for 20

note "PHASE 3: screen OFF, battery, deep Doze, EXEMPT"
adb shell dumpsys deviceidle whitelist +$PKG
adb shell dumpsys deviceidle force-idle
watch_for 20

note "END"
adb shell run-as $PKG cat files/spike.log > $OUT/spike.log || true
adb shell dumpsys battery reset
