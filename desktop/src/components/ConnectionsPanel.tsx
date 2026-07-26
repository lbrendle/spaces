/**
 * "Who is on this, and what is it about?" — rendered once, embedded in task
 * modals, memory entries, channel headers and the inspector.
 *
 * The panel is not a listing of database rows; it is the surface where a person
 * teaches the agents what belongs together. Every affordance here is therefore
 * reversible: an accidental link poisons agent context quietly, so removing one
 * is always a click away and every write comes back with an Undo.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { KIND_BY_TYPE } from "../entities";
import { ASSIGN_ROLES, assigneesOf, connectionsFor } from "../links";
import type { AssignmentView, Connection } from "../links";
import { confirmAction, toast } from "../toast";
import { refKey } from "../types";
import type { AssignRole, EntityRef } from "../types";
import { EntityAvatarStack, EntityChip, useEntity } from "./EntityChip";
import { LinkPicker, RadioChips } from "./LinkPicker";
import { IconCheck, IconPlus } from "./icons";
import { Avatar } from "./ui";
import "./connections.css";

/* ── assigning ────────────────────────────────────────────────── */

/**
 * A task's canonical `assignee_agent_id` is what the board and the prompt
 * builder read, and store.assign keeps it in step for exactly one role — so on
 * a task that role is the one to offer first. Elsewhere, ownership is the
 * relationship people mean.
 */
function defaultRole(anchor: EntityRef): AssignRole {
  return anchor.type === "task" ? "assignee" : "owner";
}

function AssignPicker({ anchor, onDone }: { anchor: EntityRef; onDone: () => void }) {
  const [role, setRole] = useState<AssignRole>(() => defaultRole(anchor));
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const assignments = useStore((s) => s.assignments);
  const assign = useStore((s) => s.assign);
  const unassign = useStore((s) => s.unassign);
  const anchorInfo = useEntity(anchor);

  const help = ASSIGN_ROLES.find((r) => r.role === role)?.help ?? "";
  const taken = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) {
      if (a.target_type === anchor.type && a.target_id === anchor.id && a.role === role) {
        set.add(`${a.subject_type}:${a.subject_id}`);
      }
    }
    return set;
  }, [assignments, anchor.type, anchor.id, role]);

  const candidates: { ref: EntityRef; name: string; sub: string; kind?: string }[] = [
    ...agents.map((a) => ({
      ref: { type: "agent", id: a.id } as EntityRef,
      name: a.name,
      sub: a.role || a.kind,
      kind: a.kind,
    })),
    ...teams.map((t) => ({
      ref: { type: "team", id: t.id } as EntityRef,
      name: t.name,
      sub: t.description || "Team",
    })),
  ];

  async function put(subject: EntityRef, name: string) {
    try {
      const before = useStore.getState().assignments;
      const row = await assign(subject, anchor, role);
      if (!row) return;
      if (!before.some((a) => a.id === row.id)) {
        toast.show({
          kind: "success",
          title: `${name} is now ${role === "owner" ? "the" : "a"} ${role} of ${anchorInfo.title}`,
          action: { label: "Undo", run: () => void unassign(row.id) },
        });
      }
      onDone();
    } catch (e) {
      toast.error("Could not assign that", e);
    }
  }

  return (
    <div className="cx-assign" role="group" aria-label={`Assign someone to ${anchorInfo.title}`}>
      <RadioChips
        label="Role"
        value={role}
        onChange={setRole}
        options={ASSIGN_ROLES.map((r) => ({ value: r.role, label: r.label, title: r.help }))}
      />
      <p className="cx-assign-help">{help}</p>
      <ul className="cx-picks">
        {candidates.map((c) => {
          const on = taken.has(refKey(c.ref));
          return (
            <li key={refKey(c.ref)}>
              <button
                type="button"
                className="cx-pick"
                disabled={on}
                aria-label={on ? `${c.name} is already ${role}` : `Assign ${c.name} as ${role}`}
                onClick={() => void put(c.ref, c.name)}
              >
                <Avatar name={c.name} id={c.ref.id} kind={c.kind} />
                <span className="cx-pick-ident">
                  <span className="cx-pick-name">{c.name}</span>
                  <span className="cx-pick-sub">{c.sub}</span>
                </span>
                {on && <IconCheck size={12} className="cx-pick-on" />}
              </button>
            </li>
          );
        })}
        {candidates.length === 0 && (
          <li className="cx-assign-help">
            No agents or teams yet. Create one in Agents &amp; Teams, then anyone here can put it
            on this.
          </li>
        )}
      </ul>
    </div>
  );
}

/* ── the panel ────────────────────────────────────────────────── */

export interface ConnectionsPanelProps {
  anchor: EntityRef;
  /** Tighter type and spacing, for the inspector rail and channel headers. */
  compact?: boolean;
}

export function ConnectionsPanel({ anchor, compact }: ConnectionsPanelProps) {
  const [picking, setPicking] = useState(false);
  const [assigning, setAssigning] = useState(false);
  /**
   * Links drawn in this sitting. Confirming the removal of a link you regretted
   * one second after making it is friction for nothing; confirming the removal
   * of one someone drew last week is the whole point of confirming.
   */
  const justLinked = useRef(new Set<string>());

  const links = useStore((s) => s.links);
  const assignments = useStore((s) => s.assignments);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const addLink = useStore((s) => s.addLink);
  const removeLink = useStore((s) => s.removeLink);
  const assign = useStore((s) => s.assign);
  const unassign = useStore((s) => s.unassign);

  const anchorInfo = useEntity(anchor);
  const key = refKey(anchor);
  const assignable = KIND_BY_TYPE[anchor.type]?.assignable ?? false;

  const roleGroups = useMemo(() => {
    const by = new Map<string, AssignmentView[]>();
    // assigneesOf already orders by role, so insertion order is the right order.
    for (const v of assigneesOf(anchor).filter((v) => v.info.exists)) {
      const list = by.get(v.roleLabel);
      if (list) list.push(v);
      else by.set(v.roleLabel, [v]);
    }
    return [...by.entries()];
    // key is the whole of anchor; the rest is what assigneesOf reads
  }, [key, assignments, agents, teams]);

  const linkGroups = useMemo(() => {
    const by = new Map<string, Connection[]>();
    for (const c of connectionsFor(anchor)) {
      const list = by.get(c.label);
      if (list) list.push(c);
      else by.set(c.label, [c]);
    }
    return [...by.entries()];
    // key is the whole of anchor; links is what connectionsFor reads
  }, [key, links, agents, teams]);

  const unlink = useCallback(
    async (c: Connection) => {
      const sentence = `${anchorInfo.title} ${c.label} ${c.info.title}`;
      if (!justLinked.current.has(c.link.id)) {
        const ok = await confirmAction({
          title: "Remove this connection?",
          body: `${sentence}. Agents working here will stop seeing it as standing context.`,
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
      }
      const { link } = c;
      try {
        await removeLink(link.id);
        justLinked.current.delete(link.id);
        toast.show({
          kind: "info",
          title: "Connection removed",
          detail: sentence,
          action: {
            label: "Undo",
            run: () =>
              void addLink(
                { type: link.from_type, id: link.from_id },
                { type: link.to_type, id: link.to_id },
                link.kind,
                link.note,
                link.created_by
              ),
          },
        });
      } catch (e) {
        toast.error("Could not remove that link", e);
      }
    },
    [anchorInfo.title, removeLink, addLink]
  );

  const drop = useCallback(
    async (v: AssignmentView) => {
      try {
        await unassign(v.assignment.id);
        toast.show({
          kind: "info",
          title: `${v.info.title} is no longer ${v.roleLabel.toLowerCase()} of ${anchorInfo.title}`,
          action: { label: "Undo", run: () => void assign(v.subject, anchor, v.role) },
        });
      } catch (e) {
        toast.error("Could not remove that assignment", e);
      }
    },
    [unassign, assign, anchor, anchorInfo.title]
  );

  const bare = roleGroups.length === 0 && linkGroups.length === 0;

  const assignButton = (
    <button
      type="button"
      className="cx-add"
      aria-expanded={assigning}
      onClick={() => {
        setAssigning((v) => !v);
        setPicking(false);
      }}
    >
      <IconPlus size={11} />
      Assign
    </button>
  );

  const linkButton = (
    <button type="button" className="cx-add" onClick={() => setPicking(true)}>
      <IconPlus size={11} />
      Link
    </button>
  );

  return (
    <section className={"cx" + (compact ? " cx-compact" : "")} aria-label="Assignments and connections">
      {bare ? (
        <div className="cx-blank">
          <p className="cx-blank-text">
            Linking is how agents find out what this is about — anything you connect here rides
            along as standing context the next time one of them works on it.
          </p>
          <div className="cx-blank-actions">
            {assignable && assignButton}
            {linkButton}
          </div>
          {assigning && assignable && <AssignPicker anchor={anchor} onDone={() => setAssigning(false)} />}
        </div>
      ) : (
        <>
          {assignable && (
            <div className="cx-sec">
              <div className="cx-sec-head">
                <h4 className="cx-sec-title">Assigned</h4>
                {assignButton}
              </div>
              {roleGroups.map(([label, views]) => (
                <div className="cx-group" key={label}>
                  <span className="cx-group-label">{label}</span>
                  <ul className="cx-items">
                    {views.map((v) => (
                      <li key={v.assignment.id}>
                        <EntityChip
                          ref={v.subject}
                          size={compact ? "sm" : "md"}
                          onRemove={() => void drop(v)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {roleGroups.length === 0 && (
                <p className="cx-none">Nobody is on this yet.</p>
              )}
              {assigning && <AssignPicker anchor={anchor} onDone={() => setAssigning(false)} />}
            </div>
          )}

          <div className="cx-sec">
            <div className="cx-sec-head">
              <h4 className="cx-sec-title">Connections</h4>
              {linkButton}
            </div>
            {linkGroups.map(([label, list]) => (
              <div className="cx-group" key={label}>
                <span className="cx-group-label">{label}</span>
                <ul className="cx-items">
                  {list.map((c) => (
                    <li key={c.link.id}>
                      <EntityChip
                        ref={c.other}
                        size={compact ? "sm" : "md"}
                        showType={!compact}
                        onRemove={() => void unlink(c)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {linkGroups.length === 0 && (
              <p className="cx-none">Not connected to anything yet.</p>
            )}
          </div>
        </>
      )}

      {picking && (
        <LinkPicker
          anchor={anchor}
          onClose={() => setPicking(false)}
          onLinked={(link) => justLinked.current.add(link.id)}
        />
      )}
    </section>
  );
}

/* ── the one-liner ────────────────────────────────────────────── */

export interface ConnectionsSummaryProps {
  anchor: EntityRef;
  /** Faces before the list collapses to "+N". */
  max?: number;
}

const ROLE_ORDER = new Map(ASSIGN_ROLES.map((r, i) => [r.role, i] as const));

/**
 * The board-card version. This lands on every row of every list, so it never
 * touches describeEntity or connectionsFor — both build objects per call, and
 * a hundred of those per keystroke is a stutter. Counting rows is enough.
 */
export function ConnectionsSummary({ anchor, max = 3 }: ConnectionsSummaryProps) {
  const links = useStore((s) => s.links);
  const assignments = useStore((s) => s.assignments);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const key = refKey(anchor);

  const { subjects, count } = useMemo(() => {
    const rows = assignments
      .filter((a) => a.target_type === anchor.type && a.target_id === anchor.id)
      .filter((a) =>
        a.subject_type === "agent"
          ? agents.some((x) => x.id === a.subject_id)
          : teams.some((x) => x.id === a.subject_id)
      )
      .sort((a, b) => (ROLE_ORDER.get(a.role) ?? 9) - (ROLE_ORDER.get(b.role) ?? 9));

    const seen = new Set<string>();
    const subjects: EntityRef[] = [];
    for (const a of rows) {
      const k = `${a.subject_type}:${a.subject_id}`;
      if (seen.has(k)) continue; // one face per agent, however many hats it wears
      seen.add(k);
      subjects.push({ type: a.subject_type, id: a.subject_id });
    }

    let count = 0;
    for (const l of links) {
      if (
        (l.from_type === anchor.type && l.from_id === anchor.id) ||
        (l.to_type === anchor.type && l.to_id === anchor.id)
      ) {
        count++;
      }
    }
    return { subjects, count };
    // key is the whole of anchor
  }, [key, links, assignments, agents, teams]);

  if (!subjects.length && !count) return null;

  return (
    <span className="cxs">
      <EntityAvatarStack refs={subjects} max={max} />
      {count > 0 && (
        <span className="cxs-count">
          <span className="cxs-glyph" aria-hidden="true">⇄</span>
          {count} link{count === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}
