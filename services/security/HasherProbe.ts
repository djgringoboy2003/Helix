// The fixture that decides whether a faster digest can be trusted.
//
// Kept apart from `NativeFileHasher.ts` because that module reaches the native
// bridge and the file system, and this has to be testable in the plain Node
// runner — the whole point of the probe is that the repository's own suite
// vouches for it.

/**
 * Deliberately larger than the native reader's 1 MiB block, so agreement means
 * agreement across a block boundary rather than on a single buffer.
 */
export const PROBE_BYTES = 1024 * 1024 + 7919;

/**
 * Bytes that exercise what a naive digest gets wrong.
 *
 * Every byte value appears, the length is not a multiple of any block size, and
 * the pattern does not repeat — so a hasher that drops, reorders or re-reads a
 * block cannot accidentally still match.
 */
export function buildProbeBytes(length: number = PROBE_BYTES): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + (index >> 8) * 17 + (index >> 16) * 7) & 0xff;
  }
  return bytes;
}
