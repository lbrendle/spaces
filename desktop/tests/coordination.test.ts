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
  assert.ok(registry.length >= 4, `expected the full registry, found ${registry.join(", ")}`);

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
    assert.match(portal, new RegExp(`"${kind}"`), `portal AGENT_BACKENDS is missing "${kind}"`);
  }

  // check_tools answers PATH questions for the chat composer. It is keyed by
  // executable, so compare against the probe bins rather than the kinds.
  const bins = [...capabilities.matchAll(/bin: "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(bins.length >= 3, `expected probe bins, found ${bins.join(", ")}`);
  for (const bin of bins) {
    assert.match(rust, new RegExp(`"${bin}"`), `HARNESS_BINS in lib.rs is missing "${bin}"`);
  }
});

test("an oversized brief spilled to disk never reaches the repository", async () => {
  const agents = await readFile(new URL("../src/agents.ts", import.meta.url), "utf8");

  // .hq/ is deliberately committed — it is the durable project brief — and a
  // turn ends with `git add -A`. A prompt carries channel history, so without
  // this ignore every oversized brief would land in someone's pull request.
  const spill = agents.slice(agents.indexOf("async function promptArg"));
  assert.match(spill, /\.hq\/prompts\/\.gitignore/);
  const ignoreAt = spill.indexOf(".hq/prompts/.gitignore");
  const promptAt = spill.indexOf("relativePath: relative");
  assert.ok(
    ignoreAt !== -1 && promptAt !== -1 && ignoreAt < promptAt,
    "the ignore has to be written before the brief, or a crash in between leaves the brief exposed"
  );

  // And the recorded command must not become the prompt.
  assert.match(agents, /const launchArgs =/);
  assert.match(agents, /\[\.\.\.adapterArgs, "<prompt>"\]/);
});

test("a hand-off with no baseline claims no commits", async () => {
  const external = await readFile(new URL("../src/external.ts", import.meta.url), "utf8");

  const settle = external.slice(external.indexOf("export async function settleHandOff"));
  // Without a "since" git log returns the last N commits on the branch, which
  // predate the brief. Reporting those as the agent's work is worse than
  // reporting nothing.
  assert.match(settle, /if \(!baseline\.sha\)/);
  assert.match(settle, /return \{ commits: \[\], newlyDirty/);
});

test("a blocked branch is not called clean-on-its-own without testing that", async () => {
  const coordination = await readFile(new URL("../src/coordination.ts", import.meta.url), "utf8");

  // Caught live: a branch that conflicts with the base *itself* was reported as
  // "lands fine on its own, but conflicts once N earlier branches are in",
  // purely because it happened to be tested after something else landed. The
  // two states call for different work, so the base has to be tested too.
  const plan = coordination.slice(coordination.indexOf("export async function integrationPlan"));
  assert.match(plan, /const alone =/);
  assert.match(plan, /mergeCheck\(project, lane\.branch, map\.base\)/);
  assert.match(plan, /!alone\.clean/);
  assert.match(plan, /Conflicts with \$\{map\.base\} itself/);

  // And the optimistic wording must be behind that check, never the default.
  const optimistic = plan.indexOf("Lands fine on its own");
  const tested = plan.indexOf("!alone.clean");
  assert.ok(tested !== -1 && tested < optimistic, "the base check must gate the optimistic note");
});

test("every harness option can be written and read back", async () => {
  const capabilities = await readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8");

  // Caught live: the External app options were declared `kind: "flag"` with no
  // flag token, so serializeArgs wrote bare values — `com.meta.endo .hq/inbox`
  // — that parseArgs has nothing to key on. Every setting was silently lost the
  // next time the agent loaded. A flag option needs a flag; anything else has
  // to go through the key=value form.
  const manifestStart = capabilities.indexOf("/* ── Manifest ─");
  const manifestEnd = capabilities.indexOf("export const HARNESSES");
  const body = capabilities.slice(manifestStart, manifestEnd);

  // Split into individual option object literals.
  const options = body.split(/\n  \{\n/).slice(1);
  assert.ok(options.length > 20, `expected the option manifests, found ${options.length}`);

  for (const opt of options) {
    const key = /key: "([a-z_]+)"/.exec(opt)?.[1];
    if (!key) continue;
    const isFlag = /kind: "flag"/.test(opt);
    const hasFlagToken = /\n    flag: "/.test(opt);
    const storedInModel = /storage: "model"/.test(opt);
    // The model column is keyed by position, not by name, so it needs no token.
    if (isFlag && !hasFlagToken && !storedInModel) {
      assert.fail(
        `option "${key}" is kind:"flag" with no flag token — it will serialize as a bare value and never parse back. Use kind:"json" for a setting that is not a CLI flag.`
      );
    }
  }
});

test("only harnesses Spaces has verified are offered", async () => {
  const [capabilities, integrations, agents] = await Promise.all([
    readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/integrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/agents.ts", import.meta.url), "utf8"),
  ]);

  // The generic escape hatch is gone: no kind may run an executable taken from
  // the agent row, because nothing validates that value.
  for (const gone of ["custom", "gemini", "aider", "opencode", "ritz"]) {
    assert.doesNotMatch(
      capabilities.slice(capabilities.indexOf("export const HARNESSES")),
      new RegExp(`kind: "${gone}"`),
      `"${gone}" should no longer be a harness`
    );
  }
  assert.doesNotMatch(agents, /program: agent\.model/);

  // An unrecognised kind must become a teammate Spaces does not launch, never
  // a command. That is the whole safety property of dropping the escape hatch.
  assert.match(capabilities, /return MANIFEST\[kind\] \? kind : "external"/);
  assert.match(agents, /ADAPTERS\[agent\.kind\] \?\? externalAdapter/);

  // Every integration has to name a harness that actually exists.
  const kinds = [...capabilities.matchAll(/^\s{4}kind: "([a-z]+)",$/gm)].map((m) => m[1]);
  const used = [...integrations.matchAll(/\n    kind: "([a-z]+)",/g)].map((m) => m[1]);
  assert.ok(used.length >= 4, `expected integrations, found ${used.length}`);
  for (const kind of used) {
    assert.ok(kinds.includes(kind), `integration points at unknown harness "${kind}"`);
  }
});

test("an agent Spaces cannot launch is still actually sent to", async () => {
  const [external, agents, rust, capabilities] = await Promise.all([
    readFile(new URL("../src/external.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/agents.ts", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8"),
  ]);

  // Muse has no CLI, no scripting dictionary, no local port and no usable URL
  // route. Driving the window is the only interface it has — and a brief
  // nobody opens is not a teammate, so the hand-off has to deliver, not just
  // write a file.
  assert.match(external, /export async function deliverToApp/);
  assert.match(agents, /await deliverToApp\(/);
  assert.match(rust, /async fn send_to_app/);

  // The composer gets the ask, not the whole brief: tens of kilobytes pasted
  // into a chat box is not what anyone hands a colleague.
  assert.match(external, /export function composerMessage/);
  assert.match(external, /Full context: \$\{opts\.briefPath\}/);

  // The file is written either way — it is the durable record and the fallback
  // when delivery fails, so a failed send must not fail the hand-off.
  const handoff = agents.slice(agents.indexOf("async function runHandOff"));
  assert.match(handoff, /result\.error\n\s*\? \{ delivered: false/);
  assert.match(handoff, /delivery\.problem/);

  // Focus is stolen because macOS only delivers input to the frontmost app,
  // but it has to be given back.
  assert.match(rust, /previous_app/);
  assert.match(rust, /fn frontmost_pid/);

  /*
   * The one that cost an afternoon: none of this may go through a child
   * process. macOS attributes an Accessibility check to whoever makes the
   * call, so `osascript` gets refused with -25211 however thoroughly Spaces
   * itself has been granted the permission — and the error names osascript,
   * which points at nothing the user can fix.
   *
   * Scoped to this module: the Calendar commands elsewhere in lib.rs use
   * osascript legitimately, under a different TCC service.
   */
  const driving = rust.slice(
    rust.indexOf("/* ── Driving an app Spaces cannot launch ─"),
    rust.indexOf("/// Which agent/GitHub CLIs are available on this machine.")
  );
  assert.ok(driving.length > 500, "could not isolate the app-driving module");
  assert.doesNotMatch(driving, /Command::new\("\/usr\/bin\/osascript"\)/);
  assert.doesNotMatch(driving, /tell application "System Events"/);
  assert.match(driving, /AXUIElementCreateApplication/);
  assert.match(driving, /lsappinfo/);

  // And the permission is checked in-process, where the answer is about Spaces.
  assert.match(rust, /fn AXIsProcessTrusted/);
  assert.match(driving, /AXIsProcessTrusted\(\)/);
  // The recovery instructions are shown by the UI layer, so that is where the
  // sentence has to be — asserting it against the Rust passes for years and
  // proves nothing.
  assert.match(external, /Privacy & Security/);

  /*
   * A send has to be able to say whether it worked.
   *
   * The first version clicked a stored offset and returned `delivered: true`
   * unconditionally, which is indistinguishable from doing nothing: the panel
   * said it had worked while the message box stayed empty. Spaces now looks
   * for the composer in the app's own accessibility tree, and reads it back
   * afterwards — `verified` is the only field allowed to mean "it arrived".
   */
  assert.match(rust, /unsafe fn find_composer/);
  assert.match(driving, /ax_string\(&found\.element, "AXValue"\)/);
  assert.match(external, /verified: boolean/);
  assert.match(handoff, /delivery\.verified/);

  /*
   * Nothing about where the message box is may be stored.
   *
   * The first version kept the composer's offset from the window's bottom-left
   * corner in the agent's settings. Nobody can answer that without a
   * screenshot and some arithmetic; it is wrong again the moment the window
   * moves or a side panel opens; and being wrong looks exactly like the
   * permission being missing. Every one of those is a property of *storing*
   * the number, not of clicking — so the click stays and the setting does not.
   * It is measured from the window on every send.
   *
   * Muse is why the click stays: its composer is not in the accessibility tree
   * at all, activating the app does not focus it, and it swallows every
   * keystroke sent to an unfocused window in silence.
   */
  assert.doesNotMatch(rust, /composer_dx|composer_dy/);
  assert.doesNotMatch(external, /composerDx|composerDy/);
  assert.doesNotMatch(capabilities, /composer_dx|composer_dy/);
  assert.match(driving, /fn composer_guess\(wx: f64, wy: f64, ww: f64, wh: f64\)/);
  assert.match(driving, /"composer"/);
  assert.match(driving, /"shape"/);
  // And an app is activated, not merely raised: `AXFrontmost` moves a window
  // in front without making its app active, and an inactive app's composer
  // never takes the caret.
  assert.match(driving, /fn activate\(/);

  /*
   * A read-back may only say "no" when it read the real thing.
   *
   * Muse reports a focused element that is not its composer and never holds
   * the pasted text. Treating that as a negative reported every successful
   * send as a failure — and, worse, suppressed the return press that makes it
   * a send at all. A match from anywhere is proof; a mismatch is proof only
   * from the box itself, and otherwise the answer is "cannot tell".
   */
  assert.match(driving, /Some\(value\) if contains_trimmed\(&value, &text\) => Some\(true\),\n\s*_ => None,/);
  // The search that remains is bounded: it only buys a read-back, and an
  // Electron chat window will happily spend seconds saying it has nothing.
  assert.match(driving, /WALK_BUDGET/);

  /*
   * Never `AXWindows[0]`. An app that has been running a while has more than
   * one window and the order is arbitrary — Muse keeps a stale "Log in" window
   * on another Space, which is first in the list and entirely wrong.
   */
  assert.match(driving, /unsafe fn target_window/);
  assert.match(driving, /AXFocusedWindow/);
  assert.doesNotMatch(driving, /fn first_window_frame/);
});
