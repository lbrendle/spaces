/**
 * The dashboard: what is happening in this workspace, right now.
 *
 * Sections are ordered by how fast a fact goes stale. Live runs sit at the
 * top because they are the only thing here that moves while you look at it;
 * GitHub sits at the bottom because it is a snapshot of somebody else's
 * server. In between is the workspace's own shape — who is carrying what, how
 * much work is open, what just happened.
 *
 * Everything above the GitHub block reads the store, so it is live and free.
 * The two things the store cannot answer at launch — messages (loaded per
 * channel on demand) and runs from earlier sessions — are primed exactly once
 * per mount and then tracked live, which is also why the feed never polls.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { useStore, channelAgents } from "../store";
import { triggerAgents, userTrigger } from "../agents";
import { getDb, uid } from "../db";
import { KIND_BY_TYPE } from "../entities";
import { LINK_KIND_BY_ID, workloadOf } from "../links";
import { getQueueSnapshot, subscribeQueue } from "../orchestrator";
import { RITZ_BASE } from "../capabilities";
import { config } from "../config";
import { errorText, toast } from "../toast";
import { slug } from "../types";
import type { Agent, AgentKind, EntityRef, EntityType, MemoryKind, TaskStatus } from "../types";
import {
  ghCapability,
  ghCommand,
  ghRefresh,
  listMyRepos,
  myOpenPRs,
  repoIssues,
  repoPRs,
  reviewRequests,
  timeAgo,
  type GhCapability,
  type SearchPR,
} from "../github";
import { EntityChip } from "./EntityChip";
import { FirstRunChecklist } from "./SetupGuide";
import { ActionQueue, usePendingActionCount } from "./ActionQueue";
import { Avatar, Field, Modal } from "./ui";
import { IconBranch, IconGitHub, IconMemory, IconPlus, IconTasks } from "./icons";
import "./dashboard.css";

/* ── time ─────────────────────────────────────────────────────── */

/** Clock face for a run in flight: m:ss, or h:mm:ss once it has been a while. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The same span, spoken — clock faces are unreadable to a screen reader. */
function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/** Re-render once a second, but only while something is actually counting. */
function useSecondTick(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setTick(Date.now());
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return tick;
}

/** Local midnight today. Due dates are calendar days, not instants. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `YYYY-MM-DD` as a local day, so a date is not "overdue" a timezone early. */
function dueTime(due: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const t = Date.parse(due);
  return Number.isNaN(t) ? 0 : t;
}

/* ── shared bits ──────────────────────────────────────────────── */

/**
 * Chips on this screen open the inspector instead of navigating. The
 * dashboard is where you look things up; being thrown into another view to
 * read one line of context is the opposite of what it is for.
 */
function useInspect(): (ref: EntityRef) => void {
  const setInspect = useStore((s) => s.setInspect);
  return useCallback((ref: EntityRef) => setInspect(ref), [setInspect]);
}

function Card({
  title,
  icon,
  meta,
  children,
}: {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="db-card">
      <h3 className="db-card-title">
        {icon && (
          <span className="db-card-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span>{title}</span>
        {meta && <span className="db-card-meta">{meta}</span>}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="db-empty">{children}</p>;
}

/** Grey bars in the shape of the rows that are coming. */
function Skeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="db-skel-list">
      <span className="db-sr" role="status">
        {label}
      </span>
      {Array.from({ length: rows }, (_, i) => (
        <span className="db-skel-row" key={i} aria-hidden="true">
          <span className="db-skel db-skel-dot" />
          <span className="db-skel db-skel-line" style={{ width: `${72 - i * 13}%` }} />
          <span className="db-skel db-skel-tail" />
        </span>
      ))}
    </div>
  );
}

/* ── right now ────────────────────────────────────────────────── */

/** The newest thing an in-flight run told us it was doing. */
function latestActivity(activity: string): string {
  if (!activity) return "";
  try {
    const parsed: unknown = JSON.parse(activity);
    if (!Array.isArray(parsed)) return "";
    for (let i = parsed.length - 1; i >= 0; i--) {
      const detail = (parsed[i] as { detail?: unknown } | null)?.detail;
      if (typeof detail === "string" && detail.trim()) return detail.trim().split("\n")[0];
    }
  } catch {
    // activity is written by the adapters and can be mid-write; a feed row is
    // never worth throwing over
  }
  return "";
}

function LiveStrip() {
  const activeRunIds = useStore((s) => s.activeRunIds);
  const runs = useStore((s) => s.runs);
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const projects = useStore((s) => s.projects);
  const setView = useStore((s) => s.setView);

  // Queue depth lives in the orchestrator, not the store: it is process state,
  // seeded from SQLite at startup and updated as turns are parked and drained.
  const queue = useSyncExternalStore(subscribeQueue, getQueueSnapshot);
  const live = activeRunIds.map((id) => runs[id]).filter((r) => !!r);
  const now = useSecondTick(live.length > 0);

  const parked = Object.entries(queue)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const cut = k.indexOf(":");
      const channelId = cut < 0 ? k : k.slice(0, cut);
      const agentId = cut < 0 ? "" : k.slice(cut + 1);
      return {
        key: k,
        n,
        agent: agents.find((a) => a.id === agentId)?.name ?? "An agent",
        channel: channels.find((c) => c.id === channelId)?.name ?? "",
        channelId,
      };
    });
  const parkedTotal = parked.reduce((sum, p) => sum + p.n, 0);

  return (
    <Card
      title="Right now"
      meta={
        live.length > 0 ? (
          <span className="db-meta-live">
            {live.length} running
            {parkedTotal > 0 && ` · ${parkedTotal} queued`}
          </span>
        ) : (
          <span className="db-meta-idle">idle</span>
        )
      }
    >
      {/* The section is headed "Right now" and its meta already reads "idle".
          A second sentence saying nothing is running is the third time, and
          the half of it that explained @mentions was answering a question
          nobody asks twice — on the surface you land on every launch. */}
      {live.length === 0 && <Empty>Nothing is running.</Empty>}

      {live.map((run) => {
        const agent = agents.find((a) => a.id === run.agent_id);
        const channel = channels.find((c) => c.id === run.channel_id);
        const project = projects.find((p) => p.id === channel?.project_id);
        const name = agent?.name ?? "An agent";
        const where = channel ? `#${channel.name}` : "a deleted channel";
        const doing = latestActivity(run.activity);
        const elapsed = Math.max(0, now - run.started_at);
        return (
          <button
            key={run.id}
            type="button"
            className="db-run"
            disabled={!channel}
            onClick={() => channel && setView({ type: "channel", channelId: channel.id })}
            aria-label={`${name} has been working in ${where} for ${spokenDuration(elapsed)}${
              doing ? `. Currently: ${doing}` : ""
            }. Open the channel.`}
          >
            <span className="db-pulse" aria-hidden="true" />
            <Avatar name={name} id={run.agent_id} kind={agent?.kind} />
            <span className="db-run-main">
              <span className="db-run-top">
                <span className="db-run-who">{name}</span>
                <span className="db-run-where">
                  {where}
                  {project && ` · ${project.name}`}
                </span>
              </span>
              <span className="db-run-doing">{doing || "starting up…"}</span>
            </span>
            <span className="db-run-clock" aria-hidden="true">
              {fmtElapsed(elapsed)}
            </span>
          </button>
        );
      })}

      {parkedTotal > 0 && (
        <div className="db-parked">
          <div className="db-parked-head">
            {parkedTotal} turn{parkedTotal === 1 ? "" : "s"} parked — each one runs as soon as
            its agent is free.
          </div>
          <ul className="db-parked-list">
            {parked.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  className="db-parked-row"
                  disabled={!p.channel}
                  onClick={() => setView({ type: "channel", channelId: p.channelId })}
                  aria-label={`${p.n} turn${p.n === 1 ? "" : "s"} waiting for ${p.agent} in ${
                    p.channel ? `#${p.channel}` : "a deleted channel"
                  }. Open the channel.`}
                >
                  <span className="db-parked-n">{p.n}</span>
                  <span className="db-parked-who">{p.agent}</span>
                  <span className="db-parked-where">
                    {p.channel ? `#${p.channel}` : "deleted channel"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/* ── workload ─────────────────────────────────────────────────── */

interface Availability {
  /** Drives the pill's tint. "elsewhere" is not a fault, so it is never red. */
  tone: "ready" | "elsewhere" | "unknown";
  label: string;
  hint: string;
}

/**
 * Whether this machine could host this agent.
 *
 * Saying it here is the whole point: agents are shared, so a workspace full of
 * teammates' agents is normal and healthy — but pressing send on one whose CLI
 * is not on YOUR PATH gets you nothing, and finding that out at dispatch time
 * is a bad way to learn it.
 */
function runtimeAvailability(kind: AgentKind, tools: Record<string, boolean>): Availability {
  if (kind === "ritz") {
    return {
      tone: "unknown",
      label: "over HTTP",
      hint: `${config().localAiName} is a service, not a binary — ${config().brand} talks to it at ${RITZ_BASE}. Settings shows whether it is answering.`,
    };
  }
  if (Object.keys(tools).length === 0) {
    return {
      tone: "unknown",
      label: "checking…",
      hint: "Spaces is still looking for the CLIs on this machine.",
    };
  }
  if (tools[kind]) {
    return {
      tone: "ready",
      label: "runs here",
      hint: `${kind} is on this machine's PATH, so you can run this agent from your device.`,
    };
  }
  return {
    tone: "elsewhere",
    label: "not on this machine",
    hint: `${kind} is not on this machine's PATH. The agent still works — it runs wherever a teammate hosts it — but sending it work from here will not start anything.`,
  };
}

const TOOLS: { id: string; label: string; note: string }[] = [
  { id: "claude", label: "claude", note: "Claude Code — agents of this kind can run from your device." },
  { id: "codex", label: "codex", note: "Codex — agents of this kind can run from your device." },
  { id: "gh", label: "gh", note: "The GitHub CLI, used for the pull request and repo sections." },
];

/**
 * Which runtimes are on this machine.
 *
 * It sat under the pane title, as three bordered pills, costing the first
 * screen 34px of permanent chrome to answer a question nobody had yet. It lives
 * here because the only thing on the page it explains is the availability
 * column immediately below it.
 */
function Runtimes({ tools }: { tools: Record<string, boolean> }) {
  return (
    <p className="db-runtimes">
      On this machine
      {TOOLS.map((t) => {
        const on = tools[t.id];
        return (
          <span
            key={t.id}
            className={"db-runtime" + (on ? " on" : "")}
            title={`${t.note} ${on ? "Found on this machine." : "Not on this machine."}`}
          >
            <span className="db-runtime-dot" aria-hidden="true" />
            {t.label}
            <span className="db-sr">{on ? "found" : "not found"} on this machine</span>
          </span>
        );
      })}
    </p>
  );
}

interface WorkloadRow {
  ref: EntityRef;
  name: string;
  sub: string;
  kind?: AgentKind;
  avail: Availability;
  total: number;
  byKind: { type: EntityType; n: number }[];
  work: EntityRef[];
}

function WorkloadCard() {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const teamMembers = useStore((s) => s.teamMembers);
  const assignments = useStore((s) => s.assignments);
  const tools = useStore((s) => s.tools);
  // workloadOf resolves each target through describeEntity, so every table it
  // reads is an input to this memo.
  const tasks = useStore((s) => s.tasks);
  const memory = useStore((s) => s.memory);
  const channels = useStore((s) => s.channels);
  const projects = useStore((s) => s.projects);

  const [openId, setOpenId] = useState("");
  const panelId = useId();
  const inspect = useInspect();

  const rows = useMemo<WorkloadRow[]>(() => {
    const build = (ref: EntityRef, name: string, sub: string, avail: Availability, kind?: AgentKind) => {
      const work = workloadOf(ref);
      const counts = new Map<EntityType, number>();
      for (const w of work) counts.set(w.info.ref.type, (counts.get(w.info.ref.type) ?? 0) + 1);
      return {
        ref,
        name,
        sub,
        kind,
        avail,
        total: work.length,
        byKind: [...counts.entries()]
          .map(([type, n]) => ({ type, n }))
          .sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
        work: work.map((w) => w.info.ref),
      };
    };

    const out = agents.map((a) =>
      build(
        { type: "agent", id: a.id },
        a.name,
        a.role || a.kind,
        runtimeAvailability(a.kind, tools),
        a.kind
      )
    );

    // Teams only earn a row once they are carrying something — an empty team
    // is an Agents-view concern, not a workload one.
    for (const t of teams) {
      if (!assignments.some((a) => a.subject_type === "team" && a.subject_id === t.id)) continue;
      const members = teamMembers
        .filter((tm) => tm.team_id === t.id)
        .map((tm) => agents.find((a) => a.id === tm.agent_id))
        .filter((a) => !!a);
      const anyHere = members.some((m) => runtimeAvailability(m.kind, tools).tone === "ready");
      out.push(
        build({ type: "team", id: t.id }, t.name, `${members.length} agents`, {
          tone: anyHere ? "ready" : "elsewhere",
          label: anyHere ? "runs here" : "no member runs here",
          hint: anyHere
            ? "At least one member's runtime is on this machine."
            : "None of this team's runtimes are on this machine, so its work runs on teammates' devices.",
        })
      );
    }

    return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [agents, teams, teamMembers, assignments, tools, tasks, memory, channels, projects]);

  const busy = rows.filter((r) => r.total > 0).length;

  return (
    <Card
      title="Workload"
      meta={rows.length > 0 && <span>{busy} of {rows.length} carrying work</span>}
    >
      <Runtimes tools={tools} />

      {rows.length === 0 && (
        <Empty>
          No agents yet. Anyone's agent can be put on anything here — a task, a channel, a
          memory entry, a pull request — and this is where that shows up.
        </Empty>
      )}

      <ul className="db-wl">
        {rows.map((row) => {
          const id = `${row.ref.type}:${row.ref.id}`;
          const open = openId === id;
          const summary = row.byKind
            .map((k) => `${k.n} ${(KIND_BY_TYPE[k.type]?.plural ?? k.type).toLowerCase()}`)
            .join(", ");

          const identity = (
            <>
              <Avatar name={row.name} id={row.ref.id} kind={row.kind} />
              <span className="db-wl-ident">
                <span className="db-wl-name">{row.name}</span>
                <span className="db-wl-sub">{row.sub}</span>
              </span>
              <span className="db-wl-counts">
                {row.byKind.map((k) => {
                  const spec = KIND_BY_TYPE[k.type];
                  return (
                    <span
                      className="db-kind"
                      key={k.type}
                      title={`${k.n} ${(spec?.plural ?? k.type).toLowerCase()}`}
                    >
                      <span className="db-kind-glyph" style={{ color: spec?.tone }} aria-hidden="true">
                        {spec?.glyph ?? "•"}
                      </span>
                      {k.n}
                    </span>
                  );
                })}
                {row.total === 0 && <span className="db-wl-none">nothing assigned</span>}
              </span>
              <span className={`db-avail db-avail-${row.avail.tone}`} title={row.avail.hint}>
                {row.avail.label}
              </span>
            </>
          );

          return (
            <li key={id} className="db-wl-item">
              {row.total > 0 ? (
                <button
                  type="button"
                  className="db-wl-row db-wl-toggle"
                  aria-expanded={open}
                  aria-controls={`${panelId}-${id}`}
                  onClick={() => setOpenId(open ? "" : id)}
                  aria-label={`${row.name}, ${summary}. ${row.avail.label}. ${
                    open ? "Hide" : "Show"
                  } what they are on.`}
                >
                  {identity}
                  <span className={"db-wl-caret" + (open ? " open" : "")} aria-hidden="true">
                    ›
                  </span>
                </button>
              ) : (
                <div className="db-wl-row">{identity}</div>
              )}

              {open && (
                <ul className="db-wl-work" id={`${panelId}-${id}`}>
                  {row.work.map((ref, i) => (
                    <li key={`${ref.type}:${ref.id}:${i}`}>
                      <EntityChip ref={ref} size="sm" showType onClick={inspect} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ── work summary ─────────────────────────────────────────────── */

const OPEN_STATUSES: TaskStatus[] = ["backlog", "todo"];

function WorkSummary() {
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const assignments = useStore((s) => s.assignments);
  const setView = useStore((s) => s.setView);

  const assignedIds = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) if (a.target_type === "task") set.add(a.target_id);
    return set;
  }, [assignments]);

  const today = startOfToday();
  const overdue = tasks
    .filter((t) => t.status !== "done" && t.due_date && dueTime(t.due_date) < today)
    .sort((a, b) => dueTime(a.due_date) - dueTime(b.due_date));
  const unassigned = tasks.filter(
    (t) => t.status !== "done" && !t.assignee_agent_id && !assignedIds.has(t.id)
  );

  const rows = projects.map((p) => {
    const mine = tasks.filter((t) => t.project_id === p.id);
    const open = mine.filter((t) => OPEN_STATUSES.includes(t.status)).length;
    const doing = mine.filter((t) => t.status === "doing").length;
    const done = mine.filter((t) => t.status === "done").length;
    return { project: p, open, doing, done, total: mine.length };
  });

  const totals = rows.reduce(
    (acc, r) => ({ open: acc.open + r.open, doing: acc.doing + r.doing, done: acc.done + r.done }),
    { open: 0, doing: 0, done: 0 }
  );

  return (
    <Card
      title="Work"
      meta={
        totals.open + totals.doing + totals.done > 0 && (
          <span>
            {totals.open + totals.doing} open · {totals.done} done
          </span>
        )
      }
    >
      {rows.length === 0 && (
        <Empty>No projects yet. Create one from the sidebar and its board shows up here.</Empty>
      )}

      <ul className="db-projects">
        {rows.map((r) => {
          const label = `${r.project.name}: ${r.open} to do, ${r.doing} in progress, ${r.done} done`;
          const pct = (n: number) => (r.total ? (n / r.total) * 100 : 0);
          return (
            <li key={r.project.id} className="db-project">
              <div className="db-project-top">
                <span className="db-project-name">{r.project.name}</span>
                <span className="db-project-counts">
                  {r.total === 0 ? (
                    <span className="db-project-zero">no tasks</span>
                  ) : (
                    <>
                      <span>
                        <b>{r.open}</b> to do
                      </span>
                      <span>
                        <b>{r.doing}</b> doing
                      </span>
                      <span>
                        <b>{r.done}</b> done
                      </span>
                    </>
                  )}
                </span>
              </div>
              <div className="db-bar" role="img" aria-label={label}>
                {r.total === 0 ? (
                  <span className="db-bar-seg db-bar-empty" style={{ width: "100%" }} />
                ) : (
                  <>
                    <span className="db-bar-seg db-bar-open" style={{ width: `${pct(r.open)}%` }} />
                    <span className="db-bar-seg db-bar-doing" style={{ width: `${pct(r.doing)}%` }} />
                    <span className="db-bar-seg db-bar-done" style={{ width: `${pct(r.done)}%` }} />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {rows.length > 0 && (
        <div className="db-legend" aria-hidden="true">
          <span className="db-legend-item">
            <span className="db-legend-dot db-bar-open" /> to do
          </span>
          <span className="db-legend-item">
            <span className="db-legend-dot db-bar-doing" /> in progress
          </span>
          <span className="db-legend-item">
            <span className="db-legend-dot db-bar-done" /> done
          </span>
        </div>
      )}

      {(overdue.length > 0 || unassigned.length > 0) && (
        <div className="db-flags">
          {overdue.length > 0 && (
            <div className="db-flag db-flag-overdue">
              <div className="db-flag-head">
                {overdue.length} overdue
                <button
                  type="button"
                  className="db-flag-go"
                  onClick={() => setView({ type: "tasks" })}
                >
                  Open board
                </button>
              </div>
              <ul className="db-chiprow">
                {overdue.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <EntityChip ref={{ type: "task", id: t.id }} size="sm" />
                  </li>
                ))}
                {overdue.length > 6 && <li className="db-more">+{overdue.length - 6} more</li>}
              </ul>
            </div>
          )}
          {unassigned.length > 0 && (
            <div className="db-flag">
              <div className="db-flag-head">
                {unassigned.length} with nobody on {unassigned.length === 1 ? "it" : "them"}
              </div>
              <ul className="db-chiprow">
                {unassigned.slice(0, 6).map((t) => (
                  <li key={t.id}>
                    <EntityChip ref={{ type: "task", id: t.id }} size="sm" />
                  </li>
                ))}
                {unassigned.length > 6 && <li className="db-more">+{unassigned.length - 6} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── activity feed ────────────────────────────────────────────── */

interface FeedItem {
  key: string;
  at: number;
  /**
   * Who did it, as its own field.
   *
   * It used to be the first word of `verb` — "Iris replied in #frontend",
   * "Ada finished in 40s", "An agent linked" — which meant the one thing you
   * scan an activity feed for was at a different horizontal position on every
   * row, buried in a sentence set in --text-dim. Forty rows of that is a wall
   * of grey prose with the answer hidden somewhere in each line. Split out, it
   * gets a column and a weight, and the feed can be read down the actor.
   *
   * Empty for the things nobody did: a memory edit, a link the system drew.
   */
  actor?: string;
  verb: string;
  refs: EntityRef[];
  /** Rendered between two chips, for a link's relation. */
  joiner?: string;
}

/**
 * Messages load per channel on demand and runs are only cached once something
 * asks for them, so at launch the store knows almost nothing about the past.
 * One pass fills in the recent slice; after that the store stays current on
 * its own and the feed is pure projection.
 */
function usePrimeFeed(): void {
  const loadMessages = useStore((s) => s.loadMessages);
  const loadRun = useStore((s) => s.loadRun);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const db = await getDb();
        const chans = await db.select<{ channel_id: string }[]>(
          "SELECT channel_id FROM messages GROUP BY channel_id ORDER BY MAX(created_at) DESC LIMIT 4"
        );
        if (!live) return;
        await Promise.all(chans.map((c) => loadMessages(c.channel_id)));
        const runIds = await db.select<{ id: string }[]>(
          "SELECT id FROM runs WHERE finished_at > 0 ORDER BY finished_at DESC LIMIT 10"
        );
        if (!live) return;
        await Promise.all(runIds.map((r) => loadRun(r.id)));
      } catch {
        // The feed degrades to whatever the store already holds, which on a
        // fresh launch is "nothing yet" — an honest answer, not an error.
      }
    })();
    return () => {
      live = false;
    };
  }, [loadMessages, loadRun]);
}

function ActivityFeed() {
  const messages = useStore((s) => s.messages);
  const runs = useStore((s) => s.runs);
  const memory = useStore((s) => s.memory);
  const links = useStore((s) => s.links);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const inspect = useInspect();

  const items = useMemo<FeedItem[]>(() => {
    const out: FeedItem[] = [];

    for (const list of Object.values(messages)) {
      // Only the tail of each channel can possibly make the cut.
      for (const m of list.slice(-12)) {
        const chan = channels.find((c) => c.id === m.channel_id);
        const who = m.author_name || (m.author_type === "user" ? "You" : "An agent");
        const did = m.author_type === "user" ? "wrote" : m.author_type === "agent" ? "replied" : "posted";
        out.push({
          key: `m:${m.id}`,
          at: m.created_at,
          actor: who,
          verb: `${did}${chan ? ` in #${chan.name}` : ""}`,
          refs: [{ type: "message", id: m.id }],
        });
      }
    }

    for (const run of Object.values(runs)) {
      if (run.status === "running" || !run.finished_at) continue;
      const name = agents.find((a) => a.id === run.agent_id)?.name ?? "An agent";
      const outcome =
        run.status === "done"
          ? `finished in ${spokenDuration(run.finished_at - run.started_at)}`
          : run.status === "cancelled"
            ? "was cancelled"
            : "stopped with an error";
      out.push({
        key: `r:${run.id}`,
        at: run.finished_at,
        actor: name,
        verb: outcome,
        refs: [{ type: "run", id: run.id }],
      });
    }

    for (const m of memory) {
      const at = m.updated_at || m.created_at;
      // A second of slack: addMemory stamps both fields from the same clock.
      out.push({
        key: `mem:${m.id}`,
        at,
        verb: at > m.created_at + 1000 ? "Memory edited" : "Memory added",
        refs: [{ type: "memory", id: m.id }],
      });
    }

    for (const l of links) {
      out.push({
        key: `l:${l.id}`,
        at: l.created_at,
        verb: l.created_by === "user" ? "Linked" : "An agent linked",
        joiner: LINK_KIND_BY_ID[l.kind]?.label ?? "related to",
        refs: [
          { type: l.from_type, id: l.from_id },
          { type: l.to_type, id: l.to_id },
        ],
      });
    }

    return out.sort((a, b) => b.at - a.at).slice(0, 14);
  }, [messages, runs, memory, links, channels, agents]);

  return (
    <Card title="Recent activity">
      {items.length === 0 && (
        <Empty>
          Nothing has happened yet. Messages, finished runs, memory edits and links you draw
          all land here.
        </Empty>
      )}
      <ul className="db-feed">
        {items.map((it) => (
          <li key={it.key} className="db-feed-row">
            <span className="db-feed-when" title={new Date(it.at).toLocaleString()}>
              {timeAgo(it.at)}
            </span>
            <span className="db-feed-what">
              {it.actor && <span className="db-feed-actor">{it.actor}</span>}
              <span className="db-feed-verb">{it.verb}</span>
              {it.refs.map((ref, i) => (
                <span className="db-feed-ref" key={`${ref.type}:${ref.id}:${i}`}>
                  {i > 0 && it.joiner && <span className="db-feed-joiner">{it.joiner}</span>}
                  <EntityChip ref={ref} size="sm" onClick={inspect} />
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ── GitHub ───────────────────────────────────────────────────── */

/**
 * Is gh installed, signed in, and working?
 *
 * github.ts answers that once per session; this only holds the answer and
 * gives the user a way to ask again after fixing something in a terminal.
 * Three states matter because they need three different sentences, and the old
 * panel could only tell them apart by guessing from a failed query.
 */
function useGhCapability(): [GhCapability | null, () => void] {
  const [cap, setCap] = useState<GhCapability | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void ghCapability().then((c) => {
      if (live) setCap(c);
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  const recheck = useCallback(() => {
    ghRefresh();
    setCap(null);
    setAttempt((n) => n + 1);
  }, []);

  return [cap, recheck];
}

interface GhQuery<T> {
  /** `null` means unanswered — still running, or not started yet. */
  data: T | null;
  /** gh's own stderr, verbatim. Empty when nothing is wrong. */
  error: string;
  /** The command that produced `error`, so a note can show what was tried. */
  command: string;
  retry: () => void;
}

/**
 * One gh query, with its own loading, its own data and its own failure.
 *
 * Per query rather than per panel because these sections ask GitHub different
 * questions through different endpoints and fail independently: search has its
 * own rate limit, a repo can have issues switched off while its pull requests
 * are fine. The panel used to share a single `error` string and hide every
 * section when it was set, so one unlucky query blanked the repo list and every
 * project card with it.
 *
 * There is deliberately no run-once ref here. There was one, and because React
 * runs effects twice in development the second pass returned early while the
 * first pass's cleanup had already marked its results stale — so nothing was
 * ever stored and the sections sat on their skeletons forever. Re-running is
 * the correct behaviour, and the shared cache in github.ts makes the repeat
 * call free: it joins the first call's promise instead of spawning gh again.
 *
 * `run` is a dependency, so callers must pass a stable function — a top-level
 * query, or one wrapped in useCallback.
 */
function useGhQuery<T>(run: () => Promise<T>, enabled: boolean): GhQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [command, setCommand] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    run().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError("");
        setCommand("");
      },
      (e: unknown) => {
        if (!live) return;
        setData(null);
        setError(errorText(e) || "gh failed without saying why.");
        setCommand(ghCommand(e));
      }
    );
    return () => {
      live = false;
    };
  }, [run, enabled, attempt]);

  // Clearing the error first puts the skeleton back, so a retry looks like the
  // work it is. github.ts drops failed entries immediately, so this really does
  // re-run gh rather than replay the cached failure.
  const retry = useCallback(() => {
    setError("");
    setCommand("");
    setAttempt((n) => n + 1);
  }, []);

  return { data, error, command, retry };
}

/**
 * Something the GitHub sections need to say that is not data.
 *
 * The command sits in the note because a failure the user cannot reproduce is
 * a failure they cannot fix: `db-note-cmd` is `user-select: all`, so it can go
 * straight into a terminal.
 */
function GhNote({
  tone,
  title,
  cmd,
  onRetry,
  retryLabel = "Try again",
  children,
}: {
  tone: "info" | "warn";
  title: string;
  cmd?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className={`db-note db-note-${tone}`}>
      <div className="db-note-title">{title}</div>
      <p className="db-note-body">{children}</p>
      {cmd && <code className="db-note-cmd">{cmd}</code>}
      {onRetry && (
        <div>
          <button type="button" className="btn tiny" onClick={onRetry}>
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The body of one GitHub column.
 *
 * Skeleton, then one of three endings: rows, an empty line, or a failure that
 * names what it tried and what came back. "Nothing waiting on you" and "we
 * could not ask" are different facts and must never render the same way — an
 * empty list where a question failed is the whole bug this panel had.
 */
function GhList<T>({
  q,
  what,
  loading,
  empty,
  rows,
  skeletonRows = 3,
}: {
  q: GhQuery<T[]>;
  what: string;
  loading: string;
  empty: string;
  rows: (items: T[]) => ReactNode;
  skeletonRows?: number;
}) {
  if (q.error) {
    return (
      <GhNote tone="warn" title={`Could not load ${what}`} cmd={q.command} onRetry={q.retry}>
        {q.error}
      </GhNote>
    );
  }
  if (!q.data) return <Skeleton rows={skeletonRows} label={loading} />;
  if (q.data.length === 0) return <Empty>{empty}</Empty>;
  return <>{rows(q.data)}</>;
}

function PRRow({ pr }: { pr: SearchPR }) {
  return (
    <a className="db-row" href={pr.url} target="_blank" rel="noreferrer">
      <span className={"db-dot db-dot-pr" + (pr.isDraft ? " draft" : "")} aria-hidden="true" />
      <span className="db-row-title">{pr.title}</span>
      <span className="db-row-sub">
        {pr.repository.nameWithOwner} #{pr.number} · {timeAgo(pr.updatedAt)}
      </span>
    </a>
  );
}

function GitHubPanel() {
  const projects = useStore((s) => s.projects);
  const [cap, recheck] = useGhCapability();

  // The probe is authoritative: the store's tool check only looks for a file on
  // PATH, which says nothing about whether gh can actually answer.
  const ready = cap?.state === "ready";
  // While the probe is in flight the sections show skeletons rather than a
  // verdict, because "we have not asked yet" is not "there is nothing here".
  const usable = cap === null || ready;

  const prs = useGhQuery(myOpenPRs, ready);
  const reviews = useGhQuery(reviewRequests, ready);
  const repos = useGhQuery(listMyRepos, ready);

  const linked = projects.filter((p) => p.repo);

  return (
    <>
      <Card
        title="GitHub"
        icon={<IconGitHub size={15} />}
        meta={
          cap?.state === "ready"
            ? `gh ${cap.version}${cap.login ? ` · ${cap.login}` : ""}`
            : undefined
        }
      >
        {cap?.state === "missing" && (
          <GhNote
            tone="info"
            title="GitHub is optional, and gh is not on this machine"
            cmd="brew install gh && gh auth login"
            onRetry={recheck}
            retryLabel="Check again"
          >
            Spaces reads pull requests, review requests and repos through the GitHub CLI. Install it
            and sign in once — everything else on this screen works without it.
          </GhNote>
        )}
        {cap?.state === "signed-out" && (
          <GhNote
            tone="warn"
            title="gh is installed but not signed in"
            cmd="gh auth login"
            onRetry={recheck}
            retryLabel="Check again"
          >
            {cap.detail} Sign in once in a terminal, then check again.
          </GhNote>
        )}
        {usable && (
          <div className="db-cols">
            <div className="db-sub">
              <h4 className="db-sub-title">My open pull requests</h4>
              <GhList
                q={prs}
                what="your open pull requests"
                loading="Loading your open pull requests…"
                empty="No open pull requests."
                rows={(list) => list.map((pr) => <PRRow key={pr.url} pr={pr} />)}
              />
            </div>
            <div className="db-sub">
              <h4 className="db-sub-title">Waiting on your review</h4>
              <GhList
                q={reviews}
                what="the reviews requested from you"
                loading="Loading review requests…"
                empty="Nothing waiting on you."
                rows={(list) => list.map((pr) => <PRRow key={pr.url} pr={pr} />)}
              />
            </div>
          </div>
        )}
      </Card>

      {usable &&
        linked.map((p) => (
          <ProjectRepoCard key={p.id} projectName={p.name} repo={p.repo} enabled={ready} />
        ))}

      {usable && (
        <Card title="Recent repos">
          <GhList
            q={repos}
            what="your repositories"
            loading="Loading repositories…"
            empty="No repositories came back."
            rows={(list) => (
              <div className="db-repo-grid">
                {list.slice(0, 12).map((r) => (
                  <a
                    key={r.nameWithOwner}
                    className="db-repo"
                    href={`https://github.com/${r.nameWithOwner}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="db-repo-name">
                      {r.name}
                      {r.isPrivate && <span className="db-tag">private</span>}
                    </span>
                    <span className="db-repo-desc">{r.description ?? ""}</span>
                    <span className="db-repo-foot">
                      <span>{r.primaryLanguage?.name ?? ""}</span>
                      <span>{timeAgo(r.updatedAt)}</span>
                    </span>
                  </a>
                ))}
              </div>
            )}
          />
        </Card>
      )}
    </>
  );
}

function ProjectRepoCard({
  projectName,
  repo,
  enabled,
}: {
  projectName: string;
  repo: string;
  /** False until the capability probe says gh can answer, so these cards do not
   *  spend two doomed subprocesses each on a machine without a working gh. */
  enabled: boolean;
}) {
  // Bound to `repo` so the query identity is stable across renders; the hook
  // re-runs only when the repo actually changes.
  const loadPRs = useCallback(() => repoPRs(repo), [repo]);
  const loadIssues = useCallback(() => repoIssues(repo), [repo]);
  // Two questions, two answers. A repo with issues disabled answers the first
  // and refuses the second, and the card used to report both as unreachable.
  const prs = useGhQuery(loadPRs, enabled);
  const issues = useGhQuery(loadIssues, enabled);

  return (
    <Card
      title={projectName}
      meta={
        <a
          className="db-repo-tag"
          href={`https://github.com/${repo}`}
          target="_blank"
          rel="noreferrer"
        >
          {repo}
        </a>
      }
    >
      <div className="db-cols">
        <div className="db-sub">
          <h4 className="db-sub-title">
            Open pull requests {prs.data ? `(${prs.data.length})` : ""}
          </h4>
          <GhList
            q={prs}
            what={`pull requests for ${repo}`}
            loading={`Loading pull requests for ${repo}…`}
            empty="None open."
            skeletonRows={2}
            rows={(list) =>
              list.slice(0, 6).map((pr) => (
                <a key={pr.url} className="db-row" href={pr.url} target="_blank" rel="noreferrer">
                  <span
                    className={"db-dot db-dot-pr" + (pr.isDraft ? " draft" : "")}
                    aria-hidden="true"
                  />
                  <span className="db-row-title">{pr.title}</span>
                  <span className="db-row-sub">
                    #{pr.number} · {pr.author.login} · {timeAgo(pr.updatedAt)}
                  </span>
                </a>
              ))
            }
          />
        </div>
        <div className="db-sub">
          <h4 className="db-sub-title">
            Open issues {issues.data ? `(${issues.data.length})` : ""}
          </h4>
          <GhList
            q={issues}
            what={`issues for ${repo}`}
            loading={`Loading issues for ${repo}…`}
            empty="None open."
            skeletonRows={2}
            rows={(list) =>
              list.slice(0, 6).map((is) => (
                <a key={is.url} className="db-row" href={is.url} target="_blank" rel="noreferrer">
                  <span className="db-dot db-dot-issue" aria-hidden="true" />
                  <span className="db-row-title">{is.title}</span>
                  <span className="db-row-sub">
                    #{is.number} · {is.author.login} · {timeAgo(is.updatedAt)}
                  </span>
                </a>
              ))
            }
          />
        </div>
      </div>
    </Card>
  );
}

/* ── quick actions ────────────────────────────────────────────── */

type QuickKind = "task" | "memory" | "channel";

const MEMORY_KINDS: { kind: MemoryKind; label: string }[] = [
  { kind: "decision", label: "Decision" },
  { kind: "context", label: "Context" },
  { kind: "note", label: "Note" },
];

function ProjectPicker({
  value,
  onChange,
  ids,
}: {
  value: string;
  onChange: (id: string) => void;
  ids: { id: string; name: string }[];
}) {
  if (ids.length < 2) return null;
  return (
    <Field label="Project">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {ids.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function QuickModal({ kind, onClose }: { kind: QuickKind; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const addTask = useStore((s) => s.addTask);
  const addMemory = useStore((s) => s.addMemory);
  const addChannel = useStore((s) => s.addChannel);
  const setView = useStore((s) => s.setView);

  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [memKind, setMemKind] = useState<MemoryKind>("note");
  const [saving, setSaving] = useState(false);

  const label = kind === "task" ? "New task" : kind === "memory" ? "New memory entry" : "New channel";
  const name = kind === "channel" ? slug(title) : title.trim();

  async function save() {
    if (!name || saving) return;
    setSaving(true);
    try {
      if (kind === "task") {
        await addTask({
          project_id: projectId,
          title: name,
          description: body,
          status: "todo",
          assignee_agent_id: assignee,
        });
        toast.show({
          kind: "success",
          title: `Added “${name}”`,
          action: { label: "Open board", run: () => setView({ type: "tasks" }) },
        });
      } else if (kind === "memory") {
        await addMemory({ project_id: projectId, title: name, content: body, kind: memKind });
        toast.show({
          kind: "success",
          title: `Saved “${name}”`,
          detail: "Every agent run in this project sees it from now on.",
          action: { label: "Open memory", run: () => setView({ type: "memory" }) },
        });
      } else {
        const chan = await addChannel(projectId, name, body);
        setView({ type: "channel", channelId: chan.id });
      }
      onClose();
    } catch (e) {
      toast.error(`Could not create that ${kind}`, e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={label} onClose={onClose} wide={kind === "memory"}>
      <ProjectPicker value={projectId} onChange={setProjectId} ids={projects} />

      <Field label={kind === "channel" ? "Name" : "Title"}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            kind === "task"
              ? "Ship the settings redesign"
              : kind === "memory"
                ? "We use pnpm, not npm"
                : "frontend"
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && kind !== "memory") void save();
          }}
        />
      </Field>
      {kind === "channel" && name && name !== title.trim() && (
        <p className="db-hint">Channels are lowercase and hyphenated: #{name}</p>
      )}

      {kind === "memory" && (
        <Field label="Kind">
          <select value={memKind} onChange={(e) => setMemKind(e.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      {kind === "task" && agents.length > 0 && (
        <Field label="Assignee">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Nobody yet</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label={kind === "channel" ? "Topic" : kind === "memory" ? "Content" : "Description"}>
        <textarea
          rows={kind === "memory" ? 8 : 3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            kind === "channel" ? "What this channel is for" : "Anything an agent should know"
          }
        />
      </Field>

      <div className="db-modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!name || saving} onClick={() => void save()}>
          {saving ? "Saving…" : label}
        </button>
      </div>
    </Modal>
  );
}

function QuickActions({ onPick }: { onPick: (k: QuickKind) => void }) {
  const hasProject = useStore((s) => s.projects.length > 0);
  const setView = useStore((s) => s.setView);

  const pick = (k: QuickKind) => {
    if (!hasProject) {
      toast.info(
        "Create a project first",
        "Tasks, memory and channels all live inside a project — use ＋ next to Projects in the sidebar."
      );
      return;
    }
    onPick(k);
  };

  return (
    <div className="db-actions">
      <button type="button" className="btn" onClick={() => pick("task")}>
        <IconTasks size={13} /> Task
      </button>
      <button type="button" className="btn" onClick={() => pick("memory")}>
        <IconMemory size={13} /> Memory
      </button>
      <button type="button" className="btn" onClick={() => pick("channel")}>
        <IconPlus size={13} /> Channel
      </button>
      <button type="button" className="btn" onClick={() => setView({ type: "graph" })}>
        <IconBranch size={13} /> Graph
      </button>
    </div>
  );
}

/* ── the screen ───────────────────────────────────────────────── */

/* ── the launcher ─────────────────────────────────────────────── */

/**
 * Ask for work, from the surface you land on.
 *
 * This is the thing the dashboard was missing, and it is not a small thing:
 * the whole product is a workspace where you hand work to agents, and the
 * screen every launch opens on was a **read-only report about that having
 * already happened**. Every route to actually starting something ran through
 * finding a channel in the rail first, then remembering the agent's handle,
 * then typing an @mention. The dashboard summarised the work and offered no
 * way to cause any.
 *
 * So: say what you want, pick who does it, press return. It posts into that
 * agent's channel exactly as if you had typed it there — the same
 * insertMessage + triggerAgents pair ChatView uses, deliberately, so there is
 * one dispatch path in the app and this cannot drift from it — and then takes
 * you to the channel, because the next thing you want is to watch it work.
 */
function Launch() {
  const store = useStore();
  const { agents, channels, projects } = store;
  const setView = useStore((s) => s.setView);
  const [text, setText] = useState("");
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  /* An agent can only be handed work in a channel it is actually in, so the
     roster here is agents that have one — not every agent on the workspace.
     Offering a name that cannot be dispatched is worse than not offering it. */
  const reachable = useMemo(() => {
    const out: { agent: Agent; channelId: string; channelName: string }[] = [];
    for (const agent of agents) {
      const channel = channels.find((c) =>
        channelAgents(store, c.id).some((a) => a.id === agent.id)
      );
      if (channel) out.push({ agent, channelId: channel.id, channelName: channel.name });
    }
    return out;
  }, [agents, channels, store]);

  const pick = reachable.find((r) => r.agent.id === who) ?? reachable[0];

  if (!reachable.length) return null;

  async function go() {
    const content = text.trim();
    if (!content || !pick || busy) return;
    setBusy(true);
    try {
      // The handle is what routes it. resolveTargets reads the @mention out of
      // the message body, so the mention has to be *in* the text rather than
      // carried beside it — same as typing it by hand.
      const handle = slug(pick.agent.name);
      const body = content.includes(`@${handle}`) ? content : `@${handle} ${content}`;
      const msg = await store.insertMessage({
        id: uid(),
        channel_id: pick.channelId,
        author_type: "user",
        author_id: "user",
        author_name: store.self().name,
        content: body,
        status: "done",
        meta: "",
        parent_id: "",
      });
      void triggerAgents(pick.channelId, userTrigger(msg));
      setText("");
      setView({ type: "channel", channelId: pick.channelId });
    } catch (e) {
      toast.error("Could not hand that over", e);
    } finally {
      setBusy(false);
    }
  }

  const project = projects.find((p) => p.id === channels.find((c) => c.id === pick?.channelId)?.project_id);

  return (
    <section className="db-launch">
      <textarea
        ref={box}
        className="db-launch-input"
        rows={2}
        placeholder="What do you want done?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Return sends; shift-return is a newline. The same contract as the
          // composer, so the muscle memory carries.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void go();
          }
        }}
      />
      <div className="db-launch-foot">
        <div className="db-launch-who" role="group" aria-label="Who does it">
          {reachable.slice(0, 6).map((r) => (
            <button
              key={r.agent.id}
              type="button"
              className={"db-who" + (r.agent.id === pick?.agent.id ? " on" : "")}
              onClick={() => setWho(r.agent.id)}
              title={`${r.agent.name} — ${r.agent.role || "agent"} · #${r.channelName}`}
            >
              <Avatar id={r.agent.id} name={r.agent.name} kind={r.agent.kind} />
              {r.agent.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn primary db-launch-go"
          disabled={!text.trim() || busy}
          onClick={() => void go()}
        >
          {busy ? "Handing over…" : "Hand it over"}
        </button>
      </div>
      {pick && (
        <p className="db-launch-note">
          Goes to <strong>#{pick.channelName}</strong>
          {project ? ` in ${project.name}` : ""} — you can watch it there.
        </p>
      )}
    </section>
  );
}

/* ── the status band ──────────────────────────────────────────── */

/**
 * The four numbers the dashboard exists to answer, in one row.
 *
 * This replaces the way the page used to open. "Waiting on you" was a
 * full-width dashed panel and "Right now" was a heading with a paragraph under
 * it — and on the overwhelmingly common launch where both are empty, they
 * spent the top two hundred pixels of the landing surface saying *nothing is
 * happening* twice, at length. An empty queue is not a thing to explain; it is
 * a zero.
 *
 * A band of counters is the same height whether the workspace is idle or on
 * fire, which is the property the old opening lacked and the reason it looked
 * broken when empty. The sections below it now render only when they have
 * something in them, so the page grows downward from a constant header rather
 * than starting with two apologies.
 *
 * Each tile is a destination. A number you cannot act on is a decoration.
 */
function StatusBand() {
  const setView = useStore((s) => s.setView);
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const activeRunIds = useStore((s) => s.activeRunIds);
  const waiting = usePendingActionCount();

  const open = tasks.filter((t) => t.status !== "done").length;
  const running = activeRunIds.length;
  const ready = agents.filter((a) => a.kind !== "ritz").length;

  const tiles: {
    key: string;
    n: number;
    label: string;
    sub: string;
    tone?: "accent" | "live";
    go: () => void;
  }[] = [
    {
      key: "waiting",
      n: waiting,
      label: waiting === 1 ? "Waiting on you" : "Waiting on you",
      sub: waiting ? "needs a yes" : "nothing to approve",
      tone: waiting ? "accent" : undefined,
      go: () => setView({ type: "dashboard" }),
    },
    {
      key: "running",
      n: running,
      label: "Running now",
      sub: running ? "live on a machine" : "no agent is working",
      tone: running ? "live" : undefined,
      go: () => setView({ type: "agents" }),
    },
    {
      key: "open",
      n: open,
      label: "Open work",
      sub: open ? "across every project" : "the board is clear",
      go: () => setView({ type: "tasks" }),
    },
    {
      key: "roster",
      n: ready,
      label: ready === 1 ? "Teammate" : "Teammates",
      sub: "on the roster",
      go: () => setView({ type: "agents" }),
    },
  ];

  return (
    <div className="db-band">
      {tiles.map((t) => (
        <button
          key={t.key}
          type="button"
          className={"db-tile" + (t.tone ? ` db-tile-${t.tone}` : "")}
          onClick={t.go}
        >
          <span className="db-tile-n num">{t.n}</span>
          <span className="db-tile-label">{t.label}</span>
          <span className="db-tile-sub">{t.sub}</span>
        </button>
      ))}
    </div>
  );
}

export function DashboardView() {
  const [quick, setQuick] = useState<QuickKind | null>(null);
  const waiting = usePendingActionCount();
  const activeRunIds = useStore((s) => s.activeRunIds);
  usePrimeFeed();

  return (
    <div className="main-pane scroll-pane">
      {/* Title and actions, and nothing else. The runtime readout that used to
          live under the title has moved to the one section it explains, which
          takes 34px off the top of every launch of this app. */}
      <div className="pane-header">
        <div className="pane-title">Dashboard</div>
        <QuickActions onPick={setQuick} />
      </div>

      <div className="db-body">
        {/* Hides itself once the four steps are done, on this and every later launch. */}
        <FirstRunChecklist />

        {/* Ask first, report second. */}
        <Launch />
        <StatusBand />

        {/* Both of these used to render unconditionally and spend a band each
            saying they were empty. The status band above carries the zero now,
            so they appear only when they have something — which is what makes
            the page grow from a constant header instead of opening on two
            explanations of nothing. */}
        {waiting > 0 && <ActionQueue />}
        {activeRunIds.length > 0 && <LiveStrip />}
        <div className="db-cols">
          <WorkloadCard />
          <WorkSummary />
        </div>
        <ActivityFeed />
        <GitHubPanel />
      </div>

      {quick && <QuickModal kind={quick} onClose={() => setQuick(null)} />}
    </div>
  );
}
