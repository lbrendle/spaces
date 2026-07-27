import {
  MediaError,
  uploadDeviceMedia,
} from "../../../../lib/media";

export const dynamic = "force-dynamic";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-length, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

export async function POST(request: Request) {
  try {
    return Response.json(await uploadDeviceMedia(request), {
      status: 201,
      headers: cors,
    });
  } catch (error) {
    const status = error instanceof MediaError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Spaces could not upload that media.";
    return Response.json({ error: message }, { status, headers: cors });
  }
}
