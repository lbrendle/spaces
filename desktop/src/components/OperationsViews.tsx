/**
 * Documents, Mail and Content Studio — the three operations surfaces.
 *
 * They share a shape on purpose: something searchable on the left, one thing
 * open on the right, and every state the data can genuinely be in spelled out
 * rather than implied. Two of the three talk to somebody else's server, so the
 * honest states are not decoration — a Send button that cannot send and a
 * publish that fails quietly are the two ways a surface like this loses work
 * somebody did.
 *
 * The calendar used to live here as a month grid. It moved to CalendarView.tsx,
 * which answers *whose* time you are looking at instead of just drawing cells.
 * What stayed behind is the provider bridge at the top of this file: syncing
 * Apple, Google and Microsoft is about accounts rather than about calendars,
 * it belongs beside the other integration plumbing, and the new view imports
 * it rather than growing a second copy.
 *
 * One shared idea runs through all three: when work is handed to an agent, the
 * exact text that will reach it is on screen and editable first. Agents inherit
 * whatever context you give them, and a surface that summarises a thread into a
 * prompt you never see is a surface that quietly decides what an agent knows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";
import { uid } from "../db";
import {
  createAppleCalendarEvent,
  createCalendarEvent,
  createCloudCalendarEvent,
  createContentItem,
  contentMedia,
  createDocument,
  createDraft,
  deleteContentItem,
  deleteDocument,
  duplicateDocument,
  listContentItems,
  listDocumentVersions,
  listIntegrationAccounts,
  listMail,
  patchContentItem,
  patchMailThread,
  publishContentItem,
  saveDocument,
  sendCloudMail,
  syncAppleCalendar,
  syncCloudCalendar,
  syncCloudMail,
  uploadContentMedia,
} from "../operations";
import type {
  CalendarEventRecord,
  ContentItem,
  DocumentVersion,
  IntegrationAccount,
  MailThread,
} from "../operations";
import {
  docAccess,
  docSharesVersion,
  forgetDocShares,
  subscribeDocShares,
  visibleDocuments,
} from "../docshares";
import type { SharedDocument } from "../docshares";
import { DocAccessBadge, DocShareButton } from "./DocumentsShare";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { triggerAgents, userTrigger } from "../agents";
import { agentIdentity } from "../entities";
import { useStore } from "../store";
import { slug } from "../types";
import {
  IconAgents,
  IconDocument,
  IconMail,
  IconMegaphone,
  IconPlus,
  IconSearch,
} from "./icons";
import { Pane } from "./Shell";
import { Field, Modal, mdToHtml } from "./ui";
import { confirmAction, toast } from "../toast";
import { config } from "../config";
import "./operations.css";

/* ── small shared pieces ──────────────────────────────────────── */

function shortDate(stamp: number): string {
  if (!stamp) return "No date";
  return new Date(stamp).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: new Date(stamp).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function shortDateTime(stamp: number): string {
  if (!stamp) return "Unscheduled";
  return new Date(stamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Just the clock. A save stamp is always today, so the date would be noise. */
function clockTime(stamp: number): string {
  return new Date(stamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The value a `datetime-local` input wants, in the viewer's own zone. */
function inputDateTime(stamp = Date.now() + 3_600_000): string {
  const date = new Date(stamp - new Date(stamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadText(name: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Grey bars in the shape of the rows that are coming.
 *
 * A spinner says "wait"; this says "a list is arriving, and roughly this big".
 * Matches the pattern the dashboard and Git activity already use, so a loading
 * pane looks the same wherever you meet one.
 */
function OpsSkeleton({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div className="ops-skel">
      <span className="sr-only" role="status">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span className="ops-skel-row" key={index} aria-hidden="true">
          <span className="ops-skel-bar" style={{ width: `${76 - index * 9}%` }} />
          <span className="ops-skel-bar thin" style={{ width: `${50 - index * 6}%` }} />
        </span>
      ))}
    </div>
  );
}

/** A named, self-describing empty state. Every one of these teaches the next step. */
function OpsEmpty({
  icon,
  title,
  children,
  action,
  compact,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={"ops-empty" + (compact ? " compact" : "")}>
      {icon}
      {compact ? <strong>{title}</strong> : <h2>{title}</h2>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

function connectionState(
  accounts: IntegrationAccount[],
  category: IntegrationAccount["category"],
  provider: string
): IntegrationAccount | undefined {
  return accounts.find((account) => account.category === category && account.provider === provider);
}

/**
 * An agent in a `<select>`, where only text fits.
 *
 * Its own name leads and whose it is trails as a separate token, never folded
 * into a possessive — "Ada · Priya's", not "Priya's Ada". A roster of people
 * should not read like a list of possessions just because the control is a
 * dropdown.
 */
function agentOptionLabel(agentId: string, role: string): string {
  const identity = agentIdentity(agentId);
  return [identity.name, role, identity.tag].filter(Boolean).join(" · ");
}

/* ── the calendar provider bridge ─────────────────────────────── */

/**
 * Everything CalendarView.tsx needs from the integrations layer.
 *
 * Syncing a provider is an account operation, not a calendar one: it writes
 * `integration_accounts`, it can fail for reasons that have nothing to do with
 * what week you are looking at, and Apple's version is a local permission
 * prompt while the other two round-trip through the portal. Keeping the three
 * behind one signature means a view can offer "connect" without knowing which
 * of those is true, and means there is exactly one place that turns a sync into
 * a sentence a person can read.
 */
export type CalendarBridgeProvider = "apple" | "google" | "microsoft";

const BRIDGE_LABEL: Record<CalendarBridgeProvider, string> = {
  apple: "Apple Calendar",
  google: "Google Calendar",
  microsoft: "Microsoft Calendar",
};

export interface CalendarBridge {
  provider: CalendarBridgeProvider;
  label: string;
  status: IntegrationAccount["status"];
  connected: boolean;
  /**
   * True when connecting happens on this machine rather than through the
   * portal — the difference between "grant permission" and "sign in", which is
   * the only thing a caller needs in order to word its button correctly.
   */
  local: boolean;
}

/** Which calendar providers exist, and where each one currently stands. */
export async function listCalendarBridges(): Promise<CalendarBridge[]> {
  const accounts = await listIntegrationAccounts();
  return (Object.keys(BRIDGE_LABEL) as CalendarBridgeProvider[]).map((provider) => {
    const account = connectionState(accounts, "calendar", provider);
    return {
      provider,
      label: BRIDGE_LABEL[provider],
      status: account?.status ?? "disconnected",
      connected: account?.status === "connected",
      local: provider === "apple",
    };
  });
}

export interface CalendarBridgeSync {
  /** Every event now stored, not just this provider's — the caller redraws all. */
  events: CalendarEventRecord[];
  /** How many of them came from this provider. */
  imported: number;
  /** One sentence, already worded, for a notice line. */
  note: string;
}

/**
 * Pull a provider's events in. Throws with the provider's own message when it
 * cannot: a sync that swallows "permission denied" is worse than one that fails.
 */
export async function syncCalendarBridge(
  provider: CalendarBridgeProvider
): Promise<CalendarBridgeSync> {
  const events =
    provider === "apple" ? await syncAppleCalendar() : await syncCloudCalendar(provider);
  const imported = events.filter((event) => event.provider === provider).length;
  return {
    events,
    imported,
    note: `${BRIDGE_LABEL[provider]} synced ${plural(imported, "event")}.`,
  };
}

/**
 * Create an event on a provider, or locally when `provider` is "local".
 * Local events are the ones this workspace owns outright; the rest are written
 * where they belong so the person's real calendar stays the source of truth.
 */
export function createCalendarBridgeEvent(
  provider: CalendarBridgeProvider | "local",
  input: {
    title: string;
    startAt: number;
    endAt: number;
    allDay?: boolean;
    location?: string;
    notes?: string;
  }
): Promise<CalendarEventRecord> {
  if (provider === "apple") return createAppleCalendarEvent(input);
  if (provider === "google" || provider === "microsoft") {
    return createCloudCalendarEvent(provider, input);
  }
  return createCalendarEvent(input);
}

/* ── handing work to an agent ─────────────────────────────────── */

interface DispatchPreset {
  id: string;
  label: string;
  /** The ask, in the first person, that leads the message. */
  instruction: string;
}

/**
 * The one place work leaves a surface and becomes an agent run.
 *
 * The whole modal exists to make one thing true: what you see in the box is
 * exactly what gets posted and exactly what the agent reads. No hidden preamble,
 * no silent truncation — the message is editable right up to the moment it is
 * sent, because the person who knows which paragraph matters is the one looking
 * at it.
 */
function AgentDispatch({
  title,
  meta,
  presets,
  context,
  included,
  projectId,
  onClose,
  onDispatched,
}: {
  title: string;
  /** Stamped on the message so the channel shows where the ask came from. */
  meta: string;
  presets: DispatchPreset[];
  /** The material itself — appended under whichever ask is chosen. */
  context: string;
  /** Plain-language inventory of what `context` contains. */
  included: string[];
  projectId?: string;
  onClose: () => void;
  onDispatched?: (agentId: string, channelId: string) => void | Promise<void>;
}) {
  const projects = useStore((state) => state.projects);
  const channels = useStore((state) => state.channels);
  const agents = useStore((state) => state.agents);
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "");
  const [channelId, setChannelId] = useState(
    () =>
      channels.find((channel) => channel.project_id === projectId)?.id ?? channels[0]?.id ?? ""
  );
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const agent = agents.find((row) => row.id === agentId);
  const preset = presets.find((row) => row.id === presetId) ?? presets[0];

  // Rebuilt whenever the ask or the agent changes, and then owned by whatever
  // the person types: an edit must never be thrown away by a re-render.
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const composed = useMemo(
    () =>
      `${agent ? `@${slug(agent.name)} ` : ""}${preset?.instruction ?? ""}\n\n${context}`.trim(),
    [agent, preset, context]
  );
  useEffect(() => {
    if (!edited) setBody(composed);
  }, [composed, edited]);

  const channel = channels.find((row) => row.id === channelId);
  const blocked = !channel
    ? "There is no channel to post into yet. Create a project with a channel first."
    : !agent
      ? "No agents yet. Add one in Agents & Teams, then it can pick this up."
      : "";

  async function send() {
    if (!channel || !agent || busy) return;
    setBusy(true);
    try {
      await useStore.getState().addChannelMember(channel.id, "agent", agent.id);
      const message = await useStore.getState().insertMessage({
        id: uid(),
        channel_id: channel.id,
        author_type: "user",
        author_id: "user",
        author_name: useStore.getState().self().name,
        content: body,
        status: "done",
        meta,
      });
      await onDispatched?.(agent.id, channel.id);
      useStore.getState().setView({ type: "channel", channelId: channel.id });
      void triggerAgents(channel.id, userTrigger(message));
      toast.success(`Sent to #${channel.name}`, `${agent.name} is picking it up.`);
      onClose();
    } catch (reason) {
      toast.error("Could not hand that over", reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="dispatch">
        {presets.length > 1 && (
          <div className="dispatch-presets" role="radiogroup" aria-label="What to ask for">
            {presets.map((option) => (
              <label
                key={option.id}
                className={"dispatch-preset" + (option.id === preset?.id ? " on" : "")}
              >
                <input
                  type="radio"
                  name="dispatch-preset"
                  checked={option.id === preset?.id}
                  onChange={() => {
                    setPresetId(option.id);
                    setEdited(false);
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
        )}
        <div className="form-row">
          <Field label="Channel">
            <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
              {channels.map((row) => {
                const project = projects.find((candidate) => candidate.id === row.project_id);
                return (
                  <option key={row.id} value={row.id}>
                    #{row.name}
                    {project ? ` · ${project.name}` : ""}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Agent">
            <select
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setEdited(false);
              }}
            >
              {agents.map((row) => (
                <option key={row.id} value={row.id}>
                  {agentOptionLabel(row.id, row.role)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="dispatch-included">
          <span className="field-label">What goes with it</span>
          <ul>
            {included.map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li>{plural(body.length, "character")} in total — the text below, unchanged.</li>
          </ul>
        </div>

        <Field label="The message, exactly as it will be posted">
          <textarea
            className="dispatch-body"
            rows={14}
            value={body}
            spellCheck={false}
            onChange={(event) => {
              setBody(event.target.value);
              setEdited(true);
            }}
          />
        </Field>

        {blocked && <div className="banner warn">{blocked}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          {edited && (
            <button className="btn subtle" onClick={() => setEdited(false)}>
              Reset to the default ask
            </button>
          )}
          <button
            className="btn primary"
            disabled={busy || !!blocked || !body.trim()}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : "Send it"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ── documents ────────────────────────────────────────────────── */

interface DocTemplate {
  id: string;
  label: string;
  blurb: string;
  path: string;
  title: string;
  body: string;
}

/**
 * Templates are questions, not prose.
 *
 * A blank page is the most expensive thing you can hand somebody, and a
 * template full of sample sentences is the second — people edit around filler
 * instead of replacing it. Each of these is the set of headings that make the
 * document useful to the next reader, human or agent, and nothing else.
 */
const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    blurb: "Nothing but a title. Start where you like.",
    path: "Notes",
    title: "Untitled",
    body: "",
  },
  {
    id: "brief",
    label: "Brief",
    blurb: "What we are doing and why, before anyone starts.",
    path: "Briefs",
    title: "Brief",
    body: "## The problem\n\n## What good looks like\n\n## Constraints\n\n## Out of scope\n\n## Open questions\n",
  },
  {
    id: "spec",
    label: "Spec",
    blurb: "The shape of a change, with the alternatives that lost.",
    path: "Specs",
    title: "Spec",
    body: "## Summary\n\n## Background\n\n## Approach\n\n## Alternatives considered\n\n## Risks\n\n## Rollout\n",
  },
  {
    id: "meeting",
    label: "Meeting notes",
    blurb: "Decisions and actions, so the meeting does not need repeating.",
    path: "Meetings",
    title: "Meeting notes",
    body: "**When:**\n\n**Who:**\n\n## Agenda\n\n## Decisions\n\n## Actions\n\n- [ ] \n",
  },
  {
    id: "decision",
    label: "Decision record",
    blurb: "One decision, its context, and what it costs.",
    path: "Decisions",
    title: "Decision",
    body: "**Status:** proposed\n\n## Context\n\n## Decision\n\n## Consequences\n\n## Revisit when\n",
  },
  {
    id: "research",
    label: "Research log",
    blurb: "A question, what you found, and what it changes.",
    path: "Research",
    title: "Research",
    body: "## Question\n\n## Sources\n\n## Findings\n\n## So what\n",
  },
  {
    id: "runbook",
    label: "Runbook",
    blurb: "Steps somebody can follow at three in the morning.",
    path: "Runbooks",
    title: "Runbook",
    body: "## When to use this\n\n## Steps\n\n1. \n\n## How to check it worked\n\n## If it goes wrong\n",
  },
];

const WIKI_TOKEN = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/**
 * Code islands in the HTML mdToHtml produces. Wiki links are rewritten
 * everywhere except inside these: a `[[token]]` written in a fence is somebody
 * showing you the syntax, and turning it into a working button would make the
 * example lie.
 */
const CODE_ISLAND = /(<pre class="codeblock">[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/;

function wikiLinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(WIKI_TOKEN)) {
    const title = match[1]?.trim();
    if (title) links.add(title);
  }
  return [...links];
}

/** Markdown, plus `[[wiki links]]` turned into real buttons. */
function documentHtml(body: string): string {
  return mdToHtml(body)
    .split(CODE_ISLAND)
    .map((part) =>
      part.startsWith("<pre class=\"codeblock\"") || part.startsWith("<code>")
        ? part
        : part.replace(WIKI_TOKEN, (_match, raw: string) => {
            const name = raw.trim();
            return `<button type="button" class="wiki-link" data-wiki="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
          })
    )
    .join("");
}

interface DocNode {
  name: string;
  path: string;
  children: DocNode[];
  docs: SharedDocument[];
}

/** `documents.path` is a folder path; this turns the flat column into the tree. */
function buildDocTree(docs: SharedDocument[]): DocNode {
  const root: DocNode = { name: "", path: "", children: [], docs: [] };
  for (const doc of docs) {
    const segments = (doc.path || "Notes").split("/").map((part) => part.trim()).filter(Boolean);
    let node = root;
    for (const segment of segments.length ? segments : ["Notes"]) {
      let child = node.children.find((candidate) => candidate.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          children: [],
          docs: [],
        };
        node.children.push(child);
      }
      node = child;
    }
    node.docs.push(doc);
  }
  const sort = (node: DocNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

function countDocs(node: DocNode): number {
  return node.docs.length + node.children.reduce((total, child) => total + countDocs(child), 0);
}

function folderPaths(node: DocNode, into: string[] = []): string[] {
  for (const child of node.children) {
    into.push(child.path);
    folderPaths(child, into);
  }
  return into;
}

/**
 * Write / Split / Read.
 *
 * Split exists because the preview toggle made the two halves compete for the
 * same column: you could look at your Markdown or at the result, never at both,
 * so checking a table meant leaving the sentence you were in. On a narrow
 * window the two columns stack rather than shrink — half a measure each is
 * worse than one good one.
 */
type DocViewMode = "write" | "split" | "read";

const DOC_MODES: Array<{ id: DocViewMode; label: string; hint: string }> = [
  { id: "write", label: "Write", hint: "The Markdown on its own (⌘E)" },
  { id: "split", label: "Split", hint: "Markdown and preview side by side" },
  { id: "read", label: "Read", hint: "The rendered document (⌘E)" },
];

/** The keys the rail's tree navigation claims; everything else falls through. */
const TREE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

/**
 * What the editor can honestly say about your work, most urgent first.
 *
 * Nobody should have to guess. Each of these is a different colour, a different
 * word and a different dot, and the chip re-mounts when it changes so the switch
 * is something you see happen rather than something you notice later.
 */
type SaveState = "readonly" | "error" | "saving" | "dirty" | "saved";

export function DocumentsView() {
  const projects = useStore((state) => state.projects);
  // Sharing lives in its own cache with its own change bus, so a visibility
  // change made in the panel has to reach this component or the editor would
  // stay writable after somebody dropped themselves to read.
  const shareVersion = useSyncExternalStore(subscribeDocShares, docSharesVersion, docSharesVersion);

  const [docs, setDocs] = useState<SharedDocument[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<SharedDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<DocViewMode>("write");
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [briefing, setBriefing] = useState(false);
  const [linkTarget, setLinkTarget] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  /**
   * Bumped on every edit. A save is an await, and somebody typing through one
   * must not have those keystrokes counted as saved when it lands — comparing
   * the count either side of the round trip is the whole check.
   */
  const editSeq = useRef(0);

  const reload = useCallback(async () => {
    const rows = await visibleDocuments();
    setDocs(rows);
    return rows;
  }, []);

  useEffect(() => {
    void reload().then((rows) => {
      const first = rows[0];
      if (!first) return;
      setSelectedId(first.id);
      setDraft(first);
      void listDocumentVersions(first.id).then(setVersions);
    });
  }, [reload]);

  const all = docs ?? [];
  const scoped = useMemo(
    () => (projectFilter ? all.filter((doc) => doc.project_id === projectFilter) : all),
    [all, projectFilter]
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return scoped;
    return scoped.filter((doc) =>
      `${doc.title} ${doc.path} ${doc.tags} ${doc.body}`.toLowerCase().includes(needle)
    );
  }, [scoped, query]);
  const tree = useMemo(() => buildDocTree(matches), [matches]);
  const folders = useMemo(() => folderPaths(buildDocTree(all)), [all]);
  const searching = !!query.trim();
  const pinned = useMemo(() => scoped.filter((doc) => doc.pinned), [scoped]);
  // Five, and only once the tree is big enough that walking it is a chore.
  // Pinned rows are excluded: they are already two inches higher up the rail,
  // and a document listed twice makes the rail look longer than it is.
  const recent = useMemo(
    () =>
      scoped
        .filter((doc) => !doc.pinned)
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 5),
    [scoped]
  );
  const showRecent = !searching && scoped.length > 6;

  // Recomputed on every share change, which is the only reason shareVersion is
  // read at all: docAccess answers from a module cache React cannot see.
  const access = useMemo(
    () => (draft ? docAccess(draft) : null),
    [draft, shareVersion]
  );
  const readOnly = access !== "write";

  const backlinks = useMemo(() => {
    if (!draft) return [];
    const target = draft.title.trim().toLowerCase();
    if (!target) return [];
    return all.filter(
      (doc) =>
        doc.id !== draft.id &&
        wikiLinks(doc.body).some((title) => title.toLowerCase() === target)
    );
  }, [all, draft]);
  const outgoing = useMemo(() => (draft ? wikiLinks(draft.body) : []), [draft]);

  const openDoc = useCallback(
    async (doc: SharedDocument) => {
      if (dirty && doc.id !== draft?.id) {
        const ok = await confirmAction({
          title: "Leave without saving?",
          body: `“${draft?.title || "Untitled"}” has changes that are not written yet.`,
          confirmLabel: "Discard changes",
          danger: true,
        });
        if (!ok) return;
      }
      editSeq.current += 1;
      setSelectedId(doc.id);
      setDraft(doc);
      setDirty(false);
      setSaveFailed(false);
      setSavedAt(0);
      setNotice("");
      setShowVersions(false);
      setVersions(await listDocumentVersions(doc.id));
    },
    // The view mode is deliberately not reset: somebody who chose Split chose
    // how they want to work, not how they want to look at one document.
    [dirty, draft]
  );

  function patch(next: Partial<SharedDocument>) {
    editSeq.current += 1;
    setDraft((current) => (current ? { ...current, ...next } : current));
    setDirty(true);
    setSaveFailed(false);
  }

  async function save() {
    if (!draft || readOnly || saving) return;
    const seq = editSeq.current;
    const snapshot: SharedDocument = { ...draft, title: draft.title.trim() || "Untitled" };
    setSaving(true);
    try {
      // saveDocument speaks DocumentRecord and returns the row it wrote; the
      // ownership columns ride along on the copy we already hold.
      const saved = await saveDocument(snapshot);
      setDocs((current) =>
        (current ?? []).map((doc) =>
          doc.id === saved.id ? { ...doc, ...snapshot, ...saved } : doc
        )
      );
      // Only `updated_at` is news. Writing the whole saved row back would undo
      // anything typed while the write was in flight.
      setDraft((current) =>
        current && current.id === saved.id
          ? { ...current, title: seq === editSeq.current ? snapshot.title : current.title, updated_at: saved.updated_at }
          : current
      );
      setSaveFailed(false);
      if (seq === editSeq.current) {
        setDirty(false);
        setSavedAt(Date.now());
      }
      setVersions(await listDocumentVersions(saved.id));
    } catch (reason) {
      // Both, on purpose: the toast carries the reason, the chip stays red so
      // the state is still visible after the toast has gone.
      setSaveFailed(true);
      toast.error("Could not save this document", reason);
    } finally {
      setSaving(false);
    }
  }

  async function createFrom(template: DocTemplate, titleOverride = "") {
    try {
      const created = await createDocument(projectFilter || projects[0]?.id || "", template.path);
      const saved = await saveDocument({
        ...created,
        title: titleOverride || template.title,
        body: template.body,
      });
      const rows = await reload();
      const row = rows.find((doc) => doc.id === saved.id);
      if (row) await openDoc(row);
      setTemplating(false);
      setQuery("");
      setNotice(
        titleOverride
          ? `“${titleOverride}” is ready — it has no text yet.`
          : template.id === "blank"
            ? "New document ready."
            : `Started from ${template.label}. Replace the headings, do not write around them.`
      );
    } catch (reason) {
      toast.error("Could not create that document", reason);
    }
  }

  async function duplicate() {
    if (!draft) return;
    try {
      const copy = await duplicateDocument(draft);
      const rows = await reload();
      const row = rows.find((doc) => doc.id === copy.id);
      if (row) await openDoc(row);
      setNotice("Duplicate ready.");
    } catch (reason) {
      toast.error("Could not duplicate this document", reason);
    }
  }

  async function remove() {
    if (!draft) return;
    const ok = await confirmAction({
      title: `Delete “${draft.title || "Untitled"}”?`,
      body: "Its version history and everyone's shares go with it. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDocument(draft.id);
      await forgetDocShares(draft.id);
      const rows = await reload();
      editSeq.current += 1;
      setSelectedId(rows[0]?.id ?? "");
      setDraft(rows[0] ?? null);
      setDirty(false);
      setSaveFailed(false);
      setSavedAt(0);
      setVersions(rows[0] ? await listDocumentVersions(rows[0].id) : []);
    } catch (reason) {
      toast.error("Could not delete this document", reason);
    }
  }

  function restoreVersion(version: DocumentVersion) {
    if (!draft || readOnly) return;
    patch({
      title: version.title,
      body: version.body,
      tags: version.tags,
      path: version.path,
    });
    setShowVersions(false);
    setNotice("Restored into the editor. Save to keep it.");
  }

  function openWikiLink(title: string) {
    const target = all.find(
      (doc) => doc.title.trim().toLowerCase() === title.trim().toLowerCase()
    );
    if (target) {
      void openDoc(target);
      return;
    }
    setNotice(`Nothing here is called “${title}” yet.`);
  }

  function insertWikiLink() {
    if (!draft || !linkTarget || readOnly) return;
    const token = `[[${linkTarget}]]`;
    const textarea = bodyRef.current;
    if (!textarea) {
      patch({ body: `${draft.body}${draft.body ? "\n" : ""}${token}` });
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    patch({ body: `${draft.body.slice(0, start)}${token}${draft.body.slice(end)}` });
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      for (const file of Array.from(files)) {
        const relative = file.webkitRelativePath || file.name;
        const parts = relative.split("/");
        parts.pop();
        const created = await createDocument(
          projectFilter || projects[0]?.id || "",
          parts.join("/") || "Imported"
        );
        await saveDocument({
          ...created,
          title: file.name.replace(/\.(md|markdown|txt)$/i, "") || file.name,
          body: await file.text(),
          source: "markdown",
        });
      }
      const rows = await reload();
      if (rows[0]) await openDoc(rows[0]);
      setNotice(`Imported ${plural(files.length, "file")}.`);
    } catch (reason) {
      toast.error("Could not import those files", reason);
    }
  }

  function setFolderOpen(path: string, open: boolean) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /**
   * ⌘S saves, ⌘E flips between writing and reading, ⌘K and ⌘F reach the search
   * box, Escape closes history.
   *
   * ⌘K is the command palette everywhere else in the app, and the sidebar
   * advertises it. So it is borrowed rather than taken: the first press jumps
   * to this view's search, and a second press — with the caret already in that
   * box — is let through to the palette. The shortcut people were taught still
   * works from here; it just costs one extra keystroke while you are in a
   * surface that has its own search.
   */
  function onPaneKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const accel = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (accel && key === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (accel && key === "e") {
      event.preventDefault();
      setMode((value) => (value === "read" ? "write" : "read"));
      return;
    }
    if (accel && (key === "f" || key === "k")) {
      if (key === "k" && document.activeElement === searchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (event.key === "Escape" && showVersions) {
      setShowVersions(false);
    }
  }

  /**
   * The rail is a tree, so it answers like one: up and down walk every visible
   * row, right opens a folder or steps into it, left closes it or steps out to
   * its parent, Home and End jump the ends.
   */
  function onTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!TREE_KEYS.has(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]"));
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();

    if (event.key === "Home") return void rows[0]?.focus();
    if (event.key === "End") return void rows[rows.length - 1]?.focus();
    if (event.key === "ArrowDown") return void rows[index + 1]?.focus();
    if (event.key === "ArrowUp") return void rows[index - 1]?.focus();

    const folder = rows[index].dataset.folder;
    if (event.key === "ArrowRight") {
      if (folder && collapsed.has(folder)) setFolderOpen(folder, true);
      else rows[index + 1]?.focus();
      return;
    }
    if (folder && !collapsed.has(folder)) {
      setFolderOpen(folder, false);
      return;
    }
    const depth = Number(rows[index].dataset.depth ?? 0);
    for (let step = index - 1; step >= 0; step -= 1) {
      if (Number(rows[step].dataset.depth ?? 0) < depth) return void rows[step].focus();
    }
  }

  function renderNode(node: DocNode, depth: number): ReactNode {
    const total = countDocs(node);
    if (!total) return null;
    const isCollapsed = collapsed.has(node.path);
    return (
      <section className="doc-folder" key={node.path}>
        <button
          className="doc-folder-head"
          data-tree-row
          data-folder={node.path}
          data-depth={depth}
          style={{ "--doc-depth": depth } as CSSProperties}
          aria-expanded={!isCollapsed}
          onClick={() => setFolderOpen(node.path, isCollapsed)}
        >
          <span className={"doc-folder-caret" + (isCollapsed ? "" : " open")} aria-hidden="true">
            ▸
          </span>
          <strong>{node.name}</strong>
          <small>{total}</small>
        </button>
        {!isCollapsed && (
          <div className="doc-folder-body">
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.docs.map((doc) => (
              <DocRow
                key={doc.id}
                doc={doc}
                depth={depth + 1}
                active={doc.id === selectedId}
                onOpen={() => void openDoc(doc)}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  const project = projects.find((row) => row.id === draft?.project_id);
  const saveState: SaveState = readOnly
    ? "readonly"
    : saveFailed
      ? "error"
      : saving
        ? "saving"
        : dirty
          ? "dirty"
          : "saved";
  const saveLabel =
    saveState === "readonly"
      ? "Read-only"
      : saveState === "error"
        ? "Not saved"
        : saveState === "saving"
          ? "Saving…"
          : saveState === "dirty"
            ? "Unsaved changes"
            : savedAt
              ? `Saved ${clockTime(savedAt)}`
              : "Saved";

  return (
    <Pane
      title={<><IconDocument size={19} /> Documents</>}
      subtitle="Write it once, share it deliberately, and let the agents who need it read it."
      actions={
        <div className="ops-header-right">
          <input
            ref={importRef}
            className="sr-only"
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            multiple
            onChange={(event) => {
              void importFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button className="btn" onClick={() => importRef.current?.click()}>
            Import Markdown
          </button>
          <button className="btn primary" onClick={() => setTemplating(true)}>
            <IconPlus size={14} /> New document
          </button>
        </div>
      }
      scroll={false}
      max={false}
      pad={false}
      className="ops"
      onKeyDown={onPaneKeyDown}
    >
      <div className="ops-split">
        <aside className="ops-list" aria-label="Documents">
          <div className="ops-rail-head">
            <div className="ops-search">
              <IconSearch size={14} />
              <input
                ref={searchRef}
                aria-label="Search documents"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
              />
              {query ? (
                <button
                  className="ops-search-clear"
                  aria-label="Clear the search"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  ✕
                </button>
              ) : (
                <kbd className="ops-search-key" aria-hidden="true">⌘K</kbd>
              )}
            </div>
            <select
              className="ops-filter"
              aria-label="Filter documents by project"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((row) => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
            </select>
          </div>

          <div className="ops-list-scroll" onKeyDown={onTreeKeyDown}>
            {!docs && <OpsSkeleton rows={5} label="Loading your documents…" />}

            {docs && !all.length && (
              <OpsEmpty
                compact
                icon={<IconDocument size={20} />}
                title="Nothing written yet"
                action={
                  <button className="btn primary" onClick={() => setTemplating(true)}>
                    <IconPlus size={13} /> New document
                  </button>
                }
              >
                Start from a brief, a spec or meeting notes — or import Markdown you already have.
              </OpsEmpty>
            )}

            {docs && !!all.length && !matches.length && (
              <OpsEmpty
                compact
                icon={<IconSearch size={20} />}
                title="Nothing matches"
                action={
                  searching ? (
                    <button
                      className="btn primary"
                      onClick={() => void createFrom(DOC_TEMPLATES[0], query.trim())}
                    >
                      <IconPlus size={13} /> Start “{query.trim()}”
                    </button>
                  ) : (
                    <button className="btn primary" onClick={() => setTemplating(true)}>
                      <IconPlus size={13} /> New document
                    </button>
                  )
                }
              >
                {searching
                  ? `No document mentions “${query.trim()}”.`
                  : "This project has nothing in it yet."}
              </OpsEmpty>
            )}

            {docs && !!matches.length && searching && (
              <section className="doc-group">
                <h3 className="doc-group-head">
                  <span>Results</span>
                  <small className="num">{matches.length}</small>
                </h3>
                {matches.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    depth={0}
                    showPath
                    active={doc.id === selectedId}
                    onOpen={() => void openDoc(doc)}
                  />
                ))}
              </section>
            )}

            {docs && !!matches.length && !searching && (
              <>
                {/* Pinned and Recent answer "what is mine" and "where was I" —
                    the two questions a folder tree is structurally unable to. */}
                {!!pinned.length && (
                  <section className="doc-group">
                    <h3 className="doc-group-head">
                      <span>Pinned</span>
                      <small className="num">{pinned.length}</small>
                    </h3>
                    {pinned.map((doc) => (
                      <DocRow
                        key={doc.id}
                        doc={doc}
                        depth={0}
                        showPath
                        active={doc.id === selectedId}
                        onOpen={() => void openDoc(doc)}
                      />
                    ))}
                  </section>
                )}
                {showRecent && (
                  <section className="doc-group">
                    <h3 className="doc-group-head">
                      <span>Recent</span>
                      <small className="num">{recent.length}</small>
                    </h3>
                    {recent.map((doc) => (
                      <DocRow
                        key={doc.id}
                        doc={doc}
                        depth={0}
                        showPath
                        active={doc.id === selectedId}
                        onOpen={() => void openDoc(doc)}
                      />
                    ))}
                  </section>
                )}
                <section className="doc-group">
                  <h3 className="doc-group-head">
                    <span>{pinned.length || showRecent ? "All documents" : "Documents"}</span>
                    <small className="num">{scoped.length}</small>
                  </h3>
                  {tree.children.map((child) => renderNode(child, 0))}
                </section>
              </>
            )}
          </div>
        </aside>

        <section className="doc-editor">
          {!docs ? (
            <OpsSkeleton rows={6} label="Loading the document…" />
          ) : !draft ? (
            <OpsEmpty
              icon={<IconDocument size={28} />}
              title="Your shared working memory"
              action={
                <button className="btn primary" onClick={() => setTemplating(true)}>
                  <IconPlus size={14} /> Start from a template
                </button>
              }
            >
              Briefs, specs, meeting notes, decisions. A document is private until you say
              otherwise — and sharing it with an agent is how it becomes that agent's context.
            </OpsEmpty>
          ) : (
            <>
              <div className="doc-bar">
                {/* Group one: the answer to "is my work safe?", and nothing else.
                    It never carries any other message — see the notice line. */}
                <div className="doc-bar-state">
                  <span className={"doc-save " + saveState} role="status" key={saveState}>
                    <span className="doc-save-dot" aria-hidden="true" />
                    {saveLabel}
                  </span>
                  <span className="doc-stats num">
                    {plural(wordCount(draft.body), "word")} · edited {shortDate(draft.updated_at)}
                  </span>
                </div>

                {/* Group two: lifecycle. Rare, quiet, and grouped away from the
                    controls somebody reaches for while actually writing. */}
                <div className="doc-bar-group">
                  <button
                    className="btn subtle"
                    aria-expanded={showVersions}
                    onClick={() => setShowVersions((value) => !value)}
                  >
                    History{versions.length ? <span className="num"> {versions.length}</span> : ""}
                  </button>
                  <button className="btn subtle" onClick={() => void duplicate()}>Duplicate</button>
                  <button
                    className="btn subtle"
                    onClick={() =>
                      downloadText(
                        `${slug(draft.title || "untitled") || "document"}.md`,
                        `# ${draft.title}\n\n${draft.body}`
                      )
                    }
                  >
                    Export
                  </button>
                  <button className="btn danger subtle" onClick={() => void remove()}>Delete</button>
                </div>

                {/* Group three: how you are looking at it. */}
                <div className="ops-seg" role="group" aria-label="How this document is shown">
                  {DOC_MODES.map((option) => (
                    <button
                      key={option.id}
                      className={"ops-seg-btn" + (mode === option.id ? " on" : "")}
                      aria-pressed={mode === option.id}
                      title={option.hint}
                      onClick={() => setMode(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {/* Group four: what you do with it. */}
                <div className="doc-bar-group">
                  <DocShareButton documentId={draft.id} />
                  <button className="btn subtle" onClick={() => setBriefing(true)}>
                    <IconAgents size={13} /> Ask an agent
                  </button>
                  <button
                    className="btn primary"
                    disabled={!dirty || readOnly || saving}
                    onClick={() => void save()}
                    title="Save (⌘S)"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              {readOnly && (
                <div className="banner info ops-notice">
                  {access === "read"
                    ? "You can read this document but not change it. Ask its owner for write access."
                    : "This document is not shared with you."}
                </div>
              )}
              {notice && (
                <div className="banner info ops-notice anim-rise">
                  {notice}
                  <button className="icon-btn" aria-label="Dismiss" onClick={() => setNotice("")}>
                    ✕
                  </button>
                </div>
              )}

              <div className="doc-sheet">
                <div className="doc-head">
                  <input
                    className="doc-title"
                    aria-label="Document title"
                    value={draft.title}
                    readOnly={readOnly}
                    onChange={(event) => patch({ title: event.target.value })}
                    placeholder="Untitled"
                  />

                  {/* Metadata above the body, not buried under it: where this
                      lives and who it belongs to is part of reading it. */}
                  <div className="doc-props">
                    <label className="doc-prop">
                      <span className="field-label">Folder</span>
                      <input
                        list="document-folders"
                        value={draft.path}
                        disabled={readOnly}
                        onChange={(event) => patch({ path: event.target.value })}
                        placeholder="Notes"
                      />
                    </label>
                    <datalist id="document-folders">
                      {folders.map((folder) => <option key={folder} value={folder} />)}
                    </datalist>
                    <label className="doc-prop">
                      <span className="field-label">Project</span>
                      <select
                        value={draft.project_id}
                        disabled={readOnly}
                        onChange={(event) => patch({ project_id: event.target.value })}
                      >
                        <option value="">Workspace-wide</option>
                        {projects.map((row) => (
                          <option key={row.id} value={row.id}>{row.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="doc-prop grow">
                      <span className="field-label">Tags</span>
                      <input
                        value={draft.tags}
                        readOnly={readOnly}
                        onChange={(event) => patch({ tags: event.target.value })}
                        placeholder="Comma separated"
                      />
                    </label>
                    <button
                      className={"doc-pin" + (draft.pinned ? " on" : "")}
                      aria-pressed={!!draft.pinned}
                      disabled={readOnly}
                      title={draft.pinned ? "Unpin from the top of the rail" : "Pin to the top of the rail"}
                      onClick={() => patch({ pinned: draft.pinned ? 0 : 1 })}
                    >
                      <span aria-hidden="true">{draft.pinned ? "★" : "☆"}</span>
                      {draft.pinned ? "Pinned" : "Pin"}
                    </button>
                  </div>
                </div>

                <div className={"doc-write " + mode}>
                  {mode !== "read" && (
                    <textarea
                      ref={bodyRef}
                      className="doc-body"
                      aria-label="Document body, Markdown"
                      value={draft.body}
                      readOnly={readOnly}
                      onChange={(event) => patch({ body: event.target.value })}
                      placeholder="Markdown. Use [[Another document]] to link one to another."
                    />
                  )}
                  {mode !== "write" && (
                    <article
                      className="doc-preview md prose"
                      onClick={(event: ReactMouseEvent<HTMLElement>) => {
                        const hit = (event.target as HTMLElement).closest<HTMLElement>("[data-wiki]");
                        if (hit) openWikiLink(hit.dataset.wiki ?? "");
                      }}
                      dangerouslySetInnerHTML={{
                        __html: documentHtml(draft.body || "*Nothing to preview yet.*"),
                      }}
                    />
                  )}
                </div>

                {showVersions && (
                  <aside className="doc-versions anim-rise">
                    <header>
                      <strong>History</strong>
                      <span>A snapshot is kept every time the text changes.</span>
                    </header>
                    {versions.map((version) => (
                      <button
                        key={version.id}
                        disabled={readOnly}
                        onClick={() => restoreVersion(version)}
                      >
                        <strong>{version.title || "Untitled"}</strong>
                        <span className="num">{shortDateTime(version.created_at)}</span>
                        <small>
                          {plural(wordCount(version.body), "word")} ·{" "}
                          {version.body.replace(/\s+/g, " ").slice(0, 110) || "empty"}
                        </small>
                      </button>
                    ))}
                    {!versions.length && (
                      <div className="column-empty">
                        Nothing to go back to yet — the first save starts the history.
                      </div>
                    )}
                  </aside>
                )}

                <div className="doc-rails">
                  <section className="doc-rail-card">
                    <header>
                      <strong>Links in this document</strong>
                      <span className="num">{outgoing.length}</span>
                    </header>
                    {outgoing.map((title) => (
                      <button key={title} className="doc-rail-link" onClick={() => openWikiLink(title)}>
                        [[{title}]]
                      </button>
                    ))}
                    {!outgoing.length && (
                      <small>Write <code>[[a title]]</code> to point at another document.</small>
                    )}
                    {/* The place to make a link is next to the links, not in a
                        toolbar three groups away from them. */}
                    <div className="doc-rail-insert">
                      <select
                        aria-label="Document to link to"
                        value={linkTarget}
                        disabled={readOnly || mode === "read"}
                        onChange={(event) => setLinkTarget(event.target.value)}
                      >
                        <option value="">Link a document…</option>
                        {all
                          .filter((doc) => doc.id !== draft.id)
                          .map((doc) => (
                            <option key={doc.id} value={doc.title}>
                              {doc.path}/{doc.title}
                            </option>
                          ))}
                      </select>
                      <button
                        className="btn subtle"
                        disabled={!linkTarget || readOnly || mode === "read"}
                        title={mode === "read" ? "Switch to Write or Split to insert a link" : undefined}
                        onClick={insertWikiLink}
                      >
                        Insert
                      </button>
                    </div>
                  </section>
                  <section className="doc-rail-card">
                    <header>
                      <strong>Points here</strong>
                      <span className="num">{backlinks.length}</span>
                    </header>
                    {backlinks.map((doc) => (
                      <button
                        key={doc.id}
                        className="doc-rail-link"
                        onClick={() => void openDoc(doc)}
                      >
                        {doc.path}/{doc.title}
                      </button>
                    ))}
                    {!backlinks.length && <small>Nothing links here yet.</small>}
                  </section>
                </div>

                <section className="doc-connections">
                  <header>
                    <strong>Connections</strong>
                    <span>
                      {project
                        ? `Everything ${project.name} is attached to`
                        : "Put this document in a project to connect it"}
                    </span>
                  </header>
                  {project ? (
                    <>
                      <p className="doc-connections-why">
                        Documents reach agents two ways: shared directly, above, or through the
                        project they sit in. Anything linked here rides along as standing context
                        for work in {project.name}.
                      </p>
                      <ConnectionsPanel anchor={{ type: "project", id: project.id }} compact />
                    </>
                  ) : (
                    <p className="doc-connections-why">
                      This document is workspace-wide, so it has no project graph of its own. Pick a
                      project above to link it to tasks, channels and repositories.
                    </p>
                  )}
                </section>
              </div>
            </>
          )}
        </section>
      </div>

      {templating && (
        <Modal title="New document" onClose={() => setTemplating(false)} wide>
          <p className="ops-modal-lead">
            Every template is a set of headings and nothing else — replace them, do not write
            around them.
          </p>
          <div className="template-grid">
            {DOC_TEMPLATES.map((template) => (
              <button
                key={template.id}
                className="template-card"
                onClick={() => void createFrom(template)}
              >
                <strong>{template.label}</strong>
                <span>{template.blurb}</span>
                <small>{template.path}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {briefing && draft && (
        <AgentDispatch
          title={`Ask an agent about “${draft.title || "Untitled"}”`}
          meta="Documents · handed over"
          projectId={draft.project_id}
          onClose={() => setBriefing(false)}
          included={[
            `The document “${draft.title || "Untitled"}”, all ${plural(wordCount(draft.body), "word")} of it.`,
            `Its folder (${draft.path || "Notes"})${draft.tags ? ` and tags (${draft.tags})` : ""}.`,
            "Nothing else — no other document, no channel history beyond the channel you pick.",
          ]}
          context={`# ${draft.title}\n\n${draft.body}`}
          presets={[
            {
              id: "context",
              label: "Use as context",
              instruction: "read this and use it as working context for what comes next.",
            },
            {
              id: "review",
              label: "Review it",
              instruction:
                "review this document. Tell me what is unclear, what is missing, and what you would cut.",
            },
            {
              id: "summarise",
              label: "Summarise it",
              instruction:
                "summarise this document in five bullets, then list every open question it leaves.",
            },
          ]}
        />
      )}
    </Pane>
  );
}

/**
 * One document in the rail.
 *
 * Two lines, fixed: what it is called and its sharing on the first, where and
 * when on the second. The body snippet that used to sit between them cost two
 * more lines per row and answered a question nobody was asking of a list —
 * you cannot skim thirty documents if each one is a paragraph.
 */
function DocRow({
  doc,
  depth,
  active,
  showPath,
  onOpen,
}: {
  doc: SharedDocument;
  depth: number;
  active: boolean;
  showPath?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      data-tree-row
      data-depth={depth}
      className={"ops-list-row focus-inset" + (active ? " active" : "")}
      style={{ "--doc-depth": depth } as CSSProperties}
      aria-current={active ? "true" : undefined}
      onClick={onOpen}
    >
      <span className="doc-row-title">
        {!!doc.pinned && <span className="doc-row-pin" aria-label="Pinned">★</span>}
        <strong>{doc.title || "Untitled"}</strong>
        <DocAccessBadge documentId={doc.id} />
      </span>
      <span className="doc-row-meta">
        {showPath && <span className="doc-row-path">{doc.path}</span>}
        <span className="num">{shortDate(doc.updated_at)}</span>
      </span>
    </button>
  );
}

/* ── mail ─────────────────────────────────────────────────────── */

const MAIL_FOLDERS: Array<{ id: MailThread["folder"]; label: string; blank: string }> = [
  { id: "inbox", label: "Inbox", blank: "Nothing has arrived here yet." },
  { id: "drafts", label: "Drafts", blank: "No drafts. Anything you compose and save lands here." },
  { id: "sent", label: "Sent", blank: "Nothing sent from here yet." },
  { id: "archive", label: "Archive", blank: "Nothing archived yet." },
];

type MailFilter = "all" | "unread" | "starred";

/** "Re: Re: Fwd: launch" and "launch" are the same conversation. */
function baseSubject(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
}

/**
 * Which account a row came from.
 *
 * Synced rows are keyed `<provider>-<remote id>` by operations.ts, which is the
 * only place the provider survives — `account_id` is whatever the remote called
 * the mailbox. Reading the prefix is therefore the honest answer rather than a
 * guess, and anything without one was written here.
 */
function mailProvider(thread: MailThread): string {
  if (thread.id.startsWith("google-")) return "google";
  if (thread.id.startsWith("microsoft-")) return "microsoft";
  return "local";
}

interface Conversation {
  key: string;
  subject: string;
  messages: MailThread[];
  latest: MailThread;
  unread: number;
  starred: boolean;
  participants: string[];
}

function conversationsOf(threads: MailThread[]): Conversation[] {
  const groups = new Map<string, MailThread[]>();
  for (const thread of threads) {
    const key = baseSubject(thread.subject).toLowerCase() || thread.id;
    const list = groups.get(key);
    if (list) list.push(thread);
    else groups.set(key, [thread]);
  }
  const out: Conversation[] = [];
  for (const [key, list] of groups) {
    const messages = [...list].sort((a, b) => a.received_at - b.received_at);
    const latest = messages[messages.length - 1];
    const participants = [
      ...new Set(
        messages
          .map((message) => message.from_name || message.from_email)
          .filter((name): name is string => !!name)
      ),
    ];
    out.push({
      key,
      subject: baseSubject(latest.subject) || latest.subject || "(no subject)",
      messages,
      latest,
      unread: messages.filter((message) => message.unread).length,
      starred: messages.some((message) => message.starred),
      participants,
    });
  }
  return out.sort((a, b) => b.latest.received_at - a.latest.received_at);
}

/** Quoted history, folded away. A reply is mostly the message you already read. */
function MailBody({ body }: { body: string }) {
  const blocks = useMemo(() => {
    const out: Array<{ quoted: boolean; text: string }> = [];
    for (const line of (body || "").split("\n")) {
      const quoted = /^\s*>/.test(line);
      const last = out[out.length - 1];
      if (last && last.quoted === quoted) last.text += `\n${line}`;
      else out.push({ quoted, text: line });
    }
    return out.filter((block) => block.text.trim() || !block.quoted);
  }, [body]);

  return (
    <div className="mail-copy">
      {blocks.map((block, index) =>
        block.quoted ? (
          <details className="mail-quote" key={index}>
            <summary>{plural(block.text.split("\n").length, "quoted line")}</summary>
            <pre>{block.text}</pre>
          </details>
        ) : (
          <p key={index}>{block.text}</p>
        )
      )}
    </div>
  );
}

/** How full a folder is, so the rail answers "where is the work" before you click. */
interface FolderCount {
  total: number;
  unread: number;
}

export function MailView() {
  const setView = useStore((state) => state.setView);
  const [folder, setFolder] = useState<MailThread["folder"]>("inbox");
  const [threads, setThreads] = useState<MailThread[] | null>(null);
  const [counts, setCounts] = useState<Record<string, FolderCount>>({});
  const [accounts, setAccounts] = useState<IntegrationAccount[] | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MailFilter>("all");
  const [providerFilter, setProviderFilter] = useState("");
  const [compose, setCompose] = useState<Partial<MailThread> | null>(null);
  const [briefing, setBriefing] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const countFolders = useCallback(async () => {
    const next: Record<string, FolderCount> = {};
    for (const item of MAIL_FOLDERS) {
      const rows = await listMail(item.id);
      next[item.id] = { total: rows.length, unread: rows.filter((row) => row.unread).length };
    }
    setCounts(next);
  }, []);

  useEffect(() => {
    setThreads(null);
    void listMail(folder).then((rows) => {
      setThreads(rows);
      setSelectedKey(conversationsOf(rows)[0]?.key ?? "");
    });
  }, [folder]);
  useEffect(() => {
    void listIntegrationAccounts().then(setAccounts);
    void countFolders();
  }, [countFolders]);

  const mailAccounts = (accounts ?? []).filter((account) => account.category === "mail");
  const connected = mailAccounts.filter((account) => account.status === "connected");
  const connectedProviders = [
    ...new Set(
      connected
        .map((account) => account.provider)
        .filter((provider): provider is "google" | "microsoft" =>
          provider === "google" || provider === "microsoft"
        )
    ),
  ];

  const rows = threads ?? [];
  const providers = [...new Set(rows.map(mailProvider))];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((thread) => {
      if (filter === "unread" && !thread.unread) return false;
      if (filter === "starred" && !thread.starred) return false;
      if (providerFilter && mailProvider(thread) !== providerFilter) return false;
      if (!needle) return true;
      return `${thread.subject} ${thread.from_name} ${thread.from_email} ${thread.to_email} ${thread.body}`
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, query, filter, providerFilter]);
  const conversations = useMemo(() => conversationsOf(visible), [visible]);
  const selected =
    conversations.find((conversation) => conversation.key === selectedKey) ?? conversations[0] ?? null;
  const folderSpec = MAIL_FOLDERS.find((item) => item.id === folder);
  const narrowed = !!query.trim() || filter !== "all" || !!providerFilter;

  /**
   * The folder counts, with the one you are looking at answered from the rows
   * already on screen. Marking something read has to move its badge now, not
   * after a round trip nobody asked for.
   */
  const folderCounts = useMemo(() => {
    if (!threads) return counts;
    return {
      ...counts,
      [folder]: { total: threads.length, unread: threads.filter((row) => row.unread).length },
    };
  }, [counts, threads, folder]);

  async function syncMail() {
    if (!connectedProviders.length) {
      setView({ type: "settings" });
      return;
    }
    if (folder !== "inbox" && folder !== "sent") {
      setNotice(
        "Sync covers Inbox and Sent. Drafts and Archive are local to this workspace and stay put."
      );
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      let next: MailThread[] = [];
      for (const provider of connectedProviders) next = await syncCloudMail(provider, folder);
      setThreads(next);
      setSelectedKey(conversationsOf(next)[0]?.key ?? "");
      setNotice(`Synced ${plural(next.length, "message")} into ${folder}.`);
      void countFolders();
    } catch (reason) {
      toast.error("Could not sync mail", reason);
    } finally {
      setBusy(false);
    }
  }

  async function openConversation(conversation: Conversation) {
    setSelectedKey(conversation.key);
    const unread = conversation.messages.filter((message) => message.unread);
    if (!unread.length) return;
    const ids = new Set(unread.map((message) => message.id));
    setThreads((current) =>
      (current ?? []).map((row) => (ids.has(row.id) ? { ...row, unread: 0 } : row))
    );
    for (const message of unread) {
      await patchMailThread(message.id, { unread: 0 }).catch(() => {});
    }
  }

  function patchLocal(id: string, next: Partial<MailThread>) {
    setThreads((current) => (current ?? []).map((row) => (row.id === id ? { ...row, ...next } : row)));
  }

  /**
   * A star belongs to the conversation, not to whichever message happened to
   * be last. Starring one and showing the badge from another is how a row ends
   * up starred-looking and un-starrable at the same time.
   */
  async function toggleStar(conversation: Conversation) {
    const starred = conversation.starred ? 0 : 1;
    const before = conversation.messages.map((message) => ({ id: message.id, starred: message.starred }));
    for (const message of conversation.messages) patchLocal(message.id, { starred });
    try {
      for (const message of conversation.messages) {
        await patchMailThread(message.id, { starred });
      }
    } catch (reason) {
      for (const row of before) patchLocal(row.id, { starred: row.starred });
      toast.error("Could not change that", reason);
    }
  }

  async function archive(conversation: Conversation) {
    const ids = conversation.messages.map((message) => message.id);
    setThreads((current) => (current ?? []).filter((row) => !ids.includes(row.id)));
    setSelectedKey("");
    for (const id of ids) await patchMailThread(id, { folder: "archive" }).catch(() => {});
    void countFolders();
  }

  /** Up and down walk the conversation list without reaching for the mouse. */
  function onListKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-mail-row]"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    items[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  }

  /** Same bargain as Documents: ⌘K and ⌘F reach this view's search first. */
  function onPaneKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const accel = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (!accel || (key !== "f" && key !== "k")) return;
    if (key === "k" && document.activeElement === searchRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  return (
    <Pane
      title={<><IconMail size={19} /> Mail</>}
      /* No subtitle: it described the product rather than the screen, and the
       * screen is a mail client — it does not need to introduce itself. */
      actions={
        <div className="ops-header-right">
          <span className={"provider-state" + (connected.length ? " connected" : "")}>
            {connected.length ? `${plural(connected.length, "account")} connected` : "No mail account"}
          </span>
          <button className="btn" onClick={() => setView({ type: "settings" })}>
            {connected.length ? "Accounts" : "Connect mail"}
          </button>
          {!!connectedProviders.length && (
            <button className="btn" disabled={busy} onClick={() => void syncMail()}>
              {busy ? "Syncing…" : "Sync"}
            </button>
          )}
          <button className="btn primary" onClick={() => setCompose({})}>
            <IconPlus size={14} /> {connected.length ? "Compose" : "New draft"}
          </button>
        </div>
      }
      scroll={false}
      max={false}
      pad={false}
      className="ops"
      onKeyDown={onPaneKeyDown}
    >
      {notice && (
        <div className="banner info ops-notice anim-rise">
          {notice}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setNotice("")}>✕</button>
        </div>
      )}
      {/* The "no account" banner that used to sit here said, at length, what
       * three other things on this screen already say: the state chip, the
       * Connect button beside it, and the inbox's own empty state, which also
       * carried the same call to action. One statement is enough, and the
       * empty state is where somebody looking at an empty inbox is looking. */}

      <div className="mail-shell">
        <aside className="mail-folders" aria-label="Mailboxes">
          <div className="ops-search">
            <IconSearch size={13} />
            <input
              ref={searchRef}
              aria-label="Search mail"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
            />
            {query ? (
              <button
                className="ops-search-clear"
                aria-label="Clear the search"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                ✕
              </button>
            ) : (
              <kbd className="ops-search-key" aria-hidden="true">⌘K</kbd>
            )}
          </div>

          <nav className="mail-folder-list">
            {MAIL_FOLDERS.map((item) => {
              const count = folderCounts[item.id];
              return (
                <button
                  key={item.id}
                  className={"mail-folder" + (folder === item.id ? " active" : "")}
                  aria-current={folder === item.id ? "true" : undefined}
                  onClick={() => setFolder(item.id)}
                >
                  <span className="mail-folder-name">{item.label}</span>
                  {!!count?.unread && (
                    <span className="mail-folder-unread num" title={`${count.unread} unread`}>
                      {count.unread}
                    </span>
                  )}
                  {!count?.unread && !!count?.total && (
                    <span className="mail-folder-total num">{count.total}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mail-facets" role="group" aria-label="Filter this folder">
            <span className="field-label">Show</span>
            {(["all", "unread", "starred"] as MailFilter[]).map((value) => (
              <button
                key={value}
                className={"mail-facet" + (filter === value ? " on" : "")}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "Everything" : value === "unread" ? "Unread" : "Starred"}
              </button>
            ))}
            {providers.length > 1 && (
              <>
                <span className="field-label">From</span>
                <button
                  className={"mail-facet" + (providerFilter === "" ? " on" : "")}
                  aria-pressed={providerFilter === ""}
                  onClick={() => setProviderFilter("")}
                >
                  Any account
                </button>
                {providers.map((provider) => (
                  <button
                    key={provider}
                    className={"mail-facet" + (providerFilter === provider ? " on" : "")}
                    aria-pressed={providerFilter === provider}
                    onClick={() => setProviderFilter(provider)}
                  >
                    {provider === "local" ? config().brand : provider}
                  </button>
                ))}
              </>
            )}
          </div>
        </aside>

        <section className="mail-list" onKeyDown={onListKeyDown}>
          {!threads && <OpsSkeleton rows={6} label="Loading this folder…" />}
          {threads &&
            conversations.map((conversation) => {
              const active = conversation.key === selected?.key;
              return (
                <div
                  key={conversation.key}
                  className={
                    "mail-row-wrap" + (active ? " active" : "") + (conversation.unread ? " unread" : "")
                  }
                >
                  <button
                    data-mail-row
                    className="mail-row focus-inset"
                    aria-current={active ? "true" : undefined}
                    onClick={() => void openConversation(conversation)}
                  >
                    <span className="mail-row-top">
                      <span className="mail-from">
                        {folder === "drafts"
                          ? `To ${conversation.latest.to_email || "nobody yet"}`
                          : conversation.participants.join(", ") || conversation.latest.from_email}
                      </span>
                      {conversation.messages.length > 1 && (
                        <span className="mail-count num">{conversation.messages.length}</span>
                      )}
                      <time className="mail-date num">
                        {shortDate(conversation.latest.received_at)}
                      </time>
                    </span>
                    <strong className="mail-subject">
                      {conversation.subject || "(no subject)"}
                    </strong>
                    <span className="mail-preview">
                      {conversation.latest.preview || "No preview"}
                    </span>
                  </button>
                  {/* Outside the row button, absolutely placed: a control inside
                      another control is invalid, and reserving its space up front
                      is what stops the row reflowing when it lights up. */}
                  <button
                    className={"mail-star" + (conversation.starred ? " on" : "")}
                    aria-pressed={conversation.starred}
                    aria-label={
                      conversation.starred
                        ? `Unstar “${conversation.subject}”`
                        : `Star “${conversation.subject}”`
                    }
                    onClick={() => void toggleStar(conversation)}
                  >
                    <span aria-hidden="true">{conversation.starred ? "★" : "☆"}</span>
                  </button>
                </div>
              );
            })}
          {threads && !conversations.length && (
            <OpsEmpty
              compact
              icon={<IconMail size={22} />}
              title={narrowed ? "Nothing matches" : folderSpec?.label ?? "Empty"}
              action={
                narrowed ? (
                  <button
                    className="btn"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                      setProviderFilter("");
                    }}
                  >
                    Clear the filters
                  </button>
                ) : folder === "inbox" && !connected.length ? (
                  <button className="btn primary" onClick={() => setView({ type: "settings" })}>
                    Connect a mail account
                  </button>
                ) : undefined
              }
            >
              {narrowed
                ? "Nothing in this folder matches what you asked for."
                : folder === "inbox" && !connected.length
                  ? "Mail arrives once an account is connected. Drafts work without one — they stay on this device."
                  : folderSpec?.blank ?? "Nothing in this folder."}
            </OpsEmpty>
          )}
        </section>

        {/* With no threads the reader renders nothing, and a third of the
         * screen went to holding that nothing while the list beside it stayed
         * capped at 340px. It gives the column back instead. */}
        <section className={"mail-reader" + (threads && !threads.length ? " mail-reader-off" : "")}>
          {!threads ? (
            <OpsSkeleton rows={4} label="Loading the conversation…" />
          ) : selected ? (
            <>
              <div className="mail-reader-head">
                <span className="field-label">
                  {selected.messages.length > 1
                    ? `${plural(selected.messages.length, "message")} · ${folder}`
                    : folder}
                </span>
                <h2>{selected.subject || "(no subject)"}</h2>
                <p>
                  {folder === "drafts"
                    ? `To ${selected.latest.to_email || "no recipient yet"}`
                    : selected.participants.join(", ") || selected.latest.from_email}
                </p>
                <div className="mail-reader-actions">
                  <button
                    className={"btn subtle" + (selected.starred ? " active" : "")}
                    aria-pressed={selected.starred}
                    onClick={() => void toggleStar(selected)}
                  >
                    {selected.starred ? "★ Starred" : "☆ Star"}
                  </button>
                  {folder === "inbox" && (
                    <button className="btn subtle" onClick={() => void archive(selected)}>
                      Archive
                    </button>
                  )}
                  <button className="btn subtle" onClick={() => setBriefing(selected)}>
                    <IconAgents size={13} /> Ask an agent
                  </button>
                  {folder === "drafts" ? (
                    <button
                      className="btn primary"
                      onClick={() =>
                        setCompose({
                          to_email: selected.latest.to_email,
                          subject: selected.latest.subject,
                          body: selected.latest.body,
                        })
                      }
                    >
                      Continue draft
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      // Worded for what will actually happen. With nothing
                      // connected this cannot send, and a button labelled
                      // "Reply" would be promising otherwise.
                      title={
                        connected.length
                          ? undefined
                          : "No mail account is connected, so this can only be kept as a draft"
                      }
                      onClick={() =>
                        setCompose({
                          to_email: selected.latest.from_email,
                          subject: /^re:/i.test(selected.latest.subject)
                            ? selected.latest.subject
                            : `Re: ${selected.latest.subject}`,
                          body: `\n\n${selected.latest.body
                            .split("\n")
                            .map((line) => `> ${line}`)
                            .join("\n")}`,
                        })
                      }
                    >
                      {connected.length ? "Reply" : "Draft a reply"}
                    </button>
                  )}
                </div>
              </div>

              <div className="mail-thread">
                {selected.messages.map((message) => (
                  <article className="mail-message" key={message.id}>
                    <header>
                      <strong>{message.from_name || message.from_email || "Unknown sender"}</strong>
                      <span>{message.to_email ? `to ${message.to_email}` : ""}</span>
                      <time className="num">{shortDateTime(message.received_at)}</time>
                    </header>
                    <MailBody body={message.body || message.preview} />
                  </article>
                ))}
              </div>
            </>
          ) : threads.length ? (
            <OpsEmpty icon={<IconMail size={28} />} title="Nothing selected">
              Pick a conversation on the left. Agents can draft a reply or summarise a thread — and
              you see the exact text they are given before it goes.
            </OpsEmpty>
          ) : null /* An empty folder has nothing to pick, so "pick a conversation
              on the left" is an instruction that cannot be followed — and it was
              sitting next to the list that had just finished saying there is
              nothing there. Two empty states side by side, one of them wrong.
              With no threads the reader is simply blank and the list speaks. */}
        </section>
      </div>

      {compose && (
        <ComposeModal
          connectedProviders={connectedProviders}
          initial={compose}
          onClose={() => setCompose(null)}
          onSaved={(draft) => {
            setCompose(null);
            setFolder("drafts");
            setThreads((current) => [draft, ...(current ?? [])]);
            setSelectedKey(baseSubject(draft.subject).toLowerCase() || draft.id);
            void countFolders();
          }}
          onSent={(sent) => {
            setCompose(null);
            setFolder("sent");
            setThreads((current) => [sent, ...(current ?? [])]);
            setSelectedKey(baseSubject(sent.subject).toLowerCase() || sent.id);
            void countFolders();
          }}
        />
      )}

      {briefing && (
        <AgentDispatch
          title={`Ask an agent about “${briefing.subject}”`}
          meta="Mail · handed over"
          onClose={() => setBriefing(null)}
          included={[
            `The subject line and ${plural(briefing.messages.length, "message")} from this conversation.`,
            `Everyone on it: ${briefing.participants.join(", ") || "unknown"}.`,
            "The full text of each message, quoted history included.",
            "No other conversation, and no attachment.",
          ]}
          context={[
            `Subject: ${briefing.subject}`,
            ...briefing.messages.map(
              (message) =>
                `\n---\nFrom: ${message.from_name || message.from_email}\nTo: ${message.to_email}\nDate: ${shortDateTime(message.received_at)}\n\n${message.body || message.preview}`
            ),
          ].join("\n")}
          presets={[
            {
              id: "reply",
              label: "Draft a reply",
              instruction:
                "draft a reply to this thread. Post the draft here for me to check — do not send anything.",
            },
            {
              id: "summary",
              label: "Summarise it",
              instruction:
                "summarise this thread: what is being asked, what has been agreed, and what is still open.",
            },
            {
              id: "actions",
              label: "Pull out the actions",
              instruction:
                "list every action this thread commits us to, who owns it, and any deadline it names.",
            },
          ]}
        />
      )}
    </Pane>
  );
}

function ComposeModal({
  connectedProviders,
  initial,
  onClose,
  onSaved,
  onSent,
}: {
  connectedProviders: Array<"google" | "microsoft">;
  initial: Partial<MailThread>;
  onClose: () => void;
  onSaved: (draft: MailThread) => void;
  onSent: (sent: MailThread) => void;
}) {
  const [to, setTo] = useState(initial.to_email ?? "");
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [body, setBody] = useState(initial.body ?? "");
  const [provider, setProvider] = useState<"google" | "microsoft">(
    connectedProviders[0] ?? "google"
  );
  const [busy, setBusy] = useState(false);
  const canSend = connectedProviders.length > 0;
  const empty = !to.trim() && !subject.trim() && !body.trim();

  async function saveDraft() {
    setBusy(true);
    try {
      onSaved(await createDraft({ to, subject, body }));
    } catch (reason) {
      toast.error("Could not save this draft", reason);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    try {
      onSent(await sendCloudMail(provider, { to, subject, body }));
    } catch (reason) {
      toast.error("Could not send that", reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={canSend ? "New message" : "New draft"} onClose={onClose} wide>
      <Field label="To">
        <input
          autoFocus
          value={to}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setTo(event.target.value)}
        />
      </Field>
      <Field label="Subject">
        <input value={subject} onChange={(event) => setSubject(event.target.value)} />
      </Field>
      <Field label="Message">
        <textarea rows={14} value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      {canSend ? (
        <Field label="Send from">
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as "google" | "microsoft")}
          >
            {connectedProviders.map((value) => (
              <option key={value} value={value}>
                {value === "google" ? "Google Workspace" : "Microsoft 365"}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        /*
         * No Send button at all when nothing is connected. A disabled one is a
         * promise the app cannot keep — it reads as "not yet" when the truth is
         * "not from here". Saying what this draft *is* costs one sentence.
         */
        <div className="banner warn">
          Nothing is connected, so this can only be kept as a draft in {config().brand} on this
          device. Connect a mail account in Settings and the same draft becomes sendable.
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || empty} onClick={() => void saveDraft()}>
          Save draft
        </button>
        {canSend && (
          <button
            className="btn primary"
            disabled={busy || !to.trim()}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ── content studio ───────────────────────────────────────────── */

/**
 * The pipeline, and everything a piece still needs before it can leave.
 *
 * Five stages across the board, one piece open beside it. The split is the
 * whole design: a card carries *state* — where it is, where it is going, whose
 * it is, whether the last attempt failed — and the panel carries *actions*.
 * Neither repeats the other, which is why the card has no toolbar and the panel
 * has no summary.
 *
 * One rule runs through the publishing half of it: a target that cannot publish
 * from here says so exactly where the button would have been, names the account
 * that is missing rather than saying "not connected", and still offers the
 * manual route with the copy ready to take. An unconnected network is a detour.
 * It is never a dead end, and it never silently drops work somebody did.
 */

interface ContentStage {
  id: ContentItem["status"];
  label: string;
  /** What the stage is for, said forwards. An empty column should recruit. */
  empty: string;
  /** The button that fills it — every empty column can be acted on. */
  cta: string;
}

const CONTENT_STAGES: ContentStage[] = [
  {
    id: "idea",
    label: "Idea",
    empty: "Everything starts as a line you did not want to lose.",
    cta: "Add an idea",
  },
  {
    id: "drafting",
    label: "Drafting",
    empty: "Nothing is being written. Pull an idea across, or brief an agent.",
    cta: "Start a draft",
  },
  {
    id: "review",
    label: "Review",
    empty: "Nothing is waiting on a human read.",
    cta: "Add something to read",
  },
  {
    id: "scheduled",
    label: "Scheduled",
    empty: "Nothing is queued. A piece here has a time and a target.",
    cta: "Queue a piece",
  },
  {
    id: "published",
    label: "Published",
    empty: "Nothing has gone out from here yet.",
    cta: "Log one you posted by hand",
  },
];

const CONTENT_STATUSES: ContentItem["status"][] = CONTENT_STAGES.map((stage) => stage.id);

function stageOf(status: ContentItem["status"]): ContentStage {
  return CONTENT_STAGES.find((stage) => stage.id === status) ?? CONTENT_STAGES[0];
}

/** The keys the board's own navigation claims; everything else falls through. */
const BOARD_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

interface ContentTarget {
  id: string;
  label: string;
  /** The provider key an integration account is stored under. "" is plan-only. */
  provider: string;
  /** The account a person would actually go and connect, in their own words. */
  account: string;
  /** Whether operations.ts will genuinely attempt a publish for this target. */
  publishable: boolean;
  /** Media this target cannot post without. */
  media: "image" | "video" | "";
  /** What the network counts to, or 0 when it does not count. */
  limit: number;
}

/**
 * The publishing targets, and the truth about each one.
 *
 * `publishable` mirrors what publishContentItem will actually attempt, and
 * `account` is deliberately the *account* rather than the network: Instagram
 * publishes through Meta, and telling somebody "Instagram is not connected"
 * sends them looking for a row that does not exist.
 */
const CONTENT_TARGETS: ContentTarget[] = [
  { id: "instagram", label: "Instagram", provider: "meta", account: "Meta", publishable: true, media: "image", limit: 2200 },
  { id: "tiktok", label: "TikTok", provider: "tiktok", account: "TikTok", publishable: true, media: "video", limit: 2200 },
  { id: "x", label: "X", provider: "x", account: "X", publishable: true, media: "", limit: 280 },
  { id: "linkedin", label: "LinkedIn", provider: "linkedin", account: "LinkedIn", publishable: false, media: "", limit: 3000 },
  { id: "youtube", label: "YouTube", provider: "youtube", account: "Google", publishable: false, media: "video", limit: 5000 },
  { id: "multi", label: "Several", provider: "", account: "", publishable: false, media: "", limit: 0 },
];

function targetOf(platform: string): ContentTarget {
  return (
    CONTENT_TARGETS.find((target) => target.id === platform) ?? {
      id: platform,
      label: platform || "No target",
      provider: platform,
      account: platform,
      publishable: false,
      media: "",
      limit: 0,
    }
  );
}

interface SocialAccountMetadata {
  connectionId?: string;
  projectLinks?: Array<{
    projectId: string;
    isDefault: boolean;
  }>;
}

function socialAccountMetadata(account: IntegrationAccount): SocialAccountMetadata {
  try {
    const parsed = JSON.parse(account.metadata) as SocialAccountMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function socialAccountConnectionId(account: IntegrationAccount): string {
  return socialAccountMetadata(account).connectionId ?? account.id.replace(/^portal-/, "");
}

function socialAccountsFor(
  accounts: IntegrationAccount[] | null,
  target: ContentTarget,
  projectId: string,
): IntegrationAccount[] {
  if (!target.publishable || !target.provider) return [];
  return (accounts ?? [])
    .filter((account) => {
      if (
        account.category !== "social" ||
        account.status !== "connected" ||
        account.provider !== target.provider
      ) {
        return false;
      }
      if (!projectId) return true;
      return (socialAccountMetadata(account).projectLinks ?? []).some(
        (link) => link.projectId === projectId,
      );
    })
    .sort((left, right) => {
      const leftDefault =
        socialAccountMetadata(left).projectLinks?.some(
          (link) => link.projectId === projectId && link.isDefault,
        ) ?? false;
      const rightDefault =
        socialAccountMetadata(right).projectLinks?.some(
          (link) => link.projectId === projectId && link.isDefault,
        ) ?? false;
      return Number(rightDefault) - Number(leftDefault) || left.handle.localeCompare(right.handle);
    });
}

/**
 * " through your Meta account", or nothing at all.
 *
 * Instagram posts through Meta and TikTok posts through TikTok; saying "your X
 * account" about X is the sentence reading itself back, so the clause only
 * appears when the account and the network are genuinely different things.
 */
function throughAccount(target: ContentTarget): string {
  return target.account && target.account !== target.label
    ? ` through your ${target.account} account`
    : "";
}

/** What a target needs beyond words, in words. */
function mediaNeed(target: ContentTarget): string {
  if (target.media === "image") return "an image URL the network can fetch";
  if (target.media === "video") return "a video URL the network can fetch";
  return "";
}

function mediaKind(url: string): "image" | "video" | "other" {
  if (!/^https?:\/\//i.test(url)) return "other";
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  return "other";
}

/**
 * Everything standing between this piece and the network, most fixable first.
 *
 * Being disconnected is deliberately not in here: that is a state of the
 * workspace rather than of the piece, it has its own sentence and its own
 * button, and mixing the two would make "connect an account" look like a typo
 * you could fix in the copy box.
 */
function publishBlockers(item: ContentItem, target: ContentTarget): string[] {
  const blockers: string[] = [];
  const copy = item.copy.trim();
  const media = item.media_url.trim();
  if (!copy) blockers.push("There is no copy to post yet.");
  if (target.media && !media) blockers.push(`${target.label} needs ${mediaNeed(target)}.`);
  if (target.media && media) {
    const kind = mediaKind(media);
    if (kind !== "other" && kind !== target.media) {
      blockers.push(`The media attached looks like ${kind}, and ${target.label} posts ${target.media}.`);
    }
  }
  const over = target.limit ? copy.length - target.limit : 0;
  if (over > 0) {
    blockers.push(`The copy is ${plural(over, "character")} over ${target.label}'s ${target.limit}.`);
  }
  return blockers;
}

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A scheduled time read back in full, in the zone the person is actually in.
 *
 * A picker that shows 09:30 and a row that shows 09:30 can both be right and
 * still be six hours apart from what the network does. Spelling out the day,
 * the zone abbreviation and how far away it is costs one line and removes the
 * entire class of "I thought that was this morning".
 */
function longLocalTime(stamp: number): string {
  return new Date(stamp).toLocaleString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
];

/** "in 3 days" / "2 hours ago" — the distance, not the timestamp. */
function relativeWhen(stamp: number, from = Date.now()): string {
  const delta = stamp - from;
  if (Math.abs(delta) < 60_000) return delta >= 0 ? "in under a minute" : "just now";
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60_000;
  for (const [candidate, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms) {
      unit = candidate;
      size = ms;
    }
  }
  return new Intl.RelativeTimeFormat([], { numeric: "auto" }).format(
    Math.round(delta / size),
    unit
  );
}

/** The columns patchContentItem accepts, so a save can send only what moved. */
const CONTENT_FIELDS = [
  "project_id",
  "campaign",
  "title",
  "brief",
  "copy",
  "platform",
  "connection_id",
  "status",
  "scheduled_at",
  "published_url",
  "media_url",
  "media_items",
  "publish_error",
  "agent_id",
] as const;

type ContentPatch = Partial<Pick<ContentItem, (typeof CONTENT_FIELDS)[number]>>;

function contentDiff(before: ContentItem, after: ContentItem): ContentPatch {
  const patch: Record<string, unknown> = {};
  for (const key of CONTENT_FIELDS) {
    if (before[key] !== after[key]) patch[key] = after[key];
  }
  return patch as ContentPatch;
}

function MediaPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const kind = mediaKind(url);
  if (!url) return null;
  if (failed || kind === "other") {
    return (
      <a className="content-media-link" href={url} target="_blank" rel="noreferrer">
        {failed ? "Media did not load — open it" : "Media attached"}
      </a>
    );
  }
  return (
    <div className="content-media">
      {kind === "image" ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          // The card itself is the drag handle; an image that starts its own
          // drag would swallow every attempt to move the card.
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <video src={url} muted playsInline preload="metadata" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

export function ContentStudioView() {
  const projects = useStore((state) => state.projects);
  const agents = useStore((state) => state.agents);
  const setView = useStore((state) => state.setView);

  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [accounts, setAccounts] = useState<IntegrationAccount[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ContentItem | null>(null);
  const [boardFocused, setBoardFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [publishingId, setPublishingId] = useState("");
  const [briefing, setBriefing] = useState<ContentItem | null>(null);
  const [dragging, setDragging] = useState("");
  // Which column the card is currently over. Lighting up all five said "you
  // may drop anywhere", which is true and useless; one lit column says where.
  const [dropTarget, setDropTarget] = useState("");

  const boardRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  /** A card moved by the keyboard leaves the DOM and comes back in the next
   *  column; without this the focus it had lands on the body instead. */
  const refocus = useRef("");
  /** Bumped on every edit, so a save that lands after you kept typing cannot
   *  mark those later keystrokes as written. */
  const editSeq = useRef(0);

  useEffect(() => {
    const refreshContent = () => void listContentItems().then(setItems);
    refreshContent();
    void listIntegrationAccounts().then(setAccounts);
    window.addEventListener("hq:content-change", refreshContent);
    return () => window.removeEventListener("hq:content-change", refreshContent);
  }, []);

  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = "";
    boardRef.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.focus();
  }, [items]);

  const connectedProviders = useMemo(() => {
    const set = new Set<string>();
    for (const account of accounts ?? []) {
      if (account.status !== "connected") continue;
      if (account.category === "social") {
        set.add(account.provider);
        // One Meta account covers Instagram; the row is stored under the
        // umbrella provider, so expand it rather than asking people to connect
        // something that does not exist as its own account.
        if (account.provider === "meta") set.add("instagram");
      }
      if (account.category === "calendar" && account.provider === "google") set.add("youtube");
    }
    return set;
  }, [accounts]);

  const availableAccountsFor = useCallback(
    (item: Pick<ContentItem, "platform" | "project_id">) =>
      socialAccountsFor(accounts, targetOf(item.platform), item.project_id),
    [accounts],
  );

  const hasPublishingAccount = useCallback(
    (item: Pick<ContentItem, "platform" | "project_id" | "connection_id">) => {
      const available = availableAccountsFor(item);
      return (
        available.length > 0 &&
        ((Boolean(item.project_id) && !item.connection_id) ||
          (available.length === 1 && !item.connection_id) ||
          available.some(
            (account) => socialAccountConnectionId(account) === item.connection_id,
          ))
      );
    },
    [availableAccountsFor],
  );

  const rows = items ?? [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((item) => {
      if (projectFilter && item.project_id !== projectFilter) return false;
      if (!needle) return true;
      const owner = agents.find((agent) => agent.id === item.agent_id)?.name ?? "";
      return `${item.title} ${item.campaign} ${item.brief} ${item.copy} ${targetOf(item.platform).label} ${owner}`
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, projectFilter, query, agents]);

  const stored = draft ? rows.find((row) => row.id === draft.id) : undefined;

  /** Both lists at once, so the board and the open piece can never disagree. */
  const applyLocal = useCallback((id: string, patch: ContentPatch) => {
    setItems((current) =>
      (current ?? []).map((row) => (row.id === id ? { ...row, ...patch } : row))
    );
    setDraft((current) => (current && current.id === id ? { ...current, ...patch } : current));
  }, []);

  const leaveDirty = useCallback(async () => {
    if (!dirty || !draft) return true;
    return confirmAction({
      title: "Leave without saving?",
      body: `“${draft.title || "Untitled"}” has changes that are not written yet.`,
      confirmLabel: "Discard changes",
      danger: true,
    });
  }, [dirty, draft]);

  const openItem = useCallback(
    async (item: ContentItem) => {
      if (item.id !== selectedId && !(await leaveDirty())) return;
      editSeq.current += 1;
      setSelectedId(item.id);
      setDraft({ ...item });
      setDirty(false);
      setSaveFailed(false);
      setSavedAt(0);
    },
    [leaveDirty, selectedId]
  );

  const closeItem = useCallback(async () => {
    if (!(await leaveDirty())) return;
    editSeq.current += 1;
    setSelectedId("");
    setDraft(null);
    setDirty(false);
    setSaveFailed(false);
    setSavedAt(0);
  }, [leaveDirty]);

  function patchDraft(next: ContentPatch) {
    editSeq.current += 1;
    setDraft((current) => (current ? { ...current, ...next } : current));
    setDirty(true);
    setSaveFailed(false);
  }

  /**
   * Write the open piece. `override` exists so an action can save *and* change
   * something in the same breath — marking a piece published is one write, not
   * a save followed by a patch that could half-land.
   */
  async function saveDraft(override: ContentPatch = {}): Promise<ContentItem | null> {
    if (!draft || saving) return null;
    const seq = editSeq.current;
    const next: ContentItem = { ...draft, ...override };
    next.title = next.title.trim() || "Untitled";
    const base = rows.find((row) => row.id === next.id);
    const patch = base ? contentDiff(base, next) : {};
    if (!Object.keys(patch).length) {
      setDirty(false);
      return next;
    }
    setSaving(true);
    try {
      await patchContentItem(next.id, patch);
      const saved: ContentItem = { ...next, updated_at: Date.now() };
      setItems((current) =>
        (current ?? []).map((row) => (row.id === saved.id ? saved : row))
      );
      // Only the parts we just wrote go back into the draft. Replacing it
      // wholesale would undo anything typed while the write was in flight.
      setDraft((current) =>
        current && current.id === saved.id
          ? {
              ...current,
              ...override,
              title: seq === editSeq.current ? saved.title : current.title,
              updated_at: saved.updated_at,
            }
          : current
      );
      setSaveFailed(false);
      if (seq === editSeq.current) {
        setDirty(false);
        setSavedAt(Date.now());
      }
      return saved;
    } catch (reason) {
      setSaveFailed(true);
      toast.error("Could not save this piece", reason);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function moveItem(item: ContentItem, status: ContentItem["status"]) {
    if (status === item.status) return;
    applyLocal(item.id, { status });
    try {
      await patchContentItem(item.id, { status });
    } catch (reason) {
      applyLocal(item.id, { status: item.status });
      toast.error("Could not move that", reason);
    }
  }

  async function create(status: ContentItem["status"]) {
    if (!(await leaveDirty())) return;
    try {
      const created = await createContentItem({
        project_id: projectFilter || projects[0]?.id || "",
        campaign: "",
        title: "",
        brief: "",
        copy: "",
        platform: CONTENT_TARGETS[0].id,
        connection_id: "",
        status,
        scheduled_at: 0,
        agent_id: "",
        media_url: "",
      });
      setItems((current) => [created, ...(current ?? [])]);
      editSeq.current += 1;
      setSelectedId(created.id);
      setDraft({ ...created });
      setDirty(false);
      setSaveFailed(false);
      setSavedAt(0);
      window.requestAnimationFrame(() => titleRef.current?.focus());
    } catch (reason) {
      toast.error("Could not start that", reason);
    }
  }

  /** Save first, then hand the *saved* row to the network. Publishing what is
   *  on screen while the row still says something else is how drafts go out. */
  async function publish() {
    if (!draft) return;
    const item = await saveDraft();
    if (!item) return;
    setPublishingId(item.id);
    try {
      const result = await publishContentItem(item);
      applyLocal(item.id, {
        status: result.state === "published" ? "published" : "scheduled",
        published_url: result.url || `${item.platform}:${result.externalId}`,
        publish_error: "",
      });
      toast.success(
        result.state === "published"
          ? `${targetOf(item.platform).label} published it`
          : `${targetOf(item.platform).label} accepted it and is processing`
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      applyLocal(item.id, { publish_error: message });
      toast.error("Publishing failed", message);
    } finally {
      setPublishingId("");
    }
  }

  async function clearError() {
    if (!draft) return;
    applyLocal(draft.id, { publish_error: "" });
    await patchContentItem(draft.id, { publish_error: "" }).catch(() => {});
  }

  async function remove() {
    if (!draft) return;
    const ok = await confirmAction({
      title: `Delete “${draft.title || "Untitled"}”?`,
      body: "The brief, the copy and the publish history go with it.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteContentItem(draft.id);
      setItems((current) => (current ?? []).filter((row) => row.id !== draft.id));
      editSeq.current += 1;
      setSelectedId("");
      setDraft(null);
      setDirty(false);
    } catch (reason) {
      toast.error("Could not delete that", reason);
    }
  }

  async function copyOut(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch (reason) {
      toast.error(`Could not copy the ${label.toLowerCase()}`, reason);
    }
  }

  /** ⌘S saves, ⌘F/⌘K reach the search box, Escape puts the open piece away. */
  function onPaneKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const accel = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (accel && key === "s") {
      event.preventDefault();
      void saveDraft();
      return;
    }
    if (accel && (key === "f" || key === "k")) {
      // ⌘K is the palette everywhere else, so it is borrowed rather than
      // taken: a second press, with the caret already here, falls through.
      if (key === "k" && document.activeElement === searchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (event.key === "Escape" && draft && !briefing) {
      event.preventDefault();
      void closeItem();
    }
  }

  /**
   * The board answers to the arrow keys the way it looks: up and down walk a
   * column, left and right cross to the next one that has anything in it,
   * Enter opens, and Alt with left or right moves the card itself a stage.
   */
  function onBoardKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-card]");
    if (!card) return;
    const item = rows.find((row) => row.id === card.dataset.card);
    if (!item) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openItem(item);
      return;
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const at = CONTENT_STATUSES.indexOf(item.status);
      const next = CONTENT_STATUSES[at + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      refocus.current = item.id;
      void moveItem(item, next);
      return;
    }
    if (!BOARD_KEYS.has(event.key)) return;
    event.preventDefault();

    const cardsIn = (status: string) =>
      Array.from(
        boardRef.current?.querySelectorAll<HTMLElement>(`[data-card][data-stage="${status}"]`) ?? []
      );
    const column = cardsIn(item.status);
    const index = column.indexOf(card);
    if (event.key === "ArrowDown") return void column[index + 1]?.focus();
    if (event.key === "ArrowUp") return void column[index - 1]?.focus();
    if (event.key === "Home") return void column[0]?.focus();
    if (event.key === "End") return void column[column.length - 1]?.focus();

    const step = event.key === "ArrowRight" ? 1 : -1;
    for (
      let at = CONTENT_STATUSES.indexOf(item.status) + step;
      at >= 0 && at < CONTENT_STATUSES.length;
      at += step
    ) {
      const neighbours = cardsIn(CONTENT_STATUSES[at]);
      if (neighbours.length) {
        neighbours[Math.min(index, neighbours.length - 1)].focus();
        return;
      }
    }
  }

  const target = draft ? targetOf(draft.platform) : null;

  return (
    <Pane
      title={<><IconMegaphone size={19} /> Content Studio</>}
      subtitle="Idea to published, with the agent that owns each piece named on it."
      actions={
        <div className="ops-header-right">
          <select
            className="ops-filter inline"
            aria-label="Filter Content Studio by project"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button className="btn" onClick={() => setView({ type: "settings" })}>Accounts</button>
          <button className="btn primary" onClick={() => void create("idea")}>
            <IconPlus size={14} /> New piece
          </button>
        </div>
      }
      scroll={false}
      max={false}
      pad={false}
      className="ops"
      onKeyDown={onPaneKeyDown}
    >
      {/* Which networks can actually be published to, said once and up front,
          rather than discovered one card at a time. */}
      <div className="content-strip">
        <div className="ops-search content-search">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            aria-label="Search content"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
          />
          {query ? (
            <button
              className="ops-search-clear"
              aria-label="Clear the search"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              ✕
            </button>
          ) : (
            <kbd className="ops-search-key" aria-hidden="true">⌘K</kbd>
          )}
        </div>
        <div className="social-provider-strip" aria-label="Publishing accounts">
          {CONTENT_TARGETS.filter((option) => option.provider).map((option) => {
            const on = connectedProviders.has(option.id);
            return (
              <button
                key={option.id}
                className={"provider-state" + (on && option.publishable ? " connected" : "")}
                title={
                  !option.publishable
                    ? `${option.label} has no publishing path here yet — plan it here, post it there`
                    : on
                      ? `${option.label} publishes from here${throughAccount(option)}`
                      : `${option.label} needs a connected ${option.account} account. Opens Settings.`
                }
                onClick={() => setView({ type: "settings" })}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {/* Shown while a card actually has focus, not as permanent furniture:
            a hint strip that is always there costs its height forever and is
            read once. */}
        {boardFocused && (
          <p className="board-hint" role="status">
            <kbd>Alt</kbd> + <kbd>←</kbd>/<kbd>→</kbd> moves a stage · <kbd>Enter</kbd> opens ·{" "}
            <kbd>Esc</kbd> puts it away
          </p>
        )}
      </div>

      <div className={"content-shell" + (draft ? " open" : "")}>
        <div
          className="content-board"
          ref={boardRef}
          onKeyDown={onBoardKeyDown}
          onFocusCapture={() => setBoardFocused(true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setBoardFocused(false);
          }}
        >
          {CONTENT_STAGES.map((stage) => {
            const cards = visible.filter((item) => item.status === stage.id);
            return (
              <section
                className={"content-column" + (dropTarget === stage.id ? " over" : "")}
                key={stage.id}
                aria-label={`${stage.label}, ${plural(cards.length, "piece")}`}
                onDragOver={(event: ReactDragEvent<HTMLElement>) => {
                  if (dragging) event.preventDefault();
                }}
                onDragEnter={() => {
                  if (dragging) setDropTarget(stage.id);
                }}
                onDragLeave={(event: ReactDragEvent<HTMLElement>) => {
                  // dragleave also fires crossing into a child, so only a
                  // departure that actually leaves the column counts.
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDropTarget((current) => (current === stage.id ? "" : current));
                  }
                }}
                onDrop={(event: ReactDragEvent<HTMLElement>) => {
                  event.preventDefault();
                  const id = dragging || event.dataTransfer.getData("text/plain");
                  const item = rows.find((row) => row.id === id);
                  setDragging("");
                  setDropTarget("");
                  if (item) void moveItem(item, stage.id);
                }}
              >
                <header>
                  <strong>{stage.label}</strong>
                  <span className="content-column-count num" key={cards.length}>
                    {cards.length}
                  </span>
                </header>
                <div
                  className="content-column-body"
                  // Only a list once it has list items in it: a loading skeleton
                  // or an empty-state paragraph inside role="list" is a lie to a
                  // screen reader.
                  role={items && cards.length ? "list" : undefined}
                >
                  {!items && <OpsSkeleton rows={2} label={`Loading ${stage.label}…`} />}
                  {items &&
                    cards.map((item) => (
                      <ContentCard
                        key={item.id}
                        item={item}
                        owner={item.agent_id ? agentIdentity(item.agent_id) : null}
                        connected={hasPublishingAccount(item)}
                        selected={item.id === selectedId}
                        dragging={dragging === item.id}
                        onOpen={() => void openItem(item)}
                        onDragStart={(event) => {
                          // Firefox refuses to start a drag with an empty
                          // payload, and the id is all the drop needs anyway.
                          event.dataTransfer.setData("text/plain", item.id);
                          event.dataTransfer.effectAllowed = "move";
                          setDragging(item.id);
                        }}
                        onDragEnd={() => {
                          setDragging("");
                          setDropTarget("");
                        }}
                      />
                    ))}
                  {items && !cards.length && (
                    <div className="column-empty">
                      <p>{query.trim() ? "Nothing here matches your search." : stage.empty}</p>
                      {!query.trim() && (
                        <button className="btn subtle" onClick={() => void create(stage.id)}>
                          <IconPlus size={12} /> {stage.cta}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {draft && target && (
          <ContentDetail
            draft={draft}
            stored={stored}
            target={target}
            connected={hasPublishingAccount(draft)}
            accounts={availableAccountsFor(draft)}
            dirty={dirty}
            saving={saving}
            savedAt={savedAt}
            saveFailed={saveFailed}
            publishing={publishingId === draft.id}
            titleRef={titleRef}
            onPatch={patchDraft}
            onSave={() => void saveDraft()}
            onPublish={() => void publish()}
            onMarkPublished={() => void saveDraft({ status: "published", publish_error: "" })}
            onClearError={() => void clearError()}
            onBrief={() => setBriefing(draft)}
            onDelete={() => void remove()}
            onClose={() => void closeItem()}
            onSettings={() => setView({ type: "settings" })}
            onCopy={(label, text) => void copyOut(label, text)}
            onOpenProject={() => {
              const project = projects.find((row) => row.id === draft.project_id);
              if (!project) return;
              const channel = useStore
                .getState()
                .channels.find((row) => row.project_id === project.id);
              setView(
                channel
                  ? { type: "channel", channelId: channel.id }
                  : { type: "workspace", projectId: project.id }
              );
            }}
          />
        )}
      </div>

      {briefing && (
        <AgentDispatch
          title={`Brief an agent on “${briefing.title || "Untitled"}”`}
          meta={`Content Studio · ${targetOf(briefing.platform).label}`}
          projectId={briefing.project_id}
          onClose={() => setBriefing(null)}
          onDispatched={async (agentId) => {
            await patchContentItem(briefing.id, { status: "drafting", agent_id: agentId });
            applyLocal(briefing.id, { status: "drafting", agent_id: agentId });
          }}
          included={[
            `The title, the target (${targetOf(briefing.platform).label}) and the campaign${briefing.campaign ? ` (${briefing.campaign})` : ""}.`,
            targetOf(briefing.platform).limit
              ? `The limit that target imposes — ${targetOf(briefing.platform).limit} characters.`
              : "No character limit on that target.",
            briefing.brief ? "The creative brief in full." : "No brief has been written yet.",
            briefing.copy ? "The draft copy as it stands." : "No copy written yet.",
            briefing.media_url ? "The media URL." : "No media attached.",
          ]}
          context={[
            `**${briefing.title || "Untitled"}**`,
            `Target: ${targetOf(briefing.platform).label}`,
            targetOf(briefing.platform).limit
              ? `Limit: ${targetOf(briefing.platform).limit} characters`
              : "",
            targetOf(briefing.platform).media
              ? `Also needs: ${mediaNeed(targetOf(briefing.platform))}`
              : "",
            briefing.campaign ? `Campaign: ${briefing.campaign}` : "",
            briefing.scheduled_at
              ? `Goes out: ${longLocalTime(briefing.scheduled_at)} (${LOCAL_ZONE})`
              : "",
            briefing.brief ? `\nBrief:\n${briefing.brief}` : "",
            briefing.copy ? `\nCurrent copy:\n${briefing.copy}` : "",
            briefing.media_url ? `\nMedia: ${briefing.media_url}` : "",
          ]
            .filter(Boolean)
            .join("\n")}
          presets={[
            {
              id: "draft",
              label: "Draft it",
              instruction: "develop this into finished copy and post it here for review.",
            },
            {
              id: "variants",
              label: "Give me options",
              instruction:
                "write three different versions of this, and say what each one is betting on.",
            },
            {
              id: "critique",
              label: "Critique it",
              instruction: "tell me what is weak about this piece and what you would change.",
            },
          ]}
        />
      )}
    </Pane>
  );
}

/**
 * A card is a *state*, not a control panel.
 *
 * Where it is going, when, whose it is, and whether the last attempt failed —
 * that is the whole job. Everything you can *do* to a piece lives in the panel
 * beside the board, which is why this has no button row: five columns of cards
 * each carrying six tiny buttons is how a board stops being scannable.
 */
function ContentCard({
  item,
  owner,
  connected,
  selected,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  item: ContentItem;
  owner: { name: string; tag: string } | null;
  connected: boolean;
  selected: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const target = targetOf(item.platform);
  const late = item.status === "scheduled" && item.scheduled_at > 0 && item.scheduled_at < Date.now();

  return (
    <article
      className={"content-card" + (selected ? " on" : "") + (dragging ? " dragging" : "")}
      role="listitem"
      tabIndex={0}
      draggable
      data-card={item.id}
      data-stage={item.status}
      aria-current={selected ? "true" : undefined}
      aria-label={`${item.title || "Untitled"}, ${stageOf(item.status).label}, targeting ${target.label}`}
      onClick={onOpen}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="content-card-top">
        <span className={"platform-badge" + (connected && target.publishable ? " connected" : "")}>
          {target.label}
        </span>
        {item.campaign && <span className="content-campaign">{item.campaign}</span>}
        {item.scheduled_at > 0 && (
          <time className="content-when num" dateTime={new Date(item.scheduled_at).toISOString()}>
            {late ? "overdue" : shortDateTime(item.scheduled_at)}
          </time>
        )}
      </div>
      <h3>{item.title || "Untitled"}</h3>
      <p>{item.copy || item.brief || "Nothing written yet."}</p>
      <MediaPreview url={item.media_url} />

      {item.publish_error && (
        <p className="content-card-flag error">{target.label} refused it — open to see why</p>
      )}
      {item.published_url && !item.publish_error && (
        <p className="content-card-flag live">{item.published_url}</p>
      )}

      <div className="content-card-foot">
        {owner?.name ? (
          <span className="content-owner">
            <IconAgents size={12} /> {owner.name}
            {owner.tag && <span className="owner-tag">{owner.tag}</span>}
          </span>
        ) : (
          <span className="content-owner unowned">Nobody owns this</span>
        )}
      </div>
    </article>
  );
}

/**
 * One piece, open. Everything that can be done to it is here and nowhere else.
 *
 * The order is the order of the questions somebody actually has: where is this
 * going, what does it say, what does it carry, when does it go, who owns it,
 * and can it go at all. The last section is the only one allowed to be loud,
 * because it is the only one that talks to somebody else's server.
 */
function ContentDetail({
  draft,
  stored,
  target,
  connected,
  accounts,
  dirty,
  saving,
  savedAt,
  saveFailed,
  publishing,
  titleRef,
  onPatch,
  onSave,
  onPublish,
  onMarkPublished,
  onClearError,
  onBrief,
  onDelete,
  onClose,
  onSettings,
  onCopy,
  onOpenProject,
}: {
  draft: ContentItem;
  stored: ContentItem | undefined;
  target: ContentTarget;
  connected: boolean;
  accounts: IntegrationAccount[];
  dirty: boolean;
  saving: boolean;
  savedAt: number;
  saveFailed: boolean;
  publishing: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  onPatch: (patch: ContentPatch) => void;
  onSave: () => void;
  onPublish: () => void;
  onMarkPublished: () => void;
  onClearError: () => void;
  onBrief: () => void;
  onDelete: () => void;
  onClose: () => void;
  onSettings: () => void;
  onCopy: (label: string, text: string) => void;
  onOpenProject: () => void;
}) {
  const projects = useStore((state) => state.projects);
  const agents = useStore((state) => state.agents);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const owner = draft.agent_id ? agentIdentity(draft.agent_id) : null;
  const project = projects.find((row) => row.id === draft.project_id);
  const selectedAccount = accounts.find(
    (account) => socialAccountConnectionId(account) === draft.connection_id,
  );
  const needsAccountChoice =
    !draft.project_id && accounts.length > 1 && !draft.connection_id;

  const copy = draft.copy.trim();
  const remaining = target.limit ? target.limit - copy.length : 0;
  const blockers = publishBlockers(draft, target);
  const canPublish = target.publishable && connected && !blockers.length;
  const scheduled = draft.scheduled_at > 0;
  const past = scheduled && draft.scheduled_at < Date.now();

  async function chooseMedia() {
    const wantsVideo = target.media === "video";
    const wantsImage = target.media === "image";
    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: wantsVideo ? "Video" : wantsImage ? "Image" : "Image or video",
          extensions: wantsVideo
            ? ["mp4", "mov", "m4v", "webm"]
            : wantsImage
              ? ["png", "jpg", "jpeg", "webp", "gif", "avif"]
              : [
                  "png",
                  "jpg",
                  "jpeg",
                  "webp",
                  "gif",
                  "avif",
                  "mp4",
                  "mov",
                  "m4v",
                  "webm",
                ],
        },
      ],
    });
    if (typeof chosen !== "string") return;
    setUploadingMedia(true);
    try {
      const mediaUrl = await uploadContentMedia(
        chosen,
        draft.project_id,
        "",
        draft.platform === "instagram",
      );
      onPatch({
        media_url: mediaUrl,
        media_items: JSON.stringify([{ url: mediaUrl, role: "post" }]),
      });
      toast.success("Media uploaded to this workspace");
    } catch (reason) {
      toast.error("Could not upload that media", reason);
    } finally {
      setUploadingMedia(false);
    }
  }

  const saveState: SaveState = saveFailed
    ? "error"
    : saving
      ? "saving"
      : dirty
        ? "dirty"
        : "saved";
  const saveLabel =
    saveState === "error"
      ? "Not saved"
      : saveState === "saving"
        ? "Saving…"
        : saveState === "dirty"
          ? "Unsaved changes"
          : savedAt
            ? `Saved ${clockTime(savedAt)}`
            : `Edited ${shortDate(stored?.updated_at ?? draft.updated_at)}`;

  return (
    <aside className="content-detail" aria-label="The open piece">
      <header className="content-detail-head">
        <div className="content-detail-top">
          <span className={"platform-badge" + (connected && target.publishable ? " connected" : "")}>
            {target.label}
          </span>
          <span className="content-detail-stage">{stageOf(draft.status).label}</span>
          <button className="icon-btn" aria-label="Close this piece" onClick={onClose}>✕</button>
        </div>
        <input
          ref={titleRef}
          className="content-title"
          aria-label="Title"
          value={draft.title}
          placeholder="Untitled"
          onChange={(event) => onPatch({ title: event.target.value })}
        />
        <div className="content-detail-save">
          <span className={"doc-save " + saveState} role="status" key={saveState}>
            <span className="doc-save-dot" aria-hidden="true" />
            {saveLabel}
          </span>
          <button
            className="btn primary"
            disabled={!dirty || saving}
            title="Save (⌘S)"
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className="content-detail-body">
        <section className="content-block">
          <span className="field-label">Where it goes</span>
          <div className="form-row">
            <Field label="Target">
              <select
                value={draft.platform}
                onChange={(event) =>
                  onPatch({ platform: event.target.value, connection_id: "" })
                }
              >
                {CONTENT_TARGETS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Stage">
              <select
                value={draft.status}
                onChange={(event) =>
                  onPatch({ status: event.target.value as ContentItem["status"] })
                }
              >
                {CONTENT_STAGES.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <p className="target-state">
            {!target.provider ? (
              <>Planning only — pick a single target when you know where this goes.</>
            ) : !target.publishable ? (
              <>
                {target.label} has no publishing path here yet. Plan and schedule it here, post it
                there, then paste the link back.
              </>
            ) : needsAccountChoice ? (
              <>
                Choose which {target.account} account should publish this
                workspace-wide piece.
              </>
            ) : connected ? (
              <>
                {target.label} publishes from{" "}
                {selectedAccount
                  ? selectedAccount.handle || selectedAccount.label
                  : project
                    ? `${project.name}'s default ${target.account} account`
                    : `the default ${target.account} account`}
                {target.limit ? `, and counts to ${target.limit} characters` : ""}.
              </>
            ) : (
              <>
                {target.account === target.label
                  ? `${target.label} is not connected.`
                  : `${target.label} publishes through a ${target.account} account, and there is no connected one.`}{" "}
                Connect it in Settings, or post this by hand below.
              </>
            )}
          </p>
          <div className="form-row">
            <Field label="Campaign">
              <input
                value={draft.campaign}
                placeholder="Launch, weekly series…"
                onChange={(event) => onPatch({ campaign: event.target.value })}
              />
            </Field>
            <Field label="Project">
              <select
                value={draft.project_id}
                onChange={(event) =>
                  onPatch({ project_id: event.target.value, connection_id: "" })
                }
              >
                <option value="">Workspace-wide</option>
                {projects.map((row) => (
                  <option key={row.id} value={row.id}>{row.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {target.publishable && target.provider && (
            <Field label="Publishing account">
              <select
                value={draft.connection_id}
                disabled={!accounts.length}
                onChange={(event) => onPatch({ connection_id: event.target.value })}
              >
                <option value="">
                  {accounts.length
                    ? needsAccountChoice
                      ? "Choose an account"
                      : project
                      ? `${project.name} default`
                      : "Workspace default"
                    : project
                      ? `No ${target.account} account linked to ${project.name}`
                      : `No ${target.account} account connected`}
                </option>
                {accounts.map((account) => {
                  const metadata = socialAccountMetadata(account);
                  const isDefault =
                    metadata.projectLinks?.some(
                      (link) =>
                        link.projectId === draft.project_id && link.isDefault,
                    ) ?? false;
                  return (
                    <option
                      key={account.id}
                      value={socialAccountConnectionId(account)}
                    >
                      {account.handle || account.label}
                      {isDefault ? " · default" : ""}
                    </option>
                  );
                })}
              </select>
            </Field>
          )}
          {project && (
            <button className="content-project-link" onClick={onOpenProject}>
              ↗ Open {project.name}
            </button>
          )}
        </section>

        <section className="content-block">
          <span className="field-label">The brief</span>
          <textarea
            className="content-brief"
            aria-label="Creative brief"
            rows={3}
            value={draft.brief}
            placeholder="What this piece has to do, and for whom."
            onChange={(event) => onPatch({ brief: event.target.value })}
          />
        </section>

        <section className="content-block">
          <span className="field-label">The copy</span>
          <textarea
            className="content-copy"
            aria-label="The copy, as it will be posted"
            rows={10}
            value={draft.copy}
            placeholder="The words that go out, exactly as they go out."
            onChange={(event) => onPatch({ copy: event.target.value })}
          />
          <p className="content-count num">
            {plural(copy.length, "character")} · {plural(wordCount(draft.copy), "word")}
            {target.limit ? (
              <>
                {" · "}
                <span className={remaining < 0 ? "over" : undefined}>
                  {remaining < 0
                    ? `${plural(-remaining, "character")} over ${target.label}'s ${target.limit}`
                    : `${remaining} left of ${target.limit}`}
                </span>
              </>
            ) : null}
          </p>
        </section>

        <section className="content-block">
          <span className="field-label">Media</span>
          <div className="content-media-entry">
            <input
              aria-label="Media URL"
              value={draft.media_url}
              placeholder="Upload a file or paste an HTTPS URL"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                const url = event.target.value;
                onPatch({
                  media_url: url,
                  media_items: url
                    ? JSON.stringify([{ url, role: "post" }])
                    : "[]",
                });
              }}
            />
            <button
              className="btn subtle"
              disabled={uploadingMedia}
              onClick={() => void chooseMedia()}
            >
              {uploadingMedia ? "Uploading…" : "Choose file"}
            </button>
          </div>
          {draft.media_url.trim() ? (
            <div className="content-media-check">
              <MediaPreview url={draft.media_url.trim()} />
            </div>
          ) : (
            <p className="content-note">
              {target.media
                ? `Spaces uploads the file and gives ${target.label} a URL it can fetch.`
                : "Optional. Upload a local file or paste a URL the network can reach."}
            </p>
          )}
          {contentMedia(draft).length > 1 && (
            <div className="content-media-set">
              {contentMedia(draft).slice(1).map((media) => (
                <div key={`${media.role}:${media.url}`}>
                  <span>{media.role}</span>
                  <MediaPreview url={media.url} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="content-block">
          <span className="field-label">When it goes out</span>
          <input
            type="datetime-local"
            aria-label="Scheduled time"
            value={scheduled ? inputDateTime(draft.scheduled_at) : ""}
            onChange={(event) =>
              onPatch({
                scheduled_at: event.target.value ? new Date(event.target.value).getTime() : 0,
              })
            }
          />
          <p className={"content-note" + (past ? " warn" : "")}>
            {!scheduled ? (
              <>No time set. A piece in Scheduled without one is a piece nobody is expecting.</>
            ) : past ? (
              <>
                {longLocalTime(draft.scheduled_at)} — {relativeWhen(draft.scheduled_at)}. That time
                has already passed.
              </>
            ) : (
              <>
                Goes out {longLocalTime(draft.scheduled_at)} — {relativeWhen(draft.scheduled_at)},
                in your own zone ({LOCAL_ZONE}).
              </>
            )}
          </p>
          <div className="content-quick">
            <button
              className="card-act"
              onClick={() => onPatch({ scheduled_at: Date.now() + 3_600_000 })}
            >
              In an hour
            </button>
            <button
              className="card-act"
              onClick={() => {
                const when = new Date();
                when.setDate(when.getDate() + 1);
                when.setHours(9, 0, 0, 0);
                onPatch({ scheduled_at: when.getTime() });
              }}
            >
              Tomorrow, 9am
            </button>
            {scheduled && (
              <button className="card-act" onClick={() => onPatch({ scheduled_at: 0 })}>
                Clear
              </button>
            )}
          </div>
        </section>

        <section className="content-block">
          <span className="field-label">Who owns it</span>
          <select
            aria-label="Owned by"
            value={draft.agent_id}
            onChange={(event) => onPatch({ agent_id: event.target.value })}
          >
            <option value="">Nobody yet</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agentOptionLabel(agent.id, agent.role)}
              </option>
            ))}
          </select>
          <p className="content-owner-line">
            {owner?.name ? (
              <>
                <IconAgents size={12} /> {owner.name}
                {owner.tag && <span className="owner-tag">{owner.tag}</span>}
              </>
            ) : (
              <span className="content-owner unowned">
                Nobody owns this, so nobody is going to write it.
              </span>
            )}
          </p>
          <button className="btn subtle" onClick={onBrief}>
            <IconAgents size={13} /> Ask an agent to draft this
          </button>
          <p className="content-note">
            It posts into a channel you pick, carrying the brief, the target and its limits. You
            see the exact message, and can edit it, before anything is sent.
          </p>
        </section>

        <section className="content-block">
          <span className="field-label">Publishing</span>

          {draft.publish_error && (
            <div className="content-error">
              <strong>{target.label} refused it</strong>
              <span>{draft.publish_error}</span>
              <div className="content-error-actions">
                <button onClick={onPublish} disabled={publishing}>
                  {publishing ? "Retrying…" : "Try again"}
                </button>
                <button onClick={onClearError}>Dismiss</button>
              </div>
            </div>
          )}

          {draft.published_url && (
            <a
              className="content-published"
              href={/^https?:\/\//i.test(draft.published_url) ? draft.published_url : undefined}
              target="_blank"
              rel="noreferrer"
            >
              {draft.published_url}
            </a>
          )}

          {/* The state, in one sentence, exactly where the button is. Naming
              the account rather than the network matters: "Instagram is not
              connected" sends somebody looking for a row that does not exist. */}
          <p className="content-note">
            {!target.provider
              ? "No single target yet, so there is nothing to publish to. Pick one above, or take it by hand."
              : !target.publishable
                ? `${target.label} has no publishing path here. The route below is the route.`
                : !connected
                  ? `${target.account} is not connected, so nothing can leave from here.`
                  : blockers.length
                    ? "Not ready to go out yet:"
                    : `Ready. This goes to ${target.label}${throughAccount(target)}.`}
          </p>

          {target.publishable && connected && !!blockers.length && (
            <ul className="content-blockers">
              {blockers.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}

          <div className="content-publish-actions">
            {canPublish && (
              <button className="btn primary" disabled={publishing} onClick={onPublish}>
                {publishing ? "Publishing…" : dirty ? "Save and publish now" : "Publish now"}
              </button>
            )}
            {target.publishable && !connected && (
              <button className="btn" onClick={onSettings}>
                Connect {target.account} in Settings
              </button>
            )}
          </div>
          {canPublish && scheduled && (
            <p className="content-note">
              Publishing sends it immediately — the {shortDateTime(draft.scheduled_at)} slot is a
              plan, not a timer.
            </p>
          )}

          {/* The manual route, always present. It is the only honest answer for
              a network with no publishing path, and it is still the fastest one
              for a network that has one but is not signed in. */}
          <div className="content-byhand">
            <span className="field-label">Post it by hand</span>
            <p className="content-note">
              Take the copy, post it in {target.label}, then paste the link back so the pipeline
              stays true.
            </p>
            <div className="content-quick">
              <button
                className="card-act"
                disabled={!copy}
                onClick={() => onCopy("Copy", draft.copy)}
              >
                Copy the text
              </button>
              {draft.media_url.trim() && (
                <button
                  className="card-act"
                  onClick={() => onCopy("Media URL", draft.media_url.trim())}
                >
                  Copy the media URL
                </button>
              )}
            </div>
            <input
              aria-label="Live link"
              value={draft.published_url}
              placeholder="https://… the link it went live at"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => onPatch({ published_url: event.target.value })}
            />
            <button
              className="btn"
              disabled={saving || draft.status === "published"}
              onClick={onMarkPublished}
            >
              {draft.status === "published" ? "Already published" : "Mark as published"}
            </button>
          </div>
        </section>

        <section className="content-block">
          <button className="btn danger subtle" onClick={onDelete}>Delete this piece</button>
        </section>
      </div>
    </aside>
  );
}
