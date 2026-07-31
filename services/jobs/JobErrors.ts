// Structured errors for the print-job domain.
//
// `docs/TECHNICAL_ARCHITECTURE.md` requires structured error codes, and
// `docs/SAFETY_AND_TESTING.md` requires the start gate to fail when any check is
// unknown. Codes exist so a refusal can be shown, logged and asserted on
// without parsing prose, and so no caller has to guess whether a thrown value
// meant "not yet" or "never".

export type PrintJobErrorCode =
  // State machine
  | 'job/invalid-transition'
  | 'job/terminal-state'
  | 'job/revision-locked'
  | 'job/unknown-state'
  | 'job/missing-artifact'
  | 'job/missing-printer'
  | 'job/missing-filament-map'
  | 'job/missing-upload'
  | 'job/concurrent-action'
  // Approval binding
  | 'approval/missing'
  | 'approval/expired'
  | 'approval/job-mismatch'
  | 'approval/revision-mismatch'
  | 'approval/printer-mismatch'
  | 'approval/filename-mismatch'
  | 'approval/gcode-hash-mismatch'
  | 'approval/filament-map-mismatch'
  | 'approval/not-granted'
  | 'approval/invalid-record'
  // Bed camera freshness. Separate from approval codes because the operator's
  // fix is different: refresh the view, not re-approve the job.
  | 'camera/unavailable'
  | 'camera/stale'
  | 'camera/printer-mismatch'
  | 'camera/revision-mismatch'
  // Persistence
  | 'repository/corrupt-record'
  | 'repository/unavailable';

export class PrintJobError extends Error {
  readonly code: PrintJobErrorCode;
  /** Safe to surface to the operator and to write to logs. */
  readonly details: Record<string, string | number | boolean>;

  constructor(
    code: PrintJobErrorCode,
    message: string,
    details: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = 'PrintJobError';
    this.code = code;
    this.details = details;
  }
}

export function isPrintJobError(value: unknown): value is PrintJobError {
  return value instanceof PrintJobError;
}

/**
 * The outcome of a check that is allowed to say no.
 *
 * Gates return this rather than throwing so a screen can render every failing
 * reason at once instead of only the first.
 */
export type GateResult =
  | { ok: true }
  | { ok: false; code: PrintJobErrorCode; message: string; details?: Record<string, string | number | boolean> };

/** A gate that said no. Carries the code and the operator-facing reason. */
export type GateFailure = Extract<GateResult, { ok: false }>;

export function isGateFailure(result: GateResult): result is GateFailure {
  return !result.ok;
}

export const GATE_OK: GateResult = { ok: true };

export function gateFailure(
  code: PrintJobErrorCode,
  message: string,
  details?: Record<string, string | number | boolean>
): GateResult {
  return { ok: false, code, message, details };
}

/** Turns a refused gate into a throwable error, preserving the code. */
export function toPrintJobError(result: GateResult): PrintJobError | null {
  if (result.ok) return null;
  return new PrintJobError(result.code, result.message, result.details);
}
