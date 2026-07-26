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
