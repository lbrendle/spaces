/**
 * The stable contract between Spaces and every coding runtime it launches.
 *
 * Claude, Codex and Ritz have different process protocols, but they should not
 * have different ideas about where they are, which channel they are answering,
 * or how to act on the workspace. Buzz solves that with one base prompt owned
 * by its event harness. Spaces does the same here while keeping its native
 * subscription-backed CLI adapters.
 *
 * Keep this contract compact and platform-shaped. Project, team, channel and
 * agent instructions are dynamic and belong in agents.ts, not here.
 */

export const SPACES_HARNESS_PROTOCOL = "spaces-event-v1";

export const SPACES_BASE_PROMPT = `You are operating inside Spaces — a local-first workspace for human-agent collaboration. The Spaces event harness routes channel events to this session.

## Spaces interface

- The current \`[Spaces Context]\` block is authoritative. Never infer the active project, channel, event, reply destination, or working directory from an older turn.
- The Spaces MCP tools (\`spaces_*\` and legacy \`hq_*\`) are your primary interface to live workspace state. Use \`spaces_list_messages\` to catch up on channel history.
- If MCP is unavailable but you have a shell, call the same tool surface as structured JSON with \`node "$SPACES_CLI" "$SPACES_PROJECT_ROOT" --call <tool> '<json-arguments>'\`. If neither transport exists, follow \`.hq/ACTIONS.md\` and append writes to \`.hq/actions.jsonl\`.
- Generated \`.hq/\` files are the durable project brief and fallback interface: read \`CONTEXT.md\`, \`ROSTER.md\`, \`BOARD.md\`, \`LINKS.md\`, \`KNOWLEDGE.md\`, \`CONTENT.md\`, and the current channel file before consequential work.
- Your final assistant response is published automatically to the current reply destination. Do not call \`hq_post\` to reply here; use it only when you intentionally need to post into another channel.
- For social work, inspect \`spaces_list_content\` and \`spaces_list_social_accounts\`, then update the canonical Content Studio card. Do not leave final copy, media, account selection, scheduling, or publishing state only in chat.
- Credentials never belong in the repo or chat. Use the Spaces mail, calendar, social, document, browser, Knowledge, Git, and Content Studio tools.
- Additive workspace changes may apply immediately. Destructive, publishing, access, and reassignment actions can require human approval; never claim they happened until the tool or app confirms them.
- Work in the supplied directory. Respect its Git state and the project instructions. Report concrete results, files, verification, blockers, and decisions without repeating the conversation.`;

export const SPACES_RESUME_PROMPT =
  "Spaces turn refresh: treat the following [Spaces Context] block as authoritative, " +
  "use the Spaces MCP tools for live state, and re-read the relevant generated .hq files " +
  "before relying on remembered workspace state.";

export interface SpacesEventContext {
  runId: string;
  agentId: string;
  agentName: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  workingDirectory: string;
  channelId: string;
  channelName: string;
  eventId: string;
  replyTo: string;
  authorId: string;
  authorName: string;
  authorType: "user" | "agent";
  taskId: string;
  sessionMode: "new" | "resume";
}

/** JSON-string values keep names or paths containing punctuation on one line. */
export function spacesContextEnvelope(context: SpacesEventContext): string {
  const fields: Array<[string, string]> = [
    ["harness", SPACES_HARNESS_PROTOCOL],
    ["run_id", context.runId],
    ["session_mode", context.sessionMode],
    ["agent_id", context.agentId],
    ["agent", context.agentName],
    ["project_id", context.projectId],
    ["project", context.projectName],
    ["project_root", context.projectRoot],
    ["working_directory", context.workingDirectory],
    ["channel_id", context.channelId],
    ["channel", context.channelName],
    ["event_id", context.eventId],
    ["reply_to", context.replyTo],
    ["author_id", context.authorId],
    ["author", context.authorName],
    ["author_type", context.authorType],
    ["task_id", context.taskId],
  ];
  return [
    "[Spaces Context]",
    ...fields.map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    "[/Spaces Context]",
  ].join("\n");
}
