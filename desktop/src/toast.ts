/**
 * The feedback layer: transient toasts, plus the one blocking question the app
 * is allowed to ask.
 *
 * Deliberately dependency-free (zustand only) so any module — store actions,
 * run plumbing, github.ts — can report an outcome without dragging in React or
 * the database. Timers live here rather than in the component so a toast
 * collapsed behind "+N more" still expires on schedule.
 */
import { create } from "zustand";

export type ToastKind = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  detail?: string;
  /** ms until auto-dismiss. 0 keeps it until the user (or code) closes it. */
  timeout?: number;
  action?: ToastAction;
  /** Work still in flight: spins, never expires. See `toast.promise`. */
  pending?: boolean;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  timeout: number;
  action?: ToastAction;
  pending?: boolean;
  /** Identical repeats collapse into one card with a ×N badge. */
  count: number;
  createdAt: number;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red; use for anything that destroys data. */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: string;
  resolve(ok: boolean): void;
}

/** Long enough to read a sentence, short enough not to nag. */
const DEFAULT_TIMEOUT = 5000;
/** An offered action needs reaching for, so the card waits a little longer. */
const ACTION_BONUS = 3000;
/** Beyond this the stack is noise; the oldest fall off the back. */
const MAX_TOASTS = 12;

function defaultTimeout(kind: ToastKind, hasAction: boolean): number {
  if (kind === "error") return 0; // errors are the whole reason this layer exists
  return DEFAULT_TIMEOUT + (hasAction ? ACTION_BONUS : 0);
}

/** Best-effort human text for whatever a rejected promise carried. */
export function errorText(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

let seq = 0;
const nextId = (): string => `tst-${++seq}-${Date.now().toString(36)}`;

interface Timer {
  handle: number;
  /** ms left when paused; the full duration while running. */
  remaining: number;
  startedAt: number;
}
const timers = new Map<string, Timer>();

function disarm(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t.handle);
  timers.delete(id);
}

function arm(id: string, ms: number): void {
  disarm(id);
  if (!ms || !Number.isFinite(ms)) return;
  const handle = window.setTimeout(() => {
    timers.delete(id);
    useToasts.getState().dismiss(id);
  }, ms);
  timers.set(id, { handle, remaining: ms, startedAt: Date.now() });
}

interface ToastState {
  /** Newest first. */
  toasts: Toast[];
  /** FIFO; only the head is on screen. */
  confirms: ConfirmRequest[];

  show(input: ToastInput): string;
  update(id: string, patch: Partial<Omit<Toast, "id">>): void;
  dismiss(id: string): void;
  clear(): void;
  /** Hover/focus freezes the countdown so you can finish reading. */
  pause(id: string): void;
  resume(id: string): void;

  ask(options: ConfirmOptions): Promise<boolean>;
  answer(id: string, ok: boolean): void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  confirms: [],

  show(input) {
    const kind = input.kind ?? "info";
    const timeout = input.timeout ?? defaultTimeout(kind, !!input.action);
    const { toasts } = get();

    // A retry loop that fails every second should read "×7", not stack seven
    // cards. Pending toasts are bound to a specific promise, so never merge.
    const twin = input.pending
      ? undefined
      : toasts.find(
          (t) => !t.pending && t.kind === kind && t.title === input.title && t.detail === input.detail
        );
    if (twin) {
      const bumped: Toast = {
        ...twin,
        count: twin.count + 1,
        action: input.action ?? twin.action,
        timeout,
        createdAt: Date.now(),
      };
      set({ toasts: [bumped, ...toasts.filter((t) => t.id !== twin.id)] });
      arm(twin.id, timeout);
      return twin.id;
    }

    const t: Toast = {
      id: nextId(),
      kind,
      title: input.title,
      detail: input.detail,
      timeout,
      action: input.action,
      pending: input.pending,
      count: 1,
      createdAt: Date.now(),
    };
    for (const dropped of toasts.slice(MAX_TOASTS - 1)) disarm(dropped.id);
    set({ toasts: [t, ...toasts].slice(0, MAX_TOASTS) });
    arm(t.id, t.pending ? 0 : timeout);
    return t.id;
  },

  update(id, patch) {
    const { toasts } = get();
    const cur = toasts.find((t) => t.id === id);
    if (!cur) return;
    const next: Toast = { ...cur, ...patch };
    set({ toasts: toasts.map((t) => (t.id === id ? next : t)) });
    arm(id, next.pending ? 0 : next.timeout);
  },

  dismiss(id) {
    disarm(id);
    const { toasts } = get();
    if (!toasts.some((t) => t.id === id)) return;
    set({ toasts: toasts.filter((t) => t.id !== id) });
  },

  clear() {
    for (const t of get().toasts) disarm(t.id);
    set({ toasts: [] });
  },

  pause(id) {
    const t = timers.get(id);
    if (!t || !t.handle) return;
    clearTimeout(t.handle);
    timers.set(id, {
      handle: 0,
      remaining: Math.max(400, t.remaining - (Date.now() - t.startedAt)),
      startedAt: 0,
    });
  },

  resume(id) {
    const t = timers.get(id);
    if (!t || t.handle) return;
    arm(id, t.remaining);
  },

  ask(options) {
    return new Promise<boolean>((resolve) => {
      set({ confirms: [...get().confirms, { ...options, id: nextId(), resolve }] });
    });
  },

  answer(id, ok) {
    const req = get().confirms.find((c) => c.id === id);
    if (!req) return;
    set({ confirms: get().confirms.filter((c) => c.id !== id) });
    req.resolve(ok);
  },
}));

export interface PromiseMessages<T> {
  pending: string;
  /** Omit to simply dismiss the pending toast on success. */
  success?: string | ((value: T) => string);
  error?: string | ((err: unknown) => string);
}

/**
 * Imperative facade. Import this, not the hook, from non-React modules:
 *   toast.error("Could not delete channel", e)
 */
export const toast = {
  show: (input: ToastInput): string => useToasts.getState().show(input),
  update: (id: string, patch: Partial<Omit<Toast, "id">>): void =>
    useToasts.getState().update(id, patch),
  dismiss: (id: string): void => useToasts.getState().dismiss(id),
  clear: (): void => useToasts.getState().clear(),

  info: (title: string, detail?: string): string =>
    useToasts.getState().show({ kind: "info", title, detail }),
  success: (title: string, detail?: string): string =>
    useToasts.getState().show({ kind: "success", title, detail }),
  warn: (title: string, detail?: string): string =>
    useToasts.getState().show({ kind: "warn", title, detail }),
  /** `detail` takes a caught value directly, so `catch (e)` sites stay one-liners. */
  error: (title: string, detail?: unknown): string =>
    useToasts.getState().show({
      kind: "error",
      title,
      detail: detail === undefined ? undefined : errorText(detail) || undefined,
    }),

  /** Tracks a promise in one card. Re-throws so callers keep their own control flow. */
  promise<T>(p: Promise<T>, msgs: PromiseMessages<T>): Promise<T> {
    const id = useToasts.getState().show({ kind: "info", title: msgs.pending, pending: true });
    return p.then(
      (value) => {
        const title = typeof msgs.success === "function" ? msgs.success(value) : msgs.success;
        if (title) {
          useToasts
            .getState()
            .update(id, { kind: "success", title, detail: undefined, pending: false, timeout: DEFAULT_TIMEOUT });
        } else {
          useToasts.getState().dismiss(id);
        }
        return value;
      },
      (err: unknown) => {
        const title = typeof msgs.error === "function" ? msgs.error(err) : msgs.error;
        const detail = errorText(err);
        useToasts.getState().update(id, {
          kind: "error",
          title: title ?? "Something went wrong",
          detail: detail && detail !== title ? detail : undefined,
          pending: false,
          timeout: 0,
        });
        throw err;
      }
    );
  },
};

/**
 * Ask before doing something the user cannot take back. Resolves false on
 * Escape, backdrop click, or Cancel — the safe answer is always the default.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return useToasts.getState().ask(options);
}
