import { useState, type DragEvent } from "react";
import type {
  NoteMeta,
  NotepadDropIndicator,
  NotepadDropPosition,
} from "../types/notepad";
import { canReorderNotes, isReorderNoOp } from "./state";

type UseNotepadReorderDragOptions = {
  dragType: string;
  axis: "x" | "y";
  visibleIds: readonly string[];
  notesById: ReadonlyMap<string, NoteMeta>;
  onReorder: (sourceId: string, targetId: string, position: NotepadDropPosition) => void;
};

function resolveDropPosition(
  event: DragEvent<HTMLElement>,
  axis: "x" | "y",
): NotepadDropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  if (axis === "y") {
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }
  return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
}

function findLastTailTarget(
  visibleIds: readonly string[],
  notesById: ReadonlyMap<string, NoteMeta>,
  sourceId: string,
): string | null {
  const source = notesById.get(sourceId);
  if (!source) {
    return null;
  }
  for (let i = visibleIds.length - 1; i >= 0; i--) {
    const candidateId = visibleIds[i];
    if (candidateId === sourceId) {
      continue;
    }
    const candidate = notesById.get(candidateId);
    if (candidate && candidate.pinned === source.pinned) {
      return candidateId;
    }
  }
  return null;
}

export function useNotepadReorderDrag({
  dragType,
  axis,
  visibleIds,
  notesById,
  onReorder,
}: UseNotepadReorderDragOptions) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<NotepadDropIndicator | null>(null);

  function clearDrag() {
    setDraggedId(null);
    setDropIndicator(null);
  }

  function hasDragType(event: DragEvent<HTMLElement>): boolean {
    return event.dataTransfer.types.includes(dragType);
  }

  function updateIndicator(next: NotepadDropIndicator | null) {
    setDropIndicator((current) => {
      if (
        current?.targetId === next?.targetId &&
        current?.position === next?.position
      ) {
        return current;
      }
      return next;
    });
  }

  function handleItemDragStart(event: DragEvent<HTMLElement>, id: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(dragType, id);
    setDraggedId(id);
    setDropIndicator(null);
  }

  function handleItemDragOver(event: DragEvent<HTMLElement>, targetId: string) {
    if (!hasDragType(event)) {
      return;
    }
    event.stopPropagation();
    const sourceId = draggedId;
    if (!sourceId || !canReorderNotes(notesById, sourceId, targetId)) {
      updateIndicator(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const position = resolveDropPosition(event, axis);
    if (isReorderNoOp(visibleIds, sourceId, targetId, position)) {
      updateIndicator(null);
      return;
    }
    updateIndicator({ targetId, position });
  }

  function handleItemDrop(event: DragEvent<HTMLElement>, targetId: string) {
    if (!hasDragType(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const sourceId = event.dataTransfer.getData(dragType) || draggedId;
    const position = resolveDropPosition(event, axis);
    clearDrag();
    if (!sourceId || !canReorderNotes(notesById, sourceId, targetId)) {
      return;
    }
    if (!isReorderNoOp(visibleIds, sourceId, targetId, position)) {
      onReorder(sourceId, targetId, position);
    }
  }

  function handleContainerDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDragType(event) || !draggedId) {
      return;
    }
    const tailId = findLastTailTarget(visibleIds, notesById, draggedId);
    if (!tailId || isReorderNoOp(visibleIds, draggedId, tailId, "after")) {
      updateIndicator(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateIndicator({ targetId: tailId, position: "after" });
  }

  function handleContainerDrop(event: DragEvent<HTMLElement>) {
    if (!hasDragType(event)) {
      return;
    }
    event.preventDefault();
    const sourceId = event.dataTransfer.getData(dragType) || draggedId;
    clearDrag();
    if (!sourceId) {
      return;
    }
    const tailId = findLastTailTarget(visibleIds, notesById, sourceId);
    if (tailId && !isReorderNoOp(visibleIds, sourceId, tailId, "after")) {
      onReorder(sourceId, tailId, "after");
    }
  }

  function handleContainerDragLeave(event: DragEvent<HTMLElement>) {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) {
      return;
    }
    updateIndicator(null);
  }

  return {
    draggedId,
    dropIndicator,
    handleItemDragStart,
    handleItemDragOver,
    handleItemDrop,
    handleItemDragEnd: clearDrag,
    handleContainerDragOver,
    handleContainerDrop,
    handleContainerDragLeave,
  };
}
