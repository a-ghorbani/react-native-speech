/**
 * TTS Engine Manager
 *
 * Manages multiple TTS engines and provides a unified interface
 */

import type {TTSEngine, TTSEngineInterface, EngineStatus} from '../types';

class TTSEngineManager {
  private engines: Map<TTSEngine, TTSEngineInterface> = new Map();
  private defaultEngine: TTSEngine = 'os-native' as TTSEngine;
  private initialized: Set<TTSEngine> = new Set();

  /**
   * Register a TTS engine
   */
  registerEngine(engine: TTSEngineInterface): void {
    this.engines.set(engine.name, engine);
  }

  /**
   * Get an engine by name
   */
  getEngine(name: TTSEngine): TTSEngineInterface {
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
  async initializeEngine(name: TTSEngine, config?: any): Promise<void> {
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
        console.warn(`Failed to destroy engine ${engine.name}:`, err);
      }),
    );

    await Promise.all(promises);
    this.engines.clear();
    this.initialized.clear();
  }
}

// Singleton instance
export const engineManager = new TTSEngineManager();
