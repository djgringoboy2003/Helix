import { useCallback, useState } from 'react';

import { getU1PrinterProfile } from '../services/nativeSlicer';
import { buildVolumeOf } from '../services/prepare/U1ProjectPreparer';
import { readLoadedSlots } from '../services/filament/FilamentSlots';
import { api } from '../services/moonraker';
import { createStartIo, readPrintPreferences } from '../services/printer/MoonrakerPrinterIo';
import {
  discardRemoteCopy,
  reviewPrinterGcode,
} from '../services/start/RemoteGcode';
import {
  buildFilamentMapping,
  buildStartJob,
  newJobId,
  reprintMappingSources,
} from '../services/start/StartJob';
import {
  startApprovedPrint,
  type UploadedFileFingerprint,
} from '../services/start/StartService';
import { createStartApproval } from '../services/jobs/ApprovalService';
import { grantStartApproval } from '../services/jobs/PrintJobMachine';
import { getPrintJobRepository } from '../services/jobs/AsyncStorageJobStorage';
import type { PrintJob } from '../services/jobs/PrintJobTypes';
import type { SliceReview } from '../services/gcode/SliceReview';
import type { StartApprovalResult } from '../components/StartApprovalDialog';

// Approving a file that is already on the printer.
//
// Reprinting used to be one call to `printer/print/start`. The safety rules do
// not have a "this one is fine, we printed it before" exemption: a start binds
// to a G-code SHA-256, and the only way to have one for a file the app did not
// produce is to read the file back and hash it.
//
// That download is the expensive part and it is deliberate. It also buys the
// extent check, which matters more here than on a fresh slice — a file of
// unknown origin is exactly where a toolpath outside the bed would come from.
//
// Both reprint entry points share this because they need identical behaviour
// and the difference between them is only which toolheads the operator picked.

export type ReprintStage = 'idle' | 'preparing' | 'awaiting' | 'starting';

export interface ReprintApprovalState {
  stage: ReprintStage;
  /** 0–1 while the file is being pulled back for review. */
  progress: number;
  message: string | null;
  error: string | null;
  job: PrintJob | null;
  review: SliceReview | null;
  filename: string | null;
}

export interface PrepareReprintInput {
  baseUrl: string;
  printerId: string;
  /** Path as Moonraker lists it. This exact name is what will be started. */
  remotePath: string;
  /**
   * File tool to physical toolhead. Omitted means identity — the file drives
   * the heads it was sliced for.
   */
  assignments?: Record<number, number>;
  /** Overrides the printer's currently armed preferences when supplied. */
  prefs?: { autoLevel: boolean; timelapse: boolean; flowCal: boolean };
}

const IDLE: ReprintApprovalState = {
  stage: 'idle',
  progress: 0,
  message: null,
  error: null,
  job: null,
  review: null,
  filename: null,
};

export function useReprintApproval() {
  const [state, setState] = useState<ReprintApprovalState>(IDLE);
  const [context, setContext] = useState<{
    baseUrl: string;
    printerId: string;
    uploaded: UploadedFileFingerprint;
    prefs: { autoLevel: boolean; timelapse: boolean; flowCal: boolean };
    localPath: string;
  } | null>(null);

  const reset = useCallback(() => {
    if (context) discardRemoteCopy(context.localPath).catch(() => {});
    setContext(null);
    setState(IDLE);
  }, [context]);

  const prepare = useCallback(async (input: PrepareReprintInput) => {
    setState({ ...IDLE, stage: 'preparing', message: 'Reading the file back from the printer…' });
    try {
      const volume = buildVolumeOf(
        JSON.parse(await getU1PrinterProfile()) as Record<string, string | string[]>,
      );
      if (!volume) throw new Error('The U1 build volume could not be read.');

      // What the printer says it holds, captured before the review so the
      // fingerprint describes the same listing the bytes were read from.
      const files = await api.listFiles(input.baseUrl);
      const listed = files.find((file) => file.path === input.remotePath);
      if (!listed) throw new Error(`${input.remotePath} is not on the printer.`);

      const { review, localPath } = await reviewPrinterGcode({
        baseUrl: input.baseUrl,
        remotePath: input.remotePath,
        volume,
        expectedPrinterModel: 'Snapmaker U1',
        onProgress: (fraction) => setState((current) => ({ ...current, progress: fraction })),
      });

      if (!review.ok) {
        const blocking = review.findings.find((finding) => finding.severity === 'blocking');
        await discardRemoteCopy(localPath);
        setState({
          ...IDLE,
          error: blocking?.message ?? 'This file did not pass review, so it will not be printed.',
        });
        return;
      }

      const query = await api.queryObjects<{ print_task_config?: unknown }>(input.baseUrl, [
        'print_task_config',
      ]);
      const loaded = readLoadedSlots(query.status?.print_task_config, []);

      const sources = reprintMappingSources(review);
      if (sources.length === 0) {
        await discardRemoteCopy(localPath);
        setState({ ...IDLE, error: 'This file does not extrude with any toolhead.' });
        return;
      }
      const targets = Object.fromEntries(
        sources.map((source) => [
          source.sourceIndex,
          input.assignments?.[source.sourceIndex] ?? source.sourceIndex,
        ]),
      );

      const job = buildStartJob({
        id: newJobId(),
        modelId: input.remotePath,
        printerId: input.printerId,
        gcodeArtifactId: localPath,
        gcodeSha256: review.sha256,
        uploadedFilename: input.remotePath,
        filamentMapping: buildFilamentMapping(sources, targets, loaded, Date.now()),
        at: Date.now(),
      });
      await getPrintJobRepository().save(job).catch(() => {});

      setContext({
        baseUrl: input.baseUrl,
        printerId: input.printerId,
        localPath,
        prefs: input.prefs ?? (await readPrintPreferences(input.baseUrl)),
        uploaded: {
          filename: input.remotePath,
          sizeBytes: listed.size,
          modified: typeof listed.modified === 'number' ? listed.modified : null,
        },
      });
      setState({
        stage: 'awaiting',
        progress: 1,
        message: null,
        error: null,
        job,
        review,
        filename: input.remotePath,
      });
    } catch (error) {
      setState({
        ...IDLE,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const confirm = useCallback(async (result: StartApprovalResult) => {
    if (!context || !state.job || !state.review) return;
    setState((current) => ({ ...current, stage: 'starting', message: 'Checking the printer…', error: null }));

    try {
      const at = Date.now();
      const approved = grantStartApproval(
        state.job,
        createStartApproval({
          job: state.job,
          printerId: context.printerId,
          filename: context.uploaded.filename,
          gcodeSha256: state.review.sha256,
          approvedAt: at,
        }),
        at,
      );
      await getPrintJobRepository().save(approved).catch(() => {});

      const outcome = await startApprovedPrint(
        {
          job: approved,
          activePrinterId: context.printerId,
          uploaded: context.uploaded,
          cameraFrame: result.cameraFrame,
          operatorConfirmedBedClear: result.bedClear,
          now: Date.now(),
        },
        createStartIo(context.baseUrl, { prefs: context.prefs }),
      );
      await getPrintJobRepository().save(outcome.job).catch(() => {});

      if (outcome.status !== 'started') {
        const detail = outcome.failures.map((failure) => failure.message).join(' ');
        const message = `${outcome.message} ${detail}`.trim();
        // An uncertain outcome is not something to retry past: the job is over
        // either way, and the operator has to look at the machine.
        if (outcome.uncertain) {
          await discardRemoteCopy(context.localPath);
          setContext(null);
          setState({ ...IDLE, error: message });
          return;
        }
        setState((current) => ({ ...current, stage: 'awaiting', message: null, error: message }));
        return;
      }

      await discardRemoteCopy(context.localPath);
      setContext(null);
      setState(IDLE);
      return outcome.filename;
    } catch (error) {
      setState((current) => ({
        ...current,
        stage: 'awaiting',
        message: null,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return undefined;
  }, [context, state.job, state.review]);

  return { state, prepare, confirm, reset };
}
