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
import {SafeAreaProvider} from 'react-native-safe-area-context';

type Tab = 'demo' | 'streaming' | 'benchmark';

export default function App() {
  const [tab, setTab] = React.useState<Tab>('demo');
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const barBg = isDark ? '#1C1C1E' : '#F2F2F7';
  const activeColor = '#007AFF';
  const inactiveColor = isDark ? '#8E8E93' : '#6D6D72';

  return (
    <SafeAreaProvider>
      <FRProvider>
        <View style={styles.container}>
          {tab === 'demo' ? (
            <RootView />
          ) : tab === 'streaming' ? (
            <StreamingView />
          ) : (
            <BenchmarkView />
          )}
          <View style={[styles.tabBar, {backgroundColor: barBg}]}>
            <TouchableOpacity
              style={styles.tabItem}
              onPress={() => setTab('demo')}>
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
      </FRProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
