// Retargeting a foreign project for the Snapmaker U1.
//
// A MakerWorld 3MF is a *Bambu Studio* project. Its
// `Metadata/project_settings.config` describes another machine completely: its
// bed, its build height, its motion limits, and its start and end G-code. The
// non-negotiable rules in `CLAUDE.md` are explicit that none of that may
// survive:
//
//   - never preserve downloaded machine start or end G-code
//   - never preserve foreign machine dimensions or motion limits
//
// This module decides what to strip, what to replace, and what to keep. It
// produces a **plan** rather than performing the edit, because the edit is a ZIP
// rewrite and `java.util.zip` already does that correctly on the native side
// (`SliceSettings3mfPatcher`). Keeping the policy here means the rules are
// exercised by the repository's own test suite instead of only by slicing
// something and looking at the result.
//
// The central rule is deliberately not a hand-maintained list of dangerous keys:
//
//   **Any key the U1 printer profile defines is a machine key, and its value
//   comes from the U1 profile — never from the download.**
//
// A hand-maintained denylist rots the moment Bambu adds a setting. Sourcing the
// answer from `assets/orca_profiles/printer/snapmaker_u1.json` means a key the
// U1 cares about is always taken from the U1's own profile, and a machine key it
// has never heard of is dropped rather than guessed at.

export type ConfigValue = string | string[];
export type ProjectSettings = Record<string, ConfigValue>;

export type KeyDisposition =
  /** The U1 profile defines this key; its value replaces the downloaded one. */
  | 'machine-replaced'
  /** A machine key the U1 profile does not define — dropped, not guessed. */
  | 'machine-removed'
  /** A process value outside what the U1 can do, brought into range. */
  | 'clamped'
  /** Geometry, appearance and process choices, kept as the designer set them. */
  | 'preserved';

export interface ConversionEntry {
  key: string;
  disposition: KeyDisposition;
  /** Operator-facing explanation. Never contains raw G-code. */
  detail: string;
}

export interface ConversionReport {
  /** False when something could not be retargeted safely. */
  ok: boolean;
  entries: ConversionEntry[];
  /** Counts for the summary line, so the UI does not have to re-derive them. */
  replaced: number;
  removed: number;
  clamped: number;
  preserved: number;
  /** Blocking problems. A non-empty list means do not slice. */
  blockers: string[];
}

export interface U1PreparationPlan {
  /** Keys to write into `project_settings.config`. */
  apply: ProjectSettings;
  /** Keys to delete from it. */
  remove: string[];
  /** Archive entries to drop — stale sliced output from the foreign machine. */
  removeEntries: string[];
  report: ConversionReport;
}

/**
 * Keys that are about a machine but that the U1 profile does not define.
 *
 * Matched by prefix, so a vendor-specific setting this code has never seen is
 * still dropped. `CLAUDE.md` requires failing closed, and an unrecognised
 * machine key from another printer is exactly the unknown state that rule is
 * about.
 */
const FOREIGN_MACHINE_PREFIXES: readonly string[] = [
  'machine_',
  'printer_',
  'printhost_',
  'print_host',
  'bed_custom_',
  'bbl_',
  'bambu_',
];

/**
 * Machine-ish keys with no shared prefix.
 *
 * `curr_bed_type` names a plate that does not exist on a U1, and the bed type
 * drives first-layer temperature, so carrying it over would apply another
 * machine's surface to this one.
 */
const FOREIGN_MACHINE_KEYS: readonly string[] = [
  'curr_bed_type',
  'gcode_flavor',
  'extruder_offset',
  'extruder_clearance_radius',
  'extruder_clearance_height_to_rod',
  'extruder_clearance_height_to_lid',
  'host_type',
  'print_host',
  'printhost_apikey',
  'printhost_cafile',
  'thumbnails',
  'thumbnails_format',
];

/**
 * Nozzle temperature bounds.
 *
 * Not in the printer profile — temperature is a filament property — so the
 * limits mirror `HelixSliceRunner.parseMaterialProfiles`, which already clamps
 * to this range on the native side.
 */
export const U1_NOZZLE_TEMP_RANGE = { min: 160, max: 300 } as const;
export const U1_BED_TEMP_RANGE = { min: 0, max: 110 } as const;

const TEMPERATURE_KEYS: readonly string[] = [
  'nozzle_temperature',
  'nozzle_temperature_initial_layer',
];

const BED_TEMPERATURE_KEYS: readonly string[] = [
  'hot_plate_temp',
  'hot_plate_temp_initial_layer',
  'textured_plate_temp',
  'textured_plate_temp_initial_layer',
  'cool_plate_temp',
  'cool_plate_temp_initial_layer',
  'eng_plate_temp',
  'eng_plate_temp_initial_layer',
];

function isForeignMachineKey(key: string): boolean {
  if (FOREIGN_MACHINE_KEYS.includes(key)) return true;
  return FOREIGN_MACHINE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** First element of an array-valued setting, or the value itself. */
function firstOf(value: ConfigValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  // Orca writes percentages ("15%") and plain numbers in the same shape.
  const cleaned = value.trim().replace(/%$/, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface LayerHeightLimits {
  min: number;
  max: number;
}

/**
 * What layer heights the U1 profile allows for its nozzle.
 *
 * Both limits are per-extruder arrays in the profile. The tightest pair across
 * extruders is used, because a project is sliced for the machine as a whole and
 * the narrowest limit is the one that always holds.
 */
export function layerHeightLimitsOf(u1Profile: ProjectSettings): LayerHeightLimits | null {
  const mins = u1Profile.min_layer_height;
  const maxes = u1Profile.max_layer_height;
  const minValues = (Array.isArray(mins) ? mins : [mins])
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null);
  const maxValues = (Array.isArray(maxes) ? maxes : [maxes])
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null);

  if (minValues.length === 0 || maxValues.length === 0) return null;
  const min = Math.max(...minValues);
  const max = Math.min(...maxValues);
  return max >= min ? { min, max } : null;
}

interface ClampOutcome {
  value: ConfigValue;
  detail: string;
}

/** Brings one numeric setting into range, preserving its array shape. */
function clampNumeric(
  value: ConfigValue,
  min: number,
  max: number,
  unit: string
): ClampOutcome | null {
  const clampOne = (raw: string): { text: string; changed: boolean } => {
    const parsed = toNumber(raw);
    if (parsed === null) return { text: raw, changed: false };
    const bounded = Math.min(Math.max(parsed, min), max);
    if (bounded === parsed) return { text: raw, changed: false };
    return { text: String(bounded), changed: true };
  };

  if (Array.isArray(value)) {
    const results = value.map(clampOne);
    if (!results.some((result) => result.changed)) return null;
    return {
      value: results.map((result) => result.text),
      detail: `Brought within the U1's ${min}–${max}${unit} range.`,
    };
  }

  const result = clampOne(value);
  if (!result.changed) return null;
  return {
    value: result.text,
    detail: `${value}${unit} is outside the U1's ${min}–${max}${unit} range; using ${result.text}${unit}.`,
  };
}

export interface PrepareOptions {
  /** Sliced output found by `ThreeMfInspector`, which must not survive. */
  slicedOutputPaths?: readonly string[];
}

/**
 * Plans the retargeting of one foreign project onto the U1.
 *
 * Nothing is written here. The returned plan says which keys to set, which to
 * delete, and which archive entries to drop, and the report explains every one
 * of those decisions to the operator.
 */
export function planU1Preparation(
  foreign: ProjectSettings,
  u1Profile: ProjectSettings,
  options: PrepareOptions = {}
): U1PreparationPlan {
  const apply: ProjectSettings = {};
  const remove: string[] = [];
  const entries: ConversionEntry[] = [];
  const blockers: string[] = [];

  const layerLimits = layerHeightLimitsOf(u1Profile);

  for (const key of Object.keys(foreign)) {
    // 1. The U1 profile owns this key. Its value wins, always.
    if (Object.prototype.hasOwnProperty.call(u1Profile, key)) {
      apply[key] = u1Profile[key];
      entries.push({
        key,
        disposition: 'machine-replaced',
        detail: "Replaced with the Snapmaker U1's own value.",
      });
      continue;
    }

    // 2. A machine key the U1 does not define. Dropped rather than guessed.
    if (isForeignMachineKey(key)) {
      remove.push(key);
      entries.push({
        key,
        disposition: 'machine-removed',
        detail: 'Belongs to the source machine and has no U1 equivalent.',
      });
      continue;
    }

    // 3. Process settings the U1 cannot honour as written.
    const clamped = clampSetting(key, foreign[key], layerLimits);
    if (clamped) {
      apply[key] = clamped.value;
      entries.push({ key, disposition: 'clamped', detail: clamped.detail });
      continue;
    }

    // 4. Everything else is the designer's intent, and is kept.
    entries.push({
      key,
      disposition: 'preserved',
      detail: 'Kept as the designer set it.',
    });
  }

  // The U1's identity is asserted even when the download never mentioned it, so
  // the prepared file names this machine rather than inheriting a default.
  for (const key of U1_IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(apply, key)) continue;
    const value = u1Profile[key];
    if (value === undefined) continue;
    apply[key] = value;
    entries.push({
      key,
      disposition: 'machine-replaced',
      detail: "Set from the Snapmaker U1's own profile.",
    });
  }

  if (!Object.prototype.hasOwnProperty.call(apply, 'printable_area')) {
    blockers.push(
      'The bundled Snapmaker U1 profile is missing its bed shape, so this project cannot be retargeted safely.'
    );
  }
  if (!Object.prototype.hasOwnProperty.call(apply, 'machine_start_gcode')) {
    blockers.push(
      "The bundled Snapmaker U1 profile has no start G-code, so the downloaded machine's could not be replaced."
    );
  }

  const removeEntries = [...(options.slicedOutputPaths ?? [])];

  return {
    apply,
    remove,
    removeEntries,
    report: {
      ok: blockers.length === 0,
      entries,
      replaced: entries.filter((entry) => entry.disposition === 'machine-replaced').length,
      removed: entries.filter((entry) => entry.disposition === 'machine-removed').length,
      clamped: entries.filter((entry) => entry.disposition === 'clamped').length,
      preserved: entries.filter((entry) => entry.disposition === 'preserved').length,
      blockers,
    },
  };
}

/**
 * Machine identity that must be present in the prepared file whether or not the
 * download mentioned it.
 *
 * A Bambu project that simply omits `printable_height` would otherwise leave the
 * engine to fall back on something, and "something" is not a safe answer for a
 * build volume.
 */
const U1_IDENTITY_KEYS: readonly string[] = [
  'printer_model',
  'printer_settings_id',
  'printer_variant',
  'printable_area',
  'printable_height',
  'nozzle_diameter',
  'machine_start_gcode',
  'machine_end_gcode',
  'layer_change_gcode',
  'change_filament_gcode',
  'machine_pause_gcode',
  'before_layer_change_gcode',
  'time_lapse_gcode',
];

function clampSetting(
  key: string,
  value: ConfigValue,
  layerLimits: LayerHeightLimits | null
): ClampOutcome | null {
  if (layerLimits && (key === 'layer_height' || key === 'initial_layer_print_height')) {
    return clampNumeric(value, layerLimits.min, layerLimits.max, ' mm');
  }
  if (TEMPERATURE_KEYS.includes(key)) {
    return clampNumeric(value, U1_NOZZLE_TEMP_RANGE.min, U1_NOZZLE_TEMP_RANGE.max, '°C');
  }
  if (BED_TEMPERATURE_KEYS.includes(key)) {
    return clampNumeric(value, U1_BED_TEMP_RANGE.min, U1_BED_TEMP_RANGE.max, '°C');
  }
  return null;
}

// --- build volume ----------------------------------------------------------

export interface ObjectExtent {
  name: string;
  /** Millimetres, after the scale and rotation the project applies. */
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export interface BuildVolume {
  width: number;
  depth: number;
  height: number;
}

export interface FitFinding {
  name: string;
  axis: 'x' | 'y' | 'z';
  sizeMm: number;
  limitMm: number;
}

export interface FitReport {
  ok: boolean;
  volume: BuildVolume;
  tooLarge: FitFinding[];
}

/**
 * Reads the U1's build volume out of its own profile.
 *
 * `printable_area` is a polygon of `"XxY"` corners, so the usable width and
 * depth are the extents of that polygon rather than the last corner's numbers.
 */
export function buildVolumeOf(u1Profile: ProjectSettings): BuildVolume | null {
  const area = u1Profile.printable_area;
  const corners = (Array.isArray(area) ? area : [area])
    .map((corner) => {
      const match = /^(-?[\d.]+)x(-?[\d.]+)$/i.exec(String(corner).trim());
      if (!match) return null;
      const x = Number(match[1]);
      const y = Number(match[2]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    })
    .filter((corner): corner is { x: number; y: number } => corner !== null);

  if (corners.length < 3) return null;
  const height = toNumber(firstOf(u1Profile.printable_height));
  if (height === null || height <= 0) return null;

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    depth: Math.max(...ys) - Math.min(...ys),
    height,
  };
}

/**
 * Checks that every object fits the U1.
 *
 * Deliberately compares each object's own extent rather than the arrangement:
 * a part taller or wider than the machine can never be printed whatever the
 * layout, and that is worth saying before a slice runs rather than after.
 * Whether several parts fit *together* is the arrangement's problem, and the
 * engine already reports it.
 */
export function checkFitsBuildVolume(
  objects: readonly ObjectExtent[],
  volume: BuildVolume
): FitReport {
  const tooLarge: FitFinding[] = [];
  for (const object of objects) {
    if (object.sizeX > volume.width) {
      tooLarge.push({ name: object.name, axis: 'x', sizeMm: object.sizeX, limitMm: volume.width });
    }
    if (object.sizeY > volume.depth) {
      tooLarge.push({ name: object.name, axis: 'y', sizeMm: object.sizeY, limitMm: volume.depth });
    }
    if (object.sizeZ > volume.height) {
      tooLarge.push({ name: object.name, axis: 'z', sizeMm: object.sizeZ, limitMm: volume.height });
    }
  }
  return { ok: tooLarge.length === 0, volume, tooLarge };
}

/** One line per problem, for the warnings screen. */
export function describeFit(report: FitReport): string[] {
  return report.tooLarge.map(
    (finding) =>
      `${finding.name} is ${finding.sizeMm.toFixed(1)} mm in ${finding.axis.toUpperCase()}, over the U1's ${finding.limitMm.toFixed(0)} mm.`
  );
}
