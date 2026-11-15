// Network edge for id resolution: turns a normalized handle into its YouTube
// channel id through YouTube's public `navigation/resolve_url` endpoint, and
// runs a batch of lookups with bounded concurrency, a deadline, and a full stop
// on the first rate-limit answer. Uses the built-in fetch only.

import { CHANNEL_ID_PATTERN } from './constants.js';

const RESOLVE_URL = 'https://www.youtube.com/youtubei/v1/navigation/resolve_url?prettyPrint=false';
const WEB_CLIENT = Object.freeze({ clientName: 'WEB', clientVersion: '2.20251113.00.00', hl: 'en', gl: 'US' });
const REQUEST_TIMEOUT_MS = 20_000;

/** Thrown when YouTube answers 429: the run stops looking up and keeps what it has. */
export class RateLimited extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST a JSON body and return { status, json }. */
async function postJson(fetchImpl, url, body, headers = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) throw new RateLimited(`${url} answered 429`);
  const json = response.ok ? await response.json() : null;
  return { status: response.status, json };
}

/**
 * Resolve one normalized handle. Returns { id } where id is a channel id, or
 * null when YouTube knows no channel by that handle (404 or no channel in the
 * answer). Throws on anything else, so a transient failure is retried next run
 * instead of being cached as a miss.
 */
export async function resolveHandle(handle, { fetchImpl = fetch } = {}) {
  const url = `https://www.youtube.com/@${encodeURIComponent(handle)}`;
  const { status, json } = await postJson(fetchImpl, RESOLVE_URL, { context: { client: WEB_CLIENT }, url });
  if (status === 404) return { id: null };
  if (status !== 200) throw new Error(`resolve_url for @${handle} answered ${status}`);
  const browseId = json?.endpoint?.browseEndpoint?.browseId;
  return { id: CHANNEL_ID_PATTERN.test(browseId ?? '') ? browseId : null };
}

/**
 * Look up `keys` with `lookup(key)`, at most `concurrency` at a time, each
 * worker pausing `spacingMs` between requests. Stops starting new lookups at
 * `deadline` (epoch ms) or after the first RateLimited.
 *
 * Returns { results: Map<key, { id }>, failed, rateLimited, timedOut }.
 */
export async function runLookups(keys, lookup, { concurrency = 4, spacingMs = 150, deadline = Infinity, now = Date.now } = {}) {
  const results = new Map();
  let failed = 0;
  let rateLimited = false;
  let timedOut = false;
  let next = 0;

  async function worker() {
    while (next < keys.length && !rateLimited) {
      if (now() >= deadline) {
        timedOut = true;
        return;
      }
      const key = keys[next];
      next += 1;
      try {
        results.set(key, await lookup(key));
      } catch (error) {
        if (error instanceof RateLimited) rateLimited = true;
        else failed += 1;
      }
      if (spacingMs > 0) await sleep(spacingMs);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { results, failed, rateLimited, timedOut };
}

const MUSIC_SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
const WEB_REMIX_CLIENT = Object.freeze({ clientName: 'WEB_REMIX', clientVersion: '1.20251110.01.00', hl: 'en', gl: 'US' });
/** YouTube Music's "Artists" search filter. */
const ARTISTS_FILTER = 'EgWKAQIgAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D';
const ARTIST_PAGE_TYPE = 'MUSIC_PAGE_TYPE_ARTIST';
const AUDIENCE_PATTERN = /([\d.,]+)\s*([KMB]?)\s+(?:subscribers?|monthly audience)/i;
const MULTIPLIERS = Object.freeze({ '': 1, K: 1e3, M: 1e6, B: 1e9 });

/** Name folding for the exact-match rule: NFKC, lowercase, trimmed, inner whitespace collapsed. */
export const foldName = (name) => String(name).normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

/** "Artist • 2.31K subscribers" -> 2310; null when the subtitle shows no audience. */
export function parseAudience(subtitle) {
  const match = AUDIENCE_PATTERN.exec(subtitle ?? '');
  if (!match) return null;
  return Math.round(Number(match[1].replace(/,/g, '')) * MULTIPLIERS[match[2].toUpperCase()]);
}

const runsText = (column) => (column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []).map((r) => r.text ?? '').join('');

/** Every artist row in a YouTube Music search answer: { id, name, audience }. */
export function artistRows(json) {
  const rows = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const item = node.musicResponsiveListItemRenderer;
    if (item) {
      const browse = item.navigationEndpoint?.browseEndpoint;
      const pageType = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      if (pageType === ARTIST_PAGE_TYPE && CHANNEL_ID_PATTERN.test(browse.browseId ?? '')) {
        rows.push({ id: browse.browseId, name: runsText(item.flexColumns?.[0]), audience: parseAudience(runsText(item.flexColumns?.[1])) });
      }
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(json);
  return rows;
}

/**
 * Pick the artist for a name: exactly one artist whose folded name equals the
 * folded query, and whose audience is at most `maxAudience`. Anything else is
 * no match, so a name shared by two artists, or a well-known artist who only
 * shares a name with a listed one, is never published.
 * Returns { id, reason } where reason is found, none, ambiguous or too-popular.
 */
export function pickArtist(name, rows, { maxAudience }) {
  const folded = foldName(name);
  const ids = [...new Set(rows.filter((row) => foldName(row.name) === folded).map((row) => row.id))];
  if (ids.length === 0) return { id: null, reason: 'none' };
  if (ids.length > 1) return { id: null, reason: 'ambiguous' };
  const audience = Math.max(...rows.filter((row) => row.id === ids[0]).map((row) => row.audience ?? 0));
  if (audience > maxAudience) return { id: null, reason: 'too-popular' };
  return { id: ids[0], reason: 'found' };
}

/** Look up a YouTube Music artist id by exact name. Same result and error contract as resolveHandle. */
export async function searchArtist(name, { maxAudience, fetchImpl = fetch } = {}) {
  const { status, json } = await postJson(
    fetchImpl,
    MUSIC_SEARCH_URL,
    { context: { client: WEB_REMIX_CLIENT }, query: name, params: decodeURIComponent(ARTISTS_FILTER) },
    { origin: 'https://music.youtube.com' },
  );
  if (status !== 200) throw new Error(`music search for ${JSON.stringify(name)} answered ${status}`);
  return pickArtist(name, artistRows(json), { maxAudience });
}
