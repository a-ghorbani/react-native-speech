/**
 * Logger Utility for Supertonic TTS
 *
 * Re-exports the shared logger configured for Supertonic.
 * All logs are prefixed with [Supertonic][Component] for easy filtering.
 */

import {
  createLogger as createSharedLogger,
  createComponentLogger,
  supertonicLogger,
} from '../../../utils/logger';

// Re-export types
export type {LogLevel} from '../../../utils/logger';

// Pre-configured Supertonic logger
export const logger = supertonicLogger;

/**
 * Create a component-specific logger for Supertonic
 * @param component - Component name (e.g., 'Engine', 'Inference', 'StyleLoader')
 */
export function createLogger(component: string) {
  return createComponentLogger('Supertonic', component);
}

// Also export the shared createLogger for backward compatibility
export {createSharedLogger};
