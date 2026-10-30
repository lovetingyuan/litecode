import type { editor } from "monaco-editor";
import type { ITheme } from "@xterm/xterm";

// Canvas renderers require resolved colors, whereas DOM and shadow trees can use CSS variables.
// Take one snapshot after workbench styles load; never read computed styles during rendering.
let resolved: Readonly<Record<string, string>> | undefined;
function colors() {
  if (!resolved) {
    const style = getComputedStyle(document.documentElement);
    const values: Record<string, string> = {};
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i);
      if (property.startsWith("--lc-")) {
        // CSS minification may shorten hex values; Monaco requires six/eight digits.
        values[property.slice(5)] = style
          .getPropertyValue(property)
          .trim()
          .replace(
            /^#([\da-f]{3,4})$/i,
            (_match, digits: string) => `#${[...digits].map((digit) => digit + digit).join("")}`,
          );
      }
    }
    resolved = values;
  }
  return resolved;
}

function color(name: string): string {
  const value = colors()[name];
  if (!value) {
    throw new Error(`Missing theme color: --lc-${name}`);
  }
  return value;
}

export function editorTheme(): editor.IStandaloneThemeData {
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: color("syntax-comment").slice(1) },
      { token: "keyword", foreground: color("syntax-keyword").slice(1) },
      { token: "string", foreground: color("syntax-string").slice(1) },
      { token: "number", foreground: color("syntax-number").slice(1) },
      { token: "type.identifier", foreground: color("syntax-type").slice(1) },
      { token: "identifier", foreground: color("syntax-identifier").slice(1) },
    ],
    colors: {
      "editor.background": color("editor"),
      "editor.foreground": color("foreground"),
      "editorLineNumber.foreground": color("line-number"),
      "editorLineNumber.activeForeground": color("foreground"),
      "editor.selectionBackground": color("editor-selection"),
      "editor.lineHighlightBackground": color("line-highlight"),
      "editor.lineHighlightBorder": color("line-highlight-border"),
      "editorWidget.background": color("widget"),
      "editorWidget.border": color("border-strong"),
      focusBorder: color("focus"),
      "editorIndentGuide.background1": color("indent-guide"),
      "editorIndentGuide.activeBackground1": color("indent-guide-active"),
      "editorSuggestWidget.background": color("widget"),
      "editorSuggestWidget.selectedBackground": color("selection"),
      "merge.currentHeaderBackground": color("merge-current-header"),
      "merge.currentContentBackground": color("merge-current-content"),
      "merge.incomingHeaderBackground": color("merge-incoming-header"),
      "merge.incomingContentBackground": color("merge-incoming-content"),
      "merge.commonHeaderBackground": color("merge-common-header"),
      "merge.commonContentBackground": color("merge-common-content"),
    },
  };
}

export function terminalTheme(): ITheme {
  return {
    background: color("editor"),
    foreground: color("foreground"),
    cursor: color("terminal-cursor"),
    selectionBackground: color("editor-selection"),
    black: color("ansi-black"),
    red: color("ansi-red"),
    green: color("ansi-green"),
    yellow: color("ansi-yellow"),
    blue: color("ansi-blue"),
    magenta: color("ansi-magenta"),
    cyan: color("ansi-cyan"),
    white: color("ansi-white"),
    brightBlack: color("ansi-bright-black"),
    brightRed: color("ansi-bright-red"),
    brightGreen: color("ansi-bright-green"),
    brightYellow: color("ansi-bright-yellow"),
    brightBlue: color("ansi-bright-blue"),
    brightMagenta: color("ansi-bright-magenta"),
    brightCyan: color("ansi-bright-cyan"),
    brightWhite: color("ansi-bright-white"),
  };
}

// themeToTreeStyles forwards these values as custom properties onto the shadow host.
export const treeTheme = {
  type: "dark" as const,
  colors: {
    "sideBar.background": "var(--lc-sidebar)",
    "sideBar.foreground": "var(--lc-foreground)",
    "sideBar.border": "var(--lc-border-panel)",
    "input.background": "var(--lc-input)",
    "input.border": "var(--lc-border-input)",
    "scrollbarSlider.background": "var(--lc-scrollbar-thumb)",
    "list.activeSelectionBackground": "var(--lc-selection)",
    "list.activeSelectionForeground": "var(--lc-foreground-strong)",
    "list.inactiveSelectionBackground": "var(--lc-selection-inactive)",
    "list.hoverBackground": "var(--lc-hover)",
    focusBorder: "var(--lc-focus)",
    "gitDecoration.modifiedResourceForeground": "var(--lc-git-modified)",
    "gitDecoration.untrackedResourceForeground": "var(--lc-git-added)",
    "gitDecoration.addedResourceForeground": "var(--lc-git-added)",
    "gitDecoration.deletedResourceForeground": "var(--lc-git-deleted)",
    "gitDecoration.renamedResourceForeground": "var(--lc-git-added)",
    "gitDecoration.ignoredResourceForeground": "var(--lc-git-ignored)",
    "gitDecoration.conflictingResourceForeground": "var(--lc-git-conflict)",
  },
};
