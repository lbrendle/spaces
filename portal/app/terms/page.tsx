import type { Metadata } from "next";
import { LegalPage } from "../legal";

export const metadata: Metadata = {
  title: "Terms of Service — Spaces",
  description: "Terms for using Spaces and its connected services.",
};

export default function TermsOfService() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      updated="July 26, 2026"
    >
      <section>
        <h2>Using Spaces</h2>
        <p>
          Spaces lets people coordinate work, information, connected
          services, paired devices, and software agents in a shared workspace.
          By using it, you agree to these terms and confirm that you are allowed
          to use the accounts, content, devices, and services you connect.
        </p>
      </section>

      <section>
        <h2>Accounts and workspaces</h2>
        <p>
          Keep your account and paired-device credentials secure. Workspace
          owners control membership, roles, shared connections, and access to
          workspace data. Actions taken through your signed-in account or paired
          device are treated as your actions unless you promptly report
          unauthorized access.
        </p>
      </section>

      <section>
        <h2>Your content</h2>
        <p>
          You retain ownership of content you submit. You grant Spaces the
          limited permission needed to store, process, display, synchronize, and
          transmit that content to provide the features you request. You are
          responsible for having the rights and permissions needed to use and
          publish it.
        </p>
      </section>

      <section>
        <h2>Connected services</h2>
        <p>
          Third-party services have their own terms, availability, review
          requirements, rate limits, and policies. Connecting a service
          authorizes Spaces to act within the permissions you approve.
          Disconnecting a service stops new Spaces actions but may not delete
          data already held by that provider.
        </p>
      </section>

      <section>
        <h2>Agents and approvals</h2>
        <p>
          Software agents can produce incorrect or unexpected results. Review
          prompts, requested permissions, code changes, content, and external
          actions before approval. Coding work requested from another device
          requires approval from the host device, and only authorized people
          should control shared agents or publishing accounts.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>You may not use Spaces to:</p>
        <ul>
          <li>Access accounts, systems, or data without authorization.</li>
          <li>
            Publish unlawful, deceptive, infringing, abusive, or harmful
            material.
          </li>
          <li>
            Evade provider safeguards, platform review, rate limits, or access
            controls.
          </li>
          <li>
            Distribute malicious code or interfere with the operation of the
            service or another workspace.
          </li>
        </ul>
      </section>

      <section>
        <h2>Availability and warranties</h2>
        <p>
          Spaces is provided on an as-available basis. Features may change,
          fail, or depend on third-party services. To the extent permitted by
          law, no warranties are made that the service will be uninterrupted,
          error-free, or suitable for a particular purpose.
        </p>
      </section>

      <section>
        <h2>Responsibility and termination</h2>
        <p>
          You are responsible for reviewing consequential actions and for the
          content and services you connect. Access may be suspended or removed
          when needed to protect a workspace, comply with law, or address misuse.
          You may stop using Spaces and disconnect integrations at any time.
        </p>
      </section>

      <section>
        <h2>Changes and questions</h2>
        <p>
          These terms may be updated as Spaces evolves. The effective date
          above identifies the current version. Questions should be directed to
          the owner or administrator of the Spaces workspace that invited you.
        </p>
      </section>
    </LegalPage>
  );
}
