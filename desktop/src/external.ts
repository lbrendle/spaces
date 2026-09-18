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
import { parsePorcelainPaths } from "./gitparse";
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
  /** Type the ask into the app's composer and send it, not just write a file. */
  autosend: boolean;
  /** Where the composer is, in points from the window's bottom-left corner. */
  composerDx: number;
  composerDy: number;
}

export function externalConfig(agent: Agent): ExternalConfig {
  const values = parseArgs(agent.kind, agent.cli_args ?? "");
  const str = (key: string) => {
    const v = values[key];
    return typeof v === "string" ? v.trim() : "";
  };
  const num = (key: string, fallback: number) => {
    const parsed = Number(str(key));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    app: (agent.model ?? "").trim(),
    bundleId: str("bundle_id"),
    workdir: str("workdir"),
    gitAuthor: str("git_author"),
    handoffDir: str("handoff") || ".hq/inbox",
    autosend: values.autosend === true,
    composerDx: num("composer_dx", 160),
    composerDy: num("composer_dy", 34),
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
  const dirtyFiles = parsePorcelainPaths(
    await safe(() => git(workdir, "status", "--porcelain"))
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
    result.baselineDirty = parsePorcelainPaths(
      await safe(() => git(workdir, "status", "--porcelain"))
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

/* ── putting it in front of the agent ────────────────────────── */

export interface Delivery {
  /** True when the message reached the app's composer and was sent. */
  delivered: boolean;
  /** "" when it worked; otherwise one sentence for the channel. */
  problem: string;
  /** The app Spaces put back in front afterwards. */
  previousApp: string;
}

/** Whether Spaces is allowed to drive other applications on this Mac. */
export async function automationReady(): Promise<boolean> {
  return invoke<boolean>("accessibility_trusted").catch(() => false);
}

/**
 * Ask for the Accessibility grant with macOS's own dialog.
 *
 * Better than pointing somebody at System Settings: the system prompt opens
 * the right pane and puts Spaces in the list already, so what is left is one
 * toggle. The grant does not land while this call is running — the dialog is
 * not modal — so the caller polls `automationReady` afterwards.
 */
export async function requestAutomation(): Promise<boolean> {
  return invoke<boolean>("request_accessibility").catch(() => false);
}

/**
 * The message Spaces actually types into the app.
 *
 * Deliberately short. The full brief is a file — it carries the project
 * instructions, the channel charter, the board and the shared-workspace block,
 * and pasting tens of kilobytes into a chat box is not what a person hands a
 * colleague. What goes in the composer is what a person would type: the ask,
 * where to work, and where the rest of it is.
 */
export function composerMessage(opts: {
  agent: Agent;
  ask: string;
  workdir: string;
  briefPath: string;
  channelName: string;
  authorName: string;
}): string {
  const ask = opts.ask.trim().replace(/\s+/g, " ");
  return [
    `${ask}`,
    "",
    `— from ${opts.authorName} in #${opts.channelName} via Spaces.`,
    opts.workdir ? `Work in ${opts.workdir} and commit when you're done.` : "",
    opts.briefPath ? `Full context: ${opts.briefPath}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Type a harmless line into the app, so somebody can find out whether this
 * works before they rely on it in a channel.
 *
 * Deliberately does not press send: verifying that Spaces can reach the
 * composer is the whole question, and posting a test message into somebody's
 * real conversation to answer it is rude. The text is left in the box for them
 * to see and clear.
 */
export async function testDelivery(agent: Agent): Promise<Delivery> {
  const config = externalConfig(agent);
  if (!config.app && !config.bundleId) {
    return {
      delivered: false,
      problem: "Name the app first — Spaces does not know what to type into.",
      previousApp: "",
    };
  }
  if (!(await automationReady())) {
    return {
      delivered: false,
      problem:
        "Spaces does not have Accessibility permission yet, so macOS will not let it type into another app.",
      previousApp: "",
    };
  }
  try {
    const raw = await invoke("send_to_app", {
      bundleId: config.bundleId,
      appName: config.app,
      text: "Spaces can type here. (Test message — nothing was sent.)",
      composerDx: config.composerDx,
      composerDy: config.composerDy,
      submit: false,
    });
    const result = (raw ?? {}) as Record<string, unknown>;
    return {
      delivered: result.delivered === true,
      problem: String(result.problem ?? ""),
      previousApp: String(result.previous_app ?? result.previousApp ?? ""),
    };
  } catch (e) {
    return { delivered: false, problem: String(e), previousApp: "" };
  }
}

/**
 * Hand the ask to the app directly.
 *
 * Muse has no CLI, no scripting dictionary, no local port, and a URL scheme
 * that routes nothing usable; its composer is not in the accessibility tree
 * either. Typing into the window is not a shortcut past an API — it is the
 * only interface the app has, and leaving a file for somebody to notice is not
 * an agent.
 *
 * Returns rather than throws: a hand-off that could not be delivered still
 * happened — the brief is on disk and the git baseline is recorded — so the
 * caller reports the problem and carries on.
 */
export async function deliverToApp(
  agent: Agent,
  message: string
): Promise<Delivery> {
  const config = externalConfig(agent);
  if (!config.autosend) {
    return { delivered: false, problem: "", previousApp: "" };
  }
  if (!config.app && !config.bundleId) {
    return {
      delivered: false,
      problem: `${agent.name} has auto-send on but no app named, so Spaces does not know what to type into.`,
      previousApp: "",
    };
  }

  // Ask the cheap question first. Without Accessibility permission macOS does
  // not refuse, it never answers — so attempting the send would stall the
  // channel for the whole 20-second cap before saying anything useful.
  if (!(await automationReady())) {
    return {
      delivered: false,
      problem:
        "Spaces does not have Accessibility permission, so macOS will not let it type into another app. " +
        "Grant it in System Settings → Privacy & Security → Accessibility, then try again.",
      previousApp: "",
    };
  }

  try {
    const raw = await invoke("send_to_app", {
      bundleId: config.bundleId,
      appName: config.app,
      text: message,
      composerDx: config.composerDx,
      composerDy: config.composerDy,
      submit: true,
    });
    const result = (raw ?? {}) as Record<string, unknown>;
    return {
      delivered: result.delivered === true,
      problem: String(result.problem ?? ""),
      previousApp: String(result.previous_app ?? result.previousApp ?? ""),
    };
  } catch (e) {
    return { delivered: false, problem: String(e), previousApp: "" };
  }
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
  // Without a baseline there is no "since", and activityOf would hand back the
  // last ten commits on the branch — which were there before the brief was
  // written. Reporting those as this agent's work is worse than reporting
  // nothing, so only the working tree is compared.
  if (!baseline.sha) {
    const activity = await activityOf(project, agent);
    const was = new Set(baseline.dirty);
    const newlyDirty = activity.dirtyFiles.filter((f) => !was.has(f));
    return { commits: [], newlyDirty, untouched: newlyDirty.length === 0 };
  }

  const activity = await activityOf(project, agent, { since: baseline.sha });
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
