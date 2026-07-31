// Uploading a sliced file, and nothing else.
//
// This module **cannot start a print**. That is the point of it. `CLAUDE.md`
// forbids starting after slicing or after upload, and `PrintJobMachine` has no
// `uploaded → starting` transition, so the upload step has to be a thing that
// finishes with bytes on the printer and no motion. A test asserts that this
// file contains no reference to any start endpoint, so the guarantee survives a
// later edit by someone who has not read this comment.
//
// Every check runs before any byte is sent. An upload that will be refused, or
// that would overwrite something, is worth discovering before spending a minute
// pushing 40 MB over wifi.

import type { SliceReview } from '../gcode/SliceReview';

export interface PrinterReadiness {
  /** Moonraker is reachable and answering. */
  connected: boolean;
  /** Klipper itself is ready, not in an error or startup state. */
  klippyReady: boolean;
  /** `print_stats.state`, verbatim. Null when the printer did not say. */
  printState: string | null;
}

export interface RemoteFile {
  path: string;
  size: number;
  modified?: number;
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

export interface UploadIo {
  readReadiness(): Promise<PrinterReadiness>;
  listFiles(): Promise<RemoteFile[]>;
  /** Free space on the printer in bytes, or null when it cannot be determined. */
  freeSpaceBytes(): Promise<number | null>;
  /** Local size of the file about to be sent. */
  statLocal(gcodePath: string): Promise<number | null>;
  /** Sends the file. Returns what the printer reported about what it stored. */
  upload(
    filename: string,
    gcodePath: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<{ status: number; sizeBytes: number | null }>;
}

export type UploadRefusalCode =
  | 'upload/not-reviewed'
  | 'upload/printer-offline'
  | 'upload/printer-not-ready'
  | 'upload/printer-busy'
  | 'upload/file-changed'
  | 'upload/file-missing'
  | 'upload/insufficient-storage'
  | 'upload/collision'
  | 'upload/rejected'
  | 'upload/interrupted'
  | 'upload/size-mismatch';

export interface UploadRecord {
  filename: string;
  sizeBytes: number;
  /** SHA-256 of the reviewed local file — what a start approval binds to. */
  sha256: string;
  uploadedAt: number;
}

export type UploadOutcome =
  | { status: 'uploaded'; record: UploadRecord }
  /**
   * A file of this name is already on the printer. The safety rules forbid
   * overwriting one without approval, so this is a question, not a failure.
   */
  | {
      status: 'needs-approval';
      code: 'upload/collision';
      message: string;
      existing: RemoteFile;
    }
  | { status: 'refused'; code: UploadRefusalCode; message: string };

/** States in which the printer must not be given a new file. */
const BUSY_STATES: readonly string[] = ['printing', 'paused'];

/** Headroom required beyond the file itself, so a print does not fill the disk. */
export const STORAGE_MARGIN_BYTES = 32 * 1024 * 1024;

function refuse(code: UploadRefusalCode, message: string): UploadOutcome {
  return { status: 'refused', code, message };
}

export interface UploadRequest {
  /** The reviewed slice. Its hash and size are what get uploaded and recorded. */
  review: SliceReview;
  /** Target name on the printer. Callers sanitise; this checks for collision. */
  filename: string;
  /** Set only after the operator has agreed to replace an existing file. */
  overwriteApproved?: boolean;
  onProgress?: (progress: UploadProgress) => void;
  now?: () => number;
}

/**
 * Uploads a reviewed slice, refusing rather than guessing.
 *
 * The order is deliberate: everything that can refuse without touching the
 * network runs first, then printer state, then storage, then the collision
 * question, and only then are bytes sent.
 */
export async function uploadSlicedGcode(
  request: UploadRequest,
  io: UploadIo
): Promise<UploadOutcome> {
  const { review, filename } = request;
  const now = request.now ?? Date.now;

  // 1. An unreviewed or failed slice has no business reaching the printer, and
  //    has no hash to record against it.
  if (!review.ok || !review.sha256) {
    return refuse(
      'upload/not-reviewed',
      'This G-code has not passed review, so it will not be uploaded.'
    );
  }

  // 2. Printer readiness.
  let readiness: PrinterReadiness;
  try {
    readiness = await io.readReadiness();
  } catch {
    return refuse('upload/printer-offline', 'The printer could not be reached.');
  }
  if (!readiness.connected) {
    return refuse('upload/printer-offline', 'The printer is offline.');
  }
  if (!readiness.klippyReady) {
    return refuse(
      'upload/printer-not-ready',
      'The printer firmware is not ready. Check the printer before uploading.'
    );
  }
  if (readiness.printState === null) {
    // Unknown printer state fails closed, per `docs/SAFETY_AND_TESTING.md`.
    return refuse(
      'upload/printer-not-ready',
      'The printer did not report what it is doing, so nothing was uploaded.'
    );
  }
  if (BUSY_STATES.includes(readiness.printState.toLowerCase())) {
    return refuse(
      'upload/printer-busy',
      `The printer is ${readiness.printState.toLowerCase()}. Wait for it to finish before uploading.`
    );
  }

  // 3. The local file must still be the one that was reviewed. A file that
  //    changed since the review would upload bytes the hash does not describe.
  let localSize: number | null;
  try {
    localSize = await io.statLocal(review.filePath);
  } catch {
    localSize = null;
  }
  if (localSize === null) {
    return refuse('upload/file-missing', 'The sliced file is no longer there.');
  }
  if (localSize !== review.sizeBytes) {
    return refuse(
      'upload/file-changed',
      'The sliced file changed after it was reviewed. Slice again before uploading.'
    );
  }

  // 4. Storage.
  let free: number | null = null;
  try {
    free = await io.freeSpaceBytes();
  } catch {
    free = null;
  }
  if (free !== null && free < review.sizeBytes + STORAGE_MARGIN_BYTES) {
    return refuse(
      'upload/insufficient-storage',
      'The printer does not have room for this file. Delete something and try again.'
    );
  }

  // 5. Collision. Never overwrite without approval.
  let existing: RemoteFile | undefined;
  try {
    const files = await io.listFiles();
    existing = files.find((file) => file.path.toLowerCase() === filename.toLowerCase());
  } catch {
    // A file list that cannot be read means a collision cannot be ruled out,
    // and the rule is "never overwrite without approval" — so stop.
    return refuse(
      'upload/rejected',
      'The printer’s file list could not be read, so an existing file might be overwritten.'
    );
  }
  if (existing && !request.overwriteApproved) {
    return {
      status: 'needs-approval',
      code: 'upload/collision',
      message: `${filename} is already on the printer. Replacing it needs your approval.`,
      existing,
    };
  }

  // 6. Send.
  let result: { status: number; sizeBytes: number | null };
  try {
    result = await io.upload(filename, review.filePath, request.onProgress);
  } catch {
    return refuse('upload/interrupted', 'The upload was interrupted. Nothing was started.');
  }
  if (result.status < 200 || result.status >= 300) {
    return refuse('upload/rejected', `The printer refused the upload (HTTP ${result.status}).`);
  }

  // 7. Verify what landed. A short write would otherwise be approved and
  //    printed as though it were the file that was reviewed.
  if (result.sizeBytes !== null && result.sizeBytes !== review.sizeBytes) {
    return refuse(
      'upload/size-mismatch',
      `The printer stored ${result.sizeBytes} bytes but the file is ${review.sizeBytes}. It was not started.`
    );
  }

  // 8. Done. No print has been started, and this function has no way to start
  //    one — reaching motion requires an approval through `PrintJobMachine`.
  return {
    status: 'uploaded',
    record: {
      filename,
      sizeBytes: review.sizeBytes,
      sha256: review.sha256,
      uploadedAt: now(),
    },
  };
}

/**
 * A filename that is safe on the printer and describes the model.
 *
 * Keeps the extension, strips anything path-like, and bounds the length.
 */
export function printerFilename(modelName: string, fallback = 'print.gcode'): string {
  const base = modelName.split(/[/\\]/).pop() ?? '';
  const stripped = Array.from(base)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!stripped) return fallback;

  const withoutModelExtension = stripped.replace(/\.(3mf|stl|obj|step|stp)$/i, '');
  const named = /\.gcode$/i.test(withoutModelExtension)
    ? withoutModelExtension
    : `${withoutModelExtension}.gcode`;
  return named.length > 100 ? `${named.slice(0, 94)}.gcode` : named;
}
