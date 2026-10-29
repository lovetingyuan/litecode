import { monaco, languageFor, loadSyntax } from "./monaco";
import { call, desktop, errorMessage } from "../core/bridge";
import { useApp, setApp, notify, activeDoc, searchSession, primarySearchId } from "../store/store";
import { ask } from "../components/dialog";
import type {
  DiskDocument,
  Doc,
  Group,
  Mirror,
  Location,
  Session,
  FileInfo,
  MediaView,
  ConflictContext,
  DiffRequest,
} from "../types/types";
import { isMarkdownDocument, isTextDocument, isTextView } from "../utils/media";
import { ensureLanguage, releaseLanguageDocument, formatModel, canFormat } from "./languages";
import { organizeSettings, parseConfiguration, settingValue } from "../utils/settings";
import { applyModelSettings, modelSettingKeys } from "./settings";
import { layoutGroups, restoreLayout, splitLayout, type SplitDirection } from "./editorLayout";
import type { FileMove } from "../explorer/explorerMove";
import { DocumentBackups } from "./documentBackup";

export const models = new Map<string, monaco.editor.ITextModel>();
export const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>();
export const diffEditors = new Map<string, { editor: monaco.editor.IStandaloneDiffEditor; viewModel: monaco.editor.IDiffEditorViewModel }>();
useApp.subscribe((state, previous) => {
  if (state.settings === previous.settings) { return; }
  if (modelSettingKeys.some((key) => settingValue(state.settings, key) !== settingValue(previous.settings, key))) {
    for (const m of models.values()) { applyModelSettings(m, state.settings); }
  }
  if (!settingValue(state.settings, "workbench.editor.enablePreview") && state.groups.some((g) => g.preview)) {
    setApp({ groups: state.groups.map((g) => ({ ...g, preview: null })) });
  }
});
const savedVersions = new Map<string, number>();
const savedEncodings = new Map<string, string>();
const subscriptions = new Map<string, monaco.IDisposable>();
const saveQueues = new Map<string, Promise<void>>();
const refreshRequests = new Map<string, symbol>();
let backupTimer: ReturnType<typeof setTimeout>;
const backups = new DocumentBackups();
let sessionBackupDue: number | undefined;
let autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
let checkpointQueue = Promise.resolve();
let saveSequence = 0;
let moveSequence = 0;
let documentEpoch = 0;
let backupRetryDelay = 0;
let backupRetryAt = 0;
let lastMoveFailure: { sequence: number; error: unknown } | undefined;
let documentMove: { paths: readonly string[]; done: Promise<{ error?: unknown }>; drainThrough: number } | null = null;
let windowClose: Promise<void> | undefined;

export async function beginDocumentMove(moves: FileMove[]) {
  return beginDocumentChange(moves.flatMap(({ from, to }) => [from, to]), () => checkDocumentMoves(moves));
}

export async function beginDocumentDelete(paths: readonly string[]) {
  return beginDocumentChange(paths);
}

async function beginDocumentChange(paths: readonly string[], validate = () => {}) {
  while (documentMove) {
    await documentMove.done;
  }
  const sequence = ++moveSequence;
  let complete!: (result: { error?: unknown }) => void;
  const done = new Promise<{ error?: unknown }>((resolve) => { complete = resolve; });
  const draining = [...saveQueues.values()];
  const move = documentMove = { paths, done, drainThrough: saveSequence };
  const release = (error?: unknown) => {
    if (documentMove !== move) { return; }
    if (error !== undefined) { lastMoveFailure = { sequence, error }; }
    documentMove = null;
    complete({ error });
    scheduleBackup();
  };
  try {
    // Existing saves and snapshots finish before disk changes. New saves and
    // file opens wait for the final paths; periodic backups stay deferred.
    await Promise.allSettled(draining);
    await checkpointQueue.catch(() => {});
    validate();
    return release;
  } catch (error) {
    release(error);
    throw error;
  }
}

function isMoving(path: string) {
  return (
    documentMove?.paths.some(source => withinPath(path, source)) ?? false
  );
}
function withinPath(path: string, parent: string) {
  const base = normalize(parent).replace(/\/+$/, "");
  return normalize(path) === base || normalize(path).startsWith(base + "/");
}

export function documentsAtPaths(paths: readonly string[]) {
  const docs = Object.values(useApp.getState().docs);
  const ids = new Set(docs.filter(doc => doc.path && paths.some(path => withinPath(doc.path!, path))).map(doc => doc.id));
  return docs.filter(doc => ids.has(doc.id) || (doc.gitDiff?.sourceId && ids.has(doc.gitDiff.sourceId)));
}

function movedDocumentPath(path: string, moves: FileMove[]) {
  const move = moves.find(({ from }) => withinPath(path, from));
  if (!move) { return null; }
  const source = visiblePath(move.from).replace(/\\/g, "/").replace(/\/+$/, "");
  const destination = visiblePath(move.to).replace(/\\/g, "/").replace(/\/+$/, "");
  return destination + visiblePath(path).replace(/\\/g, "/").slice(source.length);
}

function occupiedDestination() {
  return new Error("This destination is already open in another editor. Close that editor before moving files.");
}

function checkDocumentMoves(moves: FileMove[]) {
  const docs = Object.values(useApp.getState().docs);
  for (const { from, to } of moves) {
    if (docs.some(doc => doc.path && withinPath(doc.path, to) && !withinPath(doc.path, from))) {
      throw occupiedDestination();
    }
    const target = monaco.editor.getModel(monaco.Uri.file(visiblePath(to)));
    if (target && !docs.some(doc => doc.path && withinPath(doc.path, from) && models.get(doc.id) === target)) {
      throw occupiedDestination();
    }
  }
  for (const doc of docs) {
    const path = doc.path && movedDocumentPath(doc.path, moves);
    if (!path) { continue; }
    const target = monaco.editor.getModel(monaco.Uri.file(path));
    if (target && target !== models.get(doc.id)) { throw occupiedDestination(); }
    if (docs.some(other => other.id !== doc.id && other.path && normalize(other.path) === normalize(path))) {
      throw occupiedDestination();
    }
  }
}
export const basename = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;
export const normalize = (path: string) => visiblePath(path).replace(/\\/g, "/").toLowerCase();
export const join = (root: string, path: string) =>
  `${root.replace(/[\\/]$/, "")}/${path.replace(/\/$/, "")}`;
export const visiblePath = (path: string) =>
  path.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
export const pathTitle = (path: string) => visiblePath(path).replace(/\//g, "\\");
export const relative = (path: string, root = useApp.getState().root) => {
  const value = visiblePath(path).replace(/\\/g, "/");
  const base = root ? visiblePath(root).replace(/\\/g, "/") : null;
  return base && value.toLowerCase().startsWith(base.toLowerCase() + "/")
    ? value.slice(base.length + 1)
    : value;
};
export const editor = () => {
  const s = useApp.getState();
  const group = s.groups.find((g) => g.id === s.activeGroup);
  const doc = group?.active ? s.docs[group.active] : undefined;
  return doc && !isTextView(doc, group) && !doc.gitDiff ? undefined : editors.get(s.activeGroup);
};
export const model = (id = activeDoc()?.id): monaco.editor.ITextModel | undefined => {
  const source = id && useApp.getState().docs[id]?.gitDiff?.sourceId;
  return id ? models.get(source || id) : undefined;
};

export function patchDoc(id: string, patch: Partial<Doc>) {
  setApp((s) => (s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], ...patch } } } : {}));
}

export function patchMediaView(groupId: string, id: string, patch: Partial<MediaView>) {
  setApp((s) => ({
    groups: s.groups.map((g) =>
      g.id === groupId
        ? { ...g, mediaViews: { ...g.mediaViews, [id]: { ...g.mediaViews?.[id], ...patch } } }
        : g,
    ),
  }));
  scheduleBackup();
}

export function focusDocument(groupId = useApp.getState().activeGroup) {
  const s = useApp.getState();
  const group = s.groups.find((g) => g.id === groupId);
  const doc = group?.active ? s.docs[group.active] : undefined;
  if (!doc || isTextView(doc, group) || doc.gitDiff) {
    editors.get(groupId)?.focus();
  } else if (typeof document !== "undefined") {
    const preview = document.querySelector<HTMLElement>(
      `[data-group-id="${CSS.escape(groupId)}"] :is(.media-preview, .markdown-preview)`,
    );
    (preview?.querySelector<HTMLElement>(".image-viewport") ?? preview)?.focus({
      preventScroll: true,
    });
  }
}

export function saveEditorView(
  groupId: string,
  id: string,
  view: monaco.editor.ICodeEditorViewState | null,
) {
  if (!useApp.getState().groups.some((g) => g.id === groupId)) {
    return;
  }
  setApp((s) => ({
    groups: s.groups.map((g) =>
      g.id === groupId ? { ...g, views: { ...g.views, [id]: view } } : g,
    ),
  }));
}

function saveEditorViews() {
  const s = useApp.getState();
  const groups = s.groups.map((g) => {
    const diff = diffEditors.get(g.id);
    if (g.active && s.docs[g.active]?.gitDiff && diff) {
      return { ...g, views: { ...g.views, [g.active]: diff.editor.saveViewState() } };
    }
    const e = editors.get(g.id);
    if (g.active && e && s.docs[g.active] && isTextView(s.docs[g.active], g)) {
      return { ...g, views: { ...g.views, [g.active]: e.saveViewState() } };
    }
    return g;
  });
  if (groups.some((g, i) => g !== s.groups[i])) {
    setApp({ groups });
  }
}

export function session(): Session {
  saveEditorViews();
  const s = useApp.getState();
  return {
    gitDiffs: Object.values(s.docs).filter((doc) => doc.gitDiff).map((doc) => ({ ...doc, dirty: false })),
    gitRepository: s.gitRepository,
    gitTab: s.gitTab,
    gitLayout: s.gitLayout,
    groups: s.groups,
    activeGroup: s.activeGroup,
    editorLayout: s.editorLayout,
    groupMru: s.groupMru,
    sidebar: s.sidebar ?? "",
    sidebarWidth: s.sidebarWidth,
    history: s.history,
    historyIndex: s.historyIndex,
    query: searchSession(primarySearchId)!.query,
    searchHistory: s.searchHistory,
  };
}

export async function checkpoint(options: { waitForMoves?: boolean } = {}) {
  if (!desktop) { return; }
  const firstMove = moveSequence;
  for (;;) {
    if (options.waitForMoves) {
      // Never put a barrier-waiting job inside checkpointQueue: a move drains
      // that queue before changing disk paths.
      while (documentMove || saveQueues.size) {
        if (documentMove) {
          const result = await documentMove.done;
          if (result.error !== undefined) { throw result.error; }
        } else {
          await Promise.allSettled(saveQueues.values());
        }
      }
      if (lastMoveFailure && lastMoveFailure.sequence > firstMove) { throw lastMoveFailure.error; }
    } else if (documentMove) {
      return;
    }
    const moveVersion = moveSequence;
    const saveVersion = saveSequence;
    const snapshotDocs = useApp.getState().docs;
    await syncDocumentSnapshot();
    if (!options.waitForMoves || (!documentMove && !saveQueues.size &&
      moveVersion === moveSequence && saveVersion === saveSequence && snapshotDocs === useApp.getState().docs)) {
      return;
    }
  }
}

async function syncDocumentSnapshot() {
  await queueDocumentSnapshot(false);
}

const backupDocuments = () => Object.values(useApp.getState().docs).filter(doc => !doc.gitDiff);

function queueDocumentSnapshot(automatic: boolean) {
  const epoch = documentEpoch;
  checkpointQueue = checkpointQueue
    .catch(() => {})
    .then(async () => {
      // A reloaded WebView must restore the native mirror before replacing it.
      if (!useApp.getState().ready || epoch !== documentEpoch) { return; }
      if (automatic && documentMove) { return; }
      const capturedDue = sessionBackupDue;
      const snapshot = backups.capture(backupDocuments(), models, automatic);
      await call<void>("sync_documents", { documents: snapshot.documents, session: session() });
      snapshot.acknowledge();
      backupRetryDelay = backupRetryAt = 0;
      if (sessionBackupDue === capturedDue) { sessionBackupDue = undefined; }
      backups.noteChanges(backupDocuments(), models);
      armBackupTimer();
    });
  return checkpointQueue;
}

export function closeWindowWithRecovery(destroy: () => Promise<void>) {
  return windowClose ??= checkpoint({ waitForMoves: true }).then(destroy).finally(() => { windowClose = undefined; });
}
export function scheduleBackup() {
  sessionBackupDue = Date.now() + 400;
  backups.noteChanges(backupDocuments(), models);
  armBackupTimer();
}

function armBackupTimer() {
  clearTimeout(backupTimer);
  if (documentMove || !useApp.getState().ready) { return; }
  const deadline = Math.min(sessionBackupDue ?? Infinity, backups.nextDeadline());
  if (!Number.isFinite(deadline)) { return; }
  const epoch = documentEpoch;
  backupTimer = setTimeout(
    () => void queueDocumentSnapshot(true).catch((e) => {
      if (epoch !== documentEpoch) { return; }
      notify(`Backup failed: ${errorMessage(e)}`);
      backupRetryDelay = Math.min(30_000, backupRetryDelay ? backupRetryDelay * 2 : 1000);
      backupRetryAt = Date.now() + backupRetryDelay;
      armBackupTimer();
    }),
    Math.max(0, deadline - Date.now(), backupRetryAt - Date.now()),
  );
}

export function attachDocument(doc: Doc, text: string, initiallyDirty = false) {
  if (!monaco.languages.getLanguages().some((l) => l.id === doc.language)) {
    monaco.languages.register({ id: doc.language });
  }
  const uri = doc.path ? monaco.Uri.file(visiblePath(doc.path)) : monaco.Uri.parse(doc.id);
  const existing = monaco.editor.getModel(uri);
  if (existing && existing !== models.get(doc.id)) { throw occupiedDestination(); }
  const m = existing ?? monaco.editor.createModel(text, doc.language, uri);
  applyModelSettings(m, useApp.getState().settings);
  models.set(doc.id, m);
  if (!initiallyDirty) {
    savedVersions.set(doc.id, m.getAlternativeVersionId());
    savedEncodings.set(doc.id, doc.encoding);
  }
  setApp((s) => ({ docs: { ...s.docs, [doc.id]: doc } }));
  void loadSyntax(doc.language).then(() => {
    if (!m.isDisposed() && m.getLanguageId() !== doc.language) {
      monaco.editor.setModelLanguage(m, doc.language);
    }
  });
  subscriptions.set(
    doc.id,
    m.onDidChangeContent(() => {
      const latest = useApp.getState().docs[doc.id];
      if (!latest) {
        return;
      }
      const dirty =
        savedVersions.get(doc.id) !== m.getAlternativeVersionId() ||
        savedEncodings.get(doc.id) !== latest.encoding;
      patchDoc(doc.id, {
        dirty,
        version: latest.version + 1,
        eol: m.getEOL() === "\r\n" ? "CRLF" : "LF",
      });
      if (dirty) {
        keepOpen(doc.id);
      }
      scheduleBackup();
      clearTimeout(autoTimers.get(doc.id));
      const s = useApp.getState();
      if (s.settings["files.autoSave"] === "afterDelay" && latest.path && !latest.conflict) {
        autoTimers.set(
          doc.id,
          setTimeout(
            () => void autoSave("afterDelay", doc.id),
            Number(s.settings["files.autoSaveDelay"] ?? 1000),
          ),
        );
      }
    }),
  );
  scheduleBackup();
  if (!doc.large) {
    void ensureLanguage(doc.id, doc.language);
  }
  return m;
}

export function restoreDocument(mirror: Mirror, options: { synchronized?: boolean } = {}) {
  const detected = languageFor(mirror.path ?? "");
  // Upgrade language modes saved before their syntax support was added.
  const language =
    detected === "jsonc" ||
    (detected !== "plaintext" && mirror.language === "plaintext") ||
    (detected === "typescriptreact" && mirror.language === "typescript") ||
    (detected === "javascriptreact" && mirror.language === "javascript")
      ? detected
      : (mirror.language ?? detected);
  const kind =
    (!mirror.kind || mirror.kind === "text") && /\.svg$/i.test(mirror.path ?? "")
      ? "svg"
      : (mirror.kind ?? "text");
  const doc: Doc = {
    ...mirror,
    kind,
    large: (mirror.fileInfo?.size ?? new TextEncoder().encode(mirror.text).length) > 20 * 1024 * 1024,
    name: mirror.name ?? (mirror.path ? basename(mirror.path) : "Untitled"),
    language,
    eol: mirror.text.includes("\r\n") ? "CRLF" : "LF",
  };
  if (isTextDocument(doc)) {
    attachDocument(doc, mirror.text, mirror.dirty);
  } else {
    attachPreviewDocument(doc);
  }
  // Bootstrap already owns this exact body in its backend mirror. In
  // particular, retain restored large buffers before their first idle timer.
  if (options.synchronized) { backups.confirmRestored(doc, models.get(doc.id)); }
}

function attachPreviewDocument(doc: Doc) {
  setApp((s) => ({ docs: { ...s.docs, [doc.id]: { ...doc, dirty: false } } }));
  scheduleBackup();
}

type OpenPathOptions = {
  reveal?: boolean;
  pinned?: boolean;
  group?: string;
  line?: number;
  column?: number;
  background?: boolean;
  preserveFocus?: boolean;
  force?: boolean;
};

export async function openPath(path: string, options: OpenPathOptions = {}): Promise<string> {
  const epoch = documentEpoch;
  const root = useApp.getState().root;
  const current = () => epoch === documentEpoch && root === useApp.getState().root;
  while (documentMove && isMoving(path)) { await documentMove.done; }
  if (!current()) { throw new Error("The workspace changed before the file opened."); }
  const sequence = moveSequence;
  try {
    return await openDocumentPath(path, options, sequence, current);
  } catch (error) {
    if (current() && sequence !== moveSequence) { return openPath(path, options); }
    throw error;
  }
}

async function openDocumentPath(path: string, options: OpenPathOptions, sequence: number, current: () => boolean): Promise<string> {
  const existing = Object.values(useApp.getState().docs).find(
    (d) => d.path && normalize(d.path) === normalize(path),
  );
  let id = existing?.id;
  if (!id) {
    const fileInfo = await call<FileInfo>("inspect_file", { path });
    if (!current()) { throw new Error("The workspace changed before the file opened."); }
    let kind = fileInfo.kind;
    let disk: DiskDocument | undefined;
    try {
      if (kind === "text" || kind === "svg") {
        disk = await call<DiskDocument>("read_document", { path, force: options.force ?? false });
      }
    } catch (e) {
      if (!current()) { throw new Error("The workspace changed before the file opened."); }
      if (
        (e as { code?: string }).code === "largeFile" &&
        (await ask("Open large file?", errorMessage(e), ["Open Anyway", "Cancel"])) ===
          "Open Anyway"
      ) {
        if (!current()) { throw new Error("The workspace changed before the file opened."); }
        return openPath(path, { ...options, force: true });
      }
      if (["binary", "encoding"].includes((e as { code?: string }).code ?? "")) {
        kind = "binary";
      } else {
        throw e;
      }
    }
    // The read may have started before a disk move. Never attach its stale bytes
    // to a URI now owned by a moved document, even if the move already finished.
    if (!current()) { throw new Error("The workspace changed before the file opened."); }
    if (sequence !== moveSequence) { return openPath(path, options); }
    const duplicate = Object.values(useApp.getState().docs).find(
      (d) => d.path && normalize(d.path) === normalize(path),
    );
    if (duplicate) {
      id = duplicate.id;
    } else {
      id = `document:${crypto.randomUUID()}`;
      const language = languageFor(path);
      const doc: Doc = {
        id,
        path,
        name: basename(path),
        language,
        kind,
        fileInfo: { ...fileInfo, kind },
        encoding: disk?.encoding ?? "utf8",
        eol: disk?.eol ?? "LF",
        dirty: false,
        version: 1,
        revision: disk?.revision ?? null,
        large: options.force,
      };
      if (disk) {
        attachDocument(doc, disk.text);
      } else {
        attachPreviewDocument(doc);
      }
      if (disk && path.endsWith(".code-search")) {
        try {
          const query = JSON.parse(disk.text.split("\n")[0].replace(/^# Query: /, ""));
          patchDoc(id, { searchQuery: query });
        } catch {
          notify(
            "This Search Editor file has an invalid query header. Its text is still available for editing.",
          );
        }
      }
    }
  }
  const state = useApp.getState();
  if ((state.dataDir && normalize(path) === normalize(join(state.dataDir, "settings.json"))) ||
    (state.root && normalize(path) === normalize(join(state.root, ".litecode/settings.json")))) {
    const m = models.get(id);
    if (m) {
      try {
        const text = organizeSettings(m.getValue());
        if (text !== m.getValue()) {
          m.pushStackElement();
          m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
          m.pushStackElement();
        }
      } catch (error) {
        notify(`Settings were not organized: ${errorMessage(error)}`);
      }
    }
  }
  if (options.reveal !== false) { showDocument(id, options); }
  return id;
}

export function newDocument(text = "", name = "Untitled", searchQuery?: Doc["searchQuery"]) {
  const id = `untitled:${crypto.randomUUID()}`;
  const doc: Doc = {
    id,
    path: null,
    name,
    language: searchQuery ? "search-result" : "plaintext",
    encoding: "utf8",
    eol: "LF",
    dirty: !!text,
    version: 1,
    revision: null,
    searchQuery,
  };
  attachDocument(doc, text, !!text);
  showDocument(id, { pinned: true });
  return id;
}

export function keepOpen(id: string, groupId?: string) {
  setApp((s) => ({
    groups: s.groups.map((g) =>
      g.preview === id && (!groupId || g.id === groupId) ? { ...g, preview: null } : g,
    ),
  }));
}

export function normalizeGroup(group: Group): Group {
  const sticky = [...new Set(group.sticky ?? [])].filter((id) => group.tabs.includes(id));
  return {
    ...group,
    sticky,
    tabs: [...sticky, ...group.tabs.filter((id) => !sticky.includes(id))],
    preview:
      settingValue(useApp.getState().settings, "workbench.editor.enablePreview") &&
      group.preview && group.tabs.includes(group.preview) && !sticky.includes(group.preview)
        ? group.preview
        : null,
  };
}

export function setSticky(id: string, groupId: string, sticky: boolean) {
  setApp((s) => ({
    groups: s.groups.map((g) => {
      if (g.id !== groupId || !g.tabs.includes(id)) {
        return g;
      }
      const pinned = (g.sticky ?? []).filter((t) => t !== id);
      if (sticky) {
        pinned.push(id);
      }
      const tabs = g.tabs.filter((t) => t !== id);
      tabs.splice(pinned.length - (sticky ? 1 : 0), 0, id);
      return normalizeGroup({
        ...g,
        tabs,
        sticky: pinned,
        preview: g.preview === id ? null : g.preview,
      });
    }),
  }));
  scheduleBackup();
}

export function showDocument(
  id: string,
  options: {
    pinned?: boolean;
    group?: string;
    line?: number;
    column?: number;
    background?: boolean;
    preserveFocus?: boolean;
  } = {},
) {
  const s = useApp.getState();
  const groupId = options.group ?? s.activeGroup;
  const pinned = options.pinned || !settingValue(s.settings, "workbench.editor.enablePreview");
  if (
    options.line &&
    (s.docs[id]?.kind === "svg" || (s.docs[id] && isMarkdownDocument(s.docs[id])))
  ) {
    patchMediaView(groupId, id, { mode: "text" });
  }
  const groups = useApp.getState().groups;
  setApp({
    groups: groups.map((g) => {
      if (g.id !== groupId) {
        return g;
      }
      let tabs = [...g.tabs];
      const existing = tabs.includes(id);
      if (!existing && !pinned && g.preview && !s.docs[g.preview]?.dirty) {
        tabs = tabs.filter((t) => t !== g.preview);
      }
      if (!tabs.includes(id)) {
        tabs.push(id);
      }
      return {
        ...g,
        tabs,
        active: options.background ? g.active : id,
        preview: pinned ? (g.preview === id ? null : g.preview) : existing ? g.preview : id,
      };
    }),
    activeGroup: options.background ? s.activeGroup : groupId,
    // Reopening the already active document must also reveal its tab.
    ...(!options.background
      ? {
          view: "editor" as const,
          tabRevealRequests: {
            ...s.tabRevealRequests,
            [groupId]: (s.tabRevealRequests[groupId] ?? 0) + 1,
          },
        }
      : {}),
  });
  const visible = new Set(useApp.getState().groups.flatMap((g) => g.tabs));
  for (const tab of visible) {
    const source = useApp.getState().docs[tab]?.gitDiff?.sourceId;
    if (source) { visible.add(source); }
  }
  for (const previous of Object.values(s.docs)) {
    if (previous.id !== id && !previous.dirty && !visible.has(previous.id)) {
      disposeDocument(previous.id);
    }
  }
  if (!options.background) {
    addHistory({ id, line: options.line ?? 1, column: options.column ?? 1 });
    requestAnimationFrame(() => {
      const e = editors.get(groupId);
      if (e && options.line) {
        e.setPosition({ lineNumber: options.line, column: options.column ?? 1 });
        e.revealLineInCenterIfOutsideViewport(options.line);
      }
      if (!options.preserveFocus) {
        focusDocument(groupId);
      }
    });
  }
  scheduleBackup();
}

type AutoSaveMode = "afterDelay" | "onFocusChange" | "onWindowChange";

export async function autoSave(reason: AutoSaveMode, id?: string) {
  const current = useApp.getState().settings["files.autoSave"];
  const mode =
    reason === "onWindowChange" && current === "onFocusChange" ? "onFocusChange" : reason;
  if (current !== mode) {
    return;
  }
  const ids = reason === "onWindowChange" ? Object.keys(useApp.getState().docs) : id ? [id] : [];
  for (const documentId of ids) {
    try {
      await saveDocument(documentId, false, mode);
    } catch (e) {
      notify(errorMessage(e));
    }
  }
}

export async function save(id = activeDoc()?.id, saveAs = false) {
  if (id && useApp.getState().docs[id]?.gitDiff) {
    id = useApp.getState().docs[id].gitDiff?.sourceId;
    if (!id) { return; }
  }
  await saveDocument(id, saveAs);
}

async function queueDocumentOperation(id: string, operation: () => Promise<void>) {
  const ticket = ++saveSequence;
  const previous = saveQueues.get(id) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      if (documentMove && ticket > documentMove.drainThrough) {
        await documentMove.done;
      }
      // Reads started before a save must never replace the saved buffer.
      refreshRequests.delete(id);
      await operation();
    });
  saveQueues.set(id, current);
  try {
    await current;
  } finally {
    if (saveQueues.get(id) === current) {
      saveQueues.delete(id);
    }
  }
}

async function saveDocument(
  id: string | undefined,
  saveAs: boolean,
  autoSaveMode?: AutoSaveMode,
  resolution?: { context: ConflictContext; action: "reload" | "overwrite" },
) {
  if (!id) { return; }
  await queueDocumentOperation(id, async () => {
      let doc = useApp.getState().docs[id];
      let m = models.get(id);
      if (resolution) { checkConflictContext(resolution.context); }
      if (!doc || !m || !isTextDocument(doc)) {
        return;
      }
      if (
        autoSaveMode &&
        (useApp.getState().settings["files.autoSave"] !== autoSaveMode ||
          !doc.path ||
          !doc.dirty ||
          doc.conflict)
      ) {
        return;
      }
      let path = doc.path;
      let revision = doc.revision;
      if (resolution) {
        const { context, action } = resolution;
        const disk = await call<DiskDocument>("read_document", {
          path: context.path, force: true, encoding: context.encoding,
        });
        const fileInfo = doc.kind === "svg"
          ? await call<FileInfo>("inspect_file", { path: context.path }) : doc.fileInfo;
        checkConflictContext(context);
        if (disk.revision !== context.revision) { throw changedConflict(); }
        if (action === "reload") {
          m.pushStackElement();
          m.pushEditOperations([], [{ range: m.getFullModelRange(), text: disk.text }], () => null);
          if (m.getEOL() !== (disk.eol === "CRLF" ? "\r\n" : "\n")) {
            m.pushEOL(disk.eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
          }
          m.pushStackElement();
          savedVersions.set(id, m.getAlternativeVersionId());
          savedEncodings.set(id, disk.encoding);
          patchDoc(id, {
            dirty: false, revision: disk.revision, encoding: disk.encoding,
            eol: disk.eol, fileInfo, conflict: false, deleted: false,
          });
          scheduleBackup();
          return;
        }
        revision = context.revision;
      }
      if (!path || saveAs) {
        path = await call<string | null>("pick_path", { kind: "save" });
        if (!path) {
          return;
        }
        if (
          Object.values(useApp.getState().docs).some(
            (other) => other.id !== id && other.path && normalize(other.path) === normalize(path!),
          )
        ) {
          throw new Error(
            "This destination is already open in another editor. Close that editor before using Save As.",
          );
        }
        try {
          const disk = await call<DiskDocument>("read_document", { path, force: true });
          if ((await ask("Replace existing file?", path, ["Replace", "Cancel"])) !== "Replace") {
            return;
          }
          revision = disk.revision;
        } catch (e) {
          if ((e as { code?: string }).code !== "notFound") {
            throw e;
          }
          revision = null;
        }
      }
      if (!resolution && useApp.getState().settings["editor.formatOnSave"] === true && canFormat(doc.language)) {
        try {
          await formatModel(m);
        } catch (e) {
          notify(`Formatting failed; saving the current buffer: ${errorMessage(e)}`);
        }
        doc = useApp.getState().docs[id];
      }
      const version = doc.version;
      const alternativeVersion = m.getAlternativeVersionId();
      try {
        const newRevision = await call<string>("save_document", {
          id,
          version,
          path,
          text: m.getValue(),
          encoding: doc.encoding,
          revision,
        });
        savedVersions.set(id, alternativeVersion);
        savedEncodings.set(id, doc.encoding);
        patchDoc(id, {
          path,
          name: basename(path),
          revision: newRevision,
          dirty:
            alternativeVersion !== m.getAlternativeVersionId() ||
            useApp.getState().docs[id]?.encoding !== doc.encoding,
          conflict: false,
          deleted: false,
        });
        if (doc.kind === "svg") {
          const fileInfo = await call<FileInfo>("inspect_file", { path });
          patchDoc(id, { fileInfo });
        }
        if (saveAs || !doc.path) {
          rebindDocument(id, path);
          m = models.get(id)!;
        }
        const s = useApp.getState();
        const shortcuts = normalize(path) === normalize(join(s.dataDir, "keybindings.json"));
        if (
          shortcuts ||
          normalize(path) === normalize(join(s.dataDir, "settings.json")) ||
          (s.root && normalize(path) === normalize(join(s.root, ".litecode/settings.json")))
        ) {
          try {
            parseConfiguration(m.getValue(), shortcuts);
            const config = await call<{
              settings: Record<string, unknown>;
              keybindings: import("../types/types").Keybinding[] | null;
            }>("configuration");
            setApp({ settings: config.settings, keybindings: config.keybindings ?? [] });
          } catch (e) {
            notify(`Configuration was saved but not activated: ${errorMessage(e)}`);
          }
        }
        await checkpoint();
      } catch (e) {
        if ((e as { code?: string }).code === "conflict") {
          patchDoc(id, { conflict: true });
          if (!autoSaveMode && !resolution) { await compareDisk(id); }
        }
        throw e;
      }
  });
}

export async function saveAll() {
  for (const doc of Object.values(useApp.getState().docs)) {
    if (doc.dirty && !doc.gitDiff) {
      await save(doc.id);
    }
  }
}

export async function confirmDocumentClose(id: string): Promise<boolean> {
  const diff = useApp.getState().docs[id]?.gitDiff;
  if (diff?.sourceId) {
    const state = useApp.getState();
    const shared = state.groups.some((g) => g.tabs.some((tab) => tab !== id && (tab === diff.sourceId || state.docs[tab]?.gitDiff?.sourceId === diff.sourceId)));
    if (shared) { return true; }
    return confirmDocumentClose(diff.sourceId);
  }
  const doc = useApp.getState().docs[id];
  if (doc?.dirty) {
    const answer = await ask(
      `Save changes to ${doc.name}?`,
      "Your changes will be lost if you do not save them.",
      ["Save", "Don't Save", "Cancel"],
    );
    if (!answer || answer === "Cancel") {
      return false;
    }
    if (answer === "Save") {
      await save(id);
      if (useApp.getState().docs[id]?.dirty || !useApp.getState().docs[id]?.path) {
        return false;
      }
    }
  }
  return true;
}

export async function resetEditors() {
  documentEpoch++;
  for (const timer of autoTimers.values()) {
    clearTimeout(timer);
  }
  autoTimers.clear();
  // In-flight saves still use the models and may schedule another backup.
  await Promise.allSettled(saveQueues.values());
  clearTimeout(backupTimer);
  sessionBackupDue = undefined;
  backupRetryDelay = backupRetryAt = 0;
  backups.reset();
  for (const id of Object.keys(useApp.getState().docs)) {
    detachModel(id);
  }
  const group: Group = {
    id: crypto.randomUUID(),
    tabs: [],
    active: null,
    preview: null,
    views: {},
  };
  setApp({
    docs: {},
    groups: [group],
    activeGroup: group.id,
    editorLayout: { type: "group", id: group.id },
    groupMru: [group.id],
    tabRevealRequests: {},
    history: [],
    historyIndex: -1,
    cursor: { line: 1, column: 1, selected: 0 },
  });
}

export async function closeDocument(
  id: string,
  groupId = useApp.getState().activeGroup,
): Promise<boolean> {
  const s = useApp.getState();
  if (!s.groups.find((g) => g.id === groupId)?.tabs.includes(id)) {
    return true;
  }
  const otherView = s.groups.some((g) => g.id !== groupId && g.tabs.includes(id));
  if (!otherView && !(await confirmDocumentClose(id))) {
    return false;
  }
  removeDocumentFromGroup(id, groupId);
  return true;
}

// Deletion has already been confirmed and committed on disk. Close every view
// without a save prompt that could recreate the file or cancel the cleanup.
export function closeDeletedDocuments(paths: readonly string[]) {
  const docs = documentsAtPaths(paths).sort((a, b) => Number(!!b.gitDiff) - Number(!!a.gitDiff));
  const ids = new Set(docs.map(doc => doc.id));
  for (const doc of docs) {
    for (const group of useApp.getState().groups) {
      if (group.tabs.includes(doc.id)) { removeDocumentFromGroup(doc.id, group.id); }
    }
    if (useApp.getState().docs[doc.id]) { disposeDocument(doc.id); }
  }
  setApp(s => {
    const keep = (location: Location) => !ids.has(location.id) && !(location.path && paths.some(path => withinPath(location.path!, path)));
    return { history: s.history.filter(keep), historyIndex: s.history.slice(0, s.historyIndex + 1).filter(keep).length - 1 };
  });
  scheduleBackup();
}

function removeDocumentFromGroup(id: string, groupId: string) {
  const s = useApp.getState();
  saveEditorViews();
  setApp((s) => {
    let groups = s.groups.map((g) => {
      if (g.id !== groupId) {
        return g;
      }
      const tabs = g.tabs.filter((t) => t !== id);
      return normalizeGroup({
        ...g,
        tabs,
        active: g.active === id ? (tabs[Math.max(0, g.tabs.indexOf(id) - 1)] ?? null) : g.active,
        preview: g.preview === id ? null : g.preview,
      });
    });
    let activeGroup = s.activeGroup;
    const index = groups.findIndex((g) => g.id === groupId);
    if (groups.length > 1 && index >= 0 && !groups[index].tabs.length) {
      groups = groups.filter((g) => g.id !== groupId);
      if (activeGroup === groupId) {
        activeGroup =
          s.groupMru.find((id) => id !== groupId && groups.some((g) => g.id === id)) ??
          groups[0].id;
      }
    }
    return { groups, activeGroup };
  });
  if (!useApp.getState().groups.some((g) => g.tabs.includes(id))) {
    disposeDocument(id);
  }
  if (s.activeGroup === groupId || !useApp.getState().groups.some((g) => g.id === groupId)) {
    requestAnimationFrame(() => focusDocument());
  }
  scheduleBackup();
}

export type CloseTabsMode = "others" | "right" | "saved" | "all";
export function tabsToClose(group: Group, id: string, mode: CloseTabsMode): string[] {
  const docs = useApp.getState().docs;
  const targetIndex = group.tabs.indexOf(id);
  return group.tabs.filter(
    (tab, index) =>
      !group.sticky?.includes(tab) &&
      (mode === "all" ||
        (mode === "others" && tab !== id) ||
        (mode === "right" && index > targetIndex) ||
        (mode === "saved" && !docs[tab]?.dirty)),
  );
}

export async function closeTabs(id: string, groupId: string, mode: CloseTabsMode) {
  const group = useApp.getState().groups.find((g) => g.id === groupId);
  if (!group?.tabs.includes(id)) {
    return;
  }
  if (mode === "others") {
    keepOpen(id, groupId);
  }
  if (mode === "right" && group.active) {
    keepOpen(group.active, groupId);
  }
  for (const tab of tabsToClose(group, id, mode)) {
    const current = useApp.getState();
    if (
      current.groups.find((g) => g.id === groupId)?.sticky?.includes(tab) ||
      (mode === "saved" && current.docs[tab]?.dirty)
    ) {
      continue;
    }
    if (!(await closeDocument(tab, groupId))) {
      break;
    }
  }
}

function disposeDocument(id: string) {
  const state = useApp.getState();
  if (Object.values(state.docs).some((doc) => doc.gitDiff?.sourceId === id)) { return; }
  const source = state.docs[id]?.gitDiff?.sourceId;
  detachModel(id);
  setApp((s) => {
    const docs = { ...s.docs };
    delete docs[id];
    return { docs };
  });
  if (source && !useApp.getState().groups.some((g) => g.tabs.includes(source)) && !Object.values(useApp.getState().docs).some((doc) => doc.gitDiff?.sourceId === source)) {
    disposeDocument(source);
  }
}

function detachModel(id: string) {
  refreshRequests.delete(id);
  releaseLanguageDocument(id);
  subscriptions.get(id)?.dispose();
  subscriptions.delete(id);
  clearTimeout(autoTimers.get(id));
  autoTimers.delete(id);
  const m = models.get(id);
  if (m) {
    // Cancel the diff view model before releasing its shared source to the worker.
    for (const { editor, viewModel } of diffEditors.values()) {
      const pair = editor.getModel();
      if (pair?.original === m || pair?.modified === m) { editor.setModel(null); viewModel.dispose(); }
    }
    for (const e of editors.values()) {
      if (e.getModel() === m) {
        e.setModel(null);
      }
    }
  }
  m?.dispose();
  models.delete(id);
  savedVersions.delete(id);
  savedEncodings.delete(id);
}

export function splitGroup(
  groupId = useApp.getState().activeGroup,
  documentId?: string,
  direction?: SplitDirection,
) {
  saveEditorViews();
  const s = useApp.getState();
  const source = s.groups.find((g) => g.id === groupId);
  if (!source) {
    return s.activeGroup;
  }
  direction ??=
    s.settings["workbench.editor.openSideBySideDirection"] === "down" ? "down" : "right";
  const id = documentId ?? source.active;
  if (id && !source.tabs.includes(id)) {
    return source.id;
  }
  const group: Group = {
    id: crypto.randomUUID(),
    tabs: id ? [id] : [],
    active: id,
    preview: null,
    sticky: [],
    views: id && source.views[id] ? { [id]: source.views[id] } : {},
    mediaViews: id && source.mediaViews?.[id] ? { [id]: { ...source.mediaViews[id] } } : {},
  };
  const editorLayout = splitLayout(
    restoreLayout(
      s.editorLayout,
      s.groups.map((g) => g.id),
    ),
    source.id,
    group.id,
    direction,
  );
  const all = [...s.groups, group];
  const groups = layoutGroups(editorLayout).map((id) => all.find((g) => g.id === id)!);
  setApp({ groups, editorLayout, activeGroup: group.id });
  scheduleBackup();
  requestAnimationFrame(() => focusDocument(group.id));
  return group.id;
}

export function moveTab(id: string, from: string, to: string, before?: string) {
  saveEditorViews();
  setApp((s) => {
    const source = s.groups.find((g) => g.id === from);
    if (!source?.tabs.includes(id) || !s.groups.some((g) => g.id === to)) {
      return {};
    }
    const sticky = source.sticky?.includes(id) ?? false;
    const groups = s.groups.map((g) => {
      if (g.id !== from && g.id !== to) {
        return g;
      }
      const tabs = g.tabs.filter((t) => t !== id);
      const pinned = (g.sticky ?? []).filter((t) => t !== id);
      if (g.id === to) {
        const index = before && tabs.includes(before) ? tabs.indexOf(before) : tabs.length;
        const target = sticky ? Math.min(index, pinned.length) : Math.max(index, pinned.length);
        tabs.splice(target, 0, id);
        if (sticky) {
          pinned.splice(target, 0, id);
        }
      }
      return normalizeGroup({
        ...g,
        tabs,
        sticky: pinned,
        ...(g.id === to
          ? {
              views: { ...g.views, [id]: source.views[id] },
              mediaViews: { ...g.mediaViews, [id]: { ...source.mediaViews?.[id] } },
            }
          : {}),
        active: g.id === to ? id : g.active === id ? (tabs[0] ?? null) : g.active,
        preview: g.preview === id ? null : g.preview,
      });
    });
    return {
      groups: groups.filter(
        (g) => g.id !== from || from === to || g.tabs.length || groups.length === 1,
      ),
      activeGroup: to,
    };
  });
  scheduleBackup();
  requestAnimationFrame(() => focusDocument(to));
}

export function closeGroup(groupId: string) {
  saveEditorViews();
  const s = useApp.getState();
  const source = s.groups.find((g) => g.id === groupId);
  const targetId = s.groupMru.find((id) => id !== groupId && s.groups.some((g) => g.id === id));
  const target = s.groups.find((g) => g.id === targetId);
  if (!source || !target) {
    return;
  }
  const active = s.activeGroup === groupId ? target.id : s.activeGroup;
  setApp({
    groups: s.groups
      .filter((g) => g.id !== groupId)
      .map((g) =>
        g.id !== target.id
          ? g
          : normalizeGroup({
              ...g,
              views: { ...source.views, ...g.views },
              mediaViews: { ...source.mediaViews, ...g.mediaViews },
              sticky: [...(g.sticky ?? []), ...(source.sticky ?? [])],
              tabs: [...new Set([...g.tabs, ...source.tabs])],
              active:
                s.activeGroup === groupId
                  ? (source.active ?? g.active)
                  : (g.active ?? source.active),
            }),
      ),
    activeGroup: active,
  });
  scheduleBackup();
  requestAnimationFrame(() => focusDocument(active));
}

export function addHistory(location: Location) {
  location = { ...location, path: useApp.getState().docs[location.id]?.path ?? location.path };
  setApp((s) => {
    const current = s.history[s.historyIndex];
    if (current?.id === location.id && Math.abs(current.line - location.line) < 5) {
      return {};
    }
    const history = [...s.history.slice(0, s.historyIndex + 1), location].slice(-200);
    return { history, historyIndex: history.length - 1 };
  });
}
export async function navigate(direction: number) {
  const s = useApp.getState();
  const index = s.historyIndex + direction;
  const location = s.history[index];
  if (!location) {
    return;
  }
  if (!s.docs[location.id]) {
    const uri = monaco.Uri.parse(location.id);
    const path = location.path ?? (uri.scheme === "file" ? uri.fsPath : null);
    if (!path) {
      return;
    }
    const id = await openPath(path, { pinned: true, line: location.line, column: location.column });
    if (id) {
      location.id = id;
    }
  }
  showDocument(location.id, { pinned: true, line: location.line, column: location.column });
  setApp({ history: s.history, historyIndex: index });
}

export async function refreshDocuments(changedPaths?: readonly string[]) {
  const affected = changedPaths?.map((path) => normalize(path).replace(/\/$/, ""));
  for (const id of Object.keys(useApp.getState().docs)) {
    await saveQueues.get(id)?.catch(() => {});
    const doc = useApp.getState().docs[id];
    if (!doc) { continue; }
    if (doc.path && affected && !affected.some((path) => normalize(doc.path!) === path || normalize(doc.path!).startsWith(path + "/"))) {continue;}
    if (!doc.path || isMoving(doc.path)) {
      continue;
    }
    const request = Symbol();
    refreshRequests.set(id, request);
    const isCurrent = () => refreshRequests.get(id) === request &&
      useApp.getState().docs[id] === doc && !saveQueues.has(id) &&
      !!doc.path && !isMoving(doc.path);
    try {
      const info = await call<FileInfo>("inspect_file", { path: doc.path });
      const current = useApp.getState().docs[doc.id];
      if (!current || !isCurrent()) {
        continue;
      }
      if (!isTextDocument(doc)) {
        if (info.kind === "text" || info.kind === "svg") {
          try {
            const disk = await call<DiskDocument>("read_document", { path: doc.path, force: true });
            if (!isCurrent()) {
              continue;
            }
            attachDocument(
              {
                ...current,
                kind: info.kind,
                fileInfo: info,
                encoding: disk.encoding,
                eol: disk.eol,
                revision: disk.revision,
                deleted: false,
                conflict: false,
              },
              disk.text,
            );
          } catch (e) {
            if (!isCurrent()) { continue; }
            if (!["binary", "encoding"].includes((e as { code?: string }).code ?? "")) {
              throw e;
            }
            patchDoc(doc.id, {
              kind: "binary",
              fileInfo: { ...info, kind: "binary" },
              deleted: false,
              conflict: false,
              imageSize: undefined,
            });
          }
        } else {
          patchDoc(doc.id, { kind: info.kind, fileInfo: info, deleted: false, conflict: false });
        }
        continue;
      }
      if (info.kind !== "text" && info.kind !== "svg") {
        if (current.dirty) {
          patchDoc(doc.id, { conflict: true, deleted: false });
          continue;
        }
        detachModel(doc.id);
        patchDoc(doc.id, {
          kind: info.kind,
          fileInfo: info,
          deleted: false,
          conflict: false,
          imageSize: undefined,
        });
        continue;
      }
      const disk = await call<DiskDocument>("read_document", {
        path: doc.path,
        force: true,
        encoding: doc.encoding,
      });
      const latest = useApp.getState().docs[doc.id];
      if (!latest || !isCurrent()) {
        continue;
      }
      if (disk.revision === latest.revision) {
        patchDoc(doc.id, { kind: info.kind, fileInfo: info, deleted: false, ...(latest.deleted ? { conflict: false } : {}) });
        continue;
      }
      if (latest.dirty) {
        patchDoc(doc.id, { conflict: true, deleted: false });
        continue;
      }
      const m = models.get(doc.id);
      if (!m) {
        continue;
      }
      m.setValue(disk.text);
      savedVersions.set(doc.id, m.getAlternativeVersionId());
      savedEncodings.set(doc.id, disk.encoding);
      patchDoc(doc.id, {
        revision: disk.revision,
        kind: info.kind,
        fileInfo: info,
        dirty: false,
        conflict: false,
        deleted: false,
        encoding: disk.encoding,
        eol: disk.eol,
      });
    } catch (e) {
      const latest = useApp.getState().docs[doc.id];
      if (!latest || !isCurrent()) {
        continue;
      }
      if ((e as { code?: string }).code === "notFound") {
        patchDoc(doc.id, { deleted: true, conflict: isTextDocument(latest) });
      } else if (["binary", "encoding"].includes((e as { code?: string }).code ?? "")) {
        if (latest.dirty) {
          patchDoc(doc.id, { conflict: true, deleted: false });
        } else {
          detachModel(doc.id);
          patchDoc(doc.id, { kind: "binary", imageSize: undefined });
        }
      } else {
        notify(`Could not refresh ${doc.name}: ${errorMessage(e)}`);
      }
    }
  }
}

export async function readConflictDiff(id: string): Promise<DiffRequest> {
  const doc = useApp.getState().docs[id];
  if (!doc?.path || !models.has(id)) { throw changedConflict(); }
  let disk: DiskDocument | undefined;
  let error: string | undefined;
  try {
    disk = await call("read_document", { path: doc.path, force: true, encoding: doc.encoding });
  } catch (e) {
    error = `无法读取磁盘版本：${errorMessage(e)}`;
  }
  const latest = useApp.getState().docs[id];
  const m = models.get(id);
  if (!latest || latest.path !== doc.path || latest.encoding !== doc.encoding || !m) {
    throw changedConflict();
  }
  return {
    title: `${latest.name} · 解决保存冲突`,
    before: disk?.text ?? "", after: m.getValue(), language: latest.language, error,
    conflict: { id, path: latest.path!, version: latest.version,
      revision: disk?.revision ?? null, encoding: latest.encoding },
  };
}

export async function compareDisk(id: string) {
  const diff = await readConflictDiff(id);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<DiffRequest>("show-diff", { detail: diff }));
  }
}

function changedConflict() {
  return { code: "conflict", message: "文件或编辑内容已变化，请查看更新后的差异，再次选择最终版本。" };
}

function checkConflictContext(context: ConflictContext) {
  const doc = useApp.getState().docs[context.id];
  if (!doc || !models.has(context.id) || !doc.conflict ||
    doc.path !== context.path || doc.version !== context.version ||
    doc.encoding !== context.encoding || context.revision === null) {
    throw changedConflict();
  }
}

export async function resolveConflict(context: ConflictContext, action: "reload" | "overwrite") {
  await saveDocument(context.id, false, undefined, { context, action });
}

export async function renameDocumentPaths(from: string, to: string) {
  await renameDocuments([{ from, to }]);
}

export async function renameDocuments(moves: FileMove[]) {
  checkDocumentMoves(moves);
  for (const doc of Object.values(useApp.getState().docs)) {
    if (!doc.path) {
      continue;
    }
    const path = movedDocumentPath(doc.path, moves);
    if (!path) {
      continue;
    }
    rebindDocument(doc.id, path);
  }
  await checkpoint();
}

function rebindDocument(id: string, path: string) {
  const doc = useApp.getState().docs[id];
  const old = models.get(id);
  if (!doc) {
    return;
  }
  if (!old) {
    patchDoc(id, { path, name: basename(path), deleted: false });
    setApp((s) => ({
      history: s.history.map((location) => (location.id === id ? { ...location, path } : location)),
    }));
    return;
  }
  const uri = monaco.Uri.file(visiblePath(path));
  const target = monaco.editor.getModel(uri);
  if (target && target !== old) { throw occupiedDestination(); }
  if (target === old || old.uri.toString() === uri.toString()) {
    patchDoc(id, { path, name: basename(path), deleted: false });
    setApp((s) => ({
      history: s.history.map((location) => (location.id === id ? { ...location, path } : location)),
    }));
    return;
  }
  const views = [...editors.values()]
    .filter((e) => e.getModel() === old)
    .map((e) => ({ e, view: e.saveViewState() }));
  const text = old.getValue();
  releaseLanguageDocument(id);
  subscriptions.get(id)?.dispose();
  subscriptions.delete(id);
  savedVersions.delete(id);
  savedEncodings.delete(id);
  const next = attachDocument(
    { ...doc, path, name: basename(path), language: languageFor(path), deleted: false },
    text,
    doc.dirty,
  );
  setApp((s) => ({
    history: s.history.map((location) => (location.id === id ? { ...location, path } : location)),
  }));
  for (const { e, view } of views) {
    e.setModel(next);
    if (view) {
      e.restoreViewState(view);
    }
  }
  old.dispose();
}
