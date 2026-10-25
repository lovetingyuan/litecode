export type AppError = { code: string; message: string };
export type DiskDocument = {
  path: string;
  text: string;
  revision: string;
  encoding: string;
  eol: string;
};
export type FileKind = "text" | "image" | "svg" | "video" | "audio" | "binary";
export type FileInfo = { kind: FileKind; size: number; stamp: string };
export type MediaView = {
  mode?: "text" | "image" | "markdown";
  scale?: number | "fit";
  scrollLeft?: number;
  scrollTop?: number;
};
export type Mirror = {
  id: string;
  path: string | null;
  text: string;
  version: number;
  revision: string | null;
  encoding: string;
  dirty: boolean;
  language?: string;
  name?: string;
  searchQuery?: Query;
  kind?: FileKind;
  fileInfo?: FileInfo;
};
export type Doc = Omit<Mirror, "text"> & {
  name: string;
  language: string;
  eol: string;
  large?: boolean;
  conflict?: boolean;
  deleted?: boolean;
  searchQuery?: Query;
  imageSize?: { width: number; height: number };
};
export type Group = {
  id: string;
  tabs: string[];
  active: string | null;
  preview: string | null;
  sticky?: string[];
  views: Record<string, unknown>;
  mediaViews?: Record<string, MediaView>;
};
export type Location = { id: string; path?: string | null; line: number; column: number };
export type Session = {
  groups: Group[];
  activeGroup: string;
  editorLayout?: import("../editor/editorLayout").EditorLayout | null;
  groupMru?: string[];
  sidebar: string;
  sidebarWidth: number;
  history: Location[];
  historyIndex: number;
  query?: Query;
  searchHistory?: string[];
};
export type Keybinding = { key: string; command: string; when?: string };
export type QuickPick = {
  title: string;
  active?: string;
  items: { id: string; label: string; description?: string; run: () => unknown }[];
};
export type Bootstrap = {
  root: string | null;
  documents: Mirror[];
  session: Partial<Session> | null;
  recent: string[];
  settings: Record<string, unknown>;
  keybindings: Keybinding[] | null;
  warnings: string[];
  dataDir: string;
};
export type GitEntry = {
  path: string;
  status: "added" | "deleted" | "ignored" | "modified" | "renamed" | "untracked" | "conflicted";
};
export type GitSnapshot = {
  root: string | null;
  session: number | null;
  git: GitEntry[];
  branch: string | null;
  warnings: string[];
};
export type DirectorySnapshot = {
  root: string;
  session: number;
  directory: string;
  paths: string[];
  warnings: string[];
};
export type WorkspaceChanges = {
  root: string;
  session: number;
  changes: { path: string; structural: boolean }[];
  rescan: boolean;
  gitChanged: boolean;
  fileIndexChanged?: boolean;
};
export type Query = {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  useIgnore: boolean;
  openOnly: boolean;
  changedOnly: boolean;
  followSymlinks: boolean;
  encoding?: string;
  context: number;
};
export type SearchMatch = {
  path: string;
  documentId: string | null;
  version: number | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  preview: string;
  matched: string;
};
export type SearchSession = {
  id: string;
  number: number;
  query: Query;
  results: SearchMatch[];
  searching: boolean;
  searchErrors: string[];
  limited: boolean;
  requestId: string | null;
};
export type SearchBatch = {
  requestId: string;
  sequence: number;
  matches: SearchMatch[];
  done: boolean;
  limited: boolean;
  cancelled: boolean;
  errors: string[];
};
export const defaultQuery: Query = {
  text: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  useIgnore: true,
  openOnly: false,
  changedOnly: false,
  followSymlinks: false,
  context: 1,
};
