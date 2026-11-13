import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleLists, planRelease, makeIndex, encodeJson } from '../src/build.js';
import { signEnvelope, generateThrowawayKey } from '../src/sign.js';
import { verifyTree, checkLiveHeaders } from '../src/verify-tree.js';
import { KEY_ID, INDEX_PATH, listDir, manifestPath } from '../src/constants.js';

const CONFIG = {
  id: 'aislist',
  name: 'AiSList',
  description: 'Fixture list',
  homepage: 'https://aisloplist.com',
  repo: 'Override92/AiSList',
  license: 'CC BY-NC 4.0',
};
const { privateKey, publicKeyPem } = generateThrowawayKey();
const KEYS = { [KEY_ID]: publicKeyPem };
const BASE = listDir(CONFIG.id);

const VERSIONS = [
  { block: ['alpha', 'bravo', 'charlie'], warn: ['delta'] },
  { block: ['alpha', 'charlie', 'delta', 'echo'], warn: ['foxtrot'] },
  { block: ['alpha', 'charlie', 'delta', 'echo', 'golf'], warn: ['foxtrot', 'hotel'] },
];

/** Build a signed tree (Map of tree path -> bytes) through the given versions. */
function buildTree(versions = VERSIONS) {
  const tree = new Map([[INDEX_PATH, encodeJson(makeIndex([CONFIG]))]]);
  let previous = null;
  for (const v of versions) {
    const lists = assembleLists(
      { block: { handles: v.block, ids: [] }, warn: { handles: v.warn, ids: [] } },
      { handles: [], ids: [] },
    );
    const plan = planRelease({
      config: CONFIG,
      previous,
      existing: { snapshots: [], deltas: [] },
      lists,
      commit: 'c'.repeat(40),
      generatedAt: new Date('2026-11-13T03:17:00Z'),
    });
    for (const [path, bytes] of plan.writes) tree.set(`${BASE}/${path}`, bytes);
    const envelope = signEnvelope(encodeJson(plan.payload), privateKey, KEY_ID);
    tree.set(manifestPath(CONFIG.id), encodeJson(envelope));
    previous = { payload: plan.payload, lists };
  }
  return tree;
}

const reader = (tree) => async (path) => tree.get(path) ?? null;
const verify = (tree, extra = {}) => verifyTree({ read: reader(tree), listId: CONFIG.id, publicKeys: KEYS, ...extra });

test('passes on a good tree', async () => {
  const result = await verify(buildTree());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.payload.version, 3);
});

test('passes on a version 1 tree with no deltas', async () => {
  const result = await verify(buildTree(VERSIONS.slice(0, 1)));
  assert.deepEqual(result.errors, []);
});

test('checks the expected version', async () => {
  assert.equal((await verify(buildTree(), { expectVersion: 3 })).ok, true);
  const result = await verify(buildTree(), { expectVersion: 4 });
  assert.match(result.errors.join('\n'), /version is 3, expected 4/);
});

test('fails on a wrong hash', async () => {
  const tree = buildTree();
  const path = `${BASE}/snapshot/3.json`;
  const bytes = Buffer.from(tree.get(path));
  bytes[bytes.length - 3] = 'x'.charCodeAt(0);
  tree.set(path, bytes);
  const result = await verify(tree);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /snapshot\/3\.json: sha256 does not match/);
});

test('fails on a missing file', async () => {
  const tree = buildTree();
  tree.delete(`${BASE}/snapshot/3.json`);
  const result = await verify(tree);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /snapshot\/3\.json is listed in the manifest but missing/);
});

test('fails on a manifest listing a pruned delta', async () => {
  const tree = buildTree();
  tree.delete(`${BASE}/delta/2.json`);
  const result = await verify(tree);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /delta\/2\.json is listed in the manifest but missing/);
});

test('fails when the previous snapshot plus the delta does not give the new snapshot', async () => {
  const tree = buildTree();
  // Replace snapshot 2 with different but well-formed content.
  const other = buildTree([{ block: ['zulu'], warn: [] }, { block: ['zulu', 'yankee'], warn: [] }]);
  tree.set(`${BASE}/snapshot/2.json`, other.get(`${BASE}/snapshot/2.json`));
  const result = await verify(tree);
  assert.match(result.errors.join('\n'), /previous snapshot plus delta 3 does not equal snapshot 3/);
});

test('fails on a bad signature or an unknown key', async () => {
  const tree = buildTree();
  const envelope = JSON.parse(tree.get(manifestPath(CONFIG.id)));
  const forged = { ...envelope, payload: Buffer.from('{"schema":1}').toString('base64') };
  tree.set(manifestPath(CONFIG.id), encodeJson(forged));
  assert.match((await verify(tree)).errors.join('\n'), /signature does not verify/);
  assert.match((await verify(buildTree(), { publicKeys: { other: publicKeyPem } })).errors.join('\n'), /unknown key_id/);
});

test('fails on files that do not parse or do not match the shape', async () => {
  const tree = buildTree();
  tree.set(INDEX_PATH, Buffer.from('{not json'));
  assert.match((await verify(tree)).errors.join('\n'), /index\.json does not parse as JSON/);

  const unsorted = buildTree();
  unsorted.set(INDEX_PATH, encodeJson({ schema: 1, lists: [] }));
  assert.match((await verify(unsorted)).errors.join('\n'), /index\.json does not list "aislist"/);
});

test('a snapshot entry that is not a normalized handle is caught', async () => {
  const tree = buildTree(VERSIONS.slice(0, 1));
  // Rebuild version 1 with a raw handle smuggled in, signed so only the shape check can catch it.
  const lists = { block: { handles: ['@Alpha'], ids: [] }, warn: { handles: [], ids: [] } };
  const plan = planRelease({ config: CONFIG, previous: null, existing: { snapshots: [], deltas: [] }, lists, commit: 'c'.repeat(40), generatedAt: new Date() });
  tree.set(`${BASE}/snapshot/1.json`, plan.writes.get('snapshot/1.json'));
  tree.set(manifestPath(CONFIG.id), encodeJson(signEnvelope(encodeJson(plan.payload), privateKey, KEY_ID)));
  assert.match((await verify(tree)).errors.join('\n'), /block\.handles has 1 invalid entries/);
});

test('live headers: good responses pass', () => {
  const json = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };
  const responses = [
    { path: 'v1/index.json', status: 200, headers: { ...json, 'cache-control': 'public, max-age=3600' } },
    { path: 'v1/aislist/manifest.json', status: 200, headers: { ...json, 'cache-control': 'public, max-age=3600', etag: '"abc"' } },
    { path: 'v1/aislist/snapshot/3.json', status: 200, headers: { ...json, 'cache-control': 'public, max-age=31536000, immutable' } },
    { path: 'v1/aislist/delta/3.json', status: 200, headers: { ...json, 'cache-control': 'public, max-age=31536000, immutable' } },
    { path: 'v1/aislist/delta/0.json', status: 404, headers: {} },
  ];
  assert.deepEqual(checkLiveHeaders(responses, { missingPath: 'v1/aislist/delta/0.json' }), []);

  const broken = structuredClone(responses);
  broken[1].headers.etag = undefined;
  broken[2].headers['cache-control'] = 'public, max-age=0, must-revalidate';
  broken[3].headers['content-type'] = 'text/plain';
  broken[4].status = 200;
  const errors = checkLiveHeaders(broken, { missingPath: 'v1/aislist/delta/0.json' });
  assert.equal(errors.length, 4);
  assert.match(errors.join('\n'), /delta\/0\.json: status 200, expected 404/);
  assert.match(errors.join('\n'), /manifest\.json: no ETag/);
  assert.match(errors.join('\n'), /snapshot\/3\.json: cache-control/);
  assert.match(errors.join('\n'), /delta\/3\.json: content-type/);
});
