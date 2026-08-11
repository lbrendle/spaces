import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useStore } from "../store";
import type { ActivityEvent } from "../types";
import { Avatar, Modal, Spinner } from "./ui";
import { IconBolt, IconCheck, IconInfo, IconMemory, IconX } from "./icons";
import "./chat.css";
import "./transcript.css";

/** Log-style tag per event kind — doubles as the dot color class. */
const EV_LABELS: Record<ActivityEvent["kind"], string> = {
  tool: "tool",
  text: "text",
  info: "info",
  stderr: "err",
};

function fmtOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ------------------------------------------------------------------ *
 * Transcript model
 *
 * runs.transcript is the raw harness stream: one JSON event per line,
 * exactly as it came off the wire. Three dialects share this column
 * (claude stream-json, codex --json, ritz SSE payloads), so events are
 * classified by *shape*, not by the agent's kind — a run whose agent was
 * since deleted still reads correctly.
 *
 * Everything here is defensive: a line that does not parse, or an event
 * whose shape is unknown, becomes a raw node. Nothing is ever dropped
 * silently.
 * ------------------------------------------------------------------ */

interface ToolResult {
  text: string;
  isError: boolean;
}

type TNode =
  | { k: "text"; id: string; role: "assistant" | "user"; text: string }
  | { k: "think"; id: string; text: string }
  | { k: "tool"; id: string; name: string; input: string; result: ToolResult | null }
  | { k: "result"; id: string; result: ToolResult }
  | { k: "note"; id: string; text: string }
  | { k: "error"; id: string; text: string }
  | { k: "raw"; id: string; text: string };

type ToolNode = Extract<TNode, { k: "tool" }>;
type TextNode = Extract<TNode, { k: "text" }>;

interface Parsed {
  nodes: TNode[];
  /** non-empty lines seen, whether or not they were understood */
  events: number;
  /** nodes trimmed off the front to keep the DOM sane */
  hidden: number;
}

const EMPTY_PARSE: Parsed = { nodes: [], events: 0, hidden: 0 };

/** A very long run would otherwise put tens of thousands of nodes in the DOM. */
const MAX_NODES = 1500;
const MAX_INPUT = 8000;
const MAX_RESULT = 40000;
/** Result blocks longer than this collapse behind "Show more". */
const RESULT_PREVIEW = 1200;
/** Tool input taller than this collapses into a <details>. */
const FOLD_LINES = 6;

function pretty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… ${s.length - max} more characters — use "Copy raw" for the full stream`;
}

/** A claude tool_result body is a string, or a list of content blocks. */
function blockText(b: any): string {
  if (typeof b === "string") return b;
  if (b && typeof b.text === "string") return b.text;
  return pretty(b);
}

function resultText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).join("\n");
  return pretty(content);
}

/** Ritz streams its reasoning inline in <think> tags; split it back out. */
function splitThinking(src: string): { think: boolean; text: string }[] {
  const out: { think: boolean; text: string }[] = [];
  let rest = src;
  for (;;) {
    const open = rest.indexOf("<think>");
    if (open === -1) break;
    if (open > 0) out.push({ think: false, text: rest.slice(0, open) });
    const after = rest.slice(open + "<think>".length);
    const close = after.indexOf("</think>");
    if (close === -1) {
      // still streaming: the closing tag has not arrived yet
      out.push({ think: true, text: after });
      return out;
    }
    out.push({ think: true, text: after.slice(0, close) });
    rest = after.slice(close + "</think>".length);
  }
  if (rest) out.push({ think: false, text: rest });
  return out;
}

function parseTranscript(src: string): Parsed {
  if (!src) return EMPTY_PARSE;

  const nodes: TNode[] = [];
  let seq = 0;
  let events = 0;
  // Ids come from a monotonic counter over an append-only stream, so a node
  // keeps its id as more events arrive — which is what keeps React's per-node
  // state (open <details>, "show more") from resetting mid-run.
  const nid = () => `n${seq++}`;
  const add = <T extends TNode>(n: T): T => {
    nodes.push(n);
    return n;
  };

  /** tool calls awaiting their result, by harness-supplied id */
  const byKey = new Map<string, ToolNode>();
  /** most recent call with no result yet — the fallback when there is no id */
  let openTool: ToolNode | null = null;
  /** the ritz text block currently being appended to, token by token */
  let stream: TextNode | null = null;

  const note = (t: string) => {
    if (t.trim()) add({ k: "note", id: nid(), text: t.trim() });
  };
  const fail = (t: string) => add({ k: "error", id: nid(), text: t.trim() || "error" });
  const raw = (t: string) => add({ k: "raw", id: nid(), text: t });
  const say = (role: "assistant" | "user", t: string) => {
    if (t.trim()) add({ k: "text", id: nid(), role, text: t });
  };
  const think = (t: string) => {
    if (t.trim()) add({ k: "think", id: nid(), text: t });
  };
  const tool = (name: string, input: string, key?: string): ToolNode => {
    const n = add<ToolNode>({
      k: "tool",
      id: nid(),
      name: name || "tool",
      input: clip(input, MAX_INPUT),
      result: null,
    });
    openTool = n;
    if (key) byKey.set(key, n);
    return n;
  };
  const settle = (result: ToolResult, key?: string) => {
    const target = (key ? byKey.get(key) : undefined) ?? openTool;
    if (target && !target.result) {
      target.result = result;
      if (openTool === target) openTool = null;
      return;
    }
    add({ k: "result", id: nid(), result });
  };

  /** codex item envelopes: item.started / item.updated / item.completed */
  const classifyItem = (phase: string, item: any, line: string) => {
    const t = String(item.type ?? item.item_type ?? "");
    const key = typeof item.id === "string" ? `item:${item.id}` : undefined;
    const done = phase === "item.completed";

    if (t === "agent_message") {
      // the "started" twin carries no text yet — the completed one has it all
      if (done) say("assistant", String(item.text ?? ""));
      return;
    }
    if (t === "reasoning") {
      if (done) think(String(item.text ?? item.summary ?? ""));
      return;
    }
    if (t === "command_execution") {
      const cmd = String(item.command ?? "");
      const existing = key ? byKey.get(key) : undefined;
      const node = existing ?? tool("shell", cmd, key);
      if (existing && cmd) existing.input = clip(cmd, MAX_INPUT);
      if (done) {
        const out = String(item.aggregated_output ?? item.output ?? "");
        const code = item.exit_code;
        const failed = typeof code === "number" ? code !== 0 : item.status === "failed";
        node.result = {
          text: clip(out || (typeof code === "number" ? `exit ${code}` : "(no output)"), MAX_RESULT),
          isError: failed,
        };
        if (openTool === node) openTool = null;
      }
      return;
    }
    if (t === "file_change" || t === "patch_apply") {
      if (!done) return;
      const n = tool("edit", pretty(item.changes ?? item.path ?? item));
      if (item.status) {
        n.result = { text: String(item.status), isError: item.status === "failed" };
        openTool = null;
      }
      return;
    }
    if (t === "error") {
      fail(pretty(item.message ?? item.text) || line);
      return;
    }
    raw(line); // unknown item type — shown rather than swallowed
  };

  /** older codex protocol: {msg: {...}} */
  const classifyMsg = (msg: any, line: string) => {
    const t = String(msg.type ?? "");
    const key = typeof msg.call_id === "string" ? `call:${msg.call_id}` : undefined;
    if (t === "agent_message" && msg.message) {
      say("assistant", String(msg.message));
      return;
    }
    if (t === "agent_reasoning" && msg.text) {
      think(String(msg.text));
      return;
    }
    if (t === "exec_command_begin") {
      tool("shell", pretty(msg.command), key);
      return;
    }
    if (t === "exec_command_end") {
      const out = `${msg.stdout ?? ""}${msg.stderr ?? ""}`;
      settle({ text: clip(out || `exit ${msg.exit_code ?? "?"}`, MAX_RESULT), isError: msg.exit_code !== 0 }, key);
      return;
    }
    if (t === "error") {
      fail(pretty(msg.message) || line);
      return;
    }
    raw(line);
  };

  const classify = (o: any, line: string) => {
    const type = typeof o.type === "string" ? o.type : "";
    // any non-token event ends the ritz streaming block
    if (type !== "token") stream = null;

    /* ── ritz (SSE payloads) ─────────────────────────────── */
    if (type === "token" && typeof o.text === "string") {
      const block = stream ?? add<TextNode>({ k: "text", id: nid(), role: "assistant", text: "" });
      block.text += o.text;
      stream = block;
      return;
    }
    if (type === "start") {
      note(`start${o.model ? ` · model ${o.model}` : ""}`);
      return;
    }
    if (type === "step" && o.name) {
      const n = tool(String(o.name), pretty(o.arguments ?? o.args ?? o.input));
      if (o.result != null && o.result !== "") {
        n.result = { text: clip(pretty(o.result), MAX_RESULT), isError: o.is_error === true };
        openTool = null;
      }
      return;
    }
    if (type === "error") {
      fail(pretty(o.message ?? o.error ?? o.text) || line);
      return;
    }
    if (type === "done" || type === "end") {
      note("stream finished");
      return;
    }

    /* ── claude (stream-json) ────────────────────────────── */
    if (type === "system") {
      const bits: string[] = [];
      if (o.subtype) bits.push(String(o.subtype));
      if (o.model) bits.push(`model ${o.model}`);
      if (o.session_id) bits.push(`session ${String(o.session_id).slice(0, 8)}`);
      if (o.cwd) bits.push(String(o.cwd));
      note(`system${bits.length ? ` · ${bits.join(" · ")}` : ""}`);
      return;
    }
    if ((type === "assistant" || type === "user") && o.message) {
      const role = type === "user" ? "user" : "assistant";
      const content = o.message.content;
      if (typeof content === "string") {
        say(role, content);
        return;
      }
      if (!Array.isArray(content)) {
        raw(line);
        return;
      }
      for (const b of content) {
        const bt = b?.type;
        if (bt === "text") say(role, String(b.text ?? ""));
        else if (bt === "thinking" || bt === "redacted_thinking") {
          think(String(b.thinking ?? b.text ?? "(redacted)"));
        } else if (bt === "tool_use" || bt === "server_tool_use") {
          tool(String(b.name ?? "tool"), pretty(b.input), typeof b.id === "string" ? b.id : undefined);
        } else if (bt === "tool_result" || bt === "web_search_tool_result") {
          settle(
            { text: clip(resultText(b.content ?? b.text), MAX_RESULT), isError: b.is_error === true },
            typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
          );
        } else raw(pretty(b));
      }
      return;
    }
    if (type === "result") {
      const bits: string[] = [];
      if (o.num_turns) {
        bits.push(`${o.num_turns} ${o.num_turns === 1 ? "turn" : "turns"}`);
      }
      if (typeof o.total_cost_usd === "number") bits.push(`$${o.total_cost_usd.toFixed(3)}`);
      if (o.duration_ms) bits.push(`${Math.round(o.duration_ms / 1000)}s`);
      const head = `result${o.subtype && o.subtype !== "success" ? ` · ${o.subtype}` : ""}`;
      const summary = `${head}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
      if (o.is_error) fail(`${summary}\n${pretty(o.result ?? o.error)}`);
      else note(summary);
      return;
    }

    /* ── codex (--json) ──────────────────────────────────── */
    if (type === "thread.started") {
      note(`thread ${String(o.thread_id ?? "").slice(0, 8)}`);
      return;
    }
    if (type === "turn.started") {
      note("turn started");
      return;
    }
    if (type === "turn.completed") {
      const u = o.usage;
      const tokens =
        u && (u.input_tokens != null || u.output_tokens != null)
          ? ` · ${(u.input_tokens ?? 0) + (u.output_tokens ?? 0)} tokens`
          : "";
      note(`turn completed${tokens}`);
      return;
    }
    if (type === "turn.failed") {
      fail(pretty(o.error?.message ?? o.error) || line);
      return;
    }
    if (type.startsWith("item.") && o.item && typeof o.item === "object") {
      classifyItem(type, o.item, line);
      return;
    }
    if (o.msg && typeof o.msg === "object") {
      classifyMsg(o.msg, line);
      return;
    }

    raw(line);
  };

  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events++;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      stream = null;
      raw(line);
      continue;
    }
    if (!obj || typeof obj !== "object") {
      stream = null;
      raw(trimmed);
      continue;
    }
    try {
      classify(obj, trimmed);
    } catch {
      // a shape we mis-guessed must never take the whole view down
      stream = null;
      raw(trimmed);
    }
  }

  // Pull inline <think> spans out of text blocks (ritz emits them mid-stream).
  const out: TNode[] = [];
  for (const n of nodes) {
    if (n.k !== "text" || !n.text.includes("<think>")) {
      out.push(n);
      continue;
    }
    splitThinking(n.text).forEach((seg, i) => {
      if (!seg.text.trim()) return;
      out.push(
        seg.think
          ? { k: "think", id: `${n.id}-${i}`, text: seg.text }
          : { ...n, id: `${n.id}-${i}`, text: seg.text }
      );
    });
  }

  const hidden = Math.max(0, out.length - MAX_NODES);
  return { nodes: hidden ? out.slice(hidden) : out, events, hidden };
}

/* ------------------------------------------------------------------ *
 * Transcript rendering
 * ------------------------------------------------------------------ */

function Fold({ summary, count, children }: { summary: string; count: string; children: ReactNode }) {
  return (
    <details className="tr-fold">
      <summary className="tr-sum">
        <span className="tr-sum-text">{summary}</span>
        <span className="tr-sum-count">{count}</span>
      </summary>
      {children}
    </details>
  );
}

function ResultBlock({ result }: { result: ToolResult }) {
  const [open, setOpen] = useState(false);
  const long = result.text.length > RESULT_PREVIEW;
  const shown = long && !open ? `${result.text.slice(0, RESULT_PREVIEW)}…` : result.text;
  return (
    <div className={"tr-result" + (result.isError ? " err" : "")}>
      <pre className="tr-code">{shown}</pre>
      {long && (
        <button type="button" className="tr-more" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : `Show more (${result.text.length - RESULT_PREVIEW} more characters)`}
        </button>
      )}
    </div>
  );
}

function ToolBlock({ node }: { node: ToolNode }) {
  const lines = node.input ? node.input.split("\n") : [];
  const body = <pre className="tr-code">{node.input}</pre>;
  return (
    <div className="tr-node tr-tool">
      <div className="tr-tool-head">
        <IconBolt size={12} />
        <span className="tr-tool-name">{node.name}</span>
      </div>
      {node.input &&
        (lines.length > FOLD_LINES ? (
          <Fold summary={lines[0].slice(0, 90)} count={`${lines.length} lines`}>
            {body}
          </Fold>
        ) : (
          body
        ))}
      {node.result && <ResultBlock result={node.result} />}
    </div>
  );
}

function TranscriptNode({ node, speaker }: { node: TNode; speaker: string }) {
  switch (node.k) {
    case "text":
      return (
        <div className="tr-node tr-msg">
          <div className="tr-role">{node.role === "user" ? "user" : speaker}</div>
          <div className="tr-prose">{node.text}</div>
        </div>
      );
    case "think":
      return (
        <details className="tr-node tr-think">
          <summary className="tr-sum">
            <IconMemory size={11} />
            <span className="tr-sum-text">thinking</span>
            <span className="tr-sum-count">{node.text.length} chars</span>
          </summary>
          <div className="tr-think-body">{node.text}</div>
        </details>
      );
    case "tool":
      return <ToolBlock node={node} />;
    case "result":
      return (
        <div className="tr-node tr-orphan">
          <div className="tr-tool-head">
            <IconBolt size={12} />
            <span className="tr-tool-name">result</span>
          </div>
          <ResultBlock result={node.result} />
        </div>
      );
    case "note":
      return (
        <div className="tr-node tr-note">
          <IconInfo size={11} />
          <span>{node.text}</span>
        </div>
      );
    case "error":
      return (
        <div className="tr-node tr-err">
          <IconX size={11} />
          <span>{node.text}</span>
        </div>
      );
    default:
      return <pre className="tr-node tr-raw">{node.text}</pre>;
  }
}

/** Clipboard fallback for webviews that deny the async clipboard API. */
function legacyCopy(text: string): boolean {
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
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

type Tab = "timeline" | "transcript";
const TABS: { id: Tab; label: string }[] = [
  { id: "timeline", label: "Timeline" },
  { id: "transcript", label: "Transcript" },
];

export function RunInspector({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useStore((s) => s.runs[runId]);
  const agent = useStore((s) => s.agents.find((a) => a.id === run?.agent_id));
  const [, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>("timeline");
  const [copied, setCopied] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const logAtBottomRef = useRef(true);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!run) void useStore.getState().loadRun(runId);
  }, [runId, run]);

  const running = run?.status === "running";

  // Tick every second so the duration counts up live while the run is going.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const events = useMemo<ActivityEvent[]>(() => {
    if (!run?.activity) return [];
    try {
      const parsed = JSON.parse(run.activity);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [run?.activity]);

  // Parsing is skipped entirely while the Timeline tab is showing: a long run
  // patches its transcript on every event, and re-parsing megabytes each time
  // for a hidden pane would make the whole modal stutter.
  const onTranscript = tab === "transcript";
  const transcript = run?.transcript ?? "";
  const parsed = useMemo<Parsed>(
    () => (onTranscript ? parseTranscript(transcript) : EMPTY_PARSE),
    [onTranscript, transcript]
  );

  useEffect(() => {
    atBottomRef.current = true; // opening a new run always jumps to the latest event
    logAtBottomRef.current = true;
    setCopied(false);
  }, [runId]);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  // Keep the timeline pinned to the latest event as activity streams in —
  // unless the user has scrolled up to read earlier events. `tab` is a dep so
  // that coming back to a pane re-pins it (a hidden element has no scrollHeight).
  useEffect(() => {
    const el = timelineRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [runId, tab, events.length]);

  useEffect(() => {
    const el = logRef.current;
    if (el && logAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [runId, tab, parsed.nodes.length]);

  if (!run) {
    return (
      <Modal title="Run inspector" onClose={onClose} wide>
        <div className="run-loading"><Spinner /> loading run…</div>
      </Modal>
    );
  }

  const name = agent?.name ?? "unknown agent";
  const durationMs = (run.finished_at || Date.now()) - run.started_at;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "Home" ? TABS[0]
      : e.key === "End" ? TABS[TABS.length - 1]
      : TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    e.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#run-tab-${next.id}`)
      ?.focus();
  };

  const copyRaw = async () => {
    if (!transcript) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(transcript);
      ok = true;
    } catch {
      ok = legacyCopy(transcript);
    }
    if (!ok) return;
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Modal title="Run inspector" onClose={onClose} wide>
      <div className="run-card">
        <div className="run-head">
          <Avatar name={name} id={run.agent_id} kind={agent?.kind} />
          <div className="run-head-main">
            <div className="run-agent-name">{name}</div>
            <div className="run-head-sub">started {new Date(run.started_at).toLocaleString()}</div>
          </div>
          <span className={`run-chip ${run.status}`}>
            <span className="run-chip-dot" />
            {run.status}
          </span>
        </div>

        <div className="run-facts">
          <div className="run-fact">
            <span className="run-fact-label">Duration</span>
            <span className="run-fact-value">{fmtDuration(durationMs)}{running ? "…" : ""}</span>
          </div>
          {run.meta && (
            /* "Agent reported", not "Run usage": this string comes back from
             * the CLI and carries its own seconds, which sit beside the
             * Duration we time ourselves and disagree with it — 40s against
             * 38s, unlabelled, side by side. Saying whose number it is makes
             * the gap legible instead of looking like one of them is wrong. */
            <div className="run-fact">
              <span className="run-fact-label">Agent reported</span>
              <span
                className="run-fact-value"
                title="Reported by the agent CLI, not measured here; dollar amounts are provider estimates."
              >
                {run.meta}
              </span>
            </div>
          )}
          {run.session_id && (
            <div className="run-fact">
              <span className="run-fact-label">Session</span>
              <span className="mono-trunc" title={run.session_id}>{run.session_id}</span>
            </div>
          )}
          {run.cwd && (
            <div className="run-fact run-fact-wide">
              <span className="run-fact-label">Working directory</span>
              <span className="mono-trunc" title={run.cwd}>{run.cwd}</span>
            </div>
          )}
          <div className="run-fact">
            <span className="run-fact-label">Model</span>
            <span className="run-fact-value">{run.model || agent?.model || "default"}</span>
          </div>
          <div className="run-fact">
            <span className="run-fact-label">Effort</span>
            <span className="run-fact-value">{run.effort || "default"}</span>
          </div>
          {run.command && (
            <div className="run-fact run-fact-wide">
              <span className="run-fact-label">Command</span>
              <span className="mono-trunc" title={run.command}>{run.command}</span>
            </div>
          )}
        </div>
      </div>

      <div className="tr-tabs" role="tablist" aria-label="Run detail">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`run-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`run-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={"tr-tab" + (tab === t.id ? " on" : "")}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        id="run-panel-timeline"
        role="tabpanel"
        aria-labelledby="run-tab-timeline"
        hidden={tab !== "timeline"}
      >
        <div className="run-timeline-head">
          <span className="field-label">Activity</span>
          <span className="run-ev-count">
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
        </div>
        <div
          className="run-timeline"
          ref={timelineRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {events.length === 0 && (
            <div className="run-empty">No activity recorded{running ? " yet" : ""}.</div>
          )}
          {events.map((ev, i) => {
            // Activity is parsed defensively — an unknown kind still gets a row.
            const known = EV_LABELS[ev.kind];
            return (
              <div key={i} className={"run-ev " + (known ? ev.kind : "info")}>
                <span className="run-ev-time">{fmtOffset(ev.t)}</span>
                <span className="run-ev-dot" />
                <span className="run-ev-kind">{known ?? "log"}</span>
                <span className="run-ev-detail">{ev.detail}</span>
              </div>
            );
          })}
          {running && events.length > 0 && (
            <div className="run-ev live">
              <span className="run-ev-time" />
              <span className="run-ev-dot" />
              <span className="run-ev-kind">live</span>
              <span className="run-ev-detail">waiting for the next event…</span>
            </div>
          )}
        </div>
      </div>

      <div
        id="run-panel-transcript"
        role="tabpanel"
        aria-labelledby="run-tab-transcript"
        hidden={tab !== "transcript"}
      >
        <div className="tr-head">
          <span className="field-label">Transcript</span>
          <span className="tr-count">
            {parsed.events} event{parsed.events === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn tiny tr-copy"
            onClick={() => void copyRaw()}
            disabled={!transcript}
            title="Copy the raw harness stream to the clipboard"
          >
            {copied ? (
              <>
                <IconCheck size={12} /> Copied
              </>
            ) : (
              "Copy raw"
            )}
          </button>
        </div>
        <div
          className="tr-log"
          ref={logRef}
          tabIndex={0}
          aria-label="Raw run transcript"
          onScroll={(e) => {
            const el = e.currentTarget;
            logAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {parsed.hidden > 0 && (
            <div className="tr-trimmed">
              {parsed.hidden} earlier {parsed.hidden === 1 ? "entry" : "entries"} hidden — use “Copy
              raw” for the whole stream.
            </div>
          )}
          {parsed.nodes.length === 0 && (
            <div className="run-empty">
              {running ? "Waiting for the first event…" : "No transcript recorded for this run."}
            </div>
          )}
          {parsed.nodes.map((n) => (
            <TranscriptNode key={n.id} node={n} speaker={name} />
          ))}
          {running && parsed.nodes.length > 0 && (
            <div className="tr-live">
              <span className="tr-live-dot" />
              streaming…
            </div>
          )}
        </div>
      </div>

      <details className="run-prompt">
        <summary>Prompt</summary>
        <pre>{run.prompt}</pre>
      </details>
    </Modal>
  );
}
