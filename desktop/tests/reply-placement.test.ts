import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * Where an answer appears.
 *
 * Every multi-agent round filed its replies as a thread under the message that
 * started it. The intent was a tidy channel; the effect was that asking the
 * team something and getting three good answers left the channel looking like
 * nothing had happened — the replies sat behind a "1 reply" link nobody opens.
 *
 * The rule is the one a reader already expects: a reply to a channel message
 * is a channel message, and a reply inside a thread stays in that thread.
 * `trigger.parentId` already carries exactly that distinction.
 */
test("replies land where the question was asked", async () => {
  const src = await readFile(new URL("../src/orchestrator.ts", import.meta.url), "utf8");

  // No mode invents a thread out of the triggering message any more.
  assert.doesNotMatch(src, /parentId = trigger\.parentId \|\|/);
  assert.doesNotMatch(src, /\? trigger\.msgId : ""/);

  // Every round still carries the thread it was asked in, if there was one.
  for (const fn of ["runBroadcast", "runSequential", "runLead", "runPanel"]) {
    const at = src.indexOf(`async function ${fn}`);
    assert.ok(at > 0, `${fn} is gone`);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    assert.match(body, /const parentId = trigger\.parentId;/, `${fn} no longer inherits the thread`);
  }
});
