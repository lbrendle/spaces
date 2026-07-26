import { useEffect, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkPortal,
  pairPortal,
  syncPortal,
  type PortalConnection,
} from "../portal";
import { IconLogo } from "./icons";
import "./pairing.css";
import { config } from "../config";

// Empty unless a fork sets VITE_SPACES_PORTAL_URL: a default pointing at
// somebody's personal deployment would have a fresh clone pairing with a
// stranger's server.
const DEFAULT_PORTAL = config().portalUrl;

export function PairingGate({
  onPaired,
}: {
  onPaired: (connection: PortalConnection) => void;
}) {
  const [portalUrl, setPortalUrl] = useState(DEFAULT_PORTAL);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("My Mac");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"welcome" | "code">("welcome");
  const [serviceState, setServiceState] = useState<"checking" | "online" | "error">(
    "checking"
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setServiceState("checking");
      void checkPortal(portalUrl)
        .then(() => setServiceState("online"))
        .catch(() => setServiceState("error"));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [portalUrl]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await pairPortal(portalUrl, code, deviceName);
      const connection = await syncPortal();
      if (!connection) throw new Error("Pairing completed, but the workspace did not sync.");
      onPaired(connection);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function openAdmin() {
    const target = new URL(portalUrl || DEFAULT_PORTAL);
    target.searchParams.set("surface", "devices");
    void openUrl(target.toString());
    setStage("code");
  }

  return (
    <main className="pairing-gate">
      <div className="pairing-orbit orbit-one" />
      <div className="pairing-orbit orbit-two" />
      <section className="pairing-card">
        <div className="pairing-brand">
          <span className="pairing-logo"><IconLogo size={30} /></span>
          <span>{config().brand}</span>
        </div>
        <div className="pairing-kicker">Trusted workspace enrollment</div>
        <h1>Your company starts with one connected Spaces.</h1>
        <p className="pairing-lede">
          Sign in with ChatGPT, choose or create your workspace, then pair this
          Mac. Nothing inside {config().brand} is available until enrollment succeeds.
        </p>
        <div className={`pairing-service ${serviceState}`}>
          <span />
          {serviceState === "checking"
            ? "Checking workspace service…"
            : serviceState === "online"
              ? "Workspace service online"
              : "Workspace service unavailable at this address"}
        </div>

        <ol className="pairing-steps">
          <li className={stage === "welcome" ? "active" : "complete"}>
            <span>1</span>
            <div>
              <strong>Open web administration</strong>
              <small>Sign in and choose “Pair desktop.”</small>
            </div>
          </li>
          <li className={stage === "code" ? "active" : ""}>
            <span>2</span>
            <div>
              <strong>Enter the one-time code</strong>
              <small>It expires after 15 minutes and can only be used once.</small>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Sync projects and agents</strong>
              <small>Your workspace roster becomes available on this Mac.</small>
            </div>
          </li>
        </ol>

        {stage === "welcome" ? (
          <div className="pairing-actions">
            <button className="btn primary pairing-primary" onClick={openAdmin}>
              Open {config().brand} admin
            </button>
            <button className="btn subtle" onClick={() => setStage("code")}>
              I already have a code
            </button>
          </div>
        ) : (
          <form className="pairing-form" onSubmit={(event) => void submit(event)}>
            <label>
              <span>Web workspace</span>
              <input
                value={portalUrl}
                onChange={(event) => setPortalUrl(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </label>
            <div className="pairing-form-row">
              <label>
                <span>Pairing code</span>
                <input
                  className="pairing-code"
                  autoFocus
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                  }
                  placeholder="XXXXXXXX"
                  maxLength={8}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </label>
              <label>
                <span>Device name</span>
                <input
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  placeholder="My Mac"
                  required
                />
              </label>
            </div>
            {error && <div className="pairing-error">{error}</div>}
            <div className="pairing-actions">
              <button
                className="btn primary pairing-primary"
                type="submit"
                disabled={busy || code.length !== 8}
              >
                {busy ? "Pairing and syncing…" : "Pair this Mac"}
              </button>
              <button className="btn subtle" type="button" onClick={openAdmin}>
                Generate a new code
              </button>
            </div>
          </form>
        )}

        <footer>
          <span>Local terminals, repositories, transcripts, and browser history stay on this Mac.</span>
          <span>Device access can be revoked from web administration.</span>
        </footer>
      </section>
    </main>
  );
}
