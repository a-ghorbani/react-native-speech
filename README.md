# @pocketpalai/react-native-speech

On-device, multi-engine text-to-speech for React Native. Wraps the OS-native TTS (iOS `AVSpeechSynthesizer` / Android `TextToSpeech`) and three neural engines — Kokoro, Supertonic, Kitten — behind a single API, with native audio playback, progress events, and audio-focus handling.

<div align="center">
  <a href="./docs/USAGE.md">Usage</a> · <a href="./docs/ARCHITECTURE.md">Architecture</a> · <a href="./docs/LICENSES.md">Licenses</a> · <a href="./docs/PHONEMIZATION.md">Phonemization</a> · <a href="./MIGRATION.md">Migration</a> · <a href="./example/">Example</a>
</div>
<br/>

> **New Architecture only.** Requires React Native's New Architecture. RN 0.76+ enables it by default. For 0.68–0.75 see the [enable-apps guide](https://github.com/reactwg/react-native-new-architecture/blob/main/docs/enable-apps.md).

## Preview

| <center>Kokoro · iOS</center> | <center>Kitten · Android</center> |
| :---: | :---: |
| <video src="https://github.com/user-attachments/assets/1d055e24-8c44-41a8-a607-2ff239397684" controls width="100%" height="500"></video> | <video src="https://github.com/user-attachments/assets/02395df1-fbe8-411f-a44e-35c95ce09e9e" controls width="100%" height="500"></video> |

## Features

- **Four engines behind one API**: `OS_NATIVE` (platform TTS), `KOKORO` (high quality, multi-language), `SUPERTONIC` (fast, lightweight), `KITTEN` (compact IPA-driven).
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

The neural engines need `onnxruntime-react-native` (optional peer):

```sh
npm install onnxruntime-react-native
```

OS-native TTS works without it.

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

Per-sentence `speak()` chains produce audible gaps: each call resets the engine's internal synth pipeline, starting a fresh F0 contour and a cold first-chunk inference. Feeding the same text through a stream lets the engine keep one call containing many sentences, so its internal chunker and pipelined synth do their normal job.

Works with all neural engines (Kokoro, Supertonic, Kitten) as well as the OS engine. See the `Streaming` tab in [`example/`](./example/) for a live demo that simulates variable token rates.

## Architecture (short)

1. `Speech` is the public facade. `Speech.initialize(config)` dispatches on `config.engine` and constructs the matching engine.
2. Each engine implements `TTSEngineInterface<TConfig>`. Neural engines run ONNX sessions under `onnxruntime-react-native` and stream PCM to the native audio player.
3. Native code handles playback, progress events, and OS-level audio focus / session interruptions.

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full picture, including memory and device requirements.

## Model & dictionary downloads

The library ships no model or dictionary assets. Consumer apps fetch them from their own origin (typically Hugging Face) and pass local paths into `initialize()`. See [LICENSES.md](./docs/LICENSES.md) for upstream sources and license notes per engine.

## Known limitations

- First run per engine has a 200–2000 ms cold-start (model load + compilation).
- Neural engines recommend a 3 GB+ RAM device. Low-memory devices should prefer the Kitten nano/micro variants or fall back to `OS_NATIVE`.
- OS TTS interruption handling is limited to what the platform provides — no library-level custom ducking beyond what iOS/Android expose.
- Hermes is supported, but has no `TextDecoder` or WASM — relevant only if you extend the library's text pipeline.

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
- [`onnxruntime-react-native`](https://github.com/microsoft/onnxruntime) — Microsoft's ONNX Runtime bindings for RN, which every neural engine uses for inference.
- [`@dr.pogodin/react-native-fs`](https://github.com/birdofpreyru/react-native-fs) — file I/O for model and dict loading.

Neural model credits (weights are not bundled):

- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0).
- [Supertonic](https://github.com/supertone-inc/supertonic) by [Supertone](https://supertone.ai) (code MIT, weights OpenRAIL).
- [KittenML kitten-tts](https://huggingface.co/KittenML) (Apache-2.0).

Full license details in [LICENSES.md](./docs/LICENSES.md).

## License

MIT. See [LICENSE](./LICENSE). For model and third-party data licenses, see [LICENSES.md](./docs/LICENSES.md).
