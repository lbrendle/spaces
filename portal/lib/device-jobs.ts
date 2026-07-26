import { getD1 } from "../db";
import { authorizeDevice } from "./workspace";

type SqlValue = string | number | null;

type AuthorizedDevice = Awaited<ReturnType<typeof authorizeDevice>>;

interface AgentJobRow {
  id: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  requestedByDeviceId: string;
  requestedByDeviceName: string;
  hostDeviceId: string;
  projectId: string | null;
  projectName: string;
  channelId: string;
  requesterRunId: string;
  inputJson: string;
  status: string;
  resultJson: string | null;
  error: string;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export class DeviceJobError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function db() {
  return getD1();
}

async function all<T>(sql: string, ...values: SqlValue[]): Promise<T[]> {
  const statement = values.length ? db().prepare(sql).bind(...values) : db().prepare(sql);
  const result = await statement.all<T>();
  return (result.results ?? []) as T[];
}

async function first<T>(sql: string, ...values: SqlValue[]): Promise<T | null> {
  const rows = await all<T>(sql, ...values);
  return rows[0] ?? null;
}

async function run(sql: string, ...values: SqlValue[]) {
  const statement = values.length ? db().prepare(sql).bind(...values) : db().prepare(sql);
  return statement.run();
}

function now(): string {
  return new Date().toISOString();
}

function future(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function text(value: unknown, max = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function randomToken(bytes = 24): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function recordActivity(
  workspaceId: string,
  actorId: string,
  kind: string,
  summary: string,
  entityId: string,
) {
  const createdAt = now();
  await db().batch([
    db()
      .prepare(
        `INSERT INTO activity
          (id, workspace_id, actor_id, kind, summary, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id("act"),
        workspaceId,
        actorId,
        kind,
        summary,
        entityId,
        createdAt,
      ),
    db()
      .prepare(
        `INSERT INTO workspace_events
          (workspace_id, actor_id, kind, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, actorId, kind, entityId, createdAt),
  ]);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function publicJob(row: AgentJobRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    agentName: row.agentName,
    requestedByDeviceId: row.requestedByDeviceId,
    requestedByDeviceName: row.requestedByDeviceName,
    hostDeviceId: row.hostDeviceId,
    projectId: row.projectId,
    projectName: row.projectName,
    channelId: row.channelId,
    requesterRunId: row.requesterRunId,
    input: parseJson<Record<string, unknown>>(row.inputJson, {}),
    status: row.status,
    result: parseJson<Record<string, unknown> | null>(row.resultJson, null),
    error: row.error,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  };
}

const JOB_SELECT = `
  SELECT j.id, j.workspace_id AS workspaceId, j.agent_id AS agentId,
         a.name AS agentName,
         j.requested_by_device_id AS requestedByDeviceId,
         COALESCE(requester.name, 'Another paired desktop') AS requestedByDeviceName,
         j.host_device_id AS hostDeviceId, j.project_id AS projectId,
         COALESCE(p.name, 'Unlinked project') AS projectName,
         j.channel_id AS channelId, j.requester_run_id AS requesterRunId,
         j.input_json AS inputJson, j.status, j.result_json AS resultJson,
         j.error, j.created_at AS createdAt, j.claimed_at AS claimedAt,
         j.started_at AS startedAt, j.finished_at AS finishedAt,
         j.updated_at AS updatedAt
    FROM agent_jobs j
    JOIN agent_profiles a ON a.id = j.agent_id
    LEFT JOIN devices requester ON requester.id = j.requested_by_device_id
    LEFT JOIN projects p ON p.id = j.project_id`;

async function requireLease(
  device: AuthorizedDevice,
  jobId: string,
  leaseToken: string,
): Promise<AgentJobRow> {
  if (!jobId || !leaseToken) {
    throw new DeviceJobError(400, "Job id and lease token are required.");
  }
  const leaseTokenHash = await sha256(leaseToken);
  const job = await first<AgentJobRow>(
    `${JOB_SELECT}
      WHERE j.id = ? AND j.workspace_id = ? AND j.host_device_id = ?
        AND j.lease_token_hash = ?
        AND j.status IN ('claimed', 'running')`,
    jobId,
    device.workspaceId,
    device.id,
    leaseTokenHash,
  );
  if (!job) {
    throw new DeviceJobError(409, "This agent job lease is invalid or no longer active.");
  }
  return job;
}

async function enqueue(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const agentId = text(input.agentId, 180);
  const requesterRunId = text(input.requesterRunId, 180);
  const prompt = text(input.prompt, 120_000);
  if (!agentId || !requesterRunId || !prompt) {
    throw new DeviceJobError(400, "Agent, requester run, and prompt are required.");
  }
  const agent = await first<{
    id: string;
    name: string;
    hostDeviceId: string | null;
    ownerUserId: string | null;
    visibility: string;
  }>(
    `SELECT id, name, host_device_id AS hostDeviceId,
            owner_user_id AS ownerUserId, visibility
       FROM agent_profiles
      WHERE id = ? AND workspace_id = ?`,
    agentId,
    device.workspaceId,
  );
  if (!agent) throw new DeviceJobError(404, "That agent is not in this workspace.");
  if (!agent.hostDeviceId) {
    throw new DeviceJobError(409, `${agent.name} does not have a host device.`);
  }
  if (
    agent.visibility === "private" &&
    agent.ownerUserId &&
    agent.ownerUserId !== device.ownerUserId
  ) {
    throw new DeviceJobError(403, `${agent.name} is private to another workspace member.`);
  }
  const host = await first<{ id: string }>(
    "SELECT id FROM devices WHERE id = ? AND workspace_id = ?",
    agent.hostDeviceId,
    device.workspaceId,
  );
  if (!host) throw new DeviceJobError(409, `${agent.name}'s host device is no longer paired.`);

  const existing = await first<AgentJobRow>(
    `${JOB_SELECT}
      WHERE j.workspace_id = ? AND j.requested_by_device_id = ?
        AND j.requester_run_id = ?`,
    device.workspaceId,
    device.id,
    requesterRunId,
  );
  if (existing) return { ok: true, job: publicJob(existing), duplicate: true };

  const jobId = id("job");
  const createdAt = now();
  const inputJson = JSON.stringify({
    prompt,
    requestedByUserId: device.ownerUserId,
  });
  await run(
    `INSERT INTO agent_jobs
      (id, workspace_id, agent_id, requested_by_device_id, host_device_id,
       project_id, channel_id, requester_run_id, input_json, status,
       lease_token_hash, lease_expires_at, result_json, error, created_at,
       claimed_at, started_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval',
       NULL, NULL, NULL, '', ?, NULL, NULL, NULL, ?)`,
    jobId,
    device.workspaceId,
    agent.id,
    device.id,
    agent.hostDeviceId,
    text(input.projectId, 180) || null,
    text(input.channelId, 180),
    requesterRunId,
    inputJson,
    createdAt,
    createdAt,
  );
  await recordActivity(
    device.workspaceId,
    device.id,
    "agent.job.approval_requested",
    `Requested approval to run ${agent.name} on its host device`,
    jobId,
  );
  const job = await first<AgentJobRow>(`${JOB_SELECT} WHERE j.id = ?`, jobId);
  if (!job) throw new DeviceJobError(500, "The agent job could not be loaded.");
  return { ok: true, job: publicJob(job) };
}

async function pending(device: AuthorizedDevice) {
  const rows = await all<AgentJobRow>(
    `${JOB_SELECT}
      WHERE j.workspace_id = ? AND j.host_device_id = ?
        AND j.status = 'pending_approval'
      ORDER BY j.created_at
      LIMIT 20`,
    device.workspaceId,
    device.id,
  );
  return { ok: true, jobs: rows.map(publicJob) };
}

async function approve(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const jobId = text(input.jobId, 180);
  const approvedAt = now();
  const result = await run(
    `UPDATE agent_jobs
        SET status = 'queued', updated_at = ?
      WHERE id = ? AND workspace_id = ? AND host_device_id = ?
        AND status = 'pending_approval'`,
    approvedAt,
    jobId,
    device.workspaceId,
    device.id,
  );
  if (!result.meta.changes) {
    throw new DeviceJobError(404, "That approval request is no longer pending.");
  }
  const job = await first<AgentJobRow>(`${JOB_SELECT} WHERE j.id = ?`, jobId);
  if (!job) throw new DeviceJobError(404, "That agent job was not found.");
  await recordActivity(
    device.workspaceId,
    device.id,
    "agent.job.approved",
    `Approved ${job.agentName} to work in ${job.projectName}`,
    job.id,
  );
  return { ok: true, job: publicJob(job) };
}

async function decline(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const jobId = text(input.jobId, 180);
  const declinedAt = now();
  const result = await run(
    `UPDATE agent_jobs
        SET status = 'failed',
            error = 'Declined by the agent owner on the host device',
            finished_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND host_device_id = ?
        AND status = 'pending_approval'`,
    declinedAt,
    declinedAt,
    jobId,
    device.workspaceId,
    device.id,
  );
  if (!result.meta.changes) {
    throw new DeviceJobError(404, "That approval request is no longer pending.");
  }
  const job = await first<AgentJobRow>(`${JOB_SELECT} WHERE j.id = ?`, jobId);
  if (!job) throw new DeviceJobError(404, "That agent job was not found.");
  await recordActivity(
    device.workspaceId,
    device.id,
    "agent.job.declined",
    `Declined ${job.agentName} remote work request`,
    job.id,
  );
  return { ok: true, job: publicJob(job) };
}

async function poll(device: AuthorizedDevice) {
  const timestamp = now();
  await run(
    `UPDATE agent_jobs
        SET status = 'queued', lease_token_hash = NULL, lease_expires_at = NULL,
            claimed_at = NULL, updated_at = ?
      WHERE host_device_id = ? AND workspace_id = ?
        AND status IN ('claimed', 'running') AND lease_expires_at < ?`,
    timestamp,
    device.id,
    device.workspaceId,
    timestamp,
  );
  const candidates = await all<{ id: string }>(
    `SELECT id
       FROM agent_jobs
      WHERE workspace_id = ? AND host_device_id = ? AND status = 'queued'
      ORDER BY created_at
      LIMIT 10`,
    device.workspaceId,
    device.id,
  );
  for (const candidate of candidates) {
    const leaseToken = randomToken(32);
    const leaseTokenHash = await sha256(leaseToken);
    const leaseExpiresAt = future(90);
    const claimedAt = now();
    const result = await run(
      `UPDATE agent_jobs
          SET status = 'claimed', lease_token_hash = ?, lease_expires_at = ?,
              claimed_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND host_device_id = ?
          AND status = 'queued'`,
      leaseTokenHash,
      leaseExpiresAt,
      claimedAt,
      claimedAt,
      candidate.id,
      device.workspaceId,
      device.id,
    );
    if (!result.meta.changes) continue;
    const job = await first<AgentJobRow>(
      `${JOB_SELECT} WHERE j.id = ?`,
      candidate.id,
    );
    if (!job) continue;
    await recordActivity(
      device.workspaceId,
      device.id,
      "agent.job.claimed",
      `${job.agentName} job claimed by its host`,
      job.id,
    );
    return {
      ok: true,
      job: publicJob(job),
      leaseToken,
      leaseExpiresAt,
    };
  }
  return { ok: true, job: null };
}

async function start(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const job = await requireLease(
    device,
    text(input.jobId, 180),
    text(input.leaseToken, 500),
  );
  const startedAt = now();
  await run(
    `UPDATE agent_jobs
        SET status = 'running', started_at = COALESCE(started_at, ?),
            lease_expires_at = ?, updated_at = ?
      WHERE id = ?`,
    startedAt,
    future(90),
    startedAt,
    job.id,
  );
  return { ok: true, jobId: job.id, startedAt };
}

async function heartbeat(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const job = await requireLease(
    device,
    text(input.jobId, 180),
    text(input.leaseToken, 500),
  );
  const updatedAt = now();
  const leaseExpiresAt = future(90);
  await run(
    "UPDATE agent_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?",
    leaseExpiresAt,
    updatedAt,
    job.id,
  );
  return { ok: true, jobId: job.id, leaseExpiresAt };
}

async function finish(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
  status: "completed" | "failed",
) {
  const job = await requireLease(
    device,
    text(input.jobId, 180),
    text(input.leaseToken, 500),
  );
  const finishedAt = now();
  const rawResult =
    input.result && typeof input.result === "object"
      ? (input.result as Record<string, unknown>)
      : {};
  const resultJson =
    status === "completed"
      ? JSON.stringify({
          content: text(rawResult.content, 450_000),
          meta: text(rawResult.meta, 2_000),
          model: text(rawResult.model, 160),
          effort: text(rawResult.effort, 40),
        })
      : null;
  const error =
    status === "failed"
      ? text(input.error, 8_000) || "The host agent process failed."
      : "";
  await run(
    `UPDATE agent_jobs
        SET status = ?, result_json = ?, error = ?, finished_at = ?,
            lease_token_hash = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?`,
    status,
    resultJson,
    error,
    finishedAt,
    finishedAt,
    job.id,
  );
  await recordActivity(
    device.workspaceId,
    device.id,
    `agent.job.${status}`,
    status === "completed"
      ? `${job.agentName} completed a remote run`
      : `${job.agentName} remote run failed`,
    job.id,
  );
  return { ok: true, jobId: job.id, status, finishedAt };
}

async function results(device: AuthorizedDevice) {
  const rows = await all<AgentJobRow>(
    `${JOB_SELECT}
      WHERE j.workspace_id = ? AND j.requested_by_device_id = ?
        AND j.status IN ('completed', 'failed', 'cancelled')
      ORDER BY j.updated_at
      LIMIT 100`,
    device.workspaceId,
    device.id,
  );
  return { ok: true, jobs: rows.map(publicJob) };
}

async function updates(device: AuthorizedDevice) {
  const rows = await all<AgentJobRow>(
    `${JOB_SELECT}
      WHERE j.workspace_id = ? AND j.requested_by_device_id = ?
        AND j.status != 'delivered'
      ORDER BY j.updated_at
      LIMIT 100`,
    device.workspaceId,
    device.id,
  );
  return { ok: true, jobs: rows.map(publicJob) };
}

async function acknowledge(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const jobId = text(input.jobId, 180);
  const result = await run(
    `UPDATE agent_jobs
        SET status = 'delivered', updated_at = ?
      WHERE id = ? AND workspace_id = ? AND requested_by_device_id = ?
        AND status IN ('completed', 'failed', 'cancelled')`,
    now(),
    jobId,
    device.workspaceId,
    device.id,
  );
  if (!result.meta.changes) {
    throw new DeviceJobError(404, "That completed agent job was not found.");
  }
  return { ok: true, jobId };
}

async function cancel(
  device: AuthorizedDevice,
  input: Record<string, unknown>,
) {
  const jobId = text(input.jobId, 180);
  const cancelledAt = now();
  const result = await run(
    `UPDATE agent_jobs
        SET status = 'cancelled', error = 'Cancelled by requester',
            lease_token_hash = NULL, lease_expires_at = NULL,
            finished_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND requested_by_device_id = ?
        AND status IN ('pending_approval', 'queued', 'claimed', 'running')`,
    cancelledAt,
    cancelledAt,
    jobId,
    device.workspaceId,
    device.id,
  );
  if (!result.meta.changes) {
    throw new DeviceJobError(404, "That active agent job was not found.");
  }
  await recordActivity(
    device.workspaceId,
    device.id,
    "agent.job.cancelled",
    "Cancelled a remote agent run",
    jobId,
  );
  return { ok: true, jobId, status: "cancelled" };
}

export async function handleDeviceJob(
  token: string,
  input: Record<string, unknown>,
) {
  if (!token) throw new DeviceJobError(401, "Desktop connection token is required.");
  let device: AuthorizedDevice;
  try {
    device = await authorizeDevice(token);
  } catch {
    throw new DeviceJobError(401, "Desktop connection is not authorized.");
  }
  switch (text(input.action, 40)) {
    case "enqueue":
      return enqueue(device, input);
    case "pending":
      return pending(device);
    case "approve":
      return approve(device, input);
    case "decline":
      return decline(device, input);
    case "poll":
      return poll(device);
    case "start":
      return start(device, input);
    case "heartbeat":
      return heartbeat(device, input);
    case "complete":
      return finish(device, input, "completed");
    case "fail":
      return finish(device, input, "failed");
    case "results":
      return results(device);
    case "updates":
      return updates(device);
    case "acknowledge":
      return acknowledge(device, input);
    case "cancel":
      return cancel(device, input);
    default:
      throw new DeviceJobError(400, "Unknown agent job action.");
  }
}
