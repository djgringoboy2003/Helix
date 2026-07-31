import {
  planU1Preparation,
  type ConversionReport,
  type ProjectSettings,
} from './U1ProjectPreparer';

// Running a preparation: read the foreign profile, plan the retarget, apply it.
//
// The policy lives in `U1ProjectPreparer`; the ZIP rewrite lives in Kotlin
// (`U1ProjectRewriter`, which uses `java.util.zip` rather than a hand-written
// inflate). This is the seam that joins them, written against an interface so
// the sequencing and the failure rules are testable without a device.
//
// The rule that matters most here is that **failure is never silent**. A file
// that could not be retargeted must not reach the slicer looking like one that
// was: `CLAUDE.md` forbids foreign machine G-code and dimensions from surviving,
// and "the rewrite threw, so we carried on with the original" is exactly how
// they would.

export interface PrepareIo {
  readProjectSettings(filePath: string): Promise<string | null>;
  getU1PrinterProfile(): Promise<string>;
  prepareForU1(filePath: string, planJson: string): Promise<string>;
}

export type PreparationOutcome =
  | { status: 'prepared'; filePath: string; report: ConversionReport }
  /** Nothing to retarget. The original file is used unchanged, and safely. */
  | { status: 'not-needed'; filePath: string; reason: string }
  | { status: 'failed'; message: string; report: ConversionReport | null };

export interface PrepareRequest {
  filePath: string;
  /** Only a 3MF can carry a foreign machine profile. */
  isArchive: boolean;
  /** Sliced output found at import, which must not survive retargeting. */
  slicedOutputPaths?: readonly string[];
}

/** Parsed config, or null when the text is not a usable settings object. */
function parseSettings(text: string | null): ProjectSettings | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const settings: ProjectSettings = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        settings[key] = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        settings[key] = value as string[];
      }
      // Anything else is a shape this config format does not use; dropping it
      // is safe because the U1's own values are written over the top regardless.
    }
    return settings;
  } catch {
    return null;
  }
}

/**
 * Retargets one file for the U1, if it needs it.
 *
 * A mesh, or a 3MF with no embedded project settings, is reported as
 * `not-needed` rather than rewritten. Those files have no foreign machine
 * profile, and the native slice path already supplies the U1's own machine
 * G-code for them — writing a profile in would switch them onto a different code
 * path in the engine for no gain.
 */
export async function runU1Preparation(
  request: PrepareRequest,
  io: PrepareIo
): Promise<PreparationOutcome> {
  if (!request.isArchive) {
    return {
      status: 'not-needed',
      filePath: request.filePath,
      reason: 'A mesh carries no machine profile, so there is nothing to retarget.',
    };
  }

  let foreignText: string | null;
  try {
    foreignText = await io.readProjectSettings(request.filePath);
  } catch (error) {
    return { status: 'failed', message: describe(error), report: null };
  }

  const foreign = parseSettings(foreignText);
  if (!foreign) {
    // Either there is no config, or it is not readable as one. Both mean no
    // foreign machine profile is present to strip.
    return {
      status: 'not-needed',
      filePath: request.filePath,
      reason: 'This file carries no other machine’s profile, so there is nothing to retarget.',
    };
  }

  let u1Profile: ProjectSettings | null;
  try {
    u1Profile = parseSettings(await io.getU1PrinterProfile());
  } catch (error) {
    return { status: 'failed', message: describe(error), report: null };
  }
  if (!u1Profile) {
    return {
      status: 'failed',
      message: 'The bundled Snapmaker U1 profile could not be read, so this file cannot be retargeted.',
      report: null,
    };
  }

  const plan = planU1Preparation(foreign, u1Profile, {
    ...(request.slicedOutputPaths ? { slicedOutputPaths: request.slicedOutputPaths } : {}),
  });

  if (!plan.report.ok) {
    return { status: 'failed', message: plan.report.blockers[0], report: plan.report };
  }

  try {
    const filePath = await io.prepareForU1(
      request.filePath,
      JSON.stringify({
        apply: plan.apply,
        remove: plan.remove,
        removeEntries: plan.removeEntries,
      })
    );
    if (!filePath) {
      return {
        status: 'failed',
        message: 'The retargeted project file was not written.',
        report: plan.report,
      };
    }
    return { status: 'prepared', filePath, report: plan.report };
  } catch (error) {
    return { status: 'failed', message: describe(error), report: plan.report };
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    ? `This file could not be retargeted for the U1: ${message}`
    : 'This file could not be retargeted for the U1.';
}

/** Summary line for the Slice tab, or null when there is nothing worth saying. */
export function summarizeReport(report: ConversionReport): string | null {
  const parts: string[] = [];
  if (report.replaced > 0) parts.push(`${report.replaced} machine settings replaced`);
  if (report.removed > 0) parts.push(`${report.removed} removed`);
  if (report.clamped > 0) parts.push(`${report.clamped} brought into range`);
  return parts.length > 0 ? `Retargeted for the U1: ${parts.join(', ')}.` : null;
}
