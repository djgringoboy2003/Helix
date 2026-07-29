import {
  validateCameraFreshness,
  validateStartApproval,
  type CameraFrameRecord,
} from './ApprovalService';
import {
  gateFailure,
  GATE_OK,
  PrintJobError,
  toPrintJobError,
  type GateResult,
} from './JobErrors';
import {
  hasBlockingWarning,
  isFilamentMappingComplete,
  isLockedState,
  isTerminalState,
  MAX_JOB_EVENTS,
  type FilamentMapping,
  type PrintArtifact,
  type PrintJob,
  type PrintJobEvent,
  type PrintJobState,
  type PrintJobWarning,
  type ProfileSelection,
  type StartApproval,
} from './PrintJobTypes';
import { isSha256Hex } from '../security/Sha256';

// The print-job state machine.
//
// Screens request transitions; they never assign `job.state` themselves
// (`docs/PROJECT_MASTER_PLAN.md`). Every function here is pure: it takes a job
// and returns a new job, so persistence and recovery stay the caller's problem
// and every rule is directly testable.
//
// Two rules drive the whole design:
//
//  1. Upload and start are separate operator-gated steps. There is no edge from
//     `uploaded` to `starting`; reaching motion requires passing through
//     `awaiting_start_approval` and `start_approved`.
//  2. Anything that could change the bytes reaching the printer bumps the
//     revision, drops the approval, and rewinds the job to the earliest step
//     that has to be redone.

const ALLOWED_TRANSITIONS: Record<PrintJobState, readonly PrintJobState[]> = {
  created: ['downloading', 'inspecting', 'cancelled', 'failed'],
  downloading: ['downloaded', 'cancelled', 'failed'],
  downloaded: ['inspecting', 'cancelled', 'failed'],
  inspecting: ['rejected', 'conversion_required', 'preparing', 'prepared', 'cancelled', 'failed'],
  rejected: [],
  conversion_required: ['preparing', 'cancelled', 'failed'],
  preparing: ['prepared', 'cancelled', 'failed'],
  prepared: ['slicing', 'preparing', 'cancelled', 'failed'],
  slicing: ['review_required', 'slice_failed', 'cancelled'],
  slice_failed: ['slicing', 'preparing', 'cancelled', 'failed'],
  review_required: ['approved_for_upload', 'preparing', 'slicing', 'cancelled', 'failed'],
  approved_for_upload: ['uploading', 'review_required', 'cancelled', 'failed'],
  uploading: ['uploaded', 'approved_for_upload', 'cancelled', 'failed'],
  uploaded: ['awaiting_start_approval', 'review_required', 'cancelled', 'failed'],
  awaiting_start_approval: ['start_approved', 'uploaded', 'cancelled', 'failed'],
  start_approved: ['starting', 'awaiting_start_approval', 'cancelled', 'failed'],
  starting: ['printing', 'cancelled', 'failed'],
  printing: ['paused', 'completed', 'cancelled', 'failed'],
  paused: ['printing', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

/**
 * Happy-path ordering, used only to decide how far back a change rewinds a job.
 * Off-path states share the rank of the step they belong to.
 */
const STATE_RANK: Record<PrintJobState, number> = {
  created: 0,
  downloading: 1,
  downloaded: 2,
  inspecting: 3,
  rejected: 3,
  conversion_required: 4,
  preparing: 5,
  prepared: 6,
  slicing: 7,
  slice_failed: 7,
  review_required: 8,
  approved_for_upload: 9,
  uploading: 10,
  uploaded: 11,
  awaiting_start_approval: 12,
  start_approved: 13,
  starting: 14,
  printing: 15,
  paused: 16,
  completed: 17,
  cancelled: 17,
  failed: 17,
};

export type RevisionChangeKind =
  | 'source-artifact'
  | 'prepared-artifact'
  | 'gcode-artifact'
  | 'profile'
  | 'filament-mapping'
  | 'printer';

/** Where a job falls back to when each kind of change invalidates later work. */
const REWIND_TARGET: Record<RevisionChangeKind, PrintJobState> = {
  'source-artifact': 'downloaded',
  'prepared-artifact': 'prepared',
  'gcode-artifact': 'review_required',
  profile: 'prepared',
  'filament-mapping': 'prepared',
  printer: 'review_required',
};

/**
 * Downstream identities each change makes meaningless.
 *
 * Listed per change rather than derived from the rewind rank, because the
 * artifact being attached is itself downstream of the state the job sits in.
 */
const INVALIDATES: Record<RevisionChangeKind, readonly ('prepared' | 'gcode' | 'upload')[]> = {
  'source-artifact': ['prepared', 'gcode', 'upload'],
  'prepared-artifact': ['gcode', 'upload'],
  'gcode-artifact': ['upload'],
  profile: ['gcode', 'upload'],
  'filament-mapping': ['gcode', 'upload'],
  printer: ['upload'],
};

export function allowedTransitions(state: PrintJobState): readonly PrintJobState[] {
  return ALLOWED_TRANSITIONS[state] ?? [];
}

/**
 * Preconditions that go beyond "is this edge on the map".
 *
 * Kept separate from the table because these are the checks that stop a job
 * moving forward on incomplete data, and each one needs its own error code.
 */
function transitionGuard(job: PrintJob, to: PrintJobState): GateResult {
  switch (to) {
    case 'slicing':
      if (!job.preparedArtifactId) {
        return gateFailure('job/missing-artifact', 'Slice needs a prepared project file.');
      }
      if (!job.profileSelection) {
        return gateFailure('job/missing-artifact', 'Slice needs a selected U1 profile.');
      }
      if (!isFilamentMappingComplete(job.filamentMapping)) {
        return gateFailure(
          'job/missing-filament-map',
          'Confirm a toolhead for every source colour before slicing.'
        );
      }
      return GATE_OK;

    case 'approved_for_upload':
      if (!job.gcodeArtifactId || !isSha256Hex(job.gcodeSha256 ?? '')) {
        return gateFailure('job/missing-artifact', 'Upload needs sliced G-code with a recorded hash.');
      }
      if (hasBlockingWarning(job)) {
        return gateFailure('job/invalid-transition', 'Resolve blocking warnings before uploading.');
      }
      return GATE_OK;

    case 'uploading':
      if (!job.printerId.trim()) {
        return gateFailure('job/missing-printer', 'Upload needs a target printer.');
      }
      if (!isSha256Hex(job.gcodeSha256 ?? '')) {
        return gateFailure('job/missing-artifact', 'Upload needs sliced G-code with a recorded hash.');
      }
      return GATE_OK;

    case 'uploaded':
      if (!job.uploadedFilename) {
        return gateFailure('job/missing-upload', 'Record the uploaded filename before completing upload.');
      }
      return GATE_OK;

    case 'awaiting_start_approval':
      if (!job.uploadedFilename || !isSha256Hex(job.gcodeSha256 ?? '')) {
        return gateFailure(
          'job/missing-upload',
          'Approval needs an uploaded file and its recorded hash.'
        );
      }
      return GATE_OK;

    case 'start_approved':
      // Approvals are attached by `grantStartApproval`, which transitions here
      // itself. Arriving without one means something bypassed that path.
      if (!job.startApproval) {
        return gateFailure('approval/not-granted', 'No approval record is attached to this job.');
      }
      return GATE_OK;

    case 'starting':
      if (!job.startApproval) {
        return gateFailure('approval/missing', 'Refusing to start without an approval record.');
      }
      return GATE_OK;

    default:
      return GATE_OK;
  }
}

export function canTransition(job: PrintJob, to: PrintJobState): GateResult {
  if (job.state === to) {
    return gateFailure('job/invalid-transition', `Job is already ${to}.`, { state: to });
  }
  if (isTerminalState(job.state)) {
    return gateFailure('job/terminal-state', `Job is ${job.state} and cannot change.`, {
      state: job.state,
    });
  }
  if (!allowedTransitions(job.state).includes(to)) {
    return gateFailure('job/invalid-transition', `Cannot move from ${job.state} to ${to}.`, {
      from: job.state,
      to,
    });
  }
  return transitionGuard(job, to);
}

export interface TransitionOptions {
  /** Recorded on the event; must not contain secrets or full paths. */
  reason?: string;
}

export function transition(
  job: PrintJob,
  to: PrintJobState,
  at: number,
  options: TransitionOptions = {}
): PrintJob {
  const check = canTransition(job, to);
  const error = toPrintJobError(check);
  if (error) throw error;

  const next = withEvent(
    { ...job, state: to, updatedAt: at },
    {
      type: 'transition',
      at,
      detail: options.reason ?? `${job.state} → ${to}`,
      fromState: job.state,
      toState: to,
      revision: job.revision,
    }
  );

  // Leaving the approved window in any direction other than starting means the
  // approval no longer describes what happens next.
  if (job.state === 'start_approved' && to !== 'starting') {
    return clearApprovalFields(next, at, `approval dropped on move to ${to}`);
  }
  return next;
}

/**
 * Applies a change that could alter the printed result.
 *
 * Bumps the revision, discards any approval, and rewinds the job to the first
 * step that must be redone. Refused outright once the printer may be acting on
 * the job — see {@link isLockedState}.
 */
export function applyRevisionChange(
  job: PrintJob,
  kind: RevisionChangeKind,
  at: number,
  mutate: (job: PrintJob) => PrintJob
): PrintJob {
  if (isLockedState(job.state)) {
    throw new PrintJobError(
      'job/revision-locked',
      `Cannot change a job that is ${job.state}. Cancel it first.`,
      { state: job.state, change: kind }
    );
  }

  const target = REWIND_TARGET[kind];
  const rewound = STATE_RANK[job.state] > STATE_RANK[target] ? target : job.state;
  const revision = job.revision + 1;

  // Drop stale identities first, then let the change itself write its values,
  // so attaching an artifact is never undone by its own invalidation rule.
  let next: PrintJob = { ...job, startApproval: null };
  const invalidated = INVALIDATES[kind];
  if (invalidated.includes('prepared')) next = { ...next, preparedArtifactId: null };
  if (invalidated.includes('gcode')) next = { ...next, gcodeArtifactId: null, gcodeSha256: null };
  if (invalidated.includes('upload')) next = { ...next, uploadedFilename: null };

  next = { ...mutate(next), revision, state: rewound, updatedAt: at };

  next = withEvent(next, {
    type: 'revision',
    at,
    detail: `${kind} changed; revision ${job.revision} → ${revision}`,
    fromState: job.state,
    toState: rewound,
    revision,
  });

  if (job.startApproval) {
    next = withEvent(next, {
      type: 'approval-cleared',
      at,
      detail: `approval invalidated by ${kind} change`,
      revision,
    });
  }
  return next;
}

export function attachArtifact(job: PrintJob, artifact: PrintArtifact, at: number): PrintJob {
  if (artifact.jobId !== job.id) {
    throw new PrintJobError('job/missing-artifact', 'Artifact belongs to a different job.', {
      artifactJobId: artifact.jobId,
      jobId: job.id,
    });
  }
  if (!isSha256Hex(artifact.sha256)) {
    throw new PrintJobError('job/missing-artifact', 'Artifact needs a valid SHA-256.', {
      artifactId: artifact.id,
      type: artifact.type,
    });
  }

  // A thumbnail cannot change what is printed, so it does not spend a revision.
  if (artifact.type === 'thumbnail') {
    return withEvent({ ...job, updatedAt: at }, {
      type: 'artifact',
      at,
      detail: 'thumbnail attached',
      revision: job.revision,
    });
  }

  const kind: RevisionChangeKind =
    artifact.type === 'source'
      ? 'source-artifact'
      : artifact.type === 'prepared'
        ? 'prepared-artifact'
        : 'gcode-artifact';

  return applyRevisionChange(job, kind, at, (current) => {
    switch (artifact.type) {
      case 'source':
        return { ...current, sourceArtifactId: artifact.id };
      case 'prepared':
        return { ...current, preparedArtifactId: artifact.id };
      default:
        return { ...current, gcodeArtifactId: artifact.id, gcodeSha256: artifact.sha256 };
    }
  });
}

export function setFilamentMapping(job: PrintJob, mapping: FilamentMapping, at: number): PrintJob {
  return applyRevisionChange(job, 'filament-mapping', at, (current) => ({
    ...current,
    filamentMapping: mapping,
  }));
}

export function setProfileSelection(job: PrintJob, profile: ProfileSelection, at: number): PrintJob {
  return applyRevisionChange(job, 'profile', at, (current) => ({
    ...current,
    profileSelection: profile,
  }));
}

export function setPrinter(job: PrintJob, printerId: string, at: number): PrintJob {
  if (!printerId.trim()) {
    throw new PrintJobError('job/missing-printer', 'A job needs a printer identifier.');
  }
  if (printerId === job.printerId) return job;
  return applyRevisionChange(job, 'printer', at, (current) => ({ ...current, printerId }));
}

/**
 * Records the filename the printer now holds.
 *
 * Not a revision change: uploading does not alter the artifact. Overwriting an
 * existing printer file is a separate operator decision handled at upload time.
 */
export function recordUpload(job: PrintJob, filename: string, at: number): PrintJob {
  if (!filename.trim()) {
    throw new PrintJobError('job/missing-upload', 'Uploaded filename cannot be empty.');
  }
  return withEvent(
    { ...job, uploadedFilename: filename, updatedAt: at },
    { type: 'artifact', at, detail: `uploaded as ${filename}`, revision: job.revision }
  );
}

/** Warnings describe the job; they never change the printed bytes. */
export function setWarnings(job: PrintJob, warnings: PrintJobWarning[], at: number): PrintJob {
  return { ...job, warnings: [...warnings], updatedAt: at };
}

/**
 * Attaches an approval and moves to `start_approved` in one step, so a stored
 * approval and the state that depends on it can never disagree.
 */
export function grantStartApproval(job: PrintJob, approval: StartApproval, at: number): PrintJob {
  if (job.state !== 'awaiting_start_approval') {
    throw new PrintJobError(
      'job/invalid-transition',
      `Approval can only be given while awaiting approval, not while ${job.state}.`,
      { state: job.state }
    );
  }
  const check = validateStartApproval(job, approval, {
    activePrinterId: job.printerId,
    uploadedFilename: null,
    now: at,
  });
  const error = toPrintJobError(check);
  if (error) throw error;

  const approved = withEvent(
    { ...job, startApproval: approval, updatedAt: at },
    {
      type: 'approval-granted',
      at,
      detail: `approved revision ${approval.jobRevision} for ${approval.filename}`,
      revision: job.revision,
    }
  );
  return transition(approved, 'start_approved', at, { reason: 'operator approved start' });
}

export function clearStartApproval(job: PrintJob, reason: string, at: number): PrintJob {
  if (!job.startApproval && job.state !== 'start_approved') return job;
  const reset =
    job.state === 'start_approved'
      ? { ...job, state: 'awaiting_start_approval' as PrintJobState }
      : job;
  return clearApprovalFields({ ...reset, updatedAt: at }, at, reason);
}

export interface StartGateContext {
  activePrinterId: string;
  printerConnected: boolean;
  klipperReady: boolean;
  printerIdle: boolean;
  /** Filename Moonraker lists, or `null` when the listing could not be read. */
  uploadedFilename: string | null;
  /** Toolheads the printer reports as present and usable. */
  availableToolheads: number[];
  cameraFrame: CameraFrameRecord | null;
  operatorConfirmedBedClear: boolean;
  now: number;
  maxCameraAgeMs?: number;
}

/**
 * The full start gate from `docs/SAFETY_AND_TESTING.md`.
 *
 * Returns every failing check rather than the first, so the approval screen can
 * tell the operator everything that is wrong at once. An empty array means the
 * job-side checks pass; issuing the command is still `U1PrintService`'s call.
 *
 * Unknown counts as failure throughout: `printerConnected: false` and "could
 * not read the file listing" both block.
 */
export function evaluateStartGate(job: PrintJob, context: StartGateContext): GateResult[] {
  const failures: GateResult[] = [];
  const record = (result: GateResult) => {
    if (!result.ok) failures.push(result);
  };

  if (job.state !== 'start_approved') {
    record(
      gateFailure('job/invalid-transition', `Job must be start_approved, not ${job.state}.`, {
        state: job.state,
      })
    );
  }
  if (!context.printerConnected) {
    record(gateFailure('job/missing-printer', 'The printer is not connected.'));
  }
  if (!context.klipperReady) {
    record(gateFailure('job/missing-printer', 'Klipper is not ready.'));
  }
  if (!context.printerIdle) {
    record(gateFailure('job/concurrent-action', 'The printer is not idle.'));
  }
  if (!context.operatorConfirmedBedClear) {
    record(gateFailure('approval/not-granted', 'The operator has not confirmed the bed is clear.'));
  }
  if (hasBlockingWarning(job)) {
    record(gateFailure('job/invalid-transition', 'The job still has blocking warnings.'));
  }

  record(
    validateStartApproval(job, job.startApproval, {
      activePrinterId: context.activePrinterId,
      uploadedFilename: context.uploadedFilename,
      now: context.now,
    })
  );
  record(
    validateCameraFreshness(job, context.cameraFrame, context.now, context.maxCameraAgeMs)
  );

  const mapping = job.filamentMapping;
  if (!isFilamentMappingComplete(mapping)) {
    record(gateFailure('job/missing-filament-map', 'The filament mapping is incomplete.'));
  } else if (mapping) {
    const missing = mapping.slots
      .map((slot) => slot.toolhead)
      .filter((tool): tool is number => tool !== null)
      .filter((tool) => !context.availableToolheads.includes(tool));
    if (missing.length > 0) {
      record(
        gateFailure('job/missing-filament-map', 'A mapped toolhead is not available on the printer.', {
          missingToolheads: missing.join(','),
        })
      );
    }
  }

  return failures;
}

function clearApprovalFields(job: PrintJob, at: number, reason: string): PrintJob {
  return withEvent(
    { ...job, startApproval: null, updatedAt: at },
    { type: 'approval-cleared', at, detail: reason, revision: job.revision }
  );
}

function withEvent(job: PrintJob, event: PrintJobEvent): PrintJob {
  const events = [...job.events, event];
  return { ...job, events: events.slice(-MAX_JOB_EVENTS) };
}
