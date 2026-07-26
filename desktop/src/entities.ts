/**
 * The entity registry.
 *
 * Every noun in Spaces — a project, a channel, a task, a memory entry, an agent,
 * a pull request — is describable through one function, `describeEntity`, and
 * searchable through one function, `searchEntities`. Everything that renders a
 * reference to *something* (chips, the link picker, the graph, the command
 * palette, backlink lists, prompt context) goes through here, so a new entity
 * kind is added in exactly one place.
 *
 * Nothing in this module reads the database: it projects the already-loaded
 * store. That keeps it synchronous, which is what makes it usable from render.
 */
import { useStore } from "./store";
import { slug } from "./types";
import type { EntityRef, EntityType, View } from "./types";

export interface EntityKindSpec {
  type: EntityType;
  label: string;
  plural: string;
  /** Single glyph for chips and graph nodes. */
  glyph: string;
  /** A theme color token — never a literal. */
  tone: string;
  /** Kinds the user can pick in a link picker (runs and devices are implicit). */
  linkable: boolean;
  /** Kinds an agent or team can be put on. */
  assignable: boolean;
}

export const ENTITY_KINDS: EntityKindSpec[] = [
  { type: "project",   label: "Project",   plural: "Projects",   glyph: "◈", tone: "var(--accent)", linkable: true,  assignable: true },
  { type: "channel",   label: "Channel",   plural: "Channels",   glyph: "#", tone: "var(--blue)",   linkable: true,  assignable: true },
  { type: "task",      label: "Task",      plural: "Tasks",      glyph: "✓", tone: "var(--green)",  linkable: true,  assignable: true },
  { type: "memory",    label: "Memory",    plural: "Memory",     glyph: "◆", tone: "var(--purple)", linkable: true,  assignable: true },
  { type: "document",  label: "Document",  plural: "Documents",  glyph: "▤", tone: "var(--blue)",   linkable: true,  assignable: true },
  { type: "message",   label: "Message",   plural: "Messages",   glyph: "❝", tone: "var(--cyan)",   linkable: true,  assignable: false },
  { type: "agent",     label: "Agent",     plural: "Agents",     glyph: "✳", tone: "var(--orange)", linkable: true,  assignable: false },
  { type: "team",      label: "Team",      plural: "Teams",      glyph: "⬡", tone: "var(--yellow)", linkable: true,  assignable: false },
  { type: "member",    label: "Person",    plural: "People",     glyph: "◐", tone: "var(--cyan)",   linkable: true,  assignable: false },
  { type: "device",    label: "Device",    plural: "Devices",    glyph: "▭", tone: "var(--text-dim)", linkable: false, assignable: false },
  { type: "workspace", label: "Workspace", plural: "Workspaces", glyph: "⑂", tone: "var(--cyan)",   linkable: true,  assignable: true },
  { type: "run",       label: "Run",       plural: "Runs",       glyph: "▷", tone: "var(--text-dim)", linkable: false, assignable: false },
  { type: "event",     label: "Event",     plural: "Calendar",   glyph: "◷", tone: "var(--yellow)", linkable: true,  assignable: true },
  { type: "pr",        label: "Pull request", plural: "Pull requests", glyph: "⑃", tone: "var(--green)", linkable: true, assignable: true },
  { type: "issue",     label: "Issue",     plural: "Issues",     glyph: "◉", tone: "var(--yellow)", linkable: true,  assignable: true },
  { type: "repo",      label: "Repo",      plural: "Repos",      glyph: "⌥", tone: "var(--text-dim)", linkable: true, assignable: false },
];

export const KIND_BY_TYPE: Record<EntityType, EntityKindSpec> = Object.fromEntries(
  ENTITY_KINDS.map((k) => [k.type, k])
) as Record<EntityType, EntityKindSpec>;

export interface EntityInfo {
  ref: EntityRef;
  /** Primary label — a task title, "#frontend", "owner/repo#42". */
  title: string;
  /** One line of context: project, status, role. */
  subtitle: string;
  /** Longer text, used by hover cards and by prompt context. */
  body: string;
  glyph: string;
  tone: string;
  /** Where clicking navigates inside Spaces, or null when there is nowhere to go. */
  view: View | null;
  /** External destination, for GitHub entities. */
  href: string;
  /** Owning project id, '' when the entity isn't project-scoped. */
  projectId: string;
  /** Words matched by `searchEntities`, lowercased. */
  haystack: string;
  /**
   * False when the referenced row is gone. Links outlive their targets — a
   * dangling ref renders as a tombstone rather than disappearing silently,
   * because a link the user drew deliberately shouldn't vanish without a word.
   */
  exists: boolean;
}

function unknown(ref: EntityRef, label: string): EntityInfo {
  const spec = KIND_BY_TYPE[ref.type];
  return {
    ref,
    title: label,
    subtitle: spec ? `${spec.label} · no longer exists` : "unknown",
    body: "",
    glyph: spec?.glyph ?? "?",
    tone: "var(--text-faint)",
    view: null,
    href: "",
    projectId: "",
    haystack: label.toLowerCase(),
    exists: false,
  };
}

function trim(s: string, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * GitHub refs carry everything they need in the id, because Spaces never stores a
 * row for them: "owner/name#42" for a PR or issue, "owner/name" for a repo.
 */
function githubInfo(ref: EntityRef): EntityInfo {
  const spec = KIND_BY_TYPE[ref.type];
  const [repo, number] = ref.id.split("#");
  const kind = ref.type === "pr" ? "pull" : "issues";
  return {
    ref,
    title: ref.type === "repo" ? repo : `${repo}#${number}`,
    subtitle: ref.type === "repo" ? "GitHub repository" : `${spec.label} on ${repo}`,
    body: "",
    glyph: spec.glyph,
    tone: spec.tone,
    view: null,
    href: number ? `https://github.com/${repo}/${kind}/${number}` : `https://github.com/${repo}`,
    projectId: "",
    haystack: ref.id.toLowerCase(),
    exists: true,
  };
}

/**
 * Titles for documents, which live in operations.ts rather than the store.
 *
 * describeEntity has to stay synchronous to be usable from render, and it
 * cannot await a query — so whichever view loads documents publishes them here
 * and every chip elsewhere resolves against that. Stale is fine; a uuid is not.
 */
export interface DocumentLike {
  id: string;
  title: string;
  path?: string;
  body?: string;
  project_id?: string;
  visibility?: string;
}

const documentCache = new Map<string, DocumentLike>();

export function cacheDocuments(docs: DocumentLike[]): void {
  for (const d of docs) documentCache.set(d.id, d);
}

/** Everything the UI needs to render a reference to `ref`. Never throws. */
export function describeEntity(ref: EntityRef): EntityInfo {
  const s = useStore.getState();
  const spec = KIND_BY_TYPE[ref.type];
  const base = {
    ref,
    glyph: spec?.glyph ?? "?",
    tone: spec?.tone ?? "var(--text-dim)",
    body: "",
    view: null as View | null,
    href: "",
    projectId: "",
    exists: true,
  };
  const projectName = (id: string) => s.projects.find((p) => p.id === id)?.name ?? "";

  switch (ref.type) {
    case "project": {
      const p = s.projects.find((x) => x.id === ref.id);
      if (!p) return unknown(ref, "Deleted project");
      const chans = s.channels.filter((c) => c.project_id === p.id).length;
      return {
        ...base,
        title: p.name,
        subtitle: [p.repo, `${chans} channel${chans === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
        body: p.description,
        projectId: p.id,
        view: { type: "dashboard" },
        haystack: `${p.name} ${p.description} ${p.repo}`.toLowerCase(),
      };
    }
    case "channel": {
      const c = s.channels.find((x) => x.id === ref.id);
      if (!c) return unknown(ref, "Deleted channel");
      return {
        ...base,
        title: `#${c.name}`,
        subtitle: [projectName(c.project_id), c.topic].filter(Boolean).join(" · "),
        body: c.charter || c.topic,
        projectId: c.project_id,
        view: { type: "channel", channelId: c.id },
        haystack: `#${c.name} ${c.topic} ${c.charter}`.toLowerCase(),
      };
    }
    case "task": {
      const t = s.tasks.find((x) => x.id === ref.id);
      if (!t) return unknown(ref, "Deleted task");
      const who = s.agents.find((a) => a.id === t.assignee_agent_id)?.name;
      return {
        ...base,
        title: t.title,
        subtitle: [t.status, who && `→ ${who}`, projectName(t.project_id)].filter(Boolean).join(" · "),
        body: t.description,
        projectId: t.project_id,
        view: { type: "tasks" },
        tone: t.status === "done" ? "var(--text-faint)" : base.tone,
        haystack: `${t.title} ${t.description}`.toLowerCase(),
      };
    }
    case "memory": {
      const m = s.memory.find((x) => x.id === ref.id);
      if (!m) return unknown(ref, "Deleted memory entry");
      return {
        ...base,
        title: m.title,
        subtitle: [m.kind, m.pinned ? "pinned" : "", projectName(m.project_id)].filter(Boolean).join(" · "),
        body: m.content,
        projectId: m.project_id,
        view: { type: "memory" },
        haystack: `${m.title} ${m.content}`.toLowerCase(),
      };
    }
    case "document": {
      // Documents are not in the zustand store — operations.ts owns them — so
      // describeEntity works from whatever the open view has cached. A chip for
      // an unopened document still resolves its title from the link's own note
      // rather than showing a uuid, which is the failure this avoids.
      const doc = documentCache.get(ref.id);
      if (!doc) {
        return {
          ...base,
          title: "Document",
          subtitle: "not loaded",
          view: { type: "documents" },
          haystack: ref.id.toLowerCase(),
        };
      }
      return {
        ...base,
        title: doc.title || "(untitled)",
        subtitle: [doc.path, doc.visibility].filter(Boolean).join(" · "),
        body: doc.body ?? "",
        projectId: doc.project_id ?? "",
        view: { type: "documents" },
        haystack: `${doc.title} ${doc.path ?? ""}`.toLowerCase(),
      };
    }
    case "message": {
      const msg = Object.values(s.messages).flat().find((x) => x.id === ref.id);
      if (!msg) return unknown(ref, "Message");
      const chan = s.channels.find((c) => c.id === msg.channel_id);
      return {
        ...base,
        title: trim(msg.content, 70) || "(empty message)",
        subtitle: `${msg.author_name}${chan ? ` in #${chan.name}` : ""}`,
        body: msg.content,
        projectId: chan?.project_id ?? "",
        view: chan
          ? { type: "channel", channelId: chan.id, threadRootId: msg.parent_id || msg.id }
          : null,
        haystack: msg.content.toLowerCase(),
      };
    }
    case "agent": {
      const a = s.agents.find((x) => x.id === ref.id);
      if (!a) return unknown(ref, "Deleted agent");
      // Whose agent it is leads the subtitle: in a shared roster that is the
      // first thing you need, ahead of its job title.
      const ownerId = (a as { owner_member_id?: string }).owner_member_id ?? "";
      const owner = ownerId ? s.members.find((m) => m.id === ownerId) : undefined;
      const ownerTag = owner && !owner.is_self ? `${owner.name}'s` : "";
      return {
        ...base,
        title: a.name,
        subtitle: [ownerTag, a.role || a.kind, a.owns && `owns ${a.owns}`].filter(Boolean).join(" · "),
        body: a.persona,
        view: { type: "agents" },
        haystack: `${a.name} @${slug(a.name)} ${a.role} ${a.owns} ${a.persona}`.toLowerCase(),
      };
    }
    case "team": {
      const t = s.teams.find((x) => x.id === ref.id);
      if (!t) return unknown(ref, "Deleted team");
      const n = s.teamMembers.filter((tm) => tm.team_id === t.id).length;
      return {
        ...base,
        title: t.name,
        subtitle: `${n} agent${n === 1 ? "" : "s"}${t.description ? ` · ${t.description}` : ""}`,
        body: t.charter || t.description,
        view: { type: "agents" },
        haystack: `${t.name} @${slug(t.name)} ${t.description} ${t.charter}`.toLowerCase(),
      };
    }
    case "run": {
      const r = s.runs[ref.id];
      if (!r) return unknown(ref, "Run");
      const a = s.agents.find((x) => x.id === r.agent_id);
      const chan = s.channels.find((c) => c.id === r.channel_id);
      return {
        ...base,
        title: `${a?.name ?? "agent"} run`,
        subtitle: [r.status, chan && `#${chan.name}`].filter(Boolean).join(" · "),
        body: trim(r.prompt, 400),
        projectId: chan?.project_id ?? "",
        view: chan ? { type: "channel", channelId: chan.id } : null,
        haystack: `${a?.name ?? ""} ${r.status}`.toLowerCase(),
      };
    }
    case "workspace":
      return {
        ...base,
        title: ref.id,
        subtitle: "Agent workspace",
        view: { type: "workspaces" },
        haystack: ref.id.toLowerCase(),
      };
    case "event": {
      const ev = s.events.find((x) => x.id === ref.id);
      if (!ev) return unknown(ref, "Event");
      const cal = s.calendars.find((c) => c.id === ev.calendar_id);
      const when = new Date(ev.starts_at);
      const day = when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const time = ev.all_day
        ? "all day"
        : when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      return {
        ...base,
        title: ev.title || "(untitled event)",
        subtitle: [`${day}, ${time}`, cal?.name].filter(Boolean).join(" · "),
        body: ev.description,
        view: { type: "calendar" },
        // A chip must never out-say the grid: an event the viewer only has
        // `busy` access to arrives here already redacted by visibleEvents(),
        // but a direct describeEntity() call bypasses that, so keep the
        // haystack to the title the caller could already see.
        haystack: `${ev.title} ${ev.location}`.toLowerCase(),
      };
    }
    case "pr":
    case "issue":
    case "repo":
      return githubInfo(ref);
    // member, device and event have no local table yet — they arrive with the
    // portal. Describing them by id keeps links to them valid in the meantime.
    default:
      return {
        ...base,
        title: ref.id,
        subtitle: spec?.label ?? ref.type,
        haystack: ref.id.toLowerCase(),
      };
  }
}

/**
 * How an agent is named everywhere.
 *
 * Just its own name, with whose agent it is as a separate tag — in a communal
 * workspace "Ada" is the teammate and "Rowan's" is provenance, and folding
 * the two into one string ("Rowan's Ada") makes the roster read like a list
 * of possessions instead of a list of people. Callers render `tag` as a chip,
 * never concatenated into `name`.
 */
export function agentIdentity(agentId: string): { name: string; tag: string; ownerId: string } {
  const s = useStore.getState();
  const agent = s.agents.find((a) => a.id === agentId);
  if (!agent) return { name: "", tag: "", ownerId: "" };
  const ownerId = (agent as { owner_member_id?: string }).owner_member_id ?? "";
  if (!ownerId) return { name: agent.name, tag: "", ownerId: "" };
  const owner = s.members.find((m) => m.id === ownerId);
  if (!owner) return { name: agent.name, tag: "", ownerId };
  // Your own agents need no tag — everything untagged is yours.
  const tag = owner.is_self ? "" : `${owner.name}'s`;
  return { name: agent.name, tag, ownerId };
}

export interface SearchOpts {
  types?: EntityType[];
  projectId?: string;
  limit?: number;
}

/** Every entity that currently has a row, as refs. */
export function allRefs(opts: SearchOpts = {}): EntityRef[] {
  const s = useStore.getState();
  const want = opts.types ? new Set(opts.types) : null;
  const on = (t: EntityType) => !want || want.has(t);
  const out: EntityRef[] = [];
  if (on("project")) for (const p of s.projects) out.push({ type: "project", id: p.id });
  if (on("channel")) for (const c of s.channels) out.push({ type: "channel", id: c.id });
  if (on("task")) for (const t of s.tasks) out.push({ type: "task", id: t.id });
  if (on("memory")) for (const m of s.memory) out.push({ type: "memory", id: m.id });
  if (on("agent")) for (const a of s.agents) out.push({ type: "agent", id: a.id });
  if (on("team")) for (const t of s.teams) out.push({ type: "team", id: t.id });
  if (on("message")) for (const m of Object.values(s.messages).flat()) out.push({ type: "message", id: m.id });
  // Documents live in operations.ts rather than the store, so they are
  // searchable only once a view has published them. Without this branch `[[`
  // autocomplete can never offer a document — which is the exact syntax
  // documents use to link to each other.
  if (on("document")) for (const id of documentCache.keys()) out.push({ type: "document", id });
  return out;
}

/**
 * Rank entities against a query. Scoring is deliberately simple and stable:
 * a title prefix beats a title hit beats a body hit, and ties keep registry
 * order so the same query always produces the same list.
 */
export function searchEntities(query: string, opts: SearchOpts = {}): EntityInfo[] {
  const q = query.trim().toLowerCase();
  const limit = opts.limit ?? 40;
  const order = new Map(ENTITY_KINDS.map((k, i) => [k.type, i] as const));

  const scored: { info: EntityInfo; score: number }[] = [];
  for (const ref of allRefs(opts)) {
    const info = describeEntity(ref);
    if (!info.exists) continue;
    if (opts.projectId && info.projectId && info.projectId !== opts.projectId) continue;

    let score = 0;
    if (!q) {
      score = 1;
    } else {
      const title = info.title.toLowerCase();
      if (title.startsWith(q)) score = 100;
      else if (title.includes(q)) score = 60;
      else if (info.haystack.includes(q)) score = 25;
      else continue;
      // Shorter titles are more likely to be the thing you meant.
      score += Math.max(0, 20 - info.title.length / 4);
    }
    score -= (order.get(ref.type) ?? 0) * 0.1;
    scored.push({ info, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.info);
}

/** Human label for a ref without building the whole EntityInfo. */
export function entityLabel(ref: EntityRef): string {
  return describeEntity(ref).title;
}
