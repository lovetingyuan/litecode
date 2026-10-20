import { useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { bootstrap, call, desktop, errorMessage } from './bridge';
import { initializeEditor, monaco } from './monaco';
import { useApp, setApp, notify } from './store';
import { checkpoint, restoreDocument, refreshDocuments, basename, editor, autoSave, normalizeGroup } from './documents';
import { commands, execute, installKeys, openFolder } from './commands';
import { Explorer, refreshTree } from './Explorer';
import { SearchView } from './SearchView';
import { EditorLayoutView, WorkbenchLayout } from './EditorGrid';
import { WelcomePage } from './WelcomePage';
import { QuickOpen } from './QuickOpen';
import { DialogHost } from './dialog';
import { DiffViewer } from './DiffViewer';
import { Icon, IconButton } from './ui';
import './App.css';
import { initializeLanguages } from './languages';
import { isTextView } from './media';
import { MediaStatus } from './MediaStatus';
import { useExternalDrop } from './useExternalDrop';
import { changeIndent, changeEncoding, changeEol } from './editorStatus';

let startup: Promise<void> | undefined;
function start() {
  return startup ??= (async () => {
    await initializeEditor();
    initializeLanguages();
    const boot = await bootstrap();
    setApp({ root: boot.root, settings: boot.settings, recent: boot.recent, dataDir: boot.dataDir, keybindings: boot.keybindings ?? [] });
    for (const mirror of boot.documents) {restoreDocument(mirror);}
    const session = boot.session ?? {};
    if (session.query) {setApp({ query: session.query, searchHistory: session.searchHistory ?? [] });}
    const docs = useApp.getState().docs;
    const legacySvg = boot.documents.filter(d => (!d.kind || d.kind === 'text') && /\.svg$/i.test(d.path ?? '')).map(d => d.id);
    const valid = session.groups?.map(g => normalizeGroup({ ...g, tabs: g.tabs.filter(id => !!docs[id]), active: g.active && docs[g.active] ? g.active : g.tabs.find(id => !!docs[id]) ?? null, views: g.views ?? {}, mediaViews: { ...Object.fromEntries(legacySvg.filter(id => g.tabs.includes(id)).map(id => [id, { mode: 'text' as const }])), ...g.mediaViews } }));
    setApp({ ready: true, ...(valid?.length ? { groups: valid, editorLayout: session.editorLayout, groupMru: session.groupMru ?? [], activeGroup: session.activeGroup && valid.some(g => g.id === session.activeGroup) ? session.activeGroup : valid[0].id } : {}), sidebarWidth: Number.isFinite(session.sidebarWidth) ? Math.max(170, session.sidebarWidth!) : 260, sidebar: session.sidebar === '' ? null : session.sidebar === 'search' ? 'search' : 'explorer', history: session.history ?? [], historyIndex: session.historyIndex ?? -1 });
    if (boot.warnings.length) {notify(boot.warnings.join('\n'));}
    if (boot.root) {await refreshTree();}
    await refreshDocuments();
  })();
}

export default function App() {
  const s = useApp(); const [fatal, setFatal] = useState<string | null>(null); const [maximized, setMaximized] = useState(false);
  useExternalDrop(s.ready);
  const [diagnostics, setDiagnostics] = useState({ errors: 0, warnings: 0 });
  useEffect(() => { void start().catch(e => setFatal(errorMessage(e))); return installKeys(); }, []);
  useEffect(() => {
    if (!s.ready) {return;}
    const markers = monaco.editor.onDidChangeMarkers(() => { const all = monaco.editor.getModelMarkers({}); setDiagnostics({ errors: all.filter(m => m.severity === monaco.MarkerSeverity.Error).length, warnings: all.filter(m => m.severity === monaco.MarkerSeverity.Warning).length }); });
    return () => markers.dispose();
  }, [s.ready]);
  useEffect(() => {
    if (!desktop) {return;}
    let disposed = false; const cleanups: (() => void)[] = [];
    void (async () => {
      const onChange = await listen('workspace-changed', () => { void refreshTree(); void refreshDocuments(); });
      if (disposed) {onChange();} else {cleanups.push(onChange);}
      const onConfig = await listen('configuration-changed', () => { void call<{ settings: Record<string, unknown>; keybindings: import('./types').Keybinding[] | null }>('configuration').then(config => setApp({ settings: config.settings, keybindings: config.keybindings ?? [] })).catch(e => notify(errorMessage(e))); });
      if (disposed) {onConfig();} else {cleanups.push(onConfig);}
      const win = getCurrentWindow();
      const onFocus = await win.onFocusChanged(({ payload: focused }) => { if (!disposed && !focused) {void autoSave('onWindowChange');} });
      if (disposed) {onFocus();} else {cleanups.push(onFocus);}
      const onClose = await win.onCloseRequested(async event => { event.preventDefault(); try { await checkpoint(); await win.destroy(); } catch (e) { notify(`Could not save recovery data. Window remains open: ${errorMessage(e)}`); } });
      if (disposed) {onClose();} else {cleanups.push(onClose);}
    })().catch(e => notify(errorMessage(e)));
    return () => { disposed = true; cleanups.forEach(fn => fn()); };
  }, []);
  const group = s.groups.find(g => g.id === s.activeGroup);
  const doc = s.docs[group?.active ?? ''];
  const showWelcome = s.ready && !s.root && s.groups.every(group => group.tabs.length === 0);
  useEffect(() => { if (desktop) {void getCurrentWindow().setTitle(`${doc?.dirty ? '● ' : ''}${doc?.name ? `${doc.name} — ` : ''}${s.root ? `${basename(s.root)} — ` : ''}LiteCode`);} }, [doc?.name, doc?.dirty, s.root]);
  function windowAction(action: 'minimize' | 'maximize' | 'close') {
    if (!desktop) {return;} const win = getCurrentWindow();
    if (action === 'minimize') {void win.minimize();}
    if (action === 'maximize') {void win.toggleMaximize().then(() => win.isMaximized()).then(setMaximized);}
    if (action === 'close') {void win.close();}
  }
  return <div className="workbench">
    <header className="titlebar" data-tauri-drag-region onDoubleClick={e => { if (e.target === e.currentTarget) {windowAction('maximize');} }}>
      <div className="app-mark" aria-label="LiteCode"><Icon name="code" /></div>
      <nav className="menubar" aria-label="Application menu">{['File', 'Edit', 'Selection', 'View', 'Go', 'Help'].map(menu => <Menu.Root key={menu}><Menu.Trigger>{menu}</Menu.Trigger><Menu.Portal><Menu.Positioner className="z-90" side="bottom" align="start" sideOffset={0}><Menu.Popup className="context-menu application-menu">{commands.filter(c => c.menu === menu).map(c => <Menu.Item key={c.id} onClick={() => void execute(c.id)}><span>{c.label}</span>{c.key && <kbd>{c.key}</kbd>}</Menu.Item>)}</Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>)}</nav>
      <div className="title-center" data-tauri-drag-region><IconButton icon="arrow-left" label="Go Back (Alt+Left)" onClick={() => void execute('workbench.action.navigateBack')} disabled={s.historyIndex <= 0} /><IconButton icon="arrow-right" label="Go Forward (Alt+Right)" onClick={() => void execute('workbench.action.navigateForward')} disabled={s.historyIndex >= s.history.length - 1} /><button className="command-center" onClick={() => setApp({ quick: '' })}><Icon name="search" /><span>{s.root ? basename(s.root) : 'LiteCode'}</span></button></div>
      <div className="title-layout"><IconButton icon="layout-sidebar-left" label="Toggle Primary Side Bar" onClick={() => void execute('workbench.action.toggleSidebarVisibility')} /><IconButton icon="layout" label="Split Editor" onClick={() => void execute('workbench.action.splitEditor')} /></div>
      <div className="window-controls"><button aria-label="Minimize" onClick={() => windowAction('minimize')}><Icon name="chrome-minimize" /></button><button aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => windowAction('maximize')}><Icon name={maximized ? 'chrome-restore' : 'chrome-maximize'} /></button><button className="window-close" aria-label="Close Window" onClick={() => windowAction('close')}><Icon name="chrome-close" /></button></div>
    </header>
    <div className="workbench-body">
      <nav className="activitybar" aria-label="Views"><div><button className={s.sidebar === 'explorer' ? 'active' : ''} aria-label="Explorer (Ctrl+Shift+E)" title="Explorer (Ctrl+Shift+E)" onClick={() => setApp({ sidebar: s.sidebar === 'explorer' ? null : 'explorer' })}><Icon name="files" /></button><button className={s.sidebar === 'search' ? 'active' : ''} aria-label="Search (Ctrl+Shift+F)" title="Search (Ctrl+Shift+F)" onClick={() => void execute('workbench.action.findInFiles')}><Icon name="search" /></button></div><button title="Manage" aria-label="Manage" onClick={() => setApp({ quick: '>Preferences:' })}><Icon name="settings-gear" /></button></nav>
      {s.ready && <WorkbenchLayout sidebar={<aside className="sidebar"><div className="sidebar-view" hidden={s.sidebar !== 'explorer'}><Explorer openFolder={() => void openFolder().catch(e => notify(errorMessage(e)))} /></div><div className="sidebar-view" hidden={s.sidebar !== 'search'}><SearchView /></div></aside>}><main className="editors" aria-label="Editors">
        <div className={`editor-groups${showWelcome ? ' welcome-hidden' : ''}`} inert={showWelcome} aria-hidden={showWelcome || undefined}>
          {s.editorLayout && <EditorLayoutView node={s.editorLayout} />}
        </div>
        {showWelcome && <WelcomePage />}
      </main></WorkbenchLayout>}
      {!s.ready && <div className="startup" role="status">{fatal ? <><Icon name="error" /><p>{fatal}</p><button onClick={() => location.reload()}>Reload</button></> : <><span className="spinner" /><p>Starting editor services…</p></>}</div>}
    </div>
    <footer className="statusbar"><div className="status-left"><span className="remote-indicator" title="Local window"><Icon name="remote" /></span>{s.tree.branch && <span className="status-item" title="Current Git branch"><Icon name="source-control" />{s.tree.branch}</span>}<button title="Show Problems" onClick={() => void editor()?.getAction('editor.action.marker.next')?.run()}><Icon name="error" />{diagnostics.errors}<Icon name="warning" />{diagnostics.warnings}</button></div><div className="status-right">{doc && isTextView(doc, group) && <><button onClick={() => setApp({ quick: ':' })}>Ln {s.cursor.line}, Col {s.cursor.column}{s.cursor.selected ? ` (${s.cursor.selected} selected)` : ''}</button><button onClick={changeIndent}>Spaces: {String(s.settings['editor.tabSize'] ?? 4)}</button><button onClick={changeEncoding}>{doc.encoding.toUpperCase().replace('UTF8', 'UTF-8')}</button><button onClick={changeEol}>{doc.eol}</button><button onClick={() => void execute('litecode.setLanguage')}>{doc.language === 'plaintext' ? 'Plain Text' : doc.language}</button></>}{doc && group && !isTextView(doc, group) && <MediaStatus doc={doc} group={group} />}{s.searching && <span>Searching…</span>}<span className="status-item" title={s.languageStatus}><Icon name="check" /></span><button title="Notifications" onClick={() => notify(s.notice ?? 'No new notifications.')} aria-label="Notifications"><Icon name="bell" /></button></div></footer>
    {s.notice && <div className="notification" role="status"><Icon name="info" /><p>{s.notice}</p><IconButton icon="close" label="Dismiss Notification" onClick={() => setApp({ notice: null })} /></div>}
    {s.ready && <><QuickOpen /><DiffViewer /></>}<DialogHost />
  </div>;
}
