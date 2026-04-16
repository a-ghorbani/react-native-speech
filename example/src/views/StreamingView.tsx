import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  ActivityIndicator,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import Speech, {
  TTSEngine,
  type SpeechStream,
} from '@pocketpalai/react-native-speech';

const SAMPLE_TEXT =
  "Hello! How can I help you today? I am here to help. Let's walk " +
  'through a quick example together. Streaming tokens from a language ' +
  'model should sound smooth, not like three independent utterances ' +
  'separated by awkward pauses. With the new streaming API, short ' +
  'bursts still speak quickly, and longer text gets batched for more ' +
  'natural prosody.';

type Rate = {label: string; tokensPerSec: number};
const RATES: Rate[] = [
  {label: 'Slow (5 tok/s)', tokensPerSec: 5},
  {label: 'Medium (20 tok/s)', tokensPerSec: 20},
  {label: 'Fast (80 tok/s)', tokensPerSec: 80},
];

/** Chop a string into rough word-ish tokens so we can feed it at a rate. */
function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

interface StreamingViewProps {
  /**
   * True when the Streaming tab is the active one. Used to re-poll
   * engine readiness whenever the user lands on this tab, so we don't
   * show stale status after the engine was initialized on a sibling
   * tab (RootView) while this one was hidden.
   */
  visible?: boolean;
}

const StreamingView: React.FC<StreamingViewProps> = ({visible = true}) => {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const secondary = isDark ? '#8E8E93' : '#6D6D72';
  const cardBg = isDark ? '#1C1C1E' : '#F2F2F7';
  const inputBg = isDark ? '#3A3A3C' : '#E5E5EA';

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

  // Poll engine readiness whenever view becomes visible or streaming
  // state flips. Engines are initialized on the Demo tab; switching
  // to this tab should reflect the current engine without waiting for
  // the user to interact.
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
    <SafeAreaView
      style={[styles.container, {backgroundColor: isDark ? '#000' : '#fff'}]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, {color: textColor}]}>Streaming input</Text>
        <Text style={[styles.subtitle, {color: secondary}]}>
          Feeds text one token at a time into{' '}
          <Text style={styles.code}>Speech.createSpeechStream()</Text> to
          simulate an LLM token stream. The stream batches adaptively so
          playback stays smooth instead of sounding like per-sentence speaks.
        </Text>

        <View style={[styles.statusCard, {backgroundColor: cardBg}]}>
          <Text style={[styles.statusLabel, {color: secondary}]}>
            Active engine
          </Text>
          <Text style={[styles.statusValue, {color: textColor}]}>
            {engineName} {engineReady ? '✓' : '(not ready)'}
          </Text>
          {!engineReady && (
            <Text style={[styles.helpText, {color: secondary}]}>
              Open the Demo tab first to initialize an engine.
            </Text>
          )}
        </View>

        <Text style={[styles.sectionLabel, {color: secondary}]}>Text</Text>
        <TextInput
          style={[
            styles.textArea,
            {backgroundColor: inputBg, color: textColor},
          ]}
          value={text}
          onChangeText={setText}
          multiline
          editable={!isStreaming}
          placeholderTextColor={secondary}
        />

        <Text style={[styles.sectionLabel, {color: secondary}]}>
          Token rate
        </Text>
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
                  {
                    backgroundColor: selected ? '#007AFF' : inputBg,
                    opacity: isStreaming ? 0.5 : 1,
                  },
                ]}>
                <Text
                  style={[
                    styles.rateBtnText,
                    {color: selected ? '#fff' : textColor},
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
              {
                backgroundColor: '#34C759',
                opacity: !engineReady || isStreaming ? 0.5 : 1,
              },
            ]}>
            {isStreaming ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.actionBtnText}>Start streaming</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            disabled={!isStreaming}
            onPress={stopStreaming}
            style={[
              styles.actionBtn,
              {
                backgroundColor: '#FF3B30',
                opacity: isStreaming ? 1 : 0.5,
              },
            ]}>
            <Text style={styles.actionBtnText}>Stop</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.sectionLabel, {color: secondary}]}>
          Stream preview
        </Text>
        <View style={[styles.previewCard, {backgroundColor: cardBg}]}>
          <Text style={[styles.previewText, {color: textColor}]}>
            {streamedText}
            <Text style={[styles.previewPending, {color: secondary}]}>
              {pendingText}
            </Text>
          </Text>
        </View>

        {errorMsg && (
          <View style={[styles.errorCard, {backgroundColor: '#FF3B3020'}]}>
            <Text style={[styles.errorText, {color: '#FF3B30'}]}>
              {errorMsg}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1},
  scroll: {padding: 16, paddingBottom: 80},
  title: {fontSize: 22, fontWeight: '700', marginBottom: 4},
  subtitle: {fontSize: 14, lineHeight: 20, marginBottom: 16},
  code: {fontFamily: 'Menlo', fontSize: 13},
  statusCard: {padding: 12, borderRadius: 8, marginBottom: 16},
  statusLabel: {fontSize: 12, marginBottom: 2},
  statusValue: {fontSize: 16, fontWeight: '600'},
  helpText: {fontSize: 12, marginTop: 4},
  sectionLabel: {fontSize: 12, marginTop: 8, marginBottom: 4},
  textArea: {
    minHeight: 120,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  rateRow: {flexDirection: 'row', gap: 8, flexWrap: 'wrap'},
  rateBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  rateBtnText: {fontSize: 13, fontWeight: '600'},
  actionRow: {flexDirection: 'row', gap: 12, marginTop: 16},
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {color: '#fff', fontSize: 15, fontWeight: '600'},
  previewCard: {
    padding: 12,
    borderRadius: 8,
    minHeight: 80,
  },
  previewText: {fontSize: 14, lineHeight: 22},
  previewPending: {fontStyle: 'italic'},
  errorCard: {padding: 12, borderRadius: 8, marginTop: 12},
  errorText: {fontSize: 13},
});

export default StreamingView;
