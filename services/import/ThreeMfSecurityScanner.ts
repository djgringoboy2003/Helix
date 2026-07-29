import {
  ZipFormatError,
  isValidUtf8,
  readZipEntries,
  type ZipEntry,
} from './ZipDirectory';
import type { ChunkReader } from '../security/Sha256';

// Archive safety check for downloaded 3MF projects.
//
// A 3MF is a ZIP from an untrusted source, so it gets judged before anything
// unpacks it. The checks and default limits come from
// `docs/SAFETY_AND_TESTING.md` and `docs/TECHNICAL_ARCHITECTURE.md`.
//
// Only the ZIP index is read — no entry is inflated — so a decompression bomb
// is caught by its declared ratio rather than by running out of memory.
//
// XML well-formedness and entity expansion are checked later, by
// `ThreeMfInspector`, which is the component that actually parses the model.
// This scanner decides whether the archive is safe to open at all.

export interface ScanLimits {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxSingleXmlBytes: number;
  maxEntryBytes: number;
  maxPathLength: number;
  /** Uncompressed:compressed ratio above which an entry looks like a bomb. */
  maxCompressionRatio: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxArchiveBytes: 250 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxEntries: 10_000,
  maxSingleXmlBytes: 128 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxPathLength: 512,
  maxCompressionRatio: 200,
};

export type ScanFindingCode =
  | 'archive/not-an-archive'
  | 'archive/malformed'
  | 'archive/too-large'
  | 'archive/too-many-entries'
  | 'archive/expanded-too-large'
  | 'archive/entry-too-large'
  | 'archive/xml-too-large'
  | 'archive/compression-bomb'
  | 'archive/path-traversal'
  | 'archive/absolute-path'
  | 'archive/drive-letter-path'
  | 'archive/backslash-path'
  | 'archive/path-too-long'
  | 'archive/control-character-path'
  | 'archive/invalid-utf8-path'
  | 'archive/symlink-entry'
  | 'archive/encrypted-entry'
  | 'archive/unsupported-compression'
  | 'archive/duplicate-path'
  | 'archive/duplicate-critical-path'
  | 'archive/nested-archive'
  | 'archive/missing-critical-path'
  | 'archive/no-geometry';

export type ScanSeverity = 'reject' | 'warn';

export interface ScanFinding {
  code: ScanFindingCode;
  severity: ScanSeverity;
  message: string;
  /** Entry the finding refers to, already sanitised for display. */
  entryName?: string;
}

export interface ScanReport {
  /** False when any finding has severity `reject`. */
  ok: boolean;
  findings: ScanFinding[];
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  entryNames: string[];
}

/** Files a 3MF must contain to be openable at all (OPC + core model). */
export const REQUIRED_3MF_PATHS: readonly string[] = [
  '[Content_Types].xml',
  '_rels/.rels',
  '3D/3dmodel.model',
];

const NESTED_ARCHIVE_EXTENSIONS: readonly string[] = [
  '.zip', '.3mf', '.jar', '.gz', '.tar', '.7z', '.rar', '.xz', '.bz2',
];

const STORED = 0;
const DEFLATE = 8;

function finding(
  code: ScanFindingCode,
  severity: ScanSeverity,
  message: string,
  entryName?: string
): ScanFinding {
  return entryName === undefined ? { code, severity, message } : { code, severity, message, entryName };
}

/** Keeps a hostile entry name from carrying control characters into the UI. */
function displayName(name: string): string {
  const cleaned = Array.from(name)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

function hasControlCharacter(name: string): boolean {
  return Array.from(name).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/**
 * Judges a parsed entry list against the limits.
 *
 * Separated from reading so the rules can be tested directly, and so a caller
 * that already holds an entry list does not have to re-read the archive.
 */
export function scanZipEntries(
  entries: readonly ZipEntry[],
  archiveBytes: number,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS
): ScanReport {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;

  if (archiveBytes > limits.maxArchiveBytes) {
    findings.push(
      finding('archive/too-large', 'reject', `The archive is larger than the ${mb(limits.maxArchiveBytes)} limit.`)
    );
  }
  if (entries.length > limits.maxEntries) {
    findings.push(
      finding(
        'archive/too-many-entries',
        'reject',
        `The archive holds ${entries.length} entries, over the ${limits.maxEntries} limit.`
      )
    );
  }

  for (const entry of entries) {
    const shown = displayName(entry.name);
    totalCompressedBytes += entry.compressedSize;
    totalUncompressedBytes += entry.uncompressedSize;

    // --- path safety ---
    if (entry.name.length > limits.maxPathLength) {
      findings.push(finding('archive/path-too-long', 'reject', 'An entry path is too long.', shown));
    }
    if (!isValidUtf8(entry.rawNameBytes)) {
      findings.push(
        finding('archive/invalid-utf8-path', 'reject', 'An entry name is not valid UTF-8.', shown)
      );
    }
    if (hasControlCharacter(entry.name)) {
      findings.push(
        finding('archive/control-character-path', 'reject', 'An entry name contains control characters.', shown)
      );
    }
    if (entry.name.includes('\\')) {
      findings.push(
        finding('archive/backslash-path', 'reject', 'An entry name uses Windows path separators.', shown)
      );
    }
    if (entry.name.startsWith('/')) {
      findings.push(finding('archive/absolute-path', 'reject', 'An entry uses an absolute path.', shown));
    }
    if (/^[a-z]:/i.test(entry.name)) {
      findings.push(
        finding('archive/drive-letter-path', 'reject', 'An entry uses a drive-letter path.', shown)
      );
    }
    if (entry.name.split('/').some((segment) => segment === '..')) {
      findings.push(
        finding('archive/path-traversal', 'reject', 'An entry tries to escape the archive.', shown)
      );
    }

    // --- entry kind ---
    if (entry.isSymlink) {
      findings.push(finding('archive/symlink-entry', 'reject', 'The archive contains a symlink.', shown));
    }
    if (entry.encrypted) {
      findings.push(
        finding('archive/encrypted-entry', 'reject', 'The archive contains an encrypted entry.', shown)
      );
    }
    if (!entry.isDirectory && entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATE) {
      findings.push(
        finding(
          'archive/unsupported-compression',
          'reject',
          `An entry uses unsupported compression (method ${entry.compressionMethod}).`,
          shown
        )
      );
    }
    if (!entry.isDirectory && NESTED_ARCHIVE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      findings.push(
        finding('archive/nested-archive', 'reject', 'The archive contains another archive.', shown)
      );
    }

    // --- size limits ---
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      findings.push(finding('archive/entry-too-large', 'reject', 'An entry is too large to open.', shown));
    }
    if (entry.name.toLowerCase().endsWith('.xml') && entry.uncompressedSize > limits.maxSingleXmlBytes) {
      findings.push(finding('archive/xml-too-large', 'reject', 'An XML part is too large to parse.', shown));
    }
    // A stored entry cannot be a bomb; only compressed ones can lie about size.
    if (
      !entry.isDirectory &&
      entry.compressedSize > 0 &&
      entry.compressionMethod !== STORED &&
      entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
    ) {
      findings.push(
        finding(
          'archive/compression-bomb',
          'reject',
          `An entry expands ${Math.round(entry.uncompressedSize / entry.compressedSize)}x, over the ${limits.maxCompressionRatio}x limit.`,
          shown
        )
      );
    }

    // --- duplicates ---
    const key = entry.name.toLowerCase();
    if (seen.has(key)) {
      const critical = REQUIRED_3MF_PATHS.some((required) => required.toLowerCase() === key);
      findings.push(
        critical
          ? finding('archive/duplicate-critical-path', 'reject', 'A required part appears twice.', shown)
          : finding('archive/duplicate-path', 'reject', 'An entry path appears twice.', shown)
      );
    }
    seen.add(key);
  }

  if (totalUncompressedBytes > limits.maxExpandedBytes) {
    findings.push(
      finding(
        'archive/expanded-too-large',
        'reject',
        `The archive expands to more than the ${mb(limits.maxExpandedBytes)} limit.`
      )
    );
  }

  for (const required of REQUIRED_3MF_PATHS) {
    if (!seen.has(required.toLowerCase())) {
      findings.push(
        finding('archive/missing-critical-path', 'reject', `The archive is missing ${required}.`, required)
      );
    }
  }

  // Geometry may live in additional parts, so its absence from the core model
  // path is worth reporting without refusing the file outright.
  const hasModelPart = [...seen].some((name) => name.endsWith('.model'));
  if (!hasModelPart) {
    findings.push(finding('archive/no-geometry', 'warn', 'No model part was found in the archive.'));
  }

  return {
    ok: !findings.some((item) => item.severity === 'reject'),
    findings,
    entryCount: entries.length,
    totalCompressedBytes,
    totalUncompressedBytes,
    entryNames: entries.map((entry) => entry.name),
  };
}

/**
 * Scans a 3MF on disk.
 *
 * A file that cannot be read as a ZIP produces a rejecting report rather than
 * throwing, so callers handle "unsafe" and "unreadable" on the same path.
 */
export async function scanThreeMfArchive(
  read: ChunkReader,
  archiveBytes: number,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS
): Promise<ScanReport> {
  try {
    const entries = await readZipEntries(read, archiveBytes);
    return scanZipEntries(entries, archiveBytes, limits);
  } catch (error) {
    const isFormat = error instanceof ZipFormatError;
    const code: ScanFindingCode =
      isFormat && error.code === 'zip/not-an-archive' ? 'archive/not-an-archive' : 'archive/malformed';
    return {
      ok: false,
      findings: [
        finding(code, 'reject', isFormat ? error.message : 'The archive could not be read.'),
      ],
      entryCount: 0,
      totalCompressedBytes: 0,
      totalUncompressedBytes: 0,
      entryNames: [],
    };
  }
}

export function rejectionsOf(report: ScanReport): ScanFinding[] {
  return report.findings.filter((item) => item.severity === 'reject');
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
