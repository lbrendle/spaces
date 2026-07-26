import type { PortalUser } from "./types";

const EMAIL = "oai-authenticated-user-email";
const NAME = "oai-authenticated-user-full-name";
const NAME_ENCODING = "oai-authenticated-user-full-name-encoding";

export function portalUserFromHeaders(headers: Headers): PortalUser | null {
  const email = headers.get(EMAIL)?.trim().toLowerCase();
  if (email) {
    const encoded = headers.get(NAME);
    let name = email.split("@")[0];
    if (
      encoded &&
      headers.get(NAME_ENCODING) === "percent-encoded-utf-8"
    ) {
      try {
        name = decodeURIComponent(encoded);
      } catch {
        // Email-derived display name remains the safe fallback.
      }
    }
    return { email, name };
  }

  const host = headers.get("host") ?? "";
  if (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]")
  ) {
    return {
      email: "founder@spaces.test",
      name: "Founder",
    };
  }
  return null;
}

export function requirePortalUser(headers: Headers): PortalUser {
  const user = portalUserFromHeaders(headers);
  if (!user) throw new AuthError(401, "Sign in with ChatGPT to continue.");
  return user;
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
