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

import { codeLanguage, languageFor, loadSyntax, monaco } from "./monaco";

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
  it.each([
    ["Program.cs", "csharp"],
    ["index.php", "php"],
    ["index.phtml", "php"],
    ["main.rb", "ruby"],
    ["Main.kt", "kotlin"],
    ["build.kts", "kotlin"],
    ["Main.swift", "swift"],
    ["main.dart", "dart"],
    ["main.lua", "lua"],
    ["analysis.r", "r"],
    ["main.jl", "julia"],
    ["Main.scala", "scala"],
    ["main.pl", "perl"],
    ["main.m", "objective-c"],
    ["main.fs", "fsharp"],
    ["Main.vb", "vb"],
    ["main.ex", "elixir"],
    ["main.clj", "clojure"],
    ["main.cc", "cpp"],
    ["main.cxx", "cpp"],
    ["main.hpp", "cpp"],
    ["main.hh", "cpp"],
    ["main.hxx", "cpp"],
    ["main.h", "cpp"],
    ["main.pp", "pascal"],
    ["main.mts", "typescript"],
    ["main.cts", "typescript"],
    ["main.pyw", "python"],
    ["main.pyi", "python"],
    ["main.bash", "shell"],
    ["main.zsh", "shell"],
    ["module.psm1", "powershell"],
    ["module.psd1", "powershell"],
    ["style.less", "less"],
    ["Dockerfile", "dockerfile"],
    ["build.dockerfile", "dockerfile"],
    ["Gemfile", "ruby"],
    ["Rakefile", "ruby"],
    [".editorconfig", "ini"],
    ["settings.toml", "ini"],
  ])("identifies %s across path formats and casing", (name, language) => {
    for (const path of [name, `/workspace/src/${name}`, `C:\\项目\\${name.toUpperCase()}`]) {
      expect(languageFor(path)).toBe(language);
    }
  });

  it("prefers exact filenames to the longest registered extension", () => {
    expect(languageFor("EXACT.LONG.SYNTAX-TEST")).toBe("test-short");
    expect(languageFor("file.long.syntax-test")).toBe("test-long");
    expect(languageFor("file.syntax-test")).toBe("test-short");
  });

  it("uses the cached associations without rescanning the registry", () => {
    const before = vi.mocked(monaco.languages.getLanguages).mock.calls.length;
    for (let i = 0; i < 100; i++) {
      expect(languageFor(`file${i}.cs`)).toBe("csharp");
    }
    expect(vi.mocked(monaco.languages.getLanguages).mock.calls).toHaveLength(before);
  });

  it.each([
    "",
    "README",
    "java",
    "ts",
    "file.unknown",
    "file.cs.bak",
    "/folder.php/README",
    "main.zig",
    "Main.hs",
    "main.ml",
    "main.mli",
    "main.f90",
    "App.svelte",
    "App.astro",
  ])("keeps unrecognized file %s in plain text", (path) => {
    expect(languageFor(path)).toBe("plaintext");
  });

  it.each([
    "csharp",
    "php",
    "ruby",
    "kotlin",
    "swift",
    "dart",
    "lua",
    "r",
    "julia",
    "scala",
    "perl",
    "objective-c",
    "fsharp",
    "vb",
    "elixir",
    "clojure",
    "cpp",
    "typescript",
    "python",
    "shell",
    "powershell",
    "less",
    "dockerfile",
  ])("loads the existing grammar for %s on demand", async (language) => {
    await loadSyntax(language);
    expect(await registry.providers.get(language)).toMatchObject({ tokenizer: expect.any(Object) });
  });
});

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

describe("Vue language mode", () => {
  it.each(["App.vue", "组件.VUE", "C:\\project\\App.vue"])("identifies %s as Vue", (path) => {
    expect(languageFor(path)).toBe("vue");
  });
  it("registers Vue syntax with embedded expressions, scripts and styles", async () => {
    await loadSyntax("vue");
    expect(codeLanguage("Vue")).toBe("vue");
    const syntax = (await registry.providers.get("vue")) as monaco.languages.IMonarchLanguage;
    expect(syntax.tokenPostfix).toBe(".vue");
    expect(syntax.tokenizer.interpolation).toBeDefined();
    expect(syntax.tokenizer.scriptAfterTypeEquals).toEqual(
      expect.arrayContaining([
        [
          expect.any(RegExp),
          expect.objectContaining({ switchTo: "@scriptWithCustomType.text/typescript" }),
        ],
      ]),
    );
    expect(syntax.tokenizer.styleAfterTypeEquals).toEqual(
      expect.arrayContaining([
        [
          expect.any(RegExp),
          expect.objectContaining({ switchTo: "@styleWithCustomType.text/scss" }),
        ],
      ]),
    );
  });
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
    await Promise.all([loadSyntax("go"), loadSyntax("go"), loadSyntax("go")]);
    expect(vi.mocked(monaco.editor.colorize).mock.calls.slice(before)).toEqual([["", "go", {}]]);
    expect(await registry.providers.get("go")).toMatchObject({ tokenizer: expect.any(Object) });
  });
});
