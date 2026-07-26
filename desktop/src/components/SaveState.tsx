/**
 * The save indicator, and the two wrappers editors put around it.
 *
 * "Is my work safe?" must have exactly one answer in Spaces — same words, same
 * timing, same colour — whether you are editing a memory entry, a document, an
 * agent's instructions or a team charter. An app that says "Saved" three
 * different ways is an app you check twice, and checking twice is the habit
 * autosave was supposed to kill.
 *
 * Three rules, in the same spirit as src/autosave.ts:
 *
 *   1. **Silence is the resting state.** A permanent "Saved" badge is
 *      wallpaper: the eye stops reading it, so it stops meaning anything. Idle
 *      renders nothing, and the badge earns its place by having just changed.
 *   2. **Never pop.** Every change of state cross-fades, and the relative time
 *      re-words inside a pinned, tabular-numeral box. Reassurance that twitches
 *      is not reassurance.
 *   3. **An error is the one thing allowed to shout,** and it never leaves on
 *      its own. A failure that fades out is a failure you did not see, and the
 *      text is still sitting unsaved in the editor behind it.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { saveLabel, type Autosave } from "../autosave";
import { timeAgo } from "../github";
import { IconCheck, IconRefresh } from "./icons";
import { Spinner } from "./ui";
import "./savestate.css";

/**
 * Everything these components read off an autosave.
 *
 * Deliberately narrower than `Autosave<T>`: `reset(to?: T)` makes the full
 * interface invariant in T, so a component typed against `Autosave<unknown>`
 * would reject an editor's `Autosave<string>` and force a cast at every call
 * site. Nothing below mentions T, so this shape accepts all of them.
 */
export type SaveStatus = Pick<Autosave<unknown>, "state" | "savedAt" | "error" | "dirty" | "flush">;

/** Matches --dur. Only decides when the outgoing frame unmounts, so drift is harmless. */
const FADE_MS = 200;
/** Under a minute, "Saved" is both truer and calmer than "Saved 12s ago". */
const FRESH_MS = 60_000;
/**
 * The label only re-words at minute granularity, so a quarter-minute tick keeps
 * it honest without putting a per-second timer inside every open editor.
 */
const TICK_MS = 15_000;

type Phase = "dirty" | "saving" | "saved" | "error";

interface Frame {
  phase: Phase;
  /** The whole sentence for the inline states; the headline for an error. */
  label: string;
  /** An error's reason, on its own line so a long stderr stays readable. */
  detail: string;
  /** True once the label has gone relative — the moment its width must be pinned. */
  relative: boolean;
  /** Exact moment of the save, for the tooltip that "2m ago" cannot give you. */
  at: number;
}

/** What the indicator should be showing right now, or nothing at all. */
function frameFor(a: SaveStatus): Frame | null {
  if (a.state === "idle") return null;
  if (a.state === "saved") {
    const relative = a.savedAt > 0 && Date.now() - a.savedAt >= FRESH_MS;
    return {
      phase: "saved",
      label: relative ? `Saved ${timeAgo(a.savedAt)}` : "Saved",
      detail: "",
      relative,
      at: a.savedAt,
    };
  }
  if (a.state === "error") {
    // saveLabel's sentence is "Not saved — reason"; it is set on two lines here
    // so a wrapped stack trace cannot push the headline off the row. Same
    // words, more readable shape — the one-line form is kept as the tooltip.
    return { phase: "error", label: "Not saved", detail: a.error, relative: false, at: 0 };
  }
  return { phase: a.state, label: saveLabel(a), detail: "", relative: false, at: 0 };
}

/** Local, like Toasts.tsx's: icons.tsx has no alert mark and it is not our file. */
const IconAlert = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 3.6L21 19.5H3L12 3.6z" />
    <path d="M12 10v4M12 17.2v.2" />
  </svg>
);

function FrameBody({ frame, onRetry }: { frame: Frame; onRetry?: () => void }) {
  if (frame.phase === "error") {
    return (
      <>
        <span className="svst-glyph" aria-hidden="true">
          <IconAlert />
        </span>
        <span className="svst-copy">
          <span className="svst-title">{frame.label}</span>
          {frame.detail && (
            <span className="svst-detail" title={frame.detail}>
              {frame.detail}
            </span>
          )}
        </span>
        <button type="button" className="svst-retry" onClick={onRetry}>
          <IconRefresh size={12} />
          Retry
        </button>
      </>
    );
  }
  if (frame.phase === "saving") {
    return (
      <>
        <Spinner />
        <span className="svst-text">{frame.label}</span>
      </>
    );
  }
  if (frame.phase === "saved") {
    return (
      <>
        <span className="svst-glyph svst-tick" aria-hidden="true">
          <IconCheck size={12} />
        </span>
        <span
          className="svst-text"
          title={frame.at ? `Saved at ${new Date(frame.at).toLocaleTimeString()}` : undefined}
        >
          {frame.label}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="svst-dot" aria-hidden="true" />
      <span className="svst-text">{frame.label}</span>
    </>
  );
}

function frameClass(f: Frame): string {
  return `svst-frame svst-f-${f.phase}${f.relative ? " svst-rel" : ""}`;
}

export interface SaveStateProps {
  autosave: SaveStatus;
  /**
   * Drop the wording down to the glyph alone, for a toolbar with no room for a
   * sentence. Errors ignore it: an unmissable state that is a red dot is a
   * state nobody notices.
   */
  compact?: boolean;
}

/**
 * The inline indicator. Put it wherever the eye already is when you stop
 * typing — beside the field's label, or in a SaveBar.
 */
export function SaveState({ autosave, compact }: SaveStateProps) {
  const { state, savedAt, flush } = autosave;

  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (state !== "saved" || !savedAt) return;
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [state, savedAt]);

  const frame = frameFor(autosave);
  // The cross-fade keys off a change of *state*, not off every re-wording: the
  // minute ticks swap silently inside a pinned box. A fade in the corner of the
  // eye once a minute, forever, is exactly the distraction this file exists to
  // avoid.
  const key = frame ? `${frame.phase}:${frame.relative ? "rel" : "fresh"}:${frame.detail}` : "";

  const [leaving, setLeaving] = useState<Frame | null>(null);
  const shown = useRef<{ key: string; frame: Frame | null }>({ key, frame });
  const exit = useRef(0);

  // No dependency array on purpose: this has to see every commit to know what
  // was actually on screen a moment ago, and the exit timer lives in a ref
  // rather than in the cleanup so re-running the effect cannot cancel a fade
  // that is still playing.
  useEffect(() => {
    const before = shown.current;
    shown.current = { key, frame };
    if (before.key === key || !before.frame) return;
    window.clearTimeout(exit.current);
    setLeaving(before.frame);
    exit.current = window.setTimeout(() => setLeaving(null), FADE_MS);
  });

  useEffect(() => () => window.clearTimeout(exit.current), []);

  return (
    <div
      className={`svst${compact ? " svst-compact" : ""}`}
      // Mounted even when there is nothing to say: screen readers only announce
      // into a live region that existed before the change, and the first thing
      // this region ever says is the one that matters most.
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* The outgoing copy is keyed by phase so a second change inside the fade
          remounts it and replays the exit, rather than inheriting the tail of
          an animation belonging to a state that is now two steps back. */}
      {leaving && (
        <div key={`out-${leaving.phase}`} className={`${frameClass(leaving)} svst-leaving`} inert>
          <FrameBody frame={leaving} />
        </div>
      )}
      {frame && (
        <div key={key} className={frameClass(frame)}>
          <FrameBody frame={frame} onRetry={() => void flush()} />
        </div>
      )}
    </div>
  );
}

/* ── closing an editor ────────────────────────────────────────── */

export interface CloseGuard {
  /**
   * Flush, then resolve once the write has actually landed — `true` if it is
   * safe to close, `false` if the save failed and the editor must stay open
   * with the error on screen.
   */
  close: () => Promise<boolean>;
  /** A close is waiting on a save. Disable the button, do not tear the editor down. */
  closing: boolean;
}

/**
 * The one dirty check editors should use when they close.
 *
 * Hand-rolled versions all get the same thing wrong: they call `flush()` and
 * close in the same breath, which unmounts the editor while the write is in
 * flight and turns a failure into silence. This one waits for the write, then
 * waits for React to commit the state that reports how it went, and only then
 * tells the caller whether closing is safe.
 */
export function useCloseGuard(autosave: SaveStatus): CloseGuard {
  const [closing, setClosing] = useState(false);

  // Refs so the handler keeps one identity for the life of the editor — a
  // close handler that changes every render is one that re-arms every dialog
  // and shortcut bound to it.
  const latest = useRef(autosave);
  latest.current = autosave;
  const alive = useRef(true);
  const waiters = useRef<(() => void)[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // Drains after every commit, which is the point: whoever is waiting wanted
  // the render that carries the save's outcome, not the one before it.
  useEffect(() => {
    if (!waiters.current.length) return;
    const queue = waiters.current;
    waiters.current = [];
    for (const done of queue) done();
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Never leave a caller awaiting a commit that will not come.
      const queue = waiters.current;
      waiters.current = [];
      for (const done of queue) done();
    };
  }, []);

  const close = useCallback(async (): Promise<boolean> => {
    setClosing(true);
    try {
      // `flush()` resolves when the write resolves, but the "saved" / "error"
      // it produced is still a queued setState at that point — reading state
      // here would read the previous render. `bump()` guarantees the next
      // commit happens even if nothing else changed, and that commit
      // necessarily includes the queued update.
      await latest.current.flush();
      await new Promise<void>((resolve) => {
        waiters.current.push(resolve);
        bump();
      });
      return latest.current.state !== "error";
    } finally {
      if (alive.current) setClosing(false);
    }
  }, []);

  return { close, closing };
}

/* ── modal footer ─────────────────────────────────────────────── */

export interface SaveBarProps {
  autosave: SaveStatus;
  /** Called only once the save has landed. Omit for a footer with no exit. */
  onDone?: () => void;
  /** Extra actions, laid out to the left of Done. */
  children?: ReactNode;
}

/**
 * The footer strip for modal editors: state on one side, actions on the other.
 *
 * Done flushes first and closes second, so the last sentence typed before the
 * click is on disk before the modal goes. If the save fails the modal stays put
 * with the error showing — clicking Done again simply tries the write once more.
 *
 * ⌘S stays the editor's business (`useSaveShortcut`); binding it here would
 * fight every editor that already binds it.
 */
export function SaveBar({ autosave, onDone, children }: SaveBarProps) {
  const { close, closing } = useCloseGuard(autosave);

  return (
    <div className="svbar">
      <SaveState autosave={autosave} />
      <div className="svbar-actions">
        {children}
        {onDone && (
          <button
            type="button"
            className="btn primary"
            disabled={closing}
            onClick={() => void close().then((ok) => ok && onDone())}
          >
            {closing ? "Saving…" : "Done"}
          </button>
        )}
      </div>
    </div>
  );
}
