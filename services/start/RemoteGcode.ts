import * as FileSystem from 'expo-file-system/legacy';

import { fileUrl } from '../moonraker';
import { expoGcodeIo } from '../gcode/ExpoGcodeIo';
import { reviewSlicedGcode, type SliceReview } from '../gcode/SliceReview';
import type { BuildVolume } from '../prepare/U1ProjectPreparer';

// Reviewing a file that is already on the printer.
//
// The reprint paths — Home's "print that again" and the Files tab — start from
// a file this app may never have produced. It could have come from another
// slicer, another machine, or a version of this app from before the G-code
// review existed. `CLAUDE.md` still requires the start approval to bind to a
// SHA-256 of the exact bytes that will print, and there is only one honest way
// to get that: pull the file back and hash it.
//
// The download is not overhead, it is the check. Running the same extent scan
// over a file of unknown origin is worth more than running it over one this app
// just sliced — a foreign file is precisely where a toolpath outside the bed
// would come from.

export interface RemoteGcodeReview {
  review: SliceReview;
  /** Where the copy landed. Kept so the caller can clear it afterwards. */
  localPath: string;
}

export interface RemoteGcodeRequest {
  baseUrl: string;
  /** Path as Moonraker lists it, e.g. `folder/part.gcode`. */
  remotePath: string;
  volume: BuildVolume;
  expectedPrinterModel?: string;
  /** 0–1, for a progress bar during what can be a 40 MB pull. */
  onProgress?: (fraction: number) => void;
}

/**
 * Downloads a printer-held file and reviews it.
 *
 * A failed download produces a blocking review rather than a thrown error, so
 * the caller has one shape to render either way and cannot accidentally treat
 * "could not check" as "checked and fine".
 */
export async function reviewPrinterGcode(
  request: RemoteGcodeRequest
): Promise<RemoteGcodeReview> {
  const localPath = `${FileSystem.cacheDirectory ?? ''}helix-approve-${Date.now()}.gcode`;
  const source = fileUrl(request.baseUrl, 'gcodes', request.remotePath);

  try {
    const download = FileSystem.createDownloadResumable(
      source,
      localPath,
      {},
      (progress) => {
        const total = progress.totalBytesExpectedToWrite;
        if (request.onProgress && total > 0) {
          request.onProgress(Math.min(1, progress.totalBytesWritten / total));
        }
      }
    );
    const result = await download.downloadAsync();
    if (!result || result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result?.status ?? 0}`);
    }
  } catch {
    return {
      localPath,
      review: {
        filePath: localPath,
        sizeBytes: 0,
        sha256: '',
        extents: null,
        metadata: {
          values: {},
          layerCount: null,
          layerHeight: null,
          nozzleDiameter: null,
          printerModel: null,
          filamentTypes: [],
          filamentColors: [],
          estimatedSeconds: null,
          filamentGrams: null,
          hasThumbnail: false,
        },
        findings: [
          {
            code: 'gcode/unreadable',
            severity: 'blocking',
            message:
              'The file could not be read back from the printer, so it cannot be approved for printing.',
          },
        ],
        ok: false,
      },
    };
  }

  const review = await reviewSlicedGcode(
    {
      filePath: localPath,
      volume: request.volume,
      expectedPrinterModel: request.expectedPrinterModel,
    },
    expoGcodeIo
  );
  return { review, localPath };
}

/** Best-effort cleanup; a leftover cache copy is not worth failing a print over. */
export async function discardRemoteCopy(localPath: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(localPath, { idempotent: true });
  } catch {
    // Ignored on purpose.
  }
}
