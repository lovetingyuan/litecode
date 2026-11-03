import { beforeAll, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  languages: new Map<
    string,
    {
      id: string;
      aliases?: string[];
      extensions?: string[];
      filenames?: string[];
    }
  >(),
  factories: new Map<string, { create(): Promise<unknown> }>(),
  providers: new Map<string, Promise<unknown>>(),
}));
vi.mock("monaco-editor", () => ({
  languages: {
    register: vi.fn((language) =>
      registry.languages.set(language.id, {
        ...registry.languages.get(language.id),
        ...language,
      }),
    ),
    getLanguages: vi.fn(() => [...registry.languages.values()]),
    registerTokensProviderFactory: vi.fn((id, factory) => registry.factories.set(id, factory)),
    onLanguageEncountered: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    IndentAction: { None: 0, IndentOutdent: 2 },
  },
  editor: {
    colorize: vi.fn(async (_text, id) => {
      if (!registry.providers.has(id)) {
        registry.providers.set(id, registry.factories.get(id)!.create());
      }
      await registry.providers.get(id);
      return "";
    }),
  },
}));
vi.mock("@codingame/monaco-vscode-api/workers/editor.worker?worker", () => ({ default: vi.fn() }));
vi.mock("monaco-languageclient/vscodeApiWrapper", () => ({ MonacoVscodeApiWrapper: vi.fn() }));
vi.mock("@codingame/monaco-vscode-languages-service-override", () => ({ default: () => ({}) }));
vi.mock("./editor-features", () => ({}));

import { languageFor, loadSyntax, monaco } from "./monaco";

beforeAll(async () => {
  monaco.languages.register({
    id: "test-short",
    extensions: [".syntax-test"],
    filenames: ["exact.long.syntax-test"],
  });
  monaco.languages.register({ id: "test-long", extensions: [".long.syntax-test"] });
  await loadSyntax("plaintext");
});

describe("Registered file associations", () => {
  it("prefers exact filenames to the longest registered extension", () => {
    expect(languageFor("EXACT.LONG.SYNTAX-TEST")).toBe("test-short");
    expect(languageFor("file.long.syntax-test")).toBe("test-long");
    expect(languageFor("file.syntax-test")).toBe("test-short");
  });

  it("uses the cached associations without rescanning the registry", () => {
    const before = vi.mocked(monaco.languages.getLanguages).mock.calls.length;
    for (let i = 0; i < 2; i++) {
      expect(languageFor(`file${i}.cs`)).toBe("csharp");
    }
    expect(vi.mocked(monaco.languages.getLanguages).mock.calls).toHaveLength(before);
  });
});

describe("Embedded syntax loading", () => {
  it("shares pending syntax loads", async () => {
    const before = vi.mocked(monaco.editor.colorize).mock.calls.length;
    await Promise.all([loadSyntax("go"), loadSyntax("go"), loadSyntax("go")]);
    expect(vi.mocked(monaco.editor.colorize).mock.calls.slice(before)).toEqual([["", "go", {}]]);
    expect(await registry.providers.get("go")).toMatchObject({ tokenizer: expect.any(Object) });
  });
});
