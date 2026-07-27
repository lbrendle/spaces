# Configuration

## Desktop

Copy `desktop/.env.example` to `desktop/.env.local`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_SPACES_BRAND` | Product name in the UI | `Spaces` |
| `VITE_SPACES_BRAND_SHORT` | Compact product mark | `Spaces` |
| `VITE_SPACES_PORTAL_URL` | Paired portal base URL | empty; user is prompted |
| `VITE_SPACES_RITZ_URL` | Optional local Ritz-compatible model service | `http://127.0.0.1:8765` |
| `VITE_SPACES_DB_NAME` | SQLite filename in app data | `spaces.db` |
| `VITE_SPACES_CONTEXT_DIR` | Generated project context directory | `.hq` |
| `VITE_SPACES_SAMPLE_PATH` | Cosmetic example path | `~/code/my-app` |
| `VITE_SPACES_DOCS_URL` | Optional documentation URL | empty |

Build-time values are not secrets. OAuth credentials belong only in the portal.

## Portal

Copy `portal/.dev.vars.example` to `portal/.dev.vars` for local development.
Configure production values through Sites/Cloudflare secrets.

Core:

- `INTEGRATION_TOKEN_KEY` — high-entropy key used to encrypt OAuth tokens.
- `SPACES_SIGNUP_MODE` — `invite_only`, `allowlist`, or `open`.
- `SPACES_SIGNUP_ALLOWLIST` — comma-separated exact email addresses for
  `allowlist` mode.
- `NEXT_PUBLIC_SPACES_DESKTOP_DOWNLOAD_URL` — optional operator-provided
  desktop download. Without it the portal links to upstream releases.

Providers:

- GitHub: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Microsoft: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- Instagram/Meta: `META_APP_ID`, `META_APP_SECRET`,
  `META_GRAPH_VERSION`
- TikTok: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
- X, if a fork enables it: `X_CLIENT_ID`, `X_CLIENT_SECRET`

Redirect URIs are:

```text
https://YOUR_HOST/api/integrations/github/callback
https://YOUR_HOST/api/integrations/google/callback
https://YOUR_HOST/api/integrations/microsoft/callback
https://YOUR_HOST/api/integrations/meta/callback
https://YOUR_HOST/api/integrations/tiktok/callback
https://YOUR_HOST/api/integrations/x/callback
```

Use a different token encryption key and OAuth application for every
independent deployment. Never reuse the example configuration as production
credentials.
