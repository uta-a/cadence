#!/usr/bin/env bash
# Local development APK builder. Never installs/uninstalls apps; private keys and APKs stay under ignored work/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
MODE="${1:?Usage: DISK_KEYSTORE_PASSWORD=... bash tools/build_test_apk.sh normal|smoke}"
case "$MODE" in normal) SMOKE=0;; smoke) SMOKE=1;; *) exit 2;; esac
: "${DISK_KEYSTORE_PASSWORD:?Set the local development keystore password}"
: "${JAVA_HOME:?Set JAVA_HOME to JDK21}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
OUT="work/install-35217/phase3-$MODE"; mkdir -p "$OUT"
test -f work/install-35217/disk-local-test.jks
test -f work/install-35217/discord-352.17-source.apkm
export GITHUB_ACTOR="${GITHUB_ACTOR:-uta-a}"
export GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token)}"
export CADENCE_UI_SMOKE="$SMOKE"
if ! ./gradlew :patches:test :patches:generatePatchesList :patches:buildAndroid --no-daemon -q > "$OUT/build.log" 2>&1; then tail -35 "$OUT/build.log"; exit 1; fi
MPP=(patches/build/libs/patches-*[0-9].mpp)
test "${#MPP[@]}" -eq 1
# Enable exactly what Morphe Manager selects by default, so new patches are never silently left out of test builds.
ENABLE=()
while IFS= read -r name; do ENABLE+=("--enable=$name"); done < <(python3 -I -c 'import json,sys
for p in json.load(open(sys.argv[1]))["patches"]:
    if p.get("default"): print(p["name"])' patches-list.json)
test "${#ENABLE[@]}" -gt 0
"$JAVA_HOME/bin/java" -Xmx4g -jar work/tools/morphe-desktop-2.1.1-all.jar patch work/install-35217/discord-352.17-source.apkm \
  --patches="${MPP[0]}" --exclusive "${ENABLE[@]}" --bytecode-mode=FULL --unsigned --out="$OUT/unsigned.apk" --result-file="$OUT/patch-result.json" > "$OUT/patch.log" 2>&1
python3 -I -c 'import json,sys
r=json.load(open(sys.argv[1])); want=set(sys.argv[2:])
if not r.get("success") or r.get("failedPatches") or set(r.get("appliedPatches", [])) != want: sys.exit("patch result mismatch")' \
  "$OUT/patch-result.json" "${ENABLE[@]#--enable=}"
"$SDK/build-tools/36.0.0/zipalign" -P 16 -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
"$SDK/build-tools/36.0.0/apksigner" sign --ks work/install-35217/disk-local-test.jks --ks-key-alias disk-local-test \
  --ks-pass env:DISK_KEYSTORE_PASSWORD --key-pass env:DISK_KEYSTORE_PASSWORD --out "$OUT/signed.apk" "$OUT/aligned.apk"
"$SDK/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$OUT/signed.apk" > "$OUT/signature-verification.txt"
"$SDK/build-tools/36.0.0/zipalign" -c -P 16 4 "$OUT/signed.apk"
grep -E '^ℹ|^Cadence runtime' "$OUT/build.log" | tail -10
shasum -a 256 "$OUT/signed.apk"
