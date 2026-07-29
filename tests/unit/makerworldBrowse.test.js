const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  MAKERWORLD_DOWNLOAD_HOOK,
  MAKERWORLD_LOCATION_HOOK,
  MAX_HOOK_MESSAGE_BYTES,
  filenameFromUrl,
  isModelFileUrl,
  parseHookMessage,
} = require(servicePath('makerworld', 'WebViewDownloadCapture.ts'));
const {
  canImportFrom,
  describeLocation,
  exploreStartUrl,
} = require(servicePath('makerworld', 'BrowseNavigation.ts'));
const {
  decodedBase64Size,
  saveCapturedDownload,
} = require(servicePath('makerworld', 'DownloadWriter.ts'));
const { MAX_DOWNLOAD_BYTES } = require(servicePath('makerworld', 'DownloadHostPolicy.ts'));
const {
  describeReason,
  reasonForResponse,
  reasonForTransportError,
} = require(servicePath('makerworld', 'DownloadFailure.ts'));

// --- Messages from the page ------------------------------------------------
//
// Everything here is a string produced by a remote page, so the tests are
// mostly about what gets rejected.

test('a captured file URL is read from the hook message', () => {
  const message = parseHookMessage(
    JSON.stringify({ t: 'file', url: 'https://cdn.bblmw.com/x.3mf', name: 'bracket.3mf' })
  );
  assert.deepEqual(message, {
    kind: 'url',
    sourceUrl: 'https://cdn.bblmw.com/x.3mf',
    suggestedName: 'bracket.3mf',
  });
});

test('a file message without a URL is not a download', () => {
  assert.equal(parseHookMessage(JSON.stringify({ t: 'file', name: 'x.3mf' })), null);
  assert.equal(parseHookMessage(JSON.stringify({ t: 'file', url: '' })), null);
  assert.equal(parseHookMessage(JSON.stringify({ t: 'file', url: 42 })), null);
});

test('a missing name is empty rather than absent, so the caller always has a string', () => {
  const message = parseHookMessage(JSON.stringify({ t: 'file', url: 'https://x.test/a.3mf' }));
  assert.equal(message.suggestedName, '');
});

test('a blob arrives as base64 with its data URL prefix stripped', () => {
  const message = parseHookMessage(
    JSON.stringify({ t: 'blob', data: 'data:model/3mf;base64,QUJD', name: 'part.3mf' })
  );
  assert.deepEqual(message, { kind: 'blob', base64: 'QUJD', suggestedName: 'part.3mf' });
});

test('a blob that is not a base64 data URL is rejected', () => {
  const cases = [
    { t: 'blob', data: 'https://evil.test/x.3mf' },
    { t: 'blob', data: 'data:model/3mf,QUJD' },
    { t: 'blob', data: 'data:;base64,' },
    { t: 'blob', data: '' },
    { t: 'blob' },
  ];
  for (const payload of cases) {
    assert.equal(parseHookMessage(JSON.stringify(payload)), null, JSON.stringify(payload));
  }
});

test('location and error messages are recognised', () => {
  assert.deepEqual(parseHookMessage(JSON.stringify({ t: 'loc', url: 'https://makerworld.com/en' })), {
    kind: 'location',
    url: 'https://makerworld.com/en',
  });
  assert.deepEqual(parseHookMessage(JSON.stringify({ t: 'err', msg: 'boom' })), {
    kind: 'page-error',
    message: 'boom',
  });
  assert.equal(parseHookMessage(JSON.stringify({ t: 'err' })).message, 'The page reported an error.');
});

test('malformed, empty and unknown messages are ignored rather than thrown', () => {
  const cases = ['', 'not json', '[]', 'null', '"a string"', '{}', JSON.stringify({ t: 'other' })];
  for (const raw of cases) {
    assert.equal(parseHookMessage(raw), null, JSON.stringify(raw));
  }
  assert.equal(parseHookMessage(undefined), null);
  assert.equal(parseHookMessage(123), null);
});

test('an oversized message is dropped before it is parsed', () => {
  const huge = `{"t":"file","url":"https://cdn.bblmw.com/${'a'.repeat(MAX_HOOK_MESSAGE_BYTES)}"}`;
  assert.equal(parseHookMessage(huge), null);
});

test('both injected hooks are self-installing and guard against double injection', () => {
  for (const hook of [MAKERWORLD_DOWNLOAD_HOOK, MAKERWORLD_LOCATION_HOOK]) {
    assert.match(hook, /^\(function\(\)\{/);
    // Returning a value keeps the Android WebView from logging an evaluation
    // warning on every injection.
    assert.match(hook, /true;$/);
    assert.match(hook, /window\.__mw/);
  }
});

test('direct navigation to a model file is recognised, other navigation is not', () => {
  const files = [
    'https://cdn.bblmw.com/model.3mf',
    'https://cdn.bblmw.com/model.STL?sig=abc',
    'https://cdn.bblmw.com/model.3mf#frag',
  ];
  for (const url of files) assert.equal(isModelFileUrl(url), true, url);

  const pages = [
    'https://makerworld.com/en/models/123',
    'https://makerworld.com/3mf-guide',
    'https://cdn.bblmw.com/model.3mf.html',
    '',
  ];
  for (const url of pages) assert.equal(isModelFileUrl(url), false, url);
});

test('a filename is recovered from a URL without its query or fragment', () => {
  assert.equal(filenameFromUrl('https://cdn.bblmw.com/a/b/cool%20part.3mf?sig=x'), 'cool part.3mf');
  assert.equal(filenameFromUrl('https://cdn.bblmw.com/a/b/part.3mf#x'), 'part.3mf');
  // A malformed escape must not throw; the raw segment is good enough here
  // because the caller sanitises it before use.
  assert.equal(filenameFromUrl('https://cdn.bblmw.com/%E0%A4%A.3mf'), '%E0%A4%A.3mf');
});

// --- Where the browser is --------------------------------------------------

test('a model page offers import, a browse page does not', () => {
  const model = describeLocation('https://makerworld.com/en/models/1234567');
  assert.equal(model.onMakerWorld, true);
  assert.equal(canImportFrom(model), true);
  assert.equal(model.model.modelId, '1234567');
  assert.equal(model.model.profileId, null);
  assert.equal(model.label, 'Model 1234567');

  const browse = describeLocation('https://makerworld.com/en/search?q=bracket');
  assert.equal(browse.onMakerWorld, true);
  assert.equal(canImportFrom(browse), false);
  assert.equal(browse.label, 'MakerWorld');
});

test('a profile link carries the instance id through to the import', () => {
  const location = describeLocation('https://makerworld.com/en/models/1234567#profileId-987');
  assert.equal(canImportFrom(location), true);
  assert.equal(location.model.profileId, '987');
  assert.equal(location.label, 'Model 1234567 · profile 987');
  assert.equal(location.model.pageUrl, 'https://makerworld.com/en/models/1234567#profileId-987');
});

test('off-site browsing is described by host alone, never by full URL', () => {
  const location = describeLocation('https://accounts.google.com/signin?token=SECRET&id=42');
  assert.equal(location.onMakerWorld, false);
  assert.equal(canImportFrom(location), false);
  assert.equal(location.label, 'accounts.google.com');
  assert.equal(location.label.includes('SECRET'), false);
});

test('a look-alike host is not treated as MakerWorld', () => {
  const cases = [
    'https://makerworld.com.evil.test/en/models/1',
    'https://evil.test/makerworld.com/models/1',
    'https://makerworld.com@evil.test/models/1',
  ];
  for (const url of cases) {
    const location = describeLocation(url);
    assert.equal(location.onMakerWorld, false, url);
    assert.equal(canImportFrom(location), false, url);
  }
});

test('an absent location is safe to describe', () => {
  for (const value of [null, undefined, '', '   ']) {
    const location = describeLocation(value);
    assert.equal(location.onMakerWorld, false);
    assert.equal(location.model, null);
    assert.equal(location.label, 'MakerWorld');
  }
});

test('the Explore tab starts on MakerWorld', () => {
  assert.equal(exploreStartUrl(), 'https://makerworld.com/en');
  assert.equal(describeLocation(exploreStartUrl()).onMakerWorld, true);
});

// --- Saving what was captured ----------------------------------------------

function fakeIo(overrides = {}) {
  const calls = { removed: [], fetched: [], written: [] };
  const files = new Map();
  return {
    calls,
    files,
    io: {
      async remove(uri) {
        calls.removed.push(uri);
        files.delete(uri);
      },
      async fetchToFile(url, uri, onProgress) {
        calls.fetched.push({ url, uri });
        onProgress?.(10, 20);
        onProgress?.(20, 20);
        files.set(uri, 20);
        return { status: 200, mimeType: 'application/octet-stream' };
      },
      async writeBase64(uri, base64) {
        calls.written.push({ uri, base64 });
        files.set(uri, decodedBase64Size(base64));
      },
      async sizeOf(uri) {
        return files.has(uri) ? files.get(uri) : null;
      },
      ...overrides,
    },
  };
}

const urlCapture = {
  kind: 'url',
  sourceUrl: 'https://public-cdn.bblmw.com/signed/model.3mf?sig=abc',
  suggestedName: 'Cool Bracket.3mf',
};

test('a captured URL is fetched to a deterministic path and reported', async () => {
  const { io, calls } = fakeIo();
  const result = await saveCapturedDownload({
    capture: urlCapture,
    targetDirectory: 'file:///docs/',
    modelId: '1234567',
    io,
  });

  assert.deepEqual(calls.fetched, [
    { url: urlCapture.sourceUrl, uri: 'file:///docs/makerworld_1234567.3mf' },
  ]);
  assert.equal(result.filePath, '/docs/makerworld_1234567.3mf');
  assert.equal(result.sizeBytes, 20);
  assert.equal(result.suggestedName, 'Cool Bracket.3mf');
  assert.equal(result.sourceUrl, urlCapture.sourceUrl);
});

test('any previous file at the target is removed before writing', async () => {
  const { io, calls } = fakeIo();
  await saveCapturedDownload({
    capture: urlCapture,
    targetDirectory: 'file:///docs/',
    modelId: '1234567',
    io,
  });
  assert.deepEqual(calls.removed, ['file:///docs/makerworld_1234567.3mf']);
});

test('download progress is passed through', async () => {
  const { io } = fakeIo();
  const seen = [];
  await saveCapturedDownload({
    capture: urlCapture,
    targetDirectory: 'file:///docs/',
    modelId: '1234567',
    io,
    onProgress: (received, total) => seen.push([received, total]),
  });
  assert.deepEqual(seen, [
    [10, 20],
    [20, 20],
  ]);
});

test('a download host outside the allowlist is refused before any bytes are requested', async () => {
  const { io, calls } = fakeIo();
  await assert.rejects(
    saveCapturedDownload({
      capture: { kind: 'url', sourceUrl: 'https://evil.test/model.3mf', suggestedName: 'x.3mf' },
      targetDirectory: 'file:///docs/',
      modelId: '1234567',
      io,
    }),
    (error) => error.name === 'ModelSourceError' && error.reason === 'policy-rejected'
  );
  assert.deepEqual(calls.fetched, [], 'no request may be made to a rejected host');
});

test('a plaintext or credential-bearing download URL is refused', async () => {
  const { io } = fakeIo();
  for (const sourceUrl of [
    'http://public-cdn.bblmw.com/model.3mf',
    'https://user:pass@public-cdn.bblmw.com/model.3mf',
    'https://public-cdn.bblmw.com:8443/model.3mf',
  ]) {
    await assert.rejects(
      saveCapturedDownload({
        capture: { kind: 'url', sourceUrl, suggestedName: 'x.3mf' },
        targetDirectory: 'file:///docs/',
        modelId: '1',
        io,
      }),
      (error) => error.reason === 'policy-rejected',
      sourceUrl
    );
  }
});

test('a blob is written without a network request', async () => {
  const { io, calls } = fakeIo();
  const result = await saveCapturedDownload({
    capture: { kind: 'blob', base64: 'QUJDRA==', suggestedName: 'part.3mf' },
    targetDirectory: 'file:///docs/',
    modelId: '99',
    io,
  });
  assert.deepEqual(calls.fetched, []);
  assert.equal(calls.written.length, 1);
  assert.equal(result.sizeBytes, 4);
  assert.equal(result.suggestedName, 'part.3mf');
});

test('an oversized blob is rejected from its encoded length, before decoding', async () => {
  const { io, calls } = fakeIo();
  const oversized = 'A'.repeat(Math.ceil((MAX_DOWNLOAD_BYTES + 1024) * (4 / 3)));
  await assert.rejects(
    saveCapturedDownload({
      capture: { kind: 'blob', base64: oversized, suggestedName: 'big.3mf' },
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io,
    }),
    (error) => error.reason === 'policy-rejected'
  );
  assert.deepEqual(calls.written, []);
});

test('a hostile suggested filename is sanitised', async () => {
  const { io } = fakeIo();
  const result = await saveCapturedDownload({
    capture: { ...urlCapture, suggestedName: '../../etc/passwd' },
    targetDirectory: 'file:///docs/',
    modelId: '1234567',
    io,
  });
  assert.equal(result.suggestedName, 'passwd');
  assert.equal(result.suggestedName.includes('/'), false);
  assert.equal(result.filePath, '/docs/makerworld_1234567.3mf');
});

test('a filename is recovered from the URL when the page supplies none', async () => {
  const { io } = fakeIo();
  const result = await saveCapturedDownload({
    capture: { ...urlCapture, suggestedName: '' },
    targetDirectory: 'file:///docs/',
    modelId: '1234567',
    io,
  });
  assert.equal(result.suggestedName, 'model.3mf');
});

test('a non-numeric model id never reaches the filesystem path', async () => {
  const { io, calls } = fakeIo();
  await saveCapturedDownload({
    capture: urlCapture,
    targetDirectory: 'file:///docs/',
    modelId: '../../evil',
    io,
    now: () => 1700000000000,
  });
  assert.deepEqual(calls.fetched, [
    { url: urlCapture.sourceUrl, uri: 'file:///docs/makerworld_1700000000000.3mf' },
  ]);
});

// --- Responses that are not models -----------------------------------------
//
// MakerWorld answers 403 when not signed in and 418 for its bot check, and in
// both cases it still sends a body. That body gets written to disk, so it is
// non-empty and hashes cleanly — nothing downstream can tell it is not a model.
// These are the cases the fake IO originally could not express at all.

test('an HTTP refusal is classified rather than saved as a model', async () => {
  const cases = [
    [401, 'not-signed-in'],
    [403, 'forbidden'],
    [418, 'captcha-required'],
    [429, 'rate-limited'],
    [500, 'network'],
    [503, 'network'],
    [302, 'unknown'],
  ];

  for (const [status, expected] of cases) {
    const refused = fakeIo();
    refused.io.fetchToFile = async (url, uri) => {
      // The error page is written before the status is known — that is exactly
      // what makes it dangerous.
      refused.files.set(uri, 4096);
      return { status, mimeType: 'text/html' };
    };

    await assert.rejects(
      saveCapturedDownload({
        capture: urlCapture,
        targetDirectory: 'file:///docs/',
        modelId: '1234567',
        io: refused.io,
      }),
      (error) => error.name === 'ModelSourceError' && error.reason === expected,
      `HTTP ${status}`
    );
    assert.equal(
      refused.files.has('file:///docs/makerworld_1234567.3mf'),
      false,
      `the ${status} body must not be left on disk`
    );
  }
});

test('a 200 carrying an error page is refused on its content type', async () => {
  for (const mimeType of ['text/html', 'text/html; charset=utf-8', 'application/json']) {
    const wrong = fakeIo();
    wrong.io.fetchToFile = async (url, uri) => {
      wrong.files.set(uri, 2048);
      return { status: 200, mimeType };
    };
    await assert.rejects(
      saveCapturedDownload({
        capture: urlCapture,
        targetDirectory: 'file:///docs/',
        modelId: '1',
        io: wrong.io,
      }),
      (error) => error.reason === 'forbidden',
      mimeType
    );
  }
});

test('the content types a real 3MF arrives with are accepted', async () => {
  for (const mimeType of [
    'application/octet-stream',
    'application/zip',
    'model/3mf',
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    null,
    undefined,
  ]) {
    const ok = fakeIo();
    ok.io.fetchToFile = async (url, uri) => {
      ok.files.set(uri, 20);
      return { status: 200, mimeType };
    };
    const result = await saveCapturedDownload({
      capture: urlCapture,
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io: ok.io,
    });
    assert.equal(result.sizeBytes, 20, String(mimeType));
  }
});

test('transport errors are classified by what they say', () => {
  assert.equal(reasonForTransportError(new Error('Network request failed')), 'network');
  assert.equal(reasonForTransportError(new Error('socket hang up')), 'network');
  assert.equal(reasonForTransportError(new Error('The request was aborted')), 'cancelled');
  assert.equal(reasonForTransportError(new Error('User cancelled')), 'cancelled');
  // Anything unrecognisable is a network problem rather than a silent success.
  assert.equal(reasonForTransportError(undefined), 'network');
  assert.equal(reasonForTransportError('weird'), 'network');
});

test('a transport failure is network, and an abort is cancelled', async () => {
  const lost = fakeIo();
  lost.io.fetchToFile = async () => {
    throw new Error('Network request failed');
  };
  await assert.rejects(
    saveCapturedDownload({
      capture: urlCapture,
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io: lost.io,
    }),
    (error) => error.reason === 'network'
  );

  const aborted = fakeIo();
  aborted.io.fetchToFile = async (url, uri) => {
    aborted.files.set(uri, 900);
    throw new Error('The request was aborted');
  };
  await assert.rejects(
    saveCapturedDownload({
      capture: urlCapture,
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io: aborted.io,
    }),
    (error) => error.reason === 'cancelled'
  );
  assert.equal(
    aborted.files.has('file:///docs/makerworld_1.3mf'),
    false,
    'a partial file must not survive an interrupted download'
  );
});

test('every failure reason has operator-facing text that says what to do', () => {
  const reasons = [
    'not-signed-in',
    'captcha-required',
    'forbidden',
    'rate-limited',
    'network',
    'cancelled',
    'policy-rejected',
    'empty-file',
    'unknown',
  ];
  for (const reason of reasons) {
    const text = describeReason(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 20, reason);
    // A signed CDN URL or a raw status code must never reach the operator.
    assert.equal(/https?:\/\//.test(text), false, reason);
  }
});

test('a successful response is not a failure', () => {
  for (const status of [200, 201, 206, 299]) {
    assert.equal(reasonForResponse({ status, mimeType: 'application/zip' }), null, String(status));
  }
});

test('an empty or missing download is reported, not returned', async () => {
  const empty = fakeIo();
  empty.io.fetchToFile = async (url, uri) => {
    empty.files.set(uri, 0);
    return { status: 200, mimeType: 'application/zip' };
  };
  await assert.rejects(
    saveCapturedDownload({
      capture: urlCapture,
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io: empty.io,
    }),
    (error) => error.reason === 'empty-file'
  );

  const absent = fakeIo();
  absent.io.fetchToFile = async () => ({ status: 200, mimeType: 'application/zip' });
  await assert.rejects(
    saveCapturedDownload({
      capture: urlCapture,
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io: absent.io,
    }),
    (error) => error.reason === 'network'
  );
});

test('a file that lands over the size cap is deleted rather than kept', async () => {
  const oversized = fakeIo();
  oversized.io.fetchToFile = async (url, uri) => {
    oversized.files.set(uri, MAX_DOWNLOAD_BYTES + 1);
    return { status: 200, mimeType: 'application/zip' };
  };
  await assert.rejects(
    saveCapturedDownload({
      capture: urlCapture,
      targetDirectory: 'file:///docs/',
      modelId: '1',
      io: oversized.io,
    }),
    (error) => error.reason === 'policy-rejected'
  );
  assert.equal(oversized.calls.removed.length, 2, 'the oversized file is removed after the check');
});

test('decoded base64 size accounts for padding', () => {
  assert.equal(decodedBase64Size('QUJD'), 3);
  assert.equal(decodedBase64Size('QUJDRA=='), 4);
  assert.equal(decodedBase64Size('QUJDREU='), 5);
  assert.equal(decodedBase64Size(''), 0);
});
