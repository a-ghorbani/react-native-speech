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

const SAMPLE_TEXT = `# The Highly Scientific Guide to Procrastination

A **rigorous study** of how to accomplish absolutely nothing — *productively*. Conducted by experts (me) over many decades (since lunch).

---

## Why Procrastinate?

Procrastination is a **noble pursuit** practiced by some of history's greatest minds, including:

- Aristotle, probably.
- That one coworker who never replies to email.
- Most cats, professionally.
- You, right now, instead of doing the thing.

> "Why do today what you can put off until tomorrow, when tomorrow you can put it off until next week?" — *Anonymous, definitely not me*.

---

### The Four Classical Techniques

1. **The Tab Cascade**: open forty-seven browser tabs to "research" a topic. Close the laptop. Forget the topic.
2. **The Productive Detour**: decide to tidy your desk before starting work. Three hours later, your entire apartment is reorganized.
3. **The Power Nap Spiral**: lie down for a quick twenty minutes. Wake up four hours later, deeply confused about the date.
4. **The Snack Quest**: walk to the kitchen. Stare into the fridge. Walk back. Repeat as needed.

---

## Procrastinator Skill Levels

| Level | Title | Behavior |
|-------|--------------|--------------------------------------------------------|
| One | Rookie | Checks email instead of working. |
| Two | Amateur | Watches exactly one cat video, then a second, then nine. |
| Three | Intermediate | Alphabetizes the bookshelf for "clarity." |
| Four | Advanced | Learns the ukulele to avoid a single deadline. |
| Five | Grand Master | Writes elaborate guides about procrastination. |

---

### Warning Signs

You may be procrastinating if:

- You've brewed **three pots of coffee** before ten in the morning and produced zero results.
- Your to-do list now has its own to-do list.
- You are reading this guide right now, instead of the thing you are supposed to be doing.

> *"I will start first thing tomorrow"* — every Sunday evening, forever.

---

Remember: tomorrow is the busiest day of the week. Now go make another snack. You have earned it.`;

type Rate = {label: string; tokensPerSec: number};
const RATES: Rate[] = [
  {label: '1 tok/s', tokensPerSec: 1},
  {label: '5 tok/s', tokensPerSec: 5},
  {label: '20 tok/s', tokensPerSec: 20},
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
  const [voices, setVoices] = React.useState<Array<{id: string; name: string}>>(
    [],
  );
  const [selectedVoice, setSelectedVoice] = React.useState<string | null>(null);

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
        if (ready) {
          try {
            const meta = await Speech.getVoicesWithMetadata();
            if (mounted) {
              const v = meta.map((m: any) => ({
                id: m.id,
                name: m.name || m.id,
              }));
              setVoices(v);
              if (!selectedVoice && v.length > 0) {
                setSelectedVoice(v[0]!.id);
              }
            }
          } catch {
            const v = await Speech.getVoices();
            if (mounted) {
              setVoices(v.map(id => ({id, name: id})));
              if (!selectedVoice && v.length > 0) {
                setSelectedVoice(v[0]!);
              }
            }
          }
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [isStreaming, visible, selectedVoice]);

  const startStreaming = React.useCallback(async () => {
    if (isStreaming) return;
    setErrorMsg(null);
    cancelledRef.current = false;
    setStreamedChars(0);
    setIsStreaming(true);

    const tokens = tokenize(text);
    const intervalMs = 1000 / rate.tokensPerSec;

    const stream = Speech.createSpeechStream(selectedVoice || undefined, {
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
  }, [isStreaming, rate, text, selectedVoice]);

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

        {voices.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>{'// VOICE'}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.voiceRow}>
              {voices.map(v => (
                <TouchableOpacity
                  key={v.id}
                  disabled={isStreaming}
                  onPress={() => setSelectedVoice(v.id)}
                  style={[
                    styles.rateBtn,
                    selectedVoice === v.id && styles.rateBtnSelected,
                    isStreaming && styles.rateBtnDisabled,
                  ]}>
                  <Text
                    style={[
                      styles.rateBtnText,
                      selectedVoice === v.id && styles.rateBtnTextSelected,
                    ]}
                    numberOfLines={1}>
                    {v.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        )}

        <Text style={styles.sectionLabel}>{'// INPUT_BUFFER'}</Text>
        <TextInput
          style={styles.textArea}
          value={text}
          onChangeText={setText}
          multiline
          editable={!isStreaming}
          placeholderTextColor={C.greenBorder}
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
              <ActivityIndicator color={C.green} />
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
    color: C.green,
    letterSpacing: 3,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 16,
    color: C.greenDim,
    fontFamily: MONO,
  },
  code: {color: C.cyan},
  statusCard: {
    padding: 12,
    borderRadius: 4,
    marginBottom: 16,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.greenBorder,
  },
  statusLabel: {
    fontSize: 10,
    color: C.muted,
    fontFamily: MONO,
    letterSpacing: 1,
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.green,
  },
  statusOk: {color: C.green},
  statusErr: {color: C.red},
  helpText: {
    fontSize: 11,
    marginTop: 6,
    color: C.muted,
    fontFamily: MONO,
  },
  sectionLabel: {
    fontSize: 10,
    marginTop: 12,
    marginBottom: 6,
    color: C.muted,
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
    color: C.green,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.greenBorder,
  },
  voiceRow: {flexDirection: 'row', gap: 8, marginBottom: 4},
  rateRow: {flexDirection: 'row', gap: 8},
  rateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.greenBorder,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  rateBtnSelected: {
    borderColor: C.green,
    backgroundColor: C.greenGhost,
  },
  rateBtnDisabled: {opacity: 0.3},
  rateBtnText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: MONO,
    color: C.muted,
  },
  rateBtnTextSelected: {color: C.green},
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
    backgroundColor: C.greenGhost,
    borderColor: C.greenBorder,
  },
  actionBtnStartText: {
    color: C.green,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 2,
  },
  actionBtnStop: {
    backgroundColor: C.redGhost,
    borderColor: C.redBorder,
  },
  actionBtnStopText: {
    color: C.red,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 2,
  },
  actionBtnDisabled: {opacity: 0.3},
  previewCard: {
    padding: 12,
    borderRadius: 4,
    minHeight: 80,
    backgroundColor: C.bgCard,
    borderWidth: 1,
    borderColor: C.greenBorder,
  },
  previewText: {
    fontSize: 13,
    lineHeight: 22,
    fontFamily: MONO,
    color: C.green,
  },
  previewPending: {color: C.greenBorder},
  cursor: {color: C.cyan, fontWeight: '700'},
  errorCard: {
    padding: 12,
    borderRadius: 4,
    marginTop: 12,
    backgroundColor: C.redGhost,
    borderWidth: 1,
    borderColor: C.redBorder,
  },
  errorText: {
    fontSize: 12,
    color: C.red,
    fontFamily: MONO,
  },
});

export default StreamingView;
