/**
 * Asset Loader Utility
 *
 * Loads bundled assets (models, vocab, etc.) from the app bundle
 * Uses native module bridge to access bundled assets
 */

/**
 * Load asset as JSON
 * Path should be relative to the assets folder (Android) or Resources folder (iOS)
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
 * Apps should handle platform-specific path resolution
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
 * Convert base64 string to ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Remove data URL prefix if present
  const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;

  if (!base64Data) {
    throw new Error('Invalid base64 string');
  }

  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i++) {
    const charCode = binaryString.charCodeAt(i);
    if (charCode !== undefined) {
      bytes[i] = charCode;
    }
  }

  return bytes.buffer;
}

/**
 * Convert ArrayBuffer to base64 string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }

  return btoa(binary);
}
