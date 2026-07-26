/**
 * Concurrency and spend guards.
 *
 * Every agent run is a real OS process talking to a metered subscription. A
 * six-agent `@all`, or a lead delegating to five teammates that each chain
 * further, would otherwise spawn an unbounded fan-out on a laptop. These caps
 * make parallelism useful instead of thrashy, and make a runaway loop cost
 * seconds rather than an afternoon.
 */

/** Simultaneous agent processes across the whole app. */
export const MAX_CONCURRENT_RUNS = 3;

/** Agents a single dispatch may fan out to at once (lead delegation, panels). */
export const MAX_FANOUT = 4;

/** Runs started in one rolling window before Spaces refuses to start more. */
export const RUN_BUDGET = { max: 40, windowMs: 10 * 60_000 };

let active = 0;
const waiting: (() => void)[] = [];
const recentStarts: number[] = [];

export class BudgetExceeded extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BudgetExceeded";
  }
}

function pruneWindow(nowMs: number) {
  const cutoff = nowMs - RUN_BUDGET.windowMs;
  while (recentStarts.length && recentStarts[0] < cutoff) recentStarts.shift();
}

/** How many runs are still allowed in the current window. */
export function budgetRemaining(nowMs: number): number {
  pruneWindow(nowMs);
  return Math.max(0, RUN_BUDGET.max - recentStarts.length);
}

export function activeRuns(): number {
  return active;
}

/**
 * Acquire a run slot, waiting if the app is already at capacity.
 * Returns a release function that MUST be called in a finally block.
 * Throws BudgetExceeded if the rolling run budget is spent — that is a
 * runaway-loop backstop, not a queue, so it fails loudly rather than waiting.
 */
export async function acquireRunSlot(nowMs: number): Promise<() => void> {
  if (budgetRemaining(nowMs) <= 0) {
    throw new BudgetExceeded(
      `Run budget reached (${RUN_BUDGET.max} runs in ${Math.round(RUN_BUDGET.windowMs / 60000)} minutes). ` +
      `This usually means agents are triggering each other in a loop. Nothing was started.`
    );
  }
  recentStarts.push(nowMs);

  if (active >= MAX_CONCURRENT_RUNS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;

  let released = false;
  return () => {
    if (released) return; // releasing twice would corrupt the count
    released = true;
    active--;
    const next = waiting.shift();
    if (next) next();
  };
}

/**
 * Run `tasks` with at most MAX_FANOUT in flight, preserving result order.
 * Used wherever the orchestrator would otherwise Promise.all over a roster.
 */
export async function boundedAll<T>(
  tasks: (() => Promise<T>)[],
  limit = MAX_FANOUT
): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

/** Reset — tests only. */
export function __resetLimits() {
  active = 0;
  waiting.length = 0;
  recentStarts.length = 0;
}
