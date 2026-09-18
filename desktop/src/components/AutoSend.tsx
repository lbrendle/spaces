/**
 * AutoSend — the two things standing between "configured" and "working".
 *
 * Driving another app needs a macOS permission and a click point, and both
 * fail silently: without the grant macOS simply drops the input, and a click
 * point that is off by a hundred points lands in the conversation instead of
 * the message box. Neither is discoverable from a form full of numbers.
 *
 * So this panel answers both out loud. It says whether the permission is
 * granted and offers the system's own prompt — which opens the right pane and
 * puts Spaces in the list, leaving one toggle instead of a file picker. And it
 * types a line into the app without sending it, so somebody can watch the test
 * land in the right box before trusting it with real work.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  automationReady,
  externalConfig,
  requestAutomation,
  testDelivery,
  type Delivery,
} from "../external";
import type { Agent } from "../types";
import { Spinner } from "./ui";
import "./autosend.css";

/** How often to look again while waiting for the grant to land. */
const POLL_MS = 1500;
/**
 * Five minutes. Granting this means leaving Spaces, finding a System Settings
 * window macOS may have put on another desktop, and flipping a switch — a
 * minute's timeout expires while somebody is still looking for it, and a panel
 * that gave up is worse than one that never started.
 */
const POLL_LIMIT = 200;

export function AutoSend({ agent }: { agent: Agent }) {
  const config = externalConfig(agent);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Delivery | null>(null);
  const polls = useRef(0);

  const check = useCallback(async () => {
    const ok = await automationReady();
    setTrusted(ok);
    return ok;
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  /*
   * Coming back to Spaces is the strongest signal there is that somebody just
   * finished with System Settings — stronger than any timer — so re-ask then.
   * It also covers the case where the grant happened in an earlier session and
   * this panel has never looked.
   */
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [check]);

  /*
   * The system dialog is not modal, so the grant lands some seconds after the
   * call returns — and macOS sends no notification when it does. Polling is
   * the only way to notice, and noticing matters: the panel is the thing
   * telling somebody whether they are done.
   */
  useEffect(() => {
    if (!waiting) return;
    polls.current = 0;
    const id = window.setInterval(() => {
      polls.current += 1;
      void automationReady().then((ok) => {
        if (ok) {
          setTrusted(true);
          setWaiting(false);
        } else if (polls.current >= POLL_LIMIT) {
          setWaiting(false);
        }
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting]);

  async function grant() {
    setResult(null);
    // Returns the state as it is now, which is almost always false — the
    // dialog outlives the call. The poll above is what actually answers.
    const already = await requestAutomation();
    if (already) setTrusted(true);
    else setWaiting(true);
  }

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await testDelivery(agent));
      void check();
    } finally {
      setTesting(false);
    }
  }

  const app = config.app || "the app";

  return (
    <div className="as">
      <div className="as-row">
        <span className={`as-dot as-${trusted === null ? "checking" : trusted ? "on" : "off"}`} aria-hidden="true" />
        <span className="as-state">
          {trusted === null
            ? "Checking whether Spaces may control other apps…"
            : trusted
              ? "Spaces has Accessibility permission, so it can type into other apps."
              : waiting
                ? "Waiting for the toggle. Turn Spaces on in the Accessibility list macOS just opened — it may be on another desktop. This notices on its own, and again whenever you come back to Spaces."
                : "macOS reports no Accessibility permission. If you have already granted it, that report can be stale — try the test below anyway, and if it fails, switch Spaces off and on again in the list."}
        </span>
        {trusted === false && !waiting && (
          <button type="button" className="btn tiny primary" onClick={() => void grant()}>
            Grant permission
          </button>
        )}
        {waiting && <Spinner />}
      </div>

      {trusted === false && !waiting && (
        <p className="as-why">
          macOS asks once, and the prompt puts Spaces in the list for you — all that is left is the
          switch. Nothing else on this Mac changes.
        </p>
      )}

      <div className="as-row">
        <button
          type="button"
          className="btn tiny"
          onClick={() => void runTest()}
          disabled={testing}
        >
          {testing ? <Spinner /> : null} Type a test line into {app}
        </button>
        <span className="as-hint">
          Types, but does not send — so you can see whether it lands in the message box. Worth
          trying even when the line above says the permission is missing; that report goes stale.
        </span>
      </div>

      {result && (
        <p className={`as-result ${result.delivered ? "ok" : "bad"}`}>
          {result.delivered
            ? `Typed it into ${app}. If it went somewhere other than the message box, adjust the two offsets below and try again.`
            : result.problem || "Nothing happened, and macOS gave no reason."}
        </p>
      )}
    </div>
  );
}
