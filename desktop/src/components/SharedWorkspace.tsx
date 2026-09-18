/**
 * SharedWorkspace — one picture of what every agent is doing to the code.
 *
 * The Workspaces view already showed a card per checkout: branch, file count,
 * commit, merge. That answers "what is in this worktree" one worktree at a
 * time, which is the wrong shape for the question people actually have when
 * three agents and a person are in the same repository — *are we about to
 * stand on each other, and in what order does today's work land?*
 *
 * So this reads across all of them at once:
 *
 *   - **Holding** — paths more than one agent is changing. Two uncommitted
 *     edits to the same path in the same tree is the expensive one; it is not a
 *     merge conflict waiting to happen, it is one agent about to overwrite work
 *     git has no record of. It is drawn first and in red for that reason.
 *   - **Lanes** — every agent's branch, how far ahead and how stale, drawn to a
 *     shared scale so relative size is readable without reading numbers.
 *   - **Landing order** — the merge sequence, simulated in memory. It sees
 *     branches that conflict with *each other*, not only with the base.
 *
 * External agents (Muse, Cursor, a terminal someone drives by hand) appear
 * here exactly like spawned ones, because git cannot tell the difference and
 * neither should this.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, Project } from "../types";
import {
  integrationPlan,
  workspaceMap,
  type AgentLane,
  type IntegrationPlan,
  type Overlap,
  type WorkspaceMap,
} from "../coordination";
import { reportHandOffs } from "../agents";
import { Avatar, Spinner } from "./ui";
import { HarnessMark } from "./Face";
import "./sharedworkspace.css";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "3m", "2h", "5d" — a lane's age needs to be glanceable, not precise. */
function ago(at: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function SharedWorkspace({
  project,
  agents,
  tick,
  openDiff,
}: {
  project: Project;
  agents: readonly Agent[];
  tick: number;
  /** Opens the existing diff modal for a directory. */
  openDiff: (title: string, dir: string) => void;
}) {
  const [map, setMap] = useState<WorkspaceMap | null>(null);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  // Monotonic token: a slow earlier read must not overwrite a newer one.
  const req = useRef(0);

  const load = useCallback(async () => {
    const token = ++req.current;
    setLoading(true);
    setError("");
    try {
      const next = await workspaceMap(project, agents);
      if (token !== req.current) return;
      setMap(next);
      setError(next.error);
      // Credit any external teammate that worked since its last hand-off. This
      // is the only place that happens on a schedule, so opening the view is
      // what turns overnight work into a message.
      void reportHandOffs(project.id).catch(() => 0);
    } catch (e) {
      if (token === req.current) setError(errText(e));
    } finally {
      if (token === req.current) setLoading(false);
    }
  }, [project, agents]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // The plan is the expensive read — it runs a merge per branch — so it is not
  // folded into the map. Asking for it is deliberate.
  const buildPlan = useCallback(async () => {
    if (!map) return;
    const token = req.current;
    setPlanning(true);
    try {
      const next = await integrationPlan(project, map);
      if (token === req.current) setPlan(next);
    } catch (e) {
      if (token === req.current) setError(errText(e));
    } finally {
      if (token === req.current) setPlanning(false);
    }
  }, [project, map]);

  // A new read invalidates the old plan rather than leaving a stale one on
  // screen claiming a branch still lands cleanly.
  useEffect(() => {
    setPlan(null);
  }, [map]);

  if (error) {
    return <div className="banner warn sw-error">{error}</div>;
  }
  if (!map) {
    return (
      <div className="sw-loading">
        <Spinner /> Reading the shared repository…
      </div>
    );
  }

  const active = map.lanes.filter(
    (l) => l.ahead > 0 || l.dirtyFiles.length > 0 || l.kind === "external"
  );
  const widest = Math.max(1, ...map.lanes.map((l) => l.adds + l.dels));

  return (
    <div className="sw">
      <div className="sw-head">
        <div>
          <span className="sw-title">Shared workspace</span>
          <span className="sw-sub">
            {active.length} active {active.length === 1 ? "lane" : "lanes"} · base{" "}
            <code>{map.base}</code>
          </span>
        </div>
        <button className="btn tiny" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner /> : "⟳"} Re-read
        </button>
      </div>

      {map.overlaps.length > 0 && <Holding overlaps={map.overlaps} />}

      {active.length === 0 ? (
        <div className="sw-empty">
          Nothing in flight. Every agent is level with <code>{map.base}</code>.
        </div>
      ) : (
        <div className="sw-lanes">
          {active.map((lane) => (
            <Lane
              key={lane.agent.id}
              lane={lane}
              base={map.base}
              widest={widest}
              openDiff={openDiff}
            />
          ))}
        </div>
      )}

      <Landing
        plan={plan}
        planning={planning}
        onBuild={() => void buildPlan()}
        landable={map.lanes.some((l) => l.ahead > 0)}
        base={map.base}
      />
    </div>
  );
}

/* ── overlap ─────────────────────────────────────────────────── */

function Holding({ overlaps }: { overlaps: readonly Overlap[] }) {
  const [expanded, setExpanded] = useState(false);
  const live = overlaps.filter((o) => o.severity === "live");
  const diverging = overlaps.filter((o) => o.severity === "diverging");
  const shown = expanded ? overlaps : overlaps.slice(0, 5);

  return (
    <div className={`sw-holding ${live.length ? "danger" : ""}`}>
      <div className="sw-holding-head">
        {live.length > 0 ? (
          <>
            <strong>{live.length}</strong> {live.length === 1 ? "file is" : "files are"} being
            edited by more than one agent in the same tree right now
          </>
        ) : (
          <>
            <strong>{diverging.length}</strong> {diverging.length === 1 ? "file" : "files"}{" "}
            changed on more than one branch
          </>
        )}
      </div>
      <div className="sw-holding-why">
        {live.length > 0
          ? "Whoever saves last wins, and git keeps no record of what the other one had. Coordinate before either continues."
          : "These will meet as merge conflicts when the branches land."}
      </div>
      <ul className="sw-holding-list">
        {shown.map((o) => (
          <li key={o.path} className={o.severity === "live" ? "live" : ""}>
            <code>{o.path}</code>
            <span className="sw-holding-who">
              {o.agents.map((a) => a.agentName).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {overlaps.length > 5 && (
        <button className="btn tiny ghost" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show fewer" : `Show all ${overlaps.length}`}
        </button>
      )}
    </div>
  );
}

/* ── one agent's lane ────────────────────────────────────────── */

function Lane({
  lane,
  base,
  widest,
  openDiff,
}: {
  lane: AgentLane;
  base: string;
  widest: number;
  openDiff: (title: string, dir: string) => void;
}) {
  const size = lane.adds + lane.dels;
  // A shared scale, floored so a one-line change is still a visible mark
  // rather than nothing at all.
  const width = size ? `${Math.max(4, Math.round((size / widest) * 100))}%` : "0";
  const addShare = size ? (lane.adds / size) * 100 : 0;

  return (
    <div className="sw-lane">
      <div className="sw-lane-who">
        <Avatar name={lane.agent.name} id={lane.agent.id} kind="agent" />
        <div className="sw-lane-id">
          <span className="sw-lane-name">
            {lane.agent.name}
            <HarnessMark kind={lane.agent.kind} size={12} />
          </span>
          <span className="sw-lane-branch" title={lane.workdir}>
            {lane.branch || "no branch yet"}
          </span>
        </div>
      </div>

      <div className="sw-lane-bar" aria-hidden="true">
        <div className="sw-lane-fill" style={{ width }}>
          <div className="sw-lane-add" style={{ width: `${addShare}%` }} />
        </div>
      </div>

      <div className="sw-lane-facts">
        {lane.ahead > 0 && (
          <span className="sw-fact" title={`${lane.ahead} commits ${base} does not have`}>
            +{lane.ahead}
          </span>
        )}
        {lane.behind > 0 && (
          <span className="sw-fact stale" title={`${lane.behind} commits behind ${base}`}>
            −{lane.behind}
          </span>
        )}
        {lane.dirtyFiles.length > 0 && (
          <button
            className="sw-fact dirty"
            title={`${lane.dirtyFiles.length} uncommitted files — open the diff`}
            onClick={() => openDiff(`${lane.agent.name} — uncommitted`, lane.workdir)}
          >
            ● {lane.dirtyFiles.length}
          </button>
        )}
        {lane.kind === "external" && <span className="sw-fact ext">external</span>}
        {lane.lastAt > 0 && <span className="sw-fact quiet">{ago(lane.lastAt)}</span>}
      </div>

      {lane.lastSubject && <div className="sw-lane-subject">{lane.lastSubject}</div>}
      {!lane.readable && (
        <div className="sw-lane-subject warn">
          Spaces cannot read {lane.workdir || "this agent's directory"} — set its working
          directory so its work shows up here.
        </div>
      )}
    </div>
  );
}

/* ── landing order ───────────────────────────────────────────── */

function Landing({
  plan,
  planning,
  onBuild,
  landable,
  base,
}: {
  plan: IntegrationPlan | null;
  planning: boolean;
  onBuild: () => void;
  landable: boolean;
  base: string;
}) {
  if (!landable) return null;

  if (!plan) {
    return (
      <div className="sw-landing-cta">
        <button className="btn tiny" onClick={onBuild} disabled={planning}>
          {planning ? <Spinner /> : null} Work out the landing order
        </button>
        <span className="sw-landing-note">
          Merges every branch in memory — nothing is checked out, committed or moved.
        </span>
      </div>
    );
  }

  const sequence = [...plan.steps, ...plan.blocked].sort((a, b) => a.position - b.position);
  const blocked = plan.blocked.length;

  return (
    <div className="sw-landing">
      <div className="sw-landing-head">
        Landing order into <code>{base}</code>
        {blocked > 0 && (
          <span className="sw-landing-blocked">
            {blocked} won&apos;t land as {blocked === 1 ? "it is" : "they are"}
          </span>
        )}
        <button className="btn tiny ghost" onClick={onBuild} disabled={planning}>
          {planning ? <Spinner /> : "⟳"}
        </button>
      </div>

      {sequence.length === 0 && <div className="sw-empty">Nothing to land.</div>}

      {/* One sequence, in the order the merges were simulated. Listing the
          blocked ones afterwards would put "conflicts once 2 earlier branches
          are in" below four of them, which reads as a contradiction. */}
      {sequence.map((step) => {
        const blocked = step.order === 0;
        return (
          <div className={`sw-step${blocked ? " blocked" : ""}`} key={step.lane.agent.id}>
            <span className="sw-step-order">{blocked ? "!" : step.order}</span>
            <div className="sw-step-body">
              <span className="sw-step-name">
                {step.lane.agent.name} · <code>{step.lane.branch}</code>
              </span>
              <span className="sw-step-note">{step.note}</span>
              {step.check.conflicts.length > 0 && (
                <ul className="sw-step-conflicts">
                  {step.check.conflicts.slice(0, 8).map((p) => (
                    <li key={p}>
                      <code>{p}</code>
                    </li>
                  ))}
                  {step.check.conflicts.length > 8 && (
                    <li className="quiet">+{step.check.conflicts.length - 8} more</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
