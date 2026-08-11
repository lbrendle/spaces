/**
 * First run.
 *
 * This is the first thing anybody sees, on every device, and *everybody* in a
 * communal workspace goes through it — not just whoever installed the app. It
 * used to be written for whoever installed it: it asked for a checkout, handed
 * out a list of engineering roles to pick from, and explained PATH. Somebody
 * who came here for channels, a calendar, a knowledge base and an assistant
 * could not get past the third screen.
 *
 * So the shape is now: say hello, ask what they came for, and only then decide
 * which steps exist. Seven rules, none of which may be softened:
 *
 *   Nothing blocks. There is no network, no installed app and no paired
 *   workspace on a cold machine, and all three are legitimate end states.
 *   Every step offers the real thing and a truthful "later", never a wall.
 *
 *   Nothing pretends. A step ticks because a row exists, not because somebody
 *   walked past it. Resuming re-reads the store, so an agent deleted in the
 *   meantime is un-made here too.
 *
 *   Nothing is invented for you. There are no personas in this file. A person
 *   writes their own teammate's name, role, ownership and standing
 *   instructions, and their own team names and charters. Placeholders show the
 *   SHAPE of a good answer; not one of them is ever a value.
 *
 *   Nothing already true is asked for again. If the machine already has the
 *   app, say so and move on. If the workspace already has agents, using one of
 *   them leads and authoring another is the second option. If this is the same
 *   person's second machine, say that too.
 *
 *   Nothing is named after us. "Claude Code" and "Codex" are products and
 *   stay. "harness", "runtime", "PATH", "worktree", "checkout" are ours: gone
 *   from the coordinating path entirely, and on the building path they live
 *   inside a "what this means" disclosure, never in a sentence you must read.
 *
 *   Nothing that is a list is drawn as a fork. The apps a teammate can work
 *   inside used to be posed as a choice — pick one, one is enough — which is
 *   the wrong question for somebody who has all three. They are a checklist:
 *   all three at once, each with its real state, set up as many as you like in
 *   one pass. And because Ritz answers over HTTP rather than from a PATH, it
 *   is asked directly; it is never called missing on evidence that cannot see
 *   it. Making a second teammate adds a row to the panel you are already on,
 *   because "and now another one" must never mean starting over.
 *
 *   Nothing dead-ends. Every step says what its button does and what that
 *   costs, in the same place every time; the button is never the only thing
 *   that could be pressed, is never disabled on arrival, and nothing you have
 *   to know is behind a hover.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { config, normalizeBaseUrl, setConfig } from "../config";
import { colorFor, slug } from "../types";
import type { Agent, Device, Member } from "../types";
import { harnessFor, defaultsFor, serializeArgs } from "../capabilities";
import type { HarnessKind } from "../capabilities";
import { agentIdentity } from "../entities";
import { timeAgo } from "../github";
import { isGitRepo } from "../workspaces";
import { loadPortalConnection } from "../portal";
import { browserPlatform, currentPlatform } from "../deviceIdentity";
import { toast } from "../toast";
import { EntityChip } from "./EntityChip";
import { RadioChips } from "./LinkPicker";
import { Avatar, Spinner } from "./ui";
import {
  IconArrowRight,
  IconBolt,
  IconCheck,
  IconInfo,
  IconLogo,
  IconPlus,
  IconRefresh,
  IconX,
} from "./icons";
import "./onboarding.css";
import {
  currentDeviceId as localDeviceId,
  rememberDeviceId as rememberLocalDevice,
} from "../deviceIdentity";

/* ── what gets remembered ─────────────────────────────────────── */

/**
 * Namespaced, and versioned. v2 rather than v1 because the step list is no
 * longer one fixed sequence — a saved v1 index would resume somebody in the
 * middle of a path they never chose.
 */
const STATE_KEY = "spaces.onboarding.v2";

/**
 * Which device row is *this* machine. The People roster owns this key and
 * offers to register the machine whenever it is unset — so onboarding has to
 * write it too, or finishing here leaves that roster still asking, and saying
 * yes twice would produce two rows for one laptop.
 */

/** Broadcast so `useNeedsOnboarding` re-reads without a reload. */
const CHANGED_EVENT = "hq:onboarding-change";

/**
 * Which set of steps somebody gets.
 *
 * It grants nothing and withholds nothing: every feature is reachable from
 * both, and switching costs one click. All it decides is which steps run and
 * which words they use — which is the whole difference between a workspace
 * that makes sense to you and one that talks about worktrees.
 */
type Track = "build" | "coordinate";

interface SavedState {
  status: "active" | "done";
  /** '' until the fork is answered. */
  track: Track | "";
  /** Where to resume, as an index into that track's steps. */
  step: number;
  /** Rows this run created or adopted, so a resume picks them up again. */
  deviceId: string;
  /**
   * Every teammate this run set up, in the order they arrived. A list rather
   * than one id because the teammate step is a panel you keep adding to, and a
   * run that produced three of them must resume showing three.
   */
  agentIds: string[];
  /** The subset of `agentIds` written here rather than adopted from the roster. */
  authoredIds: string[];
  teamId: string;
  projectId: string;
  channelId: string;
  updatedAt: number;
}

const BLANK: SavedState = {
  status: "active",
  track: "",
  step: 0,
  deviceId: "",
  agentIds: [],
  authoredIds: [],
  teamId: "",
  projectId: "",
  channelId: "",
  updatedAt: 0,
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v) : [];
}

function readState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    // A run saved before the teammate step became a panel holds one id under
    // `agentId`. Reading it forward is a line of code; dropping it would lose
    // somebody's teammate on the resume, which is the one thing a saved run is
    // for — so the key stays readable even though nothing writes it any more.
    const legacy = parsed as { agentId?: unknown; authored?: unknown };
    const one = typeof legacy.agentId === "string" && legacy.agentId ? [legacy.agentId] : [];
    const agentIds = parsed.agentIds ? strings(parsed.agentIds) : one;
    const authoredIds = parsed.authoredIds
      ? strings(parsed.authoredIds)
      : legacy.authored === true
        ? one
        : [];
    return {
      ...BLANK,
      ...parsed,
      status: parsed.status === "done" ? "done" : "active",
      track: parsed.track === "build" || parsed.track === "coordinate" ? parsed.track : "",
      step: typeof parsed.step === "number" ? parsed.step : 0,
      agentIds,
      authoredIds: authoredIds.filter((id) => agentIds.includes(id)),
    };
  } catch {
    // A locked-down or corrupt store just means this run is not resumable.
    return null;
  }
}

function writeState(next: SavedState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...next, updatedAt: Date.now() }));
  } catch {
    // Private mode: the wizard still works, it just forgets between launches.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

/**
 * Run setup again, from Settings.
 *
 * It writes a fresh active run rather than deleting the key: by then this
 * machine is registered, and "has this machine been through it" is answered by
 * the saved run, so removing the key would simply leave the wizard hidden.
 */
export function restartOnboarding(): void {
  writeState({ ...BLANK });
}

/* ── who needs this ───────────────────────────────────────────── */

/**
 * Whether to show the wizard.
 *
 * Onboarding is per *device*, not per workspace. A teammate joining on their
 * own Mac, or the same person on a second one, still has to register the
 * machine and meet whoever is already on the roster — and the store they open
 * is already full, so "is this workspace empty" is the wrong question. What is
 * asked instead is "has this machine been through it", which the saved run and
 * the local device row answer between them.
 */
export function useNeedsOnboarding(): boolean {
  const loaded = useStore((s) => s.loaded);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);
  const [saved, setSaved] = useState<SavedState | null>(() => readState());

  useEffect(() => {
    const sync = () => setSaved(readState());
    window.addEventListener(CHANGED_EVENT, sync);
    // Another window of the same app finishing setup counts too.
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Never decide before the database has answered: a flash of the wizard over
  // a populated workspace is worse than a beat of nothing.
  if (!loaded) return false;
  if (saved) return saved.status !== "done";
  // An unregistered machine is either a fresh install or somebody's second one.
  if (!localDeviceId()) return true;
  return projects.length === 0 && agents.length === 0;
}

/* ── steps ────────────────────────────────────────────────────── */

type StepId = "welcome" | "you" | "machine" | "team" | "project" | "connect" | "done";

interface StepSpec {
  id: StepId;
  label: string;
}

/**
 * The two sequences. They share the frame, the persistence and most of the
 * screens; what differs is that one talks about a folder of code and the apps
 * that work inside it, and the other never mentions either — because a project
 * here is a place with channels, tasks, memory and a calendar, and only a
 * developer's project also needs a repository.
 */
const SEQUENCES: Record<Track, readonly StepSpec[]> = {
  build: [
    { id: "welcome", label: "Welcome" },
    { id: "you", label: "You" },
    { id: "machine", label: "This machine" },
    { id: "team", label: "Your team" },
    { id: "project", label: "Project" },
    { id: "connect", label: "Connections" },
    { id: "done", label: "Done" },
  ],
  coordinate: [
    { id: "welcome", label: "Welcome" },
    { id: "you", label: "You" },
    { id: "team", label: "Your team" },
    { id: "project", label: "Your work" },
    { id: "done", label: "Done" },
  ],
};

/**
 * A saved run can hold '' — that is what the stored shape allows — but the
 * wizard resolves it on the very first render, so no screen is ever drawn
 * without a sequence behind it. This is where the two facts meet.
 */
function trackOf(saved: SavedState): Track {
  return saved.track || "coordinate";
}

function sequenceFor(track: Track): readonly StepSpec[] {
  return SEQUENCES[track];
}

/** "Step 2 of 3" — welcome and done are not steps anybody has to do. */
function kickerFor(steps: readonly StepSpec[], index: number): string {
  return `Step ${index} of ${Math.max(1, steps.length - 2)}`;
}

/* ── machine facts ────────────────────────────────────────────── */

function machineGuess(platform: string): string {
  if (/mac|iphone|ipad/i.test(platform)) return "This Mac";
  if (/win/i.test(platform)) return "This PC";
  if (/linux/i.test(platform)) return "This Linux box";
  return "This machine";
}

/** The noun for this machine, for sentences people actually read. */
function machineWord(platform: string): string {
  if (/mac|iphone|ipad/i.test(platform)) return "Mac";
  if (/win/i.test(platform)) return "PC";
  return "machine";
}

/** A device row's reported tool map. Nonsense in means nothing out. */
function parseTools(raw: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) out[k] = v === true;
    return out;
  } catch {
    return {};
  }
}

/**
 * How long a machine may go quiet before its agents are called unavailable.
 * Deliberately the same hour the chat composer uses — two different answers to
 * "is Ada up" is how you end up arguing with your own app.
 */
const HOST_WINDOW = 60 * 60_000;

/**
 * Who a teammate belongs to and where it works. types.ts declares all three
 * columns now, so this is the real type — nothing here widens or casts, and
 * every teammate authored in this file sets all three rather than leaving the
 * roster to guess.
 */
type AgentVisibility = Agent["visibility"];

/* ── can it actually answer ───────────────────────────────────── */

interface Availability {
  tone: "ok" | "idle";
  text: string;
}

/**
 * Whether an agent can work right now, in one plain sentence.
 *
 * Finding out that the teammate you just picked has been asleep since Tuesday
 * *when it fails to answer you* is the worst possible moment, so every card
 * that offers one says this first. Never red: a sleeping laptop is not a fault.
 */
function availabilityOf(
  agent: Agent,
  devices: Device[],
  tools: Record<string, boolean>,
  hereId: string
): Availability {
  const app = harnessFor(agent.kind).label;
  // The local engine answers over the network on whichever machine runs it, so
  // it has no app to look for and no other machine to be asleep.
  if (agent.kind === "ritz") return { tone: "ok", text: "Works on this machine." };

  const host = agent.host_device_id ? devices.find((d) => d.id === agent.host_device_id) : undefined;
  if (!host) {
    return {
      tone: "idle",
      text: "No machine set to work on yet, so it cannot answer until one is chosen.",
    };
  }
  if (host.id === hereId) {
    // `undefined` means detection has not answered yet, which is not the same
    // as a missing app — an unknown never becomes a warning.
    return tools[agent.kind] === false
      ? { tone: "idle", text: `Works here, but ${app} is not on this machine yet.` }
      : { tone: "ok", text: "Works on this machine." };
  }
  if (parseTools(host.tools)[agent.kind] === false) {
    return { tone: "idle", text: `${host.name} has not got ${app}, so it cannot work there.` };
  }
  // Without a local device row every timestamp looks stale, including this
  // machine's own — so staleness only speaks when we know which row is not us.
  if (hereId && Date.now() - host.last_seen_at > HOST_WINDOW) {
    return {
      tone: "idle",
      text: `Works on ${host.name}, ${
        host.last_seen_at ? `last awake ${timeAgo(host.last_seen_at)}` : "never seen awake"
      } — it answers only while that machine is awake.`,
    };
  }
  return { tone: "ok", text: `Works on ${host.name}, which is awake.` };
}

/* ── what this workspace already is ───────────────────────────── */

interface Situation {
  me: Member;
  /** The device row for this machine, when it already exists. */
  here: Device | null;
  /** Agents that were here before this run — the ones worth using. */
  existing: Agent[];
  /** This person has a workspace already; this machine is new to it. */
  returning: boolean;
}

/**
 * Reading the room before saying anything.
 *
 * `mine` is every teammate this run adopted or wrote, and all of them are kept
 * out of `existing` so the roster never offers somebody their own work back —
 * which matters more now that a run can produce three of them.
 */
function useSituation(mine: readonly string[]): Situation {
  const members = useStore((s) => s.members);
  const devices = useStore((s) => s.devices);
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const me = members.find((m) => m.is_self === 1) ?? useStore.getState().self();

  const here = devices.find((d) => d.id === localDeviceId()) ?? null;
  const existing = agents.filter((a) => !mine.includes(a.id));
  const elsewhere = devices.some((d) => d.member_id === me.id && d.id !== here?.id);

  return {
    me,
    here,
    existing,
    returning: !here && (elsewhere || agents.length > 0 || projects.length > 0),
  };
}

/* ── the apps a teammate can work inside ──────────────────────── */

interface AppSpec {
  kind: HarnessKind;
  good: string;
  signin: string;
  /**
   * The one line that puts it on this machine, for the CLI ones. Ritz has none
   * on purpose: it is a service you already run, not something npm installs, so
   * printing a command would be inventing one.
   */
  install?: string;
  /** What to do when it is absent — the whole of it, in one sentence. */
  absent: string;
}

/**
 * All three, always, in a fixed order.
 *
 * These are product names people already have accounts with, and the list is
 * never filtered down to "the one we think you want": somebody with all three
 * installed is entitled to set up all three, and somebody with none still gets
 * told they can work with other people's. Only the *state* of a row changes.
 */
const APPS: readonly AppSpec[] = [
  {
    kind: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    good: "Long multi-file work inside a folder — reads, edits, runs things, reports back.",
    signin: "It signs in with your own Claude subscription the first time it runs.",
    absent: "Install it with the line below, then run it once to sign in.",
  },
  {
    kind: "codex",
    install: "npm install -g @openai/codex",
    good: "Sandboxed by default, at home on tightly scoped changes and quick reviews.",
    signin: "It signs in with your own ChatGPT account the first time it runs.",
    absent: "Install it with the line below, then run it once to sign in.",
  },
  {
    kind: "ritz",
    good: "Runs on this machine and nowhere else — nothing leaves it, and it needs no account.",
    signin: "There is no account and no sign-in: it is already yours.",
    absent:
      "Start the engine, then check again. If it listens somewhere else, put that address in Settings and this will find it.",
  },
];

/* ── is each of them actually here ────────────────────────────── */

/**
 * What is known about one app right now.
 *
 * "absent" is only ever said on evidence that could have found the thing.
 * `checking` exists because the answer for Ritz arrives over the network, and a
 * spinner is honest where a premature "not here" is not.
 */
type Presence = "here" | "checking" | "absent";

/**
 * Whether the local engine is answering.
 *
 * Ritz is reached over HTTP, so PATH detection is structurally blind to it:
 * `check_tools` looks for `claude`, `codex` and `gh` and will never report a
 * fourth, and calling Ritz missing on that evidence would be a plain untruth.
 * The only question that can be answered is whether it replies *now*, so ask
 * it — GET /models is the cheapest thing it answers.
 *
 * The address is read from config() per probe rather than captured once,
 * because it is a runtime setting somebody can change in Settings while this
 * screen is open.
 */
function useRitzProbe(): { state: Presence; url: string; recheck: () => void } {
  const [state, setState] = useState<Presence>("checking");
  const [nonce, setNonce] = useState(0);
  const url = config().localAiUrl;

  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    // A dead port refuses immediately; this timeout is for the other case —
    // something else holding it open and never answering.
    const timer = window.setTimeout(() => ac.abort(), 2500);
    setState("checking");
    fetch(`${url}/models`, { signal: ac.signal }).then(
      (res) => live && setState(res.ok ? "here" : "absent"),
      () => live && setState("absent")
    );
    return () => {
      live = false;
      clearTimeout(timer);
      ac.abort();
    };
  }, [url, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { state, url, recheck };
}

/** The host:port of the engine, for a sentence. The scheme is noise here. */
function ritzHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Every app with its state, in one place, so the checklist and the teammate
 * form cannot disagree about what this machine has.
 */
function presenceOf(
  kind: HarnessKind,
  tools: Record<string, boolean>,
  ritz: Presence
): Presence {
  // Ritz is never answered from `tools`: check_tools cannot see it.
  return kind === "ritz" ? ritz : tools[kind] ? "here" : "absent";
}

/** The state of a row, in the fewest words that are still true. */
function presenceWord(kind: HarnessKind, state: Presence): string {
  if (state === "checking") return "checking…";
  if (state === "here") return kind === "ritz" ? "answering" : "already here";
  return kind === "ritz" ? "not answering" : "not here yet";
}

/* ── small shared pieces ──────────────────────────────────────── */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Webviews can refuse the async clipboard on a heuristic we do not control;
    // the old selection trick still goes through.
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

/** `prose` is for a sentence rather than a command: it wraps instead of scrolling. */
function CopyBlock({ cmd, prose }: { cmd: string; prose?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  async function run() {
    if (!(await copyText(cmd))) {
      toast.warn("Could not reach the clipboard", "Select the text and copy it by hand.");
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={"ob-cmd" + (prose ? " ob-cmd-prose" : "")}>
      <code className="ob-cmd-text">{cmd}</code>
      <button
        type="button"
        className="ob-cmd-copy"
        onClick={() => void run()}
        aria-label={`Copy "${cmd}" to the clipboard`}
      >
        {copied ? <IconCheck size={11} /> : null}
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="ob-sr" role="status">
        {copied ? `Copied ${cmd}` : ""}
      </span>
    </div>
  );
}

/**
 * Where our vocabulary is allowed to live.
 *
 * Somebody who wants to know that "its own copy of the folder" means a git
 * worktree deserves to be told — but they can ask for it, and the person who
 * has never heard the word must not have to read past it to finish setting up.
 */
function Aside({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="ob-aside">
      <summary>{title}</summary>
      <div className="ob-aside-body">{children}</div>
    </details>
  );
}

/**
 * A labelled control. The hint sits *outside* the label on purpose: inside, it
 * becomes part of the field's accessible name, and "Instructions, prepended to
 * everything it is asked, say how it should work…" is a terrible name for a
 * box you are about to type in.
 */
function Labelled({
  label,
  hint,
  children,
  count,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  /** Scale of what is written so far, when the size of the answer matters. */
  count?: ReactNode;
}) {
  return (
    <div className="ob-field">
      <label>
        <span className="ob-label">
          {label}
          {count !== undefined && <span className="ob-count">{count}</span>}
        </span>
        {children}
      </label>
      {hint && <span className="ob-hint">{hint}</span>}
    </div>
  );
}

/** Same swatch ramp the roster uses, so a colour chosen here reads there. */
function ColorPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const group = useId();
  const options = ["", ...Array.from({ length: 8 }, (_, i) => `var(--avatar-${i})`)];
  return (
    <fieldset className="ob-colors">
      <legend className="ob-label">Colour</legend>
      <div className="ob-swatches">
        {options.map((option) => {
          const auto = option === "";
          return (
            <label
              key={option || "auto"}
              className={"ob-swatch" + (option === value ? " ob-swatch-on" : "")}
              title={auto ? "Follow the theme's own hashed colour" : "Use this colour"}
            >
              <input
                className="ob-sr"
                type="radio"
                name={group}
                checked={option === value}
                onChange={() => onChange(option)}
              />
              <span
                className="ob-swatch-dot"
                style={{ background: auto ? colorFor(id) : option }}
                aria-hidden="true"
              />
              <span className="ob-sr">{auto ? "Automatic colour" : `Colour ${option}`}</span>
              {auto && (
                <span className="ob-swatch-auto" aria-hidden="true">
                  A
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A settled fact, stated once. Never red: an absence here is not a fault. */
function Fact({ tone, children }: { tone: "ok" | "idle"; children: ReactNode }) {
  return (
    <p className={`ob-fact ob-fact-${tone}`}>
      <span className="ob-dot" aria-hidden="true" />
      {children}
    </p>
  );
}

/* ── step frame ───────────────────────────────────────────────── */

interface StepProps {
  onNext: () => void;
  onBack: (() => void) | null;
  /** The building path. Decides vocabulary, and which fields exist at all. */
  dev: boolean;
  kicker: string;
}

/**
 * One step. The form is what makes Enter advance without a key handler
 * anywhere: a textarea keeps its newlines, every other field submits.
 *
 * Only the prose scrolls — the actions row is pinned below it, so the way
 * forward sits in the same place on a two-line step and on the authoring one.
 * There is exactly one `.btn.primary` per step and it lives here, so "where is
 * the button" is never a question anybody has to ask twice.
 *
 * `outcome` is required rather than optional, because the whole point of it is
 * that it is on every step: one line saying what pressing the button does and
 * what that costs, next to the button itself rather than buried in the prose
 * above or hidden behind a hover.
 */
function StepFrame({
  kicker,
  title,
  lede,
  children,
  primary,
  primaryDisabled,
  outcome,
  busy,
  secondary,
  onSubmit,
  onBack,
}: {
  kicker: string;
  title: string;
  lede: ReactNode;
  children?: ReactNode;
  primary: string;
  /**
   * Only ever for something the reader has just typed and can see is wrong —
   * never for the state a step is arrived in, which must always have a live
   * button. Whatever sets this has to render its own reason on screen.
   */
  primaryDisabled?: boolean;
  outcome: ReactNode;
  busy?: boolean;
  secondary?: ReactNode;
  onSubmit: () => void;
  onBack: (() => void) | null;
}) {
  return (
    <form
      className="ob-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <div className="ob-scroll">
        <p className="ob-kicker">{kicker}</p>
        <h2 className="ob-title">{title}</h2>
        <div className="ob-lede">{lede}</div>
        {children}
      </div>
      <div className="ob-actions">
        {onBack && (
          <button type="button" className="btn ob-back" onClick={onBack}>
            Back
          </button>
        )}
        <p className="ob-outcome">{outcome}</p>
        <div className="ob-actions-end">
          {secondary}
          <button type="submit" className="btn primary" disabled={busy || primaryDisabled}>
            {busy && <Spinner />}
            {primary}
          </button>
        </div>
      </div>
    </form>
  );
}

/* ── 1. welcome, and the fork ─────────────────────────────────── */

/**
 * The fork sits at the foot of the welcome screen rather than on one of its
 * own, because it is not a personality quiz and a whole step would make it
 * feel like one. Neither answer is the advanced one and neither is the simple
 * one; all it decides is which steps appear and what they are called, which is
 * exactly what the note under it says.
 *
 * One of the two arrives already chosen, from what is on this machine. Not to
 * decide for anybody — the note says it was picked, both cards look identical,
 * changing it is one click here and one click from the bar on every later step
 * — but because the alternative was a first screen whose only button was dead
 * until you touched something else, which is a bad way to meet an app. It also
 * lets the rail show the real number of steps from the first frame, so "what
 * this costs" is answered before you agree to it.
 */
function WelcomeStep({
  track,
  onPick,
  onNext,
  onSkipAll,
  returning,
}: {
  track: Track;
  onPick: (t: Track) => void;
  onNext: () => void;
  onSkipAll: () => void;
  returning: boolean;
}) {
  const brand = config().brand;
  const forks: { id: Track; title: string; blurb: string; steps: string }[] = [
    {
      id: "build",
      title: "Building software",
      blurb:
        "Projects point at a folder of code on a machine you own. Teammates read it, change it, run things in it and report back.",
      steps: "Five short steps",
    },
    {
      id: "coordinate",
      title: "Coordinating work",
      blurb:
        "Projects are places to work: channels, tasks, shared notes and a calendar, with teammates who join in and keep track.",
      steps: "Three short steps",
    },
  ];

  return (
    <StepFrame
      kicker={returning ? "Welcome back" : "Welcome"}
      title={returning ? `Same ${brand}, new machine.` : `This is ${brand}.`}
      lede={
        returning ? (
          <>
            <p>
              Your workspace is already here — the people, the teammates and the projects came with
              it. Nothing gets set up twice.
            </p>
            <p>
              What is left is this machine: register it, meet whoever is already on the roster, and
              carry on.
            </p>
          </>
        ) : (
          <>
            <p>
              {brand} is a shared workspace where your AI teammates work alongside you. They work on
              machines you already own, signed in with accounts you already have.
            </p>
            <p>
              Nobody ever enters an API key. A teammate works while the machine it is on is awake,
              and everyone here can work with everyone else's.
            </p>
          </>
        )
      }
      primary={returning ? "Carry on" : "Continue"}
      outcome="Creates nothing. The next step is your name."
      onSubmit={onNext}
      onBack={null}
      secondary={
        <button type="button" className="btn" onClick={onSkipAll}>
          Skip for now
        </button>
      }
    >
      <div className="ob-forks" role="group" aria-label="What you are here to do">
        {forks.map((fork, i) => (
          <button
            key={fork.id}
            type="button"
            {...(i === 0 ? { "data-first": true } : {})}
            className={"ob-fork" + (fork.id === track ? " ob-fork-on" : "")}
            aria-pressed={fork.id === track}
            onClick={() => onPick(fork.id)}
          >
            <span className="ob-fork-title">
              {fork.title}
              {fork.id === track && <IconCheck size={12} />}
            </span>
            <span className="ob-fork-blurb">{fork.blurb}</span>
            <span className="ob-fork-steps">{fork.steps}</span>
          </button>
        ))}
      </div>
      <p className="ob-note">
        <IconInfo size={12} />
        One is already picked, from what is on this machine. Both do the same things — this only
        decides which steps you see next and how they are worded — so change it here, or from the
        bar at the top of any step, and nothing you have done is lost either way.
      </p>
      <ul className="ob-facts">
        <li>
          <strong>Every step can be skipped</strong> and picked up whenever you like.
        </li>
        <li>
          <strong>Nothing leaves this machine</strong> unless you connect something that does.
        </li>
        <li>
          <strong>Nothing installed? Still fine.</strong> You can work with teammates other people
          are running.
        </li>
      </ul>
    </StepFrame>
  );
}

/* ── 2. you ───────────────────────────────────────────────────── */

function YouStep({
  onNext,
  onBack,
  dev,
  kicker,
  deviceId,
  onDevice,
  situation,
}: StepProps & {
  deviceId: string;
  onDevice: (id: string) => void;
  situation: Situation;
}) {
  const devices = useStore((s) => s.devices);
  const tools = useStore((s) => s.tools);
  const updateMember = useStore((s) => s.updateMember);
  const addDevice = useStore((s) => s.addDevice);

  const me = situation.me;
  const [name, setName] = useState(me.name);
  const [color, setColor] = useState(me.color);
  const [touched, setTouched] = useState(false);
  const [platform, setPlatform] = useState(browserPlatform());
  const word = machineWord(platform);
  const [machine, setMachine] = useState(machineGuess(platform));
  const [register, setRegister] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void currentPlatform().then((reported) => {
      if (live) setPlatform(reported);
    });
    return () => {
      live = false;
    };
  }, []);

  // Either this run registered it or the roster did earlier — both mean this
  // machine is already on the roster, and offering again would make two rows
  // for one laptop.
  const registered = situation.here ?? devices.find((d) => d.id === deviceId) ?? null;
  // All three, so this passing note agrees with the checklist a step later. The
  // engine has to be asked rather than looked up; until it answers it is simply
  // left out, which is the one reading that is never wrong.
  const ritz = useRitzProbe();
  const found = APPS.filter((a) => presenceOf(a.kind, tools, ritz.state) === "here").map((a) =>
    harnessFor(a.kind).label
  );
  const list =
    found.length > 1
      ? `${found.slice(0, -1).join(", ")} and ${found[found.length - 1]}`
      : found[0];

  async function save() {
    setBusy(true);
    try {
      const clean = name.trim();
      if (clean !== me.name || color !== me.color) {
        await updateMember(me.id, { name: clean || me.name, color });
      }
      if (register && !registered) {
        const device = await addDevice({
          member_id: me.id,
          name: machine.trim() || machineGuess(platform),
          platform,
          tools: JSON.stringify(tools),
        });
        rememberLocalDevice(device.id);
        onDevice(device.id);
      }
      onNext();
    } catch (e) {
      toast.error("Could not save that", e);
      setBusy(false);
    }
  }

  return (
    <StepFrame
      kicker={kicker}
      title={situation.returning ? "Still you, on a new machine." : "Who is at this machine?"}
      lede={
        situation.returning ? (
          <p>
            You are already on the roster as <strong>{me.name}</strong>, so none of it is made
            twice. Registering this {word} is what lets the workspace say where your teammates are
            working from.
          </p>
        ) : (
          <p>
            One row in this workspace is you. Everything anybody owns — a calendar, a document, a
            teammate — hangs off it, and your name is what the rest of the roster sees.
          </p>
        )
      }
      primary="Continue"
      outcome={
        registered
          ? "Saves your name and colour. Nothing else changes."
          : register
            ? `Saves your name and adds this ${word} to the roster. Both are editable afterwards.`
            : "Saves your name and colour. This machine stays off the roster."
      }
      busy={busy}
      onSubmit={() => void save()}
      onBack={onBack}
      secondary={
        <button type="button" className="btn" onClick={onNext}>
          Skip
        </button>
      }
    >
      <Labelled label="Your name">
        {/* The schema seeds this row with a stand-in, so the very first focus
            selects it: typing replaces a word nobody chose, instead of
            appending to it. */}
        <input
          data-first
          value={name}
          onFocus={(e) => {
            if (!touched) e.currentTarget.select();
          }}
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
          placeholder={me.name}
        />
      </Labelled>
      <ColorPicker id={me.id} value={color} onChange={setColor} />

      <div className="ob-panel">
        {registered ? (
          <>
            <Fact tone="ok">{registered.name} is on the roster as your machine.</Fact>
            <p className="ob-hint">
              Recorded once, so the workspace can say which teammates work here — and why they go
              quiet while it sleeps.
            </p>
          </>
        ) : (
          <>
            <label className="ob-check">
              <input
                type="checkbox"
                checked={register}
                onChange={(e) => setRegister(e.target.checked)}
              />
              <span>
                <strong>Register this {word}</strong>
                <span className="ob-hint">
                  Records its name and which teammate apps it has. That is what lets a teammate of
                  yours say where it works from — and why it is unavailable while this {word} is
                  asleep. Optional, and reversible.
                </span>
              </span>
            </label>
            {register && (
              <Labelled label={`Name for this ${word}`}>
                <input
                  value={machine}
                  onChange={(e) => setMachine(e.target.value)}
                  placeholder={machineGuess(platform)}
                />
              </Labelled>
            )}
            <p className="ob-hint">
              {found.length
                ? `Already on this ${word}: ${list}.`
                : `Nothing that can run a teammate is on this ${word} yet. Registering it is still worth doing; it just cannot run one until something is here.`}
            </p>
            {dev && (
              <Aside title="What exactly gets recorded">
                <p className="ob-hint">
                  One row in the local database: this machine's name, the platform string the
                  webview reports{platform ? ` (${platform})` : ""}, and whether each agent CLI was
                  found on your PATH. No paths, no file contents, nothing about the code on it.
                </p>
              </Aside>
            )}
          </>
        )}
      </div>
    </StepFrame>
  );
}

/* ── 3. this machine (building path only) ─────────────────────── */

/**
 * The setup checklist.
 *
 * This used to be a fork — two apps, "one is enough", pick one and move on —
 * and it was wrong twice over. It was wrong for the person who has all three
 * installed, who was being asked to choose between things they already own; and
 * it left Ritz out of the list entirely, mentioned once inside a disclosure as
 * something you do "from Settings, not from here", which is how a runtime
 * somebody is actually running becomes invisible.
 *
 * So: one panel, all three, each with its own real state. Where one is present
 * the row says so and stops — detecting something and then explaining how to
 * install it is the commonest way onboarding wastes people's time. Where one is
 * absent the row keeps its install line folded away, available and never
 * nagging. Nothing here is required to continue, and nothing here is required
 * at all: teammates other people host work perfectly well from a machine with
 * none of this on it, which the step says out loud rather than implying.
 */
function MachineStep({ onNext, onBack, kicker, situation }: StepProps & { situation: Situation }) {
  const tools = useStore((s) => s.tools);
  const ritz = useRitzProbe();
  const [checking, setChecking] = useState(false);

  const rows = APPS.map((spec) => ({ spec, state: presenceOf(spec.kind, tools, ritz.state) }));
  const here = rows.filter((r) => r.state === "here");
  const brand = config().brand;
  const elsewhere = situation.existing.length;

  /**
   * Both detections at once, because they are two mechanisms answering one
   * question and re-running half of it would leave the panel internally
   * inconsistent for as long as somebody looked at it.
   */
  const recheckRitz = ritz.recheck;
  const recheck = useCallback(async () => {
    setChecking(true);
    recheckRitz();
    try {
      const found = await invoke<Record<string, boolean>>("check_tools");
      useStore.setState({ tools: found });
    } catch (e) {
      toast.error("Could not check this machine", e);
    } finally {
      setChecking(false);
    }
  }, [recheckRitz]);

  const title =
    here.length === APPS.length
      ? "All three are already here."
      : here.length === 1
        ? `${harnessFor(here[0].spec.kind).label} is already here.`
        : here.length > 1
          ? `${here.length} of ${APPS.length} are already here.`
          : "Nothing here can run a teammate yet.";

  return (
    <StepFrame
      kicker={kicker}
      title={title}
      lede={
        here.length ? (
          <p>
            A teammate works inside one of these, on somebody's machine. You can set up{" "}
            <strong>as many as you like</strong> — one teammate per app, or five in the same one —
            and {brand} drives all of them the same way. Nothing below needs an API key, and there
            is nowhere in {brand} to put one.
          </p>
        ) : (
          <p>
            A teammate works inside one of these, on somebody's machine. None of them is here yet,
            and that does not stop you:{" "}
            {elsewhere
              ? "the teammates already on the roster are yours to work with, and the next step offers them."
              : "you can work with teammates other people are running, and set one of these up whenever you want your own."}
          </p>
        )
      }
      primary="Continue"
      outcome={
        here.length
          ? "Installs nothing and changes nothing. The next step is your teammates."
          : "Installs nothing. You can still pick up teammates other people host."
      }
      onSubmit={onNext}
      onBack={onBack}
      secondary={
        <button type="button" className="btn" onClick={() => void recheck()} disabled={checking}>
          {checking ? <Spinner /> : <IconRefresh size={12} />}
          {checking ? "Checking…" : "Check again"}
        </button>
      }
    >
      <ul className="ob-runtimes">
        {rows.map(({ spec, state }) => {
          const meta = harnessFor(spec.kind);
          return (
            <li
              key={spec.kind}
              className={"ob-runtime" + (state === "here" ? " ob-runtime-on" : "")}
            >
              <p className="ob-runtime-head">
                {/* A fixed slot for either mark: the engine's answer arrives
                    while this is on screen, and a dot growing into a spinner
                    would nudge the name sideways as it did. */}
                <span className="ob-runtime-state" aria-hidden="true">
                  {state === "checking" ? <Spinner /> : <span className="ob-dot" />}
                </span>
                <span className="ob-runtime-name">{meta.label}</span>
                {/* Its own live region, so the one row that resolves late says
                    so out loud instead of only looking different. */}
                <span className="ob-pill" aria-live="polite">
                  {presenceWord(spec.kind, state)}
                </span>
              </p>
              <p className="ob-runtime-good">{spec.good}</p>

              {/* Present: say so and stop. There is nothing to do here, and a
                  command for something already installed is pure noise. */}
              {state === "here" && <p className="ob-hint">{spec.signin}</p>}

              {/* Absent: available, folded, and never in the way. The summary
                  is the whole offer, so a closed row costs one line. */}
              {state === "absent" && (
                <Aside title={`Set up ${meta.label}`}>
                  <p className="ob-hint">{spec.absent}</p>
                  {spec.install && <CopyBlock cmd={spec.install} />}
                  {/* The restart advice is true of the CLI ones only: PATH is
                      read when this app starts, so a program installed since
                      then is genuinely invisible until it restarts. Nothing of
                      the sort applies to a service we ask over HTTP every
                      time, and telling somebody to restart for that would send
                      them off to do something that cannot help. */}
                  <p className="ob-hint">
                    {spec.signin}
                    {spec.install
                      ? " Then press Check again — if it still reads as missing, restart " +
                        brand +
                        " so it sees the change."
                      : " Press Check again and this asks it once more."}
                  </p>
                </Aside>
              )}

              {/* Ritz is the one row whose absence needs explaining, because
                  "not answering" is a fact about a service rather than about a
                  missing file, and saying where we asked is the difference
                  between a diagnosis and an accusation. */}
              {spec.kind === "ritz" && state === "absent" && (
                <p className="ob-hint">
                  Asked at {ritzHost(ritz.url)} just now and got no answer. It is a service rather
                  than a program on this machine, so nothing can tell us whether it is installed —
                  only whether it is running.
                </p>
              )}
              {spec.kind === "ritz" && state === "here" && (
                <p className="ob-hint">Answering at {ritzHost(ritz.url)}.</p>
              )}
            </li>
          );
        })}
      </ul>

      <Aside title="What this means, precisely">
        <p className="ob-hint">
          <code>claude</code> and <code>codex</code> are command-line programs, found by looking on
          the PATH of the machine hosting the agent. {config().localAiName} is not: it is an HTTP service, so it never
          appears on a PATH and is detected by asking it directly — which is why it can read as
          absent on a machine that has it, if it simply is not running. Its address is a setting;
          change it in Settings and this checks the new one.
        </p>
      </Aside>
    </StepFrame>
  );
}

/* ── 4. your team ─────────────────────────────────────────────── */

/**
 * The standing context, assembled in the order the prompt builder really uses
 * it: the team charter, then the title, then what it owns, then its own
 * instructions. Showing it is the only thing that stops the difference between
 * four text boxes being a matter of faith.
 */
function assembleContext(o: {
  name: string;
  role: string;
  owns: string;
  instructions: string;
  teamName: string;
  charter: string;
}): string {
  const lines: string[] = [];
  lines.push(`You are "${o.name.trim() || "your teammate"}", an AI teammate in this channel.`);
  if (o.teamName.trim() && o.charter.trim()) {
    lines.push("", `## Charter — ${o.teamName.trim()} team`, o.charter.trim());
  }
  const role: string[] = [];
  if (o.role.trim()) role.push(`Title: ${o.role.trim()}`);
  if (o.owns.trim()) role.push(`You own: ${o.owns.trim()}`);
  if (o.instructions.trim()) role.push(o.instructions.trim());
  if (role.length) lines.push("", "## Your role", ...role);
  return lines.join("\n");
}

/** A rough sense of scale, so an empty box is not the only signal there is. */
function scaleOf(text: string): string {
  const n = text.trim().length;
  if (!n) return "empty";
  if (n < 120) return `${n} characters — a line`;
  if (n < 600) return `${n} characters — a paragraph`;
  if (n < 2000) return `${n} characters — a full brief`;
  return `${n} characters — longer than most`;
}

/**
 * One teammate somebody else already brought, offered for the taking.
 *
 * Clicking it adds it there and then — there is no second confirming step,
 * because the row appearing in the panel above is the confirmation, and a
 * "picked" state that still needs a button pressed at the bottom of the screen
 * is how people end up finishing setup with nothing selected.
 */
function AgentCard({
  agent,
  devices,
  tools,
  hereId,
  onAdd,
  busy,
}: {
  agent: Agent;
  devices: Device[];
  tools: Record<string, boolean>;
  hereId: string;
  onAdd: () => void;
  busy: boolean;
}) {
  const ident = agentIdentity(agent.id);
  const avail = availabilityOf(agent, devices, tools, hereId);
  return (
    <button
      type="button"
      className="ob-card"
      disabled={busy}
      onClick={onAdd}
      aria-label={`Work with ${ident.name}`}
    >
      <span className="ob-card-top">
        <Avatar name={agent.name} id={agent.id} kind={agent.kind} />
        <span className="ob-card-name">{ident.name}</span>
        {ident.tag && <span className="ob-tag">{ident.tag}</span>}
        <IconPlus size={12} />
      </span>
      <span className="ob-card-role">{agent.role || harnessFor(agent.kind).label}</span>
      {agent.owns && <span className="ob-card-owns">owns {agent.owns}</span>}
      <span className={`ob-avail ob-avail-${avail.tone}`}>
        <span className="ob-dot" aria-hidden="true" />
        {avail.text}
      </span>
    </button>
  );
}

/**
 * Which app a teammate works inside, with every option's real state on screen.
 *
 * Deliberately not RadioChips: that puts each option's explanation in a `title`,
 * and whether the thing you are about to depend on is actually on this machine
 * is not something anybody should have to hover to find out.
 */
function RuntimePick({
  choices,
  value,
  onChange,
  tools,
  ritz,
}: {
  choices: readonly AppSpec[];
  value: HarnessKind;
  onChange: (k: HarnessKind) => void;
  tools: Record<string, boolean>;
  ritz: Presence;
}) {
  const group = useId();
  return (
    <fieldset className="ob-picks ob-picks-wide">
      <legend className="ob-label">Which app it works inside</legend>
      {choices.map((spec) => {
        const state = presenceOf(spec.kind, tools, ritz);
        return (
          <label key={spec.kind} className="ob-pick">
            <input
              type="radio"
              name={group}
              checked={spec.kind === value}
              onChange={() => onChange(spec.kind)}
            />
            <span>
              {harnessFor(spec.kind).label}
              <span className="ob-tag">{presenceWord(spec.kind, state)}</span>
              <span className="ob-hint">{spec.good}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function TeamStep({
  onNext,
  onBack,
  dev,
  kicker,
  agentIds,
  authoredIds,
  teamId,
  channelId,
  onAgents,
  onTeam,
  situation,
}: StepProps & {
  agentIds: string[];
  authoredIds: string[];
  teamId: string;
  channelId: string;
  onAgents: (ids: string[], authored: string[]) => void;
  onTeam: (id: string) => void;
  situation: Situation;
}) {
  const store = useStore();
  const members = store.members;
  const devices = store.devices;
  const me = situation.me;
  const hereId = situation.here?.id ?? "";
  const existing = situation.existing;
  const ritz = useRitzProbe();

  /** What this run has so far, in the order it arrived. */
  const mine = agentIds
    .map((id) => store.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);

  /**
   * The authoring form is showing. It opens itself only when there is nothing
   * else on this screen to look at — with teammates already in the workspace,
   * leading with a form would be asking somebody to write one before telling
   * them they need not.
   */
  const [open, setOpen] = useState(mine.length === 0 && existing.length === 0);
  /** The last thing added, so the panel says what just happened. */
  const [added, setAdded] = useState("");

  /**
   * Opening or shutting the form swaps which control exists, and whatever had
   * focus goes with it — leaving focus on nothing at all, which for anybody on
   * a keyboard means being dropped back to the top of the dialog. The wizard's
   * own focus pass only runs when the *step* changes, so this step catches its
   * own shape changing. The mount is skipped because that pass has it.
   */
  const nameBox = useRef<HTMLInputElement | null>(null);
  const addBtn = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    (open ? nameBox.current : addBtn.current)?.focus();
  }, [open]);

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [owns, setOwns] = useState("");
  const [instructions, setInstructions] = useState("");
  const [owner, setOwner] = useState(me.id);
  // This machine first, then anything else this person has: the overwhelmingly
  // common answer is "the laptop I am sitting at".
  const [host, setHost] = useState(
    () => situation.here?.id ?? devices.find((d) => d.member_id === me.id)?.id ?? ""
  );
  const [visibility, setVisibility] = useState<AgentVisibility>("workspace");

  /**
   * Which app the next teammate works inside.
   *
   * Held as an override rather than a value, so that until somebody actually
   * chooses, the default keeps tracking two things that move underneath it: the
   * engine probe resolving, and which apps this run has already used. Storing
   * the answer would freeze whichever guess was true in the first frame.
   */
  const [kindPick, setKindPick] = useState<HarnessKind | "">("");
  const live = APPS.filter((a) => presenceOf(a.kind, store.tools, ritz.state) === "here");
  const used = new Set(mine.map((a) => a.kind));
  // A second teammate defaults to an app the first one is not already using —
  // "one of each" is the common shape, and it is one click away from any other.
  const kind: HarnessKind =
    kindPick || live.find((a) => !used.has(a.kind))?.kind || live[0]?.kind || "claude";

  const runTeam = teamId ? store.teams.find((t) => t.id === teamId) : undefined;
  const [inTeam, setInTeam] = useState(!!runTeam);
  const [teamName, setTeamName] = useState(runTeam?.name ?? "");
  const [charter, setCharter] = useState(runTeam?.charter ?? "");
  const [teamMates, setTeamMates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const clean = name.trim();
  const handle = slug(clean);
  const clash = handle
    ? [...store.agents.map((a) => a.name), ...store.teams.map((t) => t.name)].find(
        (n) => slug(n) === handle
      )
    : undefined;
  const teamHandle = slug(teamName.trim());
  // The run's own team is not a clash with itself, or resuming a run that named
  // a team would arrive with its own name flagged and its button switched off.
  const teamClash =
    inTeam && teamHandle
      ? [
          ...store.agents.map((a) => a.name),
          ...store.teams.filter((t) => t.id !== teamId).map((t) => t.name),
          clean,
        ].find((n) => n && slug(n) === teamHandle)
      : undefined;

  const hostDevice = devices.find((d) => d.id === host) ?? null;
  const hostTools = hostDevice ? parseTools(hostDevice.tools) : {};
  const ownerName = members.find((m) => m.id === owner)?.name ?? "its owner";
  const app = harnessFor(kind).label;
  const preview = assembleContext({ name: clean, role, owns, instructions, teamName, charter });

  /**
   * What the button does right now.
   *
   * Writing a name is what turns the primary into "create"; with the form shut,
   * or open and empty, it is "continue" and it works. So the step is never
   * arrived at with a button that does nothing — only a name that genuinely
   * cannot be used can switch it off, and that always has its reason on screen
   * directly above it.
   */
  const naming = open && !!clean;
  const blocked = (naming && !!clash) || !!teamClash;
  /** Anything typed into the form, so "discard" is only offered when it means something. */
  const dirty = !!(clean || role.trim() || owns.trim() || instructions.trim());

  /** Somebody who made the project first still gets teammates that hear it. */
  async function joinExistingChannel(agent: string) {
    if (channelId && useStore.getState().channels.some((c) => c.id === channelId)) {
      await store.addChannelMember(channelId, "agent", agent);
    }
  }

  /**
   * The run's team, brought level with whoever is in the run now. Membership is
   * set wholesale rather than appended, so this is safe to call after every
   * addition and after a removal.
   */
  async function syncTeam(ids: string[]): Promise<void> {
    const label = teamName.trim();
    if (!inTeam || !label || teamClash) return;
    let id = teamId;
    if (!id) {
      const team = await store.addTeam(label);
      id = team.id;
      onTeam(id);
    }
    await store.updateTeam(id, { name: label, charter: charter.trim() });
    await store.setTeamMembers(id, [...ids, ...teamMates].filter(Boolean));
  }

  /**
   * Blank the form for the next one, and default its app afresh. `owner` and
   * `host` deliberately survive: the second teammate almost always belongs to
   * the same person and works on the same machine as the first, and re-asking
   * is what makes "add another" feel like starting over.
   */
  function resetForm() {
    setName("");
    setRole("");
    setOwns("");
    setInstructions("");
    setKindPick("");
    setVisibility("workspace");
  }

  async function create() {
    if (!clean || clash || teamClash) return;
    setBusy(true);
    try {
      // The same defaults the roster gives a new agent, so one made here is
      // immediately runnable rather than half-built.
      const values = defaultsFor(kind);
      const agent = await store.addAgent({
        name: clean,
        kind,
        role: role.trim(),
        owns: owns.trim(),
        persona: instructions.trim(),
        model: String(values.model ?? "").trim(),
        cli_args: serializeArgs(kind, values),
      });
      // Not redundant: addAgent's INSERT names nine columns and these three are
      // not among them, so this patch is what actually writes ownership to the
      // row. Without it every teammate made here would arrive unowned, hosted
      // nowhere, and unable to say why it could not answer.
      await store.updateAgent(agent.id, {
        owner_member_id: owner,
        host_device_id: host,
        visibility,
      });
      const ids = [...agentIds, agent.id];
      await syncTeam(ids);
      await joinExistingChannel(agent.id);
      onAgents(ids, [...authoredIds, agent.id]);
      setAdded(clean);
      resetForm();
      // Shut the form rather than leave it blank and open: the panel above is
      // now the thing worth reading, and "Add another" reopens it in one click.
      setOpen(false);
    } catch (e) {
      toast.error("Could not create that teammate", e);
    } finally {
      setBusy(false);
    }
  }

  async function adopt(agent: Agent) {
    setBusy(true);
    try {
      const ids = [...agentIds, agent.id];
      await syncTeam(ids);
      await joinExistingChannel(agent.id);
      onAgents(ids, authoredIds);
      setAdded(agent.name);
    } catch (e) {
      toast.error("Could not set that up", e);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Taking one back out. A teammate written here is deleted, because otherwise
   * a typo leaves a row in the roster forever; one borrowed from somebody else
   * is only dropped from this run, because it was never ours to delete.
   */
  async function drop(agent: Agent) {
    const authored = authoredIds.includes(agent.id);
    setBusy(true);
    try {
      const ids = agentIds.filter((id) => id !== agent.id);
      if (authored) await store.deleteAgent(agent.id);
      await syncTeam(ids);
      onAgents(ids, authoredIds.filter((id) => id !== agent.id));
      setAdded("");
    } catch (e) {
      toast.error("Could not remove that teammate", e);
    } finally {
      setBusy(false);
    }
  }

  /** Continuing may still owe the workspace a team, if one was named late. */
  async function carryOn() {
    setBusy(true);
    try {
      await syncTeam(agentIds);
      onNext();
    } catch (e) {
      toast.error("Could not save the team", e);
      setBusy(false);
    }
  }

  /* Teams are authored here too — that is what "your own team names" means. */
  const teamBox = (
    <div className="ob-panel">
      <label className="ob-check">
        <input type="checkbox" checked={inTeam} onChange={(e) => setInTeam(e.target.checked)} />
        <span>
          <strong>Put them in a team</strong>
          <span className="ob-hint">
            A team is a name you choose plus a charter — shared standing instructions every member
            of it gets, ahead of their own. Worth doing the moment two teammates should work the
            same way. Everyone on this screen joins it.
          </span>
        </span>
      </label>
      {inTeam && (
        <>
          <Labelled label="Team name" hint="Yours to name. Mentioning it addresses everyone in it.">
            <input
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. Weekly ops"
            />
          </Labelled>
          {teamClash && (
            <p className="ob-warn">
              {teamClash} already answers to @{teamHandle}. Mentions resolve by handle, so two of
              them would be genuinely ambiguous — pick another name and this carries on.
            </p>
          )}
          <Labelled
            label="Charter"
            hint="Prepended for every member of this team, before their own instructions. Say how this group works, not what each member does."
            count={scaleOf(charter)}
          >
            <textarea
              rows={4}
              value={charter}
              onChange={(e) => setCharter(e.target.value)}
              placeholder={
                "e.g. End anything you do with a one-line summary in plain words.\nAsk before doing something somebody else would have to undo."
              }
            />
          </Labelled>
          {existing.length > 0 && (
            <fieldset className="ob-picks">
              <legend className="ob-label">Who else is in it</legend>
              {existing.map((a) => {
                const ident = agentIdentity(a.id);
                return (
                  <label key={a.id} className="ob-pick">
                    <input
                      type="checkbox"
                      checked={teamMates.includes(a.id)}
                      onChange={(e) =>
                        setTeamMates((was) =>
                          e.target.checked ? [...was, a.id] : was.filter((x) => x !== a.id)
                        )
                      }
                    />
                    <span>
                      {ident.name}
                      {ident.tag && <span className="ob-tag">{ident.tag}</span>}
                      {a.role && <span className="ob-hint">{a.role}</span>}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </>
      )}
    </div>
  );

  return (
    <StepFrame
      kicker={kicker}
      title={
        mine.length === 0
          ? "Who is on your side?"
          : mine.length === 1
            ? `${mine[0].name} is on your side.`
            : `${mine.length} teammates are on your side.`
      }
      lede={
        <p>
          Add <strong>as many as you like</strong>
          {dev
            ? " — one for each app on this machine, or several in the same one."
            : " — one for each job you want covered."}{" "}
          They are all written by you: there is no list to pick from, because a teammate that does{" "}
          <em>your</em> work has to be described in your words.
          {existing.length > 0 &&
            " The ones other people already brought are yours to work with too, and cost nothing to add."}
        </p>
      }
      primary={naming ? "Create teammate" : "Continue"}
      primaryDisabled={blocked}
      /* When the button is off, this line is the reason. The team box sits at
         the bottom of a panel that scrolls, so a name clash explained only
         where it happened can be off-screen while the button it disabled is
         pinned in view — which is the exact shape of a dead end. */
      outcome={
        blocked ? (
          <>
            <strong>@{naming && clash ? handle : teamHandle} is taken</strong> by{" "}
            {naming && clash ? clash : teamClash}. Mentions resolve by handle, so pick another and
            this switches back on.
          </>
        ) : naming ? (
          `Creates ${clean} and adds it here. You stay on this step to add another.`
        ) : mine.length ? (
          `Carries ${mine.length === 1 ? mine[0].name : `all ${mine.length}`} into the next step. Nothing else is created.`
        ) : (
          "Creates nothing. Teammates can be added later from Agents."
        )
      }
      busy={busy}
      onSubmit={() => void (naming ? create() : carryOn())}
      onBack={onBack}
      /* Only once there is something to discard. On the very first arrival the
         form is open and empty and the primary already reads "Continue", so a
         second button here would be offering the same nothing twice. */
      secondary={
        open && dirty ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              resetForm();
              setOpen(false);
            }}
          >
            Discard this one
          </button>
        ) : null
      }
    >
      {/* What this run has, read back. The row appearing here is the whole
          feedback for both adding paths. */}
      {mine.length > 0 && (
        <ul className="ob-summary">
          {mine.map((a) => {
            const avail = availabilityOf(a, devices, store.tools, hereId);
            const authored = authoredIds.includes(a.id);
            return (
              <li key={a.id}>
                <EntityChip ref={{ type: "agent", id: a.id }} />
                <span className="ob-hint">
                  {a.role || "no title"} · {harnessFor(a.kind).label} · {avail.text}
                </span>
                <button
                  type="button"
                  className="btn tiny ob-drop"
                  disabled={busy}
                  onClick={() => void drop(a)}
                  aria-label={
                    authored
                      ? `Delete ${a.name}, which was created here`
                      : `Take ${a.name} out of this setup, without deleting it`
                  }
                >
                  <IconX size={11} />
                  {authored ? "Delete" : "Take out"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {added && !open && (
        <p className="ob-note" role="status">
          <IconCheck size={12} />
          {added} is set up. Add another below, or continue — everything about{" "}
          {mine.length > 1 ? "any of them" : "it"} stays editable from the roster afterwards.
        </p>
      )}

      {/* Somebody else's teammates. Never phrased as second best: a workspace
          with people in it does not need you to write one to get going. */}
      {existing.length > 0 && (
        <div className="ob-panel">
          <p className="ob-panel-title">
            Already in this workspace — click one to work with it
          </p>
          <div className="ob-cards" role="group" aria-label="Teammates already here">
            {existing.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                devices={devices}
                tools={store.tools}
                hereId={hereId}
                busy={busy}
                onAdd={() => void adopt(a)}
              />
            ))}
          </div>
          <p className="ob-hint">
            Adding one changes nothing about it — it keeps whatever instructions its owner gave it.
            You are working with it, not editing it.
          </p>
        </div>
      )}

      {/* The authoring form. Closed, it is one button; open, it is the step. */}
      {!open ? (
        <div className="ob-panel">
          <p className="ob-panel-title">{mine.length ? "Another one?" : "Write your own"}</p>
          <p className="ob-hint">
            A name, what it owns, and the standing instructions it works under. Takes a minute, and
            nothing about it is permanent.
          </p>
          <button
            type="button"
            className="btn ob-add"
            data-first
            ref={addBtn}
            onClick={() => {
              setAdded("");
              setOpen(true);
            }}
          >
            <IconPlus size={12} />
            {mine.length ? "Add another teammate" : "Write a teammate"}
          </button>
        </div>
      ) : (
        <div className="ob-panel">
          <p className="ob-panel-title">
            {mine.length ? `Teammate ${mine.length + 1}` : "Your teammate"}
          </p>
          <div className="ob-grid">
            <Labelled label="Name" hint="Whatever you want to call it. Mentions use @name.">
              <input
                data-first
                ref={nameBox}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Scout"
              />
            </Labelled>
            <Labelled
              label="Role"
              hint="A short title. Appears in the roster, and in what other teammates are told about it."
            >
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Notetaker"
              />
            </Labelled>
          </div>
          {clash && (
            <p className="ob-warn">
              {clash} already answers to @{handle}. Mentions resolve by handle, so two of them would
              be genuinely ambiguous — pick another name and Create teammate switches back on.
            </p>
          )}

          <Labelled
            label="What it owns"
            hint="The areas it looks after. Shown beside it everywhere, and used when work is being routed to somebody."
          >
            <input
              value={owns}
              onChange={(e) => setOwns(e.target.value)}
              placeholder="e.g. meeting notes, the weekly summary"
            />
          </Labelled>

          <Labelled
            label="Instructions"
            hint="The standing prompt. Prepended to every single thing this teammate is asked, in every channel, for as long as it exists. Say how it should work — not that it should be helpful."
            count={scaleOf(instructions)}
          >
            <textarea
              rows={6}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={
                "e.g. Open with what changed since last time, in one line.\n" +
                "Ask a question when something is ambiguous instead of guessing.\n" +
                "Say plainly when you could not do something, and what you would need to."
              }
            />
          </Labelled>

          {/* Every app, with its state, on the building path — that is the
              whole point of the checklist a step earlier. On the coordinating
              path the question is only worth asking when the machine can
              genuinely answer it more than one way. */}
          {dev ? (
            <RuntimePick
              choices={APPS}
              value={kind}
              onChange={setKindPick}
              tools={store.tools}
              ritz={ritz.state}
            />
          ) : live.length > 1 ? (
            <RuntimePick
              choices={live}
              value={kind}
              onChange={setKindPick}
              tools={store.tools}
              ritz={ritz.state}
            />
          ) : null}

          {dev && (
            <div className="ob-grid">
              <Labelled label="Brought by">
                <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.is_self ? " (you)" : ""}
                    </option>
                  ))}
                </select>
              </Labelled>
              <Labelled label="Machine it works on">
                <select value={host} onChange={(e) => setHost(e.target.value)}>
                  <option value="">No machine yet</option>
                  {devices.map((d) => {
                    const holder = members.find((m) => m.id === d.member_id);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {holder ? ` — ${holder.name}'s` : ""}
                      </option>
                    );
                  })}
                </select>
              </Labelled>
            </div>
          )}

          <div className="ob-choice">
            <span className="ob-label">Who can use it</span>
            <RadioChips
              label="Who can use it"
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "workspace", label: "Everyone here" },
                { value: "private", label: "Just me" },
              ]}
            />
          </div>

          <div className="ob-panel">
            <p className="ob-panel-title">What {clean || "it"} gets told, every single time</p>
            <pre className="ob-preview">{preview}</pre>
            <p className="ob-hint">
              This sits above every message it is ever sent, ahead of the conversation itself. The
              project and the channel add their own standing instructions on top of it later.
            </p>
          </div>

          <div className="ob-panel">
            <p className="ob-panel-title">What this means</p>
            <ul className="ob-consequence">
              <li>
                {kind === "ritz"
                  ? `${clean || "It"} works through the engine on this machine, so it answers whenever ${config().brand} is open here.`
                  : hostDevice
                    ? `${clean || "It"} works on ${hostDevice.name}. While that machine is asleep, offline, or not running ${config().brand}, it cannot answer and nothing else picks it up.`
                    : `${clean || "It"} has no machine to work on yet, so it cannot answer. It sits in the roster until one is chosen — which you can do later.`}
              </li>
              <li>
                {kind === "ritz"
                  ? "There is no account to sign in to and no API key: the engine is already yours."
                  : `It signs in with ${ownerName}'s own ${app} account on that machine. No API key is asked for, stored, or needed.`}
              </li>
              <li>
                {visibility === "workspace"
                  ? "Everyone in this workspace can address it."
                  : "Only you can address it, until you change that from the roster."}
              </li>
              {kind !== "ritz" && hostDevice && hostTools[kind] === false && (
                <li>
                  {hostDevice.name} has not got {app}. Recording this is still fine; it will not
                  answer until that app is there.
                </li>
              )}
              {kind === "ritz" && ritz.state === "absent" && (
                <li>
                  The engine is not answering at {ritzHost(ritz.url)} right now. Making this is
                  still fine — it starts working the moment the engine does.
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      {teamBox}
    </StepFrame>
  );
}

/* ── 5. what you are working on ───────────────────────────────── */

type PathProbe = { kind: "none" } | { kind: "checking" } | { kind: "repo" } | { kind: "plain" };

function ProjectStep({
  onNext,
  onBack,
  dev,
  kicker,
  agentIds,
  projectId,
  onProject,
}: StepProps & {
  agentIds: string[];
  projectId: string;
  onProject: (project: string, channel: string) => void;
}) {
  const store = useStore();
  const pathLabel = useId();
  const made = projectId ? store.projects.find((p) => p.id === projectId) : undefined;
  const crew = agentIds
    .map((id) => store.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  // Naming them is worth the sentence: "your teammates join" is a promise, and
  // "Scout and Probe join" is a fact somebody can check.
  const names =
    crew.length > 1
      ? `${crew
          .slice(0, -1)
          .map((a) => a.name)
          .join(", ")} and ${crew[crew.length - 1].name}`
      : (crew[0]?.name ?? "");

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [path, setPath] = useState("");
  const [isolate, setIsolate] = useState(false);
  const [probe, setProbe] = useState<PathProbe>({ kind: "none" });
  const [busy, setBusy] = useState(false);

  // Real answer or none: a "one copy each" toggle that silently needs version
  // control is the kind of promise that only breaks on the first run.
  useEffect(() => {
    if (!dev) return;
    const dir = path.trim();
    if (!dir) {
      setProbe({ kind: "none" });
      return;
    }
    let live = true;
    setProbe({ kind: "checking" });
    const timer = window.setTimeout(() => {
      void isGitRepo(dir).then(
        (ok) => live && setProbe({ kind: ok ? "repo" : "plain" }),
        () => live && setProbe({ kind: "plain" })
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, dev]);

  async function browse() {
    try {
      const picked = await pickFolder({ directory: true });
      if (typeof picked === "string") setPath(picked);
    } catch (e) {
      toast.error("Could not open the folder picker", e);
    }
  }

  async function create() {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      const project = await store.addProject({
        name: clean,
        description: purpose.trim(),
        // A project with no folder is a first-class project: channels, tasks,
        // memory and a calendar all work without one. Only code needs a folder.
        local_path: dev ? path.trim() : "",
        isolate: dev && isolate && probe.kind === "repo" ? 1 : 0,
      });
      // addProject always makes #general; read it back rather than assume an id.
      const channel = useStore.getState().channels.find((c) => c.project_id === project.id) ?? null;
      if (channel) {
        // Every one of them, not just the first. Without this the very next
        // thing they try — saying hello — does nothing at all, because agents
        // only hear the channels they are in.
        for (const a of crew) await store.addChannelMember(channel.id, "agent", a.id);
      }
      onProject(project.id, channel?.id ?? "");
      onNext();
    } catch (e) {
      toast.error("Could not create that project", e);
      setBusy(false);
    }
  }

  if (made) {
    return (
      <StepFrame
        kicker={kicker}
        title="It is already here."
        lede={
          <p>
            Made earlier in this run, with a #general channel inside it
            {crew.length ? ` and ${names} in that channel` : ""}.
          </p>
        }
        primary="Continue"
        outcome="Creates nothing more. Nothing here is final; rename or delete it whenever."
        onSubmit={onNext}
        onBack={onBack}
      >
        <div className="ob-panel ob-made">
          <EntityChip ref={{ type: "project", id: made.id }} />
          <span className="ob-hint">
            {made.description || (dev ? made.local_path || "No folder" : "No description yet")}
          </span>
        </div>
      </StepFrame>
    );
  }

  return (
    <StepFrame
      kicker={kicker}
      title={dev ? "Give it something to work on." : "What are you working on?"}
      lede={
        dev ? (
          <p>
            A project is a name, a folder of code on this machine, and a #general channel that comes
            with it — plus tasks, shared notes and a calendar as you need them.{" "}
            {crew.length
              ? `${names} join${crew.length === 1 ? "s" : ""} that channel automatically — teammates only hear the channels they are in.`
              : "You can add teammates to that channel whenever you make one."}
          </p>
        ) : (
          <p>
            A project here is a place rather than a folder: channels to talk in, tasks to track,
            notes everybody shares, and a calendar.{" "}
            {crew.length
              ? `${names} join${crew.length === 1 ? "s" : ""} its #general channel automatically — teammates only hear the channels they are in.`
              : "You can add teammates to its #general channel whenever you like."}
          </p>
        )
      }
      primary={name.trim() ? "Create project" : "Continue without a project"}
      outcome={
        name.trim()
          ? `Creates ${name.trim()} and a #general channel${crew.length ? `, with ${names} in it` : ""}.`
          : "Creates nothing. The sidebar's ＋ makes a project whenever you want one."
      }
      busy={busy}
      onSubmit={() => void (name.trim() ? create() : onNext())}
      onBack={onBack}
      /* No Skip beside an empty form: the primary already is the skip, and two
         buttons for one action is how people end up pressing neither. */
      secondary={
        name.trim() ? (
          <button type="button" className="btn" onClick={onNext}>
            Skip
          </button>
        ) : null
      }
    >
      <Labelled label="Name">
        <input
          data-first
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={dev ? "e.g. My App" : "e.g. Spring campaign"}
        />
      </Labelled>

      <Labelled
        label={dev ? "What it is" : "What you are trying to do"}
        hint="Everybody sees this, and every teammate working here is told it. A line or two is plenty."
        count={scaleOf(purpose)}
      >
        <textarea
          rows={3}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder={
            dev
              ? "e.g. The customer-facing app. Ships weekly."
              : "e.g. Everything for the spring launch — planning, copy, and who is doing what."
          }
        />
      </Labelled>

      {dev && (
        <>
          {/* Not a <label>: the picker button lives on the same row, and a
              button inside a label is a control fighting its own wrapper. */}
          <div className="ob-field">
            <span className="ob-label" id={pathLabel}>
              Folder on this machine
            </span>
            <div className="ob-row">
              <input
                aria-labelledby={pathLabel}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={config().samplePath}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={() => void browse()}>
                Browse…
              </button>
            </div>
            <span className="ob-hint">
              Optional. Every teammate working in this project works inside this folder.
            </span>
          </div>

          {probe.kind === "checking" && (
            <p className="ob-hint">
              <Spinner /> Checking that folder…
            </p>
          )}
          {probe.kind === "repo" && (
            <Fact tone="ok">Under version control — a copy each will work here.</Fact>
          )}
          {probe.kind === "plain" && (
            <p className="ob-hint">
              <IconInfo size={12} /> Not under version control (or not there yet). That is fine —
              teammates can still work in it; they just cannot each have their own copy.
            </p>
          )}

          <label className={"ob-check" + (probe.kind === "repo" ? "" : " ob-check-off")}>
            <input
              type="checkbox"
              checked={isolate && probe.kind === "repo"}
              disabled={probe.kind !== "repo"}
              onChange={(e) => setIsolate(e.target.checked)}
            />
            <span>
              <strong>Give each teammate its own copy to work in</strong>
              <span className="ob-hint">
                They work on separate branches in separate directories instead of tripping over each
                other in one folder. Needs the folder above to be under version control; you can
                turn it on later from the project's settings.
              </span>
            </span>
          </label>
          <Aside title="What this means, precisely">
            <p className="ob-hint">
              A <code>git worktree</code> per agent, created under the repository and removed with
              the workspace. Each is a real checkout on its own branch, so commits are independent
              and nothing is stashed behind anybody's back.
            </p>
          </Aside>
        </>
      )}
    </StepFrame>
  );
}

/* ── 6. optional connections (building path only) ─────────────── */

function ConnectStep({ onNext, onBack, kicker }: StepProps) {
  const [address, setAddress] = useState(config().portalUrl);
  const [paired, setPaired] = useState<{ base: string; device: string } | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let live = true;
    void loadPortalConnection().then(
      (connection) => {
        if (!live) return;
        if (connection) {
          setPaired({ base: connection.base_url, device: connection.device_name });
          setAddress(connection.base_url);
        }
        setChecked(true);
      },
      () => live && setChecked(true)
    );
    return () => {
      live = false;
    };
  }, []);

  function saveAddress() {
    const raw = address.trim();
    if (!raw) {
      onNext();
      return;
    }
    try {
      const normalized = normalizeBaseUrl(raw);
      setConfig({ portalUrl: normalized });
      setAddress(normalized);
      toast.success("Address saved", "Pairing itself happens when you open it and ask for a code.");
    } catch (e) {
      toast.warn("That address did not parse", e instanceof Error ? e.message : String(e));
      return;
    }
    onNext();
  }

  return (
    <StepFrame
      kicker={kicker}
      title="Anything else you want plugged in?"
      lede={
        <p>
          All of this is optional and none of it is needed for what you just made. Everything above
          keeps working with no network at all.
        </p>
      }
      primary={paired ? "Continue" : "Save and continue"}
      outcome={
        paired
          ? "Changes nothing — this machine is already paired."
          : address.trim()
            ? "Saves the address only. Pairing is a separate step you start when you want to."
            : "Saves nothing. You can add a workspace address later from Settings."
      }
      onSubmit={paired ? onNext : saveAddress}
      onBack={onBack}
      secondary={
        !paired && address.trim() ? (
          <button type="button" className="btn" onClick={onNext}>
            Skip
          </button>
        ) : null
      }
    >
      <div className="ob-panel">
        <p className="ob-panel-title">A web workspace</p>
        {!checked ? (
          <p className="ob-hint">
            <Spinner /> Checking…
          </p>
        ) : paired ? (
          <>
            <Fact tone="ok">Paired as {paired.device}.</Fact>
            <p className="ob-hint">
              Connected to {paired.base}. Mail, calendars and published content flow through it;
              everything local stays on this machine.
            </p>
          </>
        ) : (
          <>
            <Labelled
              label="Address"
              hint="Only if you run one. It carries mail, calendars and publishing; nothing local depends on it."
            >
              <input
                data-first
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="workspace.example.com"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Labelled>
            <button
              type="button"
              className="btn"
              disabled={!address.trim()}
              onClick={() => {
                try {
                  void openUrl(normalizeBaseUrl(address));
                } catch (e) {
                  toast.warn(
                    "That address did not parse",
                    e instanceof Error ? e.message : String(e)
                  );
                }
              }}
            >
              Open it in a browser
            </button>
            <p className="ob-hint">
              Saving the address does not pair anything. Pairing asks the workspace for a one-time
              code, and you can do that whenever you like.
            </p>
          </>
        )}
      </div>

      <div className="ob-panel">
        <p className="ob-panel-title">Later, when you want them</p>
        <ul className="ob-later">
          <li>
            <strong>Calendars.</strong> Yours and your teammates', overlaid — shared as busy-only,
            readable, or writable, per person.
          </li>
          <li>
            <strong>Knowledge.</strong> Point at a folder of notes or documents on this machine and
            it becomes searchable, by you and by your teammates. Read-only, always.
          </li>
        </ul>
        <p className="ob-hint">Both live in the sidebar. Neither needs setting up now.</p>
      </div>
    </StepFrame>
  );
}

/* ── 7. done ──────────────────────────────────────────────────── */

/**
 * Put the suggested opener into the composer.
 *
 * The composer is a controlled textarea in a file this one does not own, and
 * there is no store handle for its draft — so the honest options are to type
 * into the real node the way a person would, or to hand the text over and let
 * them paste. This tries the first (the workspace mounts a beat after the view
 * changes), and the caller falls back to the second.
 */
async function fillComposer(text: string): Promise<boolean> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    // Workspaces stay mounted once visited, so several composers can exist;
    // only the on-screen one is the one they are about to type in.
    const boxes = Array.from(document.querySelectorAll<HTMLTextAreaElement>(".composer textarea"));
    const box = boxes.find((el) => el.offsetParent !== null);
    if (box && setter) {
      setter.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.focus();
      box.setSelectionRange(text.length, text.length);
      return true;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

function DoneStep({
  onBack,
  dev,
  agentIds,
  projectId,
  channelId,
  teamId,
  onFinish,
  situation,
}: {
  onBack: (() => void) | null;
  dev: boolean;
  agentIds: string[];
  projectId: string;
  channelId: string;
  teamId: string;
  onFinish: () => void;
  situation: Situation;
}) {
  const store = useStore();
  const crew = agentIds
    .map((id) => store.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  const project = projectId ? store.projects.find((p) => p.id === projectId) : undefined;
  const channel = channelId ? store.channels.find((c) => c.id === channelId) : undefined;
  const team = teamId ? store.teams.find((t) => t.id === teamId) : undefined;
  const hereId = situation.here?.id ?? "";

  /**
   * The opener addresses everyone set up here, in one message — which is also
   * the shortest possible demonstration that mentions are how work is
   * addressed, and that several teammates can be in one room.
   */
  const opener = useMemo(() => {
    if (!crew.length) return "";
    const handles = crew.map((a) => `@${slug(a.name)}`).join(" ");
    if (dev && project?.local_path) {
      return `${handles} take a look around this folder and tell me what it does, then suggest the three things most worth doing first.`;
    }
    if (project) {
      return `${handles} we're starting ${project.name}. Ask me whatever you need to know about it, then propose the first three things to do.`;
    }
    return `${handles} introduce yourselves: what you're for, and what you'd need from me to be useful.`;
    // Names are what the text is built from, so that is what it depends on.
  }, [crew.map((a) => a.name).join("\u0000"), project, dev]);

  async function go() {
    if (channel) {
      store.setView({ type: "channel", channelId: channel.id });
      onFinish();
      if (opener && !(await fillComposer(opener))) {
        if (await copyText(opener)) {
          toast.info("Suggested opener copied", "Paste it into the composer and send.");
        }
      }
      return;
    }
    onFinish();
  }

  const nothing = !crew.length && !project;

  return (
    <StepFrame
      kicker="Done"
      title={nothing ? "Set up whenever you like." : "Here is where you are."}
      lede={
        nothing ? (
          <p>
            Nothing was created, which is a fine place to stop. The dashboard keeps a short
            checklist, and the sidebar's ＋ makes a project whenever you want one.
          </p>
        ) : (
          <p>
            All of it is editable, and none of it is precious — rename it, move it, or delete it and
            start again.
          </p>
        )
      }
      primary={channel ? `Open #${channel.name}` : "Finish"}
      outcome={
        channel
          ? `Closes setup and opens #${channel.name}, with a first message ready to send.`
          : "Closes setup. Everything above stays where it is."
      }
      onSubmit={() => void go()}
      onBack={onBack}
    >
      {!nothing && (
        <ul className="ob-summary">
          {crew.map((a) => (
            <li key={a.id}>
              <EntityChip ref={{ type: "agent", id: a.id }} />
              <span className="ob-hint">
                {a.role || harnessFor(a.kind).label} ·{" "}
                {availabilityOf(a, store.devices, store.tools, hereId).text}
              </span>
            </li>
          ))}
          {team && (
            <li>
              <EntityChip ref={{ type: "team", id: team.id }} />
              <span className="ob-hint">
                {team.charter ? "its charter goes to every member" : "no charter yet"}
              </span>
            </li>
          )}
          {project && (
            <li>
              <EntityChip ref={{ type: "project", id: project.id }} />
              <span className="ob-hint">
                {dev
                  ? `${project.local_path || "no folder"}${project.isolate ? " · a copy each" : ""}`
                  : project.description || "no description yet"}
              </span>
            </li>
          )}
          {channel && (
            <li>
              <EntityChip ref={{ type: "channel", id: channel.id }} />
              <span className="ob-hint">
                {crew.length
                  ? `${crew.length === 1 ? `${crew[0].name} is` : `all ${crew.length} are`} in it and will hear you`
                  : "no teammates in it yet"}
              </span>
            </li>
          )}
        </ul>
      )}

      {opener && (
        <div className="ob-panel">
          <p className="ob-panel-title">Something to open with</p>
          <CopyBlock cmd={opener} prose />
          <p className="ob-hint">
            Mentions are how work is addressed here, and one message can address several teammates
            at once. Each answers while the machine it works on is awake and running{" "}
            {config().brand}.
          </p>
        </div>
      )}

      <p className="ob-note">
        <IconBolt size={12} /> Anything skipped is still there: people and machines in the roster,
        teammates and teams under Agents, projects from the sidebar's ＋ — and this whole setup
        again from Settings.
      </p>
    </StepFrame>
  );
}

/* ── the wizard ───────────────────────────────────────────────── */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus lands on whatever each step marks as its first control, and on the
 * primary button when a step has no field to type in. Every step marks one, so
 * the fallback is a guarantee rather than a routine path.
 */
function useAutoFocus(key: string, panel: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el =
        panel.current?.querySelector<HTMLElement>("[data-first]") ??
        panel.current?.querySelector<HTMLElement>(".ob-actions .btn.primary");
      el?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [key, panel]);
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const agents = useStore((s) => s.agents);
  const teams = useStore((s) => s.teams);
  const projects = useStore((s) => s.projects);
  const channels = useStore((s) => s.channels);
  const devices = useStore((s) => s.devices);

  const tools = useStore((s) => s.tools);

  /**
   * The path arrives already chosen.
   *
   * `tools` is set in the same update that sets `loaded`, and this component
   * only mounts once loaded — so by the first render the answer is real rather
   * than a guess made against an empty map. Somebody with an agent CLI on their
   * machine is more likely than not here to build with it; everybody else gets
   * the shorter path. Either way both cards are on screen, identical, and the
   * bar above every later step switches between them in one click.
   */
  const [saved, setSaved] = useState<SavedState>(() => {
    const prior = readState() ?? BLANK;
    if (prior.track) return prior;
    return { ...prior, track: tools.claude || tools.codex ? "build" : "coordinate" };
  });
  const [asking, setAsking] = useState(false);

  const track = trackOf(saved);
  const steps = sequenceFor(track);
  const step = Math.min(Math.max(saved.step, 0), steps.length - 1);
  const id: StepId = steps[step].id;
  const dev = track === "build";
  const situation = useSituation(saved.agentIds);

  useAutoFocus(`${saved.track}:${step}`, panel);

  /**
   * Progress is written straight through rather than from an effect: finishing
   * unmounts this component in the same tick, and an effect scheduled on a
   * component that is going away never runs — which is exactly the write that
   * must not be lost. The ref is the synchronous copy those writes merge onto.
   */
  const latest = useRef(saved);
  const commit = useCallback((next: SavedState) => {
    latest.current = next;
    writeState(next);
    setSaved(next);
  }, []);

  const patch = useCallback(
    (next: Partial<SavedState>) => commit({ ...latest.current, ...next }),
    [commit]
  );

  // Adopt only what still exists. Somebody who deleted a teammate they made
  // here should see the panel offer to write another, not a stale row — and
  // with a list of them, that has to be pruned member by member.
  useEffect(() => {
    const prev = latest.current;
    const agentIds = prev.agentIds.filter((id) => agents.some((a) => a.id === id));
    const next: SavedState = {
      ...prev,
      deviceId: devices.some((d) => d.id === prev.deviceId) ? prev.deviceId : "",
      agentIds,
      authoredIds: prev.authoredIds.filter((id) => agentIds.includes(id)),
      teamId: teams.some((t) => t.id === prev.teamId) ? prev.teamId : "",
      projectId: projects.some((p) => p.id === prev.projectId) ? prev.projectId : "",
      channelId: channels.some((c) => c.id === prev.channelId) ? prev.channelId : "",
    };
    if (
      next.deviceId === prev.deviceId &&
      next.agentIds.length === prev.agentIds.length &&
      next.authoredIds.length === prev.authoredIds.length &&
      next.teamId === prev.teamId &&
      next.projectId === prev.projectId &&
      next.channelId === prev.channelId
    ) {
      return;
    }
    commit(next);
  }, [agents, teams, projects, channels, devices, commit]);

  const goto = useCallback(
    (n: number) =>
      patch({ step: Math.min(Math.max(n, 0), sequenceFor(trackOf(latest.current)).length - 1) }),
    [patch]
  );

  const finish = useCallback(() => {
    commit({ ...latest.current, status: "done" });
    onDone();
  }, [commit, onDone]);

  const next = useCallback(() => goto(step + 1), [goto, step]);
  const back = step > 0 ? () => goto(step - 1) : null;

  /**
   * Switching path mid-run. The two sequences share step ids, so land on the
   * same *screen* where one exists and on the last real step where it does not
   * — throwing somebody back to the welcome screen would make the choice feel
   * expensive, which is precisely what it is not.
   */
  const switchTrack = useCallback(
    (to: Track) => {
      const here = sequenceFor(trackOf(latest.current))[latest.current.step]?.id ?? "welcome";
      const target = SEQUENCES[to].findIndex((s) => s.id === here);
      patch({ track: to, step: target >= 0 ? target : Math.max(0, SEQUENCES[to].length - 2) });
    },
    [patch]
  );

  // The safe answer is the default, so it is also the one holding focus.
  const askFirst = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (asking) askFirst.current?.focus();
  }, [asking]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      // Escape out of the skip prompt rather than out of the wizard: the
      // safe answer to "are you sure" is always no.
      if (asking) setAsking(false);
      else setAsking(true);
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.offsetParent !== null
    );
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const kicker = kickerFor(steps, step);
  const body = (() => {
    switch (id) {
      case "welcome":
        return (
          <WelcomeStep
            track={track}
            onPick={(picked) => patch({ track: picked })}
            onNext={next}
            onSkipAll={() => setAsking(true)}
            returning={situation.returning}
          />
        );
      case "you":
        return (
          <YouStep
            onNext={next}
            onBack={back}
            dev={dev}
            kicker={kicker}
            deviceId={saved.deviceId}
            onDevice={(deviceId) => patch({ deviceId })}
            situation={situation}
          />
        );
      case "machine":
        return (
          <MachineStep onNext={next} onBack={back} dev={dev} kicker={kicker} situation={situation} />
        );
      case "team":
        return (
          <TeamStep
            onNext={next}
            onBack={back}
            dev={dev}
            kicker={kicker}
            agentIds={saved.agentIds}
            authoredIds={saved.authoredIds}
            teamId={saved.teamId}
            channelId={saved.channelId}
            onAgents={(agentIds, authoredIds) => patch({ agentIds, authoredIds })}
            onTeam={(teamId) => patch({ teamId })}
            situation={situation}
          />
        );
      case "project":
        return (
          <ProjectStep
            onNext={next}
            onBack={back}
            dev={dev}
            kicker={kicker}
            agentIds={saved.agentIds}
            projectId={saved.projectId}
            onProject={(projectId, channelId) => patch({ projectId, channelId })}
          />
        );
      case "connect":
        return <ConnectStep onNext={next} onBack={back} dev={dev} kicker={kicker} />;
      case "done":
        return (
          <DoneStep
            onBack={back}
            dev={dev}
            agentIds={saved.agentIds}
            projectId={saved.projectId}
            channelId={saved.channelId}
            teamId={saved.teamId}
            onFinish={finish}
            situation={situation}
          />
        );
    }
  })();

  return (
    <div className="ob-overlay" onKeyDown={onKeyDown}>
      <div
        className="ob-panel-wrap"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
      >
        <header className="ob-head">
          <span className="ob-brand" id={titleId}>
            <span className="ob-mark">
              <IconLogo size={17} />
            </span>
            Setting up {config().brand}
          </span>
          <button type="button" className="btn ob-skip" onClick={() => setAsking(true)}>
            Skip setup
          </button>
        </header>

        {/* The steps and the step. A row of seven pills above the content read
            as a toolbar — something to operate — rather than as a spine you are
            moving down, and at seven steps it wrapped. Beside the content it is
            a contents page: where you are, what is behind you, what is left.
            It folds back to a row when the window is too narrow to carry both. */}
        <div className="ob-split">
        <ol className="ob-rail">
          {steps.map((s, i) => (
            <li
              key={s.id}
              className={"ob-rail-step" + (i === step ? " ob-on" : i < step ? " ob-past" : "")}
            >
              {/* Steps you have been through are reachable again; ones you
                  have not are not links, because arriving at the last step
                  with nothing behind it is a worse screen than not offering
                  it. */}
              <button
                type="button"
                className="ob-rail-btn"
                disabled={i > step}
                aria-current={i === step ? "step" : undefined}
                onClick={() => goto(i)}
              >
                <span className="ob-rail-dot" aria-hidden="true">
                  {i < step ? <IconCheck size={9} /> : i + 1}
                </span>
                <span className="ob-rail-label">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="ob-main">
        {/* The fork, still visible and still cheap. Hidden on the welcome
            screen, where the choice *is* the screen. */}
        {id !== "welcome" && (
          <div className="ob-mode">
            <span>
              Set up for <strong>{dev ? "building software" : "coordinating work"}</strong> — steps
              and wording only.
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => switchTrack(dev ? "coordinate" : "build")}
            >
              Switch to {dev ? "coordinating work" : "building software"}
            </button>
          </div>
        )}

        <span className="ob-sr" role="status">
          Step {step + 1} of {steps.length}: {steps[step].label}
        </span>

        {asking && (
          <div className="ob-ask" role="alertdialog" aria-label="Skip setup">
            <p>
              <strong>Skip the rest?</strong> Nothing already created goes away, and the dashboard
              keeps a short checklist for whatever is left.
            </p>
            <div className="ob-ask-actions">
              <button type="button" className="btn" ref={askFirst} onClick={() => setAsking(false)}>
                Keep going
              </button>
              <button type="button" className="btn primary" onClick={finish}>
                Skip setup
              </button>
            </div>
          </div>
        )}

        <div className="ob-body">{body}</div>
        </div>
        </div>

        <footer className="ob-foot">
          <IconArrowRight size={11} />
          Enter moves you forward, Escape offers the way out. Everything here can be changed later.
        </footer>
      </div>
    </div>
  );
}
