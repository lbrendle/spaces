/**
 * Read-only git history helpers for the Git Activity view.
 *
 * Everything here exists to answer one question: what have the agents actually
 * committed, and has any of it left this machine? Nothing in this module
 * mutates repository state — the only subcommands used are `log`, `rev-parse`,
 * `rev-list`, `symbolic-ref`, `remote` and `worktree list`.
 *
 * No function throws. Every helper returns a typed result carrying an `error`
 * string, so a half-broken checkout degrades one card instead of the view.
 */
import { git } from "./workspaces";

/** Field / record separators — written as %x1f / %x1e so subjects can contain anything. */
const US = "\u001f";
const RS = "\u001e";
const LOG_FORMAT = "--pretty=format:%H%x1f%an%x1f%at%x1f%s%x1e";

/** git's various ways of saying "this repo has no commits yet". */
const NO_COMMITS =
  /does not have any commits yet|bad default revision|unknown revision or path not in the working tree|ambiguous argument 'HEAD'|bad revision 'HEAD'/i;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run git without throwing: `error` is set instead (git's own stderr text). */
async function tryGit(cwd: string, ...args: string[]): Promise<{ out: string; error: string }> {
  try {
    return { out: await git(cwd, ...args), error: "" };
  } catch (e) {
    return { out: "", error: errText(e) };
  }
}

/* ── commits ─────────────────────────────────────────────────── */

export interface Commit {
  sha: string;
  author: string;
  /** Author time in epoch **milliseconds** (ready for timeAgo). */
  at: number;
  subject: string;
}

export interface CommitsResult {
  commits: Commit[];
  /** True when the repo simply has no commits yet — not an error. */
  noCommits: boolean;
  error: string;
}

function parseLog(out: string): Commit[] {
  const list: Commit[] = [];
  for (const record of out.split(RS)) {
    // git joins records with a newline; strip it before splitting fields.
    const line = record.replace(/^[\r\n]+/, "");
    if (!line.trim()) continue;
    const parts = line.split(US);
    const sha = (parts[0] ?? "").trim();
    if (!sha) continue;
    list.push({
      sha,
      author: parts[1] ?? "",
      at: (parseInt(parts[2] ?? "", 10) || 0) * 1000,
      // Rejoin: a subject containing \x1f is vanishingly rare but must survive.
      subject: parts.slice(3).join(US),
    });
  }
  return list;
}

/**
 * `git log` for a directory. `rev` appends revision arguments — e.g.
 * `["origin/main..HEAD"]` or `["HEAD", "--not", "--remotes"]`.
 */
export async function commits(cwd: string, limit = 50, rev: string[] = []): Promise<CommitsResult> {
  const n = String(Math.max(1, Math.floor(limit)));
  const res = await tryGit(cwd, "log", LOG_FORMAT, "-n", n, ...rev);
  if (res.error) {
    if (NO_COMMITS.test(res.error)) return { commits: [], noCommits: true, error: "" };
    return { commits: [], noCommits: false, error: res.error };
  }
  return { commits: parseLog(res.out), noCommits: false, error: "" };
}

/** 7-char display sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Spaces's own run checkpoints are committed with an "hq: " subject prefix. */
export function isCheckpoint(subject: string): boolean {
  return /^hq:\s/i.test(subject);
}

/* ── branch state ────────────────────────────────────────────── */

export interface BranchState {
  isRepo: boolean;
  noCommits: boolean;
  /** Current branch, or "" when HEAD is detached. */
  branch: string;
  detached: boolean;
  /** Full HEAD sha, "" when there are no commits. */
  head: string;
  /** Upstream ref like "origin/main", "" when the branch tracks nothing. */
  upstream: string;
  ahead: number;
  behind: number;
  remotes: string[];
  hasRemote: boolean;
  error: string;
}

function emptyState(): BranchState {
  return {
    isRepo: false,
    noCommits: false,
    branch: "",
    detached: false,
    head: "",
    upstream: "",
    ahead: 0,
    behind: 0,
    remotes: [],
    hasRemote: false,
    error: "",
  };
}

export async function branchState(cwd: string): Promise<BranchState> {
  const st = emptyState();

  const inside = await tryGit(cwd, "rev-parse", "--is-inside-work-tree");
  if (inside.error || inside.out.trim() !== "true") {
    st.error = inside.error || "Not a git repository.";
    return st;
  }
  st.isRepo = true;

  const remotes = await tryGit(cwd, "remote");
  st.remotes = remotes.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  st.hasRemote = st.remotes.length > 0;

  const head = await tryGit(cwd, "rev-parse", "HEAD");
  if (head.error) {
    if (NO_COMMITS.test(head.error)) st.noCommits = true;
    else st.error = head.error;
  } else {
    st.head = head.out.trim();
  }

  // symbolic-ref, not `rev-parse --abbrev-ref`: it still reports the branch in a
  // repo with no commits, and fails cleanly (rather than printing "HEAD") when
  // HEAD really is detached.
  const sym = await tryGit(cwd, "symbolic-ref", "--short", "-q", "HEAD");
  const branch = sym.out.trim();
  if (branch) st.branch = branch;
  else if (!st.noCommits) st.detached = true;

  if (st.hasRemote && !st.noCommits && st.branch) {
    const up = await tryGit(cwd, "rev-parse", "--abbrev-ref", "@{u}");
    const upstream = up.out.trim();
    // No upstream is normal (never pushed), so an error here is not an error.
    if (!up.error && upstream && upstream !== "@{u}") {
      st.upstream = upstream;
      const counts = await tryGit(cwd, "rev-list", "--left-right", "--count", "@{u}...HEAD");
      if (!counts.error) {
        const [behind, ahead] = counts.out.trim().split(/\s+/);
        st.behind = parseInt(behind ?? "", 10) || 0;
        st.ahead = parseInt(ahead ?? "", 10) || 0;
      }
    }
  }

  return st;
}

/* ── "has anything left this machine?" ───────────────────────── */

export type UnpushedKind =
  | "unknown" // not a repo, or git failed
  | "no-commits" // repo exists, nothing committed yet
  | "no-remote" // no remote at all — everything is local by definition
  | "never-pushed" // remote exists, but these commits are on no remote-tracking ref
  | "unpushed" // tracking a branch and ahead of it
  | "in-sync"; // everything here also exists on the remote

export interface UnpushedResult {
  kind: UnpushedKind;
  /** Number of commits that exist only on this machine. */
  count: number;
  /** The unpushed commits themselves (newest first), up to `limit`. */
  commits: Commit[];
  branch: string;
  upstream: string;
  behind: number;
  /** One-line answer, ready to render as the headline. */
  headline: string;
  /** Supporting sentence. */
  detail: string;
  error: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Exactly what has, and hasn't, left this machine.
 *
 * Pass a `branchState` you already have to avoid re-running the same git calls.
 * The semantics are deliberately precise: with no remote configured there is
 * nothing to be behind on, so the answer is a reassurance, not a scary count.
 */
export async function unpushed(
  cwd: string,
  limit = 50,
  state?: BranchState
): Promise<UnpushedResult> {
  const st = state ?? (await branchState(cwd));
  const base: UnpushedResult = {
    kind: "unknown",
    count: 0,
    commits: [],
    branch: st.branch,
    upstream: st.upstream,
    behind: st.behind,
    headline: "",
    detail: "",
    error: st.error,
  };
  const where = st.branch || (st.detached ? "this detached HEAD" : "this checkout");

  if (!st.isRepo) {
    return {
      ...base,
      headline: "Not a git repository",
      detail: "Nothing here is version controlled, so there is no history to track.",
    };
  }

  if (st.noCommits) {
    return {
      ...base,
      kind: "no-commits",
      headline: "No commits yet — nothing has left this machine",
      detail: st.hasRemote
        ? `A remote is configured (${st.remotes.join(", ")}), but nothing has been committed to push.`
        : "There is no remote configured either.",
    };
  }

  if (!st.hasRemote) {
    return {
      ...base,
      kind: "no-remote",
      headline: "Nothing has left this machine — no remote configured",
      detail:
        "This checkout has no git remote, so every commit below exists only on this computer. " +
        "Nothing can reach GitHub until you add one.",
    };
  }

  if (st.upstream) {
    if (st.ahead === 0) {
      return {
        ...base,
        kind: "in-sync",
        count: 0,
        headline: `Up to date with ${st.upstream}`,
        detail:
          st.behind > 0
            ? `Everything committed on ${where} is already on the remote. ${st.upstream} has ${plural(st.behind, "commit", "commits")} you don't have locally.`
            : `Everything committed on ${where} is already on the remote.`,
      };
    }
    const log = await commits(cwd, limit, [`${st.upstream}..HEAD`]);
    return {
      ...base,
      kind: "unpushed",
      count: st.ahead,
      commits: log.commits,
      error: log.error,
      headline: `${plural(st.ahead, "commit", "commits")} not yet pushed to ${st.upstream}`,
      detail: "These exist only on this machine. Push from Workspaces when you want them on the remote.",
    };
  }

  // A remote exists but this branch tracks nothing. The exact question is
  // "is this commit on ANY remote-tracking ref?" — not "is it ahead of X".
  const counted = await tryGit(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes");
  if (counted.error) {
    return {
      ...base,
      headline: "Couldn't tell whether these commits have been pushed",
      detail: counted.error,
      error: counted.error,
    };
  }
  const count = parseInt(counted.out.trim(), 10) || 0;
  if (count === 0) {
    return {
      ...base,
      kind: "in-sync",
      headline: `Everything on ${where} already exists on the remote`,
      detail: `No upstream branch is set for ${where}, but each of its commits was found on a remote-tracking branch.`,
    };
  }
  const log = await commits(cwd, limit, ["HEAD", "--not", "--remotes"]);
  return {
    ...base,
    kind: "never-pushed",
    count,
    commits: log.commits,
    error: log.error,
    headline: `${plural(count, "commit", "commits")} on ${where} ${count === 1 ? "has" : "have"} never been pushed`,
    detail:
      "No upstream branch is set, and these commits are on no remote-tracking branch — they exist only on this machine.",
  };
}

/**
 * Every commit on any local branch that is on no remote-tracking ref: the
 * project-wide "still only on this machine" set, in a single git call. All
 * worktrees of a repo share one object store and one set of local branches,
 * so this can be run from the main checkout.
 */
export async function localOnlyShas(
  cwd: string,
  limit = 500,
  /** Extra tips to include — e.g. the head of a detached worktree, which is on no branch. */
  extraRefs: string[] = []
): Promise<{ shas: Set<string>; error: string }> {
  const res = await tryGit(
    cwd,
    "log",
    "--pretty=format:%H",
    "-n",
    String(Math.max(1, Math.floor(limit))),
    "--branches",
    ...extraRefs,
    "--not",
    "--remotes"
  );
  if (res.error) {
    if (NO_COMMITS.test(res.error)) return { shas: new Set(), error: "" };
    return { shas: new Set(), error: res.error };
  }
  const shas = new Set(
    res.out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return { shas, error: "" };
}

/* ── remotes ─────────────────────────────────────────────────── */

export interface RemoteUrlResult {
  name: string;
  url: string;
  /** Browsable https:// form of `url`, "" when it can't be derived. */
  webUrl: string;
  error: string;
}

/** scp-style and https git URLs → a link you can actually open. */
function toWebUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "");
  const ssh = trimmed.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/](.+)$/);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (ssh && ssh[1].includes(".")) return `https://${ssh[1]}/${ssh[2].replace(/^\/+/, "")}`;
  return "";
}

export async function remoteUrl(cwd: string): Promise<RemoteUrlResult> {
  const empty: RemoteUrlResult = { name: "", url: "", webUrl: "", error: "" };
  const remotes = await tryGit(cwd, "remote");
  if (remotes.error) return { ...empty, error: remotes.error };
  const names = remotes.out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return empty;
  const name = names.includes("origin") ? "origin" : names[0];
  const url = await tryGit(cwd, "remote", "get-url", name);
  if (url.error) return { ...empty, name, error: url.error };
  const value = url.out.trim();
  return { name, url: value, webUrl: toWebUrl(value), error: "" };
}

export interface LastFetchResult {
  /** Epoch ms of the last remote-tracking ref update, or null if unknown. */
  at: number | null;
  error: string;
}

/**
 * When did remote data last land here? Read from the reflog of the
 * remote-tracking refs, so it means "the last fetch that actually moved a
 * remote branch" — a fetch that found nothing new leaves no trace.
 */
export async function lastFetch(cwd: string): Promise<LastFetchResult> {
  const res = await tryGit(cwd, "log", "-g", "--pretty=format:%at", "-1", "--remotes");
  if (res.error) return { at: null, error: "" };
  const at = parseInt(res.out.trim().split("\n")[0] ?? "", 10);
  return { at: at ? at * 1000 : null, error: "" };
}

/* ── worktrees ───────────────────────────────────────────────── */

export interface Worktree {
  path: string;
  /** Full sha the worktree is checked out at, "" if unborn. */
  head: string;
  /** Short branch name ("main", "hq/ada-1f2e3d"), "" when detached. */
  branch: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** The first entry git reports: the repository's main checkout. */
  isMain: boolean;
}

export interface WorktreesResult {
  worktrees: Worktree[];
  error: string;
}

function blankWorktree(): Worktree {
  return { path: "", head: "", branch: "", detached: false, bare: false, locked: false, isMain: false };
}

/**
 * Every checkout of this repo: the main one plus each agent worktree.
 * If `git worktree list` isn't available the main checkout is still returned,
 * with `error` set so the caller can surface the degradation.
 */
export async function worktrees(cwd: string, state?: BranchState): Promise<WorktreesResult> {
  const res = await tryGit(cwd, "worktree", "list", "--porcelain");
  if (res.error) {
    const st = state ?? (await branchState(cwd));
    if (!st.isRepo) return { worktrees: [], error: st.error || res.error };
    return {
      worktrees: [
        { ...blankWorktree(), path: cwd, head: st.head, branch: st.branch, detached: st.detached, isMain: true },
      ],
      error: res.error,
    };
  }

  const list: Worktree[] = [];
  let current: Worktree | null = null;
  const flush = () => {
    if (current && current.path) list.push(current);
    current = null;
  };
  for (const raw of res.out.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      current = { ...blankWorktree(), path: value, isMain: list.length === 0 };
      continue;
    }
    if (!current) continue;
    // An unborn checkout reports HEAD 000…0 — that is "no commits", not a sha.
    if (key === "HEAD") current.head = /^0+$/.test(value) ? "" : value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = true;
  }
  flush();
  if (list.length) list[0].isMain = true;
  return { worktrees: list, error: "" };
}
