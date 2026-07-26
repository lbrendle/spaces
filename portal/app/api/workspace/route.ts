import { loadWorkspaceUpdate, mutateWorkspace } from "../../../lib/workspace";
import { AuthError } from "../../../lib/auth";

export const dynamic = "force-dynamic";

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Spaces could not complete that action.";
  const status =
    error instanceof AuthError
      ? error.status
      : /sign in/i.test(message)
        ? 401
        : 400;
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const rawSince = url.searchParams.get("since");
    const parsedSince =
      rawSince !== null && /^\d+$/.test(rawSince) ? Number(rawSince) : null;
    const snapshot = await loadWorkspaceUpdate(
      request.headers,
      url.searchParams.get("workspace") ?? "",
      parsedSince,
    );
    return Response.json(snapshot, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as Record<string, unknown>;
    const result = await mutateWorkspace(request.headers, input);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
