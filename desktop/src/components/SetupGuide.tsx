/**
 * Onboarding, and the honest story about where agents actually run.
 *
 * The failure this file exists to prevent: someone opens Spaces, reads
 * "claude — not found", and concludes the app is broken or that they have
 * to install something before they can do anything. Neither is true. Agents
 * belong to the workspace and everyone can use anyone's; a runtime on THIS
 * machine only decides whether you can HOST one. So nothing here is painted
 * as an error, "not found" is neutral, and every install path says out loud
 * that one runtime is enough.
 *
 * Detection is deliberately two different mechanisms, because the runtimes
 * are: claude/codex/gh are binaries on PATH (the Rust `check_tools`), Ritz is
 * an HTTP service that either answers on 127.0.0.1:8765 or does not.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { getDb } from "../db";
import { toast } from "../toast";
import { fetchRitzModels, RITZ_BASE } from "../capabilities";
import { config } from "../config";
import { Spinner } from "./ui";
import { IconBolt, IconCheck, IconGitHub } from "./icons";
import "./setup.css";

/* ── runtime facts ────────────────────────────────────────────── */

interface RuntimeSpec {
  id: "claude" | "codex";
  name: string;
  /** What Spaces looks for on PATH. */
  bin: string;
  /** What this one is good at — the reason to pick it over the other. */
  good: string;
  install: string;
  /** How it authenticates. Never an API key; that is the point. */
  auth: string;
  docs: string;
  docsLabel: string;
}

const RUNTIMES: RuntimeSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    good:
      "Long multi-file work inside a repo — reads, edits, runs commands, and reports back what it did.",
    install: "npm install -g @anthropic-ai/claude-code",
    auth: "The first run signs you in with your Claude subscription.",
    docs: "https://docs.claude.com/en/docs/claude-code/overview",
    docsLabel: "docs.claude.com",
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    good:
      "OpenAI's CLI — sandboxed by default, at home on tightly scoped changes and quick reviews.",
    install: "npm install -g @openai/codex",
    auth: "Sign in once with your ChatGPT account.",
    docs: "https://github.com/openai/codex",
    docsLabel: "github.com/openai/codex",
  },
];

/* ── clipboard ────────────────────────────────────────────────── */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Webviews can refuse the async clipboard without a user-gesture heuristic
    // we control; the selection trick still goes through.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyLine({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const run = async () => {
    if (!(await copyText(cmd))) {
      toast.warn("Could not reach the clipboard", "Select the command and copy it by hand.");
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="cmdline">
      <code className="cmdline-text">{cmd}</code>
      <button
        type="button"
        className="cmdline-copy"
        onClick={() => void run()}
        aria-label={`Copy "${cmd}" to the clipboard`}
      >
        {copied ? <IconCheck size={12} /> : null}
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="setup-sr" role="status">
        {copied ? `Copied ${cmd}` : ""}
      </span>
    </div>
  );
}

/* ── status atoms ─────────────────────────────────────────────── */

type Tone = "ok" | "idle" | "wait";

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`rt-pill ${tone}`}>{children}</span>;
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={`rt-dot ${tone}`} aria-hidden="true" />;
}

/**
 * Optional detail, folded away. The summary row's flex layout lives one
 * element in: styling <summary> itself as a flex box costs it the disclosure
 * semantics in WebKit, which is the browser Spaces actually ships on.
 */
function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="rt-more">
      <summary>
        <span className="rt-sum">{summary}</span>
      </summary>
      <div className="rt-more-body">{children}</div>
    </details>
  );
}

/** One detected thing, stated once and quietly. */
function StatusRow({
  name,
  bin,
  note,
  tone,
  state,
}: {
  name: string;
  bin?: string;
  note: string;
  tone: Tone;
  state: string;
}) {
  return (
    <div className="rt-row">
      <Dot tone={tone} />
      <span className="rt-row-name">{name}</span>
      {bin && <code className="rt-bin">{bin}</code>}
      <span className="rt-row-note">{note}</span>
      <Pill tone={tone}>{state}</Pill>
    </div>
  );
}

/** The install path for a runtime you do not have. Never phrased as a lack. */
function RuntimeCard({ spec }: { spec: RuntimeSpec }) {
  return (
    <div className="rt-card">
      <div className="rt-card-head">
        <Dot tone="idle" />
        <span className="rt-card-name">{spec.name}</span>
        <code className="rt-bin">{spec.bin}</code>
        <Pill tone="idle">not found</Pill>
      </div>
      <p className="rt-card-good">{spec.good}</p>
      <CopyLine cmd={spec.install} />
      <p className="rt-card-auth">
        {spec.auth} Spaces never asks for an API key.{" "}
        <a href={spec.docs} target="_blank" rel="noreferrer">
          {spec.docsLabel}
        </a>
      </p>
    </div>
  );
}

/* ── Ritz probe ───────────────────────────────────────────────── */

interface RitzProbe {
  state: "checking" | "up" | "down";
  models: number;
}

/**
 * Ritz is not on PATH, so PATH detection cannot see it: the only truthful
 * answer is whether the engine replies right now. GET /models is the cheapest
 * question it answers.
 */
function useRitzProbe(): [RitzProbe, () => void] {
  const [probe, setProbe] = useState<RitzProbe>({ state: "checking", models: 0 });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    // A dead port refuses instantly; the timeout is for the other case —
    // something else holding 8765 and never answering.
    const timer = window.setTimeout(() => ac.abort(), 2500);
    setProbe((p) => ({ ...p, state: "checking" }));

    fetchRitzModels(ac.signal).then(
      (list) => {
        if (live) setProbe({ state: "up", models: list.models.length });
      },
      () => {
        if (live) setProbe({ state: "down", models: 0 });
      }
    );

    return () => {
      live = false;
      clearTimeout(timer);
      ac.abort();
    };
  }, [nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return [probe, recheck];
}

/* ── the guide ────────────────────────────────────────────────── */

export function SetupGuide() {
  const tools = useStore((s) => s.tools);
  const [checking, setChecking] = useState(false);
  const [ritz, recheckRitz] = useRitzProbe();

  const installed = RUNTIMES.filter((r) => !!tools[r.id]);
  const missing = RUNTIMES.filter((r) => !tools[r.id]);
  const gh = !!tools.gh;
  const host = RITZ_BASE.replace("http://", "");

  const recheck = useCallback(async () => {
    setChecking(true);
    recheckRitz();
    try {
      const found = await invoke<Record<string, boolean>>("check_tools");
      useStore.setState({ tools: found });
    } catch (e) {
      toast.error("Could not read this machine's PATH", e);
    } finally {
      setChecking(false);
    }
  }, [recheckRitz]);

  return (
    <section className="dash-card setup-guide">
      <h3>
        Runtimes
        <button
          type="button"
          className="btn tiny rt-recheck"
          onClick={() => void recheck()}
          disabled={checking}
        >
          {checking && <Spinner />}
          {checking ? "Checking…" : "Re-check"}
        </button>
      </h3>

      <p className="rt-lede">
        Agents belong to this workspace, not to a person — everyone here can use anyone's.
        Each one wraps a runtime on somebody's machine: the <code>claude</code> or{" "}
        <code>codex</code> CLI, a Custom CLI, or {config().localAiName} over HTTP. It answers while its host device is
        online.
      </p>
      <p className="rt-lede">
        <strong>You need none of this installed to use the workspace's agents.</strong> A
        runtime here only lets you host an agent of your own — on your own subscription. Spaces
        never asks for an API key.
      </p>

      {/* Neither: a choice, not a checklist. */}
      {installed.length === 0 && (
        <div className="rt-group">
          <p className="rt-note">
            Nothing on this machine yet, which is fine. To host an agent here, pick either
            runtime below — <strong>one is enough</strong>, and Spaces drives them the same way.
          </p>
          <div className="rt-choice">
            <RuntimeCard spec={RUNTIMES[0]} />
            <span className="rt-or" aria-hidden="true">
              or
            </span>
            <RuntimeCard spec={RUNTIMES[1]} />
          </div>
          <p className="rt-foot">
            Both install through npm, so they need Node on your PATH. Afterwards hit Re-check;
            if it still says not found, restart Spaces so it picks up the changed PATH.
          </p>
        </div>
      )}

      {/* Exactly one: confirm, then get out of the way. */}
      {installed.length === 1 && (
        <div className="rt-group">
          <StatusRow
            name={installed[0].name}
            bin={installed[0].bin}
            note="You can host agents on this machine."
            tone="ok"
            state="detected"
          />
          <Fold summary={`${missing[0].name} as well? Optional — you are already set up.`}>
            <RuntimeCard spec={missing[0]} />
          </Fold>
        </div>
      )}

      {/* Both: one line, folded away. */}
      {installed.length === 2 && (
        <div className="rt-group">
          <Fold
            summary={
              <>
                <Dot tone="ok" />
                Both runtimes detected — this machine can host agents.
              </>
            }
          >
            {RUNTIMES.map((r) => (
              <StatusRow
                key={r.id}
                name={r.name}
                bin={r.bin}
                note={r.good}
                tone="ok"
                state="detected"
              />
            ))}
          </Fold>
        </div>
      )}

      {/* GitHub CLI — nothing to do with agents, and says so. */}
      <div className="rt-group">
        {gh ? (
          <Fold
            summary={
              <>
                <Dot tone="ok" />
                GitHub CLI detected — the dashboard can read your PRs and issues.
              </>
            }
          >
            <p className="rt-card-good">
              If the dashboard still says GitHub is unavailable, <code>gh</code> is installed but
              not signed in.
            </p>
            <CopyLine cmd="gh auth login" />
          </Fold>
        ) : (
          <div className="rt-card">
            <div className="rt-card-head">
              <span className="rt-card-icon" aria-hidden="true">
                <IconGitHub size={14} />
              </span>
              <span className="rt-card-name">GitHub CLI</span>
              <code className="rt-bin">gh</code>
              <Pill tone="idle">not found</Pill>
            </div>
            <p className="rt-card-good">
              Optional. The dashboard, PR lists and issue lists read GitHub through{" "}
              <code>gh</code>. Agents do not need it.
            </p>
            <CopyLine cmd="brew install gh" />
            <CopyLine cmd="gh auth login" />
            <p className="rt-card-auth">
              Homebrew is the macOS route; other platforms have their own package.{" "}
              <a href="https://cli.github.com" target="_blank" rel="noreferrer">
                cli.github.com
              </a>
            </p>
          </div>
        )}
      </div>

      {/* Ritz — a service, not a CLI. Nothing to install from here. */}
      <div className="rt-group">
        {ritz.state === "up" ? (
          <Fold
            summary={
              <>
                <Dot tone="ok" />
                {config().localAiName} is answering on {host}
                {ritz.models > 0 && ` — ${ritz.models} model${ritz.models === 1 ? "" : "s"}`}.
              </>
            }
          >
            <p className="rt-card-good">
              Your configured on-device engine, reached over local HTTP. Local HTTP agents run
              here, with no CLI and no cloud round-trip.
            </p>
          </Fold>
        ) : (
          <Fold
            summary={
              <>
                <Dot tone={ritz.state === "checking" ? "wait" : "idle"} />
                {ritz.state === "checking"
                  ? `Looking for ${config().localAiName} on ${host}…`
                  : `${config().localAiName} is not running — optional, and nothing to install from here.`}
              </>
            }
          >
            <p className="rt-card-good">
              {config().localAiName} is a local engine rather than a CLI, so it never appears on your PATH. Start
              it and Spaces picks it up at the address below on the next re-check.
            </p>
            <CopyLine cmd={RITZ_BASE} />
          </Fold>
        )}
      </div>
    </section>
  );
}

/* ── first-run checklist ──────────────────────────────────────── */

interface Step {
  id: string;
  title: string;
  hint: string;
  done: boolean;
  /** null when the step cannot be acted on yet. */
  run: (() => void) | null;
}

/**
 * The New-project modal is Sidebar-local state with no store handle, and
 * Sidebar belongs to another file — so its own button is the honest way in.
 * Returns false rather than pretending when the markup has moved.
 */
function openNewProject(): boolean {
  const btn = document.querySelector<HTMLElement>(
    '.sidebar .nav-heading .icon-btn[title="New project"]'
  );
  btn?.click();
  return !!btn;
}

/**
 * A four-step card for a workspace nobody has finished setting up. Every step
 * reads real rows, so a teammate who already added an agent ticks that step
 * for you — which is the communal model working, not a bug.
 *
 * Renders nothing once all four are done, including on every later launch.
 */
export function FirstRunChecklist() {
  const uid = useId();
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const channels = useStore((s) => s.channels);
  const channelMembers = useStore((s) => s.channelMembers);
  const sessions = useStore((s) => s.sessions);
  const messages = useStore((s) => s.messages);
  const setView = useStore((s) => s.setView);

  // "Has an agent ever replied here" outlives the session, but messages load
  // per channel on demand — so the store cannot answer it at launch and the
  // card would nag people who finished months ago. One count settles it.
  // null = not answered yet; the card stays hidden rather than flashing.
  const [everReplied, setEverReplied] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const db = await getDb();
        const rows = await db.select<{ n: number }[]>(
          "SELECT COUNT(*) AS n FROM messages WHERE author_type = 'agent'"
        );
        if (live) setEverReplied((rows[0]?.n ?? 0) > 0);
      } catch {
        if (live) setEverReplied(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const staffed = channelMembers.filter(
    (m) => m.member_type === "agent" || m.member_type === "team"
  );
  const talkChannel =
    channels.find((c) => staffed.some((m) => m.channel_id === c.id)) ?? channels[0];

  const replied =
    everReplied === true ||
    sessions.length > 0 ||
    Object.values(messages).some((list) => list.some((m) => m.author_type === "agent"));

  const steps: Step[] = [
    {
      id: "agent",
      title: "Add an agent",
      hint: "A named Claude Code, Codex, local HTTP, or Custom CLI teammate. It runs on whichever machine hosts it.",
      done: agents.length > 0,
      run: () => setView({ type: "agents" }),
    },
    {
      id: "project",
      title: "Create a project",
      hint: "Point it at a repo and a local checkout — that checkout is where its agents work.",
      done: projects.length > 0,
      run: () => {
        if (!openNewProject()) {
          toast.info("Use the ＋ next to Projects", "It is in the sidebar, above your channels.");
        }
      },
    },
    {
      id: "member",
      title: "Add the agent to a channel",
      hint: "Agents only hear the channels they are in. Open one and use the ⚉ roster button.",
      done: staffed.length > 0,
      run: talkChannel ? () => setView({ type: "channel", channelId: talkChannel.id }) : null,
    },
    {
      id: "talk",
      title: "Talk to it",
      hint: "@mention it and send. It replies while its host device is online.",
      done: replied,
      run: talkChannel ? () => setView({ type: "channel", channelId: talkChannel.id }) : null,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  // Hidden until the count comes back, so a settled workspace never sees a flash.
  if (everReplied === null || doneCount === steps.length) return null;

  return (
    <section className="dash-card first-run">
      <h3>
        Get set up{" "}
        <span className="fr-count">
          {doneCount} of {steps.length}
        </span>
        <span className="fr-bar" aria-hidden="true">
          <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </span>
      </h3>
      <p className="fr-lede">
        Agents are shared here — anything a teammate already set up counts for you too.
      </p>
      <ol className="fr-steps">
        {steps.map((s, i) => (
          <li key={s.id}>
            {/* aria-disabled, not disabled: a step you cannot act on yet still
                has the hint that says why, and must stay reachable to read.
                The name carries the state; the hint rides along as description
                so it is heard once, not folded into the button's name. */}
            <button
              type="button"
              className={"fr-step" + (s.done ? " done" : "")}
              aria-disabled={!s.run}
              aria-label={`Step ${i + 1}: ${s.title}${s.done ? " — done" : ""}`}
              aria-describedby={`${uid}-${s.id}`}
              onClick={() => s.run?.()}
            >
              <span className="fr-tick" aria-hidden="true">
                {s.done ? <IconCheck size={11} /> : i + 1}
              </span>
              <span className="fr-body">
                <span className="fr-title">{s.title}</span>
                <span className="fr-hint" id={`${uid}-${s.id}`}>
                  {s.hint}
                </span>
              </span>
              <span className="fr-go">
                {s.done ? "Done" : null}
                {!s.done && s.run && (
                  <span className="fr-arrow" aria-hidden="true">
                    →
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="fr-foot">
        <IconBolt size={12} />
        No CLI on this machine? You can still use agents your teammates host — see Settings →
        Runtimes.
      </p>
    </section>
  );
}
