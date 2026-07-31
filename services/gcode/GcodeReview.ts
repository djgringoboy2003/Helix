// Reading what the slicer actually produced.
//
// `CLAUDE.md`'s workflow says "preview **actual** G-code", not "show what the
// slicer promised". So everything here is derived from the G-code file itself:
// where material is actually deposited, and what the file says about itself.
//
// Extents are computed from **extruding moves only**. Travel moves legitimately
// run outside the printed object — to a purge area, a wipe tower, a park
// position — so judging the print by every move would reject files that are
// perfectly safe. What matters for "does this fit the bed" is where plastic
// lands.
//
// The scanner is incremental so a caller can feed it a large file in chunks
// without holding it in memory. A sliced plate is routinely tens of megabytes.

export interface PrintExtents {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** Extruding moves seen. Zero means the file deposits nothing. */
  extrudingMoves: number;
}

interface ScannerState {
  x: number;
  y: number;
  z: number;
  e: number;
  absolutePosition: boolean;
  absoluteExtrusion: boolean;
  extents: PrintExtents | null;
  extrudingMoves: number;
}

export interface GcodeScanner {
  /** Feed the next chunk of text. Partial trailing lines are carried over. */
  push(chunk: string): void;
  /** Extents of everything extruded so far, or null if nothing was. */
  result(): PrintExtents | null;
}

const AXIS = /([XYZE])(-?\d*\.?\d+)/g;

function readWord(command: string, axis: string): number | null {
  AXIS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AXIS.exec(command)) !== null) {
    if (match[1] === axis) {
      const value = Number(match[2]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

/**
 * Scans G-code for the region material is deposited in.
 *
 * Handles the state that changes what a coordinate *means*: `G90`/`G91` for
 * positioning, `M82`/`M83` for extrusion, and `G92` for redefining the origin
 * mid-file. Getting `G92 E0` wrong in particular would make every subsequent
 * move look like a retraction and the extents would come out empty.
 */
export function createGcodeScanner(): GcodeScanner {
  const state: ScannerState = {
    x: 0,
    y: 0,
    z: 0,
    e: 0,
    absolutePosition: true,
    absoluteExtrusion: true,
    extents: null,
    extrudingMoves: 0,
  };
  let carry = '';

  const record = (): void => {
    if (!state.extents) {
      state.extents = {
        minX: state.x,
        maxX: state.x,
        minY: state.y,
        maxY: state.y,
        minZ: state.z,
        maxZ: state.z,
        extrudingMoves: 0,
      };
      return;
    }
    const extents = state.extents;
    extents.minX = Math.min(extents.minX, state.x);
    extents.maxX = Math.max(extents.maxX, state.x);
    extents.minY = Math.min(extents.minY, state.y);
    extents.maxY = Math.max(extents.maxY, state.y);
    extents.minZ = Math.min(extents.minZ, state.z);
    extents.maxZ = Math.max(extents.maxZ, state.z);
  };

  const handleLine = (raw: string): void => {
    // Strip comments; a `;` inside G-code is always a comment.
    const line = (raw.split(';')[0] ?? '').trim().toUpperCase();
    if (!line) return;

    if (line.startsWith('G90')) {
      state.absolutePosition = true;
      return;
    }
    if (line.startsWith('G91')) {
      state.absolutePosition = false;
      return;
    }
    if (line.startsWith('M82')) {
      state.absoluteExtrusion = true;
      return;
    }
    if (line.startsWith('M83')) {
      state.absoluteExtrusion = false;
      return;
    }
    if (line.startsWith('G92')) {
      // Redefines the current position without moving. `G92 E0` between every
      // extrusion is what relative-ish Prusa output does.
      const x = readWord(line, 'X');
      const y = readWord(line, 'Y');
      const z = readWord(line, 'Z');
      const e = readWord(line, 'E');
      if (x !== null) state.x = x;
      if (y !== null) state.y = y;
      if (z !== null) state.z = z;
      if (e !== null) state.e = e;
      return;
    }

    const isMove = /^G[01](\s|$)/.test(line);
    if (!isMove) return;

    const x = readWord(line, 'X');
    const y = readWord(line, 'Y');
    const z = readWord(line, 'Z');
    const e = readWord(line, 'E');

    const startedFrom = { x: state.x, y: state.y, z: state.z };

    if (x !== null) state.x = state.absolutePosition ? x : state.x + x;
    if (y !== null) state.y = state.absolutePosition ? y : state.y + y;
    if (z !== null) state.z = state.absolutePosition ? z : state.z + z;

    let extruded = 0;
    if (e !== null) {
      if (state.absoluteExtrusion) {
        extruded = e - state.e;
        state.e = e;
      } else {
        extruded = e;
        state.e += e;
      }
    }

    if (extruded > 0) {
      state.extrudingMoves += 1;
      // Both ends of the extrusion count: the material spans the whole segment,
      // so recording only the destination would under-report the printed area.
      const to = { x: state.x, y: state.y, z: state.z };
      state.x = startedFrom.x;
      state.y = startedFrom.y;
      state.z = startedFrom.z;
      record();
      state.x = to.x;
      state.y = to.y;
      state.z = to.z;
      record();
    }
  };

  return {
    push(chunk: string) {
      const text = carry + chunk;
      const lines = text.split('\n');
      // The last element may be a partial line; hold it for the next chunk.
      carry = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    },
    result() {
      if (carry) {
        handleLine(carry);
        carry = '';
      }
      if (!state.extents) return null;
      return { ...state.extents, extrudingMoves: state.extrudingMoves };
    },
  };
}

/** Convenience for a whole file already in memory, and for tests. */
export function scanGcode(text: string): PrintExtents | null {
  const scanner = createGcodeScanner();
  scanner.push(text);
  return scanner.result();
}

// --- metadata --------------------------------------------------------------

export interface GcodeMetadata {
  /** Every `; key = value` and `; key: value` pair, lower-cased keys. */
  values: Record<string, string>;
  layerCount: number | null;
  layerHeight: number | null;
  nozzleDiameter: number | null;
  printerModel: string | null;
  filamentTypes: string[];
  filamentColors: string[];
  estimatedSeconds: number | null;
  filamentGrams: number | null;
  hasThumbnail: boolean;
}

const DURATION = /(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i;

/** `1h 2m 3s`, `2d 4h`, or a bare number of seconds. */
export function parseDurationSeconds(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  const match = DURATION.exec(text);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

function firstNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /-?\d+(\.\d+)?/.exec(raw);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/** Splits `PLA;PETG` or `PLA,PETG` into a list. */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * Reads the comment blocks Orca and PrusaSlicer write.
 *
 * These are the slicer's own claims about the file, which is exactly why they
 * are kept separate from the extents: the summary shown to an operator says
 * what the file *declares*, while "does it fit the bed" is answered by what the
 * file actually *does*.
 */
export function parseGcodeMetadata(text: string): GcodeMetadata {
  const values: Record<string, string> = {};
  let hasThumbnail = false;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(';')) continue;
    const body = line.slice(1).trim();
    if (!body) continue;
    if (body.toLowerCase().startsWith('thumbnail begin')) hasThumbnail = true;

    const equals = body.indexOf('=');
    const colon = body.indexOf(':');
    const useEquals = equals > 0 && (colon < 0 || equals < colon);
    const at = useEquals ? equals : colon;
    if (at <= 0) continue;

    const key = body.slice(0, at).trim().toLowerCase();
    const value = body.slice(at + 1).trim();
    if (!key || key.includes(' begin') || key.includes(' end')) continue;
    // First writing wins: Orca repeats some keys per-object later in the file.
    if (!(key in values)) values[key] = value;
  }

  const estimatedRaw =
    values['total estimated time'] ??
    values['model printing time'] ??
    values['estimated printing time (normal mode)'];

  return {
    values,
    layerCount: firstNumber(values['total layer number'] ?? values['layer_num']),
    layerHeight: firstNumber(values['layer_height']),
    nozzleDiameter: firstNumber(values['nozzle_diameter']),
    printerModel: values['printer_model'] ?? null,
    filamentTypes: splitList(values['filament_type']),
    filamentColors: splitList(values['filament_colour'] ?? values['filament_color']),
    estimatedSeconds: estimatedRaw ? parseDurationSeconds(estimatedRaw) : null,
    filamentGrams: firstNumber(
      values['total filament used [g]'] ?? values['filament used [g]']
    ),
    hasThumbnail,
  };
}
