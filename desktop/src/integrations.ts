/**
 * integrations.ts — the supported agents, and one click to have one.
 *
 * A harness is a mechanism: "external app" is a transport, not a teammate.
 * An *integration* is the thing a person actually wants — "Muse", "Codex" —
 * and it is a harness plus the settings that make that particular product
 * work. Without this layer, adding Muse means knowing that it is an external
 * app, that its bundle identifier is `com.meta.endo`, and that neither of
 * those facts is discoverable from the agent editor.
 *
 * Every integration here is one Spaces has checked against the real thing on a
 * real machine: a CLI whose flags came from its own `--help`, or an app whose
 * bundle identifier resolves through Launch Services. Nothing is listed on the
 * strength of documentation alone — an integration that has not been verified
 * is worse than no integration, because it fails at the first turn instead of
 * at setup.
 */
import { defaultsFor, harnessFor, serializeArgs, type OptionValues } from "./capabilities";
import { currentDeviceId } from "./deviceIdentity";

export interface Integration {
  /** Stable id, used for React keys and for the "already added" check. */
  id: string;
  /** Product name, as its makers write it. */
  label: string;
  /** The registry harness this runs on. */
  kind: string;
  /** One line: what it is, and what it will do here. */
  blurb: string;
  /** The agent's name when added with one click. */
  agentName: string;
  role: string;
  /**
   * Settings on top of the harness defaults — a bundle identifier, an app
   * name. Everything here is a value Spaces has verified resolves.
   */
  values?: OptionValues;
  /** Goes in the agent's `model` column. */
  model?: string;
  /** Shown when the integration is not present on this machine. */
  installHint?: string;
}

/**
 * Ordered by how most people will read the list: the coding agents they
 * already run, then the ones that work in their own window, then the engine
 * they host themselves.
 */
export const INTEGRATIONS: readonly Integration[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "claude",
    blurb: "Anthropic's CLI, on the subscription already signed in on this Mac.",
    agentName: "Claude",
    role: "Engineer",
    installHint: "claude.com/claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    kind: "codex",
    blurb: "OpenAI's CLI, on the ChatGPT subscription signed in on this Mac.",
    agentName: "Codex",
    role: "Engineer",
    installHint: "npm i -g @openai/codex",
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    kind: "cursor",
    blurb: "Cursor's headless agent, on your Cursor account.",
    agentName: "Cursor",
    role: "Engineer",
    installHint: "cursor.com/cli",
  },
  {
    id: "muse",
    label: "Muse",
    kind: "external",
    blurb:
      "Meta's agent. Spaces cannot launch it — it works in its own window, and meets Spaces in the repository.",
    agentName: "Muse",
    role: "Engineer",
    model: "Muse",
    // Measured against Muse 1.0: its composer sits 160 points from the left of
    // the window and 39 up from the bottom. Auto-send is on because a brief
    // nobody opens is not a teammate — the toggle is in the agent's settings.
    values: {
      bundle_id: "com.meta.endo",
      autosend: true,
      composer_dx: "160",
      composer_dy: "39",
    },
  },
  {
    id: "zed",
    label: "Zed",
    kind: "external",
    blurb: "Zed's agent, working in the same checkout from its own editor.",
    agentName: "Zed",
    role: "Engineer",
    model: "Zed",
    // No measured composer geometry for Zed, so auto-send stays off until
    // somebody sets the offsets; a guessed click lands somewhere arbitrary.
    values: { bundle_id: "dev.zed.Zed" },
  },
];

/**
 * The agent row an integration produces.
 *
 * `serializeArgs` writes the harness's own defaults plus whatever the
 * integration prefills, so a one-click agent is configured exactly as the
 * editor would have configured it — there is no second, sloppier path into
 * the same table.
 */
export function agentFromIntegration(
  integration: Integration,
  takenNames: readonly string[]
): {
  name: string;
  kind: string;
  model: string;
  role: string;
  cli_args: string;
  host_device_id: string;
} {
  const values: OptionValues = { ...defaultsFor(integration.kind), ...(integration.values ?? {}) };
  if (integration.model) values.model = integration.model;

  return {
    name: uniqueName(integration.agentName, takenNames),
    kind: integration.kind,
    model: integration.model ?? String(values.model ?? ""),
    role: integration.role,
    cli_args: serializeArgs(integration.kind, values),
    // A CLI agent is deliberately unhosted: any paired Mac that has the binary
    // can run it. An external one cannot be — its app is installed on a
    // particular machine, and "is it installed and open" is only answerable
    // there. Recording the host is what that means, and it also stops a portal
    // that has never heard of this harness from rewriting the agent on the way
    // back down: the sync keeps the local kind for agents hosted here.
    host_device_id: harnessFor(integration.kind).wire === "external" ? currentDeviceId() : "",
  };
}

/**
 * "Codex", then "Codex 2". Mentions resolve by handle, so two agents sharing a
 * name is a real ambiguity rather than a cosmetic one — worth avoiding without
 * making the person think about it.
 */
export function uniqueName(base: string, taken: readonly string[]): string {
  const lower = taken.map((n) => n.trim().toLowerCase());
  if (!lower.includes(base.toLowerCase())) return base;
  for (let n = 2; n < 50; n++) {
    const candidate = `${base} ${n}`;
    if (!lower.includes(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now().toString().slice(-4)}`;
}

/** The app name an external integration checks for, "" for the others. */
export function integrationApp(integration: Integration): string {
  return harnessFor(integration.kind).wire === "external" ? (integration.model ?? "") : "";
}
