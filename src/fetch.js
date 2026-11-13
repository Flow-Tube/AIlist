// Network edge: pins a source to one commit and downloads its list files, and
// reads the live site for the smoke test. Uses the built-in fetch only.

import { GITHUB_API, GITHUB_RAW, COMMIT_SHA_PATTERN } from './constants.js';

const USER_AGENT = 'flow-ailist-publisher';
const DOWNLOAD_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for responses worth retrying: rate limits and server errors. */
const isRetryable = (status) => status === 408 || status === 429 || status >= 500;

/**
 * GET a URL, retrying network errors and retryable statuses up to
 * DOWNLOAD_RETRIES times with exponential backoff. Throws on final failure.
 */
export async function fetchWithRetry(url, { headers = {}, retries = DOWNLOAD_RETRIES, backoffMs = BACKOFF_BASE_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;
      lastError = new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
      if (!isRetryable(response.status)) break;
    } catch (error) {
      lastError = new Error(`GET ${url} failed: ${error.message}`);
    }
  }
  throw lastError;
}

/** Resolve a branch of a GitHub repo to its current full commit sha. */
export async function resolveCommit({ repo, branch, token }) {
  const headers = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(branch)}`, { headers });
  const { sha } = await response.json();
  if (!COMMIT_SHA_PATTERN.test(sha ?? '')) throw new Error(`GitHub returned no commit sha for ${repo}@${branch}`);
  return sha;
}

/**
 * Download every file of a source config from one pinned commit.
 * Returns { commit, texts: { [kind]: string } }.
 */
export async function downloadSource(config, { token } = {}) {
  const commit = await resolveCommit({ repo: config.repo, branch: config.branch, token });
  const texts = {};
  for (const [kind, filePath] of Object.entries(config.files)) {
    const response = await fetchWithRetry(`${GITHUB_RAW}/${config.repo}/${commit}/${filePath}`);
    texts[kind] = await response.text();
  }
  return { commit, texts };
}

/**
 * A reader over a live site for verify-tree. `read(treePath)` returns the body
 * as a Buffer, or null on 404; every response is recorded in `responses` with
 * its status and headers for the header checks.
 */
export function createHttpReader(baseUrl) {
  const responses = [];
  const root = baseUrl.replace(/\/+$/, '');
  async function read(treePath) {
    const response = await fetch(`${root}/${treePath}`, {
      headers: { 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    responses.push({ path: treePath, status: response.status, headers: response.headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${root}/${treePath} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return { read, responses };
}
