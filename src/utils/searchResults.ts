import type { SearchMatch } from "../types/types";

type IndexedMatch = { match: SearchMatch; index: number };
export type SearchFile = {
  kind: "file";
  path: string;
  name: string;
  count: number;
  matches: IndexedMatch[];
};
export type SearchFolder = {
  kind: "folder";
  path: string;
  name: string;
  count: number;
  children: SearchNode[];
};
export type SearchNode = SearchFile | SearchFolder;
export type ResultRow = (SearchNode | ({ kind: "match" } & IndexedMatch)) & { depth: number };

const slashes = (path: string) =>
  path
    .replace(/^\\\\\?\\UNC\\/i, "//")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/");

function searchPathPrefix(path: string, base: string, ignoreCase: boolean) {
  const inRoot =
    base &&
    (ignoreCase ? path.toLowerCase().startsWith(base.toLowerCase()) : path.startsWith(base));
  let prefix;
  if (inRoot) {
    prefix = base;
  } else if (path.startsWith("//")) {
    prefix = "//";
  } else if (path.startsWith("/")) {
    prefix = "/";
  } else {
    prefix = "";
  }
  return prefix;
}

function addSearchFiles(
  files: SearchFile[],
  base: string,
  ignoreCase: boolean,
  tree: SearchNode[],
  folders: Map<string, SearchFolder>,
) {
  for (const file of files) {
    const path = slashes(file.path);
    const prefix = searchPathPrefix(path, base, ignoreCase);
    const relative = path.slice(prefix.length);
    const segments = relative.split("/").slice(0, -1);
    let children = tree;
    let parent = prefix;
    for (const name of segments) {
      parent += (parent && !parent.endsWith("/") ? "/" : "") + name;
      const key = ignoreCase ? parent.toLowerCase() : parent;
      let folder = folders.get(key);
      if (!folder) {
        folder = { kind: "folder", path: parent, name: name || "/", count: 0, children: [] };
        folders.set(key, folder);
        children.push(folder);
      }
      folder.count += file.count;
      children = folder.children;
    }
    children.push(file);
  }
}

function sort(nodes: SearchNode[]) {
  nodes.sort((a, b) => {
    if (a.kind === b.kind) {
      return a.name.localeCompare(b.name);
    } else if (a.kind === "folder") {
      return -1;
    } else {
      return 1;
    }
  });
  for (const node of nodes) {
    if (node.kind === "folder") {
      sort(node.children);
    }
  }
}

export function buildSearchResults(results: SearchMatch[], root: string | null) {
  const byFile = new Map<string, SearchFile>();
  results.forEach((match, index) => {
    let file = byFile.get(match.path);
    if (!file) {
      file = {
        kind: "file",
        path: match.path,
        name: slashes(match.path).split("/").pop()!,
        count: 0,
        matches: [],
      };
      byFile.set(match.path, file);
    }
    file.count++;
    file.matches.push({ match, index });
  });
  const files = [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path));
  const tree: SearchNode[] = [];
  const folders = new Map<string, SearchFolder>();
  const base = root ? slashes(root).replace(/\/$/, "") + "/" : "";
  const ignoreCase = /^[a-z]:\//i.test(base) || base.startsWith("//");
  addSearchFiles(files, base, ignoreCase, tree, folders);
  sort(tree);
  return {
    files,
    tree,
    paths: [
      ...files.map((file) => file.path),
      ...[...folders.values()].map((folder) => folder.path),
    ],
  };
}

export function searchResultRows(
  nodes: SearchNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const node of nodes) {
    rows.push({ ...node, depth });
    if (collapsed.has(node.path)) {
      continue;
    }
    if (node.kind === "folder") {
      rows.push(...searchResultRows(node.children, collapsed, depth + 1));
    } else {
      for (const match of node.matches) {
        rows.push({ kind: "match", ...match, depth: depth + 1 });
      }
    }
  }
  return rows;
}

export function searchRowMatches(row: SearchNode | ResultRow): SearchMatch[] {
  if (row.kind === "match") {
    return [row.match];
  }
  if (row.kind === "file") {
    return row.matches.map((entry) => entry.match);
  }
  return row.children.flatMap(searchRowMatches);
}
