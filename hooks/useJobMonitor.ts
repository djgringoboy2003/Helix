import { useEffect, useRef, useState } from 'react';

import { advanceJob, isJobLive, type PrinterSnapshot } from '../services/jobs/JobMonitor';
import { getPrintJobRepository } from '../services/jobs/AsyncStorageJobStorage';
import type { PrintJob } from '../services/jobs/PrintJobTypes';

// Keeping the job record honest while a print runs.
//
// The app already shows live progress, temperatures and an ETA straight from
// Moonraker — none of that needs a job record and none of it is changed here.
// What was missing is that the *record* stopped at `printing`, so the audit
// trail said what the operator agreed to and never what happened. This closes
// that loop and nothing else.
//
// Deliberately cheap: it reacts to the status the app is already subscribed to
// rather than polling on its own, writes only when the job actually moves, and
// stops watching once there is nothing left to observe.

export function useJobMonitor(snapshot: PrinterSnapshot): PrintJob | null {
  const [job, setJob] = useState<PrintJob | null>(null);
  const loaded = useRef(false);
  // Guards against two status updates arriving before the first write lands and
  // both advancing the same job.
  const writing = useRef(false);

  // Pick up whatever was in flight when the app last closed. Recovery rules
  // live in the repository and already fail closed, so this reads whatever they
  // decided rather than second-guessing it.
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    getPrintJobRepository()
      .loadActive()
      .then((outcome) => {
        if (!outcome) return;
        setJob(outcome.job);
        if (outcome.recovered) getPrintJobRepository().save(outcome.job).catch(() => {});
      })
      .catch(() => {
        // A job that cannot be read must not stop the dashboard rendering.
      });
  }, []);

  useEffect(() => {
    if (!isJobLive(job) || !job || writing.current) return;

    const outcome = advanceJob(job, snapshot, Date.now());
    if (!outcome.changed) return;

    writing.current = true;
    setJob(outcome.job);
    getPrintJobRepository()
      .save(outcome.job)
      .catch(() => {})
      .finally(() => {
        writing.current = false;
      });
  }, [job, snapshot]);

  return job;
}
