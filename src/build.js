// Builds the published files: lists, snapshot, delta, pruning plan, manifest
// payload and index. Pure functions: data in, data out.
//
// A "lists" value has the same shape as a snapshot's list part:
//   { block: { handles: [...], ids: [...] }, warn: { handles: [...], ids: [...] } }
// with every array deduplicated and sorted. All set logic below is written
// once over KINDS x SET_NAMES, so it covers handles and ids, block and warn.

import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  KINDS,
  SET_NAMES,
  SNAPSHOTS_KEPT,
  DELTAS_KEPT,
  MAX_DELTA_CHAIN,
  GITHUB_WEB,
  snapshotRelPath,
  deltaRelPath,
  indexManifestPath,
} from './constants.js';

/** Lowercase hex SHA-256 of raw bytes. */
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Minified UTF-8 JSON bytes, non-ASCII written raw, no BOM. */
export const encodeJson = (value) => Buffer.from(JSON.stringify(value), 'utf8');

/** `{ sha256, bytes }` for a file's raw bytes. */
export const fileInfo = (bytes) => ({ sha256: sha256Hex(bytes), bytes: bytes.length });

/** Deduplicate and sort. */
const sortedUnique = (values) => [...new Set(values)].sort();

/** Build a value per kind and set: { block: { handles: f(...), ids: f(...) }, warn: {...} }. */
function mapSets(fn) {
  return Object.fromEntries(
    KINDS.map((kind) => [kind, Object.fromEntries(SET_NAMES.map((set) => [set, fn(kind, set)]))]),
  );
}

/** Lists with every set empty. */
export const emptyLists = () => mapSets(() => []);

/** The lists part of a parsed snapshot. */
export const snapshotLists = (snapshot) => mapSets((kind, set) => snapshot[kind][set]);

/**
 * Turn normalized entries into published lists: drop allow-listed entries from
 * both lists, then drop from `warn` anything that is also in `block`.
 *
 * entries: { block: { handles: Iterable, ids: Iterable }, warn: {...} }
 * allow:   { handles: Iterable, ids: Iterable }
 */
export function assembleLists(entries, allow) {
  const allowed = Object.fromEntries(SET_NAMES.map((set) => [set, new Set(allow[set])]));
  const filtered = mapSets((kind, set) =>
    sortedUnique([...entries[kind][set]].filter((value) => !allowed[set].has(value))),
  );
  return mapSets((kind, set) => {
    if (kind === 'block') return filtered.block[set];
    const blocked = new Set(filtered.block[set]);
    return filtered[kind][set].filter((value) => !blocked.has(value));
  });
}

/** Changes from `prev` to `next`: { block: { handles: { add, remove }, ids: {...} }, warn: {...} }. */
export function diffLists(prev, next) {
  return mapSets((kind, set) => {
    const before = new Set(prev[kind][set]);
    const after = new Set(next[kind][set]);
    return {
      add: next[kind][set].filter((value) => !before.has(value)),
      remove: prev[kind][set].filter((value) => !after.has(value)),
    };
  });
}

/** Apply a delta's changes: removes first, then adds, as plain set operations. */
export function applyDelta(lists, changes) {
  return mapSets((kind, set) => {
    const values = new Set(lists[kind][set]);
    for (const value of changes[kind][set].remove) values.delete(value);
    for (const value of changes[kind][set].add) values.add(value);
    return [...values].sort();
  });
}

/** True when a diff has no adds and no removes anywhere. */
export const isEmptyDiff = (changes) =>
  KINDS.every((kind) => SET_NAMES.every((set) => changes[kind][set].add.length === 0 && changes[kind][set].remove.length === 0));

/** True when two lists hold the same entries. */
export const listsEqual = (a, b) => isEmptyDiff(diffLists(a, b));

/** Manifest counts: { block_handles, block_ids, warn_handles, warn_ids }. */
export function countEntries(lists) {
  const counts = {};
  for (const kind of KINDS) for (const set of SET_NAMES) counts[`${kind}_${set}`] = lists[kind][set].length;
  return counts;
}

/** Entries in one list kind, handles and ids together. */
export const kindSize = (lists, kind) => SET_NAMES.reduce((sum, set) => sum + lists[kind][set].length, 0);

/** Totals per kind for a diff: { block: { add, remove }, warn: { add, remove } }. */
export function summarizeDiff(changes) {
  return Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      SET_NAMES.reduce(
        (sum, set) => ({ add: sum.add + changes[kind][set].add.length, remove: sum.remove + changes[kind][set].remove.length }),
        { add: 0, remove: 0 },
      ),
    ]),
  );
}

export const makeSnapshot = (listId, version, lists) => ({
  schema: SCHEMA_VERSION,
  list: listId,
  version,
  ...mapSets((kind, set) => lists[kind][set]),
});

export const makeDelta = (listId, from, to, changes) => ({
  schema: SCHEMA_VERSION,
  list: listId,
  from,
  to,
  ...changes,
});

/** Newest `keep` versions of a list of version numbers. */
const newest = (versions, keep) => [...new Set(versions)].sort((a, b) => b - a).slice(0, keep);

/** `generated_at` timestamp: ISO 8601 UTC to the second. */
export const formatTimestamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Plan the next release of one list.
 *
 * previous: null on the first run, else { payload, lists } from the current tree.
 * existing: { snapshots: number[], deltas: number[] } versions found on disk.
 * lists:    the freshly assembled lists.
 *
 * Returns { changed: false, version, changes } when the lists are unchanged.
 * Otherwise returns { changed: true, version, changes, writes, deletes, payload },
 * where writes maps list-relative paths to file bytes, deletes lists
 * list-relative paths to remove, and payload is the manifest payload object.
 * `changes` is the diff against the previous lists (or against empty lists on
 * the first run) and is meant for reporting.
 */
export function planRelease({ config, previous, existing, lists, commit, generatedAt }) {
  const listId = config.id;
  const changes = diffLists(previous ? previous.lists : emptyLists(), lists);
  if (previous && isEmptyDiff(changes)) {
    return { changed: false, version: previous.payload.version, changes };
  }

  const version = previous ? previous.payload.version + 1 : 1;
  const writes = new Map();

  const snapshotBytes = encodeJson(makeSnapshot(listId, version, lists));
  writes.set(snapshotRelPath(version), snapshotBytes);

  let deltas = previous ? previous.payload.deltas : [];
  if (previous) {
    const deltaBytes = encodeJson(makeDelta(listId, version - 1, version, changes));
    writes.set(deltaRelPath(version), deltaBytes);
    deltas = [{ to: version, path: deltaRelPath(version), ...fileInfo(deltaBytes) }, ...deltas];
  }

  const keptDeltas = new Set(newest(deltas.map((d) => d.to), DELTAS_KEPT));
  deltas = deltas.filter((d) => keptDeltas.has(d.to)).sort((a, b) => b.to - a.to);
  const keptSnapshots = new Set(newest([...existing.snapshots, version], SNAPSHOTS_KEPT));
  const deletes = [
    ...existing.snapshots.filter((v) => !keptSnapshots.has(v)).map(snapshotRelPath),
    ...existing.deltas.filter((v) => !keptDeltas.has(v)).map(deltaRelPath),
  ];

  const payload = {
    schema: SCHEMA_VERSION,
    list: listId,
    version,
    generated_at: formatTimestamp(generatedAt),
    snapshot: { path: snapshotRelPath(version), ...fileInfo(snapshotBytes) },
    deltas,
    max_delta_chain: MAX_DELTA_CHAIN,
    counts: countEntries(lists),
    source: {
      name: config.name,
      homepage: config.homepage,
      repo: `${GITHUB_WEB}/${config.repo}`,
      commit,
      license: config.license,
    },
  };

  return { changed: true, version, changes, writes, deletes, payload };
}

/** The unsigned catalogue of every configured list. */
export const makeIndex = (configs) => ({
  schema: SCHEMA_VERSION,
  lists: configs.map((config) => ({
    id: config.id,
    name: config.name,
    description: config.description,
    manifest: indexManifestPath(config.id),
    homepage: config.homepage,
    license: config.license,
  })),
});
