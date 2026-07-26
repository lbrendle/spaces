/**
 * The human side of agents having write access.
 *
 * `hqops.ts` says what an agent may do and `actions.ts` does it; this is where
 * a person sees it. Four surfaces, one vocabulary:
 *
 *   ActionQueue       proposals waiting for a yes
 *   ActionQueueBadge  how many, without opening anything
 *   ActionLog         everything that was applied, turned down or failed
 *   ActionSummary     one line under an agent's message: what that run wrote
 *
 * Nothing here renders an operation by its wire name. "hq_update_task" with
 * `{assignee}` set is a person taking a task off someone, and the queue has to
 * say so — approving a change you had to decode first is not consent. Every row
 * is built back into a sentence from the op's own parameters, with the things
 * it touches rendered as live EntityChips so the board and this list can never
 * disagree about what something is called.
 *
 * The split between "applies immediately" and "waits here" is hqops' `effect`,
 * not a setting: filing a task or drawing a link is additive and costs a click
 * to undo, while reassigning or removing existing work is the kind of quiet
 * wrongness that makes agent-driven mutation untrustworthy. That's the model
 * the empty state explains, because a queue that is usually empty still has to
 * teach what it is for.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  approveAction,
  argsOf,
  pendingActions,
  recentActions,
  rejectAction,
  subscribeActions,
} from "../actions";
import type { AgentActionRow } from "../actions";
import { OP_BY_NAME, resolveRef } from "../hqops";
import type { OpContext } from "../hqops";
import { describeEntity } from "../entities";
import { LINK_KIND_BY_ID } from "../links";
import { useStore } from "../store";
import { confirmAction, errorText, toast } from "../toast";
import { timeAgo } from "../github";
import type { EntityRef, EntityType, LinkKind } from "../types";
import { EntityChip } from "./EntityChip";
import { IconBolt, IconCheck, IconX } from "./icons";
import { Avatar, Spinner } from "./ui";
import "./actions.css";

/* ── the ledger row ───────────────────────────────────────────── */

/**
 * A row of `agent_actions`. Aliased rather than redeclared so the queue and the
 * applier can never disagree about the shape of the record they are both
 * looking at — and so a column added to the table is a one-line change there,
 * not a silent divergence here.
 *
 * Reads are never recorded (actions.ts answers them without a row), so
 * everything that reaches this file changed something or tried to.
 */
export type ActionRow = AgentActionRow;

/* ── one shared read of the ledger ────────────────────────────── */

/**
 * ActionSummary lands under every agent message in a channel, so a per-instance
 * query would mean one round trip per message on every re-render. Every hook in
 * this file reads the same snapshot instead, refreshed when actions.ts says
 * something moved.
 */
interface Feed {
  pending: ActionRow[];
  recent: ActionRow[];
  /** 0 until the first read lands, so a view can tell "empty" from "not yet". */
  at: number;
}

/** Deep enough for a day of agent work; ActionLog raises it if it asks for more. */
const RECENT = 80;

let feed: Feed = { pending: [], recent: [], at: 0 };
let want = RECENT;
const watchers = new Set<() => void>();
let offBus: (() => void) | null = null;
let coalesce: number | null = null;
let inFlight = false;
let queued = false;
/** A ledger that cannot be read is worth saying once, not once per reload. */
let complained = false;

function announce(): void {
  for (const fn of [...watchers]) {
    try {
      fn();
    } catch {
      // one bad watcher must not stop the others
    }
  }
}

async function read(): Promise<void> {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  try {
    // actions.ts may answer from memory or from SQLite; awaiting covers both
    // without this file needing to know which.
    const [pending, recent] = await Promise.all([
      Promise.resolve(pendingActions()),
      Promise.resolve(recentActions(want)),
    ]);
    feed = { pending: pending ?? [], recent: recent ?? [], at: Date.now() };
    complained = false;
    announce();
  } catch (e) {
    if (!complained) {
      complained = true;
      toast.error("Could not read the agent action log", e);
    }
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      void read();
    }
  }
}

/** Coalesce the burst that a five-op run, or twenty mounting summaries, causes. */
function refresh(): void {
  if (coalesce !== null) return;
  coalesce = window.setTimeout(() => {
    coalesce = null;
    void read();
  }, 40);
}

function watch(fn: () => void): () => void {
  watchers.add(fn);
  if (!offBus) {
    offBus = subscribeActions(refresh);
    // Agents write while the window is in the background, and coming back to it
    // is exactly the moment a stale count would mislead.
    window.addEventListener("focus", refresh);
  }
  if (!feed.at) refresh();
  return () => {
    watchers.delete(fn);
    if (!watchers.size && offBus) {
      offBus();
      offBus = null;
      window.removeEventListener("focus", refresh);
    }
  };
}

function snapshot(): Feed {
  return feed;
}

function useFeed(depth?: number): Feed {
  useEffect(() => {
    if (depth && depth > want) {
      want = depth;
      refresh();
    }
  }, [depth]);
  return useSyncExternalStore(watch, snapshot);
}

/* ── plain language ───────────────────────────────────────────── */

interface OpWords {
  /** Bare infinitive: "wants to **reassign**". */
  now: string;
  /** Past: "Ada **reassigned** …". */
  past: string;
  /** What one call produces, for the summary strip's "filed 2 tasks". */
  noun?: [string, string];
}

const OP_WORDS: Record<string, OpWords> = {
  hq_create_task: { now: "file", past: "filed", noun: ["task", "tasks"] },
  hq_update_task: { now: "edit", past: "edited", noun: ["task", "tasks"] },
  hq_link: { now: "link", past: "linked" },
  hq_unlink: { now: "disconnect", past: "disconnected" },
  hq_assign: { now: "put someone on", past: "assigned" },
  hq_add_memory: { now: "record", past: "recorded", noun: ["memory entry", "memory entries"] },
  hq_create_event: { now: "schedule", past: "scheduled", noun: ["event", "events"] },
  hq_post: { now: "post", past: "posted", noun: ["message", "messages"] },
};

/** An operation added to the registry after this file was written still reads. */
function wordsFor(op: string): OpWords {
  const known = OP_WORDS[op];
  if (known) return known;
  const plain = opLabel(op);
  return { now: plain, past: `ran ${plain}` };
}

function opLabel(op: string): string {
  return op.replace(/^hq_/, "").replace(/_/g, " ");
}

const STATUS_WORD: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

interface Detail {
  label: string;
  value: string;
}

/**
 * A row as a sentence with two holes in it:
 *
 *   {who} {verb} {lead} [a] {mid} [b] {tail}
 *
 * The holes take EntityChips where the argument resolved to something real and
 * plain text where it didn't — a proposal whose target was deleted an hour ago
 * still has to be readable enough to reject.
 */
interface Phrase {
  now: string;
  past: string;
  lead: string;
  a?: EntityRef;
  aText: string;
  mid: string;
  b?: EntityRef;
  bText: string;
  /** bText is a value the operation defines (a status, a role), not a lookup that failed. */
  bLiteral?: boolean;
  tail: string;
  details: Detail[];
}

function text(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function clamp(s: string, n = 140): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
}

function detail(label: string, value: string): Detail | null {
  return value ? { label, value } : null;
}

function kept(list: (Detail | null)[]): Detail[] {
  return list.filter((d): d is Detail => d !== null);
}

/** Best-effort chip for an argument the agent wrote as free text. */
function slot(raw: string, ctx: OpContext, types?: EntityType[]): { ref?: EntityRef; text: string } {
  if (!raw) return { text: "" };
  const { ref } = resolveRef(raw, ctx, types);
  return { ref, text: ref ? describeEntity(ref).title : raw };
}

/**
 * Applied operations report themselves as "Filed task:<id> — title", so the row
 * an agent actually created is recoverable even though the call only named it
 * by title. Anything that doesn't resolve to a live entity is dropped rather
 * than guessed at.
 */
const RESULT_REF = /\b(task|memory|event|message|channel|project|agent|team|run|workspace):([A-Za-z0-9_-]{4,})/;

function refFromResult(result: string): EntityRef | undefined {
  const m = RESULT_REF.exec(result || "");
  if (!m) return undefined;
  const ref: EntityRef = { type: m[1] as EntityType, id: m[2] };
  return describeEntity(ref).exists ? ref : undefined;
}

function whenText(raw: string): string {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw;
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function phraseFor(row: ActionRow): Phrase {
  const args = argsOf(row);
  const ctx: OpContext = {
    agentId: row.agent_id,
    projectId: row.project_id,
    channelId: row.channel_id,
  };
  const w = wordsFor(row.op);
  const made = refFromResult(row.result);
  const base: Phrase = {
    now: w.now,
    past: w.past,
    lead: "",
    aText: "",
    mid: "",
    bText: "",
    tail: "",
    details: [],
  };

  switch (row.op) {
    case "hq_create_task": {
      const who = slot(text(args, "assignee"), ctx, ["agent"]);
      return {
        ...base,
        a: made,
        aText: text(args, "title"),
        mid: who.text ? "for" : "",
        b: who.ref,
        bText: who.text,
        details: kept([
          detail("Status", STATUS_WORD[text(args, "status")] ?? ""),
          detail("Due", text(args, "due_date")),
          detail("Detail", clamp(text(args, "description"))),
        ]),
      };
    }

    case "hq_update_task": {
      const task = slot(text(args, "task"), ctx, ["task"]);
      const status = text(args, "status");
      const rest = kept([
        args.title !== undefined ? detail("New title", text(args, "title")) : null,
        args.description !== undefined
          ? detail("New description", clamp(text(args, "description")) || "cleared")
          : null,
        args.due_date !== undefined ? { label: "Due", value: text(args, "due_date") || "cleared" } : null,
      ]);

      // Taking a task off one agent and handing it to another is the single
      // most consequential thing this operation can do, so it leads whenever
      // it is part of the call.
      if (args.assignee !== undefined) {
        const to = slot(text(args, "assignee"), ctx, ["agent"]);
        const off = !to.text;
        return {
          ...base,
          now: off ? "unassign" : "reassign",
          past: off ? "unassigned" : "reassigned",
          a: task.ref,
          aText: task.text,
          mid: off ? "" : "to",
          b: to.ref,
          bText: to.text,
          details: kept([detail("Status", STATUS_WORD[status] ?? status), ...rest]),
        };
      }
      if (status) {
        return {
          ...base,
          now: "move",
          past: "moved",
          a: task.ref,
          aText: task.text,
          mid: "to",
          bText: STATUS_WORD[status] ?? status,
          bLiteral: true,
          details: rest,
        };
      }
      return { ...base, a: task.ref, aText: task.text, details: rest };
    }

    case "hq_link":
    case "hq_unlink": {
      const from = slot(text(args, "from"), ctx);
      const to = slot(text(args, "to"), ctx);
      const kind = LINK_KIND_BY_ID[text(args, "kind") as LinkKind];
      return {
        ...base,
        a: from.ref,
        aText: from.text,
        mid: row.op === "hq_link" ? kind?.label ?? "related to" : "from",
        b: to.ref,
        bText: to.text,
        details: kept([detail("Why", text(args, "note"))]),
      };
    }

    case "hq_assign": {
      const subject = slot(text(args, "subject"), ctx, ["agent", "team"]);
      const target = slot(text(args, "target"), ctx);
      const role = text(args, "role") || "owner";
      return {
        ...base,
        now: "make",
        past: "made",
        a: subject.ref,
        aText: subject.text,
        mid: `the ${role} of`,
        b: target.ref,
        bText: target.text,
      };
    }

    case "hq_add_memory":
      return {
        ...base,
        a: made,
        aText: text(args, "title"),
        details: kept([
          detail("Kind", text(args, "kind")),
          detail("Detail", clamp(text(args, "content"))),
        ]),
      };

    case "hq_create_event": {
      const about = slot(text(args, "about"), ctx);
      return {
        ...base,
        a: made,
        aText: text(args, "title"),
        mid: about.text ? "about" : "",
        b: about.ref,
        bText: about.text,
        details: kept([
          detail("When", whenText(text(args, "starts_at"))),
          detail("Calendar", text(args, "calendar")),
        ]),
      };
    }

    case "hq_post": {
      const channel = slot(text(args, "channel"), ctx, ["channel"]);
      return {
        ...base,
        lead: "to",
        a: channel.ref,
        aText: channel.text,
        details: kept([detail("Message", clamp(text(args, "content")))]),
      };
    }

    default:
      // Unknown op: name it plainly and show everything it carried, so a new
      // operation is legible here the day it lands rather than the day someone
      // remembers to teach this file about it.
      return {
        ...base,
        a: made,
        details: Object.entries(args).map(([label, value]) => ({
          label,
          value: clamp(String(value ?? "")),
        })),
      };
  }
}

/* ── tense ────────────────────────────────────────────────────── */

/**
 * A rejected proposal must not read as though it happened, and a failed one
 * must not read as though it was refused. Four tenses, one per status.
 */
type Tense = "wants" | "wanted" | "tried" | "did";

function tenseFor(status: string): Tense {
  return status === "applied" ? "did" : status === "rejected" ? "wanted" : status === "failed" ? "tried" : "wants";
}

function verbFor(p: Phrase, tense: Tense): string {
  if (tense === "did") return p.past;
  if (tense === "wants") return `wants to ${p.now}`;
  if (tense === "wanted") return `wanted to ${p.now}`;
  return `tried to ${p.now}`;
}

function titleOf(ref: EntityRef | undefined, fallback: string): string {
  return ref ? describeEntity(ref).title : fallback;
}

/** The same sentence as one string, for toasts and aria-labels. */
function sentence(p: Phrase, who: string, tense: Tense): string {
  return [
    who,
    verbFor(p, tense),
    p.lead,
    titleOf(p.a, p.aText),
    p.mid,
    titleOf(p.b, p.bText),
    p.tail,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

function nameOf(agentId: string): string {
  if (!agentId) return "Spaces";
  return useStore.getState().agents.find((a) => a.id === agentId)?.name ?? "A removed agent";
}

/* ── shared pieces ────────────────────────────────────────────── */

function Who({ agentId }: { agentId: string }) {
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === agentId);
  const name = agent?.name ?? (agentId ? "A removed agent" : "Spaces");
  return (
    <span className="aq-who">
      <Avatar name={name} id={agentId || "hq"} kind={agent?.kind} />
      <span className="aq-who-name">{name}</span>
    </span>
  );
}

function Slot({
  target,
  label,
  literal,
}: {
  target?: EntityRef;
  label: string;
  literal?: boolean;
}) {
  if (target) return <EntityChip ref={target} size="sm" />;
  if (!label) return null;
  return <span className={literal ? "aq-val" : "aq-lit"}>{label}</span>;
}

function Sentence({
  phrase,
  tense,
  who,
}: {
  phrase: Phrase;
  tense: Tense;
  who?: ReactNode;
}) {
  return (
    <span className="aq-say">
      {who}
      <span className="aq-verb">{verbFor(phrase, tense)}</span>
      {phrase.lead && <span className="aq-join">{phrase.lead}</span>}
      <Slot target={phrase.a} label={phrase.aText} />
      {phrase.mid && <span className="aq-join">{phrase.mid}</span>}
      <Slot target={phrase.b} label={phrase.bText} literal={phrase.bLiteral} />
      {phrase.tail && <span className="aq-join">{phrase.tail}</span>}
    </span>
  );
}

function Details({ details }: { details: Detail[] }) {
  if (!details.length) return null;
  return (
    <dl className="aq-detail">
      {details.map((d) => (
        <div className="aq-detail-pair" key={d.label}>
          <dt>{d.label}</dt>
          <dd>{d.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meta({ row, outcome }: { row: ActionRow; outcome?: string }) {
  const at = row.decided_at || row.created_at;
  return (
    <div className="aq-meta">
      <span className="aq-op" title={OP_BY_NAME[row.op]?.describe ?? row.op}>
        {opLabel(row.op)}
      </span>
      <time dateTime={new Date(at).toISOString()}>{timeAgo(at)}</time>
      {row.source && <span>via {row.source === "mcp" ? "MCP" : row.source}</span>}
      {outcome && <span className="aq-outcome">{outcome}</span>}
    </div>
  );
}

/* ── grouping ─────────────────────────────────────────────────── */

interface RunGroup {
  key: string;
  runId: string;
  agentId: string;
  rows: ActionRow[];
}

/**
 * By run, first-seen order kept. A run is the unit a person actually reasons
 * about — "this is what Ada did while answering me" — and it is what makes one
 * decision cover five related proposals.
 */
function groupByRun(rows: ActionRow[]): RunGroup[] {
  const by = new Map<string, RunGroup>();
  const out: RunGroup[] = [];
  for (const r of rows) {
    const key = r.run_id ? `run:${r.run_id}` : `one:${r.id}`;
    let g = by.get(key);
    if (!g) {
      g = { key, runId: r.run_id, agentId: r.agent_id, rows: [] };
      by.set(key, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

/* ── 1. the queue ─────────────────────────────────────────────── */

export interface ActionQueueProps {
  /** Narrow to one project; omit for everything waiting anywhere. */
  projectId?: string;
  /** Tighter type and spacing, for a rail or a popover. */
  compact?: boolean;
}

export function ActionQueue({ projectId, compact }: ActionQueueProps = {}) {
  const { pending, at } = useFeed();
  /** Row id, or group key while a whole run is being applied. */
  const [busy, setBusy] = useState("");

  const rows = useMemo(
    () =>
      pending
        .filter((r) => r.status === "pending" && (!projectId || r.project_id === projectId))
        .sort((a, b) => b.created_at - a.created_at),
    [pending, projectId]
  );
  const groups = useMemo(() => groupByRun(rows), [rows]);

  const decide = useCallback(async (row: ActionRow, yes: boolean) => {
    const said = sentence(phraseFor(row), nameOf(row.agent_id), yes ? "did" : "wanted");
    setBusy(row.id);
    try {
      // Both report failure in the result rather than by throwing; the catch is
      // for the unforeseen, not for "the operation said no".
      const res = yes ? await approveAction(row.id) : await rejectAction(row.id);
      if (!res.ok) {
        toast.error(yes ? "That did not apply" : "Could not turn that down", res.message);
      } else if (yes) {
        toast.success(said, res.message && res.message !== said ? res.message : undefined);
      } else {
        toast.show({ kind: "info", title: "Turned down", detail: said });
      }
    } catch (e) {
      toast.error(yes ? "Could not approve that" : "Could not reject that", e);
    } finally {
      setBusy("");
      // actions.ts emits on its own; re-reading costs one query and means a
      // transport that forgot to emit cannot strand a row on screen.
      refresh();
    }
  }, []);

  const approveRun = useCallback(async (g: RunGroup) => {
    const who = nameOf(g.agentId);
    const ok = await confirmAction({
      title: `Approve ${g.rows.length} changes from ${who}?`,
      body: "They apply oldest first, in the order they were proposed.",
      confirmLabel: `Approve ${g.rows.length}`,
    });
    if (!ok) return;

    setBusy(g.key);
    let applied = 0;
    const failed: string[] = [];
    // Oldest first: a later proposal in a run usually assumes an earlier one
    // landed, and applying them backwards would fail for the wrong reason.
    for (const row of [...g.rows].reverse()) {
      try {
        const res = await approveAction(row.id);
        if (res.ok) applied++;
        else failed.push(res.message || opLabel(row.op));
      } catch (e) {
        failed.push(errorText(e) || opLabel(row.op));
      }
    }
    setBusy("");
    refresh();
    if (failed.length) {
      toast.error(`${failed.length} of ${g.rows.length} did not apply`, failed.join(" · "));
    } else {
      toast.success(`Applied ${applied} change${applied === 1 ? "" : "s"} from ${who}`);
    }
  }, []);

  return (
    <section
      className={"aq" + (compact ? " aq-compact" : "")}
      aria-label="Agent proposals waiting for approval"
    >
      <header className="aq-head">
        <h3 className="aq-title">Waiting on you</h3>
        {rows.length > 0 && <span className="aq-count">{rows.length}</span>}
      </header>

      {rows.length === 0 ? (
        <QueueBlank ready={at > 0} />
      ) : (
        <ul className="aq-groups">
          {groups.map((g) => (
            <li className={"aq-group" + (g.rows.length > 1 ? " aq-group-run" : "")} key={g.key}>
              {g.rows.length > 1 && (
                <div className="aq-group-head">
                  <Who agentId={g.agentId} />
                  <span className="aq-group-note">
                    proposed {g.rows.length} changes in one run
                  </span>
                  <button
                    type="button"
                    className="aq-all"
                    disabled={!!busy}
                    onClick={() => void approveRun(g)}
                  >
                    {busy === g.key ? <Spinner /> : <IconCheck size={12} />}
                    Approve all
                  </button>
                </div>
              )}
              <ul className="aq-rows">
                {g.rows.map((row) => (
                  <QueueRow
                    key={row.id}
                    row={row}
                    named={g.rows.length === 1}
                    busy={busy === row.id}
                    frozen={!!busy}
                    onDecide={decide}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QueueRow({
  row,
  named,
  busy,
  frozen,
  onDecide,
}: {
  row: ActionRow;
  /** Show who proposed it — false inside a run group, where the header says. */
  named: boolean;
  busy: boolean;
  frozen: boolean;
  onDecide: (row: ActionRow, yes: boolean) => void | Promise<void>;
}) {
  // Resolved once per row: chips read the store live, so a rename after this
  // point still shows up. Only the un-resolvable fallback text can go stale.
  const phrase = useMemo(() => phraseFor(row), [row]);
  const said = useMemo(() => sentence(phrase, nameOf(row.agent_id), "wants"), [phrase, row.agent_id]);

  return (
    <li className="aq-row">
      <div className="aq-row-main">
        <Sentence
          phrase={phrase}
          tense="wants"
          who={named ? <Who agentId={row.agent_id} /> : undefined}
        />
        <Details details={phrase.details} />
        <Meta row={row} />
      </div>
      <div className="aq-acts">
        <button
          type="button"
          className="aq-yes"
          disabled={frozen}
          aria-label={`Approve — ${said}`}
          onClick={() => void onDecide(row, true)}
        >
          {busy ? <Spinner /> : <IconCheck size={12} />}
          Approve
        </button>
        <button
          type="button"
          className="aq-no"
          disabled={frozen}
          aria-label={`Reject — ${said}`}
          onClick={() => void onDecide(row, false)}
        >
          <IconX size={12} />
          Reject
        </button>
      </div>
    </li>
  );
}

/**
 * The queue is empty most of the time, which is the point — so the empty state
 * has to teach the model rather than just say "nothing here". Someone who has
 * just granted agents write access reads this to find out what they did and
 * did not just agree to.
 */
function QueueBlank({ ready }: { ready: boolean }) {
  return (
    <div className="aq-blank">
      <span className="aq-blank-glyph" aria-hidden="true">
        <IconBolt size={18} />
      </span>
      <p className="aq-blank-lead">
        {ready ? "Nothing is waiting on you." : "Reading the action log…"}
      </p>
      <p className="aq-blank-text">
        Agents file tasks, draw links, record memory and put things on calendars
        on their own — additive work lands straight on the board, and undoing a
        wrong one is a click.
      </p>
      <p className="aq-blank-text">
        Anything that reassigns, removes or overwrites what is already there
        stops here first and waits for a yes. Either way it is recorded in the
        log, whether it applied, you turned it down, or it failed.
      </p>
    </div>
  );
}

/* ── 2. the badge ─────────────────────────────────────────────── */

export interface ActionQueueBadgeProps {
  /** Narrow to one project; omit to count everything. */
  projectId?: string;
  /** Makes the badge a button — usually "open the queue". */
  onClick?: () => void;
}

/** Renders nothing at zero: an empty queue must not take up a slot in the chrome. */
export function ActionQueueBadge({ projectId, onClick }: ActionQueueBadgeProps = {}) {
  const { pending } = useFeed();
  const n = useMemo(
    () =>
      pending.filter((r) => r.status === "pending" && (!projectId || r.project_id === projectId))
        .length,
    [pending, projectId]
  );

  if (!n) return null;
  const label = `${n} agent ${n === 1 ? "proposal" : "proposals"} waiting for you`;
  const shown = n > 99 ? "99+" : String(n);

  if (onClick) {
    return (
      <button type="button" className="aq-badge aq-badge-btn" onClick={onClick} title={label} aria-label={label}>
        {shown}
      </button>
    );
  }
  return (
    <span className="aq-badge" role="status" title={label} aria-label={label}>
      {shown}
    </span>
  );
}

/* ── 3. the log ───────────────────────────────────────────────── */

export interface ActionLogProps {
  /** One run's ledger, for a run inspector; omit for the whole workspace. */
  runId?: string;
  limit?: number;
}

const OUTCOME: Record<string, string> = {
  applied: "Applied",
  rejected: "Turned down",
  failed: "Failed",
};

/**
 * The audit trail — the thing that makes granting write access defensible. It
 * is only worth anything if it is readable, so it groups by run (the unit of
 * "what happened when I asked for that") and gives failures their error text in
 * full rather than a status word.
 */
export function ActionLog({ runId, limit = RECENT }: ActionLogProps = {}) {
  const { recent, at } = useFeed(limit);

  const rows = useMemo(
    () =>
      recent
        .filter((r) => r.status !== "pending")
        .filter((r) => !runId || r.run_id === runId)
        .sort((a, b) => (b.decided_at || b.created_at) - (a.decided_at || a.created_at))
        .slice(0, limit),
    [recent, runId, limit]
  );
  const groups = useMemo(() => groupByRun(rows), [rows]);

  if (!rows.length) {
    return (
      <section className="aq-log" aria-label="Agent action log">
        <p className="aq-log-blank">
          {at === 0
            ? "Reading the action log…"
            : runId
              ? "This run did not change anything in the workspace."
              : "No agent has written anything yet. When one does, every change it makes — and every one you turn down — is recorded here."}
        </p>
      </section>
    );
  }

  return (
    <section className="aq-log" aria-label="Agent action log">
      <ul className="aq-groups">
        {groups.map((g) => {
          const bad = g.rows.filter((r) => r.status === "failed").length;
          const at = Math.max(...g.rows.map((r) => r.decided_at || r.created_at));
          return (
            <li className={"aq-group" + (bad ? " aq-group-bad" : "")} key={g.key}>
              <div className="aq-log-head">
                <Who agentId={g.agentId} />
                <span className="aq-tally">{tally(g.rows)}</span>
                <time className="aq-when" dateTime={new Date(at).toISOString()}>
                  {timeAgo(at)}
                </time>
              </div>
              <ul className="aq-rows">
                {g.rows.map((row) => (
                  <LogRow key={row.id} row={row} />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function tally(rows: ActionRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts]
    .map(([status, n]) => `${n} ${(OUTCOME[status] ?? status).toLowerCase()}`)
    .join(" · ");
}

function LogRow({ row }: { row: ActionRow }) {
  const phrase = useMemo(() => phraseFor(row), [row]);
  const tense = tenseFor(row.status);
  const failed = row.status === "failed";

  return (
    <li className={"aq-log-row" + (failed ? " aq-bad" : row.status === "rejected" ? " aq-off" : "")}>
      <span className="aq-dot" aria-hidden="true" />
      <div className="aq-row-main">
        <Sentence phrase={phrase} tense={tense} />
        {failed && row.result && <p className="aq-err">{row.result}</p>}
        <Meta row={row} outcome={OUTCOME[row.status] ?? row.status} />
      </div>
    </li>
  );
}

/* ── 4. the message footer ────────────────────────────────────── */

export interface ActionSummaryProps {
  runId: string;
  /**
   * Where the strip goes when clicked. Without one it opens the run in the
   * inspector, which is the closest thing to "show me what this did" that
   * needs no host to cooperate.
   */
  onOpen?: (target: "queue" | "log") => void;
}

/**
 * "Ada filed 2 tasks · linked 1 · 1 waiting on you" — one line under an agent's
 * message, because the moment you want to know what a run wrote is the moment
 * you are reading what it said.
 */
export function ActionSummary({ runId, onOpen }: ActionSummaryProps) {
  const { pending, recent } = useFeed();

  const { did, waiting, failed, agentId } = useMemo(() => {
    const seen = new Set<string>();
    const mine: ActionRow[] = [];
    for (const r of [...recent, ...pending]) {
      if (r.run_id !== runId || seen.has(r.id)) continue;
      seen.add(r.id);
      mine.push(r);
    }

    const applied = new Map<string, number>();
    let waiting = 0;
    let failed = 0;
    for (const r of mine) {
      if (r.status === "pending") waiting++;
      else if (r.status === "failed") failed++;
      else if (r.status === "applied") applied.set(r.op, (applied.get(r.op) ?? 0) + 1);
    }

    const did = [...applied].map(([op, n]) => {
      const w = wordsFor(op);
      const noun = w.noun ? ` ${n === 1 ? w.noun[0] : w.noun[1]}` : "";
      return `${w.past} ${n}${noun}`;
    });
    return { did, waiting, failed, agentId: mine[0]?.agent_id ?? "" };
  }, [recent, pending, runId]);

  if (!did.length && !waiting && !failed) return null;

  const open = (target: "queue" | "log") => {
    if (onOpen) onOpen(target);
    else useStore.getState().setInspect({ type: "run", id: runId });
  };

  const who = nameOf(agentId);
  const wrote = did.length ? `${who} ${did.join(" · ")}` : "";

  return (
    <span className="aq-sum">
      {wrote && (
        <button type="button" className="aq-sum-link" onClick={() => open("log")}>
          {wrote}
        </button>
      )}
      {failed > 0 && (
        <button type="button" className="aq-sum-link aq-sum-bad" onClick={() => open("log")}>
          {failed} failed
        </button>
      )}
      {waiting > 0 && (
        <button type="button" className="aq-sum-link aq-sum-wait" onClick={() => open("queue")}>
          {waiting} waiting on you
        </button>
      )}
    </span>
  );
}
