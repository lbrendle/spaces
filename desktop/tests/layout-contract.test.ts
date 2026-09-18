import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("channel composer keeps text and helper copy on the message column", async () => {
  const [view, appCss, chatCss] = await Promise.all([
    readFile(new URL("../src/components/ChatView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/App.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/chat.css", import.meta.url), "utf8"),
  ]);

  assert.match(view, /className="composer"[\s\S]*?className="composer-main"[\s\S]*?<textarea[\s\S]*?className="composer-emoji"/);
  assert.match(appCss, /\.composer textarea\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 0;/);
  assert.match(chatCss, /\.composer-emoji\s*\{[^}]*margin-bottom: 0;/);
  assert.match(chatCss, /\.composer-foot\s*\{[^}]*border-top: 1px solid var\(--border-soft\);/);
  assert.match(chatCss, /\.composer-foot\s*\{[^}]*justify-content: flex-start;/);
  assert.doesNotMatch(chatCss, /\.composer-keys\s*\{[^}]*margin-left: auto;/);
  assert.ok(view.indexOf('className="composer-foot"') > view.indexOf('className="composer-main"'));
});

test("shared surfaces do not create hidden horizontal overflow", async () => {
  const [appCss, boardCss, operationsCss] = await Promise.all([
    readFile(new URL("../src/App.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/board.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/operations.css", import.meta.url), "utf8"),
  ]);

  const heading = appCss.match(/\.dash-card h3\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(heading, /margin-inline:\s*calc/);
  assert.match(boardCss, /@media \(max-width: 1320px\)[\s\S]*?min-width: 214px/);
  assert.match(operationsCss, /@media \(max-width: 1240px\)[\s\S]*?repeat\(5, minmax\(150px, 1fr\)\)/);
});

test("task cards begin below the sticky board heading", async () => {
  const boardCss = await readFile(
    new URL("../src/components/board.css", import.meta.url),
    "utf8",
  );

  const cardsRule = boardCss.match(/\.kanban-col \.kanban-cards\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(cardsRule, /margin: 0 calc\(var\(--space-1\) \* -1\) calc\(var\(--space-1\) \* -1\);/);
  assert.match(cardsRule, /padding: var\(--space-3\) var\(--space-1\) var\(--space-1\);/);
  assert.doesNotMatch(cardsRule, /margin: calc\(var\(--space-1\) \* -1\);/);
});

test("coding dock geometry stays aligned across terminal and run output", async () => {
  const [commandCss, terminalCss, processCss] = await Promise.all([
    readFile(new URL("../src/components/commandcenter.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/terminal.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/processes.css", import.meta.url), "utf8"),
  ]);

  assert.match(commandCss, /\.cc-rail button > span:not\(\.cc-rail-label\)\s*\{[^}]*top: calc\(50% - 14px\);/);
  assert.match(terminalCss, /\.tm-root-embedded \.tm-screen\s*\{[^}]*--tm-fs: 12\.5px;[^}]*font-size: var\(--tm-fs\);/);
  assert.match(processCss, /\.proc-output\s*\{[^}]*padding: 12px;[^}]*font: 11px\/1\.6 var\(--mono\);/);
});

/*
 * A modal taller than its cap has to scroll its body, not grow.
 *
 * `.modal` is a flex column with `max-height: 86vh`, but a flex item defaults
 * to `min-height: auto` and refuses to shrink below its content — so the body
 * ignored its own `overflow-y: auto`, the modal outgrew the backdrop centring
 * it, and half the overflow went off the top of the screen. The New project
 * dialog did this the moment the repository list arrived: the title and the
 * close button left the screen and there was no way to scroll them back.
 */
test("a modal scrolls its body and never loses its own header", async () => {
  const appCss = await readFile(new URL("../src/App.css", import.meta.url), "utf8");

  const modal = appCss.match(/\n\.modal\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(modal, /max-height: 86vh/);
  assert.match(modal, /flex-direction: column/);

  const body = appCss.match(/\.modal-body\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(body, /overflow-y: auto/);
  assert.match(body, /min-height: 0/, "without this the max-height does nothing");
  assert.match(body, /flex: 1 1 auto/);

  // The way out of the dialog must not be the first thing that scrolls away.
  const head = appCss.match(/\.modal-head\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(head, /flex: 0 0 auto/);
});

/*
 * A dialog must not depend on which button opened it.
 *
 * `Modal` rendered inline wherever it was used, and most callers are in the
 * rail — `overflow: hidden`, with a stacking context of its own. The New
 * project dialog came up with the dashboard's sticky section heading painted
 * straight through its title bar. Every other overlay in the app already
 * escapes to the body; modals are the one that did not.
 */
test("modals escape whatever opened them", async () => {
  const ui = await readFile(new URL("../src/components/ui.tsx", import.meta.url), "utf8");

  const modal = ui.slice(ui.indexOf("export function Modal("));
  const body = modal.slice(0, modal.indexOf("\nexport function Avatar("));
  assert.match(body, /createPortal\(/);
  assert.match(body, /document\.body/);
  assert.match(body, /className="modal-backdrop"/);
});
