import { create } from "zustand";
import {
  layoutGroups,
  removeLayoutGroup,
  splitLayout,
  type EditorLayout,
  type SplitDirection,
} from "../editor/editorLayout";

export type Profile = {
  name: string;
  path: string;
  args: string[];
  env: Record<string, string | null>;
  kind: string;
};
export type Pane = {
  id: string;
  profile?: string;
  cwd: string;
  initialCwd: string;
  reportedCwd: boolean;
  status: "starting" | "running" | "exited" | "error";
  error?: string;
  exitCode?: number;
  attempt?: number;
};
export type TerminalTab = {
  id: string;
  name?: string;
  activePane: string;
  layout: EditorLayout;
};
type State = {
  tabs: TerminalTab[];
  activeTab: string | null;
  panes: Record<string, Pane>;
  profiles: Profile[];
  defaultProfile: string | null;
  initialized: boolean;
  find: boolean;
};
export const useTerminal = create<State>(() => ({
  tabs: [],
  activeTab: null,
  panes: {},
  profiles: [],
  defaultProfile: null,
  initialized: false,
  find: false,
}));
export const terminalSelections = new Set<string>();

export function addTab(profile?: string) {
  const id = crypto.randomUUID();
  const pane = makePane(profile);
  useTerminal.setState((s) => ({
    initialized: true,
    tabs: [
      ...s.tabs,
      { id, activePane: pane.id, layout: { type: "group", id: pane.id } },
    ],
    activeTab: id,
    panes: { ...s.panes, [pane.id]: pane },
  }));
  return pane.id;
}
function makePane(profile?: string): Pane {
  return {
    id: crypto.randomUUID(),
    profile,
    cwd: "",
    initialCwd: "",
    reportedCwd: false,
    status: "starting",
  };
}
export function addSplit(source: string, direction: SplitDirection) {
  const state = useTerminal.getState();
  const tab = state.tabs.find((t) => layoutGroups(t.layout).includes(source));
  if (!tab || !state.panes[source]) {
    return;
  }
  const pane = makePane(state.panes[source].profile);
  useTerminal.setState((s) => ({
    panes: { ...s.panes, [pane.id]: pane },
    tabs: s.tabs.map((t) =>
      t.id === tab.id
        ? {
            ...t,
            activePane: pane.id,
            layout: splitLayout(t.layout, source, pane.id, direction),
          }
        : t,
    ),
    activeTab: tab.id,
  }));
  return pane.id;
}
export function patchPane(id: string, patch: Partial<Pane>) {
  useTerminal.setState((s) =>
    s.panes[id]
      ? { panes: { ...s.panes, [id]: { ...s.panes[id], ...patch } } }
      : {},
  );
}
export function removePane(id: string) {
  useTerminal.setState((s) => {
    const panes = { ...s.panes };
    delete panes[id];
    let removedTab = -1;
    const tabs = s.tabs.flatMap((t, index) => {
      if (!layoutGroups(t.layout).includes(id)) {
        return [t];
      }
      const layout = removeLayoutGroup(t.layout, id);
      if (!layout) {
        removedTab = index;
        return [];
      }
      const ids = layoutGroups(layout);
      return [
        {
          ...t,
          layout,
          activePane: t.activePane === id ? ids[0] : t.activePane,
        },
      ];
    });
    return {
      panes,
      tabs,
      activeTab: tabs.some((t) => t.id === s.activeTab)
        ? s.activeTab
        : (tabs[Math.min(Math.max(removedTab, 0), tabs.length - 1)]?.id ??
          null),
    };
  });
}
export function activePane() {
  const s = useTerminal.getState();
  return s.tabs.find((t) => t.id === s.activeTab)?.activePane;
}
export function selectPane(id: string) {
  useTerminal.setState((s) => ({
    tabs: s.tabs.map((t) =>
      layoutGroups(t.layout).includes(id) ? { ...t, activePane: id } : t,
    ),
  }));
}
export function reorderTab(id: string, before: string) {
  useTerminal.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id);
    const tab = s.tabs.find((t) => t.id === id);
    const index = tabs.findIndex((t) => t.id === before);
    if (tab && index >= 0) {
      tabs.splice(index, 0, tab);
    }
    return { tabs };
  });
}
