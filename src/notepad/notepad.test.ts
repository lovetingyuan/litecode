import { describe, expect, it } from "vitest";
import type { NoteMeta, NotepadSnapshot } from "../types/notepad";
import { computeTextStats, displayNoteName, parseTitleAndFormat, sortNotes } from "./formats";
import {
  canReorderNotes,
  closeTabFromList,
  isReorderNoOp,
  isSyntaxHighlightEnabled,
  moveIdInList,
  reconcileSnapshot,
  reorderNotesByIds,
  reorderTabList,
  syncTabsToNoteOrder,
} from "./state";

function makeNote(overrides: Partial<NoteMeta> & { id: string }): NoteMeta {
  return {
    title: "Note",
    format: "txt",
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
    preview: "",
    revision: 1,
    ...overrides,
  };
}

describe("notepad formats and title parsing", () => {
  it("parses known text extensions and preserves dotted non-extension titles", () => {
    expect(parseTitleAndFormat("meeting.md", "txt")).toEqual({ title: "meeting", format: "md" });
    expect(parseTitleAndFormat("config.yml", "txt")).toEqual({ title: "config", format: "yaml" });
    expect(parseTitleAndFormat(".env.local", "txt")).toEqual({
      title: ".env.local",
      format: "env",
    });
    expect(parseTitleAndFormat("Release v1.2", "txt")).toEqual({
      title: "Release v1.2",
      format: "txt",
    });
    expect(parseTitleAndFormat("   ", "txt")).toBeNull();
  });

  it("formats display names without duplicating extensions", () => {
    expect(displayNoteName("Note 1", "txt")).toBe("Note 1.txt");
    expect(displayNoteName("Note 1.txt", "txt")).toBe("Note 1.txt");
    expect(displayNoteName(".env.production", "env")).toBe(".env.production");
  });

  it("computes lines, words, and characters accurately", () => {
    expect(computeTextStats("")).toEqual({ lines: 1, words: 0, chars: 0 });
    expect(computeTextStats("hello world\nsecond\tline")).toEqual({
      lines: 2,
      words: 4,
      chars: 23,
    });
  });

  it("keeps pinned notes above unpinned notes across sort orders", () => {
    const a = makeNote({ id: "a", title: "Zebra", pinned: true, updatedAt: 100 });
    const b = makeNote({ id: "b", title: "Alpha", pinned: false, updatedAt: 500 });
    const c = makeNote({ id: "c", title: "Beta", pinned: false, updatedAt: 200 });
    expect(sortNotes([b, c, a], "manual").map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(sortNotes([c, b, a], "manual").map((n) => n.id)).toEqual(["a", "c", "b"]);
    expect(sortNotes([b, c, a], "updated").map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(sortNotes([b, c, a], "title").map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
  it("defaults syntax highlighting to enabled per note until explicitly disabled", () => {
    expect(isSyntaxHighlightEnabled({}, "n1")).toBe(true);
    expect(isSyntaxHighlightEnabled({ n1: false }, "n1")).toBe(false);
    expect(isSyntaxHighlightEnabled({ n1: false }, "n2")).toBe(true);
  });
});

describe("notepad global sync reconciliation and tab operations", () => {
  it("preserves local active tab during remote updates and prunes deleted notes", () => {
    const snapshot: NotepadSnapshot = {
      revision: 5,
      notes: [makeNote({ id: "n1" }), makeNote({ id: "n3" })],
      activeId: "n3",
      openTabs: ["n3"],
    };
    const reconciled = reconcileSnapshot(
      {
        openTabs: ["n1", "n2"],
        activeId: "n1",
        contents: { n1: "keep", n2: "deleted" },
        markdownPreview: { n1: true, n2: true },
        syntaxHighlight: { n1: false, n2: false, n3: true },
      },
      snapshot,
    );
    expect(reconciled.activeId).toBe("n1");
    expect(reconciled.openTabs).toEqual(["n1"]);
    expect(reconciled.contents).toEqual({ n1: "keep" });
    expect(reconciled.markdownPreview).toEqual({ n1: true });
    expect(reconciled.syntaxHighlight).toEqual({ n1: false });

    const adopted = reconcileSnapshot(
      { openTabs: [], activeId: null, contents: {}, markdownPreview: {}, syntaxHighlight: {} },
      snapshot,
      { adoptTabs: true },
    );
    expect(adopted.activeId).toBe("n3");
    expect(adopted.openTabs).toEqual(["n3"]);
  });

  it("closes tabs and selects neighbor without losing remaining tabs", () => {
    expect(closeTabFromList(["a", "b", "c"], "b", "b")).toEqual({
      openTabs: ["a", "c"],
      activeId: "c",
    });
    expect(closeTabFromList(["a", "b"], "b", "b")).toEqual({
      openTabs: ["a"],
      activeId: "a",
    });
    expect(closeTabFromList(["a"], "a", "a")).toEqual({
      openTabs: [],
      activeId: null,
    });
    expect(reorderTabList(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("reorders notes with before/after placement and syncs open tabs to follow note order", () => {
    expect(moveIdInList(["a", "b", "c", "d"], "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(moveIdInList(["a", "b", "c", "d"], "a", "d", "after")).toEqual(["b", "c", "d", "a"]);
    expect(moveIdInList(["a", "b", "c", "d"], "a", "b", "after")).toEqual(["b", "a", "c", "d"]);
    expect(isReorderNoOp(["a", "b", "c"], "a", "b", "before")).toBe(true);
    expect(isReorderNoOp(["a", "b", "c"], "b", "a", "after")).toBe(true);
    expect(isReorderNoOp(["a", "b", "c"], "a", "b", "after")).toBe(false);

    expect(syncTabsToNoteOrder(["c", "a"], ["b", "a", "d", "c"])).toEqual(["a", "c"]);

    const notes = [
      makeNote({ id: "p1", pinned: true }),
      makeNote({ id: "n1", pinned: false }),
      makeNote({ id: "n2", pinned: false }),
    ];
    const byId = new Map(notes.map((n) => [n.id, n]));
    expect(canReorderNotes(byId, "n2", "n1")).toBe(true);
    expect(canReorderNotes(byId, "n1", "p1")).toBe(false);
    expect(reorderNotesByIds(notes, ["p1", "n2"]).map((n) => n.id)).toEqual(["p1", "n2", "n1"]);

    // Remote reorder updates local openTabs order while preserving which tabs are open locally.
    const reconciled = reconcileSnapshot(
      {
        openTabs: ["n1", "n2"],
        activeId: "n1",
        contents: {},
        markdownPreview: {},
        syntaxHighlight: {},
        sort: "manual",
      },
      {
        revision: 9,
        notes: [notes[0], notes[2], notes[1]],
        activeId: "p1",
        openTabs: ["p1", "n2", "n1"],
        sort: "manual",
      },
    );
    expect(reconciled.openTabs).toEqual(["n2", "n1"]);
    expect(reconciled.activeId).toBe("n1");
  });
});
