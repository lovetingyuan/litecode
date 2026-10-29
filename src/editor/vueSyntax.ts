import type { languages } from "monaco-editor";

export function vueSyntax(html: languages.IMonarchLanguage): languages.IMonarchLanguage {
  const embedded = (state: string, language: string): languages.IMonarchLanguageAction => ({
    token: "attribute.value",
    switchTo: `@${state}WithCustomType.${language}`,
  });
  return {
    ...html,
    tokenPostfix: ".vue",
    tokenizer: {
      ...html.tokenizer,
      root: [
        [/\{\{/, { token: "delimiter", next: "@interpolation", nextEmbedded: "typescript" }],
        // Split text at braces so an interpolation following plain text is reached.
        ...html.tokenizer.root.slice(0, -1),
        [/[^<{]+/, ""],
        [/\{/, ""],
      ],
      interpolation: [[/\}\}/, { token: "delimiter", next: "@pop", nextEmbedded: "@pop" }]],
      otherTag: [
        [/(?:v-[\w:.-]+|[:@#][\w:.-]+)/, "attribute.name", "@directive"],
        ...html.tokenizer.otherTag,
      ],
      directive: [
        [/\s+/, ""],
        [/=/, "delimiter"],
        [
          /"/,
          { token: "attribute.value", switchTo: "@directiveDouble", nextEmbedded: "typescript" },
        ],
        [
          /'/,
          { token: "attribute.value", switchTo: "@directiveSingle", nextEmbedded: "typescript" },
        ],
        [/./, { token: "@rematch", next: "@pop" }],
      ],
      directiveDouble: [[/"/, { token: "attribute.value", next: "@pop", nextEmbedded: "@pop" }]],
      directiveSingle: [[/'/, { token: "attribute.value", next: "@pop", nextEmbedded: "@pop" }]],
      script: [[/lang\b/, "attribute.name", "@scriptAfterType"], ...html.tokenizer.script],
      scriptAfterTypeEquals: [
        [/["'](?:ts|typescript)["']/, embedded("script", "text/typescript")],
        [/["']tsx["']/, embedded("script", "typescriptreact")],
        [/["']jsx["']/, embedded("script", "javascriptreact")],
        [/["'](?:js|javascript)["']/, embedded("script", "text/javascript")],
        ...html.tokenizer.scriptAfterTypeEquals,
      ],
      style: [[/lang\b/, "attribute.name", "@styleAfterType"], ...html.tokenizer.style],
      styleAfterTypeEquals: [
        [/["']scss["']/, embedded("style", "text/scss")],
        [/["']less["']/, embedded("style", "text/less")],
        [/["']css["']/, embedded("style", "text/css")],
        ...html.tokenizer.styleAfterTypeEquals,
      ],
    },
  };
}
