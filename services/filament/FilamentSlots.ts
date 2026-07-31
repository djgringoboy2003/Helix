// Reading the two sides of a filament mapping.
//
// One side is what the *project* asks for — the colours and materials the
// designer sliced against, which live in the 3MF's `project_settings.config`.
// The other is what is *physically loaded* on the U1 right now, which the
// printer reports in `print_task_config` and, when multiACE is present, in the
// ACE controller's `head_source`.
//
// Both readers are total and defensive: every field arrives from a printer or a
// downloaded file, so a missing, misspelt or wrongly-typed value has to produce
// "unknown" rather than an exception or a confident wrong answer. `CLAUDE.md`
// requires failing closed when printer state is unknown, and that starts with
// being able to say "unknown" at all — hence `status: 'unknown'` being distinct
// from `'empty'` throughout.

export type SlotStatus = 'loaded' | 'empty' | 'busy' | 'unknown';

export interface LoadedSlot {
  /** Physical U1 toolhead, 0-3. */
  toolhead: number;
  status: SlotStatus;
  /** `PLA`, `PETG`… Empty string when the printer did not say. */
  material: string;
  /** `#RRGGBB`, or empty string when unknown. Never a guess. */
  color: string;
  brand: string;
  /**
   * The spool was identified by RFID, so what it *is* is not the operator's to
   * declare. Changing this head means physically swapping the spool.
   */
  rfidLocked: boolean;
  /** Where the reading came from, for showing how much to trust it. */
  source: 'printer' | 'ace' | 'unknown';
}

export interface ProjectFilament {
  /** Filament index as the project numbers it, 0-based. */
  sourceIndex: number;
  material: string;
  color: string;
}

export const U1_TOOLHEAD_COUNT = 4;

function stringAt(raw: unknown, index: number): string {
  if (!Array.isArray(raw)) return '';
  const value = raw[index];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalises a colour to `#RRGGBB`.
 *
 * The printer sends `RRGGBBAA` without a hash; project files send `#RRGGBB` or
 * `#RRGGBBAA`. Alpha is dropped rather than compared — a filament has no
 * transparency the mapping cares about.
 */
export function normalizeHexColor(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().replace(/^#/, '');
  if (!/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value)) return '';
  return `#${value.slice(0, 6).toUpperCase()}`;
}

/**
 * A `#000000` with nothing else known is the printer's "no data" value, not a
 * black spool.
 *
 * Treating it as real black is how a mapping silently matches every unknown
 * slot to a black project colour, which is precisely the guess the safety rules
 * forbid.
 */
function isPlaceholderBlack(color: string, material: string, brand: string): boolean {
  if (color !== '#000000') return false;
  const vendor = brand.toUpperCase();
  return !material && (!vendor || vendor === 'NONE' || vendor === 'GENERIC');
}

export interface AceHeadSource {
  material?: string | undefined;
  colorHex?: string | undefined;
  brand?: string | undefined;
  /** Present when the lane's spool was read from RFID. */
  sku?: string | undefined;
}

/**
 * What is loaded on each of the four toolheads.
 *
 * `print_task_config` is the primary source because it describes the *heads*.
 * ACE `head_source` fills gaps: it knows which lane feeds each head, and it is
 * the only place an RFID SKU appears, which is what makes a slot locked.
 */
export function readLoadedSlots(
  printTaskConfig: unknown,
  headSources: readonly (AceHeadSource | null)[] = []
): LoadedSlot[] {
  const task =
    printTaskConfig && typeof printTaskConfig === 'object'
      ? (printTaskConfig as Record<string, unknown>)
      : {};
  const exists = Array.isArray(task.filament_exist) ? task.filament_exist : null;

  return Array.from({ length: U1_TOOLHEAD_COUNT }, (_, toolhead) => {
    const present = exists ? exists[toolhead] : undefined;
    const status: SlotStatus =
      typeof present === 'boolean' ? (present ? 'loaded' : 'empty') : 'unknown';

    const ace = headSources[toolhead] ?? null;

    if (status === 'empty') {
      // An empty head has nothing to describe, and carrying stale metadata for
      // it would let a mapping match against filament that is not there.
      return {
        toolhead,
        status,
        material: '',
        color: '',
        brand: '',
        rfidLocked: false,
        source: 'printer' as const,
      };
    }

    const type = stringAt(task.filament_type, toolhead);
    const subType = stringAt(task.filament_sub_type, toolhead);
    const vendor = stringAt(task.filament_vendor, toolhead);
    const printerMaterial = type && type.toUpperCase() !== 'NONE'
      ? [type, subType && subType.toUpperCase() !== 'NONE' ? subType : ''].filter(Boolean).join(' ')
      : '';
    const printerBrand = vendor && vendor.toUpperCase() !== 'NONE' ? vendor : '';
    const printerColor = normalizeHexColor(stringAt(task.filament_color_rgba, toolhead));

    const material = printerMaterial || (ace?.material ?? '').trim();
    const brand = printerBrand || (ace?.brand ?? '').trim();
    const aceColor = normalizeHexColor(ace?.colorHex);
    const color = isPlaceholderBlack(printerColor, material, brand)
      ? aceColor
      : printerColor || aceColor;

    // `source` describes what actually survived, not what was read. A printer
    // colour discarded as a placeholder must not leave the slot claiming the
    // printer told us something.
    const usedPrinterValue =
      Boolean(printerMaterial) || (Boolean(printerColor) && color === printerColor);
    const source: LoadedSlot['source'] = usedPrinterValue
      ? 'printer'
      : material || color
        ? 'ace'
        : 'unknown';

    return {
      toolhead,
      status,
      material,
      color,
      brand,
      rfidLocked: Boolean(ace?.sku && ace.sku.trim()),
      source,
    };
  });
}

/**
 * The colours a project was designed in.
 *
 * `filament_colour` is authoritative for how many filaments the project uses;
 * `filament_type` is aligned to it by position and may be shorter, in which case
 * the material is simply unknown rather than assumed to be PLA.
 */
export function readProjectFilaments(projectSettings: unknown): ProjectFilament[] {
  const settings =
    projectSettings && typeof projectSettings === 'object'
      ? (projectSettings as Record<string, unknown>)
      : {};
  const colours = settings.filament_colour;
  if (!Array.isArray(colours) || colours.length === 0) return [];

  return colours.map((raw, sourceIndex) => ({
    sourceIndex,
    material: stringAt(settings.filament_type, sourceIndex),
    color: normalizeHexColor(raw),
  }));
}

/** Squared RGB distance, 0 for identical. Cheap and good enough to rank by. */
export function colorDistance(a: string, b: string): number | null {
  const parse = (hex: string): [number, number, number] | null => {
    const value = normalizeHexColor(hex).replace('#', '');
    if (!value) return null;
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  return (
    (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2
  );
}

/**
 * How far apart two colours may be before the operator is told.
 *
 * Roughly 24 units per channel. Tight enough to catch "red where blue was
 * designed", loose enough not to complain about two slightly different whites.
 */
export const COLOR_MATCH_THRESHOLD = 24 * 24 * 3;

/** Materials match on their base type: `PLA Matte` and `PLA` are both PLA. */
export function materialsMatch(a: string, b: string): boolean {
  const base = (value: string) => value.trim().toUpperCase().split(/[\s-]/)[0] ?? '';
  const left = base(a);
  const right = base(b);
  if (!left || !right) return false;
  return left === right;
}
