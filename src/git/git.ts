import { call, errorMessage } from "../core/bridge";
import { trustedCall } from "../core/workspaceTrust";
import { ask } from "../components/dialog";
import { useApp, setApp, notify } from "../store/store";
import {
  basename,
  join,
  normalize,
  openPath,
  patchDoc,
  refreshDocuments,
  save,
  showDocument,
} from "../editor/documents";
import { languageFor } from "../editor/monaco";
import { refreshGit } from "../explorer/workspaceGit";
import { workspaceDirectories } from "../explorer/workspaceTree";
import type {
  Doc,
  GitChange,
  GitDiffContent,
  GitDiffResource,
  GitInfo,
  GitOperation,
  GitRepository,
} from "../types/types";

export function selectedRepository(): GitRepository | undefined {
  const state = useApp.getState();
  const repositories = state.gitState.repositories ?? [];
  return (
    repositories.find((r) => r.path === state.gitRepository) ??
    repositories.find(
      (r) => state.root && normalize(state.root).startsWith(normalize(r.path)),
    ) ??
    repositories[0]
  );
}

export function gitContext(repository: string) {
  const state = useApp.getState();
  if (
    !state.root ||
    normalize(state.gitState.root ?? "") !== normalize(state.root) ||
    state.gitState.session === null
  ) {
    throw new Error("Repository is still loading. Refresh and try again.");
  }
  return {
    expectedRoot: state.root,
    session: state.gitState.session,
    repository,
  };
}

export const refreshGitPanel = () => refreshGit(workspaceDirectories(), true);
export const readGitInfo = (repository: string) =>
  call<GitInfo>("git_repository_info", gitContext(repository));
export const readGitDiff = (diff: GitDiffResource) => {
  if (normalize(useApp.getState().root ?? "") !== normalize(diff.workspace)) {
    throw new Error("This comparison belongs to another workspace");
  }
  return call<GitDiffContent>("git_read_diff", {
    ...gitContext(diff.repository),
    path: diff.path,
    oldPath: diff.oldPath,
    staged: diff.staged,
    conflicted: diff.conflicted,
  });
};

export async function openGitSource(repository: string, path: string) {
  const context = gitContext(repository);
  const source = await call<string>("git_open_source", { ...context, path });
  if (useApp.getState().root === context.expectedRoot) {
    return openPath(source, { pinned: true });
  }
}

export async function openGitDiff(
  repository: string,
  change: GitChange,
  staged: boolean,
  pinned = false,
) {
  const context = gitContext(repository);
  const id = `git-diff:${encodeURIComponent(repository)}:${staged ? "index" : "worktree"}:${encodeURIComponent(change.path)}`;
  const existing = useApp.getState().docs[id];
  if (existing) {
    showDocument(id, { pinned, preserveFocus: !pinned });
    return;
  }
  const doc: Doc = {
    id,
    path: null,
    name: `${basename(change.path)} (${staged ? "Index" : "Working Tree"})`,
    language: languageFor(change.path),
    eol: "LF",
    encoding: "utf8",
    revision: null,
    version: 1,
    dirty: false,
    gitDiff: {
      workspace: context.expectedRoot,
      repository,
      path: change.path,
      oldPath: change.oldPath,
      staged,
      conflicted: change.conflicted,
    },
  };
  setApp((s) => ({ docs: { ...s.docs, [id]: doc } }));
  showDocument(id, { pinned, preserveFocus: !pinned });
}

export async function attachGitSource(id: string, content: GitDiffContent) {
  if (!content.source) {
    return;
  }
  const initial = useApp.getState().docs[id];
  if (!initial?.gitDiff) {
    return;
  }
  if (
    normalize(useApp.getState().root ?? "") !==
    normalize(initial.gitDiff.workspace)
  ) {
    return;
  }
  let source = Object.values(useApp.getState().docs).find(
    (d) => d.path && normalize(d.path) === normalize(content.source!),
  );
  if (!source) {
    // Load through the normal encoding and language services without changing tabs.
    const sourceId = await openPath(content.source, {
      reveal: false,
    });
    source = useApp.getState().docs[sourceId];
    if (!useApp.getState().docs[id]) {
      return;
    }
  }
  if (source && useApp.getState().docs[id]?.gitDiff) {
    patchDoc(id, {
      gitDiff: { ...initial.gitDiff, sourceId: source.id },
      dirty: source.dirty,
    });
  }
}

useApp.subscribe((state, previous) => {
  if (state.docs === previous.docs) {
    return;
  }
  let docs: Record<string, Doc> | undefined;
  for (const doc of Object.values(state.docs)) {
    const source = doc.gitDiff?.sourceId && state.docs[doc.gitDiff.sourceId];
    if (source && doc.dirty !== source.dirty) {
      docs ??= { ...state.docs };
      docs[doc.id] = { ...doc, dirty: source.dirty };
    }
  }
  if (docs) {
    const groups = state.groups.map((g) =>
      g.preview && docs[g.preview]?.dirty ? { ...g, preview: null } : g,
    );
    setApp({ docs, groups });
  }
});

export function changePaths(changes: GitChange[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.oldPath ? [change.path, change.oldPath] : [change.path],
      ),
    ),
  ];
}

export async function runGitOperation(
  repository: string,
  request: GitOperation,
): Promise<boolean> {
  if (useApp.getState().gitBusy[repository]) {
    return false;
  }
  const context = gitContext(repository);
  const branchOperation = ["switch", "createBranch", "deleteBranch"].includes(request.kind);
  const validBranchContext = () => {
    const state = useApp.getState();
    const selected = selectedRepository();
    return state.gitState.session === context.session && selected?.path === repository && !selected.operation;
  };
  if (branchOperation && !validBranchContext()) {
    return false;
  }
  let started = false;
  const busy = request.kind === "pull" && request.rebase ? "pullRebase" : request.kind;
  setApp((s) => ({ gitBusy: { ...s.gitBusy, [repository]: busy } }));
  try {
    const changesWorktree = [
      "pull",
      "switch",
      "createBranch",
      "continue",
      "abort",
    ].includes(request.kind);
    const affected =
      request.kind === "stage"
        ? request.paths.map((path) => normalize(join(repository, path)))
        : [];
    const dirty = Object.values(useApp.getState().docs).filter(
      (d) =>
        !d.gitDiff &&
        d.dirty &&
        d.path &&
        (changesWorktree
          ? normalize(d.path).startsWith(normalize(repository) + "/")
          : affected.includes(normalize(d.path))),
    );
    if (dirty.length) {
      if (
        (await ask(
          "Save files before Git operation?",
          "Save the affected files before continuing.",
          ["Save and Continue", "Cancel"],
          { items: dirty.map((d) => d.path!) },
        )) !== "Save and Continue"
      ) {
        return false;
      }
      for (const doc of dirty) {
        await save(doc.id);
        if (useApp.getState().docs[doc.id]?.dirty) {
          return false;
        }
      }
    }
    if (request.kind === "discard") {
      if (
        (await ask(
          "Discard changes?",
          "Tracked files will be restored from the index, preserving staged changes. Untracked files will be moved to the Recycle Bin. Unsaved edits to these files will also be discarded.",
          ["Discard Changes", "Cancel"],
          { items: request.files.map((f) => f.path) },
        )) !== "Discard Changes"
      ) {
        return false;
      }
    }
    if (
      request.kind === "deleteBranch" &&
      (await ask(
        "Delete branch?",
        `Delete local branch “${request.branch}”? Git will refuse if it is in use or not fully merged.`,
        ["Delete Branch", "Cancel"],
      )) !== "Delete Branch"
    ) {
      return false;
    }
    if (
      request.kind === "abort" &&
      (await ask(
        "Abort operation?",
        "Abort the current merge or rebase and restore the pre-operation state?",
        ["Abort", "Cancel"],
      )) !== "Abort"
    ) {
      return false;
    }
    if (useApp.getState().root !== context.expectedRoot || (branchOperation && !validBranchContext())) {
      return false;
    }
    const versions = new Map(
      Object.values(useApp.getState().docs).map((doc) => [doc.id, doc.version]),
    );
    started = true;
    await trustedCall<string>("git_operate", { ...context, request });
    if (request.kind === "discard") {
      const paths = new Set(
        request.files.map((f) => normalize(join(repository, f.path))),
      );
      for (const doc of Object.values(useApp.getState().docs)) {
        if (
          doc.path &&
          paths.has(normalize(doc.path)) &&
          versions.get(doc.id) === doc.version
        ) {
          patchDoc(doc.id, { dirty: false, conflict: false });
        }
      }
    }
    return true;
  } catch (error) {
    if (useApp.getState().root === context.expectedRoot) {
      notify(errorMessage(error));
    }
    return false;
  } finally {
    if (started && useApp.getState().root === context.expectedRoot) {
      await Promise.allSettled([refreshGitPanel(), refreshDocuments()]);
      window.dispatchEvent(
        new CustomEvent("git-operation-finished", { detail: repository }),
      );
    }
    setApp((s) => {
      const gitBusy = { ...s.gitBusy };
      delete gitBusy[repository];
      return { gitBusy };
    });
  }
}
