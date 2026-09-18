import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { threadSlice } from "../src/threading.ts";

const msg = (id: string, parent = "", status = "done") => ({ id, parent_id: parent, status });

/*
 * A turn in a thread has to be given the thread.
 *
 * It was not: the prompt quoted the channel's last twenty-five messages and
 * nothing else, so a reply to a thread that started a hundred messages back
 * arrived without its own opening. That reads as an agent ignoring context
 * when it is an agent that was never given any — the worst kind of bug,
 * because the output looks like a judgement rather than a gap.
 */
test("a thread is quoted whole, root first", () => {
  const all = [
    msg("a"),
    msg("root"),
    msg("noise"),
    msg("r1", "root"),
    msg("other", "elsewhere"),
    msg("r2", "root"),
  ];
  const slice = threadSlice(all, "root", "", 40);
  assert.deepEqual(
    slice.messages.map((m) => m.id),
    ["root", "r1", "r2"]
  );
  assert.equal(slice.elided, 0);
});

test("the message being answered is not quoted back as context", () => {
  const all = [msg("root"), msg("r1", "root"), msg("asking", "root")];
  const slice = threadSlice(all, "root", "asking", 40);
  assert.deepEqual(
    slice.messages.map((m) => m.id),
    ["root", "r1"]
  );

  // A run's own just-inserted placeholder is 'running' and is not conversation.
  const withPlaceholder = [msg("root"), msg("mine", "root", "running")];
  assert.deepEqual(
    threadSlice(withPlaceholder, "root", "", 40).messages.map((m) => m.id),
    ["root"]
  );
});

test("a long thread keeps its opening as well as its end", () => {
  const all = [msg("root"), ...Array.from({ length: 100 }, (_, i) => msg(`r${i}`, "root"))];
  const slice = threadSlice(all, "root", "", 10);

  assert.equal(slice.messages.length, 10);
  assert.equal(slice.elided, 91);
  // The root survives — it is what the thread is *for*, and a tail-only
  // window drops the one message that makes the rest interpretable.
  assert.equal(slice.messages[0].id, "root");
  assert.equal(slice.messages.at(-1)?.id, "r99");
  // Head and tail, with nothing from the middle.
  assert.deepEqual(
    slice.messages.map((m) => m.id),
    ["root", "r0", "r1", "r2", "r3", "r95", "r96", "r97", "r98", "r99"]
  );
});

test("a thread nobody can find yields nothing rather than guessing", () => {
  assert.deepEqual(threadSlice([msg("a")], "", "", 40), { messages: [], elided: 0 });
  assert.deepEqual(threadSlice([msg("a")], "missing", "", 40), { messages: [], elided: 0 });
  // A root outside the loaded window still gives up its replies.
  const orphaned = [msg("r1", "gone"), msg("r2", "gone")];
  assert.deepEqual(
    threadSlice(orphaned, "gone", "", 40).messages.map((m) => m.id),
    ["r1", "r2"]
  );
});

/*
 * A new channel starts with no conversation of its own — that is what a
 * channel is. What it should not start with is no idea what the project is
 * doing, which was the case: memory and tasks carried over, and nothing about
 * the work itself.
 */
test("a run is told what the rest of the project has been doing", async () => {
  const agents = await readFile(new URL("../src/agents.ts", import.meta.url), "utf8");

  assert.match(agents, /export async function elsewhereInProject/);
  assert.match(agents, /## Elsewhere in this project/);
  // From the database, not the store: the store only holds channels somebody
  // has opened, and the useful ones are the ones this agent has never seen.
  const fn = agents.slice(agents.indexOf("export async function elsewhereInProject"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /db\.select/);
  // And it is wired into the prompt, not merely defined.
  assert.match(agents, /await elsewhereInProject\(project, channelId\)/);

  // The thread block comes before the ambient conversation, and the ambient
  // conversation drops whatever the thread already quoted.
  assert.match(agents, /thread\.shown\.has\(m\.id\)/);
  const fresh = agents.slice(agents.indexOf("function buildFreshPrompt"));
  const threadAt = fresh.indexOf("threadContext(channel, trigger)");
  const recentAt = fresh.indexOf("## Recent conversation");
  assert.ok(threadAt > 0, "buildFreshPrompt does not build the thread block");
  assert.ok(recentAt > 0, "buildFreshPrompt no longer quotes the conversation");
  assert.ok(threadAt < recentAt, "the thread must be quoted before the ambient chat");

  // Resumed sessions get it too: being resumed is exactly when an agent is
  // pulled into a thread it has never been in.
  const resume = agents.slice(agents.indexOf("function buildResumePrompt"));
  assert.match(resume.slice(0, resume.indexOf("\n}\n")), /threadContext\(channel, trigger\)/);
});
