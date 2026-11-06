import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/find/browser/findController";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/codelens/browser/codelensController";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/multicursor/browser/multicursor";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/clipboard/browser/clipboard";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/comment/browser/comment";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/cursorUndo/browser/cursorUndo";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/folding/browser/folding";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/bracketMatching/browser/bracketMatching";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/hover/browser/hoverContribution";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/suggest/browser/suggestController";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/parameterHints/browser/parameterHints";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoSymbol/browser/goToCommands";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoSymbol/browser/peek/referencesController";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/rename/browser/rename";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/codeAction/browser/codeActionContributions";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/format/browser/formatActions";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoError/browser/gotoError";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/smartSelect/browser/smartSelect";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/inlayHints/browser/inlayHintsContribution";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/semanticTokens/browser/viewportSemanticTokens";
import "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/wordHighlighter/browser/wordHighlighter";
import { EditorExtensionsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorExtensions";
import { FormattingConflicts } from "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/format/browser/format";
import {
  MenuId,
  MenuRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";

export function configureFormatting() {
  // LiteCode chooses formatters automatically; VS Code's extension picker is unsupported.
  const formatterActions = new Set([
    "editor.action.formatDocument.multiple",
    "editor.action.formatSelection.multiple",
  ]);
  const actions = EditorExtensionsRegistry.getEditorActions();
  // The registry exposes an iterable, backed by its mutable action array.
  if (Array.isArray(actions)) {
    for (let i = actions.length - 1; i >= 0; i--) {
      if (formatterActions.has(actions[i].id)) {
        actions.splice(i, 1);
      }
    }
  }
  for (const menu of [MenuId.EditorContext, MenuId.CommandPalette]) {
    for (const item of MenuRegistry.getMenuItems(menu)) {
      if ("command" in item && formatterActions.has(item.command.id)) {
        item.when = ContextKeyExpr.false();
      }
    }
  }
  FormattingConflicts.setFormatterSelector(
    async (providers) =>
      providers.find((provider) => provider.displayName === "LiteCode") ?? providers[0],
  );
}
