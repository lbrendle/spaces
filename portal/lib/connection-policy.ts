export type ConnectionAudience = "personal" | "workspace";

const WORKSPACE_SOCIAL_PROVIDERS = new Set(["meta", "tiktok", "x"]);
const PERSONAL_CONNECTION_ROLES = new Set(["owner", "admin", "member"]);
const WORKSPACE_CONNECTION_ROLES = new Set(["owner", "admin"]);

export function connectionAudience(providerId: string): ConnectionAudience {
  return WORKSPACE_SOCIAL_PROVIDERS.has(providerId) ? "workspace" : "personal";
}

export function canConnectProvider(providerId: string, role: string): boolean {
  return connectionAudience(providerId) === "workspace"
    ? WORKSPACE_CONNECTION_ROLES.has(role)
    : PERSONAL_CONNECTION_ROLES.has(role);
}

export function canUseConnection(
  providerId: string,
  ownerUserId: string,
  actorUserId: string,
): boolean {
  return (
    connectionAudience(providerId) === "workspace" ||
    (Boolean(actorUserId) && ownerUserId === actorUserId)
  );
}
