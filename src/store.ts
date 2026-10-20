import { create } from 'zustand';
import type { Doc, Group, Location, Query, SearchMatch, TreeSnapshot, Keybinding, QuickPick } from './types';
import { defaultQuery } from './types';
import { layoutGroups, removeLayoutGroup, restoreLayout, type EditorLayout } from './editorLayout';

const initialGroup = (): Group => ({ id: crypto.randomUUID(), tabs: [], active: null, preview: null, views: {} });
const group = initialGroup();
type State = {
  ready: boolean; root: string | null; docs: Record<string, Doc>; groups: Group[]; activeGroup: string;
  editorLayout: EditorLayout | null; groupMru: string[];
  tabRevealRequests: Record<string, number>; // Transient UI requests; excluded from session().
  sidebar: 'explorer' | 'search' | null; sidebarWidth: number; tree: TreeSnapshot; treeRoot: string | null; settings: Record<string, unknown>;
  recent: string[]; history: Location[]; historyIndex: number; cursor: { line: number; column: number; selected: number };
  keybindings: Keybinding[]; dataDir: string;
  quick: string | QuickPick | null; notice: string | null; query: Query; results: SearchMatch[]; searching: boolean; searchErrors: string[];
  limited: boolean; requestId: string | null; searchHistory: string[]; languageStatus: string;
  set: (patch: Partial<State> | ((state: State) => Partial<State>)) => void;
};
export const useApp = create<State>(set => ({
  ready: false, root: null, docs: {}, groups: [group], activeGroup: group.id,
  editorLayout: { type: 'group', id: group.id }, groupMru: [group.id],
  tabRevealRequests: {},
  sidebar: 'explorer', sidebarWidth: 260, tree: { paths: [], git: [], branch: null, warnings: [], truncated: false }, treeRoot: null, settings: {},
  recent: [], history: [], historyIndex: -1, cursor: { line: 1, column: 1, selected: 0 }, quick: null, notice: null,
  keybindings: [], dataDir: '',
  query: { ...defaultQuery }, results: [], searching: false, searchErrors: [], limited: false, requestId: null, searchHistory: [], languageStatus: 'Plain Text',
  set: patch => set(state => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    const groups = next.groups ?? state.groups;
    const ids = groups.map(g => g.id);
    const changed = !!next.groups && (ids.length !== state.groups.length || ids.some((id, i) => id !== state.groups[i].id));
    if (changed || 'editorLayout' in next) {
      let layout = 'editorLayout' in next ? next.editorLayout ?? null : state.editorLayout;
      if (!('editorLayout' in next) && layout) {for (const id of layoutGroups(layout)) {if (!ids.includes(id)) {layout = layout && removeLayoutGroup(layout, id);}}}
      next.editorLayout = ids.length ? restoreLayout(layout, ids) : null;
      if (next.editorLayout) {next.groups = layoutGroups(next.editorLayout).map(id => groups.find(g => g.id === id)!);}
    }
    if (changed || next.activeGroup !== undefined || next.groupMru !== undefined) {
      const mru = [...new Set([...(next.groupMru ?? state.groupMru), ...ids])].filter(id => ids.includes(id));
      const requested = next.activeGroup ?? state.activeGroup;
      const active = ids.includes(requested) ? requested : mru[0] ?? '';
      next.activeGroup = active;
      next.groupMru = active ? [active, ...mru.filter(id => id !== active)] : [];
    }
    return next;
  }),
}));
export const setApp = (patch: Parameters<State['set']>[0]) => useApp.getState().set(patch);
export const activeDoc = () => { const s = useApp.getState(); const id = s.groups.find(g => g.id === s.activeGroup)?.active; return id ? s.docs[id] : undefined; };
export const notify = (message: string) => setApp({ notice: message });
