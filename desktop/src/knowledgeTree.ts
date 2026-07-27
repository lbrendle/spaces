export interface KnowledgeTreeEntry<T> {
  id: string;
  sourceId: string;
  sourceLabel: string;
  path: string;
  title: string;
  value: T;
}

export interface KnowledgeTreeNote<T> {
  kind: "note";
  id: string;
  name: string;
  path: string;
  value: T;
}

export interface KnowledgeTreeFolder<T> {
  kind: "folder";
  id: string;
  name: string;
  children: KnowledgeTreeNode<T>[];
}

export type KnowledgeTreeNode<T> = KnowledgeTreeFolder<T> | KnowledgeTreeNote<T>;

function cleanParts(value: string): string[] {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
}

function compareNodes<T>(left: KnowledgeTreeNode<T>, right: KnowledgeTreeNode<T>): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  }) || left.id.localeCompare(right.id);
}

/**
 * Build the same deterministic folder tree on every device from synced note
 * paths. Folder rows do not need their own local IDs: the full path is the ID,
 * so nested structure survives a different member receiving different mirror
 * row IDs for the same collection.
 */
export function buildKnowledgeTree<T>(
  entries: KnowledgeTreeEntry<T>[],
): KnowledgeTreeNode<T>[] {
  const roots = new Map<string, KnowledgeTreeFolder<T>>();
  const folders = new Map<string, KnowledgeTreeFolder<T>>();

  for (const entry of entries) {
    const sourceName = entry.sourceLabel.trim() || "Workspace";
    const sourceKey = `${entry.sourceId}:${sourceName}`;
    let root = roots.get(sourceKey);
    if (!root) {
      root = {
        kind: "folder",
        id: `source:${sourceKey}`,
        name: sourceName,
        children: [],
      };
      roots.set(sourceKey, root);
      folders.set(root.id, root);
    }

    const parts = cleanParts(entry.path);
    const fileName = parts.pop() || entry.title || "Untitled";
    let parent = root;
    let parentId = root.id;
    for (const part of parts) {
      const folderId = `${parentId}/${part.toLocaleLowerCase()}`;
      let folder = folders.get(folderId);
      if (!folder) {
        folder = { kind: "folder", id: folderId, name: part, children: [] };
        folders.set(folderId, folder);
        parent.children.push(folder);
      }
      parent = folder;
      parentId = folderId;
    }
    parent.children.push({
      kind: "note",
      id: `note:${entry.sourceId}:${entry.id}`,
      name: entry.title.trim() || fileName.replace(/\.[^.]+$/, "") || "Untitled",
      path: entry.path,
      value: entry.value,
    });
  }

  const sort = (nodes: KnowledgeTreeNode<T>[]) => {
    nodes.sort(compareNodes);
    for (const node of nodes) {
      if (node.kind === "folder") sort(node.children);
    }
  };
  const result = [...roots.values()];
  sort(result);
  return result;
}
