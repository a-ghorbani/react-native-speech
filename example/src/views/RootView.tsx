import React from 'react';
import {gs} from '../styles/gs';
import {
  Text,
  View,
  Alert,
  AppState,
  Platform,
  StyleSheet,
  useColorScheme,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  ScrollView,
  Pressable,
  TextInput,
} from 'react-native';
import type {AppStateStatus} from 'react-native';
import Speech, {
  HighlightedText,
  type HighlightedSegmentArgs,
  type HighlightedSegmentProps,
  type ChunkProgressEvent,
  type ExecutionProviderPreset,
  TTSEngine,
} from '@pocketpalai/react-native-speech';
import Button from '../components/Button';
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

const isAndroidLowerThan26 = Platform.OS === 'android' && Platform.Version < 26;

const DEFAULT_TEXT =
  'Welcome! This is a quick demo of on-device neural text-to-speech. ' +
  'Everything you hear is synthesized locally — no internet, no cloud ' +
  'API, just the model running on your phone. Try editing this text, ' +
  'or switch voices above to hear the difference.';

// Model Manager Tab Type
type ModelTab = 'kokoro' | 'supertonic' | 'kitten';

const RootView: React.FC = () => {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const textColor = isDark ? '#FFFFFF' : '#000000';
  const secondaryTextColor = isDark ? '#8E8E93' : '#6D6D72';
  const cardBg = isDark ? '#1C1C1E' : '#F2F2F7';
  const cardBgSecondary = isDark ? '#2C2C2E' : '#FFFFFF';
  const inputBg = isDark ? '#3A3A3C' : '#E5E5EA';

  // Memoized theme-dependent styles to avoid inline styles
  const themedStyles = React.useMemo(
    () =>
      StyleSheet.create({
        // Text colors
        textPrimary: {color: textColor},
        textSecondary: {color: secondaryTextColor},
        textWhite: {color: 'white'},
        // Backgrounds
        bgCard: {backgroundColor: cardBg},
        bgCardSecondary: {backgroundColor: cardBgSecondary},
        bgInput: {backgroundColor: inputBg},
        bgChunkProgress: {backgroundColor: 'rgba(0, 122, 255, 0.1)'},
        // Button states
        btnSelected: {backgroundColor: '#007AFF'},
        btnUnselected: {backgroundColor: inputBg},
        btnSelectedGreen: {backgroundColor: '#34C759'},
        // Status colors
        statusReady: {color: '#34C759'},
        statusNotReady: {color: '#FF3B30'},
        statusAccent: {color: '#007AFF'},
        // Voice item
        voiceItemSelected: {backgroundColor: isDark ? '#3A3A3C' : '#E8F4FD'},
        voiceItemUnselected: {backgroundColor: 'transparent'},
        // Download card colors
        downloadTextInstalled: {color: secondaryTextColor},
        downloadTextWhite: {color: 'white'},
        downloadMetaWhite: {color: 'rgba(255,255,255,0.8)'},
        downloadLangsWhite: {color: 'rgba(255,255,255,0.7)'},
        // Opacity
        opacityFaded: {opacity: 0.5},
        opacityFull: {opacity: 1},
        // Section label with margin
        sectionLabelWithMargin: {marginTop: 20},
        // Download card variants
        downloadCardBlue: {backgroundColor: '#007AFF'},
        downloadCardGreen: {backgroundColor: '#34C759'},
        downloadCardOrange: {backgroundColor: '#FF9500'},
        downloadCardInstalled: {backgroundColor: cardBg},
      }),
    [textColor, secondaryTextColor, cardBg, cardBgSecondary, inputBg, isDark],
  );
  console.log('just testing rerender');

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

  // Execution provider selection for hardware acceleration
  const [selectedProvider, setSelectedProvider] =
    React.useState<ExecutionProviderPreset>('auto');

  // Model release state
  const [isReleasing, setIsReleasing] = React.useState<boolean>(false);

  // Chunk progress for neural engines
  const [currentChunk, setCurrentChunk] =
    React.useState<ChunkProgressEvent | null>(null);

  // Supertonic synthesis options
  const [speed, setSpeed] = React.useState<number>(1.0);
  const [inferenceSteps, setInferenceSteps] = React.useState<number>(5);

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
    async (engine: TTSEngine, provider: ExecutionProviderPreset = 'auto') => {
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
    initializeEngine(selectedEngine, selectedProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEngine, selectedProvider]);

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
    initializeEngine(selectedEngine, selectedProvider);
  }, [initializeEngine, selectedEngine, selectedProvider]);

  const onStartPress = React.useCallback(async () => {
    // Set started immediately so Stop is available during synthesis
    // (neural engines take time to synthesize the first chunk before audio starts)
    setIsStarted(true);
    try {
      if (selectedEngine === TTSEngine.SUPERTONIC) {
        await Speech.speak(spokenText, selectedVoice || undefined, {
          speed,
          inferenceSteps,
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
  }, [selectedVoice, selectedEngine, speed, inferenceSteps, spokenText]);

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
          await initializeEngine(TTSEngine.KOKORO, selectedProvider);
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
    [loadInstalledModels, selectedEngine, selectedProvider, initializeEngine],
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
          await initializeEngine(TTSEngine.SUPERTONIC, selectedProvider);
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
    [loadInstalledModels, selectedEngine, selectedProvider, initializeEngine],
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
          await initializeEngine(TTSEngine.KITTEN, selectedProvider);
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
    [loadInstalledModels, selectedEngine, selectedProvider, initializeEngine],
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
    <SafeAreaView style={[gs.flex, gs.p10]}>
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
                  {[
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
                  ].map(item => {
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
                                      selectedProvider,
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
                                      selectedProvider,
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

      {/* ==================== ENGINE SELECTOR ==================== */}
      <View style={[styles.engineSelector, themedStyles.bgCard]}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, themedStyles.textPrimary]}>
            Engine
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
              <ActivityIndicator size="small" color="#007AFF" />
              <Text style={[styles.statusText, themedStyles.textSecondary]}>
                {isReleasing ? 'Releasing...' : 'Initializing...'}
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
              {engineReady ? '● Ready' : '● Not Ready'}
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
                  <Text style={styles.unloadBtnText}>Unload</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.loadBtn}
                  onPress={onReloadPress}
                  disabled={isInitializing || isReleasing}>
                  <Text style={styles.loadBtnText}>Load</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        {/* Acceleration (neural only) */}
        {selectedEngine !== TTSEngine.OS_NATIVE && (
          <View style={styles.accelerationSection}>
            <Text style={[styles.fieldLabel, themedStyles.textSecondary]}>
              Acceleration
            </Text>
            <View style={styles.accelerationButtons}>
              {[
                {key: 'auto', label: 'Auto'},
                {key: 'gpu', label: Platform.OS === 'ios' ? 'Metal' : 'GPU'},
                {key: 'cpu', label: 'CPU'},
              ].map(item => {
                const isProviderSelected = selectedProvider === item.key;
                return (
                  <TouchableOpacity
                    key={item.key}
                    style={[
                      styles.accelBtn,
                      isProviderSelected
                        ? themedStyles.btnSelected
                        : themedStyles.btnUnselected,
                    ]}
                    onPress={() =>
                      setSelectedProvider(item.key as ExecutionProviderPreset)
                    }
                    disabled={isInitializing || isStarted}>
                    <Text
                      style={[
                        styles.accelBtnText,
                        isProviderSelected
                          ? themedStyles.textWhite
                          : themedStyles.textPrimary,
                      ]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
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
              <Text style={[styles.dropdownArrow, themedStyles.textSecondary]}>
                ▼
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Supertonic controls */}
        {engineReady && selectedEngine === TTSEngine.SUPERTONIC && (
          <View style={styles.supertonicControls}>
            {/* Speed */}
            <View style={styles.controlGroup}>
              <Text style={[styles.fieldLabel, themedStyles.textSecondary]}>
                Speed: {speed.toFixed(2)}x
              </Text>
              <View style={styles.controlBtns}>
                {[1.0, 1.25, 1.5, 1.75, 2.0].map(s => {
                  const isSpeedSelected = speed === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[
                        styles.controlBtn,
                        isSpeedSelected
                          ? themedStyles.btnSelected
                          : themedStyles.btnUnselected,
                      ]}
                      onPress={() => setSpeed(s)}
                      disabled={isStarted}>
                      <Text
                        style={[
                          styles.controlBtnText,
                          isSpeedSelected
                            ? themedStyles.textWhite
                            : themedStyles.textPrimary,
                        ]}>
                        {s}x
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Quality */}
            <View style={styles.controlGroup}>
              <Text style={[styles.fieldLabel, themedStyles.textSecondary]}>
                Quality: {inferenceSteps} steps
              </Text>
              <View style={styles.controlBtns}>
                {[2, 3, 5, 8, 12, 16].map(steps => {
                  const isStepsSelected = inferenceSteps === steps;
                  return (
                    <TouchableOpacity
                      key={steps}
                      style={[
                        styles.controlBtn,
                        isStepsSelected
                          ? themedStyles.btnSelectedGreen
                          : themedStyles.btnUnselected,
                      ]}
                      onPress={() => setInferenceSteps(steps)}
                      disabled={isStarted}>
                      <Text
                        style={[
                          styles.controlBtnText,
                          isStepsSelected
                            ? themedStyles.textWhite
                            : themedStyles.textPrimary,
                        ]}>
                        {steps}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Chunk Progress */}
      {currentChunk && isStarted && (
        <View style={[styles.chunkProgress, themedStyles.bgChunkProgress]}>
          <View style={styles.chunkHeader}>
            <Text style={[styles.chunkLabel, themedStyles.textPrimary]}>
              Sentence {currentChunk.chunkIndex + 1}/{currentChunk.totalChunks}
            </Text>
            <Text style={[styles.chunkPercent, themedStyles.statusAccent]}>
              {currentChunk.progress}%
            </Text>
          </View>
          <View style={styles.chunkBarBg}>
            <View
              style={[
                styles.chunkBarFill,
                {width: `${currentChunk.progress}%`},
              ]}
            />
          </View>
        </View>
      )}

      {/* Main Content */}
      <View style={gs.flex}>
        {isStarted ? (
          <HighlightedText
            text={spokenText}
            highlights={highlights}
            highlightedStyle={styles.highlighted}
            onHighlightedPress={onHighlightedPress}
            style={[gs.paragraph, themedStyles.textPrimary]}
          />
        ) : (
          <TextInput
            style={[
              gs.paragraph,
              themedStyles.textPrimary,
              styles.textInput,
              themedStyles.bgInput,
            ]}
            value={spokenText}
            onChangeText={setSpokenText}
            multiline
            placeholderTextColor={secondaryTextColor}
          />
        )}
      </View>

      {/* Controls */}
      <View style={[gs.row, gs.p10]}>
        <Button
          label="Start"
          disabled={isStarted || !engineReady || isInitializing}
          onPress={onStartPress}
        />
        <Button label="Stop" disabled={!isStarted} onPress={Speech.stop} />
        {!isAndroidLowerThan26 && (
          <>
            <Button
              label="Pause"
              onPress={Speech.pause}
              disabled={isPaused || !isStarted}
            />
            <Button
              label="Resume"
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
    color: 'black',
    fontWeight: '600',
    backgroundColor: '#ffff00',
  },
  textInput: {
    minHeight: 100,
    borderRadius: 8,
    padding: 12,
    textAlignVertical: 'top',
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '75%',
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
    fontSize: 18,
    fontWeight: '600',
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
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  useBtnText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  deleteBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  deleteBtnText: {
    color: '#FF3B30',
    fontSize: 13,
    fontWeight: '500',
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
    fontSize: 16,
    color: '#007AFF',
    fontWeight: '700',
  },
  // Engine Selector
  engineSelector: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  manageBtn: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  manageBtnText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  engineButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  engineBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  engineBtnText: {
    fontSize: 14,
    fontWeight: '600',
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
    fontSize: 14,
    fontWeight: '500',
  },
  loadUnloadButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  unloadBtn: {
    backgroundColor: '#FF9500',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  unloadBtnText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  loadBtn: {
    backgroundColor: '#34C759',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  loadBtnText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  // Acceleration
  accelerationSection: {
    marginTop: 14,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
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
  supertonicControls: {
    marginTop: 14,
    gap: 12,
  },
  controlGroup: {},
  controlBtns: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  controlBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    minWidth: 44,
    alignItems: 'center',
  },
  controlBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  // Chunk Progress
  chunkProgress: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#007AFF',
  },
  chunkHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  chunkLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  chunkPercent: {
    fontSize: 13,
    fontWeight: '600',
  },
  chunkBarBg: {
    height: 4,
    backgroundColor: 'rgba(128,128,128,0.2)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  chunkBarFill: {
    height: '100%',
    backgroundColor: '#007AFF',
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
