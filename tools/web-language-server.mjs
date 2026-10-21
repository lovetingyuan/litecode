import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getLanguageService as htmlService } from "vscode-html-languageservice";
import {
  getCSSLanguageService,
  getSCSSLanguageService,
  getLESSLanguageService,
} from "vscode-css-languageservice";
import { getLanguageService as jsonService } from "vscode-json-languageservice";
import { readFile, stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const language = process.argv[process.argv.length - 1];
const html = htmlService();
const fsProvider = {
  async stat(uri) {
    const s = await stat(fileURLToPath(uri));
    return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
  },
  async readDirectory(uri) {
    return (await readdir(fileURLToPath(uri), { withFileTypes: true })).map((e) => [
      e.name,
      e.isDirectory() ? 2 : 1,
    ]);
  },
};
const css = (
  language === "scss"
    ? getSCSSLanguageService
    : language === "less"
      ? getLESSLanguageService
      : getCSSLanguageService
)({ fileSystemProvider: fsProvider });
const json = jsonService({
  schemaRequestService: async (uri) =>
    uri.startsWith("file:") ? readFile(fileURLToPath(uri), "utf8") : (await fetch(uri)).text(),
  workspaceContext: {
    resolveRelativePath: (relative, resource) => new URL(relative, resource).toString(),
  },
});
const kind =
  language === "html" ? "html" : language === "json" || language === "jsonc" ? "json" : "css";
const service = kind === "html" ? html : kind === "json" ? json : css;
let configuration = {};
const workspace = { resolveReference: (ref, base) => new URL(ref, base).toString() };
function get(params) {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) {
    return null;
  }
  return {
    doc,
    parsed:
      kind === "html"
        ? html.parseHTMLDocument(doc)
        : kind === "json"
          ? json.parseJSONDocument(doc)
          : css.parseStylesheet(doc),
  };
}
connection.onInitialize((params) => {
  if (kind === "json") {
    json.configure({
      validate: true,
      allowComments: language === "jsonc",
      schemas: params.initializationOptions?.schemas ?? [],
    });
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters:
          kind === "html" ? ["<", "/", " ", "=", '"', "."] : ['"', ":", ".", "/", "-", "@"],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentHighlightProvider: kind !== "json",
      renameProvider: kind !== "json",
      definitionProvider: kind === "css",
      referencesProvider: kind === "css",
      documentLinkProvider: { resolveProvider: false },
      colorProvider: kind !== "html",
      codeActionProvider: kind === "css",
    },
  };
});
connection.onDidChangeConfiguration((params) => {
  configuration = params.settings ?? {};
  if (kind === "css") {
    css.configure(configuration.css ?? {});
  }
  for (const doc of documents.all()) {
    validate(doc);
  }
});
connection.onCompletion(async (params) => {
  const x = get(params);
  if (!x) {
    return null;
  }
  return kind === "html"
    ? html.doComplete(x.doc, params.position, x.parsed, configuration.html)
    : kind === "json"
      ? json.doComplete(x.doc, params.position, x.parsed)
      : css.doComplete2(x.doc, params.position, x.parsed, workspace);
});
connection.onHover((params) => {
  const x = get(params);
  return x ? service.doHover(x.doc, params.position, x.parsed) : null;
});
connection.onDocumentSymbol((params) => {
  const x = get(params);
  return x ? service.findDocumentSymbols(x.doc, x.parsed) : [];
});
connection.onFoldingRanges((params) => {
  const x = get(params);
  return x ? service.getFoldingRanges(x.doc) : [];
});
connection.onSelectionRanges((params) => {
  const x = get(params);
  return x
    ? kind === "json"
      ? json.getSelectionRanges(x.doc, params.positions, x.parsed)
      : service.getSelectionRanges(x.doc, params.positions, x.parsed)
    : [];
});
connection.onDocumentHighlight((params) => {
  const x = get(params);
  return x && kind !== "json"
    ? service.findDocumentHighlights(x.doc, params.position, x.parsed)
    : [];
});
connection.onRenameRequest((params) => {
  const x = get(params);
  return x && kind !== "json"
    ? service.doRename(x.doc, params.position, params.newName, x.parsed)
    : null;
});
connection.onDefinition((params) => {
  const x = get(params);
  return x && kind === "css" ? css.findDefinition(x.doc, params.position, x.parsed) : null;
});
connection.onReferences((params) => {
  const x = get(params);
  return x && kind === "css" ? css.findReferences(x.doc, params.position, x.parsed) : [];
});
connection.onDocumentLinks((params) => {
  const x = get(params);
  return x
    ? kind === "html"
      ? html.findDocumentLinks(x.doc, workspace)
      : kind === "css"
        ? css.findDocumentLinks2(x.doc, x.parsed, workspace)
        : json.findLinks(x.doc, x.parsed)
    : [];
});
connection.onDocumentColor((params) => {
  const x = get(params);
  return x && kind !== "html" ? service.findDocumentColors(x.doc, x.parsed) : [];
});
connection.onColorPresentation((params) => {
  const x = get(params);
  return x && kind !== "html"
    ? service.getColorPresentations(x.doc, x.parsed, params.color, params.range)
    : [];
});
connection.onCodeAction((params) => {
  const x = get(params);
  return x
    ? kind === "css"
      ? css.doCodeActions2(x.doc, params.range, params.context, x.parsed)
      : []
    : [];
});
connection.onDocumentFormatting((params) => {
  const x = get(params);
  return x ? service.format(x.doc, undefined, params.options) : [];
});
connection.onDocumentRangeFormatting((params) => {
  const x = get(params);
  return x ? service.format(x.doc, params.range, params.options) : [];
});
const timers = new Map();
async function validate(doc) {
  try {
    const diagnostics =
      kind === "json"
        ? await json.doValidation(
            doc,
            json.parseJSONDocument(doc),
            language === "jsonc" ? { comments: "ignore", trailingCommas: "ignore" } : undefined,
          )
        : kind === "css"
          ? css.doValidation(doc, css.parseStylesheet(doc))
          : [];
    if (documents.get(doc.uri)?.version === doc.version) {
      connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics });
    }
  } catch (e) {
    connection.console.error(String(e));
  }
}
documents.onDidChangeContent(({ document }) => {
  clearTimeout(timers.get(document.uri));
  timers.set(
    document.uri,
    setTimeout(() => validate(document), 200),
  );
});
documents.onDidClose(({ document }) => {
  clearTimeout(timers.get(document.uri));
  timers.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});
documents.listen(connection);
connection.listen();
