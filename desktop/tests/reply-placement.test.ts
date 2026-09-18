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

/*
 * And the channel has to show them.
 *
 * The follow-the-bottom effect fires when a reply arrives, which is before it
 * has been laid out — markdown renders, a long answer expands, an image loads,
 * and the bottom moves past where the scroll was heading. The reply lands
 * below the fold and the channel looks like nothing happened.
 *
 * This never showed while replies were filed as threads, because the list did
 * not grow. Putting them in the channel is what exposed it, and from the
 * reader's seat "my agents stopped replying" and "the view did not move" are
 * the same thing.
 */
test("the channel follows a reply while it is still growing", async () => {
  const src = await readFile(new URL("../src/components/ChatView.tsx", import.meta.url), "utf8");

  // The scroller itself is observed, not just a sentinel at the end of it.
  assert.match(src, /const scrollerRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(src, /className="messages"\s*\n\s*ref=\{scrollerRef\}/);
  assert.match(src, /new ResizeObserver\(/);

  const at = src.indexOf("new ResizeObserver(");
  const body = src.slice(at, src.indexOf("}, [channelId, roots.length]);", at));
  // Reading history is still never interrupted.
  assert.match(body, /if \(!atBottomRef\.current\) return;/);
  // A smooth scroll restarted every frame never arrives, so this jumps.
  assert.match(body, /el\.scrollTop = el\.scrollHeight;/);
  // Children too: the growth is in the message that just rendered.
  assert.match(body, /for \(const child of Array\.from\(el\.children\)\) observer\.observe\(child\)/);
  assert.match(body, /observer\.disconnect\(\)/);
});
