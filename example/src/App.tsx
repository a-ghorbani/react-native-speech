import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Linking} from 'react-native';
import RootView from './views/RootView';
import BenchmarkView from './views/BenchmarkView';
import StreamingView from './views/StreamingView';
import {FRProvider} from 'react-native-full-responsive';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {C, MONO} from './styles/cyber';
import {
  isPhononSelfTestRunning,
  parseSelfTestUrl,
  resumePhononSelfTestAfterReload,
  runPhononSelfTest,
} from './selftest/phononSelfTest';

type Tab = 'demo' | 'streaming' | 'benchmark';

const TABS: {key: Tab; label: string}[] = [
  {key: 'demo', label: 'SYS'},
  {key: 'streaming', label: 'STRM'},
  {key: 'benchmark', label: 'PERF'},
];

function AppContent() {
  const [tab, setTab] = React.useState<Tab>('demo');
  const insets = useSafeAreaInsets();

  // Self-test deep link (adb `am start -d <url>` / devicectl `--payload-url`).
  React.useEffect(() => {
    const handle = (url: string | null | undefined) => {
      const params = url ? parseSelfTestUrl(url) : null;
      if (!params) return;
      if (isPhononSelfTestRunning()) {
        console.log('[SelfTest] already running; ignored', url);
        return;
      }
      runPhononSelfTest(params, {showTab: setTab}).catch(err =>
        console.log(`[SelfTest] SELFTEST_DONE error=${String(err)}`),
      );
    };
    // A run that reloaded JS (S11) resumes; its initial URL must not restart it.
    resumePhononSelfTestAfterReload({showTab: setTab})
      .then(resumed => (resumed ? null : Linking.getInitialURL()))
      .then(handle)
      .catch(() => {});
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.tabContent,
          tab === 'demo' ? styles.tabVisible : styles.tabHidden,
        ]}>
        <RootView />
      </View>
      <View
        style={[
          styles.tabContent,
          tab === 'streaming' ? styles.tabVisible : styles.tabHidden,
        ]}>
        <StreamingView visible={tab === 'streaming'} />
      </View>
      <View
        style={[
          styles.tabContent,
          tab === 'benchmark' ? styles.tabVisible : styles.tabHidden,
        ]}>
        <BenchmarkView visible={tab === 'benchmark'} />
      </View>
      <View style={[styles.tabBar, {paddingBottom: insets.bottom || 6}]}>
        {TABS.map(t => {
          const isActive = tab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={styles.tabItem}
              onPress={() => setTab(t.key)}
              activeOpacity={0.6}>
              <View
                style={[
                  styles.tabIndicator,
                  isActive && styles.tabIndicatorActive,
                ]}
              />
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {isActive ? `> ${t.label}` : `  ${t.label}`}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <FRProvider>
        <AppContent />
      </FRProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },
  tabContent: {
    flex: 1,
  },
  tabVisible: {
    display: 'flex',
  },
  tabHidden: {
    display: 'none',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 10,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
    gap: 6,
  },
  tabIndicator: {
    width: 16,
    height: 1,
    backgroundColor: 'transparent',
  },
  tabIndicatorActive: {
    backgroundColor: C.green,
    shadowColor: C.green,
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 1,
    shadowRadius: 6,
  },
  tabText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 2.5,
    color: C.muted,
  },
  tabTextActive: {
    color: C.green,
  },
});
