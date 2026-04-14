/**
 * Unified Asset Loader for Neural TTS Engines
 *
 * Loads bundled assets (models, vocab, voices, etc.) from:
 * - Local file:// URLs (app bundle)
 * - Remote https:// URLs (HuggingFace, CDN)
 *
 * Uses React Native FS for local files and fetch for remote resources.
 */

import * as RNFS from '@dr.pogodin/react-native-fs';

/**
 * Load asset as JSON from local file or remote URL
 *
 * @param path - file:// or https:// URL
 * @returns Parsed JSON object
 * @throws Error if path scheme is unsupported or file not found
 */
export async function loadAssetAsJSON<T = unknown>(path: string): Promise<T> {
  try {
    const content = await loadAssetAsText(path);
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(
      `Failed to load JSON asset ${path}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Load asset as text from local file or remote URL
 *
 * @param path - file:// or https:// URL
 * @returns File contents as string
 * @throws Error if path scheme is unsupported or file not found
 */
export async function loadAssetAsText(path: string): Promise<string> {
  // Local file:// URLs
  if (path.startsWith('file://')) {
    const filePath = path.replace('file://', '');

    const exists = await RNFS.exists(filePath);
    if (!exists) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    return RNFS.readFile(filePath, 'utf8');
  }

  // Remote https:// URLs
  if (path.startsWith('https://')) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }

  throw new Error(
    'loadAssetAsText requires file:// or https:// URL. Provide absolute paths to assets.',
  );
}

/**
 * Load asset as ArrayBuffer from local file or remote URL
 *
 * @param path - file:// or https:// URL
 * @returns File contents as ArrayBuffer
 * @throws Error if path scheme is unsupported or file not found
 */
export async function loadAssetAsArrayBuffer(
  path: string,
): Promise<ArrayBuffer> {
  try {
    // Local file:// URLs - use RNFS with base64 encoding
    if (path.startsWith('file://')) {
      const filePath = path.replace('file://', '');

      const exists = await RNFS.exists(filePath);
      if (!exists) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Read file as base64 and convert to ArrayBuffer
      const base64Data = await RNFS.readFile(filePath, 'base64');
      return base64ToArrayBuffer(base64Data);
    }

    // Remote https:// URLs - use fetch
    if (path.startsWith('https://')) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.arrayBuffer();
    }

    throw new Error(
      'loadAssetAsArrayBuffer requires file:// or https:// URL. Provide absolute paths to model files.',
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
