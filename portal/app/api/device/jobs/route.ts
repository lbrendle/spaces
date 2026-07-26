import {
  DeviceJobError,
  handleDeviceJob,
} from "../../../../lib/device-jobs";

export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    const input = (await request.json()) as Record<string, unknown>;
    const result = await handleDeviceJob(token, input);
    return Response.json(result, { headers: cors });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The agent job request failed.";
    const status = error instanceof DeviceJobError ? error.status : 500;
    return Response.json({ error: message }, { status, headers: cors });
  }
}
