import { sanitizeDownloadFilename } from '../makerworld/DownloadHostPolicy';
import { isSha256Hex, type ChunkReader } from '../security/Sha256';
import type { ImportLibrary } from './ImportLibrary';
import {
  classifyImportFile,
  UNKNOWN_ATTRIBUTION,
  type ImportAttribution,
  type ImportErrorCode,
  type ImportNotice,
  type ImportOutcome,
  type ImportRecord,
  type ImportSourceKind,
} from './ImportTypes';
import { inspectThreeMfEntries, type ThreeMfContents } from './ThreeMfInspector';
import {
  DEFAULT_SCAN_LIMITS,
  scanThreeMfArchive,
  type ScanFinding,
  type ScanLimits,
  type ScanReport,
} from './ThreeMfSecurityScanner';

// The one way a model gets into this app.
//
// Phase 4 of `docs/IMPLEMENTATION_BACKLOG.md` exists because Helix has seven
// entry points and no shared checkpoint. `ThreeMfSecurityScanner` was written in
// Stage B and, until this coordinator, nothing called it: every downloaded
// archive reached the native slicer unscanned. Routing all seven doors through
// one function is what makes a check added here apply everywhere, rather than
// to whichever door someone remembered.
//
// The order below is deliberate:
//
//   name → type → size → hash → dedupe → scan → inspect → record
//
// Cheap rejections come first, and nothing is opened as an archive before the
// index has been judged safe to read. Dedupe sits before the scan because a hash
// already in the library was scanned when it was first admitted, so re-scanning
// identical bytes buys nothing.
//
// Failure is always a returned `rejected` outcome, never a thrown error or a
// silent pass-through: `CLAUDE.md` rule 15 asks for visible errors over silent
// fallback, and an import the operator cannot see refused is one they will
// assume worked.

export interface ImportIo {
  /** Size in bytes, or null when the path is missing, empty or a directory. */
  statFile(filePath: string): Promise<number | null>;
  /** Reads a byte range, for the archive index. */
  createReader(filePath: string): ChunkReader;
  hashFile(filePath: string, sizeBytes: number): Promise<string>;
}

export interface ImportRequest {
  /** Local path to a file already on disk. Providers download before importing. */
  filePath: string;
  /** Name as offered by the source; sanitised here, never trusted as given. */
  fileName: string;
  sourceKind: ImportSourceKind;
  attribution?: ImportAttribution;
  /**
   * A SHA-256 the caller has already taken over these exact bytes.
   *
   * Only for a caller that hashed this file itself moments earlier — the
   * MakerWorld provider hashes what it wrote, and hashing again here would cost
   * a second per 10 MB for a value that cannot have changed. Anything that is
   * not a well-formed digest is ignored and the file is hashed.
   *
   * This is an import-identity shortcut and nothing more. What a start approval
   * binds to is the hash of the *sliced G-code*, taken later and never reused
   * from here.
   */
  knownSha256?: string;
}

export interface ImportCoordinatorOptions {
  library: ImportLibrary;
  io: ImportIo;
  limits?: ScanLimits;
  /** Injected so records are deterministic under test. */
  now?: () => number;
}

/** Meshes are not archives, so the archive limit is the only size bound they get. */
const MAX_IMPORT_BYTES = DEFAULT_SCAN_LIMITS.maxArchiveBytes;

function reject(
  code: ImportErrorCode,
  message: string,
  scanFindings: ScanFinding[] = [],
  inspectionFindings: ThreeMfContents['findings'] = []
): ImportOutcome {
  return { status: 'rejected', code, message, scanFindings, inspectionFindings };
}

function noticesFrom(scan: ScanReport | null, contents: ThreeMfContents | null): ImportNotice[] {
  const notices: ImportNotice[] = [];
  for (const finding of scan?.findings ?? []) {
    if (finding.severity === 'warn') notices.push({ code: finding.code, message: finding.message });
  }
  for (const finding of contents?.findings ?? []) {
    if (finding.severity === 'notice') notices.push({ code: finding.code, message: finding.message });
  }
  return notices;
}

export class ImportCoordinator {
  private readonly library: ImportLibrary;
  private readonly io: ImportIo;
  private readonly limits: ScanLimits;
  private readonly now: () => number;

  constructor(options: ImportCoordinatorOptions) {
    this.library = options.library;
    this.io = options.io;
    this.limits = options.limits ?? DEFAULT_SCAN_LIMITS;
    this.now = options.now ?? Date.now;
  }

  async import(request: ImportRequest): Promise<ImportOutcome> {
    const filePath = request.filePath.trim();
    if (!filePath) {
      return reject('import/unreadable', 'No file was given to import.');
    }

    // The source names the file; the source is untrusted. Sanitising first means
    // every later message, and the stored record, carry a name safe to show and
    // safe to write.
    const fileName = sanitizeDownloadFilename(request.fileName || filePath);
    const fileKind = classifyImportFile(fileName);
    if (!fileKind) {
      return reject(
        'import/unsupported-type',
        `${fileName} is not a model file this app can print from.`
      );
    }

    let sizeBytes: number | null;
    try {
      sizeBytes = await this.io.statFile(filePath);
    } catch {
      sizeBytes = null;
    }
    if (sizeBytes === null || sizeBytes <= 0) {
      return reject('import/unreadable', `${fileName} is empty or could not be read.`);
    }
    if (sizeBytes > MAX_IMPORT_BYTES) {
      return reject(
        'import/too-large',
        `${fileName} is larger than the ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB import limit.`
      );
    }

    let sha256: string;
    if (request.knownSha256 && isSha256Hex(request.knownSha256)) {
      sha256 = request.knownSha256.toLowerCase();
    } else {
      try {
        sha256 = await this.io.hashFile(filePath, sizeBytes);
      } catch {
        return reject(
          'import/hash-failed',
          `${fileName} could not be verified and was not imported.`
        );
      }
    }

    const existing = await this.library.findBySha256(sha256);
    if (existing) return { status: 'duplicate', record: existing };

    let scan: ScanReport | null = null;
    let contents: ThreeMfContents | null = null;

    if (fileKind === '3mf') {
      scan = await scanThreeMfArchive(this.io.createReader(filePath), sizeBytes, this.limits);
      if (!scan.ok) {
        const first = scan.findings.find((finding) => finding.severity === 'reject');
        return reject(
          'import/archive-rejected',
          first?.message ?? `${fileName} failed its safety check.`,
          scan.findings
        );
      }

      contents = inspectThreeMfEntries(scan.entryNames);
      if (!contents.ok) {
        const first = contents.findings.find((finding) => finding.severity === 'reject');
        return reject(
          'import/content-rejected',
          first?.message ?? `${fileName} holds nothing the U1 can print.`,
          scan.findings,
          contents.findings
        );
      }
    }

    const record: ImportRecord = {
      sha256,
      fileName,
      filePath,
      sizeBytes,
      fileKind,
      sourceKind: request.sourceKind,
      attribution: request.attribution ?? UNKNOWN_ATTRIBUTION,
      importedAt: this.now(),
      contents,
      notices: noticesFrom(scan, contents),
    };

    await this.library.save(record);
    return { status: 'imported', record };
  }
}

/**
 * Where a shared file most likely came from, when the caller cannot say.
 *
 * Only the doors that are actually distinguishable are claimed. Android hands a
 * shared file over as a copy in the app's own storage with no reliable record of
 * the sending app, so a Bambu Handy share is not detectable from the path — a
 * caller that genuinely knows passes `sourceKind` instead, and this is the
 * fallback for one that does not.
 */
export function detectImportSourceFromPath(filePath: string): ImportSourceKind {
  return /(^|\/)downloads?\//i.test(filePath) ? 'downloads' : 'android-share';
}
