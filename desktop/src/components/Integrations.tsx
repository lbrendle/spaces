/**
 * Integrations — the supported agents, and the state of each on this Mac.
 *
 * Adding an agent used to mean opening a form and knowing things the form did
 * not tell you: that Muse is an "external app", that its bundle identifier is
 * com.meta.endo, that Cursor's binary is called cursor-agent. This row answers
 * the question people actually arrive with — *what can I run here, and can I
 * run it right now* — and then does the setup.
 *
 * Each card is honest about one of four states, because they need different
 * things from the reader: ready (add it), not installed (install it, and here
 * is the command), signed out (sign in), and unknown (Spaces has no verified
 * way to check, so it says so rather than implying a green light).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { INTEGRATIONS, agentFromIntegration, type Integration } from "../integrations";
import { checkHarness, forgetHealth, type HarnessHealth } from "../doctor";
import { harnessFor } from "../capabilities";
import type { Agent } from "../types";
import { toast } from "../toast";
import { HarnessMark } from "./Face";
import { Spinner } from "./ui";
import "./integrations.css";

/** A synthetic agent carrying just what the doctor reads. */
function probeAgent(integration: Integration): Agent {
  const row = agentFromIntegration(integration, []);
  return { id: "probe", name: row.name, kind: row.kind, model: row.model, cli_args: row.cli_args } as Agent;
}

export function Integrations({ onAdded }: { onAdded?: (agent: Agent) => void }) {
  const agents = useStore((s) => s.agents);
  const [health, setHealth] = useState<Record<string, HarnessHealth>>({});
  const [busy, setBusy] = useState("");
  const [checking, setChecking] = useState(false);
  // Monotonic token, so a slow probe cannot overwrite a newer sweep.
  const req = useRef(0);

  const sweep = useCallback(async (fresh: boolean) => {
    const token = ++req.current;
    setChecking(true);
    if (fresh) forgetHealth();
    try {
      const results = await Promise.all(
        INTEGRATIONS.map(async (i) => [i.id, await checkHarness(i.kind, probeAgent(i))] as const)
      );
      if (token === req.current) setHealth(Object.fromEntries(results));
    } finally {
      if (token === req.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void sweep(false);
  }, [sweep]);

  async function add(integration: Integration) {
    setBusy(integration.id);
    try {
      const row = agentFromIntegration(
        integration,
        agents.map((a) => a.name)
      );
      const created = await useStore.getState().addAgent(row);
      toast.success(
        `${created.name} is on the roster`,
        harnessFor(integration.kind).wire === "external"
          ? "Spaces won't launch it — address it in a channel and it gets a brief in the repository."
          : "Add it to a channel and @-mention it to give it work."
      );
      onAdded?.(created);
    } catch (e) {
      toast.error(`Could not add ${integration.label}`, e);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="ig">
      <div className="ig-head">
        <div>
          <h3 className="ig-title">Add an agent</h3>
          <p className="ig-sub">
            Every one Spaces supports, and whether it can run from this Mac right now. Each uses
            the account already signed in here — no API key is involved.
          </p>
        </div>
        <button className="btn tiny" onClick={() => void sweep(true)} disabled={checking}>
          {checking ? <Spinner /> : "⟳"} Re-check
        </button>
      </div>

      <div className="ig-grid">
        {INTEGRATIONS.map((integration) => (
          <IntegrationCard
            key={integration.id}
            integration={integration}
            health={health[integration.id] ?? null}
            existing={agents.filter((a) => a.kind === integration.kind && matches(a, integration))}
            busy={busy === integration.id}
            onAdd={() => void add(integration)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Whether an existing agent came from this integration. Several integrations
 * share the `external` harness, so the kind alone cannot tell Muse from Zed —
 * the app name is what separates them.
 */
function matches(agent: Agent, integration: Integration): boolean {
  if (harnessFor(integration.kind).wire !== "external") return true;
  return agent.model.trim().toLowerCase() === (integration.model ?? "").toLowerCase();
}

function IntegrationCard({
  integration,
  health,
  existing,
  busy,
  onAdd,
}: {
  integration: Integration;
  health: HarnessHealth | null;
  existing: Agent[];
  busy: boolean;
  onAdd: () => void;
}) {
  const state = health?.state ?? "checking";
  /*
   * Nothing here blocks adding, on purpose.
   *
   * Agents belong to the workspace, not to a machine: one whose runtime is not
   * on this Mac is still perfectly real, and any paired machine that has it can
   * run it. Spaces says exactly that everywhere else — "recording it here is
   * fine; it will not run until that CLI is installed there" — so a disabled
   * button here would be this view contradicting the rest of the app. The state
   * line and the install hint inform the decision; they do not make it.
   */
  const missing = state === "missing";

  return (
    <div className={`ig-card ig-${state}`}>
      <div className="ig-card-head">
        <span className="ig-mark">
          <HarnessMark kind={integration.kind} size={18} />
        </span>
        <div className="ig-id">
          <span className="ig-name">{integration.label}</span>
          <span className="ig-kind">{harnessFor(integration.kind).label}</span>
        </div>
        <span className={`ig-dot ig-dot-${state}`} aria-hidden="true" />
      </div>

      <p className="ig-blurb">{integration.blurb}</p>

      <p className="ig-state">
        {health ? health.detail : "Checking this machine…"}
      </p>

      <div className="ig-actions">
        <button className="btn tiny primary" onClick={onAdd} disabled={busy}>
          {busy ? <Spinner /> : null} Add{existing.length ? " another" : ""}
        </button>
        {existing.length > 0 && (
          <span className="ig-have">
            {existing.length} on the roster
          </span>
        )}
        {missing && integration.installHint && (
          <code className="ig-hint">{integration.installHint}</code>
        )}
      </div>
    </div>
  );
}
