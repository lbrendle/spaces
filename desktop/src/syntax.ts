/**
 * A dependency-free syntax highlighter for code blocks in agent messages.
 *
 * `highlight(code, lang)` returns an HTML string built from
 * `<span class="tk-…">` tokens — kw, str, num, com, fn, ty, pn — which the
 * stylesheet maps onto the theme's --syn-* custom properties, so highlighting
 * follows whichever IDE theme is active without a single per-theme rule.
 *
 * Design notes:
 *  - Every language is scanned in ONE pass, character by character. A chain of
 *    regex `.replace()` calls over the whole source matches inside the markup
 *    it has already emitted (and inside strings and comments), which silently
 *    corrupts code; a scanner cannot.
 *  - Output is XSS-safe: every emitted character goes through `esc`, and no
 *    attribute is ever derived from input. Class names are literals.
 *  - The invariant that matters most: un-escaping the concatenated text of the
 *    output reproduces the input exactly. Leaving something uncoloured always
 *    beats dropping or duplicating a character, so each scanner falls back to
 *    plain text rather than guessing, and `highlight` itself is total — it
 *    never throws.
 */

export type TokenClass = "kw" | "str" | "num" | "com" | "fn" | "ty" | "pn";

/* ── output ────────────────────────────────────────────────── */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

class Out {
  private parts: string[] = [];
  /** Uncoloured source text. */
  text(s: string): void {
    if (s) this.parts.push(esc(s));
  }
  /** A coloured token. */
  tok(cls: TokenClass, s: string): void {
    if (s) this.parts.push(`<span class="tk-${cls}">${esc(s)}</span>`);
  }
  /** Already-escaped output from a nested highlight pass. */
  raw(html: string): void {
    if (html) this.parts.push(html);
  }
  toString(): string {
    return this.parts.join("");
  }
}

/* ── character classes ─────────────────────────────────────── */

const WS = /\s/;
const PUNCT = "!#%&()*+,-./:;<=>?@[\\]^{|}~";

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

/** Anything above ASCII counts as an identifier char so surrogate pairs and
 *  accented names stay in one token instead of being split apart. */
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c >= "\u0080";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

function isPunct(c: string): boolean {
  return c.length === 1 && PUNCT.indexOf(c) >= 0;
}

function words(list: string): Set<string> {
  return new Set(list.trim().split(/\s+/));
}

/* ── shared scanners ───────────────────────────────────────── */

/** End of a numeric literal starting at `i` (hex/bin/oct, float, exponent,
 *  digit separators and trailing suffixes like `u64` or `n`). */
function numberEnd(src: string, i: number): number {
  const n = src.length;
  let j = i;
  const two = src.slice(i, i + 2).toLowerCase();
  if (src[i] === "0" && (two === "0x" || two === "0b" || two === "0o")) {
    j = i + 2;
    while (j < n && (isHex(src[j]) || src[j] === "_")) j++;
  } else {
    if (src[j] === ".") j++;
    while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
    if (src[i] !== "." && src[j] === "." && isDigit(src[j + 1])) {
      j++;
      while (j < n && (isDigit(src[j]) || src[j] === "_")) j++;
    }
    if (src[j] === "e" || src[j] === "E") {
      let k = j + 1;
      if (src[k] === "+" || src[k] === "-") k++;
      if (isDigit(src[k])) {
        while (k < n && (isDigit(src[k]) || src[k] === "_")) k++;
        j = k;
      }
    }
  }
  while (j < n && isIdentPart(src[j])) j++;
  return j;
}

/** End of a simple quoted string (backslash escapes, never crosses a line). */
function plainStringEnd(src: string, i: number, quote: string): number {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === "\n") return j;
    j++;
  }
  return n;
}

/** Index just past the `}` matching the `{` at `i`. */
function braceEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return src.length;
}

/** Walk `src` line by line, re-emitting the newlines verbatim. */
function eachLine(src: string, out: Out, fn: (line: string) => void): void {
  const n = src.length;
  let i = 0;
  while (i < n) {
    let e = src.indexOf("\n", i);
    if (e < 0) e = n;
    fn(src.slice(i, e));
    if (e < n) out.text("\n");
    i = e + 1;
  }
}

/* ── language specs ────────────────────────────────────────── */

interface StringRule {
  open: string;
  /** Defaults to `open`. */
  close?: string;
  escapes: boolean;
  multiline: boolean;
  /** Opening delimiter of an embedded expression, e.g. "${" — closed by "}". */
  interp?: string;
  /** Defaults to "str" (SQL uses "ty" for quoted identifiers). */
  cls?: TokenClass;
}

interface LangSpec {
  lineComments: string[];
  /** `#` only opens a comment at a word boundary (shell). */
  guardLineComment?: boolean;
  blockComment?: [string, string];
  nestedBlockComment?: boolean;
  strings: StringRule[];
  keywords: Set<string>;
  types: Set<string>;
  caseInsensitive?: boolean;
  /** String prefixes such as Python's f/r/b or Rust's r/b. */
  prefixes?: Set<string>;
  /** Rust-style `r#"…"#` raw strings. */
  rawHash?: boolean;
  /** Single-quoted char/rune literals rather than strings. */
  charLiterals?: boolean;
  /** JS-style `/…/flags` regex literals. */
  regex?: boolean;
  /** Rust-style `name!(…)` macro calls. */
  macroBang?: boolean;
  /** Leading char that colours the identifier after it, e.g. `$var`, `@ivar`. */
  sigils?: Record<string, TokenClass>;
  /** The first word of a command is a function name (shell). */
  commandWords?: boolean;
  /** A string followed by `:` is an object key (JSON). */
  jsonKeys?: boolean;
}

/** Shell words after which the next word is again a command name. */
const CMD_RESET = words("if then else elif do while until time function not");

const JS: LangSpec = {
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [
    { open: '"', escapes: true, multiline: false },
    { open: "'", escapes: true, multiline: false },
    { open: "`", escapes: true, multiline: true, interp: "${" },
  ],
  keywords: words(`
    abstract accessor as asserts async await break case catch class const constructor continue
    debugger declare default delete do else enum export extends false finally for from function
    get if implements import in infer instanceof interface is keyof let module namespace new null
    of override package private protected public readonly return satisfies set static super switch
    this throw true try type typeof undefined var void while with yield
  `),
  types: words(`
    any bigint boolean never number object string symbol unknown Array ArrayBuffer BigInt Boolean
    Date Error Function JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol
    WeakMap WeakSet Record Partial Readonly Pick Omit Awaited Iterable Iterator
  `),
  regex: true,
};

const PYTHON: LangSpec = {
  lineComments: ["#"],
  strings: [
    { open: '"""', escapes: true, multiline: true },
    { open: "'''", escapes: true, multiline: true },
    { open: '"', escapes: true, multiline: false },
    { open: "'", escapes: true, multiline: false },
  ],
  keywords: words(`
    and as assert async await break class cls continue def del elif else except False finally for
    from global if import in is lambda match None nonlocal not or pass raise return self True try
    while with yield
  `),
  types: words(`
    bool bytearray bytes complex dict float frozenset int list object set str tuple type Any
    Callable Dict Iterable Iterator List Literal Mapping Optional Sequence Tuple Union
  `),
  prefixes: words("r b u f rb br fr rf"),
  sigils: { "@": "ty" },
};

const RUST: LangSpec = {
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  nestedBlockComment: true,
  strings: [{ open: '"', escapes: true, multiline: true }],
  keywords: words(`
    as async await break const continue crate dyn else enum extern false fn for if impl in let
    loop macro_rules match mod move mut pub ref return self Self static struct super trait true
    type union unsafe use where while
  `),
  types: words(`
    bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option
    Result Box Rc Arc Cell RefCell HashMap HashSet BTreeMap Cow Path PathBuf
  `),
  prefixes: words("r b br rb"),
  rawHash: true,
  charLiterals: true,
  macroBang: true,
};

const GO: LangSpec = {
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [
    { open: '"', escapes: true, multiline: false },
    { open: "`", escapes: false, multiline: true },
  ],
  keywords: words(`
    break case chan const continue default defer else fallthrough false for func go goto if import
    interface iota map nil package range return select struct switch true type var
  `),
  types: words(`
    any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
    uint uint8 uint16 uint32 uint64 uintptr
  `),
  charLiterals: true,
};

const JAVA: LangSpec = {
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [{ open: '"', escapes: true, multiline: false }],
  keywords: words(`
    abstract assert break case catch class const continue default do else enum extends final
    finally for goto if implements import instanceof interface native new package permits private
    protected public record return sealed static strictfp super switch synchronized this throw
    throws transient true false null try var volatile while yield
  `),
  types: words(`
    boolean byte char double float int long short void Boolean Byte Character Double Float Integer
    Long Object Short String List Map Set Optional Stream
  `),
  charLiterals: true,
  sigils: { "@": "ty" },
};

const RUBY: LangSpec = {
  lineComments: ["#"],
  strings: [
    { open: '"', escapes: true, multiline: false, interp: "#{" },
    { open: "'", escapes: true, multiline: false },
    { open: "`", escapes: true, multiline: false, interp: "#{" },
  ],
  keywords: words(`
    alias and begin break case class def defined? do else elsif end ensure false for if in module
    next nil not or redo require require_relative rescue retry return self super then true undef
    unless until when while yield
  `),
  types: words("Array Comparable Enumerable Float Hash Integer Numeric Range String Struct Symbol Time"),
  sigils: { "@": "ty", $: "ty", ":": "ty" },
};

const BASH: LangSpec = {
  lineComments: ["#"],
  guardLineComment: true,
  strings: [
    { open: '"', escapes: true, multiline: false },
    { open: "'", escapes: false, multiline: false },
    { open: "`", escapes: true, multiline: false },
  ],
  keywords: words(`
    alias break case continue declare do done elif else esac eval exec exit export fi for function
    if in local readonly return select set shift source then time trap typeset unset until while
  `),
  types: new Set<string>(),
  sigils: { $: "ty" },
  commandWords: true,
};

const SQL: LangSpec = {
  lineComments: ["--"],
  blockComment: ["/*", "*/"],
  strings: [
    { open: "'", escapes: false, multiline: false },
    { open: '"', escapes: false, multiline: false, cls: "ty" },
  ],
  keywords: words(`
    add all alter and any as asc begin between by cascade case check column commit constraint
    create cross default delete desc distinct drop else end exists false foreign from full grant
    group having if in index inner insert into is join key left like limit not null offset on or
    order outer primary references returning revoke right rollback select set table then
    transaction true union unique update using values view when where with
  `),
  types: words(`
    bigint bigserial boolean bool bytea char date decimal double float int integer json jsonb
    numeric precision real serial smallint text time timestamp timestamptz uuid varchar
  `),
  caseInsensitive: true,
};

const JSON_SPEC: LangSpec = {
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [{ open: '"', escapes: true, multiline: false }],
  keywords: words("true false null"),
  types: new Set<string>(),
  jsonKeys: true,
};

const SPECS: Record<string, LangSpec> = {
  ts: JS,
  python: PYTHON,
  rust: RUST,
  go: GO,
  java: JAVA,
  ruby: RUBY,
  bash: BASH,
  sql: SQL,
  json: JSON_SPEC,
};

/* ── generic scanner ───────────────────────────────────────── */

function lineCommentAt(src: string, i: number, spec: LangSpec): boolean {
  for (const lc of spec.lineComments) {
    if (!src.startsWith(lc, i)) continue;
    if (spec.guardLineComment && i > 0 && !/[\s;|&({]/.test(src[i - 1])) continue;
    return true;
  }
  return false;
}

function stringRuleAt(src: string, i: number, spec: LangSpec): StringRule | null {
  for (const rule of spec.strings) if (src.startsWith(rule.open, i)) return rule;
  return null;
}

/** A prefixed string literal (`f"…"`, `r#"…"#`) starting at the prefix. */
function prefixedString(src: string, i: number, word: string, spec: LangSpec): StringRule | null {
  const k = i + word.length;
  const lower = word.toLowerCase();
  if (spec.rawHash && (lower === "r" || lower === "br" || lower === "rb")) {
    let h = k;
    while (src[h] === "#") h++;
    if (src[h] === '"') {
      return {
        open: src.slice(i, h + 1),
        close: '"' + "#".repeat(h - k),
        escapes: false,
        multiline: true,
      };
    }
  }
  const rule = stringRuleAt(src, k, spec);
  if (!rule) return null;
  return {
    ...rule,
    close: rule.close ?? rule.open,
    open: word + rule.open,
    escapes: rule.escapes && !lower.includes("r"),
    interp: undefined,
  };
}

/** End of a char/rune literal at `i`, or -1 when it is not one (a lifetime). */
function charLiteralEnd(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  if (src[j] === "\\") {
    j++;
    if (src[j] === "u" && src[j + 1] === "{") {
      j = braceEnd(src, j + 1);
    } else {
      j++;
      while (j < n && isHex(src[j]) && j - i < 10) j++;
    }
  } else if (j < n && src[j] !== "\n") {
    const code = src.charCodeAt(j);
    j += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return src[j] === "'" ? j + 1 : -1;
}

/** End of a regex literal at `i`, or -1. Bounded to one line so a mistaken
 *  guess can never swallow the rest of the block. */
function regexEnd(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === "\n") return -1;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

function scanBlockComment(src: string, i: number, spec: LangSpec, out: Out): number {
  const [open, close] = spec.blockComment as [string, string];
  let j = i + open.length;
  let depth = 1;
  while (j < src.length) {
    if (spec.nestedBlockComment && src.startsWith(open, j)) {
      depth++;
      j += open.length;
      continue;
    }
    if (src.startsWith(close, j)) {
      depth--;
      j += close.length;
      if (depth === 0) break;
      continue;
    }
    j++;
  }
  out.tok("com", src.slice(i, j));
  return j;
}

function scanString(src: string, i: number, rule: StringRule, spec: LangSpec, out: Out): number {
  const n = src.length;
  const close = rule.close ?? rule.open;
  const cls = rule.cls ?? "str";
  let j = i + rule.open.length;
  let buf = rule.open;
  const flush = () => {
    out.tok(cls, buf);
    buf = "";
  };
  while (j < n) {
    const c = src[j];
    if (rule.escapes && c === "\\" && j + 1 < n) {
      buf += src.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (!rule.multiline && c === "\n") break;
    if (rule.interp && src.startsWith(rule.interp, j)) {
      flush();
      out.tok("pn", rule.interp);
      j = scanGeneric(src, spec, out, j + rule.interp.length, true);
      if (src[j] === "}") {
        out.tok("pn", "}");
        j++;
      }
      continue;
    }
    if (src.startsWith(close, j)) {
      buf += close;
      j += close.length;
      flush();
      return j;
    }
    buf += c;
    j++;
  }
  flush();
  return j;
}

/**
 * Scan `src` from `from`. With `stopAtBrace` the scan returns at the `}` that
 * closes an interpolation (leaving it unconsumed) instead of at end of input.
 */
function scanGeneric(src: string, spec: LangSpec, out: Out, from: number, stopAtBrace: boolean): number {
  const n = src.length;
  let i = from;
  let depth = 0;
  /** Whether the previous token can end an expression — decides `/` division vs regex. */
  let value = false;
  /** Shell: the next word starts a command. */
  let cmd = true;

  while (i < n) {
    const c = src[i];

    if (WS.test(c)) {
      let j = i;
      while (j < n && WS.test(src[j])) j++;
      const run = src.slice(i, j);
      if (run.indexOf("\n") >= 0) cmd = true;
      out.text(run);
      i = j;
      continue;
    }

    if (lineCommentAt(src, i, spec)) {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      out.tok("com", src.slice(i, j));
      i = j;
      value = false;
      continue;
    }

    if (spec.blockComment && src.startsWith(spec.blockComment[0], i)) {
      i = scanBlockComment(src, i, spec, out);
      value = false;
      continue;
    }

    if (spec.jsonKeys && c === '"') {
      const e = plainStringEnd(src, i, '"');
      let k = e;
      while (k < n && WS.test(src[k])) k++;
      out.tok(src[k] === ":" ? "ty" : "str", src.slice(i, e));
      i = e;
      value = true;
      continue;
    }

    const rule = stringRuleAt(src, i, spec);
    if (rule) {
      i = scanString(src, i, rule, spec, out);
      value = true;
      cmd = false;
      continue;
    }

    if (spec.charLiterals && c === "'") {
      const e = charLiteralEnd(src, i);
      if (e > 0) {
        out.tok("str", src.slice(i, e));
        i = e;
        value = true;
        cmd = false;
        continue;
      }
    }

    if (spec.regex && c === "/" && !value) {
      const e = regexEnd(src, i);
      if (e > 0) {
        out.tok("str", src.slice(i, e));
        i = e;
        value = true;
        continue;
      }
    }

    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const e = numberEnd(src, i);
      out.tok("num", src.slice(i, e));
      i = e;
      value = true;
      cmd = false;
      continue;
    }

    const sigil = spec.sigils && spec.sigils[c];
    if (sigil) {
      let j = i + 1;
      if (c === "@") while (src[j] === "@") j++;
      const symbolish = c !== ":" || (!isIdentPart(src[i - 1] ?? " ") && src[i - 1] !== ":" && src[j] !== ":");
      if (symbolish && c === "$" && src[j] === "{") {
        const e = braceEnd(src, j);
        out.tok(sigil, src.slice(i, e));
        i = e;
        value = true;
        cmd = false;
        continue;
      }
      if (symbolish && isIdentStart(src[j])) {
        let k = j;
        while (k < n && isIdentPart(src[k])) k++;
        out.tok(sigil, src.slice(i, k));
        i = k;
        value = true;
        cmd = false;
        continue;
      }
      if (symbolish && c === "$" && j < n && "0123456789@?*#!$_-".indexOf(src[j]) >= 0) {
        out.tok(sigil, src.slice(i, j + 1));
        i = j + 1;
        value = true;
        cmd = false;
        continue;
      }
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j])) j++;
      let word = src.slice(i, j);
      if (spec.keywords.has(word + "?") && src[j] === "?") {
        // Ruby predicate keywords such as `defined?`
        j++;
        word = src.slice(i, j);
      }
      if (spec.prefixes && spec.prefixes.has(word.toLowerCase())) {
        const pref = prefixedString(src, i, word, spec);
        if (pref) {
          i = scanString(src, i, pref, spec, out);
          value = true;
          cmd = false;
          continue;
        }
      }
      const key = spec.caseInsensitive ? word.toLowerCase() : word;
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      let cls: TokenClass | null = null;
      if (spec.keywords.has(key)) cls = "kw";
      else if (spec.types.has(key)) cls = "ty";
      else if (spec.commandWords && cmd && src[j] !== "=") cls = "fn";
      else if (spec.macroBang && src[k] === "!" && (src[k + 1] === "(" || src[k + 1] === "[" || src[k + 1] === "{"))
        cls = "fn";
      else if (src[k] === "(") cls = "fn";
      else if (word.length > 1 && word[0] >= "A" && word[0] <= "Z") cls = "ty";
      if (cls) out.tok(cls, word);
      else out.text(word);
      value = cls !== "kw";
      if (spec.commandWords) cmd = CMD_RESET.has(key);
      i = j;
      continue;
    }

    if (isPunct(c)) {
      if (c === "}" && stopAtBrace && depth === 0) return i;
      let j = i;
      while (j < n && isPunct(src[j])) {
        const p = src[j];
        if (j > i) {
          if (lineCommentAt(src, j, spec)) break;
          if (spec.blockComment && src.startsWith(spec.blockComment[0], j)) break;
          if (spec.regex && p === "/") break;
          if (spec.sigils && spec.sigils[p]) break;
        }
        if (p === "{") depth++;
        else if (p === "}") {
          if (stopAtBrace && depth === 0) break;
          depth--;
        }
        j++;
      }
      const run = src.slice(i, j);
      out.tok("pn", run);
      if (spec.commandWords && /[;|&(]/.test(run)) cmd = true;
      value = run.endsWith(")") || run.endsWith("]");
      i = j;
      continue;
    }

    out.text(c);
    i++;
  }
  return i;
}

/* ── JSON, HTML, CSS ───────────────────────────────────────── */

function scanHtml(src: string, out: Out): void {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out.text(src.slice(i));
      return;
    }
    if (lt > i) {
      out.text(src.slice(i, lt));
      i = lt;
    }
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i);
      const e = close < 0 ? n : close + 3;
      out.tok("com", src.slice(i, e));
      i = e;
      continue;
    }
    if (!/[A-Za-z/!?]/.test(src[i + 1] ?? "")) {
      out.text("<");
      i++;
      continue;
    }
    i = scanTag(src, i, out);
  }
}

function scanTag(src: string, i: number, out: Out): number {
  const n = src.length;
  let j = i + 1;
  let lead = "<";
  if (src[j] === "/" || src[j] === "!" || src[j] === "?") {
    lead += src[j];
    j++;
  }
  out.tok("pn", lead);
  let k = j;
  while (k < n && /[A-Za-z0-9_:.-]/.test(src[k])) k++;
  out.tok("kw", src.slice(j, k));
  j = k;
  while (j < n) {
    const c = src[j];
    if (WS.test(c)) {
      let e = j;
      while (e < n && WS.test(src[e])) e++;
      out.text(src.slice(j, e));
      j = e;
      continue;
    }
    if (c === ">") {
      out.tok("pn", ">");
      return j + 1;
    }
    if (c === "/" && src[j + 1] === ">") {
      out.tok("pn", "/>");
      return j + 2;
    }
    if (c === "=") {
      out.tok("pn", "=");
      j++;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = plainStringEnd(src, j, c);
      out.tok("str", src.slice(j, e));
      j = e;
      continue;
    }
    if (c === "<") return j; // malformed — let the outer loop re-sync
    let e = j;
    while (
      e < n &&
      !WS.test(src[e]) &&
      src[e] !== "=" &&
      src[e] !== ">" &&
      src[e] !== "<" &&
      src[e] !== '"' &&
      src[e] !== "'" &&
      !(src[e] === "/" && src[e + 1] === ">")
    )
      e++;
    if (e === j) {
      out.text(src[j]);
      j++;
      continue;
    }
    out.tok("ty", src.slice(j, e));
    j = e;
  }
  return n;
}

function scanCss(src: string, out: Out): void {
  const n = src.length;
  let i = 0;
  let depth = 0;
  let expectProp = true;
  while (i < n) {
    const c = src[i];
    if (WS.test(c)) {
      let j = i;
      while (j < n && WS.test(src[j])) j++;
      out.text(src.slice(i, j));
      i = j;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const close = src.indexOf("*/", i + 2);
      const e = close < 0 ? n : close + 2;
      out.tok("com", src.slice(i, e));
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = plainStringEnd(src, i, c);
      out.tok("str", src.slice(i, e));
      i = e;
      continue;
    }
    if (c === "@" && isIdentStart(src[i + 1])) {
      let j = i + 1;
      while (j < n && (isIdentPart(src[j]) || src[j] === "-")) j++;
      out.tok("kw", src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "!" && /^!\s*important/i.test(src.slice(i, i + 12))) {
      const m = /^!\s*important/i.exec(src.slice(i, i + 12));
      const len = m ? m[0].length : 1;
      out.tok("kw", src.slice(i, i + len));
      i += len;
      continue;
    }
    if (c === "#") {
      let j = i + 1;
      while (j < n && (isIdentPart(src[j]) || src[j] === "-")) j++;
      if (j === i + 1) out.tok("pn", "#");
      else out.tok(depth > 0 ? "num" : "ty", src.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      let e = numberEnd(src, i);
      if (src[e] === "%") e++;
      out.tok("num", src.slice(i, e));
      i = e;
      continue;
    }
    if (c === "." && depth === 0 && isIdentStart(src[i + 1])) {
      let j = i + 1;
      while (j < n && (isIdentPart(src[j]) || src[j] === "-")) j++;
      out.tok("ty", src.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(c) || (c === "-" && (isIdentStart(src[i + 1]) || src[i + 1] === "-"))) {
      let j = i;
      while (src[j] === "-") j++;
      while (j < n && (isIdentPart(src[j]) || src[j] === "-")) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === " " || src[k] === "\t")) k++;
      if (src[k] === "(") out.tok("fn", word);
      else if (word.startsWith("--")) out.tok("fn", word); // custom property, declared or read
      else if (depth === 0) out.tok("ty", word);
      else if (expectProp && src[k] === ":") out.tok("fn", word);
      else if (expectProp) out.tok("ty", word);
      else out.text(word);
      i = j;
      continue;
    }
    if (isPunct(c)) {
      if (c === "{") {
        depth++;
        expectProp = true;
      } else if (c === "}") {
        depth = Math.max(0, depth - 1);
        expectProp = true;
      } else if (c === ";") expectProp = true;
      else if (c === ":") expectProp = false;
      out.tok("pn", c);
      i++;
      continue;
    }
    out.text(c);
    i++;
  }
}

/* ── YAML, TOML, diff ──────────────────────────────────────── */

const YAML_CONSTS = words("true false yes no on off null nil none");
const TOML_CONSTS = words("true false inf nan");
const DATE_RE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?/;

/** Value side of a `key: value` / `key = value` line. */
function scanScalar(src: string, out: Out, consts: Set<string>): void {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t") {
      let j = i;
      while (j < n && (src[j] === " " || src[j] === "\t")) j++;
      out.text(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#" && (i === 0 || WS.test(src[i - 1]))) {
      out.tok("com", src.slice(i));
      return;
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const close = src.indexOf(triple, i + 3);
        const e = close < 0 ? n : close + 3;
        out.tok("str", src.slice(i, e));
        i = e;
        continue;
      }
      const e = plainStringEnd(src, i, c);
      out.tok("str", src.slice(i, e));
      i = e;
      continue;
    }
    if ((c === "&" || c === "*") && isIdentStart(src[i + 1])) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      out.tok("fn", src.slice(i, j));
      i = j;
      continue;
    }
    if (isDigit(c) || ((c === "-" || c === "+" || c === ".") && isDigit(src[i + 1]))) {
      const date = DATE_RE.exec(src.slice(i));
      if (date) {
        out.tok("num", date[0]);
        i += date[0].length;
        continue;
      }
      const e = numberEnd(src, c === "-" || c === "+" ? i + 1 : i);
      if (e >= n || /[\s,\]}]/.test(src[e])) {
        out.tok("num", src.slice(i, e));
        i = e;
        continue;
      }
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && (isIdentPart(src[j]) || src[j] === "-")) j++;
      const word = src.slice(i, j);
      if (consts.has(word.toLowerCase())) out.tok("kw", word);
      else out.text(word);
      i = j;
      continue;
    }
    if (isPunct(c)) {
      out.tok("pn", c);
      i++;
      continue;
    }
    out.text(c);
    i++;
  }
}

/** Emit `s` as `cls`, leaving any trailing whitespace uncoloured. */
function tokTrimmed(out: Out, cls: TokenClass, s: string): void {
  const body = s.replace(/\s+$/, "");
  out.tok(cls, body);
  out.text(s.slice(body.length));
}

/** Index of the `:` that terminates a YAML key, or -1. */
function yamlKeyEnd(s: string): number {
  if (!s) return -1;
  if (s[0] === '"' || s[0] === "'") {
    let k = plainStringEnd(s, 0, s[0]);
    while (s[k] === " ") k++;
    return s[k] === ":" && (k + 1 >= s.length || s[k + 1] === " ") ? k : -1;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "#" && i > 0 && s[i - 1] === " ") return -1;
    if (c === ":" && (i + 1 >= s.length || s[i + 1] === " " || s[i + 1] === "\t")) return i;
  }
  return -1;
}

function scanYaml(src: string, out: Out): void {
  eachLine(src, out, (line) => {
    let i = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    out.text(line.slice(0, i));
    const rest = line.slice(i);
    if (!rest) return;
    if (rest[0] === "#") {
      out.tok("com", rest);
      return;
    }
    if (rest === "---" || rest === "..." || rest.startsWith("--- ") || rest[0] === "%") {
      out.tok("pn", rest);
      return;
    }
    let p = 0;
    while (rest[p] === "-" && (p + 1 === rest.length || rest[p + 1] === " ")) {
      out.tok("pn", "-");
      p++;
      let q = p;
      while (rest[q] === " ") q++;
      out.text(rest.slice(p, q));
      p = q;
    }
    const body = rest.slice(p);
    const colon = yamlKeyEnd(body);
    if (colon >= 0) {
      tokTrimmed(out, "ty", body.slice(0, colon));
      out.tok("pn", ":");
      scanScalar(body.slice(colon + 1), out, YAML_CONSTS);
    } else {
      scanScalar(body, out, YAML_CONSTS);
    }
  });
}

/** Index of the `=` that terminates a TOML key, or -1. */
function tomlKeyEnd(s: string): number {
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") return -1;
    else if (c === "=") return i;
  }
  return -1;
}

function scanToml(src: string, out: Out): void {
  eachLine(src, out, (line) => {
    let i = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    out.text(line.slice(0, i));
    const rest = line.slice(i);
    if (!rest) return;
    if (rest[0] === "#") {
      out.tok("com", rest);
      return;
    }
    if (rest[0] === "[") {
      const close = rest.lastIndexOf("]");
      if (close > 0) {
        const open = rest[1] === "[" ? 2 : 1;
        const end = open === 2 && rest[close - 1] === "]" ? close - 1 : close;
        out.tok("pn", rest.slice(0, open));
        out.tok("ty", rest.slice(open, end));
        out.tok("pn", rest.slice(end, close + 1));
        scanScalar(rest.slice(close + 1), out, TOML_CONSTS);
        return;
      }
    }
    const eq = tomlKeyEnd(rest);
    if (eq >= 0) {
      tokTrimmed(out, "fn", rest.slice(0, eq));
      out.tok("pn", "=");
      scanScalar(rest.slice(eq + 1), out, TOML_CONSTS);
    } else {
      scanScalar(rest, out, TOML_CONSTS);
    }
  });
}

const DIFF_HEADER =
  /^(diff |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity index|rename |Binary files|@@)/;

function scanDiff(src: string, out: Out): void {
  eachLine(src, out, (line) => {
    if (!line) return;
    if (DIFF_HEADER.test(line)) out.tok("fn", line);
    else if (line[0] === "+") out.tok("str", line);
    else if (line[0] === "-") out.tok("kw", line);
    else out.tok("com", line);
  });
}

/* ── markdown ──────────────────────────────────────────────── */

function mdInline(s: string, out: Out): void {
  const n = s.length;
  let i = 0;
  let plain = "";
  const flush = () => {
    out.text(plain);
    plain = "";
  };
  while (i < n) {
    const c = s[i];
    if (c === "`") {
      let run = 0;
      while (s[i + run] === "`") run++;
      const marker = "`".repeat(run);
      const close = s.indexOf(marker, i + run);
      if (close > 0) {
        flush();
        out.tok("str", s.slice(i, close + run));
        i = close + run;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] === c) {
      const close = s.indexOf(c + c, i + 2);
      if (close > 0) {
        flush();
        out.tok("kw", s.slice(i, close + 2));
        i = close + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] && !WS.test(s[i + 1])) {
      const close = s.indexOf(c, i + 1);
      if (close > i + 1) {
        flush();
        out.tok("ty", s.slice(i, close + 1));
        i = close + 1;
        continue;
      }
    }
    if (c === "[") {
      const rb = s.indexOf("]", i);
      if (rb > 0 && s[rb + 1] === "(") {
        const rp = s.indexOf(")", rb + 2);
        if (rp > 0) {
          flush();
          out.tok("pn", "[");
          out.text(s.slice(i + 1, rb));
          out.tok("pn", "](");
          out.tok("str", s.slice(rb + 2, rp));
          out.tok("pn", ")");
          i = rp + 1;
          continue;
        }
      }
    }
    plain += c;
    i++;
  }
  flush();
}

const MD_HEADING = /^(\s{0,3})(#{1,6})(\s.*|)$/;
const MD_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const MD_FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

function mdLine(line: string, out: Out): void {
  const heading = MD_HEADING.exec(line);
  if (heading) {
    out.text(heading[1]);
    out.tok("kw", heading[2] + heading[3]);
    return;
  }
  if (/^\s{0,3}>/.test(line)) {
    out.tok("com", line);
    return;
  }
  if (MD_RULE.test(line)) {
    out.tok("pn", line);
    return;
  }
  const list = MD_LIST.exec(line);
  if (list) {
    out.text(list[1]);
    out.tok("pn", list[2]);
    out.text(list[3]);
    mdInline(list[4], out);
    return;
  }
  if (/^\s*\|/.test(line)) {
    let i = 0;
    while (i < line.length) {
      const bar = line.indexOf("|", i);
      if (bar < 0) {
        mdInline(line.slice(i), out);
        return;
      }
      mdInline(line.slice(i, bar), out);
      out.tok("pn", "|");
      i = bar + 1;
    }
    return;
  }
  mdInline(line, out);
}

function scanMarkdown(src: string, out: Out, depth: number): void {
  const n = src.length;
  let fence = "";
  let fenceLang = "";
  let contentStart = 0;
  let i = 0;
  while (i < n) {
    let e = src.indexOf("\n", i);
    if (e < 0) e = n;
    const line = src.slice(i, e);
    if (fence) {
      const closer = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closer && closer[1][0] === fence[0] && closer[1].length >= fence.length) {
        out.raw(run(src.slice(contentStart, i), fenceLang, depth + 1));
        out.tok("pn", line);
        fence = "";
      } else {
        i = e + 1;
        continue;
      }
    } else {
      const open = MD_FENCE.exec(line);
      if (open) {
        out.text(open[1]);
        out.tok("pn", open[2]);
        out.tok("ty", open[3]);
        fence = open[2];
        fenceLang = open[3].trim().split(/[\s,:]/)[0];
        contentStart = e + 1;
      } else {
        mdLine(line, out);
      }
    }
    if (e < n) out.text("\n");
    i = e + 1;
  }
  if (fence && contentStart < n) out.raw(run(src.slice(contentStart, n), fenceLang, depth + 1));
}

/* ── public API ────────────────────────────────────────────── */

const ALIASES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  javascript: "ts",
  node: "ts",
  py: "python",
  py3: "python",
  python: "python",
  python3: "python",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  json: "json",
  json5: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  sql: "sql",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  mysql: "sql",
  sqlite: "sql",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  java: "java",
  rb: "ruby",
  ruby: "ruby",
  toml: "toml",
  diff: "diff",
  patch: "diff",
};

const LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  js: "JavaScript",
  jsx: "JSX",
  javascript: "JavaScript",
  py: "Python",
  python: "Python",
  rs: "Rust",
  rust: "Rust",
  go: "Go",
  golang: "Go",
  json: "JSON",
  jsonc: "JSON",
  sh: "Shell",
  bash: "Bash",
  shell: "Shell",
  zsh: "Zsh",
  html: "HTML",
  xml: "XML",
  svg: "SVG",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  md: "Markdown",
  mdx: "MDX",
  markdown: "Markdown",
  java: "Java",
  rb: "Ruby",
  ruby: "Ruby",
  toml: "TOML",
  diff: "Diff",
  patch: "Patch",
};

function normalize(lang: string): string {
  const key = (lang || "").trim().toLowerCase().replace(/^\.+/, "");
  return ALIASES[key] ?? "";
}

/** Whether a fence language will actually be highlighted. */
export function supportsLanguage(lang: string): boolean {
  return normalize(lang) !== "";
}

/** Display name for a fence language, e.g. "tsx" → "TSX". */
export function languageLabel(lang: string): string {
  const key = (lang || "").trim().toLowerCase();
  if (!key) return "";
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** `depth` guards the markdown → fenced-code → markdown recursion. */
function run(code: string, lang: string, depth: number): string {
  const id = normalize(lang);
  if (!id || depth >= 2) return esc(code);
  const out = new Out();
  switch (id) {
    case "html":
      scanHtml(code, out);
      break;
    case "css":
      scanCss(code, out);
      break;
    case "yaml":
      scanYaml(code, out);
      break;
    case "toml":
      scanToml(code, out);
      break;
    case "diff":
      scanDiff(code, out);
      break;
    case "markdown":
      scanMarkdown(code, out, depth);
      break;
    default: {
      const spec = SPECS[id];
      if (!spec) return esc(code);
      scanGeneric(code, spec, out, 0, false);
    }
  }
  return out.toString();
}

/**
 * Highlight `code` as `lang`, returning an HTML string of `tk-*` spans.
 * Unknown or empty languages come back HTML-escaped and span-free. Safe to
 * feed straight to dangerouslySetInnerHTML: it escapes every character it
 * emits and never throws.
 */
export function highlight(code: string, lang: string): string {
  try {
    return run(code, lang, 0);
  } catch {
    return esc(code);
  }
}
