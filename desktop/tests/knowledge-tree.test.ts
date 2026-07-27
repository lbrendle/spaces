import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildKnowledgeTree } from "../src/knowledgeTree.ts";

test("synced paths produce the same Obsidian-style hierarchy across member-local ids", () => {
  const first = buildKnowledgeTree([
    {
      id: "local-a",
      sourceId: "shared-vault",
      sourceLabel: "Company vault",
      path: "Research/Agents/Orchestration.md",
      title: "Orchestration",
      value: "first",
    },
    {
      id: "local-b",
      sourceId: "shared-vault",
      sourceLabel: "Company vault",
      path: "Research/Protocols.md",
      title: "Protocols",
      value: "second",
    },
  ]);
  const second = buildKnowledgeTree([
    {
      id: "different-local-id",
      sourceId: "shared-vault",
      sourceLabel: "Company vault",
      path: "Research/Agents/Orchestration.md",
      title: "Orchestration",
      value: "first",
    },
    {
      id: "another-local-id",
      sourceId: "shared-vault",
      sourceLabel: "Company vault",
      path: "Research/Protocols.md",
      title: "Protocols",
      value: "second",
    },
  ]);

  const shape = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === "id" && String(item).startsWith("note:") ? "note" : item)));
  assert.deepEqual(shape(first), shape(second));
  assert.equal(first[0]?.kind, "folder");
  assert.equal(first[0]?.kind === "folder" ? first[0].children[0]?.kind : "", "folder");
});

test("folders sort before notes and Windows paths normalize without traversal folders", () => {
  const tree = buildKnowledgeTree([
    {
      id: "one",
      sourceId: "vault",
      sourceLabel: "Vault",
      path: "..\\Ideas\\Zeta.md",
      title: "Zeta",
      value: 1,
    },
    {
      id: "two",
      sourceId: "vault",
      sourceLabel: "Vault",
      path: "Alpha.md",
      title: "Alpha",
      value: 2,
    },
  ]);
  const root = tree[0];
  assert.equal(root?.kind, "folder");
  assert.deepEqual(
    root?.kind === "folder" ? root.children.map((node) => [node.kind, node.name]) : [],
    [
      ["folder", "Ideas"],
      ["note", "Alpha"],
    ],
  );
});

test("shared sync sends and rematerializes the preserved relative path", async () => {
  const [desktopSync, portalSync] = await Promise.all([
    readFile(new URL("../src/portalContent.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../portal/lib/shared-content.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(desktopSync, /path: file\.rel_path/);
  assert.match(desktopSync, /page\.path \|\| `\$\{page\.title\}\.md`/);
  assert.match(portalSync, /const path = text\(record\.path, 500\)/);
  assert.match(portalSync, /source_label = \?, path = \?/);
});
