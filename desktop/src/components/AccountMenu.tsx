/**
 * The account footer — the bottom of the side nav, and the app's answer to
 * three questions that were previously scattered:
 *
 *   who am I here           the face, the name, and a quiet second line
 *   where do I change it    one menu, at the corner every desktop app puts it
 *   can my agents run here  which harnesses this machine actually has
 *
 * It replaces Settings-as-a-nav-tab. Settings is somewhere you go twice a
 * month; it had a permanent seat in the primary nav beside Tasks and Mail,
 * which are places you live. Demoting it into the account corner is the point
 * of this component — the nav list gets shorter and identity gets a home.
 *
 * ── Shape ──────────────────────────────────────────────────────
 *   expanded    [face]  Name / secondary                  [gear]
 *   collapsed   [face]                 menu on click, tooltip on hover
 *
 * The face opens the picker, the name renames in place, the gear opens the
 * menu. Collapsed, the face opens the menu instead: with one target left it
 * has to be the one that leads everywhere, so the picker and the rename move
 * into the menu's own header — which is why that header exists in both modes
 * rather than only the narrow one.
 *
 * ── Why the popover is a dialog that contains a menu ───────────
 * It holds a text field while renaming, and a textbox inside role="menu" is a
 * lie assistive tech has to work around — the same call AgentsView's channel
 * popover makes. So the floating surface is a dialog, the list inside it is a
 * real role="menu" with roving tabindex, arrow keys and typeahead, and the
 * header's controls join the Tab cycle without pretending to be menu items.
 *
 * ── Why it flips up ────────────────────────────────────────────
 * A footer menu that opens downward is off the bottom of the window every
 * time. Up is the default here and down is the fallback, not the reverse.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { useTheme } from "../themeStore";
import { restartOnboarding } from "./Onboarding";
import { Face, FacePicker } from "./Face";
import { HARNESSES } from "../capabilities";
import { config } from "../config";
import { toast } from "../toast";
import { type EntityRef } from "../types";
import {
  IconAgents,
  IconCommand,
  IconDiamond,
  IconGear,
  IconInfo,
  IconList,
  IconMoon,
  IconPerson,
  IconRefresh,
  IconSettings,
  IconSparkle,
  IconSun,
} from "./icons";
import "./accountmenu.css";

/* ── settings deep links ──────────────────────────────────────── */

/**
 * The section headings SettingsView renders, verbatim.
 *
 * Appearance lives in Settings and belongs there — a second set of theme
 * controls in a corner menu is a second thing to keep in step. So these items
 * navigate rather than duplicate, and land on the right section instead of the
 * top of a long page.
 *
 * Matching on rendered heading text is a soft coupling on purpose: SettingsView
 * is not this component's to edit, and a miss degrades to "you are on the
 * Settings page", which is where the item promised to take you anyway.
 */
const SECTION_THEME = "Theme";
const SECTION_TUNING = "Fine tuning"; // accent, density, corners, text size
const SECTION_ABOUT = "About";

/** How long to keep looking for the section before giving up, in frames. */
const REVEAL_FRAMES = 40;

function reveal(heading: string) {
  // Both answers count: the OS setting, and the app's own Reduce motion
  // switch, which writes data-reduce-motion onto the root.
  const reduced =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.hasAttribute("data-reduce-motion");
  let frames = 0;
  const look = () => {
    for (const h of document.querySelectorAll<HTMLElement>(".dash-body h3")) {
      // Headings carry trailing counts ("Theme 12 of 39"), so this matches the
      // leading text rather than the whole string.
      if (!(h.textContent ?? "").trim().startsWith(heading)) continue;
      (h.closest("section") ?? h).scrollIntoView({
        block: "start",
        behavior: reduced ? "auto" : "smooth",
      });
      return;
    }
    // Settings mounts on a later commit and its sections stream in with the
    // theme gallery, so one lookup is too early. Bounded, then it stops.
    if (++frames < REVEAL_FRAMES) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

function openSettings(section?: string) {
  useStore.getState().setView({ type: "settings" });
  if (section) reveal(section);
}

/* ── the collapsed state ──────────────────────────────────────── */

/**
 * The Shell writes the rail's shape onto the app root as data-rail, and the
 * Sidebar this footer sits inside never learns about it. Rather than make the
 * integrator thread a prop it does not have, read the shape off the DOM — and
 * let an explicit `collapsed` win whenever someone does pass one.
 */
function useCollapsed(root: RefObject<HTMLElement | null>, override?: boolean): boolean {
  const [mini, setMini] = useState(false);

  useEffect(() => {
    if (override !== undefined) return;
    const host = root.current?.closest<HTMLElement>("[data-rail]");
    if (!host) return;
    const read = () => setMini(host.dataset.rail === "mini");
    read();
    const watcher = new MutationObserver(read);
    watcher.observe(host, { attributes: true, attributeFilter: ["data-rail"] });
    return () => watcher.disconnect();
  }, [override, root]);

  return override ?? mini;
}

/* ── placement ────────────────────────────────────────────────── */

const GAP = 6;
const EDGE = 8;

function place(anchor: DOMRect, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Up first: this lives in a footer, so there is room above and never room
  // below. Down is the fallback for a window short enough that neither side
  // fits, where the clamp is what keeps it fully on screen.
  let top = anchor.top - GAP - h;
  if (top < EDGE) {
    const below = anchor.bottom + GAP;
    top = below + h <= vh - EDGE ? below : Math.max(EDGE, vh - EDGE - h);
  }

  let left = anchor.left;
  if (left + w > vw - EDGE) left = anchor.right - w;
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - EDGE - w));

  return { top, left };
}

/* ── the menu model ───────────────────────────────────────────── */

interface Item {
  id: string;
  label: string;
  icon: ReactNode;
  /** Trailing text: a shortcut, a state. */
  hint?: string;
  run: () => void;
  /** For items whose effect you want to watch happen. */
  keepOpen?: boolean;
}

interface Group {
  id: string;
  /** '' for the first group, which needs no heading above the obvious. */
  label: string;
  items: Item[];
}

/* ── this machine ─────────────────────────────────────────────── */

/**
 * "Can my agents run here" is a question about which CLIs are on this
 * machine's PATH, which is what check_tools answers. Only the CLI harnesses
 * are counted: Ritz talks HTTP to a local server, so its presence is not a
 * PATH fact and a tick beside it here would be a guess.
 */
function useRuntimes(): { found: string[]; missing: string[] } {
  const tools = useStore((s) => s.tools);
  return useMemo(() => {
    const cli = HARNESSES.filter((h) => h.wire === "cli");
    return {
      found: cli.filter((h) => tools[h.kind]).map((h) => h.label),
      missing: cli.filter((h) => !tools[h.kind]).map((h) => h.label),
    };
  }, [tools]);
}

function runtimeLine(found: string[]): string {
  return found.length ? `Runs here: ${found.join(", ")}` : "No agent runtime on this machine";
}

function titleCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ── the component ────────────────────────────────────────────── */

export function AccountMenu({ collapsed }: { collapsed?: boolean }) {
  const members = useStore((s) => s.members);
  const view = useStore((s) => s.view);
  const updateMember = useStore((s) => s.updateMember);
  const setView = useStore((s) => s.setView);
  const appearance = useTheme((s) => s.theme.appearance);
  const toggleAppearance = useTheme((s) => s.toggleAppearance);
  const runtimes = useRuntimes();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const rowFaceRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Focus is moved into the list once per opening, never on a re-place. */
  const primed = useRef(false);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);

  const mini = useCollapsed(rootRef, collapsed);
  const me = members.find((m) => m.is_self === 1);

  const name = me?.name?.trim() || "You";
  // Role first: it is the thing that differs between the people in a
  // workspace. The brand answers the same question for a workspace of one.
  const secondary = me?.role ? titleCase(me.role) : config().brand;

  /* ── open / close ──────────────────────────────────────────── */

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setRenaming(false);
    if (restoreFocus) openerRef.current?.focus();
  }, []);

  const toggle = (opener: HTMLElement | null) => {
    if (open) {
      close();
      return;
    }
    openerRef.current = opener;
    setPos(null);
    setActive(0);
    primed.current = false;
    setOpen(true);
  };

  // Measure, then place — hidden for the one frame that takes, so it never
  // flashes in the corner first. The same dance EntityChip's card does.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = rootRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;

    const put = () =>
      setPos(place(anchor.getBoundingClientRect(), pop.offsetWidth, pop.offsetHeight));

    put();
    window.addEventListener("resize", put);
    // Capture: the rail is its own scroll container, and scroll does not bubble.
    window.addEventListener("scroll", put, true);
    return () => {
      window.removeEventListener("resize", put);
      window.removeEventListener("scroll", put, true);
    };
  }, [open]);

  // A route change is a decision made. The menu that carried it has no reason
  // to still be sitting over the surface it just switched to. The rail
  // changing shape is the same story: the anchor it was measured against has
  // just moved, and re-placing a menu under the pointer is worse than closing.
  useEffect(() => {
    setOpen(false);
  }, [view, mini]);

  // Outside press. Pointerdown rather than click so it closes on press, with
  // the footer itself excluded so a press on the trigger stays one action
  // rather than a close followed immediately by an open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || rootRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, close]);

  // Escape from anywhere, including a focus that has somehow left the popover.
  // The rename field stops this one short so the first Escape cancels the edit.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  /* ── rename ────────────────────────────────────────────────── */

  const startRename = () => {
    setDraft(me?.name ?? "");
    setRenaming(true);
  };

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    // An emptied field is a cancel, not an instruction to erase your name.
    if (!me || !next || next === me.name) return;
    // The store writes the row before it updates itself, so a failed write
    // leaves the old name on screen with no explanation. Say what happened —
    // your own name silently refusing to change is alarming.
    void updateMember(me.id, { name: next }).catch((e) => {
      toast.error("Could not change your name", e);
    });
  };

  /* ── the items ─────────────────────────────────────────────── */

  const groups: Group[] = useMemo(
    () => [
      {
        id: "go",
        label: "",
        items: [
          {
            id: "settings",
            label: "Settings",
            icon: <IconSettings size={15} />,
            run: () => setView({ type: "settings" }),
          },
          {
            id: "people",
            label: "People",
            icon: <IconPerson size={15} />,
            run: () => setView({ type: "people" }),
          },
          {
            id: "agents",
            label: "Agents & Teams",
            icon: <IconAgents size={15} />,
            run: () => setView({ type: "agents" }),
          },
        ],
      },
      {
        id: "appearance",
        label: "Appearance",
        items: [
          {
            id: "mode",
            label: appearance === "dark" ? "Light mode" : "Dark mode",
            icon: appearance === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />,
            // Kept open: flipping the whole app is worth watching, and the
            // next thing you want is usually the theme that goes with it.
            keepOpen: true,
            run: () => toggleAppearance(),
          },
          {
            id: "theme",
            label: "Theme",
            icon: <IconSparkle size={15} />,
            run: () => openSettings(SECTION_THEME),
          },
          {
            id: "accent",
            label: "Accent",
            icon: <IconDiamond size={15} />,
            run: () => openSettings(SECTION_TUNING),
          },
          {
            id: "density",
            label: "Density",
            icon: <IconList size={15} />,
            run: () => openSettings(SECTION_TUNING),
          },
        ],
      },
      {
        id: "help",
        label: "Help",
        items: [
          {
            id: "setup",
            label: "Run setup again",
            icon: <IconRefresh size={15} />,
            run: () => restartOnboarding(),
          },
          {
            id: "keys",
            label: "Keyboard shortcuts",
            icon: <IconCommand size={15} />,
            hint: "⌘K",
            // The command palette holds the binding sheet, and it opens on a
            // key rather than through an exported function. Synthesising the
            // key it already listens for beats a second copy of that list.
            run: () =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
              ),
          },
          {
            id: "about",
            label: `About ${config().brand}`,
            icon: <IconInfo size={15} />,
            run: () => openSettings(SECTION_ABOUT),
          },
        ],
      },
    ],
    [appearance, setView, toggleAppearance]
  );

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const runItem = (item: Item) => {
    item.run();
    if (!item.keepOpen) close();
  };

  /* ── keyboard ──────────────────────────────────────────────── */

  const focusItem = (i: number) => {
    const next = (i + flat.length) % flat.length;
    setActive(next);
    listRef.current?.querySelectorAll<HTMLButtonElement>(".am-item")[next]?.focus();
  };

  // Typeahead: one buffer, cleared when you stop typing. A single letter
  // searches from the item *after* the current one, so pressing it repeatedly
  // cycles through everything that starts with it instead of sticking.
  const typed = useRef({ text: "", at: 0 });
  const typeahead = (ch: string) => {
    const now = Date.now();
    typed.current = {
      text: now - typed.current.at > 700 ? ch : typed.current.text + ch,
      at: now,
    };
    const q = typed.current.text;
    const from = q.length > 1 ? active : active + 1;
    for (let step = 0; step < flat.length; step++) {
      const i = (from + step) % flat.length;
      if (flat[i].label.toLowerCase().startsWith(q)) {
        focusItem(i);
        return;
      }
    }
  };

  /** Everything Tab may reach inside the popover, in DOM order. */
  const tabStops = () =>
    Array.from(
      popRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled])'
      ) ?? []
    );

  const onPopKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      // The trap. Everything this popover offers is inside it, so Tab cycles
      // rather than dropping focus behind a surface that is still open.
      const stops = tabStops();
      if (stops.length < 2) return;
      const at = stops.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      stops[((e.shiftKey ? at - 1 : at + 1) + stops.length) % stops.length].focus();
      return;
    }

    // Arrows and letters belong to the field while it is being typed in.
    if (e.target === inputRef.current) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(active - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(flat.length - 1);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) {
      e.preventDefault();
      typeahead(e.key.toLowerCase());
    }
  };

  // Focus lands on the first item rather than the header: the list is what a
  // menu is for, and the arrow keys have somewhere to go from the first press.
  // Waits for placement, because a visibility:hidden button cannot take focus.
  useEffect(() => {
    if (!open || !pos || primed.current) return;
    primed.current = true;
    listRef.current?.querySelector<HTMLButtonElement>(".am-item")?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming, open]);

  /* ── render ────────────────────────────────────────────────── */

  // Before the first refreshAll the members table has not been read yet.
  // Nothing here is meaningful without a person, and a skeleton in the corner
  // of the rail would only flash.
  if (!me) return null;

  const selfRef: EntityRef = { type: "member", id: me.id };
  // Collapsed, the tooltip is the only text left, so it carries the whole row:
  // who you are and whether anything can run here. Expanded, the row says both
  // already and the tooltip only has to name what the button does.
  const tooltip = mini
    ? `${name} — ${secondary}\n${runtimeLine(runtimes.found)}`
    : "Change your picture";

  const nameField = (
    <input
      ref={inputRef}
      className="am-rename"
      value={draft}
      aria-label="Your name"
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitRename();
        } else if (e.key === "Escape") {
          // Cancels the rename only. A second Escape closes the menu, which is
          // the order you want when you mistyped inside an open one. Clearing
          // the draft is what makes the cancel stick: an empty draft is a
          // no-op for commitRename, so a blur on the way out cannot revive
          // the text that was just abandoned.
          e.preventDefault();
          e.stopPropagation();
          setDraft("");
          setRenaming(false);
        }
      }}
    />
  );

  return (
    <div
      className="am"
      ref={rootRef}
      data-collapsed={mini ? "1" : undefined}
      data-open={open ? "1" : undefined}
    >
      <button
        type="button"
        ref={rowFaceRef}
        className="am-face"
        title={tooltip}
        aria-label={mini ? `${name} — account and settings` : "Change your picture"}
        aria-haspopup="dialog"
        aria-expanded={mini ? open : undefined}
        onClick={(e) => (mini ? toggle(e.currentTarget) : setPicking(true))}
      >
        {/* 20, not 24: the face is this row's glyph and the rail's glyph
            column is 20 wide. A face drawn larger than the column would sit
            off the axis the nav icons stand on. */}
        <Face ref={selfRef} size={20} />
      </button>

      {!mini && (
        <>
          {renaming && !open ? (
            nameField
          ) : (
            <button
              type="button"
              className="am-who"
              aria-label={`${name} — rename`}
              onClick={startRename}
            >
              <span className="am-name">{name}</span>
              <span className="am-sub">{secondary}</span>
            </button>
          )}
          <button
            type="button"
            className="icon-btn am-gear"
            aria-label="Settings and account"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={(e) => toggle(e.currentTarget)}
          >
            <IconGear size={15} />
          </button>
        </>
      )}

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="am-pop glass"
            role="dialog"
            // Focus really is trapped in here, so saying so is honest rather
            // than decorative: screen readers should treat the rest of the
            // window as inert for as long as this is open.
            aria-modal="true"
            aria-label="Account"
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
            onKeyDown={onPopKeyDown}
          >
            <div className="am-head">
              <button
                type="button"
                className="am-face am-head-face"
                title="Change your picture"
                aria-label="Change your picture"
                onClick={() => {
                  // The picker is a modal and owns the window from here; a menu
                  // left open behind it is just something to dismiss twice.
                  setPicking(true);
                  close(false);
                }}
              >
                <Face ref={selfRef} size={32} />
              </button>
              {renaming ? (
                nameField
              ) : (
                <button
                  type="button"
                  className="am-who"
                  aria-label={`${name} — rename`}
                  onClick={startRename}
                >
                  <span className="am-name">{name}</span>
                  <span className="am-sub">{me.email || secondary}</span>
                </button>
              )}
            </div>

            <div className="am-list" role="menu" aria-label="Account" ref={listRef}>
              {groups.map((group) => {
                const base = flat.indexOf(group.items[0]);
                return (
                  <div
                    key={group.id}
                    role="group"
                    aria-label={group.label || "Go to"}
                    className="am-group"
                  >
                    {group.label && (
                      <div className="am-group-label" aria-hidden="true">
                        {group.label}
                      </div>
                    )}
                    {group.items.map((item, i) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className="am-item"
                        tabIndex={base + i === active ? 0 : -1}
                        onFocus={() => setActive(base + i)}
                        onClick={() => runItem(item)}
                      >
                        <span className="am-item-icon">{item.icon}</span>
                        <span className="am-item-label">{item.label}</span>
                        {item.hint && <span className="am-item-hint">{item.hint}</span>}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* Why this corner exists: agents run on a machine, not in the
                app, so which harnesses this one has is the fact that decides
                whether anything you start here will actually run. */}
            <div className="am-machine">
              <span
                className={"am-machine-dot" + (runtimes.found.length ? " ok" : " none")}
                aria-hidden="true"
              />
              <span className="am-machine-text">
                {runtimeLine(runtimes.found)}
                {runtimes.found.length > 0 && runtimes.missing.length > 0 && (
                  <span className="am-machine-rest">
                    {` · no ${runtimes.missing.join(", ")}`}
                  </span>
                )}
              </span>
            </div>
          </div>,
          document.body
        )}

      {picking && (
        <FacePicker
          ref={selfRef}
          onClose={() => {
            setPicking(false);
            // Back to the control that opened it — which is the row's face in
            // both modes, since the menu's copy has been dismissed by now.
            rowFaceRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
