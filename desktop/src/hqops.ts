/**
 * What an agent can do in Spaces.
 *
 * Spaces's premise is that agents are members, not tools: they run inside their
 * own harness — `claude`, `codex`, Ritz — but they are graphed and orchestrated
 * as first-class members of the workspace. Membership means acting, not just
 * being described, and until this module existed an agent could read `.hq/`
 * and talk in a channel but could not create a task, draw a link or take
 * ownership of anything. That made "agents can do anything a human can do"
 * false.
 *
 * Every operation is declared ONCE here and reached two ways:
 *
 *   MCP        a stdio server the harness discovers through .mcp.json
 *   file drop  a JSONL line appended to .hq/actions.jsonl
 *
 * Two transports, one registry, deliberately: Ritz has its own tool system and
 * no MCP, and a second definition of "what an agent may do" would drift from
 * the first within a week. The transports differ only in how a call arrives.
 *
 * Product mutations use the same store/operation paths as the UI. Knowledge
 * reads use the same permission-aware SQLite helpers as the Knowledge surface,
 * and the one direct document visibility update preserves saveDocument's
 * existing version-history path.
 */
import { useStore } from "./store";
import { getDb } from "./db";
import { describeEntity, searchEntities } from "./entities";
import { LINK_KINDS } from "./links";
import { ASSIGN_ROLES } from "./links";
import {
  createDocument,
  createContentItem,
  listIntegrationAccounts,
  publishContentItem,
  saveDocument,
  sendCloudMail,
  uploadContentMedia,
  type IntegrationAccount,
} from "./operations";
import {
  listCollections,
  readKbFile,
  searchKb,
} from "./kb";
import {
  localKnowledgeIdentity,
  stableKnowledgeIdentities,
  stableKnowledgeIdentity,
} from "./knowledgeRefs";
import type { EntityRef, EntityType, LinkKind, AssignRole, TaskStatus, MemoryKind } from "./types";

/**
 * Whether an operation applies immediately or needs a human to say yes.
 *
 * Additive work is free: an agent that files a task or draws a link has added
 * information, and the cost of a wrong one is a click to remove it. Anything
 * that removes or reassigns existing work is proposed instead — a confused
 * agent quietly reorganising the board is a much worse failure than a slightly
 * slower one, and the proposal is also the audit trail.
 */
export type Effect = "auto" | "propose";

export interface OpParam {
  name: string;
  type: "string" | "number" | "boolean" | "ref" | "enum";
  required?: boolean;
  /** For `enum`. */
  choices?: readonly string[];
  describe: string;
}

export interface OpContext {
  /** The agent making the call; '' when a human is replaying a proposal. */
  agentId: string;
  /** Project the calling run belongs to, used to scope unqualified names. */
  projectId: string;
  /** Channel the run is happening in, for operations that default to "here". */
  channelId: string;
}

export interface OpResult {
  ok: boolean;
  /** One line the agent sees, and the line shown in the channel. */
  message: string;
  /** Set when the operation created or touched something addressable. */
  ref?: EntityRef;
}

export interface Operation {
  name: string;
  /** One sentence; becomes the MCP tool description verbatim. */
  describe: string;
  effect: Effect;
  /** Read-only operations never need approval and never appear in the log. */
  readOnly?: boolean;
  params: OpParam[];
  run(args: Record<string, unknown>, ctx: OpContext): Promise<OpResult>;
}

/* ── argument coercion ────────────────────────────────────────── */

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    // ISO timestamps are what a language model reaches for first.
    const asDate = Date.parse(v);
    if (Number.isFinite(asDate)) return asDate;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Resolve the entity an agent named.
 *
 * Accepts "type:id" — the form the mirrored `.hq/` files print — and falls
 * back to a search, because an agent that has just read BOARD.md is far more
 * likely to type a task's title than its uuid. Ambiguity is an error rather
 * than a guess: silently picking one of two matching tasks is exactly the kind
 * of quiet wrongness that makes agent-driven mutation untrustworthy.
 */
export function resolveRef(
  raw: string,
  ctx: OpContext,
  types?: EntityType[]
): { ref?: EntityRef; error?: string } {
  const text = raw.trim();
  if (!text) return { error: "empty reference" };

  const colon = text.indexOf(":");
  if (colon > 0) {
    const type = text.slice(0, colon) as EntityType;
    const id = text.slice(colon + 1);
    if (id && describeEntity({ type, id }).exists) return { ref: { type, id } };
    // A GitHub ref has no local row but is still perfectly addressable.
    if ((type === "pr" || type === "issue" || type === "repo") && id) return { ref: { type, id } };
  }

  const hits = searchEntities(text, { types, projectId: ctx.projectId, limit: 6 })
    .filter((h) => h.title.toLowerCase() === text.toLowerCase() || h.haystack.includes(text.toLowerCase()));
  if (!hits.length) return { error: `nothing in this workspace matches "${text}"` };
  const exact = hits.filter((h) => h.title.toLowerCase() === text.toLowerCase());
  const pool = exact.length ? exact : hits;
  if (pool.length > 1) {
    return {
      error:
        `"${text}" matches ${pool.length} things (` +
        pool.slice(0, 4).map((h) => `${h.ref.type}:${h.ref.id.slice(0, 8)} ${h.title}`).join("; ") +
        `). Use the type:id form.`,
    };
  }
  return { ref: pool[0].ref };
}

function projectOf(args: Record<string, unknown>, ctx: OpContext): string {
  const named = str(args, "project");
  if (!named) return ctx.projectId;
  const s = useStore.getState();
  const hit = s.projects.find(
    (p) => p.id === named || p.name.toLowerCase() === named.toLowerCase()
  );
  return hit?.id ?? ctx.projectId;
}

interface SocialAccountMetadata {
  connectionId?: string;
  projectLinks?: Array<{ projectId: string; isDefault: boolean }>;
}

function socialMetadata(account: IntegrationAccount): SocialAccountMetadata {
  try {
    const value = JSON.parse(account.metadata) as SocialAccountMetadata;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function socialConnectionId(account: IntegrationAccount): string {
  return socialMetadata(account).connectionId ?? account.id.replace(/^portal-/, "");
}

function socialAccount(
  accounts: IntegrationAccount[],
  platform: "instagram" | "tiktok",
  projectId: string,
  requested: string,
): { account?: IntegrationAccount; error?: string } {
  const provider = platform === "instagram" ? "meta" : "tiktok";
  const candidates = accounts
    .filter((account) => {
      if (
        account.category !== "social" ||
        account.provider !== provider ||
        account.status !== "connected"
      ) {
        return false;
      }
      if (!projectId) return true;
      return (socialMetadata(account).projectLinks ?? []).some(
        (link) => link.projectId === projectId,
      );
    })
    .sort((left, right) => {
      const leftDefault =
        socialMetadata(left).projectLinks?.some(
          (link) => link.projectId === projectId && link.isDefault,
        ) ?? false;
      const rightDefault =
        socialMetadata(right).projectLinks?.some(
          (link) => link.projectId === projectId && link.isDefault,
        ) ?? false;
      return Number(rightDefault) - Number(leftDefault);
    });

  if (!candidates.length) {
    return {
      error: projectId
        ? `No connected ${platform} account is linked to this project. Link one in Spaces web → Connections.`
        : `No connected ${platform} account is available.`,
    };
  }

  if (requested) {
    const needle = requested.toLowerCase().replace(/^@/, "");
    const match = candidates.find((account) =>
      [
        account.id,
        account.label,
        account.handle,
        socialConnectionId(account),
      ].some((value) => value.toLowerCase().replace(/^@/, "") === needle)
    );
    return match
      ? { account: match }
      : {
          error: `No linked ${platform} account matches "${requested}". Available: ${candidates
            .map((account) => account.handle || account.label)
            .join(", ")}.`,
        };
  }

  if (candidates.length > 1) {
    const defaults = candidates.filter((account) =>
      socialMetadata(account).projectLinks?.some(
        (link) => link.projectId === projectId && link.isDefault,
      )
    );
    if (defaults.length === 1) return { account: defaults[0] };
    return {
      error: `Choose an account. Available: ${candidates
        .map((account) => account.handle || account.label)
        .join(", ")}.`,
    };
  }
  return { account: candidates[0] };
}

const REF_HELP = 'either "type:id" as printed in .hq/, or an exact title';

/* ── the registry ─────────────────────────────────────────────── */

export const OPERATIONS: Operation[] = [
  {
    name: "hq_search",
    describe: "Search everything in the workspace — projects, channels, tasks, memory, agents, teams — and get back type:id references you can pass to the other tools.",
    effect: "auto",
    readOnly: true,
    params: [
      { name: "query", type: "string", required: true, describe: "What to look for. An empty string lists everything." },
      { name: "types", type: "string", describe: "Optional comma-separated entity types to restrict to, e.g. \"task,memory\"." },
    ],
    async run(args, ctx) {
      const types = str(args, "types")
        .split(",").map((t) => t.trim()).filter(Boolean) as EntityType[];
      const hits = searchEntities(str(args, "query"), {
        types: types.length ? types : undefined,
        projectId: ctx.projectId,
        limit: 25,
      });
      if (!hits.length) return { ok: true, message: "No matches." };
      return {
        ok: true,
        message: hits
          .map((h) => `${h.ref.type}:${h.ref.id} — ${h.title}${h.subtitle ? ` (${h.subtitle})` : ""}`)
          .join("\n"),
      };
    },
  },

  {
    name: "hq_get",
    describe: "Read one entity in full, plus everything it is linked to and everyone assigned to it.",
    effect: "auto",
    readOnly: true,
    params: [{ name: "ref", type: "ref", required: true, describe: REF_HELP }],
    async run(args, ctx) {
      const { ref, error } = resolveRef(str(args, "ref"), ctx);
      if (!ref) return { ok: false, message: error ?? "not found" };
      const info = describeEntity(ref);
      const links = useStore.getState().linksFor(ref);
      const who = useStore.getState().assignmentsFor(ref);
      const lines = [
        `${ref.type}:${ref.id}`,
        `# ${info.title}`,
        info.subtitle && `_${info.subtitle}_`,
        info.body,
        links.length && `\n## Linked\n` + links.map((l) => {
          const far = l.from_id === ref.id
            ? { type: l.to_type, id: l.to_id }
            : { type: l.from_type, id: l.from_id };
          return `- ${l.kind} → ${far.type}:${far.id} ${describeEntity(far as EntityRef).title}`;
        }).join("\n"),
        who.length && `\n## Assigned\n` + who.map((a) =>
          `- ${describeEntity({ type: a.subject_type, id: a.subject_id }).title} (${a.role})`
        ).join("\n"),
      ].filter(Boolean);
      return { ok: true, message: lines.join("\n"), ref };
    },
  },

  {
    name: "spaces_search_knowledge",
    describe:
      "Search workspace-visible vault notes and documents by title, folder path, or content. Returns stable knowledge:source:path references for citations and follow-up reads.",
    effect: "auto",
    readOnly: true,
    params: [
      {
        name: "query",
        type: "string",
        required: true,
        describe: "Words or a folder path to find in shared Knowledge.",
      },
    ],
    async run(args) {
      const query = str(args, "query");
      if (!query) return { ok: false, message: "query is required" };
      const workspaceViewer = { type: "member", id: "" } as const;
      const [hits, collections, documents, identities] = await Promise.all([
        searchKb(query, { limit: 25, viewer: workspaceViewer }),
        listCollections(workspaceViewer),
        getDb().then((db) =>
          db.select<
            Array<{
              id: string;
              title: string;
              path: string;
              body: string;
            }>
          >(
            `SELECT id, title, path, body
               FROM documents
              WHERE visibility = 'workspace'
                AND (
                  lower(title) LIKE $1 OR lower(path) LIKE $1 OR
                  lower(body) LIKE $1
                )
              ORDER BY updated_at DESC
              LIMIT 25`,
            [`%${query.toLowerCase()}%`],
          ),
        ),
        stableKnowledgeIdentities(),
      ]);
      const names = new Map(
        collections.map((collection) => [collection.id, collection.name]),
      );
      const lines = [
        ...hits.map(
          (hit) =>
            `knowledge:${stableKnowledgeIdentity(
              identities,
              "vault",
              hit.collection_id,
            )}:${encodeURIComponent(hit.rel_path)} — ` +
            `${names.get(hit.collection_id) ?? "Shared vault"} / ${hit.rel_path} — ${hit.title}`,
        ),
        ...documents.map(
          (document) =>
            `knowledge:document:${encodeURIComponent(
              stableKnowledgeIdentity(
                identities,
                "document",
                document.id,
              ),
            )} — Workspace documents / ` +
            `${document.path || `${document.title}.md`} — ${document.title}`,
        ),
      ].slice(0, 25);
      return {
        ok: true,
        message: lines.length ? lines.join("\n") : "No Knowledge matches.",
      };
    },
  },

  {
    name: "spaces_read_knowledge",
    describe:
      "Read one shared Knowledge note in full from the stable knowledge:source:path reference returned by search, preserving its source and folder path for citation.",
    effect: "auto",
    readOnly: true,
    params: [
      {
        name: "ref",
        type: "string",
        required: true,
        describe:
          "An exact knowledge:source:path reference from spaces_search_knowledge.",
      },
    ],
    async run(args) {
      const ref = str(args, "ref");
      const match = /^knowledge:([^:]+):(.+)$/.exec(ref);
      if (!match) {
        return {
          ok: false,
          message:
            "Use an exact knowledge:source:path reference from spaces_search_knowledge.",
        };
      }
      const sourceId = match[1];
      let key = match[2];
      try {
        key = decodeURIComponent(key);
      } catch {
        return { ok: false, message: "The Knowledge reference is malformed." };
      }
      if (sourceId === "document") {
        const documentId = await localKnowledgeIdentity("document", key);
        if (!documentId) {
          return { ok: false, message: "Knowledge note not found." };
        }
        const db = await getDb();
        const [document] = await db.select<
          Array<{
            id: string;
            title: string;
            path: string;
            body: string;
          }>
        >(
          `SELECT id, title, path, body
             FROM documents
            WHERE id = $1 AND visibility = 'workspace'
            LIMIT 1`,
          [documentId],
        );
        if (!document) return { ok: false, message: "Knowledge note not found." };
        return {
          ok: true,
          message: [
            ref,
            `# ${document.title}`,
            `Source: Workspace documents`,
            `Path: ${document.path || `${document.title}.md`}`,
            "",
            document.body,
          ].join("\n"),
        };
      }
      const collectionId = await localKnowledgeIdentity("vault", sourceId);
      if (!collectionId) {
        return { ok: false, message: "Knowledge source not found." };
      }
      const workspaceViewer = { type: "member", id: "" } as const;
      const collection = (await listCollections(workspaceViewer)).find(
        (candidate) => candidate.id === collectionId,
      );
      if (!collection) return { ok: false, message: "Knowledge source not found." };
      const note = await readKbFile(collectionId, key);
      return {
        ok: true,
        message: [
          ref,
          `# ${key.split("/").pop()?.replace(/\.[^.]+$/, "") || "Untitled"}`,
          `Source: ${collection.name}`,
          `Path: ${key}`,
          "",
          note.text,
        ].join("\n"),
      };
    },
  },

  {
    name: "hq_create_task",
    describe: "File a task on the board. Use this instead of describing work in prose that nobody will act on.",
    effect: "auto",
    params: [
      { name: "title", type: "string", required: true, describe: "Short imperative title." },
      { name: "description", type: "string", describe: "Detail, markdown allowed." },
      { name: "status", type: "enum", choices: ["backlog", "todo", "doing", "done"], describe: "Defaults to todo." },
      { name: "assignee", type: "ref", describe: "An agent to put on it, e.g. \"agent:<id>\" or its name." },
      { name: "project", type: "string", describe: "Defaults to the project this run belongs to." },
      { name: "due_date", type: "string", describe: "YYYY-MM-DD." },
    ],
    async run(args, ctx) {
      const title = str(args, "title");
      if (!title) return { ok: false, message: "title is required" };
      const project = projectOf(args, ctx);
      if (!project) return { ok: false, message: "no project in scope — pass `project`" };

      let assignee = "";
      const rawAssignee = str(args, "assignee");
      if (rawAssignee) {
        const { ref } = resolveRef(rawAssignee, ctx, ["agent"]);
        if (ref) assignee = ref.id;
      }
      const task = await useStore.getState().addTask({
        project_id: project,
        title,
        description: str(args, "description"),
        status: (str(args, "status") || "todo") as TaskStatus,
        assignee_agent_id: assignee,
        due_date: str(args, "due_date"),
      });
      return { ok: true, message: `Filed task:${task.id} — ${task.title}`, ref: { type: "task", id: task.id } };
    },
  },

  {
    name: "hq_update_task",
    describe: "Change a task's status, title, description, due date or assignee.",
    effect: "propose",
    params: [
      { name: "task", type: "ref", required: true, describe: REF_HELP },
      { name: "status", type: "enum", choices: ["backlog", "todo", "doing", "done"], describe: "New status." },
      { name: "title", type: "string", describe: "New title." },
      { name: "description", type: "string", describe: "New description." },
      { name: "assignee", type: "ref", describe: "Agent to reassign to; empty string unassigns." },
      { name: "due_date", type: "string", describe: "YYYY-MM-DD." },
    ],
    async run(args, ctx) {
      const { ref, error } = resolveRef(str(args, "task"), ctx, ["task"]);
      if (!ref) return { ok: false, message: error ?? "task not found" };
      const patch: Record<string, unknown> = {};
      for (const key of ["status", "title", "description", "due_date"]) {
        if (args[key] !== undefined) patch[key] = str(args, key);
      }
      if (args.assignee !== undefined) {
        const raw = str(args, "assignee");
        patch.assignee_agent_id = raw ? (resolveRef(raw, ctx, ["agent"]).ref?.id ?? "") : "";
      }
      if (!Object.keys(patch).length) return { ok: false, message: "nothing to change" };
      await useStore.getState().updateTask(ref.id, patch);
      return { ok: true, message: `Updated ${describeEntity(ref).title}`, ref };
    },
  },

  {
    name: "hq_link",
    describe: "Connect two things. Linking a memory entry or a task to a channel is how the agents in that channel come to know about it, so prefer linking over restating.",
    effect: "auto",
    params: [
      { name: "from", type: "ref", required: true, describe: REF_HELP },
      { name: "to", type: "ref", required: true, describe: REF_HELP },
      {
        name: "kind", type: "enum", choices: LINK_KINDS.map((k) => k.kind),
        describe: "Relation, read from → to. Defaults to relates.",
      },
      { name: "note", type: "string", describe: "Why they are connected." },
    ],
    async run(args, ctx) {
      const a = resolveRef(str(args, "from"), ctx);
      if (!a.ref) return { ok: false, message: `from: ${a.error}` };
      const b = resolveRef(str(args, "to"), ctx);
      if (!b.ref) return { ok: false, message: `to: ${b.error}` };
      const kind = (str(args, "kind") || "relates") as LinkKind;
      const link = await useStore.getState().addLink(a.ref, b.ref, kind, str(args, "note"), ctx.agentId || "user");
      if (!link) return { ok: false, message: "nothing links to itself" };
      return {
        ok: true,
        message: `Linked ${describeEntity(a.ref).title} ${kind} ${describeEntity(b.ref).title}`,
        ref: a.ref,
      };
    },
  },

  {
    name: "hq_unlink",
    describe: "Remove a connection between two things.",
    effect: "propose",
    params: [
      { name: "from", type: "ref", required: true, describe: REF_HELP },
      { name: "to", type: "ref", required: true, describe: REF_HELP },
    ],
    async run(args, ctx) {
      const a = resolveRef(str(args, "from"), ctx);
      const b = resolveRef(str(args, "to"), ctx);
      if (!a.ref || !b.ref) return { ok: false, message: a.error ?? b.error ?? "not found" };
      const store = useStore.getState();
      const hit = store.links.find(
        (l) =>
          (l.from_id === a.ref!.id && l.to_id === b.ref!.id) ||
          (l.from_id === b.ref!.id && l.to_id === a.ref!.id)
      );
      if (!hit) return { ok: false, message: "those two are not linked" };
      await store.removeLink(hit.id);
      return { ok: true, message: `Unlinked ${describeEntity(a.ref).title} from ${describeEntity(b.ref).title}` };
    },
  },

  {
    name: "hq_assign",
    describe: "Put an agent or team on anything — a task, a channel, a project, a pull request, a calendar event.",
    effect: "propose",
    params: [
      { name: "subject", type: "ref", required: true, describe: "The agent or team taking it on." },
      { name: "target", type: "ref", required: true, describe: REF_HELP },
      {
        name: "role", type: "enum", choices: ASSIGN_ROLES.map((r) => r.role),
        describe: "owner, assignee, reviewer or watcher. Defaults to owner.",
      },
    ],
    async run(args, ctx) {
      const s = resolveRef(str(args, "subject"), ctx, ["agent", "team"]);
      if (!s.ref) return { ok: false, message: `subject: ${s.error}` };
      const t = resolveRef(str(args, "target"), ctx);
      if (!t.ref) return { ok: false, message: `target: ${t.error}` };
      const role = (str(args, "role") || "owner") as AssignRole;
      const row = await useStore.getState().assign(s.ref, t.ref, role);
      if (!row) return { ok: false, message: "only agents and teams can be assigned" };
      return {
        ok: true,
        message: `${describeEntity(s.ref).title} is now ${role} of ${describeEntity(t.ref).title}`,
        ref: t.ref,
      };
    },
  },

  {
    name: "hq_add_memory",
    describe: "Record a decision, convention or piece of context. Everything here is injected into every future run in this project, so write what a teammate would need to stop asking the same question.",
    effect: "auto",
    params: [
      { name: "title", type: "string", required: true, describe: "The claim, stated as a sentence." },
      { name: "content", type: "string", describe: "Detail and reasoning, markdown allowed." },
      { name: "kind", type: "enum", choices: ["decision", "context", "note"], describe: "Defaults to note." },
      { name: "project", type: "string", describe: "Defaults to the project this run belongs to." },
    ],
    async run(args, ctx) {
      const title = str(args, "title");
      if (!title) return { ok: false, message: "title is required" };
      const project = projectOf(args, ctx);
      if (!project) return { ok: false, message: "no project in scope — pass `project`" };
      const entry = await useStore.getState().addMemory({
        project_id: project,
        title,
        content: str(args, "content"),
        kind: (str(args, "kind") || "note") as MemoryKind,
      });
      return { ok: true, message: `Recorded memory:${entry.id} — ${entry.title}`, ref: { type: "memory", id: entry.id } };
    },
  },

  {
    name: "spaces_create_document",
    describe:
      "Create a durable Markdown document in Spaces, optionally inside a project and nested folder. Workspace visibility makes it available to paired teammates and Knowledge-aware agents.",
    effect: "auto",
    params: [
      {
        name: "title",
        type: "string",
        required: true,
        describe: "Document title.",
      },
      {
        name: "body",
        type: "string",
        describe: "Markdown document body.",
      },
      {
        name: "folder",
        type: "string",
        describe: "Nested folder path, e.g. Company/Runbooks.",
      },
      {
        name: "tags",
        type: "string",
        describe: "Comma-separated tags.",
      },
      {
        name: "visibility",
        type: "enum",
        choices: ["private", "workspace"],
        describe: "Defaults to workspace.",
      },
      {
        name: "project",
        type: "string",
        describe: "Defaults to the project this run belongs to.",
      },
    ],
    async run(args, ctx) {
      const title = str(args, "title");
      if (!title) return { ok: false, message: "title is required" };
      const projectId = projectOf(args, ctx);
      const document = await createDocument(
        projectId,
        str(args, "folder") || "Notes",
      );
      const visibility =
        str(args, "visibility") === "private" ? "private" : "workspace";
      const saved = await saveDocument({
        ...document,
        title,
        body: str(args, "body"),
        tags: str(args, "tags"),
        visibility,
      });
      const db = await getDb();
      await db.execute(
        "UPDATE documents SET visibility = $1 WHERE id = $2",
        [visibility, saved.id],
      );
      return {
        ok: true,
        message:
          `Created document ${saved.title} in ${saved.path} ` +
          `(${visibility === "workspace" ? "shared with the workspace" : "private"}).`,
      };
    },
  },

  {
    name: "spaces_send_mail",
    describe:
      "Send mail through the current member's connected Google or Microsoft account. This always waits for human approval before the external send.",
    effect: "propose",
    params: [
      {
        name: "provider",
        type: "enum",
        choices: ["google", "microsoft"],
        required: true,
        describe: "The member-owned mail account provider.",
      },
      {
        name: "to",
        type: "string",
        required: true,
        describe: "Recipient email address.",
      },
      {
        name: "subject",
        type: "string",
        required: true,
        describe: "Message subject.",
      },
      {
        name: "body",
        type: "string",
        required: true,
        describe: "Plain-text message body.",
      },
    ],
    async run(args) {
      const provider = str(args, "provider");
      if (provider !== "google" && provider !== "microsoft") {
        return { ok: false, message: "provider must be google or microsoft" };
      }
      const to = str(args, "to");
      const subject = str(args, "subject");
      const body = str(args, "body");
      if (!to || !subject || !body) {
        return { ok: false, message: "to, subject, and body are required" };
      }
      const sent = await sendCloudMail(provider, { to, subject, body });
      return {
        ok: true,
        message: `Sent “${sent.subject}” to ${sent.to_email} through ${provider}.`,
      };
    },
  },

  {
    name: "hq_create_event",
    describe: "Put something on a calendar — a review, a deadline, a block of focused work.",
    effect: "auto",
    params: [
      { name: "title", type: "string", required: true, describe: "What it is." },
      { name: "starts_at", type: "string", required: true, describe: "ISO 8601 timestamp." },
      { name: "ends_at", type: "string", describe: "ISO 8601; defaults to one hour after the start." },
      { name: "calendar", type: "string", describe: "Calendar name or id; defaults to the first writable one." },
      { name: "description", type: "string", describe: "Detail." },
      { name: "about", type: "ref", describe: "Something this event is about — it gets linked automatically." },
    ],
    async run(args, ctx) {
      const title = str(args, "title");
      const starts = num(args, "starts_at");
      if (!title || starts === null) return { ok: false, message: "title and a parsable starts_at are required" };
      const ends = num(args, "ends_at") ?? starts + 3_600_000;

      const store = useStore.getState();
      const named = str(args, "calendar");
      const cal =
        store.calendars.find((c) => c.id === named || c.name.toLowerCase() === named.toLowerCase()) ??
        store.calendars.find((c) => c.writable);
      if (!cal) return { ok: false, message: "no writable calendar exists yet — create one in Settings first" };

      const ev = await store.addEvent({
        calendar_id: cal.id,
        title,
        description: str(args, "description"),
        starts_at: starts,
        ends_at: Math.max(ends, starts + 60_000),
      });
      const about = str(args, "about");
      if (about) {
        const { ref } = resolveRef(about, ctx);
        if (ref) await store.addLink({ type: "event", id: ev.id }, ref, "references", "", ctx.agentId || "user");
      }
      return { ok: true, message: `Scheduled event:${ev.id} — ${ev.title}`, ref: { type: "event", id: ev.id } };
    },
  },

  {
    name: "hq_post",
    describe: "Post a message into a channel other than the one you are replying in — for handing something to a different team without waiting for a human to relay it.",
    effect: "auto",
    params: [
      { name: "channel", type: "ref", required: true, describe: "Channel name or channel:<id>." },
      { name: "content", type: "string", required: true, describe: "The message. @mentions trigger their agents, exactly as they would from a person." },
    ],
    async run(args, ctx) {
      const { ref, error } = resolveRef(str(args, "channel"), ctx, ["channel"]);
      if (!ref) return { ok: false, message: error ?? "channel not found" };
      const content = str(args, "content");
      if (!content) return { ok: false, message: "content is required" };
      const store = useStore.getState();
      const agent = store.agents.find((a) => a.id === ctx.agentId);
      const msg = await store.insertMessage({
        id: crypto.randomUUID(),
        channel_id: ref.id,
        author_type: agent ? "agent" : "system",
        author_id: ctx.agentId,
        author_name: agent?.name ?? "Spaces",
        content,
        status: "done",
        meta: "posted from another channel",
      });
      return { ok: true, message: `Posted to ${describeEntity(ref).title}`, ref: { type: "message", id: msg.id } };
    },
  },

  {
    name: "spaces_publish_social",
    describe:
      "Publish an approved post through a connected Instagram or TikTok account. This always waits for a human in Spaces to approve it before anything reaches the network.",
    effect: "propose",
    params: [
      {
        name: "platform",
        type: "enum",
        choices: ["instagram", "tiktok"],
        required: true,
        describe: "The network to publish to.",
      },
      {
        name: "copy",
        type: "string",
        required: true,
        describe: "The final caption or post copy.",
      },
      {
        name: "media_url",
        type: "string",
        describe:
          "An existing public HTTPS image URL for Instagram or video URL for TikTok. Use media_path instead for a file in the project.",
      },
      {
        name: "media_path",
        type: "string",
        describe:
          "A local image or video path inside the project. After human approval, Spaces uploads it to workspace storage before publishing.",
      },
      {
        name: "account",
        type: "string",
        describe: "Connected account handle, label, or connection id. Required when the project has no default.",
      },
      {
        name: "title",
        type: "string",
        describe: "Internal Content Studio title; defaults to the first line of the copy.",
      },
      {
        name: "project",
        type: "string",
        describe: "Defaults to the current project; its linked account policy is enforced.",
      },
    ],
    async run(args, ctx) {
      const platform = str(args, "platform") as "instagram" | "tiktok";
      if (platform !== "instagram" && platform !== "tiktok") {
        return { ok: false, message: "platform must be instagram or tiktok" };
      }
      const copy = str(args, "copy");
      let mediaUrl = str(args, "media_url");
      const mediaPath = str(args, "media_path");
      if (!copy || (!mediaUrl && !mediaPath)) {
        return { ok: false, message: "copy and either media_url or media_path are required" };
      }
      const projectId = projectOf(args, ctx);
      if (mediaPath && !mediaUrl) {
        const project = useStore.getState().projects.find((row) => row.id === projectId);
        if (!project?.local_path) {
          return {
            ok: false,
            message:
              "media_path needs a project with a local folder. Link the project folder in Spaces or provide media_url.",
          };
        }
        const absolute =
          mediaPath.startsWith("/") ||
          /^[a-zA-Z]:[\\/]/.test(mediaPath) ||
          mediaPath.startsWith("\\\\")
            ? mediaPath
            : `${project.local_path.replace(/[\\/]$/, "")}${
                project.local_path.includes("\\") ? "\\" : "/"
              }${mediaPath}`;
        try {
          mediaUrl = await uploadContentMedia(
            absolute,
            projectId,
            project.local_path,
          );
        } catch (error) {
          return {
            ok: false,
            message:
              error instanceof Error ? error.message : "Spaces could not upload the media file.",
          };
        }
      }
      let parsedMedia: URL;
      try {
        parsedMedia = new URL(mediaUrl);
      } catch {
        return { ok: false, message: "media_url must be a valid public HTTPS URL" };
      }
      if (parsedMedia.protocol !== "https:") {
        return { ok: false, message: "media_url must use HTTPS" };
      }

      const selected = socialAccount(
        await listIntegrationAccounts(),
        platform,
        projectId,
        str(args, "account"),
      );
      if (!selected.account) {
        return { ok: false, message: selected.error ?? "No publishing account is available." };
      }

      const item = await createContentItem({
        project_id: projectId,
        campaign: "",
        title: str(args, "title") || copy.split("\n")[0].slice(0, 120) || `${platform} post`,
        brief: `Proposed by ${useStore.getState().agents.find((agent) => agent.id === ctx.agentId)?.name ?? "an agent"}`,
        copy,
        platform,
        connection_id: socialConnectionId(selected.account),
        status: "review",
        scheduled_at: 0,
        agent_id: ctx.agentId,
        media_url: parsedMedia.toString(),
      });
      const result = await publishContentItem(item);
      return {
        ok: true,
        message:
          result.state === "published"
            ? `Published ${item.title}${result.url ? ` — ${result.url}` : ""}`
            : `${platform} accepted ${item.title} and is processing it (${result.externalId})`,
      };
    },
  },
];

export const OP_BY_NAME: Record<string, Operation> = Object.fromEntries(
  OPERATIONS.map((o) => [o.name, o])
);

/** JSON Schema for one operation's arguments, for the MCP tool listing. */
export function schemaFor(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of op.params) {
    properties[p.name] =
      p.type === "enum"
        ? { type: "string", enum: p.choices, description: p.describe }
        : p.type === "number"
          ? { type: "number", description: p.describe }
          : p.type === "boolean"
            ? { type: "boolean", description: p.describe }
            : { type: "string", description: p.describe };
  }
  return {
    type: "object",
    properties,
    required: op.params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

/** The whole registry as JSON, for the MCP server to serve without importing React. */
export function manifest(): unknown {
  return OPERATIONS.map((op) => ({
    name: op.name,
    description: op.describe,
    inputSchema: schemaFor(op),
    effect: op.effect,
    readOnly: !!op.readOnly,
  }));
}
