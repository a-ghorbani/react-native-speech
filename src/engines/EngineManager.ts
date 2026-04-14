/**
 * TTS Engine Manager
 *
 * Manages multiple TTS engines and provides a unified interface
 */

import type {TTSEngine, TTSEngineInterface, EngineStatus} from '../types';
import {createComponentLogger} from '../utils/logger';

const log = createComponentLogger('EngineManager', 'Manager');

// Stored engines are of unknown config; callers provide the config type per-call.
type AnyEngine = TTSEngineInterface<unknown>;

class TTSEngineManager {
  private engines: Map<TTSEngine, AnyEngine> = new Map();
  private defaultEngine: TTSEngine = 'os-native' as TTSEngine;
  private initialized: Set<TTSEngine> = new Set();

  /**
   * Register a TTS engine
   */
  registerEngine<TConfig>(engine: TTSEngineInterface<TConfig>): void {
    this.engines.set(engine.name, engine as AnyEngine);
  }

  /**
   * Get an engine by name
   */
  getEngine(name: TTSEngine): AnyEngine {
    const engine = this.engines.get(name);
    if (!engine) {
      throw new Error(`Engine '${name}' not registered`);
    }
    return engine;
  }

  /**
   * Check if engine is registered
   */
  hasEngine(name: TTSEngine): boolean {
    return this.engines.has(name);
  }

  /**
   * Get all registered engines
   */
  getAvailableEngines(): TTSEngine[] {
    return Array.from(this.engines.keys());
  }

  /**
   * Set default engine
   */
  setDefaultEngine(name: TTSEngine): void {
    if (!this.hasEngine(name)) {
      throw new Error(`Engine '${name}' not registered`);
    }
    this.defaultEngine = name;
  }

  /**
   * Get default engine
   */
  getDefaultEngine(): TTSEngine {
    return this.defaultEngine;
  }

  /**
   * Initialize an engine (lazy initialization)
   */
  async initializeEngine<TConfig>(
    name: TTSEngine,
    config?: TConfig,
  ): Promise<void> {
    if (this.initialized.has(name)) {
      return; // Already initialized
    }

    const engine = this.getEngine(name);

    // Initialize with config if provided, otherwise no arguments
    if (config !== undefined) {
      await engine.initialize(config);
    } else {
      await engine.initialize();
    }

    this.initialized.add(name);
  }

  /**
   * Force re-initialization of an engine with new config
   * Destroys existing engine state and re-initializes
   */
  async reinitializeEngine<TConfig>(
    name: TTSEngine,
    config?: TConfig,
  ): Promise<void> {
    const engine = this.getEngine(name);

    // Destroy existing state
    await engine.destroy();
    this.initialized.delete(name);

    // Re-initialize with new config
    if (config !== undefined) {
      await engine.initialize(config);
    } else {
      await engine.initialize();
    }

    this.initialized.add(name);
  }

  /**
   * Check if engine is initialized
   */
  isEngineInitialized(name: TTSEngine): boolean {
    return this.initialized.has(name);
  }

  /**
   * Get engine status
   */
  async getEngineStatus(name: TTSEngine): Promise<EngineStatus> {
    if (!this.hasEngine(name)) {
      return {
        isReady: false,
        isLoading: false,
        error: `Engine '${name}' not registered`,
      };
    }

    const engine = this.getEngine(name);
    const isReady = await engine.isReady();

    return {
      isReady,
      isLoading: false, // We don't track loading state at manager level
      error: undefined,
    };
  }

  /**
   * Destroy all engines
   */
  async destroyAll(): Promise<void> {
    const promises = Array.from(this.engines.values()).map(engine =>
      engine.destroy().catch(err => {
        log.warn(`Failed to destroy engine ${engine.name}:`, err);
      }),
    );

    await Promise.all(promises);
    this.engines.clear();
    this.initialized.clear();
  }
}

// Singleton instance
export const engineManager = new TTSEngineManager();
