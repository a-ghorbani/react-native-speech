import {NativeModules, Platform} from 'react-native';

/**
 * Android: runs a mediaPlayback foreground service, so neural synthesis keeps
 * the foreground cores with the screen off (docs/USAGE.md, "Background
 * playback on Android"). Turn it on from the foreground; Android refuses to start it from
 * the background. Other platforms: no-op.
 */
export async function setBackgroundPlayback(enabled: boolean): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  const {BackgroundPlayback} = NativeModules;
  await (enabled ? BackgroundPlayback.start() : BackgroundPlayback.stop());
}
