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

const SIGNING_KEY_ENV = 'AILIST_SIGNING_KEY';
const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';
const SMOKE_ATTEMPTS = 5;
const SMOKE_DELAY_MS = 30_000;
const PLACEHOLDER_COMMIT = '0'.repeat(40);
const REQUIRED_CONFIG_FIELDS = ['id', 'name', 'description', 'homepage', 'repo', 'branch', 'files', 'format', 'license', 'guards'];

const CLI_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  out: { type: 'string', default: DEFAULT_PATHS.out },
  sources: { type: 'string', default: DEFAULT_PATHS.sources },
  allow: { type: 'string', default: DEFAULT_PATHS.allow },
  static: { type: 'string', default: DEFAULT_PATHS.static },
  keys: { type: 'string', default: DEFAULT_PATHS.keys },
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
    for (const field of REQUIRED_CONFIG_FIELDS) {
      if (config[field] === undefined) throw new Error(`${where}: missing "${field}"`);
    }
    if (`${config.id}.json` !== name) throw new Error(`${where}: id "${config.id}" does not match the file name`);
    for (const kind of KINDS) {
      if (typeof config.files[kind] !== 'string') throw new Error(`${where}: files.${kind} is missing`);
    }
    getParser(config.format);
    validateLimits(config.guards);
    configs.push(config);
  }
  return configs;
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

/** Step 2: the source texts and the commit they came from. */
async function acquireSource(config, options) {
  if (!options['source-dir']) return downloadSource(config, { token: process.env[GITHUB_TOKEN_ENV] });
  const texts = {};
  for (const kind of KINDS) texts[kind] = await readFile(path.join(options['source-dir'], config.files[kind]), 'utf8');
  return { commit: options['source-commit'], texts };
}

// ---------------------------------------------------------------- reporting

function describeVersion(listId, version, changes, commit) {
  const totals = summarizeDiff(changes);
  const parts = KINDS.map((kind) => `+${totals[kind].add} -${totals[kind].remove} ${kind}`);
  return `data(${listId}): v${version} (${parts.join(', ')}), source ${shortSha(commit)}`;
}

function guardReport(prepared, force) {
  const lines = [];
  for (const { config, commit, stats, guard, lists, previous } of prepared) {
    if (guard.failures.length === 0) continue;
    lines.push(`## ${config.name} (\`${config.id}\`)`, '');
    lines.push(`Source: ${config.repo} at \`${commit}\``, '');
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
  const { commit, texts } = await acquireSource(config, options);
  log(`${config.id}: source ${config.repo} at ${commit}`);

  const parse = getParser(config.format);
  const parsed = {};
  const normalized = {};
  for (const kind of KINDS) {
    parsed[kind] = parse(texts[kind]);
    normalized[kind] = normalizeEntries(parsed[kind]);
    const merged = parsed[kind].handles.length - normalized[kind].rejected.length - normalized[kind].handles.size;
    log(
      `${config.id}: ${kind} ${parsed[kind].entryLines} lines` +
        (parsed[kind].declaredTotal === null ? '' : ` (header ${parsed[kind].declaredTotal})`) +
        ` -> ${normalized[kind].handles.size} handles, ${normalized[kind].ids.size} ids,` +
        ` ${merged} duplicates merged, ${parsed[kind].rejected.length + normalized[kind].rejected.length} rejected`,
    );
  }

  const lists = assembleLists(normalized, allow);
  const previous = await readPrevious(out, config.id);
  const stats = measureSource(parsed, normalized);
  const guard = checkGuards({
    limits: config.guards,
    stats,
    blockEntries: kindSize(lists, 'block'),
    previousBlockEntries: previous ? kindSize(previous.lists, 'block') : null,
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
      commit,
      generatedAt: new Date(),
    });
  }
  return { config, commit, lists, previous, stats, guard, plan };
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

  if (prepared.some((p) => p.guard.failures.length > 0)) {
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
        ? changed.map((p) => describeVersion(p.config.id, p.plan.version, p.plan.changes, p.commit)).join('; ')
        : 'data(site): update site files without a new list version',
    lists: prepared.map(({ config, commit, plan }) => ({
      id: config.id,
      version: plan.version,
      changed: plan.changed,
      source_commit: commit,
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
