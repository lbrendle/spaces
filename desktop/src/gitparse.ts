/**
 * gitparse.ts — pure parsers for git's machine-readable output.
 *
 * Kept free of every import on purpose. These are the load-bearing bits of the
 * coordination layer: if `parseMergeTree` is wrong, Spaces tells someone their
 * branch will land cleanly and it will not. Having them in a module with no
 * dependencies is what makes them testable under `node --test` without a Tauri
 * runtime, which is the only way that claim gets checked.
 */

export interface MergeTreeOutput {
  /** The merged tree OID. "" when git did not produce one (a broken invocation). */
  tree: string;
  /** Paths git could not merge automatically. */
  conflicts: string[];
}

/**
 * Parse `git merge-tree --write-tree --name-only <a> <b>`.
 *
 * Verified against git 2.54. The layout is:
 *
 *     <tree OID>
 *     <conflicted path>          ← zero or more, only when there are conflicts
 *     <blank line>
 *     Auto-merging <path>        ← the informational block
 *     CONFLICT (content): ...
 *
 * The blank line is the only reliable boundary: the message block's first line
 * is "Auto-merging <path>", which a naive path collector happily mistakes for a
 * conflicted path — and a path that is not conflicted, reported as conflicted,
 * is the exact failure this parser exists to avoid.
 *
 * git exits 1 when there are conflicts and 0 when there are not, but the whole
 * answer is on stdout either way, so callers must not treat the non-zero exit
 * as a failure.
 */
export function parseMergeTree(raw: string): MergeTreeOutput {
  const rows = raw.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < rows.length && rows[index].trim() === "") index++;

  const tree = (rows[index] ?? "").trim();
  index++;

  const conflicts: string[] = [];
  for (; index < rows.length; index++) {
    const row = rows[index];
    // The blank line ends the path section and starts the prose.
    if (row.trim() === "") break;
    conflicts.push(row.trim());
  }

  return { tree, conflicts: [...new Set(conflicts.filter(Boolean))] };
}

/** True when the string is a plausible git object id. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/.test(value.trim());
}

/**
 * Paths out of `git status --porcelain`.
 *
 * Two details that bite: the status code occupies the first two columns and the
 * path starts at column 3, and a rename is written `old -> new`, where only the
 * new path is the one anybody wants to reason about.
 */
export function parsePorcelainPaths(raw: string): string[] {
  const out: string[] = [];
  for (const row of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (row.trim() === "") continue;
    const path = row.slice(3).trim();
    if (!path) continue;
    const arrow = path.indexOf(" -> ");
    out.push(arrow === -1 ? unquote(path) : unquote(path.slice(arrow + 4).trim()));
  }
  return out;
}

/** git quotes paths containing unusual bytes; strip the quoting for display. */
function unquote(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path;
  return path.slice(1, -1).replace(/\\(["\\])/g, "$1");
}
