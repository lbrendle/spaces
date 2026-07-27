"use client";

import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentProfile,
  InboxItem,
  Issue,
  IssueStatus,
  KnowledgePage,
  Message,
  WorkspaceSnapshot,
  WorkspaceUnchanged,
} from "../lib/types";
import {
  buildKnowledgeTree,
  type KnowledgeTreeNode,
} from "../lib/knowledge-tree";

const UPSTREAM_REPOSITORY = "https://github.com/lbrendle/spaces";
const CONFIGURED_DESKTOP_DOWNLOAD =
  process.env.NEXT_PUBLIC_SPACES_DESKTOP_DOWNLOAD_URL?.trim() ?? "";
const DESKTOP_DOWNLOAD_URL =
  CONFIGURED_DESKTOP_DOWNLOAD || `${UPSTREAM_REPOSITORY}/releases`;
const DESKTOP_DOWNLOAD_LABEL = CONFIGURED_DESKTOP_DOWNLOAD
  ? "Download for Mac"
  : "View desktop releases";
const DESKTOP_DOWNLOAD_NOTE = CONFIGURED_DESKTOP_DOWNLOAD
  ? "Use the signed build published by your workspace operator."
  : "No operator build is configured; build from source or use an upstream release.";

type Surface =
  | "overview"
  | "access"
  | "agents"
  | "devices"
  | "security"
  | "today"
  | "messages"
  | "work"
  | "inbox"
  | "knowledge"
  | "calendar"
  | "people"
  | "connections";

interface ProviderCatalogItem {
  id: string;
  label: string;
  ready: boolean;
  reason: string;
  scopes: string[];
  audience: "personal" | "workspace";
  canConnect: boolean;
}

type DialogKind =
  | "invite"
  | "issue"
  | "channel"
  | "project"
  | "knowledge"
  | "calendar"
  | "event"
  | "decision"
  | "inbox"
  | "agent"
  | "team"
  | "pair"
  | null;

const NAV: Array<{
  id: Surface;
  label: string;
  hint: string;
  glyph: string;
}> = [
  { id: "overview", label: "Overview", hint: "Admin health and setup", glyph: "01" },
  { id: "access", label: "People + access", hint: "Members and invitations", glyph: "02" },
  { id: "agents", label: "Agents + teams", hint: "Models, effort, and roles", glyph: "03" },
  { id: "devices", label: "Desktop pairing", hint: "Devices and live sync", glyph: "04" },
  { id: "security", label: "Security", hint: "Boundaries and authorization", glyph: "05" },
];

const WORKSPACE_NAV: typeof NAV = [
  { id: "today", label: "Today", hint: "Your operating brief", glyph: "01" },
  { id: "messages", label: "Messages", hint: "Shared channels", glyph: "02" },
  { id: "work", label: "Work", hint: "Issues and projects", glyph: "03" },
  { id: "inbox", label: "Inbox", hint: "Mail and requests", glyph: "04" },
  { id: "calendar", label: "Calendar", hint: "Team and individual time", glyph: "05" },
  { id: "knowledge", label: "Knowledge", hint: "Vaults, notes, and backlinks", glyph: "06" },
];

const NAV_GROUPS = [
  { label: "Administration", items: NAV },
  { label: "Workspace", items: WORKSPACE_NAV },
];

const ALL_NAV = [...NAV, ...WORKSPACE_NAV];

const SURFACE_META: Record<
  Surface,
  { eyebrow: string; title: string; detail: string; action: string; dialog: DialogKind }
> = {
  overview: {
    eyebrow: "Spaces administration",
    title: "Admin overview",
    detail: "Identity, access, agents, and connected desktops in one control plane.",
    action: "Invite teammate",
    dialog: "invite",
  },
  access: {
    eyebrow: "Workspace administration",
    title: "People + access",
    detail: "Control who can enter Spaces and what role they receive.",
    action: "Invite teammate",
    dialog: "invite",
  },
  agents: {
    eyebrow: "Runtime administration",
    title: "Agents + teams",
    detail: "Configure roles, ownership, harnesses, models, effort, and team structure.",
    action: "New agent",
    dialog: "agent",
  },
  devices: {
    eyebrow: "Machine administration",
    title: "Desktop pairing",
    detail: "Connect trusted Spaces desktops and inspect their privacy-safe sync state.",
    action: "Pair desktop",
    dialog: "pair",
  },
  security: {
    eyebrow: "Trust boundary",
    title: "Security",
    detail: "See exactly what is authenticated, synchronized, and kept local.",
    action: "",
    dialog: null,
  },
  today: {
    eyebrow: "Company pulse",
    title: "Today",
    detail: "One clear view of what needs your attention.",
    action: "Invite teammate",
    dialog: "invite",
  },
  messages: {
    eyebrow: "Shared context",
    title: "Messages",
    detail: "People and agents coordinate in the same channels.",
    action: "New channel",
    dialog: "channel",
  },
  work: {
    eyebrow: "Execution",
    title: "Work",
    detail: "Projects, issues, and handoffs without a separate tracker.",
    action: "New issue",
    dialog: "issue",
  },
  inbox: {
    eyebrow: "Intake",
    title: "Inbox",
    detail: "Mail, requests, and loose ends enter one triage queue.",
    action: "Capture item",
    dialog: "inbox",
  },
  knowledge: {
    eyebrow: "Company memory",
    title: "Knowledge",
    detail: "Shared documents, selected vault files, backlinks, decisions, and research.",
    action: "New page",
    dialog: "knowledge",
  },
  calendar: {
    eyebrow: "Shared time",
    title: "Calendar",
    detail: "Overlay workspace, team, and individual calendars without leaking private details.",
    action: "New event",
    dialog: "event",
  },
  people: {
    eyebrow: "Organization",
    title: "People + agents",
    detail: "Roles, teams, ownership, models, and effort in one roster.",
    action: "Invite teammate",
    dialog: "invite",
  },
  connections: {
    eyebrow: "Connected Spaces",
    title: "Connections",
    detail: "Pair desktops and bring existing work into native Spaces flows.",
    action: "Pair desktop",
    dialog: "pair",
  },
};

const STATUS_COLUMNS: Array<{
  id: IssueStatus;
  label: string;
  short: string;
}> = [
  { id: "backlog", label: "Backlog", short: "BL" },
  { id: "ready", label: "Ready", short: "RD" },
  { id: "in_progress", label: "In progress", short: "IP" },
  { id: "review", label: "Review", short: "RV" },
  { id: "done", label: "Done", short: "DN" },
];

const SOURCE_CATALOG = [
  {
    kind: "desktop",
    label: "Spaces desktop",
    descriptor: "Projects, tasks, live agent runs, terminals, and local repositories",
    mode: "Pairing code",
  },
  {
    kind: "code",
    label: "Local execution",
    descriptor: "Code, terminals, full transcripts, and repository contents remain on the paired Mac",
    mode: "Local only",
  },
  {
    kind: "identity",
    label: "ChatGPT identity",
    descriptor: "People sign in with ChatGPT, then server-side workspace membership controls access",
    mode: "SIWC",
  },
  {
    kind: "runtime",
    label: "Agent runtimes",
    descriptor: "Claude, Codex, and Ritz configuration is administered here and executed by Spaces desktop",
    mode: "Admin policy",
  },
  {
    kind: "accounts",
    label: "Connected accounts",
    descriptor: "Google, Microsoft, Instagram, TikTok, and X accounts are administered here and consumed by the paired desktop",
    mode: "Encrypted OAuth",
  },
];

function initials(value: string): string {
  return (
    value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "Spaces"
  );
}

function mentionHandle(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "teammate"
  );
}

function relative(value: string | number): string {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  const difference = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function switchChatGPTAccount() {
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(
    `/signout-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`,
  );
}

function titleCase(value: string): string {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formValue(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

export function PortalApp() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [surface, setSurfaceState] = useState<Surface>("overview");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [shareValue, setShareValue] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const revisionRef = useRef(0);
  const workspaceRef = useRef("");
  const refreshControllerRef = useRef<AbortController | null>(null);

  const workspaceFromUrl =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("workspace") ?? "";

  function setSurface(next: Surface) {
    setSurfaceState(next);
    const url = new URL(window.location.href);
    url.searchParams.set("surface", next);
    window.history.replaceState({}, "", url);
    window.scrollTo(0, 0);
  }

  async function load(
    workspaceId = workspaceRef.current || workspaceFromUrl,
    background = false,
    force = false,
  ) {
    if (background && refreshControllerRef.current) return;
    if (!background) refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      const params = new URLSearchParams();
      if (workspaceId) params.set("workspace", workspaceId);
      if (!force && workspaceRef.current) {
        params.set("since", String(revisionRef.current));
      }
      const suffix = params.size ? `?${params.toString()}` : "";
      const response = await fetch(`/api/workspace${suffix}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json()) as
        | (WorkspaceSnapshot & { error?: string })
        | (WorkspaceUnchanged & { error?: string });
      if (!response.ok) throw new Error(body.error || "Spaces could not load this workspace.");
      revisionRef.current = body.revision;
      if ("unchanged" in body) return;
      workspaceRef.current = body.workspace.id;
      setSnapshot(body);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      if (!background) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (refreshControllerRef.current === controller) {
        refreshControllerRef.current = null;
        if (!background) setLoading(false);
      }
    }
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void load();
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("surface");
      if (
        requested &&
        [
          "overview",
          "access",
          "agents",
          "devices",
          "security",
          "today",
          "messages",
          "work",
          "inbox",
          "calendar",
          "knowledge",
          "people",
          "connections",
        ].includes(requested)
      ) {
        setSurface(requested as Surface);
      }
      const connectionError = params.get("connection_error");
      const connected = params.get("connected");
      if (connectionError) setError(connectionError);
      if (connected) {
        setNotice(`${titleCase(connected)} connected.`);
        setSurface("connections");
      }
      if (connectionError || connected) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("connection_error");
        cleanUrl.searchParams.delete("connected");
        window.history.replaceState({}, "", cleanUrl);
      }
      const stored = window.localStorage.getItem("spaces-portal-rail");
      if (stored) setRailOpen(stored !== "closed");
      const theme = window.localStorage.getItem("spaces-portal-theme");
      if (theme === "dark") document.documentElement.dataset.theme = "dark";
      if (theme === "light") document.documentElement.dataset.theme = "light";
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") {
        void load(workspaceRef.current, true);
      }
    }
    const interval = window.setInterval(refresh, 3_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      refreshControllerRef.current?.abort();
    };
    // The refresh loop intentionally reads the latest workspace and revision from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape") {
        setDialog(null);
        setSearchOpen(false);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  async function mutate(
    input: Record<string, unknown>,
    success: string,
  ): Promise<Record<string, unknown>> {
    if (!snapshot) throw new Error("Workspace unavailable.");
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          workspaceId: snapshot.workspace.id,
        }),
      });
      const body = (await response.json()) as Record<string, unknown> & {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || "Spaces could not save that.");
      setNotice(success);
      await load(snapshot.workspace.id, false, true);
      return body;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setWorking(false);
    }
  }

  function changeWorkspace(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("workspace", id);
    window.history.replaceState({}, "", url);
    revisionRef.current = 0;
    workspaceRef.current = id;
    void load(id, false, true);
  }

  function toggleRail() {
    setRailOpen((open) => {
      window.localStorage.setItem("spaces-portal-rail", open ? "closed" : "open");
      return !open;
    });
  }

  function toggleTheme() {
    const current =
      document.documentElement.dataset.theme ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("spaces-portal-theme", next);
  }

  const meta = SURFACE_META[surface];
  const globalMatches = useMemo(() => {
    if (!snapshot || !query.trim()) return [];
    const needle = query.trim().toLowerCase();
    const matches: Array<{ surface: Surface; label: string; detail: string }> = [];
    for (const member of snapshot.members) {
      if (`${member.name} ${member.email} ${member.role}`.toLowerCase().includes(needle)) {
        matches.push({ surface: "access", label: member.name, detail: member.role });
      }
    }
    for (const invite of snapshot.pendingInvites) {
      if (`${invite.email} ${invite.role}`.toLowerCase().includes(needle)) {
        matches.push({ surface: "access", label: invite.email, detail: "Pending invite" });
      }
    }
    for (const agent of snapshot.agents) {
      if (`${agent.name} ${agent.role} ${agent.backend} ${agent.model}`.toLowerCase().includes(needle)) {
        matches.push({ surface: "agents", label: agent.name, detail: agent.role || "Agent" });
      }
    }
    for (const team of snapshot.teams) {
      if (`${team.name} ${team.purpose}`.toLowerCase().includes(needle)) {
        matches.push({ surface: "agents", label: team.name, detail: "Team" });
      }
    }
    for (const device of snapshot.devices) {
      if (`${device.name} ${device.status}`.toLowerCase().includes(needle)) {
        matches.push({ surface: "devices", label: device.name, detail: device.status });
      }
    }
    return matches.slice(0, 10);
  }, [query, snapshot]);

  if (loading && !snapshot) {
    return (
      <main className="portal-loading">
        <div className="brand-glyph brand-icon" aria-hidden="true" />
        <div>
          <strong>Spaces</strong>
          <span>Opening your workspace…</span>
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="portal-loading error-state">
        <div className="brand-glyph">!</div>
        <div className="auth-recovery">
          <strong>Spaces could not open</strong>
          <span>{error || "This workspace is unavailable."}</span>
          <div className="auth-recovery-actions">
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
            <button
              type="button"
              className="quiet-button"
              onClick={switchChatGPTAccount}
            >
              Use another ChatGPT account
            </button>
          </div>
          <small>
            This clears Spaces&apos;s site session and starts ChatGPT sign-in
            again.
          </small>
        </div>
      </main>
    );
  }

  const canManageAccess =
    snapshot.workspace.role === "owner" || snapshot.workspace.role === "admin";
  const canPairDesktop =
    canManageAccess || snapshot.workspace.role === "member";
  const canOpenPrimaryDialog =
    meta.dialog !== "invite"
      ? meta.dialog !== "pair" || canPairDesktop
      : canManageAccess;

  return (
    <main className={`portal-shell ${railOpen ? "" : "rail-collapsed"}`}>
      <aside className="portal-rail" aria-label="Spaces navigation">
        <div className="rail-brand-row">
          <button
            type="button"
            className="brand-button"
            aria-label="Go to admin overview"
            onClick={() => setSurface("overview")}
          >
            <span className="brand-glyph brand-icon" aria-hidden="true" />
            <span className="brand-word">Spaces</span>
          </button>
          <button
            className="rail-collapse"
            type="button"
            aria-label={railOpen ? "Collapse navigation" : "Expand navigation"}
            onClick={toggleRail}
          >
            {railOpen ? "‹" : "›"}
          </button>
        </div>

        <label className="workspace-picker">
          <span className="workspace-avatar">{initials(snapshot.workspace.name)}</span>
          <span className="workspace-picker-copy">
            <small>Workspace</small>
            <select
              aria-label="Workspace"
              value={snapshot.workspace.id}
              onChange={(event) => changeWorkspace(event.target.value)}
            >
              {snapshot.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </span>
        </label>

        <div className="rail-navigation">
          {NAV_GROUPS.map((group) => (
            <div className="rail-group" key={group.label}>
              <span className="rail-section-label">{group.label}</span>
              <nav className="rail-nav" aria-label={group.label}>
                {group.items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={surface === item.id ? "active" : ""}
                    onClick={() => setSurface(item.id)}
                    title={!railOpen ? item.label : undefined}
                  >
                    <span className="nav-index">{item.glyph}</span>
                    <span className="nav-copy">
                      <strong>{item.label}</strong>
                      <small>{item.hint}</small>
                    </span>
                    {item.id === "access" && snapshot.pendingInvites.length > 0 && (
                      <span className="nav-count">{snapshot.pendingInvites.length}</span>
                    )}
                    {item.id === "inbox" &&
                      snapshot.inbox.some((entry) => entry.status === "new") && (
                        <span className="nav-count">
                          {snapshot.inbox.filter((entry) => entry.status === "new").length}
                        </span>
                      )}
                  </button>
                ))}
              </nav>
            </div>
          ))}
        </div>

        <div className="rail-foot">
          <button
            type="button"
            className="rail-search"
            onClick={() => {
              setSearchOpen(true);
              window.setTimeout(() => searchRef.current?.focus(), 0);
            }}
          >
            <span>Search Spaces</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="rail-user">
            <span className="person-avatar">
              {initials(snapshot.currentUser.name)}
            </span>
            <span className="rail-user-copy">
              <strong>{snapshot.currentUser.name}</strong>
              <span className="rail-user-meta">
                <small>{snapshot.workspace.role}</small>
                <a
                  href="/signout-with-chatgpt?return_to=%2F"
                  title="Sign out or switch ChatGPT account"
                >
                  Switch account
                </a>
              </span>
            </span>
            <button type="button" title="Toggle theme" onClick={toggleTheme}>
              ◐
            </button>
          </div>
        </div>
      </aside>

      <section className="portal-main">
        <header className="portal-header">
          <div>
            <span className="eyebrow">{meta.eyebrow}</span>
            <h1>{meta.title}</h1>
            <p>{meta.detail}</p>
          </div>
          <div className="header-actions">
            {surface === "agents" && (
              <button
                className="quiet-button"
                type="button"
                onClick={() => setDialog("team")}
              >
                New team
              </button>
            )}
            {surface === "work" && (
              <button
                className="quiet-button"
                type="button"
                onClick={() => setDialog("project")}
              >
                New project
              </button>
            )}
            {surface === "knowledge" && (
              <button
                className="quiet-button"
                type="button"
                onClick={() => setDialog("decision")}
              >
                Record decision
              </button>
            )}
            {surface === "people" && (
              <>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setDialog("team")}
                >
                  New team
                </button>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setDialog("agent")}
                >
                  New agent
                </button>
              </>
            )}
            {meta.dialog && canOpenPrimaryDialog && (
              <button
                className="primary-button"
                type="button"
                onClick={() => setDialog(meta.dialog)}
              >
                <span>+</span>
                {meta.action}
              </button>
            )}
          </div>
        </header>

        {(error || notice) && (
          <div className={`portal-toast ${error ? "error" : "success"}`}>
            <span>{error || notice}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              ×
            </button>
          </div>
        )}

        <div className="portal-content">
          {surface === "overview" && (
            <AdminOverviewSurface
              snapshot={snapshot}
              setSurface={setSurface}
              onInvite={() => setDialog("invite")}
              onPair={() => setDialog("pair")}
              canManageAccess={canManageAccess}
              canPairDesktop={canPairDesktop}
            />
          )}
          {surface === "access" && (
            <AccessAdminSurface
              snapshot={snapshot}
              onInvite={() => setDialog("invite")}
              working={working}
              onRoleChange={(memberId, role) =>
                mutate(
                  { action: "update_member_role", memberId, role },
                  "Workspace role updated.",
                )
              }
              onRemove={(memberId) =>
                mutate(
                  { action: "remove_member", memberId },
                  "Person and their agents removed from the workspace.",
                )
              }
            />
          )}
          {surface === "agents" && (
            <AgentAdminSurface
              snapshot={snapshot}
              onAgent={() => setDialog("agent")}
              onTeam={() => setDialog("team")}
            />
          )}
          {surface === "devices" && (
            <ConnectionsSurface
              snapshot={snapshot}
              working={working}
              mutate={mutate}
              onPair={() => setDialog("pair")}
              onRevoke={(deviceId) =>
                mutate({ action: "revoke_device", deviceId }, "Desktop access revoked.")
              }
            />
          )}
          {surface === "security" && <SecurityAdminSurface snapshot={snapshot} />}
          {surface === "today" && (
            <TodaySurface snapshot={snapshot} setSurface={setSurface} />
          )}
          {surface === "messages" && (
            <MessagesSurface
              snapshot={snapshot}
              working={working}
              mutate={mutate}
            />
          )}
          {surface === "work" && (
            <WorkSurface snapshot={snapshot} mutate={mutate} />
          )}
          {surface === "inbox" && (
            <InboxSurface snapshot={snapshot} mutate={mutate} />
          )}
          {surface === "calendar" && (
            <CalendarSurface
              snapshot={snapshot}
              onCreateCalendar={() => setDialog("calendar")}
              onCreateEvent={() => setDialog("event")}
            />
          )}
          {surface === "knowledge" && (
            <KnowledgeSurface
              key={snapshot.workspace.id}
              snapshot={snapshot}
              working={working}
              mutate={mutate}
            />
          )}
          {surface === "people" && <PeopleSurface snapshot={snapshot} />}
          {surface === "connections" && (
            <ConnectionsSurface
              snapshot={snapshot}
              working={working}
              mutate={mutate}
              onPair={() => setDialog("pair")}
              onRevoke={(deviceId) =>
                mutate({ action: "revoke_device", deviceId }, "Desktop access revoked.")
              }
            />
          )}
        </div>
      </section>

      {dialog && (
        <PortalDialog
          kind={dialog}
          snapshot={snapshot}
          working={working}
          shareValue={shareValue}
          setShareValue={setShareValue}
          onNotice={setNotice}
          onClose={() => {
            setDialog(null);
            setShareValue("");
          }}
          mutate={mutate}
        />
      )}

      {searchOpen && (
        <div
          className="search-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setSearchOpen(false);
          }}
        >
          <section className="command-search" role="dialog" aria-label="Search Spaces">
            <div className="command-input">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search members, agents, teams, and devices…"
                aria-label="Search Spaces"
              />
              <kbd>esc</kbd>
            </div>
            <div className="command-results">
              {!query.trim() ? (
                <>
                  <div className="result-heading">Go to</div>
                  {ALL_NAV.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setSurface(item.id);
                        setSearchOpen(false);
                      }}
                    >
                      <span>{item.glyph}</span>
                      <strong>{item.label}</strong>
                      <small>{item.hint}</small>
                    </button>
                  ))}
                </>
              ) : globalMatches.length ? (
                <>
                  <div className="result-heading">Results</div>
                  {globalMatches.map((match, index) => (
                    <button
                      key={`${match.surface}-${index}`}
                      type="button"
                      onClick={() => {
                        setSurface(match.surface);
                        setSearchOpen(false);
                      }}
                    >
                      <span>{ALL_NAV.find((item) => item.id === match.surface)?.glyph}</span>
                      <strong>{match.label}</strong>
                      <small>{match.detail}</small>
                    </button>
                  ))}
                </>
              ) : (
                <EmptyState
                  index="00"
                  title="No results"
                  detail="Try a member, email, agent, team, or desktop name."
                />
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function AdminOverviewSurface({
  snapshot,
  setSurface,
  onInvite,
  onPair,
  canManageAccess,
  canPairDesktop,
}: {
  snapshot: WorkspaceSnapshot;
  setSurface: (surface: Surface) => void;
  onInvite: () => void;
  onPair: () => void;
  canManageAccess: boolean;
  canPairDesktop: boolean;
}) {
  const setup = [
    {
      label: "Owner identity verified",
      detail: "ChatGPT sign-in is required for every admin session.",
      done: true,
      action: () => setSurface("security"),
    },
    {
      label: "Desktop paired",
      detail: "Connect the Mac that executes terminals and agent runs.",
      done: snapshot.devices.length > 0,
      action: canPairDesktop ? onPair : () => setSurface("devices"),
    },
    {
      label: "First teammate invited",
      detail: "Issue a seven-day, email-bound workspace invitation.",
      done: snapshot.members.length > 1 || snapshot.pendingInvites.length > 0,
      action: canManageAccess ? onInvite : () => setSurface("access"),
    },
    {
      label: "Agent policy configured",
      detail: "Assign a harness, model, effort, role, and owner.",
      done: snapshot.agents.length > 0,
      action: () => setSurface("agents"),
    },
  ];
  const completed = setup.filter((item) => item.done).length;
  return (
    <div className="today-grid admin-overview">
      <section className="brief-card lead-card">
        <div className="card-head">
          <div>
            <span className="section-index">01</span>
            <h2>Control plane</h2>
          </div>
          <span className="live-mark">
            <i />
            authenticated
          </span>
        </div>
        <div className="metric-row">
          <button type="button" onClick={() => setSurface("access")}>
            <strong>{snapshot.members.length}</strong>
            <span>members</span>
            <small>{snapshot.pendingInvites.length} pending</small>
          </button>
          <button type="button" onClick={() => setSurface("agents")}>
            <strong>{snapshot.agents.length}</strong>
            <span>agents</span>
            <small>{snapshot.teams.length} teams</small>
          </button>
          <button type="button" onClick={() => setSurface("devices")}>
            <strong>{snapshot.devices.length}</strong>
            <span>desktops</span>
            <small>{snapshot.desktopSnapshots.length} reporting</small>
          </button>
          <button type="button" onClick={() => setSurface("security")}>
            <strong>{snapshot.connections.length}</strong>
            <span>connections</span>
            <small>server authorized</small>
          </button>
        </div>
        <div className="admin-boundary">
          <span className="section-index">SYSTEM BOUNDARY</span>
          <h3>The desktop operates. This panel administers.</h3>
          <p>
            Messages, projects, terminals, the browser, repositories, and live
            agent processes stay in Spaces desktop. The web panel controls identity,
            invitations, agent policy, teams, connections, and trusted machines.
          </p>
          <div>
            <button className="quiet-button" type="button" onClick={() => setSurface("devices")}>
              Inspect desktops
            </button>
            {canManageAccess && (
              <button className="primary-button" type="button" onClick={onInvite}>
                Invite teammate
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="brief-card">
        <div className="card-head">
          <div>
            <span className="section-index">02</span>
            <h2>Admin readiness</h2>
          </div>
          <span className="completion">{completed}/{setup.length}</span>
        </div>
        <div className="progress-track">
          <span style={{ width: `${(completed / setup.length) * 100}%` }} />
        </div>
        <div className="check-list">
          {setup.map((item) => (
            <button key={item.label} type="button" onClick={item.action}>
              <span className={`check ${item.done ? "done" : ""}`}>
                {item.done ? "✓" : ""}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <b>›</b>
            </button>
          ))}
        </div>
      </section>

      <section className="brief-card activity-card">
        <div className="card-head">
          <div>
            <span className="section-index">03</span>
            <h2>Administrative activity</h2>
          </div>
          <span className="completion">latest</span>
        </div>
        <div className="activity-list">
          {snapshot.activity.slice(0, 8).map((item) => (
            <div key={item.id}>
              <span className="activity-initial">{initials(item.actorName)}</span>
              <span>
                <strong>{item.summary}</strong>
                <small>{item.actorName} · {titleCase(item.kind)}</small>
              </span>
              <time>{relative(item.createdAt)}</time>
            </div>
          ))}
          {!snapshot.activity.length && (
            <div className="quiet-empty">No administrative changes yet.</div>
          )}
        </div>
      </section>

      <section className="brief-card admin-status-card">
        <div className="card-head">
          <div>
            <span className="section-index">04</span>
            <h2>Trust status</h2>
          </div>
          <span className="live-mark">
            <i />
            enforced
          </span>
        </div>
        <dl className="admin-status-list">
          <div>
            <dt>Browser admins</dt>
            <dd>ChatGPT identity + workspace membership</dd>
          </div>
          <div>
            <dt>Desktop bootstrap</dt>
            <dd>Single-use code · 15 minute expiry</dd>
          </div>
          <div>
            <dt>Desktop sync</dt>
            <dd>Per-device token · changed shared records only</dd>
          </div>
          <div>
            <dt>Local-only data</dt>
            <dd>Code, full transcripts, terminal output, browser state</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function AccessAdminSurface({
  snapshot,
  onInvite,
  working,
  onRoleChange,
  onRemove,
}: {
  snapshot: WorkspaceSnapshot;
  onInvite: () => void;
  working: boolean;
  onRoleChange: (
    memberId: string,
    role: "admin" | "member" | "guest",
  ) => Promise<Record<string, unknown>>;
  onRemove: (memberId: string) => Promise<Record<string, unknown>>;
}) {
  const actorRole = snapshot.workspace.role;
  const canInvite = actorRole === "owner" || actorRole === "admin";

  return (
    <div className="people-surface">
      <section className="admin-callout">
        <div>
          <span className="eyebrow">Access administration</span>
          <h2>Membership is explicit and email-bound.</h2>
          <p>
            ChatGPT sign-in establishes identity. Spaces membership determines
            authorization. Invitations expire after seven days and can only be
            accepted by the invited email address.
          </p>
        </div>
        {canInvite && (
          <button className="primary-button" type="button" onClick={onInvite}>
            Invite teammate
          </button>
        )}
      </section>
      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">01</span>
            <h2>Workspace members</h2>
          </div>
          <span>{snapshot.members.length} active</span>
        </div>
        <div className="people-grid">
          {snapshot.members.map((member) => {
            const canChangeRole =
              member.id !== snapshot.currentUser.id &&
              member.role !== "owner" &&
              (actorRole === "owner" ||
                (actorRole === "admin" && member.role !== "admin"));
            const canRemove =
              actorRole === "owner" &&
              member.id !== snapshot.currentUser.id &&
              member.role !== "owner";
            return (
              <article key={member.id}>
                <span className="large-avatar">{initials(member.name)}</span>
                <div>
                  <h3>{member.name}</h3>
                  <p>{member.email}</p>
                  {canChangeRole ? (
                    <label className="member-role-control">
                      <span>Role</span>
                      <select
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        disabled={working}
                        onChange={(event) => {
                          void onRoleChange(
                            member.id,
                            event.target.value as "admin" | "member" | "guest",
                          ).catch(() => undefined);
                        }}
                      >
                        {actorRole === "owner" && (
                          <option value="admin">Admin</option>
                        )}
                        <option value="member">Member</option>
                        <option value="guest">Guest</option>
                      </select>
                    </label>
                  ) : (
                    <span className="role-chip">
                      {member.role}
                      {member.role === "owner" ? " · protected" : ""}
                    </span>
                  )}
                  {canRemove && (
                    <button
                      className="text-button danger-text"
                      type="button"
                      disabled={working}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove ${member.name} from this workspace? Their agents, paired desktops, private calendars, and personal connections will also be removed.`,
                          )
                        ) {
                          return;
                        }
                        void onRemove(member.id).catch(() => undefined);
                      }}
                    >
                      Remove from workspace
                    </button>
                  )}
                </div>
                <time>Joined {relative(member.joinedAt)}</time>
              </article>
            );
          })}
        </div>
      </section>
      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">02</span>
            <h2>Pending invitations</h2>
          </div>
          <span>{snapshot.pendingInvites.length} open</span>
        </div>
        <div className="people-grid">
          {snapshot.pendingInvites.map((invite) => (
            <article key={invite.id} className="pending">
              <span className="large-avatar">…</span>
              <div>
                <h3>{invite.email}</h3>
                <p>Waiting for ChatGPT sign-in</p>
                <span className="role-chip">{invite.role}</span>
              </div>
              <time>Expires {relative(invite.expiresAt)}</time>
            </article>
          ))}
          {!snapshot.pendingInvites.length && (
            <EmptyState
              index="00"
              title="No invitations pending"
              detail="Invite links appear here until they are accepted or expire."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function AgentAdminSurface({
  snapshot,
  onAgent,
  onTeam,
}: {
  snapshot: WorkspaceSnapshot;
  onAgent: () => void;
  onTeam: () => void;
}) {
  return (
    <div className="people-surface">
      <section className="admin-callout">
        <div>
          <span className="eyebrow">Agent policy</span>
          <h2>Configure here. Execute and inspect on desktop.</h2>
          <p>
            Agent roles, ownership, runtime, model, and reasoning effort belong
            to the workspace policy. Terminals, raw process output, and full
            transcripts remain locally inspectable in Spaces desktop. A
            prompt and final answer cross the control plane only for an
            explicitly cross-device run.
          </p>
        </div>
        <div className="admin-callout-actions">
          <button className="quiet-button" type="button" onClick={onTeam}>New team</button>
          <button className="primary-button" type="button" onClick={onAgent}>New agent</button>
        </div>
      </section>
      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">01</span>
            <h2>Agent policies</h2>
          </div>
          <span>{snapshot.agents.length} configured</span>
        </div>
        <div className="agent-grid">
          {snapshot.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} snapshot={snapshot} />
          ))}
          {!snapshot.agents.length && (
            <EmptyState
              index="AI"
              title="Add the first agent"
              detail="Assign a role, ownership, harness, model, and reasoning effort."
            />
          )}
        </div>
      </section>
      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">02</span>
            <h2>Teams</h2>
          </div>
          <span>{snapshot.teams.length} configured</span>
        </div>
        <div className="team-grid">
          {snapshot.teams.map((team) => (
            <article key={team.id}>
              <span className="team-mark">{initials(team.name)}</span>
              <div>
                <h3>{team.name}</h3>
                <p>{team.purpose || "No charter yet"}</p>
                <small>{team.people} people · {team.agents} agents</small>
              </div>
            </article>
          ))}
          {!snapshot.teams.length && (
            <EmptyState
              index="TM"
              title="No teams configured"
              detail="Group people and agents under a shared purpose."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function SecurityAdminSurface({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const controls = [
    {
      index: "01",
      title: "Admin identity",
      state: "Enforced",
      detail: "Every browser session must complete ChatGPT sign-in. Server routes use the forwarded identity and never trust client-supplied email.",
    },
    {
      index: "02",
      title: "Workspace authorization",
      state: "Enforced",
      detail: "Membership and roles are checked server-side. Sign-in alone does not grant access to a workspace.",
    },
    {
      index: "03",
      title: "Desktop enrollment",
      state: "Single use",
      detail: "Every member can create an eight-character code for their own desktop. It expires after 15 minutes and cannot be claimed twice.",
    },
    {
      index: "04",
      title: "Device synchronization",
      state: "Token bound",
      detail: "Each paired desktop receives a random device token. Roster, projects, agent configuration, explicitly shared documents and vault pages, permission-aware calendars, presence, and privacy-safe live-run summaries sync through the workspace.",
    },
    {
      index: "05",
      title: "Local execution",
      state: "Private",
      detail: "Repository contents, full transcripts, terminal output, and browser history are not published. Cross-device agent runs persist only the requested prompt and final result in the control plane.",
    },
  ];
  return (
    <div className="security-grid">
      {controls.map((control) => (
        <article key={control.index}>
          <header>
            <span className="section-index">{control.index}</span>
            <span className="state-chip">{control.state}</span>
          </header>
          <h2>{control.title}</h2>
          <p>{control.detail}</p>
        </article>
      ))}
      <article className="security-summary">
        <header>
          <span className="section-index">CURRENT TRUSTED SURFACES</span>
          <span className="state-chip">{snapshot.devices.length} desktops</span>
        </header>
        <h2>{snapshot.members.length} authorized people</h2>
        <p>
          {snapshot.pendingInvites.length} pending invitation
          {snapshot.pendingInvites.length === 1 ? "" : "s"} and{" "}
          {snapshot.devices.length} paired desktop
          {snapshot.devices.length === 1 ? "" : "s"} are currently recorded.
        </p>
      </article>
    </div>
  );
}

function TodaySurface({
  snapshot,
  setSurface,
}: {
  snapshot: WorkspaceSnapshot;
  setSurface: (surface: Surface) => void;
}) {
  const openIssues = snapshot.issues.filter((issue) => issue.status !== "done");
  const urgent = openIssues.filter(
    (issue) => issue.priority === "urgent" || issue.priority === "high",
  );
  const newInbox = snapshot.inbox.filter((item) => item.status === "new");
  const activeRuns = snapshot.desktopSnapshots.flatMap((desktop) =>
    (desktop.payload.activeRuns ?? []).map((run) => ({
      ...run,
      device: desktop.deviceName,
    })),
  );
  const onboarding = [
    {
      label: "Workspace created",
      done: true,
      detail: "Your durable company space is live.",
    },
    {
      label: "Desktop paired",
      done: snapshot.devices.length > 0,
      detail: "Stream local projects and agent runs into Spaces.",
      action: "connections" as Surface,
    },
    {
      label: "Teammate invited",
      done: snapshot.members.length > 1 || snapshot.pendingInvites.length > 0,
      detail: "Share messages, work, inbox, and knowledge.",
      action: "people" as Surface,
    },
    {
      label: "First decision recorded",
      done: snapshot.decisions.length > 0,
      detail: "Make important reasoning durable.",
      action: "knowledge" as Surface,
    },
  ];
  const completed = onboarding.filter((item) => item.done).length;

  return (
    <div className="today-grid">
      <section className="brief-card lead-card">
        <div className="card-head">
          <div>
            <span className="section-index">01</span>
            <h2>Founder queue</h2>
          </div>
          <span className="live-mark">
            <i />
            live
          </span>
        </div>
        <div className="metric-row">
          <button type="button" onClick={() => setSurface("work")}>
            <strong>{openIssues.length}</strong>
            <span>open issues</span>
            <small>{urgent.length} high signal</small>
          </button>
          <button type="button" onClick={() => setSurface("inbox")}>
            <strong>{newInbox.length}</strong>
            <span>new in inbox</span>
            <small>{snapshot.inbox.filter((item) => item.status === "waiting").length} waiting</small>
          </button>
          <button type="button" onClick={() => setSurface("messages")}>
            <strong>{snapshot.channels.length}</strong>
            <span>channels</span>
            <small>{snapshot.messages.length} messages</small>
          </button>
          <button type="button" onClick={() => setSurface("connections")}>
            <strong>{activeRuns.length}</strong>
            <span>agents running</span>
            <small>{snapshot.devices.length} desktop{snapshot.devices.length === 1 ? "" : "s"}</small>
          </button>
        </div>
        <div className="attention-list">
          <div className="list-label">Needs attention</div>
          {urgent.slice(0, 4).map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => setSurface("work")}
              className="attention-row"
            >
              <span className={`priority-mark ${issue.priority}`} />
              <span>
                <strong>{issue.title}</strong>
                <small>
                  {titleCase(issue.status)} · {issue.assigneeName || "Unassigned"}
                </small>
              </span>
              <time>{relative(issue.updatedAt)}</time>
            </button>
          ))}
          {!urgent.length && (
            <div className="quiet-empty">
              Nothing urgent. The operating queue is clear.
            </div>
          )}
        </div>
      </section>

      <section className="brief-card">
        <div className="card-head">
          <div>
            <span className="section-index">02</span>
            <h2>Spaces setup</h2>
          </div>
          <span className="completion">{completed}/{onboarding.length}</span>
        </div>
        <div className="progress-track" aria-label={`${completed} of ${onboarding.length} complete`}>
          <span style={{ width: `${(completed / onboarding.length) * 100}%` }} />
        </div>
        <div className="check-list">
          {onboarding.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.done || !item.action}
              onClick={() => item.action && setSurface(item.action)}
            >
              <span className={item.done ? "check done" : "check"}>
                {item.done ? "✓" : ""}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              {!item.done && item.action && <b>→</b>}
            </button>
          ))}
        </div>
      </section>

      <section className="brief-card activity-card">
        <div className="card-head">
          <div>
            <span className="section-index">03</span>
            <h2>Live organization</h2>
          </div>
          <button type="button" className="text-button" onClick={() => setSurface("people")}>
            Open roster
          </button>
        </div>
        {activeRuns.length > 0 && (
          <div className="live-runs">
            {activeRuns.slice(0, 3).map((run) => (
              <div key={run.id}>
                <span className="run-pulse" />
                <span>
                  <strong>{run.agent}</strong>
                  <small>
                    #{run.channel} · {run.device}
                  </small>
                </span>
                <time>{relative(run.startedAt)}</time>
              </div>
            ))}
          </div>
        )}
        <div className="activity-list">
          {snapshot.activity.slice(0, 7).map((item) => (
            <div key={item.id}>
              <span className="activity-initial">{initials(item.actorName)}</span>
              <span>
                <strong>{item.summary}</strong>
                <small>{item.actorName}</small>
              </span>
              <time>{relative(item.createdAt)}</time>
            </div>
          ))}
          {!snapshot.activity.length && (
            <div className="quiet-empty">Activity will appear as your Spaces moves.</div>
          )}
        </div>
      </section>

      <section className="brief-card project-card">
        <div className="card-head">
          <div>
            <span className="section-index">04</span>
            <h2>Projects</h2>
          </div>
          <button type="button" className="text-button" onClick={() => setSurface("work")}>
            Open work
          </button>
        </div>
        <div className="project-stack">
          {snapshot.projects.slice(0, 4).map((project) => {
            const total = project.openIssues + project.completedIssues;
            const percent = total ? Math.round((project.completedIssues / total) * 100) : 0;
            return (
              <button key={project.id} type="button" onClick={() => setSurface("work")}>
                <span className="project-monogram">{initials(project.name)}</span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.summary}</small>
                  <i>
                    <b style={{ width: `${percent}%` }} />
                  </i>
                </span>
                <em>{project.openIssues} open</em>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function MessagesSurface({
  snapshot,
  working,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  working: boolean;
  mutate: (
    input: Record<string, unknown>,
    success: string,
  ) => Promise<Record<string, unknown>>;
}) {
  const [channelId, setChannelId] = useState(snapshot.channels[0]?.id ?? "");
  const [body, setBody] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [pendingMessages, setPendingMessages] = useState<Message[]>([]);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const effectiveChannelId = snapshot.channels.some(
    (candidate) => candidate.id === channelId,
  )
    ? channelId
    : snapshot.channels[0]?.id ?? "";
  const channel =
    snapshot.channels.find((candidate) => candidate.id === effectiveChannelId) ??
    snapshot.channels[0];
  const canManage =
    snapshot.workspace.role === "owner" || snapshot.workspace.role === "admin";
  const messages = channel
    ? [
        ...snapshot.messages.filter((message) => message.channelId === channel.id),
        ...pendingMessages.filter((message) => message.channelId === channel.id),
      ]
    : [];
  const mentionOptions =
    mentionQuery === null
      ? []
      : [
          ...snapshot.members
            .filter((member) => member.id !== snapshot.currentUser.id)
            .map((member) => ({
              handle: mentionHandle(member.name),
              label: member.name,
              kind: "person",
            })),
          ...snapshot.agents.map((agent) => ({
            handle: mentionHandle(agent.name),
            label: agent.name,
            kind: "agent",
          })),
          ...snapshot.teams.map((team) => ({
            handle: mentionHandle(team.name),
            label: team.name,
            kind: "team",
          })),
        ]
          .filter((option) => option.handle.startsWith(mentionQuery))
          .filter(
            (option, index, options) =>
              options.findIndex((candidate) => candidate.handle === option.handle) === index,
          )
          .slice(0, 8);

  function insertMention(handle: string) {
    const textarea = composerRef.current;
    const caret = textarea?.selectionStart ?? body.length;
    const before = body
      .slice(0, caret)
      .replace(/@([a-z0-9-]*)$/i, `@${handle} `);
    const next = before + body.slice(caret);
    setBody(next);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(before.length, before.length);
    });
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stream = streamRef.current;
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [channel?.id, messages.length]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const messageBody = body.trim();
    if (!channel || !messageBody || working) return;
    const optimisticId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticMessage: Message = {
      id: optimisticId,
      channelId: channel.id,
      authorType: "user",
      authorId: snapshot.currentUser.id ?? snapshot.currentUser.email,
      authorName: snapshot.currentUser.name,
      body: messageBody,
      parentId: "",
      status: "done",
      meta: "",
      runId: "",
      createdAt: new Date().toISOString(),
    };
    setPendingMessages((current) => [...current, optimisticMessage]);
    setBody("");
    setMentionQuery(null);
    try {
      await mutate(
        { action: "send_message", channelId: channel.id, body: messageBody },
        `Message sent to #${channel.name}.`,
      );
      setPendingMessages((current) =>
        current.filter((message) => message.id !== optimisticId),
      );
    } catch {
      setPendingMessages((current) =>
        current.filter((message) => message.id !== optimisticId),
      );
      setBody((current) => current || messageBody);
    }
  }

  return (
    <div className="messages-layout">
      <aside className="channel-list">
        <div className="surface-subhead">
          <span>Channels</span>
          <small>{snapshot.channels.length}</small>
        </div>
        {snapshot.channels.map((item) => (
          <button
            type="button"
            key={item.id}
            className={channel?.id === item.id ? "active" : ""}
            onClick={() => setChannelId(item.id)}
          >
            <span>#</span>
            <span>
              <strong>{item.name}</strong>
              <small>{item.topic || "No topic yet"}</small>
            </span>
          </button>
        ))}
      </aside>
      <section className="conversation">
        {channel ? (
          <>
            <header className="conversation-head">
              <div>
                <span>#</span>
                <div>
                  <h2>{channel.name}</h2>
                  <p>{channel.topic || "Shared team and agent context"}</p>
                </div>
              </div>
              <div className="conversation-actions">
                <span className="mode-chip">{channel.mode}</span>
                {canManage && (
                  <button
                    type="button"
                    className="quiet-button danger-button compact"
                    disabled={working}
                    onClick={() => {
                      const count = snapshot.messages.filter(
                        (message) => message.channelId === channel.id,
                      ).length;
                      if (
                        window.confirm(
                          `Delete #${channel.name} and ${count} message${count === 1 ? "" : "s"}? This cannot be undone.`,
                        )
                      ) {
                        void mutate(
                          { action: "delete_channel", channelId: channel.id },
                          `Deleted #${channel.name}.`,
                        );
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </header>
            <div className="message-stream" ref={streamRef} aria-live="polite">
              {messages.map((message, index) => {
                const prior = messages[index - 1];
                const pending = message.id.startsWith("pending-");
                const grouped =
                  prior?.authorId === message.authorId &&
                  Date.parse(message.createdAt) - Date.parse(prior.createdAt) < 300_000;
                return (
                  <article
                    key={message.id}
                    className={`message ${grouped ? "grouped" : ""} ${pending ? "pending" : ""}`}
                  >
                    {!grouped && (
                      <span className={`message-avatar ${message.authorType}`}>
                        {initials(message.authorName)}
                      </span>
                    )}
                    <div>
                      {!grouped && (
                        <header>
                          <strong>{message.authorName}</strong>
                          {message.authorType === "agent" && <b>agent</b>}
                          <time>{pending ? "sending…" : relative(message.createdAt)}</time>
                        </header>
                      )}
                      <p>{message.body}</p>
                    </div>
                  </article>
                );
              })}
              {!messages.length && (
                <EmptyState
                  index="#"
                  title={`Start #${channel.name}`}
                  detail="A channel keeps human decisions and agent work in one durable thread."
                />
              )}
            </div>
            <form
              className="message-composer"
              aria-busy={working}
              onSubmit={(event) => void submit(event)}
            >
              {!!mentionOptions.length && (
                <div className="message-mentions" role="listbox" aria-label="People, agents, and teams">
                  {mentionOptions.map((option) => (
                    <button
                      key={`${option.kind}-${option.handle}`}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertMention(option.handle)}
                    >
                      <strong>@{option.handle}</strong>
                      <span>{option.label}</span>
                      <small>{option.kind}</small>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                value={body}
                onChange={(event) => {
                  const next = event.target.value;
                  const caret = event.target.selectionStart;
                  setBody(next);
                  setMentionQuery(
                    next.slice(0, caret).match(/(?:^|\s)@([a-z0-9-]*)$/i)?.[1].toLowerCase() ??
                      null,
                  );
                }}
                placeholder={`Message #${channel.name} — @mention people, teams, or agents`}
                aria-label={`Message #${channel.name}`}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div>
                <small>Shift + return for a new line</small>
                <button
                  className="primary-button compact"
                  type="submit"
                  disabled={working || !body.trim()}
                >
                  Send
                </button>
              </div>
            </form>
          </>
        ) : (
          <EmptyState
            index="#"
            title="Create the first channel"
            detail="Give every conversation a durable home."
          />
        )}
      </section>
    </div>
  );
}

function WorkSurface({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: (
    input: Record<string, unknown>,
    success: string,
  ) => Promise<Record<string, unknown>>;
}) {
  const [projectId, setProjectId] = useState("all");
  const effectiveProjectId =
    projectId === "all" || snapshot.projects.some((project) => project.id === projectId)
      ? projectId
      : "all";
  const canManage =
    snapshot.workspace.role === "owner" || snapshot.workspace.role === "admin";
  const selectedProject = snapshot.projects.find(
    (project) => project.id === effectiveProjectId,
  );
  const issues =
    effectiveProjectId === "all"
      ? snapshot.issues
      : snapshot.issues.filter((issue) => issue.projectId === effectiveProjectId);

  async function move(issueId: string, status: IssueStatus) {
    await mutate(
      { action: "move_issue", issueId, status },
      `Issue moved to ${titleCase(status)}.`,
    );
  }

  return (
    <div className="work-surface">
      <div className="work-toolbar">
        <div className="project-tabs">
          <button
            type="button"
            className={effectiveProjectId === "all" ? "active" : ""}
            onClick={() => setProjectId("all")}
          >
            All work
          </button>
          {snapshot.projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={effectiveProjectId === project.id ? "active" : ""}
              onClick={() => setProjectId(project.id)}
            >
              {project.name}
            </button>
          ))}
        </div>
        <div className="work-summary">
          <span>{issues.filter((issue) => issue.status !== "done").length} open</span>
          <span>{issues.filter((issue) => issue.status === "done").length} done</span>
          {canManage && selectedProject && (
            <button
              type="button"
              className="quiet-button danger-button compact"
              onClick={() => {
                const count = snapshot.issues.filter(
                  (issue) => issue.projectId === selectedProject.id,
                ).length;
                if (
                  window.confirm(
                    `Delete ${selectedProject.name}? ${count} issue${count === 1 ? "" : "s"} will be kept and moved to unassigned work. Linked social accounts will be detached. This cannot be undone.`,
                  )
                ) {
                  void mutate(
                    { action: "delete_project", projectId: selectedProject.id },
                    `Deleted ${selectedProject.name}.`,
                  );
                }
              }}
            >
              Remove project
            </button>
          )}
        </div>
      </div>
      <div className="issue-board">
        {STATUS_COLUMNS.map((column) => {
          const columnIssues = issues.filter((issue) => issue.status === column.id);
          return (
            <section
              key={column.id}
              className="issue-column"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const issueId = event.dataTransfer.getData("text/hq-issue");
                if (issueId) void move(issueId, column.id);
              }}
            >
              <header>
                <span>{column.short}</span>
                <strong>{column.label}</strong>
                <small>{columnIssues.length}</small>
              </header>
              <div className="issue-stack">
                {columnIssues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    projects={snapshot.projects}
                    onMove={(status) => void move(issue.id, status)}
                  />
                ))}
                {!columnIssues.length && (
                  <div className="column-empty">Drop work here</div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  projects,
  onMove,
}: {
  issue: Issue;
  projects: WorkspaceSnapshot["projects"];
  onMove: (status: IssueStatus) => void;
}) {
  const statusIndex = STATUS_COLUMNS.findIndex((column) => column.id === issue.status);
  const project = projects.find((candidate) => candidate.id === issue.projectId);
  return (
    <article
      className="issue-card"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/hq-issue", issue.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="issue-card-top">
        <span className={`priority-pill ${issue.priority}`}>
          {issue.priority === "normal" ? "—" : issue.priority.slice(0, 1).toUpperCase()}
        </span>
        <small>{project?.name || "Spaces"}</small>
        <time>{relative(issue.updatedAt)}</time>
      </div>
      <h3>{issue.title}</h3>
      {issue.description && <p>{issue.description}</p>}
      <footer>
        <span className="mini-avatar" title={issue.assigneeName || "Unassigned"}>
          {issue.assigneeName ? initials(issue.assigneeName) : "—"}
        </span>
        <div className="issue-move">
          <button
            type="button"
            disabled={statusIndex <= 0}
            aria-label="Move issue left"
            onClick={() => onMove(STATUS_COLUMNS[statusIndex - 1]?.id ?? issue.status)}
          >
            ←
          </button>
          <button
            type="button"
            disabled={statusIndex >= STATUS_COLUMNS.length - 1}
            aria-label="Move issue right"
            onClick={() => onMove(STATUS_COLUMNS[statusIndex + 1]?.id ?? issue.status)}
          >
            →
          </button>
        </div>
      </footer>
    </article>
  );
}

function InboxSurface({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: (
    input: Record<string, unknown>,
    success: string,
  ) => Promise<Record<string, unknown>>;
}) {
  const [filter, setFilter] = useState<"open" | InboxItem["status"]>("open");
  const [selected, setSelected] = useState(snapshot.inbox[0]?.id ?? "");
  const items = snapshot.inbox.filter((item) =>
    filter === "open" ? item.status !== "done" : item.status === filter,
  );
  const current =
    items.find((item) => item.id === selected) ??
    snapshot.inbox.find((item) => item.id === selected) ??
    items[0];

  async function setStatus(status: InboxItem["status"]) {
    if (!current) return;
    await mutate(
      { action: "update_inbox", inboxId: current.id, status },
      `Inbox item marked ${status}.`,
    );
  }

  return (
    <div className="inbox-layout">
      <aside className="inbox-queue">
        <div className="filter-tabs">
          {(["open", "new", "triaged", "waiting", "done"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {titleCase(value)}
            </button>
          ))}
        </div>
        <div className="inbox-items">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={current?.id === item.id ? "active" : ""}
              onClick={() => setSelected(item.id)}
            >
              <span className={`inbox-state ${item.status}`} />
              <span>
                <strong>{item.subject}</strong>
                <small>
                  {item.senderName} · {item.body.slice(0, 90) || "No detail"}
                </small>
              </span>
              <time>{relative(item.updatedAt)}</time>
            </button>
          ))}
          {!items.length && (
            <EmptyState
              index="00"
              title="Queue clear"
              detail="Nothing is waiting in this view."
            />
          )}
        </div>
      </aside>
      <section className="inbox-reader">
        {current ? (
          <>
            <header>
              <div>
                <span className={`state-chip ${current.status}`}>{current.status}</span>
                <time>{new Date(current.createdAt).toLocaleString()}</time>
              </div>
              <h2>{current.subject}</h2>
              <p>
                From {current.senderName} · {current.senderAddress}
              </p>
            </header>
            <div className="inbox-body">{current.body || "No additional detail."}</div>
            {current.labels.length > 0 && (
              <div className="tag-row">
                {current.labels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            )}
            <footer>
              <button
                className="quiet-button"
                type="button"
                onClick={() => void setStatus("waiting")}
              >
                Waiting
              </button>
              <button
                className="quiet-button"
                type="button"
                onClick={() => void setStatus("triaged")}
              >
                Triaged
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void setStatus("done")}
              >
                Done
              </button>
            </footer>
          </>
        ) : (
          <EmptyState
            index="IN"
            title="A native shared inbox"
            detail="Capture mail, requests, forms, and loose ends here, then assign or convert them into work."
          />
        )}
      </section>
    </div>
  );
}

function knowledgeSource(page: KnowledgePage): {
  id: string;
  label: string;
} {
  if (page.sourceType === "vault") {
    return {
      id:
        page.sourceCollectionId ||
        `${page.sourceDeviceId}:${page.sourceLabel || "vault"}`,
      label: page.sourceLabel || "Shared vault",
    };
  }
  if (page.sourceType === "document") {
    return {
      id: `documents:${page.sourceDeviceId || page.ownerUserId}`,
      label: page.sourceLabel || "Shared documents",
    };
  }
  return { id: "workspace", label: "Workspace knowledge" };
}

function folderFromKnowledgePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function PortalKnowledgeTree({
  nodes,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  nodes: KnowledgeTreeNode<KnowledgePage>[];
  selectedId: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  function render(
    items: KnowledgeTreeNode<KnowledgePage>[],
    depth: number,
  ): ReactNode {
    return items.map((node) => {
      if (node.kind === "note") {
        return (
          <li key={node.id}>
            <button
              type="button"
              className={`knowledge-tree-row note${node.value.id === selectedId ? " active" : ""}`}
              style={{ "--tree-depth": depth } as CSSProperties}
              title={node.path}
              onClick={() => onSelect(node.value.id)}
            >
              <span aria-hidden="true">·</span>
              <span>{node.name}</span>
            </button>
          </li>
        );
      }
      const stateId = depth === 0 ? `closed:${node.id}` : node.id;
      const open = depth === 0
        ? !expanded.has(stateId)
        : expanded.has(stateId);
      return (
        <li key={node.id}>
          <button
            type="button"
            className="knowledge-tree-row folder"
            style={{ "--tree-depth": depth } as CSSProperties}
            aria-expanded={open}
            onClick={() => onToggle(stateId)}
          >
            <span aria-hidden="true">{open ? "⌄" : "›"}</span>
            <span aria-hidden="true">▱</span>
            <strong>{node.name}</strong>
            <small>{node.children.length}</small>
          </button>
          {open && node.children.length > 0 && (
            <ul>{render(node.children, depth + 1)}</ul>
          )}
        </li>
      );
    });
  }

  return (
    <ul className="knowledge-tree" aria-label="Knowledge folders">
      {render(nodes, 0)}
    </ul>
  );
}

function KnowledgeSurface({
  snapshot,
  working,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  working: boolean;
  mutate: (
    input: Record<string, unknown>,
    success: string,
  ) => Promise<Record<string, unknown>>;
}) {
  const [selected, setSelected] = useState(snapshot.knowledgePages[0]?.id ?? "");
  const [filter, setFilter] = useState("");
  const [editingPageId, setEditingPageId] = useState("");
  const storageKey = `spaces.knowledge.expanded.${snapshot.workspace.id}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return new Set(
        Array.isArray(stored)
          ? stored.filter((value) => typeof value === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });

  const pages = snapshot.knowledgePages.filter((page) =>
    `${page.title} ${page.path} ${page.body} ${page.tags.join(" ")}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const current =
    pages.find((page) => page.id === selected) ??
    snapshot.knowledgePages.find((page) => page.id === selected) ??
    pages[0];
  const tree = useMemo(
    () =>
      buildKnowledgeTree(
        snapshot.knowledgePages.map((page) => {
          const source = knowledgeSource(page);
          return {
            id: page.id,
            sourceId: source.id,
            sourceLabel: source.label,
            path: page.path || `${page.title}.md`,
            title: page.title,
            value: page,
          };
        }),
      ),
    [snapshot.knowledgePages],
  );

  function toggleFolder(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // The tree remains usable if browser storage is unavailable.
      }
      return next;
    });
  }

  async function savePage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const form = new FormData(event.currentTarget);
    await mutate(
      {
        action: "update_knowledge",
        pageId: current.id,
        title: formValue(form, "title"),
        folder: formValue(form, "folder"),
        kind: formValue(form, "kind"),
        tags: formValue(form, "tags"),
        body: formValue(form, "body"),
      },
      "Knowledge page updated.",
    );
    setEditingPageId("");
  }

  return (
    <div className="knowledge-layout">
      <aside className="knowledge-index">
        <div className="knowledge-search">
          <span>⌕</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a page"
            aria-label="Find a knowledge page"
          />
        </div>
        <div className="surface-subhead">
          <span>{filter.trim() ? "Matches" : "Vaults"}</span>
          <small>{snapshot.knowledgePages.length}</small>
        </div>
        {filter.trim() ? (
          pages.map((page) => (
            <KnowledgeIndexRow
              key={page.id}
              page={page}
              active={current?.id === page.id}
              onClick={() => setSelected(page.id)}
            />
          ))
        ) : (
          <PortalKnowledgeTree
            nodes={tree}
            selectedId={current?.id ?? ""}
            expanded={expanded}
            onToggle={toggleFolder}
            onSelect={setSelected}
          />
        )}
      </aside>
      <section className="knowledge-page">
        {current ? (
          <>
            <header>
              <div className="knowledge-page-actions">
                <span className="page-kind">
                  {current.sourceType === "vault" ? "vault file" : current.kind}
                </span>
                {current.sourceType === "portal" &&
                  current.access === "write" && (
                    <button
                      type="button"
                      className="quiet-button compact"
                      onClick={() =>
                        setEditingPageId((value) =>
                          value === current.id ? "" : current.id,
                        )
                      }
                    >
                      {editingPageId === current.id ? "Close editor" : "Edit note"}
                    </button>
                  )}
              </div>
              <h2>{current.title}</h2>
              <div>
                <time>Updated {relative(current.updatedAt)}</time>
                <span>{current.backlinkCount} backlinks</span>
                <span>{current.access === "write" ? "editable" : "read only"}</span>
              </div>
            </header>
            {(current.sourceLabel || current.path) && (
              <div className="knowledge-origin">
                <span>{current.sourceLabel || "Shared knowledge"}</span>
                {current.path && <code>{current.path}</code>}
              </div>
            )}
            {editingPageId === current.id ? (
              <form
                className="knowledge-editor"
                key={current.id}
                onSubmit={(event) => void savePage(event)}
              >
                <Field label="Title" required wide>
                  <input
                    name="title"
                    defaultValue={current.title}
                    required
                  />
                </Field>
                <Field
                  label="Folder"
                  hint="Use / for nested folders, like Company/Runbooks."
                  wide
                >
                  <input
                    name="folder"
                    defaultValue={folderFromKnowledgePath(current.path)}
                    placeholder="Company/Operations"
                  />
                </Field>
                <Field label="Kind">
                  <select name="kind" defaultValue={current.kind}>
                    <option value="note">Note</option>
                    <option value="brief">Brief</option>
                    <option value="runbook">Runbook</option>
                    <option value="charter">Charter</option>
                    <option value="research">Research</option>
                  </select>
                </Field>
                <Field label="Tags">
                  <input name="tags" defaultValue={current.tags.join(", ")} />
                </Field>
                <Field label="Body" wide>
                  <textarea
                    name="body"
                    defaultValue={current.body}
                    rows={16}
                  />
                </Field>
                <footer>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => setEditingPageId("")}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={working}
                  >
                    {working ? "Saving…" : "Save note"}
                  </button>
                </footer>
              </form>
            ) : (
              <>
                <div className="knowledge-prose">
                  {current.body.split(/\n{2,}/).map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
                </div>
                <footer className="tag-row">
                  {current.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </footer>
              </>
            )}
          </>
        ) : (
          <EmptyState
            index="KN"
            title="Build the company memory"
            detail="Write notes, decisions, runbooks, research, and charters that people and agents can actually find."
          />
        )}
      </section>
      <aside className="decision-rail">
        <div className="surface-subhead">
          <span>Linked mentions</span>
          <small>{current?.backlinks.length ?? 0}</small>
        </div>
        <div className="knowledge-backlinks">
          {current?.backlinks.map((backlink) => (
            <button
              type="button"
              key={backlink.id}
              onClick={() => setSelected(backlink.id)}
            >
              <strong>{backlink.title}</strong>
              <small>{backlink.path || backlink.sourceLabel}</small>
            </button>
          ))}
          {current && !current.backlinks.length && (
            <div className="quiet-empty">No other visible note links here yet.</div>
          )}
        </div>
        <div className="surface-subhead">
          <span>Recent decisions</span>
          <small>{snapshot.decisions.length}</small>
        </div>
        {snapshot.decisions.slice(0, 8).map((decision) => (
          <article key={decision.id}>
            <span>D</span>
            <div>
              <strong>{decision.title}</strong>
              <p>{decision.body}</p>
              <small>
                {decision.authorName} · {relative(decision.createdAt)}
              </small>
            </div>
          </article>
        ))}
        {!snapshot.decisions.length && (
          <div className="quiet-empty">
            Record the decisions you never want the company to debate twice.
          </div>
        )}
      </aside>
    </div>
  );
}

function KnowledgeIndexRow({
  page,
  active,
  onClick,
}: {
  page: KnowledgePage;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={active ? "active" : ""} onClick={onClick}>
      <span>{page.kind.slice(0, 2).toUpperCase()}</span>
      <span>
        <strong>{page.title}</strong>
        <small>
          {page.sourceType === "vault" ? page.sourceLabel || "vault" : page.sourceType} ·{" "}
          {page.backlinkCount} links
        </small>
      </span>
    </button>
  );
}

function CalendarSurface({
  snapshot,
  onCreateCalendar,
  onCreateEvent,
}: {
  snapshot: WorkspaceSnapshot;
  onCreateCalendar: () => void;
  onCreateEvent: () => void;
}) {
  const [selectedCalendar, setSelectedCalendar] = useState("all");
  const calendars = snapshot.calendars;
  const calendarById = useMemo(
    () => new Map(calendars.map((calendar) => [calendar.id, calendar])),
    [calendars],
  );
  const events = snapshot.calendarEvents
    .filter((event) => event.status !== "cancelled")
    .filter((event) => selectedCalendar === "all" || event.calendarId === selectedCalendar)
    .sort((a, b) => a.startsAt - b.startsAt);
  const grouped = events.reduce<Array<{ day: string; date: Date; events: typeof events }>>(
    (groups, event) => {
      const date = new Date(event.startsAt);
      const day = date.toISOString().slice(0, 10);
      const current = groups[groups.length - 1];
      if (!current || current.day !== day) {
        groups.push({ day, date, events: [event] });
      } else {
        current.events.push(event);
      }
      return groups;
    },
    [],
  );
  const privateCount = calendars.filter((calendar) => calendar.visibility === "private").length;

  return (
    <div className="calendar-layout">
      <aside className="calendar-list">
        <div className="surface-subhead">
          <span>Calendars</span>
          <button type="button" onClick={onCreateCalendar}>+</button>
        </div>
        <button
          type="button"
          className={selectedCalendar === "all" ? "active" : ""}
          onClick={() => setSelectedCalendar("all")}
        >
          <i className="calendar-swatch all" />
          <span>
            <strong>All visible</strong>
            <small>{events.length} scheduled</small>
          </span>
        </button>
        {calendars.map((calendar) => (
          <button
            key={calendar.id}
            type="button"
            className={selectedCalendar === calendar.id ? "active" : ""}
            onClick={() => setSelectedCalendar(calendar.id)}
          >
            <i
              className="calendar-swatch"
              style={calendar.color ? { background: calendar.color } : undefined}
            />
            <span>
              <strong>{calendar.name}</strong>
              <small>
                {calendar.ownerLabel || calendar.ownerType} · {calendar.access}
              </small>
            </span>
          </button>
        ))}
        <footer>
          <strong>{privateCount} private</strong>
          <span>Busy-only events arrive redacted from the server.</span>
        </footer>
      </aside>

      <section className="calendar-agenda">
        <header>
          <div>
            <span className="eyebrow">Upcoming</span>
            <h2>{selectedCalendar === "all" ? "Across the workspace" : calendarById.get(selectedCalendar)?.name}</h2>
          </div>
          <button className="primary-button compact" type="button" onClick={onCreateEvent}>
            + Event
          </button>
        </header>
        {grouped.length ? (
          <div className="agenda-days">
            {grouped.map((group) => (
              <section key={group.day} className="agenda-day">
                <header>
                  <strong>{group.date.toLocaleDateString([], { weekday: "short" })}</strong>
                  <span>{group.date.getDate()}</span>
                  <small>{group.date.toLocaleDateString([], { month: "long" })}</small>
                </header>
                <div>
                  {group.events.map((event) => {
                    const calendar = calendarById.get(event.calendarId);
                    return (
                      <article key={event.id} className={event.redacted ? "redacted" : ""}>
                        <time>
                          {event.allDay
                            ? "all day"
                            : new Date(event.startsAt).toLocaleTimeString([], {
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                        </time>
                        <i
                          className="calendar-swatch"
                          style={calendar?.color ? { background: calendar.color } : undefined}
                        />
                        <div>
                          <strong>{event.title}</strong>
                          <p>
                            {[calendar?.name, event.location].filter(Boolean).join(" · ") ||
                              (event.redacted ? "Details withheld" : "No location")}
                          </p>
                        </div>
                        <span className="state-chip">{event.access}</span>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            index="CA"
            title={calendars.length ? "No events in this view" : "Bring the team calendar into Spaces"}
            detail={
              calendars.length
                ? "Create an event or select another calendar."
                : "Create a private, team, or workspace calendar. Connected provider events will join the same permission-aware view."
            }
          />
        )}
      </section>

      <aside className="calendar-boundary">
        <span className="eyebrow">Access model</span>
        <h3>One overlay, explicit boundaries.</h3>
        <dl>
          <div><dt>Private</dt><dd>Only the owner and direct shares.</dd></div>
          <div><dt>Busy</dt><dd>Time blocks only; titles and details are removed server-side.</dd></div>
          <div><dt>Read</dt><dd>Full event detail without edit access.</dd></div>
          <div><dt>Write</dt><dd>Create and change events together.</dd></div>
        </dl>
      </aside>
    </div>
  );
}

function PeopleSurface({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="people-surface">
      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">01</span>
            <h2>People</h2>
          </div>
          <span>{snapshot.members.length} members</span>
        </div>
        <div className="people-grid">
          {snapshot.members.map((member) => (
            <article key={member.id}>
              <span className="large-avatar">{initials(member.name)}</span>
              <div>
                <h3>{member.name}</h3>
                <p>{member.email}</p>
                <span className="role-chip">{member.role}</span>
              </div>
              <time>Joined {relative(member.joinedAt)}</time>
            </article>
          ))}
          {snapshot.pendingInvites.map((invite) => (
            <article key={invite.id} className="pending">
              <span className="large-avatar">…</span>
              <div>
                <h3>{invite.email}</h3>
                <p>Invitation pending</p>
                <span className="role-chip">{invite.role}</span>
              </div>
              <time>Expires {relative(invite.expiresAt)}</time>
            </article>
          ))}
        </div>
      </section>

      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">02</span>
            <h2>Agents</h2>
          </div>
          <span>{snapshot.agents.length} configured</span>
        </div>
        <div className="agent-grid">
          {snapshot.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} snapshot={snapshot} />
          ))}
          {!snapshot.agents.length && (
            <EmptyState
              index="AI"
              title="Add the first agent"
              detail="Give it a role, ownership, backend, model, and reasoning effort. The paired desktop executes the work."
            />
          )}
        </div>
      </section>

      <section className="roster-section">
        <div className="roster-head">
          <div>
            <span className="section-index">03</span>
            <h2>Teams</h2>
          </div>
          <span>{snapshot.teams.length} teams</span>
        </div>
        <div className="team-grid">
          {snapshot.teams.map((team) => (
            <article key={team.id}>
              <span className="team-mark">{initials(team.name)}</span>
              <div>
                <h3>{team.name}</h3>
                <p>{team.purpose || "No charter yet"}</p>
                <small>
                  {team.people} people · {team.agents} agents
                </small>
              </div>
            </article>
          ))}
          {!snapshot.teams.length && (
            <EmptyState
              index="TM"
              title="People and agents belong together"
              detail="Create a team, define its purpose, then address the whole group in a channel."
            />
          )}
        </div>
      </section>
    </div>
  );
}

function AgentCard({
  agent,
  snapshot,
}: {
  agent: AgentProfile;
  snapshot: WorkspaceSnapshot;
}) {
  const owner = snapshot.members.find((member) => member.id === agent.ownerUserId);
  const host = snapshot.devices.find((device) => device.id === agent.hostDeviceId);
  return (
    <article>
      <header>
        <span className={`agent-avatar ${agent.backend}`}>{initials(agent.name)}</span>
        <div>
          <h3>{agent.name}</h3>
          <p>{agent.role || "Unassigned role"}</p>
        </div>
        <i className={agent.status}>{agent.status}</i>
      </header>
      <dl>
        <div>
          <dt>Owns</dt>
          <dd>{agent.owns || "Not assigned"}</dd>
        </div>
        <div>
          <dt>Harness</dt>
          <dd>{titleCase(agent.backend)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{agent.model || "Harness default"}</dd>
        </div>
        <div>
          <dt>Effort</dt>
          <dd>{agent.effort || "Harness default"}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{owner?.name || "Workspace"}</dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd>{host?.name || "Not assigned"}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{agent.visibility === "private" ? "Owner only" : "Workspace"}</dd>
        </div>
      </dl>
    </article>
  );
}

function ConnectionsSurface({
  snapshot,
  working,
  mutate,
  onPair,
  onRevoke,
}: {
  snapshot: WorkspaceSnapshot;
  working: boolean;
  mutate: (
    input: Record<string, unknown>,
    success: string,
  ) => Promise<Record<string, unknown>>;
  onPair: () => void;
  onRevoke: (deviceId: string) => Promise<Record<string, unknown>>;
}) {
  const [providers, setProviders] = useState<ProviderCatalogItem[]>([]);
  const [providerError, setProviderError] = useState("");
  const [connectProjects, setConnectProjects] = useState<Record<string, string>>({});
  const latestSnapshots = new Map(
    snapshot.desktopSnapshots.map((item) => [item.deviceId, item]),
  );
  const canPair =
    snapshot.workspace.role === "owner" ||
    snapshot.workspace.role === "admin" ||
    snapshot.workspace.role === "member";
  const canManageEveryDevice =
    snapshot.workspace.role === "owner" || snapshot.workspace.role === "admin";
  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/integrations/catalog?workspace=${encodeURIComponent(snapshot.workspace.id)}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const body = (await response.json()) as {
          providers?: ProviderCatalogItem[];
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || "Connections are unavailable.");
        if (!cancelled) setProviders(body.providers ?? []);
      })
      .catch((error) => {
        if (!cancelled) setProviderError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.workspace.id]);

  return (
    <div className="connections-surface">
      <section className="connection-hero">
        <div>
          <span className="eyebrow">Trusted machine enrollment</span>
          <h2>Pair the desktop that actually runs Spaces.</h2>
          <p>
            Spaces issues a short-lived, single-use pairing code for your account. The
            desktop exchanges it for its own device token. Roster, projects,
            runtime configuration, selected shared knowledge, and calendar data
            sync through this workspace. A prompt and its
            final result cross the control plane only when one paired device
            asks an agent hosted on another device to run; repository contents,
            live terminal output, and full process transcripts remain on the
            host Mac.
          </p>
        </div>
        <div className="connection-hero-actions">
          <a
            className="primary-button"
            href={DESKTOP_DOWNLOAD_URL}
          >
            {DESKTOP_DOWNLOAD_LABEL}
          </a>
          {canPair && (
            <button className="quiet-button" type="button" onClick={onPair}>
              Pair this desktop
            </button>
          )}
          <small>{DESKTOP_DOWNLOAD_NOTE}</small>
        </div>
      </section>

      <section className="connection-section">
        <div className="roster-head">
          <div>
            <span className="section-index">01</span>
            <h2>Spaces desktops</h2>
          </div>
          <span>{snapshot.devices.length} paired</span>
        </div>
        <div className="device-grid">
          {snapshot.devices.map((device) => {
            const latest = latestSnapshots.get(device.id);
            return (
              <article key={device.id}>
                <span className="device-glyph">⌁</span>
                <div>
                  <header>
                    <h3>{device.name}</h3>
                    <span className={`device-status ${device.status}`}>
                      {device.status}
                    </span>
                  </header>
                  <p>
                    {device.ownerName} · {device.platform || "platform unknown"}
                    <br />
                    Last seen {relative(device.lastSeenAt)}
                    {latest ? ` · snapshot ${relative(latest.updatedAt)}` : ""}
                  </p>
                  {device.tools.length > 0 && (
                    <p>{device.tools.join(" · ")}</p>
                  )}
                  <dl>
                    <div>
                      <dt>Projects</dt>
                      <dd>{latest?.payload.projects ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Open tasks</dt>
                      <dd>{latest?.payload.openTasks ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Live agents</dt>
                      <dd>{latest?.payload.activeRuns?.length ?? 0}</dd>
                    </div>
                  </dl>
                  {(canManageEveryDevice ||
                    device.ownerUserId === snapshot.currentUser.id) && (
                    <button
                      className="text-button danger-text"
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Revoke ${device.name}? It will have to pair again.`)) {
                          return;
                        }
                        void onRevoke(device.id);
                      }}
                    >
                      Revoke desktop
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!snapshot.devices.length && canPair && (
            <button type="button" className="device-empty" onClick={onPair}>
              <span>+</span>
              <strong>Pair the first desktop</strong>
              <small>Connect local projects and live agent processes.</small>
            </button>
          )}
        </div>
      </section>

      <section className="connection-section">
        <div className="roster-head">
          <div>
            <span className="section-index">02</span>
            <h2>Cloud accounts</h2>
            <p>
              GitHub, mail, and calendars stay private to the person who
              connects them. Social publishing accounts are shared with the
              workspace.
            </p>
          </div>
          <span>OAuth + encrypted tokens</span>
        </div>
        <div className="provider-grid">
          {providers.map((provider) => {
            const connections = snapshot.connections.filter(
              (connection) => connection.kind === provider.id,
            );
            const shared = provider.audience === "workspace";
            const selectedProject =
              connectProjects[provider.id] ?? snapshot.projects[0]?.id ?? "";
            const connectParams = new URLSearchParams({
              workspace: snapshot.workspace.id,
            });
            if (shared && selectedProject) connectParams.set("project", selectedProject);
            return (
              <article className="provider-card" key={provider.id}>
                <header className="provider-card-head">
                  <div className="provider-card-identity">
                    <span className="source-number">
                      {provider.id.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                    <h3>{provider.label}</h3>
                    <p>
                      {connections.length
                        ? `${connections.length} ${connections.length === 1 ? "account" : "accounts"} connected`
                        : provider.ready
                          ? "Ready for account authorization."
                          : provider.reason}
                    </p>
                    <small>
                      {provider.audience === "personal"
                        ? "Private to you"
                        : "Shared with this workspace"}
                    </small>
                  </div>
                  </div>
                  {connections.length > 0 && (
                    <span className="source-state connected">connected</span>
                  )}
                </header>

                {connections.length > 0 && (
                  <div className="provider-accounts">
                    {connections.map((connection) => (
                      <section className="provider-account" key={connection.id}>
                        <header>
                          <div>
                            <strong>{connection.accountLabel || connection.label}</strong>
                            <small>
                              {connection.lastSyncAt
                                ? `Last used ${relative(connection.lastSyncAt)}`
                                : "Ready to use"}
                            </small>
                          </div>
                          <span>{connection.status}</span>
                        </header>
                        {shared && snapshot.projects.length > 0 && (
                          <div className="project-account-links">
                            {snapshot.projects.map((project) => {
                              const link = connection.projectLinks.find(
                                (candidate) => candidate.projectId === project.id,
                              );
                              return (
                                <div key={project.id}>
                                  <button
                                    type="button"
                                    className={`project-link-toggle ${link ? "linked" : ""}`}
                                    disabled={working}
                                    onClick={() => {
                                      void mutate(
                                        {
                                          action: link
                                            ? "unlink_project_connection"
                                            : "link_project_connection",
                                          projectId: project.id,
                                          connectionId: connection.id,
                                        },
                                        link
                                          ? `Removed ${connection.accountLabel} from ${project.name}.`
                                          : `Linked ${connection.accountLabel} to ${project.name}.`,
                                      ).catch(() => {});
                                    }}
                                  >
                                    <span aria-hidden="true">{link ? "✓" : "+"}</span>
                                    {project.name}
                                  </button>
                                  {link && (
                                    <button
                                      type="button"
                                      className={`project-default ${link.isDefault ? "active" : ""}`}
                                      disabled={working || link.isDefault}
                                      title={
                                        link.isDefault
                                          ? `Default ${provider.label} account for ${project.name}`
                                          : `Make this the default ${provider.label} account for ${project.name}`
                                      }
                                      onClick={() => {
                                        void mutate(
                                          {
                                            action: "set_project_connection_default",
                                            projectId: project.id,
                                            connectionId: connection.id,
                                          },
                                          `${connection.accountLabel} is now ${project.name}'s default ${provider.label} account.`,
                                        ).catch(() => {});
                                      }}
                                    >
                                      {link.isDefault ? "Default" : "Make default"}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
                )}

                {provider.ready && provider.canConnect ? (
                  <div className="provider-connect">
                    {shared && snapshot.projects.length > 0 && (
                      <label>
                        <span>Add this account to</span>
                        <select
                          value={selectedProject}
                          onChange={(event) =>
                            setConnectProjects((current) => ({
                              ...current,
                              [provider.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Workspace only</option>
                          {snapshot.projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <a
                      className={connections.length ? "quiet-button" : "primary-button"}
                      href={`/api/integrations/${provider.id}/start?${connectParams.toString()}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {connections.length ? "Add account" : "Connect"}
                    </a>
                  </div>
                ) : provider.ready ? (
                  <span className="source-state">owner or admin connects</span>
                ) : (
                  <span className="source-state">app credentials needed</span>
                )}
              </article>
            );
          })}
          {providerError && <div className="connection-error">{providerError}</div>}
        </div>
      </section>

      <section className="connection-section">
        <div className="roster-head">
          <div>
            <span className="section-index">03</span>
            <h2>Native capabilities</h2>
          </div>
          <span>replace tool sprawl</span>
        </div>
        <div className="source-list">
          {SOURCE_CATALOG.map((source, index) => {
            const connection = snapshot.connections.find(
              (candidate) => candidate.kind === source.kind,
            );
            const connected =
              source.kind === "desktop"
                ? snapshot.devices.length > 0
                : Boolean(connection && connection.status === "connected");
            return (
              <article key={source.kind}>
                <span className="source-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3>{source.label}</h3>
                  <p>{source.descriptor}</p>
                </div>
                <span className="source-mode">{source.mode}</span>
                <span className={`source-state ${connected ? "connected" : ""}`}>
                  {connected
                    ? "active"
                    : source.kind === "desktop"
                      ? "ready to pair"
                      : source.kind === "accounts"
                        ? "not configured"
                        : "administered"}
                </span>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function PortalDialog({
  kind,
  snapshot,
  working,
  shareValue,
  setShareValue,
  onNotice,
  onClose,
  mutate,
}: {
  kind: Exclude<DialogKind, null>;
  snapshot: WorkspaceSnapshot;
  working: boolean;
  shareValue: string;
  setShareValue: (value: string) => void;
  onNotice: (value: string) => void;
  onClose: () => void;
  mutate: (
    input: Record<string, unknown>,
    success: string,
  ) => Promise<Record<string, unknown>>;
}) {
  const titles: Record<Exclude<DialogKind, null>, { eyebrow: string; title: string }> = {
    invite: { eyebrow: "Onboard a person", title: "Invite teammate" },
    issue: { eyebrow: "Create shared work", title: "New issue" },
    channel: { eyebrow: "Create shared context", title: "New channel" },
    project: { eyebrow: "Create a container", title: "New project" },
    knowledge: { eyebrow: "Add company memory", title: "New page" },
    calendar: { eyebrow: "Create a time boundary", title: "New calendar" },
    event: { eyebrow: "Schedule shared time", title: "New event" },
    decision: { eyebrow: "Make reasoning durable", title: "Record decision" },
    inbox: { eyebrow: "Bring work into Spaces", title: "Capture inbox item" },
    agent: { eyebrow: "Configure an operator", title: "New agent" },
    team: { eyebrow: "Group people and agents", title: "New team" },
    pair: { eyebrow: "Connect local Spaces", title: "Pair a desktop" },
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      let result: Record<string, unknown> = {};
      if (kind === "invite") {
        result = await mutate(
          {
            action: "create_invite",
            email: formValue(form, "email"),
            role: formValue(form, "role"),
          },
          "Invitation created.",
        );
        const path = String(result.invitePath ?? "");
        if (path) setShareValue(`${window.location.origin}${path}`);
        return;
      }
      if (kind === "pair") {
        result = await mutate(
          { action: "create_device_code" },
          "Pairing code ready.",
        );
        if (result.pairingCode) setShareValue(String(result.pairingCode));
        return;
      }
      if (kind === "issue") {
        await mutate(
          {
            action: "create_issue",
            title: formValue(form, "title"),
            description: formValue(form, "description"),
            status: formValue(form, "status"),
            priority: formValue(form, "priority"),
            projectId: formValue(form, "projectId"),
            assigneeId: formValue(form, "assigneeId"),
            dueDate: formValue(form, "dueDate"),
          },
          "Issue created.",
        );
      }
      if (kind === "channel") {
        await mutate(
          {
            action: "create_channel",
            name: formValue(form, "name"),
            topic: formValue(form, "topic"),
            mode: formValue(form, "mode"),
          },
          "Channel created.",
        );
      }
      if (kind === "project") {
        await mutate(
          {
            action: "create_project",
            name: formValue(form, "name"),
            summary: formValue(form, "summary"),
            leadId: formValue(form, "leadId"),
            targetDate: formValue(form, "targetDate"),
          },
          "Project created.",
        );
      }
      if (kind === "knowledge") {
        await mutate(
          {
            action: "create_knowledge",
            title: formValue(form, "title"),
            folder: formValue(form, "folder"),
            body: formValue(form, "body"),
            kind: formValue(form, "kind"),
            tags: formValue(form, "tags"),
          },
          "Knowledge page created.",
        );
      }
      if (kind === "calendar") {
        const [ownerType, ownerId] = formValue(form, "owner").split(":", 2);
        await mutate(
          {
            action: "create_calendar",
            name: formValue(form, "name"),
            color: formValue(form, "color"),
            ownerType,
            ownerId,
            visibility: formValue(form, "visibility"),
          },
          "Calendar created.",
        );
      }
      if (kind === "event") {
        const result = await mutate(
          {
            action: "create_calendar_event",
            calendarId: formValue(form, "calendarId"),
            title: formValue(form, "title"),
            description: formValue(form, "description"),
            location: formValue(form, "location"),
            startsAt: formValue(form, "startsAt"),
            endsAt: formValue(form, "endsAt"),
            allDay: formValue(form, "allDay") === "on",
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          "Event scheduled.",
        );
        onNotice(
          result.delivery === "queued_for_desktop"
            ? "Event queued for Apple Calendar on the paired desktop."
            : result.delivery === "provider"
              ? "Event created in the connected calendar."
              : "Event scheduled in Spaces.",
        );
      }
      if (kind === "decision") {
        await mutate(
          {
            action: "create_decision",
            title: formValue(form, "title"),
            body: formValue(form, "body"),
          },
          "Decision recorded.",
        );
      }
      if (kind === "inbox") {
        await mutate(
          {
            action: "capture_inbox",
            subject: formValue(form, "subject"),
            body: formValue(form, "body"),
            senderName: formValue(form, "senderName"),
            senderAddress: formValue(form, "senderAddress"),
            labels: formValue(form, "labels"),
          },
          "Inbox item captured.",
        );
      }
      if (kind === "agent") {
        await mutate(
          {
            action: "create_agent",
            name: formValue(form, "name"),
            role: formValue(form, "role"),
            owns: formValue(form, "owns"),
            backend: formValue(form, "backend"),
            model: formValue(form, "model"),
            effort: formValue(form, "effort"),
            hostDeviceId: formValue(form, "hostDeviceId"),
            visibility: formValue(form, "visibility"),
            persona: formValue(form, "persona"),
            cliArgs: formValue(form, "cliArgs")
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
          },
          "Agent configured.",
        );
      }
      if (kind === "team") {
        await mutate(
          {
            action: "create_team",
            name: formValue(form, "name"),
            purpose: formValue(form, "purpose"),
          },
          "Team created.",
        );
      }
      onClose();
    } catch {
      // The parent owns the visible error banner.
    }
  }

  const title = titles[kind];
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="portal-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <span className="eyebrow">{title.eyebrow}</span>
            <h2>{title.title}</h2>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {shareValue ? (
          <ShareResult
            kind={kind}
            value={shareValue}
            onClose={onClose}
          />
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <DialogFields kind={kind} snapshot={snapshot} />
            <footer>
              <button className="quiet-button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={working}>
                {working
                  ? "Saving…"
                  : kind === "invite"
                    ? "Create invite"
                    : kind === "pair"
                      ? "Generate code"
                      : "Save to Spaces"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function DialogFields({
  kind,
  snapshot,
}: {
  kind: Exclude<DialogKind, null>;
  snapshot: WorkspaceSnapshot;
}) {
  if (kind === "invite") {
    return (
      <>
        <Field label="Email" required>
          <input name="email" type="email" placeholder="teammate@company.com" autoFocus required />
        </Field>
        <Field label="Workspace role" hint="Members can collaborate. Admins can also onboard and configure.">
          <select name="role" defaultValue="member">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="guest">Guest</option>
          </select>
        </Field>
      </>
    );
  }
  if (kind === "pair") {
    return (
      <div className="pair-explainer">
        <a
          className="desktop-download"
          href={DESKTOP_DOWNLOAD_URL}
        >
          <span aria-hidden="true">↓</span>
          <strong>{DESKTOP_DOWNLOAD_LABEL}</strong>
          <small>{DESKTOP_DOWNLOAD_NOTE}</small>
        </a>
        <span className="pair-diagram">
          <i>Spaces web</i>
          <b>↔</b>
          <i>Spaces desktop</i>
        </span>
        <p>
          Generate a single-use code for your account, then enter it in desktop Spaces. The desktop
          receives its own private token and can synchronize members, devices,
          projects, agent configuration, explicitly shared knowledge, permission-aware
          calendars, presence, and live-run summaries.
        </p>
        <ul>
          <li>Code expires after 15 minutes</li>
          <li>No repository contents or full process transcripts are uploaded</li>
          <li>Private documents and unshared vaults stay on their owner&apos;s Mac</li>
          <li>Busy-only calendar events are redacted before another user receives them</li>
          <li>Cross-device runs relay only the requested prompt and final result</li>
          <li>The connection can be removed without affecting local work</li>
        </ul>
      </div>
    );
  }
  if (kind === "issue") {
    return (
      <>
        <Field label="Issue" required wide>
          <input name="title" placeholder="What needs to happen?" autoFocus required />
        </Field>
        <Field label="Description" wide>
          <textarea name="description" placeholder="Context, expected outcome, and constraints…" rows={5} />
        </Field>
        <Field label="Project">
          <select name="projectId" defaultValue={snapshot.projects[0]?.id ?? ""}>
            <option value="">No project</option>
            {snapshot.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select name="status" defaultValue="backlog">
            {STATUS_COLUMNS.map((column) => (
              <option key={column.id} value={column.id}>{column.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue="normal">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field label="Assignee">
          <select name="assigneeId" defaultValue="">
            <option value="">Unassigned</option>
            {snapshot.members.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Due date">
          <input name="dueDate" type="date" />
        </Field>
      </>
    );
  }
  if (kind === "channel") {
    return (
      <>
        <Field label="Channel name" required wide>
          <input name="name" placeholder="product-launch" autoFocus required />
        </Field>
        <Field label="Topic" wide>
          <input name="topic" placeholder="What belongs in this channel?" />
        </Field>
        <Field
          label="Coordination mode"
          hint="Lead mode lets one agent triage, delegate, and synthesize."
          wide
        >
          <select name="mode" defaultValue="lead">
            <option value="lead">Lead</option>
            <option value="broadcast">Broadcast</option>
            <option value="sequential">Sequential</option>
            <option value="panel">Panel</option>
          </select>
        </Field>
      </>
    );
  }
  if (kind === "project") {
    return (
      <>
        <Field label="Project name" required wide>
          <input name="name" placeholder="Launch Spaces" autoFocus required />
        </Field>
        <Field label="Summary" wide>
          <textarea name="summary" placeholder="The outcome this project owns…" rows={4} />
        </Field>
        <Field label="Lead">
          <select name="leadId" defaultValue="">
            <option value="">No lead yet</option>
            {snapshot.members.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Target date">
          <input name="targetDate" type="date" />
        </Field>
      </>
    );
  }
  if (kind === "knowledge") {
    return (
      <>
        <Field label="Page title" required wide>
          <input name="title" placeholder="Operating principles" autoFocus required />
        </Field>
        <Field
          label="Folder"
          hint="Use / for nested folders, like Company/Runbooks."
          wide
        >
          <input name="folder" placeholder="Company/Operations" />
        </Field>
        <Field label="Kind">
          <select name="kind" defaultValue="note">
            <option value="note">Note</option>
            <option value="brief">Brief</option>
            <option value="runbook">Runbook</option>
            <option value="charter">Charter</option>
            <option value="research">Research</option>
          </select>
        </Field>
        <Field label="Tags">
          <input name="tags" placeholder="company, process" />
        </Field>
        <Field label="Body" wide>
          <textarea name="body" placeholder="Write the durable version…" rows={10} />
        </Field>
      </>
    );
  }
  if (kind === "calendar") {
    return <CalendarDialogFields snapshot={snapshot} />;
  }
  if (kind === "event") {
    const writable = snapshot.calendars.filter(
      (calendar) => calendar.access === "write" && calendar.writable,
    );
    return (
      <>
        <Field label="Calendar" required wide>
          <select name="calendarId" defaultValue={writable[0]?.id ?? ""} required>
            <option value="" disabled>Choose a writable calendar</option>
            {writable.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name} · {calendar.ownerLabel || calendar.ownerType}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Event" required wide>
          <input name="title" placeholder="What is happening?" autoFocus required />
        </Field>
        <Field label="Starts" required>
          <input name="startsAt" type="datetime-local" required />
        </Field>
        <Field label="Ends" required>
          <input name="endsAt" type="datetime-local" required />
        </Field>
        <Field label="Location">
          <input name="location" placeholder="Room or link" />
        </Field>
        <Field label="All day">
          <input name="allDay" type="checkbox" />
        </Field>
        <Field label="Description" wide>
          <textarea name="description" placeholder="Agenda and context…" rows={5} />
        </Field>
      </>
    );
  }
  if (kind === "decision") {
    return (
      <>
        <Field label="Decision" required wide>
          <input name="title" placeholder="What did we decide?" autoFocus required />
        </Field>
        <Field label="Reasoning" wide>
          <textarea
            name="body"
            placeholder="Why this choice, what was rejected, and when to revisit it…"
            rows={8}
          />
        </Field>
      </>
    );
  }
  if (kind === "inbox") {
    return (
      <>
        <Field label="Subject" required wide>
          <input name="subject" placeholder="What came in?" autoFocus required />
        </Field>
        <Field label="From">
          <input name="senderName" placeholder={snapshot.currentUser.name} />
        </Field>
        <Field label="Address">
          <input name="senderAddress" placeholder={snapshot.currentUser.email} />
        </Field>
        <Field label="Detail" wide>
          <textarea name="body" placeholder="Paste or summarize the request…" rows={7} />
        </Field>
        <Field label="Labels" wide>
          <input name="labels" placeholder="customer, finance, follow-up" />
        </Field>
      </>
    );
  }
  if (kind === "agent") {
    return (
      <>
        <Field label="Agent name" required>
          <input name="name" placeholder="Scout" autoFocus required />
        </Field>
        <Field label="Role">
          <input name="role" placeholder="Research lead" />
        </Field>
        <Field label="Owns" wide>
          <input name="owns" placeholder="Customer research, evidence, weekly brief" />
        </Field>
        <Field label="Harness">
          <select name="backend" defaultValue="codex">
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="ritz">Ritz local</option>
          </select>
        </Field>
        <Field label="Model" hint="Blank uses the harness default.">
          <input name="model" placeholder="agent default" />
        </Field>
        <Field label="Reasoning effort" wide>
          <select name="effort" defaultValue="">
            <option value="">Harness default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
            <option value="max">Maximum</option>
            <option value="deep">Deep (Ritz)</option>
          </select>
        </Field>
        <Field
          label="Host device"
          hint="The agent executes only on this trusted device. Requests wait while it is offline."
        >
          <select name="hostDeviceId" defaultValue="">
            <option value="">Assign after pairing</option>
            {snapshot.devices
              .filter(
                (device) =>
                  snapshot.workspace.role !== "member" ||
                  device.ownerUserId === snapshot.currentUser.id,
              )
              .map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} · {device.ownerName}
              </option>
              ))}
          </select>
        </Field>
        <Field label="Who can use it">
          <select name="visibility" defaultValue="workspace">
            <option value="workspace">Everyone in workspace</option>
            <option value="private">Only me</option>
          </select>
        </Field>
        <Field label="Agent instructions" wide>
          <textarea
            name="persona"
            placeholder="How this agent should work, decide, and communicate…"
            rows={5}
          />
        </Field>
        <Field
          label="Advanced CLI arguments"
          hint="One complete argument per line. The prompt is still sent through stdin."
          wide
        >
          <textarea
            name="cliArgs"
            placeholder={'--sandbox\nworkspace-write'}
            rows={4}
          />
        </Field>
      </>
    );
  }
  return (
    <>
      <Field label="Team name" required wide>
        <input name="name" placeholder="Core product" autoFocus required />
      </Field>
      <Field label="Purpose" wide>
        <textarea
          name="purpose"
          placeholder="What this mix of people and agents owns together…"
          rows={6}
        />
      </Field>
    </>
  );
}

function CalendarDialogFields({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const mine = `member:${snapshot.currentUser.id}`;
  const [owner, setOwner] = useState(mine);
  const [visibility, setVisibility] = useState<"private" | "busy" | "read" | "write">(
    "private",
  );
  return (
    <>
      <Field label="Calendar name" required wide>
        <input name="name" placeholder="Launch calendar" autoFocus required />
      </Field>
      <Field label="Owner">
        <select
          name="owner"
          value={owner}
          onChange={(event) => {
            const next = event.target.value;
            setOwner(next);
            setVisibility(next === mine ? "private" : "read");
          }}
        >
          <option value={mine}>My calendar</option>
          <option value={`workspace:${snapshot.workspace.id}`}>Workspace calendar</option>
          {snapshot.teams.map((team) => (
            <option key={team.id} value={`team:${team.id}`}>{team.name} team</option>
          ))}
        </select>
      </Field>
      <Field label="Default access">
        <select
          name="visibility"
          value={visibility}
          onChange={(event) =>
            setVisibility(
              event.target.value as "private" | "busy" | "read" | "write",
            )
          }
        >
          <option value="private">Private</option>
          <option value="busy">Workspace sees busy time</option>
          <option value="read">Workspace can read</option>
          <option value="write">Workspace can edit</option>
        </select>
      </Field>
      <Field label="Color">
        <input name="color" type="color" defaultValue="#7c6bf2" />
      </Field>
    </>
  );
}

function Field({
  label,
  hint,
  required,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`dialog-field ${wide ? "wide" : ""}`}>
      <span>
        {label}
        {required && <b>required</b>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function ShareResult({
  kind,
  value,
  onClose,
}: {
  kind: Exclude<DialogKind, null>;
  value: string;
  onClose: () => void;
}) {
  const pairing = kind === "pair";
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }
  return (
    <div className={`share-result ${pairing ? "pairing" : ""}`}>
      <span className="share-check">✓</span>
      <h3>{pairing ? "Pairing code ready" : "Invitation ready"}</h3>
      <p>
        {pairing
          ? "Open desktop Spaces → Settings → Connected workspace, then enter this code."
          : "Send this private link to the invited teammate. They must sign in with the invited email."}
      </p>
      <button type="button" className="share-value" onClick={() => void copy()}>
        <code>{value}</code>
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <small>
        {pairing
          ? "Single use · expires in 15 minutes"
          : "Single use · expires in 7 days"}
      </small>
      <button className="primary-button wide" type="button" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

function EmptyState({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="empty-state">
      <span>{index}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
