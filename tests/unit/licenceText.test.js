const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const ROOT = path.join(__dirname, '..', '..');

const { buildModule, DOCUMENTS } = require(path.join(ROOT, 'scripts', 'generate-licence-text.js'));
const { LICENCE_DOCUMENTS } = require(path.join(ROOT, 'constants', 'licenceText.ts'));

// The bundled licence text is generated, and generated files rot silently.
// Helix is AGPL-3.0-or-later, so a stale notice is not a cosmetic problem: the
// text the app shows is the text it conveys to whoever holds the APK.

test('the bundled licence text still matches the repository files', () => {
  // Regenerates in memory and compares. Editing LICENSE without re-running
  // `node scripts/generate-licence-text.js` fails here rather than shipping.
  const regenerated = buildModule();
  const onDisk = fs
    .readFileSync(path.join(ROOT, 'constants', 'licenceText.ts'), 'utf8')
    .replace(/\r\n/g, '\n');

  assert.equal(
    onDisk,
    regenerated,
    'constants/licenceText.ts is stale — run: node scripts/generate-licence-text.js'
  );
});

test('every licence document the repository ships is bundled', () => {
  assert.equal(LICENCE_DOCUMENTS.length, DOCUMENTS.length);
  for (const doc of DOCUMENTS) {
    const bundled = LICENCE_DOCUMENTS.find((entry) => entry.key === doc.key);
    assert.ok(bundled, `${doc.key} is not bundled`);
    assert.equal(bundled.sourceFile, doc.file);
    assert.ok(bundled.text.length > 0, `${doc.key} is empty`);
  }
});

test('the bundled licence is the AGPL, not a summary of it', () => {
  // The whole point of compiling it in is that someone offline holds the real
  // terms. A truncated or paraphrased licence would defeat that quietly.
  const licence = LICENCE_DOCUMENTS.find((entry) => entry.key === 'licence');

  assert.ok(licence.text.includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
  assert.ok(licence.text.includes('Version 3, 19 November 2007'));
  // Section 13 is the one that makes this the AGPL rather than the GPL.
  assert.ok(licence.text.includes('Remote Network Interaction'));
  assert.ok(licence.text.length > 30_000, 'the licence looks truncated');
});

test('attribution and third-party notices name their sources', () => {
  const attribution = LICENCE_DOCUMENTS.find((entry) => entry.key === 'attribution');
  const thirdParty = LICENCE_DOCUMENTS.find((entry) => entry.key === 'thirdParty');

  // Helix is a fork; upstream has to be named wherever the licence is shown.
  assert.ok(/helix/i.test(attribution.text));
  assert.ok(thirdParty.text.length > 200);
});

test('line endings are normalised, so a CRLF checkout generates the same file', () => {
  // Without this the drift test would fail for everyone on Windows, which is
  // how a correctness check turns into a check people learn to ignore.
  for (const entry of LICENCE_DOCUMENTS) {
    assert.ok(!entry.text.includes('\r'), `${entry.key} carries CR characters`);
  }
});
