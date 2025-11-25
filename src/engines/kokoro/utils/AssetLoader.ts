/**
 * Asset Loader Utility
 *
 * Loads bundled assets (models, vocab, etc.) from the app bundle
 * Uses native module bridge to access bundled assets
 */

import * as RNFS from '@dr.pogodin/react-native-fs';

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
  // Use RNFS for file:// URLs
  if (path.startsWith('file://')) {
    // Remove file:// prefix for RNFS
    const filePath = path.replace('file://', '');
    console.log('[AssetLoader] Reading text file:', filePath);

    try {
      // Check if file exists first
      const exists = await RNFS.exists(filePath);
      console.log('[AssetLoader] File exists:', exists);

      if (!exists) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      const content = await RNFS.readFile(filePath, 'utf8');
      console.log(
        '[AssetLoader] File read successfully, length:',
        content.length,
      );
      return content;
    } catch (error) {
      console.error('[AssetLoader] RNFS error details:', {
        path: filePath,
        error: error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  // Require callers to provide absolute file:// URLs
  throw new Error(
    'loadAssetAsText requires file:// URL. Provide absolute paths to model files.',
  );
}

/**
 * Load asset as ArrayBuffer
 * Requires absolute file:// URLs
 */
export async function loadAssetAsArrayBuffer(
  path: string,
): Promise<ArrayBuffer> {
  try {
    // Use RNFS for file:// URLs
    if (path.startsWith('file://')) {
      console.log('[AssetLoader] Loading file:', path);
      // Remove file:// prefix for RNFS
      const filePath = path.replace('file://', '');

      // Read file as base64 and convert to ArrayBuffer
      const base64Data = await RNFS.readFile(filePath, 'base64');
      const buffer = base64ToArrayBuffer(base64Data);

      console.log('[AssetLoader] Buffer size:', buffer.byteLength);

      // Log first 20 bytes for debugging
      const view = new DataView(buffer);
      const first20 = [];
      for (let i = 0; i < Math.min(20, buffer.byteLength); i++) {
        first20.push(view.getUint8(i));
      }
      console.log('[AssetLoader] First 20 bytes:', first20);

      return buffer;
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
