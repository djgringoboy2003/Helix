import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';

import { buildDiagnosticReport, diagnosticFileName } from './DiagnosticReport';
import { getFeatureFlags } from '../featureFlags';
import { getNativeSlicerStatus } from '../nativeSlicer';
import { getPrintJobRepository } from '../jobs/AsyncStorageJobStorage';
import { normalizeBuildCommit } from '../updateCheck';

// Gathering a diagnostic report and handing it to the share sheet.
//
// Split from `DiagnosticReport.ts` so the composition and the redaction stay
// testable in the plain Node runner — this half is all platform reach and can
// only be exercised on a device.

export interface ExportContext {
  connectionMode: string;
  printerUrl: string;
  connected: boolean;
  klippyState: string;
  printState?: string | null;
  toolheads?: string[];
  note?: string;
}

/** Builds the report text. Never throws: a missing part is reported as unknown. */
export async function collectDiagnosticReport(context: ExportContext): Promise<string> {
  const slicer = await getNativeSlicerStatus().catch(() => null);
  const active = await getPrintJobRepository()
    .loadActive()
    .catch(() => null);

  const extra = Constants.expoConfig?.extra as { buildCommit?: string } | undefined;

  return buildDiagnosticReport({
    appVersion: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '',
    buildCommit: normalizeBuildCommit(extra?.buildCommit),
    platform: Platform.OS,
    androidRelease: Platform.OS === 'android' ? String(Platform.Version) : null,
    flags: getFeatureFlags(),
    slicer: {
      loaded: slicer?.loaded ?? false,
      coreVersion: slicer?.coreVersion ?? null,
      coreError: slicer?.coreError ?? null,
    },
    printer: {
      connectionMode: context.connectionMode,
      url: context.printerUrl,
      connected: context.connected,
      klippyState: context.klippyState,
      printState: context.printState ?? null,
      toolheads: context.toolheads,
    },
    job: active?.job ?? null,
    note: context.note,
    generatedAt: Date.now(),
  });
}

/**
 * Writes the report to a cache file and opens the share sheet.
 *
 * Returns the text as well, so a caller can show it before it is sent —
 * the report tells the operator to check it over, and that is only meaningful
 * if they can.
 */
export async function exportDiagnosticReport(
  context: ExportContext
): Promise<{ text: string; shared: boolean }> {
  const text = await collectDiagnosticReport(context);
  const target = `${FileSystem.cacheDirectory ?? ''}${diagnosticFileName()}`;

  try {
    await FileSystem.writeAsStringAsync(target, text);
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) return { text, shared: false };
    await Sharing.shareAsync(target, {
      mimeType: 'text/plain',
      dialogTitle: 'Helix diagnostic report',
    });
    return { text, shared: true };
  } catch {
    // The text is still useful even if sharing failed; the caller can display
    // it for copying rather than losing the whole export.
    return { text, shared: false };
  }
}
