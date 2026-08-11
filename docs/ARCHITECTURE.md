# Architecture

Spaces has a deliberate split between a trusted local execution plane and a
small shared control plane.

```text
┌──────────────────────────────┐
│ Spaces desktop              │
│ SQLite · repos · terminals  │
│ browser · Claude/Codex      │
└──────────────┬───────────────┘
               │ paired device token
               │ explicit shared state / jobs
┌──────────────▼───────────────┐
│ Spaces portal               │
│ ChatGPT identity · D1       │
│ membership · OAuth tokens   │
│ shared content · job leases │
└──────────────┬───────────────┘
               │ provider APIs
       GitHub · Google · Microsoft
       Instagram · TikTok
```

## Desktop

The React/Tauri app owns:

- the local SQLite database and numbered migrations;
- local project paths and Git operations;
- PTYs and persistent terminal panes;
- embedded WebViews;
- local agent processes and session continuity;
- raw process streams, transcripts, diffs, and worktrees;
- Apple Calendar automation;
- the generated `.hq/` project context and Spaces MCP server.

Themes are CSS custom properties generated from `desktop/src/themes.ts`.
Hardcoded stylesheet colors are treated as bugs because Spaces ships light and
dark IDE-derived themes.

## Portal

The portal is a Next.js-compatible application built with vinext for
Cloudflare. D1 stores workspace identity, membership, invitations, connected
account metadata/secrets, shared content, device state, and durable remote jobs.

Provider secrets are encrypted before storage using `INTEGRATION_TOKEN_KEY`.
The token encryption key itself is a deployment secret and is never committed.

## Agent action path

```text
channel event
    │
    ▼
durable router/queue ── one lane per (channel, agent)
    │
    ├─ versioned Spaces base contract
    ├─ explicit [Spaces Context] event envelope
    └─ current project/team/channel instructions
             │
             ▼
 Claude · Codex · Local HTTP · Custom CLI
             │
      MCP or local CLI fallback
             ▼
      one operation registry
```

Spaces keeps its native Claude Code and Codex CLI adapters so members can use
the account already authenticated on their Mac. The harness contract above is
runtime-neutral: it gives every adapter the same routing identity and tool
surface without requiring a provider API key or moving the session into the
portal.

The orchestrator persists inbound events in SQLite when a target is busy,
coalesces queued events in order, and maintains one resumable runtime session
per `(channel, agent)`. Fresh and resumed turns both receive an authoritative
event envelope with the current channel, trigger, reply destination, project
root, and working directory. The Rust process boundary mirrors those values as
`SPACES_*` environment variables for tools and child processes.

Spaces generates one MCP manifest from `desktop/src/hqops.ts`. Claude and Codex
discover the same tools through a dependency-free stdio server. The same server
can execute one structured CLI call with
`node "$SPACES_CLI" "$SPACES_PROJECT_ROOT" --call <tool> '<json>'`; runtimes
without either transport retain the `.hq/actions.jsonl` fallback. Calls append
an idempotent JSON line to that queue, and the desktop drains it into a local
audit log.

Operations marked `auto` apply immediately. Operations marked `propose` wait in
the visible approval queue. External publishing and shared-card deletion are
always `propose`.

Content Studio is one workspace data model rather than a UI-only queue. The
portal D1 row is canonical; each paired desktop maintains a mapped SQLite
mirror. Web edits and agent/desktop edits move through the same revision and
tombstone stream, so full briefs, copy, media references, review stage, account
selection, and publish results remain attached to one card across members.
Agent tools read and mutate those same mirrored rows, and a publishing proposal
prefers an existing `content:<id>` instead of inventing a second audit row.

Every spawned harness receives explicit run, agent, channel, project, trigger,
reply destination, runtime, project-root, context-directory, MCP/CLI, and local
database identity. On a paired agent host, read-only tools query the same local
SQLite mirrors used by the UI for channel history, documents, private mail,
calendars, Content Studio, social-account routing, and Git context. The
blackboard also emits permission-filtered workspace Knowledge, `CONTENT.md`,
and preserved folder paths as bounded fallbacks. Knowledge reads return stable
`knowledge:source:path` references.

Projects without a local checkout receive a private control directory in the
application data folder. This lets general/non-code channels expose Spaces
tools without inventing a repository or writing coordination files into an
unrelated directory.

## Remote jobs

A remote job is always assigned to the device that hosts the selected agent.
The portal uses expiring leases and heartbeats; the requester receives durable
status and a sanitized terminal result. The host does not upload its repository,
live terminal stream, full transcript, command line, or session identifier.
