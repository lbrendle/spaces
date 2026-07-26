# Contributing

Thanks for helping make Spaces more useful and trustworthy.

## Before opening a change

- Search existing issues and discussions.
- Open an issue first for security-boundary changes, schema redesigns,
  provider integrations, or a new execution backend.
- Keep changes small enough to review. Explain the user-visible behavior and
  the local/cloud data boundary.

## Development

Desktop:

```bash
cd desktop
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Portal:

```bash
cd portal
npm ci
npm test
npx tsc --noEmit
npm run lint
```

## Project rules

- Every desktop schema change needs a numbered migration guarded by
  `PRAGMA user_version`.
- Stylesheet colors must come from theme tokens; do not add literal hex,
  `rgb()`, or `rgba()` colors.
- Never commit credentials, tokens, production workspace identifiers,
  personal data, or copied provider verification files.
- External writes need an explicit permission and approval story.
- Keep local execution local unless the feature documentation names the exact
  data that crosses the control plane.
- Add tests for authorization, account selection, migrations, and destructive
  operations.

## Pull requests

Include:

- what changed and why;
- screenshots for visible UI changes;
- the checks you ran;
- any migration or deployment steps;
- privacy/security effects;
- known limitations.

By submitting a contribution, you agree that it is licensed under the Apache
License 2.0, as described in the repository license.
