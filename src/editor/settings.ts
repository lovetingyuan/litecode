import type { editor } from "monaco-editor";
import schema from "../config/settings-schema.json";
import { settingValue } from "../utils/settings";
import { editorFontOptions } from "./font";

export function editorOptions(
  settings: Record<string, unknown>,
  large = false,
): editor.IEditorConstructionOptions {
  const get = <T>(key: keyof typeof schema.properties) => settingValue(settings, key) as T;
  return {
    ...editorFontOptions(settings),
    fontSize: get("editor.fontSize"),
    lineHeight: get("editor.lineHeight"),
    fontWeight: String(get("editor.fontWeight")),
    letterSpacing: get("editor.letterSpacing"),
    lineNumbers: get("editor.lineNumbers"),
    renderWhitespace: get("editor.renderWhitespace"),
    rulers: get("editor.rulers"),
    renderLineHighlight: get("editor.renderLineHighlight"),
    guides: {
      indentation: get("editor.guides.indentation"),
      bracketPairs: get("editor.guides.bracketPairs"),
    },
    bracketPairColorization: { enabled: get("editor.bracketPairColorization.enabled") },
    minimap: { enabled: !large && get<boolean>("editor.minimap.enabled") },
    folding: !large && get<boolean>("editor.folding"),
    cursorStyle: get("editor.cursorStyle"),
    cursorBlinking: get("editor.cursorBlinking"),
    cursorSmoothCaretAnimation: get("editor.cursorSmoothCaretAnimation"),
    scrollBeyondLastLine: get("editor.scrollBeyondLastLine"),
    smoothScrolling: get("editor.smoothScrolling"),
    mouseWheelZoom: get("editor.mouseWheelZoom"),
    wordWrap: get("editor.wordWrap"),
    wordWrapColumn: get("editor.wordWrapColumn"),
    quickSuggestions: get("editor.quickSuggestions"),
    quickSuggestionsDelay: get("editor.quickSuggestionsDelay"),
    suggestOnTriggerCharacters: get("editor.suggestOnTriggerCharacters"),
    acceptSuggestionOnEnter: get("editor.acceptSuggestionOnEnter"),
    parameterHints: { enabled: get("editor.parameterHints.enabled") },
    hover: { enabled: get("editor.hover.enabled"), delay: get("editor.hover.delay") },
    inlayHints: { enabled: get("editor.inlayHints.enabled") },
    autoClosingBrackets: get("editor.autoClosingBrackets"),
    autoClosingQuotes: get("editor.autoClosingQuotes"),
    autoSurround: get("editor.autoSurround"),
  };
}

export const modelSettingKeys = [
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.detectIndentation",
  "editor.bracketPairColorization.enabled",
] as const;

export function applyModelSettings(model: editor.ITextModel, settings: Record<string, unknown>) {
  const tabSize = settingValue(settings, "editor.tabSize") as number;
  const insertSpaces = settingValue(settings, "editor.insertSpaces") as boolean;
  if (settingValue(settings, "editor.detectIndentation")) {
    model.detectIndentation(insertSpaces, tabSize);
  } else {
    model.updateOptions({ tabSize, insertSpaces, indentSize: "tabSize" });
  }
  model.updateOptions({
    bracketColorizationOptions: {
      enabled: settingValue(settings, "editor.bracketPairColorization.enabled") as boolean,
      independentColorPoolPerBracketType: false,
    },
  });
}

export function diffOptions(settings: Record<string, unknown>): editor.IDiffEditorOptions {
  return {
    renderSideBySide: settingValue(settings, "diffEditor.renderSideBySide") as boolean,
    ignoreTrimWhitespace: settingValue(settings, "diffEditor.ignoreTrimWhitespace") as boolean,
  };
}
