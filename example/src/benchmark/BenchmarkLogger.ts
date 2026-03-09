/**
 * Structured benchmark logger.
 * Emits machine-parseable [BENCH] JSON lines via console.log.
 *
 * These markers can be captured externally via:
 * - Android: `adb logcat | grep "\[BENCH\]"`
 * - iOS: `log stream --predicate 'eventMessage CONTAINS "[BENCH]"'`
 */

const BENCH_PREFIX = '[BENCH]';

export function emitBenchmark(event: string, data: Record<string, any>): void {
  const line = JSON.stringify({event, timestamp: Date.now(), ...data});
  console.log(`${BENCH_PREFIX} ${line}`);
}

export function generateRunId(): string {
  return Math.random().toString(36).substring(2, 10);
}
