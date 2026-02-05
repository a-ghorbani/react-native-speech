/**
 * Asset Loader for Supertonic
 *
 * Re-exports the shared asset loader utilities.
 * Supports both local file:// URLs and remote https:// URLs.
 */

export {
  loadAssetAsArrayBuffer,
  loadAssetAsJSON,
  loadAssetAsText,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from '../../../utils/AssetLoader';
