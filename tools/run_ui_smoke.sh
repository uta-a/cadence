#!/usr/bin/env bash
# Named-control tests only. Does not install APKs, dump account/chat UI, or take screenshots.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERIAL="${1:?Usage: tools/run_ui_smoke.sh SERIAL ACTION [true|false] [fakeNitro|platformIndicator|quickDelete|noConfirmPin]}"
ACTION="${2:?Missing action}"
EXPECTED="${3:-false}"
FEATURE="${4:-}"
case "$ACTION" in open-disk|toggle-compact|check-compact|check-saved|close-disk|show-logs|toggle-feature|check-feature) ;; *) echo 'Unsupported action' >&2; exit 2;; esac
case "$EXPECTED" in true|false) ;; *) exit 2;; esac
case "$FEATURE" in ""|fakeNitro|platformIndicator|quickDelete|noConfirmPin) ;; *) exit 2;; esac
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
JAVA="${JAVA_HOME:?Set JAVA_HOME to JDK21}"
OUT="$ROOT/work/phase3-ui-smoke"
mkdir -p "$OUT/classes" "$OUT/dex"
CP="$SDK/platforms/android-36/android.jar:$SDK/platforms/android-36/uiautomator.jar:$SDK/platforms/android-36/optional/android.test.base.jar"
"$JAVA/bin/javac" -source 8 -target 8 -classpath "$CP" -d "$OUT/classes" "$ROOT/tools/android/DiskUiSmoke.java" > "$OUT/compile.log" 2>&1
"$JAVA/bin/jar" cf "$OUT/classes.jar" -C "$OUT/classes" .
"$SDK/build-tools/36.0.0/d8" --lib "$SDK/platforms/android-36/android.jar" --min-api 28 --output "$OUT/dex" "$OUT/classes.jar" > "$OUT/d8.log" 2>&1
"$JAVA/bin/jar" cf "$OUT/disk-ui-smoke.jar" -C "$OUT/dex" classes.dex
adb -s "$SERIAL" push "$OUT/disk-ui-smoke.jar" /data/local/tmp/disk-ui-smoke.jar
EXTRA=()
[ -n "$FEATURE" ] && EXTRA=(-e feature "$FEATURE")
adb -s "$SERIAL" shell uiautomator runtest /system/framework/android.test.runner.jar /system/framework/android.test.base.jar /data/local/tmp/disk-ui-smoke.jar \
  -c app.disk.test.DiskUiSmoke -e action "$ACTION" -e expected "$EXPECTED" ${EXTRA[@]+"${EXTRA[@]}"} | tee "$OUT/$ACTION.log"
grep -q '^OK (1 test)' "$OUT/$ACTION.log"
! grep -Eq 'shortMsg=|FAILURES|Failure in|aborted due' "$OUT/$ACTION.log"
