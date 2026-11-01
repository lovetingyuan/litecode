import schema from "../config/settings-schema.json";
import type { CSSProperties } from "react";

export const defaultFontFamily = schema.properties["editor.fontFamily"].default;
const defaultFontLigatures = schema.properties["editor.fontLigatures"].default;

export function renderedFontFamily(fontFamily: string) {
  // WebView2's zh-CN monospace fallback is NSimSun. Choose the sans-serif CJK
  // fallback explicitly, after user fonts, so Latin remains Consolas by default.
  const family =
    /[,"']/.test(fontFamily) || !/[+ ]/.test(fontFamily) ? fontFamily : `"${fontFamily}"`;
  const stack = fontFamily === defaultFontFamily ? family : `${family}, ${defaultFontFamily}`;
  // Split CSS font names without splitting commas inside quoted names.
  // eslint-disable-next-line sonarjs/regex-complexity -- Keep CSS quoted-font and escape syntax in one tokenizer; the alternatives describe distinct quote forms.
  const names = stack.match(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) ?? [];
  return names
    .map((name) => name.trim())
    .flatMap((name) => (name.toLowerCase() === "monospace" ? ['"Microsoft YaHei"', name] : [name]))
    .join(", ");
}

export function editorFontOptions(settings: Record<string, unknown>) {
  const family = settings["editor.fontFamily"];
  const ligatures = settings["editor.fontLigatures"];
  return {
    fontFamily: renderedFontFamily(
      typeof family === "string" && family.trim() ? family : defaultFontFamily,
    ),
    fontLigatures:
      typeof ligatures === "boolean" || typeof ligatures === "string"
        ? ligatures
        : defaultFontLigatures,
  };
}

export function previewFontStyle(
  settings: Record<string, unknown>,
): CSSProperties & { "--code-font-family": string; "--code-font-features": string } {
  const { fontFamily, fontLigatures } = editorFontOptions(settings);
  // VS Code also accepts the strings "true", "false" and "" as boolean aliases.
  let features: string;
  if (fontLigatures === true || fontLigatures === "true") {
    features = '"liga" on, "calt" on';
  } else if (fontLigatures === false || fontLigatures === "false" || fontLigatures === "") {
    features = '"liga" off, "calt" off';
  } else {
    features = fontLigatures;
  }
  return {
    "--code-font-family": fontFamily,
    "--code-font-features": features,
  };
}
