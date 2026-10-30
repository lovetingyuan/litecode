import { editorTheme } from "../styles/theme";
import * as monaco from "monaco-editor";
import EditorWorker from "@codingame/monaco-vscode-api/workers/editor.worker?worker";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import "./editor-features";
import { editorFontOptions } from "./font";
import { markdownSyntax } from "./markdownSyntax";
import { vueSyntax } from "./vueSyntax";
import { configLanguageConfiguration, dotenvSyntax, gitignoreSyntax } from "./configSyntax";
import { startupStep } from "../core/startup";

let startup: Promise<void> | undefined;
export function initializeEditor(): Promise<void> {
  return (startup ??= (async () => {
    const wrapper = new MonacoVscodeApiWrapper({
      $type: "classic",
      viewsConfig: { $type: "EditorService" },
      serviceOverrides: getLanguagesServiceOverride(),
      monacoWorkerFactory: () => {
        globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };
      },
      userConfiguration: {
        json: JSON.stringify({
          "editor.fontFamily": editorFontOptions({}).fontFamily,
          "editor.fontLigatures": editorFontOptions({}).fontLigatures,
          "editor.fontSize": 14,
          "editor.tabSize": 4,
        }),
      },
    });
    await startupStep("vscode-services-started", () => wrapper.start());
    await startupStep("syntaxes-registered", registerSyntaxes);
    monaco.editor.defineTheme("dark-modern", editorTheme());
    monaco.editor.setTheme("dark-modern");
    // Menus portaled into shadow roots under body must inherit the editor theme variables.
    document.body.classList.add("monaco-component");
  })());
}

const filenameLanguages = new Map<string, string>();
let extensionLanguages: [string, string][] = [];

export function languageFor(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === ".gitignore") {
    return "gitignore";
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return "dotenv";
  }
  if (
    /(?:^|[\\/])(settings|keybindings|tsconfig[^\\/]*)\.json$/i.test(path) ||
    /\.jsonc$/i.test(path)
  ) {
    return "jsonc";
  }
  const extension = name.includes(".") ? name.split(".").pop() : undefined;
  if (extension === "markdown") {
    return "markdown";
  }
  return (
    (
      {
        ts: "typescript",
        tsx: "typescriptreact",
        js: "javascript",
        jsx: "javascriptreact",
        mjs: "javascript",
        cjs: "javascript",
        json: "json",
        jsonc: "json",
        rs: "rust",
        html: "html",
        htm: "html",
        vue: "vue",
        css: "css",
        scss: "scss",
        md: "markdown",
        py: "python",
        yaml: "yaml",
        yml: "yaml",
        toml: "ini",
        sh: "shell",
        ps1: "powershell",
        sql: "sql",
        xml: "xml",
        svg: "xml",
        c: "c",
        cpp: "cpp",
        h: "cpp",
        go: "go",
        java: "java",
        txt: "plaintext",
        "code-search": "search-result",
      } as Record<string, string>
    )[extension ?? ""] ??
    filenameLanguages.get(name) ??
    extensionLanguages.find(([suffix]) => name.endsWith(suffix))?.[1] ??
    "plaintext"
  );
}

let registration: Promise<void> | undefined;
const registrations = import.meta.glob(
  "/node_modules/monaco-languages/esm/vs/languages/definitions/register.all.js",
);
const syntaxes = import.meta.glob<{
  language: monaco.languages.IMonarchLanguage;
  conf: monaco.languages.LanguageConfiguration;
}>("/node_modules/monaco-languages/esm/vs/languages/definitions/{markdown,typescript,html}/*.js");
const jsonSyntax = import.meta.glob<{
  createTokenizationSupport(comments: boolean): monaco.languages.TokensProvider;
}>("/node_modules/monaco-languages/esm/vs/languages/features/json/tokenization.js");
function registerSyntaxes() {
  return (registration ??= (async () => {
    // Register names and lazy tokenizers, including languages encountered inside Markdown.
    await registrations[
      "/node_modules/monaco-languages/esm/vs/languages/definitions/register.all.js"
    ]();
    for (const [id, aliases, filenames, filenamePatterns, syntax] of [
      ["gitignore", ["Git Ignore"], [".gitignore"], [], gitignoreSyntax],
      ["dotenv", ["Dotenv", "env"], [".env"], [".env.*"], dotenvSyntax],
    ] as const) {
      monaco.languages.register({
        id,
        aliases: [...aliases],
        filenames: [...filenames],
        filenamePatterns: [...filenamePatterns],
      });
      monaco.languages.registerTokensProviderFactory(id, {
        create: () => {
          monaco.languages.setLanguageConfiguration(id, configLanguageConfiguration);
          return syntax;
        },
      });
    }
    for (const [id, aliases] of [
      ["typescriptreact", ["TSX"]],
      ["javascriptreact", ["JSX"]],
      ["json", ["JSON"]],
      ["jsonc", ["JSONC"]],
      ["markdown", ["Markdown", "md"]],
      ["vue", ["Vue"]],
    ] as const) {
      monaco.languages.register({ id, aliases: [...aliases] });
      monaco.languages.registerTokensProviderFactory(id, {
        create: async () => {
          if (id === "json" || id === "jsonc") {
            const { createTokenizationSupport } =
              await jsonSyntax[
                "/node_modules/monaco-languages/esm/vs/languages/features/json/tokenization.js"
              ]();
            return createTokenizationSupport(id === "jsonc");
          }
          const syntax = id === "vue" ? "html" : id === "markdown" ? "markdown" : "typescript";
          const module =
            await syntaxes[
              `/node_modules/monaco-languages/esm/vs/languages/definitions/${syntax}/${syntax}.js`
            ]();
          monaco.languages.setLanguageConfiguration(id, module.conf);
          return id === "vue"
            ? vueSyntax(module.language)
            : id === "markdown"
              ? markdownSyntax(module.language)
              : module.language;
        },
      });
    }
    const extensions = new Map([
      [".pyi", "python"],
      [".zsh", "shell"],
      [".pp", "pascal"],
      // The bundled F# grammar claims OCaml suffixes without an OCaml grammar.
      [".ml", "plaintext"],
      [".mli", "plaintext"],
    ]);
    for (const language of monaco.languages.getLanguages()) {
      for (const filename of language.filenames ?? []) {
        const name = filename.toLowerCase();
        if (!filenameLanguages.has(name)) {
          filenameLanguages.set(name, language.id);
        }
      }
      for (const extension of language.extensions ?? []) {
        const suffix = extension.toLowerCase();
        if (!extensions.has(suffix)) {
          extensions.set(suffix, language.id);
        }
      }
    }
    extensionLanguages = [...extensions].sort(([a], [b]) => b.length - a.length);
  })());
}

const loading = new Map<string, Promise<void>>();
export async function loadSyntax(language: string) {
  await registerSyntaxes();
  if (
    language === "plaintext" ||
    !monaco.languages.getLanguages().some((item) => item.id === language)
  ) {
    return;
  }
  let pending = loading.get(language);
  if (!pending) {
    // Colorize waits for the registered tokenizer without creating a document model.
    pending = monaco.editor
      .colorize("", language, {})
      .then(() => {})
      .catch((error) => {
        loading.delete(language);
        throw error;
      });
    loading.set(language, pending);
  }
  await pending;
}

export function codeLanguage(name: string): string | undefined {
  const value = name.toLowerCase();
  return monaco.languages
    .getLanguages()
    .find(
      (item) =>
        item.id.toLowerCase() === value ||
        item.aliases?.some((alias) => alias.toLowerCase() === value),
    )?.id;
}
export { monaco };
