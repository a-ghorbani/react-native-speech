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

| Engine | Upstream source | Code license | Model weights license | Notes |
|--------|-----------------|--------------|-----------------------|-------|
| Kokoro | https://huggingface.co/hexgrad/Kokoro-82M | Apache-2.0 | Apache-2.0 | Fully permissive, commercial use allowed. |
| Supertonic | https://huggingface.co/Supertone/supertonic (v1), https://huggingface.co/Supertone/supertonic-2 (v2) | MIT ([repo](https://github.com/supertone-inc/supertonic)) | [OpenRAIL](https://huggingface.co/blog/open_rail) | Reference code is MIT; the model weights are under an OpenRAIL-style responsible-AI license (use-based restrictions, no absolute commercial ban). Review the model card before shipping. |
| Kitten | https://huggingface.co/KittenML (upstream); example app uses `palshub/*` mirrors | Apache-2.0 | Apache-2.0 | Fully permissive, commercial use allowed. |

Example-app download URLs (`example/src/utils/SupertonicModelManager.ts`,
`example/src/utils/KittenModelManager.ts`) point at those upstream repos or
author-owned mirrors; the library itself bundles no weights.

Consumer apps are responsible for complying with each upstream model's
terms of use. MIT-licensed library code does not inherit the model's
license — comparable to VLC (GPL) playing CC-BY-NC video: the runtime
and the content are independently licensed.

## This library

MIT. See [LICENSE](../LICENSE).
