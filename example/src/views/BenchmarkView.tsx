import React from 'react';
import {
  Text,
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  useColorScheme,
  Platform,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {TTSEngine} from '@mhpdev/react-native-speech';
import {kokoroModelManager} from '../utils/ModelManager';
import {supertonicModelManager} from '../utils/SupertonicModelManager';
import {kittenModelManager} from '../utils/KittenModelManager';
import {phonemizerDictManager} from '../utils/PhonemizerDictManager';
import {
  runBenchmark,
  type BenchmarkConfig,
  type BenchmarkSummary,
  type BenchmarkProgress,
  type EngineTestConfig,
} from '../benchmark';
import type {ExecutionProviderPreset} from '@mhpdev/react-native-speech';

const TEST_PHRASE =
  'The quick brown fox jumps over the lazy dog. ' +
  'She sells seashells by the seashore. ' +
  'How much wood would a woodchuck chuck if a woodchuck could chuck wood?';

interface InstalledEngine {
  engine: TTSEngine;
  label: string;
  variant?: string;
  getInitConfig: () => Record<string, any>;
  defaultVoice: string;
}

const BenchmarkView: React.FC = () => {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const textColor = isDark ? '#FFFFFF' : '#000000';
  const secondaryTextColor = isDark ? '#8E8E93' : '#6D6D72';
  const cardBg = isDark ? '#1C1C1E' : '#F2F2F7';
  const inputBg = isDark ? '#3A3A3C' : '#E5E5EA';
  const dimColor = isDark ? '#555' : '#BBB';

  const [installedEngines, setInstalledEngines] = React.useState<
    InstalledEngine[]
  >([]);
  const [selectedEngines, setSelectedEngines] = React.useState<Set<string>>(
    new Set(),
  );
  const [iterations, setIterations] = React.useState(3);
  const [warmupIterations, setWarmupIterations] = React.useState(1);
  const [provider, setProvider] =
    React.useState<ExecutionProviderPreset>('auto');
  const [isRunning, setIsRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<BenchmarkProgress | null>(
    null,
  );
  const [results, setResults] = React.useState<BenchmarkSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isScanning, setIsScanning] = React.useState(true);

  // Scan for installed models on mount
  React.useEffect(() => {
    scanModels();
  }, []);

  const scanModels = async () => {
    setIsScanning(true);
    const engines: InstalledEngine[] = [];

    // Phonemizer dict is shared by Kokoro + Kitten; download once up-front.
    const dictPath = await phonemizerDictManager.ensureDict('en-us');

    try {
      // Kokoro
      await kokoroModelManager.scanInstalledModels();
      const kokoroModels = kokoroModelManager.getInstalledModels();
      if (kokoroModels.length > 0) {
        const model = kokoroModels[0]!;
        engines.push({
          engine: TTSEngine.KOKORO,
          label: `Kokoro (${model.variant})`,
          variant: model.variant,
          getInitConfig: () => ({
            ...kokoroModelManager.getDownloadedModelConfig(
              model.version,
              model.variant as any,
            ),
            dictPath,
            phonemizerType: 'js',
            maxChunkSize: 100,
          }),
          defaultVoice: '', // auto-detect after init
        });
      }
    } catch {
      /* not installed */
    }

    try {
      // Supertonic
      await supertonicModelManager.scanInstalledModel();
      const stModels = supertonicModelManager.getAllInstalledModels();
      for (const model of stModels) {
        engines.push({
          engine: TTSEngine.SUPERTONIC,
          label: `Supertonic (${model.version})`,
          variant: model.version,
          getInitConfig: () => ({
            ...supertonicModelManager.getDownloadedModelConfig(
              model.version as any,
            ),
            maxChunkSize: 200,
          }),
          defaultVoice: '', // auto-detect after init
        });
      }
    } catch {
      /* not installed */
    }

    try {
      // Kitten
      await kittenModelManager.scanInstalledModel();
      const kittenModels = kittenModelManager.getAllInstalledModels();
      for (const model of kittenModels) {
        engines.push({
          engine: TTSEngine.KITTEN,
          label: `Kitten (${model.variant})`,
          variant: model.variant,
          getInitConfig: () => ({
            ...kittenModelManager.getDownloadedModelConfig(
              model.variant as any,
            ),
            dictPath,
            maxChunkSize: 100,
          }),
          defaultVoice: '', // auto-detect after init
        });
      }
    } catch {
      /* not installed */
    }

    setInstalledEngines(engines);
    // Select all by default
    setSelectedEngines(new Set(engines.map((_, i) => String(i))));
    setIsScanning(false);
  };

  const toggleEngine = (index: string) => {
    setSelectedEngines(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleRun = async () => {
    if (selectedEngines.size === 0) {
      return;
    }

    setIsRunning(true);
    setResults(null);
    setError(null);

    const engineConfigs: EngineTestConfig[] = [];
    for (const idx of selectedEngines) {
      const eng = installedEngines[Number(idx)]!;
      engineConfigs.push({
        engine: eng.engine,
        label: eng.label,
        variant: eng.variant,
        getInitConfig: eng.getInitConfig,
        voiceId: eng.defaultVoice,
      });
    }

    const benchConfig: BenchmarkConfig = {
      engines: engineConfigs,
      iterations,
      testPhrase: TEST_PHRASE,
      provider,
      warmupIterations,
    };

    try {
      const summaries = await runBenchmark(benchConfig, setProgress);
      setResults(summaries);
    } catch (err: any) {
      setError(err.message || 'Benchmark failed');
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  };

  return (
    <SafeAreaView
      style={[styles.container, {backgroundColor: isDark ? '#000' : '#FFF'}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, {color: textColor}]}>Benchmark</Text>

        {/* Scanning state */}
        {isScanning && (
          <View style={styles.centered}>
            <ActivityIndicator size="small" />
            <Text style={[styles.label, {color: secondaryTextColor}]}>
              Scanning installed models...
            </Text>
          </View>
        )}

        {/* No engines installed */}
        {!isScanning && installedEngines.length === 0 && (
          <View style={[styles.card, {backgroundColor: cardBg}]}>
            <Text style={[styles.label, {color: secondaryTextColor}]}>
              No engines installed. Download models from the Demo tab first.
            </Text>
          </View>
        )}

        {/* Config section */}
        {!isScanning && installedEngines.length > 0 && (
          <>
            {/* Engine selection */}
            <Text style={[styles.sectionTitle, {color: textColor}]}>
              Engines
            </Text>
            <View style={[styles.card, {backgroundColor: cardBg}]}>
              {installedEngines.map((eng, i) => {
                const key = String(i);
                const selected = selectedEngines.has(key);
                return (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.checkRow,
                      selected && {
                        backgroundColor: isDark ? '#1A3A5C' : '#E8F4FD',
                      },
                    ]}
                    onPress={() => toggleEngine(key)}
                    disabled={isRunning}>
                    <Text style={[styles.checkBox, {color: textColor}]}>
                      {selected ? '[x]' : '[ ]'}
                    </Text>
                    <Text style={[styles.checkLabel, {color: textColor}]}>
                      {eng.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Iterations + Warm-up row */}
            <View style={styles.configRow}>
              <View style={styles.configCol}>
                <Text style={[styles.sectionTitle, {color: textColor}]}>
                  Iterations
                </Text>
                <View style={styles.row}>
                  {[1, 3, 5].map(n => (
                    <TouchableOpacity
                      key={n}
                      style={[
                        styles.optionBtn,
                        {
                          backgroundColor:
                            iterations === n ? '#007AFF' : inputBg,
                        },
                      ]}
                      onPress={() => setIterations(n)}
                      disabled={isRunning}>
                      <Text
                        style={[
                          styles.optionText,
                          {color: iterations === n ? '#FFF' : textColor},
                        ]}>
                        {n}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <View style={styles.configCol}>
                <Text style={[styles.sectionTitle, {color: textColor}]}>
                  Warm-up
                </Text>
                <View style={styles.row}>
                  {[0, 1, 2].map(n => (
                    <TouchableOpacity
                      key={n}
                      style={[
                        styles.optionBtn,
                        {
                          backgroundColor:
                            warmupIterations === n ? '#FF9500' : inputBg,
                        },
                      ]}
                      onPress={() => setWarmupIterations(n)}
                      disabled={isRunning}>
                      <Text
                        style={[
                          styles.optionText,
                          {color: warmupIterations === n ? '#FFF' : textColor},
                        ]}>
                        {n}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>

            {/* Provider */}
            <Text style={[styles.sectionTitle, {color: textColor}]}>
              Execution Provider
            </Text>
            <View style={styles.row}>
              {(
                [
                  {key: 'auto', label: 'Auto'},
                  {
                    key: 'gpu',
                    label: Platform.OS === 'ios' ? 'CoreML' : 'GPU',
                  },
                  {key: 'cpu', label: 'CPU'},
                ] as const
              ).map(p => (
                <TouchableOpacity
                  key={p.key}
                  style={[
                    styles.optionBtn,
                    {backgroundColor: provider === p.key ? '#007AFF' : inputBg},
                  ]}
                  onPress={() => setProvider(p.key)}
                  disabled={isRunning}>
                  <Text
                    style={[
                      styles.optionText,
                      {color: provider === p.key ? '#FFF' : textColor},
                    ]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Run button */}
            <TouchableOpacity
              style={[styles.runBtn, isRunning && styles.runBtnDisabled]}
              onPress={handleRun}
              disabled={isRunning || selectedEngines.size === 0}>
              <Text style={styles.runBtnText}>
                {isRunning ? 'Running...' : 'Run Benchmark'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {/* Progress */}
        {isRunning && progress && (
          <View style={[styles.card, {backgroundColor: cardBg}]}>
            <Text style={[styles.progressTitle, {color: textColor}]}>
              {progress.engine}{' '}
              {progress.variant ? `(${progress.variant})` : ''}
            </Text>
            <Text style={[styles.label, {color: secondaryTextColor}]}>
              {progress.isWarmup ? 'Warm-up' : 'Iteration'} {progress.iteration}
              /{progress.totalIterations} — Engine {progress.engineIndex}/
              {progress.totalEngines}
            </Text>
            <Text
              style={[
                styles.phaseLabel,
                {color: progress.isWarmup ? '#FF9500' : '#007AFF'},
              ]}>
              {progress.phase.toUpperCase()}
            </Text>
          </View>
        )}

        {/* Error */}
        {error && (
          <View style={[styles.card, {backgroundColor: '#FFF0F0'}]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* Results */}
        {results && results.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, {color: textColor}]}>
              Results (median / p90)
            </Text>
            {results.map((summary, i) => (
              <View key={i} style={[styles.card, {backgroundColor: cardBg}]}>
                <Text style={[styles.resultEngine, {color: textColor}]}>
                  {summary.engine}
                  {summary.variant !== 'default' ? ` (${summary.variant})` : ''}
                </Text>

                {/* Row 1: Timing p50 */}
                <View style={styles.resultRow}>
                  <ResultCell
                    label="Init (p50)"
                    value={`${summary.stats.initMs.median}ms`}
                    color={textColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="TTFA (p50)"
                    value={`${summary.stats.ttfaMs.median}ms`}
                    color={textColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="Total (p50)"
                    value={`${summary.stats.totalSpeakMs.median}ms`}
                    color={textColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="Release"
                    value={`${summary.stats.releaseMs.median}ms`}
                    color={textColor}
                    secondaryColor={secondaryTextColor}
                  />
                </View>

                {/* Row 2: Timing p90 */}
                <View style={styles.resultRow}>
                  <ResultCell
                    label="Init (p90)"
                    value={`${summary.stats.initMs.p90}ms`}
                    color={secondaryTextColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="TTFA (p90)"
                    value={`${summary.stats.ttfaMs.p90}ms`}
                    color={secondaryTextColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="Total (p90)"
                    value={`${summary.stats.totalSpeakMs.p90}ms`}
                    color={secondaryTextColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="Rel (p90)"
                    value={`${summary.stats.releaseMs.p90}ms`}
                    color={secondaryTextColor}
                    secondaryColor={secondaryTextColor}
                  />
                </View>

                {/* Row 3: Memory */}
                <View style={styles.resultRow}>
                  <ResultCell
                    label="Mem Load"
                    value={`+${summary.averages.modelMemoryMB}MB`}
                    color={textColor}
                    secondaryColor={secondaryTextColor}
                  />
                  <ResultCell
                    label="Mem Infer"
                    value={`+${summary.averages.inferMemoryMB}MB`}
                    color={textColor}
                    secondaryColor={secondaryTextColor}
                  />
                  {summary.stats.peakInitMemoryMB != null && (
                    <ResultCell
                      label="Peak Init"
                      value={`${summary.stats.peakInitMemoryMB}MB`}
                      color={textColor}
                      secondaryColor={secondaryTextColor}
                    />
                  )}
                  {summary.stats.peakSpeakMemoryMB != null && (
                    <ResultCell
                      label="Peak Speak"
                      value={`${summary.stats.peakSpeakMemoryMB}MB`}
                      color={textColor}
                      secondaryColor={secondaryTextColor}
                    />
                  )}
                </View>

                {/* Per-iteration details */}
                <Text style={[styles.iterHeader, {color: secondaryTextColor}]}>
                  Measured iterations
                </Text>
                {summary.iterations.map((iter, j) => (
                  <View key={j} style={styles.iterRow}>
                    <Text
                      style={[styles.iterLabel, {color: secondaryTextColor}]}>
                      #{j + 1}
                    </Text>
                    <Text
                      style={[styles.iterValue, {color: secondaryTextColor}]}>
                      {iter.initMs} | {iter.ttfaMs} | {iter.totalSpeakMs} |{' '}
                      {iter.releaseMs} | +
                      {Math.round(
                        iter.memoryPostInit.nativeHeapMB -
                          iter.memoryBaseline.nativeHeapMB,
                      )}
                      MB
                    </Text>
                  </View>
                ))}

                {/* Warm-up iterations (dimmed) */}
                {summary.warmupIterations.length > 0 && (
                  <>
                    <Text style={[styles.iterHeader, {color: dimColor}]}>
                      Warm-up (discarded)
                    </Text>
                    {summary.warmupIterations.map((iter, j) => (
                      <View key={`w${j}`} style={styles.iterRow}>
                        <Text style={[styles.iterLabel, {color: dimColor}]}>
                          W{j + 1}
                        </Text>
                        <Text style={[styles.iterValue, {color: dimColor}]}>
                          {iter.initMs} | {iter.ttfaMs} | {iter.totalSpeakMs} |{' '}
                          {iter.releaseMs}
                        </Text>
                      </View>
                    ))}
                  </>
                )}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const ResultCell: React.FC<{
  label: string;
  value: string;
  color: string;
  secondaryColor: string;
}> = ({label, value, color, secondaryColor}) => (
  <View style={styles.resultCell}>
    <Text style={[styles.resultValue, {color}]}>{value}</Text>
    <Text style={[styles.resultLabel, {color: secondaryColor}]}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  card: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  centered: {
    alignItems: 'center',
    padding: 20,
    gap: 8,
  },
  label: {
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  configRow: {
    flexDirection: 'row',
    gap: 24,
  },
  configCol: {
    flex: 1,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderRadius: 6,
    gap: 8,
  },
  checkBox: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
  },
  checkLabel: {
    fontSize: 14,
  },
  optionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  optionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  runBtn: {
    backgroundColor: '#34C759',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  runBtnDisabled: {
    opacity: 0.5,
  },
  runBtnText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  progressTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  phaseLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  errorText: {
    color: '#FF3B30',
    fontSize: 14,
  },
  resultEngine: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  resultCell: {
    alignItems: 'center',
  },
  resultValue: {
    fontSize: 14,
    fontWeight: '700',
  },
  resultLabel: {
    fontSize: 11,
    marginTop: 2,
  },
  iterHeader: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
  },
  iterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  iterLabel: {
    fontSize: 12,
    fontWeight: '600',
    width: 24,
  },
  iterValue: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

export default BenchmarkView;
