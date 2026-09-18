/**
 * threading.ts — which messages a turn in a thread is actually about.
 *
 * Pure and import-free, like `gitparse.ts` and `sessionpaths.ts`, because the
 * failure here is silent: an agent given the wrong slice still answers, it
 * just answers without the question. The bug this exists to prevent was
 * exactly that — a reply in a thread was shown the channel's last twenty-five
 * messages and nothing else, so a thread that started a hundred messages back
 * arrived with its own opening missing.
 */

/** The little a thread needs to know about a message. */
export interface Threadable {
  id: string;
  parent_id: string;
  status?: string;
}

export interface ThreadSlice<T> {
  /** Root first, then replies, with the middle dropped when it is long. */
  messages: T[];
  /** How many were left out between the head and the tail. */
  elided: number;
}

/**
 * The messages of one thread, in order, trimmed from the middle.
 *
 * Head and tail rather than just the tail: the opening message is what the
 * thread is *for*, and dropping it to save room removes the one line that
 * makes the rest interpretable. The end is where the thread got to, which is
 * what the turn is replying to.
 *
 * `exclude` is the message that triggered this turn — it is quoted separately
 * as the thing being answered, and quoting it twice makes an agent think it
 * has already been asked.
 */
export function threadSlice<T extends Threadable>(
  all: readonly T[],
  rootId: string,
  exclude: string,
  limit: number
): ThreadSlice<T> {
  if (!rootId) return { messages: [], elided: 0 };

  const root = all.find((m) => m.id === rootId);
  const replies = all.filter(
    (m) => m.parent_id === rootId && m.id !== exclude && m.status !== "running"
  );
  // A root that is itself the trigger, or still running, is not quoted — but
  // its replies are still the thread.
  const head = root && root.id !== exclude && root.status !== "running" ? [root] : [];
  const thread = [...head, ...replies];

  if (thread.length <= limit || limit < 2) {
    return { messages: thread, elided: 0 };
  }
  const front = thread.slice(0, Math.floor(limit / 2));
  const back = thread.slice(-Math.ceil(limit / 2));
  return {
    messages: [...front, ...back],
    elided: thread.length - front.length - back.length,
  };
}
