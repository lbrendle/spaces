import { getD1 } from "../../../../db";
import { authorizeDevice } from "../../../../lib/workspace";

export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function token(request: Request): string {
  return (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function now(): string {
  return new Date().toISOString();
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

export async function GET(request: Request) {
  try {
    const deviceToken = token(request);
    if (!deviceToken) throw new Error("Desktop connection token is required.");
    const device = await authorizeDevice(deviceToken);
    const retryBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    await getD1()
      .prepare(
        `UPDATE calendar_commands
            SET status = 'queued', updated_at = ?
          WHERE workspace_id = ? AND device_id = ? AND status = 'processing'
            AND updated_at < ?`,
      )
      .bind(now(), device.workspaceId, device.id, retryBefore)
      .run();
    const result = await getD1()
      .prepare(
        `SELECT id, event_id AS eventId, calendar_name AS calendarName,
                payload_json AS payloadJson
           FROM calendar_commands
          WHERE workspace_id = ? AND device_id = ? AND status = 'queued'
          ORDER BY created_at
          LIMIT 10`,
      )
      .bind(device.workspaceId, device.id)
      .all<{
        id: string;
        eventId: string;
        calendarName: string;
        payloadJson: string;
      }>();
    const commands = (result.results ?? []).map(({ payloadJson, ...command }) => ({
      ...command,
      payload: JSON.parse(payloadJson) as Record<string, unknown>,
    }));
    for (const command of commands) {
      await getD1()
        .prepare(
          `UPDATE calendar_commands
              SET status = 'processing', updated_at = ?
            WHERE id = ? AND workspace_id = ? AND device_id = ? AND status = 'queued'`,
        )
        .bind(now(), command.id, device.workspaceId, device.id)
        .run();
    }
    return Response.json({ ok: true, commands }, { headers: cors });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar delivery failed.";
    return Response.json({ error: message }, { status: 400, headers: cors });
  }
}

export async function POST(request: Request) {
  try {
    const deviceToken = token(request);
    if (!deviceToken) throw new Error("Desktop connection token is required.");
    const device = await authorizeDevice(deviceToken);
    const input = (await request.json()) as Record<string, unknown>;
    const commandId = String(input.commandId ?? "").trim();
    if (!commandId) throw new Error("Calendar command id is required.");
    const command = await getD1()
      .prepare(
        `SELECT id, event_id AS eventId
           FROM calendar_commands
          WHERE id = ? AND workspace_id = ? AND device_id = ?`,
      )
      .bind(commandId, device.workspaceId, device.id)
      .first<{ id: string; eventId: string }>();
    if (!command) throw new Error("Calendar command not found.");
    const error = String(input.error ?? "").trim().slice(0, 2_000);
    const updatedAt = now();
    if (error) {
      await getD1()
        .prepare(
          `UPDATE calendar_commands
              SET status = 'error', error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(error, updatedAt, commandId)
        .run();
      return Response.json({ ok: true, state: "error" }, { headers: cors });
    }
    const externalId = String(input.externalId ?? "").trim().slice(0, 2_000);
    if (!externalId) throw new Error("Apple Calendar did not return an event id.");
    await getD1().batch([
      getD1()
        .prepare(
          `UPDATE calendar_commands
              SET status = 'completed', error = '', updated_at = ?
            WHERE id = ?`,
        )
        .bind(updatedAt, commandId),
      getD1()
        .prepare(
          `UPDATE shared_calendar_events
              SET external_id = ?, source = 'apple', updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .bind(externalId, updatedAt, command.eventId, device.workspaceId),
      getD1()
        .prepare(
          `INSERT INTO workspace_events
            (workspace_id, actor_id, kind, entity_id, created_at)
           VALUES (?, ?, 'calendar.event_delivered', ?, ?)`,
        )
        .bind(device.workspaceId, device.id, command.eventId, updatedAt),
    ]);
    const revision = await getD1()
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS revision
           FROM workspace_events
          WHERE workspace_id = ?`,
      )
      .bind(device.workspaceId)
      .first<{ revision: number }>();
    await getD1()
      .prepare(
        "UPDATE shared_calendar_events SET revision = ? WHERE id = ? AND workspace_id = ?",
      )
      .bind(Number(revision?.revision ?? 0), command.eventId, device.workspaceId)
      .run();
    return Response.json({ ok: true, state: "completed" }, { headers: cors });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Calendar delivery failed.";
    return Response.json({ error: message }, { status: 400, headers: cors });
  }
}
