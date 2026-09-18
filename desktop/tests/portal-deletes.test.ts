import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * What this exists to prevent, exactly.
 *
 * The desktop app tells the portal which mirrored records have been deleted
 * here, and the portal answers with a tombstone that removes them everywhere,
 * permanently. That claim was made by comparing `portal_links` against a
 * Zustand snapshot — a cache of what has been loaded, not a record of what
 * exists. A snapshot that lagged the links table by a single sync was enough
 * to report a live project as deleted.
 *
 * It was not theoretical: every project created during one session was mapped
 * to the portal and then tombstoned minutes later, taking its channels and its
 * adopted memory with it. Deleting is the one thing that must never be
 * inferred from a cache.
 */
test("the portal is only told to delete what the database says is gone", async () => {
  const portal = await readFile(new URL("../src/portal.ts", import.meta.url), "utf8");

  const at = portal.indexOf("const liveIds");
  assert.ok(at > 0, "the live-id set that guards deletion is gone");
  const block = portal.slice(at, portal.indexOf("const sharedPayload", at));

  // The question is asked of the tables, not of the store.
  assert.match(block, /localDb\.select[\s\S]*?SELECT id FROM \$\{table\}/);
  assert.doesNotMatch(block, /state\.projects/);
  assert.doesNotMatch(block, /state\.channels/);
  assert.doesNotMatch(block, /state\.tasks/);

  // All three mirrored kinds still take part; dropping one would silently stop
  // real deletions propagating.
  for (const pair of ['["project", "projects"]', '["channel", "channels"]', '["task", "tasks"]']) {
    assert.ok(block.includes(pair), `${pair} no longer participates`);
  }
  assert.match(block, /deleteRequests = mirrorRows/);
});

/*
 * A tombstone arriving from the portal removes the project's memory, so it has
 * to remove adoption's ledger too — otherwise the workspace would refuse to
 * bring that context back, because it still believes it already has it.
 */
test("a tombstone does not leave the adoption ledger behind", async () => {
  const content = await readFile(new URL("../src/portalContent.ts", import.meta.url), "utf8");
  const body = content.slice(content.indexOf("async function removeRemoteMirror("));
  assert.match(body, /DELETE FROM adopted_context WHERE project_id/);
});
