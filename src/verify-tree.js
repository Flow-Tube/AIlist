// Self-check of a published tree. The tree is read through an injected
// `read(treePath) -> Promise<Buffer | null>` (null = missing), so the same
// checks run against the local tree before deploy and against the live site
// in the smoke test.

import { openEnvelope } from './sign.js';
import { normalizeHandle } from './normalize.js';
import { sha256Hex, snapshotLists, applyDelta, listsEqual, countEntries } from './build.js';
import {
  SCHEMA_VERSION,
  KINDS,
  SET_NAMES,
  DELTAS_KEPT,
  CHANNEL_ID_PATTERN,
  COMMIT_SHA_PATTERN,
  INDEX_PATH,
  listDir,
  manifestPath,
  indexManifestPath,
  snapshotRelPath,
  deltaRelPath,
} from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Errors for a sorted, duplicate-free array of valid entries of one set. */
function checkEntryArray(values, set, where) {
  if (!Array.isArray(values)) return [`${where} is not an array`];
  const valid = set === 'handles' ? (v) => typeof v === 'string' && normalizeHandle(v) === v : (v) => typeof v === 'string' && CHANNEL_ID_PATTERN.test(v);
  const errors = [];
  const bad = values.filter((v) => !valid(v));
  if (bad.length > 0) errors.push(`${where} has ${bad.length} invalid entries, e.g. ${JSON.stringify(bad[0])}`);
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i - 1] < values[i])) {
      errors.push(`${where} is not sorted and duplicate-free at index ${i}`);
      break;
    }
  }
  return errors;
}

function checkHeaderFields(doc, listId, where) {
  const errors = [];
  if (doc.schema !== SCHEMA_VERSION) errors.push(`${where}: schema is ${doc.schema}, expected ${SCHEMA_VERSION}`);
  if (doc.list !== listId) errors.push(`${where}: list is ${JSON.stringify(doc.list)}, expected "${listId}"`);
  return errors;
}

export function checkSnapshotShape(snapshot, listId, version, where) {
  if (!isObject(snapshot)) return [`${where} is not a JSON object`];
  const errors = checkHeaderFields(snapshot, listId, where);
  if (snapshot.version !== version) errors.push(`${where}: version is ${snapshot.version}, expected ${version}`);
  for (const kind of KINDS) {
    if (!isObject(snapshot[kind])) {
      errors.push(`${where}: ${kind} is missing`);
      continue;
    }
    for (const set of SET_NAMES) errors.push(...checkEntryArray(snapshot[kind][set], set, `${where}: ${kind}.${set}`));
  }
  if (errors.length === 0) {
    for (const set of SET_NAMES) {
      const blocked = new Set(snapshot.block[set]);
      const overlap = snapshot.warn[set].filter((v) => blocked.has(v));
      if (overlap.length > 0) errors.push(`${where}: ${overlap.length} ${set} are in both block and warn`);
    }
  }
  return errors;
}

export function checkDeltaShape(delta, listId, to, where) {
  if (!isObject(delta)) return [`${where} is not a JSON object`];
  const errors = checkHeaderFields(delta, listId, where);
  if (delta.to !== to) errors.push(`${where}: to is ${delta.to}, expected ${to}`);
  if (delta.from !== to - 1) errors.push(`${where}: from is ${delta.from}, expected ${to - 1}`);
  for (const kind of KINDS) {
    for (const set of SET_NAMES) {
      const change = delta[kind]?.[set];
      if (!isObject(change)) {
        errors.push(`${where}: ${kind}.${set} is missing`);
        continue;
      }
      for (const op of ['add', 'remove']) errors.push(...checkEntryArray(change[op], set, `${where}: ${kind}.${set}.${op}`));
    }
  }
  return errors;
}

const checkFileRef = (ref, expectedPath, where) => {
  if (!isObject(ref)) return [`${where} is missing`];
  const errors = [];
  if (ref.path !== expectedPath) errors.push(`${where}.path is ${JSON.stringify(ref.path)}, expected "${expectedPath}"`);
  if (!isSha256(ref.sha256)) errors.push(`${where}.sha256 is not lowercase hex SHA-256`);
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) errors.push(`${where}.bytes is not a byte count`);
  return errors;
};

export function checkPayloadShape(payload, listId) {
  const where = 'manifest payload';
  if (!isObject(payload)) return [`${where} is not a JSON object`];
  const errors = checkHeaderFields(payload, listId, where);
  if (!isPositiveInt(payload.version)) return [...errors, `${where}: version is not a positive integer`];
  if (typeof payload.generated_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(payload.generated_at)) {
    errors.push(`${where}: generated_at is not an ISO 8601 UTC timestamp`);
  }
  errors.push(...checkFileRef(payload.snapshot, snapshotRelPath(payload.version), `${where}: snapshot`));
  if (!Array.isArray(payload.deltas)) {
    errors.push(`${where}: deltas is not an array`);
  } else {
    payload.deltas.forEach((d, i) => {
      if (!isObject(d) || !isPositiveInt(d.to)) errors.push(`${where}: deltas[${i}].to is not a positive integer`);
      else errors.push(...checkFileRef(d, deltaRelPath(d.to), `${where}: deltas[${i}]`));
    });
    const tos = payload.deltas.map((d) => d?.to);
    if (tos.some((to, i) => i > 0 && !(tos[i - 1] > to))) errors.push(`${where}: deltas are not newest first without repeats`);
    if (payload.deltas.length > DELTAS_KEPT) errors.push(`${where}: lists ${payload.deltas.length} deltas, more than ${DELTAS_KEPT}`);
    if (payload.version > 1 && tos[0] !== payload.version) errors.push(`${where}: newest delta is not to version ${payload.version}`);
    if (payload.version === 1 && tos.length > 0) errors.push(`${where}: version 1 lists deltas`);
  }
  if (!isPositiveInt(payload.max_delta_chain)) errors.push(`${where}: max_delta_chain is not a positive integer`);
  if (!isObject(payload.counts)) errors.push(`${where}: counts is missing`);
  const source = payload.source;
  if (!isObject(source)) {
    errors.push(`${where}: source is missing`);
  } else {
    for (const field of ['name', 'homepage', 'repo', 'license']) {
      if (typeof source[field] !== 'string' || source[field] === '') errors.push(`${where}: source.${field} is missing`);
    }
    if (!COMMIT_SHA_PATTERN.test(source.commit ?? '')) errors.push(`${where}: source.commit is not a full commit sha`);
  }
  return errors;
}

export function checkIndexShape(index, listId) {
  if (!isObject(index)) return ['index.json is not a JSON object'];
  const errors = [];
  if (index.schema !== SCHEMA_VERSION) errors.push(`index.json: schema is ${index.schema}, expected ${SCHEMA_VERSION}`);
  if (!Array.isArray(index.lists)) return [...errors, 'index.json: lists is not an array'];
  for (const [i, entry] of index.lists.entries()) {
    for (const field of ['id', 'name', 'description', 'manifest', 'homepage', 'license']) {
      if (typeof entry?.[field] !== 'string' || entry[field] === '') errors.push(`index.json: lists[${i}].${field} is missing`);
    }
  }
  const entry = index.lists.find((e) => e?.id === listId);
  if (!entry) errors.push(`index.json does not list "${listId}"`);
  else if (entry.manifest !== indexManifestPath(listId)) errors.push(`index.json: manifest for "${listId}" is ${JSON.stringify(entry.manifest)}`);
  return errors;
}

/** Parse JSON bytes, pushing an error and returning undefined when they do not parse. */
function parseJson(bytes, where, errors) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    errors.push(`${where} does not parse as JSON: ${error.message}`);
    return undefined;
  }
}

/**
 * Read a file listed in the manifest, check its size and hash, and parse it.
 * Returns the parsed value, or undefined after pushing an error.
 */
async function readListed(read, treePath, ref, errors) {
  const bytes = await read(treePath);
  if (bytes === null) {
    errors.push(`${treePath} is listed in the manifest but missing`);
    return undefined;
  }
  if (bytes.length !== ref.bytes) errors.push(`${treePath}: ${bytes.length} bytes, manifest says ${ref.bytes}`);
  if (sha256Hex(bytes) !== ref.sha256) {
    errors.push(`${treePath}: sha256 does not match the manifest`);
    return undefined;
  }
  return parseJson(bytes, treePath, errors);
}

/**
 * Verify one list in a tree. Returns { ok, errors, payload }.
 *
 * read:          async (treePath) => Buffer | null
 * publicKeys:    { [keyId]: PEM or KeyObject }
 * expectVersion: when set, the manifest must carry this version.
 */
export async function verifyTree({ read, listId, publicKeys, expectVersion = null }) {
  const errors = [];
  const result = (payload = null) => ({ ok: errors.length === 0, errors, payload });

  const indexBytes = await read(INDEX_PATH);
  if (indexBytes === null) errors.push(`${INDEX_PATH} is missing`);
  else {
    const index = parseJson(indexBytes, INDEX_PATH, errors);
    if (index !== undefined) errors.push(...checkIndexShape(index, listId));
  }

  const envelopePath = manifestPath(listId);
  const envelopeBytes = await read(envelopePath);
  if (envelopeBytes === null) {
    errors.push(`${envelopePath} is missing`);
    return result();
  }
  const envelope = parseJson(envelopeBytes, envelopePath, errors);
  if (envelope === undefined) return result();
  const opened = openEnvelope(envelope, publicKeys);
  if (!opened.ok) {
    errors.push(`${envelopePath}: ${opened.error}`);
    return result();
  }
  const payload = opened.payload;
  const shapeErrors = checkPayloadShape(payload, listId);
  if (shapeErrors.length > 0) {
    errors.push(...shapeErrors);
    return result(payload);
  }
  if (expectVersion !== null && payload.version !== expectVersion) {
    errors.push(`${envelopePath}: version is ${payload.version}, expected ${expectVersion}`);
  }

  const base = listDir(listId);
  const snapshotPath = `${base}/${payload.snapshot.path}`;
  const snapshot = await readListed(read, snapshotPath, payload.snapshot, errors);
  let lists;
  if (snapshot !== undefined) {
    const snapshotErrors = checkSnapshotShape(snapshot, listId, payload.version, snapshotPath);
    errors.push(...snapshotErrors);
    if (snapshotErrors.length === 0) {
      lists = snapshotLists(snapshot);
      const counts = countEntries(lists);
      for (const [key, value] of Object.entries(counts)) {
        if (payload.counts[key] !== value) errors.push(`manifest payload: counts.${key} is ${payload.counts[key]}, snapshot has ${value}`);
      }
    }
  }

  let newestDelta;
  for (const ref of payload.deltas) {
    const deltaPath = `${base}/${ref.path}`;
    const delta = await readListed(read, deltaPath, ref, errors);
    if (delta === undefined) continue;
    const deltaErrors = checkDeltaShape(delta, listId, ref.to, deltaPath);
    errors.push(...deltaErrors);
    if (ref.to === payload.version && deltaErrors.length === 0) newestDelta = delta;
  }

  if (payload.version > 1 && lists && newestDelta) {
    const previousPath = `${base}/${snapshotRelPath(payload.version - 1)}`;
    const previousBytes = await read(previousPath);
    if (previousBytes === null) {
      errors.push(`${previousPath} is missing, cannot check the newest delta`);
    } else {
      const previous = parseJson(previousBytes, previousPath, errors);
      if (previous !== undefined) {
        const previousErrors = checkSnapshotShape(previous, listId, payload.version - 1, previousPath);
        errors.push(...previousErrors);
        if (previousErrors.length === 0 && !listsEqual(applyDelta(snapshotLists(previous), newestDelta), lists)) {
          errors.push(`previous snapshot plus delta ${payload.version} does not equal snapshot ${payload.version}`);
        }
      }
    }
  }

  return result(payload);
}

/** Read a header from a fetch Headers object or a plain lowercase-keyed object. */
const header = (headers, name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]) ?? '';

/**
 * Check live response headers recorded during the smoke test.
 * responses: [{ path, status, headers }] for tree paths; missingPath must have answered 404.
 */
export function checkLiveHeaders(responses, { missingPath }) {
  const errors = [];
  const missing = responses.find((r) => r.path === missingPath);
  if (!missing) errors.push(`${missingPath} was not requested`);
  else if (missing.status !== 404) errors.push(`${missingPath}: status ${missing.status}, expected 404`);

  for (const { path, status, headers } of responses) {
    if (path === missingPath) continue;
    const fail = (message) => errors.push(`${path}: ${message}`);
    if (status !== 200) {
      fail(`status ${status}, expected 200`);
      continue;
    }
    if (!header(headers, 'content-type').startsWith('application/json')) fail(`content-type is "${header(headers, 'content-type')}"`);
    if (header(headers, 'access-control-allow-origin') !== '*') fail('access-control-allow-origin is not *');
    if (header(headers, 'x-content-type-options') !== 'nosniff') fail('x-content-type-options is not nosniff');

    const cacheControl = header(headers, 'cache-control');
    const immutable = /\/(snapshot|delta)\/\d+\.json$/.test(path);
    if (immutable) {
      if (!cacheControl.includes('max-age=31536000') || !cacheControl.includes('immutable')) fail(`cache-control is "${cacheControl}", expected a one-year immutable cache`);
    } else if (!cacheControl.includes('max-age=3600')) {
      fail(`cache-control is "${cacheControl}", expected max-age=3600`);
    }
    if (path.endsWith('/manifest.json') && header(headers, 'etag') === '') fail('no ETag');
  }
  return errors;
}
