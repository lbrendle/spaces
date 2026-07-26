export type WorkspaceRole = "owner" | "admin" | "member" | "guest";
export type IssueStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done";
export type IssuePriority = "low" | "normal" | "high" | "urgent";

export interface PortalUser {
  id?: string;
  email: string;
  name: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  mode: "broadcast" | "sequential" | "lead" | "panel";
  leadAgentId: string | null;
}

export interface Message {
  id: string;
  channelId: string;
  authorType: "user" | "agent" | "system";
  authorId: string;
  authorName: string;
  body: string;
  parentId: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  projectId: string | null;
  cycleId: string | null;
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  assigneeName: string | null;
  creatorName: string;
  dueDate: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  title: string;
  body: string;
  authorName: string;
  createdAt: string;
}

export interface KnowledgePage {
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

export interface SharedCalendar {
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

export interface SharedCalendarEvent {
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

export interface InboxItem {
  id: string;
  subject: string;
  body: string;
  senderName: string;
  senderAddress: string;
  status: "new" | "triaged" | "waiting" | "done";
  assigneeId: string | null;
  assigneeName: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  status: string;
  leadId: string | null;
  targetDate: string | null;
  openIssues: number;
  completedIssues: number;
}

export interface AgentProfile {
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
  visibility: "private" | "workspace";
  persona: string;
  cliArgs: string[];
  sourceAgentId: string;
}

export interface Team {
  id: string;
  name: string;
  purpose: string;
  people: number;
  agents: number;
}

export interface Device {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  platform: string;
  tools: string[];
  status: string;
  lastSeenAt: string;
}

export interface ActivityItem {
  id: string;
  kind: string;
  summary: string;
  actorName: string;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  createdAt: string;
}

export interface Connection {
  id: string;
  kind: string;
  label: string;
  status: string;
  accountLabel: string;
  audience: "personal" | "workspace";
  scopes: string[];
  projectLinks: Array<{
    projectId: string;
    isDefault: boolean;
  }>;
  lastSyncAt: string | null;
}

export interface DesktopSnapshot {
  deviceId: string;
  deviceName: string;
  updatedAt: string;
  payload: {
    projects?: number;
    openTasks?: number;
    activeRuns?: Array<{
      id: string;
      agent: string;
      channel: string;
      startedAt: number;
    }>;
  };
}

export interface WorkspaceSnapshot {
  revision: number;
  currentUser: PortalUser & { id: string };
  workspaces: WorkspaceSummary[];
  workspace: WorkspaceSummary;
  members: Member[];
  channels: Channel[];
  messages: Message[];
  issues: Issue[];
  decisions: Decision[];
  knowledgePages: KnowledgePage[];
  calendars: SharedCalendar[];
  calendarEvents: SharedCalendarEvent[];
  inbox: InboxItem[];
  projects: Project[];
  agents: AgentProfile[];
  teams: Team[];
  devices: Device[];
  pendingInvites: PendingInvite[];
  connections: Connection[];
  desktopSnapshots: DesktopSnapshot[];
  activity: ActivityItem[];
}

export interface WorkspaceUnchanged {
  unchanged: true;
  revision: number;
  workspaceId: string;
}
