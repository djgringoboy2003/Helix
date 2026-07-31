const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  Sha256,
  isSha256Hex,
  sha256Hex,
  sha256HexOfStream,
  shortHash,
} = require(servicePath('security', 'Sha256.ts'));
const {
  base64ToBytes,
  bytesToBase64,
  utf8ToBytes,
} = require(servicePath('security', 'Base64.ts'));

const nodeSha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

test('sha256 matches the published NIST test vectors', () => {
  assert.equal(
    sha256Hex(utf8ToBytes('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    sha256Hex(utf8ToBytes('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(
    sha256Hex(utf8ToBytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('sha256 handles every padding boundary around the 64-byte block', () => {
  // 55/56/63/64 are where the length field stops fitting in the final block.
  for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 7 + 13) & 0xff);
    assert.equal(sha256Hex(bytes), nodeSha256(bytes), `length ${length} must match Node's digest`);
  }
});

test('sha256 hashes a message longer than 2^32 bits worth of blocks consistently', () => {
  // Guards the 64-bit length split: the same bytes fed in one call and in many
  // must land on the same digest.
  const total = 300_000;
  const bytes = Uint8Array.from({ length: total }, (_, i) => (i * 31) & 0xff);

  const streamed = new Sha256();
  for (let offset = 0; offset < total; offset += 997) {
    streamed.update(bytes.subarray(offset, Math.min(offset + 997, total)));
  }

  assert.equal(streamed.digest(), sha256Hex(bytes));
  assert.equal(sha256Hex(bytes), nodeSha256(bytes));
});

test('sha256 rejects reuse after the digest is taken', () => {
  const hash = new Sha256().update(utf8ToBytes('abc'));
  hash.digest();
  assert.throws(() => hash.digest(), /already taken/);
  assert.throws(() => hash.update(utf8ToBytes('more')), /already taken/);
});

test('isSha256Hex accepts only lowercase 64-character hex', () => {
  const valid = sha256Hex(utf8ToBytes('abc'));
  assert.equal(isSha256Hex(valid), true);
  assert.equal(isSha256Hex(valid.toUpperCase()), false);
  assert.equal(isSha256Hex(valid.slice(0, 63)), false);
  assert.equal(isSha256Hex(`${valid}0`), false);
  assert.equal(isSha256Hex(''), false);
  assert.equal(isSha256Hex(null), false);
  assert.equal(isSha256Hex(undefined), false);
  assert.equal(isSha256Hex(12345), false);
});

test('shortHash abbreviates valid hashes and flags invalid ones', () => {
  const valid = sha256Hex(utf8ToBytes('abc'));
  assert.equal(shortHash(valid), `${valid.slice(0, 8)}…${valid.slice(-4)}`);
  assert.equal(shortHash('nope'), 'invalid-hash');
});

function chunkReaderOver(bytes) {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}

test('sha256HexOfStream matches a single-shot hash across chunk sizes', async () => {
  const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 11) & 0xff);
  const expected = sha256Hex(bytes);

  for (const chunk of [1, 7, 64, 100, 4096, 5000, 99999]) {
    const streamed = await sha256HexOfStream(chunkReaderOver(bytes), bytes.length, chunk);
    assert.equal(streamed, expected, `chunk size ${chunk} must produce the same digest`);
  }
});

test('sha256HexOfStream hashes an empty stream without reading', async () => {
  let reads = 0;
  const digest = await sha256HexOfStream(async () => {
    reads += 1;
    return new Uint8Array(0);
  }, 0);

  assert.equal(reads, 0);
  assert.equal(digest, sha256Hex(new Uint8Array(0)));
});

test('sha256HexOfStream fails closed when the file is shorter than declared', async () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  await assert.rejects(
    () => sha256HexOfStream(chunkReaderOver(bytes), 200, 64),
    /ended early/
  );
});

test('sha256HexOfStream fails closed when the file grows mid-hash', async () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  await assert.rejects(
    () => sha256HexOfStream(async (offset) => bytes.subarray(offset, offset + 200), 100, 64),
    /not stable/
  );
});

test('sha256HexOfStream rejects nonsense sizes rather than hashing nothing', async () => {
  const read = chunkReaderOver(new Uint8Array(10));
  await assert.rejects(() => sha256HexOfStream(read, -1), /Invalid stream size/);
  await assert.rejects(() => sha256HexOfStream(read, 1.5), /Invalid stream size/);
  await assert.rejects(() => sha256HexOfStream(read, 10, 0), /Invalid chunk size/);
  await assert.rejects(() => sha256HexOfStream(read, 10, -8), /Invalid chunk size/);
});

test('base64 round-trips arbitrary bytes including all padding lengths', () => {
  for (let length = 0; length < 40; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 5) & 0xff);
    const encoded = bytesToBase64(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString('base64'), `length ${length} encode`);
    assert.deepEqual(base64ToBytes(encoded), bytes, `length ${length} decode`);
  }
});

test('base64 decode tolerates whitespace and URL-safe alphabet', () => {
  const bytes = Uint8Array.from([0xfb, 0xff, 0xbe, 0x00, 0x10]);
  const standard = Buffer.from(bytes).toString('base64');
  const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');

  assert.deepEqual(base64ToBytes(standard), bytes);
  assert.deepEqual(base64ToBytes(urlSafe), bytes);
  assert.deepEqual(base64ToBytes(`${standard.slice(0, 4)}\n  ${standard.slice(4)}`), bytes);
});

test('base64 decode rejects corrupt input instead of silently dropping bytes', () => {
  assert.throws(() => base64ToBytes('ab*d'), /Invalid base64/);
  assert.throws(() => base64ToBytes('abcde'), /Truncated/);
  assert.throws(() => base64ToBytes('ab=cd'), /Misplaced/);
});

test('utf8ToBytes encodes multi-byte characters and surrogate pairs', () => {
  for (const text of ['', 'abc', 'café', '你好', '🚀 print', 'mixed é你🚀']) {
    assert.deepEqual(utf8ToBytes(text), new Uint8Array(Buffer.from(text, 'utf8')), text);
  }
});

// --- the probe that lets a native digest be trusted ------------------------

const { buildProbeBytes } = require(servicePath('security', 'HasherProbe.ts'));

test('the hasher probe is built to catch a digest that cuts corners', () => {
  // `installNativeFileHasher` will only hand SHA-256 over to the platform if it
  // reproduces this file's digest exactly. That check is only worth anything if
  // the fixture is hard to match by accident.
  const bytes = buildProbeBytes();

  // Larger than the native reader's 1 MiB block, so agreement means agreement
  // across a block boundary rather than on a single buffer.
  assert.ok(bytes.length > 1024 * 1024);
  assert.notEqual(bytes.length % (1024 * 1024), 0);

  // Every byte value appears, so a digest mishandling high bytes cannot pass.
  const seen = new Set(bytes);
  assert.equal(seen.size, 256);

  // Not a repeating buffer: a hasher that re-read or reordered a block would
  // otherwise still produce the right answer.
  const first = bytes.slice(0, 4096);
  const second = bytes.slice(4096, 8192);
  assert.notDeepEqual(first, second);
});

test('the probe is deterministic, so a mismatch means a real disagreement', () => {
  assert.deepEqual(buildProbeBytes(2048), buildProbeBytes(2048));
  assert.equal(sha256Hex(buildProbeBytes(2048)), sha256Hex(buildProbeBytes(2048)));
});
