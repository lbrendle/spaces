/**
 * People.
 *
 * Spaces has always been communal and, until migration v15, had no way to say who
 * anybody was. Calendars, documents and agents all wanted an owner and there
 * was nothing to point at. This surface is that missing roster.
 *
 * Two facts shape every string in this file, and neither may be softened:
 *
 *   A person in a paired workspace is a real, authenticated member. The invite
 *   flow writes the email-bound invitation to the portal and does not pretend a
 *   local placeholder is an identity. Historical local-only rows remain
 *   removable so old attribution never becomes an unmanageable ghost.
 *
 *   An agent runs on a machine. Somebody's `claude` or `codex` CLI, signed in
 *   with their own subscription, on hardware that is sometimes asleep. So
 *   "bring an agent" is really "name a person, name a machine", and when that
 *   machine is off the run waits durably in the paired workspace. That exact
 *   host claims it when Spaces comes back, executes under its owner's existing
 *   CLI session, and returns the result. No API key exists anywhere.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { getDb, now } from "../db";
import { colorFor, slug } from "../types";
import type { Agent, Calendar, Device, Member, MemberRole } from "../types";
import { accessFor } from "../calendars";
import { workloadOf } from "../links";
import type { AssignmentView } from "../links";
import { confirmAction, toast } from "../toast";
import { timeAgo } from "../github";
import { HARNESSES, defaultsFor, harnessFor, serializeArgs } from "../capabilities";
import type { HarnessKind } from "../capabilities";
import { loadPortalConnection, portalMemberAction } from "../portal";
import { EntityChip } from "./EntityChip";
import { Field } from "./ui";
import { SidePanel, usePanel } from "./SidePanel";
import type { PanelStack } from "./SidePanel";
import { RadioChips } from "./LinkPicker";
import { IconInfo, IconPlus } from "./icons";
import "./people.css";
import {
  browserPlatform,
  currentPlatform,
  currentDeviceId as localDeviceId,
  rememberDeviceId as rememberLocalDevice,
} from "../deviceIdentity";

/* ── the v15 columns ─────────────────────────────────────────── */

/*
 * Migration v15's `owner_member_id`, `host_device_id` and `visibility` are
 * declared on `Agent` in types.ts now, so the local widening type and the two
 * casts that fed it are gone: ownership is read and written as itself.
 */

/** workspace = anybody here can use it; private = the owner's own. */
type AgentVisibility = Agent["visibility"];

/** The three columns that say whose an agent is and where it runs. */
type Ownership = Pick<Agent, "owner_member_id" | "host_device_id" | "visibility">;

/* ── small shared facts ──────────────────────────────────────── */

const ABOUT_KEY = "spaces.people.about";

const HARNESS_GLYPH: Record<string, string> = { claude: "✳", codex: "◈", ritz: "◉" };

/** What `check_tools` looks for, in the order a card should read them. */
const KNOWN_TOOLS = ["claude", "codex", "gh"] as const;

const ROLES: { role: MemberRole; label: string; help: string }[] = [
  { role: "owner", label: "Owner", help: "Set this workspace up." },
  { role: "admin", label: "Admin", help: "Looks after it day to day." },
  { role: "member", label: "Member", help: "Works here." },
  { role: "guest", label: "Guest", help: "Around for one project." },
];

const AVATAR_RAMP = Array.from({ length: 8 }, (_, i) => `var(--avatar-${i})`);

function roleLabel(role: string): string {
  return ROLES.find((r) => r.role === role)?.label ?? role;
}

/** Their chosen colour, or the theme's hashed ramp — always a token. */
function personColor(m: Member): string {
  return m.color || colorFor(m.id);
}

function initials(name: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** A device's tool map. A row that reported nonsense reported nothing. */
function parseTools(raw: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = value === true;
    }
    return out;
  } catch {
    return {};
  }
}

function machineGuess(platform: string): string {
  if (/mac|iphone|ipad/i.test(platform)) return "This Mac";
  if (/win/i.test(platform)) return "This PC";
  if (/linux/i.test(platform)) return "This Linux box";
  return "This machine";
}

/** Prefer a harness this machine can actually host, if any can. */
function preferHarness(tools: Record<string, boolean>): HarnessKind {
  if (tools.claude) return "claude";
  if (tools.codex) return "codex";
  return "claude";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ── rows ────────────────────────────────────────────────────── */

interface CalendarRow {
  calendar: Calendar;
  /** False when this viewer has no access, so the name must not be drawn. */
  visible: boolean;
}

interface PersonRow {
  member: Member;
  isSelf: boolean;
  agents: Agent[];
  devices: Device[];
  calendars: CalendarRow[];
  /** Everything they have been assigned. Empty today — see PersonDetail. */
  workload: AssignmentView[];
}

/**
 * Members hidden from the roster by a soft delete.
 *
 * `removeMember` sets status='removed' and the store stops loading them, but
 * their name is still on the agents, devices and calendars they brought. This
 * reads them straight from the database — there is no store action for it —
 * so a former colleague keeps being credited instead of turning into an id.
 */
function useFormerMembers(nonce: number): Member[] {
  const [rows, setRows] = useState<Member[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const db = await getDb();
        const found = await db.select<Member[]>(
          "SELECT * FROM members WHERE status = 'removed' ORDER BY name"
        );
        if (live) setRows(found);
      } catch {
        // Credit is a nicety; the roster must render without it.
      }
    })();
    return () => {
      live = false;
    };
  }, [nonce]);
  return rows;
}

/* ── the view ────────────────────────────────────────────────── */

export function PeopleView() {
  const members = useStore((s) => s.members);
  const devices = useStore((s) => s.devices);
  const agents = useStore((s) => s.agents);
  const calendars = useStore((s) => s.calendars);
  const calendarShares = useStore((s) => s.calendarShares);
  const assignments = useStore((s) => s.assignments);
  const updateDevice = useStore((s) => s.updateDevice);
  const removeMember = useStore((s) => s.removeMember);

  const self = members.find((m) => m.is_self === 1) ?? useStore.getState().self();
  const canInvite = self.role === "owner" || self.role === "admin";
  /*
   * Four panels, all holding an id rather than a row, and all sharing one
   * trailing edge — SidePanel guarantees only one is ever on screen, so these
   * do not have to close each other by hand. The person editor and the
   * bring-an-agent flow also appear *inside* the detail panel, stacked, which
   * is why both are components taking an optional `stack` rather than markup
   * written twice.
   */
  const detail = usePanel<string>();
  const editing = usePanel<string>();
  const adding = usePanel();
  const bringing = usePanel<{ ownerId: string; agentId?: string }>();
  const [gone, setGone] = useState(0);
  const former = useFormerMembers(gone);
  const localId = localDeviceId();

  /**
   * A heartbeat, once per visit. Only this machine can honestly report its own
   * PATH and the fact that it is running, so "last seen" is written here and
   * nowhere else — which is exactly why every other device's stamp is old.
   */
  const beat = useRef(false);
  useEffect(() => {
    if (beat.current) return;
    beat.current = true;
    const id = localDeviceId();
    if (!id) return;
    const state = useStore.getState();
    if (!state.devices.some((d) => d.id === id)) return;
    // An empty map means PATH detection failed, not that the CLIs went away —
    // keep what the last successful check reported rather than erasing it.
    const patch: Partial<Device> = Object.keys(state.tools).length
      ? { last_seen_at: now(), tools: JSON.stringify(state.tools) }
      : { last_seen_at: now() };
    void updateDevice(id, patch).catch(() => {
      // A missed heartbeat is not worth interrupting anybody over.
    });
  }, [updateDevice]);

  const rows = useMemo<PersonRow[]>(() => {
    return members.map((member) => ({
      member,
      isSelf: member.is_self === 1,
      agents: agents.filter((a) => a.owner_member_id === member.id),
      devices: devices
        .filter((d) => d.member_id === member.id)
        .sort((a, b) => b.last_seen_at - a.last_seen_at || a.name.localeCompare(b.name)),
      calendars: calendars
        .filter((c) => c.owner_type === "member" && c.owner_id === member.id)
        .map((calendar) => ({ calendar, visible: accessFor(calendar) !== null })),
      workload: workloadOf({ type: "member", id: member.id }),
    }));
    // calendarShares and assignments are read through helpers that reach into
    // the store directly, so they have to be declared to stay reactive.
  }, [members, agents, devices, calendars, calendarShares, assignments]);

  const selected = rows.find((r) => r.member.id === detail.data) ?? null;
  const editingMember = members.find((m) => m.id === editing.data) ?? null;
  const unclaimed = useMemo(() => agents.filter((a) => !a.owner_member_id), [agents]);
  const knownIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const formerRows = useMemo(
    () =>
      former
        .filter((m) => !knownIds.has(m.id))
        .map((member) => ({
          member,
          agents: agents.filter((a) => a.owner_member_id === member.id).length,
          devices: devices.filter((d) => d.member_id === member.id).length,
          calendars: calendars.filter(
            (c) => c.owner_type === "member" && c.owner_id === member.id
          ).length,
        })),
    [former, knownIds, agents, devices, calendars]
  );

  const hosted = agents.filter((a) => a.host_device_id).length;

  async function removePerson(member: Member) {
    const row = rows.find((r) => r.member.id === member.id);
    const keeps = [
      row?.agents.length ? plural(row.agents.length, "agent") : "",
      row?.devices.length ? plural(row.devices.length, "device") : "",
      row?.calendars.length ? plural(row.calendars.length, "calendar") : "",
    ].filter(Boolean);
    const ok = await confirmAction({
      title: `Remove ${member.name}?`,
      body: [
        "They come off the roster and stop being offered as an owner.",
        keeps.length
          ? `Their ${keeps.join(", ")} stay exactly where they are, still credited to them — nothing they touched loses their name.`
          : "Nothing is attributed to them yet, so nothing changes hands.",
        "The record is kept, not deleted.",
      ].join(" "),
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeMember(member.id);
      if (detail.data === member.id) detail.hide();
      if (editing.data === member.id) editing.hide();
      setGone((n) => n + 1);
      toast.success(`${member.name} removed`, "Still credited on everything they brought.");
    } catch (e) {
      toast.error(`Could not remove ${member.name}`, e);
    }
  }

  return (
    <div className="main-pane scroll-pane">
      <div className="pane-header">
        <div>
          <div className="pane-title">People</div>
          <div className="pane-sub">
            {members.length === 1
              ? "Just you so far — everything here is owned by somebody, and this is where that somebody comes from."
              : `${plural(members.length, "person", "people")} · ${plural(devices.length, "device")} · ${
                  hosted ? `${hosted} agent${hosted === 1 ? "" : "s"} with a host` : "no agent has a host yet"
                }`}
          </div>
        </div>
        <div className="row">
          {canInvite && (
            <button className="btn" onClick={() => adding.show()}>
              <IconPlus size={13} /> Invite person
            </button>
          )}
          <button className="btn primary" onClick={() => bringing.show({ ownerId: self.id })}>
            <IconPlus size={13} /> Bring an agent
          </button>
        </div>
      </div>

      <div className="dash-body">
        <AboutPeople />

        {/* The roster keeps the whole pane. The detail that used to take a
            column out of it beside 1180px is a panel now, so the grid stops
            reflowing every time somebody is selected. */}
        <section className="dash-card pe-roster">
          <h3>
            Roster
            <span className="pe-count">{members.length}</span>
          </h3>

          <div className="pe-grid">
            {rows.map((row) => (
              <PersonCard
                key={row.member.id}
                row={row}
                localDeviceId={localId}
                selected={row.member.id === detail.data}
                onSelect={() => detail.toggle(row.member.id)}
                onEdit={() => editing.show(row.member.id)}
                onBringAgent={() => bringing.show({ ownerId: row.member.id })}
                onRemove={
                  !row.isSelf && !row.member.portal_user_id
                    ? () => void removePerson(row.member)
                    : undefined
                }
              />
            ))}
          </div>

          {members.length === 1 && (
            <p className="pe-note">
              Invite a teammate with their email. They appear here as a real member after signing
              in with that ChatGPT account and accepting the private link.
            </p>
          )}
        </section>

        {unclaimed.length > 0 && (
          <section className="dash-card">
            <h3>
              Nobody's yet
              <span className="pe-count">{unclaimed.length}</span>
            </h3>
            <p className="pe-note">
              These agents existed before Spaces modelled people, so no one is recorded as having
              brought them. Give each one an owner and a host machine and the roster can finally
              say where it runs.
            </p>
            <div className="pe-loose">
              {unclaimed.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="pe-loose-row"
                  onClick={() => bringing.show({ ownerId: self.id, agentId: agent.id })}
                >
                  <span className="pe-glyph" aria-hidden="true">
                    {HARNESS_GLYPH[agent.kind] ?? "✳"}
                  </span>
                  <span className="pe-loose-name">{agent.name}</span>
                  <span className="pe-loose-kind">{harnessFor(agent.kind).label}</span>
                  <span className="pe-loose-cta">Give it an owner</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {formerRows.length > 0 && (
          <section className="dash-card">
            <h3>
              No longer here
              <span className="pe-count">{formerRows.length}</span>
            </h3>
            <p className="pe-note">
              Removed from the roster, kept in the record. Their name still renders on everything
              they brought, which is the whole reason removal is not a delete.
            </p>
            <ul className="pe-former">
              {formerRows.map((f) => {
                const still = [
                  f.agents ? plural(f.agents, "agent") : "",
                  f.devices ? plural(f.devices, "device") : "",
                  f.calendars ? plural(f.calendars, "calendar") : "",
                ].filter(Boolean);
                return (
                  <li key={f.member.id}>
                    <span className="pe-former-name">{f.member.name}</span>
                    <span className="pe-former-note">
                      {still.length
                        ? `still credited on ${still.join(", ")}`
                        : "nothing is attributed to them"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {selected && (
        <PersonPanel
          key={selected.member.id}
          row={selected}
          localDeviceId={localId}
          onClose={detail.hide}
          onRemove={() => void removePerson(selected.member)}
        />
      )}
      {editingMember && <MemberEditorPanel member={editingMember} onClose={editing.hide} />}
      {adding.open && (
        <AddPersonPanel onClose={adding.hide} />
      )}
      {bringing.data && (
        <BringAgentPanel
          ownerId={bringing.data.ownerId}
          agentId={bringing.data.agentId}
          onClose={bringing.hide}
        />
      )}
    </div>
  );
}

/* ── the explainer ───────────────────────────────────────────── */

/**
 * The three things a communal workspace with no accounts gets misread as.
 * Open by default; it stays shut once you have read it.
 */
function AboutPeople() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(ABOUT_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const bodyId = useId();

  function toggle() {
    setOpen((was) => {
      try {
        localStorage.setItem(ABOUT_KEY, was ? "0" : "1");
      } catch {
        // A locked-down webview just forgets the preference.
      }
      return !was;
    });
  }

  return (
    <section className={"dash-card pe-about" + (open ? "" : " pe-about-shut")}>
      <button
        type="button"
        className="pe-about-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="pe-about-icon" aria-hidden="true">
          <IconInfo size={15} />
        </span>
        About people in this workspace
        <span className="pe-about-chev" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="pe-about-body" id={bodyId}>
          <dl>
            <div>
              <dt>People join through an email-bound invitation.</dt>
              <dd>
                Spaces creates the invitation in the paired web workspace. The recipient signs in
                with the invited ChatGPT account and appears on every paired desktop only after
                accepting. A typed name is never treated as an authenticated identity.
              </dd>
            </div>
            <div>
              <dt>People bring agents; machines run them.</dt>
              <dd>
                An agent belongs to whoever brought it and runs inside their own{" "}
                <code>claude</code> or <code>codex</code> session, on a machine they registered.
                When that machine is asleep or not running Spaces, the agent is unavailable — nothing
                takes over for it.
              </dd>
            </div>
            <div>
              <dt>Nobody ever types an API key.</dt>
              <dd>
                Each harness signs in with its owner's own subscription the first time it runs. Spaces
                never asks for a key, never stores one, and has nowhere to put one.
              </dd>
            </div>
            <div>
              <dt>Paired roles enforce access.</dt>
              <dd>
                People linked to the web workspace use enforced owner, admin, member and guest
                permissions. Historical local-only placeholders have no access and can be removed
                directly from their roster card.
              </dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

/* ── one person ──────────────────────────────────────────────── */

function PersonAvatar({ member, size = 36 }: { member: Member; size?: number }) {
  return (
    <span
      className="pe-avatar"
      style={{ background: personColor(member), width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials(member.name)}
    </span>
  );
}

/**
 * A person, as a card.
 *
 * Editing used to happen *inside* this card, which meant the roster reflowed
 * around a form and two cards could be in different states at once. It is a
 * panel now, like everything else here, so the card only ever shows one thing.
 */
function PersonCard({
  row,
  localDeviceId: localId,
  selected,
  onSelect,
  onEdit,
  onBringAgent,
  onRemove,
}: {
  row: PersonRow;
  localDeviceId: string;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onBringAgent: () => void;
  onRemove?: () => void;
}) {
  const { member, isSelf } = row;
  const viewerId = useStore((s) => s.members.find((m) => m.is_self === 1)?.id ?? "me");

  return (
    <article className={"pe-card" + (selected ? " pe-card-on" : "")}>
      <div className="pe-head">
        <button
          type="button"
          className="pe-ident"
          onClick={onSelect}
          aria-pressed={selected}
          title={selected ? "Close details" : "See everything they bring"}
        >
          <PersonAvatar member={member} />
          <span className="pe-ident-text">
            <span className="pe-name">
              {member.name}
              {isSelf && <span className="pe-pill pe-pill-you">you</span>}
            </span>
            <span className="pe-mail">{member.email || "no email on file"}</span>
          </span>
        </button>
        <span className="pe-pill">{roleLabel(member.role)}</span>
      </div>

      <div className="pe-brings">
        <span>{plural(row.agents.length, "agent")}</span>
        <span>{plural(row.devices.length, "device")}</span>
        <span>{plural(row.calendars.length, "calendar")}</span>
      </div>

      <section className="pe-block">
        <h4>Agents</h4>
        {row.agents.length === 0 ? (
          <p className="pe-empty">
            {isSelf ? "You have not brought an agent yet." : `Nothing recorded as ${member.name}'s.`}
          </p>
        ) : (
          <div className="pe-chips">
            {row.agents.map((agent) => (
              <AgentChip key={agent.id} agent={agent} owner={member} viewerId={viewerId} />
            ))}
          </div>
        )}
      </section>

      <section className="pe-block">
        <h4>Machines</h4>
        {row.devices.length === 0 ? (
          isSelf ? (
            <RegisterMachine member={member} />
          ) : (
            <p className="pe-empty">
              None registered. A machine is registered from the copy of Spaces running on it, so that
              one is {member.name}'s to add. Their agents can still be hosted on a machine here —
              they would use that machine's sign-in rather than theirs.
            </p>
          )
        ) : (
          <ul className="pe-devices">
            {row.devices.map((device) => (
              <DeviceRow key={device.id} device={device} local={device.id === localId} />
            ))}
          </ul>
        )}
      </section>

      {row.calendars.length > 0 && (
        <section className="pe-block">
          <h4>Calendars</h4>
          <div className="pe-chips">
            {row.calendars.map(({ calendar, visible }) => (
              <span key={calendar.id} className="chip">
                <i
                  className="pe-dot"
                  style={{ background: calendar.color || colorFor(calendar.owner_id || calendar.id) }}
                  aria-hidden="true"
                />
                {visible ? calendar.name : "private to them"}
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="pe-actions">
        <button type="button" className="btn tiny" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn tiny" onClick={onBringAgent}>
          Bring an agent
        </button>
        {onRemove && (
          <button type="button" className="btn tiny danger" onClick={onRemove}>
            Remove local record
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * An agent chip that respects the visibility flag it is drawing.
 *
 * `private` is recorded on the row and honoured here — somebody else's private
 * agent is counted, never named. It is not yet enforced anywhere else in Spaces,
 * so the tooltip says so rather than implying a lock that does not exist.
 */
function AgentChip({
  agent,
  owner,
  viewerId,
}: {
  agent: Agent;
  owner: Member;
  viewerId: string;
}) {
  const hidden = agent.visibility === "private" && owner.id !== viewerId;
  return (
    <span
      className={"chip pe-agent" + (hidden ? " pe-agent-hidden" : "")}
      title={
        hidden
          ? `${owner.name} marked this agent private, so this roster does not name it. Other surfaces do not filter on that yet.`
          : `${harnessFor(agent.kind).label}${
              agent.visibility === "private" ? " · private to you" : " · usable by everyone here"
            }`
      }
    >
      <span className="pe-glyph" aria-hidden="true">
        {HARNESS_GLYPH[agent.kind] ?? "✳"}
      </span>
      {hidden ? "a private agent" : agent.name}
    </span>
  );
}

function DeviceRow({ device, local }: { device: Device; local: boolean }) {
  const tools = parseTools(device.tools);
  const reported = Object.keys(tools).length > 0;
  return (
    <li className="pe-device">
      <div className="pe-device-head">
        <span className="pe-device-name">{device.name}</span>
        {local && <span className="pe-pill pe-pill-here">this machine</span>}
        <span className="pe-device-seen">
          {local
            ? "seen just now"
            : device.last_seen_at
              ? `seen ${timeAgo(device.last_seen_at)}`
              : "never seen"}
        </span>
      </div>
      <div className="pe-device-tools">
        {device.platform && <span className="pe-plat">{device.platform}</span>}
        {reported ? (
          KNOWN_TOOLS.filter((t) => t in tools).map((tool) => (
            <span
              key={tool}
              className={"pe-tool" + (tools[tool] ? " pe-tool-ok" : " pe-tool-missing")}
              title={`${tool} was ${tools[tool] ? "" : "not "}on ${device.name}'s PATH when it last reported.`}
            >
              {tool}
            </span>
          ))
        ) : (
          <span className="pe-tool pe-tool-none">reported no tool list</span>
        )}
      </div>
    </li>
  );
}

/**
 * Registering this machine.
 *
 * Only offered for yourself: a device row claims what is on a machine's PATH,
 * and this copy of Spaces can only speak for the one it is running on.
 */
function RegisterMachine({ member, onDone }: { member: Member; onDone?: () => void }) {
  const addDevice = useStore((s) => s.addDevice);
  const tools = useStore((s) => s.tools);
  const [platform, setPlatform] = useState(browserPlatform());
  const [name, setName] = useState(machineGuess(platform));
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  useEffect(() => {
    let live = true;
    void currentPlatform().then((reported) => {
      if (live) setPlatform(reported);
    });
    return () => {
      live = false;
    };
  }, []);

  // The paired workspace already asked this machine's name once; reuse it
  // rather than making somebody type it twice.
  useEffect(() => {
    let live = true;
    void loadPortalConnection().then(
      (connection) => {
        if (live && connection?.device_name) setName(connection.device_name);
      },
      () => {
        // No portal name is fine — the guess above stands.
      }
    );
    return () => {
      live = false;
    };
  }, []);

  const found = KNOWN_TOOLS.filter((t) => tools[t]);
  // `gh` is on the same PATH but hosts nothing, so it never counts towards
  // whether this machine can actually run an agent.
  const harnesses = (["claude", "codex"] as const).filter((t) => tools[t]);

  async function register() {
    setBusy(true);
    try {
      const device = await addDevice({
        member_id: member.id,
        name: name.trim() || machineGuess(platform),
        platform,
        tools: JSON.stringify(tools),
      });
      rememberLocalDevice(device.id);
      toast.success(
        `${device.name} registered`,
        harnesses.length
          ? `${harnesses.join(" and ")} found on PATH — agents hosted here can run while Spaces is open on it.`
          : "No agent CLI is on its PATH yet, so it cannot host anything until one is installed."
      );
      onDone?.();
    } catch (e) {
      toast.error("Could not register this machine", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pe-register">
      <p className="pe-empty">
        This machine is not on the roster yet. Registering it records its name, its platform and
        which agent CLIs are on its PATH, so the workspace can say where an agent of yours runs.
      </p>
      <div className="pe-register-row">
        <label className="pe-sr" htmlFor={fieldId}>
          Name for this machine
        </label>
        <input
          id={fieldId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={machineGuess(platform)}
        />
        <button type="button" className="btn" onClick={() => void register()} disabled={busy}>
          Register
        </button>
      </div>
      <p className="pe-hint">
        {platform ? `Reported as ${platform}. ` : ""}
        {found.length
          ? `Found on PATH: ${found.join(", ")}.`
          : "Nothing found on PATH — it can be registered anyway, it just cannot host an agent yet."}
      </p>
    </div>
  );
}

/* ── editing a person ────────────────────────────────────────── */

/**
 * Editing a person.
 *
 * Open to every row, not only your own: these are local records somebody typed
 * and somebody has to be able to fix a misspelt name. Your own row is the one
 * that matters most, so it is the one with the "you" marker beside it.
 *
 * `stack` is set when this was opened from inside the detail panel, which makes
 * it the same surface showing a different page rather than a second drawer —
 * one width, one edge, and a way back to the person you came from.
 */
function MemberEditorPanel({
  member,
  onClose,
  stack,
}: {
  member: Member;
  onClose: () => void;
  stack?: PanelStack;
}) {
  const updateMember = useStore((s) => s.updateMember);
  const self = useStore((s) => s.self());
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email);
  const [role, setRole] = useState<MemberRole>(member.role);
  const [color, setColor] = useState(member.color);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const linked = Boolean(member.portal_user_id);
  const isSelf = member.id === self.id;
  const canRename =
    !linked ||
    isSelf ||
    self.role === "owner" ||
    (self.role === "admin" && member.role !== "owner");
  const canChangeRole =
    !linked ||
    (!isSelf &&
      member.role !== "owner" &&
      (self.role === "owner" ||
        (self.role === "admin" && member.role !== "admin")));
  const roleOptions = !linked
    ? ROLES
    : ROLES.filter(({ role: option }) => {
        if (option === member.role) return true;
        if (option === "owner") return false;
        if (self.role === "admin" && option === "admin") return false;
        return true;
      });

  /* Explicit save, not autosave. A name is what everything this person owns is
     credited to, and half a name written across the roster while somebody
     retypes it is worse than a button. */
  async function save() {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      await updateMember(member.id, {
        ...(canRename ? { name: clean } : {}),
        ...(!linked ? { email: email.trim() } : {}),
        ...(canChangeRole ? { role } : {}),
        color,
      });
      (stack?.back ?? onClose)();
    } catch (e) {
      toast.error(`Could not save ${member.name}`, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title="Edit person"
      subtitle={member.name}
      onClose={onClose}
      stack={stack}
      storageKey="person"
      className="pe-panel"
      footer={
        <>
          <button type="button" className="btn" onClick={stack?.back ?? onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn primary"
            disabled={busy || !name.trim()}
          >
            Save
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="pe-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input
            data-autofocus
            value={name}
            disabled={!canRename}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            disabled={linked}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nobody@example.com"
          />
        </Field>
        {linked && (
          <p className="pe-hint">
            Account email comes from ChatGPT sign-in. Name and permitted role changes sync to the
            shared site.
          </p>
        )}
        <Field label="Role">
          <select
            value={role}
            disabled={!canChangeRole}
            onChange={(e) => setRole(e.target.value as MemberRole)}
          >
            {roleOptions.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label} — {r.help}
              </option>
            ))}
          </select>
        </Field>
        <ColorField id={member.id} value={color} onChange={setColor} />
      </form>
    </SidePanel>
  );
}

/**
 * The identity ramp as swatches. Native radios, so arrow keys, Home/End and
 * screen-reader grouping all come from the platform instead of from us.
 */
function ColorField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const group = useId();
  const options = ["", ...AVATAR_RAMP];
  return (
    <fieldset className="pe-colors">
      <legend className="field-label">Colour</legend>
      <div className="pe-swatches">
        {options.map((option) => {
          const auto = option === "";
          return (
            <label
              key={option || "auto"}
              className={"pe-swatch" + (option === value ? " pe-swatch-on" : "")}
              title={auto ? "Follow the theme's own hashed colour" : "Use this colour"}
            >
              <input
                className="pe-sr"
                type="radio"
                name={group}
                checked={option === value}
                onChange={() => onChange(option)}
              />
              <span
                className="pe-swatch-dot"
                style={{ background: auto ? colorFor(id) : option }}
                aria-hidden="true"
              />
              <span className="pe-sr">{auto ? "Automatic colour" : `Colour ${option}`}</span>
              {auto && (
                <span className="pe-swatch-auto" aria-hidden="true">
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

/* ── the detail panel ────────────────────────────────────────── */

/**
 * Everything one person brings, beside the roster rather than inside it.
 *
 * This was a card that took a 340px column out of the grid above 1180px and
 * stacked under it below that — a panel that had to be scrolled to, and that
 * reflowed every card on the page each time somebody was selected. As a real
 * panel it takes its width out of the app once and the roster stops moving.
 *
 * Its two actions open *stacked* panels: the same drawer, showing a different
 * page, with a way back. That is deliberately not a second surface — two
 * drawers against a 1280px window leave the roster they annotate too narrow to
 * read.
 */
function PersonPanel({
  row,
  localDeviceId: localId,
  onClose,
  onRemove,
}: {
  row: PersonRow;
  localDeviceId: string;
  onClose: () => void;
  onRemove: () => void;
}) {
  const devices = useStore((s) => s.devices);
  const { member, isSelf } = row;
  const edit = usePanel();
  const bring = usePanel();

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? "";

  return (
    <SidePanel
      title={
        <span className="pe-panel-title">
          <PersonAvatar member={member} size={24} />
          {member.name}
        </span>
      }
      subtitle={`${roleLabel(member.role)}${isSelf ? " · you" : ""}${
        member.email ? ` · ${member.email}` : ""
      }`}
      onClose={onClose}
      storageKey="person-detail"
      className="pe-panel"
      footer={
        <>
          {!isSelf && !member.portal_user_id && (
            <button type="button" className="btn danger pe-panel-remove" onClick={onRemove}>
              Remove local record
            </button>
          )}
          <button type="button" className="btn" onClick={() => bring.show()}>
            Bring an agent
          </button>
          <button type="button" className="btn primary" onClick={() => edit.show()}>
            Edit
          </button>
        </>
      }
    >
      <section className="pe-block">
        <h4>Agents they brought</h4>
        {row.agents.length === 0 ? (
          <p className="pe-empty">
            None yet. An agent needs an owner and a host machine before the workspace can say
            whether it is able to run.
          </p>
        ) : (
          <ul className="pe-detail-list">
            {row.agents.map((agent) => {
              const host = agent.host_device_id ? deviceName(agent.host_device_id) : "";
              const device = devices.find((d) => d.id === agent.host_device_id);
              const tools = device ? parseTools(device.tools) : {};
              const cliMissing =
                device && agent.kind !== "ritz" && tools[agent.kind] === false;
              return (
                <li key={agent.id}>
                  <div className="pe-detail-row">
                    <span className="pe-glyph" aria-hidden="true">
                      {HARNESS_GLYPH[agent.kind] ?? "✳"}
                    </span>
                    <span className="pe-detail-name">{agent.name}</span>
                    <span className="pe-pill">
                      {agent.visibility === "private" ? "private" : "workspace"}
                    </span>
                  </div>
                  <p className="pe-hint">
                    {harnessFor(agent.kind).label}
                    {host
                      ? ` on ${host} — requests wait there whenever that machine is offline.`
                      : " — no host machine, so nothing runs it yet."}
                    {cliMissing
                      ? ` That machine reported no ${agent.kind} on its PATH when it last checked in.`
                      : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="pe-block">
        <h4>Machines</h4>
        {row.devices.length === 0 ? (
          isSelf ? (
            <RegisterMachine member={member} />
          ) : (
            <p className="pe-empty">
              None registered. Only the copy of Spaces running on a machine can report what that
              machine has, so {member.name} registers their own.
            </p>
          )
        ) : (
          <ul className="pe-devices">
            {row.devices.map((device) => (
              <DeviceRow key={device.id} device={device} local={device.id === localId} />
            ))}
          </ul>
        )}
      </section>

      <section className="pe-block">
        <h4>Calendars</h4>
        {row.calendars.length === 0 ? (
          <p className="pe-empty">No calendar is owned by them.</p>
        ) : (
          <ul className="pe-detail-list">
            {row.calendars.map(({ calendar, visible }) => (
              <li key={calendar.id} className="pe-detail-row">
                <i
                  className="pe-dot"
                  style={{ background: calendar.color || colorFor(calendar.owner_id || calendar.id) }}
                  aria-hidden="true"
                />
                <span className="pe-detail-name">
                  {visible ? calendar.name : "A calendar you cannot see"}
                </span>
                <span className="pe-pill">
                  {calendar.visibility === "private" ? "private" : `workspace: ${calendar.visibility}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pe-block">
        <h4>Assigned to them</h4>
        {row.workload.length === 0 ? (
          <p className="pe-empty">
            Nothing — and it cannot be yet. Assignments in Spaces take an agent or a team as the
            subject, never a person, so this list stays empty for everybody until that changes.
            Ownership of the things above is what attribution to a person looks like today.
          </p>
        ) : (
          <div className="pe-chips">
            {row.workload.map((w) => (
              <EntityChip
                key={w.assignment.id}
                ref={{ type: w.assignment.target_type, id: w.assignment.target_id }}
                size="sm"
              />
            ))}
          </div>
        )}
      </section>

      {isSelf && (
        <p className="pe-hint">
          This is you. You cannot remove yourself from your own machine — everything here would
          lose the row it hangs ownership on.
        </p>
      )}

      {/* Rendered inside this panel's children, which is how SidePanel knows
          they are stacked: same box, same width, this one hidden behind. */}
      {edit.open && (
        <MemberEditorPanel
          member={member}
          onClose={edit.hide}
          stack={{ back: edit.hide, from: member.name }}
        />
      )}
      {bring.open && (
        <BringAgentPanel
          ownerId={member.id}
          onClose={bring.hide}
          stack={{ back: bring.hide, from: member.name }}
        />
      )}
    </SidePanel>
  );
}

/* ── invite a person ─────────────────────────────────────────── */

function AddPersonPanel({ onClose }: { onClose: () => void }) {
  const members = useStore((s) => s.members);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  // The submit button lives in the panel's pinned footer, outside the form, so
  // it is associated by id rather than by nesting — and Enter in a field still
  // submits, which is the behaviour a form in a dialog got for free.
  const formId = useId();

  const cleanEmail = email.trim().toLowerCase();
  const clash = cleanEmail
    ? members.find((m) => m.email.trim().toLowerCase() === cleanEmail)
    : undefined;

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Invitation link copied");
    } catch (error) {
      toast.error("Could not copy the invitation link", error);
    }
  }

  async function invite() {
    if (!cleanEmail) return;
    setBusy(true);
    try {
      const connection = await loadPortalConnection();
      if (!connection) throw new Error("Pair this desktop before inviting a teammate.");
      const result = await portalMemberAction("create_invite", {
        email: cleanEmail,
        role,
      });
      if (!result.invitePath) throw new Error("The workspace did not return an invitation link.");
      const url = new URL(result.invitePath, connection.base_url).toString();
      setInviteUrl(url);
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // The read-only field below remains available for manual copying.
      }
      toast.success(
        `Invitation created for ${cleanEmail}`,
        copied
          ? "The private link is on your clipboard."
          : "Copy the private link and send it to them."
      );
    } catch (e) {
      toast.error(`Could not invite ${cleanEmail || "that person"}`, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title={inviteUrl ? "Invitation ready" : "Invite a person"}
      onClose={onClose}
      storageKey="person"
      className="pe-panel"
      footer={
        inviteUrl ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
            <button type="button" className="btn primary" onClick={() => void copyInvite()}>
              Copy invitation link
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              className="btn primary"
              disabled={busy || !cleanEmail || Boolean(clash)}
            >
              {busy ? "Creating invitation…" : "Create invitation"}
            </button>
          </>
        )
      }
    >
      {inviteUrl ? (
        <>
          <p className="pe-panel-lead">
            Send this private link to {cleanEmail}. It expires after seven days and only the
            invited ChatGPT account can accept it.
          </p>
          <Field label="Private invitation link">
            <input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <p className="pe-hint">
            They appear on every paired Spaces desktop after accepting. No identity-less local
            person is created while the invitation is pending.
          </p>
        </>
      ) : (
        <>
          <p className="pe-panel-lead">
            This creates a real, email-bound invitation in the paired web workspace. The person
            joins after signing in with that ChatGPT account and accepting your private link.
          </p>
          <form
            id={formId}
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
          >
            <Field label="Email">
              <input
                data-autofocus
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jamie@example.com"
              />
            </Field>
            {clash && (
              <p className="pe-warn">
                {clash.name} is already a member with this email.
              </p>
            )}
            <Field label="Workspace role">
              <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
                {ROLES.filter((item) => item.role !== "owner").map((item) => (
                  <option key={item.role} value={item.role}>
                    {item.label} — {item.help}
                  </option>
                ))}
              </select>
            </Field>
            <p className="pe-hint">
              The role is enforced by the shared workspace as soon as the invitation is accepted.
            </p>
          </form>
        </>
      )}
    </SidePanel>
  );
}

/* ── bring an agent ──────────────────────────────────────────── */

const VISIBILITY_HELP: Record<AgentVisibility, string> = {
  workspace: "Anyone here can mention it, assign it work and run it.",
  private:
    "Recorded as its owner's own. This roster honours that and stops naming it to other people; no other surface filters on it yet, so read it as a stated intent rather than a lock.",
};

/**
 * The flow that makes "folks bring their own agents" real.
 *
 * Four answers and one consequence: who owns it, which machine hosts it, which
 * harness it wraps, and who may use it. The consequence — that it only runs
 * while that machine does — is stated in full every time, because it is the
 * thing people are most surprised by later.
 */
function BringAgentPanel({
  ownerId,
  agentId,
  onClose,
  stack,
}: {
  ownerId: string;
  agentId?: string;
  onClose: () => void;
  stack?: PanelStack;
}) {
  const store = useStore();
  const members = store.members;
  const devices = store.devices;
  const agents = store.agents;
  const formId = useId();

  const existing = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
  const [target, setTarget] = useState(existing?.id ?? "new");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<HarnessKind>(
    (existing?.kind as HarnessKind) ?? preferHarness(store.tools)
  );
  const [owner, setOwner] = useState(existing?.owner_member_id || ownerId);
  const [host, setHost] = useState(existing?.host_device_id ?? "");
  const [visibility, setVisibility] = useState<AgentVisibility>(
    existing?.visibility === "private" ? "private" : "workspace"
  );
  const [busy, setBusy] = useState(false);

  const chosen = target === "new" ? null : agents.find((a) => a.id === target) ?? null;
  const effectiveKind = chosen ? (chosen.kind as HarnessKind) : kind;
  const meta = harnessFor(effectiveKind);
  const ownerMember = members.find((m) => m.id === owner) ?? null;
  const hostDevice = devices.find((d) => d.id === host) ?? null;
  const hostTools = hostDevice ? parseTools(hostDevice.tools) : {};
  const ownerDevices = devices.filter((d) => d.member_id === owner);

  const clean = name.trim();
  const handle = slug(target === "new" ? clean : chosen?.name ?? "");
  const nameClash =
    target === "new" && handle
      ? [...store.agents.map((a) => a.name), ...store.teams.map((t) => t.name)].find(
          (n) => slug(n) === handle
        )
      : undefined;

  const canSave = target === "new" ? !!clean && !nameClash : !!chosen;
  const agentLabel = target === "new" ? clean || "The agent" : chosen?.name ?? "The agent";

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    const ownership: Ownership = {
      owner_member_id: owner,
      host_device_id: host,
      visibility,
    };
    try {
      if (target === "new") {
        // Same defaults a blank agent gets in the roster editor, so an agent
        // brought from here is immediately runnable rather than half-made.
        const values = defaultsFor(kind);
        const created = await store.addAgent({
          name: clean,
          kind,
          model: String(values.model ?? "").trim(),
          cli_args: serializeArgs(kind, values),
        });
        await store.updateAgent(created.id, ownership);
        toast.success(
          `${clean} joined the workspace`,
          host
            ? `Runs on ${hostDevice?.name ?? "its host"}, under ${ownerMember?.name ?? "its owner"}'s own ${meta.label} sign-in.`
            : "It has no host machine yet, so it cannot run until one is chosen."
        );
      } else if (chosen) {
        await store.updateAgent(chosen.id, ownership);
        toast.success(
          `${chosen.name} is now ${ownerMember?.name ?? "theirs"}`,
          host ? `Hosted on ${hostDevice?.name ?? "the chosen machine"}.` : "Still without a host machine."
        );
      }
      (stack?.back ?? onClose)();
    } catch (e) {
      toast.error("Could not save that agent", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidePanel
      title={existing ? "Give this agent an owner" : "Bring an agent"}
      subtitle={ownerMember ? `Brought by ${ownerMember.name}` : undefined}
      onClose={onClose}
      stack={stack}
      storageKey="agent"
      className="pe-panel"
      /* Four answers, then one write. There is nothing to autosave into until
         the agent exists, and half an ownership record is worse than none. */
      footer={
        <>
          <button type="button" className="btn" onClick={stack?.back ?? onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn primary" disabled={!canSave || busy}>
            {target === "new" ? "Bring it in" : "Save ownership"}
          </button>
        </>
      }
    >
      <p className="pe-panel-lead">
        An agent is somebody's CLI, running on somebody's machine. Saying whose and where is what
        lets everyone else here know when it can actually work.
      </p>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Which agent">
          <select
            value={target}
            onChange={(e) => {
              const next = e.target.value;
              setTarget(next);
              const picked = agents.find((a) => a.id === next);
              if (picked) {
                setHost(picked.host_device_id ?? "");
                setVisibility(picked.visibility === "private" ? "private" : "workspace");
                if (picked.owner_member_id) setOwner(picked.owner_member_id);
              }
            }}
          >
            <option value="new">A new agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {harnessFor(a.kind).label}
                {a.owner_member_id
                  ? ` (${members.find((m) => m.id === a.owner_member_id)?.name ?? "someone"}'s)`
                  : " (unclaimed)"}
              </option>
            ))}
          </select>
        </Field>

        {target === "new" ? (
          <>
            <Field label="Name">
              <input
                data-autofocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Scout"
              />
            </Field>
            {nameClash && (
              <p className="pe-warn">
                {nameClash} already answers to @{handle}. Mentions resolve by handle, so two of
                them would be genuinely ambiguous.
              </p>
            )}
            <div className="pe-choice">
              <div className="field-label">Harness</div>
              <RadioChips
                label="Harness"
                value={kind}
                onChange={setKind}
                options={HARNESSES.map((h) => ({
                  value: h.kind,
                  label: h.label,
                  glyph: HARNESS_GLYPH[h.kind],
                  title: h.blurb,
                }))}
              />
              <p className="pe-hint">{meta.blurb}</p>
            </div>
          </>
        ) : (
          <p className="pe-hint">
            {chosen?.name} wraps {meta.label}. Its harness and flags stay where they are — change
            those in Agents &amp; Teams, where the whole command is editable.
          </p>
        )}

        <Field label="Brought by">
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.is_self ? " (you)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Host machine">
          <select value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">No host yet</option>
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
        </Field>
        {!devices.length && (
          <p className="pe-warn">
            No machine is registered anywhere in this workspace yet. Register one from the roster
            first — an agent with no host is a record of an intention, not something that runs.
          </p>
        )}
        {devices.length > 0 && !ownerDevices.length && ownerMember && (
          <p className="pe-hint">
            {ownerMember.name} has no machine of their own registered. Hosting their agent on
            somebody else's machine works, but it will sign in with whatever session that machine
            has.
          </p>
        )}

        <div className="pe-choice">
          <div className="field-label">Who can use it</div>
          <RadioChips
            label="Who can use it"
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: "workspace", label: "Everyone here", title: VISIBILITY_HELP.workspace },
              { value: "private", label: "Just the owner", title: VISIBILITY_HELP.private },
            ]}
          />
          <p className="pe-hint">{VISIBILITY_HELP[visibility]}</p>
        </div>

        <div className="pe-consequence">
          <div className="pe-consequence-title">What this means</div>
          <ul>
            <li>
              {hostDevice
                ? `${agentLabel} runs only on ${hostDevice.name}. While that machine is asleep or Spaces is closed, requests wait durably and start when it returns.`
                : `${agentLabel} has no host machine, so it cannot run at all yet. It will sit in the roster until one is chosen.`}
            </li>
            <li>
              It signs in with {ownerMember?.name ?? "its owner"}'s own {meta.label} session on
              that machine. Spaces never asks for an API key and has nowhere to store one.
            </li>
            {hostDevice && effectiveKind !== "ritz" && hostTools[effectiveKind] === false && (
              <li>
                {hostDevice.name} reported no <code>{effectiveKind}</code> on its PATH when it
                last checked in. Recording it here is fine; it will not run until that CLI is
                installed there.
              </li>
            )}
            {hostDevice && effectiveKind === "ritz" && (
              <li>
                Ritz answers on that machine's own port rather than from PATH, so a device's tool
                list says nothing either way about it.
              </li>
            )}
          </ul>
        </div>

      </form>
    </SidePanel>
  );
}
