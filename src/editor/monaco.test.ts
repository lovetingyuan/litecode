import { describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  languages: new Map<string, { id: string; aliases?: string[] }>(),
  factories: new Map<string, { create(): Promise<unknown> }>(),
  providers: new Map<string, Promise<unknown>>(),
}));
vi.mock("monaco-editor", () => ({
  languages: {
    register: vi.fn((language) => registry.languages.set(language.id, language)),
    getLanguages: () => [...registry.languages.values()],
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
vi.mock("./editor-features", () => ({}));

import { codeLanguage, languageFor, loadSyntax, monaco } from "./monaco";

describe("React language modes", () => {
  it.each([
    ["App.tsx", "typescriptreact"],
    ["App.JSX", "javascriptreact"],
    ["main.ts", "typescript"],
    ["main.js", "javascript"],
  ])("identifies %s as %s", (path, language) => {
    expect(languageFor(path)).toBe(language);
  });

  it.each(["typescriptreact", "javascriptreact"])(
    "loads syntax and editing rules for %s",
    async (language) => {
      await loadSyntax(language);
      expect(await registry.providers.get(language)).toMatchObject({
        tokenizer: expect.any(Object),
      });
      expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
        language,
        expect.objectContaining({ brackets: expect.any(Array) }),
      );
    },
  );
});

describe("Markdown language detection", () => {
  it.each(["README.md", "AGENTS.MD", "guide.markdown", "中文.MarkDown"])(
    "identifies %s as Markdown",
    (path) => {
      expect(languageFor(path)).toBe("markdown");
    },
  );
});

describe("Configuration file language detection", () => {
  it.each([".gitignore", "/workspace/.gitignore", "C:\\workspace\\.gitignore"])(
    "identifies %s as Git Ignore",
    (path) => expect(languageFor(path)).toBe("gitignore"),
  );

  it.each([
    ".env",
    ".env.local",
    ".env.development",
    ".env.production.local",
    ".env.example",
    "/workspace/.env.test",
    "C:\\workspace\\.env.local",
    ".env.ts",
    ".env.json",
  ])("identifies %s as Dotenv before checking extensions", (path) => {
    expect(languageFor(path)).toBe("dotenv");
  });

  it.each([
    [".gitignore.bak", "plaintext"],
    ["gitignore", "plaintext"],
    ["/workspace/.gitignore/main.ts", "typescript"],
    [".environment", "plaintext"],
    ["my.env", "plaintext"],
    [".envrc", "plaintext"],
    ["/workspace/.env.local/main.ts", "typescript"],
  ])("keeps %s in %s mode", (path, language) => {
    expect(languageFor(path)).toBe(language);
  });

  it.each(["gitignore", "dotenv"])("loads %s syntax and comment configuration", async (id) => {
    await loadSyntax(id);
    expect(await registry.providers.get(id)).toMatchObject({
      tokenizer: expect.any(Object),
    });
    expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ comments: { lineComment: "#" } }),
    );
    expect(codeLanguage(id)).toBe(id);
  });
});

describe("JSON language detection", () => {
  it.each([
    "tsconfig.json",
    "tsconfig.node.json",
    "tsconfig-build.json",
    "tsconfigCustom.json",
    "/workspace/config/tsconfig.base.json",
    "C:\\workspace\\config\\TSCONFIG.NODE.JSON",
  ])("identifies %s as JSONC", (path) => {
    expect(languageFor(path)).toBe("jsonc");
  });

  it.each([
    ["package.json", "json"],
    ["mytsconfig.json", "json"],
    ["tsconfig.json.bak", "plaintext"],
    ["tsconfig/config.json", "json"],
    ["C:\\workspace\\tsconfig\\config.json", "json"],
    ["jsconfig.json", "json"],
  ])("keeps %s in %s mode", (path, language) => {
    expect(languageFor(path)).toBe(language);
  });
});

describe("JSON syntax loading", () => {
  it("registers and reuses tokenizers for JSON and JSONC documents", async () => {
    for (const path of [
      "package.json",
      "settings.json",
      "keybindings.json",
      "config.jsonc",
      "tsconfig.json",
      "tsconfig.node.json",
    ]) {
      const language = languageFor(path);
      await loadSyntax(language);
      const provider = (await registry.providers.get(language)) as monaco.languages.TokensProvider;
      const result = provider.tokenize(
        '{"name":"LiteCode","count":42,"enabled":true,"empty":null}',
        provider.getInitialState(),
      );
      expect(result.tokens.map((token) => token.scopes)).toEqual(
        expect.arrayContaining([
          "string.key.json",
          "string.value.json",
          "number.json",
          "keyword.json",
        ]),
      );
      if (language === "jsonc") {
        const comment = provider.tokenize("/* first line", provider.getInitialState());
        const next = provider.tokenize(
          'second line */ "name": "value", // comment',
          comment.endState,
        );
        expect(next.tokens.map((token) => token.scopes)).toEqual(
          expect.arrayContaining([
            "comment.block.json",
            "string.key.json",
            "string.value.json",
            "comment.line.json",
          ]),
        );
      }
    }
    for (const id of ["json", "jsonc"]) {
      expect(
        vi.mocked(monaco.editor.colorize).mock.calls.filter(([, language]) => language === id),
      ).toHaveLength(1);
    }
  });
});

describe("Embedded syntax loading", () => {
  it("registers aliases before any file in that language is opened", async () => {
    await loadSyntax("markdown");
    for (const [alias, id] of [
      ["js", "javascript"],
      ["JAVASCRIPT", "javascript"],
      ["ts", "typescript"],
      ["TSX", "typescriptreact"],
      ["jsx", "javascriptreact"],
      ["JSONC", "jsonc"],
      ["py", "python"],
      ["Git Ignore", "gitignore"],
      ["env", "dotenv"],
    ]) {
      expect(codeLanguage(alias)).toBe(id);
    }
    expect(codeLanguage("unknown-language")).toBeUndefined();
    expect(codeLanguage("")).toBeUndefined();
  });

  it("shares pending syntax loads", async () => {
    const before = vi.mocked(monaco.editor.colorize).mock.calls.length;
    await Promise.all([loadSyntax("python"), loadSyntax("python"), loadSyntax("python")]);
    expect(vi.mocked(monaco.editor.colorize).mock.calls.slice(before)).toEqual([
      ["", "python", {}],
    ]);
    expect(await registry.providers.get("python")).toMatchObject({ tokenizer: expect.any(Object) });
  });
});
