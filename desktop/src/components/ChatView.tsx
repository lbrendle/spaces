import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useStore, channelAgents } from "../store";
import {
  triggerAgents, userTrigger, cancelRun, resolveTargets, leadAgent, rosterAgents,
} from "../agents";
import { getQueueSnapshot, queueDepth, subscribeQueue } from "../orchestrator";
import { getDb, uid } from "../db";
import { slug, colorFor, refKey } from "../types";
import type {
  Agent, ChannelMode, EntityRef, Message, MessageReaction,
} from "../types";
import { agentIdentity } from "../entities";
import { autoLinkMessage } from "../links";
import { SPACES_COMMANDS, availableCommands, parseSlash, runCommand } from "../commands";
import type { SlashCommand } from "../commands";
import { timeAgo } from "../github";
import { toast } from "../toast";
import { Avatar, Modal, Spinner, mdToHtml } from "./ui";
import {
  IconAgents, IconBolt, IconBranch, IconDocument, IconGear, IconGitHub, IconInfo,
  IconMemory, IconMessage, IconPlus, IconTasks, IconX,
} from "./icons";
import { EntityChip } from "./EntityChip";
import { ConnectionsSummary } from "./ConnectionsPanel";
import { LinkPicker } from "./LinkPicker";
import { ActionSummary } from "./ActionQueue";
import { RunInspector } from "./RunInspector";
import { RunDiff } from "./RunDiff";
import "./chat.css";
import { currentDeviceId } from "../deviceIdentity";
import { config } from "../config";
import { open } from "@tauri-apps/plugin-dialog";
import { GitHubRepoPicker } from "./GitHubRepoPicker";

/**
 * The four dispatch strategies orchestrator.ts implements, in the order they
 * escalate: none → ordered → delegated → merged. The blurb is the contract the
 * user is actually choosing, so it says what happens, not what it is called.
 */
const MODES: { id: ChannelMode; label: string; blurb: string }[] = [
  { id: "broadcast", label: "Broadcast", blurb: "Everyone mentioned answers at once." },
  { id: "sequential", label: "Sequential", blurb: "They answer one at a time, each seeing the previous replies." },
  { id: "lead", label: "Lead", blurb: "The lead triages, delegates by @mention, then summarises." },
  { id: "panel", label: "Panel", blurb: "Everyone answers independently, then the lead merges." },
];

const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🚀", "🧠"];

/** dispatch() treats an unset mode as broadcast — the UI must say the same. */
function modeOf(mode: ChannelMode | undefined): ChannelMode {
  return mode || "broadcast";
}

function modeMeta(mode: ChannelMode) {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

/**
 * Who answers an unaddressed message here — the same question resolveTargets()
 * answers at send time, said out loud before anyone has typed anything.
 */
function routingLine(mode: ChannelMode, agents: Agent[], lead?: Agent): string {
  const handles = agents.map((a) => "@" + slug(a.name));
  if (agents.length === 1) return `Anything you say goes to ${handles[0]}.`;
  if (mode === "lead" && lead) {
    return `Say something — ${"@" + slug(lead.name)} takes it by default and hands work to the rest. Mention someone to go straight to them.`;
  }
  if (mode === "panel" || mode === "sequential") {
    return `Say something — every agent here answers unless you mention one by name (${handles.join(", ")}).`;
  }
  return `Say something — mention ${handles.join(", ")}, or @all, to bring agents in.`;
}

/** Distinct paths in a run's newline-separated files_changed. */
function countFiles(raw: string): number {
  if (!raw) return 0;
  return new Set(raw.split("\n").map((f) => f.trim()).filter(Boolean)).size;
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function dayLabel(ts: number): string {
  const now = Date.now();
  if (sameDay(ts, now)) return "Today";
  if (sameDay(ts, now - 86_400_000)) return "Yesterday";
  return new Date(ts).toLocaleDateString();
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function replyStamp(ts: number): string {
  return sameDay(ts, Date.now()) ? fmtTime(ts) : dayLabel(ts);
}

/** One line of a message, for a task title or a memory heading. */
function headline(text: string, n = 70): string {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const bare = line.replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim();
  return bare.length > n ? bare.slice(0, n - 1) + "…" : bare;
}

/** Same fallback the run transcript uses: some webviews refuse the async API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Chips open the drawer rather than navigating: you keep your place here. */
function inspect(ref: EntityRef) {
  useStore.getState().setInspect(ref);
}

/* ── references inside a message body ─────────────────────────── *
 *
 * `[[Title]]` and `owner/name#123` are the two references autoLinkMessage()
 * turns into real edges when a message is sent, so the body has to show them
 * as the same things the graph now holds — a chip you can hover, inspect and
 * follow, not a string of brackets.
 *
 * Rendering goes through mdToHtml with private-use sentinels standing in for
 * the chips, then portals the real EntityChip into each placeholder. The
 * detour buys full markdown fidelity: splitting the text into React nodes
 * would break a list or a fence the moment somebody linked from inside one.
 */
const CHIP_OPEN = "\uE010";
const CHIP_CLOSE = "\uE011";

/**
 * Left boundary keeps a URL's own `owner/repo#anchor` out of it — the pattern
 * is the same one links.ts matches on, minus anything already inside a link.
 */
const REF_RE =
  /\[\[([^\][\n]{1,120})\]\]|(?<![\w./#-])([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g;

/**
 * Resolve `[[Title]]` exactly the way links.ts does — memory first, then
 * tasks, on the rendered title — so the chip and the edge always agree. A
 * title that matches nothing stays as typed: a chip pointing nowhere would be
 * a promise the app can't keep.
 */
function resolveWiki(title: string): EntityRef | null {
  const s = useStore.getState();
  const needle = title.trim().toLowerCase();
  if (!needle) return null;
  const mem = s.memory.find((x) => x.title.toLowerCase() === needle);
  if (mem) return { type: "memory", id: mem.id };
  const task = s.tasks.find((x) => x.title.toLowerCase() === needle);
  return task ? { type: "task", id: task.id } : null;
}

interface RenderedBody {
  html: string;
  /** In placeholder order, so refs[i] belongs in the i-th slot. */
  refs: EntityRef[];
}

function renderBody(text: string): RenderedBody {
  const refs: EntityRef[] = [];
  // Code spans and fences are quoted text: a reference in them is an example
  // of the syntax, not a use of it.
  const parts = (text ?? "")
    .replace(/[\uE010\uE011]/g, "")
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const prepared = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(REF_RE, (whole, wiki: string | undefined, repo: string, num: string) => {
        const ref = wiki === undefined ? { type: "pr" as const, id: `${repo}#${num}` } : resolveWiki(wiki);
        if (!ref) return whole;
        refs.push(ref);
        return `${CHIP_OPEN}${refs.length - 1}${CHIP_CLOSE}`;
      });
    })
    .join("");

  const html = mdToHtml(prepared).replace(
    /\uE010(\d+)\uE011/g,
    (_m, n: string) => `<span class="msg-chip" data-ec="${n}"></span>`
  );
  return { html, refs };
}

/**
 * The body, with its references live. Same `.md` output as the shared
 * <Markdown> — one layer down, so the sentinels survive the round trip.
 */
function MessageBody({ body }: { body: RenderedBody }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const { html, refs } = body;

  // Layout effect, not effect: the placeholders are filled before paint, so a
  // streaming message never flashes an empty gap where a chip is about to be.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const found =
      host && refs.length ? [...host.querySelectorAll<HTMLElement>("[data-ec]")] : [];
    setSlots((prev) =>
      prev.length === found.length && prev.every((el, i) => el === found[i]) ? prev : found
    );
  }, [html, refs.length]);

  return (
    <>
      <div className="md" ref={hostRef} dangerouslySetInnerHTML={{ __html: html }} />
      {slots.map((slot, i) =>
        refs[i]
          ? createPortal(<EntityChip ref={refs[i]} size="sm" onClick={inspect} />, slot, `ec${i}`)
          : null
      )}
    </>
  );
}

/* ── can this agent answer right now? ─────────────────────────── *
 *
 * An agent runs inside its harness on a host device, so "will anyone answer"
 * is a question about a machine. The composer asks it before you press send,
 * because finding out afterwards costs you the turn.
 */

/** v15 columns the store already loads; types.ts doesn't declare them yet. */
type HostedAgent = Agent & { host_device_id?: string };

/** How long a host's last check-in stays worth trusting. */
const HOST_WINDOW = 60 * 60_000;

interface Availability {
  /** True when the turn will not be answered from here; silence otherwise. */
  blocked: boolean;
  /** Two or three words for a chip. */
  label: string;
  /** The whole reason, in one sentence. */
  note: string;
}

const AVAILABLE: Availability = { blocked: false, label: "", note: "" };

/** A device's reported PATH map. A row that reported nonsense reported nothing. */
function deviceTools(raw: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === true;
    return out;
  } catch {
    return {};
  }
}

function availabilityOf(agent: Agent): Availability {
  const s = useStore.getState();
  const handle = `@${slug(agent.name)}`;
  // Ritz answers on a port rather than from PATH, and asking costs a request
  // per keystroke. Agents & Teams is where that check belongs.
  if (agent.kind === "ritz") return AVAILABLE;
  const host = s.devices.find((d) => d.id === (agent as HostedAgent).host_device_id);
  const here = currentDeviceId();

  if (!host || host.id === here) {
    // `undefined` means PATH detection hasn't answered yet, which is not the
    // same as a missing CLI — an unknown never becomes a warning.
    return s.tools[agent.kind] === false
      ? {
          blocked: true,
          label: "not on this PATH",
          note: `${agent.kind} isn't on this machine's PATH, so ${handle} can't answer from here. Anyone who has it still can.`,
        }
      : AVAILABLE;
  }

  if (deviceTools(host.tools)[agent.kind] === false) {
    return {
      blocked: true,
      label: "not on its host",
      note: `${host.name} doesn't have ${agent.kind} on its PATH, so ${handle} can't run there.`,
    };
  }
  // Without a local device row every stamp looks stale, including your own
  // machine's — so staleness only speaks when we know which row is not us.
  // And it states the fact rather than the verdict: a device checks in when
  // its owner opens Spaces, so "quiet since Tuesday" is not proof of "offline".
  if (here && Date.now() - host.last_seen_at > HOST_WINDOW) {
    return {
      blocked: true,
      label: "host is quiet",
      note: `${handle} runs on ${host.name}, which ${
        host.last_seen_at ? `last checked in ${timeAgo(host.last_seen_at)}` : "has never checked in"
      }. If that machine is offline the turn waits until it is back.`,
    };
  }
  return AVAILABLE;
}

/* ── composer drafts ──────────────────────────────────────────── *
 *
 * A half-written message is work. Switching channels to check something, or
 * closing the app, is not a decision to throw it away.
 */
const DRAFT_KEY = "spaces.chat.drafts";

const drafts: Map<string, string> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return new Map(
        Object.entries(raw as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string"
        )
      );
    }
  } catch {
    // A corrupt draft store costs a draft, never the app.
  }
  return new Map<string, string>();
})();

let draftTimer: number | undefined;

function saveDraft(key: string, text: string) {
  if (text.trim()) drafts.set(key, text);
  else drafts.delete(key);
  // Debounced: a keystroke shouldn't cost a synchronous write to disk.
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(drafts)));
    } catch {
      // Out of quota or private mode: the in-memory map still holds the draft.
    }
  }, 400);
}

export function ChatView({ channelId }: { channelId: string }) {
  const store = useStore();
  const channel = store.channels.find((c) => c.id === channelId);
  const project = store.projects.find((p) => p.id === channel?.project_id);
  // The local store can briefly contain an optimistic or legacy partial row
  // while another surface refreshes. Keep that row from rendering as an
  // "Invalid Date" ghost; the next database load replaces it with the full
  // message.
  const msgs = (store.messages[channelId] ?? []).filter(
    (message) =>
      Boolean(message?.id) &&
      typeof message.created_at === "number" &&
      Number.isFinite(message.created_at)
  );
  const agents = channelAgents(store, channelId);
  const [showMembers, setShowMembers] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProject, setShowProject] = useState(false);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [inspectRunId, setInspectRunId] = useState<string | null>(null);
  const [diffRunId, setDiffRunId] = useState<string | null>(null);
  const [linkingChannel, setLinkingChannel] = useState(false);
  // runId → files_changed, for runs that predate this app session. Live runs
  // are read straight off store.runs, which stays current as they finish.
  const [filesByRun, setFilesByRun] = useState<Record<string, string>>({});
  const [reactions, setReactions] = useState<Record<string, MessageReaction[]>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const roots = useMemo(() => msgs.filter((m) => !m.parent_id), [msgs]);
  const repliesByRoot = useMemo(() => {
    const map: Record<string, Message[]> = {};
    for (const m of msgs) {
      if (m.parent_id) (map[m.parent_id] ??= []).push(m);
    }
    return map;
  }, [msgs]);

  // Every edge touching a message in this channel, indexed once. A message row
  // that walked the link table itself would walk it a hundred times a render.
  const linksByMessage = useMemo(() => {
    const map: Record<string, EntityRef[]> = {};
    for (const l of store.links) {
      if (l.from_type === "message") (map[l.from_id] ??= []).push({ type: l.to_type, id: l.to_id });
      else if (l.to_type === "message") (map[l.to_id] ??= []).push({ type: l.from_type, id: l.from_id });
    }
    return map;
  }, [store.links]);

  const channelRef = useMemo<EntityRef>(() => ({ type: "channel", id: channelId }), [channelId]);
  // Only whether the summary has anything to say — ConnectionsSummary renders
  // nothing when a channel is unconnected, and an empty button is a dead end.
  const connected = useMemo(
    () =>
      store.links.some(
        (l) =>
          (l.from_type === "channel" && l.from_id === channelId) ||
          (l.to_type === "channel" && l.to_id === channelId)
      ) ||
      store.assignments.some((a) => a.target_type === "channel" && a.target_id === channelId),
    [store.links, store.assignments, channelId]
  );

  useEffect(() => {
    void store.loadMessages(channelId);
    setThreadRootId(null);
    setInspectRunId(null);
    setDiffRunId(null);
    atBottomRef.current = true; // channel switch always jumps to the newest message
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    setReactions({});
    void (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<MessageReaction[]>(
          `SELECT r.*
           FROM message_reactions r
           JOIN messages m ON m.id = r.message_id
           WHERE m.channel_id = $1
           ORDER BY r.created_at`,
          [channelId]
        );
        if (cancelled) return;
        const grouped: Record<string, MessageReaction[]> = {};
        for (const row of rows) (grouped[row.message_id] ??= []).push(row);
        setReactions(grouped);
      } catch {
        // Reactions are additive; chat remains usable if the lookup fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  // One batched lookup per channel instead of a query per message.
  useEffect(() => {
    let cancelled = false;
    setFilesByRun({});
    void (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<{ id: string; files_changed: string }[]>(
          "SELECT id, files_changed FROM runs WHERE channel_id = $1 AND files_changed <> ''",
          [channelId]
        );
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const r of rows) map[r.id] = r.files_changed;
        setFilesByRun(map);
      } catch {
        // The diff affordance is additive: a failed lookup just hides it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  // A View can point straight at a thread (e.g. jumping to a run from Tasks).
  const view = store.view;
  useEffect(() => {
    if (
      (view.type === "channel" || view.type === "workspace") &&
      view.channelId === channelId &&
      view.threadRootId
    ) {
      setThreadRootId(view.threadRootId);
    }
  }, [view, channelId]);

  // Follow new content only while the user is at (or near) the bottom —
  // scrolling up to read history must not get yanked back down.
  const lastRoot = roots[roots.length - 1];
  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [channelId, roots.length, lastRoot?.content?.length]);

  if (!channel) return <div className="main-pane center-note">Channel not found.</div>;
  /* eslint-disable-next-line @typescript-eslint/no-use-before-define */

  const mode = modeOf(channel.mode);
  const meta = modeMeta(mode);
  // Exactly the agent orchestrator.ts would hand the round to.
  const lead = mode === "lead" || mode === "panel"
    ? leadAgent(channel, rosterAgents(channelId))
    : undefined;

  function openInspector(runId: string) {
    setDiffRunId(null);
    setInspectRunId(runId);
  }

  function openDiff(runId: string) {
    setInspectRunId(null);
    setDiffRunId(runId);
  }

  async function toggleReaction(messageId: string, emoji: string) {
    const current = reactions[messageId] ?? [];
    const mine = current.find((reaction) => reaction.emoji === emoji && reaction.actor_id === "user");
    if (mine) {
      setReactions((all) => ({
        ...all,
        [messageId]: (all[messageId] ?? []).filter((reaction) => reaction.id !== mine.id),
      }));
      const db = await getDb();
      await db.execute("DELETE FROM message_reactions WHERE id = $1", [mine.id]);
      return;
    }
    const reaction: MessageReaction = {
      id: uid(),
      message_id: messageId,
      emoji,
      actor_id: "user",
      actor_name: useStore.getState().self().name,
      created_at: Date.now(),
    };
    setReactions((all) => ({
      ...all,
      [messageId]: [...(all[messageId] ?? []), reaction],
    }));
    const db = await getDb();
    await db.execute(
      `INSERT OR IGNORE INTO message_reactions
       (id, message_id, emoji, actor_id, actor_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        reaction.id,
        reaction.message_id,
        reaction.emoji,
        reaction.actor_id,
        reaction.actor_name,
        reaction.created_at,
      ]
    );
  }

  return (
    <div className="main-pane chat">
      <div className="pane-header">
        <div>
          <div className="pane-title"><span className="hash">#</span>{channel.name}</div>
          <div className="pane-sub">
            {project && (
              <button className="chip project-chip" onClick={() => setShowProject(true)}>
                {project.name}
              </button>
            )}
            {project?.repo && (
              <a className="chip repo-chip" href={`https://github.com/${project.repo}`} target="_blank" rel="noreferrer">
                <IconGitHub size={11} /> {project.repo}
              </a>
            )}
            {channel.topic && <span className="topic">{channel.topic}</span>}
            {/* Who is on this channel and what it is about, without leaving the
                conversation to find out. */}
            <span className="chan-cx">
              {connected && (
                <button
                  className="chan-cx-open"
                  title={`Who is on #${channel.name}, and what it is connected to`}
                  onClick={() => store.setInspect(channelRef)}
                >
                  <ConnectionsSummary anchor={channelRef} />
                </button>
              )}
              <button
                className="chan-cx-add"
                title={`Connect #${channel.name} to a task, a memory entry, a pull request…`}
                onClick={() => setLinkingChannel(true)}
              >
                <IconPlus size={10} />
                Link
              </button>
            </span>
          </div>
        </div>
        <div className="row">
          <button
            className="chip mode-chip"
            title={`${meta.blurb} Click to change how #${channel.name} dispatches.`}
            onClick={() => setShowSettings(true)}
          >
            <IconBolt size={11} />
            <span className="mode-chip-name">{mode}</span>
            {lead && <span className="mode-chip-lead">· {lead.name}</span>}
          </button>
          <button className="btn" onClick={() => setShowMembers(true)}>
            <IconAgents size={14} /> {agents.length} agent{agents.length === 1 ? "" : "s"}
          </button>
          <button
            className="btn"
            title="Channel settings"
            aria-label="Channel settings"
            onClick={() => setShowSettings(true)}
          >
            <IconGear size={15} />
          </button>
        </div>
      </div>

      <div className="chat-body">
        <div className="chat-main">
          <div
            className="messages"
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {msgs.length === 0 && (
              <div className="center-note chat-blank">
                <p><strong>#{channel.name}</strong> is quiet.</p>
                {agents.length === 0 ? (
                  <>
                    <p>
                      No agents or teams are in this channel yet, so a message here reaches
                      nobody.
                    </p>
                    <p className="chat-blank-rule">
                      Once one joins, <span className="mention">@name</span> routes a message
                      to that agent and <span className="mention">@all</span> reaches
                      everyone in the channel. {meta.blurb}
                    </p>
                    <button className="btn" onClick={() => setShowMembers(true)}>
                      <IconAgents size={14} /> Add members
                    </button>
                  </>
                ) : (
                  <p>{routingLine(mode, agents, lead)}</p>
                )}
              </div>
            )}
            {roots.map((m, i) => {
              const prev = roots[i - 1];
              const newDay = !prev || !sameDay(prev.created_at, m.created_at);
              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <div className="day-divider"><span>{dayLabel(m.created_at)}</span></div>
                  )}
                  <MessageRow
                    m={m}
                    prev={newDay ? undefined : prev}
                    replies={repliesByRoot[m.id]}
                    storedFiles={filesByRun[m.run_id]}
                    reactions={reactions[m.id] ?? []}
                    projectId={channel.project_id}
                    links={linksByMessage[m.id]}
                    onReact={toggleReaction}
                    onOpenThread={setThreadRootId}
                    onInspect={openInspector}
                    onViewDiff={openDiff}
                  />
                </Fragment>
              );
            })}
            <div ref={bottomRef} />
          </div>
          <Composer channelId={channelId} />
        </div>

        {/* The channel's context, in the space the transcript was not using.
            Hidden while a thread is open — a thread is already the second
            column — and inside the command centre, where the dock is. */}
        {!threadRootId && (
          <ChannelContext
            channelId={channelId}
            projectId={channel.project_id}
            agents={agents}
            onAddMembers={() => setShowMembers(true)}
          />
        )}

        {threadRootId && (
          <ThreadPanel
            channelId={channelId}
            rootId={threadRootId}
            filesByRun={filesByRun}
            reactions={reactions}
            projectId={channel.project_id}
            linksByMessage={linksByMessage}
            onReact={toggleReaction}
            onClose={() => setThreadRootId(null)}
            onInspect={openInspector}
            onViewDiff={openDiff}
          />
        )}
      </div>

      {linkingChannel && (
        <LinkPicker anchor={channelRef} onClose={() => setLinkingChannel(false)} />
      )}
      {showMembers && <MembersModal channelId={channelId} onClose={() => setShowMembers(false)} />}
      {showSettings && <ChannelSettingsModal channelId={channelId} onClose={() => setShowSettings(false)} />}
      {showProject && project && (
        <ProjectSettingsModal projectId={project.id} onClose={() => setShowProject(false)} />
      )}
      {inspectRunId && <RunInspector runId={inspectRunId} onClose={() => setInspectRunId(null)} />}
      {diffRunId && <RunDiff runId={diffRunId} onClose={() => setDiffRunId(null)} />}
    </div>
  );
}

function MessageRow({
  m,
  prev,
  replies,
  storedFiles,
  reactions = [],
  projectId = "",
  links,
  onReact,
  onOpenThread,
  onInspect,
  onViewDiff,
}: {
  m: Message;
  prev?: Message;
  replies?: Message[];
  /** files_changed read from SQLite, for runs this session never spawned. */
  storedFiles?: string;
  reactions?: MessageReaction[];
  /** The channel's project — what a task or memory entry filed here belongs to. */
  projectId?: string;
  /** Everything this message is linked to, indexed by the channel. */
  links?: EntityRef[];
  onReact?: (messageId: string, emoji: string) => void;
  onOpenThread?: (rootId: string) => void;
  onInspect?: (runId: string) => void;
  onViewDiff?: (runId: string) => void;
}) {
  const [showReactions, setShowReactions] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  // Wikilinks resolve against titles, so a renamed memory entry has to re-chip.
  const memory = useStore((s) => s.memory);
  const tasks = useStore((s) => s.tasks);
  const body = useMemo(() => renderBody(m.content), [m.content, memory, tasks]);
  const identity = m.author_type === "agent" ? agentIdentity(m.author_id) : null;
  const grouped =
    prev &&
    prev.author_type === m.author_type &&
    prev.author_id === m.author_id &&
    m.created_at - prev.created_at < 5 * 60_000;
  const inspectable = m.author_type === "agent" && !!m.run_id && !!onInspect;

  // A run held in the store is authoritative — it is patched as the turn ends.
  // `null` means "not loaded here", which is when the SQLite read stands in.
  const liveFiles = useStore((s) => (m.run_id ? s.runs[m.run_id]?.files_changed ?? null : null));
  const changed = useMemo(
    () => countFiles(liveFiles ?? storedFiles ?? ""),
    [liveFiles, storedFiles]
  );
  const diffable = m.author_type === "agent" && !!m.run_id && changed > 0 && !!onViewDiff;
  const reactionGroups = useMemo(() => {
    const groups = new Map<string, MessageReaction[]>();
    for (const reaction of reactions) {
      const rows = groups.get(reaction.emoji) ?? [];
      rows.push(reaction);
      groups.set(reaction.emoji, rows);
    }
    return [...groups.entries()];
  }, [reactions]);

  // First message per distinct replier, in reply order, for the pill avatars.
  const repliers = useMemo(() => {
    if (!replies?.length) return [];
    const seen = new Map<string, Message>();
    for (const r of replies) {
      const key = r.author_id || r.author_name;
      if (!seen.has(key)) seen.set(key, r);
    }
    return [...seen.values()];
  }, [replies]);

  const footMeta =
    m.status === "running" ? null
      : inspectable ? (
        <button className="msg-meta msg-meta-btn" title="Inspect run" onClick={() => onInspect!(m.run_id)}>
          {m.meta || "view run"}
        </button>
      ) : m.meta ? (
        <div className="msg-meta">{m.meta}</div>
      ) : null;

  const self = useMemo<EntityRef>(() => ({ type: "message", id: m.id }), [m.id]);
  const written = !!m.content.trim();
  // A reference already sitting in the prose doesn't need repeating below it.
  const inline = useMemo(() => new Set(body.refs.map(refKey)), [body.refs]);
  const linked = useMemo(
    () => (links ?? []).filter((r) => !inline.has(refKey(r))),
    [links, inline]
  );
  /** The run's own footer strip, when it changed anything in the workspace. */
  const wrote = m.author_type === "agent" && !!m.run_id;

  async function copyBody() {
    if (await copyText(m.content)) toast.success("Message copied");
    else toast.warn("Could not reach the clipboard", "Select the text and copy it by hand.");
  }

  /**
   * Turning a message into tracked work. Both of these file the thing and then
   * link it back here, so the conversation that produced the decision is one
   * hop from the decision — that link is the whole point, not a nicety.
   */
  async function fileTask() {
    if (busy) return;
    setBusy(true);
    try {
      const store = useStore.getState();
      const task = await store.addTask({
        project_id: projectId,
        title: headline(m.content),
        description: m.content,
      });
      await store.addLink(self, { type: "task", id: task.id }, "references");
      toast.show({
        kind: "success",
        title: "Task filed",
        detail: task.title,
        action: { label: "Open", run: () => inspect({ type: "task", id: task.id }) },
      });
    } catch (e) {
      toast.error("Could not file that task", e);
    } finally {
      setBusy(false);
    }
  }

  async function pinToMemory() {
    if (busy) return;
    setBusy(true);
    try {
      const store = useStore.getState();
      const entry = await store.addMemory({
        project_id: projectId,
        title: headline(m.content),
        content: m.content,
        kind: "note",
        pinned: 1,
      });
      await store.addLink(self, { type: "memory", id: entry.id }, "references");
      toast.show({
        kind: "success",
        title: "Pinned to memory",
        detail: "Agents working on this project see it from now on.",
        action: { label: "Open", run: () => inspect({ type: "memory", id: entry.id }) },
      });
    } catch (e) {
      toast.error("Could not pin that", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={"msg" + (grouped ? " grouped" : "")}>
      {!grouped && (
        <div className="msg-head">
          <Avatar name={m.author_name} id={m.author_id || m.author_name} kind={m.author_type === "agent" ? agentKind(m.author_id) : undefined} />
          <span className="msg-author" style={{ color: m.author_type === "agent" ? colorFor(m.author_id) : undefined }}>
            {identity?.name || m.author_name}
          </span>
          {/* Whose agent it is, never folded into its name: in a shared roster
              "Ada" is the teammate and "Rowan's" is provenance. */}
          {identity?.tag && <span className="owner-tag">{identity.tag}</span>}
          {m.author_type === "agent" && <span className="bot-tag">AGENT</span>}
          <span className="msg-time">{fmtTime(m.created_at)}</span>
          {inspectable && (
            <button
              className="icon-btn msg-inspect"
              title="Inspect run"
              aria-label="Inspect run"
              onClick={() => onInspect!(m.run_id)}
            >
              <IconInfo size={13} />
            </button>
          )}
        </div>
      )}
      <div className="msg-actions" role="group" aria-label="Message actions">
        {onReact && (
          <div className="msg-action-wrap">
            <button
              className="msg-action"
              title="Add reaction"
              aria-label="Add reaction"
              aria-expanded={showReactions}
              onClick={() => setShowReactions((open) => !open)}
            >
              ☺+
            </button>
            {showReactions && (
              <div className="emoji-pop action-pop" role="menu">
                {QUICK_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    role="menuitem"
                    onClick={() => {
                      setShowReactions(false);
                      onReact(m.id, emoji);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {onOpenThread && (
          <button
            className="msg-action"
            title="Reply in thread"
            aria-label="Reply in thread"
            onClick={() => onOpenThread(m.parent_id || m.id)}
          >
            <IconMessage size={13} />
          </button>
        )}
        <button
          className="msg-action"
          title="Connect this message to something"
          aria-label="Link this message"
          onClick={() => setPicking(true)}
        >
          <IconPlus size={13} />
        </button>
        {projectId && (
          <>
            <button
              className="msg-action"
              title="File a task from this message"
              aria-label="File a task from this message"
              disabled={!written || busy}
              onClick={() => void fileTask()}
            >
              <IconTasks size={13} />
            </button>
            <button
              className="msg-action"
              title="Pin this to the project's memory"
              aria-label="Pin this to memory"
              disabled={!written || busy}
              onClick={() => void pinToMemory()}
            >
              <IconMemory size={13} />
            </button>
          </>
        )}
        <button
          className="msg-action"
          title="Copy the message text"
          aria-label="Copy the message text"
          disabled={!written}
          onClick={() => void copyBody()}
        >
          <IconDocument size={13} />
        </button>
      </div>
      <div className="msg-body">
        {m.status === "running" && !m.content && (
          <div className="running-note"><Spinner /> {m.meta || "thinking…"}</div>
        )}
        {m.content && <MessageBody body={body} />}
        {m.status === "running" && m.content && (
          <div className="running-note"><Spinner /> {m.meta || "working…"}</div>
        )}
        {m.status === "running" && (
          <button className="btn tiny danger" onClick={() => cancelRun(m.id)}>Stop</button>
        )}
        {linked.length > 0 && (
          <div className="msg-links">
            <span className="msg-links-label" aria-hidden="true">⇄</span>
            <ul className="msg-links-items">
              {linked.map((r) => (
                <li key={refKey(r)}>
                  <EntityChip ref={r} size="sm" onClick={inspect} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {(footMeta || diffable || wrote) && (
          <div className="msg-foot">
            {footMeta}
            {diffable && (
              <button
                className="msg-changes"
                title="View the diff this turn produced"
                onClick={() => onViewDiff!(m.run_id)}
              >
                <IconBranch size={12} />
                View changes
                <span className="msg-changes-count">{changed} file{changed === 1 ? "" : "s"}</span>
              </button>
            )}
            {/* Renders nothing unless the run actually wrote to the workspace. */}
            {wrote && (
              <ActionSummary
                runId={m.run_id}
                onOpen={(target) =>
                  target === "queue"
                    ? useStore.getState().setView({ type: "dashboard" })
                    : onInspect?.(m.run_id)
                }
              />
            )}
          </div>
        )}
        {/* Only what people actually reacted with; adding one lives in the
            hover toolbar with every other thing you can do to a message. */}
        {reactionGroups.length > 0 && (
          <div className="msg-reactions">
            {reactionGroups.map(([emoji, rows]) => {
              const mine = rows.some((reaction) => reaction.actor_id === "user");
              return (
                <button
                  key={emoji}
                  className={"reaction-chip" + (mine ? " mine" : "")}
                  title={rows.map((reaction) => reaction.actor_name).join(", ")}
                  aria-pressed={mine}
                  onClick={() => onReact?.(m.id, emoji)}
                >
                  <span>{emoji}</span>
                  <span className="reaction-count">{rows.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {replies && replies.length > 0 && onOpenThread && (
          <button className="reply-pill" onClick={() => onOpenThread(m.id)}>
            <span className="reply-avatars">
              {repliers.slice(0, 3).map((r) => (
                <Avatar key={r.author_id || r.author_name} name={r.author_name} id={r.author_id || r.author_name} />
              ))}
            </span>
            <span className="reply-count">{replies.length} {replies.length === 1 ? "reply" : "replies"}</span>
            <span className="reply-last">{replyStamp(replies[replies.length - 1].created_at)}</span>
          </button>
        )}
      </div>
      {picking && <LinkPicker anchor={self} onClose={() => setPicking(false)} />}
    </div>
  );
}

function agentKind(agentId: string): string | undefined {
  return useStore.getState().agents.find((a) => a.id === agentId)?.kind;
}

/* ── the channel's context ────────────────────────────────────── */

/**
 * What this channel is, beside what was said in it.
 *
 * A transcript is a single column of text, and it was being given the whole
 * pane — so on any normal window roughly a third of the screen was empty to
 * the right of every line, and the answers to "who is in here", "what work is
 * this attached to" and "what have the agents actually done lately" were
 * somewhere else entirely: the members modal, the board, the run inspector.
 *
 * The column is not decoration for the gap. It is the three questions you ask
 * about a channel while reading it, answered where you are reading.
 */
function ChannelContext({
  channelId,
  projectId,
  agents,
  onAddMembers,
}: {
  channelId: string;
  projectId: string;
  agents: Agent[];
  onAddMembers: () => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const runs = useStore((s) => s.runs);
  const setView = useStore((s) => s.setView);
  const setInspect = useStore((s) => s.setInspect);

  const open = useMemo(
    () => tasks.filter((t) => t.project_id === projectId && t.status !== "done").slice(0, 6),
    [tasks, projectId]
  );

  /* Runs that happened in THIS channel, newest first. The store keys runs by
     id rather than by channel, so this is a scan — it is a handful of records
     held in memory, not a query. */
  const recent = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.channel_id === channelId && r.finished_at)
        .sort((a, b) => b.finished_at - a.finished_at)
        .slice(0, 4),
    [runs, channelId]
  );

  return (
    <aside className="chat-context" aria-label="Channel context">
      <section className="cx-sec">
        <h3 className="cx-head">
          In this channel
          <button type="button" className="cx-add" onClick={onAddMembers}>
            Add
          </button>
        </h3>
        {agents.length === 0 ? (
          <p className="cx-none">Nobody yet — a message here reaches no one.</p>
        ) : (
          <ul className="cx-people">
            {agents.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="cx-person"
                  onClick={() => setInspect({ type: "agent", id: a.id })}
                >
                  <Avatar id={a.id} name={a.name} kind={a.kind} />
                  <span className="cx-person-text">
                    <span className="cx-person-name">{a.name}</span>
                    <span className="cx-person-role">{a.role || a.kind}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cx-sec">
        <h3 className="cx-head">
          Open work
          <button type="button" className="cx-add" onClick={() => setView({ type: "tasks" })}>
            Board
          </button>
        </h3>
        {open.length === 0 ? (
          <p className="cx-none">Nothing open on this project.</p>
        ) : (
          <ul className="cx-list">
            {open.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="cx-item"
                  onClick={() => setInspect({ type: "task", id: t.id })}
                >
                  <span className={"cx-dot cx-dot-" + t.status} aria-hidden="true" />
                  <span className="cx-item-text">{t.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 && (
        <section className="cx-sec">
          <h3 className="cx-head">Recent runs</h3>
          <ul className="cx-list">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="cx-item"
                  onClick={() => setInspect({ type: "run", id: r.id })}
                >
                  <span className={"cx-dot cx-run-" + r.status} aria-hidden="true" />
                  <span className="cx-item-text">
                    {agents.find((a) => a.id === r.agent_id)?.name ?? "An agent"}
                  </span>
                  <span className="cx-item-tail num">{timeAgo(r.finished_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function ThreadPanel({
  channelId,
  rootId,
  filesByRun,
  reactions,
  projectId,
  linksByMessage,
  onReact,
  onClose,
  onInspect,
  onViewDiff,
}: {
  channelId: string;
  rootId: string;
  filesByRun: Record<string, string>;
  reactions: Record<string, MessageReaction[]>;
  projectId: string;
  linksByMessage: Record<string, EntityRef[]>;
  onReact: (messageId: string, emoji: string) => void;
  onClose: () => void;
  onInspect: (runId: string) => void;
  onViewDiff: (runId: string) => void;
}) {
  const store = useStore();
  const msgs = store.messages[channelId] ?? [];
  const root = msgs.find((m) => m.id === rootId);
  const replies = useMemo(() => msgs.filter((m) => m.parent_id === rootId), [msgs, rootId]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastReply = replies[replies.length - 1];

  useEffect(() => {
    atBottomRef.current = true; // opening (or switching) a thread always jumps to the end
  }, [rootId]);

  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rootId, replies.length, lastReply?.content?.length]);

  if (!root) return null;

  return (
    <div className="thread-panel">
      <div className="thread-head">
        <span className="thread-title">Thread</span>
        <span className="thread-sub">
          {replies.length ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` : ""}
        </span>
        <button className="icon-btn" title="Close thread" aria-label="Close thread" onClick={onClose}>
          <IconX size={14} />
        </button>
      </div>
      <div
        className="thread-msgs"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <MessageRow
          m={root}
          storedFiles={filesByRun[root.run_id]}
          reactions={reactions[root.id] ?? []}
          projectId={projectId}
          links={linksByMessage[root.id]}
          onReact={onReact}
          onInspect={onInspect}
          onViewDiff={onViewDiff}
        />
        {replies.length > 0 && (
          <div className="thread-sep">{replies.length} repl{replies.length === 1 ? "y" : "ies"}</div>
        )}
        {replies.map((r, i) => (
          <MessageRow
            key={r.id}
            m={r}
            prev={replies[i - 1]}
            storedFiles={filesByRun[r.run_id]}
            reactions={reactions[r.id] ?? []}
            projectId={projectId}
            links={linksByMessage[r.id]}
            onReact={onReact}
            onInspect={onInspect}
            onViewDiff={onViewDiff}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      <Composer channelId={channelId} parentId={rootId} inThread />
    </div>
  );
}

/** Project command lists are a git call each; one per checkout is plenty. */
const commandCache = new Map<string, SlashCommand[]>();

function Composer({
  channelId,
  parentId = "",
  inThread = false,
}: {
  channelId: string;
  parentId?: string;
  inThread?: boolean;
}) {
  const store = useStore();
  const draftKey = `${channelId}|${parentId}`;
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const [draftFor, setDraftFor] = useState(draftKey);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  const [showEmoji, setShowEmoji] = useState(false);
  const [noTargets, setNoTargets] = useState(false);
  const [focused, setFocused] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>(SPACES_COMMANDS);
  /** Escape dismisses the command hints; the next keystroke brings them back. */
  const [slashOff, setSlashOff] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const listId = useId();
  const agents = channelAgents(store, channelId);

  // Adjusting state during render is React's own answer to "the props moved":
  // an effect would paint the previous channel's draft for one frame first.
  if (draftFor !== draftKey) {
    setDraftFor(draftKey);
    setTextState(drafts.get(draftKey) ?? "");
    setMentionQuery(null);
  }

  function setText(next: string) {
    setTextState(next);
    saveDraft(draftKey, next);
  }

  // The orchestrator parks mentions that land while an agent is mid-run. That
  // is invisible otherwise — the message is simply not answered yet.
  const queueSnap = useSyncExternalStore(subscribeQueue, getQueueSnapshot);
  const depth = useMemo(() => queueDepth(channelId), [queueSnap, channelId]);
  const waitingOn = useMemo(
    () =>
      agents
        .map((a) => ({ name: a.name, n: queueDepth(channelId, a.id) }))
        .filter((x) => x.n > 0)
        .map((x) => (x.n > 1 ? `${x.name} ×${x.n}` : x.name)),
    [queueSnap, channelId, agents]
  );

  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  const teams = store.teams.filter((t) =>
    store.channelMembers.some(
      (m) => m.channel_id === channelId && m.member_type === "team" && m.member_id === t.id
    )
  );
  const people = store.members.filter(
    (member) => member.status === "active" && !member.is_self
  );
  const personHandle = (name: string) => {
    const base = slug(name) || "teammate";
    return agents.some((agent) => slug(agent.name) === base) ||
      teams.some((team) => slug(team.name) === base)
      ? `${base}-person`
      : base;
  };

  const options = useMemo(() => {
    if (mentionQuery === null) return [];
    const all = [
      ...people.map((person) => ({
        handle: personHandle(person.name),
        label: person.name,
        kind: "person",
      })),
      ...agents.map((a) => ({ handle: slug(a.name), label: a.name, kind: a.kind as string })),
      ...teams.map((t) => ({ handle: slug(t.name), label: t.name, kind: "team" })),
      { handle: "all", label: "all agents in channel", kind: "" },
    ];
    return all.filter((o) => o.handle.startsWith(mentionQuery.toLowerCase())).slice(0, 8);
  }, [mentionQuery, agents, teams, people]);

  const mentionedPeople = useMemo(() => {
    const handles = new Set(
      (text.match(/(?<![\w@./-])@[a-z0-9-]+/gi) ?? []).map((value) =>
        value.slice(1).toLowerCase()
      )
    );
    return people.filter((person) => handles.has(personHandle(person.name)));
  }, [text, people, agents, teams]);

  const mentionAt = options.length ? Math.min(mentionSel, options.length - 1) : -1;

  /* ── slash commands ─────────────────────────────────────────
     Hinted while the name is still being typed. Spaces's own commands run here
     and never reach a harness; everything else is passed through verbatim,
     which is exactly what commands.ts promises. */
  const slashQuery = /^\/([a-z0-9:_-]*)$/i.exec(text)?.[1]?.toLowerCase() ?? null;
  const project = store.projects.find(
    (p) => p.id === store.channels.find((c) => c.id === channelId)?.project_id
  );
  const projectPath = project?.local_path ?? "";

  useEffect(() => {
    if (slashQuery === null) return;
    if (!projectPath) {
      // No checkout to read .claude/commands from — Spaces's own are all there is.
      setCommands(SPACES_COMMANDS);
      return;
    }
    const cached = commandCache.get(projectPath);
    if (cached) {
      setCommands(cached);
      return;
    }
    let alive = true;
    void availableCommands(projectPath).then((cs) => {
      commandCache.set(projectPath, cs);
      if (alive) setCommands(cs);
    });
    return () => {
      alive = false;
    };
    // Only the first "/" of a session needs to ask; after that it is cached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery === null, projectPath]);

  const slashOptions = useMemo(
    () =>
      slashQuery === null || slashOff
        ? []
        : commands.filter((c) => c.name.startsWith(slashQuery)).slice(0, 6),
    [slashQuery, slashOff, commands]
  );

  const parsed = parseSlash(text);
  const hqCommand = !!parsed && SPACES_COMMANDS.some((c) => c.name === parsed.name);

  /* ── who this will reach, and whether they can answer ─────── */
  const targets = useMemo(
    () => (text.trim() && !hqCommand ? resolveTargets(channelId, text) : []),
    // resolveTargets reads the roster and the channel's mode straight off the
    // store, so both have to be declared for the line to stay true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, hqCommand, channelId, store.channelMembers, store.channels, store.teamMembers, agents]
  );

  const blocked = useMemo(
    () =>
      targets
        .map((agent) => ({ agent, ...availabilityOf(agent) }))
        .filter((x) => x.blocked),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, store.devices, store.tools]
  );

  function updateMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([a-z0-9-]*)$/i);
    setMentionQuery(m ? m[1] : null);
    setMentionSel(0);
  }

  function insertMention(handle: string) {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    const before = text.slice(0, caret).replace(/@([a-z0-9-]*)$/i, `@${handle} `);
    setText(before + text.slice(caret));
    setMentionQuery(null);
    requestAnimationFrame(() => ta.focus());
  }

  function completeCommand(name: string) {
    setText(`/${name} `);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function insertEmoji(emoji: string) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? start;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    setShowEmoji(false);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  function dismissHint() {
    window.clearTimeout(hintTimer.current);
    setNoTargets(false);
  }

  async function send() {
    const content = text.trim();
    if (!content) return;
    setText("");
    setMentionQuery(null);

    // A command Spaces owns runs here and posts its answer; anything else — a
    // project command, something only the harness knows — is passed through
    // untouched. Same contract as the command palette, so both surfaces
    // answer "/mode lead" the same way.
    if (parseSlash(content)) {
      let outcome;
      try {
        outcome = await runCommand(channelId, content);
      } catch (e) {
        setText(content); // nothing was posted; keep what they typed
        toast.error("That command did not run", e);
        return;
      }
      if (outcome.handled) {
        if (outcome.message) {
          await store.insertMessage({
            id: uid(),
            channel_id: channelId,
            author_type: "system",
            author_id: "hq",
            author_name: config().brand,
            content: outcome.message,
            status: "done",
            meta: "",
            parent_id: parentId,
          });
        }
        return;
      }
    }

    const msg = await store.insertMessage({
      id: uid(),
      channel_id: channelId,
      author_type: "user",
      author_id: "user",
      author_name: useStore.getState().self().name,
      content,
      status: "done",
      meta: "",
      parent_id: parentId,
    });
    void triggerAgents(channelId, userTrigger(msg));
    // `[[Title]]` and `owner/name#123` become real edges on the message, which
    // is what puts them in the agents' standing context and on the graph.
    void autoLinkMessage(msg.id, channelId, content);
    // Multi-agent channel + no one addressed → the message just sits there.
    // Nudge instead of dead air.
    if (
      agents.length >= 2 &&
      resolveTargets(channelId, content).length === 0 &&
      mentionedPeople.length === 0
    ) {
      window.clearTimeout(hintTimer.current);
      setNoTargets(true);
      hintTimer.current = window.setTimeout(() => setNoTargets(false), 6000);
    }
  }

  return (
    <div className={"composer-wrap" + (inThread ? " in-thread" : "")}>
      {options.length > 0 && (
        <div className="mention-pop" role="listbox" id={listId} aria-label="People, agents, and teams">
          {options.map((o, i) => (
            <div
              key={o.handle}
              id={`${listId}-m${i}`}
              role="option"
              aria-selected={i === mentionAt}
              className={"mention-opt" + (i === mentionAt ? " mention-on" : "")}
              onMouseMove={() => setMentionSel(i)}
              onMouseDown={(e) => { e.preventDefault(); insertMention(o.handle); }}
            >
              <span className="mention">@{o.handle}</span>
              <span className="mention-label">{o.label}</span>
              {o.kind && <span className="chip tiny-chip">{o.kind}</span>}
            </div>
          ))}
        </div>
      )}
      {slashOptions.length > 0 && (
        <div className="mention-pop slash-pop" role="group" aria-label="Commands">
          {slashOptions.map((c) => (
            <button
              key={c.name}
              type="button"
              className="mention-opt slash-opt"
              onMouseDown={(e) => { e.preventDefault(); completeCommand(c.name); }}
              onClick={() => completeCommand(c.name)}
            >
              <span className="slash-name">/{c.name}</span>
              {c.args && <span className="slash-args">{c.args}</span>}
              <span className="mention-label">{c.description}</span>
              {/* Where the work happens is the difference that matters: Spaces's
                  own commands never reach a harness. */}
              <span className={"chip tiny-chip slash-scope" + (c.scope === "hq" ? " slash-local" : "")}>
                {c.scope === "hq" ? `runs in ${config().brand}` : "sent to the agent"}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* Channel-wide, so the main composer owns it — a thread would duplicate it. */}
      {!inThread && depth > 0 && (
        <div className="queue-note" role="status">
          <span className="queue-chip">
            <span className="queue-dot" />
            {depth} queued
          </span>
          <span className="queue-who">
            {waitingOn.length
              ? `waiting on ${waitingOn.join(", ")} to finish the current turn`
              : "waiting for the current turn to finish"}
          </span>
        </div>
      )}
      <div className="composer">
        <div className="composer-emoji">
          <button
            className="icon-btn emoji-trigger"
            title="Add emoji"
            aria-label="Add emoji"
            aria-expanded={showEmoji}
            onClick={() => setShowEmoji((open) => !open)}
          >
            ☺
          </button>
          {showEmoji && (
            <div className="emoji-pop composer-emoji-pop" role="menu">
              {QUICK_EMOJI.map((emoji) => (
                <button key={emoji} role="menuitem" onClick={() => insertEmoji(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={taRef}
          value={text}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={options.length > 0 ? listId : undefined}
          aria-activedescendant={mentionAt >= 0 ? `${listId}-m${mentionAt}` : undefined}
          placeholder={
            inThread
              ? "Reply in thread…"
              : agents.length
                ? `Message #… — @mention a person, agent, or team`
                : "Message… (add agents via the members button to get replies)"
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            if (noTargets) dismissHint();
            setSlashOff(false);
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              setMentionSel((Math.max(0, mentionAt) + delta + options.length) % options.length);
              return;
            }
            if (e.key === "Tab" && slashOptions.length && !e.shiftKey) {
              e.preventDefault();
              completeCommand(slashOptions[0].name);
              return;
            }
            if (e.key === "Enter" && mentionQuery !== null && options.length) {
              e.preventDefault();
              insertMention(options[mentionAt >= 0 ? mentionAt : 0].handle);
            } else if (e.key === "Enter" && !e.shiftKey) {
              // Includes an open-but-empty mention query — send, don't swallow.
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape") {
              setMentionQuery(null);
              setSlashOff(true);
            }
          }}
        />
        <button className="btn primary" onClick={send} disabled={!text.trim()}>Send</button>
      </div>

      {/* Who this message is about to reach, before it is sent. An agent whose
          host is offline or whose CLI is missing cannot answer, and finding
          that out afterwards costs the turn. */}
      {text.trim() && (
        <div className="compose-routing" role="status">
          {hqCommand ? (
            <span className="cr-line">
              <span className="cr-arrow" aria-hidden="true">↳</span>
              Runs in {config().brand}. Nothing is sent to the agents.
            </span>
          ) : targets.length ? (
            <span className="cr-line">
              <span className="cr-arrow" aria-hidden="true">↳</span>
              {targets.map((a) => (
                <span key={a.id} className="cr-who">
                  <span
                    className={"cr-dot" + (blocked.some((b) => b.agent.id === a.id) ? " cr-dot-off" : "")}
                    aria-hidden="true"
                  />
                  {agentIdentity(a.id).name || a.name}
                </span>
              ))}
              <span className="cr-verb">
                {targets.length === 1 ? "will answer" : "will all answer"}
              </span>
            </span>
          ) : mentionedPeople.length ? (
            <span className="cr-line">
              <span className="cr-arrow" aria-hidden="true">↳</span>
              {mentionedPeople.map((person) => (
                <span key={person.id} className="cr-who">
                  {person.name}
                </span>
              ))}
              <span className="cr-verb">mentioned · no agent run</span>
            </span>
          ) : agents.length ? (
            <span className="cr-line cr-none">
              Nobody is addressed — @mention an agent or team, or @all.
            </span>
          ) : null}
        </div>
      )}
      {blocked.map(({ agent, note }) => (
        <div key={agent.id} className="composer-hint composer-warn">
          {note}
        </div>
      ))}

      {noTargets && (
        <div className="composer-hint no-targets">
          Nobody was addressed — @mention an agent or team, or @all.
        </div>
      )}
      <div className="composer-foot">
        {!inThread && agents.length === 1 && (
          <span className="composer-hint">
            Messages here go to <span className="mention">@{slug(agents[0].name)}</span>{" "}
            automatically.
          </span>
        )}
        {(focused || text) && (
          <span className="composer-keys">
            <span><kbd>↵</kbd> send</span>
            <span><kbd>⇧↵</kbd> new line</span>
            {slashOptions.length > 0 && <span><kbd>↹</kbd> complete</span>}
          </span>
        )}
      </div>
    </div>
  );
}

function MembersModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const store = useStore();
  const members = store.channelMembers.filter((m) => m.channel_id === channelId);
  const isMember = (type: "agent" | "team", id: string) =>
    members.some((m) => m.member_type === type && m.member_id === id);

  return (
    <Modal title="Channel members" onClose={onClose}>
      <div className="member-section">
        <div className="field-label">Agents</div>
        {store.agents.length === 0 && (
          <div className="nav-empty">No agents yet — create them in Agents &amp; Teams.</div>
        )}
        {store.agents.map((a) => {
          const hasSession = store.getSession(channelId, a.id) !== "";
          const identity = agentIdentity(a.id);
          const availability = availabilityOf(a);
          return (
            <label key={a.id} className="member-row">
              <input
                type="checkbox"
                checked={isMember("agent", a.id)}
                onChange={(e) =>
                  e.target.checked
                    ? store.addChannelMember(channelId, "agent", a.id)
                    : store.removeChannelMember(channelId, "agent", a.id)
                }
              />
              <Avatar name={a.name} id={a.id} kind={a.kind} />
              <span>{identity.name || a.name}</span>
              {/* Whose agent it is, as its own tag — never folded into the name. */}
              {identity.tag && <span className="owner-tag">{identity.tag}</span>}
              {availability.blocked && (
                <span className="chip tiny-chip member-off" title={availability.note}>
                  {availability.label}
                </span>
              )}
              <span className="chip tiny-chip">{a.kind}{a.model ? ` · ${a.model}` : ""}</span>
              {hasSession && (
                <>
                  <span className="chip tiny-chip session-chip">
                    <IconBolt size={9} /> session
                  </span>
                  <button
                    className="icon-btn session-reset"
                    title="Forget conversation — next mention starts fresh"
                    aria-label="Forget conversation"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void store.clearSession(channelId, a.id);
                    }}
                  >
                    <IconX size={12} />
                  </button>
                </>
              )}
            </label>
          );
        })}
      </div>
      <div className="member-section">
        <div className="field-label">Teams</div>
        {store.teams.map((t) => {
          const count = store.teamMembers.filter((tm) => tm.team_id === t.id).length;
          return (
            <label key={t.id} className="member-row">
              <input
                type="checkbox"
                checked={isMember("team", t.id)}
                onChange={(e) =>
                  e.target.checked
                    ? store.addChannelMember(channelId, "team", t.id)
                    : store.removeChannelMember(channelId, "team", t.id)
                }
              />
              <Avatar name={t.name} id={t.id} />
              <span>{t.name}</span>
              <span className="chip tiny-chip">team · {count} agent{count === 1 ? "" : "s"}</span>
            </label>
          );
        })}
        {store.teams.length === 0 && <div className="nav-empty">No teams yet.</div>}
      </div>
    </Modal>
  );
}

function ProjectSettingsModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const store = useStore();
  const project = store.projects.find((p) => p.id === projectId)!;
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [repo, setRepo] = useState(project.repo);
  const [localPath, setLocalPath] = useState(project.local_path);

  return (
    <Modal title="Project settings" onClose={onClose}>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">GitHub repo (owner/name)</span>
        <GitHubRepoPicker value={repo} onChange={setRepo} />
      </label>
      <label className="field">
        <span className="field-label">Local checkout (agents work here)</span>
        <div className="row">
          <input
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder={config().samplePath}
          />
          <button
            className="btn"
            type="button"
            onClick={async () => {
              const picked = await open({ directory: true });
              if (typeof picked === "string") setLocalPath(picked);
            }}
          >
            Browse…
          </button>
        </div>
      </label>
      <div className="modal-actions space-between">
        <button
          className="btn danger"
          onClick={async () => {
            if (confirm(`Delete project "${project.name}" with all channels, tasks and memory?`)) {
              await store.deleteProject(projectId);
              onClose();
            }
          }}
        >Delete project</button>
        <button
          className="btn primary"
          onClick={async () => {
            await store.updateProject(projectId, {
              name: name.trim() || project.name,
              description: description.trim(),
              repo: repo.trim(),
              local_path: localPath.trim(),
            });
            onClose();
          }}
        >Save</button>
      </div>
    </Modal>
  );
}

/**
 * Mode picker. Native radios can't carry a two-line label without fighting the
 * global input styling, so this is the ARIA radiogroup pattern: roving tabstop,
 * arrow keys move (and select), the group is one tab stop.
 */
function ModeControl({
  value,
  onChange,
}: {
  value: ChannelMode;
  onChange: (mode: ChannelMode) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = MODES.findIndex((m) => m.id === value);

  function move(delta: number) {
    const from = index < 0 ? 0 : index;
    const next = (from + delta + MODES.length) % MODES.length;
    onChange(MODES[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div
      className="mode-options"
      role="radiogroup"
      aria-label="Channel mode"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {MODES.map((m, i) => {
        const on = m.id === value;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (index < 0 && i === 0) ? 0 : -1}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={"mode-option" + (on ? " active" : "")}
            onClick={() => onChange(m.id)}
          >
            <span className="mode-dot" aria-hidden="true" />
            <span className="mode-text">
              <span className="mode-name">{m.label}</span>
              <span className="mode-blurb">{m.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ChannelSettingsModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const store = useStore();
  const channel = store.channels.find((c) => c.id === channelId)!;
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);

  const agents = channelAgents(store, channelId);
  const mode = modeOf(channel.mode);
  const needsLead = mode === "lead" || mode === "panel";
  // What leadAgent() falls back to when nothing is configured.
  const fallback = rosterAgents(channelId)[0];
  const staleLead = !!channel.lead_agent_id && !agents.some((a) => a.id === channel.lead_agent_id);

  return (
    <Modal title="Channel settings" onClose={onClose}>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Topic</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>

      <div className="settings-section">
        <div className="section-head">
          <span className="field-label">Orchestration</span>
          <span className="section-note">Saved as you change it</span>
        </div>
        <ModeControl
          value={mode}
          onChange={(next) => void store.updateChannel(channelId, { mode: next })}
        />

        {needsLead && (
          <label className="field lead-field">
            <span className="field-label">Lead</span>
            <select
              value={staleLead ? "" : channel.lead_agent_id}
              disabled={agents.length === 0}
              onChange={(e) => void store.updateChannel(channelId, { lead_agent_id: e.target.value })}
            >
              <option value="">
                {fallback ? `First member (${fallback.name})` : "First member"}
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.role ? ` — ${a.role}` : ""}
                </option>
              ))}
            </select>
            {agents.length === 0 ? (
              <div className="lead-note warn">
                No agents in this channel yet — add members before this mode can do anything.
              </div>
            ) : staleLead ? (
              <div className="lead-note warn">
                The saved lead is no longer a member, so the first member leads. Pick someone to fix it.
              </div>
            ) : (
              <div className="lead-note">
                {mode === "lead"
                  ? "The lead answers first and hands work out; delegation needs chaining on."
                  : "The lead merges the panel's answers into one reply."}
              </div>
            )}
          </label>
        )}

        <label className="chaining-field">
          <input
            type="checkbox"
            checked={!!channel.chaining}
            onChange={(e) => void store.updateChannel(channelId, { chaining: e.target.checked ? 1 : 0 })}
          />
          <span>Agent chaining — agents can trigger each other by @mention</span>
        </label>
      </div>

      <div className="modal-actions space-between">
        <div className="row">
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm(`Delete #${channel.name} and all its messages?`)) {
                await store.deleteChannel(channelId);
                onClose();
              }
            }}
          >Delete channel</button>
          <button
            className="btn"
            onClick={async () => {
              if (confirm("Clear all messages in this channel?")) {
                await store.deleteChannelMessages(channelId);
                onClose();
              }
            }}
          >Clear history</button>
        </div>
        <button
          className="btn primary"
          onClick={async () => {
            await store.updateChannel(channelId, {
              name: name.trim().toLowerCase().replace(/\s+/g, "-") || channel.name,
              topic: topic.trim(),
            });
            onClose();
          }}
        >Save</button>
      </div>
    </Modal>
  );
}
