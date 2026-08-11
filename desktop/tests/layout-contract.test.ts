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
