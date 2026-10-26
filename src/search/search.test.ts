import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const x = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../core/bridge", () => ({ call: x.call, channel: (fn: unknown) => fn, errorMessage: (e: any) => e.message }));
vi.mock("../editor/documents", () => ({ checkpoint: vi.fn(), newDocument: vi.fn(), openPath: vi.fn(), models: new Map(), showDocument: vi.fn(), normalize: (s: string) => s, relative: (s: string) => s, patchDoc: vi.fn(), basename: (s: string) => s, editors: new Map(), patchMediaView: vi.fn() }));
vi.mock("../editor/monaco", () => ({ monaco: { Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) { } getStartPosition() { return { column: this.startColumn } } getEndPosition() { return { column: this.endColumn } } }, editor: { createModel: (text: string) => ({ getValue: () => text.replace(/\r\n/g, "\n"), getVersionId: () => 1, isDisposed: () => false, getValueInRange: () => "a", getOffsetAt: (p: any) => p.column - 1, dispose: () => { } }) } } }));
import { activateSearchTab, cancelSearch, closeSearchTab, createSearchTab, replaceMatches, runSearch } from "../search/search";
import { checkpoint } from "../editor/documents";
import { initialSearch, patchSearch, primarySearchId, searchSession, setApp, useApp } from "../store/store";
import { defaultQuery, type SearchBatch, type SearchMatch } from "../types/types";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  setApp({ root: null, docs: {}, searchSessions: [initialSearch()], activeSearchId: primarySearchId, nextSearchNumber: 2, searchHistory: [] });
  vi.clearAllMocks();
  x.call.mockResolvedValue(undefined);
  vi.mocked(checkpoint).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const hit: SearchMatch = { path: "a.txt", documentId: null, version: null, line: 1, column: 1, endLine: 1, endColumn: 2, matched: "a", preview: "a" };
const query = (text: string) => ({ ...defaultQuery, text });
function request(index = 0) {
  return x.call.mock.calls.filter(([command]) => command === "search_start")[index][1] as {
    requestId: string; onBatch: (batch: SearchBatch) => void;
  };
}
function emit(job: ReturnType<typeof request>, patch: Partial<SearchBatch> = {}) {
  job.onBatch({ requestId: job.requestId, sequence: 1, matches: [hit], done: true, cancelled: false, limited: false, errors: [], ...patch });
}

describe("Search sessions", () => {
  it("creates blank independent sessions, retains numbering and cannot close the primary search", () => {
    patchSearch(primarySearchId, { query: query("original"), results: [hit] });
    const second = createSearchTab();
    const third = createSearchTab();
    expect(searchSession(second)).toMatchObject({ number: 2, query: defaultQuery, results: [] });
    closeSearchTab(third);
    expect(useApp.getState().activeSearchId).toBe(second);
    closeSearchTab(primarySearchId);
    expect(searchSession(primarySearchId)?.query.text).toBe("original");
    const fourth = createSearchTab();
    closeSearchTab(second);
    expect(useApp.getState().activeSearchId).toBe(fourth);
    expect(searchSession(fourth)?.number).toBe(4);
  });

  it("routes concurrent batches, errors and limits to their own session while sharing history", async () => {
    const second = createSearchTab();
    await runSearch(query("first"), primarySearchId);
    await runSearch(query("second"), second);
    activateSearchTab(primarySearchId);
    emit(request(1), { matches: [{ ...hit, path: "second.txt" }], limited: true, errors: ["warning"] });
    emit(request(0));
    expect(searchSession(primarySearchId)).toMatchObject({ results: [hit], searching: false, limited: false, searchErrors: [] });
    expect(searchSession(second)).toMatchObject({ results: [{ ...hit, path: "second.txt" }], searching: false, limited: true, searchErrors: ["warning"] });
    expect(useApp.getState().searchHistory).toEqual(["second", "first"]);
    expect(x.call.mock.calls.filter(([command]) => command === "search_ack")).toHaveLength(2);
  });

  it("ignores cancelled, replaced and closed requests without affecting other sessions", async () => {
    const second = createSearchTab();
    await runSearch(query("main"), primarySearchId);
    await runSearch(query("cancelled"), second);
    cancelSearch(second);
    emit(request(1));
    expect(searchSession(second)?.results).toEqual([]);
    expect(searchSession(primarySearchId)?.searching).toBe(true);
    await runSearch(query("old"), second);
    await runSearch(query("new"), second);
    emit(request(2));
    expect(searchSession(second)?.results).toEqual([]);
    closeSearchTab(second);
    emit(request(3));
    expect(searchSession(second)).toBeUndefined();
    emit(request(0));
    expect(searchSession(primarySearchId)?.results).toEqual([hit]);
  });

  it("does not start a closed search after its checkpoint resolves", async () => {
    let resolve!: () => void;
    vi.mocked(checkpoint).mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    const second = createSearchTab();
    const pending = runSearch(query("pending"), second);
    closeSearchTab(second);
    resolve();
    await pending;
    expect(x.call.mock.calls.some(([command]) => command === "search_start")).toBe(false);
  });

  it("cancels again when a closed request finishes registering in Rust", async () => {
    let resolve!: () => void;
    x.call.mockImplementation((command) => command === "search_start"
      ? new Promise<void>((done) => { resolve = done; }) : Promise.resolve());
    const second = createSearchTab();
    const pending = runSearch(query("pending"), second);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const requestId = request().requestId;
    closeSearchTab(second);
    resolve();
    await pending;
    expect(x.call.mock.calls.filter(([command, args]) => command === "search_cancel" && args.requestId === requestId)).toHaveLength(2);
    expect(useApp.getState().searchHistory).toEqual([]);
  });

  it("resets tabs on workspace change, retaining only the primary query and rejecting old batches", async () => {
    setApp({ root: "C:/old" });
    const second = createSearchTab();
    await runSearch({ ...query("primary"), include: "*.ts" }, primarySearchId);
    await runSearch(query("secondary"), second);
    emit(request(0), { done: false });
    setApp({ root: "C:/new" });
    emit(request(0));
    emit(request(1));
    expect(useApp.getState().searchSessions).toHaveLength(1);
    expect(useApp.getState().activeSearchId).toBe(primarySearchId);
    expect(searchSession(primarySearchId)).toMatchObject({ query: { text: "primary", include: "*.ts" }, results: [], requestId: null, searching: false });
    expect(x.call.mock.calls.filter(([command]) => command === "search_start")).toHaveLength(2);
  });

  it("reports start failures only in the originating session and handles empty queries locally", async () => {
    const second = createSearchTab();
    x.call.mockImplementation(async (command) => { if (command === "search_start") { throw new Error("busy"); } });
    await runSearch(query("secondary"), second);
    expect(searchSession(second)).toMatchObject({ searching: false, requestId: null, searchErrors: ["busy"] });
    expect(searchSession(primarySearchId)?.searchErrors).toEqual([]);
    x.call.mockClear();
    await runSearch(defaultQuery, second);
    expect(searchSession(second)).toMatchObject({ searching: false, requestId: null, searchErrors: [], results: [] });
    expect(x.call).not.toHaveBeenCalled();
  });
});
it("preserves original mixed line endings in the disk replacement journal", async () => {
  const original = "a\r\nb\nc\n";
  x.call.mockImplementation(async (command: string) => {
    if (command === "read_document") { return { text: original, encoding: "utf8", revision: "original-byte-hash" }; }
    if (command === "replacement_plan") { return [{ line: 1, column: 1, endLine: 1, endColumn: 2, text: "x" }]; }
    if (command === "replace_disk") { return { succeeded: ["mixed.txt"], failed: [], remaining: [], complete: true }; }
  });
  await replaceMatches([{ path: "mixed.txt", documentId: null, version: null, line: 1, column: 1, endLine: 1, endColumn: 2, matched: "a", preview: "a" }], "x", false, query("a"));
  const write = x.call.mock.calls.find(([command]) => command === "replace_disk");
  expect(write?.[1].edits).toEqual([{ path: "mixed.txt", before: original, after: "x\nb\nc\n", encoding: "utf8", revision: "original-byte-hash" }]);
});
