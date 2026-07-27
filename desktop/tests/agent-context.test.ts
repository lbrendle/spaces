import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent harnesses receive stable run, agent, channel, and project identity", async () => {
  const [rust, agents, blackboard, operations] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/agents.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/blackboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/hqops.ts", import.meta.url), "utf8"),
  ]);
  for (const key of [
    "SPACES_RUN_ID",
    "SPACES_AGENT_ID",
    "SPACES_CHANNEL_ID",
    "SPACES_PROJECT_ID",
  ]) {
    assert.match(rust, new RegExp(`env\\("${key}"`));
  }
  assert.match(agents, /agentId: agent\.id/);
  assert.match(agents, /channelId/);
  assert.match(agents, /projectId: project\?\.id/);
  assert.match(blackboard, /KNOWLEDGE\.md/);
  assert.match(blackboard, /knowledge:source:path/);
  for (const tool of [
    "spaces_search_knowledge",
    "spaces_read_knowledge",
    "spaces_create_document",
    "spaces_send_mail",
    "spaces_publish_social",
  ]) {
    assert.match(operations, new RegExp(`name: "${tool}"`));
  }
});

test("Knowledge references use shared sync identities and exclude private collections", async () => {
  const [blackboard, operations, refs] = await Promise.all([
    readFile(new URL("../src/blackboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/hqops.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/knowledgeRefs.ts", import.meta.url), "utf8"),
  ]);
  assert.match(blackboard, /stableKnowledgeIdentity/);
  assert.match(operations, /viewer: workspaceViewer/);
  assert.match(operations, /localKnowledgeIdentity/);
  assert.match(refs, /portal_links/);
  assert.match(refs, /portal_sync_state/);
});
