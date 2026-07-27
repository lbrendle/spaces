/**
 * Knowledge collections — markdown brought *into* Spaces.
 *
 * vaults.ts models a MOUNT: Spaces stores a folder path and reads the disk live.
 * That is a fine way to search your own machine and a hopeless way to share
 * anything — a path only resolves on the one computer holding the folder, so
 * everybody else in the workspace gets a knowledge base full of notes they
 * cannot open. This module is the other shape. A COLLECTION is workspace data,
 * like a task or a memory entry: markdown is copied in once and then belongs to
 * Spaces. A folder is one way in, not the source of truth.
 *
 * The tables are the ones vaults.ts already uses, read differently:
 *
 *   vaults        one row per collection. `path` is the folder it was imported
 *                 FROM — provenance, and the thing re-import re-walks — never a
 *                 live dependency. An empty path is a perfectly good
 *                 collection that files were dropped into.
 *   vault_files   the copy itself. `body` holds the file's own text rather than
 *                 the flattened plain-text shadow a mirror kept, because it is
 *                 now the only copy there is: the reader renders it, an agent
 *                 quotes it, and search runs over it. Searching raw markdown is
 *                 slightly noisier — a link target can match — and that is the
 *                 price of the content actually being here.
 *
 * Re-import adds and updates; it never deletes. Two reasons. A collection can
 * hold files that arrived from several places and nothing in a row says which,
 * so pruning "everything this walk didn't see" would quietly delete somebody's
 * dropped notes. And once content is in Spaces it is the workspace's, not the
 * folder's — removing a note is a decision a person makes here, through
 * removeKbFile.
 *
 * Workspace-visible collections replicate through the paired web workspace.
 * The remote copy is materialized into the same tables with an empty origin
 * path, so it is searchable and readable without pretending another person's
 * disk exists here. Private collections remain on their owner's machine, and
 * a received collection is never written back into an Obsidian folder.
 *
 * Access, search and the file listing are vaults.ts's and are delegated to
 * rather than restated: two permission models over one table is how a leak
 * happens. What is new here is ingest.
 *
 * There are no store actions for these tables, so this talks to getDb()
 * directly, in the style of vaults.ts and operations.ts.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getDb, now, uid } from "./db";
import { localMember } from "./calendars";
import {
  addVault,
  getVault,
  listVaultFiles,
  listVaults,
  removeVault,
  searchVault,
  updateVault,
  vaultAccess,
  visibleVaults,
  type VaultFileMeta,
} from "./vaults";
import type { EntityRef, ShareAccess, Vault } from "./types";

/* ── shapes ───────────────────────────────────────────────────── */

/**
 * A vaults row, read as a collection: owner and visibility exactly as they are
 * on a document or a calendar, and `path` demoted from a live mount to the
 * folder the content was imported from.
 */
export type Collection = Vault;

/** A stored file without its text, for listings. */
export type CollectionFile = VaultFileMeta;

/** One file on its way in. The drag-and-drop path and importFiles both use it. */
export interface ImportFile {
  /** Path inside the collection: forward slashes, no leading separator. */
  relPath: string;
  contents: string;
}

export interface ImportProgress {
  /** Files handled so far — copied, skipped or failed. */
  done: number;
  total: number;
  /** The file just handled, for a status line. */
  path: string;
}

export interface ImportReport {
  /** Files the walk found, or were handed to importFiles. */
  scanned: number;
  /** Files copied in or updated this run. */
  imported: number;
  /** Files whose size and timestamp matched the copy, so they were left alone. */
  unchanged: number;
  /** Files stored only up to KB_CONTENT_CAP characters. */
  capped: number;
  /** Files too big, or not text, to bring into the workspace database. */
  skipped: number;
  /** Files that could not be read; any previous copy is kept. */
  failed: number;
  /** The walk hit a depth or entry cap — the folder is bigger than one import. */
  truncated: boolean;
  /**
   * The recorded folder could not be walked on this machine. Not an error:
   * the content that was already imported is still here and still readable.
   */
  originMissing: boolean;
  /** Why the folder could not be walked, when it could not. */
  originError: string;
}

export interface KbHit {
  id: string;
  collection_id: string;
  rel_path: string;
  title: string;
  score: number;
  /** Plain text around the first match, with the ellipses already in it. */
  snippet: string;
  modified_at: number;
}

export interface KbSearchOptions {
  /** Restrict to one collection; default is every one the viewer may see. */
  collectionId?: string;
  limit?: number;
  viewer?: EntityRef;
}

export interface KbFileRead {
  text: string;
  size: number;
  modified_at: number;
  /**
   * True when only the first KB_CONTENT_CAP characters were kept at import, so
   * a reader can say the note continues rather than implying it ends there.
   */
  truncated: boolean;
  /**
   * Where this text came from. "workspace" is the copy — the one everybody
   * gets. "origin" means the import folder is on this machine and held more of
   * the file than the copy does, so the fuller text was read from it.
   */
  from: "workspace" | "origin";
}

export interface KbBacklink {
  id: string;
  rel_path: string;
  title: string;
  modified_at: number;
}

/** What a drop resolved to, before anything is written. */
export interface DropInspection {
  /** Dropped folders, each worth its own collection with provenance. */
  folders: string[];
  /** Dropped files, already read. */
  files: ImportFile[];
  /** Dropped paths that are not text, or could not be read. */
  ignored: string[];
}

/** What the Rust `walk_directory` command returns. */
interface DirEntryInfo {
  relPath: string;
  size: number;
  modifiedAt: number;
  isDir: boolean;
}

interface DirWalk {
  root: string;
  entries: DirEntryInfo[];
  truncated: boolean;
}

/* ── limits ───────────────────────────────────────────────────── */

/**
 * Characters kept per file. Generous, because this is the content and not an
 * index of it — a 100k-character note is a book chapter, and anything past
 * that is a log file somebody put in their notes folder. Imports report how
 * many files hit this so the UI can say so instead of silently truncating.
 */
export const KB_CONTENT_CAP = 100_000;

/**
 * Files bigger than this are left where they are.
 *
 * Deliberately below the mirror's own cap: a mirror could afford to point at a
 * large file because the bytes stayed on disk, and a copy pays for every byte
 * in the workspace database that then has to reach everyone.
 */
export const KB_FILE_SIZE_CAP = 1_000_000;

/** Walk bounds handed to the Rust side. Generous for notes, finite for a mistake. */
const WALK_MAX_DEPTH = 12;
const WALK_MAX_ENTRIES = 20_000;

/**
 * Excluded from every walk unless a collection says otherwise. The same set
 * vaults.ts defaults to, named here because a collection created without a
 * folder still needs one the day somebody imports a folder into it.
 */
export const DEFAULT_EXCLUDE = ".git,node_modules,.obsidian,.trash";

/**
 * Extensions brought in, markdown first.
 *
 * Shorter than the mirror's list on purpose. Indexing a source tree read-only
 * costs nothing but disk; copying one into the workspace database means every
 * member carries somebody's build output around forever. Prose and the plain
 * text formats that sit beside it in a notes folder, and nothing else.
 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "org", "adoc", "canvas",
  "csv", "tsv", "json", "yaml", "yml", "toml",
]);

/* ── access, ownership and the collection list ────────────────── */

/**
 * What `viewer` may do with `collection` — the vault rule, unchanged: the owner
 * administers it, a workspace-visible collection is readable by everyone, a
 * private one by nobody else. Null means "does not exist as far as this person
 * is concerned".
 *
 * "Write" is about the collection, not the notes: rename it, import into it,
 * remove it. Nothing in Spaces edits an imported note.
 */
export function kbAccess(
  collection: Collection,
  viewer: EntityRef = localMember()
): ShareAccess | null {
  return vaultAccess(collection, viewer);
}

/** Collections `viewer` may see at all, in a stable order. */
export async function listCollections(viewer: EntityRef = localMember()): Promise<Collection[]> {
  return visibleVaults(await listVaults(), viewer);
}

export async function getCollection(id: string): Promise<Collection | null> {
  return getVault(id);
}

function assertWritable(collection: Collection): void {
  if (kbAccess(collection) !== "write") {
    throw new Error(`"${collection.name}" belongs to someone else.`);
  }
}

/**
 * A new, empty collection.
 *
 * `origin` is optional and that is the entire difference from a vault: a
 * collection files were dropped into has no folder behind it and never will,
 * so it cannot be created through addVault, which quite reasonably refuses a
 * vault with nowhere to mount.
 */
export async function createCollection(input: {
  name?: string;
  origin?: string;
  exclude?: string;
  visibility?: Collection["visibility"];
} = {}): Promise<Collection> {
  const origin = (input.origin ?? "").trim();
  if (origin) {
    return addVault({
      name: input.name ?? "",
      path: origin,
      exclude: input.exclude ?? DEFAULT_EXCLUDE,
      visibility: input.visibility,
    });
  }

  const db = await getDb();
  const collection: Collection = {
    id: uid(),
    name: input.name?.trim() || "Imported notes",
    path: "",
    owner_member_id: localMember().id,
    visibility: input.visibility ?? "private",
    exclude: input.exclude ?? DEFAULT_EXCLUDE,
    file_count: 0,
    last_indexed_at: 0,
    created_at: now(),
  };
  await db.execute(
    `INSERT INTO vaults
     (id, name, path, owner_member_id, visibility, exclude, file_count, last_indexed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      collection.id,
      collection.name,
      collection.path,
      collection.owner_member_id,
      collection.visibility,
      collection.exclude,
      collection.file_count,
      collection.last_indexed_at,
      collection.created_at,
    ]
  );
  return collection;
}

/** Rename a collection, or change who in the workspace can read it. */
export async function updateCollection(
  id: string,
  patch: Partial<Pick<Collection, "name" | "visibility" | "exclude">>
): Promise<void> {
  // `path` is deliberately not patchable here: vaults.ts treats a path change
  // as "this mirror now points somewhere else" and drops every indexed row,
  // which for a collection would throw away the content itself.
  await updateVault(id, patch);
}

/**
 * Delete a collection and everything imported into it.
 *
 * Genuinely destructive when the origin folder is not on this machine — then
 * these rows are the only copy the workspace has. Callers are expected to have
 * checked originReachable() and said so.
 */
export async function removeCollection(id: string): Promise<void> {
  await removeVault(id);
}

/** Files in a collection, without their text. */
export async function listKbFiles(collectionId: string): Promise<CollectionFile[]> {
  return listVaultFiles(collectionId);
}

/** Forget one imported note. The only way content leaves a collection. */
export async function removeKbFile(collectionId: string, fileId: string): Promise<void> {
  const collection = await getCollection(collectionId);
  if (!collection) return;
  assertWritable(collection);
  const db = await getDb();
  await db.execute("DELETE FROM vault_files WHERE id = $1 AND vault_id = $2", [
    fileId,
    collectionId,
  ]);
  await recount(collectionId, collection.last_indexed_at);
}

/**
 * Whether the folder a collection was imported from can be walked here.
 *
 * False on another member's machine, and false after somebody moves the
 * folder — neither of which is a problem, which is the whole point of ingest.
 * The UI uses it to decide whether to offer re-import, and to tell the truth
 * about where a file lives.
 */
export async function originReachable(collection: Collection): Promise<boolean> {
  if (!collection.path) return false;
  try {
    // One entry is enough: the command canonicalises the root and refuses a
    // non-directory before it looks at anything inside.
    const walk = await invoke<DirWalk>("walk_directory", {
      root: collection.path,
      exclude: [],
      maxDepth: 1,
      maxEntries: 1,
    });
    return isWalk(walk);
  } catch {
    return false;
  }
}

/**
 * A walk that came back with the shape this module reads.
 *
 * Checked rather than assumed because "the folder is not reachable from here"
 * is a first-class, non-error state everywhere below: a response that cannot be
 * read has to land there too, instead of throwing halfway through an import.
 */
function isWalk(walk: DirWalk | undefined | null): walk is DirWalk {
  return Boolean(walk && Array.isArray(walk.entries));
}

/* ── import ───────────────────────────────────────────────────── */

function emptyReport(): ImportReport {
  return {
    scanned: 0,
    imported: 0,
    unchanged: 0,
    capped: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
    originMissing: false,
    originError: "",
  };
}

/**
 * Copy a folder of markdown into a new collection.
 *
 * One walk, one read per file, and then Spaces has the text. The folder is recorded
 * so re-import knows where to look, and so the UI can say where this came from
 * — not so that anything later depends on it still being there.
 */
export async function importFromFolder(
  path: string,
  opts: {
    name?: string;
    exclude?: string;
    visibility?: Collection["visibility"];
    onProgress?: (p: ImportProgress) => void;
  } = {}
): Promise<{ collection: Collection; report: ImportReport }> {
  const origin = path.trim();
  if (!origin) throw new Error("Importing from a folder needs a folder.");
  const created = await createCollection({
    name: opts.name,
    origin,
    exclude: opts.exclude,
    visibility: opts.visibility,
  });
  const report = await ingestFolder(created, opts.onProgress);
  return { collection: (await getCollection(created.id)) ?? created, report };
}

/**
 * Re-walk the folder a collection was imported from, if it is on this machine.
 *
 * Incremental exactly as the mirror was — size and timestamp decide whether a
 * file is read at all — so a steady-state re-import is one directory walk and
 * zero file reads. When the folder is absent the report says so and nothing
 * else happens: the copy is still here, still searchable, still readable. That
 * distinction is the reason this module exists.
 */
export async function reimport(
  collectionId: string,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportReport> {
  const collection = await getCollection(collectionId);
  if (!collection) throw new Error("That collection is gone.");
  assertWritable(collection);
  return ingestFolder(collection, onProgress);
}

async function ingestFolder(
  collection: Collection,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportReport> {
  const report = emptyReport();
  if (!collection.path) {
    report.originMissing = true;
    report.originError = "This collection was never imported from a folder.";
    return report;
  }

  let walk: DirWalk;
  try {
    walk = await invoke<DirWalk>("walk_directory", {
      root: collection.path,
      exclude: collection.exclude.split(",").map((p) => p.trim()).filter(Boolean),
      maxDepth: WALK_MAX_DEPTH,
      maxEntries: WALK_MAX_ENTRIES,
    });
  } catch (e) {
    // Missing, moved, on somebody else's machine, or unreadable — all of them
    // mean "cannot re-read from here", and none of them means the collection
    // is broken. The message is kept so the UI can be specific if it wants.
    report.originMissing = true;
    report.originError = e instanceof Error ? e.message : String(e);
    return report;
  }
  if (!isWalk(walk)) {
    report.originMissing = true;
    report.originError = "The folder walk returned nothing this build could read.";
    return report;
  }

  const db = await getDb();
  const files = walk.entries.filter((e) => !e.isDir && isTextFile(e.relPath));
  report.scanned = files.length;
  report.truncated = walk.truncated;

  const existing = new Map(
    (
      await db.select<{ rel_path: string; size: number; modified_at: number }[]>(
        "SELECT rel_path, size, modified_at FROM vault_files WHERE vault_id = $1",
        [collection.id]
      )
    ).map((r) => [r.rel_path, r] as const)
  );

  const stamp = now();
  let since = 0;
  let handled = 0;
  for (const file of files) {
    const modified = Math.round(file.modifiedAt);
    const prior = existing.get(file.relPath);
    // The incremental test. Anything that changed changes one of these two.
    if (prior && prior.size === file.size && prior.modified_at === modified) {
      report.unchanged++;
    } else if (file.size > KB_FILE_SIZE_CAP) {
      report.skipped++;
    } else {
      let text: string | null = null;
      try {
        text = await invoke<string>("read_text_file", {
          root: collection.path,
          relativePath: file.relPath,
        });
      } catch {
        report.failed++;
      }
      if (text !== null) {
        const capped = await storeFile(collection.id, {
          relPath: file.relPath,
          contents: text,
          size: file.size,
          modifiedAt: modified,
          stamp,
        });
        if (capped) report.capped++;
        report.imported++;
      }
    }
    handled++;
    since++;
    // Reporting every file would be thousands of renders for a job whose
    // interesting states are "still going" and "done".
    if (onProgress && (since >= 25 || handled === files.length)) {
      since = 0;
      onProgress({ done: handled, total: files.length, path: file.relPath });
    }
  }

  await recount(collection.id, stamp);
  return report;
}

/**
 * Copy files straight in — the drag-and-drop path, and anything else that
 * already holds the text.
 *
 * Size is measured from the text because there is no stat to read, and the
 * timestamp is now: a later folder import carrying the real mtime will differ
 * from it and re-read the file, which is the self-correcting direction.
 */
export async function importFiles(
  files: ImportFile[],
  collectionId: string,
  onProgress?: (p: ImportProgress) => void
): Promise<ImportReport> {
  const collection = await getCollection(collectionId);
  if (!collection) throw new Error("That collection is gone.");
  assertWritable(collection);

  const report = emptyReport();
  report.scanned = files.length;
  const stamp = now();
  let handled = 0;
  for (const file of files) {
    const relPath = normalizeRelPath(file.relPath);
    const size = byteLength(file.contents);
    if (!relPath || !isTextFile(relPath) || size > KB_FILE_SIZE_CAP) {
      report.skipped++;
    } else {
      const capped = await storeFile(collection.id, {
        relPath,
        contents: file.contents,
        size,
        modifiedAt: stamp,
        stamp,
      });
      if (capped) report.capped++;
      report.imported++;
    }
    handled++;
    if (onProgress) onProgress({ done: handled, total: files.length, path: relPath || file.relPath });
  }

  await recount(collection.id, stamp);
  return report;
}

/** Write one file's copy. Returns true when it was stored short of its end. */
async function storeFile(
  collectionId: string,
  file: { relPath: string; contents: string; size: number; modifiedAt: number; stamp: number }
): Promise<boolean> {
  const body = file.contents.slice(0, KB_CONTENT_CAP);
  const db = await getDb();
  // Upsert on the (vault_id, rel_path) unique index, so re-importing a file is
  // the same statement as importing it and the row keeps its id — which is
  // what a search result and an open reader are holding on to.
  await db.execute(
    `INSERT INTO vault_files
       (id, vault_id, rel_path, title, body, size, modified_at, indexed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (vault_id, rel_path) DO UPDATE SET
       title = excluded.title,
       body = excluded.body,
       size = excluded.size,
       modified_at = excluded.modified_at,
       indexed_at = excluded.indexed_at`,
    [
      uid(),
      collectionId,
      file.relPath,
      titleFor(file.relPath, file.contents),
      body,
      file.size,
      file.modifiedAt,
      file.stamp,
    ]
  );
  return body.length < file.contents.length;
}

/**
 * Bring the collection's counters in line with what it actually holds.
 *
 * Counted rather than accumulated because nothing prunes: the number of files
 * in a collection is a fact about the table, not a running total any one import
 * could know. `last_indexed_at` keeps its column name and means last imported.
 */
async function recount(collectionId: string, stamp: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM vault_files WHERE vault_id = $1",
    [collectionId]
  );
  await db.execute("UPDATE vaults SET file_count = $1, last_indexed_at = $2 WHERE id = $3", [
    Number(rows[0]?.n ?? 0),
    stamp,
    collectionId,
  ]);
}

/* ── reading ──────────────────────────────────────────────────── */

/**
 * One note's text.
 *
 * The copy in Spaces is the answer, which is what makes this work at all for
 * somebody who has never seen the folder. The single exception is a file that
 * was stored short of its end: if the origin folder happens to be on this
 * machine, the fuller text is worth reading, and the result says which one came
 * back so nothing has to pretend the two are the same thing.
 */
export async function readKbFile(collectionId: string, relPath: string): Promise<KbFileRead> {
  const collection = await getCollection(collectionId);
  if (!collection) throw new Error("That collection is gone.");
  if (!kbAccess(collection)) throw new Error(`"${collection.name}" is private.`);

  const db = await getDb();
  const rows = await db.select<{ body: string; size: number; modified_at: number }[]>(
    "SELECT body, size, modified_at FROM vault_files WHERE vault_id = $1 AND rel_path = $2",
    [collectionId, relPath]
  );
  const row = rows[0];
  if (!row) throw new Error(`“${relPath}” is not in ${collection.name}.`);

  const truncated = row.body.length >= KB_CONTENT_CAP;
  if (truncated && collection.path) {
    try {
      const full = await invoke<string>("read_text_file", {
        root: collection.path,
        relativePath: relPath,
      });
      if (full.length > row.body.length) {
        return { text: full, size: row.size, modified_at: row.modified_at, truncated: false, from: "origin" };
      }
    } catch {
      // The folder is not here, which is ordinary. The copy still answers.
    }
  }
  return { text: row.body, size: row.size, modified_at: row.modified_at, truncated, from: "workspace" };
}

/**
 * Notes in the same collection that point at `relPath` with an Obsidian
 * wikilink. The candidate filter stays in SQLite and exact resolution stays in
 * JavaScript, keeping a large vault responsive without treating plain text as
 * a backlink.
 */
export async function listKbBacklinks(
  collectionId: string,
  relPath: string,
): Promise<KbBacklink[]> {
  const collection = await getCollection(collectionId);
  if (!collection || !kbAccess(collection)) return [];
  const targetPath = normalizeRelPath(relPath).toLowerCase();
  const fileName = targetPath.slice(targetPath.lastIndexOf("/") + 1);
  const targetName = fileName.replace(/\.[^.]+$/, "");
  const targetWithoutExtension = targetPath.replace(/\.[^./]+$/, "");
  const db = await getDb();
  const rows = await db.select<
    Array<KbBacklink & { body: string }>
  >(
    `SELECT id, rel_path, title, modified_at, body
       FROM vault_files
      WHERE vault_id = $1
        AND rel_path <> $2
        AND (lower(body) LIKE $3 OR lower(body) LIKE $4)
      ORDER BY title, rel_path
      LIMIT 500`,
    [
      collectionId,
      relPath,
      `%[[${targetName.toLowerCase()}%`,
      `%[[${targetWithoutExtension}%`,
    ],
  );
  return rows
    .filter((row) => {
      const links = row.body.matchAll(/\[\[([^\][|\n]+)(?:\|[^\]\n]+)?\]\]/g);
      for (const link of links) {
        const bare = normalizeRelPath(
          String(link[1] ?? "").split(/[#^]/)[0].replace(/^\.?\//, ""),
        ).toLowerCase();
        if (!bare) continue;
        const withoutExtension = bare.replace(/\.[^./]+$/, "");
        const linkedName = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
        if (
          bare === targetPath ||
          withoutExtension === targetWithoutExtension ||
          linkedName === targetName.toLowerCase()
        ) {
          return true;
        }
      }
      return false;
    })
    .map(({ body: _body, ...row }) => row);
}

/* ── search ───────────────────────────────────────────────────── */

/**
 * Ranked matches across every collection the viewer may see.
 *
 * The ranking is vaults.ts's, reused whole — it does its work inside SQLite and
 * there is no second implementation worth maintaining. The one thing added here
 * is flattening the snippet: bodies now hold markdown source, so a snippet
 * lifted straight out of one would show its syntax to somebody who is reading
 * search results, not a file.
 */
export async function searchKb(query: string, opts: KbSearchOptions = {}): Promise<KbHit[]> {
  const hits = await searchVault(query, {
    vaultId: opts.collectionId,
    limit: opts.limit,
    viewer: opts.viewer,
  });
  return hits.map((hit) => ({
    id: hit.id,
    collection_id: hit.vault_id,
    rel_path: hit.rel_path,
    title: hit.title,
    score: hit.score,
    snippet: flatten(hit.snippet),
    modified_at: hit.modified_at,
  }));
}

/* ── drag and drop ────────────────────────────────────────────── */

/**
 * Watch for files dropped onto the window.
 *
 * Tauri intercepts file drops before the DOM sees them, so the HTML drop event
 * never carries files and this is the only way in. The payload is
 * `@tauri-apps/api/webview`'s DragDropEvent — `{ type: 'enter' | 'over' |
 * 'drop' | 'leave', paths, position }`, with `paths` on enter and drop only,
 * and `position` in physical pixels. Anything else arriving here means the API
 * has moved: `onUnsupported` fires instead of a guess, and the caller is
 * expected to fall back to the folder picker and say so.
 *
 * `position` is divided by devicePixelRatio to land in the CSS pixels a
 * bounding rect is measured in, which is what lets a caller accept a drop on
 * its own panel and ignore one on the rest of the window.
 *
 * Returns an unsubscribe. Call it when the view unmounts — the listener is
 * global and would otherwise keep importing into a screen nobody is looking at.
 */
export function watchFileDrop(handlers: {
  onDrop: (paths: string[]) => void;
  onEnter?: () => void;
  onLeave?: () => void;
  /** CSS-pixel hit test; return false to ignore a drag over this point. */
  accepts?: (x: number, y: number) => boolean;
  onUnsupported?: (reason: string) => void;
}): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  let inside = false;

  const at = (position: unknown): { x: number; y: number } | null => {
    const p = position as { x?: unknown; y?: unknown } | null | undefined;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
    const ratio = window.devicePixelRatio || 1;
    return { x: p.x / ratio, y: p.y / ratio };
  };
  const wanted = (position: unknown): boolean => {
    if (!handlers.accepts) return true;
    const point = at(position);
    return point ? handlers.accepts(point.x, point.y) : false;
  };
  const leave = () => {
    if (!inside) return;
    inside = false;
    handlers.onLeave?.();
  };

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const payload = event.payload as {
        type?: unknown;
        paths?: unknown;
        position?: unknown;
      };
      if (typeof payload?.type !== "string") {
        handlers.onUnsupported?.("The drag-and-drop event did not have the shape this build expects.");
        return;
      }
      if (payload.type === "leave") {
        leave();
        return;
      }
      if (payload.type === "enter" || payload.type === "over") {
        if (wanted(payload.position)) {
          if (!inside) {
            inside = true;
            handlers.onEnter?.();
          }
        } else {
          leave();
        }
        return;
      }
      if (payload.type !== "drop") return;
      const over = wanted(payload.position);
      leave();
      if (!over) return;
      if (!Array.isArray(payload.paths)) {
        handlers.onUnsupported?.("The drop carried no file paths this build could read.");
        return;
      }
      const paths = payload.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length) handlers.onDrop(paths);
    })
    .then((fn) => {
      // The caller may already have unmounted while this was resolving.
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch((e) => {
      handlers.onUnsupported?.(e instanceof Error ? e.message : String(e));
    });

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/**
 * Sort dropped paths into folders, readable files and the rest.
 *
 * A drop gives paths and nothing else — no flag saying which are directories —
 * so anything that does not read as a file is probed with a one-entry walk.
 * Reading first keeps the common case (a handful of notes) to one call each,
 * and the probe still catches the awkward case the extension would get wrong:
 * a folder called `notes.md` is a folder.
 *
 * Folders come back unread because they deserve their own collection with the
 * folder recorded as its origin; loose files come back with their text, ready
 * for importFiles.
 */
export async function inspectDrop(paths: string[]): Promise<DropInspection> {
  const result: DropInspection = { folders: [], files: [], ignored: [] };
  for (const path of paths) {
    const clean = path.trim();
    if (!clean) continue;
    const name = baseName(clean);
    if (isTextFile(name)) {
      try {
        const contents = await invoke<string>("read_text_file", {
          root: parentDir(clean),
          relativePath: name,
        });
        result.files.push({ relPath: name, contents });
        continue;
      } catch {
        // Unreadable, or a directory wearing a file's name. Fall through.
      }
    }
    if (await isDirectory(clean)) result.folders.push(clean);
    else result.ignored.push(clean);
  }
  return result;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await invoke<DirWalk>("walk_directory", {
      root: path,
      exclude: [],
      maxDepth: 1,
      maxEntries: 1,
    });
    return true;
  } catch {
    return false;
  }
}

/* ── text ─────────────────────────────────────────────────────── */

/** Both separators, because a drop on Windows hands back backslashes. */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? "/" : ".";
}

/** The folder a collection was imported from, as a person would name it. */
export function folderName(path: string): string {
  return baseName(path);
}

/**
 * A path stored in vault_files: forward slashes, no leading separator, no
 * traversal. rel_path is half of a unique key and the thing wikilinks resolve
 * against, so it has to be one shape.
 */
function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function extensionOf(relPath: string): string {
  const name = baseName(relPath);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isTextFile(relPath: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(relPath));
}

/** UTF-8 bytes, so a dropped file's size compares against one read off disk. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * YAML frontmatter split off from the note.
 *
 * Exported because the copy keeps it — it is part of the file, and its tags are
 * worth searching — while a reader that renders it verbatim shows somebody a
 * wall of keys before their first sentence. Callers can show it as metadata,
 * or not at all.
 */
export function splitFrontmatter(text: string): { front: string; body: string } {
  if (!text.startsWith("---")) return { front: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { front: "", body: text };
  const close = text.indexOf("\n", end + 1);
  return {
    front: text.slice(3, end).trim(),
    body: close === -1 ? "" : text.slice(close + 1),
  };
}

/**
 * A file's display title: frontmatter `title:`, else the first heading, else
 * the filename. The same rule vaults.ts applies, which is not exported from
 * there — when one changes the other has to change with it, or the same note
 * gets two names depending on which way it came in.
 */
function titleFor(relPath: string, text: string): string {
  const { front, body } = splitFrontmatter(text);
  const fromFront = /^title:\s*(.+)$/m.exec(front);
  if (fromFront) {
    const value = fromFront[1].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  const heading = /^#{1,6}\s+(.+)$/m.exec(body);
  if (heading) {
    const value = heading[1].trim().replace(/\s*#+\s*$/, "");
    if (value) return value;
  }
  const name = baseName(relPath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Markdown flattened to the words a person would read in a result row.
 *
 * Runs over a snippet, never a whole file: a couple of hundred characters that
 * came out of the middle of a note, so it drops syntax and keeps the text on
 * both sides of a link rather than trying to parse anything.
 */
function flatten(text: string): string {
  return text
    .replace(/^\s*```.*$/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\][|]*)\|([^\]]*)\]\]/g, "$1 $2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}[>#]+\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
