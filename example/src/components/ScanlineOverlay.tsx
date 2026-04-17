import React from 'react';
import {View, StyleSheet} from 'react-native';
import {C} from '../styles/cyber';

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
    backgroundColor: C.greenGhost,
  },
});

export default React.memo(ScanlineOverlay);
