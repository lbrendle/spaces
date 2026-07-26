"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface InviteState {
  workspaceName: string;
  role: string;
  invitedEmail: string;
  signedInEmail: string;
  accepted: boolean;
  expired: boolean;
  canAccept: boolean;
}

export function JoinWorkspace({ token }: { token: string }) {
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const switchAccountHref = `/signout-with-chatgpt?return_to=${encodeURIComponent(
    `/join/${token}`,
  )}`;

  useEffect(() => {
    void fetch(`/api/join?token=${encodeURIComponent(token)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as InviteState & { error?: string };
        if (!response.ok) throw new Error(body.error || "Invite unavailable.");
        setInvite(body);
      })
      .catch((reason) => setError(String(reason.message ?? reason)));
  }, [token]);

  async function accept() {
    setWorking(true);
    setError("");
    try {
      const response = await fetch(
        `/api/join?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      const body = (await response.json()) as { error?: string; workspaceId?: string };
      if (!response.ok) throw new Error(body.error || "Invite unavailable.");
      window.location.assign(
        body.workspaceId ? `/?workspace=${encodeURIComponent(body.workspaceId)}` : "/",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setWorking(false);
    }
  }

  return (
    <main className="join-shell">
      <div className="join-brand">
        <span className="brand-glyph brand-icon" aria-hidden="true" />
        <span>Spaces</span>
      </div>
      <section className="join-card">
        <div className="eyebrow">Workspace invitation</div>
        {!invite && !error && <h1>Opening your invitation…</h1>}
        {invite && (
          <>
            <h1>Join {invite.workspaceName}</h1>
            <p>
              One shared place for messages, work, decisions, knowledge, and
              agent coordination. You were invited as <strong>{invite.role}</strong>.
            </p>
            <dl className="join-details">
              <div>
                <dt>Invitation</dt>
                <dd>{invite.invitedEmail}</dd>
              </div>
              <div>
                <dt>Signed in</dt>
                <dd>{invite.signedInEmail}</dd>
              </div>
            </dl>
            {invite.accepted ? (
              <Link className="primary-button wide" href="/">Open Spaces</Link>
            ) : invite.expired ? (
              <div className="notice error">This invitation has expired.</div>
            ) : invite.canAccept ? (
              <button
                className="primary-button wide"
                type="button"
                disabled={working}
                onClick={() => void accept()}
              >
                {working ? "Joining…" : `Join ${invite.workspaceName}`}
              </button>
            ) : (
              <>
                <div className="notice error">
                  You&apos;re signed in as {invite.signedInEmail}. This invitation
                  belongs to {invite.invitedEmail}.
                </div>
                <a className="primary-button wide" href={switchAccountHref}>
                  Use {invite.invitedEmail}
                </a>
              </>
            )}
          </>
        )}
        {error && (
          <div className="join-error-recovery">
            <div className="notice error">{error}</div>
            <a className="quiet-button wide" href={switchAccountHref}>
              Use another ChatGPT account
            </a>
          </div>
        )}
      </section>
      <p className="join-foot">Identity is provided by your ChatGPT workspace.</p>
    </main>
  );
}
