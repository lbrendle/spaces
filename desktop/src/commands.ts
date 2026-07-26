/**
 * Slash commands.
 *
 * Two kinds, and the distinction matters:
 *
 *  - Spaces commands (/model, /mode, /reset …) change Spaces's own state. They never
 *    reach a harness; they run locally and post a system message.
 *  - Harness commands (/review, /commit, anything in .claude/commands) are
 *    passed through verbatim. Verified: Claude Code expands custom slash
 *    commands in headless `-p` mode, so a project's existing commands work
 *    here with no porting.
 *
 * Anything unrecognised is passed through rather than rejected — a harness may
 * know commands we don't, and refusing to send them would be worse than
 * letting the harness answer.
 */
import { invoke } from "@tauri-apps/api/core";
import { useStore, channelAgents } from "./store";
import { slug } from "./types";
import type { Agent, ChannelMode } from "./types";
import { harnessFor, optionsFor, parseArgs, serializeArgs } from "./capabilities";

export interface SlashCommand {
  name: string;
  /** Short arg hint shown in the picker, e.g. "<opus|sonnet>". */
  args?: string;
  description: string;
  /** "hq" runs locally; "harness" is forwarded to the agent(s). */
  scope: "hq" | "harness";
}

export interface CommandOutcome {
  /** True when Spaces consumed the input; no agent run should be started. */
  handled: boolean;
  /** Posted into the channel as a system message. */
  message?: string;
  /** Replaces the user's text when forwarding (currently always the original). */
  forward?: string;
}

const MODE_IDS: ChannelMode[] = ["broadcast", "sequential", "lead", "panel"];

export const SPACES_COMMANDS: SlashCommand[] = [
  { name: "model", args: "<model> [@agent]", description: "Set an agent's model", scope: "hq" },
  { name: "mode", args: "<broadcast|sequential|lead|panel>", description: "How this channel dispatches", scope: "hq" },
  { name: "lead", args: "@agent", description: "Set the channel's lead agent", scope: "hq" },
  { name: "reset", args: "[@agent]", description: "Forget the conversation — next mention starts fresh", scope: "hq" },
  { name: "agents", description: "Show this channel's roster and settings", scope: "hq" },
  { name: "help", description: "List available commands", scope: "hq" },
];

/** Split "/name rest of line" — returns null when the text isn't a command. */
export function parseSlash(text: string): { name: string; rest: string } | null {
  const m = /^\s*\/([a-z0-9][a-z0-9:_-]*)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: m[2].trim() };
}

/**
 * Commands defined by the project itself (.claude/commands/*.md). Uses
 * `git ls-files --cached --others --exclude-standard`, which lists tracked AND
 * untracked files, so a command works the moment it's written.
 */
export async function discoverProjectCommands(projectPath: string): Promise<SlashCommand[]> {
  if (!projectPath) return [];
  try {
    const out = await invoke<string>("run_git", {
      args: ["ls-files", "--cached", "--others", "--exclude-standard", ".claude/commands"],
      cwd: projectPath,
    });
    const names = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".md"))
      .map((l) => l.split("/").pop()!.replace(/\.md$/, ""))
      .filter(Boolean);
    return [...new Set(names)].map((name) => ({
      name,
      description: "Project command (.claude/commands)",
      scope: "harness" as const,
    }));
  } catch {
    return []; // not a repo, no git, no commands — all non-fatal
  }
}

/** Everything offerable in the composer's picker, Spaces commands first. */
export async function availableCommands(projectPath: string): Promise<SlashCommand[]> {
  const project = await discoverProjectCommands(projectPath);
  const taken = new Set(SPACES_COMMANDS.map((c) => c.name));
  return [...SPACES_COMMANDS, ...project.filter((c) => !taken.has(c.name))];
}

function findAgent(channelId: string, handle: string): Agent | undefined {
  const h = handle.replace(/^@/, "").toLowerCase();
  return channelAgents(useStore.getState(), channelId).find((a) => slug(a.name) === h);
}

/** The agent a command applies to when none is named. */
function defaultAgent(channelId: string): Agent | undefined {
  const s = useStore.getState();
  const members = channelAgents(s, channelId);
  if (members.length === 1) return members[0];
  const channel = s.channels.find((c) => c.id === channelId);
  return members.find((a) => a.id === channel?.lead_agent_id) ?? undefined;
}

function describeAgent(a: Agent): string {
  const h = harnessFor(a.kind);
  const values = parseArgs(a.kind, a.cli_args ?? "");
  const mode = optionsFor(a.kind).find((o) => o.key === "permission_mode" || o.key === "sandbox");
  const modeVal = mode ? String(values[mode.key] ?? "") : "";
  return `@${slug(a.name)} — ${h.label}${a.model ? `, ${a.model}` : ""}${modeVal ? `, ${modeVal}` : ""}`;
}

/**
 * Run a slash command. Returns handled:false when the input should go to the
 * agents unchanged (harness commands and anything unknown).
 */
export async function runCommand(
  channelId: string,
  text: string
): Promise<CommandOutcome> {
  const parsed = parseSlash(text);
  if (!parsed) return { handled: false };
  const { name, rest } = parsed;
  const s = useStore.getState();
  const channel = s.channels.find((c) => c.id === channelId);
  if (!channel) return { handled: false };

  switch (name) {
    case "help": {
      const project = s.projects.find((p) => p.id === channel.project_id);
      const cmds = await availableCommands(project?.local_path ?? "");
      const hq = cmds.filter((c) => c.scope === "hq");
      const harness = cmds.filter((c) => c.scope === "harness");
      const fmt = (c: SlashCommand) =>
        `\`/${c.name}${c.args ? " " + c.args : ""}\` — ${c.description}`;
      return {
        handled: true,
        message: [
          "**Spaces commands**",
          ...hq.map(fmt),
          harness.length ? "\n**Project commands** (passed to the agent)" : "",
          ...harness.map(fmt),
          "\nAnything else starting with `/` is sent to the agent as-is.",
        ].filter(Boolean).join("\n"),
      };
    }

    case "agents": {
      const members = channelAgents(s, channelId);
      if (!members.length) {
        return { handled: true, message: "No agents in this channel yet — add some with the ⚉ button." };
      }
      const lead = members.find((a) => a.id === channel.lead_agent_id);
      return {
        handled: true,
        message: [
          `**#${channel.name}** — mode \`${channel.mode || "broadcast"}\`` +
            (lead ? `, lead @${slug(lead.name)}` : ""),
          ...members.map((a) => `- ${describeAgent(a)}`),
        ].join("\n"),
      };
    }

    case "mode": {
      const want = rest.trim().toLowerCase() as ChannelMode;
      if (!MODE_IDS.includes(want)) {
        return { handled: true, message: `Usage: \`/mode ${MODE_IDS.join("|")}\` — currently \`${channel.mode || "broadcast"}\`.` };
      }
      await s.updateChannel(channelId, { mode: want });
      return { handled: true, message: `#${channel.name} now dispatches in **${want}** mode.` };
    }

    case "lead": {
      const target = findAgent(channelId, rest.trim());
      if (!target) {
        return { handled: true, message: `Usage: \`/lead @agent\` — must be an agent in this channel.` };
      }
      await s.updateChannel(channelId, { lead_agent_id: target.id });
      return { handled: true, message: `**${target.name}** is now the lead for #${channel.name}.` };
    }

    case "model": {
      const parts = rest.split(/\s+/).filter(Boolean);
      const handle = parts.find((p) => p.startsWith("@"));
      const model = parts.filter((p) => !p.startsWith("@")).join(" ").trim();
      const target = handle ? findAgent(channelId, handle) : defaultAgent(channelId);
      if (!target) {
        return {
          handled: true,
          message: "Which agent? Use `/model <model> @agent` — this channel has more than one.",
        };
      }
      if (!model) {
        const suggestions =
          optionsFor(target.kind).find((o) => o.key === "model")?.suggestions ?? [];
        return {
          handled: true,
          message:
            `**${target.name}** is on \`${target.model || "the harness default"}\`.` +
            (suggestions.length
              ? ` Try: ${suggestions.map((m: string) => `\`${m}\``).join(", ")}.`
              : ""),
        };
      }
      await s.updateAgent(target.id, { model });
      // The model is fixed when a CLI session starts, so a new one is required.
      await s.clearSession(channelId, target.id);
      return {
        handled: true,
        message: `**${target.name}** now uses \`${model}\`. Its conversation here was reset so the change takes effect.`,
      };
    }

    case "reset": {
      const handle = rest.trim();
      if (handle) {
        const target = findAgent(channelId, handle);
        if (!target) return { handled: true, message: `No agent \`${handle}\` in this channel.` };
        await s.clearSession(channelId, target.id);
        return { handled: true, message: `**${target.name}** forgot this channel's conversation.` };
      }
      const members = channelAgents(s, channelId);
      await Promise.all(members.map((a) => s.clearSession(channelId, a.id)));
      return {
        handled: true,
        message: `Reset ${members.length} conversation${members.length === 1 ? "" : "s"} in #${channel.name}.`,
      };
    }

    default:
      // Unknown to Spaces — let the harness try. Claude Code expands its own
      // custom commands in headless mode.
      return { handled: false };
  }
}

/** Re-serialize an agent's options after a UI-free change (used by /model). */
export function withOption(agent: Agent, key: string, value: string): string {
  const values = parseArgs(agent.kind, agent.cli_args ?? "");
  return serializeArgs(agent.kind, { ...values, [key]: value });
}
