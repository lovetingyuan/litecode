export type FileMove = { from: string; to: string };
export type MoveReport = { moved: FileMove[]; failed: { path: string; message: string }[] };

// Canonical tree paths use forward slashes and a trailing slash for directories.
export function treeMovePlan(
  paths: readonly string[],
  directory: string | null,
): FileMove[] | null {
  const unique = [...new Set(paths)];
  const selected = new Set(unique);
  const sources = unique.filter((path) => {
    for (
      let slash = path.indexOf("/");
      slash >= 0 && slash < path.length - 1;
      slash = path.indexOf("/", slash + 1)
    ) {
      if (selected.has(path.slice(0, slash + 1))) {
        return false;
      }
    }
    return true;
  });
  const parent = directory ? directory.replace(/\/?$/, "/") : "";
  if (sources.some((path) => path.endsWith("/") && parent.startsWith(path))) {
    return null;
  }
  return sources.flatMap((from) => {
    const name = from.replace(/\/$/, "").split("/").pop()!;
    const to = parent + name + (from.endsWith("/") ? "/" : "");
    return from === to ? [] : [{ from, to }];
  });
}
