import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigs, loadAllow } from '../src/publish.js';
import { DEFAULT_PATHS } from '../src/constants.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the committed source configs load and validate', async () => {
  const configs = await loadConfigs(path.join(ROOT, DEFAULT_PATHS.sources));
  assert.deepEqual(configs.map((c) => c.id), ['aimusic', 'aislist']);
  const byId = Object.fromEntries(configs.map((c) => [c.id, c]));
  assert.equal(byId.aislist.license, 'CC BY-NC 4.0');
  assert.deepEqual(byId.aimusic.inputs.map((i) => i.license), ['CC BY 4.0', 'MIT']);
  assert.ok(byId.aimusic.inputs.every((i) => i.attribution), 'every compiled input carries its attribution');
});

test('a compiled list needs files.block on every input and a known lookup', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ailist-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const guards = { min_block_entries: 1, max_shrink_ratio: 0.1, max_growth_ratio: 0.1, max_reject_ratio: 0.1, max_header_mismatch_ratio: 0.1 };
  const input = { name: 'I', homepage: 'h', repo: 'o/r', branch: 'main', files: { block: 'a.json' }, format: 'soul-over-ai-json', license: 'l' };
  const base = { id: 'y', name: 'Y', description: 'd', homepage: 'h', license: 'l', guards };
  await writeFile(path.join(dir, 'y.json'), JSON.stringify({ ...base, inputs: [{ ...input, files: {} }] }));
  await assert.rejects(loadConfigs(dir), /inputs\[0\]: files\.block is missing/);
  const resolve = { lookup: 'artist-name', daily_budget: 1, recheck_found_days: 1, recheck_missing_days: 1, max_minutes: 1 };
  await writeFile(path.join(dir, 'y.json'), JSON.stringify({ ...base, inputs: [input], resolve }));
  await assert.rejects(loadConfigs(dir), /max_audience/);
  await writeFile(path.join(dir, 'y.json'), JSON.stringify({ ...base, inputs: [input], resolve: { ...resolve, lookup: 'guess' } }));
  await assert.rejects(loadConfigs(dir), /resolve\.lookup/);
});

test('the committed allow list parses with no invalid lines', async () => {
  const allow = await loadAllow(path.join(ROOT, DEFAULT_PATHS.allow));
  assert.ok(Array.isArray(allow.handles) && Array.isArray(allow.ids));
});

test('allow list entries are normalized and bad lines are refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ailist-allow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.txt');
  await writeFile(good, '# reason\n! note\n@Some%C3%80Name\nUCaaaaaaaaaaaaaaaaaaaaaa\n');
  assert.deepEqual(await loadAllow(good), { handles: ['someàname'], ids: ['UCaaaaaaaaaaaaaaaaaaaaaa'] });
  const bad = path.join(dir, 'bad.txt');
  await writeFile(bad, '@ok\nnot-a-handle\n');
  await assert.rejects(loadAllow(bad), /invalid entries: "not-a-handle"/);
});

test('a config with a missing threshold is refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ailist-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    id: 'x', name: 'X', description: 'd', homepage: 'h', repo: 'o/r', branch: 'main',
    files: { block: 'b.txt', warn: 'w.txt' }, format: 'aislist-txt', license: 'l',
    guards: { min_block_entries: 1, max_shrink_ratio: 0.1, max_growth_ratio: 0.1, max_reject_ratio: 0.1 },
  };
  await writeFile(path.join(dir, 'x.json'), JSON.stringify(config));
  await assert.rejects(loadConfigs(dir), /guards\.max_header_mismatch_ratio/);
});
