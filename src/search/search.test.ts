import { expect, it, vi } from "vitest";
const x = vi.hoisted(() => ({ call: vi.fn(), notify: vi.fn(), state: { query: { text: "a", regex: false }, docs: {}, results: [], requestId: null } }));
vi.mock("../core/bridge", () => ({ call: x.call, channel: vi.fn(), errorMessage: (e: any) => e.message }));
vi.mock("../store/store", () => ({ useApp: { getState: () => x.state }, setApp: vi.fn(), notify: x.notify }));
vi.mock("../editor/documents", () => ({ checkpoint: vi.fn(), newDocument: vi.fn(), openPath: vi.fn(), models: new Map(), showDocument: vi.fn(), normalize: (s: string) => s, relative: (s: string) => s, patchDoc: vi.fn(), basename: (s: string) => s, editors: new Map(), patchMediaView: vi.fn() }));
vi.mock("../editor/monaco", () => ({ monaco: { Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) { } getStartPosition() { return { column: this.startColumn } } getEndPosition() { return { column: this.endColumn } } }, editor: { createModel: (text: string) => ({ getValue: () => text.replace(/\r\n/g, "\n"), getVersionId: () => 1, getValueInRange: () => "a", getOffsetAt: (p: any) => p.column - 1, dispose: () => { } }) } } }));
import { replaceMatches } from "../search/search";
it("preserves original mixed line endings in the disk replacement journal", async () => {
  const original = "a\r\nb\nc\n";
  x.call.mockImplementation(async (command: string) => {
    if (command === "read_document") { return { text: original, encoding: "utf8", revision: "original-byte-hash" }; }
    if (command === "replacement_plan") { return [{ line: 1, column: 1, endLine: 1, endColumn: 2, text: "x" }]; }
    if (command === "replace_disk") { return { succeeded: ["mixed.txt"], failed: [] }; }
  });
  await replaceMatches([{ path: "mixed.txt", documentId: null, version: null, line: 1, column: 1, endLine: 1, endColumn: 2, matched: "a", preview: "a" }], "x", false, x.state.query as never);
  const write = x.call.mock.calls.find(([command]) => command === "replace_disk");
  expect(write?.[1].edits).toEqual([{ path: "mixed.txt", before: original, after: "x\nb\nc\n", encoding: "utf8", revision: "original-byte-hash" }]);
});
