import { create } from 'zustand';
import type { Doc, Group, Location, Query, SearchMatch, TreeSnapshot, Keybinding } from './types';
import { defaultQuery } from './types';

const initialGroup = (): Group => ({ id: crypto.randomUUID(), tabs: [], active: null, preview: null, views: {} });
const group = initialGroup();
type State = {
  ready: boolean; root: string | null; docs: Record<string, Doc>; groups: Group[]; activeGroup: string;
  sidebar: 'explorer' | 'search' | null; sidebarWidth: number; tree: TreeSnapshot; settings: Record<string, unknown>;
  recent: string[]; history: Location[]; historyIndex: number; cursor: { line: number; column: number; selected: number };
  keybindings: Keybinding[]; dataDir: string;
  quick: string | null; notice: string | null; query: Query; results: SearchMatch[]; searching: boolean; searchErrors: string[];
  limited: boolean; requestId: string | null; searchHistory: string[]; languageStatus: string;
  set: (patch: Partial<State> | ((state: State) => Partial<State>)) => void;
};
export const useApp = create<State>(set => ({
  ready: false, root: null, docs: {}, groups: [group], activeGroup: group.id,
  sidebar: 'explorer', sidebarWidth: 260, tree: { paths: [], git: [], branch: null, warnings: [], truncated: false }, settings: {},
  recent: [], history: [], historyIndex: -1, cursor: { line: 1, column: 1, selected: 0 }, quick: null, notice: null,
  keybindings: [], dataDir: '',
  query: { ...defaultQuery }, results: [], searching: false, searchErrors: [], limited: false, requestId: null, searchHistory: [], languageStatus: 'Plain Text',
  set: patch => set(patch),
}));
export const setApp = (patch: Parameters<State['set']>[0]) => useApp.getState().set(patch);
export const activeDoc = () => { const s = useApp.getState(); const id = s.groups.find(g => g.id === s.activeGroup)?.active; return id ? s.docs[id] : undefined; };
export const notify = (message: string) => setApp({ notice: message });
