import { sha256Hex } from '../security/Sha256';
import { utf8ToBytes } from '../security/Base64';

// Data model for the print pipeline, following `docs/PROJECT_MASTER_PLAN.md`.
//
// A job is a plain serialisable object. All behaviour lives in
// `PrintJobMachine.ts`; keeping the shape inert means persistence, recovery and
// tests all see the same thing the screens do.

/** Job states, exactly as listed in `docs/PROJECT_MASTER_PLAN.md`. */
export type PrintJobState =
  | 'created'
  | 'downloading'
  | 'downloaded'
  | 'inspecting'
  | 'rejected'
  | 'conversion_required'
  | 'preparing'
  | 'prepared'
  | 'slicing'
  | 'slice_failed'
  | 'review_required'
  | 'approved_for_upload'
  | 'uploading'
  | 'uploaded'
  | 'awaiting_start_approval'
  | 'start_approved'
  | 'starting'
  | 'printing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export const PRINT_JOB_STATES: readonly PrintJobState[] = [
  'created',
  'downloading',
  'downloaded',
  'inspecting',
  'rejected',
  'conversion_required',
  'preparing',
  'prepared',
  'slicing',
  'slice_failed',
  'review_required',
  'approved_for_upload',
  'uploading',
  'uploaded',
  'awaiting_start_approval',
  'start_approved',
  'starting',
  'printing',
  'paused',
  'completed',
  'cancelled',
  'failed',
];

/** No further transitions are possible. */
export const TERMINAL_STATES: readonly PrintJobState[] = [
  'rejected',
  'completed',
  'cancelled',
  'failed',
];

/**
 * States where the printer may already be moving, or the job is over.
 *
 * Nothing in these states may be edited: rewinding a job the printer is acting
 * on would leave the record describing something other than what is running.
 */
export const LOCKED_STATES: readonly PrintJobState[] = [
  'starting',
  'printing',
  'paused',
  ...TERMINAL_STATES,
];

export type PrintArtifactType = 'source' | 'prepared' | 'gcode' | 'thumbnail';

export interface PrintArtifact {
  id: string;
  jobId: string;
  type: PrintArtifactType;
  path: string;
  sha256: string;
  sizeBytes: number;
  createdAt: number;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * One project colour bound to one physical toolhead.
 *
 * `docs/SAFETY_AND_TESTING.md` forbids guessing: an unmapped slot stays
 * unmapped and blocks the gate rather than defaulting to T0.
 */
export interface FilamentSlotMapping {
  /** Source (project) filament index, as it appears in the 3MF. */
  sourceIndex: number;
  /** Physical U1 toolhead, 0-3. `null` means the operator has not chosen. */
  toolhead: number | null;
  sourceMaterial: string;
  sourceColor: string;
  loadedMaterial: string;
  loadedColor: string;
}

export interface FilamentMapping {
  slots: FilamentSlotMapping[];
  /** Set when the operator has confirmed the mapping, not merely viewed it. */
  confirmedAt: number | null;
}

export interface ProfileSelection {
  /** MakerWorld profile / project profile the model came with. */
  sourceProfileId: string;
  /** Resolved U1 process profile actually used for slicing. */
  u1ProfileId: string;
  nozzleDiameter: number;
  plateId: number;
}

export type PrintJobWarningLevel = 'info' | 'warning' | 'blocking';

export interface PrintJobWarning {
  code: string;
  level: PrintJobWarningLevel;
  message: string;
}

export interface StartApproval {
  jobId: string;
  jobRevision: number;
  printerId: string;
  filename: string;
  gcodeSha256: string;
  filamentMapHash: string;
  approvedAt: number;
  expiresAt: number;
}

export type PrintJobEventType =
  | 'transition'
  | 'revision'
  | 'artifact'
  | 'approval-granted'
  | 'approval-cleared'
  | 'error';

export interface PrintJobEvent {
  type: PrintJobEventType;
  at: number;
  /** Free-form but never secret: no cookies, tokens, signed URLs or full paths. */
  detail: string;
  fromState?: PrintJobState;
  toState?: PrintJobState;
  revision?: number;
}

export interface PrintJob {
  id: string;
  modelId: string;
  state: PrintJobState;
  /** Increments on every change that could alter the bytes sent to the printer. */
  revision: number;
  printerId: string;
  sourceArtifactId: string | null;
  preparedArtifactId: string | null;
  gcodeArtifactId: string | null;
  /** SHA-256 of the sliced G-code, copied out of the artifact for gate checks. */
  gcodeSha256: string | null;
  /** Filename as it exists on the printer after upload. */
  uploadedFilename: string | null;
  profileSelection: ProfileSelection | null;
  filamentMapping: FilamentMapping | null;
  warnings: PrintJobWarning[];
  startApproval: StartApproval | null;
  createdAt: number;
  updatedAt: number;
  events: PrintJobEvent[];
}

/** Kept bounded so a long-lived job cannot grow the stored record without limit. */
export const MAX_JOB_EVENTS = 200;

export function isTerminalState(state: PrintJobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isLockedState(state: PrintJobState): boolean {
  return LOCKED_STATES.includes(state);
}

export function isPrintJobState(value: unknown): value is PrintJobState {
  return typeof value === 'string' && (PRINT_JOB_STATES as readonly string[]).includes(value);
}

export function hasBlockingWarning(job: PrintJob): boolean {
  return job.warnings.some((warning) => warning.level === 'blocking');
}

/** True once every source colour has been given a real toolhead. */
export function isFilamentMappingComplete(mapping: FilamentMapping | null): boolean {
  if (!mapping || mapping.confirmedAt === null) return false;
  if (mapping.slots.length === 0) return false;
  return mapping.slots.every(
    (slot) => Number.isInteger(slot.toolhead) && slot.toolhead !== null && slot.toolhead >= 0
  );
}

/**
 * Stable hash of a filament mapping.
 *
 * A start approval binds to this value, so it must depend on everything that
 * changes what comes out of the nozzle and on nothing else. Slot order is
 * normalised because reordering the same assignments is not a real change,
 * while `confirmedAt` is excluded because re-confirming an identical mapping
 * should not invalidate an approval.
 */
export function filamentMapHash(mapping: FilamentMapping | null): string {
  const slots = mapping ? [...mapping.slots] : [];
  slots.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const canonical = slots
    .map((slot) =>
      [
        slot.sourceIndex,
        slot.toolhead === null ? 'unmapped' : slot.toolhead,
        slot.sourceMaterial.trim().toUpperCase(),
        slot.sourceColor.trim().toUpperCase(),
        slot.loadedMaterial.trim().toUpperCase(),
        slot.loadedColor.trim().toUpperCase(),
      ].join('|')
    )
    .join('\n');
  return sha256Hex(utf8ToBytes(`filament-map/v1\n${canonical}`));
}

export interface CreatePrintJobInput {
  id: string;
  modelId: string;
  printerId: string;
  createdAt: number;
}

export function createPrintJob(input: CreatePrintJobInput): PrintJob {
  return {
    id: input.id,
    modelId: input.modelId,
    state: 'created',
    revision: 1,
    printerId: input.printerId,
    sourceArtifactId: null,
    preparedArtifactId: null,
    gcodeArtifactId: null,
    gcodeSha256: null,
    uploadedFilename: null,
    profileSelection: null,
    filamentMapping: null,
    warnings: [],
    startApproval: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    events: [
      {
        type: 'transition',
        at: input.createdAt,
        detail: 'job created',
        toState: 'created',
        revision: 1,
      },
    ],
  };
}
