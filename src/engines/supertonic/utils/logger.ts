/**
 * Logger Utility for Supertonic TTS
 *
 * Provides consistent logging format across all Supertonic components.
 * All logs are prefixed with [Supertonic][Component] for easy filtering.
 */

/**
 * Available log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PREFIX = '[Supertonic]';

/**
 * Logger with consistent formatting for Supertonic components
 */
export const logger = {
  /**
   * Log debug message (for development/troubleshooting)
   */
  debug: (component: string, message: string, ...args: unknown[]): void => {
    console.log(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },

  /**
   * Log info message (general operational info)
   */
  info: (component: string, message: string, ...args: unknown[]): void => {
    console.log(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },

  /**
   * Log warning message (potential issues)
   */
  warn: (component: string, message: string, ...args: unknown[]): void => {
    console.warn(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },

  /**
   * Log error message (errors and failures)
   */
  error: (component: string, message: string, ...args: unknown[]): void => {
    console.error(`${LOG_PREFIX}[${component}] ${message}`, ...args);
  },
};

/**
 * Create a component-specific logger
 * @param component - Component name (e.g., 'Engine', 'Inference', 'StyleLoader')
 */
export function createLogger(component: string) {
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
