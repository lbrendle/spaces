import { useEffect, useMemo, useState } from "react";
import { uid } from "../db";
import { ensureWorkspace } from "../workspaces";
import { useStore } from "../store";
import type { Agent } from "../types";
import { ChatView } from "./ChatView";
import { BrowserPane } from "./BrowserPane";
import { LiveProcessesPane } from "./LiveProcessesPane";
import { interactiveCommand, TerminalPane } from "./TerminalPane";
import {
  IconAgents,
  IconBolt,
  IconContract,
  IconExpand,
  IconGlobe,
  IconPlus,
  IconTerminal,
  IconX,
} from "./icons";
import { Avatar } from "./ui";
import "./commandcenter.css";

type Surface = "chat" | "terminal" | "processes" | "browser";
type UtilitySurface = Exclude<Surface, "chat">;

interface TerminalTab {
  id: string;
  label: string;
  agentId: string;
  cwd: string;
  program?: string;
  args?: string[];
}

export function ProjectWorkspaceView({
  projectId,
  active = true,
  selectedChannelId,
  initialSurface,
}: {
  projectId: string;
  active?: boolean;
  selectedChannelId?: string;
  initialSurface?: Surface;
}) {
  /*
   * Narrow selectors, never the whole state.
   *
   * `useStore()` with no selector returns the root state object, and zustand
   * gives that a new identity on every `set`. This component then re-rendered on
   * every unrelated store write — and, because that object was also in the
   * effect dependency list below, it re-ran an effect whose own two calls each
   * `set`, which re-made the object, which re-ran the effect. That loop is why
   * the whole workspace surface read as "not working": a wedged renderer draws
   * nothing, throws nothing, and logs nothing.
   */
  const projects = useStore((s) => s.projects);
  const allChannels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const activeRunIds = useStore((s) => s.activeRunIds);
  // Actions are defined once in the store initialiser, so these identities are
  // stable and safe to depend on.
  const loadMessages = useStore((s) => s.loadMessages);
  const markChannelRead = useStore((s) => s.markChannelRead);

  const project = projects.find((item) => item.id === projectId);
  const channels = useMemo(
    () => allChannels.filter((channel) => channel.project_id === projectId),
    [projectId, allChannels]
  );
  const [utility, setUtility] = useState<UtilitySurface | null>(
    initialSurface && initialSurface !== "chat" ? initialSurface : null
  );
  const [dockExpanded, setDockExpanded] = useState(false);
  const [browserOpened, setBrowserOpened] = useState(initialSurface === "browser");
  const [channelId, setChannelId] = useState(selectedChannelId ?? channels[0]?.id ?? "");
  const [terminals, setTerminals] = useState<TerminalTab[]>([]);
  const [activeTerminal, setActiveTerminal] = useState("");
  const [terminalError, setTerminalError] = useState("");
  const [launching, setLaunching] = useState("");
  const [sessionModel, setSessionModel] = useState("");
  const [sessionEffort, setSessionEffort] = useState("");

  useEffect(() => {
    if (initialSurface === undefined) return;
    const next = initialSurface === "chat" ? null : initialSurface;
    setUtility(next);
    if (next === "browser") setBrowserOpened(true);
  }, [initialSurface, projectId]);

  useEffect(() => {
    if (
      selectedChannelId &&
      selectedChannelId !== channelId &&
      channels.some((channel) => channel.id === selectedChannelId)
    ) {
      setChannelId(selectedChannelId);
    }
  }, [channelId, channels, selectedChannelId]);

  useEffect(() => {
    if (!channels.some((channel) => channel.id === channelId)) {
      setChannelId(channels[0]?.id ?? "");
    }
  }, [channelId, channels]);

  useEffect(() => {
    if (!channelId) return;
    void loadMessages(channelId);
    void markChannelRead(channelId);
  }, [channelId, loadMessages, markChannelRead]);

  if (!project) {
    // An inactive workspace can remain mounted to preserve its terminal and
    // browser state. If that project was deleted, it must render nothing while
    // App prunes the stale mount; otherwise this hidden workspace covers the
    // newly selected channel with a misleading error.
    return active ? <div className="main-pane center-note">Project not found.</div> : null;
  }
  const currentProject = project;

  async function addTerminal(agent?: Agent, useSessionOverrides = false) {
    const root = currentProject.local_path.trim();
    if (!root) {
      setTerminalError("Set this project's local path before opening a terminal.");
      setUtility("terminal");
      return;
    }
    setTerminalError("");
    setLaunching(agent?.id ?? "shell");
    try {
      const id = uid();
      let cwd = root;
      if (agent && currentProject.isolate) {
        cwd = (await ensureWorkspace(currentProject, agent)) ?? root;
      }
      const terminal: TerminalTab = agent
        ? (() => {
            const command = interactiveCommand(
              agent,
              useSessionOverrides
                ? { model: sessionModel || undefined, effort: sessionEffort || undefined }
                : undefined
            );
            return {
              id,
              label: agent.name,
              agentId: agent.id,
              cwd,
              program: command.program,
              args: command.args,
            };
          })()
        : {
            id,
            label: "Shell",
            agentId: `shell-${id}`,
            cwd,
            program: "zsh",
            args: ["-l", "-i"],
          };
      setTerminals((current) => [...current, terminal]);
      setActiveTerminal(id);
      setUtility("terminal");
    } catch (reason) {
      setTerminalError(String(reason));
      setUtility("terminal");
    } finally {
      setLaunching("");
    }
  }

  function closeTerminal(id: string) {
    // Derived from the list this render already has, not from inside a
    // setTerminals updater. React runs updaters during the render phase, so the
    // setActiveTerminal that used to live in there was a setState-during-render
    // — React logs "Cannot update a component while rendering a different one",
    // and the selection it computes can be thrown away and recomputed.
    const index = terminals.findIndex((terminal) => terminal.id === id);
    if (index === -1) return;
    const next = terminals.filter((terminal) => terminal.id !== id);
    setTerminals(next);
    if (activeTerminal === id) {
      setActiveTerminal(next[Math.min(index, Math.max(0, next.length - 1))]?.id ?? "");
    }
  }

  const browserStart = project.repo
    ? `https://github.com/${project.repo}`
    : "https://www.google.com";
  const activeProjectRuns = activeRunIds.filter((id) =>
    channels.some((channel) => channel.id === runs[id]?.channel_id)
  ).length;

  /** The tabs take the dock's header row only when there are sessions to name. */
  const showTabs = utility === "terminal" && terminals.length > 0;

  function toggleUtility(next: UtilitySurface) {
    if (next === "browser") setBrowserOpened(true);
    if (utility === next) {
      setUtility(null);
      setDockExpanded(false);
    } else {
      setUtility(next);
    }
  }

  return (
    <div
      className={"main-pane cc" + (active ? "" : " workspace-inactive")}
      aria-hidden={!active}
    >
      <div
        className={
          "cc-stage" +
          (utility ? " dock-open" : "") +
          (dockExpanded ? " dock-expanded" : "")
        }
      >
        <main className="cc-primary">
          {
          channelId ? (
            <ChatView channelId={channelId} />
          ) : (
            <div className="center-note">
              <strong>No project channel yet.</strong>
              Add one from the sidebar to use project chat.
            </div>
          )
          }
        </main>

        <aside
          className={"cc-dock" + (!utility ? " closed" : "")}
          aria-hidden={!utility}
        >
          {/* One bar, not two. The dock head used to name the surface
              ("Terminal sessions") directly above a second 35px strip whose tabs
              named each session — two rules, two backgrounds, and a title that
              said less than the tabs under it. With sessions open the tabs *are*
              the title, so they take the row and the label steps aside. */}
          <div className={"cc-dock-head" + (showTabs ? " with-tabs" : "")}>
            {showTabs ? (
              // A group rather than a tablist: each session carries two controls
              // (select and close), which a strict tablist has no room for.
              // role="group" is also what makes the label reachable — aria-label
              // on a bare div is dropped.
              <div className="cc-terminal-tabs" role="group" aria-label="Terminal sessions">
                {terminals.map((terminal) => (
                  <div
                    key={terminal.id}
                    className={
                      "cc-terminal-tab" + (terminal.id === activeTerminal ? " active" : "")
                    }
                  >
                    <button
                      aria-current={terminal.id === activeTerminal}
                      onClick={() => setActiveTerminal(terminal.id)}
                    >
                      <IconTerminal size={13} />
                      {terminal.label}
                    </button>
                    <button
                      className="cc-terminal-close"
                      title={`Close ${terminal.label} and end its process`}
                      aria-label={`Close ${terminal.label}`}
                      onClick={() => closeTerminal(terminal.id)}
                    >
                      <IconX size={11} />
                    </button>
                  </div>
                ))}
                <button
                  className="cc-add-tab"
                  title="New shell"
                  aria-label="New shell"
                  onClick={() => void addTerminal()}
                >
                  <IconPlus size={13} />
                </button>
              </div>
            ) : (
              <div className="cc-dock-title">
                {utility === "browser" ? (
                  <>
                    <IconGlobe size={13} /> Project browser
                  </>
                ) : utility === "processes" ? (
                  <>
                    <IconBolt size={13} /> Agent processes
                  </>
                ) : (
                  <>
                    <IconTerminal size={13} /> Terminal sessions
                  </>
                )}
              </div>
            )}
            <button
              className="icon-btn"
              title={dockExpanded ? "Return to side panel" : "Expand panel"}
              aria-label={dockExpanded ? "Return to side panel" : "Expand panel"}
              onClick={() => setDockExpanded((expanded) => !expanded)}
            >
              {dockExpanded ? <IconContract size={13} /> : <IconExpand size={13} />}
            </button>
            <button
              className="icon-btn"
              title="Hide panel"
              aria-label="Hide panel"
              onClick={() => {
                setUtility(null);
                setDockExpanded(false);
              }}
            >
              <IconX size={13} />
            </button>
          </div>

        <section className="cc-terminal-deck" hidden={utility !== "terminal"}>
          {terminalError && <div className="banner warn cc-terminal-error">{terminalError}</div>}

          {terminals.length === 0 ? (
            <TerminalLauncher
              agents={agents}
              launching={launching}
              hasPath={!!project.local_path.trim()}
              sessionModel={sessionModel}
              sessionEffort={sessionEffort}
              onSessionModel={setSessionModel}
              onSessionEffort={setSessionEffort}
              onLaunch={(agent) => void addTerminal(agent, !!agent)}
            />
          ) : (
            <div className="cc-terminal-panels">
              {terminals.map((terminal) => (
                <div
                  key={terminal.id}
                  className="cc-terminal-panel"
                  hidden={terminal.id !== activeTerminal}
                >
                  <TerminalPane
                    embedded
                    agentId={terminal.agentId}
                    cwd={terminal.cwd}
                    program={terminal.program}
                    args={terminal.args}
                    title={`${terminal.label} — ${project.name}`}
                    onClose={() => closeTerminal(terminal.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {browserOpened && (
          <div className="cc-browser-slot" hidden={utility !== "browser"}>
            <BrowserPane
              projectId={project.id}
              initialUrl={browserStart}
              active={active && utility === "browser"}
            />
          </div>
        )}

        <section className="cc-process-deck" hidden={utility !== "processes"}>
          <LiveProcessesPane projectId={project.id} />
        </section>
        </aside>

        <nav className="cc-rail" aria-label={`${project.name} coding tools`}>
          <button
            className={utility === "terminal" ? "active" : ""}
            title={utility === "terminal" ? "Hide terminal" : "Open terminal"}
            aria-label={utility === "terminal" ? "Hide terminal" : "Open terminal"}
            onClick={() => toggleUtility("terminal")}
          >
            <IconTerminal size={16} />
            {!!terminals.length && <span>{terminals.length}</span>}
          </button>
          <button
            className={utility === "processes" ? "active" : ""}
            title={utility === "processes" ? "Hide agent processes" : "Open agent processes"}
            aria-label={utility === "processes" ? "Hide agent processes" : "Open agent processes"}
            onClick={() => toggleUtility("processes")}
          >
            <IconBolt size={16} />
            {!!activeProjectRuns && <span>{activeProjectRuns}</span>}
          </button>
          <button
            className={utility === "browser" ? "active" : ""}
            title={utility === "browser" ? "Hide browser" : "Open browser"}
            aria-label={utility === "browser" ? "Hide browser" : "Open browser"}
            onClick={() => toggleUtility("browser")}
          >
            <IconGlobe size={16} />
          </button>
        </nav>
      </div>
    </div>
  );
}

function TerminalLauncher({
  agents,
  launching,
  hasPath,
  sessionModel,
  sessionEffort,
  onSessionModel,
  onSessionEffort,
  onLaunch,
}: {
  agents: Agent[];
  launching: string;
  hasPath: boolean;
  sessionModel: string;
  sessionEffort: string;
  onSessionModel: (value: string) => void;
  onSessionEffort: (value: string) => void;
  onLaunch: (agent?: Agent) => void;
}) {
  return (
    <div className="cc-launcher">
      <div className="cc-launcher-copy">
        <span className="field-label">New terminal</span>
        <h2>Start in this project</h2>
        <p>
          Open a shell or launch an agent interactively. Sessions stay alive when the panel is hidden.
        </p>
      </div>
      <div className="cc-session-config">
        <label>
          <span>Session model</span>
          <input
            value={sessionModel}
            onChange={(event) => onSessionModel(event.target.value)}
            placeholder="agent default"
          />
        </label>
        <label>
          <span>Session effort</span>
          <select
            value={sessionEffort}
            onChange={(event) => onSessionEffort(event.target.value)}
          >
            <option value="">agent default</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
        </label>
      </div>
      <div className="cc-launch-grid">
        <button
          className="cc-launch-card shell"
          disabled={!hasPath || !!launching}
          onClick={() => onLaunch()}
        >
          <span className="cc-launch-icon"><IconTerminal size={19} /></span>
          <span>
            <strong>Project shell</strong>
            <small>{launching === "shell" ? "Opening…" : "zsh in the project checkout"}</small>
          </span>
          <IconPlus size={15} />
        </button>
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="cc-launch-card"
            disabled={!hasPath || !!launching}
            onClick={() => onLaunch(agent)}
          >
            <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
            <span>
              <strong>{agent.name}</strong>
              <small>
                {launching === agent.id
                  ? "Preparing workspace…"
                  : `${agent.kind}${agent.role ? ` · ${agent.role}` : ""}`}
              </small>
            </span>
            <IconAgents size={15} />
          </button>
        ))}
      </div>
      {!hasPath && (
        <div className="cc-launch-note">
          Add a local checkout to this project before launching a terminal.
        </div>
      )}
    </div>
  );
}
