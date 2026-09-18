/**
 * sessions.ts — the work that already happened.
 *
 * Claude Code and Codex both keep every session they have ever run on this
 * Mac, as JSONL, keyed by the directory the work happened in. On this machine
 * that is roughly three thousand sessions across a hundred and fifty
 * directories. Until now Spaces started every project from nothing while all
 * of it sat unread on the same disk — so the first thing anyone had to do was
 * explain a project that two agents already knew intimately.
 *
 * This layer turns that into Spaces projects. The grouping key is the working
 * directory, because that is the one thing a session records about *where* it
 * belongs rather than *when* it ran, and it is the same key Spaces already
 * uses for a project's local path.
 *
 * Two things are deliberately not done here. Transcripts are not copied: the
 * originals are the record, they are already on disk, and duplicating tens of
 * thousands of turns into a repository would be somebody else's mess to clean
 * up. And the raw conversation is never pushed into an agent's prompt — what
 * goes into project memory is an index of what happened, with the path to
 * each session, so an agent can read the one that matters instead of all of
 * them.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDb, now, uid } from "./db";
import { matchProject, nameOf, rootOf } from "./sessionpaths";
import { useStore } from "./store";
import type { Project } from "./types";

export { matchProject, nameOf, rootOf } from "./sessionpaths";

/** One session file, as a scan sees it. */
export interface SessionSummary {
  source: "claude" | "codex";
  /**
   * What identifies this session — its file, not the id recorded inside it.
   * Codex reuses `sessionId` across every rollout a conversation resumes into,
   * so it is not unique and must never be a key.
   */
  id: string;
  /** The id the session records for itself. Several files may share one. */
  sessionId: string;
  path: string;
  cwd: string;
  title: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
}

/** One turn of a conversation. */
export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface SessionTranscript {
  source: string;
  id: string;
  sessionId: string;
  cwd: string;
  title: string;
  startedAt: number;
  endedAt: number;
  turns: SessionTurn[];
}

/** What an import does with a directory. */
export type ImportMode =
  /** Index it into project memory only — no messages. */
  | "index"
  /** Index it *and* replay the conversations into a channel. */
  | "browse";

/** A working directory, and everything found in it. */
export interface SessionGroup {
  /** The directory sessions are grouped under, after un-worktreeing. */
  cwd: string;
  /** The last path component, as a project name. */
  name: string;
  sessions: SessionSummary[];
  claude: number;
  codex: number;
  /** Most recent session, in ms. */
  lastAt: number;
  /** The Spaces project this already belongs to, if any. */
  projectId: string;
  /** How many of these sessions are already imported. */
  imported: number;
  /** The watch mode in force for this directory, "" when not watched. */
  watching: ImportMode | "";
}

/** A row of `session_imports`. */
interface ImportedRow {
  source: string;
  session_id: string;
  project_id: string;
  channel_id: string;
  path: string;
  mtime: number;
  bytes: number;
}

interface WatchRow {
  cwd: string;
  project_id: string;
  mode: string;
}

/** The channel imported conversations land in. */
export const HISTORY_CHANNEL = "history";

/**
 * The most recent sessions an index names individually.
 *
 * A directory here has up to 786 sessions. Listing all of them would produce a
 * memory entry longer than most source files and drown the twelve entries an
 * agent's prompt actually carries. The recent ones are the ones that describe
 * where a project currently is; the rest are counted, and the directory is
 * named so anything older can be found.
 */
const INDEX_LIMIT = 60;

/**
 * Sessions replayed into a channel per directory, newest first.
 *
 * Browsing is for picking up a thread, not for archaeology, and a channel with
 * forty thousand messages in it is not browsable by anyone. The cap is on
 * sessions rather than messages so a session is never half-imported.
 */
const REPLAY_LIMIT = 200;

/** Every session on this Mac, grouped by the directory it belongs to. */
export async function scanSessions(): Promise<SessionGroup[]> {
  const found = await invoke<SessionSummary[]>("scan_agent_sessions").catch(() => []);
  const db = await getDb();
  const [imported, watches] = await Promise.all([
    db.select<ImportedRow[]>("SELECT * FROM session_imports"),
    db.select<WatchRow[]>("SELECT * FROM session_watches"),
  ]);
  const seen = new Set(imported.map((r) => `${r.source}:${r.session_id}`));
  const watched = new Map(watches.map((w) => [w.cwd, w.mode as ImportMode]));
  const projects = useStore.getState().projects;

  const groups = new Map<string, SessionGroup>();
  for (const session of found) {
    const cwd = rootOf(session.cwd);
    if (!cwd) continue;
    let group = groups.get(cwd);
    if (!group) {
      group = {
        cwd,
        name: nameOf(cwd),
        sessions: [],
        claude: 0,
        codex: 0,
        lastAt: 0,
        projectId: matchProject(cwd, projects)?.id ?? "",
        imported: 0,
        watching: watched.get(cwd) ?? "",
      };
      groups.set(cwd, group);
    }
    group.sessions.push(session);
    if (session.source === "codex") group.codex += 1;
    else group.claude += 1;
    group.lastAt = Math.max(group.lastAt, session.endedAt, session.startedAt);
    if (seen.has(`${session.source}:${session.id}`)) group.imported += 1;
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.sessions.sort((a, b) => b.endedAt - a.endedAt);
  }
  // Most recently worked in first: that is the order somebody scanning this
  // list is looking for, and it puts live projects above abandoned ones.
  return list.sort((a, b) => b.lastAt - a.lastAt);
}

/** Progress, so a long import can say what it is doing. */
export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}

export interface ImportResult {
  projectId: string;
  projectName: string;
  /** Sessions read this time; already-imported ones are not counted. */
  sessions: number;
  messages: number;
  /** Sessions that could not be read, with the reason. */
  failures: string[];
}

/**
 * Directories with an import running, so two cannot run at once.
 *
 * The watcher and somebody clicking Import can reach the same folder at the
 * same moment, and they need not agree: a catch-up runs in whatever mode was
 * stored, while a click may be changing that mode. Both writing at once left a
 * folder recorded as indexed while its channel was being filled — converging
 * eventually, but only after saying two different things. One at a time is
 * simpler than making them agree.
 */
const importing = new Set<string>();

/**
 * Bring a directory's sessions into Spaces.
 *
 * Safe to run again: a session already imported is skipped unless its file has
 * grown since, which is what makes the watcher below a loop rather than a
 * one-shot. Nothing is ever written back to the session files.
 */
export async function importGroup(
  group: SessionGroup,
  mode: ImportMode,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportResult> {
  if (importing.has(group.cwd)) {
    throw new Error(`${group.name} is already being imported.`);
  }
  importing.add(group.cwd);
  try {
    return await runImport(group, mode, onProgress);
  } finally {
    importing.delete(group.cwd);
  }
}

/** True while a directory is mid-import, so a catch-up can stand aside. */
export function isImporting(cwd: string): boolean {
  return importing.has(cwd);
}

async function runImport(
  group: SessionGroup,
  mode: ImportMode,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportResult> {
  const store = useStore.getState();
  const db = await getDb();

  const project = await ensureProject(group);
  const channelId = mode === "browse" ? await ensureHistoryChannel(project.id) : "";

  const existing = await db.select<ImportedRow[]>(
    "SELECT * FROM session_imports WHERE project_id = $1",
    [project.id]
  );
  const before = new Map(existing.map((r) => [`${r.source}:${r.session_id}`, r]));

  // Oldest first, so a channel reads forwards in time like a conversation.
  const replayable = group.sessions.slice(0, REPLAY_LIMIT).reverse();
  const candidates = mode === "browse" ? replayable : group.sessions;

  let messages = 0;
  let read = 0;
  const failures: string[] = [];

  for (const [index, session] of candidates.entries()) {
    onProgress?.({
      done: index,
      total: candidates.length,
      label: session.title || session.id,
    });

    const key = `${session.source}:${session.id}`;
    const prior = before.get(key);
    // Unchanged and already in, with a channel if one is wanted: nothing to do.
    if (prior && prior.bytes >= session.bytes && (mode !== "browse" || prior.channel_id)) {
      continue;
    }

    let transcript: SessionTranscript;
    try {
      transcript = await invoke<SessionTranscript>("read_agent_session", {
        path: session.path,
        source: session.source,
      });
    } catch (e) {
      failures.push(`${session.title || session.id}: ${String(e)}`);
      continue;
    }
    read += 1;

    if (mode === "browse" && channelId) {
      messages += await replay(session, transcript, channelId);
    }

    await db.execute(
      `INSERT INTO session_imports
         (source, session_id, agent_session_id, project_id, channel_id, path, cwd, title,
          turns, mtime, bytes, started_at, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(source, session_id) DO UPDATE SET
         agent_session_id = $3, project_id = $4, channel_id = $5, path = $6, title = $8,
         turns = $9, mtime = $10, bytes = $11, imported_at = $13`,
      [
        session.source,
        session.id,
        transcript.sessionId || session.sessionId,
        project.id,
        channelId,
        session.path,
        group.cwd,
        transcript.title || session.title,
        transcript.turns.length,
        session.endedAt,
        session.bytes,
        transcript.startedAt || session.startedAt,
        now(),
      ]
    );
  }

  /*
   * Build the index from what was actually read, not from the scan.
   *
   * A scan stops early on purpose — it has three thousand files to get
   * through — so a session whose opening prompt sits past those caps comes
   * back untitled. Reading the whole file finds it. Preferring the stored
   * title means the index says what a session was about wherever anything
   * knows, instead of "(untitled)" wherever the cheap pass gave up.
   */
  const titles = new Map(
    (
      await db.select<{ source: string; session_id: string; title: string }[]>(
        "SELECT source, session_id, title FROM session_imports WHERE project_id = $1",
        [project.id]
      )
    ).map((r) => [`${r.source}:${r.session_id}`, r.title])
  );
  await writeIndex(project.id, group, titles);
  await db.execute(
    `INSERT INTO session_watches (cwd, project_id, mode, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT(cwd) DO UPDATE SET project_id = $2, mode = $3`,
    [group.cwd, project.id, mode, now()]
  );
  await store.refreshAll();

  onProgress?.({ done: candidates.length, total: candidates.length, label: "" });
  return {
    projectId: project.id,
    projectName: project.name,
    sessions: read,
    messages,
    failures,
  };
}

/** Find or create the project a directory belongs to. */
async function ensureProject(group: SessionGroup): Promise<Project> {
  const store = useStore.getState();
  const found =
    store.projects.find((p) => p.id === group.projectId) ?? matchProject(group.cwd, store.projects);
  if (found) return found;
  return store.addProject({
    name: group.name,
    local_path: group.cwd,
    description: `Imported from ${group.claude + group.codex} earlier agent sessions.`,
  });
}

/** Find or create the channel imported conversations land in. */
async function ensureHistoryChannel(projectId: string): Promise<string> {
  const store = useStore.getState();
  const found = store.channels.find(
    (c) => c.project_id === projectId && c.name === HISTORY_CHANNEL
  );
  if (found) return found.id;
  const created = await store.addChannel(
    projectId,
    HISTORY_CHANNEL,
    "Sessions from Claude Code and Codex that ran here before Spaces did."
  );
  return created.id;
}

/**
 * Write one session's turns into a channel.
 *
 * Each session opens with a divider carrying its title, date and the path to
 * the original file, because a channel of replayed conversations is otherwise
 * an undifferentiated wall: the divider is what makes it possible to tell
 * where one piece of work ended and the next began.
 *
 * Messages are inserted straight into SQLite rather than through the store.
 * `insertMessage` also updates React state and the read cursor for every call,
 * which is right for a message someone just sent and wrong for ten thousand
 * arriving at once.
 */
async function replay(
  session: SessionSummary,
  transcript: SessionTranscript,
  channelId: string
): Promise<number> {
  const db = await getDb();
  /*
   * Clear this session's messages first, always — not only when the
   * bookkeeping says it was imported before.
   *
   * A session that grew since last time is re-read from the start, so its old
   * messages have to go; that much needs `prior`. But the bookkeeping row is
   * written *after* the messages, so any failure in between leaves messages
   * with nothing recording them, and a retry that trusted `prior` would then
   * insert a second copy. Deleting unconditionally makes a replay idempotent
   * whatever happened last time, at the cost of one statement.
   *
   * The key lives in its own column, not in `meta`: `meta` is rendered under
   * the message, and an internal identity put there showed up in the channel
   * as "imported:claude:6815ecec-…".
   */
  await db.execute("DELETE FROM messages WHERE channel_id = $1 AND import_key = $2", [
    channelId,
    importTag(session),
  ]);

  const when = transcript.startedAt || session.startedAt || session.endedAt;
  const agent = session.source === "codex" ? "Codex" : "Claude Code";
  const rows: unknown[][] = [];

  rows.push([
    uid(),
    channelId,
    "system",
    "",
    agent,
    `**${transcript.title || session.title || "Untitled session"}**\n\n`
      + `${agent} · ${new Date(when).toLocaleString()} · ${transcript.turns.length} turns\n\n`
      + `\`${session.path}\``,
    "done",
    `${agent} · imported`,
    "",
    "",
    when,
    importTag(session),
  ]);

  transcript.turns.forEach((turn, index) => {
    rows.push([
      uid(),
      channelId,
      turn.role === "user" ? "user" : "agent",
      "",
      turn.role === "user" ? "You" : agent,
      turn.text,
      "done",
      // Shown under the message, so it says where this came from rather than
      // carrying a key nobody wants to read.
      `imported from ${agent}`,
      "",
      "",
      // Turns without a timestamp still have to sort after the divider and
      // keep their order; the index is the tiebreak.
      (turn.at || when) + index,
      importTag(session),
    ]);
  });

  for (const row of rows) {
    await db.execute(
      "INSERT INTO messages (id, channel_id, author_type, author_id, author_name, content, status, meta, parent_id, run_id, created_at, import_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      row
    );
  }
  return rows.length;
}

/**
 * The marker that ties a message back to the session it came from.
 *
 * Keyed on the file, like everything else here, so re-importing one rollout
 * cannot take its siblings with it. The divider carries the same tag and is
 * told apart by its author type, which keeps the delete a single exact match.
 */
export function importTag(session: { source: string; id: string }): string {
  return `imported:${session.source}:${session.id}`;
}

/**
 * Put an index of the directory's sessions into project memory.
 *
 * This is the part agents actually read. Project memory is quoted into every
 * run, so it has to be an index and not a transcript: what was worked on,
 * when, by which agent, and the path to the full session for anything that
 * needs reading properly.
 *
 * One entry per project, rewritten in place, so importing twice does not
 * produce two.
 */
async function writeIndex(
  projectId: string,
  group: SessionGroup,
  titles: Map<string, string>
): Promise<void> {
  const store = useStore.getState();
  const title = "Earlier agent sessions";
  const recent = group.sessions.slice(0, INDEX_LIMIT);

  const lines = [
    `${group.claude + group.codex} sessions ran in \`${group.cwd}\` before this project existed:`
      + ` ${group.claude} with Claude Code, ${group.codex} with Codex.`,
    "",
    `The newest ${recent.length} are listed below. Each path is the complete session —`
      + ` read one when it is relevant rather than assuming what it says.`,
    "",
    ...recent.map((s) => {
      const when = new Date(s.endedAt || s.startedAt).toISOString().slice(0, 10);
      const agent = s.source === "codex" ? "Codex" : "Claude";
      const label = titles.get(`${s.source}:${s.id}`) || s.title || "(untitled)";
      return `- ${when} · ${agent} · ${label}\n  \`${s.path}\``;
    }),
  ];

  const existing = store.memory.find(
    (m) => m.project_id === projectId && m.title === title
  );
  if (existing) {
    await store.updateMemory(existing.id, { content: lines.join("\n") });
    return;
  }
  await store.addMemory({
    project_id: projectId,
    kind: "note",
    title,
    content: lines.join("\n"),
    pinned: 1,
  });
}

/**
 * Pick up sessions written since the last import.
 *
 * Runs against the directories somebody chose to watch, and only those: an
 * import is a decision about one project, not a standing instruction to hoover
 * up everything on the disk. Returns what it brought in so a caller can say so
 * — silence is the right default, but a project that quietly gained two
 * hundred messages should be able to mention it.
 */
export async function catchUpWatched(): Promise<ImportResult[]> {
  const db = await getDb();
  const watches = await db.select<WatchRow[]>("SELECT * FROM session_watches");
  if (watches.length === 0) return [];

  const groups = await scanSessions();
  const byCwd = new Map(groups.map((g) => [g.cwd, g]));
  const results: ImportResult[] = [];

  for (const watch of watches) {
    const group = byCwd.get(watch.cwd);
    if (!group) continue;
    // Somebody is importing this folder by hand right now; their choice of
    // mode is the current one, and two writers would only disagree.
    if (isImporting(watch.cwd)) continue;
    // Nothing new: every session is already recorded at its current size.
    if (group.imported >= group.sessions.length) continue;
    const mode: ImportMode = watch.mode === "browse" ? "browse" : "index";
    const result = await importGroup(group, mode);
    if (result.sessions > 0) results.push(result);
  }
  return results;
}

/** Stop watching a directory. Imported history stays; nothing new arrives. */
export async function unwatch(cwd: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM session_watches WHERE cwd = $1", [cwd]);
}

/**
 * Keep watched directories current while Spaces is open.
 *
 * Deliberately lazy. The first thing it does is ask whether anything is
 * watched at all, because for most people the answer is no and walking three
 * thousand files to discover that would be rude. When something is watched it
 * re-scans on a slow cadence and when the window comes back to the front —
 * which is when somebody has usually just finished a session in another app
 * and switched over.
 *
 * Nothing here is announced unless it found something. A watcher that says
 * "checked, nothing new" every ten minutes is a watcher people turn off.
 */
const WATCH_INTERVAL_MS = 10 * 60 * 1000;
/** Long enough after a focus change that switching apps twice is one check. */
const WATCH_SETTLE_MS = 4_000;

export function initSessionWatch(
  announce: (results: ImportResult[]) => void
): () => void {
  let timer = 0;
  let settle = 0;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const db = await getDb();
      const [{ n }] = await db.select<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM session_watches"
      );
      if (!n) return;
      const results = await catchUpWatched();
      if (results.length > 0) announce(results);
    } catch {
      // A watcher is a convenience. Failing loudly on every tick because a
      // session file was half-written is worse than missing this round.
    } finally {
      running = false;
    }
  };

  const soon = () => {
    window.clearTimeout(settle);
    settle = window.setTimeout(() => void run(), WATCH_SETTLE_MS);
  };
  const onFocus = () => {
    if (document.visibilityState === "visible") soon();
  };

  settle = window.setTimeout(() => void run(), WATCH_SETTLE_MS * 2);
  timer = window.setInterval(() => void run(), WATCH_INTERVAL_MS);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);

  return () => {
    window.clearTimeout(settle);
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
  };
}
