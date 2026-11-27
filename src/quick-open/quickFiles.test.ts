import { describe, expect, it } from "vitest";
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
        labelMatches: [{ start: 0, end: 8 }],
        descriptionMatches: [],
      },
      {
        path: "src/Alpha.test.ts",
        label: "Alpha.test.ts",
        description: "src",
        labelMatches: [
          { start: 0, end: 7 },
          { start: 12, end: 13 },
        ],
        descriptionMatches: [],
      },
    ]);
    expect(searchQuickFiles(workspace, [], "*.ts")).toHaveLength(100);
    expect(searchQuickFiles(workspace, [], "*")).toHaveLength(100);
  });

  it("prioritizes filename matches over path-spanning matches and highlights label and description accurately", () => {
    const root = "D:\\repo";
    const workspace = prepareQuickFiles(
      [
        "D:\\repo/apps/tianxi/src/components/CustomConversation/mixins/agentCoreSession.js",
        "D:\\repo/apps/aipkb/src/pages/ainote/lexical-editor/nodes/InlineImageNode/InlineImageComponent.jsx",
        "D:\\repo/skills/tianxi-ppt/templates/icons/chunk-filled/align-center-vertical.svg",
        "D:\\repo/apps/tianxi/src/components/CustomConversation/mixins/skillAgent.js",
        "D:\\repo/apps/tianxi/src/components/CustomConversation/mixins/mainAgent.js",
        "D:\\repo/apps/tianxi/src/components/CustomConversation/mixins/MAIN_AGENT_DOCS.md",
      ],
      root,
    );
    const open = prepareQuickFiles(
      ["D:\\repo\\apps\\tianxi\\src\\components\\CustomConversation\\mixins\\agentCoreSession.js"],
      root,
    );

    const results = searchQuickFiles(workspace, open, "mainAgent");
    expect(results.map((file) => file.label)).toEqual([
      "mainAgent.js",
      "MAIN_AGENT_DOCS.md",
      "agentCoreSession.js",
      "skillAgent.js",
      "InlineImageComponent.jsx",
      "align-center-vertical.svg",
    ]);
    expect(results[0]).toMatchObject({
      label: "mainAgent.js",
      labelMatches: [{ start: 0, end: 9 }],
      descriptionMatches: [],
    });
    expect(results[1]).toMatchObject({
      label: "MAIN_AGENT_DOCS.md",
      labelMatches: [
        { start: 0, end: 4 },
        { start: 5, end: 10 },
      ],
      descriptionMatches: [],
    });
    expect(results[2].labelMatches).toEqual([{ start: 0, end: 5 }]);
    expect(results[2].descriptionMatches.length).toBeGreaterThan(0);

    const pathQuery = searchQuickFiles(workspace, open, "mixins/mainAgent");
    expect(pathQuery[0]).toMatchObject({
      label: "mainAgent.js",
      labelMatches: [{ start: 0, end: 9 }],
      descriptionMatches: [{ start: 46, end: 52 }],
    });

    const multiTerm = searchQuickFiles(workspace, open, "agent mixins");
    expect(multiTerm[0].label).toBe("agentCoreSession.js");
    expect(multiTerm[0].labelMatches).toEqual([{ start: 0, end: 5 }]);
    expect(multiTerm[0].descriptionMatches).toEqual([{ start: 46, end: 52 }]);
  });

  it("deduplicates Windows paths across separators and casing while preserving relative descriptions", () => {
    const workspace = prepareQuickFiles(
      [
        "C:\\project/src/App.tsx",
        "c:/PROJECT/src/Entry.ts",
        "C:\\project/src/Other.ts",
      ],
      "c:/PROJECT",
    );
    const open = prepareQuickFiles(
      [
        "C:\\project\\src\\App.tsx",
        "D:\\other\\App.tsx",
        "\\\\?\\C:\\project\\src\\Entry.ts",
      ],
      "c:/PROJECT",
    );
    expect(searchQuickFiles(workspace, open, "app")).toEqual([
      {
        path: "C:\\project\\src\\App.tsx",
        label: "App.tsx",
        description: "src",
        labelMatches: [{ start: 0, end: 3 }],
        descriptionMatches: [],
      },
      {
        path: "D:\\other\\App.tsx",
        label: "App.tsx",
        description: "D:/other",
        labelMatches: [{ start: 0, end: 3 }],
        descriptionMatches: [],
      },
    ]);
    expect(searchQuickFiles(workspace, open, "").map((file) => file.label)).toEqual([
      "App.tsx",
      "App.tsx",
      "Entry.ts",
      "Other.ts",
    ]);
    expect(searchQuickFiles(workspace, open, "entry")[0].description).toBe("src");
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
