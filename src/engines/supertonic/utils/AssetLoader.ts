/**
 * Asset Loader for Supertonic
 *
 * Utilities for loading model files and assets
 * Uses fetch() with file:// URLs (same approach as Kokoro)
 */

/**
 * Load asset as ArrayBuffer
 * Requires absolute file:// URLs
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
 * Path should be absolute file:// URL
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
 * Requires absolute file:// URLs
 */
export async function loadAssetAsText(path: string): Promise<string> {
  try {
    // Use fetch for file:// URLs
    if (path.startsWith('file://')) {
      const response = await fetch(path);
      return await response.text();
    }

    // Require callers to provide absolute file:// URLs
    throw new Error(
      'loadAssetAsText requires file:// URL. Provide absolute paths to model files.',
    );
  } catch (error) {
    throw new Error(
      `Failed to load text asset ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
