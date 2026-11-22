import notepadStyles from "../styles/notepad.module.css";
import workbenchStyles from "../styles/workbench.module.css";
import { useEffect, useRef, type DragEvent } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { EditorTabsScrollbar } from "./EditorGroup";
import { FileIcon, Icon, IconButton } from "./ui";
import type { NoteMeta, NotepadDropPosition } from "../types/notepad";
import { displayNoteName } from "../notepad/formats";
import {
  closeNotepadTab,
  closeOtherNotepadTabs,
  createNote,
  duplicateNote,
  exportNotepadFile,
  importNotepadFile,
  reorderNotepadTab,
  selectNote,
  toggleNotepadMarkdownPreview,
  toggleNotepadSidebar,
  toggleNotepadSyntaxHighlight,
  toggleNotepadWordWrap,
  togglePinNote,
  triggerNotepadFind,
} from "../notepad/runtime";
import { isSyntaxHighlightEnabled, useNotepad } from "../notepad/state";
import {
  confirmDeleteNote,
  copyNoteContent,
  promptRenameNote,
  runNotepadAction,
} from "../notepad/actions";
import { useNotepadReorderDrag } from "../notepad/useNotepadReorderDrag";

const TAB_DRAG_TYPE = "application/x-litecode-notepad-tab";

export function NotepadTabBar({ activeNote }: Readonly<{ activeNote: NoteMeta | undefined }>) {
  const notes = useNotepad((s) => s.notes);
  const openTabs = useNotepad((s) => s.openTabs);
  const activeId = useNotepad((s) => s.activeId);
  const sidebarOpen = useNotepad((s) => s.sidebarOpen);
  const wordWrap = useNotepad((s) => s.wordWrap);
  const syntaxHighlight = useNotepad((s) =>
    isSyntaxHighlightEnabled(s.syntaxHighlight, s.activeId),
  );
  const previewing = useNotepad((s) => (s.activeId ? !!s.markdownPreview[s.activeId] : false));

  const tabBarRef = useRef<HTMLDivElement>(null);
  const notesById = new Map(notes.map((n) => [n.id, n]));
  const visibleTabIds = openTabs.filter((id) => notesById.has(id));
  const drag = useNotepadReorderDrag({
    dragType: TAB_DRAG_TYPE,
    axis: "x",
    visibleIds: visibleTabIds,
    notesById,
    onReorder: (sourceId, targetId, position) => reorderNotepadTab(sourceId, targetId, position),
  });

  useEffect(() => {
    tabBarRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const isMarkdown = activeNote?.format === "md";

  return (
    <div
      className={`notepad-toolbar relative flex items-center justify-between h-[35px] min-h-[35px] bg-sidebar border-b border-b-panel select-none ${notepadStyles["notepad-toolbar"]}`}
      onDoubleClick={(event) => {
        // eslint-disable-next-line sonarjs/different-types-comparison -- Compare shared runtime DOM references on empty tab-strip double-click.
        if (event.target !== event.currentTarget && event.target !== tabBarRef.current) {
          return;
        }
        runNotepadAction(createNote());
      }}
    >
      <div
        ref={tabBarRef}
        className={`notepad-tabs flex flex-1 min-w-0 h-full overflow-x-auto overflow-y-hidden ${notepadStyles["notepad-tabs"]}`}
        role="tablist"
        aria-label="Open notes"
        onDragOver={drag.handleContainerDragOver}
        onDrop={drag.handleContainerDrop}
        onDragLeave={drag.handleContainerDragLeave}
      >
        {visibleTabIds.map((id) => {
          const note = notesById.get(id);
          if (!note) {
            return null;
          }
          return (
            <NotepadTabItem
              key={id}
              note={note}
              selected={id === activeId}
              openTabs={visibleTabIds}
              dragging={drag.draggedId === id}
              dropPosition={
                drag.dropIndicator?.targetId === id ? drag.dropIndicator.position : null
              }
              onDragStart={(event) => drag.handleItemDragStart(event, id)}
              onDragOver={(event) => drag.handleItemDragOver(event, id)}
              onDrop={(event) => drag.handleItemDrop(event, id)}
              onDragEnd={drag.handleItemDragEnd}
            />
          );
        })}
      </div>
      <EditorTabsScrollbar viewportRef={tabBarRef} tabIds={openTabs} />
      <div
        className={`notepad-actions flex items-center gap-[2px] px-[6px] shrink-0 ${notepadStyles["notepad-actions"]}`}
      >
        <IconButton
          icon="layout-sidebar-left"
          label={sidebarOpen ? "Hide Notes List (Ctrl+B)" : "Show Notes List (Ctrl+B)"}
          aria-pressed={sidebarOpen}
          onClick={toggleNotepadSidebar}
        />
        <IconButton
          icon="add"
          label="New Note (Ctrl+N)"
          onClick={() => runNotepadAction(createNote())}
        />
        {isMarkdown && activeNote && (
          <IconButton
            icon={previewing ? "edit" : "open-preview"}
            label={previewing ? "Edit Markdown" : "Preview Markdown"}
            aria-pressed={previewing}
            onClick={() => toggleNotepadMarkdownPreview(activeNote.id)}
          />
        )}
        <IconButton
          icon="search"
          label="Find in Note (Ctrl+F)"
          disabled={!activeNote || (isMarkdown && previewing)}
          onClick={() => triggerNotepadFind(false)}
        />
        <IconButton
          icon="word-wrap"
          label={wordWrap ? "Disable Word Wrap (Alt+Z)" : "Enable Word Wrap (Alt+Z)"}
          aria-pressed={wordWrap}
          onClick={toggleNotepadWordWrap}
        />
        <IconButton
          icon="symbol-color"
          label={syntaxHighlight ? "Disable Syntax Highlighting" : "Enable Syntax Highlighting"}
          aria-pressed={activeNote ? syntaxHighlight : false}
          disabled={!activeNote}
          onClick={() => activeNote && toggleNotepadSyntaxHighlight(activeNote.id)}
        />
        <Menu.Root>
          <Menu.Trigger render={<IconButton icon="ellipsis" label="More Actions" />} />
          <Menu.Portal>
            <Menu.Positioner className="z-90" side="bottom" align="end">
              <Menu.Popup
                className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[200px] z-[90] ${workbenchStyles["context-menu"]}`}
              >
                <Menu.Item onClick={() => runNotepadAction(importNotepadFile())}>
                  Import File…
                </Menu.Item>
                <Menu.Item
                  disabled={!activeNote}
                  onClick={() => activeNote && runNotepadAction(exportNotepadFile(activeNote.id))}
                >
                  Export Note…
                </Menu.Item>
                <Menu.Item
                  disabled={!activeNote}
                  onClick={() => activeNote && runNotepadAction(copyNoteContent(activeNote.id))}
                >
                  Copy All Text
                </Menu.Item>
                <Menu.Separator className="menu-separator" />
                <Menu.Item
                  disabled={!activeNote}
                  onClick={() => activeNote && runNotepadAction(promptRenameNote(activeNote))}
                >
                  Rename Note…
                </Menu.Item>
                <Menu.Item
                  disabled={!activeNote}
                  onClick={() => activeNote && runNotepadAction(duplicateNote(activeNote.id))}
                >
                  Duplicate Note
                </Menu.Item>
                <Menu.Item
                  disabled={!activeNote}
                  onClick={() => activeNote && runNotepadAction(confirmDeleteNote(activeNote))}
                >
                  Delete Note
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </div>
  );
}

type NotepadTabItemProps = Readonly<{
  note: NoteMeta;
  selected: boolean;
  openTabs: readonly string[];
  dragging: boolean;
  dropPosition: NotepadDropPosition | null;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}>;

function NotepadTabItem({
  note,
  selected,
  openTabs,
  dragging,
  dropPosition,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: NotepadTabItemProps) {
  const id = note.id;
  const fullName = displayNoteName(note.title, note.format);
  let dropClass = "";
  if (dropPosition === "before") {
    dropClass = notepadStyles["notepad-tab-drop-before"];
  } else if (dropPosition === "after") {
    dropClass = notepadStyles["notepad-tab-drop-after"];
  }
  const tabClassName = [
    "notepad-tab relative h-full flex items-center gap-[6px] min-w-[100px] max-w-60 shrink-0 cursor-pointer whitespace-nowrap border-r border-r-panel border-t border-t-transparent",
    notepadStyles["notepad-tab"],
    selected && "active",
    dragging && notepadStyles["notepad-dragging"],
    dropClass,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <div
            className={tabClassName}
            role="tab"
            id={`notepad-tab-${id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={fullName}
            draggable
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onClick={() => runNotepadAction(selectNote(id))}
            onDoubleClick={() => runNotepadAction(promptRenameNote(note))}
            onAuxClick={(event) => {
              if (event.button === 1) {
                runNotepadAction(closeNotepadTab(id));
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                runNotepadAction(selectNote(id));
              } else if (event.key === "Delete") {
                runNotepadAction(closeNotepadTab(id));
              } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                const index = openTabs.indexOf(id);
                const delta = event.key === "ArrowRight" ? 1 : -1;
                const nextId = openTabs[(index + delta + openTabs.length) % openTabs.length];
                if (nextId) {
                  runNotepadAction(selectNote(nextId));
                }
              }
            }}
          />
        }
      >
        <FileIcon path={fullName} />
        <span className="truncate text-[13px]">{fullName}</span>
        {note.pinned && <Icon name="pinned" className="text-[12px]! text-muted shrink-0" />}
        <IconButton
          icon="close"
          className="notepad-tab-close absolute right-1 opacity-[0]"
          label={`Close ${fullName}`}
          onClick={(event) => {
            event.stopPropagation();
            runNotepadAction(closeNotepadTab(id));
          }}
        />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-90">
          <ContextMenu.Popup
            className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[200px] z-[90] ${workbenchStyles["context-menu"]}`}
          >
            <ContextMenu.Item onClick={() => runNotepadAction(promptRenameNote(note))}>
              Rename…
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => runNotepadAction(togglePinNote(id))}>
              {note.pinned ? "Unpin" : "Pin to Top"}
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => runNotepadAction(duplicateNote(id))}>
              Duplicate
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => runNotepadAction(exportNotepadFile(id))}>
              Export to File…
            </ContextMenu.Item>
            <ContextMenu.Separator className="menu-separator" />
            <ContextMenu.Item onClick={() => runNotepadAction(closeNotepadTab(id))}>
              Close Tab
            </ContextMenu.Item>
            <ContextMenu.Item
              disabled={openTabs.length <= 1}
              onClick={() => closeOtherNotepadTabs(id)}
            >
              Close Others
            </ContextMenu.Item>
            <ContextMenu.Separator className="menu-separator" />
            <ContextMenu.Item onClick={() => runNotepadAction(confirmDeleteNote(note))}>
              Delete Note
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
