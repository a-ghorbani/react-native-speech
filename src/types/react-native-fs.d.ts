/**
 * Type declarations for @dr.pogodin/react-native-fs
 * This is a minimal declaration to satisfy TypeScript compilation
 */
declare module '@dr.pogodin/react-native-fs' {
  export interface StatResult {
    path: string;
    ctime: Date;
    mtime: Date;
    size: number;
    mode: number;
    originalFilepath: string;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }

  export interface ReadDirItem {
    ctime: Date | null;
    mtime: Date | null;
    name: string;
    path: string;
    size: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }

  export interface DownloadBeginCallbackResult {
    jobId: number;
    statusCode: number;
    contentLength: number;
    headers: {[key: string]: string};
  }

  export interface DownloadProgressCallbackResult {
    jobId: number;
    contentLength: number;
    bytesWritten: number;
  }

  export interface DownloadResult {
    jobId: number;
    statusCode: number;
    bytesWritten: number;
  }

  export interface DownloadFileOptions {
    fromUrl: string;
    toFile: string;
    headers?: {[key: string]: string};
    background?: boolean;
    discretionary?: boolean;
    cacheable?: boolean;
    progressInterval?: number;
    progressDivider?: number;
    begin?: (res: DownloadBeginCallbackResult) => void;
    progress?: (res: DownloadProgressCallbackResult) => void;
    resumable?: () => void;
    connectionTimeout?: number;
    readTimeout?: number;
    backgroundTimeout?: number;
  }

  export interface DownloadFileReturn {
    jobId: number;
    promise: Promise<DownloadResult>;
  }

  export const DocumentDirectoryPath: string;
  export const CachesDirectoryPath: string;
  export const MainBundlePath: string;

  export function exists(filepath: string): Promise<boolean>;
  export function readFile(
    filepath: string,
    encoding?: string,
  ): Promise<string>;
  export function writeFile(
    filepath: string,
    contents: string,
    encoding?: string,
  ): Promise<void>;
  export function readDir(dirpath: string): Promise<ReadDirItem[]>;
  export function stat(filepath: string): Promise<StatResult>;
  export function copyFile(filepath: string, destPath: string): Promise<void>;
  export function moveFile(filepath: string, destPath: string): Promise<void>;
  export function unlink(filepath: string): Promise<void>;
  export function mkdir(
    filepath: string,
    options?: {NSURLIsExcludedFromBackupKey?: boolean},
  ): Promise<void>;
  export function downloadFile(
    options: DownloadFileOptions,
  ): DownloadFileReturn;
}
