const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  PRINT_JOB_STATES,
  TERMINAL_STATES,
  createPrintJob,
  filamentMapHash,
  isFilamentMappingComplete,
  isLockedState,
  isTerminalState,
} = require(servicePath('jobs', 'PrintJobTypes.ts'));
const {
  allowedTransitions,
  applyRevisionChange,
  attachArtifact,
  canTransition,
  clearStartApproval,
  evaluateStartGate,
  grantStartApproval,
  recordUpload,
  setFilamentMapping,
  setPrinter,
  setProfileSelection,
  setWarnings,
  transition,
} = require(servicePath('jobs', 'PrintJobMachine.ts'));
const {
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  createStartApproval,
  isApprovalExpired,
  isStartApprovalRecord,
  validateCameraFreshness,
  validateStartApproval,
} = require(servicePath('jobs', 'ApprovalService.ts'));
const { sha256Hex } = require(servicePath('security', 'Sha256.ts'));
const { utf8ToBytes } = require(servicePath('security', 'Base64.ts'));

const T0 = 1_700_000_000_000;
const hashOf = (text) => sha256Hex(utf8ToBytes(text));

const GCODE_HASH = hashOf('gcode-v1');
const GCODE_HASH_V2 = hashOf('gcode-v2');

function mapping(overrides = {}) {
  return {
    slots: [
      {
        sourceIndex: 0,
        toolhead: 0,
        sourceMaterial: 'PLA',
        sourceColor: 'FF0000',
        loadedMaterial: 'PLA',
        loadedColor: 'FF0000',
      },
      {
        sourceIndex: 1,
        toolhead: 1,
        sourceMaterial: 'PLA',
        sourceColor: '00FF00',
        loadedMaterial: 'PLA',
        loadedColor: '00FF00',
      },
    ],
    confirmedAt: T0,
    ...overrides,
  };
}

function artifact(type, sha256, id = `${type}-1`) {
  return {
    id,
    jobId: 'job-1',
    type,
    path: `/data/${id}`,
    sha256,
    sizeBytes: 1024,
    createdAt: T0,
  };
}

const profile = { sourceProfileId: 'mw-9', u1ProfileId: 'u1-0.4-standard', nozzleDiameter: 0.4, plateId: 1 };

/** Drives a fresh job to `uploading`, with nothing yet recorded on the printer. */
function jobAtUploading(gcodeHash = GCODE_HASH) {
  let job = createPrintJob({ id: 'job-1', modelId: 'model-1', printerId: 'printer-1', createdAt: T0 });
  job = transition(job, 'downloading', T0);
  job = transition(job, 'downloaded', T0);
  job = attachArtifact(job, artifact('source', hashOf('source')), T0);
  job = transition(job, 'inspecting', T0);
  job = transition(job, 'preparing', T0);
  job = attachArtifact(job, artifact('prepared', hashOf('prepared')), T0);
  job = transition(job, 'prepared', T0);
  job = setProfileSelection(job, profile, T0);
  job = setFilamentMapping(job, mapping(), T0);
  job = transition(job, 'slicing', T0);
  job = attachArtifact(job, artifact('gcode', gcodeHash), T0);
  job = transition(job, 'review_required', T0);
  job = transition(job, 'approved_for_upload', T0);
  return transition(job, 'uploading', T0);
}

/** `uploaded` — the resting state before any approval exists. */
function jobAtUploaded(gcodeHash = GCODE_HASH) {
  const job = recordUpload(jobAtUploading(gcodeHash), 'model_v1.gcode', T0);
  return transition(job, 'uploaded', T0);
}

function approvedJob(now = T0) {
  const uploaded = jobAtUploaded();
  const awaiting = transition(uploaded, 'awaiting_start_approval', now);
  const approval = createStartApproval({
    job: awaiting,
    printerId: awaiting.printerId,
    filename: 'model_v1.gcode',
    gcodeSha256: GCODE_HASH,
    approvedAt: now,
  });
  return grantStartApproval(awaiting, approval, now);
}

function startContext(overrides = {}) {
  return {
    activePrinterId: 'printer-1',
    printerConnected: true,
    klipperReady: true,
    printerIdle: true,
    uploadedFilename: 'model_v1.gcode',
    availableToolheads: [0, 1, 2, 3],
    cameraFrame: { capturedAt: T0, printerId: 'printer-1', cameraEndpoint: '/webcam/snapshot', jobRevision: 6 },
    operatorConfirmedBedClear: true,
    now: T0 + 1000,
    ...overrides,
  };
}

// --- transition table ------------------------------------------------------

test('every declared job state has a transition rule', () => {
  for (const state of PRINT_JOB_STATES) {
    assert.ok(Array.isArray(allowedTransitions(state)), `${state} must have a transition list`);
  }
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(allowedTransitions(state), [], `${state} must be terminal`);
  }
});

test('there is no route from uploaded to motion without both approval steps', () => {
  // The core upload-only rule: uploading must never flow into starting.
  assert.equal(allowedTransitions('uploaded').includes('starting'), false);
  assert.equal(allowedTransitions('uploaded').includes('printing'), false);
  assert.equal(allowedTransitions('uploaded').includes('start_approved'), false);
  assert.deepEqual(allowedTransitions('uploaded').includes('awaiting_start_approval'), true);
  assert.deepEqual(allowedTransitions('awaiting_start_approval'), [
    'start_approved',
    'uploaded',
    'cancelled',
    'failed',
  ]);
  assert.equal(allowedTransitions('start_approved').includes('starting'), true);

  const uploaded = jobAtUploaded();
  assert.equal(canTransition(uploaded, 'starting').ok, false);
  assert.equal(canTransition(uploaded, 'printing').ok, false);
  assert.throws(() => transition(uploaded, 'starting', T0), { code: 'job/invalid-transition' });
});

test('a full valid run reaches printing through every required step', () => {
  let job = approvedJob();
  assert.equal(job.state, 'start_approved');
  job = transition(job, 'starting', T0 + 1000);
  job = transition(job, 'printing', T0 + 2000);
  job = transition(job, 'paused', T0 + 3000);
  job = transition(job, 'printing', T0 + 4000);
  job = transition(job, 'completed', T0 + 5000);
  assert.equal(job.state, 'completed');
  assert.equal(isTerminalState(job.state), true);
});

test('terminal states reject all further transitions', () => {
  for (const terminal of TERMINAL_STATES) {
    const job = { ...createPrintJob({ id: 'job-1', modelId: 'm', printerId: 'p', createdAt: T0 }), state: terminal };
    for (const target of PRINT_JOB_STATES) {
      if (target === terminal) continue;
      const check = canTransition(job, target);
      assert.equal(check.ok, false, `${terminal} → ${target} must be refused`);
      assert.equal(check.code, 'job/terminal-state');
    }
  }
});

test('transitioning to the current state is refused rather than silently ignored', () => {
  const job = jobAtUploaded();
  const check = canTransition(job, 'uploaded');
  assert.equal(check.ok, false);
  assert.match(check.message, /already uploaded/);
});

test('slicing is blocked until the model, profile and filament map are all present', () => {
  let job = createPrintJob({ id: 'job-1', modelId: 'model-1', printerId: 'printer-1', createdAt: T0 });
  job = transition(job, 'inspecting', T0);
  job = transition(job, 'preparing', T0);
  job = attachArtifact(job, artifact('prepared', hashOf('prepared')), T0);
  job = transition(job, 'prepared', T0);

  assert.equal(canTransition(job, 'slicing').code, 'job/missing-artifact');

  job = setProfileSelection(job, profile, T0);
  assert.equal(canTransition(job, 'slicing').code, 'job/missing-filament-map');

  // An unconfirmed mapping is not a mapping.
  job = setFilamentMapping(job, mapping({ confirmedAt: null }), T0);
  assert.equal(canTransition(job, 'slicing').code, 'job/missing-filament-map');

  // Neither is one with an unassigned toolhead — the app never guesses.
  job = setFilamentMapping(
    job,
    mapping({ slots: [{ ...mapping().slots[0], toolhead: null }] }),
    T0
  );
  assert.equal(canTransition(job, 'slicing').code, 'job/missing-filament-map');

  job = setFilamentMapping(job, mapping(), T0);
  assert.equal(canTransition(job, 'slicing').ok, true);
});

test('upload is blocked by a missing hash and by blocking warnings', () => {
  let job = jobAtUploaded();
  job = transition(job, 'review_required', T0);
  assert.equal(canTransition(job, 'approved_for_upload').ok, true);

  const blocked = setWarnings(job, [{ code: 'extents', level: 'blocking', message: 'Model exceeds bed.' }], T0);
  assert.equal(canTransition(blocked, 'approved_for_upload').ok, false);

  const advisory = setWarnings(job, [{ code: 'supports', level: 'warning', message: 'No supports.' }], T0);
  assert.equal(canTransition(advisory, 'approved_for_upload').ok, true);

  const hashless = { ...job, gcodeSha256: null };
  assert.equal(canTransition(hashless, 'approved_for_upload').code, 'job/missing-artifact');
});

test('completing an upload requires the filename to be recorded first', () => {
  let job = jobAtUploading();
  assert.equal(job.uploadedFilename, null);
  assert.equal(canTransition(job, 'uploaded').code, 'job/missing-upload');

  job = recordUpload(job, 'model_v2.gcode', T0);
  assert.equal(canTransition(job, 'uploaded').ok, true);
  assert.equal(job.revision, jobAtUploading().revision, 'recording an upload is not a revision change');
  assert.throws(() => recordUpload(job, '   ', T0), { code: 'job/missing-upload' });
});

// --- revision rules --------------------------------------------------------

test('each artifact bumps the revision and rewinds to the step that must be redone', () => {
  const uploaded = jobAtUploaded();
  const startRevision = uploaded.revision;

  const resliced = attachArtifact(uploaded, artifact('gcode', GCODE_HASH_V2, 'gcode-2'), T0 + 1);
  assert.equal(resliced.revision, startRevision + 1);
  assert.equal(resliced.state, 'review_required');
  assert.equal(resliced.gcodeSha256, GCODE_HASH_V2);
  assert.equal(resliced.uploadedFilename, null, 'a new slice invalidates the uploaded file');

  const reprepared = attachArtifact(uploaded, artifact('prepared', hashOf('prepared-2'), 'prepared-2'), T0 + 1);
  assert.equal(reprepared.state, 'prepared');
  assert.equal(reprepared.gcodeSha256, null, 'a new prepared file invalidates the slice');
  assert.equal(reprepared.uploadedFilename, null);
  assert.equal(reprepared.preparedArtifactId, 'prepared-2');

  const resourced = attachArtifact(uploaded, artifact('source', hashOf('source-2'), 'source-2'), T0 + 1);
  assert.equal(resourced.state, 'downloaded');
  assert.equal(resourced.preparedArtifactId, null, 'a new source invalidates the prepared file');
  assert.equal(resourced.gcodeSha256, null);
});

test('a thumbnail does not spend a revision or rewind the job', () => {
  const uploaded = jobAtUploaded();
  const next = attachArtifact(uploaded, artifact('thumbnail', hashOf('thumb'), 'thumb-1'), T0 + 1);
  assert.equal(next.revision, uploaded.revision);
  assert.equal(next.state, 'uploaded');
});

test('changing the filament mapping or profile forces a re-slice', () => {
  const uploaded = jobAtUploaded();

  const remapped = setFilamentMapping(uploaded, mapping({ slots: [{ ...mapping().slots[0], toolhead: 2 }] }), T0 + 1);
  assert.equal(remapped.state, 'prepared');
  assert.equal(remapped.revision, uploaded.revision + 1);
  assert.equal(remapped.gcodeSha256, null);

  const reprofiled = setProfileSelection(uploaded, { ...profile, nozzleDiameter: 0.6 }, T0 + 1);
  assert.equal(reprofiled.state, 'prepared');
  assert.equal(reprofiled.gcodeSha256, null);
});

test('changing printer invalidates the upload but keeps the slice', () => {
  const uploaded = jobAtUploaded();
  const moved = setPrinter(uploaded, 'printer-2', T0 + 1);

  assert.equal(moved.printerId, 'printer-2');
  assert.equal(moved.state, 'review_required');
  assert.equal(moved.uploadedFilename, null);
  assert.equal(moved.gcodeSha256, GCODE_HASH, 'the sliced file itself is unchanged');
  assert.equal(setPrinter(uploaded, 'printer-1', T0 + 1), uploaded, 'same printer is a no-op');
  assert.throws(() => setPrinter(uploaded, '  ', T0), { code: 'job/missing-printer' });
});

test('a revision change never moves a job forward', () => {
  let job = createPrintJob({ id: 'job-1', modelId: 'model-1', printerId: 'printer-1', createdAt: T0 });
  job = transition(job, 'downloading', T0);
  // Rewind target for a source artifact is `downloaded`, which is ahead of here.
  const next = attachArtifact(job, artifact('source', hashOf('source')), T0);
  assert.equal(next.state, 'downloading');
  assert.equal(next.revision, job.revision + 1);
});

test('jobs the printer may be acting on refuse every edit', () => {
  const running = { ...approvedJob(), state: 'printing' };
  assert.equal(isLockedState('printing'), true);

  for (const attempt of [
    () => setFilamentMapping(running, mapping(), T0 + 1),
    () => setProfileSelection(running, profile, T0 + 1),
    () => setPrinter(running, 'printer-2', T0 + 1),
    () => attachArtifact(running, artifact('gcode', GCODE_HASH_V2, 'gcode-2'), T0 + 1),
    () => applyRevisionChange(running, 'profile', T0 + 1, (job) => job),
  ]) {
    assert.throws(attempt, { code: 'job/revision-locked' });
  }
});

test('every revision change is recorded as an event', () => {
  const uploaded = jobAtUploaded();
  const resliced = attachArtifact(uploaded, artifact('gcode', GCODE_HASH_V2, 'gcode-2'), T0 + 1);
  const revisionEvents = resliced.events.filter((event) => event.type === 'revision');

  assert.ok(revisionEvents.length >= 1);
  const last = revisionEvents[revisionEvents.length - 1];
  assert.equal(last.revision, resliced.revision);
  assert.match(last.detail, /gcode-artifact/);
});

// --- approval binding ------------------------------------------------------

test('an approval binds every value the safety rules require', () => {
  const job = approvedJob();
  const approval = job.startApproval;

  assert.equal(approval.jobId, job.id);
  assert.equal(approval.jobRevision, job.revision);
  assert.equal(approval.printerId, 'printer-1');
  assert.equal(approval.filename, 'model_v1.gcode');
  assert.equal(approval.gcodeSha256, GCODE_HASH);
  assert.equal(approval.filamentMapHash, filamentMapHash(job.filamentMapping));
  assert.equal(approval.approvedAt, T0);
  assert.equal(approval.expiresAt, T0 + DEFAULT_APPROVAL_TTL_MS);
  assert.equal(isStartApprovalRecord(approval), true);
});

test('approval lifetime is capped no matter what the caller asks for', () => {
  const awaiting = transition(jobAtUploaded(), 'awaiting_start_approval', T0);
  const approval = createStartApproval({
    job: awaiting,
    printerId: 'printer-1',
    filename: 'model_v1.gcode',
    gcodeSha256: GCODE_HASH,
    approvedAt: T0,
    ttlMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(approval.expiresAt, T0 + MAX_APPROVAL_TTL_MS);
});

test('an approval cannot be created from incomplete job data', () => {
  const awaiting = transition(jobAtUploaded(), 'awaiting_start_approval', T0);
  const base = { job: awaiting, printerId: 'printer-1', filename: 'model_v1.gcode', gcodeSha256: GCODE_HASH, approvedAt: T0 };

  assert.throws(() => createStartApproval({ ...base, printerId: '' }), { code: 'job/missing-printer' });
  assert.throws(() => createStartApproval({ ...base, filename: '  ' }), { code: 'job/missing-upload' });
  assert.throws(() => createStartApproval({ ...base, gcodeSha256: 'not-a-hash' }), { code: 'approval/invalid-record' });
  assert.throws(() => createStartApproval({ ...base, approvedAt: 0 }), { code: 'approval/invalid-record' });
  assert.throws(
    () => createStartApproval({ ...base, job: { ...awaiting, filamentMapping: mapping({ confirmedAt: null }) } }),
    { code: 'job/missing-filament-map' }
  );
});

test('approval can only be granted while awaiting approval', () => {
  const uploaded = jobAtUploaded();
  const awaiting = transition(uploaded, 'awaiting_start_approval', T0);
  const approval = createStartApproval({
    job: awaiting,
    printerId: 'printer-1',
    filename: 'model_v1.gcode',
    gcodeSha256: GCODE_HASH,
    approvedAt: T0,
  });

  assert.throws(() => grantStartApproval(uploaded, approval, T0), { code: 'job/invalid-transition' });
  assert.equal(grantStartApproval(awaiting, approval, T0).state, 'start_approved');
});

test('each changed bound value invalidates the approval', () => {
  const job = approvedJob();
  const context = { activePrinterId: 'printer-1', uploadedFilename: 'model_v1.gcode', now: T0 + 1000 };
  assert.equal(validateStartApproval(job, job.startApproval, context).ok, true);

  const cases = [
    ['approval/revision-mismatch', { ...job, revision: job.revision + 1 }, context],
    ['approval/printer-mismatch', { ...job, printerId: 'printer-2' }, context],
    ['approval/printer-mismatch', job, { ...context, activePrinterId: 'printer-2' }],
    ['approval/filename-mismatch', { ...job, uploadedFilename: 'other.gcode' }, context],
    ['approval/filename-mismatch', job, { ...context, uploadedFilename: 'other.gcode' }],
    ['approval/gcode-hash-mismatch', { ...job, gcodeSha256: GCODE_HASH_V2 }, context],
    ['approval/gcode-hash-mismatch', { ...job, gcodeSha256: null }, context],
    [
      'approval/filament-map-mismatch',
      { ...job, filamentMapping: mapping({ slots: [{ ...mapping().slots[0], toolhead: 3 }] }) },
      context,
    ],
    ['approval/job-mismatch', { ...job, id: 'job-2' }, context],
  ];

  for (const [expectedCode, mutatedJob, mutatedContext] of cases) {
    const result = validateStartApproval(mutatedJob, job.startApproval, mutatedContext);
    assert.equal(result.ok, false, `${expectedCode} case must fail`);
    assert.equal(result.code, expectedCode);
  }
});

test('an expired approval, or one from a backwards clock, is refused', () => {
  const job = approvedJob();
  const context = { activePrinterId: 'printer-1', uploadedFilename: 'model_v1.gcode', now: T0 };

  assert.equal(validateStartApproval(job, job.startApproval, { ...context, now: T0 + DEFAULT_APPROVAL_TTL_MS - 1 }).ok, true);
  assert.equal(
    validateStartApproval(job, job.startApproval, { ...context, now: T0 + DEFAULT_APPROVAL_TTL_MS }).code,
    'approval/expired'
  );
  assert.equal(validateStartApproval(job, job.startApproval, { ...context, now: T0 - 1 }).code, 'approval/expired');
  assert.equal(validateStartApproval(job, job.startApproval, { ...context, now: NaN }).code, 'approval/expired');
  assert.equal(validateStartApproval(job, null, context).code, 'approval/missing');

  assert.equal(isApprovalExpired(job.startApproval, T0 + DEFAULT_APPROVAL_TTL_MS), true);
  assert.equal(isApprovalExpired(null, T0), true);
});

test('any revision change drops an existing approval and rewinds out of start_approved', () => {
  const job = approvedJob();
  assert.equal(job.state, 'start_approved');

  const resliced = attachArtifact(job, artifact('gcode', GCODE_HASH_V2, 'gcode-2'), T0 + 1);
  assert.equal(resliced.startApproval, null);
  assert.equal(resliced.state, 'review_required');
  assert.ok(resliced.events.some((event) => event.type === 'approval-cleared'));
});

test('leaving start_approved for anything but starting clears the approval', () => {
  const job = approvedJob();
  const backedOut = transition(job, 'awaiting_start_approval', T0 + 1);
  assert.equal(backedOut.startApproval, null);

  const cancelled = transition(job, 'cancelled', T0 + 1);
  assert.equal(cancelled.startApproval, null);

  // Starting is the one move that keeps it, because the gate re-reads it.
  const starting = transition(job, 'starting', T0 + 1);
  assert.notEqual(starting.startApproval, null);
});

test('clearStartApproval rewinds and is safe to call twice', () => {
  const job = approvedJob();
  const cleared = clearStartApproval(job, 'settings changed', T0 + 1);
  assert.equal(cleared.state, 'awaiting_start_approval');
  assert.equal(cleared.startApproval, null);
  assert.equal(clearStartApproval(cleared, 'again', T0 + 2), cleared);
});

test('rejects malformed approval records restored from storage', () => {
  const valid = approvedJob().startApproval;
  assert.equal(isStartApprovalRecord(valid), true);
  assert.equal(isStartApprovalRecord(null), false);
  assert.equal(isStartApprovalRecord({ ...valid, gcodeSha256: 'short' }), false);
  assert.equal(isStartApprovalRecord({ ...valid, filamentMapHash: undefined }), false);
  assert.equal(isStartApprovalRecord({ ...valid, jobRevision: '2' }), false);
});

// --- filament map hash -----------------------------------------------------

test('filament map hash ignores slot order and case but not assignment', () => {
  const base = mapping();
  const reordered = mapping({ slots: [base.slots[1], base.slots[0]] });
  const recased = mapping({
    slots: base.slots.map((slot) => ({ ...slot, sourceColor: slot.sourceColor.toLowerCase() })),
  });
  const reconfirmed = mapping({ confirmedAt: T0 + 99999 });
  const changed = mapping({ slots: [{ ...base.slots[0], toolhead: 2 }, base.slots[1]] });

  assert.equal(filamentMapHash(reordered), filamentMapHash(base));
  assert.equal(filamentMapHash(recased), filamentMapHash(base));
  assert.equal(filamentMapHash(reconfirmed), filamentMapHash(base));
  assert.notEqual(filamentMapHash(changed), filamentMapHash(base));
  assert.notEqual(filamentMapHash(null), filamentMapHash(base));
});

test('an unmapped slot hashes differently from every real toolhead', () => {
  const unmapped = mapping({ slots: [{ ...mapping().slots[0], toolhead: null }] });
  assert.equal(isFilamentMappingComplete(unmapped), false);
  for (const toolhead of [0, 1, 2, 3]) {
    const mapped = mapping({ slots: [{ ...mapping().slots[0], toolhead }] });
    assert.notEqual(filamentMapHash(unmapped), filamentMapHash(mapped));
  }
});

// --- start gate ------------------------------------------------------------

test('the start gate passes only when every check is satisfied', () => {
  const job = approvedJob();
  assert.deepEqual(evaluateStartGate(job, startContext()), []);
});

test('the start gate fails closed on each unknown or unsafe condition', () => {
  const job = approvedJob();
  const cases = [
    ['job/missing-printer', { printerConnected: false }],
    ['job/missing-printer', { klipperReady: false }],
    ['job/concurrent-action', { printerIdle: false }],
    ['approval/not-granted', { operatorConfirmedBedClear: false }],
    ['camera/unavailable', { cameraFrame: null }],
    ['camera/stale', { cameraFrame: { capturedAt: T0 - 600000, printerId: 'printer-1', cameraEndpoint: '/c', jobRevision: 6 } }],
    ['camera/printer-mismatch', { cameraFrame: { capturedAt: T0, printerId: 'printer-9', cameraEndpoint: '/c', jobRevision: 6 } }],
    ['camera/revision-mismatch', { cameraFrame: { capturedAt: T0, printerId: 'printer-1', cameraEndpoint: '/c', jobRevision: 1 } }],
    ['approval/filename-mismatch', { uploadedFilename: 'someone_elses.gcode' }],
    ['job/missing-filament-map', { availableToolheads: [0] }],
  ];

  for (const [expectedCode, overrides] of cases) {
    const failures = evaluateStartGate(job, startContext(overrides));
    assert.ok(failures.length > 0, `${expectedCode} case must produce a failure`);
    assert.ok(
      failures.some((failure) => failure.code === expectedCode),
      `expected ${expectedCode}, got ${failures.map((f) => f.code).join(', ')}`
    );
  }
});

test('the start gate reports every failing check at once', () => {
  const job = approvedJob();
  const failures = evaluateStartGate(
    job,
    startContext({ printerConnected: false, printerIdle: false, operatorConfirmedBedClear: false, cameraFrame: null })
  );
  assert.ok(failures.length >= 4, `expected several failures, got ${failures.length}`);
});

test('the start gate refuses a job that is not start_approved', () => {
  const uploaded = jobAtUploaded();
  const failures = evaluateStartGate(uploaded, startContext());
  assert.ok(failures.some((failure) => failure.code === 'job/invalid-transition'));
  assert.ok(failures.some((failure) => failure.code === 'approval/missing'));
});

test('camera freshness needs a frame from this printer, this revision, and now', () => {
  const job = approvedJob();
  const fresh = { capturedAt: T0, printerId: 'printer-1', cameraEndpoint: '/webcam/snapshot', jobRevision: job.revision };

  assert.equal(validateCameraFreshness(job, fresh, T0 + 1000).ok, true);
  assert.equal(validateCameraFreshness(job, fresh, T0 + 61_000).code, 'camera/stale');
  assert.equal(validateCameraFreshness(job, fresh, T0 - 1).code, 'camera/stale');
  assert.equal(validateCameraFreshness(job, fresh, NaN).code, 'camera/stale');
  assert.equal(validateCameraFreshness(job, null, T0).code, 'camera/unavailable');
  assert.equal(validateCameraFreshness(job, fresh, T0 + 1000, 500).code, 'camera/stale');
});
