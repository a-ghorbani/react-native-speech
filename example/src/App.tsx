import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import RootView from './views/RootView';
import BenchmarkView from './views/BenchmarkView';
import StreamingView from './views/StreamingView';
import {FRProvider} from 'react-native-full-responsive';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

type Tab = 'demo' | 'streaming' | 'benchmark';

const TABS: {key: Tab; label: string}[] = [
  {key: 'demo', label: 'DEMO'},
  {key: 'streaming', label: 'STREAM'},
  {key: 'benchmark', label: 'BENCH'},
];

function AppContent() {
  const [tab, setTab] = React.useState<Tab>('demo');
  const insets = useSafeAreaInsets();

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
        <BenchmarkView />
      </View>
      <View style={[styles.tabBar, {paddingBottom: insets.bottom || 4}]}>
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
                {t.label}
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
    backgroundColor: '#050505',
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
    borderTopColor: 'rgba(0,255,65,0.15)',
    paddingTop: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    gap: 5,
  },
  tabIndicator: {
    width: 20,
    height: 2,
    backgroundColor: 'transparent',
  },
  tabIndicatorActive: {
    backgroundColor: '#00FF41',
    shadowColor: '#00FF41',
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  tabText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Courier',
    letterSpacing: 2,
    color: 'rgba(0,255,65,0.3)',
  },
  tabTextActive: {
    color: '#00FF41',
  },
});
