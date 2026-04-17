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

function AppContent() {
  const [tab, setTab] = React.useState<Tab>('demo');
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const insets = useSafeAreaInsets();

  const barBg = isDark ? '#1C1C1E' : '#F2F2F7';
  const activeColor = '#007AFF';
  const inactiveColor = isDark ? '#8E8E93' : '#6D6D72';

  return (
    <View style={styles.container}>
      {/*
        Keep all tabs mounted and toggle visibility. Conditional
        rendering would unmount the active view, and RootView's
        release-on-unmount cleanup (intended for app close /
        background) would release the neural engine every time the
        user switches tabs — breaking streaming + benchmark flows.
      */}
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
          {backgroundColor: barBg, paddingBottom: insets.bottom},
        ]}>
        <TouchableOpacity style={styles.tabItem} onPress={() => setTab('demo')}>
          <Text
            style={[
              styles.tabText,
              {color: tab === 'demo' ? activeColor : inactiveColor},
            ]}>
            Demo
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabItem}
          onPress={() => setTab('streaming')}>
          <Text
            style={[
              styles.tabText,
              {color: tab === 'streaming' ? activeColor : inactiveColor},
            ]}>
            Streaming
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabItem}
          onPress={() => setTab('benchmark')}>
          <Text
            style={[
              styles.tabText,
              {color: tab === 'benchmark' ? activeColor : inactiveColor},
            ]}>
            Benchmark
          </Text>
        </TouchableOpacity>
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
    borderTopColor: '#3C3C43',
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
