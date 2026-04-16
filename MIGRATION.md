# Migration Guide

## 1.x → 2.0

Version 2.0 turns the single-engine OS-native TTS library into a multi-engine runner. The OS-native API is preserved; the neural engines are additive.

### Package rename

`@mhpdev/react-native-speech` → `@pocketpalai/react-native-speech`.

```sh
# package.json imports
sed -i '' 's|@mhpdev/react-native-speech|@pocketpalai/react-native-speech|g' \
  $(grep -rl '@mhpdev/react-native-speech' src/)
```

Also update `__mocks__/@mhpdev/react-native-speech.ts` if you had one.

### Android native package rename

`com.mhpdev.speech` → `com.pocketpalai.speech`.

Consumer code only has to change if you have native extensions referencing the old package. The codegen module name is unchanged.

### Entry point policy

The default `Speech` export remains the main API. Per-engine classes (`KokoroEngine`, `SupertonicEngine`, `KittenEngine`, `OSEngine`) are tagged `@internal` — do not deep-import them. Use `Speech.initialize({engine: TTSEngine.KOKORO, ...})` instead.

### `TTSEngineInterface` is now generic

Subclasses of an engine must parameterize on their config type:

```ts
// before
class MyEngine implements TTSEngineInterface {}

// after
class MyEngine implements TTSEngineInterface<MyConfig> {}
```

### `initialize` is typed

```ts
// before
Speech.initialize(config?: any)

// after
Speech.initialize(config: SpeechInitConfig)
```

`SpeechInitConfig` is a discriminated union on `engine: TTSEngine.OS_NATIVE | KOKORO | SUPERTONIC | KITTEN`.

### Pocket engine removed

The Pocket engine was experimental and is gone in 2.0. Remove `engine: 'pocket'` paths from your app. Use `KITTEN` or `SUPERTONIC` for a similarly small footprint.

### New `onAudioInterruption` event (opt-in)

A new JS event fires when iOS `AVAudioSession` or Android `AudioFocus` reports an interruption (phone call, other media, etc). Subscribe via the event emitter; no change needed if you don't care.

### File renames (only matters for deep imports)

- `src/NeuralAudioPlayer.ts` → `src/NativeAudioPlayer.ts`.
- `src/types/react-native-fs.d.ts` removed. If you imported those types, import from `@dr.pogodin/react-native-fs` directly.

### Version

2.0.0. See `CHANGELOG.md` for the full list. New peer dependencies:

- `@dr.pogodin/react-native-fs` (required peer)
- `onnxruntime-react-native` (optional peer; required only for neural engines)
- `phonemize` (runtime dep, transitive — no action required)

## Per-sentence speak → `createSpeechStream`

If your app plays an LLM token stream through TTS, you've probably
accumulated a client-side queue that buffers tokens, detects sentence
endings, calls `Speech.speak()` per sentence, and chains on `onFinish`.
That pattern produces choppy audio — each call resets the engine's
synth pipeline, so sentence boundaries turn into audible pauses.

Replace the whole queue with a stream. The library now owns the
batching policy and routes each batch through the engine's internal
chunker + pipelined synth so sentences share prosody naturally.

```ts
// Before — per-sentence queue (abridged)
const SENTENCE_END = /^[\s\S]*?[.!?](?=\s|$)/;
let buffer = '';
let playing = false;
const queue: string[] = [];

async function playNext() {
  if (playing || queue.length === 0) return;
  playing = true;
  try {
    await Speech.speak(queue.shift()!, voiceId);
  } finally {
    playing = false;
    playNext();
  }
}

function onToken(chunk: string) {
  buffer += chunk;
  let match;
  while ((match = buffer.match(SENTENCE_END))) {
    queue.push(match[0].trim());
    buffer = buffer.slice(match[0].length);
    playNext();
  }
}

async function onDone() {
  if (buffer.trim()) queue.push(buffer.trim());
  buffer = '';
  playNext();
}
```

```ts
// After — let the library batch for you
const stream = Speech.createSpeechStream(voiceId);

function onToken(chunk: string) {
  stream.append(chunk); // non-blocking; batches adaptively
}

async function onDone() {
  await stream.finalize(); // flushes tail, waits for playback
}

// Interrupted mid-stream?
await stream.cancel();
```

`targetChars` (default `300`) tunes how much text subsequent batches
are allowed to accumulate before flushing. Higher values produce more
natural prosody across sentence boundaries at the cost of a larger
gap before each batch starts. The first batch always flushes on the
first complete sentence, regardless of this value.
