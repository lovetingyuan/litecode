import { treeTheme } from "../styles/theme";
import workbenchStyles from "../styles/workbench.module.css";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  preparePresortedFileTreeInput,
  themeToTreeStyles,
  type FileTreeDropContext,
} from "@pierre/trees";
import { Menu } from "@base-ui/react/menu";
import sidebarScrollbarCSS from "../styles/sidebar-scrollbar.css?raw";
import { useApp, setApp, notify } from "../store/store";
import { call, errorMessage, desktop } from "../core/bridge";
import {
  basename,
  join,
  openPath,
  relative,
  renameDocumentPaths,
  renameDocuments,
  beginDocumentMove,
  normalize,
  pathTitle,
  visiblePath,
} from "../editor/documents";
import { ask } from "./dialog";
import {
  creationParent,
  validateCreationName,
  validateRenameName,
  type CreationKind,
  type CreatedEntry,
  type RenamedEntry,
} from "../explorer/explorerCreation";
import { Icon, IconButton } from "./ui";
import {
  refreshTree,
  attachWorkspaceTree,
  directoryDecoration,
  ensureWorkspacePath,
  loadedWorkspacePaths,
  workspaceDirectories,
} from "../explorer/workspaceTree";
import { treeMovePlan, type FileMove, type MoveReport } from "../explorer/explorerMove";
import {
  createExplorerClipboard,
  isEditableTreeEvent,
  pasteDirectory,
  type FileClipboard,
  type CopyReport,
} from "../explorer/explorerClipboard";
import {
  copyDroppedItems,
  externalDropDirectory,
  registerExternalExplorer,
  type ExternalCopyPlan,
} from "../explorer/externalDrop";
import { explorerDragType } from "../explorer/explorerDrag";
import { deleteInternalFiles, pasteInternalFiles } from "../explorer/documentFileOperations";
import { gitConflictDecoration } from "../utils/gitStatus";

export { refreshTree } from "../explorer/workspaceTree";
export function revealInTree(path: string) {
  setApp({ sidebar: "explorer" });
  window.dispatchEvent(new CustomEvent("reveal-tree", { detail: path }));
}

export function Explorer({ openFolder }: { openFolder: () => void }) {
  const root = useApp((s) => s.root);
  const workspaceEpoch = useApp((s) => s.workspaceEpoch);
  const gitState = useApp((s) => s.gitState);
  const treeRoot = useApp((s) => s.treeRoot);
  const groups = useApp((s) => s.groups);
  const docs = useApp((s) => s.docs);
  const activeGroup = useApp((s) => s.activeGroup);
  const sidebar = useApp((s) => s.sidebar);
  const tabRevealRequest = useApp((s) => s.tabRevealRequests[s.activeGroup] ?? 0);
  const [context, setContext] = useState<{
    path: string;
    anchor: ComponentProps<typeof Menu.Positioner>["anchor"];
    close?: (options?: { restoreFocus?: boolean }) => void;
  } | null>(null);
  const [directoryVersion, setDirectoryVersion] = useState(0);
  const [revealTarget, setRevealTarget] = useState<{
    path: string;
    canonical: string | null;
    root: string;
  } | null>(null);
  const explicitReveal = useRef<{
    path: string;
    group: string;
    activePath: string | null | undefined;
    request: number;
  } | null>(null);
  const [explicitRequest, setExplicitRequest] = useState(0);
  const manualRefresh = useRef<{ ready: boolean } | null>(null);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const operationQueue = useRef(Promise.resolve());
  const creation = useRef<{ root: string; epoch: number; parent: string } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const wasExpanded = useRef(expanded);
  const revealPending = useRef(true);
  const moveBusy = useRef(false);
  const moveExecuting = useRef(false);
  const moveAbort = useRef<AbortController | null>(null);
  const pasteAbort = useRef<AbortController | null>(null);
  const draggedPaths = useRef<readonly string[]>([]);
  const pendingMoveSelection = useRef<string[] | null>(null);
  const [rootDropTarget, setRootDropTarget] = useState(false);
  const { model } = useFileTree({
    preparedInput: preparePresortedFileTreeInput([]),
    flattenEmptyDirectories: false,
    initialExpansion: 0,
    itemHeight: 26,
    overscan: 10,
    stickyFolders: true,
    icons: { set: "complete", colored: true },
    search: false,
    renderRowDecoration: ({ row }) => {
      if (row.kind === "directory") {
        return directoryDecoration(row.path);
      }
      const state = useApp.getState();
      return state.root
        ? gitConflictDecoration(
            join(state.root, row.path),
            state.root,
            state.gitState.root,
            state.gitState.git,
          )
        : null;
    },
    unsafeCSS: `
      ${sidebarScrollbarCSS}
      [data-file-tree-sticky-overlay-content]{box-shadow:0 3px 3px -3px var(--lc-shadow-solid)}
      svg[data-icon-name]{width:var(--trees-icon-width);height:var(--trees-icon-width)}
      [data-item-section="git"] [data-icon-name="file-tree-icon-dot"]{transform:none}
      [data-file-tree-root-drag-target="true"] > [data-file-tree-virtualized-scroll]{outline:1px solid var(--lc-focus);outline-offset:-1px;background:var(--lc-tree-drop-background)}
      [data-external-drop="true"]{outline:1px solid var(--trees-focus-border,var(--lc-focus));outline-offset:-1px;background:var(--trees-list-active-selection-background,var(--lc-selection))}
      [data-file-tree-editing="true"] [data-item-section="git"],
      [data-file-tree-editing="true"] [data-item-section="decoration"]{display:none}
      [data-file-tree-editing="true"] [data-item-section="content"]{flex:1;min-width:0}
      [data-file-tree-inline-edit-input]{min-width:0;width:100%;height:24px;box-sizing:border-box;background:var(--lc-input);border:1px solid var(--lc-focus);border-radius:2px;padding:0 4px}
      /* Keep each level at 14px and its guide centered under the parent icon. */
      [data-item-section="spacing"]{padding-left:0;margin-right:calc(-1 * var(--trees-item-row-gap))}
      [data-item-section="spacing"] > [data-item-section="spacing-item"]{
        width:14px;box-sizing:border-box;flex-shrink:0;margin:0;
        transform:translateX(calc(var(--trees-icon-width) / 2 - .5px));
      }
    `,
    renaming: { onStart: (item) => renameOptions(item.path, item.isFolder) },
    dragAndDrop: {
      canDrag: (paths) => {
        if (moveBusy.current || creation.current || !rootRef.current) {
          return false;
        }
        draggedPaths.current = paths;
        return true;
      },
      canDrop: (e) =>
        !moveBusy.current &&
        !creation.current &&
        !!treeMovePlan(e.draggedPaths, e.target.directoryPath)?.length,
      onDropRequest: (e) => {
        void requestMove(e);
      },
      onDropError: notify,
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "right-click",
        onOpen: (item, context) => {
          if (item.path === model.getCreatingPath()) {
            context.close();
            return;
          }
          setContext({
            path: item.path,
            anchor: context.anchorElement,
            close: (options) => context.close(options),
          });
        },
        onClose: () => setContext(null),
      },
    },
  });
  const rootRef = useRef(root);
  useLayoutEffect(() => {
    rootRef.current = root;
  }, [root]);
  function renameOptions(source: string, directory: boolean) {
    const state = useApp.getState();
    const base = state.root;
    const cache = workspaceDirectories();
    if (!base || !cache || cache.session === null || moveBusy.current) {
      return null;
    }
    const parent = creationParent(source, false);
    const request = { root: base, epoch: state.workspaceEpoch, parent };
    creation.current = request;
    revealPending.current = false;
    explicitReveal.current = null;
    const valid = () =>
      creation.current === request &&
      useApp.getState().root === base &&
      useApp.getState().workspaceEpoch === request.epoch;
    const args = { expectedRoot: base, session: cache.session, source };
    return {
      validateSync: (name: string) =>
        validateRenameName(name, /Win/i.test(navigator.platform), directory),
      validate: (name: string) =>
        valid()
          ? call<string | null>("validate_workspace_rename", { ...args, name })
          : "Workspace changed. Please start renaming again.",
      onCancel: () => {
        if (creation.current === request) {
          creation.current = null;
        }
      },
      onFinish: () => {
        if (creation.current === request) {
          creation.current = null;
        }
      },
      onCommit: async (name: string) => {
        const operation = operationQueue.current.then(async () => {
          if (!valid()) {
            throw new Error("Workspace changed. Please start renaming again.");
          }
          moveBusy.current = true;
          moveExecuting.current = true;
          const releaseTree = cache.hold([parent]);
          let releaseDocuments: ((error?: unknown) => void) | undefined;
          let moveError: unknown;
          try {
            const destination = join(
              base,
              [parent, ...name.split(/[\\/]/).filter(Boolean)].filter(Boolean).join("/"),
            );
            releaseDocuments = await beginDocumentMove([
              { from: join(base, source), to: destination },
            ]);
            if (!valid()) {
              throw new Error("Workspace changed. Please start renaming again.");
            }
            const result = await call<RenamedEntry>("rename_workspace_entry", { ...args, name });
            // Disk success must rebind open documents, even after a workspace switch.
            if (result.changed) {
              await renameDocumentPaths(result.from, result.to);
            }
            if (!valid()) {
              return;
            }
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
            const parts = result.relativePath.split("/");
            for (let depth = 1; depth < parts.length; depth++) {
              const ancestor = model.getItem(parts.slice(0, depth).join("/"));
              if (ancestor && "expand" in ancestor) {
                ancestor.expand();
              }
            }
            model.getItem(target)?.select();
            model.focusPath(target);
            model.scrollToPath(target, { focus: true, offset: "nearest" });
            if (creation.current === request) {
              creation.current = null;
            }
          } catch (error) {
            moveError = error;
            throw error;
          } finally {
            releaseDocuments?.(moveError);
            moveExecuting.current = false;
            try {
              await releaseTree();
              if (
                useApp.getState().root === base &&
                useApp.getState().workspaceEpoch === request.epoch
              ) {
                await refreshTree([
                  source,
                  parent ? `${parent}/${name.split(/[\\/]/)[0]}` : name.split(/[\\/]/)[0],
                ]);
              }
            } finally {
              moveBusy.current = false;
            }
          }
          requestAnimationFrame(() => {
            if (
              useApp.getState().root === base &&
              useApp.getState().workspaceEpoch === request.epoch
            ) {
              model
                .getFileTreeContainer()
                ?.shadowRoot?.querySelector<HTMLElement>(
                  '[data-item-focused="true"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])',
                )
                ?.focus({ preventScroll: true });
            }
          });
        });
        operationQueue.current = operation.catch(() => {});
        await operation;
      },
    };
  }
  async function startCreation(kind: CreationKind, path: string) {
    const state = useApp.getState();
    const base = state.root;
    const cache = workspaceDirectories();
    if (!base || !cache || moveBusy.current) {
      return;
    }
    if (path && !model.getItem(path)) {
      notify("The destination is no longer available. Please select a folder again.");
      return;
    }
    const parent =
      path === model.getCreatingPath() && creation.current
        ? creation.current.parent
        : creationParent(path, model.getItem(path)?.isDirectory() ?? false);
    model.cancelEditing();
    const request = { root: base, epoch: state.workspaceEpoch, parent };
    creation.current = request;
    const valid = () =>
      creation.current === request &&
      useApp.getState().root === base &&
      useApp.getState().workspaceEpoch === request.epoch;
    revealPending.current = false;
    explicitReveal.current = null;
    setExpanded(true);
    try {
      // Loading first makes sibling validation and the insertion position stable.
      await cache.load(parent);
      if (!valid()) {
        return;
      }
      if (cache.entry(parent).status !== "loaded" || cache.session === null) {
        throw new Error(cache.entry(parent).error ?? "Could not load the destination folder.");
      }
      const args = { expectedRoot: base, session: cache.session, parent, kind };
      const draft = model.startCreating({
        parentPath: parent,
        kind,
        validateSync: (name) => validateCreationName(name, /Win/i.test(navigator.platform)),
        validate: async (name) => {
          if (!valid()) {
            return "Workspace changed. Please start creation again.";
          }
          return call<string | null>("validate_workspace_creation", { ...args, name });
        },
        onCancel: () => {
          if (creation.current === request) {
            creation.current = null;
          }
        },
        onCommit: async (name) => {
          const operation = operationQueue.current.then(async () => {
            if (!valid()) {
              throw new Error("Workspace changed. Please start creation again.");
            }
            const result = await call<CreatedEntry>("create_workspace_entry", { ...args, name });
            if (!valid()) {
              return;
            }
            await refreshTree([
              parent ? `${parent}/${name.split(/[\\/]/)[0]}` : name.split(/[\\/]/)[0],
              result.relativePath,
            ]);
            if (!valid()) {
              return;
            }
            const target = await ensureWorkspacePath(
              result.relativePath + (result.kind === "newFolder" ? "/" : ""),
            );
            if (!valid()) {
              return;
            }
            if (target) {
              for (const selected of model.getSelectedPaths()) {
                model.getItem(selected)?.deselect();
              }
              const parts = target.replace(/\/$/, "").split("/");
              for (let depth = 1; depth < parts.length; depth++) {
                const ancestor = model.getItem(parts.slice(0, depth).join("/"));
                if (ancestor && "expand" in ancestor) {
                  ancestor.expand();
                }
              }
              model.getItem(target)?.select();
              model.focusPath(target);
              model.scrollToPath(target, { focus: result.kind === "newFolder", offset: "nearest" });
              if (result.kind === "newFolder") {
                requestAnimationFrame(() => {
                  const current = useApp.getState();
                  if (current.root === base && current.workspaceEpoch === request.epoch) {
                    model
                      .getFileTreeContainer()
                      ?.shadowRoot?.querySelector<HTMLElement>(
                        `[data-item-path="${CSS.escape(target)}"]:not([data-file-tree-sticky-row]):not([data-item-parked="true"])`,
                      )
                      ?.focus({ preventScroll: true });
                  }
                });
              }
            }
            if (result.kind === "newFile") {
              await openPath(result.path, { pinned: true }).catch((error) =>
                notify(errorMessage(error)),
              );
            }
            if (creation.current === request) {
              creation.current = null;
            }
          });
          operationQueue.current = operation.catch(() => {});
          await operation;
        },
      });
      if (!draft) {
        throw new Error("The destination folder is no longer available.");
      }
    } catch (error) {
      if (valid()) {
        creation.current = null;
        notify(errorMessage(error));
      }
    }
  }
  const clipboardRef = useRef<ReturnType<typeof createExplorerClipboard> | null>(null);
  useLayoutEffect(() => {
    if (clipboardRef.current) {
      return;
    }
    clipboardRef.current = createExplorerClipboard({
      read: () =>
        desktop
          ? call<FileClipboard>("read_file_clipboard")
          : Promise.resolve({ sequence: null, paths: [] }),
      copyExternal: async (expectedSequence, expectedRoot, targetDirectory) => {
        moveExecuting.current = true;
        return call<CopyReport>("paste_file_clipboard", {
          expectedSequence,
          expectedRoot,
          targetDirectory,
        });
      },
      pasteInternal: async (moves, cut, signal) => {
        moveExecuting.current = true;
        return pasteInternalFiles(moves, cut, signal);
      },
    });
  }, []);
  async function paste(path: string) {
    const base = rootRef.current;
    if (!base || moveBusy.current) {
      return;
    }
    const parent = pasteDirectory(path, model.getItem(path)?.isDirectory() ?? false);
    const destination = parent ? join(base, parent) : base;
    let changedPaths: string[] | undefined;
    const abort = new AbortController();
    pasteAbort.current = abort;
    moveBusy.current = true;
    const operation = operationQueue.current.then(async () => {
      try {
        if (abort.signal.aborted) {
          return;
        }
        const report = await clipboardRef.current!.paste(base, destination, abort.signal);
        if (abort.signal.aborted || rootRef.current !== base || !report) {
          return;
        }
        changedPaths = report.copied.flatMap((item) => [
          relative(item.to, base),
          ...(normalize(item.from).startsWith(normalize(base).replace(/\/$/, "") + "/")
            ? [relative(item.from, base)]
            : []),
        ]);
        if (report.copied.length) {
          pendingMoveSelection.current = report.copied.map((item) => relative(item.to, base));
          revealPending.current = false;
          setExpanded(true);
        }
        if (report.failed.length) {
          notify(
            `Pasted ${report.copied.length} item(s).\n${report.failed.map((item) => `${pathTitle(item.path)}: ${item.message}`).join("\n")}`,
          );
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          notify(errorMessage(error));
        }
      } finally {
        const executed = moveExecuting.current;
        moveExecuting.current = false;
        try {
          if (executed && !abort.signal.aborted && rootRef.current === base) {
            await refreshTree(changedPaths);
          }
        } finally {
          moveBusy.current = false;
          if (pasteAbort.current === abort) {
            pasteAbort.current = null;
          }
        }
      }
    });
    operationQueue.current = operation;
    await operation;
  }
  useEffect(
    () =>
      registerExternalExplorer({
        resolve: (targets) => {
          const container = targets.find(
            (target) => target instanceof HTMLElement && target.matches(".explorer"),
          ) as HTMLElement | undefined;
          if (!container || !rootRef.current) {
            return null;
          }
          const row = targets.find(
            (target) => target instanceof HTMLElement && target.hasAttribute("data-item-path"),
          ) as HTMLElement | undefined;
          const path = row?.dataset.itemPath;
          const item = path ? model.getItem(path) : null;
          const directory = externalDropDirectory(path, item?.isDirectory() ?? false);
          const treeContainer = model.getFileTreeContainer();
          const folderRow = directory
            ? treeContainer?.shadowRoot?.querySelector<HTMLElement>(
                `[data-item-path="${CSS.escape(directory)}"]`,
              )
            : null;
          return {
            element: folderRow ?? (directory && row ? row : container),
            directory,
            hover: item?.isDirectory()
              ? () => {
                  if ("expand" in item) {
                    item.expand();
                  }
                }
              : undefined,
            scroll:
              treeContainer?.shadowRoot?.querySelector<HTMLElement>(
                "[data-file-tree-virtualized-scroll]",
              ) ?? undefined,
          };
        },
        copy: async (drop, directory, signal) => {
          const base = rootRef.current;
          if (!base || signal.aborted) {
            return;
          }
          if (moveBusy.current) {
            notify("Another file operation is in progress. Please drag the items again.");
            return;
          }
          moveBusy.current = true;
          let executed = false;
          let changedPaths: string[] | undefined;
          const operation = operationQueue.current.then(async () => {
            try {
              if (signal.aborted || rootRef.current !== base) {
                return;
              }
              const args = {
                batchId: drop.batchId,
                expectedRoot: base,
                targetDirectory: directory ? join(base, directory) : base,
              };
              const report = await copyDroppedItems(
                drop.items,
                {
                  plan: (index) => call<ExternalCopyPlan>("plan_external_copy", { ...args, index }),
                  confirm: (_item, plan) =>
                    ask(
                      `Replace '${basename(plan.destination)}'?`,
                      `An item with this name already exists in ${pathTitle(args.targetDirectory)}.\n${plan.directory ? "The existing folder and all its contents will be replaced." : "Its existing contents will be replaced."}`,
                      ["Replace", "Skip", "Cancel"],
                      { signal },
                    ),
                  copy: async (index, plan) => {
                    executed = true;
                    moveExecuting.current = true;
                    return call("copy_external_item", {
                      ...args,
                      index,
                      expectedTarget: plan.existing,
                      replace: plan.existing !== null,
                    });
                  },
                },
                signal,
              );
              if (rootRef.current !== base || signal.aborted) {
                return;
              }
              changedPaths = report.copied.map((item) => relative(item.to, base));
              if (report.copied.length) {
                pendingMoveSelection.current = report.copied.map((item) => relative(item.to, base));
                revealPending.current = false;
                setExpanded(true);
              }
              if (report.failed.length) {
                notify(
                  `Copied ${report.copied.length} item(s).\n${report.failed.map((item) => `${pathTitle(item.path)}: ${item.message}`).join("\n")}`,
                );
              }
              if (report.copied.length === 1) {
                const copied = report.copied[0];
                if (
                  drop.items.some(
                    (item) => normalize(item.path) === normalize(copied.from) && !item.directory,
                  )
                ) {
                  await openPath(copied.to, { pinned: true, preserveFocus: true });
                }
              }
            } catch (error) {
              if (!signal.aborted) {
                notify(errorMessage(error));
              }
            } finally {
              moveExecuting.current = false;
              try {
                if (executed && rootRef.current === base) {
                  await refreshTree(changedPaths);
                }
              } finally {
                moveBusy.current = false;
              }
            }
          });
          operationQueue.current = operation;
          await operation;
        },
      }),
    [model],
  );
  function rootContext(event: MouseEvent<HTMLElement>) {
    if (!rootRef.current || isEditableTreeEvent(event.nativeEvent)) {
      return;
    }
    if (
      event.nativeEvent
        .composedPath()
        .some((target) => target instanceof HTMLElement && target.hasAttribute("data-item-path"))
    ) {
      return;
    }
    event.preventDefault();
    const anchor = {
      getBoundingClientRect: () =>
        DOMRect.fromRect({ x: event.clientX, y: event.clientY, width: 1, height: 1 }),
    };
    // Base UI accepts a virtual anchor for the tree's empty area and workspace heading.
    setContext({ path: "", anchor });
  }
  function clipboardKey(event: KeyboardEvent<HTMLElement>, path: string) {
    if (
      isEditableTreeEvent(event.nativeEvent) ||
      event.altKey ||
      event.shiftKey ||
      !event.ctrlKey
    ) {
      return false;
    }
    const kind = ({ c: "copy", x: "cut", v: "paste" } as Record<string, string>)[
      event.key.toLowerCase()
    ];
    if (!kind) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    void action(kind, path);
    return true;
  }
  async function requestMove(event: FileTreeDropContext) {
    const base = rootRef.current;
    const planned = treeMovePlan(event.draggedPaths, event.target.directoryPath);
    if (!base || moveBusy.current || !planned?.length) {
      return;
    }
    moveBusy.current = true;
    const abort = new AbortController();
    moveAbort.current = abort;
    const focused = model.getFocusedPath();
    let releaseDocuments: ((error?: unknown) => void) | undefined;
    let moveError: unknown;
    let changedPaths: string[] | undefined;
    try {
      await operationQueue.current;
      if (abort.signal.aborted) {
        return;
      }
      const args = {
        sources: planned.map((p) => join(base, p.from)),
        targetDirectory: event.target.directoryPath ? join(base, event.target.directoryPath) : base,
        expectedRoot: base,
      };
      const moves = await call<FileMove[]>("plan_file_moves", args);
      if (abort.signal.aborted || !moves.length) {
        return;
      }
      const names = moves.map((move) => basename(move.from));
      const destination = event.target.directoryPath?.replace(/\/$/, "") || basename(base);
      const choice = await ask(
        `Are you sure you want to move ${moves.length === 1 ? `'${names[0]}'` : `the following ${moves.length} files and folders`} into '${destination}'?`,
        "",
        ["Move", "Cancel"],
        {
          items: moves.map((move, index) =>
            names.filter((name) => name === names[index]).length > 1
              ? relative(move.from, base)
              : names[index],
          ),
          signal: abort.signal,
        },
      );
      if (choice !== "Move" || abort.signal.aborted) {
        return;
      }
      moveExecuting.current = true;
      releaseDocuments = await beginDocumentMove(moves);
      if (abort.signal.aborted) {
        return;
      }
      const report = await call<MoveReport>("move_files", args);
      changedPaths = report.moved.flatMap((move) => [
        relative(move.from, base),
        relative(move.to, base),
      ]);
      // Always rebind successful disk moves, including a partially failed batch.
      await renameDocuments(report.moved);
      if (!abort.signal.aborted && report.moved.length) {
        const operations = report.moved.map((move) => {
          const from = relative(move.from, base);
          const directory =
            model.getItem(from)?.isDirectory() ?? planned.some((p) => p.from === from + "/");
          return {
            type: "move" as const,
            from: from + (directory ? "/" : ""),
            to: relative(move.to, base) + (directory ? "/" : ""),
          };
        });
        pendingMoveSelection.current = operations.map((op) => op.to);
        model.batch(operations);
        revealPending.current = false;
      }
      if (report.failed.length) {
        moveError = new Error(report.failed.map((failure) => failure.message).join("\n"));
        notify(
          `Moved ${report.moved.length} item(s). The remaining items were not moved.\n${report.failed.map((f) => `${relative(f.path, base)}: ${f.message}`).join("\n")}`,
        );
      }
    } catch (e) {
      moveError = e;
      if (!abort.signal.aborted) {
        notify(errorMessage(e));
      }
    } finally {
      releaseDocuments?.(moveError);
      const executed = moveExecuting.current;
      moveExecuting.current = false;
      try {
        if (executed) {
          // Directory reads invalidated during the move run one follow-up.
          await refreshTree(changedPaths);
        } else if (!abort.signal.aborted && focused) {
          model.focusPath(focused);
          model
            .getFileTreeContainer()
            ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(focused)}"]`)
            ?.focus({ preventScroll: true });
        }
      } finally {
        moveBusy.current = false;
        if (moveAbort.current === abort) {
          moveAbort.current = null;
        }
      }
    }
  }
  function openTreeFile(event: Event, pinned = false) {
    // Rows live in the tree's shadow DOM; ignore rename inputs and empty space.
    const targets = event.composedPath();
    if (targets.some((target) => target instanceof HTMLInputElement)) {
      return false;
    }
    const row = targets.find(
      (target) => target instanceof HTMLElement && target.hasAttribute("data-item-path"),
    ) as HTMLElement | undefined;
    const path = row?.dataset.itemPath;
    const item = path ? model.getItem(path) : null;
    if (
      !path ||
      path === model.getCreatingPath() ||
      !item ||
      item.isDirectory() ||
      !rootRef.current
    ) {
      return false;
    }
    void openPath(join(rootRef.current, path), { pinned, preserveFocus: !pinned }).catch((e) =>
      notify(errorMessage(e)),
    );
    return true;
  }
  async function refreshExplorer() {
    const before = useApp.getState();
    if (!before.root) {
      return;
    }
    const request = { ready: false };
    manualRefresh.current = request;
    await refreshTree();
    const state = useApp.getState();
    if (manualRefresh.current !== request) {
      return;
    }
    // A failed scan leaves the snapshot untouched. Root changes cancel the request.
    if (
      state.root !== before.root ||
      state.treeRoot !== before.root ||
      workspaceDirectories()?.entry("").status === "failed"
    ) {
      manualRefresh.current = null;
      return;
    }
    request.ready = true;
    setRevealTarget(null);
    explicitReveal.current = null;
    setRefreshRequest((value) => value + 1);
  }
  useEffect(() => {
    model.cancelEditing();
    creation.current = null;
    manualRefresh.current = null;
    moveAbort.current?.abort();
    pasteAbort.current?.abort();
    setContext(null);
    draggedPaths.current = [];
    pendingMoveSelection.current = null;
    setRootDropTarget(false);
    setRevealTarget(null);
    return attachWorkspaceTree(model, () => {
      const moved = pendingMoveSelection.current?.flatMap(
        (path) => model.getItem(path)?.getPath() ?? [],
      );
      if (moved?.length && !moveExecuting.current) {
        pendingMoveSelection.current = null;
        revealPending.current = false;
        for (const selected of model.getSelectedPaths()) {
          model.getItem(selected)?.deselect();
        }
        for (const path of moved) {
          const parts = path.replace(/\/$/, "").split("/");
          for (let depth = 1; depth < parts.length; depth++) {
            const parent = model.getItem(parts.slice(0, depth).join("/"));
            if (parent && "expand" in parent) {
              parent.expand();
            }
          }
          model.getItem(path)?.select();
        }
        model.focusPath(moved[0]);
        model.scrollToPath(moved[0], { focus: false, offset: "nearest" });
      }
      setDirectoryVersion((version) => version + 1);
    });
  }, [model, root, workspaceEpoch]);
  useEffect(() => {
    model.setGitStatus(
      root && gitState.root && normalize(gitState.root) === normalize(root)
        ? gitState.git.flatMap(({ path, status }) =>
            status === "conflicted" ? [] : [{ path, status }],
          )
        : [],
    );
    model.setComposition(model.getComposition());
  }, [model, gitState, root]);
  useEffect(() => {
    const onReveal = (e: Event) => {
      const state = useApp.getState();
      explicitReveal.current = {
        path: (e as CustomEvent<string>).detail,
        group: state.activeGroup,
        activePath:
          state.docs[state.groups.find((g) => g.id === state.activeGroup)?.active ?? ""]?.path,
        request: state.tabRevealRequests[state.activeGroup] ?? 0,
      };
      setExplicitRequest((request) => request + 1);
    };
    window.addEventListener("reveal-tree", onReveal);
    return () => window.removeEventListener("reveal-tree", onReveal);
  }, []);
  const active = docs[groups.find((g) => g.id === activeGroup)?.active ?? ""];
  const structureVersion = workspaceDirectories()?.revision ?? 0;
  useEffect(() => {
    const path = explicitReveal.current?.path ?? active?.path;
    const base = root ? visiblePath(root).replace(/[\\/]+$/, "") : null;
    if (
      !path ||
      !base ||
      sidebar !== "explorer" ||
      !normalize(visiblePath(path)).startsWith(normalize(base) + "/")
    ) {
      return;
    }
    let cancelled = false;
    const cached = workspaceDirectories()?.cachedPath(relative(path, base));
    if (cached) {
      setRevealTarget({ path, canonical: cached, root: root! });
    }
    void ensureWorkspacePath(relative(path, base)).then((canonical) => {
      if (!cancelled) {
        setRevealTarget({ path, canonical, root: root! });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    active?.path,
    root,
    sidebar,
    expanded,
    explicitRequest,
    tabRevealRequest,
    refreshRequest,
    structureVersion,
    workspaceEpoch,
  ]);
  useEffect(() => {
    if (!moveExecuting.current && !pendingMoveSelection.current) {
      revealPending.current = true;
    }
  }, [activeGroup, active?.path, tabRevealRequest, root, sidebar]);
  useEffect(() => {
    if (moveExecuting.current || pendingMoveSelection.current) {
      return;
    }
    if (creation.current) {
      return;
    }
    const refreshed = manualRefresh.current?.ready === true;
    if (refreshed) {
      revealPending.current = true;
    }
    // A newer editor activation supersedes an explicit reveal waiting for tree data.
    const pending = explicitReveal.current;
    if (
      pending &&
      (pending.group !== activeGroup ||
        pending.activePath !== active?.path ||
        pending.request !== tabRevealRequest)
    ) {
      explicitReveal.current = null;
    }
    // Collapsing the workspace is a user action, not a request to reveal again.
    const collapsed = wasExpanded.current && !expanded;
    const reopened = !wasExpanded.current && expanded;
    wasExpanded.current = expanded;
    if (collapsed) {
      revealPending.current = false;
    }
    if (reopened) {
      revealPending.current = true;
    }
    if ((collapsed && !explicitReveal.current) || sidebar !== "explorer") {
      return;
    }
    if (!revealPending.current && !explicitReveal.current) {
      return;
    }
    if (treeRoot !== root) {
      return;
    }
    const focus = explicitReveal.current !== null;
    const path = explicitReveal.current?.path ?? active?.path;
    const base = root ? visiblePath(root).replace(/[\\/]+$/, "") : null;
    if (!path || !base || !normalize(visiblePath(path)).startsWith(normalize(base) + "/")) {
      if (refreshed) {
        manualRefresh.current = null;
      }
      explicitReveal.current = null;
      revealPending.current = false;
      return;
    }
    const canonicalPath =
      revealTarget?.path === path && revealTarget.root === root ? revealTarget.canonical : null;
    const item = canonicalPath ? model.getItem(canonicalPath) : null;
    // A newly opened file can precede the scan that first includes it.
    if (!item) {
      if (
        refreshed &&
        revealTarget?.path === path &&
        revealTarget.root === root &&
        revealTarget.canonical === null
      ) {
        manualRefresh.current = null;
        revealPending.current = false;
      }
      return;
    }
    if (item.isDirectory()) {
      if (refreshed) {
        manualRefresh.current = null;
      }
      explicitReveal.current = null;
      revealPending.current = false;
      return;
    }
    if (!expanded) {
      setExpanded(true);
      return;
    }
    const target = item.getPath();
    // Keep pointer/keyboard navigation in the tree stable; editor navigation reveals context.
    const navigatingTree =
      !focus &&
      document.activeElement === model.getFileTreeContainer() &&
      model.getFocusedPath() === target;
    const parts = target.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = model.getItem(parts.slice(0, depth).join("/"));
      if (parent && "expand" in parent) {
        parent.expand();
      }
    }
    for (const selected of model.getSelectedPaths()) {
      if (selected !== target) {
        model.getItem(selected)?.deselect();
      }
    }
    item.select();
    model.focusPath(target);
    model.scrollToPath(target, { focus: false, offset: navigatingTree ? "nearest" : "center" });
    if (refreshed) {
      manualRefresh.current = null;
    }
    explicitReveal.current = null;
    revealPending.current = false;
    if (focus) {
      // Automatic reveals retain DOM focus; explicit reveals transfer it after rendering.
      const frame = requestAnimationFrame(() => {
        model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(target)}"]`)
          ?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [
    model,
    activeGroup,
    active?.path,
    tabRevealRequest,
    root,
    treeRoot,
    sidebar,
    directoryVersion,
    revealTarget,
    expanded,
    explicitRequest,
    refreshRequest,
  ]);

  async function action(
    kind: string,
    path = model.getSelectedPaths().length ? (model.getFocusedPath() ?? "") : "",
  ) {
    if (!root) {
      return;
    }
    const selected = model.getSelectedPaths();
    const paths = (selected.includes(path) ? [...selected] : [path]).filter(
      (candidate) => candidate !== model.getCreatingPath(),
    );
    const full = join(root, path);
    const changedPaths: string[] = [];
    context?.close?.({ restoreFocus: !["rename", "newFile", "newFolder"].includes(kind) });
    setContext(null);
    if (kind === "newFile" || kind === "newFolder") {
      await startCreation(kind, path);
      return;
    }
    if (path === model.getCreatingPath()) {
      return;
    }
    try {
      if (kind === "rename") {
        model.startRenaming(path);
        return;
      }
      if (kind === "copy" || kind === "cut") {
        const items = paths.filter(Boolean);
        if (items.length) {
          await clipboardRef.current!.remember(
            items.map((p) => join(root, p)),
            kind === "cut",
          );
        }
        return;
      }
      if (kind === "fullPath" || kind === "relativePath") {
        const text = paths
          .map((p) => (kind === "fullPath" ? join(root, p).replace(/\//g, "\\") : p))
          .join("\r\n");
        if (desktop) {
          await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
        } else {
          await navigator.clipboard.writeText(text);
        }
        return;
      }
      if (kind === "reveal") {
        await call("reveal_path", { path: full });
        return;
      }
      if (kind === "delete") {
        const filtered = paths.filter(
          (p) =>
            !paths.some((parent) => parent !== p && p.startsWith(parent.replace(/\/$/, "") + "/")),
        );
        await deleteInternalFiles(
          filtered.map((path) => join(root, path)),
          (path) => changedPaths.push(relative(path, root)),
        );
      }
      if (kind === "paste") {
        await paste(path);
        return;
      }
      await refreshTree(changedPaths);
    } catch (e) {
      notify(errorMessage(e));
      await refreshTree(changedPaths.length ? changedPaths : undefined);
    }
  }
  const directoryWarnings = [...(workspaceDirectories()?.directories.values() ?? [])].flatMap(
    (entry) => entry.warnings,
  );
  const treeStyle = {
    flex: 1,
    minHeight: 0,
    // Included in the virtual layout by tools/patch-trees-scroll.mjs.
    "--trees-scroll-padding-bottom": "32px",
    "--trees-scrollbar-gutter-override": "12px",
    ...themeToTreeStyles(treeTheme),
    "--trees-font-family-override": '"Segoe UI", sans-serif',
    "--trees-font-size-override": "15px",
    "--trees-icon-width-override": "18px",
    "--trees-item-row-gap-override": "5px",
    "--trees-padding-inline-override": "0px",
    "--trees-git-ignored-color-override": "var(--git-ignored-foreground)",
  };
  return (
    <section
      className={`explorer ${workbenchStyles["explorer"]} view flex flex-col h-full min-h-0 overflow-hidden`}
      aria-label="Explorer"
      tabIndex={-1}
      onContextMenu={rootContext}
      onKeyDown={(event) => {
        if (!event.defaultPrevented) {
          clipboardKey(event, "");
        }
      }}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !isEditableTreeEvent(event.nativeEvent) &&
          !event.nativeEvent
            .composedPath()
            .some(
              (target) => target instanceof HTMLElement && target.hasAttribute("data-item-path"),
            ) &&
          !(event.target instanceof Element && event.target.closest('button, [role="menuitem"]'))
        ) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
    >
      {!root ? (
        <div
          className={`empty-sidebar py-2 px-5 leading-[1.5] ${workbenchStyles["empty-sidebar"]}`}
        >
          <p>You have not yet opened a folder.</p>
          <button
            className={`primary bg-focus text-foreground-strong rounded-[2px] py-[5px] px-[14px] ${workbenchStyles["primary"]}`}
            onClick={openFolder}
          >
            Open Folder
          </button>
          <p className="muted text-muted">
            Opening a folder enables file browsing and workspace search.
          </p>
        </div>
      ) : (
        <>
          <div
            className={`section-heading h-8 min-h-8 flex items-center justify-between text-[11px] font-bold overflow-hidden ${workbenchStyles["section-heading"]}`}
            data-drop-target={rootDropTarget}
            onDragOver={(e) => {
              if (!draggedPaths.current.length || moveBusy.current) {
                return;
              }
              e.preventDefault();
              const allowed = !!treeMovePlan(draggedPaths.current, null)?.length;
              e.dataTransfer.dropEffect = allowed ? "move" : "none";
              setRootDropTarget(allowed);
            }}
            onDragLeave={() => setRootDropTarget(false)}
            onDrop={(e) => {
              e.preventDefault();
              setRootDropTarget(false);
              if (draggedPaths.current.length) {
                void requestMove({
                  draggedPaths: draggedPaths.current,
                  target: {
                    kind: "root",
                    directoryPath: null,
                    hoveredPath: null,
                    flattenedSegmentPath: null,
                  },
                });
              }
              draggedPaths.current = [];
            }}
          >
            <button
              title={pathTitle(root)}
              onPointerDown={() => {
                model.cancelEditing();
                creation.current = null;
              }}
              onClick={() => {
                model.cancelEditing();
                creation.current = null;
                setExpanded(!expanded);
              }}
              aria-expanded={expanded}
            >
              <Icon name={expanded ? "chevron-down" : "chevron-right"} />
              {basename(root).toUpperCase()}
            </button>
            <div className="actions flex items-center gap-[2px] shrink-0">
              <IconButton
                icon="new-file"
                label="New File"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void action("newFile")}
              />
              <IconButton
                icon="new-folder"
                label="New Folder"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void action("newFolder")}
              />
              <IconButton
                icon="refresh"
                label="Refresh Explorer"
                onClick={() => void refreshExplorer()}
              />
              <IconButton
                icon="collapse-all"
                label="Collapse Folders"
                onClick={() =>
                  loadedWorkspacePaths()
                    .filter((p) => p.endsWith("/"))
                    .forEach((p) => {
                      const i = model.getItem(p.slice(0, -1));
                      if (i && "collapse" in i) {
                        i.collapse();
                      }
                    })
                }
              />
            </div>
          </div>
          {expanded && (
            <FileTree
              model={model}
              className={`file-tree block w-full overflow-hidden ${workbenchStyles["file-tree"]}`}
              style={treeStyle}
              onDragStart={(e) => {
                if (e.defaultPrevented || !rootRef.current || !draggedPaths.current.length) {
                  return;
                }
                e.dataTransfer.setData(
                  explorerDragType,
                  JSON.stringify({ root: rootRef.current, paths: draggedPaths.current }),
                );
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragEnd={() => {
                draggedPaths.current = [];
                setRootDropTarget(false);
              }}
              onPointerMove={(e) => {
                // Tree rows are virtualized inside a shadow root; resolve the current row on hover.
                const row = e.nativeEvent
                  .composedPath()
                  .find(
                    (target) =>
                      target instanceof HTMLElement && target.hasAttribute("data-item-path"),
                  ) as HTMLElement | undefined;
                if (row?.dataset.itemPath && row.dataset.fileTreeEditing !== "true") {
                  row.title = pathTitle(join(root, row.dataset.itemPath));
                }
              }}
              onClick={(e) => {
                if (e.detail === 2 || e.ctrlKey || e.metaKey || e.shiftKey) {
                  return;
                }
                if (
                  e.detail !== 0 &&
                  useApp.getState().settings["workbench.list.openMode"] === "doubleClick"
                ) {
                  return;
                }
                openTreeFile(e.nativeEvent);
              }}
              onDoubleClick={(e) => {
                openTreeFile(e.nativeEvent, true);
              }}
              onKeyDown={(e) => {
                if (isEditableTreeEvent(e.nativeEvent)) {
                  return;
                }
                if (clipboardKey(e, model.getFocusedPath() ?? "")) {
                  return;
                }
                if (e.key === "Enter" && openTreeFile(e.nativeEvent, true)) {
                  e.preventDefault();
                } else if (e.key === "F2") {
                  e.preventDefault();
                  model.startRenaming();
                } else if (e.key === "Delete") {
                  e.preventDefault();
                  void action("delete");
                }
              }}
            />
          )}
          {workspaceDirectories()?.directories.get("")?.status === "failed" && (
            <button
              className={`inline-warning py-[5px] px-[18px] leading-[18px] m-0 text-[12px] text-warning ${workbenchStyles["inline-warning"]}`}
              onClick={() => void refreshExplorer()}
            >
              {workspaceDirectories()?.directories.get("")?.error} — Retry
            </button>
          )}
          {directoryWarnings.length > 0 && (
            <button
              className={`inline-warning py-[5px] px-[18px] leading-[18px] m-0 text-[12px] text-warning ${workbenchStyles["inline-warning"]}`}
              onClick={() => notify(directoryWarnings.join("\n"))}
            >
              {directoryWarnings.length} directory warning(s)
            </button>
          )}
          {gitState.warnings.length > 0 && (
            <button
              className={`inline-warning py-[5px] px-[18px] leading-[18px] m-0 text-[12px] text-warning ${workbenchStyles["inline-warning"]}`}
              onClick={() => notify(gitState.warnings.join("\n"))}
            >
              {gitState.warnings.length} Git warning(s)
            </button>
          )}
        </>
      )}
      <Menu.Root
        open={!!context}
        onOpenChange={(open) => {
          if (!open) {
            context?.close?.();
            setContext(null);
          }
        }}
      >
        <Menu.Portal>
          <Menu.Positioner className="z-90" anchor={context?.anchor} side="right" align="start">
            <Menu.Popup
              className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[210px] z-[90] ${workbenchStyles["context-menu"]}`}
              data-file-tree-context-menu-root="true"
            >
              {[
                ["newFile", "New File…"],
                ["newFolder", "New Folder…"],
                ["reveal", "Reveal in File Explorer"],
                ["cut", "Cut"],
                ["copy", "Copy"],
                ["paste", "Paste"],
                ["fullPath", "Copy Path"],
                ["relativePath", "Copy Relative Path"],
                ["rename", "Rename…"],
                ["delete", "Delete"],
              ].map(([kind, label]) => (
                <Menu.Item
                  key={kind}
                  disabled={
                    !context?.path && ["cut", "copy", "rename", "delete", "reveal"].includes(kind)
                  }
                  onClick={() => void action(kind, context?.path ?? "")}
                >
                  {label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </section>
  );
}
