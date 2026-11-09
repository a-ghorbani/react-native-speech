/**
 * Records every PCM chunk the JS engines hand to native playback
 * (RNSpeech.playAudio): its duration, call time and settle time. Must be
 * imported before the library, which captures `playAudio` at load
 * (index.js imports it first). Phonon plays natively and is not seen here.
 */
import {TurboModuleRegistry} from 'react-native';
import {base64Bytes, pcm16Ms} from './edgesCore';

export interface PlayCall {
  seq: number;
  calledAt: number;
  settledAt?: number;
  outcome?: 'resolved' | 'rejected';
  bytes: number;
  sampleRate: number;
  channels: number;
  pcmMs: number;
}

type Listener = (call: PlayCall, phase: 'call' | 'settle') => void;

const listeners = new Set<Listener>();
let seq = 0;
let installed = false;

function install(): void {
  const mod = TurboModuleRegistry.get('RNSpeech') as unknown as {
    playAudio?: (
      data: string,
      config: Record<string, unknown>,
    ) => Promise<void>;
  } | null;
  const original = mod?.playAudio;
  if (!mod || typeof original !== 'function') {
    return;
  }
  const tapped = (data: string, config: Record<string, unknown>) => {
    const sampleRate = Number(config?.sampleRate ?? 24000);
    const channels = Number(config?.channels ?? 1);
    const bytes = base64Bytes(data);
    const call: PlayCall = {
      seq: ++seq,
      calledAt: Date.now(),
      bytes,
      sampleRate,
      channels,
      pcmMs: pcm16Ms(bytes, sampleRate, channels),
    };
    listeners.forEach(l => l(call, 'call'));
    const settle = (outcome: 'resolved' | 'rejected') => {
      call.settledAt = Date.now();
      call.outcome = outcome;
      listeners.forEach(l => l(call, 'settle'));
    };
    return original.call(mod, data, config).then(
      v => {
        settle('resolved');
        return v;
      },
      e => {
        settle('rejected');
        throw e;
      },
    );
  };
  try {
    mod.playAudio = tapped;
    installed = mod.playAudio === tapped;
  } catch {
    installed = false;
  }
}

install();

export function isPlaybackTapInstalled(): boolean {
  return installed;
}

export function onPlayCall(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
