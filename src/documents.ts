import { monaco, languageFor, loadSyntax } from './monaco';
import { call, desktop, errorMessage } from './bridge';
import { useApp, setApp, notify, activeDoc } from './store';
import { ask } from './dialog';
import type { DiskDocument, Doc, Group, Mirror, Location, Session } from './types';
import { ensureLanguage, releaseLanguageDocument, formatModel, canFormat } from './languages';
import { parseConfiguration } from './settings';

export const models = new Map<string, monaco.editor.ITextModel>();
export const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>();
const savedVersions = new Map<string, number>();
const savedEncodings = new Map<string, string>();
const subscriptions = new Map<string, monaco.IDisposable>();
const saveQueues = new Map<string, Promise<void>>();
let backupTimer: ReturnType<typeof setTimeout>;
let autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
let checkpointQueue = Promise.resolve();
export const basename = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path;
export const normalize = (path: string) => visiblePath(path).replace(/\\/g, '/').toLowerCase();
export const join = (root: string, path: string) => `${root.replace(/[\\/]$/, '')}/${path.replace(/\/$/, '')}`;
export const visiblePath = (path: string) => path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
export const pathTitle = (path: string) => visiblePath(path).replace(/\//g, '\\');
export const relative = (path: string, root = useApp.getState().root) => {
  const value = visiblePath(path).replace(/\\/g, '/'); const base = root ? visiblePath(root).replace(/\\/g, '/') : null;
  return base && value.toLowerCase().startsWith(base.toLowerCase() + '/') ? value.slice(base.length + 1) : value;
};
export const editor = () => editors.get(useApp.getState().activeGroup);
export const model = (id = activeDoc()?.id) => id ? models.get(id) : undefined;

export function patchDoc(id: string, patch: Partial<Doc>) {
  setApp(s => s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], ...patch } } } : {});
}

export function session(): Session {
  const s = useApp.getState();
  for (const g of s.groups) {
    const e = editors.get(g.id);
    if (g.active && e) g.views[g.active] = e.saveViewState();
  }
  return { groups: s.groups, activeGroup: s.activeGroup, sidebar: s.sidebar ?? '', sidebarWidth: s.sidebarWidth, history: s.history, historyIndex: s.historyIndex, query: s.query, searchHistory: s.searchHistory };
}

export async function checkpoint() {
  if (!desktop) return;
  const docs: Mirror[] = Object.values(useApp.getState().docs).flatMap(doc => {
    const m = models.get(doc.id);
    return m ? [{ id: doc.id, path: doc.path, text: m.getValue(), version: doc.version, revision: doc.revision, encoding: doc.encoding, dirty: doc.dirty, language: doc.language, name: doc.name, searchQuery: doc.searchQuery }] : [];
  });
  const currentSession = session();
  checkpointQueue = checkpointQueue.catch(() => {}).then(() => call<void>('sync_documents', { documents: docs, session: currentSession }));
  await checkpointQueue;
}
export function scheduleBackup() { clearTimeout(backupTimer); backupTimer = setTimeout(() => void checkpoint().catch(e => notify(`Backup failed: ${errorMessage(e)}`)), 400); }

export function attachDocument(doc: Doc, text: string, initiallyDirty = false) {
  if (!monaco.languages.getLanguages().some(l => l.id === doc.language)) monaco.languages.register({ id: doc.language });
  const uri = doc.path ? monaco.Uri.file(visiblePath(doc.path)) : monaco.Uri.parse(doc.id);
  const m = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, doc.language, uri);
  models.set(doc.id, m);
  if (!initiallyDirty) { savedVersions.set(doc.id, m.getAlternativeVersionId()); savedEncodings.set(doc.id, doc.encoding); }
  setApp(s => ({ docs: { ...s.docs, [doc.id]: doc } }));
  void loadSyntax(doc.language).then(() => { if (!m.isDisposed() && m.getLanguageId() !== doc.language) monaco.editor.setModelLanguage(m, doc.language); });
  subscriptions.set(doc.id, m.onDidChangeContent(() => {
    const latest = useApp.getState().docs[doc.id];
    if (!latest) return;
    const dirty = savedVersions.get(doc.id) !== m.getAlternativeVersionId() || savedEncodings.get(doc.id) !== latest.encoding;
    patchDoc(doc.id, { dirty, version: latest.version + 1, eol: m.getEOL() === '\r\n' ? 'CRLF' : 'LF' });
    if (dirty) keepOpen(doc.id);
    scheduleBackup();
    clearTimeout(autoTimers.get(doc.id));
    const s = useApp.getState();
    if (s.settings['files.autoSave'] === 'afterDelay' && latest.path && !latest.conflict) {
      autoTimers.set(doc.id, setTimeout(() => void autoSave('afterDelay', doc.id), Number(s.settings['files.autoSaveDelay'] ?? 1000)));
    }
  }));
  scheduleBackup();
  if (!doc.large) void ensureLanguage(doc.id, doc.language);
  return m;
}

export function restoreDocument(mirror: Mirror) {
  const detected = languageFor(mirror.path ?? '');
  // Older sessions stored JSX files as plain TypeScript/JavaScript.
  const language = detected === 'jsonc' || detected === 'typescriptreact' && mirror.language === 'typescript' || detected === 'javascriptreact' && mirror.language === 'javascript' ? detected : mirror.language ?? detected;
  const doc: Doc = { ...mirror, name: mirror.name ?? (mirror.path ? basename(mirror.path) : 'Untitled'), language, eol: mirror.text.includes('\r\n') ? 'CRLF' : 'LF' };
  attachDocument(doc, mirror.text, mirror.dirty);
}

export async function openPath(path: string, options: { pinned?: boolean; group?: string; line?: number; column?: number; background?: boolean; preserveFocus?: boolean; force?: boolean } = {}) {
  const existing = Object.values(useApp.getState().docs).find(d => d.path && normalize(d.path) === normalize(path));
  let id = existing?.id;
  if (!id) {
    let disk: DiskDocument;
    try { disk = await call<DiskDocument>('read_document', { path, force: options.force ?? false }); }
    catch (e) {
      if ((e as { code?: string }).code === 'largeFile' && await ask('Open large file?', errorMessage(e), ['Open Anyway', 'Cancel']) === 'Open Anyway') return openPath(path, { ...options, force: true });
      throw e;
    }
    const duplicate = Object.values(useApp.getState().docs).find(d => d.path && normalize(d.path) === normalize(path));
    if (duplicate) id = duplicate.id;
    else {
      id = monaco.Uri.file(visiblePath(path)).toString();
      const language = languageFor(path);
      attachDocument({ id, path, name: basename(path), language, encoding: disk.encoding, eol: disk.eol, dirty: false, version: 1, revision: disk.revision, large: options.force }, disk.text);
      if (path.endsWith('.code-search')) {
        try { const query = JSON.parse(disk.text.split('\n')[0].replace(/^# Query: /, '')); patchDoc(id, { searchQuery: query }); } catch { notify('This Search Editor file has an invalid query header. Its text is still available for editing.'); }
      }
    }
  }
  showDocument(id, options);
  return id;
}

export function newDocument(text = '', name = 'Untitled', searchQuery?: Doc['searchQuery']) {
  const id = `untitled:${crypto.randomUUID()}`;
  const doc: Doc = { id, path: null, name, language: searchQuery ? 'search-result' : 'plaintext', encoding: 'utf8', eol: 'LF', dirty: !!text, version: 1, revision: null, searchQuery };
  attachDocument(doc, text, !!text);
  showDocument(id, { pinned: true });
  return id;
}

export function keepOpen(id: string, groupId?: string) {
  setApp(s => ({ groups: s.groups.map(g => g.preview === id && (!groupId || g.id === groupId) ? { ...g, preview: null } : g) }));
}

export function normalizeGroup(group: Group): Group {
  const sticky = [...new Set(group.sticky ?? [])].filter(id => group.tabs.includes(id));
  return { ...group, sticky, tabs: [...sticky, ...group.tabs.filter(id => !sticky.includes(id))],
    preview: group.preview && group.tabs.includes(group.preview) && !sticky.includes(group.preview) ? group.preview : null };
}

export function setSticky(id: string, groupId: string, sticky: boolean) {
  setApp(s => ({ groups: s.groups.map(g => {
    if (g.id !== groupId || !g.tabs.includes(id)) return g;
    const pinned = (g.sticky ?? []).filter(t => t !== id);
    if (sticky) pinned.push(id);
    const tabs = g.tabs.filter(t => t !== id);
    tabs.splice(pinned.length - (sticky ? 1 : 0), 0, id);
    return normalizeGroup({ ...g, tabs, sticky: pinned, preview: g.preview === id ? null : g.preview });
  }) }));
  scheduleBackup();
}

export function showDocument(id: string, options: { pinned?: boolean; group?: string; line?: number; column?: number; background?: boolean; preserveFocus?: boolean } = {}) {
  const s = useApp.getState();
  const groupId = options.group ?? s.activeGroup;
  setApp({ groups: s.groups.map(g => {
    if (g.id !== groupId) return g;
    let tabs = [...g.tabs];
    const existing = tabs.includes(id);
    if (!existing && !options.pinned && g.preview && !s.docs[g.preview]?.dirty) tabs = tabs.filter(t => t !== g.preview);
    if (!tabs.includes(id)) tabs.push(id);
    return { ...g, tabs, active: options.background ? g.active : id, preview: options.pinned ? g.preview === id ? null : g.preview : existing ? g.preview : id };
  }), activeGroup: options.background ? s.activeGroup : groupId,
    // Reopening the already active document must also reveal its tab.
    ...(!options.background ? { tabRevealRequests: { ...s.tabRevealRequests, [groupId]: (s.tabRevealRequests[groupId] ?? 0) + 1 } } : {}),
  });
  const visible = new Set(useApp.getState().groups.flatMap(g => g.tabs));
  for (const previous of Object.values(s.docs)) if (previous.id !== id && !previous.dirty && !visible.has(previous.id)) disposeDocument(previous.id);
  if (!options.background) {
    addHistory({ id, line: options.line ?? 1, column: options.column ?? 1 });
    requestAnimationFrame(() => {
      const e = editors.get(groupId);
      if (e && options.line) { e.setPosition({ lineNumber: options.line, column: options.column ?? 1 }); e.revealLineInCenterIfOutsideViewport(options.line); }
      if (!options.preserveFocus) e?.focus();
    });
  }
  scheduleBackup();
}

type AutoSaveMode = 'afterDelay' | 'onFocusChange' | 'onWindowChange';

export async function autoSave(reason: AutoSaveMode, id?: string) {
  const current = useApp.getState().settings['files.autoSave'];
  const mode = reason === 'onWindowChange' && current === 'onFocusChange' ? 'onFocusChange' : reason;
  if (current !== mode) return;
  const ids = reason === 'onWindowChange' ? Object.keys(useApp.getState().docs) : id ? [id] : [];
  for (const documentId of ids) {
    try { await saveDocument(documentId, false, mode); }
    catch (e) { notify(errorMessage(e)); }
  }
}

export async function save(id = activeDoc()?.id, saveAs = false) { await saveDocument(id, saveAs); }

async function saveDocument(id: string | undefined, saveAs: boolean, autoSaveMode?: AutoSaveMode) {
  if (!id) return;
  const previous = saveQueues.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    let doc = useApp.getState().docs[id];
    let m = models.get(id);
    if (!doc || !m) return;
    if (autoSaveMode && (useApp.getState().settings['files.autoSave'] !== autoSaveMode || !doc.path || !doc.dirty || doc.conflict)) return;
    let path = doc.path;
    let revision = doc.revision;
    if (!path || saveAs) {
      path = await call<string | null>('pick_path', { kind: 'save' });
      if (!path) return;
      if (Object.values(useApp.getState().docs).some(other => other.id !== id && other.path && normalize(other.path) === normalize(path!))) throw new Error('This destination is already open in another editor. Close that editor before using Save As.');
      try {
        const disk = await call<DiskDocument>('read_document', { path, force: true });
        if (await ask('Replace existing file?', path, ['Replace', 'Cancel']) !== 'Replace') return;
        revision = disk.revision;
      } catch (e) { if ((e as { code?: string }).code !== 'io') throw e; revision = null; }
    }
    if (useApp.getState().settings['editor.formatOnSave'] === true && canFormat(doc.language)) {
      try { await formatModel(m); } catch (e) { notify(`Formatting failed; saving the current buffer: ${errorMessage(e)}`); }
      doc = useApp.getState().docs[id];
    }
    const version = doc.version;
    const alternativeVersion = m.getAlternativeVersionId();
    try {
      const newRevision = await call<string>('save_document', { id, version, path, text: m.getValue(), encoding: doc.encoding, revision });
      savedVersions.set(id, alternativeVersion);
      savedEncodings.set(id, doc.encoding);
      patchDoc(id, { path, name: basename(path), revision: newRevision, dirty: alternativeVersion !== m.getAlternativeVersionId(), conflict: false, deleted: false });
      if (saveAs || !doc.path) {
        rebindDocument(id, path);
        m = models.get(id)!;
      }
      const s = useApp.getState();
      const shortcuts = normalize(path) === normalize(join(s.dataDir, 'keybindings.json'));
      if (shortcuts || normalize(path) === normalize(join(s.dataDir, 'settings.json')) || s.root && normalize(path) === normalize(join(s.root, '.litecode/settings.json'))) {
        try {
          parseConfiguration(m.getValue(), shortcuts);
          const config = await call<{ settings: Record<string, unknown>; keybindings: import('./types').Keybinding[] | null }>('configuration');
          setApp({ settings: config.settings, keybindings: config.keybindings ?? [] });
        } catch (e) { notify(`Configuration was saved but not activated: ${errorMessage(e)}`); }
      }
      await checkpoint();
    } catch (e) { if ((e as { code?: string }).code === 'conflict') patchDoc(id, { conflict: true }); throw e; }
  });
  saveQueues.set(id, current);
  try { await current; } finally { if (saveQueues.get(id) === current) saveQueues.delete(id); }
}

export async function saveAll() { for (const doc of Object.values(useApp.getState().docs)) if (doc.dirty) await save(doc.id); }

export async function closeDocument(id: string, groupId = useApp.getState().activeGroup): Promise<boolean> {
  const s = useApp.getState();
  if (!s.groups.find(g => g.id === groupId)?.tabs.includes(id)) return true;
  const doc = s.docs[id];
  const otherView = s.groups.some(g => g.id !== groupId && g.tabs.includes(id));
  if (doc?.dirty && !otherView) {
    const answer = await ask(`Save changes to ${doc.name}?`, 'Your changes will be lost if you do not save them.', ['Save', "Don't Save", 'Cancel']);
    if (!answer || answer === 'Cancel') return false;
    if (answer === 'Save') { await save(id); if (useApp.getState().docs[id]?.dirty || !useApp.getState().docs[id]?.path) return false; }
  }
  setApp(s => {
    let groups = s.groups.map(g => {
      if (g.id !== groupId) return g;
      const tabs = g.tabs.filter(t => t !== id);
      return normalizeGroup({ ...g, tabs, active: g.active === id ? tabs[Math.max(0, g.tabs.indexOf(id) - 1)] ?? null : g.active, preview: g.preview === id ? null : g.preview });
    });
    let activeGroup = s.activeGroup;
    const index = groups.findIndex(g => g.id === groupId);
    if (groups.length > 1 && index >= 0 && !groups[index].tabs.length) {
      groups = groups.filter(g => g.id !== groupId);
      if (activeGroup === groupId) activeGroup = groups[Math.max(0, index - 1)].id;
    }
    return { groups, activeGroup };
  });
  if (!useApp.getState().groups.some(g => g.tabs.includes(id))) disposeDocument(id);
  if (s.activeGroup === groupId) requestAnimationFrame(() => editor()?.focus());
  scheduleBackup();
  return true;
}

export type CloseTabsMode = 'others' | 'right' | 'saved' | 'all';
export function tabsToClose(group: Group, id: string, mode: CloseTabsMode): string[] {
  const docs = useApp.getState().docs;
  const targetIndex = group.tabs.indexOf(id);
  return group.tabs.filter((tab, index) => !group.sticky?.includes(tab) &&
    (mode === 'all' || mode === 'others' && tab !== id || mode === 'right' && index > targetIndex || mode === 'saved' && !docs[tab]?.dirty));
}

export async function closeTabs(id: string, groupId: string, mode: CloseTabsMode) {
  const group = useApp.getState().groups.find(g => g.id === groupId);
  if (!group?.tabs.includes(id)) return;
  if (mode === 'others') keepOpen(id, groupId);
  if (mode === 'right' && group.active) keepOpen(group.active, groupId);
  for (const tab of tabsToClose(group, id, mode)) {
    const current = useApp.getState();
    if (current.groups.find(g => g.id === groupId)?.sticky?.includes(tab) || mode === 'saved' && current.docs[tab]?.dirty) continue;
    if (!await closeDocument(tab, groupId)) break;
  }
}

function disposeDocument(id: string) {
  releaseLanguageDocument(id);
  subscriptions.get(id)?.dispose(); subscriptions.delete(id);
  clearTimeout(autoTimers.get(id)); autoTimers.delete(id);
  models.get(id)?.dispose(); models.delete(id); savedVersions.delete(id); savedEncodings.delete(id);
  setApp(s => { const docs = { ...s.docs }; delete docs[id]; return { docs }; });
}

export function splitGroup(groupId = useApp.getState().activeGroup, documentId?: string) {
  const s = useApp.getState(); const source = s.groups.find(g => g.id === groupId)!;
  const id = documentId ?? source.active;
  if (source.active && editors.has(source.id)) source.views[source.active] = editors.get(source.id)!.saveViewState();
  const group: Group = { id: crypto.randomUUID(), tabs: id ? [id] : [], active: id, preview: null, sticky: [], views: id && source.views[id] ? { [id]: source.views[id] } : {} };
  const groups = [...s.groups]; groups.splice(groups.indexOf(source) + 1, 0, group);
  setApp({ groups, activeGroup: group.id }); scheduleBackup();
  requestAnimationFrame(() => editors.get(group.id)?.focus());
  return group.id;
}

export function moveTab(id: string, from: string, to: string, before?: string) {
  setApp(s => {
    const source = s.groups.find(g => g.id === from);
    if (!source?.tabs.includes(id) || !s.groups.some(g => g.id === to)) return {};
    const sticky = source.sticky?.includes(id) ?? false;
    return { groups: s.groups.map(g => {
      if (g.id !== from && g.id !== to) return g;
      const tabs = g.tabs.filter(t => t !== id);
      const pinned = (g.sticky ?? []).filter(t => t !== id);
      if (g.id === to) {
        const index = before && tabs.includes(before) ? tabs.indexOf(before) : tabs.length;
        const target = sticky ? Math.min(index, pinned.length) : Math.max(index, pinned.length);
        tabs.splice(target, 0, id);
        if (sticky) pinned.splice(target, 0, id);
      }
      return normalizeGroup({ ...g, tabs, sticky: pinned, active: g.id === to ? id : g.active === id ? tabs[0] ?? null : g.active, preview: g.preview === id ? null : g.preview });
    }), activeGroup: to };
  }); scheduleBackup();
}

export function addHistory(location: Location) {
  location = { ...location, path: useApp.getState().docs[location.id]?.path ?? location.path };
  setApp(s => {
    const current = s.history[s.historyIndex];
    if (current?.id === location.id && Math.abs(current.line - location.line) < 5) return {};
    const history = [...s.history.slice(0, s.historyIndex + 1), location].slice(-200);
    return { history, historyIndex: history.length - 1 };
  });
}
export async function navigate(direction: number) {
  const s = useApp.getState(); const index = s.historyIndex + direction; const location = s.history[index];
  if (!location) return;
  if (!models.has(location.id)) {
    const uri = monaco.Uri.parse(location.id); const path = location.path ?? (uri.scheme === 'file' ? uri.fsPath : null); if (!path) return;
    const id = await openPath(path, { pinned: true, line: location.line, column: location.column });
    if (id) location.id = id;
  }
  showDocument(location.id, { pinned: true, line: location.line, column: location.column });
  setApp({ history: s.history, historyIndex: index });
}

export async function refreshDocuments() {
  for (const doc of Object.values(useApp.getState().docs)) {
    if (!doc.path) continue;
    try {
      const disk = await call<DiskDocument>('read_document', { path: doc.path, force: true, encoding: doc.encoding });
      const latest = useApp.getState().docs[doc.id];
      if (!latest || disk.revision === latest.revision) continue;
      if (latest.dirty) { patchDoc(doc.id, { conflict: true }); continue; }
      const m = models.get(doc.id); if (!m) continue;
      m.setValue(disk.text); savedVersions.set(doc.id, m.getAlternativeVersionId());
      patchDoc(doc.id, { revision: disk.revision, dirty: false, conflict: false, deleted: false });
    } catch (e) { if ((e as { code?: string }).code === 'io') patchDoc(doc.id, { deleted: true, conflict: true }); }
  }
}

export async function resolveConflict(id: string, action: 'reload' | 'overwrite') {
  const doc = useApp.getState().docs[id]; if (!doc?.path) return;
  let disk: DiskDocument;
  try { disk = await call('read_document', { path: doc.path, force: true, encoding: doc.encoding }); }
  catch (e) { if (action === 'overwrite' && doc.deleted) { patchDoc(id, { revision: null }); await save(id); return; } throw e; }
  if (action === 'reload') {
    const m = models.get(id)!; m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text: disk.text }], () => null); m.pushStackElement();
    savedVersions.set(id, m.getAlternativeVersionId()); patchDoc(id, { dirty: false, revision: disk.revision, conflict: false, deleted: false });
  } else { patchDoc(id, { revision: disk.revision }); await save(id); }
  scheduleBackup();
}

export async function renameDocumentPaths(from: string, to: string) {
  for (const doc of Object.values(useApp.getState().docs)) {
    if (!doc.path || !(normalize(doc.path) === normalize(from) || normalize(doc.path).startsWith(normalize(from) + '/'))) continue;
    const path = to + doc.path.slice(from.length);
    rebindDocument(doc.id, path);
  }
  await checkpoint();
}

function rebindDocument(id: string, path: string) {
  const doc = useApp.getState().docs[id]; const old = models.get(id); if (!doc || !old) return;
  const uri = monaco.Uri.file(visiblePath(path)); if (old.uri.toString() === uri.toString()) return;
  const views = [...editors.values()].filter(e => e.getModel() === old).map(e => ({ e, view: e.saveViewState() }));
  const text = old.getValue(); releaseLanguageDocument(id); subscriptions.get(id)?.dispose(); subscriptions.delete(id);
  savedVersions.delete(id); savedEncodings.delete(id);
  const next = attachDocument({ ...doc, path, name: basename(path), language: languageFor(path), deleted: false }, text, doc.dirty);
  setApp(s => ({ history: s.history.map(location => location.id === id ? { ...location, path } : location) }));
  for (const { e, view } of views) { e.setModel(next); if (view) e.restoreViewState(view); }
  old.dispose();
}
