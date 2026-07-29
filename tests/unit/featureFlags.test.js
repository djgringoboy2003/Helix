const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  defaultFeatureFlags,
  getFeatureFlags,
  isFeatureEnabled,
  isFeatureFlagName,
  resetFeatureFlags,
  resolveFeatureFlags,
  setFeatureFlagOverrides,
  togglableFeatureFlags,
} = require(servicePath('featureFlags.ts'));

test('experimental paths default to off and the shipping WebView path to on', () => {
  const defaults = defaultFeatureFlags();

  assert.equal(defaults.makerworld_webview_enabled, true);
  assert.equal(defaults.makerworld_native_api_enabled, false);
  assert.equal(defaults.crossprint_translation_enabled, false);
  assert.equal(defaults.remote_printer_enabled, false);
  assert.equal(defaults.experimental_multi_plate_enabled, false);
});

test('the camera approval requirement is on by default and locked', () => {
  assert.equal(defaultFeatureFlags().camera_approval_required, true);
  assert.equal(FEATURE_FLAGS.camera_approval_required.locked, true);
  assert.equal(togglableFeatureFlags().includes('camera_approval_required'), false);
});

test('a locked safety flag cannot be switched off by stored overrides', () => {
  const flags = resolveFeatureFlags({
    camera_approval_required: false,
    makerworld_native_api_enabled: true,
  });

  assert.equal(flags.camera_approval_required, true, 'the camera check is not a toggle');
  assert.equal(flags.makerworld_native_api_enabled, true, 'ordinary flags still apply');
});

test('unknown keys and non-boolean values fall back to the safe default', () => {
  const flags = resolveFeatureFlags({
    remote_printer_enabled: 'yes',
    crossprint_translation_enabled: 1,
    experimental_multi_plate_enabled: null,
    not_a_real_flag: true,
    __proto__: { makerworld_native_api_enabled: true },
  });

  assert.deepEqual(flags, defaultFeatureFlags());
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'not_a_real_flag'), false);
});

test('corrupt override payloads degrade to defaults instead of throwing', () => {
  for (const bad of [null, undefined, 'flags', 42, [], true]) {
    assert.deepEqual(resolveFeatureFlags(bad), defaultFeatureFlags(), String(bad));
  }
});

test('overrides applied at startup are visible to the rest of the app', () => {
  resetFeatureFlags();
  assert.equal(isFeatureEnabled('remote_printer_enabled'), false);

  setFeatureFlagOverrides({ remote_printer_enabled: true });
  assert.equal(isFeatureEnabled('remote_printer_enabled'), true);
  assert.equal(getFeatureFlags().remote_printer_enabled, true);

  resetFeatureFlags();
  assert.equal(isFeatureEnabled('remote_printer_enabled'), false);
});

test('every declared flag has a description and appears in the name list', () => {
  for (const name of FEATURE_FLAG_NAMES) {
    assert.equal(isFeatureFlagName(name), true, name);
    assert.ok(FEATURE_FLAGS[name].description.length > 10, `${name} needs a real description`);
    assert.equal(typeof FEATURE_FLAGS[name].defaultValue, 'boolean', name);
  }

  assert.equal(isFeatureFlagName('nope'), false);
  assert.equal(isFeatureFlagName(null), false);
  assert.equal(isFeatureFlagName('toString'), false, 'inherited names are not flags');
});
