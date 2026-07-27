#!/usr/bin/env node
/**
 * Spaces's MCP server — the harness-side end of the agent write path.
 *
 * This process is spawned by the harness (`claude`, or anything else that
 * speaks MCP) inside the user's checkout, in a different process from the Spaces
 * app, with no way to import a line of Spaces's TypeScript. It is deliberately
 * small: private read-only tools may query the paired host's SQLite database,
 * while shared state retains a generated-markdown fallback:
 *
 *   tools/list   is read from .hq/mcp-tools.json, which Spaces generates from its
 *                own operation registry (src/hqops.ts). Nothing here describes
 *                an operation — a second copy of the schema would rot within a
 *                week of the first edit to the first one.
 *   tools/call   appends one JSON line to .hq/actions.jsonl and says so. Spaces
 *                drains that file and runs the operation through the same
 *                store actions the UI calls, applying it or queueing it for a
 *                human depending on the operation's declared effect.
 *   read-only    calls cannot be answered that way, because the agent needs
 *                the answer now and this transport is one-way. Those return
 *                Spaces's mirrored markdown from .hq/ and say plainly how stale it
 *                is, rather than pretending to have queried anything.
 *
 * No dependencies, on purpose. This is spawned from a user's repo by a harness
 * we do not control; `npm install` is not something that may fail between an
 * agent and its tools.
 *
 * The wire is newline-delimited JSON-RPC 2.0 over stdin/stdout — the MCP stdio
 * transport, which does *not* use LSP's Content-Length framing. One message per
 * line, and nothing but protocol messages may ever reach stdout: a stray
 * console.log is indistinguishable from a malformed frame and takes the whole
 * session down. Diagnostics go to stderr, which harnesses surface in their MCP
 * logs.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Node before 22.5 has no built-in SQLite. Shared snapshot tools still work;
  // private live reads say why they are unavailable instead of taking down MCP.
}

const SERVER_NAME = "hq";
const SERVER_VERSION = "0.1.0";

/**
 * The revision every current client still accepts. A tools-only server has no
 * version-specific behaviour to negotiate, so advertising the oldest widely
 * supported revision is strictly the safest answer: newer clients downgrade,
 * older ones keep working.
 */
const PROTOCOL_VERSION = "2024-11-05";

const SPACES_DIR = ".hq";
const MANIFEST_REL = `${SPACES_DIR}/mcp-tools.json`;
const ACTIONS_REL = `${SPACES_DIR}/actions.jsonl`;
/**
 * The mirrored markdown, in the order a person would read it. There is no
 * directory listing here on purpose — these four names are Spaces's contract
 * (see src/blackboard.ts), and guessing at others would only produce noise.
 */
const KNOWLEDGE_REL = `${SPACES_DIR}/KNOWLEDGE.md`;
const CONTENT_REL = `${SPACES_DIR}/CONTENT.md`;
const SNAPSHOT_RELS = ["CONTEXT.md", "ROSTER.md", "BOARD.md", "LINKS.md", "KNOWLEDGE.md", "CONTENT.md"].map(
  (n) => `${SPACES_DIR}/${n}`,
);

/** A single appended line stays atomic while it is small. See queueAction(). */
const MAX_LINE_BYTES = 512 * 1024;
/** A message this large is a broken client, not a big request. */
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
/** Per-file cap on mirrored markdown, so one huge BOARD.md can't eat a context window. */
const MAX_SNAPSHOT_CHARS = 20_000;

/* ── startup ──────────────────────────────────────────────────── */

function log(message) {
  process.stderr.write(`${SERVER_NAME}-mcp: ${message}\n`);
}

/** Loud and specific: a misconfigured server is otherwise a silent no-tools session. */
function die(message) {
  log(message);
  process.exit(2);
}

const rootArg = (process.argv[2] ?? "").trim() || (process.env.SPACES_PROJECT_ROOT ?? "").trim();
if (!rootArg) {
  die(
    "no project root. Pass it as the first argument (node hq-mcp-server.mjs /path/to/project) " +
      "or set SPACES_PROJECT_ROOT. Spaces writes both into .mcp.json — if you are seeing this, that " +
      "entry was hand-edited or the file was copied from another machine."
  );
}
const ROOT = resolve(rootArg);
try {
  if (!statSync(ROOT).isDirectory()) die(`project root is not a directory: ${ROOT}`);
} catch {
  die(`project root does not exist: ${ROOT}`);
}

/**
 * Who is calling, when Spaces can say.
 *
 * Spaces injects agent, channel, run and project into each harness process, so
 * actions stay attributable even when several agents share a checkout. `cwd`
 * remains an independently inspectable routing hint.
 */
const CALLER = {
  agent_id: (process.env.SPACES_AGENT_ID ?? "").trim(),
  run_id: (process.env.SPACES_RUN_ID ?? "").trim(),
  channel_id: (process.env.SPACES_CHANNEL_ID ?? "").trim(),
  project_id: (process.env.SPACES_PROJECT_ID ?? "").trim(),
};
const CALL_SOURCE = process.argv.includes("--call") ? "cli" : "mcp";

/* ── JSON-RPC plumbing ────────────────────────────────────────── */

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A tool that failed is a *result*, not a protocol error — the model must see it. */
function text(body, isError = false) {
  return { content: [{ type: "text", text: body }], isError };
}

let shuttingDown = false;

function handleMessage(msg) {
  // JSON-RPC batches: no MCP client sends them today, and 2025-06-18 removed
  // them from the spec, but answering each element on its own line costs one
  // branch and is what an ndjson reader expects anyway.
  if (Array.isArray(msg)) {
    for (const m of msg) handleMessage(m);
    return;
  }
  if (!msg || typeof msg !== "object") return;

  const method = typeof msg.method === "string" ? msg.method : "";
  // No method means it is a response to a request — and we never send requests.
  if (!method) return;

  const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
  const id = hasId ? msg.id : null;
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};

  if (!hasId) {
    // notifications/initialized, notifications/cancelled, $/… — nothing to do,
    // and answering a notification is itself a protocol violation.
    if (method === "exit") process.exit(shuttingDown ? 0 : 1);
    return;
  }

  try {
    switch (method) {
      case "initialize":
        return reply(id, initializeResult(params));
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, toolsList());
      case "tools/call":
        return reply(id, toolsCall(params));
      // Not part of the MCP stdio lifecycle (the client shuts a server down by
      // closing stdin), but harmless to honour for anything that speaks LSP out
      // of habit.
      case "shutdown":
        shuttingDown = true;
        return reply(id, {});
      default:
        return replyError(
          id,
          -32601,
          `${method} is not implemented. This server offers tools only — no resources, prompts or sampling.`
        );
    }
  } catch (e) {
    if (e instanceof RpcError) return replyError(id, e.code, e.message);
    log(`${method} failed: ${describe(e)}`);
    return replyError(id, -32603, `internal error handling ${method}: ${describe(e)}`);
  }
}

function initializeResult(params) {
  const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  if (asked && asked !== PROTOCOL_VERSION) log(`client asked for MCP ${asked}; answering ${PROTOCOL_VERSION}`);
  const loaded = loadManifest();
  if (!loaded.ok) log(loaded.problem);
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    // Surfaced to the model by clients such as Codex: routing and cross-tool
    // workflow rules that no individual tool description can express.
    instructions:
      `You are operating inside Spaces. This tool process belongs to channel ${CALLER.channel_id || "(unspecified)"}, ` +
      `project ${CALLER.project_id || "(unspecified)"}, and run ${CALLER.run_id || "(unspecified)"}; the current ` +
      "[Spaces Context] event block is authoritative for reply routing. Use spaces_list_messages after a restart. " +
      "Your final assistant response is posted to the current channel automatically; hq_post is only for another " +
      "channel. Mutating calls enter Spaces's audited action queue. Additive operations apply automatically; " +
      "destructive, access, reassignment, and publishing actions wait for human approval. Read generated .hq/ " +
      "context and use spaces_search_knowledge/spaces_read_knowledge for citable Knowledge references.",
  };
}

/* ── the manifest Spaces writes ───────────────────────────────────── */

/**
 * Read .hq/mcp-tools.json fresh on every call.
 *
 * It is a few hundred bytes and Spaces rewrites it whenever the registry changes,
 * so caching would buy nothing and cost a stale tool list for the lifetime of
 * an agent session. A missing or broken file is reported, never thrown: a
 * harness that loses its MCP server mid-session is far worse than one whose
 * tools say why they are unavailable.
 */
function loadManifest() {
  const path = join(ROOT, MANIFEST_REL);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return {
      ok: false,
      tools: [],
      // Node's fs errors carry the absolute path, so this does not repeat it.
      problem:
        `Spaces has not written ${MANIFEST_REL} for this project, so this server has no tools to offer ` +
        `(${describe(e)}). Open the project in the Spaces app to generate it — the file comes from Spaces's ` +
        `operation registry, never from hand-editing.`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      tools: [],
      problem: `${MANIFEST_REL} is not valid JSON (${describe(e)}). Delete it and let Spaces rewrite it.`,
    };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tools) ? parsed.tools : null;
  if (!list) {
    return {
      ok: false,
      tools: [],
      problem: `${MANIFEST_REL} has no "tools" array. Delete it and let Spaces rewrite it.`,
    };
  }
  const tools = list.map(normalizeTool).filter((t) => t.name);
  if (!tools.length) {
    return { ok: false, tools: [], problem: `${MANIFEST_REL} lists no usable tools.` };
  }
  return { ok: true, tools, problem: "" };
}

function normalizeTool(entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  const schema = e.inputSchema && typeof e.inputSchema === "object" ? e.inputSchema : { type: "object", properties: {} };
  return {
    name: typeof e.name === "string" ? e.name : "",
    description: typeof e.description === "string" ? e.description : "",
    inputSchema: schema,
    // Unknown effects are treated as needing a human: the failure mode of
    // over-warning is a slightly cautious agent, the other way round is an
    // agent that believes a destructive change already landed.
    effect: e.effect === "auto" ? "auto" : "propose",
    readOnly: e.readOnly === true,
  };
}

/**
 * What the agent should expect after calling, appended to Spaces's own one-liner.
 * The tool description is the only place a model reliably reads before acting,
 * so the transport's honesty about itself belongs here rather than in a note
 * it will see only after the call.
 */
function expectation(tool) {
  if (tool.readOnly) {
    return "Answered from Spaces's live paired-host database when available, with generated .hq/ snapshots as a bounded fallback.";
  }
  return tool.effect === "auto"
    ? "Queued to Spaces and applied automatically, normally within a second or two. The result is not returned here."
    : "Queued to Spaces for a human to approve, because it changes or reassigns existing work. Do not assume it has happened.";
}

function toolsList() {
  const loaded = loadManifest();
  if (!loaded.ok) {
    log(loaded.problem);
    // An empty list keeps the session alive with a visible reason, where
    // throwing would take the harness's whole MCP connection down.
    return { tools: [], _meta: { "hq/problem": loaded.problem } };
  }
  return {
    tools: loaded.tools.map((t) => ({
      name: t.name,
      description: `${t.description} ${expectation(t)}`.trim(),
      inputSchema: t.inputSchema,
      annotations: {
        readOnlyHint: t.readOnly,
        destructiveHint: !t.readOnly && t.effect !== "auto",
        idempotentHint: t.readOnly,
        openWorldHint: false,
      },
    })),
  };
}

/* ── calls ────────────────────────────────────────────────────── */

function toolsCall(params) {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) throw new RpcError(-32602, "tools/call needs a tool name");
  const args =
    params.arguments === undefined || params.arguments === null
      ? {}
      : params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments
        : null;
  if (!args) throw new RpcError(-32602, "tools/call arguments must be an object");

  const loaded = loadManifest();
  if (!loaded.ok) return text(loaded.problem, true);

  const tool = loaded.tools.find((t) => t.name === name);
  if (!tool) {
    return text(
      `Spaces has no tool called "${name}". Available: ${loaded.tools.map((t) => t.name).join(", ")}.`,
      true
    );
  }

  const missing = requiredMissing(tool, args);
  if (missing.length) {
    return text(`${tool.name} needs ${missing.join(", ")}. Nothing was sent to Spaces.`, true);
  }

  return tool.readOnly ? snapshotAnswer(tool, args) : queueAction(tool, args);
}

/**
 * Only presence is checked. Types, enums and reference resolution are Spaces's job
 * — it is the side that can actually look things up, and duplicating half of
 * that here would give the agent two different opinions about the same call.
 */
function requiredMissing(tool, args) {
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  return required.filter((key) => {
    const v = args[key];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
}

/**
 * Append one line to .hq/actions.jsonl.
 *
 * Several agents can be mid-call at once, so this is a single appendFileSync of
 * one line with its terminating newline: an O_APPEND write of a small buffer
 * lands whole, at the end, without a seek, which is exactly the guarantee a
 * line-oriented queue needs. The file is never read-modify-written here — the
 * drain in Spaces owns truncation.
 */
function queueAction(tool, args) {
  const action = {
    id: `mcp-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    ts: Date.now(),
    source: CALL_SOURCE,
    op: tool.name,
    args,
    ...CALLER,
    // The one identifying fact this process always has. Spaces gives each agent its
    // own worktree, so the drain can map cwd back to the agent even when the
    // environment says nothing.
    cwd: process.cwd(),
    pid: process.pid,
  };

  let line;
  try {
    line = JSON.stringify(action);
  } catch (e) {
    return text(`arguments could not be encoded as JSON (${describe(e)}). Nothing was sent to Spaces.`, true);
  }
  if (Buffer.byteLength(line) + 1 > MAX_LINE_BYTES) {
    return text(
      `this call is ${Math.round(Buffer.byteLength(line) / 1024)} KB, over the ${MAX_LINE_BYTES / 1024} KB ` +
        `limit for a single queued action. Shorten the arguments — long prose belongs in a memory entry ` +
        `or a task description written in smaller pieces.`,
      true
    );
  }

  const file = join(ROOT, ACTIONS_REL);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`);
  } catch (e) {
    return text(
      `could not write ${ACTIONS_REL} in ${ROOT} (${describe(e)}). The call did not reach Spaces. ` +
        `Check that the project directory is writable.`,
      true
    );
  }

  const verdict =
    tool.effect === "auto"
      ? `Spaces applies ${tool.name} automatically — normally within a second or two of it landing in the queue.`
      : `${tool.name} changes or reassigns existing work, so Spaces is holding it for a human to approve or ` +
        `reject in the app. Do not assume it has happened, and do not send it again.`;

  return text(
    [
      `Queued with Spaces as ${action.id}.`,
      verdict,
      `This transport is one-way: the outcome is not sent back here. If you need to confirm it, re-read ` +
        `the generated files in ${SPACES_DIR}/ a moment later — Spaces regenerates them after every change.`,
    ].join("\n")
  );
}

/* ── read-only calls ──────────────────────────────────────────── */

/**
 * Read-only operations need an answer in the same turn, and this process cannot
 * reach Spaces's database — so it hands back the markdown mirror Spaces keeps in .hq/,
 * with the age of each file stated. A stale answer that says it is stale is
 * usable; a stale answer that presents itself as live is how an agent ends up
 * confidently acting on a task that was closed ten minutes ago.
 */
function snapshotAnswer(tool, args) {
  if (tool.name === "spaces_list_messages") {
    return messageListAnswer(args);
  }
  if (tool.name === "spaces_search_knowledge") {
    return knowledgeSearchAnswer(args);
  }
  if (tool.name === "spaces_read_knowledge") {
    return knowledgeReadAnswer(args);
  }
  if (tool.name === "spaces_list_content") {
    return contentListAnswer(args);
  }
  if (tool.name === "spaces_get_content") {
    return contentGetAnswer(args);
  }
  if (tool.name === "spaces_list_documents") {
    return documentListAnswer(args);
  }
  if (tool.name === "spaces_get_document") {
    return documentGetAnswer(args);
  }
  if (tool.name === "spaces_list_mail") {
    return mailListAnswer(args);
  }
  if (tool.name === "spaces_get_mail") {
    return mailGetAnswer(args);
  }
  if (tool.name === "spaces_list_calendar") {
    return calendarListAnswer(args);
  }
  if (tool.name === "spaces_list_social_accounts") {
    return socialAccountsAnswer(args);
  }
  if (tool.name === "spaces_git_status") {
    return gitStatusAnswer();
  }
  const parts = [];
  for (const rel of SNAPSHOT_RELS) {
    const path = join(ROOT, rel);
    try {
      parts.push({ rel, body: readFileSync(path, "utf8"), age: Date.now() - statSync(path).mtimeMs });
    } catch {
      // A project with no memory, no board or no links simply has no file yet.
    }
  }
  if (!parts.length) {
    return text(
      `${tool.name} is answered from Spaces's generated markdown, and none of ${SNAPSHOT_RELS.join(", ")} ` +
        `exists in ${ROOT} yet. Spaces writes those files for projects with a local checkout — open the ` +
        `project in Spaces, or ask a human to sync it.`,
      true
    );
  }

  const out = [
    `Snapshot, not a live answer. ${tool.name} cannot be run over MCP: this server has no access to ` +
      `Spaces's database, so what follows is Spaces's own markdown mirror of the same data.`,
    `Written ${parts.map((p) => `${p.rel.replace(`${SPACES_DIR}/`, "")} ${ago(p.age)}`).join(", ")} — anything ` +
      `Spaces changed since then is missing.`,
    `These files name things the way a person would: task titles, @handles, channel names. The write ` +
      `tools accept an exact title as well as a "type:id" reference, and Spaces tells you when a title is ` +
      `ambiguous rather than guessing.`,
  ];

  const needle = firstStringArg(args);
  if (needle) {
    const hits = [];
    for (const part of parts) {
      const lines = part.body.split("\n");
      for (let i = 0; i < lines.length && hits.length < 40; i++) {
        if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
          hits.push(`${part.rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    out.push(
      "",
      hits.length ? `## Lines mentioning "${needle}"` : `Nothing in the snapshot mentions "${needle}".`,
      ...(hits.length ? ["", hits.join("\n")] : [])
    );
  }

  for (const part of parts) {
    const body =
      part.body.length > MAX_SNAPSHOT_CHARS
        ? `${part.body.slice(0, MAX_SNAPSHOT_CHARS)}\n\n… truncated, ${
            part.body.length - MAX_SNAPSHOT_CHARS
          } more characters — read ${part.rel} directly for the rest.`
        : part.body;
    out.push("", `## ${part.rel}`, "", body.trimEnd());
  }
  return text(out.join("\n"));
}

function liveDb() {
  if (!DatabaseSync) return { ok: false, problem: "Live Spaces reads need Node 22.5 or newer." };
  const explicit = (process.env.SPACES_DB_PATH ?? "").trim();
  const candidates = explicit
    ? [explicit]
    : [
        join(homedir(), "Library", "Application Support", "app.spaces.desktop", "spaces.db"),
        join(homedir(), ".local", "share", "app.spaces.desktop", "spaces.db"),
      ];
  const path = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!path) {
    return {
      ok: false,
      problem:
        "Spaces's local database is unavailable on this agent host. Pair and open the desktop app first.",
    };
  }
  try {
    return { ok: true, db: new DatabaseSync(path, { readOnly: true }) };
  } catch (e) {
    return { ok: false, problem: `Spaces's local database could not be opened (${describe(e)}).` };
  }
}

function rows(sql, params = []) {
  const opened = liveDb();
  if (!opened.ok) return opened;
  try {
    const values = opened.db.prepare(sql).all(...params);
    return { ok: true, rows: values };
  } catch (e) {
    return { ok: false, problem: `Spaces could not read its local state (${describe(e)}).` };
  } finally {
    try {
      opened.db.close();
    } catch {
      // read-only connection; process exit is still a safe final fallback
    }
  }
}

function messageListAnswer(args) {
  const requested =
    typeof args.channel === "string"
      ? args.channel.replace(/^channel:/i, "").trim()
      : "";
  let channelId = requested || CALLER.channel_id;
  let channelName = "";
  if (requested) {
    const found = rows(
      `SELECT id, name
         FROM channels
        WHERE id = ? OR lower(name) = lower(?)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 2`,
      [requested, requested, requested],
    );
    if (!found.ok) return text(found.problem, true);
    if (found.rows.length !== 1) {
      return text(
        found.rows.length
          ? `"${requested}" matches more than one channel. Use channel:<id>.`
          : `No channel matches "${requested}".`,
        true,
      );
    }
    channelId = String(found.rows[0].id);
    channelName = String(found.rows[0].name);
  }
  if (!channelId) {
    return text(
      "spaces_list_messages needs channel because this process has no SPACES_CHANNEL_ID.",
      true,
    );
  }
  if (!channelName) {
    const current = rows("SELECT name FROM channels WHERE id = ? LIMIT 1", [channelId]);
    if (!current.ok) return text(current.problem, true);
    channelName = current.rows.length ? String(current.rows[0].name) : "";
  }

  const requestedLimit = Number(args.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 30;
  const since =
    typeof args.since === "number"
      ? args.since
      : typeof args.since === "string" && args.since.trim()
        ? Date.parse(args.since)
        : 0;
  const sinceAt = Number.isFinite(since) ? since : 0;
  const thread =
    typeof args.thread === "string"
      ? args.thread.replace(/^message:/i, "").trim()
      : "";
  const loaded = rows(
    `SELECT m.id, m.author_type AS authorType, m.author_name AS authorName,
            m.content, m.status, m.parent_id AS parentId,
            m.created_at AS createdAt, COALESCE(c.name, '') AS channelName
       FROM messages m
       LEFT JOIN channels c ON c.id = m.channel_id
      WHERE m.channel_id = ?
      ORDER BY m.created_at DESC
      LIMIT 250`,
    [channelId],
  );
  if (!loaded.ok) return text(loaded.problem, true);
  const matches = loaded.rows
    .filter((message) => Number(message.createdAt) >= sinceAt)
    .filter(
      (message) =>
        !thread || String(message.id) === thread || String(message.parentId) === thread,
    )
    .slice(0, limit)
    .reverse();
  if (!matches.length) {
    return text(`No messages match in #${channelName || channelId}.`);
  }
  return text(
    matches
      .map((message) => {
        const route = message.parentId
          ? ` · reply_to=message:${message.parentId}`
          : "";
        const body =
          String(message.content).length > 4_000
            ? `${String(message.content).slice(0, 4_000)}\n… truncated`
            : String(message.content);
        return (
          `message:${message.id} · ${new Date(Number(message.createdAt)).toISOString()} · ` +
          `${message.authorName} (${message.authorType}) [${message.status}]${route}\n${body}`
        );
      })
      .join("\n\n"),
  );
}

function documentListAnswer(args) {
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const requestedProject =
    typeof args.project === "string" ? args.project.trim() : "";
  const projectFilter =
    requestedProject.toLowerCase() === "all"
      ? ""
      : requestedProject || CALLER.project_id;
  const loaded = rows(
    `SELECT d.id, d.project_id AS projectId, d.title, d.path, d.tags,
            d.body, d.updated_at AS updatedAt, COALESCE(p.name, '') AS project
       FROM documents d
       LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.visibility = 'workspace'
      ORDER BY d.pinned DESC, d.path, d.updated_at DESC`,
  );
  if (!loaded.ok) return text(loaded.problem, true);
  const matches = loaded.rows
    .filter(
      (document) =>
        !projectFilter ||
        !document.projectId ||
        document.projectId === projectFilter ||
        String(document.project).toLowerCase() === projectFilter.toLowerCase(),
    )
    .filter(
      (document) =>
        !query ||
        `${document.title} ${document.path} ${document.tags} ${document.body}`
          .toLowerCase()
          .includes(query),
    )
    .slice(0, 100);
  if (!matches.length) return text("No shared documents match.");
  return text(
    matches
      .map(
        (document) =>
          `document:${document.id} — ${document.path || document.title} — ${document.title}` +
          `${document.tags ? ` [${document.tags}]` : ""}`,
      )
      .join("\n"),
  );
}

function documentGetAnswer(args) {
  const requested =
    typeof args.document === "string" ? args.document.replace(/^document:/i, "").trim() : "";
  if (!requested) return text("spaces_get_document needs document.", true);
  const loaded = rows(
    `SELECT id, project_id AS projectId, title, path, tags, body
       FROM documents
      WHERE visibility = 'workspace'
        AND (id = ? OR lower(title) = lower(?) OR lower(path) = lower(?))
      ORDER BY updated_at DESC`,
    [requested, requested, requested],
  );
  if (!loaded.ok) return text(loaded.problem, true);
  if (loaded.rows.length !== 1) {
    return text(
      loaded.rows.length
        ? `"${requested}" matches ${loaded.rows.length} shared documents. Use document:<id>.`
        : `No shared document matches "${requested}".`,
      true,
    );
  }
  const document = loaded.rows[0];
  return text(
    [
      `document:${document.id}`,
      `# ${document.title}`,
      `Path: ${document.path}`,
      `Tags: ${document.tags || "—"}`,
      "",
      document.body,
    ].join("\n"),
  );
}

function mailListAnswer(args) {
  const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim() : "inbox";
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const loaded = rows(
    `SELECT id, subject, from_name AS fromName, from_email AS fromEmail,
            to_email AS toEmail, preview, body, unread, received_at AS receivedAt
       FROM mail_threads
      WHERE folder = ?
      ORDER BY received_at DESC, updated_at DESC
      LIMIT 250`,
    [folder],
  );
  if (!loaded.ok) return text(loaded.problem, true);
  const matches = loaded.rows
    .filter(
      (message) =>
        !query ||
        `${message.fromName} ${message.fromEmail} ${message.toEmail} ${message.subject} ${message.preview} ${message.body}`
          .toLowerCase()
          .includes(query),
    )
    .slice(0, 50);
  if (!matches.length) return text(`No ${folder} mail matches.`);
  return text(
    matches
      .map(
        (message) =>
          `mail:${message.id} — ${message.subject}\n` +
          `from=${message.fromName || message.fromEmail || "—"} · to=${message.toEmail || "—"} · ` +
          `${message.unread ? "unread" : "read"}\n${message.preview || ""}`,
      )
      .join("\n\n"),
  );
}

function mailGetAnswer(args) {
  const requested =
    typeof args.mail === "string" ? args.mail.replace(/^mail:/i, "").trim() : "";
  if (!requested) return text("spaces_get_mail needs mail.", true);
  const loaded = rows(
    `SELECT id, subject, from_name AS fromName, from_email AS fromEmail,
            to_email AS toEmail, body, received_at AS receivedAt
       FROM mail_threads WHERE id = ? LIMIT 1`,
    [requested],
  );
  if (!loaded.ok) return text(loaded.problem, true);
  const message = loaded.rows[0];
  if (!message) return text("Mail message not found.", true);
  return text(
    [
      `mail:${message.id}`,
      `# ${message.subject}`,
      `From: ${message.fromName || message.fromEmail || "—"}`,
      `To: ${message.toEmail || "—"}`,
      `Received: ${new Date(Number(message.receivedAt) || 0).toISOString()}`,
      "",
      message.body || "",
    ].join("\n"),
  );
}

function calendarListAnswer(args) {
  const from = Date.parse(typeof args.from === "string" ? args.from : "") ||
    Date.now() - 30 * 86_400_000;
  const to = Date.parse(typeof args.to === "string" ? args.to : "") ||
    Date.now() + 365 * 86_400_000;
  const calendar = typeof args.calendar === "string" ? args.calendar.trim().toLowerCase() : "";
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const loaded = rows(
    `SELECT e.id, e.title, e.description, e.location, e.starts_at AS startsAt,
            e.ends_at AS endsAt, e.source, c.id AS calendarId, c.name AS calendar
       FROM events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.starts_at < ? AND e.ends_at > ? AND e.status != 'cancelled'
      ORDER BY e.starts_at
      LIMIT 1000`,
    [to, from],
  );
  if (!loaded.ok) return text(loaded.problem, true);
  const matches = loaded.rows
    .filter(
      (event) =>
        !calendar ||
        String(event.calendarId).toLowerCase() === calendar ||
        String(event.calendar).toLowerCase() === calendar,
    )
    .filter(
      (event) =>
        !query ||
        `${event.title} ${event.description} ${event.location}`
          .toLowerCase()
          .includes(query),
    )
    .slice(0, 250);
  if (!matches.length) return text("No visible calendar events match.");
  return text(
    matches
      .map(
        (event) =>
          `event:${event.id} — ${event.title}\n` +
          `${new Date(Number(event.startsAt)).toISOString()} → ${new Date(Number(event.endsAt)).toISOString()} · ` +
          `${event.calendar} · source=${event.source}`,
      )
      .join("\n\n"),
  );
}

function gitStatusAnswer() {
  const run = (args) =>
    spawnSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return text("This project checkout is not a Git worktree.", true);
  }
  const branch = run(["branch", "--show-current"]).stdout.trim() || "(detached)";
  const status = run(["status", "--short", "--branch"]).stdout.trim();
  const remotes = run(["remote", "-v"]).stdout
    .split("\n")
    .filter((line) => line && !/https?:\/\/[^\s@]+@/i.test(line))
    .join("\n");
  const commits = run(["log", "-5", "--oneline", "--decorate"]).stdout.trim();
  return text(
    [
      `# Git status — ${branch}`,
      "",
      status || "Working tree clean.",
      "",
      "## Remotes",
      remotes || "No remotes.",
      "",
      "## Recent commits",
      commits || "No commits yet.",
    ].join("\n"),
  );
}

function socialAccountsAnswer(args) {
  const requestedProject =
    typeof args.project === "string" ? args.project.trim() : "";
  const projectFilter =
    requestedProject.toLowerCase() === "all"
      ? ""
      : requestedProject || CALLER.project_id;
  const platform =
    typeof args.platform === "string" ? args.platform.trim().toLowerCase() : "";
  const provider = platform === "instagram" ? "meta" : platform === "tiktok" ? "tiktok" : "";
  const loaded = rows(
    `SELECT a.id, a.provider, a.label, a.handle, a.metadata
       FROM integration_accounts a
      WHERE a.category = 'social' AND a.status = 'connected'
      ORDER BY a.provider, a.handle, a.label`,
  );
  if (!loaded.ok) return text(loaded.problem, true);
  const projects = rows(`SELECT id, name FROM projects ORDER BY name`);
  if (!projects.ok) return text(projects.problem, true);
  const projectNames = new Map(projects.rows.map((project) => [project.id, project.name]));
  const matches = loaded.rows
    .map((account) => {
      let metadata = {};
      try {
        metadata = JSON.parse(account.metadata || "{}");
      } catch {
        metadata = {};
      }
      const links = Array.isArray(metadata.projectLinks) ? metadata.projectLinks : [];
      return { ...account, metadata, links };
    })
    .filter((account) => !provider || account.provider === provider)
    .filter(
      (account) =>
        !projectFilter ||
        account.links.some(
          (link) =>
            link.projectId === projectFilter ||
            String(projectNames.get(link.projectId) || "").toLowerCase() ===
              projectFilter.toLowerCase(),
        ),
    );
  if (!matches.length) {
    return text(
      projectFilter
        ? "No connected social account is linked to this project."
        : "No connected social accounts match.",
    );
  }
  return text(
    matches
      .map((account) => {
        const linked = account.links.length
          ? account.links
              .map((link) => {
                const name = projectNames.get(link.projectId) || link.projectId;
                return `${name}${link.isDefault ? " (default)" : ""}`;
              })
              .join(", ")
          : "workspace only";
        const network = account.provider === "meta" ? "instagram" : account.provider;
        const connection = account.metadata.connectionId || account.id.replace(/^portal-/, "");
        return (
          `${network}:${account.handle || account.label || connection}` +
          ` — connection=${connection} — projects=${linked}`
        );
      })
      .join("\n"),
  );
}

function contentSections() {
  const path = join(ROOT, CONTENT_REL);
  let raw;
  let age;
  try {
    raw = readFileSync(path, "utf8");
    age = Date.now() - statSync(path).mtimeMs;
  } catch (e) {
    return {
      ok: false,
      age: 0,
      sections: [],
      problem:
        `Spaces has not written ${CONTENT_REL} for this project (${describe(e)}). ` +
        "Open or sync the project in Spaces first.",
    };
  }
  const markers = [...raw.matchAll(/^<!-- spaces-content-ref: (content:[^\n]+) -->$/gm)];
  const sections = markers.map((marker, index) => {
    const start = marker.index ?? 0;
    const end = markers[index + 1]?.index ?? raw.length;
    const block = raw.slice(start, end).trim();
    const title = /^###\s+(.+)$/m.exec(block)?.[1]?.trim() ?? "Untitled";
    const field = (name) =>
      new RegExp(`^- ${name}:\\s*(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
    return {
      ref: marker[1].trim(),
      title,
      project: field("Project"),
      projectId: field("Project ID").replace(/^`|`$/g, ""),
      status: field("Status"),
      platform: field("Platform"),
      block,
    };
  });
  return { ok: true, age, sections, problem: "" };
}

function liveContentRows() {
  return rows(
    `SELECT c.id, c.project_id AS projectId, c.campaign, c.title, c.brief,
            c.copy, c.platform, c.connection_id AS connectionId, c.status,
            c.scheduled_at AS scheduledAt, c.published_url AS publishedUrl,
            c.media_url AS mediaUrl, c.publish_error AS publishError,
            c.updated_at AS updatedAt, COALESCE(p.name, '') AS project,
            COALESCE(a.name, '') AS owner
       FROM content_items c
       LEFT JOIN projects p ON p.id = c.project_id
       LEFT JOIN agents a ON a.id = c.agent_id
      ORDER BY c.updated_at DESC, c.created_at DESC, c.id`,
  );
}

function liveContentBlock(item) {
  return [
    `content:${item.id} — ${item.title}`,
    `stage=${item.status} · project=${item.project || "No project"} · platform=${item.platform}` +
      `${item.campaign ? ` · campaign=${item.campaign}` : ""}`,
    `owner=${item.owner || "Unassigned"} · connection=${item.connectionId || "not selected"}`,
    item.brief ? `brief:\n${item.brief}` : "brief: No brief yet.",
    item.copy ? `copy:\n${item.copy}` : "copy: No copy yet.",
    item.mediaUrl ? `media: ${item.mediaUrl}` : "media: None",
    item.scheduledAt
      ? `scheduled: ${new Date(Number(item.scheduledAt)).toISOString()}`
      : "scheduled: Not scheduled",
    item.publishedUrl ? `published: ${item.publishedUrl}` : "published: Not published",
    item.publishError ? `publish error: ${item.publishError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function contentListAnswer(args) {
  const requestedProject =
    typeof args.project === "string" ? args.project.trim() : "";
  const projectFilter =
    requestedProject.toLowerCase() === "all"
      ? ""
      : requestedProject || CALLER.project_id;
  const status =
    typeof args.status === "string" ? args.status.trim().toLowerCase() : "";
  const query =
    typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const live = liveContentRows();
  if (live.ok) {
    const matches = live.rows
      .filter(
        (item) =>
          !projectFilter ||
          item.projectId === projectFilter ||
          String(item.project).toLowerCase() === projectFilter.toLowerCase(),
      )
      .filter((item) => !status || String(item.status).toLowerCase() === status)
      .filter(
        (item) =>
          !query ||
          `${item.title} ${item.project} ${item.platform} ${item.campaign} ${item.brief} ${item.copy}`
            .toLowerCase()
            .includes(query),
      )
      .slice(0, 100);
    return text(
      matches.length
        ? [
            "Live Content Studio state from the paired Spaces desktop. Use an exact content:<id> for reads, updates, deletion, scheduling, or publishing.",
            "",
            ...matches.map(liveContentBlock),
          ].join("\n\n")
        : "No Content Studio cards match.",
    );
  }

  const loaded = contentSections();
  if (!loaded.ok) return text(`${live.problem}\n${loaded.problem}`, true);
  const matches = loaded.sections
    .filter(
      (section) =>
        !projectFilter ||
        section.projectId === projectFilter ||
        section.project.toLowerCase() === projectFilter.toLowerCase(),
    )
    .filter((section) => !status || section.status.toLowerCase() === status)
    .filter(
      (section) =>
        !query ||
        `${section.title}\n${section.project}\n${section.platform}\n${section.block}`
          .toLowerCase()
          .includes(query),
    )
    .slice(0, 100);
  if (!matches.length) {
    return text(
      `No Content Studio cards match in ${CONTENT_REL}. Snapshot written ${ago(loaded.age)}.`,
    );
  }
  return text(
    [
      `Content Studio snapshot written ${ago(loaded.age)}. Use an exact content:<id> with spaces_get_content or any update/publish tool.`,
      "",
      ...matches.map((section) => section.block),
    ].join("\n\n"),
  );
}

function contentGetAnswer(args) {
  const requested =
    typeof args.content === "string" ? args.content.trim() : firstStringArg(args);
  if (!requested) return text("spaces_get_content needs content.", true);
  const lowered = requested.toLowerCase();
  const live = liveContentRows();
  if (live.ok) {
    const matches = live.rows.filter(
      (item) =>
        `content:${item.id}`.toLowerCase() === lowered ||
        String(item.title).toLowerCase() === lowered,
    );
    if (matches.length !== 1) {
      return text(
        matches.length
          ? `"${requested}" matches ${matches.length} Content Studio cards. Use the exact content:<id>.`
          : `No Content Studio card matches "${requested}".`,
        true,
      );
    }
    return text(
      [
        "Live Content Studio state from the paired Spaces desktop.",
        `Use \`content:${matches[0].id}\` for updates, scheduling, deletion, or publishing.`,
        "",
        liveContentBlock(matches[0]),
      ].join("\n"),
    );
  }

  const loaded = contentSections();
  if (!loaded.ok) return text(`${live.problem}\n${loaded.problem}`, true);
  const exact = loaded.sections.filter(
    (section) =>
      section.ref.toLowerCase() === lowered ||
      section.title.toLowerCase() === lowered,
  );
  if (exact.length !== 1) {
    return text(
      exact.length
        ? `"${requested}" matches ${exact.length} Content Studio cards. Use the exact content:<id>.`
        : `No Content Studio card matches "${requested}" in ${CONTENT_REL}. Snapshot written ${ago(loaded.age)}.`,
      true,
    );
  }
  return text(
    [
      `Content Studio snapshot written ${ago(loaded.age)}.`,
      `Use \`${exact[0].ref}\` for updates, scheduling, deletion, or publishing.`,
      "",
      exact[0].block,
    ].join("\n"),
  );
}

function knowledgeSections() {
  const path = join(ROOT, KNOWLEDGE_REL);
  let raw;
  let age;
  try {
    raw = readFileSync(path, "utf8");
    age = Date.now() - statSync(path).mtimeMs;
  } catch (e) {
    return {
      ok: false,
      age: 0,
      sections: [],
      problem:
        `Spaces has not written ${KNOWLEDGE_REL} for this project (${describe(e)}). ` +
        "Open or sync the project in Spaces first.",
    };
  }
  const markers = [...raw.matchAll(/^<!-- spaces-knowledge-ref: ([^\n]+) -->$/gm)];
  const sections = markers.map((marker, index) => {
    const start = marker.index ?? 0;
    const end = markers[index + 1]?.index ?? raw.length;
    const block = raw.slice(start, end).trim();
    const title = /^###\s+(.+)$/m.exec(block)?.[1]?.trim() ?? "Untitled";
    const source = /^- Source:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
    const notePath = /^- Path:\s*`([^`]+)`$/m.exec(block)?.[1]?.trim() ?? "";
    return {
      ref: marker[1].trim(),
      title,
      source,
      path: notePath,
      block,
    };
  });
  return { ok: true, age, sections, problem: "" };
}

function knowledgeSearchAnswer(args) {
  const query = firstStringArg(args).toLowerCase();
  if (!query) return text("spaces_search_knowledge needs a query.", true);
  const loaded = knowledgeSections();
  if (!loaded.ok) return text(loaded.problem, true);
  const hits = loaded.sections
    .filter((section) =>
      [section.ref, section.title, section.source, section.path, section.block]
        .join("\n")
        .toLowerCase()
        .includes(query),
    )
    .slice(0, 25);
  if (!hits.length) {
    return text(
      `No workspace-visible Knowledge note in ${KNOWLEDGE_REL} mentions "${query}". ` +
        `Snapshot written ${ago(loaded.age)}.`,
    );
  }
  return text(
    [
      `Knowledge snapshot written ${ago(loaded.age)}. Use the exact reference with spaces_read_knowledge.`,
      "",
      ...hits.map((hit) => {
        const lines = hit.block
          .split("\n")
          .filter((line) => line && !line.startsWith("<!--") && !line.startsWith("- "))
          .slice(1)
          .join(" ")
          .replace(/\s+/g, " ")
          .slice(0, 240);
        return `- \`${hit.ref}\` — ${hit.source} / \`${hit.path}\` — ${hit.title}${lines ? `\n  ${lines}` : ""}`;
      }),
    ].join("\n"),
  );
}

function knowledgeReadAnswer(args) {
  const ref =
    typeof args.ref === "string" ? args.ref.trim() : firstStringArg(args);
  if (!ref) return text("spaces_read_knowledge needs a Knowledge reference.", true);
  const loaded = knowledgeSections();
  if (!loaded.ok) return text(loaded.problem, true);
  const exact = loaded.sections.find((section) => section.ref === ref);
  if (!exact) {
    return text(
      `No note has the exact reference "${ref}" in ${KNOWLEDGE_REL}. Search again rather than guessing; ` +
        `the snapshot was written ${ago(loaded.age)}.`,
      true,
    );
  }
  const body =
    exact.block.length > 80_000
      ? `${exact.block.slice(0, 80_000)}\n\n… truncated by the MCP response limit`
      : exact.block;
  return text(
    [
      `Knowledge snapshot written ${ago(loaded.age)}.`,
      `Cite this note as \`${exact.ref}\` or by its preserved path \`${exact.path}\`.`,
      "",
      body,
    ].join("\n"),
  );
}

/** The query an agent typed, whatever the operation happens to call it. */
function firstStringArg(args) {
  for (const key of ["query", "ref", "q", "search", "text", "title", "name"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function describe(e) {
  return e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
}

/* ── CLI + stdin loop ─────────────────────────────────────────── */

function runCliCall(index) {
  const name = (process.argv[index + 1] ?? "").trim();
  if (!name) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error:
          "usage: node $SPACES_CLI $SPACES_PROJECT_ROOT --call <tool> '<json-arguments>'",
      })}\n`,
    );
    process.exit(1);
  }
  let args = {};
  const raw = (process.argv[index + 2] ?? "").trim();
  if (raw) {
    try {
      args = JSON.parse(raw);
    } catch (e) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          tool: name,
          error: `arguments must be one JSON object (${describe(e)})`,
        })}\n`,
      );
      process.exit(1);
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        tool: name,
        error: "arguments must be one JSON object",
      })}\n`,
    );
    process.exit(1);
  }
  try {
    const result = toolsCall({ name, arguments: args });
    const output = Array.isArray(result.content)
      ? result.content
          .filter((part) => part?.type === "text")
          .map((part) => String(part.text ?? ""))
          .join("\n")
      : "";
    const ok = result.isError !== true;
    process.stdout.write(`${JSON.stringify({ ok, tool: name, output })}\n`);
    process.exit(ok ? 0 : 4);
  } catch (e) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, tool: name, error: describe(e) })}\n`,
    );
    process.exit(4);
  }
}

const cliCallIndex = process.argv.indexOf("--call");
if (cliCallIndex >= 0) {
  runCliCall(cliCallIndex);
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_INPUT_BYTES) {
      log(`dropped ${buffer.length} bytes with no newline in them — the client is not speaking ndjson`);
      buffer = "";
      return;
    }
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        // id null is the only honest answer: we could not read one.
        replyError(null, -32700, `could not parse message as JSON: ${describe(e)}`);
        continue;
      }
      try {
        handleMessage(msg);
      } catch (e) {
        log(`unhandled error: ${describe(e)}`);
      }
    }
  });

  // Closing stdin is how an MCP client shuts a stdio server down.
  process.stdin.on("end", () => process.exit(0));
  // The harness died mid-write; nothing left to serve.
  process.stdout.on("error", () => process.exit(0));
}
