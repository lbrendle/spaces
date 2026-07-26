import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Agent, Project } from "../types";
import {
  git,
  isGitRepo,
  hasCommits,
  currentBranch,
  diffOf,
  commitAll,
  createInitialCommit,
  discardAll,
  workspaceStatus,
  mergeWorkspace,
  mergeInProgress,
  abortMerge,
  createPR,
  removeWorkspace,
} from "../workspaces";
import type { WorkspaceStatus } from "../workspaces";
import { Avatar, Modal, Spinner } from "./ui";
import "./workspaces.css";

type OpenDiff = (title: string, dir: string) => void;

interface MainStatus {
  isRepo: boolean;
  hasCommits: boolean;
  branch: string;
  changedFiles: number;
  merging: boolean;
}

/** Human-readable message from a thrown value — e.message for Errors, not "[object Object]". */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface DiffModalState {
  title: string;
  loading: boolean;
  text: string;
  error: string;
}

export function WorkspacesView() {
  const projects = useStore((s) => s.projects);
  const withPath = projects.filter((p) => p.local_path.trim() !== "");
  const [tick, setTick] = useState(0);
  const [diff, setDiff] = useState<DiffModalState | null>(null);
  // Monotonic token so a slow earlier diff can't overwrite a newer request
  // (or resurrect a closed modal).
  const diffReq = useRef(0);

  const openDiff = useCallback(async (title: string, dir: string) => {
    const token = ++diffReq.current;
    setDiff({ title, loading: true, text: "", error: "" });
    try {
      const text = await diffOf(dir);
      if (token === diffReq.current) setDiff({ title, loading: false, text, error: "" });
    } catch (e) {
      if (token === diffReq.current) setDiff({ title, loading: false, text: "", error: errText(e) });
    }
  }, []);

  const closeDiff = useCallback(() => {
    diffReq.current++;
    setDiff(null);
  }, []);

  return (
    <div className="main-pane scroll-pane">
      <div className="pane-header">
        <div>
          <div className="pane-title">Workspaces</div>
          <div className="pane-sub">
            Mission control for the code your agents produce — main checkouts and per-agent git worktrees.
          </div>
        </div>
        <button className="btn" onClick={() => setTick((t) => t + 1)}>⟳ Refresh</button>
      </div>

      {!withPath.length ? (
        <div className="center-note">
          <div>
            <strong>No local checkouts yet.</strong>
            <br />
            Set a project&apos;s local path in its settings — agents run there, and this
            view becomes mission control for the code they produce.
          </div>
        </div>
      ) : (
        <div className="dash-body">
          {withPath.map((p) => (
            <ProjectSection key={p.id} project={p} tick={tick} openDiff={openDiff} />
          ))}
        </div>
      )}

      {diff && (
        <Modal title={diff.title} onClose={closeDiff} wide>
          {diff.loading ? (
            <div className="ws-loading-row"><Spinner /> Computing diff…</div>
          ) : diff.error ? (
            <div className="banner warn ws-error">{diff.error}</div>
          ) : !diff.text.trim() ? (
            <div className="nav-empty">No uncommitted changes.</div>
          ) : (
            <DiffText text={diff.text} />
          )}
        </Modal>
      )}
    </div>
  );
}

/* ── Project section ─────────────────────────────────────────── */

function ProjectSection({
  project,
  tick,
  openDiff,
}: {
  project: Project;
  tick: number;
  openDiff: OpenDiff;
}) {
  const store = useStore();
  const agents = store.agents;
  const [main, setMain] = useState<MainStatus | null>(null);
  const [wss, setWss] = useState<Record<string, WorkspaceStatus | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isolateNote, setIsolateNote] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const dir = project.local_path;
      const repo = await isGitRepo(dir);
      let committed = false;
      let branch = "";
      let changedFiles = 0;
      let merging = false;
      if (repo) {
        [committed, branch] = await Promise.all([
          hasCommits(dir),
          currentBranch(dir),
        ]);
        changedFiles = (await git(dir, "status", "--porcelain")).split("\n").filter(Boolean).length;
        merging = await mergeInProgress(dir);
      }
      const entries = await Promise.all(
        agents.map(async (a) => [a.id, await workspaceStatus(project, a).catch(() => null)] as const)
      );
      setMain({ isRepo: repo, hasCommits: committed, branch, changedFiles, merging });
      setWss(Object.fromEntries(entries));
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [project, agents]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    if (!isolateNote) return;
    const t = setTimeout(() => setIsolateNote(false), 8000);
    return () => clearTimeout(t);
  }, [isolateNote]);

  async function toggleIsolate(checked: boolean) {
    await store.updateProject(project.id, { isolate: checked ? 1 : 0 });
    // Resumed CLI sessions have the old working directory baked in — reset them
    // so the next run starts fresh in the right place.
    await store.clearProjectSessions(project.id);
    setIsolateNote(true);
  }

  const activeWorkspaces = agents.filter((a) => wss?.[a.id]);

  return (
    <section className="dash-card">
      <h3>
        {project.name}
        {project.repo && <span className="chip repo-chip">{project.repo}</span>}
        {loading && <Spinner />}
        <label className="ws-isolate">
          <input
            type="checkbox"
            checked={!!project.isolate}
            onChange={(e) => void toggleIsolate(e.target.checked)}
          />
          Isolate agent work
        </label>
      </h3>
      <div className="ws-isolate-caption">
        Each agent gets its own git worktree + branch (hq/&lt;agent&gt;) instead of editing the
        shared checkout.
      </div>
      {isolateNote && (
        <div className="ws-isolate-note">
          Agent sessions for this project were reset so new runs pick up the new working directory.
        </div>
      )}

      {loadError && <div className="banner warn ws-error">{loadError}</div>}

      <div className="ws-grid">
        <MainCheckoutCard project={project} main={main} reload={load} openDiff={openDiff} />
        {agents.map((a) => {
          const st = wss?.[a.id];
          if (!st) return null;
          return (
            <AgentWorkspaceCard
              key={a.id}
              project={project}
              agent={a}
              status={st}
              reload={load}
              openDiff={openDiff}
            />
          );
        })}
      </div>
      {main?.isRepo && !main.hasCommits ? (
        <div className="ws-hint">
          This repository has no commits yet. Its shared checkout still works,
          but Git needs a first commit before Spaces can create isolated agent workspaces.
        </div>
      ) : main?.isRepo && wss && !activeWorkspaces.length && (
        <div className="ws-hint">
          No agent workspaces yet — with isolation on, each agent gets its own worktree
          automatically the first time it runs here.
        </div>
      )}
    </section>
  );
}

/* ── Shared action state ─────────────────────────────────────── */

function useGitAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

function InlineForm({
  placeholder,
  action,
  busy,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  action: string;
  busy: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="ws-inline-form">
      <input
        autoFocus
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim() && !busy) onSubmit(value.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <button
        className="btn tiny primary"
        disabled={busy || !value.trim()}
        onClick={() => onSubmit(value.trim())}
      >
        {action}
      </button>
    </div>
  );
}

/* ── Main checkout card ──────────────────────────────────────── */

function MainCheckoutCard({
  project,
  main,
  reload,
  openDiff,
}: {
  project: Project;
  main: MainStatus | null;
  reload: () => Promise<void>;
  openDiff: OpenDiff;
}) {
  const dir = project.local_path;
  const { busy, error, run } = useGitAction(reload);
  const [commitOpen, setCommitOpen] = useState(false);

  async function doCommit(message: string) {
    const ok = await run(() => commitAll(dir, message));
    if (ok) setCommitOpen(false);
  }

  async function doInitialCommit() {
    await run(() => createInitialCommit(dir));
  }

  if (!main) {
    return (
      <div className="ws-card">
        <div className="ws-loading-row"><Spinner /> Checking main checkout…</div>
      </div>
    );
  }

  if (!main.isRepo) {
    return (
      <div className="ws-card">
        <div className="ws-card-head">
          <div className="ws-card-id">
            <div className="ws-card-title">Main checkout</div>
            <div className="ws-branch" title={dir}>{dir}</div>
          </div>
        </div>
        <div className="ws-hint">
          Not a git repository — run <code>git init</code> in this folder to track diffs and
          enable agent workspaces.
        </div>
      </div>
    );
  }

  const dirty = main.changedFiles > 0;
  const branchLabel =
    main.branch || (main.hasCommits ? "detached HEAD" : "new repository");
  return (
    <div className="ws-card">
      <div className="ws-card-head">
        <div className="ws-card-id">
          <div className="ws-card-title">Main checkout</div>
          <div className="ws-branch" title={dir}>{branchLabel}</div>
        </div>
        <div className="ws-stats">
          <span
            className={"chip tiny-chip ws-stat" + (dirty ? " dirty" : "")}
            title="Uncommitted changed files"
          >
            {main.changedFiles} changed
          </span>
        </div>
      </div>

      {main.merging && (
        <div>
          <span
            className="chip tiny-chip ws-stat merging"
            title="A merge stopped on conflicts in this checkout. Resolve the conflicts in your editor and commit, or abort the merge."
          >
            merge in progress — resolve or abort
          </span>
        </div>
      )}

      {error && <div className="banner warn ws-error">{error}</div>}

      {!main.hasCommits && (
        <div className="ws-hint">
          No commits yet. Commit the current files, or create an empty first
          commit, to enable isolated worktrees and branch comparisons.
        </div>
      )}

      <div className="ws-actions">
        <button
          className="btn tiny"
          disabled={busy}
          onClick={() => openDiff(`${project.name} — main checkout diff`, dir)}
        >
          View diff
        </button>
        {main.merging && (
          <button
            className="btn tiny danger"
            disabled={busy}
            onClick={() => void run(() => abortMerge(dir))}
          >
            Abort merge
          </button>
        )}
        <button
          className="btn tiny"
          disabled={busy || !dirty}
          onClick={() => setCommitOpen((o) => !o)}
        >
          Commit…
        </button>
        {!main.hasCommits && !dirty && (
          <button
            className="btn tiny"
            disabled={busy}
            onClick={() => void doInitialCommit()}
          >
            Create first commit
          </button>
        )}
        <button
          className="btn tiny danger"
          disabled={busy || !dirty}
          onClick={() => {
            if (confirm(`Discard all uncommitted changes in ${dir}? This cannot be undone.`)) {
              void run(() => discardAll(dir));
            }
          }}
        >
          Discard changes
        </button>
        {busy && <Spinner />}
      </div>

      {commitOpen && (
        <InlineForm
          placeholder="Commit message"
          action="Commit"
          busy={busy}
          onSubmit={(msg) => void doCommit(msg)}
          onCancel={() => setCommitOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Agent workspace card ────────────────────────────────────── */

function AgentWorkspaceCard({
  project,
  agent,
  status,
  reload,
  openDiff,
}: {
  project: Project;
  agent: Agent;
  status: WorkspaceStatus;
  reload: () => Promise<void>;
  openDiff: OpenDiff;
}) {
  const { busy, error, run } = useGitAction(reload);
  const [commitOpen, setCommitOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prUrl, setPrUrl] = useState("");

  const dirty = status.changedFiles > 0;
  const canMerge = status.changedFiles === 0 && status.aheadOfBase > 0;

  async function doCommit(message: string) {
    const ok = await run(() => commitAll(status.path, message));
    if (ok) setCommitOpen(false);
  }

  async function doPR(title: string) {
    let url = "";
    const ok = await run(async () => {
      url = await createPR(project, agent, title);
    });
    if (ok) {
      setPrUrl(url);
      setPrOpen(false);
    }
  }

  return (
    <div className="ws-card">
      <div className="ws-card-head">
        <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
        <div className="ws-card-id">
          <div className="ws-card-title">{agent.name}</div>
          <div className="ws-branch" title={status.path}>{status.branch}</div>
        </div>
        <div className="ws-stats">
          <span
            className={"chip tiny-chip ws-stat" + (dirty ? " dirty" : "")}
            title="Uncommitted changed files"
          >
            {status.changedFiles} changed
          </span>
          <span
            className={"chip tiny-chip ws-stat" + (status.aheadOfBase > 0 ? " ahead" : "")}
            title="Commits ahead of the main checkout's branch"
          >
            {status.aheadOfBase} ahead
          </span>
        </div>
      </div>

      {error && <div className="banner warn ws-error">{error}</div>}
      {prUrl && (
        <div className="ws-pr">
          PR opened: <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a>
        </div>
      )}

      <div className="ws-actions">
        <button
          className="btn tiny"
          disabled={busy}
          onClick={() => openDiff(`${project.name} — ${agent.name}'s workspace diff`, status.path)}
        >
          View diff
        </button>
        <button
          className="btn tiny"
          disabled={busy || !dirty}
          onClick={() => {
            setCommitOpen((o) => !o);
            setPrOpen(false);
          }}
        >
          Commit…
        </button>
        <button
          className="btn tiny"
          disabled={busy || !canMerge}
          title={
            canMerge
              ? `Merge ${status.branch} into the main checkout`
              : "Commit workspace changes first, then merge — enabled once there are no uncommitted changes and the branch is ahead of base."
          }
          onClick={() => void run(() => mergeWorkspace(project, agent))}
        >
          Merge into main
        </button>
        <button
          className="btn tiny"
          disabled={busy}
          onClick={() => {
            setPrOpen((o) => !o);
            setCommitOpen(false);
          }}
        >
          Push + PR
        </button>
        <button
          className="btn tiny danger"
          disabled={busy || !dirty}
          onClick={() => {
            if (
              confirm(
                `Discard all uncommitted changes in ${agent.name}'s workspace? This cannot be undone.`
              )
            ) {
              void run(() => discardAll(status.path));
            }
          }}
        >
          Discard
        </button>
        <button
          className="btn tiny danger"
          disabled={busy}
          onClick={() => {
            if (
              confirm(
                `Remove ${agent.name}'s workspace and force-delete branch ${status.branch}? ` +
                  `This permanently deletes uncommitted changes AND any commits on ${status.branch} ` +
                  `that haven't been merged or pushed.`
              )
            ) {
              void run(() => removeWorkspace(project, agent));
            }
          }}
        >
          Remove workspace
        </button>
        {busy && <Spinner />}
      </div>

      {commitOpen && (
        <InlineForm
          placeholder="Commit message"
          action="Commit"
          busy={busy}
          onSubmit={(msg) => void doCommit(msg)}
          onCancel={() => setCommitOpen(false)}
        />
      )}
      {prOpen && (
        <InlineForm
          placeholder="PR title"
          action="Open PR"
          busy={busy}
          onSubmit={(title) => void doPR(title)}
          onCancel={() => setPrOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Diff rendering ──────────────────────────────────────────── */

function diffLineClass(line: string): string {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) {
    return "file";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const MAX_DIFF_LINES = 2000;

function DiffText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const hidden = lines.length - shown.length;
  return (
    <div className="diff-pane">
      {shown.map((line, i) => (
        <div key={i} className={`diff-line ${diffLineClass(line)}`}>
          {line === "" ? " " : line}
        </div>
      ))}
      {hidden > 0 && (
        <div className="diff-line note">
          … {hidden} more lines — open the diff in your editor for the rest.
        </div>
      )}
    </div>
  );
}
