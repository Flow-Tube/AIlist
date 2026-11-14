## Summary

<!-- Explain what changed and why. -->

<!-- The PR title becomes the squash commit on main. It must be one line: type(scope): short description -->

## Related issue

<!-- Use "Closes #123" when this PR should close an issue. -->

## Change type

- [ ] Bug fix
- [ ] Feature
- [ ] False-positive entry in `overrides/allow.txt`
- [ ] Source config or guard thresholds
- [ ] Published format or client contract
- [ ] Workflow or CI
- [ ] Documentation or site

## Validation

<!-- List the checks you ran. Mark checks that do not apply instead of claiming they passed. -->

- [ ] `node --test`
- [ ] `node src/publish.js --dry-run --out ./out` against the real source, run twice on the same folder

## Checklist

- [ ] Each new `overrides/allow.txt` entry has a short reason comment above it and links the issue.
- [ ] Changes to the published files follow "Compatibility rules" in the README, and the README matches the new behavior.
- [ ] No private keys, tokens or other secrets are added, printed or logged.
- [ ] Pinned action SHAs and the Wrangler version are only changed on purpose.
