import { transition } from './PrintJobMachine';
import { isLockedState, isTerminalState, type PrintJob, type PrintJobState } from './PrintJobTypes';

// Following a job to its end.
//
// `startApprovedPrint` leaves a job at `printing` and then stops caring. Nothing
// afterwards ever moved it, so every print this app started stayed "printing"
// in the record for ever — including ones that failed. That makes the audit
// trail a log of intentions rather than outcomes, and it is the gap Phase 10
// exists to close.
//
// Pure, like the rest of the machine: it takes a job and what the printer says,
// and returns the job. Persistence and polling are the caller's problem, which
// is what makes every rule below directly testable.
//
// The governing rule is the same one the start gate uses — **unknown is not
// good news**. A printer that has stopped answering, or that will not say what
// it is doing, leaves the job exactly where it is rather than being read as
// success. A job is only completed when the printer says it completed.

/** What the printer is doing, as `print_stats` reports it. */
export interface PrinterSnapshot {
  connected: boolean;
  klippyReady: boolean;
  /** `print_stats.state`, verbatim. Null when the printer did not say. */
  printState: string | null;
  /** `print_stats.filename`, so a job can tell whether it is still the one running. */
  filename: string | null;
}

export interface MonitorOutcome {
  job: PrintJob;
  /** True when the job moved and should be persisted. */
  changed: boolean;
  /** Safe to show and to log; empty when nothing happened. */
  reason: string;
}

/** States this monitor is entitled to move a job out of. */
const WATCHED: readonly PrintJobState[] = ['starting', 'printing', 'paused'];

/**
 * Where each printer state takes a job.
 *
 * `standby` is deliberately absent. A printer returning to standby means the
 * job ended, but not how — Moonraker reports standby after a cancel, after an
 * error recovery, and after a firmware restart alike. Guessing "completed"
 * there would write a success into the record for a print that failed, so it is
 * handled separately and fails closed.
 */
const STATE_TARGET: Record<string, PrintJobState> = {
  printing: 'printing',
  paused: 'paused',
  complete: 'completed',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  error: 'failed',
};

function unchanged(job: PrintJob): MonitorOutcome {
  return { job, changed: false, reason: '' };
}

/**
 * Advances a job to match what the printer is doing.
 *
 * Only ever acts on a job it is watching, and only when the printer is
 * describing *that* job — see {@link isSameJob}. Anything else is left alone,
 * because a monitor that guesses is worse than one that says nothing.
 */
export function advanceJob(
  job: PrintJob,
  snapshot: PrinterSnapshot,
  at: number
): MonitorOutcome {
  if (!WATCHED.includes(job.state)) return unchanged(job);
  if (isTerminalState(job.state)) return unchanged(job);

  // A printer that is unreachable or not ready tells us nothing about the job.
  // The record stays as it is; recovery on restart is `PrintJobRepository`'s
  // job and already fails closed.
  if (!snapshot.connected || !snapshot.klippyReady) return unchanged(job);
  if (snapshot.printState === null) return unchanged(job);

  const state = snapshot.printState.trim().toLowerCase();

  // The printer is running something that is not this job. That can happen
  // legitimately — somebody started a different file at the machine — and it
  // means this job's outcome is no longer observable from here.
  if (!isSameJob(job, snapshot)) {
    if (job.state === 'starting' && state === 'standby') {
      // Never picked up. The start was issued but the printer never took it.
      return move(job, 'failed', at, 'the printer never began this file');
    }
    if (state === 'printing' || state === 'paused') {
      return move(
        job,
        'failed',
        at,
        `the printer is running ${describeFile(snapshot.filename)} instead`
      );
    }
    return unchanged(job);
  }

  if (state === 'standby') {
    // Same file, but the printer is idle. The print is over and the printer is
    // not saying it succeeded, so the honest record is a failure.
    return move(
      job,
      'failed',
      at,
      'the printer returned to standby without reporting completion'
    );
  }

  const target = STATE_TARGET[state];
  if (!target) return unchanged(job);
  if (target === job.state) return unchanged(job);

  // `starting` has no direct edge to `paused` or `completed`: a job must be seen
  // printing before it can pause or finish. Passing through keeps the audit
  // trail honest about what was observed rather than inventing a step.
  if (job.state === 'starting' && (target === 'paused' || target === 'completed')) {
    const printing = move(job, 'printing', at, 'the printer began printing');
    const next = advanceJob(printing.job, snapshot, at);
    return next.changed ? next : printing;
  }

  return move(job, target, at, describeTarget(target, snapshot));
}

/**
 * Whether the printer is describing this job.
 *
 * Matched on the filename the approval bound to. Moonraker reports the path it
 * was given, which is exactly what the start command named, so this is a
 * comparison of the same string rather than a heuristic. A printer reporting no
 * filename at all is treated as "not this job" — it cannot confirm it is.
 */
export function isSameJob(job: PrintJob, snapshot: PrinterSnapshot): boolean {
  if (!job.uploadedFilename || !snapshot.filename) return false;
  return snapshot.filename === job.uploadedFilename;
}

function move(job: PrintJob, to: PrintJobState, at: number, reason: string): MonitorOutcome {
  try {
    return { job: transition(job, to, at, { reason }), changed: true, reason };
  } catch {
    // The machine refused the edge. That is the machine being right and this
    // being wrong, so the job is left alone rather than forced.
    return unchanged(job);
  }
}

function describeTarget(target: PrintJobState, snapshot: PrinterSnapshot): string {
  switch (target) {
    case 'printing':
      return 'the printer began printing';
    case 'paused':
      return 'the printer paused';
    case 'completed':
      return 'the printer reported the print finished';
    case 'cancelled':
      return 'the print was cancelled at the printer';
    default:
      return `the printer reported ${snapshot.printState ?? 'an error'}`;
  }
}

function describeFile(filename: string | null): string {
  if (!filename) return 'another file';
  // Basename only: a full path is neither useful to an operator nor something
  // the event log should carry.
  return filename.split('/').pop() || 'another file';
}

/**
 * Whether a job is still worth polling for.
 *
 * Used to stop the monitor once there is nothing left to observe, so a finished
 * job does not keep a timer alive for the life of the app.
 */
export function isJobLive(job: PrintJob | null): boolean {
  if (!job) return false;
  return WATCHED.includes(job.state) && !isTerminalState(job.state);
}

/** Exposed so a screen can tell "the printer may be moving" from "it is not". */
export function isJobOnThePrinter(job: PrintJob | null): boolean {
  return job !== null && isLockedState(job.state) && !isTerminalState(job.state);
}
