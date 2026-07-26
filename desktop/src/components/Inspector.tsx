/**
 * The inspector drawer.
 *
 * Everything used to open in a modal, which forces a choice the user should
 * never have to make: read the task, or read the channel that produced it. A
 * modal is also the wrong shape for a graph — following a link means closing
 * one dialog to open another, losing your place twice on the way.
 *
 * So the drawer is bound to `store.inspect` and carries its own back/forward
 * stack: a chip inside it moves the *drawer*, never the app. The main view
 * stays exactly where it was, which is the whole reason this is not a modal.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { useStore, channelAgents } from "../store";
import { KIND_BY_TYPE } from "../entities";
import { ASSIGN_ROLES, workloadOf } from "../links";
import { refKey, sameRef } from "../types";
import type { ActivityEvent, AssignRole, EntityRef, Run, TaskStatus, View } from "../types";
import { timeAgo } from "../github";
import { Markdown } from "./ui";
import { IconX } from "./icons";
import { EntityChip, useEntity } from "./EntityChip";
import { ConnectionsPanel } from "./ConnectionsPanel";
import "./inspector.css";

/* ── width ────────────────────────────────────────────────────── */

const WIDTH_KEY = "spaces.inspector.width";
const DEFAULT_W = 384;
const MIN_W = 300;
const MAX_W = 760;

/** Kept in step with the overlay breakpoint in inspector.css. */
const OVERLAY_BELOW = 1100;

/**
 * Never let the drawer squeeze the pane it exists to sit beside — but only
 * while it is pushing that pane. Once it overlays, shrinking the window must
 * not quietly eat a width the user chose.
 */
function ceiling(): number {
  const vw = window.innerWidth;
  const room = vw < OVERLAY_BELOW ? vw - 44 : vw - 460;
  return Math.max(MIN_W, Math.min(MAX_W, room));
}

function clampWidth(n: number): number {
  return Math.max(MIN_W, Math.min(ceiling(), Math.round(n)));
}

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampWidth(saved);
  } catch {
    /* private mode, or a hand-edited value — the default is always fine */
  }
  return DEFAULT_W;
}

function useDrawerWidth() {
  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);

  // Debounced so a drag writes once at rest rather than once per frame.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* not worth surfacing: the drawer still works, it just forgets */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [width]);

  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The cursor and the selection block belong to the document, not the handle:
  // a drag that leaves the 7px strip must still feel like a drag.
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("insp-dragging");
    return () => document.documentElement.classList.remove("insp-dragging");
  }, [dragging]);

  return {
    width,
    dragging,
    setWidth: (n: number) => setWidth(clampWidth(n)),
    setDragging,
  };
}

function Resizer({
  width,
  onWidth,
  onDragging,
}: {
  width: number;
  onWidth: (n: number) => void;
  onDragging: (on: boolean) => void;
}) {
  const active = useRef(false);

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    active.current = false;
    onDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      className="insp-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      aria-valuemax={MAX_W}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        active.current = true;
        onDragging(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        onWidth(window.innerWidth - e.clientX);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onWidth(DEFAULT_W)}
      onKeyDown={(e) => {
        // Left widens: the drawer grows towards the left edge of the screen.
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") onWidth(width + step);
        else if (e.key === "ArrowRight") onWidth(width - step);
        else if (e.key === "Home") onWidth(MAX_W);
        else if (e.key === "End") onWidth(MIN_W);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/* ── drawer-local history ─────────────────────────────────────── */

interface Nav {
  stack: EntityRef[];
  i: number;
}

/** Deep enough to retrace a graph walk, shallow enough to stay a stack. */
const MAX_HISTORY = 40;

function useDrawerHistory(inspect: EntityRef | null) {
  const setInspect = useStore((s) => s.setInspect);
  const [nav, setNav] = useState<Nav>({ stack: [], i: -1 });

  useEffect(() => {
    if (!inspect) {
      setNav({ stack: [], i: -1 });
      return;
    }
    setNav((prev) => {
      // Our own back/forward already moved the cursor before setting the store.
      if (sameRef(prev.stack[prev.i] ?? null, inspect)) return prev;
      const stack = [...prev.stack.slice(0, prev.i + 1), inspect].slice(-MAX_HISTORY);
      return { stack, i: stack.length - 1 };
    });
  }, [inspect]);

  const go = (delta: number) => {
    const target = nav.stack[nav.i + delta];
    if (!target) return;
    setNav({ stack: nav.stack, i: nav.i + delta });
    setInspect(target);
  };

  return { canBack: nav.i > 0, canForward: nav.i < nav.stack.length - 1, go };
}

/* ── small presentation pieces ────────────────────────────────── */

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="insp-section">
      <h3 className="insp-section-title">
        {title}
        {count !== undefined && <span className="insp-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  children?: ReactNode;
}) {
  if (!children && !value) return null;
  return (
    <div className="insp-fact">
      <dt>{label}</dt>
      <dd className={mono ? "insp-mono" : undefined} title={mono ? (value ?? undefined) : undefined}>
        {children ?? value}
      </dd>
    </div>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="insp-facts">{children}</dl>;
}

const RUN_TONE: Record<Run["status"], string> = {
  running: "running",
  done: "done",
  error: "error",
  cancelled: "cancelled",
};

function StatusPill({ status }: { status: Run["status"] }) {
  return <span className={`insp-status ${RUN_TONE[status] ?? "cancelled"}`}>{status}</span>;
}

const TASK_STATUS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "In progress",
  done: "Done",
};

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function parseActivity(json: string): ActivityEvent[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `store.runs` only holds what this session has touched, so a run opened cold
 * has to be fetched. Once, deliberately: a run id with no row behind it must
 * not re-query on every store change for as long as the drawer is open.
 */
function useRunOnce(id: string | undefined) {
  const loadRun = useStore((s) => s.loadRun);
  useEffect(() => {
    if (!id || useStore.getState().runs[id]) return;
    void loadRun(id);
  }, [id, loadRun]);
}

/** Chips inside the drawer navigate the drawer — that is the contract. */
function ChipRow({ refs, go }: { refs: EntityRef[]; go: (r: EntityRef) => void }) {
  if (!refs.length) return null;
  return (
    <div className="insp-chips">
      {refs.map((r) => (
        <EntityChip key={refKey(r)} ref={r} size="sm" onClick={go} />
      ))}
    </div>
  );
}

/* ── kind-specific detail ─────────────────────────────────────── */

function TaskDetail({ id, go }: { id: string; go: (r: EntityRef) => void }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === id));
  const runs = useStore((s) => s.runs);
  const agents = useStore((s) => s.agents);

  // Without this a task opened cold shows no history at all.
  useRunOnce(task?.last_run_id);

  const history = useMemo(
    () => Object.values(runs).filter((r) => r.task_id === id).sort((a, b) => b.started_at - a.started_at),
    [runs, id]
  );

  if (!task) return null;
  const assignee = agents.find((a) => a.id === task.assignee_agent_id);

  return (
    <>
      <Section title="Task">
        <Facts>
          <Fact label="Status" value={TASK_STATUS[task.status] ?? task.status} />
          <Fact label="Assignee">
            {assignee ? (
              <EntityChip ref={{ type: "agent", id: assignee.id }} size="sm" onClick={go} />
            ) : (
              <span className="insp-none">Unassigned</span>
            )}
          </Fact>
          <Fact label="Due" value={task.due_date || null} />
          <Fact label="Branch" value={task.branch || null} mono />
          <Fact label="Created" value={timeAgo(task.created_at)} />
        </Facts>
      </Section>

      <Section title="Run history" count={history.length}>
        {history.length === 0 ? (
          <p className="insp-none">No agent has run on this task yet.</p>
        ) : (
          <div className="insp-rows">
            {history.map((r) => {
              const who = agents.find((a) => a.id === r.agent_id)?.name ?? "agent";
              const ms = (r.finished_at || Date.now()) - r.started_at;
              return (
                <button
                  key={r.id}
                  type="button"
                  className="insp-run"
                  onClick={() => go({ type: "run", id: r.id })}
                  aria-label={`Run by ${who}, ${r.status}, ${timeAgo(r.started_at)}`}
                >
                  <StatusPill status={r.status} />
                  <span className="insp-run-who">{who}</span>
                  <span className="insp-run-meta">
                    {timeAgo(r.started_at)} · {duration(ms)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

function MemoryDetail({ id }: { id: string }) {
  const entry = useStore((s) => s.memory.find((m) => m.id === id));
  if (!entry) return null;
  return (
    <Section title="Memory">
      <Facts>
        <Fact label="Kind" value={entry.kind} />
        <Fact label="Pinned">
          {entry.pinned ? (
            <span className="insp-pinned">Pinned — always in context</span>
          ) : (
            <span className="insp-none">Not pinned</span>
          )}
        </Fact>
        <Fact label="Updated" value={timeAgo(entry.updated_at || entry.created_at)} />
      </Facts>
    </Section>
  );
}

function AgentDetail({ id, go }: { id: string; go: (r: EntityRef) => void }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === id));
  useStore((s) => s.assignments);
  const work = workloadOf({ type: "agent", id });

  // Grouped in registry order, so the list reads owner → assignee → reviewer →
  // watcher no matter what order the rows were written in.
  const groups = new Map<AssignRole, EntityRef[]>();
  for (const w of work) {
    const list = groups.get(w.role) ?? [];
    list.push(w.info.ref);
    groups.set(w.role, list);
  }
  const byRole = ASSIGN_ROLES.map((r) => ({ ...r, refs: groups.get(r.role) ?? [] })).filter(
    (r) => r.refs.length
  );

  if (!agent) return null;

  return (
    <>
      <Section title="Agent">
        <Facts>
          <Fact label="Harness" value={agent.kind} />
          <Fact label="Model" value={agent.model || null} mono />
          <Fact label="Role" value={agent.role || null} />
          <Fact label="Owns" value={agent.owns || null} />
        </Facts>
      </Section>

      <Section title="On the hook for" count={work.length}>
        {byRole.length === 0 ? (
          <p className="insp-none">Not assigned to anything yet.</p>
        ) : (
          byRole.map((group) => (
            <div className="insp-group" key={group.role}>
              <div className="insp-group-head" title={group.help}>
                {group.label}
              </div>
              <ChipRow refs={group.refs} go={go} />
            </div>
          ))
        )}
      </Section>
    </>
  );
}

function ChannelDetail({ id, go }: { id: string; go: (r: EntityRef) => void }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === id));
  const channelMembers = useStore((s) => s.channelMembers);
  const teamMembers = useStore((s) => s.teamMembers);
  const agents = useStore((s) => s.agents);

  const members = useMemo(
    () => channelAgents({ channelMembers, teamMembers, agents }, id),
    [channelMembers, teamMembers, agents, id]
  );
  const teams = useMemo(
    () =>
      channelMembers
        .filter((m) => m.channel_id === id && m.member_type === "team")
        .map((m) => ({ type: "team", id: m.member_id }) as EntityRef),
    [channelMembers, id]
  );

  if (!channel) return null;

  return (
    <>
      <Section title="Channel">
        {/* The charter is the entity's body, and the topic is already in the
            subtitle — repeating either here would just be the same words. */}
        <Facts>
          <Fact label="Mode" value={channel.mode} />
          <Fact label="Chaining" value={channel.chaining ? "Agents can trigger agents" : "Off"} />
        </Facts>
      </Section>

      <Section title="Members" count={members.length + teams.length}>
        {members.length + teams.length === 0 ? (
          <p className="insp-none">No agents in this channel yet.</p>
        ) : (
          <>
            <ChipRow refs={teams} go={go} />
            <ChipRow refs={members.map((a) => ({ type: "agent", id: a.id }))} go={go} />
          </>
        )}
      </Section>
    </>
  );
}

function RunDetail({ id, go }: { id: string; go: (r: EntityRef) => void }) {
  const run = useStore((s) => s.runs[id]);
  const agents = useStore((s) => s.agents);
  const [, tick] = useState(0);

  useRunOnce(id);

  // A running run's duration is a clock, not a fact.
  useEffect(() => {
    if (run?.status !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run?.status]);

  const events = useMemo(() => parseActivity(run?.activity ?? ""), [run?.activity]);

  if (!run) return null;
  const agent = agents.find((a) => a.id === run.agent_id);
  const tools = events.filter((e) => e.kind === "tool").length;
  const errors = events.filter((e) => e.kind === "stderr").length;
  const last = events[events.length - 1];
  const files = run.files_changed.split("\n").filter(Boolean);

  return (
    <>
      <Section title="Run">
        <Facts>
          <Fact label="Status">
            <StatusPill status={run.status} />
          </Fact>
          <Fact label="Agent">
            {agent ? (
              <EntityChip ref={{ type: "agent", id: agent.id }} size="sm" onClick={go} />
            ) : (
              <span className="insp-none">unknown</span>
            )}
          </Fact>
          <Fact
            label="Duration"
            value={duration((run.finished_at || Date.now()) - run.started_at) + (run.status === "running" ? "…" : "")}
          />
          <Fact label="Started" value={timeAgo(run.started_at)} />
          <Fact label="Run usage" value={run.meta || null} />
          <Fact label="Working dir" value={run.cwd || null} mono />
        </Facts>
      </Section>

      <Section title="Activity" count={events.length}>
        {events.length === 0 ? (
          <p className="insp-none">Nothing recorded{run.status === "running" ? " yet" : ""}.</p>
        ) : (
          <>
            <div className="insp-tally">
              <span>{tools} tool {tools === 1 ? "call" : "calls"}</span>
              {errors > 0 && <span className="insp-tally-err">{errors} on stderr</span>}
              {files.length > 0 && (
                <span>
                  {files.length} file{files.length === 1 ? "" : "s"} touched
                </span>
              )}
            </div>
            {last && <p className="insp-last-event">{last.detail}</p>}
          </>
        )}
      </Section>
    </>
  );
}

function Detail({ target, go }: { target: EntityRef; go: (r: EntityRef) => void }) {
  switch (target.type) {
    case "task":
      return <TaskDetail id={target.id} go={go} />;
    case "memory":
      return <MemoryDetail id={target.id} />;
    case "agent":
      return <AgentDetail id={target.id} go={go} />;
    case "channel":
      return <ChannelDetail id={target.id} go={go} />;
    case "run":
      return <RunDetail id={target.id} go={go} />;
    default:
      return null;
  }
}

/* ── the drawer ───────────────────────────────────────────────── */

export function Inspector() {
  const inspect = useStore((s) => s.inspect);
  const setInspect = useStore((s) => s.setInspect);
  const setView = useStore((s) => s.setView);
  const { width, setWidth, setDragging } = useDrawerWidth();
  const { canBack, canForward, go: step } = useDrawerHistory(inspect);
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const open = !!inspect;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A modal or the palette is stacked above the drawer, and Escape belongs
      // to whatever is on top. Neither owns a store flag we could read.
      if (document.querySelector(".modal-backdrop, .palette-backdrop")) return;
      e.preventDefault();
      setInspect(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setInspect]);

  // Opening moves focus in so the drawer is reachable and announced; closing
  // hands it back, but only if the drawer still had it — the user may have
  // clicked away, and yanking focus back would be worse than losing it.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      const back = restoreRef.current;
      const active = document.activeElement;
      if (!back?.isConnected) return;
      if (active && active !== document.body && !panelRef.current?.contains(active)) return;
      back.focus();
    };
  }, [open]);

  if (!inspect) return null;
  return (
    <Drawer
      target={inspect}
      width={width}
      setWidth={setWidth}
      setDragging={setDragging}
      canBack={canBack}
      canForward={canForward}
      step={step}
      panelRef={panelRef}
      close={() => setInspect(null)}
      go={setInspect}
      setView={setView}
    />
  );
}

/**
 * Split from `Inspector` purely so the hooks that read the focused entity are
 * only ever called with one — a null anchor has nothing to describe.
 */
function Drawer({
  target,
  width,
  setWidth,
  setDragging,
  canBack,
  canForward,
  step,
  panelRef,
  close,
  go,
  setView,
}: {
  target: EntityRef;
  width: number;
  setWidth: (n: number) => void;
  setDragging: (on: boolean) => void;
  canBack: boolean;
  canForward: boolean;
  step: (delta: number) => void;
  panelRef: RefObject<HTMLElement | null>;
  close: () => void;
  /** Move the drawer to another entity, without touching the main view. */
  go: (r: EntityRef) => void;
  setView: (v: View) => void;
}) {
  const info = useEntity(target);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const kind = KIND_BY_TYPE[target.type];
  const kindLabel = kind?.label ?? target.type;

  // Each entity is its own page: keep the scroll position out of it.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [refKey(target)]);

  return (
    <>
      <div className="insp-backdrop" aria-hidden="true" onMouseDown={close} />
      <aside
        className="insp"
        style={{ "--insp-w": `${width}px` } as CSSProperties}
        aria-label={`Inspector: ${info.title}`}
        tabIndex={-1}
        ref={(el) => {
          panelRef.current = el;
        }}
      >
        <Resizer width={width} onWidth={setWidth} onDragging={setDragging} />

        <header className="insp-head">
          <div className="insp-bar">
            <div className="insp-nav">
              <button
                type="button"
                className="icon-btn"
                onClick={() => step(-1)}
                disabled={!canBack}
                aria-label="Back"
                title="Back"
              >
                ‹
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => step(1)}
                disabled={!canForward}
                aria-label="Forward"
                title="Forward"
              >
                ›
              </button>
            </div>
            <span className="insp-kind">{kindLabel}</span>
            <div className="insp-tools">
              {info.view && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => setView(info.view!)}
                  title={`Open ${info.title} in the main view`}
                >
                  Open
                </button>
              )}
              {!info.view && info.href && (
                <a className="btn tiny" href={info.href} target="_blank" rel="noreferrer">
                  Open ↗
                </a>
              )}
              <button
                type="button"
                className="icon-btn"
                onClick={close}
                aria-label="Close inspector"
                title="Close inspector (Esc)"
              >
                <IconX size={13} />
              </button>
            </div>
          </div>

          <div className="insp-ident">
            <span className="insp-glyph" style={{ color: info.tone }} aria-hidden="true">
              {info.glyph}
            </span>
            <div className="insp-ident-text">
              <h2 className={"insp-title" + (info.exists ? "" : " insp-gone")}>{info.title}</h2>
              {info.subtitle && <div className="insp-sub">{info.subtitle}</div>}
            </div>
          </div>
        </header>

        <div className="insp-body" ref={bodyRef}>
          {!info.exists && (
            <p className="insp-note">
              This {kindLabel.toLowerCase()} was deleted. Its connections are kept so the trail
              isn't lost.
            </p>
          )}

          {info.body && (
            <div className="insp-prose">
              <Markdown text={info.body} />
            </div>
          )}

          {/* Keyed so moving between two tasks resets their per-entity state
              instead of carrying one task's run list into the next. */}
          <Detail key={refKey(target)} target={target} go={go} />

          {/* Who is on this and what it is linked to both live here — the panel
              owns assignments as well as links, and owns editing both. */}
          <div className="insp-connections">
            <ConnectionsPanel anchor={target} compact />
          </div>
        </div>
      </aside>
    </>
  );
}
