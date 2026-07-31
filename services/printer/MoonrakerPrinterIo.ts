import { api, type FileEntry } from '../moonraker';
import { uploadGcodeToPrinter } from '../nativeSlicer';
import { readLoadedSlots, type AceHeadSource, type LoadedSlot } from '../filament/FilamentSlots';
import type { PrinterReadiness, RemoteFile, UploadIo } from '../upload/UploadService';
import type { StartIo } from '../start/StartService';

// Moonraker behind the upload and start service interfaces.
//
// `UploadService` and `StartService` are written against small interfaces so
// their rules can be tested without a printer or a React Native runtime. This is
// the one file that knows Moonraker actually answers them, which is why both
// adapters live here rather than beside their services: the endpoints, the
// readiness fields and the U1's `SET_PRINT_*` vocabulary are one body of
// knowledge and drift together.
//
// Everything here is deliberately thin. No decision is taken in this file —
// a value the printer will not supply comes back as `null`, and what that means
// is the service's call.

/**
 * Connection and firmware state.
 *
 * `klippy_state` is Moonraker's own word for whether Klipper is usable;
 * `print_stats.state` is what it is doing. Either being absent yields `null`
 * rather than an assumption, and both services fail closed on that.
 */
export async function readPrinterReadiness(base: string): Promise<PrinterReadiness> {
  const info = await api.serverInfo(base);
  const klippyState = typeof info?.klippy_state === 'string' ? info.klippy_state : '';
  const connected = info?.klippy_connected !== false;

  let printState: string | null = null;
  try {
    const query = await api.queryObjects<{ print_stats?: { state?: string } }>(base, ['print_stats']);
    const state = query.status?.print_stats?.state;
    printState = typeof state === 'string' && state.trim() ? state : null;
  } catch {
    printState = null;
  }

  return { connected, klippyReady: klippyState === 'ready', printState };
}

function toRemoteFile(entry: FileEntry): RemoteFile {
  return { path: entry.path, size: entry.size, modified: entry.modified };
}

export async function listPrinterGcodes(base: string): Promise<RemoteFile[]> {
  const entries = await api.listFiles(base);
  return Array.isArray(entries) ? entries.map(toRemoteFile) : [];
}

/**
 * Free space on the printer's G-code volume.
 *
 * Moonraker reports it alongside a directory listing. Builds that omit
 * `disk_usage` return `null`, which `UploadService` treats as "unknown" and
 * deliberately does not fail closed on — a printer that cannot report space is
 * common, and refusing every upload on it would make the app unusable.
 */
export async function readFreeSpaceBytes(base: string): Promise<number | null> {
  try {
    const info = await api.directoryInfo(base, 'gcodes');
    const free = info?.disk_usage?.free;
    return typeof free === 'number' && Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

export function createUploadIo(base: string, statLocal: (path: string) => Promise<number | null>): UploadIo {
  return {
    readReadiness: () => readPrinterReadiness(base),
    listFiles: () => listPrinterGcodes(base),
    freeSpaceBytes: () => readFreeSpaceBytes(base),
    statLocal,

    async upload(filename, gcodePath) {
      await uploadGcodeToPrinter(base, filename, gcodePath);

      // The native and fetch upload paths report success differently, and
      // neither reliably returns a stored size. The printer's own listing is
      // the authority on what landed, so the size is read back from there —
      // which is also what `uploadSlicedGcode` compares with the reviewed size.
      let sizeBytes: number | null = null;
      try {
        const files = await listPrinterGcodes(base);
        const stored = files.find((file) => file.path === filename);
        sizeBytes = stored ? stored.size : null;
      } catch {
        sizeBytes = null;
      }
      return { status: 200, sizeBytes };
    },
  };
}

/**
 * The preferences the printer currently has armed.
 *
 * Read so a reprint can re-send what is already set rather than silently
 * turning something off. Anything the printer does not report comes back false,
 * which is the safe reading: an unarmed preference does nothing, while claiming
 * one is on when it is not would mislead the operator on the approval screen.
 */
export async function readPrintPreferences(
  base: string
): Promise<{ autoLevel: boolean; timelapse: boolean; flowCal: boolean }> {
  try {
    const query = await api.queryObjects<{
      print_task_config?: {
        auto_bed_leveling?: boolean;
        time_lapse_camera?: boolean;
        flow_calibrate?: boolean;
      };
    }>(base, ['print_task_config']);
    const config = query.status?.print_task_config;
    return {
      autoLevel: config?.auto_bed_leveling === true,
      timelapse: config?.time_lapse_camera === true,
      flowCal: config?.flow_calibrate === true,
    };
  } catch {
    return { autoLevel: false, timelapse: false, flowCal: false };
  }
}

export interface StartIoOptions {
  /** ACE head readings, when a multiACE unit is present. */
  headSources?: readonly (AceHeadSource | null)[];
  /** Print preferences as the operator set them for this job. */
  prefs: { autoLevel: boolean; timelapse: boolean; flowCal: boolean };
}

export function createStartIo(base: string, options: StartIoOptions): StartIo {
  return {
    readReadiness: () => readPrinterReadiness(base),
    listFiles: () => listPrinterGcodes(base),

    async readLoadedSlots(): Promise<LoadedSlot[]> {
      const query = await api.queryObjects<{ print_task_config?: unknown }>(base, [
        'print_task_config',
      ]);
      return readLoadedSlots(query.status?.print_task_config, options.headSources ?? []);
    },

    applyPrintSetup: (usedToolheads) => applyPrintSetup(base, usedToolheads, options.prefs),

    startPrint: async (filename) => {
      await api.startPrint(base, filename);
    },
  };
}

/**
 * Sends the toolhead map and print preferences, then reads them back.
 *
 * The read-back is not belt and braces: the firmware caches these per printer,
 * so a command that was silently ignored leaves the *previous* print's settings
 * armed. Verifying is the only way to know the job about to start is the job
 * that was approved. Anything unexpected throws, and `StartService` treats that
 * as "nothing was started".
 */
export async function applyPrintSetup(
  base: string,
  usedToolheads: readonly number[],
  prefs: { autoLevel: boolean; timelapse: boolean; flowCal: boolean }
): Promise<void> {
  const script = [
    'SET_MAIN_STATE MAIN_STATE=IDLE',
    `SET_PRINT_USED_EXTRUDERS EXTRUDERS=${usedToolheads.join(',')}`,
    `SET_PRINT_PREFERENCES BED_LEVEL=${prefs.autoLevel ? 1 : 0}` +
      ` TIME_LAPSE_CAMERA=${prefs.timelapse ? 1 : 0}` +
      ` FLOW_CALIBRATE=${prefs.flowCal ? 1 : 0} FLOW_CALIBRATE_EXTRUDERS=0,1,2,3`,
  ].join('\n');
  await api.runGcode(base, script);

  const applied = await api.queryObjects<{
    print_task_config?: {
      auto_bed_leveling?: boolean;
      time_lapse_camera?: boolean;
      flow_calibrate?: boolean;
      flow_calib_extruders?: boolean[];
      extruders_used?: boolean[];
    };
  }>(base, ['print_task_config']);

  const config = applied.status?.print_task_config;
  if (!config) throw new Error('The printer reported no print settings back.');
  if (
    config.auto_bed_leveling !== prefs.autoLevel ||
    config.time_lapse_camera !== prefs.timelapse ||
    config.flow_calibrate !== prefs.flowCal ||
    config.flow_calib_extruders?.length !== 4 ||
    !config.flow_calib_extruders.every(Boolean)
  ) {
    throw new Error('The printer rejected the selected print preferences.');
  }
  if (
    config.extruders_used?.length !== 4 ||
    !config.extruders_used.every((used, tool) => used === usedToolheads.includes(tool))
  ) {
    throw new Error('The printer did not accept the toolhead mapping.');
  }
}
