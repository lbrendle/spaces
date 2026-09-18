import { invoke, isTauri } from "@tauri-apps/api/core";

export type BrowserAction = "back" | "forward" | "reload";

export async function browserOpen(
  label: string,
  url: string,
  bounds: { x: number; y: number; width: number; height: number }
): Promise<void> {
  if (!isTauri()) return;
  await invoke("browser_open", { label, url, ...bounds });
}

export async function browserBounds(
  label: string,
  bounds: { x: number; y: number; width: number; height: number }
): Promise<void> {
  if (!isTauri()) return;
  await invoke("browser_bounds", { label, ...bounds });
}

export async function browserVisibility(label: string, visible: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("browser_visibility", { label, visible });
}

export async function browserClose(label: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("browser_close", { label });
}

export function normalizeBrowserInput(input: string): string {
  const value = input.trim();
  if (!value) return "https://www.google.com";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  if (/^[^\s]+\.[^\s]+(?:\/.*)?$/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export async function browserNavigate(label: string, input: string): Promise<string> {
  const url = normalizeBrowserInput(input);
  if (isTauri()) {
    return invoke<string>("browser_navigate", { label, url });
  }
  return url;
}

export async function browserAction(label: string, action: BrowserAction): Promise<void> {
  if (!isTauri()) return;
  await invoke("browser_action", { label, action });
}

export async function browserUrl(label: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("browser_url", { label });
}

/**
 * What a script in the page came back with.
 *
 * Every evaluation is wrapped on the Rust side so the page always answers in
 * this shape: a thrown error arrives as an explanation rather than as silence,
 * which matters because the caller is usually an agent that has to decide what
 * to do next.
 */
export interface BrowserEval<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * Run a script in a project browser and get its value back.
 *
 * Tauri's own `eval` cannot do this — it hands the script over and returns
 * nothing — so the Rust side reaches through to WKWebView's
 * `evaluateJavaScript:completionHandler:`. The script body is a function body:
 * it should `return` what it wants to send back.
 */
export async function browserEval<T = unknown>(
  label: string,
  script: string
): Promise<BrowserEval<T>> {
  if (!isTauri()) return { ok: false, error: "no browser outside the app" };
  try {
    const raw = await invoke<string>("browser_eval", { label, script });
    if (!raw) return { ok: true, value: undefined };
    return JSON.parse(raw) as BrowserEval<T>;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** The label of the project browser for a project, matching BrowserPane. */
export function browserLabel(projectId: string): string {
  return `spaces-browser-${projectId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Float the project browser above everything, in its own small window.
 *
 * Returns the address it is showing. The floating window *is* the browser —
 * the webview moves rather than being duplicated — so the pane and every tool
 * an agent calls keep addressing the same page.
 */
export async function browserPopout(label: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("browser_popout", { label });
}

/** Put it back, and say where it had got to. */
export async function browserDock(label: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("browser_dock", { label });
}

/** Whether this project's browser is floating right now. */
export async function browserIsFloating(label: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("browser_floating", { label }).catch(() => false);
}
