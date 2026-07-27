/**
 * Wiring the MCP transport up, from Spaces's side.
 *
 * The harness discovers tools by reading `.mcp.json` at the root of the
 * directory it was started in, spawning whatever that file names, and speaking
 * MCP to it. Spaces's job is therefore three files in the user's checkout and
 * nothing else:
 *
 *   .hq/hq-mcp-server.mjs   the server itself, copied out of the app bundle
 *   .hq/mcp-tools.json      the tool list, generated from src/hqops.ts
 *   .mcp.json              the harness's pointer at the two above
 *
 * The server travels as *text* inside the bundle (Vite inlines mcp/hq-mcp-
 * server.mjs at build time) rather than as a bundled resource. That is what
 * makes mcpServerPath() honest in both directions: a dev build and a packaged
 * .app produce the same file in the same place, because neither one has to
 * find anything on disk. Projects without a code checkout use a private
 * app-data control directory, so ordinary workspace channels get the same
 * tools without pretending that directory is a repository. Windows is not
 * handled yet: every path here is built with forward slashes, like the rest of
 * Spaces.
 *
 * Everything written here is generated and rewritten in place, exactly like the
 * blackboard: bytes are compared before writing so a sync is a true no-op and
 * git diffs stay meaningful. `.mcp.json` is the one exception to "generated" —
 * it belongs to the user, may already list their own servers, and is therefore
 * merged, never replaced.
 */
import { invoke } from "@tauri-apps/api/core";
import { manifest } from "./hqops";
import { SPACES_BASE_PROMPT, SPACES_HARNESS_PROTOCOL } from "./runtimeContract";
import type { Project } from "./types";
// The server is dependency-free single-file ESM precisely so it can ride along
// as a string. `?raw` is Vite's inliner; nothing is read from disk at runtime.
import SERVER_SOURCE from "../mcp/hq-mcp-server.mjs?raw";

const SPACES_DIR = ".hq";
/** Where the server lives, relative to the project root. */
export const MCP_SERVER_REL = `${SPACES_DIR}/hq-mcp-server.mjs`;
/** The generated tool list the server serves `tools/list` from. */
export const MCP_MANIFEST_REL = `${SPACES_DIR}/mcp-tools.json`;
/** The queue both transports append to; Spaces drains it. */
export const MCP_ACTIONS_REL = `${SPACES_DIR}/actions.jsonl`;
/** Versioned runtime contract used by system-prompt-capable adapters. */
export const RUNTIME_CONTRACT_REL = `${SPACES_DIR}/RUNTIME.md`;
/** The harness's own config file, at the root of the directory it starts in. */
export const MCP_CONFIG_REL = ".mcp.json";
/** Our key inside `mcpServers`. Anything else in there is someone else's. */
export const MCP_SERVER_KEY = "hq";

/* ── shapes the UI renders ────────────────────────────────────── */

export interface FileWrite {
  /** Absolute path, for the "reveal in Finder" affordance and error copy. */
  path: string;
  /** False when the bytes were already correct — a re-run must be a no-op. */
  written: boolean;
  error: string;
}

export interface McpRegistration {
  path: string;
  /** `failed` leaves the user's file untouched; `error` says why. */
  action: "created" | "updated" | "unchanged" | "failed";
  /** MCP servers that were already configured, left exactly as they were. */
  kept: string[];
  error: string;
}

export interface McpStatus {
  /** Project root this describes; '' when the project has no local checkout. */
  root: string;
  /** `.mcp.json` names our server and points at the file we would write. */
  registered: boolean;
  /**
   * Whether `node` is on the PATH the harness inherits. `null` means Spaces could
   * not find out: the Rust `check_tools` command probes a fixed list
   * (claude, codex, gh), and there is no general "is this binary present"
   * command. Adding "node" to that array is the one-line change that turns this
   * into a real answer; until then the UI should say it cannot tell, not that
   * node is missing.
   */
  node: boolean | null;
  /** Absolute path to the server the harness will spawn. */
  serverPath: string;
  /** Tools the manifest offers. */
  toolCount: number;
  /** Other people's MCP servers in this project, which Spaces never touches. */
  otherServers: string[];
  /** One sentence explaining why the transport is not usable; '' when it is. */
  problem: string;
}

export interface McpSetup {
  server: FileWrite;
  tools: FileWrite;
  runtime: FileWrite;
  /** The harness permission grant; see ensureClaudePermissions. */
  permissions: FileWrite;
  registration: McpRegistration;
  status: McpStatus;
}

/* ── paths ────────────────────────────────────────────────────── */

function base(root: string): string {
  return root.trim().replace(/\/+$/, "");
}

function abs(root: string, rel: string): string {
  return `${base(root)}/${rel}`;
}

/**
 * The project's own checkout — always the *main* one, even when the calling
 * agent works in a worktree. The queue, the manifest and the server have to be
 * the single copy Spaces itself watches; an agent appending to its worktree's own
 * `.hq/actions.jsonl` would be talking to nobody.
 */
function mainRoot(project: Project): string {
  return base(project.local_path ?? "");
}

/** Absolute path to the server the harness spawns for this project. */
export function mcpServerPath(project: Project): string {
  const root = mainRoot(project);
  return root ? abs(root, MCP_SERVER_REL) : "";
}

/* ── file i/o ─────────────────────────────────────────────────── */

type FileState = { kind: "file"; text: string } | { kind: "missing" } | { kind: "unknown"; error: string };

async function statFile(root: string, rel: string): Promise<FileState> {
  try {
    return { kind: "file", text: await invoke<string>("read_text_file", { root, relativePath: rel }) };
  } catch (e) {
    // Only a definite "not there" counts as missing. Anything else — a
    // permission error, a directory in the way — must not be read as an
    // invitation to overwrite.
    const error = String(e);
    return /no such file|not found|os error 2/i.test(error) ? { kind: "missing" } : { kind: "unknown", error };
  }
}

async function writeIfChanged(root: string, rel: string, contents: string): Promise<FileWrite> {
  const path = abs(root, rel);
  const cur = await statFile(root, rel);
  if (cur.kind === "file" && cur.text === contents) return { path, written: false, error: "" };
  if (cur.kind === "unknown") return { path, written: false, error: cur.error };
  try {
    await invoke("write_text_file", { root, relativePath: rel, contents });
    return { path, written: true, error: "" };
  } catch (e) {
    return { path, written: false, error: String(e) };
  }
}

/* ── the manifest ─────────────────────────────────────────────── */

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: unknown;
  effect: string;
  readOnly: boolean;
}

function tools(): ManifestTool[] {
  const raw = manifest();
  return Array.isArray(raw) ? (raw as ManifestTool[]) : [];
}

/**
 * The tool list, as the server will read it.
 *
 * Deliberately timestamp-free. The file sits in a git repo next to the rest of
 * `.hq/`, and a generated-at field would rewrite it on every sync, thrash file
 * watchers and fill history with diffs that say nothing.
 */
function manifestJson(project: Project): string {
  const body = {
    version: 1,
    generator: "Spaces",
    project: { id: project.id, name: project.name, root: mainRoot(project) },
    actions_file: MCP_ACTIONS_REL,
    tools: tools(),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Write `.hq/mcp-tools.json`. Safe to call on every registry or project change. */
export async function writeMcpManifest(project: Project): Promise<FileWrite> {
  const root = mainRoot(project);
  if (!root) return { path: "", written: false, error: "this project has no local checkout" };
  return writeIfChanged(root, MCP_MANIFEST_REL, manifestJson(project));
}

/**
 * Write `.hq/hq-mcp-server.mjs`.
 *
 * The copy is generated, like everything else under `.hq/` — if someone edits
 * it, the next sync puts Spaces's version back, because a server that does not
 * match the manifest format Spaces writes is worse than no server. Keeping a copy
 * per project (rather than one shared file in Application Support) also means a
 * repo that has been committed carries a working transport for whoever clones
 * it next.
 */
export async function ensureMcpServer(project: Project): Promise<FileWrite> {
  const root = mainRoot(project);
  if (!root) return { path: "", written: false, error: "this project has no local checkout" };
  return writeIfChanged(root, MCP_SERVER_REL, SERVER_SOURCE);
}

/** Write the platform contract once so runtimes can load it as instructions. */
export async function ensureRuntimeContract(project: Project): Promise<FileWrite> {
  const root = mainRoot(project);
  if (!root) return { path: "", written: false, error: "this project has no local checkout" };
  const contents = [
    "<!-- generated by Spaces — do not edit -->",
    `<!-- harness: ${SPACES_HARNESS_PROTOCOL} -->`,
    SPACES_BASE_PROMPT,
    "",
  ].join("\n");
  return writeIfChanged(root, RUNTIME_CONTRACT_REL, contents);
}

/* ── .mcp.json ────────────────────────────────────────────────── */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Key-sorted stringify, so "did this change?" ignores key order and spacing. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * The entry the harness spawns.
 *
 * Absolute paths, on purpose. Spaces runs isolated agents in git worktrees, and a
 * relative `.hq/hq-mcp-server.mjs` would resolve to that worktree's own copy —
 * a second queue nobody drains. The price is that `.mcp.json` becomes
 * machine-specific; see mcp/README.md.
 */
function serverEntry(project: Project, existing: unknown): Json {
  const root = mainRoot(project);
  const prevEnv = isObject(existing) && isObject(existing.env) ? existing.env : {};
  return {
    type: "stdio",
    command: "node",
    args: [mcpServerPath(project), root],
    // Extra env a user added by hand survives; ours always wins.
    env: { ...prevEnv, SPACES_PROJECT_ROOT: root, SPACES_PROJECT_ID: project.id },
  };
}

/**
 * Merge Spaces's server into `.mcp.json`, creating the file if it does not exist.
 *
 * `root` defaults to the project checkout. Pass an agent's worktree to register
 * there as well — the harness reads the file from the directory it starts in,
 * and an uncommitted `.mcp.json` in the main checkout is invisible from a
 * worktree. The entry written still points at the main checkout's server, so
 * every agent appends to the one queue Spaces drains.
 *
 * A file we cannot parse is never overwritten: losing a user's MCP config to a
 * missing comma would be an unforgivable trade for the convenience of not
 * asking.
 */
/**
 * Grant Claude Code permission to call Spaces's own tools.
 *
 * Claude is the only harness that needs a file written: it reads .mcp.json
 * from the project and gates the tools behind an allow-list. Codex takes its
 * MCP config as spawn arguments instead (see mcpCodexArgs), and Ritz has no
 * MCP at all and uses the file drop — which is why the drop, not MCP, is the
 * transport every agent kind can rely on.
 *
 * Registering the server is only half the job. Verified against a real
 * `claude -p`: it discovers the server from .mcp.json and exposes the tools as
 * `mcp__hq__*`, then refuses to call one because the permission was never
 * granted — and a non-interactive agent run cannot prompt, so it fails
 * silently-ish and the agent reports it could not act. Every agent would hit
 * that wall.
 *
 * Merges rather than writes: this file is the user's, and it commonly holds
 * their own allow-list. An entry that is already present is left exactly as it
 * was, so re-running is a true no-op.
 */
export async function ensureHarnessAccess(project: Project, root?: string): Promise<FileWrite> {
  const dir = base(root ?? mainRoot(project));
  const rel = ".claude/settings.local.json";
  const path = dir ? `${dir}/${rel}` : "";
  if (!dir) return { path, written: false, error: "this project has no local checkout" };

  const cur = await statFile(dir, rel);
  if (cur.kind === "unknown") return { path, written: false, error: cur.error };

  let config: Json = {};
  if (cur.kind === "file" && cur.text.trim()) {
    try {
      const parsed: unknown = JSON.parse(cur.text);
      if (!isObject(parsed)) {
        return { path, written: false, error: `${rel} is not a JSON object — Spaces will not overwrite it.` };
      }
      config = parsed;
    } catch (e) {
      return { path, written: false, error: `${rel} is not valid JSON (${String(e)}) — Spaces will not overwrite it.` };
    }
  }

  const before = stable(config);
  config.enableAllProjectMcpServers = true;
  const permissions: Json = isObject(config.permissions) ? { ...config.permissions } : {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  // The server-wide grant covers every tool the manifest grows later, so this
  // does not need revisiting each time an operation is added.
  const grant = `mcp__${MCP_SERVER_KEY}`;
  if (!allow.some((a) => typeof a === "string" && (a === grant || a.startsWith(`${grant}__`)))) {
    allow.push(grant);
  }
  permissions.allow = allow;
  config.permissions = permissions;

  if (stable(config) === before) return { path, written: false, error: "" };
  try {
    await invoke("write_text_file", {
      root: dir,
      relativePath: rel,
      contents: `${JSON.stringify(config, null, 2)}\n`,
    });
    return { path, written: true, error: "" };
  } catch (e) {
    return { path, written: false, error: String(e) };
  }
}

/**
 * Codex's equivalent of .mcp.json, as spawn arguments.
 *
 * `codex mcp add` would write the user's global ~/.codex/config.toml, which is
 * not Spaces's to edit — a per-project server does not belong in someone's machine
 * config. `-c` overrides do the same job for the lifetime of one invocation.
 * Returns [] when the project has no checkout to run the server from.
 */
export function mcpCodexArgs(project: Project): string[] {
  const root = mainRoot(project);
  if (!root) return [];
  const server = `${base(root)}/${MCP_SERVER_REL}`;
  return [
    "-c", `mcp_servers.${MCP_SERVER_KEY}.command="node"`,
    "-c", `mcp_servers.${MCP_SERVER_KEY}.args=["${server}","${base(root)}"]`,
  ];
}

export async function ensureMcpRegistration(project: Project, root?: string): Promise<McpRegistration> {
  const dir = base(root ?? mainRoot(project));
  const path = dir ? `${dir}/${MCP_CONFIG_REL}` : "";
  if (!dir) return { path, action: "failed", kept: [], error: "this project has no local checkout" };
  if (!mainRoot(project)) {
    return { path, action: "failed", kept: [], error: "this project has no local checkout to run the server from" };
  }

  const cur = await statFile(dir, MCP_CONFIG_REL);
  if (cur.kind === "unknown") return { path, action: "failed", kept: [], error: cur.error };

  let config: Json = {};
  if (cur.kind === "file" && cur.text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cur.text);
    } catch (e) {
      return {
        path,
        action: "failed",
        kept: [],
        error: `${MCP_CONFIG_REL} is not valid JSON (${String(e)}). Spaces will not overwrite it — fix or delete it, then try again.`,
      };
    }
    if (!isObject(parsed)) {
      return { path, action: "failed", kept: [], error: `${MCP_CONFIG_REL} is not a JSON object. Spaces will not overwrite it.` };
    }
    config = parsed;
  }

  const servers: Json = isObject(config.mcpServers) ? { ...config.mcpServers } : {};
  const kept = Object.keys(servers).filter((k) => k !== MCP_SERVER_KEY);
  const wanted = serverEntry(project, servers[MCP_SERVER_KEY]);
  if (stable(servers[MCP_SERVER_KEY]) === stable(wanted)) {
    // Byte-for-byte untouched, even if the user's formatting differs from ours.
    return { path, action: "unchanged", kept, error: "" };
  }

  const next: Json = { ...config, mcpServers: { ...servers, [MCP_SERVER_KEY]: wanted } };
  try {
    await invoke("write_text_file", {
      root: dir,
      relativePath: MCP_CONFIG_REL,
      contents: `${JSON.stringify(next, null, 2)}\n`,
    });
  } catch (e) {
    return { path, action: "failed", kept, error: String(e) };
  }
  return { path, action: cur.kind === "file" ? "updated" : "created", kept, error: "" };
}

/* ── status ───────────────────────────────────────────────────── */

async function nodePresent(): Promise<boolean | null> {
  try {
    const found = await invoke<Record<string, boolean>>("check_tools");
    const v = found?.node;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What the Settings pane renders. Reads only — call the ensure* functions to
 * change anything.
 */
export async function mcpStatus(project: Project, root?: string): Promise<McpStatus> {
  const dir = base(root ?? mainRoot(project));
  const serverPath = mcpServerPath(project);
  const status: McpStatus = {
    root: dir,
    registered: false,
    node: null,
    serverPath,
    toolCount: tools().length,
    otherServers: [],
    problem: "",
  };
  if (!dir) {
    status.problem = "This project has no local checkout, so there is nowhere to put the MCP server.";
    return status;
  }

  status.node = await nodePresent();

  const cur = await statFile(dir, MCP_CONFIG_REL);
  if (cur.kind === "file") {
    try {
      const parsed: unknown = JSON.parse(cur.text);
      const servers = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers : {};
      status.otherServers = Object.keys(servers).filter((k) => k !== MCP_SERVER_KEY);
      const ours = servers[MCP_SERVER_KEY];
      const args = isObject(ours) && Array.isArray(ours.args) ? ours.args : [];
      status.registered = args[0] === serverPath;
      if (isObject(ours) && !status.registered) {
        status.problem = `${MCP_CONFIG_REL} points at a different copy of the server — re-register to fix it.`;
      }
    } catch {
      status.problem = `${MCP_CONFIG_REL} is not valid JSON, so the harness will ignore all of it. Fix or delete it.`;
      return status;
    }
  }

  if (!status.registered && !status.problem) {
    status.problem = "The harness has not been told about Spaces yet.";
  } else if (status.registered && (await statFile(mainRoot(project), MCP_SERVER_REL)).kind !== "file") {
    // The registration points at the main checkout even when `root` is a
    // worktree, so that is where the server has to exist.
    status.problem = "Registered, but the server file is missing — re-run setup to write it back.";
  } else if (status.registered && status.node === false) {
    status.problem = "Registered, but node is not on the PATH the harness inherits, so it cannot be started.";
  }
  return status;
}

/**
 * Everything, in the order it has to happen: the server and its tool list have
 * to exist before anything is pointed at them. Returns the whole picture so the
 * caller can report exactly what changed rather than "done".
 */
export async function setupMcp(project: Project, root?: string): Promise<McpSetup> {
  const server = await ensureMcpServer(project);
  const toolList = await writeMcpManifest(project);
  const runtime = await ensureRuntimeContract(project);
  const registration = await ensureMcpRegistration(project, root);
  // Registration without permission is a server the harness can see and cannot
  // call, which is indistinguishable from a broken one from the agent's side.
  const permissions = await ensureHarnessAccess(project, root);
  return {
    server,
    tools: toolList,
    runtime,
    registration,
    permissions,
    status: await mcpStatus(project, root),
  };
}

/**
 * Give a project without a checkout a private control directory. This keeps
 * workspace tools available in general/non-coding channels without pretending
 * the directory is a repository or exposing it in the user's projects.
 */
export async function setupControlMcp(project: Project): Promise<Project> {
  const root = await invoke<string>("agent_control_root", { projectId: project.id });
  const controlProject: Project = { ...project, local_path: root, isolate: 0 };
  const setup = await setupMcp(controlProject, root);
  const problems = [
    setup.server.error,
    setup.tools.error,
    setup.runtime.error,
    setup.permissions.error,
    setup.registration.error,
  ].filter(Boolean);
  if (problems.length) throw new Error(problems.join("; "));
  return controlProject;
}
