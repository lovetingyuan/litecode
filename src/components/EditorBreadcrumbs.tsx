import { treeTheme } from "../styles/theme";
import workbenchStyles from "../styles/workbench.module.css";
import editorBreadcrumbsStyles from "./EditorBreadcrumbs.module.css";
import mediaPreviewStyles from "./MediaPreview.module.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Popover } from "@base-ui/react/popover";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { themeToTreeStyles } from "@pierre/trees";
import { useApp, notify } from "../store/store";
import { errorMessage } from "../core/bridge";
import { join, normalize, openPath, pathTitle } from "../editor/documents";
import { workspaceDirectories } from "../explorer/workspaceTree";
import { attachBreadcrumbTree, breadcrumbSegments } from "../explorer/breadcrumbTree";
import { isMarkdownDocument } from "../utils/media";
import { settingValue } from "../utils/settings";
import type { Doc, Group } from "../types/types";
import { EditorViewMenu } from "./MediaStatus";
import { FileIcon, Icon } from "./ui";
import scrollbarCSS from "../styles/sidebar-scrollbar.css?raw";
import { gitConflictDecoration } from "../utils/gitStatus";

export function EditorBreadcrumbs({ doc, group }: { doc: Doc; group: Group }) {
  const root = useApp((state) => state.root);
  const epoch = useApp((state) => state.workspaceEpoch);
  const activeGroup = useApp((state) => state.activeGroup);
  const enabled = useApp((state) => settingValue(state.settings, "breadcrumbs.enabled") as boolean);
  const [selected, setSelected] = useState<string | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    setSelected(null);
  }, [doc.id, doc.path, root, epoch, activeGroup, enabled]);
  const segments = breadcrumbSegments(doc.path ?? undefined, doc.name, root);
  if (!enabled && doc.kind !== "svg" && !isMarkdownDocument(doc)) {
    return null;
  }
  return (
    <div
      className={`breadcrumbs h-[22px] min-h-[22px] py-0 px-[10px] flex items-center overflow-hidden whitespace-nowrap z-[1] ${workbenchStyles["breadcrumbs"]} ${editorBreadcrumbsStyles["breadcrumbs"]} ${mediaPreviewStyles["breadcrumbs"]}`}
    >
      {enabled && (
        <nav
          className={`breadcrumbs-path flex items-center min-w-0 overflow-hidden flex-1 ${mediaPreviewStyles["breadcrumbs-path"]}`}
          aria-label="File breadcrumbs"
        >
          {segments.map((segment, index) => {
            const deleted = !!doc.deleted && index === segments.length - 1;
            const content = (
              <>
                {index === segments.length - 1 && <FileIcon language={doc.language} />}
                <span
                  className={
                    deleted ? "deleted-file-name text-git-ignored line-through" : undefined
                  }
                >
                  {segment.label}
                </span>
              </>
            );
            const title = `${pathTitle(segment.path)}${deleted ? "\n文件已从磁盘删除" : ""}`;
            const path = segment.workspacePath;
            return (
              <span key={segment.path}>
                {path === undefined ? (
                  <span
                    className="breadcrumb-label inline-flex items-center gap-[5px] py-0 px-[2px] text-subtle"
                    title={title}
                  >
                    {content}
                  </span>
                ) : (
                  <Popover.Root
                    open={selected === path && activeGroup === group.id}
                    onOpenChange={(open, details) => {
                      restoreFocus.current = !open && details.reason === "escape-key";
                      if (open) {
                        setSelected(path);
                      } else {
                        setSelected((current) => (current === path ? null : current));
                      }
                    }}
                  >
                    <Popover.Trigger
                      title={title}
                      aria-label={`Browse siblings of ${segment.label}${deleted ? ", 文件已从磁盘删除" : ""}`}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          restoreFocus.current = false;
                          setSelected(path);
                        }
                      }}
                    >
                      {content}
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Positioner
                        className="breadcrumb-positioner z-[90] max-w-[calc(100vw_-_16px)]"
                        side="bottom"
                        align="start"
                        sideOffset={2}
                        collisionPadding={8}
                      >
                        <Popover.Popup
                          className={`breadcrumb-popup w-90 max-w-[var(--available-width)] max-h-[min(400px,_var(--available-height))] overflow-hidden bg-widget text-foreground border border-strong rounded-[3px] outline-none flex ${editorBreadcrumbsStyles["breadcrumb-popup"]}`}
                          aria-label={`Files alongside ${segment.label}`}
                          initialFocus={false}
                          finalFocus={() => restoreFocus.current}
                        >
                          {selected === path && (
                            <BreadcrumbPicker
                              key={`${epoch}:${doc.id}:${path}`}
                              target={path}
                              groupId={group.id}
                              close={() => {
                                restoreFocus.current = false;
                                setSelected(null);
                              }}
                            />
                          )}
                        </Popover.Popup>
                      </Popover.Positioner>
                    </Popover.Portal>
                  </Popover.Root>
                )}
                {index < segments.length - 1 && <Icon name="chevron-right" />}
              </span>
            );
          })}
        </nav>
      )}
      {(doc.kind === "svg" || isMarkdownDocument(doc)) && (
        <EditorViewMenu doc={doc} group={group} />
      )}
    </div>
  );
}

function BreadcrumbPicker({
  target,
  groupId,
  close,
}: {
  target: string;
  groupId: string;
  close: () => void;
}) {
  const git = useApp((state) => state.gitState);
  const fileVersion = useApp((state) => state.fileIndexVersion);
  const cache = workspaceDirectories();
  const adapter = useRef<ReturnType<typeof attachBreadcrumbTree> | null>(null);
  const [, setVersion] = useState(0);
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 0,
    flattenEmptyDirectories: false,
    itemHeight: 26,
    overscan: 5,
    stickyFolders: false,
    icons: { set: "complete", colored: true },
    search: false,
    renaming: false,
    dragAndDrop: false,
    renderRowDecoration: ({ row }) => {
      if (row.kind !== "directory") {
        const state = useApp.getState();
        const tree = adapter.current;
        return state.root && tree
          ? gitConflictDecoration(
              join(state.root, tree.toWorkspacePath(row.path)),
              state.root,
              state.gitState.root,
              state.gitState.git,
            )
          : null;
      }
      const state = adapter.current?.state(row.path);
      if (state?.status === "loading") {
        return { text: "…", title: "Loading directory" };
      }
      if (state?.status === "failed") {
        return { text: "!", title: `${state.error}. Collapse and expand to retry.` };
      }
      if (state?.status === "loaded" && !state.paths.length) {
        return { text: "Empty", title: "Empty directory" };
      }
      return null;
    },
    unsafeCSS: `${scrollbarCSS}
      svg[data-icon-name]{width:var(--trees-icon-width);height:var(--trees-icon-width)}
      [data-item-section="git"] [data-icon-name="file-tree-icon-dot"]{transform:none}
      [data-item-section="spacing"]{padding-left:0;margin-right:calc(-1 * var(--trees-item-row-gap))}
      [data-item-section="spacing"] > [data-item-section="spacing-item"]{width:14px;box-sizing:border-box;flex-shrink:0;margin:0;transform:translateX(calc(var(--trees-icon-width) / 2 - .5px))}
    `,
  });
  useEffect(() => {
    if (!cache) {
      return;
    }
    const tree = attachBreadcrumbTree(model, cache, target, () =>
      setVersion((version) => version + 1),
    );
    adapter.current = tree;
    let frame = 0;
    void tree.initialized.then(() => {
      if (adapter.current !== tree || cache.disposed) {
        return;
      }
      frame = requestAnimationFrame(() => {
        if (adapter.current !== tree) {
          return;
        }
        model
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLElement>('[data-item-path][tabindex="0"]')
          ?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      tree.dispose();
      adapter.current = null;
    };
  }, [cache, model, target]);
  useEffect(() => {
    adapter.current?.refresh();
  }, [fileVersion]);
  useEffect(() => {
    const tree = adapter.current;
    model.setGitStatus(
      cache &&
        git.root &&
        normalize(git.root) === normalize(cache.root) &&
        (cache.session === null || git.session === cache.session) &&
        tree
        ? git.git.flatMap((entry) => {
            const localRoot = tree.toWorkspacePath("");
            return entry.status !== "conflicted" &&
              entry.path.toLowerCase().startsWith(localRoot.toLowerCase())
              ? [{ path: entry.path.slice(localRoot.length), status: entry.status }]
              : [];
          })
        : [],
    );
    model.setComposition(model.getComposition());
  }, [model, cache, git, target]);
  function open(path: string | null, pinned: boolean) {
    const tree = adapter.current;
    if (
      !path ||
      !tree ||
      !cache ||
      cache.disposed ||
      !model.getItem(path) ||
      model.getItem(path)?.isDirectory()
    ) {
      return;
    }
    const state = useApp.getState();
    if (state.root !== cache.root || !state.groups.some((group) => group.id === groupId)) {
      return;
    }
    const full = join(cache.root, tree.toWorkspacePath(path));
    close();
    void openPath(full, { group: groupId, pinned }).catch((error) => notify(errorMessage(error)));
  }
  const state = adapter.current?.state();
  const busy = !state || state.status === "unloaded" || state.status === "loading";
  const style: CSSProperties = {
    height: Math.max(26, Math.min(390, model.getVisibleCount() * 26)),
    ...themeToTreeStyles(treeTheme),
    "--trees-bg-override": "var(--lc-widget)",
    "--trees-font-family-override": '"Segoe UI", sans-serif',
    "--trees-font-size-override": "13px",
    "--trees-icon-width-override": "18px",
    "--trees-item-row-gap-override": "5px",
    "--trees-padding-inline-override": "0px",
    "--trees-git-ignored-color-override": "var(--git-ignored-foreground)",
  } as CSSProperties;
  return (
    <div className="breadcrumb-picker flex flex-col w-full min-h-0 py-[3px] px-0" aria-busy={busy}>
      <FileTree
        model={model}
        className="breadcrumb-tree shrink min-h-0 w-full"
        style={style}
        aria-label="Sibling files and folders"
        onClickCapture={(event) => {
          // The tree's built-in Ctrl/Shift gestures allow multiple selection.
          if (event.ctrlKey || event.metaKey || event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onClick={(event) => {
          const row = event.nativeEvent
            .composedPath()
            .find(
              (target) => target instanceof HTMLElement && target.hasAttribute("data-item-path"),
            ) as HTMLElement | undefined;
          if (row?.dataset.itemPath) {
            open(row.dataset.itemPath, false);
          }
        }}
        onKeyDownCapture={(event) => {
          if ((event.ctrlKey || event.metaKey || event.shiftKey) && event.key !== "Tab") {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.key.length === 1 && event.key !== " ") {
            event.preventDefault();
            event.stopPropagation();
          }
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const item = model.getFocusedItem();
          if (item && "toggle" in item) {
            item.toggle();
          } else {
            open(model.getFocusedPath(), true);
          }
        }}
      />
      {busy && (
        <div
          className={`breadcrumb-message py-[6px] px-[10px] text-[13px] ${editorBreadcrumbsStyles["breadcrumb-message"]}`}
          role="status"
        >
          Loading directory…
        </div>
      )}
      {state?.status === "failed" && (
        <div
          className={`breadcrumb-message py-[6px] px-[10px] text-[13px] ${editorBreadcrumbsStyles["breadcrumb-message"]}`}
          role="alert"
        >
          {state.error}
          <button onClick={() => adapter.current?.retry()}>Retry</button>
        </div>
      )}
      {state?.status === "loaded" && !state.paths.length && (
        <div
          className={`breadcrumb-message py-[6px] px-[10px] text-[13px] ${editorBreadcrumbsStyles["breadcrumb-message"]}`}
          role="status"
        >
          Empty directory
        </div>
      )}
    </div>
  );
}
