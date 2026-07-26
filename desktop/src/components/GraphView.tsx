/**
 * Connections — the workspace as a navigable map.
 *
 * Everything else in Spaces shows one kind of thing at a time: tasks in a board,
 * memory in a list, agents in a grid. This is the only place the *shape* of the
 * workspace is visible — that this memory entry feeds three channels, that one
 * agent owns everything in flight. So it has to stay readable at 400 nodes, and
 * it has to be cheap when nobody is looking at it.
 *
 * Hence canvas over SVG (a few hundred DOM nodes redrawn per frame is a stutter
 * machine), a hand-rolled force layout (no dependency earns its weight for
 * ~60 lines of physics), and an animation loop that stops dead the moment the
 * layout settles, the tab hides, or the view unmounts. A rAF that never stops
 * is a battery bug in a desktop app.
 *
 * The layout is naive O(n²) repulsion. At this scale that is ~80k cheap
 * iterations per frame, and the frames stop after a second or two.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../store";
import { useTheme } from "../themeStore";
import { systemReduceMotion } from "../themes";
import { ENTITY_KINDS, KIND_BY_TYPE, describeEntity, searchEntities } from "../entities";
import type { EntityInfo } from "../entities";
import {
  ASSIGN_ROLES,
  LINK_KINDS,
  LINK_KIND_BY_ID,
  graphSlice,
  neighbourhood,
} from "../links";
import { refKey } from "../types";
import type { EntityRef, EntityType, Link, LinkKind } from "../types";
import { EntityChip, useEntity } from "./EntityChip";
import { Field, Modal } from "./ui";
import { IconCheck, IconPlus, IconSearch, IconX } from "./icons";
import { toast } from "../toast";
import "./graph.css";

/* ── layout constants ─────────────────────────────────────────── */

const TAU = Math.PI * 2;

/** Cooling schedule. Below ALPHA_MIN the layout is done and the loop stops. */
const ALPHA_MIN = 0.008;
const ALPHA_DECAY = 0.978;
/** Ticks run synchronously when motion is off, or when a graph must appear settled. */
const SETTLE_TICKS = 340;

const REPULSION = 5400;
/** Beyond this the 1/d² term is worth less than the multiply that computes it. */
const REPULSION_RANGE = 700;
const SPRING = 0.036;
const SPRING_REST = 96;
const CENTERING = 0.0017;
const DAMPING = 0.85;
const MAX_STEP = 22;

const RAD_MIN = 5.5;
const RAD_MAX = 17;

const MIN_SCALE = 0.12;
const MAX_SCALE = 4;
/** Below this only hub labels are drawn; below HUB_LABEL_SCALE, none at all. */
const LABEL_SCALE = 0.72;
const HUB_LABEL_SCALE = 0.42;
const HUB_DEGREE = 4;
/** Relation glyphs are noise until the graph is big enough to read. */
const GLYPH_SCALE = 1.0;
const ARROW_SCALE = 0.55;

const ASSIGN_GLYPH = "⊙";
const ASSIGN_FILTER = "assign";
const ROLE_SET = new Set<string>(ASSIGN_ROLES.map((r) => r.role));

/* ── graph model ──────────────────────────────────────────────── */

interface GNode {
  key: string;
  ref: EntityRef;
  info: EntityInfo;
  degree: number;
  radius: number;
}

interface GEdge {
  id: string;
  from: string;
  to: string;
  /** An assignment masquerading as a link: "references" carrying a role note. */
  assign: boolean;
  label: string;
  glyph: string;
  directed: boolean;
  /** Perpendicular offset so parallel edges between a pair don't stack. */
  bend: number;
}

interface GraphData {
  nodes: GNode[];
  edges: GEdge[];
  byKey: Map<string, GNode>;
}

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [], byKey: new Map() };

/** Assignments arrive from graphSlice wearing a link's clothes. */
function isAssignEdge(link: Link): boolean {
  return link.kind === "references" && ROLE_SET.has(link.note);
}

function roleLabel(role: string): string {
  return ASSIGN_ROLES.find((r) => r.role === role)?.label ?? role;
}

function radiusFor(degree: number): number {
  return Math.min(RAD_MAX, RAD_MIN + Math.sqrt(degree) * 3.1);
}

function buildGraph(
  slice: ReturnType<typeof graphSlice>,
  hiddenKinds: ReadonlySet<string>,
  hiddenRels: ReadonlySet<string>
): GraphData {
  const byKey = new Map<string, GNode>();
  for (const info of slice.nodes) {
    if (hiddenKinds.has(info.ref.type)) continue;
    byKey.set(refKey(info.ref), {
      key: refKey(info.ref),
      ref: info.ref,
      info,
      degree: 0,
      radius: RAD_MIN,
    });
  }

  const edges: GEdge[] = [];
  // How many edges already join this unordered pair — the nth gets bent out of
  // the way of the (n-1)th, so an agent that both owns and references a task
  // reads as two relations rather than one thick line.
  const pairSeen = new Map<string, number>();

  for (const e of slice.edges) {
    const a = byKey.get(e.from);
    const b = byKey.get(e.to);
    if (!a || !b || a === b) continue;
    const assign = isAssignEdge(e.link);
    if (hiddenRels.has(assign ? ASSIGN_FILTER : e.link.kind)) continue;

    const spec = LINK_KIND_BY_ID[e.link.kind] ?? LINK_KIND_BY_ID.relates;
    const pair = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const n = pairSeen.get(pair) ?? 0;
    pairSeen.set(pair, n + 1);

    edges.push({
      id: e.link.id,
      from: e.from,
      to: e.to,
      assign,
      label: assign ? roleLabel(e.link.note) : spec.label,
      glyph: assign ? ASSIGN_GLYPH : spec.glyph,
      directed: assign || !spec.symmetric,
      // 0, +1, -1, +2, -2 … alternating so the bundle stays centred on the pair.
      bend: n === 0 ? 0 : (Math.ceil(n / 2) * (n % 2 === 1 ? 1 : -1)),
    });
    a.degree++;
    b.degree++;
  }

  // A node whose every edge was filtered out has nothing left to say here.
  const nodes: GNode[] = [];
  for (const node of byKey.values()) {
    if (!node.degree) {
      byKey.delete(node.key);
      continue;
    }
    node.radius = radiusFor(node.degree);
    nodes.push(node);
  }
  return { nodes, edges, byKey };
}

/* ── simulation ───────────────────────────────────────────────── */

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned bodies are placed by hand and never moved by the forces. */
  pinned: boolean;
}

/** Phyllotaxis seed: deterministic, evenly spread, and never two on one point. */
function seedAt(i: number): { x: number; y: number } {
  const angle = i * 2.399963;
  const r = 27 * Math.sqrt(i + 0.5);
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

function tick(data: GraphData, bodies: Map<string, Body>, alpha: number, held: string | null): void {
  const { nodes, edges } = data;
  const n = nodes.length;

  for (let i = 0; i < n; i++) {
    const a = bodies.get(nodes[i].key);
    if (!a) continue;
    for (let j = i + 1; j < n; j++) {
      const b = bodies.get(nodes[j].key);
      if (!b) continue;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > REPULSION_RANGE * REPULSION_RANGE) continue;
      if (d2 < 1) {
        // Perfectly coincident bodies have no direction to separate along;
        // nudge them apart deterministically rather than dividing by zero.
        dx = ((i % 7) - 3) * 0.4 + 0.31;
        dy = ((j % 5) - 2) * 0.4 + 0.17;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const ux = dx / d;
      const uy = dy / d;
      a.vx += ux * f;
      a.vy += uy * f;
      b.vx -= ux * f;
      b.vy -= uy * f;
    }
  }

  for (const e of edges) {
    const a = bodies.get(e.from);
    const b = bodies.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.01;
    const f = (d - SPRING_REST) * SPRING;
    const ux = dx / d;
    const uy = dy / d;
    a.vx += ux * f;
    a.vy += uy * f;
    b.vx -= ux * f;
    b.vy -= uy * f;
  }

  for (const node of nodes) {
    const body = bodies.get(node.key);
    if (!body) continue;
    if (body.pinned || node.key === held) {
      body.vx = 0;
      body.vy = 0;
      continue;
    }
    // Weak pull to the origin: without it disconnected components sail off.
    body.vx -= body.x * CENTERING;
    body.vy -= body.y * CENTERING;
    body.vx *= DAMPING;
    body.vy *= DAMPING;
    let dx = body.vx * alpha;
    let dy = body.vy * alpha;
    const m = Math.hypot(dx, dy);
    if (m > MAX_STEP) {
      dx = (dx / m) * MAX_STEP;
      dy = (dy / m) * MAX_STEP;
    }
    body.x += dx;
    body.y += dy;
  }
}

/* ── theme colors on canvas ───────────────────────────────────── */

interface Palette {
  bg: string;
  surface: string;
  overlay: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  font: string;
  tone: (tone: string) => string;
}

/**
 * Canvas cannot read `var(--x)`, so the tokens are resolved once per theme.
 * Rebuilt whenever the theme store changes — the alternative is a graph that
 * keeps yesterday's colors after a theme switch.
 */
function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  /**
   * Token or token — never a literal. themes.ts sets every one of these on
   * <html> before first paint, so the chain is only insurance against a theme
   * that predates a token; an empty result leaves the canvas style untouched,
   * which is a far smaller lie than a hardcoded colour.
   */
  const read = (...names: string[]): string => {
    for (const name of names) {
      const value = cs.getPropertyValue(name).trim();
      if (value) return value;
    }
    return "";
  };
  const cache = new Map<string, string>();
  return {
    bg: read("--bg"),
    surface: read("--surface-1", "--bg-raised"),
    overlay: read("--bg-overlay", "--bg-raised"),
    border: read("--border"),
    borderStrong: read("--border-strong", "--border"),
    text: read("--text"),
    textDim: read("--text-dim", "--text"),
    textFaint: read("--text-faint", "--text-dim"),
    accent: read("--accent"),
    // A font stack, not a colour — a literal here is a fallback, not a bug.
    font: read("--font") || "system-ui, sans-serif",
    tone(tone: string) {
      const hit = cache.get(tone);
      if (hit) return hit;
      const m = /var\(\s*(--[\w-]+)\s*\)/.exec(tone);
      const value = m ? read(m[1], "--text-dim") : tone;
      cache.set(tone, value);
      return value;
    },
  };
}

/* ── view transform ───────────────────────────────────────────── */

interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ── the view ─────────────────────────────────────────────────── */

export function GraphView() {
  // Every table describeEntity reads is a dependency of the drawing: renaming a
  // task has to rename its node, not just its card.
  const links = useStore((s) => s.links);
  const assignments = useStore((s) => s.assignments);
  const projects = useStore((s) => s.projects);
  const channels = useStore((s) => s.channels);
  const tasks = useStore((s) => s.tasks);
  const memory = useStore((s) => s.memory);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const themeSpec = useTheme((s) => s.theme);
  const prefReduceMotion = useTheme((s) => s.prefs.reduceMotion);

  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenRels, setHiddenRels] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<EntityRef | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [focusDepth, setFocusDepth] = useState(1);
  const [picking, setPicking] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());

  const reduceMotion = prefReduceMotion || systemReduceMotion();

  /* — data — */

  const slice = useMemo(
    () => graphSlice(projectId || undefined),
    // The store tables are the whole input; graphSlice reads them synchronously.
    [projectId, links, assignments, projects, channels, tasks, memory, agents, teams]
  );

  const data = useMemo(
    () => buildGraph(slice, hiddenKinds, hiddenRels),
    [slice, hiddenKinds, hiddenRels]
  );

  const kindCounts = useMemo(() => {
    const m = new Map<EntityType, number>();
    for (const info of slice.nodes) m.set(info.ref.type, (m.get(info.ref.type) ?? 0) + 1);
    return m;
  }, [slice]);

  const relCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of slice.edges) {
      const key = isAssignEdge(e.link) ? ASSIGN_FILTER : e.link.kind;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [slice]);

  /**
   * Search dims, it never removes: a graph that reshapes itself on every
   * keystroke is impossible to read, and half the value of searching here is
   * seeing *where* the matches sit.
   */
  const dimmed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const focusSet =
      focusMode && selected
        ? new Set([refKey(selected), ...neighbourhood(selected, focusDepth).map(refKey)])
        : null;
    if (!q && !focusSet) return null;
    const out = new Set<string>();
    for (const node of data.nodes) {
      const missesSearch = q
        ? !(node.info.title.toLowerCase().includes(q) || node.info.haystack.includes(q))
        : false;
      const outOfFocus = focusSet ? !focusSet.has(node.key) : false;
      if (missesSearch || outOfFocus) out.add(node.key);
    }
    return out;
    // neighbourhood() walks the link tables, so they belong in the deps.
  }, [data, query, focusMode, focusDepth, selected, links, assignments]);

  const matches = data.nodes.length - (dimmed?.size ?? 0);
  /** No links and no assignments anywhere: the first-run story, not a filter. */
  const nothingAnywhere = links.length === 0 && assignments.length === 0;
  const graphIsEmpty = slice.nodes.length === 0;
  const filteredToNothing = !graphIsEmpty && data.nodes.length === 0;

  /* — mutable state the render loop reads — */

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef<GraphData>(EMPTY_GRAPH);
  const bodiesRef = useRef<Map<string, Body>>(new Map());
  const dimRef = useRef<Set<string> | null>(null);
  const selKeyRef = useRef<string | null>(null);
  const hoverNodeRef = useRef<string | null>(null);
  const hoverEdgeRef = useRef<GEdge | null>(null);
  const heldRef = useRef<string | null>(null);
  const viewRef = useRef<Viewport>({ scale: 1, tx: 0, ty: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const paletteRef = useRef<Palette | null>(null);
  const reduceRef = useRef(reduceMotion);
  const alphaRef = useRef(1);
  const frameRef = useRef<number | null>(null);
  const drawPendingRef = useRef(true);
  const fitPendingRef = useRef(true);
  /** Auto-framing is a courtesy, not a policy: once you move the camera it stops. */
  const userMovedRef = useRef(false);

  /* — painting — */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const p = paletteRef.current;
    if (!canvas || !ctx || !p) return;

    const { w, h, dpr } = sizeRef.current;
    const { scale, tx, ty } = viewRef.current;
    const graph = dataRef.current;
    const bodies = bodiesRef.current;
    const dim = dimRef.current;
    const selKey = selKeyRef.current;
    const hoverKey = hoverNodeRef.current;
    const hoverEdge = hoverEdgeRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!graph.nodes.length) return;

    const sx = (x: number) => x * scale + tx;
    const sy = (y: number) => y * scale + ty;
    const isDim = (key: string) => (dim ? dim.has(key) : false);
    const margin = 120;
    const onScreen = (x: number, y: number) => x > -margin && x < w + margin && y > -margin && y < h + margin;

    /* edges under nodes, always */
    ctx.lineCap = "round";
    for (const e of graph.edges) {
      const a = bodies.get(e.from);
      const b = bodies.get(e.to);
      if (!a || !b) continue;
      const ax = sx(a.x);
      const ay = sy(a.y);
      const bx = sx(b.x);
      const by = sy(b.y);
      if (!onScreen(ax, ay) && !onScreen(bx, by)) continue;

      const faded = isDim(e.from) || isDim(e.to);
      const touched = !!selKey && (e.from === selKey || e.to === selKey);
      const hovered = hoverEdge?.id === e.id;

      // Control point for the bend; zero bend collapses it to the midpoint.
      const mx0 = (ax + bx) / 2;
      const my0 = (ay + by) / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const off = e.bend * 15 * Math.min(1, scale);
      const cx = mx0 - (dy / len) * off * 2;
      const cy = my0 + (dx / len) * off * 2;
      // Quadratic midpoint — where the glyph and the hover label live.
      const mx = 0.25 * ax + 0.5 * cx + 0.25 * bx;
      const my = 0.25 * ay + 0.5 * cy + 0.25 * by;

      ctx.globalAlpha = faded ? 0.13 : hovered || touched ? 1 : e.assign ? 0.7 : 0.5;
      ctx.strokeStyle = hovered || touched ? p.accent : e.assign ? p.accent : p.borderStrong;
      ctx.lineWidth = (hovered ? 2.2 : touched ? 1.8 : 1.2) * Math.min(1.4, Math.max(0.7, scale));
      // Assignments are dashed; a person owning a task is a different kind of
      // fact from a link somebody drew between two things.
      if (e.assign) ctx.setLineDash([5, 4]);
      else ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();
      ctx.setLineDash([]);

      if (e.directed && scale >= ARROW_SCALE && !faded) {
        const target = graph.byKey.get(e.to);
        const r = (target?.radius ?? RAD_MIN) * scale + 3.5;
        const vx = bx - cx;
        const vy = by - cy;
        const vl = Math.hypot(vx, vy) || 1;
        const ux = vx / vl;
        const uy = vy / vl;
        const tipX = bx - ux * r;
        const tipY = by - uy * r;
        const size = 5.5;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * size + -uy * size * 0.5, tipY - uy * size + ux * size * 0.5);
        ctx.lineTo(tipX - ux * size - -uy * size * 0.5, tipY - uy * size - ux * size * 0.5);
        ctx.closePath();
        ctx.fillStyle = touched || hovered ? p.accent : e.assign ? p.accent : p.borderStrong;
        ctx.fill();
      }

      if (!faded && scale >= GLYPH_SCALE && !hovered) {
        ctx.globalAlpha = touched ? 0.95 : 0.6;
        ctx.font = `600 ${Math.round(10 * clamp(scale, 1, 1.5))}px ${p.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // Punch the line out from under the glyph so the two never collide.
        ctx.fillStyle = p.bg;
        ctx.beginPath();
        ctx.arc(mx, my, 7.5, 0, TAU);
        ctx.fill();
        ctx.fillStyle = e.assign ? p.accent : p.textFaint;
        ctx.fillText(e.glyph, mx, my + 0.5);
      }

      if (hovered) {
        drawPill(ctx, p, e.label, mx, my);
      }
    }

    /* nodes */
    ctx.globalAlpha = 1;
    for (const node of graph.nodes) {
      const body = bodies.get(node.key);
      if (!body) continue;
      const x = sx(body.x);
      const y = sy(body.y);
      if (!onScreen(x, y)) continue;
      const r = Math.max(2.5, node.radius * scale);
      const faded = isDim(node.key);
      const tone = p.tone(node.info.tone);
      const isSel = node.key === selKey;
      const isHover = node.key === hoverKey;

      ctx.globalAlpha = faded ? 0.22 : 1;

      if (isSel) {
        ctx.beginPath();
        ctx.arc(x, y, r + 7, 0, TAU);
        ctx.fillStyle = p.accent;
        ctx.globalAlpha = faded ? 0.08 : 0.18;
        ctx.fill();
        ctx.globalAlpha = faded ? 0.22 : 1;
      }

      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      // Tinted fill plus a solid ring: legible on light and dark themes alike,
      // where a flat fill would disappear into one of them.
      ctx.globalAlpha = faded ? 0.1 : 0.28;
      ctx.fillStyle = tone;
      ctx.fill();
      ctx.globalAlpha = faded ? 0.28 : 1;
      ctx.lineWidth = isSel ? 2.6 : isHover ? 2 : 1.5;
      ctx.strokeStyle = isSel ? p.accent : tone;
      ctx.stroke();

      if (body.pinned && !faded) {
        ctx.globalAlpha = 0.85;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = p.textDim;
        ctx.beginPath();
        ctx.arc(x, y, r + 3.5, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* labels last, and only as many as fit without becoming soup */
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `600 11.5px ${p.font}`;
    ctx.lineJoin = "round";
    const boxes: number[][] = [];
    const ordered = [...graph.nodes].sort((a, b) => {
      const pri = (n: GNode) => (n.key === selKey ? 3 : n.key === hoverKey ? 2 : dim && !dim.has(n.key) ? 1 : 0);
      return pri(b) - pri(a) || b.degree - a.degree;
    });
    for (const node of ordered) {
      const always = node.key === selKey || node.key === hoverKey;
      if (!always) {
        if (scale < HUB_LABEL_SCALE) continue;
        if (scale < LABEL_SCALE && node.degree < HUB_DEGREE) continue;
      }
      const body = bodies.get(node.key);
      if (!body) continue;
      const x = sx(body.x);
      const y = sy(body.y);
      if (!onScreen(x, y)) continue;
      const faded = isDim(node.key);
      if (faded && !always) continue;

      const text = `${node.info.glyph} ${truncate(node.info.title, 24)}`;
      const width = ctx.measureText(text).width;
      const left = x + Math.max(2.5, node.radius * scale) + 6;
      const box = [left - 2, y - 8, left + width + 2, y + 8];
      if (!always && boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
        continue;
      }
      boxes.push(box);

      ctx.globalAlpha = faded ? 0.35 : 1;
      // Halo in the page background so a label crossing an edge stays readable.
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = p.bg;
      ctx.strokeText(text, left, y);
      ctx.fillStyle = always || node.degree >= HUB_DEGREE ? p.text : p.textDim;
      ctx.fillText(text, left, y);
    }
    ctx.globalAlpha = 1;
  }, []);

  /* — the loop — */

  const fitToView = useCallback(() => {
    const graph = dataRef.current;
    const bodies = bodiesRef.current;
    const { w, h } = sizeRef.current;
    if (!graph.nodes.length || !w || !h) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const node of graph.nodes) {
      const b = bodies.get(node.key);
      if (!b) continue;
      x0 = Math.min(x0, b.x - node.radius);
      y0 = Math.min(y0, b.y - node.radius);
      x1 = Math.max(x1, b.x + node.radius);
      y1 = Math.max(y1, b.y + node.radius);
    }
    if (!Number.isFinite(x0)) return;
    const pad = 60;
    // Labels hang off the right of their node in screen pixels, so the frame
    // reserves a lane for them rather than clipping the words off the map.
    const labelRoom = 150;
    const availW = Math.max(120, w - pad * 2 - labelRoom);
    const availH = Math.max(120, h - pad * 2);
    const scale = clamp(
      Math.min(availW / Math.max(1, x1 - x0), availH / Math.max(1, y1 - y0)),
      MIN_SCALE,
      1.6
    );
    viewRef.current = {
      scale,
      tx: pad + availW / 2 - ((x0 + x1) / 2) * scale,
      ty: h / 2 - ((y0 + y1) / 2) * scale,
    };
    drawPendingRef.current = true;
  }, []);

  const schedule = useCallback(() => {
    if (frameRef.current !== null || document.hidden) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // A hidden tab gets no frames at all; visibilitychange restarts us.
      if (document.hidden) return;

      const animating = alphaRef.current > ALPHA_MIN && !reduceRef.current;
      if (animating) {
        tick(dataRef.current, bodiesRef.current, alphaRef.current, heldRef.current);
        alphaRef.current *= ALPHA_DECAY;
        drawPendingRef.current = true;
        // Track the layout with the camera while it spreads out, rather than
        // framing it once at a moment that turns out not to be the last one.
        if (fitPendingRef.current && !userMovedRef.current && alphaRef.current < 0.42) {
          fitToView();
        }
        if (alphaRef.current <= ALPHA_MIN) fitPendingRef.current = false;
      }
      if (drawPendingRef.current) {
        drawPendingRef.current = false;
        draw();
      }
      if (alphaRef.current > ALPHA_MIN && !reduceRef.current) schedule();
    });
  }, [draw, fitToView]);

  const requestDraw = useCallback(() => {
    drawPendingRef.current = true;
    schedule();
  }, [schedule]);

  const settleNow = useCallback(() => {
    let alpha = 1;
    for (let i = 0; i < SETTLE_TICKS && alpha > ALPHA_MIN; i++) {
      tick(dataRef.current, bodiesRef.current, alpha, null);
      alpha *= ALPHA_DECAY;
    }
    alphaRef.current = 0;
  }, []);

  /** Reheat the layout, or — when motion is off — jump straight to the answer. */
  const reheat = useCallback(
    (amount: number) => {
      if (reduceRef.current) {
        settleNow();
        if (fitPendingRef.current && !userMovedRef.current) {
          fitPendingRef.current = false;
          fitToView();
        }
        requestDraw();
        return;
      }
      alphaRef.current = Math.max(alphaRef.current, amount);
      schedule();
    },
    [schedule, settleNow, requestDraw, fitToView]
  );

  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const px = cx ?? w / 2;
      const py = cy ?? h / 2;
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (next === v.scale) return;
      userMovedRef.current = true;
      // Keep the point under the cursor exactly where it is.
      viewRef.current = {
        scale: next,
        tx: px - ((px - v.tx) / v.scale) * next,
        ty: py - ((py - v.ty) / v.scale) * next,
      };
      requestDraw();
    },
    [requestDraw]
  );

  const centreOn = useCallback(
    (key: string) => {
      const body = bodiesRef.current.get(key);
      if (!body) return;
      userMovedRef.current = true;
      const { w, h } = sizeRef.current;
      const { scale } = viewRef.current;
      viewRef.current = { scale, tx: w / 2 - body.x * scale, ty: h / 2 - body.y * scale };
      requestDraw();
    },
    [requestDraw]
  );

  /* — keeping the refs in step with React state — */

  useEffect(() => {
    reduceRef.current = reduceMotion;
  }, [reduceMotion]);

  useEffect(() => {
    paletteRef.current = readPalette();
    requestDraw();
  }, [themeSpec, requestDraw]);

  useEffect(() => {
    const bodies = bodiesRef.current;
    let added = 0;
    data.nodes.forEach((node, i) => {
      if (bodies.has(node.key)) return;
      const seed = seedAt(bodies.size + i);
      bodies.set(node.key, { x: seed.x, y: seed.y, vx: 0, vy: 0, pinned: false });
      added++;
    });
    // Positions of filtered-out nodes are kept, so toggling a kind back on
    // puts it back where it was rather than throwing it in at random.
    dataRef.current = data;
    if (added || data.nodes.length) {
      fitPendingRef.current = fitPendingRef.current || added > 0;
      reheat(added ? 1 : 0.45);
    }
    requestDraw();
  }, [data, reheat, requestDraw]);

  useEffect(() => {
    dimRef.current = dimmed;
    requestDraw();
  }, [dimmed, requestDraw]);

  useEffect(() => {
    selKeyRef.current = selected ? refKey(selected) : null;
    // Focus is focus *on something*; losing the anchor ends it rather than
    // leaving an armed toggle that does nothing.
    if (!selected) setFocusMode(false);
    requestDraw();
  }, [selected, requestDraw]);

  useEffect(() => {
    const bodies = bodiesRef.current;
    for (const [key, body] of bodies) body.pinned = pinned.has(key);
    requestDraw();
  }, [pinned, requestDraw]);

  /* — canvas sizing, at device pixel ratio — */

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const first = sizeRef.current.w === 0;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Re-frame on resize unless the camera belongs to the user now.
      if (first || !userMovedRef.current) fitToView();
      requestDraw();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    // devicePixelRatio changes when the window moves to another display.
    const media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    media.addEventListener("change", resize);
    return () => {
      ro.disconnect();
      media.removeEventListener("change", resize);
    };
  }, [fitToView, requestDraw]);

  /* — never animate into the void — */

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      } else {
        requestDraw();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [requestDraw]);

  /* — pointer interaction — */

  const hitNode = useCallback((px: number, py: number): GNode | null => {
    const graph = dataRef.current;
    const bodies = bodiesRef.current;
    const { scale } = viewRef.current;
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const node of graph.nodes) {
      const b = bodies.get(node.key);
      if (!b) continue;
      const dx = px - (b.x * scale + viewRef.current.tx);
      const dy = py - (b.y * scale + viewRef.current.ty);
      const r = Math.max(6, node.radius * scale) + 4;
      const d = Math.hypot(dx, dy);
      if (d <= r && d < bestD) {
        best = node;
        bestD = d;
      }
    }
    return best;
  }, []);

  const hitEdge = useCallback((px: number, py: number): GEdge | null => {
    const graph = dataRef.current;
    const bodies = bodiesRef.current;
    const { scale, tx, ty } = viewRef.current;
    let best: GEdge | null = null;
    let bestD = 6;
    for (const e of graph.edges) {
      const a = bodies.get(e.from);
      const b = bodies.get(e.to);
      if (!a || !b) continue;
      const ax = a.x * scale + tx;
      const ay = a.y * scale + ty;
      const bx = b.x * scale + tx;
      const by = b.y * scale + ty;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const off = e.bend * 15 * Math.min(1, scale);
      const cx = (ax + bx) / 2 - (dy / len) * off * 2;
      const cy = (ay + by) / 2 + (dx / len) * off * 2;
      const mx = 0.25 * ax + 0.5 * cx + 0.25 * bx;
      const my = 0.25 * ay + 0.5 * cy + 0.25 * by;
      // Two straight segments through the curve's midpoint: close enough for a
      // 6px hover target, and a fraction of the cost of sampling the curve.
      const d = Math.min(segDist(px, py, ax, ay, mx, my), segDist(px, py, mx, my, bx, by));
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let mode: "none" | "pan" | "node" = "none";
    let pointerId = -1;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    let grabbed: GNode | null = null;

    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      canvas.focus();
      const { x, y } = local(e);
      lastX = x;
      lastY = y;
      moved = 0;
      pointerId = e.pointerId;
      // Capture keeps a drag alive past the window edge. It throws for a
      // pointer that has already been released, which must not kill the drag.
      try {
        canvas.setPointerCapture(pointerId);
      } catch {
        pointerId = -1;
      }
      grabbed = hitNode(x, y);
      if (grabbed) {
        mode = "node";
        heldRef.current = grabbed.key;
      } else {
        mode = "pan";
      }
      canvas.classList.toggle("gr-grabbing", true);
    };

    const onMove = (e: PointerEvent) => {
      const { x, y } = local(e);
      if (mode === "none") {
        const node = hitNode(x, y);
        const nextNode = node ? node.key : null;
        const nextEdge = node ? null : hitEdge(x, y);
        if (nextNode !== hoverNodeRef.current || nextEdge?.id !== hoverEdgeRef.current?.id) {
          hoverNodeRef.current = nextNode;
          hoverEdgeRef.current = nextEdge;
          canvas.style.cursor = nextNode ? "pointer" : nextEdge ? "help" : "grab";
          requestDraw();
        }
        return;
      }

      const dx = x - lastX;
      const dy = y - lastY;
      lastX = x;
      lastY = y;
      moved += Math.abs(dx) + Math.abs(dy);

      if (mode === "pan") {
        userMovedRef.current = true;
        viewRef.current = {
          ...viewRef.current,
          tx: viewRef.current.tx + dx,
          ty: viewRef.current.ty + dy,
        };
        requestDraw();
        return;
      }

      if (mode === "node" && grabbed) {
        const body = bodiesRef.current.get(grabbed.key);
        if (!body) return;
        userMovedRef.current = true;
        const { scale } = viewRef.current;
        body.x += dx / scale;
        body.y += dy / scale;
        body.vx = 0;
        body.vy = 0;
        // Let the neighbours follow the node being dragged — that motion is
        // what makes the structure legible. Off entirely under reduced motion.
        if (!reduceRef.current) alphaRef.current = Math.max(alphaRef.current, 0.32);
        requestDraw();
        schedule();
      }
    };

    const finish = (e: PointerEvent) => {
      if (pointerId !== -1 && canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
      canvas.classList.toggle("gr-grabbing", false);
      const wasMode = mode;
      const node = grabbed;
      mode = "none";
      grabbed = null;
      heldRef.current = null;
      pointerId = -1;

      if (wasMode === "node" && node) {
        if (moved < 4) {
          // A click selects; the drag is what pins.
          setSelected(node.ref);
          useStore.getState().setInspect(node.ref);
        } else {
          setPinned((prev) => {
            if (prev.has(node.key)) return prev;
            const next = new Set(prev);
            next.add(node.key);
            return next;
          });
          if (reduceRef.current) {
            settleNow();
            requestDraw();
          }
        }
      } else if (wasMode === "pan" && moved < 4) {
        const { x, y } = local(e);
        // Clicking bare background clears the selection, the way a canvas app
        // does — but only when it really was a click, not the end of a pan.
        if (!hitEdge(x, y)) setSelected(null);
      }
    };

    const onDouble = (e: MouseEvent) => {
      const { x, y } = local(e);
      const node = hitNode(x, y);
      if (!node) return;
      e.preventDefault();
      setSelected(node.ref);
      if (node.info.view) useStore.getState().setView(node.info.view);
      else if (node.info.href) window.open(node.info.href, "_blank", "noreferrer");
    };

    // Non-passive: a trackpad pinch (wheel + ctrlKey) and a wheel zoom both
    // have to beat the page's own scroll handling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = local(e);
      const intensity = e.ctrlKey ? 0.012 : 0.0022;
      zoomBy(Math.exp(-e.deltaY * intensity), x, y);
    };

    const onLeave = () => {
      if (hoverNodeRef.current || hoverEdgeRef.current) {
        hoverNodeRef.current = null;
        hoverEdgeRef.current = null;
        requestDraw();
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("dblclick", onDouble);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", finish);
      canvas.removeEventListener("pointercancel", finish);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDouble);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [hitNode, hitEdge, requestDraw, schedule, settleNow, zoomBy]);

  /* — commands — */

  const toggleIn = (setter: typeof setHiddenKinds) => (key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleKind = toggleIn(setHiddenKinds);
  const toggleRel = toggleIn(setHiddenRels);

  const resetFilters = () => {
    setHiddenKinds(new Set());
    setHiddenRels(new Set());
    setQuery("");
    setProjectId("");
  };

  const releasePins = () => {
    setPinned(new Set());
    reheat(0.6);
  };

  const togglePin = (key: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    reheat(0.4);
  };

  const onCanvasKey = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 160 : 60;
    const v = viewRef.current;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        userMovedRef.current = true;
        viewRef.current = {
          ...v,
          tx: v.tx + (e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0),
          ty: v.ty + (e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0),
        };
        requestDraw();
        break;
      }
      case "+":
      case "=":
        e.preventDefault();
        zoomBy(1.25);
        break;
      case "-":
      case "_":
        e.preventDefault();
        zoomBy(0.8);
        break;
      case "0":
        e.preventDefault();
        // Asking to be framed again hands the camera back to the layout.
        userMovedRef.current = false;
        fitToView();
        requestDraw();
        break;
      case "Escape":
        if (selected) {
          e.preventDefault();
          setSelected(null);
        }
        break;
      case "Enter":
        if (selected) {
          const info = describeEntity(selected);
          if (info.view) {
            e.preventDefault();
            useStore.getState().setView(info.view);
          }
        }
        break;
    }
  };

  /* — rail data — */

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = (n: GNode) => (dimmed && dimmed.has(n.key) ? 1 : 0);
    return [...data.nodes]
      .sort((a, b) => rank(a) - rank(b) || b.degree - a.degree || a.info.title.localeCompare(b.info.title))
      .slice(0, q ? 200 : 120);
  }, [data, dimmed, query]);

  const edgeCount = data.edges.length;
  const summary = graphIsEmpty
    ? "Nothing is connected yet."
    : `${data.nodes.length} thing${data.nodes.length === 1 ? "" : "s"}, ${edgeCount} connection${
        edgeCount === 1 ? "" : "s"
      }${query.trim() ? ` · ${matches} match${matches === 1 ? "" : "es"}` : ""}`;

  return (
    <div className="main-pane gr">
      <div className="pane-header">
        <div>
          <div className="pane-title">Connections</div>
          <div className="pane-sub">{summary}</div>
        </div>
        <button className="btn primary" onClick={() => setPicking(true)}>
          <IconPlus size={12} /> Connect
        </button>
      </div>

      <div className="gr-body">
        {/* With nothing drawn anywhere there is nothing to filter, and an empty
            rail of empty headings is worse than no rail. */}
        {!nothingAnywhere && (
        <aside className="gr-rail" aria-label="Graph filters">
          <div className="gr-search">
            <IconSearch size={13} className="gr-search-icon" />
            <input
              type="search"
              value={query}
              placeholder="Dim everything but…"
              aria-label="Search the graph"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="gr-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
                <IconX size={10} />
              </button>
            )}
          </div>

          <Field label="Project">
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                fitPendingRef.current = true;
              }}
            >
              <option value="">Everything</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <section className="gr-group">
            <h3 className="gr-group-title">Show</h3>
            <div className="gr-toggles">
              {ENTITY_KINDS.filter((k) => (kindCounts.get(k.type) ?? 0) > 0).map((k) => {
                const on = !hiddenKinds.has(k.type);
                return (
                  <button
                    key={k.type}
                    className={"gr-toggle" + (on ? " on" : "")}
                    aria-pressed={on}
                    onClick={() => toggleKind(k.type)}
                  >
                    <span className="gr-dot" style={{ background: k.tone }} aria-hidden="true" />
                    <span className="gr-toggle-label">{k.plural}</span>
                    <span className="gr-toggle-count">{kindCounts.get(k.type)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="gr-group">
            <h3 className="gr-group-title">Relations</h3>
            <div className="gr-toggles">
              {(relCounts.get(ASSIGN_FILTER) ?? 0) > 0 && (
                <button
                  className={"gr-toggle" + (!hiddenRels.has(ASSIGN_FILTER) ? " on" : "")}
                  aria-pressed={!hiddenRels.has(ASSIGN_FILTER)}
                  onClick={() => toggleRel(ASSIGN_FILTER)}
                >
                  <span className="gr-glyph gr-glyph-assign" aria-hidden="true">
                    {ASSIGN_GLYPH}
                  </span>
                  <span className="gr-toggle-label">assigned to</span>
                  <span className="gr-toggle-count">{relCounts.get(ASSIGN_FILTER)}</span>
                </button>
              )}
              {LINK_KINDS.filter((k) => (relCounts.get(k.kind) ?? 0) > 0).map((k) => {
                const on = !hiddenRels.has(k.kind);
                return (
                  <button
                    key={k.kind}
                    className={"gr-toggle" + (on ? " on" : "")}
                    aria-pressed={on}
                    onClick={() => toggleRel(k.kind)}
                  >
                    <span className="gr-glyph" aria-hidden="true">
                      {k.glyph}
                    </span>
                    <span className="gr-toggle-label">{k.label}</span>
                    <span className="gr-toggle-count">{relCounts.get(k.kind)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="gr-group">
            <h3 className="gr-group-title">Focus</h3>
            <button
              className={"gr-toggle wide" + (focusMode ? " on" : "")}
              aria-pressed={focusMode}
              disabled={!selected}
              onClick={() => setFocusMode((f) => !f)}
            >
              <span className="gr-glyph" aria-hidden="true">
                ◎
              </span>
              <span className="gr-toggle-label">
                {selected ? "Fade the rest" : "Select a node first"}
              </span>
            </button>
            <div className="gr-depth" role="group" aria-label="Focus depth">
              {[1, 2].map((d) => (
                <button
                  key={d}
                  className={"gr-depth-btn" + (focusDepth === d ? " on" : "")}
                  aria-pressed={focusDepth === d}
                  disabled={!focusMode || !selected}
                  onClick={() => setFocusDepth(d)}
                >
                  {d} hop{d === 1 ? "" : "s"}
                </button>
              ))}
            </div>
          </section>

          {data.nodes.length > 0 && (
            <section className="gr-group">
              <h3 className="gr-group-title">
                Nodes <span className="gr-group-count">{data.nodes.length}</span>
              </h3>
              <ul className="gr-nodes">
                {listed.map((node) => (
                  <li key={node.key}>
                    <button
                      className={
                        "gr-node-row" +
                        (selected && refKey(selected) === node.key ? " on" : "") +
                        (dimmed?.has(node.key) ? " off" : "")
                      }
                      aria-pressed={!!selected && refKey(selected) === node.key}
                      onClick={() => {
                        setSelected(node.ref);
                        useStore.getState().setInspect(node.ref);
                        centreOn(node.key);
                      }}
                    >
                      <span className="gr-node-glyph" style={{ color: node.info.tone }} aria-hidden="true">
                        {node.info.glyph}
                      </span>
                      <span className="gr-node-title">{node.info.title}</span>
                      <span className="gr-node-degree">{node.degree}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {data.nodes.length > listed.length && (
                <div className="gr-note">
                  +{data.nodes.length - listed.length} more — search to narrow the list.
                </div>
              )}
            </section>
          )}

          <div className="gr-rail-foot">
            <button className="btn tiny" onClick={resetFilters}>
              Reset filters
            </button>
            <button className="btn tiny" onClick={releasePins} disabled={pinned.size === 0}>
              Release {pinned.size} pin{pinned.size === 1 ? "" : "s"}
            </button>
          </div>
        </aside>
        )}

        <div className="gr-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="gr-canvas"
            tabIndex={0}
            role="application"
            aria-label="Connection map. Drag to pan, scroll to zoom, arrow keys to move. Use the node list in the sidebar to select a node with the keyboard."
            onKeyDown={onCanvasKey}
          />

          <div className="gr-zoom" role="group" aria-label="Zoom">
            <button className="gr-zoom-btn" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
              +
            </button>
            <button className="gr-zoom-btn" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
              −
            </button>
            <button
              className="gr-zoom-btn"
              aria-label="Fit graph to view"
              onClick={() => {
                userMovedRef.current = false;
                fitToView();
                requestDraw();
              }}
            >
              ⤢
            </button>
          </div>

          {!graphIsEmpty && !filteredToNothing && (
            <div className="gr-hint" aria-hidden="true">
              Drag a node to pin it · double-click to open it
            </div>
          )}

          {selected && !graphIsEmpty && (
            <SelectionCard
              target={selected}
              degree={data.byKey.get(refKey(selected))?.degree ?? 0}
              pinned={pinned.has(refKey(selected))}
              focusOn={focusMode}
              onTogglePin={() => togglePin(refKey(selected))}
              onToggleFocus={() => setFocusMode((f) => !f)}
              onCentre={() => centreOn(refKey(selected))}
              onClose={() => setSelected(null)}
            />
          )}

          {nothingAnywhere && <GraphEmptyState onConnect={() => setPicking(true)} />}

          {graphIsEmpty && !nothingAnywhere && (
            <div className="gr-empty">
              <div className="gr-empty-card">
                <div className="gr-empty-title">Nothing connected in this project</div>
                <p className="gr-empty-text">
                  Other projects have connections. Widen the scope to see them, or draw the first
                  one here.
                </p>
                <div className="gr-empty-actions">
                  <button className="btn" onClick={() => setProjectId("")}>
                    Show everything
                  </button>
                  <button className="btn primary" onClick={() => setPicking(true)}>
                    <IconPlus size={12} /> Connect
                  </button>
                </div>
              </div>
            </div>
          )}

          {filteredToNothing && (
            <div className="gr-empty">
              <div className="gr-empty-card">
                <div className="gr-empty-title">Nothing left to draw</div>
                <p className="gr-empty-text">
                  Every node is filtered out. Turn a kind or a relation back on, or widen the
                  project scope.
                </p>
                <button className="btn" onClick={resetFilters}>
                  Reset filters
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {picking && <ConnectEntitiesModal onClose={() => setPicking(false)} seed={selected} />}
    </div>
  );
}

/* ── canvas helpers ───────────────────────────────────────────── */

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawPill(ctx: CanvasRenderingContext2D, p: Palette, text: string, x: number, y: number): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = `600 11px ${p.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 14;
  const h = 19;
  ctx.beginPath();
  const r = 9;
  const left = x - w / 2;
  const top = y - h / 2;
  ctx.moveTo(left + r, top);
  ctx.arcTo(left + w, top, left + w, top + h, r);
  ctx.arcTo(left + w, top + h, left, top + h, r);
  ctx.arcTo(left, top + h, left, top, r);
  ctx.arcTo(left, top, left + w, top, r);
  ctx.closePath();
  ctx.fillStyle = p.overlay;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = p.border;
  ctx.stroke();
  ctx.fillStyle = p.text;
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

/* ── selection card ───────────────────────────────────────────── */

function SelectionCard({
  target,
  degree,
  pinned,
  focusOn,
  onTogglePin,
  onToggleFocus,
  onCentre,
  onClose,
}: {
  target: EntityRef;
  /** Edges currently drawn for this node — not its lifetime total, which the
      filters may be hiding. The card must agree with the picture. */
  degree: number;
  pinned: boolean;
  focusOn: boolean;
  onTogglePin: () => void;
  onToggleFocus: () => void;
  onCentre: () => void;
  onClose: () => void;
}) {
  const info = useEntity(target);
  const spec = KIND_BY_TYPE[target.type];
  const kindLabel = spec?.label ?? target.type;
  // Some subtitles already open with their kind ("Pull request on acme/atlas");
  // prefixing those would stutter.
  const kindLine = info.subtitle.toLowerCase().startsWith(kindLabel.toLowerCase())
    ? info.subtitle
    : kindLabel + (info.subtitle ? ` · ${info.subtitle}` : "");

  return (
    <div className="gr-card" role="group" aria-label={`Selected: ${info.title}`}>
      <button className="gr-card-close" aria-label="Clear selection" onClick={onClose}>
        <IconX size={10} />
      </button>
      <div className="gr-card-head">
        <span className="gr-card-glyph" style={{ color: info.tone }} aria-hidden="true">
          {info.glyph}
        </span>
        <div className="gr-card-ident">
          <div className="gr-card-title">{info.title}</div>
          <div className="gr-card-kind">{kindLine}</div>
        </div>
      </div>
      <div className="gr-card-meta">
        {degree} connection{degree === 1 ? "" : "s"} here
        {pinned ? " · pinned" : ""}
      </div>
      <div className="gr-card-actions">
        {info.view ? (
          <button className="btn tiny" onClick={() => useStore.getState().setView(info.view!)}>
            Open
          </button>
        ) : (
          info.href && (
            <a className="btn tiny" href={info.href} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          )
        )}
        <button className="btn tiny" onClick={onCentre}>
          Centre
        </button>
        <button className="btn tiny" aria-pressed={focusOn} onClick={onToggleFocus}>
          {focusOn ? "Unfocus" : "Focus"}
        </button>
        <button className="btn tiny" aria-pressed={pinned} onClick={onTogglePin}>
          {pinned ? "Unpin" : "Pin"}
        </button>
      </div>
    </div>
  );
}

/* ── empty state ──────────────────────────────────────────────── */

const EMPTY_EXAMPLES: { glyph: string; tone: string; text: string }[] = [
  { glyph: "◆", tone: "var(--purple)", text: "A memory entry → a channel, so its agents know it." },
  { glyph: "✓", tone: "var(--green)", text: "A task → the pull request that closes it." },
  { glyph: "✳", tone: "var(--orange)", text: "An agent → the work it owns." },
];

function GraphEmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="gr-empty">
      <div className="gr-empty-card wide">
        <div className="gr-empty-mark" aria-hidden="true">
          <svg viewBox="0 0 120 74" width="132" height="82">
            <line x1="24" y1="20" x2="60" y2="40" />
            <line x1="60" y1="40" x2="98" y2="18" />
            <line x1="60" y1="40" x2="40" y2="62" />
            <circle cx="24" cy="20" r="7" />
            <circle cx="98" cy="18" r="5.5" />
            <circle cx="40" cy="62" r="5" />
            <circle cx="60" cy="40" r="9.5" className="gr-empty-hub" />
          </svg>
        </div>
        <div className="gr-empty-title">Nothing is connected yet</div>
        <p className="gr-empty-text">
          This map draws the links you make between things in Spaces, plus every agent or team
          assigned to something. Connect two things and they show up here as a shape you can
          navigate.
        </p>
        <ul className="gr-empty-list">
          {EMPTY_EXAMPLES.map((x) => (
            <li key={x.text}>
              <span className="gr-empty-glyph" style={{ color: x.tone }} aria-hidden="true">
                {x.glyph}
              </span>
              {x.text}
            </li>
          ))}
        </ul>
        <p className="gr-empty-text gr-empty-why">
          Connections aren't decoration: what a channel is linked to is fed to its agents as
          standing context on every run.
        </p>
        <button className="btn primary" onClick={onConnect}>
          <IconPlus size={12} /> Connect two things
        </button>
      </div>
    </div>
  );
}

/* ── link picker ──────────────────────────────────────────────── */

/**
 * Draw a link between any two entities. Lives here because the graph is the
 * first place that needs it, but it is self-contained — anything with a
 * "connect" affordance can render it.
 */
export function ConnectEntitiesModal({
  onClose,
  seed,
}: {
  onClose: () => void;
  seed?: EntityRef | null;
}) {
  const [from, setFrom] = useState<EntityRef | null>(seed ?? null);
  const [to, setTo] = useState<EntityRef | null>(null);
  const [kind, setKind] = useState<LinkKind>("relates");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const spec = LINK_KIND_BY_ID[kind];

  const submit = async () => {
    if (!from || !to || busy) return;
    setBusy(true);
    try {
      const link = await useStore.getState().addLink(from, to, kind, note.trim(), "user");
      if (!link) {
        toast.warn("Nothing to connect", "A thing cannot be linked to itself.");
        setBusy(false);
        return;
      }
      toast.success(
        "Connected",
        `${describeEntity(from).title} ${spec.label} ${describeEntity(to).title}`
      );
      onClose();
    } catch (e) {
      toast.error("Could not draw that connection", e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect two things" onClose={onClose} wide>
      <div className="gr-connect">
        <EntityPickerField label="From" value={from} onPick={setFrom} exclude={to} />

        <Field label="Relation">
          <select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)}>
            {LINK_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.glyph}  {k.label}
              </option>
            ))}
          </select>
        </Field>

        <EntityPickerField label="To" value={to} onPick={setTo} exclude={from} />

        <Field label="Note (optional)">
          <input
            value={note}
            placeholder="Why these two are connected"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {from && to && (
          <div className="gr-connect-preview">
            <EntityChip ref={from} size="sm" />
            <span className="gr-connect-rel">
              {spec.glyph} {spec.label}
            </span>
            <EntityChip ref={to} size="sm" />
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!from || !to || busy} onClick={submit}>
            <IconCheck size={12} /> Connect
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EntityPickerField({
  label,
  value,
  onPick,
  exclude,
}: {
  label: string;
  value: EntityRef | null;
  onPick: (ref: EntityRef | null) => void;
  exclude: EntityRef | null;
}) {
  const [q, setQ] = useState("");
  const inputId = useId();
  // searchEntities projects these tables, so a task renamed in another window
  // has to re-rank the results here.
  const tasks = useStore((s) => s.tasks);
  const memory = useStore((s) => s.memory);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const projects = useStore((s) => s.projects);

  const results = useMemo(() => {
    const linkable = new Set(ENTITY_KINDS.filter((k) => k.linkable).map((k) => k.type));
    return searchEntities(q, { limit: 8 }).filter(
      (info) =>
        linkable.has(info.ref.type) &&
        !(exclude && exclude.type === info.ref.type && exclude.id === info.ref.id)
    );
  }, [q, exclude, tasks, memory, channels, agents, teams, projects]);

  // Deliberately not the shared <Field>: a <label> that wraps a result list
  // would make every click on a result land on the input instead.
  return (
    <div className="gr-field">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      {value ? (
        <div className="gr-picked" id={inputId}>
          <EntityChip ref={value} showType onRemove={() => onPick(null)} />
        </div>
      ) : (
        <>
          <input
            id={inputId}
            value={q}
            placeholder="Search tasks, channels, memory, agents…"
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="gr-results">
            {results.map((info) => (
              <li key={refKey(info.ref)}>
                <button className="gr-result" onClick={() => onPick(info.ref)}>
                  <span className="gr-result-glyph" style={{ color: info.tone }} aria-hidden="true">
                    {info.glyph}
                  </span>
                  <span className="gr-result-title">{info.title}</span>
                  <span className="gr-result-sub">{info.subtitle}</span>
                </button>
              </li>
            ))}
            {!results.length && <li className="gr-results-empty">Nothing matches “{q}”.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
