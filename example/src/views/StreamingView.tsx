import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import Speech, {
  TTSEngine,
  type SpeechStream,
} from '@pocketpalai/react-native-speech';
import {C, MONO} from '../styles/cyber';

const SAMPLE_TEXT =
  "Hello! How can I help you today? I am here to help. Let's walk " +
  'through a quick example together. Streaming tokens from a language ' +
  'model should sound smooth, not like three independent utterances ' +
  'separated by awkward pauses. With the new streaming API, short ' +
  'bursts still speak quickly, and longer text gets batched for more ' +
  'natural prosody.';

type Rate = {label: string; tokensPerSec: number};
const RATES: Rate[] = [
  {label: '5 tok/s', tokensPerSec: 5},
  {label: '20 tok/s', tokensPerSec: 20},
  {label: '80 tok/s', tokensPerSec: 80},
];

function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

interface StreamingViewProps {
  visible?: boolean;
}

const StreamingView: React.FC<StreamingViewProps> = ({visible = true}) => {
  const [text, setText] = React.useState(SAMPLE_TEXT);
  const [rate, setRate] = React.useState<Rate>(RATES[1]!);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [streamedChars, setStreamedChars] = React.useState(0);
  const [engineName, setEngineName] = React.useState<TTSEngine>(
    Speech.getCurrentEngine(),
  );
  const [engineReady, setEngineReady] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const streamRef = React.useRef<SpeechStream | null>(null);
  const cancelledRef = React.useRef(false);

  React.useEffect(() => {
    if (!visible) return;
    let mounted = true;
    (async () => {
      const ready = await Speech.isReady();
      if (mounted) {
        setEngineReady(ready);
        setEngineName(Speech.getCurrentEngine());
      }
    })();
    return () => {
      mounted = false;
    };
  }, [isStreaming, visible]);

  const startStreaming = React.useCallback(async () => {
    if (isStreaming) return;
    setErrorMsg(null);
    cancelledRef.current = false;
    setStreamedChars(0);
    setIsStreaming(true);

    const tokens = tokenize(text);
    const intervalMs = 1000 / rate.tokensPerSec;

    const stream = Speech.createSpeechStream(undefined, {
      targetChars: 300,
      onError: err => {
        setErrorMsg(err.message);
      },
    });
    streamRef.current = stream;

    try {
      let pos = 0;
      for (const tok of tokens) {
        if (cancelledRef.current) break;
        stream.append(tok);
        pos += tok.length;
        setStreamedChars(pos);
        await new Promise(r => setTimeout(r, intervalMs));
      }
      if (!cancelledRef.current) {
        await stream.finalize();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      streamRef.current = null;
      setIsStreaming(false);
    }
  }, [isStreaming, rate, text]);

  const stopStreaming = React.useCallback(async () => {
    cancelledRef.current = true;
    const s = streamRef.current;
    if (s) {
      try {
        await s.cancel();
      } catch {
        // swallow
      }
    }
    setIsStreaming(false);
  }, []);

  const streamedText = text.slice(0, streamedChars);
  const pendingText = text.slice(streamedChars);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>STREAM_INPUT</Text>
        <Text style={styles.subtitle}>
          Feeds text one token at a time into{' '}
          <Text style={styles.code}>createSpeechStream()</Text> to simulate an
          LLM token stream. The engine's synth+play loop stays alive across
          chunks — no inter-batch gaps.
        </Text>

        <View style={styles.statusCard}>
          <Text style={styles.statusLabel}>{'// ACTIVE_ENGINE'}</Text>
          <Text style={styles.statusValue}>
            {engineName.toUpperCase()}{' '}
            {engineReady ? (
              <Text style={styles.statusOk}>[READY]</Text>
            ) : (
              <Text style={styles.statusErr}>[NOT_READY]</Text>
            )}
          </Text>
          {!engineReady && (
            <Text style={styles.helpText}>
              {'> '}Initialize an engine on the DEMO tab first.
            </Text>
          )}
        </View>

        <Text style={styles.sectionLabel}>{'// INPUT_BUFFER'}</Text>
        <TextInput
          style={styles.textArea}
          value={text}
          onChangeText={setText}
          multiline
          editable={!isStreaming}
          placeholderTextColor="rgba(0,255,65,0.2)"
        />

        <Text style={styles.sectionLabel}>{'// TOKEN_RATE'}</Text>
        <View style={styles.rateRow}>
          {RATES.map(r => {
            const selected = r.tokensPerSec === rate.tokensPerSec;
            return (
              <TouchableOpacity
                key={r.tokensPerSec}
                disabled={isStreaming}
                onPress={() => setRate(r)}
                style={[
                  styles.rateBtn,
                  selected && styles.rateBtnSelected,
                  isStreaming && styles.rateBtnDisabled,
                ]}>
                <Text
                  style={[
                    styles.rateBtnText,
                    selected && styles.rateBtnTextSelected,
                  ]}>
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            disabled={!engineReady || isStreaming}
            onPress={startStreaming}
            style={[
              styles.actionBtn,
              styles.actionBtnStart,
              (!engineReady || isStreaming) && styles.actionBtnDisabled,
            ]}>
            {isStreaming ? (
              <ActivityIndicator color="#00FF41" />
            ) : (
              <Text style={styles.actionBtnStartText}>EXECUTE</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            disabled={!isStreaming}
            onPress={stopStreaming}
            style={[
              styles.actionBtn,
              styles.actionBtnStop,
              !isStreaming && styles.actionBtnDisabled,
            ]}>
            <Text style={styles.actionBtnStopText}>ABORT</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionLabel}>{'// OUTPUT_STREAM'}</Text>
        <View style={styles.previewCard}>
          <Text style={styles.previewText}>
            {streamedText}
            <Text style={styles.previewPending}>{pendingText}</Text>
            {isStreaming && <Text style={styles.cursor}>_</Text>}
          </Text>
        </View>

        {errorMsg && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>[ERROR] {errorMsg}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: C.bg},
  scroll: {padding: 16, paddingBottom: 80},
  title: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: MONO,
    color: '#00FF41',
    letterSpacing: 3,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 16,
    color: 'rgba(0,255,65,0.5)',
    fontFamily: MONO,
  },
  code: {color: '#00D4FF'},
  statusCard: {
    padding: 12,
    borderRadius: 4,
    marginBottom: 16,
    backgroundColor: 'rgba(0,255,65,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,65,0.12)',
  },
  statusLabel: {
    fontSize: 10,
    color: 'rgba(0,255,65,0.35)',
    fontFamily: MONO,
    letterSpacing: 1,
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: MONO,
    color: '#00FF41',
  },
  statusOk: {color: '#00FF41'},
  statusErr: {color: '#FF0040'},
  helpText: {
    fontSize: 11,
    marginTop: 6,
    color: 'rgba(0,255,65,0.4)',
    fontFamily: MONO,
  },
  sectionLabel: {
    fontSize: 10,
    marginTop: 12,
    marginBottom: 6,
    color: 'rgba(0,255,65,0.35)',
    fontFamily: MONO,
    letterSpacing: 1,
  },
  textArea: {
    minHeight: 120,
    borderRadius: 4,
    padding: 12,
    fontSize: 13,
    fontFamily: MONO,
    textAlignVertical: 'top',
    color: '#00FF41',
    backgroundColor: 'rgba(0,255,65,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,65,0.12)',
  },
  rateRow: {flexDirection: 'row', gap: 8},
  rateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(0,255,65,0.12)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  rateBtnSelected: {
    borderColor: '#00FF41',
    backgroundColor: 'rgba(0,255,65,0.1)',
  },
  rateBtnDisabled: {opacity: 0.35},
  rateBtnText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    color: 'rgba(0,255,65,0.4)',
  },
  rateBtnTextSelected: {color: '#00FF41'},
  actionRow: {flexDirection: 'row', gap: 10, marginTop: 16},
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  actionBtnStart: {
    backgroundColor: 'rgba(0,255,65,0.08)',
    borderColor: 'rgba(0,255,65,0.3)',
  },
  actionBtnStartText: {
    color: '#00FF41',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 2,
  },
  actionBtnStop: {
    backgroundColor: 'rgba(255,0,64,0.08)',
    borderColor: 'rgba(255,0,64,0.3)',
  },
  actionBtnStopText: {
    color: '#FF0040',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 2,
  },
  actionBtnDisabled: {opacity: 0.35},
  previewCard: {
    padding: 12,
    borderRadius: 4,
    minHeight: 80,
    backgroundColor: 'rgba(0,255,65,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(0,255,65,0.12)',
  },
  previewText: {
    fontSize: 13,
    lineHeight: 22,
    fontFamily: MONO,
    color: '#00FF41',
  },
  previewPending: {color: 'rgba(0,255,65,0.15)'},
  cursor: {color: '#00D4FF', fontWeight: '700'},
  errorCard: {
    padding: 12,
    borderRadius: 4,
    marginTop: 12,
    backgroundColor: 'rgba(255,0,64,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,0,64,0.2)',
  },
  errorText: {
    fontSize: 12,
    color: '#FF0040',
    fontFamily: MONO,
  },
});

export default StreamingView;
