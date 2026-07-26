/**
 * Collaboration context.
 *
 * Agents in a project share one git object database — each agent works in its
 * own worktree, but every worktree can read every other branch (verified: a
 * teammate can `git log`, `git diff` and `git show` another agent's branch
 * without checking it out). That means the substrate for real collaboration is
 * already there; agents just don't know it exists.
 *
 * This module turns that latent capability into prompt context: who your
 * teammates are, which branch each is working on, what they have changed, and
 * the exact commands to read their work. Reviewing a teammate's actual diff is
 * the difference between agents talking past each other and collaborating.
 *
 * Everything here is best-effort: prompt building must never fail because a
 * git command did.
 */
import { git, branchName, worktreePath, isGitRepo } from "./workspaces";
import type { Agent, Project } from "./types";
import { slug } from "./types";

export interface BranchState {
  agent: Agent;
  branch: string;
  /** commits on this branch that the integration branch doesn't have */
  ahead: number;
  /** uncommitted changes in that agent's worktree */
  dirty: number;
  lastSubject: string;
  lastAt: number;
  /** "path | +adds -dels" per file, capped */
  diffstat: string[];
}

async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return "";
  }
}

/** The branch agents integrate into: origin's default if known, else HEAD. */
export async function integrationBranch(project: Project): Promise<string> {
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
  const out = await safe(() => git(dir, "branch", "--list", branch));
  return out.trim().length > 0;
}

/** What one agent has done on its branch, as seen from the shared object store. */
export async function branchStateOf(
  project: Project,
  agent: Agent,
  base: string
): Promise<BranchState | null> {
  const branch = branchName(agent);
  if (!(await branchExists(project.local_path, branch))) return null;

  const aheadRaw = await safe(() =>
    git(project.local_path, "rev-list", "--count", `${base}..${branch}`)
  );
  const ahead = parseInt(aheadRaw.trim(), 10) || 0;

  // "<unix-ts> <subject>" — the timestamp can't contain a space and %s is a
  // single line, so one split is unambiguous and needs no delimiter byte.
  const last = await safe(() =>
    git(project.local_path, "log", "-1", "--pretty=format:%at %s", branch)
  );
  const sp = last.indexOf(" ");
  const lastAtRaw = sp === -1 ? last : last.slice(0, sp);
  const lastSubject = sp === -1 ? "" : last.slice(sp + 1);

  // numstat is machine-readable: adds, dels, path
  const statRaw = await safe(() =>
    git(project.local_path, "diff", "--numstat", `${base}...${branch}`)
  );
  const diffstat = statRaw
    .split("\n")
    .filter(Boolean)
    .slice(0, 25)
    .map((l) => {
      const [add, del, path] = l.split("\t");
      return `${path} (+${add} -${del})`;
    });

  let dirty = 0;
  const wt = worktreePath(project, agent);
  if (await isGitRepo(wt).catch(() => false)) {
    const st = await safe(() => git(wt, "status", "--porcelain"));
    dirty = st.split("\n").filter(Boolean).length;
  }

  return {
    agent,
    branch,
    ahead,
    dirty,
    lastSubject: lastSubject.trim(),
    lastAt: (parseInt(lastAtRaw, 10) || 0) * 1000,
    diffstat,
  };
}

/**
 * The block injected into an agent's prompt describing the shared workspace.
 * `me` may be null for a non-isolated project (everyone shares the checkout),
 * in which case we still describe teammates' branches if any exist.
 */
export async function collaborationBlock(
  project: Project,
  me: Agent | null,
  teammates: Agent[],
  opts: { isolated: boolean; cwd: string }
): Promise<string> {
  if (!project.local_path) return "";
  if (!(await isGitRepo(project.local_path).catch(() => false))) return "";

  const base = await integrationBranch(project);
  const lines: string[] = ["\n## Shared workspace"];

  if (opts.isolated && me) {
    lines.push(
      `You are working in your own git worktree at ${opts.cwd}, on branch \`${branchName(me)}\`. ` +
      `Commit freely — your commits are isolated from everyone else's until they are merged into \`${base}\`.`
    );
  } else {
    lines.push(
      `You are working in the shared checkout at ${opts.cwd} on \`${base}\`. ` +
      `Other agents and the user work here too — do not switch branches, and do not commit unless asked.`
    );
  }

  const states = (
    await Promise.all(teammates.map((t) => branchStateOf(project, t, base).catch(() => null)))
  ).filter(Boolean) as BranchState[];

  if (states.length) {
    lines.push(
      `\n### Your teammates' work`,
      `All agents on this project share one git object database, so you can read any teammate's ` +
      `work directly — no need to ask them to paste it.`
    );
    for (const s of states) {
      const bits = [`${s.ahead} commit${s.ahead === 1 ? "" : "s"} ahead of ${base}`];
      if (s.dirty) bits.push(`${s.dirty} uncommitted file${s.dirty === 1 ? "" : "s"}`);
      lines.push(`\n**${s.agent.name}** — branch \`${s.branch}\` (${bits.join(", ")})`);
      if (s.lastSubject) lines.push(`  last commit: ${s.lastSubject}`);
      if (s.diffstat.length) {
        lines.push(`  changed: ${s.diffstat.slice(0, 8).join(", ")}${s.diffstat.length > 8 ? `, +${s.diffstat.length - 8} more` : ""}`);
      }
    }
    const example = states[0].branch;
    lines.push(
      `\nTo read a teammate's work (read-only — never commit to their branch):`,
      "```sh",
      `git log ${base}..${example}          # what they did`,
      `git diff ${base}...${example}        # the full diff`,
      `git show ${example}:path/to/file     # a file as they have it`,
      "```",
      `If you are asked to review a teammate, read their actual diff before commenting on it.`
    );
  } else if (teammates.length) {
    lines.push(
      `\n### Your teammates`,
      teammates.map((t) => `- @${slug(t.name)} (${t.role || t.kind}) — no branch yet`).join("\n")
    );
  }

  return lines.join("\n");
}

/**
 * A compact handoff note for the agent that runs next after `from` finished —
 * so a review or follow-up starts from the actual change, not a description.
 */
export async function handoffNote(
  project: Project,
  from: Agent,
  commitAfter: string
): Promise<string> {
  if (!project.local_path || !commitAfter) return "";
  if (!(await isGitRepo(project.local_path).catch(() => false))) return "";

  const base = await integrationBranch(project);
  const branch = branchName(from);
  const statRaw = await safe(() =>
    git(project.local_path, "show", "--numstat", "--format=%s", commitAfter)
  );
  const lines = statRaw.split("\n").filter(Boolean);
  const subject = lines[0] ?? "";
  const files = lines.slice(1).slice(0, 20).map((l) => {
    const [add, del, path] = l.split("\t");
    return `  ${path} (+${add} -${del})`;
  });
  if (!files.length) return "";

  return [
    `\n### ${from.name} just changed code`,
    subject ? `commit: ${subject}` : "",
    `branch: \`${branch}\``,
    ...files,
    `\nRead it with \`git diff ${base}...${branch}\` before responding.`,
  ].filter(Boolean).join("\n");
}
