import {
  finishIntegration,
  integrationErrorResponse,
} from "../../../../../lib/integrations";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider } = await context.params;
    return await finishIntegration(request, provider);
  } catch (error) {
    return integrationErrorResponse(request, error);
  }
}
