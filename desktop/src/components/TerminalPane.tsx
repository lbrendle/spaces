/**
 * TerminalPane — an opt-in *real* terminal.
 *
 * Everywhere else in Spaces an agent runs headless and we render its JSON stream.
 * This is the escape hatch: a genuine pty (src/pty.ts → src-tauri/src/lib.rs)
 * running the harness in its own interactive UI, so the user can watch it work
 * and answer it directly.
 *
 * The renderer below is a deliberately small ANSI subset, implemented exactly
 * rather than a large one implemented approximately:
 *
 *   supported   SGR 0/1/2/3/4/7 and their resets, 30-37, 90-97, 40-47,
 *               100-107, 38/48 (256-colour indexes 0-15 only), 39/49;
 *               CR, LF, BS, TAB, deferred auto-wrap;
 *               CSI A B C D G d H f J K X P @ s u; ESC 7 8 M D E c;
 *               OSC / DCS / APC strings (consumed, not printed).
 *   stripped    everything else — scroll regions, the alternate screen, mouse
 *               tracking, cursor visibility. They are parsed and dropped, never
 *               printed, so nothing smears; a full-screen TUI simply draws into
 *               the scrollback instead of over a fixed grid.
 *
 * Colours resolve to theme tokens, so all 14 themes stay coherent. There is not
 * one literal colour in this file or in terminal.css.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "./ui";
import { IconBolt } from "./icons";
import { ptyKill, ptyResize, ptySpawn, ptyWrite, subscribe } from "../pty";
import { useStore } from "../store";
import type { Agent } from "../types";
import { configuredEffort, tokenize } from "../capabilities";
import "./terminal.css";

/* ── attributes ──────────────────────────────────────────────── */

const BOLD = 1;
const DIM = 2;
const ITALIC = 4;
const UNDER = 8;
const INVERSE = 16;

/** fg/bg are -1 for "theme default", else 0-15 into the ANSI palette. */
function pack(fg: number, bg: number, flags: number): number {
  return ((fg + 1) << 10) | ((bg + 1) << 5) | flags;
}
const DEFAULT_ATTR = pack(-1, -1, 0);

interface Cell {
  ch: string;
  a: number;
}

interface Row {
  id: number;
  /** Bumped on every mutation; the memoised <Line> re-renders on it alone. */
  version: number;
  cells: Cell[];
}

const BLANK: Cell = { ch: " ", a: DEFAULT_ATTR };

const classCache = new Map<number, string>();

function classFor(a: number): string {
  const hit = classCache.get(a);
  if (hit !== undefined) return hit;
  const flags = a & 31;
  let fg = ((a >> 10) & 31) - 1;
  let bg = ((a >> 5) & 31) - 1;
  if (flags & INVERSE) {
    const swap = fg;
    fg = bg;
    bg = swap;
  }
  const cls: string[] = [];
  // After the swap a -1 means "the other default", which is why inverse needs
  // its own two classes rather than just reusing the palette ones.
  if (fg >= 0) cls.push(`tm-f${fg}`);
  else if (flags & INVERSE) cls.push("tm-f-inv");
  if (bg >= 0) cls.push(`tm-b${bg}`);
  else if (flags & INVERSE) cls.push("tm-b-inv");
  if (flags & BOLD) cls.push("tm-bold");
  if (flags & DIM) cls.push("tm-dim");
  if (flags & ITALIC) cls.push("tm-italic");
  if (flags & UNDER) cls.push("tm-under");
  const out = cls.join(" ");
  classCache.set(a, out);
  return out;
}

/* ── parser ──────────────────────────────────────────────────── */

interface Params {
  nums: number[];
  /** True when that parameter used colon sub-params (e.g. "38:5:9"). */
  sub: boolean[];
  raw: string[];
}

function parseParams(text: string): Params {
  if (text === "") return { nums: [], sub: [], raw: [] };
  const raw = text.split(";");
  return {
    nums: raw.map((p) => {
      const v = parseInt(p.split(":")[0] ?? "", 10);
      return Number.isFinite(v) ? v : 0;
    }),
    sub: raw.map((p) => p.includes(":")),
    raw,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** An escape sequence split across chunks is held here; bail out past this. */
const MAX_PARTIAL = 8192;

/**
 * A scrollback of rows plus a cursor. Not a fixed screen grid: rows accumulate
 * and old ones fall off the top, which is what makes "follow the tail" natural
 * and what a chat-shaped app actually wants to show.
 */
class AnsiScreen {
  rows: Row[] = [{ id: 1, version: 0, cells: [] }];
  cursorRow = 0;
  cursorCol = 0;
  cols = 80;
  viewRows = 24;
  maxScrollback = 1500;

  private nextId = 2;
  private fg = -1;
  private bg = -1;
  private flags = 0;
  private saved = { row: 0, col: 0, fg: -1, bg: -1, flags: 0 };
  private partial = "";

  private get attr(): number {
    return pack(this.fg, this.bg, this.flags);
  }

  /** Index of the first row of the visible screen — the origin for CUP/ED. */
  private get screenTop(): number {
    return Math.max(0, this.rows.length - this.viewRows);
  }

  reset() {
    this.rows = [{ id: this.nextId++, version: 0, cells: [] }];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.fg = -1;
    this.bg = -1;
    this.flags = 0;
    this.saved = { row: 0, col: 0, fg: -1, bg: -1, flags: 0 };
    this.partial = "";
  }

  write(data: string) {
    const s = this.partial + data;
    this.partial = "";
    const n = s.length;
    let i = 0;
    while (i < n) {
      const ch = s[i];
      if (ch === "\x1b") {
        const used = this.escape(s, i);
        if (used < 0) {
          const tail = s.slice(i);
          // A program that opens an OSC and never closes it must not be able to
          // grow this without bound.
          this.partial = tail.length > MAX_PARTIAL ? "" : tail;
          break;
        }
        i += used;
        continue;
      }
      if (ch < " " || ch === "\x7f") {
        this.control(ch);
        i++;
        continue;
      }
      let j = i;
      while (j < n && s[j] >= " " && s[j] !== "\x7f" && s[j] !== "\x1b") j++;
      this.print(s.slice(i, j));
      i = j;
    }
    this.trim();
  }

  /* ── writing ── */

  private rowAt(index: number): Row {
    while (this.rows.length <= index) {
      this.rows.push({ id: this.nextId++, version: 0, cells: [] });
    }
    return this.rows[index];
  }

  private print(text: string) {
    // Iterate code points so an emoji stays in one cell instead of splitting
    // into two broken surrogate halves.
    for (const ch of text) {
      if (this.cursorCol >= this.cols) {
        this.cursorCol = 0;
        this.cursorRow++;
      }
      const row = this.rowAt(this.cursorRow);
      while (row.cells.length < this.cursorCol) row.cells.push(BLANK);
      row.cells[this.cursorCol] = { ch, a: this.attr };
      this.cursorCol++;
      row.version++;
    }
  }

  private control(ch: string) {
    switch (ch) {
      case "\n":
      case "\x0b":
      case "\x0c":
        // The pty has ONLCR on, so a real newline arrives as CR LF and the
        // column is already 0. A bare LF stair-steps here exactly as it would
        // in a terminal.
        this.cursorRow++;
        this.rowAt(this.cursorRow);
        break;
      case "\r":
        this.cursorCol = 0;
        break;
      case "\b":
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        break;
      case "\t":
        this.cursorCol = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        break;
      default:
        // BEL, NUL, DEL and friends: nothing to draw.
        break;
    }
  }

  /* ── escapes ── */

  /** Returns how many characters were consumed, or -1 if the chunk ended mid-sequence. */
  private escape(s: string, i: number): number {
    if (i + 1 >= s.length) return -1;
    const c = s[i + 1];
    if (c === "[") return this.csi(s, i);
    if (c === "]") return this.oscString(s, i);
    if (c === "P" || c === "X" || c === "^" || c === "_") return this.oscString(s, i);
    if (c === "7") {
      this.saveCursor();
      return 2;
    }
    if (c === "8") {
      this.restoreCursor();
      return 2;
    }
    if (c === "M") {
      this.cursorRow = Math.max(this.screenTop, this.cursorRow - 1);
      return 2;
    }
    if (c === "D") {
      this.control("\n");
      return 2;
    }
    if (c === "E") {
      this.cursorCol = 0;
      this.control("\n");
      return 2;
    }
    if (c === "c") {
      this.reset();
      return 2;
    }
    // ESC + intermediates + a final byte: charset selection (ESC ( B), keypad
    // modes (ESC =, ESC >) and so on. Consumed and dropped.
    let j = i + 1;
    while (j < s.length && s[j] >= "\x20" && s[j] <= "\x2f") j++;
    if (j >= s.length) return -1;
    return j - i + 1;
  }

  /** OSC / DCS / APC / PM / SOS: a string terminated by BEL or ST (ESC \). */
  private oscString(s: string, i: number): number {
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return j - i + 1;
      if (s[j] === "\x1b") {
        if (j + 1 >= s.length) return -1;
        if (s[j + 1] === "\\") return j - i + 2;
      }
    }
    return -1;
  }

  private csi(s: string, i: number): number {
    let j = i + 2;
    let priv = false;
    while (j < s.length && s[j] >= "\x3c" && s[j] <= "\x3f") {
      priv = true;
      j++;
    }
    const start = j;
    while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || s[j] === ";" || s[j] === ":")) j++;
    const paramText = s.slice(start, j);
    while (j < s.length && s[j] >= "\x20" && s[j] <= "\x2f") j++;
    if (j >= s.length) return -1;
    const final = s[j];
    const used = j - i + 1;
    // Private sequences (?25h cursor, ?1049h alt screen, ?2004h bracketed
    // paste, mouse tracking) are consumed and ignored, never printed.
    if (!priv && final >= "\x40" && final <= "\x7e") {
      this.applyCsi(final, parseParams(paramText));
    }
    return used;
  }

  private applyCsi(final: string, ps: Params) {
    const arg = (idx: number, dflt: number) => {
      const v = ps.nums[idx];
      return v === undefined || v === 0 ? dflt : v;
    };
    switch (final) {
      case "A":
        this.cursorRow = Math.max(this.screenTop, this.cursorRow - arg(0, 1));
        break;
      case "B":
        // Bounded by the screen height so a runaway parameter can't allocate
        // thousands of rows.
        this.cursorRow += Math.min(arg(0, 1), this.viewRows);
        this.rowAt(this.cursorRow);
        break;
      case "C":
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + arg(0, 1));
        break;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - arg(0, 1));
        break;
      case "G":
        this.cursorCol = clamp(arg(0, 1) - 1, 0, this.cols - 1);
        break;
      case "d":
        this.setRow(arg(0, 1));
        break;
      case "H":
      case "f":
        this.setRow(arg(0, 1));
        this.cursorCol = clamp(arg(1, 1) - 1, 0, this.cols - 1);
        break;
      case "J":
        this.eraseDisplay(ps.nums[0] ?? 0);
        break;
      case "K":
        this.eraseLine(ps.nums[0] ?? 0);
        break;
      case "X":
        this.eraseChars(arg(0, 1));
        break;
      case "P":
        this.deleteChars(arg(0, 1));
        break;
      case "@":
        this.insertBlanks(arg(0, 1));
        break;
      case "m":
        this.sgr(ps);
        break;
      case "s":
        this.saveCursor();
        break;
      case "u":
        this.restoreCursor();
        break;
      default:
        // Scroll regions, insert/delete line, device reports: dropped.
        break;
    }
  }

  private setRow(oneBased: number) {
    this.cursorRow = this.screenTop + clamp(oneBased - 1, 0, this.viewRows - 1);
    this.rowAt(this.cursorRow);
  }

  private saveCursor() {
    this.saved = {
      row: this.cursorRow,
      col: this.cursorCol,
      fg: this.fg,
      bg: this.bg,
      flags: this.flags,
    };
  }

  private restoreCursor() {
    this.cursorRow = Math.min(this.saved.row, this.rows.length - 1);
    this.cursorCol = this.saved.col;
    this.fg = this.saved.fg;
    this.bg = this.saved.bg;
    this.flags = this.saved.flags;
  }

  /* ── erasing ──
   * Erased cells keep the current background and nothing else: a space with
   * bold or underline still on would draw a stray rule. */

  private blank(): Cell {
    return this.bg < 0 ? BLANK : { ch: " ", a: pack(-1, this.bg, 0) };
  }

  private eraseLine(mode: number) {
    const row = this.rowAt(this.cursorRow);
    if (mode === 0) {
      row.cells.length = Math.min(row.cells.length, this.cursorCol);
    } else if (mode === 1) {
      const fill = this.blank();
      for (let c = 0; c <= this.cursorCol && c < row.cells.length; c++) row.cells[c] = fill;
    } else {
      row.cells.length = 0;
    }
    row.version++;
  }

  private eraseDisplay(mode: number) {
    if (mode === 0) {
      this.eraseLine(0);
      // Nothing below the cursor survives, so drop those rows outright.
      this.rows.length = this.cursorRow + 1;
      return;
    }
    if (mode === 1) {
      for (let r = this.screenTop; r < this.cursorRow && r < this.rows.length; r++) {
        this.rows[r].cells.length = 0;
        this.rows[r].version++;
      }
      this.eraseLine(1);
      return;
    }
    // 2 clears the visible screen; 3 additionally discards the scrollback.
    for (let r = this.screenTop; r < this.rows.length; r++) {
      this.rows[r].cells.length = 0;
      this.rows[r].version++;
    }
    if (mode === 3) {
      const dropped = this.screenTop;
      if (dropped > 0) {
        this.rows.splice(0, dropped);
        this.cursorRow = Math.max(0, this.cursorRow - dropped);
        this.saved.row = Math.max(0, this.saved.row - dropped);
      }
    }
  }

  private eraseChars(n: number) {
    const row = this.rowAt(this.cursorRow);
    const fill = this.blank();
    const end = Math.min(this.cursorCol + n, Math.max(row.cells.length, this.cursorCol));
    for (let c = this.cursorCol; c < end; c++) row.cells[c] = fill;
    row.version++;
  }

  private deleteChars(n: number) {
    const row = this.rowAt(this.cursorRow);
    if (this.cursorCol < row.cells.length) row.cells.splice(this.cursorCol, n);
    row.version++;
  }

  private insertBlanks(n: number) {
    const row = this.rowAt(this.cursorRow);
    while (row.cells.length < this.cursorCol) row.cells.push(BLANK);
    const fill = this.blank();
    row.cells.splice(this.cursorCol, 0, ...new Array<Cell>(Math.min(n, this.cols)).fill(fill));
    if (row.cells.length > this.cols) row.cells.length = this.cols;
    row.version++;
  }

  /* ── SGR ── */

  private sgr(ps: Params) {
    const codes = ps.nums.length ? ps.nums : [0];
    for (let k = 0; k < codes.length; k++) {
      const v = codes[k];
      if (v === 0) {
        this.fg = -1;
        this.bg = -1;
        this.flags = 0;
      } else if (v === 1) this.flags |= BOLD;
      else if (v === 2) this.flags |= DIM;
      else if (v === 3) this.flags |= ITALIC;
      else if (v === 4) this.flags |= UNDER;
      else if (v === 7) this.flags |= INVERSE;
      else if (v === 21 || v === 22) this.flags &= ~(BOLD | DIM);
      else if (v === 23) this.flags &= ~ITALIC;
      else if (v === 24) this.flags &= ~UNDER;
      else if (v === 27) this.flags &= ~INVERSE;
      else if (v >= 30 && v <= 37) this.fg = v - 30;
      else if (v === 39) this.fg = -1;
      else if (v >= 40 && v <= 47) this.bg = v - 40;
      else if (v === 49) this.bg = -1;
      else if (v >= 90 && v <= 97) this.fg = v - 90 + 8;
      else if (v >= 100 && v <= 107) this.bg = v - 100 + 8;
      else if (v === 38 || v === 48 || v === 58) {
        // These carry their own arguments. Whether they are colon sub-params or
        // following semicolon params, they MUST be consumed — leaving them
        // behind would have "38;5;196" set blink and then nothing.
        if (ps.sub[k]) {
          const parts = (ps.raw[k] ?? "").split(":").map((x) => parseInt(x, 10));
          this.setExtended(v, parts[1], parts[2]);
        } else {
          const mode = codes[k + 1];
          const idx = codes[k + 2];
          this.setExtended(v, mode, idx);
          k += mode === 2 ? 4 : mode === 5 ? 2 : 0;
        }
      }
      // Blink, conceal, strike, fonts and the 59 underline-colour reset are
      // recognised as no-ops rather than mangled.
    }
  }

  /** 256-colour indexes 0-15 map onto the palette; anything richer falls back
   *  to the theme default rather than guessing at a token. */
  private setExtended(which: number, mode: number | undefined, index: number | undefined) {
    if (which === 58) return; // underline colour: not rendered
    const value = mode === 5 && index !== undefined && index >= 0 && index <= 15 ? index : -1;
    if (which === 38) this.fg = value;
    else this.bg = value;
  }

  /* ── scrollback ── */

  private trim() {
    const over = this.rows.length - this.maxScrollback;
    if (over <= 0) return;
    this.rows.splice(0, over);
    this.cursorRow = Math.max(0, this.cursorRow - over);
    this.saved.row = Math.max(0, this.saved.row - over);
  }
}

/* ── rendering ───────────────────────────────────────────────── */

function spansFor(cells: Cell[]): React.ReactNode[] {
  if (cells.length === 0) return [];
  const out: React.ReactNode[] = [];
  let start = 0;
  let activeAttr = (cells[0] ?? BLANK).a;
  let text = "";
  for (let i = 0; i <= cells.length; i++) {
    const cell = cells[i] ?? BLANK;
    if (i === cells.length || cell.a !== activeAttr) {
      const cls = classFor(activeAttr);
      out.push(
        cls ? (
          <span key={start} className={cls}>
            {text}
          </span>
        ) : (
          text
        )
      );
      start = i;
      activeAttr = cell.a;
      text = "";
    }
    if (i < cells.length) text += cell.ch;
  }
  return out;
}

const Line = React.memo(
  function Line({ row }: { row: Row; v: number }) {
    return <div className="tm-line">{spansFor(row.cells)}</div>;
  },
  (a, b) => a.row === b.row && a.v === b.v
);

/* ── the interactive command for an agent ────────────────────── */

export interface InteractiveCommand {
  program: string;
  args: string[];
}

/**
 * What to run to get this agent's harness in its own interactive UI.
 *
 * Only the model is carried over from the agent's configuration. The stored
 * cli_args are tuned for headless runs (stream-json output, non-interactive
 * permission modes) and several of them are rejected outright by the
 * interactive entry points, so passing them through would just fail to launch.
 *
 * Ritz has no CLI at all — it is an HTTP engine — so its terminal is a login
 * shell in the workspace, which is still the useful thing to hand someone.
 */
export function interactiveCommand(
  agent: Pick<Agent, "kind" | "model" | "cli_args"> | undefined,
  overrides?: { model?: string; effort?: string }
): InteractiveCommand {
  const model = overrides?.model?.trim() || agent?.model?.trim() || "";
  const effort = overrides?.effort || (agent ? configuredEffort(agent.kind, agent.cli_args) : "");
  if (agent?.kind === "codex") {
    const args = model ? ["-m", model] : [];
    if (["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
      args.push("-c", `model_reasoning_effort="${effort}"`);
    }
    return { program: "codex", args };
  }
  if (agent?.kind === "custom") {
    return agent.model.trim()
      ? { program: agent.model.trim(), args: tokenize(agent.cli_args ?? "") }
      : { program: "zsh", args: ["-l", "-i"] };
  }
  if (agent?.kind === "ritz" || !agent) return { program: "zsh", args: ["-l", "-i"] };
  const args = model ? ["--model", model] : [];
  if (["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    args.push("--effort", effort);
  }
  return { program: "claude", args };
}

/* ── keyboard ────────────────────────────────────────────────── */

/** The bytes a keypress sends, or null when the terminal shouldn't claim it. */
function keyBytes(e: React.KeyboardEvent): string | null {
  const k = e.key;
  // Leave the Cmd shortcuts (copy, paste, close) to the app.
  if (e.metaKey) return null;
  if (e.ctrlKey) {
    if (k === " ") return "\x00";
    if (k.length !== 1) return null;
    const c = k.toUpperCase().charCodeAt(0);
    // ^@ through ^_ — this is where Ctrl+C (\x03) and Ctrl+D (\x04) come from.
    return c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : null;
  }
  switch (k) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    default:
      break;
  }
  if (k.length === 1) return e.altKey ? `\x1b${k}` : k;
  return null;
}

/**
 * What actually went wrong, in words.
 *
 * The Rust commands reject with a plain string, but a transport failure rejects
 * with an Error and a defect could reject with anything at all — and
 * `String({})` is "[object Object]", which tells someone staring at a terminal
 * that never started precisely nothing.
 */
function errorText(reason: unknown): string {
  if (typeof reason === "string") return reason.trim();
  if (reason instanceof Error) return reason.message || reason.name;
  if (reason && typeof reason === "object") {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
    try {
      return JSON.stringify(reason);
    } catch {
      // Circular or otherwise unserialisable; the coercion below is all that's left.
    }
  }
  return String(reason);
}

/* ── the pane ────────────────────────────────────────────────── */

export interface TerminalPaneProps {
  agentId: string;
  /** Working directory — normally the agent's worktree. Must already exist. */
  cwd: string;
  onClose: () => void;
  /** Override the derived command (defaults to interactiveCommand(agent)). */
  program?: string;
  args?: string[];
  /** Override the modal title. */
  title?: string;
  /** Fill a coding-workspace panel instead of opening as a modal. */
  embedded?: boolean;
}

type Phase =
  | { kind: "running" }
  | { kind: "exited"; code: number | null }
  | { kind: "failed" };

const MIN_COLS = 20;
const MIN_ROWS = 4;
const PROBE = "M".repeat(40);
/** Output buffered between frames; trimmed so a hidden window can't grow it. */
const MAX_BUFFERED = 512_000;

export function TerminalPane({
  agentId,
  cwd,
  onClose,
  program,
  args,
  title,
  embedded = false,
}: TerminalPaneProps) {
  const screenRef = useRef<AnsiScreen | null>(null);
  if (!screenRef.current) screenRef.current = new AnsiScreen();
  const screen = screenRef.current;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);

  const bufferRef = useRef("");
  /** Cancels the pending flush, whichever kind it is. Null when none is armed. */
  const flushRef = useRef<(() => void) | null>(null);
  const followRef = useRef(true);
  /** Set when the user types or pastes: one jump back to the tail, like a real
   *  terminal, without cancelling a deliberate scroll back through history. */
  const jumpRef = useRef(false);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  // Every pty call for this pane goes through one chain, so a StrictMode
  // double-mount can never interleave spawn and kill into an orphan.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  const [tick, setTick] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "running" });
  const [error, setError] = useState("");
  /** False until the pane has been measured at a real size — see `measure`. */
  const [sized, setSized] = useState(false);
  const alive = phase.kind === "running";

  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const derived = interactiveCommand(agent);
  const runProgram = program ?? derived.program;
  const runArgs = args ?? derived.args;

  /**
   * The pty this pane is currently attached to — one id per *spawn*, not per
   * mounted pane.
   *
   * A pane-lifetime id looks right and is subtly wrong. StrictMode's double
   * invoke (and every Restart) runs spawn → kill → spawn, and pty.ts fans events
   * out by session id alone, so a single shared id means the kill of the first
   * pty delivers its `pty-exit` to the *second* pty's handler: the pane reports
   * a perfectly healthy terminal as dead and then refuses every keystroke,
   * because `alive` is false. Rust emits `pty-exit` on kill too, so this is not
   * merely a dev-mode artefact — StrictMode just makes it happen every time.
   * A fresh id per spawn means the two generations can never address each other.
   */
  const sessionRef = useRef("");

  const enqueue = useCallback((fn: () => Promise<unknown>) => {
    // .then(fn, fn) so one failure can't stall the queue, and a trailing catch
    // so a rejection with nothing queued behind it isn't reported as unhandled.
    chainRef.current = chainRef.current.then(fn, fn).catch(() => {});
    return chainRef.current;
  }, []);

  /* ── size ── */

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const rowsEl = rowsRef.current;
    const probe = probeRef.current;
    if (!scroller || !rowsEl || !probe) return null;
    // offsetWidth/Height ignore the modal's opening transform, which a
    // getBoundingClientRect during that animation would fold into the numbers.
    const charW = probe.offsetWidth / PROBE.length;
    const lineH = probe.offsetHeight;
    if (!charW || !lineH) return null;
    const width = rowsEl.clientWidth;
    const height = scroller.clientHeight;
    /*
     * A pane with no box is not a pane that got small — it is a pane nobody can
     * see, and it must not be allowed to speak for the process.
     *
     * `display: none` measures 0, and this pane is hidden three different ways:
     * an inactive terminal tab, a collapsed dock, and a project workspace that
     * is not the current view. Clamping that 0 up to the MIN floor and sending
     * it is how a healthy pty got resized to 20x4 behind the user's back —
     * every hidden terminal reflowed whatever it was running down to twenty
     * columns, and switching back reflowed it again. Reporting "no measurement"
     * leaves the child at the last size it was actually shown at.
     */
    if (width < 1 || height < 1) return null;
    const cols = Math.max(MIN_COLS, Math.floor(width / charW));
    const rows = Math.max(MIN_ROWS, Math.floor(height / lineH));
    return { cols, rows };
  }, []);

  const applySize = useCallback(
    (next: { cols: number; rows: number } | null, notify: boolean) => {
      if (!next) return;
      // A real measurement exists now, which is what releases the spawn below.
      setSized(true);
      const prev = sizeRef.current;
      if (next.cols === prev.cols && next.rows === prev.rows) return;
      sizeRef.current = next;
      screen.cols = next.cols;
      screen.viewRows = next.rows;
      // Captured, not read at call time: by the time the queue drains this may
      // no longer be the current generation, and resizing the *next* pty to the
      // previous one's dimensions is exactly the confusion to avoid.
      const id = sessionRef.current;
      // Through the queue, so a resize triggered while the spawn is still in
      // flight lands after it instead of hitting an unknown session.
      if (notify && id) void enqueue(() => ptyResize(id, next.cols, next.rows).catch(() => {}));
    },
    [enqueue, screen]
  );

  // Runs before the spawn effect below, so the child is born at the right size.
  useLayoutEffect(() => {
    applySize(measure(), false);
    scrollRef.current?.focus();
  }, [applySize, measure]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      // The modal animates open; resizing the pty on every intermediate frame
      // would send the child a burst of SIGWINCHs.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => applySize(measure(), true), 60);
    });
    ro.observe(scroller);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [applySize, measure]);

  /* ── output ── */

  const flush = useCallback(() => {
    flushRef.current = null;
    const data = bufferRef.current;
    bufferRef.current = "";
    if (!data) return;
    const scroller = scrollRef.current;
    // Decide *before* the DOM grows, or scrollHeight has already moved.
    followRef.current =
      jumpRef.current ||
      !scroller ||
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    jumpRef.current = false;
    screen.write(data);
    setTick((t) => t + 1);
  }, [screen]);

  /**
   * Coalesce a burst of chunks into one parse+render per frame. A hidden window
   * gets a timer instead: browsers pause rAF when nothing is on screen, and an
   * agent left running in the background must not come back to a frozen pane.
   */
  const schedule = useCallback(() => {
    if (flushRef.current) return;
    if (typeof document !== "undefined" && document.hidden) {
      const id = window.setTimeout(flush, 120);
      flushRef.current = () => window.clearTimeout(id);
    } else {
      const id = requestAnimationFrame(flush);
      flushRef.current = () => cancelAnimationFrame(id);
    }
  }, [flush]);

  const onData = useCallback(
    (data: string) => {
      const next = bufferRef.current + data;
      // Keeping the newest bytes is the right trade: the scrollback is capped
      // well below this, so nothing that would still be on screen is lost.
      bufferRef.current = next.length > MAX_BUFFERED ? next.slice(-MAX_BUFFERED) : next;
      schedule();
    },
    [schedule]
  );

  useLayoutEffect(() => {
    if (!followRef.current) return;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [tick]);

  /* ── lifecycle ── */

  useEffect(() => {
    // Nothing has told us how big the child's window is yet. Spawning now would
    // start it at the MIN_COLS floor and make it draw its banner wrapped at
    // twenty columns before the first resize could correct it.
    if (!sized) return;

    const sessionId = `term-${agentId}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    sessionRef.current = sessionId;
    let live = true;
    const unsubscribe = subscribe(sessionId, {
      onData,
      onExit: (code) => {
        if (!live) return;
        // pty.ts flushes buffered output before announcing the exit, so the
        // last lines are already waiting to be drawn.
        if (bufferRef.current) schedule();
        setPhase({ kind: "exited", code });
      },
    });

    void enqueue(async () => {
      try {
        await ptySpawn({
          sessionId,
          program: runProgram,
          args: runArgs,
          cwd,
          cols: sizeRef.current.cols,
          rows: sizeRef.current.rows,
        });
        if (live) setError("");
      } catch (e) {
        if (!live) return;
        setError(errorText(e));
        setPhase({ kind: "failed" });
      }
    });

    return () => {
      live = false;
      unsubscribe();
      // This closure's own id, never sessionRef: the next generation may already
      // have claimed the ref by the time the queue reaches this.
      void enqueue(() => ptyKill(sessionId).catch(() => {}));
    };
    // runProgram/runArgs are read at spawn time; a restart is what re-runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, attempt, cwd, sized, enqueue, schedule, onData]);

  useEffect(() => {
    return () => {
      flushRef.current?.();
      flushRef.current = null;
    };
  }, []);

  const restart = () => {
    screen.reset();
    bufferRef.current = "";
    followRef.current = true;
    setPhase({ kind: "running" });
    setError("");
    setTick((t) => t + 1);
    setAttempt((a) => a + 1);
  };

  /* ── input ── */

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!alive || !sessionRef.current) return;
    const bytes = keyBytes(e);
    if (bytes === null) return;
    e.preventDefault();
    e.stopPropagation();
    jumpRef.current = true;
    void ptyWrite(sessionRef.current, bytes).catch((err) => setError(errorText(err)));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!alive || !sessionRef.current) return;
    const text = e.clipboardData.getData("text");
    e.preventDefault();
    if (!text) return;
    jumpRef.current = true;
    void ptyWrite(sessionRef.current, text).catch((err) => setError(errorText(err)));
  };

  /* ── view ── */

  const commandLine = [runProgram, ...runArgs].join(" ");
  const caretRow = screen.cursorRow;
  const heading = title ?? `Terminal — ${agent?.name ?? "agent"}`;

  const terminal = (
    <div className={"tm-root" + (embedded ? " tm-root-embedded" : "")}>
        <div className="tm-bar">
          <code className="tm-cmd" title={commandLine}>
            {commandLine}
          </code>
          {cwd && (
            <code className="tm-cwd" title={cwd}>
              {cwd}
            </code>
          )}
          <span className={"tm-state" + (alive ? " live" : "")}>
            {phase.kind === "running"
              ? "running"
              : phase.kind === "failed"
                ? "failed to start"
                : // A null code means it was ended by a signal rather than by
                  // returning one. "ended" says that; "exited ?" reads as a bug.
                  phase.code === null
                  ? "ended"
                  : `exited ${phase.code}`}
          </span>
          {!alive && (
            <button className="btn tiny tm-restart" onClick={restart}>
              <IconBolt size={12} />
              Restart
            </button>
          )}
        </div>

        {/* A live terminal that refused one write still needs to say so; a
            terminal that never started says it inside the screen instead, where
            the person is already looking. */}
        {error && phase.kind !== "failed" && <div className="banner warn tm-error">{error}</div>}

        <div
          className="tm-screen"
          ref={scrollRef}
          tabIndex={0}
          aria-label={
            embedded
              ? "Terminal. Keystrokes go straight to the process; Ctrl+C interrupts, Ctrl+D sends EOF."
              : "Terminal"
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onMouseUp={() => {
            // Don't steal a click that was a text selection.
            if (!window.getSelection()?.toString()) scrollRef.current?.focus();
          }}
        >
          <div className="tm-rows" ref={rowsRef}>
            <div className="tm-probe-box" aria-hidden="true">
              <div className="tm-line tm-probe" ref={probeRef}>
                {PROBE}
              </div>
            </div>
            {phase.kind === "failed" && (
              <div className="tm-failure" role="alert">
                <strong>This terminal could not start.</strong>
                <p className="tm-failure-why">
                  {error || "The process ended before it produced any output."}
                </p>
                <dl className="tm-failure-facts">
                  <dt>command</dt>
                  <dd>{commandLine}</dd>
                  {cwd && (
                    <>
                      <dt>cwd</dt>
                      <dd>{cwd}</dd>
                    </>
                  )}
                </dl>
              </div>
            )}
            {screen.rows.map((row) => (
              <Line key={row.id} row={row} v={row.version} />
            ))}
            {alive && (
              <div
                className="tm-caret"
                style={
                  {
                    "--tm-row": caretRow,
                    "--tm-col": screen.cursorCol,
                  } as React.CSSProperties
                }
              />
            )}
          </div>
        </div>

        {/* A fixed legend that never changes is the definition of chrome that
            has not earned its height, and in the dock it competes with the
            scrollback for the little of it there is. The modal is a deliberate,
            one-off surface with room to spare, so it keeps the guidance; the
            embedded pane carries it on the screen's accessible name instead. */}
        {!embedded && (
          <div className="tm-hint">
            Keystrokes go straight to the process — Ctrl+C interrupts, Ctrl+D sends EOF. Closing
            this window ends it.
          </div>
        )}
    </div>
  );

  if (embedded) {
    return (
      <section className="tm-embed" aria-label={heading}>
        {terminal}
      </section>
    );
  }

  return (
    <Modal title={heading} onClose={onClose} wide>
      {terminal}
    </Modal>
  );
}
