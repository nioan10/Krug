#!/usr/bin/env bash
set -euo pipefail
sudo python3 android/test-dns-proxy.py > android-artifact/dns.log 2>&1 &
dns_pid=$!
trap 'sudo kill "$dns_pid" 2>/dev/null || true' EXIT
sleep 2
adb install -r android-artifact/app-debug.apk
adb logcat -c
adb shell am start -W -n website.nioservices.krug/.MainActivity
sleep 12
adb shell pidof website.nioservices.krug >/dev/null
adb shell dumpsys activity activities | grep -q 'website.nioservices.krug/.MainActivity'
adb shell screencap -p /sdcard/okrug-test.png
adb pull /sdcard/okrug-test.png android-artifact/emulator.png
adb logcat -d -s Okrug:W AndroidRuntime:E > android-artifact/emulator.log
adb shell getprop net.dns1 >> android-artifact/emulator.log || true
adb shell pm grant website.nioservices.krug android.permission.RECORD_AUDIO
adb shell run-as website.nioservices.krug am start-foreground-service --user 0 -n website.nioservices.krug/.CallService --ez microphone true
sleep 3
adb shell dumpsys activity services website.nioservices.krug | grep -q 'isForeground=true'
adb shell input keyevent KEYCODE_HOME
sleep 2
adb shell dumpsys activity services website.nioservices.krug | grep -q 'isForeground=true'
adb shell run-as website.nioservices.krug am stopservice --user 0 -n website.nioservices.krug/.CallService || true
if grep -q 'Main page load failed' android-artifact/emulator.log; then
  cat android-artifact/emulator.log
  echo '::warning::Emulator could not reach the real server; verify network connectivity on a device.'
fi
if adb logcat -d -s AndroidRuntime:E | grep -q 'FATAL EXCEPTION'; then
  adb logcat -d -s AndroidRuntime:E
  exit 1
fi
echo 'Android application installed and started on an isolated emulator.'
