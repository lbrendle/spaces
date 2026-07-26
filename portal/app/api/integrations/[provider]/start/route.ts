import {
  integrationErrorResponse,
  startIntegration,
} from "../../../../../lib/integrations";
import { loadWorkspaceSnapshot } from "../../../../../lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await context.params;
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspace") ?? "";
    const projectId = url.searchParams.get("project") ?? "";
    const snapshot = await loadWorkspaceSnapshot(request.headers, workspaceId);
    if (projectId && !snapshot.projects.some((project) => project.id === projectId)) {
      throw new Error("That project is not available in this workspace.");
    }
    return await startIntegration(request, provider, {
      id: snapshot.workspace.id,
      role: snapshot.workspace.role,
      currentUserId: snapshot.currentUser.id,
      projectId,
    });
  } catch (error) {
    return integrationErrorResponse(request, error);
  }
}
