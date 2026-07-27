import { env } from "cloudflare:workers";
import { getD1 } from "../db";
import { authorizeDevice } from "./workspace";

const MAX_MEDIA_BYTES = 95 * 1024 * 1024;

const MEDIA_EXTENSIONS: Record<string, readonly string[]> = {
  "image/avif": [".avif"],
  "image/gif": [".gif"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
  "video/x-m4v": [".m4v"],
};

interface AuthorizedDevice {
  id: string;
  workspaceId: string;
  ownerUserId: string;
}

interface MediaRow {
  id: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
}

export class MediaError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MediaError";
    this.status = status;
  }
}

function bucket(): R2Bucket {
  const binding = (env as { MEDIA?: R2Bucket }).MEDIA;
  if (!binding) {
    throw new MediaError(
      503,
      "Workspace media storage is unavailable. Set the `r2` field in .openai/hosting.json to `MEDIA`.",
    );
  }
  return binding;
}

function safeFileName(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = [...leaf]
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? "-"
        : character,
    )
    .join("")
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 140);
  return cleaned || "media";
}

function extension(value: string): string {
  const match = /\.[a-zA-Z0-9]+$/.exec(value);
  return match?.[0].toLowerCase() ?? "";
}

function contentType(request: Request, fileName: string): string {
  const raw = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const extensions = MEDIA_EXTENSIONS[raw];
  if (!extensions) {
    throw new MediaError(
      415,
      "Upload a PNG, JPEG, WebP, GIF, AVIF, MP4, MOV, M4V, or WebM file.",
    );
  }
  if (!extensions.includes(extension(fileName))) {
    throw new MediaError(
      415,
      `The ${fileName} extension does not match its ${raw} content type.`,
    );
  }
  return raw;
}

function contentLength(request: Request): number {
  const raw = request.headers.get("content-length") ?? "";
  if (!/^\d+$/.test(raw)) {
    throw new MediaError(411, "The upload must include its Content-Length.");
  }
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new MediaError(400, "The media file is empty.");
  }
  if (bytes > MAX_MEDIA_BYTES) {
    throw new MediaError(413, "Media uploads are limited to 95 MB.");
  }
  return bytes;
}

async function resolveProjectId(
  device: AuthorizedDevice,
  requestedProjectId: string,
): Promise<string | null> {
  if (!requestedProjectId) return null;
  const row = await getD1()
    .prepare(
      `SELECT p.id
         FROM projects p
        WHERE p.workspace_id = ?
          AND (
            p.id = ?
            OR EXISTS (
              SELECT 1
                FROM project_sources s
               WHERE s.workspace_id = p.workspace_id
                 AND s.project_id = p.id
                 AND s.device_id = ?
                 AND s.source_project_id = ?
            )
          )
        LIMIT 1`,
    )
    .bind(
      device.workspaceId,
      requestedProjectId,
      device.id,
      requestedProjectId,
    )
    .first<{ id: string }>();
  if (!row) {
    throw new MediaError(404, "That project is not available in this workspace.");
  }
  return row.id;
}

export async function uploadDeviceMedia(request: Request) {
  const rawToken = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!rawToken) {
    throw new MediaError(401, "Desktop connection token is required.");
  }
  let device: AuthorizedDevice;
  try {
    device = await authorizeDevice(rawToken);
  } catch (error) {
    throw new MediaError(
      401,
      error instanceof Error ? error.message : "Desktop connection is not authorized.",
    );
  }
  if (!request.body) throw new MediaError(400, "The media file is empty.");

  const url = new URL(request.url);
  const fileName = safeFileName(url.searchParams.get("filename") ?? "media");
  const type = contentType(request, fileName);
  const bytes = contentLength(request);
  const projectId = await resolveProjectId(
    device,
    (url.searchParams.get("projectId") ?? "").trim().slice(0, 180),
  );
  const mediaId = `media_${crypto.randomUUID()}`;
  const objectKey = `${device.workspaceId}/${mediaId}/${fileName}`;
  const createdAt = new Date().toISOString();
  const storage = bucket();

  const object = await storage.put(objectKey, request.body, {
    httpMetadata: {
      contentType: type,
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: `inline; filename="${fileName.replace(/"/g, "")}"`,
    },
    customMetadata: {
      workspaceId: device.workspaceId,
      mediaId,
      projectId: projectId ?? "",
      uploadedByDeviceId: device.id,
    },
  });

  try {
    await getD1()
      .prepare(
        `INSERT INTO media_assets
          (id, workspace_id, project_id, object_key, file_name, content_type,
           byte_size, etag, created_by_user_id, created_by_device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        mediaId,
        device.workspaceId,
        projectId,
        objectKey,
        fileName,
        type,
        bytes,
        object.etag,
        device.ownerUserId,
        device.id,
        createdAt,
      )
      .run();
  } catch (error) {
    await storage.delete(objectKey);
    throw error;
  }

  const publicUrl = new URL(
    `/api/media/${encodeURIComponent(mediaId)}/${encodeURIComponent(fileName)}`,
    request.url,
  ).toString();
  return {
    ok: true as const,
    media: {
      id: mediaId,
      projectId: projectId ?? "",
      fileName,
      contentType: type,
      size: bytes,
      etag: object.etag,
      url: publicUrl,
    },
  };
}

async function mediaRow(mediaId: string): Promise<MediaRow | null> {
  return getD1()
    .prepare(
      `SELECT id, object_key AS objectKey, file_name AS fileName,
              content_type AS contentType, byte_size AS byteSize
         FROM media_assets
        WHERE id = ?
        LIMIT 1`,
    )
    .bind(mediaId)
    .first<MediaRow>();
}

function deliveryHeaders(row: MediaRow): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename="${row.fileName.replace(/"/g, "")}"`,
    "Content-Type": row.contentType,
    "X-Content-Type-Options": "nosniff",
  });
}

export async function serveMedia(
  request: Request,
  mediaId: string,
  headOnly = false,
): Promise<Response> {
  if (!/^media_[a-f0-9-]{36}$/i.test(mediaId)) {
    throw new MediaError(404, "Media not found.");
  }
  const row = await mediaRow(mediaId);
  if (!row) throw new MediaError(404, "Media not found.");

  const storage = bucket();
  const headers = deliveryHeaders(row);
  if (headOnly) {
    const object = await storage.head(row.objectKey);
    if (!object) throw new MediaError(404, "Media not found.");
    object.writeHttpMetadata(headers);
    headers.set("Content-Length", String(object.size));
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    return new Response(null, { headers });
  }

  const range = request.headers.get("range");
  let object: R2ObjectBody | null;
  try {
    object = await storage.get(
      row.objectKey,
      range ? { range: request.headers } : undefined,
    );
  } catch {
    throw new MediaError(416, "The requested media range is not available.");
  }
  if (!object) throw new MediaError(404, "Media not found.");
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");

  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Length", String(length));
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
