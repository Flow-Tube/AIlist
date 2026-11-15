// Size and change-rate checks that stop a bad source from being published.
// Thresholds come from the `guards` block of sources/<id>.json.

import { KINDS } from './constants.js';

const REQUIRED_LIMITS = Object.freeze([
  'min_block_entries',
  'max_shrink_ratio',
  'max_growth_ratio',
  'max_reject_ratio',
  'max_header_mismatch_ratio',
]);

/** Guards that `force` skips. All others always run. */
export const FORCEABLE_GUARDS = Object.freeze(['shrink', 'growth']);

/** Throw when a config's guard block is missing a threshold or holds a non-number. */
export function validateLimits(limits) {
  for (const key of REQUIRED_LIMITS) {
    if (typeof limits?.[key] !== 'number' || !Number.isFinite(limits[key]) || limits[key] < 0) {
      throw new Error(`guards.${key} must be a non-negative number`);
    }
  }
}

/**
 * Gather the numbers the guards need from the parse and normalize results of
 * each list kind. A rejected entry is either a line the parser did not
 * recognise or a handle that normalization rejected.
 */
export function measureSource(parsed, normalized) {
  const stats = { entryLines: 0, rejected: 0, headers: [] };
  for (const kind of KINDS) {
    stats.entryLines += parsed[kind].entryLines;
    stats.rejected += parsed[kind].rejected.length + normalized[kind].rejected.length;
    if (parsed[kind].declaredTotal !== null) {
      stats.headers.push({ kind, declared: parsed[kind].declaredTotal, parsed: parsed[kind].entryLines });
    }
  }
  return stats;
}

const percent = (ratio) => `${(ratio * 100).toFixed(2)}%`;

/**
 * Run every guard. Returns { failures, skipped }, where each failure is
 * { guard, message } and skipped names the guards that did not run.
 *
 * blockEntries:         block size (handles + ids) after overrides.
 * previousBlockEntries: block size of the previous snapshot, or null on the first run.
 * lookupGrowth:         ids from lookups that the previous version did not have. They are bounded
 *                       by the lookup budget, not by the source, so the growth guard leaves them out.
 * force:                skip only the shrink and growth guards.
 */
export function checkGuards({ limits, stats, blockEntries, previousBlockEntries, lookupGrowth = 0, force = false }) {
  validateLimits(limits);
  const failures = [];
  const skipped = [];
  const fail = (guard, message) => failures.push({ guard, message });

  if (blockEntries < limits.min_block_entries) {
    fail('min_block', `block has ${blockEntries} entries, fewer than the minimum of ${limits.min_block_entries}`);
  }

  if (stats.rejected > stats.entryLines * limits.max_reject_ratio) {
    const ratio = stats.entryLines === 0 ? 1 : stats.rejected / stats.entryLines;
    fail('reject', `${stats.rejected} of ${stats.entryLines} entry lines rejected (${percent(ratio)}), more than ${percent(limits.max_reject_ratio)}`);
  }

  for (const { kind, declared, parsed } of stats.headers) {
    if (Math.abs(parsed - declared) > declared * limits.max_header_mismatch_ratio) {
      fail('header', `${kind}: header says ${declared} channels but ${parsed} entry lines were parsed, off by more than ${percent(limits.max_header_mismatch_ratio)}`);
    }
  }

  if (previousBlockEntries === null) {
    skipped.push(...FORCEABLE_GUARDS.map((guard) => `${guard} (first run)`));
  } else if (force) {
    skipped.push(...FORCEABLE_GUARDS.map((guard) => `${guard} (forced)`));
  } else {
    const shrink = previousBlockEntries - blockEntries;
    if (shrink > previousBlockEntries * limits.max_shrink_ratio) {
      fail('shrink', `block shrank from ${previousBlockEntries} to ${blockEntries} (-${percent(shrink / previousBlockEntries)}), more than ${percent(limits.max_shrink_ratio)}`);
    }
    const growth = blockEntries - previousBlockEntries - lookupGrowth;
    if (growth > previousBlockEntries * limits.max_growth_ratio) {
      const fromLookups = lookupGrowth > 0 ? `, ${lookupGrowth} of them new lookups` : '';
      fail('growth', `block grew from ${previousBlockEntries} to ${blockEntries}${fromLookups} (+${percent(growth / previousBlockEntries)} from the source), more than ${percent(limits.max_growth_ratio)}`);
    }
  }

  return { failures, skipped };
}
