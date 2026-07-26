/**
 * RunDiff — the review surface for one agent turn.
 *
 * This is where a human decides whether an AI's edits stay, so everything here
 * optimises for *seeing what actually changed*: word-level intra-line marks so a
 * one-character fix doesn't read as a rewritten line, per-line syntax colours,
 * and reverts scoped to a hunk, a file, or the whole run — each behind a
 * confirmation that spells out what is about to be undone.
 *
 * Two rules run through the file:
 *  - Never render megabytes into the DOM. Everything is capped, and every cap
 *    announces itself instead of silently truncating.
 *  - Never write a file we didn't verify first. Reverse-applying a hunk checks
 *    the bytes on disk against the diff's after-image and refuses on any drift,
 *    because a revert that lands in the wrong place is worse than no revert.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { errText, revertRun, runDiff } from "../gitflow";
import { git } from "../workspaces";
import { highlight, supportsLanguage } from "../syntax";
import { confirmAction, toast } from "../toast";
import { Avatar, Modal, Spinner } from "./ui";
import { IconCheck } from "./icons";
import "./chat.css";
import "./rundiff.css";

/* ── caps ─────────────────────────────────────────────────────── */

/** Rendered diff lines across the whole modal. A 30k-line refactor must not
 *  build 30k rows just because someone clicked "view diff". */
const MAX_TOTAL_LINES = 4000;
/** …and no single file may eat the whole budget. */
const MAX_FILE_LINES = 900;
/** A minified bundle is one very long line: render a prefix of it. The model
 *  keeps the full text, so reverting stays byte-exact. */
const MAX_LINE_CHARS = 800;
/** Past this, colouring a line costs more than it helps. */
const MAX_SYNTAX_CHARS = 400;
/** Word diff is O(n·m) in tokens; past this the line is marked as a whole. */
const MAX_WORD_CELLS = 6000;
/** A run of unchanged lines longer than this collapses into an expandable gap. */
const COLLAPSE_MIN = 10;
/** …keeping this many lines either side of the gap. */
const COLLAPSE_KEEP = 3;
/** How far either side of the expected position we hunt for a hunk's
 *  after-image before giving up. Enough for a few edits above it, small enough
 *  that we can't land in an unrelated part of a big file. */
const SEARCH_WINDOW = 200;

const VIEW_KEY = "spaces.rundiff.view";
const WS_KEY = "spaces.rundiff.hide-ws";

/* ── preferences ──────────────────────────────────────────────── */

// Storage can be disabled or full; a broken preference must never take the
// review surface down with it.
function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* nothing to do — the session keeps the choice, the next one won't */
  }
}

/* ── language ─────────────────────────────────────────────────── */

/** Extension of `path`, lowercased — syntax.ts already aliases ts/tsx/py/… */
function langOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return supportsLanguage(ext) ? ext : "";
}

/* ── syntax tokens ────────────────────────────────────────────── */

interface Tok {
  text: string;
  cls: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
};

function unesc(s: string): string {
  return s.indexOf("&") < 0 ? s : s.replace(/&(?:amp|lt|gt|quot);/g, (e) => ENTITIES[e]);
}

const TOK_OPEN = '<span class="tk-';
const TOK_CLOSE = "</span>";

/**
 * Turn `highlight()`'s HTML back into positioned tokens.
 *
 * Going through HTML looks roundabout, but it buys the intra-line word marks:
 * once tokens carry offsets they can be split at word-diff boundaries, which
 * an opaque HTML string can't be. `highlight` emits one flat shape — literal
 * class names, four entities, no attributes from input — so this parse is
 * total, and the reconstruction check below makes it verifiable: on any
 * surprise we fall back to one uncoloured token rather than mangle the line.
 */
function parseHighlighted(html: string, source: string): Tok[] {
  const plain: Tok[] = [{ text: source, cls: "" }];
  const toks: Tok[] = [];
  let i = 0;
  while (i < html.length) {
    if (html.startsWith(TOK_OPEN, i)) {
      const attr = html.indexOf('">', i + TOK_OPEN.length);
      if (attr < 0) return plain;
      const cls = html.slice(i + TOK_OPEN.length, attr);
      if (!/^[a-z]+$/.test(cls)) return plain;
      const end = html.indexOf(TOK_CLOSE, attr + 2);
      if (end < 0) return plain;
      const body = html.slice(attr + 2, end);
      // A nested span would break this flat pairing; bail rather than guess.
      if (body.includes("<")) return plain;
      toks.push({ text: unesc(body), cls: `tk-${cls}` });
      i = end + TOK_CLOSE.length;
    } else {
      const next = html.indexOf("<", i);
      const end = next < 0 ? html.length : next;
      if (end === i) return plain;
      toks.push({ text: unesc(html.slice(i, end)), cls: "" });
      i = end;
    }
  }
  // The one invariant that matters: colouring must not change the text.
  if (toks.reduce((n, t) => n + t.text.length, 0) !== source.length) return plain;
  if (toks.map((t) => t.text).join("") !== source) return plain;
  return toks;
}

// Diffs repeat themselves — the same import line shows up as context in six
// hunks. Cache by language+text; clear wholesale rather than track an LRU.
const tokenCache = new Map<string, Tok[]>();

function tokensOf(text: string, lang: string): Tok[] {
  if (!lang || !text || text.length > MAX_SYNTAX_CHARS) return [{ text, cls: "" }];
  const key = `${lang}\n${text}`;
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const toks = parseHighlighted(highlight(text, lang), text);
  if (tokenCache.size > 4000) tokenCache.clear();
  tokenCache.set(key, toks);
  return toks;
}

/* ── word-level diff ──────────────────────────────────────────── */

interface Seg {
  text: string;
  changed: boolean;
}

const WORD_RE = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;

function wordsOf(s: string): string[] {
  return s.match(WORD_RE) ?? [];
}

/** Which tokens of each side survive in the longest common subsequence. */
function lcsKeep(a: string[], b: string[]): [boolean[], boolean[]] {
  const n = a.length;
  const m = b.length;
  const ka = new Array<boolean>(n).fill(false);
  const kb = new Array<boolean>(m).fill(false);
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ka[i] = true;
      kb[j] = true;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return [ka, kb];
}

function segsFrom(toks: string[], keep: boolean[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < toks.length; i++) {
    const changed = !keep[i];
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += toks[i];
    else segs.push({ text: toks[i], changed });
  }
  return segs;
}

function changedChars(segs: Seg[]): number {
  return segs.reduce((n, s) => (s.changed ? n + s.text.length : n), 0);
}

/**
 * Intra-line segments for a replaced line pair, or null when the two lines
 * share too little for the marks to mean anything — at that point the row's
 * own colour already says "this line was rewritten", and highlighting 90% of
 * it just adds noise.
 */
function diffWords(before: string, after: string): [Seg[], Seg[]] | null {
  if (!before || !after) return null;
  const a = wordsOf(before);
  const b = wordsOf(after);
  if (!a.length || !b.length) return null;

  // Trim the shared head and tail first: it is the common case (one identifier
  // changed mid-line) and it keeps the O(n·m) core small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const keepA = new Array<boolean>(a.length).fill(true);
  const keepB = new Array<boolean>(b.length).fill(true);
  if (midA.length && midB.length && midA.length * midB.length <= MAX_WORD_CELLS) {
    const [ka, kb] = lcsKeep(midA, midB);
    for (let i = 0; i < ka.length; i++) keepA[head + i] = ka[i];
    for (let j = 0; j < kb.length; j++) keepB[head + j] = kb[j];
  } else {
    for (let i = 0; i < midA.length; i++) keepA[head + i] = false;
    for (let j = 0; j < midB.length; j++) keepB[head + j] = false;
  }

  const left = segsFrom(a, keepA);
  const right = segsFrom(b, keepB);
  const ratio = Math.max(
    changedChars(left) / Math.max(1, before.length),
    changedChars(right) / Math.max(1, after.length)
  );
  if (ratio > 0.7) return null;
  return [left, right];
}

/* ── diff model ───────────────────────────────────────────────── */

type LineKind = "ctx" | "add" | "del";
type FileStatus = "added" | "deleted" | "renamed" | "modified";

interface HunkLine {
  kind: LineKind;
  /** Content without the leading +/-/space marker. Never truncated. */
  text: string;
  /** 0 when the line doesn't exist on that side. */
  oldNo: number;
  newNo: number;
  /** Counterpart in the same del/add run — drives side-by-side pairing. */
  pair?: HunkLine;
  /** Intra-line segments; absent when unpaired or wholly rewritten. */
  segs?: Seg[];
  /** Change that only moves whitespace around, or a blank line. */
  ws?: boolean;
}

interface Hunk {
  id: string;
  header: string;
  /** The text git puts after the second @@ — usually the enclosing function. */
  section: string;
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
  add: number;
  del: number;
  /** Unchanged lines between the previous hunk and this one. */
  gap: number;
  /** Lines were dropped by the cap, so this is no longer a faithful patch. */
  partial: boolean;
  newNoEol: boolean;
  oldNoEol: boolean;
}

interface DiffFile {
  id: string;
  /** Display path: the after-side, falling back to the before-side. */
  path: string;
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  add: number;
  del: number;
  /** Mode changes, rename similarity — anything git said outside the hunks. */
  notes: string[];
  /** Lines the cap refused to render. */
  dropped: number;
  rendered: number;
  lang: string;
}

interface ParsedDiff {
  files: DiffFile[];
  /** Text git (or diffOf) emitted outside any file block. */
  stray: string[];
  add: number;
  del: number;
  capped: boolean;
}

const META_PREFIXES = [
  "index ",
  "old mode ",
  "new mode ",
  "similarity index ",
  "dissimilarity index ",
  "copy from ",
  "copy to ",
];

function unquote(p: string): string {
  const t = p.trim();
  const bare = t.startsWith('"') && t.endsWith('"') && t.length > 1 ? t.slice(1, -1) : t;
  return bare.replace(/^[ab]\//, "");
}

/** Path out of a "--- a/x" / "+++ b/x" line; "" for /dev/null. */
function diffPath(raw: string): string {
  const p = raw.split("\t")[0];
  const clean = unquote(p);
  return clean === "/dev/null" || clean === "dev/null" ? "" : clean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Pair up del/add runs so the split view can align them and the word diff
 *  knows which "before" line each "after" line replaced. */
function pairRuns(lines: HunkLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      // A lone added blank line is still "whitespace only" to a reviewer.
      if (lines[i].kind === "add" && lines[i].text.trim() === "") lines[i].ws = true;
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === "del") d++;
    let a = d;
    while (a < lines.length && lines[a].kind === "add") a++;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    const paired = Math.min(dels.length, adds.length);
    for (let k = 0; k < paired; k++) {
      const L = dels[k];
      const R = adds[k];
      L.pair = R;
      R.pair = L;
      if (L.text.replace(/\s+/g, "") === R.text.replace(/\s+/g, "")) {
        L.ws = true;
        R.ws = true;
      }
      const segs = diffWords(L.text, R.text);
      if (segs) {
        L.segs = segs[0];
        R.segs = segs[1];
      }
    }
    for (const line of [...dels.slice(paired), ...adds.slice(paired)]) {
      if (line.text.trim() === "") line.ws = true;
    }
    i = Math.max(a, d);
  }
}

/**
 * One pass over git's output.
 *
 * Counts (+/-) are taken over the *whole* diff, before the render cap, so the
 * numbers stay honest past the point where rows stop being produced. The input
 * can also be three diffs concatenated (staged + unstaged + untracked, see
 * workspaces.diffOf), so the same path may legitimately appear twice and stray
 * prose can sit between file blocks — both are tolerated rather than dropped.
 */
function parseDiff(text: string): ParsedDiff {
  const all = text === "" ? [] : text.split("\n");
  const files: DiffFile[] = [];
  const stray: string[] = [];
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let prevEnd = 0;
  /** Lines the open hunk still owes each side, from its own @@ header. */
  let oldLeft = 0;
  let newLeft = 0;
  let budget = MAX_TOTAL_LINES;
  let capped = false;
  let skipBlob = false;

  const closeHunk = () => {
    if (hunk) pairRuns(hunk.lines);
    hunk = null;
  };

  const closeFile = () => {
    closeHunk();
    if (!file) return;
    if (file.status === "modified") {
      if (!file.oldPath && file.path) file.status = "added";
      else if (file.oldPath && !file.path) file.status = "deleted";
      else if (file.oldPath && file.path && file.oldPath !== file.path) file.status = "renamed";
    }
    if (!file.path) file.path = file.oldPath;
    file.lang = langOf(file.path);
  };

  const startFile = (header: string): DiffFile => {
    closeFile();
    // "a/x b/y" is ambiguous when a path contains spaces; ---/+++ overwrite
    // this below whenever git emits them, which is every case but a pure mode
    // change or a binary file.
    const rest = header.slice("diff --git ".length);
    const split = rest.lastIndexOf(" b/");
    const next: DiffFile = {
      id: `f${files.length}`,
      path: split > 0 ? unquote(rest.slice(split + 1)) : "",
      oldPath: split > 0 ? unquote(rest.slice(0, split)) : "",
      status: "modified",
      binary: false,
      hunks: [],
      add: 0,
      del: 0,
      notes: [],
      dropped: 0,
      rendered: 0,
      lang: "",
    };
    files.push(next);
    return next;
  };

  const push = (line: HunkLine) => {
    if (!file || !hunk) return;
    if (budget <= 0 || file.rendered >= MAX_FILE_LINES) {
      hunk.partial = true;
      file.dropped++;
      capped = true;
      return;
    }
    hunk.lines.push(line);
    file.rendered++;
    budget--;
  };

  for (const raw of all) {
    if (raw.startsWith("diff --git ")) {
      file = startFile(raw);
      skipBlob = false;
      prevEnd = 0;
      continue;
    }
    if (skipBlob) continue;

    if (hunk && raw.startsWith("\\")) {
      // "\ No newline at end of file" applies to the line just above it.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) {
        if (last.kind !== "add") hunk.oldNoEol = true;
        if (last.kind !== "del") hunk.newNoEol = true;
      }
      continue;
    }
    // A hunk consumes exactly the number of lines its header promised. Trusting
    // the prefix instead would swallow whatever follows — the blank line that
    // joins two diffs together in workspaces.diffOf, or the trailing newline of
    // git's own output — as a phantom empty context line, which would then be
    // "reverted" into the file.
    if (hunk && (oldLeft > 0 || newLeft > 0) && (raw === "" || " +-".includes(raw[0]))) {
      const body = raw === "" ? "" : raw.slice(1);
      if (raw.startsWith("+") && newLeft > 0) {
        newLeft--;
        newNo++;
        file!.add++;
        hunk.add++;
        push({ kind: "add", text: body, oldNo: 0, newNo });
        prevEnd = newNo;
        continue;
      }
      if (raw.startsWith("-") && oldLeft > 0) {
        oldLeft--;
        oldNo++;
        file!.del++;
        hunk.del++;
        push({ kind: "del", text: body, oldNo, newNo: 0 });
        continue;
      }
      if (!raw.startsWith("+") && !raw.startsWith("-") && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        oldNo++;
        newNo++;
        push({ kind: "ctx", text: body, oldNo, newNo });
        prevEnd = newNo;
        continue;
      }
    }
    closeHunk();

    const m = HUNK_RE.exec(raw);
    if (m) {
      if (!file) file = startFile("diff --git a/ b/");
      oldNo = parseInt(m[1], 10) - 1;
      newNo = parseInt(m[3], 10) - 1;
      // "@@ -1 +1 @@" means one line on each side.
      oldLeft = m[2] === undefined ? 1 : parseInt(m[2], 10);
      newLeft = m[4] === undefined ? 1 : parseInt(m[4], 10);
      hunk = {
        id: `${file.id}h${file.hunks.length}`,
        header: raw,
        section: m[5].trim(),
        oldStart: parseInt(m[1], 10),
        newStart: parseInt(m[3], 10),
        lines: [],
        add: 0,
        del: 0,
        gap: Math.max(0, parseInt(m[3], 10) - prevEnd - 1),
        partial: false,
        newNoEol: false,
        oldNoEol: false,
      };
      file.hunks.push(hunk);
      continue;
    }

    if (raw.startsWith("--- ")) {
      if (file) file.oldPath = diffPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (file) file.path = diffPath(raw.slice(4));
      continue;
    }
    if (file && raw.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (file && raw.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (file && (raw.startsWith("rename from ") || raw.startsWith("rename to "))) {
      file.status = "renamed";
      if (raw.startsWith("rename from ")) file.oldPath = unquote(raw.slice(12));
      else file.path = unquote(raw.slice(10));
      continue;
    }
    if (file && (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch"))) {
      file.binary = true;
      // The base85 payload after the marker is not for human eyes.
      skipBlob = raw.startsWith("GIT binary patch");
      continue;
    }
    if (file && META_PREFIXES.some((p) => raw.startsWith(p))) {
      if (!raw.startsWith("index ")) file.notes.push(raw.trim());
      continue;
    }
    if (raw.trim()) stray.push(raw.trim());
  }
  closeFile();

  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return { files, stray, add, del, capped };
}

/* ── rows ─────────────────────────────────────────────────────── */

interface SplitRow {
  left: HunkLine | null;
  right: HunkLine | null;
}

/** Zip a hunk's lines into left/right pairs for the side-by-side view. */
function splitRows(lines: HunkLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "ctx") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === "del") d++;
    let a = d;
    while (a < lines.length && lines[a].kind === "add") a++;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    i = Math.max(a, d);
  }
  return rows;
}

type Chunk<T> = { kind: "rows"; rows: T[] } | { kind: "gap"; id: string; rows: T[] };

/** Fold long unchanged stretches into a gap the reader can open. */
function collapseContext<T>(rows: T[], isCtx: (row: T) => boolean, id: string): Chunk<T>[] {
  const out: Chunk<T>[] = [];
  let buf: T[] = [];
  let i = 0;
  const flush = () => {
    if (buf.length) out.push({ kind: "rows", rows: buf });
    buf = [];
  };
  while (i < rows.length) {
    if (!isCtx(rows[i])) {
      buf.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && isCtx(rows[j])) j++;
    const run = rows.slice(i, j);
    if (run.length <= COLLAPSE_MIN) {
      buf.push(...run);
    } else {
      buf.push(...run.slice(0, COLLAPSE_KEEP));
      flush();
      out.push({ kind: "gap", id: `${id}:${i}`, rows: run.slice(COLLAPSE_KEEP, -COLLAPSE_KEEP) });
      buf.push(...run.slice(-COLLAPSE_KEEP));
    }
    i = j;
  }
  flush();
  return out;
}

/* ── paths ────────────────────────────────────────────────────── */

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : "";
}

/* ── revert plumbing ──────────────────────────────────────────── */

/** Absolute path for a git pathspec — the run's cwd may be a subdirectory. */
function absPath(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path}`;
}

async function existsAt(cwd: string, rev: string, path: string): Promise<boolean> {
  if (!rev || !path) return false;
  return git(cwd, "cat-file", "-e", `${rev}:${path}`).then(
    () => true,
    () => false
  );
}

async function removePath(cwd: string, root: string, path: string): Promise<void> {
  const abs = absPath(root, path);
  const tracked = await git(cwd, "ls-files", "--error-unmatch", "--", abs).then(
    () => true,
    () => false
  );
  // Both take an exact pathspec, so neither can wander past the one file.
  if (tracked) await git(cwd, "rm", "-f", "--", abs);
  else await git(cwd, "clean", "-f", "--", abs);
}

function sameLines(lines: string[], target: string[], at: number): boolean {
  for (let i = 0; i < target.length; i++) if (lines[at + i] !== target[i]) return false;
  return true;
}

/** Where a hunk's after-image sits in the file right now, or -1 if it doesn't. */
function locate(lines: string[], target: string[], want: number): number {
  if (target.length === 0) return want >= 0 && want <= lines.length ? want : -1;
  const max = lines.length - target.length;
  if (max < 0) return -1;
  const start = Math.min(Math.max(want, 0), max);
  if (sameLines(lines, target, start)) return start;
  for (let d = 1; d <= SEARCH_WINDOW; d++) {
    const before = start - d;
    const after = start + d;
    if (before >= 0 && sameLines(lines, target, before)) return before;
    if (after <= max && sameLines(lines, target, after)) return after;
  }
  return -1;
}

/**
 * Undo `hunks` in the file on disk.
 *
 * Deliberately not `git apply -R`: the git bridge passes argv only, so a patch
 * would have to be spilled to a temp file inside the user's repo. Reverse-
 * applying in memory also lets us verify first — every hunk's after-image must
 * still be present verbatim, or nothing is written at all.
 */
async function reverseApply(
  root: string,
  path: string,
  hunks: Hunk[],
  allowMissing: boolean
): Promise<void> {
  let content = "";
  try {
    content = await invoke<string>("read_text_file", { root, relativePath: path });
  } catch (e) {
    if (!allowMissing) throw new Error(errText(e));
  }

  const lines = content === "" ? [] : content.split("\n");
  let eol = true;
  if (content !== "") {
    if (content.endsWith("\n")) lines.pop();
    else eol = false;
  }

  // Bottom-up, so an earlier hunk's splice can't shift a later hunk's position.
  const ordered = [...hunks].sort((a, b) => b.newStart - a.newStart);
  for (const hunk of ordered) {
    if (hunk.partial) throw new Error("This hunk was only partly loaded, so Spaces won't rewrite it.");
    const after = hunk.lines.filter((l) => l.kind !== "del").map((l) => l.text);
    const before = hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text);
    const want = after.length === 0 ? hunk.newStart : hunk.newStart - 1;
    const at = locate(lines, after, want);
    if (at < 0) {
      throw new Error(
        `${path} no longer contains this hunk exactly as the run left it — it has been edited since. ` +
          "Undo it in your editor instead."
      );
    }
    const atEof = at + after.length === lines.length;
    lines.splice(at, after.length, ...before);
    if (atEof) eol = !hunk.oldNoEol;
  }

  const next = lines.length === 0 ? "" : lines.join("\n") + (eol ? "\n" : "");
  await invoke("write_text_file", { root, relativePath: path, contents: next });
}

/** How many lines of an unchanged stretch we'll pull in at once. */
const MAX_GAP_LINES = 200;

interface GapState {
  loading?: boolean;
  lines?: HunkLine[];
  error?: string;
}

/**
 * The unchanged lines above `hunk`, read from the file as it is now.
 *
 * git's diff doesn't carry them — the alternative would be re-running it with a
 * bigger -U, which the composite working-tree diff can't express. Reading the
 * file is only sound if the file still matches what the diff describes, so the
 * hunk's own first line is used as an anchor: if it isn't exactly where the
 * diff says it is, we show nothing rather than lines from the wrong file.
 */
async function readGap(root: string, file: DiffFile, hunk: Hunk): Promise<HunkLine[]> {
  const anchor = hunk.lines.find((l) => l.kind !== "del");
  if (!anchor) throw new Error("No anchor line to check this file against.");
  const text = await invoke<string>("read_text_file", { root, relativePath: file.path });
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines[anchor.newNo - 1] !== anchor.text) {
    throw new Error(`${file.path} has changed since this run — can't show the lines around it.`);
  }
  const end = hunk.newStart - 1; // 1-based line just above the hunk
  const start = Math.max(hunk.newStart - hunk.gap, end - MAX_GAP_LINES + 1);
  const out: HunkLine[] = [];
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1];
    if (text === undefined) break;
    // Unchanged lines sit at the same offset from each side's hunk start.
    out.push({ kind: "ctx", text, newNo: n, oldNo: hunk.oldStart - (hunk.newStart - n) });
  }
  return out;
}

/** Whether the working tree has changes of its own in `path`. */
async function isDirty(cwd: string, root: string, path: string): Promise<boolean> {
  return git(cwd, "status", "--porcelain", "--", absPath(root, path)).then(
    (out) => out.trim() !== "",
    () => false
  );
}

type RevertPlan =
  | { kind: "restore"; path: string; from: string; alsoRemove: string; dirty: boolean }
  | { kind: "remove"; path: string }
  | { kind: "patch"; path: string; hunks: Hunk[]; create: boolean }
  | { kind: "none"; why: string };

/**
 * How this file would be put back, decided before anything is confirmed so the
 * dialog can describe the operation that will actually run.
 *
 * Git does the work whenever a baseline commit exists — it is exact for
 * binaries, renames and files too big to have been parsed. Only a run with no
 * baseline at all falls back to reverse-applying the patch we rendered.
 */
async function planFileRevert(
  cwd: string,
  root: string,
  before: string,
  after: string,
  file: DiffFile
): Promise<RevertPlan> {
  const source = file.oldPath || file.path;
  if (before && (await existsAt(cwd, before, source))) {
    return {
      kind: "restore",
      path: source,
      from: before,
      alsoRemove: file.status === "renamed" && file.path && file.path !== source ? file.path : "",
      // Only meaningful once the run has committed: before that, the run's own
      // work is what makes the file dirty.
      dirty: after ? await isDirty(cwd, root, source) : false,
    };
  }
  if (before) return { kind: "remove", path: file.path || source };
  if (file.binary) {
    return { kind: "none", why: "This run has no baseline commit, and Spaces can't rebuild a binary file from a diff." };
  }
  if (!file.hunks.length || file.dropped > 0) {
    return {
      kind: "none",
      why: "This run has no baseline commit, and this file's diff is too large to reverse safely.",
    };
  }
  return {
    kind: "patch",
    path: file.path || source,
    hunks: file.hunks,
    create: file.status === "deleted",
  };
}

async function applyPlan(cwd: string, root: string, plan: RevertPlan): Promise<void> {
  if (plan.kind === "restore") {
    await git(cwd, "checkout", plan.from, "--", absPath(root, plan.path));
    if (plan.alsoRemove) await removePath(cwd, root, plan.alsoRemove);
  } else if (plan.kind === "remove") {
    await removePath(cwd, root, plan.path);
  } else if (plan.kind === "patch") {
    await reverseApply(root, plan.path, plan.hunks, plan.create);
  }
}

/* ── clipboard ────────────────────────────────────────────────── */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Webviews can refuse the async clipboard on a heuristic we don't control;
    // the selection trick still goes through.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const run = async () => {
    if (!(await copyText(value))) {
      toast.warn("Could not reach the clipboard", "Select the text and copy it by hand.");
      return;
    }
    setDone(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1500);
  };

  return (
    <button
      type="button"
      className="rd-copy"
      onClick={() => void run()}
      aria-label={done ? `Copied ${label}` : `Copy ${label}`}
      title={`Copy ${label}`}
    >
      {done ? <IconCheck size={11} /> : <CopyGlyph />}
    </button>
  );
}

/* ── line rendering ───────────────────────────────────────────── */

interface Piece {
  text: string;
  cls: string;
  changed: boolean;
}

/** Overlay the word-diff segmentation on the syntax tokens. */
function mergePieces(toks: Tok[], segs: Seg[]): Piece[] {
  const out: Piece[] = [];
  let si = 0;
  let off = 0;
  const put = (text: string, cls: string, changed: boolean) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.cls === cls && last.changed === changed) last.text += text;
    else out.push({ text, cls, changed });
  };
  for (const tok of toks) {
    let rest = tok.text;
    while (rest && si < segs.length) {
      const avail = segs[si].text.length - off;
      const take = Math.min(avail, rest.length);
      put(rest.slice(0, take), tok.cls, segs[si].changed);
      rest = rest.slice(take);
      off += take;
      if (off >= segs[si].text.length) {
        si++;
        off = 0;
      }
    }
    put(rest, tok.cls, false);
  }
  return out;
}

function LineText({ line, lang }: { line: HunkLine; lang: string }) {
  const long = line.text.length > MAX_LINE_CHARS;
  const text = long ? line.text.slice(0, MAX_LINE_CHARS) : line.text;
  const toks = long ? [{ text, cls: "" }] : tokensOf(text, lang);
  const pieces = line.segs && !long ? mergePieces(toks, line.segs) : null;
  const parts: Piece[] = pieces ?? toks.map((t) => ({ ...t, changed: false }));

  return (
    <>
      {text === "" && !long ? (
        " "
      ) : (
        parts.map((p, i) =>
          p.cls || p.changed ? (
            <span key={i} className={`${p.cls}${p.changed ? " rd-w" : ""}`.trim()}>
              {p.text}
            </span>
          ) : (
            <Fragment key={i}>{p.text}</Fragment>
          )
        )
      )}
      {long && (
        <span className="rd-clip" title={`${line.text.length} characters — shown to ${MAX_LINE_CHARS}`}>
          {" "}
          … +{line.text.length - MAX_LINE_CHARS} chars
        </span>
      )}
    </>
  );
}

const MARK: Record<LineKind, string> = { add: "+", del: "−", ctx: " " };

function Content({ line, lang }: { line: HunkLine | null; lang: string }) {
  if (!line) return <div className="rd-cell rd-blank" aria-hidden="true" />;
  return (
    <div className={`rd-cell ${line.kind}`}>
      <span className="rd-mark" aria-hidden="true">
        {MARK[line.kind]}
      </span>
      {/* the code lives in its own span: the cell is a flex row, and loose
          text nodes there would each become a flex item */}
      <span className="rd-code">
        <LineText line={line} lang={lang} />
      </span>
    </div>
  );
}

function Num({ n, kind, edge }: { n: number; kind: LineKind | "none"; edge?: boolean }) {
  return <div className={`rd-num ${kind}${edge ? " rd-edge" : ""}`}>{n > 0 ? n : ""}</div>;
}

/* ── hunk ─────────────────────────────────────────────────────── */

interface HunkViewProps {
  file: DiffFile;
  hunk: Hunk;
  split: boolean;
  hideWs: boolean;
  active: boolean;
  expanded: Set<string>;
  onExpand: (id: string) => void;
  /** Lines above this hunk, once they've been read off disk. */
  gap: GapState | undefined;
  onExpandGap: (() => void) | undefined;
  onRevert: ((hunk: Hunk) => void) | undefined;
  revertHint: string;
  bind: (el: HTMLDivElement | null) => void;
}

function HunkView({
  file,
  hunk,
  split,
  hideWs,
  active,
  expanded,
  onExpand,
  gap,
  onExpandGap,
  onRevert,
  revertHint,
  bind,
}: HunkViewProps) {
  const lines = hideWs ? hunk.lines.filter((l) => !l.ws) : hunk.lines;
  const hiddenWs = hunk.lines.length - lines.length;
  const changes = lines.filter((l) => l.kind !== "ctx").length;
  const cols = split ? 4 : 3;

  // One shape for both layouts: a unified row is a split row whose two sides
  // are the same line, so the collapse logic and the renderer stay single.
  const rows: SplitRow[] = split
    ? splitRows(lines)
    : lines.map((l) => ({ left: l, right: l }));
  const chunks = collapseContext(rows, (r) => r.left === r.right && r.left?.kind === "ctx", hunk.id);

  const renderRows = (part: SplitRow[], from: string) =>
    part.map((row, i) =>
      split ? (
        <Fragment key={`${from}-${i}`}>
          <Num n={row.left?.oldNo ?? 0} kind={row.left?.kind ?? "none"} />
          <Content line={row.left} lang={file.lang} />
          <Num n={row.right?.newNo ?? 0} kind={row.right?.kind ?? "none"} edge />
          <Content line={row.right} lang={file.lang} />
        </Fragment>
      ) : (
        <Fragment key={`${from}-${i}`}>
          <Num n={row.left?.oldNo ?? 0} kind={row.left?.kind ?? "none"} />
          <Num n={row.left?.newNo ?? 0} kind={row.left?.kind ?? "none"} />
          <Content line={row.left} lang={file.lang} />
        </Fragment>
      )
    );

  return (
    <div
      className={`rd-hunk${split ? " split" : ""}${active ? " is-active" : ""}`}
      ref={bind}
      id={`hunk-${hunk.id}`}
    >
      {hunk.gap > 0 &&
        (gap?.lines ? (
          renderRows(
            gap.lines.map((l) => ({ left: l, right: l })),
            "gap"
          )
        ) : (
          <div className="rd-gapline" style={{ gridColumn: `1 / ${cols + 1}` }}>
            {gap?.error ? (
              <span className="rd-gaperr">{gap.error}</span>
            ) : (
              <button
                type="button"
                className="rd-gapbtn"
                disabled={!onExpandGap || gap?.loading}
                onClick={onExpandGap}
                title={
                  onExpandGap
                    ? "Read these lines from the file on disk."
                    : "Spaces can't reach the file to show the lines around this change."
                }
              >
                {gap?.loading ? "…" : "⋯"} {hunk.gap} unchanged line
                {hunk.gap === 1 ? "" : "s"}
              </button>
            )}
          </div>
        ))}
      <div className="rd-hhead" style={{ gridColumn: `1 / ${cols + 1}` }}>
        <span className="rd-hrange" title={hunk.header}>
          @@ −{hunk.oldStart} +{hunk.newStart}
        </span>
        {hunk.section && <span className="rd-hsection">{hunk.section}</span>}
        <span className="rd-hcounts">
          <span className={"rd-add" + (hunk.add ? "" : " rd-zero")}>+{hunk.add}</span>
          <span className={"rd-del" + (hunk.del ? "" : " rd-zero")}>−{hunk.del}</span>
        </span>
        <span className="rd-action" title={onRevert ? "Undo just this hunk, on disk." : revertHint}>
          <button
            type="button"
            className="rd-mini"
            disabled={!onRevert}
            onClick={onRevert ? () => onRevert(hunk) : undefined}
          >
            Revert hunk
          </button>
        </span>
      </div>

      {changes === 0 && hiddenWs > 0 ? (
        <div className="rd-hnote" style={{ gridColumn: `1 / ${cols + 1}` }}>
          {hiddenWs} whitespace-only line{hiddenWs === 1 ? "" : "s"} hidden.
        </div>
      ) : (
        chunks.map((chunk, ci) =>
          chunk.kind === "rows" || expanded.has(chunk.id) ? (
            <Fragment key={`c${ci}`}>{renderRows(chunk.rows, `c${ci}`)}</Fragment>
          ) : (
            <button
              key={`c${ci}`}
              type="button"
              className="rd-expand"
              style={{ gridColumn: `1 / ${cols + 1}` }}
              onClick={() => onExpand(chunk.id)}
            >
              ⋯ Expand {chunk.rows.length} unchanged line{chunk.rows.length === 1 ? "" : "s"}
            </button>
          )
        )
      )}

      {hunk.partial && (
        <div className="rd-hnote" style={{ gridColumn: `1 / ${cols + 1}` }}>
          Hunk truncated — the rest is in the file itself.
        </div>
      )}
      {changes > 0 && hiddenWs > 0 && (
        <div className="rd-hnote" style={{ gridColumn: `1 / ${cols + 1}` }}>
          {hiddenWs} whitespace-only line{hiddenWs === 1 ? "" : "s"} hidden.
        </div>
      )}
    </div>
  );
}

/* ── file block ───────────────────────────────────────────────── */

const STATUS_LABEL: Record<FileStatus, string> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: "",
};

interface FileBlockProps {
  file: DiffFile;
  split: boolean;
  hideWs: boolean;
  collapsed: boolean;
  onCollapse: (id: string) => void;
  expanded: Set<string>;
  onExpand: (id: string) => void;
  gaps: Record<string, GapState>;
  onExpandGap: ((file: DiffFile, hunk: Hunk) => void) | undefined;
  activeHunk: string;
  onRevertFile: ((file: DiffFile) => void) | undefined;
  onRevertHunk: ((file: DiffFile, hunk: Hunk) => void) | undefined;
  revertHint: string;
  bindFile: (el: HTMLElement | null) => void;
  bindHunk: (id: string) => (el: HTMLDivElement | null) => void;
}

function FileBlock({
  file,
  split,
  hideWs,
  collapsed,
  onCollapse,
  expanded,
  onExpand,
  gaps,
  onExpandGap,
  activeHunk,
  onRevertFile,
  onRevertHunk,
  revertHint,
  bindFile,
  bindHunk,
}: FileBlockProps) {
  const last = file.hunks[file.hunks.length - 1];
  const digits = String(Math.max(last ? last.newStart + last.lines.length : 1, 1)).length;
  const status = STATUS_LABEL[file.status];
  const wsOnly = file.hunks.length > 0 && file.hunks.every((h) => h.lines.every((l) => l.kind === "ctx" || l.ws));

  return (
    <section className="rd-fileblock" ref={bindFile} id={`file-${file.id}`}>
      <header className="rd-fhead">
        <button
          type="button"
          className="rd-fold"
          aria-expanded={!collapsed}
          onClick={() => onCollapse(file.id)}
          title={collapsed ? "Show this file's diff" : "Hide this file's diff"}
        >
          <span className={"rd-caret" + (collapsed ? " closed" : "")} aria-hidden="true">
            ▾
          </span>
          <span className="rd-fpath" title={file.path}>
            <span className="rd-fdir">{dirOf(file.path)}</span>
            <span className="rd-fbase">{baseOf(file.path)}</span>
          </span>
        </button>
        {status && <span className={`rd-badge ${file.status}`}>{status}</span>}
        {file.binary && <span className="rd-badge binary">binary</span>}
        <span className="rd-file-counts">
          <span className={"rd-add" + (file.add ? "" : " rd-zero")}>+{file.add}</span>
          <span className={"rd-del" + (file.del ? "" : " rd-zero")}>−{file.del}</span>
        </span>
        <span className="rd-action" title={onRevertFile ? "Put this file back the way it was." : revertHint}>
          <button
            type="button"
            className="rd-mini"
            disabled={!onRevertFile}
            onClick={onRevertFile ? () => onRevertFile(file) : undefined}
          >
            Revert file
          </button>
        </span>
      </header>

      {!collapsed && (
        <div className="rd-fbody" style={{ ["--rd-num" as string]: `${digits + 1}ch` }}>
          {file.status === "renamed" && file.oldPath !== file.path && (
            <div className="rd-fnote">
              renamed from <span className="rd-mono">{file.oldPath}</span>
            </div>
          )}
          {file.notes.map((n, i) => (
            <div className="rd-fnote" key={i}>
              {n}
            </div>
          ))}
          {file.binary ? (
            <div className="rd-fnote">Binary file — not shown.</div>
          ) : file.hunks.length === 0 ? (
            <div className="rd-fnote">No textual changes.</div>
          ) : hideWs && wsOnly ? (
            <div className="rd-fnote">Only whitespace changed in this file.</div>
          ) : (
            file.hunks.map((hunk) => (
              <HunkView
                key={hunk.id}
                file={file}
                hunk={hunk}
                split={split}
                hideWs={hideWs}
                active={activeHunk === hunk.id}
                expanded={expanded}
                onExpand={onExpand}
                gap={gaps[hunk.id]}
                onExpandGap={onExpandGap ? () => onExpandGap(file, hunk) : undefined}
                onRevert={onRevertHunk && !file.binary && !hunk.partial ? (h) => onRevertHunk(file, h) : undefined}
                revertHint={
                  hunk.partial
                    ? "This hunk was truncated, so Spaces can't reverse it exactly."
                    : revertHint
                }
                bind={bindHunk(hunk.id)}
              />
            ))
          )}
          {file.dropped > 0 && (
            <div className="rd-fnote warn">
              {file.dropped} more line{file.dropped === 1 ? "" : "s"} in this file aren't shown — open
              it in your editor for the rest.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ── review actions ───────────────────────────────────────────── */

function ReviewAction({
  label,
  tone,
  hint,
  disabledHint,
  busy,
  onRun,
}: {
  label: string;
  tone?: "primary" | "danger";
  hint: string;
  disabledHint: string;
  busy: boolean;
  onRun?: () => void;
}) {
  // The title lives on the wrapper: browsers don't show tooltips for disabled
  // controls, and "why is this off?" is exactly when the tooltip matters.
  return (
    <span className="rd-action" title={onRun ? hint : disabledHint}>
      <button
        className={"btn" + (tone ? ` ${tone}` : "")}
        disabled={!onRun || busy}
        onClick={onRun}
      >
        {label}
      </button>
    </span>
  );
}

/* ── ref bookkeeping ──────────────────────────────────────────── */

/** Stable per-id ref callbacks, so rows don't detach and reattach every render. */
function useRefMap<T extends HTMLElement>() {
  const map = useRef(new Map<string, T>());
  const binders = useRef(new Map<string, (el: T | null) => void>());
  const bind = useCallback((id: string) => {
    let existing = binders.current.get(id);
    if (!existing) {
      existing = (el: T | null) => {
        if (el) map.current.set(id, el);
        else map.current.delete(id);
      };
      binders.current.set(id, existing);
    }
    return existing;
  }, []);
  return { map: map.current, bind };
}

function scrollTo(el: HTMLElement | undefined, block: ScrollLogicalPosition): void {
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block, behavior: reduce ? "auto" : "smooth" });
}

/* ── main ─────────────────────────────────────────────────────── */

interface DiffState {
  loading: boolean;
  text: string;
  error: string;
}

interface ActionNote {
  kind: "ok" | "err";
  text: string;
}

interface SidebarEntry {
  path: string;
  file: DiffFile | null;
  add: number;
  del: number;
}

export interface RunDiffProps {
  runId: string;
  onClose: () => void;
  /** Optional so the integrator can wire them; rendered disabled until then. */
  onApprove?: () => void | Promise<void>;
  onRequestChanges?: (note: string) => void | Promise<void>;
  /** Overrides the built-in whole-run revert (gitflow.revertRun). */
  onRevert?: () => void | Promise<void>;
}

export function RunDiff({
  runId,
  onClose,
  onApprove,
  onRequestChanges,
  onRevert,
}: RunDiffProps) {
  const run = useStore((s) => s.runs[runId]);
  const agent = useStore((s) => s.agents.find((a) => a.id === run?.agent_id));
  const [diff, setDiff] = useState<DiffState>({ loading: true, text: "", error: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ActionNote | null>(null);
  const [reloads, setReloads] = useState(0);
  const [root, setRoot] = useState("");
  const [split, setSplit] = useState(() => readPref(VIEW_KEY, "unified") === "split");
  const [hideWs, setHideWs] = useState(() => readPref(WS_KEY, "0") === "1");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [gaps, setGaps] = useState<Record<string, GapState>>({});
  const [activeFile, setActiveFile] = useState("");
  const [activeHunk, setActiveHunk] = useState("");
  const [status, setStatus] = useState("");

  const files = useRefMap<HTMLElement>();
  const hunks = useRefMap<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!run) void useStore.getState().loadRun(runId);
  }, [runId, run]);

  const loaded = !!run;
  const cwd = run?.cwd ?? "";
  const before = run?.commit_before ?? "";
  const after = run?.commit_after ?? "";
  const running = run?.status === "running";

  // Keyed on the checkpoint pair: a still-running turn has no "after" yet, so
  // this shows its uncommitted work now and re-reads once the checkpoint lands.
  // `reloads` re-reads it after a revert, so the view never lies about disk.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    setDiff({ loading: true, text: "", error: "" });
    // Context read off disk belongs to the diff it was read for; a revert
    // invalidates both the line numbers and the file it came from.
    setGaps({});
    setExpanded(new Set());
    void (async () => {
      try {
        const r = await runDiff(cwd, before, after);
        if (!cancelled) setDiff({ loading: false, text: r.diff, error: r.error });
      } catch (e) {
        if (!cancelled) setDiff({ loading: false, text: "", error: errText(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, cwd, before, after, reloads]);

  // Diff paths are relative to the repo root, which the run's cwd need not be.
  useEffect(() => {
    if (!cwd) {
      setRoot("");
      return;
    }
    let cancelled = false;
    void git(cwd, "rev-parse", "--show-toplevel").then(
      (out) => {
        if (!cancelled) setRoot(out.trim());
      },
      () => {
        if (!cancelled) setRoot("");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const parsed = useMemo(() => parseDiff(diff.text), [diff.text]);

  // The run's own record of what it touched is the source of truth for *which*
  // files were involved; the diff supplies the numbers. A file can appear in
  // one and not the other (untracked overflow, a diff too big to parse), so the
  // sidebar shows the union rather than picking a side.
  const entries = useMemo<SidebarEntry[]>(() => {
    const byPath = new Map<string, SidebarEntry>();
    for (const f of parsed.files) {
      const seen = byPath.get(f.path);
      if (seen) {
        seen.add += f.add;
        seen.del += f.del;
      } else {
        byPath.set(f.path, { path: f.path, file: f, add: f.add, del: f.del });
      }
    }
    const listed = (run?.files_changed ?? "")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    for (const path of listed) {
      if (!byPath.has(path)) byPath.set(path, { path, file: null, add: 0, del: 0 });
    }
    // Sorted so the directory headings group cleanly — git's own order already
    // is, but paths that came only from the run record are appended after it.
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [parsed.files, run?.files_changed]);

  const hunkOrder = useMemo(
    () =>
      parsed.files.flatMap((f) => (collapsed.has(f.id) ? [] : f.hunks.map((h) => h.id))),
    [parsed.files, collapsed]
  );
  const fileOrder = useMemo(() => parsed.files.map((f) => f.id), [parsed.files]);

  const chooseView = useCallback((next: boolean) => {
    setSplit(next);
    writePref(VIEW_KEY, next ? "split" : "unified");
  }, []);

  const chooseWs = useCallback((next: boolean) => {
    setHideWs(next);
    writePref(WS_KEY, next ? "1" : "0");
  }, []);

  const toggleFile = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandGap = useCallback((id: string) => {
    setExpanded((prev) => new Set(prev).add(id));
  }, []);

  const loadGap = useCallback(
    (file: DiffFile, hunk: Hunk) => {
      if (gaps[hunk.id]) return;
      setGaps((prev) => ({ ...prev, [hunk.id]: { loading: true } }));
      void readGap(root, file, hunk).then(
        (lines) => setGaps((prev) => ({ ...prev, [hunk.id]: { lines } })),
        (e) => setGaps((prev) => ({ ...prev, [hunk.id]: { error: errText(e) } }))
      );
    },
    [gaps, root]
  );

  const allCollapsed = fileOrder.length > 0 && fileOrder.every((id) => collapsed.has(id));
  const toggleAll = useCallback(() => {
    setCollapsed(allCollapsed ? new Set() : new Set(fileOrder));
  }, [allCollapsed, fileOrder]);

  const jumpToFile = useCallback(
    (id: string) => {
      setActiveFile(id);
      setCollapsed((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // After a state flush, so a just-expanded block is measured expanded.
      requestAnimationFrame(() => scrollTo(files.map.get(id), "start"));
    },
    [files.map]
  );

  const gotoHunk = useCallback(
    (dir: 1 | -1) => {
      if (!hunkOrder.length) return;
      const i = hunkOrder.indexOf(activeHunk);
      const next =
        i < 0
          ? hunkOrder[dir === 1 ? 0 : hunkOrder.length - 1]
          : hunkOrder[Math.min(hunkOrder.length - 1, Math.max(0, i + dir))];
      setActiveHunk(next);
      scrollTo(hunks.map.get(next), "nearest");
      setStatus(`Hunk ${hunkOrder.indexOf(next) + 1} of ${hunkOrder.length}`);
    },
    [activeHunk, hunkOrder, hunks.map]
  );

  const gotoFile = useCallback(
    (dir: 1 | -1) => {
      if (!fileOrder.length) return;
      const i = fileOrder.indexOf(activeFile);
      const next =
        i < 0
          ? fileOrder[dir === 1 ? 0 : fileOrder.length - 1]
          : fileOrder[Math.min(fileOrder.length - 1, Math.max(0, i + dir))];
      jumpToFile(next);
      const file = parsed.files.find((f) => f.id === next);
      setStatus(`File ${fileOrder.indexOf(next) + 1} of ${fileOrder.length}: ${file?.path ?? ""}`);
    },
    [activeFile, fileOrder, jumpToFile, parsed.files]
  );

  // Whole-modal shortcuts: the diff is the point of this view, so navigating it
  // shouldn't require parking focus in the right pane first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "n") gotoHunk(1);
      else if (key === "p") gotoHunk(-1);
      else if (key === "j") gotoFile(1);
      else if (key === "k") gotoFile(-1);
      else if (key === "s") chooseView(!split);
      else if (key === "w") chooseWs(!hideWs);
      else if (key === "c") toggleAll();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gotoHunk, gotoFile, chooseView, chooseWs, split, hideWs, toggleAll]);

  // "You are here" in the sidebar: whichever file header sits at the top of the
  // scroller. Coalesced through rAF so a fling doesn't thrash React.
  useEffect(() => {
    const pane = scroller.current;
    if (!pane) return;
    let queued = false;
    const measure = () => {
      queued = false;
      const top = pane.getBoundingClientRect().top;
      let current = "";
      for (const id of fileOrder) {
        const el = files.map.get(id);
        if (el && el.getBoundingClientRect().top - top <= 12) current = id;
      }
      if (current) setActiveFile(current);
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => pane.removeEventListener("scroll", onScroll);
  }, [fileOrder, files.map]);

  const act = useCallback(
    async (fn: () => Promise<string | void> | string | void, done: string) => {
      setBusy(true);
      setNote(null);
      try {
        const said = await fn();
        setNote({ kind: "ok", text: typeof said === "string" && said ? said : done });
      } catch (e) {
        setNote({ kind: "err", text: errText(e) });
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  /** Why partial reverts are unavailable — "" when they are available. */
  const revertBlock = !cwd
    ? "This run has no working directory recorded."
    : !root
      ? "Spaces couldn't find the git repository for this run's working directory."
      : running
        ? "This run is still going — wait for it to finish before undoing its work."
        : busy
          ? "Another action is still running."
          : "";

  const historyNote = after
    ? `The run's commit (${shortSha(after)}) stays in git history — only your working copy changes.`
    : "This run hasn't been committed, so the change disappears entirely.";

  const revertFile = useCallback(
    async (file: DiffFile) => {
      const plan = await planFileRevert(cwd, root, before, after, file);
      if (plan.kind === "none") {
        setNote({ kind: "err", text: plan.why });
        return;
      }
      const body =
        plan.kind === "restore"
          ? `Restores ${plan.path} to its contents at ${shortSha(plan.from)}` +
            (plan.alsoRemove ? ` and deletes ${plan.alsoRemove}` : "") +
            `. ${historyNote}` +
            (plan.dirty
              ? ` ${plan.path} also has uncommitted edits that aren't part of this run — they will be thrown away.`
              : "")
          : plan.kind === "remove"
            ? `Deletes ${plan.path} from your working tree. It did not exist before this run. ${historyNote}`
            : `Rewrites ${plan.path} on disk, undoing ${file.add} added and ${file.del} removed line` +
              `${file.add + file.del === 1 ? "" : "s"}. ${historyNote}`;
      if (
        !(await confirmAction({
          title: `Revert ${baseOf(file.path)}?`,
          body,
          confirmLabel: "Revert file",
          danger: true,
        }))
      ) {
        return;
      }
      await act(async () => {
        await applyPlan(cwd, root, plan);
        reload();
        return `Reverted ${file.path}.`;
      }, "File reverted.");
    },
    [act, before, cwd, historyNote, reload, root]
  );

  const revertHunk = useCallback(
    async (file: DiffFile, hunk: Hunk) => {
      const where = `${file.path}:${hunk.newStart}`;
      if (
        !(await confirmAction({
          title: "Revert this hunk?",
          body:
            `Puts back ${hunk.del} removed and takes out ${hunk.add} added line` +
            `${hunk.add + hunk.del === 1 ? "" : "s"} at ${where}, editing the file on disk. ` +
            `Spaces checks the file still matches the run's version first and refuses if it doesn't. ${historyNote}`,
          confirmLabel: "Revert hunk",
          danger: true,
        }))
      ) {
        return;
      }
      await act(async () => {
        await reverseApply(root, file.path, [hunk], file.status === "deleted");
        reload();
        return `Reverted the hunk at ${where}.`;
      }, "Hunk reverted.");
    },
    [act, historyNote, reload, root]
  );

  const revertWholeRun = useCallback(async () => {
    const name = agent?.name ?? "the agent";
    if (
      !(await confirmAction({
        title: "Revert this entire run?",
        body:
          `Undoes everything ${name} changed in this turn` +
          (after ? ` — commit ${shortSha(after)}` : "") +
          (cwd ? `, in ${cwd}` : "") +
          ". Spaces refuses if anything has landed on top of it, and never rewrites published history.",
        confirmLabel: "Revert run",
        danger: true,
      }))
    ) {
      return;
    }
    await act(async () => {
      if (onRevert) {
        await onRevert();
        reload();
        return "Run reverted.";
      }
      const res = await revertRun(cwd, before, after);
      if (!res.ok) throw new Error(res.error);
      reload();
      return res.value;
    }, "Run reverted.");
  }, [act, after, agent?.name, before, cwd, onRevert, reload]);

  if (!run) {
    return (
      <Modal title="Run diff" onClose={onClose} wide>
        <div className="run-loading">
          <Spinner /> loading run…
        </div>
      </Modal>
    );
  }

  const name = agent?.name ?? "unknown agent";
  const hasDiff = diff.text.trim() !== "";
  const ready = !diff.loading && !diff.error && hasDiff;

  return (
    <Modal title="Run diff" onClose={onClose} wide>
      <div className="rd-root">
        <div className="run-card">
          <div className="run-head">
            <Avatar name={name} id={run.agent_id} kind={agent?.kind} />
            <div className="run-head-main">
              <div className="run-agent-name">{name}</div>
              <div className="run-head-sub">
                {entries.length} file{entries.length === 1 ? "" : "s"} changed{" "}
                <span className="rd-add">+{parsed.add}</span>{" "}
                <span className="rd-del">−{parsed.del}</span> ·{" "}
                {new Date(run.started_at).toLocaleString()}
              </div>
            </div>
            <span className={`run-chip ${run.status}`}>
              <span className="run-chip-dot" />
              {run.status}
            </span>
          </div>
          <div className="run-facts">
            <div className="run-fact">
              <span className="run-fact-label">Checkpoint</span>
              <span className="rd-shas">
                {before ? (
                  <>
                    <code className="rd-sha" title={before}>
                      {shortSha(before)}
                    </code>
                    <CopyButton value={before} label={`before commit ${shortSha(before)}`} />
                  </>
                ) : (
                  <span className="rd-none">no baseline</span>
                )}
                <span className="rd-arrow" aria-hidden="true">
                  →
                </span>
                {after ? (
                  <>
                    <code className="rd-sha" title={after}>
                      {shortSha(after)}
                    </code>
                    <CopyButton value={after} label={`after commit ${shortSha(after)}`} />
                  </>
                ) : (
                  <span className="rd-none">working tree</span>
                )}
              </span>
            </div>
            {run.cwd && (
              <div className="run-fact run-fact-wide">
                <span className="run-fact-label">Working directory</span>
                <span className="rd-shas">
                  <span className="mono-trunc" title={run.cwd}>
                    {run.cwd}
                  </span>
                  <CopyButton value={run.cwd} label="working directory" />
                </span>
              </div>
            )}
          </div>
        </div>

        {ready && (
          <div className="rd-tools">
            <div className="rd-seg" role="group" aria-label="Diff layout">
              <button
                type="button"
                className={"rd-segbtn" + (split ? "" : " on")}
                aria-pressed={!split}
                onClick={() => chooseView(false)}
              >
                Unified
              </button>
              <button
                type="button"
                className={"rd-segbtn" + (split ? " on" : "")}
                aria-pressed={split}
                onClick={() => chooseView(true)}
              >
                Side by side
              </button>
            </div>
            <button
              type="button"
              className={"rd-toggle" + (hideWs ? " on" : "")}
              aria-pressed={hideWs}
              onClick={() => chooseWs(!hideWs)}
              title="Hide changes that only add, remove or reshuffle whitespace."
            >
              Hide whitespace
            </button>
            <button type="button" className="rd-toggle" onClick={toggleAll}>
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
            <span className="rd-spacer" />
            <span className="rd-keys" aria-hidden="true">
              <kbd>n</kbd>/<kbd>p</kbd> hunk · <kbd>j</kbd>/<kbd>k</kbd> file · <kbd>s</kbd> layout
            </span>
          </div>
        )}

        <div className="rd-panes">
          <section className="rd-pane">
            <div className="rd-pane-head">
              <span className="field-label">Files</span>
              <span className="rd-pane-count">{entries.length}</span>
            </div>
            {entries.length === 0 ? (
              <div className="rd-empty">No files recorded.</div>
            ) : (
              <nav className="rd-files" aria-label="Changed files">
                {entries.map((entry, i) => {
                  const dir = dirOf(entry.path);
                  const showDir = i === 0 || dirOf(entries[i - 1].path) !== dir;
                  const file = entry.file;
                  const body = (
                    <>
                      <span className="rd-file-path" title={entry.path}>
                        {baseOf(entry.path)}
                      </span>
                      {file?.binary && (
                        <span className="rd-file-tag" title="binary file">
                          bin
                        </span>
                      )}
                      {file && file.status !== "modified" && (
                        <span className="rd-file-tag" title={file.status}>
                          {file.status[0].toUpperCase()}
                        </span>
                      )}
                      <span className="rd-file-counts">
                        <span className={"rd-add" + (entry.add ? "" : " rd-zero")}>+{entry.add}</span>
                        <span className={"rd-del" + (entry.del ? "" : " rd-zero")}>−{entry.del}</span>
                      </span>
                    </>
                  );
                  return (
                    <Fragment key={`${entry.path}-${i}`}>
                      {showDir && <div className="rd-dir">{dir || "./"}</div>}
                      {file ? (
                        <button
                          type="button"
                          className={"rd-file" + (activeFile === file.id ? " is-active" : "")}
                          onClick={() => jumpToFile(file.id)}
                          aria-current={activeFile === file.id ? "true" : undefined}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="rd-file rd-file-flat" title="No diff recorded for this file.">
                          {body}
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </nav>
            )}
          </section>

          <section className="rd-pane">
            <div className="rd-pane-head">
              <span className="field-label">Diff</span>
              {ready && (
                <span className="rd-pane-count">
                  {parsed.files.length} block{parsed.files.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {diff.loading ? (
              <div className="rd-loading">
                <Spinner /> Computing diff…
              </div>
            ) : diff.error ? (
              <div className="banner warn rd-error">{diff.error}</div>
            ) : !hasDiff ? (
              <div className="rd-empty">
                {running
                  ? "Nothing has changed on disk yet."
                  : "This turn didn't change any files."}
              </div>
            ) : (
              <div
                className="rd-diff"
                ref={scroller}
                tabIndex={0}
                role="region"
                aria-label={split ? "Side-by-side diff" : "Unified diff"}
              >
                {parsed.files.map((file) => (
                  <FileBlock
                    key={file.id}
                    file={file}
                    split={split}
                    hideWs={hideWs}
                    collapsed={collapsed.has(file.id)}
                    onCollapse={toggleFile}
                    expanded={expanded}
                    onExpand={expandGap}
                    gaps={gaps}
                    onExpandGap={root && !file.binary ? loadGap : undefined}
                    activeHunk={activeHunk}
                    onRevertFile={revertBlock ? undefined : (f) => void revertFile(f)}
                    onRevertHunk={revertBlock ? undefined : (f, h) => void revertHunk(f, h)}
                    revertHint={revertBlock || "Undo this change on disk."}
                    bindFile={files.bind(file.id)}
                    bindHunk={hunks.bind}
                  />
                ))}
                {parsed.stray.map((s, i) => (
                  <div className="rd-stray" key={i}>
                    {s}
                  </div>
                ))}
                {parsed.capped && (
                  <div className="rd-stray warn">
                    This diff is too large to render in full — {MAX_TOTAL_LINES} lines are shown.
                    Per-file reverts still work on everything.
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="rd-live" role="status" aria-live="polite">
          {status}
        </div>
        {note && <div className={`rd-note ${note.kind}`}>{note.text}</div>}

        <div className="rd-actions">
          <ReviewAction
            label="Approve"
            tone="primary"
            hint="Mark this turn as reviewed."
            disabledHint="Approving isn't wired up in this view yet."
            busy={busy}
            onRun={onApprove && (() => void act(onApprove, "Approved — this turn is marked as reviewed."))}
          />
          <ReviewAction
            label="Request changes"
            hint="Send a note back to the agent."
            disabledHint="Requesting changes isn't wired up in this view yet."
            busy={busy}
            onRun={
              onRequestChanges &&
              (() => {
                const asked = window.prompt("What should change?");
                const text = asked?.trim();
                if (text) void act(() => onRequestChanges(text), "Change request sent.");
              })
            }
          />
          <div className="rd-spacer" />
          {busy && <Spinner />}
          <ReviewAction
            label="Revert this run"
            tone="danger"
            hint="Undo everything this turn changed."
            disabledHint={
              running
                ? "This run is still going — wait for it to finish."
                : !cwd
                  ? "This run has no working directory recorded."
                  : "This run never committed anything, so there's nothing to revert."
            }
            busy={busy}
            onRun={
              !running && cwd && (onRevert || after) ? () => void revertWholeRun() : undefined
            }
          />
        </div>
      </div>
    </Modal>
  );
}
