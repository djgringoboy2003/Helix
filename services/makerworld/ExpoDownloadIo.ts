import * as FileSystem from 'expo-file-system/legacy';

import type { DownloadIo } from './DownloadWriter';

// The real file system behind `DownloadWriter`.
//
// Kept apart from the policy logic so that module stays free of native imports
// and can be tested with a fake. Nothing here makes decisions; it only performs
// the operation it is asked to.

export const expoDownloadIo: DownloadIo = {
  async remove(uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },

  async fetchToFile(url, uri, onProgress) {
    // `createDownloadResumable` is used purely for its progress callback;
    // MakerWorld's signed CDN URLs are short-lived, so a download is never
    // actually resumed across sessions.
    const download = FileSystem.createDownloadResumable(
      url,
      uri,
      {},
      onProgress
        ? ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
            onProgress(
              totalBytesWritten,
              totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : null
            );
          }
        : undefined
    );
    const result = await download.downloadAsync();
    // `downloadAsync` resolves for any response it managed to write, including
    // a 403 sign-in page or a 418 CAPTCHA challenge, so the status is passed up
    // rather than treated as success.
    if (!result) throw new Error('The download was interrupted.');
    return { status: result.status, mimeType: result.mimeType };
  },

  async writeBase64(uri, base64) {
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
  },

  async sizeOf(uri) {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory) return null;
    return typeof info.size === 'number' ? info.size : 0;
  },
};

/** Where downloaded models are written. */
export function modelDownloadDirectory(): string {
  const base = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!base) throw new Error('App storage is unavailable.');
  return base;
}
