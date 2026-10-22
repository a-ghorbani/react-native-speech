# @pocketpalai/react-native-speech

On-device, multi-engine text-to-speech for React Native. Wraps the OS-native TTS (iOS `AVSpeechSynthesizer` / Android `TextToSpeech`) and three ONNX neural engines — Kokoro, Supertonic, Kitten — behind a single API, with native audio playback, progress events, and audio-focus handling. Gradium's Phonon engine is available as a separate add-on package.

<div align="center">
  <a href="./docs/USAGE.md">Usage</a> · <a href="./docs/ARCHITECTURE.md">Architecture</a> · <a href="./docs/LICENSES.md">Licenses</a> · <a href="./docs/PHONEMIZATION.md">Phonemization</a> · <a href="./packages/react-native-speech-phonon/README.md">Phonon</a> · <a href="./MIGRATION.md">Migration</a> · <a href="./example/">Example</a>
</div>
<br/>

> **New Architecture only.** Requires React Native's New Architecture. RN 0.76+ enables it by default. For 0.68–0.75 see the [enable-apps guide](https://github.com/reactwg/react-native-new-architecture/blob/main/docs/enable-apps.md).

## Preview

### Streaming (LLM token stream → TTS)

| <center>iOS</center> | <center>Android</center> |
| :---: | :---: |
| <video src="https://github.com/user-attachments/assets/c3f6b6e5-a778-4d19-bed5-d2c79843eba1" controls width="100%" height="500"></video> | <video src="https://github.com/user-attachments/assets/218196c8-6a2c-49c4-a918-a37f71b5fcb3" controls width="100%" height="500"></video> |

### One-shot speak

| <center>iOS</center> | <center>Android</center> |
| :---: | :---: |
| <video src="https://github.com/user-attachments/assets/648120eb-0e96-4b59-94f8-64012824942d" controls width="100%" height="500"></video> | <video src="https://github.com/user-attachments/assets/da0ccc52-042d-4444-b355-e478f3c8af33" controls width="100%" height="500"></video> |

## Features

- **Four engines behind one API**: `OS_NATIVE` (platform TTS), `KOKORO` (high quality; English text, other languages via phoneme input), `SUPERTONIC` (fast, lightweight), `KITTEN` (compact IPA-driven).
- **Engine add-ons**: engines from other packages plug into the same API with `Speech.registerEngine`. [`@pocketpalai/react-native-speech-phonon`](./packages/react-native-speech-phonon/README.md) adds Gradium's native Phonon engine (CPU on Android, Core ML on iOS 18+); apps that do not install it carry no Phonon code.
- **License-neutral runner**: the library is MIT and ships no model or dictionary data. Consumer apps supply both at runtime. See [LICENSES.md](./docs/LICENSES.md).
- **On-device synthesis**: neural TTS runs entirely on-device. The library performs no network I/O during synthesis. Any initial model or dictionary download is performed by the consumer app using its own network stack.
- **Interruption-aware audio**: iOS `AVAudioSession` and Android `AudioFocus` are wired through a JS `onAudioInterruption` event so apps can react to phone calls and other interruptions.
- **Turbo-module native layer**: native audio playback, progress events, and chunk progress for neural engines.
- **Permissive phonemization**: default is [`phonemize`](https://github.com/hans00/phonemize) (MIT). Optionally supply a mmap'd EPD1 dict via the `NativeDict` API for higher accuracy — see [PHONEMIZATION.md](./docs/PHONEMIZATION.md).
- **[`HighlightedText`](./docs/USAGE.md#highlightedtext) component**: highlight spoken text as it synthesizes.
- **TypeScript**: full type definitions; per-engine config is a discriminated union on the `engine` field.

## Installation

```sh
npm install @pocketpalai/react-native-speech
# or
yarn add @pocketpalai/react-native-speech
```

iOS:

```sh
cd ios && pod install
```

Expo (bare only — not supported in Expo Go):

```sh
npx expo install @pocketpalai/react-native-speech
npx expo prebuild
```

### Neural engines (optional)

Kokoro, Supertonic and Kitten need `onnxruntime-react-native` (optional peer):

```sh
npm install onnxruntime-react-native
```

OS-native TTS and the Phonon add-on work without it.

## Quickstart

```ts
import Speech, {TTSEngine} from '@pocketpalai/react-native-speech';

await Speech.initialize({engine: TTSEngine.OS_NATIVE});
// voiceId is optional for OS_NATIVE — omitted uses the platform default voice.
await Speech.speak('Hello world');
```

## Neural engine quickstarts

The consumer app is responsible for downloading models and passing file paths. See [`example/src/utils/`](./example/src/utils/) for reference model managers.

```ts
// Kokoro
await Speech.initialize({
  engine: TTSEngine.KOKORO,
  modelPath: 'file:///.../kokoro.onnx',
  voicesPath: 'file:///.../voices.bin',
  tokenizerPath: 'file:///.../tokenizer.json',
});
await Speech.speak('Hello from Kokoro.', 'af_bella');

// Supertonic (4 ONNX files)
await Speech.initialize({
  engine: TTSEngine.SUPERTONIC,
  durationPredictorPath: 'file:///.../duration_predictor.onnx',
  textEncoderPath: 'file:///.../text_encoder.onnx',
  vectorEstimatorPath: 'file:///.../vector_estimator.onnx',
  vocoderPath: 'file:///.../vocoder.onnx',
  unicodeIndexerPath: 'file:///.../unicode_indexer.json',
  voicesPath: 'file:///.../voices/',
});
await Speech.speak('Hello from Supertonic.', 'F1');

// Supertonic is multilingual on the v3 model (Supertone/supertonic-3):
// 31 languages plus 'na' for language-agnostic synthesis. Pass a code via
// `language` (v1 = en only; v2 = en/ko/es/pt/fr; v3 = all 31 + na). Voices
// are language-agnostic — any voice works with any language.
await Speech.speak('Bonjour le monde.', 'F1', {language: 'fr'});
await Speech.speak('Mixed-language text, just works.', 'M2', {language: 'na'});

// Kitten
await Speech.initialize({
  engine: TTSEngine.KITTEN,
  modelPath: 'file:///.../kitten.onnx',
  voicesPath: 'file:///.../voices.json',
  dictPath: 'file:///.../en-us.bin', // optional EPD1 dict
});
await Speech.speak('Hello from Kitten.', 'expr-voice-2-f');
```

Full options (execution providers, chunking, phonemizer selection) are documented in [USAGE.md](./docs/USAGE.md).

## Phonon add-on

[`@pocketpalai/react-native-speech-phonon`](./packages/react-native-speech-phonon/README.md) runs Gradium's Phonon natively: a Rust library on the CPU on Android, Core ML on iOS. Each add-on release pins the core minors it was tested against (currently `>=2.7.0 <2.9.0`). Register the engine once, before the first `initialize` that uses it:

```sh
yarn add @pocketpalai/react-native-speech-phonon
```

```ts
import Speech from '@pocketpalai/react-native-speech';
import {PhononEngine, PHONON} from '@pocketpalai/react-native-speech-phonon';

Speech.registerEngine(new PhononEngine());

if ((await Speech.getEngineSupport(PHONON)).supported) {
  await Speech.initialize({
    engine: PHONON,
    modelPath: '/.../phonon/31m-en', // Android: checkpoint folder; iOS: Core ML bundle folder
  });
  await Speech.speak('Hello from Phonon.'); // no voice id: the model's default voice
}
```

Phonon needs 3 GiB+ of RAM and, on Android, a 64-bit CPU with dotprod and fp16 (roughly Snapdragon 855, Tensor, Dimensity 1000 and newer); on iOS it needs iOS 18. Elsewhere `getEngineSupport` reports the reason and `initialize` rejects. Phonon 31m speaks English only, and Phonon has no speed or pitch control and no phoneme input. Measured on a Pixel 9, Galaxy S23, Snapdragon 8 Elite Gen 5 and Dimensity MT6899: RTF 0.08–0.17 and first audio in ~240–540 ms; on an iPhone 13 Pro, RTF 0.08 and first audio in ~285 ms.

Model download, voices, supported devices and the native binaries are covered in the [add-on README](./packages/react-native-speech-phonon/README.md).

## Streaming input (LLM token streams)

If your app plays a token-by-token LLM response through TTS, use `createSpeechStream()` instead of calling `speak()` per sentence. It buffers incoming text and adaptively flushes batches through the underlying engine so playback sounds continuous — the first sentence flushes as soon as it completes (low latency) and subsequent batches are packed up to `targetChars` characters.

```ts
const stream = Speech.createSpeechStream('af_bella', {
  targetChars: 300, // default
  onError: err => console.warn(err),
});

for await (const token of llmTokenStream) {
  stream.append(token); // non-blocking
}

await stream.finalize(); // flushes the tail and resolves when playback ends
// or: await stream.cancel(); // stops and discards
```

Per-sentence `speak()` chains produce audible gaps: each call resets the engine's internal synth pipeline, starting a fresh F0 contour and a cold first-chunk inference. The stream avoids this by keeping one continuous synth+play loop alive for the stream's entire lifetime — the next chunk is synthesized while the current one plays, so the only gap is genuine token-rate underrun (LLM slower than playback).

On neural engines you can also track playback position with stream-absolute offsets:

```ts
stream.onProgress(event => {
  // event.streamRange is relative to the total text appended so far
  highlightText(event.streamRange.start, event.streamRange.end);
});
```

The OS engine does not emit chunk progress, so `stream.onProgress` never fires there.

For even lower time-to-first-audio on neural engines, pass `firstChunk: 'clause'`: the first chunk may then end at a clause boundary (`, ; : — –` after at least 3 words, or `，；：、` after at least 4 CJK characters), or after 12 words, instead of waiting for the end of the sentence. Later chunks still break at sentence boundaries. The default is `'sentence'`. The OS engine ignores this option.

```ts
const stream = Speech.createSpeechStream('af_bella', {firstChunk: 'clause'});
```

If you need `streamRange` to index into your own text exactly, strip markdown yourself with the exported `createMarkdownStreamBuffer()` and pass `stripMarkdown: false`:

```ts
import {createMarkdownStreamBuffer} from '@pocketpalai/react-native-speech';

const md = createMarkdownStreamBuffer({firstChunk: 'clause'});
const stream = Speech.createSpeechStream('af_bella', {
  stripMarkdown: false,
  firstChunk: 'clause',
});
let spoken = ''; // what streamRange offsets index into
for await (const token of llmTokenStream) {
  const clean = md.push(token);
  spoken += clean;
  stream.append(clean);
}
const tail = md.flush();
spoken += tail;
stream.append(tail);
await stream.finalize();
```

Streaming playback works with every neural engine (Kokoro, Supertonic, Kitten, Phonon) as well as the OS engine; progress events and `firstChunk` are neural-only. See the `Streaming` tab in [`example/`](./example/) for a live demo that simulates variable token rates.

## Architecture (short)

1. `Speech` is the public facade. `Speech.initialize(config)` dispatches on `config.engine` to a built-in engine or one registered with `Speech.registerEngine`.
2. Each engine implements `TTSEngineInterface<TConfig>`. Kokoro, Supertonic and Kitten run ONNX sessions under `onnxruntime-react-native`; add-on engines such as Phonon bring their own native module. All neural engines stream PCM to the same native audio player.
3. Native code handles playback, progress events, and OS-level audio focus / session interruptions.

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full picture, including memory and device requirements.

## Model & dictionary downloads

The library ships no model or dictionary assets. Consumer apps fetch them from their own origin (typically Hugging Face) and pass local paths into `initialize()`. Model licenses differ: Phonon 31m is Apache-2.0, but the Phonon 40m models are CC BY-NC 4.0 and must not ship in a commercial app. See [LICENSES.md](./docs/LICENSES.md) for upstream sources and license notes per engine.

## Known limitations

- First run per engine has a 200–2000 ms cold-start (model load + compilation).
- Neural engines recommend a 3 GB+ RAM device (Phonon refuses to initialize below 3 GiB). Low-memory devices should prefer the Kitten nano/micro variants or fall back to `OS_NATIVE`.
- OS TTS interruption handling is limited to what the platform provides — no library-level custom ducking beyond what iOS/Android expose.
- Hermes is supported, but has no `TextDecoder` or WASM — relevant only if you extend the library's text pipeline.
- **Android 16 KB page sizes (Android 15+):** the library's own `native_dict.so` is 16 KB-aligned, but `onnxruntime-react-native` (≤ 1.24.3 at time of writing) is not — apps that load an ONNX engine on a 16 KB-page device will fail with `dlopen` errors. Workaround: a one-line linker flag added to its `CMakeLists.txt` via `patch-package`. See [`example/patches/onnxruntime-react-native+1.24.3.patch`](./example/patches/onnxruntime-react-native+1.24.3.patch) and the `postinstall` wiring in [`example/package.json`](./example/package.json) for the full setup. Drop the patch once upstream ships the fix. The Phonon add-on's libraries are 16 KB-aligned, given AGP ≥ 8.5.1.

## Testing

Mock the module in tests by creating `__mocks__/@pocketpalai/react-native-speech.ts`:

```js
module.exports = require('@pocketpalai/react-native-speech/jest');
```

## Contributing

See [CONTRIBUTING.md](./docs/CONTRIBUTING.md).

## Credits

Forked from [`@mhpdev/react-native-speech`](https://github.com/mhpdev-com/react-native-speech) by [Mhpdev](https://github.com/mhpdev-com). The 1.x line provided the OS-native TTS foundation and the `HighlightedText` component; 2.0 extended the library into a multi-engine neural platform under a new package name.

Built on top of:

- [`phonemize`](https://github.com/hans00/phonemize) by [hans00](https://github.com/hans00) — the MIT G2P library that powers the default phonemizer.
- [`onnxruntime-react-native`](https://github.com/microsoft/onnxruntime) — Microsoft's ONNX Runtime bindings for RN, which the Kokoro, Supertonic and Kitten engines use for inference.
- [`@dr.pogodin/react-native-fs`](https://github.com/birdofpreyru/react-native-fs) — file I/O for model and dict loading.

Neural model credits (weights are not bundled):

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0).
- [Supertonic](https://github.com/supertone-inc/supertonic) by [Supertone](https://supertone.ai) (code MIT, weights OpenRAIL).
- [KittenML kitten-tts](https://huggingface.co/KittenML) (Apache-2.0).
- [Phonon](https://github.com/gradium-ai/xn-ptts) by [Gradium](https://huggingface.co/gradium), used by the Phonon add-on: runtime MIT OR Apache-2.0; Phonon 31m weights Apache-2.0, Phonon 40m weights CC BY-NC 4.0 (non-commercial).

Full license details in [LICENSES.md](./docs/LICENSES.md).

## License

MIT. See [LICENSE](./LICENSE). For model and third-party data licenses, see [LICENSES.md](./docs/LICENSES.md).
