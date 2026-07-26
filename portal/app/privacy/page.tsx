import type { Metadata } from "next";
import { LegalPage } from "../legal";

export const metadata: Metadata = {
  title: "Privacy Policy — Spaces",
  description: "How Spaces handles workspace, integration, and device data.",
};

export default function PrivacyPolicy() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy Policy"
      updated="July 26, 2026"
    >
      <section>
        <h2>What Spaces is</h2>
        <p>
          Spaces is a collaborative operating system for teams and their
          agents. It brings messages, projects, documents, calendars, connected
          accounts, social publishing, and paired desktop workflows into one
          workspace.
        </p>
      </section>

      <section>
        <h2>Information we process</h2>
        <p>We process information you choose to provide or connect, including:</p>
        <ul>
          <li>
            Account identity and workspace membership information used to sign
            you in, invite teammates, and apply permissions.
          </li>
          <li>
            Messages, projects, documents, knowledge, calendar records, content
            plans, and other material created or shared in a workspace.
          </li>
          <li>
            Connection tokens and provider identifiers for services you
            authorize, such as Google, Microsoft, TikTok, Meta, and X.
          </li>
          <li>
            Paired-device, agent, command, approval, run-status, and
            privacy-safe diagnostic information needed to coordinate work.
          </li>
        </ul>
      </section>

      <section>
        <h2>How information is used</h2>
        <p>
          We use this information to provide the actions you request: keeping a
          workspace in sync, routing messages and approvals, operating connected
          integrations, publishing approved content, coordinating agents, and
          securing the service. We do not sell personal information.
        </p>
      </section>

      <section>
        <h2>Personal and shared connections</h2>
        <p>
          Personal mail and calendar connections are scoped to the person who
          connected them unless that person explicitly shares resulting content
          into the workspace. Social publishing connections may be configured as
          workspace resources so authorized teammates can collaborate on content.
          Workspace owners and administrators control membership and access to
          shared resources.
        </p>
      </section>

      <section>
        <h2>Third-party services</h2>
        <p>
          When you connect or use a third-party service, Spaces sends the
          minimum information needed to perform the requested operation. The
          third party&apos;s own terms and privacy policy also apply. You may
          disconnect an integration to stop new actions through it.
        </p>
      </section>

      <section>
        <h2>Storage, security, and retention</h2>
        <p>
          Hosted workspace data is stored in managed cloud infrastructure.
          Integration secrets are stored separately as encrypted secrets and are
          not shown to workspace members. Some desktop work, terminal output, and
          local project files remain on the paired device. We retain information
          while it is needed to operate the workspace, meet legal obligations,
          or resolve security issues.
        </p>
      </section>

      <section>
        <h2>Your choices</h2>
        <p>
          You can disconnect integrations, remove paired devices, leave a
          workspace, or ask the workspace owner to remove your membership and
          associated workspace resources. Provider-side permissions can also be
          revoked in the relevant provider account.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          Spaces is not directed to children under 13 and should not be used
          by anyone who is not legally able to authorize the connected services.
        </p>
      </section>

      <section>
        <h2>Changes and questions</h2>
        <p>
          This policy may be updated as Spaces changes. The effective date
          above identifies the current version. Questions should be directed to
          the owner or administrator of the Spaces workspace that invited you.
        </p>
      </section>
    </LegalPage>
  );
}
