// End-to-end: consecutive fixture versions through publish.js --dry-run, with
// the reference client walking the client contract against each built tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUpdate } from './reference-client.js';
import { sha256Hex, snapshotLists } from '../src/build.js';
import { KEY_ID, listDir, manifestPath } from '../src/constants.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const LIST = 'aislist';

/** Run publish.js --dry-run against one fixture source version. */
async function publishFixture(work, version, extra = []) {
  const summaryPath = path.join(work, `summary-${version}-${Date.now()}.json`);
  await run(
    process.execPath,
    [
      'src/publish.js',
      '--dry-run',
      '--out', path.join(work, 'out'),
      '--sources', path.join(FIXTURES, 'sources'),
      '--allow', path.join(FIXTURES, 'allow.txt'),
      '--source-dir', path.join(FIXTURES, 'source', version),
      '--source-commit', 'f'.repeat(40),
      '--summary', summaryPath,
      ...extra,
    ],
    { cwd: ROOT },
  );
  return JSON.parse(await readFile(summaryPath, 'utf8'));
}

/** A static file server over the tree with ETag / If-None-Match support. */
function serve(out) {
  return async (treePath, headers) => {
    let body;
    try {
      body = await readFile(path.join(out, treePath));
    } catch {
      return { status: 404, body: null, etag: null };
    }
    const etag = `"${sha256Hex(body)}"`;
    if (headers['if-none-match'] === etag) return { status: 304, body: null, etag };
    return { status: 200, body, etag };
  };
}

const readSnapshotLists = async (out, version) =>
  snapshotLists(JSON.parse(await readFile(path.join(out, listDir(LIST), 'snapshot', `${version}.json`), 'utf8')));
const readStoreLists = async (storePath) => JSON.parse(await readFile(storePath, 'utf8')).lists;

test('three fixture versions, then the reference client: snapshot, deltas, fallback', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'ailist-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'out');
  const storePath = path.join(work, 'client-store.json');
  const get = serve(out);
  const client = (summary) => runUpdate({ get, storePath, publicKeys: { [KEY_ID]: summary.public_key_pem }, listId: LIST });

  // Version 1: first client run takes the snapshot.
  const s1 = await publishFixture(work, 'v1');
  assert.equal(s1.lists[0].version, 1);
  assert.equal(s1.commit_message, 'data(aislist): v1 (+13 -0 block, +3 -0 warn), source fffffff');
  assert.deepEqual(await client(s1), { outcome: 'snapshot', version: 1 });
  assert.deepEqual(await readStoreLists(storePath), await readSnapshotLists(out, 1));
  const v1 = await readSnapshotLists(out, 1);
  assert.ok(!v1.block.handles.includes('allowedfalsepositive'), 'allow list applied');
  assert.ok(!v1.warn.handles.includes('mover'), 'block wins over warn');
  assert.ok(v1.block.handles.includes('dpcartoonài-v6k'), 'percent-decoded handle');

  // Version 2: the client follows the delta.
  const s2 = await publishFixture(work, 'v2');
  assert.equal(s2.lists[0].version, 2);
  assert.equal(s2.commit_message, 'data(aislist): v2 (+3 -1 block, +1 -2 warn), source fffffff');
  assert.deepEqual(await client(s2), { outcome: 'deltas', version: 2 });
  assert.deepEqual(await readStoreLists(storePath), await readSnapshotLists(out, 2));

  // Same source again: no new version, client sees it is current, then gets a 304.
  const s2again = await publishFixture(work, 'v2');
  assert.equal(s2again.changed, false);
  assert.equal(s2again.lists[0].version, 2);
  await assert.rejects(access(path.join(out, listDir(LIST), 'snapshot', '3.json')));
  assert.deepEqual(await client(s2again), { outcome: 'up-to-date', version: 2 });

  // Version 3 with its delta gone from the host: forced snapshot fallback.
  const s3 = await publishFixture(work, 'v3');
  assert.equal(s3.lists[0].version, 3);
  await rm(path.join(out, listDir(LIST), 'delta', '3.json'));
  assert.deepEqual(await client(s3), { outcome: 'fallback-snapshot', version: 3 });
  assert.deepEqual(await readStoreLists(storePath), await readSnapshotLists(out, 3));

  // A client with an up-to-date store and the current ETag gets a 304.
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  const manifestBytes = await readFile(path.join(out, manifestPath(LIST)));
  assert.equal(store.etag, `"${sha256Hex(manifestBytes)}"`);
  assert.deepEqual(await client(s3), { outcome: 'not-modified' });
});

test('a client two versions behind chains both deltas in order', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'ailist-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'out');
  const storePath = path.join(work, 'client-store.json');
  const get = serve(out);

  const s1 = await publishFixture(work, 'v1');
  await runUpdate({ get, storePath, publicKeys: { [KEY_ID]: s1.public_key_pem }, listId: LIST });
  await publishFixture(work, 'v2');
  const s3 = await publishFixture(work, 'v3');

  const result = await runUpdate({ get, storePath, publicKeys: { [KEY_ID]: s3.public_key_pem }, listId: LIST });
  assert.deepEqual(result, { outcome: 'deltas', version: 3 });
  assert.deepEqual(await readStoreLists(storePath), await readSnapshotLists(out, 3));
});

test('a failed signature leaves the stored list untouched', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'ailist-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'out');
  const storePath = path.join(work, 'client-store.json');
  const get = serve(out);

  const s1 = await publishFixture(work, 'v1');
  await runUpdate({ get, storePath, publicKeys: { [KEY_ID]: s1.public_key_pem }, listId: LIST });
  const before = await readFile(storePath, 'utf8');
  await publishFixture(work, 'v2');
  // The client still trusts only the first run's key, so the v2 manifest must be refused.
  const result = await runUpdate({ get, storePath, publicKeys: { [KEY_ID]: s1.public_key_pem }, listId: LIST });
  assert.equal(result.outcome, 'failed');
  assert.equal(await readFile(storePath, 'utf8'), before);
});

test('a guard abort exits non-zero, writes a report and leaves the tree unchanged', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'ailist-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'out');
  const reportPath = path.join(work, 'report.md');

  await publishFixture(work, 'v3');
  const manifestBefore = await readFile(path.join(out, manifestPath(LIST)));
  await assert.rejects(publishFixture(work, 'v4-shrunk', ['--report', reportPath]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /A guard aborted the run/);
    return true;
  });
  const report = await readFile(reportPath, 'utf8');
  assert.match(report, /`shrink`: block shrank from 16 to 8/);
  assert.match(report, /force: true/);
  assert.deepEqual(await readFile(path.join(out, manifestPath(LIST))), manifestBefore);

  // force skips the shrink guard and publishes.
  const forced = await publishFixture(work, 'v4-shrunk', ['--force']);
  assert.equal(forced.lists[0].version, 2);
});

test('channel ids fill in over runs within the lookup budget, and the cache survives a guard abort', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'ailist-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'out');
  const cacheDir = path.join(work, 'cache');
  const publish = (version, extra = []) =>
    publishFixture(work, version, [
      '--sources', path.join(FIXTURES, 'sources-resolve'),
      '--cache', cacheDir,
      '--resolve-fixture', path.join(FIXTURES, 'resolve-answers.json'),
      ...extra,
    ]);
  const cacheLines = async () =>
    (await readFile(path.join(cacheDir, `${LIST}.tsv`), 'utf8')).split('\n').filter((l) => l && !l.startsWith('#'));

  // Budget 5 per run: the first run resolves the first five handles in sorted order.
  await publish('v1');
  const v1 = await readSnapshotLists(out, 1);
  assert.equal((await cacheLines()).length, 5);
  assert.ok(v1.block.ids.includes('UCabcdefghijklmnopqrstuv'), 'source ids are kept');
  assert.ok(v1.block.ids.length > 1, 'resolved ids are published');

  // v2 adds handles: new ones are looked up before the backlog.
  const s2 = await publish('v2');
  assert.equal(s2.lists[0].version, 2);
  const v2 = await readSnapshotLists(out, 2);
  for (const id of ['UCnewoneAAAAAAAAAAAAAAAA', 'UCnewtwoAAAAAAAAAAAAAAAA']) assert.ok(v2.block.ids.includes(id), `${id} resolved first`);

  // Repeated runs drain the backlog; the allow-listed handle is never looked up or published.
  for (let i = 0; i < 4; i += 1) await publish('v2');
  const lines = await cacheLines();
  assert.ok(!lines.some((l) => l.startsWith('allowedfalsepositive\t')));
  assert.ok(lines.some((l) => l.startsWith('소소한작업실-z8d\t-\t')), 'a miss is cached as -');
  const manifest = JSON.parse(await readFile(path.join(out, manifestPath(LIST)), 'utf8'));
  const counts = JSON.parse(Buffer.from(manifest.payload, 'base64').toString('utf8')).counts;
  assert.equal(counts.block_ids, 14, '13 resolved plus the source id');
  assert.equal(counts.warn_ids, 2);
  const latest = await readSnapshotLists(out, JSON.parse(Buffer.from(manifest.payload, 'base64').toString('utf8')).version);
  assert.ok(latest.block.ids.includes('UCwarntwoAAAAAAAAAAAAAAA'), 'warn-two moved to block in v2, and its id with it');
  assert.ok(!latest.warn.ids.includes('UCwarntwoAAAAAAAAAAAAAAA'), 'block wins over warn for ids too');
  assert.ok(!latest.block.ids.includes('UCallowedfalseAAAAAAAAAA'));

  // A guard abort keeps every cached lookup, even for handles the bad source dropped.
  const before = await cacheLines();
  await assert.rejects(publish('v4-shrunk'));
  assert.deepEqual(await cacheLines(), before);
});

test('a compiled list merges its inputs, resolves names, lists every source and serves the client', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'ailist-e2e-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const out = path.join(work, 'out');
  const summaryPath = path.join(work, 'summary.json');
  await run(
    process.execPath,
    [
      'src/publish.js', '--dry-run',
      '--out', out,
      '--sources', path.join(FIXTURES, 'sources-aimusic'),
      '--allow', path.join(FIXTURES, 'allow-aimusic.txt'),
      '--source-dir', path.join(FIXTURES, 'source-aimusic'),
      '--source-commit', 'e'.repeat(40),
      '--cache', path.join(work, 'cache'),
      '--resolve-fixture', path.join(FIXTURES, 'resolve-answers-aimusic.json'),
      '--summary', summaryPath,
    ],
    { cwd: ROOT },
  );
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert.equal(summary.commit_message, 'data(aimusic): v1 (+5 -0 block, +0 -0 warn), sources eeeeeee eeeeeee');

  const lists = snapshotLists(JSON.parse(await readFile(path.join(out, listDir('aimusic'), 'snapshot', '1.json'), 'utf8')));
  assert.deepEqual(lists.block.ids, [
    'UCalphaMusicArtistAAAAAA',
    'UCalphaOwnChannelAAAAAAA',
    'UCbetaMusicArtistAAAAAAA',
    'UCdeltaMusicArtistAAAAAA',
    'UClonelySynthAAAAAAAAAAA',
  ]);
  assert.deepEqual(lists.warn, { handles: [], ids: [] });

  const envelope = JSON.parse(await readFile(path.join(out, manifestPath('aimusic')), 'utf8'));
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  assert.equal(payload.source, undefined);
  assert.deepEqual(payload.sources.map((s) => [s.name, s.license]), [['Soul Over AI', 'CC BY 4.0'], ['Spotify AI Blocker', 'MIT']]);
  assert.match(payload.sources[0].attribution, /Soul Over AI \(https:\/\/souloverai\.com\)/);

  const storePath = path.join(work, 'client-store.json');
  const result = await runUpdate({ get: serve(out), storePath, publicKeys: { [KEY_ID]: summary.public_key_pem }, listId: 'aimusic' });
  assert.deepEqual(result, { outcome: 'snapshot', version: 1 });
});
