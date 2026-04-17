import React from 'react';
import {View, StyleSheet} from 'react-native';

const LINE_COUNT = 60;
const lines = Array.from({length: LINE_COUNT});

const ScanlineOverlay: React.FC = () => (
  <View style={styles.container} pointerEvents="none">
    {lines.map((_, i) => (
      <View key={i} style={styles.line} />
    ))}
  </View>
);

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    zIndex: 999,
  },
  line: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(0,255,65,0.04)',
  },
});

export default React.memo(ScanlineOverlay);
