import { describe, expect, it } from "vitest";
import { rankPath } from "../utils/fuzzy";
import {
  prepareQuickFiles,
  searchQuickFiles,
  type FileSearchMessage,
  type FileSearchReply,
} from "./quickFiles";
import { QuickFileSearch } from "./quickFileSearch";

describe("Quick file index", () => {
  it.each([
    ["*.ts", ".ts"],
    ["Al*ph*a", "Alpha"],
    ["src/**/*.ts", "src//.ts"],
    ["src\\*Alpha*.TS", "src\\Alpha.TS"],
    ["**", ""],
    ["*不存在*", "不存在"],
  ])("normalizes wildcard query %s like VS Code Quick Open", (query, normalized) => {
    const workspace = prepareQuickFiles(
      ["src/Alpha.ts", "src/nested/Alpha.test.ts", "src/Beta.tsx", "README.md"],
      null,
    );
    const open = prepareQuickFiles(["outside/Alpha.ts", "src/Alpha.ts"], null);
    expect(searchQuickFiles(workspace, open, query)).toEqual(
      searchQuickFiles(workspace, open, normalized),
    );
  });

  it("keeps fuzzy matching, highlights and the result limit for wildcard queries", () => {
    const workspace = prepareQuickFiles(
      [
        "src/Alpha.ts",
        "src/Alpha.test.ts",
        ...Array.from({ length: 150 }, (_, i) => `src/File${i}.ts`),
      ],
      null,
    );
    expect(searchQuickFiles(workspace, [], "Al*ph*a*.ts")).toEqual([
      {
        path: "src/Alpha.ts",
        label: "Alpha.ts",
        description: "src",
        positions: [0, 1, 2, 3, 4, 5, 6, 7],
      },
      {
        path: "src/Alpha.test.ts",
        label: "Alpha.test.ts",
        description: "src",
        positions: [0, 1, 2, 3, 4, 5, 6, 8],
      },
    ]);
    expect(searchQuickFiles(workspace, [], "*.ts")).toHaveLength(100);
    expect(searchQuickFiles(workspace, [], "*")).toHaveLength(100);
  });

  it("matches the stable full-sort reference, including ties, opened files and highlight positions", () => {
    const paths = Array.from(
      { length: 1800 },
      (_, i) => `packages/module-${i % 37}/src/Component${i}.tsx`,
    );
    paths.push("src/App.tsx", "src/日本語.ts", "src/中文组件.tsx", "src/a-b.ts", "src/a_b.ts");
    const open = ["outside/ComponentExtra.tsx", paths[1300], paths[3], paths[3]];
    const workspace = prepareQuickFiles(paths, null);
    const opened = prepareQuickFiles(open, null);
    const candidates = [...new Set([...open, ...paths])];
    for (const query of [
      "",
      "c",
      "comp",
      "sc",
      "module-3/c",
      "中文",
      "tsx",
      "A_B",
      "src\\app",
      "no-match",
    ]) {
      const expected = candidates
        .map((path) => rankPath(path, query, open.includes(path)))
        .filter((r) => r !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, 100)
        .map((rank) => {
          const offset = rank.path.lastIndexOf("/") + 1;
          return {
            path: rank.path,
            label: rank.path.slice(offset),
            description: rank.path.slice(0, Math.max(0, offset - 1)),
            positions: rank.positions.filter((p) => p >= offset).map((p) => p - offset),
          };
        });
      expect(searchQuickFiles(workspace, opened, query)).toEqual(expected);
    }
  });
  it("uses workspace-relative Windows paths and keeps absolute paths for outside files", () => {
    const open = prepareQuickFiles(
      ["C:\\project\\src\\App.tsx", "D:\\other\\App.tsx", "\\\\?\\C:\\project\\src\\Entry.ts"],
      "c:/PROJECT",
    );
    expect(searchQuickFiles([], open, "app")).toEqual([
      {
        path: "C:\\project\\src\\App.tsx",
        label: "App.tsx",
        description: "src",
        positions: [0, 1, 2],
      },
      {
        path: "D:\\other\\App.tsx",
        label: "App.tsx",
        description: "D:/other",
        positions: [0, 1, 2],
      },
    ]);
    expect(searchQuickFiles([], open, "entry")[0].description).toBe("src");
    expect(
      searchQuickFiles([], prepareQuickFiles(["C:\\Entry.ts"], "C:\\"), "entry")[0].description,
    ).toBe("");
  });
});

function fixture() {
  const sent: FileSearchMessage[] = [];
  const worker = {
    postMessage: (message: FileSearchMessage) => {
      sent.push(message);
    },
    terminate() {},
    onmessage: null as ((event: MessageEvent<FileSearchReply>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
  };
  const received: string[] = [];
  const service = new QuickFileSearch(worker, () => received.push("error"));
  const search = (query: string) => service.search(query, () => received.push(query));
  const reply = (message: FileSearchMessage) => {
    if (message.kind !== "search") {
      throw new Error("Expected search");
    }
    worker.onmessage?.(
      new MessageEvent<FileSearchReply>("message", {
        data: { id: message.id, version: message.version, files: [] },
      }),
    );
  };
  return { sent, worker, received, service, search, reply };
}
describe("Quick file request scheduling", () => {
  it("runs one request at a time and only retains the newest pending query", () => {
    const f = fixture();
    f.search("a");
    f.search("ab");
    f.search("abc");
    expect(f.sent).toHaveLength(1);
    f.reply(f.sent[0]);
    expect(f.sent).toHaveLength(2);
    expect(f.received).toEqual([]);
    expect(f.sent[1]).toMatchObject({ query: "abc" });
    f.reply(f.sent[0]); // Duplicate/out-of-order response cannot release the running request.
    f.reply(f.sent[1]);
    expect(f.received).toEqual(["abc"]);
  });
  it("rejects replies from an old index, cancelled mode or closed popup", () => {
    const f = fixture();
    f.search("a");
    f.service.update({ kind: "workspace", root: "C:/next", paths: ["a.ts"] });
    f.search("a");
    f.reply(f.sent[0]);
    expect(f.received).toEqual([]);
    f.service.cancel();
    f.reply(f.sent[2]);
    expect(f.received).toEqual([]);
    f.search("reopened");
    f.reply(f.sent[3]);
    expect(f.received).toEqual(["reopened"]);
    f.service.dispose();
    expect(f.worker.onmessage).toBeNull();
  });
  it("finishes pending requests on worker failure instead of leaving the input busy", () => {
    const f = fixture();
    f.search("a");
    f.worker.onerror?.({} as ErrorEvent);
    expect(f.received).toEqual(["error", "a"]);
    f.search("b");
    expect(f.received).toEqual(["error", "a", "b"]);
  });
});
