import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getDb, uid, now } from "./db";
import { cancelRunsWhere } from "./runbus";
import type {
  Project, Channel, Agent, Team, TeamMember, ChannelMember,
  Message, Task, MemoryEntry, View, TaskStatus, Run, AgentSession,
  Link, LinkKind, Assignment, AssignRole, EntityRef, EntityType,
  Calendar, CalendarAccount, CalendarShare, CalendarEvent,
  Member, Device,
} from "./types";

interface SpacesState {
  loaded: boolean;
  tools: Record<string, boolean>;
  view: View;
  /** Entity shown in the right-hand inspector, or null when it is closed. */
  inspect: EntityRef | null;
  projects: Project[];
  channels: Channel[];
  agents: Agent[];
  teams: Team[];
  teamMembers: TeamMember[];
  channelMembers: ChannelMember[];
  tasks: Task[];
  memory: MemoryEntry[];
  links: Link[];
  assignments: Assignment[];
  members: Member[];
  devices: Device[];
  calendarAccounts: CalendarAccount[];
  calendars: Calendar[];
  calendarShares: CalendarShare[];
  /** Only the window the calendar view has loaded, not every event ever. */
  events: CalendarEvent[];
  messages: Record<string, Message[]>;
  runs: Record<string, Run>;
  sessions: AgentSession[];
  unread: Record<string, number>;
  activeRunIds: string[];

  init(): Promise<void>;
  refreshAll(): Promise<void>;
  setView(v: View): void;
  setInspect(ref: EntityRef | null): void;
  loadMessages(channelId: string): Promise<void>;

  addProject(p: Partial<Project> & { name: string }): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Promise<void>;
  deleteProject(id: string): Promise<void>;

  addChannel(projectId: string, name: string, topic?: string): Promise<Channel>;
  updateChannel(id: string, patch: Partial<Channel>): Promise<void>;
  deleteChannel(id: string): Promise<void>;

  addAgent(a: Partial<Agent> & { name: string; kind: Agent["kind"] }): Promise<Agent>;
  updateAgent(id: string, patch: Partial<Agent>): Promise<void>;
  deleteAgent(id: string): Promise<void>;

  addTeam(name: string, description?: string): Promise<Team>;
  updateTeam(id: string, patch: Partial<Team>): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  setTeamMembers(teamId: string, agentIds: string[]): Promise<void>;

  addChannelMember(channelId: string, type: "agent" | "team", memberId: string): Promise<void>;
  removeChannelMember(channelId: string, type: "agent" | "team", memberId: string): Promise<void>;

  insertMessage(
    m: Omit<Message, "created_at" | "parent_id" | "run_id"> & {
      created_at?: number;
      parent_id?: string;
      run_id?: string;
    }
  ): Promise<Message>;
  patchMessageLocal(channelId: string, msgId: string, patch: Partial<Message>): void;
  persistMessage(msgId: string, patch: Partial<Message>): Promise<void>;
  deleteChannelMessages(channelId: string): Promise<void>;

  insertRun(r: Run): Promise<void>;
  patchRun(id: string, patch: Partial<Run>, persist?: boolean): Promise<void>;
  loadRun(id: string): Promise<Run | null>;
  loadProjectRuns(projectId: string): Promise<void>;
  markRunActive(id: string, active: boolean): void;

  getSession(channelId: string, agentId: string): string;
  setSession(channelId: string, agentId: string, sessionId: string): Promise<void>;
  clearSession(channelId: string, agentId: string): Promise<void>;
  clearProjectSessions(projectId: string): Promise<void>;

  refreshUnreads(): Promise<void>;
  markChannelRead(channelId: string): Promise<void>;

  addTask(t: Partial<Task> & { project_id: string; title: string }): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<void>;
  deleteTask(id: string): Promise<void>;

  addMemory(m: Partial<MemoryEntry> & { project_id: string; title: string }): Promise<MemoryEntry>;
  updateMemory(id: string, patch: Partial<MemoryEntry>): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  /** Draw a link. Idempotent: re-linking the same pair returns the existing row. */
  addLink(from: EntityRef, to: EntityRef, kind?: LinkKind, note?: string, by?: string): Promise<Link | null>;
  updateLink(id: string, patch: Partial<Link>): Promise<void>;
  removeLink(id: string): Promise<void>;
  /** Every link where `ref` is either end. */
  linksFor(ref: EntityRef): Link[];

  assign(subject: EntityRef, target: EntityRef, role?: AssignRole): Promise<Assignment | null>;
  unassign(id: string): Promise<void>;
  assignmentsFor(target: EntityRef): Assignment[];
  /** Everything an agent or team has been put on. */
  assignmentsOf(subject: EntityRef): Assignment[];

  /** Drop every link and assignment touching an entity that no longer exists. */
  purgeGraph(refs: EntityRef[]): Promise<void>;

  addMember(m: Partial<Member> & { name: string }): Promise<Member>;
  updateMember(id: string, patch: Partial<Member>): Promise<void>;
  removeMember(id: string): Promise<void>;
  /** The person at this machine. Never null once the schema has run. */
  self(): Member;

  addDevice(d: Partial<Device> & { member_id: string; name: string }): Promise<Device>;
  updateDevice(id: string, patch: Partial<Device>): Promise<void>;

  addCalendar(c: Partial<Calendar> & { name: string }): Promise<Calendar>;
  updateCalendar(id: string, patch: Partial<Calendar>): Promise<void>;
  deleteCalendar(id: string): Promise<void>;
  setCalendarShare(calendarId: string, subject: EntityRef, access: CalendarShare["access"] | null): Promise<void>;

  /** Load every event overlapping [from, to). Replaces the loaded window. */
  loadEvents(from: number, to: number): Promise<void>;
  addEvent(e: Partial<CalendarEvent> & { calendar_id: string; title: string; starts_at: number; ends_at: number }): Promise<CalendarEvent>;
  updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<void>;
  deleteEvent(id: string): Promise<void>;
}

async function patchRow(table: string, id: string, patch: Record<string, any>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const db = await getDb();
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await db.execute(`UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1}`, [
    ...keys.map((k) => patch[k]),
    id,
  ]);
  requestPortalSync();
}

function requestPortalSync() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("hq:portal-local-change"));
  }
}

export const useStore = create<SpacesState>((set, get) => ({
  loaded: false,
  tools: {},
  view: { type: "dashboard" },
  inspect: null,
  projects: [],
  channels: [],
  agents: [],
  teams: [],
  teamMembers: [],
  channelMembers: [],
  tasks: [],
  memory: [],
  links: [],
  assignments: [],
  members: [],
  devices: [],
  calendarAccounts: [],
  calendars: [],
  calendarShares: [],
  events: [],
  messages: {},
  runs: {},
  sessions: [],
  unread: {},
  activeRunIds: [],

  async init() {
    // Reconcile rows left "running" by a previous app session — those
    // processes are gone; without this the UI shows spinners forever.
    const db = await getDb();
    await db.execute(
      "UPDATE messages SET status = 'error', meta = 'interrupted — app closed during run' WHERE status = 'running'"
    );
    await db.execute(
      "UPDATE runs SET status = 'error', finished_at = $1 WHERE status = 'running'",
      [now()]
    );
    await get().refreshAll();
    let tools: Record<string, boolean> = {};
    try {
      tools = await invoke<Record<string, boolean>>("check_tools");
    } catch {
      // tools stay unknown
    }
    set({ loaded: true, tools });
  },

  async refreshAll() {
    const db = await getDb();
    const [projects, channels, agents, teams, teamMembers, channelMembers, tasks, memory, sessions, links, assignments, calendarAccounts, calendars, calendarShares, members, devices] =
      await Promise.all([
        db.select<Project[]>("SELECT * FROM projects ORDER BY created_at"),
        db.select<Channel[]>("SELECT * FROM channels ORDER BY created_at"),
        db.select<Agent[]>("SELECT * FROM agents ORDER BY created_at"),
        db.select<Team[]>("SELECT * FROM teams ORDER BY created_at"),
        db.select<TeamMember[]>("SELECT * FROM team_members"),
        db.select<ChannelMember[]>("SELECT * FROM channel_members"),
        db.select<Task[]>("SELECT * FROM tasks ORDER BY sort_order, created_at"),
        db.select<MemoryEntry[]>("SELECT * FROM memory ORDER BY pinned DESC, updated_at DESC"),
        db.select<AgentSession[]>("SELECT * FROM agent_sessions"),
        db.select<Link[]>("SELECT * FROM links ORDER BY created_at"),
        db.select<Assignment[]>("SELECT * FROM assignments ORDER BY created_at"),
        db.select<CalendarAccount[]>("SELECT * FROM calendar_accounts ORDER BY created_at"),
        db.select<Calendar[]>("SELECT * FROM calendars ORDER BY created_at"),
        db.select<CalendarShare[]>("SELECT * FROM calendar_shares"),
        db.select<Member[]>("SELECT * FROM members WHERE status != 'removed' ORDER BY is_self DESC, name"),
        db.select<Device[]>("SELECT * FROM devices ORDER BY created_at"),
      ]);
    set({ projects, channels, agents, teams, teamMembers, channelMembers, tasks, memory, sessions, links, assignments, calendarAccounts, calendars, calendarShares, members, devices });
    await get().refreshUnreads();
  },

  setView(nextView) {
    // A channel is a surface inside its project workspace, not a separate
    // route. Keeping that boundary unified means moving between chat, browser,
    // processes, and terminal never unmounts the project's live tools.
    const channel =
      nextView.type === "channel"
        ? get().channels.find((item) => item.id === nextView.channelId)
        : undefined;
    const view: View =
      nextView.type === "channel" && channel
        ? {
            type: "workspace",
            projectId: channel.project_id,
            channelId: nextView.channelId,
            threadRootId: nextView.threadRootId,
          }
        : nextView;
    set({ view });
    const channelId =
      view.type === "channel"
        ? view.channelId
        : view.type === "workspace"
          ? view.channelId
          : undefined;
    if (channelId) {
      void get().loadMessages(channelId);
      void get().markChannelRead(channelId);
    }
  },

  setInspect(inspect) {
    set({ inspect });
  },

  async loadMessages(channelId) {
    const db = await getDb();
    const recent = await db.select<Message[]>(
      "SELECT * FROM (SELECT * FROM messages WHERE channel_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500) ORDER BY created_at, id",
      [channelId]
    );
    // Threads must stay whole: pull in any replies of loaded roots and any
    // roots referenced by loaded replies that fell outside the window.
    const have = new Set(recent.map((m) => m.id));
    const rootIds = recent.filter((m) => !m.parent_id).map((m) => m.id);
    const missingRoots = [...new Set(recent.map((m) => m.parent_id).filter((p) => p && !have.has(p)))];
    const extra: Message[] = [];
    for (const ids of [rootIds, missingRoots]) {
      if (!ids.length) continue;
      const ph = ids.map((_, i) => `$${i + 1}`).join(",");
      const rows =
        ids === rootIds
          ? await db.select<Message[]>(`SELECT * FROM messages WHERE parent_id IN (${ph})`, ids)
          : await db.select<Message[]>(`SELECT * FROM messages WHERE id IN (${ph})`, ids);
      for (const r of rows) if (!have.has(r.id)) { have.add(r.id); extra.push(r); }
    }
    const full = [...recent, ...extra].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)
    );
    set((s) => {
      // Merge with anything inserted while the SELECT was in flight.
      const inFlight = (s.messages[channelId] ?? []).filter((m) => !have.has(m.id));
      const merged = inFlight.length
        ? [...full, ...inFlight].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
        : full;
      return { messages: { ...s.messages, [channelId]: merged } };
    });
  },

  async refreshUnreads() {
    const db = await getDb();
    const rows = await db.select<{ channel_id: string; n: number }[]>(
      `SELECT m.channel_id AS channel_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN channel_reads r ON r.channel_id = m.channel_id
       WHERE m.created_at > COALESCE(r.last_read, 0) AND m.author_type != 'user'
       GROUP BY m.channel_id`
    );
    const unread: Record<string, number> = {};
    for (const r of rows) unread[r.channel_id] = r.n;
    const v = get().view;
    if (v.type === "channel") delete unread[v.channelId];
    if (v.type === "workspace" && v.channelId) delete unread[v.channelId];
    set({ unread });
  },

  async markChannelRead(channelId) {
    const db = await getDb();
    await db.execute(
      "INSERT INTO channel_reads (channel_id, last_read) VALUES ($1,$2) ON CONFLICT(channel_id) DO UPDATE SET last_read = $2",
      [channelId, now()]
    );
    set((s) => {
      const unread = { ...s.unread };
      delete unread[channelId];
      return { unread };
    });
  },

  async addProject(p) {
    const db = await getDb();
    const proj: Project = {
      id: uid(),
      name: p.name,
      description: p.description ?? "",
      repo: p.repo ?? "",
      local_path: p.local_path ?? "",
      isolate: p.isolate ?? 0,
      instructions: p.instructions ?? "",
      created_at: now(),
    };
    await db.execute(
      "INSERT INTO projects (id, name, description, repo, local_path, isolate, instructions, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [proj.id, proj.name, proj.description, proj.repo, proj.local_path, proj.isolate, proj.instructions, proj.created_at]
    );
    // every project starts with a #general channel
    const chan: Channel = {
      id: uid(),
      project_id: proj.id,
      name: "general",
      topic: "",
      chaining: 1,
      charter: "",
      mode: "lead",
      lead_agent_id: "",
      created_at: now(),
    };
    await db.execute(
      "INSERT INTO channels (id, project_id, name, topic, chaining, charter, mode, lead_agent_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [chan.id, chan.project_id, chan.name, chan.topic, chan.chaining, chan.charter, chan.mode, chan.lead_agent_id, chan.created_at]
    );
    await get().refreshAll();
    return proj;
  },

  async updateProject(id, patch) {
    await patchRow("projects", id, patch);
    await get().refreshAll();
  },

  async deleteProject(id) {
    const db = await getDb();
    const chans = get().channels.filter((c) => c.project_id === id);
    const refs: EntityRef[] = [
      { type: "project", id },
      ...chans.map((channel): EntityRef => ({ type: "channel", id: channel.id })),
      ...get().tasks
        .filter((task) => task.project_id === id)
        .map((task): EntityRef => ({ type: "task", id: task.id })),
      ...get().memory
        .filter((entry) => entry.project_id === id)
        .map((entry): EntityRef => ({ type: "memory", id: entry.id })),
    ];
    for (const c of chans) {
      cancelRunsWhere((h) => h.channelId === c.id);
      const messages = await db.select<Array<{ id: string }>>(
        "SELECT id FROM messages WHERE channel_id = $1",
        [c.id]
      );
      refs.push(
        ...messages.map((message): EntityRef => ({ type: "message", id: message.id }))
      );
      await db.execute(
        "DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)",
        [c.id]
      );
      await db.execute("DELETE FROM messages WHERE channel_id = $1", [c.id]);
      await db.execute("DELETE FROM channel_members WHERE channel_id = $1", [c.id]);
      await db.execute("DELETE FROM runs WHERE channel_id = $1", [c.id]);
      await db.execute("DELETE FROM queue WHERE channel_id = $1", [c.id]);
      await db.execute("DELETE FROM agent_sessions WHERE channel_id = $1", [c.id]);
      await db.execute("DELETE FROM channel_reads WHERE channel_id = $1", [c.id]);
    }
    await get().purgeGraph(refs);
    await db.execute("DELETE FROM channels WHERE project_id = $1", [id]);
    await db.execute("DELETE FROM tasks WHERE project_id = $1", [id]);
    await db.execute("DELETE FROM memory WHERE project_id = $1", [id]);
    await db.execute("UPDATE documents SET project_id = '' WHERE project_id = $1", [id]);
    await db.execute("UPDATE content_items SET project_id = '' WHERE project_id = $1", [id]);
    await db.execute("DELETE FROM projects WHERE id = $1", [id]);
    set({ view: { type: "dashboard" } });
    await get().refreshAll();
  },

  async addChannel(projectId, name, topic = "") {
    const db = await getDb();
    const chan: Channel = {
      id: uid(), project_id: projectId, name, topic, chaining: 1,
      charter: "", mode: "lead", lead_agent_id: "", created_at: now(),
    };
    await db.execute(
      "INSERT INTO channels (id, project_id, name, topic, chaining, charter, mode, lead_agent_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [chan.id, chan.project_id, chan.name, chan.topic, chan.chaining, chan.charter, chan.mode, chan.lead_agent_id, chan.created_at]
    );
    await get().refreshAll();
    return chan;
  },

  async updateChannel(id, patch) {
    await patchRow("channels", id, patch);
    await get().refreshAll();
  },

  async deleteChannel(id) {
    cancelRunsWhere((h) => h.channelId === id);
    const db = await getDb();
    const messages = await db.select<Array<{ id: string }>>(
      "SELECT id FROM messages WHERE channel_id = $1",
      [id]
    );
    await get().purgeGraph([
      { type: "channel", id },
      ...messages.map((message): EntityRef => ({ type: "message", id: message.id })),
    ]);
    await db.execute(
      "DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = $1)",
      [id]
    );
    await db.execute("DELETE FROM queue WHERE channel_id = $1", [id]);
    await db.execute("DELETE FROM messages WHERE channel_id = $1", [id]);
    await db.execute("DELETE FROM channel_members WHERE channel_id = $1", [id]);
    await db.execute("DELETE FROM runs WHERE channel_id = $1", [id]);
    await db.execute("DELETE FROM agent_sessions WHERE channel_id = $1", [id]);
    await db.execute("DELETE FROM channel_reads WHERE channel_id = $1", [id]);
    await db.execute("DELETE FROM channels WHERE id = $1", [id]);
    set({ view: { type: "dashboard" } });
    await get().refreshAll();
  },

  async addAgent(a) {
    const db = await getDb();
    const agent: Agent = {
      id: uid(),
      name: a.name,
      kind: a.kind,
      model: a.model ?? "",
      persona: a.persona ?? "",
      role: a.role ?? "",
      owns: a.owns ?? "",
      avatar: a.avatar ?? "",
      // Whoever creates an agent is bringing it, unless told otherwise.
      owner_member_id: a.owner_member_id ?? get().self().id,
      host_device_id: a.host_device_id ?? "",
      visibility: a.visibility ?? "workspace",
      cli_args: a.cli_args ?? "",
      created_at: now(),
    };
    await db.execute(
      // Ownership is written HERE, not by a follow-up update. Creating an
      // agent and then patching it is two chances to end up with an ownerless
      // row, and that is exactly how the columns silently stayed empty before.
      `INSERT INTO agents
        (id, name, kind, model, persona, role, owns, avatar,
         owner_member_id, host_device_id, visibility, cli_args, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        agent.id,
        agent.name,
        agent.kind,
        agent.model,
        agent.persona,
        agent.role,
        agent.owns,
        agent.avatar,
        agent.owner_member_id,
        agent.host_device_id,
        agent.visibility,
        agent.cli_args,
        agent.created_at,
      ]
    );
    await get().refreshAll();
    return agent;
  },

  async updateAgent(id, patch) {
    await patchRow("agents", id, patch);
    await get().refreshAll();
  },

  async deleteAgent(id) {
    cancelRunsWhere((h) => h.agentId === id);
    const db = await getDb();
    await db.execute("DELETE FROM team_members WHERE agent_id = $1", [id]);
    await db.execute("DELETE FROM channel_members WHERE member_type = 'agent' AND member_id = $1", [id]);
    await db.execute("DELETE FROM agent_sessions WHERE agent_id = $1", [id]);
    await db.execute("DELETE FROM queue WHERE agent_id = $1", [id]);
    await db.execute("UPDATE tasks SET assignee_agent_id = '' WHERE assignee_agent_id = $1", [id]);
    await db.execute("DELETE FROM agents WHERE id = $1", [id]);
    await get().refreshAll();
  },

  async addTeam(name, description = "") {
    const db = await getDb();
    const team: Team = { id: uid(), name, description, charter: "", avatar: "", created_at: now() };
    await db.execute(
      "INSERT INTO teams (id, name, description, charter, avatar, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [team.id, team.name, team.description, team.charter, team.avatar, team.created_at]
    );
    await get().refreshAll();
    return team;
  },

  async updateTeam(id, patch) {
    await patchRow("teams", id, patch);
    await get().refreshAll();
  },

  async deleteTeam(id) {
    const db = await getDb();
    await db.execute("DELETE FROM team_members WHERE team_id = $1", [id]);
    await db.execute("DELETE FROM channel_members WHERE member_type = 'team' AND member_id = $1", [id]);
    await db.execute("DELETE FROM teams WHERE id = $1", [id]);
    await get().refreshAll();
  },

  async setTeamMembers(teamId, agentIds) {
    const db = await getDb();
    await db.execute("DELETE FROM team_members WHERE team_id = $1", [teamId]);
    for (const aid of agentIds) {
      await db.execute("INSERT INTO team_members (team_id, agent_id) VALUES ($1,$2)", [teamId, aid]);
    }
    await get().refreshAll();
  },

  async addChannelMember(channelId, type, memberId) {
    const db = await getDb();
    await db.execute(
      "INSERT OR IGNORE INTO channel_members (channel_id, member_type, member_id) VALUES ($1,$2,$3)",
      [channelId, type, memberId]
    );
    await get().refreshAll();
  },

  async removeChannelMember(channelId, type, memberId) {
    const db = await getDb();
    await db.execute(
      "DELETE FROM channel_members WHERE channel_id = $1 AND member_type = $2 AND member_id = $3",
      [channelId, type, memberId]
    );
    await get().refreshAll();
  },

  async insertMessage(m) {
    const db = await getDb();
    const msg: Message = {
      ...m,
      parent_id: m.parent_id ?? "",
      run_id: m.run_id ?? "",
      created_at: m.created_at ?? now(),
    };
    await db.execute(
      "INSERT INTO messages (id, channel_id, author_type, author_id, author_name, content, status, meta, parent_id, run_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [msg.id, msg.channel_id, msg.author_type, msg.author_id, msg.author_name, msg.content, msg.status, msg.meta, msg.parent_id, msg.run_id, msg.created_at]
    );
    set((s) => ({
      messages: {
        ...s.messages,
        [msg.channel_id]: [...(s.messages[msg.channel_id] ?? []), msg],
      },
    }));
    const v = get().view;
    if (v.type === "channel" && v.channelId === msg.channel_id) {
      // Watched live — advance the persisted read cursor so this message
      // doesn't resurface as unread after a refresh or relaunch.
      void db.execute(
        "INSERT INTO channel_reads (channel_id, last_read) VALUES ($1,$2) ON CONFLICT(channel_id) DO UPDATE SET last_read = MAX(last_read, $2)",
        [msg.channel_id, msg.created_at]
      );
    } else if (msg.author_type !== "user") {
      set((s) => ({ unread: { ...s.unread, [msg.channel_id]: (s.unread[msg.channel_id] ?? 0) + 1 } }));
    }
    return msg;
  },

  patchMessageLocal(channelId, msgId, patch) {
    set((s) => ({
      messages: {
        ...s.messages,
        [channelId]: (s.messages[channelId] ?? []).map((m) =>
          m.id === msgId ? { ...m, ...patch } : m
        ),
      },
    }));
  },

  async persistMessage(msgId, patch) {
    await patchRow("messages", msgId, patch);
  },

  async deleteChannelMessages(channelId) {
    cancelRunsWhere((h) => h.channelId === channelId);
    const db = await getDb();
    await db.execute("DELETE FROM messages WHERE channel_id = $1", [channelId]);
    await db.execute("DELETE FROM agent_sessions WHERE channel_id = $1", [channelId]);
    await db.execute("DELETE FROM runs WHERE channel_id = $1", [channelId]);
    await db.execute("DELETE FROM queue WHERE channel_id = $1", [channelId]);
    set((s) => ({
      messages: { ...s.messages, [channelId]: [] },
      sessions: s.sessions.filter((x) => x.channel_id !== channelId),
    }));
  },

  async insertRun(r) {
    const db = await getDb();
    await db.execute(
      "INSERT INTO runs (id, agent_id, channel_id, task_id, prompt, status, session_id, meta, activity, cwd, model, effort, command, commit_before, commit_after, files_changed, transcript, started_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [r.id, r.agent_id, r.channel_id, r.task_id, r.prompt, r.status, r.session_id, r.meta, r.activity, r.cwd, r.model, r.effort, r.command, r.commit_before, r.commit_after, r.files_changed, r.transcript, r.started_at, r.finished_at]
    );
    set((s) => ({ runs: { ...s.runs, [r.id]: r } }));
  },

  async patchRun(id, patch, persist = true) {
    set((s) => {
      const prev = s.runs[id];
      if (!prev) return {};
      return { runs: { ...s.runs, [id]: { ...prev, ...patch } } };
    });
    if (persist) await patchRow("runs", id, patch as Record<string, any>);
  },

  async loadRun(id) {
    const cached = get().runs[id];
    if (cached) return cached;
    const db = await getDb();
    const rows = await db.select<Run[]>("SELECT * FROM runs WHERE id = $1", [id]);
    if (!rows.length) return null;
    set((s) => ({ runs: { ...s.runs, [id]: rows[0] } }));
    return rows[0];
  },

  async loadProjectRuns(projectId) {
    const db = await getDb();
    const rows = await db.select<Run[]>(
      `SELECT runs.*
       FROM runs
       INNER JOIN channels ON channels.id = runs.channel_id
       WHERE channels.project_id = $1
       ORDER BY runs.started_at DESC
       LIMIT 100`,
      [projectId]
    );
    set((s) => {
      const next = { ...s.runs };
      for (const run of rows) {
        // The in-memory copy is the live stream. A background refresh must not
        // replace it with the last persisted mirror while the process runs.
        if (!s.activeRunIds.includes(run.id)) next[run.id] = run;
      }
      return { runs: next };
    });
  },

  markRunActive(id, active) {
    set((s) => ({
      activeRunIds: active
        ? [...s.activeRunIds.filter((x) => x !== id), id]
        : s.activeRunIds.filter((x) => x !== id),
    }));
  },

  getSession(channelId, agentId) {
    return (
      get().sessions.find((x) => x.channel_id === channelId && x.agent_id === agentId)?.session_id ?? ""
    );
  },

  async setSession(channelId, agentId, sessionId) {
    const db = await getDb();
    await db.execute(
      "INSERT INTO agent_sessions (channel_id, agent_id, session_id, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT(channel_id, agent_id) DO UPDATE SET session_id = $3, updated_at = $4",
      [channelId, agentId, sessionId, now()]
    );
    set((s) => ({
      sessions: [
        ...s.sessions.filter((x) => !(x.channel_id === channelId && x.agent_id === agentId)),
        { channel_id: channelId, agent_id: agentId, session_id: sessionId, updated_at: now() },
      ],
    }));
  },

  async clearSession(channelId, agentId) {
    const db = await getDb();
    await db.execute("DELETE FROM agent_sessions WHERE channel_id = $1 AND agent_id = $2", [channelId, agentId]);
    set((s) => ({
      sessions: s.sessions.filter((x) => !(x.channel_id === channelId && x.agent_id === agentId)),
    }));
  },

  async clearProjectSessions(projectId) {
    const chanIds = get().channels.filter((c) => c.project_id === projectId).map((c) => c.id);
    if (!chanIds.length) return;
    const db = await getDb();
    const ph = chanIds.map((_, i) => `$${i + 1}`).join(",");
    await db.execute(`DELETE FROM agent_sessions WHERE channel_id IN (${ph})`, chanIds);
    set((s) => ({ sessions: s.sessions.filter((x) => !chanIds.includes(x.channel_id)) }));
  },

  async addTask(t) {
    const db = await getDb();
    const peers = get().tasks.filter((x) => x.project_id === t.project_id);
    const task: Task = {
      id: uid(),
      project_id: t.project_id,
      title: t.title,
      description: t.description ?? "",
      status: (t.status as TaskStatus) ?? "todo",
      assignee_agent_id: t.assignee_agent_id ?? "",
      due_date: t.due_date ?? "",
      sort_order: peers.length ? Math.max(...peers.map((x) => x.sort_order)) + 1 : 0,
      branch: "",
      last_run_id: "",
      created_at: now(),
    };
    await db.execute(
      "INSERT INTO tasks (id, project_id, title, description, status, assignee_agent_id, due_date, sort_order, branch, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [task.id, task.project_id, task.title, task.description, task.status, task.assignee_agent_id, task.due_date, task.sort_order, task.branch, task.created_at]
    );
    await get().refreshAll();
    return task;
  },

  async updateTask(id, patch) {
    await patchRow("tasks", id, patch);
    await get().refreshAll();
  },

  async deleteTask(id) {
    const db = await getDb();
    await db.execute("DELETE FROM tasks WHERE id = $1", [id]);
    await get().refreshAll();
  },

  async addMemory(m) {
    const db = await getDb();
    const entry: MemoryEntry = {
      id: uid(),
      project_id: m.project_id,
      kind: m.kind ?? "note",
      title: m.title,
      content: m.content ?? "",
      pinned: m.pinned ?? 0,
      created_at: now(),
      updated_at: now(),
    };
    await db.execute(
      "INSERT INTO memory (id, project_id, kind, title, content, pinned, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [entry.id, entry.project_id, entry.kind, entry.title, entry.content, entry.pinned, entry.created_at, entry.updated_at]
    );
    await get().refreshAll();
    return entry;
  },

  async updateMemory(id, patch) {
    await patchRow("memory", id, { ...patch, updated_at: now() });
    await get().refreshAll();
  },

  async deleteMemory(id) {
    const db = await getDb();
    await db.execute("DELETE FROM memory WHERE id = $1", [id]);
    await get().purgeGraph([{ type: "memory", id }]);
    await get().refreshAll();
  },

  /* ── the connection graph ─────────────────────────────────── */

  async addLink(from, to, kind = "relates", note = "", by = "user") {
    // Nothing links to itself, and a duplicate is a no-op rather than an error:
    // the same link gets drawn from both ends of the app all the time.
    if (from.type === to.type && from.id === to.id) return null;
    const existing = get().links.find(
      (l) =>
        l.kind === kind &&
        ((l.from_type === from.type && l.from_id === from.id && l.to_type === to.type && l.to_id === to.id) ||
          // `relates` has no direction, so a mirrored row is the same link.
          (kind === "relates" &&
            l.from_type === to.type && l.from_id === to.id &&
            l.to_type === from.type && l.to_id === from.id))
    );
    if (existing) return existing;

    const link: Link = {
      id: uid(),
      from_type: from.type, from_id: from.id,
      to_type: to.type, to_id: to.id,
      kind, note, created_by: by, created_at: now(),
    };
    const db = await getDb();
    await db.execute(
      "INSERT OR IGNORE INTO links (id, from_type, from_id, to_type, to_id, kind, note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [link.id, link.from_type, link.from_id, link.to_type, link.to_id, link.kind, link.note, link.created_by, link.created_at]
    );
    set((s) => ({ links: [...s.links, link] }));
    return link;
  },

  async updateLink(id, patch) {
    await patchRow("links", id, patch as Record<string, any>);
    set((s) => ({ links: s.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  },

  async removeLink(id) {
    const db = await getDb();
    await db.execute("DELETE FROM links WHERE id = $1", [id]);
    set((s) => ({ links: s.links.filter((l) => l.id !== id) }));
  },

  linksFor(ref) {
    return get().links.filter(
      (l) =>
        (l.from_type === ref.type && l.from_id === ref.id) ||
        (l.to_type === ref.type && l.to_id === ref.id)
    );
  },

  async assign(subject, target, role = "owner") {
    if (subject.type !== "agent" && subject.type !== "team") return null;
    const existing = get().assignments.find(
      (a) =>
        a.subject_type === subject.type && a.subject_id === subject.id &&
        a.target_type === target.type && a.target_id === target.id &&
        a.role === role
    );
    if (existing) return existing;

    const row: Assignment = {
      id: uid(),
      subject_type: subject.type,
      subject_id: subject.id,
      target_type: target.type,
      target_id: target.id,
      role,
      created_at: now(),
    };
    const db = await getDb();
    await db.execute(
      "INSERT OR IGNORE INTO assignments (id, subject_type, subject_id, target_type, target_id, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [row.id, row.subject_type, row.subject_id, row.target_type, row.target_id, row.role, row.created_at]
    );
    set((s) => ({ assignments: [...s.assignments, row] }));

    // A task has one canonical assignee column that the board, the prompt
    // builder and the swimlanes all read — keep it in step with the graph.
    if (target.type === "task" && role === "assignee" && subject.type === "agent") {
      await get().updateTask(target.id, { assignee_agent_id: subject.id });
    }
    return row;
  },

  async unassign(id) {
    const row = get().assignments.find((a) => a.id === id);
    const db = await getDb();
    await db.execute("DELETE FROM assignments WHERE id = $1", [id]);
    set((s) => ({ assignments: s.assignments.filter((a) => a.id !== id) }));
    if (row?.target_type === "task" && row.role === "assignee") {
      const task = get().tasks.find((t) => t.id === row.target_id);
      if (task?.assignee_agent_id === row.subject_id) {
        await get().updateTask(task.id, { assignee_agent_id: "" });
      }
    }
  },

  assignmentsFor(target) {
    return get().assignments.filter(
      (a) => a.target_type === target.type && a.target_id === target.id
    );
  },

  assignmentsOf(subject) {
    return get().assignments.filter(
      (a) => a.subject_type === subject.type && a.subject_id === subject.id
    );
  },

  async purgeGraph(refs) {
    if (!refs.length) return;
    const db = await getDb();
    for (const r of refs) {
      await db.execute("DELETE FROM links WHERE (from_type = $1 AND from_id = $2) OR (to_type = $1 AND to_id = $2)", [r.type, r.id]);
      await db.execute("DELETE FROM assignments WHERE (target_type = $1 AND target_id = $2) OR (subject_type = $1 AND subject_id = $2)", [r.type, r.id]);
    }
    const dead = new Set(refs.map((r) => `${r.type}:${r.id}`));
    const touches = (t: EntityType, id: string) => dead.has(`${t}:${id}`);
    set((s) => ({
      links: s.links.filter((l) => !touches(l.from_type, l.from_id) && !touches(l.to_type, l.to_id)),
      assignments: s.assignments.filter(
        (a) => !touches(a.target_type, a.target_id) && !touches(a.subject_type, a.subject_id)
      ),
    }));
  },

  /* ── people ───────────────────────────────────────────────── */

  async addMember(m) {
    const member: Member = {
      id: uid(),
      name: m.name,
      email: m.email ?? "",
      color: m.color ?? "",
      avatar: m.avatar ?? "",
      role: m.role ?? "member",
      portal_user_id: m.portal_user_id ?? "",
      // Exactly one row may claim to be this machine's user, and the schema
      // enforces it with a partial unique index — never set this here.
      is_self: 0,
      status: m.status ?? "active",
      created_at: now(),
    };
    const db = await getDb();
    await db.execute(
      `INSERT INTO members
        (id, name, email, color, avatar, role, portal_user_id, is_self, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        member.id,
        member.name,
        member.email,
        member.color,
        member.avatar,
        member.role,
        member.portal_user_id,
        member.is_self,
        member.status,
        member.created_at,
      ]
    );
    set((s) => ({ members: [...s.members, member] }));
    return member;
  },

  async updateMember(id, patch) {
    await patchRow("members", id, patch as Record<string, any>);
    const member = get().members.find((candidate) => candidate.id === id);
    const next = member ? { ...member, ...patch } : null;
    if (
      next?.portal_user_id &&
      (Object.prototype.hasOwnProperty.call(patch, "name") ||
        Object.prototype.hasOwnProperty.call(patch, "role"))
    ) {
      const db = await getDb();
      await db.execute(
        `INSERT INTO portal_member_outbox
          (member_id, portal_user_id, name, role, changed_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(member_id) DO UPDATE SET
           portal_user_id=excluded.portal_user_id,
           name=excluded.name,
           role=excluded.role,
           changed_at=excluded.changed_at`,
        [next.id, next.portal_user_id, next.name, next.role, now()]
      );
    }
    set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
    if (next?.portal_user_id) requestPortalSync();
  },

  async removeMember(id) {
    const member = get().members.find((m) => m.id === id);
    if (member?.is_self) return; // you cannot remove yourself from your own machine
    // Soft delete: their name still has to render on everything they touched.
    await patchRow("members", id, { status: "removed" });
    set((s) => ({ members: s.members.filter((m) => m.id !== id) }));
  },

  self() {
    const s = get();
    return (
      s.members.find((m) => m.is_self === 1) ??
      // Before refreshAll has run there is still a row in the database; this
      // stand-in keeps ownership checks total rather than optional.
      { id: "me", name: "You", email: "", color: "", avatar: "", role: "owner", portal_user_id: "", is_self: 1, status: "active", created_at: 0 }
    );
  },

  async addDevice(d) {
    const device: Device = {
      id: uid(),
      member_id: d.member_id,
      name: d.name,
      platform: d.platform ?? "",
      tools: d.tools ?? "{}",
      last_seen_at: now(),
      created_at: now(),
    };
    const db = await getDb();
    await db.execute(
      "INSERT INTO devices (id, member_id, name, platform, tools, last_seen_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [device.id, device.member_id, device.name, device.platform, device.tools, device.last_seen_at, device.created_at]
    );
    set((s) => ({ devices: [...s.devices, device] }));
    return device;
  },

  async updateDevice(id, patch) {
    await patchRow("devices", id, patch as Record<string, any>);
    set((s) => ({ devices: s.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
  },

  /* ── calendars ────────────────────────────────────────────── */

  async addCalendar(c) {
    const cal: Calendar = {
      id: uid(),
      account_id: c.account_id ?? "",
      external_id: c.external_id ?? "",
      name: c.name,
      color: c.color ?? "",
      owner_type: c.owner_type ?? "member",
      owner_id: c.owner_id ?? "",
      visibility: c.visibility ?? "private",
      writable: c.writable ?? 1,
      enabled: c.enabled ?? 1,
      created_at: now(),
    };
    const db = await getDb();
    await db.execute(
      "INSERT INTO calendars (id, account_id, external_id, name, color, owner_type, owner_id, visibility, writable, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [cal.id, cal.account_id, cal.external_id, cal.name, cal.color, cal.owner_type, cal.owner_id, cal.visibility, cal.writable, cal.enabled, cal.created_at]
    );
    set((s) => ({ calendars: [...s.calendars, cal] }));
    return cal;
  },

  async updateCalendar(id, patch) {
    await patchRow("calendars", id, patch as Record<string, any>);
    set((s) => ({ calendars: s.calendars.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  },

  async deleteCalendar(id) {
    const db = await getDb();
    // Events are meaningless without their calendar, and a share pointing at a
    // deleted calendar would keep granting access to nothing.
    await db.execute("DELETE FROM events WHERE calendar_id = $1", [id]);
    await db.execute("DELETE FROM calendar_shares WHERE calendar_id = $1", [id]);
    await db.execute("DELETE FROM calendars WHERE id = $1", [id]);
    set((s) => ({
      calendars: s.calendars.filter((c) => c.id !== id),
      calendarShares: s.calendarShares.filter((x) => x.calendar_id !== id),
      events: s.events.filter((e) => e.calendar_id !== id),
    }));
  },

  async setCalendarShare(calendarId, subject, access) {
    if (subject.type !== "member" && subject.type !== "team" && subject.type !== "agent") return;
    // Pin the narrowed type: the closures below lose the narrowing otherwise.
    const subjectType: CalendarShare["subject_type"] = subject.type;
    const db = await getDb();
    if (access === null) {
      await db.execute(
        "DELETE FROM calendar_shares WHERE calendar_id = $1 AND subject_type = $2 AND subject_id = $3",
        [calendarId, subjectType, subject.id]
      );
      set((s) => ({
        calendarShares: s.calendarShares.filter(
          (x) => !(x.calendar_id === calendarId && x.subject_type === subjectType && x.subject_id === subject.id)
        ),
      }));
      return;
    }
    await db.execute(
      "INSERT INTO calendar_shares (calendar_id, subject_type, subject_id, access) VALUES ($1,$2,$3,$4) ON CONFLICT(calendar_id, subject_type, subject_id) DO UPDATE SET access = $4",
      [calendarId, subjectType, subject.id, access]
    );
    set((s) => ({
      calendarShares: [
        ...s.calendarShares.filter(
          (x) => !(x.calendar_id === calendarId && x.subject_type === subjectType && x.subject_id === subject.id)
        ),
        { calendar_id: calendarId, subject_type: subjectType, subject_id: subject.id, access },
      ],
    }));
  },

  async loadEvents(from, to) {
    const db = await getDb();
    // Overlap, not containment: a meeting that started before the window and
    // ends inside it still belongs on the grid.
    const rows = await db.select<CalendarEvent[]>(
      "SELECT * FROM events WHERE starts_at < $2 AND ends_at > $1 AND status != 'cancelled' ORDER BY starts_at",
      [from, to]
    );
    set({ events: rows });
  },

  async addEvent(e) {
    const ev: CalendarEvent = {
      id: uid(),
      calendar_id: e.calendar_id,
      external_id: e.external_id ?? "",
      title: e.title,
      description: e.description ?? "",
      location: e.location ?? "",
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      all_day: e.all_day ?? 0,
      tz: e.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      organizer: e.organizer ?? "",
      attendees: e.attendees ?? "[]",
      status: e.status ?? "confirmed",
      source: e.source ?? "hq",
      updated_at: now(),
      etag: e.etag ?? "",
    };
    const db = await getDb();
    await db.execute(
      "INSERT INTO events (id, calendar_id, external_id, title, description, location, starts_at, ends_at, all_day, tz, organizer, attendees, status, source, updated_at, etag) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
      [ev.id, ev.calendar_id, ev.external_id, ev.title, ev.description, ev.location, ev.starts_at, ev.ends_at, ev.all_day, ev.tz, ev.organizer, ev.attendees, ev.status, ev.source, ev.updated_at, ev.etag]
    );
    set((s) => ({ events: [...s.events, ev].sort((a, b) => a.starts_at - b.starts_at) }));
    return ev;
  },

  async updateEvent(id, patch) {
    await patchRow("events", id, { ...patch, updated_at: now() } as Record<string, any>);
    set((s) => ({
      events: s.events
        .map((e) => (e.id === id ? { ...e, ...patch, updated_at: now() } : e))
        .sort((a, b) => a.starts_at - b.starts_at),
    }));
  },

  async deleteEvent(id) {
    const db = await getDb();
    await db.execute("DELETE FROM events WHERE id = $1", [id]);
    set((s) => ({ events: s.events.filter((e) => e.id !== id) }));
    await get().purgeGraph([{ type: "event", id }]);
  },
}));

/**
 * Whether `viewer` may see this agent at all.
 *
 * Teams are workspace-level and public by design — a team belongs to everyone,
 * which is what makes "use anyone's agents" work. That creates one sharp edge:
 * a private agent placed in a public team would have its name and role
 * advertised through the roster, leaking exactly what `private` was chosen to
 * avoid. Membership does not grant visibility; ownership does.
 */
export function agentVisibleTo(agent: Agent, viewerMemberId: string): boolean {
  const vis = (agent as { visibility?: string }).visibility ?? "workspace";
  if (vis !== "private") return true;
  const owner = (agent as { owner_member_id?: string }).owner_member_id ?? "";
  // An unowned private agent predates ownership; treat it as everyone's rather
  // than nobody's, or a migration would silently hide existing agents.
  return !owner || owner === viewerMemberId;
}

/** A team's members, minus any the viewer is not allowed to know exist. */
export function visibleTeamMembers(
  state: Pick<SpacesState, "teamMembers" | "agents" | "members">,
  teamId: string,
  viewerMemberId?: string
): Agent[] {
  const viewer = viewerMemberId ?? state.members.find((m) => m.is_self === 1)?.id ?? "me";
  const ids = new Set(state.teamMembers.filter((tm) => tm.team_id === teamId).map((tm) => tm.agent_id));
  return state.agents.filter((a) => ids.has(a.id) && agentVisibleTo(a, viewer));
}

/** Agents that are members of a channel, with team memberships expanded. */
export function channelAgents(state: Pick<SpacesState, "channelMembers" | "teamMembers" | "agents">, channelId: string): Agent[] {
  const direct = state.channelMembers
    .filter((m) => m.channel_id === channelId && m.member_type === "agent")
    .map((m) => m.member_id);
  const teamIds = state.channelMembers
    .filter((m) => m.channel_id === channelId && m.member_type === "team")
    .map((m) => m.member_id);
  const viaTeams = state.teamMembers
    .filter((tm) => teamIds.includes(tm.team_id))
    .map((tm) => tm.agent_id);
  const ids = new Set([...direct, ...viaTeams]);
  return state.agents.filter((a) => ids.has(a.id));
}
