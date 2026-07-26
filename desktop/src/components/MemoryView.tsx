/**
 * Project memory — the standing context under every agent run.
 *
 * Beyond CRUD this screen has one job: make the cost of an entry legible.
 * What is written here is not a wiki, it is a prompt prefix. agents.ts takes
 * the first twelve entries of a project, pinned first, and trims each body to
 * 500 characters; a person who cannot see that cutoff writes twelve essays and
 * silently loses the thirteenth. So the cutoff is drawn on the page — a live
 * character meter above the list, a badge on every card that falls past it,
 * and, in the reader, the literal line the agent will receive.
 *
 * Reading and writing share the right-hand pane rather than a modal, because
 * an entry is written *against* the list it joins, and because linking it to a
 * channel while writing — which is how that channel's agents come to know it —
 * needs more room than a dialog has.
 *
 * Writing is continuous: there is no Save button, because there is no moment
 * where an entry is worth less than the run that is about to read it. Every
 * field — title, body, kind, pinned — autosaves, ⌘S is kept as the way to
 * *ask*, and the indicator in the editor bar is the only thing standing
 * between someone and a lost paragraph, so it never says "Saved" for text that
 * has not landed.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useStore } from "../store";
import type { EntityRef, MemoryEntry, MemoryKind } from "../types";
import { assigneesOf, connectionsFor } from "../links";
import { useAutosave, useSaveShortcut } from "../autosave";
import { confirmAction, toast } from "../toast";
import { timeAgo } from "../github";
import { Markdown } from "./ui";
import { SaveState, useCloseGuard } from "./SaveState";
import { ConnectionsPanel, ConnectionsSummary } from "./ConnectionsPanel";
import { RadioChips } from "./LinkPicker";
import {
  IconCompass,
  IconNote,
  IconPin,
  IconPinFilled,
  IconPlus,
  IconScale,
  IconSearch,
} from "./icons";
import "./memory.css";

/* ── what the prompt builder actually does ────────────────────── */

/*
 * Mirrors buildPrompt() in agents.ts, which is not ours to import from:
 *
 *   const mem = s.memory.filter(m => m.project_id === project.id).slice(0, 12);
 *   for (const m of mem) lines.push(`- [${m.kind}] ${m.title}: ${m.content.slice(0, 500)}`);
 *
 * `s.memory` arrives from the store ordered `pinned DESC, updated_at DESC`, so
 * pinned entries genuinely are first and the twelfth-newest is genuinely the
 * last one an agent sees. Kept as named constants so a change over there is a
 * one-line change here rather than a meter that quietly starts lying.
 */
const PROMPT_ENTRIES = 12;
const PROMPT_BODY_CHARS = 500;
/** The ceiling the meter fills toward: twelve entries at full body length. */
const BUDGET_CEILING = PROMPT_ENTRIES * PROMPT_BODY_CHARS;

const promptLine = (m: MemoryEntry): string =>
  `- [${m.kind}] ${m.title}: ${m.content.slice(0, PROMPT_BODY_CHARS)}`;

/* ── kinds, sorts, templates ──────────────────────────────────── */

interface KindSpec {
  key: MemoryKind;
  label: string;
  /** Plural, for filter chips and section counts. */
  plural: string;
  /** Drawn, not typed. The compass and pin were emoji standing in for icons
   *  this app already ships — and emoji are not iconography here. */
  Icon: (props: { size?: number; className?: string }) => ReactNode;
  help: string;
}

const KINDS: KindSpec[] = [
  { key: "decision", label: "Decision", plural: "Decisions", Icon: IconScale, help: "Settled — do not relitigate it." },
  { key: "context", label: "Context", plural: "Context", Icon: IconCompass, help: "How things are around here." },
  { key: "note", label: "Note", plural: "Notes", Icon: IconNote, help: "Worth knowing, not binding." },
];
const KIND_BY_KEY: Record<MemoryKind, KindSpec> = Object.fromEntries(
  KINDS.map((k) => [k.key, k])
) as Record<MemoryKind, KindSpec>;

type SortKey = "updated" | "created" | "title";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Recently updated" },
  { key: "created", label: "Recently added" },
  { key: "title", label: "Title A–Z" },
];

interface Template {
  id: string;
  label: string;
  glyph: string;
  kind: MemoryKind;
  /** One line on the button: when to reach for this shape. */
  help: string;
  titleHint: string;
  content: string;
}

/**
 * Skeletons, not examples. Each one is the set of questions an agent will ask
 * about that kind of knowledge if the entry does not answer them up front.
 */
const TEMPLATES: Template[] = [
  {
    id: "decision",
    label: "Decision",
    glyph: "⚖",
    kind: "decision",
    help: "A choice that is settled, and why.",
    titleHint: "We use pnpm, not npm",
    content:
      "## What we decided\n\n\n## Why\n\n\n## What we rejected\n- \n\n## What this means when you work here\n- ",
  },
  {
    id: "convention",
    label: "Convention",
    glyph: "§",
    kind: "context",
    help: "How we always do a thing.",
    titleHint: "Components are one file, PascalCase",
    content: "## The rule\n\n\n## Applies to\n- \n\n## Example\n```\n\n```\n\n## Exceptions\n- ",
  },
  {
    id: "gotcha",
    label: "Gotcha",
    glyph: "⚠",
    kind: "note",
    help: "The trap that keeps catching people.",
    titleHint: "The dev server caches .env until restart",
    content: "## Symptom\n\n\n## Cause\n\n\n## Do this instead\n\n\n## Do not\n- ",
  },
  {
    id: "glossary",
    label: "Glossary",
    glyph: "❡",
    kind: "context",
    help: "Words that only mean something here.",
    titleHint: "Project vocabulary",
    content:
      "## Terms\n- **term** — what it means here, and what it does not\n- **term** — what it means here, and what it does not",
  },
];
const TEMPLATE_BY_ID: Record<string, Template> = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

/* ── search ───────────────────────────────────────────────────── */

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Space-separated terms, all of which must appear. Empty query matches all. */
function parseTerms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchEntry(m: MemoryEntry, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = `${m.title}\n${m.content}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Splits on the search terms so the matches can be wrapped in <mark>. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const parts = useMemo(() => {
    if (!terms.length) return [{ text, hit: false }];
    const rx = new RegExp(`(${terms.map(escapeRx).join("|")})`, "gi");
    return text
      .split(rx)
      .filter((s) => s !== "")
      .map((s) => ({ text: s, hit: terms.includes(s.toLowerCase()) }));
  }, [text, terms]);

  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark className="mem-hit" key={i}>
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

/**
 * Keyword-in-context. A search result wants the sentence the word is in, not
 * the top of the document — and markdown rendered around a highlight would
 * mean splicing <mark> into generated HTML, which is how XSS holes are born.
 */
function snippet(content: string, terms: string[], span = 240): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= span) return flat;
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 60);
  const cut = flat.slice(start, start + span);
  return (start > 0 ? "…" : "") + cut.trimEnd() + (start + span < flat.length ? "…" : "");
}

/** Previews clamp on a word boundary; they never reproduce the entry. */
function clampText(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return (space > n * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

const fmt = (n: number): string => n.toLocaleString();

/* ── delete, undoably ─────────────────────────────────────────── */

/**
 * store.deleteMemory drops the row's links and assignments with it, so an Undo
 * that only re-inserted the text would hand back an entry no agent picks up
 * any more. Capture the graph first, redraw it against the new id.
 */
async function deleteWithUndo(entry: MemoryEntry): Promise<boolean> {
  const ref: EntityRef = { type: "memory", id: entry.id };
  const links = connectionsFor(ref).map((c) => c.link);
  const roles = assigneesOf(ref).map((a) => ({ subject: a.subject, role: a.role }));

  const ok = await confirmAction({
    title: `Delete “${entry.title}”?`,
    body: links.length
      ? `Agents in this project stop seeing it, and its ${links.length} connection${links.length === 1 ? "" : "s"} go with it. Undo restores both.`
      : "Agents in this project stop seeing it from their next run.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return false;

  const store = useStore.getState();
  try {
    await store.deleteMemory(entry.id);
  } catch (e) {
    toast.error("Could not delete that entry", e);
    return false;
  }

  const restore = async () => {
    try {
      const s = useStore.getState();
      const fresh = await s.addMemory({
        project_id: entry.project_id,
        kind: entry.kind,
        title: entry.title,
        content: entry.content,
        pinned: entry.pinned,
      });
      const next: EntityRef = { type: "memory", id: fresh.id };
      for (const l of links) {
        const from =
          l.from_type === "memory" && l.from_id === entry.id ? next : { type: l.from_type, id: l.from_id };
        const to = l.to_type === "memory" && l.to_id === entry.id ? next : { type: l.to_type, id: l.to_id };
        await s.addLink(from, to, l.kind, l.note, l.created_by);
      }
      for (const r of roles) await s.assign(r.subject, next, r.role);
    } catch (e) {
      toast.error("Could not restore that entry", e);
    }
  };

  toast.show({
    kind: "info",
    title: `Deleted “${entry.title}”`,
    detail: links.length
      ? `Undo brings it back with its ${links.length} connection${links.length === 1 ? "" : "s"}.`
      : undefined,
    action: { label: "Undo", run: () => void restore() },
  });
  return true;
}

/* ── the budget meter ─────────────────────────────────────────── */

/**
 * The one number nobody can infer from the list: how much of every prompt
 * these entries are already spending, and which of them are not being spent
 * at all.
 */
function BudgetMeter({ entries, projectName }: { entries: MemoryEntry[]; projectName: string }) {
  const injected = entries.slice(0, PROMPT_ENTRIES);
  // +1 for the newline agents.ts joins lines with.
  const chars = injected.reduce((n, m) => n + promptLine(m).length + 1, 0);
  const pinned = entries.reduce((n, m) => n + (m.pinned ? 1 : 0), 0);
  const dropped = entries.length - injected.length;
  const trimmed = injected.filter((m) => m.content.length > PROMPT_BODY_CHARS).length;
  const pct = Math.min(100, Math.round((chars / BUDGET_CEILING) * 100));
  const level = dropped > 0 ? "over" : pct >= 75 ? "high" : "ok";

  return (
    <section className="mem-meter" data-level={level} aria-label="Agent context budget">
      {/* One sentence carrying all three numbers. It was a lead paragraph, a
          bar and a three-item fact list stacked above the list — about 100px of
          preamble before the first entry. Nothing has been dropped. */}
      <p className="mem-meter-lead">
        Every run in <strong>{projectName}</strong> starts with{" "}
        <strong>{fmt(chars)}</strong> of ~{fmt(BUDGET_CEILING)} characters ·{" "}
        <strong>{injected.length}</strong> of {entries.length} entr
        {entries.length === 1 ? "y" : "ies"} sent · <strong>{pinned}</strong> pinned first
      </p>
      <div
        className="mem-meter-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${fmt(chars)} of about ${fmt(BUDGET_CEILING)} characters used`}
      >
        <span className="mem-meter-fill" style={{ width: `${Math.max(pct, chars ? 1.5 : 0)}%` }} />
      </div>
      {dropped > 0 && (
        <p className="mem-meter-warn">
          {dropped} entr{dropped === 1 ? "y never reaches" : "ies never reach"} an agent — only the
          first {PROMPT_ENTRIES} are sent, pinned first and then most recently updated. Pin what
          matters, or fold the stragglers into an entry that is already going.
        </p>
      )}
      {trimmed > 0 && (
        <p className="mem-meter-warn">
          {trimmed} sent entr{trimmed === 1 ? "y is" : "ies are"} cut off at {PROMPT_BODY_CHARS}{" "}
          characters. Put the load-bearing sentence first.
        </p>
      )}
    </section>
  );
}

/* ── a card in the list ───────────────────────────────────────── */

interface CardProps {
  entry: MemoryEntry;
  terms: string[];
  selected: boolean;
  /** Position in prompt order; -1 once it is past the cutoff. */
  rank: number;
  onOpen: () => void;
  onTogglePin: () => void;
}

function MemoryCard({ entry, terms, selected, rank, onOpen, onTogglePin }: CardProps) {
  const spec = KIND_BY_KEY[entry.kind] ?? KINDS[2];
  const searching = terms.length > 0;
  const dropped = rank < 0;
  const trimmed = entry.content.length > PROMPT_BODY_CHARS;

  return (
    <li className={"mem-card" + (selected ? " mem-card-on" : "") + (dropped ? " mem-card-out" : "")}>
      {/* Title first. The kind, the rank, the flags and the time used to sit in
          a strip above it, so the first thing read on every row was bookkeeping
          about the row. They are in the footer now, with each other. */}
      <div className="mem-card-head">
        {/* The stretched pseudo-element makes the whole card clickable while the
            accessible name stays on one real button. */}
        <button type="button" className="mem-card-open" aria-current={selected || undefined} onClick={onOpen}>
          <Highlight text={entry.title} terms={terms} />
        </button>
        {/* Above the card-wide hit area, so the pin stays its own control. */}
        <button
          type="button"
          className={"mem-pin" + (entry.pinned ? " mem-pin-on" : "")}
          aria-pressed={!!entry.pinned}
          aria-label={entry.pinned ? `Unpin ${entry.title}` : `Pin ${entry.title} to the front of every prompt`}
          title={entry.pinned ? "Pinned — always first in agent context" : "Pin to the front of every prompt"}
          onClick={onTogglePin}
        >
          {entry.pinned ? <IconPinFilled size={13} /> : <IconPin size={13} />}
        </button>
      </div>

      {entry.content.trim() &&
        (searching ? (
          <p className="mem-card-snip">
            <Highlight text={snippet(entry.content, terms)} terms={terms} />
          </p>
        ) : (
          <div className="mem-card-md">
            <Markdown text={clampText(entry.content, 300)} />
          </div>
        ))}

      <div className="mem-card-foot">
        <span className="mem-card-kind" data-kind={entry.kind}>
          <spec.Icon size={11} className="mem-card-kind-glyph" />
          {spec.label}
        </span>
        {dropped ? (
          <span className="mem-flag mem-flag-out" title={`Past the ${PROMPT_ENTRIES}-entry cutoff — agents never see this one.`}>
            not sent
          </span>
        ) : (
          <span className="mem-card-rank" title={`Line ${rank + 1} of the memory block in every prompt.`}>
            #{rank + 1}
          </span>
        )}
        {trimmed && !dropped && (
          <span className="mem-flag mem-flag-trim" title={`Agents see the first ${PROMPT_BODY_CHARS} characters.`}>
            trimmed
          </span>
        )}
        <ConnectionsSummary anchor={{ type: "memory", id: entry.id }} />
        <span className="mem-card-time">{timeAgo(entry.updated_at || entry.created_at)}</span>
      </div>
    </li>
  );
}

/* ── templates ────────────────────────────────────────────────── */

function TemplateGrid({ onPick, compact }: { onPick: (t: Template) => void; compact?: boolean }) {
  return (
    <ul className={"mem-tpl" + (compact ? " mem-tpl-compact" : "")}>
      {TEMPLATES.map((t) => (
        <li key={t.id}>
          <button type="button" className="mem-tpl-btn" onClick={() => onPick(t)}>
            <span className="mem-tpl-glyph" aria-hidden="true">
              {t.glyph}
            </span>
            <span className="mem-tpl-name">{t.label}</span>
            <span className="mem-tpl-help">{t.help}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ── the reader ───────────────────────────────────────────────── */

function Reader({
  entry,
  rank,
  onEdit,
  onBack,
  showBack,
}: {
  entry: MemoryEntry;
  rank: number;
  onEdit: () => void;
  onBack: () => void;
  showBack: boolean;
}) {
  const updateMemory = useStore((s) => s.updateMemory);
  const spec = KIND_BY_KEY[entry.kind] ?? KINDS[2];
  const line = promptLine(entry);
  const dropped = rank < 0;
  const trimmed = entry.content.length > PROMPT_BODY_CHARS;

  return (
    <article className="mem-read" aria-label={entry.title}>
      <div className="mem-read-bar">
        {showBack && (
          <button type="button" className="btn" onClick={onBack}>
            ← All entries
          </button>
        )}
        <span className="mem-read-spacer" />
        <button
          type="button"
          className={"btn" + (entry.pinned ? " primary" : "")}
          aria-pressed={!!entry.pinned}
          onClick={() => void updateMemory(entry.id, { pinned: entry.pinned ? 0 : 1 })}
        >
          {entry.pinned ? <IconPinFilled size={12} /> : <IconPin size={12} />}
          {entry.pinned ? "Pinned" : "Pin"}
        </button>
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="btn danger"
          onClick={async () => {
            if (await deleteWithUndo(entry)) onBack();
          }}
        >
          Delete
        </button>
      </div>

      <header className="mem-read-head">
        <h2 className="mem-read-title">{entry.title}</h2>
        <p className="mem-read-meta">
          <span className="mem-card-kind" data-kind={entry.kind}>
            <spec.Icon size={11} className="mem-card-kind-glyph" />
            {spec.label}
          </span>
          <span>{spec.help}</span>
          <span>·</span>
          <span>updated {timeAgo(entry.updated_at || entry.created_at)}</span>
          <span>·</span>
          <span>added {timeAgo(entry.created_at)}</span>
        </p>
      </header>

      {entry.content.trim() ? (
        <div className="mem-read-body">
          <Markdown text={entry.content} />
        </div>
      ) : (
        <p className="mem-none">No body yet — the title is all an agent gets.</p>
      )}

      <section className="mem-read-prompt" aria-label="What agents receive">
        <h3 className="mem-h3">What the agent actually receives</h3>
        <p className="mem-sub">
          {dropped
            ? `Nothing. This entry sits past the ${PROMPT_ENTRIES}-entry cutoff, so it is not in the prompt at all — pin it, or update it to bring it forward.`
            : `Line ${rank + 1} of the memory block, verbatim${trimmed ? `, cut at ${PROMPT_BODY_CHARS} characters` : ""}.`}
        </p>
        {!dropped && (
          <pre className="mem-prompt-line">
            <code>{line}</code>
          </pre>
        )}
        {!dropped && (
          <p className="mem-sub">
            {fmt(line.length)} characters of the ~{fmt(BUDGET_CEILING)} this project has to spend.
            {trimmed && ` ${fmt(entry.content.length - PROMPT_BODY_CHARS)} characters of the body never leave this screen.`}
          </p>
        )}
      </section>

      <section className="mem-read-cx" aria-label="Connections">
        <h3 className="mem-h3">Connections</h3>
        <p className="mem-sub">
          Link this to a channel and that channel's agents inherit it as standing context; link it
          to a task or a PR and it travels with the work.
        </p>
        <ConnectionsPanel anchor={{ type: "memory", id: entry.id }} />
      </section>
    </article>
  );
}

/* ── the editor ───────────────────────────────────────────────── */

type EditMode = "write" | "both" | "preview";

/** Everything an entry is, as one value — the unit autosave persists. */
interface Draft {
  title: string;
  content: string;
  kind: MemoryKind;
  pinned: boolean;
}

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.title === b.title && a.content === b.content && a.kind === b.kind && a.pinned === b.pinned;

function Editor({
  entry,
  projectId,
  template,
  wide,
  pinnedOthers,
  onCreated,
  onClose,
  onDeleted,
}: {
  /** null until the row exists; set by onCreated without remounting us. */
  entry: MemoryEntry | null;
  projectId: string;
  template: Template | null;
  wide: boolean;
  /** Pinned entries in this project other than this one — where it will land. */
  pinnedOthers: number;
  /** The row now exists, so the list can follow it. Never closes the pane. */
  onCreated: (id: string) => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const addMemory = useStore((s) => s.addMemory);
  const updateMemory = useStore((s) => s.updateMemory);

  const [title, setTitle] = useState(entry?.title ?? "");
  const [content, setContent] = useState(entry?.content ?? template?.content ?? "");
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? template?.kind ?? "note");
  const [pinned, setPinned] = useState(!!entry?.pinned);
  const [mode, setMode] = useState<EditMode>("write");
  const [liveId, setLiveId] = useState<string | null>(entry?.id ?? null);
  const [hint, setHint] = useState<string>(template?.titleHint ?? "We use pnpm, not npm");

  const titleRef = useRef<HTMLInputElement>(null);
  /**
   * The id autosave writes against. A ref as well as state because the save
   * that *creates* the row and the save 700ms later run from two different
   * closures, and the second one must update rather than insert a twin.
   */
  const idRef = useRef<string | null>(entry?.id ?? null);

  useLayoutEffect(() => {
    titleRef.current?.focus();
  }, []);

  // "Both" is a two-column layout; in one column it would be two half-panes.
  const view: EditMode = !wide && mode === "both" ? "write" : mode;

  const draft = useMemo<Draft>(() => ({ title, content, kind, pinned }), [title, content, kind, pinned]);

  const save = useCallback(
    async (d: Draft) => {
      const t = d.title.trim();
      // An untitled draft has no row to be, and inventing "Untitled" would put
      // a placeholder in front of every agent. The chip says so; nothing else
      // happens until there is a title.
      if (!t) return;
      const patch = { title: t, content: d.content, kind: d.kind, pinned: d.pinned ? 1 : 0 } as const;
      if (idRef.current) {
        await updateMemory(idRef.current, patch);
        return;
      }
      const fresh = await addMemory({ project_id: projectId, ...patch });
      idRef.current = fresh.id;
      setLiveId(fresh.id);
      // The editor is keyed on the selection, not the id, so handing the id up
      // selects the new row in the list without remounting us mid-sentence.
      onCreated(fresh.id);
    },
    [projectId, addMemory, updateMemory, onCreated]
  );

  const autosave = useAutosave(draft, save, { equal: sameDraft });
  const { flush } = autosave;
  // Waits for the write to land, and for the render that reports how it went,
  // before it says closing is safe — a failed save keeps the pane open.
  const { close, closing } = useCloseGuard(autosave);

  const untitled = !title.trim();
  /** ⌘S is a question — "is my work safe?" — so answer it, or say what is missing. */
  const confirmSave = useCallback(async () => {
    if (!title.trim()) {
      titleRef.current?.focus();
      toast.warn("Give it a title", "The title is the line agents scan first — and what this is saved under.");
      return;
    }
    await flush();
  }, [title, flush]);
  useSaveShortcut(confirmSave);

  /** Done means "I am finished with this", so it commits before it leaves. */
  const done = useCallback(async () => {
    // An existing entry whose title has been emptied is the one case where
    // closing would drop real work: nothing has saved since the title went, so
    // the pane stays put until there is something to save under.
    if (idRef.current && untitled) {
      titleRef.current?.focus();
      toast.warn("Give it a title", "Nothing has saved since the title was cleared.");
      return;
    }
    if (!idRef.current && untitled) {
      // Nothing was ever written. Only worth a confirmation if there is prose
      // to lose; a blank pane closes silently.
      if (content.trim()) {
        const ok = await confirmAction({
          title: "Discard this draft?",
          body: "It has no title, so there is nothing to save it under and nothing will remember it.",
          confirmLabel: "Discard",
          danger: true,
        });
        if (!ok) {
          titleRef.current?.focus();
          return;
        }
      }
      onClose();
      return;
    }
    if (await close()) onClose();
  }, [untitled, content, close, onClose]);

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "Enter") {
      e.preventDefault();
      void done();
    } else if (e.key === "Escape") {
      // preventDefault + stopPropagation keeps this keystroke off the
      // inspector drawer and the command palette, both of which close on it.
      e.preventDefault();
      e.stopPropagation();
      void done();
    }
  };

  const over = Math.max(0, content.length - PROMPT_BODY_CHARS);
  const anchor: EntityRef | null = liveId ? { type: "memory", id: liveId } : null;

  return (
    <div className="mem-ed" onKeyDown={onKey}>
      <div className="mem-ed-bar">
        <span className="mem-ed-what">{liveId ? "Editing" : "New entry"}</span>
        {/* Autosave has no word for "there is nowhere to save this yet", and
            letting it say "Saved" over an untitled draft would be the one lie
            that undoes the whole indicator. */}
        {untitled ? (
          <span className="mem-blocked" role="status">
            {liveId ? "Title needed — edits are not saving" : "Needs a title"}
          </span>
        ) : (
          <SaveState autosave={autosave} />
        )}
        <span className="mem-read-spacer" />
      </div>

      <input
        ref={titleRef}
        className="mem-ed-title"
        value={title}
        placeholder={hint}
        aria-label="Entry title"
        onChange={(e) => setTitle(e.target.value)}
      />

      {/* Two chip groups sit in this row and they do opposite things: one sets a
          property of the entry, the other changes what this editor shows. They
          used to be identical and unlabelled, which made the row a coin toss.
          Each now says which it is, in the same voice as the list's "Sort". */}
      <div className="mem-ed-controls">
        <span className="mem-ed-label">Kind</span>
        <RadioChips
          label="Kind of memory"
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({ value: k.key, label: k.label, title: k.help }))}
        />
        <button
          type="button"
          className={"mem-toggle" + (pinned ? " mem-toggle-on" : "")}
          aria-pressed={pinned}
          onClick={() => setPinned((v) => !v)}
          title="Pinned entries lead the memory block in every prompt."
        >
          {pinned ? <IconPinFilled size={12} /> : <IconPin size={12} />} Pinned
        </button>
        <span className="mem-read-spacer" />
        <span className="mem-ed-label">View</span>
        <RadioChips
          label="Editor layout"
          value={view}
          onChange={setMode}
          options={
            wide
              ? [
                  { value: "write" as EditMode, label: "Write" },
                  { value: "both" as EditMode, label: "Split" },
                  { value: "preview" as EditMode, label: "Preview" },
                ]
              : [
                  { value: "write" as EditMode, label: "Write" },
                  { value: "preview" as EditMode, label: "Preview" },
                ]
          }
        />
      </div>

      {!liveId && !content.trim() && (
        <div className="mem-ed-tpl">
          <p className="mem-sub">Start from a shape:</p>
          <TemplateGrid
            compact
            onPick={(t) => {
              setContent(t.content);
              setKind(t.kind);
              setHint(t.titleHint);
            }}
          />
        </div>
      )}

      <div className="mem-ed-panes" data-view={view}>
        {view !== "preview" && (
          <textarea
            className="mem-ed-text"
            value={content}
            aria-label="Entry body, markdown"
            placeholder={"Markdown. Write it the way you would tell a new teammate — the shortest thing that stops the question coming back."}
            onChange={(e) => setContent(e.target.value)}
          />
        )}
        {view !== "write" && (
          <div className="mem-ed-preview" aria-label="Preview">
            {content.trim() ? <Markdown text={content} /> : <p className="mem-none">Nothing to preview yet.</p>}
          </div>
        )}
      </div>

      <p className={"mem-ed-count" + (over ? " mem-ed-count-over" : "")} aria-live="polite">
        {fmt(content.length)} characters
        {over > 0
          ? ` — agents receive the first ${fmt(PROMPT_BODY_CHARS)}; the last ${fmt(over)} are dropped from the prompt.`
          : ` of the ${fmt(PROMPT_BODY_CHARS)} an agent will read.`}
      </p>

      <Impact draft={draft} pinnedOthers={pinnedOthers} />

      <section className="mem-ed-cx" aria-label="Connections">
        <h3 className="mem-h3">Connections</h3>
        <p className="mem-sub">
          A memory entry linked to a channel is how that channel's agents learn it. Link it to the
          task or PR it came out of and it travels with the work.
        </p>
        {anchor ? (
          <ConnectionsPanel anchor={anchor} compact />
        ) : (
          <p className="mem-none">Title it and it saves itself — then you can link it from here.</p>
        )}
      </section>

      <div className="mem-ed-foot">
        {entry ? (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (await deleteWithUndo(entry)) onDeleted();
            }}
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="mem-ed-foot-right">
          {/* The shortcuts used to be a permanent strip of <kbd> in the editor
              bar. They live on the control they finish instead — visible when
              somebody is looking for the way out, and costing nothing until
              then. */}
          <button
            type="button"
            className="btn primary"
            disabled={closing}
            title="⌘S saves now · ⌘⏎ or esc closes"
            onClick={() => void done()}
          >
            {closing ? "Saving…" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What this entry costs and where it lands, recomputed as it is typed.
 *
 * The list's meter answers "how much is the project spending"; this answers the
 * question the writer actually has — "is the thing I am writing going to be
 * read?" Pinned is the only lever that guarantees yes, so pinning is stated as
 * a position rather than as a decoration.
 */
function Impact({ draft, pinnedOthers }: { draft: Draft; pinnedOthers: number }) {
  const line = promptLine({
    kind: draft.kind,
    title: draft.title.trim() || "…",
    content: draft.content,
  } as MemoryEntry);
  // Store order is `pinned DESC, updated_at DESC` and every save bumps
  // updated_at, so saving lands this entry at the front of its own group.
  const rank = draft.pinned ? 0 : pinnedOthers;
  const dropped = rank >= PROMPT_ENTRIES;
  const trimmed = draft.content.length > PROMPT_BODY_CHARS;

  return (
    <section
      className="mem-impact"
      data-level={dropped ? "out" : draft.pinned ? "pin" : "ok"}
      aria-label="What this entry costs"
    >
      <p className="mem-impact-line">
        <strong>{fmt(line.length)}</strong> characters of the ~{fmt(BUDGET_CEILING)} this project
        spends on memory, in <strong>every</strong> run.
      </p>
      <p className="mem-impact-line">
        {dropped ? (
          <>
            {pinnedOthers} pinned entr{pinnedOthers === 1 ? "y is" : "ies are"} already ahead of it,
            so this one never reaches an agent. Pin it and it goes first.
          </>
        ) : draft.pinned ? (
          <>
            <strong>Pinned</strong> — it leads the memory block, so an agent reads it before
            anything else in this project.
          </>
        ) : (
          <>
            Saving puts it at line <strong>{rank + 1}</strong> of the memory block: pinned entries
            first, then the most recently edited, which is now this one.
          </>
        )}
      </p>
      {trimmed && (
        <p className="mem-impact-line mem-impact-warn">
          The last {fmt(draft.content.length - PROMPT_BODY_CHARS)} characters are cut before an
          agent sees them. Put the load-bearing sentence first.
        </p>
      )}
    </section>
  );
}

/* ── the view ─────────────────────────────────────────────────── */

type Sel =
  | { mode: "read"; id: string }
  | { mode: "edit"; id: string; seq: number }
  | { mode: "new"; template: string | null; seq: number };

/** Below this the two panes would each be too narrow to read. */
const SPLIT_AT = 900;

export function MemoryView() {
  const projects = useStore((s) => s.projects);
  const memory = useStore((s) => s.memory);
  const updateMemory = useStore((s) => s.updateMemory);

  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<MemoryKind | "all">("all");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("updated");
  const [sel, setSel] = useState<Sel | null>(null);
  const seq = useRef(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The window is the wrong thing to measure: the sidebar and the inspector
  // both eat into this pane without the window changing size.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const wide = width === 0 || width >= SPLIT_AT;

  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const pid = project?.id ?? "";

  /** Store order — pinned first, then most recently updated. Prompt order. */
  const entries = useMemo(() => memory.filter((m) => m.project_id === pid), [memory, pid]);

  /** id → line number in the prompt, or -1 for the ones past the cutoff. */
  const rankById = useMemo(() => {
    const map = new Map<string, number>();
    entries.forEach((m, i) => map.set(m.id, i < PROMPT_ENTRIES ? i : -1));
    return map;
  }, [entries]);

  const terms = useMemo(() => parseTerms(query), [query]);

  const shown = useMemo(() => {
    const list = entries.filter(
      (m) =>
        (kindFilter === "all" || m.kind === kindFilter) &&
        (!pinnedOnly || !!m.pinned) &&
        matchEntry(m, terms)
    );
    // Pinned stays on top whatever the sort, because that is what the prompt
    // does — a list that disagreed with the prompt would be the bug.
    return list.sort((a, b) => {
      const p = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (p) return p;
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "created") return b.created_at - a.created_at;
      return (b.updated_at || b.created_at) - (a.updated_at || a.created_at);
    });
  }, [entries, kindFilter, pinnedOnly, terms, sort]);

  const selectedId = sel && sel.mode !== "new" ? sel.id : null;
  const selected = selectedId ? entries.find((m) => m.id === selectedId) ?? null : null;
  // A deleted entry (or a project switch) leaves a selection pointing nowhere.
  useEffect(() => {
    if (selectedId && !selected) setSel(null);
  }, [selectedId, selected]);

  const openNew = useCallback((template: Template | null) => {
    seq.current += 1;
    setSel({ mode: "new", template: template?.id ?? null, seq: seq.current });
  }, []);
  const openEdit = useCallback((id: string) => {
    seq.current += 1;
    setSel({ mode: "edit", id, seq: seq.current });
  }, []);

  if (!projects.length) {
    return (
      <div className="main-pane center-note">
        <p>Create a project first — memory is per-project shared context.</p>
      </div>
    );
  }

  const kindCounts = KINDS.map((k) => entries.filter((m) => m.kind === k.key).length);
  const showList = wide || !sel;
  const showDetail = wide || !!sel;

  const detail = (() => {
    if (sel?.mode === "new" || sel?.mode === "edit") {
      const editing = sel.mode === "edit" ? entries.find((m) => m.id === sel.id) ?? null : null;
      // Keyed by seq, not by id: creating a row swaps `entry` in underneath a
      // live editor, and remounting there would eat the caret.
      return (
        <Editor
          key={`ed-${sel.seq}`}
          entry={editing}
          projectId={pid}
          template={sel.mode === "new" && sel.template ? TEMPLATE_BY_ID[sel.template] ?? null : null}
          wide={wide}
          pinnedOthers={entries.reduce(
            (n, m) => n + (m.pinned && !(sel.mode === "edit" && m.id === sel.id) ? 1 : 0),
            0
          )}
          onCreated={(id) => setSel({ mode: "edit", id, seq: sel.seq })}
          onClose={() => setSel(sel.mode === "edit" ? { mode: "read", id: sel.id } : null)}
          onDeleted={() => setSel(null)}
        />
      );
    }
    if (selected) {
      return (
        <Reader
          entry={selected}
          rank={rankById.get(selected.id) ?? -1}
          showBack={!wide}
          onEdit={() => openEdit(selected.id)}
          onBack={() => setSel(null)}
        />
      );
    }
    return (
      <div className="mem-blank">
        <h2 className="mem-blank-title">
          {entries.length ? "Pick an entry" : "Nothing here yet — that is the expensive state"}
        </h2>
        <p className="mem-blank-text">
          {entries.length
            ? "Or start a new one from a shape below. Everything on the left is already in every prompt; what you add joins it."
            : "Agents in this project start every run knowing only what the repo tells them. Write down the decisions and traps they keep having to rediscover."}
        </p>
        <TemplateGrid onPick={(t) => openNew(t)} />
      </div>
    );
  })();

  return (
    <div className="main-pane mem" ref={rootRef} data-wide={wide ? "1" : undefined}>
      <div className="pane-header">
        <div>
          <div className="pane-title">Project memory</div>
          <div className="pane-sub">
            {projects.map((p) => (
              <button
                key={p.id}
                className={"chip select-chip" + (p.id === pid ? " active" : "")}
                aria-pressed={p.id === pid}
                onClick={() => {
                  setProjectId(p.id);
                  setSel(null);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <button className="btn primary" onClick={() => openNew(null)}>
          <IconPlus size={12} /> New entry
        </button>
      </div>

      <div className="mem-body">
        {showList && (
          <div className="mem-list-col">
            <BudgetMeter entries={entries} projectName={project?.name ?? "this project"} />

            {/* Two rows, and it was three. Row one changes how you look at the
                list — a query and an order. Row two changes what is in it, and
                ends with the count that row just produced. The two systems do
                not share a look: ordering wears a labelled select, filtering
                wears chips. */}
            <div className="mem-tools">
              <div className="mem-tools-row">
                <div className="mem-search">
                  <IconSearch size={13} className="mem-search-icon" />
                  <input
                    type="search"
                    className="mem-search-input"
                    value={query}
                    placeholder="Search titles and bodies"
                    aria-label="Search project memory"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <label className="mem-sort">
                  <span className="mem-sort-label">Sort</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                    {SORTS.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p
                  className="mem-count"
                  aria-live="polite"
                  title="Pinned entries lead the list whatever the sort, because that is what the prompt does."
                >
                  {shown.length === entries.length
                    ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`
                    : `${shown.length} of ${entries.length} shown`}
                </p>
              </div>
              <div className="mem-filters">
                <RadioChips
                  label="Filter by kind"
                  value={kindFilter}
                  onChange={setKindFilter}
                  options={[
                    { value: "all" as const, label: `All ${entries.length}` },
                    // No glyph, no separator. The word already said
                    // "Decisions"; four repeated decorations and four middots
                    // were between them the reason this row needed a second
                    // line, and a second line of chrome costs more than they
                    // were worth.
                    ...KINDS.map((k, i) => ({
                      value: k.key,
                      label: `${k.plural} ${kindCounts[i]}`,
                      title: `${k.help} — ${kindCounts[i]} in this project.`,
                    })),
                  ]}
                />
                <button
                  type="button"
                  className={"mem-toggle" + (pinnedOnly ? " mem-toggle-on" : "")}
                  aria-pressed={pinnedOnly}
                  title="Show only the entries that lead every prompt"
                  onClick={() => setPinnedOnly((v) => !v)}
                >
                  {pinnedOnly ? <IconPinFilled size={12} /> : <IconPin size={12} />} Pinned
                </button>
              </div>
            </div>

            {shown.length > 0 ? (
              <ul className="mem-list">
                {shown.map((m) => (
                  <MemoryCard
                    key={m.id}
                    entry={m}
                    terms={terms}
                    selected={m.id === selectedId}
                    rank={rankById.get(m.id) ?? -1}
                    onOpen={() => setSel({ mode: "read", id: m.id })}
                    onTogglePin={() => void updateMemory(m.id, { pinned: m.pinned ? 0 : 1 })}
                  />
                ))}
              </ul>
            ) : (
              <div className="mem-empty">
                {entries.length ? (
                  <>
                    <p>Nothing matches that.</p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setQuery("");
                        setKindFilter("all");
                        setPinnedOnly(false);
                      }}
                    >
                      Clear filters
                    </button>
                  </>
                ) : (
                  <p>
                    No memory yet. Agents will keep asking the same questions until something is
                    written here.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {showDetail && <div className="mem-detail-col">{detail}</div>}
      </div>
    </div>
  );
}
