import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('InferenceTracker', 'Engine');

/**
 * Keeps track of the model inferences an engine has started, so the model
 * session is freed only after every one of them has settled. A call that
 * started an inference can end before it does (stop races, a prefetched
 * chunk abandoned on stop, a cancelled stream), so the inference itself is
 * tracked, not the call.
 */
export class InferenceTracker {
  private readonly running = new Set<Promise<unknown>>();

  track<T>(inference: Promise<T>): Promise<T> {
    this.running.add(inference);
    const done = () => {
      this.running.delete(inference);
    };
    inference.then(done, done);
    return inference;
  }

  /**
   * Runs `free` once every inference tracked so far has settled; call it
   * after detaching the session, so nothing started later can use it.
   * Waits at most `timeoutMs`: past that it resolves, and `free` still runs
   * when the inferences settle (its error is then only logged). An error
   * from a `free` that ran within the wait is thrown.
   */
  async freeWhenIdle(
    free: () => Promise<void>,
    timeoutMs = 5000,
  ): Promise<void> {
    const freed = Promise.allSettled([...this.running])
      .then(free)
      .then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      if (!(await Promise.race([freed, timedOut]))) {
        log.warn(
          `Inference still running after ${timeoutMs} ms; freeing the session when it ends`,
        );
        freed.catch(e => log.warn('Deferred session release failed:', e));
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
