/**
 * Who can see a document.
 *
 * Documents used to be visible to everyone with the app open, which was fine
 * while "everyone" meant one person. These three controls give them the same
 * ownership model calendars have — an owner, a default, and a list of people,
 * teams and agents named individually — and try to make the answer legible
 * without opening anything: the button in a document's header says what is
 * true right now, and the badge says it again in a list row.
 *
 * The panel leads with a sentence rather than a matrix. Sharing settings are
 * read far more often than they are changed, and the question people arrive
 * with is "wait, who can see this?" — so that is answered first, in words,
 * before any control asks them to decide something.
 *
 * It opens beside the document, not over it. "Who should reach this?" is a
 * question about the text, and the answer changes when you can see what the
 * text actually says — a dialog covering it is a dialog asking you to grant
 * access to something you are no longer looking at.
 *
 * Agents sit in the same list as people on purpose. An agent that can read a
 * document is how the document reaches a run, so hiding that decision in a
 * different surface would mean granting it by accident.
 */
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useStore } from "../store";
import { KIND_BY_TYPE, describeEntity } from "../entities";
import { localMember } from "../calendars";
import { confirmAction, toast } from "../toast";
import {
  docShareState, docSharesVersion, ensureDocShares, setDocOwner, setDocShare,
  setDocVisibility, sharesFor, subscribeDocShares,
} from "../docshares";
import type { DocShareState, DocVisibility } from "../docshares";
import { PanelSection, SidePanel, usePanel } from "./SidePanel";
import type { DocShare, EntityRef, ShareAccess } from "../types";
import "./docshare.css";

/* ── vocabulary ───────────────────────────────────────────────── */

const VISIBILITY: { id: DocVisibility; label: string; blurb: string }[] = [
  {
    id: "private",
    label: "Private",
    blurb:
      "Nobody else sees it — not the text, not the title, not that it exists — except the people, " +
      "teams and agents named below.",
  },
  {
    id: "workspace",
    label: "Workspace",
    blurb:
      "Everyone in the workspace can open and read it. Editing still takes a share of its own, so a " +
      "document everybody can see is not a document anybody can rewrite.",
  },
];

const ACCESS_LABEL: Record<ShareAccess, string> = {
  read: "Read — can open it",
  write: "Write — can open and edit it",
};

const ACCESS_SHORT: Record<ShareAccess, string> = { read: "read", write: "write" };

/** New shares start here: the tier that cannot lose anybody's work. */
const DEFAULT_SHARE: ShareAccess = "read";

/**
 * How open the document is, drawn as how open the circle is: filled for shut,
 * half for a named few, hollow for the whole workspace.
 */
function glyphFor(state: DocShareState): string {
  if (state.visibility === "workspace") return "○";
  return state.shares.length ? "◐" : "●";
}

function toneClass(state: DocShareState): string {
  if (state.visibility === "workspace") return "ds-open";
  return state.shares.length ? "ds-some" : "ds-shut";
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* ── reading the current state ────────────────────────────────── */

/**
 * One document's sharing, re-rendered whenever it changes.
 *
 * Deliberately cheap: the shared cache is primed once for the whole app, so a
 * hundred list rows mounting this do not make a hundred queries.
 */
function useDocSharing(documentId: string): DocShareState {
  const version = useSyncExternalStore(subscribeDocShares, docSharesVersion, docSharesVersion);
  // The roster decides who "you" is, and it arrives asynchronously — without
  // this the first paint of a badge would keep its guess at ownership forever.
  const members = useStore((s) => s.members);
  useEffect(() => {
    void ensureDocShares().catch(() => {});
  }, []);
  return useMemo(() => docShareState(documentId), [documentId, version, members]);
}

/** A member's name from the roster; everything else from the entity graph. */
function useSubjectName(): (ref: EntityRef) => { name: string; exists: boolean } {
  const members = useStore((s) => s.members);
  const me = localMember().id;
  return (ref) => {
    if (ref.type === "member") {
      if (ref.id === me) return { name: "You", exists: true };
      const m = members.find((x) => x.id === ref.id);
      return { name: m?.name || ref.id, exists: !!m };
    }
    const info = describeEntity(ref);
    return { name: info.exists ? info.title : ref.id, exists: info.exists };
  };
}

/* ── the header control ───────────────────────────────────────── */

/**
 * A document header's sharing control: the current state as a word, and the
 * way into changing it.
 */
export function DocShareButton({ documentId }: { documentId: string }) {
  const state = useDocSharing(documentId);
  const nameOf = useSubjectName();
  const panel = usePanel();

  const owner = nameOf({ type: "member", id: state.ownerId });
  const title = state.isOwner
    ? `You own this document — ${state.label.toLowerCase()}`
    : `${owner.name} owns this document — you have ${
        state.access ? ACCESS_SHORT[state.access] : "no"
      } access`;

  return (
    <>
      <button
        type="button"
        className={"btn subtle ds-btn " + toneClass(state)}
        // Not aria-haspopup: nothing pops up. The panel opens beside this
        // toolbar and the document stays where it is, so the button is a
        // toggle for a region rather than the way into a dialog.
        aria-expanded={panel.open}
        title={title}
        onClick={() => panel.toggle()}
      >
        <span className="ds-glyph" aria-hidden="true">{glyphFor(state)}</span>
        {state.label}
      </button>
      {panel.open && <DocSharePanel documentId={documentId} onClose={panel.hide} />}
    </>
  );
}

/* ── the list-row indicator ───────────────────────────────────── */

/** A tiny inline marker for a document in a list. */
export function DocAccessBadge({ documentId }: { documentId: string }) {
  const state = useDocSharing(documentId);
  const nameOf = useSubjectName();

  if (!state.isOwner) {
    const owner = nameOf({ type: "member", id: state.ownerId });
    return (
      <span className="ds-badge ds-shared" title={`${owner.name} shared this with you`}>
        <span className="ds-glyph" aria-hidden="true">◈</span>
        {state.access ? ACCESS_SHORT[state.access] : "no access"}
      </span>
    );
  }

  return (
    <span className={"ds-badge " + toneClass(state)} title={`Yours — ${state.label.toLowerCase()}`}>
      <span className="ds-glyph" aria-hidden="true">{glyphFor(state)}</span>
      {state.visibility === "workspace"
        ? "Workspace"
        : state.shares.length
          ? `${state.shares.length} shared`
          : "Private"}
    </span>
  );
}

/* ── the panel ────────────────────────────────────────────────── */

export function DocSharePanel({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const state = useDocSharing(documentId);
  const nameOf = useSubjectName();
  const members = useStore((s) => s.members);
  const ownerFieldId = useId();

  // The cache is enough to draw with, but a panel is where somebody is about
  // to make a decision — so re-read this document's shares from the database
  // rather than trusting whatever the last write left behind.
  useEffect(() => {
    void sharesFor(documentId).catch(() => {});
  }, [documentId]);

  const owner = nameOf({ type: "member", id: state.ownerId });
  const roster = members.filter((m) => m.status !== "removed");

  const changeOwner = async (nextId: string) => {
    if (!nextId || nextId === state.ownerId) return;
    const who = nameOf({ type: "member", id: nextId }).name;
    const previous = state.ownerId;
    const ok = await confirmAction({
      title: `Make ${who} the owner?`,
      body:
        `From then on they decide who may see it. ${
          previous === localMember().id ? "You keep" : `${owner.name} keeps`
        } a write share, listed below, so the document does not drop out of ` +
        "that list — remove it afterwards if you meant to hand it over completely.",
      confirmLabel: "Transfer",
    });
    if (!ok) return;
    try {
      await setDocOwner(documentId, nextId);
      await setDocShare(documentId, { type: "member", id: previous }, "write");
      toast.success(`${who} owns this document now`);
    } catch (e) {
      toast.error("Could not change the owner", e);
    }
  };

  const changeVisibility = async (v: DocVisibility) => {
    try {
      await setDocVisibility(documentId, v);
    } catch (e) {
      toast.error("Could not change who can see it", e);
    }
  };

  return (
    /* Every control here writes on change, so there is nothing to confirm and
       no footer: the panel's own close is the way out, and closing it cannot
       lose an edit that was never pending. */
    <SidePanel title="Who can see this document" onClose={onClose} storageKey="docshare">
      <Summary state={state} nameOf={nameOf} ownerName={owner.name} />

      {!state.isOwner ? (
        <p className="ds-hint">
          <strong>{owner.name}</strong> owns this document, so only they can change its sharing.
        </p>
      ) : (
        <>
          <PanelSection title="Owner">
            <p className="ds-note">
              {state.adopted
                ? "This document predates owners, so it is treated as yours until somebody says otherwise."
                : "The one person who decides everything below."}
            </p>
            <select
              id={ownerFieldId}
              className="ds-owner"
              aria-label="Owner of this document"
              value={state.ownerId}
              onChange={(e) => void changeOwner(e.target.value)}
            >
              {roster.some((m) => m.id === state.ownerId) ? null : (
                <option value={state.ownerId}>{owner.name}</option>
              )}
              {roster.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === localMember().id ? `${m.name} (you)` : m.name}
                </option>
              ))}
            </select>
          </PanelSection>

          <PanelSection title="Everyone else">
            <p className="ds-note">
              The default for anyone in the workspace who has no share of their own below.
            </p>
            <VisibilityChoice
              documentId={documentId}
              current={state.visibility}
              onPick={(v) => void changeVisibility(v)}
            />
          </PanelSection>

          <PanelSection title="Shared with">
            <p className="ds-note">
              New shares start at “{ACCESS_LABEL.read}” — raise one deliberately when you
              mean to.
            </p>
            <ShareList state={state} nameOf={nameOf} />
          </PanelSection>
        </>
      )}
    </SidePanel>
  );
}

/* ── the sentence ─────────────────────────────────────────────── */

/**
 * Who can see it right now, in words.
 *
 * Assembled from the same values the controls below are bound to, so it cannot
 * drift out of step with them — the failure mode of a hand-written summary is
 * that it keeps describing the settings somebody just changed.
 */
function Summary({
  state,
  nameOf,
  ownerName,
}: {
  state: DocShareState;
  nameOf: (ref: EntityRef) => { name: string; exists: boolean };
  ownerName: string;
}) {
  const named = state.shares.map((s) => ({
    name: nameOf({ type: s.subject_type, id: s.subject_id }).name,
    access: s.access,
  }));
  const writers = named.filter((n) => n.access === "write").map((n) => n.name);

  const editors = writers.length
    ? `${joinNames(["You", ...writers])} can edit it.`
    : "You are the only one who can edit it.";

  let text: string;
  if (!state.isOwner) {
    text = state.access
      ? `${ownerName} owns this. You can ${
          state.access === "write" ? "read and edit it" : "read it"
        }.`
      : `${ownerName} owns this, and it is not shared with you.`;
  } else if (state.visibility === "workspace") {
    text = `Everyone in the workspace can read this. ${editors}`;
  } else if (named.length) {
    text = `Only ${joinNames(["you", ...named.map((n) => n.name)])} can see this. ${editors}`;
  } else {
    text = "Only you can see this. It does not appear in anybody else's documents.";
  }

  return (
    <p className={"ds-summary " + toneClass(state)}>
      <span className="ds-glyph" aria-hidden="true">{glyphFor(state)}</span>
      {text}
    </p>
  );
}

/* ── controls ─────────────────────────────────────────────────── */

function VisibilityChoice({
  documentId,
  current,
  onPick,
}: {
  documentId: string;
  current: DocVisibility;
  onPick: (v: DocVisibility) => void;
}) {
  const group = `ds-vis-${documentId}`;
  return (
    <div className="ds-tiers" role="radiogroup" aria-label="Default access for this document">
      {VISIBILITY.map((tier) => (
        <label key={tier.id} className={"ds-tier" + (current === tier.id ? " on" : "")}>
          <input
            type="radio"
            name={group}
            checked={current === tier.id}
            onChange={() => onPick(tier.id)}
          />
          <span className="ds-tier-body">
            <span className="ds-tier-label">{tier.label}</span>
            <span className="ds-tier-blurb">{tier.blurb}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ShareList({
  state,
  nameOf,
}: {
  state: DocShareState;
  nameOf: (ref: EntityRef) => { name: string; exists: boolean };
}) {
  const members = useStore((s) => s.members);
  const teams = useStore((s) => s.teams);
  const agents = useStore((s) => s.agents);
  const addId = useId();

  const taken = new Set(state.shares.map((s) => `${s.subject_type}:${s.subject_id}`));

  // The owner already has write access by definition, so offering to share the
  // document back with them would only look like a setting that does nothing.
  const free = (type: DocShare["subject_type"], id: string) =>
    !taken.has(`${type}:${id}`) && !(type === "member" && id === state.ownerId);

  const groups: { label: string; items: { value: string; label: string }[] }[] = [
    {
      label: "People",
      items: members
        .filter((m) => m.status !== "removed" && free("member", m.id))
        .map((m) => ({ value: `member:${m.id}`, label: m.name })),
    },
    {
      label: "Teams",
      items: teams
        .filter((t) => free("team", t.id))
        .map((t) => ({ value: `team:${t.id}`, label: t.name })),
    },
    {
      label: "Agents",
      items: agents
        .filter((a) => free("agent", a.id))
        .map((a) => ({ value: `agent:${a.id}`, label: a.name })),
    },
  ].filter((g) => g.items.length > 0);

  const set = async (ref: EntityRef, access: ShareAccess | null, who: string) => {
    try {
      await setDocShare(state.documentId, ref, access);
    } catch (e) {
      toast.error(access ? `Could not share with ${who}` : `Could not stop sharing with ${who}`, e);
    }
  };

  return (
    <div className="ds-shares">
      {state.shares.length === 0 ? (
        <div className="ds-empty">
          Nobody has a share of their own. Everyone gets the default above.
        </div>
      ) : (
        state.shares.map((share) => {
          const ref: EntityRef = { type: share.subject_type, id: share.subject_id };
          const { name, exists } = nameOf(ref);
          const kind = KIND_BY_TYPE[share.subject_type];
          return (
            <div key={`${share.subject_type}:${share.subject_id}`} className="ds-share">
              <span
                className="ds-share-glyph"
                style={{ color: kind.tone } as CSSProperties}
                aria-hidden="true"
              >
                {kind.glyph}
              </span>
              <span className={"ds-share-name" + (exists ? "" : " gone")}>{name}</span>
              {/* The level and the way to revoke it wrap as one: on a narrow
                  panel a lone ✕ on the next line reads as a control of its
                  own, and the only thing it could plausibly be removing is
                  the row above it. */}
              <span className="ds-share-set">
                <select
                  className="ds-share-access"
                  aria-label={`Access for ${name}`}
                  value={share.access}
                  onChange={(e) => void set(ref, e.target.value as ShareAccess, name)}
                >
                  {(Object.keys(ACCESS_LABEL) as ShareAccess[]).map((a) => (
                    <option key={a} value={a}>{ACCESS_LABEL[a]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Stop sharing with ${name}`}
                  onClick={() => void set(ref, null, name)}
                >
                  ✕
                </button>
              </span>
            </div>
          );
        })
      )}

      {groups.length > 0 && (
        <div className="ds-share-add">
          <label className="ds-sr" htmlFor={addId}>
            Share this document with a person, team or agent
          </label>
          <select
            id={addId}
            value=""
            onChange={(e) => {
              const value = e.target.value;
              if (!value) return;
              const cut = value.indexOf(":");
              const ref: EntityRef = {
                type: value.slice(0, cut) as EntityRef["type"],
                id: value.slice(cut + 1),
              };
              void set(ref, DEFAULT_SHARE, nameOf(ref).name);
            }}
          >
            <option value="">Share with…</option>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="ds-share-why">
            An agent that can read this document can use it during a run — that is how a document
            becomes an agent's working context.
          </span>
        </div>
      )}

      {state.visibility === "workspace" && state.shares.some((s) => s.access === "read") && (
        <p className="ds-hint ds-hint-tight">
          A share only ever raises access above the default — a read share adds nothing while
          everyone can already read it. To hold this back from somebody, make it private and share
          it with the others.
        </p>
      )}
    </div>
  );
}
