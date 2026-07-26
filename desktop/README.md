# Spaces desktop

The trusted local execution plane for Spaces. It owns repositories, Git
worktrees, agent processes, PTYs, embedded browser sessions, full transcripts,
Apple Calendar automation, and the local SQLite database.

## Run

```sh
cp .env.example .env.local
npm ci
npm run tauri dev
```

Build and test:

```sh
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Requires at least one of `claude` or `codex`. GitHub surfaces require an
authenticated `gh` CLI.

## Storage

Everything lives in SQLite at
`~/Library/Application Support/app.spaces.desktop/spaces.db`.
GitHub data is read live via the `gh` CLI (no tokens stored in the app).

The portal is optional. Without it, Spaces remains a complete local workspace
but cannot synchronize teammates, shared cloud accounts, or cross-device jobs.

See the root [public inventory](../docs/OPEN_SOURCE_INVENTORY.md) and
[architecture](../docs/ARCHITECTURE.md).
