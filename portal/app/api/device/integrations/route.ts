import { runDeviceProviderAction } from "../../../../lib/provider-actions";
import { authorizeDevice } from "../../../../lib/workspace";

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
    const token = (request.headers.get("authorization") ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token) {
      return Response.json(
        { error: "Desktop connection token is required." },
        { status: 401, headers: cors },
      );
    }
    const input = (await request.json()) as Record<string, unknown>;
    const device = await authorizeDevice(token);
    return Response.json(await runDeviceProviderAction(device, input), {
      headers: cors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider action failed.";
    return Response.json({ error: message }, { status: 400, headers: cors });
  }
}
