/**
 * Calendar management: the upstream accounts Spaces mirrors, the calendars
 * themselves, and — the part that actually matters — how much of each one
 * everybody else gets to see.
 *
 * Two things shape this panel:
 *
 *  1. It never pretends the desktop can do OAuth. Tokens live in the paired
 *     web workspace and `hasCalendarBridge()` is the only honest signal that a
 *     connect flow could even start, so with nothing paired the panel explains
 *     that in prose instead of offering a button guaranteed to fail. Locally
 *     created calendars are the case that runs today, so they are the case the
 *     layout is built around.
 *  2. Access is explained where it is chosen. `busy` is what makes overlaying
 *     someone else's week safe, and it is only safe if people understand it
 *     *before* they pick it — so every tier carries a sentence in the control
 *     itself rather than a tooltip discovered afterwards.
 */
import { useId, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useStore } from "../store";
import { useTheme } from "../themeStore";
import { avatarColor, normalizeHex } from "../themes";
import type { ThemeSpec } from "../themes";
import { describeEntity, KIND_BY_TYPE } from "../entities";
import {
  LOCAL_MEMBER, addDays, calendarColor, hasCalendarBridge, ownerLabel,
  startOfDay, syncCalendars,
} from "../calendars";
import * as calendarApi from "../calendars";
import { confirmAction, toast } from "../toast";
import { timeAgo } from "../github";
import type {
  Calendar, CalendarAccess, CalendarAccount, CalendarOwnerType, CalendarProvider,
  CalendarShare, EntityRef,
} from "../types";
import "./calendarsettings.css";

/* ── vocabulary ───────────────────────────────────────────────── */

const PROVIDERS: Record<CalendarProvider, { label: string; mark: string }> = {
  google: { label: "Google Calendar", mark: "G" },
  microsoft: { label: "Microsoft 365", mark: "M" },
  hq: { label: "Spaces", mark: "◷" },
};

/** The providers a pairing can actually run a sign-in for. */
const CONNECTABLE: CalendarProvider[] = ["google", "microsoft"];

const ACCOUNT_STATUS: Record<CalendarAccount["status"], { label: string; tone: string }> = {
  ok: { label: "Connected", tone: "ok" },
  expired: { label: "Sign-in expired", tone: "warn" },
  error: { label: "Error", tone: "bad" },
};

type Visibility = Calendar["visibility"];

/**
 * The default-visibility ladder, in prose. `busy` gets the longest line on
 * purpose: it is the tier people reach for when they want to be helpful
 * without being exposed, and "busy" alone does not say how little it shares.
 */
const VISIBILITY: { id: Visibility; label: string; blurb: string }[] = [
  {
    id: "private",
    label: "Private",
    blurb: "Nobody else sees it — not the events, not the free/busy times, not that the calendar exists.",
  },
  {
    id: "busy",
    label: "Busy only",
    blurb:
      "Others see when you are busy and nothing else: start and end times, drawn as “Busy”. No titles, " +
      "no locations, no attendees, no notes — the details are stripped before the event reaches them, " +
      "not just hidden on screen.",
  },
  {
    id: "read",
    label: "Read",
    blurb: "Others see the whole event — title, location, attendees, notes — but cannot change anything.",
  },
  {
    id: "write",
    label: "Write",
    blurb: "Others see everything and can add, edit and delete events on this calendar.",
  },
];

const ACCESS_LABEL: Record<CalendarAccess, string> = {
  busy: "Busy only — times, no details",
  read: "Read — full details",
  write: "Write — full details, can edit",
};

/** Compact form for the row's summary, where there is no space for a sentence. */
const ACCESS_SHORT: Record<CalendarAccess, string> = {
  busy: "busy only",
  read: "read",
  write: "write",
};

/** New shares start here: the tier that cannot leak anything by accident. */
const DEFAULT_SHARE: CalendarAccess = "busy";

function ownerBlurb(type: CalendarOwnerType): string {
  switch (type) {
    case "member":
      return "Yours. You are the only one who can see or write to it until you share it below.";
    case "workspace":
      return "The workspace's own calendar — the shared one the assistant books into on everybody's behalf.";
    case "team":
      return "The team's calendar. Every agent on that team inherits whatever the team is granted.";
    case "agent":
      return "That agent's own calendar, for a bot that keeps a schedule of its own.";
  }
}

/* ── owner encoding ───────────────────────────────────────────── */

/** `owner_type:owner_id`, so one <select> can carry both columns. */
function encodeOwner(owner_type: CalendarOwnerType, owner_id: string): string {
  return `${owner_type}:${owner_type === "workspace" ? "" : owner_id}`;
}

function decodeOwner(value: string): { owner_type: CalendarOwnerType; owner_id: string } {
  const cut = value.indexOf(":");
  const owner_type = (cut < 0 ? value : value.slice(0, cut)) as CalendarOwnerType;
  return { owner_type, owner_id: cut < 0 ? "" : value.slice(cut + 1) };
}

function ownerName(type: CalendarOwnerType, id: string): string {
  if (type === "workspace") return "Workspace";
  if (type === "member") return !id || id === LOCAL_MEMBER.id ? "You" : id;
  const info = describeEntity({ type, id });
  return info.exists ? info.title : id || "Unknown";
}

/* ── color ────────────────────────────────────────────────────── */

/** The eight identity colors every theme defines, as live token references. */
const PALETTE: string[] = Array.from({ length: 8 }, (_, i) => `var(--avatar-${i})`);

const AVATAR_TOKEN = /^var\(--avatar-([0-7])\)$/;

/**
 * A concrete hex for `<input type="color">`, which cannot swallow a `var()`.
 * Everything else in the UI paints with the stored value itself, so switching
 * themes still recolors a palette-chosen calendar without touching the row.
 */
function resolveHex(value: string, theme: ThemeSpec, fallbackId: string): string {
  const token = AVATAR_TOKEN.exec(value.trim());
  if (token) return theme.avatars[Number(token[1]) % theme.avatars.length];
  return normalizeHex(value) || avatarColor(fallbackId, theme);
}

/* ── the connect flow ─────────────────────────────────────────── */

type ConnectFlow = (provider: CalendarProvider) => Promise<unknown>;

/**
 * calendars.ts keeps the bridge itself private and the actions it declares
 * today are all event-level, so there is no exported way to *complete* a
 * handshake from here. If a build ships an opener we hand the flow to it; if
 * it does not, the honest answer is that the sign-in belongs to the paired
 * workspace and this panel can only re-read what that workspace wrote.
 */
function connectFlow(): ConnectFlow | null {
  const api = calendarApi as unknown as { connectAccount?: ConnectFlow };
  return typeof api.connectAccount === "function" ? api.connectAccount : null;
}

/* ── the panel ────────────────────────────────────────────────── */

export function CalendarSettings() {
  return (
    <>
      <AccountsSection />
      <CalendarsSection />
    </>
  );
}

/* ── 1. connected accounts ────────────────────────────────────── */

function AccountsSection() {
  const accounts = useStore((s) => s.calendarAccounts);
  const refreshAll = useStore((s) => s.refreshAll);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState<CalendarProvider | null>(null);

  // The pairing registers its bridge once at startup, so reading the flag in
  // render is enough — it does not flip while the panel is on screen.
  const paired = hasCalendarBridge();

  const sync = async () => {
    setSyncing(true);
    try {
      // Two months either side of today: enough that whichever week or month
      // the calendar view lands on is already populated.
      const from = addDays(startOfDay(Date.now()), -30);
      const res = await syncCalendars(from, addDays(from, 90));
      if (!res.ok) toast.warn("Nothing to sync", res.reason);
      else if (!res.changed) toast.info("Already up to date", res.reason || "No events changed.");
      else toast.success(`Synced ${res.changed} event${res.changed === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error("Sync failed", e);
    } finally {
      setSyncing(false);
    }
  };

  const connect = async (provider: CalendarProvider) => {
    const open = connectFlow();
    if (!open) {
      toast.info(
        "Start the sign-in in your workspace",
        `This desktop is paired, but it has no entry point for the ${PROVIDERS[provider].label} ` +
          "screen. Add the account in the paired workspace, then use Reload accounts here."
      );
      return;
    }
    setConnecting(provider);
    try {
      await open(provider);
      await refreshAll();
      toast.success(`${PROVIDERS[provider].label} connected`, "Sync to pull its events in.");
    } catch (e) {
      toast.error(`Could not connect ${PROVIDERS[provider].label}`, e);
    } finally {
      setConnecting(null);
    }
  };

  const reload = async () => {
    try {
      await refreshAll();
      toast.info("Accounts reloaded");
    } catch (e) {
      toast.error("Could not reload accounts", e);
    }
  };

  return (
    <section className="dash-card cs-card">
      <h3>
        Connected accounts
        <span className="cs-count">{accounts.length}</span>
        {paired && (
          <span className="cs-head-actions">
            <button type="button" className="btn cs-btn-sm" onClick={() => void reload()}>
              Reload accounts
            </button>
            <button
              type="button"
              className="btn cs-btn-sm"
              onClick={() => void sync()}
              disabled={syncing}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </span>
        )}
      </h3>

      <p className="cs-hint">
        Signing in happens in your paired web workspace, never on this machine. That workspace holds
        the OAuth token and answers Spaces's requests for calendars and events; nothing on this desktop
        can reach your Google or Microsoft account on its own, and no token is ever stored here.
      </p>

      {paired ? (
        <div className="cs-connect" role="group" aria-label="Connect a calendar account">
          <span className="cs-connect-label">Connect a calendar</span>
          {CONNECTABLE.map((id) => (
            <button
              key={id}
              type="button"
              className="btn"
              onClick={() => void connect(id)}
              disabled={connecting !== null}
            >
              <span className="cs-mark" aria-hidden="true">{PROVIDERS[id].mark}</span>
              {connecting === id ? "Opening…" : PROVIDERS[id].label}
            </button>
          ))}
        </div>
      ) : (
        <div className="cs-note">
          <div className="cs-note-title">No workspace is paired with this desktop</div>
          <p>
            There is nothing for a Connect button to hand a sign-in to, so this panel does not show
            one. Pair a web workspace and Google and Microsoft appear here.
          </p>
          <p>
            Everything below still works. Calendars you create in Spaces live in this machine's own
            database — events, colors, ownership, sharing and the calendar view all run against them
            exactly as they would against a mirrored account. Nothing is waiting on a pairing.
          </p>
        </div>
      )}

      {accounts.length > 0 && (
        <div className="cs-accounts">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </div>
      )}

      {!paired && accounts.length > 0 && (
        <p className="cs-hint cs-hint-warn">
          These accounts were connected by a workspace that is not paired right now, so they cannot
          refresh. Their events stay on the grid exactly as they were last synced.
        </p>
      )}

      {paired && accounts.length === 0 && (
        <div className="cs-empty">No accounts connected yet.</div>
      )}
    </section>
  );
}

function AccountRow({ account }: { account: CalendarAccount }) {
  const calendars = useStore((s) => s.calendars);
  const provider = PROVIDERS[account.provider] ?? PROVIDERS.hq;
  const status = ACCOUNT_STATUS[account.status] ?? ACCOUNT_STATUS.error;
  const mirrored = calendars.filter((c) => c.account_id === account.id).length;

  return (
    <div className="cs-acct">
      <span className="cs-mark cs-acct-mark" aria-hidden="true">{provider.mark}</span>
      <div className="cs-acct-id">
        <div className="cs-acct-name">{account.display_name || account.external_id || "Unnamed account"}</div>
        <div className="cs-acct-meta">
          {provider.label}
          <span className="cs-dot" aria-hidden="true">·</span>
          {ownerName(account.owner_type, account.owner_id)}
          <span className="cs-dot" aria-hidden="true">·</span>
          {mirrored} calendar{mirrored === 1 ? "" : "s"}
        </div>
        {account.last_error && account.status !== "ok" && (
          <div className="cs-acct-error">{account.last_error}</div>
        )}
      </div>
      <span className="cs-acct-sync">
        {account.last_sync_at ? `synced ${timeAgo(account.last_sync_at)}` : "never synced"}
      </span>
      <span className={`cs-pill cs-pill-${status.tone}`}>{status.label}</span>
    </div>
  );
}

/* ── 2. the calendars ─────────────────────────────────────────── */

function CalendarsSection() {
  const calendars = useStore((s) => s.calendars);
  const addCalendar = useStore((s) => s.addCalendar);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(encodeOwner("member", LOCAL_MEMBER.id));
  const nameId = useId();
  const ownerId = useId();

  const sorted = useMemo(
    () => [...calendars].sort((a, b) => a.name.localeCompare(b.name)),
    [calendars]
  );

  const cancel = () => {
    setCreating(false);
    setName("");
  };

  const create = async () => {
    const title = name.trim();
    if (!title) return;
    try {
      const cal = await addCalendar({
        name: title,
        // No account backs it: Spaces owns the row outright, so no sync can
        // overwrite or delete what you put on it. Its events are written with
        // source "hq" by addEvent's own default.
        account_id: "",
        external_id: "",
        ...decodeOwner(owner),
        visibility: "private",
        writable: 1,
        enabled: 1,
      });
      cancel();
      setOpenId(cal.id);
      toast.success(`Created “${title}”`, "It is private until you share it.");
    } catch (e) {
      toast.error("Could not create the calendar", e);
    }
  };

  return (
    <section className="dash-card cs-card">
      <h3>
        Calendars
        <span className="cs-count">{calendars.length}</span>
        {/* Hidden while the form is open: the form carries its own Cancel two
            lines below, and two of them side by side is a coin toss. */}
        {!creating && (
          <span className="cs-head-actions">
            <button type="button" className="btn cs-btn-sm" onClick={() => setCreating(true)}>
              New calendar
            </button>
          </span>
        )}
      </h3>

      {creating && (
        <form
          className="cs-new"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
        >
          <div className="cs-new-fields">
            <div className="cs-field">
              <label className="cs-field-label" htmlFor={nameId}>Name</label>
              <input
                id={nameId}
                autoFocus
                value={name}
                placeholder="Focus time"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="cs-field">
              <label className="cs-field-label" htmlFor={ownerId}>Owner</label>
              <select id={ownerId} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <OwnerOptions />
              </select>
            </div>
          </div>
          <p className="cs-hint">{ownerBlurb(decodeOwner(owner).owner_type)}</p>
          <div className="cs-new-actions">
            <button type="button" className="btn" onClick={cancel}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!name.trim()}>
              Create calendar
            </button>
          </div>
        </form>
      )}

      {sorted.length === 0 ? (
        <div className="cs-empty">
          No calendars yet. Create one — it lives in this Spaces's database and works whether or not a
          workspace is ever paired.
        </div>
      ) : (
        <div className="cs-cals">
          {sorted.map((cal) => (
            <CalendarRow
              key={cal.id}
              cal={cal}
              expanded={openId === cal.id}
              onToggle={() => setOpenId(openId === cal.id ? null : cal.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Every owner a calendar can be handed to, grouped so long rosters stay readable. */
function OwnerOptions({ dangling }: { dangling?: { value: string; label: string } }) {
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  return (
    <>
      <option value={encodeOwner("member", LOCAL_MEMBER.id)}>You</option>
      <option value={encodeOwner("workspace", "")}>Workspace — the assistant's own</option>
      {teams.length > 0 && (
        <optgroup label="Teams">
          {teams.map((t) => (
            <option key={t.id} value={encodeOwner("team", t.id)}>{t.name}</option>
          ))}
        </optgroup>
      )}
      {agents.length > 0 && (
        <optgroup label="Agents">
          {agents.map((a) => (
            <option key={a.id} value={encodeOwner("agent", a.id)}>{a.name}</option>
          ))}
        </optgroup>
      )}
      {dangling && <option value={dangling.value}>{dangling.label}</option>}
    </>
  );
}

function CalendarRow({
  cal,
  expanded,
  onToggle,
}: {
  cal: Calendar;
  expanded: boolean;
  onToggle: () => void;
}) {
  const updateCalendar = useStore((s) => s.updateCalendar);
  const deleteCalendar = useStore((s) => s.deleteCalendar);
  const accounts = useStore((s) => s.calendarAccounts);
  const shares = useStore((s) => s.calendarShares);
  const theme = useTheme((s) => s.theme);
  const bodyId = useId();
  const ownerFieldId = useId();

  // Held only while the field is being edited, so a rename landing from a sync
  // still shows through instead of being pinned by stale local state.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? cal.name;

  const account = accounts.find((a) => a.id === cal.account_id) ?? null;
  const mirrored = !!cal.account_id;
  const shareCount = shares.filter((s) => s.calendar_id === cal.id).length;
  const swatch = calendarColor(cal);

  const ownerValue = encodeOwner(cal.owner_type, cal.owner_id);
  const ownerKnown =
    cal.owner_type === "workspace" ||
    (cal.owner_type === "member" && cal.owner_id === LOCAL_MEMBER.id) ||
    describeEntity({ type: cal.owner_type, id: cal.owner_id }).exists;

  const patch = async (p: Partial<Calendar>, what: string) => {
    try {
      await updateCalendar(cal.id, p);
    } catch (e) {
      toast.error(`Could not change ${what}`, e);
    }
  };

  const commitName = () => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (!next || next === cal.name) return;
    void patch({ name: next }, "the name");
  };

  const remove = async () => {
    // Read once, at the moment of asking: subscribing to the event window
    // would re-render every calendar row each time the grid pages.
    const loaded = useStore.getState().events.filter((e) => e.calendar_id === cal.id).length;
    const ok = await confirmAction({
      title: `Delete “${cal.name}”?`,
      body:
        `Its events are deleted with it${
          loaded ? ` — ${loaded} in the window you have open, plus every one outside it` : ""
        }, along with the list of who it was shared with. ` +
        (mirrored
          ? "Only Spaces's copy is removed; the calendar stays in the upstream account and a later sync would mirror it back."
          : "This calendar exists only here, so nothing can bring it back."),
      confirmLabel: "Delete calendar",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCalendar(cal.id);
      toast.success(`Deleted “${cal.name}”`);
    } catch (e) {
      toast.error("Could not delete the calendar", e);
    }
  };

  const state =
    cal.visibility === "private"
      ? shareCount
        ? `Private · ${shareCount} shared`
        : "Private"
      : `Everyone: ${ACCESS_SHORT[cal.visibility]}${shareCount ? ` · +${shareCount}` : ""}`;

  return (
    <div className={"cs-cal" + (expanded ? " open" : "")}>
      <div className="cs-cal-head">
        <button
          type="button"
          className="cs-cal-dot"
          style={{ background: swatch } as CSSProperties}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`Change the color of ${cal.name}`}
          onClick={onToggle}
        />

        <input
          className="cs-cal-name"
          aria-label={`Name of the calendar currently called ${cal.name}`}
          value={name}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
        />

        <span className="cs-badges">
          {mirrored && (
            <span className="cs-pill" title={`Mirrored from ${account?.display_name || "an account"}`}>
              {PROVIDERS[account?.provider ?? "hq"].label}
            </span>
          )}
          {!cal.writable && <span className="cs-pill">read-only</span>}
          {!cal.enabled && <span className="cs-pill">hidden</span>}
        </span>

        <label className="cs-sr" htmlFor={ownerFieldId}>Owner of {cal.name}</label>
        <select
          id={ownerFieldId}
          className="cs-cal-owner"
          value={ownerValue}
          onChange={(e) => void patch(decodeOwner(e.target.value), "the owner")}
        >
          <OwnerOptions
            dangling={
              ownerKnown ? undefined : { value: ownerValue, label: `${ownerLabel(cal)} (missing)` }
            }
          />
        </select>

        <button
          type="button"
          className="cs-disclose"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`Color and sharing for ${cal.name} — currently ${state}`}
          onClick={onToggle}
        >
          <span className="cs-disclose-text">{state}</span>
          <span className="cs-caret" aria-hidden="true">▾</span>
        </button>

        <button
          type="button"
          className="icon-btn cs-del"
          aria-label={`Delete ${cal.name}`}
          onClick={() => void remove()}
        >
          ✕
        </button>
      </div>

      {expanded && (
        <div className="cs-cal-body" id={bodyId}>
          <p className="cs-owner-line">
            <strong>{ownerLabel(cal)}</strong> — {ownerBlurb(cal.owner_type)}
          </p>

          <Block title="Color" hint="Theme colors follow whatever palette you are wearing; a custom one stays put.">
            <ColorChoice cal={cal} theme={theme} onPick={(color) => void patch({ color }, "the color")} />
          </Block>

          <Block title="This calendar" hint="Whether it is drawn on the grid, and whether Spaces may write to it.">
            <div className="cs-toggles">
              <label className="cs-toggle">
                <input
                  type="checkbox"
                  checked={!!cal.enabled}
                  onChange={(e) => void patch({ enabled: e.target.checked ? 1 : 0 }, "visibility on the grid")}
                />
                <span>Draw it in the calendar view</span>
              </label>

              {mirrored ? (
                <span className="cs-toggle-static">
                  {cal.writable
                    ? "The account says you may edit this calendar."
                    : "The account says this calendar is read-only, so Spaces will not write to it."}
                </span>
              ) : (
                <label className="cs-toggle">
                  <input
                    type="checkbox"
                    checked={!!cal.writable}
                    onChange={(e) => void patch({ writable: e.target.checked ? 1 : 0 }, "editability")}
                  />
                  <span>Allow events to be added or edited</span>
                </label>
              )}
            </div>
          </Block>

          <Block
            title="Who can see it"
            hint="The default for everyone in the workspace who has no share of their own below."
          >
            <VisibilityChoice cal={cal} onPick={(visibility) => void patch({ visibility }, "who can see it")} />
          </Block>

          <Block
            title="Shared with"
            hint={`New shares start at “${ACCESS_LABEL.busy}” — raise one deliberately when you mean to.`}
          >
            <ShareList cal={cal} />
          </Block>
        </div>
      )}
    </div>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="cs-block">
      <div className="cs-block-head">
        <span className="cs-block-title">{title}</span>
        {hint && <span className="cs-block-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── color ────────────────────────────────────────────────────── */

function ColorChoice({
  cal,
  theme,
  onPick,
}: {
  cal: Calendar;
  theme: ThemeSpec;
  onPick: (color: string) => void;
}) {
  const group = `cs-color-${cal.id}`;
  const custom = !!cal.color && !AVATAR_TOKEN.test(cal.color);
  const hex = resolveHex(cal.color, theme, cal.owner_id || cal.id);

  return (
    <div className="cs-colors" role="group" aria-label={`Color for ${cal.name}`}>
      <label className="cs-swatch" title="Match the owner's identity color">
        <input
          type="radio"
          className="cs-sr"
          name={group}
          checked={!cal.color}
          onChange={() => onPick("")}
        />
        <span className="cs-swatch-dot cs-swatch-auto" aria-hidden="true">A</span>
        <span className="cs-sr">Automatic — match the owner's identity color</span>
      </label>

      {PALETTE.map((value, i) => (
        <label key={value} className="cs-swatch">
          <input
            type="radio"
            className="cs-sr"
            name={group}
            checked={cal.color === value}
            onChange={() => onPick(value)}
          />
          <span
            className="cs-swatch-dot"
            style={{ background: value } as CSSProperties}
            aria-hidden="true"
          />
          <span className="cs-sr">Theme color {i + 1}</span>
        </label>
      ))}

      <label className={"cs-swatch cs-swatch-custom" + (custom ? " on" : "")}>
        {/* Unset, not transparent: an inline background would beat the
            stylesheet's spectrum and leave a blank hole. */}
        <span
          className="cs-swatch-dot"
          style={custom ? ({ background: cal.color } as CSSProperties) : undefined}
          aria-hidden="true"
        />
        <span className="cs-sr">Custom color</span>
        <input
          type="color"
          className="cs-color-input"
          value={hex}
          onChange={(e) => onPick(normalizeHex(e.target.value) || "")}
        />
      </label>
    </div>
  );
}

/* ── 3. sharing ───────────────────────────────────────────────── */

function VisibilityChoice({
  cal,
  onPick,
}: {
  cal: Calendar;
  onPick: (v: Visibility) => void;
}) {
  const group = `cs-vis-${cal.id}`;
  return (
    <div className="cs-tiers" role="radiogroup" aria-label={`Default visibility for ${cal.name}`}>
      {VISIBILITY.map((tier) => (
        <label
          key={tier.id}
          className={"cs-tier" + (cal.visibility === tier.id ? " on" : "") + (tier.id === "busy" ? " cs-tier-busy" : "")}
        >
          <input
            type="radio"
            name={group}
            checked={cal.visibility === tier.id}
            onChange={() => onPick(tier.id)}
          />
          <span className="cs-tier-body">
            <span className="cs-tier-label">{tier.label}</span>
            <span className="cs-tier-blurb">{tier.blurb}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ShareList({ cal }: { cal: Calendar }) {
  const shares = useStore((s) => s.calendarShares);
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const setCalendarShare = useStore((s) => s.setCalendarShare);
  const addId = useId();

  const mine = shares.filter((s) => s.calendar_id === cal.id);
  const taken = new Set(mine.map((s) => `${s.subject_type}:${s.subject_id}`));

  // The owner already has write access by definition, so offering to share a
  // team's calendar back with that same team would only look like a setting
  // that does nothing.
  const isOwner = (type: CalendarShare["subject_type"], id: string) =>
    cal.owner_type === type && cal.owner_id === id;

  const candidates = [
    ...teams
      .filter((t) => !taken.has(`team:${t.id}`) && !isOwner("team", t.id))
      .map((t) => ({ value: `team:${t.id}`, label: t.name, group: "Teams" })),
    ...agents
      .filter((a) => !taken.has(`agent:${a.id}`) && !isOwner("agent", a.id))
      .map((a) => ({ value: `agent:${a.id}`, label: a.name, group: "Agents" })),
  ];

  const set = async (ref: EntityRef, access: CalendarAccess | null, who: string) => {
    try {
      await setCalendarShare(cal.id, ref, access);
    } catch (e) {
      toast.error(access ? `Could not share with ${who}` : `Could not stop sharing with ${who}`, e);
    }
  };

  return (
    <div className="cs-shares">
      {mine.length === 0 ? (
        <div className="cs-empty cs-empty-inline">
          Nobody has a share of their own. Everyone gets the default above.
        </div>
      ) : (
        mine.map((share) => {
          const ref: EntityRef = { type: share.subject_type, id: share.subject_id };
          const info = describeEntity(ref);
          const kind = KIND_BY_TYPE[share.subject_type];
          const who = info.exists ? info.title : share.subject_id;
          return (
            <div key={`${share.subject_type}:${share.subject_id}`} className="cs-share">
              <span className="cs-share-glyph" style={{ color: kind.tone } as CSSProperties} aria-hidden="true">
                {kind.glyph}
              </span>
              <span className={"cs-share-name" + (info.exists ? "" : " gone")}>{who}</span>
              <select
                className="cs-share-access"
                aria-label={`Access for ${who}`}
                value={share.access}
                onChange={(e) => void set(ref, e.target.value as CalendarAccess, who)}
              >
                {(Object.keys(ACCESS_LABEL) as CalendarAccess[]).map((a) => (
                  <option key={a} value={a}>{ACCESS_LABEL[a]}</option>
                ))}
              </select>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Stop sharing ${cal.name} with ${who}`}
                onClick={() => void set(ref, null, who)}
              >
                ✕
              </button>
            </div>
          );
        })
      )}

      {candidates.length > 0 && (
        <div className="cs-share-add">
          <label className="cs-sr" htmlFor={addId}>Share {cal.name} with a team or agent</label>
          <select
            id={addId}
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const { owner_type, owner_id } = decodeOwner(e.target.value);
              const ref: EntityRef = { type: owner_type, id: owner_id };
              void set(ref, DEFAULT_SHARE, ownerName(owner_type, owner_id));
            }}
          >
            <option value="">Share with…</option>
            {["Teams", "Agents"].map((g) => {
              const items = candidates.filter((c) => c.group === g);
              if (!items.length) return null;
              return (
                <optgroup key={g} label={g}>
                  {items.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>
      )}

      {cal.visibility !== "private" && mine.length > 0 && (
        <p className="cs-hint cs-hint-tight">
          A share only ever raises access above the default — it cannot take back what everyone
          already has. To hold something back from one person, lower the default and share it with
          the others.
        </p>
      )}
    </div>
  );
}
