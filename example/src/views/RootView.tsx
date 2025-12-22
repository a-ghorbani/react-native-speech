import React from 'react';
import {gs} from '../styles/gs';
import {
  Text,
  View,
  Alert,
  Platform,
  StyleSheet,
  useColorScheme,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  ScrollView,
  Pressable,
} from 'react-native';
import Speech, {
  HighlightedText,
  type HighlightedSegmentArgs,
  type HighlightedSegmentProps,
  type ChunkProgressEvent,
  type ExecutionProviderPreset,
  TTSEngine,
} from '@mhpdev/react-native-speech';
import Button from '../components/Button';
import {SafeAreaView} from 'react-native-safe-area-context';
import {kokoroModelManager} from '../utils/ModelManager';

const isAndroidLowerThan26 = Platform.OS === 'android' && Platform.Version < 26;

const Introduction =
  "This high-performance text-to-speech library is built for bare React Native and Expo, compatible with Android and iOS's new architecture (default from React Native 0.76). It enables seamless speech management with start, pause, resume, and stop controls, and provides events for detailed synthesis management.";

const RootView: React.FC = () => {
  const scheme = useColorScheme();

  const textColor = scheme === 'dark' ? 'white' : 'black';

  const [isPaused, setIsPaused] = React.useState<boolean>(false);

  const [isStarted, setIsStarted] = React.useState<boolean>(false);

  const [highlights, setHighlights] = React.useState<
    Array<HighlightedSegmentProps>
  >([]);

  const [selectedEngine, setSelectedEngine] = React.useState<TTSEngine>(
    TTSEngine.OS_NATIVE,
  );
  const [isInitializing, setIsInitializing] = React.useState<boolean>(false);
  const [engineReady, setEngineReady] = React.useState<boolean>(false);
  const [availableVoices, setAvailableVoices] = React.useState<any[]>([]);
  const [selectedVoice, setSelectedVoice] = React.useState<string | null>(null);
  const [showVoicePicker, setShowVoicePicker] = React.useState<boolean>(false);
  const [isDownloading, setIsDownloading] = React.useState<boolean>(false);
  const [showModelManager, setShowModelManager] =
    React.useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = React.useState<number>(0);
  const [installedModels, setInstalledModels] = React.useState<any[]>([]);

  // Execution provider selection for hardware acceleration
  const [selectedProvider, setSelectedProvider] =
    React.useState<ExecutionProviderPreset>('auto');

  // Chunk progress for neural engines
  const [currentChunk, setCurrentChunk] =
    React.useState<ChunkProgressEvent | null>(null);

  // Initialize engine when selection changes
  const initializeEngine = React.useCallback(
    async (engine: TTSEngine, provider: ExecutionProviderPreset = 'auto') => {
      try {
        setIsInitializing(true);
        setEngineReady(false);

        if (engine === TTSEngine.OS_NATIVE) {
          // OS engine doesn't need initialization
          await Speech.initialize({
            engine: TTSEngine.OS_NATIVE,
            silentMode: 'obey',
            ducking: true,
          });
          setEngineReady(true);
        } else if (engine === TTSEngine.KOKORO) {
          // First, scan for installed models
          await kokoroModelManager.scanInstalledModels();
          const models = kokoroModelManager.getInstalledModels();

          let config;
          if (models.length > 0 && models[0]) {
            // Use first installed model
            const model = models[0];
            config = kokoroModelManager.getDownloadedModelConfig(
              model.version,
              model.variant,
            );
            console.log('Using downloaded Kokoro model:', model);
          } else {
            // Try bundled model (will fail if not bundled)
            config = kokoroModelManager.getBundledModelConfig();
            console.log('Attempting to use bundled Kokoro model');
          }

          try {
            console.log(
              `Initializing Kokoro with execution provider: ${provider}`,
            );
            await Speech.initialize({
              engine: TTSEngine.KOKORO,
              ...config,
              phonemizerType: 'native',
              silentMode: 'obey',
              ducking: true,
              maxChunkSize: 100,
              executionProviders: provider,
            });
            setEngineReady(true);
          } catch (initError) {
            // If initialization fails, likely no models available
            console.error('Kokoro initialization failed:', initError);
            Alert.alert(
              'No Kokoro Models Found',
              'No Kokoro models are installed. Would you like to download one now?\n\n' +
                'Recommended: q8 variant (~82MB)',
              [
                {text: 'Cancel', style: 'cancel'},
                {
                  text: 'Download q8',
                  onPress: async () => {
                    try {
                      setIsInitializing(true);
                      await kokoroModelManager.downloadModel('q8', progress => {
                        console.log(
                          `Download: ${(progress.progress * 100).toFixed(1)}%`,
                        );
                      });
                      // Retry initialization with downloaded model
                      const downloadedConfig =
                        kokoroModelManager.getDownloadedModelConfig(
                          '1.0',
                          'q8',
                        );
                      await Speech.initialize({
                        engine: TTSEngine.KOKORO,
                        ...downloadedConfig,
                        phonemizerType: 'native',
                        silentMode: 'obey',
                        ducking: true,
                        executionProviders: provider,
                      });
                      setEngineReady(true);
                      Alert.alert('Success', 'Kokoro model ready to use!');
                    } catch (err) {
                      Alert.alert(
                        'Error',
                        `Failed to download/initialize: ${err instanceof Error ? err.message : 'Unknown error'}`,
                      );
                      setEngineReady(false);
                    } finally {
                      setIsInitializing(false);
                    }
                  },
                },
              ],
            );
            setEngineReady(false);
            return;
          }
        } else if (engine === TTSEngine.SUPERTONIC) {
          // TODO: Add Supertonic model manager
          Alert.alert(
            'Not Implemented',
            'Supertonic engine is not yet configured in this example. Please add model files.',
          );
          setEngineReady(false);
        }
      } catch (error) {
        console.error('Failed to initialize engine:', error);
        Alert.alert(
          'Initialization Error',
          `Failed to initialize ${engine}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        setEngineReady(false);
      } finally {
        setIsInitializing(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    initializeEngine(selectedEngine, selectedProvider);
  }, [selectedEngine, selectedProvider, initializeEngine]);

  // Load voices when engine is ready
  const loadVoices = React.useCallback(async () => {
    console.log(
      `[loadVoices] Called - engineReady: ${engineReady}, selectedEngine: ${selectedEngine}`,
    );

    if (!engineReady || isInitializing) {
      console.log(
        '[loadVoices] Engine not ready or initializing, clearing voices',
      );
      setAvailableVoices([]);
      setSelectedVoice(null);
      return;
    }

    try {
      if (selectedEngine === TTSEngine.OS_NATIVE) {
        console.log('[loadVoices] Loading OS voices');
        // Get OS voices
        const voices = await Speech.getAvailableVoices();
        setAvailableVoices(
          voices.map(v => ({
            id: v.identifier,
            name: v.name || v.identifier,
            language: v.language,
          })),
        );
        // Set first voice as default
        if (voices.length > 0 && voices[0]) {
          setSelectedVoice(voices[0].identifier);
        }
      } else if (
        selectedEngine === TTSEngine.KOKORO ||
        selectedEngine === TTSEngine.SUPERTONIC
      ) {
        console.log('[loadVoices] Loading neural engine voices');
        // Get neural engine voices with metadata
        const voices = await Speech.getVoicesWithMetadata();
        console.log(`[loadVoices] Got ${voices.length} voices`);
        setAvailableVoices(voices);
        // Set first voice as default
        if (voices.length > 0 && voices[0]) {
          setSelectedVoice(voices[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load voices:', error);
      setAvailableVoices([]);
      setSelectedVoice(null);
    }
  }, [engineReady, selectedEngine, isInitializing]);

  React.useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  // Load installed models
  const loadInstalledModels = React.useCallback(async () => {
    if (selectedEngine === TTSEngine.KOKORO) {
      await kokoroModelManager.scanInstalledModels();
      const models = kokoroModelManager.getInstalledModels();
      setInstalledModels(models);
    }
  }, [selectedEngine]);

  React.useEffect(() => {
    loadInstalledModels();
  }, [loadInstalledModels]);

  React.useEffect(() => {
    const onSpeechEnd = () => {
      setIsStarted(false);
      setIsPaused(false);
      setHighlights([]);
      setCurrentChunk(null);
    };

    const startSubscription = Speech.onStart(({id}) => {
      setIsStarted(true);
      console.log(`Speech ${id} started`);
    });
    const finishSubscription = Speech.onFinish(({id}) => {
      onSpeechEnd();
      console.log(`Speech ${id} finished`);
    });
    const pauseSubscription = Speech.onPause(({id}) => {
      setIsPaused(true);
      console.log(`Speech ${id} paused`);
    });
    const resumeSubscription = Speech.onResume(({id}) => {
      setIsPaused(false);
      console.log(`Speech ${id} resumed`);
    });
    const stoppedSubscription = Speech.onStopped(({id}) => {
      onSpeechEnd();
      console.log(`Speech ${id} stopped`);
    });
    // Word-level progress (OS TTS only)
    const progressSubscription = Speech.onProgress(({id, location, length}) => {
      setHighlights([
        {
          start: location,
          end: location + length,
        },
      ]);
      console.log(
        `Speech ${id} progress, current word length: ${length}, current char position: ${location}`,
      );
    });

    // Chunk-level progress (Neural TTS - Kokoro/Supertonic)
    const unsubscribeChunkProgress = Speech.onChunkProgress(
      (event: ChunkProgressEvent) => {
        console.log(
          `[ChunkProgress] Chunk ${event.chunkIndex + 1}/${event.totalChunks}: "${event.chunkText.substring(0, 30)}..."`,
        );
        setCurrentChunk(event);
        // Update highlights for neural engines using chunk text range
        setHighlights([
          {
            start: event.textRange.start,
            end: event.textRange.end,
          },
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

  const onStartPress = React.useCallback(async () => {
    // Use voiceId parameter for all engines (unified API)
    await Speech.speak(Introduction, selectedVoice || undefined);
  }, [selectedVoice]);

  const onHighlightedPress = React.useCallback(
    ({text, start, end}: HighlightedSegmentArgs) =>
      Alert.alert(
        'Highlighted',
        `The current segment is "${text}", starting at ${start} and ending at ${end}`,
      ),
    [],
  );

  const handleDownloadModel = React.useCallback(() => {
    if (selectedEngine === TTSEngine.KOKORO) {
      setShowModelManager(true);
    } else if (selectedEngine === TTSEngine.SUPERTONIC) {
      Alert.alert(
        'Download Supertonic Model',
        'Supertonic model manager is not yet implemented. Please add model files manually.',
      );
    } else {
      Alert.alert('Info', 'System TTS does not require model downloads.');
    }
  }, [selectedEngine]);

  const handleManageModels = React.useCallback(() => {
    // Always show Kokoro model manager
    setShowModelManager(true);
  }, []);

  const downloadModelVariant = React.useCallback(
    async (variant: 'q8' | 'fp16' | 'full') => {
      try {
        setIsDownloading(true);
        setDownloadProgress(0);

        await kokoroModelManager.downloadModel(variant, progress => {
          setDownloadProgress(progress.progress);
          console.log(
            `Download progress: ${(progress.progress * 100).toFixed(1)}%`,
          );
        });

        Alert.alert(
          'Success',
          'Kokoro model downloaded successfully! Initializing...',
        );

        // Reload installed models
        await loadInstalledModels();

        // Reinitialize with downloaded model
        await initializeEngine(TTSEngine.KOKORO);

        setShowModelManager(false);
      } catch (err) {
        Alert.alert(
          'Download Failed',
          `Failed to download model: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      } finally {
        setIsDownloading(false);
        setDownloadProgress(0);
      }
    },
    [initializeEngine, loadInstalledModels],
  );

  const deleteModelVariant = React.useCallback(
    async (version: string, variant: 'q8' | 'fp16' | 'full') => {
      try {
        await kokoroModelManager.deleteModel(version, variant);
        Alert.alert('Success', 'Model deleted successfully');
        await loadInstalledModels();
      } catch (err) {
        Alert.alert(
          'Delete Failed',
          `Failed to delete model: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    },
    [loadInstalledModels],
  );

  const getVoiceDisplayName = (voice: any): string => {
    if (selectedEngine === TTSEngine.OS_NATIVE) {
      return `${voice.name} (${voice.language})`;
    }
    return `${voice.name} - ${voice.description || voice.id}`;
  };

  const renderEngineButton = (engine: TTSEngine, label: string) => {
    const isSelected = selectedEngine === engine;
    const backgroundColor = isSelected
      ? scheme === 'dark'
        ? '#4A90E2'
        : '#007AFF'
      : scheme === 'dark'
        ? '#333'
        : '#E0E0E0';
    const textColorButton = isSelected
      ? 'white'
      : scheme === 'dark'
        ? '#CCC'
        : '#333';

    return (
      <TouchableOpacity
        key={engine}
        style={[styles.engineButton, {backgroundColor}]}
        onPress={() => {
          setEngineReady(false);
          setSelectedEngine(engine);
        }}
        disabled={isInitializing || isStarted}>
        <Text style={[styles.engineButtonText, {color: textColorButton}]}>
          {label}
        </Text>
        {isSelected && isInitializing && (
          <ActivityIndicator size="small" color="white" />
        )}
      </TouchableOpacity>
    );
  };

  console.log('availableVoices.length:', availableVoices.length);

  return (
    <SafeAreaView style={[gs.flex, gs.p10]}>
      {/* Model Manager Modal */}
      <Modal
        visible={showModelManager}
        transparent
        animationType="slide"
        onRequestClose={() => setShowModelManager(false)}>
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalContent,
              {backgroundColor: scheme === 'dark' ? '#1C1C1E' : 'white'},
            ]}>
            <Text style={[styles.modalTitle, {color: textColor}]}>
              Kokoro Models
            </Text>

            {/* Installed Models */}
            <Text
              style={[
                styles.sectionTitle,
                {color: textColor, marginBottom: 8},
              ]}>
              Installed Models ({installedModels.length})
            </Text>
            {installedModels.length > 0 ? (
              <ScrollView style={styles.modelList}>
                {installedModels.map(model => (
                  <View
                    key={`${model.version}-${model.variant}`}
                    style={[
                      styles.modelItem,
                      {
                        backgroundColor:
                          scheme === 'dark' ? '#2C2C2E' : '#F0F0F0',
                      },
                    ]}>
                    <View style={styles.modelInfo}>
                      <Text style={[styles.modelName, {color: textColor}]}>
                        {model.version} - {model.variant}
                      </Text>
                      <Text
                        style={[styles.modelSize, {color: textColor + '99'}]}>
                        {(model.size / 1024 / 1024).toFixed(1)} MB
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.deleteButton}
                      onPress={() =>
                        deleteModelVariant(model.version, model.variant)
                      }>
                      <Text style={styles.deleteButtonText}>🗑️</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={[styles.emptyText, {color: textColor + '99'}]}>
                No models installed
              </Text>
            )}

            {/* Download Section */}
            <Text
              style={[
                styles.sectionTitle,
                {color: textColor, marginTop: 16, marginBottom: 8},
              ]}>
              Download Models
            </Text>

            {isDownloading ? (
              <View style={styles.downloadingContainer}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={[styles.downloadingText, {color: textColor}]}>
                  Downloading... {(downloadProgress * 100).toFixed(0)}%
                </Text>
                <View style={styles.progressBar}>
                  <View
                    style={[
                      styles.progressFill,
                      {width: `${downloadProgress * 100}%`},
                    ]}
                  />
                </View>
              </View>
            ) : (
              <View style={styles.downloadButtons}>
                <TouchableOpacity
                  style={[
                    styles.downloadVariantButton,
                    {backgroundColor: '#007AFF'},
                  ]}
                  onPress={() => downloadModelVariant('q8')}>
                  <Text style={styles.downloadVariantText}>
                    Download q8 (82MB)
                  </Text>
                  <Text style={styles.downloadVariantSubtext}>Recommended</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.downloadVariantButton,
                    {backgroundColor: '#34C759'},
                  ]}
                  onPress={() => downloadModelVariant('fp16')}>
                  <Text style={styles.downloadVariantText}>
                    Download fp16 (164MB)
                  </Text>
                  <Text style={styles.downloadVariantSubtext}>
                    Better Quality
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.downloadVariantButton,
                    {backgroundColor: '#FF9500'},
                  ]}
                  onPress={() => downloadModelVariant('full')}>
                  <Text style={styles.downloadVariantText}>
                    Download Full (328MB)
                  </Text>
                  <Text style={styles.downloadVariantSubtext}>
                    Best Quality
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowModelManager(false)}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Voice Picker Modal */}
      <Modal
        visible={showVoicePicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowVoicePicker(false)}>
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.modalContent,
              {backgroundColor: scheme === 'dark' ? '#1C1C1E' : 'white'},
            ]}>
            <Text style={[styles.modalTitle, {color: textColor}]}>
              Select Voice
            </Text>
            <ScrollView style={styles.voiceList}>
              {availableVoices.map(voice => {
                const voiceId =
                  selectedEngine === TTSEngine.OS_NATIVE ? voice.id : voice.id;
                const isSelected = selectedVoice === voiceId;
                return (
                  <Pressable
                    key={voiceId}
                    style={[
                      styles.voiceItem,
                      isSelected && styles.voiceItemSelected,
                      {
                        backgroundColor: isSelected
                          ? scheme === 'dark'
                            ? '#2C2C2E'
                            : '#E8F4FD'
                          : 'transparent',
                      },
                    ]}
                    onPress={() => {
                      setSelectedVoice(voiceId);
                      setShowVoicePicker(false);
                    }}>
                    <Text style={[styles.voiceName, {color: textColor}]}>
                      {getVoiceDisplayName(voice)}
                    </Text>
                    {isSelected && <Text style={styles.checkmark}>✓</Text>}
                  </Pressable>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowVoicePicker(false)}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Engine Selector */}
      <View style={styles.engineSelector}>
        <View style={styles.engineHeader}>
          <Text style={[styles.selectorTitle, {color: textColor}]}>
            TTS Engine:
          </Text>
          <TouchableOpacity
            style={[
              styles.manageModelsButton,
              {backgroundColor: scheme === 'dark' ? '#4A90E2' : '#007AFF'},
            ]}
            onPress={handleManageModels}>
            <Text style={styles.manageModelsButtonText}>📥 Manage Models</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.engineButtons}>
          {renderEngineButton(TTSEngine.OS_NATIVE, 'System')}
          {renderEngineButton(TTSEngine.KOKORO, 'Kokoro')}
          {renderEngineButton(TTSEngine.SUPERTONIC, 'Supertonic')}
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusText, {color: textColor}]}>
            Status:{' '}
            {isInitializing
              ? '⏳ Initializing...'
              : engineReady
                ? '✅ Ready'
                : '❌ Not Ready'}
          </Text>
        </View>

        {/* Execution Provider Selection (Kokoro only) */}
        {selectedEngine === TTSEngine.KOKORO && (
          <View style={styles.providerSection}>
            <Text style={[styles.providerLabel, {color: textColor}]}>
              Acceleration:
            </Text>
            <View style={styles.providerButtons}>
              {(
                [
                  {key: 'auto', label: '🚀 Auto', desc: 'Best for device'},
                  {
                    key: 'gpu',
                    label: '🎮 GPU',
                    desc: Platform.OS === 'ios' ? 'Metal' : 'NNAPI',
                  },
                  {
                    key: 'ane',
                    label: '🧠 ANE',
                    desc: Platform.OS === 'ios' ? 'Neural Engine' : 'N/A',
                  },
                  {key: 'cpu', label: '💻 CPU', desc: 'Fallback'},
                ] as const
              ).map(item => {
                const isSelected = selectedProvider === item.key;
                const isDisabled = item.key === 'ane' && Platform.OS !== 'ios';
                return (
                  <TouchableOpacity
                    key={item.key}
                    style={[
                      styles.providerButton,
                      {
                        backgroundColor: isSelected
                          ? scheme === 'dark'
                            ? '#4A90E2'
                            : '#007AFF'
                          : scheme === 'dark'
                            ? '#333'
                            : '#E0E0E0',
                        opacity: isDisabled ? 0.5 : 1,
                      },
                    ]}
                    onPress={() =>
                      setSelectedProvider(item.key as ExecutionProviderPreset)
                    }
                    disabled={isDisabled || isInitializing || isStarted}>
                    <Text
                      style={[
                        styles.providerButtonText,
                        {
                          color: isSelected
                            ? 'white'
                            : scheme === 'dark'
                              ? '#CCC'
                              : '#333',
                        },
                      ]}>
                      {item.label}
                    </Text>
                    <Text
                      style={[
                        styles.providerButtonDesc,
                        {
                          color: isSelected
                            ? 'rgba(255,255,255,0.8)'
                            : scheme === 'dark'
                              ? '#999'
                              : '#666',
                        },
                      ]}>
                      {item.desc}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Voice Selection and Download */}
        {engineReady && (
          <View style={styles.voiceControls}>
            <TouchableOpacity
              style={[
                styles.voiceButton,
                {
                  backgroundColor: '#c04a4aff',
                  flex: 1,
                },
              ]}
              onPress={() => {
                console.log('Voice button pressed');
                setShowVoicePicker(true);
              }}
              disabled={availableVoices.length === 0}>
              <Text style={[styles.voiceButtonText, {color: textColor}]}>
                🎤{' '}
                {selectedVoice
                  ? availableVoices.find(v =>
                      selectedEngine === TTSEngine.OS_NATIVE
                        ? v.id === selectedVoice
                        : v.id === selectedVoice,
                    )?.name || 'Select Voice'
                  : 'Select Voice'}
              </Text>
            </TouchableOpacity>

            {selectedEngine !== TTSEngine.OS_NATIVE && (
              <TouchableOpacity
                style={[
                  styles.downloadButton,
                  {backgroundColor: scheme === 'dark' ? '#2C2C2E' : '#F0F0F0'},
                ]}
                onPress={handleDownloadModel}
                disabled={isDownloading}>
                {isDownloading ? (
                  <ActivityIndicator size="small" color={textColor} />
                ) : (
                  <Text style={[styles.downloadButtonText, {color: textColor}]}>
                    ⬇️
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Chunk Progress Indicator (Neural TTS) */}
      {currentChunk && isStarted && (
        <View style={styles.chunkProgressContainer}>
          <View style={styles.chunkProgressHeader}>
            <Text style={[styles.chunkProgressLabel, {color: textColor}]}>
              Sentence {currentChunk.chunkIndex + 1} of{' '}
              {currentChunk.totalChunks}
            </Text>
            <Text style={[styles.chunkProgressPercent, {color: textColor}]}>
              {currentChunk.progress}%
            </Text>
          </View>
          <View style={styles.chunkProgressBarBg}>
            <View
              style={[
                styles.chunkProgressBarFill,
                {width: `${currentChunk.progress}%`},
              ]}
            />
          </View>
        </View>
      )}

      <View style={gs.flex}>
        <Text style={[gs.title, {color: textColor}]}>Introduction</Text>
        <HighlightedText
          text={Introduction}
          highlights={highlights}
          highlightedStyle={styles.highlighted}
          onHighlightedPress={onHighlightedPress}
          style={[gs.paragraph, {color: textColor}]}
        />
      </View>
      <View style={[gs.row, gs.p10]}>
        <Button
          label="Start"
          disabled={isStarted || !engineReady || isInitializing}
          onPress={onStartPress}
        />
        <Button label="Stop" disabled={!isStarted} onPress={Speech.stop} />
        {isAndroidLowerThan26 ? null : (
          <React.Fragment>
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
          </React.Fragment>
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
  engineSelector: {
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(128, 128, 128, 0.1)',
  },
  engineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  selectorTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  manageModelsButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  manageModelsButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  engineButtons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  engineButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  engineButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  statusRow: {
    marginTop: 4,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '500',
  },
  providerSection: {
    marginTop: 12,
  },
  providerLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  providerButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  providerButton: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  providerButtonDesc: {
    fontSize: 9,
    marginTop: 2,
  },
  voiceControls: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  voiceButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  downloadButton: {
    width: 50,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadButtonText: {
    fontSize: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '70%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  voiceList: {
    maxHeight: 400,
  },
  voiceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 8,
  },
  voiceItemSelected: {
    borderWidth: 2,
    borderColor: '#007AFF',
  },
  voiceName: {
    fontSize: 15,
    flex: 1,
  },
  checkmark: {
    fontSize: 18,
    color: '#007AFF',
    fontWeight: '700',
  },
  closeButton: {
    marginTop: 16,
    paddingVertical: 14,
    backgroundColor: '#007AFF',
    borderRadius: 10,
    alignItems: 'center',
  },
  closeButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  modelList: {
    maxHeight: 200,
    marginBottom: 16,
  },
  modelItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  modelInfo: {
    flex: 1,
  },
  modelName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  modelSize: {
    fontSize: 14,
  },
  deleteButton: {
    padding: 8,
  },
  deleteButtonText: {
    fontSize: 20,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    marginVertical: 16,
  },
  downloadingContainer: {
    alignItems: 'center',
    padding: 20,
  },
  downloadingText: {
    fontSize: 16,
    marginTop: 12,
    marginBottom: 8,
  },
  progressBar: {
    width: '100%',
    height: 8,
    backgroundColor: 'rgba(128, 128, 128, 0.2)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#007AFF',
  },
  downloadButtons: {
    gap: 12,
  },
  downloadVariantButton: {
    padding: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  downloadVariantText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  downloadVariantSubtext: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 13,
  },
  // Chunk progress styles (Neural TTS)
  chunkProgressContainer: {
    marginBottom: 12,
    padding: 12,
    backgroundColor: 'rgba(25, 118, 210, 0.1)',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#1976d2',
  },
  chunkProgressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  chunkProgressLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  chunkProgressPercent: {
    fontSize: 14,
    fontWeight: '600',
  },
  chunkProgressBarBg: {
    height: 6,
    backgroundColor: 'rgba(128, 128, 128, 0.2)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  chunkProgressBarFill: {
    height: '100%',
    backgroundColor: '#1976d2',
    borderRadius: 3,
  },
});
