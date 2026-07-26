import { claimDevice } from "../../../../lib/workspace";

export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as { code?: string; name?: string };
    const result = await claimDevice(input.code ?? "", input.name ?? "");
    return Response.json(result, { status: 201, headers: cors });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pairing failed.";
    return Response.json({ error: message }, { status: 400, headers: cors });
  }
}
