import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The situation this exists for, in full.
 *
 * Spaces could ask an external teammate anything and could only hear one kind
 * of answer back: a commit. Asked "what's the status on the model run", Muse
 * did exactly the right thing — read the run state, changed no files, and
 * reported in its own window: "Nothing for me to commit, no files changed on
 * my side, just read the run state."
 *
 * `settleHandOff` saw no commits and nothing newly dirty, called that
 * `untouched`, and `reportHandOffs` skipped it. From the channel, a teammate
 * that answered perfectly was indistinguishable from one that ignored you —
 * and the brief had told it, in writing, that it need not report back by hand.
 */

const external = () => readFile(new URL("../src/external.ts", import.meta.url), "utf8");
const agents = () => readFile(new URL("../src/agents.ts", import.meta.url), "utf8");

test("an answer in words is an outcome, not silence", async () => {
  const src = await external();

  // The reply lives beside the brief, so one path convention covers both.
  assert.match(src, /export function replyPath\(agent: Agent\): string/);
  const path = src.slice(src.indexOf("export function replyPath"));
  assert.match(path.slice(0, path.indexOf("\n}")), /handoffPath\(agent\)[\s\S]*?\.reply\.md/);

  // And it counts: `untouched` is what suppresses the report entirely.
  const settle = src.slice(src.indexOf("export async function settleHandOff"));
  const body = settle.slice(0, settle.indexOf("\n}\n"));
  assert.match(body, /const reply = await readReply\(project, agent\)/);
  const untouched = body.match(/untouched:[^,}]*/g) ?? [];
  assert.ok(untouched.length >= 1, "settleHandOff no longer decides untouched");
  for (const clause of untouched) {
    assert.match(clause, /!reply/, `a reply must defeat untouched: ${clause}`);
  }
});

/*
 * `reportHandOffs` treats a thrown settle as "nothing happened". So if git
 * throws — a checkout gone missing, a permission problem — an answer sitting
 * readable on disk would be discarded, which is the very failure this path
 * exists to end. The two sources are independent and must fail independently.
 */
test("a broken checkout cannot swallow a written answer", async () => {
  const src = await external();
  const fn = src.slice(src.indexOf("export async function settleHandOff"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  // The reply is read before git is touched, and git failing is not fatal.
  assert.ok(
    body.indexOf("readReply(project, agent)") < body.indexOf("activityOf("),
    "the reply must be read before git can throw"
  );
  assert.match(body, /activityOf\([\s\S]*?\)\s*\.catch\(\(\) => null\)/);
  // And an absent activity reads as no commits, not as an exception.
  assert.match(body, /activity\?\.dirtyFiles \?\? \[\]/);
  assert.match(body, /activity\?\.commits \?\? \[\]/);

  // A baseline-less settle still refuses to claim pre-existing commits.
  assert.match(body, /const commits = baseline\.sha \? activity\?\.commits \?\? \[\] : \[\]/);
});

test("the brief stops promising a return path it does not have", async () => {
  const src = await external();
  const brief = src.slice(src.indexOf("const body = ["), src.indexOf("write_text_file"));

  // The old wording told the agent not to report back at all.
  assert.doesNotMatch(brief, /you do not need to report back by hand/);
  // The new wording names the file and says what goes in it.
  assert.match(brief, /replyPath\(req\.agent\)/);
  assert.match(brief, /words rather than code/);
});

test("a stale answer is never posted as a fresh one", async () => {
  const src = await external();

  // Cleared when a new brief is handed over...
  const handOff = src.slice(src.indexOf("export async function handOff"));
  const upToReturn = handOff.slice(0, handOff.indexOf("\n  return result;\n}"));
  assert.match(upToReturn, /relativePath: replyPath\(req\.agent\)[\s\S]*?contents: ""/);

  // ...and again once it has been said out loud, because reporting is per run
  // while the file is per agent.
  assert.match(src, /export async function consumeReply/);
  const reporting = await agents();
  assert.match(reporting, /if \(outcome\.reply\) await consumeReply\(project, agent\)/);
});

test("the reply reaches the channel, attributed to where it came from", async () => {
  const src = await agents();
  const fn = src.slice(src.indexOf("export async function reportHandOffs"));
  const body = fn.slice(0, fn.indexOf("\n  return reported;"));

  // The agent's own words, before the commit list rather than after it.
  const replyAt = body.indexOf("outcome.reply,");
  const commitsAt = body.indexOf("outcome.commits.slice");
  assert.ok(replyAt > 0, "the reply never reaches the message");
  assert.ok(replyAt < commitsAt, "the answer must come before the supporting commits");

  // Git is observed fact; a written reply is the agent's own account. A reader
  // deciding how much to trust it needs to be told which this is.
  assert.match(body, /"written reply and git"/);
  assert.match(body, /"written reply"/);
  assert.match(body, /"picked up from git"/);
});

/*
 * And it has to arrive without being fetched. `reportHandOffs` was called from
 * exactly one place — the shared-workspace view mounting — so an answer to a
 * question asked in #general only appeared if the person happened to navigate
 * to that project's workspace screen afterwards.
 */
test("an answer arrives without anyone going to look for it", async () => {
  const [src, app] = await Promise.all([
    agents(),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(src, /export function initHandOffWatch/);
  const watch = src.slice(src.indexOf("export function initHandOffWatch"));
  const body = watch.slice(0, watch.indexOf("\n}\n"));

  // Only projects with something outstanding are settled: the common case must
  // not shell out to git on a timer.
  assert.match(body, /awaiting external agent/);
  assert.match(body, /SELECT DISTINCT channels\.project_id/);
  assert.match(body, /reportHandOffs\(row\.project_id\)/);
  // Overlapping sweeps would run git twice over the same tree.
  assert.match(body, /if \(stopped \|\| running\) return;/);

  // Started with the other background workers, and stopped with them.
  assert.match(app, /const stopHandOffs = initHandOffWatch\(\);/);
  assert.match(app, /stopHandOffs\(\);/);
});

/*
 * The brief is a file the agent may never open.
 *
 * The return path was documented there, and Muse answered straight into its
 * own chat window without opening it — the right instinct for a chat app asked
 * something it can already answer, and the reason a perfect answer stayed
 * unreachable through three separate attempts. The composer message is the one
 * thing an agent driven this way is certain to read, so the return path has to
 * be in it.
 */
test("the message typed into the app says where a reply goes", async () => {
  const [src, caller] = await Promise.all([
    external(),
    agents(),
  ]);

  const fn = src.slice(src.indexOf("export function composerMessage"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /replyFile: string/);
  assert.match(body, /Write your answer to \$\{opts\.replyFile\}/);
  // And says plainly that answering in the window does not reach anyone.
  assert.match(body, /Answering here only reaches this window/);

  // The call site actually supplies it, as an absolute path like the others.
  assert.match(caller, /replyFile: project\?\.local_path/);
  assert.match(caller, /\$\{replyPath\(agent\)\}/);
});

/*
 * A channel is a conversation, not a set of parallel monologues.
 *
 * When a CLI agent replies, `maybeChain` dispatches that reply again so any
 * teammate it names picks it up. An external teammate's reply was inserted and
 * left there — so Muse could be asked something, answer it well, name the
 * teammate who should act on it, and nobody would ever run.
 */
test("a late reply can still start the teammate it names", async () => {
  const src = await agents();
  const fn = src.slice(src.indexOf("export async function reportHandOffs"));
  const body = fn.slice(0, fn.indexOf("\n  return reported;"));

  assert.match(body, /triggerAgents\(row\.channel_id, \{/);
  // Dispatched as the agent, carrying its own words.
  assert.match(body, /authorType: "agent"/);
  assert.match(body, /content: outcome\.reply \|\| describeOutcome\(agent, outcome\)/);
  // Pointing at the message that was just posted, so the thread is coherent.
  assert.match(body, /const replyId = uid\(\)/);
  assert.match(body, /msgId: replyId/);
  // Seeded with itself, so the ordinary loop guards apply from the first hop.
  assert.match(body, /chain: \[agent\.id\]/);

  // And only after the run is settled, or a failure mid-chain could replay it.
  assert.ok(
    body.indexOf('meta: "external work landed"') < body.indexOf("triggerAgents("),
    "the hand-off must be settled before anything is chained from it"
  );
});

/*
 * Muse answers in about five seconds. Spaces then sat on it for up to
 * forty-five, because the only sweep that could notice also shelled out to git
 * and so could not run often. From the channel that is indistinguishable from
 * a slow agent — the answer exists, readable on disk, and nobody looks.
 */
test("an answer is noticed in seconds, without git running in seconds", async () => {
  const [src, ext] = await Promise.all([
    agents(),
    readFile(new URL("../src/external.ts", import.meta.url), "utf8"),
  ]);

  // Two cadences, because the two checks cost different things.
  const poll = Number(src.match(/const HANDOFF_POLL_MS = ([\d_]+)/)?.[1].replace(/_/g, "") ?? 0);
  const git = Number(src.match(/const HANDOFF_GIT_MS = ([\d_]+)/)?.[1].replace(/_/g, "") ?? 0);
  assert.ok(poll > 0 && poll <= 10_000, `the fast tick is not fast (${poll}ms)`);
  assert.ok(git >= poll * 4, "the git sweep must be much rarer than the file check");

  const watch = src.slice(src.indexOf("export function initHandOffWatch"));
  const body = watch.slice(0, watch.indexOf("\n}\n"));
  // The fast path reads files and skips; only the slow path reaches git.
  assert.match(body, /const withGit = Date\.now\(\) - lastGit >= HANDOFF_GIT_MS/);
  assert.match(body, /if \(!withGit\) \{[\s\S]*?replyWaiting\(project, externals\)[\s\S]*?continue;/);
  // Nothing outstanding stays free.
  assert.match(body, /if \(!rows\.length\) return;/);

  // And the cheap check really is cheap: files only, no git.
  const fn = ext.slice(ext.indexOf("export async function replyWaiting"));
  const waiting = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(waiting, /readReply\(project, agent\)/);
  assert.doesNotMatch(waiting, /activityOf|git\(/);
});

/*
 * Two ways the channel got told things that were not true.
 *
 * `.spaces-workspaces/` is where Spaces puts the per-agent worktrees, so the
 * first hand-off after one is created reported "Muse: 1 uncommitted file —
 * .spaces-workspaces/": Spaces describing its own plumbing back to the person
 * as a teammate's work. And every open hand-off asks the same question, so
 * asking twice in a minute produced two identical reports seconds apart.
 */
test("Spaces' own directories are never reported as an agent's work", async () => {
  const src = await readFile(new URL("../src/external.ts", import.meta.url), "utf8");

  assert.match(src, /const SPACES_OWNED = \[/);
  for (const own of [".spaces-workspaces/", ".hq/"]) {
    assert.ok(src.includes(`"${own}"`), `${own} is not excluded`);
  }
  // Applied where the agent's new work is decided, not merely defined.
  const settle = src.slice(src.indexOf("export async function settleHandOff"));
  assert.match(settle.slice(0, settle.indexOf("\n}\n")), /!was\.has\(f\) && !spacesOwned\(f\)/);

  // A leading "./" must not let a path through.
  const fn = src.slice(src.indexOf("function spacesOwned"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /replace\(/);
});

test("one report per agent per sweep, however many hand-offs are open", async () => {
  const src = await agents();
  const fn = src.slice(src.indexOf("export async function reportHandOffs"));
  const body = fn.slice(0, fn.indexOf("\n  return reported;"));

  assert.match(body, /let said = false;/);
  assert.match(body, /said = true;/);
  // The extras are settled rather than left open, or they would be retried for
  // ever and report again the moment anything did change.
  assert.match(body, /if \(said\) \{\s*\n\s*await store\.patchRun\(row\.id, \{ meta: "external work landed" \}\);/);
});
