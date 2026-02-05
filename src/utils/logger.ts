/**
 * Logger Utility for Neural TTS Engines
 *
 * Provides consistent logging format across all TTS components.
 * All logs are prefixed with [EngineName][Component] for easy filtering.
 *
 * In production builds (__DEV__ = false), debug logs are suppressed.
 */

/**
 * Available log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Check if we're in development mode
 * Falls back to true if __DEV__ is not defined (e.g., in tests)
 */
const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

/**
 * Create a logger for a specific engine/module
 *
 * @param prefix - Module prefix (e.g., 'Kokoro', 'Supertonic')
 * @returns Logger object with debug, info, warn, error methods
 *
 * @example
 * const log = createLogger('Kokoro');
 * log.debug('Engine', 'Initializing...');
 * // Output: [Kokoro][Engine] Initializing...
 */
export function createLogger(prefix: string) {
  const LOG_PREFIX = `[${prefix}]`;

  return {
    /**
     * Log debug message (only in development)
     */
    debug: (component: string, message: string, ...args: unknown[]): void => {
      if (isDev) {
        console.log(`${LOG_PREFIX}[${component}] ${message}`, ...args);
      }
    },

    /**
     * Log info message
     */
    info: (component: string, message: string, ...args: unknown[]): void => {
      console.log(`${LOG_PREFIX}[${component}] ${message}`, ...args);
    },

    /**
     * Log warning message
     */
    warn: (component: string, message: string, ...args: unknown[]): void => {
      console.warn(`${LOG_PREFIX}[${component}] ${message}`, ...args);
    },

    /**
     * Log error message
     */
    error: (component: string, message: string, ...args: unknown[]): void => {
      console.error(`${LOG_PREFIX}[${component}] ${message}`, ...args);
    },
  };
}

/**
 * Create a component-scoped logger
 *
 * @param prefix - Module prefix (e.g., 'Kokoro')
 * @param component - Component name (e.g., 'Engine', 'VoiceLoader')
 * @returns Logger object with debug, info, warn, error methods (no component param needed)
 *
 * @example
 * const log = createComponentLogger('Kokoro', 'Engine');
 * log.debug('Initializing...');
 * // Output: [Kokoro][Engine] Initializing...
 */
export function createComponentLogger(prefix: string, component: string) {
  const logger = createLogger(prefix);

  return {
    debug: (message: string, ...args: unknown[]) =>
      logger.debug(component, message, ...args),
    info: (message: string, ...args: unknown[]) =>
      logger.info(component, message, ...args),
    warn: (message: string, ...args: unknown[]) =>
      logger.warn(component, message, ...args),
    error: (message: string, ...args: unknown[]) =>
      logger.error(component, message, ...args),
  };
}

// Pre-configured loggers for neural TTS engines
export const kokoroLogger = createLogger('Kokoro');
export const supertonicLogger = createLogger('Supertonic');
