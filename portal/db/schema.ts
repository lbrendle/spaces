import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("workspaces_slug_idx").on(table.slug)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    displayName: text("display_name").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("memberships_user_idx").on(table.userId),
  ],
);

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").notNull(),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("invites_token_idx").on(table.tokenHash),
    index("invites_workspace_idx").on(table.workspaceId),
  ],
);

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    topic: text("topic").notNull(),
    mode: text("mode").notNull().default("lead"),
    leadAgentId: text("lead_agent_id"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("channels_workspace_name_idx").on(
      table.workspaceId,
      table.name,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    authorType: text("author_type").notNull().default("user"),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    parentId: text("parent_id").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("messages_channel_idx").on(table.channelId, table.createdAt)],
);

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id"),
    cycleId: text("cycle_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    assigneeId: text("assignee_id"),
    createdBy: text("created_by").notNull(),
    dueDate: text("due_date"),
    source: text("source").notNull().default("portal"),
    sourceId: text("source_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("issues_workspace_status_idx").on(table.workspaceId, table.status),
    uniqueIndex("issues_source_idx").on(
      table.workspaceId,
      table.source,
      table.sourceId,
    ),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("decisions_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);

export const knowledgePages = sqliteTable(
  "knowledge_pages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    body: text("body").notNull(),
    kind: text("kind").notNull(),
    tagsJson: text("tags_json").notNull(),
    createdBy: text("created_by").notNull(),
    ownerUserId: text("owner_user_id").notNull().default(""),
    visibility: text("visibility").notNull().default("workspace"),
    sourceType: text("source_type").notNull().default("portal"),
    sourceDeviceId: text("source_device_id").notNull().default(""),
    sourceRecordId: text("source_record_id").notNull().default(""),
    sourceCollectionId: text("source_collection_id").notNull().default(""),
    sourceLabel: text("source_label").notNull().default(""),
    path: text("path").notNull().default(""),
    revision: integer("revision").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_pages_workspace_slug_idx").on(
      table.workspaceId,
      table.slug,
    ),
    index("knowledge_pages_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    uniqueIndex("knowledge_pages_source_idx").on(
      table.workspaceId,
      table.sourceDeviceId,
      table.sourceRecordId,
    ).where(sql`${table.sourceRecordId} <> ''`),
  ],
);

export const knowledgeAccess = sqliteTable(
  "knowledge_access",
  {
    workspaceId: text("workspace_id").notNull(),
    pageId: text("page_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    access: text("access").notNull().default("read"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.pageId,
        table.subjectType,
        table.subjectId,
      ],
    }),
    index("knowledge_access_subject_idx").on(
      table.workspaceId,
      table.subjectType,
      table.subjectId,
    ),
  ],
);

export const pageLinks = sqliteTable(
  "page_links",
  {
    workspaceId: text("workspace_id").notNull(),
    fromPageId: text("from_page_id").notNull(),
    toPageId: text("to_page_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.fromPageId, table.toPageId],
    }),
    index("page_links_to_idx").on(table.workspaceId, table.toPageId),
  ],
);

export const sharedCalendars = sqliteTable(
  "shared_calendars",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceDeviceId: text("source_device_id").notNull().default(""),
    sourceCalendarId: text("source_calendar_id").notNull().default(""),
    name: text("name").notNull(),
    color: text("color").notNull().default(""),
    provider: text("provider").notNull().default("hq"),
    externalId: text("external_id").notNull().default(""),
    ownerType: text("owner_type").notNull().default("member"),
    ownerId: text("owner_id").notNull().default(""),
    ownerLabel: text("owner_label").notNull().default(""),
    visibility: text("visibility").notNull().default("private"),
    writable: integer("writable").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (table) => [
    index("shared_calendars_workspace_idx").on(table.workspaceId),
    uniqueIndex("shared_calendars_source_idx").on(
      table.workspaceId,
      table.sourceDeviceId,
      table.sourceCalendarId,
    ).where(sql`${table.sourceCalendarId} <> ''`),
  ],
);

export const sharedCalendarAccess = sqliteTable(
  "shared_calendar_access",
  {
    workspaceId: text("workspace_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    access: text("access").notNull().default("busy"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.calendarId,
        table.subjectType,
        table.subjectId,
      ],
    }),
    index("shared_calendar_access_subject_idx").on(
      table.workspaceId,
      table.subjectType,
      table.subjectId,
    ),
  ],
);

export const sharedCalendarEvents = sqliteTable(
  "shared_calendar_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    calendarId: text("calendar_id").notNull(),
    sourceDeviceId: text("source_device_id").notNull().default(""),
    sourceEventId: text("source_event_id").notNull().default(""),
    externalId: text("external_id").notNull().default(""),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    allDay: integer("all_day").notNull().default(0),
    tz: text("tz").notNull().default(""),
    organizer: text("organizer").notNull().default(""),
    attendeesJson: text("attendees_json").notNull().default("[]"),
    status: text("status").notNull().default("confirmed"),
    source: text("source").notNull().default("hq"),
    etag: text("etag").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (table) => [
    index("shared_calendar_events_span_idx").on(
      table.workspaceId,
      table.startsAt,
      table.endsAt,
    ),
    index("shared_calendar_events_calendar_idx").on(
      table.calendarId,
      table.startsAt,
    ),
    uniqueIndex("shared_calendar_events_source_idx").on(
      table.workspaceId,
      table.sourceDeviceId,
      table.sourceEventId,
    ).where(sql`${table.sourceEventId} <> ''`),
  ],
);

export const calendarCommands = sqliteTable(
  "calendar_commands",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    deviceId: text("device_id").notNull(),
    eventId: text("event_id").notNull(),
    calendarName: text("calendar_name").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("queued"),
    error: text("error").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("calendar_commands_event_idx").on(table.eventId),
    index("calendar_commands_device_status_idx").on(
      table.deviceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const contentTombstones = sqliteTable(
  "content_tombstones",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    createdBy: text("created_by").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("content_tombstones_workspace_revision_idx").on(
      table.workspaceId,
      table.revision,
    ),
    uniqueIndex("content_tombstones_entity_idx").on(
      table.workspaceId,
      table.entity,
      table.entityId,
    ),
  ],
);

export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    senderName: text("sender_name").notNull(),
    senderAddress: text("sender_address").notNull(),
    status: text("status").notNull(),
    assigneeId: text("assignee_id"),
    labelsJson: text("labels_json").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("inbox_workspace_status_idx").on(table.workspaceId, table.status),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    leadId: text("lead_id"),
    targetDate: text("target_date"),
    sourceDeviceId: text("source_device_id").notNull().default(""),
    sourceProjectId: text("source_project_id").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("projects_workspace_idx").on(table.workspaceId, table.status),
    index("projects_source_idx").on(
      table.workspaceId,
      table.sourceDeviceId,
      table.sourceProjectId,
    ),
  ],
);

export const projectSources = sqliteTable(
  "project_sources",
  {
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    deviceId: text("device_id").notNull(),
    sourceProjectId: text("source_project_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.sourceProjectId] }),
    index("project_sources_project_idx").on(table.workspaceId, table.projectId),
  ],
);

export const cycles = sqliteTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("cycles_workspace_idx").on(table.workspaceId, table.status)],
);

export const agentProfiles = sqliteTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    owns: text("owns").notNull(),
    backend: text("backend").notNull(),
    model: text("model").notNull().default(""),
    effort: text("effort").notNull().default(""),
    status: text("status").notNull(),
    ownerUserId: text("owner_user_id"),
    hostDeviceId: text("host_device_id"),
    visibility: text("visibility").notNull().default("workspace"),
    persona: text("persona").notNull().default(""),
    cliArgsJson: text("cli_args_json").notNull().default("[]"),
    sourceAgentId: text("source_agent_id").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("agent_profiles_workspace_idx").on(table.workspaceId)],
);

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    sourceDeviceId: text("source_device_id").notNull().default(""),
    sourceTeamId: text("source_team_id").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("teams_workspace_name_idx").on(table.workspaceId, table.name),
    uniqueIndex("teams_source_idx").on(
      table.workspaceId,
      table.sourceDeviceId,
      table.sourceTeamId,
    ).where(sql`${table.sourceTeamId} <> ''`),
  ],
);

export const teamActors = sqliteTable(
  "team_actors",
  {
    teamId: text("team_id").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.actorType, table.actorId] }),
  ],
);

export const deviceCodes = sqliteTable(
  "device_codes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    codeHash: text("code_hash").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at").notNull(),
    claimedAt: text("claimed_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("device_codes_hash_idx").on(table.codeHash)],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    ownerUserId: text("owner_user_id").notNull().default(""),
    platform: text("platform").notNull().default(""),
    toolsJson: text("tools_json").notNull().default("[]"),
    status: text("status").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("devices_token_idx").on(table.tokenHash),
    index("devices_workspace_idx").on(table.workspaceId),
  ],
);

export const agentJobs = sqliteTable(
  "agent_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    requestedByDeviceId: text("requested_by_device_id").notNull(),
    hostDeviceId: text("host_device_id").notNull(),
    projectId: text("project_id"),
    channelId: text("channel_id").notNull().default(""),
    requesterRunId: text("requester_run_id").notNull(),
    inputJson: text("input_json").notNull(),
    status: text("status").notNull(),
    leaseTokenHash: text("lease_token_hash"),
    leaseExpiresAt: text("lease_expires_at"),
    resultJson: text("result_json"),
    error: text("error").notNull().default(""),
    createdAt: text("created_at").notNull(),
    claimedAt: text("claimed_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("agent_jobs_host_status_idx").on(
      table.hostDeviceId,
      table.status,
      table.createdAt,
    ),
    index("agent_jobs_requester_status_idx").on(
      table.requestedByDeviceId,
      table.status,
      table.createdAt,
    ),
    uniqueIndex("agent_jobs_requester_run_idx").on(
      table.workspaceId,
      table.requestedByDeviceId,
      table.requesterRunId,
    ),
  ],
);

export const deviceSnapshots = sqliteTable(
  "device_snapshots",
  {
    deviceId: text("device_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("device_snapshots_workspace_idx").on(table.workspaceId)],
);

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull(),
    accountLabel: text("account_label").notNull().default(""),
    scopesJson: text("scopes_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    lastSyncAt: text("last_sync_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("connections_workspace_idx").on(table.workspaceId, table.kind),
  ],
);

export const projectConnections = sqliteTable(
  "project_connections",
  {
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    connectionId: text("connection_id").notNull(),
    isDefault: integer("is_default").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.connectionId] }),
    index("project_connections_workspace_project_idx").on(
      table.workspaceId,
      table.projectId,
    ),
    index("project_connections_connection_idx").on(table.connectionId),
  ],
);

export const oauthStates = sqliteTable(
  "oauth_states",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    projectId: text("project_id").notNull().default(""),
    codeVerifier: text("code_verifier").notNull().default(""),
    scopesJson: text("scopes_json").notNull().default("[]"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("oauth_states_expiry_idx").on(table.expiresAt),
    index("oauth_states_workspace_idx").on(table.workspaceId, table.provider),
  ],
);

export const connectionSecrets = sqliteTable(
  "connection_secrets",
  {
    connectionId: text("connection_id").primaryKey(),
    encryptedJson: text("encrypted_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorId: text("actor_id").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("activity_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);

export const workspaceEvents = sqliteTable(
  "workspace_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id").notNull(),
    actorId: text("actor_id").notNull(),
    kind: text("kind").notNull(),
    entityId: text("entity_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("workspace_events_workspace_sequence_idx").on(
      table.workspaceId,
      table.sequence,
    ),
  ],
);
