import { env } from "cloudflare:workers";
import {
  connectedAccountAccess,
  markConnectionSynced,
  type ConnectedAccountAccess,
} from "./integrations";

type ProviderAction =
  | "calendar.sources"
  | "calendar.list"
  | "calendar.create"
  | "mail.list"
  | "mail.send"
  | "social.publish";

interface ActionInput {
  action?: ProviderAction;
  provider?: string;
  calendarId?: string;
  calendarName?: string;
  startAt?: number;
  endAt?: number;
  folder?: string;
  title?: string;
  subject?: string;
  body?: string;
  to?: string;
  location?: string;
  notes?: string;
  allDay?: boolean;
  copy?: string;
  mediaUrl?: string;
  connectionId?: string;
  projectId?: string;
}

interface ProviderErrorShape {
  error?: string | { message?: string };
  error_description?: string;
  message?: string;
}

function runtime(): Record<string, string | undefined> {
  return env as unknown as Record<string, string | undefined>;
}

function requiredRuntime(key: string): string {
  const value = runtime()[key]?.trim();
  if (!value) throw new Error(`${key} is not configured.`);
  return value;
}

function cleanText(value: unknown, max = 20_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finiteStamp(value: unknown, fallback: number): number {
  const stamp = Number(value);
  return Number.isFinite(stamp) ? stamp : fallback;
}

function iso(stamp: number): string {
  return new Date(stamp).toISOString();
}

function parseProviderError(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object") return fallback;
  const shape = raw as ProviderErrorShape;
  if (typeof shape.error === "string") return shape.error;
  if (shape.error && typeof shape.error === "object" && shape.error.message) {
    return shape.error.message;
  }
  return shape.error_description || shape.message || fallback;
}

async function providerJson<T>(
  url: string,
  access: ConnectedAccountAccess,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${access.accessToken}`);
  headers.set("accept", "application/json");
  const response = await fetch(url, { ...init, headers });
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    raw = {};
  }
  if (!response.ok) {
    throw new Error(parseProviderError(raw, `${access.provider} rejected the request.`));
  }
  return raw as T;
}

function utcDateTime(value: unknown): number {
  const raw = String(value ?? "");
  if (!raw) return 0;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const stamp = Date.parse(normalized);
  return Number.isFinite(stamp) ? stamp : 0;
}

function googleCalendarEvent(
  item: Record<string, unknown>,
  calendarId: string,
  calendarName: string,
) {
  const start = (item.start ?? {}) as Record<string, unknown>;
  const end = (item.end ?? {}) as Record<string, unknown>;
  const allDay = typeof start.date === "string";
  return {
    id: String(item.id ?? ""),
    provider: "google",
    calendarId,
    calendarName,
    title: String(item.summary ?? "Untitled event"),
    startAt: Date.parse(String(start.dateTime ?? start.date ?? "")),
    endAt: Date.parse(String(end.dateTime ?? end.date ?? "")),
    allDay,
    location: String(item.location ?? ""),
    notes: String(item.description ?? ""),
    status: String(item.status ?? "confirmed"),
  };
}

function microsoftCalendarEvent(
  item: Record<string, unknown>,
  calendarId = "",
  calendarName = "Microsoft Calendar",
) {
  const start = (item.start ?? {}) as Record<string, unknown>;
  const end = (item.end ?? {}) as Record<string, unknown>;
  const location = (item.location ?? {}) as Record<string, unknown>;
  return {
    id: String(item.id ?? ""),
    provider: "microsoft",
    calendarId,
    calendarName,
    title: String(item.subject ?? "Untitled event"),
    startAt: utcDateTime(start.dateTime),
    endAt: utcDateTime(end.dateTime),
    allDay: Boolean(item.isAllDay),
    location: String(location.displayName ?? ""),
    notes: String(item.bodyPreview ?? ""),
    status: String(item.isCancelled ? "cancelled" : "confirmed"),
  };
}

interface CalendarSource {
  id: string;
  name: string;
  primary: boolean;
  writable: boolean;
}

async function listCalendarSources(
  access: ConnectedAccountAccess,
): Promise<CalendarSource[]> {
  if (access.provider === "google") {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "false");
    const raw = await providerJson<{
      items?: Array<Record<string, unknown>>;
    }>(url.toString(), access);
    return (raw.items ?? []).map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.summaryOverride ?? item.summary ?? "Google Calendar"),
      primary: Boolean(item.primary),
      writable: ["owner", "writer"].includes(String(item.accessRole ?? "")),
    })).filter((calendar) => calendar.id);
  }
  if (access.provider === "microsoft") {
    const url = new URL("https://graph.microsoft.com/v1.0/me/calendars");
    url.searchParams.set("$top", "250");
    url.searchParams.set(
      "$select",
      "id,name,canEdit,isDefaultCalendar",
    );
    const raw = await providerJson<{
      value?: Array<Record<string, unknown>>;
    }>(url.toString(), access);
    return (raw.value ?? []).map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? "Microsoft Calendar"),
      primary: Boolean(item.isDefaultCalendar),
      writable: item.canEdit !== false,
    })).filter((calendar) => calendar.id);
  }
  throw new Error("Calendar discovery is available for Google and Microsoft accounts.");
}

async function resolveCalendarSource(
  access: ConnectedAccountAccess,
  input: ActionInput,
): Promise<CalendarSource> {
  const sources = await listCalendarSources(access);
  const requestedId = cleanText(input.calendarId, 2_000);
  const requestedName = cleanText(input.calendarName, 500);
  const match =
    sources.find((calendar) => requestedId && calendar.id === requestedId) ??
    sources.find((calendar) => requestedName && calendar.name === requestedName) ??
    sources.find((calendar) => calendar.primary) ??
    sources[0];
  if (!match) throw new Error(`No ${access.provider} calendars are available.`);
  return match;
}

async function listCalendar(
  access: ConnectedAccountAccess,
  input: ActionInput,
) {
  const startAt = finiteStamp(input.startAt, Date.now() - 90 * 86_400_000);
  const endAt = finiteStamp(input.endAt, Date.now() + 365 * 86_400_000);
  const calendar = await resolveCalendarSource(access, input);
  if (access.provider === "google") {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events`,
    );
    url.searchParams.set("timeMin", iso(startAt));
    url.searchParams.set("timeMax", iso(endAt));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "2500");
    const raw = await providerJson<{
      summary?: string;
      items?: Array<Record<string, unknown>>;
    }>(url.toString(), access);
    return (raw.items ?? [])
      .map((item) => googleCalendarEvent(item, calendar.id, calendar.name))
      .filter((event) => Number.isFinite(event.startAt) && Number.isFinite(event.endAt));
  }
  if (access.provider === "microsoft") {
    const url = new URL(
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/calendarView`,
    );
    url.searchParams.set("startDateTime", iso(startAt));
    url.searchParams.set("endDateTime", iso(endAt));
    url.searchParams.set("$top", "1000");
    url.searchParams.set(
      "$select",
      "id,subject,start,end,isAllDay,isCancelled,location,bodyPreview,webLink",
    );
    const raw = await providerJson<{ value?: Array<Record<string, unknown>> }>(
      url.toString(),
      access,
      { headers: { Prefer: 'outlook.timezone="UTC"' } },
    );
    return (raw.value ?? []).map((item) =>
      microsoftCalendarEvent(item, calendar.id, calendar.name)
    );
  }
  throw new Error("Calendar sync is available for Google and Microsoft accounts.");
}

function dateOnly(stamp: number): string {
  return new Date(stamp).toISOString().slice(0, 10);
}

async function createCalendar(
  access: ConnectedAccountAccess,
  input: ActionInput,
) {
  const title = cleanText(input.title, 500);
  if (!title) throw new Error("An event title is required.");
  const startAt = finiteStamp(input.startAt, Date.now());
  const endAt = Math.max(startAt, finiteStamp(input.endAt, startAt + 3_600_000));
  const location = cleanText(input.location, 500);
  const notes = cleanText(input.notes, 20_000);
  const calendar = await resolveCalendarSource(access, input);
  if (!calendar.writable) {
    throw new Error(`“${calendar.name}” is read-only.`);
  }
  if (access.provider === "google") {
    const body = input.allDay
      ? {
          summary: title,
          description: notes,
          location,
          start: { date: dateOnly(startAt) },
          end: { date: dateOnly(endAt + 86_400_000) },
        }
      : {
          summary: title,
          description: notes,
          location,
          start: { dateTime: iso(startAt) },
          end: { dateTime: iso(endAt) },
        };
    const item = await providerJson<Record<string, unknown>>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events`,
      access,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return googleCalendarEvent(item, calendar.id, calendar.name);
  }
  if (access.provider === "microsoft") {
    const item = await providerJson<Record<string, unknown>>(
      `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendar.id)}/events`,
      access,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Prefer: 'outlook.timezone="UTC"',
        },
        body: JSON.stringify({
          subject: title,
          body: { contentType: "text", content: notes },
          start: { dateTime: iso(startAt).replace(/Z$/, ""), timeZone: "UTC" },
          end: { dateTime: iso(endAt).replace(/Z$/, ""), timeZone: "UTC" },
          isAllDay: Boolean(input.allDay),
          location: { displayName: location },
        }),
      },
    );
    return microsoftCalendarEvent(item, calendar.id, calendar.name);
  }
  throw new Error("Calendar creation is available for Google and Microsoft accounts.");
}

function decodeBase64Url(value: string): string {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function googleMessageBody(payload: Record<string, unknown>): string {
  const body = (payload.body ?? {}) as Record<string, unknown>;
  if (typeof body.data === "string" && body.data) return decodeBase64Url(body.data);
  const parts = Array.isArray(payload.parts)
    ? (payload.parts as Array<Record<string, unknown>>)
    : [];
  const plain = parts.find((part) => part.mimeType === "text/plain");
  if (plain) return googleMessageBody(plain);
  for (const part of parts) {
    const nested = googleMessageBody(part);
    if (nested) return nested;
  }
  return "";
}

function header(
  payload: Record<string, unknown>,
  name: string,
): string {
  const headers = Array.isArray(payload.headers)
    ? (payload.headers as Array<Record<string, unknown>>)
    : [];
  return String(
    headers.find((candidate) =>
      String(candidate.name ?? "").toLowerCase() === name.toLowerCase(),
    )?.value ?? "",
  );
}

function mailbox(value: string): { name: string; email: string } {
  const match = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: "", email: value.trim() };
}

async function listMail(
  access: ConnectedAccountAccess,
  input: ActionInput,
) {
  const folder = input.folder === "sent" ? "sent" : "inbox";
  if (access.provider === "google") {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("labelIds", folder === "sent" ? "SENT" : "INBOX");
    listUrl.searchParams.set("maxResults", "30");
    const list = await providerJson<{ messages?: Array<{ id: string }> }>(
      listUrl.toString(),
      access,
    );
    const items = await Promise.all(
      (list.messages ?? []).map(({ id }) =>
        providerJson<Record<string, unknown>>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
          access,
        ),
      ),
    );
    return items.map((item) => {
      const payload = (item.payload ?? {}) as Record<string, unknown>;
      const from = mailbox(header(payload, "From"));
      return {
        id: String(item.id ?? ""),
        provider: "google",
        accountId: access.connectionId,
        folder,
        subject: header(payload, "Subject") || "(no subject)",
        fromName: from.name,
        fromEmail: from.email,
        toEmail: header(payload, "To"),
        preview: String(item.snippet ?? ""),
        body: googleMessageBody(payload) || String(item.snippet ?? ""),
        unread: Array.isArray(item.labelIds) && item.labelIds.includes("UNREAD"),
        receivedAt: Number(item.internalDate ?? Date.now()),
      };
    });
  }
  if (access.provider === "microsoft") {
    const folderId = folder === "sent" ? "sentitems" : "inbox";
    const url = new URL(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages`,
    );
    url.searchParams.set("$top", "50");
    url.searchParams.set(
      "$select",
      "id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,body,isRead",
    );
    url.searchParams.set("$orderby", "receivedDateTime desc");
    const raw = await providerJson<{ value?: Array<Record<string, unknown>> }>(
      url.toString(),
      access,
      { headers: { Prefer: 'outlook.body-content-type="text"' } },
    );
    return (raw.value ?? []).map((item) => {
      const from = (item.from ?? {}) as Record<string, unknown>;
      const address = (from.emailAddress ?? {}) as Record<string, unknown>;
      const recipients = Array.isArray(item.toRecipients)
        ? (item.toRecipients as Array<Record<string, unknown>>)
        : [];
      const toEmail = recipients
        .map((recipient) => {
          const email = (recipient.emailAddress ?? {}) as Record<string, unknown>;
          return String(email.address ?? "");
        })
        .filter(Boolean)
        .join(", ");
      const body = (item.body ?? {}) as Record<string, unknown>;
      return {
        id: String(item.id ?? ""),
        provider: "microsoft",
        accountId: access.connectionId,
        folder,
        subject: String(item.subject ?? "(no subject)"),
        fromName: String(address.name ?? ""),
        fromEmail: String(address.address ?? ""),
        toEmail,
        preview: String(item.bodyPreview ?? ""),
        body: String(body.content ?? item.bodyPreview ?? ""),
        unread: !item.isRead,
        receivedAt: Date.parse(
          String(item.receivedDateTime ?? item.sentDateTime ?? new Date().toISOString()),
        ),
      };
    });
  }
  throw new Error("Mail sync is available for Google and Microsoft accounts.");
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendMail(
  access: ConnectedAccountAccess,
  input: ActionInput,
) {
  const to = safeHeader(cleanText(input.to, 1_000));
  const subject = safeHeader(cleanText(input.subject, 998));
  const body = cleanText(input.body, 100_000);
  if (!to || !to.includes("@")) throw new Error("A valid recipient is required.");
  if (access.provider === "google") {
    const raw = encodeBase64Url(
      [
        `To: ${to}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        body,
      ].join("\r\n"),
    );
    const sent = await providerJson<Record<string, unknown>>(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      access,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      },
    );
    return { id: String(sent.id ?? ""), provider: "google" };
  }
  if (access.provider === "microsoft") {
    await providerJson<Record<string, unknown>>(
      "https://graph.microsoft.com/v1.0/me/sendMail",
      access,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "Text", content: body },
            toRecipients: to
              .split(",")
              .map((address) => address.trim())
              .filter(Boolean)
              .map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        }),
      },
    );
    return { id: crypto.randomUUID(), provider: "microsoft" };
  }
  throw new Error("Mail sending is available for Google and Microsoft accounts.");
}

function httpsMediaUrl(value: unknown): string {
  const raw = cleanText(value, 4_000);
  if (!raw) throw new Error("A public HTTPS media URL is required for this platform.");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Media URLs must use HTTPS.");
  return url.toString();
}

async function publishSocial(
  access: ConnectedAccountAccess,
  input: ActionInput,
) {
  const copy = cleanText(input.copy, 10_000);
  if (!copy && access.provider === "x") throw new Error("Post copy is required.");
  if (access.provider === "x") {
    if (copy.length > 280) {
      throw new Error("This X post is over 280 characters.");
    }
    const raw = await providerJson<{ data?: { id?: string } }>(
      "https://api.x.com/2/tweets",
      access,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: copy }),
      },
    );
    const id = String(raw.data?.id ?? "");
    return {
      state: "published",
      externalId: id,
      url: id ? `https://x.com/i/web/status/${id}` : "",
    };
  }
  if (access.provider === "meta") {
    const mediaUrl = httpsMediaUrl(input.mediaUrl);
    const version = requiredRuntime("META_GRAPH_VERSION");
    const instagramId = access.accountId;
    if (!instagramId) {
      throw new Error("The connected Instagram account is missing its account ID.");
    }
    const containerBody = new URLSearchParams({
      image_url: mediaUrl,
      caption: copy,
    });
    const container = await providerJson<{ id?: string }>(
      `https://graph.instagram.com/${version}/${encodeURIComponent(instagramId)}/media`,
      access,
      { method: "POST", body: containerBody },
    );
    if (!container.id) {
      throw new Error("Instagram could not create the media post.");
    }
    const publishBody = new URLSearchParams({
      creation_id: String(container.id),
    });
    const published = await providerJson<{ id?: string }>(
      `https://graph.instagram.com/${version}/${encodeURIComponent(instagramId)}/media_publish`,
      access,
      { method: "POST", body: publishBody },
    );
    if (!published.id) {
      throw new Error("Instagram could not publish the media post.");
    }
    const details = await providerJson<{ permalink?: string }>(
      `https://graph.instagram.com/${version}/${encodeURIComponent(String(published.id))}?fields=permalink`,
      access,
    );
    return {
      state: "published",
      externalId: String(published.id),
      url: String(details.permalink ?? ""),
    };
  }
  if (access.provider === "tiktok") {
    const mediaUrl = httpsMediaUrl(input.mediaUrl);
    const creator = await providerJson<{
      data?: { privacy_level_options?: string[] };
    }>(
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      access,
      { method: "POST" },
    );
    const options = creator.data?.privacy_level_options ?? [];
    const privacy = options.includes("PUBLIC_TO_EVERYONE")
      ? "PUBLIC_TO_EVERYONE"
      : options.includes("SELF_ONLY")
        ? "SELF_ONLY"
        : options[0];
    if (!privacy) throw new Error("TikTok did not return an available privacy level.");
    const raw = await providerJson<{
      data?: { publish_id?: string };
      error?: { message?: string };
    }>(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      access,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          post_info: {
            title: copy,
            privacy_level: privacy,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: {
            source: "PULL_FROM_URL",
            video_url: mediaUrl,
          },
        }),
      },
    );
    const publishId = String(raw.data?.publish_id ?? "");
    if (!publishId) throw new Error("TikTok did not return a publish job.");
    return { state: "processing", externalId: publishId, url: "" };
  }
  throw new Error("Direct publishing is currently available for X, Instagram, and TikTok.");
}

interface AuthorizedDevice {
  workspaceId: string;
  ownerUserId: string;
}

export async function createConnectedCalendarEvent(
  workspaceId: string,
  actorUserId: string,
  providerId: string,
  input: ActionInput,
) {
  const access = await connectedAccountAccess(
    workspaceId,
    providerId,
    actorUserId,
  );
  const result = await createCalendar(access, input);
  await markConnectionSynced(access.connectionId);
  return result;
}

export async function runDeviceProviderAction(
  device: AuthorizedDevice,
  input: ActionInput,
) {
  const action = input.action;
  if (!action) throw new Error("A provider action is required.");
  const access = await connectedAccountAccess(
    device.workspaceId,
    input.provider ?? "",
    device.ownerUserId,
    {
      connectionId: cleanText(input.connectionId, 160),
      projectId: cleanText(input.projectId, 160),
    },
  );
  let result: unknown;
  if (action === "calendar.sources") result = await listCalendarSources(access);
  else if (action === "calendar.list") result = await listCalendar(access, input);
  else if (action === "calendar.create") result = await createCalendar(access, input);
  else if (action === "mail.list") result = await listMail(access, input);
  else if (action === "mail.send") result = await sendMail(access, input);
  else if (action === "social.publish") result = await publishSocial(access, input);
  else throw new Error("Unknown provider action.");
  await markConnectionSynced(access.connectionId);
  return { ok: true, result };
}
