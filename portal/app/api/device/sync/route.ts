import { syncDevice } from "../../../../lib/workspace";

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
    if (!token) {
      return Response.json(
        { error: "Desktop connection token is required." },
        { status: 401, headers: cors },
      );
    }
    const input = (await request.json()) as { payload?: unknown };
    return Response.json(await syncDevice(token, input.payload), { headers: cors });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed.";
    return Response.json({ error: message }, { status: 400, headers: cors });
  }
}
