import { useEffect, useMemo, useRef, useState } from "react";
import { cancelRun } from "../agents";
import { useStore } from "../store";
import type { ActivityEvent, Run } from "../types";
import { IconBolt, IconInfo, IconX } from "./icons";
import { RunInspector } from "./RunInspector";
import { Avatar } from "./ui";
import "./processes.css";

const MAX_VISIBLE_TRANSCRIPT = 160_000;

function duration(run: Run, now: number): string {
  const total = Math.max(0, Math.round(((run.finished_at || now) - run.started_at) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function activityFor(run: Run): ActivityEvent[] {
  try {
    const parsed = JSON.parse(run.activity || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function visibleOutput(run: Run): string {
  if (run.transcript) {
    const clipped = run.transcript.slice(-MAX_VISIBLE_TRANSCRIPT);
    return clipped.length < run.transcript.length
      ? `… ${run.transcript.length - clipped.length} earlier characters hidden\n${clipped}`
      : clipped;
  }
  const events = activityFor(run);
  if (events.length) {
    return events
      .map((event) => {
        const seconds = Math.max(0, Math.floor(event.t / 1000));
        const stamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
          seconds % 60
        ).padStart(2, "0")}`;
        return `${stamp}  ${event.kind.padEnd(6)}  ${event.detail}`;
      })
      .join("\n");
  }
  return run.status === "running" ? "Waiting for the first process event…" : "No output recorded.";
}

export function LiveProcessesPane({ projectId }: { projectId: string }) {
  // Selectors, not the whole state: this pane renders a live transcript, and
  // subscribing to the root object re-renders all of it on every unrelated
  // store write anywhere in the app.
  const allChannels = useStore((s) => s.channels);
  const allRuns = useStore((s) => s.runs);
  const activeRunIds = useStore((s) => s.activeRunIds);
  const agents = useStore((s) => s.agents);
  const loadProjectRuns = useStore((s) => s.loadProjectRuns);

  const [selectedId, setSelectedId] = useState("");
  const [inspectId, setInspectId] = useState("");
  const [now, setNow] = useState(Date.now());
  // The detail column is the one scroll region — see processes.css.
  const detailRef = useRef<HTMLElement>(null);
  const channelIds = useMemo(
    () =>
      new Set(
        allChannels
          .filter((channel) => channel.project_id === projectId)
          .map((channel) => channel.id)
      ),
    [projectId, allChannels]
  );
  const runs = useMemo(
    () =>
      Object.values(allRuns)
        .filter((run) => channelIds.has(run.channel_id))
        .sort((a, b) => {
          const active =
            Number(activeRunIds.includes(b.id)) - Number(activeRunIds.includes(a.id));
          return active || b.started_at - a.started_at;
        }),
    [channelIds, activeRunIds, allRuns]
  );
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const selectedAgent = agents.find((agent) => agent.id === selected?.agent_id);
  const selectedChannel = allChannels.find((channel) => channel.id === selected?.channel_id);
  const output = selected ? visibleOutput(selected) : "";

  useEffect(() => {
    void loadProjectRuns(projectId);
  }, [projectId, loadProjectRuns]);

  useEffect(() => {
    if (!selectedId && runs[0]) setSelectedId(runs[0].id);
    if (selectedId && !runs.some((run) => run.id === selectedId)) {
      setSelectedId(runs[0]?.id ?? "");
    }
  }, [runs, selectedId]);

  useEffect(() => {
    if (!runs.some((run) => run.status === "running")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runs]);

  useEffect(() => {
    const element = detailRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [selected?.id, output]);

  if (!runs.length) {
    return (
      <div className="proc-empty">
        <IconBolt size={18} />
        <strong>No agent processes yet</strong>
        <span>Run an agent from project chat or the board. Its stream will appear here live.</span>
      </div>
    );
  }

  return (
    <>
      <div className="proc-layout">
        <div className="proc-list" aria-label="Project agent processes">
          <div className="proc-list-label">
            <span>Processes</span>
            <span>{runs.length}</span>
          </div>
          {runs.map((run) => {
            const agent = agents.find((item) => item.id === run.agent_id);
            return (
              <button
                key={run.id}
                className={"proc-row" + (selected?.id === run.id ? " active" : "")}
                onClick={() => setSelectedId(run.id)}
              >
                <span className={`proc-status ${run.status}`} />
                <span className="proc-row-main">
                  <strong>{agent?.name ?? "Unknown agent"}</strong>
                  <span>{run.status === "running" ? "live" : run.status} · {duration(run, now)}</span>
                </span>
                <span className="proc-kind">{agent?.kind ?? "agent"}</span>
              </button>
            );
          })}
        </div>

        {selected && (
          <section
            className="proc-detail"
            aria-label="Selected agent process"
            ref={detailRef}
            tabIndex={0}
          >
            <div className="proc-head">
              <Avatar
                name={selectedAgent?.name ?? "Agent"}
                id={selected.agent_id}
                kind={selectedAgent?.kind}
              />
              <div className="proc-head-copy">
                <strong>{selectedAgent?.name ?? "Unknown agent"}</strong>
                <span>
                  #{selectedChannel?.name ?? "channel"} · {duration(selected, now)}
                </span>
              </div>
              <span className={`run-chip ${selected.status}`}>
                <span className="run-chip-dot" />
                {selected.status}
              </span>
              {selected.status === "running" && (
                <button className="btn tiny" onClick={() => void cancelRun(selected.id)}>
                  <IconX size={11} /> Stop
                </button>
              )}
              <button className="btn tiny" onClick={() => setInspectId(selected.id)}>
                <IconInfo size={11} /> Inspect
              </button>
            </div>

            <div className="proc-facts">
              <span>
                <b>model</b> {selected.model || selectedAgent?.model || "default"}
              </span>
              <span>
                <b>effort</b> {selected.effort || "default"}
              </span>
              <span title={selected.cwd}>
                <b>cwd</b> {selected.cwd || "none"}
              </span>
            </div>

            <div className="proc-command" title={selected.command}>
              <span>$</span>
              <code>{selected.command || selectedAgent?.kind || "agent"}</code>
            </div>

            {/* The running cursor was a literal ▌ appended to the text. Being
                text, it was also part of anything the user selected and copied,
                and it is a glyph doing an element's job. It is now an element. */}
            <pre className="proc-output" aria-label="Live process output">
              {output}
              {selected.status === "running" && <span className="proc-tail" aria-hidden="true" />}
            </pre>

            <details className="proc-prompt">
              <summary>Launch prompt</summary>
              <pre>{selected.prompt}</pre>
            </details>
          </section>
        )}
      </div>

      {inspectId && <RunInspector runId={inspectId} onClose={() => setInspectId("")} />}
    </>
  );
}
