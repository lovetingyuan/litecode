import { describe, expect, it } from "vitest";
import { defaultFontFamily, editorFontOptions, previewFontStyle, renderedFontFamily } from "./font";
import { completeSettings, parseConfiguration } from "../utils/settings";

describe("Code fonts", () => {
  it("uses the screenshot defaults in editors, previews and annotated settings", () => {
    expect(editorFontOptions({})).toEqual({
      fontFamily: 'Consolas, "Courier New", "Microsoft YaHei", monospace',
      fontLigatures: false,
    });
    expect(previewFontStyle({})).toEqual({
      "--code-font-family": 'Consolas, "Courier New", "Microsoft YaHei", monospace',
      "--code-font-features": '"liga" off, "calt" off',
    });
    expect(parseConfiguration(completeSettings("{}"))).toMatchObject({
      "editor.fontFamily": defaultFontFamily,
      "editor.fontLigatures": false,
    });
  });

  it.each([
    [false, '"liga" off, "calt" off'],
    [true, '"liga" on, "calt" on'],
    ["false", '"liga" off, "calt" off'],
    ["true", '"liga" on, "calt" on'],
    ["", '"liga" off, "calt" off'],
    ["'liga' off, 'calt' on, 'zero' on", "'liga' off, 'calt' on, 'zero' on"],
  ])("matches Monaco's font feature semantics for %j", (value, css) => {
    const settings = { "editor.fontLigatures": value };
    expect(editorFontOptions(settings).fontLigatures).toBe(value);
    expect(previewFontStyle(settings)["--code-font-features"]).toBe(css);
  });

  it.each([
    ["Cascadia Code", '"Cascadia Code"'],
    ["等距 更纱黑体 SC", '"等距 更纱黑体 SC"'],
    ["Font+Name", '"Font+Name"'],
    ["Consolas", "Consolas"],
    ["'Missing Font', 'Courier New', monospace", "'Missing Font', 'Courier New', monospace"],
  ])("preserves %s and provides the default fallback in previews", (value, css) => {
    const settings = { "editor.fontFamily": value };
    expect(editorFontOptions(settings).fontFamily).toBe(renderedFontFamily(value));
    expect(previewFontStyle(settings)["--code-font-family"]).toBe(
      `${css}, ${defaultFontFamily}`.replace(/monospace/g, '"Microsoft YaHei", monospace'),
    );
    const completed = completeSettings(JSON.stringify(settings));
    expect(parseConfiguration(completed)).toMatchObject({ "editor.fontFamily": value });
  });

  it("keeps explicitly chosen Chinese fonts ahead of the WebView2 fallback", () => {
    expect(renderedFontFamily('Consolas, "SimSun", monospace')).toMatch(
      /^Consolas, "SimSun", "Microsoft YaHei", monospace/,
    );
    expect(renderedFontFamily('"Custom, monospace", monospace')).toMatch(
      /^"Custom, monospace", "Microsoft YaHei", monospace/,
    );
  });

  it.each([null, 42, {}, [], "", "   "])("falls back for an unusable font family: %j", (value) => {
    expect(editorFontOptions({ "editor.fontFamily": value }).fontFamily).toBe(
      editorFontOptions({}).fontFamily,
    );
  });

  it.each([null, 42, {}, []])("falls back for an invalid ligature type: %j", (value) => {
    expect(editorFontOptions({ "editor.fontLigatures": value }).fontLigatures).toBe(false);
  });
});
