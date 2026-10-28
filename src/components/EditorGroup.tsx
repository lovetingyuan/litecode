import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useApp, setApp, notify } from "../store/store";
import { monaco } from "../editor/monaco";
import { editorOptions } from "../editor/settings";
import { installMergeConflictEditor, navigateInlineConflict } from "../editor/mergeConflictEditor";
import {
  models,
  editors,
  closeDocument,
  closeGroup,
  showDocument,
  keepOpen,
  addHistory,
  moveTab,
  splitGroup,
  compareDisk,
  patchDoc,
  saveEditorView,
  openPath,
  checkpoint,
  autoSave,
  pathTitle,
  setSticky,
  focusDocument,
  join,
  newDocument,
} from "../editor/documents";
import { Menu } from "@base-ui/react/menu";
import { splitDirections } from "../core/commands";
import { errorMessage, call, channel } from "../core/bridge";
import { FileIcon, Icon, IconButton } from "./ui";
export { FileIcon } from "./ui";
import { createSearchEditor } from "../search/search";
import { EditorTabMenu } from "./EditorTabMenu";
import type { Group, Query, SearchMatch } from "../types/types";
import { isGitConflicted, isGitIgnored } from "../utils/gitStatus";
import { isMarkdownView, isTextView } from "../utils/media";
import { MediaPreview } from "./MediaPreview";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { MarkdownPreview } from "./MarkdownPreview";
import { GitDiffEditor } from "./GitDiffEditor";
import { loadedWorkspacePaths } from "../explorer/workspaceTree";
import { explorerDragFiles, explorerDragType } from "../explorer/explorerDrag";

export function EditorGroup({ group }: { group: Group }) {
  const docs = useApp((s) => s.docs);
  const activeGroup = useApp((s) => s.activeGroup);
  const settings = useApp((s) => s.settings);
  const root = useApp((s) => s.root);
  const treeRoot = useApp((s) => s.treeRoot);
  const git = useApp((s) => s.gitState.git);
  const multipleGroups = useApp((s) => s.groups.length > 1);
  const [mergeConflictCount, setMergeConflictCount] = useState(0);
  const splitDown = settings["workbench.editor.openSideBySideDirection"] === "down";
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const previous = useRef<string | null>(null);
  const doc = group.active ? docs[group.active] : undefined;
  const textView = !!doc && isTextView(doc, group);
  const gitDiff = !!doc?.gitDiff;
  const previousTextView = useRef(false);
  const tabs = useRef<HTMLDivElement>(null);
  const revealRequest = useApp((s) => s.tabRevealRequests[group.id] ?? 0);
  const activeTabIndex = group.tabs.indexOf(group.active ?? "");
  useLayoutEffect(() => {
    const element = tabs.current;
    const active = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!element || !active) {
      return;
    }
    const reveal = () => {
      const viewport = element.getBoundingClientRect();
      const bounds = active.getBoundingClientRect();
      const left = element.scrollLeft + bounds.left - viewport.left;
      if (bounds.width > element.clientWidth || left < element.scrollLeft) {
        element.scrollLeft = left;
      } else if (left + bounds.width > element.scrollLeft + element.clientWidth) {
        element.scrollLeft = left + bounds.width - element.clientWidth;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    observer.observe(active);
    return () => observer.disconnect();
  }, [group.active, activeTabIndex, revealRequest]);
  useEffect(() => {
    if (!host.current) {
      return;
    }
    const state = useApp.getState();
    const currentGroup = state.groups.find((g) => g.id === group.id);
    const e = monaco.editor.create(host.current, {
      theme: "dark-modern",
      model: null,
      automaticLayout: true,
      ...editorOptions(state.settings, currentGroup?.active ? state.docs[currentGroup.active]?.large : false),
      padding: { top: 8 },
      fixedOverflowWidgets: true,
      unicodeHighlight: { ambiguousCharacters: false },
    });
    instance.current = e;
    if (!state.docs[currentGroup?.active ?? ""]?.gitDiff) { editors.set(group.id, e); }
    const subscriptions = [
      installMergeConflictEditor(e, setMergeConflictCount),
      e.onDidFocusEditorText(() => {
        setApp({ activeGroup: group.id });
        syncCursor(e, group.id);
      }),
      e.onDidBlurEditorWidget(() => {
        if (!document.activeElement?.closest(".editor-view-trigger, .media-menu")) {
          void autoSave("onFocusChange", previous.current ?? undefined);
        }
      }),
      e.onDidChangeCursorSelection((event) => {
        const id = useApp.getState().groups.find((g) => g.id === group.id)?.active;
        if (!id || useApp.getState().activeGroup !== group.id) {
          return;
        }
        const m = e.getModel();
        const selection = event.selection;
        setApp({
          cursor: {
            line: selection.positionLineNumber,
            column: selection.positionColumn,
            selected: m?.getValueLengthInRange(selection) ?? 0,
          },
        });
        if (event.source === "api" || event.source === "mouse") {
          addHistory({ id, line: selection.positionLineNumber, column: selection.positionColumn });
        }
      }),
      e.onMouseDown((event) => {
        if (!event.event.detail || event.event.detail < 2) {
          return;
        }
        const id = useApp.getState().groups.find((g) => g.id === group.id)?.active;
        const d = id ? useApp.getState().docs[id] : undefined;
        if (!d?.searchQuery || !event.target.position) {
          return;
        }
        const m = e.getModel();
        if (!m) {
          return;
        }
        const line = m.getLineContent(event.target.position.lineNumber);
        const match = line.match(/^\s+(\d+):(\d+):/);
        if (!match) {
          return;
        }
        for (let n = event.target.position.lineNumber - 1; n > 2; n--) {
          const previous = m.getLineContent(n);
          if (previous && !previous.startsWith(" ")) {
            void openPath(previous.replace(/:$/, ""), {
              pinned: true,
              line: Number(match[1]),
              column: Number(match[2]),
            }).catch((e) => notify(errorMessage(e)));
            break;
          }
        }
      }),
    ];
    return () => {
      subscriptions.forEach((s) => s.dispose());
      if (editors.get(group.id) === e) { editors.delete(group.id); }
      e.dispose();
      instance.current = null;
    };
  }, [group.id]);
  useEffect(() => {
    const e = instance.current;
    if (!e) {
      return;
    }
    if (
      previous.current &&
      (previous.current !== group.active || !textView) &&
      previousTextView.current
    ) {
      saveEditorView(group.id, previous.current, e.saveViewState());
      if (previous.current !== group.active) {
        void autoSave("onFocusChange", previous.current);
      }
    }
    e.setModel(textView && group.active ? (models.get(group.active) ?? null) : null);
    if (!gitDiff) { editors.set(group.id, e); }
    if (
      textView &&
      group.active &&
      (previous.current !== group.active || !previousTextView.current)
    ) {
      const state = group.views[group.active];
      if (state) {
        e.restoreViewState(state as monaco.editor.ICodeEditorViewState);
      }
    }
    if (previous.current === group.active && previousTextView.current !== textView) {
      requestAnimationFrame(() => focusDocument(group.id));
    }
    previous.current = group.active;
    previousTextView.current = textView;
  }, [group.id, group.active, group.views, doc?.path, textView, gitDiff]);
  useEffect(() => {
    if (textView && instance.current) { syncCursor(instance.current, group.id); }
  }, [activeGroup, group.active, group.id, textView]);
  useEffect(() => {
    instance.current?.updateOptions(editorOptions(settings, doc?.large));
  }, [group.id, settings, doc?.large]);
  async function openTreeDrop(raw: string) {
    const { root, treeRoot } = useApp.getState();
    if (!root || treeRoot !== root) {
      return;
    }
    for (const path of explorerDragFiles(raw, root, loadedWorkspacePaths())) {
      const state = useApp.getState();
      if (state.root !== root || !state.groups.some((g) => g.id === group.id)) {
        return;
      }
      try {
        await openPath(join(root, path), { pinned: true, group: group.id });
      } catch (error) {
        notify(errorMessage(error));
      }
    }
  }
  return (
    <section
      data-group-id={group.id}
      className={`editor-group ${activeGroup === group.id ? "focused" : ""}`}
      aria-label="Editor group"
      onPointerDown={() => {
        if (activeGroup !== group.id) {
          setApp({ activeGroup: group.id });
        }
      }}
      onFocus={(e) => {
        if (e.currentTarget.contains(e.target) && activeGroup !== group.id) {
          setApp({ activeGroup: group.id });
        }
      }}
      onDragOverCapture={(e) => {
        if (!e.dataTransfer.types.includes(explorerDragType)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDropCapture={(e) => {
        if (!e.dataTransfer.types.includes(explorerDragType)) {
          return;
        }
        // Capture before Monaco inserts text or a tab consumes the drop.
        e.preventDefault();
        e.stopPropagation();
        void openTreeDrop(e.dataTransfer.getData(explorerDragType));
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const raw = e.dataTransfer.getData("application/litecode-tab");
        if (!raw) {
          return;
        }
        const { id, from } = JSON.parse(raw);
        moveTab(id, from, group.id);
      }}
    >
      <div
        className="tabs-toolbar"
        style={{ display: group.tabs.length === 0 ? "none" : undefined }}
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget && event.target !== tabs.current) {
            return;
          }
          setApp({ activeGroup: group.id });
          newDocument();
        }}
      >
        <div className="editor-tabs" ref={tabs} role="tablist" aria-label="Open editors">
          {group.tabs.map((id) => {
            const tab = docs[id];
            if (!tab) {
              return null;
            }
            const sticky = !!group.sticky?.includes(id);
            return (
              <EditorTabMenu key={id} group={group} documentId={id}>
                <div
                  role="tab"
                  title={`${tab.path ? pathTitle(tab.path) : tab.name}${tab.deleted ? "\n文件已从磁盘删除" : ""}`}
                  tabIndex={group.active === id ? 0 : -1}
                  aria-selected={group.active === id}
                  aria-label={`${tab.name}${tab.dirty ? ", unsaved" : ""}${tab.deleted ? ", 文件已从磁盘删除" : ""}${isGitConflicted(tab.path, root, treeRoot, git) ? ", Git: Unmerged changes" : ""}`}
                  className={`editor-tab ${group.active === id ? "active" : ""} ${group.preview === id ? "preview" : ""} ${sticky ? "pinned" : ""}`}
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData(
                      "application/litecode-tab",
                      JSON.stringify({ id, from: group.id }),
                    )
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const raw = e.dataTransfer.getData("application/litecode-tab");
                    if (raw) {
                      const t = JSON.parse(raw);
                      moveTab(t.id, t.from, group.id, id);
                    }
                  }}
                  onClick={() => showDocument(id, { group: group.id })}
                  onDoubleClick={() => keepOpen(id, group.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && !sticky) {
                      void closeDocument(id, group.id).catch((e) => notify(errorMessage(e)));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      showDocument(id, { group: group.id });
                    }
                    if (e.key === "Delete" && !sticky) {
                      void closeDocument(id, group.id).catch((e) => notify(errorMessage(e)));
                    }
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                      const index = group.tabs.indexOf(id);
                      const next =
                        group.tabs[
                          (index + group.tabs.length + (e.key === "ArrowRight" ? 1 : -1)) %
                            group.tabs.length
                        ];
                      if (next) {
                        showDocument(next, { group: group.id });
                      }
                    }
                  }}
                >
                  <FileIcon language={tab.language} />
                  <span
                    className={`editor-tab-label${isGitIgnored(tab.path, root, treeRoot, git) ? " ignored" : ""}${tab.deleted ? " deleted-file-name" : ""}`}
                  >
                    {tab.name}
                  </span>
                  {tab.conflict && !tab.deleted && <Icon name="warning" />}
                  {isGitConflicted(tab.path, root, treeRoot, git) && <span className="git-conflict-badge" title="Git: Unmerged changes">!</span>}
                  <button
                    className={`tab-close ${tab.dirty ? "dirty" : ""} ${sticky ? "tab-unpin" : ""}`}
                    title={`${sticky ? "Unpin" : "Close"} ${tab.name}`}
                    aria-label={`${sticky ? "Unpin" : "Close"} ${tab.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (sticky) {
                        setSticky(id, group.id, false);
                      } else {
                        void closeDocument(id, group.id).catch((e) => notify(errorMessage(e)));
                      }
                    }}
                  >
                    <Icon name={sticky ? "pinned" : tab.dirty ? "primitive-dot" : "close"} />
                  </button>
                </div>
              </EditorTabMenu>
            );
          })}
        </div>
        <EditorTabsScrollbar viewportRef={tabs} tabIds={group.tabs} />
        <div className="actions">
          {mergeConflictCount > 0 && textView && <>
            <IconButton icon="arrow-up" label="Previous Conflict" onClick={() => { if (instance.current) { navigateInlineConflict(instance.current, "previous"); } }} />
            <IconButton icon="arrow-down" label="Next Conflict" onClick={() => { if (instance.current) { navigateInlineConflict(instance.current, "next"); } }} />
            <span className="sr-only" role="status">{mergeConflictCount} merge conflicts remaining</span>
          </>}
          <IconButton
            icon={splitDown ? "split-vertical" : "split-horizontal"}
            label={`Split Editor ${splitDown ? "Down" : "Right"} (Ctrl+\\)`}
            onClick={() => splitGroup(group.id)}
          />
          <Menu.Root>
            <Menu.Trigger
              className="icon-button"
              title="Split Editor Direction"
              aria-label="Split Editor Direction"
            >
              <Icon name="chevron-down" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className="z-90" side="bottom" align="end">
                <Menu.Popup className="context-menu editor-split-menu" finalFocus={false}>
                  {splitDirections.map(({ id, label, direction }) => (
                    <Menu.Item key={id} onClick={() => splitGroup(group.id, undefined, direction)}>
                      {label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {multipleGroups && (
            <IconButton
              icon="close"
              label="Close Editor Group"
              onClick={() => closeGroup(group.id)}
            />
          )}
        </div>
      </div>
      {doc && !doc.gitDiff && <EditorBreadcrumbs doc={doc} group={group} />}
      {doc?.conflict && !doc.deleted && models.has(doc.id) && (
        <div className="conflict-banner">
          <Icon name="warning" />
          <span>
            The file changed on disk. Your edits are preserved.
          </span>
          <button onClick={() => void compareDisk(doc.id).catch((e) => notify(errorMessage(e)))}>
            Compare
          </button>
        </div>
      )}
      {doc?.searchQuery && <SearchEditorBar id={doc.id} query={doc.searchQuery} />}
      <div
        className="monaco-host"
        ref={host}
        style={{
          display: doc && !textView ? "none" : undefined,
          visibility: textView ? "visible" : "hidden",
        }}
      />
      {doc && isMarkdownView(doc, group) && (
        <MarkdownPreview key={doc.id} doc={doc} group={group} />
      )}
      {doc?.gitDiff && <GitDiffEditor key={doc.id} doc={doc} group={group} />}
      {doc && !doc.gitDiff && !textView && !isMarkdownView(doc, group) && (
        <MediaPreview key={`${doc.id}:${doc.path}`} doc={doc} group={group} />
      )}
      {!doc && (
        <div className="empty-editor">
          <div className="editor-watermark">
            <Icon name="code" />
          </div>
          <dl>
            <dt>Show All Commands</dt>
            <dd>Ctrl+Shift+P</dd>
            <dt>Go to File</dt>
            <dd>Ctrl+P</dd>
            <dt>Find in Files</dt>
            <dd>Ctrl+Shift+F</dd>
            <dt>Open Folder</dt>
            <dd>Ctrl+K Ctrl+O</dd>
          </dl>
        </div>
      )}
    </section>
  );
}

function syncCursor(editor: monaco.editor.IStandaloneCodeEditor, groupId: string) {
  if (useApp.getState().activeGroup !== groupId) { return; }
  const selection = editor.getSelection();
  if (!selection) { return; }
  setApp({ cursor: {
    line: selection.positionLineNumber,
    column: selection.positionColumn,
    selected: editor.getModel()?.getValueLengthInRange(selection) ?? 0,
  } });
}

export function EditorTabsScrollbar({
  viewportRef,
  tabIds,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  tabIds: string[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const rail = track.current;
    const slider = thumb.current;
    if (!element || !rail || !slider) {
      return;
    }
    const update = () => {
      const width = element.clientWidth;
      const scrollWidth = element.scrollWidth;
      rail.hidden = width === 0 || scrollWidth <= width;
      if (rail.hidden) {
        return;
      }
      const thumbWidth = Math.min(width, Math.max(20, (width * width) / scrollWidth));
      rail.style.width = `${width}px`;
      slider.style.width = `${thumbWidth}px`;
      slider.style.transform = `translateX(${(element.scrollLeft / (scrollWidth - width)) * (width - thumbWidth)}px)`;
    };
    update();
    const scroll = (event: WheelEvent) => {
      if (
        event.shiftKey ||
        event.deltaX ||
        !event.deltaY ||
        element.scrollWidth <= element.clientWidth
      ) {
        return;
      }
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? element.clientHeight
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1;
      element.scrollLeft += event.deltaY * unit;
    };
    element.addEventListener("scroll", update, { passive: true });
    element.addEventListener("wheel", scroll, { passive: false });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const tab of element.children) {
      observer.observe(tab);
    }
    return () => {
      element.removeEventListener("scroll", update);
      element.removeEventListener("wheel", scroll);
      observer.disconnect();
    };
  }, [viewportRef, tabIds]);
  function scrollToPointer(clientX: number, offset: number) {
    const element = viewportRef.current;
    const rail = track.current;
    const slider = thumb.current;
    if (!element || !rail || !slider) {
      return;
    }
    const travel = rail.clientWidth - slider.getBoundingClientRect().width;
    if (travel <= 0) {
      return;
    }
    const position = Math.max(
      0,
      Math.min(travel, clientX - rail.getBoundingClientRect().left - offset),
    );
    element.scrollLeft = (position / travel) * (element.scrollWidth - element.clientWidth);
  }
  return (
    <div
      ref={track}
      className="editor-tabs-scrollbar"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0 || !thumb.current) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const bounds = thumb.current.getBoundingClientRect();
        dragOffset.current =
          event.target === thumb.current ? event.clientX - bounds.left : bounds.width / 2;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
        scrollToPointer(event.clientX, dragOffset.current);
      }}
      onPointerMove={(event) => {
        if (dragOffset.current !== null) {
          scrollToPointer(event.clientX, dragOffset.current);
        }
      }}
      onLostPointerCapture={(event) => {
        dragOffset.current = null;
        delete event.currentTarget.dataset.dragging;
      }}
    >
      <div ref={thumb} className="editor-tabs-scrollbar-thumb" />
    </div>
  );
}

function SearchEditorBar({ id, query }: { id: string; query: Query }) {
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (current.current) {
        void call("search_cancel", { requestId: current.current }).catch(() => {});
      }
    },
    [],
  );
  async function rerun() {
    if (current.current) {
      await call("search_cancel", { requestId: current.current });
    }
    const next = { ...query, text: input.current?.value ?? query.text };
    const matches: SearchMatch[] = [];
    const requestId = crypto.randomUUID();
    current.current = requestId;
    await checkpoint();
    patchDoc(id, { searchQuery: next });
    const onBatch = channel((batch) => {
      if (current.current !== requestId) {
        return;
      }
      matches.push(...batch.matches);
      void call("search_ack", { requestId, sequence: batch.sequence });
      if (batch.done && !batch.cancelled) {
        void createSearchEditor(next, matches, id).catch((e) => notify(errorMessage(e)));
        if (batch.errors.length) {
          notify(batch.errors.join("\n"));
        }
      }
    });
    await call("search_start", { requestId, query: next, onBatch });
  }
  return (
    <div className="search-editor-bar">
      <input
        ref={input}
        aria-label="Search Editor query"
        defaultValue={query.text}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void rerun().catch((e) => notify(errorMessage(e)));
          }
        }}
      />
      <button onClick={() => void rerun().catch((e) => notify(errorMessage(e)))}>
        <Icon name="refresh" />
        Search Again
      </button>
      <span className="muted">Double-click a result to open its source.</span>
    </div>
  );
}
