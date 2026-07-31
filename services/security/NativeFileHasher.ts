import * as FileSystem from 'expo-file-system/legacy';

import { nativeHashFile } from '../nativeSlicer';
import { bytesToBase64 } from './Base64';
import {
  createFileChunkReader,
  normalizeFileUri,
  setFileHasher,
  type FileHasher,
} from './FileHash';
import { sha256HexOfStream } from './Sha256';
import { buildProbeBytes } from './HasherProbe';

// A faster digest, but only once it has proved it agrees with ours.
//
// `docs/CURRENT_STATE.md` commits to SHA-256 being implemented in this
// repository rather than delegated, so the primitive a start approval binds to
// stays inside this test suite. Installing the platform's `MessageDigest`
// would quietly move it outside — the tested implementation would no longer be
// the one that runs.
//
// So the native digest is not trusted on reputation. Before it is installed it
// has to reproduce, byte for byte, what the in-repo implementation produces for
// a fixture built to be awkward: larger than the native module's 1 MiB read
// block, and full of non-ASCII bytes. Disagreement, an error, or a missing
// module all leave the JavaScript hasher in place. The commitment holds either
// way; what changes is only how long a 30 MB G-code takes.
//
// The JavaScript hasher costs roughly a second per 10 MB on a phone. Note this
// only halves the wait on a reprint: the extent scan reads the same file again
// through the same chunk reader, and that stays in TypeScript because the
// G-code rules belong where the tests are.

/** Result of the check, for logging and for the tests. */
export type HasherProbe =
  | { installed: true }
  | { installed: false; reason: 'no-native-module' | 'mismatch' | 'error' };

/**
 * Checks the native digest against ours and installs it only if they agree.
 *
 * Safe to call more than once and safe to call where there is no native module.
 * Never throws: a failure here must degrade to the slower correct path, not
 * stop the app starting.
 */
export async function installNativeFileHasher(): Promise<HasherProbe> {
  const probePath = `${FileSystem.cacheDirectory ?? ''}helix-hasher-probe.bin`;

  try {
    await FileSystem.writeAsStringAsync(probePath, bytesToBase64(buildProbeBytes()), {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Ours is computed from the in-repo implementation *directly*, never
    // through `hashFile`. `hashFile` dispatches to whatever hasher is currently
    // installed, so on a second call it would return the native digest and the
    // comparison below would be the native digest against itself — a check that
    // passes for a hasher that is wrong in exactly the same way twice.
    const info = await FileSystem.getInfoAsync(normalizeFileUri(probePath));
    const size = info.exists && !info.isDirectory && typeof info.size === 'number' ? info.size : 0;
    const ours = await sha256HexOfStream(createFileChunkReader(probePath), size);
    const theirs = await nativeHashFile(probePath);

    if (theirs === null) {
      return { installed: false, reason: 'no-native-module' };
    }
    if (theirs.toLowerCase() !== ours.toLowerCase()) {
      // Do not install, and do not throw. The app keeps hashing correctly, just
      // more slowly, which is the right way round for a value a print binds to.
      return { installed: false, reason: 'mismatch' };
    }

    const verified: FileHasher = {
      hashFile: async (uri, sizeBytes) => {
        const digest = await nativeHashFile(uri);
        // Falling back rather than throwing keeps a single unreadable file from
        // becoming an unhashable one; the JS reader may still manage it.
        if (digest === null) return jsFallback(uri, sizeBytes);
        return digest;
      },
    };
    setFileHasher(verified);
    return { installed: true };
  } catch {
    return { installed: false, reason: 'error' };
  } finally {
    FileSystem.deleteAsync(probePath, { idempotent: true }).catch(() => {});
  }
}

/**
 * The in-repo implementation, reached without going through the installed
 * hasher — otherwise the fallback would call itself.
 */
function jsFallback(uri: string, sizeBytes: number): Promise<string> {
  return sha256HexOfStream(createFileChunkReader(uri), sizeBytes);
}
