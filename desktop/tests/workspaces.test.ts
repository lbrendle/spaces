import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The situation this exists for, in full.
 *
 * `worktreePath` is keyed by project *and* agent. `branchName` was keyed by
 * the agent alone. Git gives a branch to exactly one worktree, so two projects
 * backed by one repository wanted two directories and one branch — and the
 * second lost. Spaces caught the failure and ran in the shared checkout
 * instead, which is the one thing isolation exists to prevent: every agent
 * editing the same files at once, silently, after the person explicitly asked
 * for a worktree each.
 *
 * It did not need two live projects. A deleted project leaves its worktree on
 * disk still holding the branch, and nothing points at that directory any more
 * to explain why. Observed on this machine: a project that no longer existed
 * held hq/claude-…, hq/codex-…, hq/muse-… and two more, so every agent of the
 * live project on that repository fell back to the shared checkout.
 */
const src = () => readFile(new URL("../src/workspaces.ts", import.meta.url), "utf8");

test("a branch is scoped to a project, like the directory already was", async () => {
  const s = await src();

  assert.match(s, /export function scopedBranchName\(project: Project, agent: Agent\)/);
  const scoped = s.slice(s.indexOf("export function scopedBranchName"));
  // Same key the directory uses, so the two agree about what a workspace is.
  assert.match(scoped.slice(0, scoped.indexOf("\n}")), /project\.id\.slice\(0, 6\)/);

  const pathFn = s.slice(s.indexOf("export function worktreePath"));
  assert.match(pathFn.slice(0, pathFn.indexOf("\n}")), /project\.id\.slice\(0, 6\)/);
});

test("the plain name is kept when free and only avoided when taken", async () => {
  const s = await src();
  const fn = s.slice(s.indexOf("export async function ensureWorkspace"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  assert.match(body, /const plain = branchName\(agent\)/);
  assert.match(body, /branchIsCheckedOut\(project\.local_path, plain\)/);
  assert.match(body, /\? scopedBranchName\(project, agent\)/);
  assert.match(body, /: plain;/);

  // Checked out somewhere, not merely existing: a branch that exists but is in
  // no worktree can still be handed to this one, which is how an agent returns
  // to the workspace it had.
  const check = s.slice(s.indexOf("async function branchIsCheckedOut"));
  assert.match(check.slice(0, check.indexOf("\n}")), /worktree", "list", "--porcelain"/);
  assert.match(check.slice(0, check.indexOf("\n}")), /branch refs\/heads\/\$\{branch\}/);
});

/*
 * Git keeps holding a branch for a worktree whose directory has been deleted,
 * so a workspace removed by hand blocks its own branch for ever. Pruning drops
 * only records whose directory is gone, so it can never discard work.
 */
test("stale worktree records are cleared before one is added", async () => {
  const s = await src();
  const fn = s.slice(s.indexOf("export async function ensureWorkspace"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  const pruneAt = body.indexOf('"worktree", "prune"');
  const addAt = body.indexOf('"worktree", "add"');
  assert.ok(pruneAt > 0, "stale records are never pruned");
  assert.ok(pruneAt < addAt, "pruning must happen before the add it unblocks");

  // But never before returning a workspace that already exists — that would
  // run git on every single turn for no reason.
  assert.ok(
    body.indexOf("return path;") < pruneAt,
    "an existing workspace must short-circuit before any git runs"
  );
});

/*
 * The computed name is only ever a proposal. A workspace made before branches
 * were scoped is on the old name; one made when the plain name was taken is on
 * the scoped one. Merging or pushing a name that is not there fails outright,
 * so every consumer has to ask the worktree what it is really on.
 */
test("merging, pushing and status use the branch that is actually there", async () => {
  const s = await src();

  assert.match(s, /export async function workspaceBranch/);
  const fn = s.slice(s.indexOf("export async function workspaceBranch"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /rev-parse", "--abbrev-ref", "HEAD"/);
  // A detached head is not a branch name, and the legacy name is the fallback.
  assert.match(body, /head !== "HEAD"/);
  assert.match(body, /return branchName\(agent\)/);

  // No consumer may assume the name any more.
  for (const fname of ["workspaceStatus", "mergeWorkspace", "createPR", "removeWorkspace"]) {
    const at = s.indexOf(`export async function ${fname}`);
    assert.ok(at > 0, `${fname} is gone`);
    const consumer = s.slice(at, s.indexOf("\n}\n", at));
    assert.doesNotMatch(consumer, /branchName\(agent\)/, `${fname} still assumes the branch name`);
  }

  // And removal reads it while the worktree is still there to be asked.
  const remove = s.slice(s.indexOf("export async function removeWorkspace"));
  const removeBody = remove.slice(0, remove.indexOf("\n}\n"));
  assert.ok(
    removeBody.indexOf("workspaceBranch") < removeBody.indexOf('"worktree", "remove"'),
    "the branch must be read before the worktree is removed"
  );
});

/*
 * What agents are told about each other.
 *
 * The shared-workspace block names each teammate's branch and how far ahead it
 * is. That branch was chosen by preferring the name Spaces *would* pick
 * whenever a branch by that name existed anywhere in the repository — which is
 * not the same question as whether the agent is on it.
 *
 * A project deleted long ago leaves its worktrees holding exactly those names.
 * Observed in a real round: Codex was told "Claude — hq/claude-7ccc2f, 2
 * commits ahead" while Claude's worktree was on hq/claude-7ccc2f-8d83d3 with
 * nothing on it. Every agent was being briefed on a dead project's work under
 * a live teammate's name — the worst kind of wrong, because it reads as fact.
 */
test("a teammate's branch is read from where it works, not from the convention", async () => {
  const src = await readFile(new URL("../src/coordination.ts", import.meta.url), "utf8");

  const at = src.indexOf("Which branch holds this agent's committed work");
  assert.ok(at > 0, "the lane branch is no longer resolved here");
  const body = src.slice(at, src.indexOf("if (!lane.branch || lane.branch === \"HEAD\" || lane.branch === base)", at));

  // The working directory is asked first, unconditionally.
  const headAt = body.indexOf('"rev-parse", "--abbrev-ref", "HEAD"');
  const namedAt = body.indexOf("branchName(agent)");
  assert.ok(headAt > 0, "the working directory is never consulted");
  assert.ok(namedAt > headAt, "the naming convention must not win over the directory");

  // And the convention is only a fallback for a directory that could not answer.
  assert.match(body, /if \(!external && \(!lane\.branch \|\| lane\.branch === "HEAD"\)\)/);
  // Crucially, existence of the branch no longer decides it on its own.
  assert.doesNotMatch(body, /const named = external \? "" : branchName\(agent\)/);
});
