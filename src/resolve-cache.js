// The lookup cache: which key (a normalized handle, or an upstream artist id)
// resolved to which YouTube id, and when it was last checked. Pure functions:
// text in, data out. The pipeline keeps the file on its own branch so each key
// costs one request, then a recheck every few weeks.
//
// File format, one entry per line, sorted by key:
//   <key>\t<id or ->\t<YYYY-MM-DD>
// `-` records a lookup that found nothing. Lines starting with `#` are comments.

import { CHANNEL_ID_PATTERN } from './constants.js';

const MISSING = '-';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` in UTC. */
export const isoDay = (date) => date.toISOString().slice(0, 10);

const daysBetween = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Parse cache text into a Map of key to { id: string | null, checked: 'YYYY-MM-DD' }. Bad lines throw. */
export function parseCache(text) {
  const cache = new Map();
  for (const [index, line] of (text ?? '').split('\n').entries()) {
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split('\t');
    const [key, id, checked] = fields;
    const valid =
      fields.length === 3 &&
      key !== '' &&
      (id === MISSING || CHANNEL_ID_PATTERN.test(id)) &&
      DATE_PATTERN.test(checked);
    if (!valid) throw new Error(`cache line ${index + 1} is malformed: ${JSON.stringify(line)}`);
    cache.set(key, { id: id === MISSING ? null : id, checked });
  }
  return cache;
}

/** Cache text with a header comment, entries sorted by key. */
export function serializeCache(cache, header) {
  const keys = [...cache.keys()].sort();
  const lines = keys.map((key) => {
    const { id, checked } = cache.get(key);
    return `${key}\t${id ?? MISSING}\t${checked}`;
  });
  return `${header ? `# ${header}\n` : ''}${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

/** A copy of the cache holding only the keys still listed, so it never grows past the lists. */
export function pruneCache(cache, keys) {
  const keep = new Set(keys);
  return new Map([...cache].filter(([key]) => keep.has(key)));
}

/**
 * Choose which keys to look up this run, at most `budget` of them, in this order:
 *   1. keys in `priority` (new on the source since the last version) not yet cached;
 *   2. every other key not yet cached, sorted;
 *   3. cached keys due a recheck, oldest check first.
 * A found id is rechecked after `recheckFoundDays`, so a handle that moved to
 * another channel is corrected; a miss is retried after `recheckMissingDays`.
 */
export function planLookups({ keys, priority = [], cache, today, budget, recheckFoundDays, recheckMissingDays }) {
  if (budget <= 0) return [];
  const listed = new Set(keys);
  const plan = [];
  const planned = new Set();
  const take = (key) => {
    if (plan.length >= budget || planned.has(key)) return;
    planned.add(key);
    plan.push(key);
  };

  for (const key of priority) if (listed.has(key) && !cache.has(key)) take(key);
  for (const key of [...listed].sort()) if (!cache.has(key)) take(key);

  const due = [...listed]
    .filter((key) => cache.has(key))
    .map((key) => ({ key, entry: cache.get(key) }))
    .filter(({ entry }) => daysBetween(entry.checked, today) >= (entry.id ? recheckFoundDays : recheckMissingDays))
    .sort((a, b) => a.entry.checked.localeCompare(b.entry.checked) || a.key.localeCompare(b.key));
  for (const { key } of due) take(key);

  return plan;
}

/**
 * Merge lookup results into a copy of the cache. `results` maps key to
 * { id: string | null }; keys whose lookup failed are simply absent and keep
 * their old entry.
 */
export function mergeResults(cache, results, today) {
  const merged = new Map(cache);
  for (const [key, { id }] of results) merged.set(key, { id, checked: today });
  return merged;
}

/** The ids the cache knows for `keys`, skipping misses and unknown keys. */
export function cachedIds(cache, keys) {
  const ids = new Set();
  for (const key of keys) {
    const id = cache.get(key)?.id;
    if (id) ids.add(id);
  }
  return ids;
}
