# Contributing

Thanks for helping with the Flow channel lists.

## Where to report what

- **A channel that should be added or removed:** the lists come from
  [AiSList](https://github.com/Override92/AiSList), so open the request there. Flow picks up
  upstream changes on its next daily publish.
- **A channel Flow should exclude:** open the "Channel wrongly listed" issue form, or a pull
  request that adds the channel to `overrides/allow.txt` with a short reason comment above it.
- **A problem with the published files, signatures or the site:** open a bug report.
- **A security issue:** follow [SECURITY.md](SECURITY.md).
- **Filtering inside the apps:** use the [Flow](https://github.com/Flow-Tube/Flow) or
  [Flow Desktop](https://github.com/Flow-Tube/Flow-Desktop) repositories.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep the design: one responsibility per file (see the table in the README), network and
   file access only in `src/fetch.js` and `src/publish.js`, constants in `src/constants.js`,
   nothing source-specific outside `sources/`, and no runtime dependencies.
3. Run the checks below.
4. Open a pull request and fill in the template.

Pull requests are squash-merged, and the pull request title becomes the commit on `main`. The
title must be one line in the form `type(scope): short description`, for example
`fix(normalize): keep percent signs that do not start an escape`. Allowed types are `feat`,
`fix`, `docs`, `test`, `ci`, `chore`, `refactor`, `perf`, `build`, `style` and `revert`. A CI
check enforces this.

## Checks

Requires Node 22 or newer. There is nothing to install.

```sh
node --test
node src/publish.js --dry-run --out ./out
```

The dry run uses the real source and a throwaway signing key, and touches nothing remote.

## Changes to the published files

Read "Compatibility rules" in the README first. Clients ignore unknown fields, so new optional
fields can be added inside `/v1/`. Anything an existing client could misread goes to `/v2/`.
Update the README in the same pull request.

## Code of conduct

This project follows the
[Flow code of conduct](https://github.com/Flow-Tube/.github/blob/main/CODE_OF_CONDUCT.md).
