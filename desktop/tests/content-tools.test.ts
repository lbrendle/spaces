import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agents receive the complete shared Content Studio lifecycle", async () => {
  const [operations, sync] = await Promise.all([
    readFile(new URL("../src/hqops.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/portalContent.ts", import.meta.url), "utf8"),
  ]);

  for (const tool of [
    "spaces_list_content",
    "spaces_get_content",
    "spaces_create_content",
    "spaces_update_content",
    "spaces_delete_content",
    "spaces_publish_social",
  ]) {
    assert.match(operations, new RegExp(`name: "${tool}"`));
  }
  assert.match(operations, /Pass content:<id>/);
  assert.match(operations, /canonical shared Content Studio board/);
  assert.match(operations, /resolvedContentMedia/);
  assert.match(sync, /contentItemRecords/);
  assert.match(sync, /entity = 'content_item'/);
  assert.match(sync, /new CustomEvent\("hq:content-change"\)/);
});
