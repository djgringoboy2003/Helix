const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  inspectThreeMfEntries,
  rejectionsOf,
} = require(servicePath('import', 'ThreeMfInspector.ts'));
const { classifyImportFile } = require(servicePath('import', 'ImportTypes.ts'));

// Entry lists taken from the shapes Bambu Studio and Orca actually emit, plus a
// plain 3MF from a CAD exporter. Only paths matter here — the inspector never
// inflates anything, which is the whole reason it can run on an untrusted file.

const OPC_PARTS = ['[Content_Types].xml', '_rels/.rels'];

const PLAIN_3MF = [...OPC_PARTS, '3D/3dmodel.model'];

const BAMBU_UNSLICED = [
  ...OPC_PARTS,
  '3D/3dmodel.model',
  '3D/_rels/3dmodel.model.rels',
  '3D/Objects/object_1.model',
  'Metadata/model_settings.config',
  'Metadata/project_settings.config',
  'Metadata/plate_1.png',
  'Metadata/plate_1_small.png',
];

const BAMBU_SLICED = [
  ...BAMBU_UNSLICED,
  'Metadata/slice_info.config',
  'Metadata/plate_1.gcode',
  'Metadata/plate_1.gcode.md5',
];

const codes = (contents) => contents.findings.map((finding) => finding.code);

// --- content classification ------------------------------------------------

test('a plain 3MF with only geometry is accepted as geometry', () => {
  const contents = inspectThreeMfEntries(PLAIN_3MF);
  assert.equal(contents.kind, 'geometry');
  assert.equal(contents.ok, true);
  assert.deepEqual(contents.modelParts, ['3D/3dmodel.model']);
  assert.deepEqual(contents.slicedOutputPaths, []);
  assert.equal(contents.producer, 'generic');
});

test('a Bambu project with geometry and no G-code is accepted', () => {
  const contents = inspectThreeMfEntries(BAMBU_UNSLICED);
  assert.equal(contents.kind, 'geometry');
  assert.equal(contents.ok, true);
  assert.equal(contents.producer, 'bambu-or-orca');
  assert.deepEqual(contents.modelParts, ['3D/3dmodel.model', '3D/Objects/object_1.model']);
});

test('geometry plus foreign G-code is accepted, and the G-code is listed for discard', () => {
  const contents = inspectThreeMfEntries(BAMBU_SLICED);
  assert.equal(contents.kind, 'geometry-and-gcode');
  assert.equal(contents.ok, true);
  assert.ok(codes(contents).includes('content/foreign-slice-output'));
  assert.deepEqual(contents.slicedOutputPaths, [
    'Metadata/plate_1.gcode',
    'Metadata/plate_1.gcode.md5',
  ]);
});

test('a pre-sliced-only file is rejected rather than passed to the slicer', () => {
  // No `.model` part anywhere: nothing to retarget, and the safety rules forbid
  // sending another machine's G-code.
  const contents = inspectThreeMfEntries([
    ...OPC_PARTS,
    'Metadata/slice_info.config',
    'Metadata/plate_1.gcode',
  ]);
  assert.equal(contents.kind, 'pre-sliced-only');
  assert.equal(contents.ok, false);
  assert.deepEqual(
    rejectionsOf(contents).map((finding) => finding.code),
    ['content/pre-sliced-only']
  );
});

test('an archive with neither geometry nor G-code is rejected as empty', () => {
  const contents = inspectThreeMfEntries([...OPC_PARTS, 'Metadata/plate_1.png']);
  assert.equal(contents.kind, 'empty');
  assert.equal(contents.ok, false);
  assert.deepEqual(
    rejectionsOf(contents).map((finding) => finding.code),
    ['content/no-geometry']
  );
});

test('geometry in an object part alone still counts as geometry', () => {
  // Some exporters leave 3dmodel.model as a shell and put meshes in components.
  const contents = inspectThreeMfEntries([...OPC_PARTS, '3D/Objects/object_1.model']);
  assert.equal(contents.kind, 'geometry');
  assert.equal(contents.ok, true);
});

// --- plates ----------------------------------------------------------------

test('a single-plate project reports one plate with its thumbnails', () => {
  const contents = inspectThreeMfEntries(BAMBU_UNSLICED);
  assert.equal(contents.plates.length, 1);
  assert.deepEqual(contents.plates[0], {
    id: 1,
    hasGcode: false,
    thumbnailPath: 'Metadata/plate_1.png',
    smallThumbnailPath: 'Metadata/plate_1_small.png',
  });
  assert.equal(contents.plateCount, 1);
});

test('a multi-plate project reports every plate, in order, with a notice', () => {
  const contents = inspectThreeMfEntries([
    ...OPC_PARTS,
    '3D/3dmodel.model',
    'Metadata/plate_3.png',
    'Metadata/plate_1.png',
    'Metadata/plate_2.png',
    'Metadata/plate_2.gcode',
  ]);
  assert.deepEqual(
    contents.plates.map((plate) => plate.id),
    [1, 2, 3]
  );
  assert.equal(contents.plateCount, 3);
  assert.deepEqual(
    contents.plates.map((plate) => plate.hasGcode),
    [false, true, false]
  );
  assert.ok(codes(contents).includes('content/multi-plate'));
});

test('a plain 3MF declares no plates but still counts as one', () => {
  const contents = inspectThreeMfEntries(PLAIN_3MF);
  assert.deepEqual(contents.plates, []);
  assert.equal(contents.plateCount, 1);
  assert.ok(!codes(contents).includes('content/multi-plate'));
});

test('a plate known only from its G-code is still reported', () => {
  const contents = inspectThreeMfEntries([...OPC_PARTS, '3D/3dmodel.model', 'Metadata/plate_7.gcode']);
  assert.deepEqual(contents.plates, [
    { id: 7, hasGcode: true, thumbnailPath: null, smallThumbnailPath: null },
  ]);
});

test('the small thumbnail is not mistaken for the plate render', () => {
  // `plate_1_small.png` must not satisfy the `plate_N.png` pattern, or the
  // picker would show the thumbnail intended for a list row.
  const contents = inspectThreeMfEntries([...OPC_PARTS, '3D/3dmodel.model', 'Metadata/plate_1_small.png']);
  assert.equal(contents.plates[0].thumbnailPath, null);
  assert.equal(contents.plates[0].smallThumbnailPath, 'Metadata/plate_1_small.png');
});

test('other per-plate renders are not counted as plate thumbnails', () => {
  const contents = inspectThreeMfEntries([
    ...OPC_PARTS,
    '3D/3dmodel.model',
    'Metadata/top_1.png',
    'Metadata/pick_1.png',
    'Metadata/plate_no_light_1.png',
  ]);
  assert.deepEqual(contents.plates, []);
});

// --- foreign profile -------------------------------------------------------

test('a foreign slicer profile is reported so preparation can rebuild it', () => {
  const contents = inspectThreeMfEntries(BAMBU_UNSLICED);
  assert.equal(contents.hasProjectSettings, true);
  assert.equal(contents.hasModelSettings, true);
  assert.equal(contents.hasSliceInfo, false);
  assert.ok(codes(contents).includes('content/foreign-profile'));
});

test('a plain 3MF carries no foreign profile and gets no notice', () => {
  const contents = inspectThreeMfEntries(PLAIN_3MF);
  assert.equal(contents.hasProjectSettings, false);
  assert.deepEqual(contents.findings, []);
});

// --- robustness ------------------------------------------------------------

test('directory entries are ignored rather than classified', () => {
  const contents = inspectThreeMfEntries(['3D/', 'Metadata/', ...PLAIN_3MF]);
  assert.equal(contents.kind, 'geometry');
  assert.deepEqual(contents.modelParts, ['3D/3dmodel.model']);
});

test('an unusually cased archive is classified the same way', () => {
  const contents = inspectThreeMfEntries([
    '[content_types].xml',
    '_RELS/.RELS',
    '3d/3DMODEL.MODEL',
    'METADATA/PROJECT_SETTINGS.CONFIG',
    'METADATA/PLATE_1.PNG',
  ]);
  assert.equal(contents.kind, 'geometry');
  assert.equal(contents.hasProjectSettings, true);
  assert.deepEqual(
    contents.plates.map((plate) => plate.id),
    [1]
  );
  // The original casing is preserved for anything that has to open the entry.
  assert.deepEqual(contents.modelParts, ['3d/3DMODEL.MODEL']);
});

test('an empty entry list is rejected, not treated as a valid empty project', () => {
  const contents = inspectThreeMfEntries([]);
  assert.equal(contents.kind, 'empty');
  assert.equal(contents.ok, false);
});

test('a plate number that is not a plain integer does not create a plate', () => {
  const contents = inspectThreeMfEntries([
    ...OPC_PARTS,
    '3D/3dmodel.model',
    'Metadata/plate_.png',
    'Metadata/plate_x.png',
    'Metadata/plate_1extra.png',
  ]);
  assert.deepEqual(contents.plates, []);
});

test('a plate path nested deeper than Metadata is not counted', () => {
  // Anchoring on the full path stops an attacker-chosen name deep in the
  // archive from inventing plates.
  const contents = inspectThreeMfEntries([
    ...OPC_PARTS,
    '3D/3dmodel.model',
    'Metadata/sub/plate_1.png',
    'other/Metadata/plate_2.png',
  ]);
  assert.deepEqual(contents.plates, []);
});

test('G-code anywhere in the archive is listed for discard, not just under Metadata', () => {
  const contents = inspectThreeMfEntries([...OPC_PARTS, '3D/3dmodel.model', 'extras/bed_level.gcode']);
  assert.equal(contents.kind, 'geometry-and-gcode');
  assert.deepEqual(contents.slicedOutputPaths, ['extras/bed_level.gcode']);
});

// --- file kind routing -----------------------------------------------------

test('file kinds route archives and meshes apart', () => {
  assert.equal(classifyImportFile('model.3mf'), '3mf');
  assert.equal(classifyImportFile('MODEL.3MF'), '3mf');
  assert.equal(classifyImportFile('part.stl'), 'mesh');
  assert.equal(classifyImportFile('part.obj'), 'mesh');
  assert.equal(classifyImportFile('part.step'), 'mesh');
  assert.equal(classifyImportFile('part.stp'), 'mesh');
});

test('anything else has no import route', () => {
  assert.equal(classifyImportFile('sliced.gcode'), null);
  assert.equal(classifyImportFile('photo.png'), null);
  assert.equal(classifyImportFile('archive.zip'), null);
  assert.equal(classifyImportFile('model'), null);
  assert.equal(classifyImportFile(''), null);
});
