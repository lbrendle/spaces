import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import { getDb } from "../db";
import type { Agent, EntityRef, Project, Run } from "../types";
import {
  branchState,
  commits,
  isCheckpoint,
  lastFetch,
  localOnlyShas,
  remoteUrl,
  shortSha,
  unpushed,
  worktrees,
} from "../gitlog";
import type { BranchState, Commit, RemoteUrlResult, UnpushedResult } from "../gitlog";
import { runDiff } from "../gitflow";
import { branchName, git } from "../workspaces";
import { connectionsFor } from "../links";
import { repoPRs, timeAgo } from "../github";
import type { RepoPR } from "../github";
import { Avatar, Spinner } from "./ui";
import { EntityChip } from "./EntityChip";
import { RunDiff } from "./RunDiff";
import { IconBranch, IconCheck, IconGitHub, IconInfo } from "./icons";
import "./gitactivity.css";

/**
 * Git Activity — what changed, who changed it, and is it landed.
 *
 * One place that merges the main checkout and every agent worktree into a
 * single time-ordered history, draws the branch topology beside it, says
 * plainly whether any of it has left this machine, and carries the story on to
 * open PRs. It never mutates git state: commit / push / merge / discard all
 * live in Workspaces.
 *
 * The history itself comes from gitlog.ts and gitflow.ts — this file owns the
 * reading of it, not the running of it. Two things those modules don't expose
 * (a commit's parents, and whether a checkout is dirty) are read here with the
 * same `git()` primitive they are built on, because the topology and the
 * "is it landed" answer are questions this view invented.
 */

const PER_CHECKOUT = 40;
const UNPUSHED_LIMIT = 50;
const INITIAL_ROWS = 25;
/** Rows are a fixed height so the SVG lane diagram can line up with them. */
const ROW_H = 34;
const LANE_W = 13;
/** Past this the diagram stops being readable, so extra branches share a lane. */
const MAX_LANES = 7;
const PARENT_SCAN = 400;
/** Probing every worktree costs two git calls each; bound it. */
const PROBE_CHECKOUTS = 8;
const RUN_RANGE_LOOKUPS = 24;
const SPARK_DAYS = 30;
const TOP_AUTHORS = 6;
const DETAIL_DIFF_LINES = 400;

/** Lane colours, in theme tokens — never literals. */
const LANE_TONES = [
  "var(--accent)",
  "var(--blue)",
  "var(--purple)",
  "var(--cyan)",
  "var(--orange)",
  "var(--green)",
  "var(--yellow)",
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ── model ───────────────────────────────────────────────────── */

/** The Spaces run a commit came out of, flattened to what the UI renders. */
interface RunLink {
  runId: string;
  agentId: string;
  channelId: string;
  taskId: string;
  prompt: string;
  status: Run["status"];
  startedAt: number;
}

interface ActivityRow extends Commit {
  /** Display label for the checkout this commit was found on. */
  branch: string;
  /** Agent whose workspace branch this is, when the branch is hq/<agent>. */
  agentId: string;
  localOnly: boolean;
  checkpoint: boolean;
  isMain: boolean;
  /** Parent shas, empty when git wouldn't say (the graph then falls back). */
  parents: string[];
  /** The agent run that produced this commit, when Spaces recorded one. */
  run: RunLink | null;
}

/** One checkout — the main one or an agent worktree — and how landed it is. */
interface CheckoutState {
  path: string;
  label: string;
  agentId: string;
  isMain: boolean;
  ahead: number;
  aheadCapped: boolean;
  behind: number;
  behindCapped: boolean;
  /** Uncommitted files, or -1 when git wouldn't say. */
  dirty: number;
  /** What ahead/behind are measured against, for the tooltip. */
  compare: string;
  lastAt: number;
}

interface ProjectGit {
  state: BranchState;
  push: UnpushedResult;
  remote: RemoteUrlResult;
  rows: ActivityRow[];
  fetchedAt: number | null;
  /** Probed checkouts — capped, so this can be shorter than `checkoutCount`. */
  checkouts: CheckoutState[];
  checkoutCount: number;
  /** The branch everything else is measured against. */
  integration: string;
  /** Non-fatal degradations worth mentioning without failing the card. */
  notes: string[];
  truncated: boolean;
}

/* ── data load ───────────────────────────────────────────────── */

/** `git status --porcelain`, as a count. -1 means git wouldn't say. */
async function dirtyCount(dir: string): Promise<number> {
  try {
    const out = await git(dir, "status", "--porcelain");
    return out.split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return -1;
  }
}

/**
 * sha → parent shas, for the lane diagram.
 *
 * gitlog.ts's log format doesn't carry %P and it isn't this view's file to
 * change, so the topology read lives here. Failure is survivable: the graph
 * falls back to chaining each branch's own commits.
 */
async function readParents(dir: string, heads: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!heads.length) return map;
  try {
    const out = await git(dir, "log", "--pretty=format:%H %P", "-n", String(PARENT_SCAN), ...heads);
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      map.set(parts[0], parts.slice(1));
    }
  } catch {
    // no parents — layoutGraph chains by branch instead
  }
  return map;
}

function toRunLink(r: Run): RunLink {
  return {
    runId: r.id,
    agentId: r.agent_id,
    channelId: r.channel_id,
    taskId: r.task_id,
    prompt: r.prompt,
    status: r.status,
    startedAt: r.started_at,
  };
}

/**
 * Which commits an agent run is answerable for.
 *
 * A run records the HEAD before it started and the sha of the checkpoint it
 * left behind, so `commit_after` attributes exactly. An agent that ran
 * `git commit` itself leaves several commits between the two checkpoints —
 * those are expanded too, but only for runs already visible in the list, so
 * the extra git calls stay bounded.
 */
async function loadRunLinks(dir: string, shas: Set<string>): Promise<Map<string, RunLink>> {
  const map = new Map<string, RunLink>();
  if (!shas.size) return map;
  try {
    const db = await getDb();
    const runs = await db.select<Run[]>(
      "SELECT * FROM runs WHERE commit_after != '' ORDER BY started_at DESC LIMIT 400"
    );
    const ranged: Run[] = [];
    for (const r of runs) {
      if (!shas.has(r.commit_after) || map.has(r.commit_after)) continue;
      map.set(r.commit_after, toRunLink(r));
      if (r.commit_before && r.commit_before !== r.commit_after && ranged.length < RUN_RANGE_LOOKUPS) {
        ranged.push(r);
      }
    }
    await Promise.all(
      ranged.map(async (r) => {
        const res = await commits(dir, PER_CHECKOUT, [`${r.commit_before}..${r.commit_after}`]);
        for (const c of res.commits) {
          if (shas.has(c.sha) && !map.has(c.sha)) map.set(c.sha, toRunLink(r));
        }
      })
    );
  } catch {
    // attribution is an enrichment; a missing runs table must not empty the view
  }
  return map;
}

function emptyPush(state: BranchState): UnpushedResult {
  return {
    kind: "unknown",
    count: 0,
    commits: [],
    branch: "",
    upstream: "",
    behind: 0,
    headline: "Not a git repository",
    detail: "",
    error: state.error,
  };
}

async function loadProjectGit(
  project: Project,
  agents: Agent[],
  pathFilter: string
): Promise<ProjectGit> {
  const dir = project.local_path;
  const state = await branchState(dir);

  if (!state.isRepo) {
    return {
      state,
      push: emptyPush(state),
      remote: { name: "", url: "", webUrl: "", error: "" },
      rows: [],
      fetchedAt: null,
      checkouts: [],
      checkoutCount: 0,
      integration: "",
      notes: [],
      truncated: false,
    };
  }

  const [push, wts, remote, fetched] = await Promise.all([
    unpushed(dir, UNPUSHED_LIMIT, state),
    worktrees(dir, state),
    remoteUrl(dir),
    lastFetch(dir),
  ]);

  const notes: string[] = [];
  if (wts.error) {
    notes.push(`Couldn't list worktrees (${wts.error}) — showing the main checkout only.`);
  }

  // All worktrees share one object store, so every log below can run from the
  // main checkout — no need to walk into each workspace directory. A detached
  // worktree is on no branch, so its head has to be named explicitly or its
  // commits would be misreported as already pushed.
  const detachedHeads = wts.worktrees.filter((w) => w.detached && w.head).map((w) => w.head);
  const local = state.hasRemote
    ? await localOnlyShas(dir, 500, detachedHeads)
    : { shas: new Set<string>(), error: "" };
  if (local.error) notes.push(`Couldn't determine which commits are unpushed (${local.error}).`);

  const agentByBranch = new Map(agents.map((a) => [branchName(a), a.id]));
  // A pathspec turns the whole view into "history that touched this path" —
  // git does the filtering, which is the only way to filter on files we never
  // loaded.
  const paths = pathFilter ? ["--", pathFilter] : [];

  const logCheckouts = (spec: string[]) =>
    Promise.all(
      wts.worktrees.map(async (w) => {
        const blank = { w, list: [] as Commit[], ranged: false, error: "" };
        if (w.bare || !w.head) return blank;
        // A worktree sitting on the same commit as main has nothing of its own.
        if (!w.isMain && w.head === state.head) return blank;
        // For an agent worktree, only what it added on top of the main checkout —
        // shared history already shows up under the main checkout's own row set.
        const useRange = !w.isMain && state.head !== "";
        let ranged = useRange;
        let res = await commits(
          dir,
          PER_CHECKOUT,
          useRange ? [`${state.head}..${w.head}`, ...spec] : [w.head, ...spec]
        );
        if (res.error && useRange) {
          ranged = false;
          res = await commits(dir, PER_CHECKOUT, [w.head, ...spec]);
        }
        return { w, list: res.commits, ranged, error: res.error };
      })
    );

  const logs = await logCheckouts(paths);
  // "How far from landed is this branch" is not a question about one path, so
  // a path filter narrows the list without touching the landed answer below.
  const full = paths.length ? await logCheckouts([]) : logs;

  const rows: ActivityRow[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const { w, list, error } of logs) {
    if (error) notes.push(`${basename(w.path)}: ${error}`);
    if (list.length === PER_CHECKOUT) truncated = true;
    const label = w.branch || (w.detached ? `detached @ ${shortSha(w.head)}` : basename(w.path));
    for (const c of list) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      rows.push({
        ...c,
        branch: label,
        agentId: agentByBranch.get(w.branch) ?? "",
        // Only meaningful when a remote exists. With no remote the headline
        // already says everything is local, so per-row badges would be noise.
        localOnly: state.hasRemote && local.shas.has(c.sha),
        checkpoint: isCheckpoint(c.subject),
        isMain: w.isMain,
        parents: [],
        run: null,
      });
    }
  }
  rows.sort((a, b) => b.at - a.at);

  const heads = [...new Set(wts.worktrees.map((w) => w.head).filter(Boolean))];
  const [parents, runLinks] = await Promise.all([readParents(dir, heads), loadRunLinks(dir, seen)]);
  for (const row of rows) {
    row.parents = parents.get(row.sha) ?? [];
    row.run = runLinks.get(row.sha) ?? null;
  }

  const lastByPath = new Map<string, number>();
  for (const { w, list } of full) {
    if (list.length) lastByPath.set(w.path, list[0].at);
  }

  const integration = state.branch || (state.head ? `detached @ ${shortSha(state.head)}` : "HEAD");
  const probes = full.filter(({ w }) => !w.bare).slice(0, PROBE_CHECKOUTS);
  const checkouts = await Promise.all(
    probes.map(async ({ w, list, ranged }) => {
      const label = w.branch || (w.detached ? `detached @ ${shortSha(w.head)}` : basename(w.path));
      const base: CheckoutState = {
        path: w.path,
        label,
        agentId: agentByBranch.get(w.branch) ?? "",
        isMain: w.isMain,
        ahead: 0,
        aheadCapped: false,
        behind: 0,
        behindCapped: false,
        dirty: await dirtyCount(w.path),
        compare: w.isMain ? state.upstream || "" : integration,
        lastAt: lastByPath.get(w.path) ?? 0,
      };
      if (w.isMain) return { ...base, ahead: state.ahead, behind: state.behind };
      if (!w.head || !state.head || w.head === state.head) return base;
      // The range log above already *is* the ahead set, so only behind costs
      // an extra call. Both are capped, and say so.
      const behind = await commits(dir, PER_CHECKOUT, [`${w.head}..${state.head}`]);
      return {
        ...base,
        ahead: ranged ? list.length : 0,
        aheadCapped: ranged && list.length === PER_CHECKOUT,
        behind: behind.commits.length,
        behindCapped: behind.commits.length === PER_CHECKOUT,
      };
    })
  );

  return {
    state,
    push,
    remote,
    rows,
    fetchedAt: fetched.at,
    checkouts,
    checkoutCount: wts.worktrees.length,
    integration,
    notes,
    truncated,
  };
}

/* ── filtering ───────────────────────────────────────────────── */

interface Filters {
  q: string;
  /** "agent:<id>" or "git:<name>", "" for everyone. */
  author: string;
  branch: string;
  /** yyyy-mm-dd, inclusive on both ends. */
  from: string;
  to: string;
  /** Pathspec — applied by git, so changing it re-reads history. */
  path: string;
  agentOnly: boolean;
  unpushedOnly: boolean;
}

const NO_FILTERS: Filters = {
  q: "",
  author: "",
  branch: "",
  from: "",
  to: "",
  path: "",
  agentOnly: false,
  unpushedOnly: false,
};

function anyFilter(f: Filters): boolean {
  return (
    f.q !== "" ||
    f.author !== "" ||
    f.branch !== "" ||
    f.from !== "" ||
    f.to !== "" ||
    f.path !== "" ||
    f.agentOnly ||
    f.unpushedOnly
  );
}

/** yyyy-mm-dd → local midnight. Built by hand: Date.parse would read it as UTC. */
function dayStart(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function dayEnd(iso: string): number {
  const start = dayStart(iso);
  if (Number.isNaN(start)) return NaN;
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

function isoDay(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Who a commit is attributed to: the run's agent first, then the branch's. */
function rowAgentId(row: ActivityRow): string {
  return row.run?.agentId || row.agentId;
}

function authorKey(row: ActivityRow): string {
  const agent = rowAgentId(row);
  return agent ? `agent:${agent}` : `git:${row.author || "unknown"}`;
}

/** A commit Spaces can say an agent produced, rather than just a git author name. */
function fromAgentRun(row: ActivityRow): boolean {
  // Checkpoints count even when their run row is gone: "hq: " commits are only
  // ever written by a run, and channel deletion takes the run rows with it.
  return row.run !== null || row.checkpoint;
}

function matches(row: ActivityRow, f: Filters, agentName: (id: string) => string): boolean {
  if (f.agentOnly && !fromAgentRun(row)) return false;
  if (f.unpushedOnly && !row.localOnly) return false;
  if (f.branch && row.branch !== f.branch) return false;
  if (f.author && authorKey(row) !== f.author) return false;
  if (f.from) {
    const from = dayStart(f.from);
    if (!Number.isNaN(from) && row.at < from) return false;
  }
  if (f.to) {
    const to = dayEnd(f.to);
    if (!Number.isNaN(to) && row.at > to) return false;
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = `${row.subject} ${row.sha} ${row.author} ${row.branch} ${agentName(rowAgentId(row))}`;
    if (!hay.toLowerCase().includes(q)) return false;
  }
  return true;
}

/* ── lane diagram ────────────────────────────────────────────── */

interface GraphRow {
  lane: number;
  /** Lanes drawn straight through, top edge to bottom edge. */
  through: number[];
  /** Lanes arriving at the top that end at this commit — a merge. */
  merges: number[];
  /** Lanes leaving the bottom from this commit; the first continues its lane. */
  splits: number[];
  /** True when a line comes into the dot from the row above. */
  fromAbove: boolean;
  /** True when an edge here skips commits the filter hid. */
  elided: boolean;
}

/**
 * Turn a time-ordered commit list into lanes.
 *
 * Standard newest-first sweep: each lane holds the sha it is waiting for, a
 * commit claims the lane that wanted it, and its parents take the lane on
 * (first parent) or open one (a merge's later parents). Parents the filter
 * hid are resolved through to the nearest visible ancestor so a filtered list
 * still draws as one connected history — those edges are marked `elided` and
 * drawn dashed, because they are a summary, not a real single step.
 *
 * `all` is every loaded commit, filtered or not: walking *through* a hidden
 * commit needs its parents, which is exactly what `rows` no longer has.
 */
function layoutGraph(
  rows: ActivityRow[],
  all: ActivityRow[] = rows
): { graph: GraphRow[]; lanes: number } {
  const visible = new Set(rows.map((r) => r.sha));
  const parentsOf = new Map<string, string[]>();
  for (const r of all) parentsOf.set(r.sha, r.parents);

  // Rows whose parents git didn't give us chain to the next older commit on
  // their own branch: a plain ladder is a better lie than a field of dots.
  const olderOnBranch = new Map<string, string>();
  const lastSeen = new Map<string, ActivityRow>();
  for (const r of rows) {
    const prev = lastSeen.get(r.branch);
    if (prev) olderOnBranch.set(prev.sha, r.sha);
    lastSeen.set(r.branch, r);
  }

  const memo = new Map<string, string | null>();
  const resolve = (sha: string, depth = 0): string | null => {
    if (visible.has(sha)) return sha;
    if (memo.has(sha)) return memo.get(sha) ?? null;
    if (depth > 250) return null;
    let found: string | null = null;
    for (const p of parentsOf.get(sha) ?? []) {
      found = resolve(p, depth + 1);
      if (found) break;
    }
    memo.set(sha, found);
    return found;
  };

  const active: (string | null)[] = [];
  const free = () => {
    const i = active.indexOf(null);
    if (i >= 0) return i;
    if (active.length < MAX_LANES) {
      active.push(null);
      return active.length - 1;
    }
    return MAX_LANES - 1; // past the cap, extra branches share the last lane
  };

  const graph: GraphRow[] = [];
  let lanes = 1;

  for (const row of rows) {
    let lane = active.indexOf(row.sha);
    const fromAbove = lane >= 0;
    if (!fromAbove) lane = free();

    const merges: number[] = [];
    for (let j = 0; j < active.length; j++) {
      if (j !== lane && active[j] === row.sha) {
        merges.push(j);
        active[j] = null;
      }
    }
    const through: number[] = [];
    for (let j = 0; j < active.length; j++) {
      if (j !== lane && active[j]) through.push(j);
    }

    const raw = parentsOf.get(row.sha) ?? [];
    const declared = raw.length ? raw : [olderOnBranch.get(row.sha) ?? ""].filter(Boolean);
    let elided = false;
    const targets: string[] = [];
    for (const p of declared) {
      const t = resolve(p);
      if (!t || targets.includes(t)) continue;
      if (t !== p) elided = true;
      targets.push(t);
    }

    active[lane] = null;
    const splits: number[] = [];
    targets.forEach((t, k) => {
      if (k === 0) {
        active[lane] = t;
        splits.push(lane);
        return;
      }
      let j = active.indexOf(t);
      if (j < 0) {
        j = free();
        active[j] = t;
      }
      if (!splits.includes(j)) splits.push(j);
    });

    graph.push({ lane, through, merges, splits, fromAbove, elided });
    lanes = Math.max(lanes, lane + 1, ...through.map((j) => j + 1), ...splits.map((j) => j + 1));
    while (active.length && active[active.length - 1] === null) active.pop();
  }

  return { graph, lanes: Math.min(lanes, MAX_LANES) };
}

const laneX = (i: number) => 7 + i * LANE_W;
const laneTone = (i: number) => LANE_TONES[i % LANE_TONES.length];
/** S-curve between two lanes; flat ends so it meets straight lines cleanly. */
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

function GraphCell({
  g,
  lanes,
  row,
  selected,
}: {
  g: GraphRow;
  lanes: number;
  row: ActivityRow;
  selected: boolean;
}) {
  const width = laneX(lanes - 1) + 7;
  const mid = ROW_H / 2;
  const x = laneX(g.lane);
  const dash = g.elided ? "3 3" : undefined;

  return (
    <svg
      className="ga-graph"
      width={width}
      height={ROW_H}
      viewBox={`0 0 ${width} ${ROW_H}`}
      aria-hidden="true"
      focusable="false"
    >
      {g.through.map((j) => (
        <line
          key={`t${j}`}
          className="ga-edge"
          style={{ color: laneTone(j) }}
          x1={laneX(j)}
          y1={0}
          x2={laneX(j)}
          y2={ROW_H}
        />
      ))}
      {g.fromAbove && (
        <line className="ga-edge" style={{ color: laneTone(g.lane) }} x1={x} y1={0} x2={x} y2={mid} />
      )}
      {g.merges.map((j) => (
        <path
          key={`m${j}`}
          className="ga-edge"
          style={{ color: laneTone(j) }}
          d={curve(laneX(j), 0, x, mid)}
          fill="none"
        />
      ))}
      {g.splits.map((j) =>
        j === g.lane ? (
          <line
            key={`s${j}`}
            className="ga-edge"
            style={{ color: laneTone(j) }}
            strokeDasharray={dash}
            x1={x}
            y1={mid}
            x2={x}
            y2={ROW_H}
          />
        ) : (
          <path
            key={`s${j}`}
            className="ga-edge"
            style={{ color: laneTone(j) }}
            strokeDasharray={dash}
            d={curve(x, mid, laneX(j), ROW_H)}
            fill="none"
          />
        )
      )}
      <g style={{ color: laneTone(g.lane) }}>
        {selected && <circle className="ga-dot-halo" cx={x} cy={mid} r={6.5} />}
        {fromAgentRun(row) && <circle className="ga-dot-ring" cx={x} cy={mid} r={5.6} fill="none" />}
        {/* Hollow means "on this machine only" — the same story the badge tells. */}
        <circle
          className={"ga-dot" + (row.localOnly ? " local" : "")}
          cx={x}
          cy={mid}
          r={3.5}
        />
      </g>
    </svg>
  );
}

/* ── entity chips: what a commit is connected to ─────────────── */

const GH_REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const BARE_REF = /(?:^|\s)#(\d+)\b/g;

function refKeyOf(r: EntityRef): string {
  return `${r.type}:${r.id}`;
}

/**
 * The tasks and pull requests a commit relates to.
 *
 * Three routes, all of them things the user or Spaces actually recorded: the run's
 * own task, the links graph hanging off that run's message and task, and
 * GitHub refs in the subject or a PR opened from this exact branch.
 */
function relatedRefs(
  row: ActivityRow,
  repo: string,
  prByBranch: Map<string, RepoPR>
): EntityRef[] {
  const out: EntityRef[] = [];
  const seen = new Set<string>();
  const add = (ref: EntityRef) => {
    const key = refKeyOf(ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };

  if (row.run?.taskId) add({ type: "task", id: row.run.taskId });

  if (row.run) {
    // run.id is the agent's reply message id, so anything auto-linked out of
    // that reply (owner/repo#12, [[memory]], #channel) hangs off it.
    for (const anchor of [
      { type: "message", id: row.run.runId } as EntityRef,
      ...(row.run.taskId ? [{ type: "task", id: row.run.taskId } as EntityRef] : []),
    ]) {
      for (const c of connectionsFor(anchor)) {
        if (c.other.type === "pr" || c.other.type === "issue" || c.other.type === "task") {
          add(c.other);
        }
      }
    }
  }

  const pr = prByBranch.get(row.branch);
  if (pr && repo) add({ type: "pr", id: `${repo}#${pr.number}` });

  for (const m of row.subject.matchAll(GH_REF)) add({ type: "pr", id: `${m[1]}#${m[2]}` });
  if (repo) for (const m of row.subject.matchAll(BARE_REF)) add({ type: "pr", id: `${repo}#${m[1]}` });

  return out;
}

/* ── pane ────────────────────────────────────────────────────── */

export function GitActivity() {
  const projects = useStore((s) => s.projects);
  const withPath = projects.filter((p) => p.local_path.trim() !== "");
  const [tick, setTick] = useState(0);

  return (
    // ga-root carries --ga-row-h, which CSS and ROW_H above have to agree on.
    <div className="main-pane scroll-pane ga-root">
      <div className="pane-header">
        <div>
          <div className="pane-title">Git activity</div>
          {/* The first clause described the table directly beneath it, column
            * by column. What is left is the part the table cannot say: that
            * nothing here acts, and where the actions are. */}
          <div className="pane-sub">Read-only — commit, push and merge live in Workspaces.</div>
        </div>
        <button className="btn" onClick={() => setTick((t) => t + 1)}>
          <IconRefresh /> Refresh
        </button>
      </div>

      {!withPath.length ? (
        <div className="center-note">
          <div>
            <strong>No local checkouts yet.</strong>
            <br />
            Set a project&apos;s local path in its settings — once agents commit there, every
            commit, branch and push shows up here.
          </div>
        </div>
      ) : (
        <div className="dash-body">
          {withPath.map((p) => (
            <ProjectGitCard key={p.id} project={p} tick={tick} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── one project ─────────────────────────────────────────────── */

function ProjectGitCard({ project, tick }: { project: Project; tick: number }) {
  const agents = useStore((s) => s.agents);
  const links = useStore((s) => s.links);
  const [data, setData] = useState<ProjectGit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState("");
  const [diffRunId, setDiffRunId] = useState("");
  const [prs, setPRs] = useState<RepoPR[] | null>(null);
  const [prError, setPRError] = useState("");
  // Monotonic token: a slow earlier load must not overwrite a newer one.
  const req = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const token = ++req.current;
    setLoading(true);
    setError("");
    try {
      const next = await loadProjectGit(project, agents, filters.path);
      if (token === req.current) setData(next);
    } catch (e) {
      // loadProjectGit is built from non-throwing helpers; this is belt and braces.
      if (token === req.current) setError(errText(e));
    } finally {
      if (token === req.current) setLoading(false);
    }
  }, [project, agents, filters.path]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    setExpanded(false);
    setSelected("");
  }, [project.id, tick]);

  // Typing a path re-reads git, so it waits for a pause in the typing.
  useEffect(() => {
    const wanted = pathInput.trim();
    const t = window.setTimeout(() => {
      setFilters((f) => (f.path === wanted ? f : { ...f, path: wanted }));
    }, 400);
    return () => window.clearTimeout(t);
  }, [pathInput]);

  useEffect(() => {
    if (!project.repo) {
      setPRs(null);
      setPRError("");
      return;
    }
    let alive = true;
    setPRs(null);
    setPRError("");
    repoPRs(project.repo)
      .then((list) => {
        if (alive) setPRs(list);
      })
      .catch((e) => {
        if (!alive) return;
        setPRs([]);
        setPRError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [project.repo, tick]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const agentName = useCallback(
    (id: string) => (id ? agents.find((a) => a.id === id)?.name ?? "" : ""),
    [agents]
  );

  // Faceted: the author list is built from everything *except* the author
  // filter, so picking one author never hides the others.
  const beforeAuthor = useMemo(
    () => rows.filter((r) => matches(r, { ...filters, author: "" }, agentName)),
    [rows, filters, agentName]
  );
  const filtered = useMemo(
    () => (filters.author ? beforeAuthor.filter((r) => authorKey(r) === filters.author) : beforeAuthor),
    [beforeAuthor, filters.author]
  );
  const shown = useMemo(
    () => (expanded ? filtered : filtered.slice(0, INITIAL_ROWS)),
    [filtered, expanded]
  );
  const { graph, lanes } = useMemo(() => layoutGraph(shown, rows), [shown, rows]);

  const prByBranch = useMemo(
    () => new Map((prs ?? []).map((p) => [p.headRefName, p] as const)),
    [prs]
  );
  const related = useMemo(() => {
    const map = new Map<string, EntityRef[]>();
    for (const row of shown) map.set(row.sha, relatedRefs(row, project.repo, prByBranch));
    return map;
    // `links` is read through connectionsFor, so it belongs in the deps.
  }, [shown, project.repo, prByBranch, links]);

  const selectedRow = useMemo(
    () => filtered.find((r) => r.sha === selected) ?? null,
    [filtered, selected]
  );
  const selectedRelated = useMemo(
    () => (selectedRow ? relatedRefs(selectedRow, project.repo, prByBranch) : []),
    [selectedRow, project.repo, prByBranch, links]
  );

  // Arrow keys walk the list; each row is a real button, so Tab still works.
  const onListKey = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(".ga-row-main") ?? []
    );
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = buttons[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }, []);

  const clearFilters = useCallback(() => {
    setPathInput("");
    setFilters(NO_FILTERS);
  }, []);

  return (
    <section className="dash-card">
      <h3>
        {project.name}
        {project.repo && <span className="chip repo-chip">{project.repo}</span>}
        {loading && <Spinner />}
      </h3>

      {error && <div className="banner warn ga-note">{error}</div>}

      {!data && loading && <LoadingSkeleton />}

      {data && !data.state.isRepo && <NotARepo project={project} state={data.state} />}

      {data?.state.isRepo && (
        <>
          <Headline push={data.push} />
          <LandedStrip data={data} agents={agents} />
          <MetaRow data={data} />
          {data.notes.map((n, i) => (
            <div key={i} className="banner warn ga-note">
              {n}
            </div>
          ))}

          <div className="ga-section-label">
            Activity
            {rows.length > 0 && (
              // "3 of 10" only when something is actually hidden — a path
              // filter narrows the load itself, so its result is the whole set.
              <span className="ga-count">
                {filtered.length === rows.length
                  ? rows.length
                  : `${filtered.length} of ${rows.length}`}
              </span>
            )}
            {loading && <span className="ga-count">refreshing…</span>}
          </div>

          <FilterBar
            filters={filters}
            setFilters={setFilters}
            pathInput={pathInput}
            setPathInput={setPathInput}
            rows={rows}
            agents={agents}
            onClear={clearFilters}
          />

          {rows.length > 0 && (
            <div className="ga-facets">
              <DayBars
                rows={filtered}
                selectedDay={filters.from && filters.from === filters.to ? filters.from : ""}
                onPickDay={(iso) =>
                  setFilters((f) =>
                    f.from === iso && f.to === iso
                      ? { ...f, from: "", to: "" }
                      : { ...f, from: iso, to: iso }
                  )
                }
              />
              <AuthorFacet
                rows={beforeAuthor}
                agents={agents}
                active={filters.author}
                onPick={(key) =>
                  setFilters((f) => ({ ...f, author: f.author === key ? "" : key }))
                }
              />
            </div>
          )}

          {!rows.length ? (
            <div className="nav-empty">
              {filters.path
                ? `No commits touched ${filters.path}.`
                : data.state.noCommits
                  ? "No commits yet in this repository."
                  : "No commits found in this checkout."}
            </div>
          ) : !filtered.length ? (
            <div className="nav-empty ga-empty-filtered">
              No commits match these filters.
              <button className="btn tiny" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="ga-work">
              <div className="ga-list" ref={listRef} onKeyDown={onListKey}>
                {shown.map((row, i) => (
                  <CommitRow
                    key={row.sha + row.branch}
                    row={row}
                    graph={graph[i]}
                    lanes={lanes}
                    agents={agents}
                    related={related.get(row.sha) ?? []}
                    selected={row.sha === selected}
                    onSelect={() => setSelected((s) => (s === row.sha ? "" : row.sha))}
                  />
                ))}
              </div>

              <CommitDetail
                dir={project.local_path}
                row={selectedRow}
                agents={agents}
                related={selectedRelated}
                webUrl={data.remote.webUrl}
                onOpenRunDiff={setDiffRunId}
                onClose={() => setSelected("")}
              />
            </div>
          )}

          {filtered.length > INITIAL_ROWS && (
            <button className="btn tiny ga-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : `Show all ${filtered.length}`}
            </button>
          )}
          {data.truncated && (expanded || filtered.length <= INITIAL_ROWS) && (
            <div className="ga-hint">
              Showing the most recent {PER_CHECKOUT} commits per checkout — older history lives in
              your git client.
            </div>
          )}
        </>
      )}

      {project.repo && <ProjectPRs prs={prs} error={prError} repo={project.repo} />}

      {diffRunId && <RunDiff runId={diffRunId} onClose={() => setDiffRunId("")} />}
    </section>
  );
}

/* ── loading and failure ─────────────────────────────────────── */

/**
 * Skeleton rows rather than a spinner: the shape of the answer is already
 * known, so the card shouldn't jump when it arrives.
 */
function LoadingSkeleton() {
  return (
    <div className="ga-skeleton" aria-hidden="true">
      <div className="sk-block sk-headline" />
      <div className="sk-tiles">
        <div className="sk-block sk-tile" />
        <div className="sk-block sk-tile" />
        <div className="sk-block sk-tile" />
      </div>
      <div className="sk-rows">
        {[0.82, 0.64, 0.9, 0.5, 0.73, 0.6].map((w, i) => (
          <div className="sk-row" key={i}>
            <span className="sk-block sk-dot" />
            <span className="sk-block sk-sha" />
            <span className="sk-block sk-subject" style={{ width: `${w * 100}%` }} />
            <span className="sk-block sk-when" />
          </div>
        ))}
      </div>
      <span className="ga-sr">Reading git history…</span>
    </div>
  );
}

/** git's stderr, read for the two failures a person can actually act on. */
function repoTrouble(error: string): { title: string; body: string; hint: string } {
  const e = error.toLowerCase();
  if (/not found|no such file or directory.*git|enoent|program not found|failed to (run|spawn)/.test(e)) {
    return {
      title: "git isn't available",
      body: "Spaces couldn't run git at all, so no history can be read here.",
      hint: "Install git (on macOS, xcode-select --install) and reopen Spaces.",
    };
  }
  if (/no such file|does not exist|cannot find the path|not a directory/.test(e)) {
    return {
      title: "That folder isn't there",
      body: "The project's local path doesn't point at a directory on this machine.",
      hint: "Fix the local path in the project's settings.",
    };
  }
  return {
    title: "Not a git repository",
    body: "Nothing in this folder is version controlled, so there is no history to show — and nothing here can reach GitHub.",
    hint: "Run git init in it, or point the project at the checkout you actually work in.",
  };
}

function NotARepo({ project, state }: { project: Project; state: BranchState }) {
  const t = repoTrouble(state.error);
  return (
    <div className="ga-error">
      <span className="ga-error-icon">
        <IconInfo size={17} />
      </span>
      <div>
        <div className="ga-error-title">{t.title}</div>
        <div className="ga-error-body">
          {t.body}
          <div className="ga-error-path">
            <code>{project.local_path}</code>
          </div>
        </div>
        <div className="ga-error-hint">{t.hint}</div>
        {state.error && <div className="ga-note-detail">{state.error}</div>}
      </div>
    </div>
  );
}

/* ── headline: has anything left this machine? ───────────────── */

function headlineTone(kind: UnpushedResult["kind"]): string {
  if (kind === "unpushed" || kind === "never-pushed") return "pending";
  if (kind === "in-sync") return "synced";
  if (kind === "no-remote") return "local";
  return "neutral";
}

function Headline({ push }: { push: UnpushedResult }) {
  const tone = headlineTone(push.kind);
  const icon =
    tone === "synced" ? <IconCheck size={17} /> : tone === "pending" ? <IconBranch size={17} /> : <IconInfo size={17} />;
  return (
    <div className={"ga-headline " + tone}>
      <span className="ga-headline-icon">{icon}</span>
      <div className="ga-headline-body">
        <div className="ga-headline-main">{push.headline}</div>
        {push.detail && <div className="ga-headline-sub">{push.detail}</div>}
      </div>
    </div>
  );
}

/* ── landed state: ahead / behind / uncommitted ──────────────── */

function countCell(n: number, capped: boolean, tone: string) {
  if (n <= 0) return <span className="ga-num zero">0</span>;
  return (
    <span className={"ga-num " + tone}>
      {n}
      {capped ? "+" : ""}
    </span>
  );
}

function LandedStrip({ data, agents }: { data: ProjectGit; agents: Agent[] }) {
  const { checkouts, integration, state } = data;
  const dirtyTotal = checkouts.reduce((n, c) => n + Math.max(0, c.dirty), 0);
  const dirtyWhere = checkouts.filter((c) => c.dirty > 0).length;
  const aheadTotal = checkouts.reduce((n, c) => n + c.ahead, 0);

  return (
    <div className="ga-landed">
      <div className="ga-tiles">
        <div
          className="ga-tile"
          title="Commits an agent worktree has added on top of the integration branch, plus commits the main checkout hasn't pushed"
        >
          <span className="ga-tile-label">Unlanded work</span>
          <span className="ga-tile-value">
            {aheadTotal === 0 ? "all landed" : plural(aheadTotal, "commit")}
          </span>
          <span className="ga-tile-sub">
            not in {integration || "HEAD"} or on its remote
          </span>
        </div>
        <div
          className="ga-tile"
          title={
            state.upstream
              ? `${state.upstream} has commits the main checkout doesn't`
              : "This branch tracks nothing, so there is nothing to be behind"
          }
        >
          <span className="ga-tile-label">Behind the remote</span>
          <span className="ga-tile-value">
            {state.upstream ? (state.behind === 0 ? "up to date" : plural(state.behind, "commit")) : "no upstream"}
          </span>
          <span className="ga-tile-sub">{state.upstream || "nothing to pull from"}</span>
        </div>
        <div className="ga-tile" title="Files changed on disk but not committed anywhere">
          <span className="ga-tile-label">Uncommitted</span>
          <span className={"ga-tile-value" + (dirtyTotal > 0 ? " warn" : "")}>
            {dirtyTotal === 0 ? "working trees clean" : plural(dirtyTotal, "file")}
          </span>
          <span className="ga-tile-sub">
            {dirtyTotal === 0
              ? "nothing waiting to be committed"
              : `across ${plural(dirtyWhere, "checkout")}`}
          </span>
        </div>
      </div>

      {checkouts.length > 0 && (
        <table className="ga-branch-table">
          <caption className="ga-sr">Each checkout, and how far it is from landing</caption>
          <thead>
            <tr>
              <th scope="col">Checkout</th>
              <th scope="col" className="num">
                Ahead
              </th>
              <th scope="col" className="num">
                Behind
              </th>
              <th scope="col" className="num">
                Uncommitted
              </th>
              <th scope="col" className="when">
                Last commit
              </th>
            </tr>
          </thead>
          <tbody>
            {checkouts.map((c) => {
              const agent = c.agentId ? agents.find((a) => a.id === c.agentId) : undefined;
              const against = c.compare || "nothing — this branch tracks no remote";
              return (
                <tr key={c.path}>
                  <th scope="row">
                    <span className="ga-branch-cell" title={c.path}>
                      {agent && <Avatar name={agent.name} id={agent.id} kind={agent.kind} />}
                      <span className="ga-branch-name">{c.label}</span>
                      {c.isMain && <span className="chip tiny-chip ga-tag main-tag">main</span>}
                    </span>
                  </th>
                  <td className="num" title={`Commits here that ${against} doesn't have`}>
                    {countCell(c.ahead, c.aheadCapped, "ahead")}
                  </td>
                  <td className="num" title={`Commits on ${against} that this checkout doesn't have`}>
                    {countCell(c.behind, c.behindCapped, "behind")}
                  </td>
                  <td className="num" title="Uncommitted files in this working tree">
                    {c.dirty < 0 ? (
                      <span className="ga-num zero">?</span>
                    ) : (
                      countCell(c.dirty, false, "dirty")
                    )}
                  </td>
                  <td className="when">{c.lastAt ? timeAgo(c.lastAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {/* The cap only matters once something hits it, and when it does the “+”
        * in the cell says so on the spot. It does not need announcing under
        * every table that has not reached it. */}
      <div className="ga-hint ga-branch-note">
        Worktrees are measured against {integration || "HEAD"}, the main checkout against its
        upstream.
      </div>
    </div>
  );
}

function MetaRow({ data }: { data: ProjectGit }) {
  const { state, remote, fetchedAt, checkoutCount } = data;
  return (
    <div className="ga-meta-row">
      <span className="chip tiny-chip ga-meta-chip">
        <IconBranch size={12} />
        {state.detached ? `detached @ ${shortSha(state.head)}` : state.branch || "no branch"}
      </span>
      {state.upstream && (
        <span className="chip tiny-chip ga-meta-chip">tracking {state.upstream}</span>
      )}
      {remote.url ? (
        remote.webUrl ? (
          <a
            className="chip tiny-chip ga-meta-chip ga-remote-link"
            href={remote.webUrl}
            target="_blank"
            rel="noreferrer"
            title={remote.url}
          >
            <IconGitHub size={11} />
            {remote.name}: {remote.url}
          </a>
        ) : (
          <span className="chip tiny-chip ga-meta-chip" title={remote.url}>
            {remote.name}: {remote.url}
          </span>
        )
      ) : (
        <span className="chip tiny-chip ga-meta-chip">no remote</span>
      )}
      {checkoutCount > 1 && (
        <span className="chip tiny-chip ga-meta-chip" title="Main checkout plus agent worktrees">
          {checkoutCount} checkouts
        </span>
      )}
      {fetchedAt && (
        <span className="ga-meta-note" title="Last time a fetch actually moved a remote branch">
          remote data last updated {timeAgo(fetchedAt)}
        </span>
      )}
    </div>
  );
}

/* ── filters ─────────────────────────────────────────────────── */

function FilterBar({
  filters,
  setFilters,
  pathInput,
  setPathInput,
  rows,
  agents,
  onClear,
}: {
  filters: Filters;
  setFilters: (fn: (f: Filters) => Filters) => void;
  pathInput: string;
  setPathInput: (s: string) => void;
  rows: ActivityRow[];
  agents: Agent[];
  onClear: () => void;
}) {
  const authors = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      const key = authorKey(r);
      if (map.has(key)) continue;
      const agent = agents.find((a) => a.id === rowAgentId(r));
      map.set(key, agent?.name ?? r.author ?? "unknown");
    }
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, agents]);

  const branches = useMemo(
    () => [...new Set(rows.map((r) => r.branch))].sort((a, b) => a.localeCompare(b)),
    [rows]
  );

  return (
    <div className="ga-filters" role="search">
      <input
        className="ga-filter-text"
        type="search"
        value={filters.q}
        placeholder="Search message, sha, author…"
        aria-label="Search commits"
        onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
      />
      <select
        className="ga-filter-select"
        value={filters.author}
        aria-label="Filter by author"
        onChange={(e) => setFilters((f) => ({ ...f, author: e.target.value }))}
      >
        <option value="">All authors</option>
        {authors.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <select
        className="ga-filter-select"
        value={filters.branch}
        aria-label="Filter by branch"
        onChange={(e) => setFilters((f) => ({ ...f, branch: e.target.value }))}
      >
        <option value="">All branches</option>
        {branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <span className="ga-filter-dates">
        <input
          className="ga-filter-date"
          type="date"
          value={filters.from}
          aria-label="Commits from date"
          max={filters.to || undefined}
          onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
        />
        <span className="ga-filter-dash">→</span>
        <input
          className="ga-filter-date"
          type="date"
          value={filters.to}
          aria-label="Commits to date"
          min={filters.from || undefined}
          onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
        />
      </span>
      <input
        className="ga-filter-path"
        type="text"
        value={pathInput}
        placeholder="path/or/glob"
        aria-label="Filter by path"
        title="A git pathspec — src/, *.ts, docs/**. Changing it re-reads history from git."
        onChange={(e) => setPathInput(e.target.value)}
      />
      <button
        type="button"
        className={"chip select-chip ga-toggle" + (filters.agentOnly ? " active" : "")}
        aria-pressed={filters.agentOnly}
        title="Only commits Spaces can tie to an agent run, through the run's before/after checkpoints"
        onClick={() => setFilters((f) => ({ ...f, agentOnly: !f.agentOnly }))}
      >
        Agent runs
      </button>
      <button
        type="button"
        className={"chip select-chip ga-toggle" + (filters.unpushedOnly ? " active" : "")}
        aria-pressed={filters.unpushedOnly}
        title="Only commits that exist on no remote"
        onClick={() => setFilters((f) => ({ ...f, unpushedOnly: !f.unpushedOnly }))}
      >
        Not pushed
      </button>
      {anyFilter(filters) && (
        <button type="button" className="btn tiny ga-clear" onClick={onClear}>
          Clear
        </button>
      )}
    </div>
  );
}

/* ── sparklines ──────────────────────────────────────────────── */

interface Day {
  iso: string;
  label: string;
  at: number;
  count: number;
}

/**
 * The last SPARK_DAYS days, newest last. Anchored on the newest commit when
 * that is in the future of "now" (clock skew) so a bar never falls off the end.
 */
function dayBuckets(rows: ActivityRow[]): Day[] {
  const newest = rows.reduce((n, r) => Math.max(n, r.at), 0);
  const anchor = new Date(Math.max(Date.now(), newest));
  const days: Day[] = [];
  const index = new Map<string, Day>();
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    // Date arithmetic, not 86_400_000: a DST boundary would slide the buckets.
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - i);
    const day: Day = {
      iso: isoDay(d.getTime()),
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      at: d.getTime(),
      count: 0,
    };
    days.push(day);
    index.set(day.iso, day);
  }
  for (const r of rows) {
    const day = index.get(isoDay(r.at));
    if (day) day.count++;
  }
  return days;
}

function DayBars({
  rows,
  selectedDay,
  onPickDay,
}: {
  rows: ActivityRow[];
  selectedDay: string;
  onPickDay: (iso: string) => void;
}) {
  const days = useMemo(() => dayBuckets(rows), [rows]);
  const max = days.reduce((n, d) => Math.max(n, d.count), 0);
  const inWindow = days.reduce((n, d) => n + d.count, 0);

  return (
    <div className="ga-facet">
      <div className="ga-facet-head">
        <span className="ga-facet-title">Last {SPARK_DAYS} days</span>
        <span className="ga-facet-sub">{plural(inWindow, "commit")}</span>
      </div>
      <div className="ga-days" role="group" aria-label={`Commits per day, last ${SPARK_DAYS} days`}>
        {days.map((d) => (
          <button
            key={d.iso}
            type="button"
            className={"ga-day" + (d.iso === selectedDay ? " active" : "") + (d.count ? "" : " empty")}
            title={`${d.label} · ${plural(d.count, "commit")}`}
            aria-label={`${d.label}, ${plural(d.count, "commit")}`}
            aria-pressed={d.iso === selectedDay}
            onClick={() => onPickDay(d.iso)}
          >
            <span
              className="ga-day-bar"
              style={{ height: `${max ? Math.max(8, (d.count / max) * 100) : 2}%` }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/** A 30-day bar strip, small enough to sit inside a list row. */
function MiniSpark({ counts, label }: { counts: number[]; label: string }) {
  const max = counts.reduce((n, c) => Math.max(n, c), 0);
  const w = 2;
  const gap = 1;
  const h = 14;
  const width = counts.length * (w + gap);
  return (
    <svg
      className="ga-spark"
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      role="img"
      aria-label={label}
    >
      {counts.map((c, i) => {
        const bh = max ? Math.max(1.5, (c / max) * h) : 1;
        return (
          <rect
            key={i}
            className={c ? "ga-spark-bar" : "ga-spark-bar empty"}
            x={i * (w + gap)}
            y={h - bh}
            width={w}
            height={bh}
            rx={0.8}
          />
        );
      })}
    </svg>
  );
}

function AuthorFacet({
  rows,
  agents,
  active,
  onPick,
}: {
  rows: ActivityRow[];
  agents: Agent[];
  active: string;
  onPick: (key: string) => void;
}) {
  const people = useMemo(() => {
    const days = dayBuckets(rows).map((d) => d.iso);
    const slot = new Map(days.map((iso, i) => [iso, i] as const));
    const map = new Map<
      string,
      { key: string; label: string; agentId: string; count: number; counts: number[] }
    >();
    for (const r of rows) {
      const key = authorKey(r);
      let entry = map.get(key);
      if (!entry) {
        const agentId = rowAgentId(r);
        entry = {
          key,
          label: agents.find((a) => a.id === agentId)?.name ?? r.author ?? "unknown",
          agentId,
          count: 0,
          counts: days.map(() => 0),
        };
        map.set(key, entry);
      }
      entry.count++;
      const i = slot.get(isoDay(r.at));
      if (i !== undefined) entry.counts[i]++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [rows, agents]);

  const top = people.slice(0, TOP_AUTHORS);
  const rest = people.length - top.length;

  return (
    <div className="ga-facet">
      <div className="ga-facet-head">
        <span className="ga-facet-title">Who changed it</span>
        <span className="ga-facet-sub">{plural(people.length, "author")}</span>
      </div>
      {!top.length ? (
        <div className="ga-facet-empty">Nothing in range.</div>
      ) : (
        <div className="ga-authors">
          {top.map((p) => {
            const agent = p.agentId ? agents.find((a) => a.id === p.agentId) : undefined;
            return (
              <button
                key={p.key}
                type="button"
                className={"ga-author" + (p.key === active ? " active" : "")}
                aria-pressed={p.key === active}
                title={
                  p.key === active
                    ? `Showing only ${p.label} — click to clear`
                    : `Show only ${p.label}'s commits`
                }
                onClick={() => onPick(p.key)}
              >
                {agent ? (
                  <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
                ) : (
                  <span className="ga-author-dot" aria-hidden="true" />
                )}
                <span className="ga-author-name">{p.label}</span>
                <MiniSpark counts={p.counts} label={`${p.label}: ${plural(p.count, "commit")}`} />
                <span className="ga-author-count">{p.count}</span>
              </button>
            );
          })}
          {rest > 0 && <div className="ga-facet-empty">+{rest} more</div>}
        </div>
      )}
    </div>
  );
}

/* ── one commit ──────────────────────────────────────────────── */

function CommitRow({
  row,
  graph,
  lanes,
  agents,
  related,
  selected,
  onSelect,
}: {
  row: ActivityRow;
  graph: GraphRow;
  lanes: number;
  agents: Agent[];
  related: EntityRef[];
  selected: boolean;
  onSelect: () => void;
}) {
  const agentId = rowAgentId(row);
  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;

  return (
    <div className={"ga-row" + (selected ? " sel" : "")}>
      <GraphCell g={graph} lanes={lanes} row={row} selected={selected} />
      <button
        type="button"
        className="ga-row-main"
        // A toggle, not a disclosure: clicking the selected row clears it, and
        // the detail it drives is a sibling panel rather than inline content.
        aria-pressed={selected}
        onClick={onSelect}
        title={row.subject}
      >
        <span className="ga-sha">{shortSha(row.sha)}</span>
        {agent && (
          <span className="ga-agent">
            <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
            <span className="ga-agent-name">{agent.name}</span>
          </span>
        )}
        <span className="ga-subject">{row.subject || "(no subject)"}</span>
      </button>
      {related.length > 0 && (
        <span className="ga-row-links">
          {related.slice(0, 2).map((ref) => (
            <EntityChip key={refKeyOf(ref)} ref={ref} size="sm" />
          ))}
        </span>
      )}
      <span className="ga-tags">
        {row.run && (
          <span className="chip tiny-chip ga-tag run" title="Committed during an Spaces agent run">
            run
          </span>
        )}
        {row.checkpoint && !row.run && (
          <span
            className="chip tiny-chip ga-tag checkpoint"
            title="Committed by Spaces as a run checkpoint"
          >
            checkpoint
          </span>
        )}
        {row.localOnly && (
          <span className="chip tiny-chip ga-tag local" title="On this machine only — not on any remote">
            local only
          </span>
        )}
        <span
          className={"chip tiny-chip ga-tag branch" + (row.isMain ? " main" : "")}
          title={row.isMain ? "Main checkout" : "Agent worktree"}
        >
          {row.branch}
        </span>
      </span>
      <span className="ga-when" title={new Date(row.at).toLocaleString()}>
        {!agent && row.author ? `${row.author} · ` : ""}
        {timeAgo(row.at)}
      </span>
    </div>
  );
}

/* ── commit detail ───────────────────────────────────────────── */

interface FileStat {
  path: string;
  add: number;
  del: number;
}

interface DetailState {
  loading: boolean;
  message: string;
  files: FileStat[];
  diff: string;
  error: string;
}

/** Path out of a "--- a/x" / "+++ b/x" line; "" for /dev/null. */
function diffPath(raw: string): string {
  const p = raw.split("\t")[0].trim();
  if (!p || p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

/** Per-file +/- from a unified diff, merged with git's own name list. */
function fileStats(diff: string, names: string[]): FileStat[] {
  const stats = new Map<string, FileStat>();
  const ensure = (path: string) => {
    let s = stats.get(path);
    if (!s) {
      s = { path, add: 0, del: 0 };
      stats.set(path, s);
    }
    return s;
  };
  for (const n of names) ensure(n);

  let cur: FileStat | null = null;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = null;
      continue;
    }
    // Header lines start with +/- too, so they must be taken first.
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // A deletion's "+++ /dev/null" leaves `cur` on the a/ side, which is the
      // only place its removed lines can be counted.
      const path = diffPath(line.slice(4));
      if (path) cur = ensure(path);
      continue;
    }
    if (!cur || line.startsWith("@@")) continue;
    if (line.startsWith("+")) cur.add++;
    else if (line.startsWith("-")) cur.del++;
  }

  return [...stats.values()].sort(
    (a, b) => b.add + b.del - (a.add + a.del) || a.path.localeCompare(b.path)
  );
}

function diffLineKind(line: string): string {
  if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return "file";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

function CommitDetail({
  dir,
  row,
  agents,
  related,
  webUrl,
  onOpenRunDiff,
  onClose,
}: {
  dir: string;
  row: ActivityRow | null;
  agents: Agent[];
  related: EntityRef[];
  webUrl: string;
  onOpenRunDiff: (runId: string) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<DetailState>({
    loading: false,
    message: "",
    files: [],
    diff: "",
    error: "",
  });
  const [showDiff, setShowDiff] = useState(false);
  const req = useRef(0);
  const sha = row?.sha ?? "";

  useEffect(() => {
    setShowDiff(false);
    if (!sha) return;
    const token = ++req.current;
    setState({ loading: true, message: "", files: [], diff: "", error: "" });
    void (async () => {
      // `git show -s --format=%B` is the only way to the full message: the log
      // helper's format carries the subject alone. runDiff does the rest, so
      // the diff itself still goes through gitflow.ts.
      const [message, d] = await Promise.all([
        git(dir, "show", "-s", "--format=%B", sha).catch(() => ""),
        runDiff(dir, "", sha),
      ]);
      if (token !== req.current) return;
      setState({
        loading: false,
        message: message.trim(),
        files: fileStats(d.diff, d.files),
        diff: d.diff,
        error: d.error,
      });
    })();
  }, [dir, sha]);

  if (!row) {
    return (
      <aside className="ga-detail empty">
        <div className="ga-detail-empty">
          Pick a commit to see its full message, the files it touched, and the run it came from.
        </div>
      </aside>
    );
  }

  const agentId = rowAgentId(row);
  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  // Held in a local so the callbacks below keep the narrowing.
  const run = row.run;
  const [subject, ...bodyLines] = (state.message || row.subject).split("\n");
  const body = bodyLines.join("\n").trim();
  const totals = state.files.reduce(
    (t, f) => ({ add: t.add + f.add, del: t.del + f.del }),
    { add: 0, del: 0 }
  );
  const diffLines = state.diff ? state.diff.replace(/\r\n/g, "\n").split("\n") : [];
  const hiddenLines = Math.max(0, diffLines.length - DETAIL_DIFF_LINES);

  return (
    <aside className="ga-detail" aria-label={`Commit ${shortSha(row.sha)}`}>
      <div className="ga-detail-head">
        <span className="ga-detail-sha" title={row.sha}>
          {shortSha(row.sha)}
        </span>
        <span className="ga-detail-when">{new Date(row.at).toLocaleString()}</span>
        <button type="button" className="icon-btn ga-detail-close" aria-label="Close detail" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="ga-detail-message">
        <div className="ga-detail-subject">{subject || "(no subject)"}</div>
        {body && <pre className="ga-detail-body">{body}</pre>}
      </div>

      <div className="ga-detail-meta">
        <span className="chip tiny-chip ga-tag branch">{row.branch}</span>
        {row.localOnly && (
          <span className="chip tiny-chip ga-tag local">local only</span>
        )}
        {!agent && row.author && <span className="ga-detail-author">{row.author}</span>}
      </div>

      {agent && run && (
        <div className="ga-run-block">
          <div className="ga-run-head">
            <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
            <div className="ga-run-who">
              <div className="ga-run-name">{agent.name}</div>
              <div className="ga-run-sub">
                agent run · {timeAgo(run.startedAt)} · {run.status}
              </div>
            </div>
          </div>
          {run.prompt && <div className="ga-run-prompt">{run.prompt.slice(0, 220)}</div>}
          <div className="ga-run-actions">
            <button type="button" className="btn tiny" onClick={() => onOpenRunDiff(run.runId)}>
              Open the run diff
            </button>
            {/* The run's channel is the thread this commit was asked for in. */}
            <EntityChip ref={{ type: "channel", id: run.channelId }} size="sm" />
          </div>
        </div>
      )}
      {agent && !run && (
        <div className="ga-run-block plain">
          <div className="ga-run-head">
            <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
            <div className="ga-run-who">
              <div className="ga-run-name">{agent.name}</div>
              <div className="ga-run-sub">on this agent&apos;s workspace branch</div>
            </div>
          </div>
        </div>
      )}

      {related.length > 0 && (
        <div className="ga-detail-section">
          <div className="ga-detail-label">Connected to</div>
          <div className="ga-detail-chips">
            {related.map((ref) => (
              <EntityChip key={refKeyOf(ref)} ref={ref} size="sm" showType />
            ))}
          </div>
        </div>
      )}

      <div className="ga-detail-section">
        <div className="ga-detail-label">
          Files
          {state.files.length > 0 && (
            <span className="ga-detail-totals">
              <span className="ga-add">+{totals.add}</span>
              <span className="ga-del">−{totals.del}</span>
            </span>
          )}
        </div>
        {state.loading ? (
          <div className="ga-detail-files" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="sk-block sk-file" key={i} />
            ))}
          </div>
        ) : state.error ? (
          <div className="banner warn ga-note">{state.error}</div>
        ) : !state.files.length ? (
          <div className="ga-facet-empty">This commit changed no files.</div>
        ) : (
          <div className="ga-detail-files">
            {state.files.map((f) => (
              <div className="ga-file" key={f.path}>
                <span className="ga-file-path" title={f.path}>
                  {f.path}
                </span>
                <span className="ga-file-counts">
                  <span className={"ga-add" + (f.add ? "" : " zero")}>+{f.add}</span>
                  <span className={"ga-del" + (f.del ? "" : " zero")}>−{f.del}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ga-detail-actions">
        {state.diff.trim() !== "" && (
          <button
            type="button"
            className="btn tiny"
            aria-expanded={showDiff}
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? "Hide diff" : "View diff"}
          </button>
        )}
        {webUrl &&
          (row.localOnly ? (
            <span className="ga-detail-hint">Not on the remote yet, so there is nothing to open there.</span>
          ) : (
            <a className="btn tiny" href={`${webUrl}/commit/${row.sha}`} target="_blank" rel="noreferrer">
              <IconGitHub size={11} /> Open on the remote
            </a>
          ))}
      </div>

      {showDiff && (
        <div className="ga-diff" tabIndex={0} role="region" aria-label="Unified diff">
          {diffLines.slice(0, DETAIL_DIFF_LINES).map((line, i) => (
            <div className={"ga-diff-line " + diffLineKind(line)} key={i}>
              {line === "" ? " " : line}
            </div>
          ))}
          {hiddenLines > 0 && (
            <div className="ga-diff-line note">
              … {hiddenLines} more lines — open the commit in your editor for the rest.
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/* ── open PRs: where the commits ended up ────────────────────── */

function ProjectPRs({ prs, error, repo }: { prs: RepoPR[] | null; error: string; repo: string }) {
  return (
    <>
      <div className="ga-section-label">
        Open pull requests
        {prs && prs.length > 0 && <span className="ga-count">{prs.length}</span>}
      </div>
      {error && (
        <div className="banner warn ga-note">
          Couldn&apos;t reach GitHub for <code>{repo}</code>: {error.slice(0, 200)}
        </div>
      )}
      {!prs && !error && (
        <div className="ga-skeleton" aria-hidden="true">
          <div className="sk-rows">
            {[0.7, 0.55].map((w, i) => (
              <div className="sk-row" key={i}>
                <span className="sk-block sk-dot" />
                <span className="sk-block sk-subject" style={{ width: `${w * 100}%` }} />
                <span className="sk-block sk-when" />
              </div>
            ))}
          </div>
        </div>
      )}
      {prs?.length === 0 && !error && (
        <div className="nav-empty">No open pull requests — nothing is waiting to merge.</div>
      )}
      {prs?.map((pr) => (
        <a key={pr.url} className="list-row ga-pr-row" href={pr.url} target="_blank" rel="noreferrer">
          <span className={"pr-dot" + (pr.isDraft ? " draft" : "")}>
            <IconGitHub size={11} />
          </span>
          <span className="list-title">{pr.title}</span>
          <span className="chip tiny-chip ga-tag branch">{pr.headRefName}</span>
          <span className="list-sub">
            #{pr.number} · {pr.author.login} · {timeAgo(pr.updatedAt)}
          </span>
        </a>
      ))}
    </>
  );
}

/* ── local icon ──────────────────────────────────────────────── */

/**
 * Same geometry contract as ./icons.tsx (24×24, currentColor, 1.75 stroke).
 * Lives here only because icons.tsx is owned by another workstream right now —
 * it belongs in that file.
 */
function IconRefresh({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 12a8 8 0 10-2.6 5.9" />
      <path d="M20 5.5V12h-6.2" />
    </svg>
  );
}
