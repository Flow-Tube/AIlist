// Fixed values shared by the pipeline, the self-check and the tests.
// Anything specific to one source list lives in sources/<id>.json instead.

/** Schema number written into every published JSON file. */
export const SCHEMA_VERSION = 1;

/** Ed25519 key id written into the manifest envelope; see keys/<id>.pub.pem. */
export const KEY_ID = '2026-11';

/** Retention and client hints. */
export const SNAPSHOTS_KEPT = 3;
export const DELTAS_KEPT = 30;
export const MAX_DELTA_CHAIN = 14;

/** The two lists every source publishes, and the two sets inside each list. */
export const KINDS = Object.freeze(['block', 'warn']);
export const SET_NAMES = Object.freeze(['handles', 'ids']);

/** A YouTube channel id as published in the `ids` arrays. */
export const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

/** A full git commit sha as recorded in the manifest's `source.commit`. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Overrides file: same line format as the source lists, with `#` also starting a comment. */
export const ALLOW_FORMAT = 'aislist-txt';
export const ALLOW_COMMENT_PREFIXES = Object.freeze(['!', '#']);

/** GitHub endpoints used to pin and download a source. */
export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';

/** Default local paths, relative to the repo root. */
export const DEFAULT_PATHS = Object.freeze({
  sources: 'sources',
  allow: 'overrides/allow.txt',
  static: 'static',
  keys: 'keys',
  out: 'site',
});

/** Published tree layout. Tree paths are relative to the site root. */
export const API_ROOT = 'v1';
export const INDEX_PATH = `${API_ROOT}/index.json`;
export const MANIFEST_FILE = 'manifest.json';
export const SNAPSHOT_DIR = 'snapshot';
export const DELTA_DIR = 'delta';
export const VERSIONED_FILE_PATTERN = /^(\d+)\.json$/;

/** Folder of one list inside the tree, e.g. `v1/aislist`. */
export const listDir = (listId) => `${API_ROOT}/${listId}`;

/** Manifest path inside the tree, e.g. `v1/aislist/manifest.json`. */
export const manifestPath = (listId) => `${listDir(listId)}/${MANIFEST_FILE}`;

/** Manifest path as listed in index.json (relative to `v1/`). */
export const indexManifestPath = (listId) => `${listId}/${MANIFEST_FILE}`;

/** Snapshot and delta paths relative to the list folder, as written in the manifest. */
export const snapshotRelPath = (version) => `${SNAPSHOT_DIR}/${version}.json`;
export const deltaRelPath = (version) => `${DELTA_DIR}/${version}.json`;

/** Public key file name for a key id, e.g. `2026-11.pub.pem`. */
export const publicKeyFileName = (keyId) => `${keyId}.pub.pem`;
export const PUBLIC_KEY_FILE_PATTERN = /^(.+)\.pub\.pem$/;
