import type { ChunkReader } from '../security/Sha256';

// Minimal ZIP central-directory reader.
//
// A 3MF is a ZIP. Before anything unpacks one, the app needs to know what is
// inside it — names, sizes, compression, encryption — and that is all recorded
// in the central directory. Reading only the directory means a hostile archive
// is judged without inflating a single byte of it, which is the whole point of
// `ThreeMfSecurityScanner`.
//
// Deliberately not a general ZIP library: it does not decompress, and it reads
// metadata only.

export class ZipFormatError extends Error {
  readonly code: 'zip/not-an-archive' | 'zip/truncated' | 'zip/unsupported' | 'zip/malformed';

  constructor(
    code: 'zip/not-an-archive' | 'zip/truncated' | 'zip/unsupported' | 'zip/malformed',
    message: string
  ) {
    super(message);
    this.name = 'ZipFormatError';
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  /** Raw bytes of the name, kept so encoding can be judged separately. */
  rawNameBytes: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate; anything else is unsupported. */
  compressionMethod: number;
  encrypted: boolean;
  /** Set by the archive's own UTF-8 flag (general purpose bit 11). */
  utf8Names: boolean;
  isDirectory: boolean;
  /** Derived from Unix mode bits in the external attributes. */
  isSymlink: boolean;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const EOCD_MIN_BYTES = 22;
const ZIP64_LOCATOR_BYTES = 20;
/** EOCD plus the largest possible trailing comment. */
const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + 0xffff;

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;

/** Refuses to buffer a directory larger than this while scanning. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
  );
}

function u64(bytes: Uint8Array, at: number): number {
  const low = u32(bytes, at);
  const high = u32(bytes, at + 4);
  const value = high * 0x100000000 + low;
  if (!Number.isSafeInteger(value)) {
    throw new ZipFormatError('zip/unsupported', 'Archive declares an implausible size.');
  }
  return value;
}

export interface CentralDirectoryLocation {
  offset: number;
  sizeBytes: number;
  entryCount: number;
}

/** Finds the End of Central Directory record, following Zip64 when present. */
export function locateCentralDirectory(
  tail: Uint8Array,
  tailStartOffset: number,
  archiveSize: number
): CentralDirectoryLocation {
  let eocdAt = -1;
  for (let at = tail.length - EOCD_MIN_BYTES; at >= 0; at -= 1) {
    if (u32(tail, at) === EOCD_SIGNATURE) {
      eocdAt = at;
      break;
    }
  }
  if (eocdAt < 0) {
    throw new ZipFormatError('zip/not-an-archive', 'This file is not a ZIP archive.');
  }

  const commentLength = u16(tail, eocdAt + 20);
  if (tailStartOffset + eocdAt + EOCD_MIN_BYTES + commentLength !== archiveSize) {
    // Trailing bytes after the record, or a comment length that does not add
    // up, mean the file is not simply a ZIP — treat it as malformed.
    throw new ZipFormatError('zip/malformed', 'The archive has unexpected trailing data.');
  }

  let entryCount = u16(tail, eocdAt + 10);
  let sizeBytes = u32(tail, eocdAt + 12);
  let offset = u32(tail, eocdAt + 16);

  const needsZip64 =
    entryCount === UINT16_MAX || sizeBytes === UINT32_MAX || offset === UINT32_MAX;
  if (needsZip64) {
    const locatorAt = eocdAt - ZIP64_LOCATOR_BYTES;
    if (locatorAt < 0 || u32(tail, locatorAt) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipFormatError('zip/malformed', 'The archive is missing its Zip64 record.');
    }
    const zip64At = u64(tail, locatorAt + 8) - tailStartOffset;
    if (zip64At < 0 || zip64At + 56 > tail.length) {
      throw new ZipFormatError('zip/unsupported', 'The Zip64 record is outside the readable range.');
    }
    if (u32(tail, zip64At) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipFormatError('zip/malformed', 'The Zip64 record is not where it claims to be.');
    }
    entryCount = u64(tail, zip64At + 32);
    sizeBytes = u64(tail, zip64At + 40);
    offset = u64(tail, zip64At + 48);
  }

  if (offset < 0 || sizeBytes < 0 || offset + sizeBytes > archiveSize) {
    throw new ZipFormatError('zip/malformed', 'The central directory lies outside the file.');
  }
  if (sizeBytes > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ZipFormatError('zip/unsupported', 'The archive index is too large to scan.');
  }

  return { offset, sizeBytes, entryCount };
}

/** Parses central directory bytes into entries. */
export function parseCentralDirectory(bytes: Uint8Array, expectedEntries: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;

  while (at + 46 <= bytes.length) {
    if (u32(bytes, at) !== CENTRAL_HEADER_SIGNATURE) break;

    const flags = u16(bytes, at + 8);
    const compressionMethod = u16(bytes, at + 10);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const externalAttributes = u32(bytes, at + 38);

    const nameAt = at + 46;
    const extraAt = nameAt + nameLength;
    const nextAt = extraAt + extraLength + commentLength;
    if (nextAt > bytes.length) {
      throw new ZipFormatError('zip/truncated', 'The archive index ends mid-entry.');
    }

    const rawNameBytes = bytes.subarray(nameAt, extraAt);
    const utf8Names = (flags & 0x0800) !== 0;

    let compressedSize = u32(bytes, at + 20);
    let uncompressedSize = u32(bytes, at + 24);
    let localHeaderOffset = u32(bytes, at + 42);
    if (
      compressedSize === UINT32_MAX ||
      uncompressedSize === UINT32_MAX ||
      localHeaderOffset === UINT32_MAX
    ) {
      const zip64 = readZip64Extra(
        bytes.subarray(extraAt, extraAt + extraLength),
        uncompressedSize === UINT32_MAX,
        compressedSize === UINT32_MAX,
        localHeaderOffset === UINT32_MAX
      );
      uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
      compressedSize = zip64.compressedSize ?? compressedSize;
      localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset;
    }

    const name = decodeEntryName(rawNameBytes);
    // Unix mode lives in the top 16 bits; 0xA000 is S_IFLNK.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0xf000) === 0xa000;

    entries.push({
      name,
      rawNameBytes,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      encrypted: (flags & 0x0001) !== 0,
      utf8Names,
      isDirectory: name.endsWith('/'),
      isSymlink,
      localHeaderOffset,
    });

    at = nextAt;
  }

  if (expectedEntries > 0 && entries.length !== expectedEntries) {
    throw new ZipFormatError(
      'zip/malformed',
      `The archive index lists ${expectedEntries} entries but ${entries.length} could be read.`
    );
  }
  return entries;
}

interface Zip64Sizes {
  uncompressedSize: number | null;
  compressedSize: number | null;
  localHeaderOffset: number | null;
}

function readZip64Extra(
  extra: Uint8Array,
  wantUncompressed: boolean,
  wantCompressed: boolean,
  wantOffset: boolean
): Zip64Sizes {
  let at = 0;
  while (at + 4 <= extra.length) {
    const headerId = u16(extra, at);
    const dataSize = u16(extra, at + 2);
    const dataAt = at + 4;
    if (dataAt + dataSize > extra.length) break;

    if (headerId === 0x0001) {
      let cursor = dataAt;
      const take = (): number | null => {
        if (cursor + 8 > dataAt + dataSize) return null;
        const value = u64(extra, cursor);
        cursor += 8;
        return value;
      };
      // Zip64 fields appear in a fixed order, present only when overflowed.
      const uncompressedSize = wantUncompressed ? take() : null;
      const compressedSize = wantCompressed ? take() : null;
      const localHeaderOffset = wantOffset ? take() : null;
      return { uncompressedSize, compressedSize, localHeaderOffset };
    }
    at = dataAt + dataSize;
  }
  throw new ZipFormatError('zip/malformed', 'A Zip64 entry is missing its size record.');
}

/**
 * Decodes an entry name as UTF-8, replacing invalid sequences.
 *
 * The replacement is intentional: the scanner checks the decoded name for
 * traversal, and separately reports invalid encoding, so a name that decodes
 * oddly is still examined rather than being dropped.
 */
function decodeEntryName(bytes: Uint8Array): string {
  let out = '';
  let at = 0;
  while (at < bytes.length) {
    const byte = bytes[at];
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      at += 1;
      continue;
    }
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0;
    if (length === 0 || at + length > bytes.length) {
      out += '�';
      at += 1;
      continue;
    }
    let code = byte & (0xff >> (length + 1));
    let valid = true;
    for (let i = 1; i < length; i += 1) {
      const next = bytes[at + i];
      if ((next & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      code = (code << 6) | (next & 0x3f);
    }
    if (!valid) {
      out += '�';
      at += 1;
      continue;
    }
    out += code > 0xffff ? String.fromCodePoint(code) : String.fromCharCode(code);
    at += length;
  }
  return out;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  return !decodeEntryName(bytes).includes('�');
}

/** Reads an archive's entry list using only the tail and directory regions. */
export async function readZipEntries(
  read: ChunkReader,
  archiveSize: number
): Promise<ZipEntry[]> {
  if (archiveSize < EOCD_MIN_BYTES) {
    throw new ZipFormatError('zip/not-an-archive', 'The file is too small to be an archive.');
  }

  const tailLength = Math.min(archiveSize, EOCD_SEARCH_BYTES);
  const tailStart = archiveSize - tailLength;
  const tail = await read(tailStart, tailLength);
  if (tail.length < tailLength) {
    throw new ZipFormatError('zip/truncated', 'The archive could not be read to the end.');
  }

  const location = locateCentralDirectory(tail, tailStart, archiveSize);

  // Reuse the tail when the directory already sits inside it, which is the
  // common case for a 3MF.
  const directory =
    location.offset >= tailStart
      ? tail.subarray(location.offset - tailStart, location.offset - tailStart + location.sizeBytes)
      : await read(location.offset, location.sizeBytes);

  if (directory.length < location.sizeBytes) {
    throw new ZipFormatError('zip/truncated', 'The archive index is incomplete.');
  }
  return parseCentralDirectory(directory, location.entryCount);
}
