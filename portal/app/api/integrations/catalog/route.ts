import { integrationCatalog } from "../../../../lib/integrations";
import { loadWorkspaceSnapshot } from "../../../../lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspace") ?? "";
    const snapshot = await loadWorkspaceSnapshot(request.headers, workspaceId);
    return Response.json({ providers: integrationCatalog(snapshot.workspace.role) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
