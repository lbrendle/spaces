# Connections, calendars and shared context

Design spec for the "everything links to everything" layer, and how connected
calendars sit on top of it. Written against the in-flight portal architecture
(`portal/`, `src/portal.ts`, `PairingGate`), not the last commit.

---

## 1. The entity graph

One idea underneath all of it: every noun in Spaces is an **entity**, addressed by
`{type, id}`. Two tables sit on top.

```
links        anything ←→ anything, with a relation kind
assignments  an agent or team is responsible for anything
```

```ts
type EntityType =
  | "project" | "channel" | "message" | "task" | "memory"
  | "agent"   | "team"    | "run"     | "workspace"
  | "pr"      | "issue"   | "repo"    | "event";

interface EntityRef { type: EntityType; id: string }
```

```sql
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  from_type TEXT, from_id TEXT,
  to_type   TEXT, to_id   TEXT,
  kind TEXT,          -- relates | blocks | depends | parent | duplicates | implements | references
  note TEXT,
  created_by TEXT,    -- 'user', or the agent id that drew the link
  created_at INTEGER
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  subject_type TEXT,  -- agent | team
  subject_id   TEXT,
  target_type  TEXT,  -- any EntityType
  target_id    TEXT,
  role TEXT,          -- owner | assignee | reviewer | watcher
  created_at INTEGER
);
```

Neither table uses foreign keys — a type tag plus an id — so **adding an entity
kind costs no migration**. Unique indexes stop the same relation being drawn
twice; `relates` is treated as symmetric so a mirrored row is the same link.

### Why this is the whole feature

Three things fall out of it for free:

1. **Assign agents and teams to anything.** Not just tasks — a channel, a
   project, a memory entry, a workspace, a PR, a calendar event. `assignments`
   doesn't care.
2. **Backlinks everywhere.** Any entity can render "what points at me".
3. **Shared context.** When an agent runs, the prompt builder walks the graph
   one hop out from the channel (and the dispatching task) and injects what it
   finds. Linking a memory entry to a channel *is* how you give that channel's
   agents that context — no separate mechanism.

### Auto-linking

Links get drawn without the user thinking about it:

| Trigger | Link created |
|---|---|
| Task dispatched to an agent in a channel | `task → channel` (`references`), `run → task` |
| Agent run touches files / opens a PR | `run → pr`, `pr → task` |
| Message mentions `#channel` or `[[Memory title]]` | `message → channel` / `message → memory` |
| Agent writes `link: <task>` in a reply | `run → task`, `created_by = <agent id>` |
| Event created from a task | `event → task` |

Manual links are drawn from a universal picker (`⌘L`) that searches every
entity type at once.

---

## 2. Calendars

### 2.1 Ownership model

The requirement is: people connect their own calendars, Spaces has its own, and
teams get shared workspace calendars — and the UI can always say whose is whose.

```sql
-- an upstream account someone connected (OAuth lives in the portal, not here)
CREATE TABLE calendar_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  provider TEXT,              -- google | microsoft
  external_account_id TEXT,   -- the provider's account id
  display_name TEXT,          -- "rowan@…"
  owner_type TEXT,            -- person | agent | team | workspace
  owner_id TEXT,
  connected_by TEXT,          -- the member who ran the OAuth flow
  scopes TEXT, status TEXT, created_at INTEGER
);

-- individual calendars, whether upstream or Spaces-native
CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  account_id TEXT,            -- '' for Spaces-native calendars
  external_id TEXT,
  name TEXT, color TEXT,
  kind TEXT,                  -- personal | workspace | agent | team
  owner_type TEXT, owner_id TEXT,
  visibility TEXT,            -- private | busy | workspace
  writable INTEGER, created_at INTEGER
);

-- the "shared workspace calendar per team member" bit
CREATE TABLE calendar_shares (
  calendar_id TEXT,
  subject_type TEXT,          -- member | team | agent
  subject_id TEXT,
  access TEXT,                -- busy | read | write
  PRIMARY KEY (calendar_id, subject_type, subject_id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT, calendar_id TEXT, external_id TEXT,
  title TEXT, description TEXT, location TEXT,
  starts_at INTEGER, ends_at INTEGER, all_day INTEGER, tz TEXT,
  organizer TEXT, attendees TEXT,     -- JSON
  source TEXT,                        -- google | microsoft | hq
  updated_at INTEGER, etag TEXT
);
```

Four kinds of calendar, one mechanism:

- **Personal** — `owner_type='person'`. Rowan connects Google; her calendars
  land private by default. Nobody sees titles unless she shares them.
- **Spaces's** — `owner_type='workspace'`. Either a real Google calendar in the
  Spaces account or Spaces-native. This is what "vs Spaces's calendar" compares
  against.
- **Agent / team** — `owner_type='agent'|'team'`. Scheduled runs, task due
  dates and recurring routines materialise here, so "what is this agent doing
  this week" is a calendar question with an answer.
- **Shared workspace** — a workspace calendar plus `calendar_shares` rows
  granting each member `busy`, `read` or `write`.

**Privacy is the `access='busy'` tier.** A calendar shared at `busy` renders as
anonymous blocks — start, end, and nothing else. That is what makes
"mine vs Spaces's vs the team's" safe to put in one overlaid week view.

### 2.2 Events are entities

`event` joins `EntityType`, and then the graph does the rest:

- link an event to the task it's about, the channel it was scheduled from, or
  the PR it's reviewing;
- assign an agent to an event as `owner` (it prepares the agenda) or `watcher`
  (it summarises the outcome);
- an agent prepping for a meeting gets the linked task, linked memory and the
  channel's recent messages injected — because that's just shared context,
  already implemented.

No calendar-specific plumbing. That's the point of doing the graph first.

### 2.3 Keys

The portal already holds one OAuth app per provider as Worker secrets
(`GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`, …). End users hold **zero keys** —
they click "Connect Google", tokens land in D1, and the desktop calls
`calendar.list` / `calendar.create` through the portal with its device token.
`src/portal.ts` already declares those actions.

MCP runs alongside, not instead:

| | Portal OAuth | MCP |
|---|---|---|
| Spaces renders a calendar UI | ✅ | ❌ (no data outside an agent run) |
| Agent can read/write calendars | ✅ via portal actions | ✅ inherited automatically |
| Keys the end user manages | none | their own MCP auth |
| Works for someone with no CLI installed | ✅ | ❌ |

Spaces spawns the user's real `claude` / `codex` binaries, so any calendar MCP they
have configured is available to agents for free. **Portal is authoritative for
anything Spaces draws; MCP is a bonus inside agent runs.** Don't try to render MCP
data in the UI — there's no stable schema to draw.

---

## 3. Persistence and onboarding

### Where data lives today

| | Store | Scope |
|---|---|---|
| Desktop | SQLite, `~/Library/Application Support/app.spaces.desktop/spaces.db` | one machine |
| Portal | D1 via drizzle | one workspace |
| Bridge | `POST /api/device/claim` → device token, then `/api/device/sync` | pairing |

### Proposal

Split by what the data actually *is*, rather than syncing everything:

- **D1 is the system of record for workspace data** — members, integrations,
  calendars, events, and (eventually) projects, channels, tasks, memory, links,
  assignments. This is what "persists for folks".
- **Local SQLite stays the cache plus the genuinely machine-local rows** —
  runs, worktrees, agent sessions, absolute file paths, PTY state. None of that
  is meaningful on another machine.
- `device/sync` is already the pipe; it needs a per-table cursor and
  last-writer-wins on `updated_at` before it can carry mutable rows both ways.

### The agent-onboarding gap

Agents today are local rows wrapping the user's own `claude` / `codex` CLI.
Someone who installs the desktop app without those CLIs has **no agent at all**
— the roster renders, nothing runs. Three ways out, in increasing order of work:

1. **Bring your own CLI** (status quo). Onboarding = install Claude Code or
   Codex, sign in, Spaces detects it on PATH. Zero keys, zero hosting, but it's a
   developer-only product.
2. **Portal-hosted agents.** The Worker runs the agent. Works for anyone, needs
   a model provider credential held workspace-side, and loses the local
   filesystem — so it can talk and plan but not edit a repo.
3. **Delegated device execution.** An agent belongs to the workspace but runs
   on whichever paired device is online, on behalf of whoever asked. Keeps the
   filesystem and the no-keys property; needs a job queue and a trust model.

(2) and (3) are not exclusive — an agent kind column already exists, and this
is a fourth and fifth value for it. **Open decision.**

---

## 4. UI work this unlocks

- **Universal entity picker** (`⌘L`) — search every type at once, pick a
  relation, done.
- **Connections panel** on tasks, memory, channels, projects, events: linked,
  backlinks, assignees, with inline unlink.
- **Entity chips with hover cards** — one component, every reference site.
- **Graph view** — the workspace as a navigable map; filter by type, focus a
  node to see its neighbourhood.
- **Inspector drawer** — right-hand pane bound to `store.inspect`, so anything
  clicked anywhere opens in place instead of a modal.
- **Calendar view** — overlaid week/month, per-calendar colour and toggle,
  `busy` blocks anonymised, "mine / team / Spaces / agents" filter row.
- **Agent workload** — because assignments span every entity type, an agent's
  page can show everything it owns across tasks, channels, PRs and events.
