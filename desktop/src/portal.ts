import { getDb, now } from "./db";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { config } from "./config";
import { configuredEffort, tokenize } from "./capabilities";
import {
  adoptPairedDevice,
  currentDeviceId,
  currentPlatform,
  syncPortalPeople,
} from "./deviceIdentity";
import {
  applySharedPortalResponse,
  buildSharedPortalPayload,
  type RemoteCalendar,
  type RemoteCalendarEvent,
  type RemoteKnowledgePage,
  type RemoteTombstone,
  type SharedSyncAck,
} from "./portalContent";

export interface PortalConnection {
  id: number;
  base_url: string;
  device_id: string;
  workspace_id: string;
  token: string;
  device_name: string;
  paired_at: number;
  last_sync_at: number;
  status: "paired" | "online" | "error";
  last_error: string;
  content_revision: number;
}

export type PortalProviderAction =
  | "calendar.sources"
  | "calendar.list"
  | "calendar.create"
  | "mail.list"
  | "mail.send"
  | "social.publish";

interface ClaimResponse {
  ok?: boolean;
  deviceId?: string;
  workspaceId?: string;
  ownerUserId?: string;
  token?: string;
  error?: string;
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("Enter the address of your Spaces web workspace.");
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Spaces web workspace addresses must use http or https.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export async function checkPortal(baseUrl: string): Promise<string> {
  const normalized = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalized}/api/health`, {
    headers: { accept: "application/json" },
  });
  const body = (await response.json()) as {
    ok?: boolean;
    service?: string;
    error?: string;
  };
  if (!response.ok || !body.ok || body.service !== "spaces") {
    throw new Error(body.error || `This address is not ${config().brand ? "an " + config().brand : "an Spaces"} workspace.`);
  }
  return normalized;
}

export async function loadPortalConnection(): Promise<PortalConnection | null> {
  const db = await getDb();
  const rows = await db.select<PortalConnection[]>(
    "SELECT * FROM portal_connection WHERE id = 1"
  );
  return rows[0] ?? null;
}

export async function pairPortal(
  baseUrl: string,
  code: string,
  deviceName: string
): Promise<PortalConnection> {
  const normalized = await checkPortal(baseUrl);
  const pairingCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (pairingCode.length !== 8) {
    throw new Error("Enter the eight-character code from Spaces web.");
  }
  const name = deviceName.trim() || "Spaces desktop";
  const response = await fetch(`${normalized}/api/device/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairingCode, name }),
  });
  const body = (await response.json()) as ClaimResponse;
  if (!response.ok || !body.deviceId || !body.workspaceId || !body.token) {
    throw new Error(body.error || "Spaces could not pair this desktop.");
  }
  const pairedAt = now();
  const db = await getDb();
  await db.execute(
    `INSERT INTO portal_connection
      (id, base_url, device_id, workspace_id, token, device_name, paired_at,
       last_sync_at, status, last_error)
     VALUES (1, $1, $2, $3, $4, $5, $6, 0, 'paired', '')
     ON CONFLICT(id) DO UPDATE SET
       base_url = excluded.base_url,
       device_id = excluded.device_id,
       workspace_id = excluded.workspace_id,
       token = excluded.token,
       device_name = excluded.device_name,
       paired_at = excluded.paired_at,
       last_sync_at = 0,
       status = 'paired',
       last_error = ''`,
    [
      normalized,
      body.deviceId,
      body.workspaceId,
      body.token,
      name,
      pairedAt,
    ]
  );
  await adoptPairedDevice(
    body.deviceId,
    name,
    body.ownerUserId ?? ""
  );
  await useStore.getState().refreshAll();
  window.dispatchEvent(new CustomEvent("hq:portal-change"));
  return (await loadPortalConnection())!;
}

export async function disconnectPortal(): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM portal_connection WHERE id = 1");
  window.dispatchEvent(new CustomEvent("hq:portal-change"));
}

export async function portalProviderAction<T>(
  action: PortalProviderAction,
  provider: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  const connection = await loadPortalConnection();
  if (!connection) throw new Error(`Pair this ${config().brand} desktop before using connected accounts.`);
  const response = await fetch(`${connection.base_url}/api/device/integrations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, provider, ...input }),
  });
  const body = (await response.json()) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || !body.ok) {
    throw new Error(body.error || "The connected account action failed.");
  }
  return body.result as T;
}

interface CalendarCommand {
  id: string;
  eventId: string;
  calendarName: string;
  payload: {
    title: string;
    startAt: number;
    endAt: number;
    calendarName: string;
    location?: string;
    notes?: string;
  };
}

async function deliverCalendarCommands(connection: PortalConnection): Promise<void> {
  const response = await fetch(
    `${connection.base_url}/api/device/calendar-commands`,
    {
      headers: {
        authorization: `Bearer ${connection.token}`,
        accept: "application/json",
      },
    },
  );
  if (response.status === 404) return;
  const body = (await response.json()) as {
    ok?: boolean;
    commands?: CalendarCommand[];
    error?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Spaces could not load Apple Calendar deliveries.");
  }
  for (const command of body.commands ?? []) {
    let externalId = "";
    let error = "";
    try {
      const raw = await invoke<string>("apple_calendar_create", {
        title: command.payload.title,
        startAt: command.payload.startAt,
        endAt: command.payload.endAt,
        calendarName: command.payload.calendarName || command.calendarName,
        location: command.payload.location ?? "",
        notes: command.payload.notes ?? "",
      });
      const created = JSON.parse(raw) as { id?: string };
      externalId = String(created.id ?? "");
      if (!externalId) throw new Error("Calendar.app did not return an event id.");
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    const acknowledged = await fetch(
      `${connection.base_url}/api/device/calendar-commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          commandId: command.id,
          externalId,
          error,
        }),
      },
    );
    const acknowledgement = (await acknowledged.json()) as {
      ok?: boolean;
      error?: string;
    };
    if (!acknowledged.ok || !acknowledgement.ok) {
      throw new Error(
        acknowledgement.error || "Spaces could not confirm Apple Calendar delivery.",
      );
    }
  }
}

type MirroredEntity =
  | "project"
  | "channel"
  | "message"
  | "task"
  | "agent"
  | "team";

const MIRROR_TABLE: Record<MirroredEntity, string> = {
  project: "projects",
  channel: "channels",
  message: "messages",
  task: "tasks",
  agent: "agents",
  team: "teams",
};

interface ResolvedLocal {
  localId: string;
  /** False the first time Spaces has seen this remote row. */
  exists: boolean;
}

/**
 * Work out which local row represents a portal row.
 *
 * Returns null when the user has deleted it here. That is the whole point:
 * sync runs every 15 seconds, so without this a deleted project or channel
 * reappears before the user has finished watching it go. A mapping row whose
 * local row is gone is a deliberate delete, and re-creating it would be
 * overriding the user rather than syncing with them.
 *
 * On first sight it adopts an existing local row with the same identity —
 * matching by name — instead of minting a parallel `portal-<id>` row, which is
 * what produced duplicate projects and duplicate #general channels.
 */
async function resolveLocal(
  entity: MirroredEntity,
  remoteId: string,
  matchExisting: () => Promise<string | null>
): Promise<ResolvedLocal | null> {
  const db = await getDb();
  const mapped = await db.select<{ local_id: string }[]>(
    "SELECT local_id FROM portal_links WHERE entity = $1 AND remote_id = $2",
    [entity, remoteId]
  );

  if (mapped.length) {
    const localId = mapped[0].local_id;
    const alive = await db.select<{ id: string }[]>(
      `SELECT id FROM ${MIRROR_TABLE[entity]} WHERE id = $1`,
      [localId]
    );
    return alive.length ? { localId, exists: true } : null;
  }

  const existing = await matchExisting();
  // Pre-existing rows created by earlier builds carry the old prefixed id;
  // adopting them keeps their messages, tasks and memory attached.
  const legacyId = `portal-${remoteId}`;
  const legacy = existing
    ? []
    : await db.select<{ id: string }[]>(
        `SELECT id FROM ${MIRROR_TABLE[entity]} WHERE id = $1`,
        [legacyId]
      );

  const adopted = existing ?? legacy[0]?.id ?? null;
  const localId = adopted ?? crypto.randomUUID();
  await db.execute(
    "INSERT OR REPLACE INTO portal_links (entity, remote_id, local_id) VALUES ($1,$2,$3)",
    [entity, remoteId, localId]
  );
  return { localId, exists: adopted !== null };
}

export async function syncPortal(): Promise<PortalConnection | null> {
  const connection = await loadPortalConnection();
  if (!connection) return null;
  const state = useStore.getState();
  const activeRuns = state.activeRunIds
    .map((runId) => state.runs[runId])
    .filter(Boolean)
    .map((run) => {
      const agent = state.agents.find((candidate) => candidate.id === run.agent_id);
      const channel = state.channels.find(
        (candidate) => candidate.id === run.channel_id
      );
      return {
        id: run.id,
        agent: agent?.name ?? run.agent_id,
        channel: channel?.name ?? run.channel_id,
        startedAt: run.started_at,
      };
    });
  const thisDevice = currentDeviceId() || connection.device_id;
  const self = state.self();
  const localDb = await getDb();
  const mirrorRows = await localDb.select<
    Array<{ entity: string; remote_id: string; local_id: string }>
  >(
    `SELECT entity, remote_id, local_id
       FROM portal_links
      WHERE entity IN ('project','channel','message','task','agent')`,
  );
  const remoteByLocal = new Map(
    mirrorRows.map((row) => [`${row.entity}:${row.local_id}`, row.remote_id]),
  );
  const remoteId = (entity: string, localId: string) =>
    remoteByLocal.get(`${entity}:${localId}`) ?? "";
  const portalUserByMember = new Map(
    state.members.map((member) => [member.id, member.portal_user_id]),
  );
  const projectProfiles = state.projects.map((project) => ({
    id: project.id,
    portalId: remoteId("project", project.id),
    name: project.name,
    summary: project.description,
    repo: project.repo,
    status: "active",
  }));
  const projectIds = new Set(state.projects.map((project) => project.id));
  const channelProfiles = state.channels
    .filter((channel) => projectIds.has(channel.project_id))
    .map((channel) => ({
      id: channel.id,
      portalId: remoteId("channel", channel.id),
      projectId: channel.project_id,
      projectPortalId: remoteId("project", channel.project_id),
      name: channel.name,
      topic: channel.topic,
      mode: channel.mode,
      leadAgentId: channel.lead_agent_id,
      createdAt: channel.created_at,
    }));
  const localMessages = await localDb.select<
    Array<{
      id: string;
      channel_id: string;
      author_type: "user" | "agent" | "system";
      author_id: string;
      author_name: string;
      content: string;
      status: "running" | "done" | "error";
      meta: string;
      parent_id: string;
      run_id: string;
      created_at: number;
    }>
  >(
    `SELECT * FROM (
       SELECT id, channel_id, author_type, author_id, author_name, content,
              status, meta, parent_id, run_id, created_at
         FROM messages
        ORDER BY created_at DESC, id DESC
        LIMIT 2000
     ) ORDER BY created_at, id`,
  );
  let messageBudget = 460_000;
  const messageProfiles: Array<Record<string, unknown>> = [];
  for (const message of localMessages) {
    const channel = state.channels.find(
      (candidate) => candidate.id === message.channel_id,
    );
    if (!channel || !projectIds.has(channel.project_id)) continue;
    const profile = {
      id: message.id,
      portalId: remoteId("message", message.id),
      channelId: message.channel_id,
      channelPortalId: remoteId("channel", message.channel_id),
      authorType: message.author_type,
      authorId: message.author_id,
      authorPortalId:
        message.author_type === "agent"
          ? remoteId("agent", message.author_id)
          : message.author_type === "user"
            ? portalUserByMember.get(message.author_id) ?? self.portal_user_id
            : "",
      authorName: message.author_name,
      content: message.content,
      status: message.status,
      meta: message.meta,
      parentId: message.parent_id,
      parentPortalId: remoteId("message", message.parent_id),
      runId: message.run_id,
      createdAt: message.created_at,
    };
    const size = JSON.stringify(profile).length;
    if (size > messageBudget) continue;
    messageBudget -= size;
    messageProfiles.push(profile);
  }
  const taskProfiles = state.tasks
    .filter((task) => projectIds.has(task.project_id))
    .map((task) => ({
      id: task.id,
      portalId: remoteId("task", task.id),
      projectId: task.project_id,
      projectPortalId: remoteId("project", task.project_id),
      title: task.title,
      description: task.description,
      status: task.status,
      assigneeAgentId: task.assignee_agent_id,
      assigneePortalId: remoteId("agent", task.assignee_agent_id),
      dueDate: task.due_date,
      sortOrder: task.sort_order,
      createdAt: task.created_at,
    }));
  const liveIds = new Map<string, Set<string>>([
    ["project", new Set(state.projects.map((project) => project.id))],
    ["channel", new Set(state.channels.map((channel) => channel.id))],
    ["task", new Set(state.tasks.map((task) => task.id))],
  ]);
  const deleteRequests = mirrorRows
    .filter(
      (row) =>
        liveIds.has(row.entity) &&
        !liveIds.get(row.entity)!.has(row.local_id),
    )
    .map((row) => ({
      entity: row.entity,
      remoteId: row.remote_id,
      localId: row.local_id,
    }));
  const sharedPayload = await buildSharedPortalPayload(connection);
  const memberProfiles = await localDb.select<
    Array<{
      portal_user_id: string;
      name: string;
      role: string;
      changed_at: number;
    }>
  >(
    `SELECT portal_user_id, name, role, changed_at
       FROM portal_member_outbox
      ORDER BY changed_at`
  );
  const payload = {
    projects: state.projects.length,
    projectProfiles,
    channelProfiles,
    messageProfiles,
    taskProfiles,
    deleteRequests,
    openTasks: state.tasks.filter((task) => task.status !== "done").length,
    activeRuns,
    platform: await currentPlatform(),
    tools: Object.entries(state.tools)
      .filter(([, available]) => available)
      .map(([tool]) => tool),
    agents: state.agents
      .filter(
        (agent) =>
          agent.host_device_id === thisDevice ||
          (!agent.host_device_id &&
            (!agent.owner_member_id || agent.owner_member_id === self.id))
      )
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        owns: agent.owns,
        backend: agent.kind,
        model: agent.model,
        effort: configuredEffort(agent.kind, agent.cli_args),
        status: state.tools[agent.kind] === false ? "offline" : "active",
        visibility: agent.visibility,
        persona: agent.persona,
        cliArgs: tokenize(agent.cli_args ?? ""),
      })),
    memberProfiles: memberProfiles.map((member) => ({
      portalUserId: member.portal_user_id,
      name: member.name,
      role: member.role,
      changedAt: member.changed_at,
    })),
    ...sharedPayload,
  };

  try {
    const response = await fetch(`${connection.base_url}/api/device/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      updatedAt?: string;
      connections?: Array<{
        id: string;
        kind: string;
        label: string;
        status: string;
        accountLabel: string;
        scopes: string[];
        projectLinks: Array<{
          projectId: string;
          isDefault: boolean;
        }>;
        lastSyncAt: string | null;
      }>;
      workspace?: { id: string; name: string } | null;
      currentUserId?: string;
      currentDeviceId?: string;
      members?: Array<{
        id: string;
        email: string;
        name: string;
        role: "owner" | "admin" | "member" | "guest";
      }>;
      devices?: Array<{
        id: string;
        name: string;
        ownerUserId: string;
        platform: string;
        tools: string[];
        status: string;
        lastSeenAt: string;
      }>;
      projects?: Array<{
        id: string;
        name: string;
        summary: string;
        repo: string;
        status: string;
        sourceProjectId: string;
      }>;
      channels?: Array<{
        id: string;
        projectId: string;
        name: string;
        topic: string;
        mode: "broadcast" | "sequential" | "lead" | "panel";
        leadAgentId: string | null;
        sourceChannelId: string;
        createdAt: string;
      }>;
      messages?: Array<{
        id: string;
        channelId: string;
        authorType: "user" | "agent" | "system";
        authorId: string;
        authorName: string;
        body: string;
        parentId: string;
        status: "running" | "done" | "error";
        meta: string;
        runId: string;
        sourceMessageId: string;
        createdAt: string;
      }>;
      issues?: Array<{
        id: string;
        projectId: string;
        title: string;
        description: string;
        status: "backlog" | "ready" | "in_progress" | "review" | "done";
        assigneeId: string | null;
        dueDate: string | null;
        sourceTaskId: string;
        createdAt: string;
      }>;
      agents?: Array<{
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
        visibility: "workspace" | "private";
        persona: string;
        cliArgs: string[];
        sourceAgentId: string;
      }>;
      teams?: Array<{
        id: string;
        name: string;
        purpose: string;
        sourceTeamId: string;
        agentIds: string[];
      }>;
      sharedAcks?: SharedSyncAck[];
      tombstones?: RemoteTombstone[];
      knowledgePages?: RemoteKnowledgePage[];
      calendars?: RemoteCalendar[];
      calendarEvents?: RemoteCalendarEvent[];
      contentRevision?: number;
      memberAcks?: Array<{
        portalUserId: string;
        changedAt: number;
      }>;
      deleteAcks?: Array<{
        entity: "project" | "channel" | "task";
        remoteId: string;
        localId: string;
      }>;
      error?: string;
    };
    if (!response.ok || !body.ok) {
      throw new Error(body.error || "Spaces web rejected this desktop snapshot.");
    }
    const syncedAt = body.updatedAt ? Date.parse(body.updatedAt) : now();
    const db = await getDb();
    for (const ack of body.memberAcks ?? []) {
      await db.execute(
        `DELETE FROM portal_member_outbox
          WHERE portal_user_id = $1 AND changed_at <= $2`,
        [ack.portalUserId, ack.changedAt]
      );
    }
    for (const ack of body.deleteAcks ?? []) {
      await db.execute(
        `DELETE FROM portal_links
          WHERE entity = $1 AND remote_id = $2 AND local_id = $3`,
        [ack.entity, ack.remoteId, ack.localId],
      );
    }
    const memberIds = await syncPortalPeople(
      body.currentUserId ?? "",
      body.currentDeviceId ?? connection.device_id,
      body.members ?? [],
      body.devices ?? []
    );
    for (const remote of body.projects ?? []) {
      const project = await resolveLocal("project", remote.id, async () => {
        if (remote.sourceProjectId) {
          const source = await db.select<{ id: string }[]>(
            "SELECT id FROM projects WHERE id = $1 LIMIT 1",
            [remote.sourceProjectId]
          );
          if (source[0]) return source[0].id;
        }
        const rows = await db.select<{ id: string }[]>(
          `SELECT id FROM projects WHERE lower(trim(name)) = lower(trim($1))
           ORDER BY (id LIKE 'portal-%') ASC, created_at ASC LIMIT 1`,
          [remote.name]
        );
        return rows[0]?.id ?? null;
      });
      if (!project) continue; // deleted here on purpose

      // `instructions` is deliberately not written from the remote summary.
      // It is prepended to every agent prompt as standing instructions, and a
      // project blurb is not that — the old statement bound the summary into
      // both columns, quietly injecting it into every run.
      await db.execute(
        `INSERT INTO projects
         (id, name, description, repo, local_path, isolate, instructions, created_at)
         VALUES ($1,$2,$3,$4,'',0,'',$5)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           description=excluded.description,
           repo=CASE
             WHEN trim(projects.repo) = '' THEN excluded.repo
             ELSE projects.repo
           END`,
        [project.localId, remote.name, remote.summary, remote.repo ?? "", now()]
      );

      if (body.channels !== undefined) continue;
      const channel = await resolveLocal("channel", `${remote.id}-general`, async () => {
        const rows = await db.select<{ id: string }[]>(
          `SELECT id FROM channels WHERE project_id = $1 AND name = 'general'
           ORDER BY (id LIKE 'portal-%') ASC, created_at ASC LIMIT 1`,
          [project.localId]
        );
        return rows[0]?.id ?? null;
      });
      // Only ever created, never updated: a channel the user has since given a
      // real topic should not have it overwritten on every 15-second tick.
      if (!channel || channel.exists) continue;
      await db.execute(
        `INSERT INTO channels
         (id, project_id, name, topic, chaining, charter, mode, lead_agent_id, created_at)
         VALUES ($1,$2,'general',$3,1,'','lead','',$4)
         ON CONFLICT(id) DO NOTHING`,
        [channel.localId, project.localId, `Shared channel for ${remote.name}`, now()]
      );
    }
    for (const remote of body.channels ?? []) {
      const projectLink = await db.select<{ local_id: string }[]>(
        "SELECT local_id FROM portal_links WHERE entity = 'project' AND remote_id = $1 LIMIT 1",
        [remote.projectId],
      );
      const projectId = projectLink[0]?.local_id;
      if (!projectId) continue;
      const channel = await resolveLocal("channel", remote.id, async () => {
        if (remote.sourceChannelId) {
          const source = await db.select<{ id: string }[]>(
            "SELECT id FROM channels WHERE id = $1 AND project_id = $2 LIMIT 1",
            [remote.sourceChannelId, projectId],
          );
          if (source[0]) return source[0].id;
        }
        const rows = await db.select<{ id: string }[]>(
          `SELECT id FROM channels
            WHERE project_id = $1 AND lower(trim(name)) = lower(trim($2))
            ORDER BY (id LIKE 'portal-%') ASC, created_at ASC LIMIT 1`,
          [projectId, remote.name],
        );
        return rows[0]?.id ?? null;
      });
      if (!channel) continue;
      const leadLink = remote.leadAgentId
        ? await db.select<{ local_id: string }[]>(
            "SELECT local_id FROM portal_links WHERE entity = 'agent' AND remote_id = $1 LIMIT 1",
            [remote.leadAgentId],
          )
        : [];
      const createdAt = Date.parse(remote.createdAt);
      await db.execute(
        `INSERT INTO channels
          (id, project_id, name, topic, chaining, charter, mode,
           lead_agent_id, created_at)
         VALUES ($1,$2,$3,$4,1,'',$5,$6,$7)
         ON CONFLICT(id) DO UPDATE SET
           project_id=excluded.project_id,
           name=excluded.name,
           topic=excluded.topic,
           mode=excluded.mode,
           lead_agent_id=CASE
             WHEN excluded.lead_agent_id = '' THEN channels.lead_agent_id
             ELSE excluded.lead_agent_id
           END`,
        [
          channel.localId,
          projectId,
          remote.name,
          remote.topic,
          remote.mode,
          leadLink[0]?.local_id ?? "",
          Number.isFinite(createdAt) ? createdAt : now(),
        ],
      );
      // Retire the synthetic `<project>-general` mapping created by older
      // builds once the real shared channel has an authoritative portal id.
      await db.execute(
        `DELETE FROM portal_links
          WHERE entity = 'channel' AND local_id = $1 AND remote_id != $2`,
        [channel.localId, remote.id],
      );
    }
    for (const remote of body.agents ?? []) {
      const kind = ["claude", "codex", "ritz"].includes(remote.backend)
        ? remote.backend
        : "codex";
      const effort = remote.effort.trim();
      const cliArgs = remote.cliArgs?.length
        ? remote.cliArgs
            .map((part) =>
              /^[a-zA-Z0-9_./:@%+=,-]+$/.test(part)
                ? part
                : JSON.stringify(part)
            )
            .join(" ")
        : !effort
          ? ""
          : kind === "claude"
            ? `--effort ${effort}`
            : kind === "codex"
              ? `-c model_reasoning_effort="${effort}"`
              : "";
      const agent = await resolveLocal("agent", remote.id, async () => {
        if (remote.sourceAgentId) {
          const source = await db.select<{ id: string }[]>(
            "SELECT id FROM agents WHERE id = $1 LIMIT 1",
            [remote.sourceAgentId]
          );
          if (source[0]) return source[0].id;
        }
        const rows = await db.select<{ id: string }[]>(
          `SELECT id FROM agents WHERE lower(trim(name)) = lower(trim($1))
           ORDER BY (id LIKE 'portal-%') ASC, created_at ASC LIMIT 1`,
          [remote.name]
        );
        return rows[0]?.id ?? null;
      });
      if (!agent) continue;

      const ownerMemberId = remote.ownerUserId
        ? memberIds.get(remote.ownerUserId) ?? ""
        : "";
      await db.execute(
        `INSERT INTO agents
         (id, name, kind, model, persona, cli_args, role, owns, avatar,
          owner_member_id, host_device_id, visibility, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',$9,$10,$11,$12)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           kind=excluded.kind,
           model=excluded.model,
           persona=excluded.persona,
           cli_args=excluded.cli_args,
           role=excluded.role,
           owns=excluded.owns,
           owner_member_id=excluded.owner_member_id,
           host_device_id=excluded.host_device_id,
           visibility=excluded.visibility`,
        [
          agent.localId,
          remote.name,
          kind,
          remote.model,
          remote.persona,
          cliArgs,
          remote.role,
          remote.owns,
          ownerMemberId,
          remote.hostDeviceId ?? "",
          remote.visibility,
          now(),
        ]
      );
    }
    const resolvedMessages = new Map<string, ResolvedLocal>();
    for (const remote of body.messages ?? []) {
      const message = await resolveLocal("message", remote.id, async () => {
        if (remote.sourceMessageId) {
          const source = await db.select<{ id: string }[]>(
            "SELECT id FROM messages WHERE id = $1 LIMIT 1",
            [remote.sourceMessageId],
          );
          if (source[0]) return source[0].id;
        }
        return null;
      });
      if (message) resolvedMessages.set(remote.id, message);
    }
    for (const remote of body.messages ?? []) {
      const message = resolvedMessages.get(remote.id);
      if (!message) continue;
      const channelLink = await db.select<{ local_id: string }[]>(
        "SELECT local_id FROM portal_links WHERE entity = 'channel' AND remote_id = $1 LIMIT 1",
        [remote.channelId],
      );
      const channelId = channelLink[0]?.local_id;
      if (!channelId) continue;
      let authorId = "";
      if (remote.authorType === "user") {
        authorId = memberIds.get(remote.authorId) ?? self.id;
      } else if (remote.authorType === "agent") {
        const authorLink = await db.select<{ local_id: string }[]>(
          "SELECT local_id FROM portal_links WHERE entity = 'agent' AND remote_id = $1 LIMIT 1",
          [remote.authorId],
        );
        authorId = authorLink[0]?.local_id ?? remote.authorId;
      } else {
        authorId = remote.authorId;
      }
      const parentLink = remote.parentId
        ? await db.select<{ local_id: string }[]>(
            "SELECT local_id FROM portal_links WHERE entity = 'message' AND remote_id = $1 LIMIT 1",
            [remote.parentId],
          )
        : [];
      const createdAt = Date.parse(remote.createdAt);
      await db.execute(
        `INSERT INTO messages
          (id, channel_id, author_type, author_id, author_name, content,
           status, meta, parent_id, run_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(id) DO UPDATE SET
           channel_id=excluded.channel_id,
           author_type=excluded.author_type,
           author_id=excluded.author_id,
           author_name=excluded.author_name,
           content=excluded.content,
           status=excluded.status,
           meta=excluded.meta,
           parent_id=excluded.parent_id,
           run_id=excluded.run_id`,
        [
          message.localId,
          channelId,
          remote.authorType,
          authorId,
          remote.authorName,
          remote.body,
          remote.status,
          remote.meta,
          parentLink[0]?.local_id ?? "",
          remote.runId,
          Number.isFinite(createdAt) ? createdAt : now(),
        ],
      );
    }
    for (const remote of body.issues ?? []) {
      const projectLink = await db.select<{ local_id: string }[]>(
        "SELECT local_id FROM portal_links WHERE entity = 'project' AND remote_id = $1 LIMIT 1",
        [remote.projectId],
      );
      const projectId = projectLink[0]?.local_id;
      if (!projectId) continue;
      const task = await resolveLocal("task", remote.id, async () => {
        if (remote.sourceTaskId) {
          const source = await db.select<{ id: string }[]>(
            "SELECT id FROM tasks WHERE id = $1 AND project_id = $2 LIMIT 1",
            [remote.sourceTaskId, projectId],
          );
          if (source[0]) return source[0].id;
        }
        return null;
      });
      if (!task) continue;
      const assigneeLink = remote.assigneeId
        ? await db.select<{ local_id: string }[]>(
            "SELECT local_id FROM portal_links WHERE entity = 'agent' AND remote_id = $1 LIMIT 1",
            [remote.assigneeId],
          )
        : [];
      const status =
        remote.status === "ready"
          ? "todo"
          : remote.status === "in_progress" || remote.status === "review"
            ? "doing"
            : remote.status;
      const createdAt = Date.parse(remote.createdAt);
      await db.execute(
        `INSERT INTO tasks
          (id, project_id, title, description, status, assignee_agent_id,
           due_date, sort_order, branch, last_run_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,'','',$8)
         ON CONFLICT(id) DO UPDATE SET
           project_id=excluded.project_id,
           title=excluded.title,
           description=excluded.description,
           status=excluded.status,
           assignee_agent_id=excluded.assignee_agent_id,
           due_date=excluded.due_date`,
        [
          task.localId,
          projectId,
          remote.title,
          remote.description,
          status,
          assigneeLink[0]?.local_id ?? "",
          remote.dueDate ?? "",
          Number.isFinite(createdAt) ? createdAt : now(),
        ],
      );
    }
    for (const remote of body.teams ?? []) {
      const team = await resolveLocal("team", remote.id, async () => {
        if (remote.sourceTeamId) {
          const source = await db.select<{ id: string }[]>(
            "SELECT id FROM teams WHERE id = $1 LIMIT 1",
            [remote.sourceTeamId],
          );
          if (source[0]) return source[0].id;
        }
        const rows = await db.select<{ id: string }[]>(
          `SELECT id FROM teams WHERE lower(trim(name)) = lower(trim($1))
           ORDER BY (id LIKE 'portal-%') ASC, created_at ASC LIMIT 1`,
          [remote.name],
        );
        return rows[0]?.id ?? null;
      });
      if (!team) continue;
      await db.execute(
        `INSERT INTO teams
          (id, name, description, charter, avatar, created_at)
         VALUES ($1,$2,$3,'','',$4)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           description=excluded.description`,
        [team.localId, remote.name, remote.purpose, now()],
      );
      const localAgentIds: string[] = [];
      for (const remoteAgentId of remote.agentIds) {
        const links = await db.select<{ local_id: string }[]>(
          "SELECT local_id FROM portal_links WHERE entity = 'agent' AND remote_id = $1 LIMIT 1",
          [remoteAgentId],
        );
        if (links[0]?.local_id) localAgentIds.push(links[0].local_id);
      }
      await db.execute("DELETE FROM team_members WHERE team_id = $1", [team.localId]);
      for (const agentId of localAgentIds) {
        await db.execute(
          "INSERT OR IGNORE INTO team_members (team_id, agent_id) VALUES ($1,$2)",
          [team.localId, agentId],
        );
      }
    }
    await applySharedPortalResponse(
      connection,
      body.currentUserId ?? "",
      memberIds,
      body.sharedAcks ?? [],
      body.tombstones ?? [],
      body.knowledgePages ?? [],
      body.calendars ?? [],
      body.calendarEvents ?? [],
      body.contentRevision ?? connection.content_revision ?? 0,
    );
    await deliverCalendarCommands(connection);
    const categories: Record<string, "mail" | "calendar" | "social"> = {
      google: "calendar",
      microsoft: "mail",
      x: "social",
      tiktok: "social",
      meta: "social",
    };
    for (const remote of body.connections ?? []) {
      const projectLinks: Array<{ projectId: string; isDefault: boolean }> = [];
      for (const remoteLink of remote.projectLinks ?? []) {
        const links = await db.select<{ local_id: string }[]>(
          "SELECT local_id FROM portal_links WHERE entity = 'project' AND remote_id = $1 LIMIT 1",
          [remoteLink.projectId],
        );
        if (links[0]?.local_id) {
          projectLinks.push({
            projectId: links[0].local_id,
            isDefault: Boolean(remoteLink.isDefault),
          });
        }
      }
      const connectionMetadata = JSON.stringify({
        connectionId: remote.id,
        scopes: remote.scopes,
        lastSyncAt: remote.lastSyncAt,
        projectLinks,
      });
      // Google and Microsoft accounts power more than one native surface.
      if (remote.kind === "google" || remote.kind === "microsoft") {
        for (const extraCategory of ["mail", "calendar"] as const) {
          await db.execute(
            `INSERT INTO integration_accounts
             (id, category, provider, label, handle, status, metadata, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
             ON CONFLICT(id) DO UPDATE SET
               label=excluded.label,
               handle=excluded.handle,
               status=excluded.status,
               metadata=excluded.metadata,
               updated_at=excluded.updated_at`,
            [
              `portal-${remote.id}-${extraCategory}`,
              extraCategory,
              remote.kind === "microsoft" ? "microsoft" : "google",
              remote.label,
              remote.accountLabel,
              remote.status,
              connectionMetadata,
              now(),
            ]
          );
        }
        continue;
      }
      const category = categories[remote.kind] ?? "social";
      await db.execute(
        `INSERT INTO integration_accounts
         (id, category, provider, label, handle, status, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT(id) DO UPDATE SET
           category=excluded.category,
           provider=excluded.provider,
           label=excluded.label,
           handle=excluded.handle,
           status=excluded.status,
           metadata=excluded.metadata,
           updated_at=excluded.updated_at`,
        [
          `portal-${remote.id}`,
          category,
          remote.kind,
          remote.label,
          remote.accountLabel,
          remote.status,
          connectionMetadata,
          now(),
        ]
      );
    }
    await db.execute(
      `UPDATE portal_connection
          SET last_sync_at = $1, status = 'online', last_error = ''
        WHERE id = 1`,
      [Number.isFinite(syncedAt) ? syncedAt : now()]
    );
    await useStore.getState().refreshAll();
    const activeView = useStore.getState().view;
    const activeChannelId =
      activeView.type === "workspace" || activeView.type === "channel"
        ? activeView.channelId
        : undefined;
    if (activeChannelId) {
      await useStore.getState().loadMessages(activeChannelId);
    }
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const db = await getDb();
    await db.execute(
      `UPDATE portal_connection
          SET status = 'error', last_error = $1
        WHERE id = 1`,
      [message]
    );
    throw reason;
  }
  return loadPortalConnection();
}

let syncTimer = 0;
let requestedSyncTimer = 0;
let syncInFlight: Promise<PortalConnection | null> | null = null;
let syncQueued = false;

function runPortalSync() {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }
  syncQueued = false;
  syncInFlight = syncPortal().finally(() => {
    syncInFlight = null;
    if (syncQueued) {
      syncQueued = false;
      requestedSyncTimer = window.setTimeout(
        () => void runPortalSync().catch(() => {}),
        0
      );
    }
  });
  return syncInFlight;
}

export function initPortalSync(): () => void {
  window.clearInterval(syncTimer);
  window.clearTimeout(requestedSyncTimer);
  const run = () => void runPortalSync().catch(() => {});
  const syncLocalChange = () => {
    window.clearTimeout(requestedSyncTimer);
    requestedSyncTimer = window.setTimeout(run, 250);
  };
  const first = window.setTimeout(run, 1_500);
  syncTimer = window.setInterval(run, 15_000);
  window.addEventListener("hq:portal-local-change", syncLocalChange);
  return () => {
    window.clearTimeout(first);
    window.clearTimeout(requestedSyncTimer);
    window.clearInterval(syncTimer);
    window.removeEventListener("hq:portal-local-change", syncLocalChange);
  };
}
