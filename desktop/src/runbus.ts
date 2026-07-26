/**
 * Tiny registry so store.ts can cancel in-flight agent runs (on channel/agent
 * delete) without importing agents.ts — which imports store.ts.
 */
export interface RunHandle {
  runId: string;
  channelId: string;
  agentId: string;
}

type Canceller = (runId: string) => void;

const handles = new Map<string, RunHandle>();
let canceller: Canceller | null = null;

export function registerCanceller(fn: Canceller) {
  canceller = fn;
}

export function trackRun(h: RunHandle) {
  handles.set(h.runId, h);
}

export function untrackRun(runId: string) {
  handles.delete(runId);
}

export function activeRunFor(channelId: string, agentId: string): RunHandle | undefined {
  for (const h of handles.values()) {
    if (h.channelId === channelId && h.agentId === agentId) return h;
  }
  return undefined;
}

export function cancelRunsWhere(pred: (h: RunHandle) => boolean) {
  for (const h of [...handles.values()]) {
    if (pred(h)) canceller?.(h.runId);
  }
}
