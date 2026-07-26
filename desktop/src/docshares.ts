/**
 * Document ownership and sharing.
 *
 * Documents predate members: every existing row landed with owner_member_id =
 * '' and the v15 migration defaulted the new visibility column to 'private'.
 * Read those two facts together and the obvious implementation hides everyone's
 * existing notes behind an owner that matches nobody — so an unowned document
 * is treated here as belonging to whoever is at this machine, and the row is
 * stamped with their id the first time its sharing is touched. Nothing
 * vanishes; ownership just becomes explicit at the moment it starts to matter.
 *
 * The precedence rules are calendars.ts accessFor() with two tiers instead of
 * three: the owner wins, then the highest explicit share, then the document's
 * own default — and a share may only ever RAISE access above that default,
 * never lower it. Two subtly different permission models in one app is how a
 * leak happens, so when that function changes this one changes with it.
 *
 * There are no store actions for document_shares, so this queries getDb()
 * directly in the style of operations.ts. What the store would have given for
 * free — reactivity — is the small change bus at the bottom instead: reads are
 * synchronous against a cache so a list row can draw a badge without awaiting
 * anything, and every write refreshes that cache before it announces itself.
 */
import { getDb } from "./db";
import { useStore } from "./store";
import { localMember } from "./calendars";
import type { DocShare, EntityRef, ShareAccess } from "./types";
import type { DocumentRecord } from "./operations";

/** A document's default for everyone who has no share of their own. */
export type DocVisibility = "private" | "workspace";

/** A document row with the two ownership columns DocumentRecord predates. */
export interface SharedDocument extends DocumentRecord {
  owner_member_id: string;
  visibility: DocVisibility;
}

/**
 * The shape docAccess actually needs. DocumentRecord does not name the
 * ownership columns, but `SELECT *` returns them — so a plain record from
 * operations.ts satisfies this just as well as a typed SharedDocument, and a
 * caller holding nothing but an id can fall back to docAccessById().
 */
export interface DocumentOwnership {
  id: string;
  owner_member_id?: string;
  visibility?: string;
}

interface DocMeta {
  owner_member_id: string;
  visibility: DocVisibility;
}

/* ── the cache ────────────────────────────────────────────────── */

const meta = new Map<string, DocMeta>();
const sharesByDoc = new Map<string, DocShare[]>();
let loaded = false;
let inflight: Promise<void> | null = null;

function normalizeVisibility(v: string | undefined): DocVisibility {
  return v === "workspace" ? "workspace" : "private";
}

/** Load every document's ownership and every share. Replaces the cache. */
export async function loadDocShares(): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ id: string; owner_member_id: string; visibility: string }[]>(
    "SELECT id, owner_member_id, visibility FROM documents"
  );
  const shares = await db.select<DocShare[]>("SELECT * FROM document_shares");

  meta.clear();
  for (const row of rows) {
    meta.set(row.id, {
      owner_member_id: row.owner_member_id ?? "",
      visibility: normalizeVisibility(row.visibility),
    });
  }
  sharesByDoc.clear();
  for (const share of shares) {
    const list = sharesByDoc.get(share.document_id);
    if (list) list.push(share);
    else sharesByDoc.set(share.document_id, [share]);
  }
  loaded = true;
  emitDocShares();
}

/**
 * Prime the cache once, sharing a single query between concurrent callers.
 *
 * A cold cache is deliberately safe: with no shares loaded every read falls
 * back to owner-plus-default, which under-reports access rather than over-
 * reporting it. Failing closed is the only acceptable direction here.
 */
export function ensureDocShares(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!inflight) {
    inflight = loadDocShares().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function metaOf(doc: DocumentOwnership): DocMeta {
  const cached = meta.get(doc.id);
  return {
    owner_member_id: doc.owner_member_id ?? cached?.owner_member_id ?? "",
    visibility: normalizeVisibility(doc.visibility ?? cached?.visibility),
  };
}

/** The current row, from cache when warm and from the database when not. */
async function currentMeta(documentId: string): Promise<DocMeta> {
  const cached = meta.get(documentId);
  if (cached) return cached;
  const db = await getDb();
  const rows = await db.select<{ owner_member_id: string; visibility: string }[]>(
    "SELECT owner_member_id, visibility FROM documents WHERE id = $1",
    [documentId]
  );
  const row = rows[0];
  const next: DocMeta = {
    owner_member_id: row?.owner_member_id ?? "",
    visibility: normalizeVisibility(row?.visibility),
  };
  if (row) meta.set(documentId, next);
  return next;
}

/* ── access ───────────────────────────────────────────────────── */

const RANK: Record<ShareAccess, number> = { read: 1, write: 2 };

/**
 * What a 'workspace' document gives everyone who has no share of their own.
 * Read, never write: making a document editable by the whole workspace is a
 * decision worth naming a person for, so it is a share rather than a default.
 */
const WORKSPACE_BASE: ShareAccess = "read";

/**
 * Who owns `doc`, with unowned rows resolved to the local member.
 *
 * `adopted` is true while the database still says nobody — the UI uses it to
 * say "yours, since it predates sharing" rather than claiming a stored fact.
 */
export function ownerOf(doc: DocumentOwnership): { id: string; adopted: boolean } {
  const stored = metaOf(doc).owner_member_id;
  return stored ? { id: stored, adopted: false } : { id: localMember().id, adopted: true };
}

/**
 * What `viewer` may do with `doc`. Returns null for no access at all.
 *
 * Precedence is owner → explicit share → the document's default visibility,
 * exactly as calendars.ts accessFor() resolves a calendar. An explicit share
 * can only raise access above the default, never lower it below what everyone
 * already has: a share that silently took access away would be a confusing way
 * to express "hide this from one person".
 */
export function docAccess(
  doc: DocumentOwnership,
  viewer: EntityRef = localMember()
): ShareAccess | null {
  const { visibility } = metaOf(doc);
  if (viewer.type === "member" && viewer.id === ownerOf(doc).id) return "write";

  const base: ShareAccess | null = visibility === "private" ? null : WORKSPACE_BASE;

  // A team share reaches every agent in that team, so an agent inherits what
  // its team was granted. Keyed by type as well as id because document_shares
  // is keyed that way — matching on the id alone would let an agent claim a
  // team's grant, which is the one direction a permission check must not err.
  const subjects = new Set<string>([`${viewer.type}:${viewer.id}`]);
  if (viewer.type === "agent") {
    for (const tm of useStore.getState().teamMembers) {
      if (tm.agent_id === viewer.id) subjects.add(`team:${tm.team_id}`);
    }
  }

  let granted: ShareAccess | null = null;
  for (const share of sharesByDoc.get(doc.id) ?? []) {
    if (!subjects.has(`${share.subject_type}:${share.subject_id}`)) continue;
    if (!granted || RANK[share.access] > RANK[granted]) granted = share.access;
  }

  if (!granted) return base;
  if (!base) return granted;
  return RANK[granted] > RANK[base] ? granted : base;
}

/** docAccess for a caller that has an id and no row — a list badge, a header. */
export function docAccessById(
  documentId: string,
  viewer: EntityRef = localMember()
): ShareAccess | null {
  return docAccess({ id: documentId }, viewer);
}

export function canWriteDoc(doc: DocumentOwnership, viewer: EntityRef = localMember()): boolean {
  return docAccess(doc, viewer) === "write";
}

/** Documents `viewer` may see at all, ordered as the documents list expects. */
export async function visibleDocuments(
  viewer: EntityRef = localMember()
): Promise<SharedDocument[]> {
  // Tolerated on purpose: a shares table that will not load costs people the
  // documents others shared with them, never their own — and that is the safe
  // direction to fail in.
  await ensureDocShares().catch(() => {});
  const db = await getDb();
  const rows = await db.select<SharedDocument[]>(
    "SELECT * FROM documents ORDER BY pinned DESC, path, updated_at DESC"
  );
  for (const row of rows) {
    meta.set(row.id, {
      owner_member_id: row.owner_member_id ?? "",
      visibility: normalizeVisibility(row.visibility),
    });
  }
  return rows.filter((row) => docAccess(row, viewer) !== null);
}

/* ── shares ───────────────────────────────────────────────────── */

function sameShares(a: DocShare[], b: DocShare[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: DocShare) => `${s.subject_type}:${s.subject_id}:${s.access}`;
  const seen = new Set(a.map(key));
  return b.every((s) => seen.has(key(s)));
}

/** Every explicit share on a document, refreshing the cache as it goes. */
export async function sharesFor(documentId: string): Promise<DocShare[]> {
  const db = await getDb();
  const rows = await db.select<DocShare[]>(
    "SELECT * FROM document_shares WHERE document_id = $1",
    [documentId]
  );
  const before = sharesByDoc.get(documentId) ?? [];
  sharesByDoc.set(documentId, rows);
  // Announce only a real change: a panel that refetches on open would otherwise
  // bump the version on every render pass it triggers.
  if (!sameShares(before, rows)) emitDocShares();
  return rows;
}

/** Shares already in the cache. Synchronous, for rendering. */
export function cachedShares(documentId: string): DocShare[] {
  return sharesByDoc.get(documentId) ?? [];
}

/**
 * Give a document an owner, writing what was until now only assumed.
 *
 * `updated_at` is left alone deliberately — deciding who may read something is
 * not an edit to it, and bumping the timestamp would shuffle the document to
 * the top of a list sorted by recency.
 */
export async function setDocOwner(documentId: string, memberId: string): Promise<void> {
  const current = await currentMeta(documentId);
  if (current.owner_member_id === memberId) return;
  const db = await getDb();
  await db.execute("UPDATE documents SET owner_member_id = $1 WHERE id = $2", [
    memberId,
    documentId,
  ]);
  meta.set(documentId, { ...current, owner_member_id: memberId });
  emitDocShares();
}

/**
 * Claim a document that has never had an owner for the local member.
 *
 * Called before every sharing change, which is the honest moment: until
 * somebody decides who else may read it, "unowned" and "yours" are the same
 * thing and the row is better left as it was found.
 */
export async function adoptDocument(documentId: string): Promise<string> {
  const current = await currentMeta(documentId);
  if (current.owner_member_id) return current.owner_member_id;
  const me = localMember().id;
  await setDocOwner(documentId, me);
  return me;
}

export async function setDocVisibility(documentId: string, v: DocVisibility): Promise<void> {
  await adoptDocument(documentId);
  const current = await currentMeta(documentId);
  const db = await getDb();
  await db.execute("UPDATE documents SET visibility = $1 WHERE id = $2", [v, documentId]);
  meta.set(documentId, { ...current, visibility: v });
  emitDocShares();
}

/** Grant, change or (with a null access) revoke one subject's share. */
export async function setDocShare(
  documentId: string,
  subject: EntityRef,
  access: ShareAccess | null
): Promise<void> {
  if (subject.type !== "member" && subject.type !== "team" && subject.type !== "agent") return;
  // Pin the narrowed type: the closures below lose the narrowing otherwise.
  const subjectType: DocShare["subject_type"] = subject.type;
  await adoptDocument(documentId);

  const db = await getDb();
  const current = cachedShares(documentId);
  const mine = (s: DocShare) => s.subject_type === subjectType && s.subject_id === subject.id;

  if (access === null) {
    await db.execute(
      "DELETE FROM document_shares WHERE document_id = $1 AND subject_type = $2 AND subject_id = $3",
      [documentId, subjectType, subject.id]
    );
    sharesByDoc.set(documentId, current.filter((s) => !mine(s)));
  } else {
    await db.execute(
      "INSERT INTO document_shares (document_id, subject_type, subject_id, access) VALUES ($1,$2,$3,$4) ON CONFLICT(document_id, subject_type, subject_id) DO UPDATE SET access = $4",
      [documentId, subjectType, subject.id, access]
    );
    const row: DocShare = {
      document_id: documentId,
      subject_type: subjectType,
      subject_id: subject.id,
      access,
    };
    // Replaced where it already sits rather than removed and appended: raising
    // somebody's access should not make their row jump to the bottom of the
    // list the moment you change it.
    sharesByDoc.set(
      documentId,
      current.some(mine) ? current.map((s) => (mine(s) ? row : s)) : [...current, row]
    );
  }
  emitDocShares();
}

/** Drop everything remembered about a document, for a delete path. */
export async function forgetDocShares(documentId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM document_shares WHERE document_id = $1", [documentId]);
  sharesByDoc.delete(documentId);
  meta.delete(documentId);
  emitDocShares();
}

/* ── one document, as the UI needs it ─────────────────────────── */

export interface DocShareState {
  documentId: string;
  /** Resolved owner: the stored member, or the local one for an unowned row. */
  ownerId: string;
  /** True while nobody is stored and ownership is still an assumption. */
  adopted: boolean;
  visibility: DocVisibility;
  shares: DocShare[];
  /** What the viewer may do, null when the document is not theirs to see. */
  access: ShareAccess | null;
  isOwner: boolean;
  /** "Private", "Shared with 3", "Workspace" — the header control's label. */
  label: string;
}

/**
 * Everything a control needs about one document, read synchronously.
 *
 * Cheap enough to call per list row: it is two map lookups and a scan of that
 * document's own shares.
 */
export function docShareState(
  documentId: string,
  viewer: EntityRef = localMember()
): DocShareState {
  const doc: DocumentOwnership = { id: documentId };
  const owner = ownerOf(doc);
  const { visibility } = metaOf(doc);
  const shares = cachedShares(documentId);
  const label =
    visibility === "workspace"
      ? "Workspace"
      : shares.length
        ? `Shared with ${shares.length}`
        : "Private";
  return {
    documentId,
    ownerId: owner.id,
    adopted: owner.adopted,
    visibility,
    shares,
    access: docAccess(doc, viewer),
    isOwner: viewer.type === "member" && viewer.id === owner.id,
    label,
  };
}

/* ── the change bus ───────────────────────────────────────────── */

const listeners = new Set<() => void>();
let version = 0;

/**
 * Subscribe to ownership and share changes. Returns an unsubscribe fn.
 * Pairs with docSharesVersion() for React's useSyncExternalStore — the counter
 * is compared by value, so a re-render happens exactly when something moved.
 */
export function subscribeDocShares(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function docSharesVersion(): number {
  return version;
}

/** Announce that ownership or sharing changed. */
export function emitDocShares(): void {
  version++;
  // Copied first: a listener that unsubscribes while being notified would
  // otherwise mutate the set mid-iteration.
  for (const fn of [...listeners]) fn();
}
