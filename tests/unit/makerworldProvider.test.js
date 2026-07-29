const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  MAKERWORLD_PROVIDER_ID,
  MakerWorldWebViewProvider,
  referenceFromParsedUrl,
} = require(servicePath('makerworld', 'MakerWorldWebViewProvider.ts'));
const {
  clearModelSourceProviders,
  findProviderForUrl,
  getModelSourceProvider,
  listModelSourceProviders,
  registerModelSourceProvider,
} = require(servicePath('makerworld', 'ModelSourceProvider.ts'));
const { parseMakerWorldUrl } = require(servicePath('makerworld', 'MakerWorldUrlParser.ts'));
const { sha256Hex } = require(servicePath('security', 'Sha256.ts'));
const { utf8ToBytes } = require(servicePath('security', 'Base64.ts'));

const T0 = 1_700_000_000_000;
const FILE_HASH = sha256Hex(utf8ToBytes('3mf-bytes'));

const MODEL = {
  provider: MAKERWORLD_PROVIDER_ID,
  modelId: '1234567',
  profileId: '987',
  title: '',
  creator: '',
  licence: null,
  pageUrl: 'https://makerworld.com/en/models/1234567#profileId-987',
};

function bridge(overrides = {}) {
  return {
    hasSession: async () => true,
    openBrowser: async () => {},
    currentUrl: async () => 'https://makerworld.com/en/models/1234567#profileId-987',
    runDownload: async () => ({
      sourceUrl: 'https://public-cdn.bblmw.com/signed/model.3mf?sig=secret',
      suggestedName: 'Cool Bracket.3mf',
      filePath: '/data/user/0/app/files/makerworld_1234567.3mf',
      sizeBytes: 2048,
    }),
    hashFile: async () => FILE_HASH,
    now: () => T0,
    ...overrides,
  };
}

test('the provider recognises MakerWorld URLs and refuses look-alikes', () => {
  const provider = new MakerWorldWebViewProvider(bridge());
  assert.equal(provider.id, MAKERWORLD_PROVIDER_ID);
  assert.equal(provider.supportsUrl('https://makerworld.com/en/models/1'), true);
  assert.equal(provider.supportsUrl('https://evil.example/makerworld.com/models/1'), false);
  assert.equal(provider.parseUrl('https://makerworld.com/en/models/1').modelId, '1');
});

test('session status reports unknown rather than signed-out when the check fails', async () => {
  const signedIn = await new MakerWorldWebViewProvider(bridge()).getSessionStatus();
  assert.equal(signedIn.state, 'signed-in');
  assert.equal(signedIn.checkedAt, T0);

  const signedOut = await new MakerWorldWebViewProvider(bridge({ hasSession: async () => false })).getSessionStatus();
  assert.equal(signedOut.state, 'signed-out');

  const broken = await new MakerWorldWebViewProvider(
    bridge({ hasSession: async () => { throw new Error('native module unavailable'); } })
  ).getSessionStatus();
  assert.equal(broken.state, 'unknown');
  assert.equal(broken.accountLabel, null);
});

test('browsing falls back to the MakerWorld home page for an unusable URL', async () => {
  const opened = [];
  const provider = new MakerWorldWebViewProvider(bridge({ openBrowser: async (url) => void opened.push(url) }));

  await provider.openBrowseUrl();
  await provider.openBrowseUrl('https://makerworld.com/en/models/42');
  await provider.openBrowseUrl('https://evil.example/phish');

  assert.deepEqual(opened, [
    'https://makerworld.com/en',
    'https://makerworld.com/en/models/42',
    'https://makerworld.com/en',
  ]);
});

test('the current model is resolved only from a real model page', async () => {
  const onModel = await new MakerWorldWebViewProvider(bridge()).resolveCurrentModel();
  assert.equal(onModel.modelId, '1234567');
  assert.equal(onModel.profileId, '987');
  assert.equal(onModel.title, '', 'metadata comes from the 3MF, not the URL');

  for (const url of [null, 'https://makerworld.com/en', 'https://evil.example/models/1']) {
    const provider = new MakerWorldWebViewProvider(bridge({ currentUrl: async () => url }));
    assert.equal(await provider.resolveCurrentModel(), null, String(url));
  }
});

test('a completed download becomes an artifact hashed from the file on disk', async () => {
  const provider = new MakerWorldWebViewProvider(bridge());
  const artifact = await provider.downloadProfile({ model: MODEL, targetDirectory: '/data/files' });

  assert.equal(artifact.provider, MAKERWORLD_PROVIDER_ID);
  assert.equal(artifact.modelId, '1234567');
  assert.equal(artifact.profileId, '987');
  assert.equal(artifact.fileName, 'Cool Bracket.3mf');
  assert.equal(artifact.sizeBytes, 2048);
  assert.equal(artifact.sha256, FILE_HASH);
  assert.equal(artifact.downloadedAt, T0);
  assert.equal(artifact.source, MODEL);
});

test('a download from an unapproved host is rejected after the fact', async () => {
  const provider = new MakerWorldWebViewProvider(
    bridge({
      runDownload: async () => ({
        sourceUrl: 'https://evil.example/model.3mf',
        suggestedName: 'model.3mf',
        filePath: '/data/files/model.3mf',
        sizeBytes: 2048,
      }),
    })
  );

  await assert.rejects(
    () => provider.downloadProfile({ model: MODEL, targetDirectory: '/data/files' }),
    (error) => error.name === 'ModelSourceError' && error.reason === 'policy-rejected'
  );
});

test('a hostile suggested filename is sanitised, not used', async () => {
  const provider = new MakerWorldWebViewProvider(
    bridge({
      runDownload: async () => ({
        sourceUrl: 'https://public-cdn.bblmw.com/signed/model.3mf',
        suggestedName: '../../../data/data/org.crabcore.u1control/evil.3mf',
        filePath: '/data/files/model.3mf',
        sizeBytes: 2048,
      }),
    })
  );

  const artifact = await provider.downloadProfile({ model: MODEL, targetDirectory: '/data/files' });
  assert.equal(artifact.fileName, 'evil.3mf');
});

test('an unusable filename falls back to a name derived from the model id', async () => {
  const provider = new MakerWorldWebViewProvider(
    bridge({
      runDownload: async () => ({
        sourceUrl: 'https://public-cdn.bblmw.com/signed/model.3mf',
        suggestedName: '...',
        filePath: '/data/files/model.3mf',
        sizeBytes: 2048,
      }),
    })
  );

  const artifact = await provider.downloadProfile({ model: MODEL, targetDirectory: '/data/files' });
  assert.equal(artifact.fileName, 'makerworld_1234567.3mf');
});

test('empty, oversized and cancelled downloads each fail with their own reason', async () => {
  const cases = [
    ['empty-file', bridge({ runDownload: async () => ({ sourceUrl: 'https://makerworld.com/f.3mf', suggestedName: 'f.3mf', filePath: '/f', sizeBytes: 0 }) })],
    ['policy-rejected', bridge({ runDownload: async () => ({ sourceUrl: 'https://makerworld.com/f.3mf', suggestedName: 'f.3mf', filePath: '/f', sizeBytes: 900 * 1024 * 1024 }) })],
    ['cancelled', bridge({ runDownload: async () => null })],
  ];

  for (const [reason, deps] of cases) {
    const provider = new MakerWorldWebViewProvider(deps);
    await assert.rejects(
      () => provider.downloadProfile({ model: MODEL, targetDirectory: '/data/files' }),
      (error) => error.reason === reason,
      reason
    );
  }
});

test('an already-aborted request never reaches the download screen', async () => {
  let opened = false;
  const provider = new MakerWorldWebViewProvider(
    bridge({ runDownload: async () => { opened = true; return null; } })
  );

  await assert.rejects(
    () => provider.downloadProfile({ model: MODEL, targetDirectory: '/d', signal: { aborted: true } }),
    (error) => error.reason === 'cancelled'
  );
  assert.equal(opened, false);
});

test('a reference built from a URL carries no invented metadata', () => {
  const reference = referenceFromParsedUrl(parseMakerWorldUrl('https://makerworld.com/de/models/55-slug#profileId-7'));
  assert.deepEqual(reference, {
    provider: MAKERWORLD_PROVIDER_ID,
    modelId: '55',
    profileId: '7',
    title: '',
    creator: '',
    licence: null,
    pageUrl: 'https://makerworld.com/de/models/55#profileId-7',
  });
});

test('the provider registry resolves a URL to its provider', () => {
  clearModelSourceProviders();
  const provider = new MakerWorldWebViewProvider(bridge());
  registerModelSourceProvider(provider);

  assert.equal(getModelSourceProvider(MAKERWORLD_PROVIDER_ID), provider);
  assert.equal(getModelSourceProvider('nope'), null);
  assert.equal(listModelSourceProviders().length, 1);
  assert.equal(findProviderForUrl('https://makerworld.com/en/models/1'), provider);
  assert.equal(findProviderForUrl('https://printables.com/model/1'), null);

  clearModelSourceProviders();
  assert.equal(listModelSourceProviders().length, 0);
});
