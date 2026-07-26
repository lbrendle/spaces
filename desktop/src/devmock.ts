/**
 * The browser dev harness: `npm run dev` without a Tauri rebuild.
 *
 * @tauri-apps/api v2 funnels the entire IPC surface through one global.
 * `invoke(cmd, args)` is a call to `window.__TAURI_INTERNALS__.invoke`, and
 * `listen()` is itself an invoke of "plugin:event|listen" after the handler is
 * registered through `window.__TAURI_INTERNALS__.transformCallback`. So
 * installing that object before the app boots mocks *everything* — the SQL
 * plugin, the event bus, every custom Rust command — and not one application
 * file needs a branch for it.
 *
 * Everything below is self-contained: only types are imported from src/, so
 * this module can never be the reason the real app behaves differently.
 *
 * Reset the seeded database from the devtools console:
 *     __hqdev.reset()          // wipe + reseed + reload
 *     __hqdev.wipe()           // wipe only, no reload
 * or clear localStorage keys "hq.devmock.db" / "hq.devmock.seed" by hand.
 */
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type {
  Agent, Assignment, Channel, ChannelMember, Link, MemoryEntry, Message,
  Project, Run, Task, Team, TeamMember,
} from "./types";

/* ================================================================== *
 * install
 * ================================================================== */

const DB_KEY = "hq.devmock.db";
const SEED_KEY = "hq.devmock.seed";
/** Bump to invalidate everyone's saved demo database after editing the seed. */
const SEED_VERSION = "3";

export function installDevMock(): void {
  if (typeof window === "undefined") return;
  // Inside the real app Tauri installed this before our bundle ran. Never
  // shadow it — that would silently replace the actual backend.
  if ("__TAURI_INTERNALS__" in window) return;

  const w = window as unknown as Record<string, unknown>;
  // @tauri-apps/api's isTauri() reads this one global, and browser.ts guards
  // every call with it. Left unset, browser_open/bounds/navigate silently
  // return without ever reaching the harness — which is exactly how the
  // browser pane went unexercised outside the packaged app. Claiming it here
  // costs nothing else: isTauri() has no other caller in src/.
  w.isTauri = true;
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => dispatch(cmd, args ?? {}),
    transformCallback,
    unregisterCallback,
    runCallback,
    convertFileSrc: (path: string) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
  };
  // `unlisten()` calls this *before* the "plugin:event|unlisten" invoke.
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => dropListener(event, eventId),
  };
  w.__hqdev = {
    reset() {
      wipe();
      location.reload();
    },
    wipe,
    emit,
    /** The live sql.js handle, for poking at the demo data from the console. */
    get db() {
      return database;
    },
    /** Live terminals: what each was spawned as, and the size it was told. */
    get ptys() {
      return [...ptys].map(([sessionId, s]) => ({
        sessionId,
        command: s.command,
        cwd: s.cwd,
        cols: s.cols,
        rows: s.rows,
      }));
    },
    /** Open project browsers and the rectangle each was last placed at. */
    get browsers() {
      return [...browsers].map(([label, b]) => ({ label, ...b }));
    },
  };

  console.info(
    "%cHQ dev mock%c Tauri is faked in this tab: sql.js database, canned git/gh, simulated agent runs. `__hqdev.reset()` to reseed.",
    "background:#6c5ce7;color:#fff;padding:2px 6px;border-radius:3px",
    ""
  );
}

/* ================================================================== *
 * callbacks + the event bus
 * ================================================================== */

let nextCallbackId = 1;
const callbacks = new Map<number, { fn: (payload: unknown) => void; once: boolean }>();
/** event name -> the callback ids listening to it. The id doubles as the rid. */
const listeners = new Map<string, Set<number>>();

function transformCallback(cb?: (payload: unknown) => void, once = false): number {
  const id = nextCallbackId++;
  callbacks.set(id, { fn: cb ?? (() => {}), once });
  return id;
}

function unregisterCallback(id: number): void {
  callbacks.delete(id);
}

function runCallback(id: number, payload: unknown): void {
  const entry = callbacks.get(id);
  if (!entry) return;
  if (entry.once) callbacks.delete(id);
  entry.fn(payload);
}

function dropListener(event: string, eventId: number): void {
  listeners.get(event)?.delete(eventId);
  callbacks.delete(eventId);
}

/** Deliver an event exactly as Tauri does: `{ event, id, payload }`. */
function emit(event: string, payload: unknown): void {
  // Copy first: a handler is allowed to unlisten from inside itself.
  for (const id of [...(listeners.get(event) ?? [])]) runCallback(id, { event, id, payload });
}

/* ================================================================== *
 * sql.js, standing in for the SQL plugin
 * ================================================================== */

interface SqlStatement {
  bind(values: Record<string, unknown>): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
}

interface SqlDatabase {
  run(sql: string, params?: Record<string, unknown>): void;
  prepare(sql: string): SqlStatement;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  export(): Uint8Array;
  getRowsModified(): number;
}

let database: SqlDatabase | null = null;
let opening: Promise<SqlDatabase> | null = null;

async function openDatabase(): Promise<SqlDatabase> {
  if (database) return database;
  if (!opening) {
    opening = (async () => {
      const mod = (await import("sql.js")) as unknown as Record<string, unknown>;
      const initSqlJs = (mod.default ?? mod) as (cfg: {
        locateFile: (f: string) => string;
      }) => Promise<{ Database: new (bytes?: Uint8Array) => SqlDatabase }>;
      const SQL = await initSqlJs({ locateFile: () => wasmUrl });

      const saved = readSaved();
      const db = saved ? new SQL.Database(saved) : new SQL.Database();
      if (!saved) {
        seed(db);
        persistNow(db);
      }
      database = db;
      return db;
    })().catch((e) => {
      opening = null;
      throw e;
    });
  }
  return opening;
}

function readSaved(): Uint8Array | null {
  try {
    if (localStorage.getItem(SEED_KEY) !== SEED_VERSION) {
      // The seed changed under a database written by an older harness; that
      // one is demo data, so throwing it away is the right call.
      localStorage.removeItem(DB_KEY);
      return null;
    }
    const raw = localStorage.getItem(DB_KEY);
    return raw ? fromBase64(raw) : null;
  } catch {
    return null;
  }
}

function wipe(): void {
  try {
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(SEED_KEY);
  } catch {
    // private-mode localStorage — nothing to wipe
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistBroken = false;

/** Demo edits should survive a reload, but not cost a serialize per keystroke. */
function schedulePersist(): void {
  if (persistBroken || !database) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (database) persistNow(database);
  }, 400);
}

function persistNow(db: SqlDatabase): void {
  try {
    localStorage.setItem(DB_KEY, toBase64(db.export()));
    localStorage.setItem(SEED_KEY, SEED_VERSION);
  } catch (e) {
    // Quota is the usual cause once a demo has a lot of messages. Losing
    // persistence is survivable; failing every write is not.
    persistBroken = true;
    console.warn("[devmock] database persistence disabled:", e);
  }
}

function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The app binds `$1, $2 …`, which SQLite reads as *named* parameters — so they
 * bind by name, not position. That is also what makes a query that repeats
 * `$2` (see markChannelRead) work with fewer values than placeholders.
 */
function bindMap(values: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  values.forEach((v, i) => {
    out[`$${i + 1}`] = v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  return out;
}

function selectRows(db: SqlDatabase, query: string, values: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(query);
  try {
    if (values.length) stmt.bind(bindMap(values));
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function executeSql(db: SqlDatabase, query: string, values: unknown[]): [number, number] {
  if (values.length) db.run(query, bindMap(values));
  else db.run(query);
  schedulePersist();
  let lastInsertId = 0;
  try {
    lastInsertId = Number(db.exec("SELECT last_insert_rowid()")[0]?.values?.[0]?.[0] ?? 0);
  } catch {
    // pragmas and DDL have no insert id
  }
  return [db.getRowsModified(), lastInsertId];
}

/* ================================================================== *
 * command dispatch
 * ================================================================== */

const warned = new Set<string>();

async function dispatch(cmd: string, args: Record<string, any>): Promise<unknown> {
  switch (cmd) {
    /* ── SQL plugin ─────────────────────────────────────────── */
    case "plugin:sql|load":
      await openDatabase();
      return String(args.db ?? "sqlite:hq.db");
    case "plugin:sql|select":
      return selectRows(await openDatabase(), String(args.query), args.values ?? []);
    case "plugin:sql|execute":
      return executeSql(await openDatabase(), String(args.query), args.values ?? []);
    case "plugin:sql|close":
      return true;

    /* ── event plugin ───────────────────────────────────────── */
    case "plugin:event|listen": {
      const event = String(args.event);
      const handler = Number(args.handler);
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
      return handler; // the rid unlisten() will hand back
    }
    case "plugin:event|unlisten":
      dropListener(String(args.event), Number(args.eventId));
      return undefined;
    case "plugin:event|emit":
    case "plugin:event|emit_to":
      emit(String(args.event), args.payload);
      return undefined;

    /* ── HQ's own Rust commands ─────────────────────────────── */
    case "check_tools":
      // codex deliberately absent: the setup UI has a "missing CLI" state and
      // it is worth being able to see it without uninstalling anything.
      return { gh: true, claude: true, codex: false };
    case "run_git":
      return runGit(args.args ?? [], String(args.cwd ?? ""));
    case "run_gh":
      return runGh(args.args ?? []);
    case "run_gh_in":
      return runGh(args.args ?? []);
    case "read_text_file":
      return readTextFile(String(args.root ?? ""), String(args.relativePath ?? ""));
    case "write_text_file":
      files.set(fileKey(String(args.root ?? ""), String(args.relativePath ?? "")), String(args.contents ?? ""));
      return undefined;
    case "start_agent_run":
      startAgentRun(String(args.runId), String(args.program ?? "claude"), String(args.prompt ?? ""));
      return undefined;
    case "cancel_agent_run":
      cancelAgentRun(String(args.runId));
      return undefined;

    /* ── interactive terminals ──────────────────────────────── */
    case "pty_spawn":
      return ptySpawn(args);
    case "pty_write":
      return ptyWrite(String(args.sessionId ?? ""), String(args.data ?? ""));
    case "pty_resize":
      return ptyResize(String(args.sessionId ?? ""), Number(args.cols), Number(args.rows));
    case "pty_kill":
      // Killing a terminal that already exited is not an error, same as Rust.
      ptyEnd(String(args.sessionId ?? ""), null);
      return undefined;

    /* ── project browser ────────────────────────────────────── */
    case "browser_open":
      return browserOpen(args);
    case "browser_bounds":
      return browserBounds(args);
    case "browser_visibility":
      return browserVisibility(String(args.label ?? ""), !!args.visible);
    case "browser_close":
      browsers.delete(String(args.label ?? ""));
      return undefined;
    case "browser_navigate":
      return browserNavigate(String(args.label ?? ""), String(args.url ?? ""));
    case "browser_action":
      return browserAction(String(args.label ?? ""), String(args.action ?? ""));
    case "browser_url":
      return liveBrowser(String(args.label ?? "")).url;

    /* ── plugins the app touches but doesn't need in a browser ─ */
    case "plugin:notification|is_permission_granted":
      return false;
    case "plugin:notification|request_permission":
      return "denied";
    case "plugin:dialog|open":
      // A folder picker with no OS behind it: hand back the demo checkout so
      // "add a project" is walkable instead of dead.
      return args.options?.directory ? ATLAS_PATH : null;
    case "plugin:opener|open_url":
    case "plugin:opener|open_path":
      window.open(String(args.path ?? args.url ?? ""), "_blank", "noopener");
      return undefined;

    default:
      if (!warned.has(cmd)) {
        warned.add(cmd);
        console.warn(`[devmock] unhandled command "${cmd}" — resolving undefined.`, args);
      }
      return undefined;
  }
}

/* ================================================================== *
 * files
 * ================================================================== */

const files = new Map<string, string>();

function fileKey(root: string, rel: string): string {
  return `${root} ${rel}`;
}

function readTextFile(root: string, rel: string): string {
  const hit = files.get(fileKey(root, rel));
  // blackboard.ts only treats this exact shape as "definitely absent"; any
  // other error means "don't touch that file".
  if (hit === undefined) throw `failed to read ${rel}: No such file or directory (os error 2)`;
  return hit;
}

/* ================================================================== *
 * canned git
 *
 * Enough of a repository to make the Git Activity, Workspaces and project
 * setup views render real-looking answers: one checkout on `main`, two agent
 * worktrees, eight commits of which the newest two have never been pushed.
 * ================================================================== */

const ATLAS_PATH = "/Users/dev/code/atlas";
const ORIGIN_URL = "git@github.com:acme/atlas.git";
const WORKSPACE_ROOT = `${ATLAS_PATH}/../.hq-workspaces/atlas-p-atla`;

interface FakeCommit {
  sha: string;
  author: string;
  /** epoch seconds, like git's %at */
  at: number;
  subject: string;
}

const T0 = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sec = (ms: number) => Math.floor(ms / 1000);

const COMMITS: FakeCommit[] = [
  { sha: "b41d7f2a9c0e5138a6d24bf70e9c3512d8a6f401", author: "Ada", at: sec(T0 - 40 * MIN), subject: "hq: pin the message list when the reader is scrolled up" },
  { sha: "3e9a1c84f7b25d0619ac83f4e2d715b0c9384a6d", author: "Iris", at: sec(T0 - 3 * HOUR), subject: "hq: move RunInspector's status colors onto theme tokens" },
  { sha: "7c2f508be3a94d16f0d7825ab41c9e360f5d28a1", author: "Lauren", at: sec(T0 - 9 * HOUR), subject: "chat: keep threads whole when the 500-message window cuts one" },
  { sha: "a05be3719d4c82f60a13e7b5928dc4f1036ea8b2", author: "Rune", at: sec(T0 - DAY - 2 * HOUR), subject: "api: paginate /v1/events, default page size 200" },
  { sha: "d63820c5ae179f4b0c85d3172ea9b640f8c2173e", author: "Pike", at: sec(T0 - 2 * DAY), subject: "ci: cache the cargo target dir between jobs" },
  { sha: "5f18d9a740e2b3c6081fa5d92e7c34b6019adf58", author: "Lauren", at: sec(T0 - 3 * DAY), subject: "themes: light variants for the six newest palettes" },
  { sha: "c9047e2b1a8d5306f47b9e0c2d1835af607be942", author: "Rune", at: sec(T0 - 5 * DAY), subject: "runs: record commit_before/commit_after so a turn is revertable" },
  { sha: "e2b6034d9f1a75c8e03b47ad812f9c650ba3d174", author: "Ada", at: sec(T0 - 8 * DAY), subject: "chat: thread panel, focus trap and all" },
];

/** The newest two exist only on this machine — that's the interesting case. */
const UNPUSHED = COMMITS.slice(0, 2);
const HEAD_SHA = COMMITS[0].sha;

const STATUS_MAIN = " M src/components/ChatView.tsx\n M src/components/chat.css\n?? src/components/ThreadPanel.tsx\n";
const STATUS_WORKSPACE = " M src/components/ChatView.tsx\n M src/components/RunInspector.tsx\n";

const SAMPLE_DIFF = `diff --git a/src/components/chat.css b/src/components/chat.css
index 4a1c2e9..8b7d013 100644
--- a/src/components/chat.css
+++ b/src/components/chat.css
@@ -142,6 +142,7 @@
 .chat-messages {
   overflow-y: auto;
+  overscroll-behavior: contain;
   scroll-padding-block-end: var(--fs-lg);
 }
`;

/** Render a commit through git's own %-escapes, so any --pretty= works. */
function formatCommit(fmt: string, c: FakeCommit): string {
  return fmt.replace(/%x([0-9a-fA-F]{2})|%(H|h|an|ae|at|ad|s)/g, (_m, hex: string, key: string) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    switch (key) {
      case "H": return c.sha;
      case "h": return c.sha.slice(0, 7);
      case "an": return c.author;
      case "ae": return `${c.author.toLowerCase()}@example.com`;
      case "at": return String(c.at);
      case "ad": return new Date(c.at * 1000).toISOString();
      default: return c.subject;
    }
  });
}

function gitFail(message: string): never {
  throw message;
}

function isWorkspace(cwd: string): boolean {
  return cwd.includes(".hq-workspaces");
}

function runGit(args: string[], cwd: string): string {
  const [cmd, ...rest] = args;
  const line = rest.join(" ");
  const has = (flag: string) => rest.includes(flag);

  switch (cmd) {
    case "rev-parse": {
      if (has("--is-inside-work-tree")) return "true\n";
      if (has("--show-toplevel")) return `${cwd || ATLAS_PATH}\n`;
      if (has("--git-dir")) return `${cwd || ATLAS_PATH}/.git\n`;
      if (has("MERGE_HEAD")) gitFail("fatal: Needed a single revision");
      if (has("@{u}")) return "origin/main\n";
      if (has("--abbrev-ref")) return `${isWorkspace(cwd) ? workspaceBranch(cwd) : "main"}\n`;
      return `${HEAD_SHA}\n`;
    }

    case "symbolic-ref":
      if (line.includes("refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      return `${isWorkspace(cwd) ? workspaceBranch(cwd) : "main"}\n`;

    case "remote":
      if (rest[0] === "get-url") return `${ORIGIN_URL}\n`;
      return "origin\n";

    case "branch": {
      if (has("--show-current")) return `${isWorkspace(cwd) ? workspaceBranch(cwd) : "main"}\n`;
      if (has("-r")) return ""; // --contains: nothing here is on a remote branch
      if (rest[0] === "--list") {
        const want = rest[1] ?? "";
        return want.startsWith("hq/") ? `  ${want}\n` : "";
      }
      return "";
    }

    case "log": {
      const fmt = rest.find((a) => a.startsWith("--pretty=format:"))?.slice("--pretty=format:".length) ?? "%H %s";
      // `log -g … --remotes` is the "when did we last fetch?" probe.
      if (has("-g")) return formatCommit(fmt, { ...COMMITS[2], at: sec(T0 - 6 * HOUR) });
      const nAt = rest.indexOf("-n");
      const limit = nAt >= 0 ? parseInt(rest[nAt + 1] ?? "", 10) || COMMITS.length : COMMITS.length;
      const localOnly = has("--remotes") || rest.some((a) => a.includes("..") && a.endsWith("HEAD"));
      const set = (localOnly ? UNPUSHED : COMMITS).slice(0, limit);
      return set.map((c) => formatCommit(fmt, c)).join("\n");
    }

    case "rev-list": {
      if (has("--left-right")) return "0\t2\n"; // behind \t ahead
      const range = rest.find((a) => a.includes(".."));
      if (range) return `${range.startsWith("origin/") ? 2 : 3}\n`;
      return `${UNPUSHED.length}\n`;
    }

    case "status":
      return isWorkspace(cwd) ? STATUS_WORKSPACE : STATUS_MAIN;

    case "worktree":
      if (rest[0] === "list") return worktreeList();
      return "";

    case "ls-files":
      if (line.includes(".claude/commands")) {
        return ".claude/commands/review.md\n.claude/commands/ship.md\n";
      }
      return "src/components/ThreadPanel.tsx\n";

    case "diff": {
      if (has("--diff-filter=U")) return ""; // never mid-conflict
      if (has("--name-only")) return "src/components/ChatView.tsx\nsrc/components/chat.css\n";
      if (has("--cached")) return "";
      if (has("--no-index")) return "";
      return SAMPLE_DIFF;
    }

    case "show":
      return has("--name-only") ? "src/components/chat.css\n" : SAMPLE_DIFF;

    case "commit":
      return `[main ${HEAD_SHA.slice(0, 7)}] ${rest[rest.indexOf("-m") + 1] ?? "commit"}\n 2 files changed, 14 insertions(+), 3 deletions(-)\n`;

    case "merge":
      if (has("--abort")) return "";
      return "Merge made by the 'ort' strategy.\n 3 files changed, 41 insertions(+), 12 deletions(-)\n";

    case "push":
      return `To ${ORIGIN_URL}\n * [new branch]      ${rest[rest.length - 1]} -> ${rest[rest.length - 1]}\n`;

    case "checkout":
      return `Switched to branch '${rest[rest.length - 1]}'\n`;

    case "cat-file":
    case "merge-base":
      return ""; // exit 0 == "yes, that object/ancestry exists"

    case "add":
    case "reset":
    case "clean":
    case "revert":
    case "init":
    case "config":
      return "";

    default:
      return "";
  }
}

/** "…/atlas-p-atla/ada-a-ada" -> "hq/ada-a-ada", matching workspaces.ts. */
function workspaceBranch(cwd: string): string {
  const leaf = cwd.replace(/\/+$/, "").split("/").pop() ?? "";
  return `hq/${leaf}`;
}

function worktreeList(): string {
  const blocks = [`worktree ${ATLAS_PATH}\nHEAD ${HEAD_SHA}\nbranch refs/heads/main\n`];
  for (const [i, leaf] of ["ada-a-ada", "iris-a-iris"].entries()) {
    blocks.push(`worktree ${WORKSPACE_ROOT}/${leaf}\nHEAD ${COMMITS[i].sha}\nbranch refs/heads/hq/${leaf}\n`);
  }
  return blocks.join("\n");
}

/* ================================================================== *
 * canned gh
 * ================================================================== */

const GH_REPOS = [
  { name: "atlas", nameWithOwner: "acme/atlas", description: "Customer-facing web app", updatedAt: new Date(T0 - 40 * MIN).toISOString(), isPrivate: true, primaryLanguage: { name: "TypeScript" } },
  { name: "atlas-api", nameWithOwner: "acme/atlas-api", description: "Rust API behind Atlas", updatedAt: new Date(T0 - 2 * DAY).toISOString(), isPrivate: true, primaryLanguage: { name: "Rust" } },
  { name: "field-notes", nameWithOwner: "acme/field-notes", description: "Research transcripts and synthesis", updatedAt: new Date(T0 - 6 * DAY).toISOString(), isPrivate: true, primaryLanguage: null },
  { name: "hq", nameWithOwner: "acme/hq", description: "This app", updatedAt: new Date(T0 - 11 * HOUR).toISOString(), isPrivate: false, primaryLanguage: { name: "TypeScript" } },
];

const GH_MY_PRS = [
  { number: 128, title: "Pin the message list when the reader is scrolled up", url: "https://github.com/acme/atlas/pull/128", updatedAt: new Date(T0 - 35 * MIN).toISOString(), isDraft: false, headRefName: "hq/ada-a-ada", author: { login: "lauren" }, repository: { nameWithOwner: "acme/atlas" } },
  { number: 126, title: "Theme tokens for every run status", url: "https://github.com/acme/atlas/pull/126", updatedAt: new Date(T0 - 5 * HOUR).toISOString(), isDraft: true, headRefName: "hq/iris-a-iris", author: { login: "lauren" }, repository: { nameWithOwner: "acme/atlas" } },
  { number: 41, title: "Backfill event.actor_id", url: "https://github.com/acme/atlas-api/pull/41", updatedAt: new Date(T0 - 2 * DAY).toISOString(), isDraft: false, headRefName: "backfill-actor-id", author: { login: "lauren" }, repository: { nameWithOwner: "acme/atlas-api" } },
];

const GH_REVIEW_REQUESTS = [
  { number: 129, title: "Paginate /v1/events", url: "https://github.com/acme/atlas/pull/129", updatedAt: new Date(T0 - 90 * MIN).toISOString(), isDraft: false, headRefName: "hq/rune-a-rune", author: { login: "rune-bot" }, repository: { nameWithOwner: "acme/atlas" } },
  { number: 130, title: "Cache the cargo target dir", url: "https://github.com/acme/atlas/pull/130", updatedAt: new Date(T0 - 26 * HOUR).toISOString(), isDraft: false, headRefName: "ci/cargo-cache", author: { login: "pike-bot" }, repository: { nameWithOwner: "acme/atlas" } },
];

const GH_ISSUES = [
  { number: 131, title: "1.4.0 release checklist", url: "https://github.com/acme/atlas/issues/131", updatedAt: new Date(T0 - 4 * HOUR).toISOString(), author: { login: "lauren" } },
  { number: 127, title: "Thread panel traps focus on Escape", url: "https://github.com/acme/atlas/issues/127", updatedAt: new Date(T0 - DAY).toISOString(), author: { login: "iris-bot" } },
  { number: 119, title: "Workspace merge is flaky under concurrent runs", url: "https://github.com/acme/atlas/issues/119", updatedAt: new Date(T0 - 7 * DAY).toISOString(), author: { login: "rune-bot" } },
];

function runGh(args: string[]): string {
  const [cmd, sub] = args;
  const line = args.join(" ");

  if (cmd === "repo" && sub === "list") return JSON.stringify(GH_REPOS);
  if (cmd === "repo" && sub === "create") {
    return `✓ Created repository ${args[2] ?? "acme/new"} on GitHub\nhttps://github.com/${args[2] ?? "acme/new"}\n`;
  }
  if (cmd === "search" && sub === "prs") {
    return JSON.stringify(line.includes("--review-requested") ? GH_REVIEW_REQUESTS : GH_MY_PRS);
  }
  if (cmd === "pr" && sub === "list") {
    const repo = args[args.indexOf("--repo") + 1] ?? "acme/atlas";
    return JSON.stringify([...GH_MY_PRS, ...GH_REVIEW_REQUESTS].filter((p) => p.repository.nameWithOwner === repo));
  }
  if (cmd === "pr" && sub === "create") return "https://github.com/acme/atlas/pull/132\n";
  if (cmd === "issue" && sub === "list") return JSON.stringify(GH_ISSUES);
  if (cmd === "auth" && sub === "status") return "github.com\n  ✓ Logged in to github.com account lauren\n";
  return "";
}

/* ================================================================== *
 * simulated agent runs
 *
 * The payload shape is exactly what agents.ts listens for:
 *   { runId, kind: "line" | "stderr" | "done" | "error", data, exitCode }
 * and each "line" is one JSON object of the harness's own stream format, so
 * the real adapter (claudeAdapter / codexAdapter) parses it unchanged.
 * ================================================================== */

interface RunStep {
  /** ms after the run starts */
  at: number;
  kind: "line" | "stderr" | "done";
  data: string;
}

const runTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

function startAgentRun(runId: string, program: string, prompt: string): void {
  const script = program === "codex" ? codexScript(prompt) : claudeScript(runId, prompt);
  const timers: ReturnType<typeof setTimeout>[] = [];
  runTimers.set(runId, timers);
  for (const step of script) {
    timers.push(
      setTimeout(() => {
        if (!runTimers.has(runId)) return; // cancelled
        if (step.kind === "done") {
          runTimers.delete(runId);
          emit("agent-event", { runId, kind: "done", data: "", exitCode: 0 });
        } else {
          emit("agent-event", { runId, kind: step.kind, data: step.data, exitCode: null });
        }
      }, step.at)
    );
  }
}

function cancelAgentRun(runId: string): void {
  for (const t of runTimers.get(runId) ?? []) clearTimeout(t);
  runTimers.delete(runId);
}

/**
 * Echo what was actually asked, so a canned reply still reads as a reply.
 * Scanned backwards for the last "[Speaker]: …" line rather than taking the
 * final line — on a resume the collaboration block is appended after it.
 */
function askOf(prompt: string): string {
  const lines = prompt.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\[[^\]]+\]:\s*(.+)$/.exec(lines[i].trim());
    if (m) return m[1].replace(/\s+/g, " ").trim().slice(0, 110);
  }
  return "that";
}

function claudeScript(runId: string, prompt: string): RunStep[] {
  const sid = `dev-${runId.slice(0, 8)}`;
  const j = (o: unknown) => JSON.stringify(o);
  const text = (t: string) => j({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const tool = (name: string, input: unknown) =>
    j({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_${name}`, name, input }] } });

  return [
    { at: 150, kind: "line", data: j({ type: "system", subtype: "init", session_id: sid, model: "claude-opus-4-6", cwd: ATLAS_PATH }) },
    { at: 700, kind: "line", data: tool("Read", { file_path: "src/components/ChatView.tsx" }) },
    { at: 1500, kind: "line", data: tool("Grep", { pattern: "scrollIntoView", path: "src" }) },
    { at: 2400, kind: "line", data: tool("Edit", { file_path: "src/components/chat.css", old_string: "overflow-y: auto;", new_string: "overflow-y: auto;\n  overscroll-behavior: contain;" }) },
    { at: 3200, kind: "line", data: text(`**${askOf(prompt)}** — here's where that lands.`) },
    {
      at: 4100,
      kind: "line",
      data: text(
        "- the auto-scroll effect has no *was the reader already at the bottom?* guard\n" +
          "- `patchMessageLocal` fires on **every streamed token**, so a live run re-triggers it dozens of times a second\n" +
          "- `overflow-y: auto` with no `overscroll-behavior` lets a trackpad flick escape to the window"
      ),
    },
    {
      at: 5000,
      kind: "line",
      data: text(
        "Smallest honest fix is one line of CSS plus a ref:\n\n" +
          "```diff\n-  useEffect(() => { end.current?.scrollIntoView(); }, [messages]);\n" +
          "+  useEffect(() => {\n+    if (atBottom.current) end.current?.scrollIntoView({ block: \"end\" });\n+  }, [messages]);\n```\n\n" +
          "Changed `src/components/chat.css` and `src/components/ChatView.tsx`. Worth a look before I open a PR — the height-delta pinning is the part most likely to be wrong on a window resize."
      ),
    },
    { at: 5700, kind: "line", data: j({ type: "result", subtype: "success", session_id: sid, result: "", num_turns: 4, total_cost_usd: 0.0413, duration_ms: 5700 }) },
    { at: 5900, kind: "done", data: "" },
  ];
}

function codexScript(prompt: string): RunStep[] {
  const j = (o: unknown) => JSON.stringify(o);
  const message = (t: string) => j({ type: "item.completed", item: { type: "agent_message", text: t } });

  return [
    { at: 150, kind: "line", data: j({ type: "thread.started", thread_id: "01JDEVMOCKTHREAD0001" }) },
    { at: 600, kind: "line", data: j({ type: "item.started", item: { type: "command_execution", command: "rg -n 'overscroll' src" } }) },
    { at: 1400, kind: "line", data: j({ type: "item.completed", item: { type: "command_execution", command: "rg -n 'overscroll' src", exit_code: 1 } }) },
    { at: 1900, kind: "line", data: j({ type: "item.completed", item: { type: "reasoning", summary: "Locating the scroll owner" } }) },
    { at: 2600, kind: "line", data: j({ type: "item.completed", item: { type: "file_change", changes: { "src/components/chat.css": { kind: "modify" } } } }) },
    { at: 3000, kind: "stderr", data: "warning: sandbox denied write outside the workspace: /etc/hosts" },
    { at: 3600, kind: "line", data: message(`On **${askOf(prompt)}**: the scroll container owns this, not the message component.`) },
    {
      at: 4800,
      kind: "line",
      data: message(
        "Applied two changes:\n\n" +
          "1. `src/components/chat.css` — added `overscroll-behavior: contain`\n" +
          "2. `src/components/ChatView.tsx` — auto-scroll only while the reader is pinned to the bottom\n\n" +
          "`cargo test` and `npm run build` both pass locally. Nothing touched under `src/generated`."
      ),
    },
    { at: 5500, kind: "line", data: j({ type: "turn.completed", usage: { input_tokens: 18342, output_tokens: 711 } }) },
    { at: 5800, kind: "done", data: "" },
  ];
}

/* ================================================================== *
 * interactive terminals
 *
 * src/pty.ts is the contract and it is exact: two *global* events, fanned
 * out by session id,
 *     pty-output  { sessionId, data }       decoded text, never bytes
 *     pty-exit    { sessionId, exitCode }   exitCode may be null
 * plus four commands whose errors are plain strings, as Rust returns them.
 *
 * Behind them sits the smallest shell that can prove a pane works end to
 * end: a prompt, an echo of every keystroke (a pty has ECHO on, so the
 * echo is the pty's job, not the pane's), a few builtins, and a visible
 * answer to pty_resize.
 *
 * The spawn banner prints the cols x rows it was asked for. That is the
 * number a collapsed layout gets wrong, and TerminalPane clamps it to
 * 20x4 — so a pane with no height says so on its own first line instead
 * of just sitting there looking broken.
 * ================================================================== */

interface FakePty {
  cols: number;
  rows: number;
  cwd: string;
  /** program + args, as the pane shows it in its toolbar. */
  command: string;
  /** Typed but not yet submitted. */
  line: string;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const ptys = new Map<string, FakePty>();

/** Real SGR codes, so the pane's ANSI parser is exercised rather than bypassed. */
const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function ptyOut(sessionId: string, data: string): void {
  emit("pty-output", { sessionId, data });
}

/** Output a beat later, cancellable — a killed terminal must go quiet at once. */
function ptyLater(sessionId: string, session: FakePty, ms: number, data: string): void {
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    if (ptys.get(sessionId) === session) ptyOut(sessionId, data);
  }, ms);
  session.timers.add(timer);
}

function ptyPrompt(session: FakePty): string {
  const leaf = session.cwd.replace(/\/+$/, "").split("/").pop() || "/";
  return `${SGR.green}${leaf}${SGR.reset} ${SGR.dim}%${SGR.reset} `;
}

function livePty(sessionId: string): FakePty {
  const session = ptys.get(sessionId);
  if (!session) throw `no terminal is running for session ${sessionId}`;
  return session;
}

function ptySpawn(args: Record<string, any>): undefined {
  const sessionId = String(args.sessionId ?? "");
  if (!sessionId.trim()) throw "a terminal needs a session id";
  const program = String(args.program ?? "");
  if (!program.trim()) throw "no program given to run in the terminal";

  // Reusing a live id replaces what was on it, exactly as spawn_pty_blocking
  // does, so a double-mounted pane cannot leave an orphan behind.
  if (ptys.has(sessionId)) ptyEnd(sessionId, null);

  const cols = Math.max(1, Math.round(Number(args.cols)) || 80);
  const rows = Math.max(1, Math.round(Number(args.rows)) || 24);
  const argv: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
  const session: FakePty = {
    cols,
    rows,
    cwd: String(args.cwd ?? "") || "/",
    command: [program, ...argv].join(" "),
    line: "",
    timers: new Set(),
  };
  ptys.set(sessionId, session);

  // A real pty's first bytes land after the invoke has resolved. Keeping that
  // ordering is what makes pty.ts's early-output buffering worth anything.
  ptyLater(
    sessionId,
    session,
    60,
    `${SGR.dim}devmock pty — no Tauri behind this one${SGR.reset}\r\n` +
      `${SGR.cyan}${session.command}${SGR.reset}\r\n` +
      `${SGR.dim}cwd  ${session.cwd}${SGR.reset}\r\n` +
      `${SGR.dim}size ${cols}x${rows}${SGR.reset}\r\n` +
      `${SGR.dim}type \`help\` for the builtins${SGR.reset}\r\n\r\n` +
      ptyPrompt(session)
  );
  return undefined;
}

function ptyWrite(sessionId: string, data: string): undefined {
  const session = livePty(sessionId);
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === "\x1b") {
      // Arrows, Home/End, Delete. A real shell acts on these; this one only
      // has to not echo them back as garbage.
      i += 1;
      if (data[i] === "[" || data[i] === "O") {
        i += 1;
        while (i < data.length && (data[i] < "\x40" || data[i] > "\x7e")) i += 1;
        i += 1;
      }
      continue;
    }
    i += 1;
    if (ch === "\r" || ch === "\n") {
      const line = session.line;
      session.line = "";
      ptyOut(sessionId, "\r\n");
      ptyRun(sessionId, session, line.trim());
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      if (!session.line) continue;
      session.line = session.line.slice(0, -1);
      ptyOut(sessionId, "\b \b");
      continue;
    }
    if (ch === "\x03") {
      session.line = "";
      ptyOut(sessionId, `${SGR.dim}^C${SGR.reset}\r\n${ptyPrompt(session)}`);
      continue;
    }
    if (ch === "\x04") {
      // EOF only on an empty line, like a shell — otherwise Ctrl+D is a no-op.
      if (session.line) continue;
      ptyOut(sessionId, "\r\n");
      ptyEnd(sessionId, 0);
      return undefined;
    }
    if (ch < " ") continue;
    session.line += ch;
    ptyOut(sessionId, ch);
  }
  return undefined;
}

function ptyRun(sessionId: string, session: FakePty, line: string): void {
  const [cmd, ...rest] = line.split(/\s+/).filter(Boolean);
  const reply = (text: string) => ptyLater(sessionId, session, 40, text + ptyPrompt(session));

  switch (cmd) {
    case undefined:
      return reply("");
    case "help":
      return reply(
        `${SGR.bold}devmock shell${SGR.reset}\r\n` +
          "  help    this list\r\n" +
          "  pwd     working directory\r\n" +
          "  ls      a few plausible files\r\n" +
          "  size    the cols x rows this pty was last told about\r\n" +
          "  echo    print the rest of the line\r\n" +
          "  colors  one row of SGR, to check the theme mapping\r\n" +
          "  clear   erase the screen (CSI 3 J)\r\n" +
          "  exit    end the session\r\n"
      );
    case "pwd":
      return reply(`${session.cwd}\r\n`);
    case "ls":
      return reply("Cargo.toml   README.md   package.json   src   src-tauri\r\n");
    case "size":
      return reply(`${session.cols}x${session.rows}\r\n`);
    case "echo":
      return reply(`${rest.join(" ")}\r\n`);
    case "colors":
      return reply(
        [31, 32, 33, 34, 35, 36].map((c) => `\x1b[${c}m ${c} ${SGR.reset}`).join("") + "\r\n"
      );
    case "clear":
      return reply("\x1b[H\x1b[3J");
    case "exit": {
      ptyOut(sessionId, `${SGR.dim}exit${SGR.reset}\r\n`);
      const timer = setTimeout(() => ptyEnd(sessionId, 0), 60);
      session.timers.add(timer);
      return;
    }
    default:
      return reply(`${SGR.yellow}devmock: command not found: ${cmd}${SGR.reset}\r\n`);
  }
}

function ptyResize(sessionId: string, cols: number, rows: number): undefined {
  const session = livePty(sessionId);
  const next = { cols: Math.max(1, Math.round(cols) || 1), rows: Math.max(1, Math.round(rows) || 1) };
  if (next.cols === session.cols && next.rows === session.rows) return undefined;
  session.cols = next.cols;
  session.rows = next.rows;
  // A real shell redraws on SIGWINCH without saying so. This one says so:
  // making the geometry the pane computed visible, without a debugger, is the
  // entire reason the harness exists.
  ptyOut(
    sessionId,
    `\r\n${SGR.dim}[SIGWINCH ${next.cols}x${next.rows}]${SGR.reset}\r\n` +
      ptyPrompt(session) +
      session.line
  );
  return undefined;
}

/**
 * End a session and announce it. Rust emits pty-exit for a killed terminal too
 * — the waiter thread cannot tell a SIGHUP from a clean exit — so this does the
 * same rather than staying quiet on pty_kill.
 */
function ptyEnd(sessionId: string, exitCode: number | null): void {
  const session = ptys.get(sessionId);
  if (!session) return;
  for (const timer of session.timers) clearTimeout(timer);
  ptys.delete(sessionId);
  emit("pty-exit", { sessionId, exitCode });
}

/* ================================================================== *
 * project browser
 *
 * A child webview is the one thing a browser tab genuinely cannot fake, so
 * these are inert: they keep the state the pane asks about (address,
 * visibility, the rectangle it last placed) and resolve. What they do not do
 * is fail — a rejection here would have BrowserPane paint an error banner
 * that says nothing about the app.
 *
 * The validation mirrors lib.rs exactly, including the label prefix and the
 * http/https-only rule, because those are the errors the real pane has to
 * survive. `__hqdev.browsers` shows the rects it has been handed.
 * ================================================================== */

interface FakeBrowser {
  url: string;
  visible: boolean;
  /** The last rectangle browser_bounds was given, in CSS pixels. */
  bounds: { x: number; y: number; width: number; height: number };
}

const browsers = new Map<string, FakeBrowser>();

function browserHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (e) {
    throw `invalid browser address: ${String(e)}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw "HQ's browser opens http and https addresses only";
  }
  return url.toString();
}

function liveBrowser(label: string): FakeBrowser {
  if (!label.startsWith("hq-browser-")) throw "not an HQ project browser";
  const browser = browsers.get(label);
  if (!browser) throw `project browser ${label} is not open`;
  return browser;
}

function rectOf(args: Record<string, any>) {
  return {
    x: Number(args.x) || 0,
    y: Number(args.y) || 0,
    width: Math.max(1, Number(args.width) || 1),
    height: Math.max(1, Number(args.height) || 1),
  };
}

function browserOpen(args: Record<string, any>): undefined {
  const label = String(args.label ?? "");
  if (!label.startsWith("hq-browser-")) throw "not an HQ project browser";
  const bounds = rectOf(args);
  browsers.set(label, { url: browserHttpUrl(String(args.url ?? "")), visible: true, bounds });
  console.info(
    `[devmock] browser_open ${label} at ${Math.round(bounds.width)}x${Math.round(bounds.height)} ` +
      `(${Math.round(bounds.x)}, ${Math.round(bounds.y)})`
  );
  return undefined;
}

function browserBounds(args: Record<string, any>): undefined {
  liveBrowser(String(args.label ?? "")).bounds = rectOf(args);
  return undefined;
}

function browserVisibility(label: string, visible: boolean): undefined {
  liveBrowser(label).visible = visible;
  return undefined;
}

function browserNavigate(label: string, url: string): string {
  const target = browserHttpUrl(url);
  liveBrowser(label).url = target;
  return target;
}

function browserAction(label: string, action: string): undefined {
  liveBrowser(label);
  if (!["back", "forward", "reload"].includes(action)) {
    throw `unknown browser action: ${action}`;
  }
  return undefined;
}

/* ================================================================== *
 * seed data
 *
 * Mirrors src/db.ts exactly: the base schema with the v2/v3 columns folded
 * in, the v4 graph tables, and user_version stamped at 4 so getDb() runs no
 * migrations over it.
 * ================================================================== */

const SEED_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  isolate INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '');
CREATE TABLE channels (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  chaining INTEGER NOT NULL DEFAULT 1, charter TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'lead', lead_agent_id TEXT NOT NULL DEFAULT '');
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '', cli_args TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '', owns TEXT NOT NULL DEFAULT '',
  -- Ownership and avatars arrive by ALTER TABLE in later migrations, but the
  -- seed below writes them, and seeding runs before getDb() migrates anything.
  -- Same defaults as db.ts, so a migration that would break in the real app
  -- still breaks here.
  avatar TEXT NOT NULL DEFAULT '', owner_member_id TEXT NOT NULL DEFAULT '',
  host_device_id TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'workspace');
CREATE TABLE teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, charter TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '');
CREATE TABLE team_members (team_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (team_id, agent_id));
CREATE TABLE channel_members (
  channel_id TEXT NOT NULL, member_type TEXT NOT NULL, member_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, member_type, member_id));
CREATE TABLE messages (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_type TEXT NOT NULL,
  author_id TEXT NOT NULL DEFAULT '', author_name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done', meta TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '');
CREATE INDEX idx_messages_channel ON messages (channel_id, created_at);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
  assignee_agent_id TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  last_run_id TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '');
CREATE TABLE memory (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running', session_id TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '', activity TEXT NOT NULL DEFAULT '[]', cwd TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL DEFAULT 0,
  commit_before TEXT NOT NULL DEFAULT '', commit_after TEXT NOT NULL DEFAULT '',
  files_changed TEXT NOT NULL DEFAULT '',
  -- Seeding happens before getDb() runs any migration, so columns the seed
  -- rows carry must exist here even though v4/v5 would add them later.
  transcript TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '', command TEXT NOT NULL DEFAULT '');
CREATE TABLE agent_sessions (
  channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (channel_id, agent_id));
CREATE TABLE channel_reads (channel_id TEXT PRIMARY KEY, last_read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE queue (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_queue_target ON queue (channel_id, agent_id, created_at);
CREATE TABLE links (
  id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL,
  to_type TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'relates',
  note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
CREATE INDEX idx_links_from ON links (from_type, from_id);
CREATE INDEX idx_links_to ON links (to_type, to_id);
CREATE UNIQUE INDEX idx_links_uniq ON links (from_type, from_id, to_type, to_id, kind);
CREATE TABLE assignments (
  id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL);
CREATE INDEX idx_assign_target ON assignments (target_type, target_id);
CREATE INDEX idx_assign_subject ON assignments (subject_type, subject_id);
CREATE UNIQUE INDEX idx_assign_uniq ON assignments (subject_type, subject_id, target_type, target_id, role);

-- The desktop refuses to render until it is paired with a web workspace, so
-- the harness arrives pre-paired against an address nothing will ever answer.
-- Sync failures are swallowed by design, which is exactly the behaviour we
-- want here: local rows, no network.
CREATE TABLE portal_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL, device_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, token TEXT NOT NULL, device_name TEXT NOT NULL,
  paired_at INTEGER NOT NULL, last_sync_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paired', last_error TEXT NOT NULL DEFAULT '');
INSERT INTO portal_connection
  (id, base_url, device_id, workspace_id, token, device_name, paired_at, last_sync_at, status, last_error)
VALUES (1, 'http://127.0.0.1:9', 'dev-device', 'dev-workspace', 'dev-token', 'Dev browser', 0, 0, 'paired', '');

-- Stamped at 3, not at the newest version: everything above is the v2/v3-era
-- schema, so letting getDb() run migrations 4 onwards is what keeps this
-- harness honest. It picks up run transcripts, launch context, reactions,
-- documents, calendars and the rest without this file having to restate them,
-- and a migration that would break in the real app breaks here too.
PRAGMA user_version = 3;
`;

/** YYYY-MM-DD, `days` from today — due dates that stay plausible forever. */
function due(days: number): string {
  return new Date(T0 + days * DAY).toISOString().slice(0, 10);
}

function insert(db: SqlDatabase, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`;
  db.run(sql, bindMap(keys.map((k) => row[k])));
}

function seed(db: SqlDatabase): void {
  for (const stmt of SEED_SCHEMA.split(";")) {
    if (stmt.trim()) db.run(stmt);
  }

  const projects: Project[] = [
    {
      id: "p-atlas", name: "Atlas",
      description: "The customer-facing web app — React client, Rust API, one repo.",
      repo: "acme/atlas", local_path: ATLAS_PATH, isolate: 1,
      instructions:
        "Ship behind a flag. Never edit src/generated — it comes from the schema. Every change needs a test or an explicit reason there isn't one.",
      created_at: T0 - 90 * DAY,
    },
    {
      id: "p-notes", name: "Field Notes",
      description: "Customer research: interviews, transcripts, and what we concluded from them. No code in here.",
      repo: "", local_path: "", isolate: 0,
      instructions: "Quote participants verbatim. Never invent a number — if we didn't measure it, say so.",
      created_at: T0 - 24 * DAY,
    },
  ];

  const channels: Channel[] = [
    { id: "c-general", project_id: "p-atlas", name: "general", topic: "Anything Atlas.", chaining: 1, charter: "", mode: "broadcast", lead_agent_id: "", created_at: T0 - 90 * DAY },
    {
      id: "c-frontend", project_id: "p-atlas", name: "frontend", topic: "The web client — components, theming, chat.",
      chaining: 1,
      charter: "Front-end work on Atlas. Ada leads: she triages, delegates and reports back. Design-system questions go to Iris.",
      mode: "lead", lead_agent_id: "a-ada", created_at: T0 - 62 * DAY,
    },
    { id: "c-releases", project_id: "p-atlas", name: "releases", topic: "Cutting builds, CI, and what's blocking the next tag.", chaining: 1, charter: "Nothing ships from here without a green pipeline and a changelog entry.", mode: "broadcast", lead_agent_id: "a-pike", created_at: T0 - 40 * DAY },
    { id: "c-ideas", project_id: "p-notes", name: "ideas", topic: "Half-formed things, kept on purpose.", chaining: 0, charter: "", mode: "broadcast", lead_agent_id: "", created_at: T0 - 24 * DAY },
    { id: "c-research", project_id: "p-notes", name: "research", topic: "Interview synthesis and the evidence behind it.", chaining: 1, charter: "Answer as a panel: independent readings first, then Juno merges them.", mode: "panel", lead_agent_id: "a-juno", created_at: T0 - 20 * DAY },
  ];

  const agents: Agent[] = [
    { id: "a-ada", name: "Ada", kind: "claude", model: "opus", role: "Frontend", owns: "src/components, src/App.css", persona: "Reads the code before answering. Prefers the smallest change that actually fixes the cause, and says out loud which part of a fix she is least sure about.", avatar: "", owner_member_id: "", host_device_id: "", visibility: "workspace", cli_args: "--permission-mode acceptEdits", created_at: T0 - 62 * DAY },
    { id: "a-rune", name: "Rune", kind: "codex", model: "gpt-5-codex", role: "Backend", owns: "api/, migrations/", persona: "Blunt about data shapes. Will not write a migration without saying what it costs on the biggest table.", avatar: "", owner_member_id: "", host_device_id: "", visibility: "workspace", cli_args: "--sandbox workspace-write", created_at: T0 - 58 * DAY },
    { id: "a-iris", name: "Iris", kind: "claude", model: "sonnet", role: "Design systems", owns: "themes, tokens, RunInspector", persona: "Guards the token vocabulary. Treats a literal hex in a component as a bug report, not a preference.", avatar: "", owner_member_id: "", host_device_id: "", visibility: "workspace", cli_args: "", created_at: T0 - 41 * DAY },
    { id: "a-pike", name: "Pike", kind: "codex", model: "gpt-5-codex", role: "Release / CI", owns: ".github/workflows, scripts/", persona: "Owns the pipeline. Answers 'can we ship?' with a list, never a vibe.", avatar: "", owner_member_id: "", host_device_id: "", visibility: "workspace", cli_args: "--sandbox read-only", created_at: T0 - 33 * DAY },
    { id: "a-juno", name: "Juno", kind: "ritz", model: "qwen3-30b-a3b", role: "Research", owns: "interview synthesis", persona: "Runs on the local engine, so it stays on this machine. Never paraphrases a participant when a quote will do.", avatar: "", owner_member_id: "", host_device_id: "", visibility: "workspace", cli_args: "", created_at: T0 - 20 * DAY },
  ];

  const teams: Team[] = [
    { id: "tm-core", name: "Core", description: "Keeps Atlas shipping.", charter: "Small, reviewable changes. If something needs a migration, raise it before writing it.", avatar: "", created_at: T0 - 55 * DAY },
    { id: "tm-studio", name: "Studio", description: "Research and design systems.", charter: "Show the evidence. A recommendation with no quote and no number is a guess.", avatar: "", created_at: T0 - 20 * DAY },
  ];

  const teamMembers: TeamMember[] = [
    { team_id: "tm-core", agent_id: "a-ada" },
    { team_id: "tm-core", agent_id: "a-rune" },
    { team_id: "tm-core", agent_id: "a-pike" },
    { team_id: "tm-studio", agent_id: "a-iris" },
    { team_id: "tm-studio", agent_id: "a-juno" },
  ];

  const channelMembers: ChannelMember[] = [
    { channel_id: "c-general", member_type: "team", member_id: "tm-core" },
    { channel_id: "c-frontend", member_type: "agent", member_id: "a-ada" },
    { channel_id: "c-frontend", member_type: "agent", member_id: "a-iris" },
    { channel_id: "c-releases", member_type: "agent", member_id: "a-pike" },
    { channel_id: "c-releases", member_type: "agent", member_id: "a-rune" },
    { channel_id: "c-ideas", member_type: "agent", member_id: "a-juno" },
    { channel_id: "c-research", member_type: "team", member_id: "tm-studio" },
  ];

  const tasks: Task[] = [
    { id: "t-scroll", project_id: "p-atlas", title: "Message list jumps to the bottom mid-scroll", description: "Reading back through a channel while a run streams yanks you to the newest message. The auto-scroll effect has no 'reader is pinned to the bottom' guard.", status: "doing", assignee_agent_id: "a-ada", due_date: due(2), sort_order: 0, branch: "hq/ada/message-list-jumps-to-the-bottom", last_run_id: "m-f2", created_at: T0 - 3 * DAY },
    { id: "t-thread", project_id: "p-atlas", title: "Thread panel: keyboard nav and a real focus trap", description: "Escape closes the panel but focus is left on a detached node. Needs a roving tabindex over replies too.", status: "todo", assignee_agent_id: "a-ada", due_date: due(5), sort_order: 1, branch: "", last_run_id: "", created_at: T0 - 6 * DAY },
    { id: "t-tokens", project_id: "p-atlas", title: "Move the last six hardcoded hexes onto theme tokens", description: "RunInspector still paints status colors literally, so five of the light themes read as broken.", status: "doing", assignee_agent_id: "a-iris", due_date: due(1), sort_order: 2, branch: "hq/iris/theme-tokens", last_run_id: "m-f4", created_at: T0 - 4 * DAY },
    { id: "t-contrast", project_id: "p-atlas", title: "Audit contrast across all fourteen themes", description: "Text on --bg-inset fails AA in at least three light themes. Needs a measured pass, not an eyeball one.", status: "todo", assignee_agent_id: "a-iris", due_date: due(9), sort_order: 3, branch: "", last_run_id: "", created_at: T0 - 4 * DAY },
    { id: "t-api", project_id: "p-atlas", title: "Paginate /v1/events — it returns 40k rows", description: "Default page size 200, cursor on (created_at, id). The client already ignores everything past the first screen.", status: "doing", assignee_agent_id: "a-rune", due_date: due(3), sort_order: 4, branch: "hq/rune/paginate-events", last_run_id: "", created_at: T0 - 7 * DAY },
    { id: "t-migrate", project_id: "p-atlas", title: "Backfill migration for event.actor_id", description: "Two million rows. Needs to run in batches with a resumable cursor — a single UPDATE locks the table for minutes.", status: "backlog", assignee_agent_id: "a-rune", due_date: "", sort_order: 5, branch: "", last_run_id: "", created_at: T0 - 9 * DAY },
    { id: "t-ci", project_id: "p-atlas", title: "CI: cache the cargo target dir between jobs", description: "Cold builds were eating eleven minutes per run.", status: "done", assignee_agent_id: "a-pike", due_date: due(-3), sort_order: 6, branch: "ci/cargo-cache", last_run_id: "", created_at: T0 - 12 * DAY },
    { id: "t-release", project_id: "p-atlas", title: "Cut 1.4.0", description: "Blocked on the scroll fix and the token pass landing together — the release notes claim both.", status: "todo", assignee_agent_id: "a-pike", due_date: due(6), sort_order: 7, branch: "", last_run_id: "", created_at: T0 - 5 * DAY },
    { id: "t-flake", project_id: "p-atlas", title: "Flaky test: workspace merge under concurrent runs", description: "Fails roughly one run in nine. Suspect two agents merging into the main checkout in the same second.", status: "backlog", assignee_agent_id: "", due_date: "", sort_order: 8, branch: "", last_run_id: "", created_at: T0 - 14 * DAY },
    { id: "t-onboard", project_id: "p-atlas", title: "First run should not be an empty app", description: "New installs land on a blank dashboard. Seed a demo project, or offer to.", status: "backlog", assignee_agent_id: "a-ada", due_date: "", sort_order: 9, branch: "", last_run_id: "", created_at: T0 - 16 * DAY },
    { id: "t-latency", project_id: "p-atlas", title: "Trim first-token latency on the run stream", description: "Was 2.1s to first visible token; the prompt builder was re-reading memory per turn.", status: "done", assignee_agent_id: "a-rune", due_date: due(-8), sort_order: 10, branch: "", last_run_id: "", created_at: T0 - 21 * DAY },
    { id: "t-synth", project_id: "p-notes", title: "Synthesize the nine onboarding interviews", description: "Looking for what they agree on, not for the loudest quote.", status: "doing", assignee_agent_id: "a-juno", due_date: due(4), sort_order: 11, branch: "", last_run_id: "m-r2", created_at: T0 - 11 * DAY },
    { id: "t-quotes", project_id: "p-notes", title: "Quote bank for the pricing page", description: "Six verbatim quotes, attributed by role and company size, cleared for use.", status: "todo", assignee_agent_id: "a-juno", due_date: due(7), sort_order: 12, branch: "", last_run_id: "", created_at: T0 - 8 * DAY },
    { id: "t-recruit", project_id: "p-notes", title: "Recruit five more admins for round two", description: "Round one skewed heavily to solo users; the admin story is unevidenced.", status: "backlog", assignee_agent_id: "", due_date: "", sort_order: 13, branch: "", last_run_id: "", created_at: T0 - 6 * DAY },
  ];

  const memory: MemoryEntry[] = [
    { id: "mem-scroll", project_id: "p-atlas", kind: "decision", title: "Scroll anchoring belongs to the list, not the message", content: "Every attempt to fix jumping inside the message component has failed, because a message cannot know whether the reader is pinned to the bottom. The scroll container owns that state: it tracks `atBottom` on scroll, and auto-scroll is conditional on it. New message types inherit the behaviour for free.", pinned: 1, created_at: T0 - 3 * DAY, updated_at: T0 - 40 * MIN },
    { id: "mem-themes", project_id: "p-atlas", kind: "decision", title: "Colors are theme variables, never literals", content: "Fourteen themes × light and dark means a literal hex is wrong in at least twenty-seven of twenty-eight cases. Components use var(--…) only; new colors are added to the theme spec first. A hex in a component is a bug, not a style choice.", pinned: 1, created_at: T0 - 30 * DAY, updated_at: T0 - 5 * DAY },
    { id: "mem-stack", project_id: "p-atlas", kind: "context", title: "Stack, in one paragraph", content: "React 19 + TypeScript strict on the front end, zustand for state, Tauri 2 for the shell, SQLite through the SQL plugin. Agents wrap the member's own `claude`/`codex` CLI, or Ritz over local HTTP — there are no API keys anywhere in the app.", pinned: 0, created_at: T0 - 60 * DAY, updated_at: T0 - 26 * DAY },
    { id: "mem-checklist", project_id: "p-atlas", kind: "note", title: "Release checklist we keep forgetting", content: "1. Changelog entry with the user-visible sentence, not the commit subject. 2. Screenshot in the PR for anything visual. 3. Tag after CI is green, never before. 4. Post the tag in #releases so the queue drains.", pinned: 0, created_at: T0 - 18 * DAY, updated_at: T0 - 4 * HOUR },
    { id: "mem-onboarding", project_id: "p-notes", kind: "context", title: "What the nine onboarding interviews agree on", content: "All nine described the first five minutes as the deciding moment, and seven of nine had abandoned a comparable tool during setup. The blocker was never pricing — it was not knowing what to do on an empty screen.", pinned: 1, created_at: T0 - 10 * DAY, updated_at: T0 - 2 * DAY },
    { id: "mem-pricing", project_id: "p-notes", kind: "note", title: "Pricing objections, verbatim", content: "\"I can't tell what I'm paying for until I've already set it up.\" — P4, ops lead, 60 seats.\n\"Per-seat is fine. Per-agent would be a non-starter, we'd just share one.\" — P7, founder, 8 seats.", pinned: 0, created_at: T0 - 7 * DAY, updated_at: T0 - 7 * DAY },
  ];

  const messages: Message[] = [
    /* #frontend — the busiest channel: two agents, a thread, a system notice */
    { id: "m-f1", channel_id: "c-frontend", author_type: "user", author_id: "user", author_name: "Lauren", content: "@ada when a run finishes while I'm scrolled up, the list yanks me back to the bottom and I lose my place. It's been bugging me all week — can you find where it's coming from?", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 52 * MIN },
    {
      id: "m-f2", channel_id: "c-frontend", author_type: "agent", author_id: "a-ada", author_name: "Ada",
      content:
        "Found it, and it's three things stacked on top of each other.\n\n" +
        "- the auto-scroll effect runs on **every** `messages` change, with no *was the reader at the bottom?* guard\n" +
        "- `patchMessageLocal` fires per streamed token, so one live run re-triggers it dozens of times a second\n" +
        "- `.chat-messages` has `overflow-y: auto` with no `overscroll-behavior`, so a trackpad flick escapes to the window\n\n" +
        "```diff\n-  useEffect(() => { end.current?.scrollIntoView(); }, [messages]);\n+  useEffect(() => {\n+    if (atBottom.current) end.current?.scrollIntoView({ block: \"end\" });\n+  }, [messages]);\n```\n\n" +
        "Pushed to `hq/ada-a-ada`. The part I'd check first is the height-delta pinning — I'm least sure it survives a window resize mid-stream.",
      status: "done", meta: "4 turns · $0.041 · 51s", parent_id: "", run_id: "m-f2", created_at: T0 - 50 * MIN,
    },
    { id: "m-f3", channel_id: "c-frontend", author_type: "user", author_id: "user", author_name: "Lauren", content: "That matches what I saw. Does it hold with the thread panel open? @iris does any of this touch the tokens work?", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 46 * MIN },
    {
      id: "m-f4", channel_id: "c-frontend", author_type: "agent", author_id: "a-iris", author_name: "Iris",
      content:
        "No collision — Ada's change is behaviour, mine is colour. But while I'm in `RunInspector` I found six literal hexes still painting run status, which is why the light themes look broken there.\n\n" +
        "Replacing them with `var(--green)` / `var(--yellow)` / `var(--red)` and the matching `-soft` fills. That's `t-tokens`, out today.",
      status: "done", meta: "3 turns · $0.018 · 29s", parent_id: "", run_id: "m-f4", created_at: T0 - 45 * MIN,
    },
    { id: "m-f5", channel_id: "c-frontend", author_type: "user", author_id: "user", author_name: "Lauren", content: "Does the guard cover a *new thread reply* arriving, or only top-level messages?", status: "done", meta: "", parent_id: "m-f2", run_id: "", created_at: T0 - 40 * MIN },
    { id: "m-f6", channel_id: "c-frontend", author_type: "agent", author_id: "a-ada", author_name: "Ada", content: "Both — the thread panel is its own scroll container, so it gets its own `atBottom` ref rather than sharing the channel's. I've added a test that opens a thread, scrolls up, and streams a reply into it.", status: "done", meta: "2 turns · $0.009 · 14s", parent_id: "m-f2", run_id: "m-f6", created_at: T0 - 39 * MIN },
    { id: "m-f7", channel_id: "c-frontend", author_type: "system", author_id: "", author_name: "HQ", content: "⚠️ Pike's host device (`studio-mini`) went offline. Runs addressed to Pike will queue until it's back.", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 30 * MIN },
    { id: "m-f8", channel_id: "c-frontend", author_type: "user", author_id: "user", author_name: "Lauren", content: "@iris ship the token pass first — the release notes for 1.4.0 mention both and I'd rather they land together.", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 12 * MIN },
    { id: "m-f9", channel_id: "c-frontend", author_type: "agent", author_id: "a-iris", author_name: "Iris", content: "Done — `hq/iris-a-iris` is green and rebased on Ada's branch, so they merge in either order. One thing for the record: `RunInspector` also hardcoded a shadow. That's on tokens now too.", status: "done", meta: "5 turns · $0.023 · 38s", parent_id: "", run_id: "m-f9", created_at: T0 - 11 * MIN },

    /* #general — including one failed run, so the error state is visible */
    { id: "m-g1", channel_id: "c-general", author_type: "user", author_id: "user", author_name: "Lauren", content: "@all morning — anything I should know before standup?", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 5 * HOUR },
    { id: "m-g2", channel_id: "c-general", author_type: "agent", author_id: "a-rune", author_name: "Rune", content: "⚠️ Agent run failed (exit 1).\n\n```\nerror: could not compile `atlas-api` (lib) due to 2 previous errors\n```", status: "error", meta: "cancelled", parent_id: "", run_id: "m-g2", created_at: T0 - 5 * HOUR + 40_000 },
    { id: "m-g3", channel_id: "c-general", author_type: "agent", author_id: "a-pike", author_name: "Pike", content: "Pipeline is green on `main`. Two branches are ahead of origin and unpushed: `hq/ada-a-ada` and `hq/iris-a-iris`. 1.4.0 is blocked on both of those, nothing else.", status: "done", meta: "2 turns · 1.2k tokens", parent_id: "", run_id: "m-g3", created_at: T0 - 5 * HOUR + 95_000 },

    /* #research — the panel-mode channel */
    { id: "m-r1", channel_id: "c-research", author_type: "user", author_id: "user", author_name: "Lauren", content: "@studio what do the nine onboarding interviews actually agree on? Not the loudest quote — the agreement.", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 2 * DAY },
    { id: "m-r2", channel_id: "c-research", author_type: "agent", author_id: "a-juno", author_name: "Juno", content: "Three claims survive all nine transcripts:\n\n1. **The first five minutes decide it.** Nine of nine described a moment in setup where they chose to continue or not.\n2. **Seven of nine had already abandoned a comparable tool** during setup, and could name it.\n3. **Nobody's blocker was price.** Two raised pricing later, unprompted, and both were comparing seats not features.\n\nThe thin spot is admins: eight of nine were solo or near-solo users, so the multi-seat story here is unevidenced.", status: "done", meta: "local · 1.9k tokens", parent_id: "", run_id: "m-r2", created_at: T0 - 2 * DAY + 120_000 },

    /* #ideas — deliberately quiet */
    { id: "m-i1", channel_id: "c-ideas", author_type: "user", author_id: "user", author_name: "Lauren", content: "Idea, unformed: what if the empty dashboard offered to build a demo project instead of just being empty? See `t-onboard`.", status: "done", meta: "", parent_id: "", run_id: "", created_at: T0 - 3 * DAY },
  ];

  const runPrompts: Record<string, { task: string; cwd: string; before: string; after: string; files: string }> = {
    "m-f2": { task: "t-scroll", cwd: `${WORKSPACE_ROOT}/ada-a-ada`, before: COMMITS[2].sha, after: COMMITS[0].sha, files: "src/components/ChatView.tsx\nsrc/components/chat.css" },
    "m-f4": { task: "t-tokens", cwd: `${WORKSPACE_ROOT}/iris-a-iris`, before: COMMITS[2].sha, after: COMMITS[1].sha, files: "src/components/RunInspector.tsx" },
    "m-f6": { task: "", cwd: `${WORKSPACE_ROOT}/ada-a-ada`, before: COMMITS[0].sha, after: "", files: "" },
    "m-f9": { task: "t-tokens", cwd: `${WORKSPACE_ROOT}/iris-a-iris`, before: COMMITS[1].sha, after: "", files: "src/components/RunInspector.tsx\nsrc/components/inspector.css" },
    "m-g2": { task: "", cwd: ATLAS_PATH, before: COMMITS[3].sha, after: "", files: "" },
    "m-g3": { task: "t-release", cwd: ATLAS_PATH, before: COMMITS[0].sha, after: "", files: "" },
    "m-r2": { task: "t-synth", cwd: "", before: "", after: "", files: "" },
  };

  const links: Link[] = [
    { id: "lk-01", from_type: "task", from_id: "t-scroll", to_type: "memory", to_id: "mem-scroll", kind: "implements", note: "The decision this task is the first application of.", created_by: "user", created_at: T0 - 3 * DAY },
    { id: "lk-02", from_type: "task", from_id: "t-scroll", to_type: "pr", to_id: "acme/atlas#128", kind: "references", note: "", created_by: "a-ada", created_at: T0 - 38 * MIN },
    { id: "lk-03", from_type: "channel", from_id: "c-frontend", to_type: "task", to_id: "t-scroll", kind: "relates", note: "Reported and debugged here.", created_by: "user", created_at: T0 - 51 * MIN },
    { id: "lk-04", from_type: "message", from_id: "m-f2", to_type: "task", to_id: "t-scroll", kind: "references", note: "Auto-linked from the reply.", created_by: "a-ada", created_at: T0 - 50 * MIN },
    { id: "lk-05", from_type: "task", from_id: "t-thread", to_type: "task", to_id: "t-scroll", kind: "depends", note: "Same scroll container; do them in order.", created_by: "user", created_at: T0 - 6 * DAY },
    { id: "lk-06", from_type: "task", from_id: "t-tokens", to_type: "memory", to_id: "mem-themes", kind: "implements", note: "", created_by: "user", created_at: T0 - 4 * DAY },
    { id: "lk-07", from_type: "task", from_id: "t-contrast", to_type: "task", to_id: "t-tokens", kind: "depends", note: "No point measuring contrast until the literals are gone.", created_by: "a-iris", created_at: T0 - 4 * DAY },
    { id: "lk-08", from_type: "task", from_id: "t-release", to_type: "task", to_id: "t-scroll", kind: "blocks", note: "1.4.0 claims this fix in the notes.", created_by: "user", created_at: T0 - 5 * DAY },
    { id: "lk-09", from_type: "task", from_id: "t-release", to_type: "issue", to_id: "acme/atlas#131", kind: "references", note: "", created_by: "a-pike", created_at: T0 - 4 * HOUR },
    { id: "lk-10", from_type: "task", from_id: "t-migrate", to_type: "task", to_id: "t-api", kind: "parent", note: "Pagination lands first; the backfill is the follow-up.", created_by: "user", created_at: T0 - 9 * DAY },
    { id: "lk-11", from_type: "memory", from_id: "mem-checklist", to_type: "channel", to_id: "c-releases", kind: "references", note: "Read this before tagging.", created_by: "user", created_at: T0 - 18 * DAY },
    { id: "lk-12", from_type: "task", from_id: "t-synth", to_type: "memory", to_id: "mem-onboarding", kind: "implements", note: "", created_by: "a-juno", created_at: T0 - 2 * DAY },
    { id: "lk-13", from_type: "task", from_id: "t-onboard", to_type: "memory", to_id: "mem-onboarding", kind: "references", note: "The empty-screen finding is the reason this exists.", created_by: "user", created_at: T0 - 2 * DAY },
    { id: "lk-14", from_type: "task", from_id: "t-quotes", to_type: "memory", to_id: "mem-pricing", kind: "references", note: "", created_by: "user", created_at: T0 - 7 * DAY },
    { id: "lk-15", from_type: "project", from_id: "p-atlas", to_type: "repo", to_id: "acme/atlas", kind: "references", note: "", created_by: "user", created_at: T0 - 90 * DAY },
    { id: "lk-16", from_type: "task", from_id: "t-flake", to_type: "issue", to_id: "acme/atlas#119", kind: "duplicates", note: "Same failure, filed twice.", created_by: "user", created_at: T0 - 14 * DAY },
  ];

  const assignments: Assignment[] = [
    { id: "as-01", subject_type: "agent", subject_id: "a-ada", target_type: "task", target_id: "t-scroll", role: "assignee", created_at: T0 - 3 * DAY },
    { id: "as-02", subject_type: "agent", subject_id: "a-iris", target_type: "task", target_id: "t-scroll", role: "reviewer", created_at: T0 - 3 * DAY },
    { id: "as-03", subject_type: "team", subject_id: "tm-core", target_type: "channel", target_id: "c-frontend", role: "owner", created_at: T0 - 62 * DAY },
    { id: "as-04", subject_type: "agent", subject_id: "a-pike", target_type: "channel", target_id: "c-releases", role: "owner", created_at: T0 - 40 * DAY },
    { id: "as-05", subject_type: "agent", subject_id: "a-ada", target_type: "pr", target_id: "acme/atlas#128", role: "owner", created_at: T0 - 38 * MIN },
    { id: "as-06", subject_type: "agent", subject_id: "a-rune", target_type: "pr", target_id: "acme/atlas#129", role: "owner", created_at: T0 - 90 * MIN },
    { id: "as-07", subject_type: "agent", subject_id: "a-iris", target_type: "pr", target_id: "acme/atlas#126", role: "reviewer", created_at: T0 - 5 * HOUR },
    { id: "as-08", subject_type: "agent", subject_id: "a-pike", target_type: "issue", target_id: "acme/atlas#131", role: "assignee", created_at: T0 - 4 * HOUR },
    { id: "as-09", subject_type: "agent", subject_id: "a-juno", target_type: "memory", target_id: "mem-onboarding", role: "owner", created_at: T0 - 10 * DAY },
    { id: "as-10", subject_type: "team", subject_id: "tm-studio", target_type: "project", target_id: "p-notes", role: "owner", created_at: T0 - 20 * DAY },
    { id: "as-11", subject_type: "agent", subject_id: "a-rune", target_type: "task", target_id: "t-api", role: "assignee", created_at: T0 - 7 * DAY },
    { id: "as-12", subject_type: "agent", subject_id: "a-ada", target_type: "workspace", target_id: `${WORKSPACE_ROOT}/ada-a-ada`, role: "owner", created_at: T0 - 62 * DAY },
  ];

  for (const p of projects) insert(db, "projects", p as unknown as Record<string, unknown>);
  for (const c of channels) insert(db, "channels", c as unknown as Record<string, unknown>);
  for (const a of agents) insert(db, "agents", a as unknown as Record<string, unknown>);
  for (const t of teams) insert(db, "teams", t as unknown as Record<string, unknown>);
  for (const tm of teamMembers) insert(db, "team_members", tm as unknown as Record<string, unknown>);
  for (const cm of channelMembers) insert(db, "channel_members", cm as unknown as Record<string, unknown>);
  for (const t of tasks) insert(db, "tasks", t as unknown as Record<string, unknown>);
  for (const m of memory) insert(db, "memory", m as unknown as Record<string, unknown>);
  for (const m of messages) insert(db, "messages", m as unknown as Record<string, unknown>);

  // One run row per agent reply, so the run inspector, the activity timeline
  // and "what did this turn change?" all have something real behind them.
  for (const m of messages) {
    if (!m.run_id) continue;
    const extra = runPrompts[m.id] ?? { task: "", cwd: ATLAS_PATH, before: "", after: "", files: "" };
    const run: Run = {
      id: m.run_id,
      agent_id: m.author_id,
      channel_id: m.channel_id,
      task_id: extra.task,
      prompt: `You are "${m.author_name}", an AI teammate in HQ.\n\n[Lauren]: (seeded demo run — the full prompt isn't stored for seed data)`,
      status: m.status === "error" ? "error" : "done",
      session_id: `dev-${m.id}`,
      meta: m.meta,
      activity: JSON.stringify(activityFor(m)),
      cwd: extra.cwd,
      // Launch context, so the live process console has something to show.
      // The command deliberately omits the prompt — it arrives on stdin.
      model: m.author_name === "Nova" ? "gpt-5-codex" : "claude-opus-5",
      effort: "medium",
      command:
        m.author_name === "Nova"
          ? "codex exec --json --sandbox workspace-write --skip-git-repo-check -"
          : "claude -p --output-format stream-json --verbose --permission-mode acceptEdits",
      commit_before: extra.before,
      commit_after: extra.after,
      files_changed: extra.files,
      transcript: "",
      started_at: m.created_at - 40_000,
      finished_at: m.created_at,
    };
    insert(db, "runs", run as unknown as Record<string, unknown>);
  }

  for (const s of [
    { channel_id: "c-frontend", agent_id: "a-ada", session_id: "dev-m-f6", updated_at: T0 - 39 * MIN },
    { channel_id: "c-frontend", agent_id: "a-iris", session_id: "dev-m-f9", updated_at: T0 - 11 * MIN },
    { channel_id: "c-research", agent_id: "a-juno", session_id: "hq-c-research-a-juno", updated_at: T0 - 2 * DAY },
  ]) {
    insert(db, "agent_sessions", s);
  }

  // #frontend is left unread on purpose, so the sidebar badge has a value.
  for (const channelId of ["c-general", "c-releases", "c-ideas", "c-research"]) {
    insert(db, "channel_reads", { channel_id: channelId, last_read: T0 });
  }

  for (const l of links) insert(db, "links", l as unknown as Record<string, unknown>);
  for (const a of assignments) insert(db, "assignments", a as unknown as Record<string, unknown>);
}

/** A plausible activity timeline for a seeded reply, in ActivityEvent shape. */
function activityFor(m: Message): { t: number; kind: string; detail: string }[] {
  if (m.status === "error") {
    return [
      { t: 120, kind: "info", detail: "thread 01JDEVM0 · gpt-5-codex" },
      { t: 900, kind: "tool", detail: "shell cargo build --lib" },
      { t: 31_400, kind: "stderr", detail: "error: could not compile `atlas-api` (lib) due to 2 previous errors" },
    ];
  }
  return [
    { t: 140, kind: "info", detail: `session dev-${m.id} · ${m.author_name.toLowerCase()}` },
    { t: 820, kind: "tool", detail: 'Read {"file_path":"src/components/ChatView.tsx"}' },
    { t: 2_310, kind: "tool", detail: 'Grep {"pattern":"scrollIntoView","path":"src"}' },
    { t: 4_050, kind: "tool", detail: 'Edit {"file_path":"src/components/chat.css"}' },
    { t: 6_900, kind: "text", detail: m.content.slice(0, 200) },
  ];
}
