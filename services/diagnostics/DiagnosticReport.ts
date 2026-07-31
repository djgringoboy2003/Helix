import { describeEndpoint, fileNameOnly, redactSensitive } from './Redaction';
// From `Sha256` rather than `FileHash`: the latter reaches the file system and
// so drags react-native into the plain Node test runner. `shortHash` is pure.
import { shortHash } from '../security/Sha256';
import type { FeatureFlags } from '../featureFlags';
import type { PrintJob } from '../jobs/PrintJobTypes';

// The report an operator pastes into a bug report.
//
// Two rules shape it. It has to contain enough to diagnose a refused print
// without a back-and-forth — which state the job reached, which gate said no,
// what the printer was reporting. And it must not contain anything
// `CLAUDE.md` forbids in a log: no passwords, cookies, tokens or private IP
// details.
//
// Those pull against each other, and the resolution is that the report names
// *shapes* rather than values. "printer: http://<ip>:7125, connected" answers
// the question that matters; the address itself never does.
//
// The whole report is passed through `redactSensitive` at the end regardless.
// Composing it carefully is the first defence; the sweep is the one that still
// works when somebody adds a field in a hurry.

export interface DiagnosticInput {
  appVersion: string;
  buildCommit: string;
  platform: string;
  androidRelease?: string | null;
  flags: FeatureFlags;
  slicer: {
    loaded: boolean;
    coreVersion?: string | null;
    coreError?: string | null;
  };
  printer: {
    connectionMode: string;
    url: string;
    connected: boolean;
    klippyState: string;
    printState?: string | null;
    /** Toolhead readings, already reduced to status words by the caller. */
    toolheads?: string[];
  };
  /** The job in flight, when there is one. */
  job?: PrintJob | null;
  /** Free-form note the operator typed. Redacted like everything else. */
  note?: string;
  generatedAt: number;
}

/** Job events worth including; the rest is noise in a bug report. */
const MAX_EVENTS = 25;

export function buildDiagnosticReport(input: DiagnosticInput): string {
  const lines: string[] = [];
  const add = (label: string, value: string | number | boolean) =>
    lines.push(`${label}: ${value}`);

  lines.push('# Helix diagnostic report');
  lines.push('');
  lines.push(
    'Addresses, tokens and file paths are removed automatically. Check it over ' +
      'before posting it anywhere.'
  );
  lines.push('');

  lines.push('## App');
  add('version', input.appVersion || 'unknown');
  add('build', input.buildCommit || 'unknown');
  add('platform', input.platform + (input.androidRelease ? ` ${input.androidRelease}` : ''));
  add('generated', new Date(input.generatedAt).toISOString());
  lines.push('');

  lines.push('## Slicer');
  add('native library loaded', input.slicer.loaded);
  add('core version', input.slicer.coreVersion || 'unknown');
  if (input.slicer.coreError) add('core error', input.slicer.coreError);
  lines.push('');

  lines.push('## Printer');
  add('connection mode', input.printer.connectionMode || 'unknown');
  add('endpoint', describeEndpoint(input.printer.url));
  add('connected', input.printer.connected);
  add('klippy', input.printer.klippyState || 'unknown');
  add('print state', input.printer.printState ?? 'not reported');
  if (input.printer.toolheads?.length) {
    add('toolheads', input.printer.toolheads.join(', '));
  }
  lines.push('');

  lines.push('## Feature flags');
  for (const [name, value] of Object.entries(input.flags)) add(name, value);
  lines.push('');

  lines.push('## Job');
  if (!input.job) {
    lines.push('no job in flight');
  } else {
    lines.push(...describeJob(input.job));
  }
  lines.push('');

  if (input.note?.trim()) {
    lines.push('## Note');
    lines.push(input.note.trim());
    lines.push('');
  }

  // Everything, unconditionally. A value that slipped through the composition
  // above is caught here.
  return redactSensitive(lines.join('\n')).trimEnd() + '\n';
}

function describeJob(job: PrintJob): string[] {
  const lines: string[] = [];
  const add = (label: string, value: string | number | boolean) =>
    lines.push(`${label}: ${value}`);

  add('state', job.state);
  add('revision', job.revision);
  // Names, never paths — the report should say which file, not where it lives.
  add('uploaded file', job.uploadedFilename ? fileNameOnly(job.uploadedFilename) : 'none');
  add('gcode sha256', job.gcodeSha256 ? shortHash(job.gcodeSha256) : 'none');

  const mapping = job.filamentMapping;
  if (mapping) {
    add('mapping confirmed', mapping.confirmedAt !== null);
    for (const slot of mapping.slots) {
      lines.push(
        `  source ${slot.sourceIndex} (${slot.sourceMaterial || '?'} ${slot.sourceColor || '?'})` +
          ` -> T${slot.toolhead ?? '?'} (${slot.loadedMaterial || '?'} ${slot.loadedColor || '?'})`
      );
    }
  } else {
    add('mapping', 'none');
  }

  // The approval is described, never reproduced: its hashes identify the job
  // and are already short, but reprinting the record wholesale would put a
  // filename and a printer id in a file destined for a public issue tracker.
  if (job.startApproval) {
    add('approval revision', job.startApproval.jobRevision);
    add('approval expires in', `${Math.round((job.startApproval.expiresAt - Date.now()) / 1000)}s`);
  } else {
    add('approval', 'none');
  }

  if (job.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of job.warnings) {
      lines.push(`  [${warning.level}] ${warning.code}: ${warning.message}`);
    }
  }

  const events = job.events.slice(-MAX_EVENTS);
  if (events.length > 0) {
    lines.push(`events (last ${events.length} of ${job.events.length}):`);
    for (const event of events) {
      const at = new Date(event.at).toISOString().slice(11, 19);
      lines.push(`  ${at} ${event.type}: ${event.detail}`);
    }
  }

  return lines;
}

/** Filename for the exported report; no timestamp collisions within a second. */
export function diagnosticFileName(at: number = Date.now()): string {
  return `helix-diagnostic-${new Date(at).toISOString().replace(/[:.]/g, '-')}.txt`;
}
