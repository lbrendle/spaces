/**
 * Autosave.
 *
 * Every editable surface in Spaces currently ends in a Save button — memory
 * entries, documents, agent instructions, team charters, project instructions,
 * task descriptions. That is six places to lose work, and in an app where an
 * agent might be reading what you just wrote, "did that save?" is a question
 * the interface should never make you ask.
 *
 * The hard part of autosave is not the timer, it is being honest. Three rules
 * this implementation holds to:
 *
 *   1. **Never silently lose an edit.** A save in flight while you keep typing
 *      must not clobber the newer text, and a failed save must keep the value
 *      dirty and say so — not reset to what the server had.
 *   2. **Never save something the user is mid-thought on.** Debounce on idle,
 *      not on an interval, so a save lands between sentences rather than in the
 *      middle of one.
 *   3. **Always flush before it matters.** Closing the editor, navigating away,
 *      or quitting must commit the pending edit, because the alternative is
 *      losing work at exactly the moment the user believes they are done.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export interface AutosaveOptions<T> {
  /** Quiet period before a save fires. */
  delay?: number;
  /**
   * Force a save this long after the first unsaved change even if typing has
   * not stopped — otherwise a long uninterrupted paragraph is never persisted.
   */
  maxWait?: number;
  /** Compare for equality; defaults to Object.is on the value. */
  equal?: (a: T, b: T) => boolean;
  /** Called after a save fails, for a toast or an inline message. */
  onError?: (e: unknown) => void;
}

export interface Autosave<T> {
  state: SaveState;
  /** When the last successful save landed, for "saved 2m ago". */
  savedAt: number;
  error: string;
  /** True when the in-memory value differs from what was last persisted. */
  dirty: boolean;
  /** Persist now — for ⌘S, a Save button, or closing an editor. */
  flush: () => Promise<void>;
  /** Abandon pending changes and treat `value` as clean (e.g. after Cancel). */
  reset: (to?: T) => void;
}

const DEFAULT_DELAY = 700;
const DEFAULT_MAX_WAIT = 5_000;

/**
 * Persist `value` whenever it settles.
 *
 * `save` is called with the value at the moment the save begins; if the value
 * has changed again by the time it resolves, the hook stays dirty and schedules
 * another pass rather than reporting success for text that is already stale.
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<void> | void,
  options: AutosaveOptions<T> = {}
): Autosave<T> {
  const { delay = DEFAULT_DELAY, maxWait = DEFAULT_MAX_WAIT, equal, onError } = options;

  const [state, setState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState("");

  // Refs, not state: these must be readable from timers and from the unmount
  // cleanup, where a stale closure would flush the wrong value — the exact bug
  // that makes hand-rolled autosave lose the last edit.
  const latest = useRef(value);
  const persisted = useRef(value);
  const saveFn = useRef(save);
  const timer = useRef(0);
  const firstDirtyAt = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(true);

  latest.current = value;
  saveFn.current = save;

  const same = useCallback(
    (a: T, b: T) => (equal ? equal(a, b) : Object.is(a, b)),
    [equal]
  );

  const run = useCallback(async () => {
    if (inFlight.current) return;
    const snapshot = latest.current;
    if (same(snapshot, persisted.current)) {
      if (alive.current) setState((s) => (s === "dirty" ? "idle" : s));
      return;
    }
    inFlight.current = true;
    if (alive.current) setState("saving");
    try {
      await saveFn.current(snapshot);
      persisted.current = snapshot;
      firstDirtyAt.current = 0;
      if (alive.current) {
        setError("");
        setSavedAt(Date.now());
        // Typing continued while the save was in flight: the value on screen is
        // newer than what landed, so this is not "saved" yet.
        setState(same(latest.current, snapshot) ? "saved" : "dirty");
      }
      if (!same(latest.current, snapshot)) {
        inFlight.current = false;
        void run();
        return;
      }
    } catch (e) {
      // Deliberately leave `persisted` alone: the value is still unsaved, and
      // the next attempt must try again rather than assume it succeeded.
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
      onError?.(e);
    } finally {
      inFlight.current = false;
    }
  }, [same, onError]);

  useEffect(() => {
    if (same(value, persisted.current)) return;
    if (!firstDirtyAt.current) firstDirtyAt.current = Date.now();
    setState((s) => (s === "saving" ? s : "dirty"));

    window.clearTimeout(timer.current);
    const waited = Date.now() - firstDirtyAt.current;
    // Idle-debounced, but with a ceiling so continuous typing still saves.
    const wait = waited >= maxWait ? 0 : Math.min(delay, maxWait - waited);
    timer.current = window.setTimeout(() => void run(), wait);
    return () => window.clearTimeout(timer.current);
  }, [value, delay, maxWait, run, same]);

  // Flush on unmount, and on the window going away. `pagehide` rather than
  // `beforeunload`: it fires in cases beforeunload does not, and this is the
  // last chance to persist before a close.
  useEffect(() => {
    alive.current = true;
    const flushNow = () => {
      window.clearTimeout(timer.current);
      void run();
    };
    window.addEventListener("pagehide", flushNow);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", flushNow);
      window.clearTimeout(timer.current);
      // Fire and forget: the component is gone, but the write must still land.
      if (!same(latest.current, persisted.current)) void saveFn.current(latest.current);
    };
  }, [run, same]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    await run();
  }, [run]);

  const reset = useCallback((to?: T) => {
    window.clearTimeout(timer.current);
    persisted.current = to === undefined ? latest.current : to;
    firstDirtyAt.current = 0;
    setState("idle");
    setError("");
  }, []);

  return {
    state,
    savedAt,
    error,
    dirty: state === "dirty" || state === "error",
    flush,
    reset,
  };
}

/**
 * Bind ⌘S / Ctrl+S to an explicit save.
 *
 * Autosave does not remove the need for this. People press ⌘S to *confirm*
 * their work is safe, and swallowing it silently — or worse, letting the
 * browser's own save dialog appear — reads as the app ignoring them.
 */
export function useSaveShortcut(flush: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush, enabled]);
}

/** Human wording for a save state, so every surface says the same thing. */
export function saveLabel(a: Pick<Autosave<unknown>, "state" | "savedAt" | "error">): string {
  switch (a.state) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "dirty":
      return "Unsaved changes";
    case "error":
      return a.error ? `Not saved — ${a.error}` : "Not saved";
    default:
      return a.savedAt ? "Saved" : "";
  }
}
