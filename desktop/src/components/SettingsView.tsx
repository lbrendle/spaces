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
import { config, setConfig } from "../config";



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

/**
 * Settings is six unrelated subjects, and it used to be one scroll.
 *
 * Pairing, integrations, appearance, calendars, the setup checklist and the
 * CLI inventory were stacked in a single column — and one of them, the theme
 * gallery, is thirty-eight cards tall, so "change the mode" and "see whether
 * the gh CLI was found" were separated by several screens of artwork that had
 * nothing to do with either. Nothing about that column was browsable: there
 * was no way to see what settings existed without scrolling past all of them.
 *
 * One section at a time, with an index. The index is the contents page the
 * scroll never had, the panel stops being taller than the theme gallery, and
 * the section you were last in is where you come back to.
 */
const SECTIONS = [
  { id: "workspace", label: "Workspace", blurb: "Pairing with Spaces web" },
  { id: "runtime", label: "Open source", blurb: "Brand and local runtime defaults" },
  { id: "integrations", label: "Integrations", blurb: "Google, Microsoft, social accounts" },
  { id: "appearance", label: "Appearance", blurb: "Theme, accent, density" },
  { id: "calendars", label: "Calendars", blurb: "Which calendars are visible" },
  { id: "setup", label: "Setup", blurb: "What is left to finish" },
  { id: "about", label: "About", blurb: "Version and detected CLIs" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SECTION_KEY = "spaces.settings.section";

function readSection(): SectionId {
  try {
    const raw = localStorage.getItem(SECTION_KEY) as SectionId | null;
    return SECTIONS.some((s) => s.id === raw) ? (raw as SectionId) : "workspace";
  } catch {
    return "workspace";
  }
}

export function SettingsView() {
  const tools = useStore((s) => s.tools);
  const [section, setSectionState] = useState<SectionId>(readSection);

  function setSection(id: SectionId) {
    setSectionState(id);
    try {
      localStorage.setItem(SECTION_KEY, id);
    } catch {
      /* a locked-down webview just always opens on Workspace */
    }
  }

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
  const [runtimeConfig, setRuntimeConfig] = useState(() => ({
    brand: config().brand,
    brandShort: config().brandShort,
    portalUrl: config().portalUrl,
    localAiName: config().localAiName,
    localAiUrl: config().localAiUrl,
    docsUrl: config().docsUrl,
  }));

  useEffect(() => {
    const refresh = () => {
      void loadPortalConnection().then((connection) => {
        setPortal(connection);
        if (connection) {
          setPortalUrl(connection.base_url);
          setDeviceName(connection.device_name);
        }
      });
      void listIntegrationAccounts().then(setIntegrations);
    };
    refresh();
    window.addEventListener("hq:portal-change", refresh);
    void getVersion().then(setAppVersion);
    return () => window.removeEventListener("hq:portal-change", refresh);
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

  function saveRuntimeConfig(event: FormEvent) {
    event.preventDefault();
    setConfig(runtimeConfig);
    window.location.reload();
  }

  return (
    <div className="main-pane scroll-pane">
      <div className="pane-header">
        <div>
          <div className="pane-title">Settings</div>
          <div className="pane-sub">
            {SECTIONS.find((s) => s.id === section)?.blurb}
          </div>
        </div>
      </div>

      <div className="set-split">
        <nav className="set-index" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={"set-index-btn" + (s.id === section ? " on" : "")}
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              <span className="set-index-label">{s.label}</span>
              <span className="set-index-blurb">{s.blurb}</span>
            </button>
          ))}
        </nav>

        <div className="dash-body set-body">
        <section className="dash-card connected-spaces-card" hidden={section !== "workspace"}>
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

        <section className="dash-card" hidden={section !== "runtime"}>
          <h3>Open-source runtime</h3>
          <div className="set-hint about-hint">
            Personalize this installation without editing source. These values stay on this Mac and
            override the distribution defaults; a fork can set the same values with VITE_SPACES_* variables.
          </div>
          <form className="runtime-config-form" onSubmit={saveRuntimeConfig}>
            <label>
              <span>Product name</span>
              <input
                value={runtimeConfig.brand}
                onChange={(event) => setRuntimeConfig((value) => ({ ...value, brand: event.target.value }))}
                placeholder="Spaces"
                required
              />
            </label>
            <label>
              <span>Short name</span>
              <input
                value={runtimeConfig.brandShort}
                onChange={(event) => setRuntimeConfig((value) => ({ ...value, brandShort: event.target.value }))}
                placeholder="Spaces"
                required
              />
            </label>
            <label className="runtime-wide">
              <span>Web workspace default</span>
              <input
                value={runtimeConfig.portalUrl}
                onChange={(event) => setRuntimeConfig((value) => ({ ...value, portalUrl: event.target.value }))}
                placeholder="https://your-workspace.example.com"
                type="url"
              />
              <small>Optional. Pairing a desktop can also set this address.</small>
            </label>
            <label>
              <span>Local HTTP engine label</span>
              <input
                value={runtimeConfig.localAiName}
                onChange={(event) => setRuntimeConfig((value) => ({ ...value, localAiName: event.target.value }))}
                placeholder="Local AI"
                required
              />
            </label>
            <label>
              <span>Default Local HTTP engine URL</span>
              <input
                value={runtimeConfig.localAiUrl}
                onChange={(event) => setRuntimeConfig((value) => ({ ...value, localAiUrl: event.target.value }))}
                placeholder="http://127.0.0.1:8765"
                type="url"
                required
              />
              <small>This global default is inherited only when an HTTP agent has no endpoint of its own.</small>
            </label>
            <label className="runtime-wide">
              <span>Documentation URL</span>
              <input
                value={runtimeConfig.docsUrl}
                onChange={(event) => setRuntimeConfig((value) => ({ ...value, docsUrl: event.target.value }))}
                placeholder="https://docs.example.com"
                type="url"
              />
            </label>
            <div className="runtime-config-actions runtime-wide">
              <span className="set-hint">Saving reloads the interface so every surface uses the new values.</span>
              <button className="primary-btn" type="submit">Save and reload</button>
            </div>
          </form>
        </section>

        <section className="dash-card" hidden={section !== "integrations"}>
          <h3>
            {/* "Integrations", not "Connections". The rail already has a
                destination called Connections — the link graph between tasks,
                people and repos — and two unrelated things under one name in
                one product is a name that has to go. These are third-party
                accounts, which is what integrations are. */}
            Integrations
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
              const reconnect = account?.status === "error";
              return (
                <article key={provider.id}>
                  <span className="connection-monogram">
                    {provider.id === "meta" ? "IG" : provider.id.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong>{provider.label}</strong>
                    <span>
                      {connected
                        ? account.handle || "Connected"
                        : reconnect
                          ? `${account?.handle || provider.label} needs authorization again`
                          : provider.detail}
                    </span>
                  </div>
                  <span
                    className={
                      "connection-status" +
                      (connected ? " connected" : reconnect ? " error" : "")
                    }
                  >
                    {connected ? "connected" : reconnect ? "reconnect" : "not connected"}
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
                    {connected
                      ? "Manage"
                      : reconnect
                        ? "Reconnect"
                        : provider.id === "apple"
                          ? "Connect locally"
                          : "Open web admin"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>

        {/* Appearance, the theme gallery and every per-user override live in
            their own component: this file is already the settings *page*, and
            the gallery alone is bigger than the rest of it put together. */}
        {section === "appearance" && <AppearanceSettings />}

        {section === "calendars" && <CalendarSettings />}

        {section === "setup" && <SetupGuide />}

        <section className="dash-card" hidden={section !== "about"}>
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
    </div>
  );
}
