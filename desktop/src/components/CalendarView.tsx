/**
 * The calendar.
 *
 * The hard problem here is not drawing a week — it is answering *whose* time
 * you are looking at. Spaces is communal: the workspace has a calendar, so do
 * agents and teams, and they are all overlaid on yours by default. So every
 * pixel that carries meaning carries ownership with it — the rail groups
 * calendars by owner kind, every block wears its calendar's colour on its left
 * edge, and a second layout mode gives each owner its own lane so "when is
 * the workspace busy while I am free" is a glance rather than a puzzle.
 *
 * The other load-bearing idea is redaction. A calendar shared at `busy` comes
 * out of calendars.ts already stripped — title, location, attendees, all gone
 * before this file ever sees it. Blocks flagged `redacted` therefore render as
 * hatched "Busy" with no tooltip, no aria-label beyond the times and no way to
 * open them. That is deliberate: the safety of the default overlay depends on
 * it, and the cheapest way not to leak a field is never to hold one.
 *
 * Everything works with nothing connected. `syncCalendars` reporting
 * `ok: false` is the normal local-only state, not an error, so it lands as a
 * quiet note.
 *
 * The third idea arrived with the providers. Two tables hold calendar data and
 * both are real: `calendar_events` is the provider cache (the snapshot the Rust
 * side takes of this Mac, whatever the paired workspace returns for Google and
 * Microsoft), while `events` is the owned, shareable, redactable model this
 * view draws. The cache flows one way into the model, keyed on the provider's
 * own id, so a re-sync updates a row rather than growing a second one.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ComponentType,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "../store";
import { useTheme } from "../themeStore";
import { toast, confirmAction, errorText } from "../toast";
import { config } from "../config";
import { getDb, now as stamp, uid } from "../db";
import {
  addDays,
  calendarColor,
  canWrite,
  layoutDay,
  localMember,
  overlaps,
  ownerLabel,
  setCalendarBridge,
  startOfDay,
  startOfMonth,
  startOfWeek,
  syncCalendars,
  visibleCalendars,
  visibleEvents,
} from "../calendars";
import type { CalendarBridge, VisibleEvent } from "../calendars";
import { calendarBackings, providerLabel } from "../scheduling";
import type { CalendarBacking, SyncTarget } from "../scheduling";
import {
  createAppleCalendarEvent,
  createCloudCalendarEvent,
  listCalendarEvents,
  listIntegrationAccounts,
  syncAppleCalendar,
  syncCloudCalendar,
} from "../operations";
import type { CalendarEventRecord, IntegrationAccount } from "../operations";
import { assigneesOf, connectionsFor } from "../links";
import type { Calendar, CalendarEvent, CalendarOwnerType, EntityRef } from "../types";
import { EntityChip } from "./EntityChip";
import { Pane } from "./Shell";
import { SidePanel } from "./SidePanel";
import { ScheduleMeeting } from "./ScheduleMeeting";
import "./calendar.css";

/* ── borrowed surfaces ────────────────────────────────────────── */

/**
 * The connections panel and the link picker belong to the graph work, which
 * lands in its own files on its own schedule. A glob resolves to nothing
 * instead of failing the build when those files are absent, so the calendar
 * stays shippable on its own and quietly upgrades the moment they arrive.
 */
type PanelProps = { anchor: EntityRef };
type PickerProps = { anchor: EntityRef; onClose: () => void };

const graphModules = import.meta.glob(["./ConnectionsPanel.tsx", "./LinkPicker.tsx"], {
  eager: true,
}) as Record<string, Record<string, unknown>>;

function pickExport<P>(name: string): ComponentType<P> | null {
  for (const mod of Object.values(graphModules)) {
    const found = mod?.[name];
    if (typeof found === "function") return found as ComponentType<P>;
  }
  return null;
}

const ConnectionsPanelImpl = pickExport<PanelProps>("ConnectionsPanel");
const LinkPickerImpl = pickExport<PickerProps>("LinkPicker");

/* ── providers: the bridge, the cache, the accounts ───────────── */

/**
 * `setCalendarBridge` is the one seam calendars.ts offers for reaching an
 * account Spaces does not hold the tokens for, and `hasCalendarBridge()` is read
 * elsewhere as "something upstream can actually be reached". So the bridge is
 * installed only while at least one calendar account is connected, and removed
 * again when the last one goes — a bridge that is always present would turn
 * that question into a lie, and the honest local-only state is the one most
 * people are in.
 *
 * Which provider is behind which calendar is never guessed from a name:
 * scheduling.ts already answers that through `calendarBackings()`, and one
 * answer to "where does saving here really go" is worth more than a second
 * implementation that agrees most of the time.
 *
 * The provider calls themselves go straight to operations.ts rather than
 * through the account-shaped helpers next door in OperationsViews, for two
 * reasons this view cannot do without: an event created here has to name the
 * *upstream* calendar it belongs in — a Mac with Home and Work is two
 * calendars, not one — and connection state has to be read from both account
 * tables, because Apple only ever appears in one of them.
 */

/** The providers Spaces can fetch from. `local` is the absence of one. */
type Upstream = Exclude<SyncTarget, "local">;
type Cloud = Extract<Upstream, "google" | "microsoft">;

const UPSTREAMS: Upstream[] = ["apple", "google", "microsoft"];

/** How `calendar_events.provider` maps onto a target. Anything else is local. */
const CACHE_PROVIDER: Record<string, Upstream> = {
  apple: "apple",
  google: "google",
  microsoft: "microsoft",
};

/** Account status in words. A raw enum on screen is a leaked implementation. */
const ACCOUNT_STATE: Record<string, string> = {
  connected: "Connected",
  ok: "Connected",
  pending: "Finishing sign-in",
  expired: "Sign-in expired",
  error: "Needs attention",
  disconnected: "Not connected",
};

export interface ProviderState {
  target: Upstream;
  label: string;
  state: string;
  connected: boolean;
  /** The account being talked to, when there is one worth naming. */
  detail: string;
  /** True for the provider that needs nothing paired: this machine's own. */
  onThisMachine: boolean;
}

/**
 * What each provider's connection looks like right now.
 *
 * Two account tables again, for the same historical reason scheduling.ts
 * documents: the portal writes `integration_accounts`, the newer calendar work
 * writes `calendar_accounts`, and Apple only ever appears in the first because
 * it is connected by reading this Mac rather than by signing in anywhere.
 */
async function readProviders(): Promise<ProviderState[]> {
  let integrations: IntegrationAccount[] = [];
  try {
    integrations = await listIntegrationAccounts();
  } catch {
    // No integrations table yet reads as "nothing connected", which is the safe
    // direction: the view stays local rather than promising a sync.
  }
  const accounts = useStore.getState().calendarAccounts;
  return UPSTREAMS.map((target) => {
    const integration = integrations.find((a) => a.category === "calendar" && a.provider === target);
    const account = target === "apple" ? undefined : accounts.find((a) => a.provider === target);
    const raw = integration?.status ?? account?.status ?? "disconnected";
    return {
      target,
      label: providerLabel(target),
      state: ACCOUNT_STATE[raw] ?? raw,
      connected: integration?.status === "connected" || account?.status === "ok",
      detail: integration?.handle || integration?.label || account?.display_name || "",
      onThisMachine: target === "apple",
    };
  });
}

/** The account row a mirrored calendar points at, so backings can resolve it. */
async function accountIds(): Promise<Map<Upstream, string>> {
  const out = new Map<Upstream, string>();
  let integrations: IntegrationAccount[] = [];
  try {
    integrations = await listIntegrationAccounts();
  } catch {
    /* handled below: a provider with no account row mirrors as a local calendar */
  }
  for (const target of UPSTREAMS) {
    const integration = integrations.find((a) => a.category === "calendar" && a.provider === target);
    if (integration) {
      out.set(target, integration.id);
      continue;
    }
    const account = useStore.getState().calendarAccounts.find((a) => a.provider === target);
    if (account) out.set(target, account.id);
  }
  return out;
}

/* Backings change only when an account or a calendar does, and they are asked
 * for once per calendar per sync — so a short cache turns a fan-out into one
 * read without ever holding a stale answer long enough to see. */
let backingsAt = 0;
let backingsMap: Promise<Map<string, CalendarBacking>> | null = null;

function allBackings(force = false): Promise<Map<string, CalendarBacking>> {
  if (force || !backingsMap || Date.now() - backingsAt > 5_000) {
    backingsAt = Date.now();
    backingsMap = calendarBackings().catch((e) => {
      backingsMap = null;
      throw e;
    });
  }
  return backingsMap;
}

async function backingFor(calendarId: string): Promise<CalendarBacking | null> {
  return (await allBackings()).get(calendarId) ?? null;
}

/**
 * One round trip per provider, shared.
 *
 * `syncCalendars` asks the bridge once per calendar, so an account with six
 * calendars behind it would otherwise be six identical fetches — and paging to
 * next week would be six more. The promise itself is cached so concurrent
 * askers wait on the same request; a rejection is evicted so the next attempt
 * genuinely retries.
 */
const PROVIDER_TTL = 45_000;
const pulls = new Map<Upstream, { at: number; rows: Promise<CalendarEventRecord[]> }>();

function pullProvider(target: Upstream, force = false): Promise<CalendarEventRecord[]> {
  const hit = pulls.get(target);
  if (!force && hit && Date.now() - hit.at < PROVIDER_TTL) return hit.rows;
  const rows = (target === "apple" ? syncAppleCalendar() : syncCloudCalendar(target as Cloud))
    .then((all) => all.filter((row) => row.provider === target))
    .catch((e) => {
      pulls.delete(target);
      throw e;
    });
  pulls.set(target, { at: Date.now(), rows });
  return rows;
}

/**
 * A content hash of a cached row.
 *
 * Not the provider's `updated_at`: the Apple snapshot deletes and re-inserts
 * every row on every sync, so a timestamp etag would make each sync rewrite the
 * entire year. Hashing what is actually shown means an unchanged calendar costs
 * no writes at all.
 */
function fingerprint(row: CalendarEventRecord): string {
  let h = 2166136261;
  for (const part of [row.title, row.location, row.notes, row.status]) {
    const text = part ?? "";
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return `${row.start_at}-${row.end_at}-${row.all_day}-${(h >>> 0).toString(36)}`;
}

/**
 * A cached row in the shape the `events` table wants.
 *
 * Only real columns go in here: `syncCalendars` hands this object straight to
 * `updateEvent`, which turns every key it finds into a SET clause.
 */
function eventFields(row: CalendarEventRecord): Partial<CalendarEvent> {
  const target = CACHE_PROVIDER[row.provider];
  return {
    // An Spaces-native cache row has no upstream identity to preserve, and giving
    // it one would make a later sync think a provider owned it.
    external_id: target ? row.external_id || row.id : "",
    title: row.title || "(untitled)",
    description: row.notes ?? "",
    location: row.location ?? "",
    starts_at: row.start_at,
    ends_at: Math.max(row.end_at, row.start_at),
    all_day: row.all_day ? 1 : 0,
    status: row.status === "tentative" || row.status === "cancelled" ? row.status : "confirmed",
    // CalendarProvider has no `apple` member. Inventing one is a change to
    // types.ts and db.ts, which this view does not own — scheduling.ts made the
    // same call when it pushes a meeting to EventKit.
    source: target === "google" || target === "microsoft" ? target : "hq",
    etag: fingerprint(row),
  };
}

/** Events for one mirrored calendar, in the window `syncCalendars` asked for. */
async function listUpstream(params: Record<string, unknown>): Promise<Partial<CalendarEvent>[]> {
  const from = Number(params.from ?? 0);
  const to = Number(params.to ?? 0);
  const key = String(params.calendarId ?? "");
  const accountId = String(params.accountId ?? "");

  // syncCalendars identifies a calendar by `external_id || id`, so resolve it
  // back the same way rather than assuming which one it sent.
  const cal = useStore
    .getState()
    .calendars.find((c) => c.account_id === accountId && (c.external_id || c.id) === key);
  if (!cal) return [];

  const backing = await backingFor(cal.id);
  if (!backing || backing.target === "local") return [];
  // An expired sign-in is not an error to throw at the week: the accounts
  // section says so in words, and the last good sync stays on screen.
  if (!backing.ready) return [];

  const rows = await pullProvider(backing.target);
  // A calendar that names an upstream one mirrors exactly that; a calendar that
  // names none mirrors the whole account, which is what a single connected
  // calendar wants.
  const mine = cal.external_id ? rows.filter((r) => r.calendar_name === cal.external_id) : rows;

  const seen = new Set<string>();
  const out: Partial<CalendarEvent>[] = [];
  for (const row of mine) {
    if (row.start_at >= to || row.end_at <= from) continue;
    const fields = eventFields(row);
    const id = String(fields.external_id ?? "");
    // The unique index on (calendar_id, external_id) is the referee; handing
    // the same id over twice in one pass would make it the one to complain.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(fields);
  }
  return out;
}

/** Create upstream and hand back the columns that record where it landed. */
async function createUpstream(params: Record<string, unknown>): Promise<Partial<CalendarEvent>> {
  const cal = useStore.getState().calendars.find((c) => c.id === String(params.calendarId ?? ""));
  if (!cal) throw new Error("That calendar no longer exists.");
  const backing = await backingFor(cal.id);
  if (!backing || backing.target === "local") {
    throw new Error("That calendar is not backed by a connected account.");
  }
  const target = backing.target;
  const title = String(params.title ?? "");
  const startAt = Number(params.starts_at ?? 0);
  const endAt = Number(params.ends_at ?? 0);
  const location = String(params.location ?? "");
  const notes = String(params.description ?? "");

  const record =
    target === "apple"
      ? await createAppleCalendarEvent({
          title,
          startAt,
          endAt,
          calendarName: cal.external_id || cal.name,
          location,
          notes,
        })
      : await createCloudCalendarEvent(target as Cloud, {
          title,
          startAt,
          endAt,
          calendarId: cal.external_id,
          calendarName: cal.name,
          allDay: !!params.all_day,
          location,
          notes,
        });

  // The cache now holds a row this view already knows about; a pull served from
  // the old snapshot would offer it back as news.
  pulls.delete(target);
  const fields = eventFields(record);
  return { external_id: fields.external_id, source: fields.source, etag: fields.etag };
}

const bridge: CalendarBridge = async (action, params) => {
  if (action === "calendar.list") return listUpstream(params);
  if (action === "calendar.create") return createUpstream(params);
  // Editing and deleting upstream need a round trip Spaces cannot make yet. Saying
  // so beats succeeding locally and drifting away from the provider in silence.
  throw new Error("Changing an event on a connected account is not supported yet.");
};

/** True once we installed ours, so we never take somebody else's away. */
let installed = false;

/**
 * Install the bridge, or remove it again, to match what is connected.
 *
 * Exported so a launch path can call it before the calendar is ever opened —
 * the settings panel's "Sync" reads `hasCalendarBridge()` and would otherwise
 * find nothing until this view had been visited once.
 */
export async function installCalendarBridge(): Promise<boolean> {
  let live = false;
  try {
    live = (await readProviders()).some((p) => p.connected);
  } catch {
    live = false;
  }
  if (live) {
    setCalendarBridge(bridge);
    installed = true;
  } else if (installed) {
    setCalendarBridge(null);
    installed = false;
  }
  return live;
}

/**
 * Push a newly created event to whatever is behind its calendar.
 *
 * Only ever called for a calendar `canWrite` accepted, which means access
 * `write`, which means the row was never redacted: a busy-only block has no
 * title to leak here because it has no path to here at all.
 */
async function pushEventUpstream(
  ev: CalendarEvent,
  cal: Calendar
): Promise<{ target: SyncTarget; error: string }> {
  const backing = await backingFor(cal.id);
  const target = backing?.target ?? "local";
  if (!installed || target === "local") return { target: "local", error: "" };
  if (!backing?.ready) {
    return { target, error: `That ${providerLabel(target)} account is not connected.` };
  }
  try {
    const patch = (await bridge("calendar.create", {
      calendarId: cal.id,
      title: ev.title,
      starts_at: ev.starts_at,
      ends_at: ev.ends_at,
      all_day: ev.all_day,
      location: ev.location,
      description: ev.description,
    })) as Partial<CalendarEvent>;
    await useStore.getState().updateEvent(ev.id, patch);
    return { target, error: "" };
  } catch (e) {
    // The event exists either way; only the sync failed.
    return { target, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ── adopting the cache ───────────────────────────────────────── */

/** Enough for a provider's whole snapshot; a guard against a pathological one. */
const MAX_IMPORT = 4000;

/**
 * The owned calendar a cached row belongs on, created if this is its first.
 *
 * Keyed on (account, upstream calendar name) so a Mac with Home, Work and
 * Birthdays arrives as three calendars in the rail rather than one soup — each
 * with its own colour, its own switch and its own sharing decision.
 */
async function calendarForRow(
  row: CalendarEventRecord,
  accounts: Map<Upstream, string>,
  memo: Map<string, Calendar | null>
): Promise<Calendar | null> {
  const upstream = CACHE_PROVIDER[row.provider];
  const accountId = upstream ? accounts.get(upstream) ?? "" : "";
  const external = row.calendar_name || "";
  // A pair, not a join: an account id and a calendar name are both free text.
  const key = JSON.stringify([accountId, external]);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  const me = localMember();
  // getState() per call on purpose: addCalendar below mutates this list, and a
  // snapshot taken once would create the same calendar for every row.
  const found = useStore
    .getState()
    .calendars.find(
      (c) =>
        c.owner_type === me.type &&
        c.owner_id === me.id &&
        c.account_id === accountId &&
        (c.external_id || "") === external
    );
  if (found) {
    memo.set(key, found);
    return found;
  }

  try {
    const made = await useStore.getState().addCalendar({
      name: external || (upstream ? providerLabel(upstream) : config().brand),
      account_id: accountId,
      external_id: external,
      owner_type: "member",
      owner_id: me.id,
      // Somebody's own week is nobody else's business until they say so, and an
      // import is a bad moment to decide otherwise on their behalf.
      visibility: "private",
      writable: 1,
      enabled: 1,
    });
    memo.set(key, made);
    return made;
  } catch {
    memo.set(key, null);
    return null;
  }
}

/**
 * Map `calendar_events` rows onto owned calendars in `events`.
 *
 * Safe to re-run, which is what lets it happen on every launch and after every
 * manual sync. A provider row is matched on (calendar, external_id) — the pair
 * the schema already makes unique — and an Spaces-native row, which has no upstream
 * id, on its calendar, times and title. A second pass therefore updates or
 * skips; it never grows the table. The insert is still wrapped, because that
 * unique index is the real referee and losing a race with the sync path should
 * cost one row rather than the whole import.
 *
 * Rows are written straight to SQLite rather than through `addEvent`: a year of
 * somebody's Apple calendar is thousands of rows, and thousands of store
 * updates would re-sort and re-render the whole grid for each one.
 */
async function importCachedRows(rows: CalendarEventRecord[]): Promise<number> {
  if (!rows.length) return 0;
  const db = await getDb();
  const accounts = await accountIds();
  const memo = new Map<string, Calendar | null>();
  const today = Date.now();

  // Nearest to today first, so if the cap ever bites it keeps the part of the
  // calendar somebody is actually looking at.
  const ordered = [...rows]
    .sort((a, b) => Math.abs(a.start_at - today) - Math.abs(b.start_at - today))
    .slice(0, MAX_IMPORT);

  const buckets = new Map<string, { cal: Calendar; rows: CalendarEventRecord[] }>();
  for (const row of ordered) {
    const cal = await calendarForRow(row, accounts, memo);
    if (!cal) continue;
    const bucket = buckets.get(cal.id);
    if (bucket) bucket.rows.push(row);
    else buckets.set(cal.id, { cal, rows: [row] });
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let written = 0;

  for (const { cal, rows: mine } of buckets.values()) {
    type Row = Pick<CalendarEvent, "id" | "external_id" | "title" | "starts_at" | "ends_at" | "etag">;
    const existing = await db.select<Row[]>(
      "SELECT id, external_id, title, starts_at, ends_at, etag FROM events WHERE calendar_id = $1",
      [cal.id]
    );
    const byExternal = new Map(existing.filter((e) => e.external_id).map((e) => [e.external_id, e]));
    const byShape = new Map(existing.map((e) => [`${e.starts_at}:${e.ends_at}:${e.title}`, e]));
    const seen = new Set<string>();

    for (const row of mine) {
      const fields = eventFields(row);
      const external = String(fields.external_id ?? "");
      const shape = `${fields.starts_at}:${fields.ends_at}:${fields.title}`;
      const key = external || shape;
      if (seen.has(key)) continue;
      seen.add(key);

      const hit = external ? byExternal.get(external) : byShape.get(shape);
      if (hit) {
        // Unchanged upstream, so nothing to write — which is the whole point of
        // hashing the content rather than trusting a timestamp.
        if (hit.etag === fields.etag) continue;
        try {
          await db.execute(
            `UPDATE events
                SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5,
                    all_day=$6, status=$7, source=$8, updated_at=$9, etag=$10
              WHERE id=$11`,
            [
              fields.title,
              fields.description,
              fields.location,
              fields.starts_at,
              fields.ends_at,
              fields.all_day,
              fields.status,
              fields.source,
              stamp(),
              fields.etag,
              hit.id,
            ]
          );
          written++;
        } catch {
          /* one row left stale is not a reason to abandon the rest */
        }
        continue;
      }
      try {
        await db.execute(
          `INSERT INTO events
           (id, calendar_id, external_id, title, description, location, starts_at, ends_at,
            all_day, tz, organizer, attendees, status, source, updated_at, etag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'','[]',$11,$12,$13,$14)`,
          [
            uid(),
            cal.id,
            external,
            fields.title,
            fields.description,
            fields.location,
            fields.starts_at,
            fields.ends_at,
            fields.all_day,
            tz,
            fields.status,
            fields.source,
            stamp(),
            fields.etag,
          ]
        );
        written++;
      } catch {
        /* the unique index caught a row the sync path wrote a moment ago */
      }
    }
  }
  return written;
}

const ADOPTED_KEY = "spaces.calendar.adopted.v1";
let adopting: Promise<number> | null = null;

/**
 * Bring the previous calendar's rows across, once per machine.
 *
 * Somebody who already synced Apple or Google in the old view should not open
 * this one and find an empty week. Re-running is harmless — `importCachedRows`
 * matches before it writes — so the stored stamp is only an optimisation, and
 * the one thing it really buys is that an event you *deleted* here is not
 * resurrected from the cache the next time the app starts. The module-level
 * promise makes a double mount (StrictMode, a fast re-render) one pass, not two.
 */
function adoptCachedEvents(): Promise<number> {
  if (adopting) return adopting;
  adopting = (async () => {
    let done = "";
    try {
      done = window.localStorage.getItem(ADOPTED_KEY) ?? "";
    } catch {
      /* private mode: fall through and rely on matching, which is the real guard */
    }
    if (done) return 0;
    const written = await importCachedRows(await listCalendarEvents());
    try {
      window.localStorage.setItem(ADOPTED_KEY, String(Date.now()));
    } catch {
      /* nothing to do; the next launch matches instead of duplicating */
    }
    return written;
  })().catch((e) => {
    // A failed adoption must be retryable, not permanently remembered.
    adopting = null;
    throw e;
  });
  return adopting;
}

/** Where saving really goes, named without ever hardcoding the product. */
function destinationLabel(target: SyncTarget): string {
  return target === "local" ? config().brand : providerLabel(target);
}

function destinationNote(backing: CalendarBacking | null): string {
  const brand = config().brand;
  if (!backing || backing.target === "local") {
    return `Stays in ${brand}. Nothing is sent anywhere.`;
  }
  const where = providerLabel(backing.target);
  const who = backing.account ? ` (${backing.account})` : "";
  return backing.ready
    ? `Saved to ${where}${who} as well as ${brand}. Nobody is emailed an invitation.`
    : `That ${where} connection is not ready, so this stays in ${brand} until it is.`;
}

/* ── shape of the view ────────────────────────────────────────── */

type Mode = "week" | "day" | "month" | "agenda";
type Layout = "overlay" | "split";

const MODES: { mode: Mode; label: string; key: string }[] = [
  { mode: "week", label: "Week", key: "w" },
  { mode: "day", label: "Day", key: "d" },
  { mode: "month", label: "Month", key: "m" },
  { mode: "agenda", label: "Agenda", key: "a" },
];

/** Fifteen minutes: fine enough to place a stand-up, coarse enough to hit. */
const SNAP_MS = 15 * 60_000;
/** Held ⌥, for the stand-up that really does start at 9:05. */
const SNAP_FINE = 5 * 60_000;
/** Held ⌘ or ctrl: as free as a grid made of minutes gets. */
const SNAP_FREE = 60_000;
/** How long a dropped block takes to settle onto the increment it is written at. */
const SETTLE_MS = 150;
const HOUR_MS = 3_600_000;
/** A click on empty space means "about half an hour, starting here". */
const CLICK_LEN = 30 * 60_000;
const AGENDA_DAYS = 30;
/** Month cells show this many events before collapsing into "+N more". */
const MONTH_MAX = 3;

/* ── formatting ───────────────────────────────────────────────── */

const fTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fHour = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const fWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const fWeekdayLong = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const fDayNum = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const fDayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fMonthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const fFullDay = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const fmtTime = (t: number) => fTime.format(new Date(t));

/** "09:00 – 10:30", or just the start when the block is too short to hold both. */
function fmtSpan(ev: CalendarEvent): string {
  if (ev.all_day) return "All day";
  return `${fmtTime(ev.starts_at)} – ${fmtTime(ev.ends_at)}`;
}

/** "Tuesday 09:15 to 10:15" — a move, said out loud for a screen reader. */
function describeSpan(start: number, end: number): string {
  return `${fWeekdayLong.format(new Date(start))} ${fmtTime(start)} to ${fmtTime(end)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local YYYY-MM-DD, which is what <input type="date"> speaks. */
function dateValue(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeValue(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Rebuild an instant from the two inputs, in the user's own timezone. */
function fromParts(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (time || "00:00").split(":").map(Number);
  if (!y || !m || !d) return Date.now();
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

/** "1h 30m", "45m" — how long a block is, said the way people say it. */
function fmtLen(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

const snapTo = (t: number, step: number) => Math.round(t / step) * step;

/**
 * Snapping that attracts instead of teleporting.
 *
 * Plain rounding makes a block jump a whole increment as the pointer crosses
 * the halfway mark, which reads as the calendar wrestling your hand. Easing the
 * distance-from-the-increment by its own square means the block tracks the
 * pointer through open ground and visibly clings as it nears a boundary — and
 * `snapTo` is still what gets written, so the settle at the end of the drag is
 * the block agreeing with the grid rather than a surprise.
 */
function magnet(t: number, step: number): number {
  const s = snapTo(t, step);
  const d = t - s;
  const u = Math.abs(d) / (step / 2);
  return s + d * u * u;
}

function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/**
 * Whether a keystroke belongs to whatever has focus rather than to the view.
 * Deliberately narrower than "is a form control": a ticked calendar in the rail
 * keeps focus, and `w` should still switch to the week from there.
 */
function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName !== "INPUT") return false;
  const type = (t as HTMLInputElement).type;
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
}

/** True when the block belongs in the all-day strip rather than the grid. */
function isBanner(ev: CalendarEvent): boolean {
  if (ev.all_day) return true;
  // A multi-day meeting has no honest position in a single day column.
  return startOfDay(ev.ends_at - 1) > startOfDay(ev.starts_at);
}

/* ── the visible range ────────────────────────────────────────── */

interface Range {
  start: number;
  end: number;
  days: number[];
}

function daySeq(start: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(addDays(start, i));
  return out;
}

function rangeFor(mode: Mode, anchor: number): Range {
  if (mode === "day") {
    const s = startOfDay(anchor);
    return { start: s, end: addDays(s, 1), days: [s] };
  }
  if (mode === "week") {
    const s = startOfWeek(anchor);
    return { start: s, end: addDays(s, 7), days: daySeq(s, 7) };
  }
  if (mode === "month") {
    // Six whole weeks: every month fits, and the grid never changes height
    // mid-year, which would make the whole page jump on navigation.
    const s = startOfWeek(startOfMonth(anchor));
    return { start: s, end: addDays(s, 42), days: daySeq(s, 42) };
  }
  const s = startOfDay(anchor);
  return { start: s, end: addDays(s, AGENDA_DAYS), days: daySeq(s, AGENDA_DAYS) };
}

function shiftAnchor(mode: Mode, t: number, dir: number): number {
  if (mode === "day") return addDays(t, dir);
  if (mode === "week") return addDays(t, 7 * dir);
  if (mode === "agenda") return addDays(t, AGENDA_DAYS * dir);
  const d = new Date(t);
  d.setDate(1);
  d.setMonth(d.getMonth() + dir);
  return d.getTime();
}

function rangeTitle(mode: Mode, range: Range, anchor: number): string {
  if (mode === "day") return fFullDay.format(new Date(anchor));
  if (mode === "month") return fMonthYear.format(new Date(startOfMonth(anchor)));
  const last = addDays(range.end, -1);
  return `${fDayMonth.format(new Date(range.start))} – ${fDayMonth.format(new Date(last))}`;
}

/* ── whose calendar is whose ──────────────────────────────────── */

interface OwnerGroup {
  key: string;
  label: string;
  kind: CalendarOwnerType;
  color: string;
  ids: Set<string>;
}

/**
 * One lane per owner, in the order `visibleCalendars` already sorts by (you,
 * then the workspace, then teams, then agents) so the lane you care about most
 * is always leftmost.
 */
function ownerGroupsOf(cals: Calendar[]): OwnerGroup[] {
  const map = new Map<string, OwnerGroup>();
  for (const c of cals) {
    if (!c.enabled) continue;
    const key = `${c.owner_type}:${c.owner_id}`;
    let g = map.get(key);
    if (!g) {
      g = { key, label: ownerLabel(c), kind: c.owner_type, color: calendarColor(c), ids: new Set() };
      map.set(key, g);
    }
    g.ids.add(c.id);
  }
  return [...map.values()];
}

const RAIL_SECTIONS: { key: string; title: string; blurb: string }[] = [
  { key: "you", title: "You", blurb: "Calendars you own outright." },
  { key: "workspace", title: "Workspace", blurb: "The workspace's own time — the assistant's calendar." },
  { key: "people", title: "People", blurb: "Shared with you by someone else." },
  { key: "teams", title: "Teams", blurb: "A team's calendar; every member of the team can see it." },
  { key: "agents", title: "Agents", blurb: "An agent's calendar — what it has been booked to do." },
];

function sectionOf(c: Calendar): string {
  if (c.owner_type === "workspace") return "workspace";
  if (c.owner_type === "team") return "teams";
  if (c.owner_type === "agent") return "agents";
  return c.owner_id === localMember().id ? "you" : "people";
}

const ACCESS_NOTE: Record<string, string> = {
  busy: "Shared as busy — you see when this calendar is booked, never what for. Those blocks render hatched and cannot be opened.",
  read: "Shared read-only — you see the details but cannot change anything.",
  write: "You can add to and edit this calendar.",
};

/* ── glyphs ───────────────────────────────────────────────────── */

/** A padlock, drawn rather than typed so it inherits colour and never emojifies. */
function LockGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg
      className="cal-lock"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2.2" y="5.2" width="7.6" height="5.6" rx="1.2" />
      <path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" />
    </svg>
  );
}

/* ── the view ─────────────────────────────────────────────────── */

type Editing =
  | { kind: "new"; starts_at: number; ends_at: number; all_day: number; calendar_id: string }
  | { kind: "open"; id: string };

export function CalendarView() {
  // These slices are what `visibleCalendars`/`visibleEvents` project, and both
  // read the store imperatively — so they have to be named here or the grid
  // stops moving when the data does.
  const calendars = useStore((s) => s.calendars);
  const events = useStore((s) => s.events);
  const shares = useStore((s) => s.calendarShares);
  const teamMembers = useStore((s) => s.teamMembers);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const calendarAccounts = useStore((s) => s.calendarAccounts);
  const theme = useTheme((s) => s.theme);
  const loadEvents = useStore((s) => s.loadEvents);
  const addCalendar = useStore((s) => s.addCalendar);
  const setView = useStore((s) => s.setView);

  const [mode, setMode] = useState<Mode>("week");
  const [layout, setLayout] = useState<Layout>("overlay");
  const [anchor, setAnchor] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [scheduling, setScheduling] = useState(false);

  /* Providers: which accounts are connected, what each calendar is backed by,
   * and which of them the grid is currently narrowed to. `accountNonce` is
   * bumped by anything that could have changed a connection. */
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [backings, setBackings] = useState<Map<string, CalendarBacking>>(new Map());
  const [accountNonce, setAccountNonce] = useState(0);
  const [syncingProvider, setSyncingProvider] = useState("");
  const [providerFilter, setProviderFilter] = useState("");

  // Read inside the key handler so it never needs re-binding on a mode change.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const range = useMemo(() => rangeFor(mode, anchor), [mode, anchor]);

  const allCals = useMemo(
    () => visibleCalendars(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these slices are what visibleCalendars reads
    [calendars, shares, teamMembers, agents, teams, theme]
  );
  const allItems = useMemo(
    () => visibleEvents(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ditto for visibleEvents
    [calendars, events, shares, teamMembers, theme]
  );

  /* The provider filter narrows *calendars*, and the events follow from that —
   * an event's provider is a fact about where its calendar lives, never a
   * column of its own. */
  const targetOf = useCallback(
    (c: Calendar): SyncTarget => backings.get(c.id)?.target ?? "local",
    [backings]
  );
  const targets = useMemo(() => {
    const seen = new Set<SyncTarget>();
    for (const c of allCals) seen.add(targetOf(c));
    const order: SyncTarget[] = ["local", "apple", "google", "microsoft"];
    return order.filter((t) => seen.has(t));
  }, [allCals, targetOf]);

  /* Disconnecting an account can take a whole source away underneath a filter.
   * Falling back to "all" beats leaving the grid empty against an option that
   * no longer exists. */
  const filter = targets.includes(providerFilter as SyncTarget) ? providerFilter : "";

  const cals = useMemo(
    () => (filter ? allCals.filter((c) => targetOf(c) === filter) : allCals),
    [allCals, filter, targetOf]
  );
  const items = useMemo(() => {
    if (!filter) return allItems;
    const shown = new Set(cals.map((c) => c.id));
    return allItems.filter((i) => shown.has(i.calendar.id));
  }, [allItems, cals, filter]);

  /* A filter is a way of looking, not a way of working: if it leaves nothing
   * writable, new events still land somewhere rather than the button going
   * dead. */
  const writable = useMemo(() => {
    const inView = cals.filter((c) => canWrite(c));
    return inView.length ? inView : allCals.filter((c) => canWrite(c));
  }, [cals, allCals]);
  const groups = useMemo(() => ownerGroupsOf(cals), [cals]);

  /* The now-line. One timer for the whole view, re-aimed at the next minute
   * boundary each tick so it never drifts a visible amount behind the clock. */
  useEffect(() => {
    let handle = window.setTimeout(function tick() {
      setNow(Date.now());
      handle = window.setTimeout(tick, 60_000 - (Date.now() % 60_000));
    }, 60_000 - (Date.now() % 60_000));
    return () => window.clearTimeout(handle);
  }, []);

  /* Which accounts exist, and what each calendar is really backed by. Both are
   * read again whenever a connection could have moved. */
  useEffect(() => {
    let alive = true;
    void readProviders().then((p) => alive && setProviders(p));
    void allBackings(true)
      .then((m) => alive && setBackings(m))
      .catch(() => {
        /* every calendar simply reads as local, which is the safe direction */
      });
    return () => {
      alive = false;
    };
  }, [calendars, calendarAccounts, accountNonce]);

  /* Load the window, then refresh it from whatever is connected. A missing
   * bridge is the ordinary local-only state, so its reason becomes a note,
   * never a toast. */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // The previous calendar's rows first: somebody who already synced should
        // see their week before any network call resolves, not after.
        const adopted = await adoptCachedEvents();
        if (alive && adopted) {
          toast.info(
            `Brought ${adopted} event${adopted === 1 ? "" : "s"} across`,
            "Calendars you had already synced now sit beside the ones owned here."
          );
        }
      } catch (e) {
        // Nothing was lost — the cache still holds every row, and the next
        // launch tries again — so this is a warning, not a failure to load.
        if (alive) toast.warn("Could not bring the previous calendar across", errorText(e));
      }
      try {
        await loadEvents(range.start, range.end);
      } catch (e) {
        if (alive) toast.error("Could not load events", e);
        return;
      }
      const live = await installCalendarBridge();
      try {
        const res = await syncCalendars(range.start, range.end);
        if (!alive) return;
        // Three quiet states, each with a different thing to do about it: no
        // account at all, an account nothing here mirrors yet, and a sync that
        // simply worked.
        if (!res.ok) {
          setNote(live ? res.reason : "No calendar account connected yet — showing local calendars only.");
        } else if (res.reason) {
          setNote("A connected account is not mirrored here yet — sync it from the rail to bring it in.");
        } else {
          setNote("");
        }
      } catch (e) {
        if (alive) toast.error("Calendar sync failed", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [range.start, range.end, loadEvents]);

  /**
   * Pull one provider on demand.
   *
   * This is also the "connect Apple" affordance: EventKit needs no sign-in, so
   * taking the first snapshot *is* connecting, and `syncAppleCalendar` records
   * the account as it goes.
   */
  const syncProvider = useCallback(
    async (target: Upstream) => {
      setSyncingProvider(target);
      try {
        const rows = await pullProvider(target, true);
        const written = await importCachedRows(rows);
        await loadEvents(range.start, range.end);
        await installCalendarBridge();
        setAccountNonce((n) => n + 1);
        setNote("");
        toast.success(
          `${providerLabel(target)} synced`,
          written
            ? `${written} event${written === 1 ? "" : "s"} added or updated.`
            : "Nothing had changed."
        );
      } catch (e) {
        toast.error(`Could not sync ${providerLabel(target)}`, e);
      } finally {
        setSyncingProvider("");
      }
    },
    [loadEvents, range.start, range.end]
  );

  const openNew = useCallback(
    (starts_at: number, ends_at: number, all_day = 0) => {
      const target = writable[0];
      if (!target) {
        toast.info("No calendar you can write to", "Every calendar you can see is read-only or busy-only.");
        return;
      }
      setEditing({ kind: "new", starts_at, ends_at, all_day, calendar_id: target.id });
    },
    [writable]
  );

  /** The next half hour on the day you are looking at, which is nearly always right. */
  const quickNew = useCallback(() => {
    const day = startOfDay(anchor);
    const base = sameDay(anchor, Date.now())
      ? Math.ceil(Date.now() / (30 * 60_000)) * (30 * 60_000)
      : day + 9 * HOUR_MS;
    openNew(base, base + HOUR_MS);
  }, [anchor, openNew]);

  /* Keyboard: t/w/d/m/a/n/s, arrows and j/k. Deliberately global to the view rather
   * than bound to a focused element — you should be able to page the week
   * without first clicking on it.
   *
   * The editor is a panel now, so an open editor no longer switches the whole
   * view off: paging to next week while a meeting is open is exactly the thing
   * a modal made impossible, and it is why the editor stopped being one. Two
   * narrower guards replace the old blanket one — a keystroke aimed at the
   * panel belongs to the panel, and `n` and `s` would replace the editor with a
   * different surface, taking an unsaved new event with it. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (scheduling) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if ((e.target as HTMLElement | null)?.closest?.(".cal-event-panel")) return;

      const hit = MODES.find((m) => m.key === e.key.toLowerCase());
      if (hit) {
        setMode(hit.mode);
      } else if (e.key === "t" || e.key === "T") {
        setAnchor(Date.now());
      } else if (e.key === "ArrowLeft" || e.key === "k") {
        setAnchor((a) => shiftAnchor(modeRef.current, a, -1));
      } else if (e.key === "ArrowRight" || e.key === "j") {
        setAnchor((a) => shiftAnchor(modeRef.current, a, 1));
      } else if (e.key === "n") {
        if (editing) return;
        quickNew();
      } else if (e.key === "s") {
        if (editing) return;
        setScheduling(true);
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, scheduling, quickNew]);

  async function createFirstCalendar() {
    try {
      await addCalendar({
        name: "My calendar",
        owner_type: "member",
        owner_id: localMember().id,
        visibility: "private",
      });
      toast.success("Created “My calendar”", "Private to you until you share it.");
    } catch (e) {
      toast.error("Could not create the calendar", e);
    }
  }

  const title = rangeTitle(mode, range, anchor);
  const showsToday = now >= range.start && now < range.end;

  return (
    <Pane
      title="Calendar"
      subtitle={
        <>
          <span className="cal-range">{title}</span>
          {note && (
            <span className="cal-note" title={note}>
              Local only
            </span>
          )}
        </>
      }
      actions={
        <div className="cal-header-right">
          <div className="cal-nav">
            <button
              className="icon-btn cal-step"
              onClick={() => setAnchor((a) => shiftAnchor(mode, a, -1))}
              title="Previous (← or k)"
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              className={"btn cal-today" + (showsToday ? " on" : "")}
              onClick={() => setAnchor(Date.now())}
              title="Jump to today (t)"
            >
              Today
            </button>
            <button
              className="icon-btn cal-step"
              onClick={() => setAnchor((a) => shiftAnchor(mode, a, 1))}
              title="Next (→ or j)"
              aria-label="Next"
            >
              ›
            </button>
          </div>

          <div className="cal-seg" role="group" aria-label="Calendar range">
            {MODES.map((m) => (
              <button
                key={m.mode}
                className={"cal-seg-btn" + (mode === m.mode ? " on" : "")}
                aria-pressed={mode === m.mode}
                onClick={() => setMode(m.mode)}
                title={`${m.label} (${m.key})`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {(mode === "week" || mode === "day") && (
            <div className="cal-seg" role="group" aria-label="How calendars are stacked">
              <button
                className={"cal-seg-btn" + (layout === "overlay" ? " on" : "")}
                aria-pressed={layout === "overlay"}
                onClick={() => setLayout("overlay")}
                title="Every calendar in one grid"
              >
                Overlay
              </button>
              <button
                className={"cal-seg-btn" + (layout === "split" ? " on" : "")}
                aria-pressed={layout === "split"}
                onClick={() => setLayout("split")}
                title="One lane per owner — compare your time against an agent's"
              >
                Side by side
              </button>
            </div>
          )}

          <button
            className="btn"
            onClick={() => setScheduling(true)}
            title="Find a time that works for everyone (s)"
          >
            Schedule with…
          </button>

          <button
            className="btn primary"
            onClick={quickNew}
            disabled={!writable.length}
            title={writable.length ? "New event (n)" : "You have no calendar you can write to"}
          >
            ＋ Event
          </button>
        </div>
      }
      scroll={false}
      max={false}
      pad={false}
      className="cal-view"
    >
      {calendars.length === 0 ? (
        <EmptyCalendars
          onCreate={createFirstCalendar}
          providers={providers}
          syncing={syncingProvider}
          onSync={(t) => void syncProvider(t)}
          onConnect={() => setView({ type: "settings" })}
        />
      ) : (
        <div className="cal-body">
          <CalendarRail
            cals={cals}
            note={note}
            targets={targets}
            filter={filter}
            onFilter={setProviderFilter}
            providers={providers}
            syncing={syncingProvider}
            onSync={(t) => void syncProvider(t)}
            onConnect={() => setView({ type: "settings" })}
          />
          <div className="cal-surface">
            {mode === "month" ? (
              <MonthGrid
                days={range.days}
                anchor={anchor}
                items={items}
                now={now}
                onOpen={(item) => setEditing({ kind: "open", id: item.event.id })}
                onPickDay={(day) => {
                  setAnchor(day);
                  setMode("day");
                }}
              />
            ) : mode === "agenda" ? (
              <AgendaList
                days={range.days}
                items={items}
                now={now}
                onOpen={(item) => setEditing({ kind: "open", id: item.event.id })}
              />
            ) : (
              <TimeGrid
                days={range.days}
                items={items}
                groups={layout === "split" ? groups : null}
                now={now}
                canCreate={writable.length > 0}
                onOpen={(item) => setEditing({ kind: "open", id: item.event.id })}
                onCreate={(start, end) => openNew(start, end)}
              />
            )}
          </div>
        </div>
      )}

      {editing && <EventEditor editing={editing} setEditing={setEditing} onClose={() => setEditing(null)} />}

      {scheduling && (
        <ScheduleMeeting
          onClose={() => {
            setScheduling(false);
            // It widened the loaded window to search across days; put the view's
            // own window back or the grid keeps drawing somebody else's range.
            void loadEvents(range.start, range.end);
          }}
        />
      )}
    </Pane>
  );
}

/* ── empty state ──────────────────────────────────────────────── */

function EmptyCalendars({
  onCreate,
  providers,
  syncing,
  onSync,
  onConnect,
}: {
  onCreate: () => void;
  providers: ProviderState[];
  syncing: string;
  onSync: (target: Upstream) => void;
  onConnect: () => void;
}) {
  return (
    <div className="center-note cal-empty">
      <p>
        <strong>Calendars here have owners.</strong> Yours is your own time; the workspace has one of its
        own, and so do your teams and each of your agents.
      </p>
      <p>
        They stack in one grid so you can see them together, and anything shared with you as “busy” shows
        its times without ever showing what it is.
      </p>
      <button className="btn primary" onClick={onCreate}>
        Create “My calendar”
      </button>
      {/* Somebody arriving with a calendar already elsewhere should not have to
       * make an empty one first. */}
      <div className="cal-empty-accounts">
        <span className="cal-empty-or">or bring one you already keep</span>
        <div className="cal-acct-list">
          {providers.map((p) => (
            <AccountRow
              key={p.target}
              provider={p}
              syncing={syncing}
              onSync={onSync}
              onConnect={onConnect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── connected accounts ───────────────────────────────────────── */

/**
 * One provider, its state, and the one thing you can do about it.
 *
 * Apple is the odd one and says so: it is read from this machine by the native
 * bridge, so it connects here. Google and Microsoft need tokens the desktop
 * deliberately never holds, so the honest button sends you to where the pairing
 * lives rather than opening a sign-in that cannot work.
 */
function AccountRow({
  provider,
  syncing,
  onSync,
  onConnect,
}: {
  provider: ProviderState;
  syncing: string;
  onSync: (target: Upstream) => void;
  onConnect: () => void;
}) {
  const busy = syncing === provider.target;
  const canPullHere = provider.onThisMachine || provider.connected;
  return (
    <div className="cal-acct">
      <span className="cal-acct-name">
        <span className="cal-acct-label">{provider.label}</span>
        <span className={"cal-acct-state" + (provider.connected ? " on" : "")}>
          {provider.detail ? `${provider.state} · ${provider.detail}` : provider.state}
        </span>
      </span>
      {canPullHere ? (
        <button
          className="btn tiny"
          disabled={busy || !!syncing}
          onClick={() => onSync(provider.target)}
          title={
            provider.onThisMachine
              ? "Reads the calendars on this machine. Nothing leaves it."
              : `Pull this ${provider.label} account through the paired workspace.`
          }
        >
          {busy ? "Syncing…" : provider.connected ? "Sync" : "Connect"}
        </button>
      ) : (
        <button className="btn tiny" onClick={onConnect} title="Sign in from the paired workspace">
          Connect…
        </button>
      )}
    </div>
  );
}

/* ── the rail: whose calendar is whose ────────────────────────── */

function CalendarRail({
  cals,
  note,
  targets,
  filter,
  onFilter,
  providers,
  syncing,
  onSync,
  onConnect,
}: {
  cals: Calendar[];
  note: string;
  targets: SyncTarget[];
  filter: string;
  onFilter: (next: string) => void;
  providers: ProviderState[];
  syncing: string;
  onSync: (target: Upstream) => void;
  onConnect: () => void;
}) {
  const updateCalendar = useStore((s) => s.updateCalendar);

  const sections = RAIL_SECTIONS.map((s) => ({
    ...s,
    rows: cals.filter((c) => sectionOf(c) === s.key),
  })).filter((s) => s.rows.length > 0);

  return (
    <aside className="cal-rail" aria-label="Calendars">
      {/* Only worth a control when there is more than one answer: with a single
       * source it would be a filter that filters nothing. */}
      {targets.length > 1 && (
        <label className="cal-rail-filter">
          <span className="cal-rail-filter-label">Show</span>
          <select
            value={filter}
            aria-label="Filter calendars by where they come from"
            onChange={(e) => onFilter(e.target.value)}
          >
            <option value="">All calendars</option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {destinationLabel(t)}
              </option>
            ))}
          </select>
        </label>
      )}

      {sections.length === 0 && (
        <p className="cal-rail-empty">Nothing from that source. Show all calendars to see the rest.</p>
      )}

      {sections.map((section) => (
        <div className="cal-rail-section" key={section.key}>
          <div className="cal-rail-title" title={section.blurb}>
            {section.title}
          </div>
          {section.rows.map((c) => {
            const write = canWrite(c);
            // The row is the one place the busy tier gets explained, because the
            // blocks themselves must stay mute.
            const access = write ? "write" : c.visibility === "busy" ? "busy" : "read";
            const owner = ownerLabel(c);
            return (
              <label className="cal-rail-row" key={c.id} title={`${owner} · ${ACCESS_NOTE[access]}`}>
                <input
                  type="checkbox"
                  aria-label={`Show ${c.name} (${owner})`}
                  checked={!!c.enabled}
                  onChange={(e) => void updateCalendar(c.id, { enabled: e.target.checked ? 1 : 0 })}
                />
                <span
                  className="cal-swatch"
                  style={{ background: calendarColor(c) }}
                  aria-hidden="true"
                />
                <span className="cal-rail-name">
                  <span className="cal-rail-cal">{c.name}</span>
                  <span className="cal-rail-owner">{owner}</span>
                </span>
                {access === "busy" && (
                  <span className="cal-rail-lock" aria-label="Busy only">
                    <LockGlyph />
                  </span>
                )}
              </label>
            );
          })}
        </div>
      ))}

      {/* Empty only for the frame before the account tables answer; a heading
       * over nothing would flash on every visit. */}
      {providers.length > 0 && (
        <div className="cal-rail-section cal-rail-accounts">
          <div
            className="cal-rail-title"
            title="Where mirrored calendars come from. This machine's own needs nothing paired; the others are read through the paired workspace."
          >
            Accounts
          </div>
          <div className="cal-acct-list">
            {providers.map((p) => (
              <AccountRow
                key={p.target}
                provider={p}
                syncing={syncing}
                onSync={onSync}
                onConnect={onConnect}
              />
            ))}
          </div>
        </div>
      )}

      {note && <p className="cal-rail-note">{note}</p>}
    </aside>
  );
}

/* ── week / day ───────────────────────────────────────────────── */

/**
 * Dragging.
 *
 * On a calendar this is not a nicety, it is the surface: placing time by hand
 * is what a grid is *for*, and a drag that stutters, drops or cannot be taken
 * back makes the whole view feel broken however well the rest is drawn. Four
 * decisions carry it.
 *
 *  1. **The pointer is captured on the way down.** Every move after it and the
 *     release itself belong to the block, wherever the cursor has got to — over
 *     another column, over the rail, outside the window. A fast drag outrunning
 *     its block and being dropped on the floor is the commonest way a calendar
 *     feels cheap, and capture is the whole fix.
 *  2. **Nothing is committed until release.** What follows the pointer is a
 *     proxy driven by `transform`; the real block stays exactly where it was,
 *     as a ghost, so the change is legible *as* a change. Escape therefore
 *     restores by construction — there is nothing to put back, only a proxy to
 *     throw away — and a drag that cannot be abandoned is a trap.
 *  3. **One frame loop, one write.** A pointer move records a coordinate and
 *     nothing else; a single rAF reads it, works out the time and writes three
 *     styles. Per-frame React state would re-lay out every column sixty times a
 *     second, and a per-frame UPDATE would be worse.
 *  4. **The grid is measured once per drag.** Reading layout inside the loop —
 *     right after writing the proxy's transform — is exactly the forced reflow
 *     the rest of this is built to avoid, so scrolling is accounted for by
 *     arithmetic instead.
 */

type DragKind = "create" | "move" | "resize-start" | "resize-end";

interface DragSession {
  kind: DragKind;
  pointerId: number;
  /** Empty while drawing a new block, which has no row yet. */
  id: string;
  origin: { index: number; start: number; end: number; left: number; width: number };
  /** Where in the block the pointer took hold, as ms from that day's midnight. */
  grab: number;
  color: string;
  title: string;
}

/** What the proxy is showing, and what letting go would write. */
interface LiveDrag {
  index: number;
  /** Snapped: what the release commits, and what the label reads. */
  start: number;
  end: number;
  /** Magnetic: where the block actually sits under the pointer. */
  showStart: number;
  showEnd: number;
}

/** The grid's geometry, taken once at the start of a drag. */
interface Geo {
  left: number;
  top: number;
  height: number;
  colW: number;
  scroll0: number;
  edgeTop: number;
  edgeBottom: number;
}

/** A keyboard move waiting to be written, so arrow keys stay instant. */
interface Nudge {
  id: string;
  start: number;
  end: number;
}

/** How close to an edge auto-scroll begins, and its speed at the very edge. */
const EDGE_BAND = 68;
const EDGE_SPEED = 18;
/** The floating time label's height, so it can be placed clear of the block. */
const LABEL_H = 21;
/** Keys arrive one at a time; the write waits for the burst to finish. */
const NUDGE_FLUSH = 450;

interface Placed {
  item: VisibleEvent;
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Movable means a real event, on a calendar you may write to. */
function movable(item: VisibleEvent): boolean {
  return !item.redacted && canWrite(item.calendar);
}

/**
 * Why a block will not move, in a sentence.
 *
 * A busy block's reason says nothing whatever about the event — only about the
 * tier it was shared at — so answering the gesture here stays inside the
 * redaction promise instead of leaking around it.
 */
function immovableNote(item: VisibleEvent): string {
  return item.redacted
    ? "Shared as busy, so there is nothing here to move."
    : `${ownerLabel(item.calendar)} shares this read-only — it opens, but it does not move.`;
}

function TimeGrid({
  days,
  items,
  groups,
  now,
  canCreate,
  onOpen,
  onCreate,
}: {
  days: number[];
  items: VisibleEvent[];
  /** null in overlay mode; one lane per owner otherwise. */
  groups: OwnerGroup[] | null;
  now: number;
  canCreate: boolean;
  onOpen: (item: VisibleEvent) => void;
  onCreate: (start: number, end: number) => void;
}) {
  const updateEvent = useStore((s) => s.updateEvent);
  const daysRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /* The day headers and the all-day strip, which ride inside the scroller and
   * therefore cover its first rows. Two things need their height: where the
   * grid actually becomes visible, and how tall the scrolling content is
   * beneath them. Both read it here rather than assuming a number. */
  const stickyRef = useRef<HTMLDivElement>(null);
  /** The 24 hours themselves, which are the only part of the scroller that is a
   * clock. Opening on the working day measures this and not the scroller. */
  const gridRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  /* Rendered state changes about three times per drag: at the start, each time
   * the pointer crosses into another day, and at the settle. Everything that
   * changes per frame lives in a ref and is written straight to the DOM. */
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [dropIndex, setDropIndex] = useState(-1);
  const [settling, setSettling] = useState(false);
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const [said, setSaid] = useState("");

  const dragRef = useRef<DragSession | null>(null);
  const liveRef = useRef<LiveDrag | null>(null);
  const geoRef = useRef<Geo | null>(null);
  const dropRef = useRef(-1);
  const captureRef = useRef<HTMLElement | null>(null);
  const pointRef = useRef({ x: 0, y: 0, fine: false, free: false });
  const downRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const dirtyRef = useRef(false);
  const settleRef = useRef(false);
  const settleTimerRef = useRef(0);
  const frameRef = useRef(0);
  const lastFrameRef = useRef(0);
  const tickRef = useRef<(dt: number) => void>(() => {});
  const nudgeRef = useRef<Nudge | null>(null);
  const flushRef = useRef(0);
  nudgeRef.current = nudge;

  /**
   * When a drag last changed something. The click that follows a drag has to be
   * swallowed or the editor opens on every move — but a drag ending over a
   * different day fires no click on the block at all, so a boolean flag would
   * stay raised and eat someone's next real click. A timestamp expires on its
   * own.
   */
  const movedAtRef = useRef(0);

  // Open on the working day rather than at midnight; hours 0–7 are almost
  // always empty and would otherwise be all you see.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const grid = gridRef.current;
    if (!el || !grid) return;
    /* The fraction is of the day, so it is taken over the grid's height and not
     * the scroller's: the scroller also holds the headers, whose height depends
     * on how many all-day bars this week happens to stack. A sticky header
     * covers the scrollport's first rows, so scrolling by a grid-local offset
     * lands that offset at the top of what is actually visible. */
    el.scrollTop = Math.max(0, (grid.offsetHeight * 7.5) / 24 - 12);
  }, [days.length]);

  /* ── geometry ───────────────────────────────────────────────── */

  function measure(): Geo | null {
    const el = daysRef.current;
    const sc = scrollRef.current;
    if (!el || !sc) return null;
    const r = el.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const g: Geo = {
      left: r.left,
      top: r.top,
      height: r.height,
      colW: r.width / Math.max(1, days.length),
      scroll0: sc.scrollTop,
      // Where the grid starts being *seen*, not where the scroller starts: the
      // headers sit over its first rows, and a drag that reaches them has
      // already gone out of sight, so the auto-scroll band begins under them.
      edgeTop: stickyRef.current?.getBoundingClientRect().bottom ?? s.top,
      edgeBottom: s.bottom,
    };
    geoRef.current = g;
    return g;
  }

  /** Which column, and how far down that day, a screen point falls. */
  function pointFor(x: number, y: number): { index: number; frac: number } {
    const g = geoRef.current;
    if (!g) return { index: 0, frac: 0 };
    const scrolled = (scrollRef.current?.scrollTop ?? g.scroll0) - g.scroll0;
    return {
      index: clamp(Math.floor((x - g.left) / g.colW), 0, days.length - 1),
      frac: clamp((y - (g.top - scrolled)) / g.height, 0, 1),
    };
  }

  /* ── the frame loop ─────────────────────────────────────────── */

  /** Work out where the block is now. Arithmetic only; writes no styles. */
  function track() {
    const d = dragRef.current;
    if (!d) return;
    const p = pointRef.current;
    const step = p.free ? SNAP_FREE : p.fine ? SNAP_FINE : SNAP_MS;
    // The shortest block a drag can produce follows the increment in play, so
    // ⌥ buys a ten-minute meeting and not merely a finer start.
    const min = Math.max(SNAP_FINE, step);
    const at = pointFor(p.x, p.y);
    // Only a move changes column. A resize is a vertical gesture, and letting
    // it wander sideways would silently re-day the event being lengthened.
    const index = d.kind === "move" ? at.index : d.origin.index;
    const day = days[index];
    const span = addDays(day, 1) - day;
    const ms = at.frac * span;
    let live: LiveDrag;

    if (d.kind === "move") {
      const len = d.origin.end - d.origin.start;
      // A timed block belongs to one column, so it stops at midnight rather
      // than half-appearing in a day it was never dropped on.
      const room = Math.max(0, span - len);
      const raw = clamp(ms - d.grab, 0, room);
      const settled = clamp(snapTo(raw, step), 0, room);
      const shown = clamp(magnet(raw, step), 0, room);
      live = {
        index,
        start: day + settled,
        end: day + settled + len,
        showStart: day + shown,
        showEnd: day + shown + len,
      };
    } else if (d.kind === "create") {
      const a = Math.min(d.grab, ms);
      const b = Math.max(d.grab, ms);
      // A press that never moved is a click, and a click means "about half an
      // hour, starting here" rather than a zero-length sliver.
      const floor = movedRef.current ? min : CLICK_LEN;
      const start = clamp(snapTo(a, step), 0, span);
      const showStart = clamp(magnet(a, step), 0, span);
      live = {
        index,
        start: day + start,
        end: day + Math.min(span, Math.max(clamp(snapTo(b, step), 0, span), start + floor)),
        showStart: day + showStart,
        showEnd: day + Math.max(clamp(magnet(b, step), 0, span), showStart + floor),
      };
    } else if (d.kind === "resize-end") {
      const startOff = d.origin.start - day;
      const floor = startOff + min;
      const settled = clamp(Math.max(snapTo(ms, step), floor), floor, span);
      // Past the minimum the block resists rather than snapping shut: it gives
      // a little, springs back on release, and the gesture reads as a limit met
      // instead of an event that vanished under your hand.
      let shown = clamp(magnet(ms, step), 0, span);
      if (shown < floor) shown = Math.max(floor - (floor - shown) * 0.3, startOff + min * 0.4);
      live = { index, start: d.origin.start, end: day + settled, showStart: d.origin.start, showEnd: day + shown };
    } else {
      const endOff = Math.min(d.origin.end - day, span);
      const ceiling = Math.max(0, endOff - min);
      const settled = clamp(Math.min(snapTo(ms, step), ceiling), 0, ceiling);
      let shown = clamp(magnet(ms, step), 0, span);
      if (shown > ceiling) shown = Math.min(ceiling + (shown - ceiling) * 0.3, endOff - min * 0.4);
      live = { index, start: day + settled, end: d.origin.end, showStart: day + shown, showEnd: d.origin.end };
    }

    liveRef.current = live;
    if (live.index !== dropRef.current) {
      dropRef.current = live.index;
      setDropIndex(live.index);
    }
  }

  /** The only place a drag writes to the DOM: four styles and a string. */
  function paint() {
    const el = proxyRef.current;
    const l = liveRef.current;
    const g = geoRef.current;
    const d = dragRef.current;
    if (!el || !l || !g || !d) return;
    const day = days[l.index];
    const span = addDays(day, 1) - day;
    const top = ((l.showStart - day) / span) * g.height;
    const height = Math.max(((l.showEnd - l.showStart) / span) * g.height, 4);
    // +1 for the column's own left border, −3 for the gutter a block leaves
    // between itself and its neighbour: the proxy has to sit exactly where the
    // block will land, or the settle looks like a nudge.
    const x = (l.index + d.origin.left) * g.colW + 1;
    el.style.width = `${Math.max((g.colW - 1) * d.origin.width - 3, 12)}px`;
    el.style.height = `${height}px`;
    el.style.transform = `translate3d(${x}px, ${top}px, 0)`;
    const label = labelRef.current;
    if (label) {
      // The label reads the *committed* times, never the magnetic ones: it is
      // the promise the release will keep.
      label.textContent = `${fmtTime(l.start)} – ${fmtTime(l.end)} · ${fmtLen(l.end - l.start)}`;
      // A sibling rather than a child, because the proxy has to be free to
      // shrink to a fifteen-minute sliver and a label inside it would set a
      // floor the resize could never go under. It rides just above the block,
      // and drops inside only when there is no room above.
      const ly = top > LABEL_H + 2 ? top - LABEL_H : top + 1;
      label.style.transform = `translate3d(${x}px, ${ly}px, 0)`;
    }
  }

  /**
   * Scroll the grid when the pointer nears an edge, faster the closer it gets.
   * Squared, so the outer edge of the band is a crawl you can stop inside and
   * the last few pixels really move.
   *
   * `dt` is what makes it a speed rather than a step: at 120Hz a per-frame
   * constant scrolls twice as fast as at 60, and a drag that behaves
   * differently on a better display is a bug people cannot report.
   */
  function autoScroll(dt: number): boolean {
    const sc = scrollRef.current;
    const g = geoRef.current;
    if (!sc || !g) return false;
    const y = pointRef.current.y;
    let v = 0;
    if (y < g.edgeTop + EDGE_BAND) v = (y - (g.edgeTop + EDGE_BAND)) / EDGE_BAND;
    else if (y > g.edgeBottom - EDGE_BAND) v = (y - (g.edgeBottom - EDGE_BAND)) / EDGE_BAND;
    if (!v) return false;
    const before = sc.scrollTop;
    sc.scrollTop = before + Math.sign(v) * Math.min(1, v * v) * EDGE_SPEED * dt;
    return sc.scrollTop !== before;
  }

  /* Re-aimed every render so the loop never runs against a stale week: the
   * scheduled callback is the one from the first frame, and only this ref
   * decides what it does. */
  tickRef.current = (dt: number) => {
    if (!dragRef.current || settleRef.current) return;
    // Auto-scroll moves the grid under a stationary pointer, which is still a
    // change of time, so it dirties the drag exactly as a pointer move does.
    if (autoScroll(dt)) dirtyRef.current = true;
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    track();
    paint();
  };

  function frame(t: number) {
    frameRef.current = requestAnimationFrame(frame);
    // Capped at four frames' worth: a tab that was backgrounded mid-drag comes
    // back with a huge delta, and catching up in one leap is not a scroll.
    const dt = Math.min(4, lastFrameRef.current ? (t - lastFrameRef.current) / 16.7 : 1);
    lastFrameRef.current = t;
    tickRef.current(dt);
  }

  function stopFrames() {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    lastFrameRef.current = 0;
  }

  /* The proxy mounts with no transform, so it would flash at the grid's origin
   * for a frame. Painting from a layout effect — after every render, because
   * crossing into another day re-renders mid-drag — places it before paint. */
  useLayoutEffect(() => {
    if (dragRef.current) paint();
  });

  useEffect(
    () => () => {
      stopFrames();
      window.clearTimeout(settleTimerRef.current);
      window.clearTimeout(flushRef.current);
    },
    []
  );

  /* ── keyboard moves ─────────────────────────────────────────── */

  /**
   * Arrow keys do what the pointer does, at the same increment.
   *
   * The write is held back until the burst of keypresses stops — a held arrow
   * is thirty keystrokes a second and not one of them is worth a round trip —
   * so the move shows at once as a local override, and Escape can still take it
   * back while it is in the air.
   */
  const flushNudge = useCallback(() => {
    window.clearTimeout(flushRef.current);
    const n = nudgeRef.current;
    if (!n) return;
    void (async () => {
      try {
        await updateEvent(n.id, { starts_at: n.start, ends_at: n.end });
      } catch (e) {
        toast.error("Could not move the event", e);
      } finally {
        // Clear only the override this write actually covered: another key may
        // have landed while it was in flight.
        setNudge((cur) =>
          cur && cur.id === n.id && cur.start === n.start && cur.end === n.end ? null : cur
        );
      }
    })();
  }, [updateEvent]);

  /* ── starting, finishing, abandoning ────────────────────────── */

  function begin(
    e: ReactPointerEvent<HTMLElement>,
    session: Omit<DragSession, "pointerId">,
    live: LiveDrag
  ) {
    const s: DragSession = { ...session, pointerId: e.pointerId };
    dragRef.current = s;
    liveRef.current = live;
    dropRef.current = live.index;
    pointRef.current = { x: e.clientX, y: e.clientY, fine: e.altKey, free: e.metaKey || e.ctrlKey };
    downRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    dirtyRef.current = false;
    settleRef.current = false;
    captureRef.current = e.currentTarget;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer already gone: better that the drag never starts than that it
      // starts and cannot be finished.
    }
    setDrag(s);
    setDropIndex(live.index);
    setSettling(false);
    stopFrames();
    frameRef.current = requestAnimationFrame(frame);
  }

  function releaseCapture() {
    const el = captureRef.current;
    const id = dragRef.current?.pointerId;
    captureRef.current = null;
    if (!el || id === undefined) return;
    try {
      el.releasePointerCapture(id);
    } catch {
      /* already released, which is the state we were after */
    }
  }

  function clearDrag() {
    dragRef.current = null;
    liveRef.current = null;
    dropRef.current = -1;
    settleRef.current = false;
    window.clearTimeout(settleTimerRef.current);
    stopFrames();
    setDrag(null);
    setDropIndex(-1);
    setSettling(false);
  }

  function onDragMove(e: ReactPointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId || settleRef.current) return;
    // The block sits inside the column, and both are listening so that either
    // can own a drag; only the first one to see the event should act on it.
    e.stopPropagation();
    pointRef.current = { x: e.clientX, y: e.clientY, fine: e.altKey, free: e.metaKey || e.ctrlKey };
    if (!movedRef.current) {
      const dx = e.clientX - downRef.current.x;
      const dy = e.clientY - downRef.current.y;
      if (dx * dx + dy * dy > 9) movedRef.current = true;
    }
    dirtyRef.current = true;
  }

  function onDragEnd(e: ReactPointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId || settleRef.current) return;
    e.stopPropagation();
    // One last look at where the pointer really ended up: a release can carry a
    // position no move event ever reported.
    pointRef.current = { x: e.clientX, y: e.clientY, fine: e.altKey, free: e.metaKey || e.ctrlKey };
    track();
    const final = liveRef.current;
    releaseCapture();

    if (d.kind === "create") {
      clearDrag();
      if (final) onCreate(final.start, Math.max(final.end, final.start + SNAP_FINE));
      return;
    }

    if (!final || (final.start === d.origin.start && final.end === d.origin.end)) {
      // Never crossed an increment: this was a click, and the click handler is
      // the one that should answer it.
      clearDrag();
      return;
    }

    movedAtRef.current = Date.now();
    // Settle onto the increment it is written at. The magnetic offset can be
    // half a step from the snap, and a block that lands somewhere other than
    // where it was dropped should be seen to travel there.
    liveRef.current = { ...final, showStart: final.start, showEnd: final.end };
    settleRef.current = true;
    setSettling(true);
    settleTimerRef.current = window.setTimeout(clearDrag, SETTLE_MS);

    void updateEvent(d.id, { starts_at: final.start, ends_at: final.end }).catch((err) =>
      toast.error("Could not move the event", err)
    );
    setSaid(`${d.title || "Event"} moved to ${describeSpan(final.start, final.end)}.`);
  }

  const cancelDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d || settleRef.current) return;
    releaseCapture();
    clearDrag();
    // The release after Escape still fires a click on the block; without this,
    // an abandoned drag would open the editor it was never asked for.
    movedAtRef.current = Date.now();
    if (d.kind !== "create") setSaid("Move cancelled. The event is back where it was.");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- everything it touches is a ref or a setter
  }, []);

  /* Escape, in the capture phase, so a mid-drag press belongs to the drag
   * rather than to whatever else in the app is listening for it. The arrows go
   * the same way: the view pages the week on them, and a week that changes
   * under a block being carried leaves the drag holding a column that is no
   * longer the one it was aimed at. */
  useEffect(() => {
    if (!drag) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelDrag();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag, cancelDrag]);

  /* ── the three ways in ──────────────────────────────────────── */

  function startCreate(e: ReactPointerEvent<HTMLDivElement>, index: number) {
    if (!canCreate || e.button !== 0 || dragRef.current) return;
    // Only empty space starts a new event; the blocks handle their own drags.
    if (e.target !== e.currentTarget) return;
    if (!measure()) return;
    const day = days[index];
    const span = addDays(day, 1) - day;
    const ms = pointFor(e.clientX, e.clientY).frac * span;
    const start = clamp(snapTo(ms, SNAP_MS), 0, span);
    const end = Math.min(span, start + CLICK_LEN);
    begin(
      e,
      {
        kind: "create",
        id: "",
        origin: { index, start: day + start, end: day + end, left: 0, width: 1 },
        grab: ms,
        color: "",
        title: "",
      },
      { index, start: day + start, end: day + end, showStart: day + start, showEnd: day + end }
    );
  }

  function startMove(e: ReactPointerEvent<HTMLElement>, placed: Placed, index: number) {
    if (e.button !== 0 || dragRef.current) return;
    e.stopPropagation();
    flushNudge();
    if (!measure()) return;
    const ev = placed.item.event;
    const day = days[index];
    const span = addDays(day, 1) - day;
    // Grab the block where it was actually taken hold of, so it does not jump
    // its own height to centre itself on the pointer.
    const grab = pointFor(e.clientX, e.clientY).frac * span - (ev.starts_at - day);
    begin(
      e,
      {
        kind: "move",
        id: ev.id,
        origin: { index, start: ev.starts_at, end: ev.ends_at, left: placed.left, width: placed.width },
        grab,
        color: placed.item.color,
        title: ev.title,
      },
      { index, start: ev.starts_at, end: ev.ends_at, showStart: ev.starts_at, showEnd: ev.ends_at }
    );
  }

  function startResize(
    e: ReactPointerEvent<HTMLElement>,
    placed: Placed,
    index: number,
    edge: "start" | "end"
  ) {
    if (e.button !== 0 || dragRef.current) return;
    e.stopPropagation();
    flushNudge();
    if (!measure()) return;
    const ev = placed.item.event;
    begin(
      e,
      {
        kind: edge === "start" ? "resize-start" : "resize-end",
        id: ev.id,
        origin: { index, start: ev.starts_at, end: ev.ends_at, left: placed.left, width: placed.width },
        grab: 0,
        color: placed.item.color,
        title: ev.title,
      },
      { index, start: ev.starts_at, end: ev.ends_at, showStart: ev.starts_at, showEnd: ev.ends_at }
    );
  }

  function onBlockKey(e: ReactKeyboardEvent<HTMLElement>, item: VisibleEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(item);
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    const arrow = e.key.startsWith("Arrow");
    if (!movable(item)) {
      // The tooltip answers the pointer; this answers the keyboard, which
      // would otherwise get silence and no way to find out why.
      if (arrow) {
        e.preventDefault();
        setSaid(immovableNote(item));
      }
      return;
    }
    const ev = item.event;

    if (e.key === "Escape" && nudgeRef.current?.id === ev.id) {
      e.preventDefault();
      window.clearTimeout(flushRef.current);
      nudgeRef.current = null;
      setNudge(null);
      setSaid("Move cancelled. The event is back where it was.");
      return;
    }

    const vertical = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    const horizontal = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!vertical && !horizontal) return;
    e.preventDefault();
    // The view pages the week on left/right; while an event has focus those
    // keys belong to the event.
    e.stopPropagation();

    const step = e.altKey ? SNAP_FINE : SNAP_MS;
    const base =
      nudgeRef.current?.id === ev.id
        ? nudgeRef.current
        : { id: ev.id, start: ev.starts_at, end: ev.ends_at };
    let { start, end } = base;
    const day = startOfDay(start);
    const midnight = addDays(day, 1);
    if (horizontal) {
      // By calendar date, not by 24 hours: a week containing a clock change
      // would otherwise drift an hour halfway across it.
      start = addDays(start, horizontal);
      end = addDays(end, horizontal);
    } else if (e.shiftKey) {
      end = clamp(end + vertical * step, start + Math.max(SNAP_FINE, step), midnight);
    } else {
      // Stops at midnight, exactly as the drag does — an event nudged past it
      // would silently become a multi-day banner and leave the grid.
      const len = end - start;
      start = clamp(start + vertical * step, day, Math.max(day, midnight - len));
      end = start + len;
    }

    const next: Nudge = { id: ev.id, start, end };
    nudgeRef.current = next;
    setNudge(next);
    setSaid(
      e.shiftKey && vertical
        ? `${ev.title}, now ${fmtLen(end - start)}, ending ${fmtTime(end)}.`
        : `${ev.title} moved to ${describeSpan(start, end)}.`
    );
    window.clearTimeout(flushRef.current);
    flushRef.current = window.setTimeout(flushNudge, NUDGE_FLUSH);
  }

  /* ── what is drawn ──────────────────────────────────────────── */

  /* The dragged block is deliberately not moved here: the proxy carries it and
   * the original stays put as a ghost, which is what makes the change legible.
   * A keyboard nudge has no proxy, so that one is applied. */
  const shown = useMemo(() => {
    if (!nudge) return items;
    return items.map((i) =>
      i.event.id === nudge.id
        ? { ...i, event: { ...i.event, starts_at: nudge.start, ends_at: nudge.end } }
        : i
    );
  }, [items, nudge]);

  const timed = useMemo(() => shown.filter((i) => !isBanner(i.event)), [shown]);
  const banners = useMemo(() => shown.filter((i) => isBanner(i.event)), [shown]);

  const lanes = groups && groups.length > 1 ? groups : null;

  const placedByDay = useMemo(() => {
    return days.map((day) => {
      const dayItems = timed.filter((i) => overlaps(i.event, day, addDays(day, 1)));
      const out: Placed[] = [];
      if (!lanes) {
        for (const p of layoutDay(dayItems, day)) {
          out.push({
            item: p.item,
            top: p.top,
            height: p.height,
            left: p.column / p.columns,
            width: 1 / p.columns,
          });
        }
        return out;
      }
      lanes.forEach((g, gi) => {
        const mine = dayItems.filter((i) => g.ids.has(i.calendar.id));
        for (const p of layoutDay(mine, day)) {
          out.push({
            item: p.item,
            top: p.top,
            height: p.height,
            left: (gi + p.column / p.columns) / lanes.length,
            width: 1 / (lanes.length * p.columns),
          });
        }
      });
      return out;
    });
  }, [days, timed, lanes]);

  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => h), []);

  /* Where the now-line sits, if today is on screen at all. One answer for the
   * whole grid: every column shares the vertical scale. */
  const nowFrac = useMemo(() => {
    const i = days.findIndex((d) => now >= d && now < addDays(d, 1));
    if (i < 0) return null;
    const day = days[i];
    return (now - day) / (addDays(day, 1) - day);
  }, [days, now]);

  const resizing = drag?.kind === "resize-start" || drag?.kind === "resize-end";

  return (
    <div
      className={
        "cal-grid-wrap" +
        (lanes ? " split" : "") +
        (lanes && days.length > 2 ? " narrow" : "") +
        (resizing ? " cal-resizing" : "")
      }
      /* The app-wide drag lock: one grabbing cursor for the whole document and
       * no stray text selection trailing the pointer. A resize opts out — it
       * wants the axis cursor instead. */
      data-dragging={drag && !resizing ? "" : undefined}
      /* The week's column count, declared once for the whole view. The headers,
       * the all-day strip and the grid all size their columns from this, so
       * there is no second place that could be told a different number. */
      style={{ ["--cal-cols" as string]: days.length } as CSSProperties}
    >
      {/* One scroller for the whole view. The headers and the all-day strip
        * used to sit above it as siblings, which meant they were laid out over
        * the scroller's *border* width while the grid got its *content* width —
        * a scrollbar's worth of disagreement that fanned out across the columns
        * and put Sunday's events under Saturday's heading. Inside, they share
        * the one content box, and a scrollbar that appears, disappears or is an
        * overlay that never took space at all cannot make them differ. */}
      <div className="cal-scroll scroll-pane" ref={scrollRef}>
        <div className="cal-sticky" ref={stickyRef}>
          <div className="cal-headrow">
            <div className="cal-gutter-head" aria-hidden="true" />
            <div className="cal-headdays">
              {days.map((day, di) => (
                <div
                  className={
                    "cal-dayhead" +
                    (sameDay(day, now) ? " today" : "") +
                    (drag?.kind === "move" && dropIndex === di ? " drop" : "")
                  }
                  key={day}
                >
                  <span className="cal-dayhead-name">{fWeekday.format(new Date(day))}</span>
                  <span className="cal-dayhead-num">{fDayNum.format(new Date(day))}</span>
                  {lanes && days.length === 1 && (
                    <span className="cal-lanehead">
                      {lanes.map((g) => (
                        <span
                          className="cal-lane-label"
                          key={g.key}
                          style={{ width: `${100 / lanes.length}%` }}
                        >
                          <i
                            className="cal-swatch"
                            style={{ background: g.color }}
                            aria-hidden="true"
                          />
                          {g.label}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {lanes && days.length > 1 && (
            <div className="cal-lane-legend">
              <span className="cal-lane-legend-label">Lanes, left to right:</span>
              {lanes.map((g) => (
                <span className="chip cal-lane-chip" key={g.key}>
                  <i className="cal-swatch" style={{ background: g.color }} aria-hidden="true" />
                  {g.label}
                </span>
              ))}
            </div>
          )}

          <AllDayStrip days={days} banners={banners} now={now} onOpen={onOpen} />
        </div>

        <div className="cal-grid" ref={gridRef}>
          <div className="cal-gutter" aria-hidden="true">
            {hours.map((h) => (
              <div className="cal-hour" key={h}>
                <span>{h === 0 ? "" : fHour.format(new Date(2020, 0, 1, h))}</span>
              </div>
            ))}
            {/* The clock the red line is claiming, said in words, because a
             * line between two hour labels is a guess otherwise. */}
            {nowFrac !== null && (
              <div className="cal-now-label" style={{ top: `${nowFrac * 100}%` }}>
                {fmtTime(now)}
              </div>
            )}
          </div>
          <div className={"cal-days" + (days.length === 1 ? " single" : "")} ref={daysRef}>
            {days.map((day, di) => {
              const span = addDays(day, 1) - day;
              const showsNow = now >= day && now < day + span;
              return (
                <div
                  className={
                    "cal-day" +
                    (sameDay(day, now) ? " today" : "") +
                    (drag && dropIndex === di ? " drop" : "")
                  }
                  key={day}
                  onPointerDown={(e) => startCreate(e, di)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                  onPointerCancel={cancelDrag}
                >
                  {lanes &&
                    lanes.slice(1).map((g, i) => (
                      <div
                        className="cal-lane-rule"
                        key={g.key}
                        style={{ left: `${((i + 1) / lanes.length) * 100}%` }}
                      />
                    ))}

                  {placedByDay[di].map((p) => (
                    <EventBlock
                      key={p.item.event.id}
                      placed={p}
                      dayIndex={di}
                      ghost={!!drag && drag.id === p.item.event.id}
                      onOpen={() => {
                        if (Date.now() - movedAtRef.current < 250) return;
                        onOpen(p.item);
                      }}
                      onMoveStart={startMove}
                      onResizeStart={startResize}
                      onPointerMove={onDragMove}
                      onPointerUp={onDragEnd}
                      onPointerCancel={cancelDrag}
                      onKey={onBlockKey}
                      onLeave={flushNudge}
                    />
                  ))}

                  {showsNow && nowFrac !== null && (
                    <div className="cal-now" style={{ top: `${nowFrac * 100}%` }} aria-hidden="true">
                      <i />
                    </div>
                  )}
                </div>
              );
            })}

            {/* One proxy for all four gestures, so the block you are placing,
             * the edge you are pulling and the slot you are drawing all look
             * and behave like the same thing. */}
            {drag && (
              <>
                <div
                  ref={proxyRef}
                  className={
                    "cal-drag" + (drag.kind === "create" ? " new" : "") + (settling ? " settling" : "")
                  }
                  style={
                    drag.color ? ({ ["--cal-c" as string]: drag.color } as CSSProperties) : undefined
                  }
                  aria-hidden="true"
                >
                  {drag.title && <span className="cal-drag-title">{drag.title}</span>}
                </div>
                <span
                  className={"cal-drag-time" + (settling ? " settling" : "")}
                  ref={labelRef}
                  aria-hidden="true"
                />
              </>
            )}
          </div>
        </div>
      </div>

      {drag && !settling && (
        <div className="cal-drag-hint" aria-hidden="true">
          <kbd>⌥</kbd> 5 min
          <i />
          <kbd>⌘</kbd> to the minute
          <i />
          <kbd>esc</kbd> cancels
        </div>
      )}

      {/* Politely, and only what changed. A drag says everything it is doing on
       * screen already; this is here for the keyboard path. */}
      <div className="cal-sr" aria-live="polite" aria-atomic="true">
        {said}
      </div>
    </div>
  );
}

function EventBlock({
  placed,
  dayIndex,
  ghost,
  onOpen,
  onMoveStart,
  onResizeStart,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKey,
  onLeave,
}: {
  placed: Placed;
  dayIndex: number;
  /** True while this block is the one being dragged; the proxy carries it. */
  ghost: boolean;
  onOpen: () => void;
  onMoveStart: (e: ReactPointerEvent<HTMLElement>, placed: Placed, dayIndex: number) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLElement>,
    placed: Placed,
    dayIndex: number,
    edge: "start" | "end"
  ) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onKey: (e: ReactKeyboardEvent<HTMLElement>, item: VisibleEvent) => void;
  onLeave: () => void;
}) {
  const { item } = placed;
  const ev = item.event;
  const editable = movable(item);
  const style: CSSProperties = {
    top: `${placed.top * 100}%`,
    height: `${placed.height * 100}%`,
    left: `${placed.left * 100}%`,
    width: `${placed.width * 100}%`,
    // Read by calendar.css for the left edge, the tint and the focus ring.
    ["--cal-c" as string]: placed.item.color,
  };
  const short = placed.height < 0.03;

  /* A busy block is inert on purpose: no title, no tooltip about the event and
   * nothing in the accessibility tree beyond the times it is allowed to show.
   * The one thing it will say is why the gesture did nothing, which is a fact
   * about the sharing tier rather than about the event. */
  if (item.redacted) {
    return (
      <div
        className={"cal-ev cal-ev-busy" + (short ? " short" : "")}
        style={style}
        role="img"
        title={immovableNote(item)}
        aria-label={`Busy, ${fmtTime(ev.starts_at)} to ${fmtTime(ev.ends_at)}`}
      >
        <span className="cal-ev-title">
          <LockGlyph /> Busy
        </span>
        {!short && <span className="cal-ev-time">{fmtSpan(ev)}</span>}
      </div>
    );
  }

  const hint = editable
    ? "Drag to move it, the edges to resize it. Arrow keys do the same."
    : immovableNote(item);

  return (
    <div
      className={
        "cal-ev" + (short ? " short" : "") + (ghost ? " ghost" : "") + (editable ? " editable" : " locked")
      }
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`${ev.title}, ${fmtSpan(ev)}, ${item.calendar.name}`}
      title={`${ev.title}\n${fmtSpan(ev)}\n${ownerLabel(item.calendar)} · ${item.calendar.name}\n${hint}`}
      onClick={onOpen}
      onKeyDown={(e) => onKey(e, item)}
      onBlur={onLeave}
      onPointerDown={editable ? (e) => onMoveStart(e, placed, dayIndex) : undefined}
      onPointerMove={editable ? onPointerMove : undefined}
      onPointerUp={editable ? onPointerUp : undefined}
      onPointerCancel={editable ? onPointerCancel : undefined}
    >
      <span className="cal-ev-title">{ev.title}</span>
      {!short && <span className="cal-ev-time">{fmtSpan(ev)}</span>}
      {!short && ev.location && <span className="cal-ev-where">{ev.location}</span>}
      {!editable && (
        <span className="cal-ev-lock" aria-hidden="true">
          <LockGlyph />
        </span>
      )}
      {editable && (
        <>
          {/* Present at low contrast rather than absent until hover: an
           * affordance nobody can see is one nobody finds. */}
          <span
            className="cal-ev-grip top"
            onPointerDown={(e) => onResizeStart(e, placed, dayIndex, "start")}
            aria-hidden="true"
          />
          <span
            className="cal-ev-grip bottom"
            onPointerDown={(e) => onResizeStart(e, placed, dayIndex, "end")}
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
}

/* ── the all-day strip ────────────────────────────────────────── */

function AllDayStrip({
  days,
  banners,
  now,
  onOpen,
}: {
  days: number[];
  banners: VisibleEvent[];
  now: number;
  onOpen: (item: VisibleEvent) => void;
}) {
  const rows = useMemo(() => {
    const spans = banners
      .map((item) => {
        let from = days.findIndex((d) => item.event.ends_at > d && item.event.starts_at < addDays(d, 1));
        if (from < 0) return null;
        let to = from;
        while (to + 1 < days.length && item.event.ends_at > days[to + 1]) to++;
        return { item, from, to };
      })
      .filter((b): b is { item: VisibleEvent; from: number; to: number } => b !== null)
      .sort((a, b) => a.from - b.from || b.to - a.to);

    // Greedy packing: the first row with room takes the bar.
    const packed: { item: VisibleEvent; from: number; to: number }[][] = [];
    for (const bar of spans) {
      let row = packed.find((r) => r.every((b) => bar.from > b.to || bar.to < b.from));
      if (!row) {
        row = [];
        packed.push(row);
      }
      row.push(bar);
    }
    return packed;
  }, [banners, days]);

  return (
    <div className="cal-allday">
      <div className="cal-gutter-head cal-allday-label">all-day</div>
      <div className="cal-allday-rows">
        {/* The strip has to read as the same columns as the grid under it, or a
         * bar spanning Tuesday to Thursday is something you have to measure.
         * Both of these take their tracks from --cal-cols in calendar.css, the
         * same declaration the headers and the grid use; a repeat() written out
         * here would be a fourth opinion about one geometry. */}
        <div className="cal-allday-cols" aria-hidden="true">
          {days.map((d) => (
            <span className={"cal-allday-col" + (sameDay(d, now) ? " today" : "")} key={d} />
          ))}
        </div>
        {rows.length === 0 && <div className="cal-allday-empty" />}
        {rows.map((row, ri) => (
          <div className="cal-allday-row" key={ri}>
            {row.map((bar) => {
              const style: CSSProperties = {
                gridColumn: `${bar.from + 1} / ${bar.to + 2}`,
                ["--cal-c" as string]: bar.item.color,
              };
              if (bar.item.redacted) {
                return (
                  <div
                    className="cal-bar cal-ev-busy"
                    key={bar.item.event.id}
                    style={style}
                    role="img"
                    title={immovableNote(bar.item)}
                    aria-label="Busy, all day"
                  >
                    <LockGlyph /> Busy
                  </div>
                );
              }
              return (
                <button
                  className="cal-bar"
                  key={bar.item.event.id}
                  style={style}
                  onClick={() => onOpen(bar.item)}
                  title={`${bar.item.event.title}\n${ownerLabel(bar.item.calendar)} · ${bar.item.calendar.name}`}
                >
                  {bar.item.event.title}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── month ────────────────────────────────────────────────────── */

function MonthGrid({
  days,
  anchor,
  items,
  now,
  onOpen,
  onPickDay,
}: {
  days: number[];
  anchor: number;
  items: VisibleEvent[];
  now: number;
  onOpen: (item: VisibleEvent) => void;
  onPickDay: (day: number) => void;
}) {
  const month = new Date(startOfMonth(anchor)).getMonth();
  const weekdays = days.slice(0, 7);

  return (
    <div className="cal-month">
      {/* The weekday names and the cells they name scroll in one box, for the
        * reason the week view's headers do: laid out over a scroller from the
        * outside, they get a scrollbar's width the grid never had. In the month
        * that bug is latent rather than visible — six rows of cells only
        * overflow in a short window — which is exactly why it was worth
        * removing rather than waiting for someone to resize into it. */}
      <div className="cal-month-scroll scroll-pane">
        <div className="cal-month-head">
          {weekdays.map((d) => (
            <div className="cal-month-weekday" key={d}>
              {fWeekday.format(new Date(d))}
            </div>
          ))}
        </div>
        <div className="cal-month-grid">
          {days.map((day) => {
            const dayItems = items
              .filter((i) => overlaps(i.event, day, addDays(day, 1)))
              .sort(
                (a, b) =>
                  Number(b.event.all_day) - Number(a.event.all_day) || a.event.starts_at - b.event.starts_at
              );
            const outside = new Date(day).getMonth() !== month;
            const extra = dayItems.length - MONTH_MAX;
            return (
              <div
                className={
                  "cal-month-cell" + (outside ? " outside" : "") + (sameDay(day, now) ? " today" : "")
                }
                key={day}
              >
                <button
                  className="cal-month-num"
                  onClick={() => onPickDay(day)}
                  title={`Open ${fFullDay.format(new Date(day))}`}
                >
                  {fDayNum.format(new Date(day))}
                </button>
                <div className="cal-month-events">
                  {dayItems.slice(0, MONTH_MAX).map((item) =>
                    item.redacted ? (
                      <div
                        className="cal-mini cal-ev-busy"
                        key={item.event.id}
                        style={{ ["--cal-c" as string]: item.color }}
                        role="img"
                        aria-label={
                          item.event.all_day
                            ? "Busy, all day"
                            : `Busy, ${fmtTime(item.event.starts_at)} to ${fmtTime(item.event.ends_at)}`
                        }
                      >
                        <LockGlyph />
                        {!item.event.all_day && (
                          <span className="cal-mini-time">{fmtTime(item.event.starts_at)}</span>
                        )}
                        <span className="cal-mini-title">Busy</span>
                      </div>
                    ) : (
                      <button
                        className="cal-mini"
                        key={item.event.id}
                        style={{ ["--cal-c" as string]: item.color }}
                        onClick={() => onOpen(item)}
                        title={`${item.event.title}\n${fmtSpan(item.event)}\n${ownerLabel(item.calendar)}`}
                      >
                        <i className="cal-mini-dot" aria-hidden="true" />
                        {!item.event.all_day && (
                          <span className="cal-mini-time">{fmtTime(item.event.starts_at)}</span>
                        )}
                        <span className="cal-mini-title">{item.event.title}</span>
                      </button>
                    )
                  )}
                  {extra > 0 && (
                    <button className="cal-more" onClick={() => onPickDay(day)}>
                      +{extra} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── agenda ───────────────────────────────────────────────────── */

function AgendaList({
  days,
  items,
  now,
  onOpen,
}: {
  days: number[];
  items: VisibleEvent[];
  now: number;
  onOpen: (item: VisibleEvent) => void;
}) {
  const rows = days
    .map((day) => ({
      day,
      list: items
        .filter((i) => overlaps(i.event, day, addDays(day, 1)))
        .sort(
          (a, b) =>
            Number(b.event.all_day) - Number(a.event.all_day) || a.event.starts_at - b.event.starts_at
        ),
    }))
    .filter((r) => r.list.length > 0);

  if (!rows.length) {
    return (
      <div className="center-note">
        <p>Nothing scheduled in the next {AGENDA_DAYS} days.</p>
      </div>
    );
  }

  return (
    <div className="cal-agenda scroll-pane">
      {rows.map(({ day, list }) => (
        <section className="cal-agenda-day" key={day}>
          <h3 className={"cal-agenda-date" + (sameDay(day, now) ? " today" : "")}>
            <span className="cal-agenda-num">{fDayNum.format(new Date(day))}</span>
            <span className="cal-agenda-name">{fWeekdayLong.format(new Date(day))}</span>
            <span className="cal-agenda-month">{fDayMonth.format(new Date(day))}</span>
          </h3>
          <div className="cal-agenda-rows">
            {list.map((item) =>
              item.redacted ? (
                <div
                  className="cal-agenda-row cal-ev-busy"
                  key={item.event.id}
                  style={{ ["--cal-c" as string]: item.color }}
                  role="img"
                  aria-label={
                    item.event.all_day
                      ? "Busy, all day"
                      : `Busy, ${fmtTime(item.event.starts_at)} to ${fmtTime(item.event.ends_at)}`
                  }
                >
                  <span className="cal-agenda-time">{fmtSpan(item.event)}</span>
                  <span className="cal-agenda-title">
                    <LockGlyph /> Busy
                  </span>
                  <span className="cal-agenda-owner">{ownerLabel(item.calendar)}</span>
                </div>
              ) : (
                <button
                  className="cal-agenda-row"
                  key={item.event.id}
                  style={{ ["--cal-c" as string]: item.color }}
                  onClick={() => onOpen(item)}
                >
                  <span className="cal-agenda-time">{fmtSpan(item.event)}</span>
                  <span className="cal-agenda-title">{item.event.title}</span>
                  {item.event.location && (
                    <span className="cal-agenda-where">{item.event.location}</span>
                  )}
                  <span className="cal-agenda-owner">{ownerLabel(item.calendar)}</span>
                </button>
              )
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── the editor ───────────────────────────────────────────────── */

/** How long typing rests before an already-saved event writes itself. */
const AUTOSAVE_MS = 500;

/**
 * The event, edited beside the week it is in.
 *
 * This was a modal, which meant scheduling something while unable to see the
 * days on either side of it — the calendar equivalent of asking somebody to
 * pick a time with their eyes shut. As a panel the grid stays visible, stays
 * scrollable, and stays draggable: moving the block behind updates the two time
 * fields in front of you, because both are reading the same row.
 *
 * That reachability is also why an existing event no longer has a Save button.
 * A panel can be dismissed by clicking almost anything — the inspector takes
 * the same edge, and Escape is one key away — so holding typed changes hostage
 * to a button would make ordinary gestures lose work. An event that already
 * exists writes itself on a debounce. A *new* one does not: there is no row to
 * write into, creating it may also create it inside somebody's Google account,
 * and that is the one genuinely blocking step left here. So new events keep
 * their Create, and the moment they have an id they start behaving like the
 * rest.
 */
function EventEditor({
  editing,
  setEditing,
  onClose,
}: {
  editing: Editing;
  setEditing: (e: Editing | null) => void;
  onClose: () => void;
}) {
  const events = useStore((s) => s.events);
  const calendars = useStore((s) => s.calendars);
  const addEvent = useStore((s) => s.addEvent);
  const updateEvent = useStore((s) => s.updateEvent);
  const deleteEvent = useStore((s) => s.deleteEvent);
  const addLink = useStore((s) => s.addLink);
  const assign = useStore((s) => s.assign);

  const existing = editing.kind === "open" ? events.find((e) => e.id === editing.id) ?? null : null;
  const seed = editing.kind === "new" ? editing : null;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [calendarId, setCalendarId] = useState(existing?.calendar_id ?? seed?.calendar_id ?? "");
  const [allDay, setAllDay] = useState(!!(existing?.all_day ?? seed?.all_day));
  const [startDate, setStartDate] = useState(dateValue(existing?.starts_at ?? seed?.starts_at ?? Date.now()));
  const [startTime, setStartTime] = useState(timeValue(existing?.starts_at ?? seed?.starts_at ?? Date.now()));
  const [endDate, setEndDate] = useState(
    dateValue((existing?.ends_at ?? seed?.ends_at ?? Date.now()) - (allDay ? 1 : 0))
  );
  const [endTime, setEndTime] = useState(timeValue(existing?.ends_at ?? seed?.ends_at ?? Date.now()));
  const [location, setLocation] = useState(existing?.location ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const writableCals = useMemo(() => calendars.filter((c) => canWrite(c)), [calendars]);
  const home = calendars.find((c) => c.id === (existing?.calendar_id ?? calendarId));
  const readOnly = !!existing && !!home && !canWrite(home);

  /* Where this actually lands. Read for whichever calendar is currently
   * selected, because changing that select changes the answer — and the answer
   * belongs on screen before the click, not in the toast after it. */
  const [backing, setBacking] = useState<CalendarBacking | null>(null);
  useEffect(() => {
    let alive = true;
    if (!calendarId) {
      setBacking(null);
      return;
    }
    void backingFor(calendarId)
      .then((b) => alive && setBacking(b))
      .catch(() => alive && setBacking(null));
    return () => {
      alive = false;
    };
  }, [calendarId]);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  /* The panel outlives the click that opened it, and a sync or another window
   * can take the row away underneath it. Editing an event that is no longer
   * there — as a blank "New event", which is what the fallbacks above would
   * make of it — is worse than losing the panel. */
  const orphaned = editing.kind === "open" && !existing;
  useEffect(() => {
    if (orphaned) onClose();
  }, [orphaned, onClose]);

  function times(): { starts_at: number; ends_at: number } | null {
    if (allDay) {
      const s = startOfDay(fromParts(startDate, "00:00"));
      // Stored as a half-open span so a one-day event ends at the next midnight
      // and `overlaps` puts it on exactly one column.
      const e = addDays(startOfDay(fromParts(endDate, "00:00")), 1);
      return e > s ? { starts_at: s, ends_at: e } : null;
    }
    const s = fromParts(startDate, startTime);
    const e = fromParts(endDate, endTime);
    return e > s ? { starts_at: s, ends_at: e } : null;
  }

  /* How long this is, live. It is the thing people actually check after typing
   * two times, and reading it back beats making them do the subtraction — and
   * an end before its start is a state the form can be in, so it is drawn
   * rather than saved up for a toast. */
  const span = times();

  /* ── autosave, for a row that already exists ────────────────── */

  /** Everything typed here that the stored event does not already say. */
  const patch: Partial<CalendarEvent> = {};
  if (existing && !readOnly) {
    const clean = title.trim() || "(untitled)";
    if (clean !== existing.title) patch.title = clean;
    if (location !== existing.location) patch.location = location;
    if (description !== existing.description) patch.description = description;
    if ((allDay ? 1 : 0) !== existing.all_day) patch.all_day = allDay ? 1 : 0;
    if (calendarId && calendarId !== existing.calendar_id) patch.calendar_id = calendarId;
    // An end before its start is a state the form is allowed to be in; it is
    // simply not a state worth writing, so the times wait for a valid span.
    if (span) {
      if (span.starts_at !== existing.starts_at) patch.starts_at = span.starts_at;
      if (span.ends_at !== existing.ends_at) patch.ends_at = span.ends_at;
    }
  }
  const pending = useRef(patch);
  pending.current = patch;
  /** Deleted: nothing left to write into. */
  const settled = useRef(false);
  // A string, so the debounce re-arms when the *content* changes rather than on
  // every render — `patch` is a fresh object each time by construction.
  const dirtyKey = JSON.stringify(patch);
  const eventId = existing?.id ?? "";

  const flush = useCallback(async () => {
    const p = pending.current;
    if (settled.current || !eventId || !Object.keys(p).length) return;
    setSaving(true);
    try {
      // Spaces cannot edit a provider's copy yet, so an edit to a mirrored event
      // stays here rather than pretending to have travelled.
      await updateEvent(eventId, p);
    } catch (e) {
      toast.error("Could not save the event", e);
    } finally {
      setSaving(false);
    }
  }, [eventId, updateEvent]);

  useEffect(() => {
    if (dirtyKey === "{}") return;
    const t = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [dirtyKey, flush]);

  /* And once more on the way out, for the half-second that never elapsed.
     Not `flush`: by then there is no component left to tell that it is saving,
     and the write has to happen regardless. */
  useEffect(() => {
    if (!eventId) return;
    return () => {
      const p = pending.current;
      if (settled.current || !Object.keys(p).length) return;
      void updateEvent(eventId, p).catch((e) => toast.error("Could not save the event", e));
    };
  }, [eventId, updateEvent]);

  /* ── creating one ───────────────────────────────────────────── */

  async function create() {
    if (!span) {
      toast.error("Check the times", "The end has to come after the start.");
      return;
    }
    if (!calendarId) {
      toast.error("Pick a calendar", "An event has to live on a calendar you can write to.");
      return;
    }
    setBusy(true);
    try {
      const created = await addEvent({
        title: title.trim() || "(untitled)",
        location,
        description,
        all_day: allDay ? 1 : 0,
        calendar_id: calendarId,
        ...span,
      });
      // Stay open on the saved row: connections need an id, so this is the
      // first moment the panel below can do anything at all — and from here on
      // the fields save themselves.
      setEditing({ kind: "open", id: created.id });

      const target = calendars.find((c) => c.id === calendarId);
      const pushed = target
        ? await pushEventUpstream(created, target)
        : { target: "local" as SyncTarget, error: "" };
      if (pushed.error) {
        // The event exists; only the trip upstream failed, and that is a
        // warning rather than the error the whole save would be.
        toast.warn(`Created in ${config().brand} only`, pushed.error);
      } else if (pushed.target !== "local") {
        toast.success("Event created", `Also saved to ${providerLabel(pushed.target)}.`);
      } else {
        toast.success("Event created", "Link it to the work it is about below.");
      }
    } catch (e) {
      toast.error("Could not save the event", e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    const ok = await confirmAction({
      title: `Delete “${existing.title}”?`,
      body: "Its links and assignments go with it.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    // Snapshot the graph first: deleteEvent purges every link and assignment
    // touching the row, so undo has to be able to redraw them itself.
    const snapshot = { ...existing };
    const ref: EntityRef = { type: "event", id: existing.id };
    const links = connectionsFor(ref);
    const assigned = assigneesOf(ref);

    try {
      await deleteEvent(existing.id);
    } catch (e) {
      toast.error("Could not delete the event", e);
      return;
    }
    settled.current = true;
    onClose();

    toast.show({
      kind: "success",
      title: `Deleted “${snapshot.title}”`,
      action: {
        label: "Undo",
        run: () => {
          void (async () => {
            try {
              const again = await addEvent({ ...snapshot, calendar_id: snapshot.calendar_id });
              const back: EntityRef = { type: "event", id: again.id };
              for (const c of links) {
                if (c.direction === "out") await addLink(back, c.other, c.link.kind, c.link.note, c.link.created_by);
                else await addLink(c.other, back, c.link.kind, c.link.note, c.link.created_by);
              }
              for (const a of assigned) await assign(a.subject, back, a.role);
            } catch (e) {
              toast.error("Could not restore the event", e);
            }
          })();
        },
      },
    });
  }

  const destTarget: SyncTarget = backing?.target ?? "local";
  const day = span?.starts_at ?? existing?.starts_at ?? seed?.starts_at ?? Date.now();

  return (
    <SidePanel
      title={existing ? "Event" : "New event"}
      /* Which day you are editing, said once at the top — the grid beside the
         panel is showing it, and the two date fields below are for changing it
         rather than for reading it back. */
      subtitle={fFullDay.format(new Date(day))}
      onClose={onClose}
      storageKey="event"
      className="cal-event-panel"
      footer={
        existing ? (
          <>
            {!readOnly && (
              <button
                className="btn danger cal-event-del"
                onClick={() => void remove()}
                disabled={busy}
              >
                Delete
              </button>
            )}
            <span className="cal-event-state" aria-live="polite">
              {readOnly ? "Read-only" : saving ? "Saving…" : "Saved as you type"}
            </span>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => void create()}
              disabled={busy || !span}
              title={span ? undefined : "The end has to come after the start."}
            >
              {busy ? "Saving…" : "Create"}
            </button>
          </>
        )
      }
    >
      <div className="cal-editor">
        <div className="field">
          <span className="field-label">Title</span>
          <input
            className="cal-title-input"
            data-autofocus
            ref={titleRef}
            value={title}
            disabled={readOnly}
            placeholder="What is it?"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Enter still commits a new event; an existing one has nothing to
              // commit, so it is left alone.
              if (e.key === "Enter" && !readOnly && !existing) void create();
            }}
          />
        </div>

        <div className="row fields-row">
          <div className="field">
            <span className="field-label">Calendar</span>
            <select
              value={calendarId}
              disabled={readOnly}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              {readOnly && home && <option value={home.id}>{home.name}</option>}
              {!readOnly &&
                writableCals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {ownerLabel(c)} · {c.name}
                  </option>
                ))}
            </select>
          </div>
          <label className="field checkbox-field cal-allday-toggle">
            <input
              type="checkbox"
              checked={allDay}
              disabled={readOnly}
              onChange={(e) => setAllDay(e.target.checked)}
            />
            <span>All day</span>
          </label>
        </div>

        {/* A calendar that is only a calendar here and one that reaches an
         * account are different promises, and which one you made should be
         * readable before you commit rather than guessable afterwards. */}
        {!readOnly && (
          <p className={"cal-dest" + (destTarget === "local" ? " local" : "")} aria-live="polite">
            <span className="cal-dest-tag">{destinationLabel(destTarget)}</span>
            <span className="cal-dest-note">{destinationNote(backing)}</span>
          </p>
        )}

        {/* A date and a time is two controls; two pairs of them across a 420px
            panel is four, so this row stacks rather than scrolling sideways. */}
        <div className="row fields-row cal-when-row">
          <div className="field">
            <span className="field-label">Starts</span>
            <div className="cal-when">
              <input
                type="date"
                aria-label="Start date"
                value={startDate}
                disabled={readOnly}
                onChange={(e) => setStartDate(e.target.value)}
              />
              {!allDay && (
                <input
                  type="time"
                  aria-label="Start time"
                  value={startTime}
                  disabled={readOnly}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              )}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Ends</span>
            <div className="cal-when">
              <input
                type="date"
                aria-label="End date"
                value={endDate}
                disabled={readOnly}
                onChange={(e) => setEndDate(e.target.value)}
              />
              {!allDay && (
                <input
                  type="time"
                  aria-label="End time"
                  value={endTime}
                  disabled={readOnly}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              )}
            </div>
          </div>
        </div>

        <p className={"cal-span" + (span ? "" : " bad")} aria-live="polite">
          {span
            ? allDay
              ? `All day · ${Math.round((span.ends_at - span.starts_at) / 86_400_000)} day${
                  span.ends_at - span.starts_at > 86_400_000 ? "s" : ""
                }`
              : fmtLen(span.ends_at - span.starts_at)
            : "The end has to come after the start."}
        </p>

        <div className="field">
          <span className="field-label">Location</span>
          <input
            value={location}
            disabled={readOnly}
            placeholder="Room, link, anywhere"
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>

        <div className="field">
          <span className="field-label">Description</span>
          <textarea
            rows={3}
            value={description}
            disabled={readOnly}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {readOnly && home && (
          <p className="cal-readonly-note">
            {ownerLabel(home)} shared this with you read-only, so it opens but does not edit.
          </p>
        )}

        {/* No heading of our own here. The connections panel draws "Assigned"
            and "Connections" itself, and a section titled "Connections" above a
            block titled "Connections" is the same word twice in the same type —
            the space is what says a new thing has started. */}
        <div className="cal-connections">
          {existing ? (
            <EventConnections anchor={{ type: "event", id: existing.id }} />
          ) : (
            <p className="cal-connections-hint">Save it and you can link it to a task or an agent.</p>
          )}
        </div>
      </div>
    </SidePanel>
  );
}

/* ── connections ──────────────────────────────────────────────── */

function EventConnections({ anchor }: { anchor: EntityRef }) {
  if (ConnectionsPanelImpl) return <ConnectionsPanelImpl anchor={anchor} />;
  return <FallbackConnections anchor={anchor} />;
}

/**
 * What renders until the graph work lands: the same information, without the
 * affordances that file will bring. Kept small on purpose — it is a stand-in,
 * not a second implementation to keep in sync.
 */
function FallbackConnections({ anchor }: { anchor: EntityRef }) {
  const links = useStore((s) => s.links);
  const assignments = useStore((s) => s.assignments);
  const removeLink = useStore((s) => s.removeLink);
  const [picking, setPicking] = useState(false);

  const connections = useMemo(
    () => connectionsFor(anchor),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- links is what connectionsFor reads
    [links, anchor.type, anchor.id]
  );
  const people = useMemo(
    () => assigneesOf(anchor),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assignments is what assigneesOf reads
    [assignments, anchor.type, anchor.id]
  );

  return (
    <div className="cal-links">
      <p className="cal-connections-hint">
        An event is an entity: link it to the task it is about, or put an agent on it to prepare.
      </p>
      {connections.length === 0 && people.length === 0 && (
        <p className="cal-links-empty">Not connected to anything yet.</p>
      )}
      {connections.map((c) => (
        <div className="cal-link-row" key={c.link.id}>
          <span className="cal-link-kind">{c.label}</span>
          <EntityChip ref={c.other} size="sm" onRemove={() => void removeLink(c.link.id)} />
        </div>
      ))}
      {people.map((a) => (
        <div className="cal-link-row" key={a.assignment.id}>
          <span className="cal-link-kind">{a.roleLabel.toLowerCase()}</span>
          <EntityChip ref={a.subject} size="sm" />
        </div>
      ))}
      {LinkPickerImpl && (
        <button className="btn tiny" onClick={() => setPicking(true)}>
          ＋ Link something
        </button>
      )}
      {picking && LinkPickerImpl && <LinkPickerImpl anchor={anchor} onClose={() => setPicking(false)} />}
    </div>
  );
}
