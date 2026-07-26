/**
 * The file-drop transport, and the applier both transports share.
 *
 * An agent that can only read `.hq/` is a spectator. MCP fixes that for the
 * harnesses that speak it; this fixes it for everything else. Appending a line
 * to `<cwd>/.hq/actions.jsonl` needs nothing but `echo >>`, which every agent
 * in every harness can already do — Ritz included, and any future one.
 *
 * Both transports meet at dispatchAction(): one place decides whether an
 * operation applies now or waits for a human, one place writes the audit row.
 * A second decision site would drift from the first, and "did an agent need
 * approval for this?" is exactly the question that must have one answer.
 *
 * The hazard of a file transport is double application: a line still sitting
 * in the file after it was recorded gets replayed on the next drain, and the
 * board grows three copies of the same task. So the file is emptied BEFORE any
 * line runs. A crash mid-drain can therefore lose an action, which is a far
 * cheaper failure than silently repeating one — the agent gets no confirmation
 * either way, and a lost line is invisible where a duplicate is corrosive.
 *
 * Nothing here throws. A drain is a side-effect of finishing a run, and a
 * malformed JSONL line must never be able to fail the run that produced it.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDb, uid, now } from "./db";
import { OPERATIONS, OP_BY_NAME } from "./hqops";
import type { Effect, OpContext, OpResult } from "./hqops";
import type { Project } from "./types";

/** applied: done. pending: waiting on a human. rejected/failed: terminal. */
export type ActionStatus = "applied" | "pending" | "rejected" | "failed";

/** A row of agent_actions (db.ts, migration v14). */
export interface AgentActionRow {
  id: string;
  agent_id: string;
  run_id: string;
  channel_id: string;
  project_id: string;
  op: string;
  /** JSON object, as written by the agent. Use argsOf() to read it. */
  args: string;
  status: ActionStatus;
  /** The op's one-line message, or why it failed. */
  result: string;
  /** Which transport it arrived through: "file" | "mcp". */
  source: string;
  created_at: number;
  decided_at: number;
}

/**
 * The run context, plus the run id the table wants. Assignable from a plain
 * OpContext so callers that don't have a run (a human replaying a proposal)
 * don't have to invent one.
 */
export type DrainContext = OpContext & { runId?: string };

export interface DrainReport {
  /** Operations that ran and succeeded. */
  applied: number;
  /** Operations recorded and waiting on a human. */
  pending: number;
  /** Unparsable lines, unknown ops, and operations that ran and failed. */
  failed: number;
  /** Lines left in the file on purpose — over the per-drain cap, or a partial final line. */
  deferred: number;
  /** One line per action, in file order. Safe to echo back into the channel. */
  lines: string[];
  /** File-level problems (unreadable, unwritable). Reported, never thrown. */
  errors: string[];
}

const DIR = ".hq";
const FILE = `${DIR}/actions.jsonl`;

/**
 * How many lines one drain will take. A runaway loop can append faster than a
 * human can notice; the rest stays in the file rather than being dropped, so
 * the next drain continues where this one stopped.
 */
const MAX_PER_DRAIN = 200;

/* ── the change bus ───────────────────────────────────────────── */

const listeners = new Set<() => void>();
let version = 0;

/**
 * Subscribe to queue changes. Returns an unsubscribe fn.
 * Pairs with actionsVersion() for React's useSyncExternalStore — the counter
 * is compared by value, so a re-render happens exactly when something moved.
 */
export function subscribeActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function actionsVersion(): number {
  return version;
}

/** Announce that the action log changed. Exported for the MCP transport. */
export function emitActions(): void {
  version++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // a bad subscriber must not break a drain
    }
  }
}

/* ── the log ──────────────────────────────────────────────────── */

/** The args an agent wrote, parsed. Never throws — a bad row reads as empty. */
export function argsOf(row: AgentActionRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.args || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function insertRow(row: AgentActionRow): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO agent_actions
       (id, agent_id, run_id, channel_id, project_id, op, args, status, result, source, created_at, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.id, row.agent_id, row.run_id, row.channel_id, row.project_id, row.op,
      row.args, row.status, row.result, row.source, row.created_at, row.decided_at,
    ]
  );
}

async function settle(id: string, status: ActionStatus, result: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE agent_actions SET status = $1, result = $2, decided_at = $3 WHERE id = $4",
    [status, result.slice(0, 4000), now(), id]
  );
}

async function rowById(id: string): Promise<AgentActionRow | null> {
  const db = await getDb();
  const [row] = await db.select<AgentActionRow[]>("SELECT * FROM agent_actions WHERE id = $1", [id]);
  return row ?? null;
}

/**
 * The approval queue, oldest first: it is a to-do list, and the proposal that
 * has waited longest is the one to decide next.
 */
export async function pendingActions(): Promise<AgentActionRow[]> {
  try {
    const db = await getDb();
    return await db.select<AgentActionRow[]>(
      "SELECT * FROM agent_actions WHERE status = 'pending' ORDER BY created_at, id"
    );
  } catch {
    return [];
  }
}

/** The audit trail, newest first. */
export async function recentActions(limit = 50): Promise<AgentActionRow[]> {
  try {
    const db = await getDb();
    return await db.select<AgentActionRow[]>(
      "SELECT * FROM agent_actions ORDER BY created_at DESC, id DESC LIMIT $1",
      [Math.max(1, Math.min(limit, 500))]
    );
  } catch {
    return [];
  }
}

/* ── the applier ──────────────────────────────────────────────── */

function ctxOf(row: AgentActionRow): OpContext {
  return { agentId: row.agent_id, projectId: row.project_id, channelId: row.channel_id };
}

const VALID_OPS = OPERATIONS.map((o) => o.name).join(", ");

/**
 * Run one recorded action and stamp the outcome on it.
 *
 * Used by the drain for anything that applies immediately, and by a human
 * approving a proposal — deliberately the same code, so an approved proposal
 * cannot behave differently from the action the agent originally asked for.
 * Takes the row or its id; the UI usually has the row already.
 */
export async function applyAction(row: AgentActionRow | string): Promise<OpResult> {
  let target: AgentActionRow | null;
  try {
    target = typeof row === "string" ? await rowById(row) : row;
  } catch (e) {
    return { ok: false, message: String(e) };
  }
  if (!target) return { ok: false, message: "that action is no longer in the log" };

  const op = OP_BY_NAME[target.op];
  if (!op) {
    const message = `unknown op "${target.op}" — valid ops are: ${VALID_OPS}`;
    await settle(target.id, "failed", message).catch(() => {});
    emitActions();
    return { ok: false, message };
  }

  let result: OpResult;
  try {
    result = await op.run(argsOf(target), ctxOf(target));
  } catch (e) {
    result = { ok: false, message: String(e) };
  }
  await settle(target.id, result.ok ? "applied" : "failed", result.message).catch(() => {});
  emitActions();
  return result;
}

/**
 * The one entry point both transports use: record what an agent asked for,
 * then either do it or park it.
 *
 * Read-only operations are answered without a row — they change nothing, so
 * logging them would bury the mutations that matter under a pile of searches.
 */
export async function dispatchAction(
  opName: string,
  args: Record<string, unknown>,
  ctx: DrainContext,
  source: string,
  /** The agent's own id for the row, so a re-sent line can't apply twice. */
  id?: string
): Promise<{ row: AgentActionRow | null; result: OpResult }> {
  const op = OP_BY_NAME[opName];

  if (op?.readOnly) {
    try {
      return { row: null, result: await op.run(args, ctx) };
    } catch (e) {
      return { row: null, result: { ok: false, message: String(e) } };
    }
  }

  const row: AgentActionRow = {
    id: id || uid(),
    agent_id: ctx.agentId,
    run_id: ctx.runId ?? "",
    channel_id: ctx.channelId,
    project_id: ctx.projectId,
    op: opName,
    args: safeStringify(args),
    // Every row starts pending and is settled below, so an app that dies
    // mid-operation leaves a visible loose end rather than a row claiming to
    // have applied something that never ran.
    status: "pending",
    result: "",
    source,
    created_at: now(),
    decided_at: 0,
  };

  if (!op) {
    row.status = "failed";
    row.result = `unknown op "${opName}" — valid ops are: ${VALID_OPS}`;
    row.decided_at = row.created_at;
    await insertRow(row).catch(() => {});
    emitActions();
    return { row, result: { ok: false, message: row.result } };
  }

  if (op.effect === "propose") {
    row.result = "waiting for a human to approve";
    await insertRow(row);
    emitActions();
    return {
      row,
      result: {
        ok: true,
        message: `Proposed ${opName} — it is in Spaces's approval queue and takes effect when someone accepts it.`,
      },
    };
  }

  await insertRow(row);
  const result = await applyAction(row);
  return { row: { ...row, status: result.ok ? "applied" : "failed", result: result.message }, result };
}

/** Apply a queued proposal. */
export async function approveAction(id: string): Promise<OpResult> {
  let row: AgentActionRow | null;
  try {
    row = await rowById(id);
  } catch (e) {
    return { ok: false, message: String(e) };
  }
  if (!row) return { ok: false, message: "that action is no longer in the log" };
  if (row.status !== "pending") return { ok: false, message: `already ${row.status}` };
  return applyAction(row);
}

/** Decline a queued proposal. The row stays as the record that it was asked for. */
export async function rejectAction(id: string): Promise<OpResult> {
  try {
    const row = await rowById(id);
    if (!row) return { ok: false, message: "that action is no longer in the log" };
    if (row.status !== "pending") return { ok: false, message: `already ${row.status}` };
    await settle(id, "rejected", "declined");
    emitActions();
    return { ok: true, message: `Declined ${row.op}` };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

function safeStringify(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    // circular or otherwise unserialisable — keep the row, lose the detail
    return "{}";
  }
}

/* ── the file ─────────────────────────────────────────────────── */

/** Where the drop file lives, or "" when the project has no checkout. */
export function actionsPath(project: Project): string {
  const root = (project.local_path ?? "").trim().replace(/\/+$/, "");
  return root ? `${root}/${FILE}` : "";
}

const autoOps = OPERATIONS.filter((o) => !o.readOnly && o.effect === "auto").map((o) => o.name);
const proposeOps = OPERATIONS.filter((o) => o.effect === "propose").map((o) => o.name);

const EXAMPLE =
  '{"op":"hq_create_task","args":{"title":"Add a retry to the webhook sender","status":"todo"}}';

/**
 * The file's own first lines. Restored on every drain, because an agent that
 * opens an empty file learns nothing — and comment lines are inert, so putting
 * them back can never re-apply anything.
 */
const HEADER = [
  "# Spaces actions — append one JSON object per line to change the workspace.",
  "#",
  `#   ${EXAMPLE}`,
  "#",
  "# Spaces reads this file when your turn ends, records every line and empties it,",
  "# so a line takes effect exactly once. Never re-add one to make sure it took.",
  "# Blank lines and lines starting with # are ignored.",
  "#",
  `# Applies immediately: ${autoOps.join(", ")}`,
  `# Waits for a human:  ${proposeOps.join(", ")}`,
  "",
].join("\n");

/** Create the drop file if it isn't there yet. Best-effort; never throws. */
export async function ensureActionsFile(project: Project, root?: string): Promise<void> {
  const dir = (root ?? project.local_path ?? "").trim();
  if (!dir) return;
  try {
    const cur = await readFile(dir);
    if (cur.kind !== "missing") return;
    await invoke("write_text_file", { root: dir, relativePath: FILE, contents: HEADER });
  } catch {
    // a missing drop file just means this transport is unavailable here
  }
}

type FileState = { kind: "file"; text: string } | { kind: "missing" } | { kind: "unknown"; error: string };

async function readFile(root: string): Promise<FileState> {
  try {
    return { kind: "file", text: await invoke<string>("read_text_file", { root, relativePath: FILE }) };
  } catch (e) {
    // Only a definite "not there" is missing — a permissions error must not be
    // mistaken for an empty queue and then overwritten.
    return /no such file|not found|os error 2/i.test(String(e))
      ? { kind: "missing" }
      : { kind: "unknown", error: String(e) };
  }
}

/* ── the drain ────────────────────────────────────────────────── */

interface Dropped {
  raw: string;
  op: string;
  args: Record<string, unknown>;
  id?: string;
  error?: string;
}

function parseLine(raw: string): Dropped | null {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { raw: line, op: "", args: {}, error: `not JSON: ${String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { raw: line, op: "", args: {}, error: "each line must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  // `name` and `tool` are what a model reaches for when it thinks in tool
  // calls; accepting them costs a line and saves a whole class of failure.
  const opName = [obj.op, obj.name, obj.tool].find((v) => typeof v === "string" && v.trim());
  if (typeof opName !== "string" || !opName.trim()) {
    return { raw: line, op: "", args: {}, error: 'no "op" — e.g. {"op":"hq_create_task","args":{…}}' };
  }

  // Args may be nested under `args` or written flat alongside `op`. Both read
  // naturally, and rejecting the flat form would be pedantry.
  let args: Record<string, unknown>;
  if (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)) {
    args = obj.args as Record<string, unknown>;
  } else {
    const { op: _op, name: _name, tool: _tool, id: _id, args: _args, ...rest } = obj;
    args = rest;
  }

  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : undefined;
  return { raw: line, op: opName.trim(), args, id };
}

/**
 * Read the drop file, empty it, and act on what was in it. Never rejects.
 *
 * `roots` defaults to the project's own checkout; pass the run's cwd too when
 * the agent worked in an isolated worktree, whose `.hq/` is a different
 * directory from the project's and holds a different queue.
 */
export async function drainActions(
  projectId: string,
  ctx: DrainContext,
  roots?: string[]
): Promise<DrainReport> {
  const report: DrainReport = { applied: 0, pending: 0, failed: 0, deferred: 0, lines: [], errors: [] };
  try {
    const db = await getDb();
    const [project] = await db.select<Project[]>("SELECT * FROM projects WHERE id = $1", [projectId]);
    const candidates = (roots?.length ? roots : [project?.local_path ?? ""])
      .map((r) => (r ?? "").trim().replace(/\/+$/, ""))
      .filter(Boolean);
    const seen = new Set<string>();
    for (const root of candidates) {
      if (seen.has(root)) continue;
      seen.add(root);
      // Per root: one unreadable checkout must not hide another's queue.
      await drainOne(root, projectId, ctx, report).catch((e) => {
        report.errors.push(`${root}: ${String(e)}`);
      });
    }
  } catch (e) {
    report.errors.push(String(e));
  }
  return report;
}

async function drainOne(
  root: string,
  projectId: string,
  ctx: DrainContext,
  report: DrainReport
): Promise<void> {
  const file = await readFile(root);
  if (file.kind === "missing") return;
  if (file.kind === "unknown") {
    report.errors.push(`${root}/${FILE}: ${file.error}`);
    return;
  }

  const text = file.text;
  if (!text.trim()) return;

  const rawLines = text.split("\n");
  // A file being appended to right now can end mid-line. Keep that fragment:
  // parsing half an object would report a bogus failure and lose the action.
  let partial = text.endsWith("\n") ? "" : (rawLines.pop() ?? "");
  // Unless it is already whole. `printf` and some editors omit the final
  // newline, and valid JSON is never a strict prefix of a longer object — so a
  // fragment that parses is finished, and holding it back would strand it in
  // the file forever.
  if (partial.trim() && isWholeJson(partial)) {
    rawLines.push(partial);
    partial = "";
  }

  const taken: string[] = [];
  const left: string[] = [];
  let budget = MAX_PER_DRAIN;
  for (const line of rawLines) {
    const isAction = line.trim() && !line.trim().startsWith("#") && !line.trim().startsWith("//");
    if (!isAction) continue;
    if (budget > 0) {
      taken.push(line);
      budget--;
    } else {
      left.push(line);
    }
  }
  if (!taken.length && !left.length && !partial) {
    // Comments only. Nothing to do, and rewriting would only churn the file.
    return;
  }

  // Empty the file BEFORE anything runs. Everything after this point is at
  // worst lost; nothing after this point can be applied twice.
  //
  // The hazard is the gap between reading and rewriting: an MCP call appending
  // in that window would be erased unread. Appends never touch the prefix, so
  // re-reading immediately before the write and carrying forward anything that
  // grew past what we consumed recovers those lines. It narrows the window to
  // a single write rather than closing it — an atomic rename would close it,
  // and needs a Tauri command that does not exist yet.
  let appendedSince = "";
  try {
    const fresh = await readFile(root);
    if (fresh.kind === "file" && fresh.text.length > text.length && fresh.text.startsWith(text)) {
      appendedSince = fresh.text.slice(text.length);
    }
  } catch {
    // Unreadable on the second look: fall through and rewrite what we planned.
  }

  const rest = [...left, partial].filter(Boolean).join("\n");
  const carried = (rest ? `${rest}\n` : "") + appendedSince;
  try {
    await invoke("write_text_file", {
      root,
      relativePath: FILE,
      contents: carried ? `${HEADER}${carried}` : HEADER,
    });
  } catch (e) {
    report.errors.push(`could not empty ${root}/${FILE} — nothing applied: ${String(e)}`);
    return;
  }
  report.deferred += left.length + (partial.trim() ? 1 : 0);
  if (left.length) {
    report.errors.push(
      `${left.length} more line(s) left in ${FILE} — over the ${MAX_PER_DRAIN}-per-turn cap, they drain next time.`
    );
  }

  const opCtx: DrainContext = { ...ctx, projectId: ctx.projectId || projectId };
  for (const raw of taken) {
    const dropped = parseLine(raw);
    if (!dropped) continue;

    if (dropped.error) {
      report.failed++;
      report.lines.push(`[failed] ${clip(dropped.raw)} — ${dropped.error}`);
      continue;
    }

    // An id the agent chose is an idempotency key: if we already have that row,
    // the line is a re-send and must not become a second task.
    if (dropped.id) {
      const existing = await rowById(dropped.id).catch(() => null);
      if (existing) {
        report.failed++;
        report.lines.push(`[skipped] ${dropped.op} — id ${dropped.id} was already recorded`);
        continue;
      }
    }

    try {
      const { row, result } = await dispatchAction(dropped.op, dropped.args, opCtx, "file", dropped.id);
      if (row?.status === "pending") {
        report.pending++;
        report.lines.push(`[queued] ${dropped.op} — ${result.message}`);
      } else if (result.ok) {
        report.applied++;
        report.lines.push(`[applied] ${dropped.op} — ${result.message}`);
      } else {
        report.failed++;
        report.lines.push(`[failed] ${dropped.op} — ${result.message}`);
      }
    } catch (e) {
      report.failed++;
      report.lines.push(`[failed] ${dropped.op} — ${String(e)}`);
    }
  }
}

function isWholeJson(line: string): boolean {
  try {
    JSON.parse(line.trim());
    return true;
  } catch {
    return false;
  }
}

function clip(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/* ── what the agent is told ───────────────────────────────────── */

function opDoc(name: string): string[] {
  const op = OP_BY_NAME[name];
  if (!op) return [];
  const lines = [`#### \`${op.name}\``, "", op.describe, ""];
  for (const p of op.params) {
    const bits = [p.required ? "required" : "optional"];
    if (p.type === "enum" && p.choices?.length) bits.push(p.choices.join(" | "));
    lines.push(`- \`${p.name}\` (${bits.join("; ")}) — ${p.describe}`);
  }
  lines.push("");
  return lines;
}

function effectList(effect: Effect): string {
  return OPERATIONS.filter((o) => !o.readOnly && o.effect === effect)
    .map((o) => `\`${o.name}\``)
    .join(", ");
}

/**
 * The block blackboard.ts embeds so an agent working in the repo discovers it
 * has hands. Generated from the registry, so it cannot drift from what the
 * transports will actually accept.
 */
export const ACTIONS_DOC: string = [
  "## Changing Spaces from the shell",
  "",
  "You are a member of this workspace, not a bystander. You can file a task, connect",
  "two things, record a decision or put something on a calendar yourself — you do not",
  "have to describe the change in prose and hope a human copies it in.",
  "",
  "Append one JSON object per line to `.hq/actions.jsonl` in your working directory:",
  "",
  "```sh",
  `echo '${EXAMPLE}' >> ${FILE}`,
  "```",
  "",
  "Spaces reads that file as soon as your turn ends, records every line in its action log",
  "and empties the file, so each line takes effect **exactly once** — never re-add a",
  "line to make sure it took. Blank lines and `#` comments are ignored, and one bad",
  "line does not stop the others.",
  "",
  `**Applies immediately:** ${effectList("auto")}. Adding information is cheap to undo,`,
  "so it just happens.",
  "",
  `**Waits for a human:** ${effectList("propose")}. The line is still recorded and the`,
  "person sees it in Spaces's approval queue, but nothing changes until they accept it —",
  "removing or reassigning someone else's work is not yours to do unilaterally.",
  "",
  "Where an operation takes a reference to something, write it as `type:id` exactly as",
  "the `.hq/` files print it (e.g. `task:9f3c…`), or as the thing's exact title.",
  "",
  "### Operations",
  "",
  ...OPERATIONS.filter((o) => !o.readOnly).flatMap((o) => opDoc(o.name)),
  "This file is write-only: your turn is over by the time Spaces opens it, so nothing can",
  "be handed back to you. To read the workspace, open `.hq/CONTEXT.md`, `.hq/ROSTER.md`,",
  "`.hq/BOARD.md` and `.hq/LINKS.md`.",
].join("\n");
