/**
 * The single mount point for src/toast.ts: the bottom-right toast stack and the
 * confirm dialog. App.tsx renders <Toasts /> once — nothing else imports it,
 * and nothing else needs to: code reports through the `toast` facade.
 *
 * Portalled to <body> so it clears every stacking context in the shell, and the
 * live region stays mounted even when empty (screen readers only announce into
 * a region that already existed).
 */
import "./toast.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconInfo, IconX } from "./icons";
import { Spinner } from "./ui";
import { useToasts, type ConfirmRequest, type Toast } from "../toast";

/** Anything past this collapses behind "+N more" — four is already a lot to read. */
const VISIBLE = 4;
/** Matches --dur; only decides when the node unmounts, so drift is harmless. */
const EXIT_MS = 200;

const IconAlert = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 3.6L21 19.5H3L12 3.6z" />
    <path d="M12 10v4M12 17.2v.2" />
  </svg>
);

function glyphFor(t: Toast) {
  if (t.pending) return <Spinner />;
  if (t.kind === "success") return <IconCheck size={15} />;
  if (t.kind === "warn" || t.kind === "error") return <IconAlert size={16} />;
  return <IconInfo size={16} />;
}

interface Row {
  toast: Toast;
  leaving: boolean;
}

/** Keeps a dismissed toast mounted long enough to animate out. */
function useExitBuffer(live: Toast[]): Row[] {
  const [leaving, setLeaving] = useState<Toast[]>([]);
  const previous = useRef<Toast[]>(live);
  const handles = useRef<number[]>([]);

  useEffect(() => {
    const gone = previous.current.filter((t) => !live.some((l) => l.id === t.id));
    previous.current = live;
    if (!gone.length) return;
    setLeaving((cur) => [...cur, ...gone]);
    // Not cleaned up on re-run: cancelling here would strand the ghost forever.
    handles.current.push(
      window.setTimeout(() => {
        setLeaving((cur) => cur.filter((t) => !gone.some((g) => g.id === t.id)));
      }, EXIT_MS)
    );
  }, [live]);

  useEffect(() => () => handles.current.forEach(clearTimeout), []);

  return useMemo(() => {
    const rows: Row[] = [
      ...live.map((toast) => ({ toast, leaving: false })),
      ...leaving.map((toast) => ({ toast, leaving: true })),
    ];
    return rows.sort((a, b) => b.toast.createdAt - a.toast.createdAt);
  }, [live, leaving]);
}

function ToastCard({ toast, leaving }: Row) {
  const pause = useToasts((s) => s.pause);
  const resume = useToasts((s) => s.resume);
  const dismiss = useToasts((s) => s.dismiss);
  const loud = toast.kind === "warn" || toast.kind === "error";

  return (
    <div
      className={`tst tst-${toast.kind}${leaving ? " tst-leaving" : ""}`}
      role={loud ? "alert" : "status"}
      onMouseEnter={() => pause(toast.id)}
      onMouseLeave={() => resume(toast.id)}
      onFocusCapture={() => pause(toast.id)}
      onBlurCapture={() => resume(toast.id)}
    >
      <span className="tst-glyph">{glyphFor(toast)}</span>
      <div className="tst-copy">
        <div className="tst-title">
          {toast.title}
          {toast.count > 1 && <span className="tst-count">×{toast.count}</span>}
        </div>
        {toast.detail && <div className="tst-detail">{toast.detail}</div>}
        {toast.action && (
          <button
            className="tst-action"
            onClick={() => {
              toast.action?.run();
              dismiss(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button className="tst-close" onClick={() => dismiss(toast.id)} aria-label={`Dismiss: ${toast.title}`}>
        <IconX size={13} />
      </button>
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const answer = useToasts((s) => s.answer);
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const close = useCallback((ok: boolean) => answer(request.id, ok), [answer, request.id]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Land on the safe choice: no destructive action is ever one Enter away.
    cancel.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const nodes = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const escaping = e.shiftKey ? active === first || !box.current.contains(active) : active === last;
      if (escaping) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };

    // Capture phase so view-level shortcuts never see keys aimed at the dialog.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [close]);

  const titleId = `tcf-title-${request.id}`;
  const bodyId = `tcf-body-${request.id}`;

  return (
    <div
      className="tcf-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close(false)}
    >
      <div
        className="tcf"
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.body ? bodyId : undefined}
      >
        <div className="tcf-title" id={titleId}>
          {request.title}
        </div>
        {request.body && (
          <div className="tcf-body" id={bodyId}>
            {request.body}
          </div>
        )}
        <div className="tcf-actions">
          <button className="btn" ref={cancel} onClick={() => close(false)}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={`btn ${request.danger ? "danger" : "primary"}`}
            onClick={() => close(true)}
          >
            {request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const live = useToasts((s) => s.toasts);
  const request = useToasts((s) => s.confirms[0] ?? null);
  const rows = useExitBuffer(live);
  const [expanded, setExpanded] = useState(false);

  const hidden = Math.max(0, rows.length - VISIBLE);
  useEffect(() => {
    if (!hidden) setExpanded(false);
  }, [hidden]);

  const shown = expanded ? rows : rows.slice(0, VISIBLE);

  return createPortal(
    <>
      <div className="tst-stack">
        <div
          className={`tst-list${expanded ? " tst-expanded" : ""}`}
          aria-live="polite"
          aria-relevant="additions text"
        >
          {shown.map((row) => (
            <ToastCard key={row.toast.id} toast={row.toast} leaving={row.leaving} />
          ))}
        </div>
        {hidden > 0 && (
          <button className="tst-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? "Show fewer" : `+${hidden} more`}
          </button>
        )}
      </div>
      {request && <ConfirmDialog key={request.id} request={request} />}
    </>,
    document.body
  );
}

export default Toasts;
