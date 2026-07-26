/**
 * The one component every reference to anything renders through.
 *
 * A link picker, a backlink list, an assignee row, a graph tooltip and a
 * mention inside chat text are all the same problem: show *that thing* in a
 * word, let me get to it, tell me more if I linger. Solving it once here is
 * what keeps a new entity kind (added in entities.ts) free everywhere else.
 *
 * Chips read the store live rather than a snapshot — renaming a task has to
 * rename it on every card that points at it, or the graph starts lying.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { describeEntity, KIND_BY_TYPE } from "../entities";
import type { EntityInfo } from "../entities";
import { assigneesOf, connectionsFor } from "../links";
import { refKey } from "../types";
import type { EntityRef } from "../types";
import { Avatar, Markdown } from "./ui";
import { IconX } from "./icons";
import "./entitychip.css";

/* ── live entity data ─────────────────────────────────────────── */

/** Everything a chip or card actually paints, as one comparable string. */
function signature(i: EntityInfo): string {
  return [
    i.title, i.subtitle, i.body, i.glyph, i.tone, i.href,
    i.exists ? "1" : "0", i.view ? JSON.stringify(i.view) : "",
  ].join("\u0000");
}

const subscribeToStore = (onChange: () => void) => useStore.subscribe(onChange);

/**
 * `describeEntity` projects the store, so it must be re-run on every store
 * change — but it builds a fresh object each call, and useSyncExternalStore
 * treats a fresh object as a change and re-renders forever. Hence the cache:
 * recompute always, hand back the previous object unless something visible
 * actually moved.
 */
export function useEntity(ref: EntityRef): EntityInfo {
  const key = refKey(ref);
  const cache = useRef<{ key: string; sig: string; info: EntityInfo } | null>(null);

  const snapshot = useCallback(() => {
    const info = describeEntity({ type: ref.type, id: ref.id });
    const sig = signature(info);
    const hit = cache.current;
    if (hit && hit.key === key && hit.sig === sig) return hit.info;
    cache.current = { key, sig, info };
    return info;
    // `key` is the whole of `ref` that this reads, so it is the whole dep.
  }, [key]);

  return useSyncExternalStore(subscribeToStore, snapshot, snapshot);
}

/* ── hover / focus popover ────────────────────────────────────── */

/** Long enough that a pointer crossing a row of chips never fires one. */
const HOVER_DELAY = 340;
/** Keyboard focus is deliberate, so it needs far less patience. */
const FOCUS_DELAY = 90;
const GAP = 7;
const EDGE = 10;

function useHoverIntent() {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);
  const openAfter = useCallback(
    (ms: number) => {
      cancel();
      timer.current = window.setTimeout(() => setOpen(true), ms);
    },
    [cancel]
  );

  useEffect(() => cancel, [cancel]);

  // Escape closes the card and stops there — the enclosing modal or thread
  // should not also close on the keystroke that dismissed a tooltip.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  return { open, openAfter, close };
}

/**
 * Fixed-position card in a portal, flipped and clamped so it can never leave
 * the window. A portal because chips live inside modals, scrollers and the
 * palette, all of which clip.
 */
function HoverPopover({
  anchor,
  id,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  id: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current;
      const card = cardRef.current;
      if (!a || !card) return;
      const r = a.getBoundingClientRect();
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Prefer left-aligned under the chip; near the right edge, hang it off
      // the chip's right instead of letting it spill.
      let left = r.left;
      if (left + w > vw - EDGE) left = r.right - w;
      left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - EDGE - w));

      let top = r.bottom + GAP;
      if (top + h > vh - EDGE) {
        const above = r.top - GAP - h;
        top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - h);
      }
      setPos({ top, left });
    };

    place();
    window.addEventListener("resize", place);
    // Capture: the chip may sit in any inner scroller, which does not bubble.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      className="ec-card"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Hidden for the one frame it takes to measure, so it never flashes
        // in the top-left corner first.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body
  );
}

/* ── the chip ─────────────────────────────────────────────────── */

export interface EntityChipProps {
  ref: EntityRef;
  /** "md" (default) reads at --fs-xs; "sm" is for dense sidebar and meta rows. */
  size?: "sm" | "md";
  /** Replaces navigation entirely — pickers use this to select instead of go. */
  onClick?: (ref: EntityRef) => void;
  /** Adds a remove affordance; the chip itself stays clickable. */
  onRemove?: (ref: EntityRef) => void;
  /** Show the kind ("TASK") after the title, for mixed-kind lists. */
  showType?: boolean;
  /** De-emphasised: no fill, dimmer text. For chips inside running prose. */
  muted?: boolean;
}

export function EntityChip({
  ref,
  size = "md",
  onClick,
  onRemove,
  showType,
  muted,
}: EntityChipProps) {
  const info = useEntity(ref);
  const setView = useStore((s) => s.setView);
  const anchorRef = useRef<HTMLElement | null>(null);
  const cardId = useId();
  const { open, openAfter, close } = useHoverIntent();

  const spec = KIND_BY_TYPE[ref.type];
  const kindLabel = spec?.label ?? ref.type;
  // "task: Fix the parser". A tombstone's title already says "Deleted task",
  // so prefixing the kind there would only stutter.
  const name = info.exists ? `${kindLabel.toLowerCase()}: ${info.title}` : info.title;

  // GitHub entities have no view to switch to, only a URL; a real anchor gives
  // them the browser's own affordances (middle click, copy link) for free.
  const external = !onClick && !info.view && !!info.href;
  const actionable = !!onClick || !!info.view;

  const className = [
    "ec",
    `ec-${size}`,
    muted ? "ec-muted" : "",
    info.exists ? "" : "ec-dead",
    external ? "ec-external" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function activate(e: ReactMouseEvent<HTMLElement>) {
    if (onClick) {
      e.preventDefault();
      close();
      onClick(ref);
      return;
    }
    if (info.view) {
      e.preventDefault();
      close();
      setView(info.view);
    }
  }

  const shared = {
    className,
    "aria-label": name,
    "aria-describedby": open ? cardId : undefined,
    title: info.exists
      ? undefined
      : `This ${kindLabel.toLowerCase()} was deleted. The link is kept so the connection isn't lost.`,
    onMouseEnter: () => openAfter(HOVER_DELAY),
    onMouseLeave: close,
    onFocus: () => openAfter(FOCUS_DELAY),
    onBlur: close,
  };

  const inner = (
    <>
      <span className="ec-glyph" style={{ color: info.tone }} aria-hidden="true">
        {info.glyph}
      </span>
      <span className="ec-title">{info.title}</span>
      {showType && <span className="ec-type">{kindLabel}</span>}
    </>
  );

  const keepAnchor = (el: HTMLElement | null) => {
    anchorRef.current = el;
  };

  const chip = external ? (
    <a {...shared} ref={keepAnchor} href={info.href} target="_blank" rel="noreferrer" onClick={close}>
      {inner}
    </a>
  ) : (
    <button
      {...shared}
      ref={keepAnchor}
      type="button"
      // Focusable either way: a tombstone still has a story to tell, and the
      // only way to hear it with a keyboard is to be able to focus it.
      aria-disabled={actionable ? undefined : true}
      onClick={actionable ? activate : (e) => e.preventDefault()}
    >
      {inner}
    </button>
  );

  return (
    <span
      className={
        "ec-wrap" + (muted ? " ec-wrap-muted" : "") + (onRemove ? " ec-has-remove" : "")
      }
    >
      {chip}
      {onRemove && (
        <button
          type="button"
          className="ec-remove"
          aria-label={`Remove ${name}`}
          onClick={(e) => {
            e.preventDefault();
            close();
            onRemove(ref);
          }}
        >
          <IconX size={9} />
        </button>
      )}
      {open && (
        <HoverPopover anchor={anchorRef} id={cardId}>
          <EntityHoverCard ref={ref} />
        </HoverPopover>
      )}
    </span>
  );
}

/* ── the hover card ───────────────────────────────────────────── */

/** Cards preview an entity; they never reproduce it. */
function clampBody(s: string, n = 320): string {
  const t = (s ?? "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return (space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

export function EntityHoverCard({ ref }: { ref: EntityRef }) {
  const info = useEntity(ref);
  // The graph tables are what the footer is about, so the card has to move
  // when someone draws a link while it is open.
  const links = useStore((s) => s.links);
  const assignments = useStore((s) => s.assignments);
  const key = refKey(ref);

  const { assignees, connections } = useMemo(
    () => ({
      assignees: assigneesOf(ref).filter((a) => a.info.exists),
      connections: connectionsFor(ref).length,
    }),
    // The two graph tables plus the anchor are the entire input.
    [key, links, assignments]
  );

  const spec = KIND_BY_TYPE[ref.type];
  const kindLabel = spec?.label ?? ref.type;
  // Some subtitles already open with their kind ("Pull request on owner/repo",
  // "Memory · no longer exists"); prefixing those would stutter.
  const kindLine = info.subtitle.toLowerCase().startsWith(kindLabel.toLowerCase())
    ? info.subtitle
    : kindLabel + (info.subtitle ? ` · ${info.subtitle}` : "");
  const body = clampBody(info.body);
  const lead = assignees[0];

  return (
    <div className={"ec-card-in" + (info.exists ? "" : " ec-card-gone")}>
      <div className="ec-card-head">
        <span className="ec-card-glyph" style={{ color: info.tone }} aria-hidden="true">
          {info.glyph}
        </span>
        <div className="ec-card-ident">
          <div className="ec-card-title">{info.title}</div>
          <div className="ec-card-kind">{kindLine}</div>
        </div>
      </div>

      {!info.exists && (
        <div className="ec-card-note">
          This {kindLabel.toLowerCase()} was deleted. The link is kept so the connection isn't
          lost.
        </div>
      )}

      {body && (
        <div className="ec-card-body">
          <Markdown text={body} />
        </div>
      )}

      {(assignees.length > 0 || connections > 0) && (
        <div className="ec-card-foot">
          {lead && (
            <span className="ec-card-who">
              {/* The stack carries the count; the text names only the lead, so
                  the two never disagree about how many people are on this. */}
              <EntityAvatarStack refs={assignees.map((a) => a.subject)} max={3} />
              <span className="ec-card-who-text">
                {lead.info.title} · {lead.roleLabel.toLowerCase()}
              </span>
            </span>
          )}
          {connections > 0 && (
            <span className="ec-card-count">
              {connections} connection{connections === 1 ? "" : "s"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ── avatar stack ─────────────────────────────────────────────── */

function StackFace({ target }: { target: EntityRef }) {
  const info = useEntity(target);
  // Only agents carry a harness badge; teams and people have none.
  const kind = useStore((s) =>
    target.type === "agent" ? s.agents.find((a) => a.id === target.id)?.kind : undefined
  );
  const label = `${KIND_BY_TYPE[target.type]?.label ?? target.type}: ${info.title}`;
  return (
    <span className="ec-face" role="img" aria-label={label} title={label}>
      <Avatar name={info.title} id={target.id} kind={kind} />
    </span>
  );
}

/** Overlapping faces for a "who is on this" row, newest-first as given. */
export function EntityAvatarStack({ refs, max = 4 }: { refs: EntityRef[]; max?: number }) {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);

  const shown = refs.slice(0, Math.max(1, max));
  const hidden = refs.slice(shown.length);
  const hiddenKey = hidden.map(refKey).join("|");
  const overflowTitle = useMemo(
    () => hidden.map((r) => describeEntity(r).title).join(", "),
    // Names of agents and teams are the only thing describeEntity reads here.
    [hiddenKey, agents, teams]
  );

  if (!refs.length) return null;
  return (
    <span className="ec-stack">
      {shown.map((r) => (
        <StackFace key={refKey(r)} target={r} />
      ))}
      {hidden.length > 0 && (
        <span className="ec-stack-more" title={overflowTitle} aria-label={`${hidden.length} more`}>
          +{hidden.length}
        </span>
      )}
    </span>
  );
}
