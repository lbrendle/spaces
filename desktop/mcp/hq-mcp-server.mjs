#!/usr/bin/env node
/**
 * Spaces's MCP server — the harness-side end of the agent write path.
 *
 * This process is spawned by the harness (`claude`, or anything else that
 * speaks MCP) inside the user's checkout, in a different process from the Spaces
 * app, with no access to Spaces's SQLite database and no way to import a line of
 * Spaces's TypeScript. So it is deliberately the dumbest component in the system:
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
const SNAPSHOT_RELS = ["CONTEXT.md", "ROSTER.md", "BOARD.md", "LINKS.md"].map((n) => `${SPACES_DIR}/${n}`);

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
 * .mcp.json is per-project, so the project fields are always present, but the
 * agent, channel and run are per-run and Spaces does not currently put them in the
 * harness's environment. They are read anyway: the day `start_agent_run` adds
 * `.env("SPACES_AGENT_ID", …)`, every action starts arriving fully attributed with
 * no change here. Until then the drain attributes calls by `cwd`, which is the
 * agent's own worktree.
 */
const CALLER = {
  agent_id: (process.env.SPACES_AGENT_ID ?? "").trim(),
  run_id: (process.env.SPACES_RUN_ID ?? "").trim(),
  channel_id: (process.env.SPACES_CHANNEL_ID ?? "").trim(),
  project_id: (process.env.SPACES_PROJECT_ID ?? "").trim(),
};

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
    // Surfaced to the model by most clients: the one thing it genuinely cannot
    // infer from the tool list is that this transport is one-way.
    instructions:
      "These tools act on Spaces, the workspace this project is coordinated in. They are one-way: a call " +
      "is written to Spaces's action queue and applied by the app, so the tool result tells you the call " +
      "was accepted, never what it produced. Additive operations apply on their own; anything that " +
      "removes or reassigns existing work waits for a human. To see current state, read the generated " +
      "markdown in .hq/ (CONTEXT.md, ROSTER.md, BOARD.md, LINKS.md).",
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
    return "Answered from Spaces's generated markdown in .hq/, which is a snapshot a few seconds behind the app — this server cannot query Spaces live.";
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
    source: "mcp",
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

/* ── stdin loop ───────────────────────────────────────────────── */

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
