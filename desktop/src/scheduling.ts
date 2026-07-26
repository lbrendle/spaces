/**
 * Finding a time everybody can make.
 *
 * Free/busy is the one calendar feature that *has* to work across a privacy
 * boundary: the whole point of asking "when is Sam free" is that you get an
 * answer without reading Sam's week. So everything here is built on
 * `visibleEvents()`, which has already redacted anything shared at the `busy`
 * tier, and nothing in this module ever reaches back to the raw row. A block
 * the viewer may not read arrives as an interval with no title, no location and
 * no event id — the id is withheld deliberately, because `describeEntity()`
 * projects the unredacted store and handing one out would re-open the door the
 * redaction just closed.
 *
 * The second idea is honesty about coverage. "Free" is only ever "free as far
 * as I can see", and a subject with a calendar you have no access to, or one
 * switched off in the overlay, has not really been checked. Those are counted
 * and reported rather than quietly folded into a green slot.
 *
 * The third is honesty about delivery. A meeting on a provider-backed calendar
 * is pushed upstream; a meeting on a local calendar is not, and the result says
 * which happened in words. Spaces cannot add guests to a provider event yet, so
 * nothing here ever claims an invitation was sent.
 */
import { useStore } from "./store";
import { accessFor, addDays, localMember, startOfDay, visibleEvents } from "./calendars";
import { describeEntity } from "./entities";
import {
  createAppleCalendarEvent,
  createCloudCalendarEvent,
  listIntegrationAccounts,
} from "./operations";
import type { Calendar, CalendarEvent, EntityRef } from "./types";

/* ── time, in the timezone the user actually lives in ─────────── */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/**
 * The instant `minutes` past local midnight on the day containing `t`.
 *
 * Built with setHours rather than arithmetic on purpose: on a DST boundary a
 * day is 23 or 25 hours long, and "09:00 on Sunday" is a wall-clock fact, not
 * an offset from midnight.
 */
export function atMinutes(t: number, minutes: number): number {
  const d = new Date(startOfDay(t));
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
}

/** Minutes past local midnight, for turning an instant back into a time input. */
export function minutesOfDay(t: number): number {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

function isWeekend(t: number): boolean {
  const day = new Date(t).getDay();
  return day === 0 || day === 6;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

export function formatTime(t: number): string {
  return timeFmt.format(t);
}

export function formatDay(t: number): string {
  return dayFmt.format(t);
}

/** "Mon 28 Jul, 09:00 – 09:30" — the one phrasing every surface here uses. */
export function formatSlot(slot: { start: number; end: number }): string {
  return `${formatDay(slot.start)}, ${formatTime(slot.start)} – ${formatTime(slot.end)}`;
}

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / MINUTE_MS);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/* ── who is busy ──────────────────────────────────────────────── */

/**
 * One block of somebody's time.
 *
 * `title` is present only when the viewer was allowed to read it. There is no
 * event id: a redacted block must not be resolvable back to its row, and
 * carrying the id for readable blocks only would make the absence of one a tell.
 */
export interface BusyInterval {
  start: number;
  end: number;
  /** The calendar is nameable — access to it is what was granted. */
  calendarId: string;
  calendarName: string;
  /** The calendar's identity color, for the overlay. */
  color: string;
  /** True when the viewer sees only that this time is taken. */
  redacted: boolean;
  /** Withheld entirely for redacted blocks. */
  title: string;
  allDay: boolean;
  /** A "maybe" on somebody's calendar is a softer obstacle than a "yes". */
  tentative: boolean;
}

/** Everything known about one attendee's availability, including what is unknown. */
export interface SubjectBusy {
  subject: EntityRef;
  label: string;
  /** Sorted by start. Overlapping blocks are kept apart so the overlay is truthful. */
  intervals: BusyInterval[];
  /** Owned calendars that actually fed this answer. */
  checkedCalendars: number;
  /** Owned calendars the viewer has no access to. A count only — a name would leak. */
  hiddenCalendars: number;
  /** Owned calendars switched off in the overlay, so never consulted. */
  mutedCalendars: number;
  /** False when something was not checked, so "free" is a guess rather than a fact. */
  certain: boolean;
}

/**
 * The calendars that speak for a subject.
 *
 * A team's own calendar plus every calendar owned by an agent on that team:
 * booking a team means booking its agents, and a team calendar alone would miss
 * the work they are individually committed to.
 *
 * Workspace calendars belong to nobody, so they make nobody busy. Treating them
 * as everyone's busy time would make the all-hands the reason you cannot
 * schedule the all-hands.
 */
function calendarsOf(subject: EntityRef): Calendar[] {
  const s = useStore.getState();
  const owners = new Set<string>([subject.id]);
  if (subject.type === "team") {
    for (const tm of s.teamMembers) if (tm.team_id === subject.id) owners.add(tm.agent_id);
  }
  const types: string[] = subject.type === "team" ? ["team", "agent"] : [subject.type];
  return s.calendars.filter((c) => types.includes(c.owner_type) && owners.has(c.owner_id));
}

/** "You", "Sam", "Spaces", "Frontend team" — never an opaque id. */
export function subjectLabel(subject: EntityRef): string {
  if (subject.type === "member") {
    const s = useStore.getState();
    if (subject.id === s.self().id) return "You";
    const m = s.members.find((x) => x.id === subject.id);
    if (m) return m.name;
  }
  const info = describeEntity(subject);
  return info.exists ? info.title : subject.id;
}

/**
 * Busy intervals per subject over [from, to).
 *
 * A block the viewer may only see as "busy" counts exactly as much as one they
 * can read — that tier exists so this function can be useful without being
 * nosy. Redacted blocks come back as bare intervals; the title never travels.
 */
export function freeBusy(
  subjects: EntityRef[],
  from: number,
  to: number,
  viewer: EntityRef = localMember()
): SubjectBusy[] {
  const visible = visibleEvents(viewer);
  const byCalendar = new Map<string, typeof visible>();
  for (const item of visible) {
    const bucket = byCalendar.get(item.event.calendar_id);
    if (bucket) bucket.push(item);
    else byCalendar.set(item.event.calendar_id, [item]);
  }

  return subjects.map((subject) => {
    const owned = calendarsOf(subject);
    const intervals: BusyInterval[] = [];
    let checked = 0;
    let hidden = 0;
    let muted = 0;

    for (const cal of owned) {
      if (accessFor(cal, viewer) === null) {
        hidden++;
        continue;
      }
      // visibleEvents() only yields enabled calendars, so an owner who switched
      // one off has genuinely not been checked against it. Say so rather than
      // counting it as free time.
      if (!cal.enabled) {
        muted++;
        continue;
      }
      checked++;
      for (const item of byCalendar.get(cal.id) ?? []) {
        const ev = item.event;
        if (ev.starts_at >= to || ev.ends_at <= from) continue;
        if (ev.status === "cancelled") continue;
        intervals.push({
          start: ev.starts_at,
          end: ev.ends_at,
          calendarId: cal.id,
          calendarName: cal.name,
          color: item.color,
          redacted: item.redacted,
          // redactEvent() has already blanked this, but reading it explicitly
          // through the flag makes the guarantee local to this file.
          title: item.redacted ? "" : ev.title,
          allDay: !!ev.all_day,
          tentative: ev.status === "tentative",
        });
      }
    }

    intervals.sort((a, b) => a.start - b.start || a.end - b.end);
    return {
      subject,
      label: subjectLabel(subject),
      intervals,
      checkedCalendars: checked,
      hiddenCalendars: hidden,
      mutedCalendars: muted,
      certain: hidden === 0 && muted === 0 && checked > 0,
    };
  });
}

/* ── finding the gaps ─────────────────────────────────────────── */

export interface SlotSearch {
  subjects: EntityRef[];
  from: number;
  to: number;
  durationMs: number;
  /** Minutes past local midnight. Defaults to 09:00. */
  workdayStart?: number;
  /** Minutes past local midnight. Defaults to 17:00. */
  workdayEnd?: number;
  weekdaysOnly?: boolean;
  /** Step between candidate starts. Defaults to 30 minutes. */
  granularityMs?: number;
  /** All-day blocks ("Offsite", "Leave") count as busy unless told otherwise. */
  includeAllDay?: boolean;
  /** How many ranked slots to return. Defaults to 200. */
  limit?: number;
  viewer?: EntityRef;
}

/** One attendee who cannot make a slot, and the blocks that say so. */
export interface SlotConflict {
  subject: EntityRef;
  label: string;
  /** Redacted blocks carry times only — enough to say "busy", never what with. */
  intervals: BusyInterval[];
}

export interface Slot {
  start: number;
  end: number;
  /** Subjects free for the whole slot, as far as the viewer can see. */
  free: EntityRef[];
  conflicts: SlotConflict[];
  /** True when nobody has a conflict. */
  everyone: boolean;
  /** Free here, but with calendars the viewer could not check. */
  uncertain: EntityRef[];
}

export interface SlotSearchResult {
  slots: Slot[];
  busy: SubjectBusy[];
  /** The window actually searched, after clamping to whole days. */
  from: number;
  to: number;
  workdayStart: number;
  workdayEnd: number;
  /** True when the search stopped early because the range was enormous. */
  truncated: boolean;
}

/** A fortnight of candidates is plenty; beyond it the list stops being a list. */
const MAX_DAYS = 60;
const MAX_CANDIDATES = 4000;

function hits(iv: BusyInterval, start: number, end: number): boolean {
  return iv.start < end && iv.end > start;
}

/**
 * Ranked slots where everyone is free, followed by the near-misses.
 *
 * Ordering is fewest conflicts first, then earliest — so a time that works for
 * all four on Thursday outranks one that works for two of them this afternoon,
 * and within either group the soonest wins. Near-misses are kept (with the
 * blocking intervals attached) so the UI can offer "works for 3 of 4" instead
 * of the useless "no times found".
 */
export function findSlots(search: SlotSearch): SlotSearchResult {
  const {
    subjects,
    durationMs,
    workdayStart = 9 * 60,
    workdayEnd = 17 * 60,
    weekdaysOnly = true,
    granularityMs = 30 * MINUTE_MS,
    includeAllDay = true,
    limit = 200,
    viewer = localMember(),
  } = search;

  const from = Math.min(search.from, search.to);
  const to = Math.max(search.from, search.to);
  const busy = freeBusy(subjects, from, to, viewer);
  const step = Math.max(5 * MINUTE_MS, granularityMs);
  const duration = Math.max(5 * MINUTE_MS, durationMs);

  const blocking = busy.map((b) => ({
    ...b,
    intervals: b.intervals.filter((iv) => includeAllDay || !iv.allDay),
  }));

  const slots: Slot[] = [];
  let truncated = false;
  let candidates = 0;

  outer: for (let day = startOfDay(from), n = 0; day < to && n < MAX_DAYS; day = addDays(day, 1), n++) {
    if (weekdaysOnly && isWeekend(day)) continue;
    // Wall-clock hours, so the working day stays 9-to-5 across a clock change.
    const openAt = atMinutes(day, workdayStart);
    const closeAt = atMinutes(day, workdayEnd);
    if (closeAt <= openAt) continue;

    for (let start = openAt; start + duration <= closeAt; start += step) {
      if (start < from || start + duration > to) continue;
      if (++candidates > MAX_CANDIDATES) {
        truncated = true;
        break outer;
      }
      const end = start + duration;
      const free: EntityRef[] = [];
      const uncertain: EntityRef[] = [];
      const conflicts: SlotConflict[] = [];

      for (const person of blocking) {
        const clash = person.intervals.filter((iv) => hits(iv, start, end));
        if (clash.length) {
          conflicts.push({ subject: person.subject, label: person.label, intervals: clash });
        } else {
          free.push(person.subject);
          if (!person.certain) uncertain.push(person.subject);
        }
      }

      slots.push({
        start,
        end,
        free,
        conflicts,
        everyone: conflicts.length === 0,
        uncertain,
      });
    }
  }

  slots.sort((a, b) => a.conflicts.length - b.conflicts.length || a.start - b.start);

  return {
    slots: slots.slice(0, limit),
    busy,
    from,
    to,
    workdayStart,
    workdayEnd,
    truncated,
  };
}

/* ── where a meeting actually lands ───────────────────────────── */

export type SyncTarget = "google" | "microsoft" | "apple" | "local";

/** What will happen to an event saved on a given calendar, in advance. */
export interface CalendarBacking {
  calendarId: string;
  target: SyncTarget;
  /** The connected account's label, '' when there is none. */
  account: string;
  /** False when the account exists but is expired or errored. */
  ready: boolean;
  /** One sentence, safe to show before the user commits. */
  note: string;
}

const PROVIDER_LABEL: Record<SyncTarget, string> = {
  google: "Google Calendar",
  microsoft: "Outlook Calendar",
  apple: "Apple Calendar",
  local: "Spaces only",
};

export function providerLabel(target: SyncTarget): string {
  return PROVIDER_LABEL[target];
}

function localBacking(calendarId: string, note: string): CalendarBacking {
  return { calendarId, target: "local", account: "", ready: true, note };
}

/**
 * Resolve every calendar to what saving there really does.
 *
 * Two account tables have to be consulted, because two eras of this app are
 * still in the room: `calendar_accounts` holds the portal-brokered Google and
 * Microsoft connections, while Apple arrives through `integration_accounts` and
 * the local EventKit bridge. A calendar pointing at an account in neither is
 * treated as local — guessing a provider from a name is how an event silently
 * fails to reach anybody.
 */
export async function calendarBackings(): Promise<Map<string, CalendarBacking>> {
  const s = useStore.getState();
  const out = new Map<string, CalendarBacking>();

  let integrations: Awaited<ReturnType<typeof listIntegrationAccounts>> = [];
  try {
    integrations = await listIntegrationAccounts();
  } catch {
    // No integrations table yet is not an error worth stopping a meeting for;
    // every calendar simply reads as local, which is the safe direction.
  }

  for (const cal of s.calendars) {
    if (!cal.account_id) {
      out.set(cal.id, localBacking(cal.id, "Stays in Spaces. Nothing is sent anywhere."));
      continue;
    }

    const account = s.calendarAccounts.find((a) => a.id === cal.account_id);
    if (account && (account.provider === "google" || account.provider === "microsoft")) {
      const ready = account.status === "ok";
      out.set(cal.id, {
        calendarId: cal.id,
        target: account.provider,
        account: account.display_name,
        ready,
        note: ready
          ? `Saved to ${PROVIDER_LABEL[account.provider]}${account.display_name ? ` (${account.display_name})` : ""}. No invitations are emailed.`
          : `That ${PROVIDER_LABEL[account.provider]} connection is ${account.status}. The meeting would stay in Spaces until it is reconnected.`,
      });
      continue;
    }

    const integration = integrations.find((a) => a.id === cal.account_id);
    if (integration && integration.provider === "apple") {
      const ready = integration.status === "connected";
      out.set(cal.id, {
        calendarId: cal.id,
        target: "apple",
        account: integration.label,
        ready,
        note: ready
          ? "Saved to Apple Calendar on this Mac. No invitations are emailed."
          : "Apple Calendar is not connected, so the meeting would stay in Spaces.",
      });
      continue;
    }
    if (integration && (integration.provider === "google" || integration.provider === "microsoft")) {
      const ready = integration.status === "connected";
      out.set(cal.id, {
        calendarId: cal.id,
        target: integration.provider,
        account: integration.handle || integration.label,
        ready,
        note: ready
          ? `Saved to ${PROVIDER_LABEL[integration.provider]}${integration.handle ? ` (${integration.handle})` : ""}. No invitations are emailed.`
          : `That ${PROVIDER_LABEL[integration.provider]} account is ${integration.status}, so the meeting would stay in Spaces.`,
      });
      continue;
    }

    out.set(
      cal.id,
      localBacking(cal.id, "This calendar's account is not connected, so the meeting stays in Spaces.")
    );
  }
  return out;
}

/* ── booking it ───────────────────────────────────────────────── */

export interface MeetingProposal {
  slot: { start: number; end: number };
  subjects: EntityRef[];
  title: string;
  description?: string;
  location?: string;
  calendarId: string;
  viewer?: EntityRef;
}

export interface MeetingResult {
  event: CalendarEvent;
  /** Where it really landed. `local` means Spaces and nowhere else. */
  synced: SyncTarget;
  /** True when an upstream push was attempted and failed; the event still exists. */
  upstreamFailed: boolean;
  upstreamError: string;
  /** Attendees linked into the graph. */
  linked: number;
  /** Agent and team attendees given an assignment. */
  assigned: number;
  /** A sentence for a toast. Never claims an invitation was sent. */
  summary: string;
}

interface AttendeeRecord {
  email: string;
  name: string;
  response: string;
}

/**
 * Create the meeting, wire it into the graph, and push it upstream if the
 * calendar is backed by a provider.
 *
 * The local row is written first and kept whatever happens next: a provider
 * that times out should cost you a sync, not the meeting you just agreed on.
 * The result says plainly which of the two occurred, because "scheduled" and
 * "scheduled and everyone was told" are very different claims and only one of
 * them is ever true here — Spaces has no way to add guests to a provider event, so
 * nobody is emailed either way.
 */
export async function proposeMeeting(proposal: MeetingProposal): Promise<MeetingResult> {
  const store = useStore.getState();
  const viewer = proposal.viewer ?? localMember();
  const calendar = store.calendars.find((c) => c.id === proposal.calendarId);
  if (!calendar) throw new Error("That calendar no longer exists.");

  const start = Math.min(proposal.slot.start, proposal.slot.end);
  const end = Math.max(proposal.slot.start, proposal.slot.end);
  if (end <= start) throw new Error("A meeting has to end after it starts.");

  const title = proposal.title.trim() || "Meeting";
  const description = proposal.description?.trim() ?? "";
  const location = proposal.location?.trim() ?? "";

  const attendees: AttendeeRecord[] = [];
  for (const subject of proposal.subjects) {
    const member = subject.type === "member" ? store.members.find((m) => m.id === subject.id) : undefined;
    attendees.push({
      email: member?.email ?? "",
      name: subjectLabel(subject),
      response: "needsAction",
    });
  }
  const me = store.members.find((m) => m.id === viewer.id);

  const event = await store.addEvent({
    calendar_id: calendar.id,
    title,
    description,
    location,
    starts_at: start,
    ends_at: end,
    organizer: me?.email || me?.name || "",
    attendees: JSON.stringify(attendees),
    source: "hq",
  });

  const ref: EntityRef = { type: "event", id: event.id };
  let linked = 0;
  let assigned = 0;
  for (const subject of proposal.subjects) {
    // Best-effort: a graph edge failing is not a reason to lose the meeting.
    try {
      if (await store.addLink(ref, subject, "references", "attendee")) linked++;
    } catch {
      /* the meeting exists; the edge can be redrawn by hand */
    }
    if (subject.type === "agent" || subject.type === "team") {
      try {
        if (await store.assign(subject, ref, "assignee")) assigned++;
      } catch {
        /* same */
      }
    }
  }

  const backing = (await calendarBackings()).get(calendar.id);
  const target = backing?.target ?? "local";
  let synced: SyncTarget = "local";
  let upstreamFailed = false;
  let upstreamError = "";

  if (target !== "local" && backing?.ready) {
    try {
      const pushed =
        target === "apple"
          ? await createAppleCalendarEvent({
              title,
              startAt: start,
              endAt: end,
              calendarName: calendar.name,
              location,
              notes: description,
            })
          : await createCloudCalendarEvent(target, {
              title,
              startAt: start,
              endAt: end,
              calendarId: calendar.external_id,
              calendarName: calendar.name,
              location,
              notes: description,
            });
      synced = target;
      // Keep the upstream id so a later sync recognises this row as its own.
      // `source` stays "hq" for Apple: CalendarProvider has no Apple member,
      // and inventing one here would be a schema change in the wrong file.
      await store.updateEvent(event.id, {
        external_id: pushed.external_id || pushed.id,
        ...(target === "apple" ? {} : { source: target }),
      });
    } catch (e) {
      upstreamFailed = true;
      upstreamError = e instanceof Error ? e.message : String(e);
    }
  } else if (target !== "local") {
    upstreamFailed = true;
    upstreamError = backing?.note ?? "That account is not connected.";
  }

  const when = formatSlot({ start, end });
  // Three different things happened and only one of them is "it synced", so
  // the sentence distinguishes them rather than rounding up to the good news.
  const summary =
    synced !== "local"
      ? `${when}. Saved to ${PROVIDER_LABEL[synced]} as well as Spaces. No invitations were emailed.`
      : upstreamFailed
        ? `${when}. Saved in Spaces only — it did not reach ${PROVIDER_LABEL[target]}.`
        : `${when}. Saved in Spaces only; nothing was sent anywhere.`;

  return {
    // Re-read: the upstream push patches external_id, and a caller holding the
    // pre-push row would think the meeting never left Spaces.
    event: useStore.getState().events.find((e) => e.id === event.id) ?? event,
    synced,
    upstreamFailed,
    upstreamError,
    linked,
    assigned,
    summary,
  };
}

/* ── small shared helpers for the UI ──────────────────────────── */

/** A calendar the viewer may actually create a meeting on. */
export function bookableCalendars(viewer: EntityRef = localMember()): Calendar[] {
  return useStore
    .getState()
    .calendars.filter((c) => !!c.writable && accessFor(c, viewer) === "write");
}
