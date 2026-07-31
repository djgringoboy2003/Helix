import type { ScanFinding } from './ThreeMfSecurityScanner';
import type { InspectionFinding, ThreeMfContents } from './ThreeMfInspector';

// The shape of an imported model, whatever door it came in through.
//
// `docs/IMPLEMENTATION_BACKLOG.md` Phase 4 lists seven entry points — MakerWorld,
// Android share, Bambu Handy share, the system picker, the Downloads folder, an
// existing library item and a direct URL. Today each reaches the Slice tab by
// its own route with its own ad-hoc payload, so a check added to one is absent
// from the others. `ImportRecord` is the single thing they all produce, and
// `ImportCoordinator` is the only thing that produces it.
//
// The record is what later phases bind to: a job's source artifact identity is
// its `sha256`, and the attribution recorded here is what the licence rules
// require to survive into anything published or shared.

export type ImportSourceKind =
  | 'makerworld'
  | 'android-share'
  | 'bambu-handy'
  | 'file-picker'
  | 'downloads'
  | 'library'
  | 'url';

/**
 * Where a model came from and who made it.
 *
 * Every field is nullable because a file dropped in from the Downloads folder
 * genuinely has no creator or licence, and inventing one would be worse than
 * recording that it is unknown. Nothing here is trusted for safety decisions —
 * it is attribution, not policy.
 */
export interface ImportAttribution {
  /** Provider id, e.g. `makerworld`. Null for local files. */
  provider: string | null;
  modelId: string | null;
  profileId: string | null;
  title: string | null;
  creator: string | null;
  licence: string | null;
  /** Page the model was taken from. Never a signed download URL. */
  pageUrl: string | null;
}

export const UNKNOWN_ATTRIBUTION: ImportAttribution = {
  provider: null,
  modelId: null,
  profileId: null,
  title: null,
  creator: null,
  licence: null,
  pageUrl: null,
};

export type ImportFileKind = '3mf' | 'mesh';

export interface ImportRecord {
  /**
   * The SHA-256 of the file. The hash *is* the identity — two imports of the
   * same bytes are the same model however differently they were named or
   * whichever door they arrived through.
   */
  sha256: string;
  /** Sanitised; safe to display and to write to disk. */
  fileName: string;
  /** Local path, no scheme. Never logged in full. */
  filePath: string;
  sizeBytes: number;
  fileKind: ImportFileKind;
  sourceKind: ImportSourceKind;
  attribution: ImportAttribution;
  importedAt: number;
  /** Null for meshes, which are not archives and have nothing to inspect. */
  contents: ThreeMfContents | null;
  /** Non-fatal findings from the scan and the inspection, for the warnings UI. */
  notices: ImportNotice[];
}

export interface ImportNotice {
  code: string;
  message: string;
}

export type ImportErrorCode =
  /** The file is missing, empty, or could not be read. */
  | 'import/unreadable'
  /** Not a file type this app can print from. */
  | 'import/unsupported-type'
  /** Past the size limit, refused before it is read or hashed. */
  | 'import/too-large'
  /** The archive failed the security scan. */
  | 'import/archive-rejected'
  /** The archive is safe but holds nothing the U1 can print. */
  | 'import/content-rejected'
  /** Hashing failed, so the file has no identity and cannot be tracked. */
  | 'import/hash-failed';

export type ImportOutcome =
  | { status: 'imported'; record: ImportRecord }
  /**
   * The same bytes are already in the library. `record` is the existing one, so
   * a caller can go straight to it; re-importing would fork the history of a
   * model that is already tracked.
   */
  | { status: 'duplicate'; record: ImportRecord }
  | {
      status: 'rejected';
      code: ImportErrorCode;
      message: string;
      /** Whichever checker refused, for a warnings screen that can be specific. */
      scanFindings: ScanFinding[];
      inspectionFindings: InspectionFinding[];
    };

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const MESH_EXTENSIONS: readonly string[] = ['.stl', '.obj', '.step', '.stp'];

/**
 * Decides how a file will be handled from its name.
 *
 * The extension is a routing hint, not a trust decision — a `.3mf` still has to
 * survive the scanner, and `docs/TECHNICAL_ARCHITECTURE.md` is explicit that the
 * extension is not evidence of content.
 */
export function classifyImportFile(fileName: string): ImportFileKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.3mf')) return '3mf';
  if (MESH_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'mesh';
  return null;
}
