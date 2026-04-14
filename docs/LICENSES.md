# Third-Party Licenses

## Runtime dependencies

| Package | License | Role |
|---------|---------|------|
| [`phonemize`](https://github.com/hans00/phonemize) (hans00) | MIT | Default G2P phonemizer (hans00 fork) |
| [`onnxruntime-react-native`](https://github.com/microsoft/onnxruntime) | MIT | Neural inference (optional peer) |
| [`@dr.pogodin/react-native-fs`](https://github.com/birdofpreyru/react-native-fs) | MIT | File I/O (peer) |

## Library data

This library ships **no dictionary or model data**. Consumer apps supply
these at runtime:

- **Phonemization dictionary (optional):** apps may load any EPD1-format
  mmap dict via the `NativeDict` API. The library default phonemizer is
  `phonemize` (MIT, hans00 G2P) which requires no dict. See
  [PHONEMIZATION.md](PHONEMIZATION.md) for building and attributing a dict.

## Neural TTS model licenses

Models are NOT bundled. Each engine loads models from paths provided by
the consumer app. Upstream model licenses differ — review before
integrating:

| Engine | Upstream source | License | Commercial use |
|--------|-----------------|---------|----------------|
| Kokoro | https://huggingface.co/hexgrad/Kokoro-82M | Apache-2.0 | Yes |
| Supertonic (v1) | https://huggingface.co/Supertone/supertonic | verify at upstream repo | verify |
| Supertonic (v2) | https://huggingface.co/Supertone/supertonic-2 | verify at upstream repo | verify |
| Kitten (micro / nano / mini) | https://huggingface.co/palshub/kitten-tts-micro-0.8, .../kitten-tts-nano-0.8-int8, .../kitten-tts-nano-0.8-fp32, .../kitten-tts-mini-0.8 | verify at upstream repo | verify |

Sources: Supertonic and Kitten upstream URLs taken from
`example/src/utils/SupertonicModelManager.ts` and
`example/src/utils/KittenModelManager.ts` respectively (the `repo` fields
under `MODEL_VARIANTS`). The Kitten variants mirror the upstream
`KittenML/kitten-tts` family; the `palshub/*` repos are the redistribution
used by the example app.

Consumer apps are responsible for complying with each upstream model's
terms of use. MIT-licensed library code does not inherit the model's
license — comparable to VLC (GPL) playing CC-BY-NC video: the runtime
and the content are independently licensed.

## This library

MIT. See [LICENSE](../LICENSE).
