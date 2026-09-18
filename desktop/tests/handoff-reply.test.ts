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
  assert.ok(untouched.length >= 2, "settleHandOff no longer reports both baseline cases");
  for (const clause of untouched) {
    assert.match(clause, /!reply/, `a reply must defeat untouched: ${clause}`);
  }
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
