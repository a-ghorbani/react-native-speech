#!/usr/bin/env bash
# Make a mutant of app-debug.apk whose libptts_ffi.so claims 4 KB LOAD alignment; re-sign with the debug key.
set -euo pipefail
bt="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
rm -rf mut && mkdir mut && cd mut
unzip -q ../app-debug.apk
unzip -v ../app-debug.apk | grep -E 'lib/x86_64/' 
python3 ../.i57/elf_align.py lib/x86_64/libptts_ffi.so 0x1000
rm -rf META-INF/*.SF META-INF/*.RSA META-INF/*.MF
# all stored: .so mmapped from the APK, resources.arsc must be uncompressed
zip -q -r -0 ../unsigned.apk .
cd ..
"$bt/zipalign" -f -P 16 4 unsigned.apk aligned.apk
"$bt/apksigner" sign --ks example/android/app/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out app-debug.apk aligned.apk
"$bt/apksigner" verify app-debug.apk && echo "mutant ready"
