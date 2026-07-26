/**
 * Everything Spaces knows about GitHub, which is everything the `gh` CLI will tell
 * it. There is no token here and no HTTP client: `run_gh` shells out to the
 * binary the user already signed in with, so the app inherits their auth and
 * never holds a credential.
 *
 * This module carries three things beyond the queries themselves, all of them
 * fixes for the same failure: a GitHub section that renders nothing and does
 * not say why.
 *
 *  1. Every rejection is a `GhError`, which knows the command it ran and what
 *     came back on stderr. A caller that only reads `.message` still gets the
 *     real text; a caller that wants to show the user what was tried can.
 *  2. `ghCapability()` answers "is gh installed / signed in / working" once per
 *     session, so a view can tell those three apart instead of guessing from a
 *     failed query.
 *  3. Results are cached and in-flight calls are shared. Four sections asking
 *     for the same repo's pull requests is one `gh` process, and a view that
 *     remounts does not re-spawn anything for a minute. This also makes the
 *     queries safe to fire from an effect that React may run twice.
 */
import { invoke } from "@tauri-apps/api/core";

/* ── failure ──────────────────────────────────────────────────── */

/**
 * A `gh` call that did not work, carrying enough to explain itself.
 *
 * `message` is gh's own stderr so the generic `errorText()` path anywhere in
 * the app still shows something true. `command` is the argv we ran — safe to
 * print, since gh reads its credentials from its own config, never from us.
 */
export class GhError extends Error {
  readonly command: string;

  constructor(args: string[], detail: string) {
    const text = detail.trim() || "gh exited without saying why.";
    // Long GraphQL errors are one enormous line; the UI needs a paragraph, not
    // a scroll bar.
    super(text.length > 400 ? `${text.slice(0, 400)}…` : text);
    this.name = "GhError";
    this.command = `gh ${args.join(" ")}`;
  }
}

/** The command behind a failure, for UI that wants to show what it tried. */
export function ghCommand(e: unknown): string {
  return e instanceof GhError ? e.command : "";
}

function detailOf(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/* ── the call ─────────────────────────────────────────────────── */

/** Run `gh` and return stdout. Rejects with a `GhError` on any failure. */
export async function gh(args: string[]): Promise<string> {
  try {
    return await invoke<string>("run_gh", { args });
  } catch (e) {
    throw new GhError(args, detailOf(e));
  }
}

/**
 * Run `gh --json …` and parse it.
 *
 * This used to be `JSON.parse(out || "null")`, which turned an empty or
 * malformed response into `null` — and `null` is indistinguishable from "still
 * loading" to every caller here, so a section stayed on its skeleton forever.
 * An unreadable answer is a failure and now says so.
 */
export async function ghJson<T = unknown>(args: string[]): Promise<T> {
  const out = (await gh(args)).trim();
  if (!out) {
    throw new GhError(args, "gh succeeded but printed nothing where JSON was expected.");
  }
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GhError(args, `gh printed something that is not JSON: ${out.slice(0, 200)}`);
  }
}

/* ── cache and dedupe ─────────────────────────────────────────── */

/**
 * Long enough that switching views and coming back is free, short enough that
 * a pull request you just opened shows up without restarting the app.
 */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; p: Promise<unknown> }>();

/**
 * One `gh` process per distinct command per minute.
 *
 * Sharing the *promise* rather than the result is the point: two components
 * mounting in the same tick get one subprocess, not two that both finish. It is
 * also what makes these queries safe to call from an effect React runs twice —
 * the second call joins the first instead of racing it.
 *
 * Failures are evicted the moment they land. A cached error would mean a
 * network blip locks the section out for a minute, and "try again" would be a
 * lie.
 */
function shared<T>(args: string[], run: () => Promise<T>): Promise<T> {
  const key = args.join("\u001f");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p as Promise<T>;

  const p = run();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => {
    // Only drop our own entry: a retry may already have replaced it.
    if (cache.get(key)?.p === p) cache.delete(key);
  });
  return p;
}

/** Query helper: cached, deduped, typed. */
function query<T>(args: string[]): Promise<T> {
  return shared(args, () => ghJson<T>(args));
}

/**
 * Forget everything, including the capability probe.
 *
 * For an explicit "try again" after a failure that was not gh's fault — the
 * user has since signed in, or the network came back — where serving the
 * minute-old answer would be exactly wrong.
 */
export function ghRefresh(): void {
  cache.clear();
  probe = null;
}

/* ── capability ───────────────────────────────────────────────── */

/**
 * Three states, because they need three different sentences. "gh is not
 * installed" is a choice the user has not made yet; "gh is signed out" is a
 * one-command fix; "gh works but this query failed" is our problem or
 * GitHub's, and the section is the only place that can say which query.
 */
export type GhCapability =
  | { state: "missing"; detail: string }
  | { state: "signed-out"; detail: string }
  | { state: "ready"; version: string; login: string };

let probe: Promise<GhCapability> | null = null;

/** Probe `gh` once per session. Repeat callers share the first answer. */
export function ghCapability(): Promise<GhCapability> {
  return (probe ??= runProbe());
}

async function runProbe(): Promise<GhCapability> {
  let version = "";
  try {
    // `gh --version` prints "gh version 2.92.0 (2026-04-28)" and touches no
    // network, so this separates "no binary" from "no answer from GitHub".
    // Only the number is kept: it lands in a card meta that does not wrap.
    const out = await gh(["--version"]);
    version = /gh version (\S+)/.exec(out)?.[1] ?? out.trim().split("\n")[0] ?? "";
  } catch (e) {
    return { state: "missing", detail: detailOf(e) };
  }

  try {
    // Signed in, this exits 0 on stdout; signed out it exits 1 and the reason
    // is on stderr, which `run_gh` hands back as the rejection.
    const status = await gh(["auth", "status"]);
    const login = /account (\S+)/.exec(status)?.[1] ?? "";
    return { state: "ready", version, login };
  } catch (e) {
    return { state: "signed-out", detail: detailOf(e) };
  }
}

/* ── repositories ─────────────────────────────────────────────── */

export interface RepoInfo {
  name: string;
  nameWithOwner: string;
  description: string | null;
  updatedAt: string;
  isPrivate: boolean;
  primaryLanguage: { name: string } | null;
}

export function listMyRepos(limit = 30): Promise<RepoInfo[]> {
  return query<RepoInfo[]>([
    "repo", "list", "--limit", String(limit),
    "--json", "name,nameWithOwner,description,updatedAt,isPrivate,primaryLanguage",
  ]);
}

/**
 * Just the `owner/name` strings, for pickers.
 *
 * Built on `listMyRepos` rather than its own narrower `--json` so that when the
 * limits happen to match, the picker and the dashboard share one process
 * instead of asking GitHub the same question twice with different columns.
 */
export async function repoNames(limit = 100): Promise<string[]> {
  const repos = await listMyRepos(limit);
  return repos.map((r) => r.nameWithOwner);
}

/* ── pull requests ────────────────────────────────────────────── */

export interface SearchPR {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  repository: { nameWithOwner: string };
}

const SEARCH_FIELDS = "number,title,url,updatedAt,isDraft,repository";

export function myOpenPRs(): Promise<SearchPR[]> {
  return query<SearchPR[]>([
    "search", "prs", "--author=@me", "--state=open", "--limit", "20",
    "--json", SEARCH_FIELDS,
  ]);
}

export function reviewRequests(): Promise<SearchPR[]> {
  return query<SearchPR[]>([
    "search", "prs", "--review-requested=@me", "--state=open", "--limit", "20",
    "--json", SEARCH_FIELDS,
  ]);
}

export interface RepoPR {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName: string;
  author: { login: string };
}

export function repoPRs(repo: string): Promise<RepoPR[]> {
  return query<RepoPR[]>([
    "pr", "list", "--repo", repo, "--limit", "20",
    "--json", "number,title,url,updatedAt,isDraft,headRefName,author",
  ]);
}

/* ── issues ───────────────────────────────────────────────────── */

export interface RepoIssue {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  author: { login: string };
}

export function repoIssues(repo: string): Promise<RepoIssue[]> {
  return query<RepoIssue[]>([
    "issue", "list", "--repo", repo, "--limit", "20",
    "--json", "number,title,url,updatedAt,author",
  ]);
}

/* ── time ─────────────────────────────────────────────────────── */

export function timeAgo(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
