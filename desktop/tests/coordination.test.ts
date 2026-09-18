import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isObjectId, parseMergeTree, parsePorcelainPaths } from "../src/gitparse.ts";

/**
 * The fixtures below are verbatim output from git 2.54 — captured, not written
 * from memory. The conflicted one is the case that matters: its informational
 * block starts with "Auto-merging f.txt", which a parser that collects every
 * line after the tree OID reports as a conflicted path. Spaces uses this to
 * decide whether a branch will land, so a false conflict is not cosmetic.
 */
const CLEAN = "0eee85898883119f7f73d07549211b8e7e5eb547\n";

const CONFLICTED = [
  "799cf5b75c4fef9dae191cbd569c3887372d68ec",
  "f.txt",
  "",
  "Auto-merging f.txt",
  "CONFLICT (content): Merge conflict in f.txt",
  "",
].join("\n");

const CONFLICTED_MANY = [
  "799cf5b75c4fef9dae191cbd569c3887372d68ec",
  "src/a.ts",
  "src/b.ts",
  "",
  "Auto-merging src/a.ts",
  "CONFLICT (content): Merge conflict in src/a.ts",
  "Auto-merging src/b.ts",
  "CONFLICT (content): Merge conflict in src/b.ts",
  "",
].join("\n");

test("a clean merge-tree reports a tree and no conflicts", () => {
  const parsed = parseMergeTree(CLEAN);
  assert.equal(parsed.tree, "0eee85898883119f7f73d07549211b8e7e5eb547");
  assert.deepEqual(parsed.conflicts, []);
  assert.ok(isObjectId(parsed.tree));
});

test("a conflicted merge-tree reports only the conflicted paths", () => {
  const parsed = parseMergeTree(CONFLICTED);
  assert.equal(parsed.tree, "799cf5b75c4fef9dae191cbd569c3887372d68ec");
  // "Auto-merging f.txt" must not become a path.
  assert.deepEqual(parsed.conflicts, ["f.txt"]);

  const many = parseMergeTree(CONFLICTED_MANY);
  assert.deepEqual(many.conflicts, ["src/a.ts", "src/b.ts"]);
});

test("a broken merge-tree invocation yields no object id, so callers can tell", () => {
  const parsed = parseMergeTree("fatal: not something we can merge\n");
  assert.equal(isObjectId(parsed.tree), false);
  assert.equal(isObjectId(""), false);
});

test("porcelain status yields the post-rename path, unquoted", () => {
  const paths = parsePorcelainPaths(
    [
      " M src/agents.ts",
      "?? src/new.ts",
      "A  src/added.ts",
      'R  src/old.ts -> src/renamed.ts',
      'M  "src/od\\303\\251.ts"',
      "",
    ].join("\n")
  );
  assert.deepEqual(paths, [
    "src/agents.ts",
    "src/new.ts",
    "src/added.ts",
    "src/renamed.ts",
    "src/od\\303\\251.ts",
  ]);
});

test("the coordination layer predicts landings rather than attempting them", async () => {
  const coordination = await readFile(new URL("../src/coordination.ts", import.meta.url), "utf8");

  // In-memory merges only, up to the point where someone asks to land: the
  // prediction runs against a repository people are working in, so it must not
  // move a branch, stage anything or leave a merge half-finished. `land` is the
  // one function allowed to mutate, and it lives after this slice.
  const predicting = coordination.slice(
    coordination.indexOf("export async function mergeCheck"),
    coordination.indexOf("/* ── landing one ─")
  );
  assert.ok(predicting.length > 500, "could not isolate the prediction functions");
  assert.match(predicting, /merge-tree/);
  assert.match(predicting, /--write-tree/);
  for (const verb of ["merge", "checkout", "reset", "commit", "add", "rebase", "push"]) {
    assert.doesNotMatch(
      predicting,
      new RegExp(`git\\([^)]*"${verb}"`),
      `the landing prediction must not run \`git ${verb}\``
    );
  }

  // And landing must refuse rather than improvise when the tree is not ready.
  const landing = coordination.slice(coordination.indexOf("/* ── landing one ─"));
  assert.match(landing, /MERGE_HEAD/);
  assert.match(landing, /status", "--porcelain/);
  assert.match(landing, /head !== base/);
  assert.match(landing, /"merge", "--abort"/);

  // The landing order must be simulated forward, or it cannot see branches that
  // conflict with each other rather than with the base.
  assert.match(coordination, /commit-tree/);
  assert.match(coordination, /let against = map\.base/);

  // External agents are part of the map, not a special case bolted on after.
  assert.match(coordination, /isExternal\(agent\.kind\)/);
  assert.match(coordination, /kind: external \? "external" : "spawned"/);

  // Two agents editing the same path in the same tree outranks a future merge
  // conflict, because only one of them loses work with no git record.
  assert.match(coordination, /severity: liveInSharedTree \? "live" : "diverging"/);
});

test("external teammates are represented by evidence, never assumed", async () => {
  const external = await readFile(new URL("../src/external.ts", import.meta.url), "utf8");

  assert.match(external, /attribution: "git-author" \| "working-directory" \| "none"/);
  // With nothing configured, Spaces must not claim HEAD's commits are theirs.
  assert.match(external, /if \(attribution !== "none"\)/);
  assert.match(external, /baselineSha/);
  assert.match(external, /export async function settleHandOff/);
});

test("the doctor never upgrades an unknown sign-in state to ready", async () => {
  const doctor = await readFile(new URL("../src/doctor.ts", import.meta.url), "utf8");

  assert.match(doctor, /export type HealthState =/);
  assert.match(doctor, /"signed-out"/);
  assert.match(doctor, /"unknown"/);
  // Sign-in is only reported where a verified command exists for it.
  assert.match(doctor, /if \(probe\?\.authArgs\?\.length\)/);
  assert.match(doctor, /timedOut/);
});

test("the harness registry is the single source of truth for every layer", async () => {
  const [capabilities, rust, portal, adapters] = await Promise.all([
    readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../../portal/lib/workspace.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/agents.ts", import.meta.url), "utf8"),
  ]);

  // Every `kind:` in HARNESSES, in registry order. Scoped to that array —
  // HarnessOption also has a `kind`, and it holds "flag" or "json".
  const harnesses = capabilities.slice(
    capabilities.indexOf("export const HARNESSES"),
    capabilities.indexOf("const MANIFEST")
  );
  const registry = [...harnesses.matchAll(/^\s{4}kind: "([a-z]+)",$/gm)].map((m) => m[1]);
  assert.ok(registry.length >= 9, `expected the full registry, found ${registry.join(", ")}`);

  // Each one needs an adapter, or runAgent silently falls back to a bare CLI.
  const registered = [...adapters.matchAll(/^\s{2}([a-z]+): \w+Adapter,$/gm)].map((m) => m[1]);
  for (const kind of registry) {
    assert.ok(registered.includes(kind), `agents.ts has no adapter for "${kind}"`);
  }

  // Each one needs an option list, or norm() quietly downgrades it to custom.
  const manifest = capabilities.slice(capabilities.indexOf("const MANIFEST"));
  for (const kind of registry) {
    assert.match(manifest, new RegExp(`\\n  ${kind}: `), `MANIFEST has no options for "${kind}"`);
  }

  // The portal rewrites an unlisted backend to "codex" without complaining, so
  // a kind missing there comes back from a sync as a different agent.
  for (const kind of registry) {
    assert.match(portal, new RegExp(`"${kind}",`), `portal AGENT_BACKENDS is missing "${kind}"`);
  }

  // check_tools answers PATH questions for the chat composer. It is keyed by
  // executable, so compare against the probe bins rather than the kinds.
  const bins = [...capabilities.matchAll(/bin: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(bins.length >= 6, `expected probe bins, found ${bins.join(", ")}`);
  for (const bin of bins) {
    assert.match(rust, new RegExp(`"${bin}"`), `HARNESS_BINS in lib.rs is missing "${bin}"`);
  }
});
