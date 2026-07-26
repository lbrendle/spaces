# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub’s private
vulnerability reporting flow for this repository. Include:

- the affected commit or release;
- reproduction steps;
- expected and actual behavior;
- the data or permission boundary involved;
- any suggested mitigation.

The maintainers will acknowledge a complete report as soon as practical,
coordinate a fix privately, and publish an advisory when users need to act.

## Supported version

Spaces is currently alpha. Security fixes target the latest commit and the most
recent published release. Older builds may require an upgrade rather than a
backport.

## Dependency audit note

The macOS release uses `tauri-plugin-sql` with only its SQLite feature. Cargo
still records optional SQLx MySQL packages in `Cargo.lock`, including `rsa`
`0.9.10` and RUSTSEC-2023-0071, even though
`cargo tree --target all -i rsa` shows that crate is unreachable from the
Spaces build. CI ignores that one lockfile-only advisory and fails on every
reachable vulnerability. The ignore must be removed if a MySQL feature is ever
enabled or the dependency graph changes.

## Security boundaries

- Desktop agent processes inherit the local user’s permissions.
- Pairing tokens are device credentials; protect and revoke them like passwords.
- OAuth tokens are encrypted in the portal database, but the deployment’s
  `INTEGRATION_TOKEN_KEY` must be protected separately.
- A connected provider account does not automatically become a native
  Claude/Codex connector. Agent access must go through a Spaces tool and its
  approval policy.
- Repositories, raw terminal streams, full transcripts, browser history, and
  local agent session credentials should not enter portal logs or D1.

See [the architecture](docs/ARCHITECTURE.md) for the complete trust split.
