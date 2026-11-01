import type { FileTree } from "@pierre/trees";
import type { RenamedEntry } from "./explorerCreation";

function expandAncestors(model: FileTree, path: string) {
  const parts = path.split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const ancestor = model.getItem(parts.slice(0, depth).join("/"));
    if (ancestor && "expand" in ancestor) {
      ancestor.expand();
    }
  }
}

export function revealRenamedEntry(
  model: FileTree,
  result: RenamedEntry,
  source: string,
  directory: boolean,
) {
  const target = result.relativePath + (result.isDirectory ? "/" : "");
  if (result.changed && model.getItem(source)) {
    const parts = result.relativePath.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const path = parts.slice(0, depth).join("/") + "/";
      if (!model.getItem(path)) {
        model.add(path);
      }
    }
    model.move(source + (directory ? "/" : ""), target);
  }
  expandAncestors(model, result.relativePath);
  model.getItem(target)?.select();
  model.focusPath(target);
  model.scrollToPath(target, { focus: true, offset: "nearest" });
}

export function revealCreatedEntry(model: FileTree, target: string, folder: boolean) {
  for (const selected of model.getSelectedPaths()) {
    model.getItem(selected)?.deselect();
  }
  expandAncestors(model, target.replace(/\/$/, ""));
  model.getItem(target)?.select();
  model.focusPath(target);
  model.scrollToPath(target, { focus: folder, offset: "nearest" });
}

export function selectRevealedEntry(
  model: FileTree,
  item: NonNullable<ReturnType<FileTree["getItem"]>>,
  target: string,
  navigatingTree: boolean,
) {
  expandAncestors(model, target);
  for (const selected of model.getSelectedPaths()) {
    if (selected !== target) {
      model.getItem(selected)?.deselect();
    }
  }
  item.select();
  model.focusPath(target);
  model.scrollToPath(target, { focus: false, offset: navigatingTree ? "nearest" : "center" });
}
