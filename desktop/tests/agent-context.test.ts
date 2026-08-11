import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent harnesses receive a stable platform contract and event identity", async () => {
  const [rust, agents, blackboard, operations, contract] = await Promise.all([
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/agents.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/blackboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/hqops.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtimeContract.ts", import.meta.url), "utf8"),
  ]);
  for (const key of [
    "SPACES_RUN_ID",
    "SPACES_AGENT_ID",
    "SPACES_CHANNEL_ID",
    "SPACES_PROJECT_ID",
    "SPACES_TRIGGER_ID",
    "SPACES_REPLY_TO",
    "SPACES_PROJECT_ROOT",
    "SPACES_CONTEXT_DIR",
    "SPACES_MCP_SERVER",
    "SPACES_CLI",
    "SPACES_RUNTIME",
    "SPACES_HARNESS_PROTOCOL",
  ]) {
    assert.match(rust, new RegExp(`env\\("${key}"`));
  }
  assert.match(agents, /agentId: agent\.id/);
  assert.match(agents, /channelId/);
  assert.match(agents, /projectId: project\?\.id/);
  assert.match(blackboard, /KNOWLEDGE\.md/);
  assert.match(blackboard, /knowledge:source:path/);
  assert.match(contract, /spaces-event-v1/);
  assert.match(contract, /\[Spaces Context\]/);
  assert.match(contract, /current.*block is authoritative/i);
  assert.match(contract, /final assistant response is published automatically/i);
  assert.match(contract, /GUI Computer Use approval belongs to the host harness task/i);
  assert.match(contract, /never tell someone to approve an app in Spaces/i);
  assert.match(contract, /xcrun simctl io booted recordVideo/);
  assert.match(contract, /headless channel run cannot display that approval/i);
  assert.match(agents, /SPACES_BASE_PROMPT/);
  assert.match(agents, /SPACES_RESUME_PROMPT/);
  assert.match(agents, /--append-system-prompt-file/);
  assert.match(agents, /ensureRuntimeContract/);
  assert.match(agents, /parentId \|\| "channel-top-level"/);
  assert.match(agents, /mcpCodexArgs/);
  assert.match(agents, /setupMcp\(mcpProject, cwd\)/);
  assert.match(agents, /could not make its tools available/);
  assert.match(agents, /--permission-mode", "bypassPermissions"/);
  assert.match(
    await readFile(new URL("../src/mcpsetup.ts", import.meta.url), "utf8"),
    /default_tools_approval_mode="approve"/,
  );
  assert.match(
    await readFile(new URL("../src/mcpsetup.ts", import.meta.url), "utf8"),
    /SPACES_CHANNEL_ID[\s\S]*SPACES_DB_PATH[\s\S]*env_vars=/,
  );
  assert.match(
    await readFile(new URL("../src/mcpsetup.ts", import.meta.url), "utf8"),
    /\.git\/info\/exclude[\s\S]*\.claude\/settings\.local\.json/,
  );
  for (const tool of [
    "spaces_list_messages",
    "spaces_list_media",
    "spaces_send_message",
    "spaces_search_knowledge",
    "spaces_read_knowledge",
    "spaces_list_documents",
    "spaces_get_document",
    "spaces_create_document",
    "spaces_update_document",
    "spaces_delete_document",
    "spaces_list_mail",
    "spaces_get_mail",
    "spaces_create_mail_draft",
    "spaces_send_mail",
    "spaces_list_calendar",
    "spaces_create_calendar_event",
    "spaces_git_status",
    "spaces_open_browser",
    "spaces_list_social_accounts",
    "spaces_publish_social",
  ]) {
    assert.match(operations, new RegExp(`name: "${tool}"`));
  }
  assert.match(contract, /mcp__hq__spaces_\*/);
  assert.match(contract, /media_paths/);
});

test("web-authored channel messages durably dispatch to local agents", async () => {
  const [database, portal] = await Promise.all([
    readFile(new URL("../src/db.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/portal.ts", import.meta.url), "utf8"),
  ]);

  assert.match(database, /CREATE TABLE IF NOT EXISTS portal_message_dispatches/);
  assert.match(database, /PRAGMA user_version = 22/);
  assert.match(portal, /async function drainPortalMessageDispatches/);
  assert.match(portal, /remote\.authorType === "user"/);
  assert.match(portal, /!remote\.sourceMessageId/);
  assert.match(portal, /!message\.exists/);
  assert.match(portal, /preferred\[0\]\?\.id/);
  assert.match(portal, /Channels arrive before agents/);
  assert.match(portal, /UPDATE channels SET lead_agent_id = \$1 WHERE id = \$2/);
  assert.match(portal, /await import\("\.\/agents"\)/);
  assert.match(portal, /await triggerAgents\(receipt\.channel_id, userTrigger\(routed\)\)/);
  assert.match(portal, /schedulePortalMessageDispatch\(\)/);
});

test("failed approvals become durable channel context for agent retries", async () => {
  const actions = await readFile(new URL("../src/actions.ts", import.meta.url), "utf8");

  assert.match(actions, /surfaceProposalFailure/);
  assert.match(actions, /The proposal is closed/);
  assert.match(actions, /if \(!result\.ok && op\.effect === "propose"\)/);
  assert.match(actions, /insertMessage/);
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
