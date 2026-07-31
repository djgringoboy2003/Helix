const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  REDACTED,
  describeEndpoint,
  fileNameOnly,
  redactSensitive,
} = require(servicePath('diagnostics', 'Redaction.ts'));
const {
  buildDiagnosticReport,
  diagnosticFileName,
} = require(servicePath('diagnostics', 'DiagnosticReport.ts'));
const { defaultFeatureFlags } = require(servicePath('featureFlags.ts'));
const { buildFilamentMapping, buildStartJob } = require(servicePath('start', 'StartJob.ts'));

const NOW = 1_700_000_000_000;

// --- redaction: the part that must not have holes -------------------------

test('private addresses are removed, public ones are kept', () => {
  // A public host is usually a MakerWorld CDN and is worth diagnosing with; a
  // 192.168 address says where somebody lives on their own network.
  for (const address of [
    '192.168.0.25',
    '10.1.2.3',
    '172.16.9.9',
    '172.31.0.1',
    '169.254.1.1',
    '100.101.102.103',
  ]) {
    assert.equal(redactSensitive(`printer at ${address}`), `printer at ${REDACTED}`, address);
  }

  // Outside the private ranges: kept.
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '11.0.0.1']) {
    assert.ok(redactSensitive(`cdn ${address}`).includes(address), address);
  }
});

test('tailnet hostnames are removed', () => {
  assert.equal(
    redactSensitive('http://my-printer.tail1234.ts.net:7125/'),
    `http://${REDACTED}:7125/`
  );
});

test('bearer tokens and JWTs are removed wherever they appear', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

  assert.ok(!redactSensitive(`token ${jwt} here`).includes(jwt));
  assert.ok(!redactSensitive(`Authorization: Bearer ${jwt}`).includes(jwt));
  // Bare in an error string, with no label in front of it.
  assert.ok(!redactSensitive(`request failed for ${jwt}`).includes(jwt));
});

test('labelled secrets are redacted but the label survives', () => {
  // Knowing a token was involved is diagnostic; knowing its value is a leak.
  const cases = [
    ['password=hunter2', 'password=[redacted]'],
    ['Cookie: session=abc123', 'Cookie: [redacted]'],
    ['api_key: sk-live-9999', 'api_key: [redacted]'],
    ['refresh_token = "abc.def"', 'refresh_token=[redacted]'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSensitive(input), expected, input);
  }
});

test('a private address inside a labelled secret is still redacted', () => {
  // Ordering matters: the labelled sweep runs first, so this must not come out
  // as `password=[redacted]` with the address left dangling, nor half-redacted.
  const out = redactSensitive('password=192.168.0.5');
  assert.ok(!out.includes('192.168.0.5'));
  assert.equal(out, 'password=[redacted]');
});

test('credentials embedded in a URL are removed', () => {
  const out = redactSensitive('http://admin:letmein@printer.local/api');
  assert.ok(!out.includes('letmein'));
  assert.ok(!out.includes('admin:'));
});

test('device and home paths are removed', () => {
  // Each case names the segment that actually identifies someone — the package
  // and profile on Android, the account name on a desktop.
  const cases = [
    ['/data/user/0/org.crabcore.u1control/cache/x.gcode', 'org.crabcore.u1control'],
    ['/data/data/org.crabcore.u1control/files/a.gcode', 'org.crabcore.u1control'],
    ['/storage/emulated/0/Download/model.3mf', 'Download'],
    ['C:\\Users\\rober\\Helix', 'rober'],
    ['/home/lava/moonraker', 'lava'],
  ];

  for (const [input, identifying] of cases) {
    const out = redactSensitive(`path ${input}`);
    assert.ok(!out.includes(identifying), `${input} still leaks ${identifying}`);
    assert.ok(out.includes(REDACTED), input);
  }
});

test('redaction handles empty and absent input', () => {
  assert.equal(redactSensitive(''), '');
  assert.equal(redactSensitive(undefined), '');
});

// --- shaping, where the report keeps what helps ---------------------------

test('an endpoint is described by shape, never by address', () => {
  assert.equal(describeEndpoint('http://192.168.0.25:7125'), 'http://<ip>:7125');
  assert.equal(describeEndpoint('http://printer.local'), 'http://<hostname>');
  assert.equal(describeEndpoint('http://box.tail99.ts.net:7125'), 'http://<tailnet>:7125');
  assert.equal(describeEndpoint(''), 'not set');
  assert.equal(describeEndpoint('nonsense'), REDACTED);
});

test('a file is named without saying where it lives', () => {
  assert.equal(fileNameOnly('/data/user/0/app/cache/benchy.gcode'), 'benchy.gcode');
  assert.equal(fileNameOnly('C:\\Users\\rober\\model.3mf'), 'model.3mf');
  assert.equal(fileNameOnly('folder/part.gcode?v=2'), 'part.gcode');
  assert.equal(fileNameOnly(''), REDACTED);
});

// --- the report ------------------------------------------------------------

function reportInput(over = {}) {
  return {
    appVersion: '1.2.8',
    buildCommit: 'abc1234',
    platform: 'android',
    androidRelease: '15',
    flags: defaultFeatureFlags(),
    slicer: { loaded: true, coreVersion: '2.9.0', coreError: null },
    printer: {
      connectionMode: 'lan',
      url: 'http://192.168.0.25:7125',
      connected: true,
      klippyState: 'ready',
      printState: 'standby',
      toolheads: ['T0 loaded', 'T1 empty'],
    },
    job: null,
    generatedAt: NOW,
    ...over,
  };
}

test('a report carries no printer address', () => {
  const report = buildDiagnosticReport(reportInput());

  assert.ok(!report.includes('192.168.0.25'));
  assert.ok(report.includes('http://<ip>:7125'));
  assert.ok(report.includes('connected: true'));
  assert.ok(report.includes('klippy: ready'));
});

test('a report says which flags were on', () => {
  const report = buildDiagnosticReport(reportInput());
  assert.ok(report.includes('camera_approval_required: true'));
});

test('a report describes a job without reproducing its approval', () => {
  const mapping = buildFilamentMapping(
    [{ sourceIndex: 0, material: 'PLA', color: '#FF0000' }],
    { 0: 0 },
    [{ toolhead: 0, status: 'loaded', material: 'PLA', color: '#FF0000', brand: '', rfidLocked: false, source: 'printer' }],
    NOW
  );
  const job = buildStartJob({
    id: 'job-diag',
    modelId: 'benchy',
    printerId: 'printer-a',
    gcodeArtifactId: '/data/user/0/org.crabcore.u1control/cache/benchy.gcode',
    gcodeSha256: 'a'.repeat(64),
    uploadedFilename: 'benchy_1700000000.gcode',
    filamentMapping: mapping,
    at: NOW,
  });

  const report = buildDiagnosticReport(reportInput({ job }));

  assert.ok(report.includes('state: awaiting_start_approval'));
  assert.ok(report.includes('uploaded file: benchy_1700000000.gcode'));
  assert.ok(report.includes('source 0'));
  assert.ok(report.includes('-> T0'));
  // The full 64-character digest is not what an operator needs to paste.
  assert.ok(!report.includes('a'.repeat(64)));
  // And the artifact's on-device path must not survive.
  assert.ok(!report.includes('/data/user/0'));
});

test('an operator note is included but still redacted', () => {
  const report = buildDiagnosticReport(
    reportInput({ note: 'fails when I point it at 192.168.0.25 with password=hunter2' })
  );

  assert.ok(report.includes('## Note'));
  assert.ok(!report.includes('192.168.0.25'));
  assert.ok(!report.includes('hunter2'));
});

test('a report with no job says so rather than omitting the section', () => {
  const report = buildDiagnosticReport(reportInput());
  assert.ok(report.includes('## Job'));
  assert.ok(report.includes('no job in flight'));
});

test('the whole report is swept, not just the fields that were shaped', () => {
  // A value arriving through a field nobody thought about — here the slicer's
  // own error string — must still be redacted.
  const report = buildDiagnosticReport(
    reportInput({
      slicer: { loaded: false, coreVersion: null, coreError: 'failed to open /data/user/0/x.so at 10.0.0.4' },
    })
  );

  assert.ok(!report.includes('10.0.0.4'));
  assert.ok(!report.includes('/data/user/0'));
});

test('the export filename is filesystem-safe', () => {
  const name = diagnosticFileName(NOW);
  assert.ok(name.startsWith('helix-diagnostic-'));
  assert.ok(name.endsWith('.txt'));
  assert.ok(!/[:*?"<>|]/.test(name));
});
