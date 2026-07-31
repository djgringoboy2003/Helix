const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  cancelStart,
  recheckFilament,
  recheckUploadedFile,
  startApprovedPrint,
  usedToolheadsOf,
} = require(servicePath('start', 'StartService.ts'));
const {
  buildFilamentMapping,
  buildStartJob,
  newJobId,
  reprintMappingSources,
} = require(servicePath('start', 'StartJob.ts'));
const { createStartApproval } = require(servicePath('jobs', 'ApprovalService.ts'));
const {
  grantStartApproval,
  setProfileSelection,
} = require(servicePath('jobs', 'PrintJobMachine.ts'));

const NOW = 1_700_000_000_000;
const HASH = 'a'.repeat(64);
const FILENAME = 'benchy_1700000000.gcode';

const LOADED = [
  { toolhead: 0, status: 'loaded', material: 'PLA Basic', color: '#FF0000', brand: 'Generic', rfidLocked: false, source: 'printer' },
  { toolhead: 1, status: 'loaded', material: 'PLA Matte', color: '#0000FF', brand: 'Generic', rfidLocked: false, source: 'printer' },
  { toolhead: 2, status: 'empty', material: '', color: '', brand: '', rfidLocked: false, source: 'printer' },
  { toolhead: 3, status: 'unknown', material: '', color: '', brand: '', rfidLocked: false, source: 'unknown' },
];

const SOURCES = [
  { sourceIndex: 0, material: 'PLA', color: '#FF0000' },
  { sourceIndex: 1, material: 'PLA', color: '#0000FF' },
];

const UPLOADED = { filename: FILENAME, sizeBytes: 1_000_000, modified: 1_699_999_000 };

function approvedJob(over = {}) {
  const mapping = buildFilamentMapping(SOURCES, { 0: 0, 1: 1 }, LOADED, NOW - 30_000);
  const job = buildStartJob({
    id: 'job-test',
    modelId: 'benchy',
    printerId: 'printer-a',
    gcodeArtifactId: '/data/out/benchy.gcode',
    gcodeSha256: HASH,
    uploadedFilename: FILENAME,
    filamentMapping: mapping,
    at: NOW - 20_000,
    ...over,
  });
  const approval = createStartApproval({
    job,
    printerId: 'printer-a',
    filename: FILENAME,
    gcodeSha256: HASH,
    approvedAt: NOW - 10_000,
  });
  return grantStartApproval(job, approval, NOW - 10_000);
}

function fakeIo(overrides = {}) {
  const calls = [];
  const io = {
    async readReadiness() {
      calls.push('readReadiness');
      return { connected: true, klippyReady: true, printState: 'standby' };
    },
    async listFiles() {
      calls.push('listFiles');
      return [{ path: FILENAME, size: 1_000_000, modified: 1_699_999_000 }];
    },
    async readLoadedSlots() {
      calls.push('readLoadedSlots');
      return LOADED;
    },
    async applyPrintSetup(used) {
      calls.push(`applyPrintSetup:${used.join(',')}`);
    },
    async startPrint(filename) {
      calls.push(`startPrint:${filename}`);
    },
    ...overrides,
  };
  return { io, calls };
}

const request = (over = {}) => ({
  job: approvedJob(),
  activePrinterId: 'printer-a',
  uploaded: UPLOADED,
  cameraFrame: { capturedAt: NOW - 5_000, printerId: 'printer-a', cameraEndpoint: '/webcam/snapshot.jpg', jobRevision: 1 },
  operatorConfirmedBedClear: true,
  now: NOW,
  ...over,
});

// --- the structural guarantee ----------------------------------------------

test('the start module reaches the printer only through a validated approval', () => {
  // StartService is the one place allowed to start a print, so the check that
  // matters here is the inverse of UploadService's: it *does* start, and every
  // gate must sit in front of that. Asserted at the source level so a later edit
  // cannot move the start command above the checks.
  const source = fs.readFileSync(servicePath('start', 'StartService.ts'), 'utf8');
  const gateAt = source.indexOf('evaluateStartGate(job, {');
  const startAt = source.indexOf('io.startPrint(approval.filename)');

  assert.ok(gateAt > 0 && startAt > 0);
  assert.ok(gateAt < startAt, 'the gate must be evaluated before the start command');
  // The start names the approval's filename, never a caller-supplied one.
  assert.ok(!/io\.startPrint\((?!approval\.filename)/.test(source));
});

// --- building the job ------------------------------------------------------

test('a start job walks the real transitions to awaiting_start_approval', () => {
  const job = approvedJob();
  const states = job.events.filter((e) => e.toState).map((e) => e.toState);

  assert.equal(job.state, 'start_approved');
  assert.deepEqual(states.slice(0, 7), [
    'created',
    'review_required',
    'approved_for_upload',
    'uploading',
    'uploaded',
    'awaiting_start_approval',
    'start_approved',
  ]);
  assert.equal(job.revision, 1);
  assert.equal(job.uploadedFilename, FILENAME);
});

test('a job cannot be built without a confirmed mapping for every colour', () => {
  const unconfirmed = buildFilamentMapping(SOURCES, { 0: 0, 1: 1 }, LOADED, null);
  assert.throws(
    () => buildStartJob({
      id: 'x', modelId: 'm', printerId: 'p', gcodeArtifactId: '/g', gcodeSha256: HASH,
      uploadedFilename: FILENAME, filamentMapping: unconfirmed, at: NOW,
    }),
    /toolhead for every source colour/
  );

  const partial = buildFilamentMapping(SOURCES, { 0: 0 }, LOADED, NOW);
  assert.equal(partial.slots[1].toolhead, null);
  assert.throws(
    () => buildStartJob({
      id: 'x', modelId: 'm', printerId: 'p', gcodeArtifactId: '/g', gcodeSha256: HASH,
      uploadedFilename: FILENAME, filamentMapping: partial, at: NOW,
    }),
    /toolhead for every source colour/
  );
});

test('a mapping records what is loaded now, and nothing for a head that is not', () => {
  const mapping = buildFilamentMapping(SOURCES, { 0: 0, 1: 2 }, LOADED, NOW);
  assert.equal(mapping.slots[0].loadedMaterial, 'PLA Basic');
  assert.equal(mapping.slots[0].loadedColor, '#FF0000');
  // T2 is empty: nothing is recorded rather than stale metadata being carried.
  assert.equal(mapping.slots[1].loadedMaterial, '');
  assert.equal(mapping.slots[1].loadedColor, '');
});

test('two colours on one toolhead is one toolhead in use', () => {
  const job = approvedJob();
  assert.deepEqual(usedToolheadsOf(job), [0, 1]);

  const collapsed = buildStartJob({
    id: 'x', modelId: 'm', printerId: 'p', gcodeArtifactId: '/g', gcodeSha256: HASH,
    uploadedFilename: FILENAME,
    filamentMapping: buildFilamentMapping(SOURCES, { 0: 1, 1: 1 }, LOADED, NOW),
    at: NOW,
  });
  assert.deepEqual(usedToolheadsOf(collapsed), [1]);
});

// --- reprints, where the file describes itself ------------------------------

test('a reprint maps only the toolheads the file extrudes with', () => {
  // The header lists every filament the project was sliced with; the toolpaths
  // say which of them actually print. A four-filament project collapsed to one
  // colour must not demand four loaded heads.
  const sources = reprintMappingSources({
    extents: { toolsUsed: [0, 2] },
    metadata: {
      filamentTypes: ['PLA', 'PETG', 'PLA', 'ABS'],
      filamentColors: ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'],
    },
  });

  assert.deepEqual(sources, [
    { sourceIndex: 0, material: 'PLA', color: '#FF0000' },
    { sourceIndex: 2, material: 'PLA', color: '#0000FF' },
  ]);
});

test('a reprint of a file with no header still maps its toolheads', () => {
  const sources = reprintMappingSources({
    extents: { toolsUsed: [1] },
    metadata: { filamentTypes: [], filamentColors: [] },
  });

  assert.deepEqual(sources, [{ sourceIndex: 1, material: '', color: '' }]);
});

test('a file that extrudes nothing maps nothing', () => {
  assert.deepEqual(
    reprintMappingSources({ extents: null, metadata: { filamentTypes: [], filamentColors: [] } }),
    []
  );
});

test('job ids are unique within a session', () => {
  const ids = new Set([newJobId(NOW), newJobId(NOW), newJobId(NOW)]);
  assert.equal(ids.size, 3);
});

// --- the happy path --------------------------------------------------------

test('an approved print maps the toolheads, then starts the approved file', async () => {
  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'started');
  assert.equal(outcome.filename, FILENAME);
  assert.equal(outcome.job.state, 'printing');
  // Order is the guarantee: everything is re-read, then the map, then the start.
  assert.deepEqual(calls, [
    'readReadiness',
    'listFiles',
    'readLoadedSlots',
    'applyPrintSetup:0,1',
    `startPrint:${FILENAME}`,
  ]);
});

test('the audit trail records the start against the approved file', async () => {
  const { io } = fakeIo();
  const outcome = await startApprovedPrint(request(), io);
  const details = outcome.job.events.map((event) => event.detail);

  assert.ok(details.some((detail) => detail === `starting ${FILENAME}`));
  assert.ok(details.some((detail) => detail === `printing ${FILENAME}`));
  assert.ok(details.some((detail) => detail.includes('approved revision 1')));
});

// --- Phase 9 acceptance: stale camera --------------------------------------

test('a stale camera frame refuses the start', async () => {
  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(
    request({ cameraFrame: { capturedAt: NOW - 600_000, printerId: 'printer-a', cameraEndpoint: '/webcam/snapshot.jpg', jobRevision: 1 } }),
    io
  );

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/gate-failed');
  assert.ok(outcome.failures.some((failure) => failure.code === 'camera/stale'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('no camera frame at all is stale, not missing', async () => {
  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request({ cameraFrame: null }), io);

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'camera/unavailable'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('a camera frame from before the current job version does not support a start', async () => {
  const { io } = fakeIo();
  const outcome = await startApprovedPrint(
    request({ cameraFrame: { capturedAt: NOW - 1_000, printerId: 'printer-a', cameraEndpoint: '/webcam/snapshot.jpg', jobRevision: 0 } }),
    io
  );

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'camera/revision-mismatch'));
});

// --- Phase 9 acceptance: changed settings ----------------------------------

test('changing a setting after approval takes the job out of the approved state', async () => {
  const changed = setProfileSelection(
    approvedJob(),
    { sourceProfileId: 'src', u1ProfileId: 'u1-0.4', nozzleDiameter: 0.4, plateId: 1 },
    NOW
  );

  // The revision change rewound the job and discarded the approval outright.
  assert.notEqual(changed.state, 'start_approved');
  assert.equal(changed.startApproval, null);
  assert.equal(changed.revision, 2);

  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request({ job: changed }), io);
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/not-approved');
  assert.deepEqual(calls, []);
});

test('an approval that names an older revision is refused', async () => {
  const job = approvedJob();
  // A record restored from storage against a job that moved on beneath it.
  const drifted = { ...job, revision: job.revision + 1 };

  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request({ job: drifted }), io);

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'approval/revision-mismatch'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

// --- Phase 9 acceptance: changed printer -----------------------------------

test('an approval given for another printer will not start this one', async () => {
  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request({ activePrinterId: 'printer-b' }), io);

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'approval/printer-mismatch'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

// --- Phase 9 acceptance: changed filament ----------------------------------

test('a spool swapped after approval refuses the start', async () => {
  const swapped = LOADED.map((slot) =>
    slot.toolhead === 1 ? { ...slot, color: '#00FF00' } : slot
  );
  const { io, calls } = fakeIo({ readLoadedSlots: async () => swapped });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/filament-changed');
  assert.ok(outcome.message.includes('changed after this print was approved'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('a different material on an approved head refuses the start', () => {
  const job = approvedJob();
  const swapped = LOADED.map((slot) =>
    slot.toolhead === 0 ? { ...slot, material: 'PETG' } : slot
  );
  const failures = recheckFilament(job, swapped);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'approval/filament-map-mismatch');
  assert.ok(failures[0].message.includes('PETG'));
});

test('a head that stopped reporting filament is not assumed to still hold it', () => {
  const job = approvedJob();
  const unloaded = LOADED.map((slot) =>
    slot.toolhead === 0 ? { ...slot, status: 'unknown' } : slot
  );
  const failures = recheckFilament(job, unloaded);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'job/missing-filament-map');
});

test('a base material match survives a subtype change', () => {
  // `PLA Basic` and `PLA Matte` are both PLA; the mapping was built on the base
  // type, so re-checking must not invent a mismatch the operator never saw.
  const job = approvedJob();
  const restyled = LOADED.map((slot) =>
    slot.toolhead === 0 ? { ...slot, material: 'PLA Silk' } : slot
  );
  assert.deepEqual(recheckFilament(job, restyled), []);
});

// --- Phase 9 acceptance: replaced G-code file ------------------------------

test('a file replaced on the printer after approval refuses the start', async () => {
  const { io, calls } = fakeIo({
    listFiles: async () => [{ path: FILENAME, size: 999_999, modified: 1_699_999_000 }],
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/file-changed');
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('a file rewritten at the same size is caught by its modification time', () => {
  const check = recheckUploadedFile(UPLOADED, [
    { path: FILENAME, size: 1_000_000, modified: 1_700_000_500 },
  ]);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'start/file-changed');
});

test('a file that is gone refuses rather than starting something else', async () => {
  const { io, calls } = fakeIo({ listFiles: async () => [{ path: 'other.gcode', size: 10 }] });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/file-missing');
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('an unreadable file list stops the start rather than trusting the name', async () => {
  const { io, calls } = fakeIo({
    listFiles: async () => {
      throw new Error('Moonraker restarted');
    },
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/file-missing');
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('the filename is matched exactly, not case-insensitively', () => {
  // Unlike the upload collision check, which mirrors the printer's own
  // case-folding, a start must name the file that was approved character for
  // character. A near-miss here is a different file.
  const check = recheckUploadedFile(UPLOADED, [
    { path: FILENAME.toUpperCase(), size: 1_000_000, modified: 1_699_999_000 },
  ]);
  assert.equal(check.ok, false);
  assert.equal(check.code, 'start/file-missing');
});

// --- Phase 9 acceptance: expired approval ----------------------------------

test('an expired approval refuses the start', async () => {
  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request({ now: NOW + 20 * 60 * 1000 }), io);

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'approval/expired'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('a clock that moved backwards invalidates the approval', async () => {
  const { io } = fakeIo();
  const outcome = await startApprovedPrint(request({ now: NOW - 60_000 }), io);

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'approval/expired'));
});

// --- Phase 9 acceptance: the printer started another job --------------------

test('a printer that is already printing is not given a second job', async () => {
  const { io, calls } = fakeIo({
    readReadiness: async () => ({ connected: true, klippyReady: true, printState: 'printing' }),
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/printer-busy');
  // Nothing past the readiness check ran; the override replaces the recorder,
  // so an empty list is what "stopped at the first check" looks like here.
  assert.deepEqual(calls, []);
});

test('a paused printer is busy', async () => {
  const { io } = fakeIo({
    readReadiness: async () => ({ connected: true, klippyReady: true, printState: 'Paused' }),
  });
  const outcome = await startApprovedPrint(request(), io);
  assert.equal(outcome.code, 'start/printer-busy');
});

test('a printer that will not say what it is doing is not started', async () => {
  const { io, calls } = fakeIo({
    readReadiness: async () => ({ connected: true, klippyReady: true, printState: null }),
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/printer-not-ready');
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('an unreachable printer refuses before anything else is read', async () => {
  const { io, calls } = fakeIo({
    readReadiness: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.code, 'start/printer-offline');
  assert.deepEqual(calls, []);
});

// --- Phase 9 acceptance: mapping command failure ---------------------------

test('a refused toolhead mapping stops the print before it starts', async () => {
  const { io, calls } = fakeIo({
    async applyPrintSetup() {
      throw new Error('SET_PRINT_USED_EXTRUDERS rejected');
    },
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/setup-failed');
  assert.equal(outcome.uncertain, false);
  // These commands configure, they do not move anything. The job keeps its
  // approval and stays retryable rather than claiming the printer might be
  // running.
  assert.equal(outcome.job.state, 'start_approved');
  assert.notEqual(outcome.job.startApproval, null);
  assert.ok(outcome.message.includes('nothing was started'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

// --- Phase 9 acceptance: start command failure -----------------------------

test('a failed start command leaves the job failed and says the outcome is unknown', async () => {
  const { io, calls } = fakeIo({
    async startPrint() {
      throw new Error('HTTP 500');
    },
  });
  const outcome = await startApprovedPrint(request(), io);

  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.code, 'start/command-failed');
  // The request may have landed and the response been lost. The app must not
  // claim either way, and must not offer to retry as though nothing happened.
  assert.equal(outcome.uncertain, true);
  assert.ok(outcome.message.includes('Check the printer'));
  assert.equal(outcome.job.state, 'failed');
  // It got as far as the start: the toolhead map went out first.
  assert.ok(calls.includes('applyPrintSetup:0,1'));
});

// --- the bed, and the way out ----------------------------------------------

test('an unconfirmed bed refuses the start', async () => {
  const { io, calls } = fakeIo();
  const outcome = await startApprovedPrint(request({ operatorConfirmedBedClear: false }), io);

  assert.equal(outcome.status, 'refused');
  assert.ok(outcome.failures.some((failure) => failure.code === 'approval/not-granted'));
  assert.ok(!calls.some((call) => call.startsWith('startPrint')));
});

test('every failing check is reported at once, not just the first', async () => {
  const { io } = fakeIo();
  const outcome = await startApprovedPrint(
    request({
      activePrinterId: 'printer-b',
      operatorConfirmedBedClear: false,
      cameraFrame: null,
    }),
    io
  );

  const codes = outcome.failures.map((failure) => failure.code);
  assert.ok(codes.includes('approval/printer-mismatch'));
  assert.ok(codes.includes('approval/not-granted'));
  assert.ok(codes.includes('camera/unavailable'));
});

test('an approved job can be cancelled outright', () => {
  const cancelled = cancelStart(approvedJob(), 'operator cancelled', NOW);

  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.startApproval, null);
  assert.ok(cancelled.events.some((event) => event.detail === 'operator cancelled'));
});
