/**
 * Engine visibility for the example UI.
 *
 * Engines that can be missing from a build or unsupported on a device
 * (today: Phonon) are probed with `Speech.getEngineSupport` and shown only
 * when supported. An unsupported engine renders nothing: no chip, no
 * model card, no dialog; one `[Phonon] hidden: <reason>` console line.
 */

import React from 'react';
import Speech, {
  TTSEngine,
  type EngineId,
} from '@pocketpalai/react-native-speech';
import {PHONON} from '@pocketpalai/react-native-speech-phonon';

export interface EngineSupportState {
  supported: boolean;
  reason: string;
  detail?: string;
}

export type EngineSupportMap = Partial<Record<EngineId, EngineSupportState>>;

/** Engines whose availability depends on the build/device. */
export const PROBED_ENGINES: readonly EngineId[] = [PHONON];

const LOG_TAG: Partial<Record<EngineId, string>> = {
  [PHONON]: 'Phonon',
};

/**
 * Whether `engine` should be shown. Probed engines are hidden until a
 * probe says `supported` (so nothing flashes on screen while probing);
 * every other engine is always shown.
 */
export function isEngineVisible(
  engine: EngineId,
  supportMap: EngineSupportMap,
): boolean {
  if (!PROBED_ENGINES.includes(engine)) {
    return true;
  }
  return supportMap[engine]?.supported === true;
}

/** Filter a list of engines (or items carrying an `engine`) by support. */
export function visibleEngines<T extends EngineId | {engine: EngineId}>(
  all: readonly T[],
  supportMap: EngineSupportMap,
): T[] {
  return all.filter(item =>
    isEngineVisible(
      typeof item === 'string' ? (item as EngineId) : item.engine,
      supportMap,
    ),
  );
}

const loggedHidden = new Set<string>();

/** One info line per engine and reason per process. */
function logHidden(engine: EngineId, state: EngineSupportState): void {
  const key = `${engine}:${state.reason}`;
  if (loggedHidden.has(key)) {
    return;
  }
  loggedHidden.add(key);
  const tag = LOG_TAG[engine] ?? engine;
  console.log(
    `[${tag}] hidden: ${state.reason}${state.detail ? ` (${state.detail})` : ''}`,
  );
}

/** @internal test hook */
export function resetHiddenLog(): void {
  loggedHidden.clear();
}

/** Probe `engines`; never throws (a failed probe counts as unsupported). */
export async function probeEngineSupport(
  engines: readonly EngineId[] = PROBED_ENGINES,
): Promise<EngineSupportMap> {
  const entries = await Promise.all(
    engines.map(async engine => {
      let state: EngineSupportState;
      try {
        const res = await Speech.getEngineSupport(engine);
        state = {
          supported: res.supported === true,
          reason: res.reason,
          detail: res.detail,
        };
      } catch (e) {
        state = {
          supported: false,
          reason: 'error',
          detail: e instanceof Error ? e.message : String(e),
        };
      }
      if (!state.supported) {
        logHidden(engine, state);
      }
      return [engine, state] as const;
    }),
  );
  const map: EngineSupportMap = {};
  for (const [engine, state] of entries) {
    map[engine] = state;
  }
  return map;
}

/** True for the error `Speech.initialize` rejects with on an unsupported engine. */
export function isEngineUnsupportedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: unknown}).code === 'ERR_PHONON_UNSUPPORTED'
  );
}

/** `error.code` when it is a string, else 'ERR'. */
export function errorCodeOf(error: unknown): string {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === 'string' ? code : 'ERR';
}

/** What the UI does when `Speech.initialize` rejects. */
export type EngineInitFailure =
  /** Hide the engine and switch back to `fallbackTo` (no dialog) */
  | {action: 'hide'; reason: string; fallbackTo: EngineId}
  /** Show `message` in the engine's diagnostics line (no dialog) */
  | {action: 'diag'; message: string}
  /** Generic initialization dialog (engines that are always available) */
  | {action: 'alert'; message: string};

/**
 * Decide how to surface an init failure. Probed engines (Phonon) never
 * get a dialog: an `ERR_PHONON_UNSUPPORTED` rejection, or a re-probe
 * (`refreshed`, taken after the failure) that no longer says supported,
 * hides the engine and falls back to `previousEngine`; any other error
 * goes to the diagnostics line.
 */
export function engineInitFailure(
  engine: EngineId,
  error: unknown,
  refreshed: EngineSupportMap | null,
  previousEngine: EngineId,
): EngineInitFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (!PROBED_ENGINES.includes(engine)) {
    return {action: 'alert', message};
  }
  const state = refreshed?.[engine];
  if (isEngineUnsupportedError(error) || state?.supported !== true) {
    return {
      action: 'hide',
      reason: state && !state.supported ? state.reason : 'unsupported',
      fallbackTo: previousEngine === engine ? TTSEngine.KITTEN : previousEngine,
    };
  }
  return {action: 'diag', message: `${errorCodeOf(error)}: ${message}`};
}

/** Mark `engine` unsupported after a failed init (e.g. a load failure). */
export function markUnsupported(
  map: EngineSupportMap,
  engine: EngineId,
  reason: string,
  detail?: string,
): EngineSupportMap {
  const state: EngineSupportState = {supported: false, reason, detail};
  logHidden(engine, state);
  return {...map, [engine]: state};
}

/**
 * Probe once on mount. `refresh()` re-probes (e.g. after an init failure
 * recorded a negative capability natively); `hide()` hides an engine now.
 */
export function useEngineSupport(
  engines: readonly EngineId[] = PROBED_ENGINES,
): {
  supportMap: EngineSupportMap;
  probed: boolean;
  refresh: () => Promise<EngineSupportMap>;
  hide: (engine: EngineId, reason: string, detail?: string) => void;
} {
  const [supportMap, setSupportMap] = React.useState<EngineSupportMap>({});
  const [probed, setProbed] = React.useState(false);
  const key = engines.join(',');

  const refresh = React.useCallback(async () => {
    const map = await probeEngineSupport(
      key ? (key.split(',') as EngineId[]) : [],
    );
    setSupportMap(map);
    setProbed(true);
    return map;
  }, [key]);

  const hide = React.useCallback(
    (engine: EngineId, reason: string, detail?: string) =>
      setSupportMap(prev => markUnsupported(prev, engine, reason, detail)),
    [],
  );

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return {supportMap, probed, refresh, hide};
}
