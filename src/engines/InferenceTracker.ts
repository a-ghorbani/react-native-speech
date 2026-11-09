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
   * Frees a detached session: now when no inference is running (an error
   * from `free` is thrown), otherwise once every inference tracked so far
   * has settled, without waiting for them (an error is then only logged).
   * Call it after detaching the session, so nothing started later uses it.
   */
  async freeWhenIdle(free: () => Promise<void>): Promise<void> {
    if (this.running.size === 0) {
      return free();
    }
    log.debug('Inference still running; freeing the session when it ends');
    Promise.allSettled([...this.running])
      .then(free)
      .catch(e => log.warn('Deferred session release failed:', e));
  }
}
