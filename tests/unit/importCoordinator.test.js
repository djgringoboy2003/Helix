const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');
const { buildZip, nameBytes, threeMf } = require('./helpers/zipBuilder');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  ImportCoordinator,
  detectImportSourceFromPath,
} = require(servicePath('import', 'ImportCoordinator.ts'));
const {
  InMemoryImportLibrary,
  StoredImportLibrary,
  IMPORT_INDEX_KEY,
  MAX_STORED_IMPORTS,
} = require(servicePath('import', 'ImportLibrary.ts'));

// --- fake IO ---------------------------------------------------------------
// Files live in a Map of path → bytes, so the coordinator's ordering (stat,
// hash, then read as an archive) is observable and every failure mode can be
// asked for directly.

function fakeIo(files, overrides = {}) {
  const io = {
    async statFile(filePath) {
      const file = files.get(filePath);
      if (!file) return null;
      return file.length;
    },
    createReader(filePath) {
      return async (at, length) => {
        const file = files.get(filePath);
        if (!file) throw new Error('missing');
        return file.subarray(at, at + length);
      };
    },
    async hashFile(filePath) {
      const file = files.get(filePath);
      if (!file) throw new Error('missing');
      return crypto.createHash('sha256').update(file).digest('hex');
    },
  };
  return { ...io, ...overrides };
}

function coordinatorOver(files, options = {}) {
  return new ImportCoordinator({
    library: options.library ?? new InMemoryImportLibrary(),
    io: options.io ?? fakeIo(files),
    now: options.now ?? (() => 1_700_000_000_000),
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

const request = (overrides = {}) => ({
  filePath: '/data/models/benchy.3mf',
  fileName: 'benchy.3mf',
  sourceKind: 'makerworld',
  ...overrides,
});

const MAKERWORLD_ATTRIBUTION = {
  provider: 'makerworld',
  modelId: '12345',
  profileId: '678',
  title: 'Benchy',
  creator: 'someone',
  licence: 'CC-BY-4.0',
  pageUrl: 'https://makerworld.com/en/models/12345',
};

// --- the happy path --------------------------------------------------------

test('a sound 3MF is scanned, inspected and recorded', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const library = new InMemoryImportLibrary();
  const outcome = await coordinatorOver(files, { library }).import(
    request({ attribution: MAKERWORLD_ATTRIBUTION })
  );

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.fileName, 'benchy.3mf');
  assert.equal(outcome.record.fileKind, '3mf');
  assert.equal(outcome.record.sourceKind, 'makerworld');
  assert.equal(outcome.record.sizeBytes, files.get('/data/models/benchy.3mf').length);
  assert.equal(outcome.record.importedAt, 1_700_000_000_000);
  assert.match(outcome.record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(outcome.record.contents.kind, 'geometry');
  assert.deepEqual(outcome.record.attribution, MAKERWORLD_ATTRIBUTION);

  // It is in the library, keyed by hash, ready to dedupe the next arrival.
  assert.deepEqual(await library.findBySha256(outcome.record.sha256), outcome.record);
});

test('an import with no attribution records unknown rather than inventing one', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const outcome = await coordinatorOver(files).import(request({ sourceKind: 'file-picker' }));

  assert.equal(outcome.status, 'imported');
  assert.deepEqual(outcome.record.attribution, {
    provider: null,
    modelId: null,
    profileId: null,
    title: null,
    creator: null,
    licence: null,
    pageUrl: null,
  });
});

test('a mesh is imported without being scanned as an archive', async () => {
  const files = new Map([['/data/models/part.stl', nameBytes('solid part\nendsolid part\n')]]);
  const io = fakeIo(files, {
    createReader() {
      throw new Error('a mesh must not be opened as an archive');
    },
  });
  const outcome = await coordinatorOver(files, { io }).import(
    request({ filePath: '/data/models/part.stl', fileName: 'part.stl', sourceKind: 'file-picker' })
  );

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.fileKind, 'mesh');
  assert.equal(outcome.record.contents, null);
  assert.deepEqual(outcome.record.notices, []);
});

// --- duplicates ------------------------------------------------------------

test('the same bytes under a different name are a duplicate, not a second import', async () => {
  const archive = threeMf();
  const files = new Map([
    ['/data/models/benchy.3mf', archive],
    ['/data/share/copy-of-benchy.3mf', archive],
  ]);
  const library = new InMemoryImportLibrary();
  const coordinator = coordinatorOver(files, { library });

  const first = await coordinator.import(request({ attribution: MAKERWORLD_ATTRIBUTION }));
  const second = await coordinator.import(
    request({
      filePath: '/data/share/copy-of-benchy.3mf',
      fileName: 'copy-of-benchy.3mf',
      sourceKind: 'android-share',
    })
  );

  assert.equal(first.status, 'imported');
  assert.equal(second.status, 'duplicate');
  // The original record is returned intact — the attribution captured the first
  // time is not overwritten by a later, poorer-provenance arrival.
  assert.equal(second.record.fileName, 'benchy.3mf');
  assert.equal(second.record.sourceKind, 'makerworld');
  assert.deepEqual(second.record.attribution, MAKERWORLD_ATTRIBUTION);
  assert.equal((await library.list()).length, 1);
});

test('different bytes with the same name are two separate imports', async () => {
  const files = new Map([
    ['/data/a/benchy.3mf', threeMf()],
    ['/data/b/benchy.3mf', threeMf([{ name: 'Metadata/plate_1.png', content: nameBytes('x') }])],
  ]);
  const library = new InMemoryImportLibrary();
  const coordinator = coordinatorOver(files, { library });

  const first = await coordinator.import(request({ filePath: '/data/a/benchy.3mf' }));
  const second = await coordinator.import(request({ filePath: '/data/b/benchy.3mf' }));

  assert.equal(first.status, 'imported');
  assert.equal(second.status, 'imported');
  assert.notEqual(first.record.sha256, second.record.sha256);
  assert.equal((await library.list()).length, 2);
});

test('dedupe happens before the archive is opened', async () => {
  // Re-scanning bytes already admitted buys nothing, and the check runs on
  // every import, so it must not cost an archive read.
  const archive = threeMf();
  const files = new Map([['/data/models/benchy.3mf', archive]]);
  const library = new InMemoryImportLibrary();

  await coordinatorOver(files, { library }).import(request());

  const io = fakeIo(files, {
    createReader() {
      throw new Error('a duplicate must not be re-scanned');
    },
  });
  const outcome = await coordinatorOver(files, { library, io }).import(request());
  assert.equal(outcome.status, 'duplicate');
});

// --- archive rejections ----------------------------------------------------

test('a corrupt ZIP is rejected with a visible reason', async () => {
  const broken = threeMf();
  broken[broken.length - 12] ^= 0xff; // corrupt the central directory size
  const files = new Map([['/data/models/benchy.3mf', broken]]);

  const outcome = await coordinatorOver(files).import(request());
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/archive-rejected');
  assert.ok(outcome.message.length > 0);
  assert.ok(outcome.scanFindings.some((finding) => finding.severity === 'reject'));
});

test('a file that is not an archive at all is rejected, not passed to the slicer', async () => {
  const files = new Map([['/data/models/benchy.3mf', nameBytes('<html>Sign in</html>')]]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/archive-rejected');
  assert.ok(outcome.scanFindings.some((finding) => finding.code === 'archive/not-an-archive'));
});

test('a traversal path is rejected before anything is unpacked', async () => {
  const files = new Map([
    ['/data/models/benchy.3mf', threeMf([{ name: '../../etc/passwd', content: nameBytes('x') }])],
  ]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/archive-rejected');
  assert.ok(outcome.scanFindings.some((finding) => finding.code === 'archive/path-traversal'));
});

test('unsupported compression is rejected', async () => {
  const files = new Map([
    ['/data/models/benchy.3mf', threeMf([{ name: 'extra.txt', method: 99, content: nameBytes('x') }])],
  ]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/archive-rejected');
  assert.ok(
    outcome.scanFindings.some((finding) => finding.code === 'archive/unsupported-compression')
  );
});

test('an archive missing the core model part is rejected by the scanner', async () => {
  // This is also how a pre-sliced-only export is caught: with no `3dmodel.model`
  // the required-parts check fires before the content inspection is reached.
  const files = new Map([
    [
      '/data/models/benchy.3mf',
      buildZip([
        { name: '[Content_Types].xml', content: nameBytes('<Types/>') },
        { name: '_rels/.rels', content: nameBytes('<Relationships/>') },
        { name: 'Metadata/plate_1.gcode', content: nameBytes('G1 X0') },
      ]),
    ],
  ]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/archive-rejected');
  assert.ok(
    outcome.scanFindings.some((finding) => finding.code === 'archive/missing-critical-path')
  );
});

// --- content notices -------------------------------------------------------

test('a multi-plate project imports, and says so as a notice', async () => {
  const files = new Map([
    [
      '/data/models/benchy.3mf',
      threeMf([
        { name: 'Metadata/plate_1.png', content: nameBytes('a') },
        { name: 'Metadata/plate_2.png', content: nameBytes('b') },
      ]),
    ],
  ]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.contents.plateCount, 2);
  assert.ok(outcome.record.notices.some((notice) => notice.code === 'content/multi-plate'));
});

test('foreign G-code and a foreign profile are carried as notices, not rejections', async () => {
  const files = new Map([
    [
      '/data/models/benchy.3mf',
      threeMf([
        { name: 'Metadata/project_settings.config', content: nameBytes('{}') },
        { name: 'Metadata/plate_1.gcode', content: nameBytes('G1 X0') },
      ]),
    ],
  ]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.contents.kind, 'geometry-and-gcode');
  const codes = outcome.record.notices.map((notice) => notice.code);
  assert.ok(codes.includes('content/foreign-slice-output'));
  assert.ok(codes.includes('content/foreign-profile'));
});

test('a geometry-only project imports with no notices at all', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const outcome = await coordinatorOver(files).import(request());

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.contents.kind, 'geometry');
  assert.deepEqual(outcome.record.notices, []);
});

// --- the cheap gates, and their order --------------------------------------

test('an unsupported file type is refused before the file is touched', async () => {
  const io = fakeIo(new Map(), {
    async statFile() {
      throw new Error('the type check must come first');
    },
  });
  const outcome = await coordinatorOver(new Map(), { io }).import(
    request({ filePath: '/data/models/sliced.gcode', fileName: 'sliced.gcode' })
  );

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/unsupported-type');
});

test('a missing or empty file is rejected as unreadable', async () => {
  const missing = await coordinatorOver(new Map()).import(request());
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.code, 'import/unreadable');

  const empty = new Map([['/data/models/benchy.3mf', new Uint8Array(0)]]);
  const outcome = await coordinatorOver(empty).import(request());
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/unreadable');
});

test('a stat that throws is a rejection, not a crash', async () => {
  const io = fakeIo(new Map(), {
    async statFile() {
      throw new Error('storage went away');
    },
  });
  const outcome = await coordinatorOver(new Map(), { io }).import(request());
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/unreadable');
});

test('an empty path is rejected without being sanitised into something plausible', async () => {
  const outcome = await coordinatorOver(new Map()).import(request({ filePath: '   ' }));
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/unreadable');
});

test('a file past the size limit is refused before it is hashed', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const io = fakeIo(files, {
    async statFile() {
      return 400 * 1024 * 1024;
    },
    async hashFile() {
      throw new Error('an oversized file must not be hashed');
    },
  });
  const outcome = await coordinatorOver(files, { io }).import(request());

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/too-large');
});

test('a hash failure refuses the import rather than admitting an unidentified file', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const io = fakeIo(files, {
    async hashFile() {
      throw new Error('read error');
    },
  });
  const outcome = await coordinatorOver(files, { io }).import(request());

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/hash-failed');
});

// --- a hash the caller already took ----------------------------------------

test('a hash supplied by the caller is used instead of hashing the file again', async () => {
  const archive = threeMf();
  const files = new Map([['/data/models/benchy.3mf', archive]]);
  const expected = crypto.createHash('sha256').update(archive).digest('hex');
  const io = fakeIo(files, {
    async hashFile() {
      throw new Error('a file hashed by the provider must not be hashed twice');
    },
  });

  const outcome = await coordinatorOver(files, { io }).import(
    request({ knownSha256: expected })
  );
  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.sha256, expected);
});

test('a supplied hash still dedupes against the library', async () => {
  const archive = threeMf();
  const files = new Map([['/data/models/benchy.3mf', archive]]);
  const expected = crypto.createHash('sha256').update(archive).digest('hex');
  const library = new InMemoryImportLibrary();

  await coordinatorOver(files, { library }).import(request());
  const second = await coordinatorOver(files, { library }).import(
    request({ knownSha256: expected.toUpperCase() })
  );
  assert.equal(second.status, 'duplicate');
});

test('a malformed supplied hash is ignored and the file is hashed', async () => {
  const archive = threeMf();
  const files = new Map([['/data/models/benchy.3mf', archive]]);
  const expected = crypto.createHash('sha256').update(archive).digest('hex');

  for (const bad of ['', 'not-a-hash', 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}z`]) {
    const outcome = await coordinatorOver(files).import(request({ knownSha256: bad }));
    assert.equal(outcome.status, 'imported');
    assert.equal(outcome.record.sha256, expected);
  }
});

// --- filenames -------------------------------------------------------------

test('a hostile filename is sanitised before it is stored or shown', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const outcome = await coordinatorOver(files).import(
    request({ fileName: '../../../etc/pass<wd>.3mf' })
  );

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.fileName, 'pass_wd_.3mf');
});

test('a name that sanitises away falls back to the path, not to a guess', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const outcome = await coordinatorOver(files).import(request({ fileName: '' }));

  assert.equal(outcome.status, 'imported');
  assert.equal(outcome.record.fileName, 'benchy.3mf');
});

test('the type check runs on the sanitised name, not the one offered', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const outcome = await coordinatorOver(files).import(
    request({ fileName: 'benchy.3mf/../../evil.gcode' })
  );

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'import/unsupported-type');
});

// --- source detection ------------------------------------------------------

test('a Downloads path is detected as the Downloads folder', () => {
  assert.equal(detectImportSourceFromPath('/storage/emulated/0/Download/benchy.3mf'), 'downloads');
  assert.equal(detectImportSourceFromPath('/storage/emulated/0/Downloads/benchy.3mf'), 'downloads');
});

test('anything else defaults to a share rather than claiming a source it cannot know', () => {
  assert.equal(detectImportSourceFromPath('/data/user/0/org.crabcore.u1control/cache/x.3mf'), 'android-share');
  assert.equal(detectImportSourceFromPath(''), 'android-share');
});

// --- the persistent library ------------------------------------------------

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

test('a stored library survives a restart and still dedupes', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const storage = fakeStorage();

  const first = await coordinatorOver(files, {
    library: new StoredImportLibrary(storage),
  }).import(request());
  assert.equal(first.status, 'imported');

  // A fresh coordinator and a fresh library object, same storage.
  const second = await coordinatorOver(files, {
    library: new StoredImportLibrary(storage),
  }).import(request());
  assert.equal(second.status, 'duplicate');
  assert.equal(second.record.sha256, first.record.sha256);
});

test('a corrupt index reads as empty rather than blocking every import', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const storage = fakeStorage({ [IMPORT_INDEX_KEY]: '{not json' });

  const outcome = await coordinatorOver(files, {
    library: new StoredImportLibrary(storage),
  }).import(request());
  assert.equal(outcome.status, 'imported');
});

test('index entries that are not records are dropped, not trusted', async () => {
  const storage = fakeStorage({
    [IMPORT_INDEX_KEY]: JSON.stringify([
      null,
      'a string',
      { sha256: 'too-short' },
      { sha256: 'a'.repeat(64), fileName: 'ok.3mf', filePath: '/x', sizeBytes: 1, importedAt: 1, sourceKind: 'library', attribution: {} },
    ]),
  });
  const library = new StoredImportLibrary(storage);

  assert.equal((await library.list()).length, 1);
  assert.equal(await library.findBySha256('too-short'), null);
  assert.ok(await library.findBySha256('a'.repeat(64)));
});

test('saving the same hash twice replaces rather than duplicates the entry', async () => {
  const storage = fakeStorage();
  const library = new StoredImportLibrary(storage);
  const record = {
    sha256: 'b'.repeat(64),
    fileName: 'first.3mf',
    filePath: '/x',
    sizeBytes: 1,
    fileKind: '3mf',
    sourceKind: 'library',
    attribution: {},
    importedAt: 1,
    contents: null,
    notices: [],
  };

  await library.save(record);
  await library.save({ ...record, fileName: 'second.3mf', importedAt: 2 });

  const all = await library.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].fileName, 'second.3mf');
});

test('the library is capped, dropping the oldest entries', async () => {
  const storage = fakeStorage();
  const library = new StoredImportLibrary(storage);

  for (let index = 0; index < MAX_STORED_IMPORTS + 5; index += 1) {
    await library.save({
      sha256: index.toString(16).padStart(64, '0'),
      fileName: `model-${index}.3mf`,
      filePath: `/x/${index}`,
      sizeBytes: 1,
      fileKind: '3mf',
      sourceKind: 'library',
      attribution: {},
      importedAt: index,
      contents: null,
      notices: [],
    });
  }

  const all = await library.list();
  assert.equal(all.length, MAX_STORED_IMPORTS);
  // Newest first, so the survivors are the most recent saves.
  assert.equal(all[0].fileName, `model-${MAX_STORED_IMPORTS + 4}.3mf`);
});

test('removing an entry lets the same file be imported again', async () => {
  const files = new Map([['/data/models/benchy.3mf', threeMf()]]);
  const storage = fakeStorage();
  const library = new StoredImportLibrary(storage);

  const first = await coordinatorOver(files, { library }).import(request());
  await library.remove(first.record.sha256);

  const second = await coordinatorOver(files, { library }).import(request());
  assert.equal(second.status, 'imported');
});
