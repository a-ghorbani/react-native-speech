import {Platform} from 'react-native';

export const MONO = Platform.select({
  ios: 'Menlo',
  default: 'monospace',
});

export const C = {
  bg: '#1e2127',
  bgCard: 'rgba(152,195,121,0.04)',
  bgInput: 'rgba(152,195,121,0.06)',

  green: '#98c379',
  greenDim: 'rgba(152,195,121,0.55)',
  greenFaint: 'rgba(152,195,121,0.25)',
  greenGhost: 'rgba(152,195,121,0.08)',
  greenBorder: 'rgba(152,195,121,0.15)',

  cyan: '#56b6c2',
  cyanDim: 'rgba(86,182,194,0.55)',
  cyanGhost: 'rgba(86,182,194,0.08)',
  cyanBorder: 'rgba(86,182,194,0.25)',

  red: '#e06c75',
  redGhost: 'rgba(224,108,117,0.08)',
  redBorder: 'rgba(224,108,117,0.25)',

  amber: '#e5c07b',
  amberGhost: 'rgba(229,192,123,0.08)',
  amberBorder: 'rgba(229,192,123,0.25)',

  muted: 'rgba(152,195,121,0.4)',
  border: 'rgba(152,195,121,0.1)',
} as const;
