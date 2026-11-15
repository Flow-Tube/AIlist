# Flow channel lists

A static, signed, versioned mirror of the [AiSList](https://aisloplist.com) channel lists for
Flow for Android and Flow Desktop. There is no server: a daily GitHub Action builds JSON files
and Cloudflare Pages serves them at `https://ailist.flow-tube.org`.

- Base URL: `https://ailist.flow-tube.org/v1/`
- Lists: `aislist` (block and warn lists of YouTube channels that mainly publish AI-generated content)
- Integrity: an Ed25519-signed manifest covers every published file through SHA-256 hashes
- Updates: immutable snapshots plus small daily deltas

## Attribution and licence

The `aislist` data comes from [AiSList](https://aisloplist.com)
([Override92/AiSList](https://github.com/Override92/AiSList)) and is licensed under
[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The mirror credits AiSList in
the manifest's `source` field, on the site's start page, in this README, and in the apps'
attribution row. The data must not be used commercially.

The code in this repository is licensed under the GNU General Public License v3.0 (see `LICENSE`).

## Published files

Every list lives under `/v1/<list-id>/`. All files are minified UTF-8 JSON with no BOM;
non-ASCII characters are written raw.

| Path | Changes? | Purpose |
| --- | --- | --- |
| `/v1/index.json` | Yes | Unsigned, informational catalogue of available lists |
| `/v1/aislist/manifest.json` | Once per new version | Signed envelope; the only file clients poll |
| `/v1/aislist/snapshot/<version>.json` | Never | The full list at that version (newest 3 kept) |
| `/v1/aislist/delta/<version>.json` | Never | Changes from `version - 1` to `version` (newest 30 kept) |

`version` is an integer starting at 1. It goes up by exactly 1 only when the list content
changes; a run with no change publishes no new version.

### manifest.json

```json
{
  "key_id": "2026-11",
  "payload": "<standard base64, with padding, of the payload JSON bytes>",
  "sig": "<standard base64 of the 64-byte Ed25519 signature over those exact payload bytes>"
}
```

The signature covers the decoded payload bytes as they are. Verify first, parse second; no
canonical JSON is needed. Decoded payload:

```json
{
  "schema": 1,
  "list": "aislist",
  "version": 42,
  "generated_at": "2026-11-13T03:17:00Z",
  "snapshot": { "path": "snapshot/42.json", "sha256": "<hex>", "bytes": 1094967 },
  "deltas": [
    { "to": 42, "path": "delta/42.json", "sha256": "<hex>", "bytes": 35313 },
    { "to": 41, "path": "delta/41.json", "sha256": "<hex>", "bytes": 20110 }
  ],
  "max_delta_chain": 14,
  "counts": { "block_handles": 60212, "block_ids": 0, "warn_handles": 1262, "warn_ids": 0 },
  "source": {
    "name": "AiSList",
    "homepage": "https://aisloplist.com",
    "repo": "https://github.com/Override92/AiSList",
    "commit": "<full source commit sha>",
    "license": "CC BY-NC 4.0"
  }
}
```

- `path` values are relative to the manifest's folder.
- `sha256` is over the file's raw (uncompressed) bytes, lowercase hex.
- `deltas` lists every delta still hosted, newest first. Version 1 has no delta.
- `max_delta_chain` is the most deltas a client should chain before taking the snapshot instead.
- `list` is inside the signed payload, so a manifest for one list cannot be served in place of another.

### snapshot/&lt;version&gt;.json

```json
{
  "schema": 1,
  "list": "aislist",
  "version": 42,
  "block": { "handles": ["somechannel", "another-one"], "ids": [] },
  "warn":  { "handles": ["maybechannel"], "ids": [] }
}
```

- `handles` are normalized (see below), stored without the `@`, deduplicated, sorted.
- `ids` are channel IDs matching `^UC[A-Za-z0-9_-]{22}$`, deduplicated, sorted. They hold the
  IDs the source lists directly plus the channel ID of every listed handle the pipeline has
  resolved (see [Channel IDs](#channel-ids)). A handle and its ID are both published, in the
  same list.
- An entry in `block` never also appears in `warn`.

### delta/&lt;version&gt;.json

```json
{
  "schema": 1,
  "list": "aislist",
  "from": 41,
  "to": 42,
  "block": { "handles": { "add": [], "remove": [] }, "ids": { "add": [], "remove": [] } },
  "warn":  { "handles": { "add": [], "remove": [] }, "ids": { "add": [], "remove": [] } }
}
```

Apply removes first, then adds, as plain set operations. Removing an absent entry or adding a
present one is a no-op, so applying a delta twice is harmless. A channel moving from warn to
block shows up as a `warn` remove and a `block` add.

### index.json

```json
{
  "schema": 1,
  "lists": [
    {
      "id": "aislist",
      "name": "AiSList",
      "description": "Community list of YouTube channels that mainly publish AI-generated content",
      "manifest": "aislist/manifest.json",
      "homepage": "https://aisloplist.com",
      "license": "CC BY-NC 4.0"
    }
  ]
}
```

### Compatibility rules

- Clients ignore unknown fields. New optional fields can be added inside `/v1/` at any time.
- Any change an existing client could misread (renamed field, changed meaning) goes to `/v2/`,
  and `/v1/` keeps being published until old app versions have aged out.
- A client that sees `schema` greater than it understands keeps its current list and does nothing else.

## Client contract

Both apps follow these rules. `test/reference-client.js` implements them and the end-to-end
test runs it against real pipeline output.

### When to fetch

- Only while the user has the filter turned on. No requests at all while it is off.
- Once immediately when the filter is turned on, then about once every 24 hours, at a time
  randomized per device so clients do not all arrive together.
- Requests carry no identifiers, no query parameters, and a generic `User-Agent` such as
  `Flow/<app version>`.

### Update procedure

1. `GET /v1/aislist/manifest.json` with `If-None-Match` from the last response. On `304`, stop.
2. Verify the envelope signature (see Signature check). On failure, stop.
3. Parse the payload. Stop if `schema` is greater than 1, if `list` is not `aislist`, or if
   `version` is lower than the stored version. If `version` equals the stored version, stop.
4. Choose the path:
   - **Deltas** when a list is stored, `version - stored` is at most `max_delta_chain`, and
     `deltas` contains every step from `stored + 1` to `version`.
   - **Snapshot** in every other case, including the first run.
5. Download each needed file and compare its SHA-256 with the manifest before using it. A
   mismatch aborts the whole update.
6. Build the new sets in memory (for deltas: removes first, then adds, in version order), write
   them with the new version to a temporary file, then rename it over the stored file. Swap the
   in-memory sets only after the rename succeeds.
7. If a delta download returns 404 or fails its hash, fall back to the snapshot once in the same run.

**Failure rule.** Any failure (network, signature, hash, parse) leaves the stored list exactly
as it was and waits for the next scheduled run with normal backoff. A failed update never clears
the list.

### Signature check

Base64-decode `payload` and `sig`, pick the trusted public key by `key_id`, verify the Ed25519
signature over the decoded payload bytes, and only then parse the payload. An unknown `key_id`
or a failed verification means: keep the current list, do nothing else.

- Rollback: refuse a manifest whose `version` is lower than the stored one.
- Cross-list swaps: check that `list` matches the list you asked for.
- Key rotation: apps hold a small map of `key_id` to public key. A new public key ships in an
  app release first; the pipeline switches `key_id` once that release is widespread. Old app
  versions that do not know the new key keep their last good list.

### Storage

- Keep your own copy: version, `ETag`, and the four sets. The delta path needs the previous
  list, so the HTTP cache alone is not enough.
- Use one plain file in app-private storage.
- Keep the list out of sync and out of backups. It is re-downloadable and has nothing to do with
  the user's own blocked channels.

### Matching

- A channel is listed when its normalized handle is in `handles` or its channel ID is in `ids`.
  Check both: many screens (YouTube Music in particular) show a channel ID but no handle.
- `block` and `warn` are separate sets with separate user switches.
- An item with neither a handle nor a listed ID is not filtered.
- Matching is exact string equality against a hash set. Never use prefix or substring matching:
  a listed `@drew` must not hide `@drewbinsky`.
- Show an attribution row linking to aisloplist.com with the licence name, as CC BY-NC requires.

## Handle normalization

The pipeline and both apps must produce the same string for the same channel, or nothing
matches. These steps run in this order everywhere:

1. Trim surrounding whitespace.
2. Extract the handle. If the input contains `/@` or starts with `@`, take the text after the
   `@` up to the next `/`, `?` or `#`. This turns `/@LinusTechTips/shorts` into `LinusTechTips`.
   Otherwise keep the text as it is.
3. Percent-decode as UTF-8. If decoding fails, keep the text unchanged.
4. Apply Unicode NFC.
5. Lowercase with locale-independent rules: `toLowerCase()` in JS, `lowercase(Locale.ROOT)` in
   Kotlin, `to_lowercase()` in Rust.
6. Reject the result if it is empty, longer than 64 characters, or contains whitespace, `/`,
   `%`, `?`, `#` or `@`.

Two details of step 6, so all three codebases agree exactly:

- **Length** is counted in Unicode code points: `[...s].length` in JS,
  `s.codePointCount(0, s.length)` in Kotlin, `s.chars().count()` in Rust. Not UTF-16 units, not bytes.
- **Whitespace** is the JS `\s` class: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to
  U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF.

### Test vectors

These live in `test/fixtures/normalize-vectors.json` (`null` = rejected). Use that file as a
shared fixture in all three codebases.

| Input | Normalized |
| --- | --- |
| `@DPCartoon%C3%80i-v6k` | `dpcartoonài-v6k` |
| `@HFY_en_Español` | `hfy_en_español` |
| `@소소한작업실-z8d` | `소소한작업실-z8d` |
| `@ELTÍOFRONTAL` | `eltíofrontal` |
| `/@LinusTechTips/shorts` | `linustechtips` |
| `@M%C3%BAsicaB%C3%ADblicaInstrumental` | `músicabíblicainstrumental` |
| ` @Some.Channel_1 ` | `some.channel_1` |
| `@Aiomo%E3%81%82%E3%81%84%E3%81%8A%E3%82%82` | `aiomoあいおも` |
| `@Bad%ZZname` | rejected (still contains `%`) |

## How the pipeline works

`publish.yml` runs daily at 03:17 UTC and on manual dispatch. Each run:

1. Checks out `main` and the `data` branch (the published tree) into `site/`.
2. Pins AiSList to its current commit and downloads both list files from that commit.
3. Parses, normalizes and deduplicates; looks up channel IDs for listed handles within the daily
   budget (see [Channel IDs](#channel-ids)); removes `overrides/allow.txt` entries from both
   lists; removes anything in `block` from `warn`.
4. Runs the guards from `sources/aislist.json`: minimum block size, reject ratio, `Total Channels`
   header mismatch, and (against the previous snapshot) maximum shrink and growth.
5. If the lists changed, writes a new snapshot and delta and prunes old ones.
6. Signs the manifest, regenerates `index.json`, copies `static/`, and self-checks the whole tree.
7. Commits the lookup cache to `resolve-cache` (even when a guard stopped the run), commits
   `site/` to `data` when it changed, deploys it to Cloudflare Pages, and smoke-tests the live
   site (signature, hashes, headers, and a real 404 for a missing path).

**When a guard aborts**, the run fails, the live list stays at the last good version, and an
issue labelled `publish-blocked` is opened (or commented on) with the numbers. After a human
look, re-run `publish.yml` with `force: true`, which skips only the shrink and growth guards.

### Channel IDs

A source that has a `resolve` block in its config gets the channel ID of each listed handle
from YouTube's public `navigation/resolve_url` endpoint. Lookups are cached in
`cache/<list-id>.tsv` on the `resolve-cache` branch (`handle`, `channel ID or -`, `last checked`),
so each handle costs one request and then a recheck:

- Each run looks up at most `daily_budget` handles: handles new since the last version first,
  then handles never looked up, then cached entries due a recheck, oldest first.
- A found ID is rechecked after `recheck_found_days`, so a handle that moved to another channel
  is corrected; a handle with no channel is retried after `recheck_missing_days`.
- Lookups stop at `max_minutes`, or at once on a 429, and the run publishes what it has.
  A failed lookup is not cached and is retried next run.
- The cache keeps only handles still listed. When a guard stops the run, it is saved unpruned,
  so a bad source never costs the lookups already made.
- An allow-listed handle is never looked up, and its ID is never published.
- The growth guard leaves out looked-up IDs that are new since the last version, since the
  budget already bounds them; growth from the source itself is still checked.

Losing the cache branch drops the resolved IDs on the next run, which the shrink guard stops.
Restore the branch rather than forcing the run.

**False positives** go in `overrides/allow.txt`, one `@handle` or channel ID per line, through a
pull request. They are removed from both lists on the next run.

## Working on the code

Requires Node 22 or newer. There are no dependencies to install.

```sh
node --test                                  # unit and end-to-end tests, no network
node src/publish.js --dry-run --out ./out --resolve-budget 0   # real source, throwaway key, no ID lookups
node src/publish.js --help                   # all options
```

A dry run downloads the real source, builds and self-checks the tree in `./out`, and touches
nothing remote. Without `--resolve-budget 0` it also looks up channel IDs against YouTube and
writes the cache to `./cache`. Run it again on the same folder to see the unchanged or delta path.

| Path | Responsibility |
| --- | --- |
| `src/fetch.js` | Download a source at a pinned commit; read the live site |
| `src/parse.js` | Source text formats to raw entries, chosen by the config's `format` |
| `src/normalize.js` | The handle rules above |
| `src/guards.js` | Size and change-rate checks |
| `src/build.js` | Lists, snapshot, delta, pruning, manifest payload, index |
| `src/resolve-cache.js` | Lookup cache format, lookup planning and merging |
| `src/resolve.js` | Handle to channel ID lookups against YouTube, with a budget and a stop on 429 |
| `src/sign.js` | Ed25519 envelope sign and verify |
| `src/verify-tree.js` | Self-check of a built tree, also used for the live smoke test |
| `src/publish.js` | Entry point; runs the steps in order and owns all file access |
| `src/constants.js` | Schema version, retention counts, key id and tree paths |
| `sources/<id>.json` | Everything source-specific: URLs, files, format, licence, guard thresholds |
| `overrides/allow.txt` | Handles or IDs never published |
| `keys/<key_id>.pub.pem` | Public signing keys |
| `static/` | `_headers`, `index.html` and `404.html`, copied into the tree on every run |

A second source list is one new `sources/<id>.json` plus, if its format differs, one new
parser in `src/parse.js`.
