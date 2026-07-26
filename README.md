<p align="center">
  <img src="./desktop/src-tauri/icons/spaces-icon-source.png" alt="Spaces app icon" width="136" />
</p>

<h1 align="center">Spaces</h1>

<p align="center">
  Work together. Run agents. Keep context.
</p>

![Spaces — a local-first operating system for people and AI agents](./portal/public/og.png)

Spaces is a local-first operating system for people and AI agents. It brings
projects, channels, tasks, knowledge, coding workspaces, mail, calendars,
content operations, and configurable Claude Code/Codex agents into one
workspace without moving repositories or agent credentials off the computer
that owns them.

This repository contains the complete source for:

- `desktop/` — the Tauri application that owns local files, terminals,
  embedded browser sessions, Git worktrees, agent processes, transcripts, and
  the local SQLite database.
- `portal/` — the Cloudflare/Sites control plane for ChatGPT-authenticated
  identity, membership, invitations, device pairing, shared workspace state,
  OAuth integrations, and durable cross-device agent jobs.

Spaces is an alpha. The source is usable and continuously checked, but provider
features still depend on OAuth app review, API access, and your own deployment
configuration. Read the [public feature inventory](docs/OPEN_SOURCE_INVENTORY.md)
before relying on a surface in production.

## Principles

- Local execution stays local. Repositories, terminal streams, full prompts,
  browser history, agent sessions, and local credentials are not uploaded by
  ordinary sync.
- Shared state is explicit. The portal stores identity, membership, shared
  content, connected-account metadata, and the bounded data needed for an
  explicitly requested cross-device run.
- Agents are members with an audit trail. Spaces exposes workspace operations
  through its own MCP server and approval queue instead of assuming every
  harness has the same third-party connectors.
- Deployment identity is yours. The public source contains no production
  workspace, OAuth secrets, updater key, Apple signing identity, or private
  hosting project.

## Quick start

Prerequisites:

- macOS 13 or newer
- Node.js 22
- Rust stable
- at least one supported agent runtime: `claude` or `codex`
- `gh` for GitHub-backed project surfaces

Run the desktop:

```bash
cd desktop
cp .env.example .env.local
npm ci
npm run tauri dev
```

Run the portal locally in another terminal:

```bash
cd portal
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

The portal is optional for local-only work. It is required for teammate
identity, shared state across devices, connected cloud accounts, and remote
agent jobs. Pair it from Spaces desktop after creating the first local
workspace.

Official macOS builds use the same source in `desktop/`, the Spaces bundle
identity, and the Spaces updater channel. Deployment-specific workspace URLs
are injected at build time and are never committed to this repository.

## Documentation

- [Public feature inventory](docs/OPEN_SOURCE_INVENTORY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Self-hosting](docs/SELF_HOSTING.md)
- [Configuration](docs/CONFIGURATION.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party license inventory](THIRD_PARTY_NOTICES.md)

The generated `.hq/` folder inside a linked project remains the on-disk
coordination protocol for compatibility. It contains human-readable project
context, the agent action queue, and the per-project Spaces MCP server.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
