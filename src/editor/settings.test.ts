import { describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { applyModelSettings, diffOptions, editorOptions } from "./settings";

describe("Editor settings", () => {
  it("keeps the existing visual and interaction defaults", () => {
    expect(editorOptions({})).toMatchObject({
      fontSize: 14, lineHeight: 20, smoothScrolling: true, scrollBeyondLastLine: true,
      renderLineHighlight: "line", cursorBlinking: "blink", cursorStyle: "line",
      guides: { indentation: true, bracketPairs: true },
      bracketPairColorization: { enabled: true }, minimap: { enabled: true }, folding: true,
      lineNumbers: "on", renderWhitespace: "selection", wordWrap: "off", wordWrapColumn: 80,
      quickSuggestions: { other: "offWhenInlineCompletions", comments: "off", strings: "off" },
    });
  });

  it("maps nested settings and resets deleted or invalid overrides", () => {
    const options = editorOptions({
      "editor.fontWeight": 550, "editor.wordWrap": "bounded", "editor.wordWrapColumn": 100,
      "editor.guides.bracketPairs": "active", "editor.hover.enabled": "off", "editor.hover.delay": 700,
      "editor.parameterHints.enabled": false, "editor.inlayHints.enabled": "offUnlessPressed",
      "editor.quickSuggestions": false, "editor.autoClosingQuotes": "never", "editor.folding": false,
    });
    expect(options).toMatchObject({
      fontWeight: "550", wordWrap: "bounded", wordWrapColumn: 100, guides: { bracketPairs: "active" },
      hover: { enabled: "off", delay: 700 }, parameterHints: { enabled: false },
      inlayHints: { enabled: "offUnlessPressed" }, quickSuggestions: false, autoClosingQuotes: "never", folding: false,
    });
    expect(editorOptions({ "editor.hover.delay": -1 })).toEqual(editorOptions({}));
    expect(editorOptions({})).not.toEqual(options);
  });

  it("enforces the existing large-file minimap and folding restrictions", () => {
    expect(editorOptions({ "editor.minimap.enabled": true, "editor.folding": true }, true))
      .toMatchObject({ minimap: { enabled: false }, folding: false });
    expect(editorOptions({ "editor.minimap.enabled": false, "editor.folding": false }))
      .toMatchObject({ minimap: { enabled: false }, folding: false });
  });

  it("uses built-in indentation detection or explicitly configured model options without editing text", () => {
    const model = { detectIndentation: vi.fn(), updateOptions: vi.fn() };
    applyModelSettings(model as unknown as editor.ITextModel, { "editor.tabSize": 2, "editor.insertSpaces": false });
    expect(model.detectIndentation).toHaveBeenCalledWith(false, 2);
    model.detectIndentation.mockClear();
    applyModelSettings(model as unknown as editor.ITextModel, {
      "editor.detectIndentation": false, "editor.tabSize": 8, "editor.insertSpaces": false,
    });
    expect(model.detectIndentation).not.toHaveBeenCalled();
    expect(model.updateOptions).toHaveBeenCalledWith({ tabSize: 8, insertSpaces: false, indentSize: "tabSize" });
  });

  it("only adds the two requested diff options and restores their defaults", () => {
    expect(diffOptions({})).toEqual({ renderSideBySide: true, ignoreTrimWhitespace: true });
    expect(diffOptions({ "diffEditor.renderSideBySide": false, "diffEditor.ignoreTrimWhitespace": false }))
      .toEqual({ renderSideBySide: false, ignoreTrimWhitespace: false });
  });
});
