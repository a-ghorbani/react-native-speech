#!/usr/bin/env bash
set -uo pipefail
mkdir -p probe
adb install -r -t app-debug.apk > probe/install.txt 2>&1
adb shell am start -W -n speech.example/.MainActivity > probe/start.txt 2>&1 || true
sleep 15
adb shell dumpsys package speech.example > probe/dumpsys-package.txt 2>&1
adb shell dumpsys activity processes speech.example > probe/dumpsys-processes.txt 2>&1
adb shell pm dump speech.example 2>&1 | grep -iE "page|compat|align" > probe/pm-grep.txt || true
adb shell cmd package help 2>&1 | grep -iE -B1 -A3 "page" > probe/cmd-package-help.txt || true
adb logcat -d -b all -v threadtime > probe/logcat-all.txt
grep -iE "page.?size|compat" probe/dumpsys-package.txt probe/dumpsys-processes.txt | head -40
