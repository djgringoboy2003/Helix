import { gateFailure, GATE_OK, PrintJobError, type GateResult } from './JobErrors';
import { filamentMapHash, isFilamentMappingComplete, type PrintJob, type StartApproval } from './PrintJobTypes';
import { isSha256Hex } from '../security/Sha256';

// Start approvals.
//
// An approval is a snapshot of exactly what the operator agreed to print. It is
// deliberately not a boolean: `docs/SAFETY_AND_TESTING.md` requires that a
// changed printer, filename, G-code hash, filament mapping or job revision
// invalidates it, so every one of those values is written into the record and
// compared again immediately before the start command is issued.
//
// Nothing here talks to the printer. Issuing motion is the job of
// `U1PrintService` (Phase 9), which must call `validateStartApproval` first.

/**
 * How long an approval stays usable.
 *
 * Short by design: an approval means "the bed is clear and I am watching now",
 * and that claim goes stale quickly. Callers may shorten it, never lengthen it
 * past {@link MAX_APPROVAL_TTL_MS}.
 */
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;

/** A camera frame older than this cannot support a start decision. */
export const DEFAULT_MAX_CAMERA_AGE_MS = 60 * 1000;

export interface CameraFrameRecord {
  capturedAt: number;
  printerId: string;
  /** Endpoint path only — never a URL carrying credentials. */
  cameraEndpoint: string;
  jobRevision: number;
}

export interface GrantApprovalInput {
  job: PrintJob;
  printerId: string;
  filename: string;
  gcodeSha256: string;
  /** Operator action time; also the approval's start of life. */
  approvedAt: number;
  ttlMs?: number;
}

/**
 * Builds an approval record from the job's current values.
 *
 * Refuses rather than filling gaps: an approval that names an empty filename or
 * an unmapped toolhead would still look structurally valid later.
 */
export function createStartApproval(input: GrantApprovalInput): StartApproval {
  const { job, printerId, filename, gcodeSha256, approvedAt } = input;

  if (!printerId.trim()) {
    throw new PrintJobError('job/missing-printer', 'Approval needs a printer identifier.');
  }
  if (!filename.trim()) {
    throw new PrintJobError('job/missing-upload', 'Approval needs the uploaded filename.');
  }
  if (!isSha256Hex(gcodeSha256)) {
    throw new PrintJobError('approval/invalid-record', 'Approval needs a valid G-code SHA-256.', {
      filename,
    });
  }
  if (!isFilamentMappingComplete(job.filamentMapping)) {
    throw new PrintJobError(
      'job/missing-filament-map',
      'Approval needs a confirmed filament mapping for every source colour.'
    );
  }
  if (!Number.isFinite(approvedAt) || approvedAt <= 0) {
    throw new PrintJobError('approval/invalid-record', 'Approval needs a real timestamp.');
  }

  const ttlMs = Math.min(input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS);
  if (ttlMs <= 0) {
    throw new PrintJobError('approval/invalid-record', 'Approval lifetime must be positive.');
  }

  return {
    jobId: job.id,
    jobRevision: job.revision,
    printerId,
    filename,
    gcodeSha256,
    filamentMapHash: filamentMapHash(job.filamentMapping),
    approvedAt,
    expiresAt: approvedAt + ttlMs,
  };
}

export interface ApprovalCheckContext {
  /** Printer the app is connected to right now, not the one at approval time. */
  activePrinterId: string;
  /** Filename Moonraker currently reports for the uploaded file. */
  uploadedFilename: string | null;
  now: number;
}

/**
 * Re-derives every bound value from live job state and compares it with the
 * record. Any mismatch fails closed.
 */
export function validateStartApproval(
  job: PrintJob,
  approval: StartApproval | null,
  context: ApprovalCheckContext
): GateResult {
  if (!approval) {
    return gateFailure('approval/missing', 'No start approval has been given for this job.');
  }
  if (approval.jobId !== job.id) {
    return gateFailure('approval/job-mismatch', 'Approval belongs to a different job.', {
      approvalJobId: approval.jobId,
      jobId: job.id,
    });
  }
  if (approval.jobRevision !== job.revision) {
    return gateFailure(
      'approval/revision-mismatch',
      'The job changed after approval. Approve the new version.',
      { approvedRevision: approval.jobRevision, currentRevision: job.revision }
    );
  }
  if (approval.printerId !== job.printerId || approval.printerId !== context.activePrinterId) {
    return gateFailure('approval/printer-mismatch', 'Approval was given for a different printer.', {
      approvedPrinterId: approval.printerId,
      jobPrinterId: job.printerId,
      activePrinterId: context.activePrinterId,
    });
  }
  if (!job.uploadedFilename || approval.filename !== job.uploadedFilename) {
    return gateFailure('approval/filename-mismatch', 'The uploaded filename changed after approval.', {
      approvedFilename: approval.filename,
      jobFilename: job.uploadedFilename ?? '',
    });
  }
  if (context.uploadedFilename !== null && approval.filename !== context.uploadedFilename) {
    return gateFailure(
      'approval/filename-mismatch',
      'The printer reports a different filename than the one approved.',
      { approvedFilename: approval.filename, printerFilename: context.uploadedFilename }
    );
  }
  if (!job.gcodeSha256 || approval.gcodeSha256 !== job.gcodeSha256) {
    return gateFailure('approval/gcode-hash-mismatch', 'The G-code changed after approval.', {
      approvedSha256: approval.gcodeSha256,
      jobSha256: job.gcodeSha256 ?? '',
    });
  }
  if (approval.filamentMapHash !== filamentMapHash(job.filamentMapping)) {
    return gateFailure(
      'approval/filament-map-mismatch',
      'The filament mapping changed after approval.'
    );
  }
  if (!Number.isFinite(context.now)) {
    return gateFailure('approval/expired', 'Current time is unknown; refusing to start.');
  }
  if (context.now >= approval.expiresAt) {
    return gateFailure('approval/expired', 'The approval expired. Approve the print again.', {
      expiresAt: approval.expiresAt,
      now: context.now,
    });
  }
  if (context.now < approval.approvedAt) {
    // Clock moved backwards; the remaining lifetime can no longer be trusted.
    return gateFailure('approval/expired', 'Approval timing is inconsistent; approve again.', {
      approvedAt: approval.approvedAt,
      now: context.now,
    });
  }

  return GATE_OK;
}

/**
 * A camera frame supports a start only if it is recent, from this printer, and
 * captured at the revision being approved. Missing means stale.
 */
export function validateCameraFreshness(
  job: PrintJob,
  frame: CameraFrameRecord | null,
  now: number,
  maxAgeMs: number = DEFAULT_MAX_CAMERA_AGE_MS
): GateResult {
  if (!frame) {
    return gateFailure('camera/unavailable', 'No bed camera image is available.');
  }
  if (frame.printerId !== job.printerId) {
    return gateFailure('camera/printer-mismatch', 'The camera image is from a different printer.', {
      framePrinterId: frame.printerId,
      jobPrinterId: job.printerId,
    });
  }
  if (frame.jobRevision !== job.revision) {
    return gateFailure('camera/revision-mismatch', 'The camera image predates the current job version.', {
      frameRevision: frame.jobRevision,
      jobRevision: job.revision,
    });
  }
  if (!Number.isFinite(now) || !Number.isFinite(frame.capturedAt)) {
    return gateFailure('camera/stale', 'Camera timing is unknown; refusing to start.');
  }
  const age = now - frame.capturedAt;
  if (age < 0 || age > maxAgeMs) {
    return gateFailure('camera/stale', 'The bed camera image is stale. Refresh it before starting.', {
      ageMs: age,
      maxAgeMs,
    });
  }
  return GATE_OK;
}

export function approvalRemainingMs(approval: StartApproval | null, now: number): number {
  if (!approval) return 0;
  return Math.max(0, approval.expiresAt - now);
}

export function isApprovalExpired(approval: StartApproval | null, now: number): boolean {
  return approvalRemainingMs(approval, now) <= 0;
}

/** Rejects records restored from storage that are structurally wrong. */
export function isStartApprovalRecord(value: unknown): value is StartApproval {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.jobId === 'string' &&
    typeof record.jobRevision === 'number' &&
    typeof record.printerId === 'string' &&
    typeof record.filename === 'string' &&
    isSha256Hex(record.gcodeSha256) &&
    isSha256Hex(record.filamentMapHash) &&
    typeof record.approvedAt === 'number' &&
    typeof record.expiresAt === 'number'
  );
}
