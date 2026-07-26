/**
 * Booking a time across a communal workspace.
 *
 * The screen is built around one uncomfortable fact: you are allowed to know
 * *when* somebody is busy without being allowed to know *what with*. So the
 * overlay draws two categorically different kinds of block — a named one you
 * may read, and a hatched anonymous one you may not — and never a third kind
 * that looks readable but isn't. Nothing here ever asks scheduling.ts for a
 * title it did not offer.
 *
 * The other rule is that the last thing you read before committing is the
 * truth about where the meeting goes. A workspace where "Schedule" sometimes
 * means "and Google emailed everyone" and sometimes means "and it sat in a
 * local table" is a workspace where nobody trusts either outcome, so the
 * destination is stated in a full sentence next to the button, before the
 * click rather than in the toast after it. Both live in the panel's footer,
 * pinned, because a chosen slot must never be a scroll away from the sentence
 * that says where it lands.
 *
 * It opens beside the calendar and not over it. Picking a time is a comparison
 * — this slot against the week you were already looking at — and a dialog that
 * covers the grid asks you to hold that week in your head instead.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import { addDays, startOfDay } from "../calendars";
import {
  MINUTE_MS,
  atMinutes,
  bookableCalendars,
  calendarBackings,
  findSlots,
  formatDay,
  formatDuration,
  formatSlot,
  formatTime,
  proposeMeeting,
  providerLabel,
  subjectLabel,
} from "../scheduling";
import type { BusyInterval, CalendarBacking, Slot, SubjectBusy } from "../scheduling";
import { toast } from "../toast";
import { refKey } from "../types";
import type { EntityRef } from "../types";
import { Avatar, Spinner } from "./ui";
import { PanelSection, SidePanel } from "./SidePanel";
import "./scheduling.css";

/* ── form value helpers ───────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, "0");

function dateValue(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight on a `<input type="date">` value — never Date.parse, which is UTC. */
function fromDateValue(v: string): number {
  const [y, m, d] = v.split("-").map(Number);
  if (!y || !m || !d) return startOfDay(Date.now());
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function timeValue(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function minutesFromTimeValue(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

const DURATIONS = [15, 30, 45, 60, 90, 120];

/** A short meeting deserves a finer grid; an afternoon-long one does not. */
function granularityFor(durationMs: number): number {
  return durationMs <= 30 * MINUTE_MS ? 15 * MINUTE_MS : 30 * MINUTE_MS;
}

/**
 * Where to write a time along the ruler. At most five labels, whatever the
 * working day is: the ruler is a scale for reading the blocks beneath it, not
 * data of its own, and one label an hour collides into a grey smear the moment
 * the panel is anything but wide.
 */
function rulerTicks(start: number, end: number): number[] {
  const hours = Math.max(1, Math.round((end - start) / (60 * MINUTE_MS)));
  const step = Math.max(1, Math.ceil(hours / 4));
  const out: number[] = [];
  for (let h = 0; h <= hours; h += step) out.push(start + h * 60 * MINUTE_MS);
  return out;
}

function sameSubject(a: EntityRef, b: EntityRef): boolean {
  return a.type === b.type && a.id === b.id;
}

/**
 * What was *not* checked for somebody, in words. Empty when the answer is
 * complete. Counts only — naming a calendar the viewer has no access to would
 * hand over exactly the thing the access tier withholds.
 */
function coverageNote(person: SubjectBusy): string {
  if (!person.checkedCalendars && !person.hiddenCalendars && !person.mutedCalendars) {
    return `${person.label} has no calendar in Spaces, so nothing was checked.`;
  }
  const parts: string[] = [];
  if (person.hiddenCalendars) parts.push(`${person.hiddenCalendars} you cannot see`);
  if (person.mutedCalendars) parts.push(`${person.mutedCalendars} switched off in the overlay`);
  if (!parts.length) return "";
  return `Not checked: ${parts.join(" and ")}. This row may be incomplete.`;
}

/* ── attendee picker ──────────────────────────────────────────── */

interface Candidate {
  ref: EntityRef;
  label: string;
  detail: string;
  /** Harness kind, so an agent chip carries its badge. */
  kind?: string;
}

function AttendeePicker({
  subjects,
  onChange,
}: {
  subjects: EntityRef[];
  onChange: (next: EntityRef[]) => void;
}) {
  const members = useStore((s) => s.members);
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const teamMembers = useStore((s) => s.teamMembers);
  const [query, setQuery] = useState("");
  // The list belongs to the field, so it opens on focus and closes on blur —
  // but a click on a row blurs the field first, hence the beat of patience.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(0);
  const listId = useId();

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const m of members) {
      if (m.status !== "active") continue;
      out.push({
        ref: { type: "member", id: m.id },
        label: m.is_self ? `${m.name} (you)` : m.name,
        detail: m.email || m.role,
      });
    }
    for (const t of teams) {
      const n = teamMembers.filter((tm) => tm.team_id === t.id).length;
      out.push({
        ref: { type: "team", id: t.id },
        label: t.name,
        detail: `${n} agent${n === 1 ? "" : "s"}`,
      });
    }
    for (const a of agents) {
      out.push({
        ref: { type: "agent", id: a.id },
        label: a.name,
        detail: a.role || a.kind,
        kind: a.kind,
      });
    }
    return out;
  }, [members, teams, agents, teamMembers]);

  const chosen = new Set(subjects.map(refKey));
  const q = query.trim().toLowerCase();
  const matches = candidates
    .filter((c) => !chosen.has(refKey(c.ref)))
    .filter((c) => !q || c.label.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q))
    .slice(0, 8);

  const add = (ref: EntityRef) => {
    onChange([...subjects, ref]);
    setQuery("");
  };

  return (
    <div className="sm-who">
      <div className="sm-chips">
        {subjects.map((ref) => {
          const c = candidates.find((x) => sameSubject(x.ref, ref));
          return (
            <span key={refKey(ref)} className="sm-chip">
              <Avatar name={c?.label ?? subjectLabel(ref)} id={ref.id} kind={c?.kind} />
              <span className="sm-chip-name">{c?.label ?? subjectLabel(ref)}</span>
              <button
                type="button"
                className="sm-chip-x"
                aria-label={`Remove ${c?.label ?? subjectLabel(ref)} from the meeting`}
                onClick={() => onChange(subjects.filter((s) => !sameSubject(s, ref)))}
              >
                ✕
              </button>
            </span>
          );
        })}
        {!subjects.length && <span className="sm-chips-empty">Nobody yet.</span>}
      </div>

      <input
        className="sm-search"
        type="text"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-label="Add people, teams or agents to the meeting"
        placeholder="Add a person, team or agent…"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          window.clearTimeout(closeTimer.current);
          setOpen(true);
        }}
        onBlur={() => {
          closeTimer.current = window.setTimeout(() => setOpen(false), 140);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length) {
            e.preventDefault();
            add(matches[0].ref);
          } else if (e.key === "Escape" && open) {
            // Close the list without closing the whole screen behind it.
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />

      {open && matches.length > 0 && (
        <div className="sm-suggest" id={listId} role="listbox" aria-label="People you can add">
          {matches.map((c) => (
            <button
              key={refKey(c.ref)}
              type="button"
              role="option"
              aria-selected={false}
              className="sm-suggest-row"
              onClick={() => add(c.ref)}
            >
              <Avatar name={c.label} id={c.ref.id} kind={c.kind} />
              <span className="sm-suggest-name">{c.label}</span>
              {c.detail && <span className="sm-suggest-detail">{c.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── the busy overlay ─────────────────────────────────────────── */

/** One person's blocks for one day, clipped to the working window. */
function Lane({
  person,
  dayStart,
  windowStart,
  windowEnd,
  marker,
}: {
  person: SubjectBusy;
  dayStart: number;
  windowStart: number;
  windowEnd: number;
  marker: { start: number; end: number } | null;
}) {
  const span = windowEnd - windowStart;
  const dayEnd = addDays(dayStart, 1);
  const blocks = person.intervals
    .filter((iv) => iv.start < dayEnd && iv.end > dayStart)
    .map((iv) => ({
      iv,
      left: (Math.max(iv.start, windowStart) - windowStart) / span,
      width: (Math.min(iv.end, windowEnd) - Math.max(iv.start, windowStart)) / span,
    }))
    .filter((b) => b.width > 0);

  const gap = coverageNote(person);

  return (
    <div className="sm-lane">
      <span className="sm-lane-name" title={person.label}>
        {person.label}
        {gap && (
          <span className="sm-lane-gap" title={gap}>
            ?
          </span>
        )}
      </span>
      <div className="sm-track">
        {blocks.map((b, i) => (
          <div
            key={i}
            className={"sm-block" + (b.iv.redacted ? " sm-block-busy" : "") + (b.iv.tentative ? " sm-block-maybe" : "")}
            style={
              {
                left: `${b.left * 100}%`,
                width: `${Math.max(b.width * 100, 1.2)}%`,
                // The calendar's identity colour, used for the edge and a wash —
                // never for text, which a hashed hue cannot be trusted to carry.
                "--sm-c": b.iv.color,
              } as CSSProperties
            }
            title={b.iv.redacted ? "Busy" : b.iv.title || "Busy"}
          >
            <span className="sm-block-label">
              {b.iv.redacted ? "Busy" : b.iv.title || "Busy"}
            </span>
          </div>
        ))}
        {marker && (
          <div
            className="sm-marker"
            style={{
              left: `${((marker.start - windowStart) / span) * 100}%`,
              width: `${((marker.end - marker.start) / span) * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ── the screen ───────────────────────────────────────────────── */

export interface ScheduleMeetingProps {
  /** Seeds the invite, e.g. from a task's assignees. You are always added. */
  initialSubjects?: EntityRef[];
  onClose: () => void;
}

export function ScheduleMeeting({ initialSubjects, onClose }: ScheduleMeetingProps) {
  // self() builds a stand-in object when the members table has not loaded yet,
  // so subscribing to it directly would hand zustand a new identity every tick.
  const members = useStore((s) => s.members);
  const selfId = useMemo(() => useStore.getState().self().id, [members]);
  const events = useStore((s) => s.events);
  const calendars = useStore((s) => s.calendars);
  const calendarShares = useStore((s) => s.calendarShares);
  const calendarAccounts = useStore((s) => s.calendarAccounts);
  const teamMembers = useStore((s) => s.teamMembers);
  const loadEvents = useStore((s) => s.loadEvents);

  // Frozen at open so the search window is stable: recomputing "now" every
  // render would reload the event window on every keystroke.
  const [openedAt] = useState(() => Date.now());

  const [subjects, setSubjects] = useState<EntityRef[]>(() => {
    const seed: EntityRef[] = [{ type: "member", id: selfId }];
    for (const ref of initialSubjects ?? []) {
      if (!seed.some((s) => sameSubject(s, ref))) seed.push(ref);
    }
    return seed;
  });
  const [durationMs, setDurationMs] = useState(30 * MINUTE_MS);
  const [fromDate, setFromDate] = useState(() => dateValue(openedAt));
  const [toDate, setToDate] = useState(() => dateValue(addDays(openedAt, 6)));
  const [workStart, setWorkStart] = useState(timeValue(9 * 60));
  const [workEnd, setWorkEnd] = useState(timeValue(17 * 60));
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);

  const [picked, setPicked] = useState<{ start: number; end: number } | null>(null);
  const [title, setTitle] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [backings, setBackings] = useState<Map<string, CalendarBacking>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (start: number) => `${listId}-o${start}`;

  const rangeFrom = Math.max(openedAt, fromDateValue(fromDate));
  const rangeTo = addDays(fromDateValue(toDate), 1);
  const windowFrom = startOfDay(Math.min(rangeFrom, rangeTo));
  const rangeValid = rangeTo > rangeFrom;

  /*
   * Widen the store's loaded event window to whatever is being searched.
   * loadEvents replaces the window rather than merging, which is fine: every
   * consumer filters by its own range, and the calendar reloads its week when
   * it next moves.
   */
  useEffect(() => {
    if (!rangeValid) return;
    let cancelled = false;
    setLoading(true);
    void loadEvents(windowFrom, rangeTo)
      .catch((e) => {
        if (!cancelled) toast.error("Could not read the calendars", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowFrom, rangeTo, rangeValid, loadEvents]);

  useEffect(() => {
    let cancelled = false;
    void calendarBackings().then((map) => {
      if (!cancelled) setBackings(map);
    });
    return () => {
      cancelled = true;
    };
  }, [calendars, calendarAccounts]);

  const bookable = useMemo(
    () => bookableCalendars({ type: "member", id: selfId }),
    // bookableCalendars projects these two slices; it must move when they do.
    [calendars, calendarShares, selfId]
  );

  useEffect(() => {
    if (!calendarId && bookable.length) setCalendarId(bookable[0].id);
  }, [bookable, calendarId]);

  const workStartMin = minutesFromTimeValue(workStart);
  const workEndMin = minutesFromTimeValue(workEnd);
  const hoursValid = workEndMin > workStartMin;

  const search = useMemo(() => {
    if (!subjects.length || !rangeValid || !hoursValid) return null;
    return findSlots({
      subjects,
      from: rangeFrom,
      to: rangeTo,
      durationMs,
      workdayStart: workStartMin,
      workdayEnd: workEndMin,
      weekdaysOnly,
      granularityMs: granularityFor(durationMs),
      limit: 300,
    });
    // `events` is the loaded window findSlots reads through visibleEvents();
    // the share and team tables decide what of it is visible at all.
  }, [
    subjects, rangeFrom, rangeTo, rangeValid, durationMs, workStartMin, workEndMin,
    hoursValid, weekdaysOnly, events, calendars, calendarShares, teamMembers,
  ]);

  /** Days in calendar order, each with its slots in time order. */
  const days = useMemo(() => {
    if (!search) return [];
    const byDay = new Map<number, Slot[]>();
    for (const slot of search.slots) {
      const key = startOfDay(slot.start);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(slot);
      else byDay.set(key, [slot]);
    }
    return [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, slots]) => ({
        day,
        slots: slots.slice().sort((a, b) => a.start - b.start),
        windowStart: atMinutes(day, workStartMin),
        windowEnd: atMinutes(day, workEndMin),
      }));
  }, [search, workStartMin, workEndMin]);

  /** Flat reading order, so one arrow key crosses a day boundary. */
  const flat = useMemo(() => days.flatMap((d) => d.slots), [days]);

  // A slot that no longer exists (the range moved, the duration changed) must
  // not stay selected — the confirm panel would be describing a fiction.
  const selected = picked ? flat.find((s) => s.start === picked.start && s.end === picked.end) ?? null : null;
  useEffect(() => {
    if (picked && !flat.some((s) => s.start === picked.start && s.end === picked.end)) setPicked(null);
  }, [flat, picked]);

  const choose = (slot: Slot) => {
    setPicked({ start: slot.start, end: slot.end });
    // Focus stays on the listbox so the arrows keep working after a click.
    listRef.current?.focus({ preventScroll: true });
    listRef.current
      ?.querySelector(`[data-start="${slot.start}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!flat.length) return;
    const at = selected ? flat.findIndex((s) => s.start === selected.start) : -1;
    let next = at;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = Math.min(flat.length - 1, at + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = at <= 0 ? 0 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = flat.length - 1;
    else if (e.key === "Enter" && selected) {
      e.preventDefault();
      titleRef.current?.focus();
      return;
    } else return;
    e.preventDefault();
    choose(flat[Math.max(0, next)]);
  };

  // The confirm block only exists once a slot is chosen, so it can appear below
  // the fold of a scrolled panel. "nearest" leaves it alone when it is already
  // on screen, which is most of the time once you start arrowing around.
  const pickedStart = selected?.start;
  useEffect(() => {
    if (pickedStart) confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [pickedStart]);

  /** The gaps in what could be checked, so the confirm step admits to them. */
  const uncheckedNotes = (search?.busy ?? []).map(coverageNote).filter(Boolean);

  const backing = calendarId ? backings.get(calendarId) : undefined;
  const target = backing?.target ?? "local";
  const calendar = bookable.find((c) => c.id === calendarId);

  async function schedule() {
    if (!selected || !calendarId || saving) return;
    setSaving(true);
    try {
      const result = await proposeMeeting({
        slot: { start: selected.start, end: selected.end },
        subjects,
        title: title.trim() || "Meeting",
        calendarId,
      });
      if (result.upstreamFailed) {
        toast.warn(`Scheduled in Spaces only`, `${result.summary} ${result.upstreamError}`.trim());
      } else {
        toast.success(`“${title.trim() || "Meeting"}” scheduled`, result.summary);
      }
      onClose();
    } catch (e) {
      toast.error("Could not schedule the meeting", e);
    } finally {
      setSaving(false);
    }
  }

  const everyoneCount = search ? search.slots.filter((s) => s.everyone).length : 0;

  return (
    <SidePanel
      title="Schedule a meeting"
      subtitle="Across every calendar you are allowed to read. Nothing is booked until you say so."
      onClose={onClose}
      width={560}
      storageKey="schedule"
      /*
       * Pinned rather than sitting at the bottom of the body: the destination
       * sentence is the last thing to read before committing, and a sentence
       * you have to scroll to find is a sentence nobody reads. Both appear only
       * once there is a slot to commit to.
       */
      footer={
        selected ? (
          <>
            <p className="sm-dest" aria-live="polite">
              <span className="sm-dest-tag">{providerLabel(target)}</span>
              <span className="sm-dest-note">
                {backing?.note ??
                  (calendar
                    ? "Stays in Spaces. Nothing is sent anywhere."
                    : "Pick a calendar you can write to.")}
              </span>
            </p>
            <button
              type="button"
              className="btn primary"
              onClick={() => void schedule()}
              disabled={saving || !calendarId}
            >
              {saving && <Spinner />}
              {selected.everyone
                ? "Schedule"
                : `Schedule anyway (${selected.free.length}/${subjects.length})`}
            </button>
          </>
        ) : undefined
      }
    >
      {/* ── who ── */}
      <PanelSection title="Who">
        <AttendeePicker subjects={subjects} onChange={setSubjects} />
      </PanelSection>

      {/* ── when ── */}
      <PanelSection title="When">
        <div className="sm-stack">
          <div className="sm-controls">
            <label className="sm-ctl">
              <span className="sm-ctl-label">Length</span>
              <select
                value={durationMs}
                onChange={(e) => setDurationMs(Number(e.target.value))}
              >
                {DURATIONS.map((m) => (
                  <option key={m} value={m * MINUTE_MS}>
                    {formatDuration(m * MINUTE_MS)}
                  </option>
                ))}
              </select>
            </label>
            <label className="sm-ctl">
              <span className="sm-ctl-label">From</span>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label className="sm-ctl">
              <span className="sm-ctl-label">Until</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
            <label className="sm-ctl">
              <span className="sm-ctl-label">Between</span>
              <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)} />
            </label>
            <label className="sm-ctl">
              <span className="sm-ctl-label">and</span>
              <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} />
            </label>
            <label className="sm-ctl sm-ctl-check">
              <input
                type="checkbox"
                checked={weekdaysOnly}
                onChange={(e) => setWeekdaysOnly(e.target.checked)}
              />
              <span>Weekdays only</span>
            </label>
          </div>
          {!rangeValid && <p className="sm-warn">“Until” has to come on or after “From”.</p>}
          {!hoursValid && <p className="sm-warn">The working day has to end after it starts.</p>}
        </div>
      </PanelSection>

      {/* ── candidates ── */}
      <PanelSection
        title={
          <>
            Free times
            {search && !loading && (
              <span className="sm-h-note">
                {everyoneCount > 0
                  ? `${everyoneCount} work${everyoneCount === 1 ? "s" : ""} for everyone`
                  : "nothing works for everyone"}
              </span>
            )}
          </>
        }
      >
        {/* Holds its height so the panel does not jump as results replace a
            spinner and the slot you were about to click moves. */}
        <div className="sm-results-hold">
          {!subjects.length ? (
            <p className="sm-empty">
              <strong>Nobody is on the invite yet.</strong>
              Add at least one person, team or agent and their free time appears here.
            </p>
          ) : loading ? (
            <p className="sm-empty">
              <Spinner />
              Reading the calendars you have access to…
            </p>
          ) : !days.length ? (
            <p className="sm-empty">
              <strong>Nothing fits that window.</strong>
              Try a shorter meeting, a wider date range, later hours, or allow weekends.
            </p>
          ) : (
            <div
              className="sm-results"
              id={listId}
              role="listbox"
              aria-label="Candidate times"
              aria-activedescendant={selected ? optionId(selected.start) : undefined}
              tabIndex={0}
              ref={listRef}
              onKeyDown={onListKey}
            >
              {days.map((d) => (
                <div className="sm-day" role="group" aria-label={formatDay(d.day)} key={d.day}>
                  {/*
                   * The heading and the overlay are drawings of what the options
                   * below already say, and a listbox may only contain options —
                   * so they are hidden from assistive tech rather than read out
                   * twice in a shape screen readers cannot navigate. Nothing is
                   * lost: every option names its own conflicts, and the confirm
                   * panel spells out what could not be checked.
                   */}
                  <div className="sm-day-head" aria-hidden="true">
                    <span className="sm-day-name">{formatDay(d.day)}</span>
                    <span className="sm-day-count">
                      {d.slots.filter((s) => s.everyone).length} for everyone
                    </span>
                  </div>

                  <div className="sm-lanes" aria-hidden="true">
                    <div className="sm-ruler">
                      {rulerTicks(d.windowStart, d.windowEnd).map((t) => (
                        <span
                          key={t}
                          className="sm-tick"
                          style={{
                            left: `${((t - d.windowStart) / (d.windowEnd - d.windowStart)) * 100}%`,
                          }}
                        >
                          {formatTime(t)}
                        </span>
                      ))}
                    </div>
                    {(search?.busy ?? []).map((person) => (
                      <Lane
                        key={refKey(person.subject)}
                        person={person}
                        dayStart={d.day}
                        windowStart={d.windowStart}
                        windowEnd={d.windowEnd}
                        marker={
                          selected && startOfDay(selected.start) === d.day
                            ? { start: selected.start, end: selected.end }
                            : null
                        }
                      />
                    ))}
                  </div>

                  <div className="sm-slots">
                    {d.slots.map((slot) => {
                      const on = !!selected && selected.start === slot.start;
                      const label = slot.everyone
                        ? "everyone is free"
                        : `${slot.free.length} of ${subjects.length} free; ${slot.conflicts
                            .map((c) => c.label)
                            .join(", ")} busy`;
                      return (
                        <button
                          key={slot.start}
                          type="button"
                          role="option"
                          id={optionId(slot.start)}
                          data-start={slot.start}
                          aria-selected={on}
                          // One tab stop for the whole grid: the listbox owns
                          // focus and the arrow keys, exactly as the link
                          // picker's result list does.
                          tabIndex={-1}
                          className={
                            "sm-slot" +
                            (slot.everyone ? " sm-slot-all" : " sm-slot-partial") +
                            (on ? " sm-slot-on" : "")
                          }
                          aria-label={`${formatTime(slot.start)} to ${formatTime(slot.end)}, ${label}`}
                          onClick={() => choose(slot)}
                        >
                          <span className="sm-slot-time">{formatTime(slot.start)}</span>
                          {!slot.everyone && (
                            <span className="sm-slot-count">
                              {slot.free.length}/{subjects.length}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {search?.truncated && (
                <p className="sm-truncated">
                  That range is long enough that the search stopped early. Narrow it for the
                  full picture.
                </p>
              )}
            </div>
          )}
        </div>
      </PanelSection>

      {/* ── confirm ── */}
      {selected && (
        <PanelSection title="Confirm">
          <div className="sm-stack" ref={confirmRef}>
            <p className="sm-when">{formatSlot(selected)}</p>

            <ul className="sm-roll">
              {(search?.busy ?? []).map((person) => {
                const clash = selected.conflicts.find((c) => sameSubject(c.subject, person.subject));
                const gap = coverageNote(person);
                // A redacted block contributes its times and nothing else, so
                // the reason reads "Busy 14:00–14:30" and stops there.
                const why = clash
                  ? clash.intervals
                      .map(
                        (iv: BusyInterval) =>
                          `${iv.redacted ? "Busy" : iv.title || "Busy"} ${formatTime(iv.start)}–${formatTime(iv.end)}`
                      )
                      .join(", ")
                  : gap
                    ? "free on what you can see"
                    : "free";
                return (
                  <li
                    key={refKey(person.subject)}
                    className={"sm-roll-row" + (clash ? " sm-roll-busy" : "")}
                  >
                    <span className="sm-roll-mark" aria-hidden="true">{clash ? "×" : "✓"}</span>
                    <span className="sm-roll-name">{person.label}</span>
                    <span className="sm-roll-why" title={gap || undefined}>
                      {why}
                    </span>
                  </li>
                );
              })}
            </ul>

            {uncheckedNotes.length > 0 && (
              <p className="sm-caveat">
                {uncheckedNotes.join(" ")} Treat this slot as a good guess rather than a
                promise.
              </p>
            )}

            <div className="sm-fields">
              <label className="sm-ctl sm-ctl-grow">
                <span className="sm-ctl-label">Meeting name</span>
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  placeholder="Weekly sync"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="sm-ctl sm-ctl-grow">
                <span className="sm-ctl-label">Calendar</span>
                <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
                  {!bookable.length && <option value="">No calendar you can write to</option>}
                  {bookable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </PanelSection>
      )}
    </SidePanel>
  );
}
