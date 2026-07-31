const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  buildVolumeOf,
  checkFitsBuildVolume,
  describeFit,
  layerHeightLimitsOf,
  planU1Preparation,
  U1_BED_TEMP_RANGE,
  U1_NOZZLE_TEMP_RANGE,
} = require(servicePath('prepare', 'U1ProjectPreparer.ts'));

// The real bundled profile, not a stand-in. The whole policy rests on "the U1
// profile owns these keys", so the tests have to be run against the profile the
// app actually ships or they prove nothing about the app.
const U1_PROFILE = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname, '..', '..', 'android', 'app', 'src', 'main', 'assets',
      'orca_profiles', 'printer', 'snapmaker_u1.json'
    ),
    'utf8'
  )
);

const FOREIGN_START_GCODE =
  'M73 P0 R0\nM190 S65\nM109 S250\nG28\nG29\n; Bambu Lab X1 Carbon purge line\nG1 X250 Y250 F12000\n';

/** A representative Bambu Studio project, as MakerWorld hands one over. */
function bambuProject(overrides = {}) {
  return {
    from: 'project',
    version: '1.9.0.0',
    name: 'project_settings',

    // --- the source machine, none of which may survive ---
    printer_model: 'Bambu Lab X1 Carbon',
    printer_settings_id: 'Bambu Lab X1 Carbon 0.4 nozzle',
    printer_variant: '0.4',
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '250',
    nozzle_diameter: ['0.4'],
    machine_start_gcode: FOREIGN_START_GCODE,
    machine_end_gcode: 'M104 S0\nM140 S0\nG1 X250 Y250\n',
    layer_change_gcode: '; CHANGE_LAYER\nM73\n',
    change_filament_gcode: 'M620 S[next_extruder]A\n',
    // Deliberately unlike the U1's own values, so "was it replaced?" is a real
    // question. The U1 profile's own max acceleration is also 20000, which is
    // exactly the coincidence that would make a weaker fixture prove nothing.
    machine_max_acceleration_x: ['99999', '99999'],
    machine_max_speed_x: ['1200', '1200'],
    machine_max_jerk_x: ['40', '40'],
    gcode_flavor: 'marlin',
    curr_bed_type: 'Textured PEI Plate',
    bbl_use_printhost: '0',
    bambu_wifi_enabled: '1',
    host_type: 'octoprint',

    // --- the designer's intent, which must survive ---
    layer_height: '0.2',
    initial_layer_print_height: '0.2',
    sparse_infill_density: '15%',
    sparse_infill_pattern: 'gyroid',
    wall_loops: '3',
    filament_colour: ['#FFFFFF'],
    filament_type: ['PLA'],
    nozzle_temperature: ['220'],
    hot_plate_temp: ['60'],

    ...overrides,
  };
}

const dispositionOf = (report, key) =>
  report.entries.find((entry) => entry.key === key)?.disposition;

const plan = (overrides = {}, options = undefined) =>
  planU1Preparation(bambuProject(overrides), U1_PROFILE, options);

// --- the core rule ---------------------------------------------------------

test('the U1 profile owns every key it defines, whatever the download said', () => {
  const { apply, report } = plan();

  assert.equal(apply.printer_model, 'Snapmaker U1');
  assert.equal(apply.printable_height, '270');
  assert.deepEqual(apply.printable_area, U1_PROFILE.printable_area);
  assert.equal(apply.gcode_flavor, 'klipper');
  assert.equal(dispositionOf(report, 'printer_model'), 'machine-replaced');
  assert.equal(dispositionOf(report, 'printable_area'), 'machine-replaced');
});

test('foreign start and end G-code are replaced by the U1 profile, never carried over', () => {
  const { apply, report } = plan();

  assert.equal(apply.machine_start_gcode, U1_PROFILE.machine_start_gcode);
  assert.equal(apply.machine_end_gcode, U1_PROFILE.machine_end_gcode);
  assert.ok(!String(apply.machine_start_gcode).includes('Bambu'));
  assert.ok(!String(apply.machine_start_gcode).includes('X250'));
  assert.equal(dispositionOf(report, 'machine_start_gcode'), 'machine-replaced');
});

test('every per-layer and filament-change script is replaced too', () => {
  // These run mid-print on every layer and every tool change. A foreign one is
  // as dangerous as a foreign start script, and easier to overlook.
  const { apply } = plan();
  assert.equal(apply.layer_change_gcode, U1_PROFILE.layer_change_gcode);
  assert.equal(apply.change_filament_gcode, U1_PROFILE.change_filament_gcode);
  assert.ok(!String(apply.change_filament_gcode).includes('M620'));
});

test('foreign motion limits are replaced with the U1 values', () => {
  const { apply } = plan();
  assert.deepEqual(apply.machine_max_acceleration_x, U1_PROFILE.machine_max_acceleration_x);
  assert.deepEqual(apply.machine_max_speed_x, U1_PROFILE.machine_max_speed_x);
  assert.deepEqual(apply.machine_max_jerk_x, U1_PROFILE.machine_max_jerk_x);
  assert.notDeepEqual(apply.machine_max_acceleration_x, ['99999', '99999']);
  assert.notDeepEqual(apply.machine_max_speed_x, ['1200', '1200']);
});

test('a machine key the U1 profile has never heard of is dropped, not guessed at', () => {
  const { remove, report } = plan();

  assert.ok(remove.includes('bambu_wifi_enabled'));
  assert.ok(remove.includes('curr_bed_type'));
  assert.equal(dispositionOf(report, 'bambu_wifi_enabled'), 'machine-removed');
  assert.equal(dispositionOf(report, 'curr_bed_type'), 'machine-removed');
});

test('an unrecognised vendor machine key is dropped by its prefix alone', () => {
  // The point of the prefix rule: a setting invented after this code was written
  // still fails closed.
  const { remove } = plan({ machine_invented_next_year: '1', printer_secret_mode: '7' });
  assert.ok(remove.includes('machine_invented_next_year'));
  assert.ok(remove.includes('printer_secret_mode'));
});

test('the U1 identity is asserted even when the download never mentioned it', () => {
  const bare = { layer_height: '0.2', filament_colour: ['#FFFFFF'] };
  const { apply, report } = planU1Preparation(bare, U1_PROFILE);

  assert.equal(apply.printer_model, 'Snapmaker U1');
  assert.equal(apply.printable_height, '270');
  assert.equal(apply.machine_start_gcode, U1_PROFILE.machine_start_gcode);
  assert.equal(report.ok, true);
});

test('a U1 profile missing its bed or start G-code blocks preparation', () => {
  const crippled = { ...U1_PROFILE };
  delete crippled.printable_area;
  delete crippled.machine_start_gcode;

  const { report } = planU1Preparation(bambuProject(), crippled);
  assert.equal(report.ok, false);
  assert.equal(report.blockers.length, 2);
  assert.ok(report.blockers.some((line) => /bed shape/i.test(line)));
  assert.ok(report.blockers.some((line) => /start G-code/i.test(line)));
});

// --- what must survive -----------------------------------------------------

test('the designer’s process settings are preserved', () => {
  const { apply, report } = plan();

  assert.equal(dispositionOf(report, 'sparse_infill_density'), 'preserved');
  assert.equal(dispositionOf(report, 'sparse_infill_pattern'), 'preserved');
  assert.equal(dispositionOf(report, 'wall_loops'), 'preserved');
  // Preserved keys are not rewritten, so they are absent from `apply`.
  assert.ok(!Object.prototype.hasOwnProperty.call(apply, 'sparse_infill_density'));
});

test('single-colour and four-colour filament lists both survive intact', () => {
  const single = plan();
  assert.equal(dispositionOf(single.report, 'filament_colour'), 'preserved');

  const four = plan({
    filament_colour: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
    filament_type: ['PLA', 'PLA', 'PETG', 'PLA'],
  });
  assert.equal(dispositionOf(four.report, 'filament_colour'), 'preserved');
  assert.equal(dispositionOf(four.report, 'filament_type'), 'preserved');
  assert.ok(!four.remove.includes('filament_colour'));
});

test('a HueForge-style project keeps its colour list and layer intent', () => {
  const { remove, report } = plan({
    filament_colour: ['#101010', '#303030', '#606060', '#F0F0F0'],
    layer_height: '0.08',
    initial_layer_print_height: '0.16',
  });

  assert.equal(dispositionOf(report, 'filament_colour'), 'preserved');
  // 0.08 is exactly the U1 minimum, so it is honoured rather than clamped away.
  assert.equal(dispositionOf(report, 'layer_height'), 'preserved');
  assert.ok(!remove.includes('filament_colour'));
});

test('support, brim and wipe-tower choices are preserved', () => {
  const { report } = plan({
    enable_support: '1',
    support_type: 'tree(auto)',
    support_style: 'tree_strong',
    brim_type: 'outer_only',
    brim_width: '5',
    enable_prime_tower: '1',
    prime_tower_width: '60',
  });

  for (const key of [
    'support_type', 'support_style', 'brim_type', 'brim_width',
    'enable_prime_tower', 'prime_tower_width',
  ]) {
    assert.equal(dispositionOf(report, key), 'preserved', key);
  }
});

test('painted and per-volume colour data is never touched, because it is not in this file', () => {
  // Paint lives on the mesh in `3D/*.model` as per-triangle attributes. The
  // plan only ever names `project_settings.config` keys and sliced output, so
  // there is no path by which paint could be rewritten.
  const { apply, remove, removeEntries } = plan(
    {},
    { slicedOutputPaths: ['Metadata/plate_1.gcode'] }
  );

  const touched = [...Object.keys(apply), ...remove, ...removeEntries];
  assert.ok(!touched.some((name) => name.includes('.model')));
  assert.ok(!touched.some((name) => name.startsWith('3D/')));
});

test('multi-object and multi-plate projects are not altered by preparation', () => {
  // Object and plate layout live in model_settings.config and the model parts.
  const { apply, remove } = plan({ print_sequence: 'by layer', first_layer_sequence_choice: 'auto' });
  assert.ok(!remove.includes('print_sequence'));
  assert.ok(!Object.prototype.hasOwnProperty.call(apply, 'print_sequence'));
});

// --- clamping --------------------------------------------------------------

test('the layer-height limits come from the U1 profile itself', () => {
  assert.deepEqual(layerHeightLimitsOf(U1_PROFILE), { min: 0.08, max: 0.32 });
});

test('a layer height sliced for a bigger nozzle is clamped to what the U1 allows', () => {
  // A 0.6 mm-nozzle project at 0.4 mm layers, and a 0.8 mm one at 0.5 mm.
  for (const [layer, nozzle] of [['0.4', '0.6'], ['0.5', '0.8']]) {
    const { apply, report } = plan({ layer_height: layer, nozzle_diameter: [nozzle] });
    assert.equal(apply.layer_height, '0.32');
    assert.equal(dispositionOf(report, 'layer_height'), 'clamped');
    // And the nozzle itself becomes the U1's, so the two now agree.
    assert.deepEqual(apply.nozzle_diameter, U1_PROFILE.nozzle_diameter);
  }
});

test('layer heights the U1 can actually print are left alone', () => {
  for (const layer of ['0.08', '0.1', '0.2', '0.28', '0.32']) {
    const { report } = plan({ layer_height: layer });
    assert.equal(dispositionOf(report, 'layer_height'), 'preserved', layer);
  }
});

test('a 0.2 mm-nozzle project keeps its fine layers but gets the U1 nozzle', () => {
  const { apply, report } = plan({ layer_height: '0.1', nozzle_diameter: ['0.2'] });
  assert.equal(dispositionOf(report, 'layer_height'), 'preserved');
  assert.deepEqual(apply.nozzle_diameter, U1_PROFILE.nozzle_diameter);
});

test('temperatures outside the U1 range are clamped, each to its own limit', () => {
  const { apply, report } = plan({
    nozzle_temperature: ['420'],
    hot_plate_temp: ['160'],
  });

  assert.deepEqual(apply.nozzle_temperature, [String(U1_NOZZLE_TEMP_RANGE.max)]);
  assert.deepEqual(apply.hot_plate_temp, [String(U1_BED_TEMP_RANGE.max)]);
  assert.equal(dispositionOf(report, 'nozzle_temperature'), 'clamped');
  assert.equal(dispositionOf(report, 'hot_plate_temp'), 'clamped');
});

test('a negative or nonsense value is brought into range rather than passed through', () => {
  const { apply, report } = plan({
    layer_height: '-0.5',
    nozzle_temperature: ['-40'],
  });

  assert.equal(apply.layer_height, '0.08');
  assert.deepEqual(apply.nozzle_temperature, [String(U1_NOZZLE_TEMP_RANGE.min)]);
  assert.equal(dispositionOf(report, 'layer_height'), 'clamped');
});

test('an unparseable value is preserved rather than turned into a number', () => {
  // Guessing what "nozzle_temperature: default" meant would be inventing a
  // temperature. It is left for the engine to reject.
  const { report } = plan({ nozzle_temperature: ['default'] });
  assert.equal(dispositionOf(report, 'nozzle_temperature'), 'preserved');
});

test('only the out-of-range members of an array are changed', () => {
  const { apply } = plan({ nozzle_temperature: ['220', '900', '240', '10'] });
  assert.deepEqual(apply.nozzle_temperature, ['220', '300', '240', '160']);
});

test('a percentage keeps working and is not clamped as a bare number', () => {
  const { report } = plan({ sparse_infill_density: '15%' });
  assert.equal(dispositionOf(report, 'sparse_infill_density'), 'preserved');
});

// --- stale sliced output ---------------------------------------------------

test('sliced output from the foreign machine is dropped from the archive', () => {
  const { removeEntries } = plan({}, {
    slicedOutputPaths: ['Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5'],
  });
  assert.deepEqual(removeEntries, ['Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5']);
});

test('a project with no sliced output has nothing to drop', () => {
  assert.deepEqual(plan().removeEntries, []);
});

// --- the conversion report -------------------------------------------------

test('the report counts every decision and explains each one', () => {
  const { report } = plan();
  const total = report.replaced + report.removed + report.clamped + report.preserved;

  assert.equal(total, report.entries.length);
  assert.ok(report.replaced > 0);
  assert.ok(report.removed > 0);
  assert.ok(report.preserved > 0);
  for (const entry of report.entries) {
    assert.ok(entry.detail.length > 0, entry.key);
  }
});

test('the report never puts raw G-code in front of the operator', () => {
  // The detail lines are shown in the warnings screen. A start script pasted
  // into the UI would be unreadable, and the safety rules keep machine scripts
  // out of anything the operator or a log sees.
  const { report } = plan();
  for (const entry of report.entries) {
    assert.ok(!entry.detail.includes('G28'), entry.key);
    assert.ok(!entry.detail.includes('M109'), entry.key);
    assert.ok(!/\bG1\b/.test(entry.detail), entry.key);
  }
});

// --- build volume ----------------------------------------------------------

test('the build volume is read from the U1 profile polygon', () => {
  assert.deepEqual(buildVolumeOf(U1_PROFILE), { width: 271, depth: 272, height: 270 });
});

test('a profile with no usable bed polygon reports no volume', () => {
  assert.equal(buildVolumeOf({ printable_area: ['nonsense'], printable_height: '270' }), null);
  assert.equal(buildVolumeOf({ printable_area: U1_PROFILE.printable_area, printable_height: '0' }), null);
});

test('an oversized part is reported per axis, before anything is sliced', () => {
  const volume = buildVolumeOf(U1_PROFILE);
  const report = checkFitsBuildVolume(
    [
      { name: 'base', sizeX: 100, sizeY: 100, sizeZ: 50 },
      { name: 'tower', sizeX: 40, sizeY: 40, sizeZ: 400 },
      { name: 'slab', sizeX: 300, sizeY: 500, sizeZ: 10 },
    ],
    volume
  );

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.tooLarge.map((finding) => `${finding.name}:${finding.axis}`),
    ['tower:z', 'slab:x', 'slab:y']
  );
  const lines = describeFit(report);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('tower'));
  assert.ok(lines[0].includes('Z'));
});

test('parts that fit report no problem', () => {
  const volume = buildVolumeOf(U1_PROFILE);
  const report = checkFitsBuildVolume(
    [{ name: 'benchy', sizeX: 60, sizeY: 31, sizeZ: 48 }],
    volume
  );
  assert.equal(report.ok, true);
  assert.deepEqual(describeFit(report), []);
});

test('a part exactly the size of the bed is accepted, not rejected by rounding', () => {
  const volume = buildVolumeOf(U1_PROFILE);
  const report = checkFitsBuildVolume(
    [{ name: 'exact', sizeX: volume.width, sizeY: volume.depth, sizeZ: volume.height }],
    volume
  );
  assert.equal(report.ok, true);
});

test('an empty plate fits trivially', () => {
  assert.equal(checkFitsBuildVolume([], buildVolumeOf(U1_PROFILE)).ok, true);
});
