import editorStyles from "./EditorGroup.module.css";
import workbenchStyles from "../styles/workbench.module.css";
import terminalStyles from "../styles/terminal.module.css";
import { lazy, Suspense, useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bootstrap, call, desktop, errorMessage } from "../core/bridge";
import { initializeEditor, monaco } from "../editor/monaco";
import { useApp, setApp, notify, patchSearch, primarySearchId } from "../store/store";
import {
  closeWindowWithRecovery,
  restoreDocument,
  refreshDocuments,
  basename,
  pathTitle,
  editor,
  autoSave,
  normalizeGroup,
  models,
  normalize,
  scheduleBackup,
  openPath,
} from "../editor/documents";
import { commands, execute, installKeys, openFolder } from "../core/commands";
import { Explorer, refreshTree } from "./Explorer";
import { handleWorkspaceChanges } from "../explorer/workspaceTree";
import type { WorkspaceChanges } from "../types/types";
import { SearchView } from "./SearchView";
import { EditorLayoutView, WorkbenchLayout } from "./EditorGrid";
import { WelcomePage } from "./WelcomePage";
import { QuickOpen } from "./QuickOpen";
import { DialogHost } from "./dialog";
import { UpdateButton, UpdateDialog } from "./UpdateDialog";
import { initializeUpdates, updateLocked, useUpdates } from "../core/updates";
import { DiffViewer } from "./DiffViewer";
import { Icon, IconButton } from "./ui";
import "../App.css";
import { initializeLanguages } from "../editor/languages";
import { rememberWorkspaceTrust } from "../core/workspaceTrust";
import { isTextView } from "../utils/media";
import { MediaStatus } from "./MediaStatus";
import { GitLineStatus } from "./GitLineStatus";
import { useExternalDrop } from "../hooks/useExternalDrop";
import { recoverInterruptedReplacements } from "../search/replacements";
import { changeIndent, changeEncoding, changeEol } from "../editor/editorStatus";
import { startupMark, startupStep } from "../core/startup";
const TerminalView = lazy(() => import("./TerminalView"));
const GitView = lazy(() => import("./GitView").then((module) => ({ default: module.GitView })));

let startup: Promise<void> | undefined;
function start() {
  return (startup ??= (async () => {
    // Recovery/settings I/O and editor service initialization are independent.
    const [, boot] = await Promise.all([
      startupStep("editor-initialized", initializeEditor),
      startupStep("bootstrap", bootstrap),
    ]);
    await startupStep("languages-initialized", initializeLanguages);
    const restoreStarted = performance.now();
    if (boot.root) {
      rememberWorkspaceTrust(boot.root, boot.workspaceRestricted === true);
    }
    setApp({
      root: boot.root,
      settings: boot.settings,
      recent: boot.recent,
      dataDir: boot.dataDir,
      keybindings: boot.keybindings ?? [],
    });
    for (const mirror of boot.documents) {
      restoreDocument(mirror, { synchronized: true });
    }
    const session = boot.session ?? {};
    for (const doc of session.gitDiffs ?? []) {
      if (doc.gitDiff && boot.root && normalize(doc.gitDiff.workspace) === normalize(boot.root)) {
        setApp((s) => ({
          docs: {
            ...s.docs,
            [doc.id]: {
              ...doc,
              dirty: !!(doc.gitDiff?.sourceId && s.docs[doc.gitDiff.sourceId]?.dirty),
            },
          },
        }));
      }
    }
    if (session.query) {
      patchSearch(primarySearchId, { query: session.query });
      setApp({ searchHistory: session.searchHistory ?? [] });
    }
    const docs = useApp.getState().docs;
    const legacySvg = boot.documents
      .filter((d) => (!d.kind || d.kind === "text") && /\.svg$/i.test(d.path ?? ""))
      .map((d) => d.id);
    const valid = session.groups?.map((g) =>
      normalizeGroup({
        ...g,
        tabs: g.tabs.filter((id) => !!docs[id]),
        active: g.active && docs[g.active] ? g.active : (g.tabs.find((id) => !!docs[id]) ?? null),
        views: g.views ?? {},
        mediaViews: {
          ...Object.fromEntries(
            legacySvg
              .filter((id) => g.tabs.includes(id))
              .map((id) => [id, { mode: "text" as const }]),
          ),
          ...g.mediaViews,
        },
      }),
    );
    setApp({
      ready: true,
      ...(valid?.length
        ? {
            groups: valid,
            editorLayout: session.editorLayout,
            groupMru: session.groupMru ?? [],
            activeGroup:
              session.activeGroup && valid.some((g) => g.id === session.activeGroup)
                ? session.activeGroup
                : valid[0].id,
          }
        : {}),
      sidebarWidth: Number.isFinite(session.sidebarWidth)
        ? Math.max(170, session.sidebarWidth!)
        : 260,
      sidebar:
        session.sidebar === ""
          ? null
          : session.sidebar === "search"
            ? "search"
            : session.sidebar === "git"
              ? "git"
              : "explorer",
      gitRepository: session.gitRepository ?? null,
      gitTab: session.gitTab ?? "changes",
      gitLayout: session.gitLayout ?? "list",
      history: session.history ?? [],
      historyIndex: session.historyIndex ?? -1,
    });
    scheduleBackup();
    startupMark("session-restored", performance.now() - restoreStarted);
    if (boot.warnings.length) {
      notify(boot.warnings.join("\n"));
    }
    if (boot.root) {
      await startupStep("explorer-refreshed", refreshTree);
    }
    await startupStep("documents-refreshed", refreshDocuments);
    if (boot.initialOpen) {
      try {
        if (boot.initialOpen.directory) {
          await openFolder(false, boot.initialOpen.path, false);
        } else {
          await openPath(boot.initialOpen.path, { pinned: true });
        }
      } catch (error) {
        notify(`Could not open ${boot.initialOpen.path}: ${errorMessage(error)}`);
      }
    }
    if (desktop) {
      void recoverInterruptedReplacements().catch((error) => notify(errorMessage(error)));
    }
  })());
}

export default function App() {
  const s = useApp();
  const openingWorkspace = s.openingWorkspace !== null;
  const locked = useUpdates((s) => updateLocked(s.phase));
  const [fatal, setFatal] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  useExternalDrop(s.ready);
  const [diagnostics, setDiagnostics] = useState({ errors: 0, warnings: 0 });
  useEffect(() => {
    startupMark("react-mounted");
    void start().catch((e) => setFatal(errorMessage(e)));
    return installKeys();
  }, []);
  useEffect(() => {
    if (s.ready) {
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => startupMark("workbench-painted"));
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [s.ready]);
  useEffect(() => {
    if (!s.ready) {
      return;
    }
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void initializeUpdates()
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          cleanup = stop;
        }
      })
      .catch((error) => console.error("Could not initialize updates", errorMessage(error)));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [s.ready]);
  useEffect(() => {
    if (!s.ready) {
      return;
    }
    const markers = monaco.editor.onDidChangeMarkers(() => {
      const all = monaco.editor.getModelMarkers({});
      setDiagnostics({
        errors: all.filter((m) => m.severity === monaco.MarkerSeverity.Error).length,
        warnings: all.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length,
      });
    });
    return () => markers.dispose();
  }, [s.ready]);
  useEffect(() => {
    if (!desktop) {
      return;
    }
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const onChange = await listen<WorkspaceChanges>("workspace-changed", ({ payload }) => {
        void handleWorkspaceChanges(payload).then((accepted) => {
          if (accepted) {
            void refreshDocuments(
              payload.rescan
                ? undefined
                : [
                    ...payload.changes.map(
                      ({ path }) => `${payload.root.replace(/[\\/]+$/, "")}/${path}`,
                    ),
                    ...(payload.gitPaths ?? []),
                  ],
            );
          }
        });
      });
      if (disposed) {
        onChange();
      } else {
        cleanups.push(onChange);
      }
      const onConfig = await listen("configuration-changed", () => {
        void call<{
          settings: Record<string, unknown>;
          keybindings: import("../types/types").Keybinding[] | null;
        }>("configuration")
          .then((config) =>
            setApp({ settings: config.settings, keybindings: config.keybindings ?? [] }),
          )
          .catch((e) => notify(errorMessage(e)));
      });
      if (disposed) {
        onConfig();
      } else {
        cleanups.push(onConfig);
      }
      const win = getCurrentWindow();
      const syncMaximized = () => {
        void win
          .isMaximized()
          .then((value) => {
            if (!disposed) {
              setMaximized(value);
            }
          })
          .catch((e) => notify(errorMessage(e)));
      };
      const onResize = await win.onResized(syncMaximized);
      if (disposed) {
        onResize();
      } else {
        cleanups.push(onResize);
        syncMaximized();
      }
      const onFocus = await win.onFocusChanged(({ payload: focused }) => {
        if (!disposed) {
          if (focused) {
            void refreshDocuments().catch((e) => notify(errorMessage(e)));
          } else {
            void autoSave("onWindowChange");
          }
        }
      });
      if (disposed) {
        onFocus();
      } else {
        cleanups.push(onFocus);
      }
      const onClose = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await closeWindowWithRecovery(() => win.destroy());
        } catch (e) {
          notify(`Could not save recovery data. Window remains open: ${errorMessage(e)}`);
        }
      });
      if (disposed) {
        onClose();
      } else {
        cleanups.push(onClose);
      }
    })().catch((e) => notify(errorMessage(e)));
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);
  const group = s.groups.find((g) => g.id === s.activeGroup);
  const doc = s.docs[group?.active ?? ""];
  const rootName = s.root ? basename(pathTitle(s.root).replace(/[\\/]+$/, "")) : "";
  const showWelcome = s.ready && !s.root && s.groups.every((group) => group.tabs.length === 0);
  useEffect(() => {
    if (desktop) {
      void getCurrentWindow().setTitle(
        `${doc?.dirty ? "● " : ""}${doc?.name ? `${doc.name} — ` : ""}${s.root ? `${basename(s.root)} — ` : ""}LiteCode`,
      );
    }
  }, [doc?.name, doc?.dirty, s.root]);
  function windowAction(action: "minimize" | "maximize" | "close") {
    if (!desktop) {
      return;
    }
    const win = getCurrentWindow();
    if (action === "minimize") {
      void win.minimize();
    }
    if (action === "maximize") {
      void win.toggleMaximize().catch((e) => notify(errorMessage(e)));
    }
    if (action === "close") {
      void win.close();
    }
  }
  return (
    <>
      <div className="workbench relative h-full flex flex-col overflow-hidden" inert={locked}>
        <header
          className={`titlebar h-[35px] min-h-[35px] bg-sidebar border-b border-b-panel flex items-center relative select-none ${workbenchStyles["titlebar"]}`}
          data-tauri-drag-region
        >
          <div
            className={`app-mark w-10 flex justify-center text-link ${workbenchStyles["app-mark"]}`}
          >
            <img src="/litecode.svg" alt="LiteCode" width={32} height={32} draggable={false} />
          </div>
          <nav
            className={`menubar flex h-full items-center z-[2] ${workbenchStyles["menubar"]}`}
            aria-label="Application menu"
            inert={openingWorkspace}
          >
            {["File", "Edit", "Selection", "View", "Go", "Help"].map((menu) => (
              <Menu.Root key={menu}>
                <Menu.Trigger>{menu}</Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner className="z-90" side="bottom" align="start" sideOffset={0}>
                    <Menu.Popup
                      className={`context-menu bg-editor text-foreground p-1 border border-strong rounded-[5px] min-w-[210px] z-[90] ${workbenchStyles["context-menu"]} application-menu min-w-75`}
                    >
                      {commands
                        .filter((c) => c.menu === menu)
                        .map((c) => (
                          <Menu.Item key={c.id} onClick={() => void execute(c.id)}>
                            <span>{c.label}</span>
                            {c.key && <kbd>{c.key}</kbd>}
                          </Menu.Item>
                        ))}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            ))}
          </nav>
          <div
            className={`title-center absolute left-[50%] w-[40%] max-w-150 flex items-center gap-1 h-full justify-center ${workbenchStyles["title-center"]}`}
            data-tauri-drag-region
          />
          <div className="title-updates ml-auto mr-2" inert={openingWorkspace}>
            <UpdateButton />
          </div>
          <div
            className={`title-layout ml-0 flex mr-2 ${workbenchStyles["title-layout"]}`}
            inert={openingWorkspace}
          >
            <IconButton
              icon="arrow-left"
              label="Go Back (Alt+Left)"
              onClick={() => void execute("workbench.action.navigateBack")}
              disabled={s.historyIndex <= 0}
            />
            <IconButton
              icon="arrow-right"
              label="Go Forward (Alt+Right)"
              onClick={() => void execute("workbench.action.navigateForward")}
              disabled={s.historyIndex >= s.history.length - 1}
            />
            <IconButton
              icon="search"
              label="Search (Ctrl+P)"
              onClick={() => setApp({ quick: "" })}
            />
            <IconButton
              icon="layout-sidebar-left"
              label="Toggle Primary Side Bar"
              onClick={() => void execute("workbench.action.toggleSidebarVisibility")}
            />
            <IconButton
              icon="layout"
              label={s.view === "terminal" ? "Split Terminal" : "Split Editor"}
              onClick={() =>
                void execute(
                  s.view === "terminal"
                    ? "workbench.action.terminal.split"
                    : "workbench.action.splitEditor",
                )
              }
            />
          </div>
          <div className={`window-controls flex h-full ${workbenchStyles["window-controls"]}`}>
            <button aria-label="Minimize" onClick={() => windowAction("minimize")}>
              <Icon name="chrome-minimize" />
            </button>
            <button
              aria-label={maximized ? "Restore" : "Maximize"}
              onClick={() => windowAction("maximize")}
            >
              <Icon name={maximized ? "chrome-restore" : "chrome-maximize"} />
            </button>
            <button
              className="window-close"
              aria-label="Close Window"
              onClick={() => windowAction("close")}
            >
              <Icon name="chrome-close" />
            </button>
          </div>
        </header>
        <div
          className="workbench-body flex flex-1 min-h-0 relative"
          inert={openingWorkspace}
          aria-busy={openingWorkspace}
        >
          <nav
            className={`activitybar w-12 bg-sidebar border-r border-r-panel flex flex-col justify-between shrink-0 ${workbenchStyles["activitybar"]}`}
            aria-label="Views"
          >
            <div>
              <button
                className={s.view === "editor" && s.sidebar === "explorer" ? "active" : ""}
                aria-label="Explorer (Ctrl+Shift+E)"
                title="Explorer (Ctrl+Shift+E)"
                onClick={() =>
                  setApp({
                    view: "editor",
                    sidebar: s.view === "editor" && s.sidebar === "explorer" ? null : "explorer",
                  })
                }
              >
                <Icon name="files" />
              </button>
              <button
                className={s.view === "editor" && s.sidebar === "search" ? "active" : ""}
                aria-label="Search (Ctrl+Shift+F)"
                title="Search (Ctrl+Shift+F)"
                onClick={() => void execute("workbench.action.findInFiles")}
              >
                <Icon name="search" />
              </button>
              <button
                disabled={!s.ready}
                className={s.view === "terminal" ? "active" : ""}
                aria-label="Terminal (Ctrl+`)"
                title="Terminal (Ctrl+`)"
                onClick={() => void execute("workbench.action.terminal.toggleTerminal")}
              >
                <Icon name="terminal" />
              </button>
              <button
                disabled={!s.ready}
                className={s.view === "editor" && s.sidebar === "git" ? "active" : ""}
                aria-label="Source Control (Ctrl+Shift+G)"
                title="Source Control (Ctrl+Shift+G)"
                onClick={() =>
                  setApp({
                    view: "editor",
                    sidebar: s.view === "editor" && s.sidebar === "git" ? null : "git",
                  })
                }
              >
                <Icon name="source-control" />
              </button>
            </div>
            <button
              title="Manage"
              aria-label="Manage"
              onClick={() => setApp({ quick: ">Preferences:" })}
            >
              <Icon name="settings-gear" />
            </button>
          </nav>
          {s.ready && (
            <WorkbenchLayout
              sidebar={
                <aside className="sidebar bg-sidebar shrink-0 flex-col overflow-hidden border-r border-r-panel">
                  <div
                    className={`sidebar-view ${workbenchStyles["sidebar-view"]}`}
                    hidden={s.sidebar !== "explorer"}
                  >
                    <Explorer
                      openFolder={() => void openFolder().catch((e) => notify(errorMessage(e)))}
                    />
                  </div>
                  <div
                    className={`sidebar-view ${workbenchStyles["sidebar-view"]}`}
                    hidden={s.sidebar !== "search"}
                  >
                    <SearchView />
                  </div>
                  <div
                    className={`sidebar-view ${workbenchStyles["sidebar-view"]}`}
                    hidden={s.sidebar !== "git"}
                  >
                    {s.sidebar === "git" && (
                      <Suspense
                        fallback={
                          <div
                            className={`startup flex-1 flex items-center justify-center flex-col p-10 ${workbenchStyles["startup"]}`}
                          >
                            Loading Source Control…
                          </div>
                        }
                      >
                        <GitView />
                      </Suspense>
                    )}
                  </div>
                </aside>
              }
            >
              <main
                className={`editors relative flex-1 flex min-w-0 overflow-hidden ${workbenchStyles["editors"]}`}
                aria-label="Editors"
              >
                <div
                  className={`editor-groups flex flex-1 min-w-0 overflow-hidden ${editorStyles["editor-groups"]}${showWelcome ? " welcome-hidden" : ""}${s.view === "terminal" ? ` workbench-editor-hidden ${terminalStyles["workbench-editor-hidden"]}` : ""}`}
                  inert={showWelcome || s.view === "terminal"}
                  aria-hidden={showWelcome || s.view === "terminal" || undefined}
                >
                  {s.editorLayout && <EditorLayoutView node={s.editorLayout} />}
                </div>
                {showWelcome && s.view === "editor" && <WelcomePage />}
                {s.view === "terminal" && (
                  <Suspense
                    fallback={
                      <div
                        className={`startup flex-1 flex items-center justify-center flex-col p-10 ${workbenchStyles["startup"]}`}
                      >
                        Starting terminal…
                      </div>
                    }
                  >
                    <TerminalView />
                  </Suspense>
                )}
              </main>
            </WorkbenchLayout>
          )}
          {!s.ready && (
            <div
              className={`startup flex-1 flex items-center justify-center flex-col p-10 ${workbenchStyles["startup"]}`}
              role="status"
            >
              {fatal ? (
                <>
                  <Icon name="error" />
                  <p>{fatal}</p>
                  <button onClick={() => location.reload()}>Reload</button>
                </>
              ) : (
                <>
                  <span
                    className={`spinner w-5 h-5 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
                  />
                  <p>Starting editor services…</p>
                </>
              )}
            </div>
          )}
        </div>
        {openingWorkspace && (
          <div
            className={`workspace-opening absolute inset-[35px_0_22px] z-[100] bg-editor gap-3 ${workbenchStyles["workspace-opening"]} startup flex-1 flex items-center justify-center flex-col p-10 ${workbenchStyles["startup"]}`}
            role="status"
            aria-live="polite"
          >
            <span
              className={`spinner w-5 h-5 border-[2px] border-button-secondary rounded-full ${workbenchStyles["spinner"]}`}
              aria-hidden="true"
            />
            <p>Opening folder…</p>
            {s.openingWorkspace && (
              <p
                className={`workspace-opening-path max-w-full text-center text-subtle ${workbenchStyles["workspace-opening-path"]}`}
              >
                {pathTitle(s.openingWorkspace)}
              </p>
            )}
          </div>
        )}
        <footer
          className={`statusbar h-[22px] min-h-[22px] flex justify-between bg-sidebar border-t border-t-panel text-[12px] select-none ${workbenchStyles["statusbar"]}`}
          inert={openingWorkspace}
        >
          <div className="status-left flex items-stretch min-w-0">
            <span
              className={`remote-indicator flex items-center text-foreground-strong px-[10px] mr-[5px] ${import.meta.env.DEV ? "bg-remote-development" : "bg-button"}`}
              title={import.meta.env.DEV ? "Local window (Development)" : "Local window"}
            >
              <Icon name="remote" />
            </span>
            {s.root && (
              <Popover.Root key={s.root}>
                <Popover.Trigger
                  className={`workspace-status ${workbenchStyles["workspace-status"]}`}
                  title={rootName}
                  aria-label={`Project Folder: ${rootName}`}
                >
                  <Icon name="folder" />
                  <span>{rootName}</span>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner
                    className="z-90"
                    side="top"
                    align="start"
                    sideOffset={4}
                    collisionPadding={8}
                  >
                    <Popover.Popup
                      className={`workspace-popup flex items-start gap-3 w-[max-content] max-w-[min(560px,_calc(100vw_-_16px),_var(--available-width))] max-h-[var(--available-height)] overflow-y-auto p-2 bg-widget text-foreground border border-strong rounded-[4px] ${workbenchStyles["workspace-popup"]}`}
                      aria-label="Project folder"
                      initialFocus={false}
                    >
                      <span
                        className={`workspace-path flex-1 min-w-0 py-[3px] px-0 leading-[18px] select-text ${workbenchStyles["workspace-path"]}`}
                      >
                        {pathTitle(s.root)}
                      </span>
                      <Popover.Close
                        render={
                          <IconButton
                            icon="folder-opened"
                            label="Open Project Folder in File Explorer"
                          />
                        }
                        onClick={() =>
                          void call("open_directory", { path: s.root }).catch((error) =>
                            notify(errorMessage(error)),
                          )
                        }
                      />
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
            {s.gitState.branch && (
              <button
                type="button"
                className={`status-item ${workbenchStyles["status-item"]}`}
                title="Current Git branch"
                aria-label={`Show Git Repository: ${s.gitState.branch}`}
                onClick={() => {
                  setApp({ view: "editor", sidebar: "git", gitTab: "info" });
                  scheduleBackup();
                }}
              >
                <Icon name="source-control" />
                {s.gitState.branch}
              </button>
            )}
            <button
              title="Show Problems"
              onClick={() => void editor()?.getAction("editor.action.marker.next")?.run()}
            >
              <Icon name="error" />
              {diagnostics.errors}
              <Icon name="warning" />
              {diagnostics.warnings}
            </button>
          </div>
          <div
            className={`status-right flex items-stretch min-w-0 ${workbenchStyles["status-right"]}`}
          >
            <GitLineStatus
              doc={s.view === "editor" && doc && isTextView(doc, group) ? doc : undefined}
            />
            {s.view === "editor" && doc && isTextView(doc, group) && (
              <>
                <button onClick={() => setApp({ quick: ":" })}>
                  Ln {s.cursor.line}, Col {s.cursor.column}
                  {s.cursor.selected ? ` (${s.cursor.selected} selected)` : ""}
                </button>
                <IndentationStatus documentId={doc.id} />
                <button className="encoding-status" onClick={changeEncoding}>
                  {doc.encoding.toUpperCase().replace("UTF8", "UTF-8")}
                </button>
                <button onClick={changeEol}>{doc.eol}</button>
                <button onClick={() => void execute("litecode.setLanguage")}>
                  {doc.language === "plaintext" ? "Plain Text" : doc.language}
                </button>
              </>
            )}
            {s.view === "editor" && doc && group && !doc.gitDiff && !isTextView(doc, group) && (
              <MediaStatus doc={doc} group={group} />
            )}
            {s.searchSessions.some((search) => search.searching) && <span>Searching…</span>}
            <span
              className={`status-item ${workbenchStyles["status-item"]}`}
              title={s.languageStatus}
            >
              <Icon name="check" />
            </span>
            <button
              title="Notifications"
              onClick={() => notify(s.notice ?? "No new notifications.")}
              aria-label="Notifications"
            >
              <Icon name="bell" />
            </button>
          </div>
        </footer>
        {s.notice && (
          <div
            className={`notification fixed right-[18px] bottom-[38px] w-105 max-w-[calc(100vw_-_36px)] bg-widget border border-strong rounded-[5px] z-[100] flex items-start p-3 gap-[9px] ${workbenchStyles["notification"]}`}
            role="status"
          >
            <Icon name="info" />
            <p>
              {s.notice}
              {s.noticeLink &&
                [
                  { label: "Homepage", url: "https://litecode.tingyuan.in" },
                  { label: "GitHub", url: s.noticeLink },
                ].map(({ label, url }) => (
                  <span key={label}>
                    {`\n${label}: `}
                    <a
                      href={url}
                      onClick={(event) => {
                        event.preventDefault();
                        void openUrl(event.currentTarget.href).catch((error) =>
                          notify(errorMessage(error)),
                        );
                      }}
                    >
                      {url}
                    </a>
                  </span>
                ))}
            </p>
            <IconButton
              icon="close"
              label="Dismiss Notification"
              onClick={() => setApp({ notice: null })}
            />
          </div>
        )}
        {s.ready && (
          <>
            <QuickOpen />
            <DiffViewer />
          </>
        )}
        <DialogHost />
      </div>
      <UpdateDialog />
    </>
  );
}

function IndentationStatus({ documentId }: { documentId: string }) {
  const model = models.get(documentId);
  const [options, setOptions] = useState(() => model?.getOptions());
  useEffect(() => {
    setOptions(model?.getOptions());
    const listener = model?.onDidChangeOptions(() => setOptions(model.getOptions()));
    return () => listener?.dispose();
  }, [model]);
  return (
    <button className="indentation-status" onClick={changeIndent}>
      {options?.insertSpaces === false ? "Tabs" : "Spaces"}: {options?.tabSize ?? 4}
    </button>
  );
}
