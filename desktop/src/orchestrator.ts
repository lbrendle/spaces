/**
 * The coordination layer.
 *
 * agents.ts knows how to run ONE agent for ONE turn. This module decides who
 * runs, in what order, and what happens when they finish:
 *
 *  - channel modes (broadcast / sequential / lead / panel)
 *  - a durable FIFO queue, so a mention that lands while an agent is busy is
 *    parked in SQLite instead of dropped (and survives a restart)
 *  - agent-to-agent chaining, with the loop guard
 *
 * Nothing in here spawns a process directly; everything goes through runAgent.
 */
import { getDb, uid, now } from "./db";
import { useStore } from "./store";
import { activeRunFor } from "./runbus";
import {
  MAX_CHAIN, initAgentListener, leadAgent, resolveMentions, resolveTargets,
  rosterAgents, runAgent,
} from "./agents";
import type { RunOptions, RunResult, Trigger } from "./agents";
import { boundedAll, acquireRunSlot, BudgetExceeded } from "./limits";
import { slug } from "./types";
import type { Agent, Channel, ChannelMode, QueuedItem } from "./types";

/** One parked turn: everything runAgent needs to run it later, verbatim. */
interface Job {
  trigger: Trigger;
  opts: RunOptions;
}

/** (channel, agent) → the promise driving that agent's current turn + drain. */
const inflight = new Map<string, Promise<void>>();

function key(channelId: string, agentId: string): string {
  return `${channelId}:${agentId}`;
}

function queued(agent: Agent): RunResult {
  return { runId: "", agentId: agent.id, agentName: agent.name, status: "queued", content: "" };
}

function usable(r: RunResult): boolean {
  return r.status === "done" && r.content.trim().length > 0;
}

/* ------------------------------------------------------------------ *
 * Queue depth — a tiny store-independent emitter the UI can subscribe to
 * ------------------------------------------------------------------ */

export type QueueSnapshot = Readonly<Record<string, number>>;

const depths = new Map<string, number>();
const listeners = new Set<(s: QueueSnapshot) => void>();
let snapshot: QueueSnapshot = {};

function emitQueue() {
  const next: Record<string, number> = {};
  for (const [k, v] of depths) if (v > 0) next[k] = v;
  snapshot = next;
  for (const fn of [...listeners]) {
    try {
      fn(snapshot);
    } catch {
      // a bad subscriber must not break the queue
    }
  }
}

function bumpDepth(channelId: string, agentId: string, delta: number) {
  const k = key(channelId, agentId);
  const next = Math.max(0, (depths.get(k) ?? 0) + delta);
  if (next) depths.set(k, next);
  else depths.delete(k);
  emitQueue();
}

function clearDepth(channelId: string, agentId: string) {
  if (depths.delete(key(channelId, agentId))) emitQueue();
}

/**
 * Subscribe to queue-depth changes. Returns an unsubscribe fn.
 * Pairs with getQueueSnapshot() for React's useSyncExternalStore — the
 * snapshot object identity only changes when a depth actually changes.
 */
export function subscribeQueue(fn: (s: QueueSnapshot) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getQueueSnapshot(): QueueSnapshot {
  return snapshot;
}

/** Items waiting for one agent, or for the whole channel when agentId is omitted. */
export function queueDepth(channelId: string, agentId?: string): number {
  if (agentId) return snapshot[key(channelId, agentId)] ?? 0;
  const prefix = `${channelId}:`;
  let n = 0;
  for (const [k, v] of Object.entries(snapshot)) if (k.startsWith(prefix)) n += v;
  return n;
}

/* ------------------------------------------------------------------ *
 * Durable queue
 * ------------------------------------------------------------------ */

async function enqueue(channelId: string, agent: Agent, trigger: Trigger, opts: RunOptions) {
  const db = await getDb();
  const job: Job = { trigger, opts };
  await db.execute(
    "INSERT INTO queue (id, channel_id, agent_id, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
    [uid(), channelId, agent.id, JSON.stringify(job), now()]
  );
  bumpDepth(channelId, agent.id, 1);

  // One heads-up per busy stretch, not one per message.
  if (queueDepth(channelId, agent.id) === 1) {
    await useStore.getState().insertMessage({
      id: uid(),
      channel_id: channelId,
      author_type: "system",
      author_id: "",
      author_name: "Spaces",
      content: `⏳ ${agent.name} is mid-run — queued. It runs as soon as the current turn finishes.`,
      status: "done",
      meta: "",
      parent_id: opts.parentId ?? trigger.parentId,
    });
  }
}

/**
 * Take everything parked for one agent and fold it into a single turn.
 * FIFO: rowid tie-breaks created_at so same-millisecond arrivals keep order.
 */
async function takeQueued(channelId: string, agentId: string): Promise<Job | null> {
  const db = await getDb();
  const rows = await db.select<QueuedItem[]>(
    "SELECT * FROM queue WHERE channel_id = $1 AND agent_id = $2 ORDER BY created_at, rowid",
    [channelId, agentId]
  );
  if (!rows.length) {
    clearDepth(channelId, agentId);
    return null;
  }
  const ph = rows.map((_, i) => `$${i + 1}`).join(",");
  await db.execute(`DELETE FROM queue WHERE id IN (${ph})`, rows.map((r) => r.id));
  bumpDepth(channelId, agentId, -rows.length);

  const jobs: Job[] = [];
  for (const r of rows) {
    try {
      const j = JSON.parse(r.payload) as Job;
      if (j?.trigger?.content != null) jobs.push({ trigger: j.trigger, opts: j.opts ?? {} });
    } catch {
      // a corrupt payload is dropped, not retried forever
    }
  }
  return jobs.length ? coalesce(jobs) : null;
}

async function dropQueued(channelId: string, agentId: string) {
  const db = await getDb();
  await db.execute("DELETE FROM queue WHERE channel_id = $1 AND agent_id = $2", [channelId, agentId]);
  clearDepth(channelId, agentId);
}

/** Concatenate parked triggers, in order, into one follow-up turn. */
function coalesce(jobs: Job[]): Job {
  const last = jobs[jobs.length - 1];
  if (jobs.length === 1) return last;

  // Conservative: any agent-authored item makes the merged turn agent-authored,
  // so a queued agent reply can never launder itself into @all rights.
  const src = [...jobs].reverse().find((j) => j.trigger.authorType === "agent") ?? last;
  const content = [
    `${jobs.length} messages queued up while you were busy. Handle them together, in order:`,
    ...jobs.map(
      (j, i) =>
        `${i + 1}. [${j.trigger.authorName}${j.trigger.authorType === "agent" ? " (agent)" : ""}]: ${j.trigger.content}`
    ),
  ].join("\n\n");

  return {
    trigger: {
      content,
      authorType: src.trigger.authorType,
      authorId: src.trigger.authorId,
      authorName: src.trigger.authorName,
      parentId: last.trigger.parentId,
      msgId: last.trigger.msgId,
      chain: [...new Set(jobs.flatMap((j) => j.trigger.chain ?? []))],
      taskId: [...jobs].reverse().find((j) => j.trigger.taskId)?.trigger.taskId,
      attachments: jobs.flatMap((j) => j.trigger.attachments ?? []).slice(0, 8),
    },
    opts: {
      parentId: last.opts.parentId,
      note: [...jobs].reverse().find((j) => (j.opts.note ?? "").trim())?.opts.note,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Running one agent, with the queue attached
 * ------------------------------------------------------------------ */

/**
 * Run this turn and then keep going until the agent's queue is empty.
 * Returns the LAST result, so callers (lead delegation, sequential rounds)
 * react to the agent's freshest reply rather than a superseded one.
 *
 * The caller owns what happens after the FIRST turn (that is the mode's job).
 * Turns that come off the queue get the generic hand-off instead: mentions in
 * the reply trigger teammates, when the channel allows chaining.
 */
async function drive(channelId: string, agent: Agent, first: Job | null): Promise<RunResult> {
  const k = key(channelId, agent.id);
  let last: RunResult = queued(agent);
  const turn = (async () => {
    let job = first ?? (await takeQueued(channelId, agent.id));
    let ownFollowUp = first === null;
    while (job) {
      // A slot is a real OS process against a metered subscription: wait for
      // capacity rather than spawning the whole roster at once.
      const release = await acquireRunSlot(Date.now());
      try {
        last = await runAgent(channelId, agent, job.trigger, job.opts);
      } finally {
        release();
      }
      if (ownFollowUp) {
        const channel = useStore.getState().channels.find((c) => c.id === channelId);
        const parentId = job.opts.parentId ?? job.trigger.parentId;
        if (channel) void maybeChain(channel, agent, last, job.trigger, parentId);
      }
      // Keep draining even after a cancel: the queued item is usually the
      // newer message the user cancelled the old run for.
      job = await takeQueued(channelId, agent.id);
      ownFollowUp = true;
    }
  })();
  inflight.set(k, turn);
  try {
    await turn;
  } catch (e) {
    console.error("[hq] run failed", e);
    if (e instanceof BudgetExceeded) {
      void useStore.getState().insertMessage({
        id: uid(),
        channel_id: channelId,
        author_type: "system",
        author_id: "",
        author_name: "Spaces",
        content: "⚠️ " + e.message,
        status: "done",
        meta: "",
      });
    }
    last = { runId: "", agentId: agent.id, agentName: agent.name, status: "error", content: String(e) };
  } finally {
    inflight.delete(k);
  }
  return last;
}

/**
 * One agent, one turn — unless it is already busy, in which case the turn is
 * parked and picked up by the run that is in flight.
 */
async function runOne(channelId: string, agent: Agent, trigger: Trigger, opts: RunOptions = {}): Promise<RunResult> {
  if (inflight.has(key(channelId, agent.id)) || activeRunFor(channelId, agent.id)) {
    await enqueue(channelId, agent, trigger, opts);
    return queued(agent);
  }
  return drive(channelId, agent, { trigger, opts });
}

/* ------------------------------------------------------------------ *
 * Modes
 * ------------------------------------------------------------------ */

/**
 * Dispatch a trigger into a channel according to its mode. This is the single
 * entry point — agents.triggerAgents() forwards to it.
 */
export async function dispatch(channelId: string, trigger: Trigger): Promise<void> {
  const channel = useStore.getState().channels.find((c) => c.id === channelId);
  if (!channel) return;

  await initAgentListener();
  // Prompt builders read the message cache; load it before anyone resolves.
  if (!useStore.getState().messages[channelId]) await useStore.getState().loadMessages(channelId);

  const members = rosterAgents(channelId);
  if (!members.length) return;

  const mode: ChannelMode = channel.mode || "broadcast";
  // Orchestrated modes are driven by the state machine below; a trigger that
  // arrives from an agent (chaining) is always a plain direct address.
  if (trigger.authorType !== "agent") {
    if (mode === "lead") return runLead(channel, members, trigger);
    if (mode === "panel") return runPanel(channel, members, trigger);
  }

  const targets = resolveTargets(channelId, trigger.content, trigger);
  if (!targets.length) return;
  if (mode === "sequential") return runSequential(channel, members, targets, trigger);
  return runBroadcast(channel, targets, trigger);
}

/** Everyone addressed answers at once — the original v2 behaviour. */
async function runBroadcast(channel: Channel, targets: Agent[], trigger: Trigger): Promise<void> {
  const parentId = trigger.parentId || (targets.length > 1 ? trigger.msgId : "");
  await boundedAll(
    targets.map((agent) => async () => {
      const res = await runOne(channel.id, agent, trigger, { parentId });
      void maybeChain(channel, agent, res, trigger, parentId);
    })
  );
}

/**
 * Agents answer one at a time, in roster order. The next agent's prompt is
 * built only once the previous run has landed, so it sees that reply.
 */
async function runSequential(
  channel: Channel,
  members: Agent[],
  targets: Agent[],
  trigger: Trigger
): Promise<void> {
  const order = new Map(members.map((a, i) => [a.id, i] as const));
  const line = [...targets].sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  const parentId = trigger.parentId || (line.length > 1 ? trigger.msgId : "");
  const names = line.map((a) => a.name).join(" → ");

  for (let i = 0; i < line.length; i++) {
    const note =
      `Sequential round in #${channel.name}: ${names}. You are turn ${i + 1} of ${line.length}. ` +
      (i === 0
        ? "You go first — be decisive and leave the teammates after you something concrete to work from."
        : "The teammates above have already replied. Build on their work, correct it where it is wrong, and do not repeat it.");
    const res = await runOne(channel.id, line[i], trigger, { parentId, note });
    // Stopping a run stops the round — the user asked for it to stop.
    if (res.status === "cancelled") break;
  }
}

/**
 * The lead triages, delegates by @mention, then wraps up.
 * A user who addresses specific teammates bypasses the lead — an explicit
 * mention is an explicit instruction (this is also how the board dispatches
 * a task to its assignee).
 */
async function runLead(channel: Channel, members: Agent[], trigger: Trigger): Promise<void> {
  const lead = leadAgent(channel, members);
  if (!lead) return;

  const mentioned = resolveMentions(channel.id, trigger.content, trigger);
  if (mentioned.some((a) => a.id !== lead.id)) return runBroadcast(channel, mentioned, trigger);

  // The whole round lives in one thread under the triggering message.
  const parentId = trigger.parentId || trigger.msgId;
  const roster = members.filter((a) => a.id !== lead.id);
  const canDelegate = !!channel.chaining && roster.length > 0 && trigger.chain.length < MAX_CHAIN;

  const leadNote = canDelegate
    ? `You are the lead of #${channel.name}. Work out what needs to happen. Do the parts that are yours, and delegate the rest by @mentioning exactly the teammates you need (${roster.map((a) => `@${slug(a.name)}`).join(", ")}), each with a short self-contained brief: what to do, where, and what "done" looks like. A mention starts that teammate immediately, so only mention someone you actually want working right now. You get a final turn to summarise once they report back.`
    : `You are the lead of #${channel.name}. Handle this yourself and say what you did.`;

  const leadRes = await runOne(channel.id, lead, trigger, { parentId, note: leadNote });
  if (!usable(leadRes) || !canDelegate) return;

  const chain = [...trigger.chain, lead.id];
  const delegates = resolveMentions(channel.id, leadRes.content, {
    authorType: "agent",
    authorId: lead.id,
    chain,
  });
  if (!delegates.length) return;

  const brief: Trigger = {
    content: leadRes.content,
    authorType: "agent",
    authorId: lead.id,
    authorName: lead.name,
    parentId,
    msgId: leadRes.runId,
    chain,
    taskId: trigger.taskId,
  };
  const results = await boundedAll(
    delegates.map((a) => () =>
      runOne(channel.id, a, brief, {
        parentId,
        note: `${lead.name}, the lead of #${channel.name}, delegated this to you. Do only your part — the rest is assigned to other teammates working in parallel. Report back concretely: what you did, which files changed, what you could not do, and anything the lead has to decide.`,
      })
    )
  );

  const replies = results.filter(usable);
  if (!replies.length) return;

  const ask = [
    `The teammates you delegated to have reported back on: "${trigger.content.slice(0, 400)}"`,
    "",
    ...replies.map((r) => `### ${r.agentName}\n${r.content.slice(0, 4000)}`),
    "",
    "Write the wrap-up for the user: what is now done and by whom, what changed, what still remains, and anything you need the user to decide. Do not paste their reports back — synthesise.",
  ].join("\n");

  await runOne(
    channel.id,
    lead,
    {
      content: ask,
      authorType: "user",
      authorId: "user",
      authorName: "Spaces",
      parentId,
      msgId: trigger.msgId,
      chain: [...chain, ...delegates.map((d) => d.id)],
      taskId: trigger.taskId,
    },
    { parentId }
  );
}

/** Everyone answers the same question blind, then the lead merges the answers. */
async function runPanel(channel: Channel, members: Agent[], trigger: Trigger): Promise<void> {
  const mentioned = resolveMentions(channel.id, trigger.content, trigger);
  // A message aimed at part of the panel is a direct address, not a panel.
  if (mentioned.length && mentioned.length < members.length) {
    return runBroadcast(channel, mentioned, trigger);
  }

  const parentId = trigger.parentId || (members.length > 1 ? trigger.msgId : "");
  const note = `Everyone in #${channel.name} is answering this independently and at the same time — you cannot see the others' answers. Give your own best answer from your own area of ownership, and be explicit about what you are confident in and what you are not.`;
  const results = await boundedAll(
    members.map((a) => () => runOne(channel.id, a, trigger, { parentId, note }))
  );

  const replies = results.filter(usable);
  const lead = leadAgent(channel, members);
  if (!lead || replies.length < 2) return;

  const ask = [
    `The panel answered this independently: "${trigger.content.slice(0, 400)}"`,
    "",
    ...replies.map((r) => `### ${r.agentName}\n${r.content.slice(0, 4000)}`),
    "",
    "Merge these into one answer for the user: where the panel agrees, where it disagrees and why, and your single recommendation. Be decisive.",
  ].join("\n");

  await runOne(
    channel.id,
    lead,
    {
      content: ask,
      authorType: "user",
      authorId: "user",
      authorName: "Spaces",
      parentId,
      msgId: trigger.msgId,
      chain: [...trigger.chain, ...members.map((a) => a.id)],
      taskId: trigger.taskId,
    },
    { parentId }
  );
}

/**
 * Agent-to-agent chaining: an agent mentioning teammates triggers them.
 * Only broadcast dispatches chain — in the orchestrated modes the hand-offs
 * are the state machine's job, and chaining on top would double-trigger.
 */
async function maybeChain(
  channel: Channel,
  agent: Agent,
  res: RunResult,
  trigger: Trigger,
  parentId: string
): Promise<void> {
  if (!usable(res) || !channel.chaining) return;
  if (trigger.chain.length >= MAX_CHAIN) return;
  try {
    await dispatch(channel.id, {
      content: res.content,
      authorType: "agent",
      authorId: agent.id,
      authorName: agent.name,
      parentId,
      msgId: res.runId,
      chain: [...trigger.chain, agent.id],
    });
  } catch (e) {
    // Chaining is fire-and-forget; a failed hand-off must not sink the round.
    console.error("[hq] chained dispatch failed", e);
  }
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

let inited = false;

/**
 * Restore the queue after a restart: seed the depth counters, then pick up
 * anything that was still parked when the app closed. Safe to call twice.
 */
export async function initOrchestrator(): Promise<void> {
  if (inited) return;
  inited = true;
  const db = await getDb();
  const rows = await db.select<{ channel_id: string; agent_id: string; n: number }[]>(
    "SELECT channel_id, agent_id, COUNT(*) AS n FROM queue GROUP BY channel_id, agent_id"
  );
  if (!rows.length) return;
  for (const r of rows) depths.set(key(r.channel_id, r.agent_id), r.n);
  emitQueue();

  await whenStoreLoaded();
  await initAgentListener();
  const s = useStore.getState();
  for (const r of rows) {
    const agent = s.agents.find((a) => a.id === r.agent_id);
    const channel = s.channels.find((c) => c.id === r.channel_id);
    if (!agent || !channel) {
      await dropQueued(r.channel_id, r.agent_id);
      continue;
    }
    if (inflight.has(key(channel.id, agent.id)) || activeRunFor(channel.id, agent.id)) continue;
    void drive(channel.id, agent, null);
  }
}

function whenStoreLoaded(): Promise<void> {
  if (useStore.getState().loaded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = useStore.subscribe((s) => {
      if (s.loaded) {
        stop();
        resolve();
      }
    });
    if (useStore.getState().loaded) {
      stop();
      resolve();
    }
  });
}
