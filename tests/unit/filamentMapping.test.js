const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  colorDistance,
  materialsMatch,
  normalizeHexColor,
  readLoadedSlots,
  readProjectFilaments,
} = require(servicePath('filament', 'FilamentSlots.ts'));
const {
  describeSwapPlan,
  planFilamentMapping,
} = require(servicePath('filament', 'FilamentMappingPlanner.ts'));
const { filamentMapHash, isFilamentMappingComplete } = require(
  servicePath('jobs', 'PrintJobTypes.ts')
);

// --- reading what the printer says -----------------------------------------

/** A `print_task_config` in the shape the U1 actually reports. */
function printTaskConfig(overrides = {}) {
  return {
    filament_exist: [true, true, false, false],
    filament_color_rgba: ['FF0000FF', '00FF00FF', '000000FF', '000000FF'],
    filament_type: ['PLA', 'PETG', 'NONE', 'NONE'],
    filament_sub_type: ['Matte', 'NONE', 'NONE', 'NONE'],
    filament_vendor: ['Snapmaker', 'Generic', 'NONE', 'NONE'],
    ...overrides,
  };
}

test('loaded slots are read from print_task_config, four of them, always', () => {
  const slots = readLoadedSlots(printTaskConfig());

  assert.equal(slots.length, 4);
  assert.deepEqual(
    slots.map((slot) => slot.status),
    ['loaded', 'loaded', 'empty', 'empty']
  );
  assert.equal(slots[0].material, 'PLA Matte');
  assert.equal(slots[0].color, '#FF0000');
  assert.equal(slots[0].brand, 'Snapmaker');
  assert.equal(slots[1].material, 'PETG');
});

test('an empty head describes nothing rather than carrying stale metadata', () => {
  // Otherwise a mapping could match a project colour against filament that is
  // not physically there.
  const slots = readLoadedSlots(
    printTaskConfig({
      filament_exist: [false, false, false, false],
      filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
      filament_color_rgba: ['FF0000FF', 'FF0000FF', 'FF0000FF', 'FF0000FF'],
    })
  );

  for (const slot of slots) {
    assert.equal(slot.status, 'empty');
    assert.equal(slot.material, '');
    assert.equal(slot.color, '');
  }
});

test('a printer that says nothing yields unknown, not empty', () => {
  const slots = readLoadedSlots({});
  assert.deepEqual(
    slots.map((slot) => slot.status),
    ['unknown', 'unknown', 'unknown', 'unknown']
  );
  assert.equal(slots[0].source, 'unknown');
});

test('a missing or malformed status object does not throw', () => {
  for (const input of [null, undefined, 'nonsense', 42, []]) {
    const slots = readLoadedSlots(input);
    assert.equal(slots.length, 4);
    assert.equal(slots[0].status, 'unknown');
  }
});

test('placeholder black is not mistaken for a black spool', () => {
  // `#000000` with no material and no vendor is the printer's "no data".
  const slots = readLoadedSlots(
    printTaskConfig({
      filament_exist: [true, false, false, false],
      filament_color_rgba: ['000000FF', '', '', ''],
      filament_type: ['NONE', 'NONE', 'NONE', 'NONE'],
      filament_vendor: ['NONE', 'NONE', 'NONE', 'NONE'],
    })
  );
  assert.equal(slots[0].color, '');
  assert.equal(slots[0].source, 'unknown');
});

test('ACE head sources fill in what the printer did not say', () => {
  const slots = readLoadedSlots(
    printTaskConfig({
      filament_exist: [true, false, false, false],
      filament_color_rgba: ['', '', '', ''],
      filament_type: ['NONE', 'NONE', 'NONE', 'NONE'],
      filament_vendor: ['NONE', 'NONE', 'NONE', 'NONE'],
    }),
    [{ material: 'PLA', colorHex: '#1188FF', brand: 'Snapmaker' }]
  );

  assert.equal(slots[0].material, 'PLA');
  assert.equal(slots[0].color, '#1188FF');
  assert.equal(slots[0].source, 'ace');
});

test('an RFID-identified spool is marked locked', () => {
  const slots = readLoadedSlots(printTaskConfig(), [
    { material: 'PLA', colorHex: '#FF0000', sku: 'SNAP-PLA-RED-1KG' },
    { material: 'PETG', colorHex: '#00FF00' },
  ]);

  assert.equal(slots[0].rfidLocked, true);
  assert.equal(slots[1].rfidLocked, false);
});

test('colours are normalised from both printer and project shapes', () => {
  assert.equal(normalizeHexColor('FF0000FF'), '#FF0000');
  assert.equal(normalizeHexColor('#ff0000'), '#FF0000');
  assert.equal(normalizeHexColor('#FF0000AA'), '#FF0000');
  assert.equal(normalizeHexColor('red'), '');
  assert.equal(normalizeHexColor(''), '');
  assert.equal(normalizeHexColor(null), '');
  assert.equal(normalizeHexColor(12), '');
});

test('project filaments are read from the project settings', () => {
  const filaments = readProjectFilaments({
    filament_colour: ['#FF0000', '#00FF00', '#0000FF'],
    filament_type: ['PLA', 'PLA', 'PETG'],
  });

  assert.equal(filaments.length, 3);
  assert.deepEqual(filaments[0], { sourceIndex: 0, material: 'PLA', color: '#FF0000' });
  assert.deepEqual(filaments[2], { sourceIndex: 2, material: 'PETG', color: '#0000FF' });
});

test('a shorter type list leaves the material unknown rather than assuming PLA', () => {
  const filaments = readProjectFilaments({
    filament_colour: ['#FF0000', '#00FF00'],
    filament_type: ['PLA'],
  });
  assert.equal(filaments[1].material, '');
});

test('a project with no filament list yields none', () => {
  assert.deepEqual(readProjectFilaments({}), []);
  assert.deepEqual(readProjectFilaments(null), []);
  assert.deepEqual(readProjectFilaments({ filament_colour: [] }), []);
});

test('materials match on their base type', () => {
  assert.equal(materialsMatch('PLA', 'PLA Matte'), true);
  assert.equal(materialsMatch('PLA Silk', 'PLA'), true);
  assert.equal(materialsMatch('pla', 'PLA'), true);
  assert.equal(materialsMatch('PLA', 'PETG'), false);
  assert.equal(materialsMatch('', 'PLA'), false);
  assert.equal(materialsMatch('PLA', ''), false);
});

test('colour distance is zero for identical and null for unusable input', () => {
  assert.equal(colorDistance('#FF0000', '#ff0000'), 0);
  assert.ok(colorDistance('#FF0000', '#0000FF') > 0);
  assert.equal(colorDistance('#FF0000', 'nonsense'), null);
});

// --- mapping ---------------------------------------------------------------

const LOADED_RED_GREEN = readLoadedSlots(printTaskConfig());

const project = (...filaments) =>
  filaments.map(([material, color], sourceIndex) => ({ sourceIndex, material, color }));

const codes = (plan) => plan.warnings.map((item) => item.code);

test('an exact match maps cleanly and blocks nothing', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#FF0000'], ['PETG', '#00FF00']),
    LOADED_RED_GREEN
  );

  assert.deepEqual(
    plan.assessments.map((item) => item.quality),
    ['exact', 'exact']
  );
  assert.deepEqual(
    plan.mapping.slots.map((slot) => slot.toolhead),
    [0, 1]
  );
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.swapPlan, []);
});

test('a material mismatch warns but does not block', () => {
  // PETG loaded where the project wants PLA: printable, but the operator has to
  // know, because temperatures differ.
  const plan = planFilamentMapping(project(['PLA', '#00FF00']), LOADED_RED_GREEN, {
    choices: { 0: 1 },
  });

  assert.equal(plan.assessments[0].quality, 'material-mismatch');
  assert.ok(codes(plan).includes('filament/material-mismatch'));
  assert.equal(plan.ok, true);
  assert.equal(plan.warnings[0].level, 'warning');
});

test('a colour mismatch is information, not an obstacle', () => {
  const plan = planFilamentMapping(project(['PLA', '#0000FF']), LOADED_RED_GREEN, {
    choices: { 0: 0 },
  });

  assert.equal(plan.assessments[0].quality, 'colour-mismatch');
  assert.ok(codes(plan).includes('filament/colour-mismatch'));
  assert.equal(plan.ok, true);
});

test('near-identical colours are treated as a match', () => {
  const plan = planFilamentMapping(project(['PLA', '#FA0505']), LOADED_RED_GREEN, {
    choices: { 0: 0 },
  });
  assert.equal(plan.assessments[0].quality, 'exact');
});

test('mapping onto an empty head blocks', () => {
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    choices: { 0: 2 },
  });

  assert.equal(plan.assessments[0].quality, 'empty');
  assert.ok(codes(plan).includes('filament/empty-head'));
  assert.equal(plan.ok, false);
});

test('a colour with no toolhead blocks rather than defaulting to T0', () => {
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    choices: { 0: null },
  });

  assert.equal(plan.assessments[0].quality, 'unmapped');
  assert.equal(plan.mapping.slots[0].toolhead, null);
  assert.ok(codes(plan).includes('filament/unmapped'));
  assert.equal(plan.ok, false);
});

test('an unknown toolhead blocks, because unknown printer state fails closed', () => {
  const unknown = readLoadedSlots({});
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), unknown, {
    choices: { 0: 0 },
  });

  assert.equal(plan.assessments[0].quality, 'unknown');
  assert.ok(codes(plan).includes('filament/unknown-head'));
  assert.equal(plan.ok, false);
});

test('nothing is suggested for a head whose contents are unknown', () => {
  // Optimistically filling in an unknown head is exactly the silent guess the
  // safety rules forbid.
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), readLoadedSlots({}));
  assert.equal(plan.mapping.slots[0].toolhead, null);
  assert.equal(plan.assessments[0].quality, 'unmapped');
});

test('duplicate mappings are allowed but reported', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#FF0000'], ['PLA', '#FF0000']),
    LOADED_RED_GREEN,
    { choices: { 0: 0, 1: 0 } }
  );

  const duplicate = plan.warnings.find((item) => item.code === 'filament/duplicate-mapping');
  assert.ok(duplicate);
  assert.equal(duplicate.level, 'warning');
  assert.match(duplicate.message, /2 project colours are mapped to T0/);
  assert.equal(plan.ok, true);
});

test('more than four project colours warns that heads must be shared', () => {
  const plan = planFilamentMapping(
    project(
      ['PLA', '#FF0000'], ['PLA', '#00FF00'], ['PLA', '#0000FF'],
      ['PLA', '#FFFF00'], ['PLA', '#FF00FF']
    ),
    LOADED_RED_GREEN,
    { choices: { 0: 0, 1: 1, 2: 0, 3: 1, 4: 0 } }
  );

  const tooMany = plan.warnings.find((item) => item.code === 'filament/too-many-colours');
  assert.ok(tooMany);
  assert.match(tooMany.message, /5 filaments/);
  assert.equal(tooMany.level, 'warning');
});

test('a project declaring no filaments blocks', () => {
  const plan = planFilamentMapping([], LOADED_RED_GREEN);
  assert.ok(codes(plan).includes('filament/no-colours'));
  assert.equal(plan.ok, false);
});

test('an RFID-locked head that does not match says to swap the spool', () => {
  const loaded = readLoadedSlots(printTaskConfig(), [
    { material: 'PLA', colorHex: '#FF0000', sku: 'SNAP-PLA-RED' },
  ]);
  const plan = planFilamentMapping(project(['PLA', '#0000FF']), loaded, { choices: { 0: 0 } });

  const locked = plan.warnings.find((item) => item.code === 'filament/rfid-locked');
  assert.ok(locked);
  assert.match(locked.message, /swap the spool/i);
  assert.equal(plan.assessments[0].rfidLocked, true);
});

test('an RFID-locked head that matches exactly is not mentioned', () => {
  const loaded = readLoadedSlots(printTaskConfig(), [
    { material: 'PLA', colorHex: '#FF0000', sku: 'SNAP-PLA-RED' },
  ]);
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), loaded, { choices: { 0: 0 } });
  assert.ok(!codes(plan).includes('filament/rfid-locked'));
});

// --- the swap plan ---------------------------------------------------------

test('a swap plan names what to physically change, per head', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#0000FF'], ['PLA', '#FFFF00']),
    LOADED_RED_GREEN,
    { choices: { 0: 0, 1: 1 } }
  );

  assert.equal(plan.swapPlan.length, 2);
  assert.deepEqual(
    plan.swapPlan.map((step) => step.toolhead),
    [0, 1]
  );
  const lines = describeSwapPlan(plan.swapPlan);
  assert.match(lines[0], /^T0: load PLA #0000FF/);
  assert.match(lines[0], /currently PLA Matte #FF0000/);
});

test('a clean mapping needs no swaps', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#FF0000'], ['PETG', '#00FF00']),
    LOADED_RED_GREEN
  );
  assert.deepEqual(describeSwapPlan(plan.swapPlan), []);
});

// --- suggestion and operator choice ----------------------------------------

test('suggestion prefers the same material over the closer colour', () => {
  // A red PETG project colour should take the PETG head even though the PLA
  // head is the closer colour: material changes how it prints.
  const plan = planFilamentMapping(project(['PETG', '#FF0000']), LOADED_RED_GREEN);
  assert.equal(plan.mapping.slots[0].toolhead, 1);
});

test('suggestion does not reuse a head it has already suggested', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#FF0000'], ['PLA', '#FF0000']),
    LOADED_RED_GREEN
  );
  assert.deepEqual(
    plan.mapping.slots.map((slot) => slot.toolhead),
    [0, 1]
  );
});

test('an operator choice always wins over the suggestion', () => {
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    choices: { 0: 1 },
  });
  assert.equal(plan.mapping.slots[0].toolhead, 1);
});

test('a suggested mapping is never confirmed on the operator’s behalf', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#FF0000'], ['PETG', '#00FF00']),
    LOADED_RED_GREEN
  );

  assert.equal(plan.mapping.confirmedAt, null);
  // And so the start gate stays shut, however perfect the match.
  assert.equal(isFilamentMappingComplete(plan.mapping), false);
});

test('confirming a complete mapping is what opens the gate', () => {
  const plan = planFilamentMapping(
    project(['PLA', '#FF0000'], ['PETG', '#00FF00']),
    LOADED_RED_GREEN,
    { confirmedAt: 1_700_000_000_000 }
  );
  assert.equal(isFilamentMappingComplete(plan.mapping), true);
});

// --- the hash a start approval binds to ------------------------------------

test('the plan carries the Stage B mapping hash, not a parallel one', () => {
  const plan = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN);
  assert.equal(plan.mapHash, filamentMapHash(plan.mapping));
  assert.match(plan.mapHash, /^[0-9a-f]{64}$/);
});

test('changing a toolhead changes the hash, so an approval is invalidated', () => {
  const before = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    choices: { 0: 0 },
  });
  const after = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    choices: { 0: 1 },
  });
  assert.notEqual(before.mapHash, after.mapHash);
});

test('confirming an unchanged mapping does not change the hash', () => {
  const proposed = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN);
  const confirmed = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    confirmedAt: 1_700_000_000_000,
  });
  assert.equal(proposed.mapHash, confirmed.mapHash);
});

test('swapping the spool in a mapped head changes the hash', () => {
  // The approval binds to what is loaded, not only to which head was picked.
  const before = planFilamentMapping(project(['PLA', '#FF0000']), LOADED_RED_GREEN, {
    choices: { 0: 0 },
  });
  const swapped = readLoadedSlots(
    printTaskConfig({ filament_color_rgba: ['0000FFFF', '00FF00FF', '000000FF', '000000FF'] })
  );
  const after = planFilamentMapping(project(['PLA', '#FF0000']), swapped, { choices: { 0: 0 } });

  assert.notEqual(before.mapHash, after.mapHash);
});
