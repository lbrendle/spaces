export interface Project {
  id: string;
  name: string;
  description: string;
  repo: string; // owner/name on GitHub, '' if none
  local_path: string; // local checkout used as agent cwd
  isolate: number; // 1 = each agent works in its own git worktree (workspace)
  instructions: string; // project-wide standing instructions, top of every prompt
  created_at: number;
}

export interface Channel {
  id: string;
  project_id: string;
  name: string;
  topic: string;
  chaining: number; // 1 = agents mentioning other agents trigger them
  charter: string; // what this channel is for; prepended for its members
  mode: ChannelMode;
  lead_agent_id: string; // orchestrator for "lead" and "panel" modes
  created_at: number;
}

export type AgentKind = "claude" | "codex" | "ritz";

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  model: string;
  persona: string;
  role: string; // short title, e.g. "Frontend" — shown on cards and in rosters
  owns: string; // areas of ownership, e.g. "src/components, styling"
  /** Data URL. '' falls back to the mark of whatever harness it runs on. */
  avatar: string;
  /** The member who brought this agent. '' for agents that predate ownership. */
  owner_member_id: string;
  /** The device it runs on; it can only answer while that machine is awake. */
  host_device_id: string;
  /** 'workspace' — anyone may use it — or 'private' to its owner. */
  visibility: "workspace" | "private";
  cli_args: string;
  created_at: number;
}

/**
 * How a channel dispatches a message to its member agents.
 * - broadcast: everyone addressed runs at once (fastest, unordered)
 * - sequential: run in roster order, each sees the previous replies
 * - lead: the lead triages, delegates by @mention, then synthesizes
 * - panel: all answer independently, then the lead merges
 */
export type ChannelMode = "broadcast" | "sequential" | "lead" | "panel";

export interface Team {
  id: string;
  name: string;
  description: string;
  charter: string; // shared standing instructions for every member
  avatar: string;
  created_at: number;
}

export interface TeamMember {
  team_id: string;
  agent_id: string;
}

export interface ChannelMember {
  channel_id: string;
  member_type: "agent" | "team";
  member_id: string;
}

export interface Message {
  id: string;
  channel_id: string;
  author_type: "user" | "agent" | "system";
  author_id: string;
  author_name: string;
  content: string;
  status: "running" | "done" | "error";
  meta: string;
  parent_id: string; // '' = top-level; otherwise id of the thread root message
  run_id: string; // for agent messages, the run that produced it (== message id)
  created_at: number;
}

export interface MessageReaction {
  id: string;
  message_id: string;
  emoji: string;
  actor_id: string;
  actor_name: string;
  created_at: number;
}

export interface Run {
  id: string; // equals the agent reply message id
  agent_id: string;
  channel_id: string;
  task_id: string;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  session_id: string;
  meta: string;
  activity: string; // JSON array of ActivityEvent
  cwd: string;
  model: string; // snapshot at launch time
  effort: string; // snapshot at launch time
  command: string; // executable + args, never the prompt
  commit_before: string; // git checkpoint before the run
  commit_after: string; // git checkpoint after, so a run is revertable
  files_changed: string; // newline-separated paths touched during the run
  transcript: string; // raw harness stream, one JSON event per line
  started_at: number;
  finished_at: number;
}

/** A mention that arrived while its target agent was busy. */
export interface QueuedItem {
  id: string;
  channel_id: string;
  agent_id: string;
  payload: string; // JSON-encoded Trigger
  created_at: number;
}

export interface ActivityEvent {
  t: number; // ms since run start
  kind: "tool" | "text" | "info" | "stderr";
  detail: string;
}

export interface AgentSession {
  channel_id: string;
  agent_id: string;
  session_id: string;
  updated_at: number;
}

export type TaskStatus = "backlog" | "todo" | "doing" | "done";

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee_agent_id: string;
  due_date: string;
  sort_order: number;
  branch: string; // git branch created for this task, if any
  last_run_id: string; // most recent agent run dispatched from this task
  created_at: number;
}

export type MemoryKind = "decision" | "context" | "note";

export interface MemoryEntry {
  id: string;
  project_id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

/* ── the connection graph ──────────────────────────────────────
 *
 * Every noun in Spaces — a project, a channel, a message, a task, a memory
 * entry, an agent, a team, a run, a workspace, a pull request — is an
 * *entity*, addressed by an EntityRef. Two tables sit on top of that:
 *
 *   links        anything ←→ anything, with a relation kind
 *   assignments  an agent or team is responsible for anything
 *
 * Both are deliberately untyped at the database level (a type tag plus an
 * id) so new entity kinds cost nothing, and both feed the prompt builder:
 * what a thing is connected to *is* its shared context.
 */

export type EntityType =
  | "project"
  | "channel"
  | "message"
  | "task"
  | "memory"
  | "document"
  | "agent"
  | "team"
  | "member"
  | "device"
  | "run"
  | "workspace"
  | "event"
  | "pr"
  | "issue"
  | "repo";

export interface EntityRef {
  type: EntityType;
  id: string;
}

export function refKey(r: EntityRef): string {
  return `${r.type}:${r.id}`;
}

export function sameRef(a: EntityRef | null, b: EntityRef | null): boolean {
  return !!a && !!b && a.type === b.type && a.id === b.id;
}

/**
 * Relation kinds. `relates` is symmetric; the rest read from → to
 * ("this task BLOCKS that one"), and the UI shows the inverse on the far
 * side so a backlink never reads backwards.
 */
export type LinkKind =
  | "relates"
  | "blocks"
  | "depends"
  | "parent"
  | "duplicates"
  | "implements"
  | "references";

export interface Link {
  id: string;
  from_type: EntityType;
  from_id: string;
  to_type: EntityType;
  to_id: string;
  kind: LinkKind;
  note: string;
  /** 'user', or the id of the agent that drew the link. */
  created_by: string;
  created_at: number;
}

/** Why an agent or team is attached to something. */
export type AssignRole = "owner" | "assignee" | "reviewer" | "watcher";

export interface Assignment {
  id: string;
  subject_type: "agent" | "team";
  subject_id: string;
  target_type: EntityType;
  target_id: string;
  role: AssignRole;
  created_at: number;
}

/* ── calendars ─────────────────────────────────────────────────
 *
 * Spaces is a communal workspace, so "whose calendar is this" is the first
 * question the model has to answer. Every calendar has an owner — a person,
 * an agent, a team, or the workspace itself (the assistant's own) — and a share
 * list saying who else may see it and how much.
 *
 * The `busy` access tier is what makes overlaying them safe: a calendar
 * shared at `busy` renders start and end times and nothing else, so you can
 * compare your week against a teammate's without reading their titles.
 */

export type CalendarProvider = "google" | "microsoft" | "hq";

/** An upstream account somebody connected. OAuth itself lives in the portal. */
export interface CalendarAccount {
  id: string;
  provider: CalendarProvider;
  /** The provider's own account id, so re-connecting doesn't duplicate. */
  external_id: string;
  display_name: string;
  owner_type: CalendarOwnerType;
  owner_id: string;
  /** Who ran the OAuth flow — not necessarily the owner. */
  connected_by: string;
  status: "ok" | "expired" | "error";
  last_error: string;
  last_sync_at: number;
  created_at: number;
}

export type CalendarOwnerType = "member" | "agent" | "team" | "workspace";

/** How much of a calendar a viewer is allowed to see. */
export type CalendarAccess = "busy" | "read" | "write";

export interface Calendar {
  id: string;
  /** '' for a calendar Spaces owns outright rather than mirroring. */
  account_id: string;
  external_id: string;
  name: string;
  /** A theme token or hex; the UI falls back to a hashed avatar color. */
  color: string;
  owner_type: CalendarOwnerType;
  owner_id: string;
  /** Default access for workspace members who have no explicit share. */
  visibility: "private" | CalendarAccess;
  writable: number;
  /** 1 = drawn by default in the overlay. */
  enabled: number;
  created_at: number;
}

export interface CalendarShare {
  calendar_id: string;
  subject_type: "member" | "team" | "agent";
  subject_id: string;
  access: CalendarAccess;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  /** '' for events Spaces created itself. */
  external_id: string;
  title: string;
  description: string;
  location: string;
  starts_at: number;
  ends_at: number;
  all_day: number;
  tz: string;
  organizer: string;
  /** JSON array of { email, name, response }. */
  attendees: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** Where it came from, so a sync can replace only what it owns. */
  source: CalendarProvider;
  updated_at: number;
  etag: string;
}

/* ── people and their machines ─────────────────────────────────
 *
 * Spaces is a communal workspace, which until now it modelled without ever
 * modelling a person: calendars, documents and agents all wanted an owner and
 * there was nothing to point at. A member is that missing noun.
 *
 * Exactly one row has `is_self = 1` — whoever is sitting at this machine.
 * Every ownership check goes through it, so the day the portal supplies real
 * identities this becomes a lookup instead of an assumption.
 */

export type MemberRole = "owner" | "admin" | "member" | "guest";

export interface Member {
  id: string;
  name: string;
  email: string;
  /** '' means fall back to the theme's hashed identity ramp. */
  color: string;
  role: MemberRole;
  /** Identity in the paired web workspace, '' when purely local. */
  portal_user_id: string;
  is_self: number;
  status: "active" | "invited" | "removed";
  created_at: number;
  /** Data URL, downscaled before storage. '' falls back to initials. */
  avatar: string;
}

/**
 * A machine somebody has paired. Agents run inside their native harness on a
 * device, so "can this agent run right now" is a question about a device, not
 * about the agent — which is why a communal roster still shows some agents as
 * unavailable.
 */
export interface Device {
  id: string;
  member_id: string;
  name: string;
  platform: string;
  /** JSON map of which CLIs this device has on PATH. */
  tools: string;
  last_seen_at: number;
  created_at: number;
}

/** Who may see a document or a vault, mirroring the calendar tiers. */
export type ShareAccess = "read" | "write";

export interface DocShare {
  document_id: string;
  subject_type: "member" | "team" | "agent";
  subject_id: string;
  access: ShareAccess;
}

/**
 * A folder on disk mirrored into Spaces read-only — an Obsidian vault, a docs
 * directory, anything markdown. Read-only on purpose: Spaces is not going to be
 * the thing that mangles somebody's notes, and search plus agent access is
 * most of the value anyway.
 */
export interface Vault {
  id: string;
  name: string;
  path: string;
  owner_member_id: string;
  visibility: "private" | "workspace";
  /** Comma-separated globs excluded from the walk. */
  exclude: string;
  file_count: number;
  last_indexed_at: number;
  created_at: number;
}

export interface VaultFile {
  id: string;
  vault_id: string;
  /** Path relative to the vault root, always with forward slashes. */
  rel_path: string;
  title: string;
  /** Extracted plain text, for search. Capped per file. */
  body: string;
  size: number;
  modified_at: number;
  indexed_at: number;
}

export type View =
  | { type: "dashboard" }
  | { type: "tasks" }
  | { type: "documents" }
  | { type: "mail" }
  | { type: "calendar" }
  | { type: "content" }
  | { type: "memory" }
  | { type: "agents" }
  | { type: "workspaces" }
  | { type: "settings" }
  | { type: "git" }
  | { type: "graph" }
  | { type: "knowledge" }
  | { type: "people" }
  | {
      type: "workspace";
      projectId: string;
      channelId?: string;
      threadRootId?: string;
      surface?: "chat" | "terminal" | "processes" | "browser";
    }
  | { type: "channel"; channelId: string; threadRootId?: string };

export function slug(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Stable per-identity color. Returns a CSS variable reference rather than a
 * literal so that switching themes recolors every avatar and author name
 * instantly, with no React re-render — the theme redefines --avatar-N.
 */
export function colorFor(id: string): string {
  const stableId = id ?? "";
  let h = 0;
  for (let i = 0; i < stableId.length; i++) {
    h = (h * 31 + stableId.charCodeAt(i)) >>> 0;
  }
  return `var(--avatar-${h % 8})`;
}
