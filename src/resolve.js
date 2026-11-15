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
