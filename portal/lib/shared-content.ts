import { getD1 } from "../db";
import type {
  KnowledgePage,
  SharedCalendar,
  SharedCalendarEvent,
} from "./types";

type SqlValue = string | number | null;

export interface DeviceIdentity {
  id: string;
  workspaceId: string;
  ownerUserId: string;
}

export interface SharedSyncAck {
  entity: "document" | "vault" | "vault_file" | "calendar" | "event";
  sourceId: string;
  remoteId: string;
  fingerprint: string;
}

export interface SharedTombstone {
  entity:
    | "document"
    | "vault"
    | "vault_file"
    | "calendar"
    | "event"
    | "project"
    | "project_source";
  entityId: string;
  revision: number;
}

interface KnowledgeRow
  extends Omit<KnowledgePage, "tags" | "access" | "backlinks"> {
  tagsJson: string;
  revision: number;
}

interface PageLinkRow {
  fromPageId: string;
  toPageId: string;
}

interface CalendarRow extends Omit<SharedCalendar, "access"> {
  createdBy: string;
  revision: number;
}

interface EventRow extends Omit<SharedCalendarEvent, "attendees" | "access" | "redacted"> {
  attendeesJson: string;
  revision: number;
}

interface AccessRow {
  subjectType: "member" | "team" | "agent";
  subjectId: string;
  access: string;
}

const KNOWLEDGE_BODY_CAP = 100_000;
const EVENT_WINDOW_PAST = 180 * 86_400_000;
const EVENT_WINDOW_FUTURE = 730 * 86_400_000;
const ACCESS_RANK: Record<string, number> = { busy: 1, read: 2, write: 3 };

function db() {
  return getD1();
}

async function all<T>(sql: string, ...values: SqlValue[]): Promise<T[]> {
  const statement = values.length ? db().prepare(sql).bind(...values) : db().prepare(sql);
  const result = await statement.all<T>();
  return (result.results ?? []) as T[];
}

async function first<T>(sql: string, ...values: SqlValue[]): Promise<T | null> {
  const rows = await all<T>(sql, ...values);
  return rows[0] ?? null;
}

async function run(sql: string, ...values: SqlValue[]) {
  const statement = values.length ? db().prepare(sql).bind(...values) : db().prepare(sql);
  return statement.run();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function text(value: unknown, max = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function content(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolNumber(value: unknown, fallback = 0): number {
  return value === true || value === 1 ? 1 : value === false || value === 0 ? 0 : fallback;
}

function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && choices.includes(value as T)
    ? (value as T)
    : fallback;
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function jsonObjects(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      : [];
  } catch {
    return [];
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 54) || "note"
  );
}

async function workspaceRevision(workspaceId: string): Promise<number> {
  const row = await first<{ revision: number }>(
    `SELECT COALESCE(MAX(sequence), 0) AS revision
       FROM workspace_events
      WHERE workspace_id = ?`,
    workspaceId,
  );
  return Number(row?.revision ?? 0);
}

async function markChanged(
  workspaceId: string,
  actorId: string,
  kind: string,
  entityId: string,
): Promise<number> {
  await run(
    `INSERT INTO workspace_events
      (workspace_id, actor_id, kind, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    workspaceId,
    actorId,
    kind,
    entityId,
    now(),
  );
  return workspaceRevision(workspaceId);
}

async function recordTombstone(
  workspaceId: string,
  actorId: string,
  entity: SharedTombstone["entity"],
  entityId: string,
): Promise<number> {
  const revision = await markChanged(
    workspaceId,
    actorId,
    `${entity}.deleted`,
    entityId,
  );
  await run(
    `INSERT INTO content_tombstones
      (id, workspace_id, entity, entity_id, created_by, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, entity, entity_id) DO UPDATE SET
       created_by = excluded.created_by,
       revision = excluded.revision,
       created_at = excluded.created_at`,
    id("tomb"),
    workspaceId,
    entity,
    entityId,
    actorId,
    revision,
    now(),
  );
  return revision;
}

async function validSubject(
  workspaceId: string,
  subjectType: string,
  subjectId: string,
): Promise<boolean> {
  if (subjectType === "member") {
    return !!(await first(
      "SELECT 1 AS ok FROM memberships WHERE workspace_id = ? AND user_id = ?",
      workspaceId,
      subjectId,
    ));
  }
  if (subjectType === "team") {
    return !!(await first(
      "SELECT 1 AS ok FROM teams WHERE workspace_id = ? AND id = ?",
      workspaceId,
      subjectId,
    ));
  }
  if (subjectType === "agent") {
    return !!(await first(
      "SELECT 1 AS ok FROM agent_profiles WHERE workspace_id = ? AND id = ?",
      workspaceId,
      subjectId,
    ));
  }
  return false;
}

async function normalizeShares(
  workspaceId: string,
  raw: unknown,
  kind: "knowledge" | "calendar",
): Promise<AccessRow[]> {
  const values = Array.isArray(raw) ? raw.slice(0, 100) : [];
  const shares: AccessRow[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const subjectType = oneOf(
      row.subjectType,
      ["member", "team", "agent"] as const,
      "member",
    );
    const subjectId = text(row.subjectId, 180);
    const access =
      kind === "calendar"
        ? oneOf(row.access, ["busy", "read", "write"] as const, "busy")
        : oneOf(row.access, ["read", "write"] as const, "read");
    if (!subjectId || !(await validSubject(workspaceId, subjectType, subjectId))) continue;
    shares.push({ subjectType, subjectId, access });
  }
  return shares;
}

function sameShares(a: AccessRow[], b: AccessRow[]): boolean {
  const keys = (rows: AccessRow[]) =>
    rows.map((row) => `${row.subjectType}:${row.subjectId}:${row.access}`).sort();
  return JSON.stringify(keys(a)) === JSON.stringify(keys(b));
}

async function replaceKnowledgeShares(
  workspaceId: string,
  pageId: string,
  shares: AccessRow[],
): Promise<boolean> {
  const current = await all<AccessRow>(
    `SELECT subject_type AS subjectType, subject_id AS subjectId, access
       FROM knowledge_access
      WHERE workspace_id = ? AND page_id = ?`,
    workspaceId,
    pageId,
  );
  if (sameShares(current, shares)) return false;
  await run(
    "DELETE FROM knowledge_access WHERE workspace_id = ? AND page_id = ?",
    workspaceId,
    pageId,
  );
  for (const share of shares) {
    await run(
      `INSERT INTO knowledge_access
        (workspace_id, page_id, subject_type, subject_id, access)
       VALUES (?, ?, ?, ?, ?)`,
      workspaceId,
      pageId,
      share.subjectType,
      share.subjectId,
      share.access,
    );
  }
  return true;
}

async function replaceCalendarShares(
  workspaceId: string,
  calendarId: string,
  shares: AccessRow[],
): Promise<boolean> {
  const current = await all<AccessRow>(
    `SELECT subject_type AS subjectType, subject_id AS subjectId, access
       FROM shared_calendar_access
      WHERE workspace_id = ? AND calendar_id = ?`,
    workspaceId,
    calendarId,
  );
  if (sameShares(current, shares)) return false;
  await run(
    "DELETE FROM shared_calendar_access WHERE workspace_id = ? AND calendar_id = ?",
    workspaceId,
    calendarId,
  );
  for (const share of shares) {
    await run(
      `INSERT INTO shared_calendar_access
        (workspace_id, calendar_id, subject_type, subject_id, access)
       VALUES (?, ?, ?, ?, ?)`,
      workspaceId,
      calendarId,
      share.subjectType,
      share.subjectId,
      share.access,
    );
  }
  return true;
}

async function deleteKnowledgePage(
  device: DeviceIdentity,
  sourceType: "document" | "vault",
  sourceId: string,
  sourceCollectionId = "",
): Promise<void> {
  const rows = sourceType === "vault" && sourceCollectionId
    ? await all<{ id: string; sourceType: string; sourceCollectionId: string }>(
        `SELECT id, source_type AS sourceType,
                source_collection_id AS sourceCollectionId
           FROM knowledge_pages
          WHERE workspace_id = ? AND source_type = 'vault'
            AND source_device_id = ? AND source_collection_id = ?`,
        device.workspaceId,
        device.id,
        sourceCollectionId,
      )
    : await all<{ id: string; sourceType: string; sourceCollectionId: string }>(
        `SELECT id, source_type AS sourceType,
                source_collection_id AS sourceCollectionId
           FROM knowledge_pages
          WHERE workspace_id = ? AND source_type = ?
            AND source_device_id = ? AND source_record_id = ?`,
        device.workspaceId,
        sourceType,
        device.id,
        sourceId,
      );
  for (const row of rows) {
    await db().batch([
      db()
        .prepare("DELETE FROM page_links WHERE workspace_id = ? AND (from_page_id = ? OR to_page_id = ?)")
        .bind(device.workspaceId, row.id, row.id),
      db()
        .prepare("DELETE FROM knowledge_access WHERE workspace_id = ? AND page_id = ?")
        .bind(device.workspaceId, row.id),
      db()
        .prepare("DELETE FROM knowledge_pages WHERE workspace_id = ? AND id = ?")
        .bind(device.workspaceId, row.id),
    ]);
    await recordTombstone(
      device.workspaceId,
      device.id,
      row.sourceType === "vault" ? "vault_file" : "document",
      row.id,
    );
  }
  if (sourceType === "vault" && sourceCollectionId) {
    await recordTombstone(
      device.workspaceId,
      device.id,
      "vault",
      sourceCollectionId,
    );
  }
}

export async function rebuildPageLinks(workspaceId: string): Promise<void> {
  const pages = await all<{
    id: string;
    title: string;
    slug: string;
    path: string;
    body: string;
  }>(
    "SELECT id, title, slug, path, body FROM knowledge_pages WHERE workspace_id = ?",
    workspaceId,
  );
  const targets = new Map<string, string>();
  for (const page of pages) {
    const path = page.path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    const pathWithoutExtension = path.replace(/\.[^./]+$/, "");
    const fileName = pathWithoutExtension.slice(pathWithoutExtension.lastIndexOf("/") + 1);
    for (const alias of [
      page.title.trim().toLowerCase(),
      page.slug.trim().toLowerCase(),
      path,
      pathWithoutExtension,
      fileName,
    ]) {
      if (alias) targets.set(alias, page.id);
    }
  }
  await run("DELETE FROM page_links WHERE workspace_id = ?", workspaceId);
  const pattern = /\[\[([^\]]+)\]\]/g;
  for (const page of pages) {
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(page.body))) {
      const label = match[1]
        .split("|", 1)[0]
        .split("#", 1)[0]
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "")
        .toLowerCase();
      const withoutExtension = label.replace(/\.[^./]+$/, "");
      const fileName = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
      const targetId =
        targets.get(label) ??
        targets.get(withoutExtension) ??
        targets.get(fileName) ??
        targets.get(slug(label));
      if (targetId && targetId !== page.id) found.add(targetId);
    }
    for (const targetId of found) {
      await run(
        `INSERT OR IGNORE INTO page_links
          (workspace_id, from_page_id, to_page_id, created_at)
         VALUES (?, ?, ?, ?)`,
        workspaceId,
        page.id,
        targetId,
        now(),
      );
    }
  }
}

async function syncKnowledge(
  device: DeviceIdentity,
  raw: unknown,
): Promise<{ acks: SharedSyncAck[]; changed: boolean }> {
  const records = Array.isArray(raw) ? raw.slice(0, 250) : [];
  const acks: SharedSyncAck[] = [];
  let changed = false;
  for (const value of records) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const entity = oneOf(
      record.entity,
      ["document", "vault", "vault_file"] as const,
      "document",
    );
    const sourceId = text(record.sourceId, 220);
    const fingerprint = text(record.fingerprint, 2_000);
    if (!sourceId) continue;

    if (record.deleted === true || record.shared === false) {
      await deleteKnowledgePage(
        device,
        entity === "document" ? "document" : "vault",
        sourceId,
        entity === "vault" ? sourceId : text(record.collectionSourceId, 220),
      );
      acks.push({ entity, sourceId, remoteId: "", fingerprint });
      changed = true;
      continue;
    }

    if (entity === "vault") {
      acks.push({ entity, sourceId, remoteId: sourceId, fingerprint });
      continue;
    }

    const sourceType = entity === "document" ? "document" : "vault";
    const title = text(record.title, 300) || "Untitled";
    const body = content(record.body, KNOWLEDGE_BODY_CAP);
    const sourceCollectionId =
      entity === "vault_file" ? text(record.collectionSourceId, 220) : "";
    const existing = await first<{
      id: string;
      title: string;
      body: string;
      kind: string;
      tagsJson: string;
      ownerUserId: string;
      visibility: string;
      sourceLabel: string;
      path: string;
      updatedAt: string;
      slug: string;
    }>(
      `SELECT id, title, body, kind, tags_json AS tagsJson,
              owner_user_id AS ownerUserId, visibility,
              source_label AS sourceLabel, path, updated_at AS updatedAt, slug
         FROM knowledge_pages
        WHERE workspace_id = ? AND source_device_id = ? AND source_record_id = ?`,
      device.workspaceId,
      device.id,
      sourceId,
    );
    const pageId = existing?.id ?? id("page");
    const ownerCandidate = text(record.ownerUserId, 180);
    const ownerUserId =
      ownerCandidate &&
      (await validSubject(device.workspaceId, "member", ownerCandidate))
        ? ownerCandidate
        : device.ownerUserId;
    const visibility = oneOf(
      record.visibility,
      ["private", "workspace"] as const,
      sourceType === "vault" ? "workspace" : "private",
    );
    const kind = sourceType === "vault" ? "vault" : text(record.kind, 60) || "document";
    const tags = Array.isArray(record.tags)
      ? record.tags.map((tag) => text(tag, 60)).filter(Boolean).slice(0, 40)
      : [];
    const tagsJson = JSON.stringify(tags);
    const sourceLabel = text(record.sourceLabel, 180);
    const path = text(record.path, 500);
    const incomingUpdatedAt = new Date(number(record.updatedAt, Date.now())).toISOString();
    const shares = await normalizeShares(device.workspaceId, record.shares, "knowledge");
    const contentChanged =
      !existing ||
      existing.title !== title ||
      existing.body !== body ||
      existing.kind !== kind ||
      existing.tagsJson !== tagsJson ||
      existing.ownerUserId !== ownerUserId ||
      existing.visibility !== visibility ||
      existing.sourceLabel !== sourceLabel ||
      existing.path !== path ||
      existing.updatedAt !== incomingUpdatedAt;

    if (!existing) {
      const requestedSlug = `${slug(title)}-${pageId.slice(-8).toLowerCase()}`;
      await run(
        `INSERT INTO knowledge_pages
          (id, workspace_id, title, slug, body, kind, tags_json, created_by,
           owner_user_id, visibility, source_type, source_device_id,
           source_record_id, source_collection_id, source_label, path,
           revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        pageId,
        device.workspaceId,
        title,
        requestedSlug,
        body,
        kind,
        tagsJson,
        ownerUserId,
        ownerUserId,
        visibility,
        sourceType,
        device.id,
        sourceId,
        sourceCollectionId,
        sourceLabel,
        path,
        incomingUpdatedAt,
        incomingUpdatedAt,
      );
    } else if (contentChanged) {
      await run(
        `UPDATE knowledge_pages
            SET title = ?, body = ?, kind = ?, tags_json = ?,
                owner_user_id = ?, visibility = ?, source_collection_id = ?,
                source_label = ?, path = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
        title,
        body,
        kind,
        tagsJson,
        ownerUserId,
        visibility,
        sourceCollectionId,
        sourceLabel,
        path,
        incomingUpdatedAt,
        device.workspaceId,
        pageId,
      );
    }
    const sharesChanged = await replaceKnowledgeShares(
      device.workspaceId,
      pageId,
      shares,
    );
    const accessChanged =
      !!existing &&
      (existing.visibility !== visibility || sharesChanged);
    if (contentChanged || sharesChanged) {
      const revision = await markChanged(
        device.workspaceId,
        device.id,
        "knowledge.synced",
        pageId,
      );
      await run(
        "UPDATE knowledge_pages SET revision = ? WHERE workspace_id = ? AND id = ?",
        revision,
        device.workspaceId,
        pageId,
      );
      changed = true;
    }
    if (accessChanged) {
      await recordTombstone(
        device.workspaceId,
        device.id,
        sourceType === "vault" ? "vault_file" : "document",
        pageId,
      );
    }
    acks.push({ entity, sourceId, remoteId: pageId, fingerprint });
  }
  if (changed) await rebuildPageLinks(device.workspaceId);
  return { acks, changed };
}

async function resolveOwner(
  device: DeviceIdentity,
  rawType: unknown,
  rawId: unknown,
  rawLabel: unknown,
): Promise<{ type: "member" | "agent" | "team" | "workspace"; id: string; label: string }> {
  const type = oneOf(
    rawType,
    ["member", "agent", "team", "workspace"] as const,
    "member",
  );
  if (type === "workspace") {
    return { type, id: device.workspaceId, label: "Workspace" };
  }
  const candidate = text(rawId, 180);
  if (candidate && (await validSubject(device.workspaceId, type, candidate))) {
    return { type, id: candidate, label: text(rawLabel, 180) };
  }
  return { type: "member", id: device.ownerUserId, label: text(rawLabel, 180) };
}

async function deleteCalendar(device: DeviceIdentity, sourceId: string): Promise<void> {
  const calendar = await first<{ id: string }>(
    `SELECT id FROM shared_calendars
      WHERE workspace_id = ? AND source_device_id = ? AND source_calendar_id = ?`,
    device.workspaceId,
    device.id,
    sourceId,
  );
  if (!calendar) return;
  const eventIds = await all<{ id: string }>(
    "SELECT id FROM shared_calendar_events WHERE workspace_id = ? AND calendar_id = ?",
    device.workspaceId,
    calendar.id,
  );
  await db().batch([
    db()
      .prepare("DELETE FROM shared_calendar_events WHERE workspace_id = ? AND calendar_id = ?")
      .bind(device.workspaceId, calendar.id),
    db()
      .prepare("DELETE FROM shared_calendar_access WHERE workspace_id = ? AND calendar_id = ?")
      .bind(device.workspaceId, calendar.id),
    db()
      .prepare("DELETE FROM shared_calendars WHERE workspace_id = ? AND id = ?")
      .bind(device.workspaceId, calendar.id),
  ]);
  for (const event of eventIds) {
    await recordTombstone(
      device.workspaceId,
      device.id,
      "event",
      event.id,
    );
  }
  await recordTombstone(
    device.workspaceId,
    device.id,
    "calendar",
    calendar.id,
  );
}

async function syncCalendars(
  device: DeviceIdentity,
  rawCalendars: unknown,
  rawEvents: unknown,
): Promise<SharedSyncAck[]> {
  const acks: SharedSyncAck[] = [];
  const calendars = Array.isArray(rawCalendars) ? rawCalendars.slice(0, 100) : [];
  for (const value of calendars) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const sourceId = text(record.sourceId, 220);
    const fingerprint = text(record.fingerprint, 2_000);
    if (!sourceId) continue;
    if (record.deleted === true) {
      await deleteCalendar(device, sourceId);
      acks.push({ entity: "calendar", sourceId, remoteId: "", fingerprint });
      continue;
    }
    const name = text(record.name, 180) || "Calendar";
    const owner = await resolveOwner(
      device,
      record.ownerType,
      record.ownerId,
      record.ownerLabel,
    );
    const visibility = oneOf(
      record.visibility,
      ["private", "busy", "read", "write"] as const,
      "private",
    );
    const shares = await normalizeShares(device.workspaceId, record.shares, "calendar");
    const existing = await first<{
      id: string;
      name: string;
      color: string;
      provider: string;
      externalId: string;
      ownerType: string;
      ownerId: string;
      ownerLabel: string;
      visibility: string;
      writable: number;
    }>(
      `SELECT id, name, color, provider, external_id AS externalId,
              owner_type AS ownerType, owner_id AS ownerId,
              owner_label AS ownerLabel, visibility, writable
         FROM shared_calendars
        WHERE workspace_id = ? AND source_device_id = ? AND source_calendar_id = ?`,
      device.workspaceId,
      device.id,
      sourceId,
    );
    const calendarId = existing?.id ?? id("cal");
    const color = text(record.color, 60);
    const provider = text(record.provider, 40) || "hq";
    const externalId = text(record.externalId, 300);
    const writable = boolNumber(record.writable, 1);
    const contentChanged =
      !existing ||
      existing.name !== name ||
      existing.color !== color ||
      existing.provider !== provider ||
      existing.externalId !== externalId ||
      existing.ownerType !== owner.type ||
      existing.ownerId !== owner.id ||
      existing.ownerLabel !== owner.label ||
      existing.visibility !== visibility ||
      Number(existing.writable) !== writable;
    const stamp = now();
    if (!existing) {
      await run(
        `INSERT INTO shared_calendars
          (id, workspace_id, source_device_id, source_calendar_id, name, color,
           provider, external_id, owner_type, owner_id, owner_label, visibility,
           writable, created_by, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        calendarId,
        device.workspaceId,
        device.id,
        sourceId,
        name,
        color,
        provider,
        externalId,
        owner.type,
        owner.id,
        owner.label,
        visibility,
        writable,
        device.ownerUserId,
        stamp,
        stamp,
      );
    } else if (contentChanged) {
      await run(
        `UPDATE shared_calendars
            SET name = ?, color = ?, provider = ?, external_id = ?,
                owner_type = ?, owner_id = ?, owner_label = ?, visibility = ?,
                writable = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
        name,
        color,
        provider,
        externalId,
        owner.type,
        owner.id,
        owner.label,
        visibility,
        writable,
        stamp,
        device.workspaceId,
        calendarId,
      );
    }
    const sharesChanged = await replaceCalendarShares(
      device.workspaceId,
      calendarId,
      shares,
    );
    const accessChanged =
      !!existing &&
      (existing.ownerType !== owner.type ||
        existing.ownerId !== owner.id ||
        existing.visibility !== visibility ||
        sharesChanged);
    if (contentChanged || sharesChanged) {
      const revision = await markChanged(
        device.workspaceId,
        device.id,
        "calendar.synced",
        calendarId,
      );
      await run(
        "UPDATE shared_calendars SET revision = ? WHERE workspace_id = ? AND id = ?",
        revision,
        device.workspaceId,
        calendarId,
      );
    }
    if (accessChanged) {
      await recordTombstone(
        device.workspaceId,
        device.id,
        "calendar",
        calendarId,
      );
    }
    acks.push({ entity: "calendar", sourceId, remoteId: calendarId, fingerprint });
  }

  const events = Array.isArray(rawEvents) ? rawEvents.slice(0, 500) : [];
  for (const value of events) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const sourceId = text(record.sourceId, 220);
    const calendarSourceId = text(record.calendarSourceId, 220);
    const fingerprint = text(record.fingerprint, 2_000);
    if (!sourceId) continue;
    if (record.deleted === true) {
      const existing = await first<{ id: string }>(
        `SELECT id FROM shared_calendar_events
          WHERE workspace_id = ? AND source_device_id = ? AND source_event_id = ?`,
        device.workspaceId,
        device.id,
        sourceId,
      );
      if (existing) {
        await run(
          "DELETE FROM shared_calendar_events WHERE workspace_id = ? AND id = ?",
          device.workspaceId,
          existing.id,
        );
        await recordTombstone(
          device.workspaceId,
          device.id,
          "event",
          existing.id,
        );
      }
      acks.push({ entity: "event", sourceId, remoteId: "", fingerprint });
      continue;
    }
    if (!calendarSourceId) continue;
    const calendar = await first<{ id: string }>(
      `SELECT id FROM shared_calendars
        WHERE workspace_id = ? AND source_device_id = ? AND source_calendar_id = ?`,
      device.workspaceId,
      device.id,
      calendarSourceId,
    );
    if (!calendar) continue;
    const startsAt = number(record.startsAt);
    const endsAt = Math.max(number(record.endsAt, startsAt + 3_600_000), startsAt + 60_000);
    if (!startsAt) continue;
    const existing = await first<{ id: string; updatedAt: string }>(
      `SELECT id, updated_at AS updatedAt
         FROM shared_calendar_events
        WHERE workspace_id = ? AND source_device_id = ? AND source_event_id = ?`,
      device.workspaceId,
      device.id,
      sourceId,
    );
    const eventId = existing?.id ?? id("event");
    const updatedAt = new Date(number(record.updatedAt, Date.now())).toISOString();
    const values = [
      text(record.externalId, 300),
      text(record.title, 300),
      content(record.description, 12_000),
      text(record.location, 500),
      startsAt,
      endsAt,
      boolNumber(record.allDay),
      text(record.tz, 100),
      text(record.organizer, 500),
      JSON.stringify(
        Array.isArray(record.attendees)
          ? record.attendees.filter((entry) => !!entry && typeof entry === "object").slice(0, 200)
          : [],
      ),
      oneOf(record.status, ["confirmed", "tentative", "cancelled"] as const, "confirmed"),
      text(record.source, 40) || "hq",
      text(record.etag, 500),
    ] as const;
    if (!existing) {
      await run(
        `INSERT INTO shared_calendar_events
          (id, workspace_id, calendar_id, source_device_id, source_event_id,
           external_id, title, description, location, starts_at, ends_at,
           all_day, tz, organizer, attendees_json, status, source, etag,
           created_by, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        eventId,
        device.workspaceId,
        calendar.id,
        device.id,
        sourceId,
        ...values,
        device.ownerUserId,
        updatedAt,
        updatedAt,
      );
    } else {
      await run(
        `UPDATE shared_calendar_events
            SET calendar_id = ?, external_id = ?, title = ?, description = ?,
                location = ?, starts_at = ?, ends_at = ?, all_day = ?, tz = ?,
                organizer = ?, attendees_json = ?, status = ?, source = ?,
                etag = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
        calendar.id,
        ...values,
        updatedAt,
        device.workspaceId,
        eventId,
      );
    }
    if (!existing || existing.updatedAt !== updatedAt) {
      const revision = await markChanged(
        device.workspaceId,
        device.id,
        "calendar.event_synced",
        eventId,
      );
      await run(
        "UPDATE shared_calendar_events SET revision = ? WHERE workspace_id = ? AND id = ?",
        revision,
        device.workspaceId,
        eventId,
      );
    }
    acks.push({ entity: "event", sourceId, remoteId: eventId, fingerprint });
  }
  return acks;
}

async function teamsForUser(workspaceId: string, userId: string): Promise<Set<string>> {
  const rows = await all<{ teamId: string }>(
    `SELECT ta.team_id AS teamId
       FROM team_actors ta
       JOIN teams t ON t.id = ta.team_id
      WHERE t.workspace_id = ? AND ta.actor_type = 'person' AND ta.actor_id = ?`,
    workspaceId,
    userId,
  );
  return new Set(rows.map((row) => row.teamId));
}

function strongestAccess(
  base: string | null,
  shares: AccessRow[],
  userId: string,
  teamIds: Set<string>,
): string | null {
  let access = base;
  for (const share of shares) {
    const applies =
      (share.subjectType === "member" && share.subjectId === userId) ||
      (share.subjectType === "team" && teamIds.has(share.subjectId));
    if (!applies) continue;
    if (!access || (ACCESS_RANK[share.access] ?? 0) > (ACCESS_RANK[access] ?? 0)) {
      access = share.access;
    }
  }
  return access;
}

export async function loadSharedWorkspace(
  workspaceId: string,
  userId: string,
): Promise<{
  knowledgePages: KnowledgePage[];
  calendars: SharedCalendar[];
  calendarEvents: SharedCalendarEvent[];
  revision: number;
}> {
  const [
    teamIds,
    knowledgeRows,
    knowledgeShares,
    pageLinks,
    calendarRows,
    calendarShares,
  ] =
    await Promise.all([
      teamsForUser(workspaceId, userId),
      all<KnowledgeRow>(
        `SELECT p.id, p.title, p.slug, p.body, p.kind,
                p.tags_json AS tagsJson,
                COUNT(l.from_page_id) AS backlinkCount,
                p.source_type AS sourceType, p.source_label AS sourceLabel,
                p.source_device_id AS sourceDeviceId,
                p.source_record_id AS sourceRecordId,
                p.source_collection_id AS sourceCollectionId,
                p.path, p.owner_user_id AS ownerUserId, p.visibility,
                p.updated_at AS updatedAt, p.revision
           FROM knowledge_pages p
           LEFT JOIN page_links l
             ON l.workspace_id = p.workspace_id AND l.to_page_id = p.id
          WHERE p.workspace_id = ?
          GROUP BY p.id
          ORDER BY p.updated_at DESC`,
        workspaceId,
      ),
      all<AccessRow & { pageId: string }>(
        `SELECT page_id AS pageId, subject_type AS subjectType,
                subject_id AS subjectId, access
           FROM knowledge_access
          WHERE workspace_id = ?`,
        workspaceId,
      ),
      all<PageLinkRow>(
        `SELECT from_page_id AS fromPageId, to_page_id AS toPageId
           FROM page_links
          WHERE workspace_id = ?`,
        workspaceId,
      ),
      all<CalendarRow>(
        `SELECT id, name, color, provider, external_id AS externalId,
                owner_type AS ownerType, owner_id AS ownerId,
                owner_label AS ownerLabel, visibility, writable,
                source_device_id AS sourceDeviceId,
                source_calendar_id AS sourceCalendarId,
                created_by AS createdBy, updated_at AS updatedAt, revision
           FROM shared_calendars
          WHERE workspace_id = ?
          ORDER BY name`,
        workspaceId,
      ),
      all<AccessRow & { calendarId: string }>(
        `SELECT calendar_id AS calendarId, subject_type AS subjectType,
                subject_id AS subjectId, access
           FROM shared_calendar_access
          WHERE workspace_id = ?`,
        workspaceId,
      ),
    ]);

  const knowledgePages: KnowledgePage[] = [];
  for (const row of knowledgeRows) {
    const shares = knowledgeShares.filter((share) => share.pageId === row.id);
    const access =
      row.ownerUserId === userId
        ? "write"
        : strongestAccess(
            row.visibility === "workspace" ? "read" : null,
            shares,
            userId,
            teamIds,
          );
    if (access !== "read" && access !== "write") continue;
    const { tagsJson, revision, ...page } = row;
    void revision;
    knowledgePages.push({
      ...page,
      sourceType: oneOf(page.sourceType, ["portal", "document", "vault"] as const, "portal"),
      visibility: oneOf(page.visibility, ["private", "workspace"] as const, "workspace"),
      access,
      tags: jsonArray(tagsJson),
      backlinkCount: Number(page.backlinkCount ?? 0),
      backlinks: [],
    });
  }

  // Only reveal backlinks whose source and target are both visible to this
  // member. This keeps private page titles out of workspace-visible counts.
  const visiblePages = new Map(knowledgePages.map((page) => [page.id, page]));
  for (const page of knowledgePages) {
    page.backlinks = pageLinks
      .filter((link) => link.toPageId === page.id)
      .map((link) => visiblePages.get(link.fromPageId))
      .filter((source): source is KnowledgePage => Boolean(source))
      .map((source) => ({
        id: source.id,
        title: source.title,
        path: source.path,
        sourceLabel: source.sourceLabel,
      }))
      .sort((left, right) =>
        left.title.localeCompare(right.title, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
    page.backlinkCount = page.backlinks.length;
  }

  const calendars: SharedCalendar[] = [];
  const accessByCalendar = new Map<string, "busy" | "read" | "write">();
  for (const row of calendarRows) {
    const ownerAccess =
      row.createdBy === userId ||
      (row.ownerType === "member" && row.ownerId === userId) ||
      (row.ownerType === "team" && teamIds.has(row.ownerId))
        ? "write"
        : null;
    const base = row.visibility === "private" ? null : row.visibility;
    const access = ownerAccess ?? strongestAccess(
      base,
      calendarShares.filter((share) => share.calendarId === row.id),
      userId,
      teamIds,
    );
    if (access !== "busy" && access !== "read" && access !== "write") continue;
    const { revision, createdBy, ...calendar } = row;
    void revision;
    void createdBy;
    const normalized: SharedCalendar = {
      ...calendar,
      ownerType: oneOf(
        calendar.ownerType,
        ["member", "agent", "team", "workspace"] as const,
        "member",
      ),
      visibility: oneOf(
        calendar.visibility,
        ["private", "busy", "read", "write"] as const,
        "private",
      ),
      writable: Number(calendar.writable),
      access,
    };
    calendars.push(normalized);
    accessByCalendar.set(row.id, access);
  }

  const visibleIds = [...accessByCalendar.keys()];
  const eventRows = visibleIds.length
    ? await all<EventRow>(
        `SELECT id, calendar_id AS calendarId, external_id AS externalId,
                title, description, location, starts_at AS startsAt,
                ends_at AS endsAt, all_day AS allDay, tz, organizer,
                attendees_json AS attendeesJson, status, source, etag,
                source_device_id AS sourceDeviceId,
                source_event_id AS sourceEventId,
                updated_at AS updatedAt, revision
           FROM shared_calendar_events
          WHERE workspace_id = ?
            AND starts_at < ? AND ends_at > ?
          ORDER BY starts_at`,
        workspaceId,
        Date.now() + EVENT_WINDOW_FUTURE,
        Date.now() - EVENT_WINDOW_PAST,
      )
    : [];
  const calendarEvents: SharedCalendarEvent[] = [];
  for (const row of eventRows) {
    const access = accessByCalendar.get(row.calendarId);
    if (!access) continue;
    const redacted = access === "busy";
    const { attendeesJson, revision, ...event } = row;
    void revision;
    calendarEvents.push({
      ...event,
      title: redacted ? "Busy" : event.title,
      description: redacted ? "" : event.description,
      location: redacted ? "" : event.location,
      organizer: redacted ? "" : event.organizer,
      attendees: redacted ? [] : jsonObjects(attendeesJson),
      status: oneOf(event.status, ["confirmed", "tentative", "cancelled"] as const, "confirmed"),
      access,
      redacted,
      startsAt: Number(event.startsAt),
      endsAt: Number(event.endsAt),
      allDay: Number(event.allDay),
    });
  }

  const deliveredRevisions = [
    ...knowledgeRows.map((row) => Number(row.revision)),
    ...calendarRows.map((row) => Number(row.revision)),
    ...eventRows.map((row) => Number(row.revision)),
  ];
  return {
    knowledgePages,
    calendars,
    calendarEvents,
    revision: Math.max(0, ...deliveredRevisions),
  };
}

export async function syncSharedContent(
  device: DeviceIdentity,
  body: Record<string, unknown>,
): Promise<{
  acks: SharedSyncAck[];
  tombstones: SharedTombstone[];
  knowledgePages: KnowledgePage[];
  calendars: SharedCalendar[];
  calendarEvents: SharedCalendarEvent[];
  contentRevision: number;
}> {
  const cursor = Math.max(0, number(body.contentRevision));
  const knowledge = await syncKnowledge(device, body.knowledgeRecords);
  const calendarAcks = await syncCalendars(
    device,
    body.calendarRecords,
    body.calendarEventRecords,
  );
  const shared = await loadSharedWorkspace(device.workspaceId, device.ownerUserId);
  const tombstones = await all<SharedTombstone>(
    `SELECT entity, entity_id AS entityId, revision
       FROM content_tombstones
      WHERE workspace_id = ? AND revision > ?
      ORDER BY revision`,
    device.workspaceId,
    cursor,
  );
  const contentRevision = Math.max(
    cursor,
    shared.revision,
    ...tombstones.map((row) => Number(row.revision)),
  );
  return {
    acks: [...knowledge.acks, ...calendarAcks],
    tombstones,
    knowledgePages: shared.knowledgePages,
    calendars: shared.calendars,
    calendarEvents: shared.calendarEvents,
    contentRevision,
  };
}
