import { isApprovalExpired, isStartApprovalRecord } from './ApprovalService';
import { PrintJobError } from './JobErrors';
import {
  MAX_JOB_EVENTS,
  isPrintJobState,
  isTerminalState,
  type PrintJob,
  type PrintJobState,
} from './PrintJobTypes';

// Job persistence and restart recovery.
//
// Written against a tiny storage interface rather than AsyncStorage directly so
// the rules below are testable without a React Native runtime;
// `AsyncStorageJobStorage.ts` supplies the real backend.
//
// The recovery rules are the safety-relevant part. After process death the app
// cannot know what the printer did in the meantime, and
// `docs/SAFETY_AND_TESTING.md` requires unknown state to fail closed. So no job
// is ever restored into a state that implies a live operator: an in-flight step
// rewinds to the last point that can be safely retried, and an approval never
// survives a restart.

export interface JobStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const JOB_STORAGE_VERSION = 1;
export const JOB_INDEX_KEY = 'helix.jobs.v1.index';
export const JOB_KEY_PREFIX = 'helix.jobs.v1.job.';

/** Oldest records are dropped past this; history lives in the history feature. */
export const MAX_STORED_JOBS = 50;

export function jobStorageKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

/**
 * Where each interrupted step resumes from.
 *
 * A state not listed here is a resting state and survives a restart unchanged.
 */
const RECOVERY_STATE: Partial<Record<PrintJobState, PrintJobState>> = {
  downloading: 'created',
  inspecting: 'downloaded',
  preparing: 'downloaded',
  // An interrupted slice produced no usable output, so it is a failed slice.
  slicing: 'slice_failed',
  uploading: 'approved_for_upload',
  // The operator is no longer at the printer; approval must be given again.
  start_approved: 'awaiting_start_approval',
  // The app died between issuing the start and seeing it confirmed. Whether the
  // printer moved is unknowable from here, so the job does not continue.
  starting: 'failed',
};

export interface RecoveryOutcome {
  job: PrintJob;
  /** True when recovery changed the job and the operator should be told. */
  recovered: boolean;
  /** Safe to display; explains what was interrupted. */
  reason: string;
}

/**
 * Brings a stored job back to a state that is honest about what is known.
 *
 * Pure and exported so the rules can be asserted directly.
 */
export function recoverJob(job: PrintJob, at: number): RecoveryOutcome {
  const target = RECOVERY_STATE[job.state];
  const approvalStale = job.startApproval !== null && isApprovalExpired(job.startApproval, at);
  const dropApproval = job.startApproval !== null && (target !== undefined || approvalStale);

  if (!target && !dropApproval) {
    return { job, recovered: false, reason: '' };
  }

  const reason = target
    ? `Interrupted while ${job.state}; recovered to ${target}.`
    : 'The start approval expired while the app was closed.';

  const events = [
    ...job.events,
    {
      type: 'error' as const,
      at,
      detail: reason,
      fromState: job.state,
      toState: target ?? job.state,
      revision: job.revision,
    },
  ];

  return {
    job: {
      ...job,
      state: target ?? job.state,
      startApproval: dropApproval ? null : job.startApproval,
      updatedAt: at,
      events: events.slice(-MAX_JOB_EVENTS),
    },
    recovered: true,
    reason,
  };
}

/** Structural check for records coming back out of storage. */
export function isPrintJobRecord(value: unknown): value is PrintJob {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.modelId === 'string' &&
    isPrintJobState(record.state) &&
    typeof record.revision === 'number' &&
    Number.isInteger(record.revision) &&
    record.revision >= 1 &&
    typeof record.printerId === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    Array.isArray(record.warnings) &&
    Array.isArray(record.events) &&
    (record.startApproval === null || isStartApprovalRecord(record.startApproval))
  );
}

interface StoredEnvelope {
  version: number;
  job: PrintJob;
}

export class PrintJobRepository {
  private readonly storage: JobStorage;
  private readonly now: () => number;

  constructor(storage: JobStorage, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
  }

  async save(job: PrintJob): Promise<void> {
    const envelope: StoredEnvelope = { version: JOB_STORAGE_VERSION, job };
    await this.storage.setItem(jobStorageKey(job.id), JSON.stringify(envelope));
    await this.addToIndex(job.id);
  }

  /**
   * Loads a job and applies recovery. Returns `null` for an absent job and
   * throws for a present-but-unreadable one, so corruption is never mistaken
   * for "no job".
   *
   * Recovery is applied on read and not written back; persist the returned job
   * to make it durable. Reapplying it is harmless — recovered states are
   * themselves resting states, so a second pass reports `recovered: false`.
   */
  async load(jobId: string): Promise<RecoveryOutcome | null> {
    const raw = await this.storage.getItem(jobStorageKey(jobId));
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PrintJobError('repository/corrupt-record', 'Stored job could not be read.', { jobId });
    }

    const envelope = parsed as Partial<StoredEnvelope>;
    if (!envelope || envelope.version !== JOB_STORAGE_VERSION || !isPrintJobRecord(envelope.job)) {
      throw new PrintJobError('repository/corrupt-record', 'Stored job is not a usable record.', {
        jobId,
        version: typeof envelope?.version === 'number' ? envelope.version : -1,
      });
    }

    return recoverJob(envelope.job, this.now());
  }

  /** Every readable job, newest first. Unreadable records are skipped, not thrown. */
  async list(): Promise<RecoveryOutcome[]> {
    const ids = await this.readIndex();
    const outcomes: RecoveryOutcome[] = [];
    for (const id of ids) {
      try {
        const outcome = await this.load(id);
        if (outcome) outcomes.push(outcome);
      } catch {
        // A single corrupt record must not hide the rest of the operator's work.
      }
    }
    return outcomes.sort((a, b) => b.job.updatedAt - a.job.updatedAt);
  }

  /** The most recent job that is still in play, for the resume banner. */
  async loadActive(): Promise<RecoveryOutcome | null> {
    const all = await this.list();
    return all.find((outcome) => !isTerminalState(outcome.job.state)) ?? null;
  }

  async remove(jobId: string): Promise<void> {
    await this.storage.removeItem(jobStorageKey(jobId));
    const ids = await this.readIndex();
    await this.writeIndex(ids.filter((id) => id !== jobId));
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.storage.getItem(JOB_INDEX_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.storage.setItem(JOB_INDEX_KEY, JSON.stringify(ids));
  }

  private async addToIndex(jobId: string): Promise<void> {
    const ids = await this.readIndex();
    const next = [jobId, ...ids.filter((id) => id !== jobId)];
    const kept = next.slice(0, MAX_STORED_JOBS);
    for (const dropped of next.slice(MAX_STORED_JOBS)) {
      await this.storage.removeItem(jobStorageKey(dropped));
    }
    await this.writeIndex(kept);
  }
}
