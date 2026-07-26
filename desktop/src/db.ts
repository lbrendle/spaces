import Database from "@tauri-apps/plugin-sql";

let dbPromise: Promise<Database> | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  cli_args TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_type, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done',
  meta TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee_agent_id TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Additive v2 migration; every statement is safe to re-run (ALTERs are try/caught). */
const MIGRATION_V2 = `
ALTER TABLE messages ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN run_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN isolate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN chaining INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN last_run_id TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  session_id TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '',
  activity TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id TEXT PRIMARY KEY,
  last_read INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * v3 — coordination layer.
 * Roles/charters at every level, per-channel orchestration mode, a durable
 * work queue so mentions are never dropped, and git checkpoints per run.
 */
const MIGRATION_V3 = `
ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE teams ADD COLUMN charter TEXT NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN charter TEXT NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN mode TEXT NOT NULL DEFAULT 'lead';
ALTER TABLE channels ADD COLUMN lead_agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN owns TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN commit_before TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN commit_after TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN files_changed TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_target ON queue (channel_id, agent_id, created_at);
`;

/** v4 — full run transcripts (raw harness stream incl. tool results). */
const MIGRATION_V4 = `
ALTER TABLE runs ADD COLUMN transcript TEXT NOT NULL DEFAULT '';
`;

/** v5 — immutable launch context for the live process console. */
const MIGRATION_V5 = `
ALTER TABLE runs ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN effort TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN command TEXT NOT NULL DEFAULT '';
`;

/** v6 — paired private web workspace for remote team coordination. */
const MIGRATION_V6 = `
CREATE TABLE IF NOT EXISTS portal_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL,
  device_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  token TEXT NOT NULL,
  device_name TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paired',
  last_error TEXT NOT NULL DEFAULT ''
);
`;

/** v7 — durable message reactions shared by channels and threads. */
const MIGRATION_V7 = `
CREATE TABLE IF NOT EXISTS message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, emoji, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions (message_id, created_at);
`;

/** v8 — the native founder-operations surfaces and provider-safe account metadata. */
const MIGRATION_V8 = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'spaces',
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (updated_at DESC);
CREATE TABLE IF NOT EXISTS mail_threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'inbox',
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  to_email TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_folder ON mail_threads (folder, received_at DESC);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'spaces',
  external_id TEXT NOT NULL DEFAULT '',
  calendar_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events (start_at);
CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  copy TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'multi',
  status TEXT NOT NULL DEFAULT 'idea',
  scheduled_at INTEGER NOT NULL DEFAULT 0,
  published_url TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_status ON content_items (status, updated_at DESC);
CREATE TABLE IF NOT EXISTS integration_accounts (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (category, provider, handle)
);
`;

/** v9 — editable operation history and provider publishing metadata. */
const MIGRATION_V9 = `
ALTER TABLE content_items ADD COLUMN media_url TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN publish_error TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_versions
  ON document_versions (document_id, created_at DESC);
`;

/** v10 — vault-style document paths, pinning, and link-aware history. */
const MIGRATION_V10 = `
ALTER TABLE documents ADD COLUMN path TEXT NOT NULL DEFAULT 'Notes';
ALTER TABLE documents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE document_versions ADD COLUMN path TEXT NOT NULL DEFAULT 'Notes';
`;

/**
 * v11 — stable identity for rows mirrored from the portal.
 *
 * Sync used to mint local ids by prefixing the remote one (`portal-<id>`),
 * which meant a project that existed both locally and upstream became two
 * rows, and a row the user deleted came straight back on the next 15-second
 * tick. This table maps a remote id to whichever local row represents it, and
 * the absence of that local row is how a deliberate local delete survives:
 * a mapping pointing at nothing means "the user removed this on purpose",
 * never "re-create it".
 */
const MIGRATION_V11 = `
CREATE TABLE IF NOT EXISTS portal_links (
  entity TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  PRIMARY KEY (entity, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_links_local ON portal_links (entity, local_id);
`;

/**
 * v12 — the connection graph.
 *
 * `links` is the everything-to-everything table and `assignments` puts an
 * agent or team on any entity. Both are (type, id) pairs rather than foreign
 * keys, so adding an entity kind needs no migration; the unique indexes stop
 * the same relation being drawn twice.
 *
 * Numbered 12 deliberately: versions 4–11 are taken by the portal/operations
 * work (run transcripts, launch context, portal_connection, reactions,
 * documents, document versions, vault paths, portal_links). Reusing a number
 * would make one branch's migration silently skip on a database the other
 * branch had already stamped.
 */
const MIGRATION_V12 = `
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'relates',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links (from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links (to_type, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_uniq ON links (from_type, from_id, to_type, to_id, kind);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_target ON assignments (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_assign_subject ON assignments (subject_type, subject_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assign_uniq ON assignments (subject_type, subject_id, target_type, target_id, role);
`;

/**
 * v13 — calendars.
 *
 * Every calendar carries an owner (a person, an agent, a team, or the
 * workspace itself) so a communal workspace can always answer "whose is
 * this". `calendar_shares` is what makes a workspace calendar shareable per
 * member, and the `busy` access tier is what makes overlaying somebody
 * else's week safe — the UI renders their blocks with no titles.
 *
 * Events are cached here rather than fetched per render: an offline desktop
 * app that shows a blank week when the network blinks is worse than one
 * showing slightly stale times.
 */
const MIGRATION_V13 = `
CREATE TABLE IF NOT EXISTS calendar_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL DEFAULT 'member',
  owner_id TEXT NOT NULL DEFAULT '',
  connected_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  last_error TEXT NOT NULL DEFAULT '',
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_account_ext ON calendar_accounts (provider, external_id);
CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL DEFAULT 'member',
  owner_id TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  writable INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendars_owner ON calendars (owner_type, owner_id);
CREATE TABLE IF NOT EXISTS calendar_shares (
  calendar_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'busy',
  PRIMARY KEY (calendar_id, subject_type, subject_id)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  tz TEXT NOT NULL DEFAULT '',
  organizer TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'hq',
  updated_at INTEGER NOT NULL DEFAULT 0,
  etag TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_span ON events (starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_events_cal ON events (calendar_id, starts_at);
-- Partial, because Spaces-native events all carry external_id = '' and a plain
-- unique index would let only one of them exist ('' is not distinct the way
-- NULL is).
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_ext ON events (calendar_id, external_id) WHERE external_id != '';
`;

/**
 * v14 — the agent action log.
 *
 * Every mutation an agent makes lands here, whether it applied immediately or
 * is waiting for a human. Two jobs: it is the approval queue for anything
 * destructive or reassigning, and it is the audit trail for everything else —
 * "which agent moved this task, and when" has to be answerable, or handing
 * agents write access to the workspace is not a trade worth making.
 */
const MIGRATION_V14 = `
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  op TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  -- applied: done. pending: waiting on a human. rejected/failed: terminal.
  status TEXT NOT NULL DEFAULT 'applied',
  result TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'file',
  created_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_actions_status ON agent_actions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_run ON agent_actions (run_id);
`;

/**
 * v15 — people, their machines, and ownership of what they bring.
 *
 * The workspace is communal but had no person in it. Members and devices fill
 * that in, and three existing tables gain an owner:
 *
 *   agents     brought by a member, hosted on one of their devices. An agent
 *              is usable by everyone regardless — that is what communal means —
 *              but it only RUNS while its host device is online, which is the
 *              honest reason a roster shows some teammates as unavailable.
 *   documents  private to their owner unless shared, like a real drive.
 *   vaults     a folder on disk mirrored read-only for search and agent recall.
 *
 * A seed row for the local user is inserted here rather than at runtime, so
 * ownership never has a window where it points at nothing.
 */
const MIGRATION_V15 = `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  portal_user_id TEXT NOT NULL DEFAULT '',
  is_self INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_self ON members (is_self) WHERE is_self = 1;
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '{}',
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_member ON devices (member_id);
ALTER TABLE agents ADD COLUMN owner_member_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN host_device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE documents ADD COLUMN owner_member_id TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
CREATE TABLE IF NOT EXISTS document_shares (
  document_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'read',
  PRIMARY KEY (document_id, subject_type, subject_id)
);
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  owner_member_id TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  exclude TEXT NOT NULL DEFAULT '.git,node_modules,.obsidian,.trash',
  file_count INTEGER NOT NULL DEFAULT 0,
  last_indexed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_files (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  modified_at INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_files_path ON vault_files (vault_id, rel_path);
INSERT OR IGNORE INTO members (id, name, email, color, role, portal_user_id, is_self, status, created_at)
VALUES ('me', 'You', '', '', 'owner', '', 1, 'active', 0);
`;

/**
 * v16 — faces.
 *
 * A workspace full of coloured initials reads as a database. People get a real
 * picture, and an agent gets the mark of whatever it runs on, so a roster is
 * scannable by shape before you read a word of it.
 *
 * Stored as a data URL in the row rather than a file path: a path is only
 * valid on the machine that chose it, and these have to survive syncing to
 * other members. The UI downscales before writing — the cap is enforced there,
 * because SQLite will happily store a 4MB selfie and then be slow forever.
 */
const MIGRATION_V16 = `
ALTER TABLE members ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE teams ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
`;

/**
 * v17 — durable shared-content replication.
 *
 * The portal remains a control plane for execution, but selected documents,
 * imported knowledge, and permission-aware calendars now have a cloud copy.
 * This table is an outbox acknowledgement ledger: unchanged rows are not sent
 * every fifteen seconds, and a remote id always resolves back to its local
 * source without putting cloud ids into user-authored records.
 */
const MIGRATION_V17 = `
ALTER TABLE portal_connection ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS portal_sync_state (
  entity TEXT NOT NULL,
  local_id TEXT NOT NULL,
  remote_id TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  synced_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity, local_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_sync_remote ON portal_sync_state (entity, remote_id);
`;

/**
 * v18 — durable people edits for the shared web workspace.
 *
 * A paired member row is a mirror of a real authenticated portal identity.
 * Editing it locally must not race the 15-second reconciliation pull, so
 * linked name/role changes go through this outbox and are acknowledged by the
 * portal before the authoritative member response is applied.
 */
const MIGRATION_V18 = `
CREATE TABLE IF NOT EXISTS portal_member_outbox (
  member_id TEXT PRIMARY KEY,
  portal_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_member_outbox_user
  ON portal_member_outbox (portal_user_id);
`;

/**
 * v19 — pin a content draft to the exact shared social account that will
 * publish it. The project remains the policy boundary; the connection id
 * removes ambiguity when that project has more than one account per network.
 */
const MIGRATION_V19 = `
ALTER TABLE content_items ADD COLUMN connection_id TEXT NOT NULL DEFAULT '';
CREATE TABLE integration_accounts_v19 (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'disconnected',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO integration_accounts_v19
  (id, category, provider, label, handle, status, metadata, created_at, updated_at)
SELECT id, category, provider, label, handle, status, metadata, created_at, updated_at
  FROM integration_accounts;
DROP TABLE integration_accounts;
ALTER TABLE integration_accounts_v19 RENAME TO integration_accounts;
CREATE INDEX idx_integration_accounts_provider
  ON integration_accounts (category, provider, status);
`;

async function applyStatements(db: Database, sql: string, tolerateReruns: boolean) {
  for (const stmt of sql.split(";")) {
    const s = stmt.trim();
    if (!s) continue;
    try {
      await db.execute(s);
    } catch (e) {
      // Re-running an additive migration hits "duplicate column name" on its
      // ALTERs — that's expected. Anything else must fail loudly, BEFORE the
      // version gets stamped.
      if (tolerateReruns && /duplicate column name/i.test(String(e))) continue;
      throw e;
    }
  }
}

export async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await Database.load("sqlite:spaces.db");
      await applyStatements(db, SCHEMA, false);
      const ver = await db.select<{ user_version: number }[]>("PRAGMA user_version");
      const at = ver[0]?.user_version ?? 0;
      if (at < 2) {
        await applyStatements(db, MIGRATION_V2, true);
        await db.execute("PRAGMA user_version = 2");
      }
      if (at < 3) {
        await applyStatements(db, MIGRATION_V3, true);
        await db.execute("PRAGMA user_version = 3");
      }
      if (at < 4) {
        await applyStatements(db, MIGRATION_V4, true);
        await db.execute("PRAGMA user_version = 4");
      }
      if (at < 5) {
        await applyStatements(db, MIGRATION_V5, true);
        await db.execute("PRAGMA user_version = 5");
      }
      if (at < 6) {
        await applyStatements(db, MIGRATION_V6, true);
        await db.execute("PRAGMA user_version = 6");
      }
      if (at < 7) {
        await applyStatements(db, MIGRATION_V7, true);
        await db.execute("PRAGMA user_version = 7");
      }
      if (at < 8) {
        await applyStatements(db, MIGRATION_V8, true);
        await db.execute("PRAGMA user_version = 8");
      }
      if (at < 9) {
        await applyStatements(db, MIGRATION_V9, true);
        await db.execute("PRAGMA user_version = 9");
      }
      if (at < 10) {
        await applyStatements(db, MIGRATION_V10, true);
        await db.execute("PRAGMA user_version = 10");
      }
      if (at < 11) {
        await applyStatements(db, MIGRATION_V11, true);
        await db.execute("PRAGMA user_version = 11");
      }
      if (at < 12) {
        await applyStatements(db, MIGRATION_V12, true);
        await db.execute("PRAGMA user_version = 12");
      }
      if (at < 13) {
        await applyStatements(db, MIGRATION_V13, true);
        await db.execute("PRAGMA user_version = 13");
      }
      if (at < 14) {
        await applyStatements(db, MIGRATION_V14, true);
        await db.execute("PRAGMA user_version = 14");
      }
      if (at < 15) {
        await applyStatements(db, MIGRATION_V15, true);
        await db.execute("PRAGMA user_version = 15");
      }
      if (at < 16) {
        await applyStatements(db, MIGRATION_V16, true);
        await db.execute("PRAGMA user_version = 16");
      }
      if (at < 17) {
        await applyStatements(db, MIGRATION_V17, true);
        await db.execute("PRAGMA user_version = 17");
      }
      if (at < 18) {
        await applyStatements(db, MIGRATION_V18, true);
        await db.execute("PRAGMA user_version = 18");
      }
      if (at < 19) {
        await db.execute("BEGIN IMMEDIATE");
        try {
          await applyStatements(db, MIGRATION_V19, true);
          await db.execute("PRAGMA user_version = 19");
          await db.execute("COMMIT");
        } catch (error) {
          await db.execute("ROLLBACK").catch(() => {});
          throw error;
        }
      }
      return db;
    })().catch((e) => {
      dbPromise = null; // don't cache a rejected promise forever
      throw e;
    });
  }
  return dbPromise;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}
