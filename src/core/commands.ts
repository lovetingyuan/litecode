import { call, desktop, errorMessage } from "./bridge";
import { activeDoc, useApp, setApp, notify, primarySearchId } from "../store/store";
import {
  checkpoint,
  closeDocument,
  closeTabs,
  confirmDocumentClose,
  editor,
  models,
  editors,
  navigate,
  newDocument,
  openPath,
  save,
  saveAll,
  showDocument,
  splitGroup,
  scheduleBackup,
  join,
  normalize,
  relative,
  pathTitle,
  setSticky,
  resetEditors,
} from "../editor/documents";
import type { SplitDirection } from "../editor/editorLayout";
import { refreshTree, revealInTree } from "../components/Explorer";
import {
  createSearchTab,
  activateSearchTab,
  focusSearch,
  undoReplacement,
  nextSearchResult,
  retryReplacement,
  recoverInterruptedReplacements,
} from "../search/search";
import { changeLanguage } from "../editor/editorStatus";
import { acceptInlineConflict, navigateInlineConflict } from "../editor/mergeConflictEditor";
import { restartLanguages, stopLanguages, languageReport } from "../editor/languages";
import {
  manageWorkspaceTrust,
  prepareWorkspaceOpen,
  rememberWorkspaceTrust,
} from "./workspaceTrust";
import { checkForUpdates } from "./updates";
import { matchesWhen, normalizeKey, resolveBinding } from "../utils/keybindings";
import { completeSettings, parseConfiguration, updateSetting } from "../utils/settings";
import { terminalSelections, useTerminal } from "../terminal/state";

export type EditorContext = { groupId: string; documentId: string };
export type Command = {
  id: string;
  label: string;
  key?: string;
  aliases?: string[];
  menu?: string;
  when?: string;
  run: (context?: EditorContext) => unknown;
};
export const splitDirections = [
  { direction: "up", label: "Split Up", id: "workbench.action.splitEditorUp" },
  { direction: "down", label: "Split Down", id: "workbench.action.splitEditorDown" },
  { direction: "left", label: "Split Left", id: "workbench.action.splitEditorLeft" },
  { direction: "right", label: "Split Right", id: "workbench.action.splitEditorRight" },
] as const;
function splitEditor(context?: EditorContext, direction?: SplitDirection) {
  const target = editorTarget(context);
  if (target) {
    return splitGroup(target.group.id, target.doc.id, direction);
  }
  if (!context) {
    return splitGroup(undefined, undefined, direction);
  }
}
export function editorTarget(context?: EditorContext) {
  const s = useApp.getState();
  const group = s.groups.find((g) => g.id === (context?.groupId ?? s.activeGroup));
  const id = context?.documentId ?? group?.active;
  return group && id && group.tabs.includes(id) && s.docs[id]
    ? { group, doc: s.docs[id] }
    : undefined;
}
export function canRevealInExplorer(path: string | null) {
  const root = useApp.getState().root;
  return !!path && !!root && normalize(path).startsWith(normalize(root).replace(/\/$/, "") + "/");
}
async function copyEditorPath(context: EditorContext | undefined, useRelative: boolean) {
  const path = editorTarget(context)?.doc.path;
  if (!path) {
    return;
  }
  const text =
    useRelative && canRevealInExplorer(path)
      ? relative(path).replace(/\//g, "\\")
      : pathTitle(path);
  if (desktop) {
    await (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}
function closeEditorTabs(
  context: EditorContext | undefined,
  mode: Parameters<typeof closeTabs>[2],
) {
  const target = editorTarget(context);
  if (target) {
    return closeTabs(target.doc.id, target.group.id, mode);
  }
}
function pinEditor(context: EditorContext | undefined, sticky: boolean) {
  const target = editorTarget(context);
  if (target) {
    setSticky(target.doc.id, target.group.id, sticky);
  }
}
export function quick(value: string) {
  setApp({ quick: value });
}
let openingFolder = false;
export async function openFolder(newWindow = false, recentPath?: string) {
  if (openingFolder) {
    return;
  }
  openingFolder = true;
  try {
    setApp({ openingWorkspace: recentPath ?? "", quick: null });
    if (!recentPath) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }
    const selected = recentPath ?? (await call<string | null>("pick_path", { kind: "folder" }));
    if (!selected) {
      return;
    }
    setApp({ openingWorkspace: selected, quick: null });
    const info = await prepareWorkspaceOpen(selected);
    if (!info) {
      return;
    }
    const path = info.path;
    setApp({ openingWorkspace: path });
    const root = useApp.getState().root;
    const switching =
      !newWindow &&
      (!root || normalize(root).replace(/\/$/, "") !== normalize(path).replace(/\/$/, ""));
    if (switching) {
      for (const id of Object.keys(useApp.getState().docs)) {
        if (useApp.getState().docs[id]?.gitDiff) {
          continue;
        }
        if (!(await confirmDocumentClose(id))) {
          return;
        }
      }
    }
    await checkpoint();
    const same = await call<boolean>("open_workspace", {
      path,
      newWindow,
      ...(info.trust ? { trust: info.trust } : {}),
    });
    if (same) {
      if (switching) {
        await stopLanguages();
      }
      const config = await call<{
        settings: Record<string, unknown>;
        keybindings: import("../types/types").Keybinding[] | null;
      }>("configuration");
      if (switching) {
        await resetEditors();
      }
      if (!info.alreadyOpen) {
        rememberWorkspaceTrust(path, info.trust?.trusted === false);
      }
      setApp({
        ...(switching ? { view: "editor" as const } : {}),
        root: path,
        settings: config.settings,
        keybindings: config.keybindings ?? [],
      });
      if (switching) {
        await checkpoint();
      }
      await refreshTree();
    }
  } finally {
    setApp({ openingWorkspace: null });
    openingFolder = false;
  }
}
export async function openFile() {
  const path = await call<string | null>("pick_path", { kind: "file" });
  if (path) {
    await openPath(path, { pinned: true });
  }
}
function action(id: string) {
  return () => editor()?.getAction(id)?.run();
}
function trigger(id: string) {
  return () => editor()?.trigger("keyboard", id, null);
}
async function openSettings() {
  const id = await openPath(await call<string>("settings_path", { kind: "settings" }), {
    pinned: true,
  });
  if (!id) {
    return;
  }
  const m = models.get(id)!;
  const text = completeSettings(m.getValue());
  if (text !== m.getValue()) {
    m.pushStackElement();
    m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
    m.pushStackElement();
  }
  return id;
}
export const commands: Command[] = [
  {
    id: "workbench.view.scm",
    label: "Show Source Control",
    key: "Ctrl+Shift+G",
    menu: "View",
    run: () => setApp({ sidebar: "git", view: "editor" }),
  },
  ...(["current", "incoming", "both"] as const).map((choice) => ({
    id: `merge-conflict.accept.${choice}`,
    label: `Merge Conflict: Accept ${choice === "current" ? "Current" : choice === "incoming" ? "Incoming" : "Both"} Change${choice === "both" ? "s" : ""}`,
    run: (context?: EditorContext) => {
      const target = editorTarget(context);
      const instance = target ? editors.get(target.group.id) : undefined;
      if (target && instance && instance.getModel() === models.get(target.doc.id)) {
        acceptInlineConflict(instance, choice);
      }
    },
  })),
  ...(["next", "previous"] as const).map((direction) => ({
    id: `merge-conflict.${direction}`,
    label: `Merge Conflict: ${direction === "next" ? "Next" : "Previous"} Conflict`,
    run: (context?: EditorContext) => {
      const target = editorTarget(context);
      const instance = target ? editors.get(target.group.id) : undefined;
      if (target && instance && instance.getModel() === models.get(target.doc.id)) {
        navigateInlineConflict(instance, direction);
      }
    },
  })),
  {
    id: "workbench.action.terminal.toggleTerminal",
    label: "Terminal: Toggle Terminal",
    key: "Ctrl+`",
    menu: "View",
    run: () => import("../terminal/runtime").then((t) => t.showTerminal(true)),
  },
  {
    id: "workbench.action.terminal.new",
    label: "Terminal: New Terminal",
    key: "Ctrl+Shift+`",
    run: () => import("../terminal/runtime").then((t) => t.newTerminal()),
  },
  {
    id: "workbench.action.terminal.split",
    label: "Terminal: Split Terminal",
    key: "Ctrl+Shift+5",
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.splitTerminal()),
  },
  {
    id: "workbench.action.terminal.splitRight",
    label: "Terminal: Split Right",
    run: () => import("../terminal/runtime").then((t) => t.splitTerminal("right")),
  },
  {
    id: "workbench.action.terminal.splitDown",
    label: "Terminal: Split Down",
    run: () => import("../terminal/runtime").then((t) => t.splitTerminal("down")),
  },
  {
    id: "workbench.action.terminal.kill",
    label: "Terminal: Close Pane",
    key: "Ctrl+Shift+W",
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.closePane()),
  },
  {
    id: "workbench.action.terminal.focusNext",
    label: "Terminal: Next Tab",
    key: "Ctrl+PageDown",
    aliases: ["Ctrl+Tab"],
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.nextTerminal(1)),
  },
  {
    id: "workbench.action.terminal.focusPrevious",
    label: "Terminal: Previous Tab",
    key: "Ctrl+PageUp",
    aliases: ["Ctrl+Shift+Tab"],
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.nextTerminal(-1)),
  },
  ...(["left", "right", "up", "down"] as const).map((direction) => ({
    id: `workbench.action.terminal.focus${direction[0].toUpperCase()}${direction.slice(1)}`,
    label: `Terminal: Focus ${direction}`,
    key: `Alt+${direction[0].toUpperCase()}${direction.slice(1)}`,
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.moveFocus(direction)),
  })),
  {
    id: "workbench.action.terminal.copySelection",
    label: "Terminal: Copy Selection",
    key: "Ctrl+Shift+C",
    aliases: ["Ctrl+C"],
    when: "terminalFocus && terminalHasSelection",
    run: () => import("../terminal/runtime").then((t) => t.copyTerminal()),
  },
  {
    id: "workbench.action.terminal.paste",
    label: "Terminal: Paste",
    key: "Ctrl+Shift+V",
    aliases: ["Ctrl+V"],
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.pasteTerminal()),
  },
  {
    id: "workbench.action.terminal.focusFind",
    label: "Terminal: Find",
    key: "Ctrl+F",
    when: "terminalFocus",
    run: () => useTerminal.setState({ find: true }),
  },
  {
    id: "workbench.action.terminal.clear",
    label: "Terminal: Clear",
    run: () => import("../terminal/runtime").then((t) => t.clearTerminal()),
  },
  ...(
    [
      [-1, "Out", "Ctrl+-"],
      [1, "In", "Ctrl+="],
      [0, "Reset", "Ctrl+0"],
    ] as const
  ).map(([delta, name, key]) => ({
    id: `workbench.action.terminal.fontZoom${name}`,
    label: `Terminal: Font Zoom ${name}`,
    key,
    when: "terminalFocus",
    run: () => import("../terminal/runtime").then((t) => t.zoomTerminal(delta)),
  })),
  {
    id: "workbench.action.terminal.selectDefaultProfile",
    label: "Terminal: Select Default Profile",
    run: async () => {
      const { refreshProfiles } = await import("../terminal/runtime");
      await refreshProfiles();
      setApp({
        quick: {
          title: "Select Default Terminal Profile",
          active: useTerminal.getState().defaultProfile ?? undefined,
          items: useTerminal.getState().profiles.map((profile) => ({
            id: profile.name,
            label: profile.name,
            description: profile.path,
            run: async () => {
              const returnToTerminal = useApp.getState().view === "terminal";
              const id = await openSettings();
              if (id) {
                const model = models.get(id)!;
                model.pushEditOperations(
                  [],
                  [
                    {
                      range: model.getFullModelRange(),
                      text: updateSetting(
                        model.getValue(),
                        "terminal.integrated.defaultProfile.windows",
                        profile.name,
                      ),
                    },
                  ],
                  () => null,
                );
                await save(id);
              }
              await refreshProfiles();
              if (returnToTerminal) {
                setApp({ view: "terminal" });
              }
            },
          })),
        },
      });
    },
  },
  {
    id: "workbench.trust.manage",
    label: "Workspaces: Manage Workspace Trust",
    run: async () => {
      if ((await manageWorkspaceTrust()) !== undefined) {
        await restartLanguages();
      }
    },
  },
  {
    id: "litecode.installNode",
    label: "Language Tools: Install Verified Node.js Runtime",
    run: async () => {
      notify("Downloading and verifying Node.js 24.12.0…");
      const result = await call<string>("install_tools", { kind: "node" });
      await restartLanguages();
      notify(result);
    },
  },
  {
    id: "litecode.installLanguages",
    label: "Language Tools: Install JavaScript/TypeScript/Vue Tools",
    run: async () => {
      notify("Installing pinned language tools and Prettier. Package integrity will be verified…");
      const result = await call<string>("install_tools", { kind: "languages" });
      await restartLanguages();
      notify(result);
    },
  },
  {
    id: "litecode.restartLanguages",
    label: "Language: Restart Language Services",
    run: restartLanguages,
  },
  {
    id: "litecode.languageStatus",
    label: "Language: Show Service Status",
    run: () => notify(JSON.stringify(languageReport(), null, 2)),
  },
  {
    id: "litecode.toolStatus",
    label: "Language Tools: Show Tool Paths",
    run: async () => notify(JSON.stringify(await call("tool_status"), null, 2)),
  },
  {
    id: "workbench.action.files.newUntitledFile",
    label: "New Text File",
    key: "Ctrl+N",
    menu: "File",
    run: () => newDocument(),
  },
  {
    id: "workbench.action.newWindow",
    label: "New Window",
    key: "Ctrl+Shift+N",
    menu: "File",
    run: () => call<string>("new_window"),
  },
  {
    id: "workbench.action.files.openFile",
    label: "Open File…",
    key: "Ctrl+O",
    menu: "File",
    run: openFile,
  },
  {
    id: "workbench.action.files.openFolder",
    label: "Open Folder…",
    key: "Ctrl+K Ctrl+O",
    menu: "File",
    run: () => openFolder(),
  },
  {
    id: "litecode.openFolderInNewWindow",
    label: "Open Folder in New Window…",
    menu: "File",
    run: () => openFolder(true),
  },
  {
    id: "workbench.action.openRecent",
    label: "Open Recent…",
    key: "Ctrl+R",
    menu: "File",
    run: () => quick("recent "),
  },
  {
    id: "workbench.action.files.save",
    label: "Save",
    key: "Ctrl+S",
    menu: "File",
    run: () => save(),
  },
  {
    id: "workbench.action.files.saveAs",
    label: "Save As…",
    key: "Ctrl+Shift+S",
    menu: "File",
    run: () => save(activeDoc()?.id, true),
  },
  {
    id: "workbench.action.files.saveAll",
    label: "Save All",
    key: "Ctrl+K S",
    menu: "File",
    run: saveAll,
  },
  {
    id: "workbench.action.closeActiveEditor",
    label: "Close Editor",
    key: "Ctrl+F4",
    aliases: ["Ctrl+W"],
    menu: "File",
    run: (context) => {
      const target = editorTarget(context);
      if (!target) {
        return;
      }
      if (!context && target.group.sticky?.includes(target.doc.id)) {
        const next = target.group.tabs.find((id) => !target.group.sticky?.includes(id));
        if (next) {
          showDocument(next, { group: target.group.id });
        }
        return;
      }
      return closeDocument(target.doc.id, target.group.id);
    },
  },
  {
    id: "workbench.action.closeOtherEditors",
    label: "Close Others",
    run: (context) => closeEditorTabs(context, "others"),
  },
  {
    id: "workbench.action.closeEditorsToTheRight",
    label: "Close to the Right",
    run: (context) => closeEditorTabs(context, "right"),
  },
  {
    id: "workbench.action.closeUnmodifiedEditors",
    label: "Close Saved",
    key: "Ctrl+K U",
    run: (context) => closeEditorTabs(context, "saved"),
  },
  {
    id: "workbench.action.closeEditorsInGroup",
    label: "Close All",
    key: "Ctrl+K W",
    run: (context) => closeEditorTabs(context, "all"),
  },
  {
    id: "copyFilePath",
    label: "Copy Path",
    key: "Shift+Alt+C",
    run: (context) => copyEditorPath(context, false),
  },
  {
    id: "copyRelativeFilePath",
    label: "Copy Relative Path",
    key: "Ctrl+K Ctrl+Shift+C",
    run: (context) => copyEditorPath(context, true),
  },
  {
    id: "revealFileInOS",
    label: "Reveal in File Explorer",
    key: "Shift+Alt+R",
    run: (context) => {
      const path = editorTarget(context)?.doc.path;
      if (path) {
        return call("reveal_path", { path });
      }
    },
  },
  {
    id: "workbench.files.action.showActiveFileInExplorer",
    label: "Reveal in Explorer View",
    run: (context) => {
      const path = editorTarget(context)?.doc.path;
      if (path && canRevealInExplorer(path)) {
        revealInTree(path);
      }
    },
  },
  {
    id: "workbench.action.pinEditor",
    label: "Pin",
    key: "Ctrl+K Shift+Enter",
    run: (context) => pinEditor(context, true),
  },
  {
    id: "workbench.action.unpinEditor",
    label: "Unpin",
    key: "Ctrl+K Shift+Enter",
    run: (context) => pinEditor(context, false),
  },
  {
    id: "workbench.action.toggleAutoSave",
    label: "Toggle Auto Save",
    menu: "File",
    run: async () => {
      const s = useApp.getState();
      const enabled = ["afterDelay", "onFocusChange", "onWindowChange"].some(
        (mode) => s.settings["files.autoSave"] === mode,
      );
      const id = await openSettings();
      if (id) {
        const m = models.get(id)!;
        m.pushEditOperations(
          [],
          [
            {
              range: m.getFullModelRange(),
              text: updateSetting(m.getValue(), "files.autoSave", enabled ? "off" : "afterDelay"),
            },
          ],
          () => null,
        );
        await save(id);
      }
    },
  },
  { id: "undo", label: "Undo", key: "Ctrl+Z", menu: "Edit", run: trigger("undo") },
  { id: "redo", label: "Redo", key: "Ctrl+Y", menu: "Edit", run: trigger("redo") },
  {
    id: "editor.action.clipboardCutAction",
    label: "Cut",
    key: "Ctrl+X",
    menu: "Edit",
    run: trigger("editor.action.clipboardCutAction"),
  },
  {
    id: "editor.action.clipboardCopyAction",
    label: "Copy",
    key: "Ctrl+C",
    menu: "Edit",
    run: trigger("editor.action.clipboardCopyAction"),
  },
  {
    id: "editor.action.clipboardPasteAction",
    label: "Paste",
    key: "Ctrl+V",
    menu: "Edit",
    run: trigger("editor.action.clipboardPasteAction"),
  },
  { id: "actions.find", label: "Find", key: "Ctrl+F", menu: "Edit", run: action("actions.find") },
  {
    id: "editor.action.startFindReplaceAction",
    label: "Replace",
    key: "Ctrl+H",
    menu: "Edit",
    run: action("editor.action.startFindReplaceAction"),
  },
  {
    id: "workbench.action.findInFiles",
    label: "Find in Files",
    key: "Ctrl+Shift+F",
    menu: "Edit",
    run: () => {
      setApp({ sidebar: "search", view: "editor" });
      activateSearchTab(primarySearchId);
      focusSearch();
    },
  },
  {
    id: "litecode.undoReplace",
    label: "Undo Workspace Replacement",
    menu: "Edit",
    run: () => undoReplacement(),
  },
  {
    id: "litecode.retryReplace",
    label: "Search: Retry Interrupted Replacement",
    run: retryReplacement,
  },
  {
    id: "litecode.recoverReplace",
    label: "Search: Recover Interrupted Replacements",
    run: recoverInterruptedReplacements,
  },
  {
    id: "litecode.redoReplace",
    label: "Redo Workspace Replacement",
    menu: "Edit",
    run: () => undoReplacement(true),
  },
  {
    id: "editor.action.selectAll",
    label: "Select All",
    key: "Ctrl+A",
    menu: "Selection",
    run: trigger("editor.action.selectAll"),
  },
  {
    id: "editor.action.smartSelect.expand",
    label: "Expand Selection",
    key: "Shift+Alt+Right",
    menu: "Selection",
    run: action("editor.action.smartSelect.expand"),
  },
  {
    id: "editor.action.smartSelect.shrink",
    label: "Shrink Selection",
    key: "Shift+Alt+Left",
    menu: "Selection",
    run: action("editor.action.smartSelect.shrink"),
  },
  {
    id: "editor.action.addSelectionToNextFindMatch",
    label: "Add Next Occurrence",
    key: "Ctrl+D",
    menu: "Selection",
    run: action("editor.action.addSelectionToNextFindMatch"),
  },
  {
    id: "editor.action.selectHighlights",
    label: "Select All Occurrences",
    key: "Ctrl+Shift+L",
    menu: "Selection",
    run: action("editor.action.selectHighlights"),
  },
  {
    id: "workbench.action.showCommands",
    label: "Command Palette…",
    key: "Ctrl+Shift+P",
    menu: "View",
    run: () => quick(">"),
  },
  {
    id: "workbench.view.explorer",
    label: "Explorer",
    key: "Ctrl+Shift+E",
    menu: "View",
    run: () => setApp({ sidebar: "explorer", view: "editor" }),
  },
  {
    id: "workbench.action.toggleSidebarVisibility",
    label: "Toggle Primary Side Bar",
    key: "Ctrl+B",
    menu: "View",
    run: () => setApp({ sidebar: useApp.getState().sidebar ? null : "explorer" }),
  },
  {
    id: "workbench.action.splitEditor",
    label: "Split Editor",
    key: "Ctrl+\\",
    menu: "View",
    run: (context) => splitEditor(context),
  },
  ...splitDirections.map(({ direction, id }) => ({
    id,
    label: `Split Editor ${direction[0].toUpperCase()}${direction.slice(1)}`,
    menu: "View",
    run: (context?: EditorContext) => splitEditor(context, direction),
  })),
  {
    id: "editor.action.toggleWordWrap",
    label: "Toggle Word Wrap",
    key: "Alt+Z",
    menu: "View",
    run: () =>
      setApp((s) => ({
        settings: {
          ...s.settings,
          "editor.wordWrap": ["on", "wordWrapColumn", "bounded"].includes(
            String(s.settings["editor.wordWrap"]),
          )
            ? "off"
            : "on",
        },
      })),
  },
  {
    id: "workbench.action.navigateBack",
    label: "Back",
    key: "Alt+Left",
    menu: "Go",
    run: () => navigate(-1),
  },
  {
    id: "workbench.action.navigateForward",
    label: "Forward",
    key: "Alt+Right",
    menu: "Go",
    run: () => navigate(1),
  },
  {
    id: "workbench.action.quickOpen",
    label: "Go to File…",
    key: "Ctrl+P",
    menu: "Go",
    run: () => quick(""),
  },
  {
    id: "workbench.action.gotoLine",
    label: "Go to Line/Column…",
    key: "Ctrl+G",
    menu: "Go",
    run: () => quick(":"),
  },
  {
    id: "search.action.focusNextSearchResult",
    label: "Go to Next Search Result",
    key: "F4",
    menu: "Go",
    run: () => nextSearchResult(),
  },
  {
    id: "search.action.focusPreviousSearchResult",
    label: "Go to Previous Search Result",
    key: "Shift+F4",
    menu: "Go",
    run: () => nextSearchResult(-1),
  },
  {
    id: "editor.action.quickOutline",
    label: "Go to Symbol in Editor…",
    key: "Ctrl+Shift+O",
    menu: "Go",
    run: () => quick("@"),
  },
  {
    id: "editor.action.revealDefinition",
    label: "Go to Definition",
    key: "F12",
    menu: "Go",
    run: action("editor.action.revealDefinition"),
  },
  {
    id: "editor.action.goToReferences",
    label: "Go to References",
    key: "Shift+F12",
    menu: "Go",
    run: action("editor.action.goToReferences"),
  },
  {
    id: "editor.action.rename",
    label: "Rename Symbol",
    key: "F2",
    run: action("editor.action.rename"),
  },
  {
    id: "editor.action.formatDocument",
    label: "Format Document",
    key: "Shift+Alt+F",
    run: action("editor.action.formatDocument"),
  },
  {
    id: "search.action.openNewEditor",
    label: "New Search",
    run: () => createSearchTab(),
  },
  { id: "workbench.action.quickTextSearch", label: "Quick Search…", run: () => quick("%") },
  {
    id: "workbench.action.openSettingsJson",
    label: "Preferences: Open User Settings (JSON)",
    run: openSettings,
  },
  {
    id: "workbench.action.openGlobalKeybindingsFile",
    label: "Preferences: Open Keyboard Shortcuts (JSON)",
    run: async () =>
      openPath(await call("settings_path", { kind: "keybindings" }), { pinned: true }),
  },
  {
    id: "litecode.importSettings",
    label: "Preferences: Review VS Code Settings Import",
    run: async () => {
      const root = useApp.getState().root;
      if (!root) {
        throw new Error("Open a workspace containing .vscode/settings.json first.");
      }
      const disk = await call<{ text: string }>("read_document", {
        path: join(root, ".vscode/settings.json"),
      });
      const settings = parseConfiguration(disk.text);
      const { settingsSchemas } = await import("../editor/languages");
      const keys = new Set(Object.keys(settingsSchemas()[0].schema.properties));
      const supported = Object.fromEntries(
        Object.entries(settings).filter(([key]) => keys.has(key)),
      );
      const ignored = Object.keys(settings).filter((key) => !keys.has(key));
      newDocument(
        `# VS Code settings import review\n\nCopy the supported settings below into Preferences: Open User Settings (JSON), or .litecode/settings.json.\n\nThe original .vscode/settings.json remains unchanged.\n\nSupported:\n\n\x60\x60\x60json\n${JSON.stringify(supported, null, 2)}\n\x60\x60\x60\n\nIgnored settings:\n${ignored.map((key) => `- ${key}`).join("\n") || "(none)"}\n`,
        "Settings Import.md",
      );
    },
  },
  { id: "litecode.setLanguage", label: "Change Language Mode", run: changeLanguage },
  {
    id: "litecode.checkForUpdates",
    label: "Check for Updates…",
    menu: "Help",
    run: checkForUpdates,
  },
  {
    id: "litecode.about",
    label: "About LiteCode",
    menu: "Help",
    run: () =>
      setApp({
        notice: `LiteCode ${__APP_VERSION__} · ${__GIT_HASH__}`,
        noticeLink: "https://github.com/lovetingyuan/litecode",
      }),
  },
];
export async function execute(id: string, context?: EditorContext) {
  if (useApp.getState().openingWorkspace !== null) {
    return;
  }
  const command = commands.find((c) => c.id === id);
  if (!command) {
    notify(`Unknown command: ${id}`);
    return;
  }
  try {
    await command.run(context);
    scheduleBackup();
  } catch (e) {
    notify(errorMessage(e));
  }
}

export function keyContext(target: HTMLElement, editorContext?: EditorContext) {
  const state = useApp.getState();
  const current = editorTarget(editorContext);
  const doc = current?.doc;
  const typing =
    ["INPUT", "TEXTAREA"].includes(target.tagName) && !target.closest(".monaco-editor");
  return {
    terminalFocus: !!target.closest(".terminal-pane"),
    terminalHasSelection: terminalSelections.has(
      target.closest<HTMLElement>(".terminal-pane")?.dataset.terminalPane ?? "",
    ),
    editorTextFocus: !!target.closest(".monaco-editor"),
    editorFocus: !!target.closest(".editor-group"),
    inputFocus: typing,
    textInputFocus: typing || !!target.closest(".monaco-editor"),
    explorerViewletFocus: !!target.closest(".explorer-view"),
    searchViewletFocus: !!target.closest(".search-view"),
    resourceLangId: doc?.language ?? "",
    resourceScheme: doc?.path ? "file" : "untitled",
    activeEditorIsPinned: !!current?.group.sticky?.includes(doc?.id ?? ""),
    editorHasSelection: state.cursor.selected > 0,
    workspaceFolderCount: state.root ? "1" : "0",
    isWindows: true,
  };
}
function defaultBindings(
  context: Record<string, string | boolean>,
  bindings = useApp.getState().keybindings,
) {
  return commands
    .filter((command) => matchesWhen(command.when, context))
    .filter(
      (command) =>
        command.id !==
        (context.activeEditorIsPinned
          ? "workbench.action.pinEditor"
          : "workbench.action.unpinEditor"),
    )
    .flatMap((command) =>
      [command.key, ...(command.aliases ?? [])]
        .filter((key): key is string => !!key)
        .map((key) => ({ command, key })),
    )
    .filter(({ command, key }) => !resolveBinding(bindings, key, context).removed.has(command.id));
}
export function commandShortcut(
  id: string,
  context: Record<string, string | boolean>,
  bindings = useApp.getState().keybindings,
) {
  const custom = [...bindings]
    .reverse()
    .find(
      (binding) =>
        binding.command === id && resolveBinding(bindings, binding.key, context).command === id,
    );
  if (custom) {
    return custom.key;
  }
  return defaultBindings(context, bindings).find(
    (binding) =>
      binding.command.id === id && !resolveBinding(bindings, binding.key, context).command,
  )?.key;
}

let chord = "";
export function installKeys() {
  function handler(e: KeyboardEvent) {
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
      return;
    }
    if (useApp.getState().openingWorkspace !== null) {
      chord = "";
      const target = e.target instanceof Element ? e.target : null;
      const allowed =
        e.key === "Tab" ||
        target?.closest('[role="dialog"]') ||
        (["Enter", " "].includes(e.key) && target?.closest(".window-controls"));
      if (!allowed) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (
      e.isComposing ||
      useApp.getState().quick !== null ||
      document.querySelector(".modal-panel, .diff-panel, .editor-tab-menu")
    ) {
      chord = "";
      return;
    }
    const target = e.target as HTMLElement;
    const typing =
      ["INPUT", "TEXTAREA"].includes(target.tagName) && !target.closest(".monaco-editor");
    const physical =
      e.code === "Backquote"
        ? "`"
        : e.ctrlKey && /^Digit\d$/.test(e.code)
          ? e.code.slice(5)
          : e.key;
    const key = `${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.altKey ? "Alt+" : ""}${physical.length === 1 ? physical.toUpperCase() : (({ ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down" } as Record<string, string>)[physical] ?? physical)}`;
    const state = useApp.getState();
    const context = keyContext(target);
    const sequence = normalizeKey(chord ? `${chord} ${key}` : key);
    const binding = resolveBinding(state.keybindings, sequence, context);
    const defaults = defaultBindings(context);
    const wasChord = !!chord;
    chord = "";
    if (
      binding.prefix ||
      (!typing && defaults.some((c) => normalizeKey(c.key).startsWith(`${sequence} `)))
    ) {
      e.preventDefault();
      e.stopPropagation();
      chord = sequence;
      setTimeout(() => {
        if (chord === sequence) {
          chord = "";
        }
      }, 3000);
      return;
    }
    if (binding.command || wasChord) {
      const id =
        binding.command ?? defaults.find((c) => normalizeKey(c.key) === sequence)?.command.id;
      e.preventDefault();
      e.stopPropagation();
      if (id) {
        void execute(id);
      }
      return;
    }
    if (context.terminalFocus) {
      const command = defaults.find(
        (c) =>
          normalizeKey(c.key) === sequence &&
          (c.command.id.startsWith("workbench.action.terminal.") ||
            [
              "workbench.action.showCommands",
              "workbench.action.quickOpen",
              "workbench.view.explorer",
              "workbench.view.scm",
              "workbench.action.findInFiles",
            ].includes(c.command.id)),
      )?.command.id;
      if (command) {
        e.preventDefault();
        e.stopPropagation();
        void execute(command);
      }
      return;
    }
    // Text-editing shortcuts belong to Monaco or the focused input, preserving its context rules.
    const global = defaults.filter(
      (c) =>
        (c.command.id === "workbench.action.findInFiles" ||
          !["Edit", "Selection"].includes(c.command.menu ?? "")) &&
        !["F2", "F12", "Shift+F12", "Shift+Alt+F"].includes(c.key),
    );
    const command = global.find((c) => normalizeKey(c.key) === sequence)?.command.id;
    if (
      command &&
      (!typing ||
        [
          "Ctrl+S",
          "Ctrl+Shift+S",
          "Ctrl+Shift+P",
          "Ctrl+P",
          "Ctrl+Shift+F",
          "Ctrl+Shift+G",
          "Ctrl+O",
        ].includes(key))
    ) {
      e.preventDefault();
      e.stopPropagation();
      void execute(command);
    }
    if (key === "Ctrl+Tab" && !typing) {
      e.preventDefault();
      e.stopPropagation();
      const s = useApp.getState();
      const g = s.groups.find((g) => g.id === s.activeGroup)!;
      const id = g.tabs[(g.tabs.indexOf(g.active ?? "") + 1) % g.tabs.length];
      if (id) {
        showDocument(id);
      }
    }
  }
  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
