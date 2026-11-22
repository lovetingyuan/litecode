export type NotepadFormat = {
  id: string;
  label: string;
  language: string;
  extensions: readonly string[];
};

export type NoteMeta = {
  id: string;
  title: string;
  format: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  preview: string;
  revision: number;
};

export type NotepadSnapshot = {
  revision: number;
  notes: NoteMeta[];
  activeId: string | null;
  openTabs: string[];
  sort?: NotepadSort;
};

export type NotepadNoteContent = {
  id: string;
  content: string;
  revision: number;
};

export type NotepadLoadResponse = {
  snapshot: NotepadSnapshot;
  contents: Record<string, string>;
};

export type NotepadCreateResponse = {
  snapshot: NotepadSnapshot;
  note: NoteMeta;
  content: string;
};

export type NotepadSaveResponse = {
  snapshot: NotepadSnapshot;
  noteRevision: number;
};

export type NotepadEvent = {
  sourceWindow: string;
  revision: number;
  snapshot: NotepadSnapshot;
  updatedNote: NotepadNoteContent | null;
};

export type NotepadSort = "manual" | "updated" | "created" | "title";

export type NotepadDropPosition = "before" | "after";

export type NotepadDropIndicator = {
  targetId: string;
  position: NotepadDropPosition;
};

export type NotepadCursor = {
  line: number;
  column: number;
  selected: number;
};

export type NotepadStats = {
  lines: number;
  words: number;
  chars: number;
};
