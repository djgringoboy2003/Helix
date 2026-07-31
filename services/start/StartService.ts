// Starting a print, and the only place in the app that may.
//
// `CLAUDE.md` forbids starting after download, after slicing and after upload.
// Everything before this module therefore stops with bytes on the printer and no
// motion; this is the one path that reaches it, and it only does so through a
// validated `StartApproval`.
//
// The rule that shapes the whole file is that an approval is a claim about a
// moment — "the bed is clear, this is the file, this is what is loaded, I am
// watching" — and moments expire. So nothing here trusts what was true when the
// operator tapped. Every bound value is re-read from the printer immediately
// before the start command is issued, and any disagreement refuses. A test
// asserts the start command is never reached when a check fails.

import {
  validateCameraFreshness,
  validateStartApproval,
  type CameraFrameRecord,
} from '../jobs/ApprovalService';
import { isGateFailure, type GateFailure } from '../jobs/JobErrors';
import { evaluateStartGate, transition } from '../jobs/PrintJobMachine';
import type { PrintJob } from '../jobs/PrintJobTypes';
import type { PrinterReadiness, RemoteFile } from '../upload/UploadService';
import { materialsMatch, normalizeHexColor, type LoadedSlot } from '../filament/FilamentSlots';

/** States in which a new print must not be started. */
const BUSY_STATES: readonly string[] = ['printing', 'paused'];

/**
 * What the printer said about the uploaded file when the upload was verified.
 *
 * Carried into the start so the file can be checked again at start time. The
 * approval binds to a SHA-256 of bytes that are now on the printer, and the app
 * cannot re-hash them without pulling the whole file back — see
 * `docs/PHASE_9_SAFE_START.md` for why filename, size and modification time are
 * the check that is actually made.
 */
export interface UploadedFileFingerprint {
  filename: string;
  sizeBytes: number;
  /** Moonraker's `modified`, or null when it did not report one. */
  modified: number | null;
}

export interface StartIo {
  readReadiness(): Promise<PrinterReadiness>;
  listFiles(): Promise<RemoteFile[]>;
  /** What is physically on each toolhead, read fresh. */
  readLoadedSlots(): Promise<LoadedSlot[]>;
  /**
   * Applies the toolhead map and print preferences, and verifies the printer
   * accepted them. Throws when it did not.
   */
  applyPrintSetup(usedToolheads: number[]): Promise<void>;
  /** Issues the start for exactly this filename. */
  startPrint(filename: string): Promise<void>;
}

export type StartRefusalCode =
  | 'start/not-approved'
  | 'start/printer-offline'
  | 'start/printer-not-ready'
  | 'start/printer-busy'
  | 'start/file-missing'
  | 'start/file-changed'
  | 'start/filament-changed'
  | 'start/gate-failed'
  | 'start/setup-failed'
  | 'start/command-failed';

export interface StartRefusal {
  status: 'refused';
  code: StartRefusalCode;
  message: string;
  /** Every failing check, so the screen can show them all at once. */
  failures: GateFailure[];
  /** The job, updated when the refusal moved it. Persist this. */
  job: PrintJob;
  /**
   * True when the app cannot know whether the printer began moving. The
   * operator has to look at the machine; nothing here may assume either way.
   */
  uncertain: boolean;
}

export interface StartSuccess {
  status: 'started';
  filename: string;
  job: PrintJob;
}

export type StartOutcome = StartSuccess | StartRefusal;

export interface StartRequest {
  job: PrintJob;
  /** Printer the app is talking to right now, not the one at approval time. */
  activePrinterId: string;
  /** What the printer reported about the file when the upload was verified. */
  uploaded: UploadedFileFingerprint;
  /** The frame the operator is looking at. Null means none, which is stale. */
  cameraFrame: CameraFrameRecord | null;
  operatorConfirmedBedClear: boolean;
  now: number;
  maxCameraAgeMs?: number;
}

function refuse(
  job: PrintJob,
  code: StartRefusalCode,
  message: string,
  failures: GateFailure[] = [],
  uncertain = false
): StartRefusal {
  return { status: 'refused', code, message, failures, job, uncertain };
}

/**
 * The toolheads a job's mapping will actually drive.
 *
 * Sorted and deduplicated because this becomes `SET_PRINT_USED_EXTRUDERS`, and
 * two source colours routed to one head is one head in use, not two.
 */
export function usedToolheadsOf(job: PrintJob): number[] {
  const slots = job.filamentMapping?.slots ?? [];
  const used = new Set<number>();
  for (const slot of slots) {
    if (typeof slot.toolhead === 'number' && Number.isInteger(slot.toolhead)) {
      used.add(slot.toolhead);
    }
  }
  return [...used].sort((a, b) => a - b);
}

/**
 * Re-reads what is loaded and compares it with what the approval was given for.
 *
 * A spool swapped between approving and starting is the case this exists for.
 * Unknown fails: a head the printer will not describe cannot be confirmed to
 * still hold what the mapping says it holds.
 */
export function recheckFilament(job: PrintJob, live: readonly LoadedSlot[]): GateFailure[] {
  const failures: GateFailure[] = [];
  const slots = job.filamentMapping?.slots ?? [];

  for (const slot of slots) {
    if (slot.toolhead === null) continue;
    const head = live.find((candidate) => candidate.toolhead === slot.toolhead);

    if (!head || head.status !== 'loaded') {
      failures.push({
        ok: false,
        code: 'job/missing-filament-map',
        message: `T${slot.toolhead} no longer reports loaded filament.`,
        details: { toolhead: slot.toolhead, status: head?.status ?? 'unknown' },
      });
      continue;
    }

    // Compared the way the mapping was built: base material type, and colour
    // normalised to #RRGGBB. Anything the mapping did not record is not
    // re-checked — it was never part of what the operator agreed to.
    if (slot.loadedMaterial && !materialsMatch(slot.loadedMaterial, head.material)) {
      failures.push({
        ok: false,
        code: 'approval/filament-map-mismatch',
        message: `T${slot.toolhead} now holds ${head.material || 'unknown filament'}, not ${slot.loadedMaterial}.`,
        details: { toolhead: slot.toolhead },
      });
    }

    const approvedColor = normalizeHexColor(slot.loadedColor);
    const liveColor = normalizeHexColor(head.color);
    if (approvedColor && approvedColor !== liveColor) {
      failures.push({
        ok: false,
        code: 'approval/filament-map-mismatch',
        message: `T${slot.toolhead} is now ${liveColor || 'an unknown colour'}, not ${approvedColor}.`,
        details: { toolhead: slot.toolhead },
      });
    }
  }

  return failures;
}

/**
 * Confirms the printer still holds the file the approval names.
 *
 * Matched on the exact filename — `CLAUDE.md` requires the start to name the
 * uploaded file — then on the size and modification time recorded when the
 * upload was verified.
 */
export function recheckUploadedFile(
  expected: UploadedFileFingerprint,
  files: readonly RemoteFile[]
): { ok: true; file: RemoteFile } | { ok: false; code: StartRefusalCode; message: string } {
  const file = files.find((candidate) => candidate.path === expected.filename);
  if (!file) {
    return {
      ok: false,
      code: 'start/file-missing',
      message: `${expected.filename} is no longer on the printer. Upload it again.`,
    };
  }
  if (file.size !== expected.sizeBytes) {
    return {
      ok: false,
      code: 'start/file-changed',
      message: `${expected.filename} is now ${file.size} bytes, not ${expected.sizeBytes}. It is not the approved file.`,
    };
  }
  if (
    expected.modified !== null &&
    typeof file.modified === 'number' &&
    file.modified !== expected.modified
  ) {
    return {
      ok: false,
      code: 'start/file-changed',
      message: `${expected.filename} was replaced after it was approved.`,
    };
  }
  return { ok: true, file };
}

/**
 * Starts an approved print, or refuses and says why.
 *
 * The order is the point. Everything that can refuse is checked against live
 * printer state first, and the job only enters `starting` once nothing is left
 * that could say no. After that there are exactly two commands — the toolhead
 * map, then the start — and a failure in either leaves the job `failed` rather
 * than pretending to know what the printer did.
 */
export async function startApprovedPrint(
  request: StartRequest,
  io: StartIo
): Promise<StartOutcome> {
  const { job, now } = request;

  // 1. The job must be sitting on a granted approval. Anything else means
  //    something reached this function around `grantStartApproval`.
  if (job.state !== 'start_approved' || !job.startApproval) {
    return refuse(
      job,
      'start/not-approved',
      `This job is ${job.state}, not approved to start.`
    );
  }
  const approval = job.startApproval;

  // 2. Live printer state. Re-read rather than trusted from the approval
  //    screen: the printer may have been given another job in the meantime.
  let readiness: PrinterReadiness;
  try {
    readiness = await io.readReadiness();
  } catch {
    return refuse(job, 'start/printer-offline', 'The printer could not be reached.');
  }
  if (!readiness.connected) {
    return refuse(job, 'start/printer-offline', 'The printer is offline.');
  }
  if (!readiness.klippyReady) {
    return refuse(job, 'start/printer-not-ready', 'The printer firmware is not ready.');
  }
  if (readiness.printState === null) {
    return refuse(
      job,
      'start/printer-not-ready',
      'The printer did not report what it is doing, so nothing was started.'
    );
  }
  if (BUSY_STATES.includes(readiness.printState.toLowerCase())) {
    return refuse(
      job,
      'start/printer-busy',
      `The printer is already ${readiness.printState.toLowerCase()}. Nothing was started.`
    );
  }

  // 3. The exact file, still there and still the same one.
  let files: RemoteFile[];
  try {
    files = await io.listFiles();
  } catch {
    return refuse(
      job,
      'start/file-missing',
      'The printer’s file list could not be read, so the approved file could not be confirmed.'
    );
  }
  const fileCheck = recheckUploadedFile(request.uploaded, files);
  if (!fileCheck.ok) {
    return refuse(job, fileCheck.code, fileCheck.message);
  }

  // 4. What is loaded, read fresh.
  let live: LoadedSlot[];
  try {
    live = await io.readLoadedSlots();
  } catch {
    return refuse(
      job,
      'start/filament-changed',
      'What is loaded could not be read, so the filament mapping could not be confirmed.'
    );
  }
  const filamentFailures = recheckFilament(job, live);
  if (filamentFailures.length > 0) {
    return refuse(
      job,
      'start/filament-changed',
      'The filament changed after this print was approved. Approve it again.',
      filamentFailures
    );
  }

  // 5. The full gate: approval bindings, camera freshness, bed-clear, warnings,
  //    mapping completeness — every failure at once, not the first.
  const gateFailures = evaluateStartGate(job, {
    activePrinterId: request.activePrinterId,
    printerConnected: readiness.connected,
    klipperReady: readiness.klippyReady,
    printerIdle: !BUSY_STATES.includes(readiness.printState.toLowerCase()),
    uploadedFilename: fileCheck.file.path,
    availableToolheads: live.filter((slot) => slot.status === 'loaded').map((slot) => slot.toolhead),
    cameraFrame: request.cameraFrame,
    operatorConfirmedBedClear: request.operatorConfirmedBedClear,
    now,
    maxCameraAgeMs: request.maxCameraAgeMs,
  }).filter(isGateFailure);
  if (gateFailures.length > 0) {
    return refuse(
      job,
      'start/gate-failed',
      'This print cannot start yet.',
      gateFailures
    );
  }

  // 6. The toolhead map. A printer that will not take it must not be started:
  //    the file would print with whatever mapping was left over from last time.
  //
  //    The job stays `start_approved` through this. These commands configure,
  //    they do not move anything, so a refusal here is retryable and must not
  //    leave a job claiming the printer might be running.
  try {
    await io.applyPrintSetup(usedToolheadsOf(job));
  } catch (error) {
    return refuse(
      job,
      'start/setup-failed',
      `The printer would not accept the toolhead mapping, so nothing was started. ${messageOf(error)}`
    );
  }

  // 7. From here the printer may move, and the job has to say so before the
  //    command goes out — an app that dies mid-request must not recover into
  //    believing nothing happened.
  const starting = transition(job, 'starting', now, {
    reason: `starting ${approval.filename}`,
  });

  // 8. The start itself, naming the approved file and nothing else.
  try {
    await io.startPrint(approval.filename);
  } catch (error) {
    const failed = transition(starting, 'failed', now, {
      reason: 'start command failed; printer state unknown',
    });
    return refuse(
      failed,
      'start/command-failed',
      `The start command failed. Check the printer before trying again — it may or may not have begun. ${messageOf(error)}`,
      [],
      // The request may have been received and the response lost. Whether the
      // printer moved is not knowable from here, and guessing either way is
      // worse than saying so.
      true
    );
  }

  const printing = transition(starting, 'printing', now, {
    reason: `printing ${approval.filename}`,
  });
  return { status: 'started', filename: approval.filename, job: printing };
}

/**
 * The immediate cancel route.
 *
 * Available from every state the approval flow passes through, so an operator
 * who changes their mind is never left holding a job that only knows how to go
 * forwards. Cancelling a job that already reached the printer does not stop the
 * printer — that is `api.cancel`'s job, and the caller's to issue.
 */
export function cancelStart(job: PrintJob, reason: string, at: number): PrintJob {
  return transition(job, 'cancelled', at, { reason });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { validateStartApproval, validateCameraFreshness };
