import React from 'react';
import {
  Text,
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {TTSEngine} from '@pocketpalai/react-native-speech';
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
import type {ExecutionProviderPreset} from '@pocketpalai/react-native-speech';
import {C, MONO} from '../styles/cyber';

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

  React.useEffect(() => {
    scanModels();
  }, []);

  const scanModels = async () => {
    setIsScanning(true);
    const engines: InstalledEngine[] = [];

    const dictPath = await phonemizerDictManager.ensureDict('en-us');

    try {
      await kokoroModelManager.scanInstalledModels();
      const kokoroModels = kokoroModelManager.getInstalledModels();
      for (const model of kokoroModels) {
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
          defaultVoice: '',
        });
      }
    } catch {
      /* not installed */
    }

    try {
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
          defaultVoice: '',
        });
      }
    } catch {
      /* not installed */
    }

    try {
      await kittenModelManager.scanInstalledModel();
      const kitModels = kittenModelManager.getAllInstalledModels();
      for (const model of kitModels) {
        engines.push({
          engine: TTSEngine.KITTEN,
          label: `Kitten (${model.variant})`,
          variant: model.variant,
          getInitConfig: () => ({
            ...kittenModelManager.getDownloadedModelConfig(
              model.variant as any,
            ),
            dictPath,
            maxChunkSize: 500,
          }),
          defaultVoice: '',
        });
      }
    } catch {
      /* not installed */
    }

    setInstalledEngines(engines);
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
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>PERF_BENCH</Text>

        {isScanning && (
          <View style={styles.centered}>
            <ActivityIndicator size="small" color={C.cyan} />
            <Text style={styles.label}>{'> scanning installed models...'}</Text>
          </View>
        )}

        {!isScanning && installedEngines.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.label}>
              {'> no engines installed.\n> download models from the SYS tab.'}
            </Text>
          </View>
        )}

        {!isScanning && installedEngines.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{'// TARGET_ENGINES'}</Text>
            <View style={styles.card}>
              {installedEngines.map((eng, i) => {
                const key = String(i);
                const selected = selectedEngines.has(key);
                return (
                  <TouchableOpacity
                    key={key}
                    style={[styles.checkRow, selected && styles.checkRowActive]}
                    onPress={() => toggleEngine(key)}
                    disabled={isRunning}>
                    <Text style={styles.checkBox}>
                      {selected ? '[x]' : '[ ]'}
                    </Text>
                    <Text style={styles.checkLabel}>{eng.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.configRow}>
              <View style={styles.configCol}>
                <Text style={styles.sectionTitle}>{'// ITERATIONS'}</Text>
                <View style={styles.row}>
                  {[1, 3, 5].map(n => (
                    <TouchableOpacity
                      key={n}
                      style={[
                        styles.optionBtn,
                        iterations === n && styles.optionBtnActive,
                      ]}
                      onPress={() => setIterations(n)}
                      disabled={isRunning}>
                      <Text
                        style={[
                          styles.optionText,
                          iterations === n && styles.optionTextActive,
                        ]}>
                        {n}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <View style={styles.configCol}>
                <Text style={styles.sectionTitle}>{'// WARMUP'}</Text>
                <View style={styles.row}>
                  {[0, 1, 2].map(n => (
                    <TouchableOpacity
                      key={n}
                      style={[
                        styles.optionBtn,
                        warmupIterations === n && styles.optionBtnWarmup,
                      ]}
                      onPress={() => setWarmupIterations(n)}
                      disabled={isRunning}>
                      <Text
                        style={[
                          styles.optionText,
                          warmupIterations === n && styles.optionTextWarmup,
                        ]}>
                        {n}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>

            <Text style={styles.sectionTitle}>{'// EXEC_PROVIDER'}</Text>
            <View style={styles.row}>
              {(
                [
                  {key: 'auto', label: 'AUTO'},
                  {
                    key: 'gpu',
                    label: Platform.OS === 'ios' ? 'COREML' : 'GPU',
                  },
                  {key: 'cpu', label: 'CPU'},
                ] as const
              ).map(p => (
                <TouchableOpacity
                  key={p.key}
                  style={[
                    styles.optionBtn,
                    provider === p.key && styles.optionBtnActive,
                  ]}
                  onPress={() => setProvider(p.key)}
                  disabled={isRunning}>
                  <Text
                    style={[
                      styles.optionText,
                      provider === p.key && styles.optionTextActive,
                    ]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={[styles.runBtn, isRunning && styles.runBtnDisabled]}
              onPress={handleRun}
              disabled={isRunning || selectedEngines.size === 0}>
              <Text style={styles.runBtnText}>
                {isRunning ? '> RUNNING...' : '[ EXECUTE ]'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {isRunning && progress && (
          <View style={styles.card}>
            <Text style={styles.progressTitle}>
              {progress.engine.toUpperCase()}{' '}
              {progress.variant ? `(${progress.variant})` : ''}
            </Text>
            <Text style={styles.label}>
              {progress.isWarmup ? 'warmup' : 'iter'} {progress.iteration}/
              {progress.totalIterations} — engine {progress.engineIndex}/
              {progress.totalEngines}
            </Text>
            <Text
              style={[
                styles.phaseLabel,
                {color: progress.isWarmup ? C.amber : C.cyan},
              ]}>
              {progress.phase.toUpperCase()}
            </Text>
          </View>
        )}

        {error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>[ERROR] {error}</Text>
          </View>
        )}

        {results && results.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{'// RESULTS (p50 / p90)'}</Text>
            {results.map((summary, i) => (
              <View key={i} style={styles.card}>
                <Text style={styles.resultEngine}>
                  {summary.engine.toUpperCase()}
                  {summary.variant !== 'default' ? ` (${summary.variant})` : ''}
                </Text>

                <View style={styles.resultRow}>
                  <ResultCell
                    label="INIT"
                    value={`${summary.stats.initMs.median}ms`}
                  />
                  <ResultCell
                    label="TTFA"
                    value={`${summary.stats.ttfaMs.median}ms`}
                  />
                  <ResultCell
                    label="TOTAL"
                    value={`${summary.stats.totalSpeakMs.median}ms`}
                  />
                  <ResultCell
                    label="FREE"
                    value={`${summary.stats.releaseMs.median}ms`}
                  />
                </View>

                <View style={styles.resultRow}>
                  <ResultCell
                    label="p90"
                    value={`${summary.stats.initMs.p90}ms`}
                    dim
                  />
                  <ResultCell
                    label="p90"
                    value={`${summary.stats.ttfaMs.p90}ms`}
                    dim
                  />
                  <ResultCell
                    label="p90"
                    value={`${summary.stats.totalSpeakMs.p90}ms`}
                    dim
                  />
                  <ResultCell
                    label="p90"
                    value={`${summary.stats.releaseMs.p90}ms`}
                    dim
                  />
                </View>

                <View style={styles.resultRow}>
                  <ResultCell
                    label="MEM_LOAD"
                    value={`+${summary.averages.modelMemoryMB}MB`}
                  />
                  <ResultCell
                    label="MEM_INFER"
                    value={`+${summary.averages.inferMemoryMB}MB`}
                  />
                  {summary.stats.peakInitMemoryMB != null && (
                    <ResultCell
                      label="PEAK_INIT"
                      value={`${summary.stats.peakInitMemoryMB}MB`}
                    />
                  )}
                  {summary.stats.peakSpeakMemoryMB != null && (
                    <ResultCell
                      label="PEAK_INFER"
                      value={`${summary.stats.peakSpeakMemoryMB}MB`}
                    />
                  )}
                </View>

                <Text style={styles.iterHeader}>
                  {'// MEASURED_ITERATIONS'}
                </Text>
                {summary.iterations.map((iter, j) => (
                  <View key={j} style={styles.iterRow}>
                    <Text style={styles.iterLabel}>#{j + 1}</Text>
                    <Text style={styles.iterValue}>
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

                {summary.warmupIterations.length > 0 && (
                  <>
                    <Text style={styles.iterHeaderDim}>
                      {'// WARMUP (discarded)'}
                    </Text>
                    {summary.warmupIterations.map((iter, j) => (
                      <View key={`w${j}`} style={styles.iterRow}>
                        <Text style={styles.iterLabelDim}>W{j + 1}</Text>
                        <Text style={styles.iterValueDim}>
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
  dim?: boolean;
}> = ({label, value, dim}) => (
  <View style={styles.resultCell}>
    <Text style={[styles.resultValue, dim && styles.resultValueDim]}>
      {value}
    </Text>
    <Text style={styles.resultLabel}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.green,
    letterSpacing: 3,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 1,
    color: C.muted,
    marginTop: 16,
    marginBottom: 8,
  },
  card: {
    borderRadius: 4,
    padding: 12,
    marginBottom: 8,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.border,
  },
  centered: {
    alignItems: 'center',
    padding: 20,
    gap: 8,
  },
  label: {
    fontSize: 12,
    fontFamily: MONO,
    color: C.muted,
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
    borderRadius: 4,
    gap: 8,
  },
  checkRowActive: {
    backgroundColor: C.greenGhost,
  },
  checkBox: {
    fontFamily: MONO,
    fontSize: 12,
    color: C.green,
  },
  checkLabel: {
    fontSize: 12,
    fontFamily: MONO,
    color: C.green,
  },
  optionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  optionBtnActive: {
    borderColor: C.cyan,
    backgroundColor: C.cyanGhost,
  },
  optionBtnWarmup: {
    borderColor: C.amber,
    backgroundColor: C.amberGhost,
  },
  optionText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.muted,
  },
  optionTextActive: {
    color: C.cyan,
  },
  optionTextWarmup: {
    color: C.amber,
  },
  runBtn: {
    borderRadius: 4,
    padding: 14,
    alignItems: 'center',
    marginTop: 20,
    backgroundColor: C.greenGhost,
    borderWidth: 1,
    borderColor: C.greenBorder,
  },
  runBtnDisabled: {
    opacity: 0.3,
  },
  runBtnText: {
    color: C.green,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 1.5,
  },
  progressTitle: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.green,
    marginBottom: 4,
  },
  phaseLabel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    marginTop: 4,
    letterSpacing: 1,
  },
  errorCard: {
    borderRadius: 4,
    padding: 12,
    marginTop: 8,
    backgroundColor: C.redGhost,
    borderWidth: 1,
    borderColor: C.redBorder,
  },
  errorText: {
    color: C.red,
    fontSize: 12,
    fontFamily: MONO,
  },
  resultEngine: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.green,
    marginBottom: 10,
    letterSpacing: 0.5,
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
    fontSize: 12,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.green,
  },
  resultValueDim: {
    color: C.muted,
  },
  resultLabel: {
    fontSize: 9,
    fontFamily: MONO,
    color: C.muted,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  iterHeader: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.muted,
    marginTop: 10,
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  iterHeaderDim: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.greenBorder,
    marginTop: 10,
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  iterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  iterLabel: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    width: 24,
    color: C.muted,
  },
  iterValue: {
    fontSize: 11,
    fontFamily: MONO,
    color: C.greenDim,
  },
  iterLabelDim: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    width: 24,
    color: C.greenBorder,
  },
  iterValueDim: {
    fontSize: 11,
    fontFamily: MONO,
    color: C.greenBorder,
  },
});

export default BenchmarkView;
