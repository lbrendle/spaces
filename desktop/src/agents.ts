import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted, requestPermission, sendNotification,
} from "@tauri-apps/plugin-notification";
import { getDb, uid, now } from "./db";
import { threadSlice } from "./threading";
import { useStore, channelAgents } from "./store";
import { slug } from "./types";
import type { EntityRef } from "./types";
import { sharedContext } from "./links";
import { drainActions, ensureActionsFile } from "./actions";
import { scheduleBlackboardSync } from "./blackboard";
import {
  ensureRuntimeContract,
  mcpCodexArgs,
  mcpServerPath,
  setupControlMcp,
  setupMcp,
} from "./mcpsetup";
import type {
  ActivityEvent, Agent, AgentKind, Channel, ChannelMode, Message, Project,
} from "./types";
import { ensureWorkspace, isGitRepo } from "./workspaces";
import { collaborationBlock, handoffNote } from "./collab";
import { isExternal } from "./capabilities";
import {
  composerMessage,
  replyPath,
  deliverToApp,
  describeOutcome,
  externalConfig,
  externalWorkdir,
  handOff,
  handoffPath,
  consumeReply,
  replyWaiting,
  settleHandOff,
} from "./external";
import { checkpointAfter, checkpointBefore, runDiff } from "./gitflow";
import {
  cliTokens,
  configuredEffort,
  resumeArgs,
} from "./capabilities";
import { registerCanceller, trackRun, untrackRun } from "./runbus";
import { dispatch } from "./orchestrator";
import { currentDeviceId } from "./deviceIdentity";
import { confirmAction } from "./toast";
import {
  acknowledgeRemoteJob,
  approveRemoteJob,
  cancelRemoteJob,
  completeRemoteJob,
  declineRemoteJob,
  enqueueRemoteJob,
  failRemoteJob,
  heartbeatRemoteJob,
  localIdForPortal,
  pendingRemoteJobs,
  pollRemoteJob,
  portalIdForLocal,
  startRemoteJob,
  remoteJobUpdates,
  type RemoteAgentJob,
} from "./portalJobs";
import {
  SPACES_BASE_PROMPT,
  SPACES_HARNESS_PROTOCOL,
  SPACES_RESUME_PROMPT,
  spacesContextEnvelope,
} from "./runtimeContract";

/** What caused an agent run: a user message or (via chaining) another agent's reply. */
export interface Trigger {
  content: string;
  authorType: "user" | "agent";
  authorId: string;
  authorName: string;
  /** Thread root of the triggering message ('' if it was top-level). */
  parentId: string;
  /** id of the triggering message itself. */
  msgId: string;
  /** Agent ids already in this chain, to stop loops. */
  chain: string[];
  /** Task this run was dispatched from, if any. */
  taskId?: string;
  /** Bounded local files for a Spaces-compatible HTTP turn. Never synced in agent config. */
  attachments?: Array<{
    name: string;
    mime_type: string;
    data_base64: string;
    sha256?: string;
  }>;
}

/** Per-turn knobs the orchestrator sets when it drives a run. */
export interface RunOptions {
  /** Thread root for the reply; defaults to the trigger's own thread. */
  parentId?: string;
  /** Turn-specific guidance (sequential position, delegation brief, synthesis ask). */
  note?: string;
  /** Internal: a host device received a fully composed prompt from the portal. */
  prebuiltPrompt?: string;
  /** Internal: this is already executing on the assigned host. */
  skipRemote?: boolean;
  /** Internal: stable id used by a leased remote job for cancellation. */
  runId?: string;
}

export interface RunResult {
  runId: string;
  agentId: string;
  agentName: string;
  /** "queued" is never produced by runAgent — only by the orchestrator's queue. */
  status: "done" | "error" | "cancelled" | "queued";
  content: string;
}

export interface RunState {
  channelId: string;
  msgId: string;
  agent: Agent;
  parts: string[];
  raw: string[];
  meta: string;
  liveActivity: string;
  activity: ActivityEvent[];
  sessionId: string;
  /** session stored for (channel, agent) when this run started — see the
   *  clear-session race note in handleEvent. */
  initialSessionId: string;
  startedAt: number;
  chain: string[];
  parentId: string;
  /** Where the harness runs. The git checkpoints bracket this directory. */
  cwd: string;
  /** HEAD before the harness started; "" when there was nothing to check point. */
  commitBefore: string;
  /** Subject for this run's checkpoint commit: "<agent>: <what it was asked>". */
  checkpointLabel: string;
  /** The raw harness stream, one stdout line as received per entry. Unlike
   *  `parts`/`activity` this keeps everything, including the events no adapter
   *  parses — claude's tool RESULTS arrive as type:"user" messages, and a
   *  transcript without them is only half the story. */
  transcript: string[];
  /** Running size of `transcript` (chars + newline), so the cap costs nothing. */
  transcriptBytes: number;
  transcriptDropped: number;
  transcriptDroppedBytes: number;
  /** Last time the live (store-only) transcript mirror was refreshed. */
  transcriptMirroredAt: number;
  /** Resolves runAgent's promise exactly once, when the run reaches a terminal state. */
  settle?: (r: RunResult) => void;
}

const runs = new Map<string, RunState>();
/** requester run id -> durable portal job id */
const remoteJobIds = new Map<string, string>();
const hostWorkers = new Set<string>();
let listening = false;
export const MAX_CHAIN = 3;

/** A long run can stream tens of MB; the stored transcript is capped at this. */
const MAX_TRANSCRIPT = 2 * 1024 * 1024;

/** …and no single event may take more than an eighth of it. */
const MAX_TRANSCRIPT_LINE = 256 * 1024;

/** Paths recorded in runs.files_changed — a repo-wide reformat isn't a useful list. */
const MAX_CHANGED_FILES = 500;

export async function initAgentListener() {
  if (listening) return;
  listening = true;
  registerCanceller((runId) => void cancelRun(runId));
  await listen<{ runId: string; kind: string; data: string; exitCode: number | null }>(
    "agent-event",
    (ev) => void handleEvent(ev.payload)
  );
}

/** Ask for notification permission once, at startup, instead of mid-run. */
export async function ensureNotifyPermission() {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // best-effort
  }
}

/* ------------------------------------------------------------------ *
 * Harness adapters
 * ------------------------------------------------------------------ */

/**
 * One CLI harness. Adding a third one is: implement this, register it below,
 * widen AgentKind in types.ts. Nothing else in the app knows about CLI shapes.
 */
export interface AgentAdapter {
  id: AgentKind;
  /**
   * "cli" spawns a process via Rust; "external" is never launched at all — the
   * agent runs in its own app and meets Spaces in the shared repo (see
   * external.ts).
   */
  transport?: "cli" | "external";
  /** Executable name; the Rust side resolves it on PATH. */
  program: string;
  /**
   * Where the prompt goes. "stdin" is the default and the only one that scales:
   * argv hits ARG_MAX with a big context. Harnesses that have no stdin reader
   * (cursor-agent, aider) declare "argv", and runAgent spills an oversized
   * prompt to a file rather than truncating it — see promptArg().
   */
  promptDelivery?: "stdin" | "argv";
  /** Codex needs an explicit "-" to mean "prompt follows on stdin". */
  buildArgs(agent: Agent, resumeSession: string, runtimeContractPath: string): string[];
  /** Session/thread id carried by this event, '' when it carries none. */
  extractSessionId(obj: any): string;
  /** Fold one already-parsed stream event into the run's state. The JSON parse
   *  and the non-JSON passthrough are shared, in handleLine. */
  parseLine(obj: any, run: RunState): void;
}

const claudeAdapter: AgentAdapter = {
  id: "claude",
  program: "claude",

  buildArgs(agent, resumeSession, runtimeContractPath) {
    const extra = cliTokens(agent.kind, agent.cli_args ?? "");
    let hasPermissionMode = false;
    for (let index = 0; index < extra.length; index++) {
      const value = extra[index];
      if (value === "--permission-mode") {
        hasPermissionMode = true;
        // acceptEdits was Spaces's old default. It cannot answer a permission
        // prompt in print mode, so existing agents using that generated value
        // are upgraded to the headless full-access mode automatically.
        if (extra[index + 1] === "acceptEdits") {
          extra[index + 1] = "bypassPermissions";
        }
      } else if (value.startsWith("--permission-mode=")) {
        hasPermissionMode = true;
        if (value === "--permission-mode=acceptEdits") {
          extra[index] = "--permission-mode=bypassPermissions";
        }
      }
    }
    if (!hasPermissionMode) {
      extra.push("--permission-mode", "bypassPermissions");
    }
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resumeSession) args.push("--resume", resumeSession);
    if (agent.model) args.push("--model", agent.model);
    if (runtimeContractPath) {
      args.push("--append-system-prompt-file", runtimeContractPath);
    }
    return [...args, ...extra];
  },

  extractSessionId(obj) {
    if ((obj.type === "system" || obj.type === "result") && obj.session_id) {
      return String(obj.session_id);
    }
    return "";
  },

  parseLine(obj, run) {
    if (obj.type === "system" && obj.session_id) {
      pushActivity(run, "info", `session ${String(obj.session_id).slice(0, 8)} · ${obj.model ?? ""}`);
    } else if (obj.type === "assistant" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          run.parts.push(block.text);
          run.liveActivity = "";
          pushActivity(run, "text", block.text.slice(0, 200));
        } else if (block.type === "tool_use") {
          run.liveActivity = `⚙︎ using ${block.name}…`;
          const input = block.input ? JSON.stringify(block.input).slice(0, 200) : "";
          pushActivity(run, "tool", `${block.name} ${input}`);
        }
      }
    } else if (obj.type === "result") {
      if (!run.parts.length && typeof obj.result === "string" && obj.result) {
        run.parts.push(obj.result);
      }
      const bits: string[] = [];
      if (obj.num_turns) {
        bits.push(`${obj.num_turns} ${obj.num_turns === 1 ? "turn" : "turns"}`);
      }
      if (typeof obj.total_cost_usd === "number") bits.push(`$${obj.total_cost_usd.toFixed(3)}`);
      if (obj.duration_ms) bits.push(`${Math.round(obj.duration_ms / 1000)}s`);
      run.meta = bits.join(" · ");
      run.liveActivity = "";
    }
  },
};

const codexAdapter: AgentAdapter = {
  id: "codex",
  program: "codex",

  buildArgs(agent, resumeSession) {
    if (resumeSession) {
      // `codex exec resume` rejects exec-only flags (--sandbox, --add-dir,
      // --profile). resumeArgs() drops those and maps --sandbox X to the
      // equivalent -c sandbox_mode="X", which resume does accept.
      const args = ["exec", "resume", resumeSession, "--json"];
      if (agent.model) args.push("-c", `model="${agent.model}"`);
      return [...args, ...cliTokens(agent.kind, resumeArgs("codex", agent.cli_args ?? "")), "-"];
    }
    const args = ["exec", "--json"];
    if (agent.model) args.push("-m", agent.model);
    return [...args, ...cliTokens(agent.kind, agent.cli_args ?? ""), "-"];
  },

  extractSessionId(obj) {
    if (obj.type === "thread.started" && obj.thread_id) return String(obj.thread_id);
    if (obj.msg?.type === "session_configured" && obj.msg.session_id) return String(obj.msg.session_id);
    return "";
  },

  parseLine(obj, run) {
    const item = obj.item;
    if (obj.type === "thread.started" && obj.thread_id) {
      pushActivity(run, "info", `thread ${String(obj.thread_id).slice(0, 8)}`);
    } else if (obj.type === "item.completed" && item) {
      const t = item.type ?? item.item_type;
      if (t === "agent_message" && item.text) {
        run.parts.push(item.text);
        run.liveActivity = "";
        pushActivity(run, "text", item.text.slice(0, 200));
      } else if (t === "reasoning") {
        run.liveActivity = "🧠 thinking…";
      } else if (t === "command_execution") {
        pushActivity(run, "tool", `shell ${(item.command ?? "").slice(0, 200)}`);
        run.liveActivity = "";
      } else if (t === "file_change" || t === "patch_apply") {
        pushActivity(run, "tool", `edit ${JSON.stringify(item.changes ?? item.path ?? "").slice(0, 200)}`);
      }
    } else if (obj.type === "item.started" && item?.type === "command_execution") {
      run.liveActivity = `⚙︎ running: ${(item.command ?? "").slice(0, 60)}`;
    } else if (obj.msg?.type === "agent_message" && obj.msg.message) {
      run.parts.push(obj.msg.message);
      pushActivity(run, "text", String(obj.msg.message).slice(0, 200));
    } else if (obj.type === "turn.completed") {
      const u = obj.usage;
      if (u?.input_tokens != null) run.meta = `${(u.input_tokens ?? 0) + (u.output_tokens ?? 0)} tokens`;
      run.liveActivity = "";
    }
  },
};

/**
 * Cursor Agent. Verified against `cursor-agent --help` (2026.06): it takes the
 * prompt as a positional argument — there is no stdin reader — and streams the
 * same broad shape as Claude's stream-json, so the parser tolerates both.
 */
const cursorAdapter: AgentAdapter = {
  id: "cursor",
  program: "cursor-agent",
  promptDelivery: "argv",

  buildArgs(agent, resumeSession) {
    const args = ["-p", "--output-format", "stream-json"];
    if (resumeSession) args.push("--resume", resumeSession);
    if (agent.model) args.push("--model", agent.model);
    return [...args, ...cliTokens(agent.kind, agent.cli_args ?? "")];
  },

  extractSessionId(obj) {
    return String(obj.chat_id ?? obj.chatId ?? obj.session_id ?? obj.sessionId ?? "");
  },

  parseLine(obj, run) {
    if (obj.type === "system" && (obj.chat_id || obj.session_id)) {
      pushActivity(run, "info", `chat ${String(obj.chat_id ?? obj.session_id).slice(0, 8)} · ${obj.model ?? ""}`);
      return;
    }
    if (obj.type === "assistant" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          run.parts.push(block.text);
          run.liveActivity = "";
          pushActivity(run, "text", block.text.slice(0, 200));
        } else if (block.type === "tool_use" || block.type === "tool_call") {
          const name = String(block.name ?? block.tool ?? "tool");
          run.liveActivity = `⚙︎ using ${name}…`;
          pushActivity(run, "tool", `${name} ${block.input ? JSON.stringify(block.input).slice(0, 200) : ""}`);
        }
      }
      return;
    }
    if (obj.type === "result") {
      if (!run.parts.length && typeof obj.result === "string" && obj.result) run.parts.push(obj.result);
      const bits: string[] = [];
      if (obj.duration_ms) bits.push(`${Math.round(obj.duration_ms / 1000)}s`);
      if (obj.usage?.total_tokens) bits.push(`${obj.usage.total_tokens} tokens`);
      run.meta = bits.join(" · ");
      run.liveActivity = "";
    }
  },
};

/**
 * An agent Spaces does not launch.
 *
 * Muse, the Cursor app, Zed's agent, a Claude Code terminal someone drives by
 * hand — all of them edit the same repository, and none of them can be spawned
 * headlessly. Representing them as agents is not cosmetic: it is what lets the
 * branch lanes, the overlap check, the merge queue and every other agent's
 * prompt account for work Spaces did not start.
 *
 * A "run" for one of these is a hand-off: external.ts writes the brief and
 * records what the agent's tree looked like when it was handed over, so the
 * next turn can say what actually changed. The adapter parses nothing.
 */
const externalAdapter: AgentAdapter = {
  id: "external",
  transport: "external",
  program: "",

  buildArgs() {
    return [];
  },

  extractSessionId() {
    return "";
  },

  parseLine() {
    // nothing streams; external.ts drives the run to completion directly
  },
};

/**
 * The harness registry, keyed the same way capabilities.ts keys its manifest.
 * Adding one is: write an adapter, register it here, add its HarnessMeta and
 * option list. Nothing else in the app knows about CLI shapes.
 */
const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  external: externalAdapter,
};

/**
 * An unknown kind — an agent row synced from a newer build, or from a paired
 * device that supports a harness this one does not — is treated as external.
 * It stays a visible teammate with a branch and a hand-off, and Spaces starts
 * no process for it. Running an unrecognised value as an executable is the one
 * thing that must not happen here.
 */
export function adapterFor(agent: Agent): AgentAdapter {
  return ADAPTERS[agent.kind] ?? externalAdapter;
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

async function handleEvent(p: { runId: string; kind: string; data: string; exitCode: number | null }) {
  const run = runs.get(p.runId);
  if (!run) return;
  const store = useStore.getState();

  if (p.kind === "line") {
    handleLine(run, p.data);
    store.patchMessageLocal(run.channelId, run.msgId, {
      content: renderContent(run),
      meta: run.liveActivity,
    });
    void store.patchRun(run.msgId, { activity: JSON.stringify(run.activity) }, false);
    mirrorTranscript(run);
    return;
  }
  if (p.kind === "stderr") {
    pushActivity(run, "stderr", p.data.slice(0, 300));
    return;
  }
  if (p.kind !== "done" && p.kind !== "error") return;

  runs.delete(p.runId);
  untrackRun(p.runId);
  let content = renderContent(run);
  let status: "done" | "error" = "done";
  if (p.kind === "error") {
    status = "error";
    const errTail = p.data.trim().split("\n").slice(-6).join("\n");
    content = content
      ? `${content}\n\n> ⚠️ run failed (exit ${p.exitCode ?? "?"})${errTail ? `\n> ${errTail.replace(/\n/g, "\n> ")}` : ""}`
      : `⚠️ Agent run failed (exit ${p.exitCode ?? "?"}).\n\n\`\`\`\n${errTail || "no error output"}\n\`\`\``;
  } else if (!content) {
    content = "_(no output)_";
  }

  store.patchMessageLocal(run.channelId, run.msgId, { content, status, meta: run.meta });
  void store.persistMessage(run.msgId, { content, status, meta: run.meta });
  await store.patchRun(run.msgId, {
    status,
    meta: run.meta,
    session_id: run.sessionId,
    activity: JSON.stringify(run.activity),
    transcript: transcriptText(run),
    finished_at: now(),
  });
  store.markRunActive(run.msgId, false);

  // Drain anything the agent dropped for Spaces to apply. Both write transports
  // land in the same .hq/actions.jsonl: the MCP server appends to it, and an
  // agent can append to it directly. Read from the run's own cwd as well as
  // the project checkout — an isolated agent works in its own worktree, and
  // its queue file lives there, not in the main repo.
  void drainRunActions(run);
  // The turn just changed the board, the memory or the links — refresh what
  // the next agent will read before it reads it.
  const runProject = store.channels.find((c) => c.id === run.channelId)?.project_id;
  if (runProject) scheduleBlackboardSync(runProject);

  // If the user hit "reset session" while this run was in flight, honor the
  // reset: only persist the session when the stored one still matches what
  // this run started from.
  if (run.sessionId && store.getSession(run.channelId, run.agent.id) === run.initialSessionId) {
    void store.setSession(run.channelId, run.agent.id, run.sessionId);
  }

  // Close the git bracket BEFORE settling. Everything downstream — chaining,
  // lead delegation, the next turn of a sequential round — hangs off settle(),
  // and the teammate that runs next has to see this turn's work as commits,
  // not as a dirty tree it might trip over (and handoffFor reads commit_after).
  // .catch as a backstop: an unsettled run would hang its channel's queue
  // forever, and no git bookkeeping is worth that.
  await checkpoint(run).catch(() => {});

  void notifyIfBackground(run, status, content);

  // What happens next (queue drain, chaining, the next step of a lead/panel
  // round) belongs to the orchestrator — it awaits this promise.
  settle(run, status, content);
}

/**
 * Commit whatever the turn left on disk and record what it touched, so the run
 * can be diffed and reverted later.
 *
 * Pure bookkeeping: a repo without a commit identity, a rejecting pre-commit
 * hook, an unresolved merge or a dead DB all end the same way — the run is not
 * checkpointed, the reply is untouched, and nothing throws.
 */
function checkpoint(run: RunState): Promise<void> {
  if (!run.cwd) return Promise.resolve();
  // Two agents in a shared checkout finish at once often enough to matter: git
  // would fail one of them on index.lock, and `add -A` would hand one agent's
  // work to the other's commit. One at a time per directory — the second one
  // then finds a clean tree and honestly records that it committed nothing.
  const prev = checkpointing.get(run.cwd) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => checkpointNow(run));
  checkpointing.set(run.cwd, next);
  void next.finally(() => {
    if (checkpointing.get(run.cwd) === next) checkpointing.delete(run.cwd);
  });
  return next;
}

/** cwd → the checkpoint currently running there. Never holds a rejected promise. */
const checkpointing = new Map<string, Promise<void>>();

async function checkpointNow(run: RunState) {
  try {
    const after = await checkpointAfter(run.cwd, run.checkpointLabel);
    const { files } = await runDiff(run.cwd, run.commitBefore, after);
    await useStore.getState().patchRun(run.msgId, {
      commit_after: after,
      files_changed: files.slice(0, MAX_CHANGED_FILES).join("\n"),
    });
  } catch (e) {
    console.error("[hq] checkpoint failed", e);
  }
}

/**
 * Apply whatever this run asked Spaces to do, and say so in the channel.
 *
 * Deliberately after the run is settled and never awaited by the caller: an
 * agent's turn must not appear to hang because a queue file was slow, and a
 * malformed drop must not fail the run that produced it.
 */
async function drainRunActions(run: RunState): Promise<void> {
  try {
    const store = useStore.getState();
    const channel = store.channels.find((c) => c.id === run.channelId);
    const projectId = channel?.project_id ?? "";
    if (!projectId) return;
    const project = store.projects.find((p) => p.id === projectId);
    const roots = [project?.local_path ?? "", run.cwd].filter(Boolean);
    if (!roots.length) return;

    const report = await drainActions(
      projectId,
      { agentId: run.agent.id, projectId, channelId: run.channelId, runId: run.msgId },
      roots
    );
    if (!report.lines.length && !report.errors.length) return;

    // Surface it as a system message rather than a toast: what an agent changed
    // belongs in the channel's history next to the reply that changed it.
    const parts: string[] = [];
    if (report.applied) parts.push(`${report.applied} applied`);
    if (report.pending) parts.push(`${report.pending} waiting on you`);
    if (report.failed) parts.push(`${report.failed} failed`);
    await store.insertMessage({
      id: uid(),
      channel_id: run.channelId,
      author_type: "system",
      author_id: "",
      author_name: "Spaces",
      content:
        `**${run.agent.name}** changed the workspace — ${parts.join(" · ")}\n\n` +
        report.lines.map((l) => `- ${l}`).join("\n") +
        (report.errors.length ? `\n\n> ${report.errors.join("\n> ")}` : ""),
      status: "done",
      meta: "",
      parent_id: "",
      run_id: run.msgId,
    });
  } catch (e) {
    console.error("[hq] action drain failed", e);
  }
}

function settle(run: RunState, status: RunResult["status"], content: string) {
  const fn = run.settle;
  run.settle = undefined;
  fn?.({ runId: run.msgId, agentId: run.agent.id, agentName: run.agent.name, status, content });
}

async function notifyIfBackground(run: RunState, status: string, content: string) {
  const s = useStore.getState();
  const v = s.view;
  const inChannel =
    (v.type === "channel" || v.type === "workspace") &&
    v.channelId === run.channelId &&
    document.hasFocus();
  if (inChannel) return;
  try {
    const ok = await isPermissionGranted();
    if (ok) {
      const chan = s.channels.find((c) => c.id === run.channelId);
      sendNotification({
        title: `${run.agent.name} ${status === "done" ? "replied" : "failed"} in #${chan?.name ?? "?"}`,
        body: content.replace(/[#*`>]/g, "").slice(0, 120),
      });
    }
  } catch {
    // notifications are best-effort
  }
}

function pushActivity(run: RunState, kind: ActivityEvent["kind"], detail: string) {
  run.activity.push({ t: now() - run.startedAt, kind, detail });
  if (run.activity.length > 400) run.activity.splice(0, run.activity.length - 400);
}

/**
 * Keep one raw stream line, dropping the oldest ones once the run has streamed
 * more than MAX_TRANSCRIPT. Truncating from the front is deliberate: the tail
 * is what the user is looking at when a run goes wrong.
 */
function recordTranscript(run: RunState, line: string) {
  // A single tool result can carry an entire file. Elide the tail of a monster
  // event rather than let it evict the whole rest of the stream — and so that
  // one retained line can never exceed the cap on its own.
  const kept =
    line.length > MAX_TRANSCRIPT_LINE
      ? `${line.slice(0, MAX_TRANSCRIPT_LINE)} …[Spaces elided ${line.length - MAX_TRANSCRIPT_LINE} chars]`
      : line;
  run.transcript.push(kept);
  run.transcriptBytes += kept.length + 1;
  while (run.transcriptBytes > MAX_TRANSCRIPT && run.transcript.length > 1) {
    const gone = run.transcript.shift()!;
    run.transcriptBytes -= gone.length + 1;
    run.transcriptDropped++;
    run.transcriptDroppedBytes += gone.length + 1;
  }
}

/** How often the run inspector's live transcript is refreshed mid-run. */
const TRANSCRIPT_MIRROR_MS = 1000;

/**
 * Keep the store's copy of the transcript roughly current so the inspector can
 * follow a run live. Store-only — never a DB write — and throttled, because
 * re-joining the whole stream on every event would make a long run quadratic.
 * The authoritative write happens once, when the run settles.
 */
function mirrorTranscript(run: RunState) {
  const t = now();
  if (t - run.transcriptMirroredAt < TRANSCRIPT_MIRROR_MS) return;
  run.transcriptMirroredAt = t;
  void useStore.getState().patchRun(run.msgId, { transcript: transcriptText(run) }, false);
}

/** The transcript as stored: JSON per line, with a marker if the front was cut. */
function transcriptText(run: RunState): string {
  if (!run.transcript.length) return "";
  const body = run.transcript.join("\n");
  if (!run.transcriptDropped) return body;
  const n = run.transcriptDropped;
  const kb = Math.round(run.transcriptDroppedBytes / 1024);
  return `--- Spaces dropped the first ${n} event${n === 1 ? "" : "s"} (~${kb} KB) to cap this transcript at ${MAX_TRANSCRIPT / (1024 * 1024)} MB ---\n${body}`;
}

function handleLine(run: RunState, line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;
  // The transcript is the stream verbatim — recorded before parsing, so events
  // the adapters deliberately ignore (tool results) are still in it.
  recordTranscript(run, trimmed);
  const adapter = adapterFor(run.agent);
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Not a stream protocol. Every supported harness emits one, so a plain line
    // is either a warning or a crash message — keep it verbatim rather than
    // guessing at which half of it was meant to be the reply.
    run.raw.push(line);
    return;
  }
  const sid = adapter.extractSessionId(obj);
  if (sid) run.sessionId = sid;
  adapter.parseLine(obj, run);
}

function renderContent(run: RunState): string {
  if (run.parts.length) {
    const joined = run.parts.join("\n\n");
    return joined;
  }
  return run.raw.join("\n");
}


/* ------------------------------------------------------------------ *
 * Prompt composition
 * ------------------------------------------------------------------ */

function label(m: Message): string {
  return m.author_type === "agent" ? `${m.author_name} (agent)` : m.author_name;
}

function speaker(t: Trigger): string {
  return t.authorType === "agent" ? `${t.authorName} (agent)` : t.authorName;
}

/** Charters of the teams this agent belongs to that are members of this channel. */
function teamCharters(channelId: string, agentId: string) {
  const s = useStore.getState();
  const teamIds = s.channelMembers
    .filter((m) => m.channel_id === channelId && m.member_type === "team")
    .map((m) => m.member_id);
  const mine = s.teamMembers
    .filter((tm) => tm.agent_id === agentId && teamIds.includes(tm.team_id))
    .map((tm) => tm.team_id);
  return s.teams.filter((t) => mine.includes(t.id) && (t.charter ?? "").trim());
}

function rosterLine(o: Agent, isLead: boolean): string {
  const bits: string[] = [o.role.trim() || o.kind];
  if (o.owns.trim()) bits.push(`owns ${o.owns.trim()}`);
  if (o.persona.trim()) bits.push(o.persona.trim().slice(0, 120));
  if (isLead) bits.push("channel lead");
  return `- @${slug(o.name)} — ${bits.join(" · ")}`;
}

/** How this agent hands work off, which depends entirely on the channel's mode. */
function handoffRule(channel: Channel, agent: Agent, members: Agent[], others: Agent[]): string {
  const lead = leadAgent(channel, members);
  if (channel.mode === "panel") {
    return "This channel answers as a panel: give your own independent answer rather than handing work to a teammate.";
  }
  if (channel.mode === "lead" && lead && lead.id !== agent.id) {
    return `${lead.name} leads this channel: report back here and let them route anything outside your area — mentioning other teammates yourself won't start them.`;
  }
  if (!channel.chaining) {
    return "Mentions don't start teammates in this channel — say what you need from them and the user will route it.";
  }
  return `You may mention a teammate (e.g. @${slug(others[0].name)}) in your reply to hand work off or request a review — mentioning them triggers them.`;
}

function projectRoot(project: Project | undefined, cwd: string): string {
  return (project?.local_path || cwd).replace(/\/+$/, "");
}

function contextEnvelope(
  runId: string,
  agent: Agent,
  channel: Channel,
  project: Project | undefined,
  trigger: Trigger,
  cwd: string,
  replyTo: string,
  sessionMode: "new" | "resume",
): string {
  return spacesContextEnvelope({
    runId,
    agentId: agent.id,
    agentName: agent.name,
    projectId: project?.id ?? "",
    projectName: project?.name ?? "Spaces",
    projectRoot: projectRoot(project, cwd),
    workingDirectory: cwd,
    channelId: channel.id,
    channelName: channel.name,
    eventId: trigger.msgId,
    replyTo,
    authorId: trigger.authorId,
    authorName: trigger.authorName,
    authorType: trigger.authorType,
    taskId: trigger.taskId ?? "",
    sessionMode,
  });
}

/** How many messages of a thread are quoted before the middle is elided. */
const THREAD_LIMIT = 40;
/** How many other channels the "elsewhere" digest names. */
const ELSEWHERE_LIMIT = 6;

/**
 * The thread this turn belongs to, whole.
 *
 * Without this an agent answering in a thread was shown the channel's last
 * twenty-five messages and nothing else — so a reply to a thread that started
 * a hundred messages ago arrived with the question missing. It looked like an
 * agent ignoring context; it was an agent that had never been given it.
 *
 * The thread is rendered separately from the ambient conversation and first,
 * because it is what the turn is actually about. Long threads keep their head
 * and their tail: the opening is what the thread is *for*, and the end is
 * where it got to.
 */
function threadContext(channel: Channel, trigger: Trigger): { block: string; shown: Set<string> } {
  const shown = new Set<string>();
  if (!trigger.parentId) return { block: "", shown };

  const all = useStore.getState().messages[channel.id] ?? [];
  const slice = threadSlice(all, trigger.parentId, trigger.msgId, THREAD_LIMIT);
  if (!slice.messages.length) return { block: "", shown };

  const lines = [`\n## This thread`];
  slice.messages.forEach((m, index) => {
    shown.add(m.id);
    // The gap goes where it actually is: after the head, before the tail.
    if (slice.elided > 0 && index === Math.floor(THREAD_LIMIT / 2)) {
      lines.push(`… ${slice.elided} replies in the middle of this thread are not shown …`);
    }
    lines.push(`[${label(m)}]: ${m.content.slice(0, 1500)}`);
  });
  return { block: lines.join("\n"), shown };
}

/**
 * What the rest of this project has been doing.
 *
 * A channel is a thread of work, so its conversation is deliberately its own —
 * but that left a new channel knowing the project's memory and tasks and
 * nothing at all about what anyone was actually working on. One line per other
 * active channel is what somebody gets by glancing at the sidebar, and it is
 * most of the value for a fraction of the words.
 *
 * Asked of the database rather than the store: the store only holds channels
 * somebody has opened, and the ones worth reporting are usually the ones this
 * agent has never been in.
 */
export async function elsewhereInProject(
  project: Project | undefined,
  channelId: string
): Promise<string> {
  if (!project) return "";
  try {
    const db = await getDb();
    const rows = await db.select<
      { name: string; author_name: string; content: string; created_at: number }[]
    >(
      `SELECT c.name AS name, m.author_name AS author_name, m.content AS content,
              m.created_at AS created_at
         FROM channels c
         JOIN messages m ON m.id = (
           SELECT m2.id FROM messages m2
            WHERE m2.channel_id = c.id AND m2.status <> 'running'
            ORDER BY m2.created_at DESC LIMIT 1
         )
        WHERE c.project_id = $1 AND c.id <> $2
        ORDER BY m.created_at DESC
        LIMIT $3`,
      [project.id, channelId, ELSEWHERE_LIMIT]
    );
    if (!rows.length) return "";
    const lines = [`\n## Elsewhere in this project`];
    for (const row of rows) {
      const gist = row.content.replace(/\s+/g, " ").trim().slice(0, 140);
      const when = new Date(row.created_at).toISOString().slice(0, 10);
      lines.push(`- #${row.name} (${when}) — ${row.author_name}: ${gist}`);
    }
    lines.push(
      `Use spaces_list_messages to read any of these properly before acting on them.`
    );
    return lines.join("\n");
  } catch {
    // Orientation is a nicety. A run must not fail because one query did.
    return "";
  }
}

function buildFreshPrompt(
  runId: string,
  agent: Agent,
  channel: Channel,
  project: Project | undefined,
  trigger: Trigger,
  cwd: string,
  replyTo: string,
  isolated: boolean,
  note: string,
  collab: string
): string {
  const s = useStore.getState();
  const lines: string[] = [];
  lines.push(
    SPACES_BASE_PROMPT,
    "",
    contextEnvelope(runId, agent, channel, project, trigger, cwd, replyTo, "new"),
    "",
    `You are "${agent.name}", an AI teammate in #${channel.name}. Humans and other AI agents read and write here.`
  );

  // Layered standing context, widest scope first: project → team → channel → you.
  if (project?.instructions.trim()) {
    lines.push(`\n## Standing instructions for this project\n${project.instructions.trim()}`);
  }
  for (const t of teamCharters(channel.id, agent.id)) {
    lines.push(`\n## Charter — ${t.name} team\n${t.charter.trim()}`);
  }
  if (channel.charter.trim()) {
    lines.push(`\n## Charter — #${channel.name}\n${channel.charter.trim()}`);
  }

  const roleBits: string[] = [];
  if (agent.role.trim()) roleBits.push(`Title: ${agent.role.trim()}`);
  if (agent.owns.trim()) roleBits.push(`You own: ${agent.owns.trim()}`);
  if (agent.persona.trim()) roleBits.push(agent.persona.trim());
  if (channel.lead_agent_id === agent.id && (channel.mode === "lead" || channel.mode === "panel")) {
    roleBits.push("You are the lead of this channel: you triage incoming work, delegate it to teammates, and report the outcome back to the user.");
  }
  if (roleBits.length) lines.push(`\n## Your role\n${roleBits.join("\n")}`);

  if (project) {
    lines.push(`\n## Project`);
    if (project.description) lines.push(`Description: ${project.description}`);
    if (project.repo) lines.push(`GitHub repo: ${project.repo}`);
    if (cwd) lines.push(`Your working directory: ${cwd}${isolated ? " (your private git workspace on your own branch — commit freely)" : " (a shared checkout — other agents and the user work here too; do not switch branches or commit unless asked)"}`);
    if (channel.topic) lines.push(`Channel topic: ${channel.topic}`);

    const mem = s.memory.filter((m) => m.project_id === project.id).slice(0, 12);
    if (mem.length) {
      lines.push(`\n## Project memory (shared context, decisions, notes)`);
      for (const m of mem) lines.push(`- [${m.kind}] ${m.title}: ${m.content.slice(0, 500)}`);
    }

    const open = s.tasks.filter((t) => t.project_id === project.id && t.status !== "done");
    if (open.length) {
      lines.push(`\n## Open tasks`);
      for (const t of open.slice(0, 15)) {
        const who = t.assignee_agent_id ? s.agents.find((a) => a.id === t.assignee_agent_id)?.name : null;
        lines.push(`- (${t.status}) ${t.title}${who ? ` — assigned to ${who}` : ""}`);
      }
    }
  }

  const members = rosterAgents(channel.id);
  const others = members.filter((a) => a.id !== agent.id);
  if (others.length) {
    lines.push(`\n## Teammates in this channel`);
    for (const o of others) lines.push(rosterLine(o, channel.lead_agent_id === o.id));
    lines.push(handoffRule(channel, agent, members, others));
  }
  if (collab) lines.push(collab);

  // The connection graph, rendered as context. This is what makes linking a
  // memory entry or a task to a channel *mean* something: the agents in that
  // channel now know about it without anyone pasting it in. Anchored on the
  // channel and, when this turn came from the board, the dispatching task.
  const anchors: EntityRef[] = [{ type: "channel", id: channel.id }];
  if (trigger.taskId) anchors.push({ type: "task", id: trigger.taskId });
  const linked = sharedContext(anchors);
  if (linked) lines.push(linked);

  // The thread first, because it is what this turn is about; then the ambient
  // conversation with anything already quoted above left out, so a short
  // thread is not printed twice.
  const thread = threadContext(channel, trigger);
  if (thread.block) lines.push(thread.block);

  const msgs = (s.messages[channel.id] ?? [])
    .filter((m) => m.status !== "running" && !thread.shown.has(m.id))
    .slice(-25);
  if (msgs.length) {
    lines.push(`\n## Recent conversation`);
    for (const m of msgs) lines.push(`[${label(m)}]: ${m.content.slice(0, 1500)}`);
  }

  lines.push(`\n## Event`);
  if (note.trim()) lines.push(`\n## This turn\n${note.trim()}`);
  lines.push(`\n[${speaker(trigger)}]: ${trigger.content}`);
  return lines.join("\n");
}

function buildResumePrompt(
  runId: string,
  agent: Agent,
  channel: Channel,
  project: Project | undefined,
  trigger: Trigger,
  cwd: string,
  replyTo: string,
  note: string,
): string {
  const s = useStore.getState();
  const msgs = s.messages[channel.id] ?? [];
  // Skip 'running' rows: this run's own just-inserted placeholder is authored
  // by this agent and newer than everything — matching it would make the
  // "since your last reply" digest permanently empty.
  const lastMine = [...msgs]
    .reverse()
    .find((m) => m.author_id === agent.id && m.status !== "running");
  const since = msgs.filter(
    (m) =>
      (!lastMine || m.created_at > lastMine.created_at) &&
      m.status !== "running" &&
      m.id !== trigger.msgId &&
      m.author_id !== agent.id
  ).slice(-20);

  const lines: string[] = [
    SPACES_RESUME_PROMPT,
    "",
    contextEnvelope(runId, agent, channel, project, trigger, cwd, replyTo, "resume"),
    "",
  ];

  /*
   * A resumed session carries its own past turns, but not a thread it has
   * never been in — and being resumed is exactly when an agent is most likely
   * to be pulled into one. Quote it for the same reason as a fresh run.
   */
  const thread = threadContext(channel, trigger);
  if (thread.block) lines.push(thread.block);

  // A resumed session carries the memory as it looked when the session started;
  // re-state anything the user has edited since this agent's last turn.
  if (project && lastMine) {
    const fresh = s.memory
      .filter((m) => m.project_id === project.id && m.updated_at > lastMine.created_at)
      .slice(0, 8);
    if (fresh.length) {
      lines.push(`Context refresh — project memory changed since your last turn:`);
      for (const m of fresh) lines.push(`- [${m.kind}] ${m.title}: ${m.content.slice(0, 500)}`);
      lines.push("");
    }
  }

  if (since.length) {
    lines.push(`New messages in #${channel.name} since your last reply:`);
    for (const m of since) lines.push(`[${label(m)}]: ${m.content.slice(0, 1200)}`);
    lines.push("");
  }
  if (note.trim()) {
    lines.push(note.trim());
    lines.push("");
  }
  lines.push("## Event", "", `[${speaker(trigger)}]: ${trigger.content}`);
  return lines.join("\n");
}

/**
 * When this turn was started by a teammate's reply (chaining, or a lead's
 * delegation) and that teammate's run actually committed code, hand over the
 * change itself — the commit, the files, the command to read the diff — instead
 * of relying on the reply's description of it. A review that starts from the
 * real diff is a different thing entirely from one that starts from prose.
 *
 * Extra context, never a precondition: every failure path returns "".
 */
async function handoffFor(project: Project | undefined, trigger: Trigger): Promise<string> {
  if (!project || trigger.authorType !== "agent" || !trigger.msgId) return "";
  try {
    const s = useStore.getState();
    // trigger.msgId is the previous agent's reply, and a reply's id IS its run id.
    const prev = await s.loadRun(trigger.msgId);
    if (!prev?.commit_after) return "";
    // handoffNote reads the author's own branch, which only exists when they
    // worked in their own worktree. From the shared checkout that branch is
    // absent (or, worse, stale from an earlier isolated run) and the commands
    // in the note would be wrong — and the next agent is standing in the same
    // tree anyway, so the change is already in front of them.
    const shared = project.local_path.replace(/\/+$/, "");
    if (!prev.cwd || prev.cwd.replace(/\/+$/, "") === shared) return "";
    const from = s.agents.find((a) => a.id === (prev.agent_id || trigger.authorId));
    if (!from) return "";
    return await handoffNote(project, from, prev.commit_after);
  } catch {
    return "";
  }
}

/** First non-empty line of the trigger — gitflow caps the subject from here. */
function firstLine(s: string): string {
  return (s.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 120);
}

function displayCommand(program: string, args: string[]): string {
  return [program, ...args]
    .map((part) => (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

/* ------------------------------------------------------------------ *
 * Membership + addressing
 * ------------------------------------------------------------------ */

/**
 * Channel members as agents, in roster order: channel_members row order with
 * teams expanded in team_members order. Sequential mode dispatches in exactly
 * this order, so it has to be stable and not depend on the agents table.
 */
export function rosterAgents(channelId: string): Agent[] {
  const s = useStore.getState();
  const byId = new Map(s.agents.map((a) => [a.id, a] as const));
  const out: Agent[] = [];
  const seen = new Set<string>();
  for (const m of s.channelMembers.filter((x) => x.channel_id === channelId)) {
    const ids = m.member_type === "agent"
      ? [m.member_id]
      : s.teamMembers.filter((tm) => tm.team_id === m.member_id).map((tm) => tm.agent_id);
    for (const id of ids) {
      const a = byId.get(id);
      if (a && !seen.has(id)) {
        seen.add(id);
        out.push(a);
      }
    }
  }
  return out;
}

/** The channel's lead: the configured one if it is still a member, else first in the roster. */
export function leadAgent(channel: Channel | undefined, members: Agent[]): Agent | undefined {
  if (!members.length) return undefined;
  const explicit = channel?.lead_agent_id
    ? members.find((a) => a.id === channel.lead_agent_id)
    : undefined;
  return explicit ?? members[0];
}

/**
 * Agents explicitly named in a message: @handle, @team-name, @all/@here/@team.
 * Agent authors never trigger via @all and never re-trigger anyone in the chain.
 */
export function resolveMentions(
  channelId: string,
  text: string,
  trigger?: Pick<Trigger, "authorType" | "authorId" | "chain">
): Agent[] {
  const s = useStore.getState();
  const members = rosterAgents(channelId);
  if (!members.length) return [];
  const excluded = new Set(trigger?.chain ?? []);
  if (trigger?.authorType === "agent") excluded.add(trigger.authorId);

  const mentioned = new Set<string>();
  // Left boundary keeps emails (a@b), npm scopes (pkg/@scope), and URL paths
  // (/@user) from reading as mentions.
  const handles = text.match(/(?<![\w@./-])@[a-z0-9-]+/gi) ?? [];
  const teamIdsInChannel = s.channelMembers
    .filter((m) => m.channel_id === channelId && m.member_type === "team")
    .map((m) => m.member_id);

  for (const raw of handles) {
    const h = raw.slice(1).toLowerCase();
    if (h === "all" || h === "here" || h === "team") {
      if (trigger?.authorType !== "agent") members.forEach((a) => mentioned.add(a.id));
      continue;
    }
    for (const a of members) if (slug(a.name) === h) mentioned.add(a.id);
    for (const t of s.teams) {
      if (slug(t.name) === h && teamIdsInChannel.includes(t.id)) {
        s.teamMembers.filter((tm) => tm.team_id === t.id).forEach((tm) => mentioned.add(tm.agent_id));
      }
    }
  }

  for (const id of excluded) mentioned.delete(id);
  return members.filter((a) => mentioned.has(a.id));
}

/**
 * Which agents does this message address?
 * - explicit mentions always win
 * - otherwise the channel mode decides the default audience for a human message:
 *   lead → the lead, panel/sequential → the whole roster, broadcast → the sole
 *   member (a broadcast channel with several agents needs someone named, which
 *   is what the composer's "nobody addressed" nudge is for)
 * - agent authors only ever reach explicitly mentioned teammates
 */
export function resolveTargets(
  channelId: string,
  text: string,
  trigger?: Pick<Trigger, "authorType" | "authorId" | "chain">
): Agent[] {
  const s = useStore.getState();
  const members = rosterAgents(channelId);
  if (!members.length) return [];

  const mentioned = resolveMentions(channelId, text, trigger);
  if (mentioned.length) return mentioned;
  if (trigger?.authorType === "agent") return [];

  const channel = s.channels.find((c) => c.id === channelId);
  const mode: ChannelMode = channel?.mode || "broadcast";
  if (mode === "panel" || mode === "sequential") return members;
  if (mode === "lead") {
    const lead = leadAgent(channel, members);
    return lead ? [lead] : [];
  }
  return members.length === 1 ? members : [];
}

/* ------------------------------------------------------------------ *
 * Durable cross-device agent execution
 * ------------------------------------------------------------------ */

function remoteResultContent(job: RemoteAgentJob): {
  content: string;
  messageStatus: "done" | "error";
  runStatus: "done" | "error" | "cancelled";
} {
  const content =
    job.result && typeof job.result.content === "string"
      ? job.result.content
      : "";
  if (job.status === "completed") {
    return {
      content: content || "_(no output)_",
      messageStatus: "done",
      runStatus: "done",
    };
  }
  if (job.status === "cancelled") {
    return {
      content: content || "_cancelled on the requesting device_",
      messageStatus: "error",
      runStatus: "cancelled",
    };
  }
  return {
    content:
      content ||
      `⚠️ Remote agent run failed.\n\n\`\`\`\n${job.error || "The host device did not return an error."}\n\`\`\``,
    messageStatus: "error",
    runStatus: "error",
  };
}

/**
 * Apply terminal results before acknowledging them. If this app was closed
 * while the other device worked, the rows still converge on next launch.
 */
async function applyRequestedRemoteJob(job: RemoteAgentJob): Promise<void> {
  const runId = job.requesterRunId;
  if (!runId) return;
  const db = await getDb();
  const rows = await db.select<{ channel_id: string; status: string }[]>(
    "SELECT channel_id, status FROM runs WHERE id = $1 LIMIT 1",
    [runId]
  );
  const stored = rows[0];
  if (!stored) return;
  // A local cancellation is authoritative. The portal result only needs
  // acknowledging so it does not replay forever.
  if (stored.status === "cancelled" && job.status === "cancelled") return;

  const resolved = remoteResultContent(job);
  const meta =
    job.result && typeof job.result.meta === "string"
      ? job.result.meta
      : job.status === "completed"
        ? `completed on ${job.agentName}'s host`
        : "remote run";
  const activity =
    job.result && typeof job.result.activity === "string"
      ? job.result.activity
      : "[]";
  const transcript =
    job.result && typeof job.result.transcript === "string"
      ? job.result.transcript
      : "";
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : now();
  const finishedAt = Number.isFinite(finished) ? finished : now();

  await db.execute(
    "UPDATE messages SET content = $1, status = $2, meta = $3 WHERE id = $4",
    [resolved.content, resolved.messageStatus, meta, runId]
  );
  await db.execute(
    `UPDATE runs
        SET status = $1, meta = $2, activity = $3, transcript = $4,
            finished_at = $5
      WHERE id = $6`,
    [resolved.runStatus, meta, activity, transcript, finishedAt, runId]
  );

  const active = runs.get(runId);
  if (active) {
    runs.delete(runId);
    remoteJobIds.delete(runId);
    untrackRun(runId);
    const store = useStore.getState();
    store.markRunActive(runId, false);
    store.patchMessageLocal(active.channelId, runId, {
      content: resolved.content,
      status: resolved.messageStatus,
      meta,
    });
    await store.patchRun(
      runId,
      {
        status: resolved.runStatus,
        meta,
        activity,
        transcript,
        finished_at: finishedAt,
      },
      false
    );
    settle(active, resolved.runStatus, resolved.content);
  } else {
    const store = useStore.getState();
    await store.loadMessages(stored.channel_id);
    await store.loadRun(runId);
  }
}

let drainingRemoteResults = false;

async function drainRequestedRemoteJobs(): Promise<void> {
  if (drainingRemoteResults) return;
  drainingRemoteResults = true;
  try {
    const jobs = await remoteJobUpdates();
    for (const job of jobs) {
      try {
        if (
          job.status === "pending_approval" ||
          job.status === "queued" ||
          job.status === "claimed" ||
          job.status === "running"
        ) {
          const phase =
            job.status === "pending_approval"
              ? "waiting for the agent owner to approve this run…"
              : job.status === "queued"
              ? "waiting for host device…"
              : job.status === "claimed"
                ? "host accepted request…"
                : `running on ${job.agentName}'s host…`;
          const active = runs.get(job.requesterRunId);
          if (active) {
            active.liveActivity = phase;
            const store = useStore.getState();
            store.patchMessageLocal(active.channelId, active.msgId, { meta: phase });
            await store.patchRun(active.msgId, { meta: phase });
          }
          continue;
        }
        await applyRequestedRemoteJob(job);
        await acknowledgeRemoteJob(job.id);
      } catch (error) {
        console.error("[spaces] could not apply remote agent result", error);
      }
    }
  } finally {
    drainingRemoteResults = false;
  }
}

async function executeClaimedRemoteJob(
  job: RemoteAgentJob,
  leaseToken: string,
): Promise<void> {
  hostWorkers.add(job.id);
  const localRunId = `remote-${job.id}`;
  let heartbeat = 0;
  let leaseLost = false;
  try {
    await useStore.getState().refreshAll();
    const localAgentId = await localIdForPortal("agent", job.agentId);
    const agent = useStore
      .getState()
      .agents.find((candidate) => candidate.id === localAgentId);
    if (!agent) {
      throw new Error(
        `${job.agentName} is assigned here, but its local configuration has not synced yet.`
      );
    }
    const localProjectId = job.projectId
      ? await localIdForPortal("project", job.projectId)
      : "";
    const project = useStore
      .getState()
      .projects.find((candidate) => candidate.id === localProjectId);
    if (!project) {
      throw new Error(
        "The requesting project is not available on this host device yet."
      );
    }
    const checkout = project.local_path.trim();
    if (!checkout || !(await isGitRepo(checkout))) {
      throw new Error(
        `This Mac has no linked Git checkout for ${project.name}. Open the project workspace and link or clone the repository before accepting coding work.`
      );
    }
    const channel =
      useStore
        .getState()
        .channels.find(
          (candidate) =>
            candidate.project_id === project.id && candidate.name === "general"
        ) ??
      useStore
        .getState()
        .channels.find((candidate) => candidate.project_id === project.id);
    if (!channel) {
      throw new Error("The host project has no channel for this agent run.");
    }
    const prompt = job.input.prompt?.trim();
    if (!prompt) throw new Error("The remote agent job did not contain a prompt.");

    await startRemoteJob(job.id, leaseToken);
    heartbeat = window.setInterval(() => {
      void heartbeatRemoteJob(job.id, leaseToken).catch(() => {
        leaseLost = true;
        void cancelRun(localRunId);
      });
    }, 25_000);

    await useStore.getState().insertMessage({
      id: uid(),
      channel_id: channel.id,
      author_type: "system",
      author_id: "",
      author_name: "Spaces",
      content: `Remote request received for **${agent.name}** from another paired workspace device.`,
      status: "done",
      meta: `job ${job.id.slice(-8)}`,
      parent_id: "",
      run_id: job.id,
    });
    const result = await runAgent(
      channel.id,
      agent,
      {
        content: "Remote workspace request",
        authorType: "user",
        authorId: job.requestedByDeviceId,
        authorName: "Workspace teammate",
        parentId: "",
        msgId: job.id,
        chain: [],
      },
      {
        prebuiltPrompt: prompt,
        skipRemote: true,
        runId: localRunId,
      }
    );
    if (leaseLost) return;
    if (result.status !== "done") {
      await failRemoteJob(
        job.id,
        leaseToken,
        result.content || `${agent.name} did not complete the remote run.`
      );
      return;
    }
    const completed = await useStore.getState().loadRun(localRunId);
    await completeRemoteJob(job.id, leaseToken, {
      content: result.content,
      meta: completed?.meta ?? "",
      model: completed?.model ?? agent.model,
      effort: completed?.effort ?? "",
    });
  } catch (error) {
    if (!leaseLost) {
      await failRemoteJob(job.id, leaseToken, String(error)).catch(() => {});
    }
  } finally {
    window.clearInterval(heartbeat);
    hostWorkers.delete(job.id);
  }
}

let remoteJobTimer = 0;
let pollingRemoteHost = false;
const approvalPrompts = new Set<string>();

async function requestRemoteApprovals(): Promise<void> {
  const pending = await pendingRemoteJobs();
  for (const job of pending) {
    if (approvalPrompts.has(job.id)) continue;
    approvalPrompts.add(job.id);
    try {
      const prompt = job.input.prompt?.trim() ?? "";
      const preview =
        prompt.length > 280 ? `${prompt.slice(0, 277).trimEnd()}…` : prompt;
      const approved = await confirmAction({
        title: `Let ${job.agentName} work on this Mac?`,
        body:
          `${job.requestedByDeviceName || "Another paired desktop"} requested a coding run in ` +
          `${job.projectName || "an unlinked project"}.\n\n` +
          `${preview || "No task summary was provided."}\n\n` +
          "Approving can read and change the linked repository and run terminal commands with this agent's local permissions. Spaces will refuse the run if this Mac has no valid checkout.",
        confirmLabel: "Approve run",
        cancelLabel: "Decline",
      });
      if (approved) await approveRemoteJob(job.id);
      else await declineRemoteJob(job.id);
    } catch (error) {
      console.error("[spaces] could not resolve remote run approval", error);
      approvalPrompts.delete(job.id);
    }
  }
}

async function pollRemoteHost(): Promise<void> {
  void drainRequestedRemoteJobs().catch(() => {});
  if (pollingRemoteHost || hostWorkers.size >= 2) return;
  pollingRemoteHost = true;
  try {
    await requestRemoteApprovals();
    const claimed = await pollRemoteJob();
    if (claimed) void executeClaimedRemoteJob(claimed.job, claimed.leaseToken);
  } catch {
    // Pairing status already reports connectivity. A background worker going
    // quiet should not interrupt the person typing.
  } finally {
    pollingRemoteHost = false;
  }
}

export function initRemoteAgentJobs(): () => void {
  window.clearInterval(remoteJobTimer);
  void pollRemoteHost();
  remoteJobTimer = window.setInterval(() => void pollRemoteHost(), 4_000);
  return () => window.clearInterval(remoteJobTimer);
}

/* ------------------------------------------------------------------ *
 * The run primitive
 * ------------------------------------------------------------------ */

/**
 * Run ONE agent for ONE turn: post the placeholder, compose the prompt, spawn
 * the CLI, stream it into the message, record the run. Resolves when the run
 * reaches a terminal state.
 *
 * This does no dispatch policy at all — no busy check, no queueing, no
 * chaining. Callers go through orchestrator.dispatch(), which owns all of that.
 */
/**
 * macOS caps a process's whole argument block at 1 MB. Stay well under it: the
 * environment shares that budget, and a prompt that lands at 900 KB fails with
 * E2BIG rather than a message anyone can act on.
 */
const MAX_ARGV_PROMPT = 256 * 1024;

/**
 * The prompt as a single argument, for harnesses that cannot read stdin.
 *
 * Above the cap the prompt is written into `.hq/prompts/` and the argument
 * becomes a short instruction pointing at it. Every harness that needs this
 * can read a file in its own working directory, and a brief the agent has to
 * open is strictly better than a brief that was silently truncated.
 *
 * The rest of `.hq/` is deliberately committed — it is the durable project
 * brief. A prompt is not: it carries channel history, and the turn ends with
 * `git add -A`, so without the ignore below every oversized brief would land
 * in the repository and then in somebody's pull request.
 */
async function promptArg(
  prompt: string,
  project: Project | undefined,
  runId: string,
  agent: Agent
): Promise<string> {
  if (prompt.length <= MAX_ARGV_PROMPT) return prompt;
  const root = project?.local_path ?? "";
  const relative = `.hq/prompts/${runId}.md`;
  if (root) {
    try {
      // Written first, and every time: a .gitignore that travels with the
      // directory holds wherever the checkout is cloned, which a local
      // .git/info/exclude does not.
      await invoke("write_text_file", {
        root,
        relativePath: ".hq/prompts/.gitignore",
        contents: "# Spaces writes oversized run briefs here. They are not project files.\n*\n",
      });
      await invoke("write_text_file", { root, relativePath: relative, contents: prompt });
      return (
        `Your full brief is too large to pass on the command line, so it is in ` +
        `\`${relative}\` (relative to your working directory). Read that file first, ` +
        `in full, and then carry out what it asks. Do not act before you have read it.`
      );
    } catch {
      // fall through to truncation — a short brief still beats a failed run
    }
  }
  const head = prompt.slice(0, MAX_ARGV_PROMPT - 400);
  return (
    `${head}\n\n---\n[Spaces truncated this brief: it exceeded the ${Math.round(
      MAX_ARGV_PROMPT / 1024
    )} KB this harness can accept on the command line, and there was no writable ` +
    `project checkout to spill it into. ${agent.name}: say so rather than guessing at what is missing.]`
  );
}

export async function runAgent(
  channelId: string,
  agent: Agent,
  trigger: Trigger,
  opts: RunOptions = {}
): Promise<RunResult> {
  const fail = (content: string): RunResult => ({
    runId: "", agentId: agent.id, agentName: agent.name, status: "error", content,
  });

  const channel = useStore.getState().channels.find((c) => c.id === channelId);
  if (!channel) return fail("channel is gone");
  const project = useStore.getState().projects.find((p) => p.id === channel.project_id);
  const remote =
    !opts.skipRemote &&
    Boolean(agent.host_device_id) &&
    agent.host_device_id !== currentDeviceId();

  await initAgentListener();
  // Prompt builders read the message cache — make sure it's actually loaded
  // (task dispatch can target a channel that was never opened this session).
  if (!useStore.getState().messages[channelId]) await useStore.getState().loadMessages(channelId);

  const parentId = opts.parentId ?? trigger.parentId;
  const note = opts.note ?? "";
  const msgId = opts.runId ?? uid();
  const store = useStore.getState();

  const external = isExternal(agent.kind);
  // An external agent edits wherever its own app is pointed, which may be a
  // different checkout entirely. Everything downstream — the git bracket, the
  // hand-off baseline, the overlap check — has to agree about that directory.
  let cwd = (external ? externalWorkdir(project, agent) : project?.local_path) || "";
  let mcpProject = project;
  if (!remote && project && !cwd) {
    try {
      mcpProject = await setupControlMcp(project);
      cwd = mcpProject.local_path;
      await ensureActionsFile(mcpProject, cwd);
    } catch (error) {
      return fail(`Spaces could not prepare its agent tools: ${String(error)}`);
    }
  }
  let isolated = false;
  if (!remote && !external && project?.isolate && project.local_path) {
    try {
      const ws = await ensureWorkspace(project, agent);
      if (ws) {
        cwd = ws;
        isolated = true;
      }
    } catch (e) {
      await store.insertMessage({
        id: uid(),
        channel_id: channelId,
        author_type: "system",
        author_id: "",
        author_name: "Spaces",
        content: `⚠️ Couldn't prepare an isolated workspace for ${agent.name} (${String(e).slice(0, 160)}). Running in the shared checkout instead.`,
        status: "done",
        meta: "",
        parent_id: parentId,
      });
    }
  }

  // The harness discovers project MCP servers from its launch directory. An
  // isolated agent starts in a git worktree, so the registration written in
  // the main checkout is not visible there. Repair and verify the complete
  // contract at the final cwd on every run; launching without tools makes a
  // healthy-looking agent that cannot actually use Spaces.
  if (!remote && mcpProject && cwd) {
    try {
      const setup = await setupMcp(mcpProject, cwd);
      const problems = [
        setup.server.error,
        setup.tools.error,
        setup.runtime.error,
        setup.registration.error,
        setup.permissions.error,
        setup.status.problem,
      ].filter(Boolean);
      if (problems.length) throw new Error(problems.join("; "));
    } catch (error) {
      return fail(`Spaces could not make its tools available to ${agent.name}: ${String(error)}`);
    }
  }

  await store.insertMessage({
    id: msgId,
    channel_id: channelId,
    author_type: "agent",
    author_id: agent.id,
    author_name: agent.name,
    content: "",
    status: "running",
    meta: "",
    parent_id: parentId,
    run_id: msgId,
  });

  const session = remote ? "" : store.getSession(channelId, agent.id);
  // Teammates share one git object database, so every turn gets an up-to-date
  // picture of their branches, the files somebody else is holding, and how to
  // read their work. Built from the whole roster — including agents Spaces
  // never launches, because an overlap check that omits Muse is wrong exactly
  // when it matters.
  const mates = channelAgents(store, channelId).filter((a) => a.id !== agent.id);
  const collab = project && !remote && !opts.prebuiltPrompt
    ? await collaborationBlock(project, agent, mates, { isolated, cwd }).catch(() => "")
    : "";
  // If a teammate handed this turn over after committing, lead with their diff.
  const shared =
    collab +
    (!remote && !opts.prebuiltPrompt ? await handoffFor(project, trigger) : "") +
    // What the rest of the project has been doing. Computed here rather than
    // inside the builders because it needs the database, and it matters most
    // in a channel that has no history of its own to offer.
    (opts.prebuiltPrompt ? "" : await elsewhereInProject(project, channelId));
  const prompt =
    opts.prebuiltPrompt ??
    (remote
      ? buildFreshPrompt(
          msgId,
          agent,
          channel,
          project,
          trigger,
          "",
          parentId || "channel-top-level",
          false,
          note,
          "",
        )
      : session
        ? buildResumePrompt(
            msgId,
            agent,
            channel,
            project,
            trigger,
            cwd,
            parentId || "channel-top-level",
            note,
          ) + shared
        : buildFreshPrompt(
            msgId,
            agent,
            channel,
            project,
            trigger,
            project?.local_path ? cwd : "",
            parentId || "channel-top-level",
            isolated,
            note,
            shared,
          ));

  // Open the git bracket for this turn. "" for a non-repo, an unborn HEAD, or a
  // project with no local checkout — all fine, the turn just isn't checkpointed.
  const commitBefore = remote ? "" : await checkpointBefore(cwd);

  const run: RunState = {
    channelId,
    msgId,
    agent,
    parts: [],
    raw: [],
    meta: "",
    liveActivity: session ? "resuming session…" : "starting…",
    activity: [],
    sessionId: session,
    initialSessionId: session,
    startedAt: now(),
    chain: trigger.chain,
    parentId,
    cwd: remote ? "" : cwd,
    commitBefore,
    checkpointLabel: `${agent.name}: ${firstLine(trigger.content)}`,
    transcript: [],
    transcriptBytes: 0,
    transcriptDropped: 0,
    transcriptDroppedBytes: 0,
    transcriptMirroredAt: 0,
  };
  const settled = new Promise<RunResult>((resolve) => {
    run.settle = resolve;
  });
  runs.set(msgId, run);
  trackRun({ runId: msgId, channelId, agentId: agent.id });
  store.markRunActive(msgId, true);

  if (trigger.taskId) void store.updateTask(trigger.taskId, { last_run_id: msgId });

  const adapter = adapterFor(agent);
  const runtimeContract = !remote && mcpProject
    ? await ensureRuntimeContract(mcpProject).catch(() => ({
        path: "",
        written: false,
        error: "could not write the runtime contract",
      }))
    : { path: "", written: false, error: "" };
  // Codex takes its MCP config as spawn arguments. Claude and Cursor read the
  // config files we verified in the exact cwd above. An external agent has
  // neither and reaches the same operations through .hq/actions.jsonl.
  const adapterArgs = [
    ...(agent.kind === "codex" && mcpProject ? mcpCodexArgs(mcpProject) : []),
    ...adapter.buildArgs(agent, session, runtimeContract.error ? "" : runtimeContract.path),
  ];
  // Harnesses with no stdin reader take the prompt as the last argument. A
  // Spaces prompt carries the whole project brief, which can outgrow ARG_MAX,
  // so an oversized one is written next to the agent instead — losing the
  // context would be a worse failure than one extra file read.
  //
  // Kept out of `adapterArgs`: that list is what the run row records as its
  // command, and a run row is not where a whole prompt belongs. The spawn gets
  // `launchArgs`, the inspector gets the command without it.
  const launchArgs =
    !remote && adapter.promptDelivery === "argv"
      ? [...adapterArgs, await promptArg(prompt, mcpProject, msgId, agent)]
      : adapterArgs;

  await store.insertRun({
    id: msgId,
    agent_id: agent.id,
    channel_id: channelId,
    task_id: trigger.taskId ?? "",
    prompt,
    status: "running",
    session_id: session,
    meta: "",
    activity: "[]",
    cwd: remote ? "" : cwd,
    model: agent.model,
    effort: configuredEffort(agent.kind, agent.cli_args),
    command:
      remote
        ? `remote → ${agent.host_device_id}`
        : adapter.transport === "external"
        ? `hand-off → ${handoffPath(agent)}`
        : displayCommand(
            adapter.program,
            adapter.promptDelivery === "argv" ? [...adapterArgs, "<prompt>"] : adapterArgs
          ),
    commit_before: commitBefore,
    commit_after: "",
    files_changed: "",
    transcript: "",
    started_at: run.startedAt,
    finished_at: 0,
  });

  try {
    if (!remote && adapter.transport === "external") {
      return await runHandOff({
        run,
        project,
        agent,
        channel,
        trigger,
        prompt,
        msgId,
        channelId,
      });
    }
    if (remote) {
      const remoteAgentId = await portalIdForLocal("agent", agent.id);
      if (!remoteAgentId) {
        throw new Error(
          `${agent.name} has not finished syncing to the shared workspace yet. Try again after the next sync.`
        );
      }
      const remoteProjectId = project
        ? await portalIdForLocal("project", project.id)
        : "";
      if (!remoteProjectId) {
        throw new Error(
          "This project has not finished syncing to the shared workspace yet."
        );
      }
      const job = await enqueueRemoteJob({
        agentId: remoteAgentId,
        projectId: remoteProjectId,
        channelId,
        requesterRunId: msgId,
        prompt,
      });
      remoteJobIds.set(msgId, job.id);
      run.liveActivity = `queued on ${
        store.devices.find((device) => device.id === agent.host_device_id)?.name ??
        "host device"
      }…`;
      store.patchMessageLocal(channelId, msgId, { meta: run.liveActivity });
      await store.patchRun(msgId, { meta: run.liveActivity });
      return settled;
    }
    {
      await invoke("start_agent_run", {
        request: {
          runId: msgId,
          agentId: agent.id,
          channelId,
          projectId: project?.id ?? "",
          triggerId: trigger.msgId,
          replyTo: parentId || "channel-top-level",
          projectRoot: projectRoot(project, cwd),
          contextDir: projectRoot(project, cwd)
            ? `${projectRoot(project, cwd)}/.hq`
            : "",
          mcpServer: mcpProject ? mcpServerPath(mcpProject) : "",
          runtime: agent.kind,
          harnessProtocol: SPACES_HARNESS_PROTOCOL,
          program: adapter.program,
          args: launchArgs,
          cwd: cwd || null,
          prompt,
        },
      });
    }
  } catch (e) {
    runs.delete(msgId);
    remoteJobIds.delete(msgId);
    untrackRun(msgId);
    store.markRunActive(msgId, false);
    const content = `⚠️ Could not start ${agent.kind}: ${String(e)}`;
    store.patchMessageLocal(channelId, msgId, { content, status: "error" });
    void store.persistMessage(msgId, { content, status: "error" });
    void store.patchRun(msgId, { status: "error", finished_at: now() });
    run.settle = undefined;
    return { runId: msgId, agentId: agent.id, agentName: agent.name, status: "error", content };
  }

  return settled;
}

/* ------------------------------------------------------------------ *
 * Hand-offs — a turn for an agent Spaces cannot launch
 * ------------------------------------------------------------------ */

/**
 * Run a turn for an external agent.
 *
 * There is no process to start, so the turn is a hand-off: write the same
 * brief a spawned agent would have received, record the tree it was handed,
 * and say plainly in the channel that Spaces has not done the work and will
 * not until that agent's own app does.
 *
 * Two things make this worth more than a note to self. The brief is the *full*
 * composed prompt — project instructions, channel charter, board, the shared
 * workspace block — so an external teammate is briefed as well as a local one.
 * And the recorded baseline (commit_before, files_changed) is what lets
 * `reportHandOffs` later say exactly what that agent did with it, rather than
 * asking someone to remember.
 *
 * The run is settled immediately and honestly: it is "done" because Spaces has
 * finished its part of it, and the content says so in those words.
 */
async function runHandOff(opts: {
  run: RunState;
  project: Project | undefined;
  agent: Agent;
  channel: Channel;
  trigger: Trigger;
  prompt: string;
  msgId: string;
  channelId: string;
}): Promise<RunResult> {
  const { run, project, agent, channel, trigger, prompt, msgId, channelId } = opts;
  const store = useStore.getState();

  const result = await handOff({
    project,
    agent,
    brief: prompt,
    ask: trigger.content,
    channelName: channel.name,
    authorName: trigger.authorName,
    runId: msgId,
  });

  const config = externalConfig(agent);
  const where = externalWorkdir(project, agent);

  // The brief is on disk either way — it is the durable record and the
  // fallback. Auto-send is what turns it from a note somebody has to notice
  // into work the agent is actually holding.
  const delivery = result.error
    ? { delivered: false, verified: false, method: "" as const, problem: "", previousApp: "" }
    : await deliverToApp(
        agent,
        composerMessage({
          agent,
          ask: trigger.content,
          workdir: where,
          briefPath: result.path,
          // Absolute, like the other two paths in this message: the agent is
          // being told where to put a file, not where it sits in the repo.
          replyFile: project?.local_path
            ? `${project.local_path.replace(/\/+$/, "")}/${replyPath(agent)}`
            : "",
          channelName: channel.name,
          authorName: trigger.authorName,
        })
      );

  runs.delete(msgId);
  untrackRun(msgId);
  store.markRunActive(msgId, false);

  /*
   * "Sent" has to mean sent. Spaces posts the click and the paste, then reads
   * the message box back — and only that read-back earns the confident wording
   * below. A send it could not confirm falls to the hand-off text, which says
   * where the brief is, because that is what somebody would need if the typing
   * went nowhere.
   */
  const content = result.error
    ? `⚠️ Couldn't leave a brief for ${agent.name}: ${result.error}`
    : delivery.verified
      ? [
          `📤 **Sent to ${agent.name}.** Typed into ${config.app || "the app"} and sent.`,
          "",
          `- brief: \`${result.relativePath}\``,
          where ? `- working directory: \`${where}\`` : "",
          result.baselineSha ? `- tree at hand-off: \`${result.baselineSha.slice(0, 12)}\`` : "",
          "",
          `Spaces watches this repository — when ${agent.name} commits, its work appears in the shared workspace and in every other agent's next turn.`,
        ]
          .filter((l) => l !== "")
          .join("\n")
      : [
          delivery.delivered
            ? `📤 **Typed into ${config.app || "the app"} for ${agent.name}** — Spaces could not read the box back, so it cannot promise this landed.`
            : `📋 **Handed off to ${agent.name}.** Spaces does not launch ${config.app || "this agent"}, so nothing has run yet.`,
          "",
          `- brief: \`${result.relativePath}\``,
          where ? `- working directory: \`${where}\`` : "",
          result.baselineSha ? `- tree at hand-off: \`${result.baselineSha.slice(0, 12)}\`` : "",
          delivery.problem ? `\n⚠️ ${delivery.problem}` : "",
          "",
          config.autosend
            ? `If nothing appeared, open ${config.app || "the app"} and point it at that brief.`
            : `Open ${config.app || "the app"} and point it at that brief. Turn on **Send it automatically** in this agent's settings and Spaces will type it in for you.`,
          `Spaces watches this repository — when ${agent.name} commits, its work shows up in the shared workspace and in every other agent's next turn, with no reporting back by hand.`,
        ]
          .filter((l) => l !== "")
          .join("\n");

  const status: "done" | "error" = result.error ? "error" : "done";
  const meta = result.error
    ? ""
    : delivery.verified
      ? "sent · awaiting external agent"
      : delivery.delivered
        ? "typed, unconfirmed · awaiting external agent"
        : "awaiting external agent";
  store.patchMessageLocal(channelId, msgId, { content, status, meta });
  void store.persistMessage(msgId, { content, status, meta });
  await store.patchRun(msgId, {
    status,
    meta,
    // The baseline lives in the ordinary checkpoint columns, so a hand-off is
    // inspectable and diffable with exactly the same machinery as a real run.
    commit_before: result.baselineSha,
    files_changed: result.baselineDirty.join("\n"),
    finished_at: now(),
  });

  settle(run, status === "error" ? "error" : "done", content);
  return {
    runId: msgId,
    agentId: agent.id,
    agentName: agent.name,
    status: status === "error" ? "error" : "done",
    content,
  };
}

/**
 * Close the loop on every open hand-off in a project.
 *
 * Reads what each external agent has committed since its brief and posts the
 * result into the channel the brief came from. Called when someone opens the
 * shared-workspace view and before an external agent's next turn, so a teammate
 * that worked overnight is credited without anyone typing a status update.
 *
 * Returns the number of hand-offs that had something to report.
 */
export async function reportHandOffs(projectId: string): Promise<number> {
  const store = useStore.getState();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project?.local_path) return 0;

  const externals = store.agents.filter((a) => isExternal(a.kind));
  if (!externals.length) return 0;

  const channelIds = new Set(
    store.channels.filter((c) => c.project_id === projectId).map((c) => c.id)
  );
  let reported = 0;

  for (const agent of externals) {
    const open = await store.openHandOffsFor(agent.id).catch(() => []);
    /*
     * One report per agent per sweep.
     *
     * `openHandOffsFor` returns every hand-off still waiting, newest first,
     * and they all ask the same question: what has this agent done since. Ask
     * someone twice in a minute and both are open, so the same work was
     * announced once per hand-off — two identical messages, seconds apart.
     * The newest baseline is the accurate one; the rest are settled quietly.
     */
    let said = false;
    for (const row of open) {
      if (!channelIds.has(row.channel_id)) continue;
      if (said) {
        await store.patchRun(row.id, { meta: "external work landed" });
        continue;
      }
      const outcome = await settleHandOff(project, agent, {
        sha: row.commit_before,
        dirty: row.files_changed ? row.files_changed.split("\n").filter(Boolean) : [],
      }).catch(() => null);
      if (!outcome || outcome.untouched) continue;

      const replyId = uid();
      await store.insertMessage({
        id: replyId,
        channel_id: row.channel_id,
        author_type: "agent",
        author_id: agent.id,
        author_name: agent.name,
        content: [
          `✅ ${describeOutcome(agent, outcome)}`,
          "",
          // The agent's own words first: when it answered a question, this is
          // the reply, and the commit list is supporting detail.
          outcome.reply,
          outcome.reply && outcome.commits.length ? "" : "",
          ...outcome.commits.slice(0, 5).map((c) => `- \`${c.sha.slice(0, 8)}\` ${c.subject}`),
          outcome.newlyDirty.length
            ? `\nStill uncommitted: ${outcome.newlyDirty.slice(0, 10).join(", ")}`
            : "",
        ]
          .filter((l) => l !== "")
          .join("\n"),
        status: "done",
        // Where it came from, because the two are read differently: git is
        // observed fact, a written reply is the agent's own account.
        meta: outcome.reply
          ? outcome.commits.length || outcome.newlyDirty.length
            ? "written reply and git"
            : "written reply"
          : "picked up from git",
        parent_id: "",
      });
      // Mark it settled so the same work is never reported twice.
      await store.patchRun(row.id, { meta: "external work landed" });
      said = true;
      if (outcome.reply) await consumeReply(project, agent);

      /*
       * An answer that arrives late is still an answer.
       *
       * When a CLI agent replies, the reply is dispatched again so teammates
       * it names can pick it up — that is what makes a channel a conversation
       * rather than a set of parallel monologues. An external teammate's reply
       * was inserted and left there, so nothing could ever follow from it:
       * Muse could be asked something, answer it well, name the teammate who
       * should act on it, and no one would ever run.
       *
       * The ordinary chaining rules apply, which is what keeps this safe: an
       * agent-authored trigger reaches only teammates it mentions explicitly,
       * never @all, and never anyone already in the chain.
       */
      void triggerAgents(row.channel_id, {
        content: outcome.reply || describeOutcome(agent, outcome),
        authorType: "agent",
        authorId: agent.id,
        authorName: agent.name,
        parentId: "",
        msgId: replyId,
        chain: [agent.id],
      }).catch(() => {
        // Chaining is fire-and-forget; the reply is already in the channel.
      });
      reported += 1;
    }
  }
  return reported;
}

/**
 * How often to look for an answer, and how often to look at git.
 *
 * Two cadences because the two checks cost wildly different things. Reading a
 * reply file is a few bytes; settling a hand-off shells out to git several
 * times per agent. Muse answers in about five seconds and was then sat on for
 * up to forty-five, which reads as the agent being slow when it is only the
 * workspace being asleep.
 */
const HANDOFF_POLL_MS = 4_000;
const HANDOFF_GIT_MS = 45_000;

/**
 * Notice when an external teammate answers, without being asked to look.
 *
 * `reportHandOffs` was only ever called by the shared-workspace view opening,
 * which made an answer conditional on the person navigating to the right
 * screen for the right project. Ask Muse a question from #general, stay in
 * #general, and the reply lands in a place nothing is reading — which is
 * indistinguishable, from the channel, from an agent that ignored you.
 *
 * The common case is that nothing is outstanding, and that case costs one
 * indexed query and no subprocesses: only projects with an open hand-off are
 * settled, and git is touched only for those.
 */
export function initHandOffWatch(): () => void {
  let stopped = false;
  let running = false;
  // Far enough back that the first tick looks at git too.
  let lastGit = 0;

  const tick = async () => {
    // Overlapping sweeps would run git against the same tree twice and could
    // report the same work in both.
    if (stopped || running) return;
    running = true;
    try {
      const db = await getDb();
      const rows = await db.select<Array<{ project_id: string }>>(
        `SELECT DISTINCT channels.project_id AS project_id
           FROM runs
           INNER JOIN channels ON channels.id = runs.channel_id
          WHERE runs.meta LIKE '%awaiting external agent%'`
      );
      if (!rows.length) return;

      const store = useStore.getState();
      const externals = store.agents.filter((agent) => isExternal(agent.kind));
      // Work that only shows up in git can wait for the slow cadence; a
      // written answer should not.
      const withGit = Date.now() - lastGit >= HANDOFF_GIT_MS;
      if (withGit) lastGit = Date.now();

      for (const row of rows) {
        if (stopped) return;
        if (!withGit) {
          const project = store.projects.find((p) => p.id === row.project_id);
          if (!(await replyWaiting(project, externals).catch(() => false))) continue;
        }
        await reportHandOffs(row.project_id).catch(() => 0);
      }
    } catch {
      // Best effort: a sweep that fails is retried on the next tick, and the
      // shared-workspace view still settles hand-offs the way it always did.
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = window.setInterval(() => void tick(), HANDOFF_POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

/**
 * Dispatch a trigger into a channel. Kept as the app-facing entry point (the
 * chat composer and the board call this); the mode state machine, the durable
 * queue and agent-to-agent chaining all live in orchestrator.ts.
 */
export async function triggerAgents(channelId: string, trigger: Trigger): Promise<void> {
  await dispatch(channelId, trigger);
}

/** Convenience for the composer: build a Trigger from a user message row. */
export function userTrigger(msg: Message, taskId?: string): Trigger {
  return {
    content: msg.content,
    authorType: "user",
    authorId: msg.author_id || "user",
    authorName: msg.author_name,
    parentId: msg.parent_id,
    msgId: msg.id,
    chain: [],
    taskId,
  };
}

export async function cancelRun(msgId: string) {
  const run = runs.get(msgId);
  const remoteJobId = remoteJobIds.get(msgId);
  if (remoteJobId) {
    remoteJobIds.delete(msgId);
    await cancelRemoteJob(remoteJobId).catch(() => {});
  }
  await invoke("cancel_agent_run", { runId: msgId }).catch(() => {});
  // The done event may have landed during the await — don't flip a run that
  // already completed (and possibly triggered chaining) to cancelled.
  if (run && runs.has(msgId)) {
    runs.delete(msgId);
    untrackRun(msgId);
    const s = useStore.getState();
    s.markRunActive(msgId, false);
    const content = renderContent(run) || "_cancelled_";
    s.patchMessageLocal(run.channelId, msgId, { content, status: "error", meta: "cancelled" });
    void s.persistMessage(msgId, { content, status: "error", meta: "cancelled" });
    // No checkpoint: the user stopped this turn deliberately, and committing a
    // half-written edit as "work" is not what stop means. What it did manage is
    // still in the tree, and folds into the next run's checkpoint.
    void s.patchRun(msgId, {
      status: "cancelled",
      session_id: run.sessionId,
      activity: JSON.stringify(run.activity),
      transcript: transcriptText(run),
      finished_at: now(),
    });
    settle(run, "cancelled", content);
  }
}

export function isRunning(msgId: string): boolean {
  return runs.has(msgId);
}
