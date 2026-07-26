/**
 * The universal palette (⌘K / Ctrl+K).
 *
 * One list over everything Spaces knows: entities from the registry and commands
 * from a local registry that mirrors what the sidebar, the settings pane and
 * the composer can already do. The premise is that a person types the *name of
 * the thing*, not the name of the screen it lives on — so a project, a task, a
 * theme and "New channel…" all compete in the same ranked list, and the mode
 * prefixes (`>` `#` `@` `?`) exist only for when you already know which kind
 * you meant.
 *
 * Performance shapes most of the structure here. A workspace can hold
 * thousands of messages, so:
 *   - the index is built once per *open*, never per keystroke;
 *   - messages are indexed straight off the store rather than through
 *     describeEntity, whose message branch flattens and scans every message
 *     per call — indexing n messages that way is O(n²);
 *   - the component never subscribes to `messages`, so a streaming agent reply
 *     cannot re-render the palette a hundred times a second;
 *   - the query is debounced and both the per-group and total result counts
 *     are capped, so the list stays a list rather than a database dump.
 */
import "./palette.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import { useTheme } from "../themeStore";
import { THEMES } from "../themes";
import { describeEntity, searchEntities, KIND_BY_TYPE } from "../entities";
import { SPACES_COMMANDS, availableCommands, runCommand } from "../commands";
import type { SlashCommand } from "../commands";
import { triggerAgents, userTrigger } from "../agents";
import { uid } from "../db";
import { toast } from "../toast";
import { refKey, slug } from "../types";
import type { EntityRef, EntityType, Message, View } from "../types";

/* ── fuzzy matching ───────────────────────────────────────────── */

interface Match {
  score: number;
  /** Indices into the target string, for highlighting. */
  hits: number[];
}

/**
 * How many first-character occurrences to try before settling. A single greedy
 * pass matches "chv" against "ChatView" by consuming the `c` of the first word
 * and then wandering; restarting at each `c` finds the run a reader would see.
 * Six starts is enough for real titles and keeps the loop bounded.
 */
const MAX_STARTS = 6;

function scanFrom(q: string, lower: string, raw: string, start: number): Match | null {
  const hits: number[] = [];
  let score = 0;
  let prev = -2;
  let pos = start;
  for (let i = 0; i < q.length; i++) {
    const idx = i === 0 ? start : lower.indexOf(q[i], pos);
    if (idx === -1) return null;
    if (idx === 0) score += 12; // the very beginning
    else if (idx === prev + 1) score += 7; // consecutive run
    else if (!/[a-z0-9]/.test(lower[idx - 1])) score += 5; // after a separator
    else if (raw[idx] !== lower[idx] && raw[idx - 1] === lower[idx - 1]) score += 5; // camelCase hump
    else score += 1;
    if (prev >= 0 && idx > prev + 1) score -= Math.min(6, (idx - prev - 1) * 0.6);
    hits.push(idx);
    prev = idx;
    pos = idx + 1;
  }
  // A shorter target is more likely to be the thing you meant.
  return { score: score - lower.length * 0.04, hits };
}

/** Case-insensitive subsequence match, or null when `query` isn't one. */
function fuzzy(query: string, target: string): Match | null {
  if (!query) return { score: 0, hits: [] };
  if (!target) return null;
  const q = query.toLowerCase();
  const lower = target.toLowerCase();
  if (q.length > lower.length) return null;
  let best: Match | null = null;
  let at = lower.indexOf(q[0]);
  for (let n = 0; at !== -1 && n < MAX_STARTS; n++, at = lower.indexOf(q[0], at + 1)) {
    const m = scanFrom(q, lower, target, at);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}

/** The matched characters, marked. Anything else renders verbatim. */
function Marked({ text, hits }: { text: string; hits?: number[] }) {
  if (!hits || hits.length === 0) return <>{text}</>;
  const on = new Set(hits);
  const parts: { hit: boolean; s: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = on.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.s += text[i];
    else parts.push({ hit, s: text[i] });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="pal-hit">{p.s}</mark>
        ) : (
          <span key={i}>{p.s}</span>
        )
      )}
    </>
  );
}

/* ── rows ─────────────────────────────────────────────────────── */

interface Swatch {
  bg: string;
  border: string;
  accent: string;
}

interface Row {
  key: string;
  /** Group header this row sits under. */
  section: string;
  title: string;
  subtitle: string;
  /** Right-aligned context, usually the owning project. */
  context: string;
  glyph: string;
  tone: string;
  /** Secondary fuzzy target: aliases, kinds, body text. */
  extra: string;
  /** Theme rows preview themselves; the colors are data, not styling. */
  swatch?: Swatch;
  /** Present for entity rows — what ⌘↵ inspects and what "link this" links. */
  ref?: EntityRef;
  badge?: number;
  /** Rows that open a sub-step keep the palette up. */
  keepOpen?: boolean;
  run: () => void | Promise<void>;
}

/** Display order for groups when nothing is typed. */
const SECTIONS = [
  "Recent",
  "Start here",
  "Go to",
  "Create",
  "This channel",
  "Connect",
  "Appearance",
  "Themes",
  "Channels",
  "Projects",
  "Tasks",
  "Memory",
  "Agents & teams",
  "Messages",
];

const SECTION_RANK = new Map(SECTIONS.map((s, i) => [s, i] as const));

const ENTITY_SECTION: Partial<Record<EntityType, string>> = {
  project: "Projects",
  channel: "Channels",
  task: "Tasks",
  memory: "Memory",
  agent: "Agents & teams",
  team: "Agents & teams",
  message: "Messages",
};

/* ── modes ────────────────────────────────────────────────────── */

type Mode = "all" | "commands" | "channels" | "people" | "help";

const PREFIXES: { prefix: string; mode: Mode; label: string; hint: string }[] = [
  { prefix: ">", mode: "commands", label: "Commands", hint: "actions only" },
  { prefix: "#", mode: "channels", label: "Channels", hint: "jump to a channel" },
  { prefix: "@", mode: "people", label: "Agents & teams", hint: "who does what" },
  { prefix: "?", mode: "help", label: "Shortcuts", hint: "every key Spaces binds" },
];

const PREFIX_BY_MODE = new Map(PREFIXES.map((p) => [p.mode, p] as const));

/* ── limits ───────────────────────────────────────────────────── */

/** Only the newest messages are worth searching; older ones live in the channel. */
const MAX_MESSAGES = 1500;
const MAX_ROWS = 48;
const MAX_PER_SECTION = 6;
/** A narrowed mode is a deliberate browse, so it gets a longer list. */
const MAX_PER_SECTION_FOCUSED = 24;
const MAX_RECENTS = 8;
/** Long enough to swallow a fast typist's burst, short enough to feel live. */
const DEBOUNCE_MS = 70;

/* ── recents ──────────────────────────────────────────────────── */

const RECENTS_STORAGE_ID = "spaces.palette.recents.v1";

function loadRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_STORAGE_ID) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENTS);
  } catch {
    return []; // a corrupt list is not worth a crash, or a word
  }
}

function saveRecents(keys: string[]): void {
  try {
    localStorage.setItem(RECENTS_STORAGE_ID, JSON.stringify(keys.slice(0, MAX_RECENTS)));
  } catch {
    // private mode, quota, or no localStorage at all — recents are a nicety
  }
}

/* ── the keyboard cheat sheet ─────────────────────────────────── */

/**
 * Every binding the app actually registers, read off the handlers rather than
 * imagined. Spaces documents none of these anywhere else, which is the whole
 * reason "?" exists.
 */
const SHORTCUTS: { group: string; rows: { keys: string; what: string }[] }[] = [
  {
    group: "Anywhere",
    rows: [
      { keys: "⌘K  Ctrl K", what: "Open or close this palette" },
      { keys: "Esc", what: "Close the palette, the inspector, or whatever dialog is on top" },
    ],
  },
  {
    group: "This palette",
    rows: [
      { keys: "↑  ↓", what: "Move through results, across group boundaries" },
      { keys: "↵", what: "Run the highlighted result" },
      { keys: "⌘↵", what: "Open it in the inspector instead of navigating" },
      { keys: "Home  End", what: "First / last result" },
      { keys: "PgUp  PgDn", what: "Jump a page at a time" },
      { keys: ">", what: "Commands only" },
      { keys: "#", what: "Channels only" },
      { keys: "@", what: "Agents and teams" },
      { keys: "?", what: "This cheat sheet" },
      { keys: "⌫", what: "At the start of an empty query, drops the mode filter" },
    ],
  },
  {
    group: "Chat",
    rows: [
      { keys: "↵", what: "Send the message" },
      { keys: "⇧↵", what: "New line instead of sending" },
      { keys: "@", what: "Start an @mention; ↵ takes the top suggestion" },
      { keys: "Esc", what: "Dismiss the mention list" },
    ],
  },
  {
    group: "Tasks",
    rows: [{ keys: "↵", what: "Create the task typed into an “Add task” row" }],
  },
  {
    group: "Inspector",
    rows: [
      { keys: "Esc", what: "Close the drawer" },
      { keys: "←  →", what: "Widen / narrow it — hold ⇧ for bigger steps" },
      { keys: "Home  End", what: "Widest / narrowest" },
      { keys: "Double-click", what: "Reset the divider to its default width" },
    ],
  },
  {
    group: "Connections",
    rows: [
      { keys: "↑  ↓  Home  End", what: "Move through the search results" },
      { keys: "↵", what: "Draw the link" },
      { keys: "⌘↵", what: "Draw it and keep the picker open for the next one" },
      { keys: "←  →", what: "Change the relation or the role chip" },
      { keys: "Esc", what: "Close the picker without drawing anything" },
    ],
  },
  {
    group: "Appearance",
    rows: [
      { keys: "←  ↑  →  ↓", what: "Move around the theme grid" },
      { keys: "↵  Space", what: "Apply the focused theme" },
      { keys: "Home  End", what: "First / last theme" },
      { keys: "←  →", what: "Change a segmented control (density, radius, appearance)" },
      { keys: "Esc", what: "Clear the theme search box" },
    ],
  },
  {
    group: "Dialogs",
    rows: [
      { keys: "Tab  ⇧Tab", what: "Cycle the buttons — focus stays inside" },
      { keys: "↵", what: "Confirm" },
      { keys: "Esc", what: "Cancel, which is always the safe answer" },
    ],
  },
  {
    group: "Workspaces",
    rows: [
      { keys: "↵", what: "Confirm the inline name field" },
      { keys: "Esc", what: "Cancel it" },
    ],
  },
];

/* ── sub-steps ────────────────────────────────────────────────── */

interface Prompt {
  key: string;
  title: string;
  placeholder: string;
  help: string;
  /** Shows the project chooser and passes the choice to `submit`. */
  scoped: boolean;
  submit(value: string, projectId: string): Promise<void>;
}

type Stage =
  | { kind: "search" }
  | { kind: "prompt"; prompt: Prompt }
  /** Second half of "link this to…": the same search, a different verb. */
  | { kind: "link"; anchor: EntityRef };

/* ── slash-command discovery cache ────────────────────────────── */

/**
 * `discoverProjectCommands` shells out to git. Once per project path per
 * session is plenty — a command file added mid-session shows up on relaunch,
 * and that is a fair trade for never making ⌘K wait on the filesystem.
 */
const slashCache = new Map<string, SlashCommand[]>();

/* ── component ────────────────────────────────────────────────── */

export function Palette() {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [sel, setSel] = useState(0);
  const [stage, setStage] = useState<Stage>({ kind: "search" });
  const [projectPick, setProjectPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>(SPACES_COMMANDS);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const view = useStore((s) => s.view);
  const inspect = useStore((s) => s.inspect);
  const projects = useStore((s) => s.projects);
  const channels = useStore((s) => s.channels);
  const tasks = useStore((s) => s.tasks);
  const memory = useStore((s) => s.memory);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const unread = useStore((s) => s.unread);
  const setView = useStore((s) => s.setView);
  const setInspect = useStore((s) => s.setInspect);
  const addTask = useStore((s) => s.addTask);
  const addMemory = useStore((s) => s.addMemory);
  const addChannel = useStore((s) => s.addChannel);
  const addProject = useStore((s) => s.addProject);
  const addLink = useStore((s) => s.addLink);
  const removeLink = useStore((s) => s.removeLink);
  const insertMessage = useStore((s) => s.insertMessage);

  const setTheme = useTheme((s) => s.setTheme);
  const toggleAppearance = useTheme((s) => s.toggleAppearance);
  const setFollowSystem = useTheme((s) => s.setFollowSystem);
  const appearance = useTheme((s) => s.theme.appearance);

  const activeChannel = view.type === "channel" ? channels.find((c) => c.id === view.channelId) : undefined;
  const activeProject = projects.find((p) => p.id === activeChannel?.project_id);

  const close = useCallback(() => setOpen(false), []);

  /* ── global shortcut ───────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+K as well as ⌘K: Spaces is a desktop app on three platforms, and the
      // Linux/Windows habit is Ctrl. Alt is excluded so it can't swallow a
      // compose sequence that happens to produce a "k".
      const combo = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k";
      if (!combo) return;
      e.preventDefault();
      if (!e.repeat) setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Every open starts clean: a stale query is more confusing than an empty one.
  useEffect(() => {
    if (!open) return;
    setRaw("");
    setTyped("");
    setMode("all");
    setSel(0);
    setStage({ kind: "search" });
    setBusy(false);
  }, [open]);

  /**
   * A typed prefix is promoted out of the field and into a chip rather than
   * left sitting in the text. It reads as what it is — a filter — and the
   * query underneath stays a plain query, so Backspace has one obvious meaning
   * at the start of the line: drop the filter.
   */
  const onInput = (value: string) => {
    if (mode === "all" && raw === "") {
      const p = PREFIXES.find((x) => value.startsWith(x.prefix));
      if (p) {
        setMode(p.mode);
        setRaw(value.slice(p.prefix.length));
        return;
      }
    }
    setRaw(value);
  };

  // Only the text is debounced; the mode chip has to answer the keystroke that
  // produced it or the prefix system feels broken.
  useEffect(() => {
    const t = window.setTimeout(() => setTyped(raw.trim()), raw ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(t);
  }, [raw]);

  useEffect(() => setSel(0), [typed, mode, stage]);

  /* ── project slash commands ────────────────────────────────── */

  useEffect(() => {
    if (!open || !activeChannel) {
      setSlashCmds(SPACES_COMMANDS);
      return;
    }
    const path = activeProject?.local_path ?? "";
    const cached = slashCache.get(path);
    if (cached) {
      setSlashCmds(cached);
      return;
    }
    let alive = true;
    void availableCommands(path).then((cs) => {
      slashCache.set(path, cs);
      if (alive) setSlashCmds(cs);
    });
    return () => {
      alive = false;
    };
  }, [open, activeChannel, activeProject?.local_path]);

  /* ── the entity index ──────────────────────────────────────── */

  const messageCache = useRef<{ count: number; rows: Row[] }>({ count: -1, rows: [] });

  const entityRows = useMemo<Row[]>(() => {
    if (!open) return [];
    const s = useStore.getState();
    const projectName = new Map(s.projects.map((p) => [p.id, p.name] as const));

    // One searchEntities pass describes everything except messages. Passing an
    // empty query makes it a plain enumeration, so describeEntity runs exactly
    // once per entity per open rather than once per entity per keystroke.
    const out: Row[] = searchEntities("", {
      types: ["project", "channel", "task", "memory", "agent", "team"],
      limit: 4000,
    }).map((info) => {
      const proj = projectName.get(info.projectId) ?? "";
      return {
        key: `e:${refKey(info.ref)}`,
        section: ENTITY_SECTION[info.ref.type] ?? "Go to",
        title: info.title,
        subtitle: info.subtitle,
        // describeEntity already works the project into most subtitles, and a
        // project row *is* its project; saying it twice on one row is noise.
        context: proj && proj !== info.title && !info.subtitle.includes(proj) ? proj : "",
        glyph: info.glyph,
        tone: info.tone,
        extra: `${info.subtitle} ${proj} ${info.body}`.slice(0, 400),
        ref: info.ref,
        badge: info.ref.type === "channel" ? s.unread[info.ref.id] || undefined : undefined,
        run: () => goTo(info.view, info.ref),
      };
    });

    // Messages, built straight off the store. describeEntity's message branch
    // flattens every channel and scans it linearly, so routing thousands of
    // messages through it would be quadratic — and this is the one entity kind
    // that actually reaches those numbers.
    let total = 0;
    for (const arr of Object.values(s.messages)) total += arr.length;
    if (messageCache.current.count !== total) {
      const chan = new Map(s.channels.map((c) => [c.id, c] as const));
      const all: Message[] = [];
      for (const arr of Object.values(s.messages)) for (const m of arr) all.push(m);
      all.sort((a, b) => b.created_at - a.created_at);
      const spec = KIND_BY_TYPE.message;
      messageCache.current = {
        count: total,
        rows: all.slice(0, MAX_MESSAGES).map((m) => {
          const c = chan.get(m.channel_id);
          const ref: EntityRef = { type: "message", id: m.id };
          const body = m.content.replace(/\s+/g, " ").trim();
          const target: View | null = c
            ? { type: "channel", channelId: c.id, threadRootId: m.parent_id || m.id }
            : null;
          return {
            key: `e:${refKey(ref)}`,
            section: "Messages",
            title: body.length > 90 ? `${body.slice(0, 89)}…` : body || "(empty message)",
            subtitle: `${m.author_name}${c ? ` in #${c.name}` : ""}`,
            context: projectName.get(c?.project_id ?? "") ?? "",
            glyph: spec.glyph,
            tone: spec.tone,
            extra: body.slice(0, 400),
            ref,
            run: () => goTo(target, ref),
          };
        }),
      };
    }
    return out.concat(messageCache.current.rows);
    // searchEntities projects the store rather than taking it as an argument,
    // so the tables it reads are the real dependencies. Messages are absent on
    // purpose: rebuilding on every streamed token would undo the point of the
    // cache, and a reply that has not finished arriving is not worth finding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projects, channels, tasks, memory, agents, teams, unread]);

  /* ── navigation + activation helpers ───────────────────────── */

  function goTo(target: View | null, ref?: EntityRef) {
    if (target) setView(target);
    else if (ref) setInspect(ref); // nothing to navigate to — show it in the drawer
  }

  const defaultProject = useCallback((): string => {
    if (activeProject) return activeProject.id;
    return projects[0]?.id ?? "";
  }, [activeProject, projects]);

  const enterPrompt = useCallback(
    (prompt: Prompt) => {
      setStage({ kind: "prompt", prompt });
      setProjectPick(defaultProject());
      setRaw("");
      setTyped("");
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [defaultProject]
  );

  /**
   * The composer stamps a display name onto user messages and there is no
   * members table to read one from yet, so a command sent from here copies
   * whatever this channel already used and falls back to the same label
   * calendars.ts gives the local member.
   */
  const localAuthor = useCallback((channelId: string): string => {
    const mine = (useStore.getState().messages[channelId] ?? []).filter((m) => m.author_type === "user");
    return mine[mine.length - 1]?.author_name || "You";
  }, []);

  const runSlash = useCallback(
    async (cmd: SlashCommand, args: string) => {
      const channelId = activeChannel?.id;
      if (!channelId) return;
      const text = `/${cmd.name}${args ? ` ${args}` : ""}`;
      if (cmd.scope === "hq") {
        const outcome = await runCommand(channelId, text);
        if (outcome.message) {
          await insertMessage({
            id: uid(),
            channel_id: channelId,
            author_type: "system",
            author_id: "hq",
            author_name: "Spaces",
            content: outcome.message,
            status: "done",
            meta: "",
          });
        }
        setView({ type: "channel", channelId });
        return;
      }
      // Unknown to Spaces, so it belongs to the harness: posting it is exactly what
      // typing it into the composer does, which is what the user just asked for.
      const msg = await insertMessage({
        id: uid(),
        channel_id: channelId,
        author_type: "user",
        author_id: "user",
        author_name: localAuthor(channelId),
        content: text,
        status: "done",
        meta: "",
      });
      setView({ type: "channel", channelId });
      void triggerAgents(channelId, userTrigger(msg));
    },
    [activeChannel, insertMessage, localAuthor, setView]
  );

  /* ── the command registry ──────────────────────────────────── */

  const commandRows = useMemo<Row[]>(() => {
    if (!open) return [];
    const rows: Row[] = [];
    const push = (r: Row) => rows.push(r);

    const views: { label: string; glyph: string; tone: string; view: View; hint: string; extra: string }[] = [
      { label: "Dashboard", glyph: "◫", tone: "var(--accent)", view: { type: "dashboard" }, hint: "Everything at a glance", extra: "home overview" },
      { label: "Calendar", glyph: "◷", tone: "var(--yellow)", view: { type: "calendar" }, hint: "Events across every visible calendar", extra: "schedule agenda week day events" },
      { label: "Tasks", glyph: "✓", tone: "var(--green)", view: { type: "tasks" }, hint: "The board", extra: "board backlog todo doing done kanban" },
      { label: "Memory", glyph: "◆", tone: "var(--purple)", view: { type: "memory" }, hint: "Decisions and standing context", extra: "notes decisions context" },
      { label: "Agents & Teams", glyph: "✳", tone: "var(--orange)", view: { type: "agents" }, hint: "The roster", extra: "roster people bots claude codex ritz" },
      { label: "Connections", glyph: "⧉", tone: "var(--cyan)", view: { type: "graph" }, hint: "The link graph", extra: "graph links map network relations" },
      { label: "Workspaces", glyph: "⑂", tone: "var(--cyan)", view: { type: "workspaces" }, hint: "Per-agent git worktrees", extra: "worktrees branches isolate" },
      { label: "Git activity", glyph: "⌥", tone: "var(--green)", view: { type: "git" }, hint: "Commits, branches, pull requests", extra: "github commits diff branches prs" },
      { label: "Settings", glyph: "◐", tone: "var(--text-dim)", view: { type: "settings" }, hint: "Appearance, tools, everything else", extra: "preferences config options" },
    ];
    for (const v of views) {
      push({
        key: `c:go.${v.view.type}`,
        section: "Go to",
        title: v.label,
        subtitle: v.hint,
        context: "",
        glyph: v.glyph,
        tone: v.tone,
        extra: `go to open ${v.extra}`,
        run: () => setView(v.view),
      });
    }

    const noProject = "Create a project first — tasks and memory belong to one.";

    push({
      key: "c:new.task",
      section: "Create",
      title: "New task…",
      subtitle: projects.length ? "Title it, pick a project, done" : noProject,
      context: "",
      glyph: "✓",
      tone: "var(--green)",
      extra: "add create todo card",
      keepOpen: true,
      run: () => {
        if (!projects.length) return void toast.info("No projects yet", noProject);
        enterPrompt({
          key: "task",
          title: "New task",
          placeholder: "What needs doing?",
          help: "Lands in Todo. Assign it and add detail from the board.",
          scoped: true,
          submit: async (title, projectId) => {
            await addTask({ project_id: projectId, title });
            setView({ type: "tasks" });
            toast.success("Task added", title);
          },
        });
      },
    });

    push({
      key: "c:new.memory",
      section: "Create",
      title: "New memory…",
      subtitle: projects.length ? "A decision or a piece of standing context" : noProject,
      context: "",
      glyph: "◆",
      tone: "var(--purple)",
      extra: "add create note decision context remember",
      keepOpen: true,
      run: () => {
        if (!projects.length) return void toast.info("No projects yet", noProject);
        enterPrompt({
          key: "memory",
          title: "New memory",
          placeholder: "Title it — “We use SQLite, not Postgres”",
          help: "Saved as a note. Open Memory to write the body or pin it.",
          scoped: true,
          submit: async (title, projectId) => {
            await addMemory({ project_id: projectId, title });
            setView({ type: "memory" });
            toast.success("Memory added", title);
          },
        });
      },
    });

    push({
      key: "c:new.channel",
      section: "Create",
      title: "New channel…",
      subtitle: projects.length ? "A room for one thread of work" : "Create a project first — channels live in one.",
      context: "",
      glyph: "#",
      tone: "var(--blue)",
      extra: "add create room chat",
      keepOpen: true,
      run: () => {
        if (!projects.length) {
          return void toast.info("No projects yet", "Create a project first — channels live in one.");
        }
        enterPrompt({
          key: "channel",
          title: "New channel",
          placeholder: "frontend",
          help: "Lower-cased and hyphenated, the way channel names always are.",
          scoped: true,
          submit: async (name, projectId) => {
            const clean = slug(name);
            if (!clean) throw new Error("A channel needs a name with letters or digits in it.");
            const c = await addChannel(projectId, clean);
            setView({ type: "channel", channelId: c.id });
            toast.success("Channel created", `#${clean}`);
          },
        });
      },
    });

    push({
      key: "c:new.project",
      section: "Create",
      title: "New project…",
      subtitle: "Starts with a #general channel",
      context: "",
      glyph: "◈",
      tone: "var(--accent)",
      extra: "add create repo workspace",
      keepOpen: true,
      run: () =>
        enterPrompt({
          key: "project",
          title: "New project",
          placeholder: "Name it",
          help: "Repo, local path and agent isolation are set from the sidebar's full form.",
          scoped: false,
          submit: async (name) => {
            const p = await addProject({ name });
            const general = useStore.getState().channels.find((c) => c.project_id === p.id);
            if (general) setView({ type: "channel", channelId: general.id });
            toast.success("Project created", name);
          },
        }),
    });

    // "Link this to…" works on whatever you are looking at: the inspected
    // entity wins, because opening the drawer is the more specific gesture.
    const anchor: EntityRef | null =
      inspect ?? (activeChannel ? { type: "channel", id: activeChannel.id } : null);
    push({
      key: "c:link.this",
      section: "Connect",
      title: "Link this to…",
      subtitle: anchor
        ? `Draw a relation from ${describeEntity(anchor).title}`
        : "Open a channel, or select something in the inspector first",
      context: "",
      glyph: "↔",
      tone: "var(--cyan)",
      extra: "connect relate reference graph edge",
      keepOpen: true,
      run: () => {
        if (!anchor) {
          return void toast.info("Nothing to link", "Open a channel, or select something in the inspector first.");
        }
        setStage({ kind: "link", anchor });
        setRaw("");
        setTyped("");
        requestAnimationFrame(() => inputRef.current?.focus());
      },
    });

    push({
      key: "c:appearance.toggle",
      section: "Appearance",
      title: appearance === "dark" ? "Switch to light mode" : "Switch to dark mode",
      subtitle: "Each side remembers its own theme",
      context: "",
      glyph: appearance === "dark" ? "☀" : "☾",
      tone: "var(--yellow)",
      extra: "appearance dark light mode toggle contrast",
      run: () => toggleAppearance(),
    });
    push({
      key: "c:appearance.system",
      section: "Appearance",
      title: "Follow the system appearance",
      subtitle: "Flip with macOS, Windows or GNOME",
      context: "",
      glyph: "◐",
      tone: "var(--text-dim)",
      extra: "auto automatic os system appearance",
      run: () => setFollowSystem(true),
    });
    push({
      key: "c:help.keys",
      section: "Appearance",
      title: "Keyboard shortcuts",
      subtitle: "Every binding Spaces registers",
      context: "",
      glyph: "⌘",
      tone: "var(--text-dim)",
      extra: "help keys bindings cheat sheet hotkeys",
      keepOpen: true,
      run: () => {
        setMode("help");
        setRaw("");
        setTyped("");
        inputRef.current?.focus();
      },
    });

    // Every theme by name, so "dracula" goes straight there. The swatch previews
    // the theme's own palette, which makes those hexes data rather than styling.
    for (const t of THEMES) {
      push({
        key: `c:theme.${t.id}`,
        section: "Themes",
        title: t.name,
        subtitle: `${t.appearance} · ${t.author}`,
        context: "",
        glyph: "◍",
        tone: "var(--text-dim)",
        extra: `theme ${t.appearance} ${t.author} ${t.tags.join(" ")}`,
        swatch: { bg: t.bg, border: t.border, accent: t.accent },
        run: () => setTheme(t.id),
      });
    }

    if (activeChannel) {
      for (const cmd of slashCmds) {
        const needsArg = !!cmd.args && !/^\[/.test(cmd.args);
        push({
          key: `c:slash.${cmd.name}`,
          section: "This channel",
          title: `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`,
          subtitle: cmd.description,
          context: `#${activeChannel.name}`,
          glyph: "/",
          tone: cmd.scope === "hq" ? "var(--accent)" : "var(--orange)",
          extra: `slash command ${cmd.description} ${cmd.scope === "hq" ? "hq local" : "agent harness project"}`,
          keepOpen: needsArg,
          run: () => {
            if (!needsArg) return runSlash(cmd, "");
            enterPrompt({
              key: `slash.${cmd.name}`,
              title: `/${cmd.name}`,
              placeholder: cmd.args ?? "",
              help: `${cmd.description}. Runs in #${activeChannel.name}.`,
              scoped: false,
              submit: async (args) => {
                await runSlash(cmd, args.trim());
              },
            });
          },
        });
      }
    }

    return rows;
  }, [
    open,
    appearance,
    projects,
    inspect,
    activeChannel,
    slashCmds,
    addTask,
    addMemory,
    addChannel,
    addProject,
    enterPrompt,
    runSlash,
    setFollowSystem,
    setTheme,
    setView,
    toggleAppearance,
  ]);

  const allRows = useMemo(() => [...commandRows, ...entityRows], [commandRows, entityRows]);
  const byKey = useMemo(() => new Map(allRows.map((r) => [r.key, r] as const)), [allRows]);

  /* ── result assembly ───────────────────────────────────────── */

  const linking = stage.kind === "link";
  const fresh = projects.length === 0 || (tasks.length === 0 && memory.length === 0 && agents.length === 0);

  interface Scored {
    row: Row;
    score: number;
    hits?: number[];
  }

  const groups = useMemo<{ section: string; rows: Scored[] }[]>(() => {
    if (stage.kind === "prompt" || mode === "help") return [];

    const inMode = (r: Row): boolean => {
      if (linking) return !!r.ref && refKey(r.ref) !== refKey(stage.anchor);
      switch (mode) {
        case "commands":
          return !r.ref;
        case "channels":
          return r.ref?.type === "channel" || r.key === "c:new.channel";
        case "people":
          return r.ref?.type === "agent" || r.ref?.type === "team";
        default:
          return true;
      }
    };

    const pool = allRows.filter(inMode);
    const cap = mode === "all" && !linking ? MAX_PER_SECTION : MAX_PER_SECTION_FOCUSED;
    const bucket = new Map<string, Scored[]>();
    const add = (section: string, s: Scored) => {
      const list = bucket.get(section);
      if (list) list.push(s);
      else bucket.set(section, [s]);
    };

    if (!typed) {
      // Nothing typed: recents lead, then whatever the mode is *for*.
      if (mode === "all" && !linking) {
        for (const key of recents) {
          const row = byKey.get(key);
          if (row) add("Recent", { row, score: 0 });
        }
        if (fresh) {
          for (const key of ["c:new.project", "c:new.channel", "c:go.agents", "c:go.settings", "c:help.keys"]) {
            const row = byKey.get(key);
            if (row) add("Start here", { row, score: 0 });
          }
        }
      }
      const shown = new Set([...bucket.values()].flat().map((s) => s.row.key));
      const rest = pool.filter((r) => !shown.has(r.key));
      const rank = (r: Row) => (r.badge ?? 0) * -1;
      for (const row of [...rest].sort((a, b) => rank(a) - rank(b))) {
        const list = bucket.get(row.section);
        if (list && list.length >= cap) continue;
        add(row.section, { row, score: 0 });
      }
    } else {
      const needle = typed.toLowerCase();
      const scored: Scored[] = [];
      for (const row of pool) {
        const m = fuzzy(typed, row.title);
        if (m) {
          scored.push({ row, score: m.score + 10 + (recents.includes(row.key) ? 4 : 0), hits: m.hits });
          continue;
        }
        // Subtitles, project names and bodies match on substring rather than
        // subsequence. A scattered subsequence across 400 characters of body is
        // a coincidence, not a hit, and it buries the rows a reader can see a
        // reason for — the fuzziness earns its keep on titles, nowhere else.
        const at = row.extra.toLowerCase().indexOf(needle);
        if (at >= 0) scored.push({ row, score: 5 - Math.min(4, at / 80) });
      }
      scored.sort((a, b) => b.score - a.score);
      let total = 0;
      for (const s of scored) {
        if (total >= MAX_ROWS) break;
        const list = bucket.get(s.row.section);
        if (list && list.length >= cap) continue;
        add(s.row.section, s);
        total++;
      }
    }

    const out = [...bucket.entries()].map(([section, rows]) => ({ section, rows }));
    if (typed) {
      // With a query, the group holding the best answer goes first — typing
      // "dracula" should not make you scroll past every channel to reach it.
      const best = (g: { rows: Scored[] }) => Math.max(...g.rows.map((r) => r.score));
      out.sort((a, b) => best(b) - best(a));
    } else {
      const rank = (s: string) => SECTION_RANK.get(s) ?? SECTIONS.length;
      out.sort((a, b) => rank(a.section) - rank(b.section));
    }
    return out;
  }, [allRows, byKey, typed, mode, recents, fresh, linking, stage]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const selected = flat.length ? Math.min(sel, flat.length - 1) : -1;

  useEffect(() => {
    if (selected < 0) return;
    listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, groups]);

  /* ── activation ────────────────────────────────────────────── */

  const remember = useCallback((key: string) => {
    setRecents((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, MAX_RECENTS);
      saveRecents(next);
      return next;
    });
  }, []);

  const drawLink = useCallback(
    async (anchor: EntityRef, target: EntityRef, keepOpen: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        const sentence = `${describeEntity(anchor).title} related to ${describeEntity(target).title}`;
        // Snapshot first: addLink hands back the existing row for a duplicate,
        // and an Undo on that would tear down a link nobody just drew.
        const before = useStore.getState().links;
        const link = await addLink(anchor, target, "relates");
        if (!link) {
          toast.warn("Nothing to link", "An entity cannot be linked to itself.");
          return;
        }
        if (before.some((l) => l.id === link.id)) {
          toast.info("Already connected", sentence);
        } else {
          toast.show({
            kind: "success",
            title: "Linked",
            detail: sentence,
            action: { label: "Undo", run: () => void removeLink(link.id) },
          });
        }
        if (keepOpen) {
          setRaw("");
          setTyped("");
          setSel(0);
          inputRef.current?.focus();
        } else {
          close();
        }
      } catch (e) {
        toast.error("Could not create that link", e);
      } finally {
        setBusy(false);
      }
    },
    [addLink, busy, close, removeLink]
  );

  const activate = useCallback(
    (row: Row, alt: boolean) => {
      remember(row.key);
      if (stage.kind === "link") {
        if (row.ref) void drawLink(stage.anchor, row.ref, alt);
        return;
      }
      // ⌘↵ reads instead of travelling: the drawer shows the thing where you
      // stand, which is what you want when you are three clicks into something.
      if (alt && row.ref) {
        setInspect(row.ref);
        close();
        return;
      }
      if (row.keepOpen) {
        void Promise.resolve(row.run()).catch((e: unknown) => toast.error("That didn’t work", e));
        return;
      }
      close();
      void Promise.resolve(row.run()).catch((e: unknown) => toast.error("That didn’t work", e));
    },
    [close, drawLink, remember, setInspect, stage]
  );

  const submitPrompt = useCallback(async () => {
    if (stage.kind !== "prompt" || busy) return;
    const value = raw.trim();
    if (!value) return;
    setBusy(true);
    try {
      await stage.prompt.submit(value, projectPick || defaultProject());
      close();
    } catch (e) {
      toast.error(`Could not create that ${stage.prompt.title.replace(/^New /, "")}`, e);
    } finally {
      setBusy(false);
    }
  }, [busy, close, defaultProject, projectPick, raw, stage]);

  /* ── keyboard ──────────────────────────────────────────────── */

  const move = (delta: number) => {
    if (!flat.length) return;
    // Wraps in both directions, including a PageUp bigger than the list.
    setSel((((selected + delta) % flat.length) + flat.length) % flat.length);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // A sub-step is a place you can back out of; the search itself is not.
      if (stage.kind !== "search") {
        setStage({ kind: "search" });
        setRaw("");
        setTyped("");
        setMode("all");
        inputRef.current?.focus();
        return;
      }
      close();
      return;
    }

    if (e.key === "Tab") {
      // A dialog keeps its focus: tabbing out of a palette that is covering the
      // whole app leaves the keyboard somewhere the user cannot see.
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
        'input, select, button, [tabindex]:not([tabindex="-1"])'
      );
      if (!nodes?.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    if (stage.kind === "prompt") {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitPrompt();
      }
      return;
    }

    // Backspace at the very start drops the filter rather than doing nothing.
    if (e.key === "Backspace" && mode !== "all" && !raw) {
      e.preventDefault();
      setMode("all");
      return;
    }

    if (mode === "help") return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "PageDown":
        e.preventDefault();
        move(8);
        break;
      case "PageUp":
        e.preventDefault();
        move(-8);
        break;
      case "Home":
        if (flat.length) {
          e.preventDefault();
          setSel(0);
        }
        break;
      case "End":
        if (flat.length) {
          e.preventDefault();
          setSel(flat.length - 1);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (selected >= 0) activate(flat[selected].row, e.metaKey || e.ctrlKey);
        break;
      default:
        break;
    }
  };

  if (!open) return null;

  /* ── render ────────────────────────────────────────────────── */

  const activePrefix = PREFIX_BY_MODE.get(mode);
  const prompt = stage.kind === "prompt" ? stage.prompt : null;
  const anchorInfo = stage.kind === "link" ? describeEntity(stage.anchor) : null;
  // One project means there is nothing to choose; the chooser would be a
  // decision the user cannot get wrong, which is a decision not worth asking for.
  const scoped = !!prompt?.scoped && projects.length > 1;

  const placeholder = prompt
    ? prompt.placeholder
    : stage.kind === "link"
      ? "Search for the other end of the link…"
      : mode === "help"
        ? "Filter shortcuts…"
        : activePrefix
          ? `Search ${activePrefix.label.toLowerCase()}…`
          : "Search everything, or type > # @ ?";

  // Substring, not subsequence: "esc" should find Escape, not every row whose
  // words happen to contain an e, an s and a c in that order.
  const helpNeedle = typed.toLowerCase();
  const helpGroups =
    mode !== "help"
      ? []
      : SHORTCUTS.map((g) => ({
          group: g.group,
          rows: helpNeedle
            ? g.rows.filter((r) => `${r.what} ${r.keys} ${g.group}`.toLowerCase().includes(helpNeedle))
            : g.rows,
        })).filter((g) => g.rows.length > 0);

  let index = -1;

  return (
    <div
      className="palette-backdrop pal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <div className="pal-head">
          <span className="pal-lens" aria-hidden="true" />
          {(prompt || anchorInfo) && (
            <span className="pal-crumb">
              {prompt ? (
                prompt.title
              ) : (
                <>
                  <span className="pal-crumb-glyph" style={{ color: anchorInfo!.tone }} aria-hidden="true">
                    {anchorInfo!.glyph}
                  </span>
                  Link {anchorInfo!.title} to…
                </>
              )}
            </span>
          )}
          {!prompt && !anchorInfo && activePrefix && (
            <button
              type="button"
              className="pal-crumb pal-crumb-clear"
              onClick={() => {
                setMode("all");
                inputRef.current?.focus();
              }}
              aria-label={`Clear the ${activePrefix.label} filter`}
            >
              {activePrefix.label}
              <span aria-hidden="true">✕</span>
            </button>
          )}
          <input
            ref={inputRef}
            className="pal-input"
            role="combobox"
            aria-expanded={stage.kind !== "prompt" && mode !== "help"}
            aria-controls="pal-list"
            aria-activedescendant={selected >= 0 ? `pal-row-${selected}` : undefined}
            aria-label={prompt ? prompt.title : "Search Spaces"}
            placeholder={placeholder}
            value={raw}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => onInput(e.target.value)}
          />
        </div>

        {/* The prefixes sit above the list, not under it: a hint you have to
            scroll a hundred results to find is not a hint. */}
        {!raw && mode === "all" && stage.kind === "search" && (
          <div className="pal-prefixes" role="group" aria-label="Search prefixes">
            {PREFIXES.map((p) => (
              <button
                key={p.prefix}
                type="button"
                className="pal-prefix"
                onClick={() => {
                  setMode(p.mode);
                  inputRef.current?.focus();
                }}
              >
                <kbd className="pal-kbd">{p.prefix}</kbd>
                <span className="pal-prefix-label">{p.label}</span>
                <span className="pal-prefix-hint">{p.hint}</span>
              </button>
            ))}
          </div>
        )}

        {prompt ? (
          <div className="pal-body pal-prompt">
            <p className="pal-help">{prompt.help}</p>
            {scoped && (
              <label className="pal-scope">
                <span>Project</span>
                <select value={projectPick} onChange={(e) => setProjectPick(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : mode === "help" ? (
          <div className="pal-body" ref={listRef}>
            {helpGroups.map((g) => (
              <div key={g.group} className="pal-group">
                <div className="pal-head-row">{g.group}</div>
                {g.rows.map((r) => (
                  <div key={r.what} className="pal-key-row">
                    <span className="pal-keys">
                      {r.keys.split(/\s{2,}/).map((k) => (
                        <kbd key={k} className="pal-kbd">{k}</kbd>
                      ))}
                    </span>
                    <span className="pal-key-what">{r.what}</span>
                  </div>
                ))}
              </div>
            ))}
            {helpGroups.length === 0 && <div className="pal-empty">No shortcut matches “{typed}”.</div>}
          </div>
        ) : (
          <div className="pal-body" id="pal-list" role="listbox" aria-label="Results" ref={listRef}>
            {groups.map((g) => (
              <div key={g.section} className="pal-group">
                <div className="pal-head-row">{g.section}</div>
                {g.rows.map((s) => {
                  index++;
                  const i = index;
                  const row = s.row;
                  return (
                    <div
                      key={row.key}
                      id={`pal-row-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={i === selected}
                      className={"pal-row" + (i === selected ? " on" : "")}
                      onMouseMove={() => setSel(i)}
                      onClick={(e) => activate(row, e.metaKey || e.ctrlKey)}
                    >
                      {row.swatch ? (
                        <span
                          className="pal-glyph pal-swatch"
                          style={{ background: row.swatch.bg, borderColor: row.swatch.border }}
                          aria-hidden="true"
                        >
                          <i style={{ background: row.swatch.accent }} />
                        </span>
                      ) : (
                        <span className="pal-glyph" style={{ color: row.tone }} aria-hidden="true">
                          {row.glyph}
                        </span>
                      )}
                      <span className="pal-text">
                        <span className="pal-title">
                          <Marked text={row.title} hits={s.hits} />
                        </span>
                        {row.subtitle && <span className="pal-sub">{row.subtitle}</span>}
                      </span>
                      {row.context && <span className="pal-context">{row.context}</span>}
                      {row.badge ? <span className="pal-badge">{row.badge}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))}

            {flat.length === 0 && (
              <div className="pal-empty">
                {typed ? `No matches for “${typed}”.` : "Nothing here yet."}
              </div>
            )}
          </div>
        )}

        <div className="pal-foot">
          {prompt ? (
            <span className="pal-foot-keys">
              <kbd className="pal-kbd">↵</kbd> create
              <kbd className="pal-kbd">esc</kbd> back
            </span>
          ) : mode === "help" ? (
            <span className="pal-foot-keys">
              <kbd className="pal-kbd">⌫</kbd> back to search
              <kbd className="pal-kbd">esc</kbd> close
            </span>
          ) : (
            <span className="pal-foot-keys">
              <kbd className="pal-kbd">↑↓</kbd> move
              <kbd className="pal-kbd">↵</kbd> {stage.kind === "link" ? "link" : "open"}
              <kbd className="pal-kbd">⌘↵</kbd> {stage.kind === "link" ? "link, stay open" : "inspect"}
              <kbd className="pal-kbd">esc</kbd> close
            </span>
          )}
          {mode !== "help" && !prompt && (
            <button
              type="button"
              className="pal-foot-link"
              onClick={() => {
                setMode("help");
                setRaw("");
                inputRef.current?.focus();
              }}
            >
              Shortcuts <kbd className="pal-kbd">?</kbd>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
