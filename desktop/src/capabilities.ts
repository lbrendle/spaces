/**
 * capabilities.ts — a declarative manifest of what each agent harness can do.
 *
 * Spaces spawns three very different things:
 *
 *   claude  →  claude -p --output-format stream-json --verbose [flags]   (prompt on stdin)
 *   codex   →  codex exec --json [flags] -                               (prompt on stdin)
 *   ritz    →  POST <ritz endpoint>/chat                            (JSON body, SSE reply)
 *
 * The first two are configured with CLI flags, the third with JSON body
 * fields — so every option declares `kind: "flag" | "json"` and the
 * serializer emits the right wire form.
 *
 * The agent row only has two columns to store all of this: `model` and
 * `cli_args`. So:
 *   • options with `storage: "model"` live in the `model` column;
 *   • everything else round-trips through `cli_args` via
 *     serializeArgs() / parseArgs(), including Ritz's JSON fields (stored
 *     as `key=value` tokens so a single text column keeps working).
 *
 * Anything in `cli_args` that the manifest does not recognise is kept
 * verbatim under EXTRA_KEY and re-emitted unchanged, so hand-written flags
 * are never silently dropped.
 *
 * Flag names and enum values below were verified against `--help` on this
 * machine — do not "tidy" them.
 */
import { config } from "./config";
import { invoke } from "@tauri-apps/api/core";
import type { BuiltinAgentKind } from "./types";

/**
 * Open by design — see AgentKind in types.ts. The registry below is the source
 * of truth for which ids exist; this alias only supplies autocomplete.
 */
export type HarnessKind = BuiltinAgentKind | (string & {});

/** Widget used to edit an option. */
export type ControlKind = "text" | "enum" | "boolean" | "number" | "repeatable";

export type OptionValue = string | boolean | string[];
export type OptionValues = Record<string, OptionValue>;

/** Where unrecognised flags / fields are parked so nothing is ever lost. */
export const EXTRA_KEY = "__extra";

export interface HarnessOption {
  /** Stable id. For `kind: "json"` this is also the JSON body field name. */
  key: string;
  label: string;
  /** One sentence, shown under the control. */
  help: string;
  control: ControlKind;
  /** How the value reaches the harness. */
  kind: "flag" | "json";
  /** CLI token emitted for this option (flag options only). */
  flag?: string;
  /** Short form additionally accepted when parsing hand-written args. */
  alias?: string;
  /** Fixed set — rendered as a <select>. */
  choices?: readonly string[];
  /** Free-text hints — rendered as one-click chips. */
  suggestions?: readonly string[];
  default?: OptionValue;
  placeholder?: string;
  /** Section heading in the editor; options render in manifest order. */
  group?: string;
  /** Values that widen what the agent may do, mapped to the warning copy. */
  risky?: Readonly<Record<string, string>>;
  /** Lives in the agent's own `model` column rather than in cli_args. */
  storage?: "model";
  /** Rejected by `codex exec resume` — translated or dropped on resume. */
  execOnly?: boolean;
  /** Choices come from a live source rather than `choices`. */
  dynamic?: "ritz-models";
  /** Summarised as a chip on the agent card. */
  chip?: boolean;
  /** Connection metadata stored with the agent but never sent in the request body. */
  transportOnly?: boolean;
  /** Numeric bounds (control: "number"). */
  step?: string;
  min?: string;
  max?: string;
}

/**
 * What a harness can actually do, so the rest of the app can ask instead of
 * branching on `kind`. Every field is answerable for any harness, including
 * ones Spaces never spawns.
 */
export interface HarnessCaps {
  /** Can continue a prior session, so a turn is a reply rather than a re-brief. */
  resume: boolean;
  /** How the Spaces MCP server reaches it. */
  mcp: "config-file" | "args" | "none";
  /** Emits structured tool-call events (so the inspector can show live steps). */
  toolEvents: boolean;
  /** Reports tokens/cost at the end of a turn. */
  usage: boolean;
  /** Can be pointed at its own git worktree. */
  worktrees: boolean;
  /** Where the model list comes from in the editor. */
  models: "suggestions" | "dynamic" | "free";
  /** Spaces streams its output live rather than learning about it afterwards. */
  streaming: boolean;
}

/**
 * How Spaces checks whether this harness exists on the current Mac. CLI
 * harnesses are looked up on PATH; external ones are macOS app bundles.
 */
export interface HarnessProbe {
  /** Executable to resolve on PATH. "" when the user supplies it. */
  bin?: string;
  /** Args that print a version cheaply and exit non-interactively. */
  versionArgs?: readonly string[];
  /**
   * Args that report whether the user is signed in, for the harnesses that
   * have such a command. Omitted where Spaces has not verified one — an
   * unknown sign-in state is reported as unknown, never guessed.
   */
  authArgs?: readonly string[];
  /** Substring in the auth command's output that means "signed in". */
  authOkMatch?: string;
  /** Bundle identifier of a GUI app, for `wire: "external"` harnesses. */
  bundleId?: string;
  /** Conventional install location, shown when the probe fails. */
  appPath?: string;
  /** Where to get it, shown when it is missing. */
  installHint?: string;
}

export interface HarnessMeta {
  kind: HarnessKind;
  label: string;
  blurb: string;
  /**
   * "cli" harnesses are spawned as processes, "http" ones are called over the
   * network, and "external" ones Spaces never starts at all — they run in their
   * own app against the same checkout and collaborate through git and .hq.
   */
  wire: "cli" | "http" | "external";
  /** Fixed prefix Spaces always passes — shown in the preview, never editable. */
  base: string;
  /** Copy for the Advanced → raw disclosure. */
  rawLabel: string;
  rawHelp: string;
  rawPlaceholder: string;
  caps: HarnessCaps;
  probe?: HarnessProbe;
  /** Who makes it — shown on the picker so a long list stays scannable. */
  vendor?: string;
  /**
   * True when the flags below were checked against this harness's own --help.
   * A declared-but-unverified harness still runs; the editor just says so
   * rather than implying Spaces knows its CLI by heart.
   */
  verified?: boolean;
}

/* ── Ritz (local engine) ──────────────────────────────────────── */

/**
 * Local model server for the `ritz` kind. Read through config() so a fork can
 * point it elsewhere — or run none at all — without editing this manifest.
 */
export const RITZ_BASE = config().localAiUrl;
export const RITZ_CHAT_URL = `${RITZ_BASE}/chat`;
export const RITZ_MODELS_URL = `${RITZ_BASE}/models`;

export interface RitzModel {
  key: string;
  name: string;
  notes?: string;
  tier?: string;
  status?: string;
}

export interface RitzModelList {
  /** The engine's own default model key. */
  default: string;
  models: RitzModel[];
}

/**
 * GET /models on the local engine. Tolerates a bare array, {models:[…]} or
 * {data:[…]}, and entries that are plain strings. Throws if unreachable —
 * callers fall back to free text.
 */
export function ritzBase(values?: OptionValues): string {
  const configured = typeof values?.endpoint === "string" ? values.endpoint.trim() : "";
  return (configured || RITZ_BASE).replace(/\/+$/, "");
}

export function ritzHealthRoute(values?: OptionValues): string {
  const configured = typeof values?.health_route === "string" ? values.health_route.trim() : "";
  if (!configured) return "/health";
  return configured.startsWith("/") ? configured : `/${configured}`;
}

export async function fetchRitzModels(
  signal?: AbortSignal,
  baseUrl: string = RITZ_BASE,
  headers: Record<string, string> = {}
): Promise<RitzModelList> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal, headers });
  if (!res.ok) throw new Error(`${config().localAiName} returned ${res.status}`);
  const raw: unknown = await res.json();
  const box = (raw ?? {}) as Record<string, unknown>;
  const list: unknown = Array.isArray(raw) ? raw : box.models ?? box.data ?? [];
  const models: RitzModel[] = (Array.isArray(list) ? list : []).map((m) => {
    if (typeof m === "string") return { key: m, name: m };
    const o = (m ?? {}) as Record<string, unknown>;
    const key = String(o.key ?? o.id ?? o.name ?? "");
    return {
      key,
      name: String(o.name ?? key),
      notes: o.notes ? String(o.notes) : undefined,
      tier: o.tier ? String(o.tier) : undefined,
      status: o.status ? String(o.status) : undefined,
    };
  }).filter((m) => m.key !== "");
  return { default: typeof box.default === "string" ? box.default : "", models };
}

/** Verify both the configured liveness route and the HTTP agent contract. */
export async function checkRitzRuntime(
  signal: AbortSignal | undefined,
  baseUrl: string,
  healthRoute: string,
  headers: Record<string, string> = {}
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  const route = healthRoute.trim();
  if (route) {
    const health = await fetch(`${base}${route.startsWith("/") ? route : `/${route}`}`, { signal, headers });
    if (!health.ok) throw new Error(`${config().localAiName} health check returned ${health.status}`);
  }
  await fetchRitzModels(signal, base, headers);
}

/** Resolve HTTP credentials at request time; secret material never enters agent configuration. */
export async function ritzAuthHeaders(values?: OptionValues): Promise<Record<string, string>> {
  if (values?.authentication !== "upa-keychain-bearer") return {};
  const token = await invoke<string>("read_upa_spaces_token");
  if (!token) throw new Error("Universal Personal Agent bearer token is unavailable in Mac Keychain");
  return { Authorization: `Bearer ${token}` };
}

/**
 * The JSON body Spaces posts to /chat. `values` supplies the configured fields;
 * `runtime` supplies the per-run ones. Empty options are omitted so the
 * engine's own defaults apply.
 */
export function ritzBody(
  values: OptionValues,
  runtime?: {
    conversationId?: string;
    message?: string;
    workspace?: string;
    systemPrompt?: string;
    principalActorId?: string;
    triggerOrigin?: string;
    attachments?: Array<{
      name: string;
      mime_type: string;
      data_base64: string;
      sha256?: string;
    }>;
  }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    conversation_id: runtime?.conversationId ?? "<channel>:<agent>",
    message: runtime?.message ?? "<prompt>",
  };
  if (runtime?.workspace !== undefined) body.workspace = runtime.workspace;
  if (runtime?.systemPrompt) body.system_prompt = runtime.systemPrompt;
  if (runtime?.principalActorId) body.principal_actor_id = runtime.principalActorId;
  if (runtime?.triggerOrigin) body.trigger_origin = runtime.triggerOrigin;
  if (runtime?.attachments?.length) body.attachments = runtime.attachments;
  for (const opt of RITZ_OPTIONS) {
    if (opt.transportOnly) continue;
    const v = values[opt.key];
    if (opt.control === "boolean") {
      body[opt.key] = v === true;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (opt.control === "number") {
      const n = Number(s);
      if (Number.isFinite(n)) body[opt.key] = n;
      continue;
    }
    body[opt.key] = s;
  }
  return body;
}

/* ── Manifest ─────────────────────────────────────────────────── */

const CLAUDE_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Primary model",
    help: "Short alias or a full model id. Blank uses whatever your Claude Code default is.",
    control: "text",
    kind: "flag",
    flag: "--model",
    storage: "model",
    suggestions: ["opus", "sonnet", "haiku"],
    placeholder: "opus",
    group: "Model",
    chip: true,
  },
  {
    key: "effort",
    label: "Effort",
    help: "How much reasoning the agent should spend on this session.",
    control: "enum",
    kind: "flag",
    flag: "--effort",
    choices: ["low", "medium", "high", "xhigh", "max"],
    default: "high",
    group: "Model",
    chip: true,
  },
  {
    key: "fallback_model",
    label: "Fallback model",
    help: "Retried with this model when the primary one is overloaded.",
    control: "text",
    kind: "flag",
    flag: "--fallback-model",
    suggestions: ["sonnet", "haiku"],
    placeholder: "sonnet",
    group: "Model",
  },
  {
    key: "permission_mode",
    label: "Permission mode",
    help: "How much the agent may do without stopping to ask. Spaces runs headless, so anything that would prompt just stalls the run.",
    control: "enum",
    kind: "flag",
    flag: "--permission-mode",
    choices: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
    default: "bypassPermissions",
    group: "Permissions",
    chip: true,
    risky: {
      bypassPermissions:
        "Every tool runs with no confirmation at all — file writes, shell commands and network calls, anywhere this agent can reach. Use it only in a throwaway worktree.",
    },
  },
  {
    key: "allowed_tools",
    label: "Allowed tools",
    help: "Space-separated allowlist, e.g. Read Edit Bash(git:*). Leave blank for the default set.",
    control: "text",
    kind: "flag",
    flag: "--allowedTools",
    placeholder: "Read Edit Bash(git:*)",
    group: "Permissions",
  },
  {
    key: "disallowed_tools",
    label: "Disallowed tools",
    help: "Space-separated denylist, applied on top of the allowlist.",
    control: "text",
    kind: "flag",
    flag: "--disallowedTools",
    placeholder: "Bash(rm:*) WebFetch",
    group: "Permissions",
  },
  {
    key: "add_dir",
    label: "Extra directories",
    help: "Additional roots the agent may read and write, on top of its working directory.",
    control: "repeatable",
    kind: "flag",
    flag: "--add-dir",
    placeholder: `${config().samplePath}/other-repo`,
    group: "Context",
  },
  {
    key: "append_system_prompt",
    label: "Appended system prompt",
    help: "Extra standing instructions appended to Claude Code's own system prompt (the agent's persona is sent with the message instead).",
    control: "text",
    kind: "flag",
    flag: "--append-system-prompt",
    placeholder: "Always run the test suite before you reply.",
    group: "Context",
  },
  {
    key: "settings",
    label: "Settings file",
    help: "Path to a settings JSON file, or inline JSON, layered over your user settings.",
    control: "text",
    kind: "flag",
    flag: "--settings",
    placeholder: "./.claude/settings.json",
    group: "Advanced",
  },
];

const CODEX_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Model",
    help: "Passed as -m. Blank uses your Codex default.",
    control: "text",
    kind: "flag",
    flag: "-m",
    alias: "--model",
    storage: "model",
    suggestions: ["gpt-5-codex", "o3"],
    placeholder: "gpt-5-codex",
    group: "Model",
    chip: true,
  },
  {
    key: "effort",
    label: "Reasoning effort",
    help: "Sets Codex model_reasoning_effort for new and resumed runs.",
    control: "enum",
    kind: "flag",
    flag: "-c",
    choices: ["minimal", "low", "medium", "high", "xhigh"],
    default: "high",
    group: "Model",
    chip: true,
  },
  {
    key: "sandbox",
    label: "Sandbox",
    help: "What model-generated shell commands may touch. `codex exec resume` rejects this flag, so on resume Spaces sends it as -c sandbox_mode=\"…\" instead.",
    control: "enum",
    kind: "flag",
    flag: "--sandbox",
    alias: "-s",
    choices: ["read-only", "workspace-write", "danger-full-access"],
    default: "workspace-write",
    group: "Sandbox",
    execOnly: true,
    chip: true,
    risky: {
      "danger-full-access":
        "The sandbox is switched off: commands can write anywhere on disk and reach the network. Only sane inside a disposable worktree or VM.",
    },
  },
  {
    key: "add_dir",
    label: "Extra directories",
    help: "Additional writable roots alongside the workspace. Not accepted on resume, so it applies to the first turn of a session.",
    control: "repeatable",
    kind: "flag",
    flag: "--add-dir",
    placeholder: `${config().samplePath}/other-repo`,
    group: "Sandbox",
    execOnly: true,
  },
  {
    key: "skip_git_repo_check",
    label: "Allow running outside a git repo",
    help: "Codex refuses to start outside a repository unless this is set. Keep it on for scratch directories.",
    control: "boolean",
    kind: "flag",
    flag: "--skip-git-repo-check",
    default: true,
    group: "Session",
  },
  {
    key: "ephemeral",
    label: "Ephemeral session",
    help: "Runs without writing session files to disk. Note that Spaces's resume/threading needs persisted sessions.",
    control: "boolean",
    kind: "flag",
    flag: "--ephemeral",
    group: "Session",
  },
  {
    key: "profile",
    label: "Config profile",
    help: "Layers ~/.codex/<name>.config.toml over your base config. Exec-only — dropped on resume.",
    control: "text",
    kind: "flag",
    flag: "--profile",
    placeholder: "review",
    group: "Advanced",
    execOnly: true,
  },
  {
    key: "config",
    label: "Config overrides",
    help: "Raw -c key=value overrides, one per row. The value is parsed as TOML, so quote strings.",
    control: "repeatable",
    kind: "flag",
    flag: "-c",
    alias: "--config",
    placeholder: 'model_reasoning_effort="high"',
    group: "Advanced",
  },
];

const RITZ_OPTIONS: readonly HarnessOption[] = [
  {
    key: "protocol",
    label: "Protocol preset",
    help: "Spaces-compatible HTTP uses GET /models and streaming POST /chat.",
    control: "enum",
    kind: "json",
    choices: ["spaces-compatible-http"],
    default: "spaces-compatible-http",
    group: "Connection",
    transportOnly: true,
    chip: true,
  },
  {
    key: "endpoint",
    label: "Endpoint",
    help: `Blank inherits the installation default (${RITZ_BASE}); set this to give this agent its own engine.`,
    control: "text",
    kind: "json",
    placeholder: RITZ_BASE,
    group: "Connection",
    transportOnly: true,
    chip: true,
  },
  {
    key: "health_route",
    label: "Health route",
    help: "A lightweight route used by connection checks before a run.",
    control: "text",
    kind: "json",
    default: "/health",
    placeholder: "/health",
    group: "Connection",
    transportOnly: true,
  },
  {
    key: "authentication",
    label: "Authentication",
    help: "Trusted local origin works with a localhost-only engine; bearer credentials belong in the Mac Keychain, never this field.",
    control: "enum",
    kind: "json",
    choices: ["trusted-local-origin", "upa-keychain-bearer", "none"],
    default: "trusted-local-origin",
    group: "Connection",
    transportOnly: true,
  },
  {
    key: "model",
    label: "Model",
    help: `Fetched live from ${config().localAiName}. Blank lets the engine route the message itself.`,
    control: "text",
    kind: "json",
    storage: "model",
    dynamic: "ritz-models",
    placeholder: "auto",
    group: "Model",
    chip: true,
  },
  {
    key: "use_tools",
    label: "Tools",
    help: "Lets the engine call its local tools (files, shell, search). Off means chat only.",
    control: "boolean",
    kind: "json",
    default: true,
    group: "Behavior",
    chip: true,
  },
  {
    key: "deep",
    label: "Deep thinking",
    help: "Longer multi-pass reasoning before answering. Slower, better on hard problems.",
    control: "boolean",
    kind: "json",
    default: false,
    group: "Behavior",
    chip: true,
  },
  {
    key: "research",
    label: "Research",
    help: "Lets the engine gather sources before answering.",
    control: "boolean",
    kind: "json",
    default: false,
    group: "Behavior",
    chip: true,
  },
  {
    key: "temperature",
    label: "Temperature",
    help: "0 is deterministic, 1 is loose. Blank uses the engine default.",
    control: "number",
    kind: "json",
    placeholder: "0.7",
    step: "0.05",
    min: "0",
    max: "2",
    group: "Generation",
  },
  {
    key: "max_tokens",
    label: "Max tokens",
    help: "Upper bound on the reply length. Blank uses the engine default.",
    control: "number",
    kind: "json",
    placeholder: "4096",
    step: "256",
    min: "1",
    group: "Generation",
  },
];

const CUSTOM_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Executable",
    help: "Command name on PATH or an absolute executable path. Spaces sends the prompt on stdin and reads stdout.",
    control: "text",
    kind: "flag",
    storage: "model",
    placeholder: "aider",
    group: "Command",
    chip: true,
  },
];

/* ── Cursor Agent ─────────────────────────────────────────────── */

const CURSOR_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Model",
    help: "Model id as Cursor names it. Blank uses your Cursor default. `cursor-agent models` lists them.",
    control: "text",
    kind: "flag",
    flag: "--model",
    storage: "model",
    suggestions: ["gpt-5", "sonnet-4-thinking", "opus-4-thinking"],
    placeholder: "sonnet-4-thinking",
    group: "Model",
    chip: true,
  },
  {
    key: "mode",
    label: "Mode",
    help: "plan and ask are read-only. Leave blank for the normal read/write agent.",
    control: "enum",
    kind: "flag",
    flag: "--mode",
    choices: ["", "plan", "ask"],
    group: "Model",
    chip: true,
  },
  {
    key: "force",
    label: "Run everything",
    help: "Allows every command unless explicitly denied. Spaces runs headless, so a tool that stops to ask just stalls the turn.",
    control: "boolean",
    kind: "flag",
    flag: "--force",
    default: true,
    group: "Permissions",
    chip: true,
    risky: {
      true: "Every shell command and file write runs unattended, anywhere this agent can reach. Pair it with an isolated worktree.",
    },
  },
  {
    key: "sandbox",
    label: "Sandbox",
    help: "Overrides the sandbox setting in your Cursor config for this agent.",
    control: "enum",
    kind: "flag",
    flag: "--sandbox",
    choices: ["", "enabled", "disabled"],
    group: "Permissions",
  },
  {
    key: "trust",
    label: "Trust workspace",
    help: "Skips the workspace-trust prompt, which headless runs cannot answer.",
    control: "boolean",
    kind: "flag",
    flag: "--trust",
    default: true,
    group: "Permissions",
  },
  {
    key: "approve_mcps",
    label: "Approve MCP servers",
    help: "Auto-approves MCP servers so the Spaces tool surface is reachable without a prompt.",
    control: "boolean",
    kind: "flag",
    flag: "--approve-mcps",
    default: true,
    group: "Permissions",
  },
];

/* ── Gemini CLI ───────────────────────────────────────────────── */

const GEMINI_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Model",
    help: "Model id. Blank uses the Gemini CLI default.",
    control: "text",
    kind: "flag",
    flag: "--model",
    alias: "-m",
    storage: "model",
    suggestions: ["gemini-2.5-pro", "gemini-2.5-flash"],
    placeholder: "gemini-2.5-pro",
    group: "Model",
    chip: true,
  },
  {
    key: "yolo",
    label: "Auto-approve tools",
    help: "Accepts every tool call without asking. Required for headless runs.",
    control: "boolean",
    kind: "flag",
    flag: "--yolo",
    default: true,
    group: "Permissions",
    chip: true,
    risky: {
      true: "Every tool call runs unattended. Pair it with an isolated worktree.",
    },
  },
];

/* ── Aider ────────────────────────────────────────────────────── */

const AIDER_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Model",
    help: "Any model string Aider accepts, including provider prefixes.",
    control: "text",
    kind: "flag",
    flag: "--model",
    storage: "model",
    suggestions: ["sonnet", "gpt-5", "o3"],
    placeholder: "sonnet",
    group: "Model",
    chip: true,
  },
  {
    key: "yes",
    label: "Auto-confirm",
    help: "Answers Aider's confirmation prompts, which a headless run cannot.",
    control: "boolean",
    kind: "flag",
    flag: "--yes-always",
    default: true,
    group: "Permissions",
    chip: true,
  },
  {
    key: "auto_commits",
    label: "Aider commits",
    help: "Off hands committing to Spaces, so every turn is bracketed by one Spaces checkpoint instead of two histories.",
    control: "boolean",
    kind: "flag",
    flag: "--no-auto-commits",
    default: true,
    group: "Git",
  },
];

/* ── OpenCode ─────────────────────────────────────────────────── */

const OPENCODE_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "Model",
    help: "provider/model as OpenCode names it.",
    control: "text",
    kind: "flag",
    flag: "--model",
    alias: "-m",
    storage: "model",
    suggestions: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
    placeholder: "anthropic/claude-sonnet-4-5",
    group: "Model",
    chip: true,
  },
];

/* ── External (an agent Spaces does not launch) ───────────────── */

const EXTERNAL_OPTIONS: readonly HarnessOption[] = [
  {
    key: "model",
    label: "App",
    help: "The app this teammate runs in — used for the roster, and to check it is installed.",
    control: "text",
    kind: "flag",
    storage: "model",
    suggestions: ["Muse", "Cursor", "Zed", "Claude", "Windsurf"],
    placeholder: "Muse",
    group: "App",
    chip: true,
  },
  {
    key: "bundle_id",
    label: "Bundle id",
    help: "macOS bundle identifier, so Spaces can tell whether the app is installed and running. Blank skips that check.",
    control: "text",
    kind: "flag",
    placeholder: "com.meta.endo",
    suggestions: ["com.meta.endo", "com.todesktop.230313mzl4w4u92", "dev.zed.Zed", "com.anthropic.claudefordesktop"],
    group: "App",
  },
  {
    key: "workdir",
    label: "Working directory",
    help:
      "Where this agent edits code. A directory of its own — a second checkout or a worktree — is what lets Spaces tell its commits from everyone else's. Blank means the shared project checkout, where it can only be credited with uncommitted changes.",
    control: "text",
    kind: "flag",
    placeholder: "/Users/you/code/project",
    group: "Git",
  },
  {
    key: "git_author",
    label: "Git author match",
    help:
      "Substring matched against commit author name or email. Use it when this agent shares a checkout but commits under its own identity — most local agents commit as you, so check `git log` before relying on it. With neither this nor a working directory of its own set, Spaces will not attribute any commit to this agent rather than guess.",
    control: "text",
    kind: "flag",
    placeholder: "muse",
    group: "Git",
    chip: true,
  },
  {
    key: "handoff",
    label: "Hand-off file",
    help: "Where Spaces writes a brief when this agent is addressed. Relative to the project root.",
    control: "text",
    kind: "flag",
    default: ".hq/inbox",
    placeholder: ".hq/inbox",
    group: "Hand-off",
  },
];

export const HARNESSES: readonly HarnessMeta[] = [
  {
    kind: "claude",
    label: "Claude Code",
    blurb: "Runs the claude CLI in the project checkout, on your Claude subscription.",
    vendor: "Anthropic",
    wire: "cli",
    verified: true,
    base: "claude -p --output-format stream-json --verbose",
    rawLabel: "Raw flags",
    rawHelp: "Everything above, serialized. Edit it and the controls follow; unknown flags are kept and passed through untouched.",
    rawPlaceholder: "--permission-mode acceptEdits",
    caps: {
      resume: true,
      mcp: "config-file",
      toolEvents: true,
      usage: true,
      worktrees: true,
      models: "suggestions",
      streaming: true,
    },
    probe: { bin: "claude", versionArgs: ["--version"], installHint: "claude.com/claude-code" },
  },
  {
    kind: "codex",
    label: "Codex",
    blurb: "Runs codex exec in the project checkout, on your ChatGPT subscription.",
    vendor: "OpenAI",
    wire: "cli",
    verified: true,
    base: "codex exec --json",
    rawLabel: "Raw flags",
    rawHelp: "Everything above, serialized. Edit it and the controls follow; unknown flags are kept and passed through untouched.",
    rawPlaceholder: "--sandbox workspace-write --skip-git-repo-check",
    caps: {
      resume: true,
      mcp: "args",
      toolEvents: true,
      usage: true,
      worktrees: true,
      models: "suggestions",
      streaming: true,
    },
    probe: { bin: "codex", versionArgs: ["--version"], installHint: "npm i -g @openai/codex" },
  },
  {
    kind: "cursor",
    label: "Cursor Agent",
    blurb: "Runs cursor-agent headless in the project checkout, on your Cursor account.",
    vendor: "Cursor",
    wire: "cli",
    verified: true,
    base: "cursor-agent -p --output-format stream-json",
    rawLabel: "Raw flags",
    rawHelp: "Everything above, serialized. Edit it and the controls follow; unknown flags are kept and passed through untouched.",
    rawPlaceholder: "--force --sandbox disabled",
    caps: {
      resume: true,
      mcp: "config-file",
      toolEvents: true,
      usage: true,
      worktrees: true,
      models: "suggestions",
      streaming: true,
    },
    probe: {
      bin: "cursor-agent",
      versionArgs: ["--version"],
      // `cursor-agent status` is documented in its own --help as "View
      // authentication status", and exits non-interactively.
      //
      // Verified on a signed-out machine: it prints "Not logged in" and exits
      // **0**. So the exit code says nothing here, and the doctor's text check
      // is what catches it. No authOkMatch: the signed-in wording has not been
      // seen, and guessing it would turn a working agent into a false alarm.
      authArgs: ["status"],
      installHint: "cursor.com/cli",
    },
  },
  {
    kind: "gemini",
    label: "Gemini CLI",
    blurb: "Runs the gemini CLI non-interactively in the project checkout.",
    vendor: "Google",
    wire: "cli",
    base: "gemini --prompt",
    rawLabel: "Raw flags",
    rawHelp: "Everything above, serialized. Check them against `gemini --help` — Spaces has not verified this harness on your Mac.",
    rawPlaceholder: "--yolo",
    caps: {
      resume: false,
      mcp: "config-file",
      toolEvents: false,
      usage: false,
      worktrees: true,
      models: "suggestions",
      streaming: true,
    },
    probe: { bin: "gemini", versionArgs: ["--version"], installHint: "npm i -g @google/gemini-cli" },
  },
  {
    kind: "aider",
    label: "Aider",
    blurb: "Runs aider in message mode against the project checkout.",
    vendor: "Aider",
    wire: "cli",
    base: "aider --message",
    rawLabel: "Raw flags",
    rawHelp: "Everything above, serialized. Check them against `aider --help` — Spaces has not verified this harness on your Mac.",
    rawPlaceholder: "--no-stream --no-pretty",
    caps: {
      resume: false,
      mcp: "none",
      toolEvents: false,
      usage: false,
      worktrees: true,
      models: "suggestions",
      streaming: true,
    },
    probe: { bin: "aider", versionArgs: ["--version"], installHint: "pip install aider-install" },
  },
  {
    kind: "opencode",
    label: "OpenCode",
    blurb: "Runs opencode as a one-shot in the project checkout.",
    vendor: "SST",
    wire: "cli",
    base: "opencode run",
    rawLabel: "Raw flags",
    rawHelp: "Everything above, serialized. Check them against `opencode run --help` — Spaces has not verified this harness on your Mac.",
    rawPlaceholder: "--agent build",
    caps: {
      resume: false,
      mcp: "config-file",
      toolEvents: false,
      usage: false,
      worktrees: true,
      models: "suggestions",
      streaming: true,
    },
    probe: { bin: "opencode", versionArgs: ["--version"], installHint: "opencode.ai" },
  },
  {
    kind: "ritz",
    label: `${config().localAiName} (HTTP)`,
    blurb: `A configurable local or self-hosted engine at ${RITZ_BASE} — no vendor lock-in.`,
    wire: "http",
    verified: true,
    base: `POST ${RITZ_CHAT_URL}`,
    rawLabel: "Raw body fields",
    rawHelp: "The JSON body fields, as key=value pairs. Edit them and the controls follow; unknown fields are kept and sent as-is.",
    rawPlaceholder: "use_tools=true deep=false",
    caps: {
      resume: true,
      mcp: "none",
      toolEvents: true,
      usage: false,
      worktrees: true,
      models: "dynamic",
      streaming: true,
    },
  },
  {
    kind: "external",
    label: "External app",
    blurb:
      "A teammate Spaces does not launch — Muse, Cursor, Zed or a terminal you drive yourself. It joins through the shared repo and .hq, and Spaces tracks its branch, its diff and its hand-offs.",
    wire: "external",
    verified: true,
    base: "(not launched by Spaces)",
    rawLabel: "Attachment settings",
    rawHelp: "How Spaces recognises this agent's work and where it leaves briefs for it.",
    rawPlaceholder: "git_author=muse workdir=/Users/you/code/project",
    caps: {
      resume: false,
      mcp: "config-file",
      toolEvents: false,
      usage: false,
      worktrees: true,
      models: "free",
      streaming: false,
    },
  },
  {
    kind: "custom",
    label: "Custom CLI",
    blurb: "Runs any local stdin/stdout agent or harness in the project checkout.",
    wire: "cli",
    verified: true,
    base: "<executable>",
    rawLabel: "Arguments",
    rawHelp: "Arguments passed after the executable. The prompt is sent on stdin; plain text or JSON-line output is accepted.",
    rawPlaceholder: "--json --yes",
    caps: {
      resume: false,
      mcp: "config-file",
      toolEvents: true,
      usage: false,
      worktrees: true,
      models: "free",
      streaming: true,
    },
  },
];

const MANIFEST: Record<string, readonly HarnessOption[]> = {
  claude: CLAUDE_OPTIONS,
  codex: CODEX_OPTIONS,
  cursor: CURSOR_OPTIONS,
  gemini: GEMINI_OPTIONS,
  aider: AIDER_OPTIONS,
  opencode: OPENCODE_OPTIONS,
  ritz: RITZ_OPTIONS,
  external: EXTERNAL_OPTIONS,
  custom: CUSTOM_OPTIONS,
};

/**
 * Unknown kinds degrade to the Custom CLI shape rather than crashing: an agent
 * row synced from a newer build, or from a fork with harnesses this one has
 * never heard of, still opens and still runs.
 */
function norm(kind: string): HarnessKind {
  return MANIFEST[kind] ? kind : "custom";
}

/** Every harness that can be spawned or attached, in picker order. */
export function harnessKinds(): readonly string[] {
  return HARNESSES.map((h) => h.kind);
}

/** What this harness can do. Ask this instead of branching on `kind`. */
export function capsFor(kind: string): HarnessCaps {
  return harnessFor(kind).caps;
}

/** True for agents Spaces never spawns — they run in their own app. */
export function isExternal(kind: string): boolean {
  return harnessFor(kind).wire === "external";
}

/**
 * The executable a harness runs, which is not its id — the Cursor harness is
 * `cursor` and its binary is `cursor-agent`.
 *
 * Every PATH question in the app goes through this. Asking `tools["cursor"]`
 * instead returns undefined forever, which reads as "still checking" and never
 * resolves; that was true of every harness added after the original two.
 *
 * `model` supplies the executable for a Custom CLI, where it is the user's own.
 * Returns "" for harnesses with no binary at all.
 */
export function harnessBin(kind: string, model = ""): string {
  const meta = harnessFor(kind);
  if (meta.wire !== "cli") return "";
  if (norm(kind) === "custom") return model.trim();
  return meta.probe?.bin ?? "";
}

export function harnessFor(kind: string): HarnessMeta {
  const k = norm(kind);
  return HARNESSES.find((h) => h.kind === k) ?? HARNESSES[0];
}

export function optionsFor(kind: string): readonly HarnessOption[] {
  return MANIFEST[norm(kind)];
}

export function optionFor(kind: string, key: string): HarnessOption | undefined {
  return optionsFor(kind).find((o) => o.key === key);
}

/** Options in manifest order, bucketed by `group` (first-appearance order). */
export function groupedOptions(kind: string): { name: string; options: HarnessOption[] }[] {
  const groups: { name: string; options: HarnessOption[] }[] = [];
  for (const opt of optionsFor(kind)) {
    const name = opt.group ?? "Options";
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, options: [] }));
    g.options.push(opt);
  }
  return groups;
}

/** Every key present, everything switched off — the base parseArgs builds on. */
function emptyValues(kind: string): OptionValues {
  const values: OptionValues = {};
  for (const opt of optionsFor(kind)) {
    values[opt.key] = opt.control === "boolean" ? false : opt.control === "repeatable" ? [] : "";
  }
  values[EXTRA_KEY] = "";
  return values;
}

/** The starting point for a *new* agent: Spaces's opinionated defaults. */
export function defaultsFor(kind: string): OptionValues {
  const values = emptyValues(kind);
  for (const opt of optionsFor(kind)) {
    if (opt.default !== undefined) values[opt.key] = opt.default;
  }
  return values;
}

/* ── Shell-ish tokenizing ─────────────────────────────────────── */

/** Quote a value so it survives as one argument. Inverse of tokenize(). */
export function quoteArg(v: string): string {
  if (v === "") return '""';
  if (!/[\s"'\\]/.test(v)) return v;
  return `"${v.replace(/([\\"])/g, "\\$1")}"`;
}

/** Split an argument string into tokens, honouring quotes and backslashes. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false; // so an explicit "" survives as an empty token
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        cur += s[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== "" || started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (cur !== "" || started) out.push(cur);
  return out;
}

function asList(v: OptionValue | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}

function asText(v: OptionValue | undefined): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.join(" ");
  return "";
}

/* ── Serialize / parse ────────────────────────────────────────── */

/**
 * Values → the string stored in `agents.cli_args`.
 *
 * Flag harnesses emit `--flag value`; Ritz emits `field=value` tokens for
 * its JSON body. Options with `storage: "model"` are skipped — they live in
 * the agent's own model column. Unrecognised text is appended verbatim.
 */
export function serializeArgs(kind: string, values: OptionValues): string {
  const parts: string[] = [];
  for (const opt of optionsFor(kind)) {
    if (opt.storage === "model") continue;
    const v = values[opt.key];
    if (opt.control === "boolean") {
      if (opt.kind === "json") parts.push(`${opt.key}=${v === true ? "true" : "false"}`);
      else if (v === true) parts.push(opt.flag ?? "");
      continue;
    }
    if (opt.control === "repeatable") {
      for (const item of asList(v)) {
        const t = item.trim();
        if (!t) continue;
        if (opt.kind === "json") parts.push(`${opt.key}=${quoteArg(t)}`);
        else parts.push(opt.flag ?? "", quoteArg(t));
      }
      continue;
    }
    const text = asText(v).trim();
    if (!text) continue;
    if (opt.kind === "json") parts.push(`${opt.key}=${quoteArg(text)}`);
    else if (norm(kind) === "codex" && opt.key === "effort") {
      parts.push("-c", quoteArg(`model_reasoning_effort="${text}"`));
    }
    else parts.push(opt.flag ?? "", quoteArg(text));
  }
  const extra = asText(values[EXTRA_KEY]).trim();
  if (extra) parts.push(extra);
  return parts.filter((p) => p !== "").join(" ");
}

/**
 * `agents.cli_args` → values, best effort.
 *
 * Reflects the string and nothing else: a flag that isn't there reads as off,
 * so opening an agent for editing can never silently switch something on.
 * (New agents start from defaultsFor() instead.) Anything unrecognised —
 * including flags for a tool we do not model — is collected under EXTRA_KEY
 * so it round-trips untouched.
 */
export function parseArgs(kind: string, cliArgs: string): OptionValues {
  const opts = optionsFor(kind);
  const values = emptyValues(kind);
  const seenRepeat = new Set<string>();
  const extra: string[] = [];
  const tokens = tokenize(cliArgs ?? "");

  const byFlag = new Map<string, HarnessOption>();
  for (const o of opts) {
    if (o.kind !== "flag") continue;
    if (o.flag) byFlag.set(o.flag, o);
    if (o.alias) byFlag.set(o.alias, o);
  }
  const byField = new Map<string, HarnessOption>();
  for (const o of opts) if (o.kind === "json") byField.set(o.key, o);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "") continue;

    // JSON harnesses: field=value tokens.
    const eq = tok.indexOf("=");
    if (eq > 0 && !tok.startsWith("-")) {
      const field = tok.slice(0, eq);
      const raw = tok.slice(eq + 1);
      const opt = byField.get(field);
      if (opt) {
        // The outer tokenize() already stripped any quoting around the value.
        if (opt.control === "boolean") values[opt.key] = raw !== "false" && raw !== "0" && raw !== "";
        else values[opt.key] = raw;
        continue;
      }
      extra.push(tok);
      continue;
    }

    if (!tok.startsWith("-")) {
      extra.push(quoteArg(tok));
      continue;
    }

    // --flag=value as well as --flag value
    let name = tok;
    let inline: string | null = null;
    const feq = tok.indexOf("=");
    if (feq > 0) {
      name = tok.slice(0, feq);
      inline = tok.slice(feq + 1);
    }

    // Codex carries effort through its generic -c config surface. Pull the
    // known key into the first-class Effort control while preserving every
    // unrelated config override in the repeatable Advanced field.
    if (norm(kind) === "codex" && (name === "-c" || name === "--config")) {
      let value = inline;
      if (value === null) {
        if (i + 1 >= tokens.length) continue;
        value = tokens[++i];
      }
      const match = value.match(/^model_reasoning_effort\s*=\s*["']?([^"']+)["']?$/);
      if (match) {
        values.effort = match[1];
      } else {
        const prev = seenRepeat.has("config") ? asList(values.config) : [];
        seenRepeat.add("config");
        values.config = [...prev, value];
      }
      continue;
    }

    const opt = byFlag.get(name);
    if (!opt) {
      extra.push(tok.includes(" ") ? quoteArg(tok) : tok);
      continue;
    }
    if (opt.control === "boolean") {
      values[opt.key] = inline === null ? true : inline !== "false" && inline !== "0";
      continue;
    }
    let value = inline;
    if (value === null) {
      if (i + 1 >= tokens.length) continue; // dangling flag, nothing to take
      value = tokens[++i];
    }
    if (opt.control === "repeatable") {
      const prev = seenRepeat.has(opt.key) ? asList(values[opt.key]) : [];
      seenRepeat.add(opt.key);
      values[opt.key] = [...prev, value];
    } else {
      values[opt.key] = value;
    }
  }

  values[EXTRA_KEY] = extra.join(" ");
  return values;
}

/**
 * Values carried across a backend switch: keep anything whose key still
 * exists on the new harness and whose value is still legal there.
 *
 * The model is the exception — it is dropped when it came from the old
 * harness's own list ("opus" means nothing to Codex) or when the harnesses
 * talk over different wires (a Ritz model key means nothing to a CLI, and
 * vice versa). A hand-typed id survives a CLI-to-CLI switch.
 */
export function carryOver(fromKind: string, toKind: string, values: OptionValues): OptionValues {
  const next = defaultsFor(toKind);
  if (norm(fromKind) === norm(toKind)) return { ...values };
  for (const opt of optionsFor(toKind)) {
    const v = values[opt.key];
    if (v === undefined) continue;
    if (opt.control === "repeatable") {
      const list = asList(v);
      if (list.length) next[opt.key] = list;
      continue;
    }
    if (opt.control === "boolean") {
      if (typeof v === "boolean") next[opt.key] = v;
      continue;
    }
    const text = asText(v);
    if (!text) continue;
    if (opt.choices && !opt.choices.includes(text)) continue;
    if (opt.key === "model") {
      if (norm(fromKind) === "custom" || norm(toKind) === "custom") continue;
      const prev = optionFor(fromKind, "model");
      const fromList = Boolean(prev?.suggestions?.includes(text)) || prev?.dynamic !== undefined;
      const crossWire = harnessFor(fromKind).wire !== harnessFor(toKind).wire;
      if (fromList || crossWire) continue;
    }
    next[opt.key] = text;
  }
  return next;
}

/* ── Preview, risks, chips ────────────────────────────────────── */

/** The exact command Spaces will run — or, for Ritz, the request it will send. */
export function commandPreview(kind: string, values: OptionValues): string {
  const meta = harnessFor(kind);
  if (meta.wire === "http") {
    return `POST ${ritzBase(values)}/chat\n${JSON.stringify(ritzBody(values), null, 2)}`;
  }
  if (meta.wire === "external") {
    // There is no command. Showing what Spaces *does* do instead is the honest
    // preview: it writes a brief and then reads git.
    const app = asText(values.model).trim() || "the app";
    const dir = asText(values.workdir).trim();
    const handoff = asText(values.handoff).trim() || ".hq/inbox";
    return [
      `# Spaces does not launch ${app}.`,
      `write  ${handoff}/<agent>.md   # the same brief a spawned agent gets`,
      `watch  ${dir || "<project checkout>"}   # commits and uncommitted changes`,
    ].join("\n");
  }
  const k = norm(kind);
  const modelOpt = optionFor(k, "model");
  const model = asText(values.model).trim();
  const parts = [k === "custom" ? quoteArg(model || "<executable>") : meta.base];
  if (model && modelOpt?.flag) parts.push(modelOpt.flag, quoteArg(model));
  const args = serializeArgs(k, values);
  if (args) parts.push(args);
  // codex reads the prompt from stdin via a trailing "-"; cursor-agent and
  // aider have no stdin reader and take it as the last argument instead.
  if (k === "codex") parts.push("-");
  else if (k === "cursor" || k === "aider") parts.push("<prompt>");
  return parts.join(" ");
}

export interface RiskNote {
  key: string;
  value: string;
  label: string;
  message: string;
}

/** Warnings for chosen values that widen what the agent may do. */
export function riskNotes(kind: string, values: OptionValues): RiskNote[] {
  const out: RiskNote[] = [];
  for (const opt of optionsFor(kind)) {
    if (!opt.risky) continue;
    const v = asText(values[opt.key]);
    const message = opt.risky[v];
    if (message) out.push({ key: opt.key, value: v, label: opt.label, message });
  }
  return out;
}

export interface CapChip {
  key: string;
  label: string;
  risky: boolean;
}

/** Compact model/mode summary for an agent card. */
export function agentChips(kind: string, model: string, cliArgs: string): CapChip[] {
  const values = parseArgs(kind, cliArgs);
  const typed = model.trim();
  if (typed) values.model = typed;
  const chips: CapChip[] = [];
  for (const opt of optionsFor(kind)) {
    if (!opt.chip) continue;
    const v = values[opt.key];
    if (opt.control === "boolean") {
      if (v === true) chips.push({ key: opt.key, label: opt.label.toLowerCase(), risky: false });
      continue;
    }
    const text = asText(v).trim();
    if (!text) continue;
    chips.push({ key: opt.key, label: text, risky: Boolean(opt.risky?.[text]) });
  }
  return chips;
}

/** Stable label stored with each run so later agent edits do not rewrite history. */
export function configuredEffort(kind: string, cliArgs: string): string {
  const values = parseArgs(kind, cliArgs);
  if (norm(kind) === "ritz") return values.deep === true ? "deep" : "standard";
  return asText(values.effort).trim();
}

/**
 * Flags for `codex exec resume <id> --json`, which rejects exec-only flags:
 * --sandbox becomes `-c sandbox_mode="…"`, and the other exec-only options
 * (--add-dir, --profile) are dropped rather than crashing the resume.
 * Claude and Ritz resume with their configuration unchanged.
 */
export function resumeArgs(kind: string, cliArgs: string): string {
  const k = norm(kind);
  if (k !== "codex") return cliArgs;
  const values = parseArgs(k, cliArgs);
  const sandbox = asText(values.sandbox).trim();
  const kept: OptionValues = { ...values };
  for (const opt of optionsFor(k)) {
    if (!opt.execOnly) continue;
    kept[opt.key] = opt.control === "repeatable" ? [] : opt.control === "boolean" ? false : "";
  }
  const args = serializeArgs(k, kept);
  if (!sandbox) return args;
  // -c values are parsed as TOML, so the mode has to arrive quoted.
  const translated = `-c ${quoteArg(`sandbox_mode="${sandbox}"`)}`;
  return args ? `${translated} ${args}` : translated;
}
