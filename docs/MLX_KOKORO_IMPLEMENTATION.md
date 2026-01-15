# MLX-Based Neural TTS Implementation Plan

This document outlines the plan to add native Swift MLX-based neural TTS engines to react-native-speech, providing significantly faster inference on Apple Silicon devices.

## Supported Engines

| Engine | Parameters | Speed (M4 Pro) | Architecture |
|--------|------------|----------------|--------------|
| **Kokoro** | 82M | ~3.3x realtime | Flow-matching + Transformer |
| **Supertonic** | 66M | ~167x realtime | Flow-matching + ConvNeXt |

Both engines currently use ONNX Runtime in this library, but can be significantly accelerated with MLX on Apple Silicon.

## Background

### Current State: ONNX Runtime

The current Kokoro implementation uses ONNX Runtime via `onnxruntime-react-native`. While functional, it has significant performance limitations on iOS:

| Metric | Current (ONNX) | Target (MLX) |
|--------|----------------|--------------|
| **Performance** | ~0.6x realtime | ~3.3x realtime |
| **Backend** | CPU only* | Metal GPU (Apple Silicon) |
| **Inference Time** | ~8s for 13s audio | ~4s for 13s audio |

*CoreML execution provider is available but has limited transformer operator support, resulting in CPU fallback for most operations.

### Why ONNX CoreML Doesn't Work

According to [ONNX Runtime GitHub Issue #19887](https://github.com/microsoft/onnxruntime/issues/19887):

- Only ~25% of transformer model nodes can execute on CoreML
- Operators like `Erf`, `ReduceMean`, `LayerNorm`, and attention mechanisms lack CoreML support
- Graph partitioning between CoreML and CPU negates performance benefits
- ONNX Runtime explicitly warns: "CoreML is not recommended with this model"

### MLX Solution

[Apple's MLX framework](https://github.com/ml-explore/mlx-swift) is designed specifically for Apple Silicon and provides:

- Direct Metal GPU acceleration
- Native transformer architecture support
- Optimized tensor operations without conversion overhead
- Safetensors model format (loads weights directly)

The [kokoro-ios](https://github.com/mlalma/kokoro-ios) project demonstrates **3.3x realtime** performance on iPhone 13 Pro using MLX Swift.

### Supertonic: Even Faster

[Supertonic TTS](https://github.com/supertone-inc/supertonic) is designed for extreme efficiency:

- **167x realtime** on M4 Pro (even faster than Kokoro)
- **66M parameters** (smaller than Kokoro's 82M)
- **No G2P required** - works directly on raw character text
- **ConvNeXt blocks** - more CoreML/MLX friendly than transformers
- **2-step inference** - flow-matching with minimal diffusion steps

Currently, Supertonic only officially provides ONNX models, but the architecture (ConvNeXt + flow-matching) is well-suited for MLX conversion.

## Architecture

### Unified MLX TTS Module

Rather than creating separate modules for each TTS engine, we'll create a **unified native MLX TTS module** that can support multiple engines (Kokoro, Supertonic, and future models).

```
┌──────────────────────────────────────────────────────────────┐
│                    JavaScript/TypeScript                      │
│                                                               │
│  Speech.ts                                                    │
│    └── engineManager                                          │
│          ├── KokoroEngine (ONNX - existing, cross-platform)  │
│          ├── SupertonicEngine (ONNX - existing, cross-platform)│
│          └── MLXEngine (MLX - new, iOS 18+ only)             │
│                ├── model: 'kokoro' | 'supertonic'            │
│                └── Auto-selects best available               │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          │ TurboModule (JSI Bridge)
                          │
┌─────────────────────────▼────────────────────────────────────┐
│              NativeMLXTTS.ts (TypeScript Spec)                │
│                                                               │
│  interface Spec extends TurboModule {                         │
│    // Unified API for all MLX-based TTS models               │
│    loadModel(config: MLXModelConfig): Promise<void>;          │
│    generateAudio(text, voiceId, options): Promise<AudioData>; │
│    getVoices(): Promise<VoiceInfo[]>;                         │
│    unload(): Promise<void>;                                   │
│    isSupported(): boolean;                                    │
│    getSupportedModels(): string[];                            │
│  }                                                            │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          │ Native Bridge
                          │
┌─────────────────────────▼────────────────────────────────────┐
│              MLXTTSModule.swift                               │
│                                                               │
│  @objc(MLXTTSModule)                                          │
│  class MLXTTSModule: NSObject {                               │
│    private var currentEngine: MLXTTSEngine?                   │
│    private var engineType: EngineType = .none                 │
│                                                               │
│    enum EngineType {                                          │
│      case none, kokoro, supertonic                            │
│    }                                                          │
│                                                               │
│    @objc func loadModel(_ config: NSDictionary, ...)          │
│    @objc func generateAudio(_ text: String, ...)              │
│  }                                                            │
└─────────────────────────┬────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               ▼
┌─────────────────────┐     ┌─────────────────────────────────┐
│   KokoroMLXEngine   │     │      SupertonicMLXEngine        │
│                     │     │                                 │
│ - KokoroSwift pkg   │     │ - SupertonicMLX pkg (new)       │
│ - MisakiSwift (G2P) │     │ - No G2P needed                 │
│ - 82M params        │     │ - 66M params                    │
│ - ~3.3x realtime    │     │ - ~167x realtime                │
└─────────────────────┘     └─────────────────────────────────┘
          │                               │
          └───────────────┬───────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    MLX Swift Framework                        │
│                                                               │
│  ├── MLX Core - Tensor operations                            │
│  ├── MLXNN - Neural network layers                           │
│  ├── MLXFFT - Fast Fourier Transform                         │
│  └── Metal - GPU acceleration                                │
└──────────────────────────────────────────────────────────────┘
```

### Engine Selection Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    Speech.initialize()                            │
│                           │                                       │
│                           ▼                                       │
│         ┌─────────────────────────────────────┐                  │
│         │ engine === 'kokoro' | 'supertonic'? │                  │
│         └─────────────────┬───────────────────┘                  │
│                           │ yes                                   │
│                           ▼                                       │
│         ┌─────────────────────────────────────┐                  │
│         │ Check platform, iOS version, device │                  │
│         └─────────────────┬───────────────────┘                  │
│                           │                                       │
│    ┌──────────────────────┼──────────────────────┐               │
│    │                      │                      │               │
│    ▼                      ▼                      ▼               │
│  iOS 18+ &           iOS < 18              Android               │
│  Real Device         or Simulator                                │
│    │                      │                      │               │
│    ▼                      ▼                      ▼               │
│  MLXEngine           ONNX Engine            ONNX Engine          │
│  (Metal GPU)         (CPU fallback)         (CPU/NNAPI)          │
│    │                                                             │
│    ├── Kokoro: ~3.3x realtime                                    │
│    └── Supertonic: ~167x realtime                                │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Supertonic MLX Conversion

Supertonic currently only provides ONNX models officially. To use it with MLX, we need to either:

**Option A: Convert ONNX → MLX (Recommended)**
```python
# Using mlx-lm or custom converter
# Supertonic's architecture (ConvNeXt + flow-matching) is MLX-friendly
import mlx.core as mx
from onnx2mlx import convert  # hypothetical converter

model = convert("supertonic.onnx", output_format="safetensors")
```

**Option B: Request MLX Support from Supertone**
- Open issue on [supertone-inc/supertonic](https://github.com/supertone-inc/supertonic)
- Request official MLX/safetensors model release
- Their architecture is well-suited for MLX

**Option C: Port Model Manually**
- Implement Supertonic architecture in MLX Swift
- Similar approach to [kokoro-ios](https://github.com/mlalma/kokoro-ios)
- Components needed:
  - Speech autoencoder (encoder/decoder)
  - Flow-matching text-to-latent module
  - ConvNeXt blocks
  - Utterance-level duration predictor

## Requirements & Constraints

### Platform Requirements

| Requirement | Details |
|-------------|---------|
| **iOS Version** | iOS 18.0+ (MLX framework requirement) |
| **macOS Version** | macOS 15.0+ (if supporting Mac Catalyst) |
| **Hardware** | Apple Silicon (A-series, M-series) |
| **Simulator** | NOT supported (requires real Metal GPU) |

### Model Requirements

| Format | Extension | Size | Use Case |
|--------|-----------|------|----------|
| ONNX | `.onnx` | ~82MB (q8) | Existing engine, cross-platform |
| Safetensors | `.safetensors` | ~82MB | MLX engine, iOS 18+ |

Users will need both model formats if they want to support all devices.

### Dependencies

```swift
// Package.swift dependencies for KokoroSwift
dependencies: [
    .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.29.1"),
    .package(url: "https://github.com/mlalma/MisakiSwift", from: "1.0.4"),
    .package(url: "https://github.com/mlalma/MLXUtilsLibrary", from: "0.0.6"),
]
```

## Implementation Steps

### Phase 1: Native Swift Module

#### 1.1 Create KokoroMLXModule.swift

```swift
// ios/KokoroMLXModule.swift

import Foundation
import React
import KokoroSwift
import MLX

@objc(KokoroMLXModule)
class KokoroMLXModule: NSObject {

    private var tts: KokoroTTS?
    private var voices: [String: MLXArray] = [:]
    private let queue = DispatchQueue(label: "com.rnspech.kokoromlx", qos: .userInitiated)

    @objc static func requiresMainQueueSetup() -> Bool {
        return false
    }

    @objc static func isSupported() -> Bool {
        if #available(iOS 18.0, *) {
            // Check for real device (not simulator)
            #if targetEnvironment(simulator)
            return false
            #else
            return true
            #endif
        }
        return false
    }

    @objc func loadModel(_ config: NSDictionary,
                         resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
        queue.async { [weak self] in
            guard let self = self else { return }

            do {
                guard let modelPath = config["modelPath"] as? String else {
                    throw NSError(domain: "KokoroMLX", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "modelPath required"])
                }

                let modelURL = URL(fileURLWithPath: modelPath)
                self.tts = try KokoroTTS(modelPath: modelURL, g2p: .misaki)

                // Load voices if provided
                if let voicesPath = config["voicesPath"] as? String {
                    try self.loadVoices(from: voicesPath)
                }

                resolve(nil)
            } catch {
                reject("LOAD_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc func generateAudio(_ text: String,
                             voiceId: String,
                             options: NSDictionary,
                             resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {
        queue.async { [weak self] in
            guard let self = self, let tts = self.tts else {
                reject("NOT_INITIALIZED", "TTS not initialized", nil)
                return
            }

            guard let voiceEmbedding = self.voices[voiceId] else {
                reject("VOICE_NOT_FOUND", "Voice \(voiceId) not loaded", nil)
                return
            }

            do {
                let startTime = Date()
                let audioBuffer = try tts.generateAudio(
                    voice: voiceEmbedding,
                    language: .enUS,
                    text: text
                )
                let inferenceTime = Date().timeIntervalSince(startTime) * 1000

                // Convert MLXArray to base64 PCM
                let pcmData = self.convertToBase64PCM(audioBuffer)

                resolve([
                    "audio": pcmData,
                    "sampleRate": 24000,
                    "channels": 1,
                    "inferenceTimeMs": inferenceTime
                ])
            } catch {
                reject("GENERATE_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc func unload(_ resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
        queue.async { [weak self] in
            self?.tts = nil
            self?.voices.removeAll()
            resolve(nil)
        }
    }

    // MARK: - Private Methods

    private func loadVoices(from path: String) throws {
        // Load voice embeddings from safetensors or binary file
        // Implementation depends on voice file format
    }

    private func convertToBase64PCM(_ audioBuffer: MLXArray) -> String {
        // Convert MLXArray float32 samples to Int16 PCM and base64 encode
        let floatData = audioBuffer.asArray(Float.self)
        var int16Data = [Int16]()
        int16Data.reserveCapacity(floatData.count)

        for sample in floatData {
            let clamped = max(-1.0, min(1.0, sample))
            int16Data.append(Int16(clamped * 32767.0))
        }

        let data = int16Data.withUnsafeBufferPointer { buffer in
            Data(buffer: buffer)
        }

        return data.base64EncodedString()
    }
}
```

#### 1.2 Create Objective-C Bridge Header

```objective-c
// ios/KokoroMLXModule.m

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(KokoroMLXModule, NSObject)

RCT_EXTERN_METHOD(loadModel:(NSDictionary *)config
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(generateAudio:(NSString *)text
                  voiceId:(NSString *)voiceId
                  options:(NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unload:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
```

### Phase 2: TypeScript Integration

#### 2.1 Create NativeKokoroMLX.ts

```typescript
// src/NativeKokoroMLX.ts

import { TurboModuleRegistry, TurboModule } from 'react-native';

export interface MLXModelConfig {
  modelPath: string;
  voicesPath?: string;
  configPath?: string;
}

export interface MLXAudioResult {
  audio: string; // base64 PCM
  sampleRate: number;
  channels: number;
  inferenceTimeMs: number;
}

export interface MLXGenerateOptions {
  speed?: number;
  language?: string;
}

export interface Spec extends TurboModule {
  loadModel(config: MLXModelConfig): Promise<void>;
  generateAudio(
    text: string,
    voiceId: string,
    options: MLXGenerateOptions,
  ): Promise<MLXAudioResult>;
  unload(): Promise<void>;
}

// Check if module is available (iOS 18+ only)
export function isMLXSupported(): boolean {
  try {
    const module = TurboModuleRegistry.get<Spec>('KokoroMLXModule');
    return module !== null;
  } catch {
    return false;
  }
}

export default TurboModuleRegistry.get<Spec>('KokoroMLXModule');
```

#### 2.2 Create KokoroMLXEngine.ts

```typescript
// src/engines/kokoro/KokoroMLXEngine.ts

import { Platform } from 'react-native';
import type {
  TTSEngineInterface,
  AudioBuffer,
  SynthesisOptions,
  EngineStatus,
  KokoroVoice,
} from '../../types';
import NativeKokoroMLX, { isMLXSupported } from '../../NativeKokoroMLX';
import type { KokoroConfig } from '../../types';

export class KokoroMLXEngine implements TTSEngineInterface {
  readonly name = 'kokoro-mlx' as const;

  private isInitialized = false;
  private isLoading = false;
  private config: KokoroConfig | null = null;

  /**
   * Check if MLX engine is available on this device
   */
  static isAvailable(): boolean {
    if (Platform.OS !== 'ios') return false;

    const iosVersion = parseInt(Platform.Version as string, 10);
    if (iosVersion < 18) return false;

    return isMLXSupported();
  }

  async initialize(config?: KokoroConfig): Promise<void> {
    if (!KokoroMLXEngine.isAvailable()) {
      throw new Error(
        'KokoroMLX requires iOS 18+ on a physical device with Apple Silicon',
      );
    }

    if (!config?.modelPath) {
      throw new Error('modelPath is required for KokoroMLX');
    }

    this.isLoading = true;
    this.config = config;

    try {
      await NativeKokoroMLX?.loadModel({
        modelPath: config.modelPath.replace('file://', ''),
        voicesPath: config.voicesPath?.replace('file://', ''),
      });

      this.isInitialized = true;
      console.log('[KokoroMLXEngine] Initialized successfully');
    } finally {
      this.isLoading = false;
    }
  }

  async synthesize(
    text: string,
    options?: SynthesisOptions,
  ): Promise<AudioBuffer> {
    if (!this.isInitialized || !NativeKokoroMLX) {
      throw new Error('KokoroMLX engine not initialized');
    }

    const voiceId = options?.voiceId ?? 'af_heart';
    const startTime = Date.now();

    const result = await NativeKokoroMLX.generateAudio(text, voiceId, {
      speed: options?.speed ?? 1.0,
      language: options?.language ?? 'en-us',
    });

    console.log(
      `[KokoroMLXEngine] Generated audio in ${result.inferenceTimeMs.toFixed(0)}ms`,
    );

    // Decode base64 PCM to Float32Array
    const samples = this.decodeBase64PCM(result.audio);

    return {
      samples,
      sampleRate: result.sampleRate,
      channels: result.channels,
      duration: samples.length / result.sampleRate,
    };
  }

  async getAvailableVoices(language?: string): Promise<string[]> {
    // Return available voice IDs
    // TODO: Get from native module
    return ['af_heart', 'af_bella', 'am_adam', 'bf_emma', 'bm_george'];
  }

  getVoicesWithMetadata(language?: string): KokoroVoice[] {
    // TODO: Implement voice metadata
    return [];
  }

  async isReady(): Promise<boolean> {
    return this.isInitialized;
  }

  async destroy(): Promise<void> {
    await NativeKokoroMLX?.unload();
    this.isInitialized = false;
    this.config = null;
  }

  getStatus(): EngineStatus {
    return {
      isReady: this.isInitialized,
      isLoading: this.isLoading,
    };
  }

  private decodeBase64PCM(base64: string): Float32Array {
    // Decode base64 to binary
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert Int16 PCM to Float32
    const int16View = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16View.length);
    for (let i = 0; i < int16View.length; i++) {
      float32[i] = int16View[i]! / 32768.0;
    }

    return float32;
  }
}
```

### Phase 3: Podspec & Build Configuration

#### 3.1 Update RNSpeech.podspec

```ruby
# Add to RNSpeech.podspec

Pod::Spec.new do |s|
  # ... existing config ...

  # MLX-based Kokoro (iOS 18+ only)
  # Users must opt-in by setting ENABLE_KOKORO_MLX=1
  if ENV['ENABLE_KOKORO_MLX'] == '1'
    s.ios.deployment_target = '18.0'

    # Add KokoroSwift as SPM dependency
    s.swift_version = '5.9'

    # Note: CocoaPods doesn't natively support SPM dependencies
    # Option 1: Use cocoapods-spm plugin
    # Option 2: Vendor KokoroSwift source directly
    # Option 3: Create a separate pod for MLX support

    s.source_files = "ios/**/*.{h,m,mm,cpp,swift}"

    s.pod_target_xcconfig = {
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => 'ENABLE_KOKORO_MLX',
      'OTHER_LDFLAGS' => '-framework Metal -framework MetalPerformanceShaders',
    }
  end
end
```

#### 3.2 Alternative: Separate Pod for MLX

```ruby
# RNSpeechMLX.podspec (separate optional pod)

Pod::Spec.new do |s|
  s.name         = "RNSpeechMLX"
  s.version      = package["version"]
  s.summary      = "MLX-based Kokoro TTS for react-native-speech"
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.author       = package["author"]

  s.platforms    = { :ios => "18.0" }
  s.source       = { :git => "...", :tag => "v#{s.version}" }

  s.swift_version = '5.9'
  s.source_files = "ios-mlx/**/*.{swift,h,m}"

  s.dependency "RNSpeech"
  s.dependency "KokoroSwift", "~> 1.0"

  s.frameworks = "Metal", "MetalPerformanceShaders", "Accelerate"
end
```

### Phase 4: Model Management

#### 4.1 Update KokoroModelManager

```typescript
// src/engines/kokoro/KokoroModelManager.ts

export interface ModelVariant {
  onnx: string;      // .onnx file for ONNX Runtime
  safetensors?: string; // .safetensors file for MLX (optional)
}

export class KokoroModelManager {
  // ... existing code ...

  /**
   * Get model config for MLX engine
   * Requires safetensors format model
   */
  getMLXModelConfig(version: string, variant: string): KokoroConfig {
    const basePath = this.getModelDirectory(version, variant);

    return {
      modelPath: `file://${basePath}/${version}-${variant}.safetensors`,
      voicesPath: `file://${basePath}/voices.bin`,
      configPath: `file://${basePath}/config.json`,
    };
  }

  /**
   * Download MLX-compatible model (safetensors format)
   */
  async downloadMLXModel(
    variant: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const urls = {
      safetensors: `https://huggingface.co/mlalma/kokoro-mlx/resolve/main/kokoro-v1.0.safetensors`,
      voices: `https://huggingface.co/mlalma/kokoro-mlx/resolve/main/voices.bin`,
      config: `https://huggingface.co/mlalma/kokoro-mlx/resolve/main/config.json`,
    };

    // Download files...
  }
}
```

## Migration Guide

### For Library Users

#### Automatic Engine Selection (Recommended)

```typescript
import Speech, { TTSEngine } from 'react-native-speech';

// Library automatically selects best available engine
await Speech.initialize({
  engine: TTSEngine.KOKORO,
  modelPath: '...', // Provide both ONNX and safetensors if available
  // On iOS 18+ physical devices: Uses MLX (3.3x realtime)
  // On iOS <18 or simulator: Uses ONNX (0.6x realtime)
  // On Android: Uses ONNX
});
```

#### Manual Engine Selection

```typescript
import { KokoroMLXEngine } from 'react-native-speech';

// Check if MLX is available
if (KokoroMLXEngine.isAvailable()) {
  // Use MLX engine explicitly
  await Speech.initialize({
    engine: TTSEngine.KOKORO_MLX,
    modelPath: 'path/to/model.safetensors',
  });
} else {
  // Fall back to ONNX
  await Speech.initialize({
    engine: TTSEngine.KOKORO,
    modelPath: 'path/to/model.onnx',
  });
}
```

### Model Files Required

**Kokoro:**
| Engine | Model File | Voice File |
|--------|-----------|------------|
| ONNX | `kokoro-v1.0-q8.onnx` | `voices-v1.0.bin` |
| MLX | `kokoro-v1.0.safetensors` | `voices.bin` |

**Supertonic:**
| Engine | Model File | Voice File |
|--------|-----------|------------|
| ONNX | `supertonic.onnx` | `voice_presets.bin` |
| MLX | `supertonic.safetensors` (TBD) | `voice_presets.bin` |

## Performance Comparison

### Kokoro Benchmark: iPhone 13 Pro

| Metric | ONNX (CPU) | MLX (Metal) | Improvement |
|--------|-----------|-------------|-------------|
| Model Load | ~2s | ~1.5s | 1.3x |
| First Inference | ~10s | ~5s | 2x |
| Sustained Inference | ~8s/13s audio | ~4s/13s audio | 2x |
| Realtime Factor | 0.6x | 3.3x | 5.5x |

### Supertonic Benchmark: M4 Pro (Expected)

| Metric | ONNX (CPU) | MLX (Metal) | Improvement |
|--------|-----------|-------------|-------------|
| Model Load | ~1s | ~0.5s | 2x |
| Inference | ~0.5s/10s audio | ~0.06s/10s audio | 8x |
| Realtime Factor | ~20x | ~167x | 8x |

*Note: Supertonic MLX numbers are projected based on official benchmarks. Actual React Native performance may vary.*

### Memory Usage

| Engine | Model | Peak Memory | Notes |
|--------|-------|------------|-------|
| ONNX | Kokoro | ~300MB | Higher due to CPU tensor allocations |
| MLX | Kokoro | ~200MB | More efficient GPU memory management |
| ONNX | Supertonic | ~150MB | Smaller model (66M params) |
| MLX | Supertonic | ~100MB | Estimated |

### Choosing Between Kokoro and Supertonic

| Factor | Kokoro | Supertonic |
|--------|--------|------------|
| **Voice Quality** | Higher (82M params) | Good (66M params) |
| **Speed** | 3.3x realtime | 167x realtime |
| **Languages** | Multi-language | English focus |
| **G2P Required** | Yes (MisakiSwift/espeak) | No (built-in) |
| **MLX Support** | Available (kokoro-ios) | Needs porting |
| **Best For** | Quality-focused apps | Latency-critical apps |

## Known Limitations

1. **iOS 18+ Only**: MLX framework requires iOS 18.0 or later
2. **No Simulator Support**: Requires real Metal GPU hardware
3. **Apple Silicon Only**: Intel Macs not supported
4. **Larger App Size**: MLX framework adds ~50MB to app bundle
5. **Different Model Format**: Requires safetensors, not ONNX

## Future Enhancements

1. **Streaming Audio**: Generate and play audio in chunks for lower latency
2. **Voice Cloning**: Support for custom voice embeddings
3. **Multi-language**: Expand G2P support beyond English
4. **macOS Support**: Enable for Mac Catalyst apps
5. **Model Quantization**: Support quantized MLX models for smaller size
6. **Supertonic MLX Port**: Convert Supertonic to MLX Swift for 167x realtime
7. **Unified Model Manager**: Single API for both ONNX and MLX model downloads

## Implementation Roadmap

### Phase 1: Kokoro MLX (iOS 18+)
- [x] Document architecture and plan
- [ ] Create `MLXTTSModule.swift` native module
- [ ] Integrate [kokoro-ios](https://github.com/mlalma/kokoro-ios) package
- [ ] Create `KokoroMLXEngine.ts` TypeScript wrapper
- [ ] Add auto-detection and fallback logic
- [ ] Test on physical iOS 18 devices

### Phase 2: Supertonic MLX
- [ ] Research ONNX → MLX conversion for Supertonic
- [ ] Request official MLX support from Supertone
- [ ] Port Supertonic architecture to MLX Swift (if needed)
- [ ] Create `SupertonicMLXEngine.ts` wrapper
- [ ] Benchmark against ONNX version

### Phase 3: Unified MLX Module
- [ ] Refactor into single `MLXTTSModule` supporting multiple models
- [ ] Add model type detection (Kokoro vs Supertonic)
- [ ] Unified voice loading API
- [ ] Streaming audio support

## References

### Kokoro
- [kokoro-ios GitHub](https://github.com/mlalma/kokoro-ios) - MLX Swift implementation
- [Kokoro TTS Model](https://huggingface.co/hexgrad/Kokoro-82M) - Original model
- [MisakiSwift](https://github.com/mlalma/MisakiSwift) - G2P library for Kokoro

### Supertonic
- [Supertonic GitHub](https://github.com/supertone-inc/supertonic) - Official ONNX implementation
- [Supertonic Paper](https://arxiv.org/abs/2503.23108) - Architecture details
- [Supertonic Demo](https://supertonictts.github.io/) - Audio samples
- [Supertonic HuggingFace](https://huggingface.co/Supertone/supertonic) - Model files

### MLX Framework
- [MLX Swift](https://github.com/ml-explore/mlx-swift) - Apple's ML framework
- [MLX Examples](https://github.com/ml-explore/mlx-swift-examples) - Reference implementations
- [mlx-audio](https://github.com/Blaizzy/mlx-audio) - Audio ML with MLX (Python)

### ONNX Runtime Issues
- [CoreML Transformer Limitations](https://github.com/microsoft/onnxruntime/issues/19887) - Why CoreML doesn't work
