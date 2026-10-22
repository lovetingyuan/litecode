import schema from "../config/settings-schema.json";
import type { CSSProperties } from "react";

export const defaultFontFamily = schema.properties["editor.fontFamily"].default;
export const defaultFontLigatures = schema.properties["editor.fontLigatures"].default;

export function renderedFontFamily(fontFamily: string) {
  // WebView2's zh-CN monospace fallback is NSimSun. Choose the sans-serif CJK
  // fallback explicitly, after user fonts, so Latin remains Consolas by default.
  const family =
    /[,"']/.test(fontFamily) || !/[+ ]/.test(fontFamily) ? fontFamily : `"${fontFamily}"`;
  const stack = fontFamily === defaultFontFamily ? family : `${family}, ${defaultFontFamily}`;
  // Split CSS font names without splitting commas inside quoted names.
  const names = stack.match(/(?:[^,"']|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) ?? [];
  return names
    .map((name) => name.trim())
    .flatMap((name) => name.toLowerCase() === "monospace" ? ['"Microsoft YaHei"', name] : [name])
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
  return {
    "--code-font-family": fontFamily,
    // VS Code also accepts the strings "true", "false" and "" as boolean aliases.
    "--code-font-features":
      fontLigatures === true || fontLigatures === "true"
        ? '"liga" on, "calt" on'
        : fontLigatures === false || fontLigatures === "false" || fontLigatures === ""
          ? '"liga" off, "calt" off'
          : fontLigatures,
  };
}
