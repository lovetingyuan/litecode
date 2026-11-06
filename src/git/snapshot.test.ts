import { describe, expect, it } from "vitest";
import type { GitChange, GitSnapshot } from "../types/types";
import { reconcileGitSnapshot } from "./snapshot";

function snapshot(): GitSnapshot {
  return {
    root: "C:/project",
    session: 1,
    branch: "main",
    tracking: { upstream: "origin/main", ahead: 1, behind: 0 },
    git: [
      { path: "a.txt", status: "modified" },
      { path: "b.txt", status: "untracked" },
    ],
    warnings: [],
    repositories: [
      {
        path: "C:/project",
        name: "project",
        branch: "main",
        detached: false,
        operation: null,
        changes: [
          {
            path: "a.txt",
            oldPath: null,
            indexPath: null,
            indexOldPath: null,
            worktreeOldPath: null,
            indexStatus: null,
            worktreeStatus: "modified",
            conflicted: false,
            stamp: "1",
          },
        ],
      },
      {
        path: "C:/project/nested",
        name: "nested",
        branch: "main",
        detached: false,
        operation: null,
        changes: [],
      },
    ],
  };
}

describe("Git snapshot reconciliation", () => {
  it("retains an identical snapshot even if decoration order changes", () => {
    const previous = snapshot();
    const next = snapshot();
    next.git.reverse();
    expect(reconcileGitSnapshot(previous, next)).toBe(previous);
  });

  it.each([
    { path: "renamed.txt" },
    { oldPath: "old.txt" },
    { indexPath: "staged.txt" },
    { indexOldPath: "staged-old.txt" },
    { worktreeOldPath: "worktree-old.txt" },
    { indexStatus: "added" },
    { worktreeStatus: "deleted" },
    { conflicted: true },
    { stamp: "2" },
  ] satisfies Partial<GitChange>[])("publishes change details: %j", (patch) => {
    const previous = snapshot();
    const next = snapshot();
    const changed = next.repositories![0].changes[0];
    Object.assign(changed, patch);
    const result = reconcileGitSnapshot(previous, next);
    expect(result).not.toBe(previous);
    expect(result.repositories![0].changes[0]).toBe(changed);
    expect(result.repositories![1]).toBe(previous.repositories![1]);
    expect(result.git).toBe(previous.git);
  });

  it("updates repository metadata while preserving unchanged change arrays", () => {
    const previous = snapshot();
    const next = snapshot();
    next.repositories![0].branch = "feature";
    next.repositories![0].detached = true;
    next.repositories![0].operation = "rebase";
    const result = reconcileGitSnapshot(previous, next);
    expect(result.repositories![0]).toMatchObject(next.repositories![0]);
    expect(result.repositories![0].changes).toBe(previous.repositories![0].changes);
    expect(result.repositories![1]).toBe(previous.repositories![1]);
  });

  it("publishes tracking, decoration and repository removal changes", () => {
    const previous = snapshot();
    const next = snapshot();
    next.tracking!.behind = 2;
    next.git[0].status = "deleted";
    next.repositories!.pop();
    const result = reconcileGitSnapshot(previous, next);
    expect(result.tracking).toEqual(next.tracking);
    expect(result.git).toEqual(next.git);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories![0]).toBe(previous.repositories![0]);
  });

  it("does not mistake overlapping repository decorations for an unchanged set", () => {
    const previous = snapshot();
    const next = snapshot();
    next.git[1] = { ...next.git[0] };
    expect(reconcileGitSnapshot(previous, next).git).toEqual(next.git);
  });

  it.each([{ session: 2 }, { root: "C:/other" }])(
    "does not reuse data across workspace contexts: %j",
    (patch) => {
      const previous = snapshot();
      const next = { ...snapshot(), ...patch };
      expect(reconcileGitSnapshot(previous, next)).toBe(next);
    },
  );
});
