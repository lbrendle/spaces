/**
 * Collaboration context — the prompt-facing face of coordination.ts.
 *
 * This module used to build the shared-workspace block itself. It no longer
 * does: `workspaceMap` answers the same question for the UI, the merge queue
 * and the prompt at once, and two implementations of "which branch is everyone
 * on" is exactly how a roster and a prompt end up disagreeing.
 *
 * What is left here is the prompt's own concerns — composing the block for one
 * agent, and the hand-off note that leads a review with the actual diff.
 *
 * Everything is best-effort: prompt building must never fail because a git
 * command did.
 */
import { git, branchName, isGitRepo } from "./workspaces";
import { collaborationText, integrationBase, workspaceMap } from "./coordination";
import type { Agent, Project } from "./types";

export { integrationBase as integrationBranch } from "./coordination";
export type { AgentLane, Overlap, WorkspaceMap } from "./coordination";

async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return "";
  }
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
  const roster = me ? [me, ...teammates] : [...teammates];
  const map = await workspaceMap(project, roster);
  if (map.error) return "";
  return collaborationText(map, me, opts);
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

  const base = await integrationBase(project);
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
