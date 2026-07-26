/**
 * Drawing an edge in the graph.
 *
 * One search field over every entity kind at once, because the question a
 * person actually has is "what is this about?", never "which table is it in".
 *
 * The relation sits beside the results and is previewed as a sentence, so the
 * edge is read before it is drawn — an arrow nobody can read is an arrow that
 * gets drawn backwards, and a backwards `blocks` is worse than no link at all.
 * That is also why the swap control exists: LINK_KINDS only names the forward
 * direction, so "this task is blocked by that one" is unreachable without it.
 *
 * It is a panel and not a dialog because the sentence has two halves and only
 * one of them is on this surface: the other is the task, event or memory entry
 * you are linking *from*, and a dialog covering it is a dialog asking you to
 * remember what you were looking at. Opened from inside another panel it stacks
 * on the same edge; opened from a pane it simply sits beside it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import { describeEntity, searchEntities, ENTITY_KINDS } from "../entities";
import type { EntityInfo } from "../entities";
import { LINK_KINDS, LINK_KIND_BY_ID } from "../links";
import { toast } from "../toast";
import { refKey } from "../types";
import type { EntityRef, EntityType, Link, LinkKind } from "../types";
import { useEntity } from "./EntityChip";
import { SidePanel } from "./SidePanel";
import type { PanelStack } from "./SidePanel";
import { IconArrowSwap } from "./icons";
import "./connections.css";

/* ── shared chip radiogroup ───────────────────────────────────── */

export interface RadioChipOption<T extends string> {
  value: T;
  label: string;
  glyph?: string;
  /** Long-form help, surfaced as a tooltip and to assistive tech. */
  title?: string;
}

/**
 * A row of chips that behaves like one radio group: a single tab stop, arrows
 * to move within it. Link kinds and assignment roles are the same control at
 * heart, and they should look and feel identical wherever they appear.
 */
export function RadioChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: RadioChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const group = useRef<HTMLDivElement>(null);

  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    // The buttons are keyed by value, so they survive the re-render and this
    // focus call lands on the element that is about to become the tab stop.
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const onKey = (e: ReactKeyboardEvent<HTMLElement>, i: number) => {
    const key = e.key;
    if (key === "ArrowRight" || key === "ArrowDown") { e.preventDefault(); move(i, 1); }
    else if (key === "ArrowLeft" || key === "ArrowUp") { e.preventDefault(); move(i, -1); }
    else if (key === "Home") { e.preventDefault(); move(-1, 1); }
    else if (key === "End") { e.preventDefault(); move(0, -1); }
  };

  return (
    <div className="rc" role="radiogroup" aria-label={label} ref={group}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          className={"rc-chip" + (o.value === value ? " rc-on" : "")}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.glyph && <span className="rc-glyph" aria-hidden="true">{o.glyph}</span>}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── the picker ───────────────────────────────────────────────── */

const LINKABLE = ENTITY_KINDS.filter((k) => k.linkable);

/**
 * What to list before anyone types. Every message in the app is linkable, and
 * an unfiltered list of them buries the handful of things a person means — so
 * messages surface only once there is a query to earn their place.
 */
const BROWSE_TYPES: EntityType[] = LINKABLE.filter((k) => k.type !== "message").map((k) => k.type);

/** `owner/name` or `owner/name#123` — the only refs Spaces never stores a row for. */
const GITHUB_REF = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:#(\d+))?$/;

interface Row {
  key: string;
  info: EntityInfo;
  /** Typed rather than found: a GitHub ref with no local row. */
  synthetic: boolean;
  /** Already connected to the anchor by some link. */
  linked: boolean;
}

export interface LinkPickerProps {
  anchor: EntityRef;
  onClose: () => void;
  /** Pre-selects the relation, e.g. a blocker picker opening on "blocks". */
  defaultKind?: LinkKind;
  /** Fires only for links this picker actually created, never for duplicates. */
  onLinked?: (link: Link) => void;
  /**
   * Set when the surface that opened this one is itself a panel: same edge,
   * same width, plus the way back. A picker rendered inside another panel's
   * children is detected on its own — this only supplies the return trip.
   */
  stack?: PanelStack;
}

export function LinkPicker({
  anchor,
  onClose,
  defaultKind = "relates",
  onLinked,
  stack,
}: LinkPickerProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LinkKind>(defaultKind);
  const [flipped, setFlipped] = useState(false);
  const [types, setTypes] = useState<Set<EntityType>>(() => new Set());
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-r${i}`;

  const addLink = useStore((s) => s.addLink);
  const removeLink = useStore((s) => s.removeLink);
  const links = useStore((s) => s.links);
  // searchEntities projects these tables, so results have to move when they do.
  const projects = useStore((s) => s.projects);
  const channels = useStore((s) => s.channels);
  const tasks = useStore((s) => s.tasks);
  const memory = useStore((s) => s.memory);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const messages = useStore((s) => s.messages);

  const anchorInfo = useEntity(anchor);
  const anchorKey = refKey(anchor);
  const typeKey = [...types].sort().join(",");
  const spec = LINK_KIND_BY_ID[kind] ?? LINK_KIND_BY_ID.relates;

  /** Everything already joined to the anchor, so results can say so. */
  const linkedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const l of links) {
      if (l.from_type === anchor.type && l.from_id === anchor.id) set.add(`${l.to_type}:${l.to_id}`);
      else if (l.to_type === anchor.type && l.to_id === anchor.id) set.add(`${l.from_type}:${l.from_id}`);
    }
    return set;
    // anchorKey is the whole of anchor read here
  }, [links, anchorKey]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const wanted = types.size ? [...types] : q ? undefined : BROWSE_TYPES;
    const found = searchEntities(q, { types: wanted, limit: 40 })
      .filter((i) => !(i.ref.type === anchor.type && i.ref.id === anchor.id))
      .map<Row>((info) => ({
        key: refKey(info.ref),
        info,
        synthetic: false,
        linked: linkedKeys.has(refKey(info.ref)),
      }));

    // A GitHub ref has no row to find, so it is offered rather than searched.
    // A number could be either kind and only the person typing knows which.
    const m = GITHUB_REF.exec(q);
    const synthetic: Row[] = [];
    if (m) {
      const [, repo, number] = m;
      const kinds: EntityType[] = number ? ["pr", "issue"] : ["repo"];
      for (const t of kinds) {
        if (types.size && !types.has(t)) continue;
        const ref: EntityRef = { type: t, id: number ? `${repo}#${number}` : repo };
        synthetic.push({
          key: refKey(ref),
          info: describeEntity(ref),
          synthetic: true,
          linked: linkedKeys.has(refKey(ref)),
        });
      }
    }
    return [...synthetic, ...found];
    // typeKey stands in for the Set; the store slices are what searchEntities reads
  }, [query, typeKey, linkedKeys, anchorKey, projects, channels, tasks, memory, agents, teams, messages]);

  const active = rows.length ? Math.min(sel, rows.length - 1) : -1;
  const target = active >= 0 ? rows[active].info : null;

  // A symmetric relation reads the same either way, so a flipped one is a lie.
  // Derived rather than reset in an effect: state that corrects itself a frame
  // later shows the wrong sentence for that frame.
  const reversed = flipped && !spec.symmetric;

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /*
   * A panel sits below the modal layer, which is the right way round nearly
   * everywhere: a panel is chrome beside a pane, and a dialog over the top of
   * it is the newer surface. This picker is the one that inverts, because it
   * can be opened from *inside* a modal — an event's connections, a memory
   * entry's — and there it is the newer surface and the modal is the thing
   * being read against. Measured once at mount rather than watched: a modal
   * closing under an open picker must not drop the picker back underneath a
   * layer it was already drawn above.
   */
  const [overModal] = useState(() => Boolean(document.querySelector(".modal-backdrop")));

  /*
   * SidePanel hands Escape to any modal standing above it, so the one picker
   * that is above a modal has to answer for itself. Capture phase, so the
   * decision is made here before the surface underneath hears the key at all.
   */
  const escape = useRef(onClose);
  escape.current = stack?.back ?? onClose;
  useEffect(() => {
    if (!overModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      escape.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [overModal]);

  const confirm = useCallback(
    async (row: Row, keepOpen: boolean) => {
      if (busy) return;
      const other = row.info.ref;
      const from = reversed ? other : anchor;
      const to = reversed ? anchor : other;
      const sentence = `${describeEntity(from).title} ${spec.label} ${describeEntity(to).title}`;
      setBusy(true);
      try {
        // Snapshot first: addLink hands back the existing row for a duplicate,
        // and undoing that would tear down a link the user did not just draw.
        const before = useStore.getState().links;
        const link = await addLink(from, to, kind);
        if (!link) {
          toast.warn("Nothing to link", "An entity cannot be linked to itself.");
          return;
        }
        if (before.some((l) => l.id === link.id)) {
          toast.info("Already connected", sentence);
        } else {
          onLinked?.(link);
          toast.show({
            kind: "success",
            title: "Linked",
            detail: sentence,
            action: { label: "Undo", run: () => void removeLink(link.id) },
          });
        }
        if (keepOpen) {
          setQuery("");
          setSel(0);
          inputRef.current?.focus();
        } else {
          onClose();
        }
      } catch (e) {
        toast.error("Could not create that link", e);
      } finally {
        setBusy(false);
      }
    },
    [busy, reversed, anchor, spec.label, addLink, kind, onLinked, removeLink, onClose]
  );

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length) setSel((active + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setSel((active - 1 + rows.length) % rows.length);
    } else if (e.key === "Home" && rows.length) {
      e.preventDefault();
      setSel(0);
    } else if (e.key === "End" && rows.length) {
      e.preventDefault();
      setSel(rows.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) void confirm(rows[active], e.metaKey || e.ctrlKey);
    }
  };

  const toggleType = (t: EntityType) => {
    setTypes((prev) => {
      const next = new Set(prev);
      if (!next.delete(t)) next.add(t);
      return next;
    });
    setSel(0);
  };

  return (
    <SidePanel
      title="Add a connection"
      subtitle={`From ${anchorInfo.title}`}
      onClose={onClose}
      stack={stack}
      width={440}
      storageKey="link"
      className={overModal ? "lp-over-modal" : undefined}
      /* Not an actions row: the shortcuts are how this surface is driven, and
         pinning them means they are still legible with a long result list. */
      footer={
        <div className="lp-foot">
          <span><kbd className="lp-kbd">↑↓</kbd> choose</span>
          <span><kbd className="lp-kbd">↵</kbd> link</span>
          <span><kbd className="lp-kbd">⌘↵</kbd> link &amp; keep going</span>
          <span><kbd className="lp-kbd">esc</kbd> close</span>
        </div>
      }
    >
      <div className="lp">
        <p className="lp-sentence" aria-live="polite">
          {reversed && !target ? (
            <span className="lp-s-part lp-s-blank">something</span>
          ) : (
            <span className="lp-s-part">{reversed ? target?.title : anchorInfo.title}</span>
          )}
          <span className="lp-s-rel">
            <span className="lp-s-glyph" aria-hidden="true">{spec.glyph}</span>
            {spec.label}
          </span>
          {!reversed && !target ? (
            <span className="lp-s-part lp-s-blank">something</span>
          ) : (
            <span className="lp-s-part">{reversed ? anchorInfo.title : target?.title}</span>
          )}
          <button
            type="button"
            className="lp-swap"
            onClick={() => setFlipped((f) => !f)}
            disabled={spec.symmetric}
            title={
              spec.symmetric
                ? `"${spec.label}" reads the same in both directions.`
                : "Swap which side is which"
            }
            aria-label="Swap the direction of this connection"
          >
            <IconArrowSwap size={13} />
          </button>
        </p>

        <RadioChips
          label="Relation"
          value={kind}
          onChange={setKind}
          options={LINK_KINDS.map((k) => ({ value: k.kind, label: k.label, glyph: k.glyph }))}
        />

        <input
          ref={inputRef}
          className="lp-input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? rowId(active) : undefined}
          aria-label="Search everything you can link to"
          placeholder="Search tasks, channels, memory, agents… or type owner/name#123"
          value={query}
          data-autofocus
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onSearchKey}
        />

        <div className="lp-types" role="group" aria-label="Filter by kind">
          {LINKABLE.map((k) => (
            <button
              key={k.type}
              type="button"
              className={"lp-type" + (types.has(k.type) ? " lp-type-on" : "")}
              aria-pressed={types.has(k.type)}
              onClick={() => toggleType(k.type)}
            >
              <span className="lp-type-glyph" style={{ color: k.tone }} aria-hidden="true">{k.glyph}</span>
              {k.plural}
            </button>
          ))}
          {types.size > 0 && (
            <button type="button" className="lp-type lp-type-clear" onClick={() => { setTypes(new Set()); setSel(0); }}>
              Clear filters
            </button>
          )}
        </div>

        <div className="lp-list" id={listId} role="listbox" aria-label="Things to link" ref={listRef}>
          {rows.map((row, i) => (
            <div
              key={row.key}
              id={rowId(i)}
              data-idx={i}
              role="option"
              aria-selected={i === active}
              className={"lp-row" + (i === active ? " lp-row-on" : "")}
              onMouseMove={() => setSel(i)}
              onClick={() => void confirm(row, false)}
            >
              <span className="lp-glyph" style={{ color: row.info.tone }} aria-hidden="true">
                {row.info.glyph}
              </span>
              <span className="lp-ident">
                <span className="lp-title">{row.info.title}</span>
                {row.info.subtitle && <span className="lp-sub">{row.info.subtitle}</span>}
              </span>
              {row.synthetic && <span className="lp-tag">on GitHub</span>}
              {row.linked && <span className="lp-tag lp-tag-done">linked</span>}
            </div>
          ))}
          {rows.length === 0 && (
            <p className="lp-empty">
              {query.trim() ? (
                <>Nothing matches “{query.trim()}”.</>
              ) : (
                <>Nothing here yet.</>
              )}{" "}
              A pull request or issue has no row in Spaces — type it as{" "}
              <code>owner/name#123</code> and it becomes linkable.
            </p>
          )}
        </div>
      </div>
    </SidePanel>
  );
}
