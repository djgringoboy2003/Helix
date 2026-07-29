const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  DEFAULT_SCAN_LIMITS,
  REQUIRED_3MF_PATHS,
  rejectionsOf,
  scanThreeMfArchive,
  scanZipEntries,
} = require(servicePath('import', 'ThreeMfSecurityScanner.ts'));
const { readZipEntries } = require(servicePath('import', 'ZipDirectory.ts'));

// --- ZIP builder -----------------------------------------------------------
// Emits a real archive (local headers, central directory, EOCD) so the reader
// is exercised against the same layout a downloaded 3MF has. Entry data is
// stored, but sizes are declarable so bombs can be described without building
// one.

function bytes(...values) {
  return Uint8Array.from(values);
}

function u16(value) {
  return bytes(value & 0xff, (value >> 8) & 0xff);
}

function u32(value) {
  return bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function nameBytes(name) {
  return name instanceof Uint8Array ? name : new Uint8Array(Buffer.from(name, 'utf8'));
}

function buildZip(specs, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const spec of specs) {
    const rawName = nameBytes(spec.name);
    const content = spec.content ?? new Uint8Array(0);
    const compressedSize = spec.compressedSize ?? content.length;
    const uncompressedSize = spec.uncompressedSize ?? content.length;
    const method = spec.method ?? 0;
    const flags = spec.flags ?? 0x0800; // UTF-8 names
    const externalAttributes = spec.externalAttributes ?? 0;

    const local = concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(0), u32(compressedSize), u32(uncompressedSize), u16(rawName.length), u16(0),
      rawName, content,
    ]);
    locals.push(local);

    centrals.push(
      concat([
        u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
        u32(0), u32(compressedSize), u32(uncompressedSize),
        u16(rawName.length), u16(0), u16(0), u16(0), u16(0),
        u32(externalAttributes), u32(offset), rawName,
      ])
    );
    offset += local.length;
  }

  const centralDirectory = concat(centrals);
  const comment = nameBytes(options.comment ?? '');
  const declaredCount = options.declaredEntryCount ?? specs.length;

  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(declaredCount), u16(declaredCount),
    u32(centralDirectory.length), u32(offset), u16(comment.length), comment,
  ]);

  return concat([...locals, centralDirectory, eocd]);
}

const readerOver = (archive) => async (at, length) => archive.subarray(at, at + length);

/** A minimal but structurally valid 3MF. */
function validThreeMf(extra = []) {
  return buildZip([
    { name: '[Content_Types].xml', content: nameBytes('<Types/>') },
    { name: '_rels/.rels', content: nameBytes('<Relationships/>') },
    { name: '3D/3dmodel.model', content: nameBytes('<model/>') },
    ...extra,
  ]);
}

async function scan(archive, limits = DEFAULT_SCAN_LIMITS) {
  return scanThreeMfArchive(readerOver(archive), archive.length, limits);
}

const codesOf = (report) => report.findings.map((item) => item.code);

// --- reading ---------------------------------------------------------------

test('reads the entry list of a well-formed 3MF', async () => {
  const archive = validThreeMf();
  const entries = await readZipEntries(readerOver(archive), archive.length);

  assert.deepEqual(entries.map((entry) => entry.name), REQUIRED_3MF_PATHS);
  assert.equal(entries[0].encrypted, false);
  assert.equal(entries[0].isSymlink, false);
  assert.equal(entries[0].isDirectory, false);
});

test('a valid 3MF passes the scan cleanly', async () => {
  const report = await scan(validThreeMf());
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(rejectionsOf(report), []);
  assert.equal(report.entryCount, 3);
});

test('an archive with a trailing comment is still read correctly', async () => {
  const archive = buildZip(
    [
      { name: '[Content_Types].xml', content: nameBytes('<Types/>') },
      { name: '_rels/.rels', content: nameBytes('<r/>') },
      { name: '3D/3dmodel.model', content: nameBytes('<model/>') },
    ],
    { comment: 'built by a slicer' }
  );

  const report = await scan(archive);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('files that are not archives are rejected, not thrown', async () => {
  const notZip = nameBytes('this is a plain text file, not a 3MF at all');
  const report = await scan(notZip);

  assert.equal(report.ok, false);
  assert.deepEqual(codesOf(report), ['archive/not-an-archive']);
});

test('a truncated or tampered archive is reported as malformed', async () => {
  const archive = validThreeMf();

  const truncated = archive.subarray(0, archive.length - 10);
  assert.equal((await scan(truncated)).ok, false);

  // Trailing junk after the EOCD means the file is not simply a ZIP.
  const withJunk = concat([archive, nameBytes('APPENDED')]);
  const junkReport = await scan(withJunk);
  assert.equal(junkReport.ok, false);
  assert.ok(codesOf(junkReport).includes('archive/malformed'));

  // An entry count that disagrees with the directory contents.
  const miscounted = buildZip(
    [
      { name: '[Content_Types].xml' },
      { name: '_rels/.rels' },
      { name: '3D/3dmodel.model' },
    ],
    { declaredEntryCount: 9 }
  );
  assert.equal((await scan(miscounted)).ok, false);
});

test('an empty file is rejected rather than treated as an empty archive', async () => {
  const report = await scan(new Uint8Array(0));
  assert.equal(report.ok, false);
  assert.deepEqual(codesOf(report), ['archive/not-an-archive']);
});

// --- path safety -----------------------------------------------------------

test('path traversal in any position is rejected', async () => {
  const hostile = [
    '../evil.model',
    '3D/../../evil.model',
    'a/b/../../../evil.model',
    '3D/../../../../data/data/org.crabcore.u1control/files/evil',
  ];

  for (const name of hostile) {
    const report = await scan(validThreeMf([{ name }]));
    assert.equal(report.ok, false, name);
    assert.ok(codesOf(report).includes('archive/path-traversal'), name);
  }
});

test('absolute, drive-letter and backslash paths are rejected', async () => {
  const cases = [
    ['/etc/passwd', 'archive/absolute-path'],
    ['C:/Windows/system32/evil.dll', 'archive/drive-letter-path'],
    ['3D\\..\\..\\evil.model', 'archive/backslash-path'],
  ];

  for (const [name, code] of cases) {
    const report = await scan(validThreeMf([{ name }]));
    assert.equal(report.ok, false, name);
    assert.ok(codesOf(report).includes(code), `${name} expected ${code}, got ${codesOf(report)}`);
  }
});

test('an over-long path is rejected', async () => {
  const report = await scan(validThreeMf([{ name: `3D/${'a'.repeat(600)}.model` }]));
  assert.equal(report.ok, false);
  assert.ok(codesOf(report).includes('archive/path-too-long'));
});

test('invalid UTF-8 and control characters in names are rejected', async () => {
  const invalidUtf8 = Uint8Array.from([0x33, 0x44, 0x2f, 0xff, 0xfe, 0x2e, 0x78]);
  const utf8Report = await scan(validThreeMf([{ name: invalidUtf8 }]));
  assert.equal(utf8Report.ok, false);
  assert.ok(codesOf(utf8Report).includes('archive/invalid-utf8-path'));

  const withControl = Uint8Array.from([0x33, 0x44, 0x2f, 0x07, 0x78, 0x2e, 0x78]);
  const controlReport = await scan(validThreeMf([{ name: withControl }]));
  assert.equal(controlReport.ok, false);
  assert.ok(codesOf(controlReport).includes('archive/control-character-path'));

  // A hostile name must not carry its control characters into the report.
  for (const item of controlReport.findings) {
    if (item.entryName) assert.doesNotMatch(item.entryName, /[\u0000-\u001f]/);
  }
});

// --- entry kinds -----------------------------------------------------------

test('symlink entries are rejected', async () => {
  // Unix mode 0xA1FF (S_IFLNK | 0777) in the high half of external attributes.
  const report = await scan(validThreeMf([{ name: '3D/link', externalAttributes: 0xa1ff0000 }]));
  assert.equal(report.ok, false);
  assert.ok(codesOf(report).includes('archive/symlink-entry'));
});

test('encrypted entries are rejected', async () => {
  const report = await scan(validThreeMf([{ name: '3D/secret.model', flags: 0x0801 }]));
  assert.equal(report.ok, false);
  assert.ok(codesOf(report).includes('archive/encrypted-entry'));
});

test('unsupported compression methods are rejected', async () => {
  for (const method of [1, 6, 12, 14, 98]) {
    const report = await scan(validThreeMf([{ name: `3D/part${method}.model`, method }]));
    assert.equal(report.ok, false, `method ${method}`);
    assert.ok(codesOf(report).includes('archive/unsupported-compression'), `method ${method}`);
  }

  // Store and deflate are the two the app supports.
  for (const method of [0, 8]) {
    const report = await scan(validThreeMf([{ name: `3D/part${method}.model`, method, compressedSize: 10, uncompressedSize: 12 }]));
    assert.equal(report.ok, true, `method ${method}: ${JSON.stringify(report.findings)}`);
  }
});

test('nested archives are rejected', async () => {
  for (const name of ['payload.zip', '3D/inner.3mf', 'stuff.tar.gz', 'lib.jar']) {
    const report = await scan(validThreeMf([{ name }]));
    assert.equal(report.ok, false, name);
    assert.ok(codesOf(report).includes('archive/nested-archive'), name);
  }
});

// --- size limits and bombs -------------------------------------------------

test('a decompression bomb is caught from its declared ratio alone', async () => {
  // 1 KB compressed claiming 1 GB expanded — never inflated to find out.
  const report = await scan(
    validThreeMf([
      { name: '3D/bomb.model', method: 8, compressedSize: 1024, uncompressedSize: 1024 * 1024 * 1024 },
    ])
  );

  assert.equal(report.ok, false);
  assert.ok(codesOf(report).includes('archive/compression-bomb'));
});

test('a large but honestly stored entry is not mistaken for a bomb', async () => {
  const report = await scan(
    validThreeMf([{ name: '3D/big.model', method: 0, compressedSize: 40_000_000, uncompressedSize: 40_000_000 }])
  );

  assert.equal(codesOf(report).includes('archive/compression-bomb'), false);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('each size limit is enforced', async () => {
  const cases = [
    ['archive/entry-too-large', { name: '3D/huge.model', method: 8, compressedSize: 600_000_000, uncompressedSize: 600_000_000 }],
    ['archive/xml-too-large', { name: '3D/huge.xml', method: 8, compressedSize: 200_000_000, uncompressedSize: 200_000_000 }],
  ];

  for (const [code, entry] of cases) {
    const report = await scan(validThreeMf([entry]));
    assert.equal(report.ok, false, code);
    assert.ok(codesOf(report).includes(code), `expected ${code}, got ${codesOf(report)}`);
  }
});

test('the archive, expanded and entry-count limits are enforced', async () => {
  const archive = validThreeMf();

  const tinyArchiveLimit = await scan(archive, { ...DEFAULT_SCAN_LIMITS, maxArchiveBytes: 10 });
  assert.ok(codesOf(tinyArchiveLimit).includes('archive/too-large'));

  const tinyExpandedLimit = await scan(archive, { ...DEFAULT_SCAN_LIMITS, maxExpandedBytes: 1 });
  assert.ok(codesOf(tinyExpandedLimit).includes('archive/expanded-too-large'));

  const tinyEntryLimit = await scan(archive, { ...DEFAULT_SCAN_LIMITS, maxEntries: 2 });
  assert.ok(codesOf(tinyEntryLimit).includes('archive/too-many-entries'));
});

// --- structure -------------------------------------------------------------

test('duplicate paths are rejected, and duplicated required parts get their own code', async () => {
  const duplicateOrdinary = await scan(validThreeMf([{ name: '3D/extra.model' }, { name: '3D/extra.model' }]));
  assert.equal(duplicateOrdinary.ok, false);
  assert.ok(codesOf(duplicateOrdinary).includes('archive/duplicate-path'));

  const duplicateCritical = await scan(validThreeMf([{ name: '3D/3dmodel.model' }]));
  assert.equal(duplicateCritical.ok, false);
  assert.ok(codesOf(duplicateCritical).includes('archive/duplicate-critical-path'));
});

test('a missing required part is reported by name', async () => {
  const withoutModel = buildZip([
    { name: '[Content_Types].xml', content: nameBytes('<Types/>') },
    { name: '_rels/.rels', content: nameBytes('<r/>') },
  ]);

  const report = await scan(withoutModel);
  assert.equal(report.ok, false);
  const missing = report.findings.filter((item) => item.code === 'archive/missing-critical-path');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].entryName, '3D/3dmodel.model');
  assert.ok(codesOf(report).includes('archive/no-geometry'));
});

test('missing geometry is a warning, not a rejection, when the archive is otherwise sound', () => {
  const entries = REQUIRED_3MF_PATHS.map((name) => ({
    name,
    rawNameBytes: new Uint8Array(Buffer.from(name, 'utf8')),
    compressedSize: 10,
    uncompressedSize: 10,
    compressionMethod: 8,
    encrypted: false,
    utf8Names: true,
    isDirectory: false,
    isSymlink: false,
    localHeaderOffset: 0,
  }));

  const report = scanZipEntries(entries, 1000);
  assert.equal(report.ok, true, JSON.stringify(report.findings));

  const noModel = entries.filter((entry) => !entry.name.endsWith('.model'));
  const warned = scanZipEntries(noModel, 1000);
  const geometry = warned.findings.filter((item) => item.code === 'archive/no-geometry');
  assert.equal(geometry.length, 1);
  assert.equal(geometry[0].severity, 'warn');
});

test('directory entries are exempt from file-only checks', async () => {
  const report = await scan(validThreeMf([{ name: '3D/', method: 0 }, { name: 'Metadata/', method: 0 }]));
  assert.equal(report.ok, true, JSON.stringify(report.findings));
});

test('one archive can report several independent problems at once', async () => {
  const report = await scan(
    validThreeMf([
      { name: '../escape.model' },
      { name: '/absolute.model' },
      { name: 'payload.zip' },
      { name: '3D/enc.model', flags: 0x0801 },
    ])
  );

  assert.equal(report.ok, false);
  for (const expected of [
    'archive/path-traversal',
    'archive/absolute-path',
    'archive/nested-archive',
    'archive/encrypted-entry',
  ]) {
    assert.ok(codesOf(report).includes(expected), `expected ${expected}`);
  }
});
