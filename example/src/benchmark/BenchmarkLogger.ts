/**
 * Structured benchmark logger.
 * Emits machine-parseable [BENCH] JSON lines via native os_log/Log.i,
 * so they are always captured by log stream / logcat regardless of
 * debug/release build mode.
 *
 * These markers can be captured externally via:
 * - Android: `adb logcat | grep "\[BENCH\]"`
 * - iOS: `log stream --device <uuid> --predicate 'eventMessage CONTAINS "[BENCH]"'`
 */

import Benchmark from './NativeBenchmark';

export function emitBenchmark(event: string, data: Record<string, any>): void {
  const line = JSON.stringify({event, timestamp: Date.now(), ...data});
  // Emit through native os_log/Log.i (always captured by log stream/logcat)
  Benchmark.logMarker(line);
}

export function generateRunId(): string {
  return Math.random().toString(36).substring(2, 10);
}
