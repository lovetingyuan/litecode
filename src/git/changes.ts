import type { GitChange } from "../types/types";

export type ChangeGroup = "conflicts" | "staged" | "changes" | "untracked";
export function groupChanges(changes: GitChange[]) {
  const groups: Record<ChangeGroup, GitChange[]> = {
    conflicts: [],
    staged: [],
    changes: [],
    untracked: [],
  };
  for (const change of changes) {
    if (change.conflicted) {
      groups.conflicts.push(change);
      continue;
    }
    if (change.indexStatus) {
      groups.staged.push({
        ...change,
        path: change.indexPath ?? change.path,
        oldPath: change.indexOldPath ?? change.oldPath,
      });
    }
    if (change.worktreeStatus === "untracked") {
      groups.untracked.push(change);
    } else if (change.worktreeStatus) {
      groups.changes.push({
        ...change,
        oldPath: change.worktreeOldPath ?? null,
      });
    }
  }
  for (const files of Object.values(groups)) {
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  return groups;
}
export function filesUnder(changes: GitChange[], path: string) {
  return path.endsWith("/")
    ? changes.filter((c) => c.path.startsWith(path))
    : changes.filter((c) => c.path === path);
}
export function visibleRange(
  count: number,
  scroll: number,
  height: number,
  rowHeight = 26,
) {
  const first = Math.max(0, Math.floor(scroll / rowHeight) - 8);
  return {
    first,
    end: Math.min(count, Math.ceil((scroll + height) / rowHeight) + 8),
  };
}
