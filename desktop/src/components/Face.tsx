/**
 * Face — every picture of somebody, drawn in one place.
 *
 * A workspace full of coloured initials reads as a database. Three things go
 * on the wall here and they are not the same kind of thing: a person, an agent
 * and a team. So the face answers two questions at once, and keeps the two
 * channels separate on purpose:
 *
 *   COLOUR says WHO — the identity ramp, hashed from the row id or chosen by
 *   the person themselves. It is the same colour their name renders in.
 *
 *   SHAPE says WHAT — a person is a circle, an agent or a team is a rounded
 *   square, and an agent with no picture of its own shows the mark of the
 *   harness it runs on. That last one is the default for agents rather than a
 *   fallback of last resort: it means a roster is scannable by shape before you
 *   have read a single word of it, and the shape is telling you the one thing
 *   about an agent you cannot guess — which runtime is behind it.
 *
 * Order of preference, for every entity kind:
 *   1. the row's own `avatar` (a data URL, migration v16)
 *   2. for an agent, the harness mark
 *   3. initials on the identity colour
 *
 * ── on the marks ─────────────────────────────────────────────
 * The three marks are drawn here, by hand, as geometry. They are deliberately
 * abstract: they identify which runtime an agent uses, they are NOT the
 * vendors' brand assets and must never drift towards being them. Each is a
 * different silhouette family — radial, angular, round — so the difference
 * survives being drawn at 11 pixels, which is what a 16px face gives them.
 * They are monochrome via currentColor, so they inherit whatever the surface
 * around them is doing.
 *
 * ── on storage ───────────────────────────────────────────────
 * A picture lives in the row as a data URL, because a file path is only valid
 * on the machine that chose it and these have to survive syncing. That makes
 * the downscale in `prepareFace` load-bearing rather than a nicety: SQLite will
 * happily store a 4MB selfie and then be slow forever. Everything is
 * centre-cropped square, capped at 256px, re-encoded, and refused outright
 * above FACE_MAX_BYTES.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import { useStore } from "../store";
import { agentIdentity } from "../entities";
import { watchFileDrop } from "../kb";
import { errorText, toast } from "../toast";
import { colorFor } from "../types";
import type { AgentKind, EntityRef, Member } from "../types";
import { harnessFor } from "../capabilities";
import { config } from "../config";
import { Modal } from "./ui";
import { IconImage } from "./icons";
import "./face.css";

/* ── the sizes ────────────────────────────────────────────────── */

/**
 * The only sizes a face is drawn at. A closed set rather than a number,
 * because each one is hand-tuned below and a 27px face would be a 27px face
 * with the type of a 24px one.
 */
export type FaceSize = 16 | 20 | 24 | 32 | 48 | 64;

export const FACE_SIZES: readonly FaceSize[] = [16, 20, 24, 32, 48, 64];

interface Metrics {
  /** Initials, in px. Hand-set per size: a ratio lands on half pixels and blurs. */
  font: number;
  /** Edge of the harness mark, in px. */
  mark: number;
  /** Edge of the badge, in px. 0 means there is no room for one. */
  badge: number;
  /** How many initials fit. Two letters at 16px is a smudge. */
  letters: 1 | 2;
}

const METRICS: Record<FaceSize, Metrics> = {
  16: { font: 8.5, mark: 11, badge: 0, letters: 1 },
  20: { font: 10, mark: 13, badge: 0, letters: 1 },
  24: { font: 11.5, mark: 15, badge: 0, letters: 2 },
  32: { font: 14, mark: 20, badge: 12, letters: 2 },
  48: { font: 19.5, mark: 29, badge: 17, letters: 2 },
  64: { font: 25, mark: 39, badge: 22, letters: 2 },
};

/**
 * Below 32px a badge is noise rather than information — entitychip.css reached
 * the same conclusion independently and hides the old harness badge at 20px.
 * Suppressing it here means a caller can pass showBadge everywhere without
 * having to know which rows are drawn small.
 */
function metricsFor(size: FaceSize): Metrics {
  return METRICS[size] ?? METRICS[24];
}

/* ── harness marks ────────────────────────────────────────────── */

/**
 * Short names for the marks. `harnessFor().label` is the full product name
 * ("Claude Code", "Ritz (local)"), which is right in a settings form and wrong
 * on a button that has to say "Use the Codex mark".
 */
export const HARNESS_MARK_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  ritz: config().localAiName,
  custom: "Custom CLI",
};

/** Unknown kinds run on Claude, which is also what capabilities.ts assumes. */
export function harnessKind(kind: string): AgentKind {
  return kind === "codex" || kind === "ritz" || kind === "custom" ? kind : "claude";
}

/**
 * The marks themselves. One 24×24 box, centre (12, 12), same live area as the
 * icon set — so a mark and an icon sitting in the same row agree about weight.
 *
 * Radial, angular, round. The families are chosen to be distinguishable at a
 * glance rather than on inspection; detail finer than about a fifth of the box
 * would disappear at 16px, so there is none.
 */
export function HarnessMark({
  kind,
  size = 16,
  tint,
}: {
  kind: string;
  size?: number;
  /** Overrides currentColor. A theme token — never a literal. */
  tint?: string;
}) {
  const k = harnessKind(kind);
  return (
    <svg
      className="face-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={tint ? { color: tint } : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {k === "claude" && (
        // A six-point burst: three strokes through the centre at 60°.
        <g strokeWidth={2.8}>
          <path d="M12 4.2V19.8" />
          <path d="M5.25 8.1L18.75 15.9" />
          <path d="M5.25 15.9L18.75 8.1" />
        </g>
      )}
      {k === "codex" && (
        // A diamond holding a smaller solid diamond. Every edge is a corner,
        // which is what keeps it apart from the ring at small sizes.
        <>
          <path d="M12 3.6L20.4 12L12 20.4L3.6 12Z" strokeWidth={2.6} />
          <path d="M12 8.7L15.3 12L12 15.3L8.7 12Z" fill="currentColor" stroke="none" />
        </>
      )}
      {k === "ritz" && (
        // A solid core inside a ring — dense in the middle, which reads as
        // "runs here" and is the one mark with no straight line in it.
        <>
          <circle cx="12" cy="12" r="8.4" strokeWidth={2.6} />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
        </>
      )}
      {k === "custom" && (
        // A terminal prompt: generic by design, because the executable is the
        // user's rather than Spaces's.
        <>
          <path d="M5 7.5L9.5 12L5 16.5" strokeWidth={2.5} />
          <path d="M11.5 17H19" strokeWidth={2.5} />
        </>
      )}
    </svg>
  );
}

/* ── identity ─────────────────────────────────────────────────── */

/**
 * Migration v16 added `members.avatar`, and `SELECT *` already hands it to the
 * store — but types.ts is not this file's to edit, so widen locally. Same
 * approach PeopleView takes for the v15 ownership columns; the intersection
 * stays correct the day types.ts declares the column for real.
 */
type FacedMember = Member & { avatar?: string };
type HostedAgent = { host_device_id?: string };

export type FaceKind = "member" | "agent" | "team" | "unknown";

export interface FaceIdentity {
  kind: FaceKind;
  /** Their own name. Whose agent it is lives in `tag`, never folded in here. */
  name: string;
  /** "Rowan's", or '' for your own agents and for everything that is not one. */
  tag: string;
  /** Data URL, or '' to fall through to the mark or the initials. */
  avatar: string;
  /** A theme token — --avatar-N or the person's chosen colour. */
  color: string;
  /** Set only for agents. */
  harness: AgentKind | null;
  initials: string;
  /** False when the row is gone. Links outlive their targets. */
  exists: boolean;
}

/** First and last initial, the way the roster already does it. */
function initialsOf(name: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

const MISSING: FaceIdentity = {
  kind: "unknown",
  name: "",
  tag: "",
  avatar: "",
  color: "",
  harness: null,
  initials: "?",
  exists: false,
};

/**
 * Everything a face paints, read live from the store.
 *
 * Live rather than from a snapshot for the same reason chips are: renaming an
 * agent or choosing a new picture has to land on every roster, stack and
 * message header at once, or two surfaces start disagreeing about who somebody
 * is.
 */
export function useFace(ref: EntityRef): FaceIdentity {
  const members = useStore((s) => s.members);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const { type, id } = ref;

  return useMemo<FaceIdentity>(() => {
    if (type === "member") {
      const row = members.find((m) => m.id === id) as FacedMember | undefined;
      if (!row) return MISSING;
      return {
        kind: "member",
        name: row.name,
        tag: "",
        avatar: row.avatar ?? "",
        // Their chosen colour, or the theme's hashed ramp — always a token.
        color: row.color || colorFor(row.id),
        harness: null,
        initials: initialsOf(row.name),
        exists: true,
      };
    }
    if (type === "agent") {
      const row = agents.find((a) => a.id === id);
      if (!row) return MISSING;
      const who = agentIdentity(row.id);
      return {
        kind: "agent",
        name: who.name || row.name,
        tag: who.tag,
        avatar: row.avatar ?? "",
        color: colorFor(row.id),
        harness: harnessKind(row.kind),
        initials: initialsOf(row.name),
        exists: true,
      };
    }
    if (type === "team") {
      const row = teams.find((t) => t.id === id);
      if (!row) return MISSING;
      return {
        kind: "team",
        name: row.name,
        tag: "",
        avatar: row.avatar ?? "",
        color: colorFor(row.id),
        harness: null,
        initials: initialsOf(row.name),
        exists: true,
      };
    }
    return MISSING;
    // agentIdentity reads `members` to resolve the owner tag, so it belongs in
    // the deps even though nothing else here touches the roster.
  }, [type, id, members, agents, teams]);
}

/* ── availability ─────────────────────────────────────────────── */

/**
 * Whether an agent could run at all, which is a question about a machine
 * rather than about the agent.
 *
 * Deliberately NOT based on how recently a device was seen: only the copy of
 * Spaces running on a machine writes that machine's heartbeat, so every device but
 * this one looks stale forever and a "last seen" badge would simply lie. What
 * can be said honestly is whether a host was ever chosen and whether that host
 * reported the CLI on its PATH.
 */
export type Runtime = "ready" | "no-host" | "no-cli";

const RUNTIME_NOTE: Record<Runtime, string> = {
  ready: "Its host machine has the CLI — it can run whenever that machine is awake and running Spaces.",
  "no-host": "No host machine, so nothing runs it yet.",
  "no-cli": "Its host machine reported no such CLI on its PATH when it last checked in.",
};

function parseTools(raw: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = value === true;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Returns a plain string so the selector never re-renders on an equal answer —
 * a device heartbeat that changes nothing visible must not repaint a roster.
 * An empty id means "not asking", which keeps the hook call unconditional.
 */
function useRuntime(agentId: string): Runtime | null {
  return useStore((s) => {
    if (!agentId) return null;
    const agent = s.agents.find((a) => a.id === agentId);
    if (!agent) return null;
    const hostId = (agent as HostedAgent).host_device_id ?? "";
    if (!hostId) return "no-host";
    const host = s.devices.find((d) => d.id === hostId);
    if (!host) return "no-host";
    // Ritz answers on the machine's own port rather than from PATH, so a tool
    // list says nothing either way about it.
    if (agent.kind === "ritz") return "ready";
    return parseTools(host.tools)[agent.kind] === false ? "no-cli" : "ready";
  });
}

/* ── the face ─────────────────────────────────────────────────── */

export interface FaceProps {
  /** A member, agent or team. Anything else draws the tombstone. */
  ref: EntityRef;
  size?: FaceSize;
  /**
   * Adds the small badge at the bottom right. It carries whatever the face
   * itself cannot say, and nothing when there is nothing true to add — see
   * FaceBadge. Ignored below 32px, where it would only be noise.
   */
  showBadge?: boolean;
}

export function Face({ ref, size = 24, showBadge }: FaceProps) {
  const face = useFace(ref);
  const m = metricsFor(size);
  const badged = !!showBadge && m.badge > 0;
  // The picture already says which harness, so the badge reports availability;
  // when a picture has replaced the mark, the badge carries the harness instead
  // and the roster stays scannable. One slot, whichever fact is missing.
  const runtime = useRuntime(badged && face.kind === "agent" && !face.avatar ? ref.id : "");

  const label = faceLabel(face);
  const initials = m.letters === 1 ? face.initials.slice(0, 1) : face.initials;
  const showMark = !face.avatar && face.kind === "agent" && !!face.harness;

  const vars = {
    "--face-size": `${size}px`,
    "--face-font": `${m.font}px`,
    "--face-mark": `${m.mark}px`,
    "--face-badge": `${m.badge}px`,
    // The tile is the identity colour; the tombstone borrows a neutral so a
    // deleted row is visibly not somebody.
    background: face.exists ? face.color : "var(--bg-active)",
  } as CSSProperties;

  const className = [
    "face",
    `face-${size}`,
    face.kind === "member" ? "face-round" : "",
    face.exists ? "" : "face-gone",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={className} style={vars} role="img" aria-label={label} title={label}>
      {face.avatar ? (
        <img className="face-photo" src={face.avatar} alt="" draggable={false} />
      ) : showMark ? (
        <HarnessMark kind={face.harness ?? "claude"} size={m.mark} />
      ) : (
        <span className="face-initials" aria-hidden="true">
          {initials}
        </span>
      )}
      {badged && <FaceBadge face={face} runtime={runtime} size={m.badge} />}
    </span>
  );
}

/**
 * The badge says the thing the face cannot.
 *
 * An agent showing its harness mark already announces its runtime, so its
 * badge reports whether it can actually run. An agent showing a picture has
 * given that up, so its badge is the mark. A person and a team get nothing:
 * there is no second fact about them that is true today, and a badge invented
 * to fill the slot is worse than an empty corner.
 */
function FaceBadge({
  face,
  runtime,
  size,
}: {
  face: FaceIdentity;
  runtime: Runtime | null;
  size: number;
}) {
  if (face.kind !== "agent" || !face.harness) return null;

  if (face.avatar) {
    const label = HARNESS_MARK_LABEL[face.harness];
    return (
      <span className="face-badge" title={`Runs on ${harnessFor(face.harness).label}`}>
        <HarnessMark kind={face.harness} size={Math.round(size * 0.68)} />
        <span className="face-sr">{label}</span>
      </span>
    );
  }

  if (!runtime) return null;
  return (
    <span
      className={"face-badge face-badge-" + runtime}
      title={RUNTIME_NOTE[runtime]}
      aria-label={RUNTIME_NOTE[runtime]}
    >
      <span className="face-status" aria-hidden="true" />
    </span>
  );
}

function faceLabel(face: FaceIdentity): string {
  if (!face.exists) return "Someone who is no longer here";
  // A row with a blank name still needs a label: role="img" with an empty one
  // is a picture a screen reader cannot announce at all.
  const who = [face.tag, face.name].filter(Boolean).join(" ") || "Unnamed";
  if (face.kind === "agent" && face.harness) {
    return `${who} — ${harnessFor(face.harness).label} agent`;
  }
  if (face.kind === "team") return `${who} — team`;
  return who;
}

/* ── the image pipeline ───────────────────────────────────────── */

/** Longest edge stored. A face is never drawn above 64px, so 256 covers 3x. */
export const FACE_MAX_PX = 256;

/**
 * Hard cap on the stored string. This is what the SQLite row actually costs —
 * a data URL is text — so the limit is measured on the encoded length rather
 * than on the binary it came from.
 */
export const FACE_MAX_BYTES = 200 * 1024;

/** Nothing this big is worth decoding to make a 256px square out of it. */
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export interface PreparedFace {
  /** The data URL, ready to store in the row. */
  url: string;
  /** Length of that string, in bytes. */
  bytes: number;
  /** Square edge, in pixels, after the crop and the resize. */
  size: number;
  type: "image/jpeg" | "image/png";
}

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeImage(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF rotation a phone camera writes. Without
      // it a portrait selfie is stored on its side, permanently.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch {
      // Some engines reject the options bag rather than ignoring it. The
      // element path below handles orientation itself on anything current.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("that file could not be read as an image"));
      el.src = url;
    });
    // An SVG with no width/height has no intrinsic size and lands here at 0.
    if (!img.naturalWidth || !img.naturalHeight) {
      URL.revokeObjectURL(url);
      throw new Error(
        "that image does not declare a size, so there is nothing to crop — export it as a PNG or JPEG first"
      );
    }
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/**
 * Alpha is a property of the pixels, not of the file extension: plenty of PNGs
 * are opaque and would be a quarter of the size as JPEG. One pass over the
 * already-drawn square answers it exactly.
 */
function hasTransparency(canvas: HTMLCanvasElement): boolean {
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  } catch {
    // A canvas that cannot be read is a canvas that cannot be re-encoded as
    // PNG either; JPEG is the safe answer.
    return false;
  }
}

/**
 * Centre-crop to a square, resize to at most 256px, re-encode, and refuse
 * anything that is still over the cap.
 *
 * The ladder matters. Quality comes off first, because 0.62 on a 256px face is
 * indistinguishable at the sizes a face is drawn at; only when that is
 * exhausted does the square get smaller. A PNG has no quality knob, so it only
 * ever shrinks. Nothing is ever upscaled: a 48px icon blown up to 256 is four
 * times the row for exactly the same picture.
 */
export async function prepareFace(file: File): Promise<PreparedFace> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error(`${file.name || "That file"} is not an image.`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `${file.name || "That file"} is ${kb(file.size)} — too large to open. Export a smaller copy first.`
    );
  }

  const decoded = await decodeImage(file);
  try {
    const side = Math.min(decoded.width, decoded.height);
    if (!side) throw new Error("that image measured zero pixels");
    const sx = Math.round((decoded.width - side) / 2);
    const sy = Math.round((decoded.height - side) / 2);

    const draw = (edge: number): HTMLCanvasElement => {
      const canvas = document.createElement("canvas");
      canvas.width = edge;
      canvas.height = edge;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("this build has no 2D canvas to resize with");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, sx, sy, side, side, 0, 0, edge, edge);
      return canvas;
    };

    const first = Math.min(FACE_MAX_PX, side);
    let canvas = draw(first);
    const png = hasTransparency(canvas);
    const type: PreparedFace["type"] = png ? "image/png" : "image/jpeg";
    const qualities = png ? [undefined] : [0.86, 0.74, 0.62, 0.5];
    const edges = [first, 192, 160, 128].filter((e, i) => i === 0 || e < first);

    let smallest = Number.POSITIVE_INFINITY;
    for (const edge of edges) {
      if (edge !== canvas.width) canvas = draw(edge);
      for (const quality of qualities) {
        const url = png ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", quality);
        if (url.length <= FACE_MAX_BYTES) {
          return { url, bytes: url.length, size: edge, type };
        }
        smallest = Math.min(smallest, url.length);
      }
    }

    throw new Error(
      `that picture is still ${kb(smallest)} after every reduction, over the ${kb(FACE_MAX_BYTES)} limit${
        png ? " — flattening the transparency would help" : ""
      }`
    );
  } finally {
    decoded.release();
  }
}

/* ── writing it back ──────────────────────────────────────────── */

/** Which store action owns this row's avatar column. */
export async function storeFace(ref: EntityRef, avatar: string): Promise<void> {
  const s = useStore.getState();
  switch (ref.type) {
    case "member":
      // `avatar` is a real column (v16) that types.ts does not declare yet;
      // updateMember writes whatever keys it is handed, so the cast only feeds
      // the compiler.
      await s.updateMember(ref.id, { avatar } as unknown as Partial<Member>);
      return;
    case "agent":
      await s.updateAgent(ref.id, { avatar });
      return;
    case "team":
      await s.updateTeam(ref.id, { avatar });
      return;
    default:
      throw new Error(`${ref.type} has no picture to set`);
  }
}

/* ── dropping a picture on a face ─────────────────────────────── */

/**
 * Two drop paths, and only one of them is the DOM's.
 *
 * Tauri intercepts OS file drops before the webview sees them, so the HTML
 * `drop` event carries no files in a packaged build (kb.ts states the same
 * finding, which is why watchFileDrop exists at all). The webview event that
 * replaces it hands over a PATH, and this app has no command that reads a
 * file's bytes — so a dropped picture genuinely cannot be opened that way.
 *
 * Both are wired up regardless, because the two are mutually exclusive: when
 * the window sets `dragDropEnabled: false`, the HTML handlers below get real
 * files and this bridge never fires. Until then the bridge is the difference
 * between a drop that does nothing at all and a drop that says why, which is
 * the only thing left worth doing about it.
 *
 * One subscription for the whole app, shared through this registry — a roster
 * of forty faces must not open forty listeners on the same webview event.
 */
interface DropTarget {
  el: HTMLElement | null;
  setOver: (on: boolean) => void;
  onPaths: (paths: string[]) => void;
}

const dropTargets = new Set<DropTarget>();
let unwatch: (() => void) | null = null;
/** Set by the hit test on every enter/over, and read once by the drop. */
let aimed: DropTarget | null = null;
let lit: DropTarget | null = null;

function hitTest(x: number, y: number): DropTarget | null {
  let found: DropTarget | null = null;
  for (const t of dropTargets) {
    const el = t.el;
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // Last registered wins: a picker opened over a roster is the nearer target.
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) found = t;
  }
  return found;
}

function light(next: DropTarget | null): void {
  if (lit === next) return;
  lit?.setOver(false);
  lit = next;
  next?.setOver(true);
}

function startWatching(): void {
  if (unwatch || !dropTargets.size) return;
  try {
    unwatch = watchFileDrop({
      accepts: (x, y) => {
        aimed = hitTest(x, y);
        light(aimed);
        return !!aimed;
      },
      // The drop clears the highlight before it dispatches, so `aimed` is kept
      // separately — it is set by the hit test that runs immediately before.
      onLeave: () => light(null),
      onDrop: (paths) => {
        const target = aimed;
        aimed = null;
        light(null);
        target?.onPaths(paths);
      },
      onUnsupported: () => {
        // Nothing to say: the HTML handlers are still live, and a toast about
        // an API shape nobody chose would only be noise.
      },
    });
  } catch {
    // No Tauri webview (the browser dev target). The HTML handlers below are
    // the whole story there, and they work.
  }
}

function stopWatching(): void {
  if (dropTargets.size || !unwatch) return;
  unwatch();
  unwatch = null;
  aimed = null;
  lit = null;
}

export interface FaceDropOptions {
  /** Defaults to a toast. Forms pass their own so the message lands inline. */
  onError?: (message: string) => void;
  onDone?: (prepared: PreparedFace) => void;
}

export interface FaceDrop {
  /** True while a picture is over the target. */
  dropping: boolean;
  /** True while a dropped picture is being resized and written. */
  busy: boolean;
  /** Spread onto any element and it accepts a dropped picture. */
  handlers: {
    ref: (el: HTMLElement | null) => void;
    onDragEnter: (e: ReactDragEvent<HTMLElement>) => void;
    onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
    onDragLeave: (e: ReactDragEvent<HTMLElement>) => void;
    onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  };
}

function carriesFiles(e: ReactDragEvent<HTMLElement>): boolean {
  return !!e.dataTransfer?.types?.includes("Files");
}

/**
 * Make anything a drop target for a picture. Returns handlers to spread and
 * the two bits of state a caller needs to draw the affordance:
 *
 *   const drop = useFaceDrop({ type: "agent", id });
 *   <span {...drop.handlers} className={drop.dropping ? "face-target-on" : ""}>
 */
export function useFaceDrop(ref: EntityRef, opts: FaceDropOptions = {}): FaceDrop {
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  // dragenter/dragleave fire for every child crossed; a depth count is what
  // keeps the highlight from flickering as the pointer moves over the initials.
  const depth = useRef(0);
  const alive = useRef(true);
  const { type, id } = ref;

  // Options are usually inline arrows, so they change identity every render.
  // Keeping them behind a ref lets the callbacks below stay stable.
  const options = useRef(opts);
  useEffect(() => {
    options.current = opts;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback((message: string) => {
    const handler = options.current.onError;
    if (handler) handler(message);
    else toast.error("That picture could not be used", message);
  }, []);

  const take = useCallback(
    async (files: File[]) => {
      const file = files.find((f) => !f.type || f.type.startsWith("image/"));
      if (!file) {
        fail("Drop an image — a PNG, JPEG, WebP or GIF.");
        return;
      }
      setBusy(true);
      try {
        const prepared = await prepareFace(file);
        await storeFace({ type, id }, prepared.url);
        options.current.onDone?.(prepared);
      } catch (e) {
        fail(errorText(e));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [type, id, fail]
  );

  /**
   * One registry entry per hook, built once and never replaced — the callback
   * ref writes its element straight into it. Anything that rebuilt it would
   * either lose the element or, worse, let one face claim another's slot.
   * `fail` is stable, so the closure captured here stays current.
   */
  const entry = useRef<DropTarget | null>(null);
  if (!entry.current) {
    entry.current = {
      el: null,
      setOver: (on) => {
        if (alive.current) setDropping(on);
      },
      onPaths: (paths) => {
        const name = paths[0]?.split("/").pop() || "That picture";
        fail(
          `${name} arrived as a file path rather than as data, and this build cannot read a path. Use “Choose a picture” instead.`
        );
      },
    };
  }

  useEffect(() => {
    const target = entry.current;
    if (!target) return;
    dropTargets.add(target);
    startWatching();
    return () => {
      dropTargets.delete(target);
      if (lit === target) lit = null;
      if (aimed === target) aimed = null;
      stopWatching();
    };
  }, []);

  const keep = useCallback((el: HTMLElement | null) => {
    if (entry.current) entry.current.el = el;
  }, []);

  const reset = useCallback(() => {
    depth.current = 0;
    setDropping(false);
  }, []);

  return {
    dropping,
    busy,
    handlers: {
      ref: keep,
      onDragEnter: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDropping(true);
      },
      onDragOver: (e) => {
        if (!carriesFiles(e)) return;
        // Without this the browser refuses the drop entirely.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e) => {
        if (!carriesFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDropping(false);
      },
      onDrop: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        reset();
        void take(Array.from(e.dataTransfer?.files ?? []));
      },
    },
  };
}

/* ── the picker ───────────────────────────────────────────────── */

/** The identity ramp, as tokens. Never a literal — 39 themes redefine these. */
const RAMP = Array.from({ length: 8 }, (_, i) => `var(--avatar-${i})`);

export interface FacePickerProps {
  /** The member, agent or team whose picture is being set. */
  ref: EntityRef;
  onClose: () => void;
}

/**
 * Setting a picture.
 *
 * The remove option and the "use the mark" option are one control, because for
 * an agent they are the same action: clearing the row is exactly what puts the
 * harness mark back. Labelling it "Remove" would hide what actually happens,
 * and offering both would be two buttons that do one thing.
 */
export function FacePicker({ ref, onClose }: FacePickerProps) {
  const face = useFace(ref);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const drop = useFaceDrop(ref, {
    onError: setError,
    onDone: (prepared) => {
      setError("");
      toast.success("Picture set", `${prepared.size}px square, ${kb(prepared.bytes)} in the row.`);
    },
  });

  const working = busy || drop.busy;

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const prepared = await prepareFace(file);
      await storeFace(ref, prepared.url);
      toast.success("Picture set", `${prepared.size}px square, ${kb(prepared.bytes)} in the row.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError("");
    try {
      await storeFace(ref, "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const fallbackLabel =
    face.kind === "agent" && face.harness
      ? `Use the ${HARNESS_MARK_LABEL[face.harness]} mark`
      : "Use initials";

  const title = face.name ? `Picture for ${face.name}` : "Picture";

  return (
    <Modal title={title} onClose={onClose}>
      <p className="face-lead">
        Cropped square, resized to {FACE_MAX_PX}px and re-encoded before it is stored, so the row
        stays a few tens of kilobytes rather than a few megabytes. It is written into the database
        itself — a file path would only resolve on the machine that chose it.
      </p>

      <div
        {...drop.handlers}
        className={"face-drop" + (drop.dropping ? " face-drop-on" : "")}
        aria-busy={working || undefined}
      >
        <Face ref={ref} size={64} />
        <div className="face-drop-text">
          <strong>{drop.dropping ? "Drop it here" : "Drag a picture here"}</strong>
          <span>PNG, JPEG, WebP or GIF. Transparency is kept as PNG.</span>
        </div>
        <button
          type="button"
          className="btn"
          disabled={working}
          onClick={() => fileRef.current?.click()}
        >
          <IconImage size={13} /> Choose a picture
        </button>
        <input
          ref={fileRef}
          className="face-sr"
          type="file"
          accept="image/*"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clearing the value lets the same file be picked twice in a row.
            e.target.value = "";
            void choose(file);
          }}
        />
      </div>

      {error && <p className="face-error">{error}</p>}

      {face.avatar && (
        <section className="face-block">
          <div className="field-label">How it will read</div>
          <div className="face-scale">
            {([48, 32, 24, 16] as FaceSize[]).map((s) => (
              <span key={s} className="face-scale-item">
                <Face ref={ref} size={s} />
                <span className="face-scale-px">{s}</span>
              </span>
            ))}
          </div>
          <p className="face-hint">
            A face is drawn at every one of these. A photograph cropped tight on a face survives
            16px; a screenshot or a wordmark does not.
          </p>
        </section>
      )}

      {face.kind === "member" && <ColourRow ref={ref} current={face} disabled={working} />}

      {face.kind === "agent" && face.harness && (
        <p className="face-hint">
          The mark follows what the agent actually runs on — {harnessFor(face.harness).label}. It is
          not a choice, because an agent showing a runtime it does not use would be a lie the whole
          roster then repeats.
        </p>
      )}

      <div className="modal-actions space-between">
        <button
          type="button"
          className="btn tiny"
          disabled={working || !face.avatar}
          onClick={() => void clear()}
        >
          {fallbackLabel}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

/**
 * The identity colour, editable here because it is what the initials fall back
 * to — and what the person's name renders in everywhere else. Native radios,
 * so arrow keys, Home/End and screen-reader grouping come from the platform.
 */
function ColourRow({
  ref,
  current,
  disabled,
}: {
  ref: EntityRef;
  current: FaceIdentity;
  disabled: boolean;
}) {
  const updateMember = useStore((s) => s.updateMember);
  const stored = useStore((s) => s.members.find((m) => m.id === ref.id)?.color ?? "");
  const group = useId();

  function pick(value: string) {
    void updateMember(ref.id, { color: value }).catch((e) => {
      toast.error("Could not change that colour", e);
    });
  }

  return (
    <fieldset className="face-block face-colours" disabled={disabled}>
      <legend className="field-label">Identity colour</legend>
      <div className="face-swatches">
        {["", ...RAMP].map((option) => {
          const auto = option === "";
          return (
            <label
              key={option || "auto"}
              className={"face-swatch" + (option === stored ? " face-swatch-on" : "")}
              title={auto ? "Follow the theme's own hashed colour" : "Use this colour"}
            >
              <input
                className="face-sr"
                type="radio"
                name={group}
                checked={option === stored}
                onChange={() => pick(option)}
              />
              <span
                className="face-swatch-dot"
                style={{ background: auto ? colorFor(ref.id) : option }}
                aria-hidden="true"
              />
              <span className="face-sr">{auto ? "Automatic colour" : `Colour ${option}`}</span>
              {/* The automatic swatch paints the hashed colour it would pick, so
                  without a marker it is indistinguishable from choosing that
                  colour outright — which is a different decision. */}
              {auto && (
                <span className="face-swatch-auto" aria-hidden="true">
                  A
                </span>
              )}
            </label>
          );
        })}
      </div>
      <p className="face-hint">
        {current.avatar
          ? "Behind the picture — it comes back the moment the picture goes, and it is the colour their name is written in."
          : "The tile behind the initials, and the colour their name is written in."}
      </p>
    </fieldset>
  );
}
