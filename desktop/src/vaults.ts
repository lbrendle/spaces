/**
 * Vaults — a folder on disk mirrored into Spaces, read-only.
 *
 * Point Spaces at an Obsidian vault or a docs directory and it keeps a searchable
 * shadow of the text in SQLite: title, a capped plain-text body, size and
 * mtime. Read-only is the whole design. Spaces is not going to be the thing that
 * mangles somebody's notes, and the value — search, and an agent that can
 * recall what you already wrote down — needs no write access at all. The one
 * command that touches disk is `read_text_file`, and the walk itself refuses
 * to leave the root.
 *
 * Re-indexing is incremental because it has to be: re-reading five thousand
 * notes every time a view mounts is not a thing anyone would tolerate twice.
 * Size and mtime from the walk decide whether a file is read at all, so a
 * steady-state re-index is one directory walk and zero file reads.
 *
 * There are no store actions for vaults, so this module talks to getDb()
 * directly in the style of operations.ts.
 */
import { invoke } from "@tauri-apps/api/core";
import { getDb, now, uid } from "./db";
import { localMember } from "./calendars";
import type { EntityRef, ShareAccess, Vault, VaultFile } from "./types";

/* ── limits ───────────────────────────────────────────────────── */

/**
 * How much plain text is kept per file for search. A long note still matches
 * on anything in its first ~40k characters; the tail is on disk, and
 * readVaultFile() serves it. Indexing reports how many files hit this so the
 * UI can be honest rather than silently lossy.
 */
export const VAULT_BODY_CAP = 40_000;

/** Files bigger than this are listed but never read — a 40MB log is not prose. */
export const VAULT_FILE_SIZE_CAP = 2_000_000;

/** Walk bounds handed to the Rust side. Generous for notes, finite for a mistake. */
const WALK_MAX_DEPTH = 12;
const WALK_MAX_ENTRIES = 20_000;

/**
 * Rows a single search may consider. The SQL filter has already thrown away
 * everything that matches no term, so hitting this means the query was a very
 * common word — in which case the first few hundred hits are as good an answer
 * as any, and a bounded one.
 */
const SEARCH_CANDIDATE_CAP = 2_000;

/** Terms beyond this are dropped: each one costs a scan of every body. */
const SEARCH_MAX_TERMS = 6;

/**
 * Extensions read as text. An allow-list rather than a binary deny-list on
 * purpose — the failure mode of a missing extension is "your .heic isn't
 * searchable", while the failure mode of a missed binary type is a megabyte of
 * mojibake in the search index.
 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "org", "adoc", "canvas",
  "csv", "tsv", "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "html", "htm", "xml", "css", "scss", "svg",
  "js", "jsx", "ts", "tsx", "py", "rb", "rs", "go", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "zsh", "sql", "gitignore",
]);

/* ── shapes ───────────────────────────────────────────────────── */

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

/** A vault_files row without its body, for listings that only need the shape. */
export type VaultFileMeta = Omit<VaultFile, "body">;

export interface IndexProgress {
  /** Text files processed so far, read or skipped. */
  done: number;
  total: number;
  /** The file just handled, for a status line. */
  path: string;
}

export interface IndexReport {
  /** Text files the walk found. */
  scanned: number;
  /** Files actually read this run. */
  indexed: number;
  /** Files whose size and mtime were unchanged, so they were left alone. */
  skipped: number;
  /** Rows dropped because the file is no longer on disk. */
  removed: number;
  /** Files stored only up to VAULT_BODY_CAP characters. */
  capped: number;
  /** Files that could not be read at all; their previous row is kept. */
  failed: number;
  /** The walk hit a depth or entry cap — this vault is bigger than the mirror. */
  truncated: boolean;
}

export interface VaultHit {
  id: string;
  vault_id: string;
  rel_path: string;
  title: string;
  score: number;
  /** Plain text around the first match, with the ellipses already in it. */
  snippet: string;
  modified_at: number;
}

export interface SearchOptions {
  /** Restrict to one vault; default is every vault the viewer may see. */
  vaultId?: string;
  limit?: number;
  viewer?: EntityRef;
}

/* ── access ───────────────────────────────────────────────────── */

/**
 * What `viewer` may do with `vault`, mirroring calendars.ts: the owner writes,
 * a workspace-visible vault is readable by everyone, a private one by nobody
 * else. Null means "does not exist as far as this person is concerned".
 *
 * "Write" here never means writing to disk — nothing in Spaces does that to a
 * vault. It means administering the mirror: rename it, re-index it, remove it.
 */
export function vaultAccess(
  vault: Vault,
  viewer: EntityRef = localMember()
): ShareAccess | null {
  if (viewer.type === "member" && vault.owner_member_id === viewer.id) return "write";
  return vault.visibility === "workspace" ? "read" : null;
}

/** Vaults `viewer` may see at all, in a stable order. */
export function visibleVaults(vaults: Vault[], viewer: EntityRef = localMember()): Vault[] {
  return vaults
    .filter((v) => vaultAccess(v, viewer) !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function assertAdministrable(vault: Vault): void {
  if (vaultAccess(vault) !== "write") {
    throw new Error(`"${vault.name}" belongs to someone else.`);
  }
}

/* ── the vault list ───────────────────────────────────────────── */

export async function listVaults(): Promise<Vault[]> {
  const db = await getDb();
  return db.select<Vault[]>("SELECT * FROM vaults ORDER BY name, id");
}

export async function getVault(id: string): Promise<Vault | null> {
  const db = await getDb();
  const rows = await db.select<Vault[]>("SELECT * FROM vaults WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function addVault(input: {
  name: string;
  path: string;
  visibility?: Vault["visibility"];
  exclude?: string;
}): Promise<Vault> {
  const path = input.path.trim();
  if (!path) throw new Error("A vault needs a folder.");
  const db = await getDb();
  const vault: Vault = {
    id: uid(),
    name: input.name.trim() || folderName(path),
    path,
    owner_member_id: localMember().id,
    visibility: input.visibility ?? "private",
    exclude: input.exclude ?? ".git,node_modules,.obsidian,.trash",
    file_count: 0,
    last_indexed_at: 0,
    created_at: now(),
  };
  await db.execute(
    `INSERT INTO vaults
     (id, name, path, owner_member_id, visibility, exclude, file_count, last_indexed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      vault.id,
      vault.name,
      vault.path,
      vault.owner_member_id,
      vault.visibility,
      vault.exclude,
      vault.file_count,
      vault.last_indexed_at,
      vault.created_at,
    ]
  );
  return vault;
}

export async function updateVault(
  id: string,
  patch: Partial<Pick<Vault, "name" | "path" | "visibility" | "exclude">>
): Promise<void> {
  const vault = await getVault(id);
  if (!vault) return;
  assertAdministrable(vault);
  const db = await getDb();
  for (const key of ["name", "path", "visibility", "exclude"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    await db.execute(`UPDATE vaults SET ${key} = $1 WHERE id = $2`, [value, id]);
  }
  // Pointing a vault at a different folder invalidates every indexed row: the
  // paths are relative to a root that no longer exists.
  if (patch.path !== undefined && patch.path.trim() !== vault.path) {
    await db.execute("DELETE FROM vault_files WHERE vault_id = $1", [id]);
    await db.execute("UPDATE vaults SET file_count = 0, last_indexed_at = 0 WHERE id = $1", [id]);
  }
}

/** Forget a vault and everything indexed from it. The folder itself is untouched. */
export async function removeVault(id: string): Promise<void> {
  const vault = await getVault(id);
  if (!vault) return;
  assertAdministrable(vault);
  const db = await getDb();
  await db.execute("DELETE FROM vault_files WHERE vault_id = $1", [id]);
  await db.execute("DELETE FROM vaults WHERE id = $1", [id]);
}

/* ── indexing ─────────────────────────────────────────────────── */

/**
 * Bring the mirror of `vaultId` in line with what is on disk.
 *
 * One walk, then a read of only the files whose size or mtime moved. Rows for
 * files that have gone are deleted, so a search never offers a note that isn't
 * there any more. A file that cannot be read (permissions, a broken symlink,
 * something that turned out not to be UTF-8) is counted and its previous row
 * left alone — the last good copy beats no copy.
 */
export async function indexVault(
  vaultId: string,
  onProgress?: (p: IndexProgress) => void
): Promise<IndexReport> {
  const vault = await getVault(vaultId);
  if (!vault) throw new Error("That vault is gone.");
  assertAdministrable(vault);
  const db = await getDb();

  const walk = await invoke<DirWalk>("walk_directory", {
    root: vault.path,
    exclude: vault.exclude.split(",").map((p) => p.trim()).filter(Boolean),
    maxDepth: WALK_MAX_DEPTH,
    maxEntries: WALK_MAX_ENTRIES,
  });

  const files = walk.entries.filter((e) => !e.isDir && isTextFile(e.relPath));
  const report: IndexReport = {
    scanned: files.length,
    indexed: 0,
    skipped: 0,
    removed: 0,
    capped: 0,
    failed: 0,
    truncated: walk.truncated,
  };

  const existing = new Map(
    (
      await db.select<{ id: string; rel_path: string; size: number; modified_at: number }[]>(
        "SELECT id, rel_path, size, modified_at FROM vault_files WHERE vault_id = $1",
        [vaultId]
      )
    ).map((r) => [r.rel_path, r] as const)
  );

  const stamp = now();
  const seen = new Set<string>();
  let since = 0;
  for (const file of files) {
    seen.add(file.relPath);
    const modified = Math.round(file.modifiedAt);
    const prior = existing.get(file.relPath);
    // The incremental test. Anything that changed changes one of these two.
    if (prior && prior.size === file.size && prior.modified_at === modified) {
      report.skipped++;
    } else if (file.size > VAULT_FILE_SIZE_CAP) {
      report.skipped++;
    } else {
      let text: string | null = null;
      try {
        text = await invoke<string>("read_text_file", {
          root: vault.path,
          relativePath: file.relPath,
        });
      } catch {
        report.failed++;
      }
      if (text !== null) {
        const plain = plainText(text);
        const body = plain.slice(0, VAULT_BODY_CAP);
        if (body.length < plain.length) report.capped++;
        const title = titleFor(file.relPath, text);
        if (prior) {
          await db.execute(
            `UPDATE vault_files SET title=$1, body=$2, size=$3, modified_at=$4, indexed_at=$5
             WHERE id=$6`,
            [title, body, file.size, modified, stamp, prior.id]
          );
        } else {
          await db.execute(
            `INSERT INTO vault_files
             (id, vault_id, rel_path, title, body, size, modified_at, indexed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [uid(), vaultId, file.relPath, title, body, file.size, modified, stamp]
          );
        }
        report.indexed++;
      }
    }
    since++;
    // Reporting every file would be thousands of renders for a job whose
    // interesting states are "still going" and "done".
    const done = report.indexed + report.skipped + report.failed;
    if (onProgress && (since >= 25 || done === files.length)) {
      since = 0;
      onProgress({ done, total: files.length, path: file.relPath });
    }
  }

  for (const [relPath, row] of existing) {
    if (seen.has(relPath)) continue;
    await db.execute("DELETE FROM vault_files WHERE id = $1", [row.id]);
    report.removed++;
  }

  await db.execute("UPDATE vaults SET file_count = $1, last_indexed_at = $2 WHERE id = $3", [
    seen.size,
    stamp,
    vaultId,
  ]);
  return report;
}

/** Indexed files in a vault, without their bodies. */
export async function listVaultFiles(vaultId: string): Promise<VaultFileMeta[]> {
  const db = await getDb();
  return db.select<VaultFileMeta[]>(
    `SELECT id, vault_id, rel_path, title, size, modified_at, indexed_at
     FROM vault_files WHERE vault_id = $1 ORDER BY rel_path`,
    [vaultId]
  );
}

/** The file as it is on disk, for rendering. Never the indexed, flattened copy. */
export async function readVaultFile(vaultId: string, relPath: string): Promise<string> {
  const vault = await getVault(vaultId);
  if (!vault) throw new Error("That vault is gone.");
  if (!vaultAccess(vault)) throw new Error(`"${vault.name}" is private.`);
  return invoke<string>("read_text_file", { root: vault.path, relativePath: relPath });
}

/* ── search ───────────────────────────────────────────────────── */

/**
 * Ranked matches across title and body.
 *
 * The work that scales with vault size happens in SQLite: one pass computes,
 * per row, where each term first appears in the title and in the body, and
 * discards rows that match nothing. Only the surviving rows cross into JS to
 * be scored, and only the winners have their bodies fetched for a snippet —
 * so a thousand-note vault moves a few kilobytes per keystroke, not megabytes.
 *
 * Scoring is plain and ties break on title then path, so the same query
 * against the same index always returns the same order.
 */
export async function searchVault(query: string, opts: SearchOptions = {}): Promise<VaultHit[]> {
  const phrase = query.trim().toLowerCase();
  if (!phrase) return [];
  const terms = [...new Set(phrase.split(/\s+/).filter(Boolean))].slice(0, SEARCH_MAX_TERMS);
  if (!terms.length) return [];
  const limit = Math.max(1, opts.limit ?? 20);

  const viewer = opts.viewer ?? localMember();
  const vaults = visibleVaults(await listVaults(), viewer).filter(
    (v) => !opts.vaultId || v.id === opts.vaultId
  );
  if (!vaults.length) return [];

  const params: (string | number)[] = [];
  const cols: string[] = [];
  const conds: string[] = [];
  const slots: { title: string; body: string }[] = [];
  for (const term of terms) {
    params.push(term);
    const i = params.length;
    cols.push(`instr(lower(title), $${i}) AS t${i}`, `instr(lower(body), $${i}) AS b${i}`);
    conds.push(`(instr(lower(title), $${i}) > 0 OR instr(lower(body), $${i}) > 0)`);
    slots.push({ title: `t${i}`, body: `b${i}` });
  }
  // The whole query as one string scores far above its parts scattered around.
  let phraseCol = "";
  if (terms.length > 1) {
    params.push(phrase);
    phraseCol = `p${params.length}`;
    cols.push(`instr(lower(body), $${params.length}) AS ${phraseCol}`);
  }
  const vaultSlots = vaults.map((v) => {
    params.push(v.id);
    return `$${params.length}`;
  });
  conds.push(`vault_id IN (${vaultSlots.join(",")})`);

  const db = await getDb();
  const rows = await db.select<Record<string, string | number>[]>(
    `SELECT id, vault_id, rel_path, title, modified_at, ${cols.join(", ")}
     FROM vault_files
     WHERE ${conds.join(" AND ")}
     LIMIT ${SEARCH_CANDIDATE_CAP}`,
    params
  );

  const scored = rows.map((row) => {
    const title = String(row.title ?? "");
    const lower = title.toLowerCase();
    let score = 0;
    let inTitle = 0;
    let firstBodyHit = Number.MAX_SAFE_INTEGER;
    for (const slot of slots) {
      const t = Number(row[slot.title] ?? 0);
      const b = Number(row[slot.body] ?? 0);
      if (t > 0) {
        score += 120;
        inTitle++;
      }
      if (b > 0) {
        score += 30;
        firstBodyHit = Math.min(firstBodyHit, b);
      }
    }
    if (inTitle === slots.length) score += 200;
    if (lower === phrase) score += 1000;
    else if (lower.startsWith(phrase)) score += 300;
    else if (lower.includes(phrase)) score += 150;
    if (phraseCol && Number(row[phraseCol] ?? 0) > 0) score += 80;
    // A hit in the opening lines is usually what the note is about; one deep
    // in an appendix usually isn't. Small enough to only break near-ties.
    if (firstBodyHit !== Number.MAX_SAFE_INTEGER) {
      score += Math.max(0, 40 - Math.floor(firstBodyHit / 40));
    }
    return {
      id: String(row.id),
      vault_id: String(row.vault_id),
      rel_path: String(row.rel_path),
      title,
      modified_at: Number(row.modified_at ?? 0),
      score,
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.title.localeCompare(b.title) ||
      a.rel_path.localeCompare(b.rel_path)
  );
  const top = scored.slice(0, limit);
  if (!top.length) return [];

  const bodies = new Map(
    (
      await db.select<{ id: string; body: string }[]>(
        `SELECT id, body FROM vault_files WHERE id IN (${top.map((_, i) => `$${i + 1}`).join(",")})`,
        top.map((r) => r.id)
      )
    ).map((r) => [r.id, r.body] as const)
  );

  return top.map((row) => ({
    ...row,
    snippet: snippetFor(bodies.get(row.id) ?? "", terms),
  }));
}

/* ── text ─────────────────────────────────────────────────────── */

function folderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function extensionOf(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isTextFile(relPath: string): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(relPath));
}

/** YAML frontmatter, returned separately so a `title:` can still be read out of it. */
function splitFrontmatter(text: string): { front: string; rest: string } {
  if (!text.startsWith("---")) return { front: "", rest: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { front: "", rest: text };
  const close = text.indexOf("\n", end + 1);
  return {
    front: text.slice(3, end),
    rest: close === -1 ? "" : text.slice(close + 1),
  };
}

/**
 * A file's display title: frontmatter `title:`, else the first heading, else
 * the filename. Obsidian users write the first two; everyone gets the third.
 */
function titleFor(relPath: string, text: string): string {
  const { front, rest } = splitFrontmatter(text);
  const fromFront = /^title:\s*(.+)$/m.exec(front);
  if (fromFront) {
    const value = fromFront[1].trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  const heading = /^#{1,6}\s+(.+)$/m.exec(rest);
  if (heading) {
    const value = heading[1].trim().replace(/\s*#+\s*$/, "");
    if (value) return value;
  }
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Markdown flattened to the words a person would search for.
 *
 * Two calls worth naming. Link syntax keeps its text and drops its target, so
 * "roadmap" finds `[[2026/roadmap|the plan]]` by either half while "http"
 * doesn't return every note that cites a URL. And fenced code keeps its
 * contents — only the fence line goes — because in a docs directory the
 * identifier you half-remember is usually inside the code block.
 */
function plainText(text: string): string {
  const { rest } = splitFrontmatter(text);
  return rest
    .replace(/^\s*```.*$/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$1 $2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}[>#]+\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Plain text around the first term hit, with ellipses where it was cut. */
function snippetFor(body: string, terms: string[]): string {
  if (!body) return "";
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return body.slice(0, 180).trim();
  const start = Math.max(0, at - 80);
  const end = Math.min(body.length, at + 160);
  const text = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < body.length ? "…" : ""}`;
}
