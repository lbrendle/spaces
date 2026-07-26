import { invoke } from "@tauri-apps/api/core";
import { slug } from "./types";
import type { Agent, Project } from "./types";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return invoke<string>("run_git", { args, cwd });
}

export async function ghIn(cwd: string, ...args: string[]): Promise<string> {
  return invoke<string>("run_gh_in", { args, cwd });
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, "rev-parse", "--is-inside-work-tree")).trim() === "true";
  } catch {
    return false;
  }
}

/** Whether the repository has a valid HEAD commit. Fresh repositories do not. */
export async function hasCommits(dir: string): Promise<boolean> {
  return git(dir, "rev-parse", "-q", "--verify", "HEAD").then(
    () => true,
    () => false
  );
}

/**
 * Current branch for both ordinary and unborn repositories.
 * `rev-parse --abbrev-ref HEAD` throws before the first commit; symbolic-ref
 * still reports the branch Git will create.
 */
export async function currentBranch(dir: string): Promise<string> {
  return git(dir, "symbolic-ref", "--short", "-q", "HEAD").then(
    (value) => value.trim(),
    () => ""
  );
}

/** Slugs are lossy ("Åsa" and "Ösa" both → ""), so key by slug + id prefix. */
function agentKey(agent: Agent): string {
  const s = slug(agent.name) || "agent";
  return `${s}-${agent.id.slice(0, 6)}`;
}

export function worktreePath(project: Project, agent: Agent): string {
  const base = project.local_path.replace(/\/+$/, "");
  return `${base}/../.spaces-workspaces/${slug(project.name) || "project"}-${project.id.slice(0, 6)}/${agentKey(agent)}`;
}

export function branchName(agent: Agent): string {
  return `hq/${agentKey(agent)}`;
}

/**
 * Ensure a persistent worktree ("workspace") for this agent on branch hq/<agent>.
 * Returns the worktree path, or null if the project can't support one.
 */
export async function ensureWorkspace(project: Project, agent: Agent): Promise<string | null> {
  if (!project.local_path || !(await isGitRepo(project.local_path))) return null;
  // Git cannot create a worktree from an unborn HEAD. The shared checkout is
  // still usable; the Workspaces view offers an explicit first-commit action.
  if (!(await hasCommits(project.local_path))) return null;
  const path = worktreePath(project, agent);
  const branch = branchName(agent);
  if (await isGitRepo(path).catch(() => false)) return path;

  const branches = await git(project.local_path, "branch", "--list", branch);
  if (branches.trim()) {
    await git(project.local_path, "worktree", "add", path, branch);
  } else {
    await git(project.local_path, "worktree", "add", "-b", branch, path);
  }
  return path;
}

export interface WorkspaceStatus {
  path: string;
  branch: string;
  changedFiles: number;
  aheadOfBase: number;
  statusLines: string[];
}

export async function workspaceStatus(project: Project, agent: Agent): Promise<WorkspaceStatus | null> {
  const path = worktreePath(project, agent);
  if (!(await isGitRepo(path).catch(() => false))) return null;
  const branch = branchName(agent);
  const status = (await git(path, "status", "--porcelain")).split("\n").filter(Boolean);
  let ahead = 0;
  try {
    const base = await baseBranch(project);
    if (base && base !== branch) {
      const counts = await git(path, "rev-list", "--count", `${base}..${branch}`);
      ahead = parseInt(counts.trim(), 10) || 0;
    }
  } catch {
    // base branch comparison is best-effort
  }
  return { path, branch, changedFiles: status.length, aheadOfBase: ahead, statusLines: status };
}

/** The repo's default branch: origin/HEAD if known, else the main checkout's current branch. */
async function baseBranch(project: Project): Promise<string> {
  try {
    const ref = (await git(project.local_path, "symbolic-ref", "refs/remotes/origin/HEAD")).trim();
    const short = ref.replace("refs/remotes/origin/", "");
    if (short) return short;
  } catch {
    // no remote or origin/HEAD unset — fall through
  }
  return (await git(project.local_path, "rev-parse", "--abbrev-ref", "HEAD")).trim();
}

/** Uncommitted diff in any git dir (workspace or the main checkout). */
export async function diffOf(dir: string): Promise<string> {
  const staged = await git(dir, "diff", "--cached");
  const unstaged = await git(dir, "diff");
  let untrackedDiff = "";
  const untracked = (await git(dir, "ls-files", "--others", "--exclude-standard"))
    .split("\n")
    .filter(Boolean);
  const SHOW = 20;
  for (const f of untracked.slice(0, SHOW)) {
    try {
      untrackedDiff += await git(dir, "diff", "--no-index", "--", "/dev/null", f);
    } catch (e) {
      // git diff --no-index exits 1 when files differ; the Rust error payload
      // is then the diff itself. Only splice it in if it actually looks like
      // a diff — otherwise it's a real error and doesn't belong in the output.
      const s = String(e);
      if (s.startsWith("diff --git")) untrackedDiff += s;
    }
  }
  if (untracked.length > SHOW) {
    untrackedDiff += `\n… ${untracked.length - SHOW} more untracked file(s) not shown\n`;
  }
  return [staged, unstaged, untrackedDiff].filter((s) => s.trim()).join("\n");
}

export async function commitAll(dir: string, message: string): Promise<string> {
  // Committing during an unresolved merge would bake conflict markers into a
  // merge commit with no warning. Refuse and point at the way out.
  const unmerged = (await git(dir, "diff", "--name-only", "--diff-filter=U")).trim();
  const inMerge = await git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(
    () => true,
    () => false
  );
  if (unmerged || inMerge) {
    throw new Error(
      "A merge with unresolved conflicts is in progress. Resolve the conflicts in your editor, or use Abort merge, before committing."
    );
  }
  await git(dir, "add", "-A");
  return git(dir, "commit", "-m", message);
}

/** Give an otherwise empty repository its first commit so worktrees can exist. */
export async function createInitialCommit(dir: string): Promise<string> {
  await git(dir, "add", "-A");
  return git(dir, "commit", "--allow-empty", "-m", "Initial commit");
}

export async function abortMerge(dir: string): Promise<void> {
  await git(dir, "merge", "--abort");
}

export async function mergeInProgress(dir: string): Promise<boolean> {
  return git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(
    () => true,
    () => false
  );
}

export async function discardAll(dir: string): Promise<void> {
  await git(dir, "reset", "--hard");
  await git(dir, "clean", "-fd");
}

/** Merge the agent's branch into the main checkout. Workspace must be committed first. */
export async function mergeWorkspace(project: Project, agent: Agent): Promise<string> {
  const dirty = (await git(project.local_path, "status", "--porcelain")).trim();
  if (dirty) {
    throw new Error(
      "The main checkout has uncommitted changes — commit or discard them first so a conflicted merge can't eat them."
    );
  }
  return git(project.local_path, "merge", "--no-ff", branchName(agent), "-m",
    `Merge ${branchName(agent)} (Spaces workspace)`);
}

/** Push the agent branch and open a PR; returns the PR URL. */
export async function createPR(project: Project, agent: Agent, title: string): Promise<string> {
  const path = worktreePath(project, agent);
  await git(path, "push", "-u", "origin", branchName(agent));
  const out = await ghIn(path, "pr", "create", "--title", title, "--body",
    `Opened from ${agent.name}'s Spaces workspace.\n\n🤖 Generated with Spaces`);
  const m = out.match(/https:\/\/github\.com\/\S+/);
  return m ? m[0] : out.trim();
}

export async function removeWorkspace(project: Project, agent: Agent): Promise<void> {
  const path = worktreePath(project, agent);
  await git(project.local_path, "worktree", "remove", "--force", path);
  try {
    await git(project.local_path, "branch", "-D", branchName(agent));
  } catch {
    // branch may be merged/checked out elsewhere; leaving it is fine
  }
}
