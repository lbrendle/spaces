# Public feature inventory

Last audited: 2026-07-26

This is the source-of-truth inventory for the public Spaces distribution.
“Implemented” means a real code path exists. It does not mean a third-party
provider has approved your OAuth app, that an upstream API is enabled, or that
the feature has been exercised against your deployment.

## Release boundary

Included:

- the macOS Tauri desktop source;
- the Cloudflare/Sites portal, D1 migrations, and R2 media binding;
- local SQLite migrations;
- the Spaces MCP action transport and approval queue;
- provider OAuth and action implementations;
- CI, security policy, contribution files, and self-hosting documentation.

Deliberately excluded:

- production D1 data and Sites project identifiers;
- OAuth client IDs, client secrets, access tokens, and token-encryption keys;
- Apple signing/notarization credentials;
- desktop updater signing keys and private download infrastructure;
- personal account names, workspace IDs, device tokens, pairing codes,
  transcripts, repositories, and local database files;
- provider-specific domain-verification files.

## Capability matrix

| Surface | Status in source | Where data lives | Important boundary |
| --- | --- | --- | --- |
| Projects, channels, tasks, memory | Implemented | Desktop SQLite; selected shared state in portal D1 when paired | Local-only work does not require the portal. |
| Project and channel removal | Implemented | Desktop SQLite and portal D1 | Desktop exposes typed-confirmation cleanup. Shared removal is owner/admin-only; project tombstones prevent deleted duplicates from returning on paired devices. Code folders and Git remotes are never deleted. |
| Human + agent channel chat | Implemented | Desktop SQLite; shared channel data in D1 when paired | Agent responses run on the owning desktop. |
| Claude Code and Codex agents | Implemented | Local process/session state | Each user authenticates the CLI they run. Spaces stores no Claude/Codex API key. |
| Model, effort, sandbox and CLI configuration | Implemented | Desktop SQLite; shareable agent profile in D1 | Available options still depend on the installed CLI version. |
| Live agent process inspection | Implemented | Desktop only | Streams and full transcripts are not mirrored to the portal. |
| Persistent terminal panes | Implemented | Desktop process state | A terminal survives pane/tab navigation while the desktop process remains open; it is not a cloud shell. |
| Embedded project browser | Implemented on macOS | Desktop WebView state | It is an embedded webview, not a remote browser and not available in the portal. |
| Git activity and isolated worktrees | Implemented | Local repository plus `gh` reads | Spaces coordinates Git; it is not a Git object host or GitHub replacement. |
| Personal GitHub account connection | Implemented in source | Member-owned encrypted OAuth token in D1; local `gh` credential stays on that member's desktop | Members connect and see their own account. The portal never exposes the app owner’s personal token to other members. A deployment must configure a GitHub OAuth app. |
| Spaces agent MCP tools | Implemented | Generated `.hq/` files plus desktop approval log | Code projects use their checkout. Non-code projects receive a private control directory so tools do not disappear. Spawned harnesses receive explicit run, agent, channel, and project identity. |
| Agent Content Studio tools and social publishing | Implemented | Shared D1 Content Studio + desktop approval log + portal provider action | Agents can list, read, create, fully revise, stage, deduplicate, and publish canonical board cards through `spaces_list_content`, `spaces_get_content`, `spaces_create_content`, `spaces_update_content`, `spaces_delete_content`, and `spaces_publish_social`. Publishing and deletion wait for human approval. Local media can be uploaded through `media_path`. Existing agent sessions must restart to discover newly added tools. |
| Documents and knowledge | Implemented | Desktop SQLite; explicitly shared pages in D1 | Nested source/folder/note trees, preserved cross-member paths, native shared-note editing, Markdown, versions, wikilinks/backlinks, project memory, and read-only vault imports are supported. This is not simultaneous multiplayer text editing. |
| Agent Knowledge references | Implemented | Permission-filtered `.hq/KNOWLEDGE.md` snapshot | `spaces_search_knowledge` and `spaces_read_knowledge` return stable `knowledge:source:path` citations. Snapshot size is bounded and says when notes were omitted or truncated. |
| Obsidian-style vault mounting | Implemented, read-only | Original files stay on disk; index/cache in desktop SQLite | Spaces does not rewrite the mounted vault. |
| Mail list/send | Implemented for Google and Microsoft | Tokens encrypted in D1; synced rows in desktop SQLite | Provider APIs and scopes must be enabled. Personal mail connections are not workspace-shared by default. |
| Google/Microsoft calendars | List/create implemented | Tokens encrypted in D1; shared metadata/events in D1 and desktop SQLite | Upstream edit/delete and attendee invitations are not complete. |
| Apple Calendar | List/create implemented on macOS | Calendar.app plus desktop SQLite/shared command state | Runs through local macOS automation permission; there is no cloud Apple Calendar OAuth path. |
| Team/shared calendars | Implemented in Spaces | D1 and desktop SQLite | Provider-backed calendars still obey the connected account’s own permissions. |
| Instagram OAuth | Implemented with Instagram Login | Encrypted token in D1 | Every account must be eligible for the Meta app; development-role and app-review rules are external. Multiple accounts are stored separately. |
| Instagram image publishing | Implemented | Portal R2 media, provider action, and Content Studio audit row | A local image can be uploaded to a stable provider-ready HTTPS URL. The Meta app still needs `instagram_business_content_publish`; a connected account alone does not grant a native Claude/Codex connector. |
| TikTok OAuth | Implemented | Encrypted token in D1 | Sandbox/production target and Content Posting approval are controlled by TikTok. Multiple accounts are stored separately. |
| TikTok video publishing | Implemented | Portal R2 media, provider action, and Content Studio audit row | Local videos are uploaded with byte-range delivery. TikTok may require the deployed media URL prefix to be verified and may return a processing job rather than a finished post. |
| X OAuth and text publishing | Implemented, optional | Encrypted token in D1; portal provider action | The provider can be omitted from a deployment by leaving its OAuth configuration unset. |
| Project-to-social-account links | Implemented | D1 | Publishing enforces project links and the selected/default account, including multiple accounts for one provider. |
| Content Studio | Implemented | Portal D1 canonical board, paired desktop SQLite mirrors, workspace R2 media, and provider action result | The same idea/drafting/review/scheduled/published cards reconcile across the web workspace and paired members. Full briefs, copy, project/account links, agent ownership, media, errors, and publish results stay together. It is not a Buffer/Later connector and does not import their queues. |
| ChatGPT-authenticated portal | Implemented for Sites | Sites request identity + D1 membership | Authentication proves identity; membership/invitation policy grants access. Self-hosters outside Sites must supply an equivalent trusted identity layer. |
| Invitations, roles, removal | Implemented | D1 | Removing a person also revokes devices and removes or transfers their governed resources. |
| Desktop pairing | Implemented | Hashed device token in D1; token on that desktop | Pairing codes are short-lived and single-use. |
| Cross-device/BYO agent jobs | Implemented | Bounded job/result state in D1; execution on host desktop | Repositories and live process streams remain on the host. The requested prompt and sanitized final result cross the control plane. |
| Desktop auto-update | Implemented in the public source | Operator-hosted signed manifest and artifacts | The public source includes the updater client and release worker. Every fork must create its own updater key, endpoint, and platform signatures; private signing material is never committed. |
| Windows/Linux desktop | Not release-verified | N/A | Some code is portable, but macOS is the only supported and audited desktop target today. |

## Verification levels

The initial public release gate runs:

- a clean source and history scan;
- dependency vulnerability and license inventories;
- desktop TypeScript/Vite build;
- Rust unit tests;
- portal production build, tests, TypeScript check, and lint;
- MCP protocol/tool discovery checks;
- a fresh public clone repeating the build/test path;
- GitHub Actions on the public commit.

Provider transactions are a separate gate because they can create external
side effects. OAuth connection and multi-account selection can be tested
without publishing. A real Instagram/TikTok post should be performed only from
an explicitly approved test account and is not implied by a green source build.
