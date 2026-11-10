import type {OnnxInferenceSession, OnnxTensor} from '../types/OnnxRuntime';
import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('RunAborter', 'Engine');

type Outputs = Record<string, OnnxTensor>;

/**
 * Ends an engine's in-flight model runs on stop() or release(), so the
 * next utterance's first run does not share the CPU with an abandoned
 * one (#97).
 *
 * Each run gets an AbortSignal. onnxruntime-react-native terminates a
 * run on abort only with the binding patch in docs/USAGE.md; without it
 * the signal is ignored and the run completes as before. The 1.23
 * bridge binding (no `globalThis.OrtApi`) gets no signal at all, since
 * it serialises run options for the native module.
 */
export class RunAborter {
  private readonly controllers = new Set<AbortController>();

  /** Resolves to the run's outputs, or null if the run was aborted. */
  async run(
    session: OnnxInferenceSession,
    feeds: Record<string, OnnxTensor>,
  ): Promise<Outputs | null> {
    if (!takesSignal()) {
      return session.run(feeds);
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await session.run(feeds, {signal: controller.signal});
    } catch (e) {
      if (controller.signal.aborted) {
        log.debug(`Run terminated on stop: ${String(e)}`);
        return null;
      }
      throw e;
    } finally {
      this.controllers.delete(controller);
    }
  }

  abortAll(): void {
    const running = [...this.controllers];
    this.controllers.clear();
    running.forEach(c => c.abort());
  }
}

function takesSignal(): boolean {
  return (
    typeof AbortController === 'function' &&
    (globalThis as {OrtApi?: unknown}).OrtApi != null
  );
}
