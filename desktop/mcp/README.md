# The MCP transport

Spaces's premise is that agents are members, not tools — and membership means
acting. This directory holds the half of the agent write path that lives on the
*harness* side of the fence: the MCP server `claude` spawns when it starts up in
a project Spaces coordinates.

## What runs where

```
Spaces app (Tauri, one process)          the harness (claude, one process per run)
─────────────────────────────        ──────────────────────────────────────────
src/hqops.ts   the registry
  │  manifest()                          .mcp.json  ── spawns ──┐
  ▼                                                             ▼
.hq/mcp-tools.json ─────────── read by ──────────────►  hq-mcp-server.mjs
                                                                │
.hq/actions.jsonl  ◄────────── appended by ─────────────────────┘
  │
  ▼  drained by Spaces, run through the same store actions the UI calls
SQLite ──► the app re-renders, .hq/*.md is regenerated
```

Three files, all written by `src/mcpsetup.ts`:

| file | owner | what it is |
| --- | --- | --- |
| `.hq/hq-mcp-server.mjs` | generated | this server, copied out of the app bundle |
| `.hq/mcp-tools.json` | generated | the tool list, from `manifest()` in `src/hqops.ts` |
| `.mcp.json` | **the user's** | the harness's pointer at the two above — merged, never replaced |

## Why the server is dumb

It does not touch SQLite, import a line of `src/`, or contain a single
description of what an operation does. It cannot: it runs in a different process
from the app, spawned by a program Spaces does not control, possibly hours after the
app wrote the file it reads. Anything it knew about Spaces's schema would be a second
copy of that schema, and a second copy rots — the first time someone adds a
parameter to `hq_create_task`, one of the two definitions starts lying.

So the whole server is three moves:

- **`tools/list`** is `.hq/mcp-tools.json`, read fresh each time and forwarded.
  If the file is missing it returns an *empty list with the reason attached*
  rather than throwing, because a harness that loses its MCP connection
  mid-session is a much worse failure than one whose tools explain themselves.
- **`tools/call`** appends one JSON line to `.hq/actions.jsonl` and tells the
  agent what will happen to it: additive operations (`effect: "auto"`) apply on
  their own, anything that removes or reassigns existing work
  (`effect: "propose"`) waits for a human. It is honest that the call is
  *queued*, not done — the transport is one-way and the result never comes back.
- **read-only calls** can't be answered that way, since the agent needs the
  answer in the same turn. Those return Spaces's mirrored markdown from `.hq/`
  (`CONTEXT.md`, `ROSTER.md`, `BOARD.md`, `LINKS.md`, `KNOWLEDGE.md`) with the
  age of each file stated in the first two lines. Knowledge gets dedicated
  `spaces_search_knowledge` and `spaces_read_knowledge` tools so agents cite
  the same stable collection/path reference on every member device. A stale
  answer that admits it is stale is useful; a stale answer wearing a live
  one's clothes is how an agent ends up confidently acting on a task that
  closed ten minutes ago.

It has no npm dependencies and never will. It is spawned from a user's checkout
by a harness we do not control, and `npm install` is not something that may fail
between an agent and its tools.

## The wire

Newline-delimited JSON-RPC 2.0 on stdin/stdout — the MCP stdio transport, which
does **not** use LSP's `Content-Length` framing. One message per line.
`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
`shutdown` and `exit` are handled; everything else answers `-32601` honestly,
because the server advertises `tools` and nothing else. It reports
`protocolVersion: "2024-11-05"` regardless of what the client asks for: a
tools-only server has no version-specific behaviour to negotiate, and every
current client accepts an older revision.

**stdout is sacred.** One stray `console.log` is indistinguishable from a
malformed frame and takes the session down. Diagnostics go to stderr, which the
harness captures in its MCP logs.

## The line it appends

```json
{"id":"mcp-ms0z5xlm-0c4f5228","ts":1785020578906,"source":"mcp","op":"hq_create_task",
 "args":{"title":"Ship it"},"agent_id":"","run_id":"","channel_id":"","project_id":"p1",
 "cwd":"/Users/you/code/thing","pid":81746}
```

The routing fields are named after the `agent_actions` columns so the drain is a
near-1:1 mapping. `agent_id` / `run_id` / `channel_id` come from
`SPACES_AGENT_ID`, `SPACES_RUN_ID` and `SPACES_CHANNEL_ID`; Spaces injects all
three plus `SPACES_PROJECT_ID` into every harness process. `cwd` remains a
second routing hint — Spaces gives each isolated agent its own worktree, so the
path identifies the caller even when a harness strips inherited environment
variables.

Several agents can be mid-call at once, so a call is exactly one
`appendFileSync` of one line plus its newline. An `O_APPEND` write of a small
buffer lands whole and at the end without a seek, which is the only guarantee a
line-oriented queue needs; the file is never read-modify-written here. (Verified
with twelve concurrent servers × forty calls: 480 lines, 480 parsed.) Lines over
512 KB are refused with an explanation rather than risking a torn write.

## Debugging it

**Is it registered?** `claude mcp list` in the project, or `/mcp` inside a
session. `cat .mcp.json` — Spaces's entry is under `mcpServers.hq`, everything else
in there is yours and Spaces never touches it.

**Is it being called?** `tail -f .hq/actions.jsonl`. Every call an agent makes
appears there within milliseconds. If the file grows and nothing happens in the
app, the bug is in Spaces's drain, not here. If it doesn't grow, the agent never
called — check that the tools appear in `/mcp`.

**Drive it by hand.** It is just a program that reads lines:

```sh
{ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hq_create_task","arguments":{"title":"Ship it"}}}'
} | node .hq/hq-mcp-server.mjs "$PWD"
```

Run it with no argument and no `SPACES_PROJECT_ROOT` and it exits 2 with a sentence
saying so — a misconfigured server that starts anyway and offers nothing is the
one failure mode nobody ever debugs.

**Nothing in `tools/list`?** The manifest is missing or unparseable; the reason
is in the `_meta` of the empty result and on stderr. Opening the project in Spaces
rewrites it.

## Things that are true and slightly annoying

- **`.mcp.json` ends up machine-specific.** The `args` are absolute, on purpose:
  isolated agents run in git worktrees, where a relative `.hq/hq-mcp-server.mjs`
  would resolve to that worktree's own copy — a second queue nobody drains.
  If you commit `.mcp.json`, a teammate's checkout will point at your paths
  until their own Spaces re-registers it. Add it to `.gitignore` if that bothers you.
- **Worktrees need their own `.mcp.json`.** The harness reads it from the
  directory it starts in, and an uncommitted file in the main checkout is
  invisible from a worktree. `ensureMcpRegistration(project, worktreePath)`
  writes one there that still points at the main checkout's server.
- **`node` has to be on the PATH the harness inherits** (`login_path()` in
  `src-tauri/src/lib.rs`). The server is ESM and needs Node 18 or newer.
- **Codex does not read `.mcp.json`.** It keeps MCP servers in
  `~/.codex/config.toml`, which belongs to the user and which Spaces does not write:

  ```toml
  [mcp_servers.hq]
  command = "node"
  args = ["/abs/path/to/project/.hq/hq-mcp-server.mjs", "/abs/path/to/project"]
  ```

  Recent Codex builds can do that for you — check `codex mcp --help`. Either
  way, the file-drop transport works for every harness without any of this.
- **`.hq/actions.jsonl` is a queue, not a document.** It is the one file under
  `.hq/` that will produce noisy diffs if you commit it.
