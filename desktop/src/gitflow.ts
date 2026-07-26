/**
 * Git checkpoints for agent runs.
 *
 * Every agent turn is bracketed by a checkpoint: the HEAD sha before it starts
 * (commit_before) and a "hq: <label>" commit of whatever it left on disk
 * (commit_after). That pair is what makes a turn inspectable (runDiff) and
 * undoable (revertRun) long after it finished.
 *
 * checkpointBefore/checkpointAfter never throw — they run inline with a run,
 * and a git hiccup must never take the run down with it; they return "" and the
 * run simply isn't checkpointed. Everything else returns a typed result that
 * carries git's own stderr text, so the UI can show what actually went wrong.
 *
 * Built on workspaces.ts (git/isGitRepo/diffOf/mergeInProgress); it owns the
 * worktree lifecycle, this file owns per-run history.
 */

import { diffOf, git, isGitRepo, mergeInProgress } from "./workspaces";
import { slug } from "./types";

/** Human-readable message from a thrown value — git's stderr, not "[object Object]". */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type GitResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Not generic, so it's assignable to GitResult<T> for any T. */
function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function ok<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function lines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "");
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/* ── checkpoints ─────────────────────────────────────────────── */

/** HEAD before a run starts. "" when there's no repo, no commits yet, or no git. */
export async function checkpointBefore(cwd: string): Promise<string> {
  if (!cwd) return "";
  try {
    if (!(await isGitRepo(cwd))) return "";
    return (await git(cwd, "rev-parse", "HEAD")).trim();
  } catch {
    // unborn HEAD (fresh repo) or an unusable git — no baseline, not an error
    return "";
  }
}

const MAX_SUBJECT = 72;

/** "hq: <label>" on one line, capped so `git log --oneline` stays readable. */
function checkpointMessage(label: string): string {
  const one = label.replace(/\s+/g, " ").trim();
  const capped = one.length > MAX_SUBJECT ? `${one.slice(0, MAX_SUBJECT - 1).trimEnd()}…` : one;
  return `hq: ${capped || "agent run"}`;
}

/**
 * Commit whatever the run left behind. Returns the new sha, or "" when there
 * was nothing to commit (or committing would have been unsafe).
 *
 * Refuses while a merge/rebase is unresolved: staging a conflicted tree would
 * bake conflict markers into a commit that looks like real work.
 */
export async function checkpointAfter(cwd: string, label: string): Promise<string> {
  if (!cwd) return "";
  try {
    if (!(await isGitRepo(cwd))) return "";
    if (await mergeInProgress(cwd)) return "";
    const unmerged = (await git(cwd, "diff", "--name-only", "--diff-filter=U")).trim();
    if (unmerged) return "";
    const dirty = (await git(cwd, "status", "--porcelain")).trim();
    if (!dirty) return "";
    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-m", checkpointMessage(label));
    return (await git(cwd, "rev-parse", "HEAD")).trim();
  } catch {
    // e.g. no user.email configured, or a hook rejected the commit — the run
    // still succeeded, it just isn't checkpointed.
    return "";
  }
}

/* ── diff ────────────────────────────────────────────────────── */

export interface RunDiffResult {
  diff: string;
  files: string[];
  /** "" when git produced the diff cleanly. */
  error: string;
}

async function headSha(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "HEAD").then(
    (s) => s.trim(),
    () => ""
  );
}

async function uncommittedFiles(cwd: string): Promise<string[]> {
  const [unstaged, staged, untracked] = await Promise.all([
    git(cwd, "diff", "--name-only"),
    git(cwd, "diff", "--cached", "--name-only"),
    git(cwd, "ls-files", "--others", "--exclude-standard"),
  ]);
  return dedupe([...lines(unstaged), ...lines(staged), ...lines(untracked)]);
}

/**
 * What a run changed: the diff between its two checkpoints, or — when it never
 * committed (after === "") — what is still uncommitted in the working tree.
 *
 * In that uncommitted case anything the agent committed *itself* since the
 * baseline is prepended, otherwise a run whose agent ran `git commit` on its
 * own would render as an empty diff.
 */
export async function runDiff(cwd: string, before: string, after: string): Promise<RunDiffResult> {
  if (!cwd) return { diff: "", files: [], error: "This run has no working directory recorded." };
  try {
    if (!(await isGitRepo(cwd))) {
      return { diff: "", files: [], error: `${cwd} is not a git repository.` };
    }

    if (after) {
      const ranged = before !== "" && before !== after;
      const diff = ranged
        ? await git(cwd, "diff", "--no-color", before, after)
        : await git(cwd, "show", "--no-color", "--format=", after);
      const names = ranged
        ? await git(cwd, "diff", "--name-only", before, after)
        : await git(cwd, "show", "--name-only", "--format=", after);
      return { diff, files: lines(names), error: "" };
    }

    const parts: string[] = [];
    const files: string[] = [];
    const head = await headSha(cwd);
    if (before && head && head !== before) {
      try {
        parts.push(await git(cwd, "diff", "--no-color", before, head));
        files.push(...lines(await git(cwd, "diff", "--name-only", before, head)));
      } catch {
        // baseline commit is gone (branch rewritten) — the working-tree diff
        // below is still worth showing
      }
    }
    parts.push(await diffOf(cwd));
    files.push(...(await uncommittedFiles(cwd)));
    return { diff: parts.filter((p) => p.trim()).join("\n"), files: dedupe(files), error: "" };
  } catch (e) {
    return { diff: "", files: [], error: errText(e) };
  }
}

/* ── revert ──────────────────────────────────────────────────── */

/**
 * Undo one run.
 *
 * - nothing on top and a baseline to go back to → `git reset --hard <before>`,
 *   which removes the checkpoint commit entirely.
 * - the commit is already on a remote → `git revert --no-edit <after>`, so
 *   published history is never rewritten.
 * - anything landed on top → refuse. Rolling back under other people's work is
 *   the kind of thing Spaces should ask a human to do deliberately.
 */
export async function revertRun(
  cwd: string,
  before: string,
  after: string
): Promise<GitResult<string>> {
  try {
    if (!cwd) return fail("This run has no working directory recorded, so there's nothing to revert.");
    if (!(await isGitRepo(cwd))) return fail(`${cwd} is not a git repository.`);
    if (!after) return fail("This run never committed anything, so there's nothing to revert.");
    if (before === after) {
      return fail("This run's before and after checkpoints are the same commit — nothing to revert.");
    }

    const exists = await git(cwd, "cat-file", "-e", `${after}^{commit}`).then(
      () => true,
      () => false
    );
    if (!exists) {
      return fail(
        `Commit ${short(after)} is no longer in ${cwd} — the branch it was made on may have been rewritten or removed.`
      );
    }
    if (await mergeInProgress(cwd)) {
      return fail("A merge is in progress here. Finish or abort it before reverting a run.");
    }
    const dirty = (await git(cwd, "status", "--porcelain")).trim();
    if (dirty) {
      return fail(
        "There are uncommitted changes in this working tree. Commit or discard them first — reverting would throw them away."
      );
    }

    const onBranch = await git(cwd, "merge-base", "--is-ancestor", after, "HEAD").then(
      () => true,
      () => false
    );
    if (!onBranch) {
      return fail(
        `Commit ${short(after)} isn't in the checked-out branch's history — switch to the branch this run worked on first.`
      );
    }
    const ahead = parseInt((await git(cwd, "rev-list", "--count", `${after}..HEAD`)).trim(), 10) || 0;
    if (ahead > 0) {
      return fail(
        `${ahead} commit${ahead === 1 ? "" : "s"} landed on top of this run (${short(after)}). ` +
          `Spaces won't rewrite history other work is built on — review them, then undo it by hand with: git revert ${short(after)}`
      );
    }

    const published = await git(cwd, "branch", "-r", "--contains", after).then(
      (s) => s.trim() !== "",
      () => false
    );
    const baseline = before
      ? await git(cwd, "cat-file", "-e", `${before}^{commit}`).then(
          () => before,
          () => ""
        )
      : "";

    if (published || !baseline) {
      try {
        await git(cwd, "revert", "--no-edit", after);
      } catch (e) {
        // a failed revert leaves the tree mid-revert; don't strand the repo
        await git(cwd, "revert", "--abort").catch(() => "");
        return fail(`Couldn't revert ${short(after)} cleanly: ${errText(e)}`);
      }
      return ok(`Reverted ${short(after)} with a new commit.`);
    }

    // Everything between the baseline and HEAD belongs to this run (nothing
    // landed on top — that was checked above), so say how much is going away.
    const dropped =
      parseInt((await git(cwd, "rev-list", "--count", `${baseline}..HEAD`)).trim(), 10) || 1;
    await git(cwd, "reset", "--hard", baseline);
    return ok(
      `Reset back to ${short(baseline)} — ${dropped} commit${dropped === 1 ? "" : "s"} from this run ${dropped === 1 ? "is" : "are"} gone.`
    );
  } catch (e) {
    return fail(errText(e));
  }
}

/* ── task branches ───────────────────────────────────────────── */

const MAX_AGENT_SLUG = 24;
const MAX_TASK_SLUG = 48;

/** slug() capped to `max`, never empty, never left with a trailing dash. */
function part(raw: string, fallback: string, max: number): string {
  return slug(raw).slice(0, max).replace(/-+$/g, "") || fallback;
}

/**
 * Branch name for a board task: hq/<agent>/<task>.
 *
 * Nests one level below the per-agent workspace branches (hq/<agent>-<id6>), so
 * the two never collide as ref paths.
 */
export function taskBranch(agentName: string, taskTitle: string): string {
  return `hq/${part(agentName, "agent", MAX_AGENT_SLUG)}/${part(taskTitle, "task", MAX_TASK_SLUG)}`;
}

/** Current branch, "" when detached or unborn in a way git won't name. */
async function currentBranch(cwd: string): Promise<string> {
  const shown = await git(cwd, "branch", "--show-current").then(
    (s) => s.trim(),
    () => ""
  );
  if (shown) return shown;
  return git(cwd, "rev-parse", "--abbrev-ref", "HEAD").then(
    (s) => s.trim(),
    () => ""
  );
}

/**
 * Check out `branch`, creating it if it doesn't exist yet. Returns the branch
 * actually in use. A dirty tree is fine — git carries the changes over — but if
 * git refuses (the checkout would clobber a file, the branch is checked out in
 * another worktree) that comes back as an error result, never a throw.
 */
export async function ensureTaskBranch(cwd: string, branch: string): Promise<GitResult<string>> {
  const want = branch.trim();
  if (!cwd) return fail("This project has no local checkout, so there's no branch to switch to.");
  if (!want) return fail("No branch name given.");
  try {
    if (!(await isGitRepo(cwd))) return fail(`${cwd} is not a git repository.`);
    if ((await currentBranch(cwd)) === want) return ok(want);

    const exists = (await git(cwd, "branch", "--list", want)).trim() !== "";
    if (exists) await git(cwd, "checkout", want);
    else await git(cwd, "checkout", "-b", want);

    return ok((await currentBranch(cwd)) || want);
  } catch (e) {
    return fail(errText(e));
  }
}
