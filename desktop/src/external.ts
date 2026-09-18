/**
 * external.ts — teammates Spaces does not launch.
 *
 * Muse, the Cursor app, Zed's agent, a Claude Code terminal someone drives by
 * hand: all of them edit the same repository, and none of them can be spawned
 * headlessly. Spaces used to have no way to represent them, which meant the
 * roster, the branch lanes and every other agent's prompt silently pretended
 * they were not there — while they were actively changing the same files.
 *
 * The fix is not to pretend Spaces can drive them. It is to make the *shared
 * repository* the interface, which it already was:
 *
 *   - `activityOf` reads what an external agent has actually done, from git,
 *     so it appears in the collaboration block and the branch lanes exactly
 *     like a spawned agent does.
 *   - `handOff` writes a brief where that agent (or the person driving it) will
 *     find it, and records the tree it was handed, so the *next* turn can say
 *     what changed rather than asking.
 *   - `settleHandOff` closes the loop by diffing against that record.
 *
 * Everything here is best-effort against git and the filesystem: a hand-off
 * must never fail because a `git log` did.
 */
import { invoke } from "@tauri-apps/api/core";
import { git, isGitRepo } from "./workspaces";
import { parseArgs } from "./capabilities";
import { slug } from "./types";
import type { Agent, Project } from "./types";

/** How an external teammate is wired to the repository. */
export interface ExternalConfig {
  /** Product name, e.g. "Muse". */
  app: string;
  /** macOS bundle id, "" when not set. */
  bundleId: string;
  /** Absolute path where it edits code. "" means the project checkout. */
  workdir: string;
  /** Substring matched against commit author name/email. "" means no match. */
  gitAuthor: string;
  /** Project-relative directory for hand-off briefs. */
  handoffDir: string;
}

export function externalConfig(agent: Agent): ExternalConfig {
  const values = parseArgs(agent.kind, agent.cli_args ?? "");
  const str = (key: string) => {
    const v = values[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    app: (agent.model ?? "").trim(),
    bundleId: str("bundle_id"),
    workdir: str("workdir"),
    gitAuthor: str("git_author"),
    handoffDir: str("handoff") || ".hq/inbox",
  };
}

/** Where this agent works: its own directory if it has one, else the checkout. */
export function externalWorkdir(project: Project | undefined, agent: Agent): string {
  const configured = externalConfig(agent).workdir;
  if (configured) return configured.replace(/\/+$/, "");
  return (project?.local_path ?? "").replace(/\/+$/, "");
}

/** The brief's path, relative to the project root. */
export function handoffPath(agent: Agent): string {
  const dir = externalConfig(agent).handoffDir.replace(/^\/+|\/+$/g, "");
  return `${dir}/${slug(agent.name) || agent.id.slice(0, 8)}.md`;
}

async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return "";
  }
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
}

/* ── what it has actually done ───────────────────────────────── */

export interface ExternalActivity {
  /** Where the evidence came from — useful copy when nothing was found. */
  workdir: string;
  /** Branch checked out in that directory, "" when unknown. */
  branch: string;
  /** Uncommitted paths in that directory. */
  dirtyFiles: string[];
  /** Recent commits Spaces attributes to this agent. */
  commits: Array<{ sha: string; subject: string; at: number; files: string[] }>;
  /** True when the directory is a git repo Spaces could read at all. */
  readable: boolean;
  /** How the commits were attributed, for honesty in the UI. */
  attribution: "git-author" | "working-directory" | "none";
}

const RECENT_COMMITS = 10;
const FILES_PER_COMMIT = 12;

/**
 * Read an external agent's work out of git.
 *
 * Two ways to attribute a commit, in order of confidence:
 *   1. a configured author substring — exact, and works even in a shared
 *      checkout where several agents commit to the same branch;
 *   2. the working directory — right when the agent has a checkout or worktree
 *      of its own, and the only option when nothing is configured.
 *
 * When neither applies, this reports `attribution: "none"` and no commits,
 * rather than claiming whatever happens to be at HEAD.
 */
export async function activityOf(
  project: Project | undefined,
  agent: Agent,
  opts: { since?: string } = {}
): Promise<ExternalActivity> {
  const workdir = externalWorkdir(project, agent);
  const config = externalConfig(agent);
  const empty: ExternalActivity = {
    workdir,
    branch: "",
    dirtyFiles: [],
    commits: [],
    readable: false,
    attribution: "none",
  };
  if (!workdir) return empty;
  if (!(await isGitRepo(workdir).catch(() => false))) return empty;

  const branch = (await safe(() => git(workdir, "rev-parse", "--abbrev-ref", "HEAD"))).trim();
  const dirtyFiles = lines(await safe(() => git(workdir, "status", "--porcelain"))).map((l) =>
    l.slice(3).trim()
  );

  const ownDirectory = config.workdir !== "" && config.workdir !== (project?.local_path ?? "");
  const attribution: ExternalActivity["attribution"] = config.gitAuthor
    ? "git-author"
    : ownDirectory
      ? "working-directory"
      : "none";

  const commits: ExternalActivity["commits"] = [];
  if (attribution !== "none") {
    const range = opts.since ? [`${opts.since}..HEAD`] : [`-${RECENT_COMMITS}`];
    const args = [
      "log",
      ...range,
      "--pretty=format:%H%x1f%at%x1f%s",
      ...(config.gitAuthor ? ["--author", config.gitAuthor, "--regexp-ignore-case"] : []),
    ];
    for (const row of lines(await safe(() => git(workdir, ...args)))) {
      const [sha, at, subject] = row.split("\x1f");
      if (!sha) continue;
      const files = lines(
        await safe(() => git(workdir, "show", "--name-only", "--format=", sha))
      ).slice(0, FILES_PER_COMMIT);
      commits.push({
        sha,
        subject: (subject ?? "").trim(),
        at: (parseInt(at ?? "", 10) || 0) * 1000,
        files,
      });
      if (commits.length >= RECENT_COMMITS) break;
    }
  }

  return { workdir, branch, dirtyFiles, commits, readable: true, attribution };
}

/* ── handing work over ───────────────────────────────────────── */

export interface HandOffRequest {
  project: Project | undefined;
  agent: Agent;
  /** The full composed prompt — the same one a spawned agent would receive. */
  brief: string;
  /** Short line for the top of the file and the channel notice. */
  ask: string;
  channelName: string;
  authorName: string;
  runId: string;
}

export interface HandOffResult {
  /** Absolute path written, "" when the project has no checkout. */
  path: string;
  /** Project-relative path, for copy in the UI. */
  relativePath: string;
  /** HEAD in the agent's working directory when it was handed over. */
  baselineSha: string;
  /** Uncommitted paths at hand-off, so later noise can be told from new work. */
  baselineDirty: string[];
  error: string;
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Write the brief where the external agent will find it, and record the tree it
 * was handed.
 *
 * The file is the whole prompt, not a summary — the same context a spawned
 * agent gets, so the work is comparable. It is overwritten rather than
 * appended: a stale brief above a current one is how someone ends up doing
 * last week's task.
 */
export async function handOff(req: HandOffRequest): Promise<HandOffResult> {
  const root = (req.project?.local_path ?? "").replace(/\/+$/, "");
  const relativePath = handoffPath(req.agent);
  const result: HandOffResult = {
    path: "",
    relativePath,
    baselineSha: "",
    baselineDirty: [],
    error: "",
  };
  if (!root) {
    result.error = "This project has no local checkout, so there is nowhere to leave a brief.";
    return result;
  }

  const workdir = externalWorkdir(req.project, req.agent);
  if (workdir && (await isGitRepo(workdir).catch(() => false))) {
    result.baselineSha = (await safe(() => git(workdir, "rev-parse", "HEAD"))).trim();
    result.baselineDirty = lines(await safe(() => git(workdir, "status", "--porcelain"))).map((l) =>
      l.slice(3).trim()
    );
  }

  const config = externalConfig(req.agent);
  const body = [
    `# Brief for ${req.agent.name}`,
    "",
    `- **from** ${req.authorName} in #${req.channelName}`,
    `- **at** ${stamp(Date.now())}`,
    `- **run** ${req.runId}`,
    config.workdir ? `- **work in** ${config.workdir}` : "",
    result.baselineSha ? `- **tree handed over** ${result.baselineSha.slice(0, 12)}` : "",
    "",
    "> Spaces does not launch this agent. This file is the hand-off: open it in " +
      `${config.app || "the agent's app"}, do the work in the directory above, and commit. ` +
      "Spaces reads the result out of git — you do not need to report back by hand.",
    "",
    "---",
    "",
    req.ask.trim(),
    "",
    "---",
    "",
    "## Full context",
    "",
    req.brief.trim(),
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    await invoke("write_text_file", {
      root,
      relativePath,
      contents: body,
    });
    result.path = `${root}/${relativePath}`;
  } catch (e) {
    result.error = String(e);
  }
  return result;
}

/* ── closing the loop ────────────────────────────────────────── */

export interface HandOffOutcome {
  /** Commits made in the agent's directory since the hand-off. */
  commits: ExternalActivity["commits"];
  /** Paths dirty now that were not dirty at hand-off. */
  newlyDirty: string[];
  /** True when nothing at all has happened since. */
  untouched: boolean;
}

/**
 * What the external agent did with a brief.
 *
 * Diffs against the baseline `handOff` recorded rather than against "recently",
 * so a teammate that took two days still gets credited for exactly its own
 * work, and a teammate that did nothing is reported as having done nothing.
 */
export async function settleHandOff(
  project: Project | undefined,
  agent: Agent,
  baseline: { sha: string; dirty: readonly string[] }
): Promise<HandOffOutcome> {
  const activity = await activityOf(project, agent, baseline.sha ? { since: baseline.sha } : {});
  const was = new Set(baseline.dirty);
  const newlyDirty = activity.dirtyFiles.filter((f) => !was.has(f));
  return {
    commits: activity.commits,
    newlyDirty,
    untouched: activity.commits.length === 0 && newlyDirty.length === 0,
  };
}

/** One-line summary of a hand-off outcome, for a channel message. */
export function describeOutcome(agent: Agent, outcome: HandOffOutcome): string {
  if (outcome.untouched) return `${agent.name} has not touched the repository since the hand-off.`;
  const bits: string[] = [];
  if (outcome.commits.length) {
    bits.push(`${outcome.commits.length} commit${outcome.commits.length === 1 ? "" : "s"}`);
  }
  if (outcome.newlyDirty.length) {
    bits.push(`${outcome.newlyDirty.length} uncommitted file${outcome.newlyDirty.length === 1 ? "" : "s"}`);
  }
  const head = outcome.commits[0];
  return `${agent.name}: ${bits.join(", ")}${head?.subject ? ` — latest "${head.subject}"` : ""}.`;
}
