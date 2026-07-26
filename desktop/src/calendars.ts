/**
 * Calendars in a communal workspace.
 *
 * Two questions drive everything here: *whose* calendar is this, and *how
 * much* of it may the person looking at it see. Ownership is a column;
 * visibility is a share list with a deliberately weak middle tier, `busy`,
 * which renders start and end times and nothing else. That tier is the whole
 * reason overlaying your week with a teammate's — or with the workspace's own — is safe
 * enough to be the default view.
 *
 * Fetching lives behind `setCalendarBridge`. Spaces itself never holds an OAuth
 * token: the paired portal does, and it exposes provider actions the desktop
 * calls with its device token. When nothing is paired the bridge is absent and
 * every function here still works against locally-created calendars, which is
 * what makes the view developable and usable offline.
 */
import { useStore } from "./store";
import { describeEntity } from "./entities";
import { avatarColor } from "./themes";
import { useTheme } from "./themeStore";
import type {
  Calendar, CalendarAccess, CalendarEvent, CalendarOwnerType, EntityRef,
} from "./types";

/* ── who is looking ───────────────────────────────────────────── */

/**
 * The person at this machine, as an entity reference.
 *
 * Every share and ownership check in this module routes through here, which is
 * what made growing a real members table a rename rather than an audit. Kept
 * as a function because the row is loaded asynchronously: a module-level
 * constant would freeze whatever was true at import time.
 */
export function localMember(): EntityRef {
  return { type: "member", id: useStore.getState().self().id };
}

/**
 * Historical alias. The seed row is deliberately id 'me', so this stays
 * correct for a single-user workspace — but anything that could run after a
 * second member joins should call localMember() instead.
 */
export const LOCAL_MEMBER: EntityRef = { type: "member", id: "me" };

export function ownerRef(cal: Calendar): EntityRef | null {
  if (cal.owner_type === "workspace") return null;
  return { type: cal.owner_type as "member" | "agent" | "team", id: cal.owner_id };
}

/* ── access ───────────────────────────────────────────────────── */

const RANK: Record<CalendarAccess, number> = { busy: 1, read: 2, write: 3 };

/**
 * What `viewer` may do with `cal`. Returns null for no access at all.
 *
 * Precedence is owner → explicit share → the calendar's default visibility.
 * An explicit share can only *raise* access above the default, never lower it
 * below what everyone already has: a share that silently took access away
 * would be a confusing way to express "hide this from one person".
 */
export function accessFor(cal: Calendar, viewer: EntityRef = localMember()): CalendarAccess | null {
  if (cal.owner_type === viewer.type && cal.owner_id === viewer.id) return "write";

  const s = useStore.getState();
  const base: CalendarAccess | null = cal.visibility === "private" ? null : cal.visibility;

  // A team share reaches every agent in that team, so an agent inherits what
  // its team was granted.
  const subjectIds = new Set<string>([viewer.id]);
  if (viewer.type === "agent") {
    for (const tm of s.teamMembers) if (tm.agent_id === viewer.id) subjectIds.add(tm.team_id);
  }

  let granted: CalendarAccess | null = null;
  for (const share of s.calendarShares) {
    if (share.calendar_id !== cal.id) continue;
    if (!subjectIds.has(share.subject_id)) continue;
    if (!granted || RANK[share.access] > RANK[granted]) granted = share.access;
  }

  if (!granted) return base;
  if (!base) return granted;
  return RANK[granted] > RANK[base] ? granted : base;
}

export function canWrite(cal: Calendar, viewer: EntityRef = localMember()): boolean {
  return !!cal.writable && accessFor(cal, viewer) === "write";
}

/** Calendars `viewer` may see at all, in a stable order. */
export function visibleCalendars(viewer: EntityRef = localMember()): Calendar[] {
  const order: CalendarOwnerType[] = ["member", "workspace", "team", "agent"];
  return useStore
    .getState()
    .calendars.filter((c) => accessFor(c, viewer) !== null)
    .sort(
      (a, b) =>
        order.indexOf(a.owner_type) - order.indexOf(b.owner_type) ||
        a.name.localeCompare(b.name)
    );
}

/**
 * An event as `viewer` is allowed to see it.
 *
 * At `busy` everything identifying is removed rather than hidden in the UI —
 * redacting at the data layer means a tooltip, a search index or a prompt
 * builder added later cannot leak what the grid was careful not to draw.
 */
export function redactEvent(ev: CalendarEvent, access: CalendarAccess): CalendarEvent {
  if (access !== "busy") return ev;
  return {
    ...ev,
    title: "Busy",
    description: "",
    location: "",
    organizer: "",
    attendees: "[]",
  };
}

export interface VisibleEvent {
  event: CalendarEvent;
  calendar: Calendar;
  access: CalendarAccess;
  /** True when the title and details were withheld. */
  redacted: boolean;
  color: string;
}

/** Every loaded event the viewer may see, already redacted where required. */
export function visibleEvents(viewer: EntityRef = localMember()): VisibleEvent[] {
  const s = useStore.getState();
  const byId = new Map(s.calendars.map((c) => [c.id, c] as const));
  const out: VisibleEvent[] = [];
  for (const event of s.events) {
    const calendar = byId.get(event.calendar_id);
    if (!calendar || !calendar.enabled) continue;
    const access = accessFor(calendar, viewer);
    if (!access) continue;
    out.push({
      event: redactEvent(event, access),
      calendar,
      access,
      redacted: access === "busy",
      color: calendarColor(calendar),
    });
  }
  return out.sort((a, b) => a.event.starts_at - b.event.starts_at);
}

/* ── presentation ─────────────────────────────────────────────── */

/** A calendar's color, falling back to the theme's hashed identity ramp. */
export function calendarColor(cal: Calendar): string {
  if (cal.color) return cal.color;
  return avatarColor(cal.owner_id || cal.id, useTheme.getState().theme);
}

/** "You", the workspace name, "Frontend team" — whose calendar this is. */
export function ownerLabel(cal: Calendar): string {
  if (cal.owner_type === "workspace") return "Workspace";
  if (cal.owner_type === "member" && cal.owner_id === localMember().id) return "You";
  const info = describeEntity({ type: cal.owner_type as EntityRef["type"], id: cal.owner_id });
  return info.exists ? info.title : cal.owner_id || "Unknown";
}

/* ── time ─────────────────────────────────────────────────────── */

export const DAY_MS = 86_400_000;

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `weekStartsOn` is 0 for Sunday, 1 for Monday. */
export function startOfWeek(t: number, weekStartsOn = 1): number {
  const d = new Date(startOfDay(t));
  const shift = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - shift);
  return d.getTime();
}

export function startOfMonth(t: number): number {
  const d = new Date(t);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Add days by calendar date rather than by milliseconds — a DST boundary makes
 * a "day" 23 or 25 hours long, and a grid built on 86_400_000 drifts an hour
 * for half the year.
 */
export function addDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function overlaps(ev: CalendarEvent, from: number, to: number): boolean {
  return ev.starts_at < to && ev.ends_at > from;
}

export interface PositionedEvent {
  item: VisibleEvent;
  /** Fraction of the day: 0 = midnight, 1 = the following midnight. */
  top: number;
  height: number;
  /** Column index and count, for side-by-side overlapping events. */
  column: number;
  columns: number;
}

/**
 * Lay out one day's timed events into columns so overlapping meetings sit side
 * by side instead of on top of each other. Classic sweep: events are grouped
 * into clusters that transitively overlap, and every cluster is as wide as its
 * busiest moment — which is what stops a single long event from squashing the
 * entire day into slivers.
 */
export function layoutDay(items: VisibleEvent[], dayStart: number): PositionedEvent[] {
  const dayEnd = addDays(dayStart, 1);
  const span = dayEnd - dayStart;
  const timed = items
    .filter((i) => !i.event.all_day && overlaps(i.event, dayStart, dayEnd))
    .sort((a, b) => a.event.starts_at - b.event.starts_at || b.event.ends_at - a.event.ends_at);

  const out: PositionedEvent[] = [];
  let cluster: PositionedEvent[] = [];
  let clusterEnd = -Infinity;
  const columnEnds: number[] = [];

  const flush = () => {
    const columns = columnEnds.length || 1;
    for (const p of cluster) p.columns = columns;
    out.push(...cluster);
    cluster = [];
    columnEnds.length = 0;
    clusterEnd = -Infinity;
  };

  for (const item of timed) {
    const start = Math.max(item.event.starts_at, dayStart);
    const end = Math.min(Math.max(item.event.ends_at, start + 60_000), dayEnd);
    if (start >= clusterEnd && cluster.length) flush();

    let column = columnEnds.findIndex((e) => e <= start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }

    cluster.push({
      item,
      top: (start - dayStart) / span,
      height: (end - start) / span,
      column,
      columns: 1,
    });
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) flush();
  return out;
}

/* ── the provider bridge ──────────────────────────────────────── */

export type CalendarActionName = "calendar.list" | "calendar.create" | "calendar.update" | "calendar.delete";

/**
 * The seam to whatever holds the OAuth tokens. The paired portal registers an
 * implementation at startup; when nothing is paired this stays null and the
 * calendar works purely on local rows.
 */
export type CalendarBridge = (action: CalendarActionName, params: Record<string, unknown>) => Promise<unknown>;

let bridge: CalendarBridge | null = null;

export function setCalendarBridge(fn: CalendarBridge | null): void {
  bridge = fn;
}

export function hasCalendarBridge(): boolean {
  return bridge !== null;
}

export interface SyncResult {
  ok: boolean;
  /** Number of events written, or the reason nothing happened. */
  changed: number;
  reason: string;
}

/**
 * Pull remote events into the local cache for a window.
 *
 * Deliberately additive-with-replacement per calendar: rows whose `source`
 * matches the provider are replaced, and anything Spaces created itself is left
 * alone. A sync that deleted local-only events because the remote didn't know
 * about them would lose user data on the first network hiccup.
 */
export async function syncCalendars(from: number, to: number): Promise<SyncResult> {
  if (!bridge) return { ok: false, changed: 0, reason: "No workspace paired — showing local calendars only." };
  const store = useStore.getState();
  const remote = store.calendars.filter((c) => c.account_id);
  if (!remote.length) return { ok: true, changed: 0, reason: "No connected accounts." };

  let changed = 0;
  for (const cal of remote) {
    try {
      const raw = await bridge("calendar.list", {
        calendarId: cal.external_id || cal.id,
        accountId: cal.account_id,
        from,
        to,
      });
      const rows = Array.isArray(raw) ? (raw as Partial<CalendarEvent>[]) : [];
      for (const row of rows) {
        if (!row.external_id || typeof row.starts_at !== "number") continue;
        const existing = store.events.find(
          (e) => e.calendar_id === cal.id && e.external_id === row.external_id
        );
        if (existing) {
          if (existing.etag && existing.etag === row.etag) continue;
          await store.updateEvent(existing.id, row);
        } else {
          await store.addEvent({
            calendar_id: cal.id,
            title: row.title ?? "(untitled)",
            starts_at: row.starts_at,
            ends_at: row.ends_at ?? row.starts_at + 3_600_000,
            ...row,
          });
        }
        changed++;
      }
    } catch (e) {
      // One failing calendar must not abort the others — a single expired
      // token should degrade to a stale column, not an empty week.
      await store.updateCalendar(cal.id, {});
      void e;
    }
  }
  await store.loadEvents(from, to);
  return { ok: true, changed, reason: "" };
}

/* ── the graph ────────────────────────────────────────────────── */

/** Events linked to an entity, for "what meetings is this task tangled in". */
export function eventsLinkedTo(ref: EntityRef): CalendarEvent[] {
  const s = useStore.getState();
  const ids = new Set<string>();
  for (const l of s.links) {
    if (l.from_type === ref.type && l.from_id === ref.id && l.to_type === "event") ids.add(l.to_id);
    if (l.to_type === ref.type && l.to_id === ref.id && l.from_type === "event") ids.add(l.from_id);
  }
  return s.events.filter((e) => ids.has(e.id));
}
