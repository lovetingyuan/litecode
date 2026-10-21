import type { languages } from "monaco-editor";

export function markdownSyntax(language: languages.IMonarchLanguage): languages.IMonarchLanguage {
  const root = language.tokenizer.root.filter((rule) => {
    if (!Array.isArray(rule)) {
      return true;
    }
    const action = rule[1];
    return (
      typeof action !== "object" ||
      Array.isArray(action) ||
      !["@codeblock", "@codeblockgh"].includes(action.next ?? "")
    );
  });
  function fence(state: string): languages.IMonarchLanguageAction {
    return {
      cases: {
        "$2==": { token: "string", next: `@${state}.$1`, nextEmbedded: "plaintext" },
        "@default": { token: "string", next: `@${state}.$1`, nextEmbedded: "$2" },
      },
    };
  }
  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      root: [
        [/^ {0,3}(`{3,})[ \t]*([^\s`]*)(?:[ \t]+[^`]*)?$/, fence("fencedBacktick")],
        [/^ {0,3}(~{3,})[ \t]*(\S*)(?:[ \t]+.*)?$/, fence("fencedTilde")],
        ...root,
      ],
      // Keep the opening delimiter in state so a shorter or different fence cannot close it.
      fencedBacktick: [
        ["^ {0,3}$S2`*[ \\t]*$", { token: "string", next: "@pop", nextEmbedded: "@pop" }],
        [/.*$/, "variable.source"],
      ],
      fencedTilde: [
        ["^ {0,3}$S2~*[ \\t]*$", { token: "string", next: "@pop", nextEmbedded: "@pop" }],
        [/.*$/, "variable.source"],
      ],
    },
  };
}
