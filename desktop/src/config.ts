/**
 * Everything deployment-specific, in one file.
 *
 * Spaces is meant to be forkable: somebody who clones this repo should be able to
 * point it at their own web workspace, their own local model server and their
 * own brand without editing a component. So nothing anywhere else may hardcode
 * a hostname, a port, a product name or a person — if you find yourself typing
 * a URL into a component, it belongs here instead.
 *
 * Three layers, each overriding the one before:
 *
 *   1. defaults below — safe, generic, and never anybody's private host
 *   2. build-time `VITE_*` env, for a packaged distribution
 *   3. runtime overrides the user sets in Settings, persisted locally
 *
 * The default for the web workspace is deliberately EMPTY. A default that
 * pointed at somebody's personal deployment would be a footgun in a public
 * repo — a fresh clone would silently try to pair with a stranger's server.
 * Empty means the pairing screen asks, which is the honest behaviour.
 */

const STORAGE_KEY = "spaces.config";

export interface SpacesConfig {
  /** Product name shown in the UI. */
  brand: string;
  /** Short name for tight spaces (the sidebar mark, the window title). */
  brandShort: string;
  /**
   * Base URL of the paired web workspace. Empty means "not configured" —
   * the pairing screen prompts and stores what the user types.
   */
  portalUrl: string;
  /** Local model server used by the `ritz` agent kind. */
  ritzUrl: string;
  /** SQLite file name, relative to the platform app-data directory. */
  dbName: string;
  /** Directory Spaces mirrors shared context into, inside each project repo. */
  contextDir: string;
  /** Placeholder path shown in file-picker hints. Cosmetic only. */
  samplePath: string;
  /** Where "learn more" links point. Empty hides them. */
  docsUrl: string;
}

/** Read a build-time variable, falling back when it is absent or blank. */
function env(key: string, fallback: string): string {
  const raw = (import.meta.env as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

const BUILD_DEFAULTS: SpacesConfig = {
  brand: env("VITE_SPACES_BRAND", "Spaces"),
  brandShort: env("VITE_SPACES_BRAND_SHORT", env("VITE_SPACES_BRAND", "Spaces")),
  portalUrl: env("VITE_SPACES_PORTAL_URL", ""),
  ritzUrl: env("VITE_SPACES_RITZ_URL", "http://127.0.0.1:8765"),
  dbName: env("VITE_SPACES_DB_NAME", "spaces.db"),
  contextDir: env("VITE_SPACES_CONTEXT_DIR", ".hq"),
  samplePath: env("VITE_SPACES_SAMPLE_PATH", "~/code/my-app"),
  docsUrl: env("VITE_SPACES_DOCS_URL", ""),
};

/** Keys a user may change at runtime; the rest are build-time only. */
const RUNTIME_KEYS = ["brand", "brandShort", "portalUrl", "ritzUrl", "samplePath", "docsUrl"] as const;
export type RuntimeConfigKey = (typeof RUNTIME_KEYS)[number];

function loadOverrides(): Partial<SpacesConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<SpacesConfig> = {};
    for (const k of RUNTIME_KEYS) {
      const v = parsed[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    // Corrupt or unavailable storage must never stop the app booting.
    return {};
  }
}

let current: SpacesConfig = { ...BUILD_DEFAULTS, ...loadOverrides() };

/** The active configuration. Read it per use; do not destructure at module scope. */
export function config(): SpacesConfig {
  return current;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onConfigChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Change a runtime-settable value. Passing '' restores the build default. */
export function setConfig(patch: Partial<Pick<SpacesConfig, RuntimeConfigKey>>): SpacesConfig {
  const overrides = loadOverrides();
  for (const [k, v] of Object.entries(patch)) {
    if (!RUNTIME_KEYS.includes(k as RuntimeConfigKey)) continue;
    if (typeof v === "string" && v.trim()) overrides[k as RuntimeConfigKey] = v.trim();
    else delete overrides[k as RuntimeConfigKey];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Private mode: the override applies for this session and is not persisted.
  }
  current = { ...BUILD_DEFAULTS, ...overrides };
  for (const fn of listeners) fn();
  return current;
}

/** What a value would be with no runtime override, for "reset" affordances. */
export function buildDefault(key: keyof SpacesConfig): string {
  return BUILD_DEFAULTS[key];
}

export function isConfigured(key: RuntimeConfigKey): boolean {
  return !!current[key];
}

/**
 * Normalise a user-typed workspace address. Exported so the pairing screen and
 * settings validate identically — two different notions of "a valid URL" is
 * how you end up with a trailing slash breaking one screen and not the other.
 */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("Enter the address of your web workspace.");
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Workspace addresses must use http or https.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
