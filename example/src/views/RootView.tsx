import React from 'react';
import {gs} from '../styles/gs';
import {
  Text,
  View,
  Alert,
  AppState,
  Platform,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  ScrollView,
  Pressable,
} from 'react-native';
import type {AppStateStatus} from 'react-native';
import Speech, {
  HighlightedText,
  type AudioBuffer,
  type HighlightedSegmentArgs,
  type HighlightedSegmentProps,
  type ChunkProgressEvent,
  type ExecutionProvider,
  CoreMlFlag,
  DEFAULT_COREML_FLAGS,
  TTSEngine,
} from '@pocketpalai/react-native-speech';
import Button from '../components/Button';
import {C, MONO} from '../styles/cyber';
import {SafeAreaView} from 'react-native-safe-area-context';
import {kokoroModelManager} from '../utils/ModelManager';
import {
  supertonicModelManager,
  type SupertonicVersion,
} from '../utils/SupertonicModelManager';
import {phonemizerDictManager} from '../utils/PhonemizerDictManager';
import {
  kittenModelManager,
  type KittenVersion,
} from '../utils/KittenModelManager';
import {saveChunksAsWav} from '../utils/wavWriter';
import {
  ENGLISH_DEFAULT_TEXT,
  SAMPLE_TEXT,
  SAMPLE_TEXT_SET,
} from '../utils/sampleText';

const isAndroidLowerThan26 = Platform.OS === 'android' && Platform.Version < 26;

const DEFAULT_TEXT = ENGLISH_DEFAULT_TEXT;

// Model Manager Tab Type
type ModelTab = 'kokoro' | 'supertonic' | 'kitten';

// Acceleration EP picker state. Per-platform candidate set; cpu is
// always appended as the last fallback so users can't fully disable it.
type AccelEpName = 'coreml' | 'xnnpack';

interface AccelState {
  selected: ReadonlySet<AccelEpName>;
  /**
   * CoreML flag bitmask (iOS only). Bit-OR of `CoreMlFlag` constants.
   * Ignored on Android.
   */
  coreMlFlags: number;
}

const ACCEL_DEFAULT: AccelState =
  Platform.OS === 'ios'
    ? {
        selected: new Set<AccelEpName>(['coreml', 'xnnpack']),
        coreMlFlags: DEFAULT_COREML_FLAGS,
      }
    : {
        selected: new Set<AccelEpName>(['xnnpack']),
        coreMlFlags: 0,
      };

/**
 * Translate the multi-select acceleration state into the array form
 * `Speech.initialize({executionProviders})` expects. CPU is always the
 * last fallback so the runtime has a guaranteed catch-all.
 */
function accelToProviders(state: AccelState): ExecutionProvider[] {
  const out: ExecutionProvider[] = [];
  if (state.selected.has('coreml') && Platform.OS === 'ios') {
    out.push({name: 'coreml', coreMlFlags: state.coreMlFlags});
  }
  if (state.selected.has('xnnpack')) {
    out.push('xnnpack');
  }
  out.push('cpu');
  return out;
}

interface CoreMlFlagOption {
  flag: number;
  label: string;
  hint: string;
}

const COREML_FLAG_OPTIONS: CoreMlFlagOption[] = [
  {
    flag: CoreMlFlag.ENABLE_ON_SUBGRAPH,
    label: 'Subgraph',
    hint: 'Run CoreML on subgraphs (broader op coverage).',
  },
  {
    flag: CoreMlFlag.USE_CPU_AND_GPU,
    label: 'CPU + GPU',
    hint: 'Allow Metal GPU. Default; off forces CPU/ANE only.',
  },
  {
    flag: CoreMlFlag.USE_CPU_ONLY,
    label: 'CPU only',
    hint: 'Disables GPU/ANE. Useful for debugging.',
  },
  {
    flag: CoreMlFlag.ONLY_ENABLE_DEVICE_WITH_ANE,
    label: 'ANE only',
    hint: 'Skip CoreML on devices without Apple Neural Engine.',
  },
  {
    flag: CoreMlFlag.CREATE_MLPROGRAM,
    label: 'MLProgram',
    hint: 'Newer ML format (iOS 15+). Often faster on recent devices.',
  },
  {
    flag: CoreMlFlag.ONLY_ALLOW_STATIC_INPUT_SHAPES,
    label: 'Static shapes',
    hint: 'Only run CoreML on subgraphs with fixed input shapes.',
  },
];

const RootView: React.FC = () => {
  const themedStyles = React.useMemo(
    () =>
      StyleSheet.create({
        textPrimary: {color: C.green},
        textSecondary: {color: C.muted},
        textWhite: {color: C.green},
        bgCard: {
          backgroundColor: C.bgCard,
          borderWidth: 1,
          borderColor: C.border,
        },
        bgCardSecondary: {backgroundColor: '#080c08'},
        bgInput: {backgroundColor: C.bgInput},
        bgChunkProgress: {backgroundColor: C.cyanGhost},
        btnSelected: {
          backgroundColor: C.greenGhost,
          borderWidth: 1,
          borderColor: C.green,
        },
        btnUnselected: {
          backgroundColor: 'rgba(255,255,255,0.02)',
          borderWidth: 1,
          borderColor: C.border,
        },
        btnSelectedGreen: {backgroundColor: C.greenGhost},
        statusReady: {color: C.green},
        statusNotReady: {color: C.red},
        statusAccent: {color: C.cyan},
        voiceItemSelected: {backgroundColor: C.greenGhost},
        voiceItemUnselected: {backgroundColor: 'transparent'},
        downloadTextInstalled: {color: C.muted},
        downloadTextWhite: {color: C.green},
        downloadMetaWhite: {color: C.greenDim},
        downloadLangsWhite: {color: C.greenFaint},
        opacityFaded: {opacity: 0.3},
        opacityFull: {opacity: 1},
        sectionLabelWithMargin: {marginTop: 20},
        downloadCardBlue: {
          backgroundColor: C.cyanGhost,
          borderWidth: 1,
          borderColor: C.cyanBorder,
        },
        downloadCardGreen: {
          backgroundColor: C.greenGhost,
          borderWidth: 1,
          borderColor: C.greenBorder,
        },
        downloadCardOrange: {
          backgroundColor: C.amberGhost,
          borderWidth: 1,
          borderColor: C.amberBorder,
        },
        downloadCardInstalled: {backgroundColor: C.bgCard},
      }),
    [],
  );
  const [isPaused, setIsPaused] = React.useState<boolean>(false);
  const [isStarted, setIsStarted] = React.useState<boolean>(false);
  const [spokenText, setSpokenText] = React.useState<string>(DEFAULT_TEXT);
  const [highlights, setHighlights] = React.useState<
    Array<HighlightedSegmentProps>
  >([]);

  const [selectedEngine, setSelectedEngine] = React.useState<TTSEngine>(
    TTSEngine.KITTEN,
  );
  const [initializedEngine, setInitializedEngine] =
    React.useState<TTSEngine | null>(null);
  const [isInitializing, setIsInitializing] = React.useState<boolean>(false);
  const [engineReady, setEngineReady] = React.useState<boolean>(false);
  const [availableVoices, setAvailableVoices] = React.useState<any[]>([]);
  const [selectedVoice, setSelectedVoice] = React.useState<string | null>(null);
  const [showVoicePicker, setShowVoicePicker] = React.useState<boolean>(false);

  // Model Manager State
  const [showModelManager, setShowModelManager] =
    React.useState<boolean>(false);
  const [modelManagerTab, setModelManagerTab] =
    React.useState<ModelTab>('kokoro');
  const [isDownloading, setIsDownloading] = React.useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = React.useState<number>(0);
  const [downloadingItem, setDownloadingItem] = React.useState<string | null>(
    null,
  );
  const [kokoroModels, setKokoroModels] = React.useState<any[]>([]);
  const [supertonicModels, setSupertonicModels] = React.useState<any[]>([]);
  const [kittenModels, setKittenModels] = React.useState<any[]>([]);

  // Execution provider selection for hardware acceleration. Multi-select
  // per platform; CPU is always appended as the final fallback.
  const [accel, setAccel] = React.useState<AccelState>(ACCEL_DEFAULT);
  const [showAccelDetails, setShowAccelDetails] = React.useState(false);
  const providers = React.useMemo(() => accelToProviders(accel), [accel]);

  // Model release state
  const [isReleasing, setIsReleasing] = React.useState<boolean>(false);

  // Chunk progress for neural engines
  const [currentChunk, setCurrentChunk] =
    React.useState<ChunkProgressEvent | null>(null);

  // Supertonic synthesis options
  const [speed, setSpeed] = React.useState<number>(1.0);
  const [inferenceSteps, setInferenceSteps] = React.useState<number>(5);
  const [supertonicLanguage, setSupertonicLanguage] =
    React.useState<string>('en');
  // When true, accumulate audio chunks during synthesis and write a WAV
  // to the app's Documents directory once Speak completes. Lets the user
  // capture on-device output for offline verification (the Node harness
  // runs the same ASR round-trip against these files).
  const [saveWav, setSaveWav] = React.useState<boolean>(false);
  // Which Supertonic setting is open in the dropdown modal (null = closed).
  // Single modal services all three dropdowns; content is keyed by this.
  const [openPicker, setOpenPicker] = React.useState<
    'speed' | 'quality' | 'language' | null
  >(null);

  // Release current engine before switching
  const releaseCurrentEngine = React.useCallback(async () => {
    try {
      const result = await Speech.release();
      if (!result.success) {
        console.warn(
          '[RootView] Engine release had errors:',
          result.errors.map(e => `${e.component}: ${e.error.message}`),
        );
      }
    } catch (error) {
      console.warn('[RootView] Failed to release engine:', error);
    }
  }, []);

  // Initialize engine when selection changes
  const initializeEngine = React.useCallback(
    async (
      engine: TTSEngine,
      provider: ExecutionProvider[] = accelToProviders(ACCEL_DEFAULT),
    ) => {
      try {
        setIsInitializing(true);
        setEngineReady(false);
        setInitializedEngine(null);

        // Release previous engine resources before initializing new one
        await releaseCurrentEngine();

        if (engine === TTSEngine.OS_NATIVE) {
          await Speech.initialize({
            engine: TTSEngine.OS_NATIVE,
            silentMode: 'obey',
            ducking: true,
          });
          setInitializedEngine(TTSEngine.OS_NATIVE);
          setEngineReady(true);
        } else if (engine === TTSEngine.KOKORO) {
          await kokoroModelManager.scanInstalledModels();
          const models = kokoroModelManager.getInstalledModels();

          if (models.length === 0) {
            // No models - prompt to download
            setEngineReady(false);
            Alert.alert(
              'Kokoro Model Required',
              'Download a model to use Kokoro TTS.',
              [
                {text: 'Later', style: 'cancel'},
                {
                  text: 'Download',
                  onPress: () => {
                    setModelManagerTab('kokoro');
                    setShowModelManager(true);
                  },
                },
              ],
            );
            return;
          }

          const model = models[0]!;
          const config = kokoroModelManager.getDownloadedModelConfig(
            model.version,
            model.variant,
          );
          const dictPath = await phonemizerDictManager.ensureDict('en-us');

          await Speech.initialize({
            engine: TTSEngine.KOKORO,
            ...config,
            dictPath,
            phonemizerType: 'js',
            silentMode: 'obey',
            ducking: true,
            maxChunkSize: 100,
            executionProviders: provider,
          });
          setInitializedEngine(TTSEngine.KOKORO);
          setEngineReady(true);
        } else if (engine === TTSEngine.SUPERTONIC) {
          await supertonicModelManager.scanInstalledModel();
          const model = supertonicModelManager.getInstalledModel();

          if (!model) {
            setEngineReady(false);
            Alert.alert(
              'Supertonic Model Required',
              'Download a model to use Supertonic TTS.',
              [
                {text: 'Later', style: 'cancel'},
                {
                  text: 'Download',
                  onPress: () => {
                    setModelManagerTab('supertonic');
                    setShowModelManager(true);
                  },
                },
              ],
            );
            return;
          }

          const config = supertonicModelManager.getDownloadedModelConfig();
          await Speech.initialize({
            engine: TTSEngine.SUPERTONIC,
            ...config,
            silentMode: 'obey',
            ducking: true,
            maxChunkSize: 200,
            executionProviders: provider,
          });
          setInitializedEngine(TTSEngine.SUPERTONIC);
          setEngineReady(true);
        } else if (engine === TTSEngine.KITTEN) {
          await kittenModelManager.scanInstalledModel();
          const model = kittenModelManager.getInstalledModel();

          if (!model) {
            setEngineReady(false);
            Alert.alert(
              'Kitten Model Required',
              'Download a model to use Kitten TTS.',
              [
                {text: 'Later', style: 'cancel'},
                {
                  text: 'Download',
                  onPress: () => {
                    setModelManagerTab('kitten');
                    setShowModelManager(true);
                  },
                },
              ],
            );
            return;
          }

          const config = kittenModelManager.getDownloadedModelConfig();
          const dictPath = await phonemizerDictManager.ensureDict('en-us');
          await Speech.initialize({
            engine: TTSEngine.KITTEN,
            ...config,
            dictPath,
            silentMode: 'obey',
            ducking: true,
            // Kitten chunks per-sentence (unlike Kokoro's packed chunking).
            // Keep this high so natural sentences stay intact and we never
            // word-break mid-sentence; only exceptionally long sentences
            // (>500 chars) will fall back to whitespace splitting.
            maxChunkSize: 500,
            executionProviders: provider,
          });
          setInitializedEngine(TTSEngine.KITTEN);
          setEngineReady(true);
        }
      } catch (error) {
        console.error('Failed to initialize engine:', error);
        setEngineReady(false);
        Alert.alert(
          'Initialization Error',
          `Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      } finally {
        setIsInitializing(false);
      }
    },
    [releaseCurrentEngine],
  );

  React.useEffect(() => {
    initializeEngine(selectedEngine, providers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEngine, providers]);

  // Load voices when engine is ready
  const loadVoices = React.useCallback(async () => {
    // Only load voices if engine is ready and matches what we expect
    if (
      !engineReady ||
      isInitializing ||
      initializedEngine !== selectedEngine
    ) {
      setAvailableVoices([]);
      setSelectedVoice(null);
      return;
    }

    try {
      if (initializedEngine === TTSEngine.OS_NATIVE) {
        const voices = await Speech.getAvailableVoices();
        setAvailableVoices(
          voices.map(v => ({
            id: v.identifier,
            name: v.name || v.identifier,
            language: v.language,
          })),
        );
        if (voices.length > 0 && voices[0]) {
          setSelectedVoice(voices[0].identifier);
        }
      } else {
        const voices = await Speech.getVoicesWithMetadata();
        setAvailableVoices(voices);
        if (voices.length > 0 && voices[0]) {
          setSelectedVoice(voices[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load voices:', error);
      setAvailableVoices([]);
      setSelectedVoice(null);
    }
  }, [engineReady, selectedEngine, initializedEngine, isInitializing]);

  React.useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  // Auto-swap the speak text to match the picked Supertonic language —
  // but only when the current text is one of the unedited samples. If
  // the user has typed/pasted their own text, leave it alone.
  React.useEffect(() => {
    if (selectedEngine !== TTSEngine.SUPERTONIC) return;
    if (!SAMPLE_TEXT_SET.has(spokenText)) return;
    const next = SAMPLE_TEXT[supertonicLanguage];
    if (next && next !== spokenText) {
      setSpokenText(next);
    }
  }, [selectedEngine, supertonicLanguage, spokenText]);

  // Load installed models
  const loadInstalledModels = React.useCallback(async () => {
    await kokoroModelManager.scanInstalledModels();
    setKokoroModels(kokoroModelManager.getInstalledModels());

    await supertonicModelManager.scanInstalledModel();
    setSupertonicModels(supertonicModelManager.getAllInstalledModels());

    await kittenModelManager.scanInstalledModel();
    setKittenModels(kittenModelManager.getAllInstalledModels());
  }, []);

  React.useEffect(() => {
    loadInstalledModels();
  }, [loadInstalledModels]);

  // Release engine resources when app goes to background
  React.useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background') {
        // Release neural engine resources when app is backgrounded
        Speech.release().catch(err =>
          console.warn('[RootView] Background release failed:', err),
        );
        setEngineReady(false);
        setInitializedEngine(null);
      }
    };

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );
    return () => subscription.remove();
  }, []);

  // Release engine on unmount
  React.useEffect(() => {
    return () => {
      Speech.release().catch(err =>
        console.warn('[RootView] Unmount release failed:', err),
      );
    };
  }, []);

  // Speech event handlers
  React.useEffect(() => {
    const onSpeechEnd = () => {
      setIsStarted(false);
      setIsPaused(false);
      setHighlights([]);
      setCurrentChunk(null);
    };

    const startSubscription = Speech.onStart(() => setIsStarted(true));
    const finishSubscription = Speech.onFinish(() => onSpeechEnd());
    const pauseSubscription = Speech.onPause(() => setIsPaused(true));
    const resumeSubscription = Speech.onResume(() => setIsPaused(false));
    const stoppedSubscription = Speech.onStopped(() => onSpeechEnd());
    const progressSubscription = Speech.onProgress(({location, length}) => {
      setHighlights([{start: location, end: location + length}]);
    });
    const unsubscribeChunkProgress = Speech.onChunkProgress(
      (event: ChunkProgressEvent) => {
        setCurrentChunk(event);
        setHighlights([
          {start: event.textRange.start, end: event.textRange.end},
        ]);
      },
    );

    return () => {
      startSubscription.remove();
      finishSubscription.remove();
      pauseSubscription.remove();
      resumeSubscription.remove();
      stoppedSubscription.remove();
      progressSubscription.remove();
      unsubscribeChunkProgress();
    };
  }, []);

  // Unload: release engine resources without switching engine
  const onUnloadPress = React.useCallback(async () => {
    setIsReleasing(true);
    try {
      const result = await Speech.release();
      setEngineReady(false);
      setInitializedEngine(null);
      setAvailableVoices([]);
      setSelectedVoice(null);
      if (!result.success) {
        Alert.alert(
          'Release Warning',
          `Released with ${result.errors.length} error(s): ${result.errors.map(e => e.component).join(', ')}`,
        );
      }
    } catch (error) {
      Alert.alert(
        'Release Error',
        `Failed to release: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      setIsReleasing(false);
    }
  }, []);

  // Reload: re-initialize the currently selected engine
  const onReloadPress = React.useCallback(() => {
    initializeEngine(selectedEngine, providers);
  }, [initializeEngine, selectedEngine, providers]);

  const onStartPress = React.useCallback(async () => {
    // Set started immediately so Stop is available during synthesis
    // (neural engines take time to synthesize the first chunk before audio starts)
    setIsStarted(true);

    // Audio capture buffer for the optional Save WAV path. Copy each
    // chunk's samples because the engine may reuse the source buffer.
    const captured: AudioBuffer[] = [];
    const captureChunk = saveWav
      ? (buf: AudioBuffer) => {
          captured.push({
            samples: new Float32Array(buf.samples),
            sampleRate: buf.sampleRate,
            channels: buf.channels,
            duration: buf.duration,
          });
        }
      : undefined;

    try {
      if (selectedEngine === TTSEngine.SUPERTONIC) {
        await Speech.speak(spokenText, selectedVoice || undefined, {
          speed,
          inferenceSteps,
          language: supertonicLanguage,
          onAudioChunk: captureChunk,
        });
      } else {
        await Speech.speak(spokenText, selectedVoice || undefined);
      }
    } finally {
      // Speech finished or was stopped — ensure we reset
      setIsStarted(false);
      setIsPaused(false);
      setHighlights([]);
      setCurrentChunk(null);
    }

    if (saveWav && captured.length > 0) {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `supertonic-${supertonicLanguage}-${selectedVoice || 'voice'}-${ts}.wav`;
        const result = await saveChunksAsWav(captured, filename);
        Alert.alert(
          'Saved WAV',
          `${result.path}\n\n${(result.bytes / 1024).toFixed(0)} KB · ${result.durationSec.toFixed(2)}s @ ${result.sampleRate} Hz`,
        );
      } catch (err) {
        Alert.alert(
          'Save failed',
          err instanceof Error ? err.message : 'Unknown error',
        );
      }
    }
  }, [
    selectedVoice,
    selectedEngine,
    speed,
    inferenceSteps,
    supertonicLanguage,
    spokenText,
    saveWav,
  ]);

  const onHighlightedPress = React.useCallback(
    ({text, start, end}: HighlightedSegmentArgs) =>
      Alert.alert('Highlighted', `"${text}" (${start}-${end})`),
    [],
  );

  // Download handlers
  const downloadKokoroModel = React.useCallback(
    async (variant: 'q8' | 'fp16' | 'full') => {
      try {
        setIsDownloading(true);
        setDownloadingItem(`kokoro-${variant}`);
        setDownloadProgress(0);

        await kokoroModelManager.downloadModel(variant, progress => {
          setDownloadProgress(progress.progress);
        });

        await loadInstalledModels();

        Alert.alert('Success', `Kokoro ${variant} model downloaded!`);

        // If Kokoro is selected, reinitialize
        if (selectedEngine === TTSEngine.KOKORO) {
          await initializeEngine(TTSEngine.KOKORO, providers);
        }
      } catch (err) {
        Alert.alert(
          'Error',
          `Download failed: ${err instanceof Error ? err.message : 'Unknown'}`,
        );
      } finally {
        setIsDownloading(false);
        setDownloadingItem(null);
        setDownloadProgress(0);
      }
    },
    [loadInstalledModels, selectedEngine, providers, initializeEngine],
  );

  const downloadSupertonicModel = React.useCallback(
    async (version: SupertonicVersion) => {
      try {
        setIsDownloading(true);
        setDownloadingItem(`supertonic-${version}`);
        setDownloadProgress(0);

        await supertonicModelManager.downloadModel(progress => {
          setDownloadProgress(progress.progress);
        }, version);

        supertonicModelManager.setActiveVersion(version);
        await loadInstalledModels();

        Alert.alert(
          'Success',
          `Supertonic ${version.toUpperCase()} downloaded!`,
        );

        // If Supertonic is selected, reinitialize
        if (selectedEngine === TTSEngine.SUPERTONIC) {
          await initializeEngine(TTSEngine.SUPERTONIC, providers);
        }
      } catch (err) {
        Alert.alert(
          'Error',
          `Download failed: ${err instanceof Error ? err.message : 'Unknown'}`,
        );
      } finally {
        setIsDownloading(false);
        setDownloadingItem(null);
        setDownloadProgress(0);
      }
    },
    [loadInstalledModels, selectedEngine, providers, initializeEngine],
  );

  const downloadKittenModel = React.useCallback(
    async (version: KittenVersion) => {
      try {
        setIsDownloading(true);
        setDownloadingItem(`kitten-${version}`);
        setDownloadProgress(0);

        await kittenModelManager.downloadModel(progress => {
          setDownloadProgress(progress.progress);
        }, version);

        kittenModelManager.setActiveVersion(version);
        await loadInstalledModels();

        Alert.alert('Success', `Kitten TTS ${version} downloaded!`);

        // If Kitten is selected, reinitialize
        if (selectedEngine === TTSEngine.KITTEN) {
          await initializeEngine(TTSEngine.KITTEN, providers);
        }
      } catch (err) {
        Alert.alert(
          'Error',
          `Download failed: ${err instanceof Error ? err.message : 'Unknown'}`,
        );
      } finally {
        setIsDownloading(false);
        setDownloadingItem(null);
        setDownloadProgress(0);
      }
    },
    [loadInstalledModels, selectedEngine, providers, initializeEngine],
  );

  const deleteModel = React.useCallback(
    async (
      type: 'kokoro' | 'supertonic' | 'kitten',
      version: string,
      variant: string,
    ) => {
      Alert.alert('Delete Model', 'Are you sure?', [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (type === 'kokoro') {
                await kokoroModelManager.deleteModel(
                  version,
                  variant as 'q8' | 'fp16' | 'full',
                );
              } else if (type === 'supertonic') {
                await supertonicModelManager.deleteModel(
                  variant as SupertonicVersion,
                );
              } else if (type === 'kitten') {
                await kittenModelManager.deleteModel(variant as KittenVersion);
              }
              await loadInstalledModels();
              Alert.alert('Deleted', 'Model removed.');
            } catch (err) {
              Alert.alert('Error', 'Failed to delete model.');
            }
          },
        },
      ]);
    },
    [loadInstalledModels],
  );

  const getVoiceDisplayName = (voice: any): string => {
    if (selectedEngine === TTSEngine.OS_NATIVE) {
      return `${voice.name} (${voice.language})`;
    }
    return `${voice.name} - ${voice.description || voice.id}`;
  };

  // ==================== RENDER ====================

  return (
    <SafeAreaView style={[gs.flex, gs.p10, styles.rootContainer]}>
      {/* ==================== MODEL MANAGER MODAL ==================== */}
      <Modal
        visible={showModelManager}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!isDownloading) setShowModelManager(false);
        }}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, themedStyles.bgCardSecondary]}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, themedStyles.textPrimary]}>
                Model Manager
              </Text>
              <TouchableOpacity
                onPress={() => !isDownloading && setShowModelManager(false)}
                disabled={isDownloading}
                style={styles.closeIcon}>
                <Text
                  style={[styles.closeIconText, themedStyles.textSecondary]}>
                  ×
                </Text>
              </TouchableOpacity>
            </View>

            {/* Tabs */}
            <View style={[styles.tabBar, themedStyles.bgCard]}>
              <TouchableOpacity
                style={[
                  styles.tab,
                  modelManagerTab === 'kokoro' && styles.tabActive,
                  modelManagerTab === 'kokoro' && themedStyles.bgCardSecondary,
                ]}
                onPress={() => setModelManagerTab('kokoro')}
                disabled={isDownloading}>
                <Text
                  style={[
                    styles.tabText,
                    modelManagerTab === 'kokoro'
                      ? themedStyles.textPrimary
                      : themedStyles.textSecondary,
                  ]}>
                  Kokoro
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.tab,
                  modelManagerTab === 'supertonic' && styles.tabActive,
                  modelManagerTab === 'supertonic' &&
                    themedStyles.bgCardSecondary,
                ]}
                onPress={() => setModelManagerTab('supertonic')}
                disabled={isDownloading}>
                <Text
                  style={[
                    styles.tabText,
                    modelManagerTab === 'supertonic'
                      ? themedStyles.textPrimary
                      : themedStyles.textSecondary,
                  ]}>
                  Supertonic
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.tab,
                  modelManagerTab === 'kitten' && styles.tabActive,
                  modelManagerTab === 'kitten' && themedStyles.bgCardSecondary,
                ]}
                onPress={() => setModelManagerTab('kitten')}
                disabled={isDownloading}>
                <Text
                  style={[
                    styles.tabText,
                    modelManagerTab === 'kitten'
                      ? themedStyles.textPrimary
                      : themedStyles.textSecondary,
                  ]}>
                  Kitten
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.modalBody}
              showsVerticalScrollIndicator={false}>
              {/* ====== KOKORO TAB ====== */}
              {modelManagerTab === 'kokoro' && (
                <View>
                  {/* Installed */}
                  <Text
                    style={[styles.sectionLabel, themedStyles.textSecondary]}>
                    INSTALLED
                  </Text>
                  {kokoroModels.length === 0 ? (
                    <Text
                      style={[styles.emptyText, themedStyles.textSecondary]}>
                      No models installed
                    </Text>
                  ) : (
                    kokoroModels.map((model, idx) => (
                      <View
                        key={idx}
                        style={[styles.modelCard, themedStyles.bgCard]}>
                        <View style={styles.modelCardInfo}>
                          <Text
                            style={[
                              styles.modelCardName,
                              themedStyles.textPrimary,
                            ]}>
                            Kokoro {model.variant?.toUpperCase() || 'Model'}
                          </Text>
                          <Text
                            style={[
                              styles.modelCardMeta,
                              themedStyles.textSecondary,
                            ]}>
                            {(model.size / 1024 / 1024).toFixed(0)} MB
                          </Text>
                        </View>
                        <TouchableOpacity
                          onPress={() =>
                            deleteModel(
                              'kokoro',
                              model.version,
                              model.variant || 'q8',
                            )
                          }
                          style={styles.deleteBtn}>
                          <Text style={styles.deleteBtnText}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    ))
                  )}

                  {/* Available */}
                  <Text
                    style={[
                      styles.sectionLabel,
                      themedStyles.textSecondary,
                      themedStyles.sectionLabelWithMargin,
                    ]}>
                    AVAILABLE DOWNLOADS
                  </Text>
                  {(Platform.OS === 'android'
                    ? [
                        {
                          variant: 'fp16',
                          size: '164 MB',
                          desc: 'Recommended',
                          color: '#007AFF',
                        },
                        {
                          variant: 'full',
                          size: '328 MB',
                          desc: 'Best quality',
                          color: '#FF9500',
                        },
                      ]
                    : [
                        {
                          variant: 'q8',
                          size: '82 MB',
                          desc: 'Recommended',
                          color: '#007AFF',
                        },
                        {
                          variant: 'fp16',
                          size: '164 MB',
                          desc: 'Higher quality',
                          color: '#34C759',
                        },
                        {
                          variant: 'full',
                          size: '328 MB',
                          desc: 'Best quality',
                          color: '#FF9500',
                        },
                      ]
                  ).map(item => {
                    const isInstalled = kokoroModels.some(
                      m => m.variant === item.variant,
                    );
                    const isThisDownloading =
                      downloadingItem === `kokoro-${item.variant}`;

                    return (
                      <TouchableOpacity
                        key={item.variant}
                        style={[
                          styles.downloadCard,
                          isInstalled
                            ? themedStyles.downloadCardInstalled
                            : {backgroundColor: item.color},
                          isDownloading && !isThisDownloading
                            ? themedStyles.opacityFaded
                            : themedStyles.opacityFull,
                        ]}
                        onPress={() =>
                          downloadKokoroModel(
                            item.variant as 'q8' | 'fp16' | 'full',
                          )
                        }
                        disabled={isInstalled || isDownloading}>
                        {isThisDownloading ? (
                          <View style={styles.downloadingState}>
                            <ActivityIndicator color="white" size="small" />
                            <Text style={styles.downloadingText}>
                              {Math.round(downloadProgress * 100)}%
                            </Text>
                            <View style={styles.progressBarContainer}>
                              <View
                                style={[
                                  styles.progressBarFill,
                                  {width: `${downloadProgress * 100}%`},
                                ]}
                              />
                            </View>
                          </View>
                        ) : (
                          <>
                            <View>
                              <Text
                                style={[
                                  styles.downloadCardTitle,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.textWhite,
                                ]}>
                                {isInstalled
                                  ? `${item.variant.toUpperCase()} Installed`
                                  : item.variant.toUpperCase()}
                              </Text>
                              <Text
                                style={[
                                  styles.downloadCardMeta,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.downloadMetaWhite,
                                ]}>
                                {item.size} • {item.desc}
                              </Text>
                            </View>
                            {!isInstalled && (
                              <Text style={styles.downloadIcon}>↓</Text>
                            )}
                          </>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {/* ====== SUPERTONIC TAB ====== */}
              {modelManagerTab === 'supertonic' && (
                <View>
                  {/* Installed */}
                  <Text
                    style={[styles.sectionLabel, themedStyles.textSecondary]}>
                    INSTALLED
                  </Text>
                  {supertonicModels.length === 0 ? (
                    <Text
                      style={[styles.emptyText, themedStyles.textSecondary]}>
                      No models installed
                    </Text>
                  ) : (
                    supertonicModels.map((model, idx) => {
                      const isActive =
                        supertonicModelManager.getActiveVersion() ===
                        model.variant;
                      return (
                        <View
                          key={idx}
                          style={[
                            styles.modelCard,
                            themedStyles.bgCard,
                            isActive && styles.modelCardActive,
                          ]}>
                          <View style={styles.modelCardInfo}>
                            <View style={styles.modelCardNameRow}>
                              <Text
                                style={[
                                  styles.modelCardName,
                                  themedStyles.textPrimary,
                                ]}>
                                Supertonic{' '}
                                {(model.variant || 'v1').toUpperCase()}
                              </Text>
                              {isActive && (
                                <View style={styles.activeBadge}>
                                  <Text style={styles.activeBadgeText}>
                                    ACTIVE
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text
                              style={[
                                styles.modelCardMeta,
                                themedStyles.textSecondary,
                              ]}>
                              {(model.size / 1024 / 1024).toFixed(0)} MB
                              {model.languages &&
                                ` • ${model.languages.join(', ').toUpperCase()}`}
                            </Text>
                          </View>
                          <View style={styles.modelCardActions}>
                            {!isActive && supertonicModels.length > 1 && (
                              <TouchableOpacity
                                onPress={() => {
                                  supertonicModelManager.setActiveVersion(
                                    model.variant,
                                  );
                                  loadInstalledModels();
                                  if (selectedEngine === TTSEngine.SUPERTONIC) {
                                    initializeEngine(
                                      TTSEngine.SUPERTONIC,
                                      providers,
                                    );
                                  }
                                }}
                                style={styles.useBtn}>
                                <Text style={styles.useBtnText}>Use</Text>
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity
                              onPress={() =>
                                deleteModel(
                                  'supertonic',
                                  model.version,
                                  model.variant || 'v1',
                                )
                              }
                              style={styles.deleteBtn}>
                              <Text style={styles.deleteBtnText}>Delete</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })
                  )}

                  {/* Available */}
                  <Text
                    style={[
                      styles.sectionLabel,
                      themedStyles.textSecondary,
                      themedStyles.sectionLabelWithMargin,
                    ]}>
                    AVAILABLE DOWNLOADS
                  </Text>
                  {supertonicModelManager.getAvailableVersions().map(item => {
                    const isInstalled = supertonicModels.some(
                      m => m.variant === item.version,
                    );
                    const isThisDownloading =
                      downloadingItem === `supertonic-${item.version}`;

                    return (
                      <TouchableOpacity
                        key={item.version}
                        style={[
                          styles.downloadCard,
                          isInstalled
                            ? themedStyles.downloadCardInstalled
                            : item.version === 'v2'
                              ? themedStyles.downloadCardGreen
                              : themedStyles.downloadCardBlue,
                          isDownloading && !isThisDownloading
                            ? themedStyles.opacityFaded
                            : themedStyles.opacityFull,
                        ]}
                        onPress={() => downloadSupertonicModel(item.version)}
                        disabled={isInstalled || isDownloading}>
                        {isThisDownloading ? (
                          <View style={styles.downloadingState}>
                            <ActivityIndicator color="white" size="small" />
                            <Text style={styles.downloadingText}>
                              {Math.round(downloadProgress * 100)}%
                            </Text>
                            <View style={styles.progressBarContainer}>
                              <View
                                style={[
                                  styles.progressBarFill,
                                  {width: `${downloadProgress * 100}%`},
                                ]}
                              />
                            </View>
                          </View>
                        ) : (
                          <>
                            <View style={styles.downloadCardContent}>
                              <Text
                                style={[
                                  styles.downloadCardTitle,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.textWhite,
                                ]}>
                                {isInstalled
                                  ? `${item.version.toUpperCase()} Installed`
                                  : item.version.toUpperCase()}
                              </Text>
                              <Text
                                style={[
                                  styles.downloadCardMeta,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.downloadMetaWhite,
                                ]}>
                                {Math.round(item.estimatedSize / 1024 / 1024)}{' '}
                                MB • {item.description}
                              </Text>
                              <Text
                                style={[
                                  styles.downloadCardLangs,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.downloadLangsWhite,
                                ]}>
                                Languages:{' '}
                                {item.languages.join(', ').toUpperCase()}
                              </Text>
                            </View>
                            {!isInstalled && (
                              <Text style={styles.downloadIcon}>↓</Text>
                            )}
                          </>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {/* ====== KITTEN TAB ====== */}
              {modelManagerTab === 'kitten' && (
                <View>
                  {/* Installed */}
                  <Text
                    style={[styles.sectionLabel, themedStyles.textSecondary]}>
                    INSTALLED
                  </Text>
                  {kittenModels.length === 0 ? (
                    <Text
                      style={[styles.emptyText, themedStyles.textSecondary]}>
                      No models installed
                    </Text>
                  ) : (
                    kittenModels.map((model, idx) => {
                      const isActive =
                        kittenModelManager.getActiveVersion() === model.variant;
                      return (
                        <View
                          key={idx}
                          style={[
                            styles.modelCard,
                            themedStyles.bgCard,
                            isActive && styles.modelCardActive,
                          ]}>
                          <View style={styles.modelCardInfo}>
                            <View style={styles.modelCardNameRow}>
                              <Text
                                style={[
                                  styles.modelCardName,
                                  themedStyles.textPrimary,
                                ]}>
                                Kitten {model.variant}
                              </Text>
                              {isActive && (
                                <View style={styles.activeBadge}>
                                  <Text style={styles.activeBadgeText}>
                                    ACTIVE
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text
                              style={[
                                styles.modelCardMeta,
                                themedStyles.textSecondary,
                              ]}>
                              {(model.size / 1024 / 1024).toFixed(0)} MB
                              {' • EN • StyleTTS 2'}
                            </Text>
                          </View>
                          <View style={styles.modelCardActions}>
                            {!isActive && kittenModels.length > 1 && (
                              <TouchableOpacity
                                onPress={() => {
                                  kittenModelManager.setActiveVersion(
                                    model.variant,
                                  );
                                  loadInstalledModels();
                                  if (selectedEngine === TTSEngine.KITTEN) {
                                    initializeEngine(
                                      TTSEngine.KITTEN,
                                      providers,
                                    );
                                  }
                                }}
                                style={styles.useBtn}>
                                <Text style={styles.useBtnText}>Use</Text>
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity
                              onPress={() =>
                                deleteModel(
                                  'kitten',
                                  model.version,
                                  model.variant,
                                )
                              }
                              style={styles.deleteBtn}>
                              <Text style={styles.deleteBtnText}>Delete</Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      );
                    })
                  )}

                  {/* Available */}
                  <Text
                    style={[
                      styles.sectionLabel,
                      themedStyles.textSecondary,
                      themedStyles.sectionLabelWithMargin,
                    ]}>
                    AVAILABLE DOWNLOADS
                  </Text>
                  {kittenModelManager.getAvailableVersions().map(item => {
                    const isInstalled = kittenModels.some(
                      m => m.variant === item.version,
                    );
                    const isThisDownloading =
                      downloadingItem === `kitten-${item.version}`;

                    return (
                      <TouchableOpacity
                        key={item.version}
                        style={[
                          styles.downloadCard,
                          isInstalled
                            ? themedStyles.downloadCardInstalled
                            : themedStyles.downloadCardBlue,
                          isDownloading && !isThisDownloading
                            ? themedStyles.opacityFaded
                            : themedStyles.opacityFull,
                        ]}
                        onPress={() => downloadKittenModel(item.version)}
                        disabled={isInstalled || isDownloading}>
                        {isThisDownloading ? (
                          <View style={styles.downloadingState}>
                            <ActivityIndicator color="white" size="small" />
                            <Text style={styles.downloadingText}>
                              {Math.round(downloadProgress * 100)}%
                            </Text>
                            <View style={styles.progressBarContainer}>
                              <View
                                style={[
                                  styles.progressBarFill,
                                  {width: `${downloadProgress * 100}%`},
                                ]}
                              />
                            </View>
                          </View>
                        ) : (
                          <>
                            <View style={styles.downloadCardContent}>
                              <Text
                                style={[
                                  styles.downloadCardTitle,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.textWhite,
                                ]}>
                                {isInstalled
                                  ? `${item.version} Installed`
                                  : item.version}
                              </Text>
                              <Text
                                style={[
                                  styles.downloadCardMeta,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.downloadMetaWhite,
                                ]}>
                                {Math.round(item.estimatedSize / 1024 / 1024)}{' '}
                                MB • {item.description}
                              </Text>
                              <Text
                                style={[
                                  styles.downloadCardLangs,
                                  isInstalled
                                    ? themedStyles.downloadTextInstalled
                                    : themedStyles.downloadLangsWhite,
                                ]}>
                                EN • 8 voices • {item.quantization}
                              </Text>
                            </View>
                            {!isInstalled && (
                              <Text style={styles.downloadIcon}>↓</Text>
                            )}
                          </>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ==================== VOICE PICKER MODAL ==================== */}
      <Modal
        visible={showVoicePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowVoicePicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, themedStyles.bgCardSecondary]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, themedStyles.textPrimary]}>
                Select Voice
              </Text>
              <TouchableOpacity
                onPress={() => setShowVoicePicker(false)}
                style={styles.closeIcon}>
                <Text
                  style={[styles.closeIconText, themedStyles.textSecondary]}>
                  ×
                </Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.voiceList}>
              {availableVoices.map(voice => {
                const voiceId = voice.id;
                const isVoiceSelected = selectedVoice === voiceId;
                return (
                  <Pressable
                    key={voiceId}
                    style={[
                      styles.voiceItem,
                      isVoiceSelected
                        ? themedStyles.voiceItemSelected
                        : themedStyles.voiceItemUnselected,
                    ]}
                    onPress={() => {
                      setSelectedVoice(voiceId);
                      setShowVoicePicker(false);
                    }}>
                    <Text style={[styles.voiceName, themedStyles.textPrimary]}>
                      {getVoiceDisplayName(voice)}
                    </Text>
                    {isVoiceSelected && <Text style={styles.checkmark}>✓</Text>}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ==================== SETTING PICKER MODAL ====================
          Single modal services the Speed / Quality / Lang dropdowns —
          which one is open is keyed by `openPicker`. */}
      <Modal
        visible={openPicker !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setOpenPicker(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, themedStyles.bgCardSecondary]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, themedStyles.textPrimary]}>
                {openPicker === 'speed'
                  ? 'Speed'
                  : openPicker === 'quality'
                    ? 'Quality (diffusion steps)'
                    : openPicker === 'language'
                      ? 'Language'
                      : ''}
              </Text>
              <TouchableOpacity
                onPress={() => setOpenPicker(null)}
                style={styles.closeIcon}>
                <Text
                  style={[styles.closeIconText, themedStyles.textSecondary]}>
                  ×
                </Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.voiceList}>
              {(() => {
                if (openPicker === 'speed') {
                  return [1.0, 1.25, 1.5, 1.75, 2.0].map(s => {
                    const isSel = speed === s;
                    return (
                      <Pressable
                        key={s}
                        style={[
                          styles.voiceItem,
                          isSel
                            ? themedStyles.voiceItemSelected
                            : themedStyles.voiceItemUnselected,
                        ]}
                        onPress={() => {
                          setSpeed(s);
                          setOpenPicker(null);
                        }}>
                        <Text
                          style={[styles.voiceName, themedStyles.textPrimary]}>
                          {s.toFixed(2)}x
                        </Text>
                        {isSel && <Text style={styles.checkmark}>✓</Text>}
                      </Pressable>
                    );
                  });
                }
                if (openPicker === 'quality') {
                  return [2, 3, 5, 8, 12, 16].map(steps => {
                    const isSel = inferenceSteps === steps;
                    return (
                      <Pressable
                        key={steps}
                        style={[
                          styles.voiceItem,
                          isSel
                            ? themedStyles.voiceItemSelected
                            : themedStyles.voiceItemUnselected,
                        ]}
                        onPress={() => {
                          setInferenceSteps(steps);
                          setOpenPicker(null);
                        }}>
                        <Text
                          style={[styles.voiceName, themedStyles.textPrimary]}>
                          {steps} steps
                        </Text>
                        {isSel && <Text style={styles.checkmark}>✓</Text>}
                      </Pressable>
                    );
                  });
                }
                if (openPicker === 'language') {
                  return supertonicModelManager
                    .getSupportedLanguages()
                    .map(lang => {
                      const isSel = supertonicLanguage === lang;
                      return (
                        <Pressable
                          key={lang}
                          style={[
                            styles.voiceItem,
                            isSel
                              ? themedStyles.voiceItemSelected
                              : themedStyles.voiceItemUnselected,
                          ]}
                          onPress={() => {
                            setSupertonicLanguage(lang);
                            setOpenPicker(null);
                          }}>
                          <Text
                            style={[
                              styles.voiceName,
                              themedStyles.textPrimary,
                            ]}>
                            {lang.toUpperCase()}
                          </Text>
                          {isSel && <Text style={styles.checkmark}>✓</Text>}
                        </Pressable>
                      );
                    });
                }
                return null;
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Scrollable settings + content. The Run/Kill control bar stays
          pinned below — keep it always-tappable. flexGrow:1 lets the
          spoken-text area still expand to fill on tall screens. */}
      <ScrollView
        style={gs.flex}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled">
        {/* ==================== ENGINE SELECTOR ==================== */}
        <View style={[styles.engineSelector, themedStyles.bgCard]}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, themedStyles.textPrimary]}>
              ENGINE_SELECT
            </Text>
            {/* Only show Manage Models for neural engines */}
            {selectedEngine !== TTSEngine.OS_NATIVE && (
              <TouchableOpacity
                style={styles.manageBtn}
                onPress={() => {
                  if (selectedEngine === TTSEngine.KOKORO) {
                    setModelManagerTab('kokoro');
                  } else if (selectedEngine === TTSEngine.SUPERTONIC) {
                    setModelManagerTab('supertonic');
                  } else if (selectedEngine === TTSEngine.KITTEN) {
                    setModelManagerTab('kitten');
                  }
                  setShowModelManager(true);
                }}>
                <Text style={styles.manageBtnText}>Manage Models</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.engineButtons}>
            {[
              {engine: TTSEngine.KITTEN, label: 'Kitten'},
              {engine: TTSEngine.KOKORO, label: 'Kokoro'},
              {engine: TTSEngine.SUPERTONIC, label: 'Supertonic'},
              {engine: TTSEngine.OS_NATIVE, label: 'System'},
            ].map(item => {
              const isEngineSelected = selectedEngine === item.engine;
              return (
                <TouchableOpacity
                  key={item.engine}
                  style={[
                    styles.engineBtn,
                    isEngineSelected
                      ? themedStyles.btnSelected
                      : themedStyles.btnUnselected,
                  ]}
                  onPress={() => setSelectedEngine(item.engine)}
                  disabled={isInitializing || isStarted}>
                  <Text
                    style={[
                      styles.engineBtnText,
                      isEngineSelected
                        ? themedStyles.textWhite
                        : themedStyles.textPrimary,
                    ]}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Status + Load/Unload */}
          <View style={styles.statusRow}>
            {isInitializing || isReleasing ? (
              <View style={styles.statusLoading}>
                <ActivityIndicator size="small" color={C.cyan} />
                <Text style={[styles.statusText, themedStyles.textSecondary]}>
                  {isReleasing
                    ? '> releasing resources...'
                    : '> loading model...'}
                </Text>
              </View>
            ) : (
              <Text
                style={[
                  styles.statusText,
                  engineReady
                    ? themedStyles.statusReady
                    : themedStyles.statusNotReady,
                ]}>
                {engineReady ? '[ONLINE]' : '[OFFLINE]'}
              </Text>
            )}

            {/* Load/Unload for neural engines */}
            {selectedEngine !== TTSEngine.OS_NATIVE && (
              <View style={styles.loadUnloadButtons}>
                {engineReady ? (
                  <TouchableOpacity
                    style={styles.unloadBtn}
                    onPress={onUnloadPress}
                    disabled={isStarted || isReleasing || isInitializing}>
                    <Text style={styles.unloadBtnText}>RELEASE</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.loadBtn}
                    onPress={onReloadPress}
                    disabled={isInitializing || isReleasing}>
                    <Text style={styles.loadBtnText}>INIT</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>

          {/* Acceleration (neural only) */}
          {selectedEngine !== TTSEngine.OS_NATIVE && (
            <View style={styles.accelerationSection}>
              <View style={styles.accelHeaderRow}>
                <Text style={[styles.fieldLabel, themedStyles.textSecondary]}>
                  Acceleration providers
                </Text>
                <Text
                  style={[styles.accelOrderText, themedStyles.textSecondary]}>
                  CPU is always the last fallback
                </Text>
              </View>
              <View style={styles.accelerationButtons}>
                {(Platform.OS === 'ios'
                  ? [
                      {key: 'coreml' as const, label: 'CoreML'},
                      {key: 'xnnpack' as const, label: 'XNNPACK'},
                    ]
                  : [{key: 'xnnpack' as const, label: 'XNNPACK'}]
                ).map(item => {
                  const isOn = accel.selected.has(item.key);
                  return (
                    <TouchableOpacity
                      key={item.key}
                      style={[
                        styles.accelBtn,
                        isOn
                          ? themedStyles.btnSelected
                          : themedStyles.btnUnselected,
                      ]}
                      onPress={() => {
                        const next = new Set(accel.selected);
                        if (isOn) {
                          next.delete(item.key);
                        } else {
                          next.add(item.key);
                        }
                        setAccel({...accel, selected: next});
                      }}
                      disabled={isInitializing || isStarted}>
                      <Text
                        style={[
                          styles.accelBtnText,
                          isOn
                            ? themedStyles.textWhite
                            : themedStyles.textPrimary,
                        ]}>
                        {isOn ? '☑ ' : '☐ '}
                        {item.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {Platform.OS === 'android' && (
                <Text
                  style={[styles.accelHelpText, themedStyles.textSecondary]}>
                  NNAPI was dropped — Android's Neural Networks API was
                  deprecated in Android 15.
                </Text>
              )}

              {/* CoreML flag sub-options (iOS + CoreML selected) */}
              {Platform.OS === 'ios' && accel.selected.has('coreml') && (
                <View style={styles.accelDetailsBlock}>
                  <TouchableOpacity
                    onPress={() => setShowAccelDetails(s => !s)}
                    disabled={isInitializing || isStarted}>
                    <Text
                      style={[
                        styles.accelDetailsToggle,
                        themedStyles.textSecondary,
                      ]}>
                      {showAccelDetails ? '▼' : '▶'} CoreML flags
                    </Text>
                  </TouchableOpacity>
                  {showAccelDetails && (
                    <View style={styles.accelDetails}>
                      {COREML_FLAG_OPTIONS.map(opt => {
                        // eslint-disable-next-line no-bitwise
                        const isOn = (accel.coreMlFlags & opt.flag) !== 0;
                        return (
                          <TouchableOpacity
                            key={opt.flag}
                            style={styles.accelFlagRow}
                            onPress={() =>
                              setAccel({
                                ...accel,
                                coreMlFlags: isOn
                                  ? // eslint-disable-next-line no-bitwise
                                    accel.coreMlFlags & ~opt.flag
                                  : // eslint-disable-next-line no-bitwise
                                    accel.coreMlFlags | opt.flag,
                              })
                            }
                            disabled={isInitializing || isStarted}>
                            <Text
                              style={[
                                styles.accelFlagLabel,
                                themedStyles.textPrimary,
                              ]}>
                              {isOn ? '☑ ' : '☐ '}
                              {opt.label}
                            </Text>
                            <Text
                              style={[
                                styles.accelFlagHint,
                                themedStyles.textSecondary,
                              ]}>
                              {opt.hint}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
            </View>
          )}

          {/* Voice selector */}
          {engineReady && (
            <View style={styles.voiceSection}>
              <Text style={[styles.fieldLabel, themedStyles.textSecondary]}>
                Voice
              </Text>
              <TouchableOpacity
                style={[styles.voiceSelector, themedStyles.bgInput]}
                onPress={() => setShowVoicePicker(true)}
                disabled={availableVoices.length === 0}>
                <Text
                  style={[styles.voiceSelectorText, themedStyles.textPrimary]}
                  numberOfLines={1}>
                  {selectedVoice
                    ? availableVoices.find(v => v.id === selectedVoice)?.name ||
                      'Select'
                    : 'Select Voice'}
                </Text>
                <Text
                  style={[styles.dropdownArrow, themedStyles.textSecondary]}>
                  ▼
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Supertonic controls — compact pill row. Each pill opens a
            modal picker (Speed / Quality / Lang) or toggles (Save WAV).
            Lang pill is hidden when the active model has only 1 language. */}
          {engineReady && selectedEngine === TTSEngine.SUPERTONIC && (
            <View style={styles.supertonicRow}>
              <TouchableOpacity
                style={[styles.settingPill, themedStyles.bgCard]}
                onPress={() => setOpenPicker('speed')}
                disabled={isStarted}>
                <Text
                  style={[styles.settingPillLabel, themedStyles.textSecondary]}>
                  Speed
                </Text>
                <Text
                  style={[styles.settingPillValue, themedStyles.textPrimary]}>
                  {speed.toFixed(2)}x ▾
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.settingPill, themedStyles.bgCard]}
                onPress={() => setOpenPicker('quality')}
                disabled={isStarted}>
                <Text
                  style={[styles.settingPillLabel, themedStyles.textSecondary]}>
                  Quality
                </Text>
                <Text
                  style={[styles.settingPillValue, themedStyles.textPrimary]}>
                  {inferenceSteps} steps ▾
                </Text>
              </TouchableOpacity>

              {supertonicModelManager.getSupportedLanguages().length > 1 && (
                <TouchableOpacity
                  style={[styles.settingPill, themedStyles.bgCard]}
                  onPress={() => setOpenPicker('language')}
                  disabled={isStarted}>
                  <Text
                    style={[
                      styles.settingPillLabel,
                      themedStyles.textSecondary,
                    ]}>
                    Lang
                  </Text>
                  <Text
                    style={[styles.settingPillValue, themedStyles.textPrimary]}>
                    {supertonicLanguage.toUpperCase()} ▾
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[
                  styles.settingPill,
                  saveWav ? themedStyles.btnSelectedGreen : themedStyles.bgCard,
                ]}
                onPress={() => setSaveWav(v => !v)}
                disabled={isStarted}>
                <Text
                  style={[
                    styles.settingPillLabel,
                    saveWav
                      ? themedStyles.textWhite
                      : themedStyles.textSecondary,
                  ]}>
                  Save WAV
                </Text>
                <Text
                  style={[
                    styles.settingPillValue,
                    saveWav ? themedStyles.textWhite : themedStyles.textPrimary,
                  ]}>
                  {saveWav ? 'ON' : 'OFF'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Chunk Progress — always mounted to avoid layout shift */}
        <View style={styles.chunkProgress}>
          {currentChunk && isStarted ? (
            <Text style={[styles.chunkLabel, themedStyles.textSecondary]}>
              CHUNK [{currentChunk.chunkIndex + 1}/{currentChunk.totalChunks}]{' '}
              <Text style={themedStyles.statusAccent}>
                {currentChunk.progress}%
              </Text>
            </Text>
          ) : null}
        </View>

        {/* Main Content */}
        <View style={gs.flex}>
          <HighlightedText
            text={spokenText}
            highlights={highlights}
            highlightedStyle={styles.highlighted}
            onHighlightedPress={onHighlightedPress}
            style={[gs.paragraph, themedStyles.textPrimary]}
          />
        </View>
      </ScrollView>

      {/* Controls */}
      <View style={styles.controlBar}>
        <Button
          label="RUN"
          variant="success"
          disabled={isStarted || !engineReady || isInitializing}
          onPress={onStartPress}
        />
        <Button
          label="KILL"
          variant="danger"
          disabled={!isStarted}
          onPress={Speech.stop}
        />
        {!isAndroidLowerThan26 && (
          <>
            <Button
              label="HOLD"
              variant="secondary"
              onPress={Speech.pause}
              disabled={isPaused || !isStarted}
            />
            <Button
              label="CONT"
              variant="secondary"
              disabled={!isPaused}
              onPress={Speech.resume}
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
};

export default RootView;

const styles = StyleSheet.create({
  highlighted: {
    fontWeight: '600',
    backgroundColor: C.cyanGhost,
    color: C.cyan,
  },
  textInput: {
    minHeight: 120,
    borderRadius: 4,
    padding: 14,
    textAlignVertical: 'top',
    fontSize: 14,
    lineHeight: 22,
    fontFamily: MONO,
    borderWidth: 1,
    borderColor: C.greenBorder,
    color: C.green,
  },
  controlBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 4,
    paddingVertical: 12,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    maxHeight: '75%',
    borderTopWidth: 1,
    borderTopColor: C.greenFaint,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128, 128, 128, 0.3)',
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 1.5,
    color: C.green,
  },
  closeIcon: {
    padding: 4,
  },
  modalBody: {
    padding: 16,
  },
  // Tabs
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 8,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  tabActive: {},
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // Sections
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 20,
  },
  // Model Cards
  modelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  modelCardActive: {
    borderWidth: 2,
    borderColor: '#34C759',
  },
  modelCardInfo: {
    flex: 1,
  },
  modelCardNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modelCardName: {
    fontSize: 16,
    fontWeight: '600',
  },
  modelCardMeta: {
    fontSize: 13,
    marginTop: 2,
  },
  modelCardActions: {
    flexDirection: 'row',
    gap: 8,
  },
  activeBadge: {
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  activeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#34C759',
  },
  useBtn: {
    backgroundColor: C.cyanGhost,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.cyanBorder,
  },
  useBtnText: {
    color: C.cyan,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
  },
  deleteBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  deleteBtnText: {
    color: C.red,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
  },
  // Download Cards
  downloadCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 10,
    marginBottom: 10,
  },
  downloadCardTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  downloadCardMeta: {
    fontSize: 13,
    marginTop: 2,
  },
  downloadCardLangs: {
    fontSize: 12,
    marginTop: 2,
  },
  downloadIcon: {
    fontSize: 20,
    color: 'white',
    fontWeight: '700',
    marginLeft: 12,
  },
  downloadingState: {
    flex: 1,
    alignItems: 'center',
  },
  downloadingText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 6,
  },
  progressBarContainer: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    marginTop: 8,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: 'white',
  },
  // Voice Picker
  voiceList: {
    maxHeight: 400,
    padding: 16,
  },
  voiceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginBottom: 6,
  },
  voiceName: {
    fontSize: 15,
    flex: 1,
  },
  checkmark: {
    fontSize: 14,
    color: C.green,
    fontWeight: '700',
    fontFamily: MONO,
  },
  // Engine Selector
  engineSelector: {
    borderRadius: 4,
    padding: 16,
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 1.5,
  },
  manageBtn: {
    backgroundColor: C.cyanGhost,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.cyanBorder,
  },
  manageBtnText: {
    color: C.cyan,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
  engineButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  engineBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 2,
    borderRadius: 4,
    alignItems: 'center',
  },
  engineBtnText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
  },
  statusRow: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 1,
  },
  loadUnloadButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  unloadBtn: {
    backgroundColor: C.amberGhost,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.amberBorder,
  },
  unloadBtnText: {
    color: C.amber,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
  },
  loadBtn: {
    backgroundColor: C.greenGhost,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.greenBorder,
  },
  loadBtnText: {
    color: C.green,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
  },
  // Acceleration
  accelerationSection: {
    marginTop: 14,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 1,
    marginBottom: 6,
    color: C.muted,
  },
  accelerationButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  accelBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  accelBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  accelHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  accelOrderText: {
    fontSize: 9,
    fontFamily: MONO,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  accelHelpText: {
    fontSize: 10,
    fontFamily: MONO,
    marginTop: 6,
    fontStyle: 'italic',
  },
  accelDetailsBlock: {
    marginTop: 10,
  },
  accelDetailsToggle: {
    fontSize: 10,
    fontFamily: MONO,
    fontWeight: '700',
    letterSpacing: 1,
    paddingVertical: 4,
  },
  accelDetails: {
    marginTop: 4,
    paddingLeft: 6,
    borderLeftWidth: 2,
    borderLeftColor: C.muted,
  },
  accelFlagRow: {
    paddingVertical: 4,
  },
  accelFlagLabel: {
    fontSize: 12,
    fontFamily: MONO,
    fontWeight: '600',
  },
  accelFlagHint: {
    fontSize: 10,
    fontFamily: MONO,
    marginLeft: 18,
    marginTop: 1,
  },
  // Voice Section
  voiceSection: {
    marginTop: 14,
  },
  voiceSelector: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  voiceSelectorText: {
    fontSize: 14,
    flex: 1,
  },
  // Supertonic Controls
  // ScrollView around settings + content — keeps Run/Kill pinned.
  scrollContent: {
    flexGrow: 1,
  },
  supertonicRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  settingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  settingPillLabel: {
    fontSize: 11,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  settingPillValue: {
    fontSize: 13,
    fontWeight: '600',
  },
  // Chunk Progress
  chunkProgress: {
    height: 24,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  chunkHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  chunkLabel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
  chunkPercent: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
  },
  chunkBarBg: {
    height: 2,
    backgroundColor: C.greenGhost,
    overflow: 'hidden',
  },
  chunkBarFill: {
    height: '100%',
    backgroundColor: C.cyan,
  },
  rootContainer: {
    backgroundColor: C.bg,
  },
  visible: {
    display: 'flex' as const,
    flex: 1,
  },
  hidden: {
    display: 'none' as const,
  },
  terminalBlock: {
    flexDirection: 'row',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  terminalText: {
    fontSize: 11,
    fontFamily: MONO,
    color: C.greenDim,
    lineHeight: 18,
  },
  terminalCursor: {
    fontSize: 11,
    fontFamily: MONO,
    color: C.cyan,
    fontWeight: '700',
  },
  // Common
  closeIconText: {
    fontSize: 24,
  },
  dropdownArrow: {
    fontSize: 14,
  },
  downloadCardContent: {
    flex: 1,
  },
});
