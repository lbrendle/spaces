/**
 * coordination.ts — what every agent on a project is doing to the code, right
 * now, in one read.
 *
 * Agents on a project share one git object database. collab.ts already used
 * that to tell an agent which branches its teammates were on. This module goes
 * the rest of the way, because "who is on which branch" is not the question
 * that actually costs people work. These are:
 *
 *   - is anyone else editing the file I am about to edit?  (`overlaps`)
 *   - will my branch land, or will it conflict?             (`mergeCheck`)
 *   - in what order should today's branches land?           (`integrationPlan`)
 *
 * All three are answerable from the shared object store without checking
 * anything out, and the last two are answerable *before* a merge is attempted:
 * `git merge-tree --write-tree` performs a real merge in memory and reports the
 * conflicted paths, and chaining it through `commit-tree` simulates a whole
 * landing sequence. That is the difference between an integration queue that
 * predicts and one that just hopes.
 *
 * External agents (external.ts) are first-class here. A teammate running in
 * Muse or Cursor produces exactly the same evidence — commits and a dirty tree
 * — and leaving it out of the overlap check would make the check wrong in the
 * case it matters most.
 *
 * Everything is best-effort: prompt building and UI rendering must never fail
 * because a git command did.
 */
import { git, isGitRepo, branchName, worktreePath } from "./workspaces";
import { isObjectId, parseMergeTree, parsePorcelainPaths } from "./gitparse";
import { isExternal } from "./capabilities";
import { externalConfig, externalWorkdir } from "./external";
import type { Agent, Project } from "./types";

/* ── shared helpers ──────────────────────────────────────────── */

async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return "";
  }
}

/**
 * git commands that report their answer on stdout but exit non-zero to signal
 * a *result* rather than a failure — `merge-tree` with conflicts is the one
 * that matters. run_git turns a non-zero exit into a rejected promise carrying
 * whichever stream had content, so the answer arrives as an error string.
 */
async function gitAllowingFailure(cwd: string, ...args: string[]): Promise<{ out: string; failed: boolean }> {
  try {
    return { out: await git(cwd, ...args), failed: false };
  } catch (e) {
    return { out: e instanceof Error ? e.message : String(e), failed: true };
  }
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
}

function count(out: string): number {
  return parseInt(out.trim(), 10) || 0;
}

/** The branch agents integrate into: origin's default if known, else HEAD. */
export async function integrationBase(project: Project): Promise<string> {
  const ref = (await safe(() =>
    git(project.local_path, "symbolic-ref", "refs/remotes/origin/HEAD")
  )).trim();
  const short = ref.replace("refs/remotes/origin/", "").trim();
  if (short) return short;
  const head = (await safe(() =>
    git(project.local_path, "rev-parse", "--abbrev-ref", "HEAD")
  )).trim();
  return head || "main";
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  if (!branch) return false;
  return (await safe(() => git(dir, "rev-parse", "--verify", "-q", `refs/heads/${branch}`))).trim() !== "";
}

/* ── the map ─────────────────────────────────────────────────── */

/** One agent's position in the shared repository. */
export interface AgentLane {
  agent: Agent;
  /** "spawned" agents Spaces launches; "external" ones run in their own app. */
  kind: "spawned" | "external";
  /** The branch this agent's work lives on. "" when it has none yet. */
  branch: string;
  /** Where it edits. A worktree, a separate checkout, or the shared checkout. */
  workdir: string;
  /** True when Spaces could read a git repository at `workdir`. */
  readable: boolean;
  /** Commits on `branch` that `base` does not have. */
  ahead: number;
  /** Commits on `base` that `branch` does not have — how stale it is. */
  behind: number;
  /** Paths changed on the branch relative to base. */
  committedFiles: string[];
  /** Paths changed in the working tree and not yet committed. */
  dirtyFiles: string[];
  lastSubject: string;
  lastAt: number;
  adds: number;
  dels: number;
  /**
   * True when this agent works directly in the project checkout rather than in
   * a space of its own — which is what makes overlap dangerous rather than
   * merely worth knowing.
   */
  sharesCheckout: boolean;
}

export interface Overlap {
  path: string;
  /** Always two or more. */
  agents: Array<{ agentId: string; agentName: string; state: "uncommitted" | "committed" }>;
  /**
   * "live" — two agents have *uncommitted* edits to this path at the same time,
   *   in the same tree. One of them is going to lose work.
   * "diverging" — both have committed changes on different branches. It will
   *   surface as a merge conflict later, which is recoverable but avoidable.
   */
  severity: "live" | "diverging";
}

export interface WorkspaceMap {
  base: string;
  baseSha: string;
  lanes: AgentLane[];
  overlaps: Overlap[];
  /** "" unless the map could not be built at all. */
  error: string;
  generatedAt: number;
}

const MAX_FILES_PER_LANE = 200;

async function laneFor(project: Project, agent: Agent, base: string): Promise<AgentLane> {
  const external = isExternal(agent.kind);
  const root = project.local_path;
  const workdir = external
    ? externalWorkdir(project, agent)
    : project.isolate
      ? worktreePath(project, agent)
      : root;

  const lane: AgentLane = {
    agent,
    kind: external ? "external" : "spawned",
    branch: "",
    workdir,
    readable: false,
    ahead: 0,
    behind: 0,
    committedFiles: [],
    dirtyFiles: [],
    lastSubject: "",
    lastAt: 0,
    adds: 0,
    dels: 0,
    sharesCheckout: workdir.replace(/\/+$/, "") === root.replace(/\/+$/, ""),
  };

  const usable = workdir !== "" && (await isGitRepo(workdir).catch(() => false));
  lane.readable = usable;
  if (usable) {
    lane.dirtyFiles = parsePorcelainPaths(
      await safe(() => git(workdir, "status", "--porcelain"))
    ).slice(0, MAX_FILES_PER_LANE);
  }

  // Which branch holds this agent's committed work. A spawned agent in an
  // isolated project has a branch Spaces named; everyone else is on whatever
  // their working directory has checked out.
  const named = external ? "" : branchName(agent);
  if (named && (await branchExists(root, named))) {
    lane.branch = named;
  } else if (usable) {
    lane.branch = (await safe(() => git(workdir, "rev-parse", "--abbrev-ref", "HEAD"))).trim();
  }

  if (!lane.branch || lane.branch === "HEAD" || lane.branch === base) {
    // Nothing of its own to compare against base. Its dirty files still count.
    return lane;
  }
  if (!(await branchExists(root, lane.branch))) return lane;

  const [aheadRaw, behindRaw, last, numstat] = await Promise.all([
    safe(() => git(root, "rev-list", "--count", `${base}..${lane.branch}`)),
    safe(() => git(root, "rev-list", "--count", `${lane.branch}..${base}`)),
    safe(() => git(root, "log", "-1", "--pretty=format:%at%x1f%s", lane.branch)),
    safe(() => git(root, "diff", "--numstat", `${base}...${lane.branch}`)),
  ]);
  lane.ahead = count(aheadRaw);
  lane.behind = count(behindRaw);

  const [atRaw, subject] = last.split("\x1f");
  lane.lastAt = (parseInt(atRaw ?? "", 10) || 0) * 1000;
  lane.lastSubject = (subject ?? "").trim();

  for (const row of lines(numstat).slice(0, MAX_FILES_PER_LANE)) {
    const [add, del, path] = row.split("\t");
    if (!path) continue;
    lane.committedFiles.push(path);
    lane.adds += parseInt(add, 10) || 0;
    lane.dels += parseInt(del, 10) || 0;
  }

  return lane;
}

/**
 * Paths more than one agent is changing.
 *
 * Two agents with uncommitted edits to the same path *in the same tree* is the
 * expensive case — that is not a merge conflict waiting to happen, it is one
 * agent about to overwrite the other's unsaved work, with no git record that it
 * happened. Rank it above the recoverable kind.
 */
export function overlapsOf(lanes: readonly AgentLane[]): Overlap[] {
  const byPath = new Map<string, Map<string, { name: string; state: "uncommitted" | "committed"; shared: boolean }>>();

  const note = (
    path: string,
    lane: AgentLane,
    state: "uncommitted" | "committed"
  ) => {
    let entry = byPath.get(path);
    if (!entry) byPath.set(path, (entry = new Map()));
    const existing = entry.get(lane.agent.id);
    // An uncommitted edit is the stronger signal; never downgrade it.
    if (existing?.state === "uncommitted") return;
    entry.set(lane.agent.id, { name: lane.agent.name, state, shared: lane.sharesCheckout });
  };

  for (const lane of lanes) {
    for (const path of lane.dirtyFiles) note(path, lane, "uncommitted");
    for (const path of lane.committedFiles) note(path, lane, "committed");
  }

  const out: Overlap[] = [];
  for (const [path, entry] of byPath) {
    if (entry.size < 2) continue;
    const agents = [...entry].map(([agentId, v]) => ({
      agentId,
      agentName: v.name,
      state: v.state,
    }));
    const liveInSharedTree =
      [...entry.values()].filter((v) => v.state === "uncommitted" && v.shared).length > 1;
    out.push({ path, agents, severity: liveInSharedTree ? "live" : "diverging" });
  }

  // Live collisions first, then the widest fan-out, then alphabetically so the
  // list is stable between reads.
  return out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "live" ? -1 : 1;
    if (a.agents.length !== b.agents.length) return b.agents.length - a.agents.length;
    return a.path.localeCompare(b.path);
  });
}

/** Everything every agent on this project is doing to the code. */
export async function workspaceMap(project: Project, agents: readonly Agent[]): Promise<WorkspaceMap> {
  const empty: WorkspaceMap = {
    base: "",
    baseSha: "",
    lanes: [],
    overlaps: [],
    error: "",
    generatedAt: Date.now(),
  };
  if (!project.local_path) {
    return { ...empty, error: "This project has no local checkout." };
  }
  if (!(await isGitRepo(project.local_path).catch(() => false))) {
    return { ...empty, error: `${project.local_path} is not a git repository.` };
  }

  const base = await integrationBase(project);
  const baseSha = (await safe(() => git(project.local_path, "rev-parse", base))).trim();
  const lanes = await Promise.all(
    agents.map((a) => laneFor(project, a, base).catch((): AgentLane | null => null))
  );
  const kept = lanes.filter((l): l is AgentLane => l !== null);

  return {
    base,
    baseSha,
    lanes: kept,
    overlaps: overlapsOf(kept),
    error: "",
    generatedAt: Date.now(),
  };
}

/* ── will it land? ───────────────────────────────────────────── */

export interface MergeCheck {
  branch: string;
  /** What it was merged against — the base, or the simulated tree before it. */
  against: string;
  clean: boolean;
  /** Paths git could not merge automatically. */
  conflicts: string[];
  /** Tree object of the successful merge, for chaining a simulated sequence. */
  tree: string;
  /** "" unless the check itself could not run. */
  error: string;
}

/**
 * Merge `branch` into `against` in memory and report what would conflict.
 *
 * Nothing is checked out, no index is touched, and no commit is made — this is
 * safe to run against a repository someone is actively working in, which is the
 * only reason it can be used to keep a live view honest.
 */
export async function mergeCheck(
  project: Project,
  branch: string,
  against: string
): Promise<MergeCheck> {
  const result: MergeCheck = {
    branch,
    against,
    clean: false,
    conflicts: [],
    tree: "",
    error: "",
  };
  if (!project.local_path) {
    result.error = "This project has no local checkout.";
    return result;
  }
  if (!branch || !against) {
    result.error = "Nothing to compare.";
    return result;
  }

  const { out, failed } = await gitAllowingFailure(
    project.local_path,
    "merge-tree",
    "--write-tree",
    "--name-only",
    against,
    branch
  );
  const parsed = parseMergeTree(out);

  // A conflicted merge-tree exits 1 with its answer on stdout; a *broken* one
  // exits 128 with a message and no tree OID. Telling them apart is the
  // difference between "this will conflict" and "Spaces could not tell".
  if (!isObjectId(parsed.tree)) {
    result.error = out.trim().split("\n").slice(0, 3).join(" ").slice(0, 300) || "git could not merge these.";
    return result;
  }

  result.tree = parsed.tree;
  result.conflicts = parsed.conflicts;
  result.clean = !failed && parsed.conflicts.length === 0;
  return result;
}

/* ── the landing order ───────────────────────────────────────── */

export interface IntegrationStep {
  lane: AgentLane;
  /**
   * 1-based position in the sequence, for both clean and blocked branches.
   * A blocked branch keeps the position it was *tested* at — reading it out of
   * sequence is what makes "conflicts once 2 earlier branches are in" sound
   * wrong when it is sitting below four of them.
   */
  position: number;
  /** 1-based position among the branches that actually land; 0 when blocked. */
  order: number;
  check: MergeCheck;
  /** Why it is where it is, in one line. */
  note: string;
}

export interface IntegrationPlan {
  base: string;
  /** Branches that land cleanly, in the order they should be merged. */
  steps: IntegrationStep[];
  /** Branches that cannot land as they are, with the paths that stop them. */
  blocked: IntegrationStep[];
  /** Lanes with no committed work to land. */
  idle: AgentLane[];
  error: string;
}

/**
 * The order today's branches should land in, and which ones will not.
 *
 * Merges are simulated in sequence: each clean result becomes a throwaway
 * commit that the next branch is tested against, so the plan accounts for
 * branches that conflict *with each other* and not only with the base. That is
 * the case an integration queue exists for — two agents that each merge fine
 * alone and collide when the second one follows the first.
 *
 * The throwaway commits are unreferenced objects; git garbage-collects them.
 * Nothing is checked out and no branch is moved — running this is safe while
 * agents are mid-turn.
 *
 * Smallest branch first, because a large branch that conflicts is cheaper to
 * rebase than a small one is to wait behind it.
 */
export async function integrationPlan(
  project: Project,
  map: WorkspaceMap
): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = {
    base: map.base,
    steps: [],
    blocked: [],
    idle: [],
    error: map.error,
  };
  if (map.error || !project.local_path) return plan;

  const landable = map.lanes.filter((l) => l.branch && l.branch !== map.base && l.ahead > 0);
  plan.idle = map.lanes.filter((l) => !landable.includes(l));

  const ordered = [...landable].sort((a, b) => {
    const sizeA = a.adds + a.dels;
    const sizeB = b.adds + b.dels;
    if (sizeA !== sizeB) return sizeA - sizeB;
    return a.lastAt - b.lastAt;
  });

  // `against` walks forward as branches land: first the base, then a simulated
  // commit standing for "base plus everything already in the plan".
  let against = map.base;
  let landed = 0;
  let position = 0;

  for (const lane of ordered) {
    position += 1;
    const check = await mergeCheck(project, lane.branch, against).catch(
      (e): MergeCheck => ({
        branch: lane.branch,
        against,
        clean: false,
        conflicts: [],
        tree: "",
        error: String(e),
      })
    );

    if (!check.clean) {
      plan.blocked.push({
        lane,
        position,
        order: 0,
        check,
        note: check.error
          ? `Spaces could not test this merge: ${check.error}`
          : landed === 0
            ? `Conflicts with ${map.base} in ${check.conflicts.length} file${check.conflicts.length === 1 ? "" : "s"}. Rebase it before it can land.`
            : `Lands fine on its own, but conflicts once ${landed} earlier branch${landed === 1 ? "" : "es"} ${landed === 1 ? "is" : "are"} in. Whoever goes second rebases.`,
      });
      continue;
    }

    landed += 1;
    plan.steps.push({
      lane,
      position,
      order: landed,
      check,
      note: `${lane.ahead} commit${lane.ahead === 1 ? "" : "s"}, ${lane.committedFiles.length} file${lane.committedFiles.length === 1 ? "" : "s"} — merges cleanly.`,
    });

    // Stand the merged tree up as a commit so the next branch is tested against
    // the world as it will be, not as it is.
    const next = (await safe(() =>
      git(
        project.local_path,
        "commit-tree",
        check.tree,
        "-p",
        against === map.base ? map.baseSha || map.base : against,
        "-m",
        `spaces: simulated landing of ${lane.branch}`
      )
    )).trim();
    if (next) against = next;
    else break; // cannot simulate further; stop rather than report a false clean
  }

  return plan;
}

/* ── landing one ─────────────────────────────────────────────── */

export type LandResult =
  | { ok: true; message: string }
  | { ok: false; reason: string; hint: string };

/**
 * Merge one branch into the integration base, for real.
 *
 * The plan above is a prediction; this is the act. It is deliberately strict
 * about the preconditions rather than clever about recovering from them: a
 * merge run against a dirty tree, or into whatever branch happened to be
 * checked out, is how someone loses an afternoon. Every refusal names the one
 * thing to do about it.
 *
 * `--no-ff` always, so the branch stays legible in the history as one agent's
 * piece of work rather than being flattened into the base.
 */
export async function land(
  project: Project,
  branch: string,
  base: string
): Promise<LandResult> {
  const root = project.local_path;
  if (!root) {
    return { ok: false, reason: "This project has no local checkout.", hint: "Set one in the project's settings." };
  }
  if (!branch || branch === base) {
    return { ok: false, reason: "Nothing to land.", hint: "" };
  }
  if (!(await isGitRepo(root).catch(() => false))) {
    return { ok: false, reason: `${root} is not a git repository.`, hint: "" };
  }

  const inMerge = await git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(
    () => true,
    () => false
  );
  if (inMerge) {
    return {
      ok: false,
      reason: "A merge is already in progress in the main checkout.",
      hint: "Finish or abort it before landing anything else.",
    };
  }

  const dirty = (await safe(() => git(root, "status", "--porcelain"))).trim();
  if (dirty) {
    return {
      ok: false,
      reason: "The main checkout has uncommitted changes.",
      hint: "Commit or discard them first — a conflicted merge would land on top of them.",
    };
  }

  const head = (await safe(() => git(root, "rev-parse", "--abbrev-ref", "HEAD"))).trim();
  if (head !== base) {
    return {
      ok: false,
      reason: `The main checkout is on \`${head || "a detached HEAD"}\`, not \`${base}\`.`,
      hint: `Check out ${base} first, so this lands where the plan says it will.`,
    };
  }

  try {
    await git(root, "merge", "--no-ff", branch, "-m", `Merge ${branch} (Spaces)`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A merge that stops on conflicts leaves the tree mid-merge. Back it out:
    // the prediction said this would be clean, so a surprise conflict is not
    // something to strand the user's checkout in.
    await git(root, "merge", "--abort").catch(() => "");
    return {
      ok: false,
      reason: `git refused to merge ${branch}: ${message.split("\n")[0]}`,
      hint: "The working tree was left as it was. Re-read the plan — the branch may have moved since it was checked.",
    };
  }

  const sha = (await safe(() => git(root, "rev-parse", "HEAD"))).trim();
  return { ok: true, message: `Merged \`${branch}\` into \`${base}\` as ${sha.slice(0, 7)}.` };
}

/** The command to bring a blocked branch up to date, for someone to run themselves. */
export function rebaseCommand(lane: AgentLane, base: string): string {
  return `git -C ${lane.workdir || "<worktree>"} rebase ${base}`;
}

/* ── prompt copy ─────────────────────────────────────────────── */

function bullet(lane: AgentLane, base: string): string {
  const bits: string[] = [];
  if (lane.ahead) bits.push(`${lane.ahead} commit${lane.ahead === 1 ? "" : "s"} ahead of ${base}`);
  if (lane.behind) bits.push(`${lane.behind} behind`);
  if (lane.dirtyFiles.length) {
    bits.push(`${lane.dirtyFiles.length} uncommitted file${lane.dirtyFiles.length === 1 ? "" : "s"}`);
  }
  if (!bits.length) bits.push("nothing yet");
  const where = lane.kind === "external" ? ` · runs in ${externalConfig(lane.agent).app || "its own app"}` : "";
  return `**${lane.agent.name}** — \`${lane.branch || "(no branch)"}\` (${bits.join(", ")})${where}`;
}

/**
 * The shared-workspace section of an agent's prompt.
 *
 * Written to be acted on, not admired: it leads with the paths someone else is
 * holding right now, because that is the only part that changes what the agent
 * should do in the next thirty seconds.
 */
export function collaborationText(
  map: WorkspaceMap,
  me: Agent | null,
  opts: { isolated: boolean; cwd: string }
): string {
  if (map.error) return "";
  const mine = me ? map.lanes.find((l) => l.agent.id === me.id) ?? null : null;
  const others = map.lanes.filter((l) => l.agent.id !== me?.id);
  const out: string[] = ["\n## Shared workspace"];

  if (opts.isolated && me) {
    out.push(
      `You are in your own git worktree at ${opts.cwd}, on \`${mine?.branch || branchName(me)}\`. ` +
        `Commit freely — nothing you commit reaches anyone else until it is merged into \`${map.base}\`.`
    );
  } else {
    out.push(
      `You are in the shared checkout at ${opts.cwd} on \`${map.base}\`. ` +
        `Other agents and the user work in this same tree — do not switch branches, and do not commit unless asked.`
    );
  }
  if (mine?.behind) {
    out.push(
      `\n⚠️ Your branch is ${mine.behind} commit${mine.behind === 1 ? "" : "s"} behind \`${map.base}\`. ` +
        `Rebase before you go far, or your merge will be a conflict resolution rather than a merge.`
    );
  }

  // The part that actually prevents lost work.
  const relevant = map.overlaps.filter((o) => !me || o.agents.some((a) => a.agentId === me.id));
  if (relevant.length) {
    out.push("\n### Files someone else is holding");
    const live = relevant.filter((o) => o.severity === "live");
    if (live.length) {
      out.push(
        `These are being edited **right now, in this same working tree**, by someone else. ` +
          `Writing them will destroy work that git has no record of. Coordinate in the channel first, or pick different files.`
      );
      for (const o of live.slice(0, 15)) {
        out.push(`- \`${o.path}\` — ${o.agents.map((a) => a.agentName).join(", ")}`);
      }
    }
    const diverging = relevant.filter((o) => o.severity === "diverging");
    if (diverging.length) {
      out.push(
        live.length ? "\nAlso changed on more than one branch (a merge conflict later):" : "Changed on more than one branch — a merge conflict later:"
      );
      for (const o of diverging.slice(0, 15)) {
        out.push(`- \`${o.path}\` — ${o.agents.map((a) => a.agentName).join(", ")}`);
      }
    }
  }

  if (others.length) {
    out.push(
      "\n### Your teammates' work",
      "Everyone here shares one git object database, so you can read any teammate's work directly — no need to ask them to paste it."
    );
    for (const lane of others) {
      out.push(`\n${bullet(lane, map.base)}`);
      if (lane.lastSubject) out.push(`  last commit: ${lane.lastSubject}`);
      const files = lane.committedFiles.slice(0, 8);
      if (files.length) {
        out.push(
          `  changed: ${files.join(", ")}${lane.committedFiles.length > 8 ? `, +${lane.committedFiles.length - 8} more` : ""}`
        );
      }
      if (lane.kind === "external") {
        out.push(
          `  Spaces does not launch ${lane.agent.name}; it works in ${lane.workdir || "its own checkout"}. Read its commits, don't @-mention it expecting a reply in this turn.`
        );
      }
    }
    const example = others.find((l) => l.branch && l.branch !== map.base)?.branch;
    if (example) {
      out.push(
        "\nTo read a teammate's work (read-only — never commit to their branch):",
        "```sh",
        `git log ${map.base}..${example}          # what they did`,
        `git diff ${map.base}...${example}        # the full diff`,
        `git show ${example}:path/to/file     # a file as they have it`,
        "```",
        "If you are asked to review a teammate, read their actual diff before commenting on it."
      );
    }
  }

  return out.join("\n");
}
