import type { BuildVolume } from '../prepare/U1ProjectPreparer';
import {
  createGcodeScanner,
  parseGcodeMetadata,
  type GcodeMetadata,
  type PrintExtents,
} from './GcodeReview';

// Reviewing a slice before anything is uploaded.
//
// This is the step `CLAUDE.md`'s workflow calls "preview actual G-code", and it
// produces the **output SHA-256** — one of the two values a start approval binds
// to (the other is the filament mapping hash from Phase 6).
//
// The hash is taken over the finished file, after every native post-process has
// run (`GcodeToolMapper`, `GcodeFirstLayerGuard`, `GcodeThumbnailInjector`,
// `GcodeFilamentColors`). Hashing earlier would bind an approval to bytes that
// are not the bytes that get uploaded.
//
// Findings are reported rather than thrown, and an out-of-bounds print is
// `blocking`: a toolpath outside the bed is the printer being driven into its
// own frame.

export interface GcodeIo {
  /** Size in bytes, or null when the path is missing or unreadable. */
  statFile(filePath: string): Promise<number | null>;
  /** Reads a byte range and decodes it as text. */
  readTextChunk(filePath: string, offset: number, length: number): Promise<string>;
  hashFile(filePath: string, sizeBytes: number): Promise<string>;
}

export type ReviewFindingCode =
  | 'gcode/unreadable'
  | 'gcode/empty'
  | 'gcode/no-extrusion'
  | 'gcode/out-of-bounds'
  | 'gcode/below-bed'
  | 'gcode/hash-failed'
  | 'gcode/no-thumbnail'
  | 'gcode/wrong-printer';

export type ReviewSeverity = 'blocking' | 'warning' | 'info';

export interface ReviewFinding {
  code: ReviewFindingCode;
  severity: ReviewSeverity;
  message: string;
}

export interface SliceReview {
  filePath: string;
  sizeBytes: number;
  /** The identity a start approval binds to. Empty only when hashing failed. */
  sha256: string;
  extents: PrintExtents | null;
  metadata: GcodeMetadata;
  findings: ReviewFinding[];
  /** False when any finding is blocking. Nothing may be uploaded until true. */
  ok: boolean;
}

/**
 * How much is read from each end for the metadata pass.
 *
 * Orca writes its header block at the start and its config block at the end, so
 * both ends are read whole rather than streamed — that avoids a multi-byte
 * character split across a chunk boundary mattering anywhere it could affect a
 * parsed value.
 */
export const METADATA_WINDOW_BYTES = 256 * 1024;

/** Chunk size for the extent scan. Commands are ASCII, so splits are harmless. */
export const SCAN_CHUNK_BYTES = 512 * 1024;

/** Margin allowed outside the bed before a print is called out of bounds. */
export const BED_TOLERANCE_MM = 0.5;

function finding(
  code: ReviewFindingCode,
  severity: ReviewSeverity,
  message: string
): ReviewFinding {
  return { code, severity, message };
}

function emptyMetadata(): GcodeMetadata {
  return {
    values: {},
    layerCount: null,
    layerHeight: null,
    nozzleDiameter: null,
    printerModel: null,
    filamentTypes: [],
    filamentColors: [],
    estimatedSeconds: null,
    filamentGrams: null,
    hasThumbnail: false,
  };
}

function failed(filePath: string, item: ReviewFinding): SliceReview {
  return {
    filePath,
    sizeBytes: 0,
    sha256: '',
    extents: null,
    metadata: emptyMetadata(),
    findings: [item],
    ok: false,
  };
}

export interface ReviewRequest {
  filePath: string;
  /** The U1's usable volume, from `buildVolumeOf` on the bundled profile. */
  volume: BuildVolume;
  /** Expected printer model, when the caller knows it. */
  expectedPrinterModel?: string;
}

/**
 * Reads a sliced file and judges it.
 *
 * The order matters: the file is scanned before it is hashed, so a file that is
 * obviously unusable costs no hashing time — and the hash, once taken, describes
 * a file that has already been judged.
 */
export async function reviewSlicedGcode(
  request: ReviewRequest,
  io: GcodeIo
): Promise<SliceReview> {
  const { filePath, volume } = request;

  let sizeBytes: number | null;
  try {
    sizeBytes = await io.statFile(filePath);
  } catch {
    sizeBytes = null;
  }
  if (sizeBytes === null) {
    return failed(filePath, finding('gcode/unreadable', 'blocking', 'The sliced file could not be read.'));
  }
  if (sizeBytes <= 0) {
    return failed(filePath, finding('gcode/empty', 'blocking', 'The slicer produced an empty file.'));
  }

  let metadata: GcodeMetadata;
  let extents: PrintExtents | null;
  try {
    metadata = await readMetadata(filePath, sizeBytes, io);
    extents = await scanExtents(filePath, sizeBytes, io);
  } catch {
    return failed(
      filePath,
      finding('gcode/unreadable', 'blocking', 'The sliced file could not be read to the end.')
    );
  }

  const findings: ReviewFinding[] = [];

  if (!extents || extents.extrudingMoves === 0) {
    findings.push(
      finding(
        'gcode/no-extrusion',
        'blocking',
        'This file never extrudes anything. Nothing would be printed.'
      )
    );
  } else {
    findings.push(...checkBounds(extents, volume));
  }

  if (!metadata.hasThumbnail) {
    findings.push(
      finding('gcode/no-thumbnail', 'info', 'This file carries no preview image.')
    );
  }

  if (
    request.expectedPrinterModel &&
    metadata.printerModel &&
    metadata.printerModel.trim().toLowerCase() !== request.expectedPrinterModel.trim().toLowerCase()
  ) {
    // Not blocking on its own: the header is the slicer's claim, and Phase 5
    // already rebuilt the machine identity. But a disagreement here means one
    // of those two is wrong, and the operator should see it.
    findings.push(
      finding(
        'gcode/wrong-printer',
        'warning',
        `This file names ${metadata.printerModel}, not ${request.expectedPrinterModel}.`
      )
    );
  }

  let sha256 = '';
  try {
    sha256 = await io.hashFile(filePath, sizeBytes);
  } catch {
    findings.push(
      finding(
        'gcode/hash-failed',
        'blocking',
        'The sliced file could not be verified, so it cannot be approved for printing.'
      )
    );
  }

  return {
    filePath,
    sizeBytes,
    sha256,
    extents,
    metadata,
    findings,
    ok: !findings.some((item) => item.severity === 'blocking'),
  };
}

async function readMetadata(
  filePath: string,
  sizeBytes: number,
  io: GcodeIo
): Promise<GcodeMetadata> {
  const headLength = Math.min(sizeBytes, METADATA_WINDOW_BYTES);
  const head = await io.readTextChunk(filePath, 0, headLength);

  if (sizeBytes <= METADATA_WINDOW_BYTES) return parseGcodeMetadata(head);

  const tailLength = Math.min(sizeBytes - headLength, METADATA_WINDOW_BYTES);
  const tail = await io.readTextChunk(filePath, sizeBytes - tailLength, tailLength);
  return parseGcodeMetadata(`${head}\n${tail}`);
}

async function scanExtents(
  filePath: string,
  sizeBytes: number,
  io: GcodeIo
): Promise<PrintExtents | null> {
  const scanner = createGcodeScanner();
  for (let offset = 0; offset < sizeBytes; offset += SCAN_CHUNK_BYTES) {
    const length = Math.min(SCAN_CHUNK_BYTES, sizeBytes - offset);
    scanner.push(await io.readTextChunk(filePath, offset, length));
  }
  return scanner.result();
}

/** Bed coordinates run from the origin; anything outside is off the plate. */
export function checkBounds(extents: PrintExtents, volume: BuildVolume): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const over: string[] = [];

  if (extents.minX < -BED_TOLERANCE_MM) over.push(`X starts at ${extents.minX.toFixed(1)} mm`);
  if (extents.minY < -BED_TOLERANCE_MM) over.push(`Y starts at ${extents.minY.toFixed(1)} mm`);
  if (extents.maxX > volume.width + BED_TOLERANCE_MM) {
    over.push(`X reaches ${extents.maxX.toFixed(1)} mm, past ${volume.width.toFixed(0)} mm`);
  }
  if (extents.maxY > volume.depth + BED_TOLERANCE_MM) {
    over.push(`Y reaches ${extents.maxY.toFixed(1)} mm, past ${volume.depth.toFixed(0)} mm`);
  }
  if (extents.maxZ > volume.height + BED_TOLERANCE_MM) {
    over.push(`Z reaches ${extents.maxZ.toFixed(1)} mm, past ${volume.height.toFixed(0)} mm`);
  }

  if (over.length > 0) {
    findings.push(
      finding(
        'gcode/out-of-bounds',
        'blocking',
        `This file prints outside the bed: ${over.join('; ')}.`
      )
    );
  }

  if (extents.minZ < -BED_TOLERANCE_MM) {
    findings.push(
      finding(
        'gcode/below-bed',
        'blocking',
        `This file extrudes below the bed, at Z ${extents.minZ.toFixed(2)} mm.`
      )
    );
  }

  return findings;
}

export interface CriticalSetting {
  label: string;
  value: string;
}

/**
 * The handful of values worth reading before committing a print.
 *
 * Chosen for what an operator would catch a mistake with — not a settings dump.
 * Anything missing is simply omitted rather than shown as unknown.
 */
export function criticalSettings(review: SliceReview): CriticalSetting[] {
  const out: CriticalSetting[] = [];
  const { metadata, extents } = review;

  if (metadata.layerHeight !== null) {
    out.push({ label: 'Layer height', value: `${metadata.layerHeight} mm` });
  }
  if (metadata.nozzleDiameter !== null) {
    out.push({ label: 'Nozzle', value: `${metadata.nozzleDiameter} mm` });
  }
  if (metadata.layerCount !== null) {
    out.push({ label: 'Layers', value: String(metadata.layerCount) });
  }
  if (metadata.filamentTypes.length > 0) {
    out.push({ label: 'Filament', value: metadata.filamentTypes.join(', ') });
  }
  if (metadata.filamentGrams !== null) {
    out.push({ label: 'Filament used', value: `${metadata.filamentGrams} g` });
  }
  if (metadata.estimatedSeconds !== null) {
    out.push({ label: 'Estimated time', value: formatDuration(metadata.estimatedSeconds) });
  }
  if (extents) {
    out.push({
      label: 'Footprint',
      value: `${(extents.maxX - extents.minX).toFixed(0)} × ${(extents.maxY - extents.minY).toFixed(0)} × ${extents.maxZ.toFixed(0)} mm`,
    });
  }
  if (metadata.printerModel) {
    out.push({ label: 'Printer', value: metadata.printerModel });
  }
  return out;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
