import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agents can share durable media and both clients render it inline", async () => {
  const [operations, renderer, portal, contract, server, native, transport] = await Promise.all([
    readFile(new URL("../src/hqops.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ui.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../portal/app/PortalApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/runtimeContract.ts", import.meta.url), "utf8"),
    readFile(new URL("../mcp/hq-mcp-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/portal.ts", import.meta.url), "utf8"),
  ]);

  assert.match(operations, /name: "spaces_send_message"/);
  assert.match(operations, /name: "spaces_list_media"/);
  assert.match(operations, /media_paths/);
  assert.match(operations, /uploadContentMedia/);
  assert.match(operations, /!\[Shared media \$\{index \+ 1\}\]/);
  assert.match(renderer, /class="md-media"/);
  assert.match(portal, /function messageContent/);
  assert.match(portal, /className="message-media"/);
  assert.match(contract, /private worktree paths/);
  assert.match(server, /function mediaListAnswer/);
  assert.match(operations, /platform === "instagram"/);
  assert.match(native, /Instagram's publishing API accepts feed photos as JPEG/);
  assert.match(native, /"image\/jpeg"/);
  assert.match(native, /"\/usr\/bin\/sips"/);
  assert.match(transport, /instagramCompatible/);
});
