import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeTree } from "../lib/knowledge-tree.ts";

test("workspace members reconstruct the same folder hierarchy from shared paths", () => {
  const create = (ids: [string, string]) =>
    buildKnowledgeTree([
      {
        id: ids[0],
        sourceId: "collection-company",
        sourceLabel: "Company vault",
        path: "Operations/Runbooks/Deploy.md",
        title: "Deploy",
        value: "deploy",
      },
      {
        id: ids[1],
        sourceId: "collection-company",
        sourceLabel: "Company vault",
        path: "Operations/Principles.md",
        title: "Principles",
        value: "principles",
      },
    ]);

  const stripMemberIds = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, item) =>
        key === "id" && String(item).startsWith("note:") ? "note" : item,
      ),
    );

  assert.deepEqual(
    stripMemberIds(create(["member-a-row-1", "member-a-row-2"])),
    stripMemberIds(create(["member-b-row-9", "member-b-row-10"])),
  );
});

test("folders sort before notes and discard traversal path segments", () => {
  const tree = buildKnowledgeTree([
    {
      id: "one",
      sourceId: "workspace",
      sourceLabel: "Workspace knowledge",
      path: "..\\Research\\Agents.md",
      title: "Agents",
      value: 1,
    },
    {
      id: "two",
      sourceId: "workspace",
      sourceLabel: "Workspace knowledge",
      path: "Charter.md",
      title: "Charter",
      value: 2,
    },
  ]);
  const root = tree[0];
  assert.equal(root?.kind, "folder");
  assert.deepEqual(
    root?.kind === "folder"
      ? root.children.map((node) => [node.kind, node.name])
      : [],
    [
      ["folder", "Research"],
      ["note", "Charter"],
    ],
  );
});
