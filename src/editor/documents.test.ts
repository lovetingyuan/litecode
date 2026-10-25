import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import type { Doc, DiskDocument, DiffRequest } from "../types/types";

vi.mock("./monaco", () => ({
  monaco: {
    languages: { getLanguages: () => [{ id: "plaintext" }], register: vi.fn() },
    Uri: { file: (path: string) => path, parse: (id: string) => id },
    editor: { getModel: () => null, createModel: vi.fn(), setModelLanguage: vi.fn(), EndOfLineSequence: { LF: 0, CRLF: 1 } },
  },
  loadSyntax: vi.fn().mockResolvedValue(undefined),
  languageFor: vi.fn(() => "plaintext"),
}));
vi.mock("../core/bridge", () => ({
  call: vi.fn(),
  desktop: true,
  errorMessage: (e: { message: string }) => e.message,
}));
vi.mock("../components/dialog", () => ({ ask: vi.fn() }));
vi.mock("../components/Explorer", () => ({ refreshTree: vi.fn(), revealInTree: vi.fn() }));
vi.mock("../search/search", () => ({
  createSearchTab: vi.fn(), activateSearchTab: vi.fn(), focusSearch: vi.fn(), undoReplacement: vi.fn(), nextSearchResult: vi.fn(), retryReplacement: vi.fn(), recoverInterruptedReplacements: vi.fn(),
}));
vi.mock("./editorStatus", () => ({ changeLanguage: vi.fn() }));
vi.mock("./languages", () => ({
  ensureLanguage: vi.fn(),
  releaseLanguageDocument: vi.fn(),
  canFormat: vi.fn(),
  formatModel: vi.fn(),
  restartLanguages: vi.fn(),
  stopLanguages: vi.fn(),
  languageReport: vi.fn(),
}));

import { call } from "../core/bridge";
import { monaco, languageFor } from "./monaco";
import { canFormat, formatModel, releaseLanguageDocument, ensureLanguage, stopLanguages } from "./languages";
import { commands, commandShortcut, execute, openFolder } from "../core/commands";
import { refreshTree } from "../components/Explorer";
import {
  attachDocument,
  autoSave,
  editors,
  models,
  normalize,
  openPath,
  patchDoc,
  restoreDocument,
  save,
  saveEditorView,
  session,
  showDocument,
  visiblePath,
  closeDocument,
  closeGroup,
  closeTabs,
  tabsToClose,
  keepOpen,
  normalizeGroup,
  setSticky,
  moveTab,
  splitGroup,
  checkpoint,
  patchMediaView,
  refreshDocuments,
  renameDocuments,
  beginDocumentMove,
  readConflictDiff,
  compareDisk,
  resolveConflict,
} from "./documents";
import { ask } from "../components/dialog";
import { initialSearch, primarySearchId, setApp, useApp } from "../store/store";

class Buffer {
  private version = 1;
  private listeners = new Set<() => void>();
  private options = { tabSize: 4, insertSpaces: true };
  getOptions() { return this.options; }
  updateOptions = vi.fn((options: Partial<typeof this.options>) => {
    this.options = { ...this.options, ...options };
  });
  detectIndentation = vi.fn((insertSpaces: boolean, tabSize: number) => {
    this.updateOptions({ insertSpaces, tabSize });
  });
  constructor(private text: string) {}
  getValue() {
    return this.text;
  }
  getAlternativeVersionId() {
    return this.version;
  }
  getEOL() {
    return this.text.includes("\r\n") ? "\r\n" : "\n";
  }
  getLanguageId() {
    return "plaintext";
  }
  isDisposed() {
    return false;
  }
  dispose() {}
  setValue(text: string) { this.edit(text); }
  pushEOL = vi.fn();
  pushStackElement = vi.fn();
  getFullModelRange() { return {}; }
  pushEditOperations = vi.fn((_selections: unknown[], edits: { text: string }[]) => {
    this.edit(edits[0].text);
  });
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  edit(text: string) {
    this.text = text;
    this.version++;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let sequence = 0;
function addDocument(patch: Partial<Doc> = {}) {
  const id = `document-${++sequence}`;
  const doc: Doc = {
    id,
    path: `C:/workspace/${id}.txt`,
    name: `${id}.txt`,
    language: "plaintext",
    encoding: "utf8",
    eol: "LF",
    dirty: true,
    version: 1,
    revision: "old-revision",
    ...patch,
  };
  const buffer = new Buffer("edited");
  vi.mocked(monaco.editor.createModel).mockReturnValueOnce(
    buffer as unknown as Monaco.editor.ITextModel,
  );
  attachDocument(doc, buffer.getValue(), doc.dirty);
  return { id, buffer };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const writes = () =>
  vi
    .mocked(call)
    .mock.calls.filter(([command]) => command === "save_document")
    .map(([, args]) => args!);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(languageFor).mockReturnValue("plaintext");
  vi.mocked(call).mockImplementation(async (command) =>
    command === "save_document" ? "new-revision" : (undefined as never),
  );
  vi.mocked(canFormat).mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  setApp({
    docs: {},
    groups: [],
    tabRevealRequests: {},
    settings: { "files.autoSave": "onFocusChange" },
    notice: null,
  });
});

describe("Editor view snapshots", () => {
  it("persists only the primary search query even when another search is active", () => {
    const main = { ...initialSearch(), query: { ...initialSearch().query, text: "primary" } };
    const secondary = { ...initialSearch("secondary", 2), query: { ...initialSearch().query, text: "secondary" } };
    setApp({ searchSessions: [main, secondary], activeSearchId: secondary.id });
    expect(session().query).toEqual(main.query);
    expect(session()).not.toHaveProperty("searchSessions");
    expect(session()).not.toHaveProperty("activeSearchId");
    setApp({ searchSessions: [initialSearch()], activeSearchId: primarySearchId });
  });
  function view(line: number): Monaco.editor.ICodeEditorViewState {
    return {
      cursorState: [],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: line, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    };
  }

  function setup() {
    const { id } = addDocument({ dirty: false });
    setApp({
      activeGroup: "one",
      groups: [
        { id: "one", tabs: [id], active: id, preview: null, views: { [id]: view(1) } },
        { id: "two", tabs: [id], active: id, preview: null, views: { [id]: view(2) } },
      ],
    });
    return id;
  }

  it("saves a view without mutating previous snapshots or another group", () => {
    const id = setup();
    const before = useApp.getState();
    Object.freeze(before.groups[0].views);
    Object.freeze(before.groups[0]);
    const next = view(12);
    saveEditorView("one", id, next);
    const after = useApp.getState();
    expect(before.groups[0].views[id]).toEqual(view(1));
    expect(after.groups[0].views[id]).toBe(next);
    expect(after.groups[1]).toBe(before.groups[1]);
    expect(after.activeGroup).toBe(before.activeGroup);
    expect(after.editorLayout).toBe(before.editorLayout);
    saveEditorView("one", id, null);
    expect(after.groups[0].views[id]).toBe(next);
    expect(useApp.getState().groups[0].views[id]).toBeNull();
  });

  it("does not recreate a group removed before its view was saved", () => {
    const id = setup();
    setApp((s) => ({ groups: s.groups.filter((g) => g.id !== "one") }));
    const before = useApp.getState();
    saveEditorView("one", id, view(12));
    expect(useApp.getState()).toBe(before);
  });

  it("captures independent live views in one session update without mutating old sessions", () => {
    const id = setup();
    const before = session();
    for (const [index, group] of before.groups.entries()) {
      Object.freeze(group.views);
      Object.freeze(group);
      editors.set(group.id, {
        saveViewState: () => view(10 + index),
      } as Monaco.editor.IStandaloneCodeEditor);
    }
    const changed = vi.fn();
    const unsubscribe = useApp.subscribe(changed);
    const saved = session();
    unsubscribe();
    expect(changed).toHaveBeenCalledOnce();
    expect(before.groups.map((g) => g.views[id])).toEqual([view(1), view(2)]);
    expect(saved.groups.map((g) => g.views[id])).toEqual([view(10), view(11)]);
    expect(saved.activeGroup).toBe(before.activeGroup);
    expect(saved.editorLayout).toBe(before.editorLayout);
  });

  it("copies the live view into a split and keeps subsequent group views independent", () => {
    const id = setup();
    editors.set("one", {
      saveViewState: () => view(20),
    } as Monaco.editor.IStandaloneCodeEditor);
    const split = splitGroup("one", id);
    const before = useApp.getState();
    expect(before.groups.find((g) => g.id === split)?.views[id]).toEqual(view(20));
    saveEditorView(split, id, view(30));
    const saved = session();
    expect(saved.groups.find((g) => g.id === "one")?.views[id]).toEqual(view(20));
    expect(saved.groups.find((g) => g.id === split)?.views[id]).toEqual(view(30));
    expect(before.groups.find((g) => g.id === split)?.views[id]).toEqual(view(20));
  });
});

describe("Editor tab actions", () => {
  function setup() {
    const ids = Array.from({ length: 4 }, () => addDocument({ dirty: false }).id);
    setApp({
      activeGroup: "one",
      groups: [
        { id: "one", tabs: ids, active: ids[1], preview: ids[3], views: {} },
        { id: "two", tabs: [ids[0]], active: ids[0], preview: null, views: {} },
      ],
    });
    return ids;
  }

  it("disables preview replacement across groups without closing or changing fixed tabs", () => {
    const ids = setup();
    setSticky(ids[0], "one", true);
    setApp({ settings: { "workbench.editor.enablePreview": false } });
    expect(useApp.getState().groups.every((group) => group.preview === null)).toBe(true);
    const next = addDocument({ dirty: false });
    showDocument(next.id, { preserveFocus: true });
    expect(useApp.getState().groups[0]).toMatchObject({ tabs: [...ids, next.id], preview: null, sticky: [ids[0]] });
    expect(models.has(ids[3])).toBe(true);
    expect(normalizeGroup({ id: "restored", tabs: [next.id], active: next.id, preview: next.id, views: {} }).preview).toBeNull();
    setApp({ settings: {} });
    const preview = addDocument({ dirty: false });
    showDocument(preview.id, { preserveFocus: true });
    expect(useApp.getState().groups[0].preview).toBe(preview.id);
  });

  it("keeps preview persistence separate from group-local pinning", () => {
    const ids = setup();
    keepOpen(ids[3], "one");
    expect(useApp.getState().groups[0].preview).toBeNull();
    expect(useApp.getState().groups[0].sticky).toBeUndefined();
    setSticky(ids[2], "one", true);
    setSticky(ids[0], "one", true);
    expect(useApp.getState().groups[0]).toMatchObject({
      tabs: [ids[2], ids[0], ids[1], ids[3]],
      sticky: [ids[2], ids[0]],
    });
    expect(useApp.getState().groups[1].sticky).toBeUndefined();
    setSticky(ids[2], "one", false);
    expect(useApp.getState().groups[0]).toMatchObject({
      tabs: [ids[0], ids[2], ids[1], ids[3]],
      sticky: [ids[0]],
    });
    expect(session().groups[0].sticky).toEqual([ids[0]]);
  });

  it("normalizes legacy and stale restored fixed tabs", () => {
    const group = { id: "one", tabs: ["a", "b"], active: "a", preview: "b", views: {} };
    expect(normalizeGroup(group)).toMatchObject({ sticky: [], tabs: ["a", "b"], preview: "b" });
    expect(normalizeGroup({ ...group, sticky: ["missing", "b", "b"] })).toMatchObject({
      sticky: ["b"],
      tabs: ["b", "a"],
      preview: null,
    });
  });

  it("selects group-local close targets and protects fixed and dirty tabs", () => {
    const ids = setup();
    setSticky(ids[0], "one", true);
    patchDoc(ids[2], { dirty: true });
    const group = useApp.getState().groups[0];
    expect(tabsToClose(group, ids[1], "others")).toEqual([ids[2], ids[3]]);
    expect(tabsToClose(group, ids[1], "right")).toEqual([ids[2], ids[3]]);
    expect(tabsToClose(group, ids[1], "saved")).toEqual([ids[1], ids[3]]);
    expect(tabsToClose(group, ids[1], "all")).toEqual(ids.slice(1));
  });

  it("stops a batch on cancellation without closing later tabs", async () => {
    const ids = setup();
    patchDoc(ids[2], { dirty: true });
    vi.mocked(ask).mockResolvedValueOnce("Cancel");
    await closeTabs(ids[0], "one", "others");
    expect(useApp.getState().groups[0].tabs).toEqual([ids[0], ids[2], ids[3]]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("stops a batch on cancelled Save As or failed saving", async () => {
    const ids = setup();
    patchDoc(ids[1], { path: null, dirty: true });
    vi.mocked(ask).mockResolvedValueOnce("Save");
    vi.mocked(call).mockResolvedValueOnce(null);
    await closeTabs(ids[0], "one", "others");
    expect(useApp.getState().groups[0].tabs).toEqual(ids);
    patchDoc(ids[1], { path: "C:/workspace/file.txt" });
    vi.mocked(ask).mockResolvedValueOnce("Save");
    vi.mocked(call).mockRejectedValueOnce(new Error("Write failed"));
    await expect(closeTabs(ids[0], "one", "others")).rejects.toThrow("Write failed");
    expect(useApp.getState().groups[0].tabs).toEqual(ids);
  });

  it("retains shared models, removes empty groups and keeps the last group", async () => {
    const ids = setup();
    patchDoc(ids[0], { dirty: true });
    await closeTabs(ids[1], "one", "all");
    expect(ask).not.toHaveBeenCalled();
    expect(useApp.getState().groups.map((g) => g.id)).toEqual(["two"]);
    expect(useApp.getState().activeGroup).toBe("two");
    expect(models.has(ids[0])).toBe(true);
    vi.mocked(ask).mockResolvedValueOnce("Don't Save");
    expect(await closeDocument(ids[0], "two")).toBe(true);
    expect(models.has(ids[0])).toBe(false);
    expect(useApp.getState().groups).toHaveLength(1);
    expect(useApp.getState().groups[0].tabs).toEqual([]);
  });

  it("retains fixed order during reorder and cross-group moves", () => {
    const ids = setup();
    setSticky(ids[0], "one", true);
    setSticky(ids[2], "one", true);
    moveTab(ids[3], "one", "one", ids[0]);
    expect(useApp.getState().groups[0].tabs).toEqual([ids[0], ids[2], ids[3], ids[1]]);
    moveTab(ids[2], "one", "two");
    expect(useApp.getState().groups[0].sticky).toEqual([ids[0]]);
    expect(useApp.getState().groups[1]).toMatchObject({
      tabs: [ids[2], ids[0]],
      sticky: [ids[2]],
      active: ids[2],
    });
  });

  it("splits the specified inactive tab immediately right of its source", () => {
    const ids = setup();
    const view = { cursor: 8 };
    setApp((s) => ({
      groups: s.groups.map((g) => (g.id === "one" ? { ...g, views: { [ids[3]]: view } } : g)),
      activeGroup: "two",
    }));
    const id = splitGroup("one", ids[3]);
    const state = useApp.getState();
    expect(state.groups.map((g) => g.id)).toEqual(["one", id, "two"]);
    expect(state.groups[1]).toMatchObject({
      active: ids[3],
      tabs: [ids[3]],
      views: { [ids[3]]: view },
    });
    expect(state.activeGroup).toBe(id);
    expect(state.groups[0].tabs).toEqual(ids);
  });

  it("uses the side-by-side setting while explicit directions take precedence", () => {
    setup();
    setApp({ settings: { "workbench.editor.openSideBySideDirection": "down" } });
    const below = splitGroup("one");
    const layout = useApp.getState().editorLayout;
    expect(JSON.stringify(layout)).toContain("vertical");
    const left = splitGroup(below, undefined, "left");
    expect(useApp.getState().groups.map((g) => g.id)).toEqual(["one", left, below, "two"]);
    expect(useApp.getState().activeGroup).toBe(left);
    expect(useApp.getState().groups.find((g) => g.id === below)?.active).toBe(
      useApp.getState().groups.find((g) => g.id === left)?.active,
    );
  });

  it("returns to the most recently active group and preserves focus when closing an inactive group", async () => {
    const ids = setup();
    const third = splitGroup("one");
    setApp({ activeGroup: "one" });
    setApp({ activeGroup: "two" });
    setApp({ activeGroup: third });
    await closeDocument(ids[1], third);
    expect(useApp.getState().activeGroup).toBe("two");
    expect(useApp.getState().groupMru).toEqual(["two", "one"]);
    await closeTabs(ids[1], "one", "all");
    expect(useApp.getState().activeGroup).toBe("two");
  });

  it("merges a removed group into the recently active group without losing dirty or fixed tabs", () => {
    const ids = setup();
    const third = splitGroup("one", ids[2]);
    patchDoc(ids[2], { dirty: true });
    setSticky(ids[2], third, true);
    setApp({ activeGroup: "two" });
    setApp({ activeGroup: third });
    closeGroup(third);
    const state = useApp.getState();
    expect(state.activeGroup).toBe("two");
    expect(state.groups.find((g) => g.id === "two")).toMatchObject({
      active: ids[2],
      sticky: [ids[2]],
    });
    expect(state.docs[ids[2]].dirty).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.stringify(state.editorLayout)).not.toContain(third);
  });

  it("removes the source group when its last tab is moved and saves layout and MRU in the session", () => {
    const ids = setup();
    const third = splitGroup("one", ids[3]);
    moveTab(ids[3], third, "two");
    expect(useApp.getState().groups.map((g) => g.id)).toEqual(["one", "two"]);
    expect(useApp.getState().activeGroup).toBe("two");
    const saved = session();
    expect(saved.groupMru).toEqual(["two", "one"]);
    expect(saved.editorLayout).toEqual(useApp.getState().editorLayout);
    expect(saved.groups.find((g) => g.id === "two")?.tabs).toContain(ids[3]);
  });
});

describe("Live model settings", () => {
  it("updates existing and newly created models, including documents outside the active group", () => {
    const first = addDocument();
    const second = addDocument();
    const settings = { "editor.detectIndentation": false, "editor.tabSize": 8, "editor.insertSpaces": false };
    setApp({ settings });
    for (const { buffer } of [first, second, addDocument()]) {
      expect(buffer.getOptions()).toMatchObject({ tabSize: 8, insertSpaces: false });
      expect(buffer.getValue()).toBe("edited");
    }
    first.buffer.detectIndentation.mockClear();
    setApp({ settings: { ...settings, "editor.cursorStyle": "block" } });
    expect(first.buffer.detectIndentation).not.toHaveBeenCalled();
    setApp({ settings: {} });
    expect(first.buffer.detectIndentation).toHaveBeenCalledWith(true, 4);
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  models.clear();
  editors.clear();
  vi.unstubAllGlobals();
});

describe("Workspace switches", () => {
  const configuration = { settings: {}, keybindings: [] };
  beforeEach(() => {
    setApp({ root: "C:/workspace", history: [], historyIndex: -1 });
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "open_workspace") {
        return true as never;
      }
      if (command === "configuration") {
        return configuration as never;
      }
      return (command === "save_document" ? "new-revision" : undefined) as never;
    });
  });

  function setup(dirty = false) {
    const first = addDocument({ dirty });
    const second = addDocument({ dirty: false });
    setApp({
      groups: [
        { id: "one", tabs: [first.id, second.id], active: first.id, preview: second.id,
          sticky: [first.id], views: {} },
        { id: "two", tabs: [first.id], active: first.id, preview: null, views: {} },
      ],
      activeGroup: "two",
      tabRevealRequests: { one: 3, two: 1 },
      history: [{ id: first.id, path: "C:/workspace/file.txt", line: 10, column: 2 }],
      historyIndex: 0,
    });
    return first;
  }

  const commandCalls = (command: string) =>
    vi.mocked(call).mock.calls.filter(([name]) => name === command);

  it("closes fixed tabs, previews, shared split views and media, then persists an empty session", async () => {
    const { id, buffer } = setup();
    const dispose = vi.spyOn(buffer, "dispose");
    const editor = { getModel: () => buffer, setModel: vi.fn(), saveViewState: () => null };
    editors.set("two", editor as unknown as Monaco.editor.IStandaloneCodeEditor);
    const mediaId = "media";
    restoreDocument({ id: mediaId, path: "C:/workspace/image.png", kind: "image", text: "",
      encoding: "utf8", version: 1, revision: null, dirty: false });
    showDocument(mediaId, { group: "one" });

    await openFolder(false, "C:/next");

    const state = useApp.getState();
    expect(state.root).toBe("C:/next");
    expect(state.docs).toEqual({});
    expect(state.groups).toHaveLength(1);
    const group = state.groups[0];
    expect(group).toEqual({ id: expect.any(String), tabs: [], active: null, preview: null, views: {} });
    expect(state.activeGroup).toBe(group.id);
    expect(state.groupMru).toEqual([group.id]);
    expect(state.editorLayout).toEqual({ type: "group", id: group.id });
    expect(state.tabRevealRequests).toEqual({});
    expect(state.history).toEqual([]);
    expect(state.historyIndex).toBe(-1);
    expect(models.size).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(editor.setModel).toHaveBeenCalledWith(null);
    expect(releaseLanguageDocument).toHaveBeenCalledWith(id);
    expect(releaseLanguageDocument).toHaveBeenCalledWith(mediaId);
    expect(ask).not.toHaveBeenCalled();
    const persisted = commandCalls("sync_documents").slice(-1)[0][1]!;
    expect(persisted.documents).toEqual([]);
    expect(persisted.session).toMatchObject({ groups: [group], history: [], historyIndex: -1 });
    expect(refreshTree).toHaveBeenCalledOnce();
  });

  it("confirms a shared dirty document once and saves it before switching", async () => {
    const { id } = setup(true);
    vi.mocked(ask).mockResolvedValueOnce("Save");
    await openFolder(false, "C:/next");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(writes().map((args) => args.id)).toEqual([id]);
    const calls = vi.mocked(call).mock.calls.map(([name]) => name);
    expect(calls.indexOf("save_document")).toBeLessThan(calls.indexOf("open_workspace"));
    expect(useApp.getState().docs).toEqual({});
  });

  it("keeps every tab until a confirmed switch succeeds, even after Don't Save", async () => {
    const { id } = setup(true);
    const pending = deferred<boolean>();
    vi.mocked(ask).mockResolvedValueOnce("Don't Save");
    vi.mocked(call).mockImplementation(async (command) =>
      (command === "open_workspace" ? pending.promise : command === "configuration" ? configuration : undefined) as never,
    );
    const before = useApp.getState();
    const opening = openFolder(false, "C:/next");
    await vi.waitFor(() => expect(commandCalls("open_workspace")).toHaveLength(1));
    expect(useApp.getState().groups).toEqual(before.groups);
    expect(useApp.getState().docs[id].dirty).toBe(true);
    expect(useApp.getState().root).toBe("C:/workspace");
    pending.resolve(true);
    await opening;
    expect(writes()).toHaveLength(0);
    expect(useApp.getState().docs).toEqual({});
  });

  it.each(["Cancel", null])("retains all tabs and the workspace when confirmation is %s", async (answer) => {
    setup(true);
    const before = useApp.getState();
    vi.mocked(ask).mockResolvedValueOnce(answer);
    await openFolder(false, "C:/next");
    expect(useApp.getState()).toMatchObject({ root: before.root, docs: before.docs, groups: before.groups });
    expect(commandCalls("open_workspace")).toHaveLength(0);
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("does not partially close tabs when a later document cancels", async () => {
    setup(true);
    const group = useApp.getState().groups[0];
    patchDoc(group.tabs[1], { dirty: true });
    vi.mocked(ask).mockResolvedValueOnce("Don't Save").mockResolvedValueOnce("Cancel");
    const before = useApp.getState();
    await openFolder(false, "C:/next");
    expect(useApp.getState().groups).toEqual(before.groups);
    expect(useApp.getState().docs).toEqual(before.docs);
    expect(stopLanguages).not.toHaveBeenCalled();
    expect(commandCalls("open_workspace")).toHaveLength(0);
  });

  it("aborts when Save As is cancelled", async () => {
    const { id } = setup(true);
    patchDoc(id, { path: null });
    vi.mocked(ask).mockResolvedValueOnce("Save");
    vi.mocked(call).mockResolvedValueOnce(null);
    await openFolder(false, "C:/next");
    expect(useApp.getState().docs[id].dirty).toBe(true);
    expect(useApp.getState().groups).toHaveLength(2);
    expect(commandCalls("open_workspace")).toHaveLength(0);
  });

  it("aborts when saving fails", async () => {
    const { id } = setup(true);
    vi.mocked(ask).mockResolvedValueOnce("Save");
    vi.mocked(call).mockRejectedValueOnce(new Error("Write failed"));
    await expect(openFolder(false, "C:/next")).rejects.toThrow("Write failed");
    expect(useApp.getState().docs[id].dirty).toBe(true);
    expect(useApp.getState().groups).toHaveLength(2);
    expect(commandCalls("open_workspace")).toHaveLength(0);
  });

  it.each(["open_workspace", "sync_documents"])("preserves editors if %s fails", async (failedCommand) => {
    const { id } = setup(true);
    vi.mocked(ask).mockResolvedValueOnce("Don't Save");
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === failedCommand) {
        throw new Error("Open failed");
      }
      return undefined as never;
    });
    await expect(openFolder(false, "C:/next")).rejects.toThrow("Open failed");
    expect(useApp.getState().root).toBe("C:/workspace");
    expect(useApp.getState().docs[id].dirty).toBe(true);
    expect(useApp.getState().groups).toHaveLength(2);
    expect(models.has(id)).toBe(true);
  });

  it.each(["C:/workspace", "c:\\WORKSPACE\\", "\\\\?\\C:\\workspace"])(
    "preserves editors when reopening the same project as %s", async (path) => {
      setup(true);
      const before = useApp.getState();
      await openFolder(false, path);
      expect(ask).not.toHaveBeenCalled();
      expect(useApp.getState().groups).toEqual(before.groups);
      expect(useApp.getState().docs).toEqual(before.docs);
    },
  );

  it("opens a blank window from File without changing dirty editors", async () => {
    const { id, buffer } = setup(true);
    const before = useApp.getState();
    const command = commands.find((c) => c.id === "workbench.action.newWindow")!;
    expect(command).toMatchObject({ label: "New Window", menu: "File" });
    expect(commands[commands.indexOf(command) - 1].id).toBe("workbench.action.files.newUntitledFile");
    expect(commandShortcut(command.id, {}, [])).toBe("Ctrl+Shift+N");
    vi.mocked(call).mockResolvedValueOnce("editor-empty-test");

    await execute(command.id);

    expect(call).toHaveBeenCalledExactlyOnceWith("new_window");
    expect(ask).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ root: before.root, groups: before.groups, docs: before.docs });
    expect(useApp.getState().docs[id].dirty).toBe(true);
    expect(models.get(id)).toBe(buffer);
  });

  it("reports a new-window failure without changing the current session", async () => {
    setup(true);
    const before = useApp.getState();
    vi.mocked(call).mockRejectedValueOnce({ message: "Could not create window" });

    await execute("workbench.action.newWindow");

    expect(useApp.getState()).toMatchObject({
      root: before.root, groups: before.groups, docs: before.docs, notice: "Could not create window",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("preserves editors when the directory picker is cancelled", async () => {
    setup(true);
    vi.mocked(call).mockResolvedValueOnce(null);
    await openFolder();
    expect(ask).not.toHaveBeenCalled();
    expect(useApp.getState().groups).toHaveLength(2);
    expect(commandCalls("open_workspace")).toHaveLength(0);
  });

  it.each([false, true])("preserves editors when another window opens or focuses (newWindow=%s)", async (newWindow) => {
    setup(true);
    vi.mocked(ask).mockResolvedValueOnce("Don't Save");
    vi.mocked(call).mockResolvedValue(false);
    const before = useApp.getState();
    await openFolder(newWindow, "C:/next");
    expect(useApp.getState().root).toBe(before.root);
    expect(useApp.getState().groups).toEqual(before.groups);
    expect(useApp.getState().docs).toEqual(before.docs);
    if (newWindow) {
      expect(ask).not.toHaveBeenCalled();
    }
  });

  it("closes loose editors when opening the first project through the picker", async () => {
    setup();
    setApp({ root: null });
    vi.mocked(call).mockResolvedValueOnce("C:/next");
    await openFolder();
    expect(useApp.getState().root).toBe("C:/next");
    expect(useApp.getState().docs).toEqual({});
    expect(commandCalls("open_workspace")[0][1]).toEqual({ path: "C:/next", newWindow: false });
  });

  it.each([null, "C:/workspace"])("loads target settings before showing a folder opened from %s", async (root) => {
    setup();
    setApp({ root, settings: { "editor.fontSize": 14, "editor.lineHeight": 20 } });
    const settings = { "editor.fontSize": 18, "editor.lineHeight": 30 };
    vi.mocked(call).mockImplementation(async (command) =>
      (command === "open_workspace" ? true : command === "configuration" ? { settings, keybindings: null } : undefined) as never,
    );
    vi.mocked(refreshTree).mockImplementationOnce(async () => {
      expect(useApp.getState()).toMatchObject({ root: "C:/next", settings, keybindings: [] });
      expect(stopLanguages).toHaveBeenCalledOnce();
    });

    await openFolder(false, "C:/next");

    expect(commandCalls("configuration")).toHaveLength(1);
    expect(useApp.getState().settings).toEqual(settings);
  });

  it("cancels pending auto saves and backups after closing the old documents", async () => {
    const { buffer } = setup();
    setApp({ settings: { "files.autoSave": "afterDelay", "files.autoSaveDelay": 500 } });
    buffer.edit("pending auto save");
    vi.mocked(ask).mockResolvedValueOnce("Don't Save");
    await openFolder(false, "C:/next");
    const backups = commandCalls("sync_documents").length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes()).toHaveLength(0);
    expect(commandCalls("sync_documents")).toHaveLength(backups);
    buffer.edit("detached listener");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an in-flight save before disposing its model and writing the empty session", async () => {
    const { id, buffer } = setup(true);
    const pending = deferred<string>();
    const dispose = vi.spyOn(buffer, "dispose");
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "save_document") {
        return pending.promise as never;
      }
      if (command === "configuration") {
        return configuration as never;
      }
      return (command === "open_workspace" ? true : undefined) as never;
    });
    const saving = save(id);
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    vi.mocked(ask).mockResolvedValueOnce("Don't Save");
    const opening = openFolder(false, "C:/next");
    await vi.waitFor(() => expect(commandCalls("open_workspace")).toHaveLength(1));
    expect(dispose).not.toHaveBeenCalled();
    pending.resolve("saved-revision");
    await Promise.all([saving, opening]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(useApp.getState().docs).toEqual({});
    expect(commandCalls("sync_documents").slice(-1)[0][1]!.documents).toEqual([]);
  });
});

describe("Opening documents", () => {
  it.each([
    ["App.tsx", "typescript", "typescriptreact"],
    ["App.jsx", "javascript", "javascriptreact"],
    ["tsconfig.json", "json", "jsonc"],
    ["tsconfig.node.json", "json", "jsonc"],
    [".gitignore", "plaintext", "gitignore"],
    [".env", "plaintext", "dotenv"],
    [".env.production.local", "plaintext", "dotenv"],
    ["App.vue", "plaintext", "vue"],
    ["Program.cs", "plaintext", "csharp"],
    ["index.php", "plaintext", "php"],
    ["Main.kt", "plaintext", "kotlin"],
    ["main.pyi", "plaintext", "python"],
    ["main.hpp", "plaintext", "cpp"],
    ["Dockerfile", "plaintext", "dockerfile"],
    ["file.unknown", "plaintext", "plaintext"],
  ])(
    "repairs the saved language mode for %s without changing its buffer",
    (name, oldLanguage, language) => {
      vi.mocked(languageFor).mockReturnValue(language);
      const text =
        language === "jsonc"
          ? '{\n  // unsaved config edits\n  "compilerOptions": { "strict": true, },\n}'
          : "unsaved source edits";
      vi.mocked(monaco.editor.createModel).mockReturnValueOnce(
        new Buffer(text) as unknown as Monaco.editor.ITextModel,
      );
      restoreDocument({
        id: "restored",
        path: `C:/workspace/${name}`,
        language: oldLanguage,
        text,
        dirty: true,
        version: 3,
        revision: "revision",
        encoding: "utf8",
      });
      expect(useApp.getState().docs.restored).toMatchObject({ language, dirty: true, version: 3 });
      expect(models.get("restored")!.getValue()).toBe(text);
    },
  );

  it("preserves a saved non-plaintext language choice", () => {
    vi.mocked(languageFor).mockReturnValue("php");
    const text = "unsaved HTML edits";
    vi.mocked(monaco.editor.createModel).mockReturnValueOnce(
      new Buffer(text) as unknown as Monaco.editor.ITextModel,
    );
    restoreDocument({
      id: "manual-language", path: "C:/workspace/index.php", language: "html",
      text, dirty: true, version: 3, revision: "revision", encoding: "utf8",
    });
    expect(useApp.getState().docs["manual-language"]).toMatchObject({ language: "html", dirty: true });
    expect(models.get("manual-language")!.getValue()).toBe(text);
  });

  it.each([
    ["\\\\?\\D:\\project\\App.tsx", "D:\\project\\App.tsx"],
    ["\\\\?\\UNC\\server\\share\\App.tsx", "\\\\server\\share\\App.tsx"],
  ])("uses a standard file path for model URIs: %s", (path, expected) => {
    addDocument({ path });
    expect(visiblePath(path)).toBe(expected);
    expect(normalize(path)).toBe(normalize(expected));
    expect(monaco.editor.createModel).toHaveBeenLastCalledWith("edited", "plaintext", expected);
  });

  function setup() {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const { id } = addDocument();
    setApp({
      activeGroup: "group",
      groups: [{ id: "group", tabs: [], active: null, preview: null, views: {} }],
      history: [],
      historyIndex: -1,
    });
    const editor = {
      focus: vi.fn(),
      setPosition: vi.fn(),
      revealLineInCenterIfOutsideViewport: vi.fn(),
      getModel: () => null,
      setModel: vi.fn(),
      saveViewState: () => null,
    };
    editors.set("group", editor as unknown as Monaco.editor.IStandaloneCodeEditor);
    return { id, editor };
  }

  it("activates an existing file as a preview without taking focus from the explorer", async () => {
    const { id, editor } = setup();
    await openPath(useApp.getState().docs[id].path!, { preserveFocus: true });
    expect(useApp.getState().groups[0]).toMatchObject({ active: id, tabs: [id], preview: id });
    expect(useApp.getState().history[0].id).toBe(id);
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it("loads a new file and preserves focus while still revealing the requested location", async () => {
    const { editor } = setup();
    vi.mocked(call)
      .mockResolvedValueOnce({ kind: "text", size: 5, stamp: "fresh" })
      .mockResolvedValueOnce({ text: "fresh", encoding: "utf8", eol: "LF", revision: "new" });
    vi.mocked(monaco.editor.createModel).mockReturnValueOnce(
      new Buffer("fresh") as unknown as Monaco.editor.ITextModel,
    );
    const id = await openPath("C:/workspace/fresh.txt", {
      preserveFocus: true,
      line: 3,
      column: 2,
    });
    expect(models.get(id)?.getValue()).toBe("fresh");
    expect(useApp.getState().groups[0]).toMatchObject({ active: id, preview: id });
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 2 });
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it("focuses and pins the current preview when explicitly opened", () => {
    const { id, editor } = setup();
    showDocument(id, { preserveFocus: true });
    showDocument(id, { pinned: true });
    expect(useApp.getState().groups[0]).toMatchObject({ active: id, tabs: [id], preview: null });
    expect(editor.focus).toHaveBeenCalledOnce();
  });

  it("continues focusing ordinary opens and leaves background opens inactive", () => {
    const { id, editor } = setup();
    showDocument(id, { background: true });
    expect(useApp.getState().groups[0].active).toBeNull();
    expect(editor.focus).not.toHaveBeenCalled();
    showDocument(id);
    expect(editor.focus).toHaveBeenCalledOnce();
  });

  it("requests a reveal on every foreground open, including the already active document", () => {
    const { id, editor } = setup();
    showDocument(id, { preserveFocus: true });
    const first = useApp.getState().tabRevealRequests.group;
    showDocument(id, { preserveFocus: true });
    expect(useApp.getState().tabRevealRequests.group).toBe(first + 1);
    expect(useApp.getState().groups[0].tabs).toEqual([id]);
    expect(editor.focus).not.toHaveBeenCalled();
  });

  it("does not request a reveal for background opens or change another group request", () => {
    const { id } = setup();
    showDocument(id);
    const requests = useApp.getState().tabRevealRequests;
    const other = addDocument();
    showDocument(other.id, { background: true });
    expect(useApp.getState().tabRevealRequests).toBe(requests);
    expect(useApp.getState().groups[0].active).toBe(id);
    setApp((s) => ({
      groups: [...s.groups, { id: "other", tabs: [], active: null, preview: null, views: {} }],
    }));
    showDocument(other.id, { group: "other" });
    expect(useApp.getState().tabRevealRequests).toEqual({ ...requests, other: 1 });
  });

  it("keeps reveal requests out of the saved session", () => {
    const { id, editor } = setup();
    Object.assign(editor, { saveViewState: () => null });
    showDocument(id);
    expect(session()).not.toHaveProperty("tabRevealRequests");
  });
});

describe("Media documents", () => {
  beforeEach(() => {
    setApp({
      activeGroup: "one",
      groups: [{ id: "one", tabs: [], active: null, preview: null, views: {} }],
      history: [],
      historyIndex: -1,
    });
  });
  it("recognizes legacy SVG recovery records after the backend supplies its text default", () => {
    const text = "<svg><rect/></svg>";
    vi.mocked(monaco.editor.createModel).mockReturnValueOnce(
      new Buffer(text) as unknown as Monaco.editor.ITextModel,
    );
    restoreDocument({
      id: "legacy-svg",
      path: "C:/workspace/old.SVG",
      kind: "text",
      text,
      dirty: true,
      version: 3,
      revision: "old",
      encoding: "utf8",
    });
    expect(useApp.getState().docs["legacy-svg"]).toMatchObject({
      kind: "svg",
      dirty: true,
      version: 3,
    });
    expect(models.get("legacy-svg")?.getValue()).toBe(text);
  });
  it.each(["image", "video", "audio", "binary"] as const)(
    "opens and restores %s without a text model or save operation",
    async (kind) => {
      vi.mocked(call).mockImplementation(async (command) =>
        command === "inspect_file" ? { kind, size: 123, stamp: "one" } : (undefined as never),
      );
      const id = await openPath(`C:/workspace/file.${kind}`, { pinned: true });
      expect(models.has(id)).toBe(false);
      expect(useApp.getState().docs[id].kind).toBe(kind);
      await save(id);
      expect(writes()).toHaveLength(0);
      await checkpoint();
      const snapshot = vi
        .mocked(call)
        .mock.calls.filter(([command]) => command === "sync_documents")
        .slice(-1)[0]![1]!;
      const mirror = (snapshot.documents as import("../types/types").Mirror[])[0];
      expect(mirror).toMatchObject({ id, kind, text: "", dirty: false });
      restoreDocument(mirror);
      expect(models.has(id)).toBe(false);
    },
  );
  it.each(["binary", "encoding"])(
    "opens a text decoding %s failure as an unsupported editor",
    async (code) => {
      vi.mocked(call).mockImplementation(async (command) => {
        if (command === "inspect_file") {
          return { kind: "text", size: 12, stamp: "one" } as never;
        }
        if (command === "read_document") {
          throw { code, message: "Unsupported content" };
        }
        return undefined as never;
      });
      const id = await openPath("C:/workspace/unknown");
      expect(useApp.getState().docs[id].kind).toBe("binary");
      expect(models.has(id)).toBe(false);
    },
  );
  it("preserves the SVG buffer, dirty flag and independent group modes through backup", async () => {
    vi.mocked(call).mockImplementation(async (command) =>
      command === "inspect_file"
        ? ({ kind: "svg", size: 20, stamp: "one" } as never)
        : command === "read_document"
          ? ({ text: "<svg/>", encoding: "utf8", eol: "LF", revision: "svg" } as never)
          : (undefined as never),
    );
    const buffer = new Buffer("<svg/>");
    vi.mocked(monaco.editor.createModel).mockReturnValueOnce(
      buffer as unknown as Monaco.editor.ITextModel,
    );
    const id = await openPath("C:/workspace/icon.svg", { pinned: true });
    patchMediaView("one", id, { mode: "text", scale: 1.5 });
    buffer.edit("<svg><rect/></svg>");
    const other = splitGroup("one");
    patchMediaView(other, id, { mode: "image", scale: 2 });
    expect(useApp.getState().groups[0].mediaViews?.[id]).toMatchObject({
      mode: "text",
      scale: 1.5,
    });
    expect(useApp.getState().groups[1].mediaViews?.[id]).toMatchObject({ mode: "image", scale: 2 });
    await checkpoint();
    expect(writes()).toHaveLength(0);
    const args = vi
      .mocked(call)
      .mock.calls.filter(([command]) => command === "sync_documents")
      .slice(-1)[0]![1]!;
    expect((args.documents as import("../types/types").Mirror[])[0]).toMatchObject({
      text: "<svg><rect/></svg>",
      dirty: true,
      kind: "svg",
    });
  });
  it("refreshes, renames and marks a missing media file without text reads", async () => {
    let missing = false;
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "inspect_file") {
        if (missing) {
          throw { code: "notFound", message: "File missing" };
        }
        return { kind: "image", size: 24, stamp: "new" } as never;
      }
      return undefined as never;
    });
    const id = await openPath("C:/workspace/image.png", { pinned: true });
    await renameDocuments([{ from: "C:/workspace/image.png", to: "C:/workspace/renamed.png" }]);
    expect(useApp.getState().docs[id].path).toBe("C:/workspace/renamed.png");
    await refreshDocuments();
    expect(useApp.getState().docs[id].fileInfo?.stamp).toBe("new");
    expect(vi.mocked(call).mock.calls.some(([command]) => command === "read_document")).toBe(false);
    missing = true;
    await refreshDocuments();
    expect(useApp.getState().docs[id]).toMatchObject({ deleted: true, conflict: false });
  });
});

describe("Document move backups", () => {
  it("drains old backups and defers snapshots until paths have been rebound", async () => {
    const commandCalls = (name: string) => vi.mocked(call).mock.calls.filter(([command]) => command === name);
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    vi.mocked(call).mockImplementation(async command => command === "sync_documents" ? await pending as never : undefined as never);
    const backup = checkpoint();
    await vi.waitFor(() => expect(commandCalls("sync_documents")).toHaveLength(1));
    let started = false;
    const moving = beginDocumentMove(["C:/workspace/folder"]).then(release => { started = true; return release; });
    await checkpoint();
    expect(started).toBe(false);
    expect(commandCalls("sync_documents")).toHaveLength(1);
    complete();
    await backup;
    const release = await moving;
    try {
      await checkpoint();
      expect(commandCalls("sync_documents")).toHaveLength(1);
    } finally { release(); }
    await checkpoint();
    expect(commandCalls("sync_documents")).toHaveLength(2);
  });
});

describe("Markdown view navigation", () => {
  it("switches only the destination group to text when revealing a source line", () => {
    const { id } = addDocument({ language: "markdown", dirty: false });
    setApp({
      activeGroup: "one",
      groups: ["one", "two"].map((group) => ({
        id: group,
        tabs: [id],
        active: id,
        preview: null,
        views: {},
        mediaViews: { [id]: { mode: "markdown", scrollTop: 150 } },
      })),
    });
    showDocument(id, { group: "two", line: 8, column: 3 });
    expect(useApp.getState().groups[0].mediaViews?.[id]).toEqual({
      mode: "markdown",
      scrollTop: 150,
    });
    expect(useApp.getState().groups[1].mediaViews?.[id]).toEqual({ mode: "text", scrollTop: 150 });
  });
  it("copies the view on split and move, and keeps buffer contents in the session backup", async () => {
    const { id, buffer } = addDocument({ language: "markdown" });
    setApp({
      activeGroup: "one",
      groups: [
        {
          id: "one",
          tabs: [id],
          active: id,
          preview: null,
          views: {},
          mediaViews: { [id]: { mode: "markdown", scrollTop: 180 } },
        },
      ],
    });
    const split = splitGroup();
    patchMediaView(split, id, { mode: "text" });
    expect(useApp.getState().groups[0].mediaViews?.[id]?.mode).toBe("markdown");
    moveTab(id, split, "one");
    expect(useApp.getState().groups[0].mediaViews?.[id]).toEqual({ mode: "text", scrollTop: 180 });
    buffer.edit("# Unsaved Markdown");
    await checkpoint();
    const backup = vi
      .mocked(call)
      .mock.calls.filter(([command]) => command === "sync_documents")
      .slice(-1)[0]![1]!;
    expect((backup.documents as import("../types/types").Mirror[])[0]).toMatchObject({
      language: "markdown",
      text: "# Unsaved Markdown",
      dirty: true,
    });
    expect((backup.session as import("../types/types").Session).groups[0].mediaViews?.[id]).toEqual({
      mode: "text",
      scrollTop: 180,
    });
  });
});

describe("Automatic saves", () => {
  it.each([
    ["off", "onFocusChange", 0],
    ["off", "onWindowChange", 0],
    ["afterDelay", "onFocusChange", 0],
    ["afterDelay", "onWindowChange", 0],
    ["onWindowChange", "onFocusChange", 0],
    ["onWindowChange", "onWindowChange", 1],
    ["onFocusChange", "onFocusChange", 1],
    ["onFocusChange", "onWindowChange", 1],
  ] as const)("matches mode %s against event %s", async (mode, reason, count) => {
    const { id } = addDocument();
    setApp({ settings: { "files.autoSave": mode } });
    await autoSave(reason, id);
    expect(writes()).toHaveLength(count);
  });

  it("saves the document being left, even after the active document changes", async () => {
    const previous = addDocument();
    const next = addDocument();
    setApp({
      activeGroup: "group",
      groups: [
        { id: "group", tabs: [previous.id, next.id], active: next.id, preview: null, views: {} },
      ],
    });
    await autoSave("onFocusChange", previous.id);
    expect(writes().map((args) => args.id)).toEqual([previous.id]);
    expect(useApp.getState().docs[next.id].dirty).toBe(true);
    await autoSave("onFocusChange");
    expect(writes()).toHaveLength(1);
  });

  it.each(["onFocusChange", "onWindowChange"])(
    "saves all eligible documents on window blur in %s mode",
    async (mode) => {
      setApp({ settings: { "files.autoSave": mode } });
      const first = addDocument();
      const second = addDocument();
      addDocument({ path: null });
      addDocument({ dirty: false });
      addDocument({ conflict: true });
      const removed = addDocument();
      models.delete(removed.id);
      await autoSave("onWindowChange");
      expect(writes().map((args) => args.id)).toEqual([first.id, second.id]);
      expect(vi.mocked(call).mock.calls.some(([command]) => command === "pick_path")).toBe(false);
    },
  );

  it("reports failures and continues saving other documents, preserving conflicts", async () => {
    const failed = addDocument();
    const good = addDocument();
    vi.mocked(call).mockImplementation(async (command, args) => {
      if (command === "save_document" && args?.id === failed.id) {
        throw { code: "conflict", message: "File changed on disk" };
      }
      return "new-revision" as never;
    });
    await autoSave("onWindowChange");
    expect(useApp.getState().docs[failed.id]).toMatchObject({ dirty: true, conflict: true });
    expect(useApp.getState().docs[good.id].dirty).toBe(false);
    expect(useApp.getState().notice).toBe("File changed on disk");
    await autoSave("onWindowChange");
    expect(writes()).toHaveLength(2);
  });

  it("coalesces duplicate blur and model-switch saves before formatting or writing", async () => {
    const { id } = addDocument();
    setApp({ settings: { "files.autoSave": "onFocusChange", "editor.formatOnSave": true } });
    vi.mocked(canFormat).mockReturnValue(true);
    await Promise.all([
      autoSave("onFocusChange", id),
      autoSave("onFocusChange", id),
      autoSave("onWindowChange"),
    ]);
    expect(writes()).toHaveLength(1);
    expect(formatModel).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "onWindowChange", "conflict", "untitled", "removed"] as const)(
    "rechecks %s after waiting for an existing save",
    async (change) => {
      const { id, buffer } = addDocument();
      const pending = deferred<string>();
      vi.mocked(call).mockImplementation((command) =>
        command === "sync_documents"
          ? (pending.promise as never)
          : (Promise.resolve("new-revision") as never),
      );
      const manual = save(id);
      await vi.waitFor(() =>
        expect(vi.mocked(call).mock.calls.some(([command]) => command === "sync_documents")).toBe(
          true,
        ),
      );
      buffer.edit("new edits while saving");
      const queued = autoSave("onFocusChange", id);
      if (change === "conflict") {
        patchDoc(id, { conflict: true });
      } else if (change === "untitled") {
        patchDoc(id, { path: null });
      } else if (change === "removed") {
        models.delete(id);
      } else {
        setApp({ settings: { "files.autoSave": change } });
      }
      pending.resolve("new-revision");
      await Promise.all([manual, queued]);
      expect(writes()).toHaveLength(1);
    },
  );

  it("preserves edits made during a write and saves them on the next queued event", async () => {
    const { id, buffer } = addDocument();
    const pending = deferred<string>();
    vi.mocked(call).mockImplementation((command) =>
      command === "save_document" && writes().length === 1
        ? (pending.promise as never)
        : (Promise.resolve("next-revision") as never),
    );
    const first = autoSave("onFocusChange", id);
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    buffer.edit("new edits while saving");
    pending.resolve("first-revision");
    await first;
    expect(useApp.getState().docs[id].dirty).toBe(true);
    const second = autoSave("onFocusChange", id);
    const duplicate = autoSave("onFocusChange", id);
    await Promise.all([second, duplicate]);
    expect(writes().map((args) => [args.text, args.revision])).toEqual([
      ["edited", "old-revision"],
      ["new edits while saving", "first-revision"],
    ]);
    expect(useApp.getState().docs[id].dirty).toBe(false);
  });

  it("retains debounce timing for afterDelay and ignores focus events", async () => {
    setApp({ settings: { "files.autoSave": "afterDelay", "files.autoSaveDelay": 500 } });
    const { id, buffer } = addDocument({ dirty: false });
    buffer.edit("first");
    await vi.advanceTimersByTimeAsync(300);
    buffer.edit("last");
    await autoSave("onFocusChange", id);
    await autoSave("onWindowChange");
    await vi.advanceTimersByTimeAsync(499);
    expect(writes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes().map((args) => args.text)).toEqual(["last"]);
    expect(useApp.getState().docs[id].dirty).toBe(false);
  });

  it.each(["off", "conflict", "clean"] as const)(
    "rechecks a pending delay when the document becomes %s",
    async (change) => {
      setApp({ settings: { "files.autoSave": "afterDelay", "files.autoSaveDelay": 100 } });
      const { id, buffer } = addDocument({ dirty: false });
      buffer.edit("changed");
      if (change === "off") {
        setApp({ settings: { "files.autoSave": "off" } });
      } else {
        patchDoc(id, change === "conflict" ? { conflict: true } : { dirty: false });
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(writes()).toHaveLength(0);
    },
  );
});

describe("Document identity and save snapshots", () => {
  function fake(text: string, path: string) {
    return Object.assign(new Buffer(text), { uri: { toString: () => path } });
  }
  function setupFile(path: string) {
    const b = fake("unsaved-important", path);
    const id = path;
    vi.mocked(monaco.editor.createModel).mockReturnValueOnce(b as never);
    attachDocument({ id, path, name: "a.txt", language: "plaintext", encoding: "utf8", eol: "LF", dirty: true, version: 1, revision: "old" }, b.getValue(), true);
    setApp({ root: "C:/workspace", activeGroup: "one", groups: [{ id: "one", tabs: [id], active: id, preview: null, views: {} }] });
    return id;
  }
  it("preserves a renamed dirty document when the original path is opened again", async () => {
    const id = setupFile("C:/workspace/a.txt");
    vi.mocked(monaco.editor.createModel).mockImplementation((text, _lang, uri) => fake(text ?? "", String(uri)) as never);
    await renameDocuments([{ from: "C:/workspace/a.txt", to: "C:/workspace/b.txt" }]);
    expect(useApp.getState().docs[id]).toMatchObject({ path: "C:/workspace/b.txt", dirty: true });
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "inspect_file") { return { kind: "text", size: 8, stamp: "1" } as never; }
      if (command === "read_document") { return { text: "new-file", revision: "new", encoding: "utf8", eol: "LF" } as never; }
      return undefined as never;
    });
    await openPath("C:/workspace/a.txt");
    expect(Object.values(useApp.getState().docs).some(d => d.path === "C:/workspace/b.txt")).toBe(true);
    expect(models.get(id)?.getValue()).toBe("unsaved-important");
  });
  it("keeps Save As and the original path as separate documents", async () => {
    const id = setupFile("C:/workspace/a.txt");
    vi.mocked(monaco.editor.createModel).mockImplementation((text, _lang, uri) => fake(text ?? "", String(uri)) as never);
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "pick_path") { return "C:/workspace/b.txt" as never; }
      if (command === "read_document") { throw { code: "notFound", message: "not found" }; }
      return "saved" as never;
    });
    await save(id, true);
    expect(useApp.getState().docs[id].path).toBe("C:/workspace/b.txt");
    expect(useApp.getState().docs[id].id).toBe("C:/workspace/a.txt");
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "inspect_file") { return { kind: "text", size: 8, stamp: "1" } as never; }
      if (command === "read_document") { return { text: "original-file", revision: "new", encoding: "utf8", eol: "LF" } as never; }
      return undefined as never;
    });
    await openPath("C:/workspace/a.txt");
    expect(Object.keys(useApp.getState().docs)).toHaveLength(2);
    expect(Object.values(useApp.getState().docs).some(d => d.path === "C:/workspace/b.txt")).toBe(true);
  });
  it("keeps an encoding change dirty when it happens during a save", async () => {
    const { id } = addDocument();
    const pending = deferred<string>();
    vi.mocked(call).mockImplementation((command) => command === "save_document" ? pending.promise as never : Promise.resolve(undefined) as never);
    const saving = save(id);
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    patchDoc(id, { encoding: "utf16le", dirty: true });
    pending.resolve("saved");
    await saving;
    expect(writes()[0].encoding).toBe("utf8");
    expect(useApp.getState().docs[id]).toMatchObject({ encoding: "utf16le", dirty: true });
  });
});

it("restores large-file protection without starting a language service", () => {
  const b = new Buffer("let x=1");
  vi.mocked(monaco.editor.createModel).mockReturnValueOnce(b as never);
  vi.mocked(ensureLanguage).mockClear();
  restoreDocument({ id: "large-doc", path: "C:/workspace/large.ts", text: "let x=1", version: 1, revision: "r", encoding: "utf8", dirty: false, language: "typescript", kind: "text", fileInfo: { kind: "text", size: 21 * 1024 * 1024, stamp: "1" } });
  expect(useApp.getState().docs["large-doc"].large).toBe(true);
  expect(ensureLanguage).not.toHaveBeenCalled();
});

describe("External edits and conflict choices", () => {
  const disk = (revision = "external"): DiskDocument => ({
    path: "unused", text: "磁盘内容\r\n第二行\r\n", revision, encoding: "utf8", eol: "CRLF",
  });
  beforeEach(() => {
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "inspect_file") { return { kind: "text", size: 24, stamp: "external" } as never; }
      if (command === "read_document") { return disk() as never; }
      return (command === "save_document" ? "saved-choice" : undefined) as never;
    });
  });

  it("reloads a clean buffer without writing to disk", async () => {
    const { id, buffer } = addDocument({ dirty: false });
    await refreshDocuments();
    expect(buffer.getValue()).toBe(disk().text);
    expect(useApp.getState().docs[id]).toMatchObject({
      dirty: false, conflict: false, revision: "external", encoding: "utf8", eol: "CRLF",
    });
    expect(writes()).toHaveLength(0);
  });

  it("preserves the dirty buffer and marks conflicts without changing its saved revision", async () => {
    const { id, buffer } = addDocument();
    await refreshDocuments();
    expect(buffer.getValue()).toBe("edited");
    expect(useApp.getState().docs[id]).toMatchObject({ dirty: true, conflict: true, revision: "old-revision" });
    expect(writes()).toHaveLength(0);
  });

  it("shows both snapshots without writing or changing the buffer when comparing/cancelling", async () => {
    const { id, buffer } = addDocument({ conflict: true });
    const target = new EventTarget();
    const shown = vi.fn();
    target.addEventListener("show-diff", shown);
    vi.stubGlobal("window", target);
    await compareDisk(id);
    const diff = (shown.mock.calls[0][0] as CustomEvent<DiffRequest>).detail;
    expect(diff).toMatchObject({ before: disk().text, after: "edited", conflict: { id, revision: "external", version: 1 } });
    expect(writes()).toHaveLength(0);
    expect(buffer.getValue()).toBe("edited");
    expect(useApp.getState().docs[id]).toMatchObject({ conflict: true, dirty: true });
  });

  it("opens comparison for manual save conflicts and suppresses repeated auto-save attempts", async () => {
    const { id } = addDocument();
    const target = new EventTarget();
    const shown = vi.fn();
    target.addEventListener("show-diff", shown);
    vi.stubGlobal("window", target);
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async (command, args) => {
      if (command === "save_document") { throw { code: "conflict", message: "Disk changed" }; }
      return original(command, args);
    });
    await expect(save(id)).rejects.toMatchObject({ code: "conflict" });
    expect(shown).toHaveBeenCalledOnce();
    await autoSave("onWindowChange");
    expect(writes()).toHaveLength(1);
    expect(shown).toHaveBeenCalledOnce();
    patchDoc(id, { conflict: false });
    await autoSave("onWindowChange");
    expect(writes()).toHaveLength(2);
    expect(shown).toHaveBeenCalledOnce();
  });

  it("chooses disk content as an undoable buffer edit without writing to disk", async () => {
    const { id, buffer } = addDocument({ conflict: true });
    const diff = await readConflictDiff(id);
    await resolveConflict(diff.conflict!, "reload");
    expect(buffer.getValue()).toBe(disk().text);
    expect(buffer.pushStackElement).toHaveBeenCalledTimes(2);
    expect(buffer.pushEditOperations).toHaveBeenCalledOnce();
    expect(useApp.getState().docs[id]).toMatchObject({ dirty: false, conflict: false, revision: "external", eol: "CRLF" });
    expect(writes()).toHaveLength(0);
  });

  it("saves exactly the displayed editor content without format-on-save", async () => {
    const { id, buffer } = addDocument({ conflict: true });
    buffer.edit("当前内容\r\n保留这一版\r\n");
    setApp({ settings: { "editor.formatOnSave": true } });
    vi.mocked(canFormat).mockReturnValue(true);
    const diff = await readConflictDiff(id);
    await resolveConflict(diff.conflict!, "overwrite");
    expect(writes()).toEqual([expect.objectContaining({ text: diff.after, revision: "external" })]);
    expect(formatModel).not.toHaveBeenCalled();
    expect(useApp.getState().docs[id]).toMatchObject({ dirty: false, conflict: false, revision: "saved-choice" });
  });

  it.each(["reload", "overwrite"] as const)("rejects a changed disk snapshot before %s", async (action) => {
    const { id, buffer } = addDocument({ conflict: true });
    const diff = await readConflictDiff(id);
    vi.mocked(call).mockImplementation(async (command) => command === "read_document" ? disk("newer") as never : undefined as never);
    await expect(resolveConflict(diff.conflict!, action)).rejects.toMatchObject({ code: "conflict" });
    expect(writes()).toHaveLength(0);
    expect(buffer.getValue()).toBe("edited");
    expect((await readConflictDiff(id)).conflict!.revision).toBe("newer");
  });

  it.each(["version", "path", "encoding", "closed"] as const)("rejects changed %s while comparing", async (change) => {
    const { id, buffer } = addDocument({ conflict: true });
    const diff = await readConflictDiff(id);
    if (change === "version") { buffer.edit("new edits"); }
    if (change === "path") { patchDoc(id, { path: "C:/workspace/renamed.txt" }); }
    if (change === "encoding") { patchDoc(id, { encoding: "utf16le" }); }
    if (change === "closed") { setApp({ docs: {} }); }
    await expect(resolveConflict(diff.conflict!, "overwrite")).rejects.toMatchObject({ code: "conflict" });
    expect(writes()).toHaveLength(0);
  });

  it("rechecks editor changes after the asynchronous disk read", async () => {
    const { id, buffer } = addDocument({ conflict: true });
    const diff = await readConflictDiff(id);
    const pending = deferred<DiskDocument>();
    vi.mocked(call).mockImplementation(async (command) => command === "read_document" ? await pending.promise as never : undefined as never);
    const choosing = resolveConflict(diff.conflict!, "reload");
    await vi.waitFor(() => expect(vi.mocked(call).mock.calls.filter(([cmd]) => cmd === "read_document")).toHaveLength(2));
    buffer.edit("typed while reading");
    pending.resolve(disk());
    await expect(choosing).rejects.toMatchObject({ code: "conflict" });
    expect(buffer.getValue()).toBe("typed while reading");
  });

  it("serializes duplicate resolutions and writes only once", async () => {
    const { id } = addDocument({ conflict: true });
    const diff = await readConflictDiff(id);
    const results = await Promise.allSettled([
      resolveConflict(diff.conflict!, "overwrite"), resolveConflict(diff.conflict!, "overwrite"),
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(writes()).toHaveLength(1);
  });

  it("preserves the saved baseline if the backend rejects a last-moment disk change", async () => {
    const { id, buffer } = addDocument({ conflict: true });
    const diff = await readConflictDiff(id);
    vi.mocked(call).mockImplementation(async (command) => {
      if (command === "read_document") { return disk() as never; }
      if (command === "save_document") { throw { code: "conflict", message: "Changed again" }; }
      return undefined as never;
    });
    await expect(resolveConflict(diff.conflict!, "overwrite")).rejects.toMatchObject({ code: "conflict" });
    expect(buffer.getValue()).toBe("edited");
    expect(useApp.getState().docs[id]).toMatchObject({ dirty: true, conflict: true, revision: "old-revision" });
  });

  it.each(["notFound", "io"])("reports %s reads without presenting an empty disk as a valid choice", async (code) => {
    const { id, buffer } = addDocument({ conflict: true });
    vi.mocked(call).mockRejectedValue({ code, message: code === "io" ? "Permission denied" : "File deleted" });
    const diff = await readConflictDiff(id);
    expect(diff.error).toContain(code === "io" ? "Permission denied" : "File deleted");
    expect(diff.conflict!.revision).toBeNull();
    await expect(resolveConflict(diff.conflict!, "overwrite")).rejects.toMatchObject({ code: "conflict" });
    expect(buffer.getValue()).toBe("edited");
    expect(writes()).toHaveLength(0);
  });

  it("does not mislabel permission errors as file deletion", async () => {
    const { id } = addDocument();
    vi.mocked(call).mockRejectedValue({ code: "io", message: "Permission denied" });
    await refreshDocuments();
    expect(useApp.getState().docs[id].deleted).not.toBe(true);
    expect(useApp.getState().notice).toContain("Permission denied");
  });

  it("discards reads that complete after a newer refresh", async () => {
    const { id, buffer } = addDocument({ dirty: false });
    const pending = deferred<DiskDocument>();
    let reads = 0;
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async (command, args) => {
      if (command === "read_document" && ++reads === 1) { return await pending.promise as never; }
      return original(command, args);
    });
    const refreshing = refreshDocuments();
    await vi.waitFor(() => expect(reads).toBe(1));
    await refreshDocuments();
    pending.resolve({ ...disk("stale"), text: "stale content" });
    await refreshing;
    expect(buffer.getValue()).toBe(disk().text);
    expect(useApp.getState().docs[id].revision).toBe("external");
  });

  it("does not discard a pending refresh when an unrelated file changes", async () => {
    const { id, buffer } = addDocument({ dirty: false });
    const pending = deferred<DiskDocument>();
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async (command, args) =>
      command === "read_document" ? await pending.promise as never : original(command, args));
    const refreshing = refreshDocuments();
    await vi.waitFor(() => expect(vi.mocked(call).mock.calls.some(([cmd]) => cmd === "read_document")).toBe(true));
    await refreshDocuments(["C:/workspace/unrelated.txt"]);
    pending.resolve(disk());
    await refreshing;
    expect(buffer.getValue()).toBe(disk().text);
    expect(useApp.getState().docs[id].revision).toBe("external");
  });

  it("discards external reads that overlap an edit and successful save", async () => {
    const { id, buffer } = addDocument({ dirty: false });
    const pending = deferred<DiskDocument>();
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async (command, args) =>
      command === "read_document" ? await pending.promise as never : original(command, args));
    const refreshing = refreshDocuments();
    await vi.waitFor(() => expect(vi.mocked(call).mock.calls.some(([cmd]) => cmd === "read_document")).toBe(true));
    buffer.edit("saved newer edits");
    await save(id);
    pending.resolve(disk("stale"));
    await refreshing;
    expect(buffer.getValue()).toBe("saved newer edits");
    expect(useApp.getState().docs[id]).toMatchObject({ dirty: false, revision: "saved-choice" });
  });
});
