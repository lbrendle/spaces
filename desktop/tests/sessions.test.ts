import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { matchProject, nameOf, rootOf, shortPath } from "../src/sessionpaths.ts";

/*
 * Grouping is the whole import. A session records the directory it ran in, and
 * that directory is what decides which Spaces project it joins — so these are
 * not string-handling niceties, they are the difference between "240 sessions
 * in archii" and 240 projects with one session each.
 *
 * The paths below are real ones from this machine.
 */
test("sessions that ran in a worktree belong to the repository", () => {
  assert.equal(
    rootOf("/Users/lauren/archii/archii/.claude/worktrees/spaces-demo-video-82f8a9"),
    "/Users/lauren/archii/archii"
  );
  // Deeper inside a worktree is still the same repository.
  assert.equal(
    rootOf("/Users/lauren/archii/archii/.claude/worktrees/foo-1234/desktop/src"),
    "/Users/lauren/archii/archii"
  );
  // A directory that merely mentions worktrees is not one.
  assert.equal(
    rootOf("/Users/lauren/notes/claude-worktrees-explained"),
    "/Users/lauren/notes/claude-worktrees-explained"
  );
  // Trailing slashes are not a second project.
  assert.equal(rootOf("/Users/lauren/archii/archii/"), "/Users/lauren/archii/archii");
  assert.equal(rootOf("/"), "/");
  assert.equal(rootOf(""), "");

  assert.equal(nameOf("/Users/lauren/archii/archii/.claude/worktrees/x-1"), "archii");
  assert.equal(nameOf("/Users/lauren/lauren/ghostreader-ai"), "ghostreader-ai");
});

test("an abbreviated path is still the path", () => {
  // Short enough is left alone.
  assert.equal(shortPath("/Users/lauren/archii"), "/Users/lauren/archii");
  // The leading separator survives, which is the whole point: the CSS trick
  // this replaced rendered "/Users/lauren/rd/vault" as "Users/lauren/rd/vault/".
  const long = "/Users/lauren/Documents/Codex/2026-09-01/referenced-chatgpt-conversation";
  assert.ok(shortPath(long).startsWith("/Users/"));
  assert.ok(shortPath(long).endsWith("2026-09-01/referenced-chatgpt-conversation"));
  assert.ok(shortPath(long).length < long.length);
  // Nothing sensible to elide means nothing is elided.
  assert.equal(shortPath("/a/b"), "/a/b");
  assert.equal(shortPath(""), "");
});

test("a directory joins the innermost project that contains it", () => {
  const projects = [
    { id: "outer", local_path: "/Users/lauren/archii" },
    { id: "inner", local_path: "/Users/lauren/archii/archii" },
    { id: "sibling", local_path: "/Users/lauren/archii-beta" },
  ];

  // Exact beats containment.
  assert.equal(matchProject("/Users/lauren/archii/archii", projects)?.id, "inner");
  // A subdirectory is the project's, not a new project called "desktop".
  assert.equal(matchProject("/Users/lauren/archii/archii/desktop", projects)?.id, "inner");
  // The deepest container wins, not the first one listed.
  assert.equal(matchProject("/Users/lauren/archii/rd/vault", projects)?.id, "outer");
  // A worktree resolves to its repository first, then matches.
  assert.equal(
    matchProject("/Users/lauren/archii/archii/.claude/worktrees/x-1", projects)?.id,
    "inner"
  );

  /*
   * The one a prefix test gets wrong: "/Users/lauren/archii-beta" starts with
   * "/Users/lauren/archii", so a naive startsWith files every beta session
   * under the wrong project. Containment has to be tested on a separator.
   */
  assert.equal(matchProject("/Users/lauren/archii-beta", projects)?.id, "sibling");
  assert.equal(matchProject("/Users/lauren/archii-beta/src", projects)?.id, "sibling");

  // Nothing containing it, and projects with no local path, mean no match.
  assert.equal(matchProject("/Users/lauren/elsewhere", projects), undefined);
  assert.equal(matchProject("/Users/lauren/elsewhere", [{ id: "x", local_path: "" }]), undefined);
  assert.equal(matchProject("", projects), undefined);
});

/*
 * The rules that make an import safe to run, and safe to run twice. Each of
 * these is a property of the source rather than of a single function, so it is
 * asserted against the source: the alternative is discovering in six months
 * that somebody swapped a bounded replay for an unbounded one.
 */
test("importing reads other agents' history without owning it", async () => {
  const [sessions, rust, app] = await Promise.all([
    readFile(new URL("../src/sessions.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ]);

  // Read-only. The session files belong to Claude Code and Codex; Spaces has
  // no business writing to them, and a bug that did would be unrecoverable.
  assert.doesNotMatch(rust, /fn (scan_agent_sessions|read_agent_session)[\s\S]*?OpenOptions/);
  assert.doesNotMatch(sessions, /writeTextFile|removeFile/);

  // Re-running is a no-op, not a duplicate: an unchanged file is skipped
  // before it is even opened.
  assert.match(sessions, /ON CONFLICT\(source, session_id\) DO UPDATE/);
  assert.match(sessions, /prior\.bytes >= session\.bytes/);

  /*
   * A session is identified by its file, never by the id recorded inside it.
   *
   * Codex reuses its session id across every rollout a conversation resumes
   * into: 1,307 files on this machine carry 251 distinct ids, one of them
   * shared by 212 files. Keying on that discards four fifths of the Codex
   * history without a word, and makes a re-import delete the siblings of
   * whichever file it read last. The file stem is unique in both formats.
   */
  assert.match(rust, /let file_id = path\s*\n?\s*\.file_stem\(\)/);
  assert.match(rust, /id: file_id,\n\s*session_id: id,/);
  assert.match(sessions, /agent_session_id/);
  /*
   * The key a re-import deletes by lives in its own column.
   *
   * `meta` is rendered under every message, so an identity parked there showed
   * up in the channel as "imported:claude:6815ecec-…"; `run_id` is resolved
   * against the runs table, so a key there is a lookup that can only miss. And
   * the delete is an exact match, because a path can contain % or _, which
   * LIKE reads as wildcards.
   */
  assert.match(sessions, /DELETE FROM messages WHERE channel_id = \$1 AND import_key = \$2/);
  assert.doesNotMatch(sessions, /meta,[\s\S]{0,400}importTag\(session\),\n\s*"",\n\s*"",/);

  // Both caps exist and are applied. A directory here has 786 sessions; an
  // uncapped replay is a channel nobody can open and a memory entry that
  // crowds out every other one.
  assert.match(sessions, /const INDEX_LIMIT/);
  assert.match(sessions, /const REPLAY_LIMIT/);
  assert.match(sessions, /slice\(0, REPLAY_LIMIT\)/);
  assert.match(sessions, /slice\(0, INDEX_LIMIT\)/);

  // What agents read is an index with paths, not the transcripts themselves:
  // project memory is quoted into every run, so putting conversations there
  // would bury the project's actual notes.
  assert.match(sessions, /Earlier agent sessions/);

  // The watcher is local-only and must not be gated on portal pairing — a
  // machine that has never paired still has its own history to catch up on.
  assert.match(app, /initSessionWatch/);
  const gated = app.slice(app.indexOf("if (!portal) return;"), app.indexOf("initSessionWatch"));
  assert.doesNotMatch(gated, /initSessionWatch/);
});
