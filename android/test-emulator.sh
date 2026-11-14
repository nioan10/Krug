#!/usr/bin/env bash
set -euo pipefail
adb install -r android-artifact/app-debug.apk
adb logcat -c
adb shell am start -W -n website.nioservices.krug/.MainActivity
sleep 12
adb shell pidof website.nioservices.krug >/dev/null
adb shell dumpsys activity activities | grep -q 'website.nioservices.krug/.MainActivity'
adb shell screencap -p /sdcard/okrug-test.png
adb pull /sdcard/okrug-test.png android-artifact/emulator.png
if adb logcat -d -s AndroidRuntime:E | grep -q 'FATAL EXCEPTION'; then
  adb logcat -d -s AndroidRuntime:E
  exit 1
fi
echo 'Android application installed and started on an isolated emulator.'
