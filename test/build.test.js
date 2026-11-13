import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleLists,
  diffLists,
  applyDelta,
  listsEqual,
  emptyLists,
  snapshotLists,
  countEntries,
  summarizeDiff,
  planRelease,
  makeIndex,
  sha256Hex,
  formatTimestamp,
} from '../src/build.js';
import { SNAPSHOTS_KEPT, DELTAS_KEPT, MAX_DELTA_CHAIN, VERSIONED_FILE_PATTERN } from '../src/constants.js';

const CONFIG = {
  id: 'testlist',
  name: 'Test List',
  description: 'Fixture list',
  homepage: 'https://example.org',
  repo: 'example/testlist',
  license: 'CC BY-NC 4.0',
};
const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-11-13T03:17:00.123Z');
const ID_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';

const entries = (block, warn, blockIds = [], warnIds = []) => ({
  block: { handles: new Set(block), ids: new Set(blockIds) },
  warn: { handles: new Set(warn), ids: new Set(warnIds) },
});
const noAllow = { handles: [], ids: [] };

test('overlap is removed from warn, for handles and ids', () => {
  const lists = assembleLists(entries(['a', 'b'], ['b', 'c'], [ID_A], [ID_A, ID_B]), noAllow);
  assert.deepEqual(lists.block, { handles: ['a', 'b'], ids: [ID_A] });
  assert.deepEqual(lists.warn, { handles: ['c'], ids: [ID_B] });
});

test('allow-list entries are removed from both lists', () => {
  const lists = assembleLists(entries(['a', 'b'], ['c', 'd'], [ID_A], [ID_B]), { handles: ['b', 'c'], ids: [ID_A, ID_B] });
  assert.deepEqual(lists, { block: { handles: ['a'], ids: [] }, warn: { handles: ['d'], ids: [] } });
});

test('sets come out sorted and deduplicated', () => {
  const lists = assembleLists(
    { block: { handles: ['zed', 'alpha', 'mid', 'alpha'], ids: [ID_B, ID_A, ID_B] }, warn: { handles: [], ids: [] } },
    noAllow,
  );
  assert.deepEqual(lists.block.handles, ['alpha', 'mid', 'zed']);
  assert.deepEqual(lists.block.ids, [ID_A, ID_B]);
});

test('delta of two snapshots is correct, including a warn to block move', () => {
  const before = assembleLists(entries(['a', 'b'], ['m', 'w']), noAllow);
  const after = assembleLists(entries(['a', 'c', 'm'], ['w', 'x'], [ID_A]), noAllow);
  const changes = diffLists(before, after);
  assert.deepEqual(changes, {
    block: { handles: { add: ['c', 'm'], remove: ['b'] }, ids: { add: [ID_A], remove: [] } },
    warn: { handles: { add: ['x'], remove: ['m'] }, ids: { add: [], remove: [] } },
  });
  assert.deepEqual(summarizeDiff(changes), { block: { add: 3, remove: 1 }, warn: { add: 1, remove: 1 } });
});

test('previous snapshot plus delta equals the new snapshot, and applying twice is harmless', () => {
  const before = assembleLists(entries(['a', 'b', 'q'], ['m']), noAllow);
  const after = assembleLists(entries(['b', 'c', 'm'], ['n'], [ID_B]), noAllow);
  const changes = diffLists(before, after);
  const once = applyDelta(before, changes);
  assert.deepEqual(once, after);
  assert.deepEqual(applyDelta(once, changes), after);
  assert.ok(listsEqual(once, after));
});

test('counts cover all four sets', () => {
  const lists = assembleLists(entries(['a', 'b'], ['c'], [ID_A]), noAllow);
  assert.deepEqual(countEntries(lists), { block_handles: 2, block_ids: 1, warn_handles: 1, warn_ids: 0 });
});

test('first release is version 1 with a snapshot and no delta', () => {
  const lists = assembleLists(entries(['a'], ['b']), noAllow);
  const plan = planRelease({ config: CONFIG, previous: null, existing: { snapshots: [], deltas: [] }, lists, commit: COMMIT, generatedAt: NOW });
  assert.equal(plan.changed, true);
  assert.equal(plan.version, 1);
  assert.deepEqual([...plan.writes.keys()], ['snapshot/1.json']);
  assert.deepEqual(plan.deletes, []);
  const snapshotBytes = plan.writes.get('snapshot/1.json');
  assert.equal(snapshotBytes.toString(), '{"schema":1,"list":"testlist","version":1,"block":{"handles":["a"],"ids":[]},"warn":{"handles":["b"],"ids":[]}}');
  assert.deepEqual(plan.payload, {
    schema: 1,
    list: 'testlist',
    version: 1,
    generated_at: '2026-11-13T03:17:00Z',
    snapshot: { path: 'snapshot/1.json', sha256: sha256Hex(snapshotBytes), bytes: snapshotBytes.length },
    deltas: [],
    max_delta_chain: MAX_DELTA_CHAIN,
    counts: { block_handles: 1, block_ids: 0, warn_handles: 1, warn_ids: 0 },
    source: { name: 'Test List', homepage: 'https://example.org', repo: 'https://github.com/example/testlist', commit: COMMIT, license: 'CC BY-NC 4.0' },
  });
});

test('non-ASCII handles are written raw, not escaped', () => {
  const lists = assembleLists(entries(['소소한작업실-z8d', 'músicabíblicainstrumental'], []), noAllow);
  const plan = planRelease({ config: CONFIG, previous: null, existing: { snapshots: [], deltas: [] }, lists, commit: COMMIT, generatedAt: NOW });
  const text = plan.writes.get('snapshot/1.json').toString('utf8');
  assert.ok(text.includes('소소한작업실-z8d'));
  assert.ok(!text.includes('\\u'));
});

test('no version bump when nothing changed', () => {
  const lists = assembleLists(entries(['a'], ['b']), noAllow);
  const first = planRelease({ config: CONFIG, previous: null, existing: { snapshots: [], deltas: [] }, lists, commit: COMMIT, generatedAt: NOW });
  const again = planRelease({
    config: CONFIG,
    previous: { payload: first.payload, lists },
    existing: { snapshots: [1], deltas: [] },
    lists: assembleLists(entries(['a', 'a'], ['b']), noAllow),
    commit: 'b'.repeat(40),
    generatedAt: NOW,
  });
  assert.equal(again.changed, false);
  assert.equal(again.version, 1);
  assert.equal(again.writes, undefined);
});

/** Run `count` consecutive releases against an in-memory tree; return the tree and last payload. */
function simulateReleases(count) {
  const tree = new Map();
  let previous = null;
  for (let i = 1; i <= count; i += 1) {
    const lists = assembleLists(entries([`base`, `h${i}`], [`w${i % 2}`]), noAllow);
    const versionsIn = (dir) =>
      [...tree.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => Number(VERSIONED_FILE_PATTERN.exec(p.slice(dir.length + 1))[1]));
    const plan = planRelease({
      config: CONFIG,
      previous,
      existing: { snapshots: versionsIn('snapshot'), deltas: versionsIn('delta') },
      lists,
      commit: COMMIT,
      generatedAt: NOW,
    });
    assert.equal(plan.version, i);
    for (const path of plan.deletes) tree.delete(path);
    for (const [path, bytes] of plan.writes) tree.set(path, bytes);
    previous = { payload: plan.payload, lists };
  }
  return { tree, payload: previous.payload };
}

test('pruning keeps exactly 3 snapshots and 30 deltas, and the manifest lists only hosted deltas', () => {
  const { tree, payload } = simulateReleases(35);
  const snapshots = [...tree.keys()].filter((p) => p.startsWith('snapshot/')).sort();
  const deltas = [...tree.keys()].filter((p) => p.startsWith('delta/'));
  assert.equal(snapshots.length, SNAPSHOTS_KEPT);
  assert.deepEqual(snapshots, ['snapshot/33.json', 'snapshot/34.json', 'snapshot/35.json']);
  assert.equal(deltas.length, DELTAS_KEPT);
  assert.equal(payload.deltas.length, DELTAS_KEPT);
  assert.deepEqual(payload.deltas.map((d) => d.to), Array.from({ length: 30 }, (_, i) => 35 - i));
  for (const delta of payload.deltas) {
    assert.ok(tree.has(delta.path), `${delta.path} is listed and hosted`);
    assert.equal(delta.sha256, sha256Hex(tree.get(delta.path)));
    assert.equal(delta.bytes, tree.get(delta.path).length);
  }
});

test('every hosted delta chains from its predecessor to the newest snapshot', () => {
  const { tree, payload } = simulateReleases(8);
  let lists = snapshotLists(JSON.parse(tree.get('snapshot/6.json')));
  for (const to of [7, 8]) lists = applyDelta(lists, JSON.parse(tree.get(`delta/${to}.json`)));
  assert.deepEqual(lists, snapshotLists(JSON.parse(tree.get(payload.snapshot.path))));
});

test('stray delta files not in the manifest are deleted', () => {
  const lists = assembleLists(entries(['a'], []), noAllow);
  const first = planRelease({ config: CONFIG, previous: null, existing: { snapshots: [1], deltas: [9] }, lists, commit: COMMIT, generatedAt: NOW });
  assert.deepEqual(first.deletes, ['delta/9.json']);
});

test('index lists every configured source', () => {
  assert.deepEqual(makeIndex([CONFIG]), {
    schema: 1,
    lists: [{ id: 'testlist', name: 'Test List', description: 'Fixture list', manifest: 'testlist/manifest.json', homepage: 'https://example.org', license: 'CC BY-NC 4.0' }],
  });
});

test('helpers', () => {
  assert.deepEqual(emptyLists(), { block: { handles: [], ids: [] }, warn: { handles: [], ids: [] } });
  assert.equal(formatTimestamp(new Date('2026-01-02T03:04:05.999Z')), '2026-01-02T03:04:05Z');
});
