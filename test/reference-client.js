// Reference client: one update run of the client contract in README.md.
// The e2e test drives it against trees built by publish.js --dry-run.
// It is test code, not part of the published pipeline.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { openEnvelope } from '../src/sign.js';
import { sha256Hex, applyDelta, snapshotLists } from '../src/build.js';
import { listDir, manifestPath } from '../src/constants.js';

/** Highest schema this client understands. */
const SUPPORTED_SCHEMA = 1;

async function loadStore(storePath) {
  try {
    return JSON.parse(await readFile(storePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Step 6: write to a temporary file, then rename it over the stored file. */
async function saveStore(storePath, store) {
  const temporary = `${storePath}.tmp`;
  await writeFile(temporary, JSON.stringify(store));
  await rename(temporary, storePath);
}

/**
 * Run one update.
 *
 * get:        async (treePath, requestHeaders) => { status, body: Buffer | null, etag }
 * storePath:  file holding { version, etag, lists }
 * publicKeys: { [keyId]: PEM } shipped with the app
 *
 * Returns { outcome, version?, reason? } where outcome is one of
 * not-modified, failed, ignored, up-to-date, snapshot, deltas, fallback-snapshot.
 * On any failure the stored list is left exactly as it was.
 */
export async function runUpdate({ get, storePath, publicKeys, listId }) {
  const stored = await loadStore(storePath);

  // 1. Conditional manifest request.
  const response = await get(manifestPath(listId), stored?.etag ? { 'if-none-match': stored.etag } : {});
  if (response.status === 304) return { outcome: 'not-modified' };
  if (response.status !== 200) return { outcome: 'failed', reason: `manifest status ${response.status}` };

  // 2. Verify the envelope before parsing the payload.
  let envelope;
  try {
    envelope = JSON.parse(response.body.toString('utf8'));
  } catch {
    return { outcome: 'failed', reason: 'manifest is not JSON' };
  }
  const opened = openEnvelope(envelope, publicKeys);
  if (!opened.ok) return { outcome: 'failed', reason: opened.error };
  const manifest = opened.payload;

  // 3. Schema, list and version checks.
  if (manifest.schema > SUPPORTED_SCHEMA) return { outcome: 'ignored', reason: `schema ${manifest.schema}` };
  if (manifest.list !== listId) return { outcome: 'ignored', reason: `list ${manifest.list}` };
  if (stored && manifest.version < stored.version) return { outcome: 'ignored', reason: 'older version (rollback)' };
  if (stored && manifest.version === stored.version) return { outcome: 'up-to-date', version: stored.version };

  const base = listDir(listId);
  /** 5. Download a listed file and check its SHA-256 before using it. */
  const fetchVerified = async (ref) => {
    const file = await get(`${base}/${ref.path}`, {});
    if (file.status !== 200) throw new Error(`${ref.path}: status ${file.status}`);
    if (sha256Hex(file.body) !== ref.sha256) throw new Error(`${ref.path}: hash mismatch`);
    return JSON.parse(file.body.toString('utf8'));
  };

  // 4. Choose deltas or the snapshot.
  const steps = stored ? Array.from({ length: manifest.version - stored.version }, (_, i) => stored.version + 1 + i) : [];
  const deltaRefs = new Map(manifest.deltas.map((d) => [d.to, d]));
  const useDeltas = stored !== null && steps.length <= manifest.max_delta_chain && steps.every((v) => deltaRefs.has(v));

  let lists = null;
  let outcome = 'snapshot';
  if (useDeltas) {
    try {
      let working = stored.lists;
      for (const version of steps) {
        const delta = await fetchVerified(deltaRefs.get(version));
        if (delta.list !== listId || delta.from !== version - 1 || delta.to !== version) throw new Error(`delta ${version} has the wrong range`);
        working = applyDelta(working, delta);
      }
      lists = working;
      outcome = 'deltas';
    } catch {
      // 7. A failed delta falls back to the snapshot once in the same run.
      outcome = 'fallback-snapshot';
    }
  }
  if (lists === null) {
    try {
      const snapshot = await fetchVerified(manifest.snapshot);
      if (snapshot.list !== listId || snapshot.version !== manifest.version) throw new Error('snapshot does not match the manifest');
      lists = snapshotLists(snapshot);
    } catch (error) {
      return { outcome: 'failed', reason: error.message };
    }
  }

  // 6. Persist atomically; only then would an app swap its in-memory sets.
  await saveStore(storePath, { version: manifest.version, etag: response.etag, lists });
  return { outcome, version: manifest.version };
}
