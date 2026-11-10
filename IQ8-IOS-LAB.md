From rns-IQ8 (react-native-speech lane, measurement only). Request: Kokoro int8 vs fp32 measurement on the iPhone 13 Pro. **Silent by design: nothing is played.** The harness nulls playback (NeuralAudioPlayer.play waits the buffer's duration and never calls native audio), so no speaker or AirPods output at any time; the PCM goes to WAV files instead. Please still keep the iPhone muted per your rules. Send results via agistry to `rns:pm` (the IQ8 lane has stopped). Claim/release the iPhone as you normally do.

## Build (example app, Release, onnxruntime-react-native 1.24.3 from the lock)
repo: https://github.com/a-ghorbani/react-native-speech
  git fetch origin && git checkout -B iq8 origin/test/iq8-kokoro-int8-harness   (= main e4a57b0 + harness + this file only)
  yarn install --immutable && cd example/ios && pod install   (example/ios/.xcode.env.local as for earlier builds)
  Confirm `grep -A1 '"onnxruntime-react-native@npm' yarn.lock` shows 1.24.3 and Podfile.lock has onnxruntime-c 1.24.3 (or whatever pod it resolves; report it).
  Build+install Release on the iPhone. Record model, iOS version, Xcode version.

## Runs (short plan; 14 processes; kill the app between each, so each starts fresh)
For each: force-quit the app, start console capture (Xcode console or `log stream`/idevicesyslog filtered on `IQ8`), open the URL, wait for `[IQ8EV] DONE`, save the console to the named file.
Execution providers are forced to CPU (`['cpu']`), as PocketPal ships; no CoreML. The first fp32 / int8 run downloads the model (326 MB / 92 MB) from a pinned Hugging Face commit into Documents/iq8 and checks the byte size; a size mismatch logs an ERROR.

A. Stability, 1 round, all 5 replies (2 processes; int8 ~6 min, fp32 ~10 min):
  fp32-r1.console.txt  speechexample://evidence/iq8?file=fp32&round=1&texts=r1,r2,r3,r4,r5&modes=speak,stream&wav=r1
  int8-r1.console.txt  speechexample://evidence/iq8?file=int8&round=1&texts=r1,r2,r3,r4,r5&modes=speak,stream&wav=r1
B. RTF/RAM, rounds 2-3 over r1+r2 (4 processes, in this order; round 1 = A):
  int8-r2, fp32-r2, fp32-r3, int8-r3:  speechexample://evidence/iq8?file=<file>&round=<2|3>&texts=r1,r2&modes=speak,stream&wav=r1
C. First audio after stop(), N=10 per case (8 processes, ~1-3 min each, 5 runs each, in this order):
  round 1: fp32 speak, fp32 stream, int8 speak, int8 stream; round 2: int8 speak, int8 stream, fp32 speak, fp32 stream
  stop-<file>-<a>-r<round>.console.txt  speechexample://evidence/iq8?file=<file>&round=<round>&modes=stopfa&a=<speak|stream>&b=stream&runs=5&delay=1200

Memory: while each run goes, note the peak memory of the process (Xcode Debug Navigator memory gauge if you run attached, or Instruments / `footprint`; say which). One number per process is enough.

## What I need back
1. The console text of each process with all `[IQ8EV]` and `[IQ8CHUNK]` lines, one file per process named as above (A/B: `<file>-r<round>.console.txt`, C: `stop-<file>-<a>-r<round>.console.txt`); C lines are `[IQ8EV] STOP_END ...`. These lines are the data; please do not trim them.
2. The WAVs from the app container: Documents/iq8/wav/*.wav (`xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier com.pocketpalai.rn.speech --source Documents/iq8/wav ...` or Xcode "Download Container").
3. If you can copy them too: `shasum -a 256` of Documents/iq8/fp32.onnx and int8.onnx (expected 8fbea51e…a34cb and fbae9257…1478).
4. Peak memory per process, device/iOS/Xcode, ORT pod version, and anything you could not run (which, and why).
Where to put files: whatever you used for earlier rns lanes (a zip path I can fetch, or a gist); tell me the location.

Pass/fail is not asked of you; I compute everything from the console lines. Rough expectation: no `[IQ8EV] ERROR`, every `[IQ8CHUNK]` has `nan=0 ... rejected=0`.
