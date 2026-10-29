import { beforeEach, describe, expect, it } from "vitest";
import { layoutGroups, resizeLayout } from "../editor/editorLayout";
import {
  activePane,
  addSplit,
  addTab,
  patchPane,
  removePane,
  reorderTab,
  useTerminal,
} from "./state";
import { plainTerminalText, reportedDirectory, terminalOptions, terminalSetting } from "./settings";

beforeEach(() =>
  useTerminal.setState({
    tabs: [],
    activeTab: null,
    panes: {},
    profiles: [],
    defaultProfile: null,
    initialized: false,
    find: false,
  }),
);
describe("terminal tabs and split layouts", () => {
  it("keeps tabs independent and collapses nested splits without losing sessions", () => {
    const first = addTab("PowerShell");
    patchPane(first, { cwd: "D:/project/中文 dir", status: "running" });
    const right = addSplit(first, "right")!;
    const down = addSplit(right, "down")!;
    const tab = useTerminal.getState().tabs[0];
    expect(layoutGroups(tab.layout)).toEqual([first, right, down]);
    expect(activePane()).toBe(down);
    const second = addTab("Command Prompt");
    expect(activePane()).toBe(second);
    removePane(right);
    expect(layoutGroups(useTerminal.getState().tabs[0].layout)).toEqual([first, down]);
    expect(useTerminal.getState().panes[first].cwd).toBe("D:/project/中文 dir");
    removePane(second);
    expect(activePane()).toBe(down);
    removePane(down);
    removePane(first);
    expect(useTerminal.getState()).toMatchObject({
      tabs: [],
      activeTab: null,
      panes: {},
      initialized: true,
    });
  });
  it("reorders tabs and resizes without changing their session identities", () => {
    const first = addTab(),
      right = addSplit(first, "right")!;
    addTab();
    const [a, b] = useTerminal.getState().tabs;
    reorderTab(b.id, a.id);
    expect(useTerminal.getState().tabs.map((t) => t.id)).toEqual([b.id, a.id]);
    const layout = a.layout;
    const resized = resizeLayout(layout, layout.id, [200, 400]);
    expect(layoutGroups(resized)).toEqual([first, right]);
  });
});
describe("terminal settings and shell-reported directories", () => {
  it("validates settings and inherits only the editor font family", () => {
    expect(
      terminalOptions({
        "editor.fontFamily": "Cascadia Mono",
        "terminal.integrated.fontSize": NaN,
      }),
    ).toMatchObject({
      fontFamily: "Cascadia Mono",
      fontSize: 14,
      scrollback: 1000,
    });
    expect(terminalSetting({ "terminal.integrated.scrollback": 1.5 }, "scrollback")).toBe(1000);
    expect(terminalSetting({ "terminal.integrated.lineHeight": 0 }, "lineHeight")).toBe(1);
    expect(terminalSetting({ "terminal.integrated.cursorStyle": "unknown" }, "cursorStyle")).toBe(
      "block",
    );
    expect(terminalOptions({ "terminal.integrated.fontWeight": "700" }).fontWeight).toBe(700);
    expect(terminalOptions({ "terminal.integrated.fontWeight": 400 }).fontWeight).toBe(400);
  });
  it("accepts explicit local cwd sequences including escaped characters", () => {
    expect(reportedDirectory(9, '9;"D:\\中文 space;dir"')).toBe("D:\\中文 space;dir");
    expect(reportedDirectory(633, "P;Cwd=D:\\\\test\\x3bdir")).toBe("D:\\test;dir");
    expect(reportedDirectory(7, "file:///D:/%E4%B8%AD%E6%96%87%20dir")).toBe("D:/中文 dir");
    expect(reportedDirectory(9, "9;relative")).toBeNull();
    expect(reportedDirectory(7, "https://example.com/path")).toBeNull();
    expect(reportedDirectory(7, "file:///D:/bad%00path")).toBeNull();
    expect(plainTerminalText("bad\x1b[31m\nmessage")).toBe("bad [31m message");
  });
});
