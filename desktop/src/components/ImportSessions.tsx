/**
 * Import history — the work Claude Code and Codex already did here.
 *
 * Both keep every session they have run on this Mac, as JSONL, filed by the
 * directory the work happened in. That is the context somebody already has,
 * and until this screen existed Spaces asked them to explain a project from
 * scratch while thousands of sessions sat unread on the same disk.
 *
 * The list is directories, not sessions, because a directory is what becomes a
 * project. Each row says how much is there, how old it is, and whether Spaces
 * is already keeping it up to date — and offers the two things worth doing
 * with it, which are not the same decision:
 *
 *   Index    — an index of what happened goes into project memory, which every
 *              agent reads before every run. Cheap, and the answer to "use the
 *              context it already has".
 *   Index and read — the conversations are also replayed into a #history
 *              channel you can scroll. Much more to import, and worth it for
 *              the handful of projects you actually want to pick back up.
 *
 * Either one starts a watch, so sessions written after today arrive on their
 * own. That is the difference between importing once and picking up where you
 * left off.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { shortPath } from "../sessionpaths";
import {
  importGroup,
  scanSessions,
  unwatch,
  type ImportMode,
  type ImportProgress,
  type SessionGroup,
} from "../sessions";
import { toast } from "../toast";
import { useStore } from "./../store";
import { IconRefresh, IconSearch } from "./icons";
import { Spinner } from "./ui";
import "./importsessions.css";

/** Rows rendered before the list asks you to narrow it down. */
const PAGE = 40;

export function ImportSessions() {
  const setView = useStore((s) => s.setView);
  const [groups, setGroups] = useState<SessionGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [shown, setShown] = useState(PAGE);

  const scan = useCallback(async () => {
    setGroups(null);
    try {
      setGroups(await scanSessions());
    } catch (e) {
      toast.error("Could not read local sessions", e);
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !groups) return groups ?? [];
    return groups.filter(
      (g) => g.name.toLowerCase().includes(needle) || g.cwd.toLowerCase().includes(needle)
    );
  }, [groups, query]);

  const totals = useMemo(() => {
    const list = groups ?? [];
    return {
      sessions: list.reduce((n, g) => n + g.sessions.length, 0),
      claude: list.reduce((n, g) => n + g.claude, 0),
      codex: list.reduce((n, g) => n + g.codex, 0),
      watched: list.filter((g) => g.watching).length,
    };
  }, [groups]);

  async function run(group: SessionGroup, mode: ImportMode) {
    setBusy(group.cwd);
    setProgress({ done: 0, total: group.sessions.length, label: "" });
    try {
      const result = await importGroup(group, mode, setProgress);
      toast.success(
        result.sessions > 0
          ? `${result.projectName}: ${result.sessions} session${result.sessions === 1 ? "" : "s"} imported`
          : `${result.projectName} is already up to date`,
        [
          mode === "browse" && result.messages > 0
            ? `${result.messages} messages are in #history.`
            : "",
          "Spaces will pick up new sessions here on its own.",
          result.failures.length > 0 ? `${result.failures.length} could not be read.` : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
      await scan();
    } catch (e) {
      toast.error(`Could not import ${group.name}`, e);
    } finally {
      setBusy("");
      setProgress(null);
    }
  }

  async function stop(group: SessionGroup) {
    await unwatch(group.cwd);
    toast.success(`Stopped watching ${group.name}`, "What is already imported stays.");
    await scan();
  }

  return (
    /*
     * The app's pane model is three parts, not one.
     *
     * `main-pane scroll-pane` deliberately does *not* scroll — it is
     * `overflow: hidden` — because the header is a fixed sibling and the body
     * owns the scroller, so headings inside the body can stick at top:0
     * without competing with the header for the offset. Putting the whole
     * surface in the wrapper, as this did, means nothing scrolls at all and
     * the list runs off the bottom of the window.
     */
    <div className="main-pane scroll-pane im">
      <div className="pane-header">
        <div>
          <div className="pane-title">Import history</div>
          <div className="pane-sub">
            Every Claude Code and Codex session on this Mac, grouped by the folder it ran in.
            Importing reads those files and never changes them.
          </div>
        </div>
        <button className="btn" onClick={() => void scan()} disabled={groups === null}>
          {groups === null ? <Spinner /> : <IconRefresh size={13} />} Re-scan
        </button>
      </div>

      <div className="db-body im-body">
      {groups === null ? (
        <p className="im-empty">
          <Spinner /> Reading session files…
        </p>
      ) : groups.length === 0 ? (
        <p className="im-empty">
          No sessions found. Spaces looks in <code>~/.claude/projects</code> and{" "}
          <code>~/.codex/sessions</code>, which is where those two write their history.
        </p>
      ) : (
        <>
          <p className="im-totals">
            {totals.sessions.toLocaleString()} sessions across {groups.length} folders —{" "}
            {totals.claude.toLocaleString()} from Claude Code, {totals.codex.toLocaleString()} from
            Codex.
            {totals.watched > 0 && ` ${totals.watched} kept up to date.`}
          </p>

          <div className="im-search">
            <IconSearch size={13} />
            <input
              value={query}
              placeholder="Filter by folder or project name…"
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
            />
          </div>

          <div className="im-list">
            {filtered.slice(0, shown).map((group) => (
              <Row
                key={group.cwd}
                group={group}
                busy={busy === group.cwd}
                progress={busy === group.cwd ? progress : null}
                disabled={busy !== "" && busy !== group.cwd}
                onImport={(mode) => void run(group, mode)}
                onStop={() => void stop(group)}
                onOpen={() => group.projectId && setView({ type: "workspace", projectId: group.projectId })}
              />
            ))}
          </div>

          {filtered.length > shown && (
            <button className="btn tiny im-more" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length}
            </button>
          )}
          {filtered.length === 0 && <p className="im-empty">Nothing matches “{query}”.</p>}
        </>
      )}
      </div>
    </div>
  );
}

function Row({
  group,
  busy,
  progress,
  disabled,
  onImport,
  onStop,
  onOpen,
}: {
  group: SessionGroup;
  busy: boolean;
  progress: ImportProgress | null;
  disabled: boolean;
  onImport: (mode: ImportMode) => void;
  onStop: () => void;
  onOpen: () => void;
}) {
  const total = group.sessions.length;
  const when = group.lastAt ? new Date(group.lastAt).toLocaleDateString() : "";
  const partial = group.imported > 0 && group.imported < total;

  return (
    <div className={`im-row${busy ? " im-busy" : ""}`}>
      <div className="im-id">
        <span className="im-name">{group.name}</span>
        <span className="im-path" title={group.cwd}>
          {shortPath(group.cwd)}
        </span>
      </div>

      <div className="im-facts">
        <span className="im-count">
          {total.toLocaleString()} session{total === 1 ? "" : "s"}
        </span>
        <span className="im-split">
          {group.claude > 0 && `${group.claude} Claude`}
          {group.claude > 0 && group.codex > 0 && " · "}
          {group.codex > 0 && `${group.codex} Codex`}
        </span>
        {when && <span className="im-when">last {when}</span>}
      </div>

      <div className="im-state">
        {group.watching ? (
          <button className="im-watching" onClick={onStop} title="Stop keeping this up to date">
            watching · {group.watching === "browse" ? "read" : "index"}
          </button>
        ) : group.projectId ? (
          <button className="im-linked" onClick={onOpen}>
            already a project
          </button>
        ) : (
          <span className="im-new">new project</span>
        )}
        {partial && <span className="im-partial">{group.imported} of {total} in</span>}
      </div>

      <div className="im-actions">
        {busy ? (
          <span className="im-progress">
            <Spinner />
            {progress ? ` ${progress.done}/${progress.total}` : ""}
          </span>
        ) : (
          <>
            <button className="btn tiny" disabled={disabled} onClick={() => onImport("index")}>
              Index
            </button>
            <button
              className="btn tiny primary"
              disabled={disabled}
              onClick={() => onImport("browse")}
            >
              Index and read
            </button>
          </>
        )}
      </div>
    </div>
  );
}
