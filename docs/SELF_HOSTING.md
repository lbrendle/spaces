# Self-hosting

Spaces can run desktop-only or with a shared portal.

## Desktop-only

Run `desktop/` without a portal URL. Projects, channels, tasks, memory,
documents, local calendars, coding workspaces, terminals, the browser, and
local agents remain available. Teammate identity, cloud integrations,
cross-device sync, and remote jobs are unavailable.

## Shared portal on Sites

1. Create a new Sites project with D1.
2. Copy `portal/.openai/hosting.example.json` to
   `portal/.openai/hosting.json` and insert the new opaque project ID.
3. Add a high-entropy `INTEGRATION_TOKEN_KEY`.
4. Set `SPACES_SIGNUP_MODE=invite_only` before making the deployment public.
5. Add only the OAuth provider credentials you intend to support.
6. Register every provider callback against the final production hostname.
7. Deploy the portal, create the first workspace through the trusted ChatGPT
   identity flow, then invite members.
8. Pair each desktop with its own short-lived code.

The real `hosting.json` is ignored because it identifies one deployment. Never
copy another operator’s project ID or secrets.

GitHub uses a standard OAuth App with this callback:

```text
https://YOUR_HOST/api/integrations/github/callback
```

Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the hosted environment.
GitHub is a personal connection: every owner, admin, or member authorizes their
own account, and only that member can see or use its token. Shared
project/repository references do not grant teammates access to private
repositories.

## Outside Sites

The portal trusts authenticated identity headers supplied by the hosting layer.
An alternative host must provide an equivalent server-verified identity
boundary before requests reach the application. Do not accept user-supplied
email/name headers directly.

You must also provide a D1-compatible database binding named `DB`, or adapt
`portal/db/` to another transactional SQL service.

## OAuth review

Google, Microsoft, Meta, and TikTok may require app verification, test-user
roles, business verification, domain verification, or production review.
Spaces cannot bypass those controls. Keep a provider disabled until its app is
approved for the scopes shown in the Connections surface.
