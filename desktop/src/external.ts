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
    autosend: values.autosend === true,
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

/**
 * Where the agent writes an answer that is words rather than code.
 *
 * Spaces could ask an external teammate anything and could only hear one kind
 * of answer: a commit. Ask Muse for the status of a training run and it does
 * exactly the right thing — reads the run state, changes no files, reports in
 * its own window — and Spaces waits for a commit that is never coming, while
 * the brief has told it plainly that it need not report back by hand.
 *
 * A sibling of the brief, so the two halves of the conversation sit together
 * and an agent that can read one path can write the other.
 */
export function replyPath(agent: Agent): string {
  return handoffPath(agent).replace(/\.md$/, "") + ".reply.md";
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
      `${config.app || "the agent's app"} and do the work in the directory above. ` +
      "Spaces reads code changes straight out of git, so commit them and you need not " +
      "list them by hand.",
    "",
    /*
     * The other half of the return path.
     *
     * Saying only "Spaces reads the result out of git" is a promise that holds
     * for a commit and fails for everything else. Asked a question, a good
     * agent reads, answers, and changes nothing — and the answer had nowhere
     * to go, so the hand-off stayed open for ever and the person was told
     * nothing at all.
     */
    `> If any part of your answer is words rather than code — a status, a finding, a ` +
      `recommendation, a reason you did nothing — write it to \`${replyPath(req.agent)}\` ` +
      "in the project root. Spaces posts that file back into the channel as your reply. " +
      "Markdown, no front matter, and write the answer itself rather than a note saying " +
      "where to look.",
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

  /*
   * Empty the reply before handing over, for the same reason the brief is
   * overwritten rather than appended: an answer to the last question, sitting
   * where the answer to this one goes, would be posted as though it were the
   * reply to what was just asked. Emptied rather than deleted so the path the
   * brief names always exists to be opened.
   */
  try {
    await invoke("write_text_file", {
      root,
      relativePath: replyPath(req.agent),
      contents: "",
    });
  } catch {
    // A brief that was delivered is worth more than a guaranteed-clean reply
    // slot; the staleness guard below is what actually keeps this honest.
  }
  return result;
}

/* ── putting it in front of the agent ────────────────────────── */

export interface Delivery {
  /**
   * Spaces clicked and pasted. On its own this is only "the events were
   * posted" — read `verified` for whether the text was then found in the box.
   */
  delivered: boolean;
  /**
   * The composer was read back afterwards and had the text in it. This is the
   * only field that means the message arrived. It stays false for an app that
   * does not expose its message box, where nobody but a human can tell.
   */
  verified: boolean;
  /**
   * "composer" when Spaces found the message box in the app's own window
   * contents and focused it, "focus" when it relied on the app focusing its
   * own box — which is what a chat window does when you switch to it. Both
   * work; only the first can prove it.
   */
  method: "composer" | "shape" | "";
  /** "" when it worked; otherwise one sentence for the channel. */
  problem: string;
  /** The app Spaces put back in front afterwards. */
  previousApp: string;
  /** Target window in screen points: x, y, width, height. */
  window?: [number, number, number, number];
  /** The message box, when the app published one: x, y, width, height. */
  composer?: [number, number, number, number];
  /** Where Spaces clicked, in screen points. */
  clicked?: [number, number];
}

/** A `Delivery` that never left the building. */
function refused(problem: string): Delivery {
  return { delivered: false, verified: false, method: "", problem, previousApp: "" };
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
  replyFile: string;
  channelName: string;
  authorName: string;
}): string {
  const ask = opts.ask.trim().replace(/\s+/g, " ");
  return [
    `${ask}`,
    "",
    `— from ${opts.authorName} in #${opts.channelName} via Spaces.`,
    opts.workdir ? `Work in ${opts.workdir} and commit code changes there.` : "",
    /*
     * This line has to be here and not only in the brief.
     *
     * The composer message is the one thing the agent is certain to read —
     * everything else is a path it may or may not open. The return path was
     * documented in the brief, and Muse answered the question straight into
     * its own chat window without ever opening the file, which is exactly what
     * a chat app should do when asked something it can already answer. The
     * answer was perfect and unreachable.
     */
    opts.replyFile
      ? `Write your answer to ${opts.replyFile} — that file is how a reply reaches #${opts.channelName}. ` +
        "Answering here only reaches this window."
      : "",
    opts.briefPath ? `Full context: ${opts.briefPath}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Add the permission hint to a failure — after one, and only when it is
 * plausibly the cause.
 *
 * The trust API explains; it never prevents the attempt. It reports stale
 * state after a grant — an app can be switched on in the list and still be
 * told it is not trusted — and a pre-check that is wrong in that direction
 * blocks a feature that would have worked.
 */
async function explain(problem: string): Promise<string> {
  if (!problem) return "";
  if (await automationReady()) return problem;
  return `${problem} If this keeps happening, check Spaces is switched on in System Settings → Privacy & Security → Accessibility — and if it already is, switch it off and on again, which re-records the entry against the current signature.`.trim();
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
  return send(agent, "Spaces can type here. (Test message — nothing was sent.)", false);
}

/**
 * Hand the ask to the app directly, and press send.
 *
 * Muse has no CLI, no scripting dictionary, no local port, and a URL scheme
 * that routes nothing usable. Typing into the window is not a shortcut past an
 * API — it is the only interface the app has, and leaving a file for somebody
 * to notice is not an agent.
 *
 * Silently does nothing when the agent has auto-send off: that is a setting,
 * not a failure, and the caller has already written the brief.
 */
export async function deliverToApp(
  agent: Agent,
  message: string
): Promise<Delivery> {
  if (!externalConfig(agent).autosend) return refused("");
  return send(agent, message, true);
}

/**
 * The one call that drives the app, for both the test and the real hand-off.
 *
 * They differ in exactly two ways — what is typed, and whether return is
 * pressed — and everything else has to stay identical, or the test stops being
 * evidence about the thing it is testing.
 *
 * Returns rather than throws: a hand-off that could not be delivered still
 * happened — the brief is on disk and the git baseline is recorded — so the
 * caller reports the problem and carries on.
 */
async function send(agent: Agent, text: string, submit: boolean): Promise<Delivery> {
  const config = externalConfig(agent);
  if (!config.app && !config.bundleId) {
    return refused(
      submit
        ? `${agent.name} has auto-send on but no app named, so Spaces does not know what to type into.`
        : "Name the app first — Spaces does not know what to type into."
    );
  }

  try {
    const raw = await invoke("send_to_app", {
      bundleId: config.bundleId,
      appName: config.app,
      text,
      submit,
    });
    const result = (raw ?? {}) as Record<string, unknown>;
    const delivered = result.delivered === true;
    const method = result.method === "composer" || result.method === "shape" ? result.method : "";
    const nums = (v: unknown, n: number) =>
      Array.isArray(v) && v.length === n ? (v.map(Number) as number[]) : undefined;
    return {
      delivered,
      verified: result.verified === true,
      method,
      problem: await explain(String(result.problem ?? "")),
      previousApp: String(result.previous_app ?? result.previousApp ?? ""),
      window: nums(result.window, 4) as Delivery["window"],
      composer: nums(result.composer, 4) as Delivery["composer"],
      clicked: nums(result.clicked, 2) as Delivery["clicked"],
    };
  } catch (e) {
    return refused(await explain(String(e)));
  }
}

/* ── closing the loop ────────────────────────────────────────── */

export interface HandOffOutcome {
  /** Commits made in the agent's directory since the hand-off. */
  commits: ExternalActivity["commits"];
  /** Paths dirty now that were not dirty at hand-off. */
  newlyDirty: string[];
  /** What the agent wrote back in prose, if anything. */
  reply: string;
  /** True when nothing at all has happened since. */
  untouched: boolean;
}

/** How much of a written reply is worth carrying into a channel message. */
const REPLY_LIMIT = 6000;

/**
 * Paths Spaces creates itself, which are never anybody's work.
 *
 * `.spaces-workspaces/` is where the per-agent worktrees live and `.hq/` is
 * the generated blackboard; both appear as untracked changes in the checkout
 * and neither was written by the agent being asked about. Left in, the first
 * external hand-off after a worktree is created reports "Muse: 1 uncommitted
 * file — .spaces-workspaces/", which is Spaces describing its own plumbing
 * back to the person as though a teammate had done it.
 */
const SPACES_OWNED = [".spaces-workspaces/", ".hq-workspaces/", ".hq/"];

function spacesOwned(path: string): boolean {
  const clean = path.replace(/^\.\//, "");
  return SPACES_OWNED.some((own) => clean === own.slice(0, -1) || clean.startsWith(own));
}

/**
 * The agent's written answer, if it left one.
 *
 * Read from the project root rather than the agent's working directory: the
 * brief names one path and this reads that same path, so there is never a
 * question of which copy is the real one.
 */
async function readReply(project: Project | undefined, agent: Agent): Promise<string> {
  const root = (project?.local_path ?? "").replace(/\/+$/, "");
  if (!root) return "";
  try {
    const text = await invoke<string>("read_text_file", {
      root,
      relativePath: replyPath(agent),
    });
    const body = (text ?? "").trim();
    return body.length > REPLY_LIMIT ? `${body.slice(0, REPLY_LIMIT)}\n\n…truncated.` : body;
  } catch {
    // No reply file is the ordinary case, not a failure.
    return "";
  }
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
  // An answer counts as much as a commit. An agent asked a question does the
  // right thing by changing nothing, and that used to read as having done
  // nothing at all.
  const reply = await readReply(project, agent);

  /*
   * Git must not be able to swallow the reply.
   *
   * The caller treats a thrown `settleHandOff` as "nothing happened", so a
   * repository that has gone missing, or a checkout nobody can read, would
   * discard an answer that is sitting on disk and perfectly readable. That is
   * the same failure this whole path exists to end: the agent said something
   * and the person was told nothing. The two sources are independent, so a
   * failure in one reports as an absence in that one alone.
   *
   * Without a baseline there is no "since", and activityOf would hand back the
   * last ten commits on the branch — which were there before the brief was
   * written. Reporting those as this agent's work is worse than reporting
   * nothing, so only the working tree is compared.
   */
  const activity = await (baseline.sha
    ? activityOf(project, agent, { since: baseline.sha })
    : activityOf(project, agent)
  ).catch(() => null);

  const was = new Set(baseline.dirty);
  const newlyDirty = (activity?.dirtyFiles ?? []).filter(
    (f) => !was.has(f) && !spacesOwned(f)
  );
  const commits = baseline.sha ? activity?.commits ?? [] : [];
  return {
    commits,
    newlyDirty,
    reply,
    untouched: commits.length === 0 && newlyDirty.length === 0 && !reply,
  };
}

/**
 * Whether any of these agents has left an answer waiting.
 *
 * One small file read each, and no git — which is the point. Settling a
 * hand-off shells out to git several times, so it cannot run every few
 * seconds; noticing that a file now has something in it can. Muse answers in
 * about five seconds and was then sat on for up to forty-five, which reads as
 * the agent being slow when it is only the workspace being asleep.
 */
export async function replyWaiting(
  project: Project | undefined,
  agents: readonly Agent[]
): Promise<boolean> {
  for (const agent of agents) {
    if ((await readReply(project, agent)).trim()) return true;
  }
  return false;
}

/**
 * Forget a reply that has been posted.
 *
 * Reporting is per run, but the reply file is per agent — so a second open
 * hand-off, or a later one that never gets a fresh brief, would otherwise see
 * the same answer still sitting there and post it again. Emptied once it has
 * been said out loud.
 */
export async function consumeReply(project: Project | undefined, agent: Agent): Promise<void> {
  const root = (project?.local_path ?? "").replace(/\/+$/, "");
  if (!root) return;
  try {
    await invoke("write_text_file", { root, relativePath: replyPath(agent), contents: "" });
  } catch {
    // Already gone, or read-only: the run's own meta still stops it repeating.
  }
}

/** One-line summary of a hand-off outcome, for a channel message. */
export function describeOutcome(agent: Agent, outcome: HandOffOutcome): string {
  if (outcome.untouched) return `${agent.name} has not touched the repository since the hand-off.`;
  // An answer with no code behind it is a complete outcome, and saying "0
  // commits" over the top of it would bury the thing actually being reported.
  if (outcome.reply && !outcome.commits.length && !outcome.newlyDirty.length) {
    return `${agent.name} replied:`;
  }
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
