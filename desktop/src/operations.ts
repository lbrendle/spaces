import { getDb, now, uid } from "./db";
import { invoke } from "@tauri-apps/api/core";
import { portalProviderAction, uploadPortalMedia } from "./portal";
import { useStore } from "./store";
import { config } from "./config";

export interface DocumentRecord {
  id: string;
  project_id: string;
  title: string;
  body: string;
  source: string;
  tags: string;
  path: string;
  pinned: number;
  owner_member_id: string;
  visibility: "private" | "workspace";
  created_at: number;
  updated_at: number;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  title: string;
  body: string;
  tags: string;
  path: string;
  created_at: number;
}

export interface MailThread {
  id: string;
  account_id: string;
  folder: "inbox" | "drafts" | "sent" | "archive";
  subject: string;
  from_name: string;
  from_email: string;
  to_email: string;
  preview: string;
  body: string;
  unread: number;
  starred: number;
  received_at: number;
  updated_at: number;
}

export interface CalendarEventRecord {
  id: string;
  provider: string;
  external_id: string;
  calendar_name: string;
  title: string;
  start_at: number;
  end_at: number;
  all_day: number;
  location: string;
  notes: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ContentItem {
  id: string;
  project_id: string;
  campaign: string;
  title: string;
  brief: string;
  copy: string;
  platform: string;
  connection_id: string;
  status: "idea" | "drafting" | "review" | "scheduled" | "published";
  scheduled_at: number;
  published_url: string;
  media_url: string;
  publish_error: string;
  agent_id: string;
  created_at: number;
  updated_at: number;
}

export interface IntegrationAccount {
  id: string;
  category: "mail" | "calendar" | "social" | "storage" | "work";
  provider: string;
  label: string;
  handle: string;
  status: "disconnected" | "pending" | "connected" | "error";
  metadata: string;
  created_at: number;
  updated_at: number;
}

function contentChanged(): void {
  window.dispatchEvent(new CustomEvent("hq:content-change"));
  window.dispatchEvent(new CustomEvent("hq:portal-local-change"));
}

interface AppleCalendarEvent {
  id: string;
  calendar: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location: string;
  notes: string;
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const db = await getDb();
  return db.select<DocumentRecord[]>(
    "SELECT * FROM documents ORDER BY pinned DESC, path, updated_at DESC"
  );
}

export async function createDocument(
  projectId = "",
  path = "Notes"
): Promise<DocumentRecord> {
  const db = await getDb();
  const stamp = now();
  const document: DocumentRecord = {
    id: uid(),
    project_id: projectId,
    title: "Untitled",
    body: "",
    source: "spaces",
    tags: "",
    path: path.trim() || "Notes",
    pinned: 0,
    owner_member_id: useStore.getState().self().id,
    visibility: "private",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT INTO documents
     (id, project_id, title, body, source, tags, path, pinned,
      owner_member_id, visibility, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      document.id,
      document.project_id,
      document.title,
      document.body,
      document.source,
      document.tags,
      document.path,
      document.pinned,
      document.owner_member_id,
      document.visibility,
      document.created_at,
      document.updated_at,
    ]
  );
  return document;
}

export async function saveDocument(document: DocumentRecord): Promise<DocumentRecord> {
  const db = await getDb();
  const next = { ...document, updated_at: now() };
  const previous = await db.select<DocumentRecord[]>(
    "SELECT * FROM documents WHERE id = $1",
    [document.id]
  );
  const before = previous[0];
  if (
    before &&
    (before.title !== next.title ||
      before.body !== next.body ||
      before.tags !== next.tags ||
      before.path !== next.path)
  ) {
    await db.execute(
      `INSERT INTO document_versions
       (id, document_id, title, body, tags, path, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid(), before.id, before.title, before.body, before.tags, before.path, now()]
    );
  }
  await db.execute(
    `UPDATE documents
     SET project_id=$1, title=$2, body=$3, source=$4, tags=$5, path=$6,
         pinned=$7, updated_at=$8
     WHERE id=$9`,
    [
      next.project_id,
      next.title,
      next.body,
      next.source,
      next.tags,
      next.path,
      next.pinned,
      next.updated_at,
      next.id,
    ]
  );
  return next;
}

export async function duplicateDocument(document: DocumentRecord): Promise<DocumentRecord> {
  const copy = await createDocument(document.project_id);
  return saveDocument({
    ...copy,
    title: `${document.title || "Untitled"} copy`,
    body: document.body,
    source: document.source,
    tags: document.tags,
    path: document.path,
  });
}

export async function listDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
  const db = await getDb();
  return db.select<DocumentVersion[]>(
    "SELECT * FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC",
    [documentId]
  );
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM document_versions WHERE document_id = $1", [id]);
  await db.execute("DELETE FROM documents WHERE id = $1", [id]);
}

export async function listMail(folder: string): Promise<MailThread[]> {
  const db = await getDb();
  return db.select<MailThread[]>(
    "SELECT * FROM mail_threads WHERE folder = $1 ORDER BY received_at DESC, updated_at DESC",
    [folder]
  );
}

export async function createDraft(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<MailThread> {
  const db = await getDb();
  const stamp = now();
  const row: MailThread = {
    id: uid(),
    account_id: "",
    folder: "drafts",
    subject: input.subject.trim() || "(no subject)",
    from_name: useStore.getState().self().name,
    from_email: "",
    to_email: input.to.trim(),
    preview: input.body.trim().slice(0, 180),
    body: input.body,
    unread: 0,
    starred: 0,
    received_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT INTO mail_threads
     (id, account_id, folder, subject, from_name, from_email, to_email, preview,
      body, unread, starred, received_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.id,
      row.account_id,
      row.folder,
      row.subject,
      row.from_name,
      row.from_email,
      row.to_email,
      row.preview,
      row.body,
      row.unread,
      row.starred,
      row.received_at,
      row.updated_at,
    ]
  );
  contentChanged();
  return row;
}

export async function patchMailThread(
  id: string,
  patch: Partial<Pick<MailThread, "unread" | "starred" | "folder">>
): Promise<void> {
  const db = await getDb();
  if (patch.unread !== undefined) {
    await db.execute("UPDATE mail_threads SET unread=$1, updated_at=$2 WHERE id=$3", [
      patch.unread,
      now(),
      id,
    ]);
  }
  if (patch.starred !== undefined) {
    await db.execute("UPDATE mail_threads SET starred=$1, updated_at=$2 WHERE id=$3", [
      patch.starred,
      now(),
      id,
    ]);
  }
  if (patch.folder !== undefined) {
    await db.execute("UPDATE mail_threads SET folder=$1, updated_at=$2 WHERE id=$3", [
      patch.folder,
      now(),
      id,
    ]);
  }
}

interface RemoteMailRecord {
  id: string;
  provider: string;
  accountId: string;
  folder: "inbox" | "sent";
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  preview: string;
  body: string;
  unread: boolean;
  receivedAt: number;
}

export async function syncCloudMail(
  provider: "google" | "microsoft",
  folder: "inbox" | "sent" = "inbox"
): Promise<MailThread[]> {
  const remote = await portalProviderAction<RemoteMailRecord[]>("mail.list", provider, {
    folder,
  });
  const db = await getDb();
  const stamp = now();
  for (const message of remote) {
    await db.execute(
      `INSERT INTO mail_threads
       (id, account_id, folder, subject, from_name, from_email, to_email, preview,
        body, unread, starred, received_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12)
       ON CONFLICT(id) DO UPDATE SET
         folder=excluded.folder,
         subject=excluded.subject,
         from_name=excluded.from_name,
         from_email=excluded.from_email,
         to_email=excluded.to_email,
         preview=excluded.preview,
         body=excluded.body,
         unread=excluded.unread,
         received_at=excluded.received_at,
         updated_at=excluded.updated_at`,
      [
        `${provider}-${message.id}`,
        message.accountId,
        message.folder,
        message.subject,
        message.fromName,
        message.fromEmail,
        message.toEmail,
        message.preview,
        message.body,
        message.unread ? 1 : 0,
        message.receivedAt,
        stamp,
      ]
    );
  }
  return listMail(folder);
}

export async function sendCloudMail(
  provider: "google" | "microsoft",
  input: { to: string; subject: string; body: string }
): Promise<MailThread> {
  const result = await portalProviderAction<{ id: string; provider: string }>(
    "mail.send",
    provider,
    input
  );
  const db = await getDb();
  const stamp = now();
  const row: MailThread = {
    id: `${provider}-${result.id || uid()}`,
    account_id: provider,
    folder: "sent",
    subject: input.subject.trim() || "(no subject)",
    from_name: "Me",
    from_email: "",
    to_email: input.to.trim(),
    preview: input.body.trim().slice(0, 180),
    body: input.body,
    unread: 0,
    starred: 0,
    received_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT OR REPLACE INTO mail_threads
     (id, account_id, folder, subject, from_name, from_email, to_email, preview,
      body, unread, starred, received_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$10)`,
    [
      row.id,
      row.account_id,
      row.folder,
      row.subject,
      row.from_name,
      row.from_email,
      row.to_email,
      row.preview,
      row.body,
      stamp,
    ]
  );
  return row;
}

export async function listCalendarEvents(): Promise<CalendarEventRecord[]> {
  const db = await getDb();
  return db.select<CalendarEventRecord[]>(
    "SELECT * FROM calendar_events ORDER BY start_at, end_at"
  );
}

export async function syncAppleCalendar(): Promise<CalendarEventRecord[]> {
  const startAt = now() - 90 * 86_400_000;
  const endAt = now() + 365 * 86_400_000;
  const raw = await invoke<string>("apple_calendar_snapshot", { startAt, endAt });
  const events = JSON.parse(raw) as AppleCalendarEvent[];
  const db = await getDb();
  const stamp = now();
  await db.execute("DELETE FROM calendar_events WHERE provider = 'apple'");
  for (const event of events) {
    await db.execute(
      `INSERT INTO calendar_events
       (id, provider, external_id, calendar_name, title, start_at, end_at, all_day,
        location, notes, status, created_at, updated_at)
       VALUES ($1,'apple',$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$10)`,
      [
        `apple-${event.id || uid()}`,
        event.id,
        event.calendar,
        event.title,
        event.startAt,
        event.endAt,
        event.allDay ? 1 : 0,
        event.location,
        event.notes,
        stamp,
      ]
    );
  }
  await db.execute(
    `INSERT INTO integration_accounts
     (id, category, provider, label, handle, status, metadata, created_at, updated_at)
     VALUES ('calendar-apple','calendar','apple','Apple Calendar','','connected',$1,$2,$2)
     ON CONFLICT(id) DO UPDATE SET status='connected', metadata=$1, updated_at=$2`,
    [JSON.stringify({ events: events.length, rangeStart: startAt, rangeEnd: endAt }), stamp]
  );
  return listCalendarEvents();
}

interface RemoteCalendarEvent {
  id: string;
  provider: string;
  calendarId: string;
  calendarName: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location: string;
  notes: string;
  status: string;
}

interface RemoteCalendarSource {
  id: string;
  name: string;
  primary: boolean;
  writable: boolean;
}

async function persistRemoteCalendarEvent(
  event: RemoteCalendarEvent
): Promise<CalendarEventRecord> {
  const db = await getDb();
  const stamp = now();
  const row: CalendarEventRecord = {
    id: `${event.provider}-${event.calendarId || "default"}-${event.id}`,
    provider: event.provider,
    external_id: event.id,
    calendar_name: event.calendarId || event.calendarName,
    title: event.title,
    start_at: event.startAt,
    end_at: event.endAt,
    all_day: event.allDay ? 1 : 0,
    location: event.location,
    notes: event.notes,
    status: event.status || "confirmed",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT OR REPLACE INTO calendar_events
     (id, provider, external_id, calendar_name, title, start_at, end_at, all_day,
      location, notes, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [
      row.id,
      row.provider,
      row.external_id,
      row.calendar_name,
      row.title,
      row.start_at,
      row.end_at,
      row.all_day,
      row.location,
      row.notes,
      row.status,
      stamp,
    ]
  );
  return row;
}

export async function syncCloudCalendar(
  provider: "google" | "microsoft"
): Promise<CalendarEventRecord[]> {
  const startAt = now() - 90 * 86_400_000;
  const endAt = now() + 365 * 86_400_000;
  const sources = await portalProviderAction<RemoteCalendarSource[]>(
    "calendar.sources",
    provider,
  );
  const integrations = await listIntegrationAccounts();
  const accountId =
    integrations.find(
      (account) =>
        account.category === "calendar" && account.provider === provider,
    )?.id ??
    useStore.getState().calendarAccounts.find(
      (account) => account.provider === provider,
    )?.id ??
    "";
  const me = useStore.getState().self();
  if (accountId) {
    for (const source of sources) {
      const exists = useStore.getState().calendars.find(
        (calendar) =>
          calendar.account_id === accountId &&
          calendar.external_id === source.id,
      );
      if (exists) {
        if (exists.name !== source.name || exists.writable !== (source.writable ? 1 : 0)) {
          await useStore.getState().updateCalendar(exists.id, {
            name: source.name,
            writable: source.writable ? 1 : 0,
          });
        }
        continue;
      }
      const legacy = useStore.getState().calendars.find(
        (calendar) =>
          calendar.account_id === accountId &&
          calendar.external_id === source.name,
      );
      if (legacy) {
        await useStore.getState().updateCalendar(legacy.id, {
          name: source.name,
          external_id: source.id,
          writable: source.writable ? 1 : 0,
        });
      } else {
        await useStore.getState().addCalendar({
          name: source.name,
          account_id: accountId,
          external_id: source.id,
          owner_type: "member",
          owner_id: me.id,
          visibility: "private",
          writable: source.writable ? 1 : 0,
          enabled: 1,
        });
      }
    }
  }
  const remote = (
    await Promise.all(
      sources.map((calendar) =>
        portalProviderAction<RemoteCalendarEvent[]>(
          "calendar.list",
          provider,
          {
            startAt,
            endAt,
            calendarId: calendar.id,
            calendarName: calendar.name,
          }
        )
      )
    )
  ).flat();
  const db = await getDb();
  await db.execute("DELETE FROM calendar_events WHERE provider = $1", [provider]);
  for (const event of remote) await persistRemoteCalendarEvent(event);
  return listCalendarEvents();
}

export async function createCloudCalendarEvent(
  provider: "google" | "microsoft",
  input: {
    title: string;
    startAt: number;
    endAt: number;
    calendarId?: string;
    calendarName?: string;
    allDay?: boolean;
    location?: string;
    notes?: string;
  }
): Promise<CalendarEventRecord> {
  const event = await portalProviderAction<RemoteCalendarEvent>(
    "calendar.create",
    provider,
    input
  );
  return persistRemoteCalendarEvent(event);
}

export async function createAppleCalendarEvent(input: {
  title: string;
  startAt: number;
  endAt: number;
  calendarName?: string;
  location?: string;
  notes?: string;
}): Promise<CalendarEventRecord> {
  const raw = await invoke<string>("apple_calendar_create", {
    title: input.title,
    startAt: input.startAt,
    endAt: input.endAt,
    calendarName: input.calendarName ?? "",
    location: input.location ?? "",
    notes: input.notes ?? "",
  });
  const event = JSON.parse(raw) as AppleCalendarEvent;
  const db = await getDb();
  const stamp = now();
  const row: CalendarEventRecord = {
    id: `apple-${event.id || uid()}`,
    provider: "apple",
    external_id: event.id,
    calendar_name: event.calendar || "Apple Calendar",
    title: event.title,
    start_at: event.startAt,
    end_at: event.endAt,
    all_day: event.allDay ? 1 : 0,
    location: event.location,
    notes: event.notes,
    status: "confirmed",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT OR REPLACE INTO calendar_events
     (id, provider, external_id, calendar_name, title, start_at, end_at, all_day,
      location, notes, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.id,
      row.provider,
      row.external_id,
      row.calendar_name,
      row.title,
      row.start_at,
      row.end_at,
      row.all_day,
      row.location,
      row.notes,
      row.status,
      row.created_at,
      row.updated_at,
    ]
  );
  return row;
}

export async function createCalendarEvent(input: {
  title: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  calendarName?: string;
  location?: string;
  notes?: string;
}): Promise<CalendarEventRecord> {
  const db = await getDb();
  const stamp = now();
  const row: CalendarEventRecord = {
    id: uid(),
    provider: "spaces",
    external_id: "",
    calendar_name: input.calendarName || config().brand,
    title: input.title.trim(),
    start_at: input.startAt,
    end_at: Math.max(input.startAt, input.endAt),
    all_day: input.allDay ? 1 : 0,
    location: input.location?.trim() ?? "",
    notes: input.notes?.trim() ?? "",
    status: "confirmed",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT INTO calendar_events
     (id, provider, external_id, calendar_name, title, start_at, end_at, all_day,
      location, notes, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.id,
      row.provider,
      row.external_id,
      row.calendar_name,
      row.title,
      row.start_at,
      row.end_at,
      row.all_day,
      row.location,
      row.notes,
      row.status,
      row.created_at,
      row.updated_at,
    ]
  );
  return row;
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM calendar_events WHERE id = $1", [id]);
}

export async function listContentItems(): Promise<ContentItem[]> {
  const db = await getDb();
  return db.select<ContentItem[]>("SELECT * FROM content_items ORDER BY updated_at DESC");
}

export async function createContentItem(
  input: Pick<ContentItem, "project_id" | "campaign" | "title" | "brief" | "copy" | "platform" | "connection_id" | "status" | "scheduled_at" | "agent_id" | "media_url">
): Promise<ContentItem> {
  const db = await getDb();
  const stamp = now();
  const row: ContentItem = {
    id: uid(),
    ...input,
    published_url: "",
    publish_error: "",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.execute(
    `INSERT INTO content_items
     (id, project_id, campaign, title, brief, copy, platform, status,
      connection_id, scheduled_at, published_url, agent_id, media_url,
      publish_error, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      row.id,
      row.project_id,
      row.campaign,
      row.title,
      row.brief,
      row.copy,
      row.platform,
      row.status,
      row.connection_id,
      row.scheduled_at,
      row.published_url,
      row.agent_id,
      row.media_url,
      row.publish_error,
      row.created_at,
      row.updated_at,
    ]
  );
  return row;
}

export async function patchContentItem(
  id: string,
  patch: Partial<
    Pick<
      ContentItem,
      | "project_id"
      | "campaign"
      | "title"
      | "brief"
      | "copy"
      | "platform"
      | "connection_id"
      | "status"
      | "scheduled_at"
      | "published_url"
      | "media_url"
      | "publish_error"
      | "agent_id"
    >
  >
): Promise<void> {
  const db = await getDb();
  for (const [key, value] of Object.entries(patch)) {
    if (
      ![
        "project_id",
        "campaign",
        "title",
        "brief",
        "copy",
        "platform",
        "connection_id",
        "status",
        "scheduled_at",
        "published_url",
        "media_url",
        "publish_error",
        "agent_id",
      ].includes(key)
    ) continue;
    await db.execute(`UPDATE content_items SET ${key}=$1, updated_at=$2 WHERE id=$3`, [
      value,
      now(),
      id,
    ]);
  }
  if (Object.keys(patch).length) contentChanged();
}

export async function deleteContentItem(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM content_items WHERE id = $1", [id]);
  contentChanged();
}

export async function publishContentItem(
  item: ContentItem
): Promise<{ state: "published" | "processing"; externalId: string; url: string }> {
  const provider =
    item.platform === "instagram"
      ? "meta"
      : item.platform === "tiktok"
        ? "tiktok"
        : item.platform === "x"
          ? "x"
          : "";
  if (!provider) {
    throw new Error("Direct publishing is currently available for Instagram, TikTok, and X.");
  }
  try {
    const result = await portalProviderAction<{
      state: "published" | "processing";
      externalId: string;
      url: string;
    }>("social.publish", provider, {
      copy: item.copy,
      mediaUrl: item.media_url,
      projectId: item.project_id,
      connectionId: item.connection_id,
    });
    await patchContentItem(item.id, {
      status: result.state === "published" ? "published" : "scheduled",
      published_url: result.url || `${provider}:${result.externalId}`,
      publish_error: "",
    });
    return result;
  } catch (reason) {
    await patchContentItem(item.id, {
      publish_error: reason instanceof Error ? reason.message : String(reason),
    });
    throw reason;
  }
}

export async function uploadContentMedia(
  path: string,
  projectId = "",
  allowedRoot = "",
): Promise<string> {
  const media = await uploadPortalMedia(path, projectId, allowedRoot);
  return media.url;
}

export async function listIntegrationAccounts(): Promise<IntegrationAccount[]> {
  const db = await getDb();
  return db.select<IntegrationAccount[]>(
    "SELECT * FROM integration_accounts ORDER BY category, provider, label"
  );
}
