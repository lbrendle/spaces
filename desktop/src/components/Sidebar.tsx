import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, channelAgents } from "../store";
import { useTheme } from "../themeStore";
import {
  IconDashboard, IconTasks, IconBranch, IconMemory, IconAgents, IconHash, IconPlus, IconLogo, IconSun, IconMoon, IconGitHub, IconCheck, IconInfo,
  IconTerminal,
  IconDocument,
  IconMail,
  IconCalendar,
  IconMegaphone, IconGlobe,
  IconMoreVertical,
} from "./icons";
import { Modal, Field, Spinner } from "./ui";
import { AccountMenu } from "./AccountMenu";
import { open } from "@tauri-apps/plugin-dialog";
import { git, ghIn, isGitRepo } from "../workspaces";
import { slug } from "../types";
import "./newproject.css";
import { config } from "../config";
import { GitHubRepoPicker } from "./GitHubRepoPicker";

export function Sidebar() {
  const store = useStore();
  const { view, setView, projects, channels, unread, activeRunIds, runs } = store;
  const theme = useTheme((s) => s.theme);
  const toggleAppearance = useTheme((s) => s.toggleAppearance);
  const [newProject, setNewProject] = useState(false);
  const [newChannelFor, setNewChannelFor] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<
    { kind: "project" | "channel"; id: string } | null
  >(null);

  const activeChannels = new Set(
    activeRunIds.map((id) => runs[id]?.channel_id).filter(Boolean)
  );
  const activeWorkspaceChannelId =
    view.type === "workspace"
      ? view.channelId ??
        channels.find((channel) => channel.project_id === view.projectId)?.id ??
        ""
      : "";

  const navItem = (
    label: string,
    icon: ReactNode,
    type:
      | "dashboard"
      | "tasks"
      | "documents"
      | "mail"
      | "calendar"
      | "content"
      | "memory"
      | "agents"
      | "workspaces"
      | "settings"
      | "git"
      | "graph"
      | "knowledge"
      | "people"
  ) => (
    <div
      className={"nav-item" + (view.type === type ? " active" : "")}
      onClick={() => setView({ type })}
    >
      <span className="nav-icon">{icon}</span> {label}
    </div>
  );

  return (
    <div className="sidebar">
      <div className="sidebar-brand" data-tauri-drag-region>
        {/* No size: IconLogo's own 20 is the rail's glyph column exactly, so
            the mark fills the column the way the account's face does while the
            16px icons below are centred in it. All three share one axis. */}
        <span className="brand-mark"><IconLogo /></span> {config().brand}
        <span className="brand-hint" title="Command palette">⌘K</span>
        <button
          className="icon-btn appearance-toggle"
          title={`Switch to ${theme.appearance === "dark" ? "light" : "dark"} mode`}
          onClick={toggleAppearance}
        >{theme.appearance === "dark" ? <IconMoon /> : <IconSun />}</button>
      </div>
      <div className="nav-section">
        {navItem("Dashboard", <IconDashboard />, "dashboard")}
        {navItem("Tasks", <IconTasks />, "tasks")}
        {navItem("Documents", <IconDocument />, "documents")}
        {navItem("Mail", <IconMail />, "mail")}
        {navItem("Calendar", <IconCalendar />, "calendar")}
        {navItem("Content Studio", <IconMegaphone />, "content")}
        {navItem("Workspaces", <IconBranch />, "workspaces")}
        {navItem("Git activity", <IconGitHub />, "git")}
        {navItem("Memory", <IconMemory />, "memory")}
        {navItem("People", <IconAgents />, "people")}
        {navItem("Agents & Teams", <IconAgents />, "agents")}
        {navItem("Knowledge", <IconDocument />, "knowledge")}
        {navItem("Connections", <IconGlobe />, "graph")}
      </div>

      <div className="nav-section grow">
        <div className="nav-heading">
          Projects
          <button className="icon-btn" title="New project" onClick={() => setNewProject(true)}><IconPlus size={13} /></button>
        </div>
        {projects.length === 0 && (
          <div className="nav-empty">No projects yet.<br />Create one to get started.</div>
        )}
        {projects.map((p) => (
          <div key={p.id} className="project-group">
            <div
              className={
                "project-name" +
                (view.type === "workspace" && view.projectId === p.id ? " active" : "")
              }
            >
              <button
                className="project-open"
                title={`Open ${p.name} command center`}
                onClick={() =>
                  setView(
                    view.type === "workspace" && view.projectId === p.id
                      ? view
                      : { type: "workspace", projectId: p.id }
                  )
                }
              >
                <span>{p.name}</span>
              </button>
              <div className="project-actions">
                <button
                  className="icon-btn subtle"
                  title="Open coding workspace"
                  onClick={() =>
                    setView({
                      type: "workspace",
                      projectId: p.id,
                      channelId:
                        view.type === "workspace" && view.projectId === p.id
                          ? view.channelId
                          : undefined,
                      surface: "terminal",
                    })
                  }
                >
                  <IconTerminal size={13} />
                </button>
                <button
                  className="icon-btn subtle"
                  title="New channel"
                  onClick={() => setNewChannelFor(p.id)}
                >
                  <IconPlus size={13} />
                </button>
                <button
                  className="icon-btn subtle"
                  title={`Manage ${p.name}`}
                  aria-label={`Manage ${p.name}`}
                  onClick={() => setRemoveTarget({ kind: "project", id: p.id })}
                >
                  <IconMoreVertical size={13} />
                </button>
              </div>
            </div>
            {channels
              .filter((c) => c.project_id === p.id)
              .map((c) => {
                const agents = channelAgents(store, c.id);
                const active =
                  (view.type === "channel" && view.channelId === c.id) ||
                  (view.type === "workspace" && activeWorkspaceChannelId === c.id);
                const n = unread[c.id] ?? 0;
                const running = activeChannels.has(c.id);
                return (
                  <div
                    key={c.id}
                    className={"nav-item channel" + (active ? " active" : "") + (n ? " has-unread" : "")}
                    onClick={() => setView({ type: "channel", channelId: c.id })}
                  >
                    {/* The hash is this row's glyph, so it rides in the same
                        column as every nav icon rather than beside one. */}
                    <span className="nav-icon"><IconHash className="hash" /></span> {c.name}
                    {running && <span className="run-pulse" title="agent running" />}
                    {n > 0 ? (
                      <span className="unread-badge">{n > 99 ? "99+" : n}</span>
                    ) : (
                      agents.length > 0 && <span className="agent-count"><IconAgents size={12} />{agents.length}</span>
                    )}
                    <button
                      className="icon-btn subtle channel-manage"
                      title={`Manage #${c.name}`}
                      aria-label={`Manage #${c.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRemoveTarget({ kind: "channel", id: c.id });
                      }}
                    >
                      <IconMoreVertical size={13} />
                    </button>
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      <AccountMenu />

      {newProject && <NewProjectModal onClose={() => setNewProject(false)} />}
      {newChannelFor && (
        <NewChannelModal projectId={newChannelFor} onClose={() => setNewChannelFor(null)} />
      )}
      {removeTarget && (
        <RemovalModal
          kind={removeTarget.kind}
          id={removeTarget.id}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}

function RemovalModal({
  kind,
  id,
  onClose,
}: {
  kind: "project" | "channel";
  id: string;
  onClose: () => void;
}) {
  const store = useStore();
  const [confirmation, setConfirmation] = useState("");
  const [removing, setRemoving] = useState(false);
  const project = kind === "project" ? store.projects.find((item) => item.id === id) : undefined;
  const channel = kind === "channel" ? store.channels.find((item) => item.id === id) : undefined;
  const label = project?.name ?? channel?.name ?? "";
  if (!label) return null;

  const projectChannels = project
    ? store.channels.filter((item) => item.project_id === project.id)
    : [];
  const taskCount = project
    ? store.tasks.filter((item) => item.project_id === project.id).length
    : 0;
  const memoryCount = project
    ? store.memory.filter((item) => item.project_id === project.id).length
    : 0;

  async function remove() {
    if (confirmation !== label || removing) return;
    setRemoving(true);
    try {
      if (kind === "project") await store.deleteProject(id);
      else await store.deleteChannel(id);
      onClose();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Modal title={`Remove ${kind}`} onClose={onClose}>
      <div className="removal-warning">
        <strong>{kind === "project" ? project?.name : `#${channel?.name}`}</strong>
        {project ? (
          <p>
            Deletes {projectChannels.length} channel{projectChannels.length === 1 ? "" : "s"},{" "}
            {taskCount} task{taskCount === 1 ? "" : "s"}, and {memoryCount} memory entr
            {memoryCount === 1 ? "y" : "ies"}. Documents and Content Studio items are kept
            without a project. The code folder and remote repository are never deleted.
          </p>
        ) : (
          <p>
            Deletes the channel, its complete message history, saved sessions, and queued or
            running work. Other project data is unchanged.
          </p>
        )}
      </div>
      <Field label={`Type ${label} to confirm`}>
        <input
          value={confirmation}
          autoFocus
          autoComplete="off"
          onChange={(event) => setConfirmation(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void remove();
          }}
        />
      </Field>
      <div className="modal-actions">
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        <button
          className="btn danger"
          type="button"
          disabled={confirmation !== label || removing}
          onClick={() => void remove()}
        >
          {removing ? "Removing…" : `Remove ${kind}`}
        </button>
      </div>
    </Modal>
  );
}

/* ── New project: git inspection ─────────────────────────────── */

/** What the chosen local folder actually is. Drives every git option below. */
type GitProbe =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "missing" } // path isn't a directory (yet)
  | { kind: "plain" } // a directory, but not a git repo
  | { kind: "repo"; branch: string; root: string; origin: string; hasRemote: boolean; hasCommits: boolean }
  | { kind: "error"; message: string };

function errText(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  return s.trim() || "Unknown error";
}

const DEFAULT_GITIGNORE = `# Created by Spaces
.DS_Store
node_modules/
dist/
build/
*.log
.env
.env.local
`;

function baseName(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** owner/name out of an https or ssh GitHub remote, '' for anything else. */
function repoFromUrl(url: string): string {
  const m = url.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}

function firstUrl(out: string): string {
  const m = out.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[.,)\]]+$/, "") : "";
}

/**
 * Inspect a folder the user typed or picked. isGitRepo() swallows the reason a
 * folder isn't a repo, but "offer to run git init" is only the right answer for
 * one of those reasons — so on a miss we ask git again and read the failure.
 */
async function probePath(path: string): Promise<GitProbe> {
  if (await isGitRepo(path)) {
    const branch = (await git(path, "branch", "--show-current").catch(() => "")).trim();
    const root = (await git(path, "rev-parse", "--show-toplevel").catch(() => "")).trim();
    const hasCommits = await git(path, "rev-parse", "-q", "--verify", "HEAD").then(() => true, () => false);
    const remotes = (await git(path, "remote").catch(() => ""))
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    const origin = remotes.includes("origin")
      ? (await git(path, "remote", "get-url", "origin").catch(() => "")).trim()
      : "";
    return { kind: "repo", branch, root, origin, hasRemote: remotes.length > 0, hasCommits };
  }
  try {
    await git(path, "rev-parse", "--git-dir");
    // A git dir exists but there's no work tree: a bare repo, or the .git folder.
    return {
      kind: "error",
      message: "That folder is a bare repo or a .git directory — pick the working copy instead.",
    };
  } catch (e) {
    const m = errText(e);
    if (/directory does not exist/i.test(m)) return { kind: "missing" };
    if (/not a git repository/i.test(m)) return { kind: "plain" };
    if (/failed to launch/i.test(m)) return { kind: "error", message: "Could not run git — is it installed and on your PATH?" };
    return { kind: "error", message: m };
  }
}

async function writeGitignoreIfMissing(dir: string): Promise<void> {
  try {
    await invoke<string>("read_text_file", { root: dir, relativePath: ".gitignore" });
    return; // one already exists — never clobber it
  } catch {
    // no readable .gitignore; fall through and write the starter
  }
  await invoke("write_text_file", { root: dir, relativePath: ".gitignore", contents: DEFAULT_GITIGNORE });
}

/**
 * Exclude paths from this clone only, via .git/info/exclude — never the user's
 * .gitignore, which is tracked content we have no business rewriting.
 */
async function excludeLocally(dir: string, paths: string[]): Promise<void> {
  let existing = "";
  try {
    existing = await invoke<string>("read_text_file", { root: dir, relativePath: ".git/info/exclude" });
  } catch {
    // no exclude file yet — write_text_file will create it
  }
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const add = paths.filter((p) => !have.has(p));
  if (!add.length) return;
  const banner = "# added by Spaces: nested repositories with no commits";
  const lines = existing.trim() ? existing.replace(/\s*$/, "").split("\n") : [];
  if (!lines.includes(banner)) lines.push(banner);
  lines.push(...add);
  await invoke("write_text_file", {
    root: dir,
    relativePath: ".git/info/exclude",
    contents: lines.join("\n") + "\n",
  });
}

/**
 * Give the repo a HEAD. Worktrees and run checkpoints both need one commit to
 * exist, so an empty folder gets an empty commit rather than an unborn branch.
 *
 * A nested repository that has no commit of its own makes `git add -A` fail
 * outright ("does not have a commit checked out") and take the whole initial
 * commit down with it. Git names the offender, so skip it and retry rather
 * than leaving the project half-initialised. Returns the paths skipped.
 */
async function ensureInitialCommit(dir: string): Promise<string[]> {
  const hasCommits = await git(dir, "rev-parse", "-q", "--verify", "HEAD").then(() => true, () => false);
  if (hasCommits) return [];

  const skipped: string[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      await git(dir, "add", "-A");
      break;
    } catch (e) {
      const offenders = [
        ...errText(e).matchAll(/'([^']+)' does not have a commit checked out/g),
      ].map((m) => m[1]);
      // Only this specific failure is recoverable, and only finitely often.
      if (!offenders.length || attempt >= 5) throw e;
      await excludeLocally(dir, offenders);
      skipped.push(...offenders);
    }
  }

  const staged = (await git(dir, "status", "--porcelain")).trim();
  await git(dir, "commit", ...(staged ? [] : ["--allow-empty"]), "-m", "Initial commit");
  return skipped;
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { addProject, setView } = useStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [repo, setRepo] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [isolate, setIsolate] = useState(false);
  const [probe, setProbe] = useState<GitProbe>({ kind: "idle" });
  const [initGit, setInitGit] = useState(true);
  const [createGh, setCreateGh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [ghUrl, setGhUrl] = useState("");

  const dir = localPath.trim();

  // Inspect the folder as it's typed. Both git options reset with the path:
  // they're answers about *that* folder, and pushing to GitHub must always be
  // a fresh, deliberate choice.
  useEffect(() => {
    setInitGit(true);
    setCreateGh(false);
    if (!dir) {
      setProbe({ kind: "idle" });
      return;
    }
    setProbe({ kind: "checking" });
    let live = true;
    const t = setTimeout(() => {
      probePath(dir).then(
        (r) => {
          if (!live) return;
          setProbe(r);
          // A folder that already points at GitHub shouldn't land as an
          // unlinked project — offer its origin, without touching a typed value.
          if (r.kind === "repo" && r.origin) {
            const detected = repoFromUrl(r.origin);
            if (detected) setRepo((prev) => (prev.trim() ? prev : detected));
          }
        },
        (e) => live && setProbe({ kind: "error", message: errText(e) })
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [dir]);

  const isPlain = probe.kind === "plain";
  const willInit = isPlain && initGit;
  // Worktrees can only be cut inside a repo, so isolation is unavailable until
  // there is going to be one.
  const isolateBlocked = isPlain && !initGit;
  const canOfferGh = willInit || (probe.kind === "repo" && !probe.hasRemote);
  // Shown in the help text and used verbatim by gh, so they can never disagree.
  const ghRepo = slug(name) || slug(baseName(dir)) || baseName(dir);

  // Keep the two checkboxes honest: an option that isn't offered is never armed.
  useEffect(() => {
    if (isolateBlocked) setIsolate(false);
  }, [isolateBlocked]);
  useEffect(() => {
    if (!canOfferGh) setCreateGh(false);
  }, [canOfferGh]);

  function finish(projectId: string) {
    onClose();
    const chan = useStore.getState().channels.find((c) => c.project_id === projectId);
    if (chan) setView({ type: "channel", channelId: chan.id });
  }

  async function create() {
    const n = name.trim();
    if (!n || busy || createdId) return;
    setBusy(true);
    setProblems([]);
    setGhUrl("");

    const issues: string[] = [];
    let url = "";
    let linkedRepo = "";
    let gitReady = false;

    if (dir) {
      // Re-probe: the debounce may not have caught up with what was typed, and
      // git init is not something to run off a stale answer.
      const fresh = await probePath(dir);
      setProbe(fresh);
      let doInit = fresh.kind === "plain" && initGit;
      let doGh = createGh && (doInit || (fresh.kind === "repo" && !fresh.hasRemote));
      gitReady = fresh.kind === "repo";

      if (doInit) {
        try {
          await git(dir, "init");
          gitReady = true;
        } catch (e) {
          issues.push(`git init failed: ${errText(e)}`);
          doInit = false;
          doGh = false;
        }
      }
      if (doInit) {
        try {
          await writeGitignoreIfMissing(dir);
        } catch (e) {
          issues.push(`Could not write .gitignore: ${errText(e)}`);
        }
      }
      if (doInit || doGh) {
        try {
          const skipped = await ensureInitialCommit(dir);
          if (skipped.length) {
            issues.push(
              `Left ${skipped.join(", ")} out of the first commit — ` +
              `${skipped.length === 1 ? "it is a git repository" : "they are git repositories"} ` +
              `with no commits of its own. Everything else was committed.`
            );
          }
        } catch (e) {
          issues.push(`Initial commit failed: ${errText(e)}`);
          doGh = false; // nothing to push
        }
      }
      if (doGh && !ghRepo) {
        issues.push("Skipped the GitHub repo: could not work out a repo name from the project name or folder.");
      } else if (doGh) {
        try {
          const out = await ghIn(dir, "repo", "create", ghRepo, "--private", "--source", ".", "--push");
          url = firstUrl(out);
          linkedRepo = repoFromUrl(url);
        } catch (e) {
          issues.push(`Creating the GitHub repo failed: ${errText(e)}`);
        }
      }
      // Never let the project end up asking for worktrees it can't have.
      if (isolate && !gitReady) {
        issues.push(
          fresh.kind === "missing"
            ? `Isolated agent work is on, but ${dir} isn't a folder on this machine — Spaces can't create per-agent worktrees until it exists and is a git repository.`
            : `Isolated agent work is on, but ${dir} is not a git repository — Spaces can't create per-agent worktrees there until it is one.`
        );
      }
    }

    let project;
    try {
      project = await addProject({
        name: n,
        description: description.trim(),
        repo: repo.trim() || linkedRepo,
        local_path: dir,
        isolate: isolate ? 1 : 0,
      });
    } catch (e) {
      setProblems([...issues, `Could not create the project: ${errText(e)}`]);
      setBusy(false);
      return;
    }

    setCreatedId(project.id);
    setBusy(false);
    // Nothing to report — behave exactly as before and go straight to the channel.
    if (issues.length === 0 && !url) {
      finish(project.id);
      return;
    }
    setProblems(issues);
    setGhUrl(url);
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" />
      </Field>
      <Field label="Description">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project?" />
      </Field>
      <Field label="GitHub repo (optional)">
        <GitHubRepoPicker value={repo} onChange={setRepo} />
      </Field>
      <Field label="Local checkout (agents work here)">
        <div className="row">
          <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder={config().samplePath} />
          <button
            className="btn"
            onClick={async () => {
              const picked = await open({ directory: true });
              if (typeof picked === "string") setLocalPath(picked);
            }}
          >Browse…</button>
        </div>
      </Field>

      {probe.kind === "checking" && (
        <div className="np-probe"><Spinner /> Checking folder…</div>
      )}
      {probe.kind === "missing" && (
        <div className="np-probe">That folder doesn’t exist yet — pick one with Browse…</div>
      )}
      {probe.kind === "error" && (
        <div className="np-probe bad"><IconInfo size={13} /> {probe.message}</div>
      )}
      {probe.kind === "repo" && (
        <div className="np-probe">
          <span className="chip np-chip ok" title="Current branch">
            <IconCheck size={11} /> {probe.branch || "detached HEAD"}
          </span>
          {probe.origin ? (
            <span className="chip np-chip" title={probe.origin}>
              <IconGitHub size={11} /> {repoFromUrl(probe.origin) || probe.origin}
            </span>
          ) : (
            <span className="chip np-chip">no remote</span>
          )}
          {!probe.hasCommits && (
            <span className="chip np-chip warn" title="Worktrees need at least one commit">no commits yet</span>
          )}
          <span>Git repo — workspaces and run checkpoints will work here.</span>
          {probe.root && probe.root !== dir.replace(/\/+$/, "") && (
            <span className="np-note mono">Repo root: {probe.root}</span>
          )}
        </div>
      )}

      {isPlain && (
        <div className="banner warn np-setup">
          <div className="np-setup-title">
            <IconInfo size={14} /> This folder isn’t a git repository.
          </div>
          <label className="np-check">
            <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
            <span>
              <strong>Initialise a git repository here</strong>
              <span className="np-help">
                Spaces needs one to give each agent its own workspace (git worktree) and to checkpoint every
                run so you can undo it. Runs <code>git init</code>, adds a starter <code>.gitignore</code>{" "}
                if there isn’t one, then makes an initial commit. Stays entirely on this machine.
              </span>
            </span>
          </label>
        </div>
      )}

      {canOfferGh && (
        <label className="np-check np-gh">
          <input type="checkbox" checked={createGh} onChange={(e) => setCreateGh(e.target.checked)} />
          <span>
            <strong><IconGitHub size={12} /> Create a private GitHub repo too</strong>
            <span className="np-help">
              Runs <code>gh repo create {ghRepo || "<name>"} --private --source . --push</code> — this
              uploads the current contents of that folder to your GitHub account and sets it as{" "}
              <code>origin</code>. Nothing is published unless you tick this.
            </span>
          </span>
        </label>
      )}

      <label
        className={"field checkbox-field np-isolate" + (isolateBlocked ? " off" : "")}
        title={
          isolateBlocked
            ? "Needs a git repository — worktrees can only be created inside one. Tick “Initialise a git repository here” first."
            : undefined
        }
      >
        <input
          type="checkbox"
          checked={isolate}
          disabled={isolateBlocked}
          onChange={(e) => setIsolate(e.target.checked)}
        />
        <span>Isolate agent work — each agent edits in its own git worktree (branch hq/&lt;agent&gt;)</span>
      </label>

      {ghUrl && (
        <div className="np-result ok">
          <IconCheck size={13} />
          <span>Private repo created — <a href={ghUrl} target="_blank" rel="noreferrer">{ghUrl}</a></span>
        </div>
      )}
      {problems.map((p, i) => (
        <div key={i} className="np-result bad"><IconInfo size={13} /><span>{p}</span></div>
      ))}
      {createdId && problems.length > 0 && (
        <div className="np-probe">The project was still created — you can fix the git side in Settings.</div>
      )}

      <div className="modal-actions">
        {createdId ? (
          <button className="btn primary" onClick={() => finish(createdId)}>Continue</button>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>
              {busy ? <><Spinner /> Creating…</> : "Create project"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function NewChannelModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { addChannel, setView } = useStore();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");

  async function create() {
    const n = name.trim().toLowerCase().replace(/\s+/g, "-");
    if (!n) return;
    const c = await addChannel(projectId, n, topic.trim());
    onClose();
    setView({ type: "channel", channelId: c.id });
  }

  return (
    <Modal title="New channel" onClose={onClose}>
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="frontend" />
      </Field>
      <Field label="Topic">
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What's this channel about?" />
      </Field>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>Create channel</button>
      </div>
    </Modal>
  );
}
