// Turning an intercepted download into bytes on disk.
//
// This is the step between "the page handed over a file" and the provider's
// `DownloadedArtifact`. It is separated from the Explore screen because it is
// where the download policy is actually enforced, and a policy that can only be
// exercised by driving a WebView is a policy that does not get tested.
//
// The file system is reached through {@link DownloadIo} for the same reason.

import {
  checkDownloadSize,
  checkDownloadUrl,
  checkReceivedBytes,
  sanitizeDownloadFilename,
} from './DownloadHostPolicy';
import { filenameFromUrl, type CapturedDownload } from './WebViewDownloadCapture';
import { ModelSourceError } from './ModelSourceProvider';
import type { BridgeDownloadResult } from './MakerWorldWebViewProvider';

export interface DownloadIo {
  /** Removes any previous file at `uri`; must not throw when absent. */
  remove(uri: string): Promise<void>;
  /** Fetches `url` to `uri`, reporting progress where the platform can. */
  fetchToFile(
    url: string,
    uri: string,
    onProgress?: (received: number, total: number | null) => void
  ): Promise<void>;
  /** Writes base64 content to `uri`. */
  writeBase64(uri: string, base64: string): Promise<void>;
  /** Size in bytes, or `null` when the file does not exist. */
  sizeOf(uri: string): Promise<number | null>;
}

export interface SaveCapturedDownloadOptions {
  capture: CapturedDownload;
  /** Directory to write into, with a trailing slash. */
  targetDirectory: string;
  /** Used to build a stable local filename; not trusted for display. */
  modelId: string;
  io: DownloadIo;
  onProgress?: (received: number, total: number | null) => void;
  /** Injected so the local filename is deterministic in tests. */
  now?: () => number;
}

/**
 * Base64 expands 3 bytes to 4 characters, so a blob's decoded size is at most
 * three quarters of its encoded length. Used to reject an oversized blob before
 * decoding it rather than after.
 */
export function decodedBase64Size(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * Saves an intercepted download and reports what landed.
 *
 * The URL is policy-checked *before* any bytes are requested. The provider
 * checks it again afterwards, which is deliberate duplication: this call is the
 * one that decides whether to contact the host at all, and that decision cannot
 * be made after the request has already gone out.
 */
export async function saveCapturedDownload(
  options: SaveCapturedDownloadOptions
): Promise<BridgeDownloadResult> {
  const { capture, targetDirectory, modelId, io, onProgress } = options;
  const clock = options.now ?? Date.now;

  const safeModelId = /^\d+$/.test(modelId) ? modelId : String(clock());
  const targetUri = `${targetDirectory}makerworld_${safeModelId}.3mf`;

  await io.remove(targetUri).catch(() => {
    // A stale file that cannot be removed is not fatal on its own; the write
    // below overwrites it, and a failure there is reported properly.
  });

  let sourceUrl: string;
  let suggestedName: string;

  if (capture.kind === 'url') {
    const urlCheck = checkDownloadUrl(capture.sourceUrl);
    if (!urlCheck.ok) {
      throw new ModelSourceError('makerworld-webview', 'policy-rejected', urlCheck.message);
    }
    sourceUrl = capture.sourceUrl;
    suggestedName = capture.suggestedName || filenameFromUrl(capture.sourceUrl);
    await io.fetchToFile(sourceUrl, targetUri, onProgress);
  } else {
    const declared = decodedBase64Size(capture.base64);
    const sizeCheck = checkDownloadSize(declared);
    if (!sizeCheck.ok) {
      throw new ModelSourceError('makerworld-webview', 'policy-rejected', sizeCheck.message);
    }
    // A blob never left the page, so there is no host to check. It is recorded
    // as coming from the model page itself, which is what the provider's own
    // URL check then sees.
    sourceUrl = `https://makerworld.com/models/${safeModelId}`;
    suggestedName = capture.suggestedName || 'model.3mf';
    onProgress?.(0, declared);
    await io.writeBase64(targetUri, capture.base64);
    onProgress?.(declared, declared);
  }

  const sizeBytes = await io.sizeOf(targetUri);
  if (sizeBytes === null) {
    throw new ModelSourceError('makerworld-webview', 'network', 'The download did not produce a file.');
  }
  if (sizeBytes <= 0) {
    throw new ModelSourceError('makerworld-webview', 'empty-file', 'The downloaded file is empty.');
  }

  const receivedCheck = checkReceivedBytes(sizeBytes);
  if (!receivedCheck.ok) {
    await io.remove(targetUri).catch(() => {});
    throw new ModelSourceError('makerworld-webview', 'policy-rejected', receivedCheck.message);
  }

  return {
    sourceUrl,
    suggestedName: sanitizeDownloadFilename(suggestedName, `makerworld_${safeModelId}.3mf`),
    // Downstream native code takes a path, not a URI; the scheme is stripped
    // once, here, so callers never have to guess which form they hold.
    filePath: targetUri.replace(/^file:\/\//, ''),
    sizeBytes,
  };
}
