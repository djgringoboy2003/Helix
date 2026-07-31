const assert = require('node:assert/strict');
const path = require('node:path');

const { test } = require('../../scripts/test-harness');

const servicePath = (...parts) => path.join(__dirname, '..', '..', 'services', ...parts);

const {
  advanceJob,
  isJobLive,
  isJobOnThePrinter,
  isSameJob,
} = require(servicePath('jobs', 'JobMonitor.ts'));
const { buildFilamentMapping, buildStartJob } = require(servicePath('start', 'StartJob.ts'));
const { createStartApproval } = require(servicePath('jobs', 'ApprovalService.ts'));
const { grantStartApproval, transition } = require(servicePath('jobs', 'PrintJobMachine.ts'));

const NOW = 1_700_000_000_000;
const HASH = 'a'.repeat(64);
const FILENAME = 'benchy_1700000000.gcode';

const LOADED = [
  { toolhead: 0, status: 'loaded', material: 'PLA', color: '#FF0000', brand: '', rfidLocked: false, source: 'printer' },
];

/** A job in whatever state the monitor should find it in. */
function jobIn(state) {
  const mapping = buildFilamentMapping(
    [{ sourceIndex: 0, material: 'PLA', color: '#FF0000' }],
    { 0: 0 },
    LOADED,
    NOW - 30_000
  );
  let job = buildStartJob({
    id: 'job-monitor',
    modelId: 'benchy',
    printerId: 'printer-a',
    gcodeArtifactId: '/data/out/benchy.gcode',
    gcodeSha256: HASH,
    uploadedFilename: FILENAME,
    filamentMapping: mapping,
    at: NOW - 20_000,
  });
  if (state === 'awaiting_start_approval') return job;

  job = grantStartApproval(
    job,
    createStartApproval({
      job,
      printerId: 'printer-a',
      filename: FILENAME,
      gcodeSha256: HASH,
      approvedAt: NOW - 10_000,
    }),
    NOW - 10_000
  );
  if (state === 'start_approved') return job;

  job = transition(job, 'starting', NOW - 5_000, { reason: 'test' });
  if (state === 'starting') return job;

  job = transition(job, 'printing', NOW - 4_000, { reason: 'test' });
  if (state === 'printing') return job;

  if (state === 'paused') return transition(job, 'paused', NOW - 3_000, { reason: 'test' });
  throw new Error(`unhandled state ${state}`);
}

const snap = (over = {}) => ({
  connected: true,
  klippyReady: true,
  printState: 'printing',
  filename: FILENAME,
  ...over,
});

// --- the loop that was missing -------------------------------------------

test('a job follows the print to completion', () => {
  const printing = jobIn('printing');
  const outcome = advanceJob(printing, snap({ printState: 'complete' }), NOW);

  assert.equal(outcome.changed, true);
  assert.equal(outcome.job.state, 'completed');
  assert.ok(outcome.reason.includes('finished'));
});

test('starting becomes printing once the printer says so', () => {
  const outcome = advanceJob(jobIn('starting'), snap(), NOW);

  assert.equal(outcome.job.state, 'printing');
  assert.ok(outcome.reason.includes('began printing'));
});

test('pause and resume are both followed', () => {
  const paused = advanceJob(jobIn('printing'), snap({ printState: 'paused' }), NOW);
  assert.equal(paused.job.state, 'paused');

  const resumed = advanceJob(paused.job, snap({ printState: 'printing' }), NOW);
  assert.equal(resumed.job.state, 'printing');
});

test('a cancel at the printer is recorded as a cancel', () => {
  const outcome = advanceJob(jobIn('printing'), snap({ printState: 'cancelled' }), NOW);

  assert.equal(outcome.job.state, 'cancelled');
  assert.ok(outcome.reason.includes('cancelled at the printer'));
});

test('a printer error fails the job', () => {
  const outcome = advanceJob(jobIn('printing'), snap({ printState: 'error' }), NOW);
  assert.equal(outcome.job.state, 'failed');
});

test('a job seen only once, already finished, still passes through printing', () => {
  // The audit trail must not gain a step that was never observed, but it must
  // also not skip from `starting` straight to `completed` — the machine has no
  // such edge, and silently doing nothing would strand the job for ever.
  const outcome = advanceJob(jobIn('starting'), snap({ printState: 'complete' }), NOW);

  assert.equal(outcome.job.state, 'completed');
  const states = outcome.job.events.filter((e) => e.toState).map((e) => e.toState);
  assert.ok(states.includes('printing'));
});

// --- unknown is not good news --------------------------------------------

test('a disconnected printer never advances a job', () => {
  for (const over of [{ connected: false }, { klippyReady: false }, { printState: null }]) {
    const outcome = advanceJob(jobIn('printing'), snap(over), NOW);
    assert.equal(outcome.changed, false, JSON.stringify(over));
    assert.equal(outcome.job.state, 'printing');
  }
});

test('standby on the same file is a failure, not a success', () => {
  // Moonraker reports standby after a cancel, after an error recovery and after
  // a firmware restart alike. Reading it as "completed" would write a success
  // into the record for a print that failed.
  const outcome = advanceJob(jobIn('printing'), snap({ printState: 'standby' }), NOW);

  assert.equal(outcome.job.state, 'failed');
  assert.ok(outcome.reason.includes('without reporting completion'));
});

test('an unrecognised printer state leaves the job alone', () => {
  const outcome = advanceJob(jobIn('printing'), snap({ printState: 'wibble' }), NOW);
  assert.equal(outcome.changed, false);
});

// --- the printer is running something else --------------------------------

test('a job is not advanced by another file printing', () => {
  const outcome = advanceJob(jobIn('printing'), snap({ filename: 'something-else.gcode' }), NOW);

  assert.equal(outcome.job.state, 'failed');
  assert.ok(outcome.reason.includes('something-else.gcode'));
});

test('a start the printer never picked up fails rather than hanging', () => {
  const outcome = advanceJob(
    jobIn('starting'),
    snap({ printState: 'standby', filename: null }),
    NOW
  );

  assert.equal(outcome.job.state, 'failed');
  assert.ok(outcome.reason.includes('never began'));
});

test('a printer reporting no filename cannot confirm it is running this job', () => {
  assert.equal(isSameJob(jobIn('printing'), snap({ filename: null })), false);
  assert.equal(isSameJob(jobIn('printing'), snap()), true);
});

test('the reported path is reduced to a basename in the audit trail', () => {
  const outcome = advanceJob(
    jobIn('printing'),
    snap({ filename: 'deep/folder/other.gcode' }),
    NOW
  );
  assert.ok(outcome.reason.includes('other.gcode'));
  assert.ok(!outcome.reason.includes('deep/folder'));
});

// --- what the monitor will and will not touch ------------------------------

test('a job that has not reached the printer is not watched', () => {
  for (const state of ['awaiting_start_approval', 'start_approved']) {
    const outcome = advanceJob(jobIn(state), snap(), NOW);
    assert.equal(outcome.changed, false, state);
  }
});

test('a finished job is never reopened', () => {
  const done = advanceJob(jobIn('printing'), snap({ printState: 'complete' }), NOW).job;
  const again = advanceJob(done, snap({ printState: 'printing' }), NOW);

  assert.equal(again.changed, false);
  assert.equal(again.job.state, 'completed');
});

test('a job already in the reported state is not rewritten', () => {
  const outcome = advanceJob(jobIn('printing'), snap({ printState: 'printing' }), NOW);
  assert.equal(outcome.changed, false);
});

test('liveness stops the monitor once there is nothing to observe', () => {
  assert.equal(isJobLive(jobIn('printing')), true);
  assert.equal(isJobLive(jobIn('starting')), true);
  assert.equal(isJobLive(jobIn('start_approved')), false);
  assert.equal(isJobLive(null), false);

  const done = advanceJob(jobIn('printing'), snap({ printState: 'complete' }), NOW).job;
  assert.equal(isJobLive(done), false);
});

test('a job on the printer is distinguishable from one that is not', () => {
  assert.equal(isJobOnThePrinter(jobIn('printing')), true);
  assert.equal(isJobOnThePrinter(jobIn('starting')), true);
  assert.equal(isJobOnThePrinter(jobIn('start_approved')), false);
  assert.equal(isJobOnThePrinter(null), false);
});
