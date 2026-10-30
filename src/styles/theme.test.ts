/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("canvas theme adapters", () => {
  it("resolves CSS colors once for Monaco and terminal creation and updates", async () => {
    vi.resetModules();
    const themeCSS = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
    const entries = [...themeCSS.matchAll(/(--lc-[\w-]+):\s*(#[\da-f]+);/gi)];
    const properties = new Map(entries.map((entry) => [entry[1], entry[2]]));
    const names = [...properties.keys()];
    const computed = vi.fn(() => ({
      length: names.length,
      item: (index: number) => names[index],
      getPropertyValue: (name: string) =>
        (properties.get(name) ?? "").replace(/^#([\da-f])\1([\da-f])\2([\da-f])\3$/i, "#$1$2$3"),
    }));
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", computed);
    const { editorTheme, terminalTheme } = await import("./theme");
    const editor = editorTheme();
    const terminal = terminalTheme();
    expect(editor.colors["editor.background"]).toBe(properties.get("--lc-editor"));
    expect(terminal.background).toBe(editor.colors["editor.background"]);
    expect(terminal.selectionBackground).toBe(editor.colors["editor.selectionBackground"]);
    expect(editor.rules.every((rule) => /^[\da-f]{6}$/i.test(rule.foreground ?? ""))).toBe(true);
    expect(Object.values(terminal).every((value) => /^#[\da-f]{6,8}$/i.test(value))).toBe(true);
    terminalTheme();
    editorTheme();
    expect(computed).toHaveBeenCalledTimes(1);
  });

  it("reports missing tokens before passing invalid colors to canvas renderers", async () => {
    vi.resetModules();
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ length: 0 }));
    const { terminalTheme } = await import("./theme");
    expect(() => terminalTheme()).toThrow("Missing theme color: --lc-editor");
  });
});
