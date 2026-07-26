export type SignupMode = "open" | "invite_only" | "allowlist";

export interface SignupPolicy {
  mode: SignupMode;
  allowlist: Set<string>;
}

export function signupPolicy(
  rawMode: unknown,
  rawAllowlist: unknown,
  host = "",
): SignupPolicy {
  const normalizedHost = host.toLowerCase();
  const local =
    normalizedHost.startsWith("localhost") ||
    normalizedHost.startsWith("127.0.0.1") ||
    normalizedHost.startsWith("[::1]");
  const mode =
    rawMode === "open" ||
    rawMode === "invite_only" ||
    rawMode === "allowlist"
      ? rawMode
      : local
        ? "open"
        : "invite_only";
  const allowlist = new Set(
    typeof rawAllowlist === "string"
      ? rawAllowlist
          .split(/[\s,;]+/)
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean)
      : [],
  );
  return { mode, allowlist };
}

export function canCreateWorkspace(
  email: string,
  policy: SignupPolicy,
): boolean {
  if (policy.mode === "open") return true;
  if (policy.mode === "allowlist") {
    return policy.allowlist.has(email.trim().toLowerCase());
  }
  return false;
}

export function signupDeniedMessage(policy: SignupPolicy): string {
  return policy.mode === "allowlist"
    ? "This ChatGPT account is not on the Spaces workspace allowlist. Ask an owner for an invite."
    : "This ChatGPT account does not belong to an Spaces workspace yet. Ask an owner for an invite.";
}
