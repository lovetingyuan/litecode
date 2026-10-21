import {
  useEffect,
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
import { ask, input } from "./dialog";
import { Icon, IconButton } from "./ui";
import { refreshTree, attachWorkspaceTree, directoryDecoration, ensureWorkspacePath, loadedWorkspacePaths, workspaceDirectories } from "../explorer/workspaceTree";
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
  const [revealTarget, setRevealTarget] = useState<{ path: string; canonical: string | null; root: string } | null>(null);
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
    renderRowDecoration: ({ row }) => row.kind === "directory" ? directoryDecoration(row.path) : null,
    unsafeCSS: `
      ${sidebarScrollbarCSS}
      [data-file-tree-sticky-overlay-content]{box-shadow:0 3px 3px -3px #000}
      svg[data-icon-name]{width:var(--trees-icon-width);height:var(--trees-icon-width)}
      [data-item-section="git"] [data-icon-name="file-tree-icon-dot"]{transform:none}
      [data-file-tree-root-drag-target="true"] > [data-file-tree-virtualized-scroll]{outline:1px solid #0078d4;outline-offset:-1px;background:#04395e44}
      [data-external-drop="true"]{outline:1px solid var(--trees-focus-border,#0078d4);outline-offset:-1px;background:var(--trees-list-active-selection-background,#04395e)}
      /* Keep each level at 14px and its guide centered under the parent icon. */
      [data-item-section="spacing"]{padding-left:0;margin-right:calc(-1 * var(--trees-item-row-gap))}
      [data-item-section="spacing"] > [data-item-section="spacing-item"]{
        width:14px;box-sizing:border-box;flex-shrink:0;margin:0;
        transform:translateX(calc(var(--trees-icon-width) / 2 - .5px));
      }
    `,
    renaming: { onRename: (e) => mutate(e.sourcePath, e.destinationPath), onError: notify },
    dragAndDrop: {
      canDrag: (paths) => {
        if (moveBusy.current || !rootRef.current) {
          return false;
        }
        draggedPaths.current = paths;
        return true;
      },
      canDrop: (e) =>
        !moveBusy.current && !!treeMovePlan(e.draggedPaths, e.target.directoryPath)?.length,
      onDropRequest: (e) => {
        void requestMove(e);
      },
      onDropError: notify,
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "right-click",
        onOpen: (item, context) =>
          setContext({
            path: item.path,
            anchor: context.anchorElement,
            close: (options) => context.close(options),
          }),
        onClose: () => setContext(null),
      },
    },
  });
  const rootRef = useRef(root);
  rootRef.current = root;
  const clipboardRef = useRef<ReturnType<typeof createExplorerClipboard> | null>(null);
  if (!clipboardRef.current) {
    clipboardRef.current = createExplorerClipboard({
      read: () =>
        desktop
          ? call<FileClipboard>("read_file_clipboard")
          : Promise.resolve({ sequence: null, paths: [] }),
      confirm: async (paths, directory, signal) =>
        (await ask(
          `Copy ${paths.length === 1 ? `'${basename(paths[0])}'` : `the following ${paths.length} files and folders`} into '${basename(directory)}'?`,
          pathTitle(directory),
          ["Copy", "Cancel"],
          { items: paths.map(pathTitle), itemsLabel: "Items to copy", signal },
        )) === "Copy",
      copyExternal: async (expectedSequence, expectedRoot, targetDirectory) => {
        moveExecuting.current = true;
        return call<CopyReport>("paste_file_clipboard", {
          expectedSequence,
          expectedRoot,
          targetDirectory,
        });
      },
      pasteInternal: async (source, destination, cut) => {
        moveExecuting.current = true;
        await call("file_operation", {
          operation: { kind: cut ? "rename" : "copy", path: source, destination },
        });
        if (cut) {
          await renameDocumentPaths(source, destination);
        }
      },
    });
  }
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
        changedPaths = report.copied.flatMap((item) => [relative(item.to, base), ...(normalize(item.from).startsWith(normalize(base).replace(/\/$/, "") + "/") ? [relative(item.from, base)] : [])]);
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
    let releaseDocuments: (() => void) | undefined;
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
      releaseDocuments = await beginDocumentMove(moves.map((move) => move.from));
      if (abort.signal.aborted) {
        return;
      }
      const report = await call<MoveReport>("move_files", args);
      changedPaths = report.moved.flatMap((move) => [relative(move.from, base), relative(move.to, base)]);
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
        notify(
          `Moved ${report.moved.length} item(s). The remaining items were not moved.\n${report.failed.map((f) => `${relative(f.path, base)}: ${f.message}`).join("\n")}`,
        );
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        notify(errorMessage(e));
      }
    } finally {
      releaseDocuments?.();
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
    if (!path || !item || item.isDirectory() || !rootRef.current) {
      return false;
    }
    void openPath(join(rootRef.current, path), { pinned, preserveFocus: !pinned }).catch((e) =>
      notify(errorMessage(e)),
    );
    return true;
  }
  function mutate(from: string, to: string) {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    operationQueue.current = operationQueue.current.then(async () => {
      try {
        await call("file_operation", {
          operation: { kind: "rename", path: join(root, from), destination: join(root, to) },
        });
        await renameDocumentPaths(join(root, from), join(root, to));
      } catch (e) {
        notify(errorMessage(e));
      }
      await refreshTree([from, to]);
    });
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
    if (state.root !== before.root || state.treeRoot !== before.root || workspaceDirectories()?.entry("").status === "failed") {
      manualRefresh.current = null;
      return;
    }
    request.ready = true;
    setRevealTarget(null);
    explicitReveal.current = null;
    setRefreshRequest((value) => value + 1);
  }
  useEffect(() => {
    manualRefresh.current = null;
    moveAbort.current?.abort();
    pasteAbort.current?.abort();
    setContext(null);
    draggedPaths.current = [];
    pendingMoveSelection.current = null;
    setRootDropTarget(false);
    setRevealTarget(null);
    return attachWorkspaceTree(model, () => {
      const moved = pendingMoveSelection.current?.flatMap((path) => model.getItem(path)?.getPath() ?? []);
      if (moved?.length && !moveExecuting.current) {
        pendingMoveSelection.current = null;
        revealPending.current = false;
        for (const selected of model.getSelectedPaths()) {model.getItem(selected)?.deselect();}
        for (const path of moved) {
          const parts = path.replace(/\/$/, "").split("/");
          for (let depth = 1; depth < parts.length; depth++) {
            const parent = model.getItem(parts.slice(0, depth).join("/"));
            if (parent && "expand" in parent) {parent.expand();}
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
        ? gitState.git.map((g) => ({ ...g, status: g.status === "conflicted" ? "modified" : g.status }))
        : [],
    );
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
    if (!path || !base || sidebar !== "explorer" || !normalize(visiblePath(path)).startsWith(normalize(base) + "/")) {return;}
    let cancelled = false;
    const cached = workspaceDirectories()?.cachedPath(relative(path, base));
    if (cached) { setRevealTarget({ path, canonical: cached, root: root! }); }
    void ensureWorkspacePath(relative(path, base)).then((canonical) => {
      if (!cancelled) {setRevealTarget({ path, canonical, root: root! });}
    });
    return () => { cancelled = true; };
  }, [active?.path, root, sidebar, expanded, explicitRequest, tabRevealRequest, refreshRequest, structureVersion, workspaceEpoch]);
  useEffect(() => {
    if (!moveExecuting.current && !pendingMoveSelection.current) {
      revealPending.current = true;
    }
  }, [activeGroup, active?.path, tabRevealRequest, root, sidebar]);
  useEffect(() => {
    if (moveExecuting.current || pendingMoveSelection.current) {
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
    const canonicalPath = revealTarget?.path === path && revealTarget.root === root ? revealTarget.canonical : null;
    const item = canonicalPath ? model.getItem(canonicalPath) : null;
    // A newly opened file can precede the scan that first includes it.
    if (!item) {
      if (refreshed && revealTarget?.path === path && revealTarget.root === root && revealTarget.canonical === null) {
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

  async function action(kind: string, path = model.getFocusedPath() ?? "") {
    if (!root) {
      return;
    }
    const handle = model.getItem(path);
    const selected = model.getSelectedPaths();
    const paths = selected.includes(path) ? [...selected] : [path];
    const full = join(root, path);
    const changedPaths: string[] = [];
    context?.close?.({ restoreFocus: kind !== "rename" });
    setContext(null);
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
      if (kind === "newFile" || kind === "newFolder") {
        const name = await input(kind === "newFile" ? "New File" : "New Folder");
        if (!name) {
          return;
        }
        const parent = handle?.isDirectory()
          ? path.replace(/\/$/, "")
          : path.split("/").slice(0, -1).join("/");
        const target = join(root, parent ? `${parent}/${name}` : name);
        await call("file_operation", { operation: { kind, path: target } });
        changedPaths.push(relative(target, root));
        if (kind === "newFile") {
          await openPath(target, { pinned: true });
        }
      }
      if (kind === "delete") {
        if (
          (await ask("Move to Recycle Bin?", paths.join("\n"), [
            "Move to Recycle Bin",
            "Cancel",
          ])) !== "Move to Recycle Bin"
        ) {
          return;
        }
        const filtered = paths.filter(
          (p) =>
            !paths.some((parent) => parent !== p && p.startsWith(parent.replace(/\/$/, "") + "/")),
        );
        for (const path of filtered) {
          await call("file_operation", { operation: { kind: "delete", path: join(root, path) } });
          changedPaths.push(path);
        }
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
  const directoryWarnings = [...(workspaceDirectories()?.directories.values() ?? [])].flatMap((entry) => entry.warnings);
  const treeStyle = {
    flex: 1,
    minHeight: 0,
    // Included in the virtual layout by tools/patch-trees-scroll.mjs.
    "--trees-scroll-padding-bottom": "32px",
    "--trees-scrollbar-gutter-override": "12px",
    ...themeToTreeStyles({
      colors: {
        "sideBar.background": "#181818",
        "sideBar.foreground": "#cccccc",
        "list.activeSelectionBackground": "#04395e",
        "list.activeSelectionForeground": "#ffffff",
        "list.inactiveSelectionBackground": "#37373d",
        "list.hoverBackground": "#2a2d2e",
        focusBorder: "#0078d4",
        "gitDecoration.modifiedResourceForeground": "#e2c08d",
        "gitDecoration.untrackedResourceForeground": "#73c991",
      },
    }),
    "--trees-font-family-override": '"Segoe UI", sans-serif',
    "--trees-font-size-override": "15px",
    "--trees-icon-width-override": "18px",
    "--trees-item-row-gap-override": "5px",
    "--trees-padding-inline-override": "0px",
    "--trees-git-ignored-color-override": "var(--git-ignored-foreground)",
  };
  return (
    <section
      className="explorer view"
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
        <div className="empty-sidebar">
          <p>You have not yet opened a folder.</p>
          <button className="primary" onClick={openFolder}>
            Open Folder
          </button>
          <p className="muted">Opening a folder enables file browsing and workspace search.</p>
        </div>
      ) : (
        <>
          <div
            className="section-heading"
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
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              <Icon name={expanded ? "chevron-down" : "chevron-right"} />
              {basename(root).toUpperCase()}
            </button>
            <div className="actions">
              <IconButton icon="new-file" label="New File" onClick={() => void action("newFile")} />
              <IconButton
                icon="new-folder"
                label="New Folder"
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
              className="file-tree"
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
                if (row?.dataset.itemPath) {
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
            <button className="inline-warning" onClick={() => void refreshExplorer()}>
              {workspaceDirectories()?.directories.get("")?.error} — Retry
            </button>
          )}
          {directoryWarnings.length > 0 && (
            <button className="inline-warning" onClick={() => notify(directoryWarnings.join("\n"))}>
              {directoryWarnings.length} directory warning(s)
            </button>
          )}
          {gitState.warnings.length > 0 && (
            <button className="inline-warning" onClick={() => notify(gitState.warnings.join("\n"))}>
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
            <Menu.Popup className="context-menu" data-file-tree-context-menu-root="true">
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
