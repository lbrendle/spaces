/**
 * The app shell — one frame every surface hangs off.
 *
 * Before this, App.tsx was a bare flex row and each view invented its own
 * header, scroll container and padding. That is why two surfaces never quite
 * agreed on where a title sits, and why a 3000px window made every list a
 * mile wide. Everything spatial now lives here:
 *
 *   Shell      the rail + content frame, and the only thing that knows about
 *              the titlebar, the breakpoints and the drag region
 *   Pane       the standard surface: header, then a scroll container
 *   SplitPane  a persisted, keyboard-resizable two-column split
 *   Toolbar    the filter / search / sort row inside a pane body
 *
 * The rail's contents are passed in, so <Sidebar /> stays a component about
 * navigation and knows nothing about being 56px wide. Where a mini rail needs
 * something that markup doesn't carry (a label for an icon-only row), the
 * shell mirrors it onto the DOM it was handed rather than reaching into that
 * component — see useRailLabels.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconArrowLeft, IconArrowRight } from "./icons";
import "./shell.css";

/* ── the rail ─────────────────────────────────────────────────── */

const RAIL_MIN = 190;
const RAIL_MAX = 420;
/** Under this the rail is worth more as an icon strip than as labels. */
const MINI_BELOW = 1100;
/** Under this there is no room for a rail at all — it floats instead. */
const OVERLAY_BELOW = 760;

const WIDTH_KEY = "spaces.shell.rail-width";
const PREF_KEY = "spaces.shell.rail-pref";
const SPLIT_KEY = "spaces.shell.split.";

type RailMode = "full" | "mini" | "overlay";
/** "auto" = whatever the window size calls for; the rest is the user saying so. */
type RailPref = "auto" | "full" | "mini";
type Tier = "wide" | "narrow" | "tight";

function tierOf(width: number): Tier {
  if (width < OVERLAY_BELOW) return "tight";
  if (width < MINI_BELOW) return "narrow";
  return "wide";
}

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    /* private mode, or a hand-edited value — a default is always fine */
    return "";
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* not worth surfacing: the layout still works, it just forgets */
  }
}

/**
 * Never let the rail squeeze the content pane down to nothing, and re-clamp
 * when the window shrinks — but only against the live window, so restoring a
 * large window gives back the width the user chose.
 */
function clampRail(n: number): number {
  const ceiling = Math.max(RAIL_MIN, Math.min(RAIL_MAX, window.innerWidth - 420));
  return Math.max(RAIL_MIN, Math.min(ceiling, Math.round(n)));
}

function useRail() {
  const [tier, setTier] = useState<Tier>(() => tierOf(window.innerWidth));
  const [pref, setPref] = useState<RailPref>(() => {
    const raw = readStored(PREF_KEY);
    return raw === "full" || raw === "mini" ? raw : "auto";
  });
  // null means "follow --sidebar-w", which the theme scales with the type size.
  // Only a deliberate drag pins a pixel width.
  const [width, setWidth] = useState<number | null>(() => {
    const n = Number(readStored(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? clampRail(n) : null;
  });
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const lastTier = useRef(tier);
  useEffect(() => {
    const onResize = () => {
      const next = tierOf(window.innerWidth);
      if (next !== lastTier.current) {
        lastTier.current = next;
        setTier(next);
        // Crossing a breakpoint is a strong signal that the old answer no
        // longer fits, so the layout takes the wheel back. Within one window
        // size the user's choice always wins.
        setPref("auto");
      }
      setWidth((w) => (w === null ? w : clampRail(w)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    writeStored(PREF_KEY, pref === "auto" ? null : pref);
  }, [pref]);

  // Debounced so a drag writes once at rest rather than once per frame.
  useEffect(() => {
    const t = window.setTimeout(
      () => writeStored(WIDTH_KEY, width === null ? null : String(width)),
      250
    );
    return () => clearTimeout(t);
  }, [width]);

  const mode: RailMode =
    tier === "tight" ? "overlay" : pref === "auto" ? (tier === "narrow" ? "mini" : "full") : pref;

  useEffect(() => {
    if (mode !== "overlay") setOverlayOpen(false);
  }, [mode]);

  // Changing shape animates; changing width does not. A resize has to answer
  // the pointer — or the key — frame for frame, and a 200ms tween in the
  // middle of that reads as lag and makes a held arrow key crawl.
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    setAnimating(true);
    const t = window.setTimeout(() => setAnimating(false), 260);
    return () => clearTimeout(t);
  }, [mode]);

  // The cursor and the selection block belong to the document, not the handle:
  // a drag that leaves the 7px strip must still feel like a drag.
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("sh-dragging");
    return () => document.documentElement.classList.remove("sh-dragging");
  }, [dragging]);

  return {
    mode,
    width,
    animating,
    overlayOpen,
    setOverlayOpen,
    setDragging,
    setWidth: (n: number) => setWidth(clampRail(n)),
    /** `from` seeds the first nudge, when the rail is still the theme's width. */
    nudgeWidth: (by: number, from: number) =>
      setWidth((w) => clampRail(clampRail(w ?? from) + by)),
    resetWidth: () => setWidth(null),
    toggle: () => {
      if (mode === "overlay") setOverlayOpen((v) => !v);
      else setPref(mode === "mini" ? "full" : "mini");
    },
  };
}

/**
 * A mini rail shows glyphs, and a glyph with no name is a guessing game. The
 * rows come from <Sidebar />, which has no reason to carry a tooltip for a
 * label it can already see — so the shell mirrors what the narrow form needs
 * onto the nodes it was handed: a native `title` for icon-only rows, and an
 * initial for project rows, which have no icon at all.
 *
 * A native tooltip rather than a styled one on purpose: the rail is a scroll
 * container, so anything drawn inside it gets clipped at 56px.
 */
function useRailLabels(ref: RefObject<HTMLDivElement | null>, mini: boolean) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !mini) return;

    const decorate = () => {
      for (const el of root.querySelectorAll<HTMLElement>(".nav-item")) {
        // Own text only: the badges and counters a row carries are decoration,
        // and "general3" is not the name of a channel.
        const label = Array.from(el.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .trim();
        if (!label || el.title) continue;
        el.title = label;
        el.dataset.shTip = "1"; // so expanding can take back exactly what we set
      }
      for (const el of root.querySelectorAll<HTMLElement>(".project-open")) {
        const label = (el.textContent ?? "").trim();
        if (label) el.dataset.initial = label.slice(0, 1).toUpperCase();
      }
    };

    decorate();
    // Channels and projects arrive from the store long after mount, and a
    // rename has to reach the tooltip too. We only ever write attributes, so
    // watching children and text cannot feed back into this observer.
    const watcher = new MutationObserver(decorate);
    watcher.observe(root, { childList: true, subtree: true, characterData: true });

    return () => {
      watcher.disconnect();
      for (const el of root.querySelectorAll<HTMLElement>("[data-sh-tip]")) {
        el.removeAttribute("title");
        delete el.dataset.shTip;
      }
    };
  }, [ref, mini]);
}

function RailGrip({
  width,
  onWidth,
  onNudge,
  onReset,
  onDragging,
}: {
  /** Measured, so the keyboard can start from the theme's width. */
  width: number;
  onWidth: (n: number) => void;
  onNudge: (by: number, from: number) => void;
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
      className="sh-rail-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN}
      aria-valuemax={RAIL_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        active.current = true;
        onDragging(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        // The rail starts at the left edge, so the pointer's x *is* the width.
        if (active.current) onWidth(e.clientX);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowRight") onNudge(step, width);
        else if (e.key === "ArrowLeft") onNudge(-step, width);
        else if (e.key === "Home") onWidth(RAIL_MIN);
        else if (e.key === "End") onWidth(RAIL_MAX);
        else if (e.key === "Enter" || e.key === " ") onReset();
        else return;
        e.preventDefault();
      }}
    />
  );
}

function toggleHint(mode: RailMode): string {
  if (mode === "overlay") return "Hide navigation";
  return mode === "mini" ? "Expand sidebar" : "Collapse sidebar";
}

export function Shell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const rail = useRail();
  const railRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const [railW, setRailW] = useState(0);
  const floating = rail.mode === "overlay";
  const open = floating && rail.overlayOpen;

  useRailLabels(bodyRef, rail.mode === "mini");

  // Measured rather than assumed: with no pinned width the rail is whatever
  // --sidebar-w says, and the keyboard resize has to start from the truth.
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const measure = () => setRailW(Math.round(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A floating rail is a modal-ish thing: it takes focus, Escape dismisses it,
  // and focus goes back to the control that opened it.
  useEffect(() => {
    if (!open) return;
    railRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      rail.setOverlayOpen(false);
      menuRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      className="sh-app"
      data-rail={rail.mode}
      data-rail-open={open ? "1" : undefined}
      data-animate={rail.animating ? "1" : undefined}
      style={rail.width === null ? undefined : ({ "--sidebar-w": `${rail.width}px` } as CSSProperties)}
    >
      {/* The macOS traffic lights sit over our own chrome, so the top strip is
          reserved by --titlebar everywhere and stays a window drag handle. */}
      <div className="sh-drag" data-tauri-drag-region />

      {floating && (
        <button
          ref={menuRef}
          className="sh-menu"
          aria-label={open ? "Hide navigation" : "Show navigation"}
          aria-expanded={open}
          aria-controls="sh-rail"
          onClick={rail.toggle}
        >
          {open ? <IconArrowLeft size={15} /> : <IconArrowRight size={15} />}
        </button>
      )}

      <aside
        id="sh-rail"
        ref={railRef}
        className="sh-rail"
        aria-label="Primary"
        aria-hidden={floating && !open ? true : undefined}
        tabIndex={-1}
        onClick={
          floating
            ? (e) => {
                // Picking a destination is the whole point of opening it.
                if ((e.target as HTMLElement).closest(".nav-item, .project-open")) {
                  rail.setOverlayOpen(false);
                }
              }
            : undefined
        }
      >
        <div className="sh-rail-body" ref={bodyRef}>
          {sidebar}
        </div>
        <div className="sh-rail-foot">
          <button
            className="icon-btn sh-rail-toggle"
            onClick={rail.toggle}
            title={toggleHint(rail.mode)}
            aria-label={toggleHint(rail.mode)}
          >
            {rail.mode === "mini" ? <IconArrowRight size={14} /> : <IconArrowLeft size={14} />}
            <span className="sh-rail-toggle-label">
              {rail.mode === "overlay" ? "Close" : "Collapse"}
            </span>
          </button>
        </div>
        {rail.mode === "full" && (
          <RailGrip
            width={railW}
            onWidth={rail.setWidth}
            onNudge={rail.nudgeWidth}
            onReset={rail.resetWidth}
            onDragging={rail.setDragging}
          />
        )}
      </aside>

      {floating && (
        <div
          className="sh-scrim"
          onClick={() => rail.setOverlayOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* A row, not a column: the inspector drawer is a sibling of the active
          surface and has to keep sitting beside it. */}
      <div className="sh-main">{children}</div>
    </div>
  );
}

/* ── Pane ─────────────────────────────────────────────────────── */

/**
 * `true` caps the measure at the shell default, `false` lets the surface run
 * edge to edge, a number is a px cap and a string is any CSS length.
 */
export type PaneMax = boolean | number | string;

function measureStyle(max: PaneMax): CSSProperties | undefined {
  if (typeof max === "boolean") return undefined;
  return { "--sh-measure": typeof max === "number" ? `${max}px` : max } as CSSProperties;
}

/**
 * The standard surface frame. One header, one scroll container, one padding
 * rhythm — so a view only has to describe itself and hand over its content.
 *
 * `scroll={false}` gives the body to a surface that scrolls its own regions
 * (a board with per-column scroll, a calendar grid). `max={false}` opts out of
 * the comfortable measure for anything that genuinely wants the whole window.
 */
export function Pane({
  title,
  subtitle,
  actions,
  children,
  scroll = true,
  max = true,
  pad = true,
  className,
  onKeyDown,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  max?: PaneMax;
  /** The body's own padding. Off for surfaces that draw to the edge. */
  pad?: boolean;
  className?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const capped = max !== false;
  const style = measureStyle(max);

  const head = (
    <div className="sh-pane-head-row">
      <div className="sh-pane-head-text">
        <h1 className="sh-pane-title">{title}</h1>
        {subtitle ? <div className="sh-pane-sub">{subtitle}</div> : null}
      </div>
      {actions && <div className="sh-pane-actions">{actions}</div>}
    </div>
  );

  return (
    <section
      className={"sh-pane" + (className ? ` ${className}` : "")}
      style={style}
      onKeyDown={onKeyDown}
    >
      <header className="sh-pane-head">
        {capped ? <div className="sh-measure">{head}</div> : head}
      </header>
      <div className="sh-pane-body" data-scroll={scroll ? "1" : "0"} data-pad={pad ? "1" : "0"}>
        {capped ? <div className="sh-measure">{children}</div> : children}
      </div>
    </section>
  );
}

/* ── Toolbar ──────────────────────────────────────────────────── */

/** The filter / search / sort row that sits at the top of a pane body. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={"sh-toolbar" + (className ? ` ${className}` : "")}>{children}</div>;
}

/** Controls that belong together. `grow` gives the row's slack to this group. */
export function ToolbarGroup({
  children,
  grow,
  end,
}: {
  children: ReactNode;
  grow?: boolean;
  /** Pin the group to the trailing edge of the row. */
  end?: boolean;
}) {
  return (
    <div
      className="sh-toolbar-group"
      data-grow={grow ? "1" : undefined}
      data-end={end ? "1" : undefined}
    >
      {children}
    </div>
  );
}

/* ── SplitPane ────────────────────────────────────────────────── */

/**
 * A two-column split that remembers its width per key, hands the divider to
 * the keyboard, and folds into one column when the space runs out. Measured
 * against its own box rather than the window, so a collapsed rail or an open
 * inspector changes the answer — which is the point.
 *
 * Pair it with `<Pane scroll={false}>`: each side scrolls independently, which
 * is the reason to want a split in the first place.
 */
export function SplitPane({
  left,
  right,
  storageKey,
  minLeft = 220,
  defaultLeft = 320,
  minRight = 320,
  stackBelow = 720,
  label = "Resize columns",
}: {
  left: ReactNode;
  right: ReactNode;
  /** Namespaced per surface, so two splits never share a width. */
  storageKey: string;
  minLeft?: number;
  defaultLeft?: number;
  minRight?: number;
  /** Container width, not window width. */
  stackBelow?: number;
  label?: string;
}) {
  const key = SPLIT_KEY + storageKey;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [hostW, setHostW] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(() => {
    const n = Number(readStored(key));
    return Number.isFinite(n) && n > 0 ? n : defaultLeft;
  });

  // Measured on mount, not just observed: the observer's first callback lands
  // a frame late, and one frame of an unclamped split is a visible jump. The
  // window listener is the cheap half of the answer, the observer the half
  // that catches the rail collapsing without the window moving at all.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setHostW(Math.round(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Until the box has been measured there is nothing to clamp against, so the
  // stored width stands. Clamping to a 0-wide host would forget it instead.
  const ceiling = hostW > 0 ? Math.max(minLeft, hostW - minRight) : Number.POSITIVE_INFINITY;
  const clamp = (n: number) => Math.max(minLeft, Math.min(ceiling, Math.round(n)));
  const stacked = hostW > 0 && hostW < stackBelow;
  const shown = stacked ? width : clamp(width);

  useEffect(() => {
    const t = window.setTimeout(() => writeStored(key, String(width)), 250);
    return () => clearTimeout(t);
  }, [key, width]);

  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("sh-dragging");
    return () => document.documentElement.classList.remove("sh-dragging");
  }, [dragging]);

  const active = useRef(false);
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      ref={hostRef}
      className="sh-split"
      data-stacked={stacked ? "1" : undefined}
      data-dragging={dragging ? "1" : undefined}
      style={{ "--sh-split-left": `${shown}px` } as CSSProperties}
    >
      <div className="sh-split-side">{left}</div>
      {!stacked && (
        <div
          className="sh-split-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuenow={shown}
          aria-valuemin={minLeft}
          aria-valuemax={Number.isFinite(ceiling) ? ceiling : minLeft}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            active.current = true;
            setDragging(true);
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!active.current) return;
            const box = hostRef.current?.getBoundingClientRect();
            if (box) setWidth(clamp(e.clientX - box.left));
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onDoubleClick={() => setWidth(clamp(defaultLeft))}
          onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
            const step = e.shiftKey ? 48 : 16;
            // Off the previous value rather than the rendered one: a held key
            // repeats faster than React commits, and every press must count.
            const nudge = (by: number) => setWidth((w) => clamp(clamp(w) + by));
            if (e.key === "ArrowRight") nudge(step);
            else if (e.key === "ArrowLeft") nudge(-step);
            else if (e.key === "Home") setWidth(clamp(minLeft));
            else if (e.key === "End") setWidth(clamp(ceiling));
            else if (e.key === "Enter" || e.key === " ") setWidth(clamp(defaultLeft));
            else return;
            e.preventDefault();
          }}
        />
      )}
      <div className="sh-split-main">{right}</div>
    </div>
  );
}
