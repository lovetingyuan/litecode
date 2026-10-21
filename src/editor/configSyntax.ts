import type { languages } from "monaco-editor";

export const gitignoreSyntax: languages.IMonarchLanguage = {
  defaultToken: "string",
  tokenPostfix: ".gitignore",
  tokenizer: {
    root: [
      [/^#.*$/, "comment"],
      [/^!/, "keyword"],
      [/\\./, "string.escape"],
      [/\*\*|[?*]/, "keyword"],
      [/\[(?:\\.|[^\]\\])+\]/, "regexp"],
      [/\//, "delimiter"],
      [/[^\\*?[/]+/, "string"],
    ],
  },
};

export const configLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
};

export const dotenvSyntax: languages.IMonarchLanguage = {
  defaultToken: "string",
  tokenPostfix: ".dotenv",
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [
        /^([ \t]*)(export[ \t]+|)([A-Za-z_][\w.-]*)([ \t]*)(=)/,
        ["", "keyword", "identifier", "", "delimiter"],
      ],
      [/"/, "string", "@doubleQuoted"],
      [/'/, "string", "@singleQuoted"],
      { include: "@interpolation" },
      [/[^#"'$ \t]+/, "string"],
      [/[ \t]+/, ""],
    ],
    doubleQuoted: [
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
      { include: "@interpolation" },
      [/[^"\\$]+/, "string"],
    ],
    singleQuoted: [
      [/'/, "string", "@pop"],
      [/[^']+/, "string"],
    ],
    interpolation: [[/\$(?:\{[^}\r\n]*\}|[A-Za-z_]\w*)/, "identifier"]],
  },
};
