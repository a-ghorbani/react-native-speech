import {Platform} from 'react-native';

export const MONO = Platform.select({
  ios: 'Menlo',
  default: 'monospace',
});

export const C = {
  bg: '#050505',
  bgCard: 'rgba(0,255,65,0.03)',
  bgInput: 'rgba(0,255,65,0.05)',

  green: '#00FF41',
  greenDim: 'rgba(0,255,65,0.45)',
  greenFaint: 'rgba(0,255,65,0.2)',
  greenGhost: 'rgba(0,255,65,0.08)',
  greenBorder: 'rgba(0,255,65,0.12)',

  cyan: '#00D4FF',
  cyanDim: 'rgba(0,212,255,0.5)',
  cyanGhost: 'rgba(0,212,255,0.08)',
  cyanBorder: 'rgba(0,212,255,0.25)',

  red: '#FF0040',
  redGhost: 'rgba(255,0,64,0.08)',
  redBorder: 'rgba(255,0,64,0.25)',

  amber: '#FFB000',
  amberGhost: 'rgba(255,176,0,0.08)',
  amberBorder: 'rgba(255,176,0,0.25)',

  muted: 'rgba(0,255,65,0.35)',
  border: 'rgba(0,255,65,0.1)',
} as const;
