import "./settings.css";
import { AppearanceSettings } from "./AppearanceSettings";
import { CalendarSettings } from "./CalendarSettings";
import { SetupGuide } from "./SetupGuide";
import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import {
  disconnectPortal,
  loadPortalConnection,
  pairPortal,
  syncPortal,
  type PortalConnection,
} from "../portal";
import { listIntegrationAccounts, type IntegrationAccount } from "../operations";
import { config } from "../config";



const TOOLS: { id: string; name: string; cmd: string; note: string }[] = [
  { id: "claude", name: "Claude Code", cmd: "claude", note: "agent runtime" },
  { id: "codex", name: "Codex", cmd: "codex", note: "agent runtime" },
  { id: "gh", name: "GitHub CLI", cmd: "gh", note: "PRs, issues, repos" },
];

const PROVIDERS = [
  { id: "google", label: "Google Workspace", detail: "Gmail, Google Calendar, and YouTube", category: "calendar" },
  { id: "microsoft", label: "Microsoft 365", detail: "Outlook Mail and Calendar", category: "mail" },
  { id: "apple", label: "Apple Calendar", detail: "Local macOS Calendar permission", category: "calendar" },
  { id: "meta", label: "Instagram / Meta", detail: "Accounts, publishing, and insights", category: "social" },
  { id: "tiktok", label: "TikTok", detail: "Video upload and publishing", category: "social" },
  { id: "x", label: "X", detail: "Posts, threads, and account access", category: "social" },
] as const;

export function SettingsView() {
  const tools = useStore((s) => s.tools);
  const [portal, setPortal] = useState<PortalConnection | null>(null);
  const [portalUrl, setPortalUrl] = useState(
    config().portalUrl || "https://your-workspace.example.com"
  );
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState("My Mac");
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalMessage, setPortalMessage] = useState("");
  const [integrations, setIntegrations] = useState<IntegrationAccount[]>([]);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    void loadPortalConnection().then((connection) => {
      setPortal(connection);
      if (connection) {
        setPortalUrl(connection.base_url);
        setDeviceName(connection.device_name);
      }
    });
    void listIntegrationAccounts().then(setIntegrations);
    void getVersion().then(setAppVersion);
  }, []);




  async function submitPortal(event: FormEvent) {
    event.preventDefault();
    setPortalBusy(true);
    setPortalMessage("");
    try {
      const connection = await pairPortal(portalUrl, pairingCode, deviceName);
      setPortal(await syncPortal());
      setIntegrations(await listIntegrationAccounts());
      setPortalUrl(connection.base_url);
      setPairingCode("");
      setPortalMessage("Connected and synced.");
    } catch (reason) {
      setPortalMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPortalBusy(false);
    }
  }

  async function syncNow() {
    setPortalBusy(true);
    setPortalMessage("");
    try {
      setPortal(await syncPortal());
      setPortalMessage("Desktop snapshot synced.");
    } catch (reason) {
      setPortal(await loadPortalConnection());
      setPortalMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPortalBusy(false);
    }
  }

  async function disconnect() {
    setPortalBusy(true);
    await disconnectPortal();
    setPortal(null);
    setPairingCode("");
    setPortalMessage("This desktop is disconnected from Spaces web.");
    setPortalBusy(false);
  }

  return (
    <div className="main-pane scroll-pane">
      <div className="pane-header">
        <div>
          <div className="pane-title">Settings</div>
          <div className="pane-sub">
            Appearance, themes and the CLI tools Spaces drives.
          </div>
        </div>
      </div>

      <div className="dash-body">
        <section className="dash-card connected-spaces-card">
          <h3>
            Connected workspace
            {portal && (
              <span className={"portal-state " + portal.status}>
                {portal.status}
              </span>
            )}
          </h3>
          <div className="set-hint about-hint">
            Pair this desktop with the private Spaces web companion so teammates can
            see shared work and a privacy-safe summary of live local agent runs.
            Repository contents, prompts, and transcripts stay on this Mac.
          </div>
          {portal ? (
            <div className="portal-connected">
              <div className="portal-connected-main">
                <span className="portal-device-mark">⌁</span>
                <div>
                  <div className="set-label">{portal.device_name}</div>
                  <div className="set-hint">{portal.base_url}</div>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Workspace</dt>
                  <dd>{portal.workspace_id.slice(0, 18)}…</dd>
                </div>
                <div>
                  <dt>Last sync</dt>
                  <dd>
                    {portal.last_sync_at
                      ? new Date(portal.last_sync_at).toLocaleString()
                      : "Not yet"}
                  </dd>
                </div>
              </dl>
              {portal.last_error && (
                <div className="portal-error">{portal.last_error}</div>
              )}
              <div className="portal-actions">
                <button
                  type="button"
                  className="quiet-btn"
                  disabled={portalBusy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={portalBusy}
                  onClick={() => void syncNow()}
                >
                  {portalBusy ? "Syncing…" : "Sync now"}
                </button>
              </div>
            </div>
          ) : (
            <form className="portal-pair-form" onSubmit={(event) => void submitPortal(event)}>
              <label>
                <span>Spaces web address</span>
                <input
                  value={portalUrl}
                  onChange={(event) => setPortalUrl(event.target.value)}
                  placeholder="https://your-spaces.openai.site"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </label>
              <label>
                <span>Pairing code</span>
                <input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
                  placeholder="8 characters"
                  maxLength={11}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </label>
              <label>
                <span>Desktop name</span>
                <input
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  placeholder="My Mac"
                  required
                />
              </label>
              <button className="primary-btn" type="submit" disabled={portalBusy}>
                {portalBusy ? "Pairing…" : "Pair desktop"}
              </button>
            </form>
          )}
          {portalMessage && <div className="portal-message">{portalMessage}</div>}
        </section>

        <section className="dash-card">
          <h3>
            Connections
            <span className="set-count">
              {integrations.filter((account) => account.status === "connected").length}
            </span>
          </h3>
          <div className="set-hint about-hint">
            Cloud OAuth and provider tokens live in the encrypted web control plane.
            Apple Calendar stays behind this Mac&apos;s native permission boundary.
          </div>
          <div className="connection-cards">
            {PROVIDERS.map((provider) => {
              const account = integrations.find(
                (candidate) =>
                  candidate.provider === provider.id &&
                  candidate.category === provider.category
              );
              const connected = account?.status === "connected";
              return (
                <article key={provider.id}>
                  <span className="connection-monogram">
                    {provider.id === "meta" ? "IG" : provider.id.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong>{provider.label}</strong>
                    <span>{connected ? account.handle || "Connected" : provider.detail}</span>
                  </div>
                  <span className={"connection-status" + (connected ? " connected" : "")}>
                    {connected ? "connected" : "not connected"}
                  </span>
                  <button
                    className="quiet-btn"
                    onClick={() => {
                      if (provider.id === "apple") {
                        useStore.getState().setView({ type: "calendar" });
                        return;
                      }
                      if (!portal) {
                        setPortalMessage(`Pair this desktop with ${config().brand} web before connecting cloud accounts.`);
                        return;
                      }
                      const target = new URL(portal.base_url);
                      target.searchParams.set("workspace", portal.workspace_id);
                      target.searchParams.set("surface", "connections");
                      void openUrl(target.toString());
                    }}
                  >
                    {connected ? "Manage" : provider.id === "apple" ? "Connect locally" : "Open web admin"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        {/* Appearance, the theme gallery and every per-user override live in
            their own component: this file is already the settings *page*, and
            the gallery alone is bigger than the rest of it put together. */}
        <AppearanceSettings />

        <CalendarSettings />

        <SetupGuide />

        <section className="dash-card">
          <h3>About {appVersion ? `· ${appVersion}` : ""}</h3>
          <div className="set-hint about-hint">
            Spaces runs your agents locally. These CLIs are looked up on your
            PATH at launch — install one and restart Spaces to pick it up.
          </div>
          <div className="tool-list">
            {TOOLS.map((t) => {
              const ok = !!tools[t.id];
              return (
                <div key={t.id} className="tool-row">
                  <span className={"tool-dot" + (ok ? " ok" : " missing")} aria-hidden="true" />
                  <span className="tool-name">{t.name}</span>
                  <code className="tool-cmd">{t.cmd}</code>
                  <span className="tool-note">{t.note}</span>
                  <span className={"tool-state" + (ok ? " ok" : " missing")}>
                    {ok ? "detected" : "not found"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
