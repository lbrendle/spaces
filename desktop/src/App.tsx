import { useEffect, useState } from "react";
import { useStore } from "./store";
import { IconLogo } from "./components/icons";
import {
  initAgentListener,
  ensureNotifyPermission,
  initRemoteAgentJobs,
} from "./agents";
import { initOrchestrator } from "./orchestrator";
import { syncAllProjects } from "./blackboard";
import { Sidebar } from "./components/Sidebar";
import { Shell } from "./components/Shell";
import { ChatView } from "./components/ChatView";
import { DashboardView } from "./components/DashboardView";
import { TasksView } from "./components/TasksView";
import { MemoryView } from "./components/MemoryView";
import { AgentsView } from "./components/AgentsView";
import { WorkspacesView } from "./components/WorkspacesView";
import { GitActivity } from "./components/GitActivity";
import { SettingsView } from "./components/SettingsView";
import { Palette } from "./components/Palette";
import { GraphView } from "./components/GraphView";
import { KnowledgeView } from "./components/KnowledgeView";
import { PeopleView } from "./components/PeopleView";
import { Inspector } from "./components/Inspector";
import { Toasts } from "./components/Toasts";
import { Onboarding, useNeedsOnboarding } from "./components/Onboarding";
import { ProjectWorkspaceView } from "./components/ProjectWorkspaceView";
import { PairingGate } from "./components/PairingGate";
import {
  ContentStudioView,
  DocumentsView,
  MailView,
} from "./components/OperationsViews";
// The calendar with ownership, sharing and the busy tier. The month grid that
// used to live in OperationsViews has been folded into it, so there is one.
import { CalendarView } from "./components/CalendarView";
import {
  initPortalSync,
  loadPortalConnection,
  type PortalConnection,
} from "./portal";
import "./App.css";
import { config } from "./config";
import { initAppUpdater } from "./updater";

export default function App() {
  const { loaded, view, init, projects, channels, setView } = useStore();
  const [mountedWorkspaceIds, setMountedWorkspaceIds] = useState<string[]>([]);
  const [portalChecked, setPortalChecked] = useState(false);
  const [portal, setPortal] = useState<PortalConnection | null>(null);
  // Per device, not per workspace: a second Mac belonging to the same person
  // still needs registering, even though their member row already exists.
  const needsSetup = useNeedsOnboarding();
  const [setupDone, setSetupDone] = useState(false);
  // Un-latch when setup becomes needed again, or "Run setup again" from the
  // account menu does nothing for the rest of the session.
  useEffect(() => {
    if (needsSetup) setSetupDone(false);
  }, [needsSetup]);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const openProjectBrowser = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; url?: string }>).detail;
      const projectId = detail?.projectId?.trim() ?? "";
      const url = detail?.url?.trim() ?? "";
      if (!projectId || !url) return;
      window.localStorage.setItem(`spaces-browser:${projectId}`, url);
      setView({ type: "workspace", projectId, surface: "browser" });
    };
    window.addEventListener("spaces:open-browser", openProjectBrowser);
    return () =>
      window.removeEventListener("spaces:open-browser", openProjectBrowser);
  }, [setView]);

  useEffect(() => initAppUpdater(), []);

  useEffect(() => {
    const refresh = () => {
      void loadPortalConnection().then((connection) => {
        setPortal(connection);
        setPortalChecked(true);
      });
    };
    refresh();
    window.addEventListener("hq:portal-change", refresh);
    return () => window.removeEventListener("hq:portal-change", refresh);
  }, []);

  useEffect(() => {
    if (!portal) return;
    void initAgentListener();
    void initOrchestrator();
    void ensureNotifyPermission();
    // Write the shared context and the agent write path before anything can
    // need them, rather than waiting for an unrelated edit to trigger it.
    void syncAllProjects();
    const stopPortal = initPortalSync();
    const stopRemoteJobs = initRemoteAgentJobs();
    const refreshAgentMirrors = () => void syncAllProjects(100);
    window.addEventListener("hq:content-change", refreshAgentMirrors);
    return () => {
      window.removeEventListener("hq:content-change", refreshAgentMirrors);
      stopRemoteJobs();
      stopPortal();
    };
  }, [portal?.device_id]);

  const activeWorkspaceId = view.type === "workspace" ? view.projectId : "";
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setMountedWorkspaceIds((current) =>
      current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]
    );
  }, [activeWorkspaceId]);

  // Workspaces stay mounted while the user switches between chat, terminal and
  // browser so those sessions persist. A deleted project is the exception: its
  // mounted component used to survive forever and render "Project not found"
  // over whichever channel the user opened next.
  useEffect(() => {
    const available = new Set(projects.map((project) => project.id));
    setMountedWorkspaceIds((current) => {
      const next = current.filter((projectId) => available.has(projectId));
      return next.length === current.length ? current : next;
    });
  }, [projects]);

  // Deletion can arrive from this Mac or from another workspace member through
  // portal sync. Never leave navigation pointing at an entity that no longer
  // exists on the shared workspace.
  useEffect(() => {
    const missingWorkspace =
      view.type === "workspace" &&
      !projects.some((project) => project.id === view.projectId);
    const missingChannel =
      view.type === "channel" &&
      !channels.some((channel) => channel.id === view.channelId);
    if (missingWorkspace || missingChannel) setView({ type: "dashboard" });
  }, [channels, projects, setView, view]);

  if (!loaded || !portalChecked) {
    return (
      <div className="app loading">
        <div className="brand-mark big"><IconLogo size={44} /></div>
        <div>Loading {config().brand}…</div>
      </div>
    );
  }

  if (!portal) {
    return <PairingGate onPaired={setPortal} />;
  }

  return (
    // Shell owns the frame — a resizable, collapsible sidebar and one scroll
    // model — so surfaces stop each inventing their own header and padding,
    // which is why they never felt like one app.
    <Shell sidebar={<Sidebar />}>
      {view.type === "dashboard" && <DashboardView />}
      {view.type === "tasks" && <TasksView />}
      {view.type === "documents" && <DocumentsView />}
      {view.type === "mail" && <MailView />}
      {view.type === "calendar" && <CalendarView />}
      {view.type === "content" && <ContentStudioView />}
      {view.type === "memory" && <MemoryView />}
      {view.type === "agents" && <AgentsView />}
      {view.type === "workspaces" && <WorkspacesView />}
      {view.type === "git" && <GitActivity />}
      {view.type === "graph" && <GraphView />}
      {view.type === "knowledge" && <KnowledgeView />}
      {view.type === "people" && <PeopleView />}
      {view.type === "settings" && <SettingsView />}
      {[
        ...mountedWorkspaceIds,
        ...(activeWorkspaceId && !mountedWorkspaceIds.includes(activeWorkspaceId)
          ? [activeWorkspaceId]
          : []),
      ].map((projectId) => {
        const active = view.type === "workspace" && view.projectId === projectId;
        return (
          <ProjectWorkspaceView
            key={projectId}
            projectId={projectId}
            active={active}
            selectedChannelId={active ? view.channelId : undefined}
            initialSurface={active ? view.surface : undefined}
          />
        );
      })}
      {view.type === "channel" && <ChatView channelId={view.channelId} />}
      {/* Mounted once, outside the view switch: the inspector follows whatever
          entity you clicked regardless of which surface you clicked it from. */}
      <Inspector />
      <Palette />
      <Toasts />
      {/* An overlay rather than a replacement for the frame: setup should look
          like the app it is setting up, and be escapable at any step. */}
      {needsSetup && !setupDone && <Onboarding onDone={() => setSetupDone(true)} />}
    </Shell>
  );
}
