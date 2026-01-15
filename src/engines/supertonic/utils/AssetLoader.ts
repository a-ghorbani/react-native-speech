/**
 * Asset Loader for Supertonic
 *
 * Utilities for loading model files and assets
 * Supports both local file:// URLs and remote https:// URLs
 */

/**
 * Load asset as ArrayBuffer
 * Supports file:// URLs for local files
 */
export async function loadAssetAsArrayBuffer(
  path: string,
): Promise<ArrayBuffer> {
  try {
    // Use fetch for file:// URLs
    if (path.startsWith('file://')) {
      const response = await fetch(path);
      return await response.arrayBuffer();
    }

    throw new Error(
      'loadAssetAsArrayBuffer requires file:// URL. Provide absolute paths to model files.',
    );
  } catch (error) {
    throw new Error(
      `Failed to load binary asset ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Load asset as JSON
 * Supports both file:// URLs and https:// URLs
 */
export async function loadAssetAsJSON(path: string): Promise<any> {
  try {
    const content = await loadAssetAsText(path);
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to load JSON asset ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Load asset as text
 * Supports both file:// URLs and https:// URLs (for remote voice files)
 */
export async function loadAssetAsText(path: string): Promise<string> {
  try {
    // Use fetch for file:// URLs
    if (path.startsWith('file://')) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    }

    // Use fetch for https:// URLs (remote voice files from HuggingFace)
    if (path.startsWith('https://')) {
      console.log(`[AssetLoader] Fetching remote asset: ${path}`);
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    }

    // Require callers to provide absolute URLs
    throw new Error(
      'loadAssetAsText requires file:// or https:// URL. Provide absolute paths to assets.',
    );
  } catch (error) {
    throw new Error(
      `Failed to load text asset ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
