import { describe, it, expect } from "vitest";
import { matchesWhen, resolveBinding } from "./keybindings";

describe("User keyboard configuration", () => {
  it("honors contexts, precedence, removal and multi-step chords", () => {
    expect(
      matchesWhen("editorTextFocus && (resourceLangId == typescript || !inputFocus)", {
        editorTextFocus: true,
        resourceLangId: "json",
        inputFocus: false,
      }),
    ).toBe(true);
    expect(matchesWhen("editorTextFocus && unknown", { editorTextFocus: true })).toBe(false);
    expect(matchesWhen("process.exit()", {})).toBe(false);
    const bindings = [
      { key: "ctrl+k ctrl+t", command: "tools" },
      { key: "ctrl+s", command: "-save" },
      { key: "ctrl+s", command: "saveAs", when: "!inputFocus" },
    ];
    expect(resolveBinding(bindings, "Ctrl+K", {}).prefix).toBe(true);
    expect(resolveBinding(bindings, "ctrl+s", { inputFocus: false }).command).toBe("saveAs");
    expect(resolveBinding(bindings, "ctrl+s", { inputFocus: true }).removed.has("save")).toBe(true);
  });
});
