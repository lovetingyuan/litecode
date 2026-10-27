import { input } from "../components/dialog";
import { desktop } from "../core/bridge";
import { notify, useApp } from "../store/store";
import type { GitInfo, GitRepository } from "../types/types";
import { gitContext, readGitInfo, runGitOperation, selectedRepository } from "./git";

export type GitBranch = GitInfo["branches"][number];
type SwitchTarget =
  | { kind: "blocked"; reason: string }
  | { kind: "switch"; branch: string }
  | { kind: "choose"; branches: GitBranch[] }
  | { kind: "create"; name: string; start: string };

export const branchReference = (branch: GitBranch) =>
  `refs/${branch.remote ? "remotes" : "heads"}/${branch.name}`;

export function branchSwitchTarget(branch: GitBranch, branches: GitBranch[]): SwitchTarget {
  const matches = branch.remote
    ? branches.filter((local) => !local.remote && local.upstream === branch.name)
    : [branch];
  if (matches.some((local) => local.current)) {
    return { kind: "blocked", reason: "Already on this branch" };
  }
  const available = matches.filter((local) => !local.worktree);
  if (matches.length && !available.length) {
    return { kind: "blocked", reason: "Branch is in use by another worktree" };
  }
  if (available.length > 1) {
    return { kind: "choose", branches: available };
  }
  if (available.length === 1) {
    return { kind: "switch", branch: available[0].name };
  }
  return {
    kind: "create",
    name: branch.name.slice(branch.name.indexOf("/") + 1),
    start: branchReference(branch),
  };
}

export function branchDifference(info: GitInfo | null, repository: GitRepository): string {
  if (!info || repository.detached || info.detached || !info.upstream ||
      info.branch !== repository.branch || info.ahead === null || info.behind === null) {
    return "";
  }
  return `(↓${info.behind} behind · ↑${info.ahead} ahead)`;
}

// Dialogs and pickers may outlive their workspace or selected repository.
function branchContext(repository: string) {
  const context = gitContext(repository);
  return () => {
    const state = useApp.getState();
    const selected = selectedRepository();
    return state.root === context.expectedRoot && state.gitState.session === context.session &&
      selected?.path === repository && !selected.operation && !state.gitBusy[repository];
  };
}

export async function createBranch(repository: string, source?: GitBranch) {
  const valid = branchContext(repository);
  if (!valid()) {
    return;
  }
  const name = await input(source ? `New branch from ${source.name}` : "New branch name");
  if (!name || !valid()) {
    return;
  }
  const info = await readGitInfo(repository);
  if (!valid() || info.operation) {
    return;
  }
  if (source && !info.branches.some((b) => branchReference(b) === branchReference(source))) {
    notify("The source branch no longer exists. Refresh and try again.");
    return;
  }
  await runGitOperation(repository, {
    kind: "createBranch", name,
    ...(source ? { start: branchReference(source) } : {}),
  });
}

export async function switchBranch(
  repository: string,
  source: GitBranch,
  choose: (branches: GitBranch[]) => Promise<string | null>,
) {
  const valid = branchContext(repository);
  if (!valid()) {
    return;
  }
  let info = await readGitInfo(repository);
  if (!valid() || info.operation) {
    return;
  }
  const branch = info.branches.find((b) => branchReference(b) === branchReference(source));
  if (!branch) {
    notify("The branch no longer exists. Refresh and try again.");
    return;
  }
  const target = branchSwitchTarget(branch, info.branches);
  if (target.kind === "blocked") {
    return;
  }
  if (target.kind === "switch") {
    await runGitOperation(repository, { kind: "switch", branch: target.branch });
    return;
  }
  if (target.kind === "choose") {
    const name = await choose(target.branches);
    if (!name || !valid()) {
      return;
    }
    info = await readGitInfo(repository);
    if (!valid() || info.operation) {
      return;
    }
    const local = info.branches.find((b) => !b.remote && b.name === name && b.upstream === branch.name);
    if (!local || branchSwitchTarget(local, info.branches).kind !== "switch") {
      return;
    }
    await runGitOperation(repository, { kind: "switch", branch: name });
    return;
  }
  let name: string | null = target.name;
  if (info.branches.some((b) => !b.remote && b.name === name)) {
    name = await input(`Local branch ${name} already exists. New branch from ${branch.name}`);
    if (!name || !valid()) {
      return;
    }
    info = await readGitInfo(repository);
    if (!valid() || info.operation) {
      return;
    }
  }
  await runGitOperation(repository, { kind: "createBranch", name, start: target.start });
}

export async function copyBranchName(branch: GitBranch) {
  if (desktop) {
    await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(branch.name);
  } else {
    await navigator.clipboard.writeText(branch.name);
  }
  notify(`Copied branch name: ${branch.name}`);
}
