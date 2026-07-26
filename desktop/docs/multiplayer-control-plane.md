# Spaces multiplayer control plane

Spaces is local-first. The desktop app owns the working copies, terminals,
browser sessions, agent subprocesses, transcripts, and local SQLite state. The
web admin panel is a small Cloudflare control plane for identity, membership,
device enrollment, shared configuration, and explicitly requested cross-device
agent jobs.

## Identity and membership

ChatGPT sign-in establishes a person's identity; it does not automatically grant
workspace access. The admin panel applies a separate signup policy:

- `invite_only` is the production default. An existing member or valid invitation
  is required.
- `allowlist` admits exact, normalized addresses from
  `SPACES_SIGNUP_ALLOWLIST`.
- `open` creates the first workspace or admits a new person and is intended for
  controlled development and self-hosting.

Local development defaults to `open` when `SPACES_SIGNUP_MODE` is unset. A production
deployment defaults to `invite_only`.

## Pairing and device ownership

An authenticated member creates a short-lived, single-use pairing code in the
admin panel. The desktop exchanges it for a random device bearer token. Only a
hash of that token is stored in D1.

The enrolled device belongs to the member who created the code. Sync publishes
only its profile, available local harnesses, project mappings, agent profiles,
and health state. Revoking a device invalidates its access, fails its active
leases, removes its source mappings, and unhosts its agents.

## Projects and agents

`project_sources` maps each device's local project identifier to one shared
workspace project. This permits two computers to link different checkout paths
or local IDs to the same project without creating duplicate projects.

Every hosted agent has:

- an owning member;
- one enrolled host device;
- `private` or workspace visibility;
- harness, model, effort, persona, and advanced CLI arguments; and
- a source-agent mapping back to the host's local SQLite record.

A member may publish their own local agent. A private agent can only be requested
by its owner. A workspace agent can be requested by another workspace member,
but still runs only on its designated host.

## Durable job lifecycle

```text
queued -> claimed -> running -> completed | failed | cancelled -> delivered
```

The server assigns a short lease to the exact host device. The host must present
the lease token to start, heartbeat, and finish the job. Expired claims are
requeued. A stable requester run ID makes enqueueing idempotent.

The requesting desktop persists a visible run immediately, follows
queued/claimed/running updates, applies the terminal result to its local channel,
and acknowledges delivery. If it closes first, the unacknowledged result remains
available and is recovered after restart. Cancellation invalidates the host
lease and stops the local process when possible.

## Data boundary

The following stay on the host device:

- repositories and working files;
- terminal and browser history;
- full prompts assembled from local context;
- process streams, transcripts, diffs, and session IDs; and
- local secrets and provider credentials.

For an explicit cross-device run, the control plane carries the requested
prompt, lifecycle state, and a sanitized final result. The server accepts only
`content`, `meta`, `model`, and `effort` from a host result; command lines,
activities, transcripts, and session identifiers are discarded.

## Open-source and self-hosted configuration

The product does not depend on the original deployment's workspace identity. A
deployment chooses its signup policy and OAuth providers through environment
configuration, creates its own D1 database, and enrolls its own people and
devices. ChatGPT Sites can provide the authenticated web identity and UI; the
Cloudflare worker/D1 service provides durable control-plane state.
