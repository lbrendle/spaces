/**
 * Knowledge base — the notes Spaces holds, behind one search box.
 *
 * A collection is markdown that has been brought *into* the workspace. That is
 * the load-bearing fact on this screen and the reason the copy talks about
 * importing rather than mounting: a folder is one way in, the content lives
 * here afterwards, and a collection stays readable on a machine that has never
 * seen the folder. The rail says where each one came from, whether that folder
 * is on this device, and — plainly, without dressing it up — how far the
 * content actually reaches today.
 *
 * Nothing on this screen writes back to a folder. Imported text is read here,
 * quoted to an agent here, and removed here; the files it came from are never
 * touched, and there is no edit affordance anywhere on the screen.
 *
 * Three sources sit side by side because they answer the same question from
 * different places: an imported collection, Spaces's own documents, and project
 * memory. Search treats them alike and always labels which one a hit came from,
 * since "where did this claim come from" is the first thing you ask of an
 * answer.
 *
 * The payoff is the last panel: hand the top matches to an agent as context.
 * That panel shows the notes it will send, the exact character count, and the
 * literal prompt — and lets you drop any of it first. Nobody should have to
 * guess what was in a prompt sent on their behalf.
 *
 * It opens beside the reader rather than over it, and that is the whole reason
 * it is not a dialog: deciding what to send means reading the notes you are
 * about to send, and a dialog covering them turns that into a memory test. With
 * the pane still live you can search, open another note, and add the one you
 * are looking at without losing a word of the question.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { uid } from "../db";
import { slug } from "../types";
import type { Agent, MemoryEntry } from "../types";
import { describeEntity } from "../entities";
import { listDocuments, type DocumentRecord } from "../operations";
import { triggerAgents, userTrigger } from "../agents";
import { timeAgo } from "../github";
import { confirmAction, toast } from "../toast";
import {
  KB_CONTENT_CAP,
  createCollection,
  folderName,
  importFiles,
  importFromFolder,
  inspectDrop,
  kbAccess,
  listCollections,
  listKbFiles,
  originReachable,
  readKbFile,
  reimport,
  removeCollection,
  searchKb,
  splitFrontmatter,
  updateCollection,
  watchFileDrop,
  type Collection,
  type CollectionFile,
  type ImportProgress,
  type ImportReport,
} from "../kb";
import { Field, mdToHtml, Spinner } from "./ui";
import { PanelSection, SidePanel, usePanel } from "./SidePanel";
import {
  IconAgents,
  IconDocument,
  IconMemory,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconX,
} from "./icons";
import "./knowledge.css";

/* ── limits, all of them visible somewhere on the screen ──────── */

/** Hits kept per source. Past this the query is too vague to rank honestly. */
const PER_SOURCE_LIMIT = 40;
/** Rows the list will draw. The count line always says how many there were. */
const MAX_ROWS = 60;
/** Notes offered to an agent by default; every one of them is droppable. */
const DEFAULT_CONTEXT_NOTES = 5;
/** Characters of any single note that go into a prompt. */
const PER_NOTE_CHARS = 6_000;
/** Context budget the meter fills toward. Over it is allowed, but shown. */
const CONTEXT_BUDGET = 24_000;
/** Keystroke settle time before a search runs. */
const DEBOUNCE_MS = 160;
/** Below this the reader takes the whole pane instead of squeezing both. */
const SPLIT_AT = 1080;

/** What the file picker offers when drag-and-drop is not an option. */
const PICKER_EXTENSIONS = ["md", "markdown", "mdx", "txt", "text", "rst", "org", "adoc", "canvas"];

/* ── shapes ───────────────────────────────────────────────────── */

type SourceKind = "collection" | "document" | "memory";

const SPACES_DOCUMENTS = "hq:documents";
const SPACES_MEMORY = "hq:memory";

/** The drop-target choice that means "put these in a collection of their own". */
const NEW_COLLECTION = "";

interface Hit {
  /** Stable across searches, so selection survives a re-query. */
  key: string;
  kind: SourceKind;
  /** Collection id, or one of the two Spaces pseudo-source ids. */
  sourceId: string;
  sourceLabel: string;
  id: string;
  title: string;
  /** rel_path in a collection; the document's shelf or the project otherwise. */
  path: string;
  snippet: string;
  score: number;
  modified: number;
}

interface ContextNote {
  key: string;
  title: string;
  sourceLabel: string;
  path: string;
  text: string;
}

interface ReaderState {
  hit: Hit;
  /** The note without its frontmatter, which is rendered separately. */
  text: string;
  front: string;
  size: number;
  modified: number;
  /** True when only the first KB_CONTENT_CAP characters were kept. */
  truncated: boolean;
  /** Whether this text is the workspace copy or a fuller read of the origin. */
  from: "workspace" | "origin";
  /** Absolute path, only when the origin folder is on this machine. */
  originPath: string;
  /** Resolves a [[wikilink]] to a rel_path in the same collection, or null. */
  resolve: (target: string) => string | null;
  /** Files in the same collection, for turning a resolved wikilink into a Hit. */
  siblings: CollectionFile[];
}

interface ImportingState {
  collectionId: string;
  done: number;
  total: number;
  path: string;
}

/* ── text helpers ─────────────────────────────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function termsOf(query: string): string[] {
  const phrase = query.trim().toLowerCase();
  if (!phrase) return [];
  return [...new Set(phrase.split(/\s+/).filter(Boolean))].slice(0, 6);
}

/**
 * Mirrors the scoring in vaults.ts searchVault(), which kb.ts delegates to and
 * which is not ours to import from, so that a document and an imported note
 * that match equally well sort next to each other instead of the Spaces sources
 * sinking to the bottom of every list. If the weights over there change, these
 * are the ones to change with them.
 */
function scoreText(title: string, body: string, terms: string[], phrase: string): number {
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  let score = 0;
  let inTitle = 0;
  let firstBodyHit = Number.MAX_SAFE_INTEGER;
  for (const term of terms) {
    if (lowerTitle.includes(term)) {
      score += 120;
      inTitle++;
    }
    const at = lowerBody.indexOf(term);
    if (at !== -1) {
      score += 30;
      firstBodyHit = Math.min(firstBodyHit, at + 1);
    }
  }
  if (!inTitle && firstBodyHit === Number.MAX_SAFE_INTEGER) return 0;
  if (inTitle === terms.length) score += 200;
  if (lowerTitle === phrase) score += 1000;
  else if (lowerTitle.startsWith(phrase)) score += 300;
  else if (lowerTitle.includes(phrase)) score += 150;
  if (terms.length > 1 && lowerBody.includes(phrase)) score += 80;
  if (firstBodyHit !== Number.MAX_SAFE_INTEGER) {
    score += Math.max(0, 40 - Math.floor(firstBodyHit / 40));
  }
  return score;
}

/** A window of body text around the first match, flattened to one line. */
function snippetFor(body: string, terms: string[], width = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1 || flat.length <= width) return flat.slice(0, width) + (flat.length > width ? "…" : "");
  const start = Math.max(0, at - 70);
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const count = (n: number) => n.toLocaleString();

/** The one-line summary of an import, for a toast. */
function reportDetail(report: ImportReport): string {
  return [
    report.unchanged ? `${count(report.unchanged)} unchanged` : "",
    report.skipped ? `${count(report.skipped)} too big or not text` : "",
    report.failed ? `${count(report.failed)} unreadable` : "",
    report.capped
      ? `${count(report.capped)} kept to the first ${count(KB_CONTENT_CAP)} characters`
      : "",
    report.truncated ? "the folder is bigger than one import can walk" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Highlights every occurrence of a search term inside plain text. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of terms) {
    let i = lower.indexOf(term);
    while (i !== -1) {
      spans.push([i, i + term.length]);
      i = lower.indexOf(term, i + term.length);
    }
  }
  if (!spans.length) return <>{text}</>;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  const out: ReactNode[] = [];
  let pos = 0;
  merged.forEach(([from, to], i) => {
    if (from > pos) out.push(text.slice(pos, from));
    out.push(
      <mark key={i} className="kb-mark">
        {text.slice(from, to)}
      </mark>
    );
    pos = to;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

/* ── wikilinks ────────────────────────────────────────────────── */

/*
 * Obsidian's [[target]] and [[target|label]] are the one bit of syntax the
 * markdown renderer in ui.tsx knows nothing about, and the one that matters
 * most in a folder of notes — a note's links *are* its structure.
 *
 * The renderer escapes its input and hands back HTML, so the substitution
 * happens on either side of it: private-use sentinels go in before, anchors
 * come out after. Any sentinel already present in the source is stripped
 * first, which is what makes the round trip safe. Rendering goes through
 * mdToHtml rather than <Markdown> for exactly this reason; it is the same
 * renderer the rest of Spaces uses, one layer down.
 */
const WIKI_OPEN = "\uE000";
const WIKI_CLOSE = "\uE001";

interface WikiLink {
  target: string;
  label: string;
  relPath: string | null;
}

function renderNote(
  body: string,
  resolve: (target: string) => string | null
): { html: string; links: WikiLink[] } {
  const links: WikiLink[] = [];
  // Code spans and fences are quoted text: a [[wikilink]] in them is an
  // example of the syntax, not a use of it.
  const parts = body.replace(/[\uE000\uE001]/g, "").split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const prepared = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(
        /\[\[([^\][|\n]+)(?:\|([^\]\n]+))?\]\]/g,
        (_m, target: string, alias: string | undefined) => {
          const clean = target.trim();
          const index = links.length;
          links.push({
            target: clean,
            label: (alias ?? clean).trim() || clean,
            relPath: resolve(clean),
          });
          return `${WIKI_OPEN}${index}${WIKI_CLOSE}`;
        }
      );
    })
    .join("");

  const html = mdToHtml(prepared).replace(/\uE000(\d+)\uE001/g, (_m, n: string) => {
    const link = links[Number(n)];
    if (!link) return "";
    const label = escapeHtml(link.label);
    // A link to a note that isn't here is not a link. Drawing one would
    // promise a destination that does not exist.
    return link.relPath
      ? `<a class="kb-wiki" role="button" tabindex="0" data-wiki="${n}">${label}</a>`
      : `<span class="kb-wiki-dead" title="No note called “${escapeHtml(link.target)}” in this collection">${label}</span>`;
  });
  return { html, links };
}

/** Basename without extension, lowercased — how a note is addressed. */
function noteKey(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

function buildResolver(files: CollectionFile[]): (target: string) => string | null {
  const byName = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const file of files) {
    const key = noteKey(file.rel_path);
    if (!byName.has(key)) byName.set(key, file.rel_path);
    byPath.set(file.rel_path.toLowerCase(), file.rel_path);
    byPath.set(file.rel_path.toLowerCase().replace(/\.[^./]+$/, ""), file.rel_path);
  }
  return (target: string) => {
    // Obsidian ignores a #heading or ^block suffix when resolving the file.
    const bare = target.split(/[#^]/)[0].trim().replace(/^\.?\//, "");
    if (!bare) return null;
    const lower = bare.toLowerCase();
    return byPath.get(lower) ?? byName.get(noteKey(lower)) ?? null;
  };
}

/* ── the hit list ─────────────────────────────────────────────── */

/*
 * Split out and memoised: the query lives in the parent, so every keystroke
 * re-renders it, and redrawing sixty rows per character is exactly the kind of
 * thing that makes a search box feel like treacle. `hits` and `terms` only
 * change when a search actually settles.
 */
const HitList = memo(function HitList({
  hits,
  terms,
  selectedKey,
  onSelect,
}: {
  hits: Hit[];
  terms: string[];
  selectedKey: string;
  onSelect: (hit: Hit) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  function onKeyDown(e: ReactKeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".kb-hit") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const next = buttons[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  return (
    <ul className="kb-hits" ref={listRef} onKeyDown={onKeyDown}>
      {hits.map((hit) => (
        <li key={hit.key}>
          <button
            type="button"
            className={"kb-hit" + (hit.key === selectedKey ? " kb-hit-on" : "")}
            aria-current={hit.key === selectedKey ? "true" : undefined}
            onClick={() => onSelect(hit)}
          >
            <span className="kb-hit-head">
              <span className="kb-hit-title">
                <Highlight text={hit.title} terms={terms} />
              </span>
              <span className="kb-tag">{hit.sourceLabel}</span>
            </span>
            <span className="kb-hit-path">{hit.path}</span>
            {hit.snippet && (
              <span className="kb-hit-snip">
                <Highlight text={hit.snippet} terms={terms} />
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
});

/* ── the view ─────────────────────────────────────────────────── */

export function KnowledgeView() {
  // Narrow selectors on purpose: this screen stays mounted while agents stream
  // into channels, and a whole-store subscription would redraw the hit list on
  // every token that arrives somewhere else entirely.
  const memory = useStore((s) => s.memory);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The window is the wrong thing to measure: the sidebar and the inspector
  // both eat into this pane without the window changing size.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = width > 0 && width < SPLIT_AT;

  const [collections, setCollections] = useState<Collection[]>([]);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [off, setOff] = useState<Record<string, true>>({});
  const [importing, setImporting] = useState<ImportingState | null>(null);
  /** Which origin folders are on this machine. Absent means "not checked yet". */
  const [reachable, setReachable] = useState<Record<string, boolean>>({});
  const [dropping, setDropping] = useState(false);
  const [dropTarget, setDropTarget] = useState<string>(NEW_COLLECTION);

  /*
   * A collection's file list is wanted twice — to resolve wikilinks and to look
   * up a note's size — and a five-thousand-row query per click on a search
   * result is not a thing to do twice, let alone every time. The key carries
   * last_indexed_at so a re-import invalidates the entry by construction.
   */
  const fileCache = useRef(new Map<string, CollectionFile[]>());
  const kbFiles = useCallback(
    async (collectionId: string): Promise<CollectionFile[]> => {
      const collection = collections.find((c) => c.id === collectionId);
      const key = `${collectionId}:${collection?.last_indexed_at ?? 0}`;
      const hit = fileCache.current.get(key);
      if (hit) return hit;
      const files = await listKbFiles(collectionId);
      fileCache.current.clear();
      fileCache.current.set(key, files);
      return files;
    },
    [collections]
  );

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);

  const [reader, setReader] = useState<ReaderState | null>(null);
  const [readerBusy, setReaderBusy] = useState(false);
  const [readerError, setReaderError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  const asking = usePanel();

  const refreshSources = useCallback(async () => {
    const [rows, documents] = await Promise.all([listCollections(), listDocuments()]);
    setCollections(rows);
    setDocs(documents);
    setSourcesLoaded(true);
    // Whether each origin folder is on this machine decides what the rail may
    // honestly offer — re-import and Reveal only mean something here.
    const checked = await Promise.all(
      rows.map(async (c) => [c.id, await originReachable(c)] as const)
    );
    setReachable(Object.fromEntries(checked));
  }, []);

  useEffect(() => {
    void refreshSources().catch((e) => toast.error("Could not load your sources", e));
  }, [refreshSources]);

  const enabled = useCallback((id: string) => !off[id], [off]);
  const toggle = useCallback((id: string) => {
    setOff((current) => {
      const next = { ...current };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }, []);

  const activeCollections = useMemo(
    () => collections.filter((c) => enabled(c.id)),
    [collections, enabled]
  );
  const mine = useMemo(() => collections.filter((c) => kbAccess(c) === "write"), [collections]);
  const docsOn = enabled(SPACES_DOCUMENTS);
  const memoryOn = enabled(SPACES_MEMORY);
  const anySource = activeCollections.length > 0 || docsOn || memoryOn;
  // Gated on the load so the "bring your notes in" pitch doesn't flash at
  // someone who already has three collections.
  const nothingHere =
    sourcesLoaded && collections.length === 0 && docs.length === 0 && memory.length === 0;

  const projectName = useCallback(
    (id: string) => projects.find((p) => p.id === id)?.name ?? "No project",
    [projects]
  );

  /* ── search ─────────────────────────────────────────────────── */

  // Debounced, and every run carries a token: a slow query that lands after a
  // newer one must not overwrite it.
  const runToken = useRef(0);
  const searchKey = [
    query,
    activeCollections.map((c) => `${c.id}:${c.last_indexed_at}`).join(","),
    docsOn ? docs.length : "-",
    memoryOn ? memory.length : "-",
  ].join("|");

  useEffect(() => {
    const token = ++runToken.current;
    const settled = termsOf(query);
    const phrase = query.trim().toLowerCase();
    setSearching(Boolean(phrase));

    const timer = window.setTimeout(() => {
      void (async () => {
        const collected: Hit[] = [];
        let overflowed = false;

        if (settled.length) {
          const perCollection = await Promise.all(
            activeCollections.map(async (collection) => {
              try {
                return {
                  collection,
                  rows: await searchKb(query, {
                    collectionId: collection.id,
                    limit: PER_SOURCE_LIMIT,
                  }),
                };
              } catch (e) {
                console.error("collection search failed", collection.name, e);
                return { collection, rows: [] };
              }
            })
          );
          for (const { collection, rows } of perCollection) {
            if (rows.length >= PER_SOURCE_LIMIT) overflowed = true;
            for (const row of rows) {
              collected.push({
                key: `collection:${row.id}`,
                kind: "collection",
                sourceId: collection.id,
                sourceLabel: collection.name,
                id: row.id,
                title: row.title || row.rel_path,
                path: row.rel_path,
                snippet: row.snippet,
                score: row.score,
                modified: row.modified_at,
              });
            }
          }

          if (docsOn) {
            for (const doc of docs) {
              const score = scoreText(doc.title, doc.body, settled, phrase);
              if (!score) continue;
              collected.push({
                key: `document:${doc.id}`,
                kind: "document",
                sourceId: SPACES_DOCUMENTS,
                sourceLabel: "Spaces documents",
                id: doc.id,
                title: doc.title || "Untitled",
                path: doc.path || "Notes",
                snippet: snippetFor(doc.body, settled),
                score,
                modified: doc.updated_at,
              });
            }
          }

          if (memoryOn) {
            for (const entry of memory) {
              const score = scoreText(entry.title, entry.content, settled, phrase);
              if (!score) continue;
              collected.push({
                key: `memory:${entry.id}`,
                kind: "memory",
                sourceId: SPACES_MEMORY,
                sourceLabel: "Project memory",
                id: entry.id,
                title: entry.title || "Untitled",
                path: `${projectName(entry.project_id)} · ${entry.kind}`,
                snippet: snippetFor(entry.content, settled),
                score,
                modified: entry.updated_at,
              });
            }
          }
          collected.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
        } else {
          // No query: the most recently touched notes, so the screen is never
          // an empty box staring back at you.
          const perCollection = await Promise.all(
            activeCollections.map(async (collection) => {
              try {
                return { collection, files: await kbFiles(collection.id) };
              } catch {
                return { collection, files: [] as CollectionFile[] };
              }
            })
          );
          for (const { collection, files } of perCollection) {
            // Only the newest can ever make the cut, so a five-thousand-note
            // collection contributes MAX_ROWS rows, not five thousand.
            const recent = [...files]
              .sort((a, b) => b.modified_at - a.modified_at)
              .slice(0, MAX_ROWS);
            if (files.length > recent.length) overflowed = true;
            for (const file of recent) {
              collected.push({
                key: `collection:${file.id}`,
                kind: "collection",
                sourceId: collection.id,
                sourceLabel: collection.name,
                id: file.id,
                title: file.title || file.rel_path,
                path: file.rel_path,
                snippet: "",
                score: 0,
                modified: file.modified_at,
              });
            }
          }
          if (docsOn) {
            for (const doc of docs) {
              collected.push({
                key: `document:${doc.id}`,
                kind: "document",
                sourceId: SPACES_DOCUMENTS,
                sourceLabel: "Spaces documents",
                id: doc.id,
                title: doc.title || "Untitled",
                path: doc.path || "Notes",
                snippet: snippetFor(doc.body, []),
                score: 0,
                modified: doc.updated_at,
              });
            }
          }
          if (memoryOn) {
            for (const entry of memory) {
              collected.push({
                key: `memory:${entry.id}`,
                kind: "memory",
                sourceId: SPACES_MEMORY,
                sourceLabel: "Project memory",
                id: entry.id,
                title: entry.title || "Untitled",
                path: `${projectName(entry.project_id)} · ${entry.kind}`,
                snippet: snippetFor(entry.content, []),
                score: 0,
                modified: entry.updated_at,
              });
            }
          }
          collected.sort((a, b) => b.modified - a.modified);
        }

        if (token !== runToken.current) return;
        setTruncated(overflowed || collected.length > MAX_ROWS);
        setHits(collected.slice(0, MAX_ROWS));
        setTerms(settled);
        setSearching(false);
      })();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // searchKey folds in every input the query depends on; the individual
    // sources are read inside and are stable for a given key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey]);

  /* ── the reader ─────────────────────────────────────────────── */

  const openHit = useCallback(
    (hit: Hit) => {
      setSelectedKey(hit.key);
      setReaderBusy(true);
      setReaderError("");
      void (async () => {
        try {
          if (hit.kind === "collection") {
            const [file, files] = await Promise.all([
              readKbFile(hit.sourceId, hit.path),
              kbFiles(hit.sourceId),
            ]);
            const meta = files.find((f) => f.rel_path === hit.path);
            const collection = collections.find((c) => c.id === hit.sourceId);
            const root = collection?.path ?? "";
            const { front, body } = splitFrontmatter(file.text);
            setReader({
              hit,
              text: body,
              front,
              size: meta?.size ?? file.size,
              modified: file.modified_at || hit.modified,
              truncated: file.truncated,
              from: file.from,
              // Only offered when the folder is actually here; a path that
              // resolves on somebody else's machine is not an address.
              originPath:
                root && reachable[hit.sourceId] ? `${root.replace(/\/+$/, "")}/${hit.path}` : "",
              resolve: buildResolver(files),
              siblings: files,
            });
          } else {
            const body =
              hit.kind === "document"
                ? docs.find((d) => d.id === hit.id)?.body ?? ""
                : memory.find((m: MemoryEntry) => m.id === hit.id)?.content ?? "";
            setReader({
              hit,
              text: body,
              front: "",
              size: body.length,
              modified: hit.modified,
              truncated: false,
              from: "workspace",
              originPath: "",
              // Nothing in Spaces's own rows lives in a collection, so a
              // [[wikilink]] written in one has no file to point at.
              resolve: () => null,
              siblings: [],
            });
          }
        } catch (e) {
          setReader(null);
          setReaderError(e instanceof Error ? e.message : String(e));
        } finally {
          setReaderBusy(false);
        }
      })();
    },
    [collections, docs, memory, kbFiles, reachable]
  );

  const note = useMemo(
    () => (reader ? renderNote(reader.text, reader.resolve) : null),
    [reader]
  );

  const followWiki = useCallback(
    (index: number) => {
      if (!reader || !note) return;
      const link = note.links[index];
      if (!link?.relPath) return;
      const meta = reader.siblings.find((f) => f.rel_path === link.relPath);
      if (!meta) return;
      openHit({
        key: `collection:${meta.id}`,
        kind: "collection",
        sourceId: reader.hit.sourceId,
        sourceLabel: reader.hit.sourceLabel,
        id: meta.id,
        title: meta.title || meta.rel_path,
        path: meta.rel_path,
        snippet: "",
        score: 0,
        modified: meta.modified_at,
      });
    },
    [note, openHit, reader]
  );

  function onNoteActivate(e: ReactMouseEvent | ReactKeyboardEvent) {
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return;
    const anchor = (e.target as HTMLElement | null)?.closest?.("[data-wiki]");
    const index = anchor?.getAttribute("data-wiki");
    if (index === null || index === undefined) return;
    e.preventDefault();
    followWiki(Number(index));
  }

  /* ── bringing content in ────────────────────────────────────── */

  const busy = Boolean(importing);

  async function importFolder(path?: string) {
    let picked: string | string[] | null = path ?? null;
    if (!picked) {
      try {
        picked = await open({
          directory: true,
          multiple: false,
          title: "Choose a folder of notes to import",
        });
      } catch (e) {
        toast.error("Could not open the folder picker", e);
        return;
      }
    }
    if (typeof picked !== "string" || !picked) return;
    const label = folderName(picked);
    setImporting({ collectionId: "", done: 0, total: 0, path: "" });
    try {
      const { collection, report } = await importFromFolder(picked, {
        onProgress: (p: ImportProgress) =>
          setImporting({ collectionId: "", done: p.done, total: p.total, path: p.path }),
      });
      await refreshSources();
      setDropTarget(collection.id);
      toast.success(
        `Imported ${count(report.imported)} of ${count(report.scanned)} files from ${label}`,
        reportDetail(report) || undefined
      );
    } catch (e) {
      toast.error(`Could not import ${label}`, e);
    } finally {
      setImporting(null);
    }
  }

  async function runReimport(collection: Collection) {
    setImporting({ collectionId: collection.id, done: 0, total: 0, path: "" });
    try {
      const report = await reimport(collection.id, (p: ImportProgress) =>
        setImporting({ collectionId: collection.id, done: p.done, total: p.total, path: p.path })
      );
      await refreshSources();
      if (report.originMissing) {
        // Not a failure. The point of importing is that the notes are already
        // here; the folder is simply somewhere this machine cannot see.
        toast.info(
          `${collection.name} is unchanged`,
          `Its folder is not on this device, so there was nothing to re-read. The ${count(collection.file_count)} notes already imported are still here.`
        );
      } else {
        toast.success(
          `${collection.name}: ${count(report.imported)} of ${count(report.scanned)} files brought up to date`,
          reportDetail(report) || undefined
        );
      }
    } catch (e) {
      toast.error(`Could not re-import ${collection.name}`, e);
    } finally {
      setImporting(null);
    }
  }

  /** Loose files, from a drop or the picker, into the chosen collection. */
  async function bringInFiles(files: { relPath: string; contents: string }[]) {
    if (!files.length) return;
    setImporting({ collectionId: dropTarget, done: 0, total: files.length, path: "" });
    try {
      let targetId = dropTarget;
      let target = collections.find((c) => c.id === targetId);
      if (!target || kbAccess(target) !== "write") {
        target = await createCollection({});
        targetId = target.id;
      }
      const report = await importFiles(files, targetId, (p: ImportProgress) =>
        setImporting({ collectionId: targetId, done: p.done, total: p.total, path: p.path })
      );
      await refreshSources();
      setDropTarget(targetId);
      toast.success(
        `Added ${count(report.imported)} ${report.imported === 1 ? "note" : "notes"} to ${target.name}`,
        report.skipped ? `${count(report.skipped)} were not text Spaces can hold` : undefined
      );
    } catch (e) {
      toast.error("Could not add those files", e);
    } finally {
      setImporting(null);
    }
  }

  function handleDrop(paths: string[]) {
    void (async () => {
      let drop;
      try {
        drop = await inspectDrop(paths);
      } catch (e) {
        toast.error("Could not read what was dropped", e);
        return;
      }
      if (drop.ignored.length && !drop.files.length && !drop.folders.length) {
        toast.warn(
          `Nothing to import from ${count(drop.ignored.length)} ${drop.ignored.length === 1 ? "file" : "files"}`,
          "Markdown and plain text only."
        );
        return;
      }
      // A dropped folder becomes its own collection so the folder is recorded
      // and can be re-imported later; loose files go where the drop target says.
      for (const folder of drop.folders) await importFolder(folder);
      if (drop.files.length) await bringInFiles(drop.files);
    })();
  }

  /*
   * The listener is global and lives for as long as the screen does, but the
   * handler reads state — which collection is the drop target, which ones
   * exist — that changes constantly. Re-registering on every one of those
   * changes would tear the listener down in the middle of somebody's drag, so
   * it is registered once and calls through this ref, which is refreshed after
   * every render and therefore always holds the current closure.
   */
  const dropHandler = useRef(handleDrop);
  useEffect(() => {
    dropHandler.current = handleDrop;
  });

  useEffect(() => {
    // Tauri intercepts file drops before the DOM sees them, so this is the
    // only way to receive one. Scoped to this pane by a hit test, and torn
    // down on unmount so a drop on another screen never lands here.
    return watchFileDrop({
      accepts: (x, y) => {
        const box = rootRef.current?.getBoundingClientRect();
        return Boolean(box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
      },
      onEnter: () => setDropping(true),
      onLeave: () => setDropping(false),
      onDrop: (paths) => dropHandler.current(paths),
      onUnsupported: (reason) =>
        toast.warn("Drag and drop is not available in this build", `${reason} Use “Choose files” instead.`),
    });
  }, []);

  /** The picker fallback, and the way in for anyone who would rather click. */
  async function chooseFiles() {
    let picked: string | string[] | null = null;
    try {
      picked = await open({
        multiple: true,
        title: "Choose markdown files to import",
        filters: [{ name: "Notes", extensions: PICKER_EXTENSIONS }],
      });
    } catch (e) {
      toast.error("Could not open the file picker", e);
      return;
    }
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    try {
      const drop = await inspectDrop(paths);
      await bringInFiles(drop.files);
    } catch (e) {
      toast.error("Could not read those files", e);
    }
  }

  async function forget(collection: Collection) {
    const here = reachable[collection.id];
    const ok = await confirmAction({
      title: `Delete ${collection.name}?`,
      body: here
        ? `The ${count(collection.file_count)} notes imported into this workspace are deleted. The folder they came from is untouched, so you can import it again.`
        : `The ${count(collection.file_count)} notes imported into this workspace are deleted. The folder they came from is not on this device, so this workspace has no other copy of them.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeCollection(collection.id);
      if (reader?.hit.sourceId === collection.id) {
        setReader(null);
        setSelectedKey("");
      }
      if (dropTarget === collection.id) setDropTarget(NEW_COLLECTION);
      await refreshSources();
    } catch (e) {
      toast.error(`Could not delete ${collection.name}`, e);
    }
  }

  async function flipVisibility(collection: Collection) {
    const next = collection.visibility === "workspace" ? "private" : "workspace";
    try {
      await updateCollection(collection.id, { visibility: next });
      await refreshSources();
    } catch (e) {
      toast.error(`Could not change who can read ${collection.name}`, e);
    }
  }

  /* ── rendering ──────────────────────────────────────────────── */

  const totalNotes =
    collections.reduce((sum, c) => sum + c.file_count, 0) + docs.length + memory.length;

  const dropZone = (
    <div
      className={"kb-drop" + (dropping ? " kb-drop-live" : "")}
      role="group"
      aria-label="Add markdown files"
    >
      <p className="kb-drop-line">
        {dropping ? "Drop to import into this workspace" : "Drop markdown files here"}
      </p>
      {mine.length > 0 && (
        <label className="kb-drop-where">
          <span>Into</span>
          <select
            value={dropTarget}
            onChange={(e) => setDropTarget(e.target.value)}
            disabled={busy}
          >
            <option value={NEW_COLLECTION}>A new collection</option>
            {mine.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="btn tiny" onClick={() => void chooseFiles()} disabled={busy}>
        Choose files
      </button>
    </div>
  );

  const rail = (
    <aside className="kb-rail" aria-label="Sources">
      <div className="kb-sec">
        <h3 className="kb-h3">
          Collections
          <span className="kb-h3-count">{collections.length || ""}</span>
        </h3>
        {collections.length === 0 && <p className="kb-none">Nothing imported yet.</p>}
        {collections.map((collection) => (
          <CollectionRow
            key={collection.id}
            collection={collection}
            on={enabled(collection.id)}
            originHere={reachable[collection.id] === true}
            importing={importing?.collectionId === collection.id ? importing : null}
            busy={busy}
            onToggle={() => toggle(collection.id)}
            onReimport={() => void runReimport(collection)}
            onFlipVisibility={() => void flipVisibility(collection)}
            onForget={() => void forget(collection)}
          />
        ))}
        {importing && !importing.collectionId && <Progress state={importing} />}
        <button className="btn" onClick={() => void importFolder()} disabled={busy}>
          <IconPlus size={12} /> Import a folder
        </button>
        {dropZone}
      </div>

      <div className="kb-sec">
        <h3 className="kb-h3">Inside Spaces</h3>
        <label className={"kb-src" + (docsOn ? " kb-src-on" : "")}>
          <input
            type="checkbox"
            className="kb-src-box"
            checked={docsOn}
            onChange={() => toggle(SPACES_DOCUMENTS)}
          />
          <span className="kb-src-text">
            <span className="kb-src-name">
              <IconDocument size={11} /> Spaces documents
            </span>
            <span className="kb-src-meta">{count(docs.length)} documents</span>
          </span>
        </label>
        <label className={"kb-src" + (memoryOn ? " kb-src-on" : "")}>
          <input
            type="checkbox"
            className="kb-src-box"
            checked={memoryOn}
            onChange={() => toggle(SPACES_MEMORY)}
          />
          <span className="kb-src-text">
            <span className="kb-src-name">
              <IconMemory size={11} /> Project memory
            </span>
            <span className="kb-src-meta">{count(memory.length)} entries</span>
          </span>
        </label>
      </div>

      <ReachNote />
    </aside>
  );

  const blank = nothingHere ? (
    <div className="kb-blank">
      <div className="kb-blank-mark">
        <IconSearch size={30} />
      </div>
      <h2 className="kb-blank-title">Bring your notes into Spaces</h2>
      <p className="kb-blank-text">
        Import an Obsidian vault, a docs directory, or a handful of markdown files.
        The text is copied in and becomes part of this workspace — searchable from
        here, quotable by an agent, and still here when the folder isn't.
      </p>
      <ul className="kb-blank-promises">
        <li>
          <span className="kb-blank-glyph">✓</span>
          <span>
            <b>The copy is Spaces's.</b> Import once; move, rename or archive the folder
            afterwards and the notes stay readable here.
          </span>
        </li>
        <li>
          <span className="kb-blank-glyph">✓</span>
          <span>
            <b>Nothing is written back.</b> There is no edit button on this screen.
            Spaces is not going to be the thing that mangles your notes.
          </span>
        </li>
        <li>
          <span className="kb-blank-glyph">✓</span>
          <span>
            <b>An agent only sees what you send it.</b> Asking one a question shows
            you the notes and the character count before anything leaves.
          </span>
        </li>
      </ul>
      <div className="kb-blank-acts">
        <button className="btn primary" onClick={() => void importFolder()} disabled={busy}>
          <IconPlus size={12} /> Import a folder
        </button>
        <button className="btn" onClick={() => void chooseFiles()} disabled={busy}>
          Choose files
        </button>
      </div>
      <ReachNote />
    </div>
  ) : null;

  /*
   * The search field, which lives in the pane header. It used to sit in a
   * toolbar of its own directly under the header — a second 57px band with its
   * own bottom rule, above every result forever — while the header's sub-line
   * repeated the note count the toolbar was already showing.
   */
  const search = (
    <div className="kb-search">
      <IconSearch size={13} className="kb-search-icon" />
      <input
        type="search"
        className="kb-search-input"
        value={query}
        placeholder={
          anySource ? "Search every source you have switched on" : "No sources switched on"
        }
        aria-label="Search the knowledge base"
        disabled={!anySource}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
        }}
      />
      {query && (
        <button
          type="button"
          className="kb-search-clear"
          aria-label="Clear the search"
          onClick={() => setQuery("")}
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  );

  const centre = (
    <div className="kb-center">
      {!anySource ? (
        <div className="kb-blank">
          <p className="kb-blank-text">
            Every source is switched off. Turn one back on in the rail to search it.
          </p>
        </div>
      ) : hits.length === 0 && !searching ? (
        <div className="kb-blank">
          <p className="kb-blank-text">
            {query.trim()
              ? `Nothing matches “${query.trim()}” in the sources you have on. Search covers titles and the first ${count(KB_CONTENT_CAP)} characters of each note.`
              : "Nothing in these sources yet. Import a folder, or switch on Spaces's own documents."}
          </p>
        </div>
      ) : (
        <HitList hits={hits} terms={terms} selectedKey={selectedKey} onSelect={openHit} />
      )}
    </div>
  );

  const readerPane = (
    <section className="kb-reader" aria-label="Note">
      {readerBusy && !reader ? (
        <div className="kb-blank">
          <Spinner />
        </div>
      ) : readerError ? (
        <div className="kb-blank">
          <p className="kb-blank-text">{readerError}</p>
        </div>
      ) : reader && note ? (
        <>
          <div className="kb-reader-head">
            {narrow && (
              <button
                className="btn tiny kb-back"
                onClick={() => {
                  setReader(null);
                  setSelectedKey("");
                }}
              >
                ← Back to results
              </button>
            )}
            <h2 className="kb-reader-title">{reader.hit.title}</h2>
            <div className="kb-reader-meta">
              <span className="kb-tag">{reader.hit.sourceLabel}</span>
              <span>{bytes(reader.size)}</span>
              {reader.modified > 0 && <span>modified {timeAgo(reader.modified)}</span>}
              {reader.from === "origin" && (
                <span title="The copy in this workspace was cut short, so this was read from the folder it came from — which only exists on this device.">
                  read from the original
                </span>
              )}
              {readerBusy && <Spinner />}
            </div>
            <div className="kb-reader-path">
              <code title={reader.originPath || reader.hit.path}>
                {reader.originPath || reader.hit.path}
              </code>
              {reader.originPath ? (
                <button
                  className="kb-mini"
                  title="Reveal the file this was imported from"
                  onClick={() => {
                    void revealItemInDir(reader.originPath).catch((e) =>
                      toast.error("Could not reveal that file", e)
                    );
                  }}
                >
                  Reveal
                </button>
              ) : null}
              <button
                className="kb-mini"
                title="Copy this path"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(reader.originPath || reader.hit.path)
                    .then(() => toast.success("Path copied"))
                    .catch((e) => toast.error("Could not copy the path", e));
                }}
              >
                Copy
              </button>
            </div>
          </div>
          {/* One scroll region for the note, and everything that belongs to the
              note inside it. The frontmatter used to fold open inside the fixed
              header behind a 140px scroller of its own, and the truncation
              notice was a filled bar pinned across the foot of the pane. */}
          <div className="kb-reader-scroll">
            {reader.front && (
              <details className="kb-front">
                <summary>Frontmatter</summary>
                <pre>{reader.front}</pre>
              </details>
            )}
            <div
              className="md kb-reader-body"
              onClick={onNoteActivate}
              onKeyDown={onNoteActivate}
              dangerouslySetInnerHTML={{ __html: note.html }}
            />
            {reader.truncated && (
              <p className="kb-reader-cut">
                Only the first {count(KB_CONTENT_CAP)} characters of this note were imported.
                The rest is in the file it came from.
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="kb-blank">
          <p className="kb-blank-text">
            Pick a result to read it here. Imported notes render with their{" "}
            <code>[[wikilinks]]</code> live — the ones that point at a note in the
            same collection, anyway. The rest stay as text.
          </p>
        </div>
      )}
    </section>
  );

  return (
    <div
      className="main-pane kb"
      ref={rootRef}
      data-narrow={narrow ? "1" : undefined}
      data-reading={reader ? "1" : undefined}
      data-dropping={dropping ? "1" : undefined}
    >
      <div className="pane-header">
        <div className="kb-head">
          <div className="pane-title">Knowledge base</div>
          {/* The sub-line said "3 collections · 412 notes" — a count the rail
              already heads and the count beside this field already gives. The
              search box has the room instead. */}
          <div className="pane-sub">
            {blank ? (
              "Search the notes you bring in, Spaces documents and project memory"
            ) : (
              <>
                {search}
                <span className="kb-count" aria-live="polite">
                  {searching ? (
                    <Spinner />
                  ) : query.trim() ? (
                    `${truncated ? `top ${count(hits.length)}` : count(hits.length)} ${hits.length === 1 ? "match" : "matches"}`
                  ) : (
                    `${count(totalNotes)} notes here`
                  )}
                </span>
              </>
            )}
          </div>
        </div>
        {!blank && (
          <button
            className="btn primary"
            onClick={() => asking.toggle()}
            aria-expanded={asking.open}
            disabled={hits.length === 0 || agents.length === 0 || channels.length === 0}
            title={
              agents.length === 0
                ? "Add an agent first"
                : channels.length === 0
                  ? "Agents answer in a channel — create one first"
                  : "Send the top matches to an agent as context"
            }
          >
            <IconAgents size={12} /> Ask an agent
          </button>
        )}
        <button className="btn" onClick={() => void importFolder()} disabled={busy}>
          <IconPlus size={12} /> Import a folder
        </button>
      </div>

      {blank ?? (
        <div className="kb-body">
          {rail}
          {centre}
          {(!narrow || reader) && readerPane}
        </div>
      )}

      {dropping && (
        <div className="kb-drop-veil" aria-hidden="true">
          <span>Drop markdown to import it into this workspace</span>
        </div>
      )}

      {asking.open && (
        <AskPanel
          hits={hits}
          question={query}
          docs={docs}
          memory={memory}
          /* Live, not frozen: opening another note while the panel is up is
             exactly what the panel is for, so it can offer to attach it. */
          reading={reader?.hit ?? null}
          onClose={asking.hide}
        />
      )}
    </div>
  );
}

/* ── the rail's collection row ────────────────────────────────── */

/**
 * One collection: what it holds, where it came in from, and what may be done
 * with it here. The origin line is the honest part — it says "imported from"
 * rather than naming a location, and when that folder is not on this device it
 * says so instead of offering a re-import that cannot work.
 */
function CollectionRow({
  collection,
  on,
  originHere,
  importing,
  busy,
  onToggle,
  onReimport,
  onFlipVisibility,
  onForget,
}: {
  collection: Collection;
  on: boolean;
  originHere: boolean;
  importing: ImportingState | null;
  busy: boolean;
  onToggle: () => void;
  onReimport: () => void;
  onFlipVisibility: () => void;
  onForget: () => void;
}) {
  const owned = kbAccess(collection) === "write";
  const shared = collection.visibility === "workspace";
  const owner = describeEntity({ type: "member", id: collection.owner_member_id });
  return (
    <div>
      <label className={"kb-src" + (on ? " kb-src-on" : "")}>
        <input type="checkbox" className="kb-src-box" checked={on} onChange={onToggle} />
        <span className="kb-src-text">
          <span className="kb-src-name">{collection.name}</span>
          <span className="kb-src-meta">
            {collection.last_indexed_at
              ? `${count(collection.file_count)} notes · imported ${timeAgo(collection.last_indexed_at)}`
              : `${count(collection.file_count)} notes`}
          </span>
          {collection.path ? (
            <span className="kb-src-origin" title={collection.path}>
              imported from {collection.path}
              {!originHere && <span className="kb-src-away"> · not on this device</span>}
            </span>
          ) : (
            <span className="kb-src-origin">added file by file</span>
          )}
          {/* Ownership and reach are state, not an action, so they stay
              visible rather than hiding in the hover controls. */}
          <span className="kb-src-share">
            {owned ? (
              <button
                type="button"
                className="kb-vis"
                data-on={shared ? "1" : undefined}
                title={
                  shared
                    ? "Everyone in this workspace can read it. Click to make it yours alone."
                    : "Only you can read it. Click to open it to this workspace."
                }
                aria-pressed={shared}
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  onFlipVisibility();
                }}
              >
                {shared ? "Workspace" : "Private"}
              </button>
            ) : (
              <span className="kb-vis" data-on="1">
                {owner.exists ? `Shared by ${owner.title}` : "Shared"}
              </span>
            )}
          </span>
        </span>
        {owned && (
          <span className="kb-src-acts">
            {collection.path && (
              <button
                type="button"
                className="kb-mini"
                title={
                  originHere
                    ? "Re-read that folder and bring in what changed"
                    : "That folder is not on this device — nothing to re-read"
                }
                aria-label={`Re-import ${collection.name}`}
                disabled={busy || !originHere}
                onClick={(e) => {
                  e.preventDefault();
                  onReimport();
                }}
              >
                <IconRefresh size={12} />
              </button>
            )}
            <button
              type="button"
              className="kb-mini kb-mini-danger"
              title="Delete this collection from the workspace"
              aria-label={`Delete ${collection.name}`}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                onForget();
              }}
            >
              <IconX size={12} />
            </button>
          </span>
        )}
      </label>
      {importing && <Progress state={importing} />}
    </div>
  );
}

function Progress({ state }: { state: ImportingState }) {
  return (
    <div className="kb-prog" role="status" aria-live="polite">
      <div className="kb-prog-line">
        <span>
          {state.total ? `${count(state.done)} / ${count(state.total)}` : "Walking the folder…"}
        </span>
        <span className="kb-prog-file" title={state.path}>
          {state.path}
        </span>
      </div>
      <div
        className="kb-prog-track"
        role="progressbar"
        aria-valuenow={state.total ? state.done : undefined}
        aria-valuemin={0}
        aria-valuemax={state.total || undefined}
      >
        <div
          className="kb-prog-fill"
          data-indeterminate={state.total ? undefined : "1"}
          style={state.total ? { width: `${Math.round((state.done / state.total) * 100)}%` } : undefined}
        />
      </div>
    </div>
  );
}

/**
 * How far imported content actually reaches, said plainly.
 *
 * A collection is workspace data and the UI calls it that, so this has to name
 * the limit in the same breath: the rows are in this device's database, and the
 * paired web workspace — which is what would carry them to anyone else's
 * machine — does not carry these tables yet. Writing "shared with your
 * workspace" and leaving it there would be a promise the build does not keep.
 */
function ReachNote() {
  return (
    <p className="kb-reach">
      <strong>Where this lives.</strong> Imported notes are copied into Spaces's database
      on this device — that is what makes them readable without the original folder,
      and what everyone using this workspace here can search. Reaching other members'
      machines rides on the paired web workspace, which does not carry these rows yet.
      Nothing is written back to the folders you import from.
    </p>
  );
}

/* ── ask an agent across it ───────────────────────────────────── */

/** The text one hit contributes to a prompt, already cut to the per-note cap. */
async function contextTextFor(
  hit: Hit,
  docs: DocumentRecord[],
  memory: MemoryEntry[]
): Promise<string> {
  try {
    if (hit.kind === "collection") {
      return (await readKbFile(hit.sourceId, hit.path)).text.slice(0, PER_NOTE_CHARS);
    }
    if (hit.kind === "document") {
      return (docs.find((d) => d.id === hit.id)?.body ?? "").slice(0, PER_NOTE_CHARS);
    }
    return (memory.find((m) => m.id === hit.id)?.content ?? "").slice(0, PER_NOTE_CHARS);
  } catch (e) {
    console.error("could not read note for context", hit.path, e);
    return "";
  }
}

function contextNote(hit: Hit, text: string): ContextNote {
  return {
    key: hit.key,
    title: hit.title,
    sourceLabel: hit.sourceLabel,
    path: hit.path,
    text,
  };
}

/**
 * The whole point of the panel is that it is not a black box. It loads the
 * notes it intends to send, shows each one with its size, totals them, draws
 * the total against a budget, and puts the literal prompt behind a disclosure.
 * Dropping a note is one click, and the numbers move when you do.
 */
function AskPanel({
  hits,
  question,
  docs,
  memory,
  reading,
  onClose,
}: {
  hits: Hit[];
  question: string;
  docs: DocumentRecord[];
  memory: MemoryEntry[];
  /** The note open in the reader right now, if any. Changes while this is up. */
  reading: Hit | null;
  onClose: () => void;
}) {
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const projects = useStore((s) => s.projects);
  const [notes, setNotes] = useState<ContextNote[] | null>(null);
  const [ask, setAsk] = useState(question.trim());
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);

  // Frozen at open, and more firmly now than when this was a dialog: the search
  // behind a panel keeps running, and a list that re-seeded itself would swap
  // notes out from under someone who has already dropped two of them. Nothing
  // joins this list without a click.
  const seed = useRef(hits).current;

  useEffect(() => {
    let live = true;
    void (async () => {
      const top = seed.slice(0, DEFAULT_CONTEXT_NOTES);
      const loaded = await Promise.all(
        top.map(async (hit) => contextNote(hit, await contextTextFor(hit, docs, memory)))
      );
      if (live) setNotes(loaded.filter((n) => n.text.trim().length > 0));
    })();
    return () => {
      live = false;
    };
  }, [seed, docs, memory]);

  /** The reader's note, attached on request — the panel's whole reason to exist. */
  async function includeReading() {
    if (!reading || adding) return;
    setAdding(true);
    const text = await contextTextFor(reading, docs, memory);
    setAdding(false);
    if (!text.trim()) {
      toast.warn("Nothing to attach", `There is no text in “${reading.title}” to send.`);
      return;
    }
    setNotes((current) => {
      const list = current ?? [];
      // The reader can move again while the read is in flight.
      return list.some((n) => n.key === reading.key) ? list : [...list, contextNote(reading, text)];
    });
  }

  const agent: Agent | undefined = agents.find((a) => a.id === agentId);
  const contextChars = (notes ?? []).reduce((sum, n) => sum + n.text.length, 0);
  const level = contextChars > CONTEXT_BUDGET ? "over" : contextChars > CONTEXT_BUDGET * 0.75 ? "high" : "ok";

  const prompt = useMemo(() => {
    if (!agent) return "";
    const body = ask.trim() || "What do these notes say?";
    const lines = [`@${slug(agent.name)} ${body}`];
    const list = notes ?? [];
    if (list.length) {
      lines.push("", "---", "");
      lines.push(
        `**Context from the knowledge base** — ${list.length} ${list.length === 1 ? "note" : "notes"}, ${count(contextChars)} characters. These are excerpts of notes imported into this workspace; nothing here is yours to edit.`
      );
      list.forEach((n, i) => {
        lines.push("", `### ${i + 1}. ${n.title}`, `_${n.sourceLabel} · ${n.path}_`, "", n.text);
      });
    }
    return lines.join("\n");
  }, [agent, ask, notes, contextChars]);

  async function send() {
    if (!agent || !channelId || sending) return;
    setSending(true);
    const store = useStore.getState();
    try {
      // Explicit membership so the mention resolves to this agent
      // (INSERT OR IGNORE on the store side — idempotent).
      await store.addChannelMember(channelId, "agent", agent.id);
      const message = await store.insertMessage({
        id: uid(),
        channel_id: channelId,
        author_type: "user",
        author_id: "user",
        author_name: store.self().name || "You",
        content: prompt,
        status: "done",
        meta: (notes ?? []).length
          ? `Knowledge base · ${(notes ?? []).length} notes · ${count(contextChars)} chars`
          : "Knowledge base",
      });
      store.setView({ type: "channel", channelId });
      void triggerAgents(channelId, userTrigger(message));
      onClose();
    } catch (e) {
      toast.error("Could not send that to the channel", e);
      setSending(false);
    }
  }

  const channelLabel = (id: string) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) return id;
    const project = projects.find((p) => p.id === channel.project_id);
    return `${project ? `${project.name} · ` : ""}#${channel.name}`;
  };

  const included = Boolean(reading && (notes ?? []).some((n) => n.key === reading.key));

  return (
    <SidePanel
      title="Ask an agent"
      subtitle="The question goes into the channel under your name, with the notes below pasted underneath it."
      onClose={onClose}
      width={460}
      storageKey="knowledge-ask"
      /* The only commitment on this surface, and the only one that leaves the
         machine. The way out is the panel's own close, not a second button
         pretending the panel is a dialog. */
      footer={
        <button
          className="btn primary"
          disabled={!agent || !channelId || sending || notes === null}
          onClick={() => void send()}
        >
          {sending ? <Spinner /> : <IconSend size={12} />} Post and run
        </button>
      }
    >
      <Field label="Question">
        <textarea
          rows={3}
          value={ask}
          data-autofocus
          placeholder="What do these notes say about…"
          onChange={(e) => setAsk(e.target.value)}
        />
      </Field>

      <Field label="Agent">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.kind})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Channel">
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {channelLabel(c.id)}
            </option>
          ))}
        </select>
      </Field>

      <PanelSection
        title={
          <>
            Notes included
            <span className="kb-h3-count">{notes ? count(notes.length) : "…"}</span>
          </>
        }
      >
        <p className="kb-ask-hint">
          The search behind this panel is still live. Read a note before you decide,
          drop anything you would rather not send, and add the one you are looking at.
        </p>

        {notes === null ? (
          <p className="kb-none">
            <Spinner /> Reading the top matches…
          </p>
        ) : notes.length === 0 ? (
          <p className="kb-ask-warn">
            No note text attached — this will arrive as a plain question with no
            context behind it.
          </p>
        ) : (
          <ul className="kb-ask-notes">
            {notes.map((n) => (
              <li key={n.key} className="kb-ask-note">
                <span className="kb-ask-note-text">
                  <span className="kb-ask-note-title">{n.title}</span>
                  <span className="kb-ask-note-meta">
                    {n.sourceLabel} · {n.path}
                  </span>
                </span>
                <span className="kb-ask-note-chars">{count(n.text.length)}</span>
                <button
                  type="button"
                  className="kb-mini kb-mini-danger"
                  aria-label={`Drop ${n.title} from the context`}
                  title="Drop this note"
                  onClick={() =>
                    setNotes((current) => (current ?? []).filter((x) => x.key !== n.key))
                  }
                >
                  <IconX size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {reading && !included && (
          <button
            type="button"
            className="btn tiny kb-ask-add"
            disabled={adding || notes === null}
            onClick={() => void includeReading()}
          >
            {adding ? <Spinner /> : <IconPlus size={12} />} Add “{reading.title}”
          </button>
        )}

        <div className="kb-ask-meter" data-level={level === "ok" ? undefined : level}>
          <p className="kb-ask-meter-line">
            <b>{count(contextChars)}</b> characters of context in a{" "}
            <b>{count(prompt.length)}</b>-character prompt.
          </p>
          <div className="kb-ask-track">
            <div
              className="kb-ask-fill"
              style={{
                width: `${Math.min(100, Math.round((contextChars / CONTEXT_BUDGET) * 100))}%`,
              }}
            />
          </div>
          <p className="kb-ask-meter-note">
            {level === "over"
              ? `Past the ${count(CONTEXT_BUDGET)}-character mark this crowds out the agent's own instructions. Drop a note or two.`
              : level === "high"
                ? `Approaching ${count(CONTEXT_BUDGET)} characters — still fine, but the agent has less room to think.`
                : `Each note is cut off after ${count(PER_NOTE_CHARS)} characters; nothing else is added.`}
          </p>
        </div>
      </PanelSection>

      <details className="kb-ask-preview">
        <summary>See the exact prompt that will be posted</summary>
        <pre>{prompt}</pre>
      </details>
    </SidePanel>
  );
}
