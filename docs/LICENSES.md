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
| Phonon 31m (add-on) | https://huggingface.co/gradium/phonon-31m-en (Android checkpoint); iOS Core ML bundle precompiled by this repo's CI and mirrored at `palshub/phonon-31m-en-coreml` | MIT OR Apache-2.0 ([xn-ptts](https://github.com/gradium-ai/xn-ptts)) | Apache-2.0 | Permissive, commercial use allowed. The mirror keeps Gradium's attribution. |
| Phonon voices (add-on) | https://huggingface.co/gradium/phonon-voices | — | Apache-2.0 | Voice embeddings used by every Phonon model. Check the repo's model card. |
| Phonon 40m (add-on) | https://huggingface.co/gradium/phonon-40m-en (also `-fr`, `-de`, `-es`, `-pt`, `-multilingual`), gated | MIT OR Apache-2.0 | **CC BY-NC 4.0** | **Non-commercial only.** Not for commercial apps. The example app never downloads it and never defaults to it. |

> **Phonon 40m is CC BY-NC 4.0.** Shipping it, or downloading it for users, in a commercial
> app is not allowed by its license. Use Phonon 31m (Apache-2.0) instead.

Example-app download URLs (`example/src/utils/SupertonicModelManager.ts`,
`example/src/utils/KittenModelManager.ts`, `example/src/utils/PhononModelManager.ts`) point at those upstream repos or
author-owned mirrors; the library itself bundles no weights.

Consumer apps are responsible for complying with each upstream model's
terms of use. MIT-licensed library code does not inherit the model's
license — comparable to VLC (GPL) playing CC-BY-NC video: the runtime
and the content are independently licensed.

## Native binaries (Phonon add-on)

Only apps that install `@pocketpalai/react-native-speech-phonon` (see its
[README](../packages/react-native-speech-phonon/README.md)) fetch and link these binaries at
build time. Apps with only this library contain none of them.

| Binary | Built from | License |
|--------|------------|---------|
| `libptts_ffi.so` (Android), `PhononCore.xcframework` (iOS) | [gradium-ai/xn-ptts](https://github.com/gradium-ai/xn-ptts) `v0.4.0` (`f07d7952db0c6127d5e4bc3f41c82b3304b6b5aa`) by Gradium | MIT OR Apache-2.0 |
| Rust crates statically linked into them | see the notices | MIT, Apache-2.0, Unicode-3.0, Zlib (generated list) |

Both upstream license texts (`licenses/xn-ptts-LICENSE-{MIT,APACHE}`) and the generated
`THIRD_PARTY_NOTICES.md` ship inside every Phonon release zip; the same notices are in
[THIRD_PARTY_NOTICES.md](../packages/react-native-speech-phonon/docs/THIRD_PARTY_NOTICES.md)
(generated with cargo-about by the add-on's `scripts/gen-notices.sh`; do not edit by hand). An
app that ships Phonon must include these notices, as for any MIT / Apache-2.0 component, for
example on its open-source licenses screen. The add-on's JNI shim and C++ glue
(`librnspeech_phonon.so`, its `cpp/`) are part of the add-on (MIT).

## This library

MIT. See [LICENSE](../LICENSE).
