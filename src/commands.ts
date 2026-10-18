import { call, errorMessage } from './bridge';
import { activeDoc, useApp, setApp, notify } from './store';
import { checkpoint, closeDocument, editor, models, navigate, newDocument, openPath, save, saveAll, showDocument, splitGroup, scheduleBackup, join } from './documents';
import { refreshTree } from './Explorer';
import { createSearchEditor, undoReplacement, nextSearchResult } from './search';
import { input } from './dialog';
import { restartLanguages, languageReport } from './languages';
import { normalizeKey, resolveBinding } from './keybindings';
import { completeSettings, parseConfiguration, updateSetting } from './settings';

export type Command = { id: string; label: string; key?: string; menu?: string; run: () => unknown };
export function quick(value: string) { setApp({ quick: value }); }
export async function openFolder(newWindow = false, recentPath?: string) {
  const path = recentPath ?? await call<string | null>('pick_path', { kind: 'folder' }); if (!path) return;
  await checkpoint();
  const same = await call<boolean>('open_workspace', { path, newWindow });
  if (same) { setApp({ root: path }); await refreshTree(); }
}
export async function openFile() {
  const path = await call<string | null>('pick_path', { kind: 'file' }); if (path) await openPath(path, { pinned: true });
}
function action(id: string) { return () => editor()?.getAction(id)?.run(); }
function trigger(id: string) { return () => editor()?.trigger('keyboard', id, null); }
async function openSettings() {
  const id = await openPath(await call<string>('settings_path', { kind: 'settings' }), { pinned: true });
  if (!id) return;
  const m = models.get(id)!; const text = completeSettings(m.getValue());
  if (text !== m.getValue()) {
    m.pushStackElement(); m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null); m.pushStackElement();
  }
  return id;
}
export const commands: Command[] = [
  { id: 'litecode.installNode', label: 'Language Tools: Install Verified Node.js Runtime', run: async () => { notify('Downloading and verifying Node.js 24.12.0…'); const result = await call<string>('install_tools', { kind: 'node' }); await restartLanguages(); notify(result); } },
  { id: 'litecode.installLanguages', label: 'Language Tools: Install JavaScript/TypeScript Tools', run: async () => { notify('Installing pinned language tools and Prettier. Package integrity will be verified…'); const result = await call<string>('install_tools', { kind: 'languages' }); await restartLanguages(); notify(result); } },
  { id: 'litecode.restartLanguages', label: 'Language: Restart Language Services', run: restartLanguages },
  { id: 'litecode.languageStatus', label: 'Language: Show Service Status', run: () => notify(JSON.stringify(languageReport(), null, 2)) },
  { id: 'litecode.toolStatus', label: 'Language Tools: Show Tool Paths', run: async () => notify(JSON.stringify(await call('tool_status'), null, 2)) },
  { id: 'workbench.action.files.newUntitledFile', label: 'New Text File', key: 'Ctrl+N', menu: 'File', run: () => newDocument() },
  { id: 'workbench.action.files.openFile', label: 'Open File…', key: 'Ctrl+O', menu: 'File', run: openFile },
  { id: 'workbench.action.files.openFolder', label: 'Open Folder…', key: 'Ctrl+K Ctrl+O', menu: 'File', run: () => openFolder() },
  { id: 'litecode.openFolderInNewWindow', label: 'Open Folder in New Window…', menu: 'File', run: () => openFolder(true) },
  { id: 'workbench.action.openRecent', label: 'Open Recent…', key: 'Ctrl+R', menu: 'File', run: () => quick('recent ') },
  { id: 'workbench.action.files.save', label: 'Save', key: 'Ctrl+S', menu: 'File', run: () => save() },
  { id: 'workbench.action.files.saveAs', label: 'Save As…', key: 'Ctrl+Shift+S', menu: 'File', run: () => save(activeDoc()?.id, true) },
  { id: 'workbench.action.files.saveAll', label: 'Save All', key: 'Ctrl+K S', menu: 'File', run: saveAll },
  { id: 'workbench.action.closeActiveEditor', label: 'Close Editor', key: 'Ctrl+W', menu: 'File', run: () => { const id = activeDoc()?.id; if (id) return closeDocument(id); } },
  { id: 'workbench.action.toggleAutoSave', label: 'Toggle Auto Save', menu: 'File', run: async () => {
    const s = useApp.getState(); const enabled = ['afterDelay', 'onFocusChange', 'onWindowChange'].some(mode => s.settings['files.autoSave'] === mode);
    const id = await openSettings();
    if (id) { const m = models.get(id)!; m.pushEditOperations([], [{ range: m.getFullModelRange(), text: updateSetting(m.getValue(), 'files.autoSave', enabled ? 'off' : 'afterDelay') }], () => null); await save(id); }
  } },
  { id: 'undo', label: 'Undo', key: 'Ctrl+Z', menu: 'Edit', run: trigger('undo') },
  { id: 'redo', label: 'Redo', key: 'Ctrl+Y', menu: 'Edit', run: trigger('redo') },
  { id: 'editor.action.clipboardCutAction', label: 'Cut', key: 'Ctrl+X', menu: 'Edit', run: trigger('editor.action.clipboardCutAction') },
  { id: 'editor.action.clipboardCopyAction', label: 'Copy', key: 'Ctrl+C', menu: 'Edit', run: trigger('editor.action.clipboardCopyAction') },
  { id: 'editor.action.clipboardPasteAction', label: 'Paste', key: 'Ctrl+V', menu: 'Edit', run: trigger('editor.action.clipboardPasteAction') },
  { id: 'actions.find', label: 'Find', key: 'Ctrl+F', menu: 'Edit', run: action('actions.find') },
  { id: 'editor.action.startFindReplaceAction', label: 'Replace', key: 'Ctrl+H', menu: 'Edit', run: action('editor.action.startFindReplaceAction') },
  { id: 'workbench.action.findInFiles', label: 'Find in Files', key: 'Ctrl+Shift+F', menu: 'Edit', run: () => { setApp({ sidebar: 'search' }); setTimeout(() => window.dispatchEvent(new Event('focus-search')), 0); } },
  { id: 'litecode.undoReplace', label: 'Undo Workspace Replacement', menu: 'Edit', run: () => undoReplacement() },
  { id: 'litecode.redoReplace', label: 'Redo Workspace Replacement', menu: 'Edit', run: () => undoReplacement(true) },
  { id: 'editor.action.selectAll', label: 'Select All', key: 'Ctrl+A', menu: 'Selection', run: trigger('editor.action.selectAll') },
  { id: 'editor.action.smartSelect.expand', label: 'Expand Selection', key: 'Shift+Alt+Right', menu: 'Selection', run: action('editor.action.smartSelect.expand') },
  { id: 'editor.action.smartSelect.shrink', label: 'Shrink Selection', key: 'Shift+Alt+Left', menu: 'Selection', run: action('editor.action.smartSelect.shrink') },
  { id: 'editor.action.addSelectionToNextFindMatch', label: 'Add Next Occurrence', key: 'Ctrl+D', menu: 'Selection', run: action('editor.action.addSelectionToNextFindMatch') },
  { id: 'editor.action.selectHighlights', label: 'Select All Occurrences', key: 'Ctrl+Shift+L', menu: 'Selection', run: action('editor.action.selectHighlights') },
  { id: 'workbench.action.showCommands', label: 'Command Palette…', key: 'Ctrl+Shift+P', menu: 'View', run: () => quick('>') },
  { id: 'workbench.view.explorer', label: 'Explorer', key: 'Ctrl+Shift+E', menu: 'View', run: () => setApp({ sidebar: 'explorer' }) },
  { id: 'workbench.action.toggleSidebarVisibility', label: 'Toggle Primary Side Bar', key: 'Ctrl+B', menu: 'View', run: () => setApp({ sidebar: useApp.getState().sidebar ? null : 'explorer' }) },
  { id: 'workbench.action.splitEditorRight', label: 'Split Editor Right', key: 'Ctrl+\\', menu: 'View', run: splitGroup },
  { id: 'editor.action.toggleWordWrap', label: 'Toggle Word Wrap', key: 'Alt+Z', menu: 'View', run: () => setApp(s => ({ settings: { ...s.settings, 'editor.wordWrap': s.settings['editor.wordWrap'] === 'on' ? 'off' : 'on' } })) },
  { id: 'workbench.action.navigateBack', label: 'Back', key: 'Alt+Left', menu: 'Go', run: () => navigate(-1) },
  { id: 'workbench.action.navigateForward', label: 'Forward', key: 'Alt+Right', menu: 'Go', run: () => navigate(1) },
  { id: 'workbench.action.quickOpen', label: 'Go to File…', key: 'Ctrl+P', menu: 'Go', run: () => quick('') },
  { id: 'workbench.action.gotoLine', label: 'Go to Line/Column…', key: 'Ctrl+G', menu: 'Go', run: () => quick(':') },
  { id: 'search.action.focusNextSearchResult', label: 'Go to Next Search Result', key: 'F4', menu: 'Go', run: () => nextSearchResult() },
  { id: 'search.action.focusPreviousSearchResult', label: 'Go to Previous Search Result', key: 'Shift+F4', menu: 'Go', run: () => nextSearchResult(-1) },
  { id: 'editor.action.quickOutline', label: 'Go to Symbol in Editor…', key: 'Ctrl+Shift+O', menu: 'Go', run: () => quick('@') },
  { id: 'editor.action.revealDefinition', label: 'Go to Definition', key: 'F12', menu: 'Go', run: action('editor.action.revealDefinition') },
  { id: 'editor.action.goToReferences', label: 'Go to References', key: 'Shift+F12', menu: 'Go', run: action('editor.action.goToReferences') },
  { id: 'editor.action.rename', label: 'Rename Symbol', key: 'F2', run: action('editor.action.rename') },
  { id: 'editor.action.formatDocument', label: 'Format Document', key: 'Shift+Alt+F', run: action('editor.action.formatDocument') },
  { id: 'search.action.openNewEditor', label: 'New Search Editor', run: () => createSearchEditor() },
  { id: 'workbench.action.quickTextSearch', label: 'Quick Search…', run: () => quick('%') },
  { id: 'workbench.action.openSettingsJson', label: 'Preferences: Open User Settings (JSON)', run: openSettings },
  { id: 'workbench.action.openGlobalKeybindingsFile', label: 'Preferences: Open Keyboard Shortcuts (JSON)', run: async () => openPath(await call('settings_path', { kind: 'keybindings' }), { pinned: true }) },
  { id: 'litecode.importSettings', label: 'Preferences: Review VS Code Settings Import', run: async () => {
    const root = useApp.getState().root; if (!root) throw new Error('Open a workspace containing .vscode/settings.json first.');
    const disk = await call<{ text: string }>('read_document', { path: join(root, '.vscode/settings.json') });
    const settings = parseConfiguration(disk.text);
    const { settingsSchemas } = await import('./languages'); const keys = new Set(Object.keys(settingsSchemas()[0].schema.properties));
    const supported = Object.fromEntries(Object.entries(settings).filter(([key]) => keys.has(key)));
    const ignored = Object.keys(settings).filter(key => !keys.has(key));
    newDocument(`# VS Code settings import review\n\nCopy the supported settings below into Preferences: Open User Settings (JSON), or .litecode/settings.json.\n\nThe original .vscode/settings.json remains unchanged.\n\nSupported:\n\n\x60\x60\x60json\n${JSON.stringify(supported, null, 2)}\n\x60\x60\x60\n\nIgnored settings:\n${ignored.map(key => `- ${key}`).join('\n') || '(none)'}\n`, 'Settings Import.md');
  } },
  { id: 'litecode.setLanguage', label: 'Change Language Mode', run: async () => {
    const doc = activeDoc(); if (!doc) return; const value = await input('Language identifier', doc.language); if (!value) return;
    const { monaco, loadSyntax } = await import('./monaco'); await loadSyntax(value); const m = models.get(doc.id); if (m) monaco.editor.setModelLanguage(m, value);
    setApp(s => ({ docs: { ...s.docs, [doc.id]: { ...doc, language: value } } }));
  } },
  { id: 'litecode.about', label: 'About LiteCode', menu: 'Help', run: () => notify('LiteCode 0.1.0 · Tauri 2 / React / Monaco\nWindows x64 · Dark Modern\nSee docs/verification/MATRIX.md for implementation and verification status.') },
];
export async function execute(id: string) {
  const command = commands.find(c => c.id === id); if (!command) { notify(`Unknown command: ${id}`); return; }
  try { await command.run(); scheduleBackup(); } catch (e) { notify(errorMessage(e)); }
}

let chord = '';
export function installKeys() {
  function handler(e: KeyboardEvent) {
    if (e.isComposing || useApp.getState().quick !== null || document.querySelector('.modal-panel, .diff-panel')) return;
    const target = e.target as HTMLElement;
    const typing = ['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.closest('.monaco-editor');
    const key = `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.key.length === 1 ? e.key.toUpperCase() : ({ ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' } as Record<string, string>)[e.key] ?? e.key}`;
    const state = useApp.getState(); const doc = activeDoc();
    const context = { editorTextFocus: !!target.closest('.monaco-editor'), editorFocus: !!target.closest('.editor-group'), inputFocus: typing,
      textInputFocus: typing || !!target.closest('.monaco-editor'), explorerViewletFocus: !!target.closest('.explorer-view'),
      searchViewletFocus: !!target.closest('.search-view'), resourceLangId: doc?.language ?? '', resourceScheme: doc?.path ? 'file' : 'untitled',
      editorHasSelection: state.cursor.selected > 0, workspaceFolderCount: state.root ? '1' : '0', isWindows: true };
    const sequence = normalizeKey(chord ? `${chord} ${key}` : key);
    const binding = resolveBinding(state.keybindings, sequence, context);
    const defaults = commands.filter(c => c.key && !binding.removed.has(c.id));
    const wasChord = !!chord; chord = '';
    if (binding.prefix || !typing && defaults.some(c => normalizeKey(c.key!).startsWith(`${sequence} `))) {
      e.preventDefault(); e.stopPropagation(); chord = sequence;
      setTimeout(() => { if (chord === sequence) chord = ''; }, 3000); return;
    }
    if (binding.command || wasChord) {
      const id = binding.command ?? defaults.find(c => normalizeKey(c.key!) === sequence)?.id;
      e.preventDefault(); e.stopPropagation(); if (id) void execute(id); return;
    }
    // Text-editing shortcuts belong to Monaco or the focused input, preserving its context rules.
    const global = defaults.filter(c => !['Edit', 'Selection'].includes(c.menu ?? '') && !['F2', 'F12', 'Shift+F12', 'Shift+Alt+F'].includes(c.key!));
    const command = global.find(c => normalizeKey(c.key!) === sequence)?.id ?? (key === 'Ctrl+Shift+F' && !binding.removed.has('workbench.action.findInFiles') ? 'workbench.action.findInFiles' : undefined);
    if (command && (!typing || ['Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+Shift+P', 'Ctrl+P', 'Ctrl+Shift+F', 'Ctrl+O'].includes(key))) { e.preventDefault(); e.stopPropagation(); void execute(command); }
    if (key === 'Ctrl+Tab' && !typing) {
      e.preventDefault(); e.stopPropagation(); const s = useApp.getState(); const g = s.groups.find(g => g.id === s.activeGroup)!;
      const id = g.tabs[(g.tabs.indexOf(g.active ?? '') + 1) % g.tabs.length]; if (id) showDocument(id);
    }
  }
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
