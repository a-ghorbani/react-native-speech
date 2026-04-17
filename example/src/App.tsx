import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
} from 'react-native';
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
  {key: 'demo', label: 'Demo'},
  {key: 'streaming', label: 'Streaming'},
  {key: 'benchmark', label: 'Benchmark'},
];

function AppContent() {
  const [tab, setTab] = React.useState<Tab>('demo');
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const insets = useSafeAreaInsets();

  const barBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const activeColor = '#007AFF';
  const inactiveColor = isDark ? '#636366' : '#8E8E93';
  const borderColor = isDark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.18)';

  return (
    <View
      style={[
        styles.container,
        {backgroundColor: isDark ? '#000' : '#F2F2F7'},
      ]}>
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
      <View
        style={[
          styles.tabBar,
          {
            backgroundColor: barBg,
            paddingBottom: insets.bottom,
            borderTopColor: borderColor,
          },
        ]}>
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
                  styles.tabDot,
                  {backgroundColor: isActive ? activeColor : 'transparent'},
                ]}
              />
              <Text
                style={[
                  styles.tabText,
                  {color: isActive ? activeColor : inactiveColor},
                ]}>
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
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    gap: 4,
  },
  tabDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  tabText: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.1,
  },
});
