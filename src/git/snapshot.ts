import type { GitChange, GitSnapshot } from "../types/types";

function sameItems<T>(left: readonly T[], right: readonly T[], equal: (a: T, b: T) => boolean) {
  return left.length === right.length && left.every((item, index) => equal(item, right[index]));
}

function sameChange(left: GitChange, right: GitChange) {
  return (
    left.path === right.path &&
    left.oldPath === right.oldPath &&
    left.indexPath === right.indexPath &&
    left.indexOldPath === right.indexOldPath &&
    left.worktreeOldPath === right.worktreeOldPath &&
    left.indexStatus === right.indexStatus &&
    left.worktreeStatus === right.worktreeStatus &&
    left.conflicted === right.conflicted &&
    left.stamp === right.stamp
  );
}

export function reconcileGitSnapshot(previous: GitSnapshot, next: GitSnapshot): GitSnapshot {
  if (previous.root !== next.root || previous.session !== next.session) {
    return next;
  }
  const byPath = new Map(previous.repositories?.map((repository) => [repository.path, repository]));
  let repositories = next.repositories?.map((repository) => {
    const old = byPath.get(repository.path);
    if (!old) {
      return repository;
    }
    const changes = sameItems(old.changes, repository.changes, sameChange)
      ? old.changes
      : repository.changes;
    return old.name === repository.name &&
      old.branch === repository.branch &&
      old.detached === repository.detached &&
      old.operation === repository.operation &&
      changes === old.changes
      ? old
      : { ...repository, changes };
  });
  if (
    previous.repositories &&
    repositories &&
    sameItems(previous.repositories, repositories, Object.is)
  ) {
    repositories = previous.repositories;
  }
  // Repository iteration order can change without changing file decorations.
  const oldStatuses = new Map(previous.git.map((entry) => [entry.path, entry.status]));
  const git =
    previous.git.length === next.git.length &&
    (sameItems(
      previous.git,
      next.git,
      (left, right) => left.path === right.path && left.status === right.status,
    ) ||
      next.git.every(
        (entry) => oldStatuses.get(entry.path) === entry.status && oldStatuses.delete(entry.path),
      ))
      ? previous.git
      : next.git;
  const tracking =
    previous.tracking?.upstream === next.tracking?.upstream &&
    previous.tracking?.ahead === next.tracking?.ahead &&
    previous.tracking?.behind === next.tracking?.behind
      ? previous.tracking
      : next.tracking;
  const warnings = sameItems(previous.warnings, next.warnings, Object.is)
    ? previous.warnings
    : next.warnings;
  return previous.branch === next.branch &&
    repositories === previous.repositories &&
    git === previous.git &&
    tracking === previous.tracking &&
    warnings === previous.warnings
    ? previous
    : { ...next, repositories, git, tracking, warnings };
}
