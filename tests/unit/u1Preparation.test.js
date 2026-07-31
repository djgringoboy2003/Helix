const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const { runU1Preparation, summarizeReport } = require(servicePath('prepare', 'U1Preparation.ts'));

const U1_PROFILE_TEXT = fs.readFileSync(
  path.join(
    __dirname, '..', '..', 'android', 'app', 'src', 'main', 'assets',
    'orca_profiles', 'printer', 'snapmaker_u1.json'
  ),
  'utf8'
);

const BAMBU_SETTINGS = JSON.stringify({
  printer_model: 'Bambu Lab X1 Carbon',
  printable_height: '250',
  machine_start_gcode: 'G28\nG29\n; Bambu purge\n',
  machine_end_gcode: 'M104 S0\n',
  bambu_wifi_enabled: '1',
  layer_height: '0.5',
  filament_colour: ['#FF0000', '#00FF00'],
});

/** Records what the native side was asked to do, so ordering is assertable. */
function fakeIo(overrides = {}) {
  const calls = { read: [], profile: 0, prepare: [] };
  const io = {
    async readProjectSettings(filePath) {
      calls.read.push(filePath);
      return BAMBU_SETTINGS;
    },
    async getU1PrinterProfile() {
      calls.profile += 1;
      return U1_PROFILE_TEXT;
    },
    async prepareForU1(filePath, planJson) {
      calls.prepare.push({ filePath, plan: JSON.parse(planJson) });
      return `/data/prepared/u1_${filePath.split('/').pop()}`;
    },
    ...overrides,
  };
  return { io, calls };
}

const request = (overrides = {}) => ({
  filePath: '/data/models/benchy.3mf',
  isArchive: true,
  ...overrides,
});

// --- the happy path --------------------------------------------------------

test('a Bambu project is retargeted and the prepared path is returned', async () => {
  const { io, calls } = fakeIo();
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'prepared');
  assert.equal(outcome.filePath, '/data/prepared/u1_benchy.3mf');
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.prepare[0].filePath, '/data/models/benchy.3mf');
});

test('the plan handed to the native side carries the U1 machine identity', async () => {
  const { io, calls } = fakeIo();
  await runU1Preparation(request(), io);

  const { apply, remove } = calls.prepare[0].plan;
  assert.equal(apply.printer_model, 'Snapmaker U1');
  assert.equal(apply.printable_height, '270');
  assert.ok(!String(apply.machine_start_gcode).includes('Bambu'));
  assert.ok(remove.includes('bambu_wifi_enabled'));
  // 0.5 mm layers are past what the U1 allows and are brought into range.
  assert.equal(apply.layer_height, '0.32');
});

test('stale sliced output is named for removal in the plan', async () => {
  const { io, calls } = fakeIo();
  await runU1Preparation(
    request({ slicedOutputPaths: ['Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5'] }),
    io
  );

  assert.deepEqual(calls.prepare[0].plan.removeEntries, [
    'Metadata/plate_1.gcode',
    'Metadata/plate_1.gcode.md5',
  ]);
});

test('the report explains what happened and summarises for the status line', async () => {
  const { io } = fakeIo();
  const outcome = await runU1Preparation(request(), io);

  assert.ok(outcome.report.replaced > 0);
  assert.ok(outcome.report.removed > 0);
  assert.ok(outcome.report.clamped > 0);
  const summary = summarizeReport(outcome.report);
  assert.match(summary, /Retargeted for the U1/);
  assert.match(summary, /brought into range/);
});

test('a report with nothing to say summarises as nothing', () => {
  assert.equal(
    summarizeReport({ ok: true, entries: [], replaced: 0, removed: 0, clamped: 0, preserved: 3, blockers: [] }),
    null
  );
});

// --- when preparation is not needed ----------------------------------------

test('a mesh is left alone without reading anything', async () => {
  const { io, calls } = fakeIo();
  const outcome = await runU1Preparation(
    request({ filePath: '/data/models/part.stl', isArchive: false }),
    io
  );

  assert.equal(outcome.status, 'not-needed');
  assert.equal(outcome.filePath, '/data/models/part.stl');
  assert.equal(calls.read.length, 0);
  assert.equal(calls.prepare.length, 0);
});

test('a 3MF with no embedded profile is used unchanged rather than given one', async () => {
  // Writing a profile into a plain 3MF would switch the engine onto its
  // embedded-profile path, which these files do not currently take.
  const { io, calls } = fakeIo({ async readProjectSettings() { return null; } });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'not-needed');
  assert.equal(outcome.filePath, '/data/models/benchy.3mf');
  assert.equal(calls.prepare.length, 0);
});

test('a config that is not a settings object is treated as no profile', async () => {
  for (const body of ['not json', '[]', '"a string"', 'null', '123']) {
    const { io } = fakeIo({ async readProjectSettings() { return body; } });
    const outcome = await runU1Preparation(request(), io);
    assert.equal(outcome.status, 'not-needed', body);
  }
});

test('values of a shape this format does not use are dropped, not carried', async () => {
  const { io, calls } = fakeIo({
    async readProjectSettings() {
      return JSON.stringify({
        printer_model: 'Bambu Lab X1 Carbon',
        nested: { evil: true },
        numeric: 42,
        mixed: ['ok', 7],
      });
    },
  });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'prepared');
  const { apply, remove } = calls.prepare[0].plan;

  // None of the odd-shaped keys reach the native rewrite at all.
  for (const key of ['nested', 'numeric', 'mixed']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(apply, key), `apply.${key}`);
    assert.ok(!remove.includes(key), `remove.${key}`);
    assert.ok(!outcome.report.entries.some((entry) => entry.key === key), `report.${key}`);
  }
  // The string-shaped key was still handled normally.
  assert.equal(apply.printer_model, 'Snapmaker U1');
});

// --- failing closed --------------------------------------------------------

test('a native rewrite failure fails the preparation instead of using the original', async () => {
  const { io } = fakeIo({
    async prepareForU1() {
      throw new Error('disk full');
    },
  });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /could not be retargeted/i);
  assert.match(outcome.message, /disk full/);
  // Crucially, no path is offered — there is nothing safe to fall back to.
  assert.equal(outcome.filePath, undefined);
});

test('a rewrite that returns no path is a failure, not a success', async () => {
  const { io } = fakeIo({ async prepareForU1() { return ''; } });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.filePath, undefined);
});

test('an unreadable U1 profile blocks preparation rather than skipping it', async () => {
  const { io, calls } = fakeIo({
    async getU1PrinterProfile() {
      throw new Error('asset missing');
    },
  });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'failed');
  assert.equal(calls.prepare.length, 0);
});

test('a U1 profile that is not a settings object is a failure', async () => {
  const { io } = fakeIo({ async getU1PrinterProfile() { return 'null'; } });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /Snapmaker U1 profile/);
});

test('a U1 profile missing its bed shape blocks before any rewrite is attempted', async () => {
  const crippled = JSON.parse(U1_PROFILE_TEXT);
  delete crippled.printable_area;
  const { io, calls } = fakeIo({
    async getU1PrinterProfile() {
      return JSON.stringify(crippled);
    },
  });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'failed');
  assert.equal(calls.prepare.length, 0);
  assert.ok(outcome.report !== null);
  assert.match(outcome.message, /bed shape/i);
});

test('a failure to read the project settings fails rather than assuming none', async () => {
  // "Could not read it" and "it is not there" are different, and only the
  // second is safe to treat as nothing to retarget.
  const { io } = fakeIo({
    async readProjectSettings() {
      throw new Error('archive unreadable');
    },
  });
  const outcome = await runU1Preparation(request(), io);

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /archive unreadable/);
});
