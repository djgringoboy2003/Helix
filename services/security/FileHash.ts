import * as FileSystem from 'expo-file-system/legacy';

import { base64ToBytes } from './Base64';
import {
  DEFAULT_HASH_CHUNK_BYTES,
  isSha256Hex,
  sha256Hex,
  sha256HexOfStream,
  shortHash,
  type ChunkReader,
} from './Sha256';

// SHA-256 for on-disk artifacts.
//
// Everything the operator approves is identified by the hash of the exact bytes
// that will reach the printer. Hashing is therefore always done over the file,
// never over a cached value carried alongside it.

export { isSha256Hex, sha256Hex, sha256HexOfStream, shortHash, type ChunkReader };

export interface HashedFile {
  uri: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * A replaceable hashing backend.
 *
 * The default reads the file through `expo-file-system` and hashes in
 * JavaScript, which is correct but costs roughly a second per 10 MB on a phone.
 * `HelixSlicerModule` already does native file I/O and can expose a streaming
 * digest cheaply; when it does, install it here with {@link setFileHasher} and
 * every caller picks it up without changing.
 */
export interface FileHasher {
  hashFile(uri: string, sizeBytes: number): Promise<string>;
}

const jsFileHasher: FileHasher = {
  hashFile: (uri, sizeBytes) => sha256HexOfStream(createFileChunkReader(uri), sizeBytes),
};

let activeHasher: FileHasher = jsFileHasher;

export function setFileHasher(hasher: FileHasher | null): void {
  activeHasher = hasher ?? jsFileHasher;
}

/** Reads a slice of a local file as bytes. */
export function createFileChunkReader(uri: string): ChunkReader {
  const normalized = normalizeFileUri(uri);
  return async (offset, length) => {
    const encoded = await FileSystem.readAsStringAsync(normalized, {
      encoding: FileSystem.EncodingType.Base64,
      position: offset,
      length,
    });
    return base64ToBytes(encoded);
  };
}

/**
 * Hashes a local file and reports the size it was hashed over.
 *
 * Callers should treat the returned size as authoritative and compare it with
 * whatever the printer reports after upload; a size mismatch means the bytes
 * that were approved are not the bytes that landed.
 */
export async function hashFile(uri: string): Promise<HashedFile> {
  const normalized = normalizeFileUri(uri);
  const info = await FileSystem.getInfoAsync(normalized);
  if (!info.exists || info.isDirectory) throw new Error('File not found for hashing.');

  const sizeBytes = typeof info.size === 'number' ? info.size : 0;
  const sha256 = await activeHasher.hashFile(normalized, sizeBytes);
  return { uri: normalized, sizeBytes, sha256 };
}

/**
 * Confirms a file still hashes to `expectedSha256`.
 *
 * Used before acting on an approval: the approval names a hash, and the file on
 * disk has to still match it.
 */
export async function verifyFileHash(uri: string, expectedSha256: string): Promise<boolean> {
  if (!isSha256Hex(expectedSha256)) return false;
  try {
    const hashed = await hashFile(uri);
    return hashed.sha256 === expectedSha256;
  } catch {
    return false;
  }
}

/** Native paths and `file://` URIs both circulate in this app; normalise once. */
export function normalizeFileUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) throw new Error('Empty file path.');
  return trimmed.startsWith('file://') || trimmed.includes('://') ? trimmed : `file://${trimmed}`;
}

export { DEFAULT_HASH_CHUNK_BYTES };
