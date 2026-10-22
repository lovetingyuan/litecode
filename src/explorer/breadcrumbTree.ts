import type { FileTree } from "@pierre/trees";
import { DirectoryCache, directoryPath, parentDirectory } from "./directoryCache";
import { createDirectorySync } from "./explorerSync";

export type BreadcrumbSegment = { label: string; path: string; workspacePath?: string };
const visible = (path: string) => path.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "").replace(/\\/g, "/");

export function breadcrumbSegments(path: string | undefined, name: string, root: string | null): BreadcrumbSegment[] {
  const value = visible(path ?? name);
  const base = root ? visible(root).replace(/\/+$/, "") : null;
  const inWorkspace = !!path && !!base && value.toLowerCase().startsWith(base.toLowerCase() + "/");
  const relative = inWorkspace ? value.slice(base!.length + 1) : value;
  const parts = relative.split("/");
  return parts.map((label, index) => {
    const workspacePath = parts.slice(0, index + 1).join("/");
    return { label, path: inWorkspace ? `${base}/${workspacePath}` : workspacePath, ...(inWorkspace ? { workspacePath } : {}) };
  });
}

/** A picker owns its model and expansion; only directory snapshots are shared. */
export function attachBreadcrumbTree(model: FileTree, cache: DirectoryCache, target: string, changed: () => void) {
  const sync = createDirectorySync(model);
  let parent = parentDirectory(target);
  let stopped = false;
  let ready = false;
  let scheduled = false;
  let previousExpanded = new Set<string>();
  const directories = new Set<string>();
  const requested = new Set<string>();
  const valid = () => !stopped && !cache.disposed;
  const toWorkspacePath = (path: string) => parent ? `${parent}/${path}` : path;
  const toLocalPath = (path: string) => parent ? path.slice(parent.length + 1) : path;
  const contains = (path: string) => !parent || path.toLowerCase().startsWith(parent.toLowerCase() + "/");
  const expandedDirectories = () => {
    const result = new Set<string>();
    for (const directory of directories) {
      const item = model.getItem(directory);
      if (!item || !("isExpanded" in item) || !item.isExpanded()) { continue; }
      let ancestor = parentDirectory(directory);
      let visible = true;
      while (ancestor) {
        const handle = model.getItem(ancestor);
        if (!handle || !("isExpanded" in handle) || !handle.isExpanded()) { visible = false; break; }
        ancestor = parentDirectory(ancestor);
      }
      if (visible) { result.add(directory); }
    }
    return result;
  };
  const update = async (directory: string, paths: readonly string[]) => {
    if (!valid() || !requested.has(directory)) { return; }
    const localDirectory = directory === parent ? "" : toLocalPath(directory);
    const localPaths = paths.filter(contains).map(toLocalPath);
    for (const path of localPaths) { if (path.endsWith("/")) { directories.add(directoryPath(path)); } }
    await sync.update(localDirectory, localPaths, () => valid() && cache.directories.get(directory)?.paths === paths);
  };
  const inspect = () => {
    if (scheduled || !ready || !valid()) { return; }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!valid()) { return; }
      const expanded = expandedDirectories();
      for (const local of expanded) {
        const directory = directoryPath(toWorkspacePath(local));
        const entry = cache.entry(directory);
        const first = !requested.has(directory);
        requested.add(directory);
        if (first && entry.paths.length) { void update(directory, entry.paths); }
        if (entry.status === "unloaded" || entry.status === "stale" || (entry.status === "failed" && !previousExpanded.has(local))) {
          void cache.load(directory);
        }
      }
      previousExpanded = expanded;
    });
  };
  const unsubscribeCache = cache.subscribe(async (directory, paths) => {
    if (!valid() || !ready) { return; }
    if (directory !== undefined && paths) { await update(directory, paths); }
    if (valid()) {
      model.setComposition(model.getComposition());
      changed();
      inspect();
    }
  });
  const unsubscribeModel = model.subscribe(() => { inspect(); if (valid()) { changed(); } });
  const initialized = (async () => {
    // Resolve Windows casing through the shared cache before mapping tree paths.
    const canonical = await cache.ensurePath(target);
    if (!valid()) { return; }
    if (canonical) { parent = parentDirectory(canonical); }
    requested.add(parent);
    ready = true;
    await update(parent, cache.entry(parent).paths);
    await cache.load(parent);
    if (!valid()) { return; }
    const local = toLocalPath(canonical ?? target);
    const item = model.getItem(local);
    if (item) {
      item.select();
      model.focusPath(local);
      model.scrollToPath(local, { focus: true, offset: "center" });
    } else {
      model.focusFirstItem();
    }
    changed();
    inspect();
  })();
  return {
    initialized,
    toWorkspacePath,
    state: (path = "") => cache.entry(path ? directoryPath(toWorkspacePath(path)) : parent),
    refresh: () => {
      if (!ready || !valid()) { return; }
      for (const directory of [parent, ...[...expandedDirectories()].map((path) => directoryPath(toWorkspacePath(path)))]) {
        if (["stale", "unloaded"].includes(cache.entry(directory).status)) { void cache.load(directory); }
      }
    },
    retry: (path = "") => {
      if (valid()) { void cache.load(path ? directoryPath(toWorkspacePath(path)) : parent, true); }
    },
    dispose: () => { stopped = true; unsubscribeCache(); unsubscribeModel(); sync.dispose(); },
  };
}
