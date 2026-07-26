import { loadPortalConnection } from "./portal";
import { getDb } from "./db";

export type RemoteJobStatus =
  | "pending_approval"
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "delivered";

export interface RemoteAgentJob {
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
  input: {
    prompt?: string;
    requestedByUserId?: string;
  };
  status: RemoteJobStatus;
  result: Record<string, unknown> | null;
  error: string;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

interface JobResponse {
  ok?: boolean;
  job?: RemoteAgentJob | null;
  jobs?: RemoteAgentJob[];
  leaseToken?: string;
  leaseExpiresAt?: string;
  error?: string;
}

async function action(input: Record<string, unknown>): Promise<JobResponse> {
  const connection = await loadPortalConnection();
  if (!connection) throw new Error("Pair this Spaces desktop first.");
  const response = await fetch(`${connection.base_url}/api/device/jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as JobResponse;
  if (!response.ok || !body.ok) {
    throw new Error(body.error || "The remote agent request failed.");
  }
  return body;
}

export async function enqueueRemoteJob(input: {
  agentId: string;
  projectId?: string;
  channelId: string;
  requesterRunId: string;
  prompt: string;
}): Promise<RemoteAgentJob> {
  const response = await action({ action: "enqueue", ...input });
  if (!response.job) throw new Error("Spaces did not return the queued agent job.");
  return response.job;
}

export async function portalIdForLocal(
  entity: "project" | "channel" | "agent",
  localId: string,
): Promise<string> {
  if (!localId) return "";
  const db = await getDb();
  const rows = await db.select<{ remote_id: string }[]>(
    "SELECT remote_id FROM portal_links WHERE entity = $1 AND local_id = $2 LIMIT 1",
    [entity, localId]
  );
  return rows[0]?.remote_id ?? "";
}

export async function localIdForPortal(
  entity: "project" | "channel" | "agent",
  remoteId: string,
): Promise<string> {
  if (!remoteId) return "";
  const db = await getDb();
  const rows = await db.select<{ local_id: string }[]>(
    "SELECT local_id FROM portal_links WHERE entity = $1 AND remote_id = $2 LIMIT 1",
    [entity, remoteId]
  );
  return rows[0]?.local_id ?? "";
}

export async function pollRemoteJob(): Promise<{
  job: RemoteAgentJob;
  leaseToken: string;
} | null> {
  const response = await action({ action: "poll" });
  if (!response.job) return null;
  if (!response.leaseToken) throw new Error("The claimed job did not include a lease.");
  return { job: response.job, leaseToken: response.leaseToken };
}

export async function pendingRemoteJobs(): Promise<RemoteAgentJob[]> {
  return (await action({ action: "pending" })).jobs ?? [];
}

export async function approveRemoteJob(jobId: string) {
  await action({ action: "approve", jobId });
}

export async function declineRemoteJob(jobId: string) {
  await action({ action: "decline", jobId });
}

export async function startRemoteJob(jobId: string, leaseToken: string) {
  await action({ action: "start", jobId, leaseToken });
}

export async function heartbeatRemoteJob(jobId: string, leaseToken: string) {
  await action({ action: "heartbeat", jobId, leaseToken });
}

export async function completeRemoteJob(
  jobId: string,
  leaseToken: string,
  result: Record<string, unknown>,
) {
  await action({ action: "complete", jobId, leaseToken, result });
}

export async function failRemoteJob(
  jobId: string,
  leaseToken: string,
  error: string,
) {
  await action({ action: "fail", jobId, leaseToken, error });
}

export async function cancelRemoteJob(jobId: string) {
  await action({ action: "cancel", jobId });
}

export async function completedRemoteJobs(): Promise<RemoteAgentJob[]> {
  return (await action({ action: "results" })).jobs ?? [];
}

export async function remoteJobUpdates(): Promise<RemoteAgentJob[]> {
  return (await action({ action: "updates" })).jobs ?? [];
}

export async function acknowledgeRemoteJob(jobId: string) {
  await action({ action: "acknowledge", jobId });
}
