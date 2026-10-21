import type { FileTree, FileTreeMutationEvent } from "@pierre/trees";
import { call } from "../core/bridge";
import { useApp, setApp, notify } from "../store/store";
import type { DirectorySnapshot, WorkspaceChanges } from "../types/types";
import { DirectoryCache, directoryPath, parentDirectory } from "./directoryCache";
import { createDirectorySync } from "./explorerSync";
import { refreshGit } from "./workspaceGit";
let current: DirectoryCache | null = null;
let expanded = new Set<string>();
export function resetWorkspaceTree() {
  current?.dispose();
  current = null;
  expanded = new Set();
}
useApp.subscribe((state, previous) => {
  if (state.root !== previous.root) {
    resetWorkspaceTree();
    setApp({ treeRoot: null, gitState: { root: null, session: null, git: [], branch: null, warnings: [] }, fileIndexVersion: state.fileIndexVersion + 1, workspaceEpoch: state.workspaceEpoch + 1 });
  }
});
export function workspaceDirectories() {
  const root = useApp.getState().root;
  if (!root) {
    return null;
  }
  if (!current || current.root !== root || current.disposed) {
    current = new DirectoryCache(root, (directory, session) => call<DirectorySnapshot>("read_workspace_directory", { directory, expectedRoot: root, session }));
  }
  return current;
}
export function loadedWorkspacePaths() { return [...(workspaceDirectories()?.paths() ?? [])]; }
export function directoryDecoration(path: string) {
  const entry = workspaceDirectories()?.directories.get(directoryPath(path));
  if (entry?.status === "loading") {
    return { text: "…", title: "Loading directory" };
  }
  if (entry?.status === "failed") {
    return { text: "!", title: `${entry.error}. Collapse and expand this folder to retry.` };
  }
  return null;
}
export async function ensureWorkspacePath(path: string) { return workspaceDirectories()?.ensurePath(path) ?? null; }
export async function refreshTree(changedPaths?: readonly string[]): Promise<void> {
  const cache = workspaceDirectories();
  if (!cache) {
    return;
  }
  setApp((state) => ({ fileIndexVersion: state.fileIndexVersion + 1 }));
  const directories = changedPaths ? new Set(changedPaths.map(parentDirectory)) : new Set(["", ...expanded]);
  if (!changedPaths) {
    for (const directory of cache.directories.keys()) {
      cache.invalidate(directory);
    }
  }
  for (const directory of directories) {
    cache.invalidate(directory);
  }
  await Promise.all([...directories].map(async (directory) => {
    const canonical = directory ? await cache.ensurePath(`${directory}/`) : "";
    if (!cache.disposed && canonical !== null) {
      await cache.load(directoryPath(canonical));
    }
  }));
  if (!cache.disposed && useApp.getState().root === cache.root) {
    setApp({ treeRoot: cache.root });
  }
  if (!cache.disposed) {
    void refreshGit(cache);
  }
}
export async function handleWorkspaceChanges(event: WorkspaceChanges): Promise<boolean> {
  const cache = workspaceDirectories();
  if (!cache || directoryPath(event.root).toLowerCase() !== directoryPath(cache.root).toLowerCase() || (cache.session !== null && cache.session !== event.session)) {
    return false;
  }
  // A watcher can report before the initial directory request completes.
  cache.session = event.session;
  const structural = event.changes.filter((change) => change.structural);
  const ignoreChanged = event.changes.some(({ path }) => /(^|\/)(\.gitignore|\.ignore|\.rgignore)$/.test(path));
  if (event.rescan || structural.length || ignoreChanged || event.fileIndexChanged) {
    setApp((state) => ({ fileIndexVersion: state.fileIndexVersion + 1 }));
  }
  const affected = new Set<string>();
  if (event.rescan) {
    for (const directory of cache.directories.keys()) {
      cache.invalidate(directory);
      if (directory === "" || expanded.has(directory)) {
        affected.add(directory);
      }
    }
  }
  else {
    for (const { path } of structural) {
      const parent = parentDirectory(path);
      const existingParent = [...cache.directories.keys()].find((directory) => directory.toLowerCase() === parent.toLowerCase());
      if (existingParent !== undefined) {
        cache.invalidate(existingParent);
        if (existingParent === "" || expanded.has(existingParent)) {
          affected.add(existingParent);
        }
      }
      // Replacements can keep the directory name while changing all its children.
      for (const directory of cache.directories.keys()) {
        if (directory.toLowerCase() === directoryPath(path).toLowerCase() || directory.toLowerCase().startsWith(directoryPath(path).toLowerCase() + "/")) {
          cache.invalidate(directory);
          if (expanded.has(directory)) {
            affected.add(directory);
          }
        }
      }
    }
  }
  await Promise.all([...affected].map((directory) => cache.load(directory)));
  if (event.gitChanged && !cache.disposed) {
    void refreshGit(cache);
  }
  return !cache.disposed;
}
export function attachWorkspaceTree(model: FileTree, changed: () => void) {
  const cache = workspaceDirectories();
  model.resetPaths([]);
  if (!cache) {
    return () => { };
  }
  const sync = createDirectorySync(model);
  let stopped = false;
  let scheduled = false;
  let previousExpanded = new Set<string>();
  const errors = new Map<string, string>();
  const knownDirectories = new Set<string>();
  const rememberDirectories = (paths: readonly string[]) => {
    for (const path of paths) {
      if (path.endsWith("/")) { knownDirectories.add(directoryPath(path)); }
    }
  };
  const inspect = () => {
    if (scheduled || stopped) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped || cache.disposed) {
        return;
      }
      const next = new Set<string>();
      // Inspect directory handles, not every file row in a large expanded folder.
      for (const path of knownDirectories) {
        const item = model.getItem(path);
        if (!item) { knownDirectories.delete(path); continue; }
        if (!("isExpanded" in item) || !item.isExpanded()) {
          continue;
        }
        let visible = true;
        for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
          const ancestor = model.getItem(path.slice(0, slash));
          if (!ancestor || !("isExpanded" in ancestor) || !ancestor.isExpanded()) { visible = false; break; }
        }
        if (!visible) { continue; }
        next.add(path);
        const entry = cache.entry(path);
        if (entry.status === "unloaded" || entry.status === "stale" || (entry.status === "failed" && !previousExpanded.has(path))) {
          void cache.load(path);
        }
      }
      previousExpanded = next;
      expanded = next;
    });
  };
  const unsubscribeCache = cache.subscribe(async (directory, paths) => {
    if (stopped) {
      return;
    }
    if (directory !== undefined && paths) {
      rememberDirectories(paths);
      await sync.update(directory, paths, () => !cache.disposed && cache.directories.get(directory)?.paths === paths);
    }
    if (stopped || cache.disposed) {
      return;
    }
    for (const [path, entry] of cache.directories) {
      if (entry.error && errors.get(path) !== entry.error) {
        errors.set(path, entry.error);
        notify(entry.error);
      }
      if (!entry.error) {
        errors.delete(path);
      }
    }
    model.setComposition(model.getComposition());
    changed();
    inspect();
  });
  const unsubscribeModel = model.subscribe(inspect);
  const recordMove = (event: FileTreeMutationEvent) => {
    if (event.operation === "batch") {
      event.events.forEach(recordMove);
    }
    else if (event.operation === "move") {
      cache.relocate(event.from, event.to);
      const movedDirectories = [...knownDirectories].filter((path) => path + "/" === event.from || (event.from.endsWith("/") && path.startsWith(event.from)));
      for (const path of movedDirectories) {
        knownDirectories.delete(path);
        knownDirectories.add(directoryPath(event.to + (path + "/").slice(event.from.length)));
      }
    }
  };
  const unsubscribeMoves = model.onMutation("*", recordMove);
  void (async () => {
    for (const [directory, entry] of cache.directories) {
      if (stopped) {
        return;
      }
      if (entry.status === "loaded" || entry.paths.length) {
        rememberDirectories(entry.paths);
        await sync.update(directory, entry.paths);
      }
    }
    if (!stopped) {
      await cache.load("");
    }
    if (!stopped && !cache.disposed) {
      setApp({ treeRoot: cache.root });
      changed();
      inspect();
    }
  })();
  return () => { stopped = true; unsubscribeCache(); unsubscribeModel(); unsubscribeMoves(); sync.dispose(); };
}
