// What is actually inside a 3MF, once it is known to be safe to open.
//
// `ThreeMfSecurityScanner` answers "can this archive be opened at all". This
// answers "is there anything here the U1 can print, and what will preparation
// have to strip". The two are deliberately separate: the scanner judges the
// container, this judges the payload.
//
// Like the scanner, this reads **only the archive index** — entry paths and the
// sizes already parsed from the central directory. Nothing is inflated. Every
// question Phase 4 of `docs/IMPLEMENTATION_BACKLOG.md` asks of an import
// (missing geometry, geometry-only, pre-sliced-only, multi-plate) is decidable
// from the paths alone, so the import path never has to decompress bytes from an
// untrusted source to classify it.
//
// Reading part *contents* — the creator string inside `3dmodel.model`, XML
// entity expansion, the settings in `project_settings.config` — needs a DEFLATE
// implementation and belongs to `U1ProjectPreparer` in Phase 5, which is the
// component that actually parses those parts. Attribution for an import comes
// from the `ModelReference` the provider recorded at download time, not from
// self-declared metadata inside the archive.

export type ThreeMfContentKind =
  /** Editable geometry, nothing pre-sliced. The normal MakerWorld case. */
  | 'geometry'
  /** Geometry plus sliced output from a foreign machine. */
  | 'geometry-and-gcode'
  /** Sliced output only — nothing left to re-slice for the U1. */
  | 'pre-sliced-only'
  /** Neither. */
  | 'empty';

export type InspectionSeverity = 'reject' | 'notice';

export type InspectionCode =
  | 'content/no-geometry'
  | 'content/pre-sliced-only'
  | 'content/multi-plate'
  | 'content/foreign-slice-output'
  | 'content/foreign-profile';

export interface InspectionFinding {
  code: InspectionCode;
  severity: InspectionSeverity;
  message: string;
}

export interface PlateSummary {
  id: number;
  /** Sliced G-code for this plate is present, and will not survive preparation. */
  hasGcode: boolean;
  /** Archive path of the plate render, for the picker. Not yet extracted. */
  thumbnailPath: string | null;
  smallThumbnailPath: string | null;
}

export interface ThreeMfContents {
  kind: ThreeMfContentKind;
  /** False when a `reject` finding is present. */
  ok: boolean;
  findings: InspectionFinding[];
  /** `.model` parts, in archive order. */
  modelParts: string[];
  /**
   * Plates declared by `Metadata/plate_N.*`. Empty means a plain 3MF with one
   * implicit plate, not a file with no plates.
   */
  plates: PlateSummary[];
  /** Convenience: `plates.length` clamped to a minimum of 1. */
  plateCount: number;
  /** Sliced output and its checksums — everything preparation has to discard. */
  slicedOutputPaths: string[];
  /** A foreign slicer's saved profile, which must not be carried onto the U1. */
  hasProjectSettings: boolean;
  hasModelSettings: boolean;
  hasSliceInfo: boolean;
  /** Whether the layout looks like Bambu Studio / Orca rather than a plain 3MF. */
  producer: 'bambu-or-orca' | 'generic';
}

const PLATE_GCODE = /^metadata\/plate_(\d+)\.gcode$/;
const PLATE_GCODE_CHECKSUM = /^metadata\/plate_(\d+)\.gcode\.md5$/;
const PLATE_THUMBNAIL = /^metadata\/plate_(\d+)\.png$/;
const PLATE_SMALL_THUMBNAIL = /^metadata\/plate_(\d+)_small\.png$/;

const PROJECT_SETTINGS = 'metadata/project_settings.config';
const MODEL_SETTINGS = 'metadata/model_settings.config';
const SLICE_INFO = 'metadata/slice_info.config';

function isModelPart(lower: string): boolean {
  return lower.endsWith('.model');
}

function isGcode(lower: string): boolean {
  return lower.endsWith('.gcode') || lower.endsWith('.gcode.md5') || lower.endsWith('.gco');
}

interface PlateAccumulator {
  hasGcode: boolean;
  thumbnailPath: string | null;
  smallThumbnailPath: string | null;
}

function plateFor(plates: Map<number, PlateAccumulator>, id: number): PlateAccumulator {
  const existing = plates.get(id);
  if (existing) return existing;
  const created: PlateAccumulator = {
    hasGcode: false,
    thumbnailPath: null,
    smallThumbnailPath: null,
  };
  plates.set(id, created);
  return created;
}

/**
 * Classifies an archive from its entry paths.
 *
 * Takes the names rather than a reader so it composes with `ScanReport`, which
 * already carries `entryNames` from the single index read the scanner did.
 */
export function inspectThreeMfEntries(entryNames: readonly string[]): ThreeMfContents {
  const modelParts: string[] = [];
  const slicedOutputPaths: string[] = [];
  const plates = new Map<number, PlateAccumulator>();

  let hasProjectSettings = false;
  let hasModelSettings = false;
  let hasSliceInfo = false;

  for (const name of entryNames) {
    if (name.endsWith('/')) continue; // directory entries describe no content
    const lower = name.toLowerCase();

    if (isModelPart(lower)) modelParts.push(name);
    if (isGcode(lower)) slicedOutputPaths.push(name);

    if (lower === PROJECT_SETTINGS) hasProjectSettings = true;
    if (lower === MODEL_SETTINGS) hasModelSettings = true;
    if (lower === SLICE_INFO) hasSliceInfo = true;

    const gcodeMatch = PLATE_GCODE.exec(lower) ?? PLATE_GCODE_CHECKSUM.exec(lower);
    if (gcodeMatch) {
      plateFor(plates, Number(gcodeMatch[1])).hasGcode = true;
      continue;
    }
    const smallMatch = PLATE_SMALL_THUMBNAIL.exec(lower);
    if (smallMatch) {
      plateFor(plates, Number(smallMatch[1])).smallThumbnailPath = name;
      continue;
    }
    const thumbnailMatch = PLATE_THUMBNAIL.exec(lower);
    if (thumbnailMatch) {
      plateFor(plates, Number(thumbnailMatch[1])).thumbnailPath = name;
    }
  }

  const orderedPlates: PlateSummary[] = [...plates.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, plate]) => ({ id, ...plate }));

  const hasGeometry = modelParts.length > 0;
  const hasSlicedOutput = slicedOutputPaths.length > 0;
  const kind: ThreeMfContentKind = hasGeometry
    ? hasSlicedOutput
      ? 'geometry-and-gcode'
      : 'geometry'
    : hasSlicedOutput
      ? 'pre-sliced-only'
      : 'empty';

  const findings: InspectionFinding[] = [];

  if (kind === 'pre-sliced-only') {
    // The safety rules forbid preserving a foreign machine's G-code, and there
    // is no geometry left to slice for the U1, so this file has nothing usable
    // in it. Saying so here beats failing later inside the slicer.
    findings.push({
      code: 'content/pre-sliced-only',
      severity: 'reject',
      message:
        'This file holds only G-code sliced for another machine, and no editable geometry. It cannot be retargeted for the U1.',
    });
  } else if (kind === 'empty') {
    findings.push({
      code: 'content/no-geometry',
      severity: 'reject',
      message: 'No model geometry was found in this file.',
    });
  }

  if (orderedPlates.length > 1) {
    findings.push({
      code: 'content/multi-plate',
      severity: 'notice',
      message: `This project has ${orderedPlates.length} plates. Choose one before slicing.`,
    });
  }
  if (kind === 'geometry-and-gcode') {
    findings.push({
      code: 'content/foreign-slice-output',
      severity: 'notice',
      message: 'Sliced G-code from another machine is present and will be discarded.',
    });
  }
  if (hasProjectSettings) {
    findings.push({
      code: 'content/foreign-profile',
      severity: 'notice',
      message: 'This project carries another slicer’s settings, which will be rebuilt for the U1.',
    });
  }

  return {
    kind,
    ok: !findings.some((item) => item.severity === 'reject'),
    findings,
    modelParts,
    plates: orderedPlates,
    plateCount: Math.max(orderedPlates.length, 1),
    slicedOutputPaths,
    hasProjectSettings,
    hasModelSettings,
    hasSliceInfo,
    producer:
      hasProjectSettings || hasModelSettings || hasSliceInfo || orderedPlates.length > 0
        ? 'bambu-or-orca'
        : 'generic',
  };
}

export function rejectionsOf(contents: ThreeMfContents): InspectionFinding[] {
  return contents.findings.filter((item) => item.severity === 'reject');
}
