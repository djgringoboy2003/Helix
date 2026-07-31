import * as FileSystem from 'expo-file-system/legacy';

import { base64ToBytes, bytesToUtf8 } from '../security/Base64';
import { hashFile, normalizeFileUri } from '../security/FileHash';
import type { GcodeIo } from './SliceReview';

// The real file system behind `reviewSlicedGcode`.
//
// Text is read via base64 because `readAsStringAsync` only honours `position`
// and `length` for that encoding, and a sliced plate is far too large to read
// whole. Decoding is tolerant: a multi-byte character split across a chunk
// boundary becomes a replacement character, which can only ever land in a
// comment — G-code commands are ASCII.

export const expoGcodeIo: GcodeIo = {
  async statFile(filePath) {
    const info = await FileSystem.getInfoAsync(normalizeFileUri(filePath));
    if (!info.exists || info.isDirectory) return null;
    return typeof info.size === 'number' ? info.size : 0;
  },

  async readTextChunk(filePath, offset, length) {
    const encoded = await FileSystem.readAsStringAsync(normalizeFileUri(filePath), {
      encoding: FileSystem.EncodingType.Base64,
      position: offset,
      length,
    });
    return bytesToUtf8(base64ToBytes(encoded));
  },

  async hashFile(filePath) {
    // Through `FileHash` so a native digest installed with `setFileHasher`
    // speeds this up too. This is the hash a start approval binds to.
    const hashed = await hashFile(filePath);
    return hashed.sha256;
  },
};
