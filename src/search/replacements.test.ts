import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const x = vi.hoisted(() => ({ call: vi.fn(), ask: vi.fn(), checkpoint: vi.fn(), notify: vi.fn() }));
vi.mock("../core/bridge", () => ({ call: x.call, errorMessage: (e: Error) => e.message }));
vi.mock("../components/dialog", () => ({ ask: x.ask }));
vi.mock("../editor/documents", () => ({
  checkpoint: x.checkpoint,
  models: new Map(),
  normalize: (s: string) => s.replace(/^\\\\\?\\/, "").toLowerCase(),
  relative: (s: string) => s,
  basename: (s: string) => s,
  patchDoc: vi.fn(),
  restoreDocument: vi.fn(),
  showDocument: vi.fn(),
}));
vi.mock("../editor/monaco", () => ({
  monaco: {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
      getStartPosition() {
        return { lineNumber: this.startLineNumber, column: this.startColumn };
      }
      getEndPosition() {
        return { lineNumber: this.endLineNumber, column: this.endColumn };
      }
    },
    editor: { createModel: (text: string) => makeModel(text) },
  },
}));
import {
  replaceMatches,
  cancelReplacementPlan,
  undoReplacement,
  retryReplacement,
  recoverInterruptedReplacements,
} from "./replacements";
import { models } from "../editor/documents";
import { defaultQuery, type Doc, type SearchMatch } from "../types/types";
import { setApp, useApp } from "../store/store";

function makeModel(initial: string) {
  let text = initial;
  const offset = (p: { lineNumber?: number; column: number }) => {
    const lines = text.split("\n");
    return (
      lines.slice(0, (p.lineNumber ?? 1) - 1).reduce((n, line) => n + line.length + 1, 0) +
      p.column -
      1
    );
  };
  const push = vi.fn((_cursor, edits) => {
    for (const edit of edits) {
      text = edit.text;
    }
  });
  return {
    getValue: () => text,
    getVersionId: () => 1,
    getEOL: () => "\n",
    isDisposed: () => false,
    getValueInRange: (r: {
      getStartPosition: () => { column: number };
      getEndPosition: () => { column: number };
    }) => text.slice(offset(r.getStartPosition()), offset(r.getEndPosition())),
    getOffsetAt: offset,
    pushEditOperations: push,
    pushStackElement: vi.fn(),
    getFullModelRange: () => ({}),
    dispose: vi.fn(),
  };
}
const root = "C:/project";
const path = root + "/closed.txt";
const hit: SearchMatch = {
  path,
  documentId: null,
  version: null,
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  matched: "a",
  preview: "a",
};
const query = { ...defaultQuery, text: "a" };
const complete = () => ({ succeeded: [path], failed: [], remaining: [], complete: true });
let currentId = "";
let record: any;
let custom: ((command: string, args: any) => unknown) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  setApp({ root: "reset" });
  setApp({ root, docs: {} });
  models.clear();
  vi.clearAllMocks();
  custom = undefined;
  record = undefined;
  currentId = "";
  x.ask.mockResolvedValue("稍后处理");
  x.checkpoint.mockResolvedValue(undefined);
  x.call.mockImplementation(async (command: string, args: any) => {
    if (custom) {
      const result = custom(command, args);
      if (result !== undefined) {
        return await result;
      }
    }
    if (command === "read_document") {
      return { text: "a", encoding: "utf8", revision: "before" };
    }
    if (command === "replacement_plan") {
      return [{ line: 1, column: 1, endLine: 1, endColumn: 2, text: "x" }];
    }
    if (command === "replace_disk") {
      currentId = args.transactionId;
      record = {
        transactionId: currentId,
        root,
        paths: [path],
        buffers: args.buffers,
        targetAfter: true,
      };
      return complete();
    }
    if (command === "replay_replacement") {
      record = { ...record, targetAfter: args.redo };
      return complete();
    }
    if (command === "resume_replacement") {
      return complete();
    }
    if (command === "finish_replacement") {
      return;
    }
    if (command === "replacement_recovery") {
      return record ? [record] : [];
    }
    if (command === "recover_replacement") {
      record.targetAfter = false;
      return complete();
    }
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openBuffer() {
  const doc: Doc = {
    id: "open",
    path: root + "/open.txt",
    name: "open.txt",
    kind: "text",
    language: "plaintext",
    eol: "LF",
    encoding: "utf8",
    revision: "original",
    version: 1,
    dirty: true,
  };
  setApp({ docs: { open: doc } });
  const m = makeModel("a");
  models.set("open", m as any);
  return m;
}
const openHit = { ...hit, path: root + "/open.txt", documentId: "open", version: 1 };

describe("Workspace replacement safety", () => {
  it.each(["replacement_plan_begin", "replacement_plan"])(
    "cancels while %s is pending and releases the task without a transaction",
    async (stage) => {
      const m = openBuffer();
      let release!: (result?: unknown) => void;
      custom = (command) =>
        command === stage
          ? new Promise((resolve) => {
              release = resolve;
            })
          : undefined;
      const pending = replaceMatches([openHit], "x", false, query);
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(useApp.getState().replacementPhase).toBe("planning");
      expect(await replaceMatches([openHit], "x", false, query)).toEqual([
        "A replacement is already running",
      ]);
      cancelReplacementPlan();
      release(stage === "replacement_plan" ? [{ ...openHit, text: "x" }] : undefined);
      expect(await pending).toBeNull();
      expect(m.getValue()).toBe("a");
      expect(x.call.mock.calls.some(([command]) => command === "replace_disk")).toBe(false);
      expect(x.call).toHaveBeenCalledWith("replacement_plan_release", expect.any(Object));
      expect(useApp.getState().replacementPhase).toBeNull();
      custom = undefined;
      expect(await replaceMatches([openHit], "x", false, query)).toEqual([]);
    },
  );

  it("cancels at the final checkpoint before creating a transaction", async () => {
    const m = openBuffer();
    let release!: () => void;
    x.checkpoint.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = replaceMatches([openHit], "x", false, query);
    await vi.waitFor(() => expect(release).toBeDefined());
    cancelReplacementPlan();
    release();
    expect(await pending).toBeNull();
    expect(m.getValue()).toBe("a");
    expect(x.call.mock.calls.some(([command]) => command === "replace_disk")).toBe(false);
  });

  it("discards a late preview when the workspace changes", async () => {
    let release!: (result: unknown) => void;
    custom = (command) =>
      command === "replacement_plan"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    const pending = replaceMatches([hit], "x", false, query, true);
    await vi.waitFor(() => expect(release).toBeDefined());
    setApp({ root: "C:/other" });
    release([{ ...hit, text: "x" }]);
    expect(await pending).toBeNull();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(x.call.mock.calls.some(([command]) => command === "replace_disk")).toBe(false);
    expect(x.call).toHaveBeenCalledWith("replacement_plan_cancel", expect.any(Object));
  });

  it("yields during frontend assembly and cancels without applying any files", async () => {
    vi.spyOn(performance, "now").mockImplementation(() => vi.getMockedSystemTime()!.valueOf());
    const hits = Array.from({ length: 1000 }, (_, i) => ({
      ...hit,
      column: i + 1,
      endColumn: i + 2,
    }));
    custom = (command) => {
      if (command === "read_document") {
        return { text: "a".repeat(1000), encoding: "utf8", revision: "before" };
      }
      if (command === "replacement_plan") {
        // Force a frontend scheduling boundary after the native result arrives.
        vi.advanceTimersByTime(10);
        setTimeout(cancelReplacementPlan, 0);
        return hits.map((match) => ({ ...match, text: "x" }));
      }
    };
    expect(await replaceMatches(hits, "x", false, query)).toBeNull();
    expect(x.call.mock.calls.some(([command]) => command === "replace_disk")).toBe(false);
  });

  it("builds selected unsorted edits in UTF-16 coordinates without replacing unselected matches", async () => {
    const text = "a🙂 a中 a";
    const hits = [1, 5, 8].map((column) => ({ ...hit, column, endColumn: column + 1 }));
    custom = (command) => {
      if (command === "read_document") {
        return { text, encoding: "utf8", revision: "before" };
      }
      if (command === "replacement_plan") {
        return hits.map((match) => ({ ...match, text: "x" }));
      }
    };
    expect(await replaceMatches([hits[2], hits[0]], "x", false, query)).toEqual([]);
    expect(
      x.call.mock.calls.find(([command]) => command === "replace_disk")![1].edits[0].after,
    ).toBe("x🙂 a中 x");
  });

  it("keeps cancellation disabled once disk application has started", async () => {
    const m = openBuffer();
    custom = (command) => {
      if (command === "replace_disk") {
        expect(useApp.getState().replacementPhase).toBe("applying");
        cancelReplacementPlan();
      }
    };
    expect(await replaceMatches([openHit], "x", false, query)).toEqual([]);
    expect(m.getValue()).toBe("x");
    expect(x.call.mock.calls.some(([command]) => command === "replacement_plan_cancel")).toBe(
      false,
    );
  });

  it("releases a planning task after a native planning failure", async () => {
    custom = (command) =>
      command === "replacement_plan" ? Promise.reject(new Error("bad pattern")) : undefined;
    expect(await replaceMatches([hit], "x", false, query)).toEqual(["bad pattern"]);
    expect(x.call).toHaveBeenCalledWith("replacement_plan_release", expect.any(Object));
    expect(useApp.getState().replacementPhase).toBeNull();
  });

  it("persists the group before touching open buffers and commits only after checkpoint", async () => {
    const m = openBuffer();
    custom = (command) => {
      if (command === "replace_disk") {
        expect(m.getValue()).toBe("a");
      }
      if (command === "finish_replacement") {
        expect(m.getValue()).toBe("x");
        expect(x.checkpoint).toHaveBeenCalledTimes(2);
      }
    };
    expect(await replaceMatches([openHit, hit], "x", false, query)).toEqual([]);
    expect(m.getValue()).toBe("x");
    expect(
      x.call.mock.calls.find(([command]) => command === "replace_disk")?.[1].buffers[0].before,
    ).toMatchObject({ text: "a", dirty: true });
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
    expect(x.call.mock.calls.filter(([command]) => command === "resume_replacement")).toHaveLength(
      1,
    );
    expect(m.pushEditOperations).toHaveBeenCalledTimes(2);
    await undoReplacement(true);
    expect(m.getValue()).toBe("x");
  });

  it("retains the identifier when the initial write loses its IPC response", async () => {
    const m = openBuffer();
    custom = (command, args) => {
      if (command === "replace_disk") {
        currentId = args.transactionId;
        record = {
          transactionId: currentId,
          root,
          paths: [path],
          buffers: args.buffers,
          targetAfter: true,
        };
        return Promise.reject(new Error("response lost"));
      }
    };
    expect(await replaceMatches([openHit, hit], "x", false, query)).toEqual(["response lost"]);
    expect(m.getValue()).toBe("a");
    custom = undefined;
    await retryReplacement();
    expect(
      x.call.mock.calls.find(([command]) => command === "resume_replacement")?.[1].transactionId,
    ).toBe(currentId);
    expect(m.getValue()).toBe("x");
    await undoReplacement();
    expect(m.getValue()).toBe("a");
  });

  it("retries an ambiguous completion acknowledgement without applying the buffers twice", async () => {
    const m = openBuffer();
    let lost = false;
    custom = (command) => {
      if (command === "finish_replacement" && !lost) {
        lost = true;
        record = undefined;
        return Promise.reject(new Error("ACK lost"));
      }
    };
    await replaceMatches([openHit, hit], "x", false, query);
    expect(m.getValue()).toBe("x");
    await retryReplacement();
    expect(m.pushEditOperations).toHaveBeenCalledTimes(1);
    expect(x.call.mock.calls.filter(([command]) => command === "resume_replacement")).toHaveLength(
      0,
    );
    await undoReplacement();
    expect(m.getValue()).toBe("a");
  });

  it("serializes repeated undo commands and rejects changed open buffers before any disk write", async () => {
    const m = openBuffer();
    await replaceMatches([openHit, hit], "x", false, query);
    await Promise.all([undoReplacement(), undoReplacement()]);
    expect(x.call.mock.calls.filter(([command]) => command === "replay_replacement")).toHaveLength(
      1,
    );
    await undoReplacement(true);
    m.pushEditOperations([], [{ text: "later edits" }]);
    const count = x.call.mock.calls.filter(([command]) => command === "replay_replacement").length;
    await undoReplacement();
    expect(x.call.mock.calls.filter(([command]) => command === "replay_replacement")).toHaveLength(
      count,
    );
    expect(m.getValue()).toBe("later edits");
  });

  it("leaves disk and buffers alone when recovery is deferred or the user keeps the current state", async () => {
    record = { transactionId: "abc", root, paths: [path], buffers: [], targetAfter: true };
    await recoverInterruptedReplacements();
    expect(x.ask.mock.calls[0][2][0]).toBe("稍后处理");
    expect(x.call.mock.calls.some(([command]) => command === "recover_replacement")).toBe(false);
    x.ask.mockResolvedValueOnce("保留现状");
    await recoverInterruptedReplacements();
    expect(x.call.mock.calls.find(([command]) => command === "recover_replacement")?.[1]).toEqual({
      transactionId: "abc",
      keep: true,
    });
    expect(x.call.mock.calls.some(([command]) => command === "finish_replacement")).toBe(false);
  });

  it("restores interrupted disk and buffer operations with a durable completion marker", async () => {
    const m = openBuffer();
    await replaceMatches([openHit, hit], "x", false, query);
    x.ask.mockResolvedValueOnce("恢复操作前状态");
    await recoverInterruptedReplacements();
    expect(m.getValue()).toBe("a");
    expect(x.call.mock.calls.filter(([command]) => command === "finish_replacement")).toHaveLength(
      2,
    );
  });

  it("can keep a window's backup when its original workspace is missing", async () => {
    setApp({ root: null });
    record = {
      transactionId: "abc",
      root: "C:/missing",
      paths: [path],
      buffers: [],
      targetAfter: true,
    };
    x.ask.mockResolvedValueOnce("保留现状");
    await recoverInterruptedReplacements();
    expect(x.call.mock.calls.find(([command]) => command === "recover_replacement")?.[1]).toEqual({
      transactionId: "abc",
      keep: true,
    });
  });
});
