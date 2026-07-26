# Spaces portal

The authenticated control plane for Spaces. The desktop app is the operating
workspace; this web panel administers:

- teammate identity, invitations, and workspace roles;
- agent roles, ownership, harnesses, models, and reasoning effort;
- teams and organizational policy;
- trusted Spaces desktop enrollment; and
- privacy-safe health summaries from paired desktops; and
- durable, host-bound agent job delivery between paired devices.

Workspace data is stored in Cloudflare D1. Identity comes from the authenticated
OpenAI workspace request headers. The browser UI requires ChatGPT sign-in and
server-side membership. Public machine endpoints accept only expiring,
single-use pairing codes or a separate hashed token per device. Repository
contents, full process transcripts, terminal output, and browser history stay
local. For a cross-device run, the requested prompt and final result are
persisted in D1 until the requesting device applies and acknowledges the result.

## Membership policy

ChatGPT authentication establishes identity but does not itself grant workspace
membership. Configure admission with:

- `SPACES_SIGNUP_MODE=invite_only` (the production default);
- `SPACES_SIGNUP_MODE=allowlist` plus `SPACES_SIGNUP_ALLOWLIST`; or
- `SPACES_SIGNUP_MODE=open` for controlled development and self-hosting.

Existing members always retain access. A paired device is owned by the member who
created its single-use code.

## Cross-device agent jobs

Agents are explicitly owned, hosted on one enrolled device, and either private
to their owner or visible to the workspace. The durable lifecycle is:

```text
queued -> claimed -> running -> completed | failed | cancelled -> delivered
```

Only the designated host can claim a job. Claims use expiring heartbeat leases;
request IDs are idempotent; and unacknowledged terminal results survive a
requester restart. Result persistence is server-sanitized to final content,
metadata, model, and effort. Code, terminal output, browser history, command
lines, sessions, diffs, and full process transcripts remain on the host.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm ci
npm run dev
```

## Validation

```bash
npm test
npx tsc --noEmit
npm run lint
```

Do not commit `.openai/hosting.json`; it binds the source tree to one Sites
deployment. Copy `.openai/hosting.example.json` and insert your own project ID.
See the root [self-hosting guide](../docs/SELF_HOSTING.md).
