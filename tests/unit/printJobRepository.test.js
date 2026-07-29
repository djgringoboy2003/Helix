const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  JOB_INDEX_KEY,
  MAX_STORED_JOBS,
  PrintJobRepository,
  isPrintJobRecord,
  jobStorageKey,
  recoverJob,
} = require(servicePath('jobs', 'PrintJobRepository.ts'));
const { createPrintJob } = require(servicePath('jobs', 'PrintJobTypes.ts'));
const { sha256Hex } = require(servicePath('security', 'Sha256.ts'));
const { utf8ToBytes } = require(servicePath('security', 'Base64.ts'));

const T0 = 1_700_000_000_000;
const hashOf = (text) => sha256Hex(utf8ToBytes(text));

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (key) => (map.has(key) ? map.get(key) : null),
    setItem: async (key, value) => void map.set(key, value),
    removeItem: async (key) => void map.delete(key),
  };
}

function job(overrides = {}) {
  const base = createPrintJob({ id: 'job-1', modelId: 'model-1', printerId: 'printer-1', createdAt: T0 });
  return { ...base, ...overrides };
}

function approval(overrides = {}) {
  return {
    jobId: 'job-1',
    jobRevision: 1,
    printerId: 'printer-1',
    filename: 'model.gcode',
    gcodeSha256: hashOf('gcode'),
    filamentMapHash: hashOf('map'),
    approvedAt: T0,
    expiresAt: T0 + 300_000,
    ...overrides,
  };
}

// --- recovery rules --------------------------------------------------------

test('an interrupted step is recovered to the point it can be retried from', () => {
  const cases = [
    ['downloading', 'created'],
    ['inspecting', 'downloaded'],
    ['preparing', 'downloaded'],
    ['slicing', 'slice_failed'],
    ['uploading', 'approved_for_upload'],
  ];

  for (const [interrupted, expected] of cases) {
    const outcome = recoverJob(job({ state: interrupted }), T0 + 1000);
    assert.equal(outcome.job.state, expected, `${interrupted} must recover to ${expected}`);
    assert.equal(outcome.recovered, true);
    assert.match(outcome.reason, new RegExp(interrupted));
  }
});

test('a job interrupted mid-start fails closed rather than resuming', () => {
  // The app cannot know whether the printer began moving, so it does not guess.
  const outcome = recoverJob(job({ state: 'starting', startApproval: approval() }), T0 + 1000);
  assert.equal(outcome.job.state, 'failed');
  assert.equal(outcome.job.startApproval, null);
  assert.equal(outcome.recovered, true);
});

test('an approval never survives a restart', () => {
  const approved = job({ state: 'start_approved', startApproval: approval() });
  const outcome = recoverJob(approved, T0 + 1000);

  assert.equal(outcome.job.state, 'awaiting_start_approval');
  assert.equal(outcome.job.startApproval, null, 'the operator is no longer at the printer');
  assert.ok(outcome.job.events.some((event) => event.type === 'error'));
});

test('an expired approval is dropped even from a state that otherwise survives', () => {
  const awaiting = job({ state: 'awaiting_start_approval', startApproval: approval() });
  const later = recoverJob(awaiting, T0 + 600_000);

  assert.equal(later.job.startApproval, null);
  assert.equal(later.recovered, true);
  assert.match(later.reason, /expired/);
});

test('resting states are restored untouched', () => {
  for (const state of ['created', 'downloaded', 'prepared', 'review_required', 'uploaded', 'printing', 'completed']) {
    const stored = job({ state });
    const outcome = recoverJob(stored, T0 + 1000);
    assert.equal(outcome.recovered, false, `${state} should not need recovery`);
    assert.equal(outcome.job, stored, `${state} should be returned as-is`);
  }
});

// --- persistence -----------------------------------------------------------

test('a saved job round-trips through storage', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0 + 1000);
  const stored = job({ state: 'uploaded', uploadedFilename: 'model.gcode' });

  await repository.save(stored);
  const outcome = await repository.load('job-1');

  assert.deepEqual(outcome.job, stored);
  assert.equal(outcome.recovered, false);
  assert.equal(storage.map.has(jobStorageKey('job-1')), true);
});

test('loading an absent job returns null but a corrupt one throws', async () => {
  const storage = memoryStorage({
    [jobStorageKey('bad-json')]: '{not json',
    [jobStorageKey('bad-shape')]: JSON.stringify({ version: 1, job: { id: 'x' } }),
    [jobStorageKey('bad-state')]: JSON.stringify({ version: 1, job: { ...job(), state: 'teleporting' } }),
    [jobStorageKey('old-version')]: JSON.stringify({ version: 0, job: job() }),
  });
  const repository = new PrintJobRepository(storage, () => T0);

  assert.equal(await repository.load('missing'), null);
  for (const id of ['bad-json', 'bad-shape', 'bad-state', 'old-version']) {
    await assert.rejects(() => repository.load(id), { code: 'repository/corrupt-record' }, id);
  }
});

test('a corrupt record does not hide the operator’s other jobs', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0 + 1000);

  await repository.save(job({ id: 'job-1', updatedAt: T0 + 1 }));
  await repository.save(job({ id: 'job-2', updatedAt: T0 + 2 }));
  storage.map.set(jobStorageKey('job-1'), 'corrupted');

  const listed = await repository.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].job.id, 'job-2');
});

test('list returns newest first and loadActive skips finished jobs', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0 + 1000);

  await repository.save(job({ id: 'old', state: 'uploaded', updatedAt: T0 + 1 }));
  await repository.save(job({ id: 'done', state: 'completed', updatedAt: T0 + 9 }));
  await repository.save(job({ id: 'newer', state: 'prepared', updatedAt: T0 + 5 }));

  const listed = await repository.list();
  assert.deepEqual(listed.map((outcome) => outcome.job.id), ['done', 'newer', 'old']);

  const active = await repository.loadActive();
  assert.equal(active.job.id, 'newer');
});

test('loadActive returns null when every job has finished', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0);

  await repository.save(job({ id: 'a', state: 'completed' }));
  await repository.save(job({ id: 'b', state: 'cancelled' }));
  await repository.save(job({ id: 'c', state: 'failed' }));
  await repository.save(job({ id: 'd', state: 'rejected' }));

  assert.equal(await repository.loadActive(), null);
});

test('loadActive surfaces a recovered job so a banner can be shown', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0 + 1000);
  await repository.save(job({ state: 'slicing' }));

  const active = await repository.loadActive();
  assert.equal(active.recovered, true);
  assert.equal(active.job.state, 'slice_failed');
});

test('removing a job clears both the record and the index', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0);

  await repository.save(job({ id: 'job-1' }));
  await repository.remove('job-1');

  assert.equal(storage.map.has(jobStorageKey('job-1')), false);
  assert.deepEqual(JSON.parse(storage.map.get(JOB_INDEX_KEY)), []);
  assert.equal(await repository.load('job-1'), null);
});

test('saving the same job twice does not duplicate it in the index', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0);

  await repository.save(job({ id: 'job-1' }));
  await repository.save(job({ id: 'job-1', state: 'downloaded' }));

  assert.deepEqual(JSON.parse(storage.map.get(JOB_INDEX_KEY)), ['job-1']);
  assert.equal((await repository.load('job-1')).job.state, 'downloaded');
});

test('the stored job count is capped and old records are deleted, not orphaned', async () => {
  const storage = memoryStorage();
  const repository = new PrintJobRepository(storage, () => T0);

  for (let i = 0; i < MAX_STORED_JOBS + 5; i += 1) {
    await repository.save(job({ id: `job-${i}` }));
  }

  const index = JSON.parse(storage.map.get(JOB_INDEX_KEY));
  assert.equal(index.length, MAX_STORED_JOBS);
  assert.equal(index[0], `job-${MAX_STORED_JOBS + 4}`, 'newest first');
  assert.equal(storage.map.has(jobStorageKey('job-0')), false, 'evicted record must be deleted');
  assert.equal(storage.map.size, MAX_STORED_JOBS + 1, 'no orphaned records left behind');
});

test('a damaged index degrades to empty instead of throwing', async () => {
  const storage = memoryStorage({ [JOB_INDEX_KEY]: '{oops' });
  const repository = new PrintJobRepository(storage, () => T0);

  assert.deepEqual(await repository.list(), []);
  await repository.save(job({ id: 'job-1' }));
  assert.deepEqual(JSON.parse(storage.map.get(JOB_INDEX_KEY)), ['job-1']);
});

test('isPrintJobRecord rejects records that lost required fields', () => {
  const valid = job();
  assert.equal(isPrintJobRecord(valid), true);
  assert.equal(isPrintJobRecord({ ...valid, state: 'nope' }), false);
  assert.equal(isPrintJobRecord({ ...valid, revision: 0 }), false);
  assert.equal(isPrintJobRecord({ ...valid, revision: 1.5 }), false);
  assert.equal(isPrintJobRecord({ ...valid, id: '' }), false);
  assert.equal(isPrintJobRecord({ ...valid, events: null }), false);
  assert.equal(isPrintJobRecord({ ...valid, startApproval: { jobId: 'job-1' } }), false);
  assert.equal(isPrintJobRecord({ ...valid, startApproval: approval() }), true);
  assert.equal(isPrintJobRecord(null), false);
});
