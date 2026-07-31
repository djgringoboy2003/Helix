import {
  filamentMapHash,
  type FilamentMapping,
  type FilamentSlotMapping,
  type PrintJobWarning,
  type PrintJobWarningLevel,
} from '../jobs/PrintJobTypes';
import {
  COLOR_MATCH_THRESHOLD,
  colorDistance,
  materialsMatch,
  U1_TOOLHEAD_COUNT,
  type LoadedSlot,
  type ProjectFilament,
} from './FilamentSlots';

// Binding each project colour to a physical toolhead.
//
// `CLAUDE.md`: **never silently guess filament mappings.** So this module
// proposes and it judges, but it never confirms. A suggested mapping carries
// `confirmedAt: null`, `isFilamentMappingComplete` stays false, and the start
// gate stays shut until the operator has actually looked at it and said yes.
//
// The data model is Stage B's (`FilamentSlotMapping`, `FilamentMapping`,
// `filamentMapHash`), deliberately: a start approval binds to that hash, so the
// mapping this screen produces has to be the same object the approval validates
// rather than a parallel shape that has to be converted.

export type MatchQuality =
  /** Same material, same colour. */
  | 'exact'
  /** Same material, visibly different colour. */
  | 'colour-mismatch'
  /** Different material. Temperatures and behaviour differ. */
  | 'material-mismatch'
  /** Mapped to a toolhead with nothing in it. */
  | 'empty'
  /** The printer has not said what is loaded. */
  | 'unknown'
  /** No toolhead chosen yet. */
  | 'unmapped';

export interface SlotAssessment {
  sourceIndex: number;
  toolhead: number | null;
  quality: MatchQuality;
  /** The loaded slot this maps to, when there is one. */
  loaded: LoadedSlot | null;
  /** True when this head's spool is RFID-identified and cannot be relabelled. */
  rfidLocked: boolean;
  message: string;
}

export interface SwapStep {
  toolhead: number;
  wantMaterial: string;
  wantColor: string;
  haveMaterial: string;
  haveColor: string;
}

export interface MappingPlan {
  mapping: FilamentMapping;
  /** Stable identity of the mapping; a start approval binds to this. */
  mapHash: string;
  assessments: SlotAssessment[];
  warnings: PrintJobWarning[];
  /**
   * What the operator would have to physically change for a clean print.
   * Empty when every mapped head already holds the right filament.
   */
  swapPlan: SwapStep[];
  /** False when a blocking warning is present. */
  ok: boolean;
}

function warning(
  code: string,
  level: PrintJobWarningLevel,
  message: string
): PrintJobWarning {
  return { code, level, message };
}

function describeFilament(material: string, color: string): string {
  const parts = [material.trim(), color.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'an unknown filament';
}

/**
 * Ranks how well a loaded slot serves a project filament. Lower is better;
 * `null` means it cannot serve it at all.
 */
function score(source: ProjectFilament, slot: LoadedSlot): number | null {
  if (slot.status === 'empty') return null;
  if (slot.status === 'unknown' && !slot.material && !slot.color) return null;

  const sameMaterial = materialsMatch(source.material, slot.material);
  const distance = colorDistance(source.color, slot.color);

  // Material dominates: printing PETG where PLA was designed changes
  // temperatures, not just appearance.
  const materialPenalty = sameMaterial ? 0 : 1_000_000;
  const colourPenalty = distance ?? 500_000;
  return materialPenalty + colourPenalty;
}

export interface PlanOptions {
  /**
   * Operator choices, by source index. A value present here always wins over
   * the suggestion — the operator's decision is not second-guessed.
   */
  choices?: Readonly<Record<number, number | null>>;
  /** Set when the operator has confirmed; otherwise the mapping is a proposal. */
  confirmedAt?: number | null;
}

/**
 * Proposes a mapping and says what is wrong with it.
 *
 * Suggestion is greedy over the best available match, and only ever suggests a
 * head whose contents are actually known: an unknown head is left unmapped for
 * the operator to decide, rather than filled in optimistically.
 */
export function planFilamentMapping(
  sources: readonly ProjectFilament[],
  loaded: readonly LoadedSlot[],
  options: PlanOptions = {}
): MappingPlan {
  const choices = options.choices ?? {};
  const byToolhead = new Map<number, LoadedSlot>();
  for (const slot of loaded) byToolhead.set(slot.toolhead, slot);

  const taken = new Set<number>();
  for (const value of Object.values(choices)) {
    if (typeof value === 'number') taken.add(value);
  }

  const slots: FilamentSlotMapping[] = [];
  const assessments: SlotAssessment[] = [];
  const warnings: PrintJobWarning[] = [];
  const swapPlan: SwapStep[] = [];

  for (const source of sources) {
    const chosen = Object.prototype.hasOwnProperty.call(choices, source.sourceIndex)
      ? choices[source.sourceIndex]
      : suggestToolhead(source, loaded, taken);

    if (typeof chosen === 'number') taken.add(chosen);

    const slot = typeof chosen === 'number' ? byToolhead.get(chosen) ?? null : null;
    const quality = assess(source, chosen, slot);

    slots.push({
      sourceIndex: source.sourceIndex,
      toolhead: typeof chosen === 'number' ? chosen : null,
      sourceMaterial: source.material,
      sourceColor: source.color,
      loadedMaterial: slot?.material ?? '',
      loadedColor: slot?.color ?? '',
    });

    assessments.push({
      sourceIndex: source.sourceIndex,
      toolhead: typeof chosen === 'number' ? chosen : null,
      quality,
      loaded: slot,
      rfidLocked: slot?.rfidLocked ?? false,
      message: describeQuality(source, chosen, slot, quality),
    });

    if (slot && (quality === 'material-mismatch' || quality === 'colour-mismatch')) {
      swapPlan.push({
        toolhead: slot.toolhead,
        wantMaterial: source.material,
        wantColor: source.color,
        haveMaterial: slot.material,
        haveColor: slot.color,
      });
    }
  }

  collectWarnings(sources, slots, assessments, warnings);

  const mapping: FilamentMapping = {
    slots,
    confirmedAt: options.confirmedAt ?? null,
  };

  return {
    mapping,
    mapHash: filamentMapHash(mapping),
    assessments,
    warnings,
    swapPlan,
    ok: !warnings.some((item) => item.level === 'blocking'),
  };
}

function suggestToolhead(
  source: ProjectFilament,
  loaded: readonly LoadedSlot[],
  taken: ReadonlySet<number>
): number | null {
  let best: { toolhead: number; score: number } | null = null;
  for (const slot of loaded) {
    if (taken.has(slot.toolhead)) continue;
    const value = score(source, slot);
    if (value === null) continue;
    if (!best || value < best.score) best = { toolhead: slot.toolhead, score: value };
  }
  return best ? best.toolhead : null;
}

function assess(
  source: ProjectFilament,
  chosen: number | null | undefined,
  slot: LoadedSlot | null
): MatchQuality {
  if (typeof chosen !== 'number') return 'unmapped';
  if (!slot) return 'unknown';
  if (slot.status === 'empty') return 'empty';
  if (!slot.material && !slot.color) return 'unknown';
  if (!materialsMatch(source.material, slot.material)) return 'material-mismatch';

  const distance = colorDistance(source.color, slot.color);
  if (distance === null) return 'unknown';
  return distance <= COLOR_MATCH_THRESHOLD ? 'exact' : 'colour-mismatch';
}

function describeQuality(
  source: ProjectFilament,
  chosen: number | null | undefined,
  slot: LoadedSlot | null,
  quality: MatchQuality
): string {
  const want = describeFilament(source.material, source.color);
  const head = typeof chosen === 'number' ? `T${chosen}` : null;

  switch (quality) {
    case 'exact':
      return `${head} holds the ${want} this colour was designed in.`;
    case 'colour-mismatch':
      return `${head} holds ${describeFilament(slot?.material ?? '', slot?.color ?? '')}, but this colour was designed as ${want}.`;
    case 'material-mismatch':
      return `${head} holds ${slot?.material || 'a different material'}, but this colour was designed for ${source.material || 'another material'}.`;
    case 'empty':
      return `${head} is empty. Load filament or choose another toolhead.`;
    case 'unknown':
      return head
        ? `The printer has not said what is in ${head}.`
        : 'The printer has not said what is loaded.';
    case 'unmapped':
    default:
      return `No toolhead chosen for ${want}.`;
  }
}

function collectWarnings(
  sources: readonly ProjectFilament[],
  slots: readonly FilamentSlotMapping[],
  assessments: readonly SlotAssessment[],
  warnings: PrintJobWarning[]
): void {
  if (sources.length === 0) {
    warnings.push(
      warning(
        'filament/no-colours',
        'blocking',
        'This project declares no filaments, so there is nothing to map.'
      )
    );
    return;
  }

  if (sources.length > U1_TOOLHEAD_COUNT) {
    warnings.push(
      warning(
        'filament/too-many-colours',
        'warning',
        `This project uses ${sources.length} filaments and the U1 has ${U1_TOOLHEAD_COUNT} toolheads, so some colours must share one.`
      )
    );
  }

  const unmapped = assessments.filter((item) => item.quality === 'unmapped');
  if (unmapped.length > 0) {
    warnings.push(
      warning(
        'filament/unmapped',
        'blocking',
        `${unmapped.length} project ${unmapped.length === 1 ? 'colour has' : 'colours have'} no toolhead. Choose one for each before printing.`
      )
    );
  }

  const empty = assessments.filter((item) => item.quality === 'empty');
  for (const item of empty) {
    warnings.push(
      warning('filament/empty-head', 'blocking', `T${item.toolhead} is empty but a colour is mapped to it.`)
    );
  }

  const unknown = assessments.filter((item) => item.quality === 'unknown');
  if (unknown.length > 0) {
    // Unknown is not "probably fine". The rules require failing closed when
    // printer state is unknown, and what is in a toolhead is printer state.
    warnings.push(
      warning(
        'filament/unknown-head',
        'blocking',
        'The printer has not reported what is loaded in every mapped toolhead.'
      )
    );
  }

  for (const item of assessments.filter((entry) => entry.quality === 'material-mismatch')) {
    warnings.push(
      warning(
        'filament/material-mismatch',
        'warning',
        `T${item.toolhead} holds ${item.loaded?.material || 'a different material'} where the project expects ${slots.find((slot) => slot.sourceIndex === item.sourceIndex)?.sourceMaterial || 'another material'}.`
      )
    );
  }

  const colourOff = assessments.filter((item) => item.quality === 'colour-mismatch');
  if (colourOff.length > 0) {
    warnings.push(
      warning(
        'filament/colour-mismatch',
        'info',
        `${colourOff.length} ${colourOff.length === 1 ? 'colour differs' : 'colours differ'} from the design. The print will work, but will not look the same.`
      )
    );
  }

  const used = new Map<number, number>();
  for (const slot of slots) {
    if (slot.toolhead === null) continue;
    used.set(slot.toolhead, (used.get(slot.toolhead) ?? 0) + 1);
  }
  const shared = [...used.entries()].filter(([, count]) => count > 1);
  for (const [toolhead, count] of shared) {
    warnings.push(
      warning(
        'filament/duplicate-mapping',
        'warning',
        `${count} project colours are mapped to T${toolhead}, so they will print in the same filament.`
      )
    );
  }

  const locked = assessments.filter((item) => item.rfidLocked && item.quality !== 'exact');
  for (const item of locked) {
    warnings.push(
      warning(
        'filament/rfid-locked',
        'info',
        `T${item.toolhead} holds an RFID-identified spool, so it cannot be relabelled — swap the spool to change it.`
      )
    );
  }
}

/** One line per physical change the operator would make. */
export function describeSwapPlan(plan: readonly SwapStep[]): string[] {
  return plan.map(
    (step) =>
      `T${step.toolhead}: load ${describeFilament(step.wantMaterial, step.wantColor)} (currently ${describeFilament(step.haveMaterial, step.haveColor)}).`
  );
}
