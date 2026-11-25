import { create } from "zustand";
import type {
  NoteMeta,
  NotepadCursor,
  NotepadDropPosition,
  NotepadSnapshot,
  NotepadSort,
  NotepadStats,
} from "../types/notepad";
import { normalizeNotepadSort, sortNotes } from "./formats";

export type NotepadState = {
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  revision: number;
  notes: NoteMeta[];
  openTabs: string[];
  activeId: string | null;
  contents: Record<string, string | undefined>;
  sidebarOpen: boolean;
  sidebarWidth: number;
  search: string;
  sort: NotepadSort;
  wordWrap: boolean;
  syntaxHighlight: Record<string, boolean>;
  markdownPreview: Record<string, boolean>;
  cursor: NotepadCursor;
  stats: NotepadStats;
};

export const useNotepad = create<NotepadState>(() => ({
  loaded: false,
  loading: false,
  saving: false,
  lastSavedAt: null,
  revision: 0,
  notes: [],
  openTabs: [],
  activeId: null,
  contents: {},
  sidebarOpen: true,
  sidebarWidth: 230,
  search: "",
  sort: "manual",
  wordWrap: true,
  syntaxHighlight: {},
  markdownPreview: {},
  cursor: { line: 1, column: 1, selected: 0 },
  stats: { lines: 1, words: 0, chars: 0 },
}));

export function isSyntaxHighlightEnabled(
  syntaxHighlight: Readonly<Record<string, boolean>>,
  id: string | null | undefined,
): boolean {
  return id ? syntaxHighlight[id] !== false : true;
}

function filterByValidIds<T>(
  record: Record<string, T>,
  validIds: ReadonlySet<string>,
  keep?: (value: T) => boolean,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, value] of Object.entries(record)) {
    if (validIds.has(id) && (!keep || keep(value))) {
      next[id] = value;
    }
  }
  return next;
}

function uniqueValidIds(ids: readonly string[], validIds: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (validIds.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

export function syncTabsToNoteOrder(
  openTabs: readonly string[],
  orderedNoteIds: readonly string[],
): string[] {
  const openSet = new Set(openTabs);
  const result: string[] = [];
  for (const id of orderedNoteIds) {
    if (openSet.has(id)) {
      result.push(id);
      openSet.delete(id);
    }
  }
  return result;
}

export function reorderNotesByIds(
  notes: readonly NoteMeta[],
  orderedIds: readonly string[],
): NoteMeta[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const result: NoteMeta[] = [];
  for (const id of orderedIds) {
    const note = byId.get(id);
    if (note) {
      result.push(note);
      byId.delete(id);
    }
  }
  for (const remaining of byId.values()) {
    result.push(remaining);
  }
  return result;
}

export function canReorderNotes(
  notesById: ReadonlyMap<string, NoteMeta>,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) {
    return false;
  }
  const source = notesById.get(sourceId);
  const target = notesById.get(targetId);
  if (!source || !target) {
    return false;
  }
  return source.pinned === target.pinned;
}

export function isReorderNoOp(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  position: NotepadDropPosition,
): boolean {
  if (sourceId === targetId) {
    return true;
  }
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return true;
  }
  if (position === "before" && sourceIndex === targetIndex - 1) {
    return true;
  }
  if (position === "after" && sourceIndex === targetIndex + 1) {
    return true;
  }
  return false;
}

export function moveIdInList(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  position: NotepadDropPosition = "before",
): string[] {
  if (sourceId === targetId) {
    return [...ids];
  }
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return [...ids];
  }
  const next = ids.filter((id) => id !== sourceId);
  const adjustedTargetIndex = next.indexOf(targetId);
  const insertIndex = position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
  next.splice(insertIndex, 0, sourceId);
  return next;
}

export function reconcileSnapshot(
  current: Pick<
    NotepadState,
    "openTabs" | "activeId" | "contents" | "markdownPreview" | "syntaxHighlight"
  > & { sort?: NotepadSort },
  snapshot: NotepadSnapshot,
  options: { adoptTabs?: boolean } = {},
): Pick<
  NotepadState,
  | "notes"
  | "openTabs"
  | "activeId"
  | "revision"
  | "contents"
  | "markdownPreview"
  | "syntaxHighlight"
  | "sort"
> {
  const validIds = new Set(snapshot.notes.map((n) => n.id));
  const contents = filterByValidIds(current.contents, validIds);
  const markdownPreview = filterByValidIds(current.markdownPreview, validIds, Boolean);
  const syntaxHighlight = filterByValidIds(
    current.syntaxHighlight,
    validIds,
    (enabled) => !enabled,
  );
  const sort = snapshot.sort ? normalizeNotepadSort(snapshot.sort) : (current.sort ?? "manual");
  const orderedIds = sortNotes(snapshot.notes, sort).map((n) => n.id);
  const sourceTabs = options.adoptTabs ? snapshot.openTabs : current.openTabs;
  const preferredActive = options.adoptTabs ? snapshot.activeId : current.activeId;
  const validTabs = uniqueValidIds(sourceTabs, validIds);
  const syncedTabs = syncTabsToNoteOrder(validTabs, orderedIds);
  const activeId =
    preferredActive && validIds.has(preferredActive)
      ? preferredActive
      : (syncedTabs[0] ?? orderedIds[0] ?? null);
  const openTabs =
    activeId && !syncedTabs.includes(activeId)
      ? syncTabsToNoteOrder([...syncedTabs, activeId], orderedIds)
      : syncedTabs;
  return {
    revision: snapshot.revision,
    notes: snapshot.notes,
    openTabs,
    activeId,
    contents,
    markdownPreview,
    syntaxHighlight,
    sort,
  };
}

export function reorderTabList(
  tabs: readonly string[],
  sourceId: string,
  targetId: string,
): string[] {
  if (sourceId === targetId) {
    return [...tabs];
  }
  const sourceIndex = tabs.indexOf(sourceId);
  const targetIndex = tabs.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return [...tabs];
  }
  const next = tabs.filter((id) => id !== sourceId);
  next.splice(targetIndex, 0, sourceId);
  return next;
}

export function closeTabFromList(
  tabs: readonly string[],
  activeId: string | null,
  closingId: string,
): { openTabs: string[]; activeId: string | null } {
  const index = tabs.indexOf(closingId);
  if (index < 0) {
    return { openTabs: [...tabs], activeId };
  }
  const openTabs = tabs.filter((id) => id !== closingId);
  if (activeId !== closingId) {
    return { openTabs, activeId };
  }
  const nextActive = openTabs[Math.min(index, openTabs.length - 1)] ?? null;
  return { openTabs, activeId: nextActive };
}
