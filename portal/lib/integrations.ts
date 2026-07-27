import { env } from "cloudflare:workers";
import { getD1 } from "../db";
import {
  canConnectProvider,
  connectionAudience,
} from "./connection-policy";

export type ProviderId =
  | "github"
  | "google"
  | "microsoft"
  | "x"
  | "tiktok"
  | "meta";

interface Provider {
  id: ProviderId;
  label: string;
  clientIdKey: string;
  clientSecretKey: string;
  authorizeUrl: (runtime: Runtime) => string;
  tokenUrl: (runtime: Runtime) => string;
  scopes: string[];
  authorizeParams?: (runtime: Runtime) => Record<string, string>;
}

type Runtime = Record<string, string | undefined>;

const PROVIDERS: Record<ProviderId, Provider> = {
  github: {
    id: "github",
    label: "GitHub",
    clientIdKey: "GITHUB_CLIENT_ID",
    clientSecretKey: "GITHUB_CLIENT_SECRET",
    authorizeUrl: () => "https://github.com/login/oauth/authorize",
    tokenUrl: () => "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "user:email", "repo", "read:org"],
  },
  google: {
    id: "google",
    label: "Google Workspace",
    clientIdKey: "GOOGLE_CLIENT_ID",
    clientSecretKey: "GOOGLE_CLIENT_SECRET",
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/youtube.upload",
    ],
    authorizeParams: () => ({
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    }),
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft 365",
    clientIdKey: "MICROSOFT_CLIENT_ID",
    clientSecretKey: "MICROSOFT_CLIENT_SECRET",
    authorizeUrl: () =>
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: () =>
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
    ],
  },
  x: {
    id: "x",
    label: "X",
    clientIdKey: "X_CLIENT_ID",
    clientSecretKey: "X_CLIENT_SECRET",
    authorizeUrl: () => "https://x.com/i/oauth2/authorize",
    tokenUrl: () => "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    clientIdKey: "TIKTOK_CLIENT_KEY",
    clientSecretKey: "TIKTOK_CLIENT_SECRET",
    authorizeUrl: () => "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: () => "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.upload", "video.publish"],
  },
  meta: {
    id: "meta",
    label: "Instagram",
    clientIdKey: "META_APP_ID",
    clientSecretKey: "META_APP_SECRET",
    authorizeUrl: () => "https://www.instagram.com/oauth/authorize",
    tokenUrl: () => "https://api.instagram.com/oauth/access_token",
    scopes: [
      "instagram_business_basic",
      "instagram_business_content_publish",
    ],
  },
};

function runtime(): Runtime {
  return env as unknown as Runtime;
}

function required(values: Runtime, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is not configured.`);
  return value;
}

function provider(value: string): Provider {
  const found = PROVIDERS[value as ProviderId];
  if (!found) throw new Error("Unknown integration provider.");
  return found;
}

function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(raw);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new Uint8Array(
    Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function encryptTokens(tokens: unknown): Promise<string> {
  const values = runtime();
  const material = required(values, "INTEGRATION_TOKEN_KEY");
  const key = await crypto.subtle.importKey(
    "raw",
    await sha256(material),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(tokens)),
    ),
  );
  return `${base64Url(iv)}.${base64Url(ciphertext)}`;
}

async function decryptTokens(value: string): Promise<Record<string, unknown>> {
  const [encodedIv, encodedCiphertext] = value.split(".");
  if (!encodedIv || !encodedCiphertext) {
    throw new Error("The connected account secret is malformed.");
  }
  const material = required(runtime(), "INTEGRATION_TOKEN_KEY");
  const key = await crypto.subtle.importKey(
    "raw",
    await sha256(material),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(encodedIv) },
    key,
    fromBase64Url(encodedCiphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

function callbackUrl(request: Request, providerId: string): string {
  return new URL(`/api/integrations/${providerId}/callback`, request.url).toString();
}

function configured(config: Provider, values: Runtime): {
  clientId: string;
  clientSecret: string;
} {
  required(values, "INTEGRATION_TOKEN_KEY");
  return {
    clientId: required(values, config.clientIdKey),
    clientSecret: required(values, config.clientSecretKey),
  };
}

export function integrationCatalog(role: string) {
  const values = runtime();
  return Object.values(PROVIDERS).map((config) => {
    let ready = true;
    let reason = "";
    try {
      configured(config, values);
      config.authorizeUrl(values);
      config.tokenUrl(values);
    } catch (error) {
      ready = false;
      reason = error instanceof Error ? error.message : String(error);
    }
    return {
      id: config.id,
      label: config.label,
      ready,
      reason,
      scopes: config.scopes,
      audience: connectionAudience(config.id),
      canConnect: canConnectProvider(config.id, role),
    };
  });
}

export async function startIntegration(
  request: Request,
  providerId: string,
  workspace: {
    id: string;
    role: string;
    currentUserId: string;
    projectId?: string;
  },
): Promise<Response> {
  const config = provider(providerId);
  const values = runtime();
  const credentials = configured(config, values);
  if (!canConnectProvider(config.id, workspace.role)) {
    throw new Error(
      connectionAudience(config.id) === "workspace"
        ? "Only workspace owners and admins can connect shared social accounts."
        : "Guests cannot connect personal mail or calendar accounts.",
    );
  }

  const state = randomToken(28);
  const verifier = config.id === "x" ? randomToken(40) : "";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await getD1()
    .prepare(
      `INSERT INTO oauth_states
       (id, workspace_id, user_id, provider, project_id, code_verifier,
        scopes_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      state,
      workspace.id,
      workspace.currentUserId,
      config.id,
      workspace.projectId ?? "",
      verifier,
      JSON.stringify(config.scopes),
      expiresAt,
      now.toISOString(),
    )
    .run();

  const redirectUri = callbackUrl(request, config.id);
  const url = new URL(config.authorizeUrl(values));
  const params: Record<string, string> = {
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope:
      config.id === "tiktok" || config.id === "meta"
        ? config.scopes.join(",")
        : config.scopes.join(" "),
    ...(config.authorizeParams?.(values) ?? {}),
  };
  // Instagram Login treats forced reauthentication as a request for the
  // password screen, even when the intended professional account is already
  // active in Instagram. Reuse that active session so people can switch
  // accounts in Instagram first and then add each account to Spaces without
  // re-entering a password.
  if (config.id === "tiktok") params.client_key = credentials.clientId;
  else params.client_id = credentials.clientId;
  if (config.id === "x") {
    params.code_challenge = base64Url(await sha256(verifier));
    params.code_challenge_method = "S256";
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
}

interface OAuthState {
  id: string;
  workspaceId: string;
  userId: string;
  provider: ProviderId;
  projectId: string;
  codeVerifier: string;
  scopesJson: string;
  expiresAt: string;
}

async function takeState(id: string): Promise<OAuthState> {
  const row = await getD1()
    .prepare(
      `SELECT id, workspace_id AS workspaceId, user_id AS userId, provider,
              project_id AS projectId, code_verifier AS codeVerifier,
              scopes_json AS scopesJson,
              expires_at AS expiresAt
       FROM oauth_states WHERE id = ?`,
    )
    .bind(id)
    .first<OAuthState>();
  await getD1().prepare("DELETE FROM oauth_states WHERE id = ?").bind(id).run();
  if (!row || row.expiresAt <= new Date().toISOString()) {
    throw new Error("This connection request expired. Start it again from Spaces.");
  }
  return row;
}

async function exchangeCode(
  config: Provider,
  credentials: { clientId: string; clientSecret: string },
  request: Request,
  state: OAuthState,
  code: string,
): Promise<Record<string, unknown>> {
  const values = runtime();
  const body = new URLSearchParams({
    code,
    redirect_uri: callbackUrl(request, config.id),
  });
  if (config.id !== "github") body.set("grant_type", "authorization_code");
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.id === "tiktok") {
    body.set("client_key", credentials.clientId);
    body.set("client_secret", credentials.clientSecret);
  } else if (config.id === "x") {
    body.set("code_verifier", state.codeVerifier);
    headers.authorization = `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`;
  } else {
    body.set("client_id", credentials.clientId);
    body.set("client_secret", credentials.clientSecret);
    if (config.id === "microsoft") body.set("scope", config.scopes.join(" "));
  }
  const response = await fetch(config.tokenUrl(values), {
    method: "POST",
    headers,
    body,
  });
  const raw = (await response.json()) as Record<string, unknown>;
  const tokens =
    config.id === "meta" && Array.isArray(raw.data) && raw.data[0]
      ? { ...raw, ...(raw.data[0] as Record<string, unknown>) }
      : raw;
  if (!response.ok || typeof tokens.access_token !== "string") {
    throw new Error(
      typeof tokens.error_description === "string"
        ? tokens.error_description
        : typeof tokens.error === "string"
          ? tokens.error
          : `${config.label} rejected the token exchange.`,
    );
  }
  if (config.id === "meta") {
    const exchange = new URL("https://graph.instagram.com/access_token");
    exchange.searchParams.set("grant_type", "ig_exchange_token");
    exchange.searchParams.set("client_secret", credentials.clientSecret);
    exchange.searchParams.set("access_token", String(tokens.access_token));
    const longLivedResponse = await fetch(exchange, {
      headers: { accept: "application/json" },
    });
    const longLived = (await longLivedResponse.json()) as Record<string, unknown>;
    if (!longLivedResponse.ok || typeof longLived.access_token !== "string") {
      throw new Error(
        typeof longLived.error_description === "string"
          ? longLived.error_description
          : typeof longLived.error === "string"
            ? longLived.error
            : "Instagram could not issue long-lived account access.",
      );
    }
    return { ...tokens, ...longLived };
  }
  return tokens;
}

async function accountIdentity(
  providerId: ProviderId,
  accessToken: string,
): Promise<{ id: string; label: string }> {
  let url: string;
  if (providerId === "github") {
    url = "https://api.github.com/user";
  } else if (providerId === "google") {
    url = "https://openidconnect.googleapis.com/v1/userinfo";
  } else if (providerId === "microsoft") {
    url = "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
  } else if (providerId === "x") {
    url = "https://api.x.com/2/users/me?user.fields=username,name";
  } else if (providerId === "tiktok") {
    url = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name";
  } else {
    const version = required(runtime(), "META_GRAPH_VERSION");
    url = `https://graph.instagram.com/${version}/me?fields=user_id,username`;
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(providerId === "github"
        ? {
            "user-agent": "Spaces",
            "x-github-api-version": "2022-11-28",
          }
        : {}),
    },
  });
  const raw = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error("Connected, but the provider account could not be identified.");
  const data =
    providerId === "x" && raw.data && typeof raw.data === "object"
      ? (raw.data as Record<string, unknown>)
      : providerId === "tiktok" &&
          raw.data &&
          typeof raw.data === "object" &&
          (raw.data as Record<string, unknown>).user &&
          typeof (raw.data as Record<string, unknown>).user === "object"
        ? ((raw.data as Record<string, unknown>).user as Record<string, unknown>)
        : providerId === "meta" && Array.isArray(raw.data) && raw.data[0]
          ? (raw.data[0] as Record<string, unknown>)
        : raw;
  const id = String(
    data.id ?? data.user_id ?? data.sub ?? data.open_id ?? data.union_id ?? "",
  );
  const label = String(
    data.email ??
      data.userPrincipalName ??
      data.login ??
      data.username ??
      data.display_name ??
      data.displayName ??
      data.name ??
      id,
  );
  if (!id && !label) throw new Error("The provider did not return an account identity.");
  return { id: id || label, label };
}

export async function finishIntegration(
  request: Request,
  providerId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const stateId = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  if (denied) throw new Error(`Connection was not authorized: ${denied}`);
  if (!stateId || !code) throw new Error("The provider callback is missing its state or code.");

  const state = await takeState(stateId);
  if (state.provider !== providerId) throw new Error("The provider callback did not match its request.");
  const config = provider(providerId);
  const credentials = configured(config, runtime());
  const tokens = await exchangeCode(config, credentials, request, state, code);
  const identity = await accountIdentity(config.id, String(tokens.access_token));
  const stamp = new Date().toISOString();
  const scopes = (() => {
    try {
      return JSON.parse(state.scopesJson) as string[];
    } catch {
      return config.scopes;
    }
  })();
  const existingRows = await getD1()
    .prepare(
      `SELECT id, created_by AS createdBy, metadata_json AS metadataJson
         FROM connections
        WHERE workspace_id = ? AND kind = ?`,
    )
    .bind(state.workspaceId, config.id)
    .all<{ id: string; createdBy: string; metadataJson: string }>();
  const existing = (existingRows.results ?? []).find((row) => {
    if (
      connectionAudience(config.id) === "personal" &&
      row.createdBy !== state.userId
    ) {
      return false;
    }
    try {
      const metadata = JSON.parse(row.metadataJson) as { accountId?: string };
      return metadata.accountId === identity.id;
    } catch {
      return false;
    }
  });
  const connectionId = existing?.id ?? `conn_${crypto.randomUUID()}`;
  const encrypted = await encryptTokens({
    provider: config.id,
    accountId: identity.id,
    obtainedAt: stamp,
    ...tokens,
  });
  await getD1().batch([
    getD1()
      .prepare(
        `INSERT INTO connections
         (id, workspace_id, kind, label, status, account_label, scopes_json,
          metadata_json, last_sync_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label=excluded.label,
           status='connected',
           account_label=excluded.account_label,
           scopes_json=excluded.scopes_json,
           metadata_json=excluded.metadata_json,
           updated_at=excluded.updated_at`,
      )
      .bind(
        connectionId,
        state.workspaceId,
        config.id,
        config.label,
        identity.label,
        JSON.stringify(scopes),
        JSON.stringify({ accountId: identity.id }),
        state.userId,
        stamp,
        stamp,
      ),
    getD1()
      .prepare(
        `INSERT INTO connection_secrets
         (connection_id, encrypted_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id) DO UPDATE SET
           encrypted_json=excluded.encrypted_json,
           updated_at=excluded.updated_at`,
      )
      .bind(connectionId, encrypted, stamp, stamp),
    getD1()
      .prepare(
        `INSERT INTO workspace_events
          (workspace_id, actor_id, kind, entity_id, created_at)
         VALUES (?, ?, 'connection.connected', ?, ?)`,
      )
      .bind(state.workspaceId, state.userId, connectionId, stamp),
  ]);
  if (state.projectId && connectionAudience(config.id) === "workspace") {
    const project = await getD1()
      .prepare(
        "SELECT id FROM projects WHERE id = ? AND workspace_id = ?",
      )
      .bind(state.projectId, state.workspaceId)
      .first<{ id: string }>();
    if (project) {
      const existingDefault = await getD1()
        .prepare(
          `SELECT pc.connection_id AS connectionId
             FROM project_connections pc
             JOIN connections c ON c.id = pc.connection_id
            WHERE pc.workspace_id = ? AND pc.project_id = ?
              AND c.kind = ? AND pc.is_default = 1
            LIMIT 1`,
        )
        .bind(state.workspaceId, project.id, config.id)
        .first<{ connectionId: string }>();
      await getD1()
        .prepare(
          `INSERT INTO project_connections
            (workspace_id, project_id, connection_id, is_default,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, connection_id) DO UPDATE SET
             updated_at=excluded.updated_at`,
        )
        .bind(
          state.workspaceId,
          project.id,
          connectionId,
          existingDefault ? 0 : 1,
          state.userId,
          stamp,
          stamp,
        )
        .run();
    }
  }
  const destination = new URL("/", request.url);
  destination.searchParams.set("workspace", state.workspaceId);
  destination.searchParams.set("surface", "connections");
  destination.searchParams.set("connected", config.id);
  return Response.redirect(destination.toString(), 302);
}

interface ConnectedAccountRow {
  id: string;
  kind: ProviderId;
  accountLabel: string;
  metadataJson: string;
  encryptedJson: string;
}

export interface ConnectedAccountAccess {
  connectionId: string;
  provider: ProviderId;
  accountLabel: string;
  accountId: string;
  accessToken: string;
}

async function refreshTokens(
  config: Provider,
  tokens: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (config.id === "meta") {
    const accessToken = String(tokens.access_token ?? "");
    if (!accessToken) {
      throw new Error("Instagram needs to be reconnected before it can sync.");
    }
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const refreshed = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof refreshed.access_token !== "string") {
      throw new Error(
        typeof refreshed.error_description === "string"
          ? refreshed.error_description
          : typeof refreshed.error === "string"
            ? refreshed.error
            : "Instagram account access could not be refreshed.",
      );
    }
    return {
      ...tokens,
      ...refreshed,
      obtainedAt: new Date().toISOString(),
    };
  }

  const refreshToken = String(tokens.refresh_token ?? "");
  if (config.id === "github" && typeof tokens.access_token === "string") {
    return tokens;
  }
  if (!refreshToken) {
    throw new Error(`${config.label} needs to be reconnected before it can sync.`);
  }

  const values = runtime();
  const credentials = configured(config, values);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.id === "tiktok") {
    body.set("client_key", credentials.clientId);
    body.set("client_secret", credentials.clientSecret);
  } else if (config.id === "x") {
    headers.authorization = `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`;
  } else {
    body.set("client_id", credentials.clientId);
    body.set("client_secret", credentials.clientSecret);
    if (config.id === "microsoft") body.set("scope", config.scopes.join(" "));
  }

  const response = await fetch(config.tokenUrl(values), {
    method: "POST",
    headers,
    body,
  });
  const refreshed = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof refreshed.access_token !== "string") {
    throw new Error(
      typeof refreshed.error_description === "string"
        ? refreshed.error_description
        : typeof refreshed.error === "string"
          ? refreshed.error
          : `${config.label} could not refresh its account access.`,
    );
  }
  return {
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    obtainedAt: new Date().toISOString(),
  };
}

function accessTokenStillValid(tokens: Record<string, unknown>): boolean {
  const obtainedAt = Date.parse(String(tokens.obtainedAt ?? ""));
  const expiresIn = Number(tokens.expires_in);
  if (!Number.isFinite(obtainedAt) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return typeof tokens.access_token === "string" && tokens.access_token.length > 0;
  }
  return Date.now() < obtainedAt + expiresIn * 1_000 - 120_000;
}

export async function connectedAccountAccess(
  workspaceId: string,
  providerId: string,
  actorUserId: string,
  selector: {
    connectionId?: string;
    projectId?: string;
  } = {},
): Promise<ConnectedAccountAccess> {
  const config = provider(providerId);
  const audience = connectionAudience(config.id);
  const connectionId = selector.connectionId?.trim() ?? "";
  const projectId = selector.projectId?.trim() ?? "";
  const projectClause = projectId
    ? `AND EXISTS (
         SELECT 1 FROM project_connections pc
          WHERE pc.workspace_id = c.workspace_id
            AND pc.project_id = ?
            AND pc.connection_id = c.id
       )`
    : "";
  const accountClause = connectionId ? "AND c.id = ?" : "";
  const orderClause =
    projectId && !connectionId
      ? `ORDER BY (
           SELECT pc.is_default FROM project_connections pc
            WHERE pc.project_id = ? AND pc.connection_id = c.id
         ) DESC, c.updated_at DESC`
      : "ORDER BY c.updated_at DESC";
  const bindings = [
    workspaceId,
    config.id,
    audience,
    actorUserId,
    ...(projectId ? [projectId] : []),
    ...(connectionId ? [connectionId] : []),
    ...(projectId && !connectionId ? [projectId] : []),
  ];
  const row = await getD1()
    .prepare(
      `SELECT c.id, c.kind, c.account_label AS accountLabel,
              c.metadata_json AS metadataJson, s.encrypted_json AS encryptedJson
         FROM connections c
         JOIN connection_secrets s ON s.connection_id = c.id
        WHERE c.workspace_id = ? AND c.kind = ? AND c.status = 'connected'
          AND (? = 'workspace' OR c.created_by = ?)
          ${projectClause}
          ${accountClause}
        ${orderClause}
        LIMIT 1`,
    )
    .bind(...bindings)
    .first<ConnectedAccountRow>();
  if (!row) {
    throw new Error(
      projectId
        ? `${config.label} has no account linked to this project.`
        : connectionId
          ? `That ${config.label} account is no longer available.`
          : audience === "workspace"
        ? `${config.label} is not connected to this workspace.`
        : `Connect your own ${config.label} account before using it in Spaces.`,
    );
  }

  let tokens = await decryptTokens(row.encryptedJson);
  if (!accessTokenStillValid(tokens)) {
    tokens = await refreshTokens(config, tokens);
    const stamp = new Date().toISOString();
    await getD1()
      .prepare(
        `UPDATE connection_secrets
            SET encrypted_json = ?, updated_at = ?
          WHERE connection_id = ?`,
      )
      .bind(await encryptTokens(tokens), stamp, row.id)
      .run();
  }
  const accessToken = String(tokens.access_token ?? "");
  if (!accessToken) throw new Error(`${config.label} did not provide an access token.`);
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
  } catch {
    // Older rows may predate structured provider metadata.
  }
  return {
    connectionId: row.id,
    provider: config.id,
    accountLabel: row.accountLabel,
    accountId: String(metadata.accountId ?? tokens.accountId ?? ""),
    accessToken,
  };
}

export async function markConnectionSynced(connectionId: string): Promise<void> {
  const stamp = new Date().toISOString();
  await getD1()
    .prepare(
      `UPDATE connections
          SET last_sync_at = ?, updated_at = ?, status = 'connected'
        WHERE id = ?`,
    )
    .bind(stamp, stamp, connectionId)
    .run();
}

export function integrationErrorResponse(request: Request, error: unknown): Response {
  const destination = new URL("/", request.url);
  destination.searchParams.set(
    "connection_error",
    error instanceof Error ? error.message : String(error),
  );
  return Response.redirect(destination.toString(), 302);
}
