// Handle normalization. The same steps run in the pipeline and in both apps,
// in this order, so the same channel always produces the same string.

/** Longest accepted handle, counted in Unicode code points. */
export const MAX_HANDLE_LENGTH = 64;

/** Characters a normalized handle must not contain (JS `\s` whitespace, / % ? # @). */
const FORBIDDEN_CHARACTERS = /[\s/%?#@]/u;

/** Characters that end the handle part of a path or URL. */
const HANDLE_TERMINATORS = /[/?#]/;

/**
 * Step 2: if the text starts with `@` or contains `/@`, return the text after
 * that `@` up to the next `/`, `?` or `#`. Otherwise return the text unchanged.
 */
export function extractHandle(text) {
  let rest;
  if (text.startsWith('@')) {
    rest = text.slice(1);
  } else {
    const at = text.indexOf('/@');
    if (at === -1) return text;
    rest = text.slice(at + 2);
  }
  const end = rest.search(HANDLE_TERMINATORS);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Step 3: percent-decode as UTF-8, keeping the text unchanged if decoding fails. */
function percentDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Normalize one handle. Returns the normalized handle without `@`,
 * or null when the result is rejected.
 */
export function normalizeHandle(input) {
  const handle = percentDecode(extractHandle(String(input).trim()))
    .normalize('NFC')
    .toLowerCase();
  if (handle.length === 0) return null;
  if ([...handle].length > MAX_HANDLE_LENGTH) return null;
  if (FORBIDDEN_CHARACTERS.test(handle)) return null;
  return handle;
}

/**
 * Normalize the raw entries of one parsed list. Handles are normalized and
 * deduplicated; ids were validated by the parser and are only deduplicated.
 */
export function normalizeEntries({ handles, ids }) {
  const result = { handles: new Set(), ids: new Set(ids), rejected: [] };
  for (const raw of handles) {
    const handle = normalizeHandle(raw);
    if (handle === null) result.rejected.push(raw);
    else result.handles.add(handle);
  }
  return result;
}
