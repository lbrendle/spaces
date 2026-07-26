import "./palette.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import { useTheme } from "../themeStore";
import { THEMES } from "../themes";
import { Avatar } from "./ui";
import type { View } from "../types";

interface PaletteItem {
  key: string;
  group: "channel" | "view" | "project" | "agent" | "theme";
  icon: ReactNode;
  label: string;
  sub?: string;
  /** Candidate strings for fuzzy matching; best score wins. */
  texts: string[];
  unread?: number;
  run: () => void;
}

const VIEWS: { label: string; icon: string; view: View }[] = [
  { label: "Dashboard", icon: "◫", view: { type: "dashboard" } },
  { label: "Tasks", icon: "☰", view: { type: "tasks" } },
  { label: "Documents", icon: "▤", view: { type: "documents" } },
  { label: "Mail", icon: "✉", view: { type: "mail" } },
  { label: "Calendar", icon: "□", view: { type: "calendar" } },
  { label: "Content Studio", icon: "◈", view: { type: "content" } },
  { label: "Memory", icon: "✦", view: { type: "memory" } },
  { label: "Agents & Teams", icon: "⚉", view: { type: "agents" } },
  { label: "Workspaces", icon: "⌥", view: { type: "workspaces" } },
  { label: "Settings", icon: "◐", view: { type: "settings" } },
];

/**
 * Case-insensitive subsequence match. Returns null when `query` is not a
 * subsequence of `target`; otherwise a score that rewards prefix matches,
 * consecutive runs, and word-boundary hits, with a light preference for
 * shorter targets.
 */
function subseqScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (let i = 0; i < q.length; i++) {
    const idx = t.indexOf(q[i], pos);
    if (idx === -1) return null;
    if (idx === 0) score += 8; // match starts at the very beginning
    else if (idx === prev + 1) score += 4; // consecutive run
    else if (!/[a-z0-9]/.test(t[idx - 1])) score += 2; // word boundary
    else score += 1;
    prev = idx;
    pos = idx + 1;
  }
  return score - t.length * 0.05;
}

function bestScore(query: string, texts: string[]): number | null {
  let best: number | null = null;
  for (const t of texts) {
    const s = subseqScore(query, t);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const channels = useStore((s) => s.channels);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const unread = useStore((s) => s.unread);
  const setView = useStore((s) => s.setView);
  const setTheme = useTheme((s) => s.setTheme);

  // Global shortcut: Cmd+K toggles, Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!e.repeat) setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Fresh state each time it opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];
    const projName = new Map(projects.map((p) => [p.id, p.name]));
    const out: PaletteItem[] = [];

    for (const c of channels) {
      const proj = projName.get(c.project_id) ?? "";
      out.push({
        key: `chan-${c.id}`,
        group: "channel",
        icon: <span className="palette-icon hash">#</span>,
        label: c.name,
        sub: proj ? `— ${proj}` : undefined,
        texts: [c.name, proj, `${c.name} ${proj}`],
        unread: unread[c.id] ?? 0,
        run: () => setView({ type: "channel", channelId: c.id }),
      });
    }

    for (const v of VIEWS) {
      out.push({
        key: `view-${v.view.type}`,
        group: "view",
        icon: <span className="palette-icon">{v.icon}</span>,
        label: v.label,
        texts: [v.label],
        run: () => setView(v.view),
      });
    }

    for (const p of projects) {
      out.push({
        key: `proj-${p.id}`,
        group: "project",
        icon: <span className="palette-icon">▣</span>,
        label: `Project: ${p.name}`,
        sub: "command center",
        texts: [p.name, `Project: ${p.name}`, `Command center ${p.name}`],
        run: () => setView({ type: "workspace", projectId: p.id }),
      });
      out.push({
        key: `term-${p.id}`,
        group: "project",
        icon: <span className="palette-icon">&gt;_</span>,
        label: `Terminal: ${p.name}`,
        texts: [p.name, `Terminal: ${p.name}`, `Code ${p.name}`],
        run: () => setView({ type: "workspace", projectId: p.id, surface: "terminal" }),
      });
      out.push({
        key: `browser-${p.id}`,
        group: "project",
        icon: <span className="palette-icon">◎</span>,
        label: `Browser: ${p.name}`,
        texts: [p.name, `Browser: ${p.name}`, `Web ${p.name}`],
        run: () => setView({ type: "workspace", projectId: p.id, surface: "browser" }),
      });
      out.push({
        key: `processes-${p.id}`,
        group: "project",
        icon: <span className="palette-icon">●</span>,
        label: `Processes: ${p.name}`,
        texts: [p.name, `Processes: ${p.name}`, `Agent runs ${p.name}`, `Live ${p.name}`],
        run: () => setView({ type: "workspace", projectId: p.id, surface: "processes" }),
      });
    }

    for (const a of agents) {
      out.push({
        key: `agent-${a.id}`,
        group: "agent",
        icon: <Avatar name={a.name} id={a.id} kind={a.kind} />,
        label: `Agent: ${a.name}`,
        sub: `(${a.kind})`,
        texts: [a.name, `Agent: ${a.name}`, a.kind],
        run: () => setView({ type: "agents" }),
      });
    }

    // Switch themes without leaving the keyboard — the swatch previews the
    // theme's own colors, so these are data, not styling.
    for (const t of THEMES) {
      out.push({
        key: `theme-${t.id}`,
        group: "theme",
        icon: (
          <span
            className="palette-icon theme-swatch"
            style={{ background: t.bg, borderColor: t.border }}
          >
            <i style={{ background: t.accent }} />
          </span>
        ),
        label: `Theme: ${t.name}`,
        sub: t.appearance,
        texts: [t.name, `Theme: ${t.name}`, `theme ${t.appearance}`],
        run: () => setTheme(t.id),
      });
    }

    return out;
  }, [open, channels, projects, agents, unread, setView, setTheme]);

  const results = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (!q) {
      const chans = items
        .filter((i) => i.group === "channel")
        .sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0));
      return [...chans, ...items.filter((i) => i.group === "view")];
    }
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const item of items) {
      const s = bestScore(q, item.texts);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.item);
  }, [items, query]);

  const selected = results.length ? Math.min(sel, results.length - 1) : -1;

  // Keep the selected row visible while arrowing through the list.
  useEffect(() => {
    if (selected < 0) return;
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  const activate = (item: PaletteItem) => {
    setOpen(false);
    item.run();
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length) setSel((selected + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setSel((selected - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected >= 0) activate(results[selected]);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="palette">
        <input
          className="palette-input"
          placeholder="Jump to a channel, view, project, or agent…"
          value={query}
          autoFocus
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onInputKey}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((it, i) => (
            <div
              key={it.key}
              data-idx={i}
              className={"palette-row" + (i === selected ? " selected" : "")}
              onMouseMove={() => setSel(i)}
              onClick={() => activate(it)}
            >
              {it.icon}
              <span className="palette-label">{it.label}</span>
              {it.sub && <span className="palette-sub">{it.sub}</span>}
              {it.unread ? <span className="palette-unread">{it.unread}</span> : null}
            </div>
          ))}
          {results.length === 0 && (
            <div className="nav-empty">No matches for “{query.trim()}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}
