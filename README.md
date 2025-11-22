<p align="center">
  <a href="https://mhpdev.com" target="_blank">
    <img src="./docs/banner.png" alt="React Native Full Responsive Banner" style="max-width:100%;height:auto;" />
  </a>
</p>

A high-performance text-to-speech library built for bare React Native and Expo, compatible with Android and iOS. It enables seamless speech management and provides events for detailed synthesis management.

<div align="center">
  <a href="./docs/USAGE.md">Documentation</a> · <a href="./example/">Example</a>
</div>
<br/>

> **Only New Architecture**: This library is only compatible with the new architecture. If you're using React Native 0.76 or higher, it is already enabled. However, if your React Native version is between 0.68 and 0.75, you need to enable it first. [Click here if you need help enabling the new architecture](https://github.com/reactwg/react-native-new-architecture/blob/main/docs/enable-apps.md)

## Preview

|                                                                                                          <center>Android</center>                                                                                                           |                                                                                                          <center>iOS</center>                                                                                                           |
| :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <video src="https://github.com/user-attachments/assets/0601b827-a87a-4eb0-be28-273aa2ec5942" controls width="100%" height="500"></video> [Android Preview](https://github.com/user-attachments/assets/0601b827-a87a-4eb0-be28-273aa2ec5942) | <video src="https://github.com/user-attachments/assets/1579639e-049b-42f4-9795-bc56956541bd" width="100%" height="500" controls></video> [iOS Preview](https://github.com/user-attachments/assets/1579639e-049b-42f4-9795-bc56956541bd) |

## Features

- 🚀 &nbsp;**High Performance** - Built on Turbo Modules for a fast, native-like experience on Android & iOS

- 🎛️ &nbsp;**Full Control** - Complete set of methods for comprehensive speech synthesis management

- 🪄 &nbsp;**Consistent Playback** - Offers `pause` and `resume` support for iOS and Android. Since this functionality isn’t natively available on Android, the library provides a custom implementation (API 26+) designed to emulate the iOS experience

- 🔊 &nbsp;**Optional Audio Ducking** - Automatically lowers other app audio to ensure clear, uninterrupted speech

- 📡 &nbsp;**Rich Events** - Comprehensive event system for precise synthesis lifecycle monitoring

- 💅 &nbsp;**Visual Feedback** - Customizable [HighlightedText](./docs/USAGE.md#highlightedtext) component for real-time speech visualization

- ✅ &nbsp;**Type Safety** - Fully written in TypeScript with complete type definitions

### Multi-Engine Support (v2.0+)

- 🎯 &nbsp;**Neural TTS** - High-quality neural voices running entirely on-device
  - **Kokoro** - Premium quality, multi-language support (EN, ZH, KO, JA)
  - **Supertonic** - Ultra-fast (167× real-time), lightweight (66M params)
- 🔒 &nbsp;**Privacy-First** - Neural synthesis with no cloud dependencies
- 🌐 &nbsp;**Multi-Language** - Support for English, Chinese, Korean, Japanese
- 🎨 &nbsp;**Voice Blending** - Mix multiple voices for unique characteristics (Kokoro)
- ⚡ &nbsp;**Ultra-Fast** - Supertonic delivers 167× faster than real-time performance
- 🔄 &nbsp;**Unified API** - Simple, consistent API across all engines

> **New in v2.0:** Neural TTS engine support with Kokoro and Supertonic! See [Kokoro Guide](./docs/KOKORO_GUIDE.md) and [Supertonic Guide](./docs/SUPERTONIC_GUIDE.md) for details.

## Installation

### Bare React Native

Install the package using either npm or Yarn:

```sh
npm install @mhpdev/react-native-speech
```

Or with Yarn:

```sh
yarn add @mhpdev/react-native-speech
```

For iOS, navigate to the ios directory and install the pods:

```sh
cd ios && pod install
```

### Expo

For Expo projects, follow these steps:

1. Install the package:

   ```sh
   npx expo install @mhpdev/react-native-speech
   ```

2. Since it is not supported on Expo Go, run:

   ```sh
   npx expo prebuild
   ```

### Neural TTS Engines (Optional)

To use neural TTS engines (Kokoro or Supertonic), install the ONNX Runtime peer dependency:

```sh
npm install onnxruntime-react-native
```

> **Note:** `onnxruntime-react-native` is an **optional peer dependency**. It's only required if you want to use neural TTS engines (Kokoro or Supertonic). The OS native TTS works without it.

Then follow the model management guides:
- [Kokoro Model Management Guide](./docs/KOKORO_MODEL_MANAGEMENT.md)
- [Supertonic Model Management Guide](./docs/SUPERTONIC_MODEL_MANAGEMENT.md)

## Usage

To learn how to use the library, check out the [usage section](./docs/USAGE.md).

## Quick Start

```tsx
import React from 'react';
import Speech from '@mhpdev/react-native-speech';
import {SafeAreaView, StyleSheet, Text, TouchableOpacity} from 'react-native';

const App: React.FC = () => {
  const onSpeakPress = () => {
    Speech.speak('Hello World!');
  };

  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={onSpeakPress}>
        <Text style={styles.buttonText}>Speak</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
};

export default App;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    padding: 12.5,
    borderRadius: 5,
    backgroundColor: 'skyblue',
  },
  buttonText: {
    fontSize: 22,
    fontWeight: '600',
  },
});
```

### Neural TTS Quick Start (v2.0 Unified API)

```tsx
import Speech, {TTSEngine} from '@mhpdev/react-native-speech';

// Initialize with Kokoro (high quality)
await Speech.initialize({
  engine: TTSEngine.KOKORO,
  modelPath: 'file://path/to/model.onnx',
  vocabPath: 'file://path/to/vocab.json',
  mergesPath: 'file://path/to/merges.txt',
  voicesPath: 'file://path/to/voices.bin',
});

// Or initialize with Supertonic (ultra-fast)
await Speech.initialize({
  engine: TTSEngine.SUPERTONIC,
  modelPath: 'file://path/to/model.onnx',
  voicesPath: 'file://path/to/voices.bin',
});

// Speak with neural voice (same API for all engines!)
await Speech.speak(
  'Hello! This is high-quality neural speech.',
  'af_bella', // Voice ID
  { speed: 1.0, volume: 1.0 }
);
```

**To switch engines, just change the config - no code changes needed!**

See the [Kokoro Guide](./docs/KOKORO_GUIDE.md) and [Supertonic Guide](./docs/SUPERTONIC_GUIDE.md) for complete setup instructions.

To become more familiar with the usage of the library, check out the [example project](./example/).

## Documentation

- [Usage Guide](./docs/USAGE.md) - Complete API reference for OS native TTS
- [Kokoro Guide](./docs/KOKORO_GUIDE.md) - Kokoro neural TTS engine setup and usage
- [Supertonic Guide](./docs/SUPERTONIC_GUIDE.md) - Supertonic neural TTS engine setup and usage
- [Kokoro Model Management](./docs/KOKORO_MODEL_MANAGEMENT.md) - How to manage Kokoro models
- [Supertonic Model Management](./docs/SUPERTONIC_MODEL_MANAGEMENT.md) - How to manage Supertonic models
- [Migration Guide](./docs/MIGRATION_V2.md) - Migrating from v1.x to v2.0
- [Example App](./example/) - Working examples of all features

## Testing

To mock the package's methods and components using the default mock configuration provided, follow these steps:

- Create a file named `@mhpdev/react-native-speech.ts` inside your `__mocks__` directory.

- Copy the following code into that file:

  ```js
  module.exports = require('@mhpdev/react-native-speech/jest');
  ```

## Contributing

See the [contributing guide](./docs/CONTRIBUTING.md) to learn how to contribute to the repository and the development workflow.

## License

MIT
