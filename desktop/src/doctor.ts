/**
 * doctor.ts — is this harness actually going to work on this Mac?
 *
 * Every agent Spaces can run has a different failure mode before it runs at
 * all: the binary is not installed, it is installed but signed out, it is a GUI
 * app that was never launched, the MCP bridge needs node and node is missing.
 * Those are all the same question to a person ("can this teammate work?") and
 * four unrelated checks underneath.
 *
 * This module answers the question once, per harness, with a result that says
 * what is wrong and what to do about it — and never guesses. A harness with no
 * verified way to report its sign-in state reports "unknown", not "ready":
 * telling someone an agent is good to go and then having it fail on the first
 * turn is worse than saying nothing.
 *
 * Results are cached, because the agent editor asks on every keystroke and
 * spawning `--version` for each one would be absurd.
 */
import { invoke } from "@tauri-apps/api/core";
import { harnessFor, parseArgs, ritzBase, ritzHealthRoute } from "./capabilities";
import type { Agent } from "./types";

export type HealthState =
  /** Installed, and as far as Spaces can tell, usable. */
  | "ready"
  /** The binary or app is not on this machine. */
  | "missing"
  /** Present, but not signed in. */
  | "signed-out"
  /** Present; Spaces has no verified way to check sign-in. */
  | "unknown"
  /** The check itself failed — a hung probe, a permissions error. */
  | "error";

export interface HarnessHealth {
  kind: string;
  state: HealthState;
  /** One line, written for a person. Never empty. */
  detail: string;
  /** Version string as the harness reports it, "" when it did not say. */
  version: string;
  /** Resolved executable or .app path, "" when not found. */
  path: string;
  /** Where to get it, when it is missing. */
  installHint: string;
  /** External harnesses only: whether the app is open right now. */
  running?: boolean;
  checkedAt: number;
}

interface ProbeResult {
  found: boolean;
  path: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface AppPresence {
  installed: boolean;
  path: string;
  running: boolean;
  version: string;
}

/** Tauri hands back snake_case from serde; normalise once, here. */
function normaliseProbe(raw: unknown): ProbeResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    found: o.found === true,
    path: String(o.path ?? ""),
    exitCode: Number(o.exit_code ?? o.exitCode ?? -1),
    stdout: String(o.stdout ?? ""),
    stderr: String(o.stderr ?? ""),
    timedOut: (o.timed_out ?? o.timedOut) === true,
  };
}

function normaliseApp(raw: unknown): AppPresence {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    installed: o.installed === true,
    path: String(o.path ?? ""),
    running: o.running === true,
    version: String(o.version ?? ""),
  };
}

/**
 * First line that looks like a version. CLIs pad `--version` with update
 * notices and banners, and the useful part is rarely the whole of stdout.
 */
function versionLine(out: string): string {
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/\d+\.\d+/.test(line)) return line.slice(0, 80);
  }
  return out.trim().split("\n")[0]?.slice(0, 80) ?? "";
}

/* ── cache ───────────────────────────────────────────────────── */

/** Long enough that typing in the editor is free, short enough to notice an install. */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; value: HarnessHealth }>();
const inflight = new Map<string, Promise<HarnessHealth>>();
const listeners = new Set<() => void>();

function announce() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // a bad subscriber must not break the doctor
    }
  }
}

/** Subscribe to "some health result changed". Returns an unsubscribe fn. */
export function subscribeHealth(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The cached answer, or null when nothing has been checked yet. */
export function cachedHealth(kind: string, discriminator = ""): HarnessHealth | null {
  return cache.get(`${kind}:${discriminator}`)?.value ?? null;
}

/** Drop every cached result, so the next read re-probes. */
export function forgetHealth() {
  cache.clear();
  announce();
}

/* ── the checks ──────────────────────────────────────────────── */

async function checkCli(kind: string, program: string): Promise<HarnessHealth> {
  const meta = harnessFor(kind);
  const probe = meta.probe;
  const bin = program.trim() || probe?.bin || "";
  const base: HarnessHealth = {
    kind,
    state: "unknown",
    detail: "",
    version: "",
    path: "",
    installHint: probe?.installHint ?? "",
    checkedAt: Date.now(),
  };

  if (!bin) {
    return { ...base, state: "missing", detail: "No executable set for this agent yet." };
  }

  const present = await invoke<boolean>("check_program", { program: bin }).catch(() => false);
  if (!present) {
    return {
      ...base,
      state: "missing",
      detail: probe?.installHint
        ? `${bin} is not on this Mac's PATH — install it from ${probe.installHint}.`
        : `${bin} is not on this Mac's PATH.`,
    };
  }

  // Found it. Ask for a version only where we know a cheap, non-interactive way.
  let version = "";
  let path = "";
  if (probe?.versionArgs?.length) {
    const raw = await invoke("probe_program", {
      program: bin,
      args: [...probe.versionArgs],
      timeoutMs: 6000,
    }).catch(() => null);
    if (raw) {
      const result = normaliseProbe(raw);
      path = result.path;
      if (result.timedOut) {
        return {
          ...base,
          path,
          state: "error",
          detail: `${bin} did not answer \`${probe.versionArgs.join(" ")}\` within 6s. It may be waiting for input, which a headless run cannot give it.`,
        };
      }
      version = versionLine(result.stdout || result.stderr);
    }
  }

  // Sign-in, only where a verified command exists. Everywhere else this stays
  // unknown rather than becoming an optimistic "ready".
  if (probe?.authArgs?.length) {
    const raw = await invoke("probe_program", {
      program: bin,
      args: [...probe.authArgs],
      timeoutMs: 8000,
    }).catch(() => null);
    if (raw) {
      const result = normaliseProbe(raw);
      const text = `${result.stdout}\n${result.stderr}`;
      const match = probe.authOkMatch;
      const signedIn = result.timedOut
        ? null
        : match
          ? text.toLowerCase().includes(match.toLowerCase())
          : result.exitCode === 0 && !/not (logged|signed) in|please (log|sign) in/i.test(text);
      if (signedIn === false) {
        return {
          ...base,
          path,
          version,
          state: "signed-out",
          detail: `${meta.label} is installed but not signed in. Run \`${bin} ${(probe.authArgs ?? []).join(" ")}\` in a terminal to see why.`,
        };
      }
      if (signedIn === true) {
        return {
          ...base,
          path,
          version,
          state: "ready",
          detail: version ? `${meta.label} ${version}, signed in.` : `${meta.label} is installed and signed in.`,
        };
      }
    }
  }

  return {
    ...base,
    path,
    version,
    state: "ready",
    detail: version
      ? `${bin} ${version}.${meta.verified ? "" : " Spaces has not verified this harness's flags — check them against its own --help."}`
      : `${bin} is installed.`,
  };
}

async function checkHttp(kind: string, agent?: Agent): Promise<HarnessHealth> {
  const meta = harnessFor(kind);
  const values = parseArgs(kind, agent?.cli_args ?? "");
  const url = `${ritzBase(values)}${ritzHealthRoute(values)}`;
  const base: HarnessHealth = {
    kind,
    state: "unknown",
    detail: "",
    version: "",
    path: ritzBase(values),
    installHint: meta.probe?.installHint ?? "",
    checkedAt: Date.now(),
  };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      return { ...base, state: "error", detail: `${url} answered ${res.status} ${res.statusText}.` };
    }
    return { ...base, state: "ready", detail: `${meta.label} is answering at ${ritzBase(values)}.` };
  } catch (e) {
    return {
      ...base,
      state: "missing",
      detail: `Nothing is answering at ${url} — start the engine, or point this agent at a different endpoint. (${String(e).slice(0, 80)})`,
    };
  }
}

async function checkExternal(kind: string, agent?: Agent): Promise<HarnessHealth> {
  const values = parseArgs(kind, agent?.cli_args ?? "");
  const appName = String(agent?.model ?? values.model ?? "").trim();
  const bundleId = String(values.bundle_id ?? "").trim();
  const base: HarnessHealth = {
    kind,
    state: "unknown",
    detail: "",
    version: "",
    path: "",
    installHint: "",
    checkedAt: Date.now(),
  };

  if (!appName && !bundleId) {
    return {
      ...base,
      detail:
        "No app named for this teammate yet. Spaces will still track its branch and diffs — naming the app just lets it say whether the app is open.",
    };
  }

  const raw = await invoke("check_app", { bundleId, appName }).catch(() => null);
  if (!raw) {
    return { ...base, state: "error", detail: "Could not ask macOS about this app." };
  }
  const app = normaliseApp(raw);
  if (!app.installed) {
    return {
      ...base,
      state: "missing",
      detail: `${appName || bundleId} is not installed on this Mac. This agent can still hold a branch, but nobody here can act on its hand-offs.`,
    };
  }
  return {
    ...base,
    state: "ready",
    path: app.path,
    version: app.version,
    running: app.running,
    detail: app.running
      ? `${appName || bundleId}${app.version ? ` ${app.version}` : ""} is installed and running.`
      : `${appName || bundleId}${app.version ? ` ${app.version}` : ""} is installed but not open — hand-offs will wait until it is.`,
  };
}

/**
 * Health for one harness. `agent` sharpens the answer where the agent's own
 * configuration matters (a custom executable, a non-default HTTP endpoint, the
 * app behind an external teammate); omit it for a picker row.
 */
export async function checkHarness(kind: string, agent?: Agent): Promise<HarnessHealth> {
  const meta = harnessFor(kind);
  const program =
    meta.kind === "custom" || !meta.probe?.bin ? String(agent?.model ?? "").trim() : meta.probe.bin;
  const discriminator =
    meta.wire === "cli" ? program : meta.wire === "http" ? String(agent?.cli_args ?? "") : `${agent?.model ?? ""}|${agent?.cli_args ?? ""}`;
  const key = `${kind}:${discriminator}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    try {
      const value =
        meta.wire === "http"
          ? await checkHttp(kind, agent)
          : meta.wire === "external"
            ? await checkExternal(kind, agent)
            : await checkCli(kind, program);
      cache.set(key, { at: Date.now(), value });
      announce();
      return value;
    } catch (e) {
      const value: HarnessHealth = {
        kind,
        state: "error",
        detail: String(e).slice(0, 200),
        version: "",
        path: "",
        installHint: "",
        checkedAt: Date.now(),
      };
      cache.set(key, { at: Date.now(), value });
      announce();
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** Health for every registered harness, for the picker and the setup guide. */
export async function checkAllHarnesses(kinds: readonly string[]): Promise<HarnessHealth[]> {
  return Promise.all(kinds.map((k) => checkHarness(k)));
}

/**
 * Run a harness's own `--help` and hand back what it said.
 *
 * The honest answer to "are these flags right?" for a harness Spaces has not
 * verified. Used by the editor's "Check flags" action, so the user reads the
 * CLI's own documentation rather than trusting a definition that shipped
 * months ago.
 */
export async function harnessHelp(program: string, args: readonly string[] = ["--help"]): Promise<string> {
  const raw = await invoke("probe_program", {
    program: program.trim(),
    args: [...args],
    timeoutMs: 8000,
  });
  const result = normaliseProbe(raw);
  if (!result.found) return `${program} is not on this Mac's PATH.`;
  if (result.timedOut) return `${program} ${args.join(" ")} did not finish within 8s.`;
  return (result.stdout || result.stderr).trim() || "(no output)";
}
