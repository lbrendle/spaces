import { getD1 } from "../db";
import { env } from "cloudflare:workers";
import { AuthError, requirePortalUser } from "./auth";
import {
  canUseConnection,
  connectionAudience,
} from "./connection-policy";
import {
  loadSharedWorkspace,
  rebuildPageLinks,
  syncSharedContent,
} from "./shared-content";
import {
  canCreateWorkspace,
  signupDeniedMessage,
  signupPolicy,
} from "./signup";
import { createConnectedCalendarEvent } from "./provider-actions";
import type {
  ActivityItem,
  AgentProfile,
  Channel,
  Connection,
  ContentItem,
  Decision,
  DesktopSnapshot,
  Device,
  InboxItem,
  Issue,
  Member,
  Message,
  PendingInvite,
  PortalUser,
  Project,
  Team,
  WorkspaceRole,
  WorkspaceSnapshot,
  WorkspaceSummary,
  WorkspaceUnchanged,
} from "./types";

type SqlValue = string | number | null;

interface WorkspaceContext {
  user: PortalUser & { id: string };
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
}

interface MutationResult {
  ok: true;
  invitePath?: string;
  pairingCode?: string;
  expiresAt?: string;
  delivery?: "queued_for_desktop" | "spaces" | "provider";
}

interface ConnectionRow {
  id: string;
  kind: string;
  label: string;
  status: string;
  accountLabel: string;
  scopesJson: string;
  lastSyncAt: string | null;
  ownerUserId: string;
}

interface ProjectConnectionRow {
  connectionId: string;
  projectId: string;
  isDefault: number;
}

function db() {
  return getD1();
}

async function all<T>(sql: string, ...values: SqlValue[]): Promise<T[]> {
  const statement = values.length ? db().prepare(sql).bind(...values) : db().prepare(sql);
  const result = await statement.all<T>();
  return (result.results ?? []) as T[];
}

async function first<T>(sql: string, ...values: SqlValue[]): Promise<T | null> {
  const rows = await all<T>(sql, ...values);
  return rows[0] ?? null;
}

async function run(sql: string, ...values: SqlValue[]) {
  const statement = values.length ? db().prepare(sql).bind(...values) : db().prepare(sql);
  return statement.run();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function future(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 42) || "hq"
  );
}

function text(value: unknown, max = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanKnowledgeSegment(value: string): string {
  return [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("")
    .replace(/[<>:"|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function knowledgeFolder(value: unknown): string {
  return text(value, 400)
    .replace(/\\/g, "/")
    .split("/")
    .map(cleanKnowledgeSegment)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function knowledgePath(folder: unknown, title: string): string {
  const safeTitle =
    cleanKnowledgeSegment(title.replace(/[\\/]/g, " ")) || "Untitled";
  const normalizedFolder = knowledgeFolder(folder);
  return `${normalizedFolder ? `${normalizedFolder}/` : ""}${safeTitle}.md`;
}

function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && choices.includes(value as T)
    ? (value as T)
    : fallback;
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function visibleConnections(
  rows: ConnectionRow[],
  actorUserId: string,
  projectLinks: ProjectConnectionRow[] = [],
): Connection[] {
  return rows
    .filter((row) =>
      canUseConnection(row.kind, row.ownerUserId, actorUserId),
    )
    .map((connection) => ({
      id: connection.id,
      kind: connection.kind,
      label: connection.label,
      status: connection.status,
      accountLabel: connection.accountLabel,
      lastSyncAt: connection.lastSyncAt,
      audience: connectionAudience(connection.kind),
      scopes: jsonArray(connection.scopesJson),
      projectLinks: projectLinks
        .filter((link) => link.connectionId === connection.id)
        .map((link) => ({
          projectId: link.projectId,
          isDefault: Boolean(link.isDefault),
        })),
    }));
}

function jsonObject<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function activity(
  workspaceId: string,
  actorId: string,
  kind: string,
  summary: string,
  entityId: string,
) {
  const createdAt = now();
  await db().batch([
    db()
      .prepare(
        `INSERT INTO activity
          (id, workspace_id, actor_id, kind, summary, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id("act"),
        workspaceId,
        actorId,
        kind,
        summary,
        entityId,
        createdAt,
      ),
    db()
      .prepare(
        `INSERT INTO workspace_events
          (workspace_id, actor_id, kind, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, actorId, kind, entityId, createdAt),
  ]);
}

async function workspaceEvent(
  workspaceId: string,
  actorId: string,
  kind: string,
  entityId: string,
) {
  await run(
    `INSERT INTO workspace_events
      (workspace_id, actor_id, kind, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    workspaceId,
    actorId,
    kind,
    entityId,
    now(),
  );
}

async function workspaceRevision(workspaceId: string): Promise<number> {
  const row = await first<{ revision: number }>(
    `SELECT COALESCE(MAX(sequence), 0) AS revision
       FROM workspace_events
      WHERE workspace_id = ?`,
    workspaceId,
  );
  return Number(row?.revision ?? 0);
}

async function createFounderWorkspace(user: PortalUser & { id: string }) {
  const workspaceId = id("ws");
  const channelId = id("ch");
  const projectId = id("prj");
  const createdAt = now();
  const baseName =
    user.name && user.name !== user.email
      ? `${user.name.split(/\s+/)[0]}'s Spaces`
      : "Founder Spaces";
  const workspaceSlug = `${slug(baseName)}-${workspaceId.slice(-6)}`;

  await db().batch([
    db()
      .prepare(
        `INSERT INTO workspaces
          (id, name, slug, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, baseName, workspaceSlug, user.id, createdAt),
    db()
      .prepare(
        `INSERT INTO memberships
          (workspace_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .bind(workspaceId, user.id, createdAt),
    db()
      .prepare(
        `INSERT INTO channels
          (id, workspace_id, name, topic, mode, lead_agent_id, created_by, created_at)
         VALUES (?, ?, 'general', 'Direction, decisions, and team coordination', 'lead', NULL, ?, ?)`,
      )
      .bind(channelId, workspaceId, user.id, createdAt),
    db()
      .prepare(
        `INSERT INTO projects
          (id, workspace_id, name, summary, status, lead_id, target_date, created_by, created_at, updated_at)
         VALUES (?, ?, 'Spaces', 'The operating system for this company', 'active', NULL, NULL, ?, ?, ?)`,
      )
      .bind(projectId, workspaceId, user.id, createdAt, createdAt),
    db()
      .prepare(
        `INSERT INTO knowledge_pages
          (id, workspace_id, title, slug, body, kind, tags_json, created_by,
           owner_user_id, visibility, source_type, source_record_id,
           source_label, path, created_at, updated_at)
         VALUES (?, ?, 'Operating charter', 'operating-charter', ?, 'charter',
           '["company","operating-system"]', ?, ?, 'workspace', 'portal', ?,
           'Workspace knowledge', 'Company/Operating charter.md', ?, ?)`,
      )
      .bind(
        id("page"),
        workspaceId,
        "Spaces is the shared place for work, decisions, messages, knowledge, and agent coordination. Keep the important context here so people and agents can operate without reconstructing the company from scattered tools.",
        user.id,
        user.id,
        id("page_source"),
        createdAt,
        createdAt,
      ),
  ]);

  const issueOne = id("issue");
  const issueTwo = id("issue");
  await db().batch([
    db()
      .prepare(
        `INSERT INTO issues
          (id, workspace_id, project_id, cycle_id, title, description, status, priority,
           assignee_id, created_by, due_date, source, source_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'Pair the Spaces desktop app', ?, 'ready', 'high',
           ?, ?, NULL, 'portal', NULL, ?, ?)`,
      )
      .bind(
        issueOne,
        workspaceId,
        projectId,
        "Connect a desktop Spaces so this portal can show live projects, tasks, and agent runs.",
        user.id,
        user.id,
        createdAt,
        createdAt,
      ),
    db()
      .prepare(
        `INSERT INTO issues
          (id, workspace_id, project_id, cycle_id, title, description, status, priority,
           assignee_id, created_by, due_date, source, source_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'Invite the first teammate', ?, 'backlog', 'normal',
           ?, ?, NULL, 'portal', NULL, ?, ?)`,
      )
      .bind(
        issueTwo,
        workspaceId,
        projectId,
        "Invite someone into the same messages, board, inbox, knowledge base, and operating context.",
        user.id,
        user.id,
        createdAt,
        createdAt,
      ),
  ]);
  await activity(
    workspaceId,
    user.id,
    "workspace.created",
    `Created ${baseName}`,
    workspaceId,
  );
}

export async function resolveWorkspace(
  headers: Headers,
  requestedWorkspaceId = "",
): Promise<WorkspaceContext> {
  const identity = requirePortalUser(headers);
  const seenAt = now();
  const runtime = env as {
    SPACES_SIGNUP_MODE?: string;
    SPACES_SIGNUP_ALLOWLIST?: string;
  };
  const policy = signupPolicy(
    runtime.SPACES_SIGNUP_MODE,
    runtime.SPACES_SIGNUP_ALLOWLIST,
    headers.get("host") ?? "",
  );
  let user = await first<{ id: string; email: string; name: string }>(
    "SELECT id, email, name FROM users WHERE email = ?",
    identity.email,
  );

  if (!user) {
    if (!canCreateWorkspace(identity.email, policy)) {
      throw new AuthError(403, signupDeniedMessage(policy));
    }
    user = { id: id("usr"), email: identity.email, name: identity.name };
    await run(
      `INSERT INTO users (id, email, name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
      user.id,
      user.email,
      user.name,
      seenAt,
      seenAt,
    );
  } else {
    await run(
      "UPDATE users SET name = ?, last_seen_at = ? WHERE id = ?",
      identity.name,
      seenAt,
      user.id,
    );
    user.name = identity.name;
  }

  let workspaces = await all<WorkspaceSummary>(
    `SELECT w.id, w.name, w.slug, m.role
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ?
      ORDER BY w.created_at`,
    user.id,
  );

  if (!workspaces.length) {
    if (!canCreateWorkspace(identity.email, policy)) {
      throw new AuthError(403, signupDeniedMessage(policy));
    }
    await createFounderWorkspace(user);
    workspaces = await all<WorkspaceSummary>(
      `SELECT w.id, w.name, w.slug, m.role
         FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ?
        ORDER BY w.created_at`,
      user.id,
    );
  }

  const workspace =
    workspaces.find((candidate) => candidate.id === requestedWorkspaceId) ??
    workspaces[0];
  if (!workspace) throw new Error("No Spaces workspace is available.");
  return { user, workspace, workspaces };
}

async function loadWorkspaceSnapshotForContext(
  context: WorkspaceContext,
): Promise<WorkspaceSnapshot> {
  const workspaceId = context.workspace.id;
  const revision = await workspaceRevision(workspaceId);

  const [
    members,
    channels,
    messages,
    issues,
    decisions,
    sharedContent,
    inbox,
    projects,
    agents,
    teams,
    devices,
    pendingInvites,
    connections,
    connectionLinks,
    snapshots,
    activityItems,
  ] = await Promise.all([
    all<Member>(
      `SELECT u.id, u.email,
              COALESCE(NULLIF(m.display_name, ''), u.name) AS name,
              m.role, m.created_at AS joinedAt
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 COALESCE(NULLIF(m.display_name, ''), u.name)`,
      workspaceId,
    ),
    all<Channel>(
      `SELECT id, project_id AS projectId, name, topic, mode,
              lead_agent_id AS leadAgentId
         FROM channels
        WHERE workspace_id = ?
        ORDER BY created_at`,
      workspaceId,
    ),
    all<Message>(
      `SELECT m.id, m.channel_id AS channelId, m.author_type AS authorType,
              m.author_id AS authorId,
              COALESCE(NULLIF(m.author_name, ''), u.name, a.name, 'Spaces') AS authorName,
              m.body, m.parent_id AS parentId, m.status, m.meta,
              m.run_id AS runId, m.created_at AS createdAt
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
         LEFT JOIN agent_profiles a ON m.author_type = 'agent' AND a.id = m.author_id
        WHERE c.workspace_id = ?
        ORDER BY m.created_at DESC
        LIMIT 240`,
      workspaceId,
    ),
    all<Issue>(
      `SELECT i.id, i.project_id AS projectId, i.cycle_id AS cycleId,
              i.title, i.description, i.status, i.priority,
              i.assignee_id AS assigneeId, assignee.name AS assigneeName,
              creator.name AS creatorName, i.due_date AS dueDate, i.source,
              i.created_at AS createdAt, i.updated_at AS updatedAt
         FROM issues i
         JOIN users creator ON creator.id = i.created_by
         LEFT JOIN users assignee ON assignee.id = i.assignee_id
        WHERE i.workspace_id = ?
        ORDER BY i.updated_at DESC`,
      workspaceId,
    ),
    all<Decision>(
      `SELECT d.id, d.title, d.body, u.name AS authorName,
              d.created_at AS createdAt
         FROM decisions d
         JOIN users u ON u.id = d.created_by
        WHERE d.workspace_id = ?
        ORDER BY d.created_at DESC`,
      workspaceId,
    ),
    loadSharedWorkspace(workspaceId, context.user.id),
    all<InboxItem & { labelsJson: string }>(
      `SELECT i.id, i.subject, i.body, i.sender_name AS senderName,
              i.sender_address AS senderAddress, i.status,
              i.assignee_id AS assigneeId, u.name AS assigneeName,
              i.labels_json AS labelsJson, i.created_at AS createdAt,
              i.updated_at AS updatedAt
         FROM inbox_items i
         LEFT JOIN users u ON u.id = i.assignee_id
        WHERE i.workspace_id = ?
        ORDER BY CASE i.status WHEN 'new' THEN 0 WHEN 'triaged' THEN 1
                              WHEN 'waiting' THEN 2 ELSE 3 END,
                 i.updated_at DESC`,
      workspaceId,
    ).then((rows) =>
      rows.map(({ labelsJson, ...item }) => ({
        ...item,
        labels: jsonArray(labelsJson),
      })),
    ),
    all<Project>(
      `SELECT p.id, p.name, p.summary, p.repo, p.status, p.lead_id AS leadId,
              p.target_date AS targetDate,
              SUM(CASE WHEN i.status != 'done' THEN 1 ELSE 0 END) AS openIssues,
              SUM(CASE WHEN i.status = 'done' THEN 1 ELSE 0 END) AS completedIssues
         FROM projects p
         LEFT JOIN issues i ON i.project_id = p.id
        WHERE p.workspace_id = ?
        GROUP BY p.id
        ORDER BY p.updated_at DESC`,
      workspaceId,
    ),
    all<AgentProfile & { cliArgsJson: string }>(
      `SELECT id, name, role, owns, backend, model, effort, status,
              owner_user_id AS ownerUserId, host_device_id AS hostDeviceId,
              visibility, persona, cli_args_json AS cliArgsJson,
              source_agent_id AS sourceAgentId
         FROM agent_profiles
        WHERE workspace_id = ?
        ORDER BY name`,
      workspaceId,
    ).then((rows) =>
      rows.map(({ cliArgsJson, ...agent }) => ({
        ...agent,
        cliArgs: jsonArray(cliArgsJson),
      })),
    ),
    all<Team>(
      `SELECT t.id, t.name, t.purpose,
              SUM(CASE WHEN a.actor_type = 'person' THEN 1 ELSE 0 END) AS people,
              SUM(CASE WHEN a.actor_type = 'agent' THEN 1 ELSE 0 END) AS agents
         FROM teams t
         LEFT JOIN team_actors a ON a.team_id = t.id
        WHERE t.workspace_id = ?
        GROUP BY t.id
        ORDER BY t.name`,
      workspaceId,
    ),
    all<Device & { toolsJson: string }>(
      `SELECT d.id, d.name, d.owner_user_id AS ownerUserId,
              COALESCE(u.name, 'Workspace member') AS ownerName,
              d.platform, d.tools_json AS toolsJson, d.status,
              d.last_seen_at AS lastSeenAt
         FROM devices d
         LEFT JOIN users u ON u.id = d.owner_user_id
        WHERE d.workspace_id = ?
        ORDER BY d.last_seen_at DESC`,
      workspaceId,
    ).then((rows) =>
      rows.map(({ toolsJson, ...device }) => ({
        ...device,
        tools: jsonArray(toolsJson),
      })),
    ),
    all<PendingInvite>(
      `SELECT id, email, role, expires_at AS expiresAt, created_at AS createdAt
         FROM invites
        WHERE workspace_id = ? AND accepted_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      workspaceId,
      now(),
    ),
    all<ConnectionRow>(
      `SELECT id, kind, label, status, account_label AS accountLabel,
              scopes_json AS scopesJson, last_sync_at AS lastSyncAt,
              created_by AS ownerUserId
         FROM connections
        WHERE workspace_id = ?
        ORDER BY kind, label`,
      workspaceId,
    ),
    all<ProjectConnectionRow>(
      `SELECT connection_id AS connectionId, project_id AS projectId,
              is_default AS isDefault
         FROM project_connections
        WHERE workspace_id = ?
        ORDER BY updated_at DESC`,
      workspaceId,
    ),
    all<{ deviceId: string; deviceName: string; updatedAt: string; payloadJson: string }>(
      `SELECT s.device_id AS deviceId, d.name AS deviceName,
              s.updated_at AS updatedAt, s.payload_json AS payloadJson
         FROM device_snapshots s
         JOIN devices d ON d.id = s.device_id
        WHERE s.workspace_id = ?
        ORDER BY s.updated_at DESC`,
      workspaceId,
    ).then((rows) =>
      rows.map(
        ({ payloadJson, ...snapshot }): DesktopSnapshot => ({
          ...snapshot,
          payload: jsonObject(payloadJson, {}),
        }),
      ),
    ),
    all<ActivityItem>(
      `SELECT a.id, a.kind, a.summary,
              COALESCE(u.name, 'Spaces desktop') AS actorName,
              a.created_at AS createdAt
         FROM activity a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.workspace_id = ?
        ORDER BY a.created_at DESC
        LIMIT 40`,
      workspaceId,
    ),
  ]);

  return {
    revision,
    currentUser: context.user,
    workspaces: context.workspaces,
    workspace: context.workspace,
    members,
    channels,
    messages: messages.reverse(),
    issues,
    decisions,
    knowledgePages: sharedContent.knowledgePages,
    calendars: sharedContent.calendars,
    calendarEvents: sharedContent.calendarEvents,
    contentItems: sharedContent.contentItems,
    inbox,
    projects: projects.map((project) => ({
      ...project,
      openIssues: Number(project.openIssues ?? 0),
      completedIssues: Number(project.completedIssues ?? 0),
    })),
    agents,
    teams: teams.map((team) => ({
      ...team,
      people: Number(team.people ?? 0),
      agents: Number(team.agents ?? 0),
    })),
    devices,
    pendingInvites,
    connections: visibleConnections(connections, context.user.id, connectionLinks),
    desktopSnapshots: snapshots,
    activity: activityItems,
  };
}

export async function loadWorkspaceSnapshot(
  headers: Headers,
  requestedWorkspaceId = "",
): Promise<WorkspaceSnapshot> {
  const context = await resolveWorkspace(headers, requestedWorkspaceId);
  return loadWorkspaceSnapshotForContext(context);
}

export async function loadWorkspaceUpdate(
  headers: Headers,
  requestedWorkspaceId = "",
  since: number | null = null,
): Promise<WorkspaceSnapshot | WorkspaceUnchanged> {
  const context = await resolveWorkspace(headers, requestedWorkspaceId);
  const revision = await workspaceRevision(context.workspace.id);
  if (since !== null && since >= revision) {
    return {
      unchanged: true,
      revision,
      workspaceId: context.workspace.id,
    };
  }
  return loadWorkspaceSnapshotForContext(context);
}

async function requireRole(
  context: WorkspaceContext,
  allowed: readonly WorkspaceRole[],
) {
  if (!allowed.includes(context.workspace.role)) {
    throw new Error("Your workspace role cannot perform this action.");
  }
}

interface MemberProfileActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

interface MemberProfilePatch {
  memberId: string;
  name?: string;
  role?: string;
}

async function applyMemberProfilePatch(
  actor: MemberProfileActor,
  patch: MemberProfilePatch,
  strict: boolean,
): Promise<boolean> {
  const member = await first<{
    id: string;
    name: string;
    email: string;
    role: WorkspaceRole;
  }>(
    `SELECT u.id, COALESCE(NULLIF(m.display_name, ''), u.name) AS name,
            u.email, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.user_id = ?`,
    actor.workspaceId,
    patch.memberId,
  );
  if (!member) {
    if (strict) throw new Error("That workspace member no longer exists.");
    return false;
  }

  let changed = false;
  const requestedName = text(patch.name, 120);
  if (requestedName && requestedName !== member.name) {
    const canRename =
      member.id === actor.userId ||
      actor.role === "owner" ||
      (actor.role === "admin" && member.role !== "owner");
    if (!canRename) {
      if (strict) throw new Error("Your workspace role cannot rename this member.");
    } else {
      await run(
        `UPDATE memberships
            SET display_name = ?
          WHERE workspace_id = ? AND user_id = ?`,
        requestedName,
        actor.workspaceId,
        member.id,
      );
      await activity(
        actor.workspaceId,
        actor.userId,
        "member.profile_changed",
        `Renamed ${member.name} to ${requestedName}`,
        member.id,
      );
      member.name = requestedName;
      changed = true;
    }
  }

  if (patch.role !== undefined && patch.role !== member.role) {
    const requestedRole = text(patch.role, 20);
    if (!["admin", "member", "guest"].includes(requestedRole)) {
      if (strict) throw new Error("Choose a valid workspace role.");
      return changed;
    }
    const role = requestedRole as Exclude<WorkspaceRole, "owner">;
    let roleError = "";
    if (!["owner", "admin"].includes(actor.role)) {
      roleError = "Your workspace role cannot perform this action.";
    } else if (member.role === "owner") {
      roleError = "The workspace owner role is protected.";
    } else if (member.id === actor.userId) {
      roleError = "You cannot change your own workspace role.";
    } else if (
      actor.role === "admin" &&
      (member.role === "admin" || role === "admin")
    ) {
      roleError = "Only the workspace owner can change administrator roles.";
    }
    if (roleError) {
      if (strict) throw new Error(roleError);
      return changed;
    }
    await run(
      `UPDATE memberships
          SET role = ?
        WHERE workspace_id = ? AND user_id = ?`,
      role,
      actor.workspaceId,
      member.id,
    );
    await activity(
      actor.workspaceId,
      actor.userId,
      "member.role_changed",
      `Changed ${member.name || member.email} to ${role}`,
      member.id,
    );
    changed = true;
  }

  return changed;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(bytes = 24): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function createWorkspaceInvite(
  actor: MemberProfileActor,
  emailValue: unknown,
  roleValue: unknown,
): Promise<MutationResult> {
  if (!["owner", "admin"].includes(actor.role)) {
    throw new Error("Your workspace role cannot perform this action.");
  }
  const email = text(emailValue, 240).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid teammate email.");
  }
  const role = oneOf(
    roleValue,
    ["admin", "member", "guest"] as const,
    "member",
  );
  const existingMember = await first<{ id: string }>(
    `SELECT u.id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND lower(u.email) = lower(?)`,
    actor.workspaceId,
    email,
  );
  if (existingMember) {
    throw new Error("That person is already a member of this workspace.");
  }
  const existingInvite = await first<{ id: string }>(
    `SELECT id
       FROM invites
      WHERE workspace_id = ? AND lower(email) = lower(?)
        AND accepted_at IS NULL AND expires_at > ?
      LIMIT 1`,
    actor.workspaceId,
    email,
    now(),
  );
  if (existingInvite) {
    throw new Error("That email already has an active workspace invitation.");
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  const inviteId = id("invite");
  const expiresAt = future(60 * 24 * 7);
  const createdAt = now();
  await run(
    `INSERT INTO invites
      (id, workspace_id, email, role, token_hash, invited_by,
       expires_at, accepted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    inviteId,
    actor.workspaceId,
    email,
    role,
    tokenHash,
    actor.userId,
    expiresAt,
    createdAt,
  );
  await activity(
    actor.workspaceId,
    actor.userId,
    "member.invited",
    `Invited ${email} as ${role}`,
    inviteId,
  );
  return {
    ok: true,
    invitePath: `/join/${encodeURIComponent(token)}`,
    expiresAt,
  };
}

export async function mutateWorkspace(
  headers: Headers,
  input: Record<string, unknown>,
): Promise<MutationResult> {
  const workspaceId = text(input.workspaceId, 120);
  const context = await resolveWorkspace(headers, workspaceId);
  const actionName = text(input.action, 80);
  const createdAt = now();

  if (actionName === "reset_workspace_history") {
    await requireRole(context, ["owner"]);
    const requiredConfirmation = `RESET HISTORY ${context.workspace.id}`;
    if (text(input.confirmation, 300) !== requiredConfirmation) {
      throw new Error(
        `Type "${requiredConfirmation}" to clear workspace history.`,
      );
    }

    const media = await db()
      .prepare(
        `SELECT object_key AS objectKey
           FROM media_assets
          WHERE workspace_id = ?`,
      )
      .bind(context.workspace.id)
      .all<{ objectKey: string }>();
    const storage = (env as unknown as { MEDIA?: R2Bucket }).MEDIA;
    const objectKeys = (media.results ?? [])
      .map((row) => row.objectKey)
      .filter(Boolean);
    if (objectKeys.length && !storage) {
      throw new Error(
        "Workspace media storage is unavailable, so Spaces refused to leave orphaned history behind.",
      );
    }
    for (let index = 0; index < objectKeys.length; index += 500) {
      await storage!.delete(objectKeys.slice(index, index + 500));
    }

    await db().batch([
      db()
        .prepare("DELETE FROM message_sources WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare(
          `DELETE FROM messages
            WHERE channel_id IN (
              SELECT id FROM channels WHERE workspace_id = ?
            )`,
        )
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM issue_sources WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM issues WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM decisions WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM knowledge_access WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM page_links WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM knowledge_pages WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM shared_calendar_events WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM calendar_commands WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM content_tombstones WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM content_items WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM inbox_items WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM cycles WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM agent_jobs WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM device_snapshots WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM media_assets WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM activity WHERE workspace_id = ?")
        .bind(context.workspace.id),
      db()
        .prepare("DELETE FROM workspace_events WHERE workspace_id = ?")
        .bind(context.workspace.id),
    ]);
    return { ok: true };
  }

  if (actionName === "create_issue") {
    const title = text(input.title, 180);
    if (!title) throw new Error("Issue title is required.");
    const issueId = id("issue");
    const status = oneOf(
      input.status,
      ["backlog", "ready", "in_progress", "review", "done"] as const,
      "backlog",
    );
    const priority = oneOf(
      input.priority,
      ["low", "normal", "high", "urgent"] as const,
      "normal",
    );
    await run(
      `INSERT INTO issues
        (id, workspace_id, project_id, cycle_id, title, description, status, priority,
         assignee_id, created_by, due_date, source, source_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'portal', NULL, ?, ?)`,
      issueId,
      context.workspace.id,
      text(input.projectId, 120) || null,
      title,
      text(input.description, 8_000),
      status,
      priority,
      text(input.assigneeId, 120) || null,
      context.user.id,
      text(input.dueDate, 32) || null,
      createdAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "issue.created",
      `Created “${title}”`,
      issueId,
    );
    return { ok: true };
  }

  if (actionName === "move_issue") {
    const issueId = text(input.issueId, 120);
    const status = oneOf(
      input.status,
      ["backlog", "ready", "in_progress", "review", "done"] as const,
      "backlog",
    );
    const issue = await first<{ title: string }>(
      "SELECT title FROM issues WHERE id = ? AND workspace_id = ?",
      issueId,
      context.workspace.id,
    );
    if (!issue) throw new Error("Issue not found.");
    await run(
      "UPDATE issues SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      status,
      createdAt,
      issueId,
      context.workspace.id,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "issue.moved",
      `Moved “${issue.title}” to ${status.replace("_", " ")}`,
      issueId,
    );
    return { ok: true };
  }

  if (actionName === "create_content") {
    await requireRole(context, ["owner", "admin", "member"]);
    const title = text(input.title, 300) || "Untitled";
    const projectId = text(input.projectId, 180);
    if (
      projectId &&
      !(await first(
        "SELECT 1 AS ok FROM projects WHERE workspace_id = ? AND id = ?",
        context.workspace.id,
        projectId,
      ))
    ) {
      throw new Error("Choose a project in this workspace.");
    }
    const connectionId = text(input.connectionId, 180);
    if (
      connectionId &&
      !(await first(
        `SELECT 1 AS ok FROM connections
          WHERE workspace_id = ? AND id = ?
            AND kind IN ('meta', 'tiktok', 'x')`,
        context.workspace.id,
        connectionId,
      ))
    ) {
      throw new Error("Choose a connected social account in this workspace.");
    }
    const agentId = text(input.agentId, 180);
    if (
      agentId &&
      !(await first(
        "SELECT 1 AS ok FROM agent_profiles WHERE workspace_id = ? AND id = ?",
        context.workspace.id,
        agentId,
      ))
    ) {
      throw new Error("Choose an agent in this workspace.");
    }
    const contentId = id("content");
    await run(
      `INSERT INTO content_items
        (id, workspace_id, project_id, campaign, title, brief, copy, platform,
         connection_id, status, scheduled_at, published_url, media_url,
         media_items, publish_error, agent_id, created_by, source_device_id,
         source_content_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '', ?, ?, ?, 0)`,
      contentId,
      context.workspace.id,
      projectId || null,
      text(input.campaign, 240),
      title,
      typeof input.brief === "string" ? input.brief.slice(0, 12_000) : "",
      typeof input.copy === "string" ? input.copy.slice(0, 30_000) : "",
      oneOf(
        input.platform,
        ["instagram", "tiktok", "x", "linkedin", "youtube", "multi"] as const,
        "multi",
      ),
      connectionId,
      oneOf(
        input.status,
        ["idea", "drafting", "review", "scheduled", "published"] as const,
        "idea",
      ),
      Math.max(0, Number(input.scheduledAt) || 0),
      text(input.publishedUrl, 2_000),
      text(input.mediaUrl, 2_000),
      text(input.mediaItems, 20_000) || "[]",
      agentId,
      context.user.id,
      contentId,
      createdAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "content.created",
      `Added “${title}” to Content Studio`,
      contentId,
    );
    await run(
      "UPDATE content_items SET revision = ? WHERE id = ? AND workspace_id = ?",
      await workspaceRevision(context.workspace.id),
      contentId,
      context.workspace.id,
    );
    return { ok: true };
  }

  if (actionName === "update_content") {
    await requireRole(context, ["owner", "admin", "member"]);
    const contentId = text(input.contentId, 180);
    const existing = await first<ContentItem>(
      `SELECT id, COALESCE(project_id, '') AS projectId, campaign, title, brief,
              copy, platform, connection_id AS connectionId, status,
              scheduled_at AS scheduledAt, published_url AS publishedUrl,
              media_url AS mediaUrl, media_items AS mediaItems,
              publish_error AS publishError,
              agent_id AS agentId, created_by AS createdBy,
              source_device_id AS sourceDeviceId,
              source_content_id AS sourceContentId,
              created_at AS createdAt, updated_at AS updatedAt, revision
         FROM content_items
        WHERE workspace_id = ? AND id = ?`,
      context.workspace.id,
      contentId,
    );
    if (!existing) throw new Error("Content item not found.");
    const has = (key: string) =>
      Object.prototype.hasOwnProperty.call(input, key);
    const projectId = has("projectId")
      ? text(input.projectId, 180)
      : existing.projectId;
    if (
      projectId &&
      !(await first(
        "SELECT 1 AS ok FROM projects WHERE workspace_id = ? AND id = ?",
        context.workspace.id,
        projectId,
      ))
    ) {
      throw new Error("Choose a project in this workspace.");
    }
    const connectionId = has("connectionId")
      ? text(input.connectionId, 180)
      : existing.connectionId;
    if (
      connectionId &&
      !(await first(
        `SELECT 1 AS ok FROM connections
          WHERE workspace_id = ? AND id = ?
            AND kind IN ('meta', 'tiktok', 'x')`,
        context.workspace.id,
        connectionId,
      ))
    ) {
      throw new Error("Choose a connected social account in this workspace.");
    }
    const agentId = has("agentId")
      ? text(input.agentId, 180)
      : existing.agentId;
    if (
      agentId &&
      !(await first(
        "SELECT 1 AS ok FROM agent_profiles WHERE workspace_id = ? AND id = ?",
        context.workspace.id,
        agentId,
      ))
    ) {
      throw new Error("Choose an agent in this workspace.");
    }
    const title = has("title")
      ? text(input.title, 300) || "Untitled"
      : existing.title;
    await run(
      `UPDATE content_items
          SET project_id = ?, campaign = ?, title = ?, brief = ?, copy = ?,
              platform = ?, connection_id = ?, status = ?, scheduled_at = ?,
              published_url = ?, media_url = ?, media_items = ?, publish_error = ?,
              agent_id = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
      projectId || null,
      has("campaign") ? text(input.campaign, 240) : existing.campaign,
      title,
      has("brief") && typeof input.brief === "string"
        ? input.brief.slice(0, 12_000)
        : existing.brief,
      has("copy") && typeof input.copy === "string"
        ? input.copy.slice(0, 30_000)
        : existing.copy,
      has("platform")
        ? oneOf(
            input.platform,
            ["instagram", "tiktok", "x", "linkedin", "youtube", "multi"] as const,
            existing.platform,
          )
        : existing.platform,
      connectionId,
      has("status")
        ? oneOf(
            input.status,
            ["idea", "drafting", "review", "scheduled", "published"] as const,
            existing.status,
          )
        : existing.status,
      has("scheduledAt")
        ? Math.max(0, Number(input.scheduledAt) || 0)
        : existing.scheduledAt,
      has("publishedUrl")
        ? text(input.publishedUrl, 2_000)
        : existing.publishedUrl,
      has("mediaUrl") ? text(input.mediaUrl, 2_000) : existing.mediaUrl,
      has("mediaItems")
        ? text(input.mediaItems, 20_000) || "[]"
        : existing.mediaItems,
      has("publishError") && typeof input.publishError === "string"
        ? input.publishError.slice(0, 4_000)
        : existing.publishError,
      agentId,
      createdAt,
      context.workspace.id,
      contentId,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "content.updated",
      `Updated “${title}”`,
      contentId,
    );
    await run(
      "UPDATE content_items SET revision = ? WHERE id = ? AND workspace_id = ?",
      await workspaceRevision(context.workspace.id),
      contentId,
      context.workspace.id,
    );
    return { ok: true };
  }

  if (actionName === "delete_content") {
    await requireRole(context, ["owner", "admin", "member"]);
    const contentId = text(input.contentId, 180);
    const item = await first<{ title: string }>(
      "SELECT title FROM content_items WHERE workspace_id = ? AND id = ?",
      context.workspace.id,
      contentId,
    );
    if (!item) throw new Error("Content item not found.");
    await run(
      "DELETE FROM content_items WHERE workspace_id = ? AND id = ?",
      context.workspace.id,
      contentId,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "content.deleted",
      `Deleted “${item.title}”`,
      contentId,
    );
    const revision = await workspaceRevision(context.workspace.id);
    await run(
      `INSERT INTO content_tombstones
        (id, workspace_id, entity, entity_id, created_by, revision, created_at)
       VALUES (?, ?, 'content_item', ?, ?, ?, ?)
       ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
         created_by = excluded.created_by,
         revision = excluded.revision,
         created_at = excluded.created_at`,
      id("tomb"),
      context.workspace.id,
      contentId,
      context.user.id,
      revision,
      createdAt,
    );
    return { ok: true };
  }

  if (actionName === "send_message") {
    const channelId = text(input.channelId, 120);
    const body = text(input.body, 12_000);
    if (!body) throw new Error("Message cannot be empty.");
    const channel = await first<{ name: string }>(
      "SELECT name FROM channels WHERE id = ? AND workspace_id = ?",
      channelId,
      context.workspace.id,
    );
    if (!channel) throw new Error("Channel not found.");
    const messageId = id("msg");
    await run(
      `INSERT INTO messages
        (id, channel_id, author_type, author_id, body, parent_id, created_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      messageId,
      channelId,
      context.user.id,
      body,
      text(input.parentId, 120),
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "message.sent",
      `Sent a message in #${channel.name}`,
      messageId,
    );
    return { ok: true };
  }

  if (actionName === "create_channel") {
    const name = slug(text(input.name, 64));
    if (!name) throw new Error("Channel name is required.");
    const channelId = id("ch");
    await run(
      `INSERT INTO channels
        (id, workspace_id, name, topic, mode, lead_agent_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      channelId,
      context.workspace.id,
      name,
      text(input.topic, 240),
      oneOf(
        input.mode,
        ["broadcast", "sequential", "lead", "panel"] as const,
        "lead",
      ),
      context.user.id,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "channel.created",
      `Created #${name}`,
      channelId,
    );
    return { ok: true };
  }

  if (actionName === "delete_channel") {
    await requireRole(context, ["owner", "admin"]);
    const channelId = text(input.channelId, 120);
    const channel = await first<{ name: string }>(
      "SELECT name FROM channels WHERE id = ? AND workspace_id = ?",
      channelId,
      context.workspace.id,
    );
    if (!channel) throw new Error("Channel not found.");
    await db().batch([
      db()
        .prepare(
          "DELETE FROM message_sources WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)",
        )
        .bind(channelId),
      db().prepare("DELETE FROM messages WHERE channel_id = ?").bind(channelId),
      db()
        .prepare(
          "DELETE FROM channel_sources WHERE workspace_id = ? AND channel_id = ?",
        )
        .bind(context.workspace.id, channelId),
      db()
        .prepare("DELETE FROM channels WHERE id = ? AND workspace_id = ?")
        .bind(channelId, context.workspace.id),
      db()
        .prepare(
          `INSERT INTO activity
            (id, workspace_id, actor_id, kind, summary, entity_id, created_at)
           VALUES (?, ?, ?, 'channel.deleted', ?, ?, ?)`,
        )
        .bind(
          id("act"),
          context.workspace.id,
          context.user.id,
          `Deleted #${channel.name}`,
          channelId,
          createdAt,
        ),
      db()
        .prepare(
          `INSERT INTO workspace_events
            (workspace_id, actor_id, kind, entity_id, created_at)
           VALUES (?, ?, 'channel.deleted', ?, ?)`,
        )
        .bind(context.workspace.id, context.user.id, channelId, createdAt),
      db()
        .prepare(
          `INSERT INTO content_tombstones
            (id, workspace_id, entity, entity_id, created_by, revision, created_at)
           VALUES (?, ?, 'channel', ?, ?,
             (SELECT COALESCE(MAX(sequence), 0) FROM workspace_events WHERE workspace_id = ?), ?)
           ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
             created_by = excluded.created_by,
             revision = excluded.revision,
             created_at = excluded.created_at`,
        )
        .bind(
          id("tomb"),
          context.workspace.id,
          channelId,
          context.user.id,
          context.workspace.id,
          createdAt,
        ),
    ]);
    return { ok: true };
  }

  if (actionName === "create_project") {
    const name = text(input.name, 120);
    if (!name) throw new Error("Project name is required.");
    const projectId = id("prj");
    await run(
      `INSERT INTO projects
        (id, workspace_id, name, summary, status, lead_id, target_date,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      projectId,
      context.workspace.id,
      name,
      text(input.summary, 1_200),
      text(input.leadId, 120) || null,
      text(input.targetDate, 32) || null,
      context.user.id,
      createdAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "project.created",
      `Started ${name}`,
      projectId,
    );
    return { ok: true };
  }

  if (actionName === "delete_project") {
    await requireRole(context, ["owner", "admin"]);
    const projectId = text(input.projectId, 120);
    const project = await first<{ name: string }>(
      "SELECT name FROM projects WHERE id = ? AND workspace_id = ?",
      projectId,
      context.workspace.id,
    );
    if (!project) throw new Error("Project not found.");
    const sources = await all<{ deviceId: string; sourceProjectId: string }>(
      `SELECT device_id AS deviceId, source_project_id AS sourceProjectId
         FROM project_sources
        WHERE workspace_id = ? AND project_id = ?`,
      context.workspace.id,
      projectId,
    );
    const activityId = id("act");
    const tombstoneId = id("tomb");
    const statements = [
      db()
        .prepare(
          `INSERT INTO activity
            (id, workspace_id, actor_id, kind, summary, entity_id, created_at)
           VALUES (?, ?, ?, 'project.deleted', ?, ?, ?)`,
        )
        .bind(
          activityId,
          context.workspace.id,
          context.user.id,
          `Deleted ${project.name}`,
          projectId,
          createdAt,
        ),
      db()
        .prepare(
          `INSERT INTO workspace_events
            (workspace_id, actor_id, kind, entity_id, created_at)
           VALUES (?, ?, 'project.deleted', ?, ?)`,
        )
        .bind(context.workspace.id, context.user.id, projectId, createdAt),
      db()
        .prepare(
          `INSERT INTO content_tombstones
            (id, workspace_id, entity, entity_id, created_by, revision, created_at)
           VALUES (?, ?, 'project', ?, ?,
             (SELECT COALESCE(MAX(sequence), 0) FROM workspace_events WHERE workspace_id = ?), ?)
           ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
             created_by = excluded.created_by,
             revision = excluded.revision,
             created_at = excluded.created_at`,
        )
        .bind(
          tombstoneId,
          context.workspace.id,
          projectId,
          context.user.id,
          context.workspace.id,
          createdAt,
        ),
      ...sources.map((source) =>
        db()
          .prepare(
            `INSERT INTO content_tombstones
              (id, workspace_id, entity, entity_id, created_by, revision, created_at)
             VALUES (?, ?, 'project_source', ?, ?,
               (SELECT COALESCE(MAX(sequence), 0) FROM workspace_events WHERE workspace_id = ?), ?)
             ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
               created_by = excluded.created_by,
               revision = excluded.revision,
               created_at = excluded.created_at`,
          )
          .bind(
            id("tomb"),
            context.workspace.id,
            JSON.stringify([source.deviceId, source.sourceProjectId]),
            context.user.id,
            context.workspace.id,
            createdAt,
          ),
      ),
      db()
        .prepare(
          `DELETE FROM message_sources
            WHERE message_id IN (
              SELECT m.id FROM messages m
              JOIN channels c ON c.id = m.channel_id
              WHERE c.workspace_id = ? AND c.project_id = ?
            )`,
        )
        .bind(context.workspace.id, projectId),
      db()
        .prepare(
          "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ? AND project_id = ?)",
        )
        .bind(context.workspace.id, projectId),
      db()
        .prepare(
          "DELETE FROM channel_sources WHERE workspace_id = ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ? AND project_id = ?)",
        )
        .bind(context.workspace.id, context.workspace.id, projectId),
      db()
        .prepare("DELETE FROM channels WHERE workspace_id = ? AND project_id = ?")
        .bind(context.workspace.id, projectId),
      db()
        .prepare(
          "DELETE FROM issue_sources WHERE workspace_id = ? AND issue_id IN (SELECT id FROM issues WHERE workspace_id = ? AND project_id = ?)",
        )
        .bind(context.workspace.id, context.workspace.id, projectId),
      db()
        .prepare("DELETE FROM issues WHERE workspace_id = ? AND project_id = ?")
        .bind(context.workspace.id, projectId),
      db()
        .prepare("DELETE FROM project_connections WHERE workspace_id = ? AND project_id = ?")
        .bind(context.workspace.id, projectId),
      db()
        .prepare(
          "UPDATE content_items SET project_id = NULL, updated_at = ? WHERE workspace_id = ? AND project_id = ?",
        )
        .bind(createdAt, context.workspace.id, projectId),
      db()
        .prepare("DELETE FROM project_sources WHERE workspace_id = ? AND project_id = ?")
        .bind(context.workspace.id, projectId),
      db()
        .prepare("DELETE FROM projects WHERE id = ? AND workspace_id = ?")
        .bind(projectId, context.workspace.id),
    ];
    await db().batch(statements);
    return { ok: true };
  }

  if (actionName === "create_knowledge") {
    const title = text(input.title, 180);
    if (!title) throw new Error("Page title is required.");
    const pageId = id("page");
    const path = knowledgePath(input.folder, title);
    await run(
      `INSERT INTO knowledge_pages
        (id, workspace_id, title, slug, body, kind, tags_json,
         created_by, owner_user_id, visibility, source_type, source_record_id,
         source_label, path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'workspace', 'portal', ?,
         'Workspace knowledge', ?, ?, ?)`,
      pageId,
      context.workspace.id,
      title,
      `${slug(title)}-${pageId.slice(-4)}`,
      text(input.body, 30_000),
      oneOf(
        input.kind,
        ["note", "brief", "runbook", "charter", "research"] as const,
        "note",
      ),
      JSON.stringify(
        text(input.tags, 600)
          .split(",")
          .map((tag) => slug(tag))
          .filter(Boolean)
          .slice(0, 12),
      ),
      context.user.id,
      context.user.id,
      pageId,
      path,
      createdAt,
      createdAt,
    );
    await rebuildPageLinks(context.workspace.id);
    await activity(
      context.workspace.id,
      context.user.id,
      "knowledge.created",
      `Added “${title}” to knowledge`,
      pageId,
    );
    return { ok: true };
  }

  if (actionName === "update_knowledge") {
    const pageId = text(input.pageId, 180);
    const existing = await first<{
      id: string;
      title: string;
      ownerUserId: string;
      sourceType: string;
    }>(
      `SELECT id, title, owner_user_id AS ownerUserId, source_type AS sourceType
         FROM knowledge_pages
        WHERE id = ? AND workspace_id = ?`,
      pageId,
      context.workspace.id,
    );
    if (!existing) throw new Error("Knowledge page not found.");
    if (existing.sourceType !== "portal") {
      throw new Error("Imported vault files are edited at their source.");
    }
    const canAdmin =
      context.workspace.role === "owner" || context.workspace.role === "admin";
    if (existing.ownerUserId !== context.user.id && !canAdmin) {
      throw new Error("You do not have write access to this page.");
    }
    const title = text(input.title, 180);
    if (!title) throw new Error("Page title is required.");
    const path = knowledgePath(input.folder, title);
    await run(
      `UPDATE knowledge_pages
          SET title = ?, slug = ?, body = ?, kind = ?, tags_json = ?,
              source_label = 'Workspace knowledge', path = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
      title,
      `${slug(title)}-${pageId.slice(-4)}`,
      text(input.body, 30_000),
      oneOf(
        input.kind,
        ["note", "brief", "runbook", "charter", "research"] as const,
        "note",
      ),
      JSON.stringify(
        text(input.tags, 600)
          .split(",")
          .map((tag) => slug(tag))
          .filter(Boolean)
          .slice(0, 12),
      ),
      path,
      createdAt,
      pageId,
      context.workspace.id,
    );
    await rebuildPageLinks(context.workspace.id);
    await activity(
      context.workspace.id,
      context.user.id,
      "knowledge.updated",
      `Updated “${title}”`,
      pageId,
    );
    return { ok: true };
  }

  if (actionName === "create_calendar") {
    const name = text(input.name, 180);
    if (!name) throw new Error("Calendar name is required.");
    const calendarId = id("cal");
    const ownerType = oneOf(
      input.ownerType,
      ["member", "team", "workspace"] as const,
      "member",
    );
    let ownerId = context.user.id;
    let ownerLabel = context.user.name;
    if (ownerType === "workspace") {
      ownerId = context.workspace.id;
      ownerLabel = "Workspace";
    } else if (ownerType === "team") {
      const requestedTeamId = text(input.ownerId, 180);
      const team = await first<{ id: string; name: string }>(
        "SELECT id, name FROM teams WHERE workspace_id = ? AND id = ?",
        context.workspace.id,
        requestedTeamId,
      );
      if (!team) throw new Error("Choose a team in this workspace.");
      ownerId = team.id;
      ownerLabel = team.name;
    }
    const visibility = oneOf(
      input.visibility,
      ["private", "busy", "read", "write"] as const,
      ownerType === "member" ? "private" : "read",
    );
    await run(
      `INSERT INTO shared_calendars
        (id, workspace_id, source_device_id, source_calendar_id, name, color,
         provider, external_id, owner_type, owner_id, owner_label, visibility,
         writable, created_by, created_at, updated_at, revision)
       VALUES (?, ?, '', ?, ?, ?, 'hq', '', ?, ?, ?, ?, 1, ?, ?, ?, 0)`,
      calendarId,
      context.workspace.id,
      calendarId,
      name,
      text(input.color, 60),
      ownerType,
      ownerId,
      ownerLabel,
      visibility,
      context.user.id,
      createdAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "calendar.created",
      `Created “${name}”`,
      calendarId,
    );
    await run(
      "UPDATE shared_calendars SET revision = ? WHERE id = ? AND workspace_id = ?",
      await workspaceRevision(context.workspace.id),
      calendarId,
      context.workspace.id,
    );
    return { ok: true };
  }

  if (actionName === "create_calendar_event") {
    const calendarId = text(input.calendarId, 180);
    const title = text(input.title, 300);
    if (!calendarId || !title) throw new Error("Choose a calendar and enter an event title.");
    const shared = await loadSharedWorkspace(context.workspace.id, context.user.id);
    const calendar = shared.calendars.find((candidate) => candidate.id === calendarId);
    if (!calendar || calendar.access !== "write" || !calendar.writable) {
      throw new Error("You do not have write access to that calendar.");
    }
    const startsAt = Date.parse(text(input.startsAt, 80));
    const endsAt = Date.parse(text(input.endsAt, 80));
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      throw new Error("Choose a valid start and end time.");
    }
    let externalId = "";
    let source = "hq";
    if (calendar.provider === "google" || calendar.provider === "microsoft") {
      const upstream = await createConnectedCalendarEvent(
        context.workspace.id,
        context.user.id,
        calendar.provider,
        {
          title,
          startAt: startsAt,
          endAt: endsAt,
          allDay: input.allDay === true,
          location: text(input.location, 500),
          notes: text(input.description, 12_000),
          calendarId: calendar.externalId,
          calendarName: calendar.name,
        },
      );
      externalId = String(upstream.id ?? "");
      source = calendar.provider;
      if (!externalId) {
        throw new Error(`${calendar.provider} did not confirm the new event.`);
      }
    } else if (calendar.provider === "apple") {
      if (!calendar.sourceDeviceId) {
        throw new Error(
          "This Apple calendar is not attached to a paired desktop.",
        );
      }
      source = "apple_pending";
    }
    const eventId = id("event");
    await run(
      `INSERT INTO shared_calendar_events
        (id, workspace_id, calendar_id, source_device_id, source_event_id,
         external_id, title, description, location, starts_at, ends_at,
         all_day, tz, organizer, attendees_json, status, source, etag,
         created_by, created_at, updated_at, revision)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]',
               'confirmed', ?, '', ?, ?, ?, 0)`,
      eventId,
      context.workspace.id,
      calendarId,
      eventId,
      externalId,
      title,
      text(input.description, 12_000),
      text(input.location, 500),
      startsAt,
      endsAt,
      input.allDay === true ? 1 : 0,
      text(input.tz, 100) || "UTC",
      context.user.email,
      source,
      context.user.id,
      createdAt,
      createdAt,
    );
    if (calendar.provider === "apple") {
      await run(
        `INSERT INTO calendar_commands
          (id, workspace_id, device_id, event_id, calendar_name, payload_json,
           status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', '', ?, ?)`,
        id("calcmd"),
        context.workspace.id,
        calendar.sourceDeviceId,
        eventId,
        calendar.externalId || calendar.name,
        JSON.stringify({
          title,
          startAt: startsAt,
          endAt: endsAt,
          calendarName: calendar.externalId || calendar.name,
          location: text(input.location, 500),
          notes: text(input.description, 12_000),
        }),
        createdAt,
        createdAt,
      );
    }
    await activity(
      context.workspace.id,
      context.user.id,
      "calendar.event_created",
      `Scheduled “${title}”`,
      eventId,
    );
    await run(
      "UPDATE shared_calendar_events SET revision = ? WHERE id = ? AND workspace_id = ?",
      await workspaceRevision(context.workspace.id),
      eventId,
      context.workspace.id,
    );
    return {
      ok: true,
      delivery:
        calendar.provider === "apple"
          ? "queued_for_desktop"
          : source === "hq"
            ? "spaces"
            : "provider",
    };
  }

  if (actionName === "create_decision") {
    const title = text(input.title, 180);
    if (!title) throw new Error("Decision title is required.");
    const decisionId = id("decision");
    await run(
      `INSERT INTO decisions
        (id, workspace_id, title, body, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      decisionId,
      context.workspace.id,
      title,
      text(input.body, 12_000),
      context.user.id,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "decision.recorded",
      `Recorded “${title}”`,
      decisionId,
    );
    return { ok: true };
  }

  if (actionName === "capture_inbox") {
    const subject = text(input.subject, 180);
    if (!subject) throw new Error("Inbox subject is required.");
    const inboxId = id("inbox");
    await run(
      `INSERT INTO inbox_items
        (id, workspace_id, subject, body, sender_name, sender_address,
         status, assignee_id, labels_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?, ?, ?)`,
      inboxId,
      context.workspace.id,
      subject,
      text(input.body, 12_000),
      text(input.senderName, 120) || context.user.name,
      text(input.senderAddress, 180) || context.user.email,
      JSON.stringify(
        text(input.labels, 500)
          .split(",")
          .map((label) => slug(label))
          .filter(Boolean)
          .slice(0, 10),
      ),
      context.user.id,
      createdAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "inbox.captured",
      `Captured “${subject}”`,
      inboxId,
    );
    return { ok: true };
  }

  if (actionName === "update_inbox") {
    const inboxId = text(input.inboxId, 120);
    const status = oneOf(
      input.status,
      ["new", "triaged", "waiting", "done"] as const,
      "triaged",
    );
    const inboxItem = await first<{ subject: string }>(
      "SELECT subject FROM inbox_items WHERE id = ? AND workspace_id = ?",
      inboxId,
      context.workspace.id,
    );
    if (!inboxItem) throw new Error("Inbox item not found.");
    await run(
      "UPDATE inbox_items SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      status,
      createdAt,
      inboxId,
      context.workspace.id,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "inbox.updated",
      `Marked “${inboxItem.subject}” ${status}`,
      inboxId,
    );
    return { ok: true };
  }

  if (actionName === "create_agent") {
    await requireRole(context, ["owner", "admin", "member"]);
    const name = text(input.name, 100);
    if (!name) throw new Error("Agent name is required.");
    const agentId = id("agent");
    const hostDeviceId = text(input.hostDeviceId, 160);
    if (hostDeviceId) {
      const host = await first<{ id: string; ownerUserId: string }>(
        `SELECT id, owner_user_id AS ownerUserId
           FROM devices
          WHERE id = ? AND workspace_id = ?`,
        hostDeviceId,
        context.workspace.id,
      );
      if (!host) throw new Error("Choose a paired device in this workspace.");
      if (
        context.workspace.role === "member" &&
        host.ownerUserId !== context.user.id
      ) {
        throw new Error("Members can host agents only on their own paired desktops.");
      }
    }
    await run(
      `INSERT INTO agent_profiles
        (id, workspace_id, name, role, owns, backend, model, effort, status,
         owner_user_id, host_device_id, visibility, persona, cli_args_json,
         source_agent_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?, ?, '', ?, ?, ?)`,
      agentId,
      context.workspace.id,
      name,
      text(input.role, 120),
      text(input.owns, 500),
      oneOf(input.backend, ["claude", "codex", "ritz", "custom"] as const, "codex"),
      text(input.model, 160),
      oneOf(
        input.effort,
        ["", "low", "medium", "high", "xhigh", "max", "deep", "standard"] as const,
        "",
      ),
      context.user.id,
      hostDeviceId || null,
      oneOf(input.visibility, ["private", "workspace"] as const, "workspace"),
      text(input.persona, 8_000),
      JSON.stringify(
        Array.isArray(input.cliArgs)
          ? input.cliArgs.map((value) => text(value, 500)).filter(Boolean).slice(0, 32)
          : [],
      ),
      context.user.id,
      createdAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "agent.created",
      `Configured ${name}`,
      agentId,
    );
    return { ok: true };
  }

  if (actionName === "create_team") {
    const name = text(input.name, 100);
    if (!name) throw new Error("Team name is required.");
    const teamId = id("team");
    await run(
      `INSERT INTO teams
        (id, workspace_id, name, purpose, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      teamId,
      context.workspace.id,
      name,
      text(input.purpose, 600),
      context.user.id,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "team.created",
      `Created ${name}`,
      teamId,
    );
    return { ok: true };
  }

  if (actionName === "create_invite") {
    return createWorkspaceInvite(
      {
        workspaceId: context.workspace.id,
        userId: context.user.id,
        role: context.workspace.role,
      },
      input.email,
      input.role,
    );
  }

  if (actionName === "update_member_role") {
    await requireRole(context, ["owner", "admin"]);
    const memberId = text(input.memberId, 160);
    await applyMemberProfilePatch(
      {
        workspaceId: context.workspace.id,
        userId: context.user.id,
        role: context.workspace.role,
      },
      { memberId, role: text(input.role, 20) },
      true,
    );
    return { ok: true };
  }

  if (actionName === "remove_member") {
    await requireRole(context, ["owner"]);
    const memberId = text(input.memberId, 160);
    const member = await first<{
      id: string;
      email: string;
      name: string;
      role: WorkspaceRole;
    }>(
      `SELECT u.id, u.email, COALESCE(NULLIF(m.display_name, ''), u.name) AS name,
              m.role
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.user_id = ?`,
      context.workspace.id,
      memberId,
    );
    if (!member) throw new Error("That person is no longer in this workspace.");
    if (member.role === "owner") throw new Error("The workspace owner is protected.");
    if (member.id === context.user.id) throw new Error("You cannot remove yourself.");

    const statements = [
      db()
        .prepare(
          `UPDATE agent_jobs
              SET status = 'failed',
                  error = 'Agent owner was removed from the workspace',
                  lease_token_hash = NULL,
                  lease_expires_at = NULL,
                  finished_at = ?,
                  updated_at = ?
            WHERE workspace_id = ?
              AND status IN ('pending_approval', 'queued', 'claimed', 'running')
              AND (
                agent_id IN (
                  SELECT id FROM agent_profiles
                   WHERE workspace_id = ? AND owner_user_id = ?
                )
                OR host_device_id IN (
                  SELECT id FROM devices
                   WHERE workspace_id = ? AND owner_user_id = ?
                )
              )`,
        )
        .bind(
          createdAt,
          createdAt,
          context.workspace.id,
          context.workspace.id,
          member.id,
          context.workspace.id,
          member.id,
        ),
      db()
        .prepare(
          `DELETE FROM team_actors
            WHERE actor_type = 'agent'
              AND actor_id IN (
                SELECT id FROM agent_profiles
                 WHERE workspace_id = ? AND owner_user_id = ?
              )`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `UPDATE channels SET lead_agent_id = NULL
            WHERE workspace_id = ?
              AND lead_agent_id IN (
                SELECT id FROM agent_profiles
                 WHERE workspace_id = ? AND owner_user_id = ?
              )`,
        )
        .bind(context.workspace.id, context.workspace.id, member.id),
      db()
        .prepare(
          `UPDATE issues SET assignee_id = NULL, updated_at = ?
            WHERE workspace_id = ?
              AND (
                assignee_id = ?
                OR assignee_id IN (
                  SELECT id FROM agent_profiles
                   WHERE workspace_id = ? AND owner_user_id = ?
                )
              )`,
        )
        .bind(
          createdAt,
          context.workspace.id,
          member.id,
          context.workspace.id,
          member.id,
        ),
      db()
        .prepare(
          `DELETE FROM device_snapshots
            WHERE device_id IN (
              SELECT id FROM devices
               WHERE workspace_id = ? AND owner_user_id = ?
            )`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM project_sources
            WHERE workspace_id = ?
              AND device_id IN (
                SELECT id FROM devices
                 WHERE workspace_id = ? AND owner_user_id = ?
              )`,
        )
        .bind(context.workspace.id, context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM calendar_commands
            WHERE workspace_id = ?
              AND device_id IN (
                SELECT id FROM devices
                 WHERE workspace_id = ? AND owner_user_id = ?
              )`,
        )
        .bind(context.workspace.id, context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM devices
            WHERE workspace_id = ? AND owner_user_id = ?`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM shared_calendar_events
            WHERE workspace_id = ?
              AND calendar_id IN (
                SELECT id FROM shared_calendars
                 WHERE workspace_id = ? AND owner_type = 'member' AND owner_id = ?
              )`,
        )
        .bind(context.workspace.id, context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM shared_calendar_access
            WHERE workspace_id = ?
              AND calendar_id IN (
                SELECT id FROM shared_calendars
                 WHERE workspace_id = ? AND owner_type = 'member' AND owner_id = ?
              )`,
        )
        .bind(context.workspace.id, context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM shared_calendars
            WHERE workspace_id = ? AND owner_type = 'member' AND owner_id = ?`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM knowledge_pages
            WHERE workspace_id = ? AND owner_user_id = ? AND visibility = 'private'`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `UPDATE knowledge_pages
              SET owner_user_id = ?, updated_at = ?
            WHERE workspace_id = ? AND owner_user_id = ? AND visibility = 'workspace'`,
        )
        .bind(
          context.user.id,
          createdAt,
          context.workspace.id,
          member.id,
        ),
      db()
        .prepare(
          `DELETE FROM connection_secrets
            WHERE connection_id IN (
              SELECT id FROM connections
               WHERE workspace_id = ? AND created_by = ?
                 AND kind NOT IN ('meta', 'tiktok', 'x')
            )`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `DELETE FROM connections
            WHERE workspace_id = ? AND created_by = ?
              AND kind NOT IN ('meta', 'tiktok', 'x')`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          `UPDATE connections
              SET created_by = ?, updated_at = ?
            WHERE workspace_id = ? AND created_by = ?
              AND kind IN ('meta', 'tiktok', 'x')`,
        )
        .bind(
          context.user.id,
          createdAt,
          context.workspace.id,
          member.id,
        ),
      db()
        .prepare(
          `DELETE FROM invites
            WHERE workspace_id = ?
              AND lower(email) = lower(?)`,
        )
        .bind(context.workspace.id, member.email),
      db()
        .prepare(
          `DELETE FROM agent_profiles
            WHERE workspace_id = ? AND owner_user_id = ?`,
        )
        .bind(context.workspace.id, member.id),
      db()
        .prepare(
          "DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
        )
        .bind(context.workspace.id, member.id),
    ];
    await db().batch(statements);
    await activity(
      context.workspace.id,
      context.user.id,
      "member.removed",
      `Removed ${member.name || member.email} and their agents`,
      member.id,
    );
    return { ok: true };
  }

  if (
    actionName === "link_project_connection" ||
    actionName === "unlink_project_connection" ||
    actionName === "set_project_connection_default"
  ) {
    await requireRole(context, ["owner", "admin"]);
    const projectId = text(input.projectId, 160);
    const connectionId = text(input.connectionId, 160);
    const project = await first<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE id = ? AND workspace_id = ?",
      projectId,
      context.workspace.id,
    );
    const connection = await first<{
      id: string;
      kind: string;
      accountLabel: string;
    }>(
      `SELECT id, kind, account_label AS accountLabel
         FROM connections
        WHERE id = ? AND workspace_id = ? AND status = 'connected'`,
      connectionId,
      context.workspace.id,
    );
    if (!project) throw new Error("That project no longer exists.");
    if (!connection) throw new Error("That connected account no longer exists.");
    if (connectionAudience(connection.kind) !== "workspace") {
      throw new Error("Only shared social accounts can be linked to projects.");
    }

    if (actionName === "link_project_connection") {
      const existingDefault = await first<{ connectionId: string }>(
        `SELECT pc.connection_id AS connectionId
           FROM project_connections pc
           JOIN connections c ON c.id = pc.connection_id
          WHERE pc.workspace_id = ? AND pc.project_id = ?
            AND c.kind = ? AND pc.is_default = 1
          LIMIT 1`,
        context.workspace.id,
        project.id,
        connection.kind,
      );
      await run(
        `INSERT INTO project_connections
          (workspace_id, project_id, connection_id, is_default,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, connection_id) DO UPDATE SET
           updated_at=excluded.updated_at`,
        context.workspace.id,
        project.id,
        connection.id,
        existingDefault ? 0 : 1,
        context.user.id,
        createdAt,
        createdAt,
      );
      await activity(
        context.workspace.id,
        context.user.id,
        "connection.project_linked",
        `Linked ${connection.accountLabel || connection.kind} to ${project.name}`,
        connection.id,
      );
      return { ok: true };
    }

    const link = await first<{ isDefault: number }>(
      `SELECT is_default AS isDefault
         FROM project_connections
        WHERE workspace_id = ? AND project_id = ? AND connection_id = ?`,
      context.workspace.id,
      project.id,
      connection.id,
    );
    if (!link) throw new Error("That account is not linked to this project.");

    if (actionName === "set_project_connection_default") {
      await db().batch([
        db()
          .prepare(
            `UPDATE project_connections
                SET is_default = 0, updated_at = ?
              WHERE workspace_id = ? AND project_id = ?
                AND connection_id IN (
                  SELECT id FROM connections
                   WHERE workspace_id = ? AND kind = ?
                )`,
          )
          .bind(
            createdAt,
            context.workspace.id,
            project.id,
            context.workspace.id,
            connection.kind,
          ),
        db()
          .prepare(
            `UPDATE project_connections
                SET is_default = 1, updated_at = ?
              WHERE workspace_id = ? AND project_id = ? AND connection_id = ?`,
          )
          .bind(createdAt, context.workspace.id, project.id, connection.id),
      ]);
      await activity(
        context.workspace.id,
        context.user.id,
        "connection.project_default_changed",
        `Set ${connection.accountLabel || connection.kind} as ${project.name}'s default ${connection.kind} account`,
        connection.id,
      );
      return { ok: true };
    }

    await run(
      `DELETE FROM project_connections
        WHERE workspace_id = ? AND project_id = ? AND connection_id = ?`,
      context.workspace.id,
      project.id,
      connection.id,
    );
    if (link.isDefault) {
      const replacement = await first<{ connectionId: string }>(
        `SELECT pc.connection_id AS connectionId
           FROM project_connections pc
           JOIN connections c ON c.id = pc.connection_id
          WHERE pc.workspace_id = ? AND pc.project_id = ? AND c.kind = ?
          ORDER BY pc.updated_at DESC
          LIMIT 1`,
        context.workspace.id,
        project.id,
        connection.kind,
      );
      if (replacement) {
        await run(
          `UPDATE project_connections
              SET is_default = 1, updated_at = ?
            WHERE workspace_id = ? AND project_id = ? AND connection_id = ?`,
          createdAt,
          context.workspace.id,
          project.id,
          replacement.connectionId,
        );
      }
    }
    await activity(
      context.workspace.id,
      context.user.id,
      "connection.project_unlinked",
      `Unlinked ${connection.accountLabel || connection.kind} from ${project.name}`,
      connection.id,
    );
    return { ok: true };
  }

  if (actionName === "create_device_code") {
    await requireRole(context, ["owner", "admin", "member"]);
    const code = pairingCode();
    const codeHash = await sha256(code);
    const expiresAt = future(15);
    const codeId = id("code");
    await run(
      `INSERT INTO device_codes
        (id, workspace_id, code_hash, created_by, expires_at, claimed_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      codeId,
      context.workspace.id,
      codeHash,
      context.user.id,
      expiresAt,
      createdAt,
    );
    await activity(
      context.workspace.id,
      context.user.id,
      "device.pairing_code_created",
      "Created a desktop pairing code",
      codeId,
    );
    return { ok: true, pairingCode: code, expiresAt };
  }

  if (actionName === "revoke_device") {
    await requireRole(context, ["owner", "admin", "member"]);
    const deviceId = text(input.deviceId, 160);
    const device = await first<{
      id: string;
      name: string;
      ownerUserId: string;
    }>(
      `SELECT id, name, owner_user_id AS ownerUserId
         FROM devices
        WHERE id = ? AND workspace_id = ?`,
      deviceId,
      context.workspace.id,
    );
    if (!device) throw new Error("That desktop is no longer paired.");
    if (
      context.workspace.role === "member" &&
      device.ownerUserId !== context.user.id
    ) {
      throw new Error("Members can only revoke their own desktops.");
    }
    await db().batch([
      db().prepare("DELETE FROM device_snapshots WHERE device_id = ?").bind(device.id),
      db().prepare("DELETE FROM project_sources WHERE device_id = ?").bind(device.id),
      db()
        .prepare(
          `UPDATE agent_jobs
              SET status = 'failed',
                  error = 'Host device access was revoked',
                  lease_token_hash = NULL,
                  lease_expires_at = NULL,
                  finished_at = ?,
                  updated_at = ?
            WHERE workspace_id = ? AND host_device_id = ?
              AND status IN ('queued', 'claimed', 'running')`,
        )
        .bind(createdAt, createdAt, context.workspace.id, device.id),
      db()
        .prepare(
          `UPDATE agent_profiles
              SET host_device_id = NULL, status = 'offline', updated_at = ?
            WHERE workspace_id = ? AND host_device_id = ?`,
        )
        .bind(createdAt, context.workspace.id, device.id),
      db().prepare("DELETE FROM devices WHERE id = ?").bind(device.id),
    ]);
    await activity(
      context.workspace.id,
      context.user.id,
      "device.revoked",
      `Revoked ${device.name}`,
      device.id,
    );
    return { ok: true };
  }

  throw new Error("Unknown Spaces action.");
}

export async function inspectInvite(headers: Headers, token: string) {
  const identity = requirePortalUser(headers);
  const tokenHash = await sha256(token);
  const invite = await first<{
    id: string;
    workspaceId: string;
    workspaceName: string;
    email: string;
    role: WorkspaceRole;
    expiresAt: string;
    acceptedAt: string | null;
  }>(
    `SELECT i.id, i.workspace_id AS workspaceId, w.name AS workspaceName,
            i.email, i.role, i.expires_at AS expiresAt,
            i.accepted_at AS acceptedAt
       FROM invites i
       JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.token_hash = ?`,
    tokenHash,
  );
  if (!invite) throw new Error("This invite link is invalid.");
  const expired = invite.expiresAt <= now();
  return {
    workspaceName: invite.workspaceName,
    role: invite.role,
    invitedEmail: invite.email,
    signedInEmail: identity.email,
    accepted: Boolean(invite.acceptedAt),
    expired,
    canAccept:
      !invite.acceptedAt &&
      !expired &&
      invite.email.toLowerCase() === identity.email.toLowerCase(),
  };
}

export async function acceptInvite(headers: Headers, token: string) {
  const identity = requirePortalUser(headers);
  const tokenHash = await sha256(token);
  const invite = await first<{
    id: string;
    workspaceId: string;
    email: string;
    role: WorkspaceRole;
    expiresAt: string;
    acceptedAt: string | null;
  }>(
    `SELECT id, workspace_id AS workspaceId, email, role,
            expires_at AS expiresAt, accepted_at AS acceptedAt
       FROM invites
      WHERE token_hash = ?`,
    tokenHash,
  );
  if (!invite || invite.acceptedAt || invite.expiresAt <= now()) {
    throw new Error("This invite is no longer available.");
  }
  if (invite.email.toLowerCase() !== identity.email.toLowerCase()) {
    throw new Error(`Sign in as ${invite.email} to accept this invite.`);
  }

  let user = await first<{ id: string }>(
    "SELECT id FROM users WHERE email = ?",
    identity.email,
  );
  const acceptedAt = now();
  if (!user) {
    user = { id: id("usr") };
    await run(
      `INSERT INTO users (id, email, name, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
      user.id,
      identity.email,
      identity.name,
      acceptedAt,
      acceptedAt,
    );
  }
  await db().batch([
    db()
      .prepare(
        `INSERT OR IGNORE INTO memberships
          (workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(invite.workspaceId, user.id, invite.role, acceptedAt),
    db()
      .prepare("UPDATE invites SET accepted_at = ? WHERE id = ?")
      .bind(acceptedAt, invite.id),
  ]);
  await activity(
    invite.workspaceId,
    user.id,
    "member.joined",
    `${identity.name} joined the workspace`,
    user.id,
  );
  return { ok: true, workspaceId: invite.workspaceId };
}

export async function claimDevice(code: string, name: string) {
  const codeHash = await sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  const record = await first<{
    id: string;
    workspaceId: string;
    createdBy: string;
    expiresAt: string;
    claimedAt: string | null;
  }>(
    `SELECT id, workspace_id AS workspaceId, created_by AS createdBy,
            expires_at AS expiresAt,
            claimed_at AS claimedAt
       FROM device_codes
      WHERE code_hash = ?`,
    codeHash,
  );
  if (!record || record.claimedAt || record.expiresAt <= now()) {
    throw new Error("Pairing code is invalid or expired.");
  }
  const deviceId = id("device");
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const claimedAt = now();
  await db().batch([
    db()
      .prepare(
        `INSERT INTO devices
          (id, workspace_id, name, token_hash, owner_user_id, platform,
           tools_json, status, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, '', '[]', 'online', ?, ?)`,
      )
      .bind(
        deviceId,
        record.workspaceId,
        text(name, 100) || "Spaces desktop",
        tokenHash,
        record.createdBy,
        claimedAt,
        claimedAt,
      ),
    db()
      .prepare("UPDATE device_codes SET claimed_at = ? WHERE id = ?")
      .bind(claimedAt, record.id),
  ]);
  await activity(
    record.workspaceId,
    deviceId,
    "device.paired",
    `Paired ${text(name, 100) || "Spaces desktop"}`,
    deviceId,
  );
  return {
    ok: true,
    deviceId,
    workspaceId: record.workspaceId,
    ownerUserId: record.createdBy,
    token,
  };
}

export async function authorizeDevice(token: string) {
  const tokenHash = await sha256(token);
  const device = await first<{
    id: string;
    workspaceId: string;
    ownerUserId: string;
  }>(
    `SELECT id, workspace_id AS workspaceId, owner_user_id AS ownerUserId
       FROM devices
      WHERE token_hash = ?`,
    tokenHash,
  );
  if (!device) throw new Error("Desktop connection is not authorized.");
  return device;
}

export async function mutateDeviceMember(
  token: string,
  input: Record<string, unknown>,
): Promise<MutationResult> {
  const device = await authorizeDevice(token);
  const actor = await first<{ role: WorkspaceRole }>(
    `SELECT role
       FROM memberships
      WHERE workspace_id = ? AND user_id = ?`,
    device.workspaceId,
    device.ownerUserId,
  );
  if (!actor) {
    throw new Error("The paired desktop owner is no longer a workspace member.");
  }

  const actionName = text(input.action, 80);
  if (actionName === "create_invite") {
    return createWorkspaceInvite(
      {
        workspaceId: device.workspaceId,
        userId: device.ownerUserId,
        role: actor.role,
      },
      input.email,
      input.role,
    );
  }
  throw new Error("Unknown Spaces member action.");
}

export async function syncDevice(token: string, payload: unknown) {
  const device = await authorizeDevice(token);
  const updatedAt = now();
  const body =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const platform = text(body.platform, 160);
  const tools = Array.isArray(body.tools)
    ? body.tools.map((value) => text(value, 80)).filter(Boolean).slice(0, 64)
    : [];
  const encoded = JSON.stringify(body).slice(0, 500_000);
  const previousSnapshot = await first<{ payloadJson: string }>(
    "SELECT payload_json AS payloadJson FROM device_snapshots WHERE device_id = ?",
    device.id,
  );
  await db().batch([
    db()
      .prepare(
        `INSERT INTO device_snapshots
          (device_id, workspace_id, payload_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .bind(device.id, device.workspaceId, encoded, updatedAt),
    db()
      .prepare(
        `UPDATE devices
            SET status = 'online', last_seen_at = ?, platform = ?, tools_json = ?
          WHERE id = ?`,
      )
      .bind(updatedAt, platform, JSON.stringify(tools), device.id),
  ]);

  const deviceActor = await first<{ role: WorkspaceRole }>(
    `SELECT role
       FROM memberships
      WHERE workspace_id = ? AND user_id = ?`,
    device.workspaceId,
    device.ownerUserId,
  );
  if (!deviceActor) {
    throw new Error("The paired desktop owner is no longer a workspace member.");
  }
  const deleteAcks: Array<{
    entity: "project" | "channel" | "task";
    remoteId: string;
    localId: string;
  }> = [];
  const incomingDeletes = Array.isArray(body.deleteRequests)
    ? body.deleteRequests.slice(0, 500)
    : [];
  if (deviceActor.role === "owner" || deviceActor.role === "admin") {
    for (const value of incomingDeletes) {
      if (!value || typeof value !== "object") continue;
      const request = value as Record<string, unknown>;
      const requestedEntity = text(request.entity, 20);
      if (!["project", "channel", "task"].includes(requestedEntity)) continue;
      const entity = requestedEntity as "project" | "channel" | "task";
      const remoteId = text(request.remoteId, 180);
      const localId = text(request.localId, 180);
      if (!remoteId || !localId) continue;

      if (entity === "project") {
        const project = await first<{ id: string }>(
          "SELECT id FROM projects WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          remoteId,
        );
        if (project) {
          const sources = await all<{
            deviceId: string;
            sourceProjectId: string;
          }>(
            `SELECT device_id AS deviceId, source_project_id AS sourceProjectId
               FROM project_sources
              WHERE workspace_id = ? AND project_id = ?`,
            device.workspaceId,
            remoteId,
          );
          await workspaceEvent(
            device.workspaceId,
            device.id,
            "project.deleted",
            remoteId,
          );
          const revision = await workspaceRevision(device.workspaceId);
          await run(
            `INSERT INTO content_tombstones
              (id, workspace_id, entity, entity_id, created_by, revision, created_at)
             VALUES (?, ?, 'project', ?, ?, ?, ?)
             ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
               created_by = excluded.created_by,
               revision = excluded.revision,
               created_at = excluded.created_at`,
            id("tomb"),
            device.workspaceId,
            remoteId,
            device.ownerUserId,
            revision,
            updatedAt,
          );
          for (const source of sources) {
            await run(
              `INSERT INTO content_tombstones
                (id, workspace_id, entity, entity_id, created_by, revision, created_at)
               VALUES (?, ?, 'project_source', ?, ?, ?, ?)
               ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
                 created_by = excluded.created_by,
                 revision = excluded.revision,
                 created_at = excluded.created_at`,
              id("tomb"),
              device.workspaceId,
              JSON.stringify([source.deviceId, source.sourceProjectId]),
              device.ownerUserId,
              revision,
              updatedAt,
            );
          }
          await db().batch([
            db()
              .prepare(
                `DELETE FROM message_sources
                  WHERE message_id IN (
                    SELECT m.id FROM messages m
                    JOIN channels c ON c.id = m.channel_id
                    WHERE c.workspace_id = ? AND c.project_id = ?
                  )`,
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare(
                `DELETE FROM messages
                  WHERE channel_id IN (
                    SELECT id FROM channels
                    WHERE workspace_id = ? AND project_id = ?
                  )`,
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM channel_sources WHERE workspace_id = ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ? AND project_id = ?)",
              )
              .bind(device.workspaceId, device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM channels WHERE workspace_id = ? AND project_id = ?",
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM issue_sources WHERE workspace_id = ? AND issue_id IN (SELECT id FROM issues WHERE workspace_id = ? AND project_id = ?)",
              )
              .bind(device.workspaceId, device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM issues WHERE workspace_id = ? AND project_id = ?",
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM project_connections WHERE workspace_id = ? AND project_id = ?",
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM project_sources WHERE workspace_id = ? AND project_id = ?",
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare(
                "DELETE FROM projects WHERE workspace_id = ? AND id = ?",
              )
              .bind(device.workspaceId, remoteId),
          ]);
        }
      } else if (entity === "channel") {
        const channel = await first<{ id: string }>(
          "SELECT id FROM channels WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          remoteId,
        );
        if (channel) {
          await workspaceEvent(
            device.workspaceId,
            device.id,
            "channel.deleted",
            remoteId,
          );
          const revision = await workspaceRevision(device.workspaceId);
          await run(
            `INSERT INTO content_tombstones
              (id, workspace_id, entity, entity_id, created_by, revision, created_at)
             VALUES (?, ?, 'channel', ?, ?, ?, ?)
             ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
               created_by = excluded.created_by,
               revision = excluded.revision,
               created_at = excluded.created_at`,
            id("tomb"),
            device.workspaceId,
            remoteId,
            device.ownerUserId,
            revision,
            updatedAt,
          );
          await db().batch([
            db()
              .prepare(
                "DELETE FROM message_sources WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ?)",
              )
              .bind(remoteId),
            db().prepare("DELETE FROM messages WHERE channel_id = ?").bind(remoteId),
            db()
              .prepare(
                "DELETE FROM channel_sources WHERE workspace_id = ? AND channel_id = ?",
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare("DELETE FROM channels WHERE workspace_id = ? AND id = ?")
              .bind(device.workspaceId, remoteId),
          ]);
        }
      } else {
        const issue = await first<{ id: string }>(
          "SELECT id FROM issues WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          remoteId,
        );
        if (issue) {
          await workspaceEvent(
            device.workspaceId,
            device.id,
            "task.deleted",
            remoteId,
          );
          const revision = await workspaceRevision(device.workspaceId);
          await run(
            `INSERT INTO content_tombstones
              (id, workspace_id, entity, entity_id, created_by, revision, created_at)
             VALUES (?, ?, 'task', ?, ?, ?, ?)
             ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
               created_by = excluded.created_by,
               revision = excluded.revision,
               created_at = excluded.created_at`,
            id("tomb"),
            device.workspaceId,
            remoteId,
            device.ownerUserId,
            revision,
            updatedAt,
          );
          await db().batch([
            db()
              .prepare(
                "DELETE FROM issue_sources WHERE workspace_id = ? AND issue_id = ?",
              )
              .bind(device.workspaceId, remoteId),
            db()
              .prepare("DELETE FROM issues WHERE workspace_id = ? AND id = ?")
              .bind(device.workspaceId, remoteId),
          ]);
        }
      }
      deleteAcks.push({ entity, remoteId, localId });
    }
  }
  const memberAcks: Array<{ portalUserId: string; changedAt: number }> = [];
  const incomingMemberProfiles = Array.isArray(body.memberProfiles)
    ? body.memberProfiles.slice(0, 100)
    : [];
  for (const value of incomingMemberProfiles) {
    if (!value || typeof value !== "object") continue;
    const profile = value as Record<string, unknown>;
    const portalUserId = text(profile.portalUserId, 180);
    const changedAt = Math.max(0, Number(profile.changedAt) || 0);
    if (!portalUserId || !changedAt) continue;
    await applyMemberProfilePatch(
      {
        workspaceId: device.workspaceId,
        userId: device.ownerUserId,
        role: deviceActor.role,
      },
      {
        memberId: portalUserId,
        name: text(profile.name, 120),
        role: text(profile.role, 20),
      },
      false,
    );
    memberAcks.push({ portalUserId, changedAt });
  }

  const incomingProjects = Array.isArray(body.projectProfiles)
    ? body.projectProfiles.slice(0, 200)
    : [];
  for (const value of incomingProjects) {
    if (!value || typeof value !== "object") continue;
    const project = value as Record<string, unknown>;
    const sourceProjectId = text(project.id, 180);
    const name = text(project.name, 120);
    const repo = text(project.repo, 240);
    if (!sourceProjectId || !name) continue;
    const deletedSource = await first<{ id: string }>(
      `SELECT id FROM content_tombstones
        WHERE workspace_id = ? AND entity = 'project_source' AND entity_id = ?`,
      device.workspaceId,
      JSON.stringify([device.id, sourceProjectId]),
    );
    if (deletedSource) continue;
    const existing = await first<{ id: string }>(
      `SELECT p.id
         FROM project_sources s
         JOIN projects p ON p.id = s.project_id
        WHERE s.workspace_id = ? AND s.device_id = ?
          AND s.source_project_id = ?`,
      device.workspaceId,
      device.id,
      sourceProjectId,
    );
    const requestedPortalId = text(project.portalId, 180);
    const requested = requestedPortalId
      ? await first<{ id: string }>(
          "SELECT id FROM projects WHERE id = ? AND workspace_id = ?",
          requestedPortalId,
          device.workspaceId,
        )
      : null;
    const nameMatches = !existing && !requested
      ? await all<{ id: string }>(
          `SELECT id
             FROM projects
            WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?))
            ORDER BY created_at
            LIMIT 2`,
          device.workspaceId,
          name,
        )
      : [];
    const projectId =
      existing?.id ??
      requested?.id ??
      (nameMatches.length === 1 ? nameMatches[0].id : id("prj"));
    if (existing || requested || nameMatches.length === 1) {
      await run(
        `UPDATE projects
            SET name = ?, summary = ?,
                repo = CASE WHEN ? = '' THEN repo ELSE ? END,
                status = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
        name,
        text(project.summary, 1_200),
        repo,
        repo,
        oneOf(project.status, ["active", "paused", "done"] as const, "active"),
        updatedAt,
        projectId,
        device.workspaceId,
      );
    } else {
      await run(
        `INSERT INTO projects
          (id, workspace_id, name, summary, repo, status, lead_id, target_date,
           source_device_id, source_project_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        projectId,
        device.workspaceId,
        name,
        text(project.summary, 1_200),
        repo,
        oneOf(project.status, ["active", "paused", "done"] as const, "active"),
        device.id,
        sourceProjectId,
        device.ownerUserId,
        updatedAt,
        updatedAt,
      );
    }
    await run(
      `INSERT INTO project_sources
        (workspace_id, project_id, device_id, source_project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, source_project_id) DO UPDATE SET
         project_id = excluded.project_id,
         updated_at = excluded.updated_at`,
      device.workspaceId,
      projectId,
      device.id,
      sourceProjectId,
      updatedAt,
      updatedAt,
    );
  }

  const incomingAgents = Array.isArray(body.agents)
    ? body.agents.slice(0, 100)
    : [];
  for (const value of incomingAgents) {
    if (!value || typeof value !== "object") continue;
    const agent = value as Record<string, unknown>;
    const sourceAgentId = text(agent.id, 180);
    const name = text(agent.name, 100);
    if (!sourceAgentId || !name) continue;
    const existing = await first<{ id: string }>(
      `SELECT id
         FROM agent_profiles
        WHERE workspace_id = ? AND host_device_id = ? AND source_agent_id = ?`,
      device.workspaceId,
      device.id,
      sourceAgentId,
    );
    const adoptable =
      existing ??
      (await first<{ id: string }>(
        `SELECT id
           FROM agent_profiles
          WHERE workspace_id = ? AND owner_user_id = ? AND host_device_id IS NULL
            AND source_agent_id = '' AND name = ?
          ORDER BY created_at
          LIMIT 1`,
        device.workspaceId,
        device.ownerUserId,
        name,
      ));
    const agentId = adoptable?.id ?? id("agent");
    const backend = oneOf(
      agent.backend,
      ["claude", "codex", "ritz", "custom"] as const,
      "codex",
    );
    const visibility = oneOf(
      agent.visibility,
      ["private", "workspace"] as const,
      "workspace",
    );
    const cliArgs = Array.isArray(agent.cliArgs)
      ? agent.cliArgs
          .map((entry) => text(entry, 500))
          .filter(Boolean)
          .slice(0, 32)
      : [];
    await run(
      `INSERT INTO agent_profiles
        (id, workspace_id, name, role, owns, backend, model, effort, status,
         owner_user_id, host_device_id, visibility, persona, cli_args_json,
         source_agent_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         owns = excluded.owns,
         backend = excluded.backend,
         model = excluded.model,
         effort = excluded.effort,
         status = excluded.status,
         visibility = excluded.visibility,
         persona = excluded.persona,
         cli_args_json = excluded.cli_args_json,
         owner_user_id = excluded.owner_user_id,
         host_device_id = excluded.host_device_id,
         source_agent_id = excluded.source_agent_id,
         updated_at = excluded.updated_at
       WHERE agent_profiles.workspace_id = excluded.workspace_id
         AND (
           agent_profiles.host_device_id = excluded.host_device_id
           OR agent_profiles.host_device_id IS NULL
         )`,
      agentId,
      device.workspaceId,
      name,
      text(agent.role, 120),
      text(agent.owns, 500),
      backend,
      text(agent.model, 160),
      text(agent.effort, 40),
      oneOf(agent.status, ["configured", "active", "offline"] as const, "configured"),
      device.ownerUserId,
      device.id,
      visibility,
      text(agent.persona, 8_000),
      JSON.stringify(cliArgs),
      sourceAgentId,
      device.ownerUserId,
      updatedAt,
      updatedAt,
    );
  }

  const incomingChannels = Array.isArray(body.channelProfiles)
    ? body.channelProfiles.slice(0, 500)
    : [];
  for (const value of incomingChannels) {
    if (!value || typeof value !== "object") continue;
    const channel = value as Record<string, unknown>;
    const sourceChannelId = text(channel.id, 180);
    const sourceProjectId = text(channel.projectId, 180);
    const name = slug(text(channel.name, 64));
    if (!sourceChannelId || !sourceProjectId || !name) continue;
    const linkedProject = await first<{ id: string }>(
      `SELECT project_id AS id
         FROM project_sources
        WHERE workspace_id = ? AND device_id = ? AND source_project_id = ?`,
      device.workspaceId,
      device.id,
      sourceProjectId,
    );
    const requestedProjectId = text(channel.projectPortalId, 180);
    const requestedProject = !linkedProject && requestedProjectId
      ? await first<{ id: string }>(
          "SELECT id FROM projects WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedProjectId,
        )
      : null;
    const projectId = linkedProject?.id ?? requestedProject?.id;
    if (!projectId) continue;

    const existing = await first<{ id: string }>(
      `SELECT channel_id AS id
         FROM channel_sources
        WHERE workspace_id = ? AND device_id = ? AND source_channel_id = ?`,
      device.workspaceId,
      device.id,
      sourceChannelId,
    );
    const requestedPortalId = text(channel.portalId, 180);
    const requested = !existing && requestedPortalId
      ? await first<{ id: string }>(
          "SELECT id FROM channels WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedPortalId,
        )
      : null;
    const named = !existing && !requested
      ? await first<{ id: string }>(
          `SELECT id FROM channels
            WHERE workspace_id = ? AND project_id = ?
              AND lower(trim(name)) = lower(trim(?))
            ORDER BY created_at LIMIT 1`,
          device.workspaceId,
          projectId,
          name,
        )
      : null;
    const channelId = existing?.id ?? requested?.id ?? named?.id ?? id("ch");
    const sourceLeadId = text(channel.leadAgentId, 180);
    const lead = sourceLeadId
      ? await first<{ id: string }>(
          `SELECT id FROM agent_profiles
            WHERE workspace_id = ? AND host_device_id = ? AND source_agent_id = ?`,
          device.workspaceId,
          device.id,
          sourceLeadId,
        )
      : null;
    const createdAtMs = Number(channel.createdAt);
    const createdAt = Number.isFinite(createdAtMs) && createdAtMs > 0
      ? new Date(createdAtMs).toISOString()
      : updatedAt;
    await run(
      `INSERT INTO channels
        (id, workspace_id, project_id, name, topic, mode, lead_agent_id,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         name = excluded.name,
         topic = excluded.topic,
         mode = excluded.mode,
         lead_agent_id = excluded.lead_agent_id,
         updated_at = excluded.updated_at
       WHERE channels.workspace_id = excluded.workspace_id`,
      channelId,
      device.workspaceId,
      projectId,
      name,
      text(channel.topic, 500),
      oneOf(
        channel.mode,
        ["broadcast", "sequential", "lead", "panel"] as const,
        "lead",
      ),
      lead?.id ?? null,
      device.ownerUserId,
      createdAt,
      updatedAt,
    );
    await run(
      `INSERT INTO channel_sources
        (workspace_id, channel_id, device_id, source_channel_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, source_channel_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         updated_at = excluded.updated_at`,
      device.workspaceId,
      channelId,
      device.id,
      sourceChannelId,
      updatedAt,
      updatedAt,
    );
  }

  const incomingMessages = Array.isArray(body.messageProfiles)
    ? body.messageProfiles.slice(0, 2_000)
    : [];
  for (const value of incomingMessages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    const sourceMessageId = text(message.id, 180);
    const sourceChannelId = text(message.channelId, 180);
    const content =
      typeof message.content === "string"
        ? message.content.slice(0, 12_000)
        : "";
    if (!sourceMessageId || !sourceChannelId || !content) continue;
    const linkedChannel = await first<{ id: string }>(
      `SELECT channel_id AS id
         FROM channel_sources
        WHERE workspace_id = ? AND device_id = ? AND source_channel_id = ?`,
      device.workspaceId,
      device.id,
      sourceChannelId,
    );
    const requestedChannelId = text(message.channelPortalId, 180);
    const requestedChannel = !linkedChannel && requestedChannelId
      ? await first<{ id: string }>(
          "SELECT id FROM channels WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedChannelId,
        )
      : null;
    const channelId = linkedChannel?.id ?? requestedChannel?.id;
    if (!channelId) continue;

    const existing = await first<{ id: string }>(
      `SELECT message_id AS id
         FROM message_sources
        WHERE workspace_id = ? AND device_id = ? AND source_message_id = ?`,
      device.workspaceId,
      device.id,
      sourceMessageId,
    );
    const requestedPortalId = text(message.portalId, 180);
    const requested = !existing && requestedPortalId
      ? await first<{ id: string }>(
          `SELECT m.id
             FROM messages m
             JOIN channels c ON c.id = m.channel_id
            WHERE c.workspace_id = ? AND m.id = ?`,
          device.workspaceId,
          requestedPortalId,
        )
      : null;
    const messageId = existing?.id ?? requested?.id ?? id("msg");
    const authorType = oneOf(
      message.authorType,
      ["user", "agent", "system"] as const,
      "user",
    );
    const sourceAuthorId = text(message.authorId, 180);
    const requestedAuthorId = text(message.authorPortalId, 180);
    let authorId = device.ownerUserId;
    if (authorType === "user" && requestedAuthorId) {
      const member = await first<{ id: string }>(
        `SELECT user_id AS id FROM memberships
          WHERE workspace_id = ? AND user_id = ?`,
        device.workspaceId,
        requestedAuthorId,
      );
      authorId = member?.id ?? device.ownerUserId;
    } else if (authorType === "agent") {
      const agent = sourceAuthorId
        ? await first<{ id: string }>(
            `SELECT id FROM agent_profiles
              WHERE workspace_id = ? AND host_device_id = ? AND source_agent_id = ?`,
            device.workspaceId,
            device.id,
            sourceAuthorId,
          )
        : null;
      const requestedAgent = !agent && requestedAuthorId
        ? await first<{ id: string }>(
            "SELECT id FROM agent_profiles WHERE workspace_id = ? AND id = ?",
            device.workspaceId,
            requestedAuthorId,
          )
        : null;
      authorId = agent?.id ?? requestedAgent?.id ?? (sourceAuthorId || device.id);
    } else if (authorType === "system") {
      authorId = device.id;
    }
    const sourceParentId = text(message.parentId, 180);
    const requestedParentId = text(message.parentPortalId, 180);
    const linkedParent = sourceParentId
      ? await first<{ id: string }>(
          `SELECT message_id AS id
             FROM message_sources
            WHERE workspace_id = ? AND device_id = ? AND source_message_id = ?`,
          device.workspaceId,
          device.id,
          sourceParentId,
        )
      : null;
    const parentId = linkedParent?.id ?? requestedParentId;
    const createdAtMs = Number(message.createdAt);
    const createdAt = Number.isFinite(createdAtMs) && createdAtMs > 0
      ? new Date(createdAtMs).toISOString()
      : updatedAt;
    await run(
      `INSERT INTO messages
        (id, channel_id, author_type, author_id, author_name, body, parent_id,
         status, meta, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         channel_id = excluded.channel_id,
         author_type = excluded.author_type,
         author_id = excluded.author_id,
         author_name = excluded.author_name,
         body = excluded.body,
         parent_id = excluded.parent_id,
         status = excluded.status,
         meta = excluded.meta,
         run_id = excluded.run_id,
         updated_at = excluded.updated_at`,
      messageId,
      channelId,
      authorType,
      authorId,
      text(message.authorName, 160) || "Spaces",
      content,
      parentId,
      oneOf(message.status, ["running", "done", "error"] as const, "done"),
      typeof message.meta === "string" ? message.meta.slice(0, 20_000) : "",
      text(message.runId, 180),
      createdAt,
      updatedAt,
    );
    await run(
      `INSERT INTO message_sources
        (workspace_id, message_id, device_id, source_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, source_message_id) DO UPDATE SET
         message_id = excluded.message_id,
         updated_at = excluded.updated_at`,
      device.workspaceId,
      messageId,
      device.id,
      sourceMessageId,
      updatedAt,
      updatedAt,
    );
  }

  const incomingTasks = Array.isArray(body.taskProfiles)
    ? body.taskProfiles.slice(0, 1_000)
    : [];
  for (const value of incomingTasks) {
    if (!value || typeof value !== "object") continue;
    const task = value as Record<string, unknown>;
    const sourceTaskId = text(task.id, 180);
    const sourceProjectId = text(task.projectId, 180);
    const title = text(task.title, 240);
    if (!sourceTaskId || !sourceProjectId || !title) continue;
    const linkedProject = await first<{ id: string }>(
      `SELECT project_id AS id FROM project_sources
        WHERE workspace_id = ? AND device_id = ? AND source_project_id = ?`,
      device.workspaceId,
      device.id,
      sourceProjectId,
    );
    const requestedProjectId = text(task.projectPortalId, 180);
    const requestedProject = !linkedProject && requestedProjectId
      ? await first<{ id: string }>(
          "SELECT id FROM projects WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedProjectId,
        )
      : null;
    const projectId = linkedProject?.id ?? requestedProject?.id;
    if (!projectId) continue;
    const existing = await first<{ id: string }>(
      `SELECT issue_id AS id FROM issue_sources
        WHERE workspace_id = ? AND device_id = ? AND source_task_id = ?`,
      device.workspaceId,
      device.id,
      sourceTaskId,
    );
    const requestedPortalId = text(task.portalId, 180);
    const requested = !existing && requestedPortalId
      ? await first<{ id: string }>(
          "SELECT id FROM issues WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedPortalId,
        )
      : null;
    const issueId = existing?.id ?? requested?.id ?? id("issue");
    const sourceAssigneeId = text(task.assigneeAgentId, 180);
    const requestedAssigneeId = text(task.assigneePortalId, 180);
    const localAssignee = sourceAssigneeId
      ? await first<{ id: string }>(
          `SELECT id FROM agent_profiles
            WHERE workspace_id = ? AND host_device_id = ? AND source_agent_id = ?`,
          device.workspaceId,
          device.id,
          sourceAssigneeId,
        )
      : null;
    const requestedAssignee = !localAssignee && requestedAssigneeId
      ? await first<{ id: string }>(
          "SELECT id FROM agent_profiles WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedAssigneeId,
        )
      : null;
    const taskStatus = oneOf(
      task.status,
      ["backlog", "todo", "doing", "done"] as const,
      "todo",
    );
    const issueStatus =
      taskStatus === "todo"
        ? "ready"
        : taskStatus === "doing"
          ? "in_progress"
          : taskStatus;
    const createdAtMs = Number(task.createdAt);
    const createdAt = Number.isFinite(createdAtMs) && createdAtMs > 0
      ? new Date(createdAtMs).toISOString()
      : updatedAt;
    await run(
      `INSERT INTO issues
        (id, workspace_id, project_id, cycle_id, title, description, status,
         priority, assignee_id, created_by, due_date, source, source_id,
         created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'normal', ?, ?, ?, 'spaces', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         title = excluded.title,
         description = excluded.description,
         status = excluded.status,
         assignee_id = excluded.assignee_id,
         due_date = excluded.due_date,
         updated_at = excluded.updated_at
       WHERE issues.workspace_id = excluded.workspace_id`,
      issueId,
      device.workspaceId,
      projectId,
      title,
      text(task.description, 8_000),
      issueStatus,
      localAssignee?.id ?? requestedAssignee?.id ?? null,
      device.ownerUserId,
      text(task.dueDate, 40) || null,
      createdAt,
      updatedAt,
    );
    await run(
      `INSERT INTO issue_sources
        (workspace_id, issue_id, device_id, source_task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, source_task_id) DO UPDATE SET
         issue_id = excluded.issue_id,
         updated_at = excluded.updated_at`,
      device.workspaceId,
      issueId,
      device.id,
      sourceTaskId,
      updatedAt,
      updatedAt,
    );
  }

  const incomingTeams = Array.isArray(body.teamProfiles)
    ? body.teamProfiles.slice(0, 100)
    : [];
  for (const value of incomingTeams) {
    if (!value || typeof value !== "object") continue;
    const team = value as Record<string, unknown>;
    const sourceTeamId = text(team.id, 180);
    const name = text(team.name, 120);
    if (!sourceTeamId || !name) continue;
    const existing = await first<{
      id: string;
      name: string;
      purpose: string;
    }>(
      `SELECT id, name, purpose
         FROM teams
        WHERE workspace_id = ? AND source_device_id = ? AND source_team_id = ?`,
      device.workspaceId,
      device.id,
      sourceTeamId,
    );
    const requestedPortalId = text(team.portalId, 180);
    const requested = !existing && requestedPortalId
      ? await first<{ id: string; name: string; purpose: string }>(
          "SELECT id, name, purpose FROM teams WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          requestedPortalId,
        )
      : null;
    const named = !existing && !requested
      ? await all<{ id: string; name: string; purpose: string }>(
          `SELECT id, name, purpose
             FROM teams
            WHERE workspace_id = ? AND lower(trim(name)) = lower(trim(?))
            ORDER BY created_at LIMIT 2`,
          device.workspaceId,
          name,
        )
      : [];
    const adopted = existing ?? requested ?? (named.length === 1 ? named[0] : null);
    const teamId = adopted?.id ?? id("team");
    const purpose = text(team.purpose, 1_200);
    if (adopted) {
      await run(
        `UPDATE teams
            SET name = ?, purpose = ?, source_device_id = ?, source_team_id = ?
          WHERE workspace_id = ? AND id = ?`,
        name,
        purpose,
        device.id,
        sourceTeamId,
        device.workspaceId,
        teamId,
      );
    } else {
      await run(
        `INSERT INTO teams
          (id, workspace_id, name, purpose, source_device_id, source_team_id,
           created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        teamId,
        device.workspaceId,
        name,
        purpose,
        device.id,
        sourceTeamId,
        device.ownerUserId,
        updatedAt,
      );
    }
    const incomingAgentIds = Array.isArray(team.agentIds)
      ? team.agentIds.map((entry) => text(entry, 180)).filter(Boolean).slice(0, 100)
      : [];
    const desiredActors: string[] = [];
    for (const sourceAgentId of incomingAgentIds) {
      const agent = await first<{ id: string }>(
        `SELECT id FROM agent_profiles
          WHERE workspace_id = ? AND host_device_id = ? AND source_agent_id = ?`,
        device.workspaceId,
        device.id,
        sourceAgentId,
      );
      if (agent) desiredActors.push(agent.id);
    }
    const currentActors = await all<{ id: string }>(
      `SELECT actor_id AS id FROM team_actors
        WHERE team_id = ? AND actor_type = 'agent'
        ORDER BY actor_id`,
      teamId,
    );
    const actorChanged =
      JSON.stringify(currentActors.map((row) => row.id).sort()) !==
      JSON.stringify([...desiredActors].sort());
    if (actorChanged) {
      await run(
        "DELETE FROM team_actors WHERE team_id = ? AND actor_type = 'agent'",
        teamId,
      );
      for (const agentId of desiredActors) {
        await run(
          "INSERT OR IGNORE INTO team_actors (team_id, actor_type, actor_id) VALUES (?, 'agent', ?)",
          teamId,
          agentId,
        );
      }
    }
    if (
      !adopted ||
      adopted.name !== name ||
      adopted.purpose !== purpose ||
      actorChanged
    ) {
      await workspaceEvent(
        device.workspaceId,
        device.id,
        "team.synced",
        teamId,
      );
    }
  }
  const sharedContent = await syncSharedContent(device, body);
  if (previousSnapshot?.payloadJson !== encoded) {
    await workspaceEvent(
      device.workspaceId,
      device.id,
      "device.snapshot_changed",
      device.id,
    );
  }
  const connections = await all<ConnectionRow>(
    `SELECT id, kind, label, status, account_label AS accountLabel,
            scopes_json AS scopesJson, last_sync_at AS lastSyncAt,
            created_by AS ownerUserId
       FROM connections
      WHERE workspace_id = ?
      ORDER BY kind, label`,
    device.workspaceId,
  );
  const connectionLinks = await all<ProjectConnectionRow>(
    `SELECT connection_id AS connectionId, project_id AS projectId,
            is_default AS isDefault
       FROM project_connections
      WHERE workspace_id = ?
      ORDER BY updated_at DESC`,
    device.workspaceId,
  );
  const workspace = await first<{ id: string; name: string }>(
    "SELECT id, name FROM workspaces WHERE id = ?",
    device.workspaceId,
  );
  const projects = await all<{
    id: string;
    name: string;
    summary: string;
    repo: string;
    status: string;
    sourceProjectId: string;
  }>(
    `SELECT p.id, p.name, p.summary, p.repo, p.status,
            COALESCE(s.source_project_id, '') AS sourceProjectId
       FROM projects p
       LEFT JOIN project_sources s
         ON s.project_id = p.id AND s.workspace_id = p.workspace_id
        AND s.device_id = ?
      WHERE p.workspace_id = ?
      ORDER BY p.created_at`,
    device.id,
    device.workspaceId,
  );
  const channels = await all<{
    id: string;
    projectId: string;
    name: string;
    topic: string;
    mode: string;
    leadAgentId: string | null;
    sourceChannelId: string;
    createdAt: string;
  }>(
    `SELECT c.id, c.project_id AS projectId, c.name, c.topic, c.mode,
            c.lead_agent_id AS leadAgentId,
            COALESCE(s.source_channel_id, '') AS sourceChannelId,
            c.created_at AS createdAt
       FROM channels c
       LEFT JOIN channel_sources s
         ON s.channel_id = c.id AND s.workspace_id = c.workspace_id
        AND s.device_id = ?
      WHERE c.workspace_id = ? AND c.project_id IS NOT NULL
      ORDER BY c.created_at`,
    device.id,
    device.workspaceId,
  );
  const messages = await all<{
    id: string;
    channelId: string;
    authorType: string;
    authorId: string;
    authorName: string;
    body: string;
    parentId: string;
    status: string;
    meta: string;
    runId: string;
    sourceMessageId: string;
    createdAt: string;
  }>(
    `SELECT * FROM (
       SELECT m.id, m.channel_id AS channelId, m.author_type AS authorType,
              m.author_id AS authorId,
              COALESCE(NULLIF(m.author_name, ''), u.name, a.name, 'Spaces') AS authorName,
              m.body, m.parent_id AS parentId, m.status, m.meta,
              m.run_id AS runId,
              COALESCE(s.source_message_id, '') AS sourceMessageId,
              m.created_at AS createdAt
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN users u
           ON m.author_type = 'user' AND u.id = m.author_id
         LEFT JOIN agent_profiles a
           ON m.author_type = 'agent' AND a.id = m.author_id
         LEFT JOIN message_sources s
           ON s.message_id = m.id AND s.workspace_id = c.workspace_id
          AND s.device_id = ?
        WHERE c.workspace_id = ? AND c.project_id IS NOT NULL
        ORDER BY m.created_at DESC
        LIMIT 2000
     ) ORDER BY createdAt`,
    device.id,
    device.workspaceId,
  );
  const issues = await all<{
    id: string;
    projectId: string;
    title: string;
    description: string;
    status: string;
    assigneeId: string | null;
    dueDate: string | null;
    sourceTaskId: string;
    createdAt: string;
  }>(
    `SELECT i.id, i.project_id AS projectId, i.title, i.description,
            i.status, i.assignee_id AS assigneeId, i.due_date AS dueDate,
            COALESCE(s.source_task_id, '') AS sourceTaskId,
            i.created_at AS createdAt
       FROM issues i
       LEFT JOIN issue_sources s
         ON s.issue_id = i.id AND s.workspace_id = i.workspace_id
        AND s.device_id = ?
      WHERE i.workspace_id = ? AND i.project_id IS NOT NULL
      ORDER BY i.created_at`,
    device.id,
    device.workspaceId,
  );
  const agents = await all<{
    id: string;
    name: string;
    role: string;
    owns: string;
    backend: string;
    model: string;
    effort: string;
    status: string;
    ownerUserId: string | null;
    hostDeviceId: string | null;
    visibility: string;
    persona: string;
    cliArgsJson: string;
    sourceAgentId: string;
  }>(
    `SELECT id, name, role, owns, backend, model, effort, status,
            owner_user_id AS ownerUserId, host_device_id AS hostDeviceId,
            visibility, persona, cli_args_json AS cliArgsJson,
            source_agent_id AS sourceAgentId
       FROM agent_profiles
      WHERE workspace_id = ?
      ORDER BY created_at`,
    device.workspaceId,
  );
  const teams = await all<{
    id: string;
    name: string;
    purpose: string;
    sourceTeamId: string;
  }>(
    `SELECT id, name, purpose, source_team_id AS sourceTeamId
       FROM teams
      WHERE workspace_id = ?
      ORDER BY created_at`,
    device.workspaceId,
  );
  const teamActors = await all<{
    teamId: string;
    agentId: string;
  }>(
    `SELECT ta.team_id AS teamId, a.id AS agentId
       FROM team_actors ta
       JOIN teams t ON t.id = ta.team_id
       JOIN agent_profiles a
         ON ta.actor_type = 'agent' AND a.id = ta.actor_id
      WHERE t.workspace_id = ?`,
    device.workspaceId,
  );
  const members = await all<{
    id: string;
    email: string;
    name: string;
    role: WorkspaceRole;
  }>(
    `SELECT u.id, u.email,
            COALESCE(NULLIF(m.display_name, ''), u.name) AS name,
            m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY COALESCE(NULLIF(m.display_name, ''), u.name)`,
    device.workspaceId,
  );
  const devices = await all<{
    id: string;
    name: string;
    ownerUserId: string;
    platform: string;
    toolsJson: string;
    status: string;
    lastSeenAt: string;
  }>(
    `SELECT id, name, owner_user_id AS ownerUserId, platform,
            tools_json AS toolsJson, status, last_seen_at AS lastSeenAt
       FROM devices
      WHERE workspace_id = ?
      ORDER BY last_seen_at DESC`,
    device.workspaceId,
  );
  return {
    ok: true,
    updatedAt,
    workspace,
    currentUserId: device.ownerUserId,
    currentDeviceId: device.id,
    memberAcks,
    deleteAcks,
    members,
    devices: devices.map(({ toolsJson, ...row }) => ({
      ...row,
      tools: jsonArray(toolsJson),
    })),
    projects,
    channels,
    messages,
    issues,
    agents: agents.map(({ cliArgsJson, ...agent }) => ({
      ...agent,
      cliArgs: jsonArray(cliArgsJson),
    })),
    teams: teams.map((team) => ({
      ...team,
      agentIds: teamActors
        .filter((actor) => actor.teamId === team.id)
        .map((actor) => actor.agentId)
        .filter(Boolean),
    })),
    sharedAcks: sharedContent.acks,
    tombstones: sharedContent.tombstones,
    knowledgePages: sharedContent.knowledgePages,
    calendars: sharedContent.calendars,
    calendarEvents: sharedContent.calendarEvents,
    contentItems: sharedContent.contentItems,
    contentRevision: sharedContent.contentRevision,
    connections: visibleConnections(
      connections,
      device.ownerUserId,
      connectionLinks,
    ),
  };
}
