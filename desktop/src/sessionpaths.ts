/**
 * sessionpaths.ts — deciding which project a session belongs to.
 *
 * Pure and import-free on purpose, like `gitparse.ts`: this is the part of the
 * import that is easy to get subtly wrong and impossible to notice, because a
 * mistake does not fail — it quietly files a thousand sessions under a project
 * that will be deleted, or splits one project into forty.
 */

/** The smallest shape of a project this module needs. */
export interface PathedProject {
  id: string;
  local_path: string;
}

/**
 * Where a session really belongs.
 *
 * Agents run in worktrees — Spaces makes them itself, under
 * `<repo>/.claude/worktrees/<branch>` — and a session that ran in one is about
 * the repository, not about a directory that disappears when the branch lands.
 * On this machine roughly a fifth of all sessions are in worktrees; left alone
 * they shatter one project into dozens of one-off folders that no longer
 * exist. Collapsing them is what makes "240 sessions in archii" true instead
 * of "240 folders with one session each".
 *
 * Trailing slashes go too, so `/repo` and `/repo/` are one project.
 */
export function rootOf(cwd: string): string {
  const marker = "/.claude/worktrees/";
  const at = (cwd ?? "").indexOf(marker);
  const root = at > 0 ? cwd.slice(0, at) : (cwd ?? "");
  // Never strip a lone "/" to "": an empty path means "no directory", which is
  // a different answer.
  return root.length > 1 ? root.replace(/\/+$/, "") : root;
}

/** The last path component, for use as a project name. */
export function nameOf(cwd: string): string {
  const parts = rootOf(cwd).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * The project a directory belongs to, if Spaces already has one.
 *
 * An exact path first, then the deepest project this directory sits inside. A
 * session run in `<repo>/src` is the repository's, not a new project called
 * "src" — and when projects nest, the innermost one owns it.
 *
 * Containment is tested with a trailing separator so `/repo-two` is never
 * matched by `/repo`.
 */
export function matchProject<T extends PathedProject>(
  cwd: string,
  projects: readonly T[]
): T | undefined {
  const root = rootOf(cwd);
  if (!root) return undefined;

  const candidates = projects.filter((p) => p.local_path && rootOf(p.local_path));
  const exact = candidates.find((p) => rootOf(p.local_path) === root);
  if (exact) return exact;

  return candidates
    .filter((p) => root.startsWith(`${rootOf(p.local_path)}/`))
    .sort((a, b) => rootOf(b.local_path).length - rootOf(a.local_path).length)[0];
}

/**
 * A path short enough for a list row, without lying about it.
 *
 * The usual trick for this is CSS — `direction: rtl` with an ellipsis, so the
 * informative tail survives and the head is clipped. It is also wrong for
 * paths: RTL reorders the leading separator to the other end, so
 * `/Users/lauren/lauren/spaces` renders as `Users/lauren/lauren/spaces/`. A
 * path that is subtly not the path is worse than one that is visibly
 * abbreviated, so this elides the middle explicitly and leaves rendering
 * alone.
 *
 * The first component and the last two are kept: the root says whose machine
 * it is, and the tail is what tells two projects apart.
 */
export function shortPath(path: string, max = 56): string {
  if (!path || path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  const head = parts[0];
  const tail = parts.slice(-2).join("/");
  const short = `/${head}/…/${tail}`;
  // Still too long means the tail itself is long, and the tail is the part
  // worth keeping.
  return short.length < path.length ? short : path;
}
