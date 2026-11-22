import notepadStyles from "../styles/notepad.module.css";
import workbenchStyles from "../styles/workbench.module.css";
import type { DragEvent } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { FileIcon, Icon, IconButton } from "./ui";
import type { NoteMeta, NotepadDropPosition, NotepadSort } from "../types/notepad";
import {
  displayNoteName,
  formatRelativeTime,
  NOTEPAD_FORMATS,
  sortNotes,
} from "../notepad/formats";
import {
  changeNoteFormat,
  createNote,
  duplicateNote,
  exportNotepadFile,
  importNotepadFile,
  reorderNotepadNotes,
  selectNote,
  setNotepadSort,
  togglePinNote,
} from "../notepad/runtime";
import { useNotepad } from "../notepad/state";
import { confirmDeleteNote, promptRenameNote, runNotepadAction } from "../notepad/actions";
import { useNotepadReorderDrag } from "../notepad/useNotepadReorderDrag";

const NOTE_DRAG_TYPE = "application/x-litecode-notepad-note";

const SORT_OPTIONS: readonly { id: NotepadSort; label: string }[] = [
  { id: "manual", label: "Custom Order" },
  { id: "updated", label: "Recently Updated" },
  { id: "created", label: "Recently Created" },
  { id: "title", label: "Title (A-Z)" },
];

export function NotepadSidebar() {
  const notes = useNotepad((s) => s.notes);
  const activeId = useNotepad((s) => s.activeId);
  const search = useNotepad((s) => s.search);
  const sort = useNotepad((s) => s.sort);

  const query = search.trim().toLowerCase();
  const sorted = sortNotes(notes, sort);
  const filtered = query
    ? sorted.filter((note) => {
        const name = displayNoteName(note.title, note.format).toLowerCase();
        return name.includes(query) || note.preview.toLowerCase().includes(query);
      })
    : sorted;

  const filteredIds = filtered.map((note) => note.id);
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const drag = useNotepadReorderDrag({
    dragType: NOTE_DRAG_TYPE,
    axis: "y",
    visibleIds: filteredIds,
    notesById,
    onReorder: (sourceId, targetId, position) =>
      runNotepadAction(reorderNotepadNotes(sourceId, targetId, position)),
  });

  const noun = notes.length === 1 ? "note" : "notes";
  const countLabel = query
    ? `${filtered.length} of ${notes.length} ${noun}`
    : `${notes.length} ${noun}`;

  return (
    <aside
      className="notepad-sidebar flex flex-col w-full h-full min-w-0 min-h-0 bg-sidebar border-r border-r-panel overflow-hidden select-none"
      aria-label="Notepad notes"
    >
      <div
        className={`view-title flex items-center justify-between h-[35px] min-h-[35px] text-[11px] font-semibold uppercase text-muted border-b border-b-panel ${workbenchStyles["view-title"]}`}
      >
        <span>Notepad</span>
        <div className="actions flex items-center gap-[2px]">
          <IconButton
            icon="add"
            label="New Note (Ctrl+N)"
            onClick={() => runNotepadAction(createNote())}
          />
          <IconButton
            icon="folder-opened"
            label="Import File…"
            onClick={() => runNotepadAction(importNotepadFile())}
          />
          <Menu.Root>
            <Menu.Trigger render={<IconButton icon="list-flat" label="Sort Notes" />} />
            <Menu.Portal>
              <Menu.Positioner className="z-90" side="bottom" align="end">
                <Menu.Popup
                  className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[180px] z-[90] ${workbenchStyles["context-menu"]}`}
                >
                  {SORT_OPTIONS.map((option) => (
                    <Menu.Item
                      key={option.id}
                      onClick={() => runNotepadAction(setNotepadSort(option.id))}
                    >
                      <span>{option.label}</span>
                      {sort === option.id && <Icon name="check" />}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </div>

      <div className="p-2 border-b border-b-panel">
        <div className="relative flex items-center">
          <input
            type="text"
            className="w-full pr-6 text-[12px] h-[26px]"
            placeholder="Filter notes…"
            aria-label="Filter notes"
            value={search}
            onChange={(event) => useNotepad.setState({ search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                useNotepad.setState({ search: "" });
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="absolute right-[2px] w-5 h-5 p-0 inline-flex items-center justify-center text-muted hover:text-foreground"
              aria-label="Clear filter"
              title="Clear filter"
              onClick={() => useNotepad.setState({ search: "" })}
            >
              <Icon name="close" className="text-[13px]!" />
            </button>
          )}
        </div>
      </div>

      <div
        className={`flex-1 min-h-0 overflow-y-auto py-1 ${notepadStyles["notepad-sidebar-list"]}`}
        role="listbox"
        aria-label="Notes"
        onDragOver={drag.handleContainerDragOver}
        onDrop={drag.handleContainerDrop}
        onDragLeave={drag.handleContainerDragLeave}
      >
        {filtered.map((note, index) => (
          <NoteRow
            key={note.id}
            note={note}
            active={note.id === activeId}
            dragging={drag.draggedId === note.id}
            dropPosition={
              drag.dropIndicator?.targetId === note.id ? drag.dropIndicator.position : null
            }
            onDragStart={(event) => drag.handleItemDragStart(event, note.id)}
            onDragOver={(event) => drag.handleItemDragOver(event, note.id)}
            onDrop={(event) => drag.handleItemDrop(event, note.id)}
            onDragEnd={drag.handleItemDragEnd}
            onNavigate={(delta) => {
              const target = filtered[(index + delta + filtered.length) % filtered.length];
              if (target) {
                runNotepadAction(selectNote(target.id));
              }
            }}
          />
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-muted">
            {notes.length === 0 ? "No notes yet." : "No matching notes."}
          </div>
        )}
      </div>

      <div className="h-[24px] min-h-[24px] px-3 flex items-center justify-between text-[11px] text-muted border-t border-t-panel">
        <span>{countLabel}</span>
        <span
          className="inline-flex items-center gap-1"
          title="Notes sync globally across all windows"
        >
          <Icon name="sync" className="text-[12px]!" />
          Global
        </span>
      </div>
    </aside>
  );
}

type NoteRowProps = Readonly<{
  note: NoteMeta;
  active: boolean;
  dragging: boolean;
  dropPosition: NotepadDropPosition | null;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onNavigate: (delta: 1 | -1) => void;
}>;

function NoteRow({
  note,
  active,
  dragging,
  dropPosition,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onNavigate,
}: NoteRowProps) {
  const fullName = displayNoteName(note.title, note.format);
  let dropClass = "";
  if (dropPosition === "before") {
    dropClass = notepadStyles["notepad-note-drop-before"];
  } else if (dropPosition === "after") {
    dropClass = notepadStyles["notepad-note-drop-after"];
  }
  const rowClassName = [
    "w-full text-left px-3 py-[7px] rounded-none flex flex-col gap-[3px] cursor-pointer outline-none focus-visible:outline-1 focus-visible:outline-focus focus-visible:-outline-offset-1",
    notepadStyles["notepad-note-item"],
    active && "active",
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
            role="option"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            draggable
            className={rowClassName}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onClick={() => runNotepadAction(selectNote(note.id))}
            onDoubleClick={() => runNotepadAction(promptRenameNote(note))}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                runNotepadAction(selectNote(note.id));
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                onNavigate(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                onNavigate(-1);
              }
            }}
          />
        }
      >
        <div className="flex items-center gap-[6px] min-w-0 w-full">
          <FileIcon path={fullName} />
          <span className="flex-1 min-w-0 truncate text-[13px]">{fullName}</span>
          {note.pinned && <Icon name="pinned" className="text-[12px]! text-muted shrink-0" />}
          <span className={`text-[11px] text-muted shrink-0 ${notepadStyles["notepad-note-time"]}`}>
            {formatRelativeTime(note.updatedAt)}
          </span>
        </div>
        <div
          className={`pl-6 text-[11px] text-muted truncate w-full ${notepadStyles["notepad-note-preview"]}`}
        >
          {note.preview || "Empty note"}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-90">
          <ContextMenu.Popup
            className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[200px] z-[90] ${workbenchStyles["context-menu"]}`}
          >
            <ContextMenu.Item onClick={() => runNotepadAction(promptRenameNote(note))}>
              Rename…
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => runNotepadAction(togglePinNote(note.id))}>
              {note.pinned ? "Unpin" : "Pin to Top"}
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => runNotepadAction(duplicateNote(note.id))}>
              Duplicate
            </ContextMenu.Item>
            <ContextMenu.SubmenuRoot>
              <ContextMenu.SubmenuTrigger className="flex items-center justify-between gap-8 h-[27px] px-5 pl-6 rounded-[4px] w-full text-left whitespace-nowrap cursor-pointer outline-none data-highlighted:bg-selection data-highlighted:text-foreground-strong">
                <span>Format</span>
                <Icon name="chevron-right" className="text-[13px]!" />
              </ContextMenu.SubmenuTrigger>
              <ContextMenu.Portal>
                <ContextMenu.Positioner className="z-90" sideOffset={4}>
                  <ContextMenu.Popup
                    className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[190px] z-[90] ${workbenchStyles["context-menu"]} ${notepadStyles["notepad-format-menu"]}`}
                  >
                    {NOTEPAD_FORMATS.map((fmt) => (
                      <ContextMenu.Item
                        key={fmt.id}
                        onClick={() => runNotepadAction(changeNoteFormat(note.id, fmt.id))}
                      >
                        <span>
                          {fmt.label} (.{fmt.id})
                        </span>
                        {note.format === fmt.id && <Icon name="check" />}
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            </ContextMenu.SubmenuRoot>
            <ContextMenu.Item onClick={() => runNotepadAction(exportNotepadFile(note.id))}>
              Export to File…
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
