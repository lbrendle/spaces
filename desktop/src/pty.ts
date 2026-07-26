/**
 * pty.ts — typed client for the Rust pty commands in src-tauri/src/lib.rs.
 *
 * This is the interactive counterpart to agents.ts: instead of streaming a
 * headless harness over pipes, it runs a program in a real terminal so the
 * user can watch and type. Nothing here knows about runs, agents or channels.
 *
 * Two Tauri events carry the traffic:
 *   pty-output  { sessionId, data }      — a decoded chunk of terminal output
 *   pty-exit    { sessionId, exitCode }  — the process ended
 *
 * Both are global, so this module keeps exactly one listener for each and fans
 * them out by session id.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PtyOutputEvent {
  sessionId: string;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number | null;
}

export interface PtyHandlers {
  /** A chunk of output. Chunks are already whole UTF-8; just concatenate them. */
  onData: (data: string) => void;
  /** The process ended. Called at most once per session. */
  onExit?: (exitCode: number | null) => void;
}

export interface PtySpawnOptions {
  sessionId: string;
  /** Executable name or absolute path; the Rust side resolves it on the login PATH. */
  program: string;
  args?: string[];
  /** Must be an existing directory, or the spawn fails with a clear error. */
  cwd?: string;
  cols?: number;
  rows?: number;
}

const handlers = new Map<string, PtyHandlers>();

/**
 * Output that arrived before its handler subscribed.
 *
 * ptySpawn awaits listener registration, so nothing is dropped by the event
 * system — but a caller that spawns first and subscribes second would still
 * miss the banner a fast CLI prints immediately. Buffering closes that window.
 */
const pending = new Map<string, string>();
const pendingExit = new Map<string, number | null>();

/** Enough for a screenful of noise; a subscriber that never arrives is capped. */
const MAX_PENDING = 64_000;

/**
 * Sessions that have been spawned and not yet reaped.
 *
 * The buffers above exist for the window between spawn and subscribe. Without
 * this set they would also fill for sessions nobody will ever subscribe to
 * again — every closed terminal leaves a final `pty-exit`, and each one would
 * strand an entry that is never read and never freed. Buffering only for live
 * sessions bounds both maps by the number of open terminals.
 */
const spawned = new Set<string>();

let listeners: Promise<void> | null = null;

/**
 * Register the two global listeners, once. Every entry point awaits this before
 * a process can produce output, because Tauri drops events that nothing is
 * listening for.
 */
export function initPtyListeners(): Promise<void> {
  if (!listeners) {
    listeners = (async () => {
      await listen<PtyOutputEvent>("pty-output", (ev) => {
        const { sessionId, data } = ev.payload;
        if (!data) return;
        const h = handlers.get(sessionId);
        if (h) {
          h.onData(data);
          return;
        }
        if (!spawned.has(sessionId)) return;
        const buffered = (pending.get(sessionId) ?? "") + data;
        pending.set(sessionId, buffered.length > MAX_PENDING ? buffered.slice(-MAX_PENDING) : buffered);
      });
      await listen<PtyExitEvent>("pty-exit", (ev) => {
        const { sessionId, exitCode } = ev.payload;
        const h = handlers.get(sessionId);
        if (h) {
          // Flush anything still buffered before announcing the exit, so the
          // last lines a program prints are never lost to the ordering.
          flushPending(sessionId, h);
          spawned.delete(sessionId);
          h.onExit?.(exitCode ?? null);
          return;
        }
        // The exit of a session that was killed and unsubscribed is the normal
        // close path, and there is nobody left to tell.
        if (!spawned.delete(sessionId)) return;
        pendingExit.set(sessionId, exitCode ?? null);
      });
    })().catch((e) => {
      // A failed registration must not be cached as success — the next call retries.
      listeners = null;
      throw e;
    });
  }
  return listeners;
}

function flushPending(sessionId: string, h: PtyHandlers) {
  const buffered = pending.get(sessionId);
  pending.delete(sessionId);
  if (buffered) h.onData(buffered);
}

/**
 * Receive this session's output. Pass a plain callback for output only, or a
 * handlers object to hear about the exit too. Returns an unsubscribe function.
 *
 * Safe to call before or after ptySpawn: anything that arrived in between is
 * replayed on subscribe, in order.
 */
export function subscribe(
  sessionId: string,
  cb: PtyHandlers | ((data: string) => void)
): () => void {
  const h: PtyHandlers = typeof cb === "function" ? { onData: cb } : cb;
  handlers.set(sessionId, h);
  void initPtyListeners().catch(() => {
    // Surfaced by ptySpawn, which awaits the same promise.
  });
  flushPending(sessionId, h);
  if (pendingExit.has(sessionId)) {
    const code = pendingExit.get(sessionId) ?? null;
    pendingExit.delete(sessionId);
    h.onExit?.(code);
  }
  return () => {
    if (handlers.get(sessionId) === h) handlers.delete(sessionId);
    pending.delete(sessionId);
    pendingExit.delete(sessionId);
  };
}

/**
 * Open a pty and run `program` in it. Reusing a live session id replaces the
 * terminal that was on it, so a double-mounted view cannot leave an orphan.
 */
export async function ptySpawn(opts: PtySpawnOptions): Promise<void> {
  await initPtyListeners();
  spawned.add(opts.sessionId);
  try {
    await invoke("pty_spawn", {
      sessionId: opts.sessionId,
      program: opts.program,
      args: opts.args ?? [],
      cwd: opts.cwd || null,
      cols: Math.max(1, Math.round(opts.cols ?? 80)),
      rows: Math.max(1, Math.round(opts.rows ?? 24)),
    });
  } catch (e) {
    // Nothing is running under this id, so nothing should be buffered for it.
    spawned.delete(opts.sessionId);
    throw e;
  }
}

/** Send keystrokes or pasted text. Delivered in call order. */
export async function ptyWrite(sessionId: string, data: string): Promise<void> {
  if (!data) return;
  await invoke("pty_write", { sessionId, data });
}

/** Tell the child its window changed size (this is what raises SIGWINCH). */
export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", {
    sessionId,
    cols: Math.max(1, Math.round(cols)),
    rows: Math.max(1, Math.round(rows)),
  });
}

/** Close a terminal. Killing one that already exited is not an error. */
export async function ptyKill(sessionId: string): Promise<void> {
  // Dropped first: the kill provokes a `pty-exit` that no longer has anyone to
  // reach, and buffering it would be the leak `spawned` exists to prevent.
  spawned.delete(sessionId);
  pending.delete(sessionId);
  pendingExit.delete(sessionId);
  await invoke("pty_kill", { sessionId });
}
