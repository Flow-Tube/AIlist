import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCache, serializeCache, pruneCache, planLookups, mergeResults, cachedIds } from '../src/resolve-cache.js';
import { resolveHandle, runLookups, RateLimited } from '../src/resolve.js';

const ID_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const RECHECK = { recheckFoundDays: 90, recheckMissingDays: 30 };

test('cache text round-trips, sorted, with misses as -', () => {
  const cache = new Map([
    ['zeta', { id: null, checked: '2026-11-01' }],
    ['alpha', { id: ID_A, checked: '2026-11-02' }],
  ]);
  const text = serializeCache(cache, 'header');
  assert.equal(text, `# header\nalpha\t${ID_A}\t2026-11-02\nzeta\t-\t2026-11-01\n`);
  assert.deepEqual(parseCache(text), new Map([...cache].sort()));
  assert.deepEqual(parseCache(undefined), new Map());
});

test('a malformed cache line throws instead of being skipped', () => {
  assert.throws(() => parseCache(`alpha\tUCshort\t2026-11-01\n`), /line 1/);
  assert.throws(() => parseCache(`alpha\t${ID_A}\n`), /line 1/);
  assert.throws(() => parseCache(`alpha\t${ID_A}\t11/01/2026\n`), /line 1/);
});

test('lookups take new keys first, then the backlog, then rechecks, within the budget', () => {
  const cache = new Map([
    ['found-old', { id: ID_A, checked: '2026-07-01' }],
    ['found-new', { id: ID_B, checked: '2026-11-01' }],
    ['miss-old', { id: null, checked: '2026-10-01' }],
    ['miss-new', { id: null, checked: '2026-11-10' }],
  ]);
  const keys = ['backlog-b', 'backlog-a', 'fresh', 'found-old', 'found-new', 'miss-old', 'miss-new'];
  const base = { keys, priority: ['fresh', 'unlisted'], cache, today: '2026-11-15', ...RECHECK };
  assert.deepEqual(planLookups({ ...base, budget: 10 }), ['fresh', 'backlog-a', 'backlog-b', 'found-old', 'miss-old']);
  assert.deepEqual(planLookups({ ...base, budget: 2 }), ['fresh', 'backlog-a']);
  assert.deepEqual(planLookups({ ...base, budget: 0 }), []);
});

test('merge keeps failed keys, prune drops unlisted ones, cachedIds skips misses', () => {
  const cache = new Map([
    ['kept', { id: ID_A, checked: '2026-10-01' }],
    ['gone', { id: ID_B, checked: '2026-10-01' }],
  ]);
  const merged = mergeResults(cache, new Map([['new', { id: null }], ['kept', { id: ID_B }]]), '2026-11-15');
  assert.deepEqual(merged.get('kept'), { id: ID_B, checked: '2026-11-15' });
  assert.deepEqual(merged.get('new'), { id: null, checked: '2026-11-15' });
  assert.equal(cache.get('kept').id, ID_A, 'the input cache is not changed');
  const pruned = pruneCache(merged, ['kept', 'new']);
  assert.deepEqual([...pruned.keys()].sort(), ['kept', 'new']);
  assert.deepEqual(cachedIds(pruned, ['kept', 'new', 'unknown']), new Set([ID_B]));
});

const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('resolveHandle reads the browse id, treats 404 as a miss, and throws on other errors', async () => {
  let sent;
  const found = async (url, init) => {
    sent = JSON.parse(init.body);
    return jsonResponse(200, { endpoint: { browseEndpoint: { browseId: ID_A } } });
  };
  assert.deepEqual(await resolveHandle('músicabíblica', { fetchImpl: found }), { id: ID_A });
  assert.equal(sent.url, 'https://www.youtube.com/@m%C3%BAsicab%C3%ADblica');
  assert.deepEqual(await resolveHandle('gone', { fetchImpl: async () => jsonResponse(404, null) }), { id: null });
  const notAChannel = async () => jsonResponse(200, { endpoint: { browseEndpoint: { browseId: 'FEwhat_to_watch' } } });
  assert.deepEqual(await resolveHandle('odd', { fetchImpl: notAChannel }), { id: null });
  await assert.rejects(resolveHandle('x', { fetchImpl: async () => jsonResponse(500, null) }), /answered 500/);
  await assert.rejects(resolveHandle('x', { fetchImpl: async () => jsonResponse(429, null) }), RateLimited);
});

test('runLookups counts failures and stops starting lookups after a rate limit', async () => {
  const seen = [];
  const lookup = async (key) => {
    seen.push(key);
    if (key === 'bad') throw new Error('boom');
    if (key === 'limit') throw new RateLimited('429');
    return { id: null };
  };
  const run = await runLookups(['a', 'bad', 'limit', 'never', 'never2'], lookup, { concurrency: 1, spacingMs: 0 });
  assert.deepEqual(seen, ['a', 'bad', 'limit']);
  assert.deepEqual([...run.results.keys()], ['a']);
  assert.equal(run.failed, 1);
  assert.equal(run.rateLimited, true);
});

test('runLookups stops at the deadline', async () => {
  let clock = 0;
  const run = await runLookups(['a', 'b', 'c'], async () => ({ id: null }), {
    concurrency: 1,
    spacingMs: 0,
    deadline: 2,
    now: () => clock++,
  });
  assert.equal(run.results.size, 2);
  assert.equal(run.timedOut, true);
});

test('artist rows come from artist results only, with their audience', async () => {
  const { artistRows, parseAudience } = await import('../src/resolve.js');
  const row = (id, name, subtitle, pageType = 'MUSIC_PAGE_TYPE_ARTIST') => ({
    musicResponsiveListItemRenderer: {
      navigationEndpoint: { browseEndpoint: { browseId: id, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType } } } },
      flexColumns: [name, subtitle].map((text) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text }] } } })),
    },
  });
  const json = { contents: [{ shelf: [row(ID_A, 'Alpha', 'Artist • 2.31K subscribers'), row(ID_B, 'Beta', 'Album', 'MUSIC_PAGE_TYPE_ALBUM')] }] };
  assert.deepEqual(artistRows(json), [{ id: ID_A, name: 'Alpha', audience: 2310 }]);
  assert.equal(parseAudience('Artist • 4.46M monthly audience'), 4_460_000);
  assert.equal(parseAudience('Artist • 1,204 subscribers'), 1204);
  assert.equal(parseAudience('Artist'), null);
});

test('pickArtist takes only a unique exact folded match under the audience ceiling', async () => {
  const { pickArtist, foldName } = await import('../src/resolve.js');
  const limit = { maxAudience: 500_000 };
  assert.equal(foldName('  The  Ｖelvet\tSundown '), 'the velvet sundown');
  assert.deepEqual(pickArtist('Velvet Sundown', [{ id: ID_A, name: 'velvet  sundown', audience: 24 }], limit), { id: ID_A, reason: 'found' });
  assert.deepEqual(pickArtist('Velvet Sundown', [{ id: ID_A, name: 'The Velvet Sundown', audience: 24 }], limit), { id: null, reason: 'none' });
  assert.deepEqual(
    pickArtist('Twin', [{ id: ID_A, name: 'Twin', audience: 1 }, { id: ID_B, name: 'twin', audience: 2 }], limit),
    { id: null, reason: 'ambiguous' },
  );
  assert.deepEqual(pickArtist('Star', [{ id: ID_A, name: 'Star', audience: 4_000_000 }], limit), { id: null, reason: 'too-popular' });
  assert.deepEqual(pickArtist('Same', [{ id: ID_A, name: 'Same', audience: 3 }, { id: ID_A, name: 'Same', audience: null }], limit), { id: ID_A, reason: 'found' });
});
