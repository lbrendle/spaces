/**
 * The roster.
 *
 * Agents here are not personal accounts: they belong to the workspace and
 * everyone can run anyone's. So this view is a directory of colleagues, and it
 * has to answer three questions before it answers anything else — who is on
 * this team, what do they own, and can I actually run them right now.
 *
 * Availability is the honest half. An agent wraps a runtime that lives on a
 * machine: `claude` and `codex` are binaries on somebody's PATH, Ritz is an
 * engine answering on a local port. A runtime missing *here* is not an error
 * and not the agent's fault — this machine cannot host that one, and a
 * teammate whose machine can still runs it. Every string in this file is
 * written to that fact and must stay written to it.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { config } from "../config";
import { slug } from "../types";
import type {
  Agent,
  AgentSession,
  AssignRole,
  Channel,
  EntityRef,
  LinkKind,
  Run,
  Team,
} from "../types";
import { ASSIGN_ROLES, workloadOf } from "../links";
import type { AssignmentView } from "../links";
import { useAutosave, useSaveShortcut } from "../autosave";
import { confirmAction, toast } from "../toast";
import { timeAgo } from "../github";
import { Avatar, Field, Modal, Spinner } from "./ui";
import { SaveState, useCloseGuard } from "./SaveState";
import { EntityAvatarStack, EntityChip } from "./EntityChip";
import { HarnessMark } from "./Face";
import { RadioChips } from "./LinkPicker";
import { IconPlus, IconX, IconInfo, IconGear, IconBolt, IconSearch, IconCheck } from "./icons";
import {
  HARNESSES,
  agentChips,
  carryOver,
  commandPreview,
  defaultsFor,
  fetchRitzModels,
  checkRitzRuntime,
  groupedOptions,
  harnessFor,
  parseArgs,
  riskNotes,
  serializeArgs,
  RITZ_BASE,
  ritzBase,
  ritzHealthRoute,
  ritzAuthHeaders,
} from "../capabilities";
import type { HarnessKind, HarnessOption, OptionValue, OptionValues, RitzModel } from "../capabilities";
import "./agents.css";

/* ── can it run from here? ───────────────────────────────────── */

/** "unknown" is a real answer: PATH detection can fail, and Ritz takes a moment. */
type Availability = "ready" | "unavailable" | "unknown";

interface Runtimes {
  of(kind: string, program?: string): Availability;
  recheck(): void;
  checking: boolean;
}

/** How long to wait on 127.0.0.1:8765 before calling it down. */
const RITZ_TIMEOUT = 2500;

/**
 * Two different questions, because the runtimes are two different things:
 * claude and codex are binaries the Rust side looks for on PATH, Ritz either
 * answers on its port right now or does not. Ritz is only asked when somebody
 * actually has a Ritz agent — an idle workspace shouldn't poll a local port.
 */
type HttpRuntime = { base: string; healthRoute: string; authentication: string };

function useRuntimes(httpRuntimes: HttpRuntime[] = [], customPrograms: string[] = []): Runtimes {
  const tools = useStore((s) => s.tools);
  const [ritz, setRitz] = useState<Record<string, Availability>>({});
  const [checking, setChecking] = useState(false);
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0);
  const customKey = [...new Set(customPrograms.map((p) => p.trim()).filter(Boolean))].sort().join("\n");
  const ritzKey = [...new Map(
    httpRuntimes
      .filter((runtime) => runtime.base.trim())
      .map((runtime) => [
        runtime.base.trim(),
        `${runtime.base.trim()}\t${runtime.healthRoute.trim()}\t${runtime.authentication.trim()}`,
      ])
  ).values()].sort().join("\n");

  useEffect(() => {
    const runtimes = ritzKey
      ? ritzKey.split("\n").map((line) => {
          const [base, healthRoute = "/health", authentication = "trusted-local-origin"] = line.split("\t", 3);
          return { base, healthRoute, authentication };
        })
      : [];
    if (!runtimes.length) {
      setRitz({});
      return;
    }
    let live = true;
    const ac = new AbortController();
    // A dead port refuses instantly; the timeout is for the other case —
    // something else holding 8765 and never answering.
    const timer = window.setTimeout(() => ac.abort(), RITZ_TIMEOUT);
    setRitz(Object.fromEntries(runtimes.map(({ base }) => [base, "unknown"])));
    void Promise.all(runtimes.map(async ({ base, healthRoute, authentication }) => {
      try {
        const headers = await ritzAuthHeaders({ authentication });
        await checkRitzRuntime(ac.signal, base, healthRoute, headers);
        return [base, "ready"] as const;
      } catch {
        return [base, "unavailable"] as const;
      }
    })).then((pairs) => {
      if (live) setRitz(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
      clearTimeout(timer);
      ac.abort();
    };
  }, [ritzKey, nonce]);

  useEffect(() => {
    const programs = customKey ? customKey.split("\n") : [];
    if (!programs.length) {
      setCustom({});
      return;
    }
    let live = true;
    void Promise.all(
      programs.map(async (program) => [program, await invoke<boolean>("check_program", { program })] as const)
    ).then((pairs) => {
      if (live) setCustom(Object.fromEntries(pairs));
    }).catch(() => {
      if (live) setCustom(Object.fromEntries(programs.map((program) => [program, false])));
    });
    return () => { live = false; };
  }, [customKey, nonce]);

  const recheck = useCallback(() => {
    setChecking(true);
    setNonce((n) => n + 1);
    invoke<Record<string, boolean>>("check_tools")
      .then((found) => useStore.setState({ tools: found }))
      .catch((e: unknown) => toast.error("Could not read this machine's PATH", e))
      .finally(() => setChecking(false));
  }, []);

  // Identity matters: the roster memoizes every card off this object, so it
  // may only change when an answer actually changes.
  return useMemo(
    () => ({
      of: (kind: string, program = ""): Availability => {
        if (kind === "ritz") {
          const key = (program || RITZ_BASE).trim();
          return ritz[key] ?? "unknown";
        }
        if (kind === "custom") {
          const key = program.trim();
          if (!key) return "unavailable";
          return custom[key] === undefined ? "unknown" : custom[key] ? "ready" : "unavailable";
        }
        const found = tools[kind];
        return found === undefined ? "unknown" : found ? "ready" : "unavailable";
      },
      recheck,
      checking,
    }),
    [tools, ritz, custom, recheck, checking]
  );
}

/** Why an agent can't run from this machine — never phrased as a fault. */
function unavailableNote(kind: string, name: string, runtime = ""): string {
  const handle = `@${slug(name)}`;
  if (kind === "ritz") {
    const endpoint = runtime || RITZ_BASE;
    return `${config().localAiName} isn't answering on ${endpoint.replace("http://", "")}, so ${handle} can't run from this machine. Anyone whose engine is up can still use it.`;
  }
  if (kind === "custom") {
    return `That custom executable isn't available on this machine, so ${handle} can't run here. Configure its command or host it on a teammate's device.`;
  }
  const bin = kind === "codex" ? "codex" : "claude";
  return `${bin} isn't on this machine's PATH, so ${handle} can't run from here. Teammates who have it can.`;
}

/* ── the hardest part of a new agent is the blank persona box ── */

interface AgentPreset {
  id: string;
  label: string;
  /** What this one is for, in the picker. */
  blurb: string;
  name: string;
  role: string;
  owns: string;
  persona: string;
}

const PRESETS: AgentPreset[] = [
  {
    id: "reviewer",
    label: "Reviewer",
    blurb: "Reads diffs, argues about them, doesn't write them.",
    name: "Reviewer",
    role: "Reviewer",
    owns: "code review, PR feedback",
    persona:
      "You review changes; you do not write features. Read the diff before saying anything about it. Lead with the one thing that would actually break, then correctness, then naming and style — and say which is which. Quote the file and line you mean. If a change is fine, say so in one sentence rather than inventing work.",
  },
  {
    id: "frontend",
    label: "Frontend",
    blurb: "UI work, with taste and accessibility built in.",
    name: "Frontend",
    role: "Frontend",
    owns: "src/components, styling, accessibility",
    persona:
      "You own the interface. Match the surrounding code before inventing a pattern, and reuse the existing design tokens rather than hardcoding values. Every interactive thing needs a keyboard path, a visible focus state and an accessible name. Never add a dependency without asking first. Small, reviewable diffs.",
  },
  {
    id: "backend",
    label: "Backend",
    blurb: "Data model, migrations, the parts that must not lose data.",
    name: "Backend",
    role: "Backend",
    owns: "data model, migrations, background jobs",
    persona:
      "You own the data layer. Schema changes come with a migration and a way back. Prefer boring, explicit code at the boundaries: validate input, handle the error case, never swallow a failure silently. Say plainly when a change is irreversible before you make it.",
  },
  {
    id: "docs",
    label: "Docs",
    blurb: "Writes the README the next person actually needs.",
    name: "Docs",
    role: "Docs",
    owns: "README, docs/, changelog",
    persona:
      "You write for the person arriving tomorrow with no context. Read the code before describing it — never document behaviour you have not verified. Short sentences, concrete examples, no marketing voice. When something is confusing, say so and suggest the fix rather than papering over it with prose.",
  },
];

/* ── what the directory knows about each name ────────────────── */

interface AgentRow {
  agent: Agent;
  handle: string;
  availability: Availability;
  /** Runs in flight right now, newest first. */
  running: Run[];
  /** Last time this agent did anything at all, ms epoch; 0 = never. */
  lastActive: number;
  workload: AssignmentView[];
  teams: Team[];
  /** Channels it was added to by name. */
  direct: Channel[];
  /** Channels it sits in because a team it belongs to is a member. */
  viaTeam: { channel: Channel; team: Team }[];
  haystack: string;
}

interface DiscoveredAgentProfile {
  path: string;
  name: string;
  kind: Agent["kind"];
  description: string;
  model: string;
  persona: string;
}

interface TeamRow {
  team: Team;
  handle: string;
  members: Agent[];
  workload: AssignmentView[];
  channels: Channel[];
  /** Members that could run from this machine right now. */
  ready: number;
  /** Assignments carried by the members themselves, on top of the team's own. */
  memberLoad: number;
  lastActive: number;
  haystack: string;
}

const ROLE_ORDER = new Map(ASSIGN_ROLES.map((r, i) => [r.role, i] as const));

function byRole(a: AssignmentView, b: AssignmentView): number {
  return (ROLE_ORDER.get(a.role) ?? 9) - (ROLE_ORDER.get(b.role) ?? 9);
}

function lastActiveOf(agentId: string, sessions: AgentSession[], runs: Record<string, Run>): number {
  let t = 0;
  for (const s of sessions) if (s.agent_id === agentId && s.updated_at > t) t = s.updated_at;
  for (const r of Object.values(runs)) {
    if (r.agent_id !== agentId) continue;
    t = Math.max(t, r.finished_at || r.started_at);
  }
  return t;
}

/* ── the view ─────────────────────────────────────────────────── */

type HarnessFilter = "all" | HarnessKind;
type AvailFilter = "all" | "ready" | "running" | "unavailable";
type SortKey = "name" | "workload" | "recent";

/**
 * What the right-hand pane is showing. `seq` on the two "new" cases forces a
 * fresh editor each time — clicking New agent twice must not reuse the state of
 * the draft you just abandoned.
 */
type Sel =
  | { kind: "agent"; id: string }
  | { kind: "team"; id: string }
  | { kind: "new-agent"; seed?: Partial<Agent>; seq: number }
  | { kind: "new-team"; seq: number };

/** Below this the roster and the editor would each be too narrow to use. */
const SPLIT_AT = 900;

/**
 * A pane that may refuse to be left.
 *
 * Only the create forms use it: an agent that has never been saved is lost the
 * moment the pane changes, and losing a persona someone just wrote is exactly
 * the failure this whole screen is meant to stop.
 */
type LeaveGuard = () => Promise<boolean>;

export function AgentsView() {
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const teamMembers = useStore((s) => s.teamMembers);
  const channels = useStore((s) => s.channels);
  const channelMembers = useStore((s) => s.channelMembers);
  const projects = useStore((s) => s.projects);
  const assignments = useStore((s) => s.assignments);
  const tasks = useStore((s) => s.tasks);
  const sessions = useStore((s) => s.sessions);
  const runs = useStore((s) => s.runs);
  const activeRunIds = useStore((s) => s.activeRunIds);

  const [sel, setSel] = useState<Sel | null>(null);
  const [query, setQuery] = useState("");
  const [harness, setHarness] = useState<HarnessFilter>("all");
  const [avail, setAvail] = useState<AvailFilter>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredAgentProfile[]>([]);
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const runtimes = useRuntimes(
    agents.filter((a) => a.kind === "ritz").map((a) => {
      const values = parseArgs("ritz", a.cli_args);
      return {
        base: ritzBase(values),
        healthRoute: ritzHealthRoute(values),
        authentication: String(values.authentication || "trusted-local-origin"),
      };
    }),
    agents.filter((a) => a.kind === "custom").map((a) => a.model)
  );

  // The window is the wrong thing to measure: the sidebar and the inspector
  // both eat into this pane without the window changing size.
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const wide = width === 0 || width >= SPLIT_AT;

  // Set by whichever editor is mounted, cleared when it unmounts.
  const guard = useRef<LeaveGuard | null>(null);
  const select = useCallback(async (next: Sel | null) => {
    if (guard.current && !(await guard.current())) return;
    setSel(next);
  }, []);
  const openNewAgent = useCallback(
    (seed?: Partial<Agent>) => {
      seq.current += 1;
      void select({ kind: "new-agent", seed, seq: seq.current });
    },
    [select]
  );
  const openNewTeam = useCallback(() => {
    seq.current += 1;
    void select({ kind: "new-team", seq: seq.current });
  }, [select]);

  const rows = useMemo<AgentRow[]>(() => {
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
    return agents.map((agent) => {
      const myTeams = teamMembers
        .filter((tm) => tm.agent_id === agent.id)
        .map((tm) => teams.find((t) => t.id === tm.team_id))
        .filter((t): t is Team => !!t);

      const directIds = new Set(
        channelMembers
          .filter((m) => m.member_type === "agent" && m.member_id === agent.id)
          .map((m) => m.channel_id)
      );
      const direct = channels.filter((c) => directIds.has(c.id));
      const viaTeam: { channel: Channel; team: Team }[] = [];
      for (const team of myTeams) {
        for (const m of channelMembers) {
          if (m.member_type !== "team" || m.member_id !== team.id) continue;
          if (directIds.has(m.channel_id)) continue;
          const channel = channels.find((c) => c.id === m.channel_id);
          // First team wins the credit; a second one adds nothing to read.
          if (channel && !viaTeam.some((v) => v.channel.id === channel.id)) {
            viaTeam.push({ channel, team });
          }
        }
      }

      const workload = workloadOf({ type: "agent", id: agent.id }).sort(byRole);
      const running = activeRunIds
        .map((id) => runs[id])
        .filter((r): r is Run => !!r && r.agent_id === agent.id)
        .sort((a, b) => b.started_at - a.started_at);

      return {
        agent,
        handle: slug(agent.name),
        availability: runtimes.of(
          agent.kind,
          agent.kind === "ritz" ? ritzBase(parseArgs("ritz", agent.cli_args)) : agent.model
        ),
        running,
        lastActive: lastActiveOf(agent.id, sessions, runs),
        workload,
        teams: myTeams,
        direct,
        viaTeam,
        haystack: [
          agent.name,
          slug(agent.name),
          agent.role,
          agent.owns,
          agent.persona,
          agent.model,
          harnessFor(agent.kind).label,
          myTeams.map((t) => t.name).join(" "),
          direct.map((c) => `#${c.name} ${projectName(c.project_id)}`).join(" "),
          workload.map((w) => w.info.title).join(" "),
        ]
          .join(" ")
          .toLowerCase(),
      };
    });
  }, [
    agents, teams, teamMembers, channels, channelMembers, projects,
    assignments, tasks, sessions, runs, activeRunIds, runtimes,
  ]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const kept = rows.filter((r) => {
      if (q && !r.haystack.includes(q)) return false;
      if (harness !== "all" && r.agent.kind !== harness) return false;
      if (avail === "running") return r.running.length > 0;
      if (avail === "ready") return r.availability === "ready";
      if (avail === "unavailable") return r.availability === "unavailable";
      return true;
    });
    const order = [...kept];
    if (sort === "name") order.sort((a, b) => a.agent.name.localeCompare(b.agent.name));
    // Ties on a roll-up fall back to the name, so the grid never reshuffles
    // itself between two renders that know the same things.
    if (sort === "workload") {
      order.sort(
        (a, b) => b.workload.length - a.workload.length || a.agent.name.localeCompare(b.agent.name)
      );
    }
    if (sort === "recent") {
      order.sort(
        (a, b) =>
          Number(b.running.length > 0) - Number(a.running.length > 0) ||
          b.lastActive - a.lastActive ||
          a.agent.name.localeCompare(b.agent.name)
      );
    }
    return order;
  }, [rows, q, harness, avail, sort]);

  const shownIds = useMemo(() => new Set(filtered.map((r) => r.agent.id)), [filtered]);
  const loadById = useMemo(
    () => new Map(rows.map((r) => [r.agent.id, r.workload.length] as const)),
    [rows]
  );

  const teamRows = useMemo<TeamRow[]>(() => {
    return teams.map((team) => {
      const members = teamMembers
        .filter((tm) => tm.team_id === team.id)
        .map((tm) => agents.find((a) => a.id === tm.agent_id))
        .filter((a): a is Agent => !!a);
      const channelIds = new Set(
        channelMembers
          .filter((m) => m.member_type === "team" && m.member_id === team.id)
          .map((m) => m.channel_id)
      );
      return {
        team,
        handle: slug(team.name),
        members,
        workload: workloadOf({ type: "team", id: team.id }).sort(byRole),
        channels: channels.filter((c) => channelIds.has(c.id)),
        ready: members.filter((m) => runtimes.of(
          m.kind,
          m.kind === "ritz" ? ritzBase(parseArgs("ritz", m.cli_args)) : m.model
        ) === "ready").length,
        memberLoad: members.reduce((n, m) => n + (loadById.get(m.id) ?? 0), 0),
        lastActive: members.reduce((t, m) => Math.max(t, lastActiveOf(m.id, sessions, runs)), 0),
        haystack: [team.name, slug(team.name), team.description, team.charter,
          members.map((m) => m.name).join(" ")].join(" ").toLowerCase(),
      };
    });
  }, [
    teams, teamMembers, agents, channels, channelMembers,
    assignments, tasks, sessions, runs, runtimes, loadById,
  ]);

  // A team earns its place when it matches itself or holds a matching agent —
  // filtering the roster to "codex" and keeping a team of Claude agents would
  // be a lie about who is on screen.
  const filteredTeams = useMemo(() => {
    const narrowed = q !== "" || harness !== "all" || avail !== "all";
    if (!narrowed) return teamRows;
    return teamRows.filter(
      (t) => (q && t.haystack.includes(q)) || t.members.some((m) => shownIds.has(m.id))
    );
  }, [teamRows, q, harness, avail, shownIds]);

  const readyCount = rows.filter((r) => r.availability === "ready").length;
  const runningCount = rows.filter((r) => r.running.length > 0).length;
  const narrowed = q !== "" || harness !== "all" || avail !== "all";

  const selAgent = sel?.kind === "agent" ? rows.find((r) => r.agent.id === sel.id) ?? null : null;
  const selTeam = sel?.kind === "team" ? teamRows.find((r) => r.team.id === sel.id) ?? null : null;
  // Someone else's delete (or an Undo that minted a new id) leaves the
  // selection pointing at a row that is no longer there.
  useEffect(() => {
    if (sel?.kind === "agent" && !selAgent) setSel(null);
    if (sel?.kind === "team" && !selTeam) setSel(null);
  }, [sel, selAgent, selTeam]);

  function clearFilters() {
    setQuery("");
    setHarness("all");
    setAvail("all");
  }

  async function openLocalImport() {
    setImportOpen(true);
    setImportBusy(true);
    try {
      const response = await invoke<DiscoveredAgentProfile[]>("discover_agent_profiles", {
        projectRoots: projects.map((project) => project.local_path).filter(Boolean),
      });
      const profiles = Array.isArray(response) ? response : [];
      setDiscovered(profiles);
      setImportSelected(new Set(profiles.map((profile) => profile.path)));
    } catch (error) {
      toast.error("Could not scan local agent profiles", error);
    } finally {
      setImportBusy(false);
    }
  }

  async function importLocalProfiles() {
    const chosen = discovered.filter((profile) => importSelected.has(profile.path));
    if (!chosen.length) return;
    setImportBusy(true);
    const used = new Set(useStore.getState().agents.map((agent) => agent.name.toLowerCase()));
    let firstId = "";
    try {
      for (const profile of chosen) {
        let name = profile.name.trim() || "Imported agent";
        let suffix = 2;
        while (used.has(name.toLowerCase())) name = `${profile.name} ${suffix++}`;
        used.add(name.toLowerCase());
        const created = await useStore.getState().addAgent({
          name,
          kind: profile.kind,
          model: profile.model,
          persona: profile.persona,
          role: "Imported agent",
          owns: profile.description,
          cli_args: "",
        });
        if (!firstId) firstId = created.id;
      }
      toast.success(
        `${chosen.length} local agent${chosen.length === 1 ? "" : "s"} imported`,
        "Their instruction files were copied into the shared roster; the originals were not changed."
      );
      setImportOpen(false);
      if (firstId) setSel({ kind: "agent", id: firstId });
    } catch (error) {
      toast.error("Could not import local agents", error);
    } finally {
      setImportBusy(false);
    }
  }

  const showRoster = wide || !sel;
  /*
   * The detail column appears when there is a detail — not merely when the
   * window is wide enough to hold one.
   *
   * `wide || !!sel` meant that on any normal window the right two thirds of
   * this screen were permanently occupied, and with nothing selected they held
   * a "Pick a teammate" heading, four role presets and four paragraphs
   * explaining what an agent is. The roster of an agent-native product was the
   * narrow strip beside an explanation of the concept. Now the roster owns the
   * pane until you actually pick somebody, and the presets and the explainer
   * live under it where they read as help rather than as the subject.
   */
  const showDetail = !!sel;

  const detail = (() => {
    if (sel?.kind === "agent" && selAgent) {
      return (
        <AgentEditor
          key={`a-${selAgent.agent.id}`}
          row={selAgent}
          seed={undefined}
          wide={wide}
          guard={guard}
          onBack={() => void select(null)}
          onDuplicate={() =>
            openNewAgent({ ...selAgent.agent, name: copyName(selAgent.agent.name, agents) })
          }
          onGone={() => setSel(null)}
          onCreated={(id) => setSel({ kind: "agent", id })}
        />
      );
    }
    if (sel?.kind === "new-agent") {
      return (
        <AgentEditor
          key={`na-${sel.seq}`}
          row={null}
          seed={sel.seed}
          wide={wide}
          guard={guard}
          onBack={() => void select(null)}
          onDuplicate={() => undefined}
          onGone={() => setSel(null)}
          onCreated={(id) => setSel({ kind: "agent", id })}
        />
      );
    }
    if (sel?.kind === "team" && selTeam) {
      return (
        <TeamEditor
          key={`t-${selTeam.team.id}`}
          row={selTeam}
          wide={wide}
          guard={guard}
          onBack={() => void select(null)}
          onGone={() => setSel(null)}
          onCreated={(id) => setSel({ kind: "team", id })}
        />
      );
    }
    if (sel?.kind === "new-team") {
      return (
        <TeamEditor
          key={`nt-${sel.seq}`}
          row={null}
          wide={wide}
          guard={guard}
          onBack={() => void select(null)}
          onGone={() => setSel(null)}
          onCreated={(id) => setSel({ kind: "team", id })}
        />
      );
    }
    return <RosterBlank hasAgents={rows.length > 0} onPreset={(p) => openNewAgent(seedFromPreset(p))} />;
  })();

  return (
    <div className="main-pane ag" ref={rootRef} data-wide={wide ? "1" : undefined}>
      <div className="pane-header">
        <div>
          <div className="pane-title">Agents &amp; Teams</div>
          <div className="pane-sub">
            {agents.length === 0
              ? "A shared roster — whoever creates an agent, everyone can use it."
              : `${agents.length} agent${agents.length === 1 ? "" : "s"}, ${teams.length} team${
                  teams.length === 1 ? "" : "s"
                } · ${readyCount} can run on this machine${
                  runningCount ? ` · ${runningCount} working now` : ""
                }`}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void openLocalImport()}>
            Import local
          </button>
          <button className="btn" onClick={openNewTeam}>
            <IconPlus size={13} /> Team
          </button>
          <button className="btn primary" onClick={() => openNewAgent()}>
            <IconPlus size={13} /> Agent
          </button>
        </div>
      </div>

      <div className="ag-body">
        {showRoster && (
          <div className="ag-roster-col">
            <Toolbar
              query={query}
              onQuery={setQuery}
              harness={harness}
              onHarness={setHarness}
              avail={avail}
              onAvail={setAvail}
              sort={sort}
              onSort={setSort}
              runtimes={runtimes}
            />

            <section className="ag-sec" aria-label="Agents">
              <h3 className="ag-sec-head">
                Agents
                <span className="ag-h3-count">
                  {narrowed ? `${filtered.length} of ${rows.length}` : rows.length || ""}
                </span>
              </h3>

              {rows.length === 0 && (
                <p className="ag-empty ag-sec-empty">
                  No agents yet. An agent is a name, a persona and a runtime — once it exists,
                  everyone in this workspace can @mention it.
                </p>
              )}
              {rows.length > 0 && filtered.length === 0 && (
                <div className="ag-sec-empty ag-no-match">
                  Nothing matches those filters.
                  <button type="button" className="btn tiny" onClick={clearFilters}>
                    Clear filters
                  </button>
                </div>
              )}

              <ul className="ag-rows">
                {filtered.map((row) => (
                  <AgentRosterRow
                    key={row.agent.id}
                    row={row}
                    selected={sel?.kind === "agent" && sel.id === row.agent.id}
                    onOpen={() => void select({ kind: "agent", id: row.agent.id })}
                  />
                ))}
              </ul>
            </section>

            <section className="ag-sec" aria-label="Teams">
              <h3 className="ag-sec-head">
                Teams
                <span className="ag-h3-count">{teams.length || ""}</span>
              </h3>
              {!teams.length && (
                <p className="ag-empty ag-sec-empty">
                  Teams bundle agents — add a whole team to a channel and every member joins, or
                  mention @team-name to fan one request out to all of them.
                </p>
              )}
              {teams.length > 0 && filteredTeams.length === 0 && (
                <p className="ag-empty ag-sec-empty">No team matches those filters.</p>
              )}
              <ul className="ag-rows">
                {filteredTeams.map((row) => (
                  <TeamRosterRow
                    key={row.team.id}
                    row={row}
                    selected={sel?.kind === "team" && sel.id === row.team.id}
                    onOpen={() => void select({ kind: "team", id: row.team.id })}
                  />
                ))}
              </ul>
            </section>

            {/* The presets and the explainer, under the roster instead of
                instead of it. Only when nothing is picked — once you are
                reading a teammate, help about the concept is noise. */}
            {!sel && (
              <div className="ag-help">
                <RosterBlank hasAgents={rows.length > 0} onPreset={(p) => openNewAgent(p)} />
              </div>
            )}
          </div>
        )}

        {showDetail && <div className="ag-detail-col">{detail}</div>}
      </div>
      {importOpen && (
        <Modal title="Import local agents" wide onClose={() => !importBusy && setImportOpen(false)}>
          <div className="ag-import-intro">
            Reads conventional profile folders for Claude Code, Codex, OpenCode, and this workspace.
            Importing copies their instructions into the roster and never edits the source files.
          </div>
          {importBusy && discovered.length === 0 ? (
            <div className="ag-import-empty"><Spinner /> Looking for agent profiles…</div>
          ) : discovered.length === 0 ? (
            <div className="ag-import-empty">
              No Markdown profiles found in ~/.claude/agents, ~/.codex/agents,
              ~/.config/opencode/agents, or this workspace&apos;s agent folders.
            </div>
          ) : (
            <div className="ag-import-list">
              {discovered.map((profile) => (
                <label className="ag-import-row" key={profile.path}>
                  <input
                    type="checkbox"
                    checked={importSelected.has(profile.path)}
                    onChange={(event) => setImportSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(profile.path);
                      else next.delete(profile.path);
                      return next;
                    })}
                  />
                  <span className="ag-import-mark"><HarnessMark kind={profile.kind} size={16} /></span>
                  <span className="ag-import-copy">
                    <strong>{profile.name}</strong>
                    <span>{profile.description || harnessFor(profile.kind).label}</span>
                    <code>{profile.path}</code>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="ag-import-actions">
            <span>{importSelected.size} selected</span>
            <button type="button" className="btn" disabled={importBusy} onClick={() => setImportOpen(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={importBusy || importSelected.size === 0} onClick={() => void importLocalProfiles()}>
              {importBusy ? "Importing…" : "Import selected"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── the pane before anything is picked ──────────────────────── */

function RosterBlank({
  hasAgents,
  onPreset,
}: {
  hasAgents: boolean;
  onPreset: (p: AgentPreset) => void;
}) {
  return (
    <div className="ag-blank-pane">
      <h2 className="ag-blank-title">
        {hasAgents ? "Pick a teammate" : "Nobody works here yet"}
      </h2>
      <p className="ag-blank-text">
        {hasAgents
          ? "Everything an agent is — what it owns, what it is told before every run, what it may do to your machine — is on the right once you choose one."
          : "An agent is a name, a persona and a runtime. Start from a shape and edit everything afterwards; the persona is the single biggest lever on whether it is useful."}
      </p>
      <div className="ag-preset-row">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="ag-preset" onClick={() => onPreset(p)}>
            <span className="ag-preset-label">{p.label}</span>
            <span className="ag-preset-blurb">{p.blurb}</span>
          </button>
        ))}
      </div>
      <AboutAgents />
    </div>
  );
}

/* ── the explainer ────────────────────────────────────────────── */

const ABOUT_KEY = "spaces.agents.about";

/**
 * The four facts people get wrong about a shared roster, in the order they get
 * them wrong. Open by default, and it stays shut once you have read it.
 */
function AboutAgents() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(ABOUT_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const bodyId = useId();

  function toggle() {
    setOpen((was) => {
      try {
        localStorage.setItem(ABOUT_KEY, was ? "0" : "1");
      } catch {
        // a locked-down webview just forgets the preference; not worth a toast
      }
      return !was;
    });
  }

  return (
    <section className={"dash-card ag-about" + (open ? "" : " ag-about-shut")}>
      <button
        type="button"
        className="ag-about-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="ag-about-icon" aria-hidden="true">
          <IconInfo size={15} />
        </span>
        About agents in a shared workspace
        <span className="ag-about-chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="ag-about-body" id={bodyId}>
          {/* dl > div > dt + dd keeps each pair together when the list columns. */}
          <dl>
            <div>
              <dt>They are shared, not personal.</dt>
              <dd>
                Whoever creates an agent, everyone in this workspace can @mention it, add it to a
                channel and assign it work. There is no "my agents" here.
              </dd>
            </div>
            <div>
              <dt>Each one runs on the machine that has its runtime.</dt>
              <dd>
                <code>claude</code>, <code>codex</code>, and Custom CLI agents run from somebody's PATH; {config().localAiName} is an
                engine answering on {RITZ_BASE.replace("http://", "")}. An agent can work while at
                least one host with that runtime is online — which is why a card can say it is
                unavailable <em>from here</em> and still be perfectly usable by a teammate.
              </dd>
            </div>
            <div>
              <dt>You do not need a CLI to use somebody else's agent.</dt>
              <dd>
                Installing a runtime only lets you <em>host</em> agents on this machine. With none
                installed you can still mention, assign and read every agent in the roster.
              </dd>
            </div>
            <div>
              <dt>No API keys, ever.</dt>
              <dd>
                Each runtime signs in with its owner's own subscription the first time it runs. Spaces
                never asks for a key, never stores one, and has nowhere to put one.
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

/* ── directory toolbar ───────────────────────────────────────── */

function Toolbar({
  query, onQuery, harness, onHarness, avail, onAvail, sort, onSort, runtimes,
}: {
  query: string;
  onQuery: (v: string) => void;
  harness: HarnessFilter;
  onHarness: (v: HarnessFilter) => void;
  avail: AvailFilter;
  onAvail: (v: AvailFilter) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  runtimes: Runtimes;
}) {
  return (
    <div className="ag-toolbar">
      <div className="ag-search">
        <span className="ag-search-icon" aria-hidden="true">
          <IconSearch size={14} />
        </span>
        <input
          type="search"
          value={query}
          aria-label="Search agents by name, role, what they own, or persona"
          placeholder="Search name, role, owns, persona…"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              onQuery("");
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="ag-search-clear"
            aria-label="Clear the search"
            onClick={() => onQuery("")}
          >
            <IconX size={12} />
          </button>
        )}
      </div>

      <div className="ag-filters">
        <RadioChips
          label="Filter by runtime"
          value={harness}
          onChange={onHarness}
          options={[
            { value: "all", label: "All runtimes" },
            ...HARNESSES.map((h) => ({ value: h.kind, label: h.label, title: h.blurb })),
          ]}
        />
        <RadioChips
          label="Filter by availability"
          value={avail}
          onChange={onAvail}
          options={[
            { value: "all", label: "Any state" },
            { value: "running", label: "Running", title: "Working on something right now." },
            {
              value: "ready",
              label: "Ready here",
              title: "Its runtime is on this machine, so you can run it yourself.",
            },
            {
              value: "unavailable",
              label: "Not on this machine",
              title: "Runs from a teammate's machine, not this one.",
            },
          ]}
        />
        <RadioChips
          label="Sort the roster"
          value={sort}
          onChange={onSort}
          options={[
            { value: "name", label: "A–Z" },
            { value: "workload", label: "Workload", title: "Most assigned first." },
            { value: "recent", label: "Recently active" },
          ]}
        />
        <button
          type="button"
          className="btn tiny ag-recheck"
          onClick={runtimes.recheck}
          disabled={runtimes.checking}
          title="Ask this machine again which runtimes it has"
        >
          {runtimes.checking && <Spinner />}
          {runtimes.checking ? "Checking…" : "Re-check runtimes"}
        </button>
      </div>
    </div>
  );
}

/* ── roster rows ─────────────────────────────────────────────── */

type RowState = "running" | Availability;

const stateOf = (row: AgentRow): RowState => (row.running.length ? "running" : row.availability);

const STATE_WORD: Record<RowState, string> = {
  running: "Running",
  ready: "Idle",
  unavailable: "Not here",
  unknown: "Checking",
};

/**
 * One line in the roster.
 *
 * The card this replaces carried the whole of an agent on its face, which is
 * lovely for one agent and unreadable for twelve. The row keeps what you scan
 * for — who, what they do, can they run, how loaded they are — and the pane
 * beside it holds everything you would open a card to read.
 */
function AgentRosterRow({
  row,
  selected,
  onOpen,
}: {
  row: AgentRow;
  selected: boolean;
  onOpen: () => void;
}) {
  const { agent, handle, workload } = row;
  const meta = harnessFor(agent.kind);
  const state = stateOf(row);
  const channels = row.direct.length + row.viaTeam.length;
  // Only the risky ones: a permission this agent has been granted over the
  // machine is worth seeing while scanning, and the rest is editor detail.
  const risky = useMemo(
    () => agentChips(agent.kind, agent.model, agent.cli_args).filter((c) => c.risky),
    [agent.kind, agent.model, agent.cli_args]
  );

  return (
    <li>
      <button
        type="button"
        className={"ag-row" + (selected ? " ag-row-on" : "")}
        aria-current={selected || undefined}
        onClick={onOpen}
      >
        <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
        <span className="ag-row-text">
          <span className="ag-row-line">
            <span className="ag-row-name">{agent.name}</span>
            <span className={"ag-row-dot ag-row-dot-" + state} aria-hidden="true" />
            <span className="ag-sr">— {STATE_WORD[state]}</span>
          </span>
          <span className="ag-row-sub">
            <span className="ag-row-role">{agent.role || meta.label}</span>
            <span className="ag-row-handle">@{handle}</span>
          </span>
        </span>
        <span className="ag-row-tail">
          {risky.map((c) => (
            <span key={c.key} className="chip tiny-chip risky" title="A permission worth knowing about">
              {c.label}
            </span>
          ))}
          {workload.length > 0 && (
            <span className="ag-row-stat" title={`${workload.length} assigned`}>
              {workload.length}
              <span className="ag-sr"> assignments</span>
            </span>
          )}
          {channels === 0 && (
            <span className="ag-row-flag" title="In no channel, so nobody can @mention it.">
              no channel
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function TeamRosterRow({
  row,
  selected,
  onOpen,
}: {
  row: TeamRow;
  selected: boolean;
  onOpen: () => void;
}) {
  const { team, members } = row;
  return (
    <li>
      <button
        type="button"
        className={"ag-row" + (selected ? " ag-row-on" : "")}
        aria-current={selected || undefined}
        onClick={onOpen}
      >
        <Avatar name={team.name} id={team.id} />
        <span className="ag-row-text">
          <span className="ag-row-line">
            <span className="ag-row-name">{team.name}</span>
          </span>
          <span className="ag-row-sub">
            <span className="ag-row-role">
              {members.length} member{members.length === 1 ? "" : "s"}
            </span>
            <span className="ag-row-handle">@{row.handle}</span>
          </span>
        </span>
        <span className="ag-row-tail">
          {!team.charter.trim() && (
            <span className="ag-row-flag" title="No charter — members inherit nothing from this team.">
              no charter
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Why an agent can or cannot work from here, in one sentence. */
function AvailabilityNote({ row }: { row: AgentRow }) {
  const channels = useStore((s) => s.channels);
  const { agent, running } = row;
  const meta = harnessFor(agent.kind);
  const state = stateOf(row);
  const runChannel = running[0] && channels.find((c) => c.id === running[0].channel_id);

  const note =
    state === "running"
      ? running.length > 1
        ? `Working on ${running.length} things right now.`
        : `Working${runChannel ? ` in #${runChannel.name}` : ""} — started ${timeAgo(
            running[0].started_at
          )}.`
      : state === "ready"
        ? `Ready — ${meta.wire === "cli" ? "its CLI is" : "its engine is"} on this machine.${
            row.lastActive ? ` Last active ${timeAgo(row.lastActive)}.` : " Never run yet."
          }`
        : state === "unavailable"
          ? unavailableNote(
              agent.kind,
              agent.name,
              agent.kind === "ritz" ? ritzBase(parseArgs("ritz", agent.cli_args)) : agent.model
            )
          : "Still checking what this machine can run.";

  return <p className={"ag-note ag-note-" + state}>{note}</p>;
}

/* ── workload roll-up (agents and teams share it) ────────────── */

/** Enough to see the shape of someone's week without scrolling the card. */
const WORKLOAD_PREVIEW = 6;

function WorkloadBlock({ workload, empty }: { workload: AssignmentView[]; empty: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? workload : workload.slice(0, WORKLOAD_PREVIEW);
  const hidden = workload.length - shown.length;

  const groups: [string, AssignmentView[]][] = [];
  for (const v of shown) {
    const last = groups[groups.length - 1];
    if (last && last[0] === v.roleLabel) last[1].push(v);
    else groups.push([v.roleLabel, [v]]);
  }

  return (
    <div className="ag-block">
      <div className="ag-block-head">
        <span className="ag-block-title">Workload</span>
        <span className="ag-block-count">{workload.length}</span>
      </div>
      {workload.length === 0 ? (
        <p className="ag-empty">{empty}</p>
      ) : (
        <>
          {groups.map(([role, items], i) => (
            <div className="ag-role-row" key={role + i}>
              <span className="ag-role-tag">{role}</span>
              <span className="ag-chips">
                {items.map((v) => (
                  <EntityChip key={v.assignment.id} ref={v.info.ref} size="sm" showType />
                ))}
              </span>
            </div>
          ))}
          {(hidden > 0 || all) && (
            <button type="button" className="ag-more" onClick={() => setAll((v) => !v)}>
              {all ? "Show less" : `+${hidden} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ── channel membership, and joining one from here ───────────── */

function ChannelBlock({ row }: { row: AgentRow }) {
  const removeChannelMember = useStore((s) => s.removeChannelMember);
  const addChannelMember = useStore((s) => s.addChannelMember);
  const subject: EntityRef = { type: "agent", id: row.agent.id };
  const total = row.direct.length + row.viaTeam.length;

  async function leave(channel: Channel) {
    try {
      await removeChannelMember(channel.id, "agent", row.agent.id);
      toast.show({
        kind: "success",
        title: `${row.agent.name} left #${channel.name}`,
        detail: "Mentions there won't reach it any more.",
        action: {
          label: "Undo",
          run: () => void addChannelMember(channel.id, "agent", row.agent.id),
        },
      });
    } catch (e) {
      toast.error(`Could not remove ${row.agent.name} from #${channel.name}`, e);
    }
  }

  return (
    <div className="ag-block">
      <div className="ag-block-head">
        <span className="ag-block-title">Channels</span>
        <span className="ag-block-count">{total}</span>
        <ChannelAdder subject={subject} label={row.agent.name} />
      </div>
      {total === 0 ? (
        <p className="ag-empty">
          In no channel yet, so nobody can @mention it. Add it to one above.
        </p>
      ) : (
        <div className="ag-chips">
          {row.direct.map((c) => (
            <EntityChip
              key={c.id}
              ref={{ type: "channel", id: c.id }}
              size="sm"
              onRemove={() => void leave(c)}
            />
          ))}
          {row.viaTeam.map(({ channel, team }) => (
            <span className="ag-via" key={channel.id}>
              <EntityChip ref={{ type: "channel", id: channel.id }} size="sm" />
              <span className="ag-via-text" title={`Member because the ${team.name} team is in this channel`}>
                via {team.name}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Join a channel without going to it first.
 *
 * A menu rather than a select: the list is grouped by project and filterable,
 * because "which #frontend?" is a real question in a workspace with more than
 * one repo.
 */
function ChannelAdder({ subject, label }: { subject: EntityRef; label: string }) {
  const channels = useStore((s) => s.channels);
  const projects = useStore((s) => s.projects);
  const channelMembers = useStore((s) => s.channelMembers);
  const addChannelMember = useStore((s) => s.addChannelMember);
  const removeChannelMember = useStore((s) => s.removeChannelMember);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menuId = useId();

  const memberType = subject.type === "team" ? "team" : "agent";

  const options = useMemo(() => {
    const joined = new Set(
      channelMembers
        .filter((m) => m.member_type === memberType && m.member_id === subject.id)
        .map((m) => m.channel_id)
    );
    const needle = q.trim().toLowerCase();
    return channels
      .filter((c) => !joined.has(c.id))
      .map((c) => ({ channel: c, project: projects.find((p) => p.id === c.project_id)?.name ?? "" }))
      .filter(
        (o) =>
          !needle ||
          `#${o.channel.name} ${o.channel.topic} ${o.project}`.toLowerCase().includes(needle)
      );
  }, [channels, channelMembers, projects, subject.id, memberType, q]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only this menu closes — not the card, not an enclosing modal.
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function step(from: HTMLElement, delta: number) {
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>(".ag-pop-item") ?? [])];
    if (!items.length) return;
    const i = items.indexOf(from as HTMLButtonElement);
    items[(i + delta + items.length) % items.length]?.focus();
  }

  async function join(channel: Channel) {
    setOpen(false);
    setQ("");
    trigger.current?.focus();
    try {
      await addChannelMember(channel.id, memberType, subject.id);
      toast.show({
        kind: "success",
        title: `${label} joined #${channel.name}`,
        detail: "It answers @mentions there now.",
        action: {
          label: "Undo",
          run: () => void removeChannelMember(channel.id, memberType, subject.id),
        },
      });
    } catch (e) {
      toast.error(`Could not add ${label} to #${channel.name}`, e);
    }
  }

  return (
    <div className="ag-pop-wrap" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className="ag-add"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Add ${label} to a channel`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPlus size={11} /> Channel
      </button>
      {open && (
        // A dialog rather than a menu: it holds a filter field, and a textbox
        // inside role="menu" is a lie assistive tech has to work around.
        <div className="ag-pop" id={menuId} role="dialog" aria-label={`Channels ${label} can join`}>
          <input
            ref={input}
            className="ag-pop-search"
            value={q}
            placeholder="Filter channels…"
            aria-label="Filter channels"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                wrap.current?.querySelector<HTMLButtonElement>(".ag-pop-item")?.focus();
              }
            }}
          />
          <div className="ag-pop-list">
            {options.map(({ channel, project }) => (
              <button
                key={channel.id}
                type="button"
                className="ag-pop-item"
                onClick={() => void join(channel)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    step(e.currentTarget, 1);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    step(e.currentTarget, -1);
                  }
                }}
              >
                <span className="ag-pop-name">#{channel.name}</span>
                {project && <span className="ag-pop-sub">{project}</span>}
              </button>
            ))}
            {options.length === 0 && (
              <p className="ag-pop-empty">
                {channels.length
                  ? "In every channel already, or none match that filter."
                  : "No channels yet — create one from the sidebar first."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── team editor ─────────────────────────────────────────────── */

interface TeamDraft {
  name: string;
  description: string;
  charter: string;
}

const sameTeamDraft = (a: TeamDraft, b: TeamDraft): boolean =>
  a.name === b.name && a.description === b.description && a.charter === b.charter;

/**
 * A team is a charter with a membership list attached.
 *
 * The charter is the reason the screen exists — it is prepended to every
 * member's run — so it is treated exactly like a persona: autosaved, sized for
 * writing, and honest about the one rule people trip over, which is that a
 * charter only reaches a member in channels *the team itself* joined.
 */
function TeamEditor({
  row,
  wide,
  guard,
  onBack,
  onGone,
  onCreated,
}: {
  row: TeamRow | null;
  wide: boolean;
  guard: { current: LeaveGuard | null };
  onBack: () => void;
  onGone: () => void;
  onCreated: (id: string) => void;
}) {
  const store = useStore();
  const team = row?.team ?? null;
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [charter, setCharter] = useState(team?.charter ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(
    team ? store.teamMembers.filter((tm) => tm.team_id === team.id).map((tm) => tm.agent_id) : []
  );
  const nameRef = useRef<HTMLInputElement>(null);

  const teamId = team?.id ?? null;
  const draft = useMemo<TeamDraft>(
    () => ({ name, description, charter }),
    [name, description, charter]
  );

  const write = useCallback(
    async (d: TeamDraft) => {
      if (!teamId || !d.name.trim()) return;
      await useStore.getState().updateTeam(teamId, {
        name: d.name.trim(),
        description: d.description,
        charter: d.charter,
      });
    },
    [teamId]
  );

  const autosave = useAutosave(draft, write, { equal: sameTeamDraft });
  const { flush } = autosave;
  const { close, closing } = useCloseGuard(autosave);
  useSaveShortcut(flush, !!teamId);

  const drafted = !teamId && (name.trim() !== "" || description.trim() !== "" || charter.trim() !== "");
  const canLeave = useCallback(async () => {
    // Nothing writes while the name is empty, so leaving would drop whatever
    // was typed after it was cleared.
    if (teamId && !name.trim()) {
      nameRef.current?.focus();
      toast.warn("Give it a name", "Nothing has saved since the name was cleared.");
      return false;
    }
    // A failed save keeps the pane open with the reason on screen.
    if (teamId) return close();
    if (!drafted) return true;
    return confirmAction({
      title: "Discard this draft?",
      body: "The team has never been created, so nothing will remember it — including the charter.",
      confirmLabel: "Discard",
      danger: true,
    });
  }, [teamId, name, drafted, close]);

  useEffect(() => {
    guard.current = canLeave;
    return () => {
      if (guard.current === canLeave) guard.current = null;
    };
  }, [guard, canLeave]);

  const running = store.activeRunIds
    .map((id) => store.runs[id])
    .filter((r) => !!r && memberIds.includes(r.agent_id)).length;

  /** Membership is written the moment it is toggled — it is one row, not prose. */
  async function toggleMember(id: string, on: boolean) {
    const next = on ? [...memberIds, id] : memberIds.filter((x) => x !== id);
    const was = memberIds;
    setMemberIds(next);
    if (!teamId) return;
    try {
      await store.setTeamMembers(teamId, next);
    } catch (e) {
      setMemberIds(was);
      toast.error(`Could not change who is in ${name.trim() || "this team"}`, e);
    }
  }

  async function create() {
    const t = name.trim();
    if (!t) return;
    try {
      const fresh = await store.addTeam(t, description);
      // addTeam only takes a name and a description; the charter is a patch.
      if (charter.trim()) await store.updateTeam(fresh.id, { charter });
      if (memberIds.length) await store.setTeamMembers(fresh.id, memberIds);
      onCreated(fresh.id);
      toast.success(`${t} created`, `Mention @${slug(t)} to reach every member at once.`);
    } catch (e) {
      toast.error(`Could not create ${t}`, e);
    }
  }

  async function remove() {
    if (!team) return;
    const ref: EntityRef = { type: "team", id: team.id };
    const snap = snapshotOf(ref);
    const cost = costOf(snap);
    const ok = await confirmAction({
      title: `Delete the ${team.name} team?`,
      body: [
        cost.length ? `It leaves ${cost.join(", ")}.` : "It isn't attached to anything yet.",
        memberIds.length
          ? `Its ${memberIds.length} member${memberIds.length === 1 ? "" : "s"} stay — only the grouping and this charter go.`
          : "",
        "Undo puts the team and its membership back.",
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    const gone: Team = { ...team };
    const members = [...memberIds];
    try {
      await store.deleteTeam(gone.id);
      await store.purgeGraph([ref]);
      onGone();
      toast.show({
        kind: "success",
        title: `${gone.name} deleted`,
        detail: cost.length ? `Left ${cost.join(", ")}.` : undefined,
        action: { label: "Undo", run: () => void restoreTeam(gone, members, snap) },
      });
    } catch (e) {
      toast.error(`Could not delete ${gone.name}`, e);
    }
  }

  async function leave(channel: Channel) {
    if (!team) return;
    try {
      await store.removeChannelMember(channel.id, "team", team.id);
      toast.show({
        kind: "success",
        title: `${team.name} left #${channel.name}`,
        detail: "Its members stay in any channel they joined by name.",
        action: {
          label: "Undo",
          run: () => void store.addChannelMember(channel.id, "team", team.id),
        },
      });
    } catch (e) {
      toast.error(`Could not remove ${team.name} from #${channel.name}`, e);
    }
  }

  const reach = row?.channels.length ?? 0;

  return (
    <div
      className="ag-ed"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }}
    >
      <div className="ag-ed-bar">
        {!wide && (
          <button type="button" className="btn tiny" onClick={onBack}>
            ← Roster
          </button>
        )}
        <span className="ag-ed-what">{team ? "Editing team" : "New team"}</span>
        {!team ? (
          <span className="ag-blocked" role="status">
            Draft — no team yet
          </span>
        ) : name.trim() ? (
          <SaveState autosave={autosave} />
        ) : (
          <span className="ag-blocked" role="status">
            Name needed — edits are not saving
          </span>
        )}
        <span className="ag-ed-spacer" />
        {team && (
          <span className="ag-ed-keys" aria-hidden="true">
            <kbd>⌘S</kbd> save now
          </span>
        )}
      </div>

      <section className="ag-ed-sec">
        <div className="ag-ed-ident">
          <Avatar name={name || "?"} id={team?.id ?? "new-team"} />
          <div className="ag-ed-idfields">
            <Field label="Name">
              <input
                ref={nameRef}
                autoFocus={!team}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Core Dev"
              />
            </Field>
            <Field label="Description">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ships the app"
              />
            </Field>
          </div>
        </div>
        {name.trim() && (
          <p className="ag-ed-mention">
            Mention as <span className="mention">@{slug(name)}</span> to reach every member
          </p>
        )}
      </section>

      <section className="ag-ed-sec ag-ed-persona">
        <h3 className="ag-h3">Charter</h3>
        <p className="ag-ed-help">
          Standing context every member is given, before its own persona. Write what the team
          holds in common — what it ships, what it refuses, where the line is.
        </p>
        <textarea
          className="ag-persona-text"
          value={charter}
          aria-label="Team charter"
          placeholder="We keep the app shippable at all times. Small diffs, no dependency added without a note in #core."
          onChange={(e) => setCharter(e.target.value)}
        />
        {team && <NextRunNote name={name.trim()} running={running} />}
        <p className={"ag-reach" + (row && reach === 0 ? " ag-reach-none" : "")}>
          {!row
            ? "A charter is sent only in channels the team itself is a member of — add it to one once the team exists, or nobody ever reads this."
            : reach === 0
              ? "This charter reaches nobody yet: it is sent only in channels the team itself is a member of, and this team is in none. Add it to one below."
              : `Sent to every member in the ${reach} channel${reach === 1 ? "" : "s"} this team is a member of. In a channel someone joined by name, the team charter is not sent — only the channel's own charter and their persona.`}
        </p>
        {charter.trim() && (
          <pre className="ag-ctx-body ag-reach-block">{`## Charter — ${name.trim() || "this"} team\n${charter.trim()}`}</pre>
        )}
      </section>

      <section className="ag-ed-sec">
        <div className="ag-block-head">
          <span className="ag-block-title">Members</span>
          <span className="ag-block-count">{memberIds.length}</span>
        </div>
        {!store.agents.length && (
          <p className="ag-empty">No agents exist yet — create one and it can join this team.</p>
        )}
        {row && memberIds.length > 0 && (
          <div className="ag-team-members">
            <EntityAvatarStack refs={memberIds.map((id) => ({ type: "agent", id }))} max={6} />
            <span className="ag-team-ready">
              {row.ready === row.members.length
                ? row.members.length === 1
                  ? "Its member can run on this machine."
                  : "All can run on this machine."
                : `${row.ready} of ${row.members.length} can run on this machine.`}
            </span>
          </div>
        )}
        <div className="ag-members">
          {store.agents.map((a) => (
            <label key={a.id} className="member-row">
              <input
                type="checkbox"
                checked={memberIds.includes(a.id)}
                onChange={(e) => void toggleMember(a.id, e.target.checked)}
              />
              <Avatar name={a.name} id={a.id} kind={a.kind} />
              <span>{a.name}</span>
              <span className="chip tiny-chip">{harnessFor(a.kind).label}</span>
              {memberIds.includes(a.id) && (
                <span className="ag-member-on" aria-hidden="true">
                  <IconCheck size={12} />
                </span>
              )}
            </label>
          ))}
        </div>
        {!team && store.agents.length > 0 && (
          <p className="opt-hint">Membership is saved with the team when you create it.</p>
        )}
      </section>

      {row && (
        <section className="ag-ed-sec">
          <div className="ag-block">
            <div className="ag-block-head">
              <span className="ag-block-title">Channels</span>
              <span className="ag-block-count">{row.channels.length}</span>
              <ChannelAdder subject={{ type: "team", id: row.team.id }} label={row.team.name} />
            </div>
            {row.channels.length === 0 ? (
              <p className="ag-empty">
                In no channel. Adding the team adds every member at once — and it is the only way
                this charter is ever sent.
              </p>
            ) : (
              <div className="ag-chips">
                {row.channels.map((c) => (
                  <EntityChip
                    key={c.id}
                    ref={{ type: "channel", id: c.id }}
                    size="sm"
                    onRemove={() => void leave(c)}
                  />
                ))}
              </div>
            )}
          </div>

          <WorkloadBlock
            workload={row.workload}
            empty="Nothing assigned to the team itself. Assigning the team, rather than a person, is how work survives someone being busy."
          />
          {row.memberLoad > 0 && (
            <p className="ag-note ag-note-quiet">
              Members carry {row.memberLoad} assignment{row.memberLoad === 1 ? "" : "s"} of their
              own.
            </p>
          )}
        </section>
      )}

      <div className="ag-ed-foot">
        {team ? (
          <>
            <button className="btn danger" onClick={() => void remove()}>
              Delete
            </button>
            <span className="ag-ed-spacer" />
            {/* Leaving is the only exit, and the parent runs the same guard on
                it that a click on another row does — so Done is literally
                "leave", and it flushes on the way out. */}
            <button className="btn primary" disabled={closing} onClick={onBack}>
              {closing ? "Saving…" : "Done"}
            </button>
          </>
        ) : (
          <>
            <p className="ag-ed-foot-note">
              Nothing is shared until you create it. After that, every change here saves itself.
            </p>
            <span className="ag-ed-spacer" />
            <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
              <IconCheck size={12} /> Create team
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── deleting, reversibly ────────────────────────────────────── */

/**
 * Everything a delete detaches, captured before it happens.
 *
 * `deleteAgent` drops team and channel memberships silently, and the graph
 * rows survive pointing at a name that no longer exists. Snapshotting first is
 * what lets Undo mean undo rather than "make a blank one with the same name".
 */
interface RosterSnapshot {
  channelIds: string[];
  /** Teams an agent belonged to; always empty for a team. */
  teamIds: string[];
  assignments: { target: EntityRef; role: AssignRole }[];
  links: { other: EntityRef; kind: LinkKind; note: string; outbound: boolean }[];
}

function snapshotOf(ref: EntityRef): RosterSnapshot {
  const s = useStore.getState();
  const memberType = ref.type === "team" ? "team" : "agent";
  return {
    channelIds: s.channelMembers
      .filter((m) => m.member_type === memberType && m.member_id === ref.id)
      .map((m) => m.channel_id),
    teamIds:
      ref.type === "agent"
        ? s.teamMembers.filter((tm) => tm.agent_id === ref.id).map((tm) => tm.team_id)
        : [],
    assignments: s.assignments
      .filter((a) => a.subject_type === memberType && a.subject_id === ref.id)
      .map((a) => ({ target: { type: a.target_type, id: a.target_id }, role: a.role })),
    links: s.linksFor(ref).map((l) =>
      l.from_type === ref.type && l.from_id === ref.id
        ? { other: { type: l.to_type, id: l.to_id }, kind: l.kind, note: l.note, outbound: true }
        : { other: { type: l.from_type, id: l.from_id }, kind: l.kind, note: l.note, outbound: false }
    ),
  };
}

/** Plain-English list of what a delete costs, for the confirm dialog. */
function costOf(snap: RosterSnapshot): string[] {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (snap.channelIds.length) parts.push(n(snap.channelIds.length, "channel"));
  if (snap.teamIds.length) parts.push(n(snap.teamIds.length, "team"));
  if (snap.assignments.length) parts.push(n(snap.assignments.length, "assignment"));
  if (snap.links.length) parts.push(n(snap.links.length, "link"));
  return parts;
}

/**
 * Re-attach a restored agent or team. The restored row is a new id, so this
 * redraws the graph rather than resurrecting it — which is also why the delete
 * path purges the old rows instead of leaving them to point at nothing.
 */
async function reattach(ref: EntityRef, snap: RosterSnapshot): Promise<void> {
  const s = () => useStore.getState();
  for (const teamId of snap.teamIds) {
    if (!s().teams.some((t) => t.id === teamId)) continue;
    const ids = s().teamMembers.filter((tm) => tm.team_id === teamId).map((tm) => tm.agent_id);
    await s().setTeamMembers(teamId, [...new Set([...ids, ref.id])]);
  }
  for (const channelId of snap.channelIds) {
    if (!s().channels.some((c) => c.id === channelId)) continue;
    await s().addChannelMember(channelId, ref.type === "team" ? "team" : "agent", ref.id);
  }
  for (const a of snap.assignments) await s().assign(ref, a.target, a.role);
  for (const l of snap.links) {
    if (l.outbound) await s().addLink(ref, l.other, l.kind, l.note);
    else await s().addLink(l.other, ref, l.kind, l.note);
  }
}

/* ── agent editor ────────────────────────────────────────────── */

function seedFromPreset(p: AgentPreset): Partial<Agent> {
  return { name: p.name, role: p.role, owns: p.owns, persona: p.persona };
}

/** "Scout" → "Scout copy", or "Scout copy 2" when that is taken too. */
function copyName(name: string, agents: Agent[]): string {
  const taken = new Set(agents.map((a) => a.name.toLowerCase()));
  const base = `${name} copy`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }
  return base;
}

/** The runtime to offer first: one this machine can actually host. */
function preferredKind(tools: Record<string, boolean>): HarnessKind {
  if (tools.claude) return "claude";
  if (tools.codex) return "codex";
  return "claude";
}

/** Everything the agents row holds as text, as one value autosave can persist. */
interface AgentDraft {
  name: string;
  role: string;
  owns: string;
  persona: string;
  kind: HarnessKind;
  model: string;
  cli_args: string;
}

const sameAgentDraft = (a: AgentDraft, b: AgentDraft): boolean =>
  a.name === b.name &&
  a.role === b.role &&
  a.owns === b.owns &&
  a.persona === b.persona &&
  a.kind === b.kind &&
  a.model === b.model &&
  a.cli_args === b.cli_args;

/**
 * The sentence that stops the worst misreading of an autosaving persona: that
 * editing it steers the run happening in front of you. It does not — a harness
 * gets its instructions once, at launch.
 */
function NextRunNote({ name, running }: { name: string; running: number }) {
  if (running > 0) {
    return (
      <p className="ag-next ag-next-live">
        {name || "This agent"} is working right now. That run keeps the instructions it started
        with — everything here reaches it on its <strong>next</strong> run.
      </p>
    );
  }
  return (
    <p className="ag-next">
      Saved as you type, and read at the start of the <strong>next</strong> run. A run already in
      flight keeps the instructions it launched with.
    </p>
  );
}

function AgentEditor({
  row,
  seed,
  wide,
  guard,
  onBack,
  onDuplicate,
  onGone,
  onCreated,
}: {
  /** null while this is still a draft that has never been written. */
  row: AgentRow | null;
  seed?: Partial<Agent>;
  wide: boolean;
  guard: { current: LeaveGuard | null };
  onBack: () => void;
  onDuplicate: () => void;
  onGone: () => void;
  onCreated: (id: string) => void;
}) {
  const store = useStore();
  const agent = row?.agent ?? null;
  const base = agent ?? seed ?? null;
  const [name, setName] = useState(base?.name ?? "");
  const [role, setRole] = useState(base?.role ?? "");
  const [owns, setOwns] = useState(base?.owns ?? "");
  const [persona, setPersona] = useState(base?.persona ?? "");
  const [kind, setKind] = useState<HarnessKind>(
    (base?.kind as HarnessKind) ?? preferredKind(store.tools)
  );
  const [values, setValues] = useState<OptionValues>(() => {
    const start = (base?.kind as HarnessKind) ?? preferredKind(store.tools);
    // A preset seed carries a persona, never flags — it starts from Spaces's
    // opinionated defaults, exactly like a blank new agent does.
    if (!base?.cli_args && !base?.model) return defaultsFor(start);
    const parsed = parseArgs(start, base.cli_args ?? "");
    // The model column wins; a hand-written --model in cli_args is the fallback.
    return { ...parsed, model: (base.model ?? "").trim() || parsed.model || "" };
  });
  // While the raw box has focus its literal text is shown, so typing isn't
  // fought by re-serialization; on blur it snaps back to the canonical form.
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const meta = harnessFor(kind);
  const groups = useMemo(() => groupedOptions(kind), [kind]);
  const preview = commandPreview(kind, values);
  const risks = riskNotes(kind, values);
  const serialized = serializeArgs(kind, values);
  const customProgram = String(values.model ?? "");
  const currentRitzBase = ritzBase(values);
  const runtimes = useRuntimes(
    kind === "ritz" ? [{
      base: currentRitzBase,
      healthRoute: ritzHealthRoute(values),
      authentication: String(values.authentication || "trusted-local-origin"),
    }] : [],
    kind === "custom" ? [customProgram] : []
  );
  const availability = runtimes.of(kind, kind === "ritz" ? currentRitzBase : customProgram);

  const handle = slug(name);
  // Mentions resolve by handle, so two agents sharing one is a real ambiguity.
  const clash =
    handle &&
    [
      ...store.agents.filter((a) => a.id !== agent?.id).map((a) => ({ name: a.name, what: "agent" })),
      ...store.teams.map((t) => ({ name: t.name, what: "team" })),
    ].find((x) => slug(x.name) === handle);

  const running = store.activeRunIds
    .map((id) => store.runs[id])
    .filter((r) => !!r && agent && r.agent_id === agent.id);

  function update(key: string, v: OptionValue) {
    setValues((prev) => ({ ...prev, [key]: v }));
    setRawDraft(null);
  }

  function changeKind(next: HarnessKind) {
    setValues((prev) => carryOver(kind, next, prev));
    setKind(next);
    setRawDraft(null);
  }

  function applyPreset(p: AgentPreset) {
    // Never clobber words someone has already written; fill the empty boxes.
    if (!name.trim()) setName(p.name);
    if (!role.trim()) setRole(p.role);
    if (!owns.trim()) setOwns(p.owns);
    setPersona((prev) => (prev.trim() ? prev : p.persona));
  }

  const draft = useMemo<AgentDraft>(
    () => ({
      name,
      role,
      owns,
      persona,
      kind,
      model: String(values.model ?? "").trim(),
      cli_args: serialized,
    }),
    [name, role, owns, persona, kind, values.model, serialized]
  );

  const agentId = agent?.id ?? null;
  const write = useCallback(
    async (d: AgentDraft) => {
      // A draft agent is not saved on a timer: it goes into a roster everyone
      // can @mention, and half a name is not a colleague. Creation stays an
      // act; everything after it is continuous.
      if (!agentId || !d.name.trim()) return;
      await useStore.getState().updateAgent(agentId, {
        name: d.name.trim(),
        // The cast is a no-op now that Agent["kind"] includes "ritz"; it stays
        // so this view keeps compiling whichever way that union moves.
        kind: d.kind as Agent["kind"],
        model: d.model,
        role: d.role.trim(),
        owns: d.owns.trim(),
        persona: d.persona,
        cli_args: d.cli_args,
      });
    },
    [agentId]
  );

  const autosave = useAutosave(draft, write, { equal: sameAgentDraft });
  const { flush } = autosave;
  const { close, closing } = useCloseGuard(autosave);
  useSaveShortcut(flush, !!agentId);

  /** True once a draft holds words worth a confirmation before dropping it. */
  const drafted =
    !agentId &&
    (name.trim() !== (seed?.name ?? "").trim() ||
      role.trim() !== (seed?.role ?? "").trim() ||
      owns.trim() !== (seed?.owns ?? "").trim() ||
      persona.trim() !== (seed?.persona ?? "").trim());

  const canLeave = useCallback(async () => {
    // A saved agent whose name has been emptied is the one case where leaving
    // would drop real work: nothing has written since the name went, so the
    // pane stays put until there is something to save under.
    if (agentId && !name.trim()) {
      nameRef.current?.focus();
      toast.warn("Give it a name", "Nothing has saved since the name was cleared.");
      return false;
    }
    // close() waits for the write *and* for the render that reports it, so a
    // save that failed keeps the pane open with the reason on screen rather
    // than swapping in another agent over the top of it.
    if (agentId) return close();
    if (!drafted) return true;
    return confirmAction({
      title: "Discard this draft?",
      body: "It has never been created, so nothing in the workspace will remember it — including the persona.",
      confirmLabel: "Discard",
      danger: true,
    });
  }, [agentId, name, drafted, close]);

  useEffect(() => {
    guard.current = canLeave;
    return () => {
      if (guard.current === canLeave) guard.current = null;
    };
  }, [guard, canLeave]);

  async function create() {
    const t = name.trim();
    if (!t) return;
    try {
      const fresh = await store.addAgent({
        name: t,
        kind: kind as Agent["kind"],
        model: String(values.model ?? "").trim(),
        role: role.trim(),
        owns: owns.trim(),
        persona,
        cli_args: serialized,
      });
      // Leaving is safe from here on: the guard sees an id and just flushes.
      onCreated(fresh.id);
      toast.success(
        `${t} joined the workspace`,
        `Everyone here can mention @${slug(t)} now — and every edit from here saves itself.`
      );
    } catch (e) {
      toast.error(`Could not create ${t}`, e);
    }
  }

  async function remove() {
    if (!agent) return;
    const ref: EntityRef = { type: "agent", id: agent.id };
    const snap = snapshotOf(ref);
    const cost = costOf(snap);
    const ok = await confirmAction({
      title: `Delete ${agent.name}?`,
      body: [
        cost.length
          ? `@${slug(agent.name)} leaves ${cost.join(", ")}.`
          : `@${slug(agent.name)} isn't attached to anything yet.`,
        running.length ? "It is working right now; deleting cancels that run." : "",
        "Undo puts all of it back, but a restored agent is a new record — its saved conversation in each channel starts over.",
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    const row: Agent = { ...agent };
    try {
      await store.deleteAgent(row.id);
      // Links and assignments outlive their target everywhere else in Spaces; for
      // a deleted teammate they would only be dead ends, and the snapshot
      // above is what Undo reads from.
      await store.purgeGraph([ref]);
      onGone();
      toast.show({
        kind: "success",
        title: `${row.name} deleted`,
        detail: cost.length ? `Left ${cost.join(", ")}.` : undefined,
        action: { label: "Undo", run: () => void restoreAgent(row, snap) },
      });
    } catch (e) {
      toast.error(`Could not delete ${row.name}`, e);
    }
  }

  return (
    <div
      className="ag-ed"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Contained here so the keystroke doesn't also close the inspector
        // drawer or the command palette, both of which listen for it.
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }}
    >
      <div className="ag-ed-bar">
        {!wide && (
          <button type="button" className="btn tiny" onClick={onBack}>
            ← Roster
          </button>
        )}
        <span className="ag-ed-what">
          {agent ? "Editing" : seed ? "Duplicate" : "New agent"}
        </span>
        {/* Autosave has no word for "there is nothing to save this into yet",
            and letting it say "Saved" over a draft would be the one lie that
            undoes the whole indicator. */}
        {!agent ? (
          <span className="ag-blocked" role="status">
            Draft — not in the roster yet
          </span>
        ) : name.trim() ? (
          <SaveState autosave={autosave} />
        ) : (
          <span className="ag-blocked" role="status">
            Name needed — edits are not saving
          </span>
        )}
        <span className="ag-ed-spacer" />
        {agent && (
          <span className="ag-ed-keys" aria-hidden="true">
            <kbd>⌘S</kbd> save now
          </span>
        )}
      </div>

      {!agent && (
        <section className="ag-ed-sec">
          <div className="field-label">Start from</div>
          <div className="ag-preset-row">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ag-preset"
                onClick={() => applyPreset(p)}
                title={p.blurb}
              >
                <span className="ag-preset-label">{p.label}</span>
                <span className="ag-preset-blurb">{p.blurb}</span>
              </button>
            ))}
          </div>
          <p className="opt-hint">
            Presets only fill the boxes you have left empty — edit everything afterwards. A
            persona is the single biggest lever on whether an agent is useful.
          </p>
        </section>
      )}

      <section className="ag-ed-sec">
        <div className="ag-ed-ident">
          <Avatar name={name || "?"} id={agent?.id ?? "new"} kind={kind} />
          <div className="ag-ed-idfields">
            <Field label="Name">
              <input
                ref={nameRef}
                autoFocus={!agent}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Scout"
              />
            </Field>
            <Field label="Role">
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Frontend" />
            </Field>
          </div>
        </div>
        {name.trim() && (
          <p className="ag-ed-mention">
            Mention as <span className="mention">@{handle}</span>
          </p>
        )}
        {clash && (
          <p className="ag-clash">
            <IconInfo size={13} /> <strong>{clash.name}</strong> already answers to @{handle} — that{" "}
            {clash.what} and this one will be indistinguishable in a mention. Pick a different name.
          </p>
        )}
        <Field label="Owns">
          <input
            value={owns}
            onChange={(e) => setOwns(e.target.value)}
            placeholder="src/components, styling"
          />
        </Field>
        <p className="opt-hint">
          Name, role and what it owns are all quoted to its teammates in the roster of every
          channel it is in — this is how a mention lands on the right agent.
        </p>
      </section>

      <section className="ag-ed-sec ag-ed-persona">
        <h3 className="ag-h3">Persona</h3>
        <p className="ag-ed-help">
          The standing instructions this agent is given before it reads a word of the conversation.
          Written to it, in the second person: what it does, what it refuses, how it works.
        </p>
        <textarea
          className="ag-persona-text"
          value={persona}
          aria-label="Persona — standing instructions for this agent"
          placeholder="You are the frontend specialist. You care about accessibility, you match the surrounding code before inventing a pattern, and you never add a dependency without asking."
          onChange={(e) => setPersona(e.target.value)}
        />
        {/* A draft saves nothing yet, so the promise would be a lie; the footer
            says what is true of a draft instead. */}
        {agent && <NextRunNote name={name.trim()} running={running.length} />}
        <ContextPreview
          agentId={agent?.id ?? null}
          name={name}
          role={role}
          owns={owns}
          persona={persona}
        />
      </section>

      <section className="ag-ed-sec">
        <h3 className="ag-h3">Runtime</h3>
        <Field label="Backend">
          <select value={kind} onChange={(e) => changeKind(e.target.value as HarnessKind)}>
            {HARNESSES.map((h) => (
              <option key={h.kind} value={h.kind}>
                {h.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="harness-blurb">{meta.blurb}</div>
        <p className={"ag-avail ag-avail-" + availability}>
          {availability === "ready"
            ? `${meta.label} is available on this machine, so you can run this agent yourself.`
            : availability === "unavailable"
              ? `${meta.label} isn't on this machine — the agent is still perfectly real, and anyone whose machine has it can run it. No API key is involved either way.`
              : "Checking whether this machine has that runtime…"}
        </p>
        {kind === "ritz" && (
          <button
            type="button"
            className="btn tiny ag-recheck"
            onClick={runtimes.recheck}
            disabled={runtimes.checking}
          >
            {runtimes.checking ? "Testing…" : "Test connection"}
          </button>
        )}
      </section>

      {groups.map((g) => (
        <div className="opt-group" key={g.name}>
          {/* a lone option that already says the group's name doesn't need the heading */}
          {!(g.options.length === 1 && g.options[0].label === g.name) && (
            <div className="opt-group-title">{g.name}</div>
          )}
          {g.options.map((opt) => (
            <OptionControl
              key={opt.key}
              opt={opt}
              kind={kind}
              value={values[opt.key]}
              ritzEndpoint={currentRitzBase}
              ritzAuthentication={String(values.authentication || "trusted-local-origin")}
              onChange={(v) => update(opt.key, v)}
            />
          ))}
        </div>
      ))}

      <div className="opt-group">
        {risks.map((r) => (
          <div className="risk-note" key={r.key}>
            <span className="icon">
              <IconInfo size={15} />
            </span>
            <div>
              <code>{r.value}</code> — {r.message}
            </div>
          </div>
        ))}
        <div className="cmd-preview">
          <div className="cmd-preview-head">
            <span className="icon">
              <IconBolt size={12} />
            </span>
            {meta.wire === "cli" ? "What Spaces will run" : "What Spaces will send"}
          </div>
          <pre className="cmd-preview-body">{preview}</pre>
        </div>

        <button
          className="disclosure"
          type="button"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((s) => !s)}
        >
          <span className="icon">
            <IconGear size={13} />
          </span>
          {showRaw ? `Hide ${meta.rawLabel.toLowerCase()}` : `Advanced — ${meta.rawLabel.toLowerCase()}`}
        </button>
        {showRaw && (
          <div className="disclosure-body">
            <input
              value={rawDraft ?? serialized}
              spellCheck={false}
              placeholder={meta.rawPlaceholder}
              aria-label={meta.rawLabel}
              onChange={(e) => {
                setRawDraft(e.target.value);
                const parsed = parseArgs(kind, e.target.value);
                // The model has its own column, so it is never part of the raw
                // string — but if someone types --model there, honour it.
                setValues((prev) => ({
                  ...parsed,
                  model: String(parsed.model ?? "") || prev.model || "",
                }));
              }}
              onBlur={() => setRawDraft(null)}
            />
            <div className="opt-hint">{meta.rawHelp}</div>
          </div>
        )}
      </div>

      {row && (
        <section className="ag-ed-sec">
          <h3 className="ag-h3">Where it works</h3>
          <AvailabilityNote row={row} />
          <ChannelBlock row={row} />
          <div className="ag-block">
            <div className="ag-block-head">
              <span className="ag-block-title">Teams</span>
              <span className="ag-block-count">{row.teams.length}</span>
            </div>
            {row.teams.length ? (
              <div className="ag-chips">
                {row.teams.map((t) => (
                  <EntityChip key={t.id} ref={{ type: "team", id: t.id }} size="sm" />
                ))}
              </div>
            ) : (
              <p className="ag-empty">
                In no team. A team's charter only reaches its members, so joining one is how an
                agent inherits standing context it did not write.
              </p>
            )}
          </div>
          <WorkloadBlock
            workload={row.workload}
            empty="Nothing assigned yet. Put it on a task, channel or PR from that thing's connections panel."
          />
        </section>
      )}

      <div className="ag-ed-foot">
        {agent ? (
          <>
            <button className="btn danger" onClick={() => void remove()}>
              Delete
            </button>
            <span className="ag-ed-spacer" />
            <button
              className="btn"
              onClick={onDuplicate}
              title={`Start a new agent from ${agent.name}'s persona and settings`}
            >
              <IconPlus size={11} /> Duplicate
            </button>
            {/* Leaving is the only exit, and the parent runs the same guard on
                it that a click on another row does — so Done is literally
                "leave", and it flushes on the way out. */}
            <button className="btn primary" disabled={closing} onClick={onBack}>
              {closing ? "Saving…" : "Done"}
            </button>
          </>
        ) : (
          <>
            <p className="ag-ed-foot-note">
              Nothing is shared until you create it. After that, every change here saves itself.
            </p>
            <span className="ag-ed-spacer" />
            <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
              <IconCheck size={12} /> Create agent
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── what the agent will actually be told ────────────────────── */

interface Layer {
  key: string;
  /** Where this text comes from, in the app's own words. */
  label: string;
  /** The literal block agents.ts pushes into the prompt. */
  text: string;
  /** Missing rather than written: shown greyed, so the gap is legible. */
  absent?: boolean;
  /** True for the persona layer, which is the one being edited. */
  mine?: boolean;
}

/**
 * The assembled standing context, in the order buildFreshPrompt() writes it:
 * project instructions → team charters → channel charter → this agent.
 *
 * It is per-channel and it has to be, because two of those four layers depend
 * on the channel — and a team charter reaches a member *only* in channels the
 * team itself joined, which is the single most surprising rule in the app.
 * Mirrored from agents.ts rather than imported: that module runs agents, and a
 * preview must never be able to start one.
 */
function ContextPreview({
  agentId,
  name,
  role,
  owns,
  persona,
}: {
  agentId: string | null;
  name: string;
  role: string;
  owns: string;
  persona: string;
}) {
  const channels = useStore((s) => s.channels);
  const channelMembers = useStore((s) => s.channelMembers);
  const teamMembers = useStore((s) => s.teamMembers);
  const teams = useStore((s) => s.teams);
  const projects = useStore((s) => s.projects);
  const [pick, setPick] = useState("");

  const myTeams = useMemo(
    () =>
      agentId
        ? teamMembers
            .filter((tm) => tm.agent_id === agentId)
            .map((tm) => teams.find((t) => t.id === tm.team_id))
            .filter((t): t is Team => !!t)
        : [],
    [agentId, teamMembers, teams]
  );

  const mine = useMemo(() => {
    if (!agentId) return [];
    const teamIds = new Set(myTeams.map((t) => t.id));
    const ids = new Set<string>();
    for (const m of channelMembers) {
      if (m.member_type === "agent" && m.member_id === agentId) ids.add(m.channel_id);
      if (m.member_type === "team" && teamIds.has(m.member_id)) ids.add(m.channel_id);
    }
    return channels.filter((c) => ids.has(c.id));
  }, [agentId, channels, channelMembers, myTeams]);

  const channel = mine.find((c) => c.id === pick) ?? mine[0] ?? null;
  const project = channel ? projects.find((p) => p.id === channel.project_id) : undefined;

  // Exactly teamCharters() in agents.ts: the team must be a member of *this*
  // channel, not merely a team this agent belongs to.
  const inChannel = useMemo(
    () =>
      channel
        ? new Set(
            channelMembers
              .filter((m) => m.channel_id === channel.id && m.member_type === "team")
              .map((m) => m.member_id)
          )
        : new Set<string>(),
    [channel, channelMembers]
  );

  const roleBits = [
    role.trim() ? `Title: ${role.trim()}` : "",
    owns.trim() ? `You own: ${owns.trim()}` : "",
    persona.trim(),
    channel && agentId && channel.lead_agent_id === agentId && (channel.mode === "lead" || channel.mode === "panel")
      ? "You are the lead of this channel: you triage incoming work, delegate it to teammates, and report the outcome back to the user."
      : "",
  ].filter(Boolean);

  const layers: Layer[] = [];
  if (project) {
    layers.push({
      key: "project",
      label: `Project — ${project.name}`,
      text: project.instructions.trim()
        ? `## Standing instructions for this project\n${project.instructions.trim()}`
        : `No standing instructions on ${project.name}, so nothing is inherited from the project.`,
      absent: !project.instructions.trim(),
    });
  }
  for (const t of myTeams) {
    const charter = (t.charter ?? "").trim();
    const applies = inChannel.has(t.id);
    if (!charter && !applies) continue;
    layers.push({
      key: `team-${t.id}`,
      label: `Team — ${t.name}`,
      text: !charter
        ? `The ${t.name} team has no charter, so being in it adds nothing to this prompt.`
        : applies
          ? `## Charter — ${t.name} team\n${charter}`
          : `Not sent here. The ${t.name} team is not a member of #${channel?.name ?? ""} — only agents who joined by name are — so its charter is left out.`,
      absent: !charter || !applies,
    });
  }
  if (channel) {
    layers.push({
      key: "channel",
      label: `Channel — #${channel.name}`,
      text: channel.charter.trim()
        ? `## Charter — #${channel.name}\n${channel.charter.trim()}`
        : `#${channel.name} has no charter, so nothing is inherited from the channel.`,
      absent: !channel.charter.trim(),
    });
  }
  layers.push({
    key: "role",
    label: `This agent — ${name.trim() || "unnamed"}`,
    text: roleBits.length
      ? `## Your role\n${roleBits.join("\n")}`
      : "Empty. With no role, no ownership and no persona, the agent is told nothing about itself at all.",
    absent: !roleBits.length,
    mine: true,
  });

  return (
    <div className="ag-ctx">
      <div className="ag-ctx-head">
        <h4 className="ag-ctx-title">What it is told, in order</h4>
        {mine.length > 1 && (
          <label className="ag-ctx-pick">
            <span className="ag-sr">Preview the context for a channel</span>
            <select value={channel?.id ?? ""} onChange={(e) => setPick(e.target.value)}>
              {mine.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {agentId && !channel ? (
        <p className="ag-empty">
          In no channel yet, so there is nowhere for this to be sent. Add it to one below and the
          project, team and channel context it inherits appears here.
        </p>
      ) : !agentId ? (
        <p className="ag-empty">
          Create the agent and this fills in: the project instructions, team charter and channel
          charter it will inherit, in the order it receives them.
        </p>
      ) : (
        <>
          <ol className="ag-ctx-layers">
            {layers.map((l) => (
              <li
                key={l.key}
                className={"ag-ctx-layer" + (l.mine ? " ag-ctx-mine" : "")}
                data-absent={l.absent ? "1" : undefined}
              >
                <div className="ag-ctx-label">
                  {l.label}
                  {l.mine && <span className="ag-ctx-tag">you are editing this</span>}
                </div>
                <pre className="ag-ctx-body">{l.text}</pre>
              </li>
            ))}
          </ol>
          <p className="ag-ctx-foot">
            Then project memory, the open tasks, who else is in #{channel?.name}, and the
            conversation so far — the parts nobody writes here.
          </p>
        </>
      )}
    </div>
  );
}

async function restoreAgent(row: Agent, snap: RosterSnapshot): Promise<void> {
  try {
    const created = await useStore.getState().addAgent({
      name: row.name,
      kind: row.kind,
      model: row.model,
      persona: row.persona,
      role: row.role,
      owns: row.owns,
      cli_args: row.cli_args,
    });
    await reattach({ type: "agent", id: created.id }, snap);
    toast.success(
      `${row.name} is back`,
      "Channels, teams, assignments and links restored. Its saved conversations start fresh."
    );
  } catch (e) {
    toast.error(`Could not restore ${row.name}`, e);
  }
}

/** One manifest option, rendered as the control it declares. */
function OptionControl({
  opt,
  kind,
  value,
  ritzEndpoint,
  ritzAuthentication,
  onChange,
}: {
  opt: HarnessOption;
  kind: HarnessKind;
  value: OptionValue | undefined;
  ritzEndpoint?: string;
  ritzAuthentication?: string;
  onChange: (v: OptionValue) => void;
}) {
  const text = typeof value === "string" ? value : "";

  if (opt.control === "boolean") {
    return (
      <div className="opt">
        <label className="opt-check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="opt-label">{opt.label}</span>
          {opt.flag && <span className="opt-flag">{opt.flag}</span>}
          {opt.kind === "json" && <span className="opt-flag">{opt.key}</span>}
        </label>
        <div className="opt-hint">{opt.help}</div>
      </div>
    );
  }

  if (opt.control === "repeatable") {
    const items = Array.isArray(value) ? value : text ? [text] : [];
    return (
      <div className="opt">
        <OptHead opt={opt} />
        {items.map((item, i) => (
          <div className="rep-row" key={i}>
            <input
              value={item}
              spellCheck={false}
              placeholder={opt.placeholder}
              aria-label={`${opt.label} ${i + 1}`}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              className="icon-btn"
              type="button"
              title={`Remove ${opt.label.toLowerCase()}`}
              aria-label={`Remove ${opt.label.toLowerCase()} ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <IconX size={13} />
            </button>
          </div>
        ))}
        <button className="btn tiny rep-add" type="button" onClick={() => onChange([...items, ""])}>
          <IconPlus size={11} /> Add
        </button>
        <div className="opt-hint">{opt.help}</div>
      </div>
    );
  }

  if (opt.control === "enum") {
    return (
      <div className="opt">
        <OptHead opt={opt} />
        <select value={text} aria-label={opt.label} onChange={(e) => onChange(e.target.value)}>
          {!opt.choices?.includes(text) && <option value={text}>{text || "(harness default)"}</option>}
          {opt.choices?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="opt-hint">{opt.help}</div>
      </div>
    );
  }

  if (opt.control === "number") {
    return (
      <div className="opt">
        <OptHead opt={opt} />
        <input
          type="number"
          value={text}
          step={opt.step}
          min={opt.min}
          max={opt.max}
          placeholder={opt.placeholder}
          aria-label={opt.label}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="opt-hint">{opt.help}</div>
      </div>
    );
  }

  if (opt.dynamic === "ritz-models") {
    return (
      <RitzModelPicker
        opt={opt}
        value={text}
        onChange={onChange}
        active={kind === "ritz"}
        endpoint={ritzEndpoint || RITZ_BASE}
        authentication={ritzAuthentication || "trusted-local-origin"}
      />
    );
  }

  return (
    <div className="opt">
      <OptHead opt={opt} />
      <input
        value={text}
        spellCheck={false}
        placeholder={opt.placeholder}
        aria-label={opt.label}
        onChange={(e) => onChange(e.target.value)}
      />
      {opt.suggestions && (
        <div className="opt-suggest">
          {opt.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={text === s}
              className={"chip tiny-chip" + (text === s ? " on" : "")}
              onClick={() => onChange(text === s ? "" : s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="opt-hint">{opt.help}</div>
    </div>
  );
}

function OptHead({ opt }: { opt: HarnessOption }) {
  return (
    <div className="opt-head">
      <span className="field-label">{opt.label}</span>
      <span className="opt-flag">{opt.kind === "flag" ? opt.flag : opt.key}</span>
    </div>
  );
}

/** Model picker for Ritz: the live model list, with free text as the fallback. */
function RitzModelPicker({
  opt,
  value,
  onChange,
  active,
  endpoint,
  authentication,
}: {
  opt: HarnessOption;
  value: string;
  onChange: (v: OptionValue) => void;
  active: boolean;
  endpoint: string;
  authentication: string;
}) {
  const [models, setModels] = useState<RitzModel[] | null>(null);
  const [engineDefault, setEngineDefault] = useState("");
  const [error, setError] = useState("");
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const ac = new AbortController();
    setError("");
    ritzAuthHeaders({ authentication })
      .then((headers) => fetchRitzModels(ac.signal, endpoint, headers))
      .then((list) => {
        if (!live) return;
        setModels(list.models);
        setEngineDefault(list.default);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setModels([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      ac.abort();
    };
  }, [active, endpoint, authentication]);

  const known = models ?? [];
  const inList = known.some((m) => m.key === value);
  const asText = custom || (!!value && known.length > 0 && !inList) || (!!error && known.length === 0);

  return (
    <div className="opt">
      <OptHead opt={opt} />
      {asText ? (
        <input
          value={value}
          spellCheck={false}
          placeholder={opt.placeholder}
          aria-label={opt.label}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <select
          value={value}
          aria-label={opt.label}
          onChange={(e) => {
            if (e.target.value === "__custom") {
              setCustom(true);
              return;
            }
            onChange(e.target.value);
          }}
        >
          <option value="">
            {engineDefault ? `Let ${config().localAiName} choose (${engineDefault})` : `Let ${config().localAiName} choose`}
          </option>
          {/* keeps a saved model visible while the live list is still loading */}
          {!!value && !inList && <option value={value}>{value}</option>}
          {known.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name} — {m.key}
              {m.tier ? ` · ${m.tier}` : ""}
            </option>
          ))}
          <option value="__custom">Type a model key…</option>
        </select>
      )}
      {models === null && !error && (
        <div className="model-status">
          <Spinner /> Asking {config().localAiName} which models it has…
        </div>
      )}
      {!!error && (
        <div className="model-status warn">
          {config().localAiName} isn&rsquo;t answering on {RITZ_BASE.replace(/^https?:\/\//, "")} — type a model key, or start the engine and
          reopen this dialog.
        </div>
      )}
      {models !== null && !error && (
        <div className="model-status">
          {known.length} model{known.length === 1 ? "" : "s"} loaded.
          {asText && known.length > 0 && (
            <button
              className="model-link"
              type="button"
              onClick={() => {
                setCustom(false);
                if (!known.some((m) => m.key === value)) onChange("");
              }}
            >
              Pick from the list
            </button>
          )}
        </div>
      )}
      <div className="opt-hint">{opt.help}</div>
    </div>
  );
}

async function restoreTeam(row: Team, memberIds: string[], snap: RosterSnapshot): Promise<void> {
  try {
    const created = await useStore.getState().addTeam(row.name, row.description);
    if (row.charter) await useStore.getState().updateTeam(created.id, { charter: row.charter });
    const live = useStore.getState().agents;
    await useStore
      .getState()
      .setTeamMembers(created.id, memberIds.filter((id) => live.some((a) => a.id === id)));
    await reattach({ type: "team", id: created.id }, snap);
    toast.success(`${row.name} is back`, "Members, channels and assignments restored.");
  } catch (e) {
    toast.error(`Could not restore ${row.name}`, e);
  }
}
