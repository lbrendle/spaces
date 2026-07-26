/**
 * The markdown field, on Obsidian's model.
 *
 * Every markdown field in Spaces used to be a bare textarea, which quietly assumed
 * you already knew markdown. This renders the syntax *in place* instead: a
 * `# heading` looks like a heading while it stays the characters `# heading`,
 * and the markers un-ghost on the line the caret is on so you can always see
 * and edit the real thing. The document is plain text and stays plain text.
 *
 * ── How it works, and the one invariant that matters ──────────────────────
 *
 * A transparent <textarea> sits on top of a styled layer that mirrors the same
 * string. The textarea keeps the caret, the selection, the native undo stack,
 * IME composition, spellcheck and accessibility; the layer only paints. That
 * only holds together if **the layer wraps exactly where the textarea wraps**.
 * A single extra visual line in the layer offsets every line below it, which
 * is the failure that makes this technique look broken.
 *
 * So: nothing in the layer may change how wide a character is. That rules out
 * bold-by-font-weight and per-heading font sizes in a proportional font, and it
 * is why the editor is set in `--mono`. In a monospaced family every face —
 * roman, italic, bold — shares one advance, so real italics are free, and a
 * heading can be *scaled* as long as the extra width is taken back out with
 * negative tracking (see `--mde-h*` in markdowneditor.css: at scale s, letter
 * spacing of (1-s)/s ch restores the original advance per character exactly).
 * Weight is painted with -webkit-text-stroke rather than a bold face, because a
 * stroke thickens the glyph without touching its advance even when the text
 * falls back to some font we never chose.
 *
 * Syntax is ghosted, never removed, for the same reason and for a better one:
 * a person who does not know markdown watches `**` fade as their words go bold,
 * which teaches the syntax instead of hiding it. The two places we do cover the
 * source — a list bullet, a checkbox — draw the replacement in exactly the cells
 * the characters occupied, and hand them back on the caret's line.
 *
 * Edits go through document.execCommand("insertText") rather than assigning to
 * .value, because assigning wipes the native undo stack, and losing ⌘Z in a
 * text field is a worse regression than anything this component adds.
 */
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import { searchEntities } from "../entities";
import type { EntityInfo } from "../entities";
import { highlight } from "../syntax";
import { slug } from "../types";
import type { EntityType } from "../types";
import "./markdowneditor.css";

/* ═══════════════════════════════════════════════════════════════
   Editing primitives
   ═══════════════════════════════════════════════════════════════ */

/**
 * Replace [start, end) with `text`, keeping the browser's own undo history.
 *
 * execCommand is deprecated and still the only way to put an edit *into* the
 * undo stack from script; a direct assignment to .value clears it. The manual
 * path below is the fallback for engines that have finally dropped it, and it
 * dispatches the input event itself so a controlled parent still hears about
 * the change either way.
 */
function edit(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  select?: [number, number]
): void {
  if (start === end && !text) return;
  ta.focus();
  ta.setSelectionRange(start, end);

  let ok = false;
  try {
    ok = text
      ? document.execCommand("insertText", false, text)
      : end > start && document.execCommand("delete");
  } catch {
    ok = false;
  }
  if (!ok) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    const next = ta.value.slice(0, start) + text + ta.value.slice(end);
    setter?.call(ta, next);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const caret = start + text.length;
  const [a, b] = select ?? [caret, caret];
  ta.setSelectionRange(a, b);
}

/**
 * Insert `snippet` at the caret, replacing any selection.
 *
 * Exported because plenty of surfaces want to drop a token into a field they
 * do not own — a link picker writing `[[Title]]`, a toolbar writing a fence.
 * Works on any textarea, not only this one, and keeps its undo history.
 */
export function insertMarkdown(textarea: HTMLTextAreaElement, snippet: string): void {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  edit(textarea, start, end, snippet);
}

/* ═══════════════════════════════════════════════════════════════
   Source model — one pass per line, then one pass per line's inlines
   ═══════════════════════════════════════════════════════════════ */

type LineKind =
  | "text"
  | "heading"
  | "quote"
  | "bullet"
  | "ordered"
  | "rule"
  | "table"
  | "fence"
  | "code";

interface SourceLine {
  raw: string;
  kind: LineKind;
  /** Leading whitespace, kept separate so the bullet lands in its own cell. */
  indent: string;
  /** The block marker itself: "##", "-", "3.", ">", "```ts". */
  token: string;
  /** Whitespace between the marker and the content. */
  gap: string;
  /** "[ ]" or "[x]" for a checklist item, "" otherwise. */
  box: string;
  /** Whitespace after the checkbox. */
  boxGap: string;
  /** Everything the reader is actually meant to read. */
  body: string;
  /** Heading level 1-6, or the number of an ordered item. */
  level: number;
  /** Blockquote depth, 0 when this is not a quote. */
  quote: number;
  /** Column the quote bar is drawn in, in characters. */
  quoteCol: number;
  checked: boolean;
  /** Language of the fence this line belongs to. */
  lang: string;
}

const RE_FENCE = /^(\s*)(```|~~~)(.*)$/;
const RE_HEADING = /^(#{1,6})(\s+)(.*)$/;
const RE_RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^([ \t]*(?:>[ \t]?)+)(.*)$/;
const RE_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const RE_TASK = /^(\[[ xX]\])([ \t]+)(.*)$/;

function blank(raw: string): SourceLine {
  return {
    raw,
    kind: "text",
    indent: "",
    token: "",
    gap: "",
    box: "",
    boxGap: "",
    body: raw,
    level: 0,
    quote: 0,
    quoteCol: 0,
    checked: false,
    lang: "",
  };
}

/** Classify one line. `offset` is how many characters a quote prefix already ate. */
function classify(raw: string, offset: number): SourceLine {
  const line = blank(raw);

  const quote = RE_QUOTE.exec(raw);
  if (quote && quote[1].includes(">")) {
    const inner = classify(quote[2], offset + quote[1].length);
    const depth = (quote[1].match(/>/g) ?? []).length;
    return {
      ...inner,
      raw,
      indent: quote[1] + inner.indent,
      quote: depth,
      quoteCol: offset + quote[1].search(/>/),
      kind: inner.kind === "text" ? "quote" : inner.kind,
    };
  }

  const heading = RE_HEADING.exec(raw);
  if (heading) {
    return { ...line, kind: "heading", token: heading[1], gap: heading[2], body: heading[3], level: heading[1].length };
  }

  if (RE_RULE.test(raw)) return { ...line, kind: "rule", token: raw.trim(), indent: raw.slice(0, raw.length - raw.trimStart().length), body: "" };

  const list = RE_LIST.exec(raw);
  if (list) {
    const ordered = /\d/.test(list[2]);
    const task = RE_TASK.exec(list[4]);
    return {
      ...line,
      kind: ordered ? "ordered" : "bullet",
      indent: list[1],
      token: list[2],
      gap: list[3],
      box: task ? task[1] : "",
      boxGap: task ? task[2] : "",
      body: task ? task[3] : list[4],
      level: ordered ? parseInt(list[2], 10) : 0,
      checked: task ? task[1][1].toLowerCase() === "x" : false,
    };
  }

  if (/^[ \t]*\|.*\|[ \t]*$/.test(raw)) return { ...line, kind: "table" };

  return line;
}

/** The whole document, with fenced regions resolved. */
function parseDoc(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  let fence = "";
  let lang = "";
  for (const raw of text.split("\n")) {
    const f = RE_FENCE.exec(raw);
    if (f && (!fence || f[2] === fence)) {
      const opening = !fence;
      if (opening) {
        fence = f[2];
        lang = f[3].trim().split(/\s+/)[0] ?? "";
      }
      out.push({ ...blank(raw), kind: "fence", indent: f[1], token: f[2] + f[3], body: "", lang });
      if (!opening) {
        fence = "";
        lang = "";
      }
      continue;
    }
    if (fence) {
      out.push({ ...blank(raw), kind: "code", lang });
      continue;
    }
    out.push(classify(raw, 0));
  }
  return out;
}

/* ── Inline scan ────────────────────────────────────────────────
   Single left-to-right pass. A chain of regex replacements over the
   whole line matches inside the markup it has already produced; a
   scanner cannot. Every character of the input lands in exactly one
   token, which is what keeps the layer the same width as the source. */

type InlineClass =
  | "text"
  | "mk"
  | "code"
  | "strong"
  | "em"
  | "strongem"
  | "strike"
  | "hl"
  | "link"
  | "url"
  | "wiki"
  | "at"
  | "hash";

interface Inline {
  c: InlineClass;
  s: string;
}

const ESCAPABLE = "\\`*_{}[]()#+-.!~>|";
const URL_RE = /^https?:\/\/[^\s<>"']+/;

function runOf(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function scanInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ c: "text", s: buf });
      buf = "";
    }
  };
  const push = (c: InlineClass, s: string) => {
    if (s) out.push({ c, s });
  };
  /** A delimited span: opener, content, closer. */
  const span = (c: InlineClass, open: string, body: string, close: string) => {
    flush();
    push("mk", open);
    push(c, body);
    push("mk", close);
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];

    // `i + 1 < n` guards the lone trailing backslash: "".includes("") is true,
    // so without it the last character of the line would be scanned as escaped.
    if (ch === "\\" && i + 1 < n && ESCAPABLE.includes(src[i + 1])) {
      flush();
      push("mk", "\\");
      push("text", src[i + 1]);
      i += 2;
      continue;
    }

    // Code first: everything inside a code span is literal.
    if (ch === "`") {
      const run = runOf(src, i, "`");
      const fence = "`".repeat(run);
      const close = src.indexOf(fence, i + run);
      if (close > 0) {
        span("code", fence, src.slice(i + run, close), fence);
        i = close + run;
        continue;
      }
    }

    if (ch === "[" && src[i + 1] === "[") {
      const close = src.indexOf("]]", i + 2);
      if (close > i + 1) {
        span("wiki", "[[", src.slice(i + 2, close), "]]");
        i = close + 2;
        continue;
      }
    }

    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const shut = src.indexOf("]", open + 1);
      if (shut > open && src[shut + 1] === "(") {
        const paren = src.indexOf(")", shut + 2);
        if (paren > shut) {
          flush();
          push("mk", src.slice(i, open + 1));
          push("link", src.slice(open + 1, shut));
          push("mk", "](");
          push("url", src.slice(shut + 2, paren));
          push("mk", ")");
          i = paren + 1;
          continue;
        }
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const close = src.indexOf("~~", i + 2);
      if (close > i + 1) {
        span("strike", "~~", src.slice(i + 2, close), "~~");
        i = close + 2;
        continue;
      }
    }

    if (ch === "=" && src[i + 1] === "=") {
      const close = src.indexOf("==", i + 2);
      if (close > i + 1) {
        span("hl", "==", src.slice(i + 2, close), "==");
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      // `_` inside a word is snake_case, not emphasis.
      const boundaryOk = ch === "*" || !isWordChar(src[i - 1]);
      const run = Math.min(runOf(src, i, ch), 3);
      const mark = ch.repeat(run);
      const close = boundaryOk ? src.indexOf(mark, i + run) : -1;
      const body = close > 0 ? src.slice(i + run, close) : "";
      const closeOk = ch === "*" || !isWordChar(src[close + mark.length]);
      if (close > 0 && body.trim() && !/^\s|\s$/.test(body) && closeOk) {
        span(run >= 3 ? "strongem" : run === 2 ? "strong" : "em", mark, body, mark);
        i = close + run;
        continue;
      }
    }

    if (ch === "h" && (i === 0 || !isWordChar(src[i - 1]))) {
      const m = URL_RE.exec(src.slice(i));
      if (m) {
        const raw = m[0].replace(/[.,;:!?)]+$/, "");
        flush();
        push("url", raw);
        i += raw.length;
        continue;
      }
    }

    // Left boundary keeps emails, npm scopes and /@user paths intact — the same
    // rule links.ts uses, so what looks like a mention is what becomes an edge.
    if (ch === "@" && !/[\w@./-]/.test(src[i - 1] ?? "")) {
      const m = /^@[a-z0-9-]+/i.exec(src.slice(i));
      if (m) {
        flush();
        push("at", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (ch === "#" && (i === 0 || /\s/.test(src[i - 1]))) {
      const m = /^#[a-z0-9-]+/i.exec(src.slice(i));
      if (m) {
        flush();
        push("hash", m[0]);
        i += m[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   The rendered layer
   ═══════════════════════════════════════════════════════════════ */

function Inlines({ toks }: { toks: Inline[] }) {
  return (
    <>
      {toks.map((t, i) =>
        t.c === "text" ? (
          <span key={i}>{t.s}</span>
        ) : (
          <span key={i} className={`mde-${t.c}`}>
            {t.s}
          </span>
        )
      )}
    </>
  );
}

interface LineProps {
  line: SourceLine;
  index: number;
  active: boolean;
}

/**
 * One source line, one block box.
 *
 * memo'd on purpose: moving the caret re-renders the layer so the syntax on the
 * new line can un-ghost, and in a long document only two lines have actually
 * changed.
 */
const Line = memo(function Line({ line, index, active }: LineProps) {
  // Block classes are `mde-ln-*` and inline ones `mde-*`, so a line of code and
  // a code span never end up asking for the same rule.
  const cls = ["mde-ln", `mde-ln-${line.kind}`];
  if (line.kind === "heading") cls.push(`mde-h${line.level}`);
  if (line.quote) cls.push("mde-inq");
  // A task draws a checkbox; drawing a bullet next to it as well would be two
  // affordances for one item.
  if (line.box) cls.push("mde-ln-task");
  if (line.checked) cls.push("mde-done");
  if (active) cls.push("mde-on");

  const style = line.quote ? ({ "--mde-qc": `${line.quoteCol}` } as CSSProperties) : undefined;

  let body: ReactNode;
  if (line.kind === "code" && line.lang) {
    // syntax.ts guarantees its output escapes every character it emits and
    // reproduces the input exactly, which is the only reason this is safe and
    // the only reason the width still matches.
    body = <span className="mde-src" dangerouslySetInnerHTML={{ __html: highlight(line.raw, line.lang) }} />;
  } else if (line.kind === "code" || line.kind === "rule" || line.kind === "table") {
    body = <span className="mde-src">{line.raw}</span>;
  } else {
    const toks = inlineTokens(line.body);
    body = (
      <>
        {/* Indent is whitespace for a list and `> ` for a quote, so it is
            ghosted like any other block marker — whitespace does not care. */}
        {line.indent && <span className="mde-mk">{line.indent}</span>}
        {line.token && <span className={"mde-mk mde-tok"}>{line.token}</span>}
        {line.gap && <span>{line.gap}</span>}
        {line.box && (
          <span className="mde-mk mde-box" data-on={line.checked ? "1" : "0"}>
            {line.box}
          </span>
        )}
        {line.boxGap && <span>{line.boxGap}</span>}
        <Inlines toks={toks} />
      </>
    );
  }

  return (
    <div className={cls.join(" ")} data-line={index} style={style}>
      {body}
    </div>
  );
});

/** Inline scanning is pure and hot, so it is cached on the string itself. */
const inlineCache = new Map<string, Inline[]>();
function inlineTokens(src: string): Inline[] {
  const hit = inlineCache.get(src);
  if (hit) return hit;
  const toks = scanInline(src);
  // Bounded: a long editing session would otherwise keep every intermediate
  // state of every line alive for the life of the window.
  if (inlineCache.size > 4000) inlineCache.clear();
  inlineCache.set(src, toks);
  return toks;
}

/* ═══════════════════════════════════════════════════════════════
   Writer behaviour markdown itself does not have
   ═══════════════════════════════════════════════════════════════ */

interface Ctx {
  ta: HTMLTextAreaElement;
  value: string;
  start: number;
  end: number;
}

function lineBounds(value: string, at: number): [number, number] {
  const start = value.lastIndexOf("\n", at - 1) + 1;
  const nl = value.indexOf("\n", at);
  return [start, nl === -1 ? value.length : nl];
}

/** The marker a new sibling item carries. Empty when the line starts nothing. */
function continuation(line: SourceLine): string {
  if (line.kind === "bullet") return `${line.indent}${line.token}${line.gap}${line.box ? `[ ]${line.boxGap}` : ""}`;
  if (line.kind === "ordered")
    return `${line.indent}${line.level + 1}${line.token.slice(-1)}${line.gap}${line.box ? `[ ]${line.boxGap}` : ""}`;
  if (line.kind === "quote") return line.indent;
  return "";
}

/** Everything before the content — what "an empty item" means. */
function markerOf(line: SourceLine): string {
  if (line.kind === "quote") return line.indent;
  return line.indent + line.token + line.gap + line.box + line.boxGap;
}

/**
 * Renumber every ordered run in the document.
 *
 * A run is the items at one indent, ended by a blank line or by content that
 * is not part of the list; a nested list is its own run and does not interrupt
 * its parent. The first item keeps whatever number it was given — somebody who
 * starts at 3 meant 3 — and everything after it follows on. Returns the input
 * unchanged when nothing was wrong, because a no-op edit still costs an undo.
 */
function renumberDoc(text: string): string {
  const rows = text.split("\n");
  const counters = new Map<number, number>();
  let touched = false;

  for (let i = 0; i < rows.length; i++) {
    const line = classify(rows[i], 0);
    if (line.kind !== "ordered") {
      // Anything flush left that is not a list item closes every open run.
      if (!line.raw.trim() || (line.kind !== "bullet" && !line.indent)) counters.clear();
      continue;
    }
    const width = line.indent.length;
    for (const depth of [...counters.keys()]) if (depth > width) counters.delete(depth);
    const n = counters.has(width) ? (counters.get(width) as number) + 1 : line.level;
    counters.set(width, n);

    const want = `${line.indent}${n}${line.token.slice(-1)}${line.gap}${line.box}${line.boxGap}${line.body}`;
    if (want !== rows[i]) {
      rows[i] = want;
      touched = true;
    }
  }
  return touched ? rows.join("\n") : text;
}

/** Carry an offset across a renumber, which only ever changes digits in place. */
function shiftOffset(before: string, after: string, off: number): number {
  const oldRows = before.split("\n");
  const newRows = after.split("\n");
  let idx = 0;
  let consumed = 0;
  while (idx < oldRows.length - 1 && consumed + oldRows[idx].length < off) {
    consumed += oldRows[idx].length + 1;
    idx++;
  }
  let base = 0;
  for (let i = 0; i < idx; i++) base += newRows[i].length + 1;
  const col = off - consumed + (newRows[idx].length - oldRows[idx].length);
  return base + Math.max(0, Math.min(newRows[idx].length, col));
}

function applyRenumber(ta: HTMLTextAreaElement): void {
  const next = renumberDoc(ta.value);
  if (next === ta.value) return;
  const a = shiftOffset(ta.value, next, ta.selectionStart);
  const b = shiftOffset(ta.value, next, ta.selectionEnd);
  edit(ta, 0, ta.value.length, next, [a, b]);
}

/** Enter: continue a list, end it on an empty item, split a line cleanly. */
function onEnter(ctx: Ctx): boolean {
  const { ta, value, start, end } = ctx;
  const [ls, le] = lineBounds(value, start);
  const line = classify(value.slice(ls, le), 0);
  const marker = markerOf(line);
  if (!marker || (line.kind !== "bullet" && line.kind !== "ordered" && line.kind !== "quote")) return false;

  // An empty item means "I am done": step out one level, then stop listing.
  if (!line.body.trim() && start === end && start >= ls + marker.length) {
    const outdented = line.indent.length >= 2 ? marker.replace(/^(?: {2}|\t)/, "") : "";
    edit(ta, ls, ls + marker.length, outdented);
    return true;
  }

  edit(ta, start, end, `\n${continuation(line)}`);
  if (line.kind === "ordered") applyRenumber(ta);
  return true;
}

/**
 * Tab inside a list indents; anywhere else it must still move focus, or the
 * field becomes a keyboard trap and the form around it becomes unreachable.
 */
function onTab(ctx: Ctx, shift: boolean): boolean {
  const { ta, value, start, end } = ctx;
  const [first] = lineBounds(value, start);
  const [, last] = lineBounds(value, end);
  const rows = value.slice(first, last).split("\n");
  const listed = rows.some((r) => {
    const kind = classify(r, 0).kind;
    return kind === "bullet" || kind === "ordered";
  });
  if (!listed) return false;

  const next = rows.map((r) => (shift ? r.replace(/^(?:\t| {1,2})/, "") : `  ${r}`));
  const before = rows.join("\n");
  const after = next.join("\n");
  // Already flush left. Still ours — Tab must not tab out of a list.
  if (after === before) return true;

  const head = next[0].length - rows[0].length;
  const total = after.length - before.length;
  edit(ta, first, last, after, [Math.max(first, start + head), Math.max(first, end + total)]);
  applyRenumber(ta);
  return true;
}

/* ── Wrapping and toggling ──────────────────────────────────── */

/** Typing one of these over a selection wraps it instead of replacing it. */
const WRAP_PAIRS: Record<string, string> = {
  "*": "*",
  _: "_",
  "`": "`",
  "~": "~",
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
};

const WORD_RE = /[\w'’-]/;

/** Grow a collapsed caret to the word it sits in, so ⌘B needs no selection. */
function wordAt(value: string, at: number): [number, number] {
  let a = at;
  let b = at;
  while (a > 0 && WORD_RE.test(value[a - 1])) a--;
  while (b < value.length && WORD_RE.test(value[b])) b++;
  return [a, b];
}

/** Toggle semantics: applying bold to bold text takes it off again. */
function toggleWrap(ctx: Ctx, open: string, close: string): void {
  const { ta, value } = ctx;
  let { start, end } = ctx;
  if (start === end) [start, end] = wordAt(value, start);

  const outside = value.slice(start - open.length, start) === open && value.slice(end, end + close.length) === close;
  if (outside) {
    const inner = value.slice(start, end);
    edit(ta, start - open.length, end + close.length, inner, [start - open.length, start - open.length + inner.length]);
    return;
  }
  const inside =
    end - start >= open.length + close.length &&
    value.slice(start, start + open.length) === open &&
    value.slice(end - close.length, end) === close;
  if (inside) {
    const inner = value.slice(start + open.length, end - close.length);
    edit(ta, start, end, inner, [start, start + inner.length]);
    return;
  }
  const body = value.slice(start, end);
  edit(ta, start, end, `${open}${body}${close}`, [start + open.length, start + open.length + body.length]);
}

/** ⌘⇧C: a fence when the selection spans lines, a code span when it does not. */
function toggleCode(ctx: Ctx): void {
  const { ta, value, start, end } = ctx;
  if (value.slice(start, end).includes("\n")) {
    const body = value.slice(start, end);
    edit(ta, start, end, "```\n" + body + "\n```", [start + 4, start + 4 + body.length]);
    return;
  }
  toggleWrap(ctx, "`", "`");
}

/* ═══════════════════════════════════════════════════════════════
   Paste
   ═══════════════════════════════════════════════════════════════ */

function isUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "TR", "FIGURE"]);

/**
 * A small, honest HTML → markdown converter.
 *
 * It knows headings, lists, links, emphasis, code, quotes, rules and tables.
 * Anything it does not recognise contributes its text and nothing else, which
 * is the right failure: a paste that loses formatting is a nuisance, a paste
 * that inserts angle brackets into someone's charter is a bug.
 */
function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walk = (node: Node, depth: number): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const kids = () =>
      Array.from(el.childNodes)
        .map((c) => walk(c, depth))
        .join("");

    switch (el.tagName) {
      case "BR":
        return "\n";
      case "HR":
        return "\n---\n";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return `\n\n${"#".repeat(Number(el.tagName[1]))} ${kids().trim()}\n\n`;
      case "STRONG":
      case "B": {
        const t = kids().trim();
        return t ? `**${t}**` : "";
      }
      case "EM":
      case "I": {
        const t = kids().trim();
        return t ? `*${t}*` : "";
      }
      case "S":
      case "DEL": {
        const t = kids().trim();
        return t ? `~~${t}~~` : "";
      }
      case "CODE":
        return el.closest("pre") ? kids() : `\`${(el.textContent ?? "").trim()}\``;
      case "PRE":
        return `\n\n\`\`\`\n${(el.textContent ?? "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
      case "A": {
        const href = el.getAttribute("href") ?? "";
        const t = kids().trim();
        if (!t) return "";
        return href && !href.startsWith("#") ? `[${t}](${href})` : t;
      }
      case "IMG": {
        const src = el.getAttribute("src") ?? "";
        return src.startsWith("data:") ? "" : `![${el.getAttribute("alt") ?? ""}](${src})`;
      }
      case "BLOCKQUOTE":
        return `\n\n${kids().trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
      case "UL":
      case "OL": {
        const items = Array.from(el.children).filter((c) => c.tagName === "LI");
        const pad = "  ".repeat(depth);
        const rows = items.map((li, i) => {
          const bullet = el.tagName === "OL" ? `${i + 1}.` : "-";
          const inner = Array.from(li.childNodes)
            .map((c) => walk(c, depth + 1))
            .join("")
            .trim();
          return `${pad}${bullet} ${inner}`;
        });
        return `\n${rows.join("\n")}\n`;
      }
      case "TABLE": {
        const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
          `| ${Array.from(tr.children).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ")} |`
        );
        if (!rows.length) return "";
        const cols = (rows[0].match(/\|/g) ?? []).length - 1;
        rows.splice(1, 0, `|${" --- |".repeat(Math.max(1, cols))}`);
        return `\n\n${rows.join("\n")}\n\n`;
      }
      default:
        return BLOCK_TAGS.has(el.tagName) ? `\n${kids()}\n` : kids();
    }
  };

  return walk(doc.body, 0)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

/* ═══════════════════════════════════════════════════════════════
   Autocomplete
   ═══════════════════════════════════════════════════════════════ */

type TriggerKind = "wiki" | "at" | "hash" | "slash";

interface Trigger {
  kind: TriggerKind;
  /** Where the trigger's first character sits, so the whole token is replaced. */
  start: number;
  query: string;
}

/** Kinds worth listing before anyone has typed. Messages earn their place. */
const BROWSE: EntityType[] = ["task", "memory", "channel", "agent", "team", "project"];

function triggerAt(text: string, caret: number): Trigger | null {
  if (caret < 1) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);

  const slash = /^\/([a-z]*)$/.exec(line);
  if (slash) return { kind: "slash", start: lineStart, query: slash[1] };

  const wiki = /\[\[([^\]\n]*)$/.exec(line);
  if (wiki) return { kind: "wiki", start: lineStart + wiki.index, query: wiki[1] };

  const at = /(^|[\s([{])@([a-z0-9-]*)$/i.exec(line);
  if (at) return { kind: "at", start: lineStart + at.index + at[1].length, query: at[2] };

  // One character minimum, or the popover would open on every heading.
  const hash = /(^|[\s([{])#([a-z0-9-]+)$/i.exec(line);
  if (hash) return { kind: "hash", start: lineStart + hash.index + hash[1].length, query: hash[2] };

  return null;
}

/**
 * The token an entity is referenced by.
 *
 * These are exactly the forms `autoLinkMessage` in links.ts parses. Picking a
 * channel out of a `[[` search still writes `#name`, because a `[[#name]]`
 * would look like a link and create no edge, and a reference that draws no
 * edge is the whole feature failing quietly.
 */
function tokenFor(info: EntityInfo): string {
  switch (info.ref.type) {
    case "channel":
      return info.title.startsWith("#") ? info.title : `#${info.title}`;
    case "agent":
    case "team":
      return `@${slug(info.title)}`;
    case "pr":
    case "issue":
    case "repo":
      return info.title;
    default:
      return `[[${info.title}]]`;
  }
}

interface Choice {
  key: string;
  title: string;
  detail: string;
  glyph: string;
  tone: string;
  /** Replacement text, and where the caret should end up inside it. */
  text: string;
  caret: number;
}

/**
 * Structure insertion for people who do not know the syntax yet. Secondary by
 * design: everything here is also a keystroke or three characters of markdown,
 * and nothing in this editor is reachable *only* from this menu.
 */
const SNIPPETS: { name: string; detail: string; text: string; caret: number }[] = [
  { name: "heading", detail: "Section title", text: "## ", caret: 3 },
  { name: "list", detail: "Bulleted list", text: "- ", caret: 2 },
  { name: "numbered", detail: "Numbered list", text: "1. ", caret: 3 },
  { name: "todo", detail: "Checklist item", text: "- [ ] ", caret: 6 },
  { name: "quote", detail: "Block quote", text: "> ", caret: 2 },
  { name: "code", detail: "Code block", text: "```\n\n```", caret: 4 },
  { name: "table", detail: "Two-column table", text: "| Column | Column |\n| --- | --- |\n|  |  |", caret: 2 },
  { name: "divider", detail: "Horizontal rule", text: "---\n", caret: 4 },
];

function choicesFor(trigger: Trigger, projectId?: string): Choice[] {
  if (trigger.kind === "slash") {
    const q = trigger.query.toLowerCase();
    return SNIPPETS.filter((s) => !q || s.name.startsWith(q)).map((s) => ({
      key: s.name,
      title: `/${s.name}`,
      detail: s.detail,
      glyph: "",
      tone: "var(--text-faint)",
      text: s.text,
      caret: s.caret,
    }));
  }

  const types: EntityType[] | undefined =
    trigger.kind === "at" ? ["agent", "team"]
    : trigger.kind === "hash" ? ["channel"]
    : trigger.query.trim() ? undefined
    : BROWSE;

  return searchEntities(trigger.query, { types, projectId, limit: 8 }).map((info) => {
    const text = tokenFor(info);
    return {
      key: `${info.ref.type}:${info.ref.id}`,
      title: info.title,
      detail: info.subtitle,
      glyph: info.glyph,
      tone: info.tone,
      text,
      caret: text.length,
    };
  });
}

/* ═══════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════ */

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  autoFocus?: boolean;
  /** Scopes `[[` search to one project, exactly as the link picker does. */
  projectId?: string;
  /** ⌘Enter. Absent means ⌘Enter does nothing rather than something surprising. */
  onSubmit?: () => void;
  className?: string;
  ariaLabel?: string;
}

/** Past this, the live layer stops parsing and just mirrors the text. */
const PARSE_CEILING = 80_000;

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  minRows = 3,
  maxRows = 20,
  autoFocus,
  projectId,
  onSubmit,
  className,
  ariaLabel,
}: MarkdownEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const [caret, setCaret] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState("");

  const plain = value.length > PARSE_CEILING;
  const lines = useMemo(() => (plain ? [] : parseDoc(value)), [value, plain]);

  /** Which lines the selection touches — those show their syntax at full strength. */
  const [firstActive, lastActive] = useMemo(() => {
    if (!focused) return [-1, -1];
    const upto = (at: number) => {
      let n = 0;
      for (let i = 0; i < at && i < value.length; i++) if (value[i] === "\n") n++;
      return n;
    };
    return [upto(caret[0]), upto(caret[1])];
  }, [focused, caret, value]);

  const trigger = useMemo(() => {
    if (!focused || caret[0] !== caret[1]) return null;
    const t = triggerAt(value, caret[0]);
    if (!t) return null;
    return `${t.kind}:${t.start}` === dismissed ? null : t;
  }, [focused, caret, value, dismissed]);

  const choices = useMemo(() => (trigger ? choicesFor(trigger, projectId) : []), [trigger, projectId]);
  const active = choices.length ? Math.min(sel, choices.length - 1) : -1;
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : "";
  useEffect(() => {
    setSel(0);
  }, [triggerKey]);

  /* ── Geometry ──────────────────────────────────────────────
     The layer has to be exactly as wide as the textarea's content box, which
     is narrower than the element as soon as a scrollbar appears — and the
     scrollbars here are 11px of real layout, not an overlay. */
  const measure = useCallback(() => {
    const ta = taRef.current;
    const layer = layerRef.current;
    if (!ta || !layer) return;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 20;
    const chrome =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);

    ta.style.height = "auto";
    const wanted = ta.scrollHeight + borders;
    const height = Math.min(lh * maxRows + chrome, Math.max(lh * minRows + chrome, wanted));
    ta.style.height = `${height}px`;
    ta.style.overflowY = wanted > height ? "auto" : "hidden";
    layer.style.width = `${ta.clientWidth}px`;
    layer.scrollTop = ta.scrollTop;
  }, [maxRows, minRows]);

  useLayoutEffect(measure, [measure, value]);

  const lastWidth = useRef(0);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      // Width is the only thing worth re-measuring for. The height changes
      // because `measure` just changed it, and reacting to that would leave
      // the observer feeding itself.
      const w = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(w - lastWidth.current) < 0.5) return;
      lastWidth.current = w;
      measure();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [measure]);

  // selectionchange is the only event that fires for every way a caret moves —
  // arrows, clicks, ⌘←, an OS text service. onSelect misses most of them.
  useEffect(() => {
    const read = () => {
      const ta = taRef.current;
      if (!ta || document.activeElement !== ta) return;
      setCaret([ta.selectionStart, ta.selectionEnd]);
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);

  const ctx = (): Ctx | null => {
    const ta = taRef.current;
    if (!ta) return null;
    return { ta, value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  };

  const accept = useCallback(
    (choice: Choice) => {
      const ta = taRef.current;
      if (!ta || !trigger) return;
      const at = ta.selectionStart;
      edit(ta, trigger.start, at, choice.text, [
        trigger.start + choice.caret,
        trigger.start + choice.caret,
      ]);
      setCaret([ta.selectionStart, ta.selectionEnd]);
      setDismissed("");
    },
    [trigger]
  );

  /* ── Link, which may have to wait on the clipboard ───────── */

  async function linkify(): Promise<void> {
    const c = ctx();
    if (!c) return;
    const { ta, value: text, start, end } = c;
    const picked = text.slice(start, end);

    let url = "";
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (isUrl(clip)) url = clip;
    } catch {
      // Reading the clipboard can be refused; the placeholder path still works.
    }
    if (ta.value !== text) return; // they kept typing while we asked

    if (isUrl(picked)) {
      edit(ta, start, end, `[](${picked})`, [start + 1, start + 1]);
      return;
    }
    if (url) {
      edit(ta, start, end, `[${picked}](${url})`, [
        start + 1 + picked.length + 2 + url.length + 1,
        start + 1 + picked.length + 2 + url.length + 1,
      ]);
      return;
    }
    // No URL anywhere: leave the caret in the slot they still have to fill.
    edit(ta, start, end, `[${picked}]()`, [start + picked.length + 3, start + picked.length + 3]);
  }

  /* ── Keys ──────────────────────────────────────────────────── */

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const c = ctx();
    if (!c) return;
    const accel = e.metaKey || e.ctrlKey;

    if (trigger && choices.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((active + 1) % choices.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((active - 1 + choices.length) % choices.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(choices[Math.max(0, active)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(triggerKey);
        return;
      }
    }

    if (accel && e.key === "Enter") {
      if (!onSubmit) return;
      e.preventDefault();
      onSubmit();
      return;
    }

    if (accel && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleWrap(c, "**", "**");
        return;
      }
      if (key === "i" && !e.shiftKey) {
        e.preventDefault();
        toggleWrap(c, "*", "*");
        return;
      }
      if (key === "c" && e.shiftKey) {
        e.preventDefault();
        toggleCode(c);
        return;
      }
      if (key === "k" && !e.shiftKey) {
        // The palette owns ⌘K everywhere else; inside a text field it is the
        // link key, and the whole app agrees that fields win over chrome.
        e.preventDefault();
        e.stopPropagation();
        void linkify();
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !accel) {
      if (onEnter(c)) e.preventDefault();
      return;
    }

    if (e.key === "Tab" && !accel) {
      if (onTab(c, e.shiftKey)) e.preventDefault();
      return;
    }

    // Wrapping a selection instead of destroying it.
    const close = WRAP_PAIRS[e.key];
    if (close && !accel && !e.altKey && c.end > c.start) {
      e.preventDefault();
      const body = c.value.slice(c.start, c.end);
      edit(c.ta, c.start, c.end, `${e.key}${body}${close}`, [c.start + 1, c.start + 1 + body.length]);
    }
  }

  function onPaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const c = ctx();
    if (!c || !e.clipboardData) return;
    const text = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");

    if (isUrl(text) && c.end > c.start) {
      e.preventDefault();
      const body = c.value.slice(c.start, c.end);
      const out = `[${body}](${text.trim()})`;
      edit(c.ta, c.start, c.end, out, [c.start + out.length, c.start + out.length]);
      return;
    }
    if (!html) return;

    const md = htmlToMarkdown(html);
    // Copying plain text still puts HTML on the clipboard; only take over when
    // the conversion actually recovered structure the text form had lost.
    if (!md || md.replace(/\s+/g, " ").trim() === text.replace(/\s+/g, " ").trim()) return;
    e.preventDefault();
    edit(c.ta, c.start, c.end, md);
  }

  /* ── Render ────────────────────────────────────────────────── */

  const showPlaceholder = !value && !!placeholder;

  return (
    <div className={"mde" + (className ? ` ${className}` : "")}>
      <div className="mde-layer" ref={layerRef} aria-hidden="true">
        {showPlaceholder ? (
          <div className="mde-ln mde-ph">{placeholder}</div>
        ) : plain ? (
          value.split("\n").map((raw, i) => (
            <div className="mde-ln" key={i}>
              <span className="mde-src">{raw}</span>
            </div>
          ))
        ) : (
          lines.map((line, i) => (
            <Line key={i} line={line} index={i} active={i >= firstActive && i <= lastActive} />
          ))
        )}
      </div>

      <textarea
        ref={taRef}
        className="mde-input"
        value={value}
        rows={minRows}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        role={trigger && choices.length ? "combobox" : undefined}
        aria-expanded={trigger && choices.length ? true : undefined}
        aria-controls={trigger && choices.length ? listId : undefined}
        aria-activedescendant={active >= 0 && trigger ? `${listId}-o${active}` : undefined}
        aria-autocomplete={trigger && choices.length ? "list" : undefined}
        onChange={(e) => {
          setDismissed("");
          onChange(e.target.value);
          setCaret([e.target.selectionStart, e.target.selectionEnd]);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={(e) => {
          setFocused(true);
          setCaret([e.target.selectionStart, e.target.selectionEnd]);
        }}
        onBlur={() => setFocused(false)}
        onScroll={(e) => {
          const layer = layerRef.current;
          if (!layer) return;
          layer.scrollTop = e.currentTarget.scrollTop;
          layer.scrollLeft = e.currentTarget.scrollLeft;
        }}
      />

      {trigger && choices.length > 0 && (
        <div className="mde-pop" id={listId} role="listbox" aria-label="Insert a reference">
          {choices.map((choice, i) => (
            <div
              key={choice.key}
              id={`${listId}-o${i}`}
              role="option"
              aria-selected={i === active}
              className={"mde-opt" + (i === active ? " mde-opt-on" : "")}
              onMouseMove={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(choice);
              }}
            >
              {choice.glyph && (
                <span className="mde-opt-glyph" style={{ color: choice.tone }} aria-hidden="true">
                  {choice.glyph}
                </span>
              )}
              <span className="mde-opt-title">{choice.title}</span>
              {choice.detail && <span className="mde-opt-detail">{choice.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
