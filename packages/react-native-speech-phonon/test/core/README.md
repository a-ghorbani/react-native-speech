# Phonon C++ core host tests

Host tests for the shared Phonon core in `cpp/` (`PhononApi`, `PhononCore`,
`PhononWorker`; see `docs/DESIGN.md` §1.4–1.5). They run against `fake_ptts.c`, a
stand-in for `libptts_ffi` that implements the 8 `ptts_*` symbols with upstream's documented
semantics and records every call.

This folder sits outside `cpp/` on purpose: neither the Android CMake build, the podspec
`cpp/**` glob nor the npm `files` list can pick it up.

## Run

From the repo root:

```sh
scripts/test-core.sh              # ASan + UBSan (default), all tests
scripts/test-core.sh cancel       # only tests whose name contains "cancel"
PHONON_SANITIZE=thread scripts/test-core.sh   # ThreadSanitizer instead
PHONON_SANITIZE=0 scripts/test-core.sh        # no sanitizers
```

Needs CMake ≥ 3.16 and clang or gcc (clang is preferred when found; set `CC`/`CXX` to
override). Works on Linux and macOS. The build goes to `test/core/build/` (git-ignored)
unless `PHONON_CORE_BUILD_DIR` is set. Exit code 0 means every test passed.

Binaries:

| Binary | Binding | Covers |
|---|---|---|
| `core_test` | `dlopen` + `dlsym` of `libfake_ptts.so` (Android path) | everything below |
| `static_api_test` | `fake_ptts.c` linked in, `RN_SPEECH_PHONON_STATIC_API=1` (iOS path) | static binding, Apple unit mapping, frame hook |

## Coverage

- `phonon_load_api`: all symbols → ok; `libfake_ptts_nosym.so` (no `ptts_set_language`) →
  `symbols-missing` with the name, library closed, no abort; missing file → `library-missing`.
- Handle lifecycle: create reports voices/languages/default voice; create frees the previous
  handle after `cancelAll()`; destroy; stale and destroyed handle ids → `PHONON_INVALID_HANDLE`.
- `ptts_new` errors read with `ptts_last_error(NULL)` on the creating thread (the fake keeps
  them thread-local like upstream; the test creates on a worker thread).
- Request ids: start at 1, unique and monotonic under concurrent allocation, survive a
  simulated RN reload (new "module", same `Core::get()`).
- Cancel watermark: cancel(current) then cancel(prefetch) stops both, in either order;
  concurrent `fetch_max`; un-issued ids are clamped (cannot poison later ids); `cancelAll`
  does not poison the next request; a queued request cancelled while another is in
  `ptts_speak` returns `cancelled:true` without reaching `ptts_speak`; cancel mid-utterance
  stops at the next frame; cancel after the last frame discards the audio; cancel before
  conditioning skips `set_voice` / `set_language`.
- Voice/language: applied only on change; `voice=''` skips `set_voice` on a fresh handle and
  switches back to upstream's default after an explicit voice; unknown voice/language map to
  `PHONON_VOICE_NOT_FOUND` / `PHONON_LANGUAGE_UNSUPPORTED` with upstream's message; a model
  without voices speaks unconditioned.
- Buffer store: copy is non-consuming, take consumes, release is idempotent; count cap and
  byte cap evict only orphaned buffers (request id ≤ watermark); `PHONON_BUFFER_LIMIT` when
  full of live buffers (refused before synthesizing for the count cap); `releaseOrphans`.
- Frame callback: a hook that throws (`std::exception`, `std::bad_alloc`, non-std) or a sink
  over the size limit stops generation with `PHONON_CALLBACK_FAILED`; the process survives
  and the next request works. The every-N-frames hook (iOS autorelease drain) fires N-wise.
- `float_to_pcm16`: gain, clamp, ±1 endpoints, truncation, NaN/±inf (matches
  `src/utils/AudioConverter.ts`).
- Compute-unit mapping: Android always `PTTS_UNIT_CPU` (also end to end into `ptts_new`);
  Apple `neuralEngine`/`''` → ANE, `cpu` → CPU.
- Error codes, diagnostics (`busy`, ids, watermark, live/orphan buffers).
- `PhononWorker`: FIFO order, per-job hook wraps every job, jobs run on the worker thread,
  8 MB stack and `phonon-synth` name, a throwing job or hook does not kill the thread,
  destructor drains then joins.
- A 200-request stress run with a concurrent canceller (clean under ASan/UBSan and TSan).

## Optional: real `libptts_ffi` on an aarch64 Linux host

The `real_lib` test loads a real library, creates a handle from a checkpoint folder,
synthesizes, cancels mid-utterance and checks the unknown-voice message. It is skipped unless
both variables are set. Build the library from the pinned tag with explicit CPU flags (never
`target-cpu=native`; rustc crashes with it on this host):

```sh
git clone https://github.com/gradium-ai/xn-ptts && cd xn-ptts
git checkout f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa          # v0.4.0
RUSTFLAGS="-C target-cpu=generic -C target-feature=+neon,+dotprod,+fp16" \
  cargo build --release -p ptts-ffi --locked

PHONON_REAL_LIB=$PWD/target/release/libptts_ffi.so \
PHONON_MODEL_DIR=/path/to/phonon-31m-en \
  scripts/test-core.sh real_lib
```
