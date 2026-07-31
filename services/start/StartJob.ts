// Building the job record a start approval binds to.
//
// A `PrintJob` is what makes an approval checkable: the revision, the G-code
// hash, the printer and the filament mapping all live on it, and
// `validateStartApproval` re-derives every one of them from it. So before
// anything can be approved, one has to exist.
//
// The job is created at `review_required` — the first point in the pipeline that
// has produced something a start could bind to. Earlier states are real and the
// machine models them, but a job created at `created` would have to be given a
// source and a prepared artifact, and on the reprint paths neither exists: the
// file came off the printer, not out of an import. Inventing hashes for them to
// satisfy the guards would be exactly the kind of confident wrong answer the
// safety rules are written against. Every guard from `review_required` onwards
// runs for real.

import {
  createPrintJob,
  isFilamentMappingComplete,
  type FilamentMapping,
  type FilamentSlotMapping,
  type PrintJob,
  type PrintJobWarning,
  type ProfileSelection,
} from '../jobs/PrintJobTypes';
import { PrintJobError } from '../jobs/JobErrors';
import { recordUpload, transition } from '../jobs/PrintJobMachine';
import { isSha256Hex } from '../security/Sha256';
import type { LoadedSlot } from '../filament/FilamentSlots';

export interface StartJobInput {
  id: string;
  /** Stable identity for the thing being printed; used for the audit trail. */
  modelId: string;
  printerId: string;
  /** Local path of the reviewed G-code, recorded as the artifact identity. */
  gcodeArtifactId: string;
  /** SHA-256 of the exact bytes that were uploaded. */
  gcodeSha256: string;
  uploadedFilename: string;
  filamentMapping: FilamentMapping;
  profileSelection?: ProfileSelection | null;
  warnings?: PrintJobWarning[];
  at: number;
}

/**
 * Produces a job sitting at `awaiting_start_approval`.
 *
 * Walks the real transitions from `review_required` rather than assigning
 * states, so a job that arrives at the approval screen has satisfied every
 * precondition the machine enforces — a valid hash, a target printer, a
 * recorded filename, and no blocking warnings.
 */
export function buildStartJob(input: StartJobInput): PrintJob {
  if (!isSha256Hex(input.gcodeSha256)) {
    throw new PrintJobError('job/missing-artifact', 'A job needs the reviewed G-code hash.');
  }
  if (!input.printerId.trim()) {
    throw new PrintJobError('job/missing-printer', 'A job needs a target printer.');
  }
  if (!input.uploadedFilename.trim()) {
    throw new PrintJobError('job/missing-upload', 'A job needs the uploaded filename.');
  }
  if (!isFilamentMappingComplete(input.filamentMapping)) {
    throw new PrintJobError(
      'job/missing-filament-map',
      'A job needs a confirmed toolhead for every source colour.'
    );
  }

  const base = createPrintJob({
    id: input.id,
    modelId: input.modelId,
    printerId: input.printerId,
    createdAt: input.at,
  });

  const reviewed: PrintJob = {
    ...base,
    state: 'review_required',
    gcodeArtifactId: input.gcodeArtifactId,
    gcodeSha256: input.gcodeSha256,
    filamentMapping: input.filamentMapping,
    profileSelection: input.profileSelection ?? null,
    warnings: [...(input.warnings ?? [])],
    updatedAt: input.at,
    events: [
      ...base.events,
      {
        type: 'artifact',
        at: input.at,
        detail: 'entered the pipeline with reviewed G-code',
        toState: 'review_required',
        revision: base.revision,
      },
    ],
  };

  let job = transition(reviewed, 'approved_for_upload', input.at, {
    reason: 'review passed',
  });
  job = transition(job, 'uploading', input.at, { reason: 'sending to printer' });
  job = recordUpload(job, input.uploadedFilename, input.at);
  job = transition(job, 'uploaded', input.at, { reason: 'upload verified' });
  return transition(job, 'awaiting_start_approval', input.at, {
    reason: 'waiting for the operator',
  });
}

export interface MappingSource {
  /** Source (project or file) filament index. */
  sourceIndex: number;
  material: string;
  color: string;
}

/**
 * Joins what the project asks for to what is physically loaded.
 *
 * `targets` is the operator's choice of toolhead per source index. A source with
 * no target stays `null`, which leaves the mapping incomplete and blocks the
 * gate — the safety rules forbid defaulting an unmapped colour to T0.
 *
 * The loaded material and colour are copied in as read *now*, because that is
 * what an approval binds to and what `recheckFilament` compares against at start
 * time. A head the printer has not described contributes empty strings, which
 * are not re-checked; `evaluateStartGate` refuses it separately for not being
 * loaded, rather than this pretending to have matched something.
 */
export function buildFilamentMapping(
  sources: readonly MappingSource[],
  targets: Readonly<Record<number, number | null>>,
  loaded: readonly LoadedSlot[],
  confirmedAt: number | null
): FilamentMapping {
  const slots: FilamentSlotMapping[] = sources.map((source) => {
    const toolhead = targets[source.sourceIndex] ?? null;
    const head = toolhead === null ? null : loaded.find((slot) => slot.toolhead === toolhead);
    return {
      sourceIndex: source.sourceIndex,
      toolhead,
      sourceMaterial: source.material,
      sourceColor: source.color,
      loadedMaterial: head?.status === 'loaded' ? head.material : '',
      loadedColor: head?.status === 'loaded' ? head.color : '',
    };
  });
  return { slots, confirmedAt };
}

/**
 * The colours a printer-held file will print in, as the file itself describes.
 *
 * The toolheads come from the toolpaths — `toolsUsed` counts only heads that
 * actually extrude — while the material and colour come from the header, which
 * lists every filament the project was sliced with. Pairing them by index is
 * what makes a reprint's mapping describe the file rather than the project it
 * came from.
 */
export function reprintMappingSources(review: {
  extents: { toolsUsed: number[] } | null;
  metadata: { filamentTypes: string[]; filamentColors: string[] };
}): MappingSource[] {
  const tools = review.extents?.toolsUsed ?? [];
  return tools.map((tool) => ({
    sourceIndex: tool,
    material: review.metadata.filamentTypes[tool] ?? '',
    color: review.metadata.filamentColors[tool] ?? '',
  }));
}

/**
 * A job id that sorts by creation and cannot collide within a session.
 *
 * Not a UUID: nothing outside this device consumes it, and a readable timestamp
 * makes a stored job's audit trail legible without a lookup.
 */
let sequence = 0;
export function newJobId(at: number = Date.now()): string {
  sequence = (sequence + 1) % 0xffff;
  return `job-${at.toString(36)}-${sequence.toString(36).padStart(3, '0')}`;
}
