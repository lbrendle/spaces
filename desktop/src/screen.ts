/**
 * screen.ts — the rest of the Mac, for agents that are allowed it.
 *
 * Spaces already drives applications it cannot otherwise reach: that is how a
 * hand-off gets into Muse, which has no CLI, no scripting dictionary and no
 * local port. This makes the same two abilities — look at a window, type into
 * one — available to any agent whose reach has been switched on, through the
 * MCP its harness already speaks.
 *
 * Reading is by accessibility tree rather than screenshot. It is what the app
 * publishes about itself, it needs no screen-recording permission, and it
 * arrives as text an agent can reason about instead of an image it must first
 * describe to itself. The limit is real and worth stating plainly: an app that
 * publishes nothing cannot be read, and Muse is exactly such an app.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ScreenSend {
  delivered: boolean;
  verified: boolean;
  problem: string;
}

/** What an application's front window is showing, as text. */
export async function readApp(app: string): Promise<string> {
  return invoke<string>("screen_read", { appName: app.trim() });
}

/**
 * Type into an application, optionally pressing return afterwards.
 *
 * The same command that delivers a hand-off to Muse, so there is one piece of
 * machinery for driving an app and not two — including everything learned
 * making that work: activating rather than merely raising, loading the
 * clipboard before anything is clicked, and refusing to call a send verified
 * unless the box was read back.
 */
export async function typeIntoApp(
  app: string,
  text: string,
  submit: boolean
): Promise<ScreenSend> {
  const raw = await invoke("send_to_app", {
    bundleId: "",
    appName: app.trim(),
    text,
    submit,
  });
  const result = (raw ?? {}) as Record<string, unknown>;
  return {
    delivered: result.delivered === true,
    verified: result.verified === true,
    problem: String(result.problem ?? ""),
  };
}

/** Whether Spaces may drive other applications on this Mac at all. */
export async function screenAllowed(): Promise<boolean> {
  return invoke<boolean>("accessibility_trusted").catch(() => false);
}
