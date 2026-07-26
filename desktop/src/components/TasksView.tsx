/**
 * The task board.
 *
 * Three ideas hold this file together:
 *
 *  1. Order is data. `sort_order` is a real column, so dragging a card up two
 *     places has to survive a reload. It is an INTEGER, which means there is no
 *     midpoint to slot into — the destination column is renumbered instead.
 *  2. A card is a view onto an entity, not a row. Single click inspects, double
 *     click edits, and everything the graph knows about the task (who reviews
 *     it, what it blocks, which subtasks are done) is on the card itself.
 *  3. Every mouse affordance has a keyboard twin. Dragging is the obvious way
 *     to move a card and must not regress, so keyboard carry reuses the same
 *     drop-target state and the same commit path — one implementation, two
 *     input devices.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { useStore, channelAgents } from "../store";
import { getDb, uid } from "../db";
import { triggerAgents, userTrigger } from "../agents";
import { slug } from "../types";
import type { Agent, EntityRef, Project, Run, Task, TaskStatus, View } from "../types";
import { assigneesOf } from "../links";
import { timeAgo } from "../github";
import { confirmAction, toast } from "../toast";
import { Avatar, Field } from "./ui";
import { EntityAvatarStack } from "./EntityChip";
import { ConnectionsPanel, ConnectionsSummary } from "./ConnectionsPanel";
import { PanelSection, SidePanel, usePanel } from "./SidePanel";
import { IconCheck, IconChevronDown, IconEdit, IconFilter, IconPlus, IconSearch } from "./icons";
import "./board.css";

/* ── shape of the board ───────────────────────────────────────── */

interface ColumnSpec {
  key: TaskStatus;
  label: string;
  /** Said when the column is empty and no filter is hiding anything. */
  empty: string;
}

const COLUMNS: ColumnSpec[] = [
  { key: "backlog", label: "Backlog", empty: "Nothing parked here" },
  { key: "todo", label: "To do", empty: "Nothing queued" },
  { key: "doing", label: "In progress", empty: "Nothing in flight" },
  { key: "done", label: "Done", empty: "Nothing finished yet" },
];

/** What the swimlanes divide the board by. Columns are always status. */
type GroupBy = "status" | "assignee" | "project";

const GROUPS: { id: GroupBy; label: string; help: string }[] = [
  { id: "status", label: "Status", help: "One set of columns for the whole board" },
  { id: "assignee", label: "Assignee", help: "A lane per agent; dropping into a lane reassigns the task" },
  { id: "project", label: "Project", help: "A lane per project; dropping into a lane moves the task" },
];

type SortMode = "manual" | "due" | "newest" | "oldest" | "title";

const SORTS: { id: SortMode; label: string }[] = [
  { id: "manual", label: "Manual order" },
  { id: "due", label: "Due date" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title" },
];

type DueFilter = "any" | "overdue" | "today" | "week" | "none";

const DUE_FILTERS: { id: DueFilter; label: string }[] = [
  { id: "any", label: "Any" },
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "none", label: "No date" },
];

/** A swimlane. `id` is '' for the unassigned lane; `key` is always unique. */
interface Lane {
  key: string;
  id: string;
  name: string;
  sub?: string;
  agent?: Agent;
  project?: Project;
}

/** Where a carried card would land. */
interface DropTarget {
  laneKey: string;
  status: TaskStatus;
  /** Position in the destination column *excluding* the carried card. */
  index: number;
}

/** A card in flight, from either input device. */
interface Carry {
  id: string;
  via: "mouse" | "keys";
}

/**
 * Which card holds the tab order, and whether the board has *asked* for it to
 * take focus. `seq` makes each request unique; `at` dates it, which is what
 * lets a card that has only just mounted tell "I was carried here a moment ago"
 * apart from "a filter change brought me back an hour later".
 */
interface FocusState {
  id: string;
  seq: number;
  at: number;
}

/** How long a focus request stays valid for a card that mounts into it. */
const FOCUS_GRACE_MS = 1200;

/* ── persisted toolbar state ──────────────────────────────────── */

const PREFS_KEY = "spaces.board.prefs";

interface Prefs {
  scope: string; // project id, or 'all'
  groupBy: GroupBy;
  sort: SortMode;
}

const DEFAULT_PREFS: Prefs = { scope: "all", groupBy: "status", sort: "manual" };

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // hand-edited, or private mode — the defaults are always fine
    return DEFAULT_PREFS;
  }
}

/* ── dates ────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type DueTone = "overdue" | "today" | "soon" | "later" | "done";

interface DueMeta {
  tone: DueTone;
  /** Short enough for a chip. */
  label: string;
  /** The whole date, for the title attribute and screen readers. */
  full: string;
  days: number;
}

/**
 * Urgency, not just a date. "3 days late" and "Tomorrow" are the two facts a
 * person scanning a column actually wants; the calendar date is in the tooltip
 * for when they want to be precise.
 */
function dueMeta(due: string, status: TaskStatus): DueMeta | null {
  if (!due) return null;
  const at = Date.parse(`${due}T00:00:00`);
  if (!Number.isFinite(at)) return null;
  const days = Math.round((at - Date.parse(`${todayISO()}T00:00:00`)) / DAY_MS);
  const d = new Date(at);
  const short = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const full = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  if (status === "done") return { tone: "done", label: short, full, days };
  if (days < 0) return { tone: "overdue", label: days === -1 ? "1 day late" : `${-days} days late`, full, days };
  if (days === 0) return { tone: "today", label: "Today", full, days };
  if (days === 1) return { tone: "soon", label: "Tomorrow", full, days };
  if (days <= 7) return { tone: "soon", label: d.toLocaleDateString(undefined, { weekday: "short" }), full, days };
  return { tone: "later", label: short, full, days };
}

/* ── labels ───────────────────────────────────────────────────── */

/**
 * There is no labels column and this file may not add one, so labels are the
 * `#tag` words people already write in a title or description. Leading letter
 * required, which keeps `#412` (an issue number) from becoming a label.
 */
const LABEL_RE = /(?:^|[\s([])#([a-z][a-z0-9._/-]{0,28})/gi;

interface Labels {
  /** Everything the filters match on. */
  all: string[];
  /** Only the ones the title doesn't already show, so a card never repeats itself. */
  hidden: string[];
}

function tagsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LABEL_RE)) {
    const tag = m[1].toLowerCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function labelsOf(t: Task): Labels {
  const title = tagsIn(t.title);
  const body = tagsIn(t.description);
  return {
    all: [...title, ...body.filter((x) => !title.includes(x))],
    hidden: body.filter((x) => !title.includes(x)),
  };
}

/* ── run state ────────────────────────────────────────────────── */

function taskRunning(t: Task, runs: Record<string, Run>, activeRunIds: string[]): boolean {
  if (!t.last_run_id) return false;
  if (activeRunIds.includes(t.last_run_id)) return true;
  return runs[t.last_run_id]?.status === "running";
}

/* ── writes ───────────────────────────────────────────────────── */

/** Gap between neighbours after a renumber, so most later drops write one row. */
const ORDER_STRIDE = 16;

/**
 * Persist the order of one column.
 *
 * `sort_order` is an INTEGER, so a card cannot be slotted between two
 * neighbours by number alone — the column is renumbered with a stride, and only
 * the rows whose number actually moved are written. The writes go straight to
 * the database rather than through `updateTask` because that action reloads
 * every table per call, and doing that once per card would turn a drag into a
 * stutter. The caller refreshes once, at the end.
 *
 * Returns true when anything was written.
 */
async function persistOrder(ordered: Task[]): Promise<boolean> {
  const writes = ordered
    .map((t, i) => ({ id: t.id, order: i * ORDER_STRIDE, was: t.sort_order }))
    .filter((w) => w.order !== w.was);
  if (!writes.length) return false;
  const db = await getDb();
  for (const w of writes) {
    await db.execute("UPDATE tasks SET sort_order = $1 WHERE id = $2", [w.order, w.id]);
  }
  return true;
}

/**
 * Put an agent on a task as its one canonical assignee.
 *
 * `store.assign` mirrors the assignee role into `task.assignee_agent_id`, so
 * going through the graph — rather than patching the column directly — is what
 * keeps the board, the avatar stack and the prompt builder telling the same
 * story. Stale assignee rows are dropped first: a task has exactly one primary.
 */
async function setPrimaryAssignee(taskId: string, agentId: string): Promise<void> {
  const s = useStore.getState();
  const target: EntityRef = { type: "task", id: taskId };
  for (const a of s.assignmentsFor(target)) {
    if (a.role === "assignee" && a.subject_id !== agentId) await s.unassign(a.id);
  }
  if (agentId) {
    await s.assign({ type: "agent", id: agentId }, target, "assignee");
  } else if (useStore.getState().tasks.find((t) => t.id === taskId)?.assignee_agent_id) {
    // No assignment row existed (an older task, or one assigned before the
    // graph did) — the column still has to be cleared.
    await s.updateTask(taskId, { assignee_agent_id: "" });
  }
}

/**
 * Put a deleted task back, id and all.
 *
 * `deleteTask` deliberately leaves links and assignments behind (they render as
 * tombstones until something claims them again), so restoring the same id
 * restores the task's whole neighbourhood with it. That is what makes Undo an
 * honest offer rather than a copy.
 */
async function restoreTask(t: Task): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO tasks (id, project_id, title, description, status, assignee_agent_id, due_date, sort_order, branch, last_run_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [t.id, t.project_id, t.title, t.description, t.status, t.assignee_agent_id, t.due_date, t.sort_order, t.branch, t.last_run_id, t.created_at]
  );
  await useStore.getState().refreshAll();
}

async function deleteTaskWithUndo(task: Task): Promise<boolean> {
  const ok = await confirmAction({
    title: "Delete this task?",
    body: `“${task.title}” goes away for everyone. You can undo it from the toast.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return false;
  try {
    await useStore.getState().deleteTask(task.id);
    toast.show({
      kind: "info",
      title: "Task deleted",
      detail: task.title,
      action: { label: "Undo", run: () => void restoreTask(task) },
    });
    return true;
  } catch (e) {
    toast.error("Could not delete that task", e);
    return false;
  }
}

/* ── the view ─────────────────────────────────────────────────── */

export function TasksView() {
  const store = useStore();
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<string[]>([]);
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const [dueFilter, setDueFilter] = useState<DueFilter>("any");
  const [mineOnly, setMineOnly] = useState(false);

  /*
   * Both hold a task *id*, not a row: the panel stays open while you work, and
   * a card the board re-sorted underneath it must not leave the panel editing a
   * copy of how the task used to be.
   */
  const edit = usePanel<string>();
  const assign = usePanel<string>();
  const [carry, setCarry] = useState<Carry | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [focus, setFocus] = useState<FocusState>({ id: "", seq: 0, at: 0 });
  const [announce, setAnnounce] = useState("");

  const searchRef = useRef<HTMLInputElement | null>(null);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // the board still works, it just forgets between launches
      }
      return next;
    });
  }, []);

  /* scope ------------------------------------------------------- */

  const projects = store.projects;
  const scope = projects.some((p) => p.id === prefs.scope) ? prefs.scope : "all";
  const inScope = useMemo(
    () => store.tasks.filter((t) => scope === "all" || t.project_id === scope),
    [store.tasks, scope]
  );

  /* filtering --------------------------------------------------- */

  const labelIndex = useMemo(() => {
    const map = new Map<string, Labels>();
    for (const t of inScope) map.set(t.id, labelsOf(t));
    return map;
  }, [inScope]);

  const allLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tags of labelIndex.values()) {
      for (const tag of tags.all) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
  }, [labelIndex]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    return inScope.filter((t) => {
      if (mineOnly && (t.status === "done" || t.assignee_agent_id)) return false;
      if (needle && !`${t.title} ${t.description}`.toLowerCase().includes(needle)) return false;
      if (assigneeFilter.length && !assigneeFilter.includes(t.assignee_agent_id || "")) return false;
      if (labelFilter.length) {
        const tags = labelIndex.get(t.id)?.all ?? [];
        if (!labelFilter.every((l) => tags.includes(l))) return false;
      }
      if (dueFilter !== "any") {
        const meta = dueMeta(t.due_date, t.status);
        if (dueFilter === "none" && meta) return false;
        if (dueFilter === "overdue" && meta?.tone !== "overdue") return false;
        if (dueFilter === "today" && !(meta && meta.days === 0 && t.status !== "done")) return false;
        if (dueFilter === "week" && !(meta && meta.days <= 7 && t.status !== "done")) return false;
      }
      return true;
    });
  }, [inScope, mineOnly, needle, assigneeFilter, labelFilter, labelIndex, dueFilter]);

  const filtering =
    !!needle || !!assigneeFilter.length || !!labelFilter.length || dueFilter !== "any" || mineOnly;
  /**
   * What the Filter control's badge counts. The search box is on the toolbar in
   * person, so counting it here would be the one control reporting itself twice.
   */
  const filterCount =
    assigneeFilter.length + labelFilter.length + (dueFilter !== "any" ? 1 : 0) + (mineOnly ? 1 : 0);
  /** Only manual order has a position to save — see `commit`. */
  const ordered = prefs.sort === "manual";

  const clearFilters = useCallback(() => {
    setQuery("");
    setAssigneeFilter([]);
    setLabelFilter([]);
    setDueFilter("any");
    setMineOnly(false);
  }, []);

  /* lanes ------------------------------------------------------- */

  const lanes: Lane[] = useMemo(() => {
    if (prefs.groupBy === "assignee") {
      // Lanes come from what is in scope, not from what survives the filters —
      // otherwise typing in the search box removes the lane you were dragging
      // towards.
      const withWork = store.agents.filter((a) => inScope.some((t) => t.assignee_agent_id === a.id));
      return [
        ...withWork.map((a) => ({ key: `a:${a.id}`, id: a.id, name: a.name, sub: a.role || a.kind, agent: a })),
        { key: "a:", id: "", name: "Unassigned", sub: "Nobody has picked these up" },
      ];
    }
    if (prefs.groupBy === "project") {
      const list = scope === "all" ? projects : projects.filter((p) => p.id === scope);
      return list.map((p) => ({ key: `p:${p.id}`, id: p.id, name: p.name, sub: p.repo, project: p }));
    }
    return [{ key: "all", id: "", name: "" }];
  }, [prefs.groupBy, store.agents, inScope, projects, scope]);

  const laneOf = useCallback(
    (t: Task): string => {
      if (prefs.groupBy === "assignee") {
        // A task pointing at a deleted agent belongs in Unassigned, not in a
        // lane that no longer renders — otherwise it silently leaves the board.
        const known = t.assignee_agent_id && store.agents.some((a) => a.id === t.assignee_agent_id);
        return `a:${known ? t.assignee_agent_id : ""}`;
      }
      if (prefs.groupBy === "project") return `p:${t.project_id}`;
      return "all";
    },
    [prefs.groupBy, store.agents]
  );

  /** lane key + status → the cards in that column, in display order. */
  const columns = useMemo(() => {
    const by = new Map<string, Task[]>();
    for (const t of visible) {
      const key = `${laneOf(t)} ${t.status}`;
      const list = by.get(key);
      if (list) list.push(t);
      else by.set(key, [t]);
    }
    for (const [key, list] of by) by.set(key, sortTasks(list, prefs.sort));
    return by;
  }, [visible, laneOf, prefs.sort]);

  const cardsIn = useCallback(
    (laneKey: string, status: TaskStatus): Task[] => columns.get(`${laneKey} ${status}`) ?? [],
    [columns]
  );

  /* per-card graph facts, computed once for the whole board ------ */

  const progress = useMemo(() => {
    const done = new Map<string, number>();
    const total = new Map<string, number>();
    const status = new Map(store.tasks.map((t) => [t.id, t.status] as const));
    for (const l of store.links) {
      if (l.kind !== "parent" || l.from_type !== "task" || l.to_type !== "task") continue;
      const child = status.get(l.to_id);
      if (!child) continue;
      total.set(l.from_id, (total.get(l.from_id) ?? 0) + 1);
      if (child === "done") done.set(l.from_id, (done.get(l.from_id) ?? 0) + 1);
    }
    return { done, total };
  }, [store.links, store.tasks]);

  /** `${taskId}:${agentId}` for every agent the graph already shows on a card. */
  const inGraph = useMemo(() => {
    const set = new Set<string>();
    for (const a of store.assignments) {
      if (a.target_type === "task" && a.subject_type === "agent") set.add(`${a.target_id}:${a.subject_id}`);
    }
    return set;
  }, [store.assignments]);

  /* keyboard navigation model ----------------------------------- */

  /** lanes × columns of ids, so arrow keys are pure index arithmetic. */
  const grid = useMemo(
    () => lanes.map((lane) => COLUMNS.map((col) => cardsIn(lane.key, col.key).map((t) => t.id))),
    [lanes, cardsIn]
  );

  const where = useCallback(
    (id: string): { lane: number; col: number; row: number } | null => {
      for (let lane = 0; lane < grid.length; lane++) {
        for (let col = 0; col < grid[lane].length; col++) {
          const row = grid[lane][col].indexOf(id);
          if (row >= 0) return { lane, col, row };
        }
      }
      return null;
    },
    [grid]
  );

  /** Ask a card to take focus. Cards decide whether to honour it; see FocusState. */
  const requestFocus = useCallback((id: string) => {
    setFocus((f) => ({ id, seq: f.seq + 1, at: Date.now() }));
  }, []);

  const moveFocus = useCallback(
    (id: string, dx: number, dy: number) => {
      const at = where(id);
      if (!at) return;
      if (dy) {
        const list = grid[at.lane][at.col];
        const next = at.row + dy;
        if (next >= 0 && next < list.length) {
          requestFocus(list[next]);
          return;
        }
        // Off the end of a column: continue into the neighbouring lane's same
        // column, which is where the eye goes anyway.
        for (let lane = at.lane + dy; lane >= 0 && lane < grid.length; lane += dy) {
          const list2 = grid[lane][at.col];
          if (list2.length) {
            requestFocus(dy > 0 ? list2[0] : list2[list2.length - 1]);
            return;
          }
        }
        return;
      }
      for (let col = at.col + dx; col >= 0 && col < COLUMNS.length; col += dx) {
        const list = grid[at.lane][col];
        if (list.length) {
          requestFocus(list[Math.min(at.row, list.length - 1)]);
          return;
        }
      }
    },
    [grid, where, requestFocus]
  );

  /* moving a card ----------------------------------------------- */

  /** The destination column with the carried card taken out of it. */
  const destWithout = useCallback(
    (target: DropTarget, movingId: string): Task[] =>
      cardsIn(target.laneKey, target.status).filter((t) => t.id !== movingId),
    [cardsIn]
  );

  const commit = useCallback(
    async (taskId: string, target: DropTarget) => {
      const task = useStore.getState().tasks.find((t) => t.id === taskId);
      if (!task) return;
      const lane = lanes.find((l) => l.key === target.laneKey);
      const before: Partial<Task> = {};
      const patch: Partial<Task> = {};

      if (task.status !== target.status) {
        before.status = task.status;
        patch.status = target.status;
      }
      if (prefs.groupBy === "assignee" && lane && (task.assignee_agent_id || "") !== lane.id) {
        before.assignee_agent_id = task.assignee_agent_id;
        patch.assignee_agent_id = lane.id;
      }
      if (prefs.groupBy === "project" && lane?.project && task.project_id !== lane.project.id) {
        before.project_id = task.project_id;
        patch.project_id = lane.project.id;
      }

      try {
        // Manual order is the only mode where a position means anything; under
        // any other sort the list would jump back on the next render, so
        // pretending to save one would be a lie.
        let reordered = false;
        if (ordered) {
          const rest = destWithout(target, taskId);
          const moved = { ...task, ...patch };
          rest.splice(Math.max(0, Math.min(target.index, rest.length)), 0, moved);
          reordered = await persistOrder(rest);
        }

        if (Object.keys(patch).length) await useStore.getState().updateTask(taskId, patch);
        else if (reordered) await useStore.getState().refreshAll();

        if (patch.assignee_agent_id !== undefined) {
          // Keep the graph in step with the column the lane just wrote.
          await setPrimaryAssignee(taskId, patch.assignee_agent_id);
        }
        if (patch.project_id !== undefined) {
          toast.show({
            kind: "info",
            title: `Moved to ${lane?.name ?? "another project"}`,
            detail: task.title,
            action: { label: "Undo", run: () => void useStore.getState().updateTask(taskId, before) },
          });
        }
      } catch (e) {
        toast.error("Could not move that task", e);
      }
    },
    [lanes, prefs.groupBy, ordered, destWithout]
  );

  /* carrying ---------------------------------------------------- */

  const pickUp = useCallback(
    (id: string, via: Carry["via"]) => {
      const at = where(id);
      if (!at) return;
      setCarry({ id, via });
      setOver({ laneKey: lanes[at.lane].key, status: COLUMNS[at.col].key, index: at.row });
      if (via === "keys") {
        const t = useStore.getState().tasks.find((x) => x.id === id);
        setAnnounce(`Picked up ${t?.title ?? "task"}. Arrow keys choose a place, space drops it, escape cancels.`);
      }
    },
    [where, lanes]
  );

  const drop = useCallback(
    (target: DropTarget | null) => {
      if (carry && target) {
        const id = carry.id;
        const keys = carry.via === "keys";
        // Crossing a column remounts the card, so the request has to outlive
        // the node that raised it — which is exactly what dating it buys.
        void commit(id, target).then(() => {
          if (keys) requestFocus(id);
        });
      }
      if (carry?.via === "keys") setAnnounce("Dropped.");
      setCarry(null);
      setOver(null);
    },
    [carry, commit, requestFocus]
  );

  const cancelCarry = useCallback(() => {
    if (carry?.via === "keys") setAnnounce("Cancelled — the card stayed where it was.");
    setCarry(null);
    setOver(null);
  }, [carry]);

  /** Arrow keys while carrying move the drop target, not the focus. */
  const nudgeTarget = useCallback(
    (dx: number, dy: number) => {
      if (!carry || !over) return;
      const laneIdx = Math.max(0, lanes.findIndex((l) => l.key === over.laneKey));
      const colIdx = COLUMNS.findIndex((c) => c.key === over.status);
      let next: DropTarget = over;
      if (dy) {
        const room = destWithout(over, carry.id).length;
        const index = over.index + dy;
        if (index < 0 || index > room) {
          const lane = laneIdx + dy;
          if (lane < 0 || lane >= lanes.length) return;
          const target = { laneKey: lanes[lane].key, status: over.status, index: 0 };
          next = { ...target, index: dy > 0 ? 0 : destWithout(target, carry.id).length };
        } else {
          next = { ...over, index };
        }
      } else {
        const col = colIdx + dx;
        if (col < 0 || col >= COLUMNS.length) return;
        const target = { laneKey: over.laneKey, status: COLUMNS[col].key, index: 0 };
        next = { ...target, index: Math.min(over.index, destWithout(target, carry.id).length) };
      }
      setOver(next);
      // Focus stays on the carried card, so nothing scrolls the drop target
      // into view for us — and a drop indicator you cannot see is no indicator.
      document.querySelector(`[data-col="${next.laneKey} ${next.status}"]`)?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      const lane = lanes.find((l) => l.key === next.laneKey);
      const col = COLUMNS.find((c) => c.key === next.status);
      const place = ordered ? `, position ${next.index + 1}` : "";
      setAnnounce(`${col?.label ?? ""}${lane?.name ? `, ${lane.name}` : ""}${place}.`);
    },
    [carry, over, lanes, destWithout, ordered]
  );

  /* card actions ------------------------------------------------ */

  const inspect = useCallback((t: Task) => useStore.getState().setInspect({ type: "task", id: t.id }), []);

  // Named so the card key handler can depend on something stable — `usePanel`
  // hands back the same callbacks for the life of the board.
  const editShow = edit.show;
  const assignShow = assign.show;
  const onEditCard = useCallback((t: Task) => editShow(t.id), [editShow]);
  const onAssignCard = useCallback((t: Task) => assignShow(t.id), [assignShow]);

  const remove = useCallback(
    async (t: Task) => {
      const at = where(t.id);
      const gone = await deleteTaskWithUndo(t);
      if (!gone || !at) return;
      // Keep the keyboard where the card was, so a run of deletions does not
      // dump focus back to the top of the document.
      const list = grid[at.lane][at.col].filter((id) => id !== t.id);
      const nextId = list[Math.min(at.row, list.length - 1)];
      if (nextId) requestFocus(nextId);
    },
    [where, grid, requestFocus]
  );

  const onCardKey = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, task: Task) => {
      const k = e.key;
      if (k === "Escape" && carry) {
        e.preventDefault();
        cancelCarry();
        return;
      }
      if (k === " " || k === "Spacebar") {
        e.preventDefault();
        if (carry?.id === task.id) drop(over);
        else if (!carry) pickUp(task.id, "keys");
        return;
      }
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0;
        const dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
        if (carry?.id === task.id) nudgeTarget(dx, dy);
        else if (!carry) moveFocus(task.id, dx, dy);
        return;
      }
      if (carry) return; // while carrying, nothing else applies
      if (k === "Enter") {
        e.preventDefault();
        inspect(task);
      } else if (k === "e" || k === "E") {
        e.preventDefault();
        editShow(task.id);
      } else if (k === "a" || k === "A") {
        e.preventDefault();
        assignShow(task.id);
      } else if (k === "Delete" || k === "Backspace") {
        e.preventDefault();
        void remove(task);
      }
    },
    [carry, over, drop, pickUp, cancelCarry, nudgeTarget, moveFocus, inspect, remove, editShow, assignShow]
  );

  /* "/" focuses the search box, the way every list in the app should --- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      // A panel is non-blocking, so the board's own shortcut stays live while
      // one is open — but a keystroke aimed *at* the panel belongs to it, and
      // yanking focus out to the search box would be the modal mistake again.
      if (el?.closest(".sp")) return;
      if (document.querySelector(".modal-backdrop, .board-pop")) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ── render ─────────────────────────────────────────────────── */

  if (!projects.length) {
    return (
      <div className="main-pane center-note board-blank">
        <p>
          <strong>No projects yet.</strong>
        </p>
        <p>Tasks live inside projects — make one and this board fills up.</p>
      </div>
    );
  }

  const openCount = inScope.filter((t) => t.status !== "done").length;
  const doneCount = inScope.length - openCount;
  const laneCount = (lane: Lane) => COLUMNS.reduce((n, c) => n + cardsIn(lane.key, c.key).length, 0);

  /*
   * Roving tabindex: exactly one card sits in the tab order. When nothing has
   * been focused yet — or the card that was focused is now filtered away — that
   * card is the first on the board, so Tab always reaches the cards and never
   * has to walk through all of them.
   */
  const cardProps: CardProps = {
    focus: {
      id: focus.id && where(focus.id) ? focus.id : grid.flat().flat()[0] ?? "",
      // The request names a card outright: falling back to the first card for
      // the tab order is fine, stealing focus to it is not.
      want: focus.id,
      seq: focus.seq,
      at: focus.at,
    },
    setFocus,
    carryId: carry?.id ?? null,
    onKey: onCardKey,
    onInspect: inspect,
    onEdit: onEditCard,
    onAssign: onAssignCard,
    onPickUp: pickUp,
    onDropped: drop,
    progress,
    inGraph,
    labels: labelIndex,
  };

  const shared = {
    filtering,
    carry,
    over,
    setOver,
    onDrop: drop,
    cardProps,
    // Under a sorted view the board must not draw an indicator promising a
    // position it is not going to keep.
    ordered,
  };
  const quickAdd = (lane: Lane) => ({
    quickAddProject: quickAddProjectFor(lane, scope, projects),
    // The board can show several projects at once; say which one Enter files into.
    nameProject: scope === "all" && !lane.project,
    quickAddAssignee: prefs.groupBy === "assignee" ? lane.id : undefined,
  });

  const board =
    prefs.groupBy === "status" ? (
      <div className="kanban" role="group" aria-label="Task board">
        {COLUMNS.map((col) => (
          <BoardColumn
            key={col.key}
            col={col}
            lane={lanes[0]}
            tasks={cardsIn(lanes[0].key, col.key)}
            compact={false}
            {...shared}
            {...quickAdd(lanes[0])}
          />
        ))}
      </div>
    ) : (
      <div className="swimlanes">
        {lanes.map((lane) => (
          <section
            key={lane.key}
            className={"swimlane" + (laneCount(lane) ? "" : " quiet")}
            aria-label={lane.name}
          >
            <div className="swimlane-head">
              {lane.agent && <Avatar name={lane.agent.name} id={lane.agent.id} kind={lane.agent.kind} />}
              <span className="swimlane-name">{lane.name}</span>
              {lane.sub && <span className="swimlane-sub">{lane.sub}</span>}
              <span className="count">{laneCount(lane)}</span>
            </div>
            <div className="swimlane-cols" role="group" aria-label={`${lane.name} columns`}>
              {COLUMNS.map((col) => (
                <BoardColumn
                  key={col.key}
                  col={col}
                  lane={lane}
                  tasks={cardsIn(lane.key, col.key)}
                  compact
                  {...shared}
                  {...quickAdd(lane)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    );

  return (
    <div className="main-pane board">
      <div className="pane-header board-header">
        <div className="board-ident">
          <div className="pane-title">Tasks</div>
          {/* Scope, not a filter: it says which project's board this is, so it
              sits with the title and stays out of the Filter control. */}
          <select
            className="board-scope"
            aria-label="Project"
            value={scope}
            onChange={(e) => setPrefs({ scope: e.target.value })}
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="board-summary">
            {openCount} open · {doneCount} done
          </span>
        </div>

        <BoardToolbar
          searchRef={searchRef}
          query={query}
          onQuery={setQuery}
          groupBy={prefs.groupBy}
          onGroupBy={(g) => setPrefs({ groupBy: g, ...(g === "project" ? { scope: "all" } : null) })}
          sort={prefs.sort}
          onSort={(s) => setPrefs({ sort: s })}
          filter={{
            agents: store.agents,
            inScope,
            assignee: assigneeFilter,
            onAssignee: setAssigneeFilter,
            labels: allLabels,
            label: labelFilter,
            onLabel: setLabelFilter,
            due: dueFilter,
            onDue: setDueFilter,
            mineOnly,
            onMineOnly: setMineOnly,
            count: filterCount,
            onClear: clearFilters,
          }}
        />
      </div>

      {visible.length === 0 ? (
        <div className="board-empty">
          <span className="board-empty-mark" aria-hidden="true">
            ◫
          </span>
          {filtering ? (
            <>
              <p className="board-empty-title">Nothing matches those filters</p>
              <p className="board-empty-sub">
                {inScope.length} task{inScope.length === 1 ? "" : "s"} in scope, all hidden.
              </p>
              <button className="btn" onClick={clearFilters}>
                Clear filters
              </button>
            </>
          ) : (
            <>
              <p className="board-empty-title">This board is empty</p>
              <p className="board-empty-sub">
                Add the first task in a column below — or ask an agent in a channel to file one.
              </p>
              <div className="kanban board-empty-cols" role="group" aria-label="Task board">
                {COLUMNS.map((col) => (
                  <BoardColumn
                    key={col.key}
                    col={col}
                    lane={lanes[0]}
                    tasks={[]}
                    compact={false}
                    {...shared}
                    {...quickAdd(lanes[0])}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        board
      )}

      {/* Live instructions, and only while a card is actually in the air. */}
      {carry?.via === "keys" && <CarryHint />}

      <div className="board-sr" role="status" aria-live="polite">
        {announce}
      </div>

      {edit.data && <TaskPanel taskId={edit.data} onClose={edit.hide} />}
      {assign.data && <AssignPanel taskId={assign.data} onClose={assign.hide} />}
    </div>
  );
}

/** Which project a column's quick-add files into when the scope is "all". */
function quickAddProjectFor(lane: Lane | undefined, scope: string, projects: Project[]): Project | undefined {
  if (lane?.project) return lane.project;
  if (scope !== "all") return projects.find((p) => p.id === scope);
  return projects[0];
}

function sortTasks(list: Task[], mode: SortMode): Task[] {
  const out = [...list];
  switch (mode) {
    case "due":
      // No date is not "due first"; it sinks.
      return out.sort(
        (a, b) =>
          (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) ||
          a.due_date.localeCompare(b.due_date) ||
          a.sort_order - b.sort_order
      );
    case "newest":
      return out.sort((a, b) => b.created_at - a.created_at);
    case "oldest":
      return out.sort((a, b) => a.created_at - b.created_at);
    case "title":
      return out.sort((a, b) => a.title.localeCompare(b.title));
    default:
      return out.sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
  }
}

/* ── toolbar ──────────────────────────────────────────────────── */

/**
 * Everything the filters need, handed over in one piece. It is a lot of state,
 * but it is one *concept* — what is being hidden — and passing it as one object
 * is what lets the toolbar stay a row of four controls instead of a signature.
 */
interface FilterProps {
  agents: Agent[];
  inScope: Task[];
  assignee: string[];
  onAssignee: (v: string[]) => void;
  labels: string[];
  label: string[];
  onLabel: (v: string[]) => void;
  due: DueFilter;
  onDue: (v: DueFilter) => void;
  mineOnly: boolean;
  onMineOnly: (on: boolean) => void;
  /** How many filters are on — the number on the Filter control. */
  count: number;
  onClear: () => void;
}

/**
 * One row: search, how the board is arranged, what it is hiding, and help.
 *
 * Arrangement and filtering used to look identical — a segmented "Status |
 * Assignee | Project" that read as tabs, sitting one row above a strip of
 * assignee chips that read as the same thing. They are now different objects:
 * arrangement is a pair of labelled selects that show their current value, and
 * filtering is a single button that shows a count and opens a sheet.
 */
function BoardToolbar({
  searchRef, query, onQuery, groupBy, onGroupBy, sort, onSort, filter,
}: {
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  sort: SortMode;
  onSort: (s: SortMode) => void;
  filter: FilterProps;
}) {
  return (
    <div className="board-tools">
      <div className="board-search">
        <IconSearch size={13} className="board-search-icon" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search tasks"
          aria-label="Search tasks"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery("");
            }
          }}
        />
        <kbd className="board-search-key" aria-hidden="true">
          /
        </kbd>
      </div>

      <label className="board-pick" title={GROUPS.find((g) => g.id === groupBy)?.help}>
        <span className="board-pick-label">Group</span>
        <select
          aria-label="Group by"
          value={groupBy}
          onChange={(e) => onGroupBy(e.target.value as GroupBy)}
        >
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </label>

      <label className="board-pick">
        <span className="board-pick-label">Sort</span>
        <select aria-label="Sort" value={sort} onChange={(e) => onSort(e.target.value as SortMode)}>
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <FilterMenu {...filter} />
      <HelpMenu />
    </div>
  );
}

/* ── popovers ─────────────────────────────────────────────────── */

/**
 * A button and the sheet it opens, in one element so that "clicked outside"
 * has a single box to test against — the trigger is inside the popover as far
 * as dismissal is concerned, which is what stops a click on it from closing and
 * reopening in the same gesture.
 */
function MenuButton({
  label, className, trigger, align = "right", children,
}: {
  label: string;
  className?: string;
  trigger: (open: boolean) => ReactNode;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);

  /** Closing by keyboard hands the keyboard back to the button that opened it. */
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // A click outside just closes: the pointer has already chosen where it is
    // going, and pulling focus back to the trigger would fight it.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Ahead of the board's own Escape, which would otherwise cancel a carry
      // that the sheet is sitting on top of.
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={"board-menu" + (className ? ` ${className}` : "")} ref={ref}>
      <button
        ref={btn}
        className={"btn board-menu-btn" + (open ? " open" : "")}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger(open)}
      </button>
      {open && (
        <div className={"board-pop" + (align === "left" ? " left" : "")} role="group" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/**
 * A row in a popover: a tick column, a label, and an optional count. The tick
 * keeps its column whether or not it is ticked, so every label starts on the
 * same pixel and the sheet reads as a list rather than a stack of buttons.
 */
function PopRow({
  on, children, count, onClick,
}: {
  on: boolean;
  children: ReactNode;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button className={"pop-row" + (on ? " on" : "")} aria-pressed={on} onClick={onClick}>
      <span className="pop-tick" aria-hidden="true">
        {on && <IconCheck size={11} />}
      </span>
      <span className="pop-label">{children}</span>
      {count !== undefined && <span className="pop-count">{count}</span>}
    </button>
  );
}

/**
 * Everything that hides cards, behind one control that says how much of it is
 * on. Four rows of chips became four labelled sections in a sheet, and the row
 * they used to cost the board went back to the board.
 */
function FilterMenu({
  agents, inScope, assignee, onAssignee, labels, label, onLabel, due, onDue,
  mineOnly, onMineOnly, count, onClear,
}: FilterProps) {
  const toggle = (list: string[], value: string, set: (v: string[]) => void) =>
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  const withWork = agents.filter((a) => inScope.some((t) => t.assignee_agent_id === a.id));
  const held = (id: string) => inScope.filter((t) => (t.assignee_agent_id || "") === id).length;

  return (
    <MenuButton
      label="Filter"
      className={count ? "on" : ""}
      trigger={() => (
        <>
          <IconFilter size={12} />
          Filter
          {count > 0 && <span className="board-menu-count">{count}</span>}
          <IconChevronDown size={11} className="board-menu-caret" />
        </>
      )}
    >
      {() => (
        <>
          <div className="pop-head">Assignee</div>
          <PopRow on={assignee.length === 0} onClick={() => onAssignee([])}>
            Anyone
          </PopRow>
          {withWork.map((a) => (
            <PopRow
              key={a.id}
              on={assignee.includes(a.id)}
              count={held(a.id)}
              onClick={() => toggle(assignee, a.id, onAssignee)}
            >
              <Avatar name={a.name} id={a.id} kind={a.kind} />
              {a.name}
            </PopRow>
          ))}
          <PopRow
            on={assignee.includes("")}
            count={held("")}
            onClick={() => toggle(assignee, "", onAssignee)}
          >
            Unassigned
          </PopRow>

          {labels.length > 0 && (
            <>
              <div className="pop-head" title="Labels are the #tags written in a task's title or description">
                Labels
              </div>
              {labels.slice(0, 12).map((tag) => (
                <PopRow key={tag} on={label.includes(tag)} onClick={() => toggle(label, tag, onLabel)}>
                  <span className="pop-tag">#{tag}</span>
                </PopRow>
              ))}
            </>
          )}

          <div className="pop-head">Due</div>
          {DUE_FILTERS.map((d) => (
            <PopRow key={d.id} on={due === d.id} onClick={() => onDue(d.id)}>
              {d.label}
            </PopRow>
          ))}

          <div className="pop-head">Only</div>
          <PopRow on={mineOnly} onClick={() => onMineOnly(!mineOnly)}>
            <span title="Open tasks nobody has handed to an agent — what is still on your own plate">
              My open work
            </span>
          </PopRow>

          {count > 0 && (
            <button className="pop-clear" onClick={onClear}>
              Clear {count} filter{count === 1 ? "" : "s"}
            </button>
          )}
        </>
      )}
    </MenuButton>
  );
}

/**
 * The board explaining itself, on request. It carries the mouse model as well
 * as the keys, because "click inspects, double-click edits" is the rule nobody
 * can guess — but a rule you need once is not worth a strip of the window
 * forever, so it lives behind the "?" it was already sitting next to.
 */
function HelpMenu() {
  return (
    <MenuButton
      label="Shortcuts"
      className="board-help"
      trigger={() => <span aria-hidden="true">?</span>}
    >
      {() => (
        <>
          <div className="pop-head">Mouse</div>
          <p className="pop-note">Click a card to inspect it, double-click to edit, drag to reorder.</p>
          <div className="pop-head">Keyboard</div>
          <dl className="pop-keys">
            <dt>
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <kbd>←</kbd>
              <kbd>→</kbd>
            </dt>
            <dd>between cards</dd>
            <dt>
              <kbd>Space</kbd>
            </dt>
            <dd>pick up, then arrows to place and space to drop</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>put a carried card back</dd>
            <dt>
              <kbd>E</kbd>
            </dt>
            <dd>edit</dd>
            <dt>
              <kbd>A</kbd>
            </dt>
            <dd>assign</dd>
            <dt>
              <kbd>⌫</kbd>
            </dt>
            <dd>delete</dd>
            <dt>
              <kbd>/</kbd>
            </dt>
            <dd>search</dd>
          </dl>
        </>
      )}
    </MenuButton>
  );
}

/** Live instructions while a card is in the air. Gone the moment it lands. */
function CarryHint() {
  return (
    <div className="board-carry" role="presentation">
      <kbd>↑</kbd>
      <kbd>↓</kbd>
      <kbd>←</kbd>
      <kbd>→</kbd> choose a place · <kbd>Space</kbd> drop it here · <kbd>Esc</kbd> put it back
    </div>
  );
}

/* ── columns ──────────────────────────────────────────────────── */

interface CardProps {
  /** `id` holds the tab order, `want` names the card a request is aimed at. */
  focus: FocusState & { want: string };
  setFocus: (f: FocusState) => void;
  carryId: string | null;
  onKey: (e: ReactKeyboardEvent<HTMLElement>, t: Task) => void;
  onInspect: (t: Task) => void;
  onEdit: (t: Task) => void;
  onAssign: (t: Task) => void;
  onPickUp: (id: string, via: Carry["via"]) => void;
  onDropped: (target: DropTarget | null) => void;
  progress: { done: Map<string, number>; total: Map<string, number> };
  inGraph: Set<string>;
  labels: Map<string, Labels>;
}

function BoardColumn({
  col, lane, tasks, compact, filtering, carry, over, setOver, onDrop,
  quickAddProject, quickAddAssignee, nameProject, cardProps, ordered,
}: {
  col: ColumnSpec;
  lane: Lane;
  tasks: Task[];
  compact: boolean;
  filtering: boolean;
  /** False under a sorted view: the column accepts drops, positions mean nothing. */
  ordered: boolean;
  carry: Carry | null;
  over: DropTarget | null;
  setOver: (t: DropTarget | null) => void;
  onDrop: (target: DropTarget | null) => void;
  quickAddProject?: Project;
  quickAddAssignee?: string;
  nameProject: boolean;
  cardProps: CardProps;
}) {
  const runs = useStore((s) => s.runs);
  const activeRunIds = useStore((s) => s.activeRunIds);
  const hot = col.key === "doing" && tasks.some((t) => taskRunning(t, runs, activeRunIds));

  const mine = !!over && over.laneKey === lane.key && over.status === col.key;
  const rest = carry ? tasks.filter((t) => t.id !== carry.id) : tasks;
  const beforeId = mine && ordered ? rest[over.index]?.id ?? null : undefined;

  const aim = (index: number) => setOver({ laneKey: lane.key, status: col.key, index });

  /** Above or below the card the pointer is on — the usual list-drop rule. */
  const aimAt = (e: ReactDragEvent, index: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    aim(e.clientY > r.top + r.height / 2 ? index + 1 : index);
  };

  return (
    <div
      className={
        "kanban-col" + (compact ? " compact" : "") + (mine && carry ? " drag-over" : "")
      }
      data-col={`${lane.key} ${col.key}`}
      role="group"
      aria-label={`${col.label}${lane.name ? `, ${lane.name}` : ""}, ${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
      onDragOver={(e) => {
        if (!carry) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        aim(rest.length);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(over);
      }}
    >
      {/* A heading and a count. The dot is not decoration — it only appears
          when something in this column is actually running. */}
      <div className="kanban-head">
        {hot && <span className="col-dot hot" />}
        {col.label} <span className="count">{tasks.length}</span>
      </div>

      <div className="kanban-cards">
        {tasks.length === 0 && !mine && (
          <p className="col-empty">{filtering ? "Nothing here matches" : col.empty}</p>
        )}
        {tasks.map((t) => (
          <Fragment key={t.id}>
            {beforeId === t.id && <DropLine />}
            <TaskCard
              task={t}
              compact={compact}
              dragging={carry?.id === t.id}
              carriedByKeys={carry?.id === t.id && carry.via === "keys"}
              onDragOver={(e) => {
                if (!carry) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                // Hovering the carried card itself says nothing about where it
                // should land, so the last target stands.
                const at = rest.findIndex((x) => x.id === t.id);
                if (at >= 0) aimAt(e, at);
              }}
              {...cardProps}
            />
          </Fragment>
        ))}
        {mine && ordered && beforeId === null && <DropLine />}
      </div>

      {quickAddProject && (
        <QuickAdd
          project={quickAddProject}
          status={col.key}
          assignee={quickAddAssignee}
          nameIt={nameProject}
        />
      )}
    </div>
  );
}

function DropLine() {
  return <div className="drop-line" aria-hidden="true" />;
}

/* ── cards ────────────────────────────────────────────────────── */

function TaskCard({
  task, compact, dragging, carriedByKeys, onDragOver, focus, setFocus, carryId, onKey, onInspect, onEdit,
  onAssign, onPickUp, onDropped, progress, inGraph, labels,
}: CardProps & {
  task: Task;
  compact: boolean;
  dragging: boolean;
  carriedByKeys: boolean;
  onDragOver: (e: ReactDragEvent) => void;
}) {
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const activeRunIds = useStore((s) => s.activeRunIds);
  const ref = useRef<HTMLDivElement | null>(null);
  const focused = focus.id === task.id;

  /*
   * Focus follows the board's explicit requests and nothing else. A card that
   * has been on screen honours any request aimed at it. A card that has only
   * just mounted honours one raised moments ago — that is the card carried into
   * this column, whose old node took the request to the grave with it — but
   * never an older one, so a filter change can never yank focus out of the
   * search box.
   */
  const honoured = useRef(-1);
  useEffect(() => {
    if (honoured.current === focus.seq) return;
    const fresh = honoured.current === -1;
    honoured.current = focus.seq;
    if (focus.want !== task.id) return;
    if (fresh && Date.now() - focus.at > FOCUS_GRACE_MS) return;
    ref.current?.focus();
  });

  const assignee = agents.find((a) => a.id === task.assignee_agent_id);
  const live = taskRunning(task, runs, activeRunIds);
  const due = dueMeta(task.due_date, task.status);
  const tags = labels.get(task.id)?.hidden ?? [];
  const total = progress.total.get(task.id) ?? 0;
  const done = progress.done.get(task.id) ?? 0;

  /**
   * ConnectionsSummary draws the faces the *graph* knows about. A task assigned
   * before the graph existed has the column set and no assignment row, so its
   * primary is drawn here instead — never both, so a face is never doubled.
   */
  const orphanPrimary = assignee && !inGraph.has(`${task.id}:${assignee.id}`) ? assignee : null;

  return (
    <div
      ref={ref}
      className={
        "task-card" +
        (dragging ? " dragging" : "") +
        (carriedByKeys ? " carrying" : "") +
        (live ? " live" : "") +
        (task.status === "done" ? " settled" : "")
      }
      data-task={task.id}
      role="button"
      tabIndex={focused ? 0 : -1}
      aria-label={`${task.title}${assignee ? `, assigned to ${assignee.name}` : ""}${due ? `, due ${due.full}` : ""}`}
      aria-grabbed={carryId === task.id || undefined}
      draggable
      onFocus={() => {
        // Taking focus with the mouse moves the roving tabindex but must not
        // count as a focus *request*, or every card would re-assert focus.
        if (!focused) setFocus({ id: task.id, seq: focus.seq, at: 0 });
      }}
      onKeyDown={(e) => onKey(e, task)}
      onClick={() => onInspect(task)}
      onDoubleClick={() => onEdit(task)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        onPickUp(task.id, "mouse");
      }}
      onDragEnd={() => onDropped(null)}
      onDragOver={onDragOver}
    >
      {/*
        Three lines and no wrappers: a title that is bigger and heavier than
        anything under it, one dim line of detail, and one row of metadata. The
        row that used to hold the due date and the labels, and the flex box that
        held the title next to its edit button, are both gone — the edit button
        floats in the corner it was already occupying.
      */}
      <div className="task-title">{task.title}</div>

      {task.description && !compact && <div className="task-desc">{task.description}</div>}

      <div className="task-foot">
        <button
          className="task-faces"
          tabIndex={focused ? 0 : -1}
          aria-label={assignee ? `Change who is on ${task.title}` : `Assign ${task.title}`}
          title="Assign (A)"
          onClick={(e) => {
            e.stopPropagation();
            onAssign(task);
          }}
        >
          {orphanPrimary && (
            <EntityAvatarStack refs={[{ type: "agent", id: orphanPrimary.id }]} max={1} />
          )}
          <ConnectionsSummary anchor={{ type: "task", id: task.id }} max={3} />
          {!assignee && !orphanPrimary && (
            <span className="task-faces-empty">
              <IconPlus size={10} />
              Assign
            </span>
          )}
        </button>

        {due && (
          <span className={"task-due " + due.tone} title={`Due ${due.full}`}>
            {due.label}
          </span>
        )}
        {total > 0 && (
          <span
            className={"task-sub" + (done === total ? " complete" : "")}
            title={`${done} of ${total} linked subtasks done`}
          >
            {done}/{total}
          </span>
        )}
        {tags.slice(0, 3).map((tag) => (
          <span key={tag} className="task-tag">
            #{tag}
          </span>
        ))}

        {task.last_run_id && <RunMark runId={task.last_run_id} focused={focused} />}
      </div>

      <button
        className="task-edit"
        tabIndex={focused ? 0 : -1}
        aria-label={`Edit ${task.title}`}
        title="Edit (E, or double-click the card)"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(task);
        }}
      >
        <IconEdit size={12} />
      </button>
    </div>
  );
}

/* ── run strip ────────────────────────────────────────────────── */

/** Navigate to a run's channel, opening the thread when its reply message is threaded (run id == message id). */
async function openRunLocation(runId: string, channelId: string, setView: (v: View) => void) {
  let threadRootId: string | undefined;
  try {
    const db = await getDb();
    const rows = await db.select<{ parent_id: string }[]>(
      "SELECT parent_id FROM messages WHERE id = $1",
      [runId]
    );
    threadRootId = rows[0]?.parent_id || undefined;
  } catch {
    // message lookup failed — fall back to plain channel navigation
  }
  setView({ type: "channel", channelId, threadRootId });
}

/**
 * How a run ended, at the weight the fact deserves.
 *
 * This was a filled, bordered, full-width bar across the bottom of the card,
 * which meant "an agent finished something here yesterday" outweighed the name
 * of the task on every card that had ever been run. It is a status, so it is a
 * dot and a word, in the footer with the rest of the metadata — and still the
 * same click through to where the run happened.
 */
function RunMark({ runId, focused }: { runId: string; focused?: boolean }) {
  const run = useStore((s) => s.runs[runId]);
  const loadRun = useStore((s) => s.loadRun);
  const setView = useStore((s) => s.setView);

  useEffect(() => {
    if (!run) void loadRun(runId);
  }, [runId, run, loadRun]);

  if (!run) return null;
  const [cls, word, why] =
    run.status === "running" ? ["running", "running", "An agent is working on this — open the run"]
    : run.status === "done" ? ["ok", "run done", "The run finished — open it to review"]
    : run.status === "cancelled" ? ["cancelled", "cancelled", "The run was cancelled — open it"]
    : ["err", "run failed", "The run failed — open it"];
  return (
    <button
      className={"run-mark " + cls}
      tabIndex={focused ? 0 : -1}
      title={why}
      onClick={(e) => {
        e.stopPropagation();
        void openRunLocation(run.id, run.channel_id, setView);
      }}
    >
      <span className="run-dot" aria-hidden="true" />
      {word}
    </button>
  );
}

/* ── quick add ────────────────────────────────────────────────── */

function QuickAdd({
  project, status, assignee, nameIt,
}: {
  project: Project;
  status: TaskStatus;
  assignee?: string;
  /** Say which project this files into, when the board is showing several. */
  nameIt: boolean;
}) {
  const store = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await store.addTask({
        project_id: project.id,
        title,
        status,
        ...(assignee ? { assignee_agent_id: assignee } : {}),
      });
      setText("");
    } catch (e) {
      toast.error("Could not add that task", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <input
      className="quick-add"
      value={text}
      placeholder={nameIt ? `＋ Add to ${project.name}` : "＋ Add task"}
      aria-label={`Add a task to ${project.name}`}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void add();
        if (e.key === "Escape" && text) {
          e.stopPropagation();
          setText("");
        }
      }}
    />
  );
}

/* ── the two panels ───────────────────────────────────────────── */

/*
 * WHY THE EDITOR IS NOT THE INSPECTOR.
 *
 * The obvious question, given that a click on a card already opens a drawer, is
 * why the pencil does not open the same one. Because the inspector is a
 * *reader* for every entity type — task, agent, channel, run, memory — bound to
 * `store.inspect` and carrying its own back/forward history, so a chip inside
 * it walks the graph without moving the app. Teaching it to edit tasks would
 * fork that: one entity type would stop being a page you can navigate away from
 * and become a form with unsaved state, and every back button in the drawer
 * would then have to ask whether it was allowed to leave.
 *
 * What makes the pair unambiguous instead is that they are never both on
 * screen. SidePanel holds a single trailing edge: opening this panel closes the
 * inspector, opening the inspector — from a chip in the connections list, say —
 * closes this panel, and when the panel closes it puts the inspector back on
 * the entity it displaced. So there is one drawer, and the board decides what
 * is in it: a click inspects the task, E or the pencil edits it, and either way
 * the answer arrives in the same place.
 */

/** How long typing rests before a panel writes it. */
const AUTOSAVE_MS = 500;

/**
 * Close a panel whose row has gone.
 *
 * A panel outlives the click that opened it — the board keeps working behind
 * it, and a card can be deleted, or an agent can finish a run and move a task,
 * while it is still on screen. Editing a task that no longer exists is worse
 * than losing the surface, so the surface goes.
 */
function useGoneGuard(alive: boolean, onClose: () => void) {
  useEffect(() => {
    if (!alive) onClose();
  }, [alive, onClose]);
}

/* ── assign ───────────────────────────────────────────────────── */

function AssignPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  useGoneGuard(!!task, onClose);
  if (!task) return null;
  return <AssignBody key={task.id} task={task} onClose={onClose} />;
}

function AssignBody({ task, onClose }: { task: Task; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const assignments = useStore((s) => s.assignments);

  const others = useMemo(
    () =>
      assigneesOf({ type: "task", id: task.id }).filter(
        (v) => v.role !== "assignee" && v.info.exists
      ),
    // assignments is what assigneesOf reads
    [task.id, assignments]
  );

  async function pick(agentId: string, name: string) {
    const was = task.assignee_agent_id;
    try {
      await setPrimaryAssignee(task.id, agentId);
      toast.show({
        kind: "success",
        title: agentId ? `${name} is on “${task.title}”` : `Took ${name} off “${task.title}”`,
        action: { label: "Undo", run: () => void setPrimaryAssignee(task.id, was) },
      });
      onClose();
    } catch (e) {
      toast.error("Could not change the assignee", e);
    }
  }

  return (
    <SidePanel
      title="Assign"
      /* The task used to be named inside the lead sentence, which meant reading
         a paragraph to find out which card you were about to change. */
      subtitle={task.title}
      onClose={onClose}
      storageKey="assign"
      className="assign-panel"
    >
      <p className="assign-lead">
        An agent only runs while its host device is online, but anyone here can put any agent on
        it.
      </p>
      <ul className="assign-list">
        {agents.map((a) => {
          const on = a.id === task.assignee_agent_id;
          return (
            <li key={a.id}>
              <button
                className={"assign-row" + (on ? " on" : "")}
                onClick={() => void pick(on ? "" : a.id, a.name)}
              >
                <Avatar name={a.name} id={a.id} kind={a.kind} />
                <span className="assign-ident">
                  <span className="assign-name">{a.name}</span>
                  <span className="assign-sub">{a.role || a.kind}</span>
                </span>
                {on && <span className="assign-on">Assignee · click to clear</span>}
              </button>
            </li>
          );
        })}
        {agents.length === 0 && <li className="assign-none">No agents yet — add one in Agents.</li>}
      </ul>
      {others.length > 0 && (
        <p className="assign-note">
          Also on this: {others.map((v) => `${v.info.title} (${v.roleLabel.toLowerCase()})`).join(", ")}.
        </p>
      )}
      <p className="assign-note">
        Reviewers and watchers live in the task's Connections panel — open the task to add one.
      </p>
    </SidePanel>
  );
}

/* ── the task editor ──────────────────────────────────────────── */

function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  useGoneGuard(!!task, onClose);
  if (!task) return null;
  // Keyed on the id: opening a second card while the panel is up re-seeds every
  // field rather than carrying one task's half-typed title onto another.
  return <TaskEditor key={task.id} task={task} onClose={onClose} />;
}

/**
 * The task, edited beside the board.
 *
 * WHY THERE IS NO SAVE BUTTON. A modal could hold unsaved edits safely, because
 * nothing else on screen was reachable while it was up. This panel is both
 * reachable and dismissible: clicking another card opens the inspector, which
 * takes the trailing edge and closes this. A Save button would turn the most
 * ordinary gesture on the board into silent data loss. So the fields *are* the
 * task — they write themselves, on a debounce, and the card behind updates as
 * you type, which is the whole reason for editing beside the work rather than
 * on top of it. The footer says so rather than leaving it to be discovered.
 */
function TaskEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const store = useStore();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [due, setDue] = useState(task.due_date);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [assignee, setAssignee] = useState(task.assignee_agent_id);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Run[]>([]);
  const channels = store.channels.filter((c) => c.project_id === task.project_id);
  const [sendChannel, setSendChannel] = useState(channels[0]?.id ?? "");

  const project = store.projects.find((p) => p.id === task.project_id);
  const agent = store.agents.find((a) => a.id === assignee);

  /* Who is on a task is graph state, and a lane drop or the assign panel can
     change it while this one is open. The select follows the row. */
  useEffect(() => setAssignee(task.assignee_agent_id), [task.assignee_agent_id]);

  /* Everything typed here that the row does not already say. */
  const patch = useMemo(() => {
    const out: Partial<Task> = {};
    const clean = title.trim();
    // An empty box means "still typing", never "call this task nothing": the
    // title is the only thing identifying the card behind the panel.
    if (clean && clean !== task.title) out.title = clean;
    if (description !== task.description) out.description = description;
    if (due !== task.due_date) out.due_date = due;
    if (status !== task.status) out.status = status;
    return out;
  }, [title, description, due, status, task.title, task.description, task.due_date, task.status]);

  const pending = useRef(patch);
  pending.current = patch;
  /** Deleted, or deliberately handed on: either way, stop writing. */
  const settled = useRef(false);
  // A string, not the object: this panel re-renders on every store change, and
  // an object dep would re-arm the timer each time — under a live run the save
  // would be starved and never fire.
  const dirtyKey = JSON.stringify(patch);

  const flush = useCallback(async () => {
    const p = pending.current;
    if (settled.current || !Object.keys(p).length) return;
    setSaving(true);
    try {
      await useStore.getState().updateTask(task.id, p);
    } catch (e) {
      toast.error("Could not save that task", e);
    } finally {
      setSaving(false);
    }
  }, [task.id]);

  /* Debounced, because `updateTask` reloads every table — a write per keystroke
     would make typing a description stutter the whole board. */
  useEffect(() => {
    if (dirtyKey === "{}") return;
    const t = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [dirtyKey, flush]);

  /* And once more on the way out, for the half-second that never elapsed.
     Deliberately not `flush`: by then there is no component left to tell that
     it is saving, and the write has to happen anyway. */
  useEffect(() => {
    const id = task.id;
    return () => {
      const p = pending.current;
      if (settled.current || !Object.keys(p).length) return;
      void useStore
        .getState()
        .updateTask(id, p)
        .catch((e) => toast.error("Could not save that task", e));
    };
  }, [task.id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const db = await getDb();
      const rows = await db.select<Run[]>(
        "SELECT * FROM runs WHERE task_id = $1 ORDER BY started_at DESC",
        [task.id]
      );
      if (alive) setHistory(rows);
    })();
    return () => {
      alive = false;
    };
  }, [task.id]);

  async function changeAssignee(next: string) {
    setAssignee(next);
    try {
      // Through the graph, so the avatar stacks, the inspector and the prompt
      // builder all learn about it at the same moment.
      await setPrimaryAssignee(task.id, next);
    } catch (e) {
      toast.error("Could not change the assignee", e);
      setAssignee(task.assignee_agent_id);
    }
  }

  async function dispatchToAgent() {
    if (!agent || !sendChannel) return;
    await flush();
    // Make membership explicit so the mention resolves to the assignee (INSERT OR IGNORE — idempotent).
    await store.addChannelMember(sendChannel, "agent", agent.id);
    const content = `@${slug(agent.name)} please work on this task: **${title.trim()}**${description ? `\n\n${description}` : ""}`;
    const msg = await store.insertMessage({
      id: uid(),
      channel_id: sendChannel,
      author_type: "user",
      author_id: "user",
      author_name: useStore.getState().self().name,
      content,
      status: "done",
      meta: "",
    });
    await store.updateTask(task.id, { status: "doing" });
    // The status this panel is holding is now stale by design, and the unmount
    // write must not put "todo" back over the "doing" we just set.
    settled.current = true;
    onClose();
    store.setView({ type: "channel", channelId: sendChannel });
    void triggerAgents(sendChannel, userTrigger(msg, task.id));
  }

  async function remove() {
    if (!(await deleteTaskWithUndo(task))) return;
    settled.current = true;
    onClose();
  }

  return (
    <SidePanel
      title="Task"
      subtitle={project?.name}
      onClose={onClose}
      storageKey="task"
      className="task-panel"
      footer={
        <>
          <button type="button" className="btn danger task-panel-del" onClick={() => void remove()}>
            Delete
          </button>
          <span className="task-panel-state" aria-live="polite">
            {saving ? "Saving…" : "Saved as you type"}
          </span>
        </>
      }
    >
      <Field label="Title">
        <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {/* Two per row, not three: a panel is 420px, and a date input that has to
          share a line with two selects stops being clickable. */}
      <div className="row fields-row">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
            {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Due">
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <Field label="Assignee">
        <select value={assignee} onChange={(e) => void changeAssignee(e.target.value)}>
          <option value="">Unassigned</option>
          {store.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>)}
        </select>
      </Field>

      {agent && channels.length > 0 && (
        <PanelSection title={`Send it to ${agent.name}`}>
          <div className="dispatch-row">
            <select value={sendChannel} onChange={(e) => setSendChannel(e.target.value)}>
              {channels.map((c) => {
                const isMember = channelAgents(store, c.id).some((a) => a.id === agent.id);
                return (
                  <option key={c.id} value={c.id}>#{c.name}{isMember ? "" : " (will be added)"}</option>
                );
              })}
            </select>
            <button className="btn" onClick={() => void dispatchToAgent()}>▶ Send</button>
          </div>
        </PanelSection>
      )}

      {/* The connections panel names its own two halves, so this section labels
          what they add up to: the standing context every agent working on this
          task is handed. */}
      <PanelSection title="Shared context">
        <ConnectionsPanel anchor={{ type: "task", id: task.id }} />
      </PanelSection>

      {history.length > 0 && (
        <PanelSection title="Run history">
          {history.map((r) => {
            const a = store.agents.find((x) => x.id === r.agent_id);
            return (
              <button
                key={r.id}
                className="run-row"
                onClick={() => void openRunLocation(r.id, r.channel_id, store.setView)}
              >
                <span className="run-agent">{a?.name ?? "unknown agent"}</span>
                <span className={"chip tiny-chip run-status " + r.status}>{r.status}</span>
                {r.meta && <span className="run-meta">{r.meta}</span>}
                <span className="run-time">{timeAgo(r.started_at)}</span>
              </button>
            );
          })}
        </PanelSection>
      )}
    </SidePanel>
  );
}
