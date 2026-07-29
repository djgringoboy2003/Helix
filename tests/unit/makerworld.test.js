const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  browseUrl,
  findMakerWorldUrl,
  isMakerWorldHost,
  modelUrl,
  parseMakerWorldUrl,
  supportsUrl,
} = require(servicePath('makerworld', 'MakerWorldUrlParser.ts'));
const {
  MAX_DOWNLOAD_BYTES,
  MAX_REDIRECTS,
  checkDownloadFilename,
  checkDownloadSize,
  checkDownloadUrl,
  checkReceivedBytes,
  checkRedirectChain,
  hasSupportedModelExtension,
  isAllowedDownloadHost,
  sanitizeDownloadFilename,
} = require(servicePath('makerworld', 'DownloadHostPolicy.ts'));

// --- URL parsing -----------------------------------------------------------

test('parses the MakerWorld model URL shapes the app actually receives', () => {
  const cases = [
    ['https://makerworld.com/en/models/1234567', '1234567', null, 'en'],
    ['https://makerworld.com/models/1234567', '1234567', null, null],
    ['https://www.makerworld.com/en/models/1234567', '1234567', null, 'en'],
    ['https://makerworld.com/zh/models/1234567-cool-bracket', '1234567', null, 'zh'],
    ['https://makerworld.com/en/models/1234567#profileId-987', '1234567', '987', 'en'],
    ['https://makerworld.com/en/models/1234567?from=search', '1234567', null, 'en'],
    ['https://makerworld.com/en/models/1234567?profileId=987', '1234567', '987', 'en'],
    ['https://makerworld.com/en/models/1234567?instanceId=987', '1234567', '987', 'en'],
    ['makerworld.com/en/models/1234567', '1234567', null, 'en'],
    ['  https://makerworld.com/en/models/1234567/  ', '1234567', null, 'en'],
    ['https://makerworld.com/en-us/models/1234567', '1234567', null, 'en-us'],
  ];

  for (const [url, modelId, profileId, locale] of cases) {
    const parsed = parseMakerWorldUrl(url);
    assert.ok(parsed, `${url} should parse`);
    assert.equal(parsed.modelId, modelId, url);
    assert.equal(parsed.profileId, profileId, url);
    assert.equal(parsed.locale, locale, url);
    assert.equal(parsed.provider, 'makerworld');
    assert.equal(parsed.kind, profileId ? 'profile' : 'model', url);
  }
});

test('rejects look-alike hosts that merely mention makerworld.com', () => {
  const hostile = [
    'https://evil.example/makerworld.com/models/1234567',
    'https://makerworld.com.evil.example/en/models/1234567',
    'https://notmakerworld.com/en/models/1234567',
    'https://makerworld.com@evil.example/en/models/1234567',
    'https://evil.example/?u=https://makerworld.com/en/models/1234567',
    'ftp://makerworld.com/en/models/1234567',
    'javascript:fetch("https://makerworld.com/en/models/1")',
    'https://makerworld.com:8080/en/models/1234567',
    '',
    '   ',
  ];

  for (const url of hostile) {
    assert.equal(parseMakerWorldUrl(url), null, `${url} must not parse`);
    assert.equal(supportsUrl(url), false, `${url} must not be supported`);
  }
});

test('a non-model MakerWorld page is recognised as browsing, not as a model', () => {
  for (const url of ['https://makerworld.com/en', 'https://makerworld.com/', 'https://makerworld.com/en/search?q=box']) {
    const parsed = parseMakerWorldUrl(url);
    assert.ok(parsed, url);
    assert.equal(parsed.kind, 'browse', url);
    assert.equal(parsed.modelId, '', url);
  }
});

test('a models path without a numeric id is refused rather than guessed at', () => {
  for (const url of [
    'https://makerworld.com/en/models/not-a-number',
    'https://makerworld.com/en/models/abc123',
    'https://makerworld.com/en/models/',
  ]) {
    const parsed = parseMakerWorldUrl(url);
    assert.ok(parsed === null || parsed.kind === 'browse', `${url} must not yield a model id`);
  }
});

test('canonical URLs are rebuilt from recognised parts, never echoed back', () => {
  const parsed = parseMakerWorldUrl('https://www.makerworld.com/en/models/1234567-slug?utm_source=x#profileId-987');
  assert.equal(parsed.canonicalUrl, 'https://makerworld.com/en/models/1234567#profileId-987');
  assert.equal(modelUrl('42'), 'https://makerworld.com/en/models/42');
  assert.equal(modelUrl('42', '7', 'de'), 'https://makerworld.com/de/models/42#profileId-7');
  assert.equal(browseUrl(), 'https://makerworld.com/en');
  assert.equal(browseUrl(null), 'https://makerworld.com');
});

test('host recognition is exact and case-insensitive', () => {
  assert.equal(isMakerWorldHost('MakerWorld.com'), true);
  assert.equal(isMakerWorldHost(' www.makerworld.com '), true);
  assert.equal(isMakerWorldHost('cdn.makerworld.com'), false);
  assert.equal(isMakerWorldHost('makerworld.com.evil.example'), false);
});

test('finds a model link inside shared text and ignores surrounding prose', () => {
  const shared = findMakerWorldUrl('Check this out! https://makerworld.com/en/models/1234567#profileId-99 — nice print.');
  assert.ok(shared);
  assert.equal(shared.modelId, '1234567');
  assert.equal(shared.profileId, '99');

  assert.equal(findMakerWorldUrl('no links here'), null);
  assert.equal(findMakerWorldUrl('https://makerworld.com/en'), null, 'a browse link is not a model');
  assert.equal(findMakerWorldUrl('https://evil.example/makerworld.com/models/1'), null);
});

test('trailing sentence punctuation is not treated as part of the link', () => {
  const parsed = findMakerWorldUrl('Try https://makerworld.com/en/models/1234567.');
  assert.ok(parsed);
  assert.equal(parsed.modelId, '1234567');
});

// --- download policy -------------------------------------------------------

test('only approved HTTPS hosts may serve a download', () => {
  const allowed = [
    'https://makerworld.com/file.3mf',
    'https://www.makerworld.com/file.3mf',
    'https://cdn.makerworld.com/file.3mf',
    'https://public-cdn.bblmw.com/signed/file.3mf?sig=abc',
    'https://makerworld.bblmw.com/file.3mf',
    'https://makerworld.com:443/file.3mf',
  ];
  for (const url of allowed) assert.equal(checkDownloadUrl(url).ok, true, url);

  const refused = [
    ['http://makerworld.com/file.3mf', 'download/insecure-scheme'],
    ['https://evil.example/file.3mf', 'download/host-not-allowed'],
    ['https://bblmw.com.evil.example/file.3mf', 'download/host-not-allowed'],
    ['https://user:pass@makerworld.com/file.3mf', 'download/credentials-in-url'],
    ['https://makerworld.com:8443/file.3mf', 'download/port-not-allowed'],
    ['not a url', 'download/unparseable-url'],
    ['', 'download/unparseable-url'],
  ];
  for (const [url, code] of refused) {
    const check = checkDownloadUrl(url);
    assert.equal(check.ok, false, url);
    assert.equal(check.code, code, url);
  }
});

test('the allowlist matches subdomains only for entries that opt in', () => {
  assert.equal(isAllowedDownloadHost('bblmw.com'), true);
  assert.equal(isAllowedDownloadHost('a.b.bblmw.com'), true);
  assert.equal(isAllowedDownloadHost('MAKERWORLD.COM'), true);
  assert.equal(isAllowedDownloadHost('makerworld.com.'), true, 'trailing root dot is the same host');
  assert.equal(isAllowedDownloadHost('evilbblmw.com'), false);
  assert.equal(isAllowedDownloadHost('bblmw.com.evil.example'), false);
  assert.equal(isAllowedDownloadHost(''), false);
});

test('every hop of a redirect chain is checked, not just the last', () => {
  const good = ['https://makerworld.com/a', 'https://public-cdn.bblmw.com/b'];
  assert.equal(checkRedirectChain(good).ok, true);

  const detour = ['https://makerworld.com/a', 'https://evil.example/b', 'https://makerworld.com/c'];
  assert.equal(checkRedirectChain(detour).code, 'download/host-not-allowed');

  const tooMany = Array.from({ length: MAX_REDIRECTS + 2 }, () => 'https://makerworld.com/a');
  assert.equal(checkRedirectChain(tooMany).code, 'download/too-many-redirects');
});

test('size limits apply to both the declared and the received length', () => {
  assert.equal(checkDownloadSize(1024).ok, true);
  assert.equal(checkDownloadSize(null).ok, true, 'unknown up front is tolerated; streaming still caps it');
  assert.equal(checkDownloadSize(MAX_DOWNLOAD_BYTES).ok, true);
  assert.equal(checkDownloadSize(MAX_DOWNLOAD_BYTES + 1).code, 'download/too-large');
  assert.equal(checkDownloadSize(-1).code, 'download/size-unknown');
  assert.equal(checkDownloadSize(Number.NaN).code, 'download/size-unknown');

  assert.equal(checkReceivedBytes(MAX_DOWNLOAD_BYTES).ok, true);
  assert.equal(checkReceivedBytes(MAX_DOWNLOAD_BYTES + 1).code, 'download/too-large');
  assert.equal(checkReceivedBytes(11, 10).code, 'download/too-large');
});

test('server-supplied filenames cannot escape the download directory', () => {
  assert.equal(sanitizeDownloadFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeDownloadFilename('..\\..\\windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(sanitizeDownloadFilename('/absolute/path/model.3mf'), 'model.3mf');
  assert.equal(sanitizeDownloadFilename('..'), 'model.3mf', 'a name that is only dots falls back');
  assert.equal(sanitizeDownloadFilename('.hidden.3mf'), 'hidden.3mf');
  assert.equal(sanitizeDownloadFilename(''), 'model.3mf');
  assert.equal(sanitizeDownloadFilename('   '), 'model.3mf');
});

test('filename sanitising strips control characters and reserved device names', () => {
  assert.equal(sanitizeDownloadFilename('mo del.3mf'), 'model.3mf');
  assert.equal(sanitizeDownloadFilename('ab.3mf'), 'ab.3mf');
  assert.equal(sanitizeDownloadFilename('con.3mf'), '_con.3mf');
  assert.equal(sanitizeDownloadFilename('LPT1'), '_LPT1');
  assert.equal(sanitizeDownloadFilename('bad<>:"|?*name.3mf'), 'bad_______name.3mf');
  assert.equal(sanitizeDownloadFilename('Sensible Model Name.3mf'), 'Sensible Model Name.3mf');
});

test('long filenames are truncated but keep their extension', () => {
  const long = `${'x'.repeat(300)}.3mf`;
  const safe = sanitizeDownloadFilename(long);
  assert.ok(safe.length <= 120, `expected <= 120 chars, got ${safe.length}`);
  assert.ok(safe.endsWith('.3mf'));
});

test('extension is reported, not trusted, and an unusable name is refused', () => {
  assert.equal(hasSupportedModelExtension('model.3MF'), true);
  assert.equal(hasSupportedModelExtension('model.stl'), true);
  assert.equal(hasSupportedModelExtension('model.gcode'), false);
  assert.equal(hasSupportedModelExtension('model.3mf.exe'), false);

  assert.equal(checkDownloadFilename('model.3mf').ok, true);
  assert.equal(checkDownloadFilename('...').code, 'download/bad-filename');
});
