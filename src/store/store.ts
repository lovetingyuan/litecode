import { create } from "zustand";
import type {
  Doc,
  Group,
  Location,
  SearchSession,
  GitSnapshot,
  Keybinding,
  QuickPick,
} from "../types/types";
import { defaultQuery } from "../types/types";
import {
  layoutGroups,
  removeLayoutGroup,
  restoreLayout,
  type EditorLayout,
} from "../editor/editorLayout";

const initialGroup = (): Group => ({
  id: crypto.randomUUID(),
  tabs: [],
  active: null,
  preview: null,
  views: {},
});
const group = initialGroup();
export const primarySearchId = "search";
export const initialSearch = (id = primarySearchId, number = 1): SearchSession => ({
  id,
  number,
  query: { ...defaultQuery },
  results: [],
  searching: false,
  searchErrors: [],
  limited: false,
  requestId: null,
});
type State = {
  ready: boolean;
  openingWorkspace: string | null; // Empty until the native picker returns a path.
  root: string | null;
  docs: Record<string, Doc>;
  groups: Group[];
  activeGroup: string;
  editorLayout: EditorLayout | null;
  groupMru: string[];
  tabRevealRequests: Record<string, number>; // Transient UI requests; excluded from session().
  sidebar: "explorer" | "search" | "git" | null;
  gitRepository: string | null;
  gitTab: "changes" | "info";
  gitLayout: "list" | "tree";
  gitBusy: Record<string, string>;
  gitMessages: Record<string, string>;
  view: "editor" | "terminal";
  sidebarWidth: number;
  gitState: GitSnapshot;
  fileIndexVersion: number;
  workspaceEpoch: number;
  treeRoot: string | null;
  settings: Record<string, unknown>;
  recent: string[];
  history: Location[];
  historyIndex: number;
  cursor: { line: number; column: number; selected: number };
  keybindings: Keybinding[];
  dataDir: string;
  quick: string | QuickPick | null;
  notice: string | null;
  noticeLink: string | null;
  searchSessions: SearchSession[];
  activeSearchId: string;
  nextSearchNumber: number;
  searchHistory: string[];
  replacementPhase: "planning" | "applying" | null;
  languageStatus: string;
  set: (patch: Partial<State> | ((state: State) => Partial<State>)) => void;
};
export const useApp = create<State>((set) => ({
  ready: false,
  openingWorkspace: null,
  root: null,
  docs: {},
  groups: [group],
  activeGroup: group.id,
  editorLayout: { type: "group", id: group.id },
  groupMru: [group.id],
  tabRevealRequests: {},
  sidebar: "explorer",
  gitRepository: null,
  gitTab: "changes",
  gitLayout: "list",
  gitBusy: {},
  gitMessages: {},
  view: "editor",
  sidebarWidth: 260,
  gitState: { root: null, session: null, git: [], branch: null, warnings: [] },
  fileIndexVersion: 0,
  workspaceEpoch: 0,
  treeRoot: null,
  settings: {},
  recent: [],
  history: [],
  historyIndex: -1,
  cursor: { line: 1, column: 1, selected: 0 },
  quick: null,
  notice: null,
  noticeLink: null,
  keybindings: [],
  dataDir: "",
  searchSessions: [initialSearch()],
  activeSearchId: primarySearchId,
  nextSearchNumber: 2,
  searchHistory: [],
  replacementPhase: null,
  languageStatus: "Plain Text",
  set: (patch) =>
    set((state) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      const groups = next.groups ?? state.groups;
      const ids = groups.map((g) => g.id);
      const changed =
        !!next.groups &&
        (ids.length !== state.groups.length || ids.some((id, i) => id !== state.groups[i].id));
      if (changed || "editorLayout" in next) {
        let layout = "editorLayout" in next ? (next.editorLayout ?? null) : state.editorLayout;
        if (!("editorLayout" in next) && layout) {
          for (const id of layoutGroups(layout)) {
            if (!ids.includes(id)) {
              layout = layout && removeLayoutGroup(layout, id);
            }
          }
        }
        next.editorLayout = ids.length ? restoreLayout(layout, ids) : null;
        if (next.editorLayout) {
          next.groups = layoutGroups(next.editorLayout).map((id) =>
            groups.find((g) => g.id === id)!,
          );
        }
      }
      if (changed || next.activeGroup !== undefined || next.groupMru !== undefined) {
        const mru = [...new Set([...(next.groupMru ?? state.groupMru), ...ids])].filter((id) =>
          ids.includes(id),
        );
        const requested = next.activeGroup ?? state.activeGroup;
        const active = ids.includes(requested) ? requested : (mru[0] ?? "");
        next.activeGroup = active;
        next.groupMru = active ? [active, ...mru.filter((id) => id !== active)] : [];
      }
      return next;
    }),
}));
export const setApp = (patch: Parameters<State["set"]>[0]) => useApp.getState().set(patch);
export const searchSession = (id = useApp.getState().activeSearchId) =>
  useApp.getState().searchSessions.find((search) => search.id === id);
export function patchSearch(id: string, patch: Partial<SearchSession>) {
  setApp((s) => ({
    searchSessions: s.searchSessions.map((search) =>
      search.id === id ? { ...search, ...patch } : search,
    ),
  }));
}
export const activeDoc = () => {
  const s = useApp.getState();
  const id = s.groups.find((g) => g.id === s.activeGroup)?.active;
  return id ? s.docs[id] : undefined;
};
export const notify = (message: string) => setApp({ notice: message, noticeLink: null });
