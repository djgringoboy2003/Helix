const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  STORAGE_MARGIN_BYTES,
  printerFilename,
  uploadSlicedGcode,
} = require(servicePath('upload', 'UploadService.ts'));

const GOOD_REVIEW = {
  filePath: '/data/out/output.gcode',
  sizeBytes: 1_000_000,
  sha256: 'a'.repeat(64),
  extents: null,
  metadata: {},
  findings: [],
  ok: true,
};

function fakeIo(overrides = {}) {
  const calls = { uploads: [], progress: [] };
  const io = {
    async readReadiness() {
      return { connected: true, klippyReady: true, printState: 'standby' };
    },
    async listFiles() {
      return [{ path: 'something-else.gcode', size: 10 }];
    },
    async freeSpaceBytes() {
      return 4_000_000_000;
    },
    async statLocal() {
      return GOOD_REVIEW.sizeBytes;
    },
    async upload(filename, gcodePath, onProgress) {
      calls.uploads.push({ filename, gcodePath });
      onProgress?.({ sentBytes: GOOD_REVIEW.sizeBytes, totalBytes: GOOD_REVIEW.sizeBytes });
      return { status: 201, sizeBytes: GOOD_REVIEW.sizeBytes };
    },
    ...overrides,
  };
  return { io, calls };
}

const request = (over = {}) => ({
  review: GOOD_REVIEW,
  filename: 'benchy.gcode',
  now: () => 1_700_000_000_000,
  ...over,
});

// --- the structural guarantee ----------------------------------------------

test('the upload module contains no way to start a print', () => {
  // The safety rules forbid starting after upload, and PrintJobMachine has no
  // uploaded -> starting transition. This asserts the same thing at the source
  // level, so a later edit cannot quietly reintroduce it.
  const source = fs.readFileSync(servicePath('upload', 'UploadService.ts'), 'utf8');

  assert.ok(!/printer\/print\/start/i.test(source));
  assert.ok(!/\bstartPrint\b/.test(source));
  assert.ok(!/SET_MAIN_STATE/i.test(source));
});

// --- the happy path --------------------------------------------------------

test('a reviewed slice uploads and is recorded against its hash', async () => {
  const { io, calls } = fakeIo();
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.status, 'uploaded');
  assert.deepEqual(outcome.record, {
    filename: 'benchy.gcode',
    sizeBytes: 1_000_000,
    sha256: 'a'.repeat(64),
    uploadedAt: 1_700_000_000_000,
  });
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].gcodePath, '/data/out/output.gcode');
});

test('progress is reported to the caller', async () => {
  const seen = [];
  const { io } = fakeIo();
  await uploadSlicedGcode(request({ onProgress: (p) => seen.push(p) }), io);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].sentBytes, 1_000_000);
});

// --- refusing before the network is touched --------------------------------

test('an unreviewed or failed slice is refused without contacting the printer', async () => {
  const { io, calls } = fakeIo({
    async readReadiness() {
      throw new Error('must not be asked');
    },
  });

  for (const review of [
    { ...GOOD_REVIEW, ok: false },
    { ...GOOD_REVIEW, sha256: '' },
  ]) {
    const outcome = await uploadSlicedGcode(request({ review }), io);
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.code, 'upload/not-reviewed');
  }
  assert.equal(calls.uploads.length, 0);
});

test('an offline printer refuses the upload', async () => {
  const { io, calls } = fakeIo({
    async readReadiness() {
      return { connected: false, klippyReady: false, printState: null };
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/printer-offline');
  assert.equal(calls.uploads.length, 0);
});

test('an unreachable printer refuses rather than throwing', async () => {
  const { io } = fakeIo({
    async readReadiness() {
      throw new Error('ECONNREFUSED');
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);
  assert.equal(outcome.code, 'upload/printer-offline');
});

test('firmware that is not ready refuses the upload', async () => {
  const { io } = fakeIo({
    async readReadiness() {
      return { connected: true, klippyReady: false, printState: 'standby' };
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);
  assert.equal(outcome.code, 'upload/printer-not-ready');
});

test('a busy or paused printer refuses the upload', async () => {
  for (const printState of ['printing', 'paused', 'PRINTING', 'Paused']) {
    const { io, calls } = fakeIo({
      async readReadiness() {
        return { connected: true, klippyReady: true, printState };
      },
    });
    const outcome = await uploadSlicedGcode(request(), io);
    assert.equal(outcome.code, 'upload/printer-busy', printState);
    assert.equal(calls.uploads.length, 0);
  }
});

test('a printer that does not say what it is doing fails closed', async () => {
  const { io } = fakeIo({
    async readReadiness() {
      return { connected: true, klippyReady: true, printState: null };
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);
  assert.equal(outcome.code, 'upload/printer-not-ready');
});

test('a complete or standby printer is free to receive a file', async () => {
  for (const printState of ['standby', 'complete', 'ready', 'cancelled', 'error']) {
    const { io } = fakeIo({
      async readReadiness() {
        return { connected: true, klippyReady: true, printState };
      },
    });
    const outcome = await uploadSlicedGcode(request(), io);
    assert.equal(outcome.status, 'uploaded', printState);
  }
});

// --- the local file --------------------------------------------------------

test('a sliced file that vanished refuses the upload', async () => {
  const { io } = fakeIo({ async statLocal() { return null; } });
  const outcome = await uploadSlicedGcode(request(), io);
  assert.equal(outcome.code, 'upload/file-missing');
});

test('a file that changed since the review refuses the upload', async () => {
  // Otherwise bytes would be sent that the reviewed hash does not describe.
  const { io, calls } = fakeIo({ async statLocal() { return 999; } });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/file-changed');
  assert.equal(calls.uploads.length, 0);
});

// --- storage ---------------------------------------------------------------

test('insufficient storage refuses the upload', async () => {
  const { io, calls } = fakeIo({
    async freeSpaceBytes() {
      return GOOD_REVIEW.sizeBytes + STORAGE_MARGIN_BYTES - 1;
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/insufficient-storage');
  assert.equal(calls.uploads.length, 0);
});

test('enough storage, counting the margin, allows the upload', async () => {
  const { io } = fakeIo({
    async freeSpaceBytes() {
      return GOOD_REVIEW.sizeBytes + STORAGE_MARGIN_BYTES;
    },
  });
  assert.equal((await uploadSlicedGcode(request(), io)).status, 'uploaded');
});

test('storage that cannot be determined does not block the upload', async () => {
  // Moonraker does not always report free space, and refusing every upload on a
  // printer that never reports it would make the app unusable there. The
  // byte-count check after the upload still catches a disk that filled.
  const { io } = fakeIo({ async freeSpaceBytes() { return null; } });
  assert.equal((await uploadSlicedGcode(request(), io)).status, 'uploaded');
});

// --- collision -------------------------------------------------------------

test('an existing file is never overwritten without approval', async () => {
  const { io, calls } = fakeIo({
    async listFiles() {
      return [{ path: 'benchy.gcode', size: 5, modified: 1 }];
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.status, 'needs-approval');
  assert.equal(outcome.code, 'upload/collision');
  assert.deepEqual(outcome.existing, { path: 'benchy.gcode', size: 5, modified: 1 });
  assert.equal(calls.uploads.length, 0);
});

test('collision detection ignores case, as the printer does', async () => {
  const { io } = fakeIo({
    async listFiles() {
      return [{ path: 'BENCHY.GCODE', size: 5 }];
    },
  });
  assert.equal((await uploadSlicedGcode(request(), io)).status, 'needs-approval');
});

test('approved overwrite proceeds', async () => {
  const { io, calls } = fakeIo({
    async listFiles() {
      return [{ path: 'benchy.gcode', size: 5 }];
    },
  });
  const outcome = await uploadSlicedGcode(request({ overwriteApproved: true }), io);

  assert.equal(outcome.status, 'uploaded');
  assert.equal(calls.uploads.length, 1);
});

test('an unreadable file list stops the upload rather than risking an overwrite', async () => {
  const { io, calls } = fakeIo({
    async listFiles() {
      throw new Error('Moonraker restarted');
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/rejected');
  assert.equal(calls.uploads.length, 0);
});

// --- the transfer itself ---------------------------------------------------

test('an interrupted upload is reported, and nothing is started', async () => {
  const { io } = fakeIo({
    async upload() {
      throw new Error('socket closed');
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/interrupted');
  assert.match(outcome.message, /nothing was started/i);
});

test('a non-2xx response is a refusal, not a success', async () => {
  const { io } = fakeIo({
    async upload() {
      return { status: 500, sizeBytes: null };
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/rejected');
  assert.match(outcome.message, /HTTP 500/);
});

test('a mismatched byte count refuses, so a short write is never approved', async () => {
  const { io } = fakeIo({
    async upload() {
      return { status: 201, sizeBytes: 12345 };
    },
  });
  const outcome = await uploadSlicedGcode(request(), io);

  assert.equal(outcome.code, 'upload/size-mismatch');
  assert.match(outcome.message, /12345/);
  assert.match(outcome.message, /not started/i);
});

test('a printer that reports no size is trusted on its 2xx', async () => {
  // Some Moonraker builds return no size for an upload. Refusing every one of
  // those would block uploads entirely on those printers.
  const { io } = fakeIo({
    async upload() {
      return { status: 201, sizeBytes: null };
    },
  });
  assert.equal((await uploadSlicedGcode(request(), io)).status, 'uploaded');
});

// --- filenames -------------------------------------------------------------

test('printer filenames are derived safely from the model name', () => {
  assert.equal(printerFilename('benchy.3mf'), 'benchy.gcode');
  assert.equal(printerFilename('benchy'), 'benchy.gcode');
  assert.equal(printerFilename('already.gcode'), 'already.gcode');
  assert.equal(printerFilename('../../etc/passwd.3mf'), 'passwd.gcode');
  assert.equal(printerFilename('a<b>c.3mf'), 'a_b_c.gcode');
  assert.equal(printerFilename(''), 'print.gcode');
  assert.equal(printerFilename('   '), 'print.gcode');
});

test('an over-long name is bounded but keeps its extension', () => {
  const name = printerFilename(`${'x'.repeat(300)}.3mf`);
  assert.ok(name.length <= 100);
  assert.ok(name.endsWith('.gcode'));
});
