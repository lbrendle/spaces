/**
 * The workspace as a git repository.
 *
 * Agent orchestration already leans on git for code — each agent works in its
 * own worktree, every run brackets itself with a commit before and after, and
 * a run is revertable because of it. This module extends that to the rest of
 * the workspace: tasks, memory, links, assignments, agent instructions and team
 * charters become files with real history, so "who changed this and why" is a
 * `git log`, a proposal is a branch, and undo is a revert.
 *
 * Three decisions hold the design up.
 *
 * **State lives outside `refs/heads`.** Everything is committed under
 * `refs/hq/*`, which git pushes and fetches like any other ref but which
 * `ls-remote --heads` does not report — so it rides the project's existing
 * GitHub remote without appearing as a branch, without cluttering the branch
 * list, and crucially without triggering CI. A task edit must never start a
 * build. (Verified locally; GitHub's acceptance of custom ref namespaces is
 * checked at push time and reported rather than assumed.)
 *
 * **One file per entity.** Not a table in a shared markdown file: two agents
 * adding a task at the same time would conflict on every single write. With
 * `tasks/<id>.md`, concurrent adds touch different paths and merge cleanly, and
 * a conflict means what a conflict should mean — two people changed the same
 * thing.
 *
 * **Git is the log; SQLite is a derived index.** Writes go to git and the
 * database is a cache rebuilt from it. That is what makes history, branching
 * and revert real rather than cosmetic — an exported mirror you cannot branch
 * from is a backup, not a version-control system.
 */
import { invoke } from "@tauri-apps/api/core";
import { git, isGitRepo } from "./workspaces";
import type {
  Assignment, Agent, Channel, Link, MemoryEntry, Project, Task, Team, TeamMember,
} from "./types";

/* ── refs ─────────────────────────────────────────────────────── */

/** Committed workspace state. Not a branch; invisible to CI. */
export const STATE_REF = "refs/hq/state";

/** One ref per proposing run, so a proposal is reviewable as a diff. */
export function proposalRef(runId: string): string {
  return `refs/hq/proposals/${runId}`;
}

/**
 * Where entity files live in the tree. Inside `.hq/` so an agent reading the
 * repo finds them next to the human-readable mirror, but under `state/` so the
 * two are never confused: the mirror is prose for reading, this is the record.
 */
export const STATE_DIR = ".hq/state";

export type EntityKind =
  | "projects" | "channels" | "tasks" | "memory" | "agents"
  | "teams" | "links" | "assignments";

export const ENTITY_KINDS: EntityKind[] = [
  "projects", "channels", "tasks", "memory", "agents", "teams", "links", "assignments",
];

/* ── encoding ─────────────────────────────────────────────────── */

/**
 * An entity as a file: front matter for the fields, body for the prose.
 *
 * Deliberately not JSON. A diff is the primary interface here — you read it in
 * a review, in `git log -p`, in a pull request — and JSON diffs badly: a
 * re-ordered key or a re-wrapped string shows as a change when nothing
 * changed. Keys are emitted in sorted order for exactly that reason, so the
 * same state always produces the same bytes.
 */
export function encodeEntity(fields: Record<string, unknown>, body = ""): string {
  const lines = ["---"];
  for (const key of Object.keys(fields).sort()) {
    const v = fields[key];
    if (v === undefined || v === null || v === "") continue;
    lines.push(`${key}: ${scalar(v)}`);
  }
  lines.push("---", "");
  const text = String(body ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (text) lines.push(text, "");
  return lines.join("\n");
}

function scalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // Quote only when the value could otherwise be misread — an unquoted value
  // keeps diffs readable, which is the whole point of this format.
  return /^[\w.@/+-]+$/.test(s) ? s : JSON.stringify(s);
}

export function decodeEntity(text: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  const src = text.replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { fields, body: src };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { fields, body: src };
  for (const line of src.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    try {
      fields[key] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    } catch {
      fields[key] = raw;
    }
  }
  return { fields, body: src.slice(end + 4).replace(/^\n+/, "") };
}

/* ── the tree ─────────────────────────────────────────────────── */

export interface StateFile {
  /** Relative to the repo root, e.g. ".hq/state/tasks/<id>.md". */
  path: string;
  contents: string;
}

/** Everything in the workspace, as files. Deterministic for a given state. */
export function stateFiles(s: {
  projects: Project[]; channels: Channel[]; tasks: Task[]; memory: MemoryEntry[];
  agents: Agent[]; teams: Team[]; teamMembers: TeamMember[];
  links: Link[]; assignments: Assignment[];
}): StateFile[] {
  const out: StateFile[] = [];
  const put = (kind: EntityKind, id: string, fields: Record<string, unknown>, body = "") =>
    out.push({ path: `${STATE_DIR}/${kind}/${id}.md`, contents: encodeEntity(fields, body) });

  for (const p of s.projects) {
    const { description, instructions, ...rest } = p;
    put("projects", p.id, rest, [description, instructions].filter(Boolean).join("\n\n"));
  }
  for (const c of s.channels) {
    const { topic, charter, ...rest } = c;
    put("channels", c.id, rest, [topic, charter].filter(Boolean).join("\n\n"));
  }
  for (const t of s.tasks) {
    const { description, ...rest } = t;
    put("tasks", t.id, rest, description);
  }
  for (const m of s.memory) {
    const { content, ...rest } = m;
    put("memory", m.id, rest, content);
  }
  for (const a of s.agents) {
    // The persona is the agent's standing instructions — the thing most worth
    // reviewing in a diff, so it is the body rather than a quoted field.
    const { persona, ...rest } = a;
    put("agents", a.id, rest, persona);
  }
  for (const t of s.teams) {
    const { charter, description, ...rest } = t;
    const members = s.teamMembers
      .filter((tm) => tm.team_id === t.id)
      .map((tm) => tm.agent_id)
      .sort();
    put("teams", t.id, { ...rest, members: members.join(",") },
      [description, charter].filter(Boolean).join("\n\n"));
  }
  for (const l of s.links) {
    const { note, ...rest } = l;
    put("links", l.id, rest, note);
  }
  for (const a of s.assignments) put("assignments", a.id, { ...a });

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/* ── plumbing ─────────────────────────────────────────────────── */

/**
 * `git` with an isolated index and optional stdin.
 *
 * The index matters: building a tree with the user's own index would stage
 * their working changes into Spaces's commit and, worse, leave their staging area
 * rearranged. A scratch index file keeps the two completely separate.
 */
async function gitEx(
  root: string,
  args: string[],
  opts: { indexFile?: string; stdin?: string } = {}
): Promise<string> {
  const env: Record<string, string> = {};
  if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  return invoke<string>("run_git_ex", {
    args,
    cwd: root,
    env,
    stdin: opts.stdin ?? null,
  });
}

async function refCommit(root: string, ref: string): Promise<string> {
  return git(root, "rev-parse", "-q", "--verify", ref).then((s) => s.trim(), () => "");
}

export interface CommitResult {
  /** '' when nothing changed and no commit was made. */
  commit: string;
  changed: boolean;
  error: string;
}

/**
 * Commit the current workspace state to `ref`.
 *
 * Writes the files, builds a tree through a scratch index, and only creates a
 * commit when the tree actually differs from the ref's current tree — an
 * unchanged commit per keystroke would make the history useless for review,
 * which is the one thing it exists for.
 */
export async function commitState(
  root: string,
  files: StateFile[],
  message: string,
  opts: { ref?: string; parentRef?: string; author?: string } = {}
): Promise<CommitResult> {
  const ref = opts.ref ?? STATE_REF;
  try {
    if (!(await isGitRepo(root))) {
      return { commit: "", changed: false, error: "not a git repository" };
    }

    for (const f of files) {
      await invoke("write_text_file", { root, relativePath: f.path, contents: f.contents });
    }
    // Spaces's record is not part of the user's branch: it belongs to refs/hq/*,
    // and leaving it untracked-but-visible would make `git status` noisy
    // forever. Excluded locally rather than through .gitignore, which is the
    // user's tracked file to own.
    await excludeLocally(root, [`/${STATE_DIR}/`]);

    const index = `.git/spaces-index-${Math.abs(hash(ref))}`;
    await gitEx(root, ["read-tree", "--empty"], { indexFile: index });
    await gitEx(root, ["add", "--force", "--", STATE_DIR], { indexFile: index });
    const tree = (await gitEx(root, ["write-tree"], { indexFile: index })).trim();

    const parent = await refCommit(root, opts.parentRef ?? ref);
    if (parent) {
      const prevTree = (await git(root, "rev-parse", `${parent}^{tree}`)).trim();
      if (prevTree === tree) return { commit: parent, changed: false, error: "" };
    }

    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : [])];
    const commit = (await gitEx(root, args, { stdin: message })).trim();
    await git(root, "update-ref", ref, commit);
    return { commit, changed: true, error: "" };
  } catch (e) {
    // The workspace must keep working when its history cannot be written —
    // a failed commit is a degraded feature, not a broken app.
    return { commit: "", changed: false, error: String(e) };
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Add local-only excludes; never touches the user's tracked .gitignore. */
async function excludeLocally(root: string, paths: string[]): Promise<void> {
  let existing = "";
  try {
    existing = await invoke<string>("read_text_file", { root, relativePath: ".git/info/exclude" });
  } catch {
    // no exclude file yet — writing creates it
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const add = paths.filter((p) => !have.has(p));
  if (!add.length) return;
  const banner = "# Spaces workspace state — versioned under refs/hq/*, not on your branch";
  const lines = existing.trim() ? existing.replace(/\s*$/, "").split("\n") : [];
  if (!lines.includes(banner)) lines.push(banner);
  lines.push(...add);
  await invoke("write_text_file", {
    root,
    relativePath: ".git/info/exclude",
    contents: lines.join("\n") + "\n",
  });
}

/* ── history ──────────────────────────────────────────────────── */

export interface StateCommit {
  sha: string;
  subject: string;
  author: string;
  at: number;
}

/** History of the workspace, newest first. */
export async function stateHistory(root: string, limit = 50, ref = STATE_REF): Promise<StateCommit[]> {
  const out = await git(
    root, "log", `--max-count=${limit}`, "--format=%H%x1f%s%x1f%an%x1f%at", ref
  ).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject, author, at] = line.split("\x1f");
      return { sha, subject, author, at: Number(at) * 1000 };
    });
}

/** What one commit changed, as a diff against its parent. */
export async function stateDiff(root: string, sha: string): Promise<string> {
  return git(root, "diff", `${sha}^!`, "--", STATE_DIR).catch(() =>
    git(root, "show", "--format=", sha).catch(() => "")
  );
}

/* ── sync ─────────────────────────────────────────────────────── */

export interface SyncResult {
  ok: boolean;
  detail: string;
}

/**
 * Push workspace history to the project's remote.
 *
 * Pushes `refs/hq/*` explicitly rather than relying on any default refspec, so
 * this can never touch a branch. A host that refuses custom ref namespaces
 * fails here and is reported honestly — the local history is still complete,
 * it just is not shared yet.
 */
export async function pushState(root: string, remote = "origin"): Promise<SyncResult> {
  try {
    await git(root, "push", remote, `${STATE_REF}:${STATE_REF}`);
    return { ok: true, detail: "workspace history pushed" };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export async function fetchState(root: string, remote = "origin"): Promise<SyncResult> {
  try {
    await git(root, "fetch", remote, `${STATE_REF}:${STATE_REF}`);
    return { ok: true, detail: "workspace history fetched" };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
