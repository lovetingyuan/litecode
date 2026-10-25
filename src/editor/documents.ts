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

export const models = new Map<string, monaco.editor.ITextModel>();
export const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>();
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
let autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
let checkpointQueue = Promise.resolve();
let saveSequence = 0;
let documentMove: { paths: string[]; done: Promise<void>; drainThrough: number } | null = null;

export async function beginDocumentMove(paths: string[]) {
  if (documentMove) {
    await documentMove.done;
  }
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const draining = [...saveQueues.values()];
  documentMove = { paths, done, drainThrough: saveSequence };
  // Finish saves already in flight; subsequent saves read the rebound path.
  await Promise.allSettled(draining);
  // Backups authorize document paths too. Drain old snapshots before disk moves,
  // and defer new snapshots until every descendant has its rebound path.
  await checkpointQueue.catch(() => {});
  return () => {
    documentMove = null;
    release();
    scheduleBackup();
  };
}

function isMoving(path: string) {
  return (
    documentMove?.paths.some(
      (source) =>
        normalize(path) === normalize(source) ||
        normalize(path).startsWith(normalize(source) + "/"),
    ) ?? false
  );
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
  return doc && !isTextView(doc, group) ? undefined : editors.get(s.activeGroup);
};
export const model = (id = activeDoc()?.id) => (id ? models.get(id) : undefined);

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
  if (!doc || isTextView(doc, group)) {
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

export async function checkpoint() {
  if (!desktop || documentMove) {
    return;
  }
  const docs: Mirror[] = Object.values(useApp.getState().docs).map((doc) => {
    const m = models.get(doc.id);
    return {
      id: doc.id,
      path: doc.path,
      text: m?.getValue() ?? "",
      version: doc.version,
      revision: doc.revision,
      encoding: doc.encoding,
      dirty: doc.dirty,
      language: doc.language,
      name: doc.name,
      searchQuery: doc.searchQuery,
      kind: doc.kind,
      fileInfo: doc.fileInfo,
    };
  });
  const currentSession = session();
  checkpointQueue = checkpointQueue
    .catch(() => {})
    .then(() => call<void>("sync_documents", { documents: docs, session: currentSession }));
  await checkpointQueue;
}
export function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(
    () => void checkpoint().catch((e) => notify(`Backup failed: ${errorMessage(e)}`)),
    400,
  );
}

export function attachDocument(doc: Doc, text: string, initiallyDirty = false) {
  if (!monaco.languages.getLanguages().some((l) => l.id === doc.language)) {
    monaco.languages.register({ id: doc.language });
  }
  const uri = doc.path ? monaco.Uri.file(visiblePath(doc.path)) : monaco.Uri.parse(doc.id);
  const m = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, doc.language, uri);
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

export function restoreDocument(mirror: Mirror) {
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
}

function attachPreviewDocument(doc: Doc) {
  setApp((s) => ({ docs: { ...s.docs, [doc.id]: { ...doc, dirty: false } } }));
  scheduleBackup();
}

export async function openPath(
  path: string,
  options: {
    pinned?: boolean;
    group?: string;
    line?: number;
    column?: number;
    background?: boolean;
    preserveFocus?: boolean;
    force?: boolean;
  } = {},
) {
  const existing = Object.values(useApp.getState().docs).find(
    (d) => d.path && normalize(d.path) === normalize(path),
  );
  let id = existing?.id;
  if (!id) {
    const fileInfo = await call<FileInfo>("inspect_file", { path });
    let kind = fileInfo.kind;
    let disk: DiskDocument | undefined;
    try {
      if (kind === "text" || kind === "svg") {
        disk = await call<DiskDocument>("read_document", { path, force: options.force ?? false });
      }
    } catch (e) {
      if (
        (e as { code?: string }).code === "largeFile" &&
        (await ask("Open large file?", errorMessage(e), ["Open Anyway", "Cancel"])) ===
          "Open Anyway"
      ) {
        return openPath(path, { ...options, force: true });
      }
      if (["binary", "encoding"].includes((e as { code?: string }).code ?? "")) {
        kind = "binary";
      } else {
        throw e;
      }
    }
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
  showDocument(id, options);
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
    if (doc.dirty) {
      await save(doc.id);
    }
  }
}

export async function confirmDocumentClose(id: string): Promise<boolean> {
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
  for (const timer of autoTimers.values()) {
    clearTimeout(timer);
  }
  autoTimers.clear();
  // In-flight saves still use the models and may schedule another backup.
  await Promise.allSettled(saveQueues.values());
  clearTimeout(backupTimer);
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
  return true;
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
  detachModel(id);
  setApp((s) => {
    const docs = { ...s.docs };
    delete docs[id];
    return { docs };
  });
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
          patchDoc(doc.id, { conflict: true });
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
        patchDoc(doc.id, { kind: info.kind, fileInfo: info, deleted: false });
        continue;
      }
      if (latest.dirty) {
        patchDoc(doc.id, { conflict: true });
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
          patchDoc(doc.id, { conflict: true });
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

export async function renameDocuments(moves: { from: string; to: string }[]) {
  for (const doc of Object.values(useApp.getState().docs)) {
    if (!doc.path) {
      continue;
    }
    const move = moves.find(
      ({ from }) =>
        normalize(doc.path!) === normalize(from) ||
        normalize(doc.path!).startsWith(normalize(from) + "/"),
    );
    if (!move) {
      continue;
    }
    const path = move.to + doc.path.slice(move.from.length);
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
  if (old.uri.toString() === uri.toString()) {
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
