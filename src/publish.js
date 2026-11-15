#!/usr/bin/env node
// Entry point. Runs the pipeline steps in order and owns all file system access.
// List logic lives in parse, normalize, guards, build, sign and verify-tree.
//
//   node src/publish.js [--dry-run] [--force] [--out site] [--summary f] [--report f]
//   node src/publish.js --smoke https://ailist.flow-tube.org [--out site]
//
// Publish mode runs pipeline steps 2 to 11: pin and download each source, parse,
// normalize, apply overrides, resolve overlap, run the guards, compare, build,
// sign, and self-check the tree in --out. It never commits, pushes or deploys.
// Smoke mode checks the live site against the tree in --out.

import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  KEY_ID,
  KINDS,
  GITHUB_WEB,
  ALLOW_FORMAT,
  ALLOW_COMMENT_PREFIXES,
  DEFAULT_PATHS,
  INDEX_PATH,
  SNAPSHOT_DIR,
  DELTA_DIR,
  VERSIONED_FILE_PATTERN,
  PUBLIC_KEY_FILE_PATTERN,
  listDir,
  manifestPath,
  deltaRelPath,
} from './constants.js';
import { getParser } from './parse.js';
import { normalizeEntries } from './normalize.js';
import { measureSource, checkGuards, validateLimits } from './guards.js';
import { assembleLists, planRelease, makeIndex, encodeJson, snapshotLists, kindSize, summarizeDiff } from './build.js';
import { signEnvelope, readEnvelopeUnverified, generateThrowawayKey } from './sign.js';
import { verifyTree, checkLiveHeaders } from './verify-tree.js';
import { downloadSource, createHttpReader } from './fetch.js';
import { parseCache, serializeCache, pruneCache, planLookups, mergeResults, cachedIds, isoDay } from './resolve-cache.js';
import { resolveHandle, searchArtist, runLookups } from './resolve.js';

const SIGNING_KEY_ENV = 'AILIST_SIGNING_KEY';
const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';
const SMOKE_ATTEMPTS = 5;
const SMOKE_DELAY_MS = 30_000;
const PLACEHOLDER_COMMIT = '0'.repeat(40);
const LIST_FIELDS = ['id', 'name', 'description', 'homepage', 'license', 'guards'];
const INPUT_FIELDS = ['name', 'homepage', 'repo', 'branch', 'files', 'format', 'license'];
const RESOLVE_LIMITS = ['daily_budget', 'recheck_found_days', 'recheck_missing_days', 'max_minutes'];
const LOOKUPS = Object.freeze(['handle', 'artist-name']);

const CLI_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  out: { type: 'string', default: DEFAULT_PATHS.out },
  sources: { type: 'string', default: DEFAULT_PATHS.sources },
  allow: { type: 'string', default: DEFAULT_PATHS.allow },
  static: { type: 'string', default: DEFAULT_PATHS.static },
  keys: { type: 'string', default: DEFAULT_PATHS.keys },
  cache: { type: 'string', default: DEFAULT_PATHS.cache },
  'resolve-budget': { type: 'string' },
  'resolve-fixture': { type: 'string' },
  'source-dir': { type: 'string' },
  'source-commit': { type: 'string', default: PLACEHOLDER_COMMIT },
  summary: { type: 'string' },
  report: { type: 'string' },
  smoke: { type: 'string' },
  help: { type: 'boolean', default: false },
};

const USAGE = `Usage:
  node src/publish.js [options]               build, sign and self-check the tree in --out
  node src/publish.js --smoke <base-url>      check the live site against the tree in --out

Options:
  --dry-run              sign with a throwaway in-memory key instead of ${SIGNING_KEY_ENV}
  --force                skip only the shrink and growth guards
  --out <dir>            published tree to read and update (default: ${DEFAULT_PATHS.out})
  --sources <dir>        source configs (default: ${DEFAULT_PATHS.sources})
  --allow <file>         overrides allow list (default: ${DEFAULT_PATHS.allow})
  --static <dir>         static files copied into the tree (default: ${DEFAULT_PATHS.static})
  --keys <dir>           public keys, named <key_id>.pub.pem (default: ${DEFAULT_PATHS.keys})
  --cache <dir>          id lookup cache, one <list-id>.tsv per list (default: ${DEFAULT_PATHS.cache})
  --resolve-budget <n>   most id lookups per list this run (default: the config's daily_budget; 0 = none)
  --resolve-fixture <f>  answer id lookups from a JSON file of { key: id or null } instead of YouTube
  --source-dir <dir>     read source files from <dir>/<config file path> instead of downloading
  --source-commit <sha>  commit recorded for --source-dir (default: ${PLACEHOLDER_COMMIT})
  --summary <file>       write a JSON run summary, including the data commit message
  --report <file>        write a Markdown report when a guard aborts the run`;

class GuardAbort extends Error {}

const log = (message) => console.log(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortSha = (sha) => sha.slice(0, 7);

// ---------------------------------------------------------------- file system

async function readOptional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFileDeep(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

/** Reader over a local tree for verify-tree. */
const localReader = (root) => (treePath) => readOptional(path.join(root, treePath));

/** Version numbers of the `<n>.json` files in a folder (empty when it does not exist). */
async function listVersions(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map((name) => VERSIONED_FILE_PATTERN.exec(name)).filter(Boolean).map((match) => Number(match[1]));
}

export async function loadConfigs(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  if (names.length === 0) throw new Error(`No source configs in ${dir}`);
  const configs = [];
  for (const name of names) {
    const config = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    const where = path.join(dir, name);
    for (const field of LIST_FIELDS) {
      if (config[field] === undefined) throw new Error(`${where}: missing "${field}"`);
    }
    if (`${config.id}.json` !== name) throw new Error(`${where}: id "${config.id}" does not match the file name`);
    if (config.inputs !== undefined && (!Array.isArray(config.inputs) || config.inputs.length === 0)) {
      throw new Error(`${where}: inputs must be a non-empty array`);
    }
    for (const [i, input] of inputsOf(config).entries()) {
      const at = config.inputs ? `${where}: inputs[${i}]` : where;
      for (const field of INPUT_FIELDS) {
        if (input[field] === undefined) throw new Error(`${at}: missing "${field}"`);
      }
      if (typeof input.files.block !== 'string') throw new Error(`${at}: files.block is missing`);
      if (!config.inputs && typeof input.files.warn !== 'string') throw new Error(`${at}: files.warn is missing`);
      if (input.files.warn !== undefined && typeof input.files.warn !== 'string') throw new Error(`${at}: files.warn is not a path`);
      getParser(input.format);
    }
    validateLimits(config.guards);
    if (config.resolve !== undefined) validateResolve(config.resolve, where);
    configs.push(config);
  }
  return configs;
}

function validateResolve(resolve, where) {
  for (const key of RESOLVE_LIMITS) {
    if (!Number.isInteger(resolve?.[key]) || resolve[key] < 0) throw new Error(`${where}: resolve.${key} must be a non-negative integer`);
  }
  const lookup = resolve.lookup ?? 'handle';
  if (!LOOKUPS.includes(lookup)) throw new Error(`${where}: resolve.lookup must be one of ${LOOKUPS.join(', ')}`);
  if (lookup === 'artist-name' && (!Number.isInteger(resolve.max_audience) || resolve.max_audience < 0)) {
    throw new Error(`${where}: resolve.max_audience must be a non-negative integer for artist-name lookups`);
  }
}

/**
 * The upstream sources of a list. A single-source config names its repo and
 * files at the top level; a compiled list names several under `inputs`, each
 * with its own repo, files (block, optionally warn), format and licence.
 */
export function inputsOf(config) {
  if (config.inputs) return config.inputs;
  const { id, name, homepage, repo, branch, files, format, license } = config;
  return [{ id, name, homepage, repo, branch, files, format, license }];
}

/** Allow-list entries, normalized. An unreadable line is an error, never silently skipped. */
export async function loadAllow(file) {
  const text = (await readOptional(file))?.toString('utf8') ?? '';
  const parsed = getParser(ALLOW_FORMAT)(text, { commentPrefixes: ALLOW_COMMENT_PREFIXES });
  const normalized = normalizeEntries(parsed);
  const invalid = [...parsed.rejected, ...normalized.rejected];
  if (invalid.length > 0) throw new Error(`${file}: invalid entries: ${invalid.map((l) => JSON.stringify(l)).join(', ')}`);
  return { handles: [...normalized.handles], ids: [...normalized.ids] };
}

/** Public keys by key id from <dir>/<key_id>.pub.pem. */
async function loadPublicKeys(dir) {
  const keys = {};
  let names = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of names) {
    const match = PUBLIC_KEY_FILE_PATTERN.exec(name);
    if (match) keys[match[1]] = await readFile(path.join(dir, name), 'utf8');
  }
  return keys;
}

/** The signing key and the public keys the self-check trusts. */
async function loadSigning({ dryRun, keysDir }) {
  if (dryRun) {
    const { privateKey, publicKeyPem } = generateThrowawayKey();
    return { privateKey, publicKeys: { [KEY_ID]: publicKeyPem }, throwawayPublicKeyPem: publicKeyPem };
  }
  const privateKey = process.env[SIGNING_KEY_ENV];
  if (!privateKey) throw new Error(`${SIGNING_KEY_ENV} is not set. Use --dry-run to sign with a throwaway key.`);
  const publicKeys = await loadPublicKeys(keysDir);
  if (!publicKeys[KEY_ID]) throw new Error(`No public key for key_id "${KEY_ID}" in ${keysDir}`);
  return { privateKey, publicKeys };
}

/** The previous release of a list from the tree, or null on the first run. */
async function readPrevious(out, listId) {
  const envelopeBytes = await readOptional(path.join(out, manifestPath(listId)));
  if (envelopeBytes === null) return null;
  const { payload, payloadBytes } = readEnvelopeUnverified(JSON.parse(envelopeBytes.toString('utf8')));
  const snapshotFile = path.join(out, listDir(listId), payload.snapshot.path);
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  return { payload, payloadBytes, lists: snapshotLists(snapshot) };
}

/** Step 2: for each input, the source texts per list kind and the commit they came from. */
async function acquireInputs(config, options) {
  const acquired = [];
  for (const input of inputsOf(config)) {
    if (!options['source-dir']) {
      acquired.push({ input, ...(await downloadSource(input, { token: process.env[GITHUB_TOKEN_ENV] })) });
      continue;
    }
    const texts = {};
    for (const [kind, file] of Object.entries(input.files)) texts[kind] = await readFile(path.join(options['source-dir'], file), 'utf8');
    acquired.push({ input, commit: options['source-commit'], texts });
  }
  return acquired;
}

const emptyParse = () => ({ handles: [], ids: [], names: [], rejected: [], entryLines: 0, declaredTotal: null });

/** Merge the parse results of several inputs for one list kind. A header total only counts for a single input. */
function mergeParsed(results) {
  if (results.length === 1) return { names: [], ...results[0] };
  const merged = emptyParse();
  for (const result of results) {
    merged.handles.push(...result.handles);
    merged.ids.push(...result.ids);
    merged.names.push(...(result.names ?? []));
    merged.rejected.push(...result.rejected);
    merged.entryLines += result.entryLines;
  }
  return merged;
}

/** The payload's provenance: `source` for a single input, `sources` for a compiled list. */
function provenance(config, acquired) {
  const describe = ({ input, commit }) => ({
    name: input.name,
    homepage: input.homepage,
    repo: `${GITHUB_WEB}/${input.repo}`,
    commit,
    license: input.license,
    ...(input.attribution ? { attribution: input.attribution } : {}),
  });
  return config.inputs ? { sources: acquired.map(describe) } : { source: describe(acquired[0]) };
}

// ---------------------------------------------------------------- id resolution

const cachePath = (options, listId) => path.join(options.cache, `${listId}.tsv`);

/**
 * The lookup function for this run: a fixture file of { key: id or null } in
 * tests, YouTube otherwise. `names` maps an artist-name key to the name to search.
 */
async function createLookup(config, options, names) {
  if (options['resolve-fixture']) {
    const answers = JSON.parse(await readFile(options['resolve-fixture'], 'utf8'));
    return async (key) => {
      if (!Object.hasOwn(answers, key)) throw new Error(`no fixture answer for ${key}`);
      return { id: answers[key] };
    };
  }
  if ((config.resolve.lookup ?? 'handle') === 'handle') return (handle) => resolveHandle(handle);
  return (key) => searchArtist(names.get(key), { maxAudience: config.resolve.max_audience });
}

/**
 * Look up YouTube ids within the run's budget and add every id the cache knows
 * to the same list kind as its key. Keys are normalized handles (`lookup:
 * handle`) or artist-name keys (`lookup: artist-name`). Allow-listed handles
 * are never looked up and never contribute an id; allow-listed ids are dropped
 * later with the rest.
 *
 * Returns { cache, prunedCache, lookupGrowth }. The caller saves the pruned
 * cache once the guards pass and the full one when they do not, so a bad source
 * never costs the lookups already made. lookupGrowth counts block ids that come
 * from lookups and were not in the previous version, which the growth guard
 * leaves out: the lookup budget bounds them, and counting them would keep
 * blocking every run after one aborted with lookups cached.
 */
async function resolveListIds(config, { normalized, allow, previous, options }) {
  const byHandle = (config.resolve.lookup ?? 'handle') === 'handle';
  const allowed = new Set(allow.handles);
  const names = new Map(KINDS.flatMap((kind) => [...normalized[kind].names]));
  const keysByKind = Object.fromEntries(
    KINDS.map((kind) => [kind, byHandle ? [...normalized[kind].handles].filter((h) => !allowed.has(h)) : [...normalized[kind].names.keys()]]),
  );
  const listed = [...new Set(KINDS.flatMap((kind) => keysByKind[kind]))];
  const previousHandles = new Set(byHandle && previous ? KINDS.flatMap((kind) => previous.lists[kind].handles) : []);
  const today = isoDay(new Date());
  const what = byHandle ? 'handles' : 'artist names';

  let cache = parseCache((await readOptional(cachePath(options, config.id)))?.toString('utf8'));
  const budget = options['resolve-budget'] === undefined ? config.resolve.daily_budget : Number(options['resolve-budget']);
  if (!Number.isInteger(budget) || budget < 0) throw new Error('--resolve-budget must be a non-negative integer');
  const plan = planLookups({
    keys: listed,
    priority: byHandle && previous ? listed.filter((h) => !previousHandles.has(h)) : [],
    cache,
    today,
    budget,
    recheckFoundDays: config.resolve.recheck_found_days,
    recheckMissingDays: config.resolve.recheck_missing_days,
  });
  if (plan.length > 0) {
    const run = await runLookups(plan, await createLookup(config, options, names), {
      deadline: Date.now() + config.resolve.max_minutes * 60_000,
      spacingMs: options['resolve-fixture'] ? 0 : undefined,
    });
    cache = mergeResults(cache, run.results, today);
    const found = [...run.results.values()].filter((r) => r.id).length;
    const reasons = {};
    for (const { id, reason } of run.results.values()) if (!id && reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
    const why = Object.keys(reasons).length > 0 ? ` (${Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(', ')})` : '';
    log(
      `${config.id}: looked up ${run.results.size} of ${plan.length} planned ${what}: ${found} found, ` +
        `${run.results.size - found} not found${why}, ${run.failed} failed` +
        (run.rateLimited ? ', stopped on a rate limit' : '') +
        (run.timedOut ? ', stopped at the time limit' : ''),
    );
  }

  const sourceBlockIds = new Set(normalized.block.ids);
  for (const kind of KINDS) {
    for (const id of cachedIds(cache, keysByKind[kind])) normalized[kind].ids.add(id);
  }
  const previousBlockIds = new Set(previous?.lists.block.ids ?? []);
  const lookupGrowth = [...normalized.block.ids].filter((id) => !sourceBlockIds.has(id) && !previousBlockIds.has(id)).length;
  const resolved = listed.filter((key) => cache.get(key)?.id).length;
  const unchecked = listed.filter((key) => !cache.has(key)).length;
  log(`${config.id}: ${resolved} of ${listed.length} ${what} have an id, ${unchecked} not looked up yet`);
  return { cache, prunedCache: pruneCache(cache, listed), lookupGrowth };
}

async function saveCache(options, listId, cache) {
  await writeFileDeep(cachePath(options, listId), serializeCache(cache, `${listId}: lookup key, YouTube id or -, last checked (UTC)`));
}

// ---------------------------------------------------------------- reporting

function describeVersion(listId, version, changes, acquired) {
  const totals = summarizeDiff(changes);
  const parts = KINDS.map((kind) => `+${totals[kind].add} -${totals[kind].remove} ${kind}`);
  const label = acquired.length === 1 ? 'source' : 'sources';
  return `data(${listId}): v${version} (${parts.join(', ')}), ${label} ${acquired.map((a) => shortSha(a.commit)).join(' ')}`;
}

function guardReport(prepared, force) {
  const lines = [];
  for (const { config, acquired, stats, guard, lists, previous } of prepared) {
    if (guard.failures.length === 0) continue;
    lines.push(`## ${config.name} (\`${config.id}\`)`, '');
    for (const { input, commit } of acquired) lines.push(`Source: ${input.repo} at \`${commit}\``, '');
    lines.push('**Failed checks**', '', ...guard.failures.map((f) => `- \`${f.guard}\`: ${f.message}`), '');
    lines.push('| Number | Value |', '| --- | --- |');
    lines.push(`| Block entries now | ${kindSize(lists, 'block')} |`);
    lines.push(`| Block entries in v${previous?.payload.version ?? '-'} | ${previous ? kindSize(previous.lists, 'block') : 'none (first run)'} |`);
    lines.push(`| Warn entries now | ${kindSize(lists, 'warn')} |`);
    lines.push(`| Entry lines parsed | ${stats.entryLines} |`);
    lines.push(`| Rejected entries | ${stats.rejected} |`);
    for (const h of stats.headers) lines.push(`| ${h.kind} header / parsed | ${h.declared} / ${h.parsed} |`);
    lines.push('');
    if (guard.skipped.length > 0) lines.push(`Skipped: ${guard.skipped.join(', ')}`, '');
  }
  lines.push('The live list stays at the last good version.');
  if (!force) lines.push('After a human look, re-run `publish.yml` with `force: true`, which skips only the shrink and growth guards.');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- publish

/** Steps 2 to 8 for one list, plus the build plan of step 9. Writes nothing. */
async function prepareList(config, { options, allow, out }) {
  const acquired = await acquireInputs(config, options);
  for (const { input, commit } of acquired) log(`${config.id}: source ${input.repo} at ${commit}`);

  const parsed = {};
  const normalized = {};
  for (const kind of KINDS) {
    parsed[kind] = mergeParsed(
      acquired.map(({ input, texts }) => (texts[kind] === undefined ? emptyParse() : getParser(input.format)(texts[kind]))),
    );
    normalized[kind] = normalizeEntries(parsed[kind]);
    normalized[kind].names = new Map(parsed[kind].names.map((entry) => [entry.key, entry.name]));
    const merged = parsed[kind].handles.length - normalized[kind].rejected.length - normalized[kind].handles.size;
    log(
      `${config.id}: ${kind} ${parsed[kind].entryLines} lines` +
        (parsed[kind].declaredTotal === null ? '' : ` (header ${parsed[kind].declaredTotal})`) +
        ` -> ${normalized[kind].handles.size} handles, ${normalized[kind].ids.size} ids,` +
        (normalized[kind].names.size > 0 ? ` ${normalized[kind].names.size} artist names,` : '') +
        ` ${merged} duplicates merged, ${parsed[kind].rejected.length + normalized[kind].rejected.length} rejected`,
    );
  }

  const previous = await readPrevious(out, config.id);
  const resolution = config.resolve ? await resolveListIds(config, { normalized, allow, previous, options }) : null;
  const lists = assembleLists(normalized, allow);
  const stats = measureSource(parsed, normalized);
  const guard = checkGuards({
    limits: config.guards,
    stats,
    blockEntries: kindSize(lists, 'block'),
    previousBlockEntries: previous ? kindSize(previous.lists, 'block') : null,
    lookupGrowth: resolution?.lookupGrowth ?? 0,
    force: options.force,
  });
  log(`${config.id}: after overrides and overlap: block ${kindSize(lists, 'block')}, warn ${kindSize(lists, 'warn')}`);
  for (const failure of guard.failures) log(`${config.id}: GUARD FAILED ${failure.guard}: ${failure.message}`);
  if (guard.skipped.length > 0) log(`${config.id}: guards skipped: ${guard.skipped.join(', ')}`);

  let plan = null;
  if (guard.failures.length === 0) {
    const base = path.join(out, listDir(config.id));
    plan = planRelease({
      config,
      previous,
      existing: { snapshots: await listVersions(path.join(base, SNAPSHOT_DIR)), deltas: await listVersions(path.join(base, DELTA_DIR)) },
      lists,
      provenance: provenance(config, acquired),
      generatedAt: new Date(),
    });
  }
  return { config, acquired, lists, previous, stats, guard, plan, resolution };
}

/**
 * Steps 9 and 10 for one list: write files, prune, sign and write the manifest.
 * An unchanged list keeps its payload bytes and is signed again. Ed25519 is
 * deterministic, so with the same key the manifest comes out byte-identical,
 * and every run proves the signing key still matches the published public key.
 */
async function writeRelease({ config, plan, previous }, { out, signing }) {
  const base = path.join(out, listDir(config.id));
  for (const relPath of plan.deletes ?? []) await rm(path.join(base, relPath), { force: true });
  for (const [relPath, bytes] of plan.writes ?? []) await writeFileDeep(path.join(base, relPath), bytes);
  const payloadBytes = plan.changed ? encodeJson(plan.payload) : previous.payloadBytes;
  const envelope = signEnvelope(payloadBytes, signing.privateKey, KEY_ID);
  await writeFileDeep(path.join(out, manifestPath(config.id)), encodeJson(envelope));
}

async function publish(options) {
  const out = options.out;
  const configs = await loadConfigs(options.sources);
  const allow = await loadAllow(options.allow);
  const signing = await loadSigning({ dryRun: options['dry-run'], keysDir: options.keys });
  if (options['dry-run']) log('dry run: signing with a throwaway key; nothing remote is changed');

  const prepared = [];
  for (const config of configs) prepared.push(await prepareList(config, { options, allow, out }));

  const blocked = prepared.some((p) => p.guard.failures.length > 0);
  for (const { config, resolution } of prepared) {
    if (resolution) await saveCache(options, config.id, blocked ? resolution.cache : resolution.prunedCache);
  }
  if (blocked) {
    if (options.report) await writeFileDeep(options.report, guardReport(prepared, options.force));
    throw new GuardAbort('A guard aborted the run. Nothing was written.');
  }

  for (const item of prepared) {
    await writeRelease(item, { out, signing });
    log(
      item.plan.changed
        ? `${item.config.id}: wrote v${item.plan.version}, deleted ${item.plan.deletes.length} pruned files`
        : `${item.config.id}: unchanged at v${item.plan.version}`,
    );
  }
  await writeFileDeep(path.join(out, INDEX_PATH), encodeJson(makeIndex(configs)));
  await cp(options.static, out, { recursive: true, force: true });

  for (const item of prepared) {
    const result = await verifyTree({ read: localReader(out), listId: item.config.id, publicKeys: signing.publicKeys, expectVersion: item.plan.version });
    if (!result.ok) throw new Error(`Self-check failed for ${item.config.id}:\n  ${result.errors.join('\n  ')}`);
    log(`${item.config.id}: self-check passed for v${item.plan.version} (${JSON.stringify(result.payload.counts)})`);
  }

  const changed = prepared.filter((p) => p.plan.changed);
  const summary = {
    dry_run: options['dry-run'],
    changed: changed.length > 0,
    commit_message:
      changed.length > 0
        ? changed.map((p) => describeVersion(p.config.id, p.plan.version, p.plan.changes, p.acquired)).join('; ')
        : 'data(site): update site files without a new list version',
    lists: prepared.map(({ config, acquired, plan }) => ({
      id: config.id,
      version: plan.version,
      changed: plan.changed,
      source_commit: acquired[0].commit,
      source_commits: Object.fromEntries(acquired.map(({ input, commit }) => [input.repo, commit])),
      changes: summarizeDiff(plan.changes),
    })),
  };
  if (signing.throwawayPublicKeyPem) summary.public_key_pem = signing.throwawayPublicKeyPem;
  if (options.summary) await writeFileDeep(options.summary, `${JSON.stringify(summary, null, 2)}\n`);
  log(summary.changed ? summary.commit_message : 'no list changed');
}

// ---------------------------------------------------------------- smoke test

/** One pass of the live checks. Returns a list of errors. */
async function smokeOnce(baseUrl, out, configs, publicKeys) {
  const errors = [];
  for (const config of configs) {
    const { read, responses } = createHttpReader(baseUrl);
    try {
      const local = await readOptional(path.join(out, manifestPath(config.id)));
      if (local === null) {
        errors.push(`${config.id}: no local manifest in ${out} to compare with`);
        continue;
      }
      const expectVersion = readEnvelopeUnverified(JSON.parse(local.toString('utf8'))).payload.version;
      const result = await verifyTree({ read, listId: config.id, publicKeys, expectVersion });
      errors.push(...result.errors);
      const missingPath = `${listDir(config.id)}/${deltaRelPath(0)}`;
      await read(missingPath);
      errors.push(...checkLiveHeaders(responses, { missingPath }));
      if (result.ok) log(`${config.id}: live v${expectVersion} verified`);
    } catch (error) {
      errors.push(`${config.id}: ${error.message}`);
    }
  }
  return errors;
}

async function smoke(options) {
  const configs = await loadConfigs(options.sources);
  const publicKeys = await loadPublicKeys(options.keys);
  for (let attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt += 1) {
    const errors = await smokeOnce(options.smoke, options.out, configs, publicKeys);
    if (errors.length === 0) {
      log(`smoke test passed on attempt ${attempt}`);
      return;
    }
    log(`smoke test attempt ${attempt}/${SMOKE_ATTEMPTS} failed:\n  ${errors.join('\n  ')}`);
    if (attempt < SMOKE_ATTEMPTS) await sleep(SMOKE_DELAY_MS);
  }
  throw new Error('Smoke test failed');
}

// ---------------------------------------------------------------- entry

export async function main(argv) {
  const { values: options } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true, allowPositionals: false });
  if (options.help) {
    log(USAGE);
    return;
  }
  if (options.smoke) await smoke(options);
  else await publish(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof GuardAbort ? error.message : error.stack ?? String(error));
    process.exitCode = 1;
  });
}
