import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The situation this exists for, in full.
 *
 * `cli_args` carries two different kinds of thing: tokens for the harness's
 * command line, and `key=value` settings for options whose `kind` is "json",
 * which are Spaces' own and mean nothing to a CLI. Every adapter tokenized the
 * whole string into argv, so the second kind was handed to the program.
 *
 * Adding one boolean — "Can use the browser and the screen" — therefore broke
 * every Codex turn on this machine. `reach=false` landed in the `[PROMPT]`
 * position of `codex exec`, which pushed the trailing `-` into a second
 * positional, and codex refused the whole invocation:
 *
 *     error: unexpected argument '-' found
 *
 * Confirmed against codex-cli 0.155.0. With the token, exactly that error;
 * without it, the arguments parse and it goes looking for the prompt on stdin.
 * Asserted against the source rather than by importing, because capabilities.ts
 * reaches Tauri through ./config — the same reason coordination.test.ts reads
 * its subject as text.
 */
const capabilities = () => readFile(new URL("../src/capabilities.ts", import.meta.url), "utf8");
const agents = () => readFile(new URL("../src/agents.ts", import.meta.url), "utf8");

test("there is one place that turns cli_args into argv, and it filters", async () => {
  const src = await capabilities();

  assert.match(src, /export function cliTokens\(kind: string, cliArgs: string\): string\[\]/);
  const fn = src.slice(src.indexOf("export function cliTokens"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));

  // Only the harness's own settings are dropped — selected by `kind`, so a new
  // one is filtered the day it is added rather than the day it breaks a run.
  assert.match(body, /optionsFor\(kind\)/);
  assert.match(body, /opt\.kind === "json"/);
  assert.match(body, /ours\.has\(token\.slice\(0, eq\)\)/);
  // A token with no '=' is an ordinary argument, and '=' at 0 is not a key.
  assert.match(body, /eq <= 0/);
  // A harness with no settings of its own is left exactly as it was.
  assert.match(body, /if \(!ours\.size\) return tokenize\(cliArgs\)/);
});

test("what is written as a setting is what is taken back out", async () => {
  const src = await capabilities();

  // serializeArgs writes json options as `key=value`; cliTokens strips exactly
  // that shape. If the two ever disagree, settings quietly reach argv again.
  const ser = src.slice(src.indexOf("export function serializeArgs"));
  assert.match(ser.slice(0, ser.indexOf("\n}\n")), /opt\.kind === "json"\) parts\.push\(`\$\{opt\.key\}=/);
});

test("no adapter tokenizes cli_args straight into argv", async () => {
  const src = await agents();

  assert.doesNotMatch(src, /tokenize\(agent\.cli_args/);
  assert.doesNotMatch(src, /tokenize\(resumeArgs\(/);
  // Claude, Codex (fresh and resumed) and Cursor all build argv from cli_args.
  assert.equal(
    (src.match(/cliTokens\(agent\.kind/g) ?? []).length,
    4,
    "an adapter is building argv without the filter"
  );
});

/*
 * The trailing `-` is how codex is told the prompt arrives on stdin, and it is
 * only ever valid as the sole positional. Anything that occupies [PROMPT]
 * ahead of it turns it into a second one and fails the run.
 */
test("codex still asks for the prompt on stdin, with nothing ahead of it", async () => {
  const src = await agents();
  const adapter = src.slice(src.indexOf("const codexAdapter"));
  const build = adapter.slice(0, adapter.indexOf("extractSessionId"));

  assert.match(build, /cliTokens\(agent\.kind, agent\.cli_args \?\? ""\), "-"\]/);
  assert.match(build, /cliTokens\(agent\.kind, resumeArgs\("codex", agent\.cli_args \?\? ""\)\), "-"\]/);
});
