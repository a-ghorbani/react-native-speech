import {NativeModules} from 'react-native';

export interface OutputInfo {
  /** iOS AVAudioSession.outputLatency; Android AudioManager.getOutputLatency (hidden API, -1 if blocked) */
  outputLatencyMs: number;
  /** Android: playback head minus presented frame (AudioTrack.getTimestamp) of a silent probe track; -1 if unavailable */
  probeLatencyMs: number;
  /** iOS IOBufferDuration; Android PROPERTY_OUTPUT_FRAMES_PER_BUFFER at the native rate */
  bufferMs: number;
  sampleRate: number;
  route: string[];
}

export interface RecordProbeResult {
  started: boolean;
  bytes: number;
  error?: string;
  /** iOS: category before the probe, restored afterwards */
  previousCategory?: string;
}

/** Android player states: 2 started, 3 paused, 4 stopped, -1 unreadable. */
export interface FocusProbeResult {
  granted?: boolean;
  before?: number[];
  samples?: Array<{t: number; players: number[]}>;
}

interface PlaybackProbeModule {
  getOutputInfo(): Promise<OutputInfo>;
  /**
   * iOS: posts AVAudioSessionInterruptionNotification began, then ended
   * with ShouldResume after `holdMs`. Android: holds an AudioFocusRequest
   * of `kind` ('gain' | 'transient' | 'duck' | 'notification', the last
   * being a notification's MAY_DUCK request) for `holdMs`, sampling the
   * library's speech player states.
   */
  interrupt(kind: string, holdMs: number): Promise<FocusProbeResult>;
  /** Android: posts a default-sound notification, kept for `holdMs`. */
  postNotification?(holdMs: number): Promise<
    FocusProbeResult & {
      enabled: boolean;
      ringerMode: number;
      interruptionFilter: number;
    }
  >;
  /**
   * iOS: overrideOutputAudioPort speaker, then none after `holdMs`.
   * Android: audio mode IN_COMMUNICATION for `holdMs`, then restored.
   */
  routeChange(
    holdMs: number,
  ): Promise<{before: string[]; during: string[]; after: string[]}>;
  /** Starts a microphone recording for `ms` and stops it. */
  recordProbe(ms: number): Promise<RecordProbeResult>;
}

const {RNPlaybackProbe} = NativeModules;
export default (RNPlaybackProbe ?? null) as PlaybackProbeModule | null;
