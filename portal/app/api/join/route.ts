import { acceptInvite, inspectInvite } from "../../../lib/workspace";

export const dynamic = "force-dynamic";

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token")?.trim() ?? "";
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Invite unavailable.";
  return Response.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    return Response.json(await inspectInvite(request.headers, tokenFrom(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    return Response.json(await acceptInvite(request.headers, tokenFrom(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
