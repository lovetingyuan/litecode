import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const x = vi.hoisted(() => ({ call: vi.fn(), ask: vi.fn(), checkpoint: vi.fn(), notify: vi.fn() }));
vi.mock("../core/bridge", () => ({ call: x.call, errorMessage: (e: Error) => e.message }));
vi.mock("../components/dialog", () => ({ ask: x.ask }));
vi.mock("../editor/documents", () => ({
  checkpoint: x.checkpoint, models: new Map(), normalize: (s: string) => s.replace(/^\\\\\?\\/, "").toLowerCase(),
  relative: (s: string) => s, basename: (s: string) => s, patchDoc: vi.fn(), restoreDocument: vi.fn(), showDocument: vi.fn(),
}));
vi.mock("../editor/monaco", () => ({
  monaco: {
    Range: class {
      constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}
      getStartPosition() { return { column: this.startColumn }; }
      getEndPosition() { return { column: this.endColumn }; }
    },
    editor: { createModel: (text: string) => makeModel(text) },
  },
}));
import { replaceMatches, undoReplacement, retryReplacement, recoverInterruptedReplacements } from "./replacements";
import { models } from "../editor/documents";
import { defaultQuery, type Doc, type SearchMatch } from "../types/types";
import { setApp } from "../store/store";

function makeModel(initial: string) {
  let text = initial;
  const push = vi.fn((_cursor, edits) => {
    for (const edit of edits) { text = edit.text; }
  });
  return {
    getValue: () => text, getVersionId: () => 1, getEOL: () => "\n",
    getValueInRange: () => text.slice(0, 1), getOffsetAt: (p: { column: number }) => p.column - 1,
    pushEditOperations: push, pushStackElement: vi.fn(), getFullModelRange: () => ({}), dispose: vi.fn(),
  };
}
const root = "C:/project";
const path = root + "/closed.txt";
const hit: SearchMatch = { path, documentId: null, version: null, line: 1, column: 1, endLine: 1, endColumn: 2, matched: "a", preview: "a" };
const query = { ...defaultQuery, text: "a" };
const complete = () => ({ succeeded: [path], failed: [], remaining: [], complete: true });
let currentId = "";
let record: any;
let custom: ((command: string, args: any) => unknown) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  setApp({ root: "reset" });
  setApp({ root, docs: {} });
  models.clear();
  vi.clearAllMocks();
  custom = undefined; record = undefined; currentId = "";
  x.ask.mockResolvedValue("稍后处理");
  x.checkpoint.mockResolvedValue(undefined);
  x.call.mockImplementation(async (command: string, args: any) => {
    if (custom) {
      const result = custom(command, args);
      if (result !== undefined) { return await result; }
    }
    if (command === "read_document") { return { text: "a", encoding: "utf8", revision: "before" }; }
    if (command === "replacement_plan") { return [{ line: 1, column: 1, endLine: 1, endColumn: 2, text: "x" }]; }
    if (command === "replace_disk") {
      currentId = args.transactionId;
      record = { transactionId: currentId, root, paths: [path], buffers: args.buffers, targetAfter: true };
      return complete();
    }
    if (command === "replay_replacement") { record = { ...record, targetAfter: args.redo }; return complete(); }
    if (command === "resume_replacement") { return complete(); }
    if (command === "finish_replacement") { return; }
    if (command === "replacement_recovery") { return record ? [record] : []; }
    if (command === "recover_replacement") { record.targetAfter = false; return complete(); }
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function openBuffer() {
  const doc: Doc = { id: "open", path: root + "/open.txt", name: "open.txt", kind: "text", language: "plaintext", eol: "LF", encoding: "utf8", revision: "original", version: 1, dirty: true };
  setApp({ docs: { open: doc } });
  const m = makeModel("a");
  models.set("open", m as any);
  return m;
}
const openHit = { ...hit, path: root + "/open.txt", documentId: "open", version: 1 };

describe("Workspace replacement safety", () => {
  it("persists the group before touching open buffers and commits only after checkpoint", async () => {
    const m = openBuffer();
    custom = (command) => {
      if (command === "replace_disk") { expect(m.getValue()).toBe("a"); }
      if (command === "finish_replacement") { expect(m.getValue()).toBe("x"); expect(x.checkpoint).toHaveBeenCalledTimes(2); }
    };
    expect(await replaceMatches([openHit, hit], "x", false, query)).toEqual([]);
    expect(m.getValue()).toBe("x");
    expect(x.call.mock.calls.find(([command]) => command === "replace_disk")?.[1].buffers[0].before).toMatchObject({ text: "a", dirty: true });
  });

  it("keeps the group on the undo stack after a partial disk failure and retries without repeating buffer edits", async () => {
    const m = openBuffer();
    await replaceMatches([openHit, hit], "x", false, query);
    let failed = false;
    custom = (command) => {
      if (command === "replay_replacement" && !failed) {
        failed = true;
        return { succeeded: [], failed: ["disk full"], remaining: [path], complete: false };
      }
    };
    await undoReplacement();
    expect(m.getValue()).toBe("x");
    await undoReplacement();
    expect(m.getValue()).toBe("a");
    expect(x.call.mock.calls.filter(([command]) => command === "resume_replacement")).toHaveLength(1);
    expect(m.pushEditOperations).toHaveBeenCalledTimes(2);
    await undoReplacement(true);
    expect(m.getValue()).toBe("x");
  });

  it("retains the identifier when the initial write loses its IPC response", async () => {
    const m = openBuffer();
    custom = (command, args) => {
      if (command === "replace_disk") {
        currentId = args.transactionId;
        record = { transactionId: currentId, root, paths: [path], buffers: args.buffers, targetAfter: true };
        return Promise.reject(new Error("response lost"));
      }
    };
    expect(await replaceMatches([openHit, hit], "x", false, query)).toEqual(["response lost"]);
    expect(m.getValue()).toBe("a");
    custom = undefined;
    await retryReplacement();
    expect(x.call.mock.calls.find(([command]) => command === "resume_replacement")?.[1].transactionId).toBe(currentId);
    expect(m.getValue()).toBe("x");
    await undoReplacement();
    expect(m.getValue()).toBe("a");
  });

  it("retries an ambiguous completion acknowledgement without applying the buffers twice", async () => {
    const m = openBuffer();
    let lost = false;
    custom = (command) => {
      if (command === "finish_replacement" && !lost) { lost = true; record = undefined; return Promise.reject(new Error("ACK lost")); }
    };
    await replaceMatches([openHit, hit], "x", false, query);
    expect(m.getValue()).toBe("x");
    await retryReplacement();
    expect(m.pushEditOperations).toHaveBeenCalledTimes(1);
    expect(x.call.mock.calls.filter(([command]) => command === "resume_replacement")).toHaveLength(0);
    await undoReplacement();
    expect(m.getValue()).toBe("a");
  });

  it("serializes repeated undo commands and rejects changed open buffers before any disk write", async () => {
    const m = openBuffer();
    await replaceMatches([openHit, hit], "x", false, query);
    await Promise.all([undoReplacement(), undoReplacement()]);
    expect(x.call.mock.calls.filter(([command]) => command === "replay_replacement")).toHaveLength(1);
    await undoReplacement(true);
    m.pushEditOperations([], [{ text: "later edits" }]);
    const count = x.call.mock.calls.filter(([command]) => command === "replay_replacement").length;
    await undoReplacement();
    expect(x.call.mock.calls.filter(([command]) => command === "replay_replacement")).toHaveLength(count);
    expect(m.getValue()).toBe("later edits");
  });

  it("leaves disk and buffers alone when recovery is deferred or the user keeps the current state", async () => {
    record = { transactionId: "abc", root, paths: [path], buffers: [], targetAfter: true };
    await recoverInterruptedReplacements();
    expect(x.ask.mock.calls[0][2][0]).toBe("稍后处理");
    expect(x.call.mock.calls.some(([command]) => command === "recover_replacement")).toBe(false);
    x.ask.mockResolvedValueOnce("保留现状");
    await recoverInterruptedReplacements();
    expect(x.call.mock.calls.find(([command]) => command === "recover_replacement")?.[1]).toEqual({ transactionId: "abc", keep: true });
    expect(x.call.mock.calls.some(([command]) => command === "finish_replacement")).toBe(false);
  });

  it("restores interrupted disk and buffer operations with a durable completion marker", async () => {
    const m = openBuffer();
    await replaceMatches([openHit, hit], "x", false, query);
    x.ask.mockResolvedValueOnce("恢复操作前状态");
    await recoverInterruptedReplacements();
    expect(m.getValue()).toBe("a");
    expect(x.call.mock.calls.filter(([command]) => command === "finish_replacement")).toHaveLength(2);
  });

  it("can keep a window's backup when its original workspace is missing", async () => {
    setApp({ root: null });
    record = { transactionId: "abc", root: "C:/missing", paths: [path], buffers: [], targetAfter: true };
    x.ask.mockResolvedValueOnce("保留现状");
    await recoverInterruptedReplacements();
    expect(x.call.mock.calls.find(([command]) => command === "recover_replacement")?.[1]).toEqual({ transactionId: "abc", keep: true });
  });
});
