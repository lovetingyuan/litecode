import type { FileTree, FileTreeBatchOperation, FileTreeMutationEvent } from "@pierre/trees";
/** Reconcile a single directory; unrelated loaded subtrees are never compared. */
export function createDirectorySync(model: FileTree) {
  const children = new Map<string, Set<string>>();
  let disposed = false;
  const recordMove = (event: FileTreeMutationEvent) => {
    if (event.operation === "batch") {
      event.events.forEach(recordMove);
    }
    else if (event.operation === "move" && event.from.endsWith("/")) {
      const moved = [...children].filter(([path]) => path + "/" === event.from || path.startsWith(event.from));
      for (const [path] of moved) {
        children.delete(path);
      }
      for (const [path, paths] of moved) {
        children.set((event.to + (path + "/").slice(event.from.length)).replace(/\/$/, ""), new Set([...paths].map((path) => event.to + path.slice(event.from.length))));
      }
    }
  };
  const unsubscribe = model.onMutation("*", recordMove);
  return {
    dispose() { disposed = true; unsubscribe(); },
    async update(directory: string, paths: readonly string[], valid = () => true) {
      const previous = children.get(directory) ?? new Set<string>();
      const next = new Set(paths);
      const operations: FileTreeBatchOperation[] = [];
      for (const path of previous) {
        if (next.has(path)) {
          continue;
        }
        if (model.getItem(path)) {
          operations.push({ type: "remove", path, recursive: path.endsWith("/") });
        }
        if (path.endsWith("/")) {
          for (const cached of children.keys()) {
            if (cached === path.slice(0, -1) || cached.startsWith(path)) {
              children.delete(cached);
            }
          }
        }
      }
      for (const path of next) {
        if (!model.getItem(path)) {
          operations.push({ type: "add", path });
        }
      }
      children.set(directory, next);
      for (let offset = 0; offset < operations.length && !disposed && valid(); offset += 512) {
        model.batch(operations.slice(offset, offset + 512));
        if (offset + 512 < operations.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    },
  };
}
