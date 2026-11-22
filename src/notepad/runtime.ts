import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, desktop, errorMessage } from "../core/bridge";
import { loadSyntax, monaco } from "../editor/monaco";
import { notify, setApp, useApp } from "../store/store";
import type {
  NoteMeta,
  NotepadCreateResponse,
  NotepadDropPosition,
  NotepadEvent,
  NotepadLoadResponse,
  NotepadNoteContent,
  NotepadSaveResponse,
  NotepadSnapshot,
  NotepadSort,
} from "../types/notepad";
import {
  DEFAULT_NOTEPAD_FORMAT,
  computeTextStats,
  formatLanguage,
  makePreview,
  normalizeNotepadSort,
  parseTitleAndFormat,
  resolveFormat,
  sortNotes,
} from "./formats";
import {
  canReorderNotes,
  closeTabFromList,
  isReorderNoOp,
  isSyntaxHighlightEnabled,
  moveIdInList,
  reconcileSnapshot,
  reorderNotesByIds,
  syncTabsToNoteOrder,
  useNotepad,
} from "./state";

const SAVE_DEBOUNCE_MS = 250;
const BROWSER_STORAGE_KEY = "litecode.notepad.v1";

type BrowserStoreData = {
  revision: number;
  notes: NoteMeta[];
  activeId: string | null;
  openTabs: string[];
  sort?: NotepadSort;
  contents: Record<string, string>;
};

const notepadModels = new Map<string, monaco.editor.ITextModel>();
const modelSubscriptions = new Map<string, monaco.IDisposable>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const pendingSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; content: string }>();
const inFlightSaves = new Map<string, Promise<void>>();
const applyingRemote = new Set<string>();
const readingNotes = new Map<string, Promise<string>>();

let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;
let loadPromise: Promise<void> | undefined;
let syncInstalled = false;
let windowLabel = "main";
let orderMutationSeq = 0;
let pendingOrderMutations = 0;

function readBrowserStore(): BrowserStoreData {
  try {
    const raw = localStorage.getItem(BROWSER_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        "notes" in parsed &&
        Array.isArray(parsed.notes)
      ) {
        return parsed as BrowserStoreData; // Guarded by runtime shape check above for browser-only fallback storage.
      }
    }
  } catch {
    // Ignore invalid browser storage and initialize a fresh default note.
  }
  const now = Date.now();
  const id = `note-${now.toString(16)}`;
  const initial: NoteMeta = {
    id,
    title: "Note 1",
    format: DEFAULT_NOTEPAD_FORMAT,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    preview: "",
    revision: 1,
  };
  const data: BrowserStoreData = {
    revision: 1,
    notes: [initial],
    activeId: id,
    openTabs: [id],
    sort: "manual",
    contents: { [id]: "" },
  };
  writeBrowserStore(data);
  return data;
}

function writeBrowserStore(data: BrowserStoreData) {
  try {
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage quota errors in browser dev mode.
  }
}

function browserSnapshot(data: BrowserStoreData): NotepadSnapshot {
  return {
    revision: data.revision,
    notes: data.notes,
    activeId: data.activeId,
    openTabs: data.openTabs,
    sort: normalizeNotepadSort(data.sort),
  };
}

function updateSavingFlag() {
  useNotepad.setState({ saving: pendingSaves.size > 0 || inFlightSaves.size > 0 });
}

function noteUri(id: string) {
  return monaco.Uri.parse(`notepad://note/${encodeURIComponent(id)}`);
}

function updateActiveStats(id: string, text: string) {
  if (useNotepad.getState().activeId === id) {
    useNotepad.setState({ stats: computeTextStats(text) });
  }
}

export function getNotepadModel(id: string): monaco.editor.ITextModel | undefined {
  return notepadModels.get(id);
}

function modelLanguageForNote(
  id: string,
  format: string,
  syntaxHighlight: Readonly<Record<string, boolean>>,
): string {
  return isSyntaxHighlightEnabled(syntaxHighlight, id) ? formatLanguage(format) : "plaintext";
}

function applyNotepadModelLanguage(
  id: string,
  model: monaco.editor.ITextModel,
  format: string,
  ensureLoaded = false,
) {
  if (model.isDisposed()) {
    return;
  }
  const language = modelLanguageForNote(id, format, useNotepad.getState().syntaxHighlight);
  if (language === "plaintext") {
    if (model.getLanguageId() !== "plaintext") {
      monaco.editor.setModelLanguage(model, "plaintext");
    }
    return;
  }
  if (!ensureLoaded && model.getLanguageId() === language) {
    return;
  }
  void loadSyntax(language)
    .then(() => {
      if (model.isDisposed()) {
        return;
      }
      const state = useNotepad.getState();
      const note = state.notes.find((n) => n.id === id);
      const desired = modelLanguageForNote(id, note?.format ?? format, state.syntaxHighlight);
      if (desired === language && model.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(model, language);
      }
    })
    .catch(() => {});
}

export function ensureNotepadModel(id: string, format: string, initialText: string) {
  const existing = notepadModels.get(id);
  if (existing && !existing.isDisposed()) {
    applyNotepadModelLanguage(id, existing, format);
    return existing;
  }
  const language = modelLanguageForNote(id, format, useNotepad.getState().syntaxHighlight);
  const uri = noteUri(id);
  const reused = monaco.editor.getModel(uri);
  const model = reused ?? monaco.editor.createModel(initialText, language, uri);
  if (reused && reused.getValue() !== initialText) {
    applyingRemote.add(id);
    try {
      reused.setValue(initialText);
    } finally {
      applyingRemote.delete(id);
    }
  }
  model.updateOptions({ tabSize: 4, insertSpaces: true });
  applyNotepadModelLanguage(id, model, format, true);
  notepadModels.set(id, model);
  modelSubscriptions.get(id)?.dispose();
  modelSubscriptions.set(
    id,
    model.onDidChangeContent(() => {
      if (applyingRemote.has(id)) {
        return;
      }
      const text = model.getValue();
      const preview = makePreview(text);
      useNotepad.setState((s) => ({
        contents: { ...s.contents, [id]: text },
        notes: s.notes.map((n) => (n.id === id ? { ...n, preview } : n)),
        ...(s.activeId === id ? { stats: computeTextStats(text) } : {}),
      }));
      scheduleNoteSave(id, text);
    }),
  );
  return model;
}

function disposeNotepadModel(id: string) {
  const pending = pendingSaves.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(id);
  }
  modelSubscriptions.get(id)?.dispose();
  modelSubscriptions.delete(id);
  const model = notepadModels.get(id);
  notepadModels.delete(id);
  viewStates.delete(id);
  if (model && !model.isDisposed()) {
    if (editorInstance?.getModel() === model) {
      editorInstance.setModel(null);
    }
    model.dispose();
  }
  updateSavingFlag();
}

function applyRemoteContentToModel(id: string, content: string) {
  const model = notepadModels.get(id);
  if (!model || model.isDisposed() || model.getValue() === content) {
    return;
  }
  const activeOnEditor = editorInstance?.getModel() === model;
  const savedSelections = activeOnEditor ? editorInstance?.getSelections() : null;
  applyingRemote.add(id);
  try {
    model.applyEdits([{ range: model.getFullModelRange(), text: content }]);
    if (activeOnEditor && savedSelections && editorInstance) {
      editorInstance.setSelections(savedSelections);
    }
  } finally {
    applyingRemote.delete(id);
  }
}

function syncModelLanguages(notes: readonly NoteMeta[]) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  for (const [id, model] of notepadModels.entries()) {
    const meta = byId.get(id);
    if (!meta) {
      disposeNotepadModel(id);
      continue;
    }
    applyNotepadModelLanguage(id, model, meta.format);
  }
}

function scheduleNoteSave(id: string, content: string) {
  const existing = pendingSaves.get(id);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pendingSaves.delete(id);
    void persistNoteContent(id, content);
  }, SAVE_DEBOUNCE_MS);
  pendingSaves.set(id, { timer, content });
  updateSavingFlag();
}

async function persistNoteContent(id: string, content: string) {
  const previous = inFlightSaves.get(id) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      if (!useNotepad.getState().notes.some((n) => n.id === id)) {
        return;
      }
      if (desktop) {
        const result = await call<NotepadSaveResponse>("notepad_save_content", { id, content });
        useNotepad.setState((s) => ({
          ...reconcileSnapshot(s, result.snapshot),
          lastSavedAt: Date.now(),
        }));
      } else {
        const data = readBrowserStore();
        const note = data.notes.find((n) => n.id === id);
        if (note) {
          note.updatedAt = Date.now();
          note.preview = makePreview(content);
          note.revision += 1;
          data.revision += 1;
          data.contents[id] = content;
          writeBrowserStore(data);
          useNotepad.setState((s) => ({
            ...reconcileSnapshot(s, browserSnapshot(data)),
            lastSavedAt: Date.now(),
          }));
        }
      }
    })
    .catch((error) => {
      notify(`Could not save note: ${errorMessage(error)}`);
    })
    .finally(() => {
      if (inFlightSaves.get(id) === task) {
        inFlightSaves.delete(id);
      }
      updateSavingFlag();
    });
  inFlightSaves.set(id, task);
  updateSavingFlag();
  await task;
}

export async function flushNotepadSaves() {
  const entries = [...pendingSaves.entries()];
  for (const [id, entry] of entries) {
    clearTimeout(entry.timer);
    pendingSaves.delete(id);
    void persistNoteContent(id, entry.content);
  }
  await Promise.allSettled(inFlightSaves.values());
}

function handleRemoteEvent(event: NotepadEvent) {
  if (
    event.sourceWindow === windowLabel &&
    (pendingOrderMutations > 0 || event.revision <= useNotepad.getState().revision)
  ) {
    return;
  }
  const current = useNotepad.getState();
  const reconciled = reconcileSnapshot(current, event.snapshot);
  const updated = event.updatedNote;
  if (updated && !pendingSaves.has(updated.id) && !inFlightSaves.has(updated.id)) {
    reconciled.contents[updated.id] = updated.content;
    applyRemoteContentToModel(updated.id, updated.content);
  }
  useNotepad.setState((s) => ({
    ...reconciled,
    ...(updated && s.activeId === updated.id && !pendingSaves.has(updated.id)
      ? { stats: computeTextStats(updated.content) }
      : {}),
  }));
  syncModelLanguages(event.snapshot.notes);
}

function installGlobalSync() {
  if (syncInstalled) {
    return;
  }
  syncInstalled = true;
  if (desktop) {
    windowLabel = getCurrentWindow().label;
    void listen<NotepadEvent>("notepad-changed", ({ payload }) => {
      handleRemoteEvent(payload);
    }).catch((error) => notify(errorMessage(error)));
  } else {
    window.addEventListener("storage", (event) => {
      if (event.key !== BROWSER_STORAGE_KEY) {
        return;
      }
      const data = readBrowserStore();
      const current = useNotepad.getState();
      const reconciled = reconcileSnapshot(current, browserSnapshot(data));
      for (const [id, text] of Object.entries(data.contents)) {
        if (!pendingSaves.has(id)) {
          reconciled.contents[id] = text;
          applyRemoteContentToModel(id, text);
        }
      }
      useNotepad.setState(reconciled);
      syncModelLanguages(data.notes);
    });
  }
}

async function persistTabs(openTabs: string[], activeId: string | null) {
  if (desktop) {
    await call<NotepadSnapshot>("notepad_set_tabs", { openTabs, activeId }).catch(() => {});
  } else {
    const data = readBrowserStore();
    data.openTabs = openTabs;
    data.activeId = activeId;
    writeBrowserStore(data);
  }
}

export async function ensureNoteContentLoaded(id: string): Promise<string> {
  const existing = useNotepad.getState().contents[id];
  if (existing !== undefined) {
    return existing;
  }
  const inflight = readingNotes.get(id);
  if (inflight) {
    return inflight;
  }
  const request = (async () => {
    if (desktop) {
      const result = await call<NotepadNoteContent>("notepad_read", { id });
      if (!pendingSaves.has(id)) {
        useNotepad.setState((s) => ({
          contents: { ...s.contents, [id]: result.content },
          ...(s.activeId === id ? { stats: computeTextStats(result.content) } : {}),
        }));
        applyRemoteContentToModel(id, result.content);
      }
      return result.content;
    }
    const data = readBrowserStore();
    const content = data.contents[id] ?? "";
    useNotepad.setState((s) => ({
      contents: { ...s.contents, [id]: content },
      ...(s.activeId === id ? { stats: computeTextStats(content) } : {}),
    }));
    return content;
  })().finally(() => {
    readingNotes.delete(id);
  });
  readingNotes.set(id, request);
  return request;
}

export async function ensureNotepadLoaded(forceRefresh = false) {
  installGlobalSync();
  if (useNotepad.getState().loaded && !forceRefresh) {
    return;
  }
  if (loadPromise && !forceRefresh) {
    return loadPromise;
  }
  const run = (async () => {
    useNotepad.setState({ loading: !useNotepad.getState().loaded });
    try {
      const response: NotepadLoadResponse = desktop
        ? await call<NotepadLoadResponse>("notepad_load")
        : (() => {
            const data = readBrowserStore();
            return { snapshot: browserSnapshot(data), contents: data.contents };
          })();
      const current = useNotepad.getState();
      const adoptTabs = !current.loaded;
      const reconciled = reconcileSnapshot(current, response.snapshot, { adoptTabs });
      for (const [id, text] of Object.entries(response.contents)) {
        if (!pendingSaves.has(id) && !inFlightSaves.has(id)) {
          reconciled.contents[id] = text;
          applyRemoteContentToModel(id, text);
        }
      }
      const activeText = reconciled.activeId
        ? (reconciled.contents[reconciled.activeId] ?? "")
        : "";
      useNotepad.setState({
        ...reconciled,
        loaded: true,
        loading: false,
        stats: computeTextStats(activeText),
      });
      syncModelLanguages(response.snapshot.notes);
    } finally {
      useNotepad.setState({ loading: false });
    }
  })();
  loadPromise = run.finally(() => {
    if (loadPromise === run) {
      loadPromise = undefined;
    }
  });
  return loadPromise;
}

export function showNotepad(toggle = false) {
  if (!useApp.getState().ready) {
    return;
  }
  if (toggle && useApp.getState().view === "notepad") {
    void flushNotepadSaves();
    setApp({ view: "editor" });
    return;
  }
  setApp({ view: "notepad" });
  void ensureNotepadLoaded(true).catch((error) => notify(errorMessage(error)));
  requestAnimationFrame(() => focusNotepadEditor());
}

export async function selectNote(id: string) {
  const state = useNotepad.getState();
  const note = state.notes.find((n) => n.id === id);
  if (!note) {
    return;
  }
  const openTabs = state.openTabs.includes(id)
    ? state.openTabs
    : syncTabsToNoteOrder(
        [...state.openTabs, id],
        sortNotes(state.notes, state.sort).map((n) => n.id),
      );
  const cached = state.contents[id];
  useNotepad.setState({
    activeId: id,
    openTabs,
    ...(cached !== undefined ? { stats: computeTextStats(cached) } : {}),
  });
  void persistTabs(openTabs, id);
  const content = cached ?? (await ensureNoteContentLoaded(id));
  ensureNotepadModel(id, note.format, content);
  updateActiveStats(id, content);
  requestAnimationFrame(() => focusNotepadEditor());
}

export async function createNote(options?: { title?: string; format?: string; content?: string }) {
  await ensureNotepadLoaded();
  const format = resolveFormat(options?.format ?? DEFAULT_NOTEPAD_FORMAT).id;
  if (desktop) {
    const created = await call<NotepadCreateResponse>("notepad_create", {
      title: options?.title ?? null,
      format,
      content: options?.content ?? "",
    });
    useNotepad.setState((s) => {
      const openTabs = s.openTabs.includes(created.note.id)
        ? s.openTabs
        : [...s.openTabs, created.note.id];
      return {
        ...reconcileSnapshot({ ...s, openTabs, activeId: created.note.id }, created.snapshot),
        contents: { ...s.contents, [created.note.id]: created.content },
        stats: computeTextStats(created.content),
      };
    });
    ensureNotepadModel(created.note.id, created.note.format, created.content);
    requestAnimationFrame(() => focusNotepadEditor());
    return created.note;
  }
  const data = readBrowserStore();
  const now = Date.now();
  const id = `note-${crypto.randomUUID()}`;
  let index = 1;
  const existingTitles = new Set(data.notes.map((n) => n.title.toLowerCase()));
  while (existingTitles.has(`note ${index}`)) {
    index++;
  }
  const content = options?.content ?? "";
  const note: NoteMeta = {
    id,
    title: options?.title?.trim() || `Note ${index}`,
    format,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    preview: makePreview(content),
    revision: 1,
  };
  data.revision += 1;
  data.notes.unshift(note);
  data.openTabs = syncTabsToNoteOrder(
    [...data.openTabs, id],
    sortNotes(data.notes, normalizeNotepadSort(data.sort)).map((n) => n.id),
  );
  data.activeId = id;
  data.contents[id] = content;
  writeBrowserStore(data);
  useNotepad.setState((s) => ({
    ...reconcileSnapshot(
      { ...s, openTabs: [...s.openTabs, id], activeId: id },
      browserSnapshot(data),
    ),
    contents: { ...s.contents, [id]: content },
    stats: computeTextStats(content),
  }));
  ensureNotepadModel(id, note.format, content);
  requestAnimationFrame(() => focusNotepadEditor());
  return note;
}

export async function renameNote(id: string, rawInput: string) {
  const note = useNotepad.getState().notes.find((n) => n.id === id);
  if (!note) {
    return;
  }
  const parsed = parseTitleAndFormat(rawInput, note.format);
  if (!parsed) {
    return;
  }
  await updateNoteMeta(id, { title: parsed.title, format: parsed.format });
}

export async function changeNoteFormat(id: string, format: string) {
  await updateNoteMeta(id, { format: resolveFormat(format).id });
}

export async function togglePinNote(id: string) {
  const note = useNotepad.getState().notes.find((n) => n.id === id);
  if (!note) {
    return;
  }
  await updateNoteMeta(id, { pinned: !note.pinned });
}

async function updateNoteMeta(
  id: string,
  patch: { title?: string; format?: string; pinned?: boolean },
) {
  if (desktop) {
    const snapshot = await call<NotepadSnapshot>("notepad_update_meta", {
      id,
      title: patch.title ?? null,
      format: patch.format ?? null,
      pinned: patch.pinned ?? null,
    });
    useNotepad.setState((s) => reconcileSnapshot(s, snapshot));
    syncModelLanguages(snapshot.notes);
  } else {
    const data = readBrowserStore();
    const note = data.notes.find((n) => n.id === id);
    if (!note) {
      return;
    }
    if (patch.title !== undefined) {
      note.title = patch.title;
    }
    if (patch.format !== undefined) {
      note.format = resolveFormat(patch.format).id;
    }
    if (patch.pinned !== undefined) {
      note.pinned = patch.pinned;
    }
    note.updatedAt = Date.now();
    note.revision += 1;
    data.revision += 1;
    writeBrowserStore(data);
    const snapshot = browserSnapshot(data);
    useNotepad.setState((s) => reconcileSnapshot(s, snapshot));
    syncModelLanguages(snapshot.notes);
  }
}

export async function duplicateNote(id: string) {
  const note = useNotepad.getState().notes.find((n) => n.id === id);
  if (!note) {
    return;
  }
  const content = await ensureNoteContentLoaded(id);
  return createNote({
    title: `${note.title} (Copy)`,
    format: note.format,
    content,
  });
}

export async function deleteNote(id: string) {
  disposeNotepadModel(id);
  if (desktop) {
    const snapshot = await call<NotepadSnapshot>("notepad_delete", { id });
    useNotepad.setState((s) => {
      const next = reconcileSnapshot(s, snapshot);
      const activeText = next.activeId ? (next.contents[next.activeId] ?? "") : "";
      return { ...next, stats: computeTextStats(activeText) };
    });
  } else {
    const data = readBrowserStore();
    data.notes = data.notes.filter((n) => n.id !== id);
    const nextTabs = closeTabFromList(data.openTabs, data.activeId, id);
    data.openTabs = nextTabs.openTabs;
    data.activeId = nextTabs.activeId ?? data.notes[0]?.id ?? null;
    if (data.activeId && !data.openTabs.includes(data.activeId)) {
      data.openTabs.push(data.activeId);
    }
    delete data.contents[id];
    data.revision += 1;
    writeBrowserStore(data);
    const snapshot = browserSnapshot(data);
    useNotepad.setState((s) => {
      const next = reconcileSnapshot(s, snapshot);
      const activeText = next.activeId ? (next.contents[next.activeId] ?? "") : "";
      return { ...next, stats: computeTextStats(activeText) };
    });
  }
  const nextActive = useNotepad.getState().activeId;
  if (nextActive) {
    void ensureNoteContentLoaded(nextActive).catch(() => {});
  }
}

export async function closeNotepadTab(id: string) {
  if (pendingSaves.has(id)) {
    const pending = pendingSaves.get(id)!;
    clearTimeout(pending.timer);
    pendingSaves.delete(id);
    await persistNoteContent(id, pending.content);
  }
  const state = useNotepad.getState();
  const next = closeTabFromList(state.openTabs, state.activeId, id);
  const nextText = next.activeId ? (state.contents[next.activeId] ?? "") : "";
  useNotepad.setState({
    openTabs: next.openTabs,
    activeId: next.activeId,
    stats: computeTextStats(nextText),
  });
  void persistTabs(next.openTabs, next.activeId);
  if (next.activeId) {
    void ensureNoteContentLoaded(next.activeId).catch(() => {});
  }
}

export function closeOtherNotepadTabs(keepId: string) {
  const state = useNotepad.getState();
  if (!state.notes.some((n) => n.id === keepId)) {
    return;
  }
  const openTabs = [keepId];
  useNotepad.setState({ openTabs, activeId: keepId });
  void persistTabs(openTabs, keepId);
}

export async function reorderNotepadNotes(
  sourceId: string,
  targetId: string,
  position: NotepadDropPosition = "before",
) {
  const state = useNotepad.getState();
  const notesById = new Map(state.notes.map((n) => [n.id, n]));
  if (!canReorderNotes(notesById, sourceId, targetId)) {
    return;
  }
  const orderedIds = sortNotes(state.notes, state.sort).map((n) => n.id);
  if (isReorderNoOp(orderedIds, sourceId, targetId, position)) {
    return;
  }
  const nextOrder = moveIdInList(orderedIds, sourceId, targetId, position);
  const nextNotes = reorderNotesByIds(state.notes, nextOrder);
  const nextOpenTabs = syncTabsToNoteOrder(state.openTabs, nextOrder);

  const seq = ++orderMutationSeq;
  useNotepad.setState({
    notes: nextNotes,
    openTabs: nextOpenTabs,
    sort: "manual",
  });

  if (desktop) {
    pendingOrderMutations += 1;
    try {
      const snapshot = await call<NotepadSnapshot>("notepad_reorder", {
        noteIds: nextOrder,
        openTabs: nextOpenTabs,
      });
      if (seq === orderMutationSeq) {
        useNotepad.setState((s) => reconcileSnapshot(s, snapshot));
      }
    } catch (error) {
      notify(`Could not reorder notes: ${errorMessage(error)}`);
      if (seq === orderMutationSeq) {
        void ensureNotepadLoaded(true).catch(() => {});
      }
    } finally {
      pendingOrderMutations = Math.max(0, pendingOrderMutations - 1);
    }
    return;
  }

  const data = readBrowserStore();
  data.notes = reorderNotesByIds(data.notes, nextOrder);
  data.sort = "manual";
  data.openTabs = syncTabsToNoteOrder(
    data.openTabs,
    sortNotes(data.notes, "manual").map((n) => n.id),
  );
  data.revision += 1;
  writeBrowserStore(data);
  if (seq === orderMutationSeq) {
    useNotepad.setState((s) => reconcileSnapshot(s, browserSnapshot(data)));
  }
}

export async function setNotepadSort(sort: NotepadSort) {
  const state = useNotepad.getState();
  const nextSort = normalizeNotepadSort(sort);
  const orderedIds = sortNotes(state.notes, nextSort).map((n) => n.id);
  const nextOpenTabs = syncTabsToNoteOrder(state.openTabs, orderedIds);

  const seq = ++orderMutationSeq;
  useNotepad.setState({
    sort: nextSort,
    openTabs: nextOpenTabs,
  });

  if (desktop) {
    pendingOrderMutations += 1;
    try {
      const snapshot = await call<NotepadSnapshot>("notepad_set_sort", {
        sort: nextSort,
        openTabs: nextOpenTabs,
      });
      if (seq === orderMutationSeq) {
        useNotepad.setState((s) => reconcileSnapshot(s, snapshot));
      }
    } catch (error) {
      notify(`Could not update sort order: ${errorMessage(error)}`);
      if (seq === orderMutationSeq) {
        void ensureNotepadLoaded(true).catch(() => {});
      }
    } finally {
      pendingOrderMutations = Math.max(0, pendingOrderMutations - 1);
    }
    return;
  }

  const data = readBrowserStore();
  data.sort = nextSort;
  data.openTabs = syncTabsToNoteOrder(
    data.openTabs,
    sortNotes(data.notes, nextSort).map((n) => n.id),
  );
  data.revision += 1;
  writeBrowserStore(data);
  if (seq === orderMutationSeq) {
    useNotepad.setState((s) => reconcileSnapshot(s, browserSnapshot(data)));
  }
}

export function reorderNotepadTab(
  sourceId: string,
  targetId: string,
  position: NotepadDropPosition = "before",
) {
  void reorderNotepadNotes(sourceId, targetId, position);
}

export function switchNotepadTab(delta: 1 | -1) {
  const state = useNotepad.getState();
  if (state.openTabs.length <= 1 || !state.activeId) {
    return;
  }
  const index = state.openTabs.indexOf(state.activeId);
  const nextId = state.openTabs[(index + delta + state.openTabs.length) % state.openTabs.length];
  if (nextId) {
    void selectNote(nextId);
  }
}

export async function importNotepadFile() {
  if (!desktop) {
    notify("Importing files requires the LiteCode desktop app.");
    return;
  }
  const created = await call<NotepadCreateResponse | null>("notepad_import_file");
  if (!created) {
    return;
  }
  useNotepad.setState((s) => {
    const openTabs = s.openTabs.includes(created.note.id)
      ? s.openTabs
      : [...s.openTabs, created.note.id];
    return {
      ...reconcileSnapshot({ ...s, openTabs, activeId: created.note.id }, created.snapshot),
      contents: { ...s.contents, [created.note.id]: created.content },
      stats: computeTextStats(created.content),
    };
  });
  ensureNotepadModel(created.note.id, created.note.format, created.content);
  requestAnimationFrame(() => focusNotepadEditor());
}

export async function exportNotepadFile(id: string) {
  await flushNotepadSaves();
  if (!desktop) {
    notify("Exporting files requires the LiteCode desktop app.");
    return;
  }
  const savedPath = await call<string | null>("notepad_export_file", { id });
  if (savedPath) {
    notify(`Exported note to ${savedPath}`);
  }
}

export function registerNotepadEditor(instance: monaco.editor.IStandaloneCodeEditor | null) {
  editorInstance = instance;
}

export function saveNotepadViewState(id: string, state: monaco.editor.ICodeEditorViewState | null) {
  viewStates.set(id, state);
}

export function restoreNotepadViewState(id: string): monaco.editor.ICodeEditorViewState | null {
  return viewStates.get(id) ?? null;
}

export function focusNotepadEditor() {
  if (useApp.getState().view === "notepad") {
    editorInstance?.focus();
  }
}

export function triggerNotepadFind(replace = false) {
  if (!editorInstance) {
    return;
  }
  editorInstance.focus();
  void editorInstance
    .getAction(replace ? "editor.action.startFindReplaceAction" : "actions.find")
    ?.run();
}

export function toggleNotepadSidebar() {
  useNotepad.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
}

export function toggleNotepadWordWrap() {
  useNotepad.setState((s) => ({ wordWrap: !s.wordWrap }));
}

export function toggleNotepadSyntaxHighlight(id: string) {
  const nextEnabled = !isSyntaxHighlightEnabled(useNotepad.getState().syntaxHighlight, id);
  useNotepad.setState((s) => {
    const next = { ...s.syntaxHighlight };
    if (nextEnabled) {
      delete next[id];
    } else {
      next[id] = false;
    }
    return { syntaxHighlight: next };
  });
  const model = notepadModels.get(id);
  const note = useNotepad.getState().notes.find((n) => n.id === id);
  if (model && note) {
    applyNotepadModelLanguage(id, model, note.format);
  }
}

export function toggleNotepadMarkdownPreview(id: string) {
  useNotepad.setState((s) => ({
    markdownPreview: { ...s.markdownPreview, [id]: !s.markdownPreview[id] },
  }));
}
