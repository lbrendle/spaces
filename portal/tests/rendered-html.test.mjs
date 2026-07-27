import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("production build emits the Spaces worker and product shell", async () => {
  const [worker, app] = await Promise.all([
    readFile(new URL("../dist/server/index.js", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /vinext|fetch/i);
  assert.match(app, /Opening your workspace/);
  assert.match(app, /Admin overview/);
  assert.match(app, /Agents \+ teams/);
  assert.doesNotMatch(app, /codex-preview|react-loading-skeleton/i);
});

test("admin shell keeps every workspace surface mounted", async () => {
  const app = await readFile(
    new URL("../app/PortalApp.tsx", import.meta.url),
    "utf8",
  );
  for (const surface of [
    "today",
    "messages",
    "work",
    "inbox",
    "calendar",
    "knowledge",
    "content",
  ]) {
    assert.match(app, new RegExp(`surface === "${surface}"`));
  }
  assert.match(app, /setPendingMessages/);
  assert.match(app, /sending…/);
});

test("auth error and invite mismatch screens can restart with another ChatGPT account", async () => {
  const [app, join, joinPage] = await Promise.all([
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/join/[token]/JoinWorkspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/join/[token]/page.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(app, /Use another ChatGPT account/);
  assert.match(app, /signout-with-chatgpt\?return_to=/);
  assert.match(join, /switchAccountHref/);
  assert.match(join, /This invitation\s+belongs to/);
  assert.match(joinPage, /requireChatGPTUser/);
  assert.match(joinPage, /`\/join\/\$\{encodeURIComponent\(token\)\}`/);
});

test("shared knowledge and calendars have permission-aware durable storage", async () => {
  const [schema, migration, tombstoneMigration, workspace, app] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_tough_bishop.sql", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0007_living_the_leader.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/shared-content.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /knowledgeAccess/);
  assert.match(schema, /sharedCalendars/);
  assert.match(schema, /sharedCalendarEvents/);
  assert.match(migration, /CREATE TABLE `knowledge_access`/);
  assert.match(migration, /CREATE TABLE `shared_calendar_events`/);
  assert.match(tombstoneMigration, /CREATE TABLE `content_tombstones`/);
  assert.match(workspace, /revision > \?/);
  assert.match(workspace, /redacted \? "Busy"/);
  assert.match(workspace, /visibility === "private"/);
  assert.match(workspace, /from_page_id AS fromPageId/);
  assert.match(workspace, /page\.backlinks = pageLinks/);
  assert.match(app, /function CalendarSurface/);
  assert.match(app, /function PortalKnowledgeTree/);
  assert.match(app, /action: "update_knowledge"/);
  assert.match(app, /Linked mentions/);
  assert.match(app, /Company\/Runbooks/);
  assert.match(app, /Busy-only events arrive redacted from the server/);
});

test("GitHub is a member-owned connection and not the app owner's shared token", async () => {
  const [integrations, policy, app] = await Promise.all([
    readFile(new URL("../lib/integrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/connection-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(integrations, /id: "github"/);
  assert.match(integrations, /GITHUB_CLIENT_ID/);
  assert.match(integrations, /https:\/\/api\.github\.com\/user/);
  assert.match(integrations, /row\.createdBy !== state\.userId/);
  assert.doesNotMatch(policy, /WORKSPACE_SOCIAL_PROVIDERS.*github/);
  assert.match(app, /Private to you/);
});

test("calendar creation reaches exact cloud calendars and queues native Apple delivery", async () => {
  const [actions, workspace, route, schema, migration, app] = await Promise.all([
    readFile(new URL("../lib/provider-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/device/calendar-commands/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0009_soft_misty_knight.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /calendar\.sources/);
  assert.match(actions, /users\/me\/calendarList/);
  assert.match(actions, /resolveCalendarSource/);
  assert.match(actions, /encodeURIComponent\(calendar\.id\)/);
  assert.match(workspace, /createConnectedCalendarEvent/);
  assert.match(workspace, /queued_for_desktop/);
  assert.match(route, /apple Calendar/i);
  assert.match(route, /calendar\.event_delivered/);
  assert.match(schema, /calendarCommands/);
  assert.match(migration, /CREATE TABLE `calendar_commands`/);
  assert.match(app, /Event queued for Apple Calendar/);
});

test("starter preview is removed and product metadata is present", async () => {
  const [page, layout, packageJson, app] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<PortalApp \/>/);
  assert.match(page, /requireChatGPTUser/);
  assert.match(layout, /your company in one place/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(app, /Spaces-0\.1\.12-universal\.dmg/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("declares durable D1 storage for workspace state", async () => {
  const hosting = JSON.parse(
    await readFile(new URL("../.openai/hosting.example.json", import.meta.url), "utf8"),
  );
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, "MEDIA");
  await assert.rejects(access(new URL("../.openai/hosting.json", import.meta.url)));
});

test("workspace media uploads use authenticated R2 storage and public delivery", async () => {
  const [schema, migration, media, uploadRoute, deliveryRoute] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0013_media_assets.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/media.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/device/media/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/media/[id]/[name]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /mediaAssets/);
  assert.match(migration, /CREATE TABLE `media_assets`/);
  assert.match(media, /storage\.put/);
  assert.match(media, /authorizeDevice/);
  assert.match(uploadRoute, /uploadDeviceMedia/);
  assert.match(deliveryRoute, /serveMedia/);
});

test("Content Studio is one shared board for people, devices, and agents", async () => {
  const [schema, migration, shared, workspace, app] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0014_shared_content_board.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/shared-content.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const contentItems/);
  assert.match(migration, /CREATE TABLE `content_items`/);
  assert.match(migration, /content_items_source_idx/);
  assert.match(shared, /syncContentItems/);
  assert.match(shared, /"content_item"/);
  assert.match(shared, /contentItems: shared\.contentItems/);
  assert.match(workspace, /actionName === "create_content"/);
  assert.match(workspace, /actionName === "update_content"/);
  assert.match(workspace, /actionName === "delete_content"/);
  assert.match(app, /function ContentStudioSurface/);
  assert.match(app, /text\/spaces-content/);
  assert.match(app, /The complete caption or script—not a link back to chat/);
});

test("social accounts are distinct, project-linked, and explicitly selectable", async () => {
  const [schema, migration, integrations, actions, workspace, app] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0010_broken_golden_guardian.sql", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/integrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/provider-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /projectConnections/);
  assert.match(migration, /CREATE TABLE `project_connections`/);
  assert.match(migration, /ALTER TABLE `oauth_states` ADD `project_id`/);
  assert.match(integrations, /metadata\.accountId === identity\.id/);
  assert.match(integrations, /selector: \{/);
  assert.match(integrations, /https:\/\/www\.tiktok\.com\/v2\/auth\/authorize\//);
  assert.match(integrations, /video\.upload/);
  assert.match(integrations, /video\.publish/);
  assert.match(integrations, /https:\/\/www\.instagram\.com\/oauth\/authorize/);
  assert.match(integrations, /instagram_business_content_publish/);
  assert.match(integrations, /ig_exchange_token/);
  assert.match(integrations, /ig_refresh_token/);
  assert.doesNotMatch(integrations, /force_reauth/);
  assert.match(actions, /connectionId: cleanText\(input\.connectionId/);
  assert.match(actions, /post\/publish\/creator_info\/query/);
  assert.match(actions, /post\/publish\/video\/init/);
  assert.match(actions, /PULL_FROM_URL/);
  assert.match(actions, /graph\.instagram\.com/);
  assert.doesNotMatch(actions, /graph\.facebook\.com.*media_publish/);
  assert.match(workspace, /actionName === "link_project_connection"/);
  assert.match(workspace, /actionName === "set_project_connection_default"/);
  assert.match(app, /Add account/);
  assert.match(app, /Make default/);
});

test("workspace revisions reconcile changes across active sessions", async () => {
  const [app, route, schema, migration] = await Promise.all([
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0005_cultured_dragon_lord.sql", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(app, /setInterval\(refresh, 3_000\)/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /WorkspaceUnchanged/);
  assert.match(route, /loadWorkspaceUpdate/);
  assert.match(route, /searchParams\.get\("since"\)/);
  assert.match(schema, /workspaceEvents/);
  assert.match(migration, /AUTOINCREMENT/);
});

test("owners can clear workspace history without deleting identity or connections", async () => {
  const workspace = await readFile(
    new URL("../lib/workspace.ts", import.meta.url),
    "utf8",
  );
  const reset = workspace.slice(
    workspace.indexOf('actionName === "reset_workspace_history"'),
    workspace.indexOf('actionName === "create_issue"'),
  );
  assert.match(reset, /actionName === "reset_workspace_history"/);
  assert.match(reset, /requireRole\(context, \["owner"\]\)/);
  assert.match(reset, /RESET HISTORY \$\{context\.workspace\.id\}/);
  for (const table of [
    "messages",
    "issues",
    "knowledge_pages",
    "shared_calendar_events",
    "content_items",
    "agent_jobs",
    "device_snapshots",
    "media_assets",
    "activity",
  ]) {
    assert.match(reset, new RegExp(`DELETE FROM ${table}`));
  }
  for (const preserved of [
    "workspaces",
    "memberships",
    "projects",
    "channels",
    "agents",
    "devices",
    "connections",
    "project_connections",
  ]) {
    assert.doesNotMatch(reset, new RegExp(`DELETE FROM ${preserved}`));
  }
  assert.match(reset, /storage!\.delete/);
});

test("member roles and personal desktop pairing are authorized server-side", async () => {
  const [workspace, app, schema] = await Promise.all([
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /actionName === "update_member_role"/);
  assert.match(workspace, /memberProfiles/);
  assert.match(workspace, /memberAcks/);
  assert.match(workspace, /applyMemberProfilePatch/);
  assert.match(workspace, /The workspace owner role is protected/);
  assert.match(workspace, /Only the workspace owner can change administrator roles/);
  assert.match(
    workspace,
    /requireRole\(context, \["owner", "admin", "member"\]\)/,
  );
  assert.match(workspace, /Members can only revoke their own desktops/);
  assert.match(app, /member-role-control/);
  assert.match(app, /action: "update_member_role"/);
  assert.match(app, /device\.ownerUserId === snapshot\.currentUser\.id/);
  assert.match(schema, /displayName/);
});

test("member removal, owned agents, mentions, and remote coding require explicit authority", async () => {
  const [workspace, jobs, app] = await Promise.all([
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/device-jobs.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /actionName === "remove_member"/);
  assert.match(workspace, /Removed \$\{member\.name \|\| member\.email\} and their agents/);
  assert.match(workspace, /DELETE FROM invites/);
  assert.match(workspace, /actionName === "create_agent"/);
  assert.match(workspace, /Members can host agents only on their own paired desktops/);
  assert.match(jobs, /'pending_approval'/);
  assert.match(jobs, /case "approve"/);
  assert.match(jobs, /case "decline"/);
  assert.match(jobs, /requestedByDeviceName/);
  assert.match(app, /People, agents, and teams/);
  assert.match(app, /kind: "person"/);
});

test("owners and admins can remove duplicate channels and projects across devices", async () => {
  const [workspace, shared, desktopSync, sidebar, app] = await Promise.all([
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/shared-content.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../desktop/src/portalContent.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../desktop/src/components/Sidebar.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/PortalApp.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /actionName === "delete_channel"/);
  assert.match(workspace, /actionName === "delete_project"/);
  assert.match(workspace, /requireRole\(context, \["owner", "admin"\]\)/);
  assert.match(workspace, /entity = 'project_source'/);
  assert.match(shared, /\| "project_source"/);
  assert.match(desktopSync, /tombstone\.entity === "project"/);
  assert.match(sidebar, /The code folder and remote repository/);
  assert.match(app, /Remove project/);
  assert.match(app, /action: "delete_channel"/);
  assert.match(app, /action: "delete_project"/);
});

test("paired desktops replicate the complete shared project graph", async () => {
  const readOptional = async (url) => {
    try {
      return await readFile(url, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  };
  const [workspace, migration, desktopSync, store] = await Promise.all([
    readFile(new URL("../lib/workspace.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../drizzle/0012_shared_desktop_workspace.sql", import.meta.url),
      "utf8",
    ),
    readOptional(new URL("../../desktop/src/portal.ts", import.meta.url)),
    readOptional(new URL("../../desktop/src/store.ts", import.meta.url)),
  ]);

  for (const table of ["channel_sources", "message_sources", "issue_sources"]) {
    assert.ok(migration.includes(`CREATE TABLE \`${table}\``));
  }
  assert.match(migration, /ALTER TABLE `projects` ADD `repo`/);
  for (const profile of [
    "projectProfiles",
    "channelProfiles",
    "messageProfiles",
    "taskProfiles",
    "deleteRequests",
  ]) {
    assert.match(workspace, new RegExp(profile));
    if (desktopSync) assert.match(desktopSync, new RegExp(profile));
  }
  assert.match(workspace, /entity = 'project_source'/);
  assert.match(workspace, /deviceActor\.role === "owner"/);
  if (desktopSync) {
    assert.match(desktopSync, /body\.channels/);
    assert.match(desktopSync, /body\.messages/);
    assert.match(desktopSync, /body\.issues/);
  }
  if (store) assert.match(store, /requestPortalSync\(\);/);
});
