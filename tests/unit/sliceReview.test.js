const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  createGcodeScanner,
  parseDurationSeconds,
  parseGcodeMetadata,
  scanGcode,
} = require(servicePath('gcode', 'GcodeReview.ts'));
const {
  BED_TOLERANCE_MM,
  checkBounds,
  criticalSettings,
  reviewSlicedGcode,
} = require(servicePath('gcode', 'SliceReview.ts'));
const { bytesToUtf8, utf8ToBytes } = require(servicePath('security', 'Base64.ts'));

const U1_VOLUME = { width: 271, depth: 272, height: 270 };

// --- the extent scanner ----------------------------------------------------

test('extents cover both ends of every extruding move', () => {
  // Recording only destinations would miss the span the material covers.
  const extents = scanGcode(['G90', 'M82', 'G1 X10 Y10 Z0.2', 'G1 X50 Y60 E5'].join('\n'));

  assert.equal(extents.minX, 10);
  assert.equal(extents.maxX, 50);
  assert.equal(extents.minY, 10);
  assert.equal(extents.maxY, 60);
  assert.equal(extents.extrudingMoves, 1);
});

test('travel moves are excluded, so a purge or park does not widen the print', () => {
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X250 Y250 F9000', 'G1 X10 Y10 Z0.2', 'G1 X20 Y20 E1'].join('\n')
  );

  assert.equal(extents.maxX, 20);
  assert.equal(extents.maxY, 20);
});

test('a file that never extrudes reports nothing', () => {
  assert.equal(scanGcode(['G90', 'G1 X10 Y10', 'G1 X20 Y20'].join('\n')), null);
});

test('retractions are not extrusions', () => {
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X10 Y10 E5', 'G1 X200 Y200 E4', 'G1 X250 Y250 E3'].join('\n')
  );

  // E falls on both later moves, so they retract while travelling and none of
  // that distance is printed.
  assert.equal(extents.maxX, 10);
  assert.equal(extents.extrudingMoves, 1);
});

test('material laid while travelling counts from where the head already was', () => {
  // A move that extrudes deposits along its whole length, so its start point is
  // printed area even though the head arrived there on a travel move. Recording
  // only destinations would under-report the footprint.
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X10 Y10 E1', 'G1 X200 Y200', 'G1 X20 Y20 E5'].join('\n')
  );
  assert.equal(extents.maxX, 200);
});

test('relative extrusion is understood', () => {
  const extents = scanGcode(['G90', 'M83', 'G1 X10 Y10 E0.5', 'G1 X30 Y30 E0.5'].join('\n'));
  assert.equal(extents.maxX, 30);
  assert.equal(extents.extrudingMoves, 2);
});

test('relative positioning is understood', () => {
  const extents = scanGcode(
    ['G91', 'M83', 'G1 X10 Y10 E1', 'G1 X10 Y10 E1', 'G1 X10 Y10 E1'].join('\n')
  );
  assert.equal(extents.maxX, 30);
  assert.equal(extents.maxY, 30);
});

test('G92 redefines position without extruding', () => {
  // `G92 E0` between extrusions is routine; treating it as a move would make
  // every following extrusion look like a retraction and empty the extents.
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X10 Y10 E5', 'G92 E0', 'G1 X40 Y40 E5'].join('\n')
  );

  assert.equal(extents.maxX, 40);
  assert.equal(extents.extrudingMoves, 2);
});

test('G92 on an axis moves the origin for later coordinates', () => {
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X10 Y10 E1', 'G92 X0 Y0', 'G1 X10 Y10 E2'].join('\n')
  );
  // After the reset, X10 is 10 from the new origin, which was the old X10.
  assert.equal(extents.maxX, 10);
});

test('Z is tracked for the tallest extrusion, not the tallest travel', () => {
  // A Z-hop is a travel: the head lifts, moves, and comes back down before
  // extruding again, so the hop height is not printed height.
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X10 Y10 Z0.2 E1', 'G1 Z50 F600', 'G1 Z10 F600', 'G1 X20 Y20 E2'].join('\n')
  );
  assert.equal(extents.maxZ, 10);
});

test('a continuous rise while extruding is printed height, as in vase mode', () => {
  // Spiral vase raises Z throughout the extrusion, so every height along the
  // move really is printed and must be inside the build volume.
  const extents = scanGcode(
    ['G90', 'M82', 'G1 X10 Y10 Z0.2 E1', 'G1 X20 Y20 Z80 E40'].join('\n')
  );
  assert.equal(extents.maxZ, 80);
});

test('comments and blank lines are ignored', () => {
  const extents = scanGcode(
    ['; a comment', '', 'G90', 'M82', 'G1 X10 Y10 E1 ; inline comment', ';G1 X999 Y999 E9'].join('\n')
  );
  assert.equal(extents.maxX, 10);
});

test('lowercase G-code is handled', () => {
  const extents = scanGcode(['g90', 'm82', 'g1 x10 y10 e1', 'g1 x30 y30 e2'].join('\n'));
  assert.equal(extents.maxX, 30);
});

test('chunked input gives the same answer as a single pass', () => {
  const text = [
    'G90', 'M82',
    ...Array.from({ length: 200 }, (_, i) => `G1 X${i % 100} Y${(i * 3) % 90} Z0.2 E${i + 1}`),
  ].join('\n');

  const whole = scanGcode(text);
  const scanner = createGcodeScanner();
  for (let at = 0; at < text.length; at += 7) scanner.push(text.slice(at, at + 7));
  const chunked = scanner.result();

  assert.deepEqual(chunked, whole);
});

test('a file with no trailing newline still counts its last line', () => {
  const scanner = createGcodeScanner();
  scanner.push('G90\nM82\nG1 X10 Y10 E1');
  assert.equal(scanner.result().extrudingMoves, 1);
});

// --- bounds ----------------------------------------------------------------

const extentsOf = (over = {}) => ({
  minX: 10, maxX: 100, minY: 10, maxY: 100, minZ: 0, maxZ: 50, extrudingMoves: 10, ...over,
});

test('a print inside the bed reports nothing', () => {
  assert.deepEqual(checkBounds(extentsOf(), U1_VOLUME), []);
});

test('a print past the bed in any axis blocks', () => {
  for (const over of [{ maxX: 400 }, { maxY: 400 }, { maxZ: 400 }, { minX: -20 }, { minY: -20 }]) {
    const findings = checkBounds(extentsOf(over), U1_VOLUME);
    assert.equal(findings.length, 1, JSON.stringify(over));
    assert.equal(findings[0].code, 'gcode/out-of-bounds');
    assert.equal(findings[0].severity, 'blocking');
  }
});

test('extruding below the bed is its own blocking finding', () => {
  const findings = checkBounds(extentsOf({ minZ: -5 }), U1_VOLUME);
  assert.ok(findings.some((item) => item.code === 'gcode/below-bed'));
  assert.ok(findings.every((item) => item.severity === 'blocking'));
});

test('a small tolerance keeps a print exactly on the edge from being rejected', () => {
  const edge = extentsOf({ maxX: U1_VOLUME.width + BED_TOLERANCE_MM });
  assert.deepEqual(checkBounds(edge, U1_VOLUME), []);

  const past = extentsOf({ maxX: U1_VOLUME.width + BED_TOLERANCE_MM + 0.1 });
  assert.equal(checkBounds(past, U1_VOLUME).length, 1);
});

test('every offending axis is named in one finding', () => {
  const findings = checkBounds(extentsOf({ maxX: 400, maxY: 400, maxZ: 400 }), U1_VOLUME);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /X reaches/);
  assert.match(findings[0].message, /Y reaches/);
  assert.match(findings[0].message, /Z reaches/);
});

// --- metadata --------------------------------------------------------------

const ORCA_HEADER = [
  '; HEADER_BLOCK_START',
  '; total layer number: 214',
  '; total estimated time: 2h 41m 6s',
  '; total filament used [g] = 31.62',
  '; thumbnail begin 48x48 1234',
  '; AAAA',
  '; thumbnail end',
  '; HEADER_BLOCK_END',
].join('\n');

const ORCA_CONFIG = [
  '; CONFIG_BLOCK_START',
  '; layer_height = 0.2',
  '; nozzle_diameter = 0.4',
  '; printer_model = Snapmaker U1',
  '; filament_type = PLA;PETG',
  '; filament_colour = #FF0000;#00FF00',
  '; CONFIG_BLOCK_END',
].join('\n');

test('the Orca header and config blocks are read', () => {
  const metadata = parseGcodeMetadata(`${ORCA_HEADER}\n${ORCA_CONFIG}`);

  assert.equal(metadata.layerCount, 214);
  assert.equal(metadata.layerHeight, 0.2);
  assert.equal(metadata.nozzleDiameter, 0.4);
  assert.equal(metadata.printerModel, 'Snapmaker U1');
  assert.deepEqual(metadata.filamentTypes, ['PLA', 'PETG']);
  assert.deepEqual(metadata.filamentColors, ['#FF0000', '#00FF00']);
  assert.equal(metadata.filamentGrams, 31.62);
  assert.equal(metadata.estimatedSeconds, 2 * 3600 + 41 * 60 + 6);
  assert.equal(metadata.hasThumbnail, true);
});

test('a file with no comments yields empty metadata rather than throwing', () => {
  const metadata = parseGcodeMetadata('G90\nG1 X10 Y10 E1\n');
  assert.deepEqual(metadata.values, {});
  assert.equal(metadata.layerCount, null);
  assert.equal(metadata.hasThumbnail, false);
});

test('the first value for a key wins, since Orca repeats some later', () => {
  const metadata = parseGcodeMetadata('; layer_height = 0.2\n; layer_height = 0.3\n');
  assert.equal(metadata.layerHeight, 0.2);
});

test('durations parse in every shape the slicers emit', () => {
  assert.equal(parseDurationSeconds('1h 2m 3s'), 3723);
  assert.equal(parseDurationSeconds('45m'), 2700);
  assert.equal(parseDurationSeconds('90s'), 90);
  assert.equal(parseDurationSeconds('2d 4h'), 187200);
  assert.equal(parseDurationSeconds('3600'), 3600);
  assert.equal(parseDurationSeconds('who knows'), null);
  assert.equal(parseDurationSeconds(''), null);
});

test('UTF-8 round-trips through the chunk decoder', () => {
  for (const text of ['plain', 'café ✓', '日本語', '𝄞 clef']) {
    assert.equal(bytesToUtf8(utf8ToBytes(text)), text);
  }
});

test('malformed bytes decode to a replacement rather than throwing', () => {
  assert.equal(bytesToUtf8(Uint8Array.from([0xff, 0x41])).includes('A'), true);
});

// --- the whole review ------------------------------------------------------

function gcodeFile(body) {
  return `${ORCA_HEADER}\n${body}\n${ORCA_CONFIG}\n`;
}

const GOOD_BODY = ['G90', 'M82', 'G1 X10 Y10 Z0.2', 'G1 X100 Y100 E20', 'G1 X20 Y20 Z40 E40'].join('\n');

function fakeIo(text, overrides = {}) {
  const bytes = utf8ToBytes(text);
  return {
    async statFile() {
      return bytes.length;
    },
    async readTextChunk(_filePath, offset, length) {
      return bytesToUtf8(bytes.subarray(offset, offset + length));
    },
    async hashFile() {
      return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    },
    ...overrides,
  };
}

const request = (over = {}) => ({ filePath: '/data/out/output.gcode', volume: U1_VOLUME, ...over });

test('a sound slice reviews clean and carries its hash', async () => {
  const review = await reviewSlicedGcode(request(), fakeIo(gcodeFile(GOOD_BODY)));

  assert.equal(review.ok, true);
  assert.match(review.sha256, /^[0-9a-f]{64}$/);
  assert.equal(review.extents.maxX, 100);
  assert.equal(review.metadata.layerCount, 214);
  assert.ok(review.sizeBytes > 0);
  assert.ok(!review.findings.some((item) => item.severity === 'blocking'));
});

test('an out-of-bounds slice blocks, and is not approvable', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(gcodeFile(['G90', 'M82', 'G1 X10 Y10 Z0.2', 'G1 X400 Y100 E20'].join('\n')))
  );

  assert.equal(review.ok, false);
  assert.ok(review.findings.some((item) => item.code === 'gcode/out-of-bounds'));
});

test('a slice that extrudes nothing blocks', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(gcodeFile(['G90', 'M82', 'G1 X10 Y10', 'G1 X20 Y20'].join('\n')))
  );

  assert.equal(review.ok, false);
  assert.ok(review.findings.some((item) => item.code === 'gcode/no-extrusion'));
});

test('an empty or missing file blocks without being hashed', async () => {
  const empty = await reviewSlicedGcode(request(), fakeIo('', { async statFile() { return 0; } }));
  assert.equal(empty.ok, false);
  assert.equal(empty.findings[0].code, 'gcode/empty');
  assert.equal(empty.sha256, '');

  const missing = await reviewSlicedGcode(
    request(),
    fakeIo('', { async statFile() { return null; } })
  );
  assert.equal(missing.findings[0].code, 'gcode/unreadable');
});

test('a stat that throws is a blocking finding, not a crash', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo('', { async statFile() { throw new Error('storage gone'); } })
  );
  assert.equal(review.ok, false);
  assert.equal(review.findings[0].code, 'gcode/unreadable');
});

test('a read failure part-way through blocks rather than reviewing a partial file', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(gcodeFile(GOOD_BODY), {
      async readTextChunk() {
        throw new Error('read error');
      },
    })
  );
  assert.equal(review.ok, false);
  assert.equal(review.findings[0].code, 'gcode/unreadable');
});

test('a hash failure blocks, because an unhashable file cannot be approved', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(gcodeFile(GOOD_BODY), {
      async hashFile() {
        throw new Error('read error');
      },
    })
  );

  assert.equal(review.ok, false);
  assert.equal(review.sha256, '');
  assert.ok(review.findings.some((item) => item.code === 'gcode/hash-failed'));
});

test('a file naming another printer warns without blocking', async () => {
  const review = await reviewSlicedGcode(
    request({ expectedPrinterModel: 'Snapmaker U1' }),
    fakeIo(gcodeFile(GOOD_BODY).replace('Snapmaker U1', 'Bambu Lab X1 Carbon'))
  );

  const found = review.findings.find((item) => item.code === 'gcode/wrong-printer');
  assert.ok(found);
  assert.equal(found.severity, 'warning');
  assert.equal(review.ok, true);
});

test('the matching printer model raises nothing', async () => {
  const review = await reviewSlicedGcode(
    request({ expectedPrinterModel: 'snapmaker u1' }),
    fakeIo(gcodeFile(GOOD_BODY))
  );
  assert.ok(!review.findings.some((item) => item.code === 'gcode/wrong-printer'));
});

test('a missing preview is information only', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(gcodeFile(GOOD_BODY).replace('; thumbnail begin 48x48 1234', '; nothing'))
  );

  const found = review.findings.find((item) => item.code === 'gcode/no-thumbnail');
  assert.ok(found);
  assert.equal(found.severity, 'info');
  assert.equal(review.ok, true);
});

test('a large file is read in chunks and still reviewed correctly', async () => {
  // Forces several scan chunks and both metadata windows.
  const filler = Array.from({ length: 40_000 }, (_, i) => `G1 X${i % 100} Y${i % 90} Z0.2 E${i + 1}`);
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(gcodeFile(['G90', 'M82', ...filler].join('\n')))
  );

  assert.equal(review.ok, true);
  assert.equal(review.extents.maxX, 99);
  // Metadata still found, though the config block is now far past the head.
  assert.equal(review.metadata.layerCount, 214);
  assert.equal(review.metadata.printerModel, 'Snapmaker U1');
});

test('the critical settings summary reads as an operator check, not a dump', async () => {
  const review = await reviewSlicedGcode(request(), fakeIo(gcodeFile(GOOD_BODY)));
  const settings = criticalSettings(review);
  const labels = settings.map((item) => item.label);

  assert.deepEqual(labels, [
    'Layer height', 'Nozzle', 'Layers', 'Filament', 'Filament used',
    'Estimated time', 'Footprint', 'Printer',
  ]);
  assert.equal(settings.find((item) => item.label === 'Layer height').value, '0.2 mm');
  assert.equal(settings.find((item) => item.label === 'Estimated time').value, '2h 41m');
});

test('settings that are absent are omitted rather than shown as unknown', async () => {
  const review = await reviewSlicedGcode(
    request(),
    fakeIo(['G90', 'M82', 'G1 X10 Y10 Z0.2 E1'].join('\n'))
  );
  const labels = criticalSettings(review).map((item) => item.label);

  assert.deepEqual(labels, ['Footprint']);
});
