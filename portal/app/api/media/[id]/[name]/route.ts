import {
  MediaError,
  serveMedia,
} from "../../../../../lib/media";

export const dynamic = "force-dynamic";

function mediaError(error: unknown) {
  const status = error instanceof MediaError ? error.status : 500;
  const message =
    error instanceof Error ? error.message : "Spaces could not load that media.";
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id } = await context.params;
    return await serveMedia(request, id);
  } catch (error) {
    return mediaError(error);
  }
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ id: string; name: string }> },
) {
  try {
    const { id } = await context.params;
    return await serveMedia(request, id, true);
  } catch (error) {
    const response = mediaError(error);
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  }
}
