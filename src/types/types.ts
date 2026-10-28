export type AppError = { code: string; message: string };
export type DiskDocument = {
  path: string;
  text: string;
  revision: string;
  encoding: string;
  eol: string;
};
export type ConflictContext = {
  id: string;
  path: string;
  revision: string | null;
  version: number;
  encoding: string;
};
export type DiffRequest = {
  title: string;
  before: string;
  after: string;
  language: string;
  conflict?: ConflictContext;
  error?: string;
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
  gitDiff?: GitDiffResource;
  name: string;
  language: string;
  eol: string;
  large?: boolean;
  conflict?: boolean;
  deleted?: boolean;
  searchQuery?: Query;
  imageSize?: { width: number; height: number };
};
export type DocumentSnapshot = Omit<Mirror, "text"> & { text?: string };
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
  gitDiffs?: Doc[];
  gitRepository?: string | null;
  gitTab?: "changes" | "info";
  gitLayout?: "list" | "tree";
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
  repositories?: GitRepository[];
  root: string | null;
  session: number | null;
  git: GitEntry[];
  branch: string | null;
  warnings: string[];
};
export type GitChange = {
  indexPath?: string | null;
  indexOldPath?: string | null;
  worktreeOldPath?: string | null;
  path: string;
  oldPath: string | null;
  indexStatus: string | null;
  worktreeStatus: string | null;
  conflicted: boolean;
  stamp: string;
};
export type GitRepository = {
  path: string;
  name: string;
  branch: string | null;
  detached: boolean;
  operation: string | null;
  changes: GitChange[];
};
export type GitInfo = {
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  lastFetch: number | null;
  operation: string | null;
  remotes: { name: string; fetch: string | null; push: string | null }[];
  branches: { name: string; current: boolean; remote: boolean; upstream: string | null; worktree: boolean }[];
};
export type GitDiffResource = {
  workspace: string;
  repository: string;
  path: string;
  oldPath: string | null;
  staged: boolean;
  conflicted: boolean;
  sourceId?: string;
};
export type GitDiffContent = { before: string; after: string; source: string | null; summary: string | null };
export type GitBlameRange = { startLine: number; lineCount: number; commit: string | null };
export type GitBlameCommit = { author: string; authorTime: number; summary: string };
export type GitCommitDetails = { sha: string; message: string; author: string; authorEmail: string; authorTime: number };
export type GitFileBlame = {
  head: string | null;
  ranges: GitBlameRange[];
  commits: Record<string, GitBlameCommit>;
};
export type GitOperation =
  | { kind: "stage" | "unstage"; paths: string[] }
  | { kind: "discard"; files: { path: string; stamp: string }[] }
  | { kind: "commit"; message: string }
  | { kind: "fetch"; remote: string }
  | { kind: "pull"; rebase: boolean; remote?: string; branch?: string }
  | { kind: "push"; remote?: string }
  | { kind: "switch" | "deleteBranch"; branch: string }
  | { kind: "createBranch"; name: string; start?: string }
  | { kind: "continue" | "abort" };
export type DirectorySnapshot = {
  root: string;
  session: number;
  directory: string;
  paths: string[];
  warnings: string[];
};
export type WorkspaceChanges = {
  gitPaths?: string[];
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
