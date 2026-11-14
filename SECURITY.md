# Security Policy

## Supported versions

Only the `main` branch and the files currently served from <https://ailist.flow-tube.org>
are supported. Older snapshots and deltas are removed once they leave the retention window.

## Reporting a vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Report privately through
[GitHub Security Advisories](https://github.com/Flow-Tube/AIlist/security/advisories/new).
If you cannot use that form, email <contact@flow-tube.org>.

In scope:

- Ways to get a client to accept a manifest, snapshot or delta that was not signed by a
  published key, or to accept a rollback or a list swap.
- Exposure of the signing key or the Cloudflare token, or a way to run code in the publish
  workflow with access to them.
- Problems in the served site or its headers.

Out of scope: which channels are on the lists. Report those to
[AiSList](https://github.com/Override92/AiSList) or with the "Channel wrongly listed" issue form.

Please include the affected URL, file or commit, the steps to reproduce, and the impact.
You will receive an acknowledgement within 48 hours. Please do not disclose the issue
publicly until a fix has shipped.

## Verifying published files

Every manifest is an Ed25519 envelope. The current signing key is:

| `key_id` | Public key (raw, base64) |
| --- | --- |
| `2026-11` | `xak9y4JaDG+UjKfl7cDwiaJs+7FjrOM+urMW1YfSuc0=` |

The same key is in [`keys/2026-11.pub.pem`](keys/2026-11.pub.pem). A manifest signed by any
other key is not an official Flow list. The full check is described under
[Signature check](README.md#signature-check) in the README.
