import { useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { bootstrap, call, desktop, errorMessage } from './bridge';
import { initializeEditor, monaco } from './monaco';
import { useApp, setApp, notify, activeDoc } from './store';
import { checkpoint, restoreDocument, refreshDocuments, basename, editor, models, patchDoc, scheduleBackup } from './documents';
import { commands, execute, installKeys, openFolder } from './commands';
import { Explorer, refreshTree } from './Explorer';
import { SearchView } from './SearchView';
import { EditorGroup } from './EditorGroup';
import { QuickOpen } from './QuickOpen';
import { DialogHost, input } from './dialog';
import { DiffViewer } from './DiffViewer';
import { Icon, IconButton } from './ui';
import './App.css';
import { initializeLanguages } from './languages';

let startup: Promise<void> | undefined;
function start() {
  return startup ??= (async () => {
    await initializeEditor();
    initializeLanguages();
    const boot = await bootstrap();
    setApp({ root: boot.root, settings: boot.settings, recent: boot.recent, dataDir: boot.dataDir, keybindings: boot.keybindings ?? [] });
    for (const mirror of boot.documents) restoreDocument(mirror);
    const session = boot.session;
    if (session.query) setApp({ query: session.query, searchHistory: session.searchHistory ?? [] });
    const valid = session.groups?.map(g => ({ ...g, tabs: g.tabs.filter(id => models.has(id)), active: g.active && models.has(g.active) ? g.active : g.tabs.find(id => models.has(id)) ?? null, views: g.views ?? {} }));
    setApp({ ready: true, ...(valid?.length ? { groups: valid, activeGroup: session.activeGroup && valid.some(g => g.id === session.activeGroup) ? session.activeGroup : valid[0].id } : {}), sidebarWidth: session.sidebarWidth ?? 260, sidebar: session.sidebar === 'search' ? 'search' : 'explorer', history: session.history ?? [], historyIndex: session.historyIndex ?? -1 });
    if (boot.warnings.length) notify(boot.warnings.join('\n'));
    if (boot.root) await refreshTree();
    await refreshDocuments();
  })();
}

export default function App() {
  const s = useApp(); const [fatal, setFatal] = useState<string | null>(null); const [maximized, setMaximized] = useState(false);
  const [diagnostics, setDiagnostics] = useState({ errors: 0, warnings: 0 });
  useEffect(() => { void start().catch(e => setFatal(errorMessage(e))); return installKeys(); }, []);
  useEffect(() => {
    if (!s.ready) return;
    const markers = monaco.editor.onDidChangeMarkers(() => { const all = monaco.editor.getModelMarkers({}); setDiagnostics({ errors: all.filter(m => m.severity === monaco.MarkerSeverity.Error).length, warnings: all.filter(m => m.severity === monaco.MarkerSeverity.Warning).length }); });
    return () => markers.dispose();
  }, [s.ready]);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false; const cleanups: (() => void)[] = [];
    void (async () => {
      const onChange = await listen('workspace-changed', () => { void refreshTree(); void refreshDocuments(); });
      if (disposed) onChange(); else cleanups.push(onChange);
      const onConfig = await listen('configuration-changed', () => { void call<{ settings: Record<string, unknown>; keybindings: import('./types').Keybinding[] | null }>('configuration').then(config => setApp({ settings: config.settings, keybindings: config.keybindings ?? [] })).catch(e => notify(errorMessage(e))); });
      if (disposed) onConfig(); else cleanups.push(onConfig);
      const win = getCurrentWindow();
      const onClose = await win.onCloseRequested(async event => { event.preventDefault(); try { await checkpoint(); await win.destroy(); } catch (e) { notify(`Could not save recovery data. Window remains open: ${errorMessage(e)}`); } });
      if (disposed) onClose(); else cleanups.push(onClose);
    })().catch(e => notify(errorMessage(e)));
    return () => { disposed = true; cleanups.forEach(fn => fn()); };
  }, []);
  const doc = s.docs[s.groups.find(g => g.id === s.activeGroup)?.active ?? ''];
  useEffect(() => { if (desktop) void getCurrentWindow().setTitle(`${doc?.dirty ? '● ' : ''}${doc?.name ? `${doc.name} — ` : ''}${s.root ? `${basename(s.root)} — ` : ''}LiteCode`); }, [doc?.name, doc?.dirty, s.root]);
  function windowAction(action: 'minimize' | 'maximize' | 'close') {
    if (!desktop) return; const win = getCurrentWindow();
    if (action === 'minimize') void win.minimize();
    if (action === 'maximize') void win.toggleMaximize().then(() => win.isMaximized()).then(setMaximized);
    if (action === 'close') void win.close();
  }
  function resize(e: React.PointerEvent) {
    const start = e.clientX; const width = s.sidebarWidth; e.currentTarget.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => setApp({ sidebarWidth: Math.min(window.innerWidth * 0.65, Math.max(170, width + event.clientX - start)) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); scheduleBackup(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  return <div className="workbench">
    <header className="titlebar" data-tauri-drag-region onDoubleClick={e => { if (e.target === e.currentTarget) windowAction('maximize'); }}>
      <div className="app-mark" aria-label="LiteCode"><Icon name="code" /></div>
      <nav className="menubar" aria-label="Application menu">{['File', 'Edit', 'Selection', 'View', 'Go', 'Help'].map(menu => <Menu.Root key={menu}><Menu.Trigger>{menu}</Menu.Trigger><Menu.Portal><Menu.Positioner className="z-90" side="bottom" align="start" sideOffset={0}><Menu.Popup className="context-menu application-menu">{commands.filter(c => c.menu === menu).map(c => <Menu.Item key={c.id} onClick={() => void execute(c.id)}><span>{c.label}</span>{c.key && <kbd>{c.key}</kbd>}</Menu.Item>)}</Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>)}</nav>
      <div className="title-center" data-tauri-drag-region><IconButton icon="arrow-left" label="Go Back (Alt+Left)" onClick={() => void execute('workbench.action.navigateBack')} disabled={s.historyIndex <= 0} /><IconButton icon="arrow-right" label="Go Forward (Alt+Right)" onClick={() => void execute('workbench.action.navigateForward')} disabled={s.historyIndex >= s.history.length - 1} /><button className="command-center" onClick={() => setApp({ quick: '' })}><Icon name="search" /><span>{s.root ? basename(s.root) : 'LiteCode'}</span></button></div>
      <div className="title-layout"><IconButton icon="layout-sidebar-left" label="Toggle Primary Side Bar" onClick={() => void execute('workbench.action.toggleSidebarVisibility')} /><IconButton icon="layout" label="Split Editor Right" onClick={() => void execute('workbench.action.splitEditorRight')} /></div>
      <div className="window-controls"><button aria-label="Minimize" onClick={() => windowAction('minimize')}><Icon name="chrome-minimize" /></button><button aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => windowAction('maximize')}><Icon name={maximized ? 'chrome-restore' : 'chrome-maximize'} /></button><button className="window-close" aria-label="Close Window" onClick={() => windowAction('close')}><Icon name="chrome-close" /></button></div>
    </header>
    <div className="workbench-body">
      <nav className="activitybar" aria-label="Views"><div><button className={s.sidebar === 'explorer' ? 'active' : ''} aria-label="Explorer (Ctrl+Shift+E)" title="Explorer (Ctrl+Shift+E)" onClick={() => setApp({ sidebar: s.sidebar === 'explorer' ? null : 'explorer' })}><Icon name="files" /></button><button className={s.sidebar === 'search' ? 'active' : ''} aria-label="Search (Ctrl+Shift+F)" title="Search (Ctrl+Shift+F)" onClick={() => void execute('workbench.action.findInFiles')}><Icon name="search" /></button></div><button title="Manage" aria-label="Manage" onClick={() => setApp({ quick: '>Preferences:' })}><Icon name="settings-gear" /></button></nav>
      {s.ready && <><aside className="sidebar" style={{ width: s.sidebar ? s.sidebarWidth : 0, display: s.sidebar ? 'flex' : 'none' }}><div className="sidebar-view" hidden={s.sidebar !== 'explorer'}><Explorer openFolder={() => void openFolder().catch(e => notify(errorMessage(e)))} /></div><div className="sidebar-view" hidden={s.sidebar !== 'search'}><SearchView /></div></aside>{s.sidebar && <div className="sidebar-resizer" role="separator" aria-label="Primary side bar width" aria-orientation="vertical" aria-valuenow={s.sidebarWidth} tabIndex={0} onPointerDown={resize} onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setApp({ sidebarWidth: Math.max(170, s.sidebarWidth + (e.key === 'ArrowRight' ? 10 : -10)) }); } }} />}<main className="editors" aria-label="Editors">{s.groups.map(group => <EditorGroup key={group.id} group={group} />)}</main></>}
      {!s.ready && <div className="startup" role="status">{fatal ? <><Icon name="error" /><p>{fatal}</p><button onClick={() => location.reload()}>Reload</button></> : <><span className="spinner" /><p>Starting editor services…</p></>}</div>}
    </div>
    <footer className="statusbar"><div className="status-left"><span className="remote-indicator" title="Local window"><Icon name="remote" /></span>{s.tree.branch && <span className="status-item" title="Current Git branch"><Icon name="source-control" />{s.tree.branch}</span>}<button title="Show Problems" onClick={() => void editor()?.getAction('editor.action.marker.next')?.run()}><Icon name="error" />{diagnostics.errors}<Icon name="warning" />{diagnostics.warnings}</button></div><div className="status-right">{doc && <><button onClick={() => setApp({ quick: ':' })}>Ln {s.cursor.line}, Col {s.cursor.column}{s.cursor.selected ? ` (${s.cursor.selected} selected)` : ''}</button><button onClick={() => void changeIndent()}>Spaces: {String(s.settings['editor.tabSize'] ?? 4)}</button><button onClick={() => void changeEncoding()}>{doc.encoding.toUpperCase().replace('UTF8', 'UTF-8')}</button><button onClick={() => { const m = models.get(doc.id); if (m) m.pushEOL(doc.eol === 'LF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF); }}>{doc.eol}</button><button onClick={() => void execute('litecode.setLanguage')}>{doc.language === 'plaintext' ? 'Plain Text' : doc.language}</button></>}{s.searching && <span>Searching…</span>}<span className="status-item" title={s.languageStatus}><Icon name="check" /></span><button title="Notifications" onClick={() => notify(s.notice ?? 'No new notifications.')} aria-label="Notifications"><Icon name="bell" /></button></div></footer>
    {s.notice && <div className="notification" role="status"><Icon name="info" /><p>{s.notice}</p><IconButton icon="close" label="Dismiss Notification" onClick={() => setApp({ notice: null })} /></div>}
    {s.ready && <><QuickOpen /><DiffViewer /></>}<DialogHost />
  </div>;
}
async function changeEncoding() { const doc = activeDoc(); if (!doc) return; const encoding = await input('Save with Encoding: utf8, utf8bom, utf16le, utf16be, gbk', doc.encoding); if (encoding && ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'gbk'].includes(encoding)) patchDoc(doc.id, { encoding, dirty: true }); }
async function changeIndent() { const value = await input('Tab Size', String(useApp.getState().settings['editor.tabSize'] ?? 4)); if (value && Number(value) >= 1 && Number(value) <= 16) setApp(s => ({ settings: { ...s.settings, 'editor.tabSize': Number(value) } })); }
