/**
 * The side panel — what almost every modal in Spaces should have been.
 *
 * A modal says "stop and answer this". Asking an agent, editing a task,
 * picking a link, scheduling a meeting: none of those are questions, they are
 * things you do *while* reading the work. A dialog blocks the view you were
 * reading, traps the keyboard, and makes you decide before you can go back and
 * check. A panel opens beside the work instead, and the work keeps working.
 *
 * That last part is the whole design, so it is worth being explicit about what
 * "non-blocking" costs us here:
 *
 *   - no backdrop above the breakpoint, so nothing eats a click. The app
 *     behind stays clickable, scrollable and selectable while a panel is open.
 *   - the panel does not float *over* the surface, it takes a gutter out of
 *     it. `reserve()` pads #root by the panel's width, so the pane shrinks the
 *     way it does for the inspector drawer and nothing is hidden underneath.
 *   - focus moves in on open and back to the trigger on close, but it is NOT
 *     trapped. Tabbing out of a panel into the work is the point.
 *
 * Escape still closes, because a surface you can dismiss without aiming is
 * cheaper to open — and cheap to open is what makes a panel better than a
 * dialog in the first place.
 *
 * Exports: <SidePanel>, usePanel() for the open/close state, and
 * <PanelSection> for the rhythm inside one.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { IconArrowLeft, IconX } from "./icons";
import "./sidepanel.css";

export type PanelSide = "right" | "left";

/* ── width ────────────────────────────────────────────────────── */

const KEY_PREFIX = "spaces.panel.";
const DEFAULT_W = 420;
const MIN_W = 300;
const MAX_W = 720;

/** Kept in step with the overlay breakpoint in sidepanel.css. */
const OVERLAY_BELOW = 1100;

/**
 * Never let a panel squeeze the surface it exists to sit beside — but only
 * while it is actually sitting beside it. Once it overlays, shrinking the
 * window must not quietly eat a width the user chose.
 */
function ceiling(): number {
  const vw = window.innerWidth;
  const room = vw < OVERLAY_BELOW ? vw - 44 : vw - 460;
  return Math.max(MIN_W, Math.min(MAX_W, room));
}

function clampWidth(n: number): number {
  return Math.max(MIN_W, Math.min(ceiling(), Math.round(n)));
}

function readWidth(storageKey: string | undefined, fallback: number): number {
  if (storageKey) {
    try {
      const saved = Number(localStorage.getItem(KEY_PREFIX + storageKey));
      if (Number.isFinite(saved) && saved > 0) return clampWidth(saved);
    } catch {
      /* private mode, or a hand-edited value — the default is always fine */
    }
  }
  return clampWidth(fallback);
}

function usePanelWidth(storageKey: string | undefined, initial: number) {
  const [width, setWidth] = useState(() => readWidth(storageKey, initial));
  const [dragging, setDragging] = useState(false);

  // Debounced so a drag writes once at rest rather than once per frame.
  useEffect(() => {
    if (!storageKey) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(KEY_PREFIX + storageKey, String(width));
      } catch {
        /* not worth surfacing: the panel still works, it just forgets */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [storageKey, width]);

  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The cursor and the selection block belong to the document, not the handle:
  // a drag that leaves the 7px strip must still feel like a drag.
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("sp-dragging");
    return () => document.documentElement.classList.remove("sp-dragging");
  }, [dragging]);

  return {
    width,
    setWidth: useCallback((n: number) => setWidth(clampWidth(n)), []),
    // Off the previous value rather than the rendered one: a held key repeats
    // faster than React commits, and every press has to count.
    nudge: useCallback((by: number) => setWidth((w) => clampWidth(w + by)), []),
    setDragging,
  };
}

function Grip({
  side,
  width,
  onWidth,
  onNudge,
  onReset,
  onDragging,
}: {
  side: PanelSide;
  width: number;
  onWidth: (n: number) => void;
  onNudge: (by: number) => void;
  onReset: () => void;
  onDragging: (on: boolean) => void;
}) {
  const active = useRef(false);

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    active.current = false;
    onDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      className="sp-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      aria-valuemax={MAX_W}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        active.current = true;
        onDragging(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        onWidth(side === "right" ? window.innerWidth - e.clientX : e.clientX);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        // Whichever arrow points away from the panel's own edge widens it.
        const wider = side === "right" ? "ArrowLeft" : "ArrowRight";
        const narrower = side === "right" ? "ArrowRight" : "ArrowLeft";
        if (e.key === wider) onNudge(step);
        else if (e.key === narrower) onNudge(-step);
        else if (e.key === "Home") onWidth(MAX_W);
        else if (e.key === "End") onWidth(MIN_W);
        else if (e.key === "Enter" || e.key === " ") onReset();
        else return;
        e.preventDefault();
      }}
    />
  );
}

/* ── the trailing edge ────────────────────────────────────────── */

/**
 * ONE RULE, EVERYWHERE: the trailing edge holds a single surface, and whatever
 * opened last owns it. Opening a panel closes the inspector drawer; opening
 * the inspector — from a chip inside a panel, say — closes the panel.
 *
 * They REPLACE rather than stack, and that is deliberate. Two drawers side by
 * side is 800px of chrome against a 1280px window: it turns the surface they
 * both exist to annotate into a column too narrow to read, and then asks the
 * user to work out which of the two right-hand things they are looking at. A
 * panel opened *from* a panel is a real case, and `stack` is the answer to it
 * — one surface, a back affordance, no second floating layer.
 *
 * Replacing is lossy, so a panel puts back what it displaced: if it took the
 * edge from the inspector and the edge is still empty when it closes, the
 * inspector comes back to the entity it was showing. The guard matters — if
 * anything else claimed the edge in between, that thing wins and we stay out.
 *
 * The inspector cannot be asked directly (it is bound to `store.inspect` and
 * has no handle of its own), which is why a UI primitive reaches for the store
 * here. That coupling is the price of not making every caller mediate between
 * two drawers by hand, and of the rule being the same everywhere.
 */
let edge: { close: () => void } | null = null;

/**
 * Take the panel's width out of the app rather than laying it over the top.
 * #root rather than the shell's own class: every surface in the app lives
 * inside it, it is already `overflow: hidden`, and the rule then belongs to
 * this component instead of reaching into a frame another file owns.
 */
function reserve(side: PanelSide, px: number) {
  const root = document.documentElement;
  root.dataset.hqPanel = side;
  root.style.setProperty("--spaces-panel-w", `${px}px`);
}

function release() {
  const root = document.documentElement;
  delete root.dataset.hqPanel;
  root.style.removeProperty("--spaces-panel-w");
}

/* ── stacking ─────────────────────────────────────────────────── */

interface PanelHost {
  width: number;
  setWidth: (n: number) => void;
  nudge: (by: number) => void;
  /** Back to the width the panel behind opened at, not the child's own. */
  reset: () => void;
  /** A child covers its parent for as long as it is mounted. */
  cover: () => () => void;
}

const PanelHostContext = createContext<PanelHost | null>(null);

/** Set on a panel that was opened from inside another one. */
export interface PanelStack {
  /** Return to the panel this one came from. Renders the back control. */
  back: () => void;
  /** What you are going back to: "Back to task" rather than "Back". */
  from?: string;
}

/* ── the panel ────────────────────────────────────────────────── */

export interface SidePanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Controls for the header, alongside the close button. */
  actions?: ReactNode;
  /** Primary actions. Pinned to the bottom, so a long body cannot bury them. */
  footer?: ReactNode;
  onClose: () => void;
  /** Starting width, until the user drags the divider. */
  width?: number;
  /** Remembers this panel's width under `spaces.panel.<storageKey>`. */
  storageKey?: string;
  /** Which edge it comes from. The trailing edge unless there is a reason. */
  side?: PanelSide;
  /** Opened from within another panel: same surface, plus a way back. */
  stack?: PanelStack;
  children: ReactNode;
  className?: string;
}

export function SidePanel({
  title,
  subtitle,
  actions,
  footer,
  onClose,
  width: initialWidth = DEFAULT_W,
  storageKey,
  side = "right",
  stack,
  children,
  className,
}: SidePanelProps) {
  const host = useContext(PanelHostContext);
  const nested = host !== null;
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // A stacked panel is the same surface showing a different page, so it takes
  // its parent's width and its divider drives the parent's — resizing the
  // child and finding the parent a different size on the way back would be
  // two panels pretending to be one.
  const own = usePanelWidth(nested ? undefined : storageKey, initialWidth);
  const width = host ? host.width : own.width;
  const setWidth = host ? host.setWidth : own.setWidth;
  const nudgeWidth = useCallback(
    (by: number) => (host ? host.nudge(by) : own.nudge(by)),
    [host, own.nudge]
  );
  const resetWidth = useCallback(
    () => (host ? host.reset() : own.setWidth(initialWidth)),
    [host, own.setWidth, initialWidth]
  );

  // How many panels this one is currently hosting. Non-zero means something is
  // in front of us: we stop drawing, stop taking tabs and stop taking Escape.
  const [covering, setCovering] = useState(0);
  const covered = covering > 0;

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const backRef = useRef(stack?.back);
  backRef.current = stack?.back;

  /* Claim the edge, and hand it back on the way out. */
  useEffect(() => {
    if (nested) return; // the root panel of the stack already holds it
    const me = { close: () => closeRef.current() };
    const previous = edge;
    edge = me;
    previous?.close();

    const displaced = useStore.getState().inspect;
    if (displaced) useStore.getState().setInspect(null);

    // The other tenant can be opened from inside this panel — a chip in a
    // connections list, a run in a history row. It wins, and we step off.
    const stop = useStore.subscribe((state, prev) => {
      if (state.inspect && state.inspect !== prev.inspect) me.close();
    });

    return () => {
      stop();
      // Someone else took the edge while we were closing; the gutter and the
      // inspector are their business now.
      if (edge !== me) return;
      edge = null;
      release();
      if (displaced && !useStore.getState().inspect) {
        useStore.getState().setInspect(displaced);
      }
    };
  }, [nested]);

  /* Keep the reserved gutter in step with the width. Cleanup lives in the
     claim effect above, which is the one that knows whether we still own it. */
  useEffect(() => {
    if (nested) return;
    reserve(side, width);
  }, [nested, side, width]);

  /* Register with the panel behind us, if there is one. Bound to the callback
     rather than the whole context, which changes on every width tick. */
  const coverHost = host?.cover;
  useEffect(() => coverHost?.(), [coverHost]);

  /* Focus moves in, and goes back to whatever opened us. It is not trapped:
     tabbing out into the work is the entire difference from a dialog.
     Deliberately mount-only: a panel opening in front of this one must not
     make this one grab focus back when it closes again. */
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const target =
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panelRef.current;
    target?.focus();

    return () => {
      if (!restore?.isConnected) return;
      const active = document.activeElement;
      // The user clicked away and is somewhere else entirely; yanking focus
      // back would be worse than losing it.
      if (active && active !== document.body && !panelRef.current?.contains(active)) return;
      restore.focus();
    };
  }, []);

  /* Stepping behind another panel and back again is the one case the rule
     above cannot serve: the control that opened the panel in front is *inside*
     this one, and a hidden element refuses focus, so the closing panel's own
     restore lands nowhere. Each panel parks its own keyboard position instead,
     and puts it back once it is on screen again. */
  const parked = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (covered) return;
    const back = parked.current;
    parked.current = null;
    if (back?.isConnected && panelRef.current?.contains(back)) back.focus();
  }, [covered]);

  /* Escape belongs to the topmost surface. */
  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A modal, the palette or a confirm is stacked above us, and each of
      // them owns Escape while it is up. None owns a flag we could read.
      if (document.querySelector(".modal-backdrop, .palette-backdrop, .tcf-backdrop")) return;
      e.preventDefault();
      (backRef.current ?? closeRef.current)();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [covered]);

  const cover = useCallback(() => {
    // Read now, not in the render that hides us: by then the panel in front
    // has taken focus and this panel's own trigger is no longer the answer.
    const active = document.activeElement as HTMLElement | null;
    if (active && panelRef.current?.contains(active)) parked.current = active;
    setCovering((n) => n + 1);
    return () => setCovering((n) => n - 1);
  }, []);

  const context = useMemo<PanelHost>(
    () => ({ width, setWidth, nudge: nudgeWidth, reset: resetWidth, cover }),
    [width, setWidth, nudgeWidth, resetWidth, cover]
  );

  return createPortal(
    <PanelHostContext.Provider value={context}>
      {/* Below the breakpoint the panel floats over the surface instead of
          beside it, and the scrim is the pointer's way out. Above it there is
          no scrim at all — see the header of this file. */}
      {!nested && <div className="sp-scrim" aria-hidden="true" onMouseDown={onClose} />}

      <aside
        className={"sp" + (className ? ` ${className}` : "")}
        data-side={side}
        data-covered={covered ? "1" : undefined}
        style={{ "--sp-w": `${width}px` } as CSSProperties}
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={(el) => {
          panelRef.current = el;
        }}
      >
        <Grip
          side={side}
          width={width}
          onWidth={setWidth}
          onNudge={nudgeWidth}
          onReset={resetWidth}
          onDragging={own.setDragging}
        />

        <header className="sp-head">
          {stack && (
            <button type="button" className="sp-back" onClick={stack.back}>
              <IconArrowLeft size={13} />
              {stack.from ? `Back to ${stack.from}` : "Back"}
            </button>
          )}

          <div className="sp-head-row">
            <div className="sp-head-text">
              <h2 className="sp-title" id={titleId}>
                {title}
              </h2>
              {subtitle && <div className="sp-sub">{subtitle}</div>}
            </div>
            <div className="sp-tools">
              {actions}
              <button
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="Close panel"
                title="Close panel (Esc)"
              >
                <IconX size={13} />
              </button>
            </div>
          </div>
        </header>

        <div className="sp-body">{children}</div>

        {footer && <footer className="sp-foot">{footer}</footer>}
      </aside>
    </PanelHostContext.Provider>,
    document.body
  );
}

/* ── sections ─────────────────────────────────────────────────── */

/**
 * A run of related fields under a quiet heading. Space and a heading are the
 * whole mechanism — a panel is 400px wide, and boxing anything inside one
 * leaves a column of nested rectangles.
 */
export function PanelSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="sp-section">
      <h3 className="sp-section-title">{title}</h3>
      {children}
    </section>
  );
}

/* ── the controller ───────────────────────────────────────────── */

export interface PanelController<T> {
  open: boolean;
  /** What the panel was opened with, or null while it is closed. */
  data: T | null;
  show: (value?: T) => void;
  hide: () => void;
  toggle: (value?: T) => void;
}

/**
 * Open/close state for one panel, so callers stop reinventing it.
 *
 *   const edit = usePanel<Task>();
 *   <button onClick={() => edit.show(task)}>Edit</button>
 *   {edit.data && <SidePanel title={edit.data.title} onClose={edit.hide}>…</SidePanel>}
 *
 * `data` is what makes it worth having: rendering the panel off the value it
 * was opened with means it can never be open with nothing to show, and the
 * panel's contents unmount on close instead of holding a stale row.
 */
export function usePanel<T = true>(): PanelController<T> {
  const [state, setState] = useState<{ value: T } | null>(null);

  const show = useCallback((value?: T) => setState({ value: (value ?? true) as T }), []);
  const hide = useCallback(() => setState(null), []);
  const toggle = useCallback(
    (value?: T) => setState((s) => (s ? null : { value: (value ?? true) as T })),
    []
  );

  return useMemo(
    () => ({ open: state !== null, data: state ? state.value : null, show, hide, toggle }),
    [state, show, hide, toggle]
  );
}
