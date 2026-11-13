import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGuards, measureSource, validateLimits } from '../src/guards.js';

const LIMITS = {
  min_block_entries: 40000,
  max_shrink_ratio: 0.02,
  max_growth_ratio: 0.25,
  max_reject_ratio: 0.01,
  max_header_mismatch_ratio: 0.01,
};

const clean = { entryLines: 50000, rejected: 0, headers: [] };

/** Run the guards with healthy defaults and the given overrides; return the guard names that failed. */
function failing(overrides = {}) {
  const { failures } = checkGuards({
    limits: LIMITS,
    stats: clean,
    blockEntries: 50000,
    previousBlockEntries: 50000,
    ...overrides,
  });
  return failures.map((f) => f.guard);
}

test('healthy input passes every guard', () => {
  assert.deepEqual(failing(), []);
});

test('minimum block size: trips below the threshold, passes at and above it', () => {
  const run = (n) => failing({ blockEntries: n, previousBlockEntries: n });
  assert.deepEqual(run(39999), ['min_block']);
  assert.deepEqual(run(40000), []);
  assert.deepEqual(run(40001), []);
});

test('reject ratio: trips just over 1%, passes at and under it', () => {
  const run = (rejected) => failing({ stats: { entryLines: 10000, rejected, headers: [] } });
  assert.deepEqual(run(101), ['reject']);
  assert.deepEqual(run(100), []);
  assert.deepEqual(run(99), []);
});

test('header mismatch: trips just over 1%, passes at and under it, in either direction', () => {
  const run = (parsed) => failing({ stats: { ...clean, headers: [{ kind: 'block', declared: 10000, parsed }] } });
  assert.deepEqual(run(9899), ['header']);
  assert.deepEqual(run(9900), []);
  assert.deepEqual(run(9950), []);
  assert.deepEqual(run(10100), []);
  assert.deepEqual(run(10101), ['header']);
});

test('shrink: trips just over 2%, passes at and under it', () => {
  const run = (n) => failing({ blockEntries: n, previousBlockEntries: 50000 });
  assert.deepEqual(run(48999), ['shrink']);
  assert.deepEqual(run(49000), []);
  assert.deepEqual(run(49001), []);
});

test('growth: trips just over 25%, passes at and under it', () => {
  const run = (n) => failing({ blockEntries: n, previousBlockEntries: 50000 });
  assert.deepEqual(run(62501), ['growth']);
  assert.deepEqual(run(62500), []);
  assert.deepEqual(run(62499), []);
});

test('first run skips shrink and growth but keeps the other guards', () => {
  const result = checkGuards({ limits: LIMITS, stats: clean, blockEntries: 50000, previousBlockEntries: null });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.skipped, ['shrink (first run)', 'growth (first run)']);
  assert.deepEqual(failing({ previousBlockEntries: null, blockEntries: 100 }), ['min_block']);
  assert.deepEqual(failing({ previousBlockEntries: null, stats: { entryLines: 100, rejected: 50, headers: [] } }), ['reject']);
});

test('force skips only shrink and growth', () => {
  assert.deepEqual(failing({ force: true, blockEntries: 45000 }), []);
  assert.deepEqual(failing({ force: true, blockEntries: 70000 }), []);
  assert.deepEqual(failing({ force: true, blockEntries: 30000 }), ['min_block']);
  assert.deepEqual(failing({ force: true, stats: { entryLines: 1000, rejected: 50, headers: [] } }), ['reject']);
  assert.deepEqual(failing({ force: true, stats: { ...clean, headers: [{ kind: 'warn', declared: 1000, parsed: 900 }] } }), ['header']);
});

test('several failures are all reported', () => {
  const result = checkGuards({
    limits: LIMITS,
    stats: { entryLines: 30000, rejected: 1000, headers: [{ kind: 'block', declared: 60000, parsed: 30000 }] },
    blockEntries: 29000,
    previousBlockEntries: 60000,
  });
  assert.deepEqual(result.failures.map((f) => f.guard), ['min_block', 'reject', 'header', 'shrink']);
  assert.match(result.failures[3].message, /shrank from 60000 to 29000/);
});

test('measureSource adds parse and normalize rejects across both lists', () => {
  const parsed = {
    block: { entryLines: 10, rejected: ['junk'], declaredTotal: 10 },
    warn: { entryLines: 3, rejected: [], declaredTotal: null },
  };
  const normalized = { block: { rejected: ['@Bad%ZZ'] }, warn: { rejected: ['@x%'] } };
  assert.deepEqual(measureSource(parsed, normalized), {
    entryLines: 13,
    rejected: 3,
    headers: [{ kind: 'block', declared: 10, parsed: 10 }],
  });
});

test('missing thresholds are a config error', () => {
  assert.throws(() => validateLimits({ ...LIMITS, max_growth_ratio: undefined }), /guards\.max_growth_ratio/);
  assert.throws(() => validateLimits(undefined), /guards\.min_block_entries/);
});
