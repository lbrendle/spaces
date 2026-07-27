import { getDb, now, uid } from "./db";
import { cancelRunsWhere } from "./runbus";
import type {
  Agent,
  Calendar,
  CalendarEvent,
  CalendarShare,
  Member,
  Team,
  TeamMember,
  Vault,
  VaultFile,
} from "./types";
import type { ContentItem, DocumentRecord } from "./operations";

interface ConnectionIdentity {
  device_id: string;
  workspace_id: string;
  content_revision?: number;
}

interface SyncStateRow {
  entity: string;
  local_id: string;
  remote_id: string;
  fingerprint: string;
}

export interface SharedSyncAck {
  entity:
    | "document"
    | "vault"
    | "vault_file"
    | "calendar"
    | "event"
    | "content_item";
  sourceId: string;
  remoteId: string;
  fingerprint: string;
}

export interface RemoteKnowledgePage {
  id: string;
  title: string;
  slug: string;
  body: string;
  kind: string;
  tags: string[];
  backlinkCount: number;
  sourceType: "portal" | "document" | "vault";
  sourceLabel: string;
  sourceDeviceId: string;
  sourceRecordId: string;
  sourceCollectionId: string;
  path: string;
  ownerUserId: string;
  visibility: "private" | "workspace";
  access: "read" | "write";
  updatedAt: string;
}

export interface RemoteCalendar {
  id: string;
  name: string;
  color: string;
  provider: string;
  externalId: string;
  ownerType: "member" | "agent" | "team" | "workspace";
  ownerId: string;
  ownerLabel: string;
  visibility: "private" | "busy" | "read" | "write";
  writable: number;
  access: "busy" | "read" | "write";
  sourceDeviceId: string;
  sourceCalendarId: string;
  updatedAt: string;
}

export interface RemoteCalendarEvent {
  id: string;
  calendarId: string;
  externalId: string;
  title: string;
  description: string;
  location: string;
  startsAt: number;
  endsAt: number;
  allDay: number;
  tz: string;
  organizer: string;
  attendees: Array<Record<string, unknown>>;
  status: "confirmed" | "tentative" | "cancelled";
  source: string;
  etag: string;
  access: "busy" | "read" | "write";
  redacted: boolean;
  sourceDeviceId: string;
  sourceEventId: string;
  updatedAt: string;
}

export interface RemoteContentItem {
  id: string;
  projectId: string;
  campaign: string;
  title: string;
  brief: string;
  copy: string;
  platform: string;
  connectionId: string;
  status: ContentItem["status"];
  scheduledAt: number;
  publishedUrl: string;
  mediaUrl: string;
  publishError: string;
  agentId: string;
  createdBy: string;
  sourceDeviceId: string;
  sourceContentId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface RemoteTombstone {
  entity:
    | "document"
    | "vault"
    | "vault_file"
    | "calendar"
    | "event"
    | "project"
    | "project_source"
    | "channel"
    | "task"
    | "content_item";
  entityId: string;
  revision: number;
}

interface KnowledgeRecord {
  entity: "document" | "vault" | "vault_file";
  sourceId: string;
  fingerprint: string;
  deleted?: boolean;
  shared?: boolean;
  collectionSourceId?: string;
  title?: string;
  body?: string;
  kind?: string;
  tags?: string[];
  sourceLabel?: string;
  path?: string;
  ownerUserId?: string;
  visibility?: "private" | "workspace";
  shares?: SharedAccess[];
  updatedAt?: number;
}

interface CalendarRecord {
  sourceId: string;
  fingerprint: string;
  deleted?: boolean;
  name?: string;
  color?: string;
  provider?: string;
  externalId?: string;
  ownerType?: Calendar["owner_type"];
  ownerId?: string;
  ownerLabel?: string;
  visibility?: Calendar["visibility"];
  writable?: number;
  shares?: SharedAccess[];
}

interface EventRecord {
  sourceId: string;
  calendarSourceId: string;
  fingerprint: string;
  deleted?: boolean;
  externalId?: string;
  title?: string;
  description?: string;
  location?: string;
  startsAt?: number;
  endsAt?: number;
  allDay?: number;
  tz?: string;
  organizer?: string;
  attendees?: Array<Record<string, unknown>>;
  status?: CalendarEvent["status"];
  source?: string;
  etag?: string;
  updatedAt?: number;
}

interface ContentItemRecord {
  sourceId: string;
  remoteId: string;
  fingerprint: string;
  deleted?: boolean;
  projectId?: string;
  projectPortalId?: string;
  campaign?: string;
  title?: string;
  brief?: string;
  copy?: string;
  platform?: string;
  connectionId?: string;
  status?: ContentItem["status"];
  scheduledAt?: number;
  publishedUrl?: string;
  mediaUrl?: string;
  publishError?: string;
  agentId?: string;
  agentPortalId?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface SharedAccess {
  subjectType: "member" | "team" | "agent";
  subjectId: string;
  access: string;
}

export interface SharedPortalPayload {
  contentRevision: number;
  teamProfiles: Array<{
    id: string;
    portalId: string;
    name: string;
    purpose: string;
    agentIds: string[];
  }>;
  knowledgeRecords: KnowledgeRecord[];
  calendarRecords: CalendarRecord[];
  calendarEventRecords: EventRecord[];
  contentItemRecords: ContentItemRecord[];
}

const MIRROR_TABLE = {
  document: "documents",
  vault: "vaults",
  vault_file: "vault_files",
  calendar: "calendars",
  event: "events",
  content_item: "content_items",
} as const;

function syncKey(entity: string, localId: string): string {
  return `${entity}:${localId}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseObjects(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      : [];
  } catch {
    return [];
  }
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 40);
}

async function remoteIdFor(
  entity: "agent" | "team" | "project" | "content_item",
  localId: string,
): Promise<string> {
  const db = await getDb();
  const rows = await db.select<{ remote_id: string }[]>(
    "SELECT remote_id FROM portal_links WHERE entity = $1 AND local_id = $2 LIMIT 1",
    [entity, localId],
  );
  return rows[0]?.remote_id ?? "";
}

async function subjectAccess(
  share: { subject_type: "member" | "team" | "agent"; subject_id: string; access: string },
  members: Map<string, Member>,
): Promise<SharedAccess | null> {
  const subjectId =
    share.subject_type === "member"
      ? members.get(share.subject_id)?.portal_user_id ?? ""
      : await remoteIdFor(share.subject_type, share.subject_id);
  return subjectId
    ? {
        subjectType: share.subject_type,
        subjectId,
        access: share.access,
      }
    : null;
}

async function ownerPortalId(
  ownerType: Calendar["owner_type"],
  ownerId: string,
  members: Map<string, Member>,
  connection: ConnectionIdentity,
): Promise<string> {
  if (ownerType === "workspace") return connection.workspace_id;
  if (ownerType === "member") return members.get(ownerId)?.portal_user_id ?? "";
  return remoteIdFor(ownerType, ownerId);
}

function ownerName(
  ownerType: Calendar["owner_type"],
  ownerId: string,
  members: Map<string, Member>,
  agents: Map<string, Agent>,
  teams: Map<string, Team>,
): string {
  if (ownerType === "workspace") return "Workspace";
  if (ownerType === "member") return members.get(ownerId)?.name ?? "";
  if (ownerType === "agent") return agents.get(ownerId)?.name ?? "";
  return teams.get(ownerId)?.name ?? "";
}

function changed(
  states: Map<string, SyncStateRow>,
  entity: string,
  localId: string,
  fingerprint: string,
): boolean {
  return states.get(syncKey(entity, localId))?.fingerprint !== fingerprint;
}

export async function buildSharedPortalPayload(
  connection: ConnectionIdentity,
): Promise<SharedPortalPayload> {
  const db = await getDb();
  const [
    stateRows,
    documents,
    documentShares,
    vaults,
    vaultFiles,
    calendars,
    calendarShares,
    events,
    members,
    agents,
    teams,
    teamMembers,
    mirrorRows,
    accounts,
    contentItems,
  ] = await Promise.all([
    db.select<SyncStateRow[]>("SELECT * FROM portal_sync_state"),
    db.select<DocumentRecord[]>("SELECT * FROM documents ORDER BY updated_at DESC"),
    db.select<Array<{ document_id: string; subject_type: "member" | "team" | "agent"; subject_id: string; access: string }>>(
      "SELECT * FROM document_shares",
    ),
    db.select<Vault[]>("SELECT * FROM vaults ORDER BY last_indexed_at DESC"),
    db.select<VaultFile[]>("SELECT * FROM vault_files ORDER BY modified_at DESC"),
    db.select<Calendar[]>("SELECT * FROM calendars ORDER BY created_at"),
    db.select<CalendarShare[]>("SELECT * FROM calendar_shares"),
    db.select<CalendarEvent[]>(
      `SELECT * FROM events
        WHERE starts_at < $1 AND ends_at > $2
        ORDER BY updated_at DESC`,
      [Date.now() + 730 * 86_400_000, Date.now() - 180 * 86_400_000],
    ),
    db.select<Member[]>("SELECT * FROM members WHERE status != 'removed'"),
    db.select<Agent[]>("SELECT * FROM agents"),
    db.select<Team[]>("SELECT * FROM teams"),
    db.select<TeamMember[]>("SELECT * FROM team_members"),
    db.select<Array<{ entity: string; local_id: string }>>(
      "SELECT entity, local_id FROM portal_links WHERE entity IN ('team','document','vault','vault_file','calendar','event','content_item')",
    ),
    db.select<Array<{ id: string; provider: string }>>(
      "SELECT id, provider FROM calendar_accounts",
    ),
    db.select<ContentItem[]>(
      "SELECT * FROM content_items ORDER BY updated_at DESC",
    ),
  ]);
  const states = new Map(stateRows.map((row) => [syncKey(row.entity, row.local_id), row]));
  const memberMap = new Map(members.map((member) => [member.id, member]));
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const teamMap = new Map(teams.map((team) => [team.id, team]));
  const mirrored = new Set(mirrorRows.map((row) => syncKey(row.entity, row.local_id)));
  const providerByAccount = new Map(accounts.map((account) => [account.id, account.provider]));

  const teamProfiles = await Promise.all(
    teams
      .filter((team) => !mirrored.has(syncKey("team", team.id)))
      .map(async (team) => ({
        id: team.id,
        portalId: await remoteIdFor("team", team.id),
        name: team.name,
        purpose: team.description || team.charter,
        agentIds: teamMembers
          .filter((member) => member.team_id === team.id)
          .map((member) => member.agent_id),
      })),
  );

  const knowledgeRecords: KnowledgeRecord[] = [];
  let knowledgeBudget = 360_000;
  const aliveKnowledge = new Set<string>();
  for (const document of documents) {
    if (document.source.startsWith("portal")) continue;
    aliveKnowledge.add(syncKey("document", document.id));
    const rawShares = documentShares.filter((share) => share.document_id === document.id);
    const shares = (
      await Promise.all(rawShares.map((share) => subjectAccess(share, memberMap)))
    ).filter((share): share is SharedAccess => !!share);
    const shared = document.visibility === "workspace" || shares.length > 0;
    const fingerprint = stable({
      updatedAt: document.updated_at,
      visibility: document.visibility,
      shares,
      shared,
    });
    if (!changed(states, "document", document.id, fingerprint)) continue;
    const prior = states.get(syncKey("document", document.id));
    if (!shared && !prior) continue;
    const record: KnowledgeRecord = {
      entity: "document",
      sourceId: document.id,
      fingerprint,
      shared,
      title: shared ? document.title : undefined,
      body: shared ? document.body : undefined,
      kind: "document",
      tags: shared ? parseTags(document.tags) : undefined,
      sourceLabel: shared ? "Documents" : undefined,
      path: shared ? document.path : undefined,
      ownerUserId: memberMap.get(document.owner_member_id)?.portal_user_id,
      visibility: document.visibility,
      shares,
      updatedAt: document.updated_at,
    };
    const cost = shared ? document.body.length : 64;
    if (cost > knowledgeBudget && knowledgeRecords.length) continue;
    knowledgeBudget -= cost;
    knowledgeRecords.push(record);
  }

  const localVaults = vaults.filter((vault) => !mirrored.has(syncKey("vault", vault.id)));
  const sharedVaultIds = new Set(localVaults.filter((vault) => vault.visibility === "workspace").map((vault) => vault.id));
  for (const vault of localVaults) {
    aliveKnowledge.add(syncKey("vault", vault.id));
    const shared = vault.visibility === "workspace";
    const fingerprint = stable({
      visibility: vault.visibility,
      indexedAt: vault.last_indexed_at,
      fileCount: vault.file_count,
    });
    if (!changed(states, "vault", vault.id, fingerprint)) continue;
    const prior = states.get(syncKey("vault", vault.id));
    if (!shared && !prior) continue;
    knowledgeRecords.push({
      entity: "vault",
      sourceId: vault.id,
      fingerprint,
      shared,
      title: shared ? vault.name : undefined,
      sourceLabel: shared ? vault.name : undefined,
      ownerUserId: memberMap.get(vault.owner_member_id)?.portal_user_id,
      visibility: vault.visibility,
      updatedAt: vault.last_indexed_at || vault.created_at,
    });
  }
  for (const file of vaultFiles) {
    if (!sharedVaultIds.has(file.vault_id)) continue;
    if (mirrored.has(syncKey("vault_file", file.id))) continue;
    aliveKnowledge.add(syncKey("vault_file", file.id));
    const vault = teamSafeFind(localVaults, file.vault_id);
    if (!vault) continue;
    const fingerprint = stable({
      modifiedAt: file.modified_at,
      indexedAt: file.indexed_at,
      size: file.size,
    });
    if (!changed(states, "vault_file", file.id, fingerprint)) continue;
    if (file.body.length > knowledgeBudget && knowledgeRecords.length) continue;
    knowledgeBudget -= file.body.length;
    knowledgeRecords.push({
      entity: "vault_file",
      sourceId: file.id,
      collectionSourceId: file.vault_id,
      fingerprint,
      shared: true,
      title: file.title || file.rel_path.split("/").pop() || "Untitled",
      body: file.body,
      kind: "vault",
      sourceLabel: vault.name,
      path: file.rel_path,
      ownerUserId: memberMap.get(vault.owner_member_id)?.portal_user_id,
      visibility: "workspace",
      shares: [],
      updatedAt: file.modified_at || file.indexed_at,
    });
  }
  for (const state of stateRows) {
    if (!["document", "vault", "vault_file"].includes(state.entity)) continue;
    const key = syncKey(state.entity, state.local_id);
    if (aliveKnowledge.has(key) || state.fingerprint === "deleted") continue;
    knowledgeRecords.push({
      entity: state.entity as KnowledgeRecord["entity"],
      sourceId: state.local_id,
      fingerprint: "deleted",
      deleted: true,
    });
  }

  const calendarRecords: CalendarRecord[] = [];
  const localCalendars = calendars.filter(
    (calendar) => !mirrored.has(syncKey("calendar", calendar.id)),
  );
  const aliveCalendars = new Set<string>();
  for (const calendar of localCalendars) {
    aliveCalendars.add(calendar.id);
    const rawShares = calendarShares.filter((share) => share.calendar_id === calendar.id);
    const shares = (
      await Promise.all(rawShares.map((share) => subjectAccess(share, memberMap)))
    ).filter((share): share is SharedAccess => !!share);
    const ownerId =
      (await ownerPortalId(
        calendar.owner_type,
        calendar.owner_id,
        memberMap,
        connection,
      )) || memberMap.get(members.find((member) => member.is_self)?.id ?? "")?.portal_user_id || "";
    const recordBase = {
      name: calendar.name,
      color: calendar.color,
      provider: providerByAccount.get(calendar.account_id) ?? "hq",
      externalId: calendar.external_id,
      ownerType: calendar.owner_type,
      ownerId,
      ownerLabel: ownerName(
        calendar.owner_type,
        calendar.owner_id,
        memberMap,
        agentMap,
        teamMap,
      ),
      visibility: calendar.visibility,
      writable: calendar.writable,
      shares,
    };
    const fingerprint = stable(recordBase);
    if (!changed(states, "calendar", calendar.id, fingerprint)) continue;
    calendarRecords.push({
      sourceId: calendar.id,
      fingerprint,
      ...recordBase,
    });
  }
  for (const state of stateRows) {
    if (state.entity !== "calendar") continue;
    if (aliveCalendars.has(state.local_id) || state.fingerprint === "deleted") continue;
    calendarRecords.push({
      sourceId: state.local_id,
      fingerprint: "deleted",
      deleted: true,
    });
  }

  const calendarEventRecords: EventRecord[] = [];
  const aliveEvents = new Set<string>();
  for (const event of events) {
    if (!aliveCalendars.has(event.calendar_id)) continue;
    if (mirrored.has(syncKey("event", event.id))) continue;
    aliveEvents.add(event.id);
    const recordBase = {
      externalId: event.external_id,
      title: event.title,
      description: event.description,
      location: event.location,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      allDay: event.all_day,
      tz: event.tz,
      organizer: event.organizer,
      attendees: parseObjects(event.attendees),
      status: event.status,
      source: event.source,
      etag: event.etag,
      updatedAt: event.updated_at,
    };
    const fingerprint = stable(recordBase);
    if (!changed(states, "event", event.id, fingerprint)) continue;
    calendarEventRecords.push({
      sourceId: event.id,
      calendarSourceId: event.calendar_id,
      fingerprint,
      ...recordBase,
    });
    if (calendarEventRecords.length >= 500) break;
  }
  for (const state of stateRows) {
    if (state.entity !== "event") continue;
    if (aliveEvents.has(state.local_id) || state.fingerprint === "deleted") continue;
    calendarEventRecords.push({
      sourceId: state.local_id,
      calendarSourceId: "",
      fingerprint: "deleted",
      deleted: true,
    });
  }

  const contentItemRecords: ContentItemRecord[] = [];
  const aliveContent = new Set<string>();
  for (const item of contentItems) {
    aliveContent.add(item.id);
    const recordBase = {
      projectId: item.project_id,
      projectPortalId: item.project_id
        ? await remoteIdFor("project", item.project_id)
        : "",
      campaign: item.campaign,
      title: item.title,
      brief: item.brief,
      copy: item.copy,
      platform: item.platform,
      connectionId: item.connection_id,
      status: item.status,
      scheduledAt: item.scheduled_at,
      publishedUrl: item.published_url,
      mediaUrl: item.media_url,
      publishError: item.publish_error,
      agentId: item.agent_id,
      agentPortalId: item.agent_id
        ? await remoteIdFor("agent", item.agent_id)
        : "",
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
    const fingerprint = stable(recordBase);
    if (!changed(states, "content_item", item.id, fingerprint)) continue;
    contentItemRecords.push({
      sourceId: item.id,
      remoteId: await remoteIdFor("content_item", item.id),
      fingerprint,
      ...recordBase,
    });
  }
  for (const state of stateRows) {
    if (state.entity !== "content_item") continue;
    if (aliveContent.has(state.local_id) || state.fingerprint === "deleted") continue;
    contentItemRecords.push({
      sourceId: state.local_id,
      remoteId: state.remote_id,
      fingerprint: "deleted",
      deleted: true,
    });
  }

  return {
    contentRevision: connection.content_revision ?? 0,
    teamProfiles,
    knowledgeRecords: knowledgeRecords.slice(0, 250),
    calendarRecords: calendarRecords.slice(0, 100),
    calendarEventRecords: calendarEventRecords.slice(0, 500),
    contentItemRecords: contentItemRecords.slice(0, 500),
  };
}

function teamSafeFind(vaults: Vault[], id: string): Vault | undefined {
  return vaults.find((vault) => vault.id === id);
}

async function resolveMirror(
  entity: keyof typeof MIRROR_TABLE,
  remoteId: string,
): Promise<string | null> {
  const db = await getDb();
  const mapped = await db.select<Array<{ local_id: string }>>(
    "SELECT local_id FROM portal_links WHERE entity = $1 AND remote_id = $2",
    [entity, remoteId],
  );
  if (mapped.length) {
    const localId = mapped[0].local_id;
    const alive = await db.select<Array<{ id: string }>>(
      `SELECT id FROM ${MIRROR_TABLE[entity]} WHERE id = $1`,
      [localId],
    );
    return alive.length ? localId : null;
  }
  const localId = uid();
  await db.execute(
    "INSERT INTO portal_links (entity, remote_id, local_id) VALUES ($1,$2,$3)",
    [entity, remoteId, localId],
  );
  return localId;
}

async function localOwnerId(
  ownerType: RemoteCalendar["ownerType"] | "member",
  remoteId: string,
  memberIds: Map<string, string>,
): Promise<string> {
  if (ownerType === "member") return memberIds.get(remoteId) ?? "";
  if (ownerType === "workspace") return "";
  const db = await getDb();
  const rows = await db.select<Array<{ local_id: string }>>(
    "SELECT local_id FROM portal_links WHERE entity = $1 AND remote_id = $2 LIMIT 1",
    [ownerType, remoteId],
  );
  return rows[0]?.local_id ?? "";
}

async function removeRemoteMirror(tombstone: RemoteTombstone): Promise<void> {
  const db = await getDb();
  const mapped = await db.select<Array<{ local_id: string }>>(
    "SELECT local_id FROM portal_links WHERE entity = $1 AND remote_id = $2 LIMIT 1",
    [tombstone.entity, tombstone.entityId],
  );
  const localId = mapped[0]?.local_id;
  if (!localId) return;

  if (tombstone.entity === "document") {
    await db.execute("DELETE FROM document_shares WHERE document_id = $1", [localId]);
    await db.execute("DELETE FROM document_versions WHERE document_id = $1", [localId]);
    await db.execute("DELETE FROM documents WHERE id = $1 AND source = 'portal'", [localId]);
  } else if (tombstone.entity === "vault_file") {
    await db.execute("DELETE FROM vault_files WHERE id = $1", [localId]);
  } else if (tombstone.entity === "vault") {
    await db.execute("DELETE FROM vault_files WHERE vault_id = $1", [localId]);
    await db.execute("DELETE FROM vaults WHERE id = $1 AND path = ''", [localId]);
  } else if (tombstone.entity === "event") {
    await db.execute("DELETE FROM events WHERE id = $1", [localId]);
  } else if (tombstone.entity === "calendar") {
    await db.execute("DELETE FROM events WHERE calendar_id = $1", [localId]);
    await db.execute("DELETE FROM calendar_shares WHERE calendar_id = $1", [localId]);
    await db.execute("DELETE FROM calendars WHERE id = $1 AND account_id = ''", [localId]);
  } else if (tombstone.entity === "project") {
    const channels = await db.select<Array<{ id: string }>>(
      "SELECT id FROM channels WHERE project_id = $1",
      [localId],
    );
    for (const channel of channels) {
      cancelRunsWhere((handle) => handle.channelId === channel.id);
      await db.execute(
        `DELETE FROM links
          WHERE (from_type = 'channel' AND from_id = $1)
             OR (to_type = 'channel' AND to_id = $1)
             OR (from_type = 'message' AND from_id IN (
                  SELECT id FROM messages WHERE channel_id = $1
                ))
             OR (to_type = 'message' AND to_id IN (
                  SELECT id FROM messages WHERE channel_id = $1
                ))`,
        [channel.id],
      );
      await db.execute(
        `DELETE FROM assignments
          WHERE (target_type = 'channel' AND target_id = $1)
             OR (subject_type = 'channel' AND subject_id = $1)
             OR (target_type = 'message' AND target_id IN (
                  SELECT id FROM messages WHERE channel_id = $1
                ))
             OR (subject_type = 'message' AND subject_id IN (
                  SELECT id FROM messages WHERE channel_id = $1
                ))`,
        [channel.id],
      );
      await db.execute(
        "DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)",
        [channel.id],
      );
      await db.execute(
        "DELETE FROM portal_links WHERE entity = 'message' AND local_id IN (SELECT id FROM messages WHERE channel_id = $1)",
        [channel.id],
      );
      await db.execute("DELETE FROM queue WHERE channel_id = $1", [channel.id]);
      await db.execute("DELETE FROM messages WHERE channel_id = $1", [channel.id]);
      await db.execute("DELETE FROM channel_members WHERE channel_id = $1", [channel.id]);
      await db.execute("DELETE FROM runs WHERE channel_id = $1", [channel.id]);
      await db.execute("DELETE FROM agent_sessions WHERE channel_id = $1", [channel.id]);
      await db.execute("DELETE FROM channel_reads WHERE channel_id = $1", [channel.id]);
      await db.execute(
        "DELETE FROM portal_links WHERE entity = 'channel' AND local_id = $1",
        [channel.id],
      );
    }
    await db.execute(
      `DELETE FROM links
        WHERE (from_type = 'project' AND from_id = $1)
           OR (to_type = 'project' AND to_id = $1)
           OR (from_type = 'task' AND from_id IN (
                SELECT id FROM tasks WHERE project_id = $1
              ))
           OR (to_type = 'task' AND to_id IN (
                SELECT id FROM tasks WHERE project_id = $1
              ))
           OR (from_type = 'memory' AND from_id IN (
                SELECT id FROM memory WHERE project_id = $1
              ))
           OR (to_type = 'memory' AND to_id IN (
                SELECT id FROM memory WHERE project_id = $1
              ))`,
      [localId],
    );
    await db.execute(
      `DELETE FROM assignments
        WHERE (target_type = 'project' AND target_id = $1)
           OR (subject_type = 'project' AND subject_id = $1)
           OR (target_type = 'task' AND target_id IN (
                SELECT id FROM tasks WHERE project_id = $1
              ))
           OR (subject_type = 'task' AND subject_id IN (
                SELECT id FROM tasks WHERE project_id = $1
              ))
           OR (target_type = 'memory' AND target_id IN (
                SELECT id FROM memory WHERE project_id = $1
              ))
           OR (subject_type = 'memory' AND subject_id IN (
                SELECT id FROM memory WHERE project_id = $1
              ))`,
      [localId],
    );
    await db.execute("DELETE FROM channels WHERE project_id = $1", [localId]);
    await db.execute(
      "DELETE FROM portal_links WHERE entity = 'task' AND local_id IN (SELECT id FROM tasks WHERE project_id = $1)",
      [localId],
    );
    await db.execute("DELETE FROM tasks WHERE project_id = $1", [localId]);
    await db.execute("DELETE FROM memory WHERE project_id = $1", [localId]);
    await db.execute("UPDATE documents SET project_id = '' WHERE project_id = $1", [localId]);
    await db.execute("UPDATE content_items SET project_id = '' WHERE project_id = $1", [localId]);
    await db.execute("DELETE FROM projects WHERE id = $1", [localId]);
  } else if (tombstone.entity === "channel") {
    cancelRunsWhere((handle) => handle.channelId === localId);
    await db.execute(
      `DELETE FROM links
        WHERE (from_type = 'channel' AND from_id = $1)
           OR (to_type = 'channel' AND to_id = $1)
           OR (from_type = 'message' AND from_id IN (
                SELECT id FROM messages WHERE channel_id = $1
              ))
           OR (to_type = 'message' AND to_id IN (
                SELECT id FROM messages WHERE channel_id = $1
              ))`,
      [localId],
    );
    await db.execute(
      `DELETE FROM assignments
        WHERE (target_type = 'channel' AND target_id = $1)
           OR (subject_type = 'channel' AND subject_id = $1)
           OR (target_type = 'message' AND target_id IN (
                SELECT id FROM messages WHERE channel_id = $1
              ))
           OR (subject_type = 'message' AND subject_id IN (
                SELECT id FROM messages WHERE channel_id = $1
              ))`,
      [localId],
    );
    await db.execute(
      "DELETE FROM portal_links WHERE entity = 'message' AND local_id IN (SELECT id FROM messages WHERE channel_id = $1)",
      [localId],
    );
    await db.execute(
      "DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)",
      [localId],
    );
    await db.execute("DELETE FROM queue WHERE channel_id = $1", [localId]);
    await db.execute("DELETE FROM messages WHERE channel_id = $1", [localId]);
    await db.execute("DELETE FROM channel_members WHERE channel_id = $1", [localId]);
    await db.execute("DELETE FROM runs WHERE channel_id = $1", [localId]);
    await db.execute("DELETE FROM agent_sessions WHERE channel_id = $1", [localId]);
    await db.execute("DELETE FROM channel_reads WHERE channel_id = $1", [localId]);
    await db.execute("DELETE FROM channels WHERE id = $1", [localId]);
  } else if (tombstone.entity === "task") {
    await db.execute(
      `DELETE FROM links
        WHERE (from_type = 'task' AND from_id = $1)
           OR (to_type = 'task' AND to_id = $1)`,
      [localId],
    );
    await db.execute(
      `DELETE FROM assignments
        WHERE (target_type = 'task' AND target_id = $1)
           OR (subject_type = 'task' AND subject_id = $1)`,
      [localId],
    );
    await db.execute("DELETE FROM tasks WHERE id = $1", [localId]);
  } else if (tombstone.entity === "content_item") {
    await db.execute("DELETE FROM content_items WHERE id = $1", [localId]);
    await db.execute(
      "DELETE FROM portal_sync_state WHERE entity = 'content_item' AND local_id = $1",
      [localId],
    );
  }

  // A tombstone is authoritative server state, not a user deleting a mirror
  // locally. Removing this mapping lets a still-authorized current row in the
  // same response be materialized again after an ACL change.
  await db.execute(
    "DELETE FROM portal_links WHERE entity = $1 AND remote_id = $2",
    [tombstone.entity, tombstone.entityId],
  );
}

export async function applySharedPortalResponse(
  connection: ConnectionIdentity,
  currentUserId: string,
  memberIds: Map<string, string>,
  acks: SharedSyncAck[],
  tombstones: RemoteTombstone[],
  pages: RemoteKnowledgePage[],
  calendars: RemoteCalendar[],
  events: RemoteCalendarEvent[],
  contentItems: RemoteContentItem[],
  contentRevision: number,
): Promise<void> {
  const db = await getDb();
  for (const ack of acks) {
    if (ack.entity === "content_item") {
      const prior = await db.select<Array<{ local_id: string }>>(
        `SELECT local_id
           FROM portal_links
          WHERE entity = 'content_item' AND remote_id = $1
          LIMIT 1`,
        [ack.remoteId],
      );
      const priorLocalId = prior[0]?.local_id ?? "";
      if (priorLocalId && priorLocalId !== ack.sourceId) {
        const mirrored = await db.select<Array<{ remote_id: string }>>(
          `SELECT remote_id
             FROM portal_sync_state
            WHERE entity = 'content_item' AND local_id = $1
            LIMIT 1`,
          [priorLocalId],
        );
        if (mirrored[0]?.remote_id === ack.remoteId) {
          await db.execute("DELETE FROM content_items WHERE id = $1", [priorLocalId]);
          await db.execute(
            `DELETE FROM portal_sync_state
              WHERE entity = 'content_item' AND local_id = $1`,
            [priorLocalId],
          );
        }
      }
      await db.execute(
        `INSERT INTO portal_links (entity, remote_id, local_id)
         VALUES ('content_item',$1,$2)
         ON CONFLICT(entity, remote_id) DO UPDATE SET
           local_id=excluded.local_id`,
        [ack.remoteId, ack.sourceId],
      );
    }
    await db.execute(
      `INSERT INTO portal_sync_state
        (entity, local_id, remote_id, fingerprint, synced_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(entity, local_id) DO UPDATE SET
         remote_id=excluded.remote_id,
         fingerprint=excluded.fingerprint,
         synced_at=excluded.synced_at`,
      [ack.entity, ack.sourceId, ack.remoteId, ack.fingerprint, now()],
    );
  }

  for (const tombstone of tombstones) {
    await removeRemoteMirror(tombstone);
  }

  const selfLocalId = memberIds.get(currentUserId) ?? "";
  for (const page of pages) {
    if (page.sourceDeviceId === connection.device_id) continue;
    const updatedAt = Number.isFinite(Date.parse(page.updatedAt))
      ? Date.parse(page.updatedAt)
      : now();
    const ownerId = memberIds.get(page.ownerUserId) ?? selfLocalId;
    if (page.sourceType === "vault") {
      const collectionRemoteId = page.sourceCollectionId || `collection:${page.id}`;
      const vaultId = await resolveMirror("vault", collectionRemoteId);
      if (!vaultId) continue;
      await db.execute(
        `INSERT INTO vaults
          (id, name, path, owner_member_id, visibility, exclude,
           file_count, last_indexed_at, created_at)
         VALUES ($1,$2,'',$3,'workspace','',0,$4,$4)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           owner_member_id=excluded.owner_member_id,
           visibility='workspace',
           last_indexed_at=excluded.last_indexed_at`,
        [vaultId, page.sourceLabel || "Shared vault", ownerId, updatedAt],
      );
      const fileId = await resolveMirror("vault_file", page.id);
      if (!fileId) continue;
      await db.execute(
        `INSERT INTO vault_files
          (id, vault_id, rel_path, title, body, size, modified_at, indexed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT(id) DO UPDATE SET
           vault_id=excluded.vault_id,
           rel_path=excluded.rel_path,
           title=excluded.title,
           body=excluded.body,
           size=excluded.size,
           modified_at=excluded.modified_at,
           indexed_at=excluded.indexed_at`,
        [
          fileId,
          vaultId,
          page.path || `${page.title}.md`,
          page.title,
          page.body,
          page.body.length,
          updatedAt,
        ],
      );
      await db.execute(
        `UPDATE vaults
            SET file_count = (SELECT COUNT(*) FROM vault_files WHERE vault_id = $1)
          WHERE id = $1`,
        [vaultId],
      );
      continue;
    }

    const documentId = await resolveMirror("document", page.id);
    if (!documentId) continue;
    await db.execute(
      `INSERT INTO documents
        (id, project_id, title, body, source, tags, path, pinned,
         owner_member_id, visibility, created_at, updated_at)
       VALUES ($1,'',$2,$3,'portal',$4,$5,0,$6,$7,$8,$8)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         body=excluded.body,
         source='portal',
         tags=excluded.tags,
         path=excluded.path,
         owner_member_id=excluded.owner_member_id,
         visibility=excluded.visibility,
         updated_at=excluded.updated_at`,
      [
        documentId,
        page.title,
        page.body,
        page.tags.join(", "),
        page.path || page.sourceLabel || "Shared knowledge",
        ownerId,
        page.visibility,
        updatedAt,
      ],
    );
    await db.execute(
      "DELETE FROM document_shares WHERE document_id = $1 AND subject_type = 'member' AND subject_id = $2",
      [documentId, selfLocalId],
    );
    if (page.visibility === "private" && ownerId !== selfLocalId && selfLocalId) {
      await db.execute(
        `INSERT INTO document_shares
          (document_id, subject_type, subject_id, access)
         VALUES ($1,'member',$2,$3)`,
        [documentId, selfLocalId, page.access],
      );
    }
  }

  const calendarLocalIds = new Map<string, string>();
  for (const calendar of calendars) {
    if (calendar.sourceDeviceId === connection.device_id) continue;
    const calendarId = await resolveMirror("calendar", calendar.id);
    if (!calendarId) continue;
    calendarLocalIds.set(calendar.id, calendarId);
    const ownerId = await localOwnerId(calendar.ownerType, calendar.ownerId, memberIds);
    const createdAt = Number.isFinite(Date.parse(calendar.updatedAt))
      ? Date.parse(calendar.updatedAt)
      : now();
    await db.execute(
      `INSERT INTO calendars
        (id, account_id, external_id, name, color, owner_type, owner_id,
         visibility, writable, enabled, created_at)
       VALUES ($1,'',$2,$3,$4,$5,$6,$7,$8,1,$9)
       ON CONFLICT(id) DO UPDATE SET
         external_id=excluded.external_id,
         name=excluded.name,
         color=excluded.color,
         owner_type=excluded.owner_type,
         owner_id=excluded.owner_id,
         visibility=excluded.visibility,
         writable=excluded.writable`,
      [
        calendarId,
        calendar.externalId,
        calendar.name,
        calendar.color,
        calendar.ownerType,
        ownerId,
        calendar.visibility,
        calendar.writable,
        createdAt,
      ],
    );
    await db.execute(
      "DELETE FROM calendar_shares WHERE calendar_id = $1 AND subject_type = 'member' AND subject_id = $2",
      [calendarId, selfLocalId],
    );
    if (
      calendar.visibility === "private" &&
      !(calendar.ownerType === "member" && ownerId === selfLocalId) &&
      selfLocalId
    ) {
      await db.execute(
        `INSERT INTO calendar_shares
          (calendar_id, subject_type, subject_id, access)
         VALUES ($1,'member',$2,$3)`,
        [calendarId, selfLocalId, calendar.access],
      );
    }
  }

  for (const event of events) {
    if (event.sourceDeviceId === connection.device_id) continue;
    let calendarId = calendarLocalIds.get(event.calendarId);
    if (!calendarId) {
      const mapped = await db.select<Array<{ local_id: string }>>(
        "SELECT local_id FROM portal_links WHERE entity = 'calendar' AND remote_id = $1 LIMIT 1",
        [event.calendarId],
      );
      calendarId = mapped[0]?.local_id;
    }
    if (!calendarId) continue;
    const eventId = await resolveMirror("event", event.id);
    if (!eventId) continue;
    await db.execute(
      `INSERT INTO events
        (id, calendar_id, external_id, title, description, location,
         starts_at, ends_at, all_day, tz, organizer, attendees, status,
         source, updated_at, etag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(id) DO UPDATE SET
         calendar_id=excluded.calendar_id,
         external_id=excluded.external_id,
         title=excluded.title,
         description=excluded.description,
         location=excluded.location,
         starts_at=excluded.starts_at,
         ends_at=excluded.ends_at,
         all_day=excluded.all_day,
         tz=excluded.tz,
         organizer=excluded.organizer,
         attendees=excluded.attendees,
         status=excluded.status,
         source=excluded.source,
         updated_at=excluded.updated_at,
         etag=excluded.etag`,
      [
        eventId,
        calendarId,
        event.externalId,
        event.title,
        event.description,
        event.location,
        event.startsAt,
        event.endsAt,
        event.allDay,
        event.tz,
        event.organizer,
        JSON.stringify(event.attendees),
        event.status,
        event.source === "google" || event.source === "microsoft" ? event.source : "hq",
        Number.isFinite(Date.parse(event.updatedAt)) ? Date.parse(event.updatedAt) : now(),
        event.etag,
      ],
    );
  }

  for (const item of contentItems) {
    let contentId = "";
    if (item.sourceDeviceId === connection.device_id && item.sourceContentId) {
      const source = await db.select<Array<{ id: string }>>(
        "SELECT id FROM content_items WHERE id = $1 LIMIT 1",
        [item.sourceContentId],
      );
      if (source[0]) {
        contentId = source[0].id;
        const prior = await db.select<Array<{ local_id: string }>>(
          `SELECT local_id
             FROM portal_links
            WHERE entity = 'content_item' AND remote_id = $1
            LIMIT 1`,
          [item.id],
        );
        const priorLocalId = prior[0]?.local_id ?? "";
        if (priorLocalId && priorLocalId !== contentId) {
          const mirrored = await db.select<Array<{ remote_id: string }>>(
            `SELECT remote_id
               FROM portal_sync_state
              WHERE entity = 'content_item' AND local_id = $1
              LIMIT 1`,
            [priorLocalId],
          );
          if (mirrored[0]?.remote_id === item.id) {
            await db.execute("DELETE FROM content_items WHERE id = $1", [priorLocalId]);
            await db.execute(
              `DELETE FROM portal_sync_state
                WHERE entity = 'content_item' AND local_id = $1`,
              [priorLocalId],
            );
          }
        }
        await db.execute(
          `INSERT INTO portal_links (entity, remote_id, local_id)
           VALUES ('content_item',$1,$2)
           ON CONFLICT(entity, remote_id) DO UPDATE SET
             local_id=excluded.local_id`,
          [item.id, contentId],
        );
      }
    }
    if (!contentId) {
      contentId = (await resolveMirror("content_item", item.id)) ?? "";
    }
    if (!contentId) continue;
    const project = item.projectId
      ? await db.select<Array<{ local_id: string }>>(
          "SELECT local_id FROM portal_links WHERE entity = 'project' AND remote_id = $1 LIMIT 1",
          [item.projectId],
        )
      : [];
    const agent = item.agentId
      ? await db.select<Array<{ local_id: string }>>(
          "SELECT local_id FROM portal_links WHERE entity = 'agent' AND remote_id = $1 LIMIT 1",
          [item.agentId],
        )
      : [];
    const createdAt = Number.isFinite(Date.parse(item.createdAt))
      ? Date.parse(item.createdAt)
      : now();
    const updatedAt = Number.isFinite(Date.parse(item.updatedAt))
      ? Date.parse(item.updatedAt)
      : now();
    await db.execute(
      `INSERT INTO content_items
        (id, project_id, campaign, title, brief, copy, platform, status,
         connection_id, scheduled_at, published_url, agent_id, media_url,
         publish_error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(id) DO UPDATE SET
         project_id=excluded.project_id,
         campaign=excluded.campaign,
         title=excluded.title,
         brief=excluded.brief,
         copy=excluded.copy,
         platform=excluded.platform,
         status=excluded.status,
         connection_id=excluded.connection_id,
         scheduled_at=excluded.scheduled_at,
         published_url=excluded.published_url,
         agent_id=excluded.agent_id,
         media_url=excluded.media_url,
         publish_error=excluded.publish_error,
         updated_at=excluded.updated_at`,
      [
        contentId,
        project[0]?.local_id ?? "",
        item.campaign,
        item.title,
        item.brief,
        item.copy,
        item.platform,
        item.status,
        item.connectionId,
        Number(item.scheduledAt) || 0,
        item.publishedUrl,
        agent[0]?.local_id ?? "",
        item.mediaUrl,
        item.publishError,
        createdAt,
        updatedAt,
      ],
    );
    const fingerprint = stable({
      projectId: project[0]?.local_id ?? "",
      projectPortalId: item.projectId,
      campaign: item.campaign,
      title: item.title,
      brief: item.brief,
      copy: item.copy,
      platform: item.platform,
      connectionId: item.connectionId,
      status: item.status,
      scheduledAt: Number(item.scheduledAt) || 0,
      publishedUrl: item.publishedUrl,
      mediaUrl: item.mediaUrl,
      publishError: item.publishError,
      agentId: agent[0]?.local_id ?? "",
      agentPortalId: item.agentId,
      createdAt,
      updatedAt,
    });
    await db.execute(
      `INSERT INTO portal_sync_state
        (entity, local_id, remote_id, fingerprint, synced_at)
       VALUES ('content_item',$1,$2,$3,$4)
       ON CONFLICT(entity, local_id) DO UPDATE SET
         remote_id=excluded.remote_id,
         fingerprint=excluded.fingerprint,
         synced_at=excluded.synced_at`,
      [contentId, item.id, fingerprint, now()],
    );
  }

  await db.execute(
    "UPDATE portal_connection SET content_revision = $1 WHERE id = 1",
    [contentRevision],
  );
  window.dispatchEvent(new CustomEvent("hq:content-change"));
}
