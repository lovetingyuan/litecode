import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Allotment } from "allotment";
import { useApp, notify } from "../store/store";
import { errorMessage } from "../core/bridge";
import { execute } from "../core/commands";
import {
  layoutGroups,
  minimumLayoutSize,
  resizeLayout,
  type EditorLayout,
} from "../editor/editorLayout";
import { reorderTab, selectPane, useTerminal } from "../terminal/state";
import {
  closePane,
  closeTab,
  copyTerminal,
  findTerminal,
  focusTerminal,
  mountPane,
  newTerminal,
  pasteTerminal,
  refreshProfiles,
  restartPane,
  selectTab,
  selectTerminalWord,
  setPaneVisible,
  splitTerminal,
} from "../terminal/runtime";
import { terminalSetting } from "../terminal/settings";
import { PaneLayout } from "./EditorGrid";
import { input } from "./dialog";
import { Icon, IconButton } from "./ui";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";

const noCommit = () => {};
const safe = (operation: Promise<unknown>) => {
  void operation.catch((error) => notify(errorMessage(error)));
};
function SettingsButton() {
  return (
    <IconButton
      icon="settings-gear"
      label="Terminal Settings"
      onClick={() => void execute("workbench.action.openSettingsJson")}
    />
  );
}

export default function TerminalView() {
  const tabs = useTerminal((s) => s.tabs);
  const selected = useTerminal((s) => s.activeTab);
  const panes = useTerminal((s) => s.panes);
  const profiles = useTerminal((s) => s.profiles);
  const currentDefault = useTerminal((s) => s.defaultProfile);
  const finding = useTerminal((s) => s.find);
  const visible = useApp((s) => s.view === "terminal");
  const tabBar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (visible) {
      tabBar.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selected, visible]);
  async function rename(id: string) {
    const tab = useTerminal.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    const value = await input(
      "Rename Terminal",
      tab.name ?? panes[tab.activePane]?.profile ?? "Terminal",
    );
    if (value) {
      useTerminal.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, name: value } : t)),
      }));
    }
  }
  return (
    <section className="terminal-view" aria-label="Terminal" hidden={!visible}>
      <div className="terminal-toolbar">
        <div
          ref={tabBar}
          className="terminal-tabs"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {tabs.map((tab) => (
            <ContextMenu.Root key={tab.id}>
              <ContextMenu.Trigger
                render={
                  <div
                    className={`terminal-tab${tab.id === selected ? " active" : ""}`}
                  />
                }
              >
                <button
                  role="tab"
                  id={`terminal-tab-${tab.id}`}
                  aria-selected={tab.id === selected}
                  aria-controls={`terminal-panel-${tab.id}`}
                  tabIndex={tab.id === selected ? 0 : -1}
                  draggable
                  onClick={() => selectTab(tab.id)}
                  onDoubleClick={() => safe(rename(tab.id))}
                  onDragStart={(event) =>
                    event.dataTransfer.setData(
                      "application/x-litecode-terminal-tab",
                      tab.id,
                    )
                  }
                  onDragOver={(event) => {
                    if (
                      event.dataTransfer.types.includes(
                        "application/x-litecode-terminal-tab",
                      )
                    ) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const id = event.dataTransfer.getData(
                      "application/x-litecode-terminal-tab",
                    );
                    if (id && id !== tab.id) {
                      reorderTab(id, tab.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    ) {
                      event.preventDefault();
                      const index = tabs.indexOf(tab);
                      selectTab(
                        tabs[
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? tabs.length - 1
                              : (index +
                                  (event.key === "ArrowRight" ? 1 : -1) +
                                  tabs.length) %
                                tabs.length
                        ].id,
                      );
                    }
                  }}
                >
                  <Icon name="terminal" />
                  <span>
                    {tab.name ??
                      panes[tab.activePane]?.profile ??
                      currentDefault ??
                      "Terminal"}
                  </span>
                  {layoutGroups(tab.layout).length > 1 && (
                    <small>{layoutGroups(tab.layout).length}</small>
                  )}
                </button>
                <IconButton
                  icon="close"
                  className="terminal-tab-close"
                  label={`Close Terminal Tab ${tab.name ?? panes[tab.activePane]?.profile ?? "Terminal"}`}
                  onClick={() => closeTab(tab.id)}
                />
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Positioner className="z-90">
                  <ContextMenu.Popup className="context-menu">
                    <ContextMenu.Item onClick={() => safe(rename(tab.id))}>
                      Rename…
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      onClick={() =>
                        safe(splitTerminal("right", tab.activePane))
                      }
                    >
                      Split Right
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      onClick={() =>
                        safe(splitTerminal("down", tab.activePane))
                      }
                    >
                      Split Down
                    </ContextMenu.Item>
                    <ContextMenu.Separator className="menu-separator" />
                    <ContextMenu.Item onClick={() => closeTab(tab.id)}>
                      Close Tab
                    </ContextMenu.Item>
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
        </div>
        <div className="terminal-actions">
          <IconButton
            icon="add"
            label="New Terminal (Ctrl+Shift+`)"
            onClick={() => newTerminal()}
          />
          <Menu.Root
            onOpenChange={(open) => {
              if (open) {
                safe(refreshProfiles());
              }
            }}
          >
            <Menu.Trigger
              render={
                <IconButton
                  icon="chevron-down"
                  label="Select Terminal Profile"
                />
              }
            />
            <Menu.Portal>
              <Menu.Positioner className="z-90" side="bottom" align="end">
                <Menu.Popup className="context-menu">
                  {profiles.map((profile) => (
                    <Menu.Item
                      key={profile.name}
                      onClick={() => newTerminal(profile.name)}
                    >
                      <span>{profile.name}</span>
                      {profile.name === currentDefault && <Icon name="check" />}
                    </Menu.Item>
                  ))}
                  <Menu.Separator className="menu-separator" />
                  <Menu.Item
                    onClick={() =>
                      void execute(
                        "workbench.action.terminal.selectDefaultProfile",
                      )
                    }
                  >
                    Select Default Profile…
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <IconButton
            icon="split-horizontal"
            label="Split Terminal Right"
            disabled={!tabs.length}
            onClick={() => safe(splitTerminal("right"))}
          />
          <IconButton
            icon="split-vertical"
            label="Split Terminal Down"
            disabled={!tabs.length}
            onClick={() => safe(splitTerminal("down"))}
          />
          <IconButton
            icon="search"
            label="Find in Terminal (Ctrl+F)"
            disabled={!tabs.length}
            onClick={() => useTerminal.setState({ find: !finding })}
          />
          <SettingsButton />
        </div>
      </div>
      {finding && <TerminalFind />}
      <div className="terminal-content">
        {tabs.map((tab) => (
          <div
            className="terminal-panel"
            key={tab.id}
            id={`terminal-panel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`terminal-tab-${tab.id}`}
            hidden={tab.id !== selected}
          >
            <TerminalLayout
              node={tab.layout}
              tabId={tab.id}
              visible={visible && tab.id === selected}
            />
          </div>
        ))}
        {!tabs.length && (
          <div className="terminal-empty">
            <Icon name="terminal" />
            <p>No terminal is running.</p>
            <button onClick={() => newTerminal()}>New Terminal</button>
          </div>
        )}
      </div>
    </section>
  );
}

function TerminalLayout({
  node,
  tabId,
  visible,
}: {
  node: EditorLayout;
  tabId: string;
  visible: boolean;
}) {
  if (node.type === "group") {
    return <TerminalPane id={node.id} visible={visible} />;
  }
  return (
    <PaneLayout
      key={`${node.id}:${node.axis}:${node.children.map((c) => c.id).join(",")}`}
      label="Terminal pane size"
      vertical={node.axis === "vertical"}
      defaultSizes={node.sizes}
      onCommit={noCommit}
      onChange={(sizes) =>
        useTerminal.setState((s) => ({
          tabs: s.tabs.map((tab) =>
            tab.id === tabId
              ? { ...tab, layout: resizeLayout(tab.layout, node.id, sizes) }
              : tab,
          ),
        }))
      }
    >
      {node.children.map((child) => {
        const minimum = minimumLayoutSize(child);
        return (
          <Allotment.Pane
            key={child.id}
            minSize={node.axis === "vertical" ? minimum.height : minimum.width}
          >
            <TerminalLayout node={child} tabId={tabId} visible={visible} />
          </Allotment.Pane>
        );
      })}
    </PaneLayout>
  );
}

function TerminalPane({ id, visible }: { id: string; visible: boolean }) {
  const pane = useTerminal((s) => s.panes[id]);
  const focused = useTerminal(
    (s) => s.tabs.find((t) => t.id === s.activeTab)?.activePane === id,
  );
  const settings = useApp((s) => s.settings);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (host.current) {
      return mountPane(id, host.current);
    }
  }, [id, pane?.attempt]);
  useEffect(() => setPaneVisible(id, visible), [id, visible]);
  if (!pane) {
    return null;
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <div
            className={`terminal-pane${focused ? " focused" : ""}`}
            data-terminal-pane={id}
            onFocusCapture={() => selectPane(id)}
            onPointerDown={() => selectPane(id)}
          />
        }
        onContextMenuCapture={(event) => {
          if (event.shiftKey) {
            return;
          }
          const behavior = terminalSetting(settings, "rightClickBehavior");
          event.preventDefault();
          event.stopPropagation();
          if (behavior === "nothing") {
            return;
          }
          if (behavior === "selectWord") {
            selectTerminalWord(id, event);
            return;
          }
          if (behavior === "paste") {
            safe(pasteTerminal(id));
          } else {
            safe(
              import("../terminal/runtime").then(async (r) => {
                focusTerminal(id);
                if (r.hasTerminalSelection()) {
                  await copyTerminal(id);
                } else {
                  await pasteTerminal(id);
                }
              }),
            );
          }
        }}
      >
        <div ref={host} className="terminal-host" />
        <div className="terminal-pane-caption" title={pane.cwd}>
          {pane.status === "starting" ? "Starting…" : pane.cwd}
        </div>
        <IconButton
          icon="close"
          className="terminal-pane-close"
          label="Close Terminal Pane"
          onClick={() => closePane(id)}
        />
        {(pane.status === "error" || pane.status === "exited") && (
          <div className="terminal-exit" role="status">
            <span>{pane.error}</span>
            <button onClick={() => restartPane(id)}>Restart Terminal</button>
          </div>
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-90">
          <ContextMenu.Popup className="context-menu">
            <ContextMenu.Item onClick={() => safe(copyTerminal(id))}>
              Copy
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => safe(pasteTerminal(id))}>
              Paste
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => {
                focusTerminal(id);
                void execute("workbench.action.terminal.clear");
              }}
            >
              Clear
            </ContextMenu.Item>
            <ContextMenu.Separator className="menu-separator" />
            <ContextMenu.Item onClick={() => safe(splitTerminal("right", id))}>
              Split Right
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => safe(splitTerminal("down", id))}>
              Split Down
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => closePane(id)}>
              Close Pane
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TerminalFind() {
  const [text, setText] = useState("");
  const [regex, setRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [found, setFound] = useState(true);
  const pane = useTerminal(
    (s) => s.tabs.find((t) => t.id === s.activeTab)?.activePane,
  );
  useEffect(() => {
    setFound(findTerminal(text, false, regex, matchCase));
  }, [text, regex, matchCase, pane]);
  const close = () => {
    useTerminal.setState({ find: false });
    findTerminal("");
    focusTerminal();
  };
  return (
    <div className="terminal-find" role="search" aria-label="Find in terminal">
      <input
        autoFocus
        aria-label="Terminal search"
        value={text}
        placeholder="Find"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            close();
          } else if (event.key === "Enter") {
            event.preventDefault();
            setFound(findTerminal(text, event.shiftKey, regex, matchCase));
          }
        }}
      />
      <button
        title="Match Case"
        aria-pressed={matchCase}
        onClick={() => setMatchCase(!matchCase)}
      >
        Aa
      </button>
      <button
        title="Use Regular Expression"
        aria-pressed={regex}
        onClick={() => setRegex(!regex)}
      >
        .*
      </button>
      <span role="status">{text && !found ? "No results" : ""}</span>
      <IconButton
        icon="arrow-up"
        label="Previous Terminal Match"
        onClick={() => setFound(findTerminal(text, true, regex, matchCase))}
      />
      <IconButton
        icon="arrow-down"
        label="Next Terminal Match"
        onClick={() => setFound(findTerminal(text, false, regex, matchCase))}
      />
      <IconButton icon="close" label="Close Terminal Search" onClick={close} />
    </div>
  );
}
