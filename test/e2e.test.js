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
